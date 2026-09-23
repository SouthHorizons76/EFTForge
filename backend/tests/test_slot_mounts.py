"""Verify generated physical rail hints and compatibility-derived offset optic ports."""

import importlib.util
import json
import math
from pathlib import Path
import sqlite3

import pytest
from sqlalchemy import event

import slot_mounts
from models_items import Item
from models_slot_allowed import SlotAllowedItem
from models_slots import Slot
from tests import test_slot_semantics

db = test_slot_semantics.db

_SPEC = importlib.util.spec_from_file_location(
    "generate_slot_mounts", Path(__file__).resolve().parents[2] / "scripts" / "generate_slot_mounts.py"
)
_GENERATOR = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_GENERATOR)
IDENTITY = [0, 0, 0, 1]
TOP = [-math.sqrt(0.5), 0, 0, math.sqrt(0.5)]
BOTTOM = [0, -math.sqrt(0.5), math.sqrt(0.5), 0]
LEFT = [-0.5, 0.5, -0.5, 0.5]
RIGHT = [-0.5, -0.5, 0.5, 0.5]


@pytest.mark.parametrize(
    "rotation, orientations, expected",
    [
        (TOP, [IDENTITY], "top"),
        (BOTTOM, [IDENTITY], "bottom"),
        (LEFT, [IDENTITY], "left"),
        (RIGHT, [IDENTITY], "right"),
        (LEFT, [[0, 0, 1, 0]], "right"),
        (TOP, [[0, 0, 1, 0]], "bottom"),
        (LEFT, [IDENTITY, [0, 0, 1, 0]], "unknown"),
        (TOP, [IDENTITY, [0, 0, 0, -1]], "top"),
        ([-0.6532815, 0.270598, -0.270598, 0.6532815], [IDENTITY], "left"),
        (IDENTITY, [IDENTITY], "unknown"),
        ([0, 0, 0, 0], [IDENTITY], "unknown"),
        ([float("nan"), 0, 0, 1], [IDENTITY], "unknown"),
        (TOP, [[0, 0, 1]], "unknown"),
        (TOP, [], "unknown"),
    ],
)
def test_geometry_uses_facing_and_composed_owner_orientation(rotation, orientations, expected):
    # Deliberately put the pivot above the part; side rails must follow their normal.
    assert slot_mounts.classify_bone_mount({"rot": rotation, "pos": [0, 0.05, 0.2]}, orientations) == expected


def test_missing_geometry_and_stale_metadata_are_safe(monkeypatch):
    assert slot_mounts.classify_bone_mount(None, [IDENTITY]) == "unknown"
    for data in [
        {},
        {"items": {"part": 5}, "profiles": []},
        {"items": {"part": 0}, "profiles": [{"mod_mount": "bad"}]},
    ]:
        monkeypatch.setattr(slot_mounts, "_load_metadata", lambda: data)
        assert slot_mounts.slot_mount_fields("part", "mod_mount") == {
            "slot_mount": "unknown",
            "slot_mount_source": "unknown",
        }
    monkeypatch.setattr(
        slot_mounts, "_load_metadata", lambda: {"items": {"part": 0}, "profiles": [{"mod_mount": "left"}]}
    )
    assert slot_mounts.slot_mount_hint("part", "mod_mount_001") == ("unknown", "unknown")
    assert slot_mounts.slot_mount_hint("new-part", "mod_mount") == ("unknown", "unknown")


@pytest.mark.parametrize(
    "game_name", ["mod_scope_001", "mod_mount", "mod_mount_002", "mod_tactical_003", "mod_tactical001"]
)
def test_new_accessory_ports_use_current_singleton_compatibility(monkeypatch, game_name):
    monkeypatch.setattr(slot_mounts, "_load_metadata", lambda: {})
    assert slot_mounts.slot_mount_fields("new-handguard", game_name, [slot_mounts.MPR45_ID]) == {
        "slot_mount": "offset_left",
        "slot_mount_source": "compatibility",
    }
    for name, candidates in [
        ("mod_scope", []),
        ("mod_scope", [slot_mounts.MPR45_ID, "other"]),
        ("mod_foregrip", [slot_mounts.MPR45_ID]),
        ("mod_barrel", [slot_mounts.MPR45_ID]),
    ]:
        assert slot_mounts.slot_mount_fields("new-handguard", name, candidates)["slot_mount"] == "unknown"


def _catalogue(reverse=False, optic_name="mod_scope"):
    connection = sqlite3.connect(":memory:")
    connection.executescript("""
        CREATE TABLE items (id TEXT, category_ids TEXT);
        CREATE TABLE slots (id TEXT, parent_item_id TEXT, slot_game_name TEXT);
        CREATE TABLE slot_allowed_items (slot_id TEXT, allowed_item_id TEXT);
        """)
    items = [
        ("hg-a", "55818a104bdc2db9688b4569"),
        ("hg-b", "55818a104bdc2db9688b4569"),
        ("structural", "55818a594bdc2db9688b456a"),
    ]
    slots = [
        ("a", "hg-a", "mod_mount_000"),
        ("b", "hg-b", "mod_mount_000"),
        ("scope-a", "hg-a", optic_name),
        ("scope-b", "hg-b", optic_name),
        ("struct", "hg-a", "mod_mount_001"),
        ("foregrip", "hg-a", "mod_foregrip"),
        ("unknown", "hg-a", "mod_tactical"),
        ("receiver", "hg-a", "mod_reciever"),
    ]
    allowed = [
        ("scope-a", slot_mounts.MPR45_ID),
        ("scope-b", slot_mounts.MPR45_ID),
        ("struct", "structural"),
        ("foregrip", slot_mounts.MPR45_ID),
        ("receiver", slot_mounts.MPR45_ID),
    ]
    connection.executemany("INSERT INTO items VALUES (?, ?)", list(reversed(items)) if reverse else items)
    connection.executemany("INSERT INTO slots VALUES (?, ?, ?)", list(reversed(slots)) if reverse else slots)
    connection.executemany(
        "INSERT INTO slot_allowed_items VALUES (?, ?)", list(reversed(allowed)) if reverse else allowed
    )
    connection.execute("PRAGMA query_only = ON")
    return connection


@pytest.mark.parametrize("optic_name", ["mod_scope", "mod_mount_002", "mod_tactical001"])
def test_generator_is_deterministic_deduplicated_and_excludes_structural_ports(optic_name):
    bone_map = {"mod_mount_000": {"rot": LEFT}, "mod_mount_001": {"rot": LEFT}, "mod_foregrip": {"rot": TOP}}
    bones = {"weapons": [{"tpl": owner, "bones": bone_map} for owner in ["hg-a", "hg-b"]]}
    manifest = {
        "version": 5,
        "templates": {owner: "shared-model" for owner in ["hg-a", "hg-b"]},
        "models": {"shared-model": [{"q": IDENTITY}]},
    }
    outputs = []
    for reverse in [False, True]:
        with _catalogue(reverse, optic_name) as connection:
            data, report = _GENERATOR.generate(connection, bones, manifest)
        outputs.append(_GENERATOR.encode(data))
    assert outputs[0] == outputs[1]
    assert data["profiles"] == [{"mod_mount_000": "left", optic_name: "offset_left"}]
    assert data["items"] == {"hg-a": 0, "hg-b": 0}
    assert report["structural_filters_skipped"] == report["unknown"] == 1
    assert json.loads(outputs[0]) == data
    with _catalogue() as connection, pytest.raises(ValueError, match="version 5"):
        _GENERATOR.generate(connection, bones, {**manifest, "version": 99})


def test_checked_in_profiles_keep_explicit_grips_bipods_out_of_geometry():
    data = json.loads(slot_mounts._DATA_PATH.read_text(encoding="utf-8"))
    assert data["version"] == 1
    assert all(not slot.startswith(("mod_foregrip", "mod_bipod")) for profile in data["profiles"] for slot in profile)
    assert slot_mounts.slot_mount_hint("5bb20de5d4351e0035629e59", "mod_tactical_000") == ("top", "geometry")
    assert slot_mounts.slot_mount_hint("5bb20de5d4351e0035629e59", "mod_tactical_001") == ("right", "geometry")
    assert slot_mounts.slot_mount_hint("5bb20de5d4351e0035629e59", "mod_tactical_002") == ("left", "geometry")


def test_slot_mounts_agree_across_load_paths_without_per_slot_queries(db, monkeypatch):
    import main

    monkeypatch.setattr(
        slot_mounts,
        "_load_metadata",
        lambda: {
            "items": {"adapter": 0},
            "profiles": [{"mod_mount_000": "left", "mod_mount_001": "right", "mod_scope": "offset_left"}],
        },
    )
    db.add(Item(id=slot_mounts.MPR45_ID, name="Unrelated translated name"))
    db.add(SlotAllowedItem(slot_id="empty", allowed_item_id=slot_mounts.MPR45_ID))
    for index in range(30):
        sid = f"new-scope-{index}"
        db.add(Slot(id=sid, parent_item_id="adapter", slot_game_name=f"mod_scope_{index:03d}", slot_name="Stock"))
        db.add(SlotAllowedItem(slot_id=sid, allowed_item_id=slot_mounts.MPR45_ID))
    for raw_name in ["mod_mount_020", "mod_tactical001"]:
        db.add(Slot(id=raw_name, parent_item_id="adapter", slot_game_name=raw_name))
        db.add(SlotAllowedItem(slot_id=raw_name, allowed_item_id=slot_mounts.MPR45_ID))
    db.commit()
    single = main.get_item_slots("adapter", db)
    assert single == main.get_item_slots_batch(["adapter"], db)["adapter"]
    assert single == main.get_gun_init("gun", db=db)["slots_by_item"]["adapter"]
    result = {slot["id"]: slot for slot in single}
    assert result["optic"]["slot_mount"] == "left"
    assert result["mixed"]["slot_mount"] == "right"
    assert result["empty"]["slot_mount"] == "offset_left"
    assert result["unknown"]["slot_mount"] == "unknown"
    assert all(result[f"new-scope-{i}"]["slot_mount_source"] == "compatibility" for i in range(30))
    assert all(result[name]["slot_mount"] == "offset_left" for name in ["mod_mount_020", "mod_tactical001"])

    slots = db.query(Slot).filter(Slot.parent_item_id == "adapter").all()
    statements = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(db.bind, "before_cursor_execute", record)
    try:
        main._slot_dtos(db, slots)
    finally:
        event.remove(db.bind, "before_cursor_execute", record)
    assert len(statements) == 2

    db.add(SlotAllowedItem(slot_id="empty", allowed_item_id="scope"))
    db.add(SlotAllowedItem(slot_id="new-scope-0", allowed_item_id="scope"))
    db.commit()
    changed = {slot["id"]: slot for slot in main.get_item_slots("adapter", db)}
    assert changed["empty"]["slot_mount"] == changed["new-scope-0"]["slot_mount"] == "unknown"
