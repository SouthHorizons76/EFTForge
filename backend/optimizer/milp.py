"""MILP formulation: weapon + mods (no presets-as-base yet - see
optimizer/solver.py's module docstring for what's still deferred and why).

Solved with scipy.optimize.milp (HiGHS backend) - the same solver engine the
original optimizer's WASM frontend already uses.
"""

import time
from collections import deque
from types import SimpleNamespace

import numpy as np
from scipy.optimize import milp, LinearConstraint, Bounds

from stats import _compute_stats

TIEBREAK = 0.01

# A literal zero weight on any axis makes that axis contribute exactly
# nothing to a score/objective, so the solver picks between otherwise-close
# candidates with zero regard for it - producing a real, visible cliff right
# at the 0% corner of the weight triangle (confirmed on plain main: EvoErgo
# ergo_weight=0 gave ergo 29, but 0.01 gave ergo 41, nothing in between).
# This floor keeps every axis in play for tie-breaking, chosen as the
# smallest value that reliably closes that gap in testing (below ~5e-3 the
# EvoErgo case above stayed stuck at 29). It's deliberately still 2x smaller
# than TIEBREAK (0.01), which is exactly what let a large price gap outvote
# a caller's genuine 0% price weight before (see _evo_ergo_true_score's
# docstring) - that fix takes priority, so this floor can't go any higher
# even though it only shrinks the ergo-corner cliff (29 -> ~34) rather than
# eliminating it outright.
WEIGHT_FLOOR = 5e-3

# tarkov.dev raw category id for sound suppressors (standalone and integral
# barrel-suppressors alike) - verified against the synced DB, not just docs.
SUPPRESSOR_CATEGORY_ID = "550aa4cd4bdc2dd8348b456c"

# A no-op OptimizeParams stand-in (every field _build_constraints reads is at
# its default/off value) for compute_stat_ranges(), which wants only the
# structural constraints (slot mutex, dependency, conflicts, required slots),
# not the caller's own hard-stat constraints. Duck-typed instead of importing
# OptimizeParams to avoid a circular import (solver.py imports this module).
_NO_CONSTRAINTS_PARAMS = SimpleNamespace(
    max_price=None,
    min_ergonomics=None,
    max_recoil_v=None,
    max_recoil_sum=None,
    include_categories=None,
    max_weight=None,
    min_mag_capacity=None,
    min_sighting_range=None,
    include_items=None,
    prevent_overswing=False,
    max_moa=None,
    equip_ergo_modifier=0.0,
    require_suppressor=False,
)

# Shared wall-clock budget for one build_and_solve call. A normal solve finishes in well under a
# second; this only ever matters for a pathological case (an earlier attempt
# at multi-slot placement variables produced a MILP that ran for 30+ minutes
# without finishing). Every HiGHS invocation receives only the time remaining
# in this budget, including overswing-cut retries and the EvoErgo anchor sweep.
# Without a shared cap, those nested solves could hold a backend worker for
# many minutes instead of degrading gracefully. Kept well above the
# typical solve time so a legitimately hard-but-feasible constraint combo
# normally has time to finish; see main.py's per-IP/global solve concurrency
# guard for the surrounding request-level protection.
SOLVE_TIME_LIMIT_SECONDS = 30

# Objective exchange rates, mirroring the reference optimizer's lpBuilder.ts so
# the same weight sliders produce the same trade-offs. There, at equal weights,
# one real ergonomics point is worth ew*1e4 objective units, one unit of
# recoil_modifier (a fraction, so 1% = 0.01) is worth rw*1e7, and one ruble is
# worth pw*10 - i.e. a 1% recoil reduction is worth ~10 ergonomics points. We
# reproduce those exact ratios on a ÷1e4 scale: 1 ergo point = ergo_w, 1 unit
# of recoil_modifier = recoil_w*1000 (so 1% = recoil_w*10), 1 ruble =
# price_w*0.001. Recoil is deliberately the dominant combat axis at balanced
# weights - the reference is well-established and this matches how EFT players
# actually build. Both _weighted_objective (plain mode) and _evo_ergo_objective
# (EvoErgo mode) use these same rates for their recoil/price terms, matching
# the reference's useEvoErgo, which only swaps in a weight-penalized ergo term
# on top of the usual blended objective rather than rescaling recoil/price too.
ERGO_OBJ_COEFF = 1.0  # per ergonomics point
RECOIL_OBJ_COEFF = 1000.0  # per unit of recoil_modifier (1% recoil = 10)
PRICE_OBJ_COEFF = 0.001  # per ruble

# EvoErgo tangent sweep: anchor total-ergo values to linearize EFTForge's own
# quadratic KG(E) curve (stats.py's _compute_stats) around. A MILP can only
# optimize a linear objective, so true EED (a quadratic function of ergo) has
# to be approximated by a handful of tangent lines, each solved separately -
# the tangent whose resulting build has the best *true* EED wins. This mirrors
# the reference optimizer's k-sweep approach (CHANGELOG "EED tangent k-sweep
# solver"), just re-derived against EFTForge's own KG(E) coefficients instead
# of the reference's separate formula, per the "always use EFTForge's own
# formula" decision.
EVO_ERGO_ERGO_ANCHORS = [30, 55, 80, 105, 130, 155]

# After solving at a starting anchor, I re-anchor exactly at that candidate's
# own achieved total ergo and resolve again - a fixed-point iteration against
# stats.py's convex KG(E) curve, the same "re-cut exactly where the last
# solve actually landed" idea _solve_avoiding_overswing already uses for the
# overswing constraint. The static 6-point grid alone can strand a candidate
# between two anchors even though a better tangent point sits between them
# (reported in GitHub #37: SureFire MAG5-60 vs Magpul PMAG D-60 on the M4A1),
# so I keep refining each starting anchor's chain until it converges (next_k
# stops moving), repeats a k I've already tried, or the shared deadline hits.
MAX_EVO_ERGO_REFINE_ITERS = 3

# stats.py's KG(E) overswing-threshold curve: KG = KG_A*E^2 + KG_B*E + KG_C.
# Must stay in sync with _compute_stats() there - this is a re-derivation for
# the MILP's linear tangent-cut approximation, not an independent formula.
KG_A, KG_B, KG_C = 0.0007556, 0.02736, 2.9159

# stats.py's accuracy_moa formula: MOA = MOA_K * COI * (1 - total_accuracy_mod/100).
MOA_K = 34.36
# Safe upper bound on the per-candidate-barrel MOA gate terms below - real
# values (COI a few units, accuracy mods a few hundred percent at most) stay
# well under this, mirroring the reference optimizer's own big-M choice.
MOA_BIG_M = 2000.0


class _Infeasible(Exception):
    def __init__(self, reason, key=None, params=None):
        self.reason = reason
        self.key = key
        self.params = params or {}


class ConstraintBuilder:
    """Accumulates (coeffs, lb, ub) rows, then assembles one LinearConstraint."""

    def __init__(self, n):
        self.n = n
        self.rows = []

    def le(self, coeffs: dict, rhs):
        self.rows.append((coeffs, -np.inf, rhs))

    def ge(self, coeffs: dict, rhs):
        self.rows.append((coeffs, rhs, np.inf))

    def eq(self, coeffs: dict, rhs):
        self.rows.append((coeffs, rhs, rhs))

    def build(self):
        if not self.rows:
            return None
        A = np.zeros((len(self.rows), self.n))
        lb = np.zeros(len(self.rows))
        ub = np.zeros(len(self.rows))
        for row_i, (coeffs, l, u) in enumerate(self.rows):
            for col_i, val in coeffs.items():
                A[row_i, col_i] += val
            lb[row_i] = l
            ub[row_i] = u
        return LinearConstraint(A, lb, ub)


def _order_pairs_parent_first(selected_ids, item_to_valid_slots, weapon_id, selected_set):
    """EFTForge's build importer (build-manager.js loadBuildFromPayload) installs
    slot_pairs with a single BFS pass and looks up each pair's parent node by
    slot id - so a child pair arriving before its parent silently gets dropped.
    I pick one concrete slot per selected item (same "first owner that's
    actually in the build" rule the plain selected-order version used), then
    emit pairs in a real BFS from the weapon outward so every parent is
    guaranteed to precede its children.
    """
    chosen = {}
    for item_id in selected_ids:
        for slot_id, owner in sorted(item_to_valid_slots.get(item_id, [])):
            if owner == weapon_id or owner in selected_set:
                chosen[item_id] = (slot_id, owner)
                break

    children_of = {}
    for item_id, (_, owner) in chosen.items():
        children_of.setdefault(owner, []).append(item_id)

    pairs = []
    queue = deque(children_of.get(weapon_id, []))
    while queue:
        item_id = queue.popleft()
        slot_id, _ = chosen[item_id]
        pairs.append([slot_id, item_id])
        queue.extend(children_of.get(item_id, []))

    return pairs


def _item_to_valid_slots(compat_map, candidate_set):
    """item_id -> [(slot_id, owner_id), ...] restricted to candidate items."""
    out = {}
    for slot_id, items in compat_map.slot_items.items():
        owner = compat_map.slot_owner[slot_id]
        for item_id in items:
            if item_id in candidate_set:
                out.setdefault(item_id, []).append((slot_id, owner))
    return out


def _lp_stat_range(cb, n, coeffs):
    """[min, max] of sum(coeffs[i]*x_i) actually achievable under the
    structural constraints already in cb (slot mutex, dependency, conflicts,
    required slots) - via LP relaxation (fast: continuous, no integrality),
    not a raw sum over every reachable item's coefficient. Summing every
    positive (or negative) coefficient across the whole reachable set hugely
    overshoots reality, since most of those items can never be selected
    simultaneously (they compete for the same slots or conflict). A
    relaxation optimum is still a valid outer bound on the true
    integer-feasible range (relaxing integrality can only widen it), so it's
    safe to use for tangent-cut anchors or a UI slider's extremes.
    """
    fallback_lo = float(np.clip(coeffs, None, 0).sum())
    fallback_hi = float(np.clip(coeffs, 0, None).sum())

    constraints = cb.build()
    if constraints is None:
        return fallback_lo, fallback_hi

    bounds = Bounds(0, 1)
    zero_integrality = np.zeros(n)
    res_max = milp(-coeffs, constraints=constraints, bounds=bounds, integrality=zero_integrality)
    res_min = milp(coeffs, constraints=constraints, bounds=bounds, integrality=zero_integrality)

    hi = -res_max.fun if res_max.success else fallback_hi
    lo = res_min.fun if res_min.success else fallback_lo
    return lo, hi


def _add_overswing_cut_at(cb, idx, mods, item_ids, base_ergo, base_weight, equip_ergo_modifier, anchor_ergo):
    """Adds one linear tangent-line cut - total_weight <= KG(effective_ergo)'s
    tangent at anchor_ergo - hard-constraining out exactly the build that sits
    at that ergo value and everything else the tangent's slope excludes. KG is
    convex in ergo, so a MILP (linear only) can't encode the true "weight <=
    KG(ergo)" region directly - that region is itself non-convex - but a
    single tangent line is always a sound (never lets an overswinging build
    through) local bound. See _solve_avoiding_overswing for why this is
    called with one fresh anchor per rejected solve rather than a fixed grid
    of anchors ANDed together up front.
    """
    b = equip_ergo_modifier
    e0 = anchor_ergo * (1 + b)
    kg0 = KG_A * e0 * e0 + KG_B * e0 + KG_C
    slope = (2 * KG_A * e0 + KG_B) * (1 + b)  # d(KG)/d(total_ergo) via chain rule E = total_ergo*(1+b)
    coeffs = {idx[i]: (mods[i].weight or 0) - slope * (mods[i].ergonomics_modifier or 0) for i in item_ids}
    rhs = kg0 + slope * (base_ergo - anchor_ergo) - base_weight
    cb.le(coeffs, rhs)


def _add_max_moa_constraint(cb, idx, mods, weapon, item_ids, max_moa):
    """Hard-constrains stats.py's accuracy_moa <= max_moa. COI-bearing items
    (alternate barrels) override the weapon's own center_of_impact when
    selected, so each is gated with a big-M "if this barrel is chosen" cut;
    a final cut covers "no alternate barrel chosen, falls back to the
    weapon's own COI" when that fallback itself has a real COI value.
    """
    coi_items = [i for i in item_ids if mods[i].center_of_impact is not None]
    acc_items = [i for i in item_ids if mods[i].center_of_impact is None]

    def _acc_coeffs(coi):
        scale = (MOA_K * coi) / 100.0
        return {idx[i]: scale * (mods[i].accuracy_modifier or 0) for i in acc_items}

    if not coi_items:
        base_coi = weapon.center_of_impact
        if base_coi is None:
            raise _Infeasible(
                "This weapon has no accuracy (MOA) stat to constrain.",
                key="optimizer.reason.moaNotSupported",
            )
        cb.ge(_acc_coeffs(base_coi), MOA_K * base_coi - max_moa)
        return

    cb.le({idx[i]: 1 for i in coi_items}, 1)  # at most one alternate barrel active at a time

    for b_id in coi_items:
        coi_b = mods[b_id].center_of_impact
        coeffs = _acc_coeffs(coi_b)
        coeffs[idx[b_id]] = coeffs.get(idx[b_id], 0) - MOA_BIG_M
        cb.ge(coeffs, MOA_K * coi_b - max_moa - MOA_BIG_M)

    if weapon.center_of_impact is not None:
        coeffs = _acc_coeffs(weapon.center_of_impact)
        for b_id in coi_items:
            coeffs[idx[b_id]] = coeffs.get(idx[b_id], 0) + MOA_BIG_M
        cb.ge(coeffs, MOA_K * weapon.center_of_impact - max_moa)


def _build_constraints(weapon, mods: dict, compat_map, candidate_ids: list, prices: dict, params):
    """Builds every item_id/idx/constraint/item_to_valid_slots the solve needs,
    independent of the objective - so the EvoErgo sweep can re-solve the same
    model with different objectives without rebuilding constraints each time.
    Raises _Infeasible for anything that can be ruled out before ever calling
    the solver (an empty candidate set, an unmeetable mag/sighting/include
    requirement).
    """
    item_ids = list(candidate_ids)
    idx = {item_id: i for i, item_id in enumerate(item_ids)}
    n = len(item_ids)
    weapon_id = weapon.id

    if n == 0:
        raise _Infeasible(
            "No attachments are available under the current filters.",
            key="optimizer.reason.noAttachmentsAvailable",
        )

    candidate_set = set(item_ids)
    item_to_valid_slots = _item_to_valid_slots(compat_map, candidate_set)

    # One extra continuous column (index n, after every item's binary x_i) for
    # capped_ergo - mirrors the reference optimizer's capped_ergo (lpBuilder.ts).
    ergo_idx = n
    cb = ConstraintBuilder(n + 1)

    # 1. Slot mutex - at most one item per slot.
    for slot_id, items in compat_map.slot_items.items():
        in_play = [i for i in items if i in idx]
        if len(in_play) >= 2:
            cb.le({idx[i]: 1 for i in in_play}, 1)

    # 2. Dependency - an item needs at least one of its owning slots' owners
    # selected (or to sit directly on the weapon). Items reachable through more
    # than one parent are treated as "usable via any of them" (an OR over
    # owners) rather than tracked with per-slot placement variables. Tried a
    # full placement-variable model (see git history) - it's the structurally
    # correct fix (checked on the M4A1: 418 of 579 reachable attachments have
    # more than one valid parent, so this is common, not a rare edge case),
    # but it blew up solve time badly enough in testing (full suite went from
    # single-digit seconds to 10+ minutes without finishing) that it's not
    # viable without real solver-performance work (tighter symmetry-breaking,
    # a solve time limit, or restricting placement vars to only the items that
    # actually matter for a required-slot conflict). Reverted; the narrow
    # correctness gap this leaves - a multi-parent item double-counting toward
    # two different required-slot constraints at once - stays open.
    for item_id in item_ids:
        owners = {owner for _, owner in item_to_valid_slots.get(item_id, [])}
        if weapon_id in owners:
            continue  # always reachable straight off the weapon
        owner_vars = [idx[o] for o in owners if o in idx]
        if owner_vars:
            coeffs = {idx[item_id]: 1}
            for ov in owner_vars:
                coeffs[ov] = coeffs.get(ov, 0) - 1
            cb.le(coeffs, 0)
        else:
            cb.eq({idx[item_id]: 1}, 0)  # no reachable owner - can't be placed

    # 3. Conflicts - item<->item and item<->slot, both directions.
    conflict_pairs = set()

    def _add_conflicts_for(item_id, item_row):
        if item_row.conflicting_item_ids:
            for other_id in item_row.conflicting_item_ids.split(","):
                if other_id in idx:
                    conflict_pairs.add(tuple(sorted((item_id, other_id))))
        if item_row.conflicting_slot_ids:
            for slot_id in item_row.conflicting_slot_ids.split(","):
                for other_id in compat_map.slot_items.get(slot_id, []):
                    if other_id in idx and other_id != item_id:
                        conflict_pairs.add(tuple(sorted((item_id, other_id))))

    for item_id in item_ids:
        _add_conflicts_for(item_id, mods[item_id])
    # The weapon itself may also declare conflicts (e.g. a receiver that
    # blocks a specific handguard) - those forbid the mod outright.
    forced_zero = set()
    if weapon.conflicting_item_ids:
        for other_id in weapon.conflicting_item_ids.split(","):
            if other_id in idx:
                forced_zero.add(other_id)
    if weapon.conflicting_slot_ids:
        for slot_id in weapon.conflicting_slot_ids.split(","):
            for other_id in compat_map.slot_items.get(slot_id, []):
                if other_id in idx:
                    forced_zero.add(other_id)
    for item_id in forced_zero:
        cb.eq({idx[item_id]: 1}, 0)

    for a, b in conflict_pairs:
        cb.le({idx[a]: 1, idx[b]: 1}, 1)

    # 4. Required slots.
    for slot_id, items in compat_map.slot_items.items():
        slot = compat_map.slots_by_id.get(slot_id)
        if not slot or not slot.required:
            continue
        in_play = [i for i in items if i in idx]
        if not in_play:
            continue
        owner = compat_map.slot_owner[slot_id]
        coeffs = {idx[i]: -1 for i in in_play}
        if owner == weapon_id:
            cb.le(coeffs, -1)  # sum(x_i) >= 1
        elif owner in idx:
            coeffs[idx[owner]] = coeffs.get(idx[owner], 0) + 1
            cb.le(coeffs, 0)  # sum(x_i) >= x_owner

    # 5. Hard-stat / budget constraints. Recoil and weight are affine in x
    # given a fixed receiver base, since EFTForge's own stat formula is
    # base * (1 + sum(x_i * modifier_i)) for recoil and base + sum(x_i *
    # weight_i) for weight - both linear once the base is a known constant.
    base_ergo = weapon.base_ergonomics or 0
    base_weight = weapon.weight or 0
    base_recoil_v = weapon.recoil_vertical
    base_recoil_h = weapon.recoil_horizontal

    if params.max_price is not None:
        cb.le({idx[i]: prices[i]["price_rub"] for i in item_ids}, params.max_price)

    # capped_ergo <= base_ergo + sum(ergo_modifier_i * x_i), bounded [0, 100] by
    # _solve_once's Bounds. This feeds ONLY the objective's ergo term (see
    # _weighted_objective) - past 100 ergo does nothing further for ranking builds
    # against each other, so the solver shouldn't keep spending recoil/price budget
    # chasing it. It's deliberately NOT used for min_ergonomics or reported anywhere:
    # stats.py's total_ergo (what the build panel displays, and what EED/overswing/
    # arm stamina are computed from) stays the real uncapped sum - the display must
    # show the actual computed number, not a solver-internal scoring artifact.
    ergo_cap_coeffs = {idx[i]: -(mods[i].ergonomics_modifier or 0) for i in item_ids}
    ergo_cap_coeffs[ergo_idx] = 1
    cb.le(ergo_cap_coeffs, base_ergo)

    if params.min_ergonomics is not None:
        cb.ge({idx[i]: (mods[i].ergonomics_modifier or 0) for i in item_ids}, params.min_ergonomics - base_ergo)

    if params.max_recoil_v is not None and base_recoil_v is not None:
        cb.le(
            {idx[i]: base_recoil_v * (mods[i].recoil_modifier or 0) for i in item_ids},
            params.max_recoil_v - base_recoil_v,
        )

    # Vertical + horizontal combined - both scale by the same recoil_modifier
    # sum per _compute_stats, so this is still affine in x given fixed bases.
    if params.max_recoil_sum is not None and base_recoil_v is not None and base_recoil_h is not None:
        base_sum = base_recoil_v + base_recoil_h
        cb.le(
            {idx[i]: base_sum * (mods[i].recoil_modifier or 0) for i in item_ids},
            params.max_recoil_sum - base_sum,
        )

    if params.include_categories:
        for group in params.include_categories:
            group_set = set(group)
            matching = [i for i in item_ids if group_set & set((mods[i].category_ids or "").split(","))]
            if not matching:
                raise _Infeasible(
                    f"No available item matches required category group: {sorted(group_set)}.",
                    key="optimizer.reason.categoryGroupUnavailable",
                    params={"groups": ", ".join(sorted(group_set))},
                )
            cb.ge({idx[i]: 1 for i in matching}, 1)

    if params.require_suppressor:
        suppressors = [i for i in item_ids if SUPPRESSOR_CATEGORY_ID in (mods[i].category_ids or "").split(",")]
        if not suppressors:
            raise _Infeasible(
                "No available suppressor is compatible with this weapon under the current filters.",
                key="optimizer.reason.suppressorUnavailable",
            )
        cb.ge({idx[i]: 1 for i in suppressors}, 1)

    if params.max_weight is not None:
        cb.le({idx[i]: (mods[i].weight or 0) for i in item_ids}, params.max_weight - base_weight)

    if params.min_mag_capacity:
        mags = [i for i in item_ids if (mods[i].magazine_capacity or 0) >= params.min_mag_capacity]
        if not mags:
            raise _Infeasible(
                f"No available magazine with capacity >= {params.min_mag_capacity} rounds.",
                key="optimizer.reason.minMagCapacityUnavailable",
                params={"capacity": params.min_mag_capacity},
            )
        cb.ge({idx[i]: 1 for i in mags}, 1)

    if params.min_sighting_range:
        base_sight = weapon.sighting_range or 0
        if base_sight < params.min_sighting_range:
            sights = [i for i in item_ids if (mods[i].sighting_range or 0) >= params.min_sighting_range]
            if not sights:
                raise _Infeasible(
                    f"No available sight with sighting range >= {params.min_sighting_range}m.",
                    key="optimizer.reason.minSightingRangeUnavailable",
                    params={"range": params.min_sighting_range},
                )
            cb.ge({idx[i]: 1 for i in sights}, 1)

    if params.include_items:
        for req_id in params.include_items:
            if req_id not in idx:
                raise _Infeasible(
                    f"Required item {req_id} is not available under the current filters.",
                    key="optimizer.reason.requiredItemUnavailable",
                    params={"itemId": req_id},
                )
            cb.eq({idx[req_id]: 1}, 1)

    if params.max_moa is not None:
        _add_max_moa_constraint(cb, idx, mods, weapon, item_ids, params.max_moa)

    return item_ids, idx, cb, item_to_valid_slots, base_ergo, base_weight, base_recoil_v, ergo_idx


def _weighted_objective(item_ids, idx, mods, prices, params):
    ergo_w = max(params.ergo_weight, TIEBREAK)
    recoil_w = max(params.recoil_weight, TIEBREAK)
    price_w = max(params.price_weight, TIEBREAK)

    # recoil_modifier is a pure fraction (-0.12 = -12%), so - like the reference -
    # the objective scores recoil as a percentage and the weapon's absolute base
    # recoil never enters here. A recoil-reducing mod has a negative modifier, so
    # its recoil_term is negative and pulls the (minimized) objective down.
    n_items = len(item_ids)
    c = np.zeros(n_items + 1)
    for item_id in item_ids:
        i = idx[item_id]
        recoil_term = recoil_w * RECOIL_OBJ_COEFF * (mods[item_id].recoil_modifier or 0)
        price_term = price_w * PRICE_OBJ_COEFF * prices[item_id]["price_rub"]
        c[i] = recoil_term + price_term
    # capped_ergo (see _build_constraints) instead of a raw per-item ergo term -
    # ergo past 100 is worthless in-game, so the objective must stop rewarding it there.
    c[n_items] = -ergo_w * ERGO_OBJ_COEFF
    return c


def _evo_ergo_objective(k, item_ids, idx, mods, prices, params):
    """Same blended objective as _weighted_objective, on the exact same
    exchange rates (ERGO_OBJ_COEFF/RECOIL_OBJ_COEFF/PRICE_OBJ_COEFF), except
    the raw ergo term is replaced with a tangent-linearized EvoErgo term (ergo
    adjusted for its weight cost at slope k, the first-order approximation of
    EFTForge's true quadratic EED around the ergo value k was derived from).
    This matches the reference optimizer's lpBuilder.ts, where useEvoErgo only
    adds a weight-penalty term on top of the usual blended ergo/recoil/price
    objective, it doesn't replace it or its rates - k plays the role of "true"
    marginal ergo value (dEED/dergo at the anchor) in place of the plain
    mode's flat 1-point-per-point assumption, and 15 is dEED/dweight (both
    read straight off stats.py's evo_weight = total_weight - KG(E)).
    """
    ergo_w = max(params.ergo_weight, TIEBREAK)
    recoil_w = max(params.recoil_weight, TIEBREAK)
    price_w = max(params.price_weight, TIEBREAK)

    # capped_ergo (index len(item_ids), see _build_constraints) plays no part in
    # EvoErgo mode - the tangent-linearized term below replaces it entirely - so
    # it's left at coefficient 0 here; the shared constraint set still carries the
    # column, it's just an unused free variable for this objective.
    c = np.zeros(len(item_ids) + 1)
    for item_id in item_ids:
        i = idx[item_id]
        evo_ergo_term = (
            ergo_w * ERGO_OBJ_COEFF * (-k * (mods[item_id].ergonomics_modifier or 0) + 15 * (mods[item_id].weight or 0))
        )
        recoil_term = recoil_w * RECOIL_OBJ_COEFF * (mods[item_id].recoil_modifier or 0)
        price_term = price_w * PRICE_OBJ_COEFF * prices[item_id]["price_rub"]
        c[i] = evo_ergo_term + recoil_term + price_term
    return c


def _evo_ergo_k_for_anchor(ergo_anchor, equip_ergo_modifier):
    b = equip_ergo_modifier
    E0 = ergo_anchor * (1 + b)
    kg_prime = 0.0015112 * E0 + 0.02736  # d/dE of stats.py's KG(E) = 0.0007556*E^2 + 0.02736*E + 2.9159
    return 15 * kg_prime * (1 + b)  # chain rule through E = ergo*(1+b)


def _evo_ergo_true_score(candidate, weapon, mods, params):
    """The exact value of the same blended objective _evo_ergo_objective's
    tangent line only approximates for a given candidate build - true
    (quadratic) EED in place of the linearized guess, recoil/price read
    straight off the candidate's own selected items. Lower is better,
    matching the LP's minimize convention.

    This is what decides between differently-anchored candidates, instead of
    comparing raw EED alone. Comparing raw EED let the sweep hand back a
    build that looked "best on ergo" while ignoring how it scored on
    recoil/price entirely, even at extreme weightings - a 100%-recoil-weighted
    run could beat a partly-ergo-weighted run on EED, because the winner
    was never actually chosen by the weights the caller asked for (see
    GitHub #37's non-monotonic EED report).

    Deliberately *not* flooring these at TIEBREAK the way _evo_ergo_objective
    does for its own per-item coefficients - that floor exists so a literal
    zero weight still leaves the LP well-posed while it's picking a
    candidate, not so a weight the caller explicitly set to 0% keeps quietly
    swinging which candidate wins. Once TIEBREAK was floating around here
    too, a large price gap between two candidates could outvote the EED
    difference the caller actually asked to weight, even at price_weight=0
    (found while chasing a real slider-drop report: 0% ergo scored 1.92 EED,
    7% ergo scored 0.26 - the 7% pick was ~41,000 RUB cheaper, and the
    floored price term was worth more to the old score than that EED gap).

    WEIGHT_FLOOR is used instead - smaller than TIEBREAK (0.01) so it's much
    less likely to matter against a real weight, but nonzero so an axis set
    to a literal 0% still gets *some* say in tie-breaking instead of none at
    all (that all-or-nothing switch is what caused the 0%-vs-1%-ergo cliff -
    see test_literal_zero_weight_does_not_cliff_against_the_next_ui_tick).
    It only shrinks that cliff rather than eliminating it: closing it fully
    would need a floor close to TIEBREAK's own size, which is what caused
    the price-override bug above in the first place.
    """
    ergo_w = max(params.ergo_weight, WEIGHT_FLOOR)
    recoil_w = max(params.recoil_weight, WEIGHT_FLOOR)
    price_w = max(params.price_weight, WEIGHT_FLOOR)
    eed = _compute_stats(weapon, candidate["selected_items"], mods, params.strength_level, params.equip_ergo_modifier)[
        "evo_ergo_delta"
    ]
    recoil_sum = sum((mods[i].recoil_modifier or 0) for i in candidate["selected_items"])
    return (
        -ergo_w * ERGO_OBJ_COEFF * eed
        + recoil_w * RECOIL_OBJ_COEFF * recoil_sum
        + price_w * PRICE_OBJ_COEFF * candidate.get("total_price_rub", 0)
    )


def _milp_metadata(res):
    """Normalize SciPy/HiGHS termination data into JSON-safe fields."""
    out = {
        "solver_status_code": int(res.status),
        "solver_message": str(res.message),
    }
    for key in ("mip_node_count", "mip_dual_bound", "mip_gap"):
        value = getattr(res, key, None)
        if value is not None and np.isfinite(value):
            out[key] = int(value) if key == "mip_node_count" else float(value)
    return out


def _empty_result(status, reason, metadata, metrics):
    result = {
        "status": status,
        "reason": reason,
        "selected_items": [],
        "slot_pairs": [],
        "termination": metadata,
        "metrics": metrics,
    }
    if status == "infeasible":
        result["reason_key"] = "optimizer.infeasible"
    return result


def _deadline_timeout(matrix_ms=0.0):
    reason = "The overall solver time limit was reached before finding a feasible build."
    return _empty_result(
        "timeout",
        reason,
        {
            "solver_status_code": 1,
            "solver_message": "Overall solver time limit reached.",
        },
        {
            "matrix_build_ms": round(matrix_ms, 3),
            "solver_ms": 0.0,
            "solve_count": 0,
            "solve_status_counts": {},
        },
    )


def _solve_once(c, cb, n, item_ids, weapon_id, item_to_valid_slots, prices, deadline=None, extra_bounds=(100.0,)):
    """extra_bounds is the upper bound for each trailing continuous column
    past the n binary x_i's - normally just capped_ergo (index n, bounded
    [0, 100]). Tchebycheff solves (see _solve_tchebycheff_once) pass a second
    entry for the unbounded-above min-max auxiliary z, reusing this same
    solve/status-handling logic instead of duplicating it for one extra
    column."""
    matrix_start = time.perf_counter()
    constraints = cb.build()
    matrix_ms = (time.perf_counter() - matrix_start) * 1000
    extra_n = len(extra_bounds)
    bounds = Bounds(np.zeros(n + extra_n), np.concatenate([np.ones(n), np.array(extra_bounds, dtype=float)]))
    integrality = np.concatenate([np.ones(n), np.zeros(extra_n)])

    time_limit = SOLVE_TIME_LIMIT_SECONDS
    if deadline is not None:
        time_limit = min(time_limit, deadline - time.perf_counter())
        if time_limit <= 0:
            return _deadline_timeout(matrix_ms)

    solve_start = time.perf_counter()
    res = milp(
        c,
        constraints=constraints,
        bounds=bounds,
        integrality=integrality,
        options={"time_limit": time_limit},
    )
    solve_ms = (time.perf_counter() - solve_start) * 1000
    metadata = _milp_metadata(res)
    metrics = {"matrix_build_ms": round(matrix_ms, 3), "solver_ms": round(solve_ms, 3)}

    # scipy.optimize.milp status codes: 0=optimal, 1=iteration/time limit,
    # 2=infeasible, 3=unbounded, 4=other solver failure. A limit result may
    # still carry a valid incumbent; preserve it, but never label it optimal.
    extra_ok = res.x is not None and len(res.x) == n + extra_n
    if extra_ok:
        for j, ub in enumerate(extra_bounds):
            val = res.x[n + j]
            if not (-1e-6 <= val <= (ub + 1e-6 if np.isfinite(ub) else np.inf)):
                extra_ok = False
                break
    has_incumbent = (
        extra_ok
        and np.all(np.isfinite(res.x))
        and np.all(np.asarray(res.x[:n]) >= -1e-6)
        and np.all(np.asarray(res.x[:n]) <= 1 + 1e-6)
        and np.allclose(res.x[:n], np.rint(res.x[:n]), atol=1e-5)
    )
    if res.status == 2:
        return _empty_result("infeasible", "No feasible build satisfies these constraints.", metadata, metrics)
    if res.status == 1 and not has_incumbent:
        return _empty_result(
            "timeout", "The solver reached its time limit before finding a feasible build.", metadata, metrics
        )
    if res.status not in (0, 1) or not has_incumbent:
        return _empty_result("error", f"MILP solver failed: {res.message}", metadata, metrics)

    selected_ids = [item_ids[i] for i in range(n) if res.x[i] > 0.5]
    selected_set = set(selected_ids)
    slot_pairs = _order_pairs_parent_first(selected_ids, item_to_valid_slots, weapon_id, selected_set)

    return {
        "status": "optimal" if res.status == 0 else "feasible",
        "reason": (
            None if res.status == 0 else "The solver reached its time limit; showing the best feasible build found."
        ),
        "selected_items": selected_ids,
        "slot_pairs": slot_pairs,
        "total_price_rub": sum(prices[i]["price_rub"] for i in selected_ids),
        "termination": metadata,
        "metrics": metrics,
    }


def _aggregate_attempt_metrics(attempts):
    """Combine direct solves and nested lazy-cut solves without undercounting."""
    status_counts = {}
    solve_count = 0
    matrix_build_ms = 0.0
    solver_ms = 0.0
    for attempt in attempts:
        metrics = attempt.get("metrics", {})
        matrix_build_ms += metrics.get("matrix_build_ms", 0.0)
        solver_ms += metrics.get("solver_ms", 0.0)
        nested_counts = metrics.get("solve_status_counts")
        if nested_counts is not None:
            for status, count in nested_counts.items():
                status_counts[status] = status_counts.get(status, 0) + count
            solve_count += metrics.get("solve_count", sum(nested_counts.values()))
        else:
            status = attempt["status"]
            status_counts[status] = status_counts.get(status, 0) + 1
            solve_count += 1
    return {
        "matrix_build_ms": round(matrix_build_ms, 3),
        "solver_ms": round(solver_ms, 3),
        "solve_count": solve_count,
        "solve_status_counts": status_counts,
    }


# Each iteration below only ever fires because a real solve just proved a
# fresh cut necessary, so this is a generous ceiling, not a tuned budget -
# it exists purely so a pathological weapon can't hang a request.
MAX_OVERSWING_CUT_ITERS = 40


def _solve_avoiding_overswing(
    c,
    cb,
    n,
    item_ids,
    idx,
    weapon,
    mods,
    item_to_valid_slots,
    prices,
    base_ergo,
    base_weight,
    equip_ergo_modifier,
    strength_level,
    deadline=None,
    extra_bounds=(100.0,),
):
    """Same contract as _solve_once, but hard-constrains the result to
    stats.py's own "overswing" definition (total_weight <= KG(effective_ergo))
    without the unsoundness-by-omission a fixed grid of ANDed tangent cuts
    has: since KG is convex, ANDing several tangent lines only ever shrinks
    the modeled region as more/wider-spread anchors are added, it never
    converges toward the true curve - so a weapon whose viable builds all
    land far from every anchor could see every one of them rejected even
    though none of them actually overswing (see SVDS + suppressor + prevent
    overswing).

    Solves once with whatever overswing cuts are already in cb, checks the
    result against stats._compute_stats()'s exact formula, and - only if it
    actually overswings - adds one new cut anchored exactly at that build's
    own total_ergo (tight there, so it's guaranteed to exclude that specific
    build without extrapolating a stale bound across the whole ergo range)
    and retries. cb accumulates cuts across calls, so repeat calls (e.g. the
    EvoErgo anchor sweep below) never rediscover the same violation twice.
    """
    attempts = []
    for _ in range(MAX_OVERSWING_CUT_ITERS):
        result = _solve_once(
            c, cb, n, item_ids, weapon.id, item_to_valid_slots, prices, deadline=deadline, extra_bounds=extra_bounds
        )
        attempts.append(result)
        if result["status"] not in ("optimal", "feasible"):
            result["metrics"] = _aggregate_attempt_metrics(attempts)
            return result
        stats = _compute_stats(weapon, result["selected_items"], mods, strength_level, equip_ergo_modifier)
        if not stats["overswing"]:
            incomplete = any(attempt["status"] != "optimal" for attempt in attempts)
            if incomplete:
                result = {**result}
                result["status"] = "feasible"
                result["reason"] = (
                    "At least one overswing-cut solve reached a limit; showing the best feasible build found."
                )
                result["termination"] = {
                    "solver_status_code": 1,
                    "solver_message": "Overswing-cut solve incomplete.",
                    "attempts": [attempt.get("termination", {}) for attempt in attempts],
                }
            result["metrics"] = _aggregate_attempt_metrics(attempts)
            return result
        selected_ergo = base_ergo + sum((mods[i].ergonomics_modifier or 0) for i in result["selected_items"])
        _add_overswing_cut_at(cb, idx, mods, item_ids, base_ergo, base_weight, equip_ergo_modifier, selected_ergo)
    reason = "Overswing constraint cut iteration limit reached before finding a feasible build."
    return _empty_result(
        "error",
        reason,
        {
            "solver_status_code": 4,
            "solver_message": reason,
            "attempts": [attempt.get("termination", {}) for attempt in attempts],
        },
        _aggregate_attempt_metrics(attempts),
    )


# --- Tchebycheff ("Sweet Spot") scalarization ---
# See OptimizeParams.use_tchebycheff's docstring (solver.py) for why this
# exists: a fixed per-unit exchange rate lets one item's outsized single-axis
# swing dominate weighted-sum regardless of slider position. Tchebycheff
# instead minimizes the worst (max) of each axis's own weighted, normalized
# distance from its own best-achievable value, so weights actually control
# where the result lands relative to what's achievable on each axis alone.

# Standard "augmented Tchebycheff" tie-breaker: without it, min-max can return
# a merely weakly-efficient point (needlessly bad on an unweighted axis, since
# nothing in a plain min z objective penalizes slack on axes that aren't the
# current worst one). Added as a small secondary term so ties are broken
# toward genuinely Pareto-optimal builds; kept small enough to never override
# the primary min-max ranking.
TCHEBYCHEFF_AUGMENTATION_RHO = 1e-3

# Upper bound for z, the min-max auxiliary column - a normalized deviation
# that's realistically at most a few hundred even in extreme weight/range
# combinations. Bounded finite rather than left at np.inf: HiGHS handles a
# large-but-finite bound more predictably than a genuinely unbounded column.
TCHEBYCHEFF_Z_BOUND = 1e6


def _pure_axis_objective(kind, item_ids, idx, mods, prices, n):
    """A single-axis-only objective (no blending, no TIEBREAK) used purely to
    find that axis's own best-achievable value - the Tchebycheff ideal point."""
    c = np.zeros(n + 1)
    if kind == "ergo":
        c[n] = -1.0  # maximize capped_ergo
    elif kind == "recoil":
        for item_id in item_ids:
            c[idx[item_id]] = mods[item_id].recoil_modifier or 0
    else:
        for item_id in item_ids:
            c[idx[item_id]] = prices[item_id]["price_rub"]
    return c


def _candidate_axis_values(candidate, mods, prices, base_ergo):
    selected = candidate["selected_items"]
    ergo = min(100.0, base_ergo + sum((mods[i].ergonomics_modifier or 0) for i in selected))
    recoil = sum((mods[i].recoil_modifier or 0) for i in selected)
    price = candidate.get("total_price_rub") or sum(prices[i]["price_rub"] for i in selected)
    return {"ergo": ergo, "recoil": recoil, "price": price}


def _compute_ideal_and_nadir(
    cb, n, item_ids, idx, mods, prices, weapon, item_to_valid_slots, base_ergo, base_weight, params, deadline
):
    """One pure single-axis solve per axis (ergo/recoil/price) finds that
    axis's ideal point; the *other* two axes' values on those same builds
    give a payoff-table nadir estimate - the standard, solve-cheap way to get
    normalization ranges for Tchebycheff without computing the true nadir
    (itself as hard as the original problem). Returns (ideal, nadir, attempts)
    - (None, None, attempts) if any axis solve didn't reach a usable build, so
    the caller can fall back to weighted-sum rather than scalarize against a
    broken reference point.
    """
    attempts = []
    axis_builds = {}
    for kind in ("ergo", "recoil", "price"):
        c = _pure_axis_objective(kind, item_ids, idx, mods, prices, n)
        if params.prevent_overswing:
            # Each axis gets its own copy of cb's rows rather than sharing (and
            # mutating) the caller's cb directly - overswing cuts anchored while
            # chasing one axis's extreme (e.g. pure price, which might land at
            # very low ergo) are only sound *there*, and accumulating them
            # across all three axes plus the final Tchebycheff solve recreates
            # exactly the "several ANDed tangent cuts jointly exclude every
            # non-overswinging build" failure _solve_avoiding_overswing's
            # adaptive, one-cut-per-violation design exists to avoid (see its
            # own docstring, and the SVDS+suppressor regression test).
            axis_cb = ConstraintBuilder(cb.n)
            axis_cb.rows = list(cb.rows)
            candidate = _solve_avoiding_overswing(
                c,
                axis_cb,
                n,
                item_ids,
                idx,
                weapon,
                mods,
                item_to_valid_slots,
                prices,
                base_ergo,
                base_weight,
                params.equip_ergo_modifier,
                params.strength_level,
                deadline=deadline,
            )
        else:
            candidate = _solve_once(c, cb, n, item_ids, weapon.id, item_to_valid_slots, prices, deadline=deadline)
        attempts.append(candidate)
        if candidate["status"] not in ("optimal", "feasible"):
            return None, None, attempts
        axis_builds[kind] = _candidate_axis_values(candidate, mods, prices, base_ergo)

    ideal = {
        "ergo": axis_builds["ergo"]["ergo"],
        "recoil": axis_builds["recoil"]["recoil"],
        "price": axis_builds["price"]["price"],
    }
    nadir = {
        "ergo": min(axis_builds["recoil"]["ergo"], axis_builds["price"]["ergo"]),
        "recoil": max(axis_builds["ergo"]["recoil"], axis_builds["price"]["recoil"]),
        "price": max(axis_builds["ergo"]["price"], axis_builds["recoil"]["price"]),
    }
    return ideal, nadir, attempts


def _tchebycheff_model(cb, n, item_ids, idx, mods, prices, ideal, nadir, params):
    """Extends the shared n+1-column constraint set (items + capped_ergo)
    with one more continuous column (z, the min-max auxiliary) and three cuts
    - one per axis - each lower-bounding z by that axis's own weighted,
    normalized distance from its ideal point. Returns (objective, cb2) ready
    for _solve_once/_solve_avoiding_overswing via
    extra_bounds=(100.0, TCHEBYCHEFF_Z_BOUND).
    """
    ergo_idx = n
    z_idx = n + 1
    # WEIGHT_FLOOR (not TIEBREAK - see _evo_ergo_true_score's docstring for why
    # those are different constants): a literal 0% weight zeroes out both this
    # axis's z-constraint and its augmentation term below, so the solver picks
    # among tied candidates with zero regard for that axis at all - a real
    # cliff right at the 0% corner (confirmed on plain main: recoil_weight=0
    # gives ergo 104.3, but 0.0001 gives ergo 100.0, then flat to 0.01). The
    # floor is far too small to matter against any weight a caller actually
    # set, but keeps every axis in play for tie-breaking instead of switching
    # it off entirely.
    ergo_w = max(params.ergo_weight, WEIGHT_FLOOR)
    recoil_w = max(params.recoil_weight, WEIGHT_FLOOR)
    price_w = max(params.price_weight, WEIGHT_FLOOR)

    # Floors guard degenerate cases where every reachable build ties on one
    # axis (range would otherwise be 0, making that axis's deviation blow up
    # to +-inf for any nonzero difference against the shared solve tolerance).
    ergo_range = max(ideal["ergo"] - nadir["ergo"], 1.0)
    recoil_range = max(nadir["recoil"] - ideal["recoil"], 1e-4)
    price_range = max(nadir["price"] - ideal["price"], 1.0)

    cb2 = ConstraintBuilder(n + 2)
    cb2.rows.extend(cb.rows)

    # z >= ergo_w * (ideal_ergo - capped_ergo) / ergo_range
    cb2.ge({z_idx: 1, ergo_idx: ergo_w / ergo_range}, ergo_w * ideal["ergo"] / ergo_range)

    # z >= recoil_w * (recoil_sum - ideal_recoil) / recoil_range
    recoil_coeffs = {idx[i]: -(recoil_w / recoil_range) * (mods[i].recoil_modifier or 0) for i in item_ids}
    recoil_coeffs[z_idx] = 1
    cb2.ge(recoil_coeffs, -recoil_w * ideal["recoil"] / recoil_range)

    # z >= price_w * (price_sum - ideal_price) / price_range
    price_coeffs = {idx[i]: -(price_w / price_range) * prices[i]["price_rub"] for i in item_ids}
    price_coeffs[z_idx] = 1
    cb2.ge(price_coeffs, -price_w * ideal["price"] / price_range)

    c = np.zeros(n + 2)
    c[z_idx] = 1.0
    c[ergo_idx] = -TCHEBYCHEFF_AUGMENTATION_RHO * ergo_w / ergo_range
    for item_id in item_ids:
        i = idx[item_id]
        c[i] = TCHEBYCHEFF_AUGMENTATION_RHO * (
            (recoil_w / recoil_range) * (mods[item_id].recoil_modifier or 0)
            + (price_w / price_range) * prices[item_id]["price_rub"]
        )
    return c, cb2


def _solve_tchebycheff(
    cb, n, item_ids, idx, mods, prices, weapon, item_to_valid_slots, base_ergo, base_weight, params, deadline
):
    """Top-level Tchebycheff solve: compute ideal/nadir, build the augmented
    min-max model, solve it. Falls back to signaling "no ideal point" (via a
    None return) if any axis solve failed, letting the caller drop back to
    weighted-sum rather than scalarize against a broken reference point.
    """
    ideal, nadir, ideal_attempts = _compute_ideal_and_nadir(
        cb, n, item_ids, idx, mods, prices, weapon, item_to_valid_slots, base_ergo, base_weight, params, deadline
    )
    if ideal is None:
        return None, ideal_attempts

    c, cb2 = _tchebycheff_model(cb, n, item_ids, idx, mods, prices, ideal, nadir, params)
    if params.prevent_overswing:
        result = _solve_avoiding_overswing(
            c,
            cb2,
            n,
            item_ids,
            idx,
            weapon,
            mods,
            item_to_valid_slots,
            prices,
            base_ergo,
            base_weight,
            params.equip_ergo_modifier,
            params.strength_level,
            deadline=deadline,
            extra_bounds=(100.0, TCHEBYCHEFF_Z_BOUND),
        )
    else:
        result = _solve_once(
            c,
            cb2,
            n,
            item_ids,
            weapon.id,
            item_to_valid_slots,
            prices,
            deadline=deadline,
            extra_bounds=(100.0, TCHEBYCHEFF_Z_BOUND),
        )
    return result, ideal_attempts


def build_and_solve(weapon, mods: dict, compat_map, candidate_ids: list, prices: dict, params):
    model_start = time.perf_counter()
    deadline = model_start + SOLVE_TIME_LIMIT_SECONDS
    try:
        item_ids, idx, cb, item_to_valid_slots, base_ergo, base_weight, base_recoil_v, _ergo_idx = _build_constraints(
            weapon, mods, compat_map, candidate_ids, prices, params
        )
    except _Infeasible as exc:
        return {
            "status": "infeasible",
            "reason": exc.reason,
            "reason_key": exc.key,
            "reason_params": exc.params,
            "selected_items": [],
            "slot_pairs": [],
            "metrics": {"model_build_ms": round((time.perf_counter() - model_start) * 1000, 3)},
        }

    n = len(item_ids)
    model_metrics = {
        "variable_count": n,
        "constraint_count": len(cb.rows),
        "coefficient_count": sum(len(coeffs) for coeffs, _, _ in cb.rows),
        "model_build_ms": round((time.perf_counter() - model_start) * 1000, 3),
    }

    if not params.use_evo_ergo:
        if params.use_tchebycheff:
            tcheby_result, ideal_attempts = _solve_tchebycheff(
                cb,
                n,
                item_ids,
                idx,
                mods,
                prices,
                weapon,
                item_to_valid_slots,
                base_ergo,
                base_weight,
                params,
                deadline,
            )
            if tcheby_result is not None:
                tcheby_result["metrics"] = {
                    **model_metrics,
                    **_aggregate_attempt_metrics(ideal_attempts + [tcheby_result]),
                }
                return tcheby_result
            # No usable ideal point (an axis solve timed out/failed) - fall back
            # to weighted-sum rather than fail the request outright.
        c = _weighted_objective(item_ids, idx, mods, prices, params)
        if params.prevent_overswing:
            result = _solve_avoiding_overswing(
                c,
                cb,
                n,
                item_ids,
                idx,
                weapon,
                mods,
                item_to_valid_slots,
                prices,
                base_ergo,
                base_weight,
                params.equip_ergo_modifier,
                params.strength_level,
                deadline=deadline,
            )
        else:
            result = _solve_once(c, cb, n, item_ids, weapon.id, item_to_valid_slots, prices, deadline=deadline)
        solve_metrics = (
            result["metrics"] if "solve_count" in result["metrics"] else _aggregate_attempt_metrics([result])
        )
        result["metrics"] = {
            **model_metrics,
            **solve_metrics,
        }
        return result

    # EvoErgo mode: sweep tangent anchors, refining each one against its own
    # achieved ergo (see MAX_EVO_ERGO_REFINE_ITERS above), and keep whichever
    # candidate scores best on the *true* blended objective (_evo_ergo_true_score)
    # - the tangent-line objectives are only an approximation used to generate
    # candidates the MILP can actually solve. A pinned evo_ergo_k is an exact
    # caller-chosen tangent (tests rely on this solving exactly once), so only
    # the automatic sweep gets refined.
    base_anchors = (
        [params.evo_ergo_k]
        if params.evo_ergo_k is not None
        else [_evo_ergo_k_for_anchor(a, params.equip_ergo_modifier) for a in EVO_ERGO_ERGO_ANCHORS]
    )
    refine = params.evo_ergo_k is None

    best = None
    best_score = None
    attempts = []
    deadline_exhausted = False
    tried_k = set()
    for base_k in base_anchors:
        if deadline_exhausted:
            break
        k = base_k
        for _ in range(1 + (MAX_EVO_ERGO_REFINE_ITERS if refine else 0)):
            if time.perf_counter() >= deadline:
                deadline_exhausted = True
                break
            rounded_k = round(k, 9)
            if rounded_k in tried_k:
                # Another anchor's refinement chain already landed exactly here -
                # redundant, not a sign this anchor went unexplored.
                break
            tried_k.add(rounded_k)
            c = _evo_ergo_objective(k, item_ids, idx, mods, prices, params)
            if params.prevent_overswing:
                candidate = _solve_avoiding_overswing(
                    c,
                    cb,
                    n,
                    item_ids,
                    idx,
                    weapon,
                    mods,
                    item_to_valid_slots,
                    prices,
                    base_ergo,
                    base_weight,
                    params.equip_ergo_modifier,
                    params.strength_level,
                    deadline=deadline,
                )
            else:
                candidate = _solve_once(c, cb, n, item_ids, weapon.id, item_to_valid_slots, prices, deadline=deadline)
            attempts.append(candidate)
            if candidate["status"] == "timeout" and time.perf_counter() >= deadline:
                deadline_exhausted = True
            if candidate["status"] not in ("optimal", "feasible"):
                break
            score = _evo_ergo_true_score(candidate, weapon, mods, params)
            if best_score is None or score < best_score:
                best, best_score = candidate, score
            if not refine:
                break
            achieved_ergo = base_ergo + sum((mods[i].ergonomics_modifier or 0) for i in candidate["selected_items"])
            next_k = _evo_ergo_k_for_anchor(achieved_ergo, params.equip_ergo_modifier)
            if abs(next_k - k) < 1e-9:
                break
            k = next_k

    if best is None:
        result = _deadline_timeout() if deadline_exhausted else None
        if result is None:
            result = next((r for r in attempts if r["status"] == "timeout"), None)
        if result is None:
            result = next((r for r in attempts if r["status"] == "error"), attempts[0])
        result["metrics"] = {
            **model_metrics,
            **_aggregate_attempt_metrics(attempts),
        }
        return result

    incomplete = deadline_exhausted or any(r["status"] != "optimal" for r in attempts)
    if incomplete:
        best = {**best}
        best["status"] = "feasible"
        best["reason"] = "At least one EvoErgo solve reached a limit; showing the best feasible build found."
        best["termination"] = {
            "solver_status_code": 1,
            "solver_message": "EvoErgo sweep incomplete.",
            "attempts": [r.get("termination", {}) for r in attempts],
        }
    best["metrics"] = {
        **model_metrics,
        **_aggregate_attempt_metrics(attempts),
    }
    return best


def _moa_stat_range(cb, idx, mods, item_ids, weapon):
    """[min, max] accuracy_moa actually achievable - same per-candidate-barrel
    reasoning as _add_max_moa_constraint, but reporting the achievable range
    instead of gating a single threshold.
    """
    coi_items = [i for i in item_ids if mods[i].center_of_impact is not None]
    acc_items = [i for i in item_ids if mods[i].center_of_impact is None]

    # cb (built by _build_constraints) carries one extra column past the items for
    # capped_ergo - pad to match even though this range doesn't care about ergo.
    n = len(item_ids)
    acc_coeffs = np.zeros(n + 1)
    for i in acc_items:
        acc_coeffs[idx[i]] = mods[i].accuracy_modifier or 0
    acc_lo, acc_hi = _lp_stat_range(cb, n + 1, acc_coeffs)

    candidate_cois = [mods[i].center_of_impact for i in coi_items]
    if weapon.center_of_impact is not None:
        candidate_cois.append(weapon.center_of_impact)  # "no alternate barrel chosen" fallback
    if not candidate_cois:
        return None

    values = []
    for coi in candidate_cois:
        values.append(MOA_K * coi * (1 - acc_hi / 100))
        values.append(MOA_K * coi * (1 - acc_lo / 100))
    return max(0.0, min(values)), max(values)


def compute_stat_ranges(weapon, mods: dict, compat_map, candidate_ids: list, prices: dict) -> dict:
    """Reachable magazine capacities and the theoretical accuracy_moa range
    for this weapon - the two constraints where the reference optimizer
    itself computes a per-weapon dynamic slider range (availableMagCapacities
    and moaRange in App.tsx). Every other hard constraint (budget, min ergo)
    uses a fixed range there, matched in the frontend instead of here.
    """
    try:
        item_ids, idx, cb, item_to_valid_slots, base_ergo, base_weight, base_recoil_v, _ergo_idx = _build_constraints(
            weapon, mods, compat_map, candidate_ids, prices, _NO_CONSTRAINTS_PARAMS
        )
    except _Infeasible:
        return {}

    ranges = {}

    mag_caps = sorted({mods[i].magazine_capacity for i in item_ids if mods[i].magazine_capacity})
    if mag_caps:
        ranges["mag_capacity"] = {"min": mag_caps[0], "max": mag_caps[-1], "values": mag_caps}

    moa_range = _moa_stat_range(cb, idx, mods, item_ids, weapon)
    if moa_range:
        ranges["moa"] = {"min": round(moa_range[0], 2), "max": round(moa_range[1], 2)}

    return ranges
