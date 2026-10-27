"""Read-only item catalog: traders, ammo, items and slots."""

from typing import List

from fastapi import APIRouter, Body, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from models_items import Item
from models_slot_allowed import SlotAllowedItem
from models_slots import Slot
from models_traders import Trader
from routers.shared import get_db, item_name, item_short_name

router = APIRouter()


# ---------------------------------------------------
# Traders
# ---------------------------------------------------


@router.get("/traders")
def get_traders(db: Session = Depends(get_db)):
    traders = db.query(Trader).all()
    return [
        {
            "id": t.id,
            "name": t.name,
            "normalizedName": t.normalized_name,
            "imageLink": t.image_link,
            "image4xLink": t.image_4x_link,
        }
        for t in traders
    ]


def _ammo_dto(a, lang: str) -> dict:
    return {
        "id": a.id,
        "name": item_name(a, lang),
        "short_name": item_short_name(a, lang),
        "icon_link": a.icon_link,
        "base_image_link": a.base_image_link,
        "background_color": a.background_color,
        "weight": a.weight,
        "caliber": a.caliber,
        "ammo_type": a.ammo_type,
        "damage": a.ammo_damage,
        "penetration_power": a.penetration_power,
        "penetration_chance": a.penetration_chance,
        "penetration_power_deviation": a.penetration_power_deviation,
        "armor_damage": a.armor_damage,
        "velocity": a.velocity,
        "tracer": a.tracer,
        "tracer_color": a.tracer_color,
        "projectile_count": a.projectile_count,
        "fragmentation_chance": a.fragmentation_chance,
        "ricochet_chance": a.ricochet_chance,
        "stack_max_size": a.stack_max_size,
        "accuracy_modifier": a.ammo_accuracy_modifier,
        "recoil_modifier": a.ammo_recoil_modifier,
        "light_bleed_delta": a.light_bleed_delta,
        "heavy_bleed_delta": a.heavy_bleed_delta,
        "heat_factor": a.heat_factor,
        "durability_burn_factor": a.durability_burn_factor,
        "penetration_damage_mod": a.penetration_damage_mod,
        "malf_feed_chance": a.malf_feed_chance,
        "misfire_chance": a.misfire_chance,
        "trader_price": a.trader_price,
        "trader_price_rub": a.trader_price_rub,
        "trader_currency": a.trader_currency,
        "trader_vendor": a.trader_vendor,
        "trader_min_level": a.trader_min_level,
    }


# Calibers that are flares / signal cartridges - no meaningful ballistic stats
_AMMO_EXCLUDED_CALIBERS = {"Caliber26x75"}


@router.get("/ammo/all")
def get_all_ammo(lang: str = "en", db: Session = Depends(get_db)):
    rows = (
        db.query(Item)
        .filter(Item.is_ammo == True)
        .filter(Item.caliber.notin_(_AMMO_EXCLUDED_CALIBERS))
        .order_by(Item.caliber.asc(), Item.penetration_power.asc())
        .all()
    )
    result = {}
    for a in rows:
        cal = a.caliber or "Unknown"
        result.setdefault(cal, []).append(_ammo_dto(a, lang))
    return result


@router.get("/ammo/{caliber}")
def get_ammo_for_caliber(caliber: str, lang: str = "en", db: Session = Depends(get_db)):
    ammo = db.query(Item).filter(Item.is_ammo == True, Item.caliber == caliber).order_by(Item.weight.asc()).all()

    return [_ammo_dto(a, lang) for a in ammo]


# ---------------------------------------------------
# Item IDs (for client-side flea price prefetch)
# ---------------------------------------------------


@router.get("/items/ids")
def get_item_ids(db: Session = Depends(get_db)):
    ids = db.query(Item.id).all()
    return [row[0] for row in ids]


# ---------------------------------------------------
# Slots
# ---------------------------------------------------


@router.get("/items/{item_id}/slots")
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


@router.get("/slots/{slot_id}/allowed-items")
def get_allowed_items(slot_id: str, lang: str = "en", db: Session = Depends(get_db)):
    allowed = db.query(SlotAllowedItem).filter(SlotAllowedItem.slot_id == slot_id).all()

    ids = [a.allowed_item_id for a in allowed]

    items = db.query(Item).filter(Item.id.in_(ids)).all()

    return [
        {
            "id": item.id,
            "name": item_name(item, lang),
            "short_name": item_short_name(item, lang),
            "weight": item.weight,
            "ergonomics_modifier": item.ergonomics_modifier,
            "recoil_modifier": item.recoil_modifier,
            "accuracy_modifier": item.accuracy_modifier,
            "center_of_impact": item.center_of_impact,
            "deviation_curve": item.deviation_curve,
            "deviation_max": item.deviation_max,
            "sighting_range": item.sighting_range,
            "heat_factor": item.heat_factor,
            "cooling_factor": item.cooling_factor,
            "durability_burn_factor": item.durability_burn_factor,
            "velocity_modifier": item.velocity_modifier,
            "loudness": item.loudness,
            "icon_link": item.icon_link,
            "base_image_link": item.base_image_link,
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
            "task_unlock_id": item.task_unlock_id,
            "task_unlock_name": item.task_unlock_name,
            "task_unlock_name_zh": item.task_unlock_name_zh,
        }
        for item in items
    ]


# ---------------------------------------------------
# Batch endpoints for build reconstruction
# ---------------------------------------------------


@router.post("/slots/allowed-items/batch")
def get_allowed_items_batch(
    slot_ids: List[str] = Body(...),
    lang: str = Body(default="en"),
    db: Session = Depends(get_db),
):
    if not slot_ids:
        return {}
    allowed_rows = db.query(SlotAllowedItem).filter(SlotAllowedItem.slot_id.in_(slot_ids)).all()
    all_item_ids = list({row.allowed_item_id for row in allowed_rows})
    items_by_id = (
        {item.id: item for item in db.query(Item).filter(Item.id.in_(all_item_ids)).all()} if all_item_ids else {}
    )
    result = {sid: [] for sid in slot_ids}
    for row in allowed_rows:
        item = items_by_id.get(row.allowed_item_id)
        if item:
            result[row.slot_id].append(
                {
                    "id": item.id,
                    "name": item_name(item, lang),
                    "short_name": item_short_name(item, lang),
                    "weight": item.weight,
                    "ergonomics_modifier": item.ergonomics_modifier,
                    "recoil_modifier": item.recoil_modifier,
                    "accuracy_modifier": item.accuracy_modifier,
                    "center_of_impact": item.center_of_impact,
                    "deviation_curve": item.deviation_curve,
                    "deviation_max": item.deviation_max,
                    "sighting_range": item.sighting_range,
                    "heat_factor": item.heat_factor,
                    "cooling_factor": item.cooling_factor,
                    "durability_burn_factor": item.durability_burn_factor,
                    "velocity_modifier": item.velocity_modifier,
                    "loudness": item.loudness,
                    "icon_link": item.icon_link,
                    "base_image_link": item.base_image_link,
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
                    "task_unlock_id": item.task_unlock_id,
                    "task_unlock_name": item.task_unlock_name,
                    "task_unlock_name_zh": item.task_unlock_name_zh,
                }
            )
    return result


@router.post("/items/slots/batch")
def get_item_slots_batch(
    item_ids: List[str] = Body(..., embed=True),
    db: Session = Depends(get_db),
):
    if not item_ids:
        return {}
    slots = db.query(Slot).filter(Slot.parent_item_id.in_(item_ids)).all()
    slot_ids = [s.id for s in slots]
    counts = {}
    if slot_ids:
        counts = dict(
            db.query(SlotAllowedItem.slot_id, func.count(SlotAllowedItem.allowed_item_id))
            .filter(SlotAllowedItem.slot_id.in_(slot_ids))
            .group_by(SlotAllowedItem.slot_id)
            .all()
        )
    result = {iid: [] for iid in item_ids}
    for s in slots:
        result[s.parent_item_id].append(
            {
                "id": s.id,
                "parent_item_id": s.parent_item_id,
                "slot_name": s.slot_name,
                "slot_game_name": s.slot_game_name,
                "has_allowed_items": counts.get(s.id, 0) > 0,
            }
        )
    return result
