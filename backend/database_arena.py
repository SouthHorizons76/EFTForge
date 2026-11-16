"""Arena's own item database: the same tables as tarkov.db, filled from Arena's game data
snapshot (sync_arena.py), plus the Arena-only tables in models_arena.py.

It only exists where ARENA_SNAPSHOT_PATH is configured. Requests reach it by asking for
?game=arena (routers/shared.py get_game_db)."""

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from config import ARENA_DB_URL, DB_POOL

arena_engine = create_engine(ARENA_DB_URL, connect_args={"check_same_thread": False}, pool_pre_ping=True, **DB_POOL)

ArenaSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=arena_engine)

# Tables only the Arena database has. The item tables themselves come from database.Base.
ArenaBase = declarative_base()
