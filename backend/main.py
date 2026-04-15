import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

from fastapi import BackgroundTasks, FastAPI, Body, Depends, HTTPException, Header, Request
from starlette.middleware.gzip import GZipMiddleware as GZIPMiddleware
from sqlalchemy import case, func, text
from sqlalchemy.orm import Session
from typing import List

from database import SessionLocal, engine, Base
from models_items import Item
from models_slots import Slot
from models_slot_allowed import SlotAllowedItem
from models_traders import Trader
from models_stat_changelog import StatChangeLog  # noqa: F401 - registers table with Base.metadata

from database_ratings import ratings_engine, RatingsSessionLocal, RatingsBase
from models_ratings import AttachmentVote, AttachmentRating  # noqa: F401 - registers tables

from database_builds import builds_engine, BuildsSessionLocal, BuildsBase
from models_builds import PublicBuild, PublicBuildAuthor, IPBan, PendingNotification, ServerAnnouncement, BuildVote, BuildRating  # noqa: F401 - registers tables

from fastapi.middleware.cors import CORSMiddleware

from config import CORS_ORIGINS, IP_HASH_SECRET, ADMIN_API_KEY, ENABLE_API_DOCS, TRUSTED_PROXY_IPS

_docs_url    = "/docs"    if ENABLE_API_DOCS else None
_redoc_url   = "/redoc"   if ENABLE_API_DOCS else None
_openapi_url = "/openapi.json" if ENABLE_API_DOCS else None

app = FastAPI(title="EFTForge API", docs_url=_docs_url, redoc_url=_redoc_url, openapi_url=_openapi_url)

# Recorded once at process start - clients use this to detect a backend restart
# and bypass their local update-check TTL so a fresh deploy is noticed immediately.
SERVER_START_TIME = int(time.time())

# Validation constants
STRENGTH_LEVEL_MIN = 0
STRENGTH_LEVEL_MAX = 51   # 0 = no skill, 51 = elite
EQUIP_ERGO_MIN = -1.0     # negative = armor/rig ergonomics penalty
EQUIP_ERGO_MAX = 1.0      # positive = ergonomics bonus

app.add_middleware(GZIPMiddleware, minimum_size=500)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "X-Admin-Key", "X-Client-ID"],
)

Base.metadata.create_all(bind=engine)
RatingsBase.metadata.create_all(bind=ratings_engine)
BuildsBase.metadata.create_all(bind=builds_engine)


def _migrate_builds_db():
    with builds_engine.connect() as conn:
        existing = {row[1] for row in conn.execute(text("PRAGMA table_info(public_builds)"))}
        if "ammo_id" not in existing:
            conn.execute(text("ALTER TABLE public_builds ADD COLUMN ammo_id TEXT"))
            conn.commit()


def _migrate_items_db():
    with engine.connect() as conn:
        existing = {row[1] for row in conn.execute(text("PRAGMA table_info(items)"))}
        if "task_unlock_id" not in existing:
            conn.execute(text("ALTER TABLE items ADD COLUMN task_unlock_id TEXT"))
            conn.commit()
        if "task_unlock_name" not in existing:
            conn.execute(text("ALTER TABLE items ADD COLUMN task_unlock_name TEXT"))
            conn.commit()
        if "task_unlock_name_zh" not in existing:
            conn.execute(text("ALTER TABLE items ADD COLUMN task_unlock_name_zh TEXT"))
            conn.commit()
        if "sighting_range" not in existing:
            conn.execute(text("ALTER TABLE items ADD COLUMN sighting_range INTEGER"))
            conn.commit()
        if "bare_image_512_link" not in existing:
            conn.execute(text("ALTER TABLE items ADD COLUMN bare_image_512_link TEXT"))
            conn.commit()



def _migrate_slots_db():
    with engine.connect() as conn:
        existing = {row[1] for row in conn.execute(text("PRAGMA table_info(slots)"))}
        if "slot_game_name" not in existing:
            conn.execute(text("ALTER TABLE slots ADD COLUMN slot_game_name TEXT"))
            conn.commit()


_migrate_builds_db()
_migrate_items_db()
_migrate_slots_db()


# ---------------------------------------------------
# Language helpers
# ---------------------------------------------------

def _item_name(item, lang: str) -> str:
    return (item.name_zh or item.name) if lang == "zh" else item.name

def _item_short_name(item, lang: str) -> str:
    return (item.short_name_zh or item.short_name) if lang == "zh" else item.short_name


# ---------------------------------------------------
# Database
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


# ---------------------------------------------------
# Ratings helpers
# ---------------------------------------------------

_ITEM_ID_RE = re.compile(r'^[0-9a-f]{24}$')

def _validate_item_id(item_id: str) -> None:
    if not _ITEM_ID_RE.match(item_id):
        raise HTTPException(status_code=400, detail="Invalid item_id format")

def _get_client_ip(request: Request) -> str:
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

# Admin brute-force lockout: ip -> (fail_count, lockout_until_monotonic)
_admin_failures: dict[str, tuple[int, float]] = {}
_ADMIN_MAX_FAILURES = 5
_ADMIN_LOCKOUT_SECONDS = 600  # 10 minutes

def _evict_expired_admin_failures(now: float) -> None:
    """Remove lockout entries whose window has fully passed."""
    expired = [ip for ip, (_, lockout_until) in _admin_failures.items() if lockout_until > 0 and lockout_until < now]
    for ip in expired:
        del _admin_failures[ip]

# Community builds kill switch.
# Persisted via a sentinel file so it survives server restarts.
_COMMUNITY_BUILDS_LOCK_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "community_builds.lock")
_community_builds_disabled: bool = os.path.exists(_COMMUNITY_BUILDS_LOCK_FILE)

def _require_admin(request: Request, x_admin_key: str = Header(None)) -> None:
    if not ADMIN_API_KEY:
        raise HTTPException(status_code=503, detail="Admin not configured")

    ip = _get_client_ip(request)
    now = time.monotonic()
    _evict_expired_admin_failures(now)

    fail_count, lockout_until = _admin_failures.get(ip, (0, 0.0))
    if lockout_until > now:
        raise HTTPException(status_code=429, detail="Too many failed attempts. Try again later.")

    if not x_admin_key or not hmac.compare_digest(x_admin_key, ADMIN_API_KEY):
        new_count = fail_count + 1
        locked_until = (now + _ADMIN_LOCKOUT_SECONDS) if new_count >= _ADMIN_MAX_FAILURES else 0.0
        _admin_failures[ip] = (new_count, locked_until)
        raise HTTPException(status_code=403, detail="Forbidden")

    # Success - reset counter
    _admin_failures.pop(ip, None)


# ---------------------------------------------------
# Client identity helpers (token-based, not IP-based)
# ---------------------------------------------------

# UUID v4 format: 8-4-4-4-12 hex, version nibble = 4, variant bits = 8|9|a|b
_CLIENT_ID_RE = re.compile(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
)

def _get_client_id_hash(x_client_id: str | None) -> str:
    """Validate the X-Client-ID header and return its HMAC-SHA256 hash.
    Raises HTTP 400 if missing or not a valid UUID v4."""
    if not x_client_id or not _CLIENT_ID_RE.match(x_client_id.strip().lower()):
        raise HTTPException(status_code=400, detail="Missing or invalid X-Client-ID.")
    return hmac.new(
        IP_HASH_SECRET.encode(),
        x_client_id.strip().lower().encode(),
        hashlib.sha256,
    ).hexdigest()

def _get_optional_client_id_hash(x_client_id: str | None) -> str | None:
    """Return the client_id_hash if the header is present and valid, else None."""
    if not x_client_id:
        return None
    cleaned = x_client_id.strip().lower()
    if not _CLIENT_ID_RE.match(cleaned):
        return None
    return hmac.new(IP_HASH_SECRET.encode(), cleaned.encode(), hashlib.sha256).hexdigest()


# ---------------------------------------------------
# Build publish helpers
# ---------------------------------------------------

_logger = logging.getLogger(__name__)

def _safe_json_loads(s: str | None):
    """Parse a JSON string; return None and log on corruption instead of raising."""
    if not s:
        return None
    try:
        return json.loads(s)
    except (json.JSONDecodeError, ValueError):
        _logger.error("Corrupted JSON in build record: %.60r", s)
        return None

# publish rate limit: client_id_hash -> monotonic time of last successful publish
_publish_last: dict[str, float] = {}
_PUBLISH_COOLDOWN = 60.0

_HTML_TAG_RE = re.compile(r'<[^>]+>')

def _sanitize_build_name(raw: str) -> str:
    """Strip HTML tags and collapse whitespace."""
    return " ".join(_HTML_TAG_RE.sub("", raw).split())

def _check_client_ban(client_id_hash: str, db: Session) -> None:
    """Raise 403 if the client is currently banned from publishing."""
    ban = db.query(IPBan).filter(IPBan.ip_hash == client_id_hash).first()
    if not ban:
        return
    if ban.banned_until is None or ban.banned_until > datetime.now(timezone.utc).replace(tzinfo=None):
        raise HTTPException(status_code=403, detail="You are banned from publishing.")

def _validate_pairs(pairs: list, db_main: Session) -> None:
    """Validate that pairs has at least one attachment and all item IDs exist."""
    if len(pairs) <= 1:
        raise HTTPException(status_code=422, detail="Build must have at least one attachment.")
    item_ids = [p[1] for p in pairs]
    found = {r[0] for r in db_main.query(Item.id).filter(Item.id.in_(item_ids)).all()}
    missing = [iid for iid in item_ids if iid not in found]
    if missing:
        raise HTTPException(status_code=422, detail=f"Unknown item IDs: {missing[:5]}")


# ---------------------------------------------------
# Shared calculation helpers (no DB access)
# ---------------------------------------------------

def _compute_stats(base_item, current_ids: list, items_map: dict,
                   strength_level: int = 10, equip_ergo_modifier: float = 0.0) -> dict:
    """Compute build stats from pre-loaded items. No DB queries."""
    factory_ids = base_item.factory_attachment_ids.split(",") if base_item.factory_attachment_ids else []
    factory_set = set(factory_ids)
    current_set = set(current_ids)
    factory_intact = bool(factory_set) and factory_set.issubset(current_set)

    receiver_ergo = base_item.base_ergonomics or 0
    receiver_weight = base_item.weight or 0
    factory_ergo = base_item.factory_ergonomics or receiver_ergo
    factory_weight = base_item.factory_weight or receiver_weight

    if factory_intact:
        total_ergo = factory_ergo
        total_weight = factory_weight
        total_recoil_v = base_item.factory_recoil_vertical if base_item.factory_recoil_vertical is not None else base_item.recoil_vertical
        total_recoil_h = base_item.factory_recoil_horizontal if base_item.factory_recoil_horizontal is not None else base_item.recoil_horizontal
    else:
        total_ergo = receiver_ergo
        total_weight = receiver_weight
        total_recoil_v = base_item.recoil_vertical
        total_recoil_h = base_item.recoil_horizontal

    total_recoil_modifier = 0.0
    for att_id in current_ids:
        att = items_map.get(att_id)
        if not att:
            continue
        if factory_intact and att_id in factory_set:
            continue
        total_ergo += att.ergonomics_modifier or 0
        total_weight += att.weight or 0
        total_recoil_modifier += att.recoil_modifier or 0

    if not factory_intact:
        if total_recoil_v is not None:
            total_recoil_v = round(total_recoil_v * (1 + total_recoil_modifier))
        if total_recoil_h is not None:
            total_recoil_h = round(total_recoil_h * (1 + total_recoil_modifier))

    b = equip_ergo_modifier
    E = total_ergo * (1 + b)
    KG = 0.0007556 * (E ** 2) + 0.02736 * E + 2.9159
    evo_weight = total_weight - KG
    eed = -15 * evo_weight

    arm_stamina = (
        (85.5 / (total_weight + 0.65))
        + 9.15
        + 0.06477 * total_ergo * (1 + b / 2)
    ) / 1.04 * (1 + strength_level * 0.004)

    # Effective sighting range: max scope sighting range installed, else weapon base
    effective_sighting_range = base_item.sighting_range
    for att_id in current_ids:
        att = items_map.get(att_id)
        if att and att.sighting_range is not None and att.sighting_range > 0:
            if effective_sighting_range is None or att.sighting_range > effective_sighting_range:
                effective_sighting_range = att.sighting_range

    return {
        "total_ergo": round(total_ergo, 2),
        "total_weight": round(total_weight, 3),
        "overswing": evo_weight > 0,
        "evo_ergo_delta": round(eed, 2),
        "recoil_vertical": total_recoil_v,
        "recoil_horizontal": total_recoil_h,
        "arm_stamina": round(arm_stamina, 1),
        "sighting_range": effective_sighting_range,
    }


def _check_conflicts(candidate, candidate_id: str, installed_set: set,
                     installed_items_map: dict, slots_by_item: dict,
                     slot_id: str, lang: str) -> dict:
    """Run all four conflict checks using pre-loaded data. No DB queries."""
    # Item ↔ item
    if candidate.conflicting_item_ids:
        conflict_ids = set(candidate.conflicting_item_ids.split(","))
        overlap = conflict_ids.intersection(installed_set)
        if overlap:
            conflicting = installed_items_map.get(list(overlap)[0])
            if conflicting:
                return {"valid": False, "reason_key": "conflict.incompatibleWith",
                        "reason_name": _item_name(conflicting, lang),
                        "conflicting_item_id": conflicting.id, "conflicting_slot_id": None}

    # Slot ↔ slot
    if candidate.conflicting_slot_ids:
        conflict_slots = set(candidate.conflicting_slot_ids.split(","))
        for iid in installed_set:
            for s in slots_by_item.get(iid, []):
                if s.id in conflict_slots:
                    return {"valid": False, "reason_key": "conflict.slot",
                            "reason_name": s.slot_name,
                            "conflicting_item_id": None, "conflicting_slot_id": s.id}

    # Reverse item ↔ item
    for inst_item in installed_items_map.values():
        if inst_item.conflicting_item_ids:
            if candidate_id in set(inst_item.conflicting_item_ids.split(",")):
                return {"valid": False, "reason_key": "conflict.incompatibleWith",
                        "reason_name": _item_name(inst_item, lang),
                        "conflicting_item_id": inst_item.id, "conflicting_slot_id": None}

    # Reverse slot
    for inst_item in installed_items_map.values():
        if inst_item.conflicting_slot_ids:
            if slot_id in set(inst_item.conflicting_slot_ids.split(",")):
                return {"valid": False, "reason_key": "conflict.blockedBy",
                        "reason_name": _item_name(inst_item, lang),
                        "conflicting_item_id": inst_item.id, "conflicting_slot_id": None}

    return {"valid": True, "reason_key": None, "reason_name": None,
            "conflicting_item_id": None, "conflicting_slot_id": None}


# ---------------------------------------------------
# Health check
# ---------------------------------------------------

@app.api_route("/health", methods=["GET", "HEAD"])
def health_check(request: Request, db: Session = Depends(get_db)):
    """Liveness + basic DB connectivity check for load balancers / monitoring."""
    try:
        db.execute(text("SELECT 1"))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"DB unavailable: {exc}")
    return {"status": "ok", "started": SERVER_START_TIME}


# ---------------------------------------------------
# Traders
# ---------------------------------------------------

@app.get("/traders")
def get_traders(db: Session = Depends(get_db)):
    traders = db.query(Trader).all()
    return [
        {
            "id":             t.id,
            "name":           t.name,
            "normalizedName": t.normalized_name,
            "imageLink":      t.image_link,
            "image4xLink":    t.image_4x_link,
        }
        for t in traders
    ]


# Weapons
# ---------------------------------------------------

@app.get("/guns")
def get_guns(lang: str = "en", db: Session = Depends(get_db)):
    guns = db.query(Item).filter(Item.is_weapon == True).all()

    result = []

    for gun in guns:

        if gun.factory_attachment_ids:
            factory_ids = gun.factory_attachment_ids.split(",")
        else:
            factory_ids = []

        result.append({
            "id": gun.id,
            "name": _item_name(gun, lang),
            "short_name": _item_short_name(gun, lang),
            "base_ergo": gun.factory_ergonomics or gun.base_ergonomics or 0,
            "weight": gun.weight or 0,
            "icon_link": gun.icon_link,
            "preset_icon_link": gun.preset_icon_link,
            "image_512_link": gun.image_512_link,
            "bare_image_512_link": gun.bare_image_512_link,
            "factory_attachment_ids": factory_ids,
            "caliber": gun.caliber,
            "weapon_category": gun.weapon_category,
            "recoil_vertical": gun.recoil_vertical,
            "recoil_horizontal": gun.recoil_horizontal,
            "sighting_range": gun.sighting_range,
            "center_of_impact": gun.center_of_impact,
            "camera_snap": gun.camera_snap,
            "deviation_curve": gun.deviation_curve,
            "deviation_max": gun.deviation_max,
            "recoil_angle": gun.recoil_angle,
            "camera_recoil": gun.camera_recoil,
            "convergence": gun.convergence,
            "recoil_dispersion": gun.recoil_dispersion,
            "aim_sensitivity": gun.aim_sensitivity,
            "cam_angle_step": gun.cam_angle_step,
            "mount_cam_snap": gun.mount_cam_snap,
            "mount_h_rec": gun.mount_h_rec,
            "mount_v_rec": gun.mount_v_rec,
            "mount_breath": gun.mount_breath,
            "rec_hand_rot": gun.rec_hand_rot,
            "rec_force_back": gun.rec_force_back,
            "rec_force_up": gun.rec_force_up,
            "rec_return_speed": gun.rec_return_speed,
            "trader_price":     gun.trader_price,
            "trader_price_rub": gun.trader_price_rub,
            "trader_currency":  gun.trader_currency,
            "trader_vendor":    gun.trader_vendor,
            "trader_min_level": gun.trader_min_level,
        })

    return result

@app.get("/ammo/{caliber}")
def get_ammo_for_caliber(caliber: str, lang: str = "en", db: Session = Depends(get_db)):
    ammo = db.query(Item).filter(
        Item.is_ammo == True,
        Item.caliber == caliber
    ).order_by(Item.weight.asc()).all()

    return [
        {
            "id":             a.id,
            "name":           _item_name(a, lang),
            "weight":         a.weight,
            "icon_link":      a.icon_link,
            "trader_price":     a.trader_price,
            "trader_price_rub": a.trader_price_rub,
            "trader_currency":  a.trader_currency,
            "trader_vendor":    a.trader_vendor,
            "trader_min_level": a.trader_min_level,
        }
        for a in ammo
    ]

# ---------------------------------------------------
# Item IDs (for client-side flea price prefetch)
# ---------------------------------------------------

@app.get("/items/ids")
def get_item_ids(db: Session = Depends(get_db)):
    ids = db.query(Item.id).all()
    return [row[0] for row in ids]

# ---------------------------------------------------
# Slots
# ---------------------------------------------------

@app.get("/items/{item_id}/slots")
def get_item_slots(item_id: str, db: Session = Depends(get_db)):
    slots = db.query(Slot).filter(Slot.parent_item_id == item_id).all()
    if not slots:
        return []

    slot_ids = [s.id for s in slots]

    # Count allowed items per slot in one query to avoid N+1
    counts = dict(
        db.query(SlotAllowedItem.slot_id, func.count(SlotAllowedItem.allowed_item_id))
        .filter(SlotAllowedItem.slot_id.in_(slot_ids))
        .group_by(SlotAllowedItem.slot_id)
        .all()
    )

    return [
        {
            "id": s.id,
            "parent_item_id": s.parent_item_id,
            "slot_name": s.slot_name,
            "slot_game_name": s.slot_game_name,
            "has_allowed_items": counts.get(s.id, 0) > 0,
        }
        for s in slots
    ]


# ---------------------------------------------------
# Allowed Items
# ---------------------------------------------------

@app.get("/slots/{slot_id}/allowed-items")
def get_allowed_items(slot_id: str, lang: str = "en", db: Session = Depends(get_db)):
    allowed = db.query(SlotAllowedItem).filter(
        SlotAllowedItem.slot_id == slot_id
    ).all()

    ids = [a.allowed_item_id for a in allowed]

    items = db.query(Item).filter(Item.id.in_(ids)).all()

    return [
        {
            "id": item.id,
            "name": _item_name(item, lang),
            "short_name": _item_short_name(item, lang),
            "weight": item.weight,
            "ergonomics_modifier": item.ergonomics_modifier,
            "recoil_modifier": item.recoil_modifier,
            "sighting_range": item.sighting_range,
            "icon_link": item.icon_link,
            "conflicting_item_ids": item.conflicting_item_ids,
            "conflicting_slot_ids": item.conflicting_slot_ids,
            "magazine_capacity": item.magazine_capacity,
            "caliber": item.caliber,
            "is_weapon": item.is_weapon,
            "trader_price":     item.trader_price,
            "trader_price_rub": item.trader_price_rub,
            "trader_currency":  item.trader_currency,
            "trader_vendor":    item.trader_vendor,
            "trader_min_level": item.trader_min_level,
            "task_unlock_id":      item.task_unlock_id,
            "task_unlock_name":    item.task_unlock_name,
            "task_unlock_name_zh": item.task_unlock_name_zh,
        }
        for item in items
    ]

# ---------------------------------------------------
# Build Compatibility Validation
# ---------------------------------------------------

@app.post("/build/validate")
def validate_attachment(
    base_item_id: str = Body(...),
    installed_ids: List[str] = Body(...),
    slot_id: str = Body(...),
    candidate_id: str = Body(...),
    lang: str = Body(default="en"),
    db: Session = Depends(get_db),
):

    base_item = db.query(Item).filter(Item.id == base_item_id).first()
    if not base_item:
        raise HTTPException(status_code=404, detail="Base item not found")

    candidate = db.query(Item).filter(Item.id == candidate_id).first()
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate item not found")

    # -------------------------------------------------
    # SLOT LEGALITY CHECK
    # -------------------------------------------------

    allowed = db.query(SlotAllowedItem).filter(
        SlotAllowedItem.slot_id == slot_id,
        SlotAllowedItem.allowed_item_id == candidate_id
    ).first()

    if not allowed:
        return {
            "valid": False,
            "reason": "Item not allowed in this slot",
            "type": "slot_not_allowed"
        }

    # -------------------------------------------------
    # BATCH-LOAD all installed items and their slots (2 queries total)
    # -------------------------------------------------

    installed_set = set(installed_ids)
    installed_set.add(base_item_id)

    installed_items = db.query(Item).filter(Item.id.in_(installed_set)).all()
    installed_map = {item.id: item for item in installed_items}

    all_installed_slots = db.query(Slot).filter(
        Slot.parent_item_id.in_(installed_set)
    ).all()
    slots_by_item: dict[str, list] = {item_id: [] for item_id in installed_set}
    for s in all_installed_slots:
        slots_by_item[s.parent_item_id].append(s)

    result = _check_conflicts(candidate, candidate_id, installed_set,
                              installed_map, slots_by_item, slot_id, lang)
    if not result["valid"]:
        return result

    return {"valid": True}


# ---------------------------------------------------
# Calculation Engine
# ---------------------------------------------------

@app.post("/build/calculate")
def calculate_build(
    base_item_id: str = Body(...),
    attachment_ids: List[str] | None = Body(default=None),
    assume_full_mag: bool = Body(default=True),
    selected_ammo_id: str | None = Body(default=None),
    selected_ubgl_ammo_id: str | None = Body(default=None),
    strength_level: int = Body(default=10),
    equip_ergo_modifier: float = Body(default=0.0),
    db: Session = Depends(get_db),
):

    if not (STRENGTH_LEVEL_MIN <= strength_level <= STRENGTH_LEVEL_MAX):
        raise HTTPException(status_code=422, detail=f"strength_level must be between {STRENGTH_LEVEL_MIN} and {STRENGTH_LEVEL_MAX}")

    if not (EQUIP_ERGO_MIN <= equip_ergo_modifier <= EQUIP_ERGO_MAX):
        raise HTTPException(status_code=422, detail=f"equip_ergo_modifier must be between {EQUIP_ERGO_MIN} and {EQUIP_ERGO_MAX}")

    base_item = db.query(Item).filter(Item.id == base_item_id).first()
    if not base_item:
        raise HTTPException(status_code=404, detail="Base item not found")

    current_ids = attachment_ids or []
    items_map = {}
    if current_ids:
        items_map = {
            item.id: item
            for item in db.query(Item).filter(Item.id.in_(current_ids)).all()
        }

    stats = _compute_stats(base_item, current_ids, items_map, strength_level, equip_ergo_modifier)

    # ------------------------------
    # Ammo Weight Logic (not in batch endpoint - only used for the main stats panel)
    # ------------------------------
    ammo_weight_added = False

    if assume_full_mag and selected_ammo_id:
        ammo = db.query(Item).filter(Item.id == selected_ammo_id).first()
        if ammo and ammo.is_ammo:
            for att in items_map.values():
                if att.magazine_capacity:
                    stats["total_weight"] = round(
                        stats["total_weight"] + (ammo.weight or 0) * att.magazine_capacity, 3
                    )
            ammo_weight_added = True

    # UBGL grenade ammo weight - one round per UBGL installed.
    # UBGLs are detected by caliber-match: any non-ammo installed item whose
    # caliber matches the selected grenade ammo's caliber is the UBGL.
    if assume_full_mag and selected_ubgl_ammo_id:
        grenade = db.query(Item).filter(Item.id == selected_ubgl_ammo_id).first()
        if grenade and grenade.is_ammo and grenade.caliber:
            ubgl_count = sum(
                1 for att in items_map.values()
                if att.caliber == grenade.caliber and not att.is_ammo
            )
            if ubgl_count:
                stats["total_weight"] = round(
                    stats["total_weight"] + (grenade.weight or 0) * ubgl_count, 3
                )
                ammo_weight_added = True

    if ammo_weight_added:
        # Recompute EED, overswing, and arm stamina with the ammo-adjusted weight
        b = equip_ergo_modifier
        E = stats["total_ergo"] * (1 + b)
        KG = 0.0007556 * (E ** 2) + 0.02736 * E + 2.9159
        evo_weight = stats["total_weight"] - KG
        stats["evo_ergo_delta"] = round(-15 * evo_weight, 2)
        stats["overswing"] = evo_weight > 0
        stats["arm_stamina"] = round(
            (
                (85.5 / (stats["total_weight"] + 0.65))
                + 9.15
                + 0.06477 * stats["total_ergo"] * (1 + b / 2)
            ) / 1.04 * (1 + strength_level * 0.004),
            1
        )

    return stats


# ---------------------------------------------------
# Batch Process (validation + calculation for all candidates in one request)
# ---------------------------------------------------

@app.post("/build/batch-process")
def batch_process(
    base_item_id: str = Body(...),
    installed_ids: List[str] = Body(...),
    slot_id: str = Body(...),
    candidate_ids: List[str] = Body(...),
    lang: str = Body(default="en"),
    strength_level: int = Body(default=10),
    equip_ergo_modifier: float = Body(default=0.0),
    db: Session = Depends(get_db),
):
    if not (STRENGTH_LEVEL_MIN <= strength_level <= STRENGTH_LEVEL_MAX):
        raise HTTPException(status_code=422, detail=f"strength_level must be between {STRENGTH_LEVEL_MIN} and {STRENGTH_LEVEL_MAX}")

    if not (EQUIP_ERGO_MIN <= equip_ergo_modifier <= EQUIP_ERGO_MAX):
        raise HTTPException(status_code=422, detail=f"equip_ergo_modifier must be between {EQUIP_ERGO_MIN} and {EQUIP_ERGO_MAX}")

    base_item = db.query(Item).filter(Item.id == base_item_id).first()
    if not base_item:
        raise HTTPException(status_code=404, detail="Base item not found")

    # 1. Batch-load all items needed (installed + candidates) - 1 query
    all_needed_ids = set(installed_ids) | set(candidate_ids)
    items_map = {
        item.id: item
        for item in db.query(Item).filter(Item.id.in_(all_needed_ids)).all()
    }

    # 2. Validation setup: installed items + their slots - 1 query each
    installed_set = set(installed_ids) | {base_item_id}
    installed_items_map = {iid: items_map[iid] for iid in installed_ids if iid in items_map}
    installed_items_map[base_item_id] = base_item

    all_installed_slots = db.query(Slot).filter(
        Slot.parent_item_id.in_(installed_set)
    ).all()
    slots_by_item: dict[str, list] = {iid: [] for iid in installed_set}
    for s in all_installed_slots:
        slots_by_item[s.parent_item_id].append(s)

    # 3. Which candidates are allowed in this slot - 1 query
    allowed_records = db.query(SlotAllowedItem).filter(
        SlotAllowedItem.slot_id == slot_id,
        SlotAllowedItem.allowed_item_id.in_(candidate_ids)
    ).all()
    allowed_set = {r.allowed_item_id for r in allowed_records}

    # 4. Baseline stats (installed_ids, no candidate) - no DB
    base_stats = _compute_stats(base_item, installed_ids, items_map, strength_level, equip_ergo_modifier)

    # 5. Per-candidate validation + calculation - no DB
    results = []
    for candidate_id in candidate_ids:
        candidate = items_map.get(candidate_id)
        if not candidate:
            continue

        if candidate_id not in allowed_set:
            validation = {"valid": False, "reason_key": None, "reason_name": None,
                          "conflicting_item_id": None, "conflicting_slot_id": None}
        else:
            validation = _check_conflicts(candidate, candidate_id, installed_set,
                                          installed_items_map, slots_by_item, slot_id, lang)

        sim_stats = _compute_stats(base_item, list(installed_ids) + [candidate_id],
                                   items_map, strength_level, equip_ergo_modifier)
        results.append({
            "item_id":          candidate_id,
            "trader_price":     candidate.trader_price,
            "trader_price_rub": candidate.trader_price_rub,
            "trader_currency":  candidate.trader_currency,
            "trader_vendor":    candidate.trader_vendor,
            "trader_min_level": candidate.trader_min_level,
            **validation,
            **sim_stats,
        })

    return {"base": base_stats, "candidates": results}


# ---------------------------------------------------
# Gun Init (single-request gun selection bootstrap)
# ---------------------------------------------------

@app.get("/guns/{gun_id}/init")
def get_gun_init(
    gun_id: str,
    lang: str = "en",
    strength_level: int = 10,
    equip_ergo_modifier: float = 0.0,
    selected_ammo_id: str | None = None,
    selected_ubgl_ammo_id: str | None = None,
    assume_full_mag: bool = True,
    db: Session = Depends(get_db),
):
    if not (STRENGTH_LEVEL_MIN <= strength_level <= STRENGTH_LEVEL_MAX):
        raise HTTPException(status_code=422, detail=f"strength_level must be between {STRENGTH_LEVEL_MIN} and {STRENGTH_LEVEL_MAX}")

    if not (EQUIP_ERGO_MIN <= equip_ergo_modifier <= EQUIP_ERGO_MAX):
        raise HTTPException(status_code=422, detail=f"equip_ergo_modifier must be between {EQUIP_ERGO_MIN} and {EQUIP_ERGO_MAX}")

    gun = db.query(Item).filter(Item.id == gun_id).first()
    if not gun:
        raise HTTPException(status_code=404, detail="Gun not found")

    factory_ids = [f.strip() for f in (gun.factory_attachment_ids or "").split(",") if f.strip()]

    # Batch-load all factory attachment items (1 query)
    factory_items_map = {}
    if factory_ids:
        factory_items_map = {
            item.id: item
            for item in db.query(Item).filter(Item.id.in_(factory_ids)).all()
        }

    # Batch-load all slots for gun + all factory items (1 query)
    all_item_ids = {gun_id} | set(factory_ids)
    all_slots = db.query(Slot).filter(Slot.parent_item_id.in_(all_item_ids)).all()
    all_slot_ids = [s.id for s in all_slots]

    # Count allowed items per slot for has_allowed_items (1 query)
    slot_counts = {}
    if all_slot_ids:
        slot_counts = dict(
            db.query(SlotAllowedItem.slot_id, func.count(SlotAllowedItem.allowed_item_id))
            .filter(SlotAllowedItem.slot_id.in_(all_slot_ids))
            .group_by(SlotAllowedItem.slot_id)
            .all()
        )

    # Build slots_by_item for frontend slotCache population
    slots_by_item: dict[str, list] = {iid: [] for iid in all_item_ids}
    for s in all_slots:
        slots_by_item[s.parent_item_id].append({
            "id": s.id,
            "parent_item_id": s.parent_item_id,
            "slot_name": s.slot_name,
            "slot_game_name": s.slot_game_name,
            "has_allowed_items": slot_counts.get(s.id, 0) > 0,
        })

    # Find which factory items are allowed in which slots (1 query)
    factory_allowed_by_slot: dict[str, set] = {}
    if all_slot_ids and factory_ids:
        for rec in db.query(SlotAllowedItem).filter(
            SlotAllowedItem.slot_id.in_(all_slot_ids),
            SlotAllowedItem.allowed_item_id.in_(factory_ids),
        ).all():
            factory_allowed_by_slot.setdefault(rec.slot_id, set()).add(rec.allowed_item_id)

    # Serialize a factory attachment item (same shape as /slots/{id}/allowed-items)
    def _fmt_item(item):
        return {
            "id": item.id,
            "name": _item_name(item, lang),
            "short_name": _item_short_name(item, lang),
            "weight": item.weight,
            "ergonomics_modifier": item.ergonomics_modifier,
            "recoil_modifier": item.recoil_modifier,
            "sighting_range": item.sighting_range,
            "icon_link": item.icon_link,
            "conflicting_item_ids": item.conflicting_item_ids,
            "conflicting_slot_ids": item.conflicting_slot_ids,
            "magazine_capacity": item.magazine_capacity,
            "caliber": item.caliber,
            "is_weapon": item.is_weapon,
            "trader_price": item.trader_price,
            "trader_price_rub": item.trader_price_rub,
            "trader_currency": item.trader_currency,
            "trader_vendor": item.trader_vendor,
            "trader_min_level": item.trader_min_level,
        }

    # Determine which factory items can fit inside another factory item's slots.
    # These are "child candidates" and must be processed after their potential parents
    # so the parent can claim its gun-level slot first.
    factory_item_ids = set(factory_ids)
    factory_child_ids: set[str] = set()
    for s in all_slots:
        if s.parent_item_id in factory_item_ids:
            factory_child_ids.update(
                fid for fid in factory_allowed_by_slot.get(s.id, set())
                if fid != s.parent_item_id
            )

    def _sort_ids(ids: list) -> list:
        """Parents (not a child of any factory item) first, child-candidates last."""
        return (
            [fid for fid in ids if fid not in factory_child_ids] +
            [fid for fid in ids if fid in factory_child_ids]
        )

    # Resolve factory attachment tree.
    # Each slot is only filled once (first match wins) to prevent a later item
    # from overwriting an earlier one that already claimed that slot.
    def _resolve_children(node_item_id: str, remaining_ids: list) -> dict:
        children = {}
        node_slots = slots_by_item.get(node_item_id, [])
        for attachment_id in _sort_ids(remaining_ids):
            if attachment_id not in factory_items_map:
                continue
            for slot in node_slots:
                if (slot["id"] not in children and
                        attachment_id in factory_allowed_by_slot.get(slot["id"], set())):
                    other_ids = [fid for fid in remaining_ids if fid != attachment_id]
                    children[slot["id"]] = {
                        "item": _fmt_item(factory_items_map[attachment_id]),
                        "children": _resolve_children(attachment_id, other_ids),
                    }
                    break
        return children

    factory_tree = _resolve_children(gun_id, factory_ids)

    # Load ammo for caliber (1 query)
    ammo_list = []
    if gun.caliber:
        ammo_list = [
            {
                "id": a.id,
                "name": _item_name(a, lang),
                "weight": a.weight,
                "icon_link": a.icon_link,
                "trader_price": a.trader_price,
                "trader_price_rub": a.trader_price_rub,
                "trader_currency": a.trader_currency,
                "trader_vendor": a.trader_vendor,
                "trader_min_level": a.trader_min_level,
            }
            for a in db.query(Item).filter(
                Item.is_ammo == True,
                Item.caliber == gun.caliber,
            ).order_by(Item.weight.asc()).all()
        ]

    # Compute build stats with factory attachments
    stats = _compute_stats(gun, factory_ids, factory_items_map, strength_level, equip_ergo_modifier)

    # Apply ammo weight if a valid ammo ID was provided
    ammo_weight_added = False

    if assume_full_mag and selected_ammo_id:
        ammo = db.query(Item).filter(Item.id == selected_ammo_id).first()
        if ammo and ammo.is_ammo:
            for att in factory_items_map.values():
                if att.magazine_capacity:
                    stats["total_weight"] = round(
                        stats["total_weight"] + (ammo.weight or 0) * att.magazine_capacity, 3
                    )
            ammo_weight_added = True

    # UBGL grenade ammo weight - one round per UBGL installed.
    # UBGLs are detected by caliber-match: any non-ammo factory item whose
    # caliber matches the selected grenade ammo's caliber is the UBGL.
    if assume_full_mag and selected_ubgl_ammo_id:
        grenade = db.query(Item).filter(Item.id == selected_ubgl_ammo_id).first()
        if grenade and grenade.is_ammo and grenade.caliber:
            ubgl_count = sum(
                1 for att in factory_items_map.values()
                if att.caliber == grenade.caliber and not att.is_ammo
            )
            if ubgl_count:
                stats["total_weight"] = round(
                    stats["total_weight"] + (grenade.weight or 0) * ubgl_count, 3
                )
                ammo_weight_added = True

    if ammo_weight_added:
        b = equip_ergo_modifier
        E = stats["total_ergo"] * (1 + b)
        KG = 0.0007556 * (E ** 2) + 0.02736 * E + 2.9159
        evo_weight = stats["total_weight"] - KG
        stats["evo_ergo_delta"] = round(-15 * evo_weight, 2)
        stats["overswing"] = evo_weight > 0
        stats["arm_stamina"] = round(
            (
                (85.5 / (stats["total_weight"] + 0.65))
                + 9.15
                + 0.06477 * stats["total_ergo"] * (1 + b / 2)
            ) / 1.04 * (1 + strength_level * 0.004),
            1
        )

    # Fetch UBGL grenade ammo list - find any factory UBGL by caliber (UBGLs are non-ammo items with a caliber)
    ubgl_ammo_list = []
    ubgl_caliber = next(
        (att.caliber for att in factory_items_map.values() if att.caliber and not att.is_ammo and not att.magazine_capacity),
        None
    )
    if ubgl_caliber:
        ubgl_ammo_list = [
            {
                "id": a.id,
                "name": _item_name(a, lang),
                "weight": a.weight,
                "icon_link": a.icon_link,
                "trader_price": a.trader_price,
                "trader_price_rub": a.trader_price_rub,
                "trader_currency": a.trader_currency,
                "trader_vendor": a.trader_vendor,
                "trader_min_level": a.trader_min_level,
            }
            for a in db.query(Item).filter(
                Item.is_ammo == True,
                Item.caliber == ubgl_caliber,
            ).order_by(Item.weight.asc()).all()
        ]

    return {
        "slots_by_item": slots_by_item,
        "factory_tree": factory_tree,
        "factory_attachment_ids": factory_ids,
        "ammo": ammo_list,
        "ubgl_ammo": ubgl_ammo_list,
        "stats": stats,
    }


# ---------------------------------------------------
# Attachment Ratings
# ---------------------------------------------------

@app.get("/ratings/attachments/bulk")
def get_bulk_ratings(ids: str, x_client_id: str = Header(None), db: Session = Depends(get_ratings_db)):
    if len(ids) > 4000:
        raise HTTPException(status_code=413, detail="ids parameter too long")
    raw_ids = [i.strip() for i in ids.split(",") if i.strip()]
    if not raw_ids:
        raise HTTPException(status_code=400, detail="ids parameter is required")
    if len(raw_ids) > 200:
        raise HTTPException(status_code=400, detail="Too many ids (max 200)")
    for item_id in raw_ids:
        _validate_item_id(item_id)
    unique_ids = list(dict.fromkeys(raw_ids))  # deduplicate, preserve order

    # use client token hash for vote lookup; fall back to no user_vote if absent
    client_hash = _get_optional_client_id_hash(x_client_id)

    rating_rows = db.query(AttachmentRating).filter(
        AttachmentRating.item_id.in_(unique_ids)
    ).all()
    ratings_map = {r.item_id: r for r in rating_rows}

    votes_map = {}
    if client_hash:
        vote_rows = db.query(AttachmentVote).filter(
            AttachmentVote.item_id.in_(unique_ids),
            AttachmentVote.ip_hash == client_hash,
        ).all()
        votes_map = {v.item_id: v.vote for v in vote_rows}

    result = {}
    for item_id in unique_ids:
        r = ratings_map.get(item_id)
        result[item_id] = {
            "likes":     r.like_count    if r else 0,
            "dislikes":  r.dislike_count if r else 0,
            "user_vote": votes_map.get(item_id),
        }

    return {"ratings": result}


@app.post("/ratings/attachments/{item_id}/vote")
def post_vote(item_id: str, vote: str = Body(..., embed=True), x_client_id: str = Header(None), db: Session = Depends(get_ratings_db)):
    _validate_item_id(item_id)
    if vote not in ("like", "dislike"):
        raise HTTPException(status_code=422, detail='vote must be "like" or "dislike"')

    ip_hash = _get_client_id_hash(x_client_id)

    existing = db.query(AttachmentVote).filter(
        AttachmentVote.item_id == item_id,
        AttachmentVote.ip_hash == ip_hash,
    ).first()

    if existing is None:
        db.add(AttachmentVote(item_id=item_id, ip_hash=ip_hash, vote=vote))
        _upsert_rating(db, item_id, like_delta=1 if vote == "like" else 0, dislike_delta=1 if vote == "dislike" else 0)
        result_vote = vote
    elif existing.vote == vote:
        db.delete(existing)
        _upsert_rating(db, item_id, like_delta=-1 if vote == "like" else 0, dislike_delta=-1 if vote == "dislike" else 0)
        result_vote = None
    else:
        existing.vote = vote
        existing.created_at = datetime.now(timezone.utc)
        like_d    = (1 if vote == "like" else -1)
        dislike_d = (1 if vote == "dislike" else -1)
        _upsert_rating(db, item_id, like_delta=like_d, dislike_delta=dislike_d)
        result_vote = vote

    db.commit()

    rating = db.query(AttachmentRating).filter(AttachmentRating.item_id == item_id).first()
    return {
        "likes":     rating.like_count    if rating else 0,
        "dislikes":  rating.dislike_count if rating else 0,
        "user_vote": result_vote,
    }


@app.delete("/ratings/attachments/{item_id}/vote")
def delete_vote(item_id: str, x_client_id: str = Header(None), db: Session = Depends(get_ratings_db)):
    _validate_item_id(item_id)
    ip_hash = _get_client_id_hash(x_client_id)

    existing = db.query(AttachmentVote).filter(
        AttachmentVote.item_id == item_id,
        AttachmentVote.ip_hash == ip_hash,
    ).first()

    if existing:
        old_vote = existing.vote
        db.delete(existing)
        _upsert_rating(db, item_id, like_delta=-1 if old_vote == "like" else 0, dislike_delta=-1 if old_vote == "dislike" else 0)
        db.commit()

    rating = db.query(AttachmentRating).filter(AttachmentRating.item_id == item_id).first()
    return {
        "likes":     rating.like_count    if rating else 0,
        "dislikes":  rating.dislike_count if rating else 0,
        "user_vote": None,
    }


@app.delete("/admin/ratings/attachments/{item_id}")
def admin_clear_rating(item_id: str, request: Request, x_admin_key: str = Header(None), db: Session = Depends(get_ratings_db)):
    _require_admin(request, x_admin_key)
    _validate_item_id(item_id)

    db.query(AttachmentVote).filter(AttachmentVote.item_id == item_id).delete()
    db.query(AttachmentRating).filter(AttachmentRating.item_id == item_id).delete()
    db.commit()

    return {"cleared": True, "item_id": item_id}


def _upsert_rating(db: Session, item_id: str, like_delta: int, dislike_delta: int) -> None:
    """Insert or update the rating summary row atomically."""
    existing = db.query(AttachmentRating).filter(AttachmentRating.item_id == item_id).first()
    if existing is None:
        db.add(AttachmentRating(
            item_id=item_id,
            like_count=max(0, like_delta),
            dislike_count=max(0, dislike_delta),
            last_updated=datetime.now(timezone.utc),
        ))
    else:
        existing.like_count    = max(0, existing.like_count    + like_delta)
        existing.dislike_count = max(0, existing.dislike_count + dislike_delta)
        existing.last_updated  = datetime.now(timezone.utc)


# ---------------------------------------------------
# Build Ratings
# ---------------------------------------------------

def _validate_build_id_positive(build_id: int) -> None:
    if build_id <= 0:
        raise HTTPException(status_code=400, detail="Invalid build_id")


def _upsert_build_rating(db: Session, build_id: int, like_delta: int, dislike_delta: int) -> None:
    existing = db.query(BuildRating).filter(BuildRating.build_id == build_id).first()
    if existing is None:
        db.add(BuildRating(
            build_id=build_id,
            like_count=max(0, like_delta),
            dislike_count=max(0, dislike_delta),
            last_updated=datetime.now(timezone.utc),
        ))
    else:
        existing.like_count    = max(0, existing.like_count    + like_delta)
        existing.dislike_count = max(0, existing.dislike_count + dislike_delta)
        existing.last_updated  = datetime.now(timezone.utc)


@app.get("/ratings/builds/bulk")
def get_bulk_build_ratings(ids: str, x_client_id: str = Header(None), db: Session = Depends(get_builds_db)):
    if len(ids) > 4000:
        raise HTTPException(status_code=413, detail="ids parameter too long")
    raw_ids = [i.strip() for i in ids.split(",") if i.strip()]
    if not raw_ids:
        raise HTTPException(status_code=400, detail="ids parameter is required")
    if len(raw_ids) > 200:
        raise HTTPException(status_code=400, detail="Too many ids (max 200)")

    try:
        int_ids = [int(i) for i in raw_ids]
    except ValueError:
        raise HTTPException(status_code=400, detail="ids must be integers")
    unique_ids = list(dict.fromkeys(int_ids))

    client_hash = _get_optional_client_id_hash(x_client_id)

    rating_rows = db.query(BuildRating).filter(BuildRating.build_id.in_(unique_ids)).all()
    ratings_map = {r.build_id: r for r in rating_rows}

    votes_map = {}
    if client_hash:
        vote_rows = db.query(BuildVote).filter(
            BuildVote.build_id.in_(unique_ids),
            BuildVote.ip_hash == client_hash,
        ).all()
        votes_map = {v.build_id: v.vote for v in vote_rows}

    result = {}
    for build_id in unique_ids:
        r = ratings_map.get(build_id)
        result[str(build_id)] = {
            "likes":     r.like_count    if r else 0,
            "dislikes":  r.dislike_count if r else 0,
            "user_vote": votes_map.get(build_id),
        }

    return {"ratings": result}


@app.post("/ratings/builds/{build_id}/vote")
def post_build_vote(build_id: int, vote: str = Body(..., embed=True), x_client_id: str = Header(None), db: Session = Depends(get_builds_db)):
    _validate_build_id_positive(build_id)
    if vote != "like":
        raise HTTPException(status_code=422, detail='vote must be "like"')

    ip_hash = _get_client_id_hash(x_client_id)

    existing = db.query(BuildVote).filter(
        BuildVote.build_id == build_id,
        BuildVote.ip_hash  == ip_hash,
    ).first()

    if existing is None:
        db.add(BuildVote(build_id=build_id, ip_hash=ip_hash, vote=vote))
        _upsert_build_rating(db, build_id, like_delta=1 if vote == "like" else 0, dislike_delta=1 if vote == "dislike" else 0)
        result_vote = vote
    elif existing.vote == vote:
        db.delete(existing)
        _upsert_build_rating(db, build_id, like_delta=-1 if vote == "like" else 0, dislike_delta=-1 if vote == "dislike" else 0)
        result_vote = None
    else:
        existing.vote = vote
        existing.created_at = datetime.now(timezone.utc)
        like_d    = (1 if vote == "like" else -1)
        dislike_d = (1 if vote == "dislike" else -1)
        _upsert_build_rating(db, build_id, like_delta=like_d, dislike_delta=dislike_d)
        result_vote = vote

    db.commit()

    rating = db.query(BuildRating).filter(BuildRating.build_id == build_id).first()
    return {
        "likes":     rating.like_count    if rating else 0,
        "dislikes":  rating.dislike_count if rating else 0,
        "user_vote": result_vote,
    }


@app.delete("/ratings/builds/{build_id}/vote")
def delete_build_vote(build_id: int, x_client_id: str = Header(None), db: Session = Depends(get_builds_db)):
    _validate_build_id_positive(build_id)
    ip_hash = _get_client_id_hash(x_client_id)

    existing = db.query(BuildVote).filter(
        BuildVote.build_id == build_id,
        BuildVote.ip_hash  == ip_hash,
    ).first()

    if existing:
        old_vote = existing.vote
        db.delete(existing)
        _upsert_build_rating(db, build_id, like_delta=-1 if old_vote == "like" else 0, dislike_delta=-1 if old_vote == "dislike" else 0)
        db.commit()

    rating = db.query(BuildRating).filter(BuildRating.build_id == build_id).first()
    return {
        "likes":     rating.like_count    if rating else 0,
        "dislikes":  rating.dislike_count if rating else 0,
        "user_vote": None,
    }


# ---------------------------------------------------
# Build Image Proxy
# Forwards weapon build data to image-gen.tarkov-changes.com
# and returns the generated image URL.
# Simple in-process cache keyed by a hash of the items list.
# ---------------------------------------------------

_IMAGE_GEN_CACHE: dict[str, str] = {}   # hash -> image_url
_IMAGE_GEN_MAX   = 500                  # evict when cache exceeds this size

# Patchright runs in a dedicated thread with its own ProactorEventLoop so that
# asyncio.create_subprocess_exec (used internally to launch the browser) works
# on Windows regardless of which event loop uvicorn chooses.
_pw_loop:      asyncio.AbstractEventLoop | None = None
_pw_loop_ready = threading.Event()
_pw_instance   = None
_pw_context    = None
_pw_page       = None   # persistent page - API calls run as real browser fetch()

# Persistent profile dir - Cloudflare session data accumulates across restarts
_PW_PROFILE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pw_profile")

def _run_pw_event_loop():
    global _pw_loop
    if sys.platform == "win32":
        _pw_loop = asyncio.ProactorEventLoop()
    else:
        _pw_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_pw_loop)
    _pw_loop_ready.set()
    _pw_loop.run_forever()

threading.Thread(target=_run_pw_event_loop, daemon=True, name="patchright-loop").start()

# Main-world fetch override script.
# Injected into the real page (main world) via the HTML route handler so it runs
# BEFORE any site JavaScript.  Because page.evaluate() runs in an isolated world,
# we bridge the two worlds with:
#   isolated -> main  :  CustomEvent on document  (dispatchEvent crosses worlds)
#   main -> isolated  :  document.body.setAttribute (DOM attrs are shared)
_FETCH_OVERRIDE_SCRIPT = r"""
(function() {
    if (typeof window === 'undefined') return;
    if (window.__EFT_INSTALLED__) return;
    window.__EFT_INSTALLED__ = true;
    window.__EFT_BUILD_OVERRIDE__ = null;

    // Receive the override payload from Playwright's isolated world.
    // CustomEvent dispatched on document is visible in ALL worlds.
    document.addEventListener('__eft_set_override__', function(e) {
        window.__EFT_BUILD_OVERRIDE__ = e.detail;
    });

    var _origFetch = window.fetch;
    if (typeof _origFetch !== 'function') return;

    window.fetch = function(url, init) {
        var urlStr = (url instanceof Request) ? url.url : String(url);
        if (urlStr.indexOf('/api/generate-build') !== -1 &&
                window.__EFT_BUILD_OVERRIDE__) {
            var override = window.__EFT_BUILD_OVERRIDE__;
            window.__EFT_BUILD_OVERRIDE__ = null;
            try {
                // Parse the site's natural body to get the gun item in its
                // native SPT format (real instance UUID, correct slotId, etc.)
                var naturalBodyStr = (!(url instanceof Request) && init && init.body)
                    ? init.body : '{}';
                var naturalBody = JSON.parse(naturalBodyStr);

                // Support both {data: {items}} and {items} top-level shapes
                var naturalItems, bodyShape;
                if (naturalBody.data && Array.isArray(naturalBody.data.items)) {
                    naturalItems = naturalBody.data.items;
                    bodyShape = 'data';
                } else if (Array.isArray(naturalBody.items)) {
                    naturalItems = naturalBody.items;
                    bodyShape = 'root';
                } else {
                    naturalItems = [];
                    bodyShape = 'unknown';
                }
                var naturalGun = naturalItems[0];

                var ourItems = (override.data && override.data.items) || [];
                var ourGunId = ourItems.length > 0 ? ourItems[0]._id : null;

                var mergedItems;
                if (naturalGun && ourGunId && ourItems.length > 1) {
                    // Keep the site's gun item (correct format) and append our
                    // attachments, fixing any parentId that points to our gun
                    // id so it points to the site's real gun instance id instead.
                    mergedItems = [naturalGun];
                    for (var i = 1; i < ourItems.length; i++) {
                        var att = Object.assign({}, ourItems[i]);
                        if (att.parentId === ourGunId) {
                            att.parentId = naturalGun._id;
                        }
                        mergedItems.push(att);
                    }
                } else {
                    // No attachments or couldn't merge - use our payload as-is
                    mergedItems = ourItems;
                }

                // Rebuild the body preserving the site's envelope structure
                var newBodyObj;
                if (bodyShape === 'data') {
                    newBodyObj = Object.assign({}, naturalBody, {
                        data: Object.assign({}, naturalBody.data, {
                            id: naturalGun ? naturalGun._id : naturalBody.data.id,
                            items: mergedItems
                        })
                    });
                } else if (bodyShape === 'root') {
                    newBodyObj = Object.assign({}, naturalBody, {
                        id: naturalGun ? naturalGun._id : naturalBody.id,
                        items: mergedItems
                    });
                } else {
                    // Unknown structure - use our data wrapper as fallback
                    newBodyObj = {
                        data: {
                            id: override.data && override.data.id,
                            items: mergedItems
                        }
                    };
                }
                var newBody = JSON.stringify(newBodyObj);

                if (url instanceof Request) {
                    url = new Request(url, { body: newBody });
                } else {
                    init = Object.assign({}, init || {}, { body: newBody });
                }
                try { document.body.setAttribute('data-eft-fired', '1'); } catch(_e) {}
            } catch(e) {
                // Merge failed - fall through with natural request unchanged
                try { document.body.setAttribute('data-eft-fired', 'merge-failed:' + e.message); } catch(_e) {}
            }
        }
        return _origFetch.apply(this, [url, init]);
    };
})();
"""

# Minimal SW - only needed to keep the registration happy; does not intercept.
_SW_CODE = r"""
self.addEventListener('install', function(e) { e.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });
"""

async def _init_pw():
    global _pw_instance, _pw_context, _pw_page
    # Remove stale Chrome singleton lock files left behind by a previous crash.
    # Chrome aborts (SIGTRAP) during startup if it finds these and can't
    # determine whether the owning process is still alive (common in containers).
    for _lock in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        _lock_path = os.path.join(_PW_PROFILE_DIR, _lock)
        if os.path.exists(_lock_path):
            try:
                os.remove(_lock_path)
                _logger.warning("Removed stale Chrome lock: %s", _lock_path)
            except OSError as _e:
                _logger.warning("Could not remove Chrome lock %s: %s", _lock_path, _e)
    from patchright.async_api import async_playwright
    _pw_instance = await async_playwright().start()
    _pw_context = await _pw_instance.chromium.launch_persistent_context(
        user_data_dir=_PW_PROFILE_DIR,
        channel="chrome",
        headless=False,
        args=["--disable-crash-reporter"],
    )
    _pw_page = await _pw_context.new_page()

    # Serve a minimal no-op SW so the registration succeeds (keeps a stable
    # browsing session; the actual interception is done in the main-world script).
    async def _serve_sw(route):
        await route.fulfill(
            status=200,
            headers={"content-type": "application/javascript; charset=utf-8",
                     "service-worker-allowed": "/"},
            body=_SW_CODE.encode(),
        )
    await _pw_context.route("**/eft-sw.js", _serve_sw)

    # Inject _FETCH_OVERRIDE_SCRIPT into the page HTML as the very first <head>
    # child.  This runs in the MAIN JavaScript world before any site code, so
    # our window.fetch wrapper is installed before the site can capture a
    # reference to native fetch.  CSP headers are stripped so the inline script
    # is not blocked.
    _override_tag = ("<script>" + _FETCH_OVERRIDE_SCRIPT + "</script>").encode()

    async def _patch_html(route):
        try:
            resp = await route.fetch(timeout=60000)
            body = await resp.body()
            patched = body.replace(b"<head>", b"<head>" + _override_tag, 1)
            injected = patched != body
            _STRIP = ("content-length", "content-encoding",
                      "content-security-policy", "x-content-security-policy",
                      "x-webkit-csp")
            hdrs = {k: v for k, v in resp.headers.items() if k.lower() not in _STRIP}
            await route.fulfill(status=resp.status, headers=hdrs, body=patched)
            _logger.warning("HTML patched: injected=%s script_bytes=%d", injected, len(_override_tag))
        except Exception as exc:
            _logger.warning("HTML patch failed: %s", exc)
            await route.continue_()

    await _pw_page.route("https://image-gen.tarkov-changes.com/build", _patch_html)

    response = await _pw_page.goto(
        "https://image-gen.tarkov-changes.com/build",
        wait_until="networkidle",
        timeout=60000,
    )

    # Simulate basic user interaction to help pass bot scoring
    await _pw_page.mouse.move(400, 300)
    await asyncio.sleep(2)
    await _pw_page.mouse.move(700, 400)
    await asyncio.sleep(1)

    # Register a minimal SW (needed for the SW route to be served; harmless).
    sw_result = await _pw_page.evaluate("""async () => {
        try {
            const oldRegs = await navigator.serviceWorker.getRegistrations();
            for (const r of oldRegs) await r.unregister();
            const reg = await navigator.serviceWorker.register('/eft-sw.js', {scope: '/'});
            await new Promise((resolve) => {
                if (reg.active && reg.active.state === 'activated') { resolve(); return; }
                const sw = reg.installing || reg.waiting || reg.active;
                if (!sw) { setTimeout(resolve, 3000); return; }
                sw.addEventListener('statechange', function onchange() {
                    if (sw.state === 'activated' || sw.state === 'redundant') {
                        sw.removeEventListener('statechange', onchange);
                        resolve();
                    }
                });
                setTimeout(resolve, 5000);
            });
            return {ok: true, scope: reg.scope, state: reg.active ? reg.active.state : 'no-active'};
        } catch(e) {
            return {ok: false, error: e.message};
        }
    }""")
    _logger.warning("SW registration: %s", sw_result)

    title = await _pw_page.title()
    cookies = await _pw_context.cookies()
    _logger.warning(
        "Patchright init - status: %s, title: %s, cookies: %s",
        response.status if response else "none",
        title,
        [c["name"] for c in cookies],
    )

_pw_req_lock: asyncio.Lock | None = None
_pw_in_flight: int = 0  # number of requests currently waiting or generating

async def _reset_pw_page():
    """Called from the pw loop after a build-image failure.  Tears down the
    entire browser session so the next _do_pw_request gets a clean slate from
    _init_pw(), rather than inheriting a closed/crashed browser context."""
    global _pw_page, _pw_context, _pw_instance
    _pw_page = None
    try:
        if _pw_context is not None:
            await _pw_context.close()
    except Exception as _e:
        _logger.warning("patchright: error closing context: %s", _e)
    finally:
        _pw_context = None
    try:
        if _pw_instance is not None:
            await _pw_instance.stop()
    except Exception as _e:
        _logger.warning("patchright: error stopping playwright: %s", _e)
    finally:
        _pw_instance = None
    _logger.warning("patchright: full browser reset after failure")


async def _do_pw_request(id: str, items: list, weapon_name: str) -> dict:
    global _pw_page, _pw_req_lock, _pw_in_flight
    if _pw_page is None:
        await _init_pw()
        # give the page time to fully settle after a cold-start before the
        # first generation request goes out - without this the image-gen API
        # returns 502 on the very first attempt
        await asyncio.sleep(5)
    if _pw_req_lock is None:
        _pw_req_lock = asyncio.Lock()

    _pw_in_flight += 1
    try:
        async with _pw_req_lock:
            api_resp_body: list = []  # holds (status, body) tuples
            api_done = asyncio.Event()

            async def _on_response(response):
                if "/api/generate-build" in response.url and not api_done.is_set():
                    try:
                        body = await response.text()
                        _logger.warning("generate-build status=%s", response.status)
                        api_resp_body.append((response.status, body))
                    except Exception as e:
                        _logger.warning("error reading response: %s", e)
                    api_done.set()

            _pw_page.on("response", _on_response)
            try:
                # Clear stale fired-flag from any previous request.
                # This attribute is written by the main-world wrapper and read here
                # (isolated world) - DOM attributes are shared across JS worlds.
                await _pw_page.evaluate(
                    "() => { try { document.body.removeAttribute('data-eft-fired'); } catch(_) {} }"
                )

                # Send the override payload to the main world via a CustomEvent on
                # document.  CustomEvents dispatched on DOM nodes cross the
                # isolated->main world boundary in Chrome.  The main-world listener
                # (installed by our HTML-injected script) stores the payload in
                # window.__EFT_BUILD_OVERRIDE__ so the fetch wrapper can use it.
                payload = {"data": {"id": id, "items": items}}
                await _pw_page.evaluate("""(payload) => {
                    document.dispatchEvent(
                        new CustomEvent('__eft_set_override__', {detail: payload})
                    );
                }""", payload)

                # Click the weapon.  The site's own JavaScript fires the fetch call.
                # Because window.fetch in the main world is OUR wrapper (installed
                # before any site code ran), the wrapper intercepts the call,
                # replaces the body with our payload, then calls native fetch.
                # Cloudflare sees a normal Chrome request with no CDP fingerprint.
                search = _pw_page.get_by_placeholder("Search for an item...")
                await search.click(timeout=30000)
                await search.fill("")
                await search.type(weapon_name, delay=40)
                await asyncio.sleep(0.5)
                await _pw_page.get_by_text(weapon_name).first.click(timeout=5000)

                try:
                    await asyncio.wait_for(api_done.wait(), timeout=30)
                except asyncio.TimeoutError:
                    raise RuntimeError("Timed out waiting for generate-build response")

                # Read diagnostic attributes back from shared DOM
                fired = await _pw_page.evaluate(
                    "() => document.body.getAttribute('data-eft-fired')"
                )
                _logger.warning("Override fired: %s", fired == "1")

            finally:
                _pw_page.remove_listener("response", _on_response)

            if not api_resp_body:
                raise RuntimeError("No generate-build response captured")

            status, body = api_resp_body[0]
            if status >= 400 or not body.strip():
                raise RuntimeError(f"generate-build returned HTTP {status}: {body[:200]!r}")

            data = json.loads(body)
            _logger.warning("image-gen response: %s", str(data)[:200])
            return data
    finally:
        _pw_in_flight -= 1

@app.get("/build-image/busy")
async def build_image_busy():
    return {"busy": _pw_in_flight > 0}

@app.post("/build-image")
async def proxy_build_image(
    id:    str        = Body(...),
    items: List[dict] = Body(...),
    db:    Session    = Depends(get_db),
):
    # Stable cache key: hash of sorted item tpl+slot pairs
    cache_key_src = json.dumps(sorted((i.get("_tpl","") + i.get("slotId","")) for i in items))
    cache_key = hashlib.sha256(cache_key_src.encode()).hexdigest()[:16]

    if cache_key in _IMAGE_GEN_CACHE:
        return {"image_url": _IMAGE_GEN_CACHE[cache_key]}

    weapon = db.get(Item, id)
    if not weapon:
        raise HTTPException(status_code=404, detail=f"Unknown weapon id: {id}")
    weapon_name = weapon.name

    _pw_loop_ready.wait(timeout=10)

    future = asyncio.run_coroutine_threadsafe(
        _do_pw_request(id, items, weapon_name), _pw_loop
    )
    try:
        uvloop = asyncio.get_event_loop()
        data = await uvloop.run_in_executor(None, lambda: future.result(timeout=120))
    except Exception as exc:
        # Cancel the coroutine in the pw loop so it releases _pw_req_lock and
        # decrements _pw_in_flight - without this the lock is held forever and
        # all subsequent /build-image requests queue up as zombies.
        future.cancel()
        # Reset _pw_page so the next request gets a fresh page rather than
        # trying to interact with a Chromium that may be in a broken UI state.
        asyncio.run_coroutine_threadsafe(_reset_pw_page(), _pw_loop)
        _logger.error("build-image failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=502, detail=f"Image generator request failed: {exc}")

    image_url = data.get("imageUrl")
    if not image_url:
        raise HTTPException(status_code=502, detail=f"No imageUrl in response: {data}")
    if image_url.startswith("/"):
        image_url = "https://image-gen.tarkov-changes.com" + image_url

    # Evict if over limit (simple FIFO eviction)
    if len(_IMAGE_GEN_CACHE) >= _IMAGE_GEN_MAX:
        oldest = next(iter(_IMAGE_GEN_CACHE))
        del _IMAGE_GEN_CACHE[oldest]
    _IMAGE_GEN_CACHE[cache_key] = image_url

    return {"image_url": image_url}


# ---------------------------------------------------
# Background build-image migration worker
# Generates card images for all community builds and
# stores them permanently in the Gitee asset repo so
# cards never depend on the third-party image-gen URLs.
# ---------------------------------------------------

def _bp_hex24(s: str) -> str:
    """Port of the frontend _bpHex24 hash.
    Produces a 24-char hex instance ID - must match the JS implementation exactly."""
    MASK = 0xFFFFFFFF
    h1, h2, h3 = 0x6b4a1c7f, 0x3e9d5a2b, 0xd1e4c7a9
    for ch in s:
        c = ord(ch)
        h1 = ((h1 ^ c) * 0x9e3779b9) & MASK
        h2 = ((h2 ^ c) * 0x85ebca6b) & MASK
        h3 = ((h3 ^ c) * 0xc2b2ae35) & MASK
        h1 ^= (h2 >> 13) ^ (h3 >> 7)
        h2 ^= (h1 >> 17) ^ (h3 >> 5)
        h3 ^= (h1 >> 11) ^ (h2 >> 19)
    h1 = (h1 ^ h2 ^ h3) & MASK
    h2 = (h2 ^ ((h1 * 0x27d4eb2d) & MASK)) & MASK
    h3 = (h3 ^ ((h2 * 0x165667b1) & MASK)) & MASK
    return "".join(f"{v:08x}" for v in (h1, h2, h3))


def _build_spt_items(gun_id: str, pairs: list) -> list:
    """Convert pairs [[slot_id, item_id], ...] to the SPT-format items array
    the image-gen API expects, matching the frontend _bpBuildSptItems() exactly."""
    gun_instance_id = _bp_hex24(gun_id + ":root")
    items = [{
        "_id":      gun_instance_id,
        "_tpl":     gun_id,
        "slotId":   "hideout",
        "parentId": "hideout",
    }]

    if not pairs:
        return items

    slot_ids = [p[0] for p in pairs]
    with SessionLocal() as db:
        slots = db.query(Slot).filter(Slot.id.in_(slot_ids)).all()
    slot_map = {s.id: s for s in slots}

    # tracks item template id -> instance id so children can find their parent
    instance_map: dict[str, str] = {gun_id: gun_instance_id}

    for slot_id, item_id in pairs:
        slot = slot_map.get(slot_id)
        if not slot:
            continue
        game_slot_name  = slot.slot_game_name or slot.slot_name
        parent_instance = instance_map.get(slot.parent_item_id)
        if not parent_instance:
            continue
        instance_id = _bp_hex24(parent_instance + ":" + game_slot_name)
        items.append({
            "_id":      instance_id,
            "_tpl":     item_id,
            "slotId":   game_slot_name,
            "parentId": parent_instance,
        })
        instance_map[item_id] = instance_id

    return items


_GITEE_API        = "https://gitee.com/api/v5"
_GITEE_OWNER      = "morph1ne"
_GITEE_REPO       = "eftforge-assets"
_GITEE_FOLDER     = "streaming-assets/build-images"
_GITEE_BRANCH     = "master"
_GITEE_RAW_PREFIX = (
    f"https://gitee.com/{_GITEE_OWNER}/{_GITEE_REPO}"
    f"/raw/{_GITEE_BRANCH}/{_GITEE_FOLDER}/"
)


def _gitee_upload_sync(filename: str, image_bytes: bytes, token: str) -> str:
    """Upload or overwrite a build image in the Gitee asset repo.
    Returns the permanent raw URL for the file."""
    import requests as _req

    path    = f"{_GITEE_FOLDER}/{filename}"
    api_url = f"{_GITEE_API}/repos/{_GITEE_OWNER}/{_GITEE_REPO}/contents/{path}"
    content = base64.b64encode(image_bytes).decode()

    # fetch existing file SHA so we can update rather than error on duplicate
    sha = None
    r = _req.get(api_url, params={"access_token": token}, timeout=20)
    if r.status_code == 200:
        data = r.json()
        sha = data.get("sha") if isinstance(data, dict) else None

    payload = {
        "access_token": token,
        "message": f"ci: auto-generate build image {filename}",
        "content": content,
        "branch": _GITEE_BRANCH,
    }
    if sha:
        payload["sha"] = sha
        r = _req.put(api_url, json=payload, timeout=30)
    else:
        r = _req.post(api_url, json=payload, timeout=30)

    r.raise_for_status()
    return f"{_GITEE_RAW_PREFIX}{filename}"


def _generate_and_save_build_image(build_id: int, gun_id: str, gun_name: str, pairs: list) -> bool:
    """Synchronous helper: generates a card image for a single community build,
    uploads it to Gitee, and saves the URL to the DB.
    Returns True on success, False on any failure.
    Safe to call from a thread (BackgroundTasks or run_in_executor)."""
    from config import GITEE_TOKEN, GITEE_DRY_RUN

    if not GITEE_TOKEN and not GITEE_DRY_RUN:
        return False

    import requests as _req

    # build the full SPT-format items array the image-gen API expects,
    # matching the frontend _bpBuildSptItems() exactly
    items = _build_spt_items(gun_id, pairs)

    # generate via patchright - blocks until the lock is acquired and generation completes
    future = asyncio.run_coroutine_threadsafe(
        _do_pw_request(gun_id, items, gun_name), _pw_loop
    )
    try:
        data = future.result(timeout=120)
    except Exception as exc:
        _logger.error("build-image gen failed for build %s: %s", build_id, exc)
        return False

    image_url = data.get("imageUrl")
    if not image_url:
        _logger.error("build-image gen: no imageUrl in response for build %s", build_id)
        return False
    if image_url.startswith("/"):
        image_url = "https://image-gen.tarkov-changes.com" + image_url

    try:
        r = _req.get(image_url, timeout=30)
        r.raise_for_status()
        image_bytes = r.content
        content_type = r.headers.get("content-type", "image/jpeg")
    except Exception as exc:
        _logger.error("build-image download failed for build %s: %s", build_id, exc)
        return False

    ext = "jpg"
    if "png" in content_type:
        ext = "png"
    elif "webp" in content_type:
        ext = "webp"

    filename = f"build_{build_id}.{ext}"

    if GITEE_DRY_RUN:
        dry_url = f"dryrun:{_GITEE_RAW_PREFIX}{filename}"
        _logger.warning(
            "build-image [DRY RUN]: build %s - %d bytes (%s) - would upload to %s",
            build_id, len(image_bytes), content_type, dry_url.removeprefix("dryrun:"),
        )
        with BuildsSessionLocal() as db:
            b = db.get(PublicBuild, build_id)
            if b:
                b.card_image_url = dry_url
                db.commit()
        return True

    try:
        raw_url = _gitee_upload_sync(filename, image_bytes, GITEE_TOKEN)
    except Exception as exc:
        _logger.error("build-image Gitee upload failed for build %s: %s", build_id, exc)
        return False

    with BuildsSessionLocal() as db:
        b = db.get(PublicBuild, build_id)
        if b:
            b.card_image_url = raw_url
            db.commit()

    _logger.warning("build-image saved for build %s -> %s", build_id, raw_url)
    return True


async def _bg_migrate_build_images():
    """Continuously generates and uploads card images for every community build
    that doesn't yet have one stored in our own asset repo.  Runs only when the
    image-gen lock is free so real user requests always take priority."""
    from config import GITEE_TOKEN, GITEE_DRY_RUN, DISABLE_BG_MIGRATE

    if DISABLE_BG_MIGRATE:
        _logger.warning("bg-migrate: disabled via DISABLE_BG_MIGRATE - skipping")
        return

    if not GITEE_TOKEN and not GITEE_DRY_RUN:
        _logger.warning("bg-migrate: GITEE_TOKEN not set - build image migration disabled")
        return

    if GITEE_DRY_RUN:
        _logger.warning("bg-migrate: dry-run mode enabled - no files will be uploaded to Gitee")

    # wait for patchright loop, then let the server fully settle before starting
    _pw_loop_ready.wait(timeout=30)
    await asyncio.sleep(15)

    _logger.warning("bg-migrate: build image migration worker started")
    loop     = asyncio.get_event_loop()
    build_id = None

    while True:
        try:
            # yield to real user requests
            if _pw_in_flight > 0:
                await asyncio.sleep(5)
                continue

            # find the next build that hasn't been auto-migrated yet;
            # featured builds are prioritised so they look good first;
            # rows marked with the error sentinel are skipped until manually cleared
            with BuildsSessionLocal() as db:
                build = (
                    db.query(PublicBuild)
                    .filter(
                        (PublicBuild.card_image_url == None)  # noqa: E711
                        | (
                            ~PublicBuild.card_image_url.like(_GITEE_RAW_PREFIX + "%")
                            & ~PublicBuild.card_image_url.like("error:%")
                            & ~PublicBuild.card_image_url.like("dryrun:%")
                        )
                    )
                    .order_by(PublicBuild.is_featured.desc(), PublicBuild.id.asc())
                    .first()
                )
                if build is None:
                    _logger.warning("bg-migrate: all builds have auto-generated images, worker exiting")
                    break

                build_id = build.id
                gun_id   = build.gun_id
                gun_name = build.gun_name
                pairs    = json.loads(build.pairs_json)

            captured_id, captured_gun_id, captured_gun_name, captured_pairs = (
                build_id, gun_id, gun_name, pairs
            )
            ok = False
            for attempt in range(1, 4):
                _logger.warning(
                    "bg-migrate: generating image for build %s (%s) - attempt %s/3",
                    build_id, gun_name, attempt,
                )
                ok = await loop.run_in_executor(
                    None,
                    lambda: _generate_and_save_build_image(
                        captured_id, captured_gun_id, captured_gun_name, captured_pairs
                    ),
                )
                if ok:
                    break
                if attempt < 3:
                    _logger.warning("bg-migrate: attempt %s failed for build %s, retrying in 10s", attempt, build_id)
                    await asyncio.sleep(10)

            if not ok:
                _logger.error("bg-migrate: all 3 attempts failed for build %s, marking as errored", build_id)
                with BuildsSessionLocal() as db:
                    b = db.get(PublicBuild, build_id)
                    if b and not (b.card_image_url or "").startswith(_GITEE_RAW_PREFIX):
                        b.card_image_url = "error:gen-failed"
                        db.commit()
                await asyncio.sleep(10)
                continue

            # brief pause after each success so real requests can jump in
            await asyncio.sleep(3)

        except Exception as exc:
            _logger.error(
                "bg-migrate: error on build %s: %s", build_id or "?", exc, exc_info=True
            )
            await asyncio.sleep(30)  # back off before retrying


@app.on_event("startup")
async def _on_startup():
    asyncio.create_task(_bg_migrate_build_images())


# ---------------------------------------------------
# Public Builds
# ---------------------------------------------------

@app.post("/builds/publish")
def publish_build(
    request:          Request,
    background_tasks: BackgroundTasks,
    x_client_id: str = Header(None),
    gun_id:     str        = Body(...),
    build_name: str        = Body(...),
    pairs:      List[list] = Body(...),
    stats:      dict | None = Body(default=None),
    ammo_id:    str | None  = Body(default=None),
    db:         Session    = Depends(get_builds_db),
    db_main:    Session    = Depends(get_db),
):
    client_hash = _get_client_id_hash(x_client_id)

    # rate limit: one publish per 60 seconds per client
    now_mono = time.monotonic()
    # evict stale entries (older than 2x cooldown) to prevent unbounded growth
    stale = [k for k, t in _publish_last.items() if now_mono - t > _PUBLISH_COOLDOWN * 2]
    for k in stale:
        del _publish_last[k]
    last = _publish_last.get(client_hash, 0.0)
    if now_mono - last < _PUBLISH_COOLDOWN:
        remaining = int(_PUBLISH_COOLDOWN - (now_mono - last))
        raise HTTPException(status_code=429, detail=f"Rate limit: wait {remaining}s before publishing again.")

    _check_client_ban(client_hash, db)

    # validate gun exists
    gun = db_main.query(Item).filter(Item.id == gun_id, Item.is_weapon == True).first()
    if not gun:
        raise HTTPException(status_code=422, detail="Unknown gun_id.")

    # sanitize build name
    name = _sanitize_build_name(build_name)[:60]
    if not name:
        raise HTTPException(status_code=422, detail="build_name cannot be empty.")

    # validate pairs format: each must be [str, str]
    if not isinstance(pairs, list):
        raise HTTPException(status_code=422, detail="pairs must be an array.")
    if len(pairs) > 200:
        raise HTTPException(status_code=422, detail="Too many pairs (max 200).")
    for p in pairs:
        if not (isinstance(p, list) and len(p) == 2
                and isinstance(p[0], str) and isinstance(p[1], str)):
            raise HTTPException(status_code=422, detail="Each pair must be [slot_id, item_id].")

    _validate_pairs(pairs, db_main)

    # reject if gun already has 500 community builds
    _COMMUNITY_BUILDS_LIMIT = 500
    existing_count = db.query(PublicBuild).filter(PublicBuild.gun_id == gun_id).count()
    if existing_count >= _COMMUNITY_BUILDS_LIMIT:
        raise HTTPException(status_code=409, detail="community_builds_limit_reached")

    # compute total price: gun + all attachments
    all_ids = [gun_id] + [p[1] for p in pairs]
    price_rows = db_main.query(Item.id, Item.trader_price_rub).filter(Item.id.in_(all_ids)).all()
    total_price = sum(r[1] or 0 for r in price_rows) or None

    build = PublicBuild(
        gun_id          = gun_id,
        gun_name        = gun.name,
        build_name      = name,
        pairs_json      = json.dumps(pairs),
        ip_hash         = client_hash,
        ip_snapshot     = _get_client_ip(request),
        author_id       = None,
        is_admin_build  = False,
        stats_json      = json.dumps(stats) if stats else None,
        total_price_rub = total_price,
        ammo_id         = ammo_id or None,
    )
    db.add(build)
    db.commit()
    db.refresh(build)

    _publish_last[client_hash] = now_mono

    # kick off image generation in the background - response returns immediately
    background_tasks.add_task(
        _generate_and_save_build_image,
        build.id, gun_id, gun.name, pairs,
    )

    return {"id": build.id, "published_at": build.published_at.isoformat()}


@app.get("/builds/public")
def get_public_builds(
    gun_id: str,
    x_client_id: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    if _community_builds_disabled:
        raise HTTPException(status_code=503, detail="community_builds_disabled")

    client_hash = _get_optional_client_id_hash(x_client_id)

    rows = (
        db.query(PublicBuild, PublicBuildAuthor)
        .outerjoin(PublicBuildAuthor, PublicBuild.author_id == PublicBuildAuthor.id)
        .filter(PublicBuild.gun_id == gun_id)
        .order_by(PublicBuild.is_featured.desc(), PublicBuild.published_at.desc())
        .limit(500)
        .all()
    )

    return [
        {
            "id":                     build.id,
            "gun_id":                 build.gun_id,
            "build_name":             build.build_name,
            "author_display_name":    author.display_name     if author else None,
            "author_display_name_zh": author.display_name_zh  if author else None,
            "author_avatar_url":      author.avatar_url        if author else None,
            "is_admin_build":         build.is_admin_build,
            "is_featured":            build.is_featured,
            "published_at":           build.published_at.isoformat(),
            "is_mine":                (client_hash is not None and build.ip_hash == client_hash),
            "pairs":                  _safe_json_loads(build.pairs_json),
            "stats":                  _safe_json_loads(build.stats_json),
            "total_price_rub": build.total_price_rub,
            "load_count":      build.load_count or 0,
            "card_image_url":  build.card_image_url,
            "ammo_id":         build.ammo_id,
        }
        for build, author in rows
    ]


@app.post("/builds/{build_id}/load")
def record_build_load(
    build_id: int,
    db: Session = Depends(get_builds_db),
):
    build = db.query(PublicBuild).filter(PublicBuild.id == build_id).first()
    if not build:
        raise HTTPException(status_code=404, detail="Build not found.")
    build.load_count = (build.load_count or 0) + 1
    db.commit()
    return {"load_count": build.load_count}


@app.delete("/builds/{build_id}")
def unlist_build(
    build_id: int,
    x_client_id: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    client_hash = _get_client_id_hash(x_client_id)
    build = db.query(PublicBuild).filter(PublicBuild.id == build_id).first()
    if not build:
        raise HTTPException(status_code=404, detail="Build not found.")
    if build.ip_hash != client_hash:
        raise HTTPException(status_code=403, detail="Not your build.")
    db.delete(build)
    db.commit()
    return {"unlisted": True, "build_id": build_id}


@app.get("/builds/notifications")
def get_notifications(
    x_client_id: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    client_hash = _get_client_id_hash(x_client_id)

    notes = (
        db.query(PendingNotification)
        .filter(
            PendingNotification.ip_hash == client_hash,
            PendingNotification.delivered == False,  # noqa: E712
        )
        .all()
    )

    result = []
    for note in notes:
        result.append({
            "type": note.type,
            "data": json.loads(note.data_json),
        })
        note.delivered = True

    db.commit()
    return result


@app.get("/builds/ban-status")
def get_ban_status(x_client_id: str = Header(None), db: Session = Depends(get_builds_db)):
    client_hash = _get_optional_client_id_hash(x_client_id)
    if not client_hash:
        return {"is_banned": False, "banned_until": None}
    ban = db.query(IPBan).filter(IPBan.ip_hash == client_hash).first()
    if not ban:
        return {"is_banned": False, "banned_until": None}
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if ban.banned_until is not None and ban.banned_until <= now:
        return {"is_banned": False, "banned_until": None}
    return {
        "is_banned":    True,
        "banned_until": ban.banned_until.isoformat() + "Z" if ban.banned_until else None,
        "reason":       ban.reason,
    }


# ---------------------------------------------------
# Admin - Builds
# ---------------------------------------------------

@app.post("/admin/builds/publish")
def admin_publish_build(
    request:         Request,
    x_admin_key:     str = Header(None),
    gun_id:          str        = Body(...),
    build_name:      str        = Body(...),
    pairs:           List[list] = Body(...),
    author_id:       str | None = Body(default=None),
    stats:           dict | None = Body(default=None),
    card_image_url:  str | None = Body(default=None),
    ammo_id:         str | None = Body(default=None),
    db:              Session    = Depends(get_builds_db),
    db_main:         Session    = Depends(get_db),
):
    _require_admin(request, x_admin_key)

    gun = db_main.query(Item).filter(Item.id == gun_id, Item.is_weapon == True).first()
    if not gun:
        raise HTTPException(status_code=422, detail="Unknown gun_id.")

    name = _sanitize_build_name(build_name)[:60]
    if not name:
        raise HTTPException(status_code=422, detail="build_name cannot be empty.")

    if author_id is not None:
        if not db.query(PublicBuildAuthor).filter(PublicBuildAuthor.id == author_id).first():
            raise HTTPException(status_code=422, detail="author_id not found.")

    if not isinstance(pairs, list):
        raise HTTPException(status_code=422, detail="pairs must be an array.")
    for p in pairs:
        if not (isinstance(p, list) and len(p) == 2
                and isinstance(p[0], str) and isinstance(p[1], str)):
            raise HTTPException(status_code=422, detail="Each pair must be [slot_id, item_id].")

    _validate_pairs(pairs, db_main)

    all_ids = [gun_id] + [p[1] for p in pairs]
    price_rows = db_main.query(Item.id, Item.trader_price_rub).filter(Item.id.in_(all_ids)).all()
    total_price = sum(r[1] or 0 for r in price_rows) or None

    build = PublicBuild(
        gun_id          = gun_id,
        gun_name        = gun.name,
        build_name      = name,
        pairs_json      = json.dumps(pairs),
        ip_hash         = "admin",
        ip_snapshot     = None,
        author_id       = author_id,
        is_admin_build  = True,
        is_featured     = True,
        stats_json      = json.dumps(stats) if stats else None,
        total_price_rub = total_price,
        card_image_url  = card_image_url,
        ammo_id         = ammo_id or None,
    )
    db.add(build)
    db.commit()
    db.refresh(build)
    return {"id": build.id, "published_at": build.published_at.isoformat()}


@app.post("/admin/builds/{build_id}/feature")
def admin_feature_build(
    build_id:       int,
    request:        Request,
    x_admin_key:    str = Header(None),
    card_image_url: str | None = Body(default=None),
    author_id:      str | None = Body(default=None),
    db:             Session = Depends(get_builds_db),
):
    _require_admin(request, x_admin_key)
    build = db.query(PublicBuild).filter(PublicBuild.id == build_id).first()
    if not build:
        raise HTTPException(status_code=404, detail="Build not found.")
    if author_id is not None:
        if not db.query(PublicBuildAuthor).filter(PublicBuildAuthor.id == author_id).first():
            raise HTTPException(status_code=422, detail="author_id not found.")
    build.is_featured    = True
    if card_image_url is not None:
        build.card_image_url = card_image_url
    if author_id is not None:
        build.author_id = author_id
    db.commit()
    return {"id": build.id, "is_featured": True, "card_image_url": build.card_image_url, "author_id": build.author_id}


@app.post("/admin/builds/{build_id}/unfeature")
def admin_unfeature_build(
    build_id:    int,
    request:     Request,
    x_admin_key: str = Header(None),
    db:          Session = Depends(get_builds_db),
):
    _require_admin(request, x_admin_key)
    build = db.query(PublicBuild).filter(PublicBuild.id == build_id).first()
    if not build:
        raise HTTPException(status_code=404, detail="Build not found.")
    build.is_featured    = False
    build.card_image_url = None
    build.author_id      = None
    db.commit()
    return {"id": build.id, "is_featured": False}


@app.post("/admin/builds/{build_id}/card-image")
def admin_set_card_image(
    build_id:       int,
    request:        Request,
    x_admin_key:    str = Header(None),
    card_image_url: str | None = Body(default=None, embed=True),
    db:             Session = Depends(get_builds_db),
):
    _require_admin(request, x_admin_key)
    build = db.query(PublicBuild).filter(PublicBuild.id == build_id).first()
    if not build:
        raise HTTPException(status_code=404, detail="Build not found.")
    build.card_image_url = card_image_url
    db.commit()
    return {"id": build.id, "card_image_url": build.card_image_url}


@app.post("/admin/builds/{build_id}/author")
def admin_set_build_author(
    build_id:    int,
    request:     Request,
    x_admin_key: str = Header(None),
    author_id:   str | None = Body(default=..., embed=True),
    db:          Session = Depends(get_builds_db),
):
    _require_admin(request, x_admin_key)
    build = db.query(PublicBuild).filter(PublicBuild.id == build_id).first()
    if not build:
        raise HTTPException(status_code=404, detail="Build not found.")
    if author_id is not None:
        if not db.query(PublicBuildAuthor).filter(PublicBuildAuthor.id == author_id).first():
            raise HTTPException(status_code=422, detail="author_id not found.")
    build.author_id = author_id
    db.commit()
    return {"id": build.id, "author_id": build.author_id}


@app.delete("/admin/builds/{build_id}")
def admin_delete_build(
    build_id: int,
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    _require_admin(request, x_admin_key)
    build = db.query(PublicBuild).filter(PublicBuild.id == build_id).first()
    if not build:
        raise HTTPException(status_code=404, detail="Build not found.")

    owner_hash = build.ip_hash
    build_name = build.build_name
    db.delete(build)

    # notify the owner (skip for admin-published builds)
    if owner_hash != "admin":
        db.add(PendingNotification(
            ip_hash   = owner_hash,
            type      = "unlist",
            data_json = json.dumps({"build_name": build_name}),
        ))

    db.commit()
    return {"deleted": True, "build_id": build_id, "ip_hash": owner_hash}


@app.get("/admin/migration/status")
def admin_migration_status(
    request:     Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    _require_admin(request, x_admin_key)
    from config import GITEE_TOKEN, GITEE_DRY_RUN, DISABLE_BG_MIGRATE

    total    = db.query(PublicBuild).count()
    migrated = db.query(PublicBuild).filter(
        PublicBuild.card_image_url.like(_GITEE_RAW_PREFIX + "%")
    ).count()
    errored  = db.query(PublicBuild).filter(
        PublicBuild.card_image_url.like("error:%")
    ).count()
    dry_run_count = db.query(PublicBuild).filter(
        PublicBuild.card_image_url.like("dryrun:%")
    ).count()
    pending  = total - migrated - errored - dry_run_count

    return {
        "total":            total,
        "migrated":         migrated,
        "pending":          pending,
        "errored":          errored,
        "dry_run_processed": dry_run_count,
        "worker_disabled":  DISABLE_BG_MIGRATE,
        "dry_run":          GITEE_DRY_RUN,
        "token_set":        bool(GITEE_TOKEN),
        "complete":         pending == 0 and errored == 0,
    }


@app.post("/admin/migration/reset")
def admin_migration_reset(
    request:     Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    """Clears ALL auto-generated card image URLs so the migration worker
    re-processes every build from scratch on the next server restart."""
    _require_admin(request, x_admin_key)
    count = (
        db.query(PublicBuild)
        .filter(
            PublicBuild.card_image_url.like(_GITEE_RAW_PREFIX + "%")
            | PublicBuild.card_image_url.like("error:%")
            | PublicBuild.card_image_url.like("dryrun:%")
        )
        .update({"card_image_url": None}, synchronize_session=False)
    )
    db.commit()
    return {"reset": count}


@app.post("/admin/migration/clear-errors")
def admin_migration_clear_errors(
    request:     Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    _require_admin(request, x_admin_key)
    count = (
        db.query(PublicBuild)
        .filter(
            PublicBuild.card_image_url.like("error:%")
            | PublicBuild.card_image_url.like("dryrun:%")
        )
        .update({"card_image_url": None}, synchronize_session=False)
    )
    db.commit()
    return {"cleared": count}


@app.get("/admin/builds")
def admin_list_builds(
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    _require_admin(request, x_admin_key)
    rows = db.query(PublicBuild).order_by(PublicBuild.published_at.desc()).all()
    return [
        {
            "id":             b.id,
            "gun_id":         b.gun_id,
            "gun_name":       b.gun_name,
            "build_name":     b.build_name,
            "author_id":      b.author_id,
            "ip_hash":        b.ip_hash,
            "ip_snapshot":    b.ip_snapshot,
            "is_admin_build": b.is_admin_build,
            "published_at":   b.published_at.isoformat(),
        }
        for b in rows
    ]


# ---------------------------------------------------
# Leaderboard
# ---------------------------------------------------

def _dense_rank(scores):
    """Return dense ranks for a descending-sorted list of scores.
    Tied scores share the same rank with no gaps: [50,50,50,30] -> [1,1,1,2]."""
    ranks = []
    rank = 0
    for i, score in enumerate(scores):
        if i == 0 or score != scores[i - 1]:
            rank += 1
        ranks.append(rank)
    return ranks


def _build_row_to_dict(rank, build, author, like_count):
    return {
        "rank":                   rank,
        "build_id":               build.id,
        "build_name":             build.build_name,
        "gun_id":                 build.gun_id,
        "gun_name":               build.gun_name,
        "author_display_name":    author.display_name     if author else None,
        "author_display_name_zh": author.display_name_zh  if author else None,
        "author_avatar_url":      author.avatar_url        if author else None,
        "like_count":             like_count,
        "is_admin_build":         build.is_admin_build,
        "is_featured":            build.is_featured,
        "pairs":                  _safe_json_loads(build.pairs_json),
        "stats":                  _safe_json_loads(build.stats_json),
        "total_price_rub":        build.total_price_rub,
        "card_image_url":         build.card_image_url,
        "ammo_id":                build.ammo_id,
    }


@app.get("/leaderboard/builds")
def get_leaderboard_builds(
    period: str = "2w",
    db: Session = Depends(get_builds_db),
):
    if period not in ("2w", "all"):
        raise HTTPException(status_code=400, detail='period must be "2w" or "all"')

    if period == "2w":
        two_weeks_ago = datetime.now(timezone.utc) - timedelta(weeks=2)
        rows = (
            db.query(PublicBuild, PublicBuildAuthor, func.count(BuildVote.id).label("trending_likes"))
            .join(BuildVote, BuildVote.build_id == PublicBuild.id)
            .outerjoin(PublicBuildAuthor, PublicBuild.author_id == PublicBuildAuthor.id)
            .filter(BuildVote.created_at >= two_weeks_ago, BuildVote.vote == "like")
            .group_by(PublicBuild.id)
            .order_by(func.count(BuildVote.id).desc())
            .limit(10)
            .all()
        )
        counts = [count for _, _, count in rows]
        ranks  = _dense_rank(counts)
        return [_build_row_to_dict(ranks[i], build, author, count) for i, (build, author, count) in enumerate(rows)]
    else:
        rows = (
            db.query(PublicBuild, PublicBuildAuthor, BuildRating)
            .outerjoin(BuildRating, BuildRating.build_id == PublicBuild.id)
            .outerjoin(PublicBuildAuthor, PublicBuild.author_id == PublicBuildAuthor.id)
            .filter(BuildRating.like_count > 0)
            .order_by(BuildRating.like_count.desc())
            .limit(50)
            .all()
        )
        counts = [rating.like_count if rating else 0 for _, _, rating in rows]
        ranks  = _dense_rank(counts)
        return [_build_row_to_dict(ranks[i], build, author, counts[i]) for i, (build, author, _) in enumerate(rows)]


@app.get("/leaderboard/attachments")
def get_leaderboard_attachments(
    period: str = "2w",
    sort: str = "likes",
    db: Session = Depends(get_ratings_db),
    db_main: Session = Depends(get_db),
):
    if period not in ("2w", "all"):
        raise HTTPException(status_code=400, detail='period must be "2w" or "all"')
    if sort not in ("likes", "dislikes"):
        raise HTTPException(status_code=400, detail='sort must be "likes" or "dislikes"')

    likes_label    = func.sum(case((AttachmentVote.vote == "like",    1), else_=0))
    dislikes_label = func.sum(case((AttachmentVote.vote == "dislike", 1), else_=0))

    if period == "2w":
        two_weeks_ago = datetime.now(timezone.utc) - timedelta(weeks=2)
        order_expr = likes_label if sort == "likes" else dislikes_label
        rows = (
            db.query(
                AttachmentVote.item_id,
                likes_label.label("likes"),
                dislikes_label.label("dislikes"),
            )
            .filter(AttachmentVote.created_at >= two_weeks_ago)
            .group_by(AttachmentVote.item_id)
            .having(order_expr > 0)
            .order_by(order_expr.desc())
            .limit(20)
            .all()
        )
    else:
        order_col = AttachmentRating.like_count if sort == "likes" else AttachmentRating.dislike_count
        rows = (
            db.query(
                AttachmentRating.item_id,
                AttachmentRating.like_count.label("likes"),
                AttachmentRating.dislike_count.label("dislikes"),
            )
            .filter(order_col > 0)
            .order_by(order_col.desc())
            .limit(100)
            .all()
        )

    item_ids = [row.item_id for row in rows]
    items_map = {
        item.id: item
        for item in db_main.query(Item).filter(Item.id.in_(item_ids)).all()
    } if item_ids else {}

    # resolve most common slot_name for each item as its category
    category_map: dict[str, str] = {}
    if item_ids:
        slot_rows = (
            db_main.query(SlotAllowedItem.allowed_item_id, Slot.slot_name, func.count(SlotAllowedItem.id).label("cnt"))
            .join(Slot, Slot.id == SlotAllowedItem.slot_id)
            .filter(SlotAllowedItem.allowed_item_id.in_(item_ids))
            .group_by(SlotAllowedItem.allowed_item_id, Slot.slot_name)
            .all()
        )
        # keep highest count slot_name per item
        for item_id, slot_name, cnt in slot_rows:
            if item_id not in category_map or cnt > category_map.get('__cnt__' + item_id, 0):
                category_map[item_id] = slot_name
                category_map['__cnt__' + item_id] = cnt

    scores = [row.likes if sort == "likes" else row.dislikes for row in rows]
    ranks  = _dense_rank(scores)

    return [
        {
            "rank":          ranks[i],
            "item_id":       row.item_id,
            "item_name":     items_map[row.item_id].name      if row.item_id in items_map else row.item_id,
            "item_name_zh":  items_map[row.item_id].name_zh   if row.item_id in items_map else None,
            "icon_link":     items_map[row.item_id].icon_link if row.item_id in items_map else None,
            "like_count":    row.likes,
            "dislike_count": row.dislikes,
            "item_category": category_map.get(row.item_id, None),
        }
        for i, row in enumerate(rows)
    ]


@app.get("/stat-changelog")
def get_stat_changelog(
    limit: int = 300,
    db: Session = Depends(get_db),
):
    rows = (
        db.query(StatChangeLog)
        .order_by(StatChangeLog.detected_at.desc())
        .limit(min(limit, 500))
        .all()
    )

    item_ids = list({r.item_id for r in rows})
    items_map = {
        item.id: item
        for item in db.query(Item).filter(Item.id.in_(item_ids)).all()
    } if item_ids else {}

    return [
        {
            "item_id":      row.item_id,
            "item_name":    items_map[row.item_id].name     if row.item_id in items_map else row.item_name,
            "item_name_zh": items_map[row.item_id].name_zh  if row.item_id in items_map else None,
            "icon_link":    items_map[row.item_id].icon_link if row.item_id in items_map else None,
            "stat_name":    row.stat_name,
            "old_value":    row.old_value,
            "new_value":    row.new_value,
            "detected_at":  row.detected_at.isoformat() if row.detected_at else None,
        }
        for row in rows
    ]


# ---------------------------------------------------
# Admin - Bans
# ---------------------------------------------------

@app.post("/admin/bans")
def admin_create_ban(
    request: Request,
    x_admin_key:    str      = Header(None),
    client_id_hash: str      = Body(...),
    duration_hours: int | None = Body(default=None),
    reason:         str | None = Body(default=None),
    db: Session = Depends(get_builds_db),
):
    _require_admin(request, x_admin_key)

    banned_until = None
    if duration_hours is not None:
        banned_until = datetime.now(timezone.utc) + timedelta(hours=duration_hours)

    existing = db.query(IPBan).filter(IPBan.ip_hash == client_id_hash).first()
    if existing:
        existing.banned_at    = datetime.now(timezone.utc)
        existing.banned_until = banned_until
        existing.reason       = reason
    else:
        db.add(IPBan(ip_hash=client_id_hash, banned_until=banned_until, reason=reason))

    # notify the banned client
    db.add(PendingNotification(
        ip_hash   = client_id_hash,
        type      = "ban",
        data_json = json.dumps({
            "banned_until": banned_until.replace(tzinfo=None).isoformat() + "Z" if banned_until else None,
            "reason":       reason,
        }),
    ))

    db.commit()
    return {"banned": True, "client_id_hash": client_id_hash}


@app.delete("/admin/bans/{client_id_hash}")
def admin_delete_ban(
    client_id_hash: str,
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    _require_admin(request, x_admin_key)
    deleted = db.query(IPBan).filter(IPBan.ip_hash == client_id_hash).delete()
    if deleted:
        db.add(PendingNotification(
            ip_hash   = client_id_hash,
            type      = "unban",
            data_json = json.dumps({}),
        ))
    db.commit()
    return {"unbanned": True, "client_id_hash": client_id_hash}


@app.get("/admin/bans")
def admin_list_bans(
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    _require_admin(request, x_admin_key)
    bans = db.query(IPBan).all()
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    return [
        {
            "ip_hash":      b.ip_hash,
            "banned_at":    b.banned_at.isoformat(),
            "banned_until": b.banned_until.isoformat() + "Z" if b.banned_until else None,
            "is_active":    b.banned_until is None or b.banned_until > now,
            "reason":       b.reason,
        }
        for b in bans
    ]


# ---------------------------------------------------
# Admin - Authors
# ---------------------------------------------------

@app.post("/admin/authors")
def admin_upsert_author(
    request: Request,
    x_admin_key:     str      = Header(None),
    id:              str      = Body(...),
    display_name:    str      = Body(...),
    avatar_url:      str | None = Body(default=None),
    display_name_zh: str | None = Body(default=None),
    db: Session = Depends(get_builds_db),
):
    _require_admin(request, x_admin_key)
    existing = db.query(PublicBuildAuthor).filter(PublicBuildAuthor.id == id).first()
    if existing:
        existing.display_name    = display_name
        existing.avatar_url      = avatar_url
        existing.display_name_zh = display_name_zh
    else:
        db.add(PublicBuildAuthor(
            id              = id,
            display_name    = display_name,
            avatar_url      = avatar_url,
            display_name_zh = display_name_zh,
        ))
    db.commit()
    return {"ok": True, "id": id}


@app.delete("/admin/authors/{author_id}")
def admin_delete_author(
    author_id: str,
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    _require_admin(request, x_admin_key)
    author = db.query(PublicBuildAuthor).filter(PublicBuildAuthor.id == author_id).first()
    if not author:
        raise HTTPException(status_code=404, detail="Author not found.")
    db.query(PublicBuild).filter(PublicBuild.author_id == author_id).update({"author_id": None})
    db.delete(author)
    db.commit()
    return {"ok": True, "id": author_id}


@app.post("/admin/community-builds/disable")
def admin_disable_community_builds(request: Request, x_admin_key: str = Header(None)):
    global _community_builds_disabled
    _require_admin(request, x_admin_key)
    _community_builds_disabled = True
    open(_COMMUNITY_BUILDS_LOCK_FILE, "w").close()
    return {"community_builds_enabled": False}


@app.post("/admin/community-builds/enable")
def admin_enable_community_builds(request: Request, x_admin_key: str = Header(None)):
    global _community_builds_disabled
    _require_admin(request, x_admin_key)
    _community_builds_disabled = False
    if os.path.exists(_COMMUNITY_BUILDS_LOCK_FILE):
        os.remove(_COMMUNITY_BUILDS_LOCK_FILE)
    return {"community_builds_enabled": True}


@app.get("/admin/community-builds/status")
def admin_community_builds_status(request: Request, x_admin_key: str = Header(None)):
    _require_admin(request, x_admin_key)
    return {"community_builds_enabled": not _community_builds_disabled}


@app.get("/announcements")
def get_announcements(db: Session = Depends(get_builds_db)):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    rows = (
        db.query(ServerAnnouncement)
        .filter(
            (ServerAnnouncement.expires_at == None) |  # noqa: E711
            (ServerAnnouncement.expires_at > now)
        )
        .order_by(ServerAnnouncement.created_at.desc())
        .all()
    )
    return [
        {
            "id":         r.id,
            "message":    r.message,
            "level":      r.level,
            "created_at": r.created_at.isoformat(),
            "expires_at": r.expires_at.isoformat() if r.expires_at else None,
        }
        for r in rows
    ]


# ---------------------------------------------------
# Admin - Announcements
# ---------------------------------------------------

@app.post("/admin/announcements")
def admin_create_announcement(
    request:          Request,
    x_admin_key:      str      = Header(None),
    message:          str      = Body(...),
    level:            str      = Body(default="info"),
    expires_in_hours: int | None = Body(default=None),
    db: Session = Depends(get_builds_db),
):
    _require_admin(request, x_admin_key)
    if level not in ("info", "warning", "error"):
        raise HTTPException(status_code=422, detail="level must be 'info', 'warning', or 'error'.")
    expires_at = None
    if expires_in_hours is not None:
        expires_at = datetime.now(timezone.utc) + timedelta(hours=expires_in_hours)
    row = ServerAnnouncement(message=message, level=level, expires_at=expires_at)
    db.add(row)
    db.commit()
    db.refresh(row)
    return {
        "id":         row.id,
        "message":    row.message,
        "level":      row.level,
        "created_at": row.created_at.isoformat(),
        "expires_at": row.expires_at.isoformat() if row.expires_at else None,
    }


@app.delete("/admin/announcements/{announcement_id}")
def admin_delete_announcement(
    announcement_id: int,
    request:         Request,
    x_admin_key:     str = Header(None),
    db: Session = Depends(get_builds_db),
):
    _require_admin(request, x_admin_key)
    deleted = db.query(ServerAnnouncement).filter(ServerAnnouncement.id == announcement_id).delete()
    db.commit()
    if not deleted:
        raise HTTPException(status_code=404, detail="Announcement not found.")
    return {"deleted": True, "id": announcement_id}


@app.get("/admin/announcements")
def admin_list_announcements(
    request:     Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    _require_admin(request, x_admin_key)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    rows = db.query(ServerAnnouncement).order_by(ServerAnnouncement.created_at.desc()).all()
    return [
        {
            "id":         r.id,
            "message":    r.message,
            "level":      r.level,
            "created_at": r.created_at.isoformat(),
            "expires_at": r.expires_at.isoformat() if r.expires_at else None,
            "is_active":  r.expires_at is None or r.expires_at > now,
        }
        for r in rows
    ]


@app.get("/admin/authors")
def admin_list_authors(
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    _require_admin(request, x_admin_key)
    authors = db.query(PublicBuildAuthor).all()
    return [
        {
            "id":             a.id,
            "display_name":    a.display_name,
            "display_name_zh": a.display_name_zh,
            "avatar_url":      a.avatar_url,
        }
        for a in authors
    ]
