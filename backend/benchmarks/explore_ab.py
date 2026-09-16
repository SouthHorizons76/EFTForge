"""Compare Explore cases on two backends and one SQLite snapshot.

Time the direct streaming generator, excluding imports, GC and validation.
Keep the production budget unless --budget-seconds explicitly overrides it.
"""

import argparse
from dataclasses import asdict, replace
import gc
import hashlib
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import time

DEFAULT_EXCLUSIONS = ["591c4e1186f77410354b316e", "5a7c74b3e899ef0014332c29"]
PHASE_METRICS = ("candidate_load_ms", "model_build_ms", "matrix_build_ms", "solver_ms", "processing_ms", "solve_count")


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def emit(value, stream=sys.stdout):
    stream.write(json.dumps(value, allow_nan=False) + "\n")
    stream.flush()


def case_definitions(args):
    if args.cases_json is None:
        return [
            {"id": weapon, "weapon": weapon, "steps": args.steps, "tradeoff": "price", "params": {}}
            for weapon in args.weapon or ("AK-101", "M4A1")
        ]
    cases = json.loads(args.cases_json.read_text())
    if not isinstance(cases, list) or not cases:
        raise ValueError("--cases-json must contain a nonempty array")
    json.dumps(cases, allow_nan=False)
    seen = set()
    for case in cases:
        if not isinstance(case, dict) or set(case) != {"id", "weapon", "steps", "tradeoff", "params"}:
            raise ValueError("Each case requires exactly id, weapon, steps, tradeoff and params")
        if not isinstance(case["id"], str) or not case["id"] or case["id"] in seen:
            raise ValueError("Case IDs must be unique nonempty strings")
        seen.add(case["id"])
        if not isinstance(case["weapon"], str) or not case["weapon"]:
            raise ValueError(f"{case['id']}: weapon must be a nonempty string")
        if type(case["steps"]) is not int or not 10 <= case["steps"] <= 81:
            raise ValueError(f"{case['id']}: steps must be an integer in [10, 81]")
        if case["tradeoff"] not in ("price", "recoil", "ergo") or not isinstance(case["params"], dict):
            raise ValueError(f"{case['id']}: invalid tradeoff or params")
    return cases


def sweep_bound(event, low, high, steps, params):
    """Recover the unrounded bound on the axis named by the progress event."""
    stat = event.get("bound_stat")
    if event["phase"] != "sweep" or low is None or high is None or stat not in ("ergo", "eed", "recoil_v"):
        return None

    def coordinate(point):
        metric = {"ergo": "local_price_before_display_ergo", "recoil_v": "local_price_before_display_recoil_v"}.get(
            stat
        )
        value = point["build"].get("metrics", {}).get(metric, point[stat])
        return min(100, value) if stat == "ergo" else value

    bound = coordinate(low) + (coordinate(high) - coordinate(low)) * (event["done"] - 2) / steps
    if stat == "ergo" and params.min_ergonomics is not None:
        bound = max(bound, params.min_ergonomics)
    elif stat == "recoil_v" and params.max_recoil_v is not None:
        bound = min(bound, params.max_recoil_v)
    return bound


def linear_objective(axis, values, max_price):
    if axis == "price":
        return values["attachment_price_rub"]
    if axis == "ergo":
        primary = -values["capped_ergo"]
    elif axis == "recoil":
        primary = values["raw_recoil_modifier"]
    else:
        return None
    return primary + 1e-6 / max_price * values["attachment_price_rub"]


def worker(args):
    # Reserve the original pipe for JSON before importing native libraries.
    # HiGHS can write directly to fd 1 even when solver output is disabled.
    sys.stdout.flush()
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.path.insert(0, str(args.backend.resolve()))
    import numpy
    import scipy
    import sqlalchemy
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from models_items import Item
    from optimizer import explore, milp, solver
    from stats import _compute_stats, apply_full_mag_ammo, full_mag_ammo_weight

    engine = create_engine(f"sqlite:///file:{args.database.resolve()}?mode=ro&uri=true")
    native_budget = explore.EXPLORE_TIME_LIMIT_SECONDS
    if args.budget_seconds is not None:
        explore.EXPLORE_TIME_LIMIT_SECONDS = args.budget_seconds
    setup = json.loads(sys.stdin.readline())
    cases = {}
    with Session(engine) as db:
        defaults = {}
        if setup["legacy_defaults"]:
            ammo_id = db.query(Item).filter(Item.name == "5.56x45mm M856A1", Item.is_ammo == True).one().id
            defaults = {"selected_ammo_id": ammo_id, "assume_full_mag": True, "exclude_items": setup["exclude_items"]}
        for case in setup["cases"]:
            selector = case["weapon"]
            query = db.query(Item).filter(Item.is_weapon == True)
            weapon = None
            for condition in (
                Item.id == selector,
                Item.name == selector,
                Item.short_name == selector,
                Item.name.contains(selector),
            ):
                matches = query.filter(condition).all()
                if len(matches) > 1:
                    raise ValueError(f"{case['id']}: ambiguous weapon {selector!r}; use its exact name or ID")
                if matches:
                    weapon = matches[0]
                    break
            if weapon is None:
                raise ValueError(f"{case['id']}: unknown weapon {selector!r}")
            params = solver.OptimizeParams(**{**defaults, **case["params"]})
            cases[case["id"]] = {**case, "weapon_id": weapon.id, "weapon_name": weapon.name, "params": asdict(params)}
    emit(
        {
            "python": sys.version,
            "numpy": numpy.__version__,
            "scipy": scipy.__version__,
            "sqlalchemy": sqlalchemy.__version__,
            "weapons": {case["weapon"]: case["weapon_id"] for case in cases.values()},
            "cases": list(cases.values()),
            "native_budget_seconds": native_budget,
            "effective_budget_seconds": explore.EXPLORE_TIME_LIMIT_SECONDS,
            "nonproduction_budget": explore.EXPLORE_TIME_LIMIT_SECONDS != native_budget,
            "source_hashes": {
                name: sha256(args.backend / name)
                for name in (
                    "optimizer/explore.py",
                    "optimizer/solver.py",
                    "optimizer/milp.py",
                    "optimizer/local_price.py",
                    "stats.py",
                )
                if (args.backend / name).is_file()
            },
        },
        stream=protocol,
    )

    # Keep only the latest identical candidate input, rather than retaining a
    # complete candidate graph for every baseline call. Inspect it after timing.
    state = {}
    load_candidates = solver._load_candidates_and_prices
    optimize = explore.optimize_weapon

    def capture_inputs(*positional, **keywords):
        started = time.perf_counter()
        inputs = load_candidates(*positional, **keywords)
        state["input_load_ms"] += (time.perf_counter() - started) * 1000
        state["input_load_count"] += 1
        state["inputs"] = inputs
        return inputs

    def capture_solve(db, weapon_id, params, **keywords):
        result = optimize(db, weapon_id, params, **keywords)
        state["attempts"].append((keywords.get("objective_axis"), params, result))
        return result

    solver._load_candidates_and_prices = capture_inputs
    explore.optimize_weapon = capture_solve
    for line in sys.stdin:
        request = json.loads(line)
        case = cases[request["case_id"]]
        params = solver.OptimizeParams(**case["params"])
        state.clear()
        state.update(attempts=[], input_load_ms=0, input_load_count=0)
        gc.collect()
        with Session(engine) as db:
            events = []
            started = time.perf_counter()
            cpu_started = time.process_time()
            first_point_ms = None
            for event in explore.explore_weapon_stream(db, case["weapon_id"], params, case["tradeoff"], case["steps"]):
                events.append(event)
                if first_point_ms is None and event["type"] == "progress" and event.get("point"):
                    first_point_ms = (time.perf_counter() - started) * 1000
            wall_ms = (time.perf_counter() - started) * 1000
            cpu_ms = (time.process_time() - cpu_started) * 1000
            result = events[-1]["data"]
            weapon, compat, mods, (candidate_ids, prices) = state["inputs"]
            ammo = db.get(Item, params.selected_ammo_id) if params.assume_full_mag and params.selected_ammo_id else None
            ubgl_ammo = (
                db.get(Item, params.selected_ubgl_ammo_id)
                if params.assume_full_mag and params.selected_ubgl_ammo_id
                else None
            )
            max_price = max((prices[i]["price_rub"] for i in candidate_ids), default=0) or 1
            checked = {}

            def inspect_build(build, axis, call_params):
                selected = build.get("selected_items", [])
                if build["status"] not in ("optimal", "feasible"):
                    return {
                        "status": build["status"],
                        "selected_items": selected,
                        "termination": build.get("termination", {}),
                    }
                if id(build) not in checked:
                    raw_ergo = (weapon.base_ergonomics or 0) + sum(mods[i].ergonomics_modifier or 0 for i in selected)
                    recoil_modifier = sum(mods[i].recoil_modifier or 0 for i in selected)
                    price = sum(prices[i]["price_rub"] for i in selected)
                    raw_weight = (weapon.weight or 0) + sum(
                        (mods[i].weight or 0) + full_mag_ammo_weight(mods[i], ammo, ubgl_ammo) for i in selected
                    )
                    expected = _compute_stats(weapon, selected, mods, params.strength_level, params.equip_ergo_modifier)
                    apply_full_mag_ammo(
                        expected,
                        {i: mods[i] for i in selected},
                        ammo,
                        ubgl_ammo,
                        params.strength_level,
                        params.equip_ergo_modifier,
                    )
                    checked[id(build)] = {
                        "status": build["status"],
                        "termination": build.get("termination", {}),
                        "selected_items": sorted(selected),
                        "slot_pairs": build.get("slot_pairs", []),
                        "raw_ergo": raw_ergo,
                        "capped_ergo": min(100, raw_ergo),
                        "raw_recoil_modifier": recoil_modifier,
                        "raw_recoil_v": (
                            None if weapon.recoil_vertical is None else weapon.recoil_vertical * (1 + recoil_modifier)
                        ),
                        "raw_recoil_sum": (
                            None
                            if weapon.recoil_vertical is None or weapon.recoil_horizontal is None
                            else (weapon.recoil_vertical + weapon.recoil_horizontal) * (1 + recoil_modifier)
                        ),
                        "raw_loaded_weight": raw_weight,
                        "attachment_price_rub": price,
                        "final_stats": build["final_stats"],
                        "grand_total_rub": build["grand_total_rub"],
                        "base": build.get("base"),
                        "price_matches_selected_offers": build.get("item_prices") == {i: prices[i] for i in selected},
                        "stats_match_builder": expected == build["final_stats"],
                    }
                out = dict(checked[id(build)])
                out["objective_axis"] = axis
                out["minimization_objective"] = linear_objective(axis, out, max_price)
                out["objective_kind"] = "linear_axis"
                if axis is None and call_params.use_evo_ergo:
                    # Report the true score used to select between EvoErgo
                    # anchors, separately from each tangent's MILP dual bound.
                    out["objective_kind"] = "evo_true_selection_score"
                    out["minimization_objective"] = (
                        -max(call_params.ergo_weight, milp.WEIGHT_FLOOR)
                        * milp.ERGO_OBJ_COEFF
                        * out["final_stats"]["evo_ergo_delta"]
                        + max(call_params.recoil_weight, milp.WEIGHT_FLOOR)
                        * milp.RECOIL_OBJ_COEFF
                        * out["raw_recoil_modifier"]
                        + max(call_params.price_weight, milp.WEIGHT_FLOOR)
                        * milp.PRICE_OBJ_COEFF
                        * out["attachment_price_rub"]
                    )
                out["objective_matches_mip_dual_bound"] = axis is not None
                checks = {
                    "stats_match_builder": out["stats_match_builder"],
                    "price_matches_selected_offers": out["price_matches_selected_offers"],
                }
                for name, actual, lower in (
                    ("min_ergonomics", out["raw_ergo"], True),
                    ("max_ergonomics", out["raw_ergo"], False),
                    ("max_recoil_v", out["raw_recoil_v"], False),
                    ("max_recoil_sum", out["raw_recoil_sum"], False),
                    ("max_price", out["attachment_price_rub"], False),
                    ("max_weight", out["raw_loaded_weight"], False),
                    ("min_eed", out["final_stats"]["evo_ergo_delta"], True),
                ):
                    bound = getattr(call_params, name)
                    if bound is not None and actual is not None:
                        checks[name] = actual + 1e-7 >= bound if lower else actual <= bound + 1e-7
                if call_params.min_mag_capacity:
                    checks["min_mag_capacity"] = (
                        max((mods[i].magazine_capacity or 0 for i in selected), default=0)
                        >= call_params.min_mag_capacity
                    )
                if call_params.min_sighting_range:
                    checks["min_sighting_range"] = (
                        max([weapon.sighting_range or 0] + [mods[i].sighting_range or 0 for i in selected])
                        >= call_params.min_sighting_range
                    )
                if call_params.prevent_overswing:
                    checks["prevent_overswing"] = not out["final_stats"]["overswing"]
                if call_params.require_suppressor:
                    checks["require_suppressor"] = any(
                        milp.SUPPRESSOR_CATEGORY_ID in (mods[i].category_ids or "").split(",") for i in selected
                    )
                checks["include_items"] = set(call_params.include_items or ()) <= set(selected)
                checks["exclude_items"] = not set(call_params.exclude_items or ()) & set(selected)
                selected_categories = set().union(*[(mods[i].category_ids or "").split(",") for i in selected])
                checks["include_categories"] = all(
                    selected_categories.intersection(group) for group in call_params.include_categories or ()
                )
                checks["exclude_categories"] = not selected_categories.intersection(
                    call_params.exclude_categories or ()
                )
                if call_params.max_moa is not None:
                    # Inspect the displayed value here; audit the unrounded model separately.
                    checks["max_moa_display"] = out["final_stats"]["accuracy_moa"] <= round(call_params.max_moa, 2)
                out["checks"] = checks
                out["min_ergonomics"] = call_params.min_ergonomics
                out["ergo_floor_satisfied"] = checks.get("min_ergonomics", True)
                return out

            attempts = [
                {
                    "axis": axis,
                    "params": asdict(call_params),
                    "metrics": build.get("metrics", {}),
                    "termination": build.get("termination", {}),
                    **inspect_build(build, axis, call_params),
                }
                for axis, call_params, build in state["attempts"]
            ]
            progress = []
            low = high = None
            origins = {id(build): (axis, call_params) for axis, call_params, build in state["attempts"]}
            for event in events:
                if event["type"] != "progress":
                    continue
                point = event.get("point")
                if event["phase"] == "boundary_low":
                    low = point
                elif event["phase"] == "boundary_high":
                    high = point
                bound = sweep_bound(event, low, high, case["steps"], params)
                inspected = None
                if point:
                    axis, call_params = origins[id(point["build"])]
                    if bound is not None:
                        bound_param = {"ergo": "min_ergonomics", "eed": "min_eed", "recoil_v": "max_recoil_v"}[
                            event["bound_stat"]
                        ]
                        call_params = replace(call_params, **{bound_param: bound})
                    inspected = inspect_build(point["build"], axis, call_params)
                progress.append(
                    {
                        **{key: value for key, value in event.items() if key != "point"},
                        "exact_bound_value": bound,
                        "exact_sweep_floor": bound if event.get("bound_stat") == "ergo" else None,
                        "point": inspected,
                    }
                )
            metrics_sum = {key: sum(attempt["metrics"].get(key, 0) for attempt in attempts) for key in PHASE_METRICS}
            metrics_sum.update(input_load_ms=state["input_load_ms"], input_load_count=state["input_load_count"])
            emit(
                {
                    "wall_ms": wall_ms,
                    "case_id": case["id"],
                    "weapon": case["weapon"],
                    "weapon_id": case["weapon_id"],
                    "weapon_name": case["weapon_name"],
                    "steps": case["steps"],
                    "tradeoff": case["tradeoff"],
                    "params": asdict(params),
                    "cpu_ms": cpu_ms,
                    "first_point_ms": first_point_ms,
                    **{key: result[key] for key in ("processing_ms", "complete", "status", "solve_count")},
                    "reused_count": result.get("reused_count", 0),
                    "prepare_ms": result.get("prepare_ms", 0),
                    "point_count": len(result["points"]),
                    "points": [
                        inspect_build(point["build"], *origins[id(point["build"])]) for point in result["points"]
                    ],
                    "candidate_shape": {
                        "reachable_count": len(compat.reachable_ids),
                        "candidate_count": len(candidate_ids),
                        "slot_count": len(compat.slot_items),
                        "edge_count": sum(len(ids) for ids in compat.slot_items.values()),
                        **compat.pruning_metrics,
                    },
                    "metrics_sum": metrics_sum,
                    "attempts": attempts,
                    "progress": progress,
                },
                stream=protocol,
            )


def controller(args):
    cases = case_definitions(args)
    args.output.mkdir(parents=True, exist_ok=False)
    env = {
        **os.environ,
        "PYTHONHASHSEED": str(args.hash_seed),
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
        "IP_HASH_SECRET": "explore-benchmark-only",
        "ADMIN_API_KEY": "explore-benchmark-only",
        "DISABLE_BG_MIGRATE": "1",
        "DATABASE_URL": f"sqlite:///file:{args.database.resolve()}?mode=ro&uri=true",
    }
    metadata = {
        "mode": "direct_explore_stream_with_in_memory_call_instrumentation",
        "database_sha256": sha256(args.database),
        "cases": cases,
        "cases_file_sha256": sha256(args.cases_json) if args.cases_json else None,
        "steps": args.steps,
        "tradeoff": "price",
        "exclude_items": args.exclude_item if args.exclude_item is not None else DEFAULT_EXCLUSIONS,
        "runs": args.runs,
        "warmup_pairs": args.warmups,
        "budget_override_seconds": args.budget_seconds,
        "platform": platform.platform(),
        "cpu_count": os.cpu_count(),
        "cpu_affinity": sorted(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else None,
        "thread_env": {
            key: env[key] for key in ("PYTHONHASHSEED", "OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS")
        },
    }
    processes, logs, records = {}, [], []
    try:
        for name, backend in (("baseline", args.baseline), ("candidate", args.candidate)):
            log = (args.output / f"{name}.stderr.log").open("w")
            logs.append(log)
            command = [
                sys.executable,
                str(Path(__file__).resolve()),
                "--worker",
                "--backend",
                str(backend.resolve()),
                "--database",
                str(args.database.resolve()),
                "--steps",
                str(args.steps),
            ]
            if args.budget_seconds is not None:
                command.extend(["--budget-seconds", str(args.budget_seconds)])
            processes[name] = subprocess.Popen(
                command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, env=env
            )
            emit(
                {
                    "cases": cases,
                    "legacy_defaults": args.cases_json is None,
                    "exclude_items": metadata["exclude_items"],
                },
                processes[name].stdin,
            )
            line = processes[name].stdout.readline()
            if not line:
                raise RuntimeError(f"{name} worker failed to start; see its stderr log")
            metadata[name] = json.loads(line)
        assert metadata["baseline"]["weapons"] == metadata["candidate"]["weapons"]
        assert metadata["baseline"]["cases"] == metadata["candidate"]["cases"]
        assert metadata["baseline"]["effective_budget_seconds"] == metadata["candidate"]["effective_budget_seconds"]
        (args.output / "metadata.json").write_text(json.dumps(metadata, indent=2))
        with (args.output / "samples.jsonl").open("w") as stream:
            for round_id in range(args.warmups + args.runs):
                for case_index, case in enumerate(cases):
                    order = ("baseline", "candidate") if (round_id + case_index) % 2 == 0 else ("candidate", "baseline")
                    for revision in order:
                        process = processes[revision]
                        emit({"case_id": case["id"]}, process.stdin)
                        line = process.stdout.readline()
                        if not line:
                            raise RuntimeError(f"{revision} worker stopped; see its stderr log")
                        row = {
                            "round": round_id,
                            "phase": "warmup" if round_id < args.warmups else "measured",
                            "case_id": case["id"],
                            "weapon": case["weapon"],
                            "revision": revision,
                            **json.loads(line),
                        }
                        records.append(row)
                        emit(row, stream)
                        emit(
                            {
                                key: row[key]
                                for key in (
                                    "round",
                                    "phase",
                                    "case_id",
                                    "weapon",
                                    "revision",
                                    "processing_ms",
                                    "complete",
                                    "solve_count",
                                    "reused_count",
                                    "point_count",
                                )
                            }
                        )
        if sha256(args.database) != metadata["database_sha256"]:
            raise RuntimeError("Database changed during the comparison; discard these measurements")
        summary = {}
        for case in cases:
            summary[case["id"]] = {}
            for revision in processes:
                rows = [
                    r
                    for r in records
                    if r["case_id"] == case["id"] and r["revision"] == revision and r["phase"] == "measured"
                ]
                summary[case["id"]][revision] = {
                    "n": len(rows),
                    "complete_runs": sum(r["complete"] for r in rows),
                    "processing_ms_median": statistics.median(r["processing_ms"] for r in rows),
                    "processing_ms_range": [
                        min(r["processing_ms"] for r in rows),
                        max(r["processing_ms"] for r in rows),
                    ],
                    "metrics_sum_median": {
                        key: statistics.median(r["metrics_sum"][key] for r in rows) for key in rows[0]["metrics_sum"]
                    },
                    "invalid_build_checks": sum(
                        not all(check.get("checks", {}).values())
                        for r in rows
                        for check in r["attempts"] + [p["point"] for p in r["progress"] if p["point"]]
                    ),
                }
        (args.output / "summary.json").write_text(json.dumps(summary, indent=2))
    finally:
        for process in processes.values():
            if process.poll() is None:
                process.stdin.close()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        for log in logs:
            log.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--backend", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument(
        "--database", type=Path, required=True, help="Frozen, checkpointed SQLite snapshot; opened read-only"
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument(
        "--hash-seed", type=int, default=0, help="Identical PYTHONHASHSEED for both workers (default: 0)"
    )
    parser.add_argument("--cases-json", type=Path, help="JSON case array with id, weapon, steps, tradeoff and params")
    parser.add_argument("--warmups", type=int, default=0)
    parser.add_argument("--steps", type=int, choices=range(10, 82), default=81, metavar="10..81")
    parser.add_argument("--weapon", action="append", choices=("AK-101", "M4A1"))
    parser.add_argument(
        "--exclude-item", action="append", help="Replace the two UI default exclusions; repeat for each ID"
    )
    parser.add_argument(
        "--budget-seconds", type=float, help="Explicitly override BOTH budgets, e.g. 120 for a completeness comparison"
    )
    args = parser.parse_args()
    if args.budget_seconds is not None and not 0 < args.budget_seconds <= 600:
        parser.error("--budget-seconds must be finite and in (0, 600]")
    if not 0 <= args.hash_seed <= 4294967295:
        parser.error("--hash-seed must be in [0, 4294967295]")
    if args.worker:
        worker(args)
    else:
        if not args.baseline or not args.candidate or not args.output or args.runs < 1 or args.warmups < 0:
            parser.error("--baseline, --candidate, --output, --runs >= 1 and --warmups >= 0 are required")
        if not args.database.is_file():
            parser.error("--database must exist")
        if args.cases_json is not None:
            if args.weapon or args.exclude_item:
                parser.error(
                    "--weapon and --exclude-item cannot be combined with --cases-json; set each case explicitly"
                )
            try:
                case_definitions(args)
            except (OSError, ValueError) as exc:
                parser.error(str(exc))
        wal = Path(str(args.database) + "-wal")
        if wal.exists() and wal.stat().st_size:
            parser.error("Use a frozen checkpointed snapshot without a nonempty WAL file")
        controller(args)
