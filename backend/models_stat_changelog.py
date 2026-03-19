from datetime import datetime
from sqlalchemy import Column, Integer, String, Float, DateTime
from database import Base


class StatChangeLog(Base):
    __tablename__ = "stat_change_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    item_id = Column(String, nullable=False, index=True)
    item_name = Column(String, nullable=False)
    stat_name = Column(String, nullable=False)
    old_value = Column(Float, nullable=True)
    new_value = Column(Float, nullable=True)
    detected_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    sync_source = Column(String, nullable=False, default="scheduled")
