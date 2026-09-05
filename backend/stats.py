"""Build-stat aggregation shared between the Combo Calculator and the Optimizer.

Pulled out of main.py so the optimizer package can reuse the exact same
ergonomics/EED/overswing/arm-stamina/MOA math without importing main.py (which
would create a circular import, since main.py wires up the optimizer's API
routes). This must stay the single source of truth for these formulas - the
optimizer's own build results and the Combo Calculator's must always agree on
what a given attachment set's stats are.
"""


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

    b = equip_ergo_modifier
    E = total_ergo * (1 + b)
    KG = 0.0007556 * (E**2) + 0.02736 * E + 2.9159
    evo_weight = total_weight - KG
    eed = -15 * evo_weight

    arm_stamina = (
        ((85.5 / (total_weight + 0.65)) + 9.15 + 0.06477 * total_ergo * (1 + b / 2))
        / 1.04
        * (1 + strength_level * 0.004)
    )

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
        # MOA = 34.36 * COI; accuracy_modifier is a percent accuracy increase, so positive = smaller MOA
        final_moa = round(34.36 * base_coi * (1 - total_accuracy_mod / 100), 2)
    else:
        final_moa = None

    return {
        "total_ergo": round(total_ergo, 2),
        "total_weight": round(total_weight, 3),
        "overswing": evo_weight > 0,
        "evo_ergo_delta": round(eed, 2),
        "recoil_vertical": total_recoil_v,
        "recoil_horizontal": total_recoil_h,
        "arm_stamina": round(arm_stamina, 1),
        "sighting_range": effective_sighting_range,
        "accuracy_moa": final_moa,
        "heat_factor": round(heat_factor, 4),
        "cooling_factor": round(cooling_factor, 4),
        "durability_burn_factor": round(durability_burn_factor, 4),
        "velocity_modifier_pct": round(total_velocity_mod, 4),
    }


def apply_full_mag_ammo(
    stats: dict, items_map: dict, ammo, ubgl_grenade, strength_level: int, equip_ergo_modifier: float
) -> dict:
    """Applies "assume full mag" ammo effects on top of an already-computed _compute_stats()
    result: BSG hides heat/cooling/durability-burn stats on ammo's own in-game inspect
    tooltip, but the loaded round still measurably affects the weapon's heat/durability-burn
    in-game, so it's folded in here even though it's never shown on the ammo item itself.
    Also sets muzzle_velocity (None with no ammo assumed loaded, so the frontend can show
    "No Ammo"), and adds every installed magazine's (ammo.weight * magazine_capacity) plus
    one UBGL grenade's weight per installed UBGL to total_weight, then recomputes EED/
    overswing/arm_stamina against that heavier weight. Shared by /build/calculate,
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
        if ammo.heat_factor is not None:
            stats["heat_factor"] = round(stats["heat_factor"] * ammo.heat_factor, 4)
        if ammo.durability_burn_factor is not None:
            stats["durability_burn_factor"] = round(stats["durability_burn_factor"] * ammo.durability_burn_factor, 4)
        if ammo.velocity is not None:
            stats["muzzle_velocity"] = round(ammo.velocity * (1 + stats["velocity_modifier_pct"] / 100))
        for att in items_map.values():
            if att.magazine_capacity:
                stats["total_weight"] = round(stats["total_weight"] + (ammo.weight or 0) * att.magazine_capacity, 3)
        ammo_weight_added = True

    # UBGL grenade ammo weight - one round per UBGL installed. UBGLs are detected by
    # caliber-match: any non-ammo installed item whose caliber matches the selected
    # grenade ammo's caliber is the UBGL.
    if ubgl_grenade and ubgl_grenade.is_ammo and ubgl_grenade.caliber:
        ubgl_count = sum(1 for att in items_map.values() if att.caliber == ubgl_grenade.caliber and not att.is_ammo)
        if ubgl_count:
            stats["total_weight"] = round(stats["total_weight"] + (ubgl_grenade.weight or 0) * ubgl_count, 3)
            ammo_weight_added = True

    if ammo_weight_added:
        # Recompute EED, overswing, and arm stamina with the ammo-adjusted weight
        b = equip_ergo_modifier
        E = stats["total_ergo"] * (1 + b)
        KG = 0.0007556 * (E**2) + 0.02736 * E + 2.9159
        evo_weight = stats["total_weight"] - KG
        stats["evo_ergo_delta"] = round(-15 * evo_weight, 2)
        stats["overswing"] = evo_weight > 0
        stats["arm_stamina"] = round(
            ((85.5 / (stats["total_weight"] + 0.65)) + 9.15 + 0.06477 * stats["total_ergo"] * (1 + b / 2))
            / 1.04
            * (1 + strength_level * 0.004),
            1,
        )

    return stats
