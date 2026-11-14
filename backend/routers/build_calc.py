"""Build validation and stat calculation endpoints."""

from typing import List

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

from models_items import Item
from models_slot_allowed import SlotAllowedItem
from models_slots import Slot
from routers.shared import (
    EQUIP_ERGO_MAX,
    EQUIP_ERGO_MIN,
    MAX_CANDIDATE_IDS,
    MAX_COMBO_BATCH,
    MAX_INSTALLED_IDS,
    STRENGTH_LEVEL_MAX,
    STRENGTH_LEVEL_MIN,
    cap_list,
    get_game_db,
)
from services.conflicts import check_conflicts
from stats import _compute_stats, apply_full_mag_ammo

router = APIRouter()


# ---------------------------------------------------
# Build Compatibility Validation
# ---------------------------------------------------


@router.post("/build/validate")
def validate_attachment(
    base_item_id: str = Body(...),
    installed_ids: List[str] = Body(...),
    slot_id: str = Body(...),
    candidate_id: str = Body(...),
    lang: str = Body(default="en"),
    db: Session = Depends(get_game_db),
):

    cap_list("installed_ids", installed_ids, MAX_INSTALLED_IDS)

    base_item = db.query(Item).filter(Item.id == base_item_id).first()
    if not base_item:
        raise HTTPException(status_code=404, detail="Base item not found")

    candidate = db.query(Item).filter(Item.id == candidate_id).first()
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate item not found")

    # -------------------------------------------------
    # SLOT LEGALITY CHECK
    # -------------------------------------------------

    allowed = (
        db.query(SlotAllowedItem)
        .filter(SlotAllowedItem.slot_id == slot_id, SlotAllowedItem.allowed_item_id == candidate_id)
        .first()
    )

    if not allowed:
        return {"valid": False, "reason": "Item not allowed in this slot", "type": "slot_not_allowed"}

    # -------------------------------------------------
    # BATCH-LOAD all installed items and their slots (2 queries total)
    # -------------------------------------------------

    installed_set = set(installed_ids)
    installed_set.add(base_item_id)

    installed_items = db.query(Item).filter(Item.id.in_(installed_set)).all()
    installed_map = {item.id: item for item in installed_items}

    all_installed_slots = db.query(Slot).filter(Slot.parent_item_id.in_(installed_set)).all()
    slots_by_item: dict[str, list] = {item_id: [] for item_id in installed_set}
    for s in all_installed_slots:
        slots_by_item[s.parent_item_id].append(s)

    result = check_conflicts(candidate, candidate_id, installed_set, installed_map, slots_by_item, slot_id, lang)
    if not result["valid"]:
        return result

    return {"valid": True}


# ---------------------------------------------------
# Calculation Engine
# ---------------------------------------------------


@router.post("/build/calculate")
def calculate_build(
    base_item_id: str = Body(...),
    attachment_ids: List[str] | None = Body(default=None),
    assume_full_mag: bool = Body(default=True),
    selected_ammo_id: str | None = Body(default=None),
    selected_ubgl_ammo_id: str | None = Body(default=None),
    strength_level: int = Body(default=10),
    equip_ergo_modifier: float = Body(default=0.0),
    db: Session = Depends(get_game_db),
):

    if not (STRENGTH_LEVEL_MIN <= strength_level <= STRENGTH_LEVEL_MAX):
        raise HTTPException(
            status_code=422, detail=f"strength_level must be between {STRENGTH_LEVEL_MIN} and {STRENGTH_LEVEL_MAX}"
        )

    if not (EQUIP_ERGO_MIN <= equip_ergo_modifier <= EQUIP_ERGO_MAX):
        raise HTTPException(
            status_code=422, detail=f"equip_ergo_modifier must be between {EQUIP_ERGO_MIN} and {EQUIP_ERGO_MAX}"
        )

    base_item = db.query(Item).filter(Item.id == base_item_id).first()
    if not base_item:
        raise HTTPException(status_code=404, detail="Base item not found")

    current_ids = attachment_ids or []
    items_map = {}
    if current_ids:
        items_map = {item.id: item for item in db.query(Item).filter(Item.id.in_(current_ids)).all()}

    stats = _compute_stats(base_item, current_ids, items_map, strength_level, equip_ergo_modifier)

    # ------------------------------
    # Ammo Weight + Heat/Durability-Burn Logic (not in batch endpoint - only used for the main stats panel)
    # ------------------------------
    # Gated on assume_full_mag (not on whether a magazine is actually installed): the toggle
    # represents "assume this weapon is loaded and ready to fire this round," which is independent
    # of whether the user has dropped a magazine model into the builder.
    ammo = (
        db.query(Item).filter(Item.id == selected_ammo_id).first() if (selected_ammo_id and assume_full_mag) else None
    )
    ubgl_grenade = (
        db.query(Item).filter(Item.id == selected_ubgl_ammo_id).first()
        if (assume_full_mag and selected_ubgl_ammo_id)
        else None
    )
    apply_full_mag_ammo(stats, items_map, ammo, ubgl_grenade, strength_level, equip_ergo_modifier)

    return stats


# ---------------------------------------------------
# Batch Process (validation + calculation for all candidates in one request)
# ---------------------------------------------------


@router.post("/build/batch-process")
def batch_process(
    base_item_id: str = Body(...),
    installed_ids: List[str] = Body(...),
    slot_id: str = Body(...),
    candidate_ids: List[str] = Body(...),
    lang: str = Body(default="en"),
    strength_level: int = Body(default=10),
    equip_ergo_modifier: float = Body(default=0.0),
    db: Session = Depends(get_game_db),
):
    if not (STRENGTH_LEVEL_MIN <= strength_level <= STRENGTH_LEVEL_MAX):
        raise HTTPException(
            status_code=422, detail=f"strength_level must be between {STRENGTH_LEVEL_MIN} and {STRENGTH_LEVEL_MAX}"
        )

    if not (EQUIP_ERGO_MIN <= equip_ergo_modifier <= EQUIP_ERGO_MAX):
        raise HTTPException(
            status_code=422, detail=f"equip_ergo_modifier must be between {EQUIP_ERGO_MIN} and {EQUIP_ERGO_MAX}"
        )

    cap_list("installed_ids", installed_ids, MAX_INSTALLED_IDS)
    cap_list("candidate_ids", candidate_ids, MAX_CANDIDATE_IDS)

    base_item = db.query(Item).filter(Item.id == base_item_id).first()
    if not base_item:
        raise HTTPException(status_code=404, detail="Base item not found")

    # 1. Batch-load all items needed (installed + candidates) - 1 query
    all_needed_ids = set(installed_ids) | set(candidate_ids)
    items_map = {item.id: item for item in db.query(Item).filter(Item.id.in_(all_needed_ids)).all()}

    # 2. Validation setup: installed items + their slots - 1 query each
    installed_set = set(installed_ids) | {base_item_id}
    installed_items_map = {iid: items_map[iid] for iid in installed_ids if iid in items_map}
    installed_items_map[base_item_id] = base_item

    all_installed_slots = db.query(Slot).filter(Slot.parent_item_id.in_(installed_set)).all()
    slots_by_item: dict[str, list] = {iid: [] for iid in installed_set}
    for s in all_installed_slots:
        slots_by_item[s.parent_item_id].append(s)

    # 3. Which candidates are allowed in this slot - 1 query
    allowed_records = (
        db.query(SlotAllowedItem)
        .filter(SlotAllowedItem.slot_id == slot_id, SlotAllowedItem.allowed_item_id.in_(candidate_ids))
        .all()
    )
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
            validation = {
                "valid": False,
                "reason_key": None,
                "reason_name": None,
                "conflicting_item_id": None,
                "conflicting_slot_id": None,
            }
        else:
            validation = check_conflicts(
                candidate, candidate_id, installed_set, installed_items_map, slots_by_item, slot_id, lang
            )

        sim_stats = _compute_stats(
            base_item, list(installed_ids) + [candidate_id], items_map, strength_level, equip_ergo_modifier
        )
        results.append(
            {
                "item_id": candidate_id,
                "trader_price": candidate.trader_price,
                "trader_price_rub": candidate.trader_price_rub,
                "trader_currency": candidate.trader_currency,
                "trader_vendor": candidate.trader_vendor,
                "trader_min_level": candidate.trader_min_level,
                **validation,
                **sim_stats,
            }
        )

    return {"base": base_stats, "candidates": results}


@router.post("/build/combo-batch-process")
def combo_batch_process(
    base_item_id: str = Body(...),
    installed_ids: List[str] = Body(...),
    combos: List[dict] = Body(...),
    lang: str = Body(default="en"),
    strength_level: int = Body(default=10),
    equip_ergo_modifier: float = Body(default=0.0),
    db: Session = Depends(get_game_db),
):
    if not (STRENGTH_LEVEL_MIN <= strength_level <= STRENGTH_LEVEL_MAX):
        raise HTTPException(
            status_code=422, detail=f"strength_level must be between {STRENGTH_LEVEL_MIN} and {STRENGTH_LEVEL_MAX}"
        )
    if not (EQUIP_ERGO_MIN <= equip_ergo_modifier <= EQUIP_ERGO_MAX):
        raise HTTPException(
            status_code=422, detail=f"equip_ergo_modifier must be between {EQUIP_ERGO_MIN} and {EQUIP_ERGO_MAX}"
        )

    cap_list("installed_ids", installed_ids, MAX_INSTALLED_IDS)
    cap_list("combos", combos, MAX_COMBO_BATCH)

    base_item = db.query(Item).filter(Item.id == base_item_id).first()
    if not base_item:
        raise HTTPException(status_code=404, detail="Base item not found")

    all_needed_ids = set(installed_ids)
    for combo in combos:
        add_ids = combo.get("add_ids", [])
        if not isinstance(add_ids, list) or len(add_ids) > MAX_INSTALLED_IDS:
            raise HTTPException(status_code=422, detail="Invalid add_ids in combo")
        all_needed_ids.update(add_ids)

    items_map = {item.id: item for item in db.query(Item).filter(Item.id.in_(all_needed_ids)).all()}
    items_map[base_item_id] = base_item

    base_stats = _compute_stats(base_item, installed_ids, items_map, strength_level, equip_ergo_modifier)

    results = []
    for combo in combos:
        add_ids = combo.get("add_ids", [])
        sim_stats = _compute_stats(
            base_item, list(installed_ids) + add_ids, items_map, strength_level, equip_ergo_modifier
        )
        results.append({"cid": combo.get("cid"), **sim_stats})

    return {"base": base_stats, "combos": results}
