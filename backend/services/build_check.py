"""Whether a gun build can actually be used in game: every part on it (the gun included) has
something in each of its required slots (a receiver, a barrel, a pistol grip...). The game
won't let a weapon missing one be equipped.

The builder marks those slots and refuses to publish such a build
(frontend/modules/build-codes.js missingRequiredSlots), and publishing checks it here
again. Builds already published are checked again whenever the slot data changes, and one
the data update left incomplete is taken out of the community and its publisher told
(recheck_published), as services/arena_preset_check.py does for Arena presets.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from collections import Counter

from config import RUNTIME_DIR

_logger = logging.getLogger(__name__)

# Bump whenever the check changes, so the builds already published are checked again
CHECK_VERSION = 1
_STAMP_FILE = os.path.join(RUNTIME_DIR, "build_check.json")
CHECK_SECONDS = 600

# A data update that would take more than this share of the published builds out at once is
# far more likely broken data (a bad sync) than broken builds, and unlisting can't be undone:
# then nothing goes, the error log says so, and the check runs again on the next pass. Once
# the data is confirmed right, recheck_published(..., force=True) takes them out by hand.
MAX_UNLIST_SHARE = 0.1
# Below this many, a data update may always take them out
MIN_UNLIST_GUARD = 10


def unlist_allowed(broken: int, total: int, what: str) -> bool:
    """Whether a recheck may take `broken` of `total` published builds out at once."""
    if broken <= max(MIN_UNLIST_GUARD, total * MAX_UNLIST_SHARE):
        return True
    _logger.error(
        "%s: the current data would unlist %d of %d published at once, which looks like broken data;"
        " left them all listed. If the data is right, run recheck_published(..., force=True) by hand.",
        what,
        broken,
        total,
    )
    return False


def required_slots(db) -> dict[str, list[tuple[str, str]]]:
    """{item id: [(slot id, slot name)]} for every item with a required slot."""
    from models_slots import Slot

    out: dict[str, list[tuple[str, str]]] = {}
    rows = db.query(Slot.id, Slot.parent_item_id, Slot.slot_name).filter(Slot.required == True)  # noqa: E712
    for slot_id, owner, name in rows:
        out.setdefault(owner, []).append((slot_id, name or ""))
    return out


def missing_required(required: dict, gun_id: str, pairs: list) -> list[tuple[str, str, str]]:
    """The required slots a build leaves empty, as (owner item id, slot id, slot name), one per
    empty copy. A part on the build twice needs each of its required slots filled twice."""
    pairs = [p for p in pairs or [] if isinstance(p, (list, tuple)) and len(p) >= 2]
    owners = Counter([gun_id] + [p[1] for p in pairs])
    filled = Counter(p[0] for p in pairs)
    out = []
    for owner, count in owners.items():
        for slot_id, name in required.get(owner, ()):
            out.extend((owner, slot_id, name) for _ in range(count - min(filled[slot_id], count)))
    return out


def _stamp(required: dict) -> dict:
    rows = sorted((owner, slot_id) for owner, slots in required.items() for slot_id, _ in slots)
    digest = hashlib.sha256(json.dumps(rows).encode()).hexdigest()[:16]
    return {"data": digest, "version": CHECK_VERSION}


def recheck_published(builds_db, db, force: bool = False) -> int | None:
    """Take every published gun build the current slot data finds incomplete out of the
    community, telling its publisher. Returns how many went, or None when there were too
    many to trust (unlist_allowed) and none went."""
    from models_builds import PendingNotification, PublicBuild
    from services.gitee import gitee_delete_image

    required = required_slots(db)
    published = builds_db.query(PublicBuild).filter(PublicBuild.game.is_(None)).all()
    broken = []
    for build in published:
        try:
            pairs = json.loads(build.pairs_json or "[]")
        except ValueError:
            continue
        if not isinstance(pairs, list):
            continue
        missing = missing_required(required, build.gun_id, pairs)
        if missing:
            broken.append((build, sorted({name for _, _, name in missing})))
    if not force and not unlist_allowed(len(broken), len(published), "Community builds"):
        return None

    gone: list[tuple[int, str | None]] = []
    for build, slots in broken:
        if build.ip_hash != "admin":
            builds_db.add(
                PendingNotification(
                    ip_hash=build.ip_hash,
                    type="build_unlist",
                    data_json=json.dumps(
                        {
                            "build_name": build.build_name,
                            "gun_id": build.gun_id,
                            "gun_name": build.gun_name,
                            "slots": slots,
                        }
                    ),
                )
            )
        gone.append((build.id, build.card_image_url))
        builds_db.delete(build)
        _logger.info("Community builds: unlisted %s (%s), missing %s", build.id, build.build_name, ",".join(slots))
    builds_db.commit()
    for build_id, card_image_url in gone:
        gitee_delete_image(card_image_url, build_id)
    return len(gone)


def _read_stamp() -> dict:
    try:
        with open(_STAMP_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def recheck_if_needed() -> int:
    """Check the published builds again when the slot data, or this check, changed since the
    last time. Holds the schema lock, so one worker of a multi-process server does it."""
    from database import SessionLocal
    from database_builds import BuildsSessionLocal
    from db_migrations import schema_lock
    from services import sync

    # Mid sync the slot tables are being rewritten: wait for the finished data
    if sync.is_sync_running():
        return 0
    with schema_lock():
        with SessionLocal() as db:
            required = required_slots(db)
            # An empty slot table is a database still being made, not data saying nothing's required
            if not required:
                return 0
            stamp = _stamp(required)
            if _read_stamp() == stamp:
                return 0
            with BuildsSessionLocal() as builds_db:
                removed = recheck_published(builds_db, db)
            # Too many to trust: nothing went, and the next pass checks again
            if removed is None:
                return 0
        tmp = _STAMP_FILE + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(stamp, f)
            os.replace(tmp, _STAMP_FILE)
        except OSError as exc:
            _logger.warning("Community builds: could not record the check: %s", exc)
    return removed


async def _loop():
    await asyncio.sleep(20)  # let the server come up first
    while True:
        try:
            await asyncio.get_event_loop().run_in_executor(None, recheck_if_needed)
        except Exception as exc:
            _logger.warning("Community builds: could not check the published builds: %s", exc)
        await asyncio.sleep(CHECK_SECONDS)


_task: asyncio.Task | None = None


def start_build_check() -> None:
    """Check the published builds after every data change (tarkov.dev syncs run from cron
    as their own process, so we watch the data rather than hook the sync)."""
    global _task
    if _task is None:
        _task = asyncio.create_task(_loop())
