/* eslint-env node */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Same vectors backend/tests/test_calculations.py checks stats.py::_calc_aiming_stats
// against - a drift between the Python and JS copies of the aiming formulas shows up as
// a failure here or there instead of a silent client/server stat mismatch.
const goldenPath = path.join(__dirname, "../../backend/tests/data/stat_formula_golden.json");
const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));

const source = fs.readFileSync(path.join(__dirname, "../modules/calculations.js"), "utf8");

function loadCalc() {
    const EFTForge = {};
    const ctx = vm.createContext({ window: { EFTForge }, EFTForge });
    vm.runInContext(source, ctx);
    return ctx.EFTForge.calc;
}

test("calcTrueErgoDelta matches the shared golden vectors", () => {
    const { calcTrueErgoDelta } = loadCalc();
    for (const c of golden.cases) {
        const te = calcTrueErgoDelta(c.total_ergo, c.total_weight, c.equip_ergo_modifier);
        assert.ok(
            Math.abs(te - c.expected_true_ergo_delta) < 0.0001,
            `calcTrueErgoDelta(${c.total_ergo}, ${c.total_weight}, ${c.equip_ergo_modifier}) = ${te}, expected ${c.expected_true_ergo_delta}`
        );
        assert.equal(te < 0, c.expected_overswing, `overswing mismatch for ${JSON.stringify(c)}`);
    }
});

test("calcArmStamina matches the shared golden vectors", () => {
    const { calcArmStamina } = loadCalc();
    for (const c of golden.cases) {
        const stamina = calcArmStamina(c.total_weight, c.total_ergo, c.strength_level, c.equip_ergo_modifier);
        if (c.expected_arm_stamina === null) {
            assert.equal(stamina, null, `calcArmStamina(${c.total_weight}, ${c.total_ergo}) should drain nothing`);
            continue;
        }
        assert.ok(
            Math.abs(stamina - c.expected_arm_stamina) < 0.01,
            `calcArmStamina(${c.total_weight}, ${c.total_ergo}, ${c.strength_level}, ${c.equip_ergo_modifier}) = ${stamina}, expected ${c.expected_arm_stamina}`
        );
    }
});

test("calcAimSway matches the shared golden vectors", () => {
    const { calcAimSway } = loadCalc();
    for (const c of golden.cases) {
        const sway = calcAimSway(c.total_ergo, c.total_weight, c.equip_ergo_modifier);
        assert.ok(
            Math.abs(sway - c.expected_aim_sway) < 0.0001,
            `calcAimSway(${c.total_ergo}, ${c.total_weight}, ${c.equip_ergo_modifier}) = ${sway}, expected ${c.expected_aim_sway}`
        );
        assert.equal(sway > 0, c.expected_overswing, `overswing mismatch for ${JSON.stringify(c)}`);
    }
});
