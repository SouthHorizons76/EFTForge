from sqlalchemy import Column, Integer, String, Float
from database import Base


class Gun(Base):
    __tablename__ = "guns"

    id = Column(Integer, primary_key=True)
    tarkov_id = Column(String, unique=True, index=True)
    name = Column(String)
    base_ergo = Column(Float)
    weight = Column(Float)
    rear_mount = Column(String)
    weapon_family = Column(String)
