"""Check request-scoped input reuse against independent solves and database changes."""

import os
from dataclasses import replace

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

os.environ.setdefault("IP_HASH_SECRET", "optimizer-prepared-test-secret")
os.environ.setdefault("ADMIN_API_KEY", "optimizer-prepared-test-admin")

from database import Base
from models_item_offers import ItemOffer
from models_weapon_presets import WeaponDefaultPreset
from optimizer.solver import OptimizeParams, optimize_weapon, prepare_optimize_weapon
from tests.test_reachability_integration import setup_graph


@pytest.fixture
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def setup_tradeoffs(db, *, nested=False, preset=True):
    edges = {("mag", "gun"): ["heavy", "light"]}
    fields = {
        "gun": {"weight": 2.0, "base_ergonomics": 60, "factory_attachment_ids": "heavy"},
        "heavy": {"weight": 0.5, "magazine_capacity": 30, "ergonomics_modifier": -10, "recoil_modifier": -0.3},
        "light": {"weight": 0.2, "magazine_capacity": 30, "ergonomics_modifier": 10, "recoil_modifier": 0},
        "ammo": {"is_ammo": True, "weight": 0.012},
    }
    if nested:
        edges[("attachment", "heavy")] = ["tip"]
        fields["tip"] = {"ergonomics_modifier": 1, "recoil_modifier": 0}
    if preset:
        fields["preset"] = {}
    setup_graph(db, edges, required=["mag"], fields=fields)
    if preset:
        db.add(WeaponDefaultPreset(weapon_id="gun", preset_id="preset"))
        db.query(ItemOffer).filter_by(item_id="preset").update({"price": 50, "price_rub": 50})
        db.commit()


def without_metrics(result):
    return {key: value for key, value in result.items() if key != "metrics"}


@pytest.mark.parametrize("nested", [False, True])
@pytest.mark.parametrize("preset", [False, True])
def test_prepared_solves_match_fresh_constraints_stats_and_prices_without_queries(db, nested, preset):
    setup_tradeoffs(db, nested=nested, preset=preset)
    params = OptimizeParams(selected_ammo_id="ammo")
    variants = [params, replace(params, min_ergonomics=65), replace(params, max_recoil_v=75)]
    expected = [optimize_weapon(db, "gun", p, objective_axis="recoil") for p in variants]
    assert all(result["status"] == "optimal" for result in expected)
    assert "heavy" in expected[0]["selected_items"]
    assert "light" in expected[1]["selected_items"]
    prepared = prepare_optimize_weapon(db, "gun", params)
    first = optimize_weapon(db, "gun", params, objective_axis="recoil", prepared=prepared)
    assert without_metrics(first) == without_metrics(expected[0])
    assert first["metrics"]["candidate_prepare_ms"] >= 0

    statements = []

    def capture(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(db.bind, "before_cursor_execute", capture)
    try:
        for variant, reference in zip(variants, expected):
            result = optimize_weapon(db, "gun", variant, objective_axis="recoil", prepared=prepared)
            assert without_metrics(result) == without_metrics(reference)
        infeasible = optimize_weapon(db, "gun", replace(params, min_ergonomics=1000), prepared=prepared)
        assert infeasible["status"] == "infeasible"
    finally:
        event.remove(db.bind, "before_cursor_execute", capture)
    assert statements == []
    assert not db.dirty


@pytest.mark.parametrize(
    "changes",
    [
        {"include_items": ["light"]},
        {"exclude_items": ["heavy"]},
        {"exclude_categories": ["category"]},
        {"trader_levels": {"mechanic": 0}},
        {"flea_available": False},
        {"player_level": 1},
        {"game_mode": "pve"},
        {"assume_full_mag": False},
        {"selected_ammo_id": "other"},
        {"selected_ubgl_ammo_id": "ammo"},
    ],
)
def test_prepared_rejects_changed_loading_inputs(db, changes):
    setup_tradeoffs(db)
    params = OptimizeParams(selected_ammo_id="ammo")
    prepared = prepare_optimize_weapon(db, "gun", params)
    with pytest.raises(ValueError, match="same session, weapon, market filters and ammo"):
        optimize_weapon(db, "gun", replace(params, **changes), prepared=prepared)


def test_prepared_rejects_mutated_filters_and_other_session_or_weapon(db):
    setup_tradeoffs(db)
    params = OptimizeParams(trader_levels={"mechanic": 1}, include_items=["heavy"])
    prepared = prepare_optimize_weapon(db, "gun", params)
    params.trader_levels["mechanic"] = 0
    with pytest.raises(ValueError):
        optimize_weapon(db, "gun", params, prepared=prepared)
    params.trader_levels["mechanic"] = 1
    params.include_items.append("light")
    with pytest.raises(ValueError):
        optimize_weapon(db, "gun", params, prepared=prepared)
    params.include_items.pop()
    with pytest.raises(ValueError):
        optimize_weapon(db, "other-gun", params, prepared=prepared)
    with Session(db.bind) as other_db, pytest.raises(ValueError):
        optimize_weapon(other_db, "gun", params, prepared=prepared)


def test_new_context_refreshes_changed_market_data(db):
    setup_tradeoffs(db)
    params = OptimizeParams(selected_ammo_id="ammo")
    previous = optimize_weapon(db, "gun", params, prepared=prepare_optimize_weapon(db, "gun", params))
    db.query(ItemOffer).update({"price": 900, "price_rub": 900})
    db.commit()
    fresh = optimize_weapon(db, "gun", params)
    prepared = prepare_optimize_weapon(db, "gun", params)
    current = optimize_weapon(db, "gun", params, prepared=prepared)
    assert without_metrics(current) == without_metrics(fresh)
    assert current["grand_total_rub"] != previous["grand_total_rub"]
    assert current["ammo_fill"]["price"]["price_rub"] == 900


def test_missing_weapon_preserves_error_result(db):
    params = OptimizeParams()
    prepared = prepare_optimize_weapon(db, "missing", params)
    assert optimize_weapon(db, "missing", params, prepared=prepared) == optimize_weapon(db, "missing", params)
