"""Forwarding of community endpoints to the live eftforge.com service.

Used by the desktop app's connected mode (desktop.py) and by the local dev
connected mode toggled from the DEV modal (see dev_connected_* below).
"""

import json
import logging
import os

import requests
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from config import LOCAL_DEV, REMOTE_ORIGIN, RUNTIME_DIR

_logger = logging.getLogger("uvicorn.error")

# Path prefixes forwarded to eftforge.com in connected mode. Matching is on
# whole path segments ("/builds" matches "/builds/public" but not
# "/builds-x"). /admin is deliberately absent: admin endpoints only ever hit
# the local backend and the local admin key is never sent upstream.
COMMUNITY_PREFIXES = (
    "/ratings",
    "/builds",
    "/leaderboard",
    "/announcements",
    "/profile",
    "/stat-changelog",
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


def path_matches(path: str, prefixes: tuple) -> bool:
    for prefix in prefixes:
        if path == prefix or path.startswith(prefix + "/"):
            return True
    return False


def make_session(user_agent: str) -> requests.Session:
    session = requests.Session()
    session.headers["User-Agent"] = user_agent
    return session


def forward_to_remote(session: requests.Session, request: Request, body: bytes, strip_cors: bool = False) -> Response:
    url = REMOTE_ORIGIN + request.url.path
    if request.url.query:
        url += "?" + request.url.query

    headers = {k: v for k, v in request.headers.items() if k.lower() not in _STRIP_REQUEST_HEADERS}

    try:
        upstream = session.request(
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

    response_headers = {}
    for key, value in upstream.headers.items():
        lower = key.lower()
        if lower in _STRIP_RESPONSE_HEADERS:
            continue
        # Cross-origin callers (local dev on :5500) get their CORS headers from
        # our own CORSMiddleware, so drop whatever prod sent for its origin.
        if strip_cors and lower.startswith("access-control-"):
            continue
        response_headers[key] = value
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=response_headers,
    )


# ---------------------------------------------------------------------------
# Local dev connected mode
# ---------------------------------------------------------------------------

# Persisted in the runtime dir so the choice survives uvicorn --reload restarts.
_DEV_CONNECTED_FILE = os.path.join(RUNTIME_DIR, "dev_connected_mode.json")

# Only reads are forwarded: a dev box must never publish, vote or comment on
# the live service by accident.
_DEV_FORWARD_METHODS = {"GET", "HEAD"}

# Build image rendering isn't community data, so we keep it on the local
# Kitbash! (the desktop app forwards it only because it ships without one).
_DEV_FORWARD_PREFIXES = tuple(p for p in COMMUNITY_PREFIXES if p not in ("/build-image", "/health/imggen"))

_dev_session = make_session("EFTForge-LocalDev (+https://eftforge.com)")


def dev_connected_enabled() -> bool:
    if not LOCAL_DEV:
        return False
    try:
        with open(_DEV_CONNECTED_FILE, "r", encoding="utf-8") as f:
            return json.load(f).get("enabled") is True
    except (OSError, ValueError):
        return False


def set_dev_connected(enabled: bool) -> None:
    if enabled:
        with open(_DEV_CONNECTED_FILE, "w", encoding="utf-8") as f:
            json.dump({"enabled": True}, f)
    elif os.path.exists(_DEV_CONNECTED_FILE):
        os.remove(_DEV_CONNECTED_FILE)


async def _dev_connected_dispatch(request: Request, call_next):
    path = request.url.path
    if not path_matches(path, _DEV_FORWARD_PREFIXES) or not dev_connected_enabled():
        return await call_next(request)
    if request.method not in _DEV_FORWARD_METHODS:
        return Response(
            content=json.dumps({"detail": "dev_connected_read_only"}),
            status_code=403,
            media_type="application/json",
        )
    return await run_in_threadpool(forward_to_remote, _dev_session, request, b"", True)


def add_dev_connected_middleware(app) -> None:
    """Register before CORSMiddleware so CORS wraps the forwarded responses."""
    app.add_middleware(BaseHTTPMiddleware, dispatch=_dev_connected_dispatch)
