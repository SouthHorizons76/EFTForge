from sqlalchemy import Column, String, Float, Boolean, Text, Integer
from database import Base


class Item(Base):
    __tablename__ = "items"

    id = Column(String, primary_key=True, index=True)
    name = Column(String)
    weight = Column(Float)
    ergonomics_modifier = Column(Float)
    recoil_modifier = Column(Float, default=0)
    icon_link = Column(String)
    weapon_category = Column(String)

    is_weapon = Column(Boolean, default=False)

    # Stripped receiver ergonomics
    base_ergonomics = Column(Float)

    # Factory preset values
    factory_ergonomics = Column(Float)
    factory_weight = Column(Float)

    # Store attachment IDs as comma-separated string
    factory_attachment_ids = Column(Text)
    
    caliber = Column(String)
    magazine_capacity = Column(Integer)
    is_ammo = Column(Boolean, default=False)
    
    # Conflict system
    conflicting_item_ids = Column(Text)      # comma-separated item IDs
    conflicting_slot_ids = Column(Text)      # comma-separated slot IDs