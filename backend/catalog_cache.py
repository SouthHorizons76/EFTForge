"""Let the CDN and browsers cache the read-only item catalog endpoints.

Those responses only change when a sync rewrites tarkov.db or a deploy changes the
code, so the frontend tags each request with the data version it got from
GET /data-version (?dv=...). A request whose version still matches gets a long
cache lifetime; the URL changes with the next sync, so no purge is ever needed.

Every other catalog response says no-store explicitly: requests without ?dv= (the
frontend's fallback), a stale ?dv=, errors, and anything served mid-sync. Spelling it
out instead of sending no header means a CDN set to follow origin can never pick its
own lifetime for them and keep a stale answer.

Kept out of main.py so the tests can run it on CI without a synced tarkov.db.
"""

import hashlib
import os
import re
from collections.abc import Callable
from urllib.parse import parse_qs

CATALOG_MAX_AGE = 86400
DATA_VERSION_HEADER = "X-Data-Version"

# GET routes whose answer depends only on tarkov.db and their own query string.
CATALOG_PATH_RE = re.compile(
    r"^/(?:traders|guns|graph/searchable-items|ammo/[^/]+|items/ids|items/[^/]+/slots"
    r"|slots/[^/]+/allowed-items|guns/[^/]+/init|build/mods|build/default-preset|armor/items)$"
)


def code_stamp(backend_dir: str) -> str:
    """Newest mtime of the backend's own .py files, read once per process. A deploy
    only takes effect on restart, and the restarted workers read the new stamp, so a
    response cached by old code is never served under the new code's version."""
    newest = 0
    for root, dirs, files in os.walk(backend_dir):
        dirs[:] = [d for d in dirs if d not in {"venv", ".venv", "tests", "benchmarks", "__pycache__"}]
        for name in files:
            if name.endswith(".py"):
                try:
                    newest = max(newest, os.stat(os.path.join(root, name)).st_mtime_ns)
                except OSError:
                    pass
    return str(newest)


def make_data_version(
    db_path: str,
    read_epoch: Callable[[], str],
    sync_running: Callable[[], bool],
    stamp: str,
    extra: Callable[[], str] = lambda: "",
) -> Callable[[], str | None]:
    """Build the version function. It returns None (never cache) while a sync is
    running or the DB can't be read. Any write to tarkov.db moves its mtime, so even
    a sync that never publishes a new epoch changes the version."""

    def data_version() -> str | None:
        if sync_running():
            return None
        parts = [read_epoch(), stamp, extra()]
        for path in (db_path, db_path + "-wal"):
            try:
                st = os.stat(path)
            except FileNotFoundError:
                if path == db_path:
                    return None
                continue
            except OSError:
                return None
            parts.append(f"{st.st_mtime_ns}:{st.st_size}")
        return hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]

    return data_version


class CatalogCacheMiddleware:
    """Plain ASGI rather than BaseHTTPMiddleware, so it never wraps the streaming
    optimizer responses or their disconnect detection: anything that isn't a catalog
    GET goes straight through untouched."""

    def __init__(self, app, data_version: Callable[[], str | None]):
        self.app = app
        self.data_version = data_version

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "GET" or not CATALOG_PATH_RE.match(scope["path"]):
            await self.app(scope, receive, send)
            return

        requested = parse_qs(scope.get("query_string", b"").decode("latin-1")).get("dv", [None])[0]
        before = self.data_version()

        async def send_with_cache_headers(message):
            if message["type"] == "http.response.start":
                # Checked again after the handler ran: a sync that started meanwhile
                # may have handed us half-written data.
                after = self.data_version()
                headers = list(message.get("headers", []))
                if after:
                    headers.append((DATA_VERSION_HEADER.lower().encode(), after.encode()))
                cacheable = (
                    requested is not None
                    and message["status"] == 200
                    and before is not None
                    and requested == before == after
                )
                value = f"public, max-age={CATALOG_MAX_AGE}" if cacheable else "no-store"
                headers = [(k, v) for k, v in headers if k.lower() != b"cache-control"]
                headers.append((b"cache-control", value.encode()))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_cache_headers)
