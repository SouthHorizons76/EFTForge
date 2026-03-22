from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

from config import BUILDS_DB_URL

builds_engine = create_engine(
    BUILDS_DB_URL,
    connect_args={"check_same_thread": False},
    pool_pre_ping=True,
)
BuildsSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=builds_engine)
BuildsBase = declarative_base()
