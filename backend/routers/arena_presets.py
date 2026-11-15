"""Community Arena presets: whole loadouts players publish for one preset class, and whole
BlastGang shops (class id "blastgang": both sides' lineups, board picks and weapon builds,
as arena-shop.js keeps them).

They live in public_builds next to the gun builds (game = "arena"), so the likes, comments,
load counts, unlisting, bans and notifications the gun builds have work on them unchanged
through the same /builds and /ratings routes. Only publishing and listing are Arena's own.
Every route sits under /builds, so the desktop app's community proxy and the prod nginx
allowlist already cover them."""

import json
import time
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Request
from sqlalchemy import func
from sqlalchemy.orm import Session

from database_arena import ArenaSessionLocal
from models_builds import BuildComment, BuildRating, PublicBuild, PublicBuildAuthor
from models_items import Item
from routers import community_builds
from routers.shared import (
    check_client_ban,
    get_builds_db,
    get_client_id_hash,
    get_client_ip,
    get_optional_client_id_hash,
    safe_json_loads,
    sanitize_build_name,
    sanitize_username,
)
from services import arena, arena_preset_check
from services.gitee import validate_avatar_url

router = APIRouter()

GAME_ARENA = "arena"

# The loadout as arena-loadout.js keeps it
WEAPON_SLOTS = ("FirstPrimaryWeapon", "SecondPrimaryWeapon", "Holster")
GEAR_SLOTS = ("Headwear", "Earpiece", "FaceCover", "Eyewear", "ArmorVest", "TacticalVest", "Scabbard")
CARRY_PLACES = ("rig", "pockets")
MAX_WEAPON_PAIRS = 200
MAX_GEAR_INSERTS = 8
MAX_CARRIED = 64
MAX_COUNT = 9999
MAX_LOADS = 32
MAX_GRID_INDEX = 64
MAX_CELL = 64
# A full loadout serializes to a few kilobytes; this only stops abuse
MAX_LOADOUT_JSON_CHARS = 24000
PRESETS_PER_CLASS_LIMIT = 500

# BlastGang's shop as arena-shop.js keeps it
BLAST_GANG = "blastgang"
BLAST_GANG_NAME = "BlastGang"
SHOP_SIDES = ("attack", "defense")
SHOP_WEAPON_TYPES = ("CrapStorm", "HoboGun", "UberGun", "Pistol", "SpecialGun", "SniperGun")
# The board's slots a shop picks for each side ("" for one the user emptied)
SHOP_GEAR_SLOTS = ("Headwear", "Earpiece", "FaceCover", "Eyewear", "TacticalVest", "Scabbard")
MAX_SHOP_LINEUP = 16
MAX_SHOP_BUILDS = 128
# Both sides' lineups and every weapon's build; still well under the loadouts' cap times two
MAX_SHOP_JSON_CHARS = 48000


def _arena_db():
    if not arena.available():
        raise HTTPException(status_code=503, detail="arena_unavailable")
    db = ArenaSessionLocal()
    try:
        yield db
    finally:
        db.close()


def _bad(detail: str):
    raise HTTPException(status_code=422, detail=detail)


def _id(value: Any, what: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 64:
        _bad(f"{what} must be an item id.")
    return value


def _optional_id(value: Any, what: str) -> str | None:
    return None if value is None else _id(value, what)


def _int(value: Any, what: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        _bad(f"{what} must be a whole number from {low} to {high}.")
    return value


def _loads(raw: Any, what: str) -> list[list]:
    """A magazine's rounds bottom up, [[ammo id, count], ...], as arena-loadout.js keeps them."""
    if not isinstance(raw, list) or len(raw) > MAX_LOADS:
        _bad(f"{what} must be a list of at most {MAX_LOADS} [ammo id, count] pairs.")
    out = []
    for load in raw:
        if not (isinstance(load, list) and len(load) == 2):
            _bad(f"{what} must be a list of [ammo id, count] pairs.")
        out.append([_id(load[0], what), _int(load[1], what, 1, MAX_COUNT)])
    return out


def _id_map(raw: Any, what: str) -> dict[str, str]:
    if raw is None:
        return {}
    if not isinstance(raw, dict) or len(raw) > MAX_GEAR_INSERTS:
        _bad(f"{what} must be an object of at most {MAX_GEAR_INSERTS} entries.")
    out = {}
    for slot, item_id in raw.items():
        if not isinstance(slot, str) or not slot or len(slot) > 64:
            _bad(f"{what} has a bad slot name.")
        out[slot] = _id(item_id, what)
    return out


def clean_loadout(raw: Any) -> tuple[dict, set[str]]:
    """The loadout rebuilt from only what a loadout holds, and every item id it uses.
    Raises 422 on anything malformed."""
    if not isinstance(raw, dict):
        _bad("loadout must be an object.")
    ids: set[str] = set()

    weapons_raw = raw.get("weapons") or {}
    if not isinstance(weapons_raw, dict) or any(k not in WEAPON_SLOTS for k in weapons_raw):
        _bad("loadout.weapons has an unknown slot.")
    weapons = {}
    for slot, w in weapons_raw.items():
        if w is None:
            continue
        if not isinstance(w, dict):
            _bad("A weapon must be an object.")
        pairs = w.get("pairs") or []
        if not isinstance(pairs, list) or len(pairs) > MAX_WEAPON_PAIRS:
            _bad(f"A weapon holds at most {MAX_WEAPON_PAIRS} parts.")
        clean_pairs = []
        for p in pairs:
            if not (isinstance(p, list) and len(p) == 2 and isinstance(p[0], str) and len(p[0]) <= 64):
                _bad("Each pair must be [slot_id, item_id].")
            clean_pairs.append([p[0], _id(p[1], "A weapon part")])
        weapon = {
            "gunId": _id(w.get("gunId"), "A weapon"),
            "pairs": clean_pairs,
            "ammoId": _optional_id(w.get("ammoId"), "A weapon's ammo"),
        }
        # How many rounds its magazine holds (none recorded: full); the old flag for an empty one
        if weapon["ammoId"] and w.get("magRounds") is not None:
            weapon["magRounds"] = _int(w.get("magRounds"), "A weapon's magazine rounds", 0, MAX_COUNT)
        if w.get("magEmpty") is True and weapon["ammoId"]:
            weapon["magEmpty"] = True
        # Its magazine's rounds when they're mixed, or not the chambered round
        if w.get("magLoads") is not None:
            weapon["magLoads"] = _loads(w.get("magLoads"), "A weapon's magazine rounds")
            ids.update(load[0] for load in weapon["magLoads"])
        ids.add(weapon["gunId"])
        ids.update(p[1] for p in clean_pairs)
        if weapon["ammoId"]:
            ids.add(weapon["ammoId"])
        weapons[slot] = weapon

    gear_raw = raw.get("gear") or {}
    if not isinstance(gear_raw, dict) or any(k not in GEAR_SLOTS for k in gear_raw):
        _bad("loadout.gear has an unknown slot.")
    gear = {}
    for slot, g in gear_raw.items():
        if g is None:
            continue
        if not isinstance(g, dict):
            _bad("Worn gear must be an object.")
        worn = {"id": _id(g.get("id"), "Worn gear")}
        plates = _id_map(g.get("plates"), "Plates")
        parts = _id_map(g.get("parts"), "Helmet parts")
        if plates:
            worn["plates"] = plates
        if parts:
            worn["parts"] = parts
        ids.add(worn["id"])
        ids.update(plates.values())
        ids.update(parts.values())
        gear[slot] = worn

    carried_raw = raw.get("carried") or []
    if not isinstance(carried_raw, list) or len(carried_raw) > MAX_CARRIED:
        _bad(f"A loadout carries at most {MAX_CARRIED} items.")
    carried = []
    for c in carried_raw:
        if not isinstance(c, dict):
            _bad("A carried item must be an object.")
        entry = {
            "id": _id(c.get("id"), "A carried item"),
            "count": _int(c.get("count", 1), "A carried item's count", 1, MAX_COUNT),
        }
        ammo = _optional_id(c.get("ammoId"), "A magazine's ammo")
        if ammo:
            entry["ammoId"] = ammo
            ids.add(ammo)
            # How many rounds the magazine holds (none recorded: full), or its mixed rounds
            if c.get("rounds") is not None:
                entry["rounds"] = _int(c.get("rounds"), "A magazine's rounds", 0, MAX_COUNT)
            if c.get("loads") is not None:
                entry["loads"] = _loads(c.get("loads"), "A magazine's rounds")
                ids.update(load[0] for load in entry["loads"])
        where = c.get("where")
        if where is not None:
            if where not in CARRY_PLACES:
                _bad("A carried item goes in the rig or the pockets.")
            entry["where"] = where
            entry["grid"] = _int(c.get("grid", 0), "A carried item's grid", 0, MAX_GRID_INDEX)
            entry["x"] = _int(c.get("x", 0), "A carried item's column", 0, MAX_CELL)
            entry["y"] = _int(c.get("y", 0), "A carried item's row", 0, MAX_CELL)
            entry["r"] = bool(c.get("r"))
        ids.add(entry["id"])
        carried.append(entry)

    if not weapons and not gear and not carried:
        _bad("The loadout is empty.")
    return {"weapons": weapons, "gear": gear, "carried": carried}, ids


def _pairs(raw: Any, what: str) -> list[list]:
    if not isinstance(raw, list) or len(raw) > MAX_WEAPON_PAIRS:
        _bad(f"{what} holds at most {MAX_WEAPON_PAIRS} parts.")
    out = []
    for p in raw:
        if not (isinstance(p, list) and len(p) == 2 and isinstance(p[0], str) and len(p[0]) <= 64):
            _bad("Each pair must be [slot_id, item_id].")
        out.append([p[0], _id(p[1], what)])
    return out


def clean_shop(raw: Any, shop: dict) -> tuple[dict, set[str]]:
    """A BlastGang shop rebuilt from only what a shop holds, and every armory item id it uses.

    A lineup naming a shop item the data no longer has (or not of that type) just drops it, as
    the shop page mends it on load. A weapon's build holding a part BlastGang bans on that
    weapon is refused. Raises 422 on anything malformed."""
    if not isinstance(raw, dict):
        _bad("shop must be an object.")
    entries = {e["id"]: e for e in shop.get("items") or [] if isinstance(e, dict) and isinstance(e.get("id"), str)}
    types = {e.get("type") for e in entries.values()}
    ids: set[str] = set()

    out: dict = {}
    for side in SHOP_SIDES:
        side_raw = raw.get(side) or {}
        if not isinstance(side_raw, dict):
            _bad(f"shop.{side} must be an object.")
        clean_side: dict = {}
        for key, value in side_raw.items():
            if key == "gear":
                gear_raw = value or {}
                if not isinstance(gear_raw, dict) or any(k not in SHOP_GEAR_SLOTS for k in gear_raw):
                    _bad("shop gear has an unknown slot.")
                gear = {}
                for slot, item_id in gear_raw.items():
                    if item_id is None:
                        continue
                    if item_id == "":
                        gear[slot] = ""
                        continue
                    gear[slot] = _id(item_id, "Shop gear")
                    ids.add(gear[slot])
                if gear:
                    clean_side["gear"] = gear
                continue
            if key not in types:
                continue
            if not isinstance(value, list) or len(value) > MAX_SHOP_LINEUP:
                _bad(f"A shop slot type holds at most {MAX_SHOP_LINEUP} items.")
            lineup = []
            for shop_id in value:
                entry = entries.get(shop_id) if isinstance(shop_id, str) else None
                if entry and entry.get("type") == key and shop_id not in lineup:
                    lineup.append(shop_id)
            clean_side[key] = lineup
        out[side] = clean_side

    builds_raw = raw.get("builds") or {}
    if not isinstance(builds_raw, dict) or len(builds_raw) > MAX_SHOP_BUILDS:
        _bad(f"A shop holds at most {MAX_SHOP_BUILDS} weapon builds.")
    builds = {}
    for shop_id, b in builds_raw.items():
        entry = entries.get(shop_id)
        if not entry or entry.get("type") not in SHOP_WEAPON_TYPES:
            continue
        if not isinstance(b, dict):
            _bad("A shop weapon's build must be an object.")
        pairs = _pairs(b.get("pairs") or [], "A shop weapon's build")
        banned = set(entry.get("excluded_mods") or [])
        if any(p[1] in banned for p in pairs):
            _bad("A shop weapon's build holds a part BlastGang doesn't allow on it.")
        ammo = _optional_id(b.get("ammoId"), "A shop weapon's ammo")
        ids.update(p[1] for p in pairs)
        # The shop's own round needn't be an armory item
        if ammo and ammo != entry.get("ammo_id"):
            ids.add(ammo)
        builds[shop_id] = {"pairs": pairs, "ammoId": ammo}
    out["builds"] = builds

    if not builds and not any(out[side] for side in SHOP_SIDES):
        _bad("The shop is empty.")
    return out, ids


def _class_by_id(db_arena: Session, class_id: str) -> dict | None:
    return next((c for c in arena.setting(db_arena, "classes", []) or [] if c.get("id") == class_id), None)


@router.post("/builds/arena/publish")
def publish_arena_preset(
    request: Request,
    x_client_id: str = Header(None),
    class_id: str = Body(..., max_length=64),
    build_name: str = Body(..., max_length=60),
    loadout: dict = Body(...),
    author_username: str | None = Body(default=None, max_length=30),
    author_avatar_url: str | None = Body(default=None),
    db: Session = Depends(get_builds_db),
    db_arena: Session = Depends(_arena_db),
):
    client_hash = get_client_id_hash(x_client_id)

    # One publish a minute per client, gun builds and Arena presets together
    last_by_client = community_builds._publish_last
    cooldown = community_builds._PUBLISH_COOLDOWN
    now_mono = time.monotonic()
    for k in [k for k, t in last_by_client.items() if now_mono - t > cooldown * 2]:
        del last_by_client[k]
    last = last_by_client.get(client_hash, 0.0)
    if now_mono - last < cooldown:
        raise HTTPException(
            status_code=429, detail=f"Rate limit: wait {int(cooldown - (now_mono - last))}s before publishing again."
        )

    check_client_ban(client_hash, db)

    shop = None
    if class_id == BLAST_GANG:
        shop = arena.setting(db_arena, "blast_gang")
        if not shop:
            raise HTTPException(status_code=422, detail="BlastGang's shop isn't in this Arena data.")
        class_name = BLAST_GANG_NAME
    else:
        cls = _class_by_id(db_arena, class_id)
        if not cls:
            raise HTTPException(status_code=422, detail="Unknown class_id.")
        class_name = cls.get("name") or cls.get("key") or class_id

    name = sanitize_build_name(build_name)[:60]
    if not name:
        raise HTTPException(status_code=422, detail="build_name cannot be empty.")

    u_name = sanitize_username(author_username) if author_username else None
    try:
        u_avatar = validate_avatar_url(author_avatar_url)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    clean, ids = clean_shop(loadout, shop) if shop else clean_loadout(loadout)
    serialized = json.dumps(clean, separators=(",", ":"))
    if len(serialized) > (MAX_SHOP_JSON_CHARS if shop else MAX_LOADOUT_JSON_CHARS):
        raise HTTPException(status_code=422, detail="loadout payload too large.")
    found = {r[0] for r in db_arena.query(Item.id).filter(Item.id.in_(ids)).all()}
    missing = sorted(ids - found)
    if missing:
        raise HTTPException(status_code=422, detail=f"Unknown item IDs: {missing[:5]}")
    # What the page won't publish, refused here too (services/arena_preset_check.py)
    problems = arena_preset_check.preset_problems(arena_preset_check.Rules(db_arena), class_id, clean)
    if problems:
        raise HTTPException(status_code=422, detail="arena_problems:" + ",".join(sorted(set(problems))))

    existing = db.query(PublicBuild).filter(PublicBuild.gun_id == class_id, PublicBuild.game == GAME_ARENA).count()
    if existing >= PRESETS_PER_CLASS_LIMIT:
        raise HTTPException(status_code=409, detail="community_builds_limit_reached")

    preset = PublicBuild(
        game=GAME_ARENA,
        gun_id=class_id,
        gun_name=class_name,
        build_name=name,
        pairs_json="[]",
        loadout_json=serialized,
        ip_hash=client_hash,
        ip_snapshot=get_client_ip(request),
        author_id=None,
        is_admin_build=False,
        user_display_name=u_name or None,
        user_avatar_url=u_avatar or None,
    )
    db.add(preset)
    db.commit()
    db.refresh(preset)
    last_by_client[client_hash] = now_mono
    return {"id": preset.id, "published_at": preset.published_at.isoformat()}


def _comment_counts(db: Session, ids: list[int]) -> dict[int, int]:
    if not ids:
        return {}
    rows = (
        db.query(BuildComment.build_id, func.count(BuildComment.id))
        .filter(BuildComment.build_id.in_(ids), BuildComment.is_deleted == False)  # noqa: E712
        .group_by(BuildComment.build_id)
        .all()
    )
    return {bid: cnt for bid, cnt in rows}


def _preset_dict(b: PublicBuild, author: PublicBuildAuthor | None, client_hash: str | None, comments: int) -> dict:
    return {
        "id": b.id,
        "class_id": b.gun_id,
        "class_name": b.gun_name,
        "build_name": b.build_name,
        "author_display_name": author.display_name if author else None,
        "author_display_name_zh": author.display_name_zh if author else None,
        "author_avatar_url": author.avatar_url if author else None,
        "user_display_name": b.user_display_name,
        "user_avatar_url": b.user_avatar_url,
        "is_admin_build": b.is_admin_build,
        "is_featured": b.is_featured,
        "published_at": b.published_at.isoformat(),
        "is_mine": client_hash is not None and b.ip_hash == client_hash,
        "loadout": safe_json_loads(b.loadout_json) or {},
        "load_count": b.load_count or 0,
        "comment_count": comments,
    }


@router.get("/builds/arena/public")
def get_public_arena_presets(
    class_id: str,
    x_client_id: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    # Read off the module: the kill switch flag gets rebound at runtime
    if community_builds._community_builds_disabled:
        raise HTTPException(status_code=503, detail="community_builds_disabled")
    client_hash = get_optional_client_id_hash(x_client_id)
    rows = (
        db.query(PublicBuild, PublicBuildAuthor)
        .outerjoin(PublicBuildAuthor, PublicBuild.author_id == PublicBuildAuthor.id)
        .filter(PublicBuild.gun_id == class_id, PublicBuild.game == GAME_ARENA)
        .order_by(PublicBuild.is_featured.desc(), PublicBuild.published_at.desc())
        .limit(PRESETS_PER_CLASS_LIMIT)
        .all()
    )
    counts = _comment_counts(db, [b.id for b, _ in rows])
    return [_preset_dict(b, a, client_hash, counts.get(b.id, 0)) for b, a in rows]


@router.get("/builds/arena/mine")
def get_my_arena_presets(
    x_client_id: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    if not x_client_id:
        return []
    client_hash = get_client_id_hash(x_client_id)
    rows = (
        db.query(PublicBuild)
        .filter(PublicBuild.ip_hash == client_hash, PublicBuild.game == GAME_ARENA)
        .order_by(PublicBuild.published_at.desc())
        .limit(100)
        .all()
    )
    counts = _comment_counts(db, [b.id for b in rows])
    likes = {
        r.build_id: r.like_count for r in db.query(BuildRating).filter(BuildRating.build_id.in_([b.id for b in rows]))
    }
    out = []
    for b in rows:
        entry = _preset_dict(b, None, client_hash, counts.get(b.id, 0))
        entry["like_count"] = likes.get(b.id, 0)
        out.append(entry)
    return out
