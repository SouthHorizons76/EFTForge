from sqlalchemy import Column, String
from database import Base


class Trader(Base):
    __tablename__ = "traders"

    id              = Column(String, primary_key=True)
    name            = Column(String)
    normalized_name = Column(String, nullable=True, index=True)
    image_link      = Column(String, nullable=True)
    image_4x_link   = Column(String, nullable=True)
