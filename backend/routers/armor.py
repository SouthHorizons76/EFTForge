"""Armor catalog and the armor ballistics simulation."""

import dataclasses
import functools
import json
import os
import time
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

import ammo_chart
import ballistics
from models_armor import ArmorDefaultInsert, ArmorPiece, ArmorPlateSlot
from models_items import Item
from models_slot_allowed import SlotAllowedItem
from models_slots import Slot
from routers.shared import get_client_ip, get_db, item_name, item_short_name, validate_item_id
from services.solve_limits import check_solve_rate_limit

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


BodyCollider = Literal[
    "HeadCommon",
    "ParietalHead",
    "BackHead",
    "Ears",
    "Eyes",
    "Jaw",
    "NeckFront",
    "NeckBack",
    "RibcageUp",
    "RibcageLow",
    "SpineTop",
    "SpineDown",
    "LeftSideChestUp",
    "RightSideChestUp",
    "LeftSideChestDown",
    "RightSideChestDown",
    "Pelvis",
    "PelvisBack",
    "LeftUpperArm",
    "LeftForearm",
    "RightUpperArm",
    "RightForearm",
    "LeftThigh",
    "LeftCalf",
    "RightThigh",
    "RightCalf",
]


class PlateChoice(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    item_id: str
    durability_percent: float = Field(default=100, ge=0, le=100)


class EquippedArmor(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    item_id: str
    # Applies to the item's own armor (a carrier's built in soft armor); plates and helmet attachments carry their own
    durability_percent: float = Field(default=100, ge=0, le=100)
    # A built-in insert's own durability by its slot name (Soft_armor_front), over durability_percent
    piece_durability: dict[str, Annotated[float, Field(ge=0, le=100)]] = Field(default_factory=dict, max_length=16)
    plates: dict[str, PlateChoice] = Field(default_factory=dict, max_length=8)  # by plate slot name
    attachments: list[str] = Field(default_factory=list, max_length=6)  # helmet face shields, ear armor
    # By attachment id; an attachment left out is at full durability
    attachment_durability: dict[str, Annotated[float, Field(ge=0, le=100)]] = Field(default_factory=dict, max_length=6)


class PlateColliderValues(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    penetration_level: float = Field(ge=0, le=200)
    penetration_chance: float = Field(ge=0, le=1)
    penetration_damage_mod: float = Field(ge=-1, le=1)


class SimulateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    ammo_id: str
    equipment: list[EquippedArmor] = Field(default_factory=list, max_length=len(_EQUIPMENT_SLOT_NAMES))
    # The body collider hit; it decides which body part's HP drains
    collider: BodyCollider
    # A plate zone the shot goes through first, e.g. Plate_Granit_SAPI_chest. It has to sit
    # in front of `collider`.
    plate_collider: str | None = Field(default=None, max_length=64)
    # Overrides the plate collider's own values, which normally come from the game files
    plate_collider_values: PlateColliderValues | None = None
    # The hit body part's current HP, if not full; every other part is taken as full
    hp: float | None = Field(default=None, gt=0, le=200)
    # Either how far away the shot is from, in meters (we fly the bullet there), or the share
    # of its muzzle speed it arrives with. Neither means point blank.
    distance: float | None = Field(default=None, ge=0, le=1000)
    speed_ratio: float | None = Field(default=None, ge=0, le=1)
    # The weapon's and its mods' summed muzzle velocity %, as /build/calculate reports it
    velocity_modifier_pct: float = Field(default=0.0, ge=-90, le=200)
    heavy_vest_skill: float = Field(default=0.0, ge=0, le=1)
    # Degrees off straight-on every shot comes in at; past an armor piece's ricochet angle
    # it can deflect the bullet
    angle: float = Field(default=0.0, ge=0, le=89)
    max_shots: int = Field(default=30, ge=1, le=40)


# Caps the pellet hits a buckshot run works through, so a 20-pellet shell can't ask for
# 20 times the work of a rifle round
_MAX_PROJECTILE_HITS = 320
# Seconds a run may take before it stops and reports the shots it finished. Several layers
# hit at an angle is the slow case; most runs finish in well under a second.
_SIMULATE_TIME_BUDGET = 8.0


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


def _helmet_slots(db, helmet_ids):
    """{helmet id: [(slot name, set of armor attachment ids it takes)]}, slots without armor left out."""
    rows = (
        db.query(Slot.parent_item_id, Slot.slot_game_name, SlotAllowedItem.allowed_item_id)
        .join(SlotAllowedItem, SlotAllowedItem.slot_id == Slot.id)
        .join(Item, Item.id == SlotAllowedItem.allowed_item_id)
        .filter(Slot.parent_item_id.in_(list(helmet_ids)), Item.armor_kind == "attachment")
        .order_by(Slot.parent_item_id, Slot.slot_game_name)
    )
    slots = {}
    for helmet_id, slot_name, item_id in rows:
        by_name = slots.setdefault(helmet_id, {})
        by_name.setdefault(slot_name, set()).add(item_id)
    return {helmet_id: list(by_name.items()) for helmet_id, by_name in slots.items()}


def _fit_attachments(slots, attachment_ids):
    """{attachment id: slot name} with every attachment in its own slot, or None if they don't all fit."""

    def place(index, taken):
        if index == len(attachment_ids):
            return {}
        for slot_name, allowed in slots:
            if slot_name not in taken and attachment_ids[index] in allowed:
                rest = place(index + 1, taken | {slot_name})
                if rest is not None:
                    return {attachment_ids[index]: slot_name, **rest}
        return None

    return place(0, frozenset())


def check_loadout(db, ranked, items_by_id):
    """Raise a 422 when the worn items couldn't be worn together in game.

    Covers the rules the game applies between equipment slots: an armored rig takes the
    body armor's place, items list the items they conflict with, some face covers and
    visors keep the headwear or eyewear slot empty, and a helmet only takes the
    attachments its own slots allow, one per slot.
    """
    worn = {_EQUIPMENT_SLOT_NAMES[rank]: equipped for rank, equipped in ranked}
    if "rig" in worn and "armor" in worn:
        rig, armor = items_by_id[worn["rig"].item_id], items_by_id[worn["armor"].item_id]
        raise HTTPException(status_code=422, detail=f"{rig.name} can't be worn with body armor ({armor.name})")

    present = []  # (item, the equipment slot it sits in)
    for slot_name, equipped in worn.items():
        present.append((items_by_id[equipped.item_id], slot_name))
        present += [(items_by_id[attachment_id], slot_name) for attachment_id in equipped.attachments]
        present += [(items_by_id[plate.item_id], slot_name) for plate in equipped.plates.values()]

    for i, (item, _) in enumerate(present):
        conflicts = set(_split(item.conflicting_item_ids))
        for j, (other, _) in enumerate(present):
            if j > i and (other.id in conflicts or item.id in _split(other.conflicting_item_ids)):
                raise HTTPException(status_code=422, detail=f"{item.name} conflicts with {other.name}")

    for item, slot_name in present:
        if item.blocks_headwear and slot_name != "headwear" and "headwear" in worn:
            raise HTTPException(status_code=422, detail=f"{item.name} can't be worn with headwear")
        if item.blocks_eyewear and slot_name != "eyewear" and "eyewear" in worn:
            raise HTTPException(status_code=422, detail=f"{item.name} can't be worn with eyewear")

    helmets = {equipped.item_id: equipped for equipped in worn.values() if equipped.attachments}
    slots_by_helmet = _helmet_slots(db, helmets) if helmets else {}
    for helmet_id, equipped in helmets.items():
        if len(set(equipped.attachments)) != len(equipped.attachments) or (
            _fit_attachments(slots_by_helmet.get(helmet_id, []), list(equipped.attachments)) is None
        ):
            raise HTTPException(
                status_code=422, detail=f"These attachments don't fit {items_by_id[helmet_id].name}'s slots"
            )


def _layer(piece, durability_percent, armor_globals):
    if piece.material not in armor_globals.destructibility:
        raise HTTPException(status_code=422, detail=f"Unknown armor material {piece.material}")
    return ballistics.ArmorLayer(
        armor_class=piece.armor_class,
        max_durability=piece.durability,
        durability=piece.durability * durability_percent / 100,
        material=piece.material,
        blunt_throughput=piece.blunt_throughput,
        armor_type=piece.armor_type or "None",
        ricochet_x=piece.ricochet_x or 0.0,
        ricochet_y=piece.ricochet_y or 0.0,
        ricochet_z=piece.ricochet_z or 0.0,
    )


def build_layers(db, payload, armor_globals):
    """(plates, soft layers, descriptions) covering the requested spot, in the game's check order."""
    items_by_id = {}
    for equipped in payload.equipment:
        for item_id in [equipped.item_id, *equipped.attachments, *(p.item_id for p in equipped.plates.values())]:
            validate_item_id(item_id)
            items_by_id[item_id] = None
    for item in db.query(Item).filter(Item.id.in_(list(items_by_id))).all():
        items_by_id[item.id] = item
    missing = [item_id for item_id, item in items_by_id.items() if item is None]
    if missing:
        raise HTTPException(status_code=404, detail=f"Unknown item {missing[0]}")

    ranked = []
    for equipped in payload.equipment:
        item = items_by_id[equipped.item_id]
        rank = _equipment_rank(item)
        if item.armor_kind not in ("armor", "rig", "helmet", "eyewear") or rank is None:
            raise HTTPException(status_code=422, detail=f"{item.name} isn't worn armor")
        ranked.append((rank, equipped))
    ranks = [rank for rank, _ in ranked]
    if len(set(ranks)) != len(ranks):
        raise HTTPException(status_code=422, detail="Only one item per equipment slot")
    ranked.sort(key=lambda pair: pair[0])
    check_loadout(db, ranked, items_by_id)

    plate_slots = {
        (slot.holder_item_id, slot.slot_name_id): slot
        for slot in db.query(ArmorPlateSlot).filter(
            ArmorPlateSlot.holder_item_id.in_([equipped.item_id for _, equipped in ranked])
        )
    }
    pieces_by_holder = {}
    for piece in db.query(ArmorPiece).filter(ArmorPiece.holder_item_id.in_(list(items_by_id))).order_by(ArmorPiece.id):
        pieces_by_holder.setdefault(piece.holder_item_id, []).append(piece)

    plates, soft_layers, described = [], [], {"plates": [], "soft_layers": []}

    def describe(target, piece, layer, item):
        target.append(
            {
                "item_id": item.id,
                "name": item_name(item, "en") if piece.slot_name_id is None else (piece.name or item.name),
                "slot": piece.slot_name_id,
                "armor_class": layer.armor_class,
                "durability": layer.durability,
                "max_durability": layer.max_durability,
                "material": layer.material,
            }
        )

    # Plates sit in unlocked armor slots, which the game moves ahead of everything else
    for _, equipped in ranked:
        for slot_name, choice in equipped.plates.items():
            slot = plate_slots.get((equipped.item_id, slot_name))
            plate = items_by_id[choice.item_id]
            if slot is None or choice.item_id not in _split(slot.allowed_plate_ids):
                raise HTTPException(status_code=422, detail=f"{plate.name} doesn't fit {slot_name}")
            if payload.plate_collider is None or payload.plate_collider not in _split(slot.plate_colliders):
                continue
            for piece in pieces_by_holder.get(plate.id, []):
                if payload.plate_collider in _split(piece.plate_colliders):
                    layer = _layer(piece, choice.durability_percent, armor_globals)
                    if slot.blunt_reduce_from_soft_armor:
                        layer = dataclasses.replace(layer, blunt_reduce_from_soft_armor=True)
                    plates.append(layer)
                    describe(described["plates"], piece, layer, plate)

    for _, equipped in ranked:
        item = items_by_id[equipped.item_id]
        holders = [(item.id, equipped.durability_percent)]
        for attachment_id in equipped.attachments:
            attachment = items_by_id[attachment_id]
            if item.armor_kind != "helmet" or attachment.armor_kind != "attachment":
                raise HTTPException(status_code=422, detail=f"{attachment.name} doesn't attach to {item.name}")
            holders.append((attachment_id, equipped.attachment_durability.get(attachment_id, 100)))
        for holder, durability_percent in holders:
            for piece in pieces_by_holder.get(holder, []):
                if payload.collider in _split(piece.body_colliders):
                    if holder == item.id and piece.slot_name_id in equipped.piece_durability:
                        durability_percent = equipped.piece_durability[piece.slot_name_id]
                    layer = _layer(piece, durability_percent, armor_globals)
                    soft_layers.append(layer)
                    describe(described["soft_layers"], piece, layer, items_by_id[holder])

    return plates, soft_layers, described


@functools.cache
def _armor_globals():
    return ballistics.load_armor_globals()


@functools.cache
def _colliders():
    return ballistics.load_player_colliders()


def _target(payload):
    """(body part, its full HP, PlateCollider or None) for the spot the request hits."""
    colliders = _colliders()
    body_part = colliders["body_parts"].get(payload.collider)
    parts = _armor_globals().health.get("parts", {})
    if body_part not in parts:
        raise HTTPException(status_code=422, detail=f"No health data for {payload.collider}")
    plate_collider = None
    if payload.plate_collider is not None:
        zone = colliders["plates"].get(payload.plate_collider)
        if zone is None:
            raise HTTPException(status_code=422, detail=f"Unknown plate zone {payload.plate_collider}")
        if zone["collider"] != payload.collider:
            raise HTTPException(
                status_code=422, detail=f"{payload.plate_collider} doesn't sit in front of {payload.collider}"
            )
        values = payload.plate_collider_values.model_dump() if payload.plate_collider_values else zone
        plate_collider = ballistics.PlateCollider(
            penetration_level=values["penetration_level"],
            penetration_chance=values["penetration_chance"],
            penetration_damage_mod=values["penetration_damage_mod"],
        )
    return body_part, parts[body_part]["max"], plate_collider


def _ammo_or_404(db, ammo_id):
    validate_item_id(ammo_id)
    ammo = db.query(Item).filter(Item.id == ammo_id, Item.is_ammo == True).first()  # noqa: E712
    if ammo is None:
        raise HTTPException(status_code=404, detail="Ammo not found")
    if ammo.ammo_damage is None or ammo.penetration_power is None or ammo.armor_damage is None:
        raise HTTPException(status_code=422, detail="This ammo is missing damage or penetration data")
    return ammo


def _flight(ammo, payload):
    """(where and how fast the bullet arrives, or None, and the speed ratio for the engine)."""
    if payload.distance is None:
        return None, 1.0 if payload.speed_ratio is None else payload.speed_ratio
    if payload.speed_ratio is not None:
        raise HTTPException(status_code=422, detail="Give either distance or speed_ratio, not both")
    if not (ammo.velocity and ammo.bullet_mass_grams and ammo.bullet_diameter_mm and ammo.ballistic_coefficient):
        raise HTTPException(status_code=422, detail="This ammo has no flight data")
    start = ballistics.muzzle_speed(ammo.velocity, payload.velocity_modifier_pct)
    path = ballistics.flight_path(
        start, ammo.bullet_mass_grams, ammo.bullet_diameter_mm, ammo.ballistic_coefficient, payload.distance
    )
    hit = ballistics.arrival(path, payload.distance)
    if hit is None:
        raise HTTPException(status_code=422, detail="The bullet doesn't reach that far")
    speed_ratio = min(hit.speed / start, 1.0)
    return {
        "distance": hit.distance,
        "muzzle_speed": start,
        "speed": hit.speed,
        "drop": hit.drop,
        "time": hit.time,
        "speed_ratio": speed_ratio,
    }, speed_ratio


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
    helmet_ids = [item.id for item in items if item.armor_kind == "helmet"]
    helmet_slots = _helmet_slots(db, helmet_ids)
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
            # A helmet's attachment slots, in the game's slot order, with what it comes with
            "attachment_slots": [
                {"slot": name, "allowed_ids": sorted(allowed), "default_id": defaults.get((item.id, name))}
                for name, allowed in helmet_slots.get(item.id, [])
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


def _prepare(db, payload):
    """Everything about a request that doesn't depend on the ammo: the target and the layers."""
    armor_globals = _armor_globals()
    body_part, full_hp, plate_collider = _target(payload)
    plates, soft_layers, described = build_layers(db, payload, armor_globals)
    if payload.hp is not None and payload.hp > full_hp:
        raise HTTPException(status_code=422, detail=f"hp can't exceed {full_hp} for the {body_part}")
    part_hp = payload.hp or full_hp
    # A stomach or limb at 0 doesn't kill: damage past it spreads until the thorax or head goes
    spread_hp = ballistics.spread_capacity(body_part, armor_globals.health)
    return {
        "armor_globals": armor_globals,
        "body_part": body_part,
        "part_hp": part_hp,
        "spread_hp": spread_hp,
        "plate_collider": plate_collider,
        "plates": plates,
        "soft_layers": soft_layers,
        "described": described,
    }


def _run(ammo, payload, target, deadline):
    """(flight, pellets per shot, SimulationResult) for one ammo against a prepared target."""
    flight, speed_ratio = _flight(ammo, payload)
    projectiles = max(1, ammo.projectile_count or 1)
    result = ballistics.simulate(
        ballistics.Ammo(
            damage=ammo.ammo_damage,
            penetration=ammo.penetration_power,
            armor_damage=ammo.armor_damage,
            penetration_deviation=ammo.penetration_power_deviation or 0.0,
            penetration_damage_mod=ammo.penetration_damage_mod or 0.0,
        ),
        target["part_hp"] + target["spread_hp"],
        soft_layers=target["soft_layers"],
        plates=target["plates"],
        armor_globals=target["armor_globals"],
        plate_collider=target["plate_collider"],
        speed_ratio=speed_ratio,
        heavy_vest_skill=payload.heavy_vest_skill,
        max_shots=min(payload.max_shots, max(1, _MAX_PROJECTILE_HITS // projectiles)),
        projectiles=projectiles,
        angle=payload.angle,
        deadline=deadline,
    )
    return flight, projectiles, result


@router.post("/armor/simulate")
def armor_simulate(request: Request, payload: SimulateRequest, db: Session = Depends(get_db)):
    """Kill chance and armor wear shot by shot for one ammo into one spot on the given armor."""
    check_solve_rate_limit(get_client_ip(request))
    ammo = _ammo_or_404(db, payload.ammo_id)
    target = _prepare(db, payload)
    flight, projectiles, result = _run(ammo, payload, target, time.monotonic() + _SIMULATE_TIME_BUDGET)
    return {
        "ammo_id": ammo.id,
        "body_part": target["body_part"],
        "hp": target["part_hp"],
        "spread_hp": target["spread_hp"],
        "projectiles": projectiles,
        "flight": flight,
        **target["described"],
        "shots_to_kill": result.shots_to_kill(),
        "truncated": result.truncated,
        "shots": [
            {
                "shot": shot.shot,
                "kill_chance": shot.kill_chance,
                "durability_alive": shot.durability_alive,
                "hp_alive": shot.hp_alive,
            }
            for shot in result.shots
        ],
    }


# Seconds a whole caliber comparison may take, shared by every round in it
_COMPARE_TIME_BUDGET = 12.0
_COMPARE_MAX_AMMO = 40


@router.post("/armor/compare")
def armor_compare(request: Request, payload: SimulateRequest, db: Session = Depends(get_db)):
    """Shots to kill for every round in the requested ammo's caliber, against the same armor
    and target. Rounds the time budget doesn't reach come back marked as skipped."""
    check_solve_rate_limit(get_client_ip(request))
    picked = _ammo_or_404(db, payload.ammo_id)
    target = _prepare(db, payload)
    rounds = (
        db.query(Item)
        .filter(Item.is_ammo == True, Item.caliber == picked.caliber)  # noqa: E712
        .order_by(Item.penetration_power.desc())
        .limit(_COMPARE_MAX_AMMO)
        .all()
    )
    deadline = time.monotonic() + _COMPARE_TIME_BUDGET
    rows = []
    for ammo in rounds:
        if ammo.ammo_damage is None or ammo.penetration_power is None or ammo.armor_damage is None:
            continue
        row = {
            "ammo_id": ammo.id,
            "name": item_name(ammo, "en"),
            "damage": ammo.ammo_damage,
            "penetration": ammo.penetration_power,
            "projectiles": max(1, ammo.projectile_count or 1),
        }
        if time.monotonic() > deadline:
            row["skipped"] = True
            rows.append(row)
            continue
        try:
            _, _, result = _run(ammo, payload, target, deadline)
        except HTTPException:
            # This round has no flight data or doesn't reach the distance
            row["skipped"] = True
            rows.append(row)
            continue
        row.update(
            shots_to_kill_50=result.shots_to_kill(0.5),
            shots_to_kill_90=result.shots_to_kill(0.9),
            truncated=result.truncated,
        )
        rows.append(row)
    return {"caliber": picked.caliber, "ammo": rows}
