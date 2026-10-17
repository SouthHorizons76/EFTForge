"""Sample two-objective tradeoffs using epsilon constraints and the native solver."""

import copy
import os
import threading
import time
from collections import namedtuple
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

from optimizer.solver import OptimizeParams, optimize_weapon, prepare_optimize_weapon

EXPLORE_TIME_LIMIT_SECONDS = 30
# HiGHS releases the GIL, so independent samples solve in parallel threads.
# Results are still consumed in sequential order, so this only changes speed.
EXPLORE_WORKERS = max(1, int(os.environ.get("EFTFORGE_EXPLORE_WORKERS") or min(os.cpu_count() or 1, 8)))

_POOL = None
_POOL_LOCK = threading.Lock()


def _solve_pool():
    # Share one pool for the life of the process. Starting new threads while
    # threads that ran HiGHS are exiting can deadlock on Windows, so never let
    # solver threads come and go between requests.
    global _POOL
    with _POOL_LOCK:
        if _POOL is None:
            _POOL = ThreadPoolExecutor(EXPLORE_WORKERS, thread_name_prefix="explore-solve")
        return _POOL


_Request = namedtuple("_Request", "axis record overrides params objective_axis reusable")


def _copy_cuts(cache):
    if cache is None:
        return None
    return {axis: {sig: dict(cuts) for sig, cuts in sigs.items()} for axis, sigs in cache.items()}


def _merge_cuts(shared, learned):
    for axis, sigs in learned.items():
        for sig, cuts in sigs.items():
            shared.setdefault(axis, {}).setdefault(sig, {}).update(cuts)


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


def frontier_points(points, tradeoff, use_true_ergo=False):
    # Compare displayed stats and break coordinate ties on the omitted axis. Under
    # the TrueErgo toggle, the ergo axis itself is TrueErgoDelta (see explore_weapon_stream),
    # so the frontier has to be computed in TrueErgo terms too - a build the frontend
    # will show as ergo-dominant on the TrueErgo axis must win the dominance/tie
    # check here in those same terms, not raw ergo's.
    ergo_key = "true_ergo_delta" if use_true_ergo else "ergo"
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
    # objective_axis branch) - TrueErgo's blended-objective anchor sweep has no
    # part in those and, worse, ignores objective_axis entirely, so leaving it on
    # would silently swap every sample over to solving the full ergo/recoil/price
    # blend instead of the epsilon-constrained axis this whole sweep depends on.
    # The one place TrueErgo actually changes anything is the "max ergo" boundary
    # point the price/recoil tradeoffs use to size their sweep - see solve()'s own
    # use_true_ergo branch below, which is the only call that ever pays for it.
    use_true_ergo = params.use_true_ergo
    # An unpriced part's cost is unknown, so a curve that plots price can't place a
    # build holding one. Keep them only on Ergonomics vs. Recoil, where price just
    # breaks ties (see OptimizeParams.allow_unpriced).
    params = replace(
        params,
        use_true_ergo=False,
        use_tchebycheff=False,
        allow_unpriced=params.allow_unpriced and tradeoff == "price",
    )
    prepared = prepare_optimize_weapon(db, weapon_id, params)
    prepared.local_price_cleanup = tradeoff == "price"
    warm = getattr(prepared, "warm", None)
    if warm is not None:
        warm(db, params)
    solutions = _ErgoFloorSolutions(prepared)
    points, attempts, failures = [], [], []
    reused_count = 0
    completed = True
    done_calls = 0
    total_calls = steps + 1  # 2 boundary solves + (steps - 1) sweep solves
    pool = _solve_pool() if EXPLORE_WORKERS > 1 else None

    def request(axis, *, record=True, **overrides):
        if axis == "ergo" and use_true_ergo:
            # Same TrueErgo anchor sweep the old single-solve TrueErgo mode runs,
            # pinned to a pure ergo objective (recoil/price weight zeroed out) so
            # this boundary point reflects the real weight-adjusted TrueErgo best
            # instead of the raw ergonomics-sum best a plain axis solve finds.
            call_params = replace(
                params, use_true_ergo=True, ergo_weight=1.0, recoil_weight=0.0, price_weight=0.0, **overrides
            )
            return _Request(axis, record, overrides, call_params, None, False)
        # Only reuse plain linear problems. Keep the TrueErgo/overswing cutting
        # planes local to each solve, and never reuse across a relaxed bound.
        reusable = (
            not use_true_ergo
            and not params.prevent_overswing
            and params.min_true_ergo_delta is None
            and set(overrides) <= {"min_ergonomics"}
        )
        return _Request(axis, record, overrides, replace(params, **overrides), axis, reusable)

    def native(req, cut_cache):
        if time.perf_counter() >= deadline:
            return None
        context = prepared
        if cut_cache is not None:
            # Give each parallel solve its own copy of the learned cuts so its
            # path never depends on how its siblings happen to be scheduled.
            context = copy.copy(prepared)
            context.placement_cut_cache = cut_cache
        options = {"deadline": deadline, "prepared": context}
        if req.objective_axis is not None:
            options["objective_axis"] = req.objective_axis
        return optimize_weapon(db, weapon_id, req.params, **options), cut_cache

    def finish(req, result):
        nonlocal completed
        if result["status"] == "infeasible" and not req.overrides:
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
            "true_ergo_delta": stats["true_ergo_delta"],
            "recoil_v": stats["recoil_vertical"],
            "price": result["grand_total_rub"],
            "build": result,
        }
        if req.record:
            points.append(point)
        return point

    def solve_in_order(requests):
        """Yield each request's point in order, exactly as solving them one at a
        time would, while up to EXPLORE_WORKERS native solves run ahead. A
        request an earlier optimum already answers is reused, never solved."""
        nonlocal completed, reused_count
        snapshot = _copy_cuts(getattr(prepared, "placement_cut_cache", None)) if pool is not None else None
        running = {}

        def covered(req):
            return req.reusable and solutions.get(req.axis, req.params.min_ergonomics) is not None

        def run_ahead(start):
            for k in range(start, len(requests)):
                if sum(not future.done() for future in running.values()) >= EXPLORE_WORKERS:
                    return
                if k not in running and not covered(requests[k]):
                    running[k] = pool.submit(native, requests[k], _copy_cuts(snapshot))

        try:
            for i, req in enumerate(requests):
                if pool is not None:
                    run_ahead(i)
                future = running.pop(i, None)
                if time.perf_counter() >= deadline:
                    completed = False
                    yield None
                    continue
                result = solutions.get(req.axis, req.params.min_ergonomics) if req.reusable else None
                if result is not None:
                    reused_count += 1
                    if future is not None:
                        future.cancel()
                    yield finish(req, result)
                    continue
                if future is not None:
                    solved = future.result()
                else:
                    solved = native(req, _copy_cuts(snapshot))
                if solved is None:
                    completed = False
                    yield None
                    continue
                result, cut_cache = solved
                if cut_cache is not None:
                    _merge_cuts(prepared.placement_cut_cache, cut_cache)
                attempts.append(result["status"])
                if req.reusable:
                    solutions.add(req.axis, req.params.min_ergonomics, result)
                yield finish(req, result)
        finally:
            for future in running.values():
                future.cancel()

    def ergo_boundary_point(axis, max_point):
        """Refine the sweep's ergo-max boundary point (see
        ERGO_BOUNDARY_LEEWAY_POINTS above for why the raw pure-ergo solve
        alone isn't good enough). Starting from the true max achievable ergo,
        re-solve on the real tradeoff axis at that max and at a few floors just
        below it, keeping the lowest-ergo candidate that still clears
        ERGO_BOUNDARY_MIN_RELATIVE_GAIN's bar over the current best. Every
        probe here is unrecorded - only the final pick is added to the graph,
        so the discarded high-ergo/bad-recoil probes never show up as their
        own points.
        """
        if max_point is None:
            return None
        max_ergo = _sampling_value(max_point, "ergo")
        stat_key = "recoil_v" if axis == "recoil" else "price"
        # min_ergonomics is passed as a full override (dataclasses.replace), so it
        # would otherwise silently relax the caller's own explicit floor below what
        # they asked for - clamp to it, and stop once clamping leaves no room left.
        user_floor = params.min_ergonomics if params.min_ergonomics is not None else 0
        floors = [max_ergo]
        for d in range(1, ERGO_BOUNDARY_LEEWAY_POINTS + 1):
            floor = max(max_ergo - d, user_floor)
            if floor <= 0 or floor >= floors[-1]:
                break
            floors.append(floor)
        probes = solve_in_order([request(axis, min_ergonomics=floor, record=False) for floor in floors])
        try:
            best = next(probes) or max_point
            for d in range(1, len(floors)):
                if time.perf_counter() >= deadline:
                    break
                candidate = next(probes)
                if candidate is None or not _sampling_value(best, stat_key):
                    continue
                best_value = _sampling_value(best, stat_key)
                gain = (best_value - _sampling_value(candidate, stat_key)) / best_value
                if gain >= ERGO_BOUNDARY_MIN_RELATIVE_GAIN * d:
                    best = candidate
        finally:
            probes.close()
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

    def sweep(requests, axis, bound_stat, bounds):
        nonlocal completed
        results = solve_in_order(requests)
        try:
            for bound in bounds:
                if time.perf_counter() >= deadline:
                    completed = False
                    break
                yield progress("sweep", next(results), axis, bound_stat, bound)
        finally:
            results.close()

    # The low end of each curve is the build users chase most, and no sweep point
    # can land below it, so prove it is the true optimum when a tangent cut was
    # involved (see OptimizeParams.verify_ted_optimum).
    endpoint = {"verify_ted_optimum": True} if params.prevent_overswing else {}
    if tradeoff == "ergo":
        boundaries = solve_in_order([request("recoil", **endpoint), request("price", **endpoint)])
        try:
            low = next(boundaries)
            yield progress("boundary_low", low, "recoil")
            high = next(boundaries)
            yield progress("boundary_high", high, "price")
        finally:
            boundaries.close()
        if low and high:
            span = high["recoil_v"] - low["recoil_v"]
            bounds = []
            for i in range(1, steps if span > 0 else 1):
                bound = low["recoil_v"] + span * i / steps
                if params.max_recoil_v is not None:
                    bound = min(bound, params.max_recoil_v)
                bounds.append(bound)
            requests = [request("price", max_recoil_v=bound) for bound in bounds]
            yield from sweep(requests, "price", "recoil_v", bounds)
    else:
        axis = "recoil" if tradeoff == "price" else "price"
        # The low end and the max ergo solve do not depend on each other.
        boundaries = solve_in_order([request(axis, **endpoint), request("ergo", record=use_true_ergo)])
        try:
            low = next(boundaries)
            yield progress("boundary_low", low, axis)
            high = next(boundaries)
        finally:
            boundaries.close()
        if not use_true_ergo:
            high = ergo_boundary_point(axis, high)
            if high is not None:
                points.append(high)
        yield progress("boundary_high", high, "ergo")
        if low and high:
            # Under the TrueErgo toggle, the "ergo" endpoint above was chosen by
            # TrueErgo, not raw ergo sum - so the sweep has to bound each intermediate
            # point by TrueErgo too (via min_true_ergo_delta's cutting-plane floor), or every point
            # in between would still be picked by the plain "at least this much raw
            # ergo" constraint and the toggle would only ever affect that one
            # endpoint, not the balanced/low-recoil builds people actually choose.
            # The user's own explicit min_ergonomics floor (if any) keeps applying
            # underneath this regardless - it's still part of `params`, forwarded
            # to every request() below same as always.
            if use_true_ergo:
                span = high["true_ergo_delta"] - low["true_ergo_delta"]
                bounds = [low["true_ergo_delta"] + span * i / steps for i in range(1, steps if span > 0 else 1)]
                requests = [request(axis, min_true_ergo_delta=bound) for bound in bounds]
                yield from sweep(requests, axis, "true_ergo_delta", bounds)
            else:
                # Price cleanup may improve an endpoint's ergo. Sample the
                # original endpoints so v1 still solves the same problems.
                low_ergo = _sampling_value(low, "ergo")
                span = _sampling_value(high, "ergo") - low_ergo
                bounds = []
                for i in range(1, steps if span > 0 else 1):
                    bound = low_ergo + span * i / steps
                    if params.min_ergonomics is not None:
                        bound = max(bound, params.min_ergonomics)
                    bounds.append(bound)
                requests = [request(axis, min_ergonomics=bound) for bound in bounds]
                yield from sweep(requests, axis, "ergo", bounds)
    if not low or not high:
        completed = completed and bool(attempts) and all(s == "infeasible" for s in attempts)
    frontier = frontier_points(points, tradeoff, use_true_ergo)
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
