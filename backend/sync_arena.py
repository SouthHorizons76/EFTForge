"""Builds Arena's item database (database_arena.py) from Arena's game data snapshot.

Arena has its own item stats, and rules the main game doesn't: every item costs meta
points, each preset class may only carry some of them, and a class's preset has to land
inside its meta score limits. tarkov.dev carries none of that, so Arena mode runs on the
snapshot alone (game_snapshot.py), and only exists where ARENA_SNAPSHOT_PATH is set.

The database holds Arena's armory: every item a custom preset can hold. Stats, slots,
conflicts, presets and armor all come from the snapshot. From tarkov.db we only borrow
what the game data has no word on (image links, our category labels), for the items both
know.

On top of game_snapshot.py's format the snapshot carries:

    "arena": {
      "classes":    [{"_id", "name"}],          the preset types
      "boundaries": [{"PresetClass", "MetascoreMin", "MetascoreMax", ...}],
      "presets":    [{"id", "name", "typeId", "inventory": {"items": [...]}}],
      "armory":     [{"id", "templateId", "handbookCategoryId", "isUnlockedByDefault",
                      "excludedMods", "excludedAmmo"}],
      "blast_gang": {                             BlastGang's shop, optional
        "slots":   {"<type>": count},             how many of each kind a shop holds
        "items":   [{"id", "type", "templateId", "nodeTemplateId", "prices", "settings",
                     "excludedMods", "isStarterLot", "isSlotAvailable", ...}],
        "presets": {"<templateId>": {"_items": [...]}}   what each item is sold as
      }
    }

Run by services/arena.py whenever the snapshot changes, or by hand: python sync_arena.py
"""

from __future__ import annotations

import json
import logging

from sqlalchemy import inspect, text

from config import ARENA_SNAPSHOT_PATH
from database import Base, engine
from database_arena import ArenaBase, ArenaSessionLocal, arena_engine
from game_snapshot import AMMO, WEAPON, GameData, SnapshotError, file_stamp, load_snapshot, pick_snapshot_file
from models_arena import ArenaItem, ArenaSetting
from models_armor import ArmorDefaultInsert, ArmorPiece, ArmorPlateSlot, BotHealth
from models_item_offers import ItemOffer
from models_items import Item
from models_slot_allowed import SlotAllowedItem
from models_slots import Slot
from models_traders import Trader
from models_weapon_presets import WeaponDefaultPreset

logger = logging.getLogger(__name__)

ASSET_BASE = "https://assets.tarkov.dev"

# The game's EArenaPresetClass name of each preset type a player can build for. The
# boundaries are keyed by that name and the items by the type's id, and the data never
# says which is which.
CLASS_KEY_BY_ID = {
    "632f8229f6541cacd808452c": "Assault",
    "632f7afadcb4c7c2c209ba8f": "CQB",
    "632f8dadbe00240c170aab18": "Recon",
    "632f8e11f6541cacd808452e": "Marksman",
}
# The locale names Recon "Scout"
_CLASS_LOCALE_KEY = {"Recon": "Scout"}
CLASS_ORDER = ["Assault", "CQB", "Recon", "Marksman"]

# BlastGang's shop: the preset its two sides start every match with
BLAST_GANG_MODE = "BlastGang"
BLAST_GANG_KITS = {"BGAttack": "attack", "BGDefense": "defense"}
# The rounds in a weapon, which the shop counts apart from the weapon's build
_LOADED_AMMO_SLOTS = ("cartridges", "patron_in_weapon")

# Bumped whenever this file builds the database differently, so a deploy rebuilds it from the
# snapshot it already has instead of waiting for new game data
BUILD_VERSION = 2

# tarkov.dev's placeholder for an item it has no picture of; a weapon showing it is drawn by
# Kitbash! (routers/guns.py), as in the main game's builder
UNKNOWN_IMAGE_512 = f"{ASSET_BASE}/unknown-item-512.webp"

# The class of the armor sections built into a vest or helmet
BUILT_IN_INSERTS = "BuiltInInserts"

# What we keep of tarkov.db's row for an item both databases know
_BORROWED_COLUMNS = (
    "image_512_link",
    "bare_image_512_link",
    "icon_link",
    "base_image_link",
    "preset_icon_link",
    "weapon_category",
    "attachment_category",
    "attachment_category_zh",
)

# The gear slot an item of a class goes in, nearest class first
_GEAR_SLOT_BY_NODE = {
    "Headwear": "Headwear",
    "FaceCover": "FaceCover",
    "Visors": "Eyewear",
    "Headphones": "Earpiece",
    "Armor": "ArmorVest",
    "Vest": "TacticalVest",
    "Knife": "Scabbard",
    "Pistol": "Holster",
    "Revolver": "Holster",
}
_CARRY_KIND_BY_NODE = {
    "Magazine": "magazine",
    "Ammo": "ammo",
    "Meds": "medical",
    "ThrowWeap": "grenade",
}
# The slots of the game's inventory a preset fills, and the pockets every preset has
PRESET_SLOTS = (
    "FirstPrimaryWeapon",
    "SecondPrimaryWeapon",
    "Holster",
    "Scabbard",
    "Headwear",
    "Earpiece",
    "FaceCover",
    "Eyewear",
    "ArmorVest",
    "TacticalVest",
    "Pockets",
)


def _asset(item_id: str, kind: str) -> str:
    return f"{ASSET_BASE}/{item_id}-{kind}.webp"


def _main_rows() -> dict:
    """tarkov.db's item rows by id, or nothing when it hasn't been synced yet."""
    try:
        if not inspect(engine).has_table("items"):
            return {}
        with engine.connect() as conn:
            return {row["id"]: dict(row) for row in conn.execute(text("SELECT * FROM items")).mappings()}
    except Exception as exc:  # a missing or locked tarkov.db only costs us the borrowed columns
        logger.warning("Arena sync: tarkov.db unreadable, building without it: %s", exc)
        return {}


def _copy_table(db, model) -> int:
    """Copy one of tarkov.db's tables as it is (traders, bot health)."""
    table = model.__table__
    try:
        if not inspect(engine).has_table(table.name):
            return 0
        with engine.connect() as conn:
            rows = [dict(row) for row in conn.execute(table.select()).mappings()]
    except Exception as exc:
        logger.warning("Arena sync: could not copy %s: %s", table.name, exc)
        return 0
    if rows:
        db.execute(table.insert(), rows)
    return len(rows)


def _gear_slot(data: GameData, item_id: str):
    nodes = data.nodes(item_id)
    for node in nodes:
        if node in _GEAR_SLOT_BY_NODE:
            return _GEAR_SLOT_BY_NODE[node]
    # Every other weapon is carried on the sling or the back
    return "Primary" if WEAPON in nodes else None


def _carry_kind(data: GameData, item_id: str):
    for node in data.nodes(item_id):
        if node in _CARRY_KIND_BY_NODE:
            return _CARRY_KIND_BY_NODE[node]
    return None


def _grids(props: dict):
    out = []
    for grid in props.get("Grids") or []:
        grid_props = grid.get("_props") if isinstance(grid, dict) else None
        if isinstance(grid_props, dict) and grid_props.get("cellsH") and grid_props.get("cellsV"):
            out.append([grid_props["cellsH"], grid_props["cellsV"]])
    return out


def _item_row(data: GameData, item_id: str, borrowed: dict | None, columns: list) -> dict:
    row = dict.fromkeys(columns)
    nodes = data.nodes(item_id)
    props = data.props(item_id)
    if borrowed:
        for column in _BORROWED_COLUMNS:
            row[column] = borrowed.get(column)
        for column in ("name", "short_name", "name_zh", "short_name_zh"):
            row[column] = borrowed.get(column)
    is_weapon = WEAPON in nodes
    row.update(
        id=item_id,
        name=data.name(item_id) or row["name"] or data.entries[item_id].get("_name") or item_id,
        short_name=data.name(item_id, short=True) or row["short_name"],
        name_zh=data.name(item_id, "zh") or row["name_zh"],
        short_name_zh=data.name(item_id, "zh", short=True) or row["short_name_zh"],
        # What the tarkov.dev sync writes for an item with no say in these
        ergonomics_modifier=0,
        recoil_modifier=0,
        base_ergonomics=0,
        is_weapon=is_weapon,
        is_ammo=AMMO in nodes,
        background_color=props.get("BackgroundColor"),
        category_ids=",".join(data.category_ids(item_id)) or None,
        armor_kind=data.armor_kind(item_id),
    )
    row.update(data.item_columns(item_id))
    item_conflicts, slot_conflicts = data.conflicts(item_id)
    row["conflicting_item_ids"] = ",".join(item_conflicts) or None
    row["conflicting_slot_ids"] = ",".join(slot_conflicts) or None
    row["icon_link"] = row["icon_link"] or _asset(item_id, "icon")
    row["base_image_link"] = row["base_image_link"] or _asset(item_id, "base-image")
    if is_weapon:
        row["weapon_category"] = row["weapon_category"] or data.weapon_category(item_id)
        row["weapon_skill"] = data.weapon_skill(item_id)
        # Only the main game's weapons have tarkov.dev pictures: an Arena only one gets the
        # placeholder, which sends it to Kitbash!
        if not borrowed:
            row["bare_image_512_link"] = UNKNOWN_IMAGE_512
            row["image_512_link"] = UNKNOWN_IMAGE_512
        row["bare_image_512_link"] = row["bare_image_512_link"] or _asset(item_id, "512")
        row["image_512_link"] = row["image_512_link"] or row["bare_image_512_link"]
    if not row["attachment_category"]:
        # The item's own class, named by the game where it has a name for it
        row["attachment_category"] = data.en.get(f"{data.chain(item_id)[1]} Name") or (nodes[0] if nodes else None)
        row["attachment_category_zh"] = data.zh.get(f"{data.chain(item_id)[1]} Name")
    return row


def _factory_parts(parts: list, base_id: str, known: set) -> list:
    """A default preset's part ids, base first, dropping what Arena's armory lacks along
    with everything mounted on it."""
    kept = [base_id]
    dropped = set()
    for part in parts:
        tpl = part["tpl"]
        if tpl == base_id and part["parent_tpl"] is None:
            continue
        if tpl not in known or part["parent_tpl"] in dropped:
            dropped.add(tpl)
            continue
        kept.append(tpl)
    return kept


def _preset_tree(preset: dict, known: set) -> list:
    """A stock preset's gear as [{"slot", "id", "count", "children": [...]}], from the
    game's flat inventory list. Only what sits under the character's own slots counts:
    the stash and the like are dropped."""
    items = [x for x in (preset.get("inventory") or {}).get("items") or [] if isinstance(x, dict)]
    children: dict = {}
    for entry in items:
        children.setdefault(entry.get("parentId"), []).append(entry)

    def node(entry: dict):
        count = ((entry.get("upd") or {}).get("StackObjectsCount")) or 1
        return {
            "slot": entry.get("slotId"),
            "id": entry.get("_tpl"),
            "count": count,
            "children": [node(child) for child in children.get(entry.get("_id"), []) if child.get("_tpl") in known],
        }

    out = []
    for root in children.get(None, []):
        for entry in children.get(root.get("_id"), []):
            if entry.get("slotId") not in PRESET_SLOTS:
                continue
            if entry.get("slotId") == "Pockets":
                # The pockets themselves are no armory item: keep what is in them
                out.append({"slot": "Pockets", "id": None, "count": 1, "children": node(entry)["children"]})
            elif entry.get("_tpl") in known:
                out.append(node(entry))
    return out


def _classes(data: GameData, arena: dict) -> list:
    boundaries = {b.get("PresetClass"): b for b in arena.get("boundaries") or [] if isinstance(b, dict)}
    listed = {c.get("_id") for c in arena.get("classes") or [] if isinstance(c, dict)}
    out = []
    for class_id, key in CLASS_KEY_BY_ID.items():
        if class_id not in listed:
            continue
        bounds = boundaries.get(key) or {}
        locale_key = f"EArenaPresetClass/{_CLASS_LOCALE_KEY.get(key, key)}"
        out.append(
            {
                "id": class_id,
                "key": key,
                "name": data.en.get(locale_key) or key,
                "name_zh": data.zh.get(locale_key),
                "meta_min": bounds.get("MetascoreMin"),
                "meta_max": bounds.get("MetascoreMax"),
            }
        )
    out.sort(key=lambda c: CLASS_ORDER.index(c["key"]))
    return out


def _blast_gang(data: GameData, arena: dict, known: set) -> dict | None:
    """BlastGang's shop, the way the game's Shop settings screen offers it: every item a
    shop slot can take, by type, with its price on each side; a weapon's build (as the
    builder's slot pairs) with the meta point range a build of it has to stay in."""
    shop = arena.get("blast_gang")
    if not isinstance(shop, dict) or not isinstance(shop.get("items"), list):
        return None
    presets = shop.get("presets") or {}
    items = []
    for entry in shop["items"]:
        if not isinstance(entry, dict):
            continue
        item_id = entry.get("nodeTemplateId")
        if item_id not in known:
            continue
        settings = entry.get("settings") or {}
        prices = entry.get("prices") or {}
        preset = presets.get(entry.get("templateId")) or {}
        parts = [p for p in preset.get("_items") or [] if isinstance(p, dict)]
        by_id = {p.get("_id"): p for p in parts}
        children: dict = {}
        for part in parts:
            children.setdefault(part.get("parentId"), []).append(part)
        root = by_id.get(preset.get("_parent")) or next((p for p in parts if p.get("_tpl") == item_id), None)

        # A weapon's parts as [slot id, item id] pairs, parent before child, the way a
        # build code carries them; armor's plates and attachments as [slot name, item id]
        pairs, inserts = [], []

        def walk(node: dict, parent_tpl: str) -> None:
            slots = {s["name_id"]: s["id"] for s in data.slots(parent_tpl)}
            for child in children.get(node.get("_id"), []):
                tpl, slot_name = child.get("_tpl"), child.get("slotId")
                if slot_name in _LOADED_AMMO_SLOTS or tpl not in known:
                    continue
                if slot_name in slots:
                    pairs.append([slots[slot_name], tpl])
                    walk(child, tpl)
                elif node is root:
                    inserts.append([slot_name, tpl])

        if root:
            walk(root, item_id)
        meta = sum(float(data.props(p.get("_tpl")).get("ArenaMetapoints") or 0) for p in parts) if parts else None
        items.append(
            {
                "id": entry.get("id"),
                "key": entry.get("systemName"),
                "type": entry.get("type"),
                "item_id": item_id,
                # 0 means the side can't buy it
                "price_attack": prices.get("fighter") or 0,
                "price_defense": prices.get("defence") or 0,
                "starter_lot": bool(entry.get("isStarterLot")),
                "starter_weapon": bool(settings.get("isStarter")),
                "slot_available": entry.get("isSlotAvailable") is not False,
                "unlock": bool(entry.get("requiresArmoryUnlock")),
                "meta_points": meta,
                "meta_min": settings.get("metaScoreMin"),
                "meta_max": settings.get("metaScoreMax"),
                "ammo_id": settings.get("ammoTemplateId") if settings.get("ammoTemplateId") in known else None,
                # Named here: some of the shop's rounds aren't armory items
                "ammo_name": (
                    data.name(settings.get("ammoTemplateId"), short=True) if settings.get("ammoTemplateId") else None
                ),
                "ammo_name_zh": (
                    data.name(settings.get("ammoTemplateId"), "zh", short=True)
                    if settings.get("ammoTemplateId")
                    else None
                ),
                "spare_ammo": settings.get("additionalAmmoAmount"),
                "is_magazine": settings.get("isMagazine"),
                "kill_bonus": settings.get("killBonus"),
                "round_limit": settings.get("playerRoundLimit"),
                "team_round_limit": settings.get("teamRoundLimit"),
                "excluded_mods": [i for i in entry.get("excludedMods") or [] if i in known],
                "pairs": pairs,
                "inserts": inserts,
            }
        )
    kits = {}
    for preset in arena.get("presets") or []:
        if (
            isinstance(preset, dict)
            and preset.get("gameMode") == BLAST_GANG_MODE
            and preset.get("name") in BLAST_GANG_KITS
        ):
            kits[BLAST_GANG_KITS[preset["name"]]] = _preset_tree(preset, known)
    slots = {k: v for k, v in (shop.get("slots") or {}).items() if isinstance(v, int)}
    return {"slots": slots, "items": items, "kits": kits}


def _built_in_points(data: GameData, holders: set, built_in: set) -> dict:
    """{holder id: the meta points of the armor sections built into it}."""
    out = {}
    for holder_id in holders:
        total = 0.0
        for slot in data.props(holder_id).get("Slots") or []:
            slot_filter = data._slot_filter(slot) if isinstance(slot, dict) else {}
            insert_id = slot_filter.get("Plate")
            if slot_filter.get("locked") and insert_id in built_in:
                total += float(data.props(insert_id).get("ArenaMetapoints") or 0)
        if total:
            out[holder_id] = total
    return out


def _exclusions(entries, template_by_entry: dict) -> str | None:
    """{class id: [item ids]} from the armory's per class lists, which name armory entries."""
    out = {}
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        items = [template_by_entry[i] for i in entry.get("items") or [] if i in template_by_entry]
        if items:
            out[entry.get("presetClassId")] = items
    return json.dumps(out) if out else None


def build_arena_db(snapshot: dict, stamp: str = "") -> dict:
    """Rebuild the Arena database from `snapshot` in one transaction. Readers keep seeing
    the previous data until it commits."""
    arena = snapshot.get("arena")
    if not isinstance(arena, dict) or not isinstance(arena.get("armory"), list):
        raise SnapshotError("the snapshot has no Arena armory")
    data = GameData(snapshot)

    # Imported here: db_migrations pulls in every other database too
    from db_migrations import sync_model_columns

    # Every row is rewritten below, so a model's new column only has to exist
    for metadata in (Base.metadata, ArenaBase.metadata):
        metadata.create_all(bind=arena_engine)
        sync_model_columns(arena_engine, metadata)

    armory = [e for e in arena["armory"] if isinstance(e, dict) and e.get("templateId") in data.entries]
    template_by_entry = {e.get("id"): e["templateId"] for e in armory}
    item_set = set(data.item_ids)
    # A built-in armor section (a vest's soft armor, a helmet's shell) is an armory item in
    # the game, but never one a player picks: it comes with its holder. We keep it out of
    # the item tables, as tarkov.dev does, and count its meta points into the holder's.
    built_in = {i for i in item_set if data.is_a(i, BUILT_IN_INSERTS)}
    known = {e["templateId"] for e in armory if e["templateId"] in item_set} - built_in
    built_in_points = _built_in_points(data, known, built_in)
    main_rows = _main_rows()
    columns = [c.name for c in Item.__table__.columns]

    db = ArenaSessionLocal()
    try:
        for model in (
            SlotAllowedItem,
            ArmorPiece,
            ArmorPlateSlot,
            ArmorDefaultInsert,
            ItemOffer,
            WeaponDefaultPreset,
            Slot,
            Item,
            Trader,
            BotHealth,
            ArenaItem,
            ArenaSetting,
        ):
            db.query(model).delete()

        rows = {item_id: _item_row(data, item_id, main_rows.get(item_id), columns) for item_id in known}

        # Slots, and what Arena lets into each
        slot_rows, allowed_rows = [], []
        for item_id in known:
            for slot in data.slots(item_id):
                slot_rows.append(
                    {
                        "id": slot["id"],
                        "parent_item_id": item_id,
                        "slot_name": slot["name"],
                        "slot_game_name": slot["name_id"],
                        "required": slot["required"],
                    }
                )
                allowed_rows += [
                    {"slot_id": slot["id"], "allowed_item_id": allowed}
                    for allowed in dict.fromkeys(slot["allowed"])
                    if allowed in known
                ]

        # Factory presets, simulated the way the tarkov.dev sync does
        preset_rows = []
        for base_id, (preset_id, parts) in data.default_presets().items():
            if base_id not in known or not rows[base_id]["is_weapon"]:
                continue
            row = rows[base_id]
            part_ids = _factory_parts(parts, base_id, known)
            row["factory_attachment_ids"] = ",".join(part_ids)
            preset_rows.append({"weapon_id": base_id, "preset_id": preset_id})
            borrowed = main_rows.get(base_id)
            if borrowed and not borrowed.get("image_512_link"):
                row["image_512_link"] = _asset(preset_id, "512")
                row["preset_icon_link"] = _asset(preset_id, "icon")
            # The same weapon built differently in Arena (the M16A2 is Arena's Mk 12 SPR): the
            # main game's picture shows another gun, so Kitbash! draws Arena's preset
            if borrowed and set(filter(None, (borrowed.get("factory_attachment_ids") or "").split(","))) != set(
                part_ids
            ):
                row["image_512_link"] = UNKNOWN_IMAGE_512
            weight = row["weight"] or 0
            ergonomics = row["base_ergonomics"] or 0
            recoil = 0.0
            for part_id in part_ids[1:]:
                part = rows[part_id]
                weight += part["weight"] or 0
                ergonomics += part["ergonomics_modifier"] or 0
                recoil += part["recoil_modifier"] or 0
            row["factory_weight"] = weight
            row["factory_ergonomics"] = ergonomics
            if row["recoil_vertical"] is not None:
                row["factory_recoil_vertical"] = round(row["recoil_vertical"] * (1 + recoil))
            if row["recoil_horizontal"] is not None:
                row["factory_recoil_horizontal"] = round(row["recoil_horizontal"] * (1 + recoil))
        for row in rows.values():
            if row["is_weapon"] and not row["factory_attachment_ids"]:
                row["factory_attachment_ids"] = row["id"]

        db.execute(Item.__table__.insert(), list(rows.values()))
        if slot_rows:
            db.execute(Slot.__table__.insert(), slot_rows)
        if allowed_rows:
            db.execute(SlotAllowedItem.__table__.insert(), allowed_rows)
        if preset_rows:
            db.execute(WeaponDefaultPreset.__table__.insert(), preset_rows)

        pieces, plate_slots, defaults = data.armor_rows()
        pieces = [p for p in pieces if p["holder_item_id"] in known]
        plate_slots = [p for p in plate_slots if p["holder_item_id"] in known]
        for plate_slot in plate_slots:
            allowed = [i for i in (plate_slot["allowed_plate_ids"] or "").split(",") if i in known]
            plate_slot["allowed_plate_ids"] = ",".join(allowed) or None
        defaults = [d for d in defaults if d["holder_item_id"] in known and d["item_id"] in known]
        if pieces:
            db.execute(ArmorPiece.__table__.insert(), pieces)
        if plate_slots:
            db.execute(ArmorPlateSlot.__table__.insert(), plate_slots)
        if defaults:
            db.execute(ArmorDefaultInsert.__table__.insert(), defaults)

        _copy_table(db, Trader)
        _copy_table(db, BotHealth)

        arena_rows = []
        for entry in armory:
            item_id = entry["templateId"]
            if item_id not in known:
                continue
            props = data.props(item_id)
            category_id = entry.get("handbookCategoryId")
            grids = _grids(props)
            arena_rows.append(
                {
                    "item_id": item_id,
                    "meta_points": float(props.get("ArenaMetapoints") or 0) + built_in_points.get(item_id, 0.0),
                    "meta_group": props.get("MetascoreGroup") if isinstance(props.get("MetascoreGroup"), str) else None,
                    "class_ids": ",".join(props.get("ArenaClassAvailability") or []) or None,
                    "gear_slot": _gear_slot(data, item_id),
                    "carry_kind": _carry_kind(data, item_id),
                    "category_id": category_id,
                    "category": data.en.get(category_id) or None,
                    "category_zh": data.zh.get(category_id) or None,
                    "unlocked_by_default": bool(entry.get("isUnlockedByDefault")),
                    "excluded_mods": _exclusions(entry.get("excludedMods"), template_by_entry),
                    "excluded_ammo": _exclusions(entry.get("excludedAmmo"), template_by_entry),
                    "width": props.get("Width"),
                    "height": props.get("Height"),
                    "grids": json.dumps(grids) if grids else None,
                }
            )
        db.execute(ArenaItem.__table__.insert(), arena_rows)

        classes = _classes(data, arena)
        class_ids = {c["id"] for c in classes}
        presets = [
            {
                "id": preset.get("id"),
                "name": preset.get("name"),
                "class_id": preset.get("typeId"),
                "gear": _preset_tree(preset, known),
            }
            for preset in arena.get("presets") or []
            if isinstance(preset, dict) and preset.get("typeId") in class_ids
        ]
        presets.sort(key=lambda p: str(p["name"]))
        blast_gang = _blast_gang(data, arena, known)
        settings = {
            "classes": classes,
            "presets": presets,
            "blast_gang": blast_gang,
            "snapshot": {
                "id": snapshot.get("id"),
                "version": snapshot.get("version"),
                "detected": snapshot.get("detected"),
                "stamp": stamp,
            },
        }
        db.execute(ArenaSetting.__table__.insert(), [{"key": k, "value": json.dumps(v)} for k, v in settings.items()])
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    summary = {
        "items": len(rows),
        "weapons": sum(1 for r in rows.values() if r["is_weapon"]),
        "slots": len(slot_rows),
        "classes": len(classes),
        "presets": len(presets),
        "blast_gang_items": len(blast_gang["items"]) if blast_gang else 0,
        "version": snapshot.get("version"),
    }
    logger.info("Arena database built: %s", summary)
    return summary


def built_stamp() -> str | None:
    """The stamp of the snapshot the Arena database was last built from, or None."""
    try:
        if not inspect(arena_engine).has_table(ArenaSetting.__tablename__):
            return None
        with arena_engine.connect() as conn:
            value = conn.execute(text("SELECT value FROM arena_settings WHERE key = 'snapshot'")).scalar()
        return (json.loads(value) or {}).get("stamp") if value else None
    except Exception:
        return None


def sync_arena(force: bool = False) -> dict | None:
    """Build the Arena database when its snapshot has changed. Returns the build's summary,
    or None when there was nothing to do."""
    file_path = pick_snapshot_file(ARENA_SNAPSHOT_PATH)
    if not file_path:
        return None
    stamp = f"{file_stamp(file_path)}|build{BUILD_VERSION}"
    if not force and built_stamp() == stamp:
        return None
    return build_arena_db(load_snapshot(file_path), stamp)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not ARENA_SNAPSHOT_PATH:
        raise SystemExit("ARENA_SNAPSHOT_PATH is not set")
    print(sync_arena(force=True) or "no snapshot to read")
