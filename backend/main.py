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
            "factory_attachment_ids": factory_ids,
            "caliber": gun.caliber,
            "weapon_category": gun.weapon_category,
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
# Evo Ergo Calculation
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
    else:
        total_ergo = receiver_ergo
        total_weight = receiver_weight

    attachments = []
    conflict_detected = False

    if current_ids:
        attachments = db.query(Item).filter(
            Item.id.in_(current_ids)
        ).all()

        installed_ids = set(current_ids)

        for att in attachments:

            # --------------------------
            # Check item-to-item conflict
            # --------------------------
            if att.conflicting_item_ids:
                conflicts = set(att.conflicting_item_ids.split(","))
                if conflicts.intersection(installed_ids):
                    conflict_detected = True

            # --------------------------
            # Check slot conflict
            # --------------------------
            if att.conflicting_slot_ids:
                conflict_slots = set(att.conflicting_slot_ids.split(","))
                for slot_id in conflict_slots:
                    # If any installed attachment occupies that slot
                    for other in attachments:
                        parent_slots = db.query(Slot).filter(
                            Slot.parent_item_id == other.id
                        ).all()
                        for ps in parent_slots:
                            if ps.id == slot_id:
                                conflict_detected = True

            if conflict_detected:
                break

        # Normal stat addition
        for att in attachments:

            if factory_intact and att.id in factory_ids:
                continue

            total_ergo += att.ergonomics_modifier or 0
            total_weight += att.weight or 0

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
    }