"""Atlas: game data change sets, time-gated for the public.

ATLAS_EXPORT_DIR holds index.json plus sets/<id>.json, each set with a UTC "detected"
time. Nothing in this repo writes them; we only read and serve them. Normal
visitors only see sets older than ATLAS_PUBLIC_DELAY_HOURS. The admin key or a personal
Atlas key (X-Atlas-Key) shows everything at once. Keys are created and revoked by the
admin; only their SHA-256 is stored, in ATLAS_KEYS_FILE.

Caching: the index differs per caller and is never cached. A set file is the same for
everyone, so it is cacheable once public; before that it is no-store, so a CDN can't
hand a key holder's early copy to the public.

The admin also switches EFTForge's header button for Atlas on and off (hidden by default);
that only hides the way in, never the page or its data.
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Request, Response

from config import RUNTIME_DIR
from routers.shared import get_client_ip, require_admin

router = APIRouter()

ATLAS_EXPORT_DIR = os.environ.get("ATLAS_EXPORT_DIR", "").strip()
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


def access(request: Request, x_atlas_key: str | None, x_admin_key: str | None) -> tuple[str, dict | None]:
    """(level, viewer): public, key or admin, plus who the page watermarks itself with - the
    key's id (the one the admin key list shows, never the key itself) and the name it was
    created with for a key, None for the public and the admin.
    A wrong key is a 403 (and counts towards a lockout) rather than silently falling back
    to the public view, so a typo is noticed."""
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
    return KEY, {"id": entry["id"], "name": entry.get("name") or ""}


def access_level(request: Request, x_atlas_key: str | None, x_admin_key: str | None) -> str:
    return access(request, x_atlas_key, x_admin_key)[0]


# ---------------------------------------------------
# Change sets
# ---------------------------------------------------


def _export_dir() -> str:
    if not ATLAS_EXPORT_DIR:
        raise HTTPException(status_code=503, detail="Atlas is not configured")
    return ATLAS_EXPORT_DIR


def _read_index() -> list[dict]:
    try:
        with open(os.path.join(_export_dir(), "index.json"), encoding="utf-8") as f:
            return json.load(f).get("sets", [])
    except FileNotFoundError:
        return []


def _public_after(entry: dict) -> datetime:
    return datetime.fromisoformat(entry["detected"]) + timedelta(hours=ATLAS_PUBLIC_DELAY_HOURS)


def visible_index(level: str, sets: list[dict], now: datetime | None = None) -> dict:
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
        "access": level,
        "delay_hours": ATLAS_PUBLIC_DELAY_HOURS,
        "server_time": now.isoformat(),
        "sets": shown,
    }


@router.get("/atlas/api/index")
def atlas_index(
    request: Request,
    response: Response,
    x_atlas_key: str = Header(None),
    x_admin_key: str = Header(None),
):
    level, viewer = access(request, x_atlas_key, x_admin_key)
    response.headers["Cache-Control"] = "private, no-store"
    # The page watermarks early access sets with the viewer, so a leaked screenshot names
    # the key to revoke.
    return {
        **visible_index(level, _read_index()),
        "viewer": viewer["id"] if viewer else None,
        "viewer_name": viewer["name"] if viewer else None,
    }


def _gate_set(set_id: str, level: str) -> bool:
    """Whether the set is public yet. A set that isn't public (for this caller) looks exactly
    like one that doesn't exist."""
    if not _SET_ID_RE.fullmatch(set_id):
        raise HTTPException(status_code=404, detail="Not found")
    entry = next((s for s in _read_index() if s.get("id") == set_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="Not found")
    is_public = _public_after(entry) <= _now()
    if level == PUBLIC and not is_public:
        raise HTTPException(status_code=404, detail="Not found")
    return is_public


def _serve(path: str, is_public: bool) -> Response:
    # The ids in the path are checked before we get here; we still refuse anything that
    # resolves outside sets/, so a looser check later can't open other files.
    sets_dir = os.path.realpath(os.path.join(_export_dir(), "sets"))
    path = os.path.realpath(path)
    if not path.startswith(sets_dir + os.sep):
        raise HTTPException(status_code=404, detail="Not found")
    try:
        with open(path, "rb") as f:
            body = f.read()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Not found")
    cache = "public, max-age=3600" if is_public else "private, no-store"
    return Response(content=body, media_type="application/json", headers={"Cache-Control": cache})


@router.get("/atlas/api/sets/{set_id}")
def atlas_set(
    set_id: str,
    request: Request,
    x_atlas_key: str = Header(None),
    x_admin_key: str = Header(None),
):
    level = access_level(request, x_atlas_key, x_admin_key)
    is_public = _gate_set(set_id, level)
    return _serve(os.path.join(_export_dir(), "sets", f"{set_id}.json"), is_public)


# A set file holds {"$atlas_value": n, "bytes": size} in place of a value too large to
# inline (a whole new file, say); the value itself is sets/<id>/<n>.json, fetched on demand
# under the same gate as its set.
@router.get("/atlas/api/sets/{set_id}/values/{value_id}")
def atlas_set_value(
    set_id: str,
    value_id: str,
    request: Request,
    x_atlas_key: str = Header(None),
    x_admin_key: str = Header(None),
):
    level = access_level(request, x_atlas_key, x_admin_key)
    is_public = _gate_set(set_id, level)
    if not _VALUE_ID_RE.fullmatch(value_id):
        raise HTTPException(status_code=404, detail="Not found")
    return _serve(os.path.join(_export_dir(), "sets", set_id, f"{value_id}.json"), is_public)


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
def admin_create_atlas_key(name: str = Body(..., embed=True, max_length=60), expires_days: float | None = Body(None)):
    key = _KEY_PREFIX + secrets.token_urlsafe(24)
    entry = {
        "id": secrets.token_hex(4),
        "name": name.strip(),
        "hash": _hash(key),
        "created_at": _now().isoformat(timespec="seconds"),
        "expires_at": (_now() + timedelta(days=expires_days)).isoformat(timespec="seconds") if expires_days else None,
        "revoked": False,
    }
    with _keys_lock:
        _save_keys([*_load_keys(), entry])
    # The key itself is only ever shown here.
    return {"id": entry["id"], "name": entry["name"], "key": key, "expires_at": entry["expires_at"]}


@router.get("/admin/atlas/keys", dependencies=[Depends(require_admin)])
def admin_list_atlas_keys():
    return [{k: v for k, v in key.items() if k != "hash"} for key in _load_keys()]


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
