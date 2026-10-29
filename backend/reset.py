import hashlib
import json
import os
import sqlite3
import subprocess
import threading
import time
import sys

from solver_cache_epoch import bump_solver_cache_epoch
from ammo_chart import start_refresh as start_chart_refresh

DB_FILE = "tarkov.db"

# Written by the background dev sync when it detects that data actually
# changed. Consumed (and deleted) by GET /dev/sync-notice in routers/system.py, which
# only ever runs when reset.py's dev branch has produced one - production
# never calls reset.py, so this file never appears there.
NOTICE_FILE = "dev_sync_notice.json"


def delete_db():
    if os.path.exists(DB_FILE):
        print("Deleting old database...")
        os.remove(DB_FILE)
    else:
        print("No existing database found.")


def sync_tarkov():
    print("Syncing tarkov.dev data...")
    subprocess.run([sys.executable, "sync_tarkov_dev.py"], check=True)


# Isolated DB used by the dev background sync so the live tarkov.db (and any
# connections uvicorn already has open against it) are never touched until a
# full, fresh copy of the data is ready to go.
SCRATCH_DB = "tarkov_dev_sync_scratch.db"

# Tables sync_tarkov_dev.py rewrites on every run. Order matters for the copy
# below: children deleted before parents, parents inserted before children.
_SYNC_TABLES = (
    "slot_allowed_items",
    "slots",
    "item_offers",
    "armor_pieces",
    "armor_plate_slots",
    "armor_default_inserts",
    "weapon_default_presets",
    "items",
    "traders",
)

# Tables whose content decides whether a resync changed anything worth copying over.
# Not item_offers: prices move on every sync and would make every run look new.
_FINGERPRINT_TABLES = ("items", "armor_pieces", "armor_plate_slots", "armor_default_inserts")


def _items_fingerprint(db_path):
    """Hash of the _FINGERPRINT_TABLES, used to tell whether a resync actually changed anything."""
    if not os.path.exists(db_path):
        return None
    conn = sqlite3.connect(db_path)
    try:
        h = hashlib.sha256()
        for table in _FINGERPRINT_TABLES:
            h.update(table.encode())
            # Rows in a stable order, so the same data always hashes the same
            for row in sorted(repr(r) for r in conn.execute(f"SELECT * FROM {table}")):
                h.update(row.encode("utf-8", "ignore"))
        return h.hexdigest()
    except sqlite3.OperationalError:
        return None
    finally:
        conn.close()


def _sync_to_scratch():
    """Runs the normal sync script against a throwaway DB file, completely
    isolated from the live tarkov.db - no shared connections, no visible
    half-written state, regardless of how long the network fetch takes."""
    if os.path.exists(SCRATCH_DB):
        os.remove(SCRATCH_DB)
    print("Syncing tarkov.dev data into scratch DB...")
    env = {
        **os.environ,
        "DATABASE_URL": f"sqlite:///{SCRATCH_DB}",
        "EFTFORGE_SKIP_SOLVER_CACHE_EPOCH": "1",
    }
    subprocess.run([sys.executable, "sync_tarkov_dev.py"], check=True, env=env)


def _table_columns(conn, schema, table):
    return [row[1] for row in conn.execute(f"PRAGMA {schema}.table_info({table})")]


def _copy_scratch_into_live():
    """Replaces the live tables' rows with the scratch DB's in one transaction,
    so any query running against tarkov.db sees either the full old data or
    the full new data - never a table that's been cleared but not yet refilled.

    Copies by explicit column NAME, not "SELECT *" position - the live table's
    columns are in ALTER-TABLE-append order (i.e. always growing at the end),
    which does not necessarily match the current model's declaration order in
    scratch, so a positional copy can silently shuffle values into the wrong
    columns. Only columns present in both tables are copied; a column that
    exists solely in scratch (freshly added to the model, not yet migrated
    into the live schema) is skipped for this run and picked up once
    db_migrations.py's startup migration adds it to the live table.
    """
    conn = sqlite3.connect(DB_FILE, timeout=10)
    try:
        conn.execute("ATTACH DATABASE ? AS scratch", (SCRATCH_DB,))
        conn.execute("BEGIN IMMEDIATE")
        # A table the live file doesn't have yet (a newer model than the server last ran
        # with) gets the scratch copy's schema
        live_tables = {row[0] for row in conn.execute("SELECT name FROM main.sqlite_master WHERE type = 'table'")}
        for table in _SYNC_TABLES:
            if table not in live_tables:
                (schema,) = conn.execute(
                    "SELECT sql FROM scratch.sqlite_master WHERE type = 'table' AND name = ?", (table,)
                ).fetchone()
                conn.execute(schema)
        for table in _SYNC_TABLES:
            conn.execute(f"DELETE FROM {table}")
        for table in reversed(_SYNC_TABLES):
            live_cols = _table_columns(conn, "main", table)
            scratch_cols = set(_table_columns(conn, "scratch", table))
            cols = ", ".join(c for c in live_cols if c in scratch_cols)
            conn.execute(f"INSERT INTO {table} ({cols}) SELECT {cols} FROM scratch.{table}")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.execute("DETACH DATABASE scratch")
        conn.close()


def _sync_in_background():
    """Sync into scratch, and only touch the live DB (atomically) if the data
    actually changed - writes NOTICE_FILE so the frontend can prompt a refresh."""
    try:
        _sync_to_scratch()
        before = _items_fingerprint(DB_FILE)
        after = _items_fingerprint(SCRATCH_DB)
        if after is not None and after != before:
            _copy_scratch_into_live()
            bump_solver_cache_epoch()
            start_chart_refresh()
            with open(NOTICE_FILE, "w", encoding="utf-8") as f:
                json.dump({"changed": True, "at": time.time()}, f)
            print("Background sync found new data - live DB updated, frontend will be notified.")
        else:
            print("Background sync complete - no data changes detected.")
    except Exception as e:
        print(f"Background sync failed (server keeps running on existing data): {e}")
    finally:
        if os.path.exists(SCRATCH_DB):
            os.remove(SCRATCH_DB)


def seed_other():
    # Add any additional seed scripts here
    # subprocess.run(["python", "other_seed_script.py"], check=True)
    print("No additional seeds configured.")


def start_server_dev():
    print("Starting server (dev mode with --reload)...")
    env = {**os.environ, "EFTFORGE_LOCAL_DEV": "1"}
    subprocess.run([sys.executable, "-m", "uvicorn", "main:app", "--reload"], env=env)


def start_server_prod():
    """Production server: no --reload, multi-worker via Gunicorn + Uvicorn workers."""
    print("Starting server (production)...")
    workers = str(os.cpu_count() or 2)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "gunicorn",
            "main:app",
            "-w",
            workers,
            "-k",
            "uvicorn.workers.UvicornWorker",
            "--bind",
            "0.0.0.0:8000",
        ]
    )


if __name__ == "__main__":
    prod = "--prod" in sys.argv

    if prod:
        delete_db()
        sync_tarkov()
        seed_other()
        start_server_prod()
    else:
        if os.path.exists(NOTICE_FILE):
            os.remove(NOTICE_FILE)

        if os.path.exists(DB_FILE):
            print(f"Using existing {DB_FILE} - starting immediately, syncing in the background...")
            threading.Thread(target=_sync_in_background, daemon=True).start()
        else:
            print("No existing database found - syncing before first start...")
            sync_tarkov()
            seed_other()

        start_server_dev()
