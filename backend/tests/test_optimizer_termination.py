"""Regression tests for MILP termination reporting.

These tests use small fake HiGHS results, so they run without tarkov.db and
pin the distinction between infeasible, timed out, and feasible-at-time-limit.
"""

from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from optimizer.milp import (
    ConstraintBuilder,
    _aggregate_attempt_metrics,
    _solve_avoiding_overswing,
    _solve_once,
    build_and_solve,
)


def _result(status, x=None, success=False):
    return SimpleNamespace(
        status=status,
        success=success,
        x=x,
        message={0: "Optimal", 1: "Time limit reached", 2: "Infeasible"}.get(status, "Solver error"),
        mip_node_count=3,
        mip_dual_bound=1.25,
        mip_gap=0.1,
    )


def _run(fake_result, deadline=None):
    with patch("optimizer.milp.milp", return_value=fake_result):
        return _solve_once(
            np.array([1.0]),
            ConstraintBuilder(1),
            1,
            ["mod"],
            "weapon",
            {"mod": [("slot", "weapon")]},
            {"mod": {"price_rub": 100}},
            deadline=deadline,
        )


def test_infeasible_is_reported_separately():
    result = _run(_result(2))

    assert result["status"] == "infeasible"
    assert result["selected_items"] == []
    assert result["termination"]["solver_status_code"] == 2


def test_timeout_without_incumbent_is_not_infeasible():
    result = _run(_result(1))

    assert result["status"] == "timeout"
    assert result["selected_items"] == []
    assert "time limit" in result["reason"].lower()


def test_timeout_with_fractional_vector_is_not_treated_as_an_incumbent():
    result = _run(_result(1, x=np.array([0.5, 50.0])))

    assert result["status"] == "timeout"
    assert result["selected_items"] == []


def test_timeout_with_incumbent_preserves_feasible_build():
    result = _run(_result(1, x=np.array([1.0, 50.5])))

    assert result["status"] == "feasible"
    assert result["selected_items"] == ["mod"]
    assert result["slot_pairs"] == [["slot", "mod"]]
    assert result["total_price_rub"] == 100


def test_optimal_result_remains_optimal():
    result = _run(_result(0, x=np.array([1.0, 50.5]), success=True))

    assert result["status"] == "optimal"
    assert result["reason"] is None


def test_solve_once_uses_only_the_remaining_shared_budget():
    with (
        patch("optimizer.milp.time.perf_counter", return_value=95.0),
        patch("optimizer.milp.milp", return_value=_result(0, x=np.array([1.0, 50.5]), success=True)) as solve,
    ):
        result = _solve_once(
            np.array([1.0, 0.0]),
            ConstraintBuilder(2),
            1,
            ["mod"],
            "weapon",
            {"mod": [("slot", "weapon")]},
            {"mod": {"price_rub": 100}},
            deadline=100.0,
        )

    assert result["status"] == "optimal"
    assert solve.call_args.kwargs["options"]["time_limit"] == 5.0


def test_expired_shared_budget_does_not_start_another_solver():
    with (
        patch("optimizer.milp.time.perf_counter", return_value=101.0),
        patch("optimizer.milp.milp") as solve,
    ):
        result = _solve_once(
            np.array([1.0, 0.0]),
            ConstraintBuilder(2),
            1,
            ["mod"],
            "weapon",
            {"mod": [("slot", "weapon")]},
            {"mod": {"price_rub": 100}},
            deadline=100.0,
        )

    assert result["status"] == "timeout"
    assert result["metrics"]["solve_count"] == 0
    solve.assert_not_called()


def test_nested_attempt_metrics_are_not_undercounted():
    metrics = _aggregate_attempt_metrics(
        [
            {
                "status": "feasible",
                "metrics": {
                    "matrix_build_ms": 3.0,
                    "solver_ms": 7.0,
                    "solve_count": 2,
                    "solve_status_counts": {"feasible": 1, "optimal": 1},
                },
            },
            {"status": "optimal", "metrics": {"matrix_build_ms": 2.0, "solver_ms": 5.0}},
        ]
    )

    assert metrics == {
        "matrix_build_ms": 5.0,
        "solver_ms": 12.0,
        "solve_count": 3,
        "solve_status_counts": {"feasible": 1, "optimal": 2},
    }


def test_lazy_overswing_cut_preserves_incomplete_status_and_metrics():
    feasible = {
        "status": "feasible",
        "reason": "time limit",
        "selected_items": ["mod"],
        "slot_pairs": [],
        "termination": {"solver_status_code": 1},
        "metrics": {"matrix_build_ms": 1.0, "solver_ms": 2.0},
    }
    optimal = {
        "status": "optimal",
        "reason": None,
        "selected_items": [],
        "slot_pairs": [],
        "termination": {"solver_status_code": 0},
        "metrics": {"matrix_build_ms": 3.0, "solver_ms": 4.0},
    }
    weapon = SimpleNamespace(id="weapon")

    with (
        patch("optimizer.milp._solve_once", side_effect=[feasible, optimal]) as solve,
        patch("optimizer.milp._compute_stats", side_effect=[{"overswing": True}, {"overswing": False}]),
        patch("optimizer.milp._add_overswing_cut_at"),
    ):
        result = _solve_avoiding_overswing(
            np.array([1.0]),
            ConstraintBuilder(1),
            1,
            ["mod"],
            {"mod": 0},
            weapon,
            {"mod": SimpleNamespace(ergonomics_modifier=0)},
            {"mod": [("slot", "weapon")]},
            {"mod": {"price_rub": 100}},
            50,
            3.0,
            0.0,
            10,
            deadline=123.0,
        )

    assert result["status"] == "feasible"
    assert result["metrics"]["solve_count"] == 2
    assert result["metrics"]["solve_status_counts"] == {"feasible": 1, "optimal": 1}
    assert len(result["termination"]["attempts"]) == 2
    assert [call.kwargs["deadline"] for call in solve.call_args_list] == [123.0, 123.0]


def test_true_ergo_anchor_sweep_stops_at_the_shared_deadline():
    params = SimpleNamespace(
        use_true_ergo=True,
        true_ergo_k=None,
        prevent_overswing=False,
        equip_ergo_modifier=0.0,
        strength_level=10,
        ergo_weight=1.0,
        recoil_weight=1.0,
        price_weight=1.0,
    )
    weapon = SimpleNamespace(id="weapon")
    mod = SimpleNamespace(ergonomics_modifier=0, weight=0, recoil_modifier=0)
    optimal = {
        "status": "optimal",
        "reason": None,
        "selected_items": ["mod"],
        "slot_pairs": [],
        "termination": {"solver_status_code": 0},
        "metrics": {"matrix_build_ms": 1.0, "solver_ms": 2.0},
    }

    with (
        patch("optimizer.milp.time.perf_counter", side_effect=[0.0, 1.0, 1.0, 31.0]),
        patch(
            "optimizer.milp._build_constraints",
            return_value=(["mod"], {"mod": 0}, ConstraintBuilder(2), {}, 50, 3.0, 100, 1),
        ),
        patch("optimizer.milp._true_ergo_objective", return_value=np.zeros(2)),
        patch("optimizer.milp._solve_once", return_value=optimal) as solve,
        patch("optimizer.milp._compute_stats", return_value={"true_ergo_delta": 1.0}),
    ):
        result = build_and_solve(weapon, {"mod": mod}, None, ["mod"], {"mod": {"price_rub": 100}}, params)

    assert result["status"] == "feasible"
    assert result["metrics"]["solve_count"] == 1
    assert solve.call_count == 1
    assert solve.call_args.kwargs["deadline"] == 30.0
