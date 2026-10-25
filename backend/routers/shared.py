"""Helpers most routers need: DB sessions, request identity, admin auth, request
validation limits, and item/user text helpers. Feature-specific logic belongs in
its own router or service module."""

import hashlib
import hmac
import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import Header, HTTPException, Request
from sqlalchemy.orm import Session

from config import ADMIN_API_KEY, IP_HASH_SECRET, TRUSTED_PROXY_IPS
from database import SessionLocal
from database_builds import BuildsSessionLocal
from database_changelog import ChangelogSessionLocal
from database_ratings import RatingsSessionLocal
from models_builds import IPBan
from models_items import Item

_logger = logging.getLogger(__name__)


# ---------------------------------------------------
# Database sessions
# ---------------------------------------------------


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_ratings_db():
    db = RatingsSessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_builds_db():
    db = BuildsSessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_changelog_db():
    db = ChangelogSessionLocal()
    try:
        yield db
    finally:
        db.close()


# ---------------------------------------------------
# Request identity
# ---------------------------------------------------

_ITEM_ID_RE = re.compile(r"^[0-9a-f]{24}$")


def validate_item_id(item_id: str) -> None:
    if not _ITEM_ID_RE.match(item_id):
        raise HTTPException(status_code=400, detail="Invalid item_id format")


def get_client_ip(request: Request) -> str:
    """Return the real client IP. Forwarding headers are only trusted when the
    direct connection comes from a known reverse proxy (TRUSTED_PROXY_IPS)."""
    direct_ip = request.client.host if request.client else ""
    if direct_ip in TRUSTED_PROXY_IPS:
        xff = request.headers.get("X-Forwarded-For")
        if xff:
            return xff.split(",")[0].strip()
        xri = request.headers.get("X-Real-IP")
        if xri:
            return xri.strip()
    return direct_ip


# UUID v4 format: 8-4-4-4-12 hex, version nibble = 4, variant bits = 8|9|a|b
CLIENT_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def get_client_id_hash(x_client_id: str | None) -> str:
    """Validate the X-Client-ID header and return its HMAC-SHA256 hash.
    Raises HTTP 400 if missing or not a valid UUID v4."""
    if not x_client_id or not CLIENT_ID_RE.match(x_client_id.strip().lower()):
        raise HTTPException(status_code=400, detail="Missing or invalid X-Client-ID.")
    return hmac.new(
        IP_HASH_SECRET.encode(),
        x_client_id.strip().lower().encode(),
        hashlib.sha256,
    ).hexdigest()


def get_optional_client_id_hash(x_client_id: str | None) -> str | None:
    """Return the client_id_hash if the header is present and valid, else None."""
    if not x_client_id:
        return None
    cleaned = x_client_id.strip().lower()
    if not CLIENT_ID_RE.match(cleaned):
        return None
    return hmac.new(IP_HASH_SECRET.encode(), cleaned.encode(), hashlib.sha256).hexdigest()


# ---------------------------------------------------
# Admin auth
# ---------------------------------------------------

# Admin brute-force lockout: ip -> (fail_count, lockout_until_monotonic, last_failure_monotonic)
_admin_failures: dict[str, tuple[int, float, float]] = {}
_ADMIN_MAX_FAILURES = 5
_ADMIN_LOCKOUT_SECONDS = 600  # 10 minutes


def _evict_expired_admin_failures(now: float) -> None:
    """Remove expired lockouts and idle below-threshold entries so the dict
    cannot grow without bound under failed-auth probes from many IPs."""
    expired = [
        ip
        for ip, (_, lockout_until, last_fail) in _admin_failures.items()
        if (lockout_until > 0 and lockout_until < now)
        or (lockout_until == 0 and now - last_fail > _ADMIN_LOCKOUT_SECONDS)
    ]
    for ip in expired:
        del _admin_failures[ip]


def require_admin(request: Request, x_admin_key: str = Header(None)) -> None:
    if not ADMIN_API_KEY:
        raise HTTPException(status_code=503, detail="Admin not configured")

    ip = get_client_ip(request)
    now = time.monotonic()
    _evict_expired_admin_failures(now)

    fail_count, lockout_until, _ = _admin_failures.get(ip, (0, 0.0, 0.0))
    if lockout_until > now:
        raise HTTPException(status_code=429, detail="Too many failed attempts. Try again later.")

    if not x_admin_key or not hmac.compare_digest(x_admin_key, ADMIN_API_KEY):
        new_count = fail_count + 1
        locked_until = (now + _ADMIN_LOCKOUT_SECONDS) if new_count >= _ADMIN_MAX_FAILURES else 0.0
        _admin_failures[ip] = (new_count, locked_until, now)
        raise HTTPException(status_code=403, detail="Forbidden")

    # Success - reset counter
    _admin_failures.pop(ip, None)


# ---------------------------------------------------
# Community build records
# ---------------------------------------------------


def safe_json_loads(s: str | None):
    """Parse a JSON string; return None and log on corruption instead of raising."""
    if not s:
        return None
    try:
        return json.loads(s)
    except (json.JSONDecodeError, ValueError):
        _logger.error("Corrupted JSON in build record: %.60r", s)
        return None


def public_card_url(url: str | None) -> str | None:
    # Hide the migration worker's markers ("error:", "wait:", "dryrun:") from
    # clients, which would otherwise try to load them as image URLs.
    return url if url and url.startswith(("https://", "http://")) else None


# ---------------------------------------------------
# Request validation
# ---------------------------------------------------

STRENGTH_LEVEL_MIN = 0
STRENGTH_LEVEL_MAX = 51  # 0 = no skill, 51 = elite
EQUIP_ERGO_MIN = -1.0  # negative = armor/rig ergonomics penalty
EQUIP_ERGO_MAX = 1.0  # positive = ergonomics bonus
VALID_GAME_MODES = {"pvp", "pve", "pvpSeason"}

# Request complexity caps - generous for real clients, block abuse of the
# CPU-heavy calculation endpoints with arbitrarily large payloads.
MAX_INSTALLED_IDS = 300
MAX_CANDIDATE_IDS = 2000
MAX_COMBO_BATCH = 5000
MAX_IMAGE_ITEMS = 150
MAX_STATS_JSON_CHARS = 2000


def cap_list(name: str, value: list, limit: int) -> None:
    if len(value) > limit:
        raise HTTPException(status_code=422, detail=f"{name} exceeds maximum length of {limit}")


# ---------------------------------------------------
# Language helpers
# ---------------------------------------------------


def item_name(item, lang: str) -> str:
    return (item.name_zh or item.name) if lang == "zh" else item.name


def item_short_name(item, lang: str) -> str:
    return (item.short_name_zh or item.short_name) if lang == "zh" else item.short_name


def item_category(item, lang: str) -> Optional[str]:
    return (item.attachment_category_zh or item.attachment_category) if lang == "zh" else item.attachment_category


# ---------------------------------------------------
# User-submitted text and community build checks
# ---------------------------------------------------


def strip_html_tags(s: str) -> str:
    """Strip HTML tags in O(n) time.

    A backtracking regex like <[^>]+> is quadratic on adversarial input with
    many '<' and no closing '>' (each failed match rescans to the end of the
    string). This walks the string once, only searching forward from each
    '<' and giving up on the whole string once one search comes up empty.
    """
    out = []
    i, n = 0, len(s)
    no_more_close = False
    while i < n:
        if not no_more_close and s[i] == "<":
            j = s.find(">", i + 1)
            if j == -1:
                no_more_close = True
            elif j > i + 1:
                i = j + 1
                continue
        out.append(s[i])
        i += 1
    return "".join(out)


def sanitize_build_name(raw: str) -> str:
    """Strip HTML tags and collapse whitespace."""
    return " ".join(strip_html_tags(raw).split())


def check_client_ban(client_id_hash: str, db: Session) -> None:
    """Raise 403 if the client is currently banned from publishing."""
    ban = db.query(IPBan).filter(IPBan.ip_hash == client_id_hash).first()
    if not ban:
        return
    if ban.banned_until is None or ban.banned_until > datetime.now(timezone.utc).replace(tzinfo=None):
        raise HTTPException(status_code=403, detail="You are banned from publishing.")


def validate_pairs(pairs: list, db_main: Session) -> None:
    """Validate that pairs has at least one attachment and all item IDs exist."""
    if len(pairs) < 1:
        raise HTTPException(status_code=422, detail="Build must have at least one attachment.")
    item_ids = [p[1] for p in pairs]
    found = {r[0] for r in db_main.query(Item.id).filter(Item.id.in_(item_ids)).all()}
    missing = [iid for iid in item_ids if iid not in found]
    if missing:
        raise HTTPException(status_code=422, detail=f"Unknown item IDs: {missing[:5]}")


def sanitize_username(raw: str) -> str:
    return " ".join(strip_html_tags(raw).split())[:30]
