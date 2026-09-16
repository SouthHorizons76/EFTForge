"""Compare expanded paired runs using complete requests and exact raw coordinates."""

import argparse
from collections import Counter
import json
from pathlib import Path
import statistics


def coordinate_equal(a, b):
    return (
        abs(a["raw_ergo"] - b["raw_ergo"]) <= 1e-8
        and abs(a["raw_recoil_v"] - b["raw_recoil_v"]) <= 1e-8
        and a["final_stats"]["total_ergo"] == b["final_stats"]["total_ergo"]
        and a["final_stats"]["recoil_vertical"] == b["final_stats"]["recoil_vertical"]
    )


def compare(left, right):
    matches = []
    for a in left["points"]:
        equal = [b for b in right["points"] if coordinate_equal(a, b)]
        if not equal:
            continue
        b = min(equal, key=lambda p: p["grand_total_rub"])
        before, after = a["grand_total_rub"], b["grand_total_rub"]
        matches.append(
            dict(
                ergo=a["raw_ergo"],
                recoil_v=a["raw_recoil_v"],
                before=before,
                after=after,
                direction="lower" if after < before else "higher" if after > before else "equal",
            )
        )

    def trace(row):
        return [(p["axis"], p["params"]) for p in row["attempts"]]

    a, b = trace(left), trace(right)
    same_prefix = a[: min(len(a), len(b))] == b[: min(len(a), len(b))]
    uncovered = []
    for point in left["points"]:
        if not any(
            q["raw_ergo"] >= point["raw_ergo"] - 1e-8
            and q["raw_recoil_v"] <= point["raw_recoil_v"] + 1e-8
            and q["final_stats"]["total_ergo"] >= point["final_stats"]["total_ergo"]
            and q["final_stats"]["recoil_vertical"] <= point["final_stats"]["recoil_vertical"]
            and q["grand_total_rub"] <= point["grand_total_rub"]
            for q in right["points"]
        ):
            uncovered.append({k: point[k] for k in ("raw_ergo", "raw_recoil_v", "grand_total_rub")})
    return dict(
        matches=matches,
        match_counts=dict(Counter(p["direction"] for p in matches)),
        trace_equal=a == b,
        trace_common_prefix_equal=same_prefix,
        baseline_points=len(left["points"]),
        candidate_points=len(right["points"]),
        baseline_points_covered_in_3d=len(left["points"]) - len(uncovered),
        baseline_points_not_covered_in_3d=uncovered,
        complete_pair=left["complete"] and right["complete"],
        wall_ratio=right["wall_ms"] / left["wall_ms"],
        wall_delta_ms=right["wall_ms"] - left["wall_ms"],
    )


def audit(row):
    all_points = row["attempts"] + row["points"] + [p["point"] for p in row["progress"] if p.get("point")]
    issues = []
    for i, point in enumerate(all_points):
        bad = [k for k, v in point.get("checks", {}).items() if not v]
        if bad:
            issues.append(dict(index=i, failed=bad))
    cleaned = [p for p in row["attempts"] if "local_price_before_ergo" in p.get("metrics", {})]
    guard_failures = []
    for p in cleaned:
        m = p["metrics"]
        if (
            p["raw_ergo"] < m["local_price_before_ergo"] - 1e-7
            or p["raw_recoil_modifier"] > m["local_price_before_recoil_modifier"] + 1e-7
            or p["final_stats"]["total_ergo"] < m["local_price_before_display_ergo"]
            or p["final_stats"]["recoil_vertical"] > m["local_price_before_display_recoil_v"]
            or m["local_price_saved_rub"] < 0
        ):
            guard_failures.append(p)
    return dict(
        check_failures=issues,
        cleanup_guard_failures=guard_failures,
        cleanup_ms=sum(p["metrics"].get("local_price_ms", 0) for p in row["attempts"]),
        cleaned_attempts=len(cleaned),
        improved_attempts=sum(p["metrics"]["local_price_saved_rub"] > 0 for p in cleaned),
        native_milp_calls=row["metrics_sum"]["solve_count"],
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = {"runs": []}
    for run in args.run:
        meta = json.loads((run / "metadata.json").read_text())
        rows = [json.loads(x) for x in (run / "samples.jsonl").read_text().splitlines()]
        rows = [r for r in rows if r.get("phase", "measured") == "measured"]
        labels = list(dict.fromkeys(r["revision"] for r in rows))
        groups = {}
        for row in rows:
            groups.setdefault((row["case_id"], row["round"]), {})[row["revision"]] = row
        pairs = (
            [("baseline", "candidate")]
            if set(labels) == {"baseline", "candidate"}
            else [("original", "v1"), ("original", "v1_local"), ("v1", "v1_local")]
        )
        comparisons = []
        for (case_id, round_id), group in groups.items():
            for before, after in pairs:
                if before not in group or after not in group:
                    continue
                assert group[before]["params"] == group[after]["params"]
                comparisons.append(
                    dict(
                        case_id=case_id,
                        round=round_id,
                        before=before,
                        after=after,
                        **compare(group[before], group[after])
                    )
                )
        overview = {}
        for before, after in pairs:
            selected = [p for p in comparisons if p["before"] == before and p["after"] == after]
            complete = [p for p in selected if p["complete_pair"]]
            ids = {(p["case_id"], p["round"]) for p in complete}
            sums = {
                label: sum(r["wall_ms"] for r in rows if r["revision"] == label and (r["case_id"], r["round"]) in ids)
                for label in (before, after)
            }
            overview[before + "_to_" + after] = dict(
                pairs=len(selected),
                complete_pairs=len(complete),
                complete_wall_ratio=sums[after] / sums[before] if sums[before] else None,
                complete_case_ratio_median=statistics.median(p["wall_ratio"] for p in complete) if complete else None,
                exact_coordinate_price_counts=dict(Counter(m["direction"] for p in selected for m in p["matches"])),
                baseline_points=sum(p["baseline_points"] for p in selected),
                baseline_points_covered_in_3d=sum(p["baseline_points_covered_in_3d"] for p in selected),
                complete_trace_differences=[p["case_id"] for p in complete if not p["trace_equal"]],
                partial_trace_prefix_differences=[
                    p["case_id"] for p in selected if not p["complete_pair"] and not p["trace_common_prefix_equal"]
                ],
            )
        details = [
            dict(
                case_id=r["case_id"],
                round=r["round"],
                revision=r["revision"],
                weapon=r["weapon_name"],
                wall_ms=r["wall_ms"],
                complete=r["complete"],
                status=r["status"],
                steps=r["steps"],
                solve_count=r["solve_count"],
                reused_count=r["reused_count"],
                point_count=r["point_count"],
                first_point_ms=r["first_point_ms"],
                **audit(r)
            )
            for r in rows
        ]
        report["runs"].append(
            dict(name=run.name, metadata=meta, comparisons=comparisons, overview=overview, details=details)
        )
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    for run in report["runs"]:
        print(run["name"], json.dumps(run["overview"]))
        for d in run["details"]:
            if d["check_failures"] or d["cleanup_guard_failures"]:
                print("FAIL", d["case_id"], d["revision"])


if __name__ == "__main__":
    main()
