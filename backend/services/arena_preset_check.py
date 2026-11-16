"""What keeps a community Arena preset from being published, checked on the server too.

A by-hand port of the checks the loadout page and BlastGang's shop make before they let a
preset publish (frontend/modules/arena-loadout.js problems(), arena-shop.js problems()), so
a preset published around the page is refused all the same, and so the presets already
published can be checked again whenever Arena's data changes: a preset a data update broke
is taken out of the community and its publisher told (recheck_published).

A class preset's problems: an item the armory doesn't have, one its class may not carry,
a part or round its class may not put on that weapon, worn gear that can't be worn
together, a headset made for a helmet's mount worn in the Earpiece slot, a weapon with a
required slot left empty (services/build_check.py), and a total over the class's meta point
limit. Only "no room in the rig" stays the page's alone, since placing items is the page's
grid packing.

A shop's problems: a weapon build outside its meta point range, holding a part BlastGang
bans on that weapon or leaving one of its required slots empty, and worn gear on either
side's board that can't be worn together.

Keep it in step with those two files by hand: there is no shared code between them.
"""

from __future__ import annotations

import json
import logging
import os

from config import RUNTIME_DIR
from services.build_check import missing_required, required_slots, unlist_allowed

_logger = logging.getLogger(__name__)

# Bump whenever the checks change, so the presets already published are checked again
CHECK_VERSION = 6
_STAMP_FILE = os.path.join(RUNTIME_DIR, "arena_preset_check.json")

BLAST_GANG = "blastgang"
GAME_ARENA = "arena"
WEAPON_SLOTS = ("FirstPrimaryWeapon", "SecondPrimaryWeapon", "Holster")
GEAR_SLOTS = ("Headwear", "Earpiece", "FaceCover", "Eyewear", "ArmorVest", "TacticalVest", "Scabbard")
BLOCKS = {
    "Headwear": "blocks_headwear",
    "Earpiece": "blocks_earpiece",
    "FaceCover": "blocks_facecover",
    "Eyewear": "blocks_eyewear",
}

# arena-shop.js
SHOP_SIDES = ("attack", "defense")
SHOP_WEAPON_TYPES = ("CrapStorm", "HoboGun", "UberGun", "Pistol", "SpecialGun", "SniperGun")
SHOP_GEAR_TYPES = ("Helmets", "Armor", "HeavyArmor")
SHOP_FREE_TYPES = ("Vest", "Headphones")
SHOP_BOARD_TYPES = {"TacticalVest": "Vest", "Earpiece": "Headphones"}
SHOP_GEAR_SLOTS = ("Headwear", "FaceCover", "Eyewear", "Scabbard")
SHOP_PLAIN_SLOTS = ("Headwear", "FaceCover", "Eyewear")


def _split(text) -> list:
    return [part for part in (text or "").split(",") if part]


class Rules:
    """What the checks read from Arena's database, loaded once per check run."""

    def __init__(self, db):
        from models_arena import ArenaItem
        from models_armor import ArmorPiece, ArmorPlateSlot
        from models_items import Item
        from routers.shared import worn_slot_conflicts
        from services import arena

        items = {item.id: item for item in db.query(Item)}
        extras = {row.item_id: row for row in db.query(ArenaItem) if row.item_id in items}
        self.items = items
        self.extras = extras
        self.armor_ids = {i for i, item in items.items() if item.armor_kind}
        self.gear_ids = {i for i, row in extras.items() if row.gear_slot or row.carry_kind}
        weapon_ids = {i for i, item in items.items() if item.is_weapon}
        # What the page finds an item in: /arena/points (the armory), /arena/items, /armor/items, /guns
        self.known = set(extras) | self.armor_ids | weapon_ids
        holders = {r[0] for r in db.query(ArmorPiece.holder_item_id)} | {
            r[0] for r in db.query(ArmorPlateSlot.holder_item_id)
        }
        self.armored = holders & self.armor_ids

        # Each worn item's row as arena-loadout.js _gearRow merges /arena/items' and /armor/items'
        self.rows = {}
        for item_id in self.gear_ids | self.armor_ids:
            item = items[item_id]
            # Both payloads carry the item's whole lists, so a helmet part (only in
            # /armor/items) is checked against headsets and the rest as a worn item is
            slots = worn_slot_conflicts(item)
            copies = (item_id in self.gear_ids) + (item_id in self.armor_ids)
            row = {"conflicting_ids": set(_split(item.conflicting_item_ids)), "conflicting_slots": slots * copies}
            for flag in BLOCKS.values():
                row[flag] = bool(getattr(item, flag))
            self.rows[item_id] = row

        self.classes = {c.get("id"): c for c in arena.setting(db, "classes", []) or []}
        # Headsets only a helmet's mount takes: never worn in the Earpiece slot
        self.mount_only = set(arena.setting(db, "mount_only", []) or [])
        self.shop = arena.setting(db, "blast_gang") or None
        # {item id: [(slot id, slot name)]}: the slots a weapon can't be used with empty
        self.required = required_slots(db)

    # ---- items ----

    def mp(self, item_id) -> float:
        row = self.extras.get(item_id)
        return float(row.meta_points or 0) if row else 0.0

    def capacity(self, item_id) -> int:
        item = self.items.get(item_id) if item_id in self.known else None
        return (item.magazine_capacity or 0) if item else 0

    def allowed_for_class(self, item_id, class_id) -> bool:
        row = self.extras.get(item_id)
        ids = _split(row.class_ids) if row else []
        return not class_id or not ids or class_id in ids

    def allowed_on_gun(self, item_id, gun_id, class_id) -> bool:
        row = self.extras.get(gun_id)
        if not row or not class_id:
            return True
        mods = json.loads(row.excluded_mods) if row.excluded_mods else {}
        ammo = json.loads(row.excluded_ammo) if row.excluded_ammo else {}
        return item_id not in (mods.get(class_id) or []) + (ammo.get(class_id) or [])

    def row(self, item_id) -> dict:
        return self.rows.get(item_id) or {
            "conflicting_ids": set(),
            "conflicting_slots": [],
            **{flag: False for flag in BLOCKS.values()},
        }


# ----------------------------------------------------------------------
# Meta points (arena-loadout.js totals)
# ----------------------------------------------------------------------


def _clean_loads(loads, cap) -> list:
    out = []
    room = cap
    for load in loads or []:
        if not isinstance(load, list) or len(load) < 2 or not load[0] or room <= 0:
            continue
        try:
            n = min(room, int(float(load[1] or 0)))
        except (TypeError, ValueError):
            continue
        if n <= 0:
            continue
        room -= n
        if out and out[-1][0] == load[0]:
            out[-1][1] += n
        else:
            out.append([load[0], n])
    return out


def _weapon_loads(w: dict, cap: int) -> list:
    if not cap:
        return []
    if isinstance(w.get("magLoads"), list):
        return _clean_loads(w["magLoads"], cap)
    if not w.get("ammoId") or w.get("magEmpty"):
        return []
    rounds = w.get("magRounds")
    return _clean_loads([[w["ammoId"], rounds if isinstance(rounds, int) else cap]], cap)


def _weapon_meta(rules: Rules, w: dict) -> float:
    mods = 0.0
    cap = 0
    for pair in w.get("pairs") or []:
        mods += rules.mp(pair[1])
        if rules.capacity(pair[1]) > 0:
            cap = rules.capacity(pair[1])
    ammo = rules.mp(w["ammoId"]) if w.get("ammoId") else 0.0
    for load in _weapon_loads(w, cap):
        ammo += rules.mp(load[0]) * load[1]
    return rules.mp(w.get("gunId")) + mods + ammo


def _carried_meta(rules: Rules, c: dict) -> float:
    each = rules.mp(c.get("id"))
    cap = rules.capacity(c.get("id"))
    if cap > 0:
        if isinstance(c.get("loads"), list):
            loads = _clean_loads(c["loads"], cap)
        elif c.get("ammoId"):
            rounds = c.get("rounds")
            loads = _clean_loads([[c["ammoId"], rounds if isinstance(rounds, int) else cap]], cap)
        else:
            loads = []
        for load in loads:
            each += rules.mp(load[0]) * load[1]
    return each * (c.get("count") or 1)


def loadout_total(rules: Rules, loadout: dict) -> float:
    total = 0.0
    for slot in WEAPON_SLOTS:
        w = (loadout.get("weapons") or {}).get(slot)
        if w:
            total += _weapon_meta(rules, w)
    for slot in GEAR_SLOTS:
        g = (loadout.get("gear") or {}).get(slot)
        if g:
            total += rules.mp(g.get("id"))
            total += sum(rules.mp(i) for i in (g.get("plates") or {}).values())
            total += sum(rules.mp(i) for i in (g.get("parts") or {}).values())
    for c in loadout.get("carried") or []:
        if c.get("where"):
            total += _carried_meta(rules, c)
    return total


# ----------------------------------------------------------------------
# Gear that can't be worn together (arena-loadout.js _gearConflicts)
# ----------------------------------------------------------------------


def _worn_entries(gear: dict) -> list:
    out = []
    for slot in GEAR_SLOTS:
        worn = gear.get(slot)
        if not worn:
            continue
        out.append({"slot": slot, "place": None, "id": worn.get("id")})
        for store in ("parts", "plates"):
            for name, item_id in (worn.get(store) or {}).items():
                if item_id:
                    out.append({"slot": slot, "place": f"{store}:{name}", "id": item_id})
    return out


def _place_name(entry):
    return entry["place"].split(":", 1)[1] if entry["place"] else None


def _slot_hit(rules: Rules, x, y, gear) -> bool:
    worn = gear.get(y["slot"])
    for c in rules.row(x["id"])["conflicting_slots"]:
        if (
            c["item"] == y["id"]
            and worn
            and ((worn.get("parts") or {}).get(c["slot"]) or (worn.get("plates") or {}).get(c["slot"]))
        ):
            return True
        if _place_name(y) != c["slot"] or not worn:
            continue
        if worn.get("id") == c["item"] or c["item"] in (worn.get("parts") or {}).values():
            return True
    return False


def _entries_conflict(rules: Rules, a, b, gear) -> bool:
    ra, rb = rules.row(a["id"]), rules.row(b["id"])
    if b["id"] in ra["conflicting_ids"] or a["id"] in rb["conflicting_ids"]:
        return True
    if a["slot"] != b["slot"] and (
        (b["slot"] in BLOCKS and ra[BLOCKS[b["slot"]]]) or (a["slot"] in BLOCKS and rb[BLOCKS[a["slot"]]])
    ):
        return True
    for rig, other in ((a, b), (b, a)):
        if (
            rig["slot"] == "TacticalVest"
            and other["slot"] == "ArmorVest"
            and not rig["place"]
            and not other["place"]
            and rig["id"] in rules.armored
        ):
            return True
    return _slot_hit(rules, a, b, gear) or _slot_hit(rules, b, a, gear)


def gear_conflicts(rules: Rules, gear: dict) -> list:
    entries = _worn_entries(gear)
    out = []
    for i, a in enumerate(entries):
        for b in entries[i + 1 :]:  # noqa: E203 - black's slice spacing
            if _entries_conflict(rules, a, b, gear):
                out.append((a, b))
    return out


# ----------------------------------------------------------------------
# The checks
# ----------------------------------------------------------------------


def weapon_conflicts(rules: Rules, w: dict) -> bool:
    """Whether a weapon's parts can't all be on it together: one names another as conflicting,
    or rules out a slot another one fills (as worn gear's slot conflicts count a slot only
    while it holds something). Checked every way round, since the data often names a conflict
    on one side only (a Mosin's AA762R names the wooden stocks; they don't name it)."""
    pairs = [p for p in w.get("pairs") or [] if isinstance(p, list) and len(p) >= 2]
    entries = [(None, w.get("gunId"))] + [(p[0], p[1]) for p in pairs]
    for i, (slot_id, item_id) in enumerate(entries):
        item = rules.items.get(item_id)
        if item is None:
            continue
        items_out = set(_split(item.conflicting_item_ids))
        slots_out = set(_split(item.conflicting_slot_ids))
        for j, (other_slot, other_id) in enumerate(entries):
            if i == j:
                continue
            if other_id in items_out or (other_slot and other_slot in slots_out):
                return True
    return False


def loadout_problems(rules: Rules, class_id: str, loadout: dict) -> list[str]:
    """A class preset's problems, as short codes (empty when it may publish)."""
    out: list[str] = []

    def check(item_id, gun_id=None):
        if item_id not in rules.known:
            out.append("not_in_armory")
        elif not rules.allowed_for_class(item_id, class_id):
            out.append("class")
        elif gun_id and not rules.allowed_on_gun(item_id, gun_id, class_id):
            out.append("weapon")

    for slot in WEAPON_SLOTS:
        w = (loadout.get("weapons") or {}).get(slot)
        if not w:
            continue
        gun = w.get("gunId")
        check(gun)
        for pair in w.get("pairs") or []:
            check(pair[1], gun)
        if w.get("ammoId"):
            check(w["ammoId"], gun)
        for load in w.get("magLoads") or []:
            if load and load[0] and load[0] != w.get("ammoId"):
                check(load[0], gun)
        if weapon_conflicts(rules, w):
            out.append("part_conflict")
        if missing_required(rules.required, gun, w.get("pairs") or []):
            out.append("missing_part")
    for slot in GEAR_SLOTS:
        g = (loadout.get("gear") or {}).get(slot)
        if not g:
            continue
        check(g.get("id"))
        for item_id in list((g.get("plates") or {}).values()) + list((g.get("parts") or {}).values()):
            check(item_id)
    for c in loadout.get("carried") or []:
        check(c.get("id"))
        loaded = {c.get("ammoId")} | {load[0] for load in c.get("loads") or [] if load}
        for item_id in loaded:
            if item_id:
                check(item_id)
    if gear_conflicts(rules, loadout.get("gear") or {}):
        out.append("conflict")
    if ((loadout.get("gear") or {}).get("Earpiece") or {}).get("id") in rules.mount_only:
        out.append("mount_only")
    cls = rules.classes.get(class_id) or {}
    total = loadout_total(rules, loadout)
    if cls.get("meta_max") is not None and total > cls["meta_max"]:
        out.append("over_limit")
    # The game won't start a match on a preset under its class's floor either
    if cls.get("meta_min") is not None and total < cls["meta_min"]:
        out.append("under_limit")
    return out


def _shop_entries(rules: Rules) -> dict:
    return {e["id"]: e for e in (rules.shop or {}).get("items") or [] if isinstance(e, dict) and e.get("id")}


def _kit_node(rules: Rules, side, slot):
    for node in ((rules.shop or {}).get("kits") or {}).get(side) or []:
        if node.get("slot") == slot and node.get("id"):
            return node
    return None


def _price(entry, side):
    return entry.get("price_defense" if side == "defense" else "price_attack") or 0


def _first_of_lineup(rules: Rules, store: dict, entries: dict, kind: str, side: str):
    """The shop item in `kind`'s first slot on `side`, mended as arena-shop.js _lineup does."""
    choices = [e for e in entries.values() if e.get("type") == kind and _price(e, side) > 0]
    allowed = {e["id"] for e in choices}
    for shop_id in (store.get(side) or {}).get(kind) or []:
        if shop_id in allowed:
            return entries[shop_id]
    board_slot = next((k for k, v in SHOP_BOARD_TYPES.items() if v == kind), None)
    if board_slot:
        worn = _kit_node(rules, side, board_slot)
        own = next((e for e in choices if worn and e.get("item_id") == worn["id"]), None)
        return own or (choices[0] if choices else None)
    starters = [e for e in choices if e.get("starter_lot")]
    if starters:
        return starters[0]
    rest = sorted((e for e in choices if not e.get("starter_lot")), key=lambda e: _price(e, side))
    return rest[0] if rest else None


def _kit_gear(rules: Rules, store: dict, entries: dict, side: str) -> dict:
    """What `side`'s board wears, as arena-shop.js _kitLoadout builds it."""
    picks = (store.get(side) or {}).get("gear") or {}
    gear = {}
    for slot in GEAR_SLOTS:
        kind = SHOP_BOARD_TYPES.get(slot) or ("Armor" if slot == "ArmorVest" else None)
        if slot in SHOP_BOARD_TYPES and picks.get(slot) == "":
            continue
        picked = _first_of_lineup(rules, store, entries, kind, side) if kind else None
        if picked:
            item_id = picked.get("item_id")
        elif slot in SHOP_GEAR_SLOTS:
            pick = picks.get(slot)
            if pick == "":
                item_id = None
            else:
                plain = slot in SHOP_PLAIN_SLOTS
                fits = (
                    pick in rules.gear_ids
                    and rules.extras[pick].gear_slot == slot
                    and not (plain and pick in rules.armor_ids)
                )
                item_id = pick if pick and fits else (_kit_node(rules, side, slot) or {}).get("id")
        else:
            item_id = (_kit_node(rules, side, slot) or {}).get("id")
        if item_id:
            gear[slot] = {"id": item_id}
    return gear


def shop_problems(rules: Rules, store: dict) -> list[str]:
    """A BlastGang shop's problems, as short codes (empty when it may publish)."""
    out: list[str] = []
    entries = _shop_entries(rules)
    for shop_id, build in (store.get("builds") or {}).items():
        entry = entries.get(shop_id)
        if not entry or entry.get("type") not in SHOP_WEAPON_TYPES or not isinstance(build, dict):
            continue
        pairs = build.get("pairs") or []
        banned = set(entry.get("excluded_mods") or [])
        if any(p[1] in banned for p in pairs):
            out.append("shop_part")
            continue
        if missing_required(rules.required, entry.get("item_id"), pairs):
            out.append("shop_missing_part")
            continue
        if not entry.get("meta_max"):
            continue
        ids = [entry.get("item_id")] + [p[1] for p in pairs]
        # The page counts a build only once it has every part's points
        if any(i not in rules.extras for i in ids):
            continue
        meta = sum(rules.mp(i) for i in ids)
        if meta > entry["meta_max"] or meta < (entry.get("meta_min") or 0):
            out.append("shop_range")
    for side in SHOP_SIDES:
        if gear_conflicts(rules, _kit_gear(rules, store, entries, side)):
            out.append("conflict")
    return out


def preset_problems(rules: Rules, class_id: str, loadout: dict) -> list[str]:
    if class_id == BLAST_GANG:
        return shop_problems(rules, loadout) if rules.shop else ["shop_gone"]
    if class_id not in rules.classes:
        return ["class_gone"]
    return loadout_problems(rules, class_id, loadout)


# ----------------------------------------------------------------------
# Published presets a data update broke
# ----------------------------------------------------------------------


def recheck_published(builds_db, arena_db, force: bool = False) -> int | None:
    """Take every published Arena preset the current data finds a problem with out of the
    community, telling its publisher. Returns how many went, or None when there were too
    many to trust (services/build_check.py unlist_allowed) and none went."""
    from models_builds import PendingNotification, PublicBuild

    rules = Rules(arena_db)
    published = builds_db.query(PublicBuild).filter(PublicBuild.game == GAME_ARENA).all()
    broken = []
    for preset in published:
        try:
            loadout = json.loads(preset.loadout_json or "{}")
        except ValueError:
            loadout = {}
        if not isinstance(loadout, dict):
            loadout = {}
        try:
            problems = preset_problems(rules, preset.gun_id, loadout)
        except Exception as exc:  # one odd preset never stops the rest
            _logger.warning("Arena presets: could not check preset %s: %s", preset.id, exc)
            continue
        if problems:
            broken.append((preset, problems))
    if not force and not unlist_allowed(len(broken), len(published), "Arena presets"):
        return None

    # Their stored drawings go once the rows are gone (services/arena_drawings.py)
    gone: list[tuple[int, str | None]] = []
    for preset, problems in broken:
        if preset.ip_hash != "admin":
            builds_db.add(
                PendingNotification(
                    ip_hash=preset.ip_hash,
                    type="arena_unlist",
                    data_json=json.dumps(
                        {
                            "build_name": preset.build_name,
                            "class_id": preset.gun_id,
                            "class_name": preset.gun_name,
                            "problems": sorted(set(problems)),
                        }
                    ),
                )
            )
        gone.append((preset.id, preset.drawings_json))
        builds_db.delete(preset)
        _logger.info("Arena presets: unlisted %s (%s): %s", preset.id, preset.build_name, ",".join(problems))
    builds_db.commit()
    if gone:
        from services.arena_drawings import delete_drawings

        for build_id, drawings_json in gone:
            delete_drawings(drawings_json, build_id)
    return len(gone)


def _read_stamp() -> dict:
    try:
        with open(_STAMP_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def recheck_if_needed() -> int:
    """Check the published presets again when Arena's data, or these checks, changed since
    the last time. Run by services/snapshots.py under the schema lock, so one worker of a
    multi-process server does it."""
    from database_arena import ArenaSessionLocal
    from database_builds import BuildsSessionLocal
    from services import arena

    if not arena.available():
        return 0
    with ArenaSessionLocal() as arena_db:
        snap = (arena.setting(arena_db, "snapshot", {}) or {}).get("stamp") or arena.db_stamp()
        stamp = {"data": snap, "version": CHECK_VERSION}
        if _read_stamp() == stamp:
            return 0
        with BuildsSessionLocal() as builds_db:
            removed = recheck_published(builds_db, arena_db)
    # Too many to trust: nothing went, and the next check tries again
    if removed is None:
        return 0
    tmp = _STAMP_FILE + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(stamp, f)
        os.replace(tmp, _STAMP_FILE)
    except OSError as exc:
        _logger.warning("Arena presets: could not record the check: %s", exc)
    return removed
