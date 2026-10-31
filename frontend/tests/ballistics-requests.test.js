/* eslint-env node */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// The requests the Ballistics Workbench makes of the engine (armor simulation, caliber
// comparison, drop table) run only in the browser, so these check the layer building and
// loadout rules against a small catalog shaped like GET /armor/items and GET /ammo/all.
const constants = JSON.parse(fs.readFileSync(path.join(__dirname, "../../backend/spt_armor_stats.json"), "utf8"));
const source = fs.readFileSync(path.join(__dirname, "../modules/ballistics-engine.js"), "utf8");

function loadEngine() {
    const EFTForge = {};
    const ctx = vm.createContext({ window: { EFTForge }, Map, Set, Math, Date, console });
    vm.runInContext(source, ctx);
    return ctx.window.EFTForge.ballisticsEngine;
}

const engine = loadEngine();

const AMMO = "a".repeat(24);
const BUCKSHOT = "b".repeat(24);
const VEST = "c".repeat(24);
const PLATE = "d".repeat(24);
const HELMET = "e".repeat(24);
const SHIELD = "f".repeat(24);
const MASK = "1".repeat(24);
const OTHER_VEST = "2".repeat(24);
const GLASSES = "3".repeat(24);
const RIG = "4".repeat(24);
const EARS = "5".repeat(24);
const VISOR_MASK = "6".repeat(24);
const WEAK = "7".repeat(24);
const MANDIBLE = "8".repeat(24);

function piece(fields) {
    return { slot: null, name: null, ricochet: [null, null, null], body_colliders: [], plate_colliders: [], ...fields };
}

function armor(id, name, kind, equipmentSlot, fields = {}) {
    return {
        id, name, kind, equipment_slot: equipmentSlot, pieces: [], plate_slots: [], attachment_slots: [],
        conflicting_ids: [], blocks_headwear: false, blocks_eyewear: false, ...fields,
    };
}

function catalog() {
    const flight = { velocity: 700, bullet_mass_grams: 7.9, bullet_diameter_mm: 7.92, ballistic_coefficient: 0.367 };
    return {
        items: [
            armor(VEST, "Carrier", "armor", "armor", {
                pieces: [piece({
                    slot: "Soft_armor_front", name: "Aramid", armor_class: 2, durability: 34, material: "Aramid",
                    armor_type: "Light", blunt_throughput: 0.33, body_colliders: ["RibcageUp", "RibcageLow"],
                })],
                plate_slots: [{
                    slot: "Front_plate", plate_colliders: ["Plate_Granit_SAPI_chest"], allowed_plate_ids: [PLATE],
                    blunt_reduce_from_soft_armor: true, default_id: PLATE,
                }],
            }),
            armor(OTHER_VEST, "Other carrier", "armor", "armor"),
            armor(RIG, "Armored rig", "rig", "rig", {
                pieces: [piece({
                    slot: "Soft_armor_front", name: "Rig aramid", armor_class: 3, durability: 40, material: "Aramid",
                    armor_type: "Light", blunt_throughput: 0.3, body_colliders: ["RibcageUp"],
                })],
            }),
            armor(PLATE, "SAPI", "attachment", null, {
                pieces: [piece({
                    armor_class: 5, durability: 50, material: "Ceramic", armor_type: "Heavy", blunt_throughput: 0.3,
                    plate_colliders: ["Plate_Granit_SAPI_chest"],
                })],
            }),
            armor(HELMET, "Helmet", "helmet", "headwear", {
                pieces: [piece({
                    slot: "Helmet_top", armor_class: 4, durability: 30, material: "Aramid", armor_type: "Light",
                    blunt_throughput: 0.2, body_colliders: ["ParietalHead"],
                })],
                attachment_slots: [
                    { slot: "mod_equipment_000", allowed_ids: [SHIELD], default_id: SHIELD },
                    { slot: "mod_equipment_001", allowed_ids: [EARS], default_id: null },
                ],
            }),
            armor(SHIELD, "Shield", "attachment", null, {
                pieces: [piece({
                    armor_class: 2, durability: 30, material: "Glass", armor_type: "Light", blunt_throughput: 0.1,
                    body_colliders: ["Eyes"],
                })],
            }),
            armor(EARS, "Ear armor", "attachment", null, {
                conflicting_ids: [MASK],
                attachment_slots: [{ slot: "mod_equipment", allowed_ids: [MANDIBLE], default_id: null }],
            }),
            armor(MANDIBLE, "Mandible", "attachment", null, {
                pieces: [piece({
                    armor_class: 2, durability: 20, material: "Aramid", armor_type: "None", blunt_throughput: 0.2,
                    body_colliders: ["Jaw", "NeckFront"],
                })],
            }),
            armor(MASK, "Mask", "helmet", "face_cover", {
                pieces: [piece({
                    armor_class: 3, durability: 35, material: "UHMWPE", armor_type: "Light", blunt_throughput: 0.12,
                    body_colliders: ["Eyes", "Jaw"],
                })],
            }),
            armor(VISOR_MASK, "Visor mask", "helmet", "face_cover", { blocks_eyewear: true }),
            armor(GLASSES, "Glasses", "eyewear", "eyewear", {
                pieces: [piece({
                    armor_class: 1, durability: 25, material: "Glass", armor_type: "None", blunt_throughput: 0.9,
                    body_colliders: ["Eyes"],
                })],
            }),
        ],
        ammo: [
            { id: AMMO, name: "PS", caliber: "Caliber762x39", damage: 61, penetration_power: 35, armor_damage: 52, ...flight },
            { id: BUCKSHOT, name: "Buck", caliber: "Caliber762x39", damage: 37, penetration_power: 3, armor_damage: 26, projectile_count: 8 },
            { id: WEAK, name: "PS weak", caliber: "Caliber762x39", damage: 40, penetration_power: 10, armor_damage: 20 },
        ],
        constants,
    };
}

function request(op, payload, data = catalog()) {
    // Copied out of the engine's realm, the way the worker's reply is, so arrays compare as arrays
    return structuredClone(engine.handle(engine.createContext(data), op, payload));
}

function simulate(payload, data) {
    const reply = request("simulate", payload, data);
    assert.ok(reply.ok, `simulate failed: ${reply.status} ${JSON.stringify(reply.data)}`);
    return reply.data;
}

function rejected(payload, data) {
    const reply = request("simulate", payload, data);
    assert.equal(reply.ok, false, "expected the request to be turned down");
    return reply;
}

function itemById(data, id) {
    return data.items.find(item => item.id === id);
}

test("soft armor thorax hit", () => {
    const result = simulate({ ammo_id: AMMO, equipment: [{ item_id: VEST }], collider: "RibcageUp" });
    assert.equal(result.hp, 85);
    assert.deepEqual(result.plates, []);
    assert.deepEqual(result.soft_layers.map(layer => layer.slot), ["Soft_armor_front"]);
    const chances = result.shots.map(shot => shot.kill_chance);
    assert.deepEqual(chances, [...chances].sort((a, b) => a - b));
    assert.ok(chances[chances.length - 1] > 0.99);
    assert.notEqual(result.shots_to_kill, null);
});

test("an armored rig takes the body armor's place in a full loadout", () => {
    const result = simulate({
        ammo_id: AMMO, collider: "RibcageUp", max_shots: 3,
        equipment: [GLASSES, RIG, MASK, HELMET].map(id => ({ item_id: id })),
    });
    assert.deepEqual(result.soft_layers.map(layer => layer.armor_class), [3]);
    assert.ok(result.shots.length > 0);
});

for (const [equipment, message] of [
    [[{ item_id: VEST }, { item_id: RIG }], "can't be worn with body armor"],
    [[{ item_id: HELMET, attachments: [EARS] }, { item_id: MASK }], "conflicts with"],
    [[{ item_id: VISOR_MASK }, { item_id: GLASSES }], "can't be worn with eyewear"],
    [[{ item_id: HELMET, attachments: [SHIELD, SHIELD] }], "don't fit"],
    [[{ item_id: HELMET, attachments: [MASK] }], "don't fit"],
    // The mandible only goes on the ear armor
    [[{ item_id: HELMET, attachments: [MANDIBLE] }], "don't fit"],
]) {
    test(`loadouts the game won't allow are turned down: ${message}`, () => {
        const reply = rejected({ ammo_id: AMMO, equipment, collider: "RibcageUp" });
        assert.equal(reply.status, 422);
        assert.ok(reply.data.detail.includes(message), reply.data.detail);
    });
}

test("a helmet takes one attachment per slot", () => {
    const result = simulate({ ammo_id: AMMO, equipment: [{ item_id: HELMET, attachments: [EARS, SHIELD] }], collider: "Eyes" });
    assert.deepEqual(result.soft_layers.map(layer => layer.item_id), [SHIELD]);
});

test("an attachment takes attachments in its own slots", () => {
    const result = simulate({ ammo_id: AMMO, equipment: [{ item_id: HELMET, attachments: [MANDIBLE, EARS] }], collider: "Jaw" });
    assert.deepEqual(result.soft_layers.map(layer => layer.item_id), [MANDIBLE]);
});

test("durability percent scales every piece", () => {
    const result = simulate({ ammo_id: AMMO, equipment: [{ item_id: VEST, durability_percent: 50 }], collider: "RibcageUp" });
    assert.equal(result.soft_layers[0].durability, 17);
});

for (const [pieces, expected] of [[{ Soft_armor_front: 25 }, 8.5], [{ Soft_armor_back: 25 }, 17]]) {
    test(`an insert's own durability overrides the item's percent: ${JSON.stringify(pieces)}`, () => {
        const result = simulate({
            ammo_id: AMMO, collider: "RibcageUp",
            equipment: [{ item_id: VEST, durability_percent: 50, piece_durability: pieces }],
        });
        assert.equal(result.soft_layers[0].durability, expected);
    });
}

test("an insert's own durability stays on that insert", () => {
    // Two inserts of one vest over the same spot: the override on the first leaves the second on the item's percent
    const data = catalog();
    itemById(data, VEST).pieces.push(piece({
        slot: "Collar", name: "Collar", armor_class: 2, durability: 20, material: "Aramid",
        armor_type: "Light", blunt_throughput: 0.33, body_colliders: ["RibcageUp"],
    }));
    const result = simulate({
        ammo_id: AMMO, collider: "RibcageUp",
        equipment: [{ item_id: VEST, durability_percent: 50, piece_durability: { Soft_armor_front: 25 } }],
    }, data);
    assert.deepEqual(result.soft_layers.map(layer => layer.durability), [8.5, 10]);
});

test("a helmet attachment has its own durability", () => {
    const result = simulate({
        ammo_id: AMMO, collider: "Eyes",
        equipment: [{ item_id: HELMET, durability_percent: 100, attachments: [SHIELD], attachment_durability: { [SHIELD]: 50 } }],
    });
    const layer = result.soft_layers[0];
    assert.equal(layer.item_id, SHIELD);
    assert.equal(layer.durability, layer.max_durability / 2);
});

test("headwear and its attachments come before the face cover, then eyewear", () => {
    // Listed in the wrong order on purpose
    const result = simulate({
        ammo_id: AMMO, collider: "Eyes",
        equipment: [{ item_id: GLASSES }, { item_id: MASK }, { item_id: HELMET, attachments: [SHIELD] }],
    });
    assert.equal(result.hp, 35);
    assert.deepEqual(result.soft_layers.map(layer => layer.item_id), [SHIELD, MASK, GLASSES]);
});

test("a plate hit puts the plate first and its slot's blunt flag counts", () => {
    const payload = {
        ammo_id: AMMO, collider: "RibcageUp", plate_collider: "Plate_Granit_SAPI_chest",
        equipment: [{ item_id: VEST, plates: { Front_plate: { item_id: PLATE } } }],
    };
    const result = simulate(payload);
    assert.equal(result.body_part, "Chest");
    assert.deepEqual(result.plates.map(layer => layer.item_id), [PLATE]);
    assert.deepEqual(result.soft_layers.map(layer => layer.slot), ["Soft_armor_front"]);

    // The plate stops most of these rounds, so softening its blunt damage changes the kill chances
    const unflagged = catalog();
    itemById(unflagged, VEST).plate_slots[0].blunt_reduce_from_soft_armor = false;
    const plain = simulate(payload, unflagged);
    assert.notDeepEqual(plain.shots.map(shot => shot.kill_chance), result.shots.map(shot => shot.kill_chance));
});

for (const [body, status] of [
    [{ ammo_id: "0".repeat(24) }, 404],
    [{ hp: 50, collider: "Eyes" }, 422], // more than a head's 35
    [{ plate_collider: "Plate_Granit_SAPI_back" }, 422], // the back plate isn't in front of the chest
    [{ plate_collider: "Plate_Nonexistent" }, 422],
    [{ equipment: [{ item_id: VEST }, { item_id: OTHER_VEST }] }, 422],
    [{ equipment: [{ item_id: PLATE }] }, 422],
    [{ equipment: [{ item_id: VEST, attachments: [SHIELD] }] }, 422],
    [{ equipment: [{ item_id: VEST, plates: { Back_plate: { item_id: PLATE } } }] }, 422],
    [{ equipment: [{ item_id: "9".repeat(24) }] }, 404],
]) {
    test(`bad requests are turned down: ${JSON.stringify(body)}`, () => {
        assert.equal(rejected({ ammo_id: AMMO, equipment: [], collider: "RibcageUp", ...body }).status, status);
    });
}

test("distance flies the bullet and weakens the hit", () => {
    const base = { ammo_id: AMMO, equipment: [{ item_id: VEST }], collider: "RibcageUp" };
    const close = simulate(base);
    const far = simulate({ ...base, distance: 300, velocity_modifier_pct: 1.8 });
    assert.equal(close.flight, null);
    assert.ok(Math.abs(far.flight.muzzle_speed - 712.6) < 1e-9);
    assert.ok(far.flight.speed_ratio > 0 && far.flight.speed_ratio < 1);
    assert.ok(far.flight.drop > 0);
    // Slower on arrival means less damage, so no shot kills more often from range
    close.shots.forEach((near, i) => {
        if (far.shots[i]) assert.ok(far.shots[i].kill_chance <= near.kill_chance + 1e-9);
    });
});

test("distance needs flight data and rules out a speed ratio", () => {
    const base = { equipment: [], collider: "RibcageUp" };
    assert.equal(rejected({ ...base, ammo_id: AMMO, distance: 100, speed_ratio: 0.8 }).status, 422);
    const data = catalog();
    data.ammo.find(ammo => ammo.id === AMMO).ballistic_coefficient = null;
    assert.equal(rejected({ ...base, ammo_id: AMMO, distance: 100 }, data).status, 422);
});

test("buckshot fires every pellet and caps the shots", () => {
    const result = simulate({ ammo_id: BUCKSHOT, equipment: [{ item_id: VEST }], collider: "RibcageUp", max_shots: 40, hp: 85 });
    assert.equal(result.projectiles, 8);
    // 320 pellet hits at most, so 8 pellets allow 40 shots at most
    assert.ok(result.shots.length <= 40);
});

test("neck hits drain the thorax", () => {
    const result = simulate({ ammo_id: AMMO, equipment: [], collider: "NeckFront" });
    assert.deepEqual([result.body_part, result.hp], ["Chest", 85]);
});

test("stomach hits spread until the thorax goes", () => {
    const result = simulate({ ammo_id: AMMO, equipment: [], collider: "RibcageLow" });
    assert.equal(result.body_part, "Stomach");
    assert.equal(result.hp, 70);
    assert.ok(Math.abs(result.spread_hp - 352.38) < 0.01);
    // 61 damage a shot through a 422 HP pool: the 7th shot kills
    assert.equal(result.shots_to_kill, 7);
});

test("an angle changes nothing on armor without ricochet values", () => {
    const base = { ammo_id: AMMO, equipment: [{ item_id: HELMET }], collider: "ParietalHead" };
    const straight = simulate(base);
    const angled = simulate({ ...base, angle: 80 });
    assert.deepEqual(angled.shots.map(s => s.kill_chance), straight.shots.map(s => s.kill_chance));
});

test("compare ranks every round in the caliber", () => {
    const reply = request("compare", { ammo_id: AMMO, equipment: [{ item_id: VEST }], collider: "RibcageUp" });
    assert.ok(reply.ok);
    const rows = Object.fromEntries(reply.data.ammo.map(row => [row.ammo_id, row]));
    assert.deepEqual(Object.keys(rows).sort(), [AMMO, BUCKSHOT, WEAK].sort());
    assert.ok(rows[AMMO].shots_to_kill_50 <= rows[WEAK].shots_to_kill_50);
    assert.equal(rows[BUCKSHOT].projectiles, 8);
});

/* Drop table */

const FAST = "a".repeat(24);
const SLOW = "b".repeat(24);
const NO_FLIGHT = "c".repeat(24);
const OTHER_CALIBER = "e".repeat(24);

function flightCatalog() {
    const flight = { bullet_mass_grams: 4, bullet_diameter_mm: 5.7, ballistic_coefficient: 0.233 };
    return {
        items: [],
        ammo: [
            { id: FAST, name: "Fast", caliber: "556", velocity: 945, damage: 49, penetration_power: 44, ...flight },
            { id: SLOW, name: "Slow", caliber: "556", velocity: 850, damage: 50, penetration_power: 30, ...flight },
            { id: NO_FLIGHT, name: "Odd", velocity: null, damage: 10, penetration_power: 1 },
            { id: OTHER_CALIBER, name: "Other", caliber: "762", velocity: 850, damage: 50, ...flight },
        ],
        constants,
    };
}

function table(payload) {
    const reply = request("flight", payload, flightCatalog());
    assert.ok(reply.ok, `flight failed: ${reply.status} ${JSON.stringify(reply.data)}`);
    return reply.data;
}

function byDistance(rows) {
    return Object.fromEntries(rows.map(row => [row.distance, row]));
}

test("the loaded round zeroes itself by default", () => {
    const result = table({ ammo_id: FAST, zero_distance: 100, max_distance: 300, step: 50 });
    const rows = byDistance(result.rows);
    assert.equal(result.zero_ammo_id, FAST);
    assert.ok(Math.abs(rows[100].impact_cm) < 1e-4);
    assert.ok(Math.abs(rows[0].impact_cm + 5) < 1e-9);
    // Slower on arrival means less damage and pen left
    assert.ok(rows[300].damage < rows[0].damage);
    assert.ok(rows[300].penetration < rows[0].penetration);
});

test("a weapon's default ammo sets the zero", () => {
    const result = table({ ammo_id: FAST, zero_ammo_id: SLOW, zero_distance: 100, max_distance: 100, step: 50 });
    assert.equal(result.zero_ammo_id, SLOW);
    assert.ok(byDistance(result.rows)[100].impact_cm > 0);
});

test("ammo without flight data is turned down", () => {
    assert.equal(request("flight", { ammo_id: NO_FLIGHT }, flightCatalog()).status, 422);
});

test("compared rounds of the same caliber share the zero", () => {
    // The loaded round itself and a round we can't fly both drop out
    assert.deepEqual(table({ ammo_id: FAST, compare_ammo_ids: [FAST, NO_FLIGHT] }).compare, []);
    const result = table({ ammo_id: FAST, compare_ammo_ids: [SLOW], zero_distance: 100, max_distance: 200, step: 100 });
    assert.deepEqual(result.compare.map(entry => entry.ammo_id), [SLOW]);
    // Zeroed for the faster round, the slower one lands low at the zero
    assert.ok(byDistance(result.compare[0].rows)[100].impact_cm < 0);
    assert.equal(result.compare[0].muzzle_speed, 850);
});

test("a round of another caliber zeroes with itself", () => {
    const result = table({ ammo_id: FAST, zero_ammo_id: SLOW, compare_ammo_ids: [SLOW, OTHER_CALIBER], max_distance: 100, step: 50 });
    const compared = Object.fromEntries(result.compare.map(entry => [entry.ammo_id, entry]));
    assert.equal(compared[SLOW].zero_ammo_id, SLOW);
    assert.equal(compared[OTHER_CALIBER].zero_ammo_id, OTHER_CALIBER);
    // Zeroed with itself, it crosses the sight line right at the zero
    assert.ok(Math.abs(byDistance(compared[OTHER_CALIBER].rows)[100].impact_cm) < 1e-4);
});

/* Stopping a request on the page's worker */

// The page side of the engine with a stand-in Worker that records what it's sent
function loadPage() {
    const workers = [];
    class FakeWorker {
        constructor() { this.posted = []; this.terminated = false; workers.push(this); }
        postMessage(message) { this.posted.push(message); }
        terminate() { this.terminated = true; }
    }
    const fetch = async () => ({ ok: true, json: async () => constants });
    const window = { EFTForge: { config: { API_BASE: "" } } };
    vm.runInContext(source, vm.createContext({ window, Map, Set, Math, Date, console, Worker: FakeWorker, fetch }));
    return { local: window.EFTForge.ballisticsLocal, workers };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const requestsSent = worker => worker.posted.filter(message => message.op).map(message => [message.id, message.op]);

test("stopping the running request hands what waits behind it to a fresh worker", async () => {
    const { local, workers } = loadPage();
    const data = catalog();
    const stop = new AbortController();
    const run = local.simulate({ ammo_id: AMMO }, data, null, stop.signal);
    const table = local.flight({ ammo_id: AMMO }, data);
    await settle();
    assert.deepEqual(requestsSent(workers[0]), [[1, "simulate"], [2, "flight"]]);

    stop.abort();
    assert.equal((await run).cancelled, true);
    assert.equal(workers[0].terminated, true);
    assert.equal(workers.length, 2);
    // The fresh worker gets the data again, then only the request still wanted
    assert.equal(workers[1].posted[0].type, "data");
    assert.deepEqual(requestsSent(workers[1]), [[2, "flight"]]);

    workers[1].onmessage({ data: { id: 2, reply: { ok: true, status: 200, data: "table" } } });
    assert.equal((await table).data, "table");
});

test("stopping a request that's still waiting leaves the running one alone", async () => {
    const { local, workers } = loadPage();
    const data = catalog();
    const stop = new AbortController();
    const run = local.simulate({ ammo_id: AMMO }, data);
    const waiting = local.compare({ ammo_id: AMMO }, data, stop.signal);
    await settle();

    stop.abort();
    assert.equal((await waiting).cancelled, true);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].terminated, false);

    workers[0].onmessage({ data: { id: 1, reply: { ok: true, status: 200, data: "result" } } });
    assert.equal((await run).data, "result");
    // The worker's late answer for the dropped one goes nowhere
    workers[0].onmessage({ data: { id: 2, reply: { ok: true, status: 200, data: "late" } } });
});
