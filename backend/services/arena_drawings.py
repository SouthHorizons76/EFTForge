"""Arena preset drawings: each weapon and each helmet wearing parts in a published preset,
drawn by Kitbash! once and stored on Gitee beside the gun build cards (services/build_cards.py).
Preset cards on the page use these and never ask Kitbash! themselves, so opening the
community's presets costs the renderer nothing.

A preset's drawings_json is NULL until it's drawn, then {"state", "images": {slot: url}}:
"saved" with every drawing, "wait" when Kitbash! can't draw some part yet (the drawings it
could make are kept, and the next worker start tries again), "error" when it failed outright.
The page (arena-loadout.js useDrawings) files each address under the key it would have asked
Kitbash! for, so the requests made here must match the page's (_weaponDrawing, _helmetDrawing).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time

import build_images
from build_images import build_image_key, loaded_image_key
from database_builds import BuildsSessionLocal
from models_builds import PublicBuild
from services.arena_preset_check import WEAPON_SLOTS, Rules, _weapon_loads
from services.build_cards import build_spt_items
from services.gitee import GITEE_RAW_PREFIX, gitee_delete_image, gitee_upload_sync

_logger = logging.getLogger(__name__)

GAME_ARENA = "arena"
# BlastGang's shop: its cards have no board, so nothing to draw
BLAST_GANG = "blastgang"
# Any 24 hex ids do for a helmet's SPT items (arena-loadout.js _helmetDrawing)
_HELMET_ROOT = "0" * 24


def _weapon_job(rules: Rules, arena_db, w: dict):
    """(render key, items, ammo) for a weapon as the page asks for it: its magazine full of the
    round it fires when it holds any rounds, and the round it fires chambered either way."""
    gun = w.get("gunId")
    if not gun:
        return None
    pairs = [p for p in w.get("pairs") or [] if isinstance(p, list) and len(p) >= 2]
    items = build_spt_items(gun, pairs, arena_db)
    cap = 0
    for pair in pairs:
        if rules.capacity(pair[1]) > 0:
            cap = rules.capacity(pair[1])
    loads = _weapon_loads(w, cap)
    fires = w.get("ammoId") or (loads[-1][0] if loads else None)
    # /build-image loads the ammo only with assume_full_mag, which the page sends for a
    # weapon whose magazine holds rounds
    ammo = fires if fires and sum(n for _, n in loads) > 0 else None
    return loaded_image_key(build_image_key(gun, items), ammo, None), items, ammo


def _helmet_job(worn: dict):
    parts = {k: v for k, v in (worn.get("parts") or {}).items() if v}
    if not worn.get("id") or not parts:
        return None
    items = [{"_id": _HELMET_ROOT, "_tpl": worn["id"], "parentId": "hideout", "slotId": "hideout"}]
    for i, slot in enumerate(sorted(parts)):
        items.append(
            {"_id": _HELMET_ROOT[:-2] + f"{i + 1:02d}", "_tpl": parts[slot], "parentId": _HELMET_ROOT, "slotId": slot}
        )
    key = build_image_key(worn["id"], items)
    # A helmet is drawn with its attachments switched on (routers/images.py), under a key of its own
    on = [items[0]] + [{**it, "upd": {"Togglable": {"On": True}}} for it in items[1:]]
    return key + ":on", on, None


def preset_jobs(arena_db, loadout: dict) -> dict:
    """{slot: (render key, items, ammo)} for everything a preset's card draws."""
    rules = Rules(arena_db)
    jobs = {}
    for slot in WEAPON_SLOTS:
        w = (loadout.get("weapons") or {}).get(slot)
        if isinstance(w, dict):
            job = _weapon_job(rules, arena_db, w)
            if job:
                jobs[slot] = job
    helmet = (loadout.get("gear") or {}).get("Headwear")
    if isinstance(helmet, dict):
        job = _helmet_job(helmet)
        if job:
            jobs["Headwear"] = job
    return jobs


def _store(filename: str, data: bytes) -> str:
    from config import GITEE_DRY_RUN, GITEE_TOKEN

    if GITEE_DRY_RUN:
        _logger.warning("arena-drawings [DRY RUN]: %s - %d bytes", filename, len(data))
        return f"dryrun:{GITEE_RAW_PREFIX}{filename}"
    raw = gitee_upload_sync(filename, data, GITEE_TOKEN)
    # Version stamped so a redrawn picture is a new cache entry
    return f"{raw}?v={int(time.time())}"


def _set_drawings(build_id: int, value: dict) -> bool:
    """Save the drawings unless the preset went meanwhile. Returns whether it's still there."""
    with BuildsSessionLocal() as db:
        b = db.get(PublicBuild, build_id)
        if not b:
            return False
        b.drawings_json = json.dumps(value, separators=(",", ":"))
        db.commit()
        return True


def draw_preset(build_id: int) -> str:
    """Draw one published preset's weapons and helmet and store them. Returns "saved",
    "wait", "error", or "skipped" when there's nothing to do. Blocking; run it in a thread."""
    from config import GITEE_DRY_RUN, GITEE_TOKEN
    from database_arena import ArenaSessionLocal
    from services import arena

    if not GITEE_TOKEN and not GITEE_DRY_RUN:
        return "skipped"
    if not arena.available() or not build_images.loaded():
        return "skipped"
    with BuildsSessionLocal() as db:
        b = db.get(PublicBuild, build_id)
        if not b or b.game != GAME_ARENA:
            return "skipped"
        try:
            loadout = json.loads(b.loadout_json or "{}")
        except ValueError:
            loadout = None
        old = _images_of(b.drawings_json)
        nothing_to_draw = b.gun_id == BLAST_GANG or not isinstance(loadout, dict)
    if nothing_to_draw:
        _set_drawings(build_id, {"state": "saved", "images": {}})
        return "skipped"

    images: dict[str, str] = {}
    state = "saved"
    try:
        with ArenaSessionLocal() as arena_db:
            jobs = preset_jobs(arena_db, loadout)
    except ValueError as exc:
        _logger.error("arena-drawings: preset %s has a build Kitbash! can't take: %s", build_id, exc)
        jobs = {}
        state = "error"
    for slot, (key, items, ammo) in jobs.items():
        try:
            data, skipped = build_images.render_webp(key, items, ammo, None)
        except build_images.Unrenderable as exc:
            # A newer Kitbash! may draw it: the page shows the item's own picture meanwhile
            _logger.warning("arena-drawings: Kitbash! can't draw %s of preset %s yet: %s", slot, build_id, exc)
            state = "wait"
            continue
        if skipped:
            # Drawn without the parts it can't draw yet, as the page would draw it; try again later
            state = "wait"
        try:
            images[slot] = _store(f"arena_{build_id}_{slot}.webp", data)
        except Exception as exc:
            # Marked, so the worker doesn't retry it on every pass; the cards show the items'
            # own pictures for the slots it misses
            _logger.error("arena-drawings: Gitee upload failed for preset %s %s: %s", build_id, slot, exc)
            state = "error"
    if not _set_drawings(build_id, {"state": state, "images": images}):
        # Unlisted while it was being drawn: take its pictures away again
        delete_drawings(json.dumps({"images": images}), build_id)
        return "skipped"
    # A slot drawn before that couldn't be drawn this time: its old picture goes (a slot drawn
    # again overwrote its own file)
    for slot, url in old.items():
        if slot not in images:
            gitee_delete_image(url, build_id)
    return state


def _images_of(drawings_json: str | None) -> dict:
    try:
        data = json.loads(drawings_json) if drawings_json else {}
    except ValueError:
        return {}
    images = data.get("images") if isinstance(data, dict) else None
    return images if isinstance(images, dict) else {}


def public_drawings(drawings_json: str | None) -> dict:
    """{slot: url} for the page: only real addresses, never a dry run's."""
    return {
        slot: url
        for slot, url in _images_of(drawings_json).items()
        if isinstance(url, str) and url.startswith(("https://", "http://"))
    }


def delete_drawings(drawings_json: str | None, build_id: int) -> None:
    """Best effort: take a preset's pictures off Gitee. Never raises."""
    for url in _images_of(drawings_json).values():
        gitee_delete_image(url, build_id)


# ---------------------------------------------------
# Background worker: draws every published preset that has no drawings yet (the ones from
# before this existed, and any whose publish-time drawing didn't happen), one at a time
# ---------------------------------------------------

_task: asyncio.Task | None = None

# Every worker process of the server runs the worker below, so each preset is claimed before
# it's drawn: only the worker whose claim landed draws it. A claim older than this was a
# worker that died mid draw, and the preset is free again.
_CLAIM_STALE_SECONDS = 600
_CLAIM_PREFIX = '{"state":"drawing"'


def claim(build_id: int) -> bool:
    """Mark an undrawn preset as being drawn by us. False when another worker got it first."""
    value = json.dumps({"state": "drawing", "at": int(time.time())}, separators=(",", ":"))
    with BuildsSessionLocal() as db:
        claimed = (
            db.query(PublicBuild)
            .filter(PublicBuild.id == build_id, PublicBuild.drawings_json.is_(None))
            .update({"drawings_json": value}, synchronize_session=False)
        )
        db.commit()
    return claimed == 1


def release_stale_claims() -> int:
    """Free the presets whose claim outlived its worker. Returns how many."""
    now = time.time()
    freed = 0
    with BuildsSessionLocal() as db:
        rows = (
            db.query(PublicBuild)
            .filter(PublicBuild.game == GAME_ARENA, PublicBuild.drawings_json.like(_CLAIM_PREFIX + "%"))
            .all()
        )
        for b in rows:
            try:
                at = float(json.loads(b.drawings_json).get("at") or 0)
            except (ValueError, AttributeError, TypeError):
                at = 0
            if now - at > _CLAIM_STALE_SECONDS:
                b.drawings_json = None
                freed += 1
        db.commit()
    return freed


async def _worker():
    from config import GITEE_DRY_RUN, GITEE_TOKEN

    if not GITEE_TOKEN and not GITEE_DRY_RUN:
        return
    await asyncio.sleep(20)
    if not await asyncio.to_thread(build_images.loaded):
        _logger.error("arena-drawings: Kitbash! is not installed or failed to load - presets stay undrawn")
        return
    # This worker may have loaded a newer Kitbash!: presets waiting on parts get another try.
    # Every database call goes to a thread: on the event loop it would hold up every request.
    waiting = await asyncio.to_thread(_retry_waiting)
    if waiting:
        _logger.warning("arena-drawings: %s preset(s) waiting on Kitbash! parts get another try", waiting)
    while True:
        try:
            await asyncio.to_thread(release_stale_claims)
            build_id = await asyncio.to_thread(_next_undrawn)
            if build_id is None:
                return
            if not await asyncio.to_thread(claim, build_id):
                continue  # another worker is drawing it
            result = await asyncio.to_thread(draw_preset, build_id)
            # Arena or Kitbash! went away: free it and leave the rest for the next start
            if result == "skipped" and await asyncio.to_thread(_release_claim, build_id):
                return
            # A pause between presets so live requests can jump in
            await asyncio.sleep(3)
        except Exception as exc:
            _logger.error("arena-drawings: worker error: %s", exc, exc_info=True)
            await asyncio.sleep(30)


def _retry_waiting() -> int:
    """Put the presets waiting on Kitbash! parts back in line. Returns how many."""
    with BuildsSessionLocal() as db:
        waiting = (
            db.query(PublicBuild)
            .filter(PublicBuild.game == GAME_ARENA, PublicBuild.drawings_json.like('{"state":"wait"%'))
            .update({"drawings_json": None}, synchronize_session=False)
        )
        db.commit()
    return waiting


def _next_undrawn() -> int | None:
    with BuildsSessionLocal() as db:
        row = (
            db.query(PublicBuild.id)
            .filter(PublicBuild.game == GAME_ARENA, PublicBuild.drawings_json.is_(None))
            .order_by(PublicBuild.is_featured.desc(), PublicBuild.id.asc())
            .first()
        )
    return row[0] if row else None


def _release_claim(build_id: int) -> bool:
    """Take back our claim on a preset we didn't draw. Whether there was one to take back."""
    with BuildsSessionLocal() as db:
        b = db.get(PublicBuild, build_id)
        if b and (b.drawings_json or "").startswith(_CLAIM_PREFIX):
            b.drawings_json = None
            db.commit()
            return True
    return False


def start_worker() -> bool:
    global _task
    if _task and not _task.done():
        return False
    _task = asyncio.create_task(_worker())
    return True
