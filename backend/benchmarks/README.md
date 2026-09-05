# Solver baselines

`solver_baseline.py` measures solvers from a cold result cache against fixed,
real-data cases:

- M4A1: dense/deep optimizer stress case; the Stock combo slot exercises a
  bounded but branching Combo Calculator path.
- PPSh-41: shallow, low-branching fast-path contrast case.
- M4A1 at trader level 1 without flea access: market-filtered optimizer input.
- M4A1 with mounts excluded: optimizer input with disconnected descendants.
- M4A1 receiver/barrel Combo tree with handguards excluded: a bounded deep-tree
  case. This produces many results; select it separately for longer runs.

Sync `tarkov.db` first, then run from `backend/` with the normal development
environment variables set:

```bash
PYTHONHASHSEED=0 python benchmarks/solver_baseline.py --runs 9 --case m4a1_stress --case ppsh41_fast_path
PYTHONHASHSEED=0 python benchmarks/solver_baseline.py --runs 9 --case m4a1_ll1_no_flea --case m4a1_excluded_mounts
PYTHONHASHSEED=0 python benchmarks/solver_baseline.py --runs 3 --case m4a1_receiver_barrel_tree
```

The JSON output records compatibility-graph shape, candidate/frontier/model
sizes, truncation state, solver termination, and min/median/max wall time. The
case guards fail loudly if later game-data updates make either weapon stop
representing its intended end of the range, including M4A1 multi-parent/depth
density and the PPSh-41 shallow, single-parent fast path.

Use the same database snapshot, Python/dependency versions, hash seed, and
machine for both revisions. Run the identical benchmark script in both
checkouts without other CPU-heavy work. Hash seeding matters because the
existing candidate set order can change MILP branching. Compare repeated
wall-time samples, not only model size or one solve. Timings are descriptive;
CI does not assert fragile wall-clock speed thresholds.

Result digests compare item selections, computed stats and prices for the
optimizer, and complete serialized Combo results independent of list ordering.
An unequal digest needs investigation: tied optimizer solutions can differ,
and pruning can allow more work within existing Combo truncation limits.
Untruncated Combo outputs should remain equivalent. A known intentional
correctness change is rejection of an owner whose required slot has no
available candidate; the previous MILP skipped that empty constraint.

## Pruning metrics and boundaries

- Optimizer reports market candidates, candidates after pruning, removals due
  to lost root paths, required-slot failure and fixed-weapon conflicts, plus
  pruning time/passes. Candidate loading time includes preprocessing.
- Combo reports pruning time/passes and removed candidate edges summed over
  root-parent views (not globally unique items). Shallow trees skip the index.
- Indices contain copied primitive data and are reused within a request only;
  there is no additional cross-request cache to invalidate. Existing result
  caches retain the shared data-generation invalidation from PR 1.
- Required-slot propagation is used for whole builds, including range and MOA
  setup. Combo retains partial builds and external conflict annotations; its
  cuts concern placements conflicting with a fixed parent or their own owner.
- Pruning is a necessary-condition check, not an exact placement solver.
  Alternative parent paths are retained. Original MILP slot mutex/conflict
  constraints are preserved even when their slot owner is removed.

The database-independent tests in `test_reachability.py` enumerate concrete
small-graph placements to check soundness. `test_reachability_integration.py`
uses in-memory endpoint fixtures for filter, pricing, required-slot, auxiliary
range, conflict-display and request-isolation regressions.

## Request-local preparation follow-up

Deep Combo requests reuse serialized item records and scalar snapshots for
the unchanged stats function. Nested optimizer graphs load scalar slot, item
and offer records; root-only graphs retain the cheaper small-input path.
Already-filtered adjacency lists are reused by pruning. None of these records
are cached across requests.

A local comparison against the first PR2 version (`938c463`) used the same
September 1 game-data snapshot, Python 3.12 and `PYTHONHASHSEED=0`. Revisions
were alternated, with result caches and garbage collection cleared before
each timed sample. The following are median milliseconds, including Combo
SSE serialization and decoding; they do not measure network/browser latency.

| Case | First PR2 | Follow-up | Samples per revision |
| --- | ---: | ---: | ---: |
| M4A1 receiver/barrel Combo, handguards excluded | 11846.8 | 9568.2 | 3 |
| M4A1 Stock Combo | 30.7 | 27.5 | 11 |
| M4A1 optimizer | 127.4 | 124.8 | 11 |
| M4A1 optimizer, LL1 without flea | 47.1 | 44.0 | 11 |
| M4A1 optimizer, mounts excluded | 105.2 | 102.2 | 11 |
| PPSh-41 Combo | 3.51 | 3.50 | 11 |
| PPSh-41 optimizer | 4.59 | 4.62 | 11 |

All result digests matched, including all 51,820 deep-tree Combo results.
The deep Combo improvement is the clearest; optimizer changes are modest
and the shallow cases are effectively unchanged. These observations are
not a general speed guarantee or a CI threshold. Large Combo response
serialization and decoding remain a substantial part of the request time.
