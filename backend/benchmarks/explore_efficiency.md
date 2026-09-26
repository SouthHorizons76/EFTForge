# Explore sampling: efficiency and price validation

Explore repeatedly loads the same candidate graph, offers and ammo for one
curve, then solves nearby problems that sometimes share the same optimum.
This change prepares those inputs once per request and reuses an optimal
linear result only while its original selection proves the tighter ergo
floor remains feasible. Nonlinear TrueErgo and overswing searches retain their
existing solve paths.

For plain ergonomics/recoil curves, a bounded local pass considers cheaper
single-part substitutions and compensating pairs. It checks the full linear
model, preserves raw and displayed combat attributes and the selected factory
parts, and rebuilds parent-first slot pairs. It makes no additional MILP calls.
The target is 20 ms per native recoil result, within the existing 30-second
Explore deadline. This is a cooperative work limit, not a hard per-pass timer.

Sampling endpoints and reuse eligibility use the pre-cleanup native stats.
Incidental ergo improvements therefore do not change later native requests.
Progress includes actual solve/reuse counts, and hard-timeout fallback retains
those counts and uses the TrueErgo axis when requested.

## Measurement conditions

Upstream baseline: `414b46ad0aa07cedf57d78e1cb399ed032d2afc7`.
The fork base `397993d1da7031c9a9cea8b6ef5610baf6d2bc90` has the same tree.
The intermediate `v1` revision contains input/solution reuse without local
price cleanup; it is an experimental comparison, not a published release.

All revisions use the same read-only game-data snapshot, Python 3.12.14,
SciPy 1.18.1 and NumPy 2.3.5. Workers run serially and alternate execution order.
The direct Explore generator is timed, including preparation and output
construction, excluding imports, pre-run GC and post-run auditing. BLAS and
OpenMP thread environment variables are 1; HiGHS options are unchanged.

Database SHA256:
`b5c31c76653b51aeee794773c59567b367e4243ac74bb61bc4e0bf2927e08790`.
[Machine-readable measurements](results/explore_efficiency_summary.json)
include source hashes, runtime versions, paired results and audit counts.
These are fixed-snapshot observations, not browser latency or service SLAs.

## Performance

An initial 81-step full-curve diagnostic used a 120-second budget so every
revision could finish. These times do not imply completion within production's
30-second limit.

| Case | Original seconds | Reuse only | Current |
|---|---:|---:|---:|
| SKS | 9.253 | 2.738 | 2.843 |
| AK-74N | 18.806 | 9.191 | 9.242 |
| MPX | 13.501 | 5.203 | 5.222 |
| M4A1 PVP | 47.084 | 35.903 | 36.307 |
| M4A1 PVE | 52.187 | 37.591 | 37.023 |
| AK-101 | 41.698 | 25.289 | 24.230 |
| M4A1 LL1, no flea | 6.429 | 0.145 | 0.146 |
| M4A1 LL3, no flea | 19.945 | 8.777 | 8.767 |

The expansion tested 15 weapons, 46 distinct configurations and 134 requests,
all with the production 30-second budget. The 40-case main matrix returned
34 complete curves, five infeasible results and one partial curve in both
reuse-only and current revisions. Completed requests, including the five
infeasible cases, took 1.45% longer in aggregate with local price cleanup.

Six additional weapon comparisons used 20 steps and the same 30-second budget:

| Case | Original seconds | Reuse only | Current |
|---|---:|---:|---:|
| HK416 | 4.414 | 3.303 | 3.355 |
| SA58 | 2.752 | 1.949 | 1.961 |
| SR-25 | 4.280 | 3.438 | 3.445 |
| M700 | 3.333 | 2.388 | 2.478 |
| Saiga-12 | 2.808 | 1.599 | 1.681 |
| Glock 17 | 0.121 | 0.025 | 0.030 |

Current aggregate time was 26.87% lower than original in these six cases.
Hash seeds 1 and 7 each covered four cases; all completed, with aggregate
cleanup overhead of 3.25% and 3.82% relative to reuse only. Seeds vary Python
candidate ordering, not HiGHS's random seed. Complete paired native request
sequences and native MILP counts matched throughout.

Three measurements per selected constraint case showed median overhead of
5.6% for HK416 LL3, 9.9% for locked M4 stock/grip, and 9.3% for M4 with M203.
Local cleanup is not free. Its maximum observed pass in the main matrix was
24.633 ms, slightly beyond the cooperative 20 ms target.

## Price and correctness

Compare prices directly only when uncapped raw ergonomics, raw vertical recoil
and displayed attributes all match. The 40-case matrix had 366 matching points:
257 cheaper, 109 equal and none dearer than reuse only. The six-weapon original
comparison had 61 matching points: 60 cheaper and one equal. Including repeated
and hash-seed observations, 650 paired point comparisons against reuse only had
485 reductions and 165 ties. Those are repeated observations, not 650 independent
configurations.

In the initial PVE M4 diagnostic, the exact 48.5-ergo / 47.957-raw-recoil point
cost 427028 RUB in original, 3244992 RUB with reuse only, and 410757 RUB with
bounded cleanup. Prices follow `grand_total_rub`: receiver/preset plus parts,
excluding loaded ammo. `max_price` limits part cost. Existing `no_price` rules
remain in effect and do not prove an unquoted part can actually be bought free.

The expansion audited 2883 selections, deduplicated within each request. No
full linear-model, purchase-total or concrete slot-placement violations were
found. Exact sweep bounds, includes/excludes, category groups, MOA, sighting
range, magazine capacity and loaded weights were checked. Regression tests
also cover deadlines, prepared-context invalidation, factory parts, compensating
swaps, nonlinear exclusions, reuse bounds and timeout metadata.

## Remaining limitations

- M4A1 at 81 steps can still exceed 30 seconds. At a 200000 RUB part budget,
  both variants returned 11 frontier points; reuse only attempted 58 solves
  versus 56 with cleanup. One 98-ergo / 61.285-raw-recoil / 221735-RUB point
  was not covered by the current partial curve. Equal point counts do not
  imply identical coverage.
- Glock 17 has an inherited reuse-only difference: original has raw ergo 104
  at 100350 RUB; current has raw ergo 103 at 105304 RUB, with identical raw
  recoil. Both are plotted at the 100-ergo cap, but current costs 4.94% more.
  Strict uncapped-coordinate comparisons exclude this case. Saiga-12 also
  retains one original attribute combination not covered in all three axes.
  Some SKS price exceptions from the earlier diagnostic remain. There is no
  global cheapest-price guarantee.
- Shared `stats.py` accumulation is order-sensitive near rounding boundaries.
  Seventeen reordered-selection observations differed by one displayed recoil
  point. A fixed HK416 set yields 69.49999999999999 in one accumulation order
  and 69.5 in another, displaying 69 versus 70. This reproduces in original,
  reuse-only and current code; no stat formula change is included here.
- Backend verification does not measure concurrent service throughput or
  frontend behavior.

## Pre-PR checks

The database-independent suite passed 194 tests. All 52 database-dependent
tests then passed against the same read-only snapshot, including solver API,
process-boundary and concurrency checks. Black and Flake8 passed for the entire
backend. The packaged benchmark, summary and audit scripts passed a two-case
three-version smoke check; those smoke timings are not part of the reported
performance measurements.

## Reproduce

From the repository root, using the same database snapshot:

```bash
python backend/benchmarks/explore_ab.py \
  --baseline /path/to/baseline/backend --candidate backend \
  --database /path/to/tarkov.db \
  --cases-json backend/benchmarks/explore_v1_expanded.json \
  --output /tmp/explore-expanded --runs 1

python backend/benchmarks/explore_three_way.py \
  --original /path/to/original/backend --v1 /path/to/reuse-only/backend \
  --candidate backend --database /path/to/tarkov.db \
  --cases-json backend/benchmarks/explore_v1_expanded_original.json \
  --output /tmp/explore-three --budget-seconds 30 --runs 1

python backend/benchmarks/summarize_v1_expanded.py \
  --run /tmp/explore-expanded --output /tmp/explore-summary.json
python backend/benchmarks/audit_v1_expanded.py \
  --backend backend --database /path/to/tarkov.db \
  --run /tmp/explore-expanded --output /tmp/explore-audit.json
```

Keep snapshot and source hashes with every run. Change `--hash-seed` to 1 or 7
for the seed matrix. Run repeat cases with `--runs 2`. Do not run the live data
sync script to reproduce this historical snapshot.
