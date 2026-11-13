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
# What all keys together may send on to the provider per game mode in KEY_SHARE_WINDOW, so the
# players page keeps most of each mode's own budget there (15 per 10 minutes for most modes, 100
# for PvE): a partner site sent twice a mode's whole budget on its own on 2026-11-12. A keyed
# lookup past it is busy, and so gets the last answer we had when there is one. Arena's visitors
# use only about half its budget, so keys get twice the share there (2026-11-13: two partners'
# Arena syncs were turned away 40 to 90% of the time at 5)
KEY_SHARE = 5
KEY_SHARES = {"pve": 30, "arena": 10}
KEY_SHARE_WINDOW = 600
# Lookups waiting on the provider or drawing their weapons at once, across every worker, so a
# burst can't take every thread the rest of the site needs. A lookup over the cap is turned
# away right away rather than queued.
MAX_IN_FLIGHT = int(os.environ.get("ATLAS_LOOKUP_MAX_IN_FLIGHT", "8"))
# 3D full body renders per IP (only the ones not drawn yet count): a player trying every weapon
# and pose of a few profiles stays inside; each costs the render service about two seconds.
RENDER_WINDOWS = ((60, 20), (3600, 200))
# How many of those slots keyed lookups may hold between them, so the page's own visitors
# always keep the rest.
KEY_MAX_IN_FLIGHT = int(os.environ.get("ATLAS_LOOKUP_KEY_MAX_IN_FLIGHT", "3"))
CACHE_SECONDS = 60
# How old a kept answer may be for a server sending an Atlas key: another site showing profiles
# doesn't need them to the minute, and its visitors keep asking for the same popular players,
# so they mostly come from here instead of the game. Page visitors keep CACHE_SECONDS.
KEY_CACHE_SECONDS = 600
# How long a kept answer stays around at all: past the ages above it's only handed out when a mode
# can't be looked up right now (the provider's budget for it is used up, or the game refuses), as
# the last answer we had, marked stale, rather than an error
STALE_SECONDS = 6 * 3600
# Kept answers per worker, by size: prod's 2 GB box is already into swap, so a minute's worth
# of profiles is plenty (the drawings aren't in them, they're files under /atlas/api/lookup-art)
CACHE_BYTES = 32 * 1024 * 1024
# How long a name the game won't search stays on our list (it filters the text itself, whoever holds
# it), so people retrying one don't spend the mode's lookups; a day in case the game's list changes
UNSEARCHABLE_SECONDS = 24 * 3600
UNSEARCHABLE_MAX = 10000

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
    _take(who, KEY_WINDOWS if key_id else IP_WINDOWS)


def take_render(ip: str) -> None:
    """Count one 3D full body render for this IP, its own allowance (RENDER_WINDOWS), or refuse
    it with 429 as take() does."""
    _take("render:" + _who(ip), RENDER_WINDOWS)


def take_key_share(mode: str) -> None:
    """Count one keyed lookup going on to the provider in this mode, or turn it away as busy once
    the keys' share of that mode is used up."""
    _take(f"keys:{mode}", ((KEY_SHARE_WINDOW, KEY_SHARES.get(mode, KEY_SHARE)),), error="busy")


def _take(who: str, windows: tuple, error: str = "rate") -> None:
    now = time.time()
    longest = max(span for span, _ in (*IP_WINDOWS, *KEY_WINDOWS, *RENDER_WINDOWS))
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
                    # a window allowing none has no oldest entry to wait out: wait it out whole
                    retry = max(1, int(oldest + span - now) + 1) if oldest is not None else span
                    con.execute("COMMIT")
                    _logger.info("atlas lookup: rate limited %s (%d in %ds)", who[:12], count, span)
                    raise HTTPException(
                        status_code=429,
                        detail={"error": error, "retryAfter": retry},
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


def cached(key: tuple, max_age: float = CACHE_SECONDS) -> dict | None:
    """A kept answer no older than max_age seconds. Answers are kept for STALE_SECONDS, so a page
    visitor's minute-old limit doesn't throw away one a key, or a stale fallback, could still use."""
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit is None:
            return None
        age = now - hit[0]
        if age > STALE_SECONDS:
            _drop(key)
            return None
        if age > max_age:
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


def stale(key: tuple) -> dict | None:
    """The last answer kept for key, however old (up to STALE_SECONDS), for when a fresh one
    can't be had."""
    with _cache_lock:
        hit = _cache.get(key)
        if hit is None or time.monotonic() - hit[0] > STALE_SECONDS:
            return None
        return hit[1]


_unsearchable: "OrderedDict[tuple, float]" = OrderedDict()


def unsearchable(mode: str, nickname: str) -> bool:
    """Whether the game refused to search this name in this mode within UNSEARCHABLE_SECONDS."""
    key = (mode, nickname.lower())
    with _cache_lock:
        at = _unsearchable.get(key)
        if at is None:
            return False
        if time.monotonic() - at > UNSEARCHABLE_SECONDS:
            del _unsearchable[key]
            return False
        return True


def remember_unsearchable(mode: str, nickname: str) -> None:
    key = (mode, nickname.lower())
    with _cache_lock:
        _unsearchable.pop(key, None)
        _unsearchable[key] = time.monotonic()
        while len(_unsearchable) > UNSEARCHABLE_MAX:
            _unsearchable.popitem(last=False)


class _Pending:
    """A lookup on its way to the provider, which later askers for the same thing wait on."""

    def __init__(self):
        self.done = threading.Event()
        self.body: dict | None = None
        self.error: BaseException | None = None


_pending: dict[tuple, _Pending] = {}
_pending_lock = threading.Lock()


def begin(key: tuple) -> tuple[bool, _Pending]:
    """(leading, pending): the first asker for key leads the lookup; anyone asking for the same
    thing while it's on its way gets the same pending one to wait on instead of a second request."""
    with _pending_lock:
        pending = _pending.get(key)
        if pending is not None:
            return False, pending
        pending = _pending[key] = _Pending()
        return True, pending


def finish(key: tuple, pending: _Pending, body: dict | None = None, error: BaseException | None = None) -> None:
    pending.body, pending.error = body, error
    with _pending_lock:
        if _pending.get(key) is pending:
            del _pending[key]
    pending.done.set()


def clear() -> None:
    """For the tests: an empty cache and no counted lookups."""
    global _cache_size
    with _cache_lock:
        _cache.clear()
        _cache_size = 0
        _unsearchable.clear()
    with _pending_lock:
        _pending.clear()
    con = _connect()
    try:
        con.execute("DELETE FROM hits")
    finally:
        con.close()
