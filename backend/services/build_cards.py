"""Community build card images: drawing them with Kitbash!, storing them on Gitee,
and the background worker that backfills and redraws them."""

import asyncio
import json
import logging
import os
import time

import build_images
from build_images import build_image_key
from config import RUNTIME_DIR
from database import SessionLocal
from database_builds import BuildsSessionLocal
from models_builds import PublicBuild
from models_slots import Slot
from routers.shared import safe_json_loads
from services.gitee import GITEE_RAW_PREFIX, gitee_upload_sync

_logger = logging.getLogger(__name__)


# ---------------------------------------------------
# Background build-image migration worker
# Draws card images for all community builds with Kitbash!
# and stores them permanently in the Gitee asset repo.
# ---------------------------------------------------


def _bp_hex24(s: str) -> str:
    """Port of the frontend _bpHex24 hash.
    Produces a 24-char hex instance ID - must match the JS implementation exactly."""
    MASK = 0xFFFFFFFF
    h1, h2, h3 = 0x6B4A1C7F, 0x3E9D5A2B, 0xD1E4C7A9
    for ch in s:
        c = ord(ch)
        h1 = ((h1 ^ c) * 0x9E3779B9) & MASK
        h2 = ((h2 ^ c) * 0x85EBCA6B) & MASK
        h3 = ((h3 ^ c) * 0xC2B2AE35) & MASK
        h1 ^= (h2 >> 13) ^ (h3 >> 7)
        h2 ^= (h1 >> 17) ^ (h3 >> 5)
        h3 ^= (h1 >> 11) ^ (h2 >> 19)
    h1 = (h1 ^ h2 ^ h3) & MASK
    h2 = (h2 ^ ((h1 * 0x27D4EB2D) & MASK)) & MASK
    h3 = (h3 ^ ((h2 * 0x165667B1) & MASK)) & MASK
    return "".join(f"{v:08x}" for v in (h1, h2, h3))


def build_spt_items(gun_id: str, pairs: list, db=None) -> list:
    """Convert pairs [[slot_id, item_id], ...] to the SPT-format items array
    Kitbash! renders, matching the frontend _bpBuildSptItems() exactly. `db` reads the
    slots from another item database (Arena's); tarkov.db's by default."""
    gun_instance_id = _bp_hex24(gun_id + ":root")
    items = [
        {
            "_id": gun_instance_id,
            "_tpl": gun_id,
            "slotId": "hideout",
            "parentId": "hideout",
        }
    ]

    if not pairs:
        return items

    slot_ids = [p[0] for p in pairs]
    if db is not None:
        slots = db.query(Slot).filter(Slot.id.in_(slot_ids)).all()
    else:
        with SessionLocal() as session:
            slots = session.query(Slot).filter(Slot.id.in_(slot_ids)).all()
    slot_map = {s.id: s for s in slots}

    # Item template id -> its instance ids in the order they were installed. A
    # part installed twice shares slot ids between its copies, so each pair goes
    # to the first copy whose slot is still empty. Pairs list copies and their
    # children in the same breadth-first order, which puts every part back where
    # it was (frontend createSlotParentResolver does the same).
    instances: dict[str, list[str]] = {gun_id: [gun_instance_id]}
    filled: set[tuple[str, str]] = set()

    for slot_id, item_id in pairs:
        slot = slot_map.get(slot_id)
        if not slot:
            raise ValueError(f"Unknown build image slot: {slot_id}")
        game_slot_name = slot.slot_game_name or slot.slot_name
        parent_instance = next(
            (i for i in instances.get(slot.parent_item_id, ()) if (i, slot_id) not in filled),
            None,
        )
        if not parent_instance:
            raise ValueError(f"Unresolved build image parent for slot: {slot_id}")
        filled.add((parent_instance, slot_id))
        instance_id = _bp_hex24(parent_instance + ":" + game_slot_name)
        items.append(
            {
                "_id": instance_id,
                "_tpl": item_id,
                "slotId": game_slot_name,
                "parentId": parent_instance,
            }
        )
        instances.setdefault(item_id, []).append(instance_id)

    return items


# Marks a build whose card waits for Kitbash! to draw every part. Unlike the
# "error:" marker it clears itself on the next worker start, since a restart is
# when a newer Kitbash! with more sprites gets loaded.
CARD_WAITING_PARTS = "wait:kitbash-parts"


def _mark_card_waiting(build_id: int) -> None:
    with BuildsSessionLocal() as db:
        b = db.get(PublicBuild, build_id)
        if b and not (b.card_image_url or "").startswith(GITEE_RAW_PREFIX):
            b.card_image_url = CARD_WAITING_PARTS
            db.commit()


def generate_and_save_build_image(build_id: int, gun_id: str, pairs: list) -> str:
    """Synchronous helper: draws a card image for a single community build with
    Kitbash!, uploads it to Gitee, and saves the URL to the DB.
    Returns "saved", "incomplete" when Kitbash! cannot draw the weapon or every
    part yet (the build is then marked with CARD_WAITING_PARTS), or "failed" on
    any other failure.
    Safe to call from a thread (BackgroundTasks or run_in_executor)."""
    from config import GITEE_TOKEN, GITEE_DRY_RUN

    if not GITEE_TOKEN and not GITEE_DRY_RUN:
        return "failed"
    # Checked up front so a Kitbash! that failed to load isn't mistaken for a
    # build it cannot draw.
    if not build_images.loaded():
        _logger.error("build-image: Kitbash! is not installed or failed to load, cannot draw build %s", build_id)
        return "failed"
    try:
        items = build_spt_items(gun_id, pairs)
        image_bytes, skipped = build_images.render_webp(build_image_key(gun_id, items), items)
    except ValueError as exc:
        _logger.error("build-image: invalid build tree for build %s: %s", build_id, exc)
        return "failed"
    except build_images.Unrenderable as exc:
        # A newer Kitbash! may draw it, so wait rather than fail for good.
        _logger.warning("build-image Kitbash! cannot draw build %s yet: %s", build_id, exc)
        _mark_card_waiting(build_id)
        return "incomplete"
    if skipped:
        # A stored card outlives the missing sprite, so wait until Kitbash! has every part.
        _logger.warning("build-image Kitbash! cannot draw %s in build %s yet", skipped, build_id)
        _mark_card_waiting(build_id)
        return "incomplete"
    return "saved" if _save_build_card(build_id, image_bytes, "webp") else "failed"


def _save_build_card(build_id: int, image_bytes: bytes, ext: str) -> bool:
    """Uploads a card image to Gitee and saves its URL on the build."""
    from config import GITEE_TOKEN, GITEE_DRY_RUN

    content_type = f"image/{'jpeg' if ext == 'jpg' else ext}"
    filename = f"build_{build_id}.{ext}"

    if GITEE_DRY_RUN:
        dry_url = f"dryrun:{GITEE_RAW_PREFIX}{filename}"
        _logger.warning(
            "build-image [DRY RUN]: build %s - %d bytes (%s) - would upload to %s",
            build_id,
            len(image_bytes),
            content_type,
            dry_url.removeprefix("dryrun:"),
        )
        with BuildsSessionLocal() as db:
            b = db.get(PublicBuild, build_id)
            if b:
                b.card_image_url = dry_url
                db.commit()
        return True

    try:
        raw_url = gitee_upload_sync(filename, image_bytes, GITEE_TOKEN)
    except Exception as exc:
        _logger.error("build-image Gitee upload failed for build %s: %s", build_id, exc)
        return False

    with BuildsSessionLocal() as db:
        b = db.get(PublicBuild, build_id)
        if b:
            # version-stamp the URL so a regenerated image is a distinct cache entry
            # instead of colliding with whatever browsers cached under the old timestamp
            b.card_image_url = f"{raw_url}?v={int(time.time())}"
            db.commit()

    _logger.warning("build-image saved for build %s -> %s", build_id, raw_url)
    return True


async def _bg_migrate_build_images(force: bool = False):
    """Continuously draws and uploads card images for every community build
    that doesn't yet have one stored in our own asset repo."""
    from config import GITEE_TOKEN, GITEE_DRY_RUN, DISABLE_BG_MIGRATE

    if DISABLE_BG_MIGRATE and not force:
        _logger.warning("bg-migrate: disabled via DISABLE_BG_MIGRATE - skipping")
        return

    if not GITEE_TOKEN and not GITEE_DRY_RUN:
        _logger.warning("bg-migrate: GITEE_TOKEN not set - build image migration disabled")
        return

    if GITEE_DRY_RUN:
        _logger.warning("bg-migrate: dry-run mode enabled - no files will be uploaded to Gitee")

    # let the server fully settle before starting
    await asyncio.sleep(15)

    # Without a working Kitbash! every attempt fails, and we'd mark every
    # pending build errored one by one, so don't start at all.
    if not await asyncio.to_thread(build_images.loaded):
        _logger.error("bg-migrate: Kitbash! is not installed or failed to load - build image migration disabled")
        return

    # This worker may have loaded a newer Kitbash!, so give builds that were
    # waiting on parts another try.
    with BuildsSessionLocal() as db:
        requeued = (
            db.query(PublicBuild)
            .filter(PublicBuild.card_image_url == CARD_WAITING_PARTS)
            .update({"card_image_url": None}, synchronize_session=False)
        )
        db.commit()
    if requeued:
        _logger.warning("bg-migrate: requeued %s build(s) that were waiting on Kitbash! parts", requeued)

    _logger.warning("bg-migrate: build image migration worker started")
    loop = asyncio.get_event_loop()
    build_id = None

    while True:
        try:
            # find the next build that hasn't been auto-migrated yet;
            # featured builds are prioritised so they look good first;
            # rows marked with the error sentinel are skipped until manually cleared
            with BuildsSessionLocal() as db:
                build = (
                    db.query(PublicBuild)
                    .filter(PublicBuild.game.is_(None))
                    .filter(
                        (PublicBuild.card_image_url == None)  # noqa: E711
                        | (
                            ~PublicBuild.card_image_url.like(GITEE_RAW_PREFIX + "%")
                            & ~PublicBuild.card_image_url.like("error:%")
                            & ~PublicBuild.card_image_url.like("wait:%")
                            & ~PublicBuild.card_image_url.like("dryrun:%")
                        )
                    )
                    .order_by(PublicBuild.is_featured.desc(), PublicBuild.id.asc())
                    .first()
                )
                if build is None:
                    _logger.warning("bg-migrate: all builds have auto-generated images, worker exiting")
                    break

                build_id = build.id
                gun_id = build.gun_id
                gun_name = build.gun_name
                pairs = json.loads(build.pairs_json)

            captured_id, captured_gun_id, captured_pairs = (build_id, gun_id, pairs)
            result = "failed"
            for attempt in range(1, 4):
                _logger.warning(
                    "bg-migrate: generating image for build %s (%s) - attempt %s/3",
                    build_id,
                    gun_name,
                    attempt,
                )
                result = await loop.run_in_executor(
                    None,
                    lambda: generate_and_save_build_image(captured_id, captured_gun_id, captured_pairs),
                )
                # Missing parts stay missing until a newer Kitbash! loads, so retrying is pointless.
                if result != "failed":
                    break
                if attempt < 3:
                    _logger.warning("bg-migrate: attempt %s failed for build %s, retrying in 10s", attempt, build_id)
                    await asyncio.sleep(10)

            if result == "incomplete":
                # generate_and_save_build_image already marked it waiting.
                _logger.warning("bg-migrate: build %s waits for Kitbash! to draw every part", build_id)
                await asyncio.sleep(3)
                continue
            if result == "failed":
                _logger.error("bg-migrate: all 3 attempts failed for build %s, marking as errored", build_id)
                with BuildsSessionLocal() as db:
                    b = db.get(PublicBuild, build_id)
                    if b and not (b.card_image_url or "").startswith(GITEE_RAW_PREFIX):
                        b.card_image_url = "error:gen-failed"
                        db.commit()
                await asyncio.sleep(10)
                continue

            # brief pause after each success so real requests can jump in
            await asyncio.sleep(3)

        except Exception as exc:
            _logger.error("bg-migrate: error on build %s: %s", build_id or "?", exc, exc_info=True)
            await asyncio.sleep(30)  # back off before retrying


_bg_migrate_task: asyncio.Task | None = None


def start_card_migration(force: bool = False) -> bool:
    """Start the card migration worker, unless a run is still going."""
    global _bg_migrate_task
    if _bg_migrate_task and not _bg_migrate_task.done():
        return False
    _bg_migrate_task = asyncio.create_task(_bg_migrate_build_images(force=force))
    return True


# A file, like the solve locks, so two Gunicorn workers can't run the same batch.
# A run that died mid-batch leaves it behind, so it goes stale after an hour.
_CARD_REGEN_LOCK_FILE = os.path.join(RUNTIME_DIR, "card_regen.lock")
_CARD_REGEN_LOCK_STALE_SECONDS = 3600


def acquire_card_regen_lock() -> bool:
    for _ in range(2):  # 2nd pass only runs after clearing a stale lock
        try:
            os.close(os.open(_CARD_REGEN_LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            return True
        except FileExistsError:
            try:
                stale = time.time() - os.path.getmtime(_CARD_REGEN_LOCK_FILE) > _CARD_REGEN_LOCK_STALE_SECONDS
            except OSError:
                continue
            if not stale:
                return False
            try:
                os.remove(_CARD_REGEN_LOCK_FILE)
            except OSError:
                pass
    return False


def regenerate_cards(build_ids: list[int]) -> None:
    """Redraws each build's card in turn, holding the batch lock until done."""
    counts = {"saved": 0, "incomplete": 0, "failed": 0}
    try:
        for build_id in build_ids:
            with BuildsSessionLocal() as db:
                build = db.get(PublicBuild, build_id)
                # Skip builds deleted, or given a card some other way, since the batch was queued.
                if not build or (build.card_image_url or "").startswith(GITEE_RAW_PREFIX):
                    continue
                gun_id, pairs = build.gun_id, safe_json_loads(build.pairs_json) or []
            try:
                result = generate_and_save_build_image(build_id, gun_id, pairs)
            except Exception as exc:
                _logger.error("card-regen: build %s raised: %s", build_id, exc, exc_info=True)
                result = "failed"
            counts[result] += 1
            # A failure keeps whatever marker the build had, so the next batch retries it.
    finally:
        try:
            os.remove(_CARD_REGEN_LOCK_FILE)
        except OSError:
            pass
    _logger.warning(
        "card-regen: done - %s saved, %s still waiting on Kitbash!, %s failed",
        counts["saved"],
        counts["incomplete"],
        counts["failed"],
    )
