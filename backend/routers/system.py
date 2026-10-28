"""Health, sync status, data version, and the hyperactive sync admin switch."""

import json
import os
import subprocess
import time

from fastapi import APIRouter, Body, Depends, HTTPException, Header, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from config import BETA_MODE, LOCAL_DEV, REMOTE_ORIGIN, RUNTIME_DIR
from routers.shared import get_db, require_admin
from services import community_proxy, sync

router = APIRouter()


# Recorded once at process start - clients use this to detect a backend restart
# and bypass their local update-check TTL so a fresh deploy is noticed immediately.
SERVER_START_TIME = int(time.time())


# ---------------------------------------------------
# Health check
# ---------------------------------------------------


@router.api_route("/health", methods=["GET", "HEAD"])
def health_check(request: Request, db: Session = Depends(get_db)):
    """Liveness + basic DB connectivity check for load balancers / monitoring."""
    try:
        db.execute(text("SELECT 1"))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"DB unavailable: {exc}")
    return {"status": "ok", "started": SERVER_START_TIME}


# ---------------------------------------------------
# Beta
# ---------------------------------------------------


def _beta_commit():
    """The commit the beta runs, read once at start: a checkout and a restart is how a new
    beta goes up. EFTFORGE_BETA_COMMIT wins for a copy that isn't a git checkout."""
    if not BETA_MODE:
        return None
    override = os.environ.get("EFTFORGE_BETA_COMMIT", "").strip()
    if override:
        return override
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


BETA_COMMIT = _beta_commit()


@router.get("/beta-info")
def get_beta_info():
    """What the beta's header shows in place of the wordmark. Only the beta answers."""
    if not BETA_MODE:
        raise HTTPException(status_code=404, detail="Not Found")
    return {"commit": BETA_COMMIT}


_LAST_SYNC_FILE = os.path.join(RUNTIME_DIR, "last_sync.json")


@router.get("/sync-status")
def get_sync_status():
    """Public endpoint - lets clients show a notice when a background sync is in progress,
    and when the tarkov.dev data was last successfully synced (cron, hyperactive mode,
    or a local dev background sync all write last_sync.json via sync_tarkov_dev.py)."""
    running = sync.is_sync_running()
    last_synced_at = None
    if os.path.exists(_LAST_SYNC_FILE):
        try:
            with open(_LAST_SYNC_FILE, "r", encoding="utf-8") as f:
                last_synced_at = json.load(f).get("last_synced_at")
        except (OSError, ValueError):
            pass
    return {"sync_running": running, "last_synced_at": last_synced_at}


@router.get("/data-version")
def get_data_version():
    """The token the frontend adds to catalog requests as ?dv= so the CDN can cache
    them until the next sync or deploy. Null while a sync runs: clients then send
    unversioned requests, which are never cached."""
    return JSONResponse({"version": sync.data_version()}, headers={"Cache-Control": "no-store"})


_DEV_SYNC_NOTICE_FILE = os.path.join(RUNTIME_DIR, "dev_sync_notice.json")


@router.get("/dev/sync-notice")
def get_dev_sync_notice():
    """Local-dev only: reset.py's background sync writes this file when it finds
    new data. Only reset.py's non-prod branch ever creates it, so in production
    this file never exists and the endpoint is a permanent no-op."""
    if not os.path.exists(_DEV_SYNC_NOTICE_FILE):
        return {"changed": False}
    try:
        os.remove(_DEV_SYNC_NOTICE_FILE)
    except OSError:
        pass
    return {"changed": True}


def _require_local_dev(request: Request) -> None:
    # 404 rather than 403 so these routes look absent anywhere but a reset.py
    # dev server, and only a direct loopback client may use them.
    client = request.client.host if request.client else ""
    if not LOCAL_DEV or client not in ("127.0.0.1", "::1"):
        raise HTTPException(status_code=404, detail="Not Found")


@router.get("/dev/connected-mode")
def get_dev_connected_mode(request: Request):
    """Local-dev only: whether community reads are forwarded to the live service."""
    _require_local_dev(request)
    return {"enabled": community_proxy.dev_connected_enabled(), "remote_origin": REMOTE_ORIGIN}


@router.post("/dev/connected-mode")
def set_dev_connected_mode(request: Request, enabled: bool = Body(..., embed=True)):
    """Local-dev only: toggled from the DEV modal. Forwards community GETs to
    the live service and rejects community writes while on."""
    _require_local_dev(request)
    community_proxy.set_dev_connected(enabled)
    return {"enabled": community_proxy.dev_connected_enabled(), "remote_origin": REMOTE_ORIGIN}


# ---------------------------------------------------
# Admin - Hyperactive Sync Mode
# ---------------------------------------------------


@router.get("/admin/hyperactive-mode")
def admin_get_hyperactive_mode(
    request: Request,
    x_admin_key: str = Header(None),
):
    require_admin(request, x_admin_key)
    return {
        "hyperactive_mode": sync.hyperactive_mode,
        "sync_running": sync.sync_running,
        "last_sync_at": sync.last_sync_at,
        "sync_interval_seconds": sync.SYNC_INTERVAL_HYPERACTIVE_SECS,
    }


@router.post("/admin/hyperactive-mode")
async def admin_set_hyperactive_mode(
    request: Request,
    enabled: bool = Body(...),
    x_admin_key: str = Header(None),
):
    require_admin(request, x_admin_key)
    sync.hyperactive_mode = enabled
    if enabled:
        open(sync.HYPERACTIVE_LOCK_FILE, "w").close()
        sync.sync_trigger.set()  # wake the background loop for an immediate sync
    else:
        if os.path.exists(sync.HYPERACTIVE_LOCK_FILE):
            os.remove(sync.HYPERACTIVE_LOCK_FILE)
        sync.sync_trigger.set()  # wake the background loop so it sees mode=False
    return {"hyperactive_mode": enabled}
