"""Kitbash! drawings of BlastGang's shop weapons and helmets as the shop sells them.

Every visitor's shop shows the same few dozen builds, so we draw each one once and keep it on
disk in RUNTIME_DIR/arena_shop_art, named by a hash of what's drawn, instead of every page
asking /build-image for each of them. /arena/blastgang names each item's drawing, and
/arena/blastgang/art/<name>.webp draws it on first request. The answer is cached by the
browser for good (the name changes when the build does) and marked private so the CDN in
front of the site doesn't keep a copy: the pictures come straight from this server.

Only the drawings of the current shop are served: a name the shop doesn't have is a 404, so
the route can't be used to draw anything else. A weapon or helmet the user rebuilt in the
builder still goes through /build-image.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading

import build_images
from config import RUNTIME_DIR
from models_slots import Slot
from services import arena

_logger = logging.getLogger(__name__)

ART_DIR = os.path.join(RUNTIME_DIR, "arena_shop_art")
ART_DIR_BYTES = 64 * 1024 * 1024  # a drawing is 10 to 20 KB; past this the oldest go first
URL = "/arena/blastgang/art"
WEAPON_TYPES = {"CrapStorm", "HoboGun", "UberGun", "Pistol", "SpecialGun", "SniperGun"}
HELMET_TYPE = "Helmets"
ROOT_ID = "0" * 24

_lock = threading.Lock()
# name -> (root item id, SPT items, helmet), for the shop the registry was built from
_specs: dict[str, tuple[str, list, bool]] = {}
_specs_from: str | None = None  # the Arena database's stamp when they were named
_failed: set[str] = set()  # names Kitbash! couldn't draw, so they aren't tried on every request
# Drawings that aren't on disk yet are made a couple at a time, so a first visit to a fresh
# shop can't take every worker thread
_draw_slots = threading.BoundedSemaphore(2)


def _spt_items(item_id: str, pairs: list, slot_of: dict[str, Slot]) -> list | None:
    """The SPT items Kitbash! takes for `item_id` with its parts, from the builder's
    [slot id, item id] pairs (parent before child), or None when a slot is unknown."""
    items = [{"_id": ROOT_ID, "_tpl": item_id, "parentId": "hideout", "slotId": "hideout"}]
    latest = {item_id: ROOT_ID}  # item id -> the SPT id of its latest copy, its parts' parent
    for i, pair in enumerate(pairs or []):
        if not (isinstance(pair, list) and len(pair) == 2):
            return None
        slot = slot_of.get(pair[0])
        if slot is None or slot.parent_item_id not in latest or not slot.slot_game_name:
            return None
        spt_id = f"{i + 1:024x}"
        items.append(
            {"_id": spt_id, "_tpl": pair[1], "parentId": latest[slot.parent_item_id], "slotId": slot.slot_game_name}
        )
        latest[pair[1]] = spt_id
    return items


def _render_key(item_id: str, items: list, helmet: bool) -> str:
    key = build_images.build_image_key(item_id, items)
    # /build-image keys a helmet's drawing apart, since it draws its attachments switched on
    return key + ":on" if helmet else key


def _name(render_key: str) -> str:
    return hashlib.sha256(render_key.encode()).hexdigest()[:32]


def names(db, shop_items: list) -> dict[str, str]:
    """{shop item id: its drawing's address} for the shop's weapons and helmets, and remember
    what each name draws. `db` is the Arena database, whose slots name the parts' slots."""
    wanted = [i for i in shop_items if i.get("type") in WEAPON_TYPES or i.get("type") == HELMET_TYPE]
    slot_ids = {p[0] for i in wanted for p in (i.get("pairs") or []) if isinstance(p, list) and p}
    slot_of = {s.id: s for s in db.query(Slot).filter(Slot.id.in_(slot_ids)).all()} if slot_ids else {}
    out, specs = {}, {}
    for entry in wanted:
        helmet = entry.get("type") == HELMET_TYPE
        items = _spt_items(entry["item_id"], entry.get("pairs") or [], slot_of)
        if items is None:
            continue
        try:
            name = _name(_render_key(entry["item_id"], items, helmet))
        except ValueError:
            continue
        specs[name] = (entry["item_id"], items, helmet)
        out[entry["id"]] = f"{URL}/{name}.webp"
    global _specs, _specs_from
    with _lock:
        _specs = specs
        _specs_from = arena.db_stamp()
    return out


def path_for(name: str, db, shop_items: list) -> str | None:
    """The file of drawing `name`, drawn now if it isn't on disk yet; None for a name the
    current shop doesn't have, or one Kitbash! can't draw."""
    root = os.path.realpath(ART_DIR)
    path = os.path.realpath(os.path.join(root, name + ".webp"))
    if not path.startswith(root + os.sep):
        return None
    if not build_images.available():
        return None
    with _lock:
        spec = _specs.get(name)
        stale = _specs_from != arena.db_stamp()
    if spec is None and stale:
        # Another worker named it, or the shop changed since: name this shop's drawings here too
        names(db, shop_items)
        with _lock:
            spec = _specs.get(name)
    if spec is None or name in _failed:
        return None
    return path if os.path.isfile(path) or _draw(name, spec, path) else None


def _draw(name: str, spec: tuple, path: str) -> bool:
    """Draw `spec` into `path` unless it's there already. Whether the file is there after."""
    with _draw_slots:
        if os.path.isfile(path):
            return True
        item_id, items, helmet = spec
        render_key = _render_key(item_id, items, helmet)
        if helmet:
            items = [items[0]] + [
                {**it, "upd": {**(it.get("upd") or {}), "Togglable": {"On": True}}} for it in items[1:]
            ]
        try:
            data, skipped = build_images.render_webp(render_key, items)
        except build_images.Unrenderable as exc:
            _logger.info("shop art: Kitbash! cannot draw %s (%s): %s", item_id, name, exc)
            _failed.add(name)
            return False
        if skipped:
            _logger.info("shop art: Kitbash! left out %s in %s", skipped, item_id)
        _store(path, data)
    return True


def warm() -> int:
    """Draw every drawing of the current shop that isn't on disk yet, ahead of any visitor
    asking for it. services/snapshots.py runs this after each snapshot check, so a new shop is
    drawn within minutes of arriving. Returns how many it drew."""
    from database_arena import ArenaSessionLocal

    if not (arena.available() and build_images.available()):
        return 0
    with ArenaSessionLocal() as db:
        shop = arena.setting(db, "blast_gang")
        if not shop:
            return 0
        names(db, shop.get("items") or [])
    with _lock:
        specs = dict(_specs)
    root = os.path.realpath(ART_DIR)
    drawn = 0
    for name, spec in specs.items():
        path = os.path.join(root, name + ".webp")
        if name in _failed or os.path.isfile(path):
            continue
        if _draw(name, spec, path):
            drawn += 1
    if drawn:
        _logger.info("shop art: drew %d BlastGang shop drawings", drawn)
    return drawn


def _store(path: str, data: bytes) -> None:
    os.makedirs(ART_DIR, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)
    _prune()


def _prune() -> None:
    try:
        files = [os.path.join(ART_DIR, f) for f in os.listdir(ART_DIR) if f.endswith(".webp")]
        stats = sorted(((os.path.getmtime(f), os.path.getsize(f), f) for f in files), reverse=True)
    except OSError:
        return
    total = 0
    for _, size, f in stats:
        total += size
        if total > ART_DIR_BYTES:
            try:
                os.remove(f)
            except OSError:
                pass
