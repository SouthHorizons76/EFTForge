window.EFTForge = window.EFTForge || {};

// Client-side copies of backend/stats.py's aiming formulas, for instant feedback when the
// Strength or equipment ergo settings change. Keep these in sync with stats.py by hand;
// backend/tests/data/stat_formula_golden.json checks both sides.
//
// "Effective ergo" is total ergo times (1 + equipment ergo modifier), floored at 0: the
// value the game uses for aiming. Aiming in overswings once weight * (1 - effective ergo /
// 100) passes 3 kg, so a build of W kg needs 100 * (1 - 3 / W) ergo (none at 3 kg or less).

const SWAY_START_KG = 3.0;
const SWAY_FULL_KG = 7.0;
const ARM_STAMINA_CAPACITY = 80.0;
const AIM_DRAIN_RATE = 1.1;
const STRENGTH_AIM_FATIGUE_PER_LEVEL = 0.004;

function effectiveErgo(ergo, b = 0) {
    return Math.max(0, ergo * (1 + b));
}

function swingWeight(weight, eff) {
    return weight * (1 - Math.min(Math.max(eff, 0), 100) / 100);
}

function ergoNeeded(weight) {
    return weight <= SWAY_START_KG ? 0 : 100 * (1 - SWAY_START_KG / weight);
}

/**
 * TrueErgoDelta (TED): the build's effective ergo (up to 100) less the ergo its weight
 * needs - how much ergo it could lose before aiming in overswings. Negative = already
 * overswinging. A build of 3 kg or less needs none, so its TED is its ergo.
 *
 * @param {number} totalErgo   - total ergonomics of the equipped build
 * @param {number} totalWeight - total weight (kg) of the equipped build
 * @param {number} b           - equipment ergo modifier (decimal sum from headgear/armor/rig etc.)
 */
function calcTrueErgoDelta(totalErgo, totalWeight, b = 0) {
    return Math.min(effectiveErgo(totalErgo, b), 100) - ergoNeeded(totalWeight);
}

// How hard aiming in kicks the weapon, 0 to 1: none until swing weight passes 3 kg,
// full at 7 kg.
function calcAimSway(totalErgo, totalWeight, b = 0) {
    const sw = swingWeight(totalWeight, effectiveErgo(totalErgo, b));
    return Math.min(Math.max((sw - SWAY_START_KG) / (SWAY_FULL_KG - SWAY_START_KG), 0), 1);
}

/**
 * Seconds of aiming from full arm stamina to empty: an 80 point pool drained at
 * sqrt(weight * (1 - sqrt(E) / 25)) * 1.1 per second, less 0.4% per Strength level.
 * Returns null when aiming costs nothing (a weightless build).
 */
function calcArmStamina(weight, ergo, strengthLevel, b = 0) {
    const eff = effectiveErgo(ergo, b);
    const ergoWeight = weight * (1 - Math.sqrt(eff) / 25);
    const drain = Math.sqrt(Math.max(ergoWeight, 0)) * AIM_DRAIN_RATE * (1 - strengthLevel * STRENGTH_AIM_FATIGUE_PER_LEVEL);
    return drain > 0 ? ARM_STAMINA_CAPACITY / drain : null;
}

EFTForge.calc = { calcArmStamina, calcTrueErgoDelta, calcAimSway };
