from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

from config import CHANGELOG_DB_URL

changelog_engine = create_engine(
    CHANGELOG_DB_URL,
    connect_args={"check_same_thread": False},
    pool_pre_ping=True,
)
ChangelogSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=changelog_engine)
ChangelogBase = declarative_base()
