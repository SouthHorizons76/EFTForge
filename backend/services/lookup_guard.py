"""Guards for the public Atlas player lookup: a per-IP rate limit every worker shares (per Atlas
key instead for a server that sends one), a cap on lookups in flight at once, and a short cache
of finished answers.

There's no total for the server as a whole: everyone gets their own allowance, and a crowd of
players just means more lookups.

The rate limit lives in a small SQLite file under RUNTIME_DIR, not in a dict: with more than
one Gunicorn worker process, a per-process count would hand each IP that many times its
allowance. Rows are keyed by an HMAC of the IP, never the raw address, and are dropped once
they're older than the longest window. An IPv6 address counts as its /64, the block one connection
is usually handed, so cycling through the addresses of one block buys nothing. The cache is per worker on purpose: it only spares
repeat work, so a miss on another worker costs a lookup, never a wrong answer.
"""

import hashlib
import hmac
import ipaddress
import json
import logging
import os
import sqlite3
import threading
import time
from collections import OrderedDict

from fastapi import HTTPException

from config import IP_HASH_SECRET, RUNTIME_DIR
from server_semaphore import server_semaphore

_logger = logging.getLogger(__name__)

# (window seconds, lookups allowed in it) per IP. A player checking a squad, switching modes
# and opening a few weapons stays well inside; a script walking account IDs doesn't.
IP_WINDOWS = ((60, 30), (3600, 400))
# The same per Atlas key, for another site's server asking on behalf of its own users (a chat
# bot, say), whose lookups all come from one IP. The key's allowance replaces its IP's. The
# minute stays under nginx's own limit on /atlas/api/lookup (60 a minute per IP), which still
# applies in front of us.
KEY_WINDOWS = ((60, 40), (3600, 1200))
# Lookups waiting on the provider or drawing their weapons at once, across every worker, so a
# burst can't take every thread the rest of the site needs. A lookup over the cap is turned
# away right away rather than queued.
MAX_IN_FLIGHT = int(os.environ.get("ATLAS_LOOKUP_MAX_IN_FLIGHT", "8"))
# How many of those slots keyed lookups may hold between them, so the page's own visitors
# always keep the rest.
KEY_MAX_IN_FLIGHT = int(os.environ.get("ATLAS_LOOKUP_KEY_MAX_IN_FLIGHT", "3"))
CACHE_SECONDS = 60
# Kept answers per worker, by size: prod's 2 GB box is already into swap, so a minute's worth
# of profiles is plenty (the drawings aren't in them, they're files under /atlas/api/lookup-art)
CACHE_BYTES = 8 * 1024 * 1024

_DB_PATH = os.path.join(RUNTIME_DIR, "lookup_limits.sqlite3")
_LOCK_DIR = os.path.join(RUNTIME_DIR, "lookup_locks")
os.makedirs(_LOCK_DIR, exist_ok=True)
_IN_FLIGHT = server_semaphore(MAX_IN_FLIGHT, _LOCK_DIR, "slot")
_KEY_IN_FLIGHT = server_semaphore(KEY_MAX_IN_FLIGHT, _LOCK_DIR, "keyslot")

_schema_lock = threading.Lock()
_schema_ready = False


def _connect() -> sqlite3.Connection:
    global _schema_ready
    con = sqlite3.connect(_DB_PATH, timeout=5, isolation_level=None)
    if not _schema_ready:
        with _schema_lock:
            con.execute("PRAGMA journal_mode=WAL")
            con.execute("CREATE TABLE IF NOT EXISTS hits (who TEXT NOT NULL, at REAL NOT NULL)")
            con.execute("CREATE INDEX IF NOT EXISTS hits_who_at ON hits (who, at)")
            _schema_ready = True
    return con


def _bucket(ip: str) -> str:
    """What one allowance belongs to: an IPv4 address, or the /64 of an IPv6 one."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if addr.version == 6:
        if addr.ipv4_mapped:
            return str(addr.ipv4_mapped)
        return str(ipaddress.ip_network(f"{addr}/64", strict=False))
    return str(addr)


def _who(ip: str) -> str:
    return hmac.new(IP_HASH_SECRET.encode(), _bucket(ip).encode(), hashlib.sha256).hexdigest()


def take(ip: str, key_id: str | None = None) -> None:
    """Count one lookup for this IP, or for the Atlas key when there is one, or refuse it with
    429 and Retry-After once a window is full. A refused lookup isn't counted, so waiting out
    the window always works."""
    # a key's id is already no secret (the admin key list shows it), so it needs no HMAC
    who = f"key:{key_id}" if key_id else _who(ip)
    windows = KEY_WINDOWS if key_id else IP_WINDOWS
    now = time.time()
    longest = max(span for span, _ in (*IP_WINDOWS, *KEY_WINDOWS))
    con = _connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        try:
            con.execute("DELETE FROM hits WHERE at < ?", (now - longest,))
            for span, limit in windows:
                count, oldest = con.execute(
                    "SELECT COUNT(*), MIN(at) FROM hits WHERE who = ? AND at >= ?", (who, now - span)
                ).fetchone()
                if count >= limit:
                    con.execute("COMMIT")
                    retry = max(1, int(oldest + span - now) + 1)
                    _logger.info("atlas lookup: rate limited %s (%d in %ds)", who[:12], count, span)
                    raise HTTPException(
                        status_code=429,
                        detail={"error": "rate", "retryAfter": retry},
                        headers={"Retry-After": str(retry)},
                    )
            con.execute("INSERT INTO hits (who, at) VALUES (?, ?)", (who, now))
            con.execute("COMMIT")
        except HTTPException:
            raise
        except BaseException:
            con.execute("ROLLBACK")
            raise
    finally:
        con.close()


def _busy(what: str) -> HTTPException:
    _logger.info("atlas lookup: every %s busy", what)
    return HTTPException(status_code=429, detail={"error": "busy"}, headers={"Retry-After": "5"})


class in_flight:
    """One of the MAX_IN_FLIGHT slots for the length of a lookup, or 429 busy when none is free.
    A keyed lookup first takes one of the KEY_MAX_IN_FLIGHT key slots, then a shared one."""

    def __init__(self, keyed: bool = False):
        self.keyed = keyed

    def __enter__(self):
        if self.keyed and not _KEY_IN_FLIGHT.acquire(blocking=False):
            raise _busy("key slot")
        if not _IN_FLIGHT.acquire(blocking=False):
            if self.keyed:
                _KEY_IN_FLIGHT.release()
            raise _busy("slot")
        return self

    def __exit__(self, *_):
        _IN_FLIGHT.release()
        if self.keyed:
            _KEY_IN_FLIGHT.release()


_cache: "OrderedDict[tuple, tuple[float, dict, int]]" = OrderedDict()
_cache_size = 0
_cache_lock = threading.Lock()


def _drop(key: tuple) -> None:
    global _cache_size
    _cache_size -= _cache.pop(key)[2]


def cached(key: tuple) -> dict | None:
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit is None:
            return None
        if now - hit[0] > CACHE_SECONDS:
            _drop(key)
            return None
        _cache.move_to_end(key)
        return hit[1]


def remember(key: tuple, body: dict) -> None:
    """Keep an answer, dropping the oldest ones past CACHE_BYTES. One bigger than a quarter of
    that isn't kept at all, so it can't push out everything else."""
    global _cache_size
    size = len(json.dumps(body, separators=(",", ":")))
    if size > CACHE_BYTES // 4:
        return
    with _cache_lock:
        if key in _cache:
            _drop(key)
        _cache[key] = (time.monotonic(), body, size)
        _cache_size += size
        while _cache_size > CACHE_BYTES:
            _drop(next(iter(_cache)))


def clear() -> None:
    """For the tests: an empty cache and no counted lookups."""
    global _cache_size
    with _cache_lock:
        _cache.clear()
        _cache_size = 0
    con = _connect()
    try:
        con.execute("DELETE FROM hits")
    finally:
        con.close()
