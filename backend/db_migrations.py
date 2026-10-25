"""Create and upgrade every database's schema at startup.

builds.db, ratings.db and changelog.db hold data we can't regenerate, so their schema
changes are versioned: each database keeps its version in SQLite's PRAGMA user_version
and runs every migration newer than that, each one in a single transaction together
with its version bump. A brand-new database gets the current schema from the models
and is stamped with the latest version without running any migration.

tarkov.db is rebuilt from tarkov.dev on every sync, so it is not versioned: we add any
column (and index) its models have and the live tables lack.

To change a versioned schema, append a function to that database's migration list.
Never edit, remove or reorder one that has shipped - its version is its position in
the list. Use add_column() for new columns so a migration stays a no-op on tables
create_all() already built with that column.
"""

import contextlib
import logging
import os
import sqlite3
import threading
from typing import Callable, Iterator

from sqlalchemy import inspect
from sqlalchemy.engine import Engine
from sqlalchemy.schema import MetaData

from config import RUNTIME_DIR
from database import Base, engine
from database_builds import BuildsBase, builds_engine
from database_changelog import ChangelogBase, changelog_engine
from database_ratings import RatingsBase, ratings_engine

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None

_logger = logging.getLogger(__name__)

Migration = Callable[[sqlite3.Connection], None]


# ---------------------------------------------------
# Helpers for writing migrations
# ---------------------------------------------------


def column_names(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def add_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    """ALTER TABLE ... ADD COLUMN, skipped when the column already exists."""
    if column not in column_names(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


# ---------------------------------------------------
# builds.db
# ---------------------------------------------------


def _builds_001_baseline(conn: sqlite3.Connection) -> None:
    # Everything the old unversioned startup checks added, so a database from any
    # earlier version ends up at the same schema.
    add_column(conn, "public_builds", "ammo_id", "TEXT")
    add_column(conn, "public_builds", "is_rotating", "INTEGER NOT NULL DEFAULT 0")
    add_column(conn, "public_builds", "user_display_name", "TEXT")
    add_column(conn, "public_builds", "user_avatar_url", "TEXT")
    add_column(conn, "public_builds", "tags_json", "TEXT")
    add_column(conn, "server_announcements", "dismissible", "INTEGER NOT NULL DEFAULT 1")
    add_column(conn, "build_comments", "user_display_name", "TEXT")
    add_column(conn, "build_comments", "user_avatar_url", "TEXT")
    # Indexes for hot query paths that create_all only adds to new tables.
    conn.execute("CREATE INDEX IF NOT EXISTS ix_public_builds_ip_hash ON public_builds (ip_hash)")
    conn.execute("CREATE INDEX IF NOT EXISTS ix_build_vote_created_at ON build_votes (created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS ix_build_comments_ip_hash ON build_comments (ip_hash)")


BUILDS_MIGRATIONS: list[Migration] = [
    _builds_001_baseline,
]

# ---------------------------------------------------
# ratings.db and changelog.db
# ---------------------------------------------------

RATINGS_MIGRATIONS: list[Migration] = []
CHANGELOG_MIGRATIONS: list[Migration] = []


# ---------------------------------------------------
# Runner
# ---------------------------------------------------

_local_schema_lock = threading.Lock()


@contextlib.contextmanager
def schema_lock() -> Iterator[None]:
    """Hold this while touching any schema. Prod runs several Gunicorn workers that
    all import main at once, and without it they would race to create tables and
    apply the same migration. flock is released by the kernel if a worker dies."""
    if fcntl is None:
        # Windows (dev and the desktop app) runs a single server process.
        with _local_schema_lock:
            yield
        return
    os.makedirs(RUNTIME_DIR, exist_ok=True)
    fd = os.open(os.path.join(RUNTIME_DIR, "schema.flock"), os.O_CREAT | os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def _connect(path: str) -> sqlite3.Connection:
    # isolation_level=None leaves transactions to us, so each migration and its
    # version bump commit together or not at all (SQLite DDL is transactional).
    return sqlite3.connect(path, timeout=30, isolation_level=None)


def _has_tables(path: str) -> bool:
    if not os.path.exists(path):
        return False
    conn = _connect(path)
    try:
        return conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").fetchone() is not None
    finally:
        conn.close()


def schema_version(path: str) -> int:
    conn = _connect(path)
    try:
        return conn.execute("PRAGMA user_version").fetchone()[0]
    finally:
        conn.close()


def stamp(path: str, version: int) -> None:
    conn = _connect(path)
    try:
        conn.execute(f"PRAGMA user_version = {int(version)}")
    finally:
        conn.close()


def run_migrations(path: str, migrations: list[Migration]) -> int:
    """Apply every migration newer than the database's version and return the new version."""
    conn = _connect(path)
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version > len(migrations):
            # An older build opened data from a newer one (a desktop downgrade). Extra
            # columns are harmless to older code, so we keep going instead of refusing
            # to start, but leave the schema alone.
            _logger.warning("%s is at schema version %d, newer than this build's %d", path, version, len(migrations))
            return version
        for number, migration in enumerate(migrations[version:], start=version + 1):
            conn.execute("BEGIN IMMEDIATE")
            try:
                migration(conn)
                conn.execute(f"PRAGMA user_version = {number}")
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            _logger.info("%s migrated to schema version %d (%s)", path, number, migration.__name__)
            version = number
        return version
    finally:
        conn.close()


def _column_ddl(column, dialect) -> str | None:
    """The ADD COLUMN definition for a model column, or None when SQLite can't add it."""
    if column.primary_key:
        return None
    definition = column.type.compile(dialect=dialect)
    # Render server defaults the way create_all would; fall back to a scalar Python
    # default so rows that already exist get the same value new rows would.
    default = dialect.ddl_compiler(dialect, None).get_column_default_string(column)
    if default is None and column.default is not None and column.default.is_scalar:
        value = column.default.arg
        if isinstance(value, bool):
            default = str(int(value))
        elif isinstance(value, (int, float)):
            default = repr(value)
        elif isinstance(value, str):
            default = "'" + value.replace("'", "''") + "'"
    if not column.nullable:
        if default is None:
            return None
        definition += " NOT NULL"
    if default is not None:
        definition += f" DEFAULT {default}"
    return definition


def sync_model_columns(bind: Engine, metadata: MetaData) -> list[str]:
    """Add every model column and index the live tables lack. Only for databases whose
    rows are regenerated (tarkov.db): it never changes or drops anything, and a column
    it adds stays empty until the next sync fills it."""
    added = []
    with bind.begin() as conn:
        live = inspect(conn)
        tables = set(live.get_table_names())
        for table in metadata.sorted_tables:
            if table.name not in tables:
                continue
            existing = {c["name"] for c in live.get_columns(table.name)}
            for column in table.columns:
                if column.name in existing:
                    continue
                ddl = _column_ddl(column, bind.dialect)
                if ddl is None:
                    _logger.warning("can't add %s.%s to the live table, rebuild the database", table.name, column.name)
                    continue
                conn.exec_driver_sql(f"ALTER TABLE {table.name} ADD COLUMN {column.name} {ddl}")
                added.append(f"{table.name}.{column.name}")
            for index in table.indexes:
                index.create(conn, checkfirst=True)
    return added


# ---------------------------------------------------
# Startup
# ---------------------------------------------------

_VERSIONED = (
    (builds_engine, BuildsBase, BUILDS_MIGRATIONS),
    (ratings_engine, RatingsBase, RATINGS_MIGRATIONS),
    (changelog_engine, ChangelogBase, CHANGELOG_MIGRATIONS),
)


def prepare_databases(status: Callable[[str], None] = lambda _: None) -> None:
    """Create missing tables and bring every schema up to date. `status` gets the
    desktop splash screen's progress markers."""
    with schema_lock():
        status("preparing_database")
        Base.metadata.create_all(bind=engine)
        fresh = []
        for db_engine, base, migrations in _VERSIONED:
            path = db_engine.url.database
            fresh.append(not _has_tables(path))
            base.metadata.create_all(bind=db_engine)

        status("applying_updates")
        sync_model_columns(engine, Base.metadata)
        for (db_engine, _, migrations), is_fresh in zip(_VERSIONED, fresh):
            path = db_engine.url.database
            if is_fresh:
                # create_all just built the current schema, which every migration so far
                # is already part of.
                stamp(path, len(migrations))
            else:
                run_migrations(path, migrations)
