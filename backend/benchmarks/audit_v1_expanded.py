"""Audit frozen Explore output against the full matrix without solving again."""

import argparse
from collections import Counter
from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import sys

TOL = 1e-7


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", type=Path, required=True)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--run", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.backend.resolve()))
    os.environ.setdefault("IP_HASH_SECRET", "local-benchmark")
    os.environ.setdefault("ADMIN_API_KEY", "local-benchmark")
    os.environ["DISABLE_BG_MIGRATE"] = "1"
    os.environ["DATABASE_URL"] = f"sqlite:///file:{args.database.resolve()}?mode=ro&uri=true"
    import numpy as np
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from models_items import Item
    from optimizer.milp import _SolveStats, _build_constraints, _Infeasible
    from optimizer.solver import OptimizeParams, prepare_optimize_weapon, _choose_base

    engine = create_engine(os.environ["DATABASE_URL"])
    report = {
        "database_sha256": digest(args.database),
        "model_source_sha256": digest(args.backend / "optimizer/milp.py"),
        "rows": [],
    }
    for run in args.run:
        meta = json.loads((run / "metadata.json").read_text())
        assert meta["database_sha256"] == report["database_sha256"]
        for line in (run / "samples.jsonl").read_text().splitlines():
            row = json.loads(line)
            if row.get("phase", "measured") != "measured":
                continue
            params = replace(OptimizeParams(**row["params"]), use_true_ergo=False, use_tchebycheff=False)
            record = dict(run=run.name, revision=row["revision"], case_id=row["case_id"], round=row["round"])
            with Session(engine) as db:
                prepared = prepare_optimize_weapon(db, row["weapon_id"], params)
                weapon, compat, mods, (candidate_ids, prices) = prepared.candidates
                # Check each selection once; the timed harness separately checks every
                # native and reused sample against its exact changing sweep bound.
                selections = {}
                all_points = row["attempts"] + row["points"] + [e["point"] for e in row["progress"] if e.get("point")]
                for point in all_points:
                    if point["status"] in ("optimal", "feasible"):
                        selections.setdefault(tuple(point["selected_items"]), point)
                ammo = (
                    db.get(Item, params.selected_ammo_id)
                    if params.assume_full_mag and params.selected_ammo_id
                    else None
                )
                ubgl = (
                    db.get(Item, params.selected_ubgl_ammo_id)
                    if params.assume_full_mag and params.selected_ubgl_ammo_id
                    else None
                )
                stats = _SolveStats(weapon, mods, params, ammo, ubgl)
                try:
                    ids, idx, cb, _, _, _, _, ergo_idx = _build_constraints(
                        weapon, mods, compat, candidate_ids, prices, params, stats
                    )
                    matrix = cb.build()
                except _Infeasible:
                    assert not selections, "Recorded a feasible result for a preflight-infeasible model"
                    record.update(selections=0, matrix_rows=None, hard_failures=[], placement_issues=[])
                    report["rows"].append(record)
                    continue
                hard_failures, placement_issues, unknown_prices, stat_order_differences = [], [], [], []
                for selected, point in selections.items():
                    tests = {}
                    missing = set(selected) - set(idx)
                    tests["candidate_membership"] = not missing
                    if missing:
                        hard_failures.append({"selected_items": selected, "missing_candidates": sorted(missing)})
                        continue
                    raw_ergo = (weapon.base_ergonomics or 0) + sum(mods[i].ergonomics_modifier or 0 for i in selected)
                    x = np.zeros(cb.n)
                    x[[idx[i] for i in selected]] = 1
                    x[ergo_idx] = min(100, raw_ergo)
                    lhs = matrix.A @ x
                    violation = np.maximum(np.maximum(matrix.lb - lhs, lhs - matrix.ub), 0)
                    tests["full_linear_matrix"] = bool(np.max(violation, initial=0) <= TOL and x[ergo_idx] >= 0)
                    attachment = sum(prices[i]["price_rub"] for i in selected)
                    unpriced = [i for i in selected if prices[i].get("no_price")]
                    if unpriced:
                        unknown_prices.append({"selected_items": selected, "unpriced_items": unpriced})
                    base, total = _choose_base(
                        db, weapon, params, list(selected), prices, attachment, prepared=prepared
                    )
                    tests["attachment_price"] = attachment == point["attachment_price_rub"]
                    tests["purchase_total"] = total == point["grand_total_rub"]
                    tests["purchase_base"] = base == point["base"]
                    tests["native_order_stats_match"] = point["stats_match_builder"]
                    reordered = stats.compute(list(selected))
                    if reordered != point["final_stats"]:
                        stat_order_differences.append(
                            {
                                "selected_items": selected,
                                "differences": {
                                    k: {"recorded": point["final_stats"][k], "sorted_recalculation": value}
                                    for k, value in reordered.items()
                                    if value != point["final_stats"][k]
                                },
                            }
                        )
                    if not all(tests.values()):
                        hard_failures.append(
                            {
                                "selected_items": selected,
                                "tests": tests,
                                "max_matrix_violation": float(np.max(violation, initial=0)),
                            }
                        )
                    # Keep actual placement separate from the existing relaxed item
                    # model, whose multi-parent required-slot gap is documented upstream.
                    reached, occupied, placed = {weapon.id}, set(), set()
                    issues = []
                    for slot, item in point["slot_pairs"]:
                        owner = compat.slot_owner.get(slot)
                        if owner not in reached:
                            issues.append(["parent_not_placed", slot, item])
                        if item not in compat.slot_items.get(slot, []):
                            issues.append(["invalid_slot", slot, item])
                        if slot in occupied or item in placed:
                            issues.append(["duplicate_placement", slot, item])
                        reached.add(item)
                        placed.add(item)
                        occupied.add(slot)
                    if placed != set(selected):
                        issues.append(["unplaced_items", sorted(set(selected) - placed)])
                    for slot, info in compat.slots_by_id.items():
                        if info.required and compat.slot_owner[slot] in reached and slot not in occupied:
                            issues.append(["empty_required_slot", slot, compat.slot_owner[slot]])
                    if issues:
                        placement_issues.append(
                            {
                                "selected_items": selected,
                                "issues": issues,
                                "final_point": any(p["selected_items"] == list(selected) for p in row["points"]),
                            }
                        )
                record.update(
                    selections=len(selections),
                    matrix_rows=len(matrix.lb),
                    hard_failures=hard_failures,
                    placement_issues=placement_issues,
                    unknown_prices=unknown_prices,
                    stat_order_differences=stat_order_differences,
                )
                report["rows"].append(record)
    report["totals"] = dict(
        rows=len(report["rows"]),
        selections=sum(r["selections"] for r in report["rows"]),
        hard_failures=sum(len(r["hard_failures"]) for r in report["rows"]),
        placement_issues=sum(len(r["placement_issues"]) for r in report["rows"]),
        stat_order_differences=sum(len(r.get("stat_order_differences", [])) for r in report["rows"]),
    )
    report["placement_issue_kinds"] = dict(
        Counter(issue[0] for r in report["rows"] for p in r["placement_issues"] for issue in p["issues"])
    )
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report["totals"]))


if __name__ == "__main__":
    main()
