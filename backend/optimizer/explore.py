"""Sample two-objective tradeoffs using epsilon constraints and the native solver."""

import time
from dataclasses import replace

from optimizer.solver import OptimizeParams, optimize_weapon

EXPLORE_TIME_LIMIT_SECONDS = 30


def frontier_points(points, tradeoff):
    # Compare displayed stats and break coordinate ties on the omitted axis.
    x_key, y_key, tie_key = {
        "price": ("ergo", "recoil_v", "price"),
        "recoil": ("ergo", "price", "recoil_v"),
        "ergo": ("recoil_v", "price", "ergo"),
    }[tradeoff]
    unique = {}
    for point in points:
        key = point[x_key], point[y_key]
        previous = unique.get(key)
        sign = -1 if tie_key == "ergo" else 1
        if previous is None or sign * point[tie_key] < sign * previous[tie_key]:
            unique[key] = point
    candidates = list(unique.values())
    sign = 1 if x_key == "recoil_v" else -1
    return sorted(
        [
            p
            for p in candidates
            if not any(
                sign * q[x_key] <= sign * p[x_key]
                and q[y_key] <= p[y_key]
                and (q[x_key] != p[x_key] or q[y_key] != p[y_key])
                for q in candidates
            )
        ],
        key=lambda p: p[x_key],
    )


def explore_weapon(db, weapon_id: str, params: OptimizeParams, tradeoff="price", steps=20):
    if tradeoff not in ("price", "recoil", "ergo") or not 10 <= steps <= 81:
        raise ValueError("Invalid Explore tradeoff or resolution")
    started = time.perf_counter()
    deadline = started + EXPLORE_TIME_LIMIT_SECONDS
    params = replace(params, use_evo_ergo=False, use_tchebycheff=False)
    points, attempts = [], []
    completed = True

    def solve(axis, **overrides):
        nonlocal completed
        if time.perf_counter() >= deadline:
            completed = False
            return None
        result = optimize_weapon(db, weapon_id, replace(params, **overrides), deadline=deadline, objective_axis=axis)
        attempts.append(result["status"])
        if result["status"] not in ("optimal", "infeasible"):
            completed = False
        if result["status"] not in ("optimal", "feasible") or not result.get("final_stats"):
            return None
        stats = result["final_stats"]
        if stats.get("recoil_vertical") is None:
            completed = False
            return None
        point = {
            "ergo": min(100, stats["total_ergo"]),
            "recoil_v": stats["recoil_vertical"],
            "price": result["grand_total_rub"],
            "build": result,
        }
        points.append(point)
        return point

    if tradeoff == "ergo":
        low, high = solve("recoil"), solve("price")
        if low and high:
            span = high["recoil_v"] - low["recoil_v"]
            for i in range(1, steps):
                if span <= 0:
                    break
                if time.perf_counter() >= deadline:
                    completed = False
                    break
                bound = low["recoil_v"] + span * i / steps
                if params.max_recoil_v is not None:
                    bound = min(bound, params.max_recoil_v)
                solve("price", max_recoil_v=bound)
    else:
        axis = "recoil" if tradeoff == "price" else "price"
        low, high = solve(axis), solve("ergo")
        if low and high:
            span = high["ergo"] - low["ergo"]
            for i in range(1, steps):
                if span <= 0:
                    break
                if time.perf_counter() >= deadline:
                    completed = False
                    break
                bound = low["ergo"] + span * i / steps
                if params.min_ergonomics is not None:
                    bound = max(bound, params.min_ergonomics)
                solve(axis, min_ergonomics=bound)
    if not low or not high:
        completed = completed and bool(attempts) and all(s == "infeasible" for s in attempts)
    frontier = frontier_points(points, tradeoff)
    return {
        "gun_id": weapon_id,
        "tradeoff": tradeoff,
        "steps": steps,
        "points": frontier,
        "complete": completed,
        "status": "complete" if completed and frontier else "infeasible" if completed else "partial",
        "solve_count": len(attempts),
        "processing_ms": round((time.perf_counter() - started) * 1000, 3),
    }
