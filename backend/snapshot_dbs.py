"""
snapshot_dbs.py - backs up the three user-data SQLite databases.

Copies ratings.db and builds.db into a backups/ directory
next to this script, timestamped in UTC+8.  Keeps the 30 most recent
snapshots per database; older ones are pruned automatically.

Run alongside the 4:00 AM UTC+8 resync cron:
    0 20 * * * cd /path/to/backend && python snapshot_dbs.py >> /var/log/db_snapshot.log 2>&1
(20:00 UTC = 04:00 UTC+8)
"""

import os
import re
import shutil
from datetime import datetime, timezone, timedelta

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
BACKUP_DIR  = os.path.join(SCRIPT_DIR, "backups")
KEEP        = 30  # snapshots to retain per database

DATABASES = ["ratings.db", "builds.db"]

# timestamp in UTC+8
UTC8 = timezone(timedelta(hours=8))
stamp = datetime.now(UTC8).strftime("%Y%m%d_%H%M%S")


def snapshot():
    os.makedirs(BACKUP_DIR, exist_ok=True)

    for db_name in DATABASES:
        src = os.path.join(SCRIPT_DIR, db_name)
        if not os.path.exists(src):
            print(f"SKIP  {db_name} (not found)")
            continue

        stem = db_name.replace(".db", "")
        dst  = os.path.join(BACKUP_DIR, f"{stem}_{stamp}.db")
        shutil.copy2(src, dst)
        print(f"OK    {dst}")

        # prune old snapshots for this database, keeping the most recent KEEP files
        pattern = re.compile(rf"^{re.escape(stem)}_\d{{8}}_\d{{6}}\.db$")
        existing = sorted(
            f for f in os.listdir(BACKUP_DIR) if pattern.match(f)
        )
        for old in existing[:-KEEP]:
            os.remove(os.path.join(BACKUP_DIR, old))
            print(f"PRUNED {old}")


if __name__ == "__main__":
    snapshot()
