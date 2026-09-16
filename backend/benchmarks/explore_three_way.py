"""Run three unchanged Explore revisions serially with the same workload."""

import argparse
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys

from explore_ab import emit, sha256


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("original", "v1", "candidate", "database", "cases_json", "output"):
        parser.add_argument("--" + name.replace("_", "-"), type=Path, required=True)
    parser.add_argument("--candidate-label", default="v1_local")
    parser.add_argument("--budget-seconds", type=float, default=30)
    parser.add_argument("--runs", type=int, default=1)
    args = parser.parse_args()
    if not 0 < args.budget_seconds <= 600 or args.runs < 1:
        parser.error("Require a positive budget up to 600 seconds and at least one run")
    cases = json.loads(args.cases_json.read_text())
    args.output.mkdir(parents=True, exist_ok=False)
    env = {
        **os.environ,
        "PYTHONHASHSEED": "0",
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
        "IP_HASH_SECRET": "explore-three-way-local",
        "ADMIN_API_KEY": "explore-three-way-local",
        "DISABLE_BG_MIGRATE": "1",
        "DATABASE_URL": f"sqlite:///file:{args.database.resolve()}?mode=ro&uri=true",
    }
    if args.candidate_label in ("original", "v1") or not args.candidate_label.replace("_", "").isalnum():
        parser.error("Use a distinct alphanumeric candidate label")
    labels = ("original", "v1", args.candidate_label)
    backends = {"original": args.original, "v1": args.v1, args.candidate_label: args.candidate}
    metadata = {
        "mode": "serial_three_way_direct_explore_stream",
        "database_sha256": sha256(args.database),
        "cases_sha256": sha256(args.cases_json),
        "cases": cases,
        "runs": args.runs,
        "budget_seconds": args.budget_seconds,
        "platform": platform.platform(),
        "cpu_affinity": sorted(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else None,
        "thread_env": {
            k: env[k] for k in ("PYTHONHASHSEED", "OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS")
        },
        "versions": {},
    }
    processes, logs, records = {}, [], []
    try:
        for label in labels:
            log = (args.output / f"{label}.stderr.log").open("w")
            logs.append(log)
            process = subprocess.Popen(
                [
                    sys.executable,
                    str(Path(__file__).with_name("explore_ab.py")),
                    "--worker",
                    "--backend",
                    str(backends[label].resolve()),
                    "--database",
                    str(args.database.resolve()),
                    "--budget-seconds",
                    str(args.budget_seconds),
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=log,
                text=True,
                env=env,
            )
            processes[label] = process
            emit({"cases": cases, "legacy_defaults": False, "exclude_items": []}, process.stdin)
            response = process.stdout.readline()
            if not response:
                raise RuntimeError(f"{label} worker failed to start")
            metadata["versions"][label] = json.loads(response)
        resolved = [metadata["versions"][label]["cases"] for label in labels]
        assert resolved[0] == resolved[1] == resolved[2]
        (args.output / "metadata.json").write_text(json.dumps(metadata, indent=2))
        with (args.output / "samples.jsonl").open("w") as stream:
            for round_id in range(args.runs):
                for case_index, case in enumerate(cases):
                    offset = (round_id + case_index) % len(labels)
                    for label in labels[offset:] + labels[:offset]:
                        process = processes[label]
                        emit({"case_id": case["id"]}, process.stdin)
                        response = process.stdout.readline()
                        if not response:
                            raise RuntimeError(f"{label} worker failed; inspect its stderr log")
                        row = {"round": round_id, "phase": "measured", "revision": label, **json.loads(response)}
                        records.append(row)
                        emit(row, stream)
                        emit(
                            {
                                key: row.get(key)
                                for key in (
                                    "round",
                                    "case_id",
                                    "revision",
                                    "processing_ms",
                                    "complete",
                                    "point_count",
                                )
                            }
                        )
        assert sha256(args.database) == metadata["database_sha256"]
        for label in labels:
            for name, digest in metadata["versions"][label]["source_hashes"].items():
                assert sha256(backends[label] / name) == digest, (label, name)
        summary = {}
        for case in cases:
            summary[case["id"]] = {}
            for label in labels:
                rows = [r for r in records if r["case_id"] == case["id"] and r["revision"] == label]
                summary[case["id"]][label] = {
                    "n": len(rows),
                    "complete_runs": sum(r["complete"] for r in rows),
                    "processing_ms": [r["processing_ms"] for r in rows],
                    "processing_ms_median": statistics.median(r["processing_ms"] for r in rows),
                    "point_counts": [r["point_count"] for r in rows],
                    "failed_checks": sum(
                        not all(p.get("checks", {}).values())
                        for r in rows
                        for p in r["points"] + r["attempts"] + [e["point"] for e in r["progress"] if e.get("point")]
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
    main()
