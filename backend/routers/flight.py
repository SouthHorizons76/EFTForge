"""Bullet drop and zeroing tables for one round out of one weapon setup."""

import functools

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

import ballistics
from models_items import Item
from routers.shared import get_db, validate_item_id

router = APIRouter()

_MAX_ROWS = 101


class FlightRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    ammo_id: str
    # Other rounds for the charts to lay over the first. One of the same caliber flies from the
    # same weapon and zero; one of another caliber can't, so it's zeroed with itself instead.
    compare_ammo_ids: list[str] = Field(default_factory=list, max_length=2)
    # The weapon whose default ammo sets the zero; without one the loaded round zeros itself
    weapon_id: str | None = None
    zero_distance: float = Field(default=100, ge=10, le=1000)
    # Sight line height above the bore. The game takes it from the weapon and sight models,
    # which we don't have, so the player sets it.
    sight_height_cm: float = Field(default=5.0, ge=0, le=20)
    velocity_modifier_pct: float = Field(default=0.0, ge=-90, le=200)
    max_distance: float = Field(default=500, ge=25, le=1000)
    step: float = Field(default=25, ge=5, le=200)


@functools.cache
def _armor_globals():
    return ballistics.load_armor_globals()


def _shot(ammo, velocity_modifier_pct):
    if not (ammo.velocity and ammo.bullet_mass_grams and ammo.bullet_diameter_mm and ammo.ballistic_coefficient):
        raise HTTPException(status_code=422, detail=f"{ammo.name} has no flight data")
    return (
        ballistics.muzzle_speed(ammo.velocity, velocity_modifier_pct),
        ammo.bullet_mass_grams,
        ammo.bullet_diameter_mm,
        ammo.ballistic_coefficient,
    )


def _ammo(db, ammo_id):
    validate_item_id(ammo_id)
    ammo = db.query(Item).filter(Item.id == ammo_id, Item.is_ammo == True).first()  # noqa: E712
    if ammo is None:
        raise HTTPException(status_code=404, detail="Ammo not found")
    return ammo


@router.post("/ammo/flight")
def ammo_flight(payload: FlightRequest, db: Session = Depends(get_db)):
    """Point of impact against the sight line, speed, time, damage and pen at each distance."""
    ammo = _ammo(db, payload.ammo_id)
    zero_ammo = ammo
    if payload.weapon_id is not None:
        validate_item_id(payload.weapon_id)
        weapon = db.query(Item).filter(Item.id == payload.weapon_id, Item.is_weapon == True).first()  # noqa: E712
        if weapon is None:
            raise HTTPException(status_code=404, detail="Weapon not found")
        if weapon.default_ammo_id:
            zero_ammo = _ammo(db, weapon.default_ammo_id)
    distances = []
    distance = 0.0
    while distance <= payload.max_distance + 1e-9 and len(distances) < _MAX_ROWS:
        distances.append(round(distance, 6))
        distance += payload.step
    zero_shot = _shot(zero_ammo, payload.velocity_modifier_pct)
    shot, rows = _rows(ammo, zero_shot, payload, distances)
    if rows is None:
        raise HTTPException(status_code=422, detail="The zeroing round doesn't reach the zero distance")
    compare = []
    for compare_id in dict.fromkeys(payload.compare_ammo_ids):
        if compare_id == ammo.id:
            continue
        other = _ammo(db, compare_id)
        same_weapon = other.caliber == ammo.caliber
        # A round we can't fly just drops out of the charts instead of failing the whole table
        try:
            other_zero = zero_shot if same_weapon else _shot(other, payload.velocity_modifier_pct)
            other_shot, other_rows = _rows(other, other_zero, payload, distances)
        except HTTPException:
            continue
        if other_rows is None:
            continue
        compare.append(
            {
                "ammo_id": other.id,
                "zero_ammo_id": zero_ammo.id if same_weapon else other.id,
                "muzzle_speed": other_shot[0],
                "rows": other_rows,
            }
        )
    return {
        "ammo_id": ammo.id,
        "zero_ammo_id": zero_ammo.id,
        "muzzle_speed": shot[0],
        "rows": rows,
        "compare": compare,
    }


def _rows(ammo, zero_shot, payload, distances):
    """(shot, [row]) for one round out of the zeroed weapon, rows None if the zero is out of reach."""
    shot = _shot(ammo, payload.velocity_modifier_pct)
    table = ballistics.zeroing_table(
        shot,
        zero_shot,
        payload.zero_distance,
        payload.sight_height_cm / 100,
        distances,
    )
    if table is None:
        return shot, None
    armor_globals = _armor_globals()
    return shot, [
        {
            "distance": row.distance,
            "impact_cm": row.impact * 100,
            "correction_mrad": row.correction_mrad,
            "speed": row.speed,
            "time": row.time,
            # What survives of damage and pen at the speed it arrives with
            "damage": (
                ammo.ammo_damage * ballistics.degradation_factor(row.speed / shot[0], armor_globals)
                if ammo.ammo_damage is not None
                else None
            ),
            "penetration": (
                ammo.penetration_power * ballistics.degradation_factor(row.speed / shot[0], armor_globals)
                if ammo.penetration_power is not None
                else None
            ),
        }
        for row in table
    ]
