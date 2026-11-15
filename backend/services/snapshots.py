"""Keeps the item data in step with the game data snapshots (game_snapshot.py).

Every CHECK_SECONDS, and once shortly after startup:

1. Where SNAPSHOT_SOURCE_URL is set (the desktop app, by default the live site), download
   any newer snapshot it publishes (routers/snapshots.py) into the local snapshot folders.
2. Rebuild the Arena database when its snapshot changed (services/arena.py refresh).
3. Apply a changed main game snapshot to tarkov.db straight away, instead of waiting for
   the next tarkov.dev sync, which applies it too.
4. Take the published Arena presets the Arena data now finds a problem with out of the
   community (services/arena_preset_check.py), once per data change.

Nothing here ever runs without a snapshot configured, and a failure leaves the data as
it was: the next check tries again.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import threading
import time

import requests

from config import (
    ARENA_SNAPSHOT_PATH,
    DESKTOP_APP_VERSION,
    DESKTOP_MODE,
    GAME_SNAPSHOT_PATH,
    RUNTIME_DIR,
    SNAPSHOT_SOURCE_URL,
)

_logger = logging.getLogger(__name__)

CHECK_SECONDS = 600
GAMES = ("eft", "arena")
# A snapshot's file name as the source lists it: a plain name, never a path
_FILE_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]{0,80}\.json$")
_USER_AGENT = f"EFTForge-Desktop/{DESKTOP_APP_VERSION}" if DESKTOP_MODE else "EFTForge"
# The notice file the frontend's "new data, reload" toast polls (routers/system.py)
_NOTICE_FILE = os.path.join(RUNTIME_DIR, "dev_sync_notice.json")

_check_lock = threading.Lock()
_task: asyncio.Task | None = None
_status = {
    "checking": False,
    "checked_at": None,
    "error": None,
    "changed": False,
}


def configured() -> bool:
    return bool(GAME_SNAPSHOT_PATH or ARENA_SNAPSHOT_PATH)


def local_path(game: str) -> str:
    return ARENA_SNAPSHOT_PATH if game == "arena" else GAME_SNAPSHOT_PATH


# ----------------------------------------------------------------------
# Downloading from the source
# ----------------------------------------------------------------------


def _read_index(folder: str) -> list:
    try:
        with open(os.path.join(folder, "index.json"), encoding="utf-8") as f:
            entries = json.load(f).get("snapshots") or []
        return [e for e in entries if isinstance(e, dict)]
    except (OSError, ValueError, AttributeError):
        return []


def _write_json(path: str, obj) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def fetch_remote(game: str, session: requests.Session | None = None) -> bool:
    """Download the source's newest snapshot for `game` when ours isn't it. Returns
    whether a new one arrived. The old one stays until the new one is complete and
    readable, so a failed download never costs the data we had."""
    from game_snapshot import SnapshotError, load_snapshot

    folder = local_path(game)
    if not SNAPSHOT_SOURCE_URL or not folder:
        return False
    http = session or requests
    headers = {"User-Agent": _USER_AGENT}
    res = http.get(f"{SNAPSHOT_SOURCE_URL}/snapshots/{game}/index.json", timeout=15, headers=headers)
    if res.status_code == 404:
        return False  # the source publishes none for this game
    res.raise_for_status()
    entries = [e for e in (res.json().get("snapshots") or []) if isinstance(e, dict)]
    newest = max(entries, key=lambda e: str(e.get("detected") or ""), default=None)
    name = newest.get("file") if newest else None
    if not isinstance(name, str) or not _FILE_RE.match(name):
        return False
    os.makedirs(folder, exist_ok=True)
    local = _read_index(folder)
    if local and local[0].get("file") == name and os.path.isfile(os.path.join(folder, name)):
        return False

    target = os.path.join(folder, name)
    tmp = target + ".part"
    with http.get(f"{SNAPSHOT_SOURCE_URL}/snapshots/{game}/{name}", timeout=120, headers=headers, stream=True) as body:
        body.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in body.iter_content(chunk_size=1 << 16):
                f.write(chunk)
    try:
        load_snapshot(tmp)
    except SnapshotError:
        os.remove(tmp)
        raise
    os.replace(tmp, target)
    _write_json(os.path.join(folder, "index.json"), {"snapshots": [{**newest, "file": name}]})
    # Only the one we now use is kept
    for other in os.listdir(folder):
        if other.endswith(".json") and other not in (name, "index.json"):
            try:
                os.remove(os.path.join(folder, other))
            except OSError:
                pass
    _logger.info("Snapshots: downloaded %s %s (%s).", game, newest.get("version"), name)
    return True


# ----------------------------------------------------------------------
# Using what we have
# ----------------------------------------------------------------------


def apply_game_snapshot() -> bool:
    """Apply the main game snapshot to tarkov.db if it isn't the one applied last."""
    from database import SessionLocal
    from game_snapshot import applied_snapshot, apply_to_main_db, file_stamp, pick_snapshot_file

    file_path = pick_snapshot_file(GAME_SNAPSHOT_PATH) if GAME_SNAPSHOT_PATH else None
    if not file_path or applied_snapshot().get("stamp") == file_stamp(file_path):
        return False
    from services import sync

    if sync.is_sync_running():
        return False  # the sync applies it itself when it finishes
    with SessionLocal() as db:
        apply_to_main_db(db, file_path)
    from ammo_chart import start_refresh
    from services.solver_cache import clear_solver_caches
    from solver_cache_epoch import bump_solver_cache_epoch

    bump_solver_cache_epoch()
    clear_solver_caches()
    start_refresh()
    return True


def status() -> dict:
    """What the desktop settings show: per game, the client the data is from and when it
    was checked."""
    from game_snapshot import applied_snapshot
    from services import arena

    out = dict(_status)
    game = applied_snapshot()
    out["eft"] = {"version": game.get("version"), "detected": game.get("detected")} if game else None
    out["arena"] = None
    if arena.available():
        from database_arena import ArenaSessionLocal

        with ArenaSessionLocal() as db:
            snap = arena.setting(db, "snapshot", {}) or {}
        out["arena"] = {"version": snap.get("version"), "detected": snap.get("detected")}
    out["source"] = SNAPSHOT_SOURCE_URL or None
    return out


def check_now() -> bool:
    """One full check. Returns whether any data changed. One at a time per process; the
    schema lock keeps the workers of a multi-process server from doing it together."""
    from db_migrations import schema_lock
    from services import arena

    if not configured() or not _check_lock.acquire(blocking=False):
        return False
    _status.update(checking=True, error=None)
    changed = False
    try:
        with schema_lock():
            if SNAPSHOT_SOURCE_URL:
                with requests.Session() as session:
                    for game in GAMES:
                        try:
                            fetch_remote(game, session)
                        except Exception as exc:  # one game failing never stops the other
                            _logger.warning("Snapshots: could not download %s: %s", game, exc)
                            _status["error"] = str(exc)
            if arena.refresh_locked():
                changed = True
            try:
                if apply_game_snapshot():
                    changed = True
            except Exception as exc:
                _logger.warning("Snapshots: could not apply the game snapshot: %s", exc)
                _status["error"] = str(exc)
            # Published Arena presets the new data broke come out of the community
            try:
                from services import arena_preset_check

                arena_preset_check.recheck_if_needed()
            except Exception as exc:
                _logger.warning("Snapshots: could not check the published Arena presets: %s", exc)
        if changed:
            try:
                _write_json(_NOTICE_FILE, {"changed": True, "kind": "snapshot", "at": time.time()})
            except OSError:
                pass
        # BlastGang's shop drawings, made before anyone opens the shop (only the missing ones)
        try:
            from services import shop_art

            shop_art.warm()
        except Exception as exc:
            _logger.warning("Snapshots: could not draw the BlastGang shop: %s", exc)
    except Exception as exc:
        _logger.warning("Snapshots: check failed, keeping the data we have: %s", exc)
        _status["error"] = str(exc)
    finally:
        _status.update(checking=False, checked_at=time.time(), changed=changed)
        _check_lock.release()
    return changed


async def _loop():
    await asyncio.sleep(5)  # let the server come up first
    while True:
        await asyncio.get_event_loop().run_in_executor(None, check_now)
        await asyncio.sleep(CHECK_SECONDS)


def start_snapshot_sync() -> None:
    """Keep the item data in step with its snapshots. Does nothing without any."""
    global _task
    if configured() and _task is None:
        _task = asyncio.create_task(_loop())
