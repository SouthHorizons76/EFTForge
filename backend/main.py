from fastapi import FastAPI, Body, Depends, HTTPException
from starlette.middleware.gzip import GZipMiddleware as GZIPMiddleware
from sqlalchemy import func
from sqlalchemy.orm import Session
from typing import List

from database import SessionLocal, engine, Base
from models_items import Item
from models_slots import Slot
from models_slot_allowed import SlotAllowedItem

from fastapi.middleware.cors import CORSMiddleware

from config import CORS_ORIGINS

app = FastAPI(title="EFTForge API")

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
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

Base.metadata.create_all(bind=engine)


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


# ---------------------------------------------------
# Shared calculation helpers (no DB access)
# ---------------------------------------------------

def _compute_stats(base_item, current_ids: list, items_map: dict,
                   strength_level: int = 10, equip_ergo_modifier: float = 0.0) -> dict:
    """Compute build stats from pre-loaded items. No DB queries."""
    factory_ids = base_item.factory_attachment_ids.split(",") if base_item.factory_attachment_ids else []
    factory_set = set(factory_ids)
    current_set = set(current_ids)
    factory_intact = factory_set.issubset(current_set)

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
            "base_ergo": gun.factory_ergonomics or gun.base_ergonomics or 0,
            "weight": gun.weight or 0,
            "icon_link": gun.icon_link,
            "image_512_link": gun.image_512_link,
            "factory_attachment_ids": factory_ids,
            "caliber": gun.caliber,
            "weapon_category": gun.weapon_category,
            "recoil_vertical": gun.recoil_vertical,
            "recoil_horizontal": gun.recoil_horizontal,
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
            "id": a.id,
            "name": _item_name(a, lang),
            "weight": a.weight
        }
        for a in ammo
    ]

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
    # Ammo Weight Logic (not in batch endpoint — only used for the main stats panel)
    # ------------------------------
    if assume_full_mag and selected_ammo_id:
        ammo = db.query(Item).filter(Item.id == selected_ammo_id).first()
        if ammo and ammo.is_ammo:
            for att in items_map.values():
                if att.magazine_capacity:
                    stats["total_weight"] = round(
                        stats["total_weight"] + (ammo.weight or 0) * att.magazine_capacity, 3
                    )
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

    # 1. Batch-load all items needed (installed + candidates) — 1 query
    all_needed_ids = set(installed_ids) | set(candidate_ids)
    items_map = {
        item.id: item
        for item in db.query(Item).filter(Item.id.in_(all_needed_ids)).all()
    }

    # 2. Validation setup: installed items + their slots — 1 query each
    installed_set = set(installed_ids) | {base_item_id}
    installed_items_map = {iid: items_map[iid] for iid in installed_ids if iid in items_map}
    installed_items_map[base_item_id] = base_item

    all_installed_slots = db.query(Slot).filter(
        Slot.parent_item_id.in_(installed_set)
    ).all()
    slots_by_item: dict[str, list] = {iid: [] for iid in installed_set}
    for s in all_installed_slots:
        slots_by_item[s.parent_item_id].append(s)

    # 3. Which candidates are allowed in this slot — 1 query
    allowed_records = db.query(SlotAllowedItem).filter(
        SlotAllowedItem.slot_id == slot_id,
        SlotAllowedItem.allowed_item_id.in_(candidate_ids)
    ).all()
    allowed_set = {r.allowed_item_id for r in allowed_records}

    # 4. Baseline stats (installed_ids, no candidate) — no DB
    base_stats = _compute_stats(base_item, installed_ids, items_map, strength_level, equip_ergo_modifier)

    # 5. Per-candidate validation + calculation — no DB
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
            "item_id": candidate_id,
            **validation,
            **sim_stats,
        })

    return {"base": base_stats, "candidates": results}
