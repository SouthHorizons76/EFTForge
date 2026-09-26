"""Regression tests for the optimizer's hard process boundary."""

import os
from types import SimpleNamespace

import pytest

from optimizer import process_runner
from optimizer.solver import OptimizeParams


def _capture_cleanup(monkeypatch):
    cleaned = []
    real_stop = process_runner._stop_process

    def stop(process):
        real_stop(process)
        cleaned.append(process)

    monkeypatch.setattr(process_runner, "_stop_process", stop)
    return cleaned


def test_hard_timeout_terminates_optimizer_child(monkeypatch):
    monkeypatch.setattr(process_runner, "PROCESS_HARD_TIMEOUT_SECONDS", 0.001)
    cleaned = _capture_cleanup(monkeypatch)

    result = process_runner.run_job("optimize", "unused", OptimizeParams())

    assert result["status"] == "timeout"
    assert result["metrics"]["hard_timeout"] is True
    assert len(cleaned) == 1
    assert not cleaned[0].is_alive()


def test_closing_explore_stream_terminates_optimizer_child(monkeypatch):
    monkeypatch.setattr(process_runner, "PROCESS_POLL_SECONDS", 0.001)
    monkeypatch.setattr(process_runner, "PROCESS_STARTUP_GRACE_SECONDS", 0.001)
    monkeypatch.setattr(process_runner, "EXPLORE_TIME_LIMIT_SECONDS", 0)
    cleaned = _capture_cleanup(monkeypatch)
    stream = process_runner.stream_explore("unused", OptimizeParams(), "price", 10)

    event = next(stream)
    assert event["data"]["hard_timeout"] is True
    stream.close()

    assert len(cleaned) == 1
    assert not cleaned[0].is_alive()


def test_partial_stream_keeps_actual_solve_and_reuse_counts(monkeypatch):
    events = iter([{"type": "progress", "done": 50, "solve_count": 9, "reused_count": 45, "point": None}])

    def receive_event():
        try:
            return next(events)
        except StopIteration:
            raise EOFError

    connection = SimpleNamespace(poll=lambda timeout: True, recv=receive_event, close=lambda: None)
    monkeypatch.setattr(process_runner, "_start_process", lambda *args: (None, connection))
    monkeypatch.setattr(process_runner, "_stop_process", lambda process: None)
    result = list(process_runner.stream_explore("unused", OptimizeParams(), "price", 81))[-1]["data"]

    assert not result["complete"]
    assert result["hard_timeout"]
    assert result["solve_count"] == 9
    assert result["reused_count"] == 45


def _interrupted_points(monkeypatch, points, params):
    events = iter({"type": "progress", "done": index, "point": point} for index, point in enumerate(points, 1))

    def receive_event():
        try:
            return next(events)
        except StopIteration:
            raise EOFError

    connection = SimpleNamespace(poll=lambda timeout: True, recv=receive_event, close=lambda: None)
    monkeypatch.setattr(process_runner, "_start_process", lambda *args: (None, connection))
    monkeypatch.setattr(process_runner, "_stop_process", lambda process: None)
    return list(process_runner.stream_explore("unused", params, "price", 81))[-1]["data"]


def test_partial_true_ergo_curve_keeps_the_better_true_ergo_point(monkeypatch):
    high_raw = {"ergo": 80, "true_ergo_delta": 0.5, "recoil_v": 50, "price": 100}
    high_true_ergo = {"ergo": 50, "true_ergo_delta": 2.0, "recoil_v": 50, "price": 100}
    result = _interrupted_points(monkeypatch, [high_raw, high_true_ergo], OptimizeParams(use_true_ergo=True))
    assert result["points"] == [high_true_ergo]


@pytest.mark.skipif(
    not os.path.exists(os.path.join(os.path.dirname(__file__), "..", "tarkov.db")),
    reason="requires a synced tarkov.db",
)
def test_real_optimizer_job_crosses_process_boundary():
    result = process_runner.run_job("optimize", "5447a9cd4bdc2dbd208b4567", OptimizeParams())

    assert result["status"] in ("optimal", "feasible")
    assert result["selected_items"]
