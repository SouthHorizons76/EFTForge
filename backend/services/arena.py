"""Arena mode's side of the API: whether its database is there, what it adds to an item,
and rebuilding it when its snapshot changes (sync_arena.py, run by services/snapshots.py)."""

import json
import logging
import os
import time

from config import ARENA_SNAPSHOT_PATH
from database_arena import arena_engine
from models_arena import ArenaItem, ArenaSetting

_logger = logging.getLogger(__name__)

_AVAILABLE_TTL = 30.0
_available: tuple[float, bool] = (0.0, False)


def configured() -> bool:
    return bool(ARENA_SNAPSHOT_PATH)


def available() -> bool:
    """Whether Arena's database has been built. Asked on every Arena request, so the
    answer is kept for a moment."""
    global _available
    now = time.monotonic()
    if now - _available[0] < _AVAILABLE_TTL and _available[0]:
        return _available[1]
    import sync_arena

    built = configured() and sync_arena.built_stamp() is not None
    _available = (now, built)
    return built


def db_stamp() -> str:
    """Changes whenever the Arena database is rewritten, for the catalog's data version."""
    if not configured():
        return ""
    path = os.path.abspath(arena_engine.url.database or "")
    parts = []
    # A write may only reach the -wal file until SQLite checkpoints it, as tarkov.db's version counts
    for name in (path, path + "-wal"):
        try:
            stat = os.stat(name)
        except FileNotFoundError:
            if name == path:
                return ""
            continue
        except OSError:
            return ""
        parts.append(f"{stat.st_mtime_ns}:{stat.st_size}")
    return "|".join(parts)


def is_arena(db) -> bool:
    """Whether a session reads Arena's database."""
    try:
        return db.get_bind() is arena_engine
    except Exception:
        return False


def _split(text) -> list:
    return [part for part in (text or "").split(",") if part]


def item_fields(row: ArenaItem) -> dict:
    return {
        "meta_points": row.meta_points,
        "meta_group": row.meta_group,
        # No class listed means every class may carry it
        "arena_class_ids": _split(row.class_ids),
        # Where a weapon is carried (Primary, Holster, Scabbard), null for everything else
        "gear_slot": row.gear_slot,
        # {class id: [item ids]} a class may not mount on, or load into, this weapon
        "arena_excluded_mods": json.loads(row.excluded_mods) if row.excluded_mods else {},
        "arena_excluded_ammo": json.loads(row.excluded_ammo) if row.excluded_ammo else {},
    }


def extras(db, item_ids=None) -> dict:
    """{item id: the fields Arena adds to that item's DTO}. Empty for the main game, so a
    DTO built with `**extras.get(item.id, {})` is unchanged there."""
    if not is_arena(db):
        return {}
    query = db.query(ArenaItem)
    if item_ids is not None:
        ids = list(item_ids)
        if not ids:
            return {}
        query = query.filter(ArenaItem.item_id.in_(ids))
    return {row.item_id: item_fields(row) for row in query}


def preset_points(gun, factory_ids: list, extras: dict) -> dict:
    """{"preset_meta_points": the weapon's default preset in meta points} for a gun DTO:
    the weapon and every part of its factory preset. {} outside Arena (empty extras)."""
    if not extras:
        return {}
    ids = factory_ids if gun.id in factory_ids else [gun.id, *factory_ids]
    total = sum((extras.get(item_id) or {}).get("meta_points") or 0 for item_id in ids)
    return {"preset_meta_points": round(total, 1)}


def setting(db, key: str, default=None):
    row = db.get(ArenaSetting, key)
    return json.loads(row.value) if row else default


def refresh_locked() -> dict | None:
    """Rebuild the Arena database if its snapshot changed. The caller holds the schema
    lock (services/snapshots.py), so the workers of a multi-process server never build
    it together. A bad snapshot is logged and the previous data stays."""
    global _available
    if not configured():
        return None
    import sync_arena

    try:
        summary = sync_arena.sync_arena()
    except Exception as exc:
        _logger.warning("Arena sync failed, keeping the previous data: %s", exc)
        return None
    if summary:
        _available = (0.0, False)
    return summary
