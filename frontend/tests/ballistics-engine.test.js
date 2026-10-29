/* eslint-env node */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// The Python engine's own answers (backend/tests/test_ballistics_engine_golden.py writes
// them), so a drift between ballistics.py and our port fails here instead of the browser
// quietly disagreeing with the server.
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "../../backend/tests/data/ballistics_engine_golden.json"), "utf8"));
const constants = JSON.parse(fs.readFileSync(path.join(__dirname, "../../backend/spt_armor_stats.json"), "utf8"));
const source = fs.readFileSync(path.join(__dirname, "../modules/ballistics-engine.js"), "utf8");

function loadEngine() {
    const EFTForge = {};
    const ctx = vm.createContext({ window: { EFTForge }, Map, Set, Math, Date, console });
    vm.runInContext(source, ctx);
    return ctx.window.EFTForge.ballisticsEngine;
}

const engine = loadEngine();
const armorGlobals = engine.loadArmorGlobals(constants.globals);

// Kill chances sum many branches, so allow for the order they're added in
function close(actual, expected, where, tolerance) {
    if (expected === null || actual === null) {
        assert.equal(actual, expected, where);
        return;
    }
    if (Array.isArray(expected)) {
        assert.equal(actual.length, expected.length, where + " length");
        expected.forEach((value, i) => close(actual[i], value, `${where}[${i}]`, tolerance));
        return;
    }
    assert.ok(Math.abs(actual - expected) <= (tolerance || 1e-9) * Math.max(1, Math.abs(expected)), `${where}: ${actual} != ${expected}`);
}

test("simulate matches the Python engine shot by shot", () => {
    for (const c of golden.simulate) {
        const options = Object.assign({ max_shots: 30 }, c.options, { armor_globals: armorGlobals });
        const ammo = Object.assign({ penetration_deviation: 0, penetration_damage_mod: 0 }, c.ammo);
        const result = engine.simulate(ammo, c.hp, options);
        assert.equal(result.shots.length, c.shots.length, `${c.name}: shot count`);
        c.shots.forEach((expected, i) => {
            const actual = result.shots[i];
            const where = `${c.name} shot ${expected.shot}`;
            assert.equal(actual.shot, expected.shot, where);
            close(actual.kill_chance, expected.kill_chance, where + " kill_chance");
            close(actual.durability_alive, expected.durability_alive, where + " durability_alive");
            close(actual.hp_alive, expected.hp_alive, where + " hp_alive");
            close(actual.stop_chance, expected.stop_chance, where + " stop_chance");
            close(actual.penetration_chance, expected.penetration_chance, where + " penetration_chance");
            close(actual.penetration_damage, expected.penetration_damage, where + " penetration_damage");
        });
    }
});

test("spread capacity matches for every body part", () => {
    for (const [part, expected] of Object.entries(golden.spread_capacity)) {
        close(engine.spreadCapacity(part, armorGlobals.health), expected, part);
    }
});

test("flight paths match step for step", () => {
    for (const c of golden.flight) {
        const points = engine.flightPath(...c.shot, c.max_distance).filter((_, i) => i % 25 === 0);
        assert.equal(points.length, c.points.length, "point count");
        c.points.forEach((expected, i) => {
            for (const key of ["time", "distance", "drop", "speed"]) close(points[i][key], expected[key], `${c.shot} ${i} ${key}`);
        });
    }
});

test("zeroing tables match row for row", () => {
    for (const c of golden.zeroing) {
        const rows = engine.zeroingTable(c.shot, c.zero_shot, c.zero_distance, c.sight_height, c.distances);
        assert.equal(rows.length, c.rows.length, "row count");
        c.rows.forEach((expected, i) => {
            for (const key of ["distance", "impact", "correction_mrad", "speed", "time"]) close(rows[i][key], expected[key], `${c.shot} row ${i} ${key}`);
        });
    }
});

test("degradation factor matches", () => {
    for (const [ratio, expected] of golden.degradation) close(engine.degradationFactor(ratio, armorGlobals), expected, String(ratio));
});

test("pyRound rounds halves to even like Python", () => {
    assert.equal(engine.pyRound(2.5, 0), 2);
    assert.equal(engine.pyRound(3.5, 0), 4);
    assert.equal(engine.pyRound(-2.5, 0), -2);
    assert.equal(engine.pyRound(0.1234567, 6), 0.123457);
});
