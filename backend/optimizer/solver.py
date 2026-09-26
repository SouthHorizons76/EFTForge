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
Found-in-Raid fallback pricing (below) and category include filters and
TrueErgo mode (optimizer/milp.py) are implemented. Use Tchebycheff scalarization
for balanced builds and explore.py for sampled two-objective tradeoffs.

Every stat number this module reports comes from stats._compute_stats() -
EFTForge's own, already-tested TrueErgo/overswing/arm-stamina/MOA formulas -
never a separately-derived formula, so the optimizer and the Combo
Calculator always agree on what a given attachment set's stats are.
"""

import time
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Optional, List, Dict

from models_items import Item
from models_item_offers import ItemOffer
from models_weapon_presets import WeaponDefaultPreset
from stats import _compute_stats, apply_full_mag_ammo
from compatibility import CompatibilityIndex

from optimizer.compat_map import build_compatibility_map
from optimizer.pricing import get_best_price, offers_by_item
from optimizer.feasibility import check_feasibility
from optimizer.milp import build_and_solve, compute_stat_ranges as _milp_stat_ranges


@dataclass
class OptimizeParams:
    max_price: Optional[float] = None
    min_ergonomics: Optional[float] = None
    max_ergonomics: Optional[float] = None
    # Explore-internal only (see explore.py's solve()) - not part of any public
    # request model. Hard-floors TrueErgoDelta via
    # milp.py's _solve_with_min_true_ergo, the same lazy tangent-cut technique
    # prevent_overswing uses, instead of min_ergonomics's plain linear sum.
    # Lets Explore's TrueErgo toggle pick the right build for every point on the
    # curve, not just its "max ergo" boundary.
    min_true_ergo_delta: Optional[float] = None
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
    # TrueErgo mode swaps the raw capped-ergo term in the weighted ergo/recoil/
    # price objective above for stats.py's TrueErgo, approximated
    # by a refined tangent sweep since a MILP can only optimize a linear
    # objective (see optimizer/milp.py). The result still has to win on the
    # same ergo/recoil/price blend the weights above describe, not just have
    # the single highest TrueErgo regardless of how it scores on recoil/price.
    # true_ergo_k lets a caller pin a specific exchange rate instead of
    # sweeping (and refining) the default anchor set - mainly useful for tests.
    use_true_ergo: bool = False
    true_ergo_k: Optional[float] = None
    # Weighted-sum (the ergo/recoil/price blend above) has a real failure mode:
    # a fixed per-unit exchange rate means one item with a large enough single-
    # axis swing can dominate the objective regardless of slider position, so
    # the weights stop doing anything across most of their range (see GitHub
    # #37 discussion - the same failure the reference optimizer's "Sweet Spot
    # Mode" was built to fix). Tchebycheff mode replaces the fixed exchange
    # rate with a min-max of each objective's *normalized* distance from its
    # own best-achievable value, so a 50/50 weighting actually lands roughly
    # halfway between the pure-recoil and pure-ergo builds instead of pinning
    # to one extreme. On by default; only applies to the plain (non-TrueErgo)
    # objective for now - TrueErgo mode keeps its own weighted-sum-with-
    # refinement approach (see milp.py's anchor sweep) until this is extended
    # to it.
    use_tchebycheff: bool = True
    # Hard-constrains the build to stats._compute_stats()'s own "overswing"
    # definition (total_weight <= overswing_limit_kg(effective_ergo)), approximated
    # by tangent cuts at each rejected build's own ergo since a MILP can't
    # encode the true convex threshold directly.
    prevent_overswing: bool = False
    # Upper bound on stats.py's accuracy_moa (lower MOA = tighter grouping).
    max_moa: Optional[float] = None
    trader_levels: Optional[Dict[str, int]] = None
    flea_available: bool = True
    player_level: Optional[int] = None
    # "pvp" | "pve" | "pvpSeason" - which game mode's flea prices to solve against.
    # Trader offers don't vary by mode, so this only ever filters ItemOffer's flea rows.
    game_mode: str = "pvp"
    strength_level: int = 10
    equip_ergo_modifier: float = 0.0
    # Mirrors /build/calculate's "assume full mag" toggle (see stats.apply_full_mag_ammo):
    # ammo selection stays fixed, while each candidate magazine/UBGL carries its own
    # capacity-dependent ammo weight in the objective, constraints and final stats.
    assume_full_mag: bool = True
    selected_ammo_id: Optional[str] = None
    selected_ubgl_ammo_id: Optional[str] = None


def _prepared_input_key(params):
    # Snapshot every setting used to load candidates, offers or selected ammo.
    # Keep mutable lists/dicts out of the key so later edits cannot hide a change.
    return (
        tuple(params.include_items or ()),
        tuple(params.exclude_items or ()),
        tuple(params.exclude_categories or ()),
        None if params.trader_levels is None else tuple(sorted(params.trader_levels.items())),
        params.flea_available,
        params.player_level,
        params.game_mode,
        params.assume_full_mag,
        params.selected_ammo_id,
        params.selected_ubgl_ammo_id,
    )


@dataclass
class PreparedOptimizeContext:
    """Reuse read-only inputs within one Explore request and one database session.

    Prepare a new context for each request; keep changing constraints and objective
    settings in OptimizeParams, and recheck their feasibility on every solve.
    """

    db: object
    weapon_id: str
    input_key: tuple
    candidates: tuple
    candidate_load_ms: float
    ammo: object = None
    ubgl_grenade: object = None
    ammo_loaded: bool = False
    best_offer_prices: dict = field(default_factory=dict)
    preset_id: Optional[str] = None
    preset_loaded: bool = False
    # Enable only for Explore's plain ergonomics/recoil curve. Keep every
    # secondary operation inside the original request deadline.
    local_price_cleanup: bool = False
    local_price_cache: dict = field(default_factory=dict)

    @property
    def weapon(self):
        return self.candidates[0]

    @property
    def mods(self):
        return self.candidates[2]

    def validate(self, db, weapon_id, params):
        if self.db is not db or self.weapon_id != weapon_id or self.input_key != _prepared_input_key(params):
            raise ValueError("Prepared optimizer inputs require the same session, weapon, market filters and ammo")


def prepare_optimize_weapon(db, weapon_id: str, params: OptimizeParams) -> PreparedOptimizeContext:
    """Load candidates once for a request that solves several related builds."""
    started = time.perf_counter()
    candidates = _load_candidates_and_prices(db, weapon_id, params)
    return PreparedOptimizeContext(
        db, weapon_id, _prepared_input_key(params), candidates, (time.perf_counter() - started) * 1000
    )


_RESKIN_SIGNATURE_FIELDS = (
    "attachment_category",
    "ergonomics_modifier",
    "recoil_modifier",
    "accuracy_modifier",
    "weight",
    "magazine_capacity",
    "sighting_range",
    "conflicting_item_ids",
    "conflicting_slot_ids",
    "category_ids",
    "heat_factor",
    "cooling_factor",
    "durability_burn_factor",
    "velocity_modifier",
)


def _drop_dominated_reskins(compat_map, mods, candidate_ids, prices, include, factory_ids):
    """Some items are pure cosmetic reskins of each other - identical in every
    stat and slot compatibility, just a different price (e.g. the AR-15
    Strike Industries ARE tube's plain and Anodized Red colorways). Any single
    solve can land on either one on a genuine tie in its own objective, so a
    tiebreak/cleanup pass scoped to one particular solve path can miss it -
    and did (see PRs around 2026-09-16's ARE-tube reports). Dropping the
    strictly-dominated (pricier) twin here, before any model is built, fixes
    it once for every solve path instead of chasing each one individually.

    Skips include/factory items so an explicit lock or a free preset part is
    never silently swapped out from under the user.
    """
    slots_by_item = {}
    for slot_id, items in compat_map.slot_items.items():
        for iid in items:
            slots_by_item.setdefault(iid, set()).add(slot_id)

    def owned_slots_signature(item_id):
        # A reskin can still own child slots of its own (e.g. the ARE tube's
        # sling-mount/endplate slots) - safe to dedupe as long as each of its
        # own slots accepts exactly the same items as its twin's, so nothing
        # reachable further down the tree actually differs between them.
        parts = []
        for slot_id in compat_map.item_to_slots.get(item_id, ()):
            info = compat_map.slots_by_id.get(slot_id)
            allowed = tuple(sorted(compat_map.slot_items.get(slot_id, ())))
            parts.append((getattr(info, "required", None), allowed))
        return tuple(sorted(parts))

    def signature(item_id):
        item = mods[item_id]
        return (
            tuple(getattr(item, field, None) for field in _RESKIN_SIGNATURE_FIELDS)
            + (tuple(sorted(slots_by_item.get(item_id, ()))),)
            + (owned_slots_signature(item_id),)
        )

    groups = {}
    for item_id in candidate_ids:
        if item_id in include:
            continue
        groups.setdefault(signature(item_id), []).append(item_id)

    dominated = set()
    for ids in groups.values():
        if len(ids) < 2:
            continue
        # A factory twin ships free with the gun, so it always wins the group
        # regardless of its own market price - but it's never itself dropped,
        # even in the unlikely case two same-stat items are both factory parts.
        ids.sort(key=lambda iid: (iid not in factory_ids, prices[iid]["price_rub"], iid))
        dominated.update(iid for iid in ids[1:] if iid not in factory_ids)
    return [iid for iid in candidate_ids if iid not in dominated] if dominated else candidate_ids


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
                ItemOffer.game_mode,
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
        best = get_best_price(
            raw_offers, params.trader_levels, params.flea_available, params.player_level, params.game_mode
        )
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

    candidate_ids = _drop_dominated_reskins(compat_map, mods, candidate_ids, prices, include, factory_ids)

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


def optimize_weapon(
    db, weapon_id: str, params: OptimizeParams, *, deadline=None, objective_axis=None, prepared=None
) -> dict:
    started = time.perf_counter()
    if prepared is None:
        weapon, compat_map, mods, loaded = _load_candidates_and_prices(db, weapon_id, params)
    else:
        prepared.validate(db, weapon_id, params)
        weapon, compat_map, mods, loaded = prepared.candidates
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
    if prepared is not None:
        # Expose the shared setup separately; candidate_load_ms and processing_ms
        # still measure only the work actually performed by this individual solve.
        input_metrics["candidate_prepare_ms"] = round(prepared.candidate_load_ms, 3)

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

    if prepared is not None and prepared.ammo_loaded:
        ammo, ubgl_grenade = prepared.ammo, prepared.ubgl_grenade
    else:
        ammo = (
            db.query(Item).filter(Item.id == params.selected_ammo_id).first()
            if (params.assume_full_mag and params.selected_ammo_id)
            else None
        )
        ubgl_grenade = (
            db.query(Item).filter(Item.id == params.selected_ubgl_ammo_id).first()
            if (params.assume_full_mag and params.selected_ubgl_ammo_id)
            else None
        )
        if prepared is not None:
            prepared.ammo, prepared.ubgl_grenade = ammo, ubgl_grenade
            prepared.ammo_loaded = True
    solve_options = {}
    if deadline is not None:
        solve_options["deadline"] = deadline
    if objective_axis is not None:
        solve_options["objective_axis"] = objective_axis
    if prepared is not None and prepared.local_price_cleanup:
        solve_options["local_price_cleanup"] = True
        solve_options["local_price_cache"] = prepared.local_price_cache
    result = build_and_solve(
        weapon, mods, compat_map, candidate_ids, prices, params, ammo=ammo, ubgl_grenade=ubgl_grenade, **solve_options
    )
    result["metrics"] = {**input_metrics, **result.get("metrics", {})}

    if result["status"] in ("optimal", "feasible"):
        final_stats = _compute_stats(
            weapon, result["selected_items"], mods, params.strength_level, params.equip_ergo_modifier
        )
        # Fills the solved build's magazine(s) with whatever ammo is currently selected in the
        # main builder, respecting its "assume full mag" toggle - same effect loading this
        # build into the builder would have, applied up front so the results panel already
        # shows the ammo-adjusted weight/TrueErgo/overswing/arm_stamina instead of the bare-mod
        # numbers. items_map is scoped to only the selected items (not every reachable
        # candidate) since apply_full_mag_ammo scans every entry for magazine_capacity/caliber.
        selected_mods = {item_id: mods[item_id] for item_id in result["selected_items"]}
        apply_full_mag_ammo(
            final_stats, selected_mods, ammo, ubgl_grenade, params.strength_level, params.equip_ergo_modifier
        )
        result["final_stats"] = final_stats
        result["gun_id"] = weapon_id
        # Ammo needed to fill the solved build's magazine(s), for the results panel's
        # "beneath the base receiver" line - one row of (capacity) rounds at the same
        # trader/flea-filtered price the rest of the manifest is costed at. None when no
        # ammo is assumed loaded or the build has no magazine to fill.
        result["ammo_fill"] = None
        if ammo and ammo.is_ammo:
            mag_capacity = sum((m.magazine_capacity or 0) for m in selected_mods.values() if m.magazine_capacity)
            if mag_capacity:
                result["ammo_fill"] = {
                    "item_id": ammo.id,
                    "capacity": mag_capacity,
                    "price": _load_best_offer_price(db, ammo.id, params, prepared=prepared),
                }
        # The exact price/vendor each selected item was actually costed at during
        # the solve (respects flea_available/trader_levels) - the manifest UI
        # renders from this instead of independently re-picking "cheapest overall"
        # client-side, which would ignore those same access filters.
        result["item_prices"] = {item_id: prices[item_id] for item_id in result["selected_items"]}
        # Per-item TED contribution, so the results-panel manifest can show the
        # same TED column the attachment table does. Contribution is marginal -
        # the build's TED minus what it would have without that one part - which is
        # the meaningful "how much does this part add" figure for a finished build. Applies
        # the same ammo fill to the "without" side too (recomputed per-subset, since removing
        # the magazine itself removes the ammo weight it was carrying), so ammo weight's own
        # effect on TED isn't misattributed entirely to whichever part happens to be diffed.
        result["true_ergo_contributions"] = _per_item_true_ergo_contributions(
            weapon,
            result["selected_items"],
            mods,
            final_stats["true_ergo_delta"],
            params.strength_level,
            params.equip_ergo_modifier,
            ammo,
            ubgl_grenade,
        )
        result["base"], result["grand_total_rub"] = _choose_base(
            db, weapon, params, result["selected_items"], prices, result["total_price_rub"], prepared=prepared
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


def _load_best_offer_price(db, item_id, params, *, prepared=None):
    if prepared is not None and item_id in prepared.best_offer_prices:
        return prepared.best_offer_prices[item_id]
    offers = offers_by_item(db.query(ItemOffer).filter(ItemOffer.item_id == item_id).all()).get(item_id, [])
    best = get_best_price(offers, params.trader_levels, params.flea_available, params.player_level, params.game_mode)
    if prepared is not None:
        prepared.best_offer_prices[item_id] = best
    return best


def _choose_base(db, weapon, params, selected_items, prices, mods_total_rub, *, prepared=None):
    """Decide whether it's cheaper to build up from the bare base receiver or from the
    weapon's factory preset. The preset is a separate purchasable item that bundles its
    parts, so any selected part already in the preset comes free with it. Returns
    (base_info, grand_total_rub), where base_info names the chosen base and its own
    price/vendor and grand_total_rub is the true all-in cost (base + parts bought on
    top). This is a costing decision made after the solve, so it never changes which
    parts were chosen - only how the build is acquired and priced."""
    inf = float("inf")

    receiver_best = _load_best_offer_price(db, weapon.id, params, prepared=prepared)
    receiver_price = receiver_best["price_rub"] if receiver_best else None
    receiver_total = (receiver_price if receiver_price is not None else inf) + mods_total_rub

    preset_total = inf
    preset_best = None
    if prepared is not None and prepared.preset_loaded:
        preset_id = prepared.preset_id
    else:
        row = db.query(WeaponDefaultPreset).filter(WeaponDefaultPreset.weapon_id == weapon.id).first()
        preset_id = row.preset_id if row else None
        if prepared is not None:
            prepared.preset_id = preset_id
            prepared.preset_loaded = True
    if preset_id is not None:
        preset_best = _load_best_offer_price(db, preset_id, params, prepared=prepared)
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


def _per_item_true_ergo_contributions(
    weapon, selected_ids, mods, full_true_ergo, strength_level, equip_ergo_modifier, ammo=None, ubgl_grenade=None
):
    """Marginal TrueErgoDelta each selected part contributes to the build, keyed by
    item id. Each value is full_true_ergo - TED(build without that part). _compute_stats is
    pure arithmetic over the pre-loaded items (no DB, no solve), so one pass per part
    is cheap for the handful of attachments a build has. full_true_ergo is expected to already
    include apply_full_mag_ammo's adjustment (if any); ammo/ubgl_grenade re-applies the
    same fill to each "without" subset so a non-magazine part's contribution isn't
    polluted by the full build's ammo-weight delta (removing the magazine itself still
    correctly drops the ammo weight, since the subset then has no magazine_capacity item
    left for apply_full_mag_ammo to add it to)."""
    contributions = {}
    for item_id in selected_ids:
        subset = [i for i in selected_ids if i != item_id]
        stats_without = _compute_stats(weapon, subset, mods, strength_level, equip_ergo_modifier)
        if ammo is not None or ubgl_grenade is not None:
            subset_mods = {i: mods[i] for i in subset}
            apply_full_mag_ammo(stats_without, subset_mods, ammo, ubgl_grenade, strength_level, equip_ergo_modifier)
        contributions[item_id] = round(full_true_ergo - stats_without["true_ergo_delta"], 2)
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
        game_mode=params.game_mode,
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
            game_mode=params.game_mode,
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
