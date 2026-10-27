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
    shot = _shot(ammo, payload.velocity_modifier_pct)
    rows = ballistics.zeroing_table(
        shot,
        _shot(zero_ammo, payload.velocity_modifier_pct),
        payload.zero_distance,
        payload.sight_height_cm / 100,
        distances,
    )
    if rows is None:
        raise HTTPException(status_code=422, detail="The zeroing round doesn't reach the zero distance")
    armor_globals = _armor_globals()
    return {
        "ammo_id": ammo.id,
        "zero_ammo_id": zero_ammo.id,
        "muzzle_speed": shot[0],
        "rows": [
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
            for row in rows
        ],
    }
