"""Build preview images drawn by Kitbash!, plus the image generation admin switch."""

import asyncio
import json
import logging
import os
import threading
import time
from typing import Annotated, List, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Header, Request
from sqlalchemy.orm import Session

import build_images
from build_images import build_image_key, loaded_image_key
from config import RUNTIME_DIR
from database_builds import BuildsSessionLocal
from models_builds import PublicBuild
from models_items import Item
from routers.shared import MAX_IMAGE_ITEMS, cap_list, get_client_ip, get_db, require_admin
from services.build_cards import build_spt_items

_logger = logging.getLogger(__name__)

router = APIRouter()


# Admin kill switch for build image generation. /build-image/status also reports
# it disabled while Kitbash! isn't installed, so the frontend greys out the toggle.
_IMGGEN_DISABLED_LOCK_FILE = os.path.join(RUNTIME_DIR, "imggen_disabled.lock")
_imggen_disabled: bool = os.path.exists(_IMGGEN_DISABLED_LOCK_FILE)


# ---------------------------------------------------
# Build Images
# Kitbash! draws each build in process from baked sprites
# (see build_images.py) and keeps its own render cache.
# ---------------------------------------------------

_IMGGEN_HEALTH_CACHE: dict = {}  # {"status": str, "ts": float, "error": str|None}
_IMGGEN_HEALTH_TTL = 300  # 5 min - one real probe per UptimeRobot polling cycle


@router.get("/build-image/status")
async def build_image_status():
    # The About dialog shows the Kitbash! commit even while the kill switch is on.
    return {
        "disabled": _imggen_disabled or not build_images.available(),
        # Reads Kitbash!'s 6 MB manifest the first time in each worker.
        "kitbash": await asyncio.to_thread(build_images.version),
    }


@router.api_route("/health/imggen", methods=["GET", "HEAD"])
async def health_imggen():
    """Renders the newest community build with Kitbash! and returns 200/{"status":"ok"} or 503.
    Result is cached for _IMGGEN_HEALTH_TTL seconds so UptimeRobot polling
    doesn't trigger a render on every check."""
    now = time.monotonic()
    cached = _IMGGEN_HEALTH_CACHE.get("result")
    if cached and (now - cached["ts"]) < _IMGGEN_HEALTH_TTL:
        if cached["status"] == "ok":
            return {"status": "ok"}
        raise HTTPException(status_code=503, detail=cached.get("error", "down"))

    with BuildsSessionLocal() as bdb:
        build = bdb.query(PublicBuild).filter(PublicBuild.pairs_json != "[]").order_by(PublicBuild.id.desc()).first()
    if not build:
        raise HTTPException(status_code=503, detail="No builds available for probe")

    pairs = json.loads(build.pairs_json)
    try:
        if not build_images.available():
            raise RuntimeError("Kitbash! is not installed")
        items = build_spt_items(build.gun_id, pairs)
        await asyncio.to_thread(build_images.render_webp, build_image_key(build.gun_id, items), items)
        _IMGGEN_HEALTH_CACHE["result"] = {"status": "ok", "ts": now, "error": None}
        return {"status": "ok"}
    except Exception as exc:
        err = str(exc)
        _IMGGEN_HEALTH_CACHE["result"] = {"status": "down", "ts": now, "error": err}
        raise HTTPException(status_code=503, detail=err)


# The old image-gen queue used to be the only throttle on /build-image. A render
# is a few ms of CPU behind build_images' per-worker lock, so we cap both how
# fast one IP may ask (a token bucket that allows the bursts of quick attachment
# swaps) and how many renders may queue on that lock, and answer 429 past
# either. The frontend treats any failed render as "show the static image".
# Per worker process, unlike the solver's server-wide cap in services/solve_limits.py: a render is a few ms of in-process CPU.
_IMAGE_BURST = 20
_IMAGE_REFILL_PER_SEC = 4.0
_image_buckets: dict[str, tuple[float, float]] = {}  # ip -> (tokens, last refill)
_image_buckets_lock = threading.Lock()
_MAX_QUEUED_RENDERS = 8
_RENDER_QUEUE_SEM = threading.BoundedSemaphore(_MAX_QUEUED_RENDERS)


def _take_image_token(ip: str) -> bool:
    now = time.monotonic()
    with _image_buckets_lock:
        # Any bucket idle long enough to refill completely is back to the default, so drop it.
        full_after = _IMAGE_BURST / _IMAGE_REFILL_PER_SEC
        for k in [k for k, (_, t) in _image_buckets.items() if now - t > full_after]:
            del _image_buckets[k]
        tokens, last = _image_buckets.get(ip, (float(_IMAGE_BURST), now))
        tokens = min(_IMAGE_BURST, tokens + (now - last) * _IMAGE_REFILL_PER_SEC)
        if tokens < 1:
            _image_buckets[ip] = (tokens, now)
            return False
        _image_buckets[ip] = (tokens - 1, now)
        return True


def _render_limited(*args) -> tuple[bytes, list[str]]:
    if not _RENDER_QUEUE_SEM.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Image renderer is busy - try again shortly.")
    try:
        return build_images.render_webp(*args)
    finally:
        _RENDER_QUEUE_SEM.release()


@router.post("/build-image")
async def build_image(
    request: Request,
    id: str = Body(...),
    items: List[dict] = Body(...),
    source: Literal["preview", "hover", "optimizer", "export", "armor"] = Body("preview"),
    db: Session = Depends(get_db),
    # "Assume Full Magazine": Kitbash! draws the build's magazines full of this ammo
    # and its UBGL loaded, as the game does.
    assume_full_mag: Annotated[bool, Body()] = False,
    selected_ammo_id: Annotated[str | None, Body()] = None,
    selected_ubgl_ammo_id: Annotated[str | None, Body()] = None,
):
    if _imggen_disabled or not build_images.available():
        raise HTTPException(status_code=503, detail="Build preview generation is temporarily disabled")
    if not _take_image_token(get_client_ip(request)):
        raise HTTPException(status_code=429, detail="Too many image requests - please slow down.")

    cap_list("items", items, MAX_IMAGE_ITEMS)

    weapon = db.get(Item, id)
    if not weapon:
        raise HTTPException(status_code=404, detail=f"Unknown weapon id: {id}")
    # A helmet is drawn with its attachments too, for the Ballistics Workbench's loadout
    if not (weapon.is_weapon or weapon.armor_kind == "helmet"):
        raise HTTPException(status_code=422, detail="Build image root must be a weapon or a helmet")
    # Kitbash! chambers a round even without a magazine, so the ammo always counts.
    ammo, ubgl_ammo = (selected_ammo_id or None, selected_ubgl_ammo_id or None) if assume_full_mag else (None, None)
    try:
        cache_key = build_image_key(id, items)
        render_key = loaded_image_key(cache_key, ammo, ubgl_ammo)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if not weapon.is_weapon:
        # A helmet always shows its attachments switched on (face shields down). The build
        # key ignores toggles, so these drawings get a key of their own.
        items = [items[0]] + [
            {**item, "upd": {**(item.get("upd") or {}), "Togglable": {"On": True}}} for item in items[1:]
        ]
        render_key += ":on"
    try:
        data, skipped = await asyncio.to_thread(_render_limited, render_key, items, ammo, ubgl_ammo)
    except build_images.UnsupportedWeapon as exc:
        _logger.info("build-image Kitbash! cannot draw weapon %s source=%s: %s", id, source, exc)
        raise HTTPException(
            status_code=422,
            detail={"code": "unsupported_weapon", "message": f"Kitbash! cannot draw this weapon: {exc}"},
        )
    except build_images.Unrenderable as exc:
        _logger.info("build-image Kitbash! cannot draw build=%s source=%s: %s", cache_key[:16], source, exc)
        raise HTTPException(status_code=422, detail=f"Kitbash! cannot draw this build: {exc}")
    if skipped:
        _logger.info("build-image Kitbash! left out %s in build=%s source=%s", skipped, cache_key[:16], source)
    # Parts Kitbash! cannot draw yet are left out of the image rather than failing it.
    return {"image_url": build_images.data_url(data), "skipped": skipped}


@router.get("/admin/imggen-disabled")
def admin_get_imggen_disabled(
    request: Request,
    x_admin_key: str = Header(None),
):
    require_admin(request, x_admin_key)
    return {"imggen_disabled": _imggen_disabled}


@router.post("/admin/imggen-disabled")
def admin_set_imggen_disabled(
    request: Request,
    disabled: bool = Body(...),
    x_admin_key: str = Header(None),
):
    global _imggen_disabled
    require_admin(request, x_admin_key)
    _imggen_disabled = disabled
    if disabled:
        open(_IMGGEN_DISABLED_LOCK_FILE, "w").close()
    else:
        if os.path.exists(_IMGGEN_DISABLED_LOCK_FILE):
            os.remove(_IMGGEN_DISABLED_LOCK_FILE)
    return {"imggen_disabled": disabled}
