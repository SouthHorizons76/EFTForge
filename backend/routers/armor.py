"""Armor catalog and the data the browser's ballistics engine runs on.

The armor simulator, caliber comparison and drop table all run in the browser
(frontend/modules/ballistics-engine.js), so every route here only reads data.
"""

import functools
import json
import os

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

import ammo_chart
import ballistics
from models_armor import ArmorDefaultInsert, ArmorPiece, ArmorPlateSlot
from models_items import Item
from models_slot_allowed import SlotAllowedItem
from models_slots import Slot
from routers.shared import get_db, item_name, item_short_name

router = APIRouter()

# The game checks armor slot by slot in this order: Headwear, FaceCover, Eyewear,
# TacticalVest, ArmorVest. We place an equipped item by its tarkov.dev category, and
# glasses (which carry no equipment category) by their armor kind.
_HEADWEAR = "5a341c4086f77401f2541505"
_FACE_COVER = "5a341c4686f77469e155819e"
_CHEST_RIG = "5448e5284bdc2dcb718b4567"
_ARMOR_VEST = "5448e54d4bdc2dcc718b4568"
_EQUIPMENT_SLOT_NAMES = ("headwear", "face_cover", "eyewear", "rig", "armor")
_CATEGORY_RANK = {_HEADWEAR: 0, _FACE_COVER: 1, _CHEST_RIG: 3, _ARMOR_VEST: 4}
_EYEWEAR_RANK = 2


def _equipment_rank(item):
    if item.armor_kind == "eyewear":
        return _EYEWEAR_RANK
    ranks = [_CATEGORY_RANK[c] for c in (item.category_ids or "").split(",") if c in _CATEGORY_RANK]
    return min(ranks) if ranks else None


def _equipment_slot_name(item):
    rank = _equipment_rank(item)
    return None if rank is None or item.armor_kind == "attachment" else _EQUIPMENT_SLOT_NAMES[rank]


def _split(text):
    return [part for part in (text or "").split(",") if part]


def _attachment_slots(db, holder_ids):
    """{holder id: [(slot name, set of armor attachment ids it takes)]}, slots without armor left out."""
    rows = (
        db.query(Slot.parent_item_id, Slot.slot_game_name, SlotAllowedItem.allowed_item_id)
        .join(SlotAllowedItem, SlotAllowedItem.slot_id == Slot.id)
        .join(Item, Item.id == SlotAllowedItem.allowed_item_id)
        .filter(Slot.parent_item_id.in_(list(holder_ids)), Item.armor_kind == "attachment")
        .order_by(Slot.parent_item_id, Slot.slot_game_name)
    )
    slots = {}
    for holder_id, slot_name, item_id in rows:
        by_name = slots.setdefault(holder_id, {})
        by_name.setdefault(slot_name, set()).add(item_id)
    return {holder_id: list(by_name.items()) for holder_id, by_name in slots.items()}


@functools.cache
def _armor_globals():
    return ballistics.load_armor_globals()


@functools.cache
def _colliders():
    return ballistics.load_player_colliders()


@router.get("/armor/items")
def armor_items(lang: str = "en", db: Session = Depends(get_db)):
    """Every armor item with its own armor pieces and the plate slots it offers."""
    destructibility = _armor_globals().destructibility
    pieces_by_holder, slots_by_holder = {}, {}
    for piece in db.query(ArmorPiece).order_by(ArmorPiece.id):
        pieces_by_holder.setdefault(piece.holder_item_id, []).append(
            {
                "slot": piece.slot_name_id,
                "name": piece.name_zh if lang == "zh" and piece.name_zh else piece.name,
                "armor_class": piece.armor_class,
                "durability": piece.durability,
                # Durability over the material's destructibility: how much raw armor damage it
                # soaks, the fair way to compare wear across materials
                "effective_durability": (
                    piece.durability / destructibility[piece.material] if destructibility.get(piece.material) else None
                ),
                "material": piece.material,
                "armor_type": piece.armor_type,
                "ricochet": [piece.ricochet_x, piece.ricochet_y, piece.ricochet_z],
                "blunt_throughput": piece.blunt_throughput,
                "body_colliders": _split(piece.body_colliders),
                "plate_colliders": _split(piece.plate_colliders),
            }
        )
    defaults = {}
    for insert in db.query(ArmorDefaultInsert):
        defaults[(insert.holder_item_id, insert.slot_name_id)] = insert.item_id
    for slot in db.query(ArmorPlateSlot).order_by(ArmorPlateSlot.id):
        slots_by_holder.setdefault(slot.holder_item_id, []).append(
            {
                "slot": slot.slot_name_id,
                "plate_colliders": _split(slot.plate_colliders),
                "allowed_plate_ids": _split(slot.allowed_plate_ids),
                "blunt_reduce_from_soft_armor": bool(slot.blunt_reduce_from_soft_armor),
                # The plate the item comes with, from its default preset
                "default_id": defaults.get((slot.holder_item_id, slot.slot_name_id)),
            }
        )
    items = db.query(Item).filter(Item.armor_kind.isnot(None)).order_by(Item.name).all()
    armor_ids = {item.id for item in items}
    # Helmet attachments can hold more of them (a FAST side armor takes the gunsight mandible)
    holder_ids = [item.id for item in items if item.armor_kind in ("helmet", "attachment")]
    attachment_slots = _attachment_slots(db, holder_ids)
    return [
        {
            "id": item.id,
            "name": item_name(item, lang),
            "short_name": item_short_name(item, lang),
            "icon_link": item.icon_link,
            # The full size inventory image, for the loadout slots
            "image_link": item.base_image_link or item.icon_link,
            "background_color": item.background_color,
            "kind": item.armor_kind,
            # Which equipment slot it's worn in, or None for plates and helmet attachments
            "equipment_slot": _equipment_slot_name(item),
            "weight": item.weight,
            "speed_penalty": item.speed_penalty,
            "turn_penalty": item.turn_penalty,
            "ergo_penalty": item.ergo_penalty,
            "trader_price_rub": item.trader_price_rub,
            # Who sells it and from which loyalty level, for the item table's price cell
            "trader_vendor": item.trader_vendor,
            "trader_min_level": item.trader_min_level,
            "pieces": pieces_by_holder.get(item.id, []),
            "plate_slots": slots_by_holder.get(item.id, []),
            # A helmet's or attachment's slots that take attachments, in the game's slot order,
            # with what it comes with
            "attachment_slots": [
                {"slot": name, "allowed_ids": sorted(allowed), "default_id": defaults.get((item.id, name))}
                for name, allowed in attachment_slots.get(item.id, [])
            ],
            # Other armor this can't be worn with (both sides list a conflict only sometimes)
            "conflicting_ids": [other for other in _split(item.conflicting_item_ids) if other in armor_ids],
            "blocks_headwear": bool(item.blocks_headwear),
            "blocks_eyewear": bool(item.blocks_eyewear),
        }
        for item in items
    ]


_chart_cache = {"stamp": None, "chart": None}


@router.get("/armor/chart")
def armor_chart():
    """The precomputed ammo effectiveness chart (see ammo_chart.py): shots to kill for every
    round against every armor setup, in the standard point blank, straight on scenario."""
    path = ammo_chart.chart_path()
    if path is None:
        raise HTTPException(status_code=404, detail="No ammo chart has been worked out yet")
    stamp = (path, os.path.getmtime(path))
    if _chart_cache["stamp"] != stamp:
        _chart_cache["chart"] = ammo_chart.load_chart()
        _chart_cache["stamp"] = stamp
    chart = _chart_cache["chart"]
    return {key: value for key, value in chart.items() if key != "ammo"} | {
        "ammo": [{"id": row["id"], "caliber": row["caliber"]} for row in chart["ammo"]]
    }


@functools.cache
def _constants():
    with open(os.path.join(os.path.dirname(ballistics.__file__), "spt_armor_stats.json"), encoding="utf-8") as f:
        data = json.load(f)
    return {"globals": data["globals"], "colliders": data["colliders"]}


@router.get("/armor/constants")
def armor_constants():
    """The game constants the ballistics engine runs on (spt_armor_stats.json), for the copy of
    the engine that runs in the browser (frontend/modules/ballistics-engine.js)."""
    return _constants()


@router.get("/armor/zones")
def armor_zones():
    """Which body part each collider drains, and which body collider each plate zone covers."""
    colliders = _colliders()
    return {
        "body_parts": colliders["body_parts"],
        "max_hp": {part: values["max"] for part, values in _armor_globals().health["parts"].items()},
        "plates": {
            zone: {"collider": v["collider"], "body_part": v["body_part"]} for zone, v in colliders["plates"].items()
        },
    }
