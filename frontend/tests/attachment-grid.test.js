/* eslint-env node */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const layoutSource = fs.readFileSync(path.join(__dirname, "../modules/attachment-layout.js"), "utf8");
const gridSource = fs.readFileSync(path.join(__dirname, "../modules/attachment-grid.js"), "utf8");

function apiSlot(id, name, role, gameName) {
    return { id, slot_name: name, slot_role: role, slot_game_name: gameName, has_allowed_items: true };
}

function fixture() {
    const mounted = () => ({
        item: { id: "shared@mount" },
        children: {
            "optic/slot": { item: { id: "shared#optic" }, children: {} },
        },
    });
    const root = {
        item: { id: "gun / example" },
        children: { "rail/a": mounted(), "rail/b": mounted() },
    };
    const slots = {
        [root.item.id]: [
            apiSlot("rail/a", "Mount", "mount", "mod_mount_000"),
            apiSlot("rail/b", "Mount", "mount", "mod_mount_001"),
            apiSlot("stock", "Stock", "stock", "mod_stock"),
        ],
        "shared@mount": [apiSlot("optic/slot", "Scope", "scope", "mod_scope")],
        "shared#optic": [apiSlot("tactical-slot", "Tactical", "tactical", "mod_tactical_000")],
    };
    return { root, slots };
}

function grid(data = fixture()) {
    const fetched = [];
    const EFTForge = { state: { buildTree: data.root, slotCache: {} } };
    const context = vm.createContext({
        window: { EFTForge },
        EFTForge,
        isMobileLayout: () => false,
        localStorage: { getItem: () => null, setItem: () => {} },
        fetchItemSlots: async id => {
            fetched.push(id);
            assert.ok(Object.prototype.hasOwnProperty.call(data.slots, id), `Provide slots for ${id}`);
            return data.slots[id];
        },
        cacheSet: (cache, id, value) => { cache[id] = value; },
    });
    vm.runInContext(layoutSource, context);
    vm.runInContext(gridSource, context);
    return {
        ...data,
        context,
        fetched,
        collect: () => context.window.collectAllVisibleSlots(data.root),
        compute: entries => context.window.computeGridPositions(entries),
    };
}

function coordinates(entries, layout) {
    return Array.from(entries, (entry, index) => {
        const position = layout.positions.get(index);
        return [entry.instanceId, position.col, position.row, position.extras];
    }).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}

function assertVisible(entries, layout) {
    assert.equal(layout.positions.size, entries.length);
    const occupied = new Set();
    for (let col = layout.gunCol; col < layout.gunCol + layout.gunSpan; col++) {
        occupied.add(`${col},${layout.gunRow}`);
    }
    entries.forEach((entry, index) => {
        const position = layout.positions.get(index);
        assert.ok(position, `Place ${entry.instanceId}`);
        assert.equal(position.extras, false);
        assert.ok(Number.isInteger(position.col) && Number.isInteger(position.row));
        assert.ok(position.col >= 1 && position.col <= layout.totalCols);
        assert.ok(position.row >= 1 && position.row <= layout.totalRows);
        const cell = `${position.col},${position.row}`;
        assert.ok(!occupied.has(cell), `Keep ${entry.instanceId} separate from other cells and the gun`);
        occupied.add(cell);
    });
}

test("collector paths keep repeated attachment instances stable when an earlier branch is removed", async () => {
    const view = grid();
    const before = await view.collect();
    const secondRoot = before.find(entry => entry.parentNode === view.root && entry.slot.id === "rail/b");
    const branchPaths = entries => Array.from(entries)
        .filter(entry => entry.instanceId === secondRoot.instanceId || entry.instanceId.startsWith(`${secondRoot.instanceId}@`))
        .map(entry => [entry.instanceId, entry.parentInstanceId]);
    const firstPaths = branchPaths(before);
    assert.equal(firstPaths.length, 3);
    assert.equal(secondRoot.instanceId, `${encodeURIComponent(view.root.item.id)}/${encodeURIComponent("rail/b")}`);
    assert.equal(new Set(before.map(entry => entry.instanceId)).size, before.length);

    delete view.root.children["rail/a"];
    const after = await view.collect();
    assert.deepEqual(branchPaths(after), firstPaths);
    assert.equal(after.length, before.length - 2);
    assertVisible(after, view.compute(after));
});

test("collector ownership points to the exact installed instance and reuses shared slot definitions", async () => {
    const view = grid();
    const entries = await view.collect();
    const byInstance = new Map(entries.map(entry => [entry.instanceId, entry]));
    for (const entry of entries) {
        if (entry.parentNode === view.root) {
            assert.equal(entry.parentInstanceId, null);
            assert.equal(entry.depth, 0);
        } else {
            const owner = byInstance.get(entry.parentInstanceId);
            assert.ok(owner, `Retain the owner of ${entry.instanceId}`);
            assert.equal(owner.parentNode.children[owner.slot.id], entry.parentNode);
            assert.equal(entry.depth, owner.depth + 1);
        }
    }
    assert.equal(entries.length, 7);
    assert.deepEqual(view.fetched.slice().sort(), [view.root.item.id, "shared@mount", "shared#optic"].sort());
    assertVisible(entries, view.compute(entries));
});

test("source API traversal order cannot change automatic positions", async () => {
    const original = grid();
    const reorderedData = fixture();
    for (const slots of Object.values(reorderedData.slots)) slots.reverse();
    const reordered = grid(reorderedData);
    const firstEntries = await original.collect();
    const secondEntries = await reordered.collect();
    const firstLayout = original.compute(firstEntries);
    const secondLayout = reordered.compute(secondEntries);
    assert.notEqual(firstEntries[0].instanceId, secondEntries[0].instanceId);
    assert.deepEqual(coordinates(secondEntries, secondLayout), coordinates(firstEntries, firstLayout));
    assert.deepEqual(
        [secondLayout.gunCol, secondLayout.gunRow, secondLayout.totalCols, secondLayout.totalRows],
        [firstLayout.gunCol, firstLayout.gunRow, firstLayout.totalCols, firstLayout.totalRows]
    );
    assertVisible(secondEntries, secondLayout);
});

test("automatic layout ignores conflicting absolute overrides", async () => {
    const view = grid();
    const entries = await view.collect();
    const baseline = view.compute(entries);
    const overrides = {};
    for (const entry of entries) {
        const key = `${entry.slot.id}@${entry.parentNode.item.id}`;
        overrides[key] = { col: 7, vrow: 0 };
        overrides[`${key}#1`] = { col: 7, vrow: 0 };
    }
    view.context.window._AG_OVERRIDES = overrides;
    const layout = view.compute(entries);
    assert.equal(layout.mode, "automatic");
    assert.deepEqual(coordinates(entries, layout), coordinates(entries, baseline));
    assertVisible(entries, layout);
});

test("legacy comparison remains selectable and honors its own coordinates", async () => {
    const view = grid();
    const entries = await view.collect();
    const baseline = view.compute(entries);
    const index = entries.findIndex(entry => entry.parentNode === view.root && entry.slot.id === "rail/a");
    view.context.window._AG_OVERRIDES = { [`rail/a@${view.root.item.id}`]: { col: 2, vrow: 3 } };
    view.context.EFTForge.attachmentGrid.useLegacyLayout = true;
    const legacy = view.compute(entries);
    assert.equal(legacy.mode, "legacy");
    assert.equal(legacy.gunCol, 7);
    assert.equal(legacy.totalCols, 10);
    assert.equal(legacy.positions.get(index).col, 2);
    assert.equal(legacy.positions.get(index).row - legacy.gunRow, 3);

    view.context.EFTForge.attachmentGrid.useLegacyLayout = false;
    const automatic = view.compute(entries);
    assert.equal(automatic.mode, "automatic");
    assert.deepEqual(coordinates(entries, automatic), coordinates(entries, baseline));
});

test("slots from an older API without semantic roles remain visible with their owners", async () => {
    const data = fixture();
    for (const slots of Object.values(data.slots)) {
        for (const slot of slots) delete slot.slot_role;
    }
    const view = grid(data);
    const entries = await view.collect();
    assert.equal(entries.length, 7);
    assert.ok(entries.every(entry => entry.role === "unknown"));
    const layout = view.compute(entries);
    assertVisible(entries, layout);
    const indexes = new Map(entries.map((entry, index) => [entry.instanceId, index]));
    for (const entry of entries) {
        if (entry.parentInstanceId === null) continue;
        const position = layout.positions.get(indexes.get(entry.instanceId));
        const owner = layout.positions.get(indexes.get(entry.parentInstanceId));
        assert.ok(position.row > owner.row);
    }
});

test("installed handguards in generic mount slots acquire body placement and keep optics above them", async () => {
    const root = {
        item: { id: "gun" },
        children: { generic: { item: { id: "handguard", attachment_role: "handguard" }, children: {} } },
    };
    const genericSlot = apiSlot("generic", "Mount", "mount", "mod_mount_000");
    const view = grid({ root, slots: {
        gun: [apiSlot("receiver", "Receiver", "receiver", "mod_reciever"), genericSlot],
        handguard: [apiSlot("optic", "Scope", "scope", "mod_scope")],
    } });
    const entries = await view.collect();
    const handguardIndex = entries.findIndex(entry => entry.slot.id === "generic");
    const opticIndex = entries.findIndex(entry => entry.slot.id === "optic");
    assert.equal(entries[handguardIndex].role, "handguard");
    assert.equal(entries[opticIndex].parentInstanceId, entries[handguardIndex].instanceId);
    assert.equal(genericSlot.slot_role, "mount");
    const layout = view.compute(entries);
    assertVisible(entries, layout);
    const handguard = layout.positions.get(handguardIndex);
    const optic = layout.positions.get(opticIndex);
    assert.deepEqual([handguard.col, handguard.row - layout.gunRow], [5, 0]);
    assert.equal(optic.col, handguard.col);
    assert.ok(optic.row < handguard.row);

    delete root.children.generic;
    const emptyEntries = await view.collect();
    const emptyMount = emptyEntries.find(entry => entry.slot.id === "generic");
    assert.equal(emptyMount.instanceId, entries[handguardIndex].instanceId);
    assert.equal(emptyMount.role, "mount");
    assertVisible(emptyEntries, view.compute(emptyEntries));
});

test("cached handguard mount metadata reaches layout and survives installing adapters", async () => {
    const root = { item: { id: "gun" }, children: {
        hg: { item: { id: "handguard", attachment_role: "handguard" }, children: {} },
    } };
    const handguardSlots = [
        ["top", "tactical", "mod_tactical_000", "top", "geometry"],
        ["right", "mount", "mod_mount_000", "right", "geometry"],
        ["left", "mount", "mod_mount_001", "left", "geometry"],
        ["optic", "scope", "mod_scope", "offset_left", "compatibility"],
    ].map(([id, role, name, mount, source]) => ({
        ...apiSlot(id, "Translated slot", role, name), slot_mount: mount, slot_mount_source: source,
    }));
    const view = grid({ root, slots: {
        gun: [apiSlot("receiver", "Receiver", "receiver", "mod_reciever"),
            apiSlot("hg", "Mount", "mount", "mod_mount")],
        handguard: handguardSlots,
        adapter: [apiSlot("device", "Tactical", "tactical", "mod_tactical")],
    } });
    const before = await view.collect();
    const baseline = view.compute(before);
    assertVisible(before, baseline);
    function relative(entries, layout, id) {
        const child = layout.positions.get(entries.findIndex(entry => entry.slot.id === id));
        const owner = layout.positions.get(entries.findIndex(entry => entry.slot.id === "hg"));
        return [child.col - owner.col, child.row - owner.row];
    }
    for (const [id, expected] of [["top", [0, -1]], ["right", [1, 1]],
        ["left", [-1, 1]], ["optic", [-1, -1]]]) {
        assert.deepEqual(relative(before, baseline, id), expected);
        assert.equal(before.find(entry => entry.slot.id === id).mount,
            handguardSlots.find(slot => slot.id === id).slot_mount);
    }
    root.children.hg.children.left = { item: { id: "adapter", attachment_role: "mount" }, children: {} };
    const after = await view.collect();
    const expanded = view.compute(after);
    assertVisible(after, expanded);
    for (const id of ["top", "right", "left", "optic"]) {
        assert.deepEqual(relative(after, expanded, id), relative(before, baseline, id));
    }
    assert.deepEqual(relative(after, expanded, "device"), [-1, 2]);
    assert.equal(view.fetched.filter(id => id === "handguard").length, 1);
});

for (const [slotRole, installedRole, expected] of [
    ["mount", "mount", "mount"],
    ["mount", "unknown", "mount"],
    ["mount", undefined, "mount"],
    ["scope", "handguard", "scope"],
]) {
    test(`collector preserves ${slotRole} semantics when the installed role is ${installedRole ?? "missing"}`, async () => {
        const data = fixture();
        data.slots[data.root.item.id][0].slot_role = slotRole;
        data.root.children["rail/a"].item.attachment_role = installedRole;
        const view = grid(data);
        const entries = await view.collect();
        const entry = entries.find(candidate => candidate.parentNode === data.root && candidate.slot.id === "rail/a");
        assert.equal(entry.role, expected);
        assert.equal(entry.slot.slot_role, slotRole);
        assertVisible(entries, view.compute(entries));
    });
}
