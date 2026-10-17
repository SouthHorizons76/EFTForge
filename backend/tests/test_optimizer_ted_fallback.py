"""Tangent TED cuts must not leave a valid build reported as infeasible (issue 60)."""

import os
import random
from itertools import product

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

os.environ.setdefault("IP_HASH_SECRET", "optimizer-ted-fallback-test-secret")
os.environ.setdefault("ADMIN_API_KEY", "optimizer-ted-fallback-test-admin")

from database import Base  # noqa: E402
from models_items import Item  # noqa: E402
from optimizer import milp  # noqa: E402
from optimizer.solver import OptimizeParams, optimize_weapon  # noqa: E402
from stats import _compute_stats  # noqa: E402
from tests.test_reachability_integration import setup_graph  # noqa: E402


@pytest.fixture
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def setup_choices(db, choices, base_ergo):
    fields = {"gun": {"base_ergonomics": base_ergo, "weight": 3}}
    for item_id, ergo, weight, recoil in choices:
        fields[item_id] = {"ergonomics_modifier": ergo, "weight": weight, "recoil_modifier": recoil}
    setup_graph(db, {("choice", "gun"): [choice[0] for choice in choices]}, required=["choice"], fields=fields)


def setup_distant_valid_build(db, margin, equipment=0):
    # The solver tries bad_first (lowest recoil, fails the floor) first. A tangent
    # cut at its ergo also cuts off valid_better, the only build that passes.
    scale = 1 + equipment
    setup_choices(
        db, [("bad_first", 0, 2.1, -0.3), ("valid_better", 30 / scale, 6, -0.2)], base_ergo=(40 + margin) / scale
    )


def count_outer_fallbacks(monkeypatch):
    calls = []
    original = milp._solve_with_outer_ted

    def counted(*args, **kwargs):
        calls.append(kwargs)
        return original(*args, **kwargs)

    monkeypatch.setattr(milp, "_solve_with_outer_ted", counted)
    return calls


@pytest.mark.parametrize(
    "constraint", [{"prevent_overswing": True}, {"min_true_ergo_delta": 0}, {"min_true_ergo_delta": 10}]
)
@pytest.mark.parametrize("equipment", [-0.2, 0, 0.05])
def test_valid_build_beyond_a_tangent_cut_is_still_found(db, monkeypatch, constraint, equipment):
    setup_distant_valid_build(db, constraint.get("min_true_ergo_delta", 0), equipment)
    calls = count_outer_fallbacks(monkeypatch)
    params = OptimizeParams(use_tchebycheff=False, equip_ergo_modifier=equipment, **constraint)

    result = optimize_weapon(db, "gun", params, objective_axis="recoil")

    assert result["status"] == "optimal"
    assert result["selected_items"] == ["valid_better"]
    assert not result["final_stats"]["overswing"]
    assert result["final_stats"]["true_ergo_delta"] >= constraint.get("min_true_ergo_delta", 0)
    assert len(calls) == 1


def test_fast_path_alone_handles_a_build_that_passes_first(db, monkeypatch):
    setup_choices(db, [("light", 0, 0.1, -0.3), ("heavy", 0, 6, -0.2)], base_ergo=50)
    calls = count_outer_fallbacks(monkeypatch)

    result = optimize_weapon(db, "gun", OptimizeParams(use_tchebycheff=False, prevent_overswing=True))

    assert result["selected_items"] == ["light"]
    assert calls == []


def test_build_found_after_a_tangent_cut_is_flagged_until_verified(db):
    # bad_first overswings, so the loop adds a tangent cut before accepting good.
    setup_choices(db, [("bad_first", 0, 2.1, -0.3), ("good", 0, 1.9, -0.1)], base_ergo=40)

    unchecked = optimize_weapon(
        db, "gun", OptimizeParams(use_tchebycheff=False, prevent_overswing=True), objective_axis="recoil"
    )
    checked = optimize_weapon(
        db,
        "gun",
        OptimizeParams(use_tchebycheff=False, prevent_overswing=True, verify_ted_optimum=True),
        objective_axis="recoil",
    )

    assert unchecked["selected_items"] == checked["selected_items"] == ["good"]
    assert unchecked["status"] == checked["status"] == "optimal"
    assert unchecked["optimality_unproven"] is True
    assert "optimality_unproven" not in checked


def test_build_accepted_without_a_tangent_cut_is_not_flagged(db):
    setup_choices(db, [("light", 0, 0.1, -0.3), ("heavy", 0, 6, -0.2)], base_ergo=50)

    result = optimize_weapon(
        db, "gun", OptimizeParams(use_tchebycheff=False, prevent_overswing=True), objective_axis="recoil"
    )

    assert "optimality_unproven" not in result


def test_genuinely_infeasible_floor_stays_infeasible(db):
    # Both builds are too heavy for 20 TED at their ergo, so the fallback has to agree.
    setup_choices(db, [("heavy", 0, 2.1, -0.3), ("heavier", 5, 6, -0.2)], base_ergo=45)

    result = optimize_weapon(db, "gun", OptimizeParams(use_tchebycheff=False, min_true_ergo_delta=20))

    assert result["status"] == "infeasible"
    assert result["selected_items"] == []


def bands_only(monkeypatch):
    # Send every TED-floor solve straight to the band search so it can be checked on its own.
    def solve(
        c, cb, n, item_ids, idx, weapon, mods, slots, prices, _base_ergo, _base_weight, equip, strength, floor, **kw
    ):
        kw.pop("verify", None)
        return milp._solve_with_outer_ted(
            c, cb, n, item_ids, idx, weapon, mods, slots, prices, equip, strength, [], min_true_ergo_delta=floor, **kw
        )

    monkeypatch.setattr(milp, "_solve_with_min_true_ergo", solve)


def setup_random_gun(db, seed):
    rng = random.Random(seed)
    slots = {}
    fields = {"gun": {"base_ergonomics": rng.uniform(30, 50), "weight": rng.uniform(2.0, 3.5)}}
    for slot in ("a", "b", "c"):
        slots[(slot, "gun")] = []
        for k in range(4):
            item_id = f"{slot}{k}"
            slots[(slot, "gun")].append(item_id)
            fields[item_id] = {
                "ergonomics_modifier": rng.choice([-10, -5, 0, 5, 10, 15, 20]),
                "weight": round(rng.uniform(0.05, 1.6), 3),
                "recoil_modifier": round(rng.uniform(-0.1, 0.05), 3),
            }
    setup_graph(db, slots, required=["a", "b", "c"], fields=fields)
    mods = {item_id: db.get(Item, item_id) for item_id in fields if item_id != "gun"}
    return db.get(Item, "gun"), mods, list(slots.values())


def assert_matches_brute_force(db, weapon, mods, slots, params):
    best = None
    for build in product(*slots):
        stats = _compute_stats(weapon, list(build), mods, params.strength_level, params.equip_ergo_modifier)
        if params.prevent_overswing and stats["overswing"]:
            continue
        if params.min_true_ergo_delta is not None and stats["true_ergo_delta"] < params.min_true_ergo_delta - 1e-7:
            continue
        recoil = sum(mods[i].recoil_modifier for i in build)
        best = recoil if best is None else min(best, recoil)

    result = optimize_weapon(db, "gun", params, objective_axis="recoil")

    if best is None:
        assert result["status"] == "infeasible"
        return
    assert result["status"] == "optimal"
    assert not (params.prevent_overswing and result["final_stats"]["overswing"])
    if params.min_true_ergo_delta is not None:
        assert result["final_stats"]["true_ergo_delta"] >= params.min_true_ergo_delta - 1e-7
    assert sum(mods[i].recoil_modifier for i in result["selected_items"]) == pytest.approx(best, abs=1e-9)


@pytest.mark.parametrize("seed", range(12))
def test_band_search_matches_brute_force(db, monkeypatch, seed):
    weapon, mods, slots = setup_random_gun(db, seed)
    bands_only(monkeypatch)
    for floor in (-10, 0, 10, 25):
        params = OptimizeParams(use_tchebycheff=False, min_true_ergo_delta=float(floor))
        assert_matches_brute_force(db, weapon, mods, slots, params)


@pytest.mark.parametrize("seed", range(12))
def test_verified_endpoint_matches_brute_force(db, seed):
    # The tangent loop runs first here; the verification has to catch what it misses.
    weapon, mods, slots = setup_random_gun(db, seed)
    constraints = [{"prevent_overswing": True}] + [{"min_true_ergo_delta": float(f)} for f in (-10, 0, 10, 25)]
    for constraint in constraints:
        params = OptimizeParams(use_tchebycheff=False, verify_ted_optimum=True, **constraint)
        assert_matches_brute_force(db, weapon, mods, slots, params)


def test_weighted_tchebycheff_solve_keeps_its_z_bound_after_fallback(db):
    setup_distant_valid_build(db, 0)

    result = optimize_weapon(db, "gun", OptimizeParams(prevent_overswing=True))

    assert result["status"] in ("optimal", "feasible")
    assert result["selected_items"] == ["valid_better"]
