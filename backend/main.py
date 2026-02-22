from fastapi import FastAPI, Body, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from database import SessionLocal, engine, Base
from models_items import Item
from models_slots import Slot
from models_slot_allowed import SlotAllowedItem

from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="db4tarkov CN API")

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

        # Convert CSV string to array
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
            "factory_attachment_ids": factory_ids
        })

    return result

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
            "icon_link": item.icon_link
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
    db: Session = Depends(get_db),
):

    base_item = db.query(Item).filter(Item.id == base_item_id).first()

    if not base_item:
        raise HTTPException(status_code=404, detail="Base item not found")

    # -------------------------------------------------
    # Receiver Base
    # -------------------------------------------------

    receiver_ergo = base_item.base_ergonomics or 0
    receiver_weight = base_item.weight or 0

    # -------------------------------------------------
    # Factory IDs
    # -------------------------------------------------

    factory_ids = []
    if base_item.factory_attachment_ids:
        factory_ids = base_item.factory_attachment_ids.split(",")

    current_ids = attachment_ids or []

    factory_set = set(factory_ids)
    current_set = set(current_ids)

    # True only if ALL factory attachments are currently installed
    factory_intact = factory_set.issubset(current_set)

    # -------------------------------------------------
    # Determine baseline
    # -------------------------------------------------

    factory_ergo = base_item.factory_ergonomics or receiver_ergo
    factory_weight = base_item.factory_weight or receiver_weight

    if factory_intact:
        base_ergo = factory_ergo
        base_weight = factory_weight
        total_ergo = factory_ergo
        total_weight = factory_weight
    else:
        base_ergo = receiver_ergo
        base_weight = receiver_weight
        total_ergo = receiver_ergo
        total_weight = receiver_weight

    # -------------------------------------------------
    # Apply user-added attachments ONLY
    # -------------------------------------------------

    factory_ids = []
    if base_item.factory_attachment_ids:
        factory_ids = base_item.factory_attachment_ids.split(",")
        
        # Determine if factory config is intact
        factory_set = set(factory_ids)
        current_set = set(attachment_ids or [])

        factory_intact = factory_set.issubset(current_set)

    if current_ids:
        attachments = db.query(Item).filter(
            Item.id.in_(current_ids)
        ).all()

        for att in attachments:

            # If factory intact, skip factory attachments (avoid double count)
            if factory_intact and att.id in factory_ids:
                continue

            total_ergo += att.ergonomics_modifier or 0
            total_weight += att.weight or 0

    # -------------------------------------------------
    # EvoErgo Formula
    # -------------------------------------------------

    b = 0  # gear modifier placeholder

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
        "base_ergo": round(base_ergo, 2),
        "base_weight": round(base_weight, 3),
        "total_ergo": round(total_ergo, 2),
        "total_weight": round(total_weight, 3),
        "overswing": overswing,
        "evo_ergo_delta": round(eed, 2),
    }