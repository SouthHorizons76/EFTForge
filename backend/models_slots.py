from sqlalchemy import Column, String, ForeignKey
from database import Base


class Slot(Base):
    __tablename__ = "slots"

    id = Column(String, primary_key=True)

    parent_item_id = Column(String, ForeignKey("items.id"))

    slot_name = Column(String)

    # Authoritative Tarkov internal identifier
    name_id = Column(String, nullable=True)