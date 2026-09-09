"""Alternate two persistent workers against one read-only M4A1 DB snapshot.

The timed region includes candidate loading, solving and final stats. It bypasses
the HTTP result cache. Worker imports, GC and validation are outside that region.
"""

import argparse
from collections import deque
import gc
import hashlib
import json
import os
from pathlib import Path
import platform
import random
import statistics
import subprocess
import sys
import time

WEAPON = "5447a9cd4bdc2dbd208b4567"
AMMO = "54527a984bdc2d4e668b4567"  # M855, 0.012 kg
CASES = {
    "weighted_empty": {"use_tchebycheff": False, "assume_full_mag": False},
    "weighted_loaded": {"use_tchebycheff": False},
    "default_empty": {"assume_full_mag": False},
    "default_loaded": {},
    "evo_empty": {"use_evo_ergo": True, "assume_full_mag": False},
    "evo_loaded": {"use_evo_ergo": True},
    "recoil_overswing_empty": {
        "ergo_weight": 0,
        "prevent_overswing": True,
        "assume_full_mag": False,
    },
    "recoil_overswing_loaded": {"ergo_weight": 0, "prevent_overswing": True},
    "evo_overswing_loaded": {"use_evo_ergo": True, "prevent_overswing": True},
    "evo_suppressed_overswing": {
        "use_evo_ergo": True,
        "ergo_weight": 0,
        "prevent_overswing": True,
        "require_suppressor": True,
    },
    "default_weight_limit": {"max_weight": 4.0, "ergo_weight": 0},
    "evo_weight_limit": {"max_weight": 4.0, "use_evo_ergo": True},
}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def graph_metrics(cmap):
    placements = {}
    for sid, ids in cmap.slot_items.items():
        for iid in ids:
            placements.setdefault(iid, set()).add(sid)
    depth = {WEAPON: 0}
    queue = deque([WEAPON])
    while queue:
        owner = queue.popleft()
        for sid in cmap.item_to_slots.get(owner, []):
            for iid in cmap.slot_items[sid]:
                if iid not in depth:
                    depth[iid] = depth[owner] + 1
                    queue.append(iid)
    return {
        "reachable": len(cmap.reachable_ids),
        "multi_parent": sum(len(slots) > 1 for slots in placements.values()),
        "slots": len(cmap.slot_items),
        "edges": sum(len(ids) for ids in cmap.slot_items.values()),
        "max_shortest_depth": max(depth.values()),
    }


def worker(args):
    started = time.perf_counter()
    sys.path.insert(0, str(args.backend.resolve()))
    import scipy
    import sqlalchemy
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from models_items import Item
    from optimizer.compat_map import build_compatibility_map
    from optimizer.solver import OptimizeParams, optimize_weapon
    from stats import _compute_stats, apply_full_mag_ammo

    engine = create_engine(f"sqlite:///file:{args.database.resolve()}?mode=ro&uri=true")
    with Session(engine) as db:
        graph = graph_metrics(build_compatibility_map(db, WEAPON))
    assert graph["reachable"] >= 500 and graph["multi_parent"] >= 400
    source_hashes = {
        name: hashlib.sha256((args.backend / name).read_bytes()).hexdigest()
        for name in ("optimizer/milp.py", "optimizer/solver.py", "stats.py")
    }
    print(
        json.dumps(
            {
                "python": sys.version,
                "scipy": scipy.__version__,
                "sqlalchemy": sqlalchemy.__version__,
                "graph": graph,
                "source_hashes": source_hashes,
                "startup_ms": (time.perf_counter() - started) * 1000,
            }
        ),
        flush=True,
    )
    for line in sys.stdin:
        request = json.loads(line)
        params = OptimizeParams(**request["params"])
        gc.collect()
        with Session(engine) as db:
            cpu = time.process_time()
            started = time.perf_counter()
            result = optimize_weapon(db, WEAPON, params)
            wall_ms = (time.perf_counter() - started) * 1000
            cpu_ms = (time.process_time() - cpu) * 1000
            checks = {}
            selected = result.get("selected_items", [])
            if result["status"] in ("optimal", "feasible"):
                mods = {iid: db.get(Item, iid) for iid in selected}
                expected = _compute_stats(
                    db.get(Item, WEAPON), selected, mods, params.strength_level, params.equip_ergo_modifier
                )
                ammo = db.get(Item, params.selected_ammo_id) if params.assume_full_mag else None
                apply_full_mag_ammo(expected, mods, ammo, None, params.strength_level, params.equip_ergo_modifier)
                checks = {
                    "stats_match_builder": expected == result["final_stats"],
                    "overswing_constraint": not params.prevent_overswing or not expected["overswing"],
                    "weight_constraint": params.max_weight is None or expected["total_weight"] <= params.max_weight,
                    "magazine_constraint": max((m.magazine_capacity or 0) for m in mods.values())
                    >= params.min_mag_capacity,
                }
        stable = {k: result.get(k) for k in ("status", "final_stats", "total_price_rub", "ammo_fill")}
        stable["selected_items"] = sorted(selected)
        print(
            json.dumps(
                {
                    "wall_ms": wall_ms,
                    "cpu_ms": cpu_ms,
                    "status": result["status"],
                    "metrics": result.get("metrics", {}),
                    "final_stats": result.get("final_stats"),
                    "ammo_fill": result.get("ammo_fill"),
                    "selected_items": sorted(selected),
                    "digest": digest(stable),
                    "checks": checks,
                }
            ),
            flush=True,
        )


def summarize(records):
    out = {}
    for case in sorted({r["case"] for r in records}):
        out[case] = {}
        for revision in ("baseline", "candidate"):
            rows = [r for r in records if r["case"] == case and r["revision"] == revision and r["phase"] == "measured"]
            if not rows:
                continue
            values = [r["wall_ms"] for r in rows]
            out[case][revision] = {
                "n": len(rows),
                "median_ms": statistics.median(values),
                "min_ms": min(values),
                "max_ms": max(values),
                "median_cpu_ms": statistics.median(r["cpu_ms"] for r in rows),
                "metrics_median": {
                    k: statistics.median(r["metrics"].get(k, 0) for r in rows)
                    for k in ("candidate_load_ms", "model_build_ms", "matrix_build_ms", "solver_ms", "solve_count")
                },
                "statuses": sorted({r["status"] for r in rows}),
                "digests": sorted({r["digest"] for r in rows}),
                "invalid_results": sum(not all(r["checks"].values()) for r in rows),
                "last_stats": rows[-1]["final_stats"],
            }
    return out


def controller(args):
    args.output.mkdir(parents=True, exist_ok=False)
    selected = args.case or list(CASES)
    params = {
        name: {
            "selected_ammo_id": AMMO,
            "assume_full_mag": True,
            "min_mag_capacity": 60,
            "ergo_weight": 1,
            "recoil_weight": 1,
            "price_weight": 0,
            **CASES[name],
        }
        for name in selected
    }
    env = {
        **os.environ,
        "PYTHONHASHSEED": str(args.hash_seed),
        "IP_HASH_SECRET": "ammo-benchmark-only",
        "ADMIN_API_KEY": "ammo-benchmark-only",
        "DISABLE_BG_MIGRATE": "1",
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
    }
    processes, logs, metadata, records = {}, [], {}, []
    try:
        for name, backend in (("baseline", args.baseline), ("candidate", args.candidate)):
            log = (args.output / f"{name}.stderr.log").open("w")
            logs.append(log)
            processes[name] = subprocess.Popen(
                [
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "--worker",
                    "--backend",
                    str(backend.resolve()),
                    "--database",
                    str(args.database.resolve()),
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=log,
                text=True,
                env=env,
            )
            metadata[name] = json.loads(processes[name].stdout.readline())
        assert metadata["baseline"]["graph"] == metadata["candidate"]["graph"]
        metadata.update(
            {
                "database_sha256": hashlib.sha256(args.database.read_bytes()).hexdigest(),
                "cases": params,
                "runs": args.runs,
                "hash_seed": args.hash_seed,
                "platform": platform.platform(),
                "cpu_count": os.cpu_count(),
                "cpu_affinity": sorted(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else None,
                "thread_env": {k: env[k] for k in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS")},
            }
        )
        (args.output / "metadata.json").write_text(json.dumps(metadata, indent=2))
        with (args.output / "samples.jsonl").open("w") as stream:
            rng = random.Random(37)
            for round_id in range(args.runs + 1):
                order = selected.copy()
                rng.shuffle(order)
                for case_index, case in enumerate(order):
                    revisions = (
                        ["baseline", "candidate"] if (round_id + case_index) % 2 == 0 else ["candidate", "baseline"]
                    )
                    pair = {}
                    for revision in revisions:
                        proc = processes[revision]
                        proc.stdin.write(json.dumps({"params": params[case]}) + "\n")
                        proc.stdin.flush()
                        line = proc.stdout.readline()
                        if not line:
                            raise RuntimeError(f"{revision} worker stopped; see its stderr log")
                        row = {
                            "case": case,
                            "round": round_id,
                            "phase": "warmup" if round_id == 0 else "measured",
                            "revision": revision,
                            **json.loads(line),
                        }
                        records.append(row)
                        stream.write(json.dumps(row) + "\n")
                        stream.flush()
                        pair[revision] = round(row["wall_ms"], 1)
                    print(json.dumps({"round": round_id, "case": case, **pair}), flush=True)
        (args.output / "summary.json").write_text(json.dumps(summarize(records), indent=2))
    finally:
        for process in processes.values():
            if process.poll() is None:
                process.stdin.close()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    process.wait(timeout=5)
        for log in logs:
            log.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--backend", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--hash-seed", type=int, default=0)
    parser.add_argument("--case", action="append", choices=CASES)
    args = parser.parse_args()
    if args.worker:
        worker(args)
    else:
        if not args.baseline or not args.candidate or not args.output or args.runs < 1:
            parser.error("--baseline, --candidate, --output and --runs >= 1 are required")
        controller(args)
