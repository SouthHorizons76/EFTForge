"""Desktop-app-only backend features (EFTFORGE_DESKTOP=1).

Wired into the FastAPI app by main.py via init_desktop(). Provides:

  - Static serving of the frontend from the local backend, with a
    window.__EFTFORGE_DESKTOP__ flag injected into index.html so the frontend
    knows it is running inside the packaged app.
  - The community proxy: when the user is in "connected" mode, community
    endpoints (builds, ratings, comments, leaderboard, announcements, profile,
    build images, stat changelog) are forwarded to the live eftforge.com
    service; in "local" mode they are handled by the local SQLite DBs exactly
    like a dev environment.
  - Desktop settings (data/settings.json) + endpoints to read/update them.
  - A tarkov.dev data sync manager that mirrors reset.py's scratch-DB approach:
    sync into a throwaway DB in a worker process, then copy into the live
    tarkov.db in one transaction only if the data actually changed.
"""

import json
import logging
import os
import sqlite3
import subprocess
import sys
import threading
import time

from solver_cache_epoch import bump_solver_cache_epoch

import requests
from fastapi import FastAPI, HTTPException, Body
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request

from config import (
    ADMIN_API_KEY,
    DATA_DIR,
    DESKTOP_APP_VERSION,
    FRONTEND_DIR,
    REMOTE_ORIGIN,
    RUNTIME_DIR,
)

_logger = logging.getLogger("uvicorn.error")

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# Settings (data/settings.json)
# ---------------------------------------------------------------------------

_SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
_SETTINGS_LOCK = threading.Lock()

# community_mode: "connected" = community endpoints proxied to eftforge.com,
#                 "local"     = community features disabled entirely (the app
#                               is a pure offline modding tool; only item data
#                               syncs from tarkov.dev).
# update_source:  "auto" | "gitee" | "github" - read by the Tauri launcher on
#                 startup to order the updater endpoints.
# close_action:   "ask" | "tray" | "exit" - what the X button does. "ask" (the
#                 default) shows a one-off choice modal every time; the other
#                 two are what the user picked with "remember my choice" on
#                 that modal, read directly by the Rust side (main.rs) on
#                 every window close request.
#
# First run defaults to fully local: connecting to EFTForge.com is an explicit
# opt-in from the UI.
_DEFAULT_SETTINGS = {
    "community_mode": "local",
    "update_source": "auto",
    "close_action": "ask",
}

_VALID_VALUES = {
    "community_mode": {"connected", "local"},
    "update_source": {"auto", "gitee", "github"},
    "close_action": {"ask", "tray", "exit"},
}


def get_settings() -> dict:
    with _SETTINGS_LOCK:
        settings = dict(_DEFAULT_SETTINGS)
        try:
            with open(_SETTINGS_FILE, "r", encoding="utf-8") as f:
                stored = json.load(f)
            for key in _DEFAULT_SETTINGS:
                if stored.get(key) in _VALID_VALUES[key]:
                    settings[key] = stored[key]
        except (OSError, ValueError):
            pass
        return settings


def _save_settings(settings: dict) -> None:
    with _SETTINGS_LOCK:
        with open(_SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2)


# ---------------------------------------------------------------------------
# Community proxy
# ---------------------------------------------------------------------------

# News/patch-notes content isn't bundled into the desktop app (it was ~40MB of
# screenshots, blowing past Gitee's 100MB release cap) - it's always fetched
# from eftforge.com instead, the same way item images already require
# internet regardless of local/connected mode.
_NEWS_PREFIX = ("/news",)

# Path prefixes forwarded to eftforge.com in connected mode. Matching is on
# whole path segments ("/builds" matches "/builds/public" but not
# "/builds-x"). /admin is deliberately absent: admin endpoints only ever hit
# the local backend and the local admin key is never sent upstream.
_COMMUNITY_PREFIXES = (
    "/ratings",
    "/builds",
    "/leaderboard",
    "/announcements",
    "/profile",
    "/stat-changelog",
    "/build-image",
    "/health/imggen",
)

# In local mode these return a clean 503 instead of touching the local DBs -
# community features are OFF, not "community with an empty local dataset".
# The frontend hides all of this UI in local mode; the block is just
# defense-in-depth. /announcements and /stat-changelog stay locally served
# (harmless, and stat history is an item-data feature, not a community one).
_LOCAL_BLOCKED_PREFIXES = (
    "/ratings",
    "/builds",
    "/leaderboard",
    "/profile",
    "/build-image",
    "/health/imggen",
)

# Hop-by-hop / local-only request headers never forwarded upstream.
_STRIP_REQUEST_HEADERS = {
    "host",
    "connection",
    "keep-alive",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "accept-encoding",
    "origin",
    "referer",
    "x-admin-key",
}

# Response headers not forwarded back (requests already decodes the body).
_STRIP_RESPONSE_HEADERS = {
    "content-encoding",
    "transfer-encoding",
    "content-length",
    "connection",
    "keep-alive",
    "alt-svc",
    "server",
    "strict-transport-security",
}

_proxy_session = requests.Session()
_proxy_session.headers["User-Agent"] = f"EFTForge-Desktop/{DESKTOP_APP_VERSION} (+https://eftforge.com)"


def _path_matches(path: str, prefixes: tuple) -> bool:
    for prefix in prefixes:
        if path == prefix or path.startswith(prefix + "/"):
            return True
    return False


def _forward_to_remote(request: Request, body: bytes) -> Response:
    url = REMOTE_ORIGIN + request.url.path
    if request.url.query:
        url += "?" + request.url.query

    headers = {k: v for k, v in request.headers.items() if k.lower() not in _STRIP_REQUEST_HEADERS}

    try:
        upstream = _proxy_session.request(
            request.method,
            url,
            data=body if body else None,
            headers=headers,
            # Connect fast-fails; long read timeout covers build-image
            # generation (prod nginx allows 130s).
            timeout=(10, 130),
            allow_redirects=False,
        )
    except requests.RequestException as exc:
        _logger.warning("community proxy: %s %s failed: %s", request.method, url, exc)
        return Response(
            content=json.dumps({"detail": f"EFTForge.com unreachable: {exc.__class__.__name__}"}),
            status_code=502,
            media_type="application/json",
        )

    response_headers = {k: v for k, v in upstream.headers.items() if k.lower() not in _STRIP_RESPONSE_HEADERS}
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=response_headers,
    )


# ---------------------------------------------------------------------------
# tarkov.dev sync manager (scratch-DB approach, same guarantees as reset.py)
# ---------------------------------------------------------------------------

_LIVE_DB_PATH = os.path.join(DATA_DIR, "tarkov.db")
_SCRATCH_DB_PATH = os.path.join(DATA_DIR, "tarkov_dev_sync_scratch.db")
_SYNC_LOCK_FILE = os.path.join(RUNTIME_DIR, "sync_in_progress.lock")

# Tables rewritten on every sync. Children deleted before parents, parents
# inserted before children (mirrors reset.py).
_SYNC_TABLES = ("slot_allowed_items", "slots", "item_offers", "items", "traders")

# Skip the automatic startup sync if data is fresher than this.
_AUTO_SYNC_MAX_AGE_SECS = 12 * 3600

_sync_state_lock = threading.Lock()
_sync_state = {
    "running": False,
    "changed": False,  # result of the most recent completed sync
    "error": None,
    "finished_at": None,
}

_clear_caches = None  # set by init_desktop


def _items_fingerprint(db_path: str):
    if not os.path.exists(db_path):
        return None
    conn = sqlite3.connect(db_path)
    try:
        import hashlib

        h = hashlib.sha256()
        for row in conn.execute("SELECT * FROM items ORDER BY id"):
            h.update(repr(row).encode("utf-8", "ignore"))
        return h.hexdigest()
    except sqlite3.OperationalError:
        return None
    finally:
        conn.close()


def _table_columns(conn, schema, table):
    return [row[1] for row in conn.execute(f"PRAGMA {schema}.table_info({table})")]


def _copy_scratch_into_live() -> None:
    """Replace the live tables' rows with the scratch DB's in one transaction,
    so queries see either the full old data or the full new data - never a
    half-refilled table.

    Copies by explicit column NAME, not "SELECT *" position - the live table's
    columns are in ALTER-TABLE-append order (i.e. always growing at the end),
    which does not necessarily match the current model's declaration order in
    scratch, so a positional copy can silently shuffle values into the wrong
    columns. Only columns present in both tables are copied; a column that
    exists solely in scratch (freshly added to the model, not yet migrated
    into the live schema) is skipped for this run and picked up once main.py's
    startup migration adds it to the live table.
    """
    conn = sqlite3.connect(_LIVE_DB_PATH, timeout=10)
    try:
        conn.execute("ATTACH DATABASE ? AS scratch", (_SCRATCH_DB_PATH,))
        conn.execute("BEGIN IMMEDIATE")
        for table in _SYNC_TABLES:
            conn.execute(f"DELETE FROM {table}")
        for table in reversed(_SYNC_TABLES):
            live_cols = _table_columns(conn, "main", table)
            scratch_cols = set(_table_columns(conn, "scratch", table))
            cols = ", ".join(c for c in live_cols if c in scratch_cols)
            conn.execute(f"INSERT INTO {table} ({cols}) SELECT {cols} FROM scratch.{table}")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.execute("DETACH DATABASE scratch")
        conn.close()


def _sync_worker_command() -> list[str]:
    if getattr(sys, "frozen", False):
        # PyInstaller build: re-invoke this same exe in worker mode.
        return [sys.executable, "--sync-worker"]
    return [sys.executable, os.path.join(_BACKEND_DIR, "desktop_main.py"), "--sync-worker"]


def _run_sync() -> None:
    try:
        open(_SYNC_LOCK_FILE, "w").close()

        if os.path.exists(_SCRATCH_DB_PATH):
            os.remove(_SCRATCH_DB_PATH)

        env = {
            **os.environ,
            "DATABASE_URL": "sqlite:///" + _SCRATCH_DB_PATH.replace("\\", "/"),
            "EFTFORGE_SKIP_SOLVER_CACHE_EPOCH": "1",
        }
        _logger.info("desktop sync: fetching tarkov.dev data into scratch DB...")
        result = subprocess.run(
            _sync_worker_command(),
            env=env,
            cwd=DATA_DIR,
            timeout=600,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if result.returncode != 0:
            raise RuntimeError(f"sync worker exited with code {result.returncode}")

        before = _items_fingerprint(_LIVE_DB_PATH)
        after = _items_fingerprint(_SCRATCH_DB_PATH)
        changed = after is not None and after != before
        if changed:
            _copy_scratch_into_live()
            bump_solver_cache_epoch()
            if _clear_caches:
                _clear_caches()
            # Same notice file reset.py's dev sync writes: the frontend already
            # polls /dev/sync-notice and shows an "update now" refresh toast.
            with open(os.path.join(RUNTIME_DIR, "dev_sync_notice.json"), "w", encoding="utf-8") as f:
                json.dump({"changed": True, "at": time.time()}, f)
            _logger.info("desktop sync: new data found - live DB updated.")
        else:
            _logger.info("desktop sync: complete, no data changes.")

        with _sync_state_lock:
            _sync_state.update(changed=changed, error=None)
    except Exception as exc:
        _logger.error("desktop sync failed (app keeps running on existing data): %s", exc)
        with _sync_state_lock:
            _sync_state.update(changed=False, error=str(exc))
    finally:
        if os.path.exists(_SCRATCH_DB_PATH):
            try:
                os.remove(_SCRATCH_DB_PATH)
            except OSError:
                pass
        if os.path.exists(_SYNC_LOCK_FILE):
            try:
                os.remove(_SYNC_LOCK_FILE)
            except OSError:
                pass
        with _sync_state_lock:
            _sync_state.update(running=False, finished_at=time.time())


def start_sync() -> bool:
    """Kick off a background sync. Returns False if one is already running."""
    with _sync_state_lock:
        if _sync_state["running"]:
            return False
        _sync_state.update(running=True, changed=False, error=None, finished_at=None)
    threading.Thread(target=_run_sync, name="desktop-sync", daemon=True).start()
    return True


def _last_synced_at() -> str | None:
    try:
        with open(os.path.join(RUNTIME_DIR, "last_sync.json"), "r", encoding="utf-8") as f:
            return json.load(f).get("last_synced_at")
    except (OSError, ValueError):
        return None


def _auto_sync_if_stale() -> None:
    last = _last_synced_at()
    if last:
        try:
            from datetime import datetime, timezone

            last_dt = datetime.fromisoformat(last)
            if last_dt.tzinfo is None:
                last_dt = last_dt.replace(tzinfo=timezone.utc)
            age = (datetime.now(timezone.utc) - last_dt).total_seconds()
            if age < _AUTO_SYNC_MAX_AGE_SECS:
                _logger.info("desktop sync: data is fresh (synced %.1fh ago), skipping startup sync.", age / 3600)
                return
        except ValueError:
            pass
    _logger.info("desktop sync: data missing or stale - starting background sync.")
    start_sync()


# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------


def init_desktop(app: FastAPI, clear_caches=None) -> None:
    global _clear_caches
    _clear_caches = clear_caches

    # --- community proxy / local-mode block ------------------------------
    @app.middleware("http")
    async def _community_proxy(request: Request, call_next):
        path = request.url.path
        if _path_matches(path, _NEWS_PREFIX):
            body = await request.body()
            return await run_in_threadpool(_forward_to_remote, request, body)
        if _path_matches(path, _COMMUNITY_PREFIXES):
            if get_settings()["community_mode"] == "connected":
                body = await request.body()
                return await run_in_threadpool(_forward_to_remote, request, body)
            if _path_matches(path, _LOCAL_BLOCKED_PREFIXES):
                return Response(
                    content=json.dumps({"detail": "community_disabled_local_mode"}),
                    status_code=503,
                    media_type="application/json",
                )
        return await call_next(request)

    # --- desktop endpoints ----------------------------------------------
    @app.get("/desktop/settings")
    def desktop_get_settings():
        return {
            "settings": get_settings(),
            "app_version": DESKTOP_APP_VERSION,
            "data_dir": DATA_DIR,
            "remote_origin": REMOTE_ORIGIN,
        }

    @app.post("/desktop/settings")
    def desktop_set_settings(payload: dict = Body(...)):
        settings = get_settings()
        for key, allowed in _VALID_VALUES.items():
            if key in payload:
                if payload[key] not in allowed:
                    raise HTTPException(status_code=422, detail=f"Invalid value for {key}")
                settings[key] = payload[key]
        _save_settings(settings)
        return {"settings": settings}

    @app.post("/desktop/sync")
    def desktop_start_sync():
        started = start_sync()
        return {"started": started, "already_running": not started}

    @app.get("/desktop/sync-status")
    def desktop_sync_status():
        with _sync_state_lock:
            state = dict(_sync_state)
        state["last_synced_at"] = _last_synced_at()
        return state

    # --- startup: refresh stale item data automatically ------------------
    @app.on_event("startup")
    async def _desktop_startup():
        # Small delay so the server is fully up before the worker spawns.
        import asyncio

        async def _delayed():
            await asyncio.sleep(5)
            _auto_sync_if_stale()

        asyncio.create_task(_delayed())

    # --- static frontend --------------------------------------------------
    index_path = os.path.join(FRONTEND_DIR, "index.html")

    if not os.path.exists(index_path):
        # Packaged exe run standalone without the installed frontend resources
        # (or a bad EFTFORGE_FRONTEND_DIR): keep the API alive, skip the UI.
        _logger.warning("desktop mode: frontend not found at %s - serving API only", FRONTEND_DIR)
        return

    def _serve_index() -> HTMLResponse:
        with open(index_path, "r", encoding="utf-8") as f:
            html = f.read()
        community_mode = get_settings()["community_mode"]
        flag = json.dumps(
            {
                "appVersion": DESKTOP_APP_VERSION,
                "adminKey": ADMIN_API_KEY,
                # Rendered per request (index is no-store), so a reload after
                # switching modes always reflects the current setting.
                "communityMode": community_mode,
            }
        )
        inject = "<script>window.__EFTFORGE_DESKTOP__ = " + flag + ";</script>"
        if community_mode == "local":
            # Community-only header buttons must never paint in local mode -
            # the JS hiding in desktop-settings.js runs too late to prevent a
            # flash (or a fast click). Keep this selector list in sync with
            # desktop-settings.js _init().
            inject += "<style>#leaderboard-btn,#profile-nav-btn{display:none !important;}</style>"
        html = html.replace("<head>", "<head>\n" + inject, 1)
        return HTMLResponse(html, headers={"Cache-Control": "no-store"})

    @app.get("/", include_in_schema=False)
    def desktop_index():
        return _serve_index()

    @app.get("/index.html", include_in_schema=False)
    def desktop_index_html():
        return _serve_index()

    # Registered last so every API route above wins; serves all other
    # frontend assets (html=True gives news/ its index behavior too).
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

    _logger.info(
        "desktop mode: data dir %s | frontend %s | community mode %s",
        DATA_DIR,
        FRONTEND_DIR,
        get_settings()["community_mode"],
    )
