from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

from config import RATINGS_DB_URL

ratings_engine = create_engine(
    RATINGS_DB_URL,
    connect_args={"check_same_thread": False},
    pool_pre_ping=True,
)
RatingsSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=ratings_engine)
RatingsBase = declarative_base()
