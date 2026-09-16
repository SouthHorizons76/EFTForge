"""Check that cached optima preserve each sampled problem and its deadline."""

import os
from types import SimpleNamespace

import pytest

os.environ.setdefault("IP_HASH_SECRET", "explore-reuse-test-secret")
os.environ.setdefault("ADMIN_API_KEY", "explore-reuse-test-admin")

from optimizer import explore  # noqa: E402
from optimizer.solver import OptimizeParams  # noqa: E402


def _prepared(ergo=10):
    return SimpleNamespace(
        weapon=SimpleNamespace(base_ergonomics=30),
        mods={"part": SimpleNamespace(ergonomics_modifier=ergo)},
    )


def _result(status="optimal", displayed_ergo=40):
    return {
        "status": status,
        "selected_items": ["part"],
        "final_stats": {"total_ergo": displayed_ergo},
        "termination": {"mip_dual_bound": -0.30001, "mip_gap": 0.00003},
    }


def test_tightening_retains_the_optimum_and_its_existing_gap_certificate():
    cache = explore._ErgoFloorSolutions(_prepared())
    result = _result()
    cache.add("recoil", 35, result)

    assert cache.get("recoil", 39) is result
    assert cache.get("recoil", 39)["termination"] == result["termination"]
    assert cache.get("recoil", 41) is None
    assert cache.get("price", 39) is None


def test_relaxing_a_boundary_floor_cannot_reuse_its_restricted_optimum():
    cache = explore._ErgoFloorSolutions(_prepared(ergo=71))
    cache.add("recoil", 100, _result(displayed_ergo=101))

    assert cache.get("recoil", 100.5) is not None
    assert cache.get("recoil", 99) is None
    assert cache.get("recoil", None) is None


@pytest.mark.parametrize("status", ["feasible", "timeout", "infeasible", "error"])
def test_only_optimal_results_can_supply_a_reuse_certificate(status):
    cache = explore._ErgoFloorSolutions(_prepared())
    cache.add("recoil", None, _result(status=status))
    assert cache.get("recoil", 35) is None


def test_rounded_display_ergo_cannot_prove_a_linear_floor():
    cache = explore._ErgoFloorSolutions(_prepared(ergo=9.996))
    cache.add("recoil", 39, _result(displayed_ergo=40.00))

    assert cache.get("recoil", 39.995) is not None
    assert cache.get("recoil", 39.998) is None


def test_factory_display_ergo_cannot_replace_the_model_coefficients():
    prepared = _prepared()
    prepared.weapon.factory_attachment_ids = "part"
    prepared.weapon.factory_ergonomics = 60
    cache = explore._ErgoFloorSolutions(prepared)
    cache.add("recoil", 35, _result(displayed_ergo=60))

    assert cache.get("recoil", 39) is not None
    assert cache.get("recoil", 45) is None


@pytest.fixture
def discrete_solver(monkeypatch):
    # Enumerate a tiny unique-optimum problem without invoking HiGHS so we can
    # check every grid point independently of the cache's own decision logic.
    choices = {
        "a": {"ergo": 30, "recoil": 50, "price": 100},
        "b": {"ergo": 40, "recoil": 70, "price": 200},
        "c": {"ergo": 50, "recoil": 90, "price": 400},
    }
    prepared = SimpleNamespace(
        weapon=SimpleNamespace(base_ergonomics=30),
        mods={iid: SimpleNamespace(ergonomics_modifier=row["ergo"] - 30) for iid, row in choices.items()},
        candidate_load_ms=0,
    )
    calls = []
    now = [0.0]

    def solve(db, weapon_id, params, *, deadline, objective_axis=None, prepared=None):
        assert deadline == 30
        calls.append((objective_axis, params.min_ergonomics))
        eligible = {
            iid: row
            for iid, row in choices.items()
            if (params.min_ergonomics is None or row["ergo"] >= params.min_ergonomics)
            and (params.min_eed is None or row["ergo"] >= params.min_eed)
            and (params.max_recoil_v is None or row["recoil"] <= params.max_recoil_v)
        }
        if not eligible:
            return {"status": "infeasible"}
        axis = objective_axis or "ergo"
        iid = min(eligible, key=lambda item: -eligible[item][axis] if axis == "ergo" else eligible[item][axis])
        row = eligible[iid]
        return {
            "status": "optimal",
            "selected_items": [iid],
            "final_stats": {
                "total_ergo": row["ergo"],
                "evo_ergo_delta": row["ergo"],
                "recoil_vertical": row["recoil"],
            },
            "grand_total_rub": row["price"],
        }

    monkeypatch.setattr(explore, "prepare_optimize_weapon", lambda *args: prepared)
    monkeypatch.setattr(explore, "optimize_weapon", solve)
    monkeypatch.setattr(explore.time, "perf_counter", lambda: now[0])
    return SimpleNamespace(choices=choices, calls=calls, now=now)


@pytest.mark.parametrize("tradeoff,axis", [("price", "recoil"), ("recoil", "price")])
def test_reuse_preserves_all_81_grid_samples_and_their_optima(discrete_solver, tradeoff, axis):
    events = list(explore.explore_weapon_stream(None, "gun", OptimizeParams(), tradeoff, 81))
    progress = [event for event in events if event["type"] == "progress"]
    result = events[-1]["data"]

    assert len(progress) == 82
    assert [event["done"] for event in progress] == list(range(1, 83))
    assert all(event["total"] == 82 for event in progress)
    low, high = progress[:2]
    for i, event in enumerate(progress[2:], start=1):
        floor = low["point"]["ergo"] + (high["point"]["ergo"] - low["point"]["ergo"]) * i / 81
        expected = min(row[axis] for row in discrete_solver.choices.values() if row["ergo"] >= floor)
        selected = discrete_solver.choices[event["point"]["build"]["selected_items"][0]]
        assert event["bound_value"] == round(floor, 2)
        assert selected["ergo"] >= floor
        assert selected[axis] == expected

    assert result["complete"]
    assert result["solve_count"] == len(discrete_solver.calls)
    assert result["solve_count"] < 20
    assert result["solve_count"] + result["reused_count"] == 86
    assert [point["ergo"] for point in result["points"]] == [30, 40, 50]


@pytest.mark.parametrize(
    "params",
    [OptimizeParams(prevent_overswing=True), OptimizeParams(use_evo_ergo=True), OptimizeParams(min_eed=0)],
)
def test_nonlinear_modes_do_not_reuse_linear_optimality_certificates(discrete_solver, params):
    result = explore.explore_weapon(None, "gun", params, "price", 10)
    assert result["complete"]
    assert result["reused_count"] == 0


def test_deadline_stops_even_when_the_next_sample_could_reuse_an_optimum(discrete_solver):
    stream = explore.explore_weapon_stream(None, "gun", OptimizeParams(), "price", 81)
    next(stream)
    next(stream)
    first_sample = next(stream)
    assert first_sample["phase"] == "sweep"
    assert first_sample["point"]["ergo"] == 40
    calls_before_deadline = len(discrete_solver.calls)

    discrete_solver.now[0] = 31
    remaining = list(stream)
    assert len(remaining) == 1
    result = remaining[0]["data"]
    assert result["status"] == "partial"
    assert not result["complete"]
    assert result["points"]
    assert len(discrete_solver.calls) == calls_before_deadline


def test_price_cleanup_ergo_gain_keeps_the_original_native_reuse_range():
    cache = explore._ErgoFloorSolutions(_prepared(ergo=10))
    result = _result(displayed_ergo=40)
    result["metrics"] = {"local_price_before_ergo": 35}
    cache.add("recoil", 30, result)
    assert cache.get("recoil", 34) is result
    assert cache.get("recoil", 36) is None


def test_price_cleanup_cannot_move_the_native_sampling_grid(discrete_solver, monkeypatch):
    original_events = list(explore.explore_weapon_stream(None, "gun", OptimizeParams(), "price", 81))
    original_calls = list(discrete_solver.calls)
    discrete_solver.calls.clear()
    native = explore.optimize_weapon

    def cleanup(*args, **kwargs):
        result = native(*args, **kwargs)
        if kwargs.get("objective_axis") == "recoil" and args[2].min_ergonomics is None:
            result["metrics"] = {
                "local_price_before_ergo": 30,
                "local_price_before_display_ergo": 30,
                "local_price_before_display_recoil_v": 50,
            }
            result["final_stats"]["total_ergo"] = 35
        return result

    monkeypatch.setattr(explore, "optimize_weapon", cleanup)
    changed_events = list(explore.explore_weapon_stream(None, "gun", OptimizeParams(), "price", 81))
    assert changed_events[0]["point"]["ergo"] == 35
    assert discrete_solver.calls == original_calls
    assert [e.get("bound_value") for e in changed_events] == [e.get("bound_value") for e in original_events]
