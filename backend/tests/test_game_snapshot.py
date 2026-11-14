"""Reading a game data snapshot into our columns, and the main game's optional overwrite.

Only made-up data (tests/snapshot_fixture.py): no real game data belongs in this repo."""

import json
import os
from datetime import datetime, timedelta, timezone

import pytest

from game_snapshot import GameData, SnapshotError, load_snapshot, pick_snapshot_file
from tests import snapshot_fixture as fx


@pytest.fixture
def data():
    return GameData(fx.make_snapshot())


def test_weapon_columns_follow_the_tarkov_dev_sync(data):
    cols = data.item_columns(fx.RIFLE)
    assert cols["weight"] == 3.0
    assert cols["base_ergonomics"] == cols["ergonomics_modifier"] == 50
    assert (cols["recoil_vertical"], cols["recoil_horizontal"]) == (120, 300)
    assert (cols["rec_force_up"], cols["rec_force_back"]) == (120, 300)
    assert cols["caliber"] == "CaliberTest"
    assert cols["recoil_stable_angle"] == 28
    assert (cols["recoil_center_y"], cols["recoil_center_z"]) == (-0.25, 0.1)
    assert cols["default_ammo_id"] == fx.ROUND_A
    assert data.weapon_category(fx.RIFLE) == "Assault rifle"
    assert data.weapon_skill(fx.RIFLE) == "Assault"
    assert data.weapon_category(fx.PISTOL) == "Handgun"


def test_a_default_ammo_that_is_no_round_is_left_out(data):
    assert "default_ammo_id" not in data.item_columns(fx.PISTOL)


def test_mod_percentages_become_fractions(data):
    cols = data.item_columns(fx.BARREL)
    assert cols["recoil_modifier"] == -0.03
    assert cols["accuracy_modifier"] == 2
    assert (cols["heat_factor"], cols["cooling_factor"]) == (0.95, 1.05)
    # exactly 1 changes nothing, and tarkov.dev leaves it empty
    assert cols["durability_burn_factor"] is None
    assert (cols["velocity_modifier"], cols["loudness"]) == (-2, 5)
    assert cols["center_of_impact"] == 0.03


def test_magazines_and_sights(data):
    mag = data.item_columns(fx.MAGAZINE)
    assert mag["magazine_capacity"] == 30
    # the tarkov.dev sync keeps a magazine's recoil at 0, so a magazine has no say in it
    assert "recoil_modifier" not in mag
    sight = data.item_columns(fx.SIGHT)
    assert sight["sighting_range"] == 200
    assert "loudness" not in sight and "velocity_modifier" not in sight


def test_ammo_and_launcher_columns(data):
    ammo = data.item_columns(fx.ROUND_A)
    assert (ammo["ammo_damage"], ammo["penetration_power"], ammo["velocity"]) == (50, 40, 900)
    assert (ammo["ammo_accuracy_modifier"], ammo["ammo_recoil_modifier"]) == (-0.05, 0.05)
    assert data.item_columns(fx.LAUNCHER)["caliber"] == "CaliberTestGrenade"


def test_armor(data):
    assert data.armor_kind(fx.VEST) == "armor"
    assert data.armor_kind(fx.HELMET) == "helmet"
    # a cap is headwear too, but protects nothing
    assert data.armor_kind(fx.CAP) is None
    vest = data.item_columns(fx.VEST)
    assert (vest["speed_penalty"], vest["turn_penalty"], vest["ergo_penalty"]) == (-0.06, -0.02, -0.03)
    pieces, plate_slots, defaults = data.armor_rows()
    soft = next(p for p in pieces if p["holder_item_id"] == fx.VEST)
    assert (soft["slot_name_id"], soft["insert_item_id"], soft["armor_class"]) == (
        "Soft_armor_front",
        fx.SOFT_INSERT,
        2,
    )
    assert soft["body_colliders"] == "RibcageUp"
    helmet = next(p for p in pieces if p["holder_item_id"] == fx.HELMET)
    assert helmet["slot_name_id"] is None and helmet["armor_class"] == 3
    (front,) = plate_slots
    assert front["allowed_plate_ids"] == f"{fx.PLATE_A},{fx.PLATE_B}"
    assert front["blunt_reduce_from_soft_armor"] is True
    assert {"holder_item_id": fx.VEST, "slot_name_id": "Front_plate", "item_id": fx.PLATE_A} in defaults


def test_slots_resolve_classes_and_skip_armor_sections(data):
    slots = {s["name_id"]: s for s in data.slots(fx.RIFLE)}
    assert set(slots["mod_pistol_grip"]["allowed"]) == {fx.GRIP_A, fx.GRIP_B}
    assert slots["mod_pistol_grip"]["required"] is True
    assert slots["mod_pistol_grip"]["name"] == "Pistol Grip"
    assert data.slots(fx.VEST) == []


def test_conflicts_split_items_from_slots(data):
    assert data.conflicts(fx.GRIP_A) == ([], [fx.S_SIGHT])
    items, slots = data.conflicts(fx.BARREL)
    assert set(items) == {fx.GRIP_A, fx.GRIP_B} and slots == []


def test_default_presets(data):
    preset_id, parts = data.default_presets()[fx.RIFLE]
    assert preset_id == fx.PRESET
    assert {"tpl": fx.BRAKE, "slot": "mod_muzzle", "parent_tpl": fx.BARREL} in parts


def test_names(data):
    assert data.name(fx.RIFLE) == "Test rifle"
    assert data.name(fx.RIFLE, "zh", short=True) == "TR-1"


def _write(path, obj):
    path.write_text(json.dumps(obj), encoding="utf-8")


def test_a_file_is_read_as_it_is(tmp_path):
    path = tmp_path / "snap.json"
    _write(path, fx.make_snapshot())
    assert pick_snapshot_file(str(path)) == str(path)
    assert load_snapshot(str(path))["version"] == "0.0.0.1"


def test_a_folder_reads_its_newest_snapshot_at_once(tmp_path):
    now = datetime(2026, 1, 2, 12, tzinfo=timezone.utc)
    entries = []
    for name, minutes_ago in (("old.json", 600), ("new.json", 1)):
        _write(tmp_path / name, fx.make_snapshot())
        entries.append({"file": name, "detected": (now - timedelta(minutes=minutes_ago)).isoformat()})
    # newer, but outside the folder or missing: never read
    entries.append({"file": "../escape.json", "detected": now.isoformat()})
    entries.append({"file": "gone.json", "detected": now.isoformat()})
    _write(tmp_path / "index.json", {"snapshots": entries})
    assert pick_snapshot_file(str(tmp_path)) == os.path.join(str(tmp_path), "new.json")


def test_nothing_configured_reads_nothing(tmp_path):
    assert pick_snapshot_file("") is None
    assert pick_snapshot_file(str(tmp_path / "missing")) is None


def test_a_wrong_format_is_refused(tmp_path):
    path = tmp_path / "snap.json"
    _write(path, {**fx.make_snapshot(), "format": 99})
    with pytest.raises(SnapshotError):
        load_snapshot(str(path))


@pytest.fixture
def main_db(tmp_path, monkeypatch):
    os.environ.setdefault("IP_HASH_SECRET", "snapshot-test-secret")
    os.environ.setdefault("ADMIN_API_KEY", "snapshot-test-admin")
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    import config
    from database import Base
    from models_items import Item

    engine = create_engine("sqlite://")
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add_all(
        [
            Item(
                id=fx.RIFLE,
                name="tarkov.dev rifle",
                weight=2.5,
                ergonomics_modifier=45,
                base_ergonomics=45,
                recoil_vertical=110,
                recoil_horizontal=290,
                is_weapon=True,
                icon_link="dev-icon",
                factory_attachment_ids=f"{fx.RIFLE},{fx.GRIP_A}",
                trader_price=1000,
            ),
            Item(id=fx.GRIP_A, name="tarkov.dev grip", weight=0.1, ergonomics_modifier=8, recoil_modifier=-0.01),
            # what the game data doesn't know stays as tarkov.dev has it
            Item(id="f" * 24, name="only on tarkov.dev", weight=9.0),
        ]
    )
    db.commit()
    path = tmp_path / "snap.json"
    _write(path, fx.make_snapshot())
    monkeypatch.setattr(config, "GAME_SNAPSHOT_PATH", str(path))
    import game_snapshot

    monkeypatch.setattr(game_snapshot, "_applied_file", lambda: str(tmp_path / "applied.json"))
    yield db, Item
    db.close()


def test_the_main_game_takes_the_snapshot_stats_and_keeps_the_rest(main_db):
    import sync_tarkov_dev

    db, Item = main_db
    sync_tarkov_dev._apply_game_snapshot(db)
    rifle = db.get(Item, fx.RIFLE)
    assert (rifle.weight, rifle.base_ergonomics, rifle.recoil_vertical) == (3.0, 50, 120)
    # names, images and prices stay tarkov.dev's
    assert (rifle.name, rifle.icon_link, rifle.trader_price) == ("tarkov.dev rifle", "dev-icon", 1000)
    # the factory figures follow the new part stats
    assert rifle.factory_weight == pytest.approx(3.1)
    assert rifle.factory_ergonomics == 58
    assert rifle.factory_recoil_vertical == round(120 * (1 - 0.01))
    assert db.get(Item, "f" * 24).weight == 9.0


def test_no_snapshot_changes_nothing(main_db, monkeypatch):
    import config
    import sync_tarkov_dev

    db, Item = main_db
    monkeypatch.setattr(config, "GAME_SNAPSHOT_PATH", "")
    sync_tarkov_dev._apply_game_snapshot(db)
    assert db.get(Item, fx.RIFLE).weight == 2.5


def test_an_unreadable_snapshot_changes_nothing(main_db, monkeypatch, tmp_path):
    import config
    import sync_tarkov_dev

    db, Item = main_db
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    monkeypatch.setattr(config, "GAME_SNAPSHOT_PATH", str(bad))
    sync_tarkov_dev._apply_game_snapshot(db)
    assert db.get(Item, fx.RIFLE).weight == 2.5
