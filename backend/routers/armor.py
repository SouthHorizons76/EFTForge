"""Armor catalog and the armor ballistics simulation."""

import dataclasses
import functools
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

import ballistics
from models_armor import ArmorPiece, ArmorPlateSlot
from models_items import Item
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

# Only these body parts kill when they reach 0 HP; a stomach or limb at 0 doesn't
_LETHAL_HP = {"Head": 35, "Chest": 85}

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
]


class PlateChoice(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    item_id: str
    durability_percent: float = Field(default=100, ge=0, le=100)


class EquippedArmor(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    item_id: str
    # Applies to the item's own armor and its helmet attachments; plates carry their own
    durability_percent: float = Field(default=100, ge=0, le=100)
    plates: dict[str, PlateChoice] = Field(default_factory=dict, max_length=8)  # by plate slot name
    attachments: list[str] = Field(default_factory=list, max_length=6)  # helmet face shields, ear armor


class PlateColliderValues(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    penetration_level: float = Field(ge=0, le=200)
    penetration_chance: float = Field(ge=0, le=1)
    penetration_damage_mod: float = Field(ge=-1, le=1)


class SimulateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    ammo_id: str
    equipment: list[EquippedArmor] = Field(default_factory=list, max_length=4)
    # The body collider hit; it decides which body part's HP drains
    collider: BodyCollider
    # A plate zone the shot goes through first, e.g. Plate_Granit_SAPI_chest. It has to sit
    # in front of `collider`.
    plate_collider: str | None = Field(default=None, max_length=64)
    # Overrides the plate collider's own values, which normally come from the game files
    plate_collider_values: PlateColliderValues | None = None
    hp: float | None = Field(default=None, gt=0, le=85)
    # Either how far away the shot is from, in meters (we fly the bullet there), or the share
    # of its muzzle speed it arrives with. Neither means point blank.
    distance: float | None = Field(default=None, ge=0, le=1000)
    speed_ratio: float | None = Field(default=None, ge=0, le=1)
    # The weapon's and its mods' summed muzzle velocity %, as /build/calculate reports it
    velocity_modifier_pct: float = Field(default=0.0, ge=-90, le=200)
    heavy_vest_skill: float = Field(default=0.0, ge=0, le=1)
    max_shots: int = Field(default=30, ge=1, le=40)


# Caps the pellet hits a buckshot run works through, so a 20-pellet shell can't ask for
# 20 times the work of a rifle round
_MAX_PROJECTILE_HITS = 320


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
        holders = [item.id]
        for attachment_id in equipped.attachments:
            attachment = items_by_id[attachment_id]
            if item.armor_kind != "helmet" or attachment.armor_kind != "attachment":
                raise HTTPException(status_code=422, detail=f"{attachment.name} doesn't attach to {item.name}")
            holders.append(attachment_id)
        for holder in holders:
            for piece in pieces_by_holder.get(holder, []):
                if payload.collider in _split(piece.body_colliders):
                    layer = _layer(piece, equipped.durability_percent, armor_globals)
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
    """(body part, full HP, PlateCollider or None) for the spot the request hits."""
    colliders = _colliders()
    body_part = colliders["body_parts"].get(payload.collider)
    if body_part not in _LETHAL_HP:
        raise HTTPException(status_code=422, detail="Only head and thorax hits can kill, so only those are simulated")
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
    return body_part, _LETHAL_HP[body_part], plate_collider


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
    pieces_by_holder, slots_by_holder = {}, {}
    for piece in db.query(ArmorPiece).order_by(ArmorPiece.id):
        pieces_by_holder.setdefault(piece.holder_item_id, []).append(
            {
                "slot": piece.slot_name_id,
                "name": piece.name_zh if lang == "zh" and piece.name_zh else piece.name,
                "armor_class": piece.armor_class,
                "durability": piece.durability,
                "material": piece.material,
                "armor_type": piece.armor_type,
                "blunt_throughput": piece.blunt_throughput,
                "body_colliders": _split(piece.body_colliders),
                "plate_colliders": _split(piece.plate_colliders),
            }
        )
    for slot in db.query(ArmorPlateSlot).order_by(ArmorPlateSlot.id):
        slots_by_holder.setdefault(slot.holder_item_id, []).append(
            {
                "slot": slot.slot_name_id,
                "plate_colliders": _split(slot.plate_colliders),
                "allowed_plate_ids": _split(slot.allowed_plate_ids),
            }
        )
    items = db.query(Item).filter(Item.armor_kind.isnot(None)).order_by(Item.name).all()
    return [
        {
            "id": item.id,
            "name": item_name(item, lang),
            "short_name": item_short_name(item, lang),
            "icon_link": item.icon_link,
            "kind": item.armor_kind,
            # Which equipment slot it's worn in, or None for plates and helmet attachments
            "equipment_slot": _equipment_slot_name(item),
            "pieces": pieces_by_holder.get(item.id, []),
            "plate_slots": slots_by_holder.get(item.id, []),
        }
        for item in items
    ]


@router.get("/armor/zones")
def armor_zones():
    """Which body part each collider drains, and which body collider each plate zone covers."""
    colliders = _colliders()
    return {
        "body_parts": colliders["body_parts"],
        "lethal_hp": _LETHAL_HP,
        "plates": {
            zone: {"collider": v["collider"], "body_part": v["body_part"]} for zone, v in colliders["plates"].items()
        },
    }


@router.post("/armor/simulate")
def armor_simulate(request: Request, payload: SimulateRequest, db: Session = Depends(get_db)):
    """Kill chance and armor wear shot by shot for one ammo into one spot on the given armor."""
    check_solve_rate_limit(get_client_ip(request))
    ammo = _ammo_or_404(db, payload.ammo_id)
    armor_globals = _armor_globals()
    body_part, full_hp, plate_collider = _target(payload)
    plates, soft_layers, described = build_layers(db, payload, armor_globals)
    if payload.hp is not None and payload.hp > full_hp:
        raise HTTPException(status_code=422, detail=f"hp can't exceed {full_hp} for the {body_part}")
    hp = payload.hp or full_hp
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
        hp,
        soft_layers=soft_layers,
        plates=plates,
        armor_globals=armor_globals,
        plate_collider=plate_collider,
        speed_ratio=speed_ratio,
        heavy_vest_skill=payload.heavy_vest_skill,
        max_shots=min(payload.max_shots, max(1, _MAX_PROJECTILE_HITS // projectiles)),
        projectiles=projectiles,
    )
    return {
        "ammo_id": ammo.id,
        "body_part": body_part,
        "hp": hp,
        "projectiles": projectiles,
        "flight": flight,
        **described,
        "shots_to_kill": result.shots_to_kill(),
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
