"""Check the precomputed ammo effectiveness chart and how it reuses cells between rebuilds."""

import json
import os
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

PS = "a" * 24
BT = "b" * 24
VEST = "c" * 24
VEST_TWIN = "d" * 24
HELMET = "e" * 24
PLATE = "f" * 24
GRENADE = "1" * 24


@pytest.fixture(scope="module")
def api():
    # Import lazily so collection does not initialize the application databases.
    os.environ.setdefault("IP_HASH_SECRET", "chart-test-secret")
    os.environ.setdefault("ADMIN_API_KEY", "chart-test-admin")
    import main  # noqa: F401 - registers every model
    import ammo_chart
    from database import Base
    from models_armor import ArmorPiece
    from models_items import Item

    return SimpleNamespace(Base=Base, Item=Item, ArmorPiece=ArmorPiece, chart=ammo_chart)


@pytest.fixture
def db(api):
    engine = create_engine("sqlite://")
    api.Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    item, piece = api.Item, api.ArmorPiece
    session.add_all(
        [
            item(
                id=PS,
                name="PS",
                is_ammo=True,
                caliber="Caliber762x39",
                ammo_damage=61,
                penetration_power=35,
                armor_damage=52,
            ),
            item(
                id=BT,
                name="BT",
                is_ammo=True,
                caliber="Caliber545x39",
                ammo_damage=54,
                penetration_power=37,
                armor_damage=44,
            ),
            item(
                id=GRENADE,
                name="VOG",
                is_ammo=True,
                caliber="Caliber40mmRU",
                ammo_damage=0,
                penetration_power=0,
                armor_damage=0,
            ),
            item(id=VEST, name="Vest", armor_kind="armor"),
            item(id=VEST_TWIN, name="Vest twin", armor_kind="armor"),
            item(id=HELMET, name="Helmet", armor_kind="helmet"),
            item(id=PLATE, name="Plate", armor_kind="attachment"),
        ]
    )
    soft = dict(armor_class=3, durability=40, material="Aramid", armor_type="Light", blunt_throughput=0.3)
    session.add_all(
        [
            # Two vests with identical soft armor share one setup
            piece(holder_item_id=VEST, slot_name_id="Soft_armor_front", body_colliders="RibcageUp", **soft),
            piece(holder_item_id=VEST_TWIN, slot_name_id="Soft_armor_front", body_colliders="RibcageUp", **soft),
            piece(
                holder_item_id=HELMET,
                slot_name_id="Helmet_top",
                body_colliders="ParietalHead",
                armor_class=4,
                durability=30,
                material="Aramid",
                armor_type="Light",
                blunt_throughput=0.2,
            ),
            piece(
                holder_item_id=PLATE,
                plate_colliders="Plate_Granit_SAPI_chest",
                armor_class=5,
                durability=50,
                material="Ceramic",
                armor_type="Heavy",
                blunt_throughput=0.3,
            ),
        ]
    )
    session.commit()
    yield session
    session.close()


def test_chart_covers_every_round_and_merges_identical_setups(api, db):
    chart = api.chart.build_chart(db, log=lambda *_: None)
    assert [row["id"] for row in chart["ammo"]] == [BT, PS]  # grenades left out
    kinds = {setup["kind"]: setup for setup in chart["setups"]}
    assert set(kinds) == {"body", "helmet", "plate"}
    assert sorted(kinds["body"]["item_ids"]) == [VEST, VEST_TWIN]
    assert len(chart["grid"]) == 2 and all(len(row) == 3 for row in chart["grid"])
    for row in chart["grid"]:
        for s50, s90 in row:
            assert s50 is None or s90 is None or s50 <= s90


def test_body_armor_is_worn_with_its_default_front_plate(api, db):
    from models_armor import ArmorDefaultInsert, ArmorPlateSlot

    carrier = "2" * 24
    db.add(api.Item(id=carrier, name="Carrier", armor_kind="armor"))
    db.add(
        api.ArmorPiece(
            holder_item_id=carrier,
            slot_name_id="Soft_armor_front",
            body_colliders="RibcageUp",
            armor_class=3,
            durability=40,
            material="Aramid",
            armor_type="Light",
            blunt_throughput=0.3,
        )
    )
    db.add(
        ArmorPlateSlot(
            holder_item_id=carrier,
            slot_name_id="Front_plate",
            plate_colliders="Plate_Granit_SAPI_chest",
            allowed_plate_ids=PLATE,
            blunt_reduce_from_soft_armor=True,
        )
    )
    db.add(ArmorDefaultInsert(holder_item_id=carrier, slot_name_id="Front_plate", item_id=PLATE))
    db.commit()

    setups = api.chart.chart_setups(db, api.chart.ballistics.load_player_colliders())
    worn = next(setup for setup in setups if carrier in setup["item_ids"])
    assert worn["kind"] == "body" and worn["plate_ids"] == [PLATE]
    assert worn["plate_zone"] == "Plate_Granit_SAPI_chest" and worn["armor_class"] == 5
    assert worn["plates"][0].blunt_reduce_from_soft_armor and len(worn["soft_layers"]) == 1
    # The same soft armor without a plate stays in its own column
    assert VEST not in worn["item_ids"]


def test_rebuild_only_works_out_cells_whose_inputs_changed(api, db):
    first = api.chart.build_chart(db, log=lambda *_: None)
    lines = []
    api.chart.build_chart(db, first, log=lines.append)
    assert "0 worked out" in lines[-1]

    # A patch changes one round: only its row is worked out again
    db.query(api.Item).filter(api.Item.id == PS).update({"penetration_power": 47})
    db.commit()
    lines.clear()
    api.chart.build_chart(db, first, log=lines.append)
    assert "3 worked out" in lines[-1]


def test_rebuild_reuses_cells_from_every_stored_chart(api, db):
    full = api.chart.build_chart(db, log=lambda *_: None)
    # One stored chart is missing the helmet's column, another has it: nothing is worked out
    helmet = next(i for i, setup in enumerate(full["setups"]) if setup["kind"] == "helmet")
    partial = dict(full, grid=[[cell if i != helmet else None for i, cell in enumerate(row)] for row in full["grid"]])
    partial["setups"] = [dict(s, key="stale") if i == helmet else s for i, s in enumerate(full["setups"])]
    lines = []
    api.chart.build_chart(db, [partial, full], log=lines.append)
    assert "0 worked out" in lines[-1]


def test_newest_stored_chart_is_served(api, tmp_path, monkeypatch):
    runtime, seed = tmp_path / "runtime.json", tmp_path / "seed.json"
    runtime.write_text(json.dumps({"computed_at": "2026-01-01T00:00:00+00:00", "id": "runtime"}))
    seed.write_text(json.dumps({"computed_at": "2026-02-01T00:00:00+00:00", "id": "seed"}))
    monkeypatch.setattr(api.chart, "_runtime_file", lambda: str(runtime))
    monkeypatch.setattr(api.chart, "SEED_FILE", str(seed))
    # A desktop update shipped a newer chart than the one the app refreshed earlier
    assert api.chart.load_chart()["id"] == "seed"


def test_engine_version_bump_works_everything_out_again(api, db, monkeypatch):
    first = api.chart.build_chart(db, log=lambda *_: None)
    monkeypatch.setattr(api.chart, "ENGINE_VERSION", api.chart.ENGINE_VERSION + 1)
    lines = []
    api.chart.build_chart(db, first, log=lines.append)
    assert "6 worked out" in lines[-1]


def test_checked_in_chart_is_current():
    import ammo_chart

    with open(ammo_chart.SEED_FILE, encoding="utf-8") as f:
        chart = json.load(f)
    assert chart["engine_version"] == ammo_chart.ENGINE_VERSION
    assert len(chart["grid"]) == len(chart["ammo"])
    assert all(len(row) == len(chart["setups"]) for row in chart["grid"])
