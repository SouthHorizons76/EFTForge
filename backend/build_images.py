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

from PIL import Image
import threading
from collections import OrderedDict

from config import KITBASH_CACHE_MB, KITBASH_DIR, KITBASH_RENDER_URL

_logger = logging.getLogger(__name__)

# Icons come out at twice the game's inventory size (cells * 63 + 1); 3x looks
# the same on screen at about 1.7x the bytes.
SCALE = 2
WEBP_QUALITY = 90
# Measured on 30 built factory guns: method 4 comes out 43% smaller than method 0 at the same
# quality (10 KB against 18 KB, PSNR within 0.5 dB) for about 8 ms more. Method 6 only saves
# another 3% and takes over a second per gun.
WEBP_METHOD = 4
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
        im.save(buf, "WEBP", quality=WEBP_QUALITY, method=WEBP_METHOD)
        result = buf.getvalue(), [it["_tpl"] for it in skipped]
        _cache[key] = result
        _cache_bytes += len(result[0])
        while _cache_bytes > _MAX_CACHE_BYTES and len(_cache) > 1:
            _, (old, _) = _cache.popitem(last=False)
            _cache_bytes -= len(old)
        return result


def data_url(data: bytes) -> str:
    return "data:image/webp;base64," + base64.b64encode(data).decode("ascii")


# Character renders (Kitbash!'s spec/character.md): the headshot the trader screen shows and a
# full-body image, stacked from sprites baked per suit and worn item. Loaded per view on first use.
CHARACTER_VIEWS = ("headshot", "full")
# Kitbash! bakes the headshot at 500 px, but the players page shows it at about 196 px (up to
# about 300 on a high-DPI screen), so we shrink it before encoding: at 320 px it looks the same
# there and comes out about 24 KB instead of 43 (measured on nine local headshots). The full
# body fills its panel at close to its own size, so it stays as baked.
CHARACTER_SIZES = {"headshot": 320}
_character_lock = threading.Lock()
_characters: dict = {}
_character_failed: set[str] = set()
_character_bakes: dict[str, str] = {}  # view -> hash of its manifest


def _get_character(view: str):
    with _character_lock:
        if view not in _characters and view not in _character_failed:
            try:
                if KITBASH_DIR not in sys.path:
                    sys.path.insert(0, KITBASH_DIR)
                # an older Kitbash! checkout has no characters, which only means no renders
                from kitbash.character import MANIFESTS, REPO, CharacterCompositor

                _characters[view] = CharacterCompositor(view)
                # The manifest's own bytes name the bake: any rebake (a fix that keeps the version
                # stamps, say) rewrites it, and with it every character's address. The full body
                # also covers what draws the gun in its hand: the gun poses' bakes, the gun
                # sprites and where each gun sits in the hand.
                data = os.path.join(REPO, "data")
                with open(os.path.join(data, MANIFESTS[view]), "rb") as f:
                    digest = hashlib.sha256(f.read())
                if view == "full":
                    extra = sorted(n for n in os.listdir(data) if n.startswith("character-full-"))
                    for n in extra + ["sprites-hands.manifest.json", "hand-grips.json"]:
                        if os.path.isfile(os.path.join(data, n)):
                            with open(os.path.join(data, n), "rb") as f:
                                digest.update(n.encode() + b"\0" + f.read())
                _character_bakes[view] = digest.hexdigest()
            except Exception:
                _character_failed.add(view)
                _logger.warning("Kitbash! character renders (%s) are unavailable in %s", view, KITBASH_DIR)
        return _characters.get(view)


def character_key(view: str, customization: dict, equipment: list) -> str | None:
    """A name for the character as drawn in `view`, or None when Kitbash! can't draw this one:
    no character sprites, or a head or body (and for the full body, feet) it has no sprites for,
    which would leave a headless or bodiless picture. Covers the bake, so a rebake draws anew."""
    comp = _get_character(view) if view in CHARACTER_VIEWS and available() else None
    if comp is None:
        return None
    m = comp.m
    parts = {p: customization.get(p) for p in ("head", "body", "feet")}
    if parts["head"] not in m["heads"] or parts["body"] not in m["bodies"]:
        return None
    if view == "full" and parts["feet"] not in m.get("feet", {}):
        return None
    drawn = [view, _character_bakes.get(view), CHARACTER_SIZES.get(view), parts, equipment]
    return hashlib.sha256(json.dumps(drawn, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def render_character_webp(view: str, customization: dict, equipment: list) -> bytes:
    """WebP bytes of the character in `view` (check character_key first). Blocking."""
    comp = _get_character(view)
    if comp is None:
        raise Unrenderable("kitbash characters are not loaded")
    try:
        im = comp.render(customization, equipment)
    except _character_error() as exc:
        raise Unrenderable(str(exc)) from exc
    size = CHARACTER_SIZES.get(view)
    if size and im.width > size:
        # resampled with premultiplied alpha, so the see-through edges don't pick up a dark fringe
        height = round(im.height * size / im.width)
        im = im.convert("RGBa").resize((size, height), Image.LANCZOS).convert("RGBA")
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=WEBP_QUALITY, method=WEBP_METHOD)
    return buf.getvalue()


# The 3D full body (Kitbash!'s spec/character.md, 3D full body): drawn by Kitbash!'s render
# service from its outfit library, with every carried weapon where the game puts it and the one
# in hand held as the game holds it, in the game's own hold or one of Kitbash!'s custom poses.
# Bump when what the service draws changes for the same request (lighting, say), so every
# picture's address changes with it.
CHARACTER3D_VERSION = 4
CHARACTER3D_TIMEOUT = 90  # seconds: the service takes one render at a time, a few may be waiting
# The service frames the character with the game's own camera, which stands it higher in the
# picture than the sprite full body the players page board was laid out for: moved down this
# many pixels (of 1238), its feet land where the sprites' do. There's room under them for it.
CHARACTER3D_DROP = 96
_character3d_digest: list = []


def _kitbash_character():
    if KITBASH_DIR not in sys.path:
        sys.path.insert(0, KITBASH_DIR)
    from kitbash import character

    return character


def character3d_available() -> bool:
    """Whether the 3D full body can be drawn: a render service and a Kitbash! checkout with the
    3D bake."""
    if not KITBASH_RENDER_URL or not available():
        return False
    try:
        return _kitbash_character().render3d_available()
    except Exception:
        _logger.warning("Kitbash! 3D full body is unavailable in %s", KITBASH_DIR)
        return False


def _character3d_bake() -> str:
    """The 3D bake's own name: its manifest and the custom poses' labels, so a rebake draws anew."""
    if not _character3d_digest:
        digest = hashlib.sha256(str(CHARACTER3D_VERSION).encode())
        for rel in (("data", "character-3d.manifest.json"), ("data", "custom-poses", "labels.json")):
            with open(os.path.join(KITBASH_DIR, *rel), "rb") as f:
                digest.update(f.read())
        _character3d_digest.append(digest.hexdigest())
    return _character3d_digest[0]


def character3d_spec(customization: dict, equipment: list, weapons: dict, hand: str | None, pose: str | None) -> dict:
    """The render service's request for this character (kitbash.character.render3d_spec)."""
    return _kitbash_character().render3d_spec(customization, equipment, weapons, hand, pose)


def character3d_key(spec: dict) -> str:
    """A name for the picture the service draws for this request, covering the bake."""
    return hashlib.sha256(
        json.dumps([_character3d_bake(), spec], sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def character3d_poses(hand: str | None, category: str | None = None) -> list:
    return _kitbash_character().poses_3d(hand, category)


def character3d_default_hand(weapons: dict) -> str | None:
    return _kitbash_character().default_hand(weapons)


def render_character3d_webp(spec: dict) -> bytes:
    """WebP bytes of the 3D full body from the render service. Blocking."""
    import urllib.error
    import urllib.request

    req = urllib.request.Request(
        KITBASH_RENDER_URL + "/render", json.dumps(spec).encode(), {"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=CHARACTER3D_TIMEOUT) as r:
            png = r.read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise Unrenderable(f"render service: {exc}") from exc
    # the service sends PNG, lossless; encoded here like the other drawings
    try:
        im = Image.open(io.BytesIO(png))
        im.load()
    except OSError as exc:
        raise Unrenderable(f"render service sent no picture: {exc}") from exc
    im = im.convert("RGBA")
    placed = Image.new("RGBA", im.size, (0, 0, 0, 0))
    placed.paste(im.crop((0, 0, im.width, im.height - CHARACTER3D_DROP)), (0, CHARACTER3D_DROP))
    buf = io.BytesIO()
    placed.save(buf, "WEBP", quality=WEBP_QUALITY, method=WEBP_METHOD)
    return buf.getvalue()


def _character_error():
    from kitbash.compositor import KitbashError

    return KitbashError
