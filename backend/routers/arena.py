"""Arena mode: the preset classes with their meta score limits, the stock presets, and
the gear a preset is built from.

Arena's item data lives in its own database (database_arena.py), built from Arena's game
data snapshot. The item routes the builder already uses read it when asked with
?game=arena (routers/shared.py get_game_db); these are the routes only Arena has. Without
a snapshot they answer 503 and the frontend never shows the mode."""

import json

from typing import List

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

from database_arena import ArenaSessionLocal
from models_arena import ArenaItem
from models_items import Item
from routers.shared import MAX_INSTALLED_IDS, cap_list, item_name, item_short_name
from services import arena

router = APIRouter()

# The pockets every Arena preset has: four single cells
POCKET_GRIDS = [[1, 1], [1, 1], [1, 1], [1, 1]]


def get_arena_db():
    if not arena.available():
        raise HTTPException(status_code=503, detail="arena_unavailable")
    db = ArenaSessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/arena/config")
def arena_config(lang: str = "en", db: Session = Depends(get_arena_db)):
    """The classes a preset can be built for, each with the meta score its preset has to
    land in, and the game's own stock presets to start from."""
    classes = [
        {
            "id": c["id"],
            "key": c["key"],
            "name": c["name_zh"] if lang == "zh" and c.get("name_zh") else c["name"],
            "meta_min": c["meta_min"],
            "meta_max": c["meta_max"],
        }
        for c in arena.setting(db, "classes", [])
    ]
    return {
        "classes": classes,
        "presets": arena.setting(db, "presets", []),
        "pocket_grids": POCKET_GRIDS,
        "snapshot": {k: v for k, v in (arena.setting(db, "snapshot", {}) or {}).items() if k != "stamp"},
    }


@router.get("/arena/items")
def arena_items(lang: str = "en", db: Session = Depends(get_arena_db)):
    """Everything a preset wears or carries that isn't a weapon part: gear by the slot it
    goes in, and the magazines, ammo, medical items and grenades a rig and pockets hold.
    Weapons come from /guns and armor's details from /armor/items, both with ?game=arena."""
    rows = (
        db.query(Item, ArenaItem)
        .join(ArenaItem, ArenaItem.item_id == Item.id)
        .filter((ArenaItem.gear_slot.isnot(None)) | (ArenaItem.carry_kind.isnot(None)))
        .order_by(Item.name)
        .all()
    )
    return [
        {
            "id": item.id,
            "name": item_name(item, lang),
            "short_name": item_short_name(item, lang),
            "icon_link": item.icon_link,
            "image_link": item.base_image_link or item.icon_link,
            "background_color": item.background_color,
            "weight": item.weight,
            "gear_slot": extra.gear_slot,
            "carry_kind": extra.carry_kind,
            "category": extra.category_zh if lang == "zh" and extra.category_zh else extra.category,
            "is_weapon": bool(item.is_weapon),
            "weapon_category": item.weapon_category,
            "caliber": item.caliber,
            "magazine_capacity": item.magazine_capacity,
            "stack_max_size": item.stack_max_size,
            "damage": item.ammo_damage,
            "penetration_power": item.penetration_power,
            "armor_kind": item.armor_kind,
            "width": extra.width,
            "height": extra.height,
            # The cells a rig offers, as [[columns, rows], ...]
            "grids": json.loads(extra.grids) if extra.grids else [],
            "unlocked_by_default": bool(extra.unlocked_by_default),
            **arena.item_fields(extra),
        }
        for item, extra in rows
    ]


@router.post("/arena/points")
def arena_points(
    item_ids: List[str] = Body(...),
    lang: str = Body(default="en"),
    db: Session = Depends(get_arena_db),
):
    """What a loadout needs to count any items: their meta points, the classes that may
    carry them, and for magazines how many rounds they hold. Unknown ids are left out."""
    cap_list("item_ids", item_ids, MAX_INSTALLED_IDS)
    ids = list(dict.fromkeys(item_ids))
    if not ids:
        return {}
    rows = db.query(Item, ArenaItem).join(ArenaItem, ArenaItem.item_id == Item.id).filter(Item.id.in_(ids)).all()
    return {
        item.id: {
            "id": item.id,
            "name": item_name(item, lang),
            "short_name": item_short_name(item, lang),
            "icon_link": item.icon_link,
            "magazine_capacity": item.magazine_capacity,
            "caliber": item.caliber,
            "is_ammo": bool(item.is_ammo),
            **arena.item_fields(extra),
        }
        for item, extra in rows
    }
