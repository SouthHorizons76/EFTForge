/* eslint-env node */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../modules/attachment-layout.js"), "utf8");

function engine() {
    const EFTForge = {};
    const context = vm.createContext({ window: { EFTForge }, EFTForge });
    vm.runInContext(source, context);
    return EFTForge.attachmentLayout;
}

function slot(id, role, parentId = null, order = id) {
    return { id, role, parentId, order };
}

function port(id, role, parentId, mount, order = id) {
    return { ...slot(id, role, parentId, order), mount };
}

function assertCompleteLayout(entries, layout) {
    assert.equal(layout.positions.size, entries.length);
    assert.equal(layout.gunCol, 7);
    assert.equal(layout.gunSpan, 3);
    assert.equal(layout.totalCols, 10);
    const occupied = new Set();
    for (let col = layout.gunCol; col < layout.gunCol + layout.gunSpan; col++) {
        occupied.add(`${col},${layout.gunRow}`);
    }
    for (const { id } of entries) {
        const position = layout.positions.get(id);
        assert.ok(position, `Keep ${id} visible`);
        assert.equal(position.extras, false);
        assert.ok(Number.isInteger(position.col) && Number.isInteger(position.row));
        assert.ok(position.col >= 1 && position.col <= layout.totalCols);
        assert.ok(position.row >= 1 && position.row <= layout.totalRows);
        const key = `${position.col},${position.row}`;
        assert.ok(!occupied.has(key), `Reserve a separate cell for ${id} at ${key}`);
        occupied.add(key);
    }
    assert.ok(layout.gunCol >= 1 && layout.gunCol + layout.gunSpan - 1 <= layout.totalCols);
    assert.ok(layout.gunRow >= 1 && layout.gunRow <= layout.totalRows);
}

function coordinates(layout) {
    return Array.from(layout.positions, ([id, position]) => [id, position.col, position.row])
        .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}

function offset(layout, id, ownerId) {
    const position = layout.positions.get(id);
    const owner = ownerId === null
        ? { col: layout.gunCol, row: layout.gunRow }
        : layout.positions.get(ownerId);
    return [position.col - owner.col, position.row - owner.row];
}

function assertAt(layout, id, col, vrow) {
    const position = layout.positions.get(id);
    assert.ok(position, `Place ${id}`);
    assert.deepEqual([position.col, position.row - layout.gunRow], [col, vrow], id);
}

function assertContinuation(layout, id, ownerId, direction) {
    const relative = offset(layout, id, ownerId);
    assert.equal(relative[0], 0, `Keep ${id} in its owner's column`);
    assert.ok(relative[1] * direction > 0, `Continue ${id} in its owner's direction`);
}

test("reserve the complete weapon footprint even without attachments", () => {
    const layout = engine().compute([]);
    assertCompleteLayout([], layout);
    assert.equal(layout.gunRow, 1);
    assert.equal(layout.totalRows, 1);
});

test("reserve the familiar weapon anchors before placing accessory branches", () => {
    const entries = [
        slot("receiver", "receiver"),
        slot("barrel", "barrel"),
        slot("muzzle", "muzzle", "barrel"),
        slot("stock", "stock"),
        slot("scope", "scope"),
        slot("magazine", "magazine"),
        slot("grip", "pistol_grip"),
        slot("charge", "charge"),
        slot("rear", "rear_sight"),
        slot("front", "front_sight"),
        slot("foregrip", "foregrip"),
    ];
    const layout = engine().compute(entries);
    assertCompleteLayout(entries, layout);
    for (const [id, col, vrow] of [
        ["receiver", 6, 0], ["barrel", 5, 0], ["muzzle", 4, 0],
        ["stock", 10, 0], ["scope", 8, -1], ["magazine", 8, 1],
        ["grip", 9, 1], ["charge", 10, -1], ["rear", 9, -1],
        ["front", 4, -1], ["foregrip", 7, 1],
    ]) assertAt(layout, id, col, vrow);
});

test("duplicate body slots continue below their role's column without expanding the body queue", () => {
    const roles = ["receiver", "handguard", "catch", "barrel", "gas_block", "muzzle"];
    const entries = roles.map(role => slot(role, role, null, "00"));
    entries.push(
        slot("barrel/continuation", "barrel", "barrel"),
        slot("second-barrel", "barrel", null, "99"),
        slot("muzzle/adapter", "muzzle", "muzzle"),
        slot("muzzle/adapter/suppressor", "muzzle", "muzzle/adapter")
    );
    const layout = engine().compute(entries);
    assertCompleteLayout(entries, layout);
    roles.forEach((role, index) => assertAt(layout, role, 6 - index, 0));
    assertContinuation(layout, "barrel/continuation", "barrel", 1);
    assertContinuation(layout, "second-barrel", "barrel", 1);
    assertContinuation(layout, "muzzle/adapter", "muzzle", 1);
    assertContinuation(layout, "muzzle/adapter/suppressor", "muzzle/adapter", 1);
});

test("AK-12 receiver optics and stock continuations retain weapon anatomy", () => {
    const entries = [
        slot("receiver", "receiver"),
        slot("receiver/scope", "scope", "receiver"),
        slot("receiver/rear", "rear_sight", "receiver"),
        slot("receiver/rear/insert", "rear_sight", "receiver/rear"),
        slot("gas", "gas_block"),
        slot("handguard", "handguard"),
        port("handguard/light", "tactical", "handguard", "top"),
        slot("handguard/grip", "foregrip", "handguard"),
        slot("muzzle", "muzzle"),
        slot("muzzle/suppressor", "muzzle", "muzzle"),
        slot("buffer", "stock"),
        slot("buffer/stock", "stock", "buffer"),
        slot("buffer/stock/pad", "stock", "buffer/stock"),
        slot("magazine", "magazine"),
        slot("grip", "pistol_grip"),
        slot("charge", "charge"),
    ];
    const layout = engine().compute(entries);
    assertCompleteLayout(entries, layout);
    for (const [id, col, vrow] of [
        ["receiver", 6, 0], ["handguard", 5, 0], ["gas", 4, 0], ["muzzle", 3, 0],
        ["receiver/scope", 8, -1], ["receiver/rear", 9, -1], ["buffer", 10, 0],
        ["magazine", 8, 1], ["grip", 9, 1], ["charge", 10, -1],
        ["handguard/light", 5, -1], ["handguard/grip", 5, 1],
    ]) assertAt(layout, id, col, vrow);
    assertContinuation(layout, "buffer/stock", "buffer", 1);
    assertContinuation(layout, "buffer/stock/pad", "buffer/stock", 1);
    assertContinuation(layout, "muzzle/suppressor", "muzzle", 1);
    assertContinuation(layout, "receiver/rear/insert", "receiver/rear", -1);
});

test("optics on a secondary handguard remain above that handguard's column", () => {
    const entries = [
        slot("receiver", "receiver"),
        slot("handguard", "handguard"),
        slot("handguard/upper", "handguard", "handguard"),
        slot("handguard/upper/optic", "scope", "handguard/upper"),
    ];
    const layout = engine().compute(entries);
    assertCompleteLayout(entries, layout);
    assertAt(layout, "receiver", 6, 0);
    assertAt(layout, "handguard", 5, 0);
    assertContinuation(layout, "handguard/upper", "handguard", 1);
    assertContinuation(layout, "handguard/upper/optic", "handguard/upper", -1);
    assert.ok(offset(layout, "handguard/upper/optic", null)[1] < 0);
});

test("stock chassis expose pistol-grip and optic slots at their weapon anchors", () => {
    const entries = [
        slot("chassis", "stock"),
        slot("chassis/grip", "pistol_grip", "chassis"),
        slot("chassis/optic", "scope", "chassis"),
        slot("chassis/stock", "stock", "chassis"),
    ];
    const layout = engine().compute(entries);
    assertCompleteLayout(entries, layout);
    assertAt(layout, "chassis", 10, 0);
    assertAt(layout, "chassis/grip", 9, 1);
    assertAt(layout, "chassis/optic", 8, -1);
    assertContinuation(layout, "chassis/stock", "chassis", 1);
});

test("M4 handguard branching cannot move primary weapon anchors", () => {
    const base = [
        slot("upper", "receiver"),
        slot("upper/handguard", "handguard", "upper"),
        slot("upper/barrel", "barrel", "upper"),
        slot("upper/barrel/gas", "gas_block", "upper/barrel"),
        slot("upper/barrel/gas/front", "front_sight", "upper/barrel/gas"),
        slot("upper/barrel/muzzle", "muzzle", "upper/barrel"),
        slot("upper/barrel/muzzle/suppressor", "muzzle", "upper/barrel/muzzle"),
        slot("upper/optic-mount", "mount", "upper"),
        slot("upper/optic-mount/scope", "scope", "upper/optic-mount"),
        slot("upper/rear", "rear_sight", "upper"),
        slot("upper/rear/insert", "rear_sight", "upper/rear"),
        slot("buffer", "stock"),
        slot("buffer/stock", "stock", "buffer"),
        slot("buffer/stock/pad", "stock", "buffer/stock"),
        slot("magazine", "magazine"),
        slot("grip", "pistol_grip"),
        slot("charge", "charge"),
    ];
    const branches = [];
    for (let index = 0; index < 12; index++) {
        const id = `upper/handguard/mount-${index}`;
        branches.push(
            slot(id, "mount", "upper/handguard", String(index).padStart(2, "0")),
            slot(`${id}/device`, "tactical", id),
            slot(`${id}/device/optic`, "scope", `${id}/device`)
        );
    }
    const compute = engine().compute;
    const baseline = compute(base);
    const expanded = compute([...base, ...branches]);
    assertCompleteLayout(base, baseline);
    assertCompleteLayout([...base, ...branches], expanded);
    for (const [id, col, vrow] of [
        ["upper", 6, 0], ["upper/handguard", 5, 0], ["upper/barrel", 4, 0],
        ["upper/barrel/gas", 3, 0], ["upper/barrel/muzzle", 2, 0],
        ["upper/barrel/gas/front", 2, -1], ["upper/optic-mount", 8, -1],
        ["upper/rear", 9, -1], ["buffer", 10, 0], ["magazine", 8, 1],
        ["grip", 9, 1], ["charge", 10, -1],
    ]) {
        assertAt(baseline, id, col, vrow);
        assertAt(expanded, id, col, vrow);
    }
    assertContinuation(expanded, "upper/optic-mount/scope", "upper/optic-mount", -1);
    assertContinuation(expanded, "upper/rear/insert", "upper/rear", -1);
    assertContinuation(expanded, "buffer/stock", "buffer", 1);
    assertContinuation(expanded, "buffer/stock/pad", "buffer/stock", 1);
    assertContinuation(expanded, "upper/barrel/muzzle/suppressor", "upper/barrel/muzzle", 1);
    for (let index = 0; index < 12; index++) {
        const id = `upper/handguard/mount-${index}`;
        const relative = offset(expanded, id, "upper/handguard");
        assert.ok(Math.abs(relative[0]) <= 1, `Keep ${id} in the handguard's three lanes`);
        assert.ok(relative[1] > 0);
        assertContinuation(expanded, `${id}/device`, id, 1);
        assertContinuation(expanded, `${id}/device/optic`, `${id}/device`, 1);
    }
});

test("handguard optics grow above the handguard while parallel mounts grow below it", () => {
    const entries = [
        slot("receiver", "receiver"),
        slot("receiver/scope", "scope", "receiver"),
        slot("handguard", "handguard"),
        slot("handguard/optic", "scope", "handguard"),
        slot("handguard/foregrip", "foregrip", "handguard"),
        slot("handguard/mount-a", "mount", "handguard", "00"),
        slot("handguard/mount-b", "mount", "handguard", "01"),
        slot("handguard/mount-c", "mount", "handguard", "02"),
    ];
    const layout = engine().compute(entries);
    assertCompleteLayout(entries, layout);
    assertAt(layout, "receiver/scope", 8, -1);
    assertAt(layout, "handguard/optic", 5, -1);
    assertAt(layout, "handguard/foregrip", 5, 1);
    assert.equal(layout.positions.get("handguard/mount-a").col, 4);
    assert.equal(layout.positions.get("handguard/mount-b").col, 6);
    assert.equal(layout.positions.get("handguard/mount-c").col, 5);
    for (const id of ["handguard/mount-a", "handguard/mount-b", "handguard/mount-c"]) {
        assert.ok(offset(layout, id, "handguard")[1] > 0);
    }
});

test("HK416 Quad Rail ports follow mount geometry, with the MPR45 above-left", () => {
    const entries = [
        slot("receiver", "receiver"),
        slot("handguard", "handguard", "receiver"),
        slot("barrel", "barrel", "receiver"),
        slot("gas", "gas_block", "barrel"),
        slot("muzzle", "muzzle", "barrel"),
        port("handguard/mod_scope", "scope", "handguard", "offset_left"),
        port("handguard/mod_tactical_000", "tactical", "handguard", "top"),
        port("handguard/mod_tactical_001", "tactical", "handguard", "right"),
        port("handguard/mod_tactical_002", "tactical", "handguard", "left"),
        port("handguard/mod_foregrip", "foregrip", "handguard", "bottom"),
        port("handguard/mod_bipod", "bipod", "handguard", "bottom"),
    ];
    const layout = engine().compute(entries);
    assertCompleteLayout(entries, layout);
    for (const [id, expected] of [
        ["mod_scope", [-1, -1]], ["mod_tactical_000", [0, -1]],
        ["mod_tactical_001", [1, 1]], ["mod_tactical_002", [-1, 1]],
        ["mod_foregrip", [0, 1]], ["mod_bipod", [0, 2]],
    ]) assert.deepEqual(offset(layout, `handguard/${id}`, "handguard"), expected);
    assert.deepEqual(coordinates(engine().compute(entries.slice().reverse())), coordinates(layout));
});

for (const role of ["scope", "mount", "tactical"]) {
    test(`MPR45-only ${role} ports keep the offset optic branch above-left`, () => {
        const entries = [slot("handguard", "handguard"),
            port("handguard/offset", role, "handguard", "offset_left"),
            slot("handguard/offset/optic", "scope", "handguard/offset"),
        ];
        const layout = engine().compute(entries);
        assertCompleteLayout(entries, layout);
        assert.deepEqual(offset(layout, "handguard/offset", "handguard"), [-1, -1]);
        assert.deepEqual(offset(layout, "handguard/offset/optic", "handguard"), [-1, -2]);
    });
}

test("M-LOK adapters inherit their physical lane through tactical and optic descendants", () => {
    const entries = [slot("receiver", "receiver"), slot("handguard", "handguard")];
    for (const [mount, role] of [["left", "mount"], ["right", "mount"], ["bottom", "mount"],
        ["top", "tactical"], ["offset_left", "scope"]]) {
        const id = `handguard/${mount}`;
        entries.push(port(id, role, "handguard", mount));
        for (const child of ["device-a", "device-b"]) {
            entries.push(slot(`${id}/${child}`, "tactical", id));
            entries.push(slot(`${id}/${child}/optic`, "scope", `${id}/${child}`));
        }
    }
    const layout = engine().compute(entries);
    assertCompleteLayout(entries, layout);
    for (const [mount, colDelta, direction] of [["left", -1, 1], ["right", 1, 1], ["bottom", 0, 1],
        ["top", 0, -1], ["offset_left", -1, -1]]) {
        const id = `handguard/${mount}`;
        assert.deepEqual(offset(layout, id, "handguard"), [colDelta, direction]);
        for (const entry of entries.filter(candidate => candidate.id.startsWith(`${id}/`))) {
            assertContinuation(layout, entry.id, entry.parentId, direction);
        }
    }
});

test("multiple ports on one side stack without crossing their owner or changing sides", () => {
    const entries = [slot("receiver", "receiver"), slot("handguard", "handguard"),
        port("handguard/a", "tactical", "handguard", "left"),
        slot("handguard/a/device", "tactical", "handguard/a"),
        port("handguard/b", "mount", "handguard", "left"),
        slot("handguard/b/device", "scope", "handguard/b"),
        port("handguard/top", "tactical", "handguard", "top"),
    ];
    const layout = engine().compute(entries);
    assertCompleteLayout(entries, layout);
    for (const id of ["handguard/a", "handguard/b", "handguard/a/device", "handguard/b/device"]) {
        const relative = offset(layout, id, "handguard");
        assert.equal(relative[0], -1);
        assert.ok(relative[1] > 0);
    }
    assert.deepEqual(offset(layout, "handguard/top", "handguard"), [0, -1]);
});

test("missing physical metadata uses lower fallback lanes instead of a tactical tower above the handguard", () => {
    const entries = [slot("handguard", "handguard"),
        slot("handguard/a", "tactical", "handguard"),
        { ...slot("handguard/b", "tactical", "handguard"), mount: "future_port" },
        slot("handguard/c", "mount", "handguard"),
    ];
    const layout = engine().compute(entries);
    assertCompleteLayout(entries, layout);
    for (const id of ["handguard/a", "handguard/b", "handguard/c"]) {
        assert.ok(offset(layout, id, "handguard")[1] > 0);
    }
    assert.deepEqual(offset(layout, "handguard/a", "handguard"), [-1, 1]);
    assert.deepEqual(offset(layout, "handguard/b", "handguard"), [1, 1]);
});

test("foregrip and bipod connector normals cannot override their bottom placement", () => {
    const entries = [slot("handguard", "handguard"),
        port("handguard/foregrip", "foregrip", "handguard", "top"),
        port("handguard/bipod", "bipod", "handguard", "top"),
    ];
    const layout = engine().compute(entries);
    assertCompleteLayout(entries, layout);
    assert.deepEqual(offset(layout, "handguard/foregrip", "handguard"), [0, 1]);
    assert.deepEqual(offset(layout, "handguard/bipod", "handguard"), [0, 2]);
});

test("physical ports belong to their handguard instance even when it is an accessory descendant", () => {
    const entries = [slot("rail", "mount"), slot("rail/handguard", "handguard", "rail"),
        port("rail/handguard/left", "mount", "rail/handguard", "left"),
        port("rail/handguard/top", "tactical", "rail/handguard", "top"),
        port("rail/handguard/optic", "scope", "rail/handguard", "offset_left"),
    ];
    const layout = engine().compute(entries);
    assertCompleteLayout(entries, layout);
    assert.deepEqual(offset(layout, "rail/handguard/left", "rail/handguard"), [-1, 1]);
    assert.deepEqual(offset(layout, "rail/handguard/top", "rail/handguard"), [0, -1]);
    assert.deepEqual(offset(layout, "rail/handguard/optic", "rail/handguard"), [-1, -1]);
});

test("side-mounted rails keep all branching descendants within the handguard's three lanes", () => {
    const entries = [slot("receiver", "receiver"), slot("handguard", "handguard")];
    for (const [index, side] of ["left", "right"].entries()) {
        const mount = `handguard/${side}`;
        entries.push(slot(mount, "mount", "handguard", String(index)));
        for (let child = 0; child < 4; child++) {
            const device = `${mount}/device-${child}`;
            entries.push(slot(device, "tactical", mount));
            for (let nested = 0; nested < 3; nested++) {
                entries.push(slot(`${device}/nested-${nested}`, "unknown", device));
            }
        }
    }
    const layout = engine().compute(entries);
    assertCompleteLayout(entries, layout);
    assertAt(layout, "handguard", 5, 0);
    assert.equal(layout.positions.get("handguard/left").col, 4);
    assert.equal(layout.positions.get("handguard/right").col, 6);
    for (const entry of entries.filter(candidate => candidate.parentId !== null)) {
        const position = layout.positions.get(entry.id);
        assert.ok(position.col >= 4 && position.col <= 6, `Keep ${entry.id} within its handguard's lanes`);
        assert.ok(offset(layout, entry.id, entry.parentId)[1] > 0, `Continue ${entry.id} below its owner`);
    }
});

test("input traversal and sibling order do not change placement or mutate descriptors", () => {
    const entries = Object.freeze([
        slot("root/mount-b", "mount", null, "02"),
        slot("root/mount-b/light", "tactical", "root/mount-b"),
        slot("root/mount-a", "mount", null, "01"),
        slot("root/mount-a/light", "tactical", "root/mount-a"),
        slot("root/barrel", "barrel"),
        slot("root/barrel/muzzle", "muzzle", "root/barrel"),
        slot("root/stock", "stock"),
    ].map(Object.freeze));
    const compute = engine().compute;
    const baseline = compute(entries);
    const reordered = compute([...entries].reverse());
    assertCompleteLayout(entries, baseline);
    assertCompleteLayout(entries, reordered);
    assert.deepEqual(coordinates(reordered), coordinates(baseline));
    assert.deepEqual(
        [reordered.gunCol, reordered.gunRow, reordered.totalCols, reordered.totalRows],
        [baseline.gunCol, baseline.gunRow, baseline.totalCols, baseline.totalRows]
    );
});

test("distinguish identical attachment instances by their complete ancestry paths", () => {
    const entries = [
        slot("gun/rail-a", "mount"),
        slot("gun/rail-a/identical-mount", "mount", "gun/rail-a"),
        slot("gun/rail-a/identical-mount/light", "tactical", "gun/rail-a/identical-mount"),
        slot("gun/rail-b", "mount"),
        slot("gun/rail-b/identical-mount", "mount", "gun/rail-b"),
        slot("gun/rail-b/identical-mount/light", "tactical", "gun/rail-b/identical-mount"),
    ];
    const compute = engine().compute;
    const together = compute(entries);
    const remaining = entries.filter(entry => !entry.id.startsWith("gun/rail-a"));
    const alone = compute(remaining);
    assertCompleteLayout(entries, together);
    assertCompleteLayout(remaining, alone);
    assert.deepEqual(
        offset(together, "gun/rail-b/identical-mount/light", "gun/rail-b/identical-mount"),
        offset(alone, "gun/rail-b/identical-mount/light", "gun/rail-b/identical-mount")
    );
});

test("keep deep and numerous accessory branches visible using vertical overflow", () => {
    const entries = [slot("mount", "mount")];
    let ownerId = "mount";
    for (let depth = 0; depth < 80; depth++) {
        const id = `${ownerId}/new-slot`;
        entries.push(slot(id, depth % 2 ? "unknown" : "future_slot_type", ownerId));
        ownerId = id;
    }
    for (let sibling = 0; sibling < 35; sibling++) {
        entries.push(slot(`mount/parallel-${sibling}`, "unknown", "mount", String(sibling).padStart(2, "0")));
    }
    const layout = engine().compute(entries);
    assertCompleteLayout(entries, layout);
    assert.ok(layout.totalRows > 30);
    for (const entry of entries.slice(1)) {
        assert.ok(offset(layout, entry.id, entry.parentId)[1] < 0);
    }
});

test("unknown root slots remain below the gun and preserve their descendants' direction", () => {
    const entries = [
        slot("unknown", "future_slot_type"),
        slot("unknown/adapter", "unknown", "unknown"),
        slot("unknown/adapter/optic", "scope", "unknown/adapter"),
    ];
    const layout = engine().compute(entries);
    assertCompleteLayout(entries, layout);
    assertAt(layout, "unknown", 7, 1);
    assertContinuation(layout, "unknown/adapter", "unknown", 1);
    assertContinuation(layout, "unknown/adapter/optic", "unknown/adapter", 1);
});

test("reserve the secondary charging-handle position without moving the primary handle", () => {
    const entries = [slot("primary", "charge", null, "00"), slot("secondary", "charge", null, "01")];
    const layout = engine().compute(entries);
    assertCompleteLayout(entries, layout);
    assertAt(layout, "primary", 10, -1);
    assertAt(layout, "secondary", 7, 1);
});

test("keep an unknown orphan accessible when its owner descriptor is unavailable", () => {
    const entries = [slot("missing/slot", "unknown", "missing")];
    const layout = engine().compute(entries);
    assertCompleteLayout(entries, layout);
    assert.ok(offset(layout, "missing/slot", null)[1] > 0);
});

test("reject duplicate identities and ancestry cycles instead of losing slots silently", () => {
    const compute = engine().compute;
    assert.throws(() => compute([slot("same", "mount"), slot("same", "mount")]), /Duplicate/);
    assert.throws(() => compute([
        slot("a", "mount", "b"),
        slot("b", "mount", "a"),
    ]), /ancestry cycle/);
});
