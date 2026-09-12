"""Regression tests for the optimizer's hard process boundary."""

import os

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


@pytest.mark.skipif(
    not os.path.exists(os.path.join(os.path.dirname(__file__), "..", "tarkov.db")),
    reason="requires a synced tarkov.db",
)
def test_real_optimizer_job_crosses_process_boundary():
    result = process_runner.run_job("optimize", "5447a9cd4bdc2dbd208b4567", OptimizeParams())

    assert result["status"] in ("optimal", "feasible")
    assert result["selected_items"]
