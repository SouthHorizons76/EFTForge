"""
migrate_changelog.py - one-off migration of stat_change_log rows from an old
tarkov.db backup into the new changelog.db.

Usage:
    py migrate_changelog.py <path-to-old-tarkov.db>

Skips rows that already exist in changelog.db (matched on item_id + stat_name
+ detected_at) so it is safe to run multiple times or against multiple backups.
"""

import sys
import sqlite3
import os

CHANGELOG_DB = os.path.join(os.path.dirname(__file__), "changelog.db")


def migrate(source_path: str):
    if not os.path.exists(source_path):
        print(f"ERROR: source DB not found: {source_path}")
        sys.exit(1)

    src = sqlite3.connect(source_path)
    dst = sqlite3.connect(CHANGELOG_DB)

    src.row_factory = sqlite3.Row
    src_cur = src.cursor()

    # Read all rows from the old DB
    try:
        src_cur.execute(
            "SELECT item_id, item_name, stat_name, old_value, new_value, "
            "detected_at, sync_source FROM stat_change_log ORDER BY detected_at"
        )
        rows = src_cur.fetchall()
    except sqlite3.OperationalError as e:
        print(f"ERROR reading source: {e}")
        sys.exit(1)

    print(f"Found {len(rows)} rows in source DB.")

    # Ensure table exists in changelog.db
    dst.execute("""
        CREATE TABLE IF NOT EXISTS stat_change_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id     TEXT    NOT NULL,
            item_name   TEXT    NOT NULL,
            stat_name   TEXT    NOT NULL,
            old_value   REAL,
            new_value   REAL,
            detected_at DATETIME NOT NULL,
            sync_source TEXT    NOT NULL DEFAULT 'scheduled'
        )
    """)
    dst.execute(
        "CREATE INDEX IF NOT EXISTS ix_stat_change_log_item_id ON stat_change_log (item_id)"
    )

    # Build a set of existing (item_id, stat_name, detected_at) to skip dupes
    existing = {
        (r[0], r[1], r[2])
        for r in dst.execute(
            "SELECT item_id, stat_name, detected_at FROM stat_change_log"
        )
    }

    inserted = 0
    skipped = 0
    for row in rows:
        key = (row["item_id"], row["stat_name"], row["detected_at"])
        if key in existing:
            skipped += 1
            continue
        dst.execute(
            "INSERT INTO stat_change_log "
            "(item_id, item_name, stat_name, old_value, new_value, detected_at, sync_source) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                row["item_id"],
                row["item_name"],
                row["stat_name"],
                row["old_value"],
                row["new_value"],
                row["detected_at"],
                row["sync_source"],
            ),
        )
        existing.add(key)
        inserted += 1

    dst.commit()
    src.close()
    dst.close()

    print(f"Done. Inserted {inserted}, skipped {skipped} duplicates.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: py migrate_changelog.py <path-to-old-tarkov.db>")
        sys.exit(1)
    migrate(sys.argv[1])
