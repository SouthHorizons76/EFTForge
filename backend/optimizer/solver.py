"""Top-level entry point for the weapon build optimizer.

What's deliberately not handled, and why:
  - presets as an alternative "base" competing with the base receiver - the
    one remaining piece of the reference optimizer's model this doesn't cover
  - multi-slot placement variables - attempted (a real gap: 418 of 579
    reachable M4A1 attachments have more than one valid parent slot), but the
    exact formulation blew up solve time badly enough in testing (full test
    suite went from single-digit seconds to 10+ minutes without finishing)
    that it's not viable without real solver-performance work first. Reverted;
    see milp.py's dependency-constraint comment for the narrow correctness
    gap this leaves.
  - Tchebycheff scalarization ("Sweet Spot" mode) - skipped as low value
    without a paired Explore/visualization feature
Found-in-Raid fallback pricing (below) and category include filters and
EvoErgo mode (optimizer/milp.py) are implemented.

Every stat number this module reports comes from stats._compute_stats() -
EFTForge's own, already-tested EED/overswing/arm-stamina/MOA formulas -
never a separately-derived formula, so the optimizer and the Combo
Calculator always agree on what a given attachment set's stats are.
"""

import time
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Optional, List, Dict

from models_items import Item
from models_item_offers import ItemOffer
from models_weapon_presets import WeaponDefaultPreset
from stats import _compute_stats
from compatibility import CompatibilityIndex

from optimizer.compat_map import build_compatibility_map
from optimizer.pricing import get_best_price, offers_by_item
from optimizer.feasibility import check_feasibility
from optimizer.milp import build_and_solve, compute_stat_ranges as _milp_stat_ranges


@dataclass
class OptimizeParams:
    max_price: Optional[float] = None
    min_ergonomics: Optional[float] = None
    max_recoil_v: Optional[float] = None
    max_recoil_sum: Optional[float] = None  # vertical + horizontal combined - used by Gunsmith tasks
    max_weight: Optional[float] = None
    min_mag_capacity: Optional[int] = None
    min_sighting_range: Optional[float] = None
    include_items: Optional[List[str]] = None
    exclude_items: Optional[List[str]] = None
    # Each inner list is an OR-group of raw tarkov.dev category ids - at least
    # one selected item must match each group. Matches Item.category_ids
    # (comma-separated raw category ids, populated by sync_tarkov_dev.py).
    include_categories: Optional[List[List[str]]] = None
    # Flat list of raw category ids - no selected item may match any of them.
    exclude_categories: Optional[List[str]] = None
    # Requires at least one selected item to be a sound suppressor (see
    # optimizer/milp.py's SUPPRESSOR_CATEGORY_ID) - whatever muzzle adapter
    # chain that suppressor needs to be reachable is pulled in automatically
    # by the existing slot-dependency constraints, same as any other item.
    require_suppressor: bool = False
    ergo_weight: float = 1.0
    recoil_weight: float = 1.0
    price_weight: float = 0.0
    # EvoErgo mode swaps the raw capped-ergo term in the weighted ergo/recoil/
    # price objective above for stats.py's true (quadratic) EED, approximated
    # by a refined tangent sweep since a MILP can only optimize a linear
    # objective (see optimizer/milp.py). The result still has to win on the
    # same ergo/recoil/price blend the weights above describe, not just have
    # the single highest EED regardless of how it scores on recoil/price.
    # evo_ergo_k lets a caller pin a specific tangent slope instead of
    # sweeping (and refining) the default anchor set - mainly useful for tests.
    use_evo_ergo: bool = False
    evo_ergo_k: Optional[float] = None
    # Weighted-sum (the ergo/recoil/price blend above) has a real failure mode:
    # a fixed per-unit exchange rate means one item with a large enough single-
    # axis swing can dominate the objective regardless of slider position, so
    # the weights stop doing anything across most of their range (see GitHub
    # #37 discussion - the same failure the reference optimizer's "Sweet Spot
    # Mode" was built to fix). Tchebycheff mode replaces the fixed exchange
    # rate with a min-max of each objective's *normalized* distance from its
    # own best-achievable value, so a 50/50 weighting actually lands roughly
    # halfway between the pure-recoil and pure-ergo builds instead of pinning
    # to one extreme. On by default; only applies to the plain (non-EvoErgo)
    # objective for now - EvoErgo mode keeps its own weighted-sum-with-
    # refinement approach (see milp.py's anchor sweep) until this is extended
    # to it.
    use_tchebycheff: bool = True
    # Hard-constrains the build to stats._compute_stats()'s own "overswing"
    # definition (total_weight <= KG(effective_ergo)), approximated by tangent
    # cuts around milp.py's EVO_ERGO_ERGO_ANCHORS since a MILP can't encode the
    # true quadratic threshold directly.
    prevent_overswing: bool = False
    # Upper bound on stats.py's accuracy_moa (lower MOA = tighter grouping).
    max_moa: Optional[float] = None
    trader_levels: Optional[Dict[str, int]] = None
    flea_available: bool = True
    player_level: Optional[int] = None
    strength_level: int = 10
    equip_ergo_modifier: float = 0.0


def _load_candidates_and_prices(db, weapon_id: str, params: OptimizeParams):
    """Shared setup for optimize_weapon() and get_stat_ranges(): the weapon,
    its reachable mods, and which of those are actually selectable (and at
    what price) once exclude_items/exclude_categories and the current
    trader/flea/player-level access filters are applied.
    """
    weapon = db.query(Item).filter(Item.id == weapon_id, Item.is_weapon == True).first()  # noqa: E712
    if not weapon:
        return None, None, None, None

    compat_map = build_compatibility_map(db, weapon_id)
    all_mod_ids = list(compat_map.reachable_ids)
    shallow = len(compat_map.item_to_slots) == 1

    mods: dict[str, Item | SimpleNamespace] = {}
    if all_mod_ids:
        # Solving is read-only. Plain scalar records avoid ORM tracking and
        # descriptor overhead across model construction and repeated stat calls.
        # For a single level, that setup costs more than the few repeated reads.
        if shallow:
            mods = {m.id: m for m in db.query(Item).filter(Item.id.in_(all_mod_ids)).all()}
        else:
            rows = db.query(*Item.__table__.columns).filter(Item.id.in_(all_mod_ids)).all()
            mods = {row.id: SimpleNamespace(**row._mapping) for row in rows}

    offers_map = {}
    if all_mod_ids:
        # Pricing needs only these scalar columns, not tracked ORM instances
        # or barter payloads. Keep offer order and get_best_price unchanged.
        offer_query = (
            db.query(ItemOffer)
            if shallow
            else db.query(
                ItemOffer.item_id,
                ItemOffer.vendor_normalized,
                ItemOffer.trader_level,
                ItemOffer.price,
                ItemOffer.currency,
                ItemOffer.price_rub,
                ItemOffer.is_flea,
                ItemOffer.min_level_flea,
            )
        )
        offer_rows = offer_query.filter(ItemOffer.item_id.in_(all_mod_ids)).all()
        offers_map = offers_by_item(offer_rows)

    exclude = set(params.exclude_items or [])
    include = set(params.include_items or [])
    exclude_categories = set(params.exclude_categories or [])
    # The weapon's own default-preset parts ship free with the gun, so they stay
    # selectable at price 0 even when no trader/flea sells them - they're genuinely
    # accessible, and a required slot may only be fillable by one of them.
    factory_ids = set(weapon.factory_attachment_ids.split(",")) if weapon.factory_attachment_ids else set()
    candidate_ids = []
    prices = {}
    for item_id in all_mod_ids:
        if item_id in exclude or item_id not in mods:
            continue
        if exclude_categories and exclude_categories & set((mods[item_id].category_ids or "").split(",")):
            continue
        raw_offers = offers_map.get(item_id, [])
        best = get_best_price(raw_offers, params.trader_levels, params.flea_available, params.player_level)
        if best is None:
            # No accessible price - either nothing sells it under the current trader/flea
            # access, or no trader/flea ever sells it at all. Either way it's inaccessible
            # on the open market, so drop it: a priceless part must not read as free
            # (price 0) and get picked as the "cheapest" option. Exceptions kept at price
            # 0: a part the user force-included via the mod filter (they've explicitly
            # asked for it and may already own one), one of the weapon's own factory
            # preset parts (those come with the gun), or a magazine - high-capacity mags
            # are routinely flea-banned and trader-barter-only in-game, so this data set
            # never prices most of them at all. Dropping those would silently shrink the
            # min-mag-capacity slider's range and make the constraint infeasible for
            # capacities that are genuinely obtainable, just not through a priced offer.
            if item_id not in include and item_id not in factory_ids and not mods[item_id].magazine_capacity:
                continue
            best = {"price": 0, "currency": "RUB", "price_rub": 0, "vendor": None}
            # Factory parts really do cost 0 - they ship with the gun. The include/
            # magazine-capacity carve-outs above don't actually know a price, so flag
            # them as such; the manifest UI reads this to show "-" instead of "0₽".
            if item_id not in factory_ids:
                best["no_price"] = True
        candidate_ids.append(item_id)
        prices[item_id] = best

    pruning_started = time.perf_counter()
    available = set(candidate_ids)
    # Slots of inaccessible owners cannot support a root path. Restrict the
    # index before building its reverse edges, especially for low trader levels.
    active_slots = [
        s for s in compat_map.slots_by_id.values() if s.parent_item_id == weapon_id or s.parent_item_id in available
    ]
    active_edges = {s.id: [iid for iid in compat_map.slot_items[s.id] if iid in available] for s in active_slots}
    # Only the weapon is fixed here. Optional-item conflicts still belong to
    # the MILP; indexing them during every slider request would add unused work.
    index = CompatibilityIndex(active_slots, active_edges, {weapon_id: weapon})
    # Preserve the MILP's fixed-weapon exclusions. Includes remain requirements,
    # not a whitelist; pricing exemptions above must survive preprocessing.
    blocked = set(index.item_conflicts.get(weapon_id, ()))
    for sid in index.slot_conflicts.get(weapon_id, ()):
        blocked.update(compat_map.slot_items.get(sid, ()))
    pruned = index.prune(compat_map.item_to_slots.get(weapon_id, ()), available - blocked, require_complete=True)
    market_count = len(candidate_ids)
    candidate_ids = [iid for iid in candidate_ids if iid in pruned.item_ids]
    compat_map.pruning_metrics = {
        "market_candidate_count": market_count,
        "pruned_candidate_count": len(candidate_ids),
        "unreachable_candidate_count": pruned.unreachable_count,
        "required_failure_candidate_count": pruned.required_failure_count,
        "weapon_conflict_candidate_count": len(set(prices) & blocked),
        "pruning_passes": pruned.passes,
        "pruning_ms": round((time.perf_counter() - pruning_started) * 1000, 3),
    }
    # Keep the original slot constraints while shrinking the item variables.
    # Dropping slots owned by removed items would loosen the existing MILP's
    # multi-parent mutex/conflict semantics (placement variables are out of scope).
    return weapon, compat_map, mods, (candidate_ids, prices)


def optimize_weapon(db, weapon_id: str, params: OptimizeParams) -> dict:
    started = time.perf_counter()
    weapon, compat_map, mods, loaded = _load_candidates_and_prices(db, weapon_id, params)
    candidate_load_ms = (time.perf_counter() - started) * 1000
    if weapon is None:
        return {"status": "error", "reason": f"Unknown weapon id: {weapon_id}", "selected_items": [], "slot_pairs": []}
    candidate_ids, prices = loaded
    input_metrics = {
        "reachable_candidate_count": len(compat_map.reachable_ids),
        "market_candidate_count": len(candidate_ids),
        "candidate_load_ms": round(candidate_load_ms, 3),
        **compat_map.pruning_metrics,
    }

    reasons = check_feasibility(weapon, mods, candidate_ids, params)
    if reasons:
        return {
            "status": "infeasible",
            "reason": "; ".join(r["text"] for r in reasons),
            "reason_details": [{"key": r["key"], "params": r["params"]} for r in reasons],
            "selected_items": [],
            "slot_pairs": [],
            "metrics": {**input_metrics, "processing_ms": round((time.perf_counter() - started) * 1000, 3)},
        }

    result = build_and_solve(weapon, mods, compat_map, candidate_ids, prices, params)
    result["metrics"] = {**input_metrics, **result.get("metrics", {})}

    if result["status"] in ("optimal", "feasible"):
        final_stats = _compute_stats(
            weapon, result["selected_items"], mods, params.strength_level, params.equip_ergo_modifier
        )
        result["final_stats"] = final_stats
        result["gun_id"] = weapon_id
        # The exact price/vendor each selected item was actually costed at during
        # the solve (respects flea_available/trader_levels) - the manifest UI
        # renders from this instead of independently re-picking "cheapest overall"
        # client-side, which would ignore those same access filters.
        result["item_prices"] = {item_id: prices[item_id] for item_id in result["selected_items"]}
        # Per-item EvoErgo contribution, so the results-panel manifest can show the
        # same EvoErgo column the attachment table does. Contribution is marginal -
        # the build's EED minus the EED it would have without that one part - which is
        # the meaningful "how much does this part add" figure for a finished build.
        result["evo_contributions"] = _per_item_evo_contributions(
            weapon,
            result["selected_items"],
            mods,
            final_stats["evo_ergo_delta"],
            params.strength_level,
            params.equip_ergo_modifier,
        )
        result["base"], result["grand_total_rub"] = _choose_base(
            db, weapon, params, result["selected_items"], prices, result["total_price_rub"]
        )
        # Selected parts that ship free on the weapon's factory preset - only
        # meaningful when that preset is actually the cheaper base (result["base"]),
        # since otherwise the build is priced off the bare receiver and every part
        # is bought on its own. Lets the manifest UI split these out into their own
        # "Retained from Preset" group instead of listing them as if they were
        # deliberately chosen alongside the optimized parts.
        factory_ids = set(weapon.factory_attachment_ids.split(",")) if weapon.factory_attachment_ids else set()
        result["retained_from_preset"] = (
            sorted(factory_ids & set(result["selected_items"])) if result["base"]["kind"] == "preset" else []
        )

    result["metrics"]["processing_ms"] = round((time.perf_counter() - started) * 1000, 3)
    return result


def _load_best_offer_price(db, item_id, params):
    offers = offers_by_item(db.query(ItemOffer).filter(ItemOffer.item_id == item_id).all()).get(item_id, [])
    return get_best_price(offers, params.trader_levels, params.flea_available, params.player_level)


def _choose_base(db, weapon, params, selected_items, prices, mods_total_rub):
    """Decide whether it's cheaper to build up from the bare base receiver or from the
    weapon's factory preset. The preset is a separate purchasable item that bundles its
    parts, so any selected part already in the preset comes free with it. Returns
    (base_info, grand_total_rub), where base_info names the chosen base and its own
    price/vendor and grand_total_rub is the true all-in cost (base + parts bought on
    top). This is a costing decision made after the solve, so it never changes which
    parts were chosen - only how the build is acquired and priced."""
    inf = float("inf")

    receiver_best = _load_best_offer_price(db, weapon.id, params)
    receiver_price = receiver_best["price_rub"] if receiver_best else None
    receiver_total = (receiver_price if receiver_price is not None else inf) + mods_total_rub

    preset_total = inf
    preset_best = None
    preset_id = None
    row = db.query(WeaponDefaultPreset).filter(WeaponDefaultPreset.weapon_id == weapon.id).first()
    if row:
        preset_id = row.preset_id
        preset_best = _load_best_offer_price(db, preset_id, params)
        if preset_best:
            factory_ids = set(weapon.factory_attachment_ids.split(",")) if weapon.factory_attachment_ids else set()
            covered = sum(prices[i]["price_rub"] for i in selected_items if i in factory_ids and i in prices)
            preset_total = preset_best["price_rub"] + (mods_total_rub - covered)

    if preset_total < receiver_total:
        base = {
            "kind": "preset",
            "item_id": preset_id,
            "price_rub": preset_best["price_rub"],
            "vendor": preset_best["vendor"],
        }
        grand_total = preset_total
    else:
        base = {
            "kind": "receiver",
            "item_id": weapon.id,
            "price_rub": receiver_price,
            "vendor": receiver_best["vendor"] if receiver_best else None,
        }
        grand_total = receiver_total if receiver_total != inf else mods_total_rub

    return base, round(grand_total)


def _per_item_evo_contributions(weapon, selected_ids, mods, full_eed, strength_level, equip_ergo_modifier):
    """Marginal EvoErgo delta each selected part contributes to the build, keyed by
    item id. Each value is full_eed - EED(build without that part). _compute_stats is
    pure arithmetic over the pre-loaded items (no DB, no solve), so one pass per part
    is cheap for the handful of attachments a build has."""
    contributions = {}
    for item_id in selected_ids:
        subset = [i for i in selected_ids if i != item_id]
        eed_without = _compute_stats(weapon, subset, mods, strength_level, equip_ergo_modifier)["evo_ergo_delta"]
        contributions[item_id] = round(full_eed - eed_without, 2)
    return contributions


def get_stat_ranges(db, weapon_id: str, params: OptimizeParams) -> dict:
    """Theoretical [min, max] each hard-constraint stat can reach for this
    weapon under the current trader/flea/player-level access, so the
    optimizer UI can cap each constraint slider to what's actually
    achievable instead of an arbitrary fixed range.
    """
    weapon, compat_map, mods, loaded = _load_candidates_and_prices(db, weapon_id, params)
    if weapon is None:
        return {"status": "error", "reason": f"Unknown weapon id: {weapon_id}"}
    candidate_ids, prices = loaded
    return {"status": "ok", "ranges": _milp_stat_ranges(weapon, mods, compat_map, candidate_ids, prices)}


# Binary-search step count and convergence tolerance, ported from the
# reference optimizer's computeMOAFloor (solver.worker.ts) - it already had
# the right idea: reuse the existing max_moa constraint instead of a second,
# separately-derived "maximize accuracy" model.
_MOA_FLOOR_MAX_ITERS = 14
_MOA_FLOOR_EPS = 0.02


def get_moa_floor(db, weapon_id: str, params: OptimizeParams) -> dict:
    """Exact minimum achievable accuracy_moa for this weapon, found by
    binary-searching the max_moa constraint with real solves (each one an
    actual integer MILP, not the LP-relaxation approximation
    milp.compute_stat_ranges() uses for the fast/default slider bounds).
    Slower, but exact - only run when the user opts into it via the
    optimizer's "Exact slider floor" toggle.
    """
    weapon, compat_map, mods, loaded = _load_candidates_and_prices(db, weapon_id, params)
    if weapon is None:
        return {"status": "error", "reason": f"Unknown weapon id: {weapon_id}"}
    candidate_ids, prices = loaded

    base_params = OptimizeParams(
        trader_levels=params.trader_levels,
        flea_available=params.flea_available,
        player_level=params.player_level,
        ergo_weight=0.0,
        recoil_weight=0.0,
        price_weight=1.0,
    )

    seed = build_and_solve(weapon, mods, compat_map, candidate_ids, prices, base_params)
    if seed["status"] == "infeasible":
        return {"status": "ok", "floor": 0.0}
    if seed["status"] not in ("optimal", "feasible"):
        return {"status": seed["status"], "reason": seed.get("reason"), "floor": None}
    seed_stats = _compute_stats(weapon, seed["selected_items"], mods)
    hi = seed_stats["accuracy_moa"] or 0.0
    lo = 0.0

    for _ in range(_MOA_FLOOR_MAX_ITERS):
        if hi - lo <= _MOA_FLOOR_EPS:
            break
        mid = (lo + hi) / 2
        trial_params = OptimizeParams(
            trader_levels=params.trader_levels,
            flea_available=params.flea_available,
            player_level=params.player_level,
            ergo_weight=0.0,
            recoil_weight=0.0,
            price_weight=1.0,
            max_moa=mid,
        )
        result = build_and_solve(weapon, mods, compat_map, candidate_ids, prices, trial_params)
        if result["status"] in ("optimal", "feasible"):
            stats = _compute_stats(weapon, result["selected_items"], mods)
            hi = min(hi, stats["accuracy_moa"] or hi)
        elif result["status"] == "infeasible":
            lo = mid
        else:
            return {"status": result["status"], "reason": result.get("reason"), "floor": None}

    return {"status": "ok", "floor": round(hi, 3)}
