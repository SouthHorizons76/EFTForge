"""Build-stat aggregation shared between the Combo Calculator and the Optimizer.

Pulled out of main.py so the optimizer package can reuse the exact same
ergonomics/TrueErgoDelta/overswing/arm-stamina/MOA math without importing main.py
(which would create a circular import, since main.py wires up the optimizer's API
routes). This must stay the single source of truth for these formulas - the
optimizer's own build results and the Combo Calculator's must always agree on
what a given attachment set's stats are.

Every formula here reproduces the game exactly. "Effective ergo" is the build's total
ergo times (1 + equipment ergo modifier), floored at 0, the value the game uses for
aiming.
"""

import math

# Overswing: aiming in kicks the weapon once weight * (1 - effective ergo / 100) passes
# SWAY_START_KG, and the kick reaches full strength at SWAY_FULL_KG. So a build of W kg
# needs 100 * (1 - 3 / W) effective ergo to stay clear (none at 3 kg or less).
SWAY_START_KG = 3.0
SWAY_FULL_KG = 7.0
# Ergo past 100 does nothing for overswing. The optimizer's tangent cuts run up to this
# much effective ergo, where the weight limit is already 300 kg.
OVERSWING_ERGO_CAP = 99.0

# Arm stamina: an 80 point pool that drains while aiming at
# sqrt(weight * (1 - sqrt(effective ergo) / 25)) * 1.1 points per second, less 0.4% per
# Strength level (standing, full hydration).
ARM_STAMINA_CAPACITY = 80.0
AIM_DRAIN_RATE = 1.1
STRENGTH_AIM_FATIGUE_PER_LEVEL = 0.004

# accuracy_moa formula: MOA = MOA_K * COI * (1 - total_accuracy_mod / 100) * ammo factor,
# for a barrel at full durability.
MOA_K = 100 / 2.9089


def effective_ergo(total_ergo: float, equip_ergo_modifier: float) -> float:
    return max(0.0, total_ergo * (1 + equip_ergo_modifier))


def ergo_needed(total_weight: float) -> float:
    """The effective ergo a build of this weight needs to keep aiming in from overswinging."""
    if total_weight <= SWAY_START_KG:
        return 0.0
    return 100 * (1 - SWAY_START_KG / total_weight)


def true_ergo_delta(total_weight: float, eff_ergo: float) -> float:
    """TrueErgoDelta (TED): the build's effective ergo (up to 100) less the ergo its weight
    needs - how much ergo it could lose before aiming in overswings. Negative = already
    overswinging. A build of 3 kg or less needs none, so its TED is its ergo."""
    return min(max(eff_ergo, 0.0), 100.0) - ergo_needed(total_weight)


def overswing_limit_kg(eff_ergo: float, margin: float = 0.0) -> float:
    """The heaviest build with at least `margin` TED at this effective ergo:
    300 / (100 + margin - E). Only meaningful where E >= margin (below that no weight
    reaches the margin; the optimizer floors ergo separately for that)."""
    den = 100 + margin - min(max(eff_ergo, 0.0), OVERSWING_ERGO_CAP)
    return 100 * SWAY_START_KG / den if den > 0 else 1e6


def overswing_limit_slope(eff_ergo: float, margin: float = 0.0) -> float:
    """d(overswing_limit_kg)/d(effective ergo): 0 outside the uncapped range."""
    if eff_ergo < 0 or eff_ergo >= OVERSWING_ERGO_CAP:
        return 0.0
    den = 100 + margin - eff_ergo
    return 100 * SWAY_START_KG / den**2 if den > 0 else 0.0


def ted_cost_per_kg(total_weight: float) -> float:
    """How many TED points one more kilogram costs around a build of this weight:
    300 / W^2 above 3 kg, nothing below (those builds can't overswing)."""
    return 100 * SWAY_START_KG / total_weight**2 if total_weight > SWAY_START_KG else 0.0


def aim_sway_strength(total_weight: float, eff_ergo: float) -> float:
    """How hard aiming in kicks the weapon, 0 (none) to 1 (full)."""
    swing = total_weight * (1 - min(max(eff_ergo, 0.0), 100.0) / 100)
    return min(max((swing - SWAY_START_KG) / (SWAY_FULL_KG - SWAY_START_KG), 0.0), 1.0)


def arm_stamina_seconds(total_weight: float, eff_ergo: float, strength_level: int):
    """Seconds of aiming from full arm stamina to empty, or None when aiming costs
    nothing (a weightless build)."""
    ergo_weight = total_weight * (1 - math.sqrt(eff_ergo) / 25)
    drain = math.sqrt(max(ergo_weight, 0.0)) * AIM_DRAIN_RATE * (1 - strength_level * STRENGTH_AIM_FATIGUE_PER_LEVEL)
    return ARM_STAMINA_CAPACITY / drain if drain > 0 else None


def ammo_accuracy_factor(ammo) -> float:
    """The loaded round's multiplier on MOA: an accuracy bonus of a percent divides
    by (1 + a / 100), a penalty multiplies by (1 + |a| / 100)."""
    acc = (getattr(ammo, "ammo_accuracy_modifier", None) or 0) if ammo is not None else 0
    return (100 + abs(acc)) / 100 if acc <= 0 else 100 / (100 + acc)


def _calc_aiming_stats(total_ergo: float, total_weight: float, strength_level: int, equip_ergo_modifier: float):
    """TrueErgoDelta, overswing, arm stamina and aim sway strength for a build.
    This is the canonical Python copy - frontend/modules/calculations.js keeps a
    hand-synced copy for instant client-side feedback (see AGENTS.md), and
    backend/tests/test_calculations.py checks both against the same golden vectors so a
    drift between the two shows up as a test failure instead of a silent stat mismatch.
    """
    eff = effective_ergo(total_ergo, equip_ergo_modifier)
    ted = true_ergo_delta(total_weight, eff)
    return {
        "true_ergo_delta": ted,
        "overswing": ted < 0,
        "arm_stamina": arm_stamina_seconds(total_weight, eff, strength_level),
        "aim_sway": aim_sway_strength(total_weight, eff),
    }


def _aiming_fields(total_ergo, total_weight, strength_level, equip_ergo_modifier) -> dict:
    """_calc_aiming_stats as the rounded fields every stats dict carries."""
    a = _calc_aiming_stats(total_ergo, total_weight, strength_level, equip_ergo_modifier)
    return {
        "true_ergo_delta": round(a["true_ergo_delta"], 2),
        "overswing": a["overswing"],
        "arm_stamina": round(a["arm_stamina"], 1) if a["arm_stamina"] is not None else None,
        "aim_sway": round(a["aim_sway"] * 100, 1),
    }


def _compute_stats(
    base_item, current_ids: list, items_map: dict, strength_level: int = 10, equip_ergo_modifier: float = 0.0
) -> dict:
    """Compute build stats from pre-loaded items. No DB queries."""
    factory_ids = base_item.factory_attachment_ids.split(",") if base_item.factory_attachment_ids else []
    factory_set = set(factory_ids)
    current_set = set(current_ids)
    factory_intact = bool(factory_set) and factory_set.issubset(current_set)

    receiver_ergo = base_item.base_ergonomics or 0
    receiver_weight = base_item.weight or 0
    factory_ergo = base_item.factory_ergonomics or receiver_ergo
    factory_weight = base_item.factory_weight or receiver_weight

    if factory_intact:
        total_ergo = factory_ergo
        total_weight = factory_weight
        total_recoil_v = (
            base_item.factory_recoil_vertical
            if base_item.factory_recoil_vertical is not None
            else base_item.recoil_vertical
        )
        total_recoil_h = (
            base_item.factory_recoil_horizontal
            if base_item.factory_recoil_horizontal is not None
            else base_item.recoil_horizontal
        )
    else:
        total_ergo = receiver_ergo
        total_weight = receiver_weight
        total_recoil_v = base_item.recoil_vertical
        total_recoil_h = base_item.recoil_horizontal

    total_recoil_modifier = 0.0
    total_accuracy_mod = 0.0
    total_velocity_mod = base_item.velocity_modifier or 0
    barrel_coi = None  # installed barrel's centerOfImpact overrides the weapon base
    heat_factor = 1.0
    cooling_factor = 1.0
    durability_burn_factor = 1.0
    for att_id in current_ids:
        att = items_map.get(att_id)
        if not att:
            continue
        is_factory_att = att_id in factory_set
        # Ergo/weight/recoil: skip factory attachments when factory_intact (pre-computed values used above)
        if not (factory_intact and is_factory_att):
            total_ergo += att.ergonomics_modifier or 0
            total_weight += att.weight or 0
            total_recoil_modifier += att.recoil_modifier or 0
        # Accuracy: always process all installed attachments - there is no pre-computed factory accuracy value
        if not att.is_weapon and att.center_of_impact is not None:
            barrel_coi = att.center_of_impact
        else:
            total_accuracy_mod += att.accuracy_modifier or 0
        # Muzzle velocity: summed percentage modifier (barrel + muzzle devices); applied to
        # the loaded ammo's velocity, not overridden like accuracy's COI
        total_velocity_mod += att.velocity_modifier or 0
        # Heat/cooling/durability-burn are multipliers (not summed percentages) - default 1.0 for parts without the stat
        if att.heat_factor is not None:
            heat_factor *= att.heat_factor
        if att.cooling_factor is not None:
            cooling_factor *= att.cooling_factor
        if att.durability_burn_factor is not None:
            durability_burn_factor *= att.durability_burn_factor

    if not factory_intact:
        if total_recoil_v is not None:
            total_recoil_v = round(total_recoil_v * (1 + total_recoil_modifier))
        if total_recoil_h is not None:
            total_recoil_h = round(total_recoil_h * (1 + total_recoil_modifier))

    # Effective sighting range: max scope sighting range installed, else weapon base
    effective_sighting_range = base_item.sighting_range
    for att_id in current_ids:
        att = items_map.get(att_id)
        if att and att.sighting_range is not None and att.sighting_range > 0:
            if effective_sighting_range is None or att.sighting_range > effective_sighting_range:
                effective_sighting_range = att.sighting_range

    # Accuracy (MOA): barrel COI overrides weapon base; percentage mods apply on top
    # barrel_coi takes priority over weapon's center_of_impact when a barrel is installed
    base_coi = barrel_coi if barrel_coi is not None else base_item.center_of_impact
    if base_coi is not None:
        # accuracy_modifier is a percent accuracy increase, so positive = smaller MOA
        final_moa = MOA_K * base_coi * (1 - total_accuracy_mod / 100)
    else:
        final_moa = None

    return {
        "total_ergo": round(total_ergo, 2),
        "total_weight": round(total_weight, 3),
        "recoil_vertical": total_recoil_v,
        "recoil_horizontal": total_recoil_h,
        **_aiming_fields(total_ergo, total_weight, strength_level, equip_ergo_modifier),
        "sighting_range": effective_sighting_range,
        "accuracy_moa": round(final_moa, 2) if final_moa is not None else None,
        "heat_factor": round(heat_factor, 4),
        "cooling_factor": round(cooling_factor, 4),
        "durability_burn_factor": round(durability_burn_factor, 4),
        "velocity_modifier_pct": round(total_velocity_mod, 4),
    }


def full_mag_ammo_weight(item, ammo=None, ubgl_grenade=None) -> float:
    """Ammo carried by one installed item; selected ammo is fixed by the caller."""
    weight = 0.0
    if ammo and ammo.is_ammo and item.magazine_capacity:
        weight += (ammo.weight or 0) * item.magazine_capacity
    if ubgl_grenade and ubgl_grenade.is_ammo and ubgl_grenade.caliber:
        if item.caliber == ubgl_grenade.caliber and not item.is_ammo:
            weight += ubgl_grenade.weight or 0
    return weight


def apply_full_mag_ammo(
    stats: dict, items_map: dict, ammo, ubgl_grenade, strength_level: int, equip_ergo_modifier: float
) -> dict:
    """Applies "assume full mag" ammo effects on top of an already-computed _compute_stats()
    result: BSG hides heat/cooling/durability-burn stats on ammo's own in-game inspect
    tooltip, but the loaded round still measurably affects the weapon's heat/durability-burn
    in-game, so it's folded in here even though it's never shown on the ammo item itself.
    Also sets muzzle_velocity (None with no ammo assumed loaded, so the frontend can show
    "No Ammo"), and adds every installed magazine's (ammo.weight * magazine_capacity) plus
    one UBGL grenade's weight per installed UBGL to total_weight, then recomputes TrueErgoDelta/
    overswing/arm_stamina against that heavier weight. The loaded round's accuracy
    also scales accuracy_moa. Shared by /build/calculate,
    /guns/{id}/init, and the optimizer's post-solve final_stats - all three must agree on
    what a loaded magazine does to a build's stats. items_map only needs to cover the
    build's own installed/selected items (unselected candidates must not be passed in,
    since every item in it is scanned for magazine_capacity/caliber). ammo/ubgl_grenade are
    the already-gated (assume_full_mag on, an id was actually selected) Item rows to apply,
    or None to skip that part - the caller owns that gating and the DB lookup. Mutates and
    returns stats.
    """
    ammo_weight_added = False
    stats["muzzle_velocity"] = None

    if ammo and ammo.is_ammo:
        # The loaded round's accuracy scales the weapon's MOA too.
        if stats.get("accuracy_moa") is not None:
            stats["accuracy_moa"] = round(stats["accuracy_moa"] * ammo_accuracy_factor(ammo), 2)
        if ammo.heat_factor is not None:
            stats["heat_factor"] = round(stats["heat_factor"] * ammo.heat_factor, 4)
        if ammo.durability_burn_factor is not None:
            stats["durability_burn_factor"] = round(stats["durability_burn_factor"] * ammo.durability_burn_factor, 4)
        if ammo.velocity is not None:
            stats["muzzle_velocity"] = round(ammo.velocity * (1 + stats["velocity_modifier_pct"] / 100))
        for att in items_map.values():
            if att.magazine_capacity:
                stats["total_weight"] = round(stats["total_weight"] + full_mag_ammo_weight(att, ammo), 3)
        ammo_weight_added = True

    # UBGL grenade ammo weight - one round per UBGL installed. UBGLs are detected by
    # caliber-match: any non-ammo installed item whose caliber matches the selected
    # grenade ammo's caliber is the UBGL.
    if ubgl_grenade and ubgl_grenade.is_ammo and ubgl_grenade.caliber:
        grenade_weight = sum(full_mag_ammo_weight(att, ubgl_grenade=ubgl_grenade) for att in items_map.values())
        if grenade_weight:
            stats["total_weight"] = round(stats["total_weight"] + grenade_weight, 3)
            ammo_weight_added = True

    if ammo_weight_added:
        # Recompute TrueErgoDelta, overswing and arm stamina with the ammo-adjusted weight
        stats.update(_aiming_fields(stats["total_ergo"], stats["total_weight"], strength_level, equip_ergo_modifier))

    return stats
