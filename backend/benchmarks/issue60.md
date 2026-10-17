# Issue 60: correctness and solve-time investigation

The active optimizer retains the earlier setup and sparse-matrix speed improvements.
A partial correction is now enabled (see Current state below). The original
investigation, which found every sound full replacement too slow for the dense M4
TrueErgo curves, follows it unchanged.

Issue: <https://github.com/SouthHorizons76/EFTForge/issues/60>.

## Current state

The tangent-cut loops in `optimizer/milp.py` still run first and decide most solves.
Three additions sit on top of them.

1. **False infeasibility is fixed.** When a tangent loop ends with no build (or runs
   out of rounds) after adding a tangent cut, `_solve_with_outer_ted` re-solves from a
   copy of the model without the tangent rows (`ConstraintBuilder.tangent_rows`). It
   runs a best-first search over weight bands: each band is a plain MILP with one chord
   of the concave TED boundary, which is sound inside the band, and a band whose best
   build fails the exact stats check splits at that build's weight. No binaries are
   added, so each band solves about as fast as a tangent-loop solve. The chords are
   fitted to an LP-proven weight range, further capped by the best reachable ergo.
   `optimizer/ted_outer.py` keeps the archived patch's optimistic affine model,
   rounding allowances and exact acceptance check, without its disjunction code.
2. **Explore endpoints are verified.** With overswing prevention on, Explore sets
   `OptimizeParams.verify_ted_optimum` on its axis-boundary solves. If the tangent loop
   accepted a build after adding a tangent cut, the band search runs with that build as
   the incumbent, skips bands whose bound cannot beat it, and returns a strictly better
   build only when one exists.
3. **Unverified builds are labeled.** Any other build accepted after a tangent cut
   carries `optimality_unproven: true`, and the results panel shows "Best found (not
   verified optimal)" with the normal checkmark instead of "Optimal".

Still open: middle-of-curve points can be suboptimal under their own TED floor (most
M4 TrueErgo points carry the label). Usually a neighboring point covers the better
build and the frontier filter drops the worse one. Running the band search first on
every solve fixes this, but measured 3 to 4 times slower on the M4 overswing curves
(TrueErgo at 81 steps: about 7 s to 27 to 30 s), so it stays disabled.

### Measurements

Same harness and case file as below, plus the user-reported HK 416A5 case (M855A1,
100-round magazine, suppressor and Vudu required, Kobra sight shade banned,
TrueErgo and overswing prevention, PvE, 81 steps). Eight workers, one warmup and
three alternating measured pairs, median wall time. Each change was measured
against the unchanged tangent-only baseline.

| Case | Baseline | Fallback only | Fallback and endpoint check |
| --- | --- | --- | --- |
| M4 ordinary, 10 steps | 0.86 s | 0.87 s | 0.94 s |
| M4 overswing, 10 steps | 0.94 s | 0.96 s | 2.71 s, low recoil 49 to 48 |
| M4 overswing, 81 steps | 3.95 s | 3.90 s | 5.48 s |
| M4 TrueErgo and overswing, 10 steps | 2.15 s | 2.13 s | 2.85 s, low recoil 49 to 48 |
| M4 TrueErgo and overswing, 81 steps | 9.63 s | 8.92 s | 8.90 s, low recoil 49 to 48 |
| AK-101 overswing, 20 steps | 1.40 s | 1.39 s | 2.14 s |
| HK 416A5 user case, 81 steps | 2.25 s, 2 points | 11.99 s, 11 points | 9.74 s, 16 points, low recoil 76 to 69 |

The fallback alone returned identical builds to the baseline on every M4 and AK-101
case. The two configurations were measured in separate runs, so the baselines differ
slightly (the endpoint check run measured 0.98, 1.04, 4.16, 2.27, 9.47, 1.46 and
3.10 s). These are local measurements, not timing guarantees.

`tests/test_optimizer_ted_fallback.py` covers the false-infeasibility cases from the
archived patch, compares the band search against brute force on 12 random three-slot
guns at four TED floors, and checks verified endpoints against brute force under
overswing prevention and four TED floors.

## Reproduction

The existing tangent cuts can exclude valid attachment selections. Validating the
returned build's stats does not establish optimality when those selections have
already been excluded. An exhaustive three-choice fixture reproduced both a worse
result marked optimal and false infeasibility. The initial regression run had
32 failures and two passes.

With M4 `5447a9cd4bdc2dbd208b4567`, M855 `54527a984bdc2d4e668b4567`, full magazines,
at least 60-round capacity and PvP prices, the seed-zero baseline returned recoil
48 at TED floor -5.22 and recoil 49 with overswing prevention. The sound one-hot
prototype returned recoil 47 and 48 respectively across hash seeds 0 through 3.
The database and runtime differ from the issue author's original reproduction.

## Explore measurements

Use eight Explore workers, the same read-only database, persistent subprocesses,
alternating A/B order and the application's unchanged 30-second deadlines. The
baseline includes the earlier optimizer speed improvements in this workspace.

| Formulation | M4 TrueErgo and overswing prevention, 10 steps | 81 steps |
| --- | --- | --- |
| One-hot secants | 2.482 to 6.122 s | 7.133 to 30.036 s, partial |
| Log-coded secants | 2.313 to 30.013 s, partial | Not repeated |
| Global chord and retry shortcut | 2.274 to 6.460 s | 7.212 to 30.029 s, partial |
| Hybrid and rounded-floor bound | 2.380 to 7.561 s | 7.501 to 30.015 s, partial |

The one-hot 10-step result is the median of three measured pairs after one warmup.
Its density result uses one pair. Global and hybrid results use one measured pair
after one warmup. The logarithmic result uses one pair. These are local measurements,
not timing guarantees.

The final hybrid retained seven frontier points at 81 steps; the baseline completed
with 14. Ordinary M4 curves retained exact event output; the three-pair one-hot
comparison measured 0.986 to 0.958 seconds. AK-101 overswing curves changed little.
Changing candidate ordering alone would not repair the invalid feasible region.
The sampling method, point density, game formulas and solver options were preserved.

Across the recorded runs, 2,881 returned-build audits passed shared stats and active
constraint checks. This establishes build validity, not global optimality. The
small exhaustive regression oracle and outer-bound proof address the latter for
the existing linear objectives, within the solver's existing numerical tolerances.

Runtime: Python 3.12.10, NumPy 2.5.3, SciPy 1.18.1, SQLAlchemy 2.0.52, Windows 11.
The unchanged database SHA-256 is
`b26887567322e6ba260b7828cd23fe8e6cdb809b73f2e7fd0b9dddb643523ca9`.
See [the aggregate evidence](results/issue60_summary.json) for source hashes,
repetition counts, status, frontier yield and individual measurements. Temporary
directory names in that JSON identify the original measurement stages.
[The compressed raw evidence](results/issue60_raw_evidence.zip) retains the paired
measurement streams, full curve events, per-build audits, harness and baseline
Python sources. Its SHA-256 is recorded in the aggregate evidence.

## Reviewable correction

[issue60_secant.patch](proposals/issue60_secant.patch) contains the final tested
hybrid prototype and its regressions. It applies on top of the earlier speed
changes currently in the workspace. The patch is archived for review and is not
part of the active Python implementation.
The patch passes `git apply --check`. After restoring the active optimizer,
23 setup, sparse-matrix, cache and termination regressions passed; the restored
optimizer files match the prior speed-work snapshot byte for byte.

For modeled margin m, optimistic effective ergonomics S and weight W, the exact
uncapped boundary above 3 kg is f(W) = 100 + m - 300/W. This function is concave.
Its secants lie below the boundary over their intervals. Selecting the minimum
segment line through a binary disjunction therefore retains every feasible build.
A global endpoint chord strengthens the continuous relaxation. Positive floors
also require W <= 300/m because effective ergonomics caps at 100.

The patch uses conservative factory and ammo-rounding allowances, the existing
exact stats oracle, displayed-TED floor checks and strict overswing checks.
Rejected selections receive sound adaptive disjunctions or exact no-good rows.
Local price cleanup fills auxiliary assignments and repeats the exact aiming
check. The final hybrid avoids the initial grid for positive margins and rounds
the model floor outward to the next eligible displayed hundredth.

The full backend suite passed with the prototype: 424 passed and three skipped
in 77.65 seconds. Black and flake8 passed. Preservation regressions enumerate
768 attachment selections and confirm that valid selections survive every learned
cut. Tests also cover equipment scale zero, ammo and UBGL weights, factory overrides,
the 100-point cap, half-cent TED boundaries, incomplete solve status, auxiliary
integrality and local price cleanup. No frontend checks were performed.

The existing TrueErgo objective anchor sweep remains an approximation. This patch
does not establish a new global nonlinear TrueErgo objective optimum. Further
speed work would need independent measurements. Sharing request-local secant
geometry between tiers is mathematically possible with matching affine inputs,
adequate weight-domain coverage and freshly computed row bounds, but its speed
benefit has not been demonstrated.

## Reproduce a curve comparison

Apply the archived patch to a separate candidate checkout that already contains
the earlier speed changes. Run the existing curve benchmark against the active
baseline and that candidate, with the same frozen item database:

```powershell
$env:EFTFORGE_EXPLORE_WORKERS = '8'
backend\venv\Scripts\python.exe backend\benchmarks\explore_ab.py `
  --baseline C:\path\to\baseline\backend `
  --candidate C:\path\to\candidate\backend `
  --database backend\tarkov.db `
  --cases-json backend\benchmarks\issue60_cases.json `
  --warmups 1 --runs 3 --output C:\path\to\new-results
```

Keep the default budget. Run `tests/test_optimizer_ted_outer.py` in the candidate
for the database-independent exhaustive regressions.
