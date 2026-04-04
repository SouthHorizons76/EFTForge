import hashlib
import hmac
import json
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, Body, Depends, HTTPException, Header, Request
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


_migrate_builds_db()
_migrate_items_db()


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

# Active user tracking: client_id_hash -> last_seen monotonic time
_active_clients: dict[str, float] = {}
_ACTIVE_WINDOW_SECONDS = 60.0  # consider a client "active" if seen within this window

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

    return {
        "total_ergo": round(total_ergo, 2),
        "total_weight": round(total_weight, 3),
        "overswing": evo_weight > 0,
        "evo_ergo_delta": round(eed, 2),
        "recoil_vertical": total_recoil_v,
        "recoil_horizontal": total_recoil_h,
        "arm_stamina": round(arm_stamina, 1),
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
    return {"status": "ok"}


# ---------------------------------------------------
# Active users
# ---------------------------------------------------

@app.post("/heartbeat")
def heartbeat(x_client_id: str = Header(None)):
    """Register the calling client as currently active. Call every ~30s from the frontend."""
    client_hash = _get_client_id_hash(x_client_id)
    now = time.monotonic()
    _active_clients[client_hash] = now
    # Evict stale entries to keep memory bounded
    cutoff = now - _ACTIVE_WINDOW_SECONDS
    stale = [k for k, t in _active_clients.items() if t < cutoff]
    for k in stale:
        del _active_clients[k]
    return {"ok": True}


@app.get("/active-users")
def active_users():
    """Return the number of unique clients seen within the last 60 seconds."""
    cutoff = time.monotonic() - _ACTIVE_WINDOW_SECONDS
    count = sum(1 for t in _active_clients.values() if t >= cutoff)
    return {"active_users": count}


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
            "factory_attachment_ids": factory_ids,
            "caliber": gun.caliber,
            "weapon_category": gun.weapon_category,
            "recoil_vertical": gun.recoil_vertical,
            "recoil_horizontal": gun.recoil_horizontal,
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
# Public Builds
# ---------------------------------------------------

@app.post("/builds/publish")
def publish_build(
    request: Request,
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
