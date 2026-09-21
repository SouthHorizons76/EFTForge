"""Render build images in process with Kitbash, from sprites baked once per part."""

import base64
import io
import logging
import os
import sys
import threading
from collections import OrderedDict

from config import KITBASH_CACHE_MB, KITBASH_DIR

_logger = logging.getLogger(__name__)

# Icons come out at twice the game's inventory size (cells * 63 + 1).
SCALE = 2
_MAX_CACHE_BYTES = 32 * 2**20

_lock = threading.Lock()
_compositor = None
_error_type = None
_load_failed = False
_cache: OrderedDict[str, bytes] = OrderedDict()
_cache_bytes = 0


def available() -> bool:
    return bool(KITBASH_DIR) and os.path.isfile(os.path.join(KITBASH_DIR, "data", "sprites.manifest.json"))


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
            _logger.exception("kitbash failed to load from %s", KITBASH_DIR)
    return _compositor


class Unrenderable(Exception):
    """The build has a part Kitbash has no sprite for; use the image-gen proxy."""


def render_webp(key: str, items: list) -> bytes:
    """WebP bytes for a validated build tree. Blocking; call from a thread."""
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
            im = comp.render(items, scale=SCALE)
        except _error_type as exc:
            raise Unrenderable(str(exc)) from exc
        buf = io.BytesIO()
        # Method 0 encodes in a few ms at nearly the size of the slow methods.
        im.save(buf, "WEBP", quality=90, method=0)
        data = buf.getvalue()
        _cache[key] = data
        _cache_bytes += len(data)
        while _cache_bytes > _MAX_CACHE_BYTES and len(_cache) > 1:
            _, old = _cache.popitem(last=False)
            _cache_bytes -= len(old)
        return data


def data_url(data: bytes) -> str:
    return "data:image/webp;base64," + base64.b64encode(data).decode("ascii")
