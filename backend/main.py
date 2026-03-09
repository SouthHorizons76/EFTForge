from fastapi import FastAPI, Body, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from database import SessionLocal, engine, Base
from models_items import Item
from models_slots import Slot
from models_slot_allowed import SlotAllowedItem

from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="EFTForge API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5500"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

Base.metadata.create_all(bind=engine)


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
# Weapons
# ---------------------------------------------------

@app.get("/guns")
def get_guns(db: Session = Depends(get_db)):
    guns = db.query(Item).filter(Item.is_weapon == True).all()

    result = []

    for gun in guns:

        if gun.factory_attachment_ids:
            factory_ids = gun.factory_attachment_ids.split(",")
        else:
            factory_ids = []

        result.append({
            "id": gun.id,
            "name": gun.name,
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
def get_ammo_for_caliber(caliber: str, db: Session = Depends(get_db)):
    ammo = db.query(Item).filter(
        Item.is_ammo == True,
        Item.caliber == caliber
    ).order_by(Item.weight.asc()).all()

    return [
        {
            "id": a.id,
            "name": a.name,
            "weight": a.weight
        }
        for a in ammo
    ]

# ---------------------------------------------------
# Slots
# ---------------------------------------------------

@app.get("/items/{item_id}/slots")
def get_item_slots(item_id: str, db: Session = Depends(get_db)):
    return db.query(Slot).filter(Slot.parent_item_id == item_id).all()


# ---------------------------------------------------
# Allowed Items
# ---------------------------------------------------

@app.get("/slots/{slot_id}/allowed-items")
def get_allowed_items(slot_id: str, db: Session = Depends(get_db)):
    allowed = db.query(SlotAllowedItem).filter(
        SlotAllowedItem.slot_id == slot_id
    ).all()

    ids = [a.allowed_item_id for a in allowed]

    items = db.query(Item).filter(Item.id.in_(ids)).all()

    return [
        {
            "id": item.id,
            "name": item.name,
            "short_name": item.short_name,
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
    # ITEM ↔ ITEM CONFLICT CHECK
    # -------------------------------------------------

    installed_set = set(installed_ids)
    installed_set.add(base_item_id)

    if candidate.conflicting_item_ids:
        conflict_ids = set(candidate.conflicting_item_ids.split(","))
        overlap = conflict_ids.intersection(installed_set)

        if overlap:
            conflicting_item = db.query(Item).filter(
                Item.id == list(overlap)[0]
            ).first()

            return {
                "valid": False,
                "reason": f"Is incompatible with: {conflicting_item.name}",
                "type": "item_conflict",
                "conflicting_item_id": conflicting_item.id
            }

    # -------------------------------------------------
    # SLOT ↔ SLOT CONFLICT CHECK
    # -------------------------------------------------

    if candidate.conflicting_slot_ids:
        conflict_slots = set(candidate.conflicting_slot_ids.split(","))

        for installed_id in installed_set:

            installed_item = db.query(Item).filter(
                Item.id == installed_id
            ).first()

            if not installed_item:
                continue

            installed_slots = db.query(Slot).filter(
                Slot.parent_item_id == installed_item.id
            ).all()

            for s in installed_slots:
                if s.id in conflict_slots:
                    return {
                        "valid": False,
                        "reason": f"Conflicts with slot: {s.slot_name}",
                        "type": "slot_conflict",
                        "conflicting_slot_id": s.id
                    }
                    
    # -------------------------------------------------
    # REVERSE ITEM ↔ ITEM CONFLICT CHECK
    # -------------------------------------------------

    for installed_id in installed_set:

        installed_item = db.query(Item).filter(
            Item.id == installed_id
        ).first()

        if not installed_item:
            continue

        if installed_item.conflicting_item_ids:
            installed_conflicts = set(
                installed_item.conflicting_item_ids.split(",")
            )

            if candidate_id in installed_conflicts:
                return {
                    "valid": False,
                    "reason": f"Is incompatible with: {installed_item.name}",
                    "type": "reverse_item_conflict",
                    "conflicting_item_id": installed_item.id
                }
                    
    # -------------------------------------------------
    # REVERSE SLOT CONFLICT CHECK
    # -------------------------------------------------

    for installed_id in installed_set:

        installed_item = db.query(Item).filter(
            Item.id == installed_id
        ).first()

        if not installed_item:
            continue

        if installed_item.conflicting_slot_ids:
            installed_conflicts = set(
                installed_item.conflicting_slot_ids.split(",")
            )

            if slot_id in installed_conflicts:
                return {
                    "valid": False,
                    "reason": f"Blocked by installed item: {installed_item.name}",
                    "type": "reverse_slot_conflict",
                    "conflicting_item_id": installed_item.id
                }

    # -------------------------------------------------
    # VALID
    # -------------------------------------------------

    return {
        "valid": True
    }
    
# ---------------------------------------------------
# Calculation Engine
# ---------------------------------------------------

@app.post("/build/calculate")
def calculate_build(
    base_item_id: str = Body(...),
    attachment_ids: List[str] | None = Body(default=None),
    assume_full_mag: bool = Body(default=True),
    selected_ammo_id: str | None = Body(default=None),
    db: Session = Depends(get_db),
):

    base_item = db.query(Item).filter(Item.id == base_item_id).first()
    if not base_item:
        raise HTTPException(status_code=404, detail="Base item not found")

    receiver_ergo = base_item.base_ergonomics or 0
    receiver_weight = base_item.weight or 0

    factory_ids = []
    if base_item.factory_attachment_ids:
        factory_ids = base_item.factory_attachment_ids.split(",")

    current_ids = attachment_ids or []

    factory_set = set(factory_ids)
    current_set = set(current_ids)
    factory_intact = factory_set.issubset(current_set)

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

    attachments = []
    total_recoil_modifier = 0.0

    if current_ids:
        attachments = db.query(Item).filter(
            Item.id.in_(current_ids)
        ).all()

        for att in attachments:

            if factory_intact and att.id in factory_ids:
                continue

            total_ergo += att.ergonomics_modifier or 0
            total_weight += att.weight or 0
            total_recoil_modifier += att.recoil_modifier or 0

    # Apply recoil modifier only when NOT using factory preset
    if not factory_intact:
        if total_recoil_v is not None:
            total_recoil_v = round(total_recoil_v * (1 + total_recoil_modifier))
        if total_recoil_h is not None:
            total_recoil_h = round(total_recoil_h * (1 + total_recoil_modifier))

    # ------------------------------
    # Ammo Weight Logic
    # ------------------------------
    if assume_full_mag and selected_ammo_id:

        ammo = db.query(Item).filter(Item.id == selected_ammo_id).first()

        if ammo and ammo.is_ammo:

            for att in attachments:
                if att.magazine_capacity:
                    capacity = att.magazine_capacity
                    total_weight += (ammo.weight or 0) * capacity

    # ------------------------------
    # Evo Ergo Calculation
    # ------------------------------

    # b = equipment ergonomics modifier (reserved for future use, e.g. helmet, armor, and backpacks)
    b = 0
    E = total_ergo * (1 + b)

    KG = (
        0.0007556 * (E ** 2)
        + 0.02736 * E
        + 2.9159
    )

    evo_weight = total_weight - KG
    overswing = evo_weight > 0
    eed = -15 * evo_weight

    return {
        "total_ergo": round(total_ergo, 2),
        "total_weight": round(total_weight, 3),
        "overswing": overswing,
        "evo_ergo_delta": round(eed, 2),
        "recoil_vertical": total_recoil_v,
        "recoil_horizontal": total_recoil_h,
    }