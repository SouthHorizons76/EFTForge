from sqlalchemy import Column, String, Integer, ForeignKey, UniqueConstraint
from database import Base


class SlotAllowedItem(Base):
    __tablename__ = "slot_allowed_items"

    id = Column(Integer, primary_key=True, autoincrement=True)

    slot_id = Column(String, ForeignKey("slots.id"), index=True)
    allowed_item_id = Column(String, ForeignKey("items.id"), index=True)

    __table_args__ = (
        UniqueConstraint("slot_id", "allowed_item_id", name="uix_slot_allowed"),
    )
