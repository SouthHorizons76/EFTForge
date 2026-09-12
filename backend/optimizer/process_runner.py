"""Run native optimizer calls behind a process boundary.

HiGHS normally observes its own time limit, but a native solver call cannot be
interrupted safely from the Python thread that invoked it.  Keeping each job in
a disposable child process lets the API enforce a real wall-clock limit and
clean up immediately when a streaming client disconnects.
"""

import multiprocessing
import time
import traceback
from dataclasses import asdict

from optimizer.explore import EXPLORE_TIME_LIMIT_SECONDS, frontier_points
from optimizer.milp import SOLVE_TIME_LIMIT_SECONDS

PROCESS_EXIT_GRACE_SECONDS = 2.0
PROCESS_NORMAL_EXIT_GRACE_SECONDS = 0.2
PROCESS_POLL_SECONDS = 0.1
PROCESS_STARTUP_GRACE_SECONDS = 5.0
PROCESS_HARD_TIMEOUT_SECONDS = SOLVE_TIME_LIMIT_SECONDS + PROCESS_STARTUP_GRACE_SECONDS


def _stop_process(process) -> None:
    process.join(timeout=PROCESS_NORMAL_EXIT_GRACE_SECONDS)
    if not process.is_alive():
        return
    process.terminate()
    process.join(timeout=PROCESS_EXIT_GRACE_SECONDS)
    if process.is_alive():
        process.kill()
        process.join(timeout=PROCESS_EXIT_GRACE_SECONDS)


def _send(connection, event) -> None:
    try:
        connection.send(event)
    except (BrokenPipeError, EOFError, OSError):
        pass


def _job_worker(connection, kind: str, payload: dict) -> None:
    db = None
    try:
        from database import SessionLocal
        from optimizer.gunsmith import solve_gunsmith_task
        from optimizer.solver import OptimizeParams, get_moa_floor, get_stat_ranges, optimize_weapon

        db = SessionLocal()
        if kind == "optimize":
            result = optimize_weapon(db, payload["weapon_id"], OptimizeParams(**payload["params"]))
        elif kind == "stat_ranges":
            result = get_stat_ranges(db, payload["weapon_id"], OptimizeParams(**payload["params"]))
        elif kind == "moa_floor":
            result = get_moa_floor(db, payload["weapon_id"], OptimizeParams(**payload["params"]))
        elif kind == "gunsmith":
            result = solve_gunsmith_task(db, **payload)
        else:
            raise ValueError(f"Unknown optimizer job: {kind}")
        _send(connection, {"type": "result", "data": result})
    except BaseException as exc:
        _send(
            connection,
            {
                "type": "error",
                "message": str(exc) or type(exc).__name__,
                "traceback": traceback.format_exc(),
            },
        )
    finally:
        if db is not None:
            db.close()
        connection.close()


def _explore_worker(connection, payload: dict) -> None:
    db = None
    try:
        from database import SessionLocal
        from optimizer.explore import explore_weapon_stream
        from optimizer.solver import OptimizeParams

        db = SessionLocal()
        for event in explore_weapon_stream(
            db,
            payload["weapon_id"],
            OptimizeParams(**payload["params"]),
            payload["tradeoff"],
            payload["steps"],
        ):
            _send(connection, event)
    except BaseException as exc:
        _send(
            connection,
            {
                "type": "error",
                "message": str(exc) or type(exc).__name__,
                "traceback": traceback.format_exc(),
            },
        )
    finally:
        if db is not None:
            db.close()
        connection.close()


def _start_process(target, *args):
    context = multiprocessing.get_context("spawn")
    receive, send = context.Pipe(duplex=False)
    process = context.Process(target=target, args=(send, *args), daemon=True)
    process.start()
    send.close()
    return process, receive


def _timeout_result() -> dict:
    return {
        "status": "timeout",
        "reason": "The optimizer exceeded its hard wall-clock time limit.",
        "reason_key": "optimizer.solveFailed",
        "selected_items": [],
        "slot_pairs": [],
        "metrics": {"hard_timeout": True},
    }


def run_job(kind: str, weapon_id: str, params, **kwargs) -> dict:
    payload = {"weapon_id": weapon_id, "params": asdict(params), **kwargs}
    process, receive = _start_process(_job_worker, kind, payload)
    deadline = time.monotonic() + PROCESS_HARD_TIMEOUT_SECONDS
    try:
        while time.monotonic() < deadline:
            if receive.poll(min(PROCESS_POLL_SECONDS, max(0, deadline - time.monotonic()))):
                try:
                    event = receive.recv()
                except EOFError:
                    break
                if event["type"] == "result":
                    return event["data"]
                raise RuntimeError(f"Optimizer child failed: {event['message']}\n{event['traceback']}")
            if not process.is_alive():
                break
        return _timeout_result()
    finally:
        receive.close()
        _stop_process(process)


def run_gunsmith(task_name: str, **kwargs) -> dict:
    process, receive = _start_process(_job_worker, "gunsmith", {"task_name": task_name, **kwargs})
    deadline = time.monotonic() + PROCESS_HARD_TIMEOUT_SECONDS
    try:
        while time.monotonic() < deadline:
            if receive.poll(min(PROCESS_POLL_SECONDS, max(0, deadline - time.monotonic()))):
                try:
                    event = receive.recv()
                except EOFError:
                    break
                if event["type"] == "result":
                    return event["data"]
                raise RuntimeError(f"Optimizer child failed: {event['message']}\n{event['traceback']}")
            if not process.is_alive():
                break
        return _timeout_result()
    finally:
        receive.close()
        _stop_process(process)


def stream_explore(weapon_id: str, params, tradeoff: str, steps: int):
    payload = {
        "weapon_id": weapon_id,
        "params": asdict(params),
        "tradeoff": tradeoff,
        "steps": steps,
    }
    process, receive = _start_process(_explore_worker, payload)
    started = time.monotonic()
    deadline = started + EXPLORE_TIME_LIMIT_SECONDS + PROCESS_STARTUP_GRACE_SECONDS
    points = []
    solve_count = 0
    try:
        while time.monotonic() < deadline:
            if receive.poll(min(PROCESS_POLL_SECONDS, max(0, deadline - time.monotonic()))):
                try:
                    event = receive.recv()
                except EOFError:
                    break
                if event["type"] == "error":
                    raise RuntimeError(f"Optimizer child failed: {event['message']}\n{event['traceback']}")
                if event["type"] == "progress":
                    solve_count = event["done"]
                    if event.get("point"):
                        points.append(event["point"])
                yield event
                if event["type"] == "result":
                    return
            elif not process.is_alive():
                break

        frontier = frontier_points(points, tradeoff)
        yield {
            "type": "result",
            "data": {
                "gun_id": weapon_id,
                "tradeoff": tradeoff,
                "steps": steps,
                "points": frontier,
                "complete": False,
                "status": "partial",
                "solve_count": solve_count,
                "processing_ms": round((time.monotonic() - started) * 1000, 3),
                "hard_timeout": True,
            },
        }
    finally:
        receive.close()
        _stop_process(process)
