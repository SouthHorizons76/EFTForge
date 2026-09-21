"""Render build images in process with Kitbash!, from sprites baked once per part."""

import base64
import hashlib
import io
import json
import logging
import os
import re
import sys
import threading
from collections import OrderedDict

from config import KITBASH_CACHE_MB, KITBASH_DIR

_logger = logging.getLogger(__name__)

# Icons come out at three times the game's inventory size (cells * 63 + 1): the
# most the baked sprites cover without upscaling (4x upscales some rifles).
SCALE = 3
WEBP_QUALITY = 90
# ~1.8x the bytes per image of 2x, so twice the room for the same hit rate.
_MAX_CACHE_BYTES = 64 * 2**20

_lock = threading.Lock()
_compositor = None
_error_type = None
_load_failed = False
_cache: OrderedDict[str, bytes] = OrderedDict()
_cache_bytes = 0


def available() -> bool:
    return bool(KITBASH_DIR) and os.path.isfile(os.path.join(KITBASH_DIR, "data", "sprites.manifest.json"))


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
    global _compositor, _error_type, _load_failed
    if _compositor is None and not _load_failed:
        try:
            if KITBASH_DIR not in sys.path:
                sys.path.insert(0, KITBASH_DIR)
            from kitbash import Compositor, KitbashError

            _compositor = Compositor(cache_mb=KITBASH_CACHE_MB)
            _error_type = KitbashError
        except Exception:
            _load_failed = True
            _logger.exception("Kitbash! failed to load from %s", KITBASH_DIR)
    return _compositor


class Unrenderable(Exception):
    """The build has a part Kitbash! has no sprite for."""


def render_webp(key: str, items: list, ammo: str | None = None, ubgl_ammo: str | None = None) -> bytes:
    """WebP bytes for a validated build tree, its magazines full of `ammo` and its
    UBGL loaded with `ubgl_ammo` when given (key must cover both, see
    loaded_image_key). Blocking; call from a thread."""
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
                items = comp.load_ammo(items, ammo)
            if ubgl_ammo:
                items = comp.load_ammo(items, ubgl_ammo, chamber=True)
            im = comp.render(items, scale=SCALE)
        except _error_type as exc:
            raise Unrenderable(str(exc)) from exc
        buf = io.BytesIO()
        # Method 0 encodes in a few ms at nearly the size of the slow methods.
        im.save(buf, "WEBP", quality=WEBP_QUALITY, method=0)
        data = buf.getvalue()
        _cache[key] = data
        _cache_bytes += len(data)
        while _cache_bytes > _MAX_CACHE_BYTES and len(_cache) > 1:
            _, old = _cache.popitem(last=False)
            _cache_bytes -= len(old)
        return data


def data_url(data: bytes) -> str:
    return "data:image/webp;base64," + base64.b64encode(data).decode("ascii")
