from sqlalchemy import Column, String, Float, Boolean, Text, Integer
from database import Base


class Item(Base):
    __tablename__ = "items"

    id = Column(String, primary_key=True, index=True)
    name = Column(String)
    short_name = Column(String)

    weight = Column(Float)
    ergonomics_modifier = Column(Float)
    recoil_modifier = Column(Float, default=0)

    image_512_link = Column(String, nullable=True)
    icon_link = Column(String, nullable=True)

    weapon_category = Column(String)
    is_weapon = Column(Boolean, default=False)

    base_ergonomics = Column(Float)

    factory_ergonomics = Column(Float)
    factory_weight = Column(Float)

    factory_attachment_ids = Column(Text)

    caliber = Column(String)
    magazine_capacity = Column(Integer)
    is_ammo = Column(Boolean, default=False)

    conflicting_item_ids = Column(Text)
    conflicting_slot_ids = Column(Text)