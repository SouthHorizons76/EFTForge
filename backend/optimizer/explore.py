"""Sample two-objective tradeoffs using epsilon constraints and the native solver."""

import time
from dataclasses import replace

from optimizer.solver import OptimizeParams, optimize_weapon, prepare_optimize_weapon

EXPLORE_TIME_LIMIT_SECONDS = 30


def _diagnose_empty_explore(db, weapon_id, params, failures, deadline):
    # Preserve proven pre-check failures before spending time on extra solves.
    for failure in failures:
        if failure.get("reason_details") or failure.get("reason_key") not in (None, "optimizer.infeasible"):
            return {k: failure[k] for k in ("reason", "reason_details", "reason_key", "reason_params") if k in failure}

    limits = {
        name: None
        for name in (
            "max_price",
            "min_ergonomics",
            "max_ergonomics",
            "max_recoil_v",
            "max_recoil_sum",
            "max_weight",
            "min_mag_capacity",
            "min_sighting_range",
            "max_moa",
        )
        if getattr(params, name) is not None
    }
    if params.prevent_overswing:
        limits["prevent_overswing"] = False
    probes = [({name: value}, name) for name, value in limits.items()]
    if len(limits) > 1:
        probes.append((limits, "combinedStats"))
    diagnostic_solve_count = 0
    for overrides, label in probes:
        if time.perf_counter() >= deadline:
            break
        # Share the curve's deadline and only report a relaxation backed by a build.
        result = optimize_weapon(db, weapon_id, replace(params, **overrides), deadline=deadline, objective_axis="price")
        diagnostic_solve_count += 1
        if result["status"] in ("optimal", "feasible") and result.get("final_stats"):
            return {
                "reason_key": f"optimizer.reason.relax.{label}",
                "diagnostic_solve_count": diagnostic_solve_count,
            }
    return {
        "reason_key": "optimizer.reason.constraintsConflict",
        "diagnostic_solve_count": diagnostic_solve_count,
    }


# How many ergo points below the true achievable max to search for a
# materially better recoil/price trade at the sweep's ergo-max boundary.
# Tarkov mod stats are chunky, not continuous, so the single item combo that
# hits the exact top of the ergo axis can be a completely different (and far
# worse) pick than one just a point or two below it - without this, that
# boundary point is a pure ergo-maximize with zero regard for recoil/price
# (see solve()'s "ergo" axis branch), so the graph's edge can land on an
# abhorrent-recoil build purely because it happens to sit at the very top.
ERGO_BOUNDARY_LEEWAY_POINTS = 3
# Only give up an ergo point at that boundary if it buys at least this much
# relative improvement on the true tradeoff stat (recoil or price) - small
# enough to catch a real cliff, large enough that ergo isn't given away for
# noise-level gains.
ERGO_BOUNDARY_MIN_RELATIVE_GAIN = 0.03


class _ErgoFloorSolutions:
    """Reuse an optimum only while it remains feasible in a smaller feasible set."""

    def __init__(self, prepared):
        self.prepared = prepared
        self.entries = {}

    def get(self, axis, floor):
        floor = float("-inf") if floor is None else floor
        for old_floor, raw_ergo, result in self.entries.get(axis, []):
            # Keep the old objective and its dual bound: tightening a constraint
            # cannot improve the minimum. Use model coefficients, never rounded
            # display stats or the full-factory-preset stat substitution.
            if old_floor <= floor <= raw_ergo - 1e-7:
                return result
        return None

    def add(self, axis, floor, result):
        if result["status"] != "optimal" or not result.get("final_stats"):
            return
        weapon, mods = self.prepared.weapon, self.prepared.mods
        raw_ergo = (weapon.base_ergonomics or 0) + sum(
            mods[i].ergonomics_modifier or 0 for i in result["selected_items"]
        )
        # Keep v1's native-solve partition. An incidental ergo gain from a
        # cheaper replacement must not shift later floors or native searches.
        raw_ergo = min(raw_ergo, result.get("metrics", {}).get("local_price_before_ergo", raw_ergo))
        floor = float("-inf") if floor is None else floor
        self.entries.setdefault(axis, []).append((floor, raw_ergo, result))


def _sampling_value(point, key):
    metric = {"ergo": "local_price_before_display_ergo", "recoil_v": "local_price_before_display_recoil_v"}.get(key)
    value = point["build"].get("metrics", {}).get(metric, point[key])
    return min(100, value) if key == "ergo" else value


def frontier_points(points, tradeoff, use_evo_ergo=False):
    # Compare displayed stats and break coordinate ties on the omitted axis. Under
    # the EvoErgo toggle, the ergo axis itself is true EED (see explore_weapon_stream),
    # so the frontier has to be computed in EED terms too - a build the frontend
    # will show as ergo-dominant on the true-EED axis must win the dominance/tie
    # check here in those same terms, not raw ergo's.
    ergo_key = "eed" if use_evo_ergo else "ergo"
    x_key, y_key, tie_key = {
        "price": (ergo_key, "recoil_v", "price"),
        "recoil": (ergo_key, "price", "recoil_v"),
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


def explore_weapon_stream(db, weapon_id: str, params: OptimizeParams, tradeoff="price", steps=20):
    """Generator form of explore_weapon: yields a progress event after every sampled
    point (each one a real, already-solved build - not a simulated/estimated tick), then
    yields the final result event last. explore_weapon() below just drains this and
    returns that final event's data, so existing callers/tests are unaffected."""
    if tradeoff not in ("price", "recoil", "ergo") or not 10 <= steps <= 81:
        raise ValueError("Invalid Explore tradeoff or resolution")
    started = time.perf_counter()
    deadline = started + EXPLORE_TIME_LIMIT_SECONDS
    # Every regular sample below is a pure single-axis solve (see solve()'s
    # objective_axis branch) - EvoErgo's blended-objective anchor sweep has no
    # part in those and, worse, ignores objective_axis entirely, so leaving it on
    # would silently swap every sample over to solving the full ergo/recoil/price
    # blend instead of the epsilon-constrained axis this whole sweep depends on.
    # The one place EvoErgo actually changes anything is the "max ergo" boundary
    # point the price/recoil tradeoffs use to size their sweep - see solve()'s own
    # use_evo_ergo branch below, which is the only call that ever pays for it.
    use_evo_ergo = params.use_evo_ergo
    params = replace(params, use_evo_ergo=False, use_tchebycheff=False)
    prepared = prepare_optimize_weapon(db, weapon_id, params)
    prepared.local_price_cleanup = tradeoff == "price"
    solutions = _ErgoFloorSolutions(prepared)
    points, attempts, failures = [], [], []
    reused_count = 0
    completed = True
    done_calls = 0
    total_calls = steps + 1  # 2 boundary solves + (steps - 1) sweep solves

    def solve(axis, *, record=True, **overrides):
        nonlocal completed, reused_count
        if time.perf_counter() >= deadline:
            completed = False
            return None
        if axis == "ergo" and use_evo_ergo:
            # Same true-EED anchor sweep the old single-solve EvoErgo mode runs,
            # pinned to a pure ergo objective (recoil/price weight zeroed out) so
            # this boundary point reflects the real weight-adjusted EED best
            # instead of the raw ergonomics-sum best a plain axis solve finds.
            call_params = replace(
                params, use_evo_ergo=True, ergo_weight=1.0, recoil_weight=0.0, price_weight=0.0, **overrides
            )
            result = optimize_weapon(db, weapon_id, call_params, deadline=deadline, prepared=prepared)
            attempts.append(result["status"])
        else:
            call_params = replace(params, **overrides)
            # Only reuse plain linear problems. Keep the EED/overswing cutting
            # planes local to each solve, and never reuse across a relaxed bound.
            reusable = (
                not use_evo_ergo
                and not params.prevent_overswing
                and params.min_eed is None
                and set(overrides) <= {"min_ergonomics"}
            )
            result = solutions.get(axis, call_params.min_ergonomics) if reusable else None
            if result is None:
                result = optimize_weapon(
                    db, weapon_id, call_params, deadline=deadline, objective_axis=axis, prepared=prepared
                )
                attempts.append(result["status"])
                if reusable:
                    solutions.add(axis, call_params.min_ergonomics, result)
            else:
                reused_count += 1
        if result["status"] == "infeasible" and not overrides:
            failures.append(result)
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
            "eed": stats["evo_ergo_delta"],
            "recoil_v": stats["recoil_vertical"],
            "price": result["grand_total_rub"],
            "build": result,
        }
        if record:
            points.append(point)
        return point

    def ergo_boundary_point(axis):
        """Refine the sweep's ergo-max boundary point (see
        ERGO_BOUNDARY_LEEWAY_POINTS above for why the raw pure-ergo solve
        alone isn't good enough). First finds the true max achievable ergo,
        then re-solves on the real tradeoff axis at that max and at a few
        floors just below it, keeping the lowest-ergo candidate that still
        clears ERGO_BOUNDARY_MIN_RELATIVE_GAIN's bar over the current best.
        Every probe here is unrecorded - only the final pick is added to the
        graph, so the discarded high-ergo/bad-recoil probes never show up as
        their own points.
        """
        max_point = solve("ergo", record=False)
        if max_point is None:
            return None
        max_ergo = _sampling_value(max_point, "ergo")
        stat_key = "recoil_v" if axis == "recoil" else "price"
        best = solve(axis, min_ergonomics=max_ergo, record=False) or max_point
        # min_ergonomics is passed as a full override (dataclasses.replace), so it
        # would otherwise silently relax the caller's own explicit floor below what
        # they asked for - clamp to it, and stop once clamping leaves no room left.
        user_floor = params.min_ergonomics if params.min_ergonomics is not None else 0
        prev_floor = max_ergo
        for d in range(1, ERGO_BOUNDARY_LEEWAY_POINTS + 1):
            floor = max(max_ergo - d, user_floor)
            if floor <= 0 or floor >= prev_floor or time.perf_counter() >= deadline:
                break
            prev_floor = floor
            candidate = solve(axis, min_ergonomics=floor, record=False)
            if candidate is None or not _sampling_value(best, stat_key):
                continue
            best_value = _sampling_value(best, stat_key)
            gain = (best_value - _sampling_value(candidate, stat_key)) / best_value
            if gain >= ERGO_BOUNDARY_MIN_RELATIVE_GAIN * d:
                best = candidate
        return best

    def progress(phase, point, axis, bound_stat=None, bound_value=None):
        nonlocal done_calls
        done_calls += 1
        return {
            "type": "progress",
            "phase": phase,
            "axis": axis,
            "bound_stat": bound_stat,
            "bound_value": round(bound_value, 2) if bound_value is not None else None,
            "done": done_calls,
            "total": total_calls,
            "solve_count": len(attempts),
            "reused_count": reused_count,
            "point": point,
        }

    if tradeoff == "ergo":
        low = solve("recoil")
        yield progress("boundary_low", low, "recoil")
        high = solve("price")
        yield progress("boundary_high", high, "price")
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
                yield progress("sweep", solve("price", max_recoil_v=bound), "price", "recoil_v", bound)
    else:
        axis = "recoil" if tradeoff == "price" else "price"
        low = solve(axis)
        yield progress("boundary_low", low, axis)
        if use_evo_ergo:
            high = solve("ergo")
        else:
            high = ergo_boundary_point(axis)
            if high is not None:
                points.append(high)
        yield progress("boundary_high", high, "ergo")
        if low and high:
            # Under the EvoErgo toggle, the "ergo" endpoint above was chosen by true
            # EED, not raw ergo sum - so the sweep has to bound each intermediate
            # point by EED too (via min_eed's cutting-plane floor), or every point
            # in between would still be picked by the plain "at least this much raw
            # ergo" constraint and the toggle would only ever affect that one
            # endpoint, not the balanced/low-recoil builds people actually choose.
            # The user's own explicit min_ergonomics floor (if any) keeps applying
            # underneath this regardless - it's still part of `params`, forwarded
            # to every solve() call below same as always.
            if use_evo_ergo:
                span = high["eed"] - low["eed"]
            else:
                # Price cleanup may improve an endpoint's ergo. Sample the
                # original endpoints so v1 still solves the same problems.
                low_ergo = _sampling_value(low, "ergo")
                span = _sampling_value(high, "ergo") - low_ergo
            for i in range(1, steps):
                if span <= 0:
                    break
                if time.perf_counter() >= deadline:
                    completed = False
                    break
                if use_evo_ergo:
                    bound = low["eed"] + span * i / steps
                    yield progress("sweep", solve(axis, min_eed=bound), axis, "eed", bound)
                else:
                    bound = low_ergo + span * i / steps
                    if params.min_ergonomics is not None:
                        bound = max(bound, params.min_ergonomics)
                    yield progress("sweep", solve(axis, min_ergonomics=bound), axis, "ergo", bound)
    if not low or not high:
        completed = completed and bool(attempts) and all(s == "infeasible" for s in attempts)
    frontier = frontier_points(points, tradeoff, use_evo_ergo)
    diagnosis = {}
    if not frontier and failures:
        diagnosis = _diagnose_empty_explore(db, weapon_id, params, failures, deadline)
    yield {
        "type": "result",
        "data": {
            "gun_id": weapon_id,
            "tradeoff": tradeoff,
            "steps": steps,
            "points": frontier,
            "complete": completed,
            "status": "complete" if completed and frontier else "infeasible" if completed else "partial",
            "solve_count": len(attempts),
            "reused_count": reused_count,
            "prepare_ms": round(prepared.candidate_load_ms, 3),
            "processing_ms": round((time.perf_counter() - started) * 1000, 3),
            **diagnosis,
        },
    }


def explore_weapon(db, weapon_id: str, params: OptimizeParams, tradeoff="price", steps=20):
    for event in explore_weapon_stream(db, weapon_id, params, tradeoff, steps):
        if event["type"] == "result":
            return event["data"]
