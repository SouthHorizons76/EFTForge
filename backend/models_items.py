from sqlalchemy import Column, String, Float, Boolean, Text
from database import Base


class Item(Base):
    __tablename__ = "items"

    id = Column(String, primary_key=True, index=True)
    name = Column(String)
    weight = Column(Float)
    ergonomics_modifier = Column(Float)
    recoil_modifier = Column(Float)
    icon_link = Column(String)

    is_weapon = Column(Boolean, default=False)

    # Stripped receiver ergonomics
    base_ergonomics = Column(Float)

    # Factory preset values
    factory_ergonomics = Column(Float)
    factory_weight = Column(Float)

    # Store attachment IDs as comma-separated string
    factory_attachment_ids = Column(Text)