"""Render build images in process with Kitbash!, from sprites baked once per part."""

import base64
import functools
import hashlib
import io
import json
import logging
import os
import re
import subprocess
import sys
import threading
from collections import OrderedDict

from config import KITBASH_CACHE_MB, KITBASH_DIR

_logger = logging.getLogger(__name__)

# Icons come out at twice the game's inventory size (cells * 63 + 1); 3x looks
# the same on screen at about 1.7x the bytes.
SCALE = 2
WEBP_QUALITY = 90
_MAX_CACHE_BYTES = 32 * 2**20

_lock = threading.Lock()
_compositor = None
_error_type = None
_unsupported_type = None
_load_failed = False
# key -> (webp bytes, templates of the parts left out)
_cache: OrderedDict[str, tuple[bytes, list[str]]] = OrderedDict()
_cache_bytes = 0


def available() -> bool:
    return bool(KITBASH_DIR) and os.path.isfile(os.path.join(KITBASH_DIR, "data", "sprites.manifest.json"))


@functools.cache
def version() -> dict | None:
    """The Kitbash! checkout's HEAD commit, commit date and codename, and the game
    client its newest sprites were baked from, or None when Kitbash! isn't installed. Any part
    we cannot read is None. Read once per worker, like the compositor, so it names
    the Kitbash! this worker actually loaded."""
    if not available():
        return None
    return {**_git_head(), "codename": _codename(), "gameVersion": _game_version()}


def _git_head() -> dict:
    none = {"commit": None, "date": None}
    try:
        # The checkout may belong to another user on the server, which git refuses
        # to read without safe.directory.
        out = subprocess.run(
            ["git", "-c", "safe.directory=*", "-C", KITBASH_DIR, "log", "-1", "--format=%H %cI"],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        ).stdout.split()
    except (OSError, subprocess.SubprocessError):
        _logger.warning("Could not read the Kitbash! commit from %s", KITBASH_DIR)
        return none
    if len(out) != 2 or not re.fullmatch(r"[0-9a-f]{40}", out[0]):
        return none
    return {"commit": out[0], "date": out[1]}


def _codename() -> str | None:
    # Kitbash! names each release in a CODENAME file at its root.
    try:
        with open(os.path.join(KITBASH_DIR, "CODENAME"), encoding="utf-8") as f:
            name = f.read().strip()
    except OSError:
        return None
    return name if re.fullmatch(r"[A-Za-z][A-Za-z0-9 -]{0,31}", name) else None


def _game_version() -> str | None:
    # Every bake stamps the manifest with the client it drew from (Kitbash!'s spec/manifest.md).
    try:
        with open(os.path.join(KITBASH_DIR, "data", "sprites.manifest.json"), encoding="utf-8") as f:
            ver = json.load(f).get("gameVersion")
    except (OSError, ValueError):
        _logger.warning("Could not read the Kitbash! manifest in %s", KITBASH_DIR)
        return None
    return ver if isinstance(ver, str) and re.fullmatch(r"[0-9][0-9.]*", ver) else None


def build_image_key(gun_id: str, items: list) -> str:
    # Validate the complete tree before caching or rendering any build.
    if not items or len(items) > 150:
        raise ValueError("Expected 1 to 150 build items")
    nodes = {}
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Invalid build item")
        for field in ("_id", "_tpl"):
            if not isinstance(item.get(field), str) or not re.fullmatch(r"[0-9a-f]{24}", item[field]):
                raise ValueError(f"Invalid item {field}")
        if item["_id"] in nodes:
            raise ValueError("Duplicate item instance")
        if not isinstance(item.get("slotId"), str) or not item["slotId"]:
            raise ValueError("Missing item slot")
        if not isinstance(item.get("parentId"), str):
            raise ValueError("Missing item parent")
        nodes[item["_id"]] = item
    root = items[0]
    if root["_tpl"] != gun_id or root["slotId"] != "hideout" or root["parentId"] != "hideout":
        raise ValueError("Build root does not match the requested weapon")
    children = {iid: [] for iid in nodes}
    occupied = set()
    for item in items[1:]:
        parent = item["parentId"]
        if parent not in nodes:
            raise ValueError("Unknown attachment parent")
        placement = (parent, item["slotId"])
        if placement in occupied:
            raise ValueError("Duplicate attachment slot")
        occupied.add(placement)
        children[parent].append(item)
    visited = set()

    def encode(item):
        iid = item["_id"]
        if iid in visited:
            raise ValueError("Cyclic build tree")
        visited.add(iid)
        return [item["_tpl"], item["slotId"], [encode(c) for c in sorted(children[iid], key=lambda c: c["slotId"])]]

    encoded = encode(root)
    if len(visited) != len(nodes):
        raise ValueError("Disconnected build tree")
    return hashlib.sha256(json.dumps(encoded, separators=(",", ":")).encode()).hexdigest()


def loaded_image_key(key: str, ammo: str | None, ubgl_ammo: str | None) -> str:
    """The render cache key for a build whose magazines are loaded with `ammo` and
    whose UBGL holds `ubgl_ammo`; the build key itself when both are empty."""
    for tpl in (ammo, ubgl_ammo):
        if tpl is not None and not re.fullmatch(r"[0-9a-f]{24}", tpl):
            raise ValueError("Invalid ammo id")
    if not (ammo or ubgl_ammo):
        return key
    return hashlib.sha256(f"{key}|{ammo or ''}|{ubgl_ammo or ''}".encode()).hexdigest()


def _get():
    # Import and load the manifest once per worker, on first use.
    global _compositor, _error_type, _unsupported_type, _load_failed
    if _compositor is None and not _load_failed:
        try:
            if KITBASH_DIR not in sys.path:
                sys.path.insert(0, KITBASH_DIR)
            from kitbash import Compositor, KitbashError, UnsupportedWeapon

            _compositor = Compositor(cache_mb=KITBASH_CACHE_MB)
            _error_type = KitbashError
            _unsupported_type = UnsupportedWeapon
        except Exception:
            _load_failed = True
            _logger.exception("Kitbash! failed to load from %s", KITBASH_DIR)
    return _compositor


def loaded() -> bool:
    """Whether Kitbash! is installed and its compositor loads in this worker."""
    if not available():
        return False
    with _lock:
        return _get() is not None


class Unrenderable(Exception):
    """Kitbash! cannot draw the build."""


class UnsupportedWeapon(Unrenderable):
    """Kitbash! cannot draw the weapon itself."""


def render_webp(
    key: str, items: list, ammo: str | None = None, ubgl_ammo: str | None = None
) -> tuple[bytes, list[str]]:
    """WebP bytes for a validated build tree, its magazines full of `ammo` and a
    round of it chambered, and its
    UBGL loaded with `ubgl_ammo` when given (key must cover both, see
    loaded_image_key), and the templates of the parts Kitbash! left out because it
    cannot draw them yet. Blocking; call from a thread."""
    global _cache_bytes
    with _lock:
        hit = _cache.get(key)
        if hit is not None:
            _cache.move_to_end(key)
            return hit
        comp = _get()
        if comp is None:
            raise Unrenderable("kitbash is not loaded")
        try:
            if ammo:
                # Chamber a round as well: stripping some parts off a gun (or all
                # of them) shows its chamber.
                items = comp.load_ammo(items, ammo, chamber=True)
            if ubgl_ammo:
                items = comp.load_ammo(items, ubgl_ammo, chamber=True)
            items, skipped = comp.drawable(items)
            im = comp.render(items, scale=SCALE)
        except _unsupported_type as exc:
            raise UnsupportedWeapon(str(exc)) from exc
        except _error_type as exc:
            raise Unrenderable(str(exc)) from exc
        buf = io.BytesIO()
        # Method 0 encodes in a few ms at nearly the size of the slow methods.
        im.save(buf, "WEBP", quality=WEBP_QUALITY, method=0)
        result = buf.getvalue(), [it["_tpl"] for it in skipped]
        _cache[key] = result
        _cache_bytes += len(result[0])
        while _cache_bytes > _MAX_CACHE_BYTES and len(_cache) > 1:
            _, (old, _) = _cache.popitem(last=False)
            _cache_bytes -= len(old)
        return result


def data_url(data: bytes) -> str:
    return "data:image/webp;base64," + base64.b64encode(data).decode("ascii")
