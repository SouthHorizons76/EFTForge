from sqlalchemy import Column, String
from database import Base


class Trader(Base):
    __tablename__ = "traders"

    id           = Column(String, primary_key=True)
    name         = Column(String)
    image_link   = Column(String, nullable=True)
    image_4x_link = Column(String, nullable=True)
