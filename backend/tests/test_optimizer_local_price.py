"""Check bounded price substitutions independently of native solver tie-breaking."""

import copy
import os
from dataclasses import replace

import numpy as np
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

os.environ.setdefault("IP_HASH_SECRET", "local-price-test")
os.environ.setdefault("ADMIN_API_KEY", "local-price-test")

from database import Base
from models_items import Item
from models_item_offers import ItemOffer
from optimizer import local_price, milp
from optimizer.solver import OptimizeParams, _load_candidates_and_prices
from tests.test_reachability_integration import setup_graph


@pytest.fixture
def model(monkeypatch):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        setup_graph(
            db,
            {
                ("receiver", "gun"): ["expensive_receiver", "cheap_receiver"],
                ("stock", "gun"): ["old_stock", "new_stock"],
                ("handle", "gun"): ["expensive_handle", "cheap_handle"],
                ("accessory", "gun"): ["lever"],
            },
            required=["receiver", "stock", "handle"],
            fields={
                "gun": {"weight": 2, "base_ergonomics": 40},
                "expensive_receiver": {"ergonomics_modifier": 2.5, "recoil_modifier": -0.045, "weight": 0.1},
                "cheap_receiver": {
                    "ergonomics_modifier": 7,
                    "recoil_modifier": -0.04,
                    "weight": 0.1,
                    "conflicting_item_ids": "lever",
                },
                "old_stock": {"ergonomics_modifier": 3, "recoil_modifier": -0.235, "weight": 0.1},
                "new_stock": {"ergonomics_modifier": 1, "recoil_modifier": -0.24, "weight": 0.1},
                "expensive_handle": {"ergonomics_modifier": 3.5, "recoil_modifier": 0, "weight": 0.1},
                "cheap_handle": {"ergonomics_modifier": 3, "recoil_modifier": 0, "weight": 0.1},
                "lever": {"ergonomics_modifier": 2, "recoil_modifier": 0, "weight": 0.1},
                "ammo": {"is_ammo": True, "weight": 0.01},
            },
        )
        costs = {
            "expensive_receiver": 1600000,
            "cheap_receiver": 67000,
            "old_stock": 18000,
            "new_stock": 54000,
            "expensive_handle": 1280000,
            "cheap_handle": 9000,
            "lever": 6000,
        }
        for iid, amount in costs.items():
            db.query(ItemOffer).filter_by(item_id=iid).update({"price": amount, "price_rub": amount})
        db.commit()
        # Use deterministic work limits in correctness tests, not wall-clock speed.
        monkeypatch.setattr(local_price.time, "perf_counter", lambda: 0.0)
        yield db
    engine.dispose()


def run_cleanup(db, params=None, deadline=1, status="optimal"):
    params = params or OptimizeParams(use_tchebycheff=False)
    weapon, compat, mods, (ids, prices) = _load_candidates_and_prices(db, "gun", params)
    ammo = db.get(Item, params.selected_ammo_id) if params.assume_full_mag and params.selected_ammo_id else None
    stats = milp._SolveStats(weapon, mods, params, ammo)
    ids, idx, cb, slots, *_ = milp._build_constraints(weapon, mods, compat, ids, prices, params, stats)
    source = {
        "status": status,
        "selected_items": ["expensive_receiver", "old_stock", "expensive_handle", "lever"],
        "metrics": {"solver_ms": 200},
    }
    source["total_price_rub"] = sum(prices[i]["price_rub"] for i in source["selected_items"])
    before = copy.deepcopy(source)
    result = local_price.improve_price(source, weapon, mods, compat, slots, ids, idx, prices, cb, stats, deadline)
    assert source == before
    if result["status"] in ("optimal", "feasible"):
        selected = result["selected_items"]
        x = np.zeros(len(ids) + 1)
        x[[idx[i] for i in selected]] = 1
        x[-1] = min(100, weapon.base_ergonomics + sum(mods[i].ergonomics_modifier or 0 for i in selected))
        constraint = cb.build()
        lhs = constraint.A @ x
        assert np.all(lhs >= constraint.lb - 1e-7)
        assert np.all(lhs <= constraint.ub + 1e-7)
        actual, original = stats.compute(selected), stats.compute(source["selected_items"])
        assert actual["total_ergo"] >= original["total_ergo"]
        assert actual["recoil_vertical"] <= original["recoil_vertical"]
        assert result["total_price_rub"] <= source["total_price_rub"]
    return result, source


def test_compensating_swaps_remove_conflicts_then_reuse_the_ergo_surplus(model, monkeypatch):
    def no_native_solver(*args, **kwargs):
        pytest.fail("Price cleanup must not invoke MILP")

    monkeypatch.setattr(milp, "milp", no_native_solver)
    result, source = run_cleanup(model)
    assert set(result["selected_items"]) == {"cheap_receiver", "new_stock", "cheap_handle"}
    assert result["total_price_rub"] == 130000
    assert result["metrics"]["local_price_saved_rub"] == source["total_price_rub"] - 130000
    assert result["metrics"]["local_price_checks"] <= local_price.MAX_ROUNDS * local_price.MAX_CHECKS


@pytest.mark.parametrize(
    "params",
    [
        OptimizeParams(include_items=["lever"]),
        OptimizeParams(max_ergonomics=51),
        OptimizeParams(include_categories=[["keep-lever"]]),
    ],
)
def test_all_model_constraints_apply_to_replacements(model, params):
    model.get(Item, "lever").category_ids = "keep-lever"
    model.commit()
    result, source = run_cleanup(model, replace(params, use_tchebycheff=False))
    assert result["selected_items"] == source["selected_items"]


def test_free_factory_parts_cannot_be_removed_or_replaced(model):
    model.get(Item, "gun").factory_attachment_ids = "lever"
    model.commit()
    result, _ = run_cleanup(model)
    assert "lever" in result["selected_items"]
    assert "expensive_receiver" in result["selected_items"]


def test_loaded_ammo_weight_can_block_a_cheaper_combination(model):
    model.get(Item, "old_stock").magazine_capacity = 10
    model.get(Item, "new_stock").magazine_capacity = 100
    model.commit()
    params = OptimizeParams(use_tchebycheff=False, selected_ammo_id="ammo", max_weight=2.5)
    result, source = run_cleanup(model, params)
    assert result["selected_items"] == source["selected_items"]
    empty, _ = run_cleanup(model, replace(params, assume_full_mag=False))
    assert empty["total_price_rub"] == 130000


def test_shared_deadline_skips_optional_work(model):
    result, source = run_cleanup(model, deadline=0)
    assert result is source


def test_native_timeout_incumbent_does_not_become_optimal(model):
    result, _ = run_cleanup(model, status="feasible")
    assert result["total_price_rub"] == 130000
    assert result["status"] == "feasible"


def test_single_solve_path_does_not_enable_cleanup_implicitly(model, monkeypatch):
    def unexpected_cleanup(*args, **kwargs):
        pytest.fail("Only the explicit Explore mode may enable cleanup")

    monkeypatch.setattr(milp, "improve_price", unexpected_cleanup)
    from optimizer.solver import optimize_weapon

    result = optimize_weapon(model, "gun", OptimizeParams(use_tchebycheff=False), objective_axis="recoil")
    assert result["status"] == "optimal"


def test_children_without_a_reachable_parent_are_removed(model):
    from models_slots import Slot

    model.get(Slot, "accessory").parent_item_id = "expensive_receiver"
    model.get(Item, "cheap_receiver").conflicting_item_ids = None
    model.commit()
    result, _ = run_cleanup(model)
    assert set(result["selected_items"]) == {"cheap_receiver", "new_stock", "cheap_handle"}


def test_displayed_recoil_must_not_regress_at_equal_model_recoil(model, monkeypatch):
    compute = milp._SolveStats.compute

    def display_cliff(self, selected):
        stats = compute(self, selected)
        if "cheap_receiver" in selected:
            stats["recoil_vertical"] += 1
        return stats

    monkeypatch.setattr(milp._SolveStats, "compute", display_cliff)
    result, source = run_cleanup(model)
    assert result["selected_items"] == source["selected_items"]


def test_cleanup_keeps_one_native_solve_and_rebuilds_parent_first_slots(model, monkeypatch):
    source = {
        "status": "optimal",
        "selected_items": ["expensive_receiver", "old_stock", "expensive_handle", "lever"],
        "metrics": {},
    }
    calls = []

    def native(*args, **kwargs):
        calls.append(1)
        return copy.deepcopy(source)

    monkeypatch.setattr(milp, "_solve_once", native)
    from optimizer.solver import optimize_weapon, prepare_optimize_weapon

    params = OptimizeParams(use_tchebycheff=False)
    prepared = prepare_optimize_weapon(model, "gun", params)
    prepared.local_price_cleanup = True
    result = optimize_weapon(model, "gun", params, objective_axis="recoil", prepared=prepared)
    assert len(calls) == result["metrics"]["solve_count"] == 1
    assert result["total_price_rub"] == 130000
    assert {iid for _slot, iid in result["slot_pairs"]} == set(result["selected_items"])
    assert result["grand_total_rub"] == 130100
