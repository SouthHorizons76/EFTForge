"""Loaded-ammo regressions that also run in CI without the game database."""

import os

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

os.environ.setdefault("IP_HASH_SECRET", "optimizer-ammo-test-secret")
os.environ.setdefault("ADMIN_API_KEY", "optimizer-ammo-test-admin")

from database import Base
from models_items import Item
from optimizer.solver import OptimizeParams, optimize_weapon
from stats import _compute_stats, apply_full_mag_ammo
from tests.test_reachability_integration import setup_graph


@pytest.fixture
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


MODES = [
    pytest.param({"use_tchebycheff": False}, id="weighted"),
    pytest.param({"use_tchebycheff": True}, id="tchebycheff"),
    pytest.param({"use_evo_ergo": True}, id="evo-ergo"),
]


def setup_magazines(db, factory=False):
    # The heavy build reproduces the reported X-17 numbers: 30.8 ergo,
    # 4.392 kg empty (+1.25 EED), 4.622 kg loaded (-2.20 EED).
    gun = {"weight": 3.982, "base_ergonomics": 30.8}
    if factory:
        gun.update(factory_attachment_ids="heavy", factory_weight=4.392, factory_ergonomics=30.8)
    setup_graph(
        db,
        {("mag", "gun"): ["heavy", "light"]},
        required=["mag"],
        fields={
            "gun": gun,
            "heavy": {"weight": 0.410, "magazine_capacity": 10, "ergonomics_modifier": 0, "recoil_modifier": -0.1},
            "light": {"weight": 0.210, "magazine_capacity": 10, "ergonomics_modifier": 0, "recoil_modifier": 0},
            "ammo": {"is_ammo": True, "weight": 0.023},
        },
    )


def assert_loaded_stats_match(db, result, ammo_id="ammo", grenade_id=None):
    mods = {iid: db.get(Item, iid) for iid in result["selected_items"]}
    expected = _compute_stats(db.get(Item, "gun"), result["selected_items"], mods)
    apply_full_mag_ammo(
        expected,
        mods,
        db.get(Item, ammo_id) if ammo_id else None,
        db.get(Item, grenade_id) if grenade_id else None,
        10,
        0.0,
    )
    assert result["final_stats"] == expected


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("factory", [False, True])
def test_prevent_overswing_checks_loaded_build(db, mode, factory):
    setup_magazines(db, factory)
    options = dict(mode, prevent_overswing=True, selected_ammo_id="ammo", ergo_weight=0, recoil_weight=1)
    empty = optimize_weapon(db, "gun", OptimizeParams(**options, assume_full_mag=False))
    assert empty["selected_items"] == ["heavy"]
    loaded = optimize_weapon(db, "gun", OptimizeParams(**options))
    assert loaded["status"] == "optimal"
    assert loaded["final_stats"]["overswing"] is False
    assert loaded["final_stats"]["evo_ergo_delta"] >= 0
    assert loaded["selected_items"] == ["light"]
    assert_loaded_stats_match(db, loaded)
    # Request-local weights must not dirty ORM rows or leak into the next solve.
    assert not db.dirty
    assert db.get(Item, "heavy").weight == 0.410
    again = optimize_weapon(db, "gun", OptimizeParams(**options, assume_full_mag=False))
    assert again["final_stats"] == empty["final_stats"]


@pytest.mark.parametrize("mode", MODES)
def test_weight_limit_includes_ammo(db, mode):
    setup_magazines(db)
    options = dict(mode, max_weight=4.5, selected_ammo_id="ammo", ergo_weight=0, recoil_weight=1)
    result = optimize_weapon(db, "gun", OptimizeParams(**options))
    assert result["status"] == "optimal"
    assert result["final_stats"]["total_weight"] <= 4.5
    assert result["selected_items"] == ["light"]
    assert_loaded_stats_match(db, result)


@pytest.mark.parametrize("constraint", [{"max_weight": 4.5}, {"prevent_overswing": True}])
def test_forced_overweight_loaded_build_is_infeasible(db, constraint):
    setup_magazines(db)
    result = optimize_weapon(db, "gun", OptimizeParams(**constraint, include_items=["heavy"], selected_ammo_id="ammo"))
    assert result["status"] == "infeasible"
    assert result["selected_items"] == []


@pytest.mark.parametrize("large_mag_ergo", [0, 5])
def test_evo_ergo_ranks_magazines_by_loaded_weight(db, large_mag_ergo):
    setup_magazines(db)
    db.get(Item, "gun").weight = 1.0
    db.get(Item, "light").magazine_capacity = 60
    # At +5 ergo, high and low tangent anchors find different magazines.
    # The final candidate ranking must use loaded EED as well as the objective.
    db.get(Item, "light").ergonomics_modifier = large_mag_ergo
    db.get(Item, "heavy").recoil_modifier = 0
    db.commit()
    options = dict(use_evo_ergo=True, ergo_weight=1, recoil_weight=0, selected_ammo_id="ammo")
    empty = optimize_weapon(db, "gun", OptimizeParams(**options, assume_full_mag=False))
    loaded = optimize_weapon(db, "gun", OptimizeParams(**options))
    assert empty["selected_items"] == ["light"]
    assert loaded["selected_items"] == ["heavy"]
    assert_loaded_stats_match(db, loaded)


@pytest.mark.parametrize("ammo_id", [None, "missing", "light"])
def test_missing_or_non_ammo_selection_keeps_empty_weight(db, ammo_id):
    setup_magazines(db)
    result = optimize_weapon(
        db, "gun", OptimizeParams(prevent_overswing=True, selected_ammo_id=ammo_id, ergo_weight=0, recoil_weight=1)
    )
    assert result["status"] == "optimal"
    assert result["selected_items"] == ["heavy"]
    assert result["final_stats"]["total_weight"] == 4.392


@pytest.mark.parametrize("mode", MODES)
def test_ubgl_grenade_participates_in_overswing_constraint(db, mode):
    setup_magazines(db)
    for iid in ["heavy", "light"]:
        item = db.get(Item, iid)
        item.magazine_capacity = None
        item.caliber = "Caliber40x46"
    db.get(Item, "ammo").caliber = "Caliber40x46"
    db.get(Item, "ammo").weight = 0.230
    db.commit()
    result = optimize_weapon(
        db,
        "gun",
        OptimizeParams(**mode, prevent_overswing=True, selected_ubgl_ammo_id="ammo", ergo_weight=0, recoil_weight=1),
    )
    assert result["status"] == "optimal"
    assert result["final_stats"]["overswing"] is False
    assert result["selected_items"] == ["light"]
    assert_loaded_stats_match(db, result, ammo_id=None, grenade_id="ammo")
