"""Ammo effectiveness chart: shots to kill for every round against every armor setup.

The whole chart is worked out ahead of time and stored, so the page only reads it. Every
cell is keyed by hashes of exactly what it depends on (that round's ballistics, that armor
setup's stats, the game constants and the engine version), so after a sync we only redo the
cells whose inputs changed. Game patches touch a handful of items, so that's usually quick.

A checked-in copy (ammo_chart.json next to this file) ships with the code so a fresh install
has a chart straight away; refreshed charts go to RUNTIME_DIR and take over from it.
Production sets AMMO_CHART_REFRESH=0 and only ever serves the checked-in copy.

Every cell is the same standard shot: point blank, straight on, full durability, the armor
worn alone. Body armor and rigs are worn as they come and hit in the upper chest, through
their default front plate if they have one and then their soft armor; plates on their own
in front of the upper chest or back, helmets on the top of the head.

Run directly to rebuild the chart against the configured tarkov.db:
    python ammo_chart.py
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone

import ballistics

# Bump whenever the engine's results change, so every cell is worked out again
ENGINE_VERSION = 1
MAX_SHOTS = 30

_HERE = os.path.dirname(os.path.abspath(__file__))
SEED_FILE = os.path.join(_HERE, "ammo_chart.json")


def _runtime_file():
    from config import RUNTIME_DIR

    return os.path.join(RUNTIME_DIR, "ammo_chart.json")


def _lock_file():
    from config import RUNTIME_DIR

    return os.path.join(RUNTIME_DIR, "ammo_chart.lock")


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()[:16]


def _layer_signature(layer):
    return [
        layer.armor_class,
        layer.max_durability,
        layer.material,
        layer.blunt_throughput,
        layer.armor_type,
        layer.blunt_reduce_from_soft_armor,
    ]


def _split(value):
    return [part for part in (value or "").split(",") if part]


def _layer(piece, flagged=False):
    return ballistics.ArmorLayer(
        armor_class=piece.armor_class,
        max_durability=piece.durability,
        durability=piece.durability,
        material=piece.material,
        blunt_throughput=piece.blunt_throughput,
        armor_type=piece.armor_type or "None",
        blunt_reduce_from_soft_armor=flagged,
    )


def chart_setups(db, colliders):
    """[setup] for every armor item, merged where items share identical stats.

    A setup is {"key", "kind", "item_ids", "plate_ids", "collider", "plates", "soft_layers", "plate_zone"},
    plate_ids holding each item's default front plate (None for none)."""
    from models_armor import ArmorDefaultInsert, ArmorPiece, ArmorPlateSlot
    from models_items import Item

    pieces = {}
    for piece in db.query(ArmorPiece).order_by(ArmorPiece.id):
        pieces.setdefault(piece.holder_item_id, []).append(piece)
    plate_slots = {}
    for slot in db.query(ArmorPlateSlot).order_by(ArmorPlateSlot.id):
        plate_slots.setdefault(slot.holder_item_id, []).append(slot)
    defaults = {(insert.holder_item_id, insert.slot_name_id): insert.item_id for insert in db.query(ArmorDefaultInsert)}
    plate_zones = colliders["plates"]

    def front_plate(item):
        """(plate layer, its zone, plate id) for the plate the item comes with in front of the
        upper chest, or None when it comes without one."""
        for slot in plate_slots.get(item.id, []):
            plate_id = defaults.get((item.id, slot.slot_name_id))
            if plate_id is None:
                continue
            for zone in _split(slot.plate_colliders):
                info = plate_zones.get(zone)
                if not info or info["collider"] != "RibcageUp":
                    continue
                for piece in pieces.get(plate_id, []):
                    if zone in _split(piece.plate_colliders):
                        return _layer(piece, flagged=bool(slot.blunt_reduce_from_soft_armor)), zone, plate_id
        return None

    setups = {}

    def add(kind, item, collider, soft, plates=(), zone=None, plate_id=None):
        layers = [*plates, *soft]
        if not layers:
            return
        key = _digest([kind, collider, zone and plate_zones[zone], [_layer_signature(lay) for lay in layers]])
        setup = setups.setdefault(
            key,
            {
                "key": key,
                "kind": kind,
                "item_ids": [],
                "plate_ids": [],
                "collider": collider,
                "plates": list(plates),
                "soft_layers": list(soft),
                "plate_zone": zone,
                "armor_class": max(lay.armor_class for lay in layers),
            },
        )
        setup["item_ids"].append(item.id)
        setup["plate_ids"].append(plate_id)

    for item in db.query(Item).filter(Item.armor_kind.isnot(None)).order_by(Item.name):
        own = pieces.get(item.id, [])
        if item.armor_kind in ("armor", "rig"):
            soft = [_layer(p) for p in own if "RibcageUp" in _split(p.body_colliders)]
            # Worn as it comes: its default front plate goes in front of the soft armor
            plate = front_plate(item)
            if plate:
                layer, zone, plate_id = plate
                add("body", item, "RibcageUp", soft, [layer], zone, plate_id)
            else:
                add("body", item, "RibcageUp", soft)
        elif item.armor_kind == "helmet":
            top = [_layer(p) for p in own if "ParietalHead" in _split(p.body_colliders)]
            add("helmet", item, "ParietalHead", top)
        elif item.armor_kind == "attachment":
            for piece in own:
                # Plates covering the thorax: front plates sit before the upper chest, back
                # plates before the upper back. Side plates cover the stomach, so they're out.
                for zone in _split(piece.plate_colliders):
                    info = plate_zones.get(zone)
                    if info and info["body_part"] == "Chest":
                        add("plate", item, info["collider"], [], [_layer(piece, flagged=True)], zone)
                        break
    return list(setups.values())


def _ammo_signature(ammo):
    return [
        ammo.ammo_damage,
        ammo.penetration_power,
        ammo.armor_damage,
        ammo.penetration_power_deviation or 0.0,
        ammo.penetration_damage_mod or 0.0,
        max(1, ammo.projectile_count or 1),
    ]


def chart_ammo(db):
    from models_items import Item

    rows = (
        db.query(Item)
        .filter(Item.is_ammo == True)  # noqa: E712
        .filter(Item.ammo_damage.isnot(None), Item.penetration_power.isnot(None), Item.armor_damage.isnot(None))
        .order_by(Item.caliber, Item.penetration_power)
        .all()
    )
    # Grenades and flares carry no penetration worth charting
    return [ammo for ammo in rows if (ammo.ammo_damage or 0) > 0 and (ammo.penetration_power or 0) > 0]


def _constants_signature(armor_globals, colliders):
    return _digest(
        [
            ENGINE_VERSION,
            MAX_SHOTS,
            list(armor_globals.class_resistance),
            armor_globals.destructibility,
            armor_globals.blunt_damage_reduce_from_soft_armor_mod,
            armor_globals.damage_degradation_coefficient,
            armor_globals.health,
            colliders,
        ]
    )


def compute_cell(ammo, setup, armor_globals, colliders):
    """[shots for a 50% kill chance, shots for 90%], None where it takes more than MAX_SHOTS."""
    body_part = colliders["body_parts"][setup["collider"]]
    hp = armor_globals.health["parts"][body_part]["max"] + ballistics.spread_capacity(body_part, armor_globals.health)
    plate_collider = None
    if setup["plate_zone"]:
        zone = colliders["plates"][setup["plate_zone"]]
        plate_collider = ballistics.PlateCollider(
            zone["penetration_level"], zone["penetration_chance"], zone["penetration_damage_mod"]
        )
    projectiles = max(1, ammo.projectile_count or 1)
    result = ballistics.simulate(
        ballistics.Ammo(
            damage=ammo.ammo_damage,
            penetration=ammo.penetration_power,
            armor_damage=ammo.armor_damage,
            penetration_deviation=ammo.penetration_power_deviation or 0.0,
            penetration_damage_mod=ammo.penetration_damage_mod or 0.0,
        ),
        hp,
        soft_layers=setup["soft_layers"],
        plates=setup["plates"],
        armor_globals=armor_globals,
        plate_collider=plate_collider,
        max_shots=MAX_SHOTS,
        stop_at_kill_chance=0.9,
        projectiles=projectiles,
    )
    return [result.shots_to_kill(0.5), result.shots_to_kill(0.9)]


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def chart_path():
    """The stored chart worked out most recently, or None if there isn't one. On the website
    both are the same file; the desktop app keeps its own refreshed copy in its data folder,
    and an update can ship a newer checked-in one, which then takes over."""
    paths = [path for path in dict.fromkeys((_runtime_file(), SEED_FILE)) if os.path.exists(path)]
    return max(paths, key=_computed_at, default=None)


_computed_at_cache = {}


def _computed_at(path):
    # Read once per version of the file: the chart endpoint asks on every request
    stamp = (path, os.path.getmtime(path))
    if stamp not in _computed_at_cache:
        _computed_at_cache[stamp] = (_read(path) or {}).get("computed_at") or ""
    return _computed_at_cache[stamp]


def load_chart():
    """The freshest stored chart, or None if there isn't one."""
    path = chart_path()
    return _read(path) if path else None


def build_chart(db, previous=None, log=print):
    """The chart for the current data, reusing every cell of `previous` whose inputs match."""
    armor_globals = ballistics.load_armor_globals()
    colliders = ballistics.load_player_colliders()
    constants = _constants_signature(armor_globals, colliders)
    known = _cells(previous)

    ammo_rows = chart_ammo(db)
    setups = chart_setups(db, colliders)
    ammo_keys = [_digest([_ammo_signature(ammo), constants]) for ammo in ammo_rows]

    grid, worked_out, started = [], 0, time.monotonic()
    for ammo, ammo_key in zip(ammo_rows, ammo_keys):
        row = []
        for setup in setups:
            # Rounds with identical ballistics share a key, so they share the work too
            cell = known.get((ammo_key, setup["key"]))
            if cell is None:
                cell = known[(ammo_key, setup["key"])] = compute_cell(ammo, setup, armor_globals, colliders)
                worked_out += 1
            row.append(cell)
        grid.append(row)
    log(
        f"Ammo chart: {len(ammo_rows)} rounds x {len(setups)} armor setups, "
        f"{worked_out} worked out, {time.monotonic() - started:.0f}s"
    )
    return {
        "engine_version": ENGINE_VERSION,
        "computed_at": datetime.now(timezone.utc).isoformat(),
        "max_shots": MAX_SHOTS,
        "ammo": [{"id": ammo.id, "caliber": ammo.caliber, "key": key} for ammo, key in zip(ammo_rows, ammo_keys)],
        "setups": [
            {
                "key": setup["key"],
                "kind": setup["kind"],
                "item_ids": setup["item_ids"],
                "plate_ids": setup["plate_ids"],
                "armor_class": setup["armor_class"],
            }
            for setup in setups
        ],
        # grid[ammo index][setup index] = [shots for 50%, shots for 90%]
        "grid": grid,
    }


def _cells(charts):
    """{(ammo key, setup key): cell} from stored charts (one or a list), to reuse what still holds."""
    cells = {}
    for chart in charts if isinstance(charts, list) else [charts]:
        if not chart or chart.get("engine_version") != ENGINE_VERSION:
            continue
        setup_keys = [setup["key"] for setup in chart.get("setups", [])]
        for ammo, row in zip(chart.get("ammo", []), chart.get("grid", [])):
            for setup_key, cell in zip(setup_keys, row):
                cells[(ammo["key"], setup_key)] = cell
    return cells


def write_chart(chart, path):
    # Write beside the target and swap it in, so a reader never sees half a file
    folder = os.path.dirname(path)
    fd, temp = tempfile.mkstemp(dir=folder, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(chart, f, separators=(",", ":"))
    os.replace(temp, path)


def refresh(path=None, log=print):
    """Rebuild the stored chart against the configured tarkov.db, reusing what still holds."""
    from database import SessionLocal

    lock = _lock_file()
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.close(fd)
    except FileExistsError:
        # Another refresh is already on it, unless that one died hours ago
        if time.time() - os.path.getmtime(lock) < 6 * 3600:
            log("Ammo chart refresh already running - skipping.")
            return
        os.remove(lock)
        return refresh(path, log)
    try:
        db = SessionLocal()
        try:
            # Cells from both stored charts, so a desktop update's shipped cells are reused too
            known = [_read(p) for p in dict.fromkeys((_runtime_file(), SEED_FILE))]
            chart = build_chart(db, [chart for chart in known if chart], log)
        finally:
            db.close()
        write_chart(chart, path or _runtime_file())
    finally:
        try:
            os.remove(lock)
        except OSError:
            pass


def start_refresh():
    """Refresh the chart without holding up the caller: a low-priority process normally, a
    background thread in the frozen desktop app (which can't run this file as a script).
    Does nothing where AMMO_CHART_REFRESH is off, which keeps the shipped chart."""
    from config import AMMO_CHART_REFRESH

    if not AMMO_CHART_REFRESH:
        return
    if getattr(sys, "frozen", False):
        threading.Thread(target=refresh, kwargs={"log": lambda *_: None}, daemon=True).start()
        return
    kwargs = {"cwd": _HERE, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.BELOW_NORMAL_PRIORITY_CLASS | subprocess.CREATE_NO_WINDOW
    else:
        kwargs["preexec_fn"] = lambda: os.nice(10)
        kwargs["start_new_session"] = True
    subprocess.Popen([sys.executable, os.path.join(_HERE, "ammo_chart.py")], **kwargs)


if __name__ == "__main__":
    refresh(sys.argv[1] if len(sys.argv) > 1 else None)
