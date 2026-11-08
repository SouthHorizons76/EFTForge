"""Atlas: game data change sets, time-gated for the public.

ATLAS_EXPORT_DIR holds index.json plus sets/<id>.json, each set with a UTC "detected"
time. ATLAS_ARENA_EXPORT_DIR holds Arena's, laid out the same way and served under
/atlas/api/arena. Nothing in this repo writes them; we only read and serve them. Normal
visitors only see sets older than ATLAS_PUBLIC_DELAY_HOURS. The admin key or a personal
Atlas key (X-Atlas-Key) shows everything at once. Keys are created and revoked by the
admin; only their SHA-256 is stored, in ATLAS_KEYS_FILE.

Caching: the index differs per caller and is never cached. A set file is the same for
everyone, so it is cacheable once public; before that it is no-store, so a CDN can't
hand a key holder's early copy to the public. A public set is stored with an ETag but
checked with us on every use (no-cache), because the exporter can rewrite a set (a
rebuild with new fields) and a cached copy must never outlive that.

The admin also switches EFTForge's header button for Atlas on and off (hidden by default);
that only hides the way in, never the page or its data.

ATLAS_MATCHING_DIR holds the average matchmaking wait per datacenter: latest.json plus one
<UTC date>.jsonl per day. It is live data with
no time gate, served by /atlas/api/matching.

/atlas/api/v1/{game}/... is the feed other sites pull change sets from, server to server,
with an Atlas key. Unlike the page's endpoints it never falls back to the public view and
never lets anything be cached, so revoking a key stops its pulls on the very next request.
It also never serves a set before it's public: a key only opens early sets on the Atlas page
itself (to view or export there), never for another site to republish.
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Request, Response

from config import RUNTIME_DIR
from routers.shared import get_client_ip, require_admin

router = APIRouter()

ATLAS_EXPORT_DIR = os.environ.get("ATLAS_EXPORT_DIR", "").strip()
ATLAS_ARENA_EXPORT_DIR = os.environ.get("ATLAS_ARENA_EXPORT_DIR", "").strip()
ATLAS_MATCHING_DIR = os.environ.get("ATLAS_MATCHING_DIR", "").strip()
ATLAS_KEYS_FILE = os.environ.get("ATLAS_KEYS_FILE", os.path.join(RUNTIME_DIR, "atlas_keys.json"))
ATLAS_PUBLIC_DELAY_HOURS = float(os.environ.get("ATLAS_PUBLIC_DELAY_HOURS", "12"))
# Present: EFTForge's header shows its Atlas button. Absent (the default): the button stays
# hidden, though /atlas itself still works for anyone with the link.
ATLAS_ENTRY_FILE = os.path.join(RUNTIME_DIR, "atlas_entry_shown")

_SET_ID_RE = re.compile(r"^[0-9a-f]{7,40}$")
_VALUE_ID_RE = re.compile(r"^[0-9]{1,6}$")
_KEY_PREFIX = "atl_"
_keys_lock = threading.Lock()

# Failed key attempts per IP, like require_admin: 5 misses lock the IP for 10 minutes.
_MAX_FAILURES = 5
_LOCKOUT_SECONDS = 600
_failures: dict[str, tuple[int, float]] = {}

PUBLIC, KEY, ADMIN = "public", "key", "admin"
EFT, ARENA = "eft", "arena"
# What a key opens: the change sets (early on the Atlas page, and the feed for other sites) and
# its own allowance on the player lookup. A key made for a chat bot's lookups gets only LOOKUP,
# so pasting it into the Atlas page can't show sets before they're public.
CHANGES, LOOKUP = "changes", "lookup"
SCOPES = (CHANGES, LOOKUP)
SCOPE_NAMES = {CHANGES: "change sets", LOOKUP: "player lookups"}


# ---------------------------------------------------
# Keys
# ---------------------------------------------------


def _hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def _load_keys() -> list[dict]:
    try:
        with open(ATLAS_KEYS_FILE, encoding="utf-8") as f:
            return json.load(f).get("keys", [])
    except (FileNotFoundError, ValueError):
        return []


def _save_keys(keys: list[dict]) -> None:
    os.makedirs(os.path.dirname(ATLAS_KEYS_FILE) or ".", exist_ok=True)
    tmp = ATLAS_KEYS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"keys": keys}, f, indent=2)
    os.replace(tmp, ATLAS_KEYS_FILE)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _valid_key(key: str) -> dict | None:
    """The stored entry of a live key, or None."""
    if not key.startswith(_KEY_PREFIX):
        return None
    digest = _hash(key)
    now = _now()
    for k in _load_keys():
        if k.get("revoked") or not hmac.compare_digest(k["hash"], digest):
            continue
        expires = k.get("expires_at")
        return k if not expires or datetime.fromisoformat(expires) > now else None
    return None


def scopes_of(entry: dict) -> list[str]:
    # keys made before scopes existed keep everything they could already do
    return entry.get("scopes") or list(SCOPES)


def access(
    request: Request, x_atlas_key: str | None, x_admin_key: str | None, scope: str = CHANGES
) -> tuple[str, dict | None]:
    """(level, viewer): public, key or admin, plus who the page watermarks itself with - the
    key's id (the one the admin key list shows, never the key itself) and the name it was
    created with for a key, None for the public and the admin.
    A wrong key is a 403 (and counts towards a lockout) rather than silently falling back
    to the public view, so a typo is noticed. So is a real key without the scope asked for
    (a lookup only key on the change sets, say), though that one isn't counted as a miss."""
    if x_admin_key:
        require_admin(request, x_admin_key)
        return ADMIN, None
    if not x_atlas_key:
        return PUBLIC, None
    ip = get_client_ip(request)
    now = time.monotonic()
    count, until = _failures.get(ip, (0, 0.0))
    if until > now:
        raise HTTPException(status_code=429, detail="Too many failed attempts. Try again later.")
    entry = _valid_key(x_atlas_key.strip())
    if entry is None:
        count += 1
        _failures[ip] = (count, now + _LOCKOUT_SECONDS if count >= _MAX_FAILURES else 0.0)
        raise HTTPException(status_code=403, detail="Invalid or expired Atlas key")
    _failures.pop(ip, None)
    if scope not in scopes_of(entry):
        raise HTTPException(status_code=403, detail=f"This Atlas key isn't valid for {SCOPE_NAMES[scope]}")
    return KEY, {"id": entry["id"], "name": entry.get("name") or ""}


def access_level(request: Request, x_atlas_key: str | None, x_admin_key: str | None) -> str:
    return access(request, x_atlas_key, x_admin_key)[0]


# ---------------------------------------------------
# Change sets
# ---------------------------------------------------


# Each game has its own export folder; one that isn't set is a 503 for that game only.
def _export_dir(game: str = EFT) -> str:
    directory = ATLAS_ARENA_EXPORT_DIR if game == ARENA else ATLAS_EXPORT_DIR
    if not directory:
        raise HTTPException(status_code=503, detail="Atlas is not configured")
    return directory


def _read_index(game: str = EFT) -> list[dict]:
    try:
        with open(os.path.join(_export_dir(game), "index.json"), encoding="utf-8") as f:
            return json.load(f).get("sets", [])
    except FileNotFoundError:
        return []


def _public_after(entry: dict) -> datetime:
    return datetime.fromisoformat(entry["detected"]) + timedelta(hours=ATLAS_PUBLIC_DELAY_HOURS)


def visible_index(level: str, sets: list[dict], now: datetime | None = None, game: str = EFT) -> dict:
    """Every set is listed for everyone. One the public can't open yet keeps only its
    headline numbers (when, version, how many changes in how many files), not which files
    changed; the set and its values stay 404 to the public until public_at."""
    now = now or _now()
    shown = []
    for s in sets:
        public_at = _public_after(s)
        if level != PUBLIC or public_at <= now:
            shown.append({**s, "public_at": public_at.isoformat(), "locked": False})
        else:
            headline = {k: s[k] for k in ("id", "detected", "version", "total") if k in s}
            shown.append(
                {
                    **headline,
                    "file_count": len(s.get("files") or {}),
                    "public_at": public_at.isoformat(),
                    "locked": True,
                }
            )
    # server_time: the page counts down to public_at on our clock, not the viewer's (the
    # gate itself never trusts the client; this only keeps the countdown honest)
    return {
        "game": game,
        "access": level,
        "delay_hours": ATLAS_PUBLIC_DELAY_HOURS,
        "server_time": now.isoformat(),
        "sets": shown,
    }


def _index(game: str, request: Request, response: Response, x_atlas_key: str | None, x_admin_key: str | None):
    level, viewer = access(request, x_atlas_key, x_admin_key)
    response.headers["Cache-Control"] = "private, no-store"
    # The page watermarks early access sets with the viewer, so a leaked screenshot names
    # the key to revoke.
    return {
        **visible_index(level, _read_index(game), game=game),
        "viewer": viewer["id"] if viewer else None,
        "viewer_name": viewer["name"] if viewer else None,
    }


@router.get("/atlas/api/index")
def atlas_index(
    request: Request,
    response: Response,
    x_atlas_key: str = Header(None),
    x_admin_key: str = Header(None),
):
    return _index(EFT, request, response, x_atlas_key, x_admin_key)


@router.get("/atlas/api/arena/index")
def atlas_arena_index(
    request: Request,
    response: Response,
    x_atlas_key: str = Header(None),
    x_admin_key: str = Header(None),
):
    return _index(ARENA, request, response, x_atlas_key, x_admin_key)


def _gate_set(set_id: str, level: str, game: str = EFT) -> bool:
    """Whether the set is public yet. A set that isn't public (for this caller) looks exactly
    like one that doesn't exist."""
    if not _SET_ID_RE.fullmatch(set_id):
        raise HTTPException(status_code=404, detail="Not found")
    entry = next((s for s in _read_index(game) if s.get("id") == set_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="Not found")
    is_public = _public_after(entry) <= _now()
    if level == PUBLIC and not is_public:
        raise HTTPException(status_code=404, detail="Not found")
    return is_public


def _serve(path: str, is_public: bool, game: str = EFT, request: Request | None = None) -> Response:
    # The ids in the path are checked before we get here; we still refuse anything that
    # resolves outside sets/, so a looser check later can't open other files.
    sets_dir = os.path.realpath(os.path.join(_export_dir(game), "sets"))
    path = os.path.realpath(path)
    if not path.startswith(sets_dir + os.sep):
        raise HTTPException(status_code=404, detail="Not found")
    try:
        with open(path, "rb") as f:
            body = f.read()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Not found")
    if not is_public:
        return Response(content=body, media_type="application/json", headers={"Cache-Control": "private, no-store"})
    # a CDN or browser with the current copy gets a bodiless 304 back
    headers = {"Cache-Control": "public, no-cache", "ETag": f'"{hashlib.sha256(body).hexdigest()[:32]}"'}
    sent = request.headers.get("if-none-match", "") if request is not None else ""
    if headers["ETag"] in [tag.strip().removeprefix("W/") for tag in sent.split(",")]:
        return Response(status_code=304, headers=headers)
    return Response(content=body, media_type="application/json", headers=headers)


def _set(game: str, set_id: str, request: Request, x_atlas_key: str | None, x_admin_key: str | None) -> Response:
    level = access_level(request, x_atlas_key, x_admin_key)
    is_public = _gate_set(set_id, level, game)
    return _serve(os.path.join(_export_dir(game), "sets", f"{set_id}.json"), is_public, game, request)


@router.get("/atlas/api/sets/{set_id}")
def atlas_set(
    set_id: str,
    request: Request,
    x_atlas_key: str = Header(None),
    x_admin_key: str = Header(None),
):
    return _set(EFT, set_id, request, x_atlas_key, x_admin_key)


@router.get("/atlas/api/arena/sets/{set_id}")
def atlas_arena_set(
    set_id: str,
    request: Request,
    x_atlas_key: str = Header(None),
    x_admin_key: str = Header(None),
):
    return _set(ARENA, set_id, request, x_atlas_key, x_admin_key)


# A set file holds {"$atlas_value": n, "bytes": size} in place of a value too large to
# inline (a whole new file, say); the value itself is sets/<id>/<n>.json, fetched on demand
# under the same gate as its set.
def _set_value(
    game: str, set_id: str, value_id: str, request: Request, x_atlas_key: str | None, x_admin_key: str | None
) -> Response:
    level = access_level(request, x_atlas_key, x_admin_key)
    is_public = _gate_set(set_id, level, game)
    if not _VALUE_ID_RE.fullmatch(value_id):
        raise HTTPException(status_code=404, detail="Not found")
    return _serve(os.path.join(_export_dir(game), "sets", set_id, f"{value_id}.json"), is_public, game, request)


@router.get("/atlas/api/sets/{set_id}/values/{value_id}")
def atlas_set_value(
    set_id: str,
    value_id: str,
    request: Request,
    x_atlas_key: str = Header(None),
    x_admin_key: str = Header(None),
):
    return _set_value(EFT, set_id, value_id, request, x_atlas_key, x_admin_key)


@router.get("/atlas/api/arena/sets/{set_id}/values/{value_id}")
def atlas_arena_set_value(
    set_id: str,
    value_id: str,
    request: Request,
    x_atlas_key: str = Header(None),
    x_admin_key: str = Header(None),
):
    return _set_value(ARENA, set_id, value_id, request, x_atlas_key, x_admin_key)


# ---------------------------------------------------
# Feed for other sites
# ---------------------------------------------------

# The key goes in X-Atlas-Key or "Authorization: Bearer atl_...". We don't open CORS for the
# feed: a key in a browser is a key handed to every visitor, so the pull belongs on the other
# site's server. Every call reads the key file again (see _valid_key), so a revoke or an
# expiry made through any worker applies to all of them at once.
FEED_GAMES = (EFT, ARENA)
FEED_PAGE_DEFAULT = 50
FEED_PAGE_MAX = 200
# Requests per key per minute, counted per worker. Enough for a first full pull of every set
# within a few minutes, far more than polling for new ones needs.
FEED_RATE_LIMIT = 120
_feed_hits: dict[str, deque] = {}


def _key_in(x_atlas_key: str | None, authorization: str | None) -> str | None:
    """The key a server sent, from X-Atlas-Key or "Authorization: Bearer atl_...", or None."""
    key = x_atlas_key
    if not key and authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() == "bearer":
            key = token
    return key if key and key.strip() else None


def request_key(request: Request) -> dict | None:
    """The viewer of the key on a request, for routes that take a key without needing one (the
    player lookup): None when it carries no key, a 403 (counting towards the lockout) for a
    wrong one, so a server with a revoked key isn't quietly moved to the public allowance."""
    key = _key_in(request.headers.get("x-atlas-key"), request.headers.get("authorization"))
    if key is None:
        return None
    return access(request, key, None, LOOKUP)[1]


def _feed_access(request: Request, x_atlas_key: str | None, authorization: str | None) -> dict:
    key = _key_in(x_atlas_key, authorization)
    if key is None:
        raise HTTPException(status_code=401, detail="An Atlas key is required", headers={"WWW-Authenticate": "Bearer"})
    # No admin key here: the feed is only ever opened by a key we can revoke.
    _, viewer = access(request, key, None)
    now = time.monotonic()
    hits = _feed_hits.setdefault(viewer["id"], deque())
    while hits and hits[0] <= now - 60:
        hits.popleft()
    if len(hits) >= FEED_RATE_LIMIT:
        retry = int(hits[0] + 60 - now) + 1
        raise HTTPException(status_code=429, detail="Rate limit exceeded", headers={"Retry-After": str(retry)})
    hits.append(now)
    return viewer


def _feed_game(game: str) -> str:
    if game not in FEED_GAMES:
        raise HTTPException(status_code=404, detail="Not found")
    return game


def _detected(entry: dict) -> datetime:
    detected = datetime.fromisoformat(entry["detected"])
    return detected if detected.tzinfo else detected.replace(tzinfo=timezone.utc)


# A cursor is "<detected, in microseconds since the epoch>-<set id>": URL safe, and it orders
# sets the same way the feed does, so it still works after the set it names leaves the index.
def _order(entry: dict) -> tuple[int, str]:
    return int(_detected(entry).timestamp() * 1_000_000), entry["id"]


def _cursor_of(entry: dict) -> str:
    micros, set_id = _order(entry)
    return f"{micros}-{set_id}"


def _cursor_key(cursor: str) -> tuple[int, str]:
    micros, _, set_id = cursor.partition("-")
    if not micros.isdigit() or not _SET_ID_RE.fullmatch(set_id):
        raise HTTPException(status_code=400, detail="Invalid cursor")
    return int(micros), set_id


def _since_key(since: str) -> tuple[int, str]:
    # A "+" in an offset arrives as a space when the caller didn't encode it.
    try:
        when = datetime.fromisoformat(since.strip().replace(" ", "+").replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid since, expected an ISO 8601 time")
    when = when if when.tzinfo else when.replace(tzinfo=timezone.utc)
    # every set detected after this time, whatever its id
    return int(when.timestamp() * 1_000_000), "￿"


def _too_early_message(public_at: datetime) -> str:
    hours = f"{ATLAS_PUBLIC_DELAY_HOURS:g}"
    return (
        f"This change set is less than {hours} hours old, and the feed doesn't serve sets until they are"
        f" public (at {public_at.isoformat()}). With a valid Atlas key you can view it in Atlas directly"
        " or export its JSON there."
        " DISCLAIMER: YOU BEAR ALL LEGAL RESPONSIBILITY FOR PUBLISHING ANY CHANGE SET FROM ATLAS BEFORE ITS"
        f" {hours} HOUR PERIOD ENDS. MORPH1NE MAY REVOKE YOUR ATLAS KEY AT ANY TIME, FOR ANY REASON."
    )


def feed_page(
    sets: list[dict], cursor: str | None, since: str | None, limit: int, game: str = EFT, now: datetime | None = None
) -> dict:
    """Public sets after the cursor (or detected after since), oldest first. The caller keeps
    the returned cursor and passes it back next time; has_more means call again right away.
    Sets that aren't public yet are only listed under pending, by their headline numbers, and
    the cursor never moves past them, so the caller picks each one up once it goes public.
    Every set has the same delay and the order is by detected time, so the public sets always
    come first and the pending ones after them."""
    now = now or _now()
    ordered = sorted(sets, key=_order)
    after = _cursor_key(cursor) if cursor else _since_key(since) if since else None
    if after:
        ordered = [s for s in ordered if _order(s) > after]
    public = [s for s in ordered if _public_after(s) <= now]
    page = public[:limit]
    pending = [
        {
            **{k: s[k] for k in ("id", "detected", "version", "total") if k in s},
            "file_count": len(s.get("files") or {}),
            "public_at": _public_after(s).isoformat(),
        }
        for s in ordered
        if _public_after(s) > now
    ]
    payload = {
        "game": game,
        "server_time": now.isoformat(),
        "sets": [{**s, "public_at": _public_after(s).isoformat()} for s in page],
        "cursor": _cursor_of(page[-1]) if page else cursor,
        "has_more": len(public) > limit,
        "pending": pending,
    }
    if pending:
        payload["message"] = _too_early_message(datetime.fromisoformat(pending[0]["public_at"]))
    return payload


@router.get("/atlas/api/v1/{game}/changes")
def atlas_feed_changes(
    game: str,
    request: Request,
    response: Response,
    cursor: str | None = None,
    since: str | None = None,
    limit: int = Query(FEED_PAGE_DEFAULT, ge=1, le=FEED_PAGE_MAX),
    x_atlas_key: str = Header(None),
    authorization: str = Header(None),
):
    _feed_access(request, x_atlas_key, authorization)
    game = _feed_game(game)
    response.headers["Cache-Control"] = "private, no-store"
    return feed_page(_read_index(game), cursor, since, limit, game)


def _feed_gate(set_id: str, game: str) -> None:
    """A set that isn't public yet is a 425 Too Early with the time it opens, even for a
    valid key; unlike the page, the feed doesn't hide that the set exists."""
    if not _SET_ID_RE.fullmatch(set_id):
        raise HTTPException(status_code=404, detail="Not found")
    entry = next((s for s in _read_index(game) if s.get("id") == set_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="Not found")
    public_at = _public_after(entry)
    wait = (public_at - _now()).total_seconds()
    if wait > 0:
        raise HTTPException(
            status_code=425,
            detail=_too_early_message(public_at),
            headers={"Retry-After": str(int(wait) + 1), "Cache-Control": "private, no-store"},
        )


# Served the same as the page's set files, but never cacheable, even once public, so nothing
# between us and the caller can keep answering for a key after it's revoked.
@router.get("/atlas/api/v1/{game}/sets/{set_id}")
def atlas_feed_set(
    game: str,
    set_id: str,
    request: Request,
    x_atlas_key: str = Header(None),
    authorization: str = Header(None),
):
    _feed_access(request, x_atlas_key, authorization)
    game = _feed_game(game)
    _feed_gate(set_id, game)
    return _serve(os.path.join(_export_dir(game), "sets", f"{set_id}.json"), False, game)


@router.get("/atlas/api/v1/{game}/sets/{set_id}/values/{value_id}")
def atlas_feed_set_value(
    game: str,
    set_id: str,
    value_id: str,
    request: Request,
    x_atlas_key: str = Header(None),
    authorization: str = Header(None),
):
    _feed_access(request, x_atlas_key, authorization)
    game = _feed_game(game)
    _feed_gate(set_id, game)
    if not _VALUE_ID_RE.fullmatch(value_id):
        raise HTTPException(status_code=404, detail="Not found")
    return _serve(os.path.join(_export_dir(game), "sets", set_id, f"{value_id}.json"), False, game)


# ---------------------------------------------------
# Matching times
# ---------------------------------------------------

MATCHING_MAX_HOURS = 168
MATCHING_MAX_POINTS = 288  # history points per datacenter; samples are averaged down to fit
# Samples arrive about every 100 s; a bucket shorter than that would come out empty every few
# points and break the page's lines into dashes, so short ranges get fewer, wider buckets
MATCHING_MIN_STEP = 300
MATCHING_CACHE_SECONDS = 60
_matching_cache: dict[int, tuple[float, dict]] = {}


def _matching_dir() -> str:
    if not ATLAS_MATCHING_DIR:
        raise HTTPException(status_code=503, detail="Atlas matching is not configured")
    return ATLAS_MATCHING_DIR


def _wait(value) -> int | None:
    # Waits are whole seconds; anything else in a sample is dropped rather than trusted
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 86400 else None


def _read_latest(directory: str) -> dict | None:
    try:
        with open(os.path.join(directory, "latest.json"), encoding="utf-8") as f:
            latest = json.load(f)
    except (FileNotFoundError, ValueError):
        return None
    if not isinstance(latest, dict) or not isinstance(latest.get("dataCenters"), list):
        return None
    # The ping IPs in the file are left out: the page only shows the waits
    datacenters = [
        {"region": str(dc.get("region") or ""), "name": str(dc["dataCenter"]), "wait": _wait(dc.get("avgTimeAwait"))}
        for dc in latest["dataCenters"]
        if isinstance(dc, dict) and isinstance(dc.get("dataCenter"), str)
    ]
    return {"time": latest.get("time") if isinstance(latest.get("time"), int) else None, "datacenters": datacenters}


def _read_samples(directory: str, since: int, until: int) -> list[tuple[int, dict]]:
    """(time, {datacenter: wait}) for every sample in [since, until], oldest first."""
    samples = []
    day = datetime.fromtimestamp(since, timezone.utc).date()
    last = datetime.fromtimestamp(until, timezone.utc).date()
    while day <= last:
        try:
            with open(os.path.join(directory, f"{day.isoformat()}.jsonl"), encoding="utf-8") as f:
                lines = f.readlines()
        except FileNotFoundError:
            lines = []
        for line in lines:
            try:
                sample = json.loads(line)
            except ValueError:
                continue  # a line cut short while it was being written
            when = sample.get("time") if isinstance(sample, dict) else None
            waits = sample.get("avgTimeAwait") if isinstance(sample, dict) else None
            if isinstance(when, int) and since <= when <= until and isinstance(waits, dict):
                samples.append((when, waits))
        day += timedelta(days=1)
    samples.sort(key=lambda s: s[0])
    return samples


def matching_history(samples: list[tuple[int, dict]], since: int, until: int, names: list[str]) -> dict:
    """Average the samples into at most MATCHING_MAX_POINTS equal buckets per datacenter.
    A bucket without a sample for a datacenter is None, so the page draws a gap there."""
    step = max(MATCHING_MIN_STEP, -(-(until - since) // MATCHING_MAX_POINTS))
    count = -(-(until - since) // step) or 1
    sums = {name: [0] * count for name in names}
    seen = {name: [0] * count for name in names}
    for when, waits in samples:
        i = min((when - since) // step, count - 1)
        for name in names:
            wait = _wait(waits.get(name))
            if wait is not None:
                sums[name][i] += wait
                seen[name][i] += 1
    series = {
        name: [round(sums[name][i] / seen[name][i]) if seen[name][i] else None for i in range(count)] for name in names
    }
    return {"start": since, "step": step, "series": series}


def matching_payload(directory: str, hours: int, now: datetime | None = None) -> dict:
    now = now or _now()
    until = int(now.timestamp())
    since = until - hours * 3600
    latest = _read_latest(directory)
    datacenters = latest["datacenters"] if latest else []
    samples = _read_samples(directory, since, until)
    # Datacenters from the history that the latest sample no longer lists still get a line
    names = list(dict.fromkeys([dc["name"] for dc in datacenters] + [n for _, w in samples for n in w]))
    return {
        "server_time": now.isoformat(),
        "updated": (
            datetime.fromtimestamp(latest["time"], timezone.utc).isoformat() if latest and latest["time"] else None
        ),
        "hours": hours,
        "datacenters": datacenters,
        "history": matching_history(samples, since, until, names),
    }


@router.get("/atlas/api/matching")
def atlas_matching(response: Response, hours: int = 24):
    if not 1 <= hours <= MATCHING_MAX_HOURS:
        raise HTTPException(status_code=422, detail=f"hours must be between 1 and {MATCHING_MAX_HOURS}")
    directory = _matching_dir()
    # Everyone sees the same numbers, so one copy per range serves every caller for a minute
    cached = _matching_cache.get(hours)
    if cached and cached[0] > time.monotonic():
        payload = cached[1]
    else:
        payload = matching_payload(directory, hours)
        _matching_cache[hours] = (time.monotonic() + MATCHING_CACHE_SECONDS, payload)
    response.headers["Cache-Control"] = f"public, max-age={MATCHING_CACHE_SECONDS}"
    return payload


# ---------------------------------------------------
# Header entry
# ---------------------------------------------------


# We check the file on every call rather than caching a flag, so a switch made through one
# worker shows up in all of them right away.
def entry_shown() -> bool:
    return os.path.exists(ATLAS_ENTRY_FILE)


@router.get("/atlas/api/entry")
def atlas_entry(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return {"shown": entry_shown()}


@router.get("/admin/atlas/entry", dependencies=[Depends(require_admin)])
def admin_get_atlas_entry():
    return {"shown": entry_shown()}


@router.post("/admin/atlas/entry", dependencies=[Depends(require_admin)])
def admin_set_atlas_entry(shown: bool = Body(..., embed=True)):
    if shown:
        os.makedirs(os.path.dirname(ATLAS_ENTRY_FILE) or ".", exist_ok=True)
        open(ATLAS_ENTRY_FILE, "w").close()
    else:
        try:
            os.remove(ATLAS_ENTRY_FILE)
        except FileNotFoundError:
            pass
    return {"shown": shown}


# ---------------------------------------------------
# Admin - Atlas keys
# ---------------------------------------------------


@router.post("/admin/atlas/keys", dependencies=[Depends(require_admin)])
def admin_create_atlas_key(
    name: str = Body(..., embed=True, max_length=60),
    expires_days: float | None = Body(None),
    scopes: Annotated[list[str] | None, Body()] = None,
):
    """A new key, with every scope unless scopes names fewer (["lookup"] for a chat bot)."""
    scopes = list(dict.fromkeys(scopes)) if scopes else list(SCOPES)
    unknown = [s for s in scopes if s not in SCOPES]
    if unknown:
        raise HTTPException(status_code=422, detail=f"scopes must be among {', '.join(SCOPES)}")
    key = _KEY_PREFIX + secrets.token_urlsafe(24)
    entry = {
        "id": secrets.token_hex(4),
        "name": name.strip(),
        "hash": _hash(key),
        "created_at": _now().isoformat(timespec="seconds"),
        "expires_at": (_now() + timedelta(days=expires_days)).isoformat(timespec="seconds") if expires_days else None,
        "revoked": False,
        "scopes": scopes,
    }
    with _keys_lock:
        _save_keys([*_load_keys(), entry])
    # The key itself is only ever shown here.
    return {"id": entry["id"], "name": entry["name"], "key": key, "expires_at": entry["expires_at"], "scopes": scopes}


@router.get("/admin/atlas/keys", dependencies=[Depends(require_admin)])
def admin_list_atlas_keys():
    return [{**{k: v for k, v in key.items() if k != "hash"}, "scopes": scopes_of(key)} for key in _load_keys()]


@router.delete("/admin/atlas/keys/{key_id}", dependencies=[Depends(require_admin)])
def admin_revoke_atlas_key(key_id: str):
    with _keys_lock:
        keys = _load_keys()
        for k in keys:
            if k["id"] == key_id:
                k["revoked"] = True
                _save_keys(keys)
                return {"id": key_id, "revoked": True}
    raise HTTPException(status_code=404, detail="Key not found")
