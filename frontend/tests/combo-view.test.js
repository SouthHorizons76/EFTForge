/* eslint-env node */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../modules/slot-selector.js"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));

function view() {
    const pending = [], toasts = [], errors = [], renders = [];
    const nodes = new Map(), intervals = new Map(), classes = new Set();
    let nextInterval = 0;
    const classList = {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
    };
    const root = { item: { id: "gun" }, children: {} };
    const state = { lastSlot: { id: "A", slot_name: "Stock" }, lastParentNode: root, buildTree: root,
        currentGun: root.item, combosCache: {}, lastComboItems: [], comboMode: true,
        slotCache: {}, traderLevels: {}, comboSort: { key: "recoil", direction: "asc" }, comboErgoWeight: 50 };
    const EFTForge = { state, config: {}, lang: { t: x => x } };
    const ctx = vm.createContext({ window: { EFTForge }, EFTForge, AbortController, DOMException,
        console: { error: (...args) => errors.push(args) },
        document: {
            getElementById(id) {
                if (!nodes.has(id)) nodes.set(id, { style: {}, classList, textContent: "", innerHTML: "" });
                return nodes.get(id);
            },
            querySelector(selector) { return selector === ".attachment-table" ? { classList } : null; },
        },
        collectAttachmentIds: () => [], _lang: () => "en", escapeHtml: x => x,
        showToast: (...args) => toasts.push(args),
        setInterval: callback => { intervals.set(++nextInterval, callback); return nextInterval; },
        clearInterval: id => intervals.delete(id),
    });
    vm.runInContext(source, ctx);
    ctx._clearMarqueeTimers = () => {};
    ctx.updateSortIndicators = () => {};
    ctx._renderComboRows = items => renders.push(plain(items));
    ctx.comboFull = (payload, signal, onProgress) => new Promise((resolve, reject) => {
        pending.push({ payload, signal, onProgress, resolve, reject });
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    const select = id => { state.lastSlot = { id, slot_name: "Stock" }; return ctx.openComboView(); };
    const inFlight = () => vm.runInContext("_comboCalcInFlight", ctx);
    return { ctx, state, pending, nodes, intervals, classes, toasts, errors, renders, select, inFlight };
}

function result(id, truncated = false) {
    return { base: {}, combos: [{ parent_item: { id, name: id }, child_items: [],
        child_slot_ids: [], all_child_slot_ids: [], total_ergo: 1 }], truncated,
        truncation_reasons: truncated ? ["frontier_cap"] : [] };
}

function compact(result) {
    const items = {};
    const combos = result.combos.map(({ parent_item, child_items, ...rest }) => {
        for (const item of [parent_item, ...child_items]) items[item.id] = item;
        return { ...rest, parent_item_id: parent_item.id, child_item_ids: child_items.map(item => item.id) };
    });
    return { ...result, response_format: "items-v1", items, combos };
}

for (const name of ["Receiver", "Handguard", "Catch", "Barrel", "Gas Block", "Muzzle"]) {
    test(`selected ${name} remains its own combo root without grid layout globals`, () => {
        const { ctx, state } = view();
        const parent = { item: { id: "receiver" }, children: {} };
        state.buildTree.children.receiver = parent;
        state.lastParentNode = parent;
        state.lastSlot = { id: "selected", slot_name: name };

        const root = ctx._findComboRootSlot();
        assert.equal(root.parentNode, parent);
        assert.equal(root.slotId, "selected");
        assert.equal(root.isLeftQueueRoot, true);
    });
}

test("nested combo slots stop at their nearest assembly boundary regardless of grid ordering", () => {
    const { ctx, state } = view();
    const receiver = { item: { id: "receiver" }, children: {} };
    const handguard = { item: { id: "handguard" }, children: {} };
    const rail = { item: { id: "rail" }, children: {} };
    state.buildTree.children.receiver = receiver;
    receiver.children.handguard = handguard;
    handguard.children.rail = rail;
    state.slotCache = {
        gun: [{ id: "receiver", slot_name: "Receiver" }],
        receiver: [{ id: "handguard", slot_name: "Handguard" }],
        handguard: [{ id: "rail", slot_name: "Mount" }],
    };
    state.lastParentNode = rail;
    state.lastSlot = { id: "device", slot_name: "Tactical" };
    ctx._AG_LEFT_ORDER = ["Mount", "Tactical"];

    const root = ctx._findComboRootSlot();
    assert.equal(root.parentNode, receiver);
    assert.equal(root.slotId, "handguard");
    assert.equal(root.isLeftQueueRoot, true);
});

test("non-assembly descendants use the gun's direct slot even if layout treats them separately", () => {
    const { ctx, state } = view();
    const stock = { item: { id: "stock" }, children: {} };
    const adapter = { item: { id: "adapter" }, children: {} };
    state.buildTree.children.stock = stock;
    stock.children.adapter = adapter;
    state.slotCache = {
        gun: [{ id: "stock", slot_name: "Stock" }],
        stock: [{ id: "adapter", slot_name: "Mount" }],
    };
    state.lastParentNode = adapter;
    state.lastSlot = { id: "pad", slot_name: "Stock" };
    ctx._AG_LEFT_ORDER = ["Mount", "Stock"];

    const root = ctx._findComboRootSlot();
    assert.equal(root.parentNode, state.buildTree);
    assert.equal(root.slotId, "stock");
    assert.equal(root.isLeftQueueRoot, false);
});

for (const selectedName of ["Handguard", "Mount"]) {
    test(`combo exclusions preserve the selected ${selectedName} boundary semantics`, async () => {
        const { ctx, state, pending } = view();
        const handguard = { item: { id: "handguard" }, children: {} };
        state.buildTree.children.handguard = handguard;
        state.slotCache.gun = [{ id: "handguard", slot_name: "Handguard" }];
        state.lastParentNode = selectedName === "Handguard" ? state.buildTree : handguard;
        state.lastSlot = { id: selectedName === "Handguard" ? "handguard" : "rail", slot_name: selectedName };
        ctx._AG_LEFT_ORDER = [];

        const request = ctx.openComboView();
        assert.equal(pending[0].payload.root_slot_id, "handguard");
        assert.deepEqual(plain(pending[0].payload.exclude_child_slot_names),
            ["Receiver", "Handguard", "Catch", "Barrel", "Gas Block", "Muzzle"].filter(name => name !== selectedName));
        pending[0].resolve({ base: {}, combos: [] });
        await request;
    });
}

test("aborted request cannot clear the next request's loading flag or progress", async () => {
    const v = view();
    const a = v.select("A"), oldDots = [...v.intervals.values()][0];
    const b = v.select("B");
    const text = v.nodes.get("attachment-body").innerHTML;
    await a;
    assert.equal(v.inFlight(), true);
    assert.equal(v.pending[1].signal.aborted, false);
    v.pending[0].onProgress({ capped: true });
    oldDots();
    assert.equal(v.nodes.has("combo-loading-progress"), false);
    assert.equal(v.nodes.has("combo-loading-main"), false);
    v.ctx.applyComboSort();
    assert.equal(v.nodes.get("attachment-body").innerHTML, text);
    v.pending[1].resolve(compact(result("B", true)));
    await b;
    assert.equal(v.state.lastComboItems[0].parentEntry.item.id, "B");
    assert.equal(v.toasts.length, 1);
    assert.equal(v.inFlight(), false);
    assert.equal(v.intervals.size, 0);
});

test("a resolved stale request cannot write results, cache or truncation toasts", async () => {
    const v = view(), a = v.select("A");
    v.pending[0].resolve(result("A", true));
    const b = v.select("B");
    await a;
    assert.equal(v.state.lastComboItems.length, 0);
    assert.equal(Object.keys(v.state.combosCache).length, 0);
    assert.equal(v.toasts.length, 0);
    assert.equal(v.inFlight(), true);
    v.pending[1].resolve(result("B"));
    await b;
    assert.equal(v.state.lastComboItems[0].parentEntry.item.id, "B");
});

test("a cache hit invalidates an in-flight request", async () => {
    const v = view(), initial = v.select("B");
    v.pending[0].resolve(result("B"));
    await initial;
    const a = v.select("A");
    v.pending[1].resolve(result("A", true));
    await v.select("B");
    await a;
    assert.equal(v.pending.length, 2);
    assert.equal(v.state.lastComboItems[0].parentEntry.item.id, "B");
    assert.equal(v.state.lastComboWasCapped, false);
    assert.equal(v.toasts.length, 0);
    assert.equal(v.inFlight(), false);
});

test("leaving combo view and stale errors cannot change the current view", async () => {
    const v = view(), a = v.select("A");
    v.pending[0].reject(new Error("late server error"));
    v.ctx._abortComboCalc();
    v.state.comboMode = false;
    v.nodes.get("attachment-body").innerHTML = "new view";
    await a;
    assert.equal(v.nodes.get("attachment-body").innerHTML, "new view");
    assert.equal(v.errors.length, 0);
    assert.equal(v.intervals.size, 0);
});

test("empty results clear old rows and remain empty when sorted or cached", async () => {
    const v = view();
    v.state.lastComboItems = [{ stale: true }];
    const request = v.select("A");
    v.pending[0].resolve({ base: {}, combos: [], response_format: "items-v1", items: {} });
    await request;
    await v.select("A");
    assert.equal(v.pending.length, 1);
    assert.equal(v.state.lastComboItems.length, 0);
    assert.match(v.nodes.get("attachment-body").innerHTML, /ui.comboNone/);
});

for (const changeContext of [
    state => { state.currentGun = null; state.buildTree = null; state.lastSlot = null; state.lastParentNode = null; },
    state => { state.buildTree = { item: state.currentGun, children: {} }; },
]) {
    test("a changed gun or tab discards the pending result", async () => {
        const v = view(), request = v.select("A");
        changeContext(v.state);
        v.pending[0].onProgress({ capped: true });
        assert.equal(v.nodes.has("combo-loading-progress"), false);
        v.pending[0].resolve(result("A", true));
        await request;
        assert.equal(v.state.lastComboItems.length, 0);
        assert.equal(Object.keys(v.state.combosCache).length, 0);
        assert.equal(v.toasts.length, 0);
        assert.equal(v.errors.length, 0);
        assert.equal(v.inFlight(), false);
        assert.equal(v.intervals.size, 0);
    });
}

for (const [field, value, requestField] of [
    ["currentStrengthLevel", 51, "strength_level"],
    ["currentEquipErgoModifier", -0.1, "equip_ergo_modifier"],
]) for (const failed of [false, true]) {
    test("changed stat inputs restart the current view after an outdated response or error", async () => {
        const v = view(), request = v.select("A");
        v.state[field] = value;
        if (failed) v.pending[0].reject(new Error("outdated failure"));
        else v.pending[0].resolve(result("old", true));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(v.pending.length, 2);
        assert.equal(v.pending[1].payload[requestField], value);
        assert.equal(v.inFlight(), true);
        assert.equal(v.toasts.length, 0);
        assert.equal(v.errors.length, 0);
        v.pending[1].resolve(result("current"));
        await request;
        assert.equal(v.state.lastComboItems[0].parentEntry.item.id, "current");
        assert.equal(Object.keys(v.state.combosCache).length, 1);
        assert.equal(v.inFlight(), false);
        assert.equal(v.intervals.size, 0);
    });
}

for (const value of [
    { ...result("A"), response_format: "future" },
    { ...compact(result("A")), items: {} },
    { ...compact(result("A")), items: { A: { id: "other", name: "wrong" } } },
    { ...result("A"), combos: null },
]) {
    test("malformed result follows the view's error path", async () => {
        const v = view(), request = v.select("A");
        v.pending[0].resolve(value);
        await request;
        assert.equal(v.errors.length, 1);
        assert.equal(v.state.comboMode, false);
        assert.equal(v.inFlight(), false);
        assert.equal(v.intervals.size, 0);
        assert.equal(Object.keys(v.state.combosCache).length, 0);
        assert.match(v.nodes.get("attachment-body").innerHTML, /ui.comboError/);
    });
}

test("formats preserve repeated placements, stats, conflicts and current-setting prices", () => {
    const { ctx, state } = view();
    const parent = Object.freeze({ id: "p", name: "Parent", recoil_modifier: -0.1,
        trader_vendor: "mechanic", trader_min_level: 2, trader_price_rub: 100 });
    const child = Object.freeze({ id: "c", name: "子件", recoil_modifier: -0.05 });
    const legacy = { base: { total_ergo: 20, total_weight: 2, evo_ergo_delta: 4, recoil_vertical: 100 },
        combos: [{ parent_item: parent, child_items: [child, child], child_slot_ids: ["s1", "s2"],
            child_slot_parent_item_ids: ["p", "c"], all_child_slot_ids: ["s1"], all_nested_slot_ids: ["s2"],
            total_ergo: 24, total_weight: 3, evo_ergo_delta: 6, recoil_vertical: 80, recoil_horizontal: 90,
            conflict: { conflicting_item_id: "x", conflict_name: "外部配件" } }] };
    const wire = compact(legacy), snapshot = JSON.stringify(wire);
    state.fleaCachePvp = { c: 50 };
    const actual = ctx._prepareComboItems(wire);
    assert.deepEqual(plain(actual), plain(ctx._prepareComboItems(legacy)));
    const entry = actual[0];
    assert.equal(entry.childItems[0], entry.childItems[1]);
    assert.deepEqual(plain(entry.childSlotIds), ["s1", "s2"]);
    assert.deepEqual(plain(entry.childSlotParentItemIds), ["p", "c"]);
    assert.deepEqual([entry.simErgo, entry.comboErgoDelta, entry.comboWeightDelta, entry.comboEEDDelta], [24, 4, 1, 2]);
    assert.ok(Math.abs(entry.comboRecoilPct + 20) < 1e-10);
    assert.equal(entry.totalPrice, 200);
    assert.ok(Math.abs(entry.comboRublePerRecoil - 10) < 1e-10);
    assert.equal(entry.sortName, "parent 子件 子件");
    assert.deepEqual(plain(entry.conflict), legacy.combos[0].conflict);
    state.priceMode = "pve";
    state.fleaCachePve = { p: 40, c: 20 };
    assert.equal(ctx._prepareComboItems(wire)[0].totalPrice, 80);
    state.fleaCachePve = {};
    state.traderLevels.mechanic = 1;
    assert.equal(ctx._prepareComboItems(wire)[0].totalPrice, null);
    state.fleaCachePve = { c: 0 };
    assert.equal(ctx._prepareComboItems(wire)[0].totalPrice, 0);
    assert.equal(JSON.stringify(wire), snapshot);
    delete legacy.base.recoil_vertical;
    assert.equal(ctx._prepareComboItems(compact(legacy))[0].comboRecoilPct, -20);
});

test("visibility uses only displayed combos and combines evidence across rows", () => {
    const { ctx, classes } = view();
    const entry = (item, delta = 0, price = null) => ({ parentEntry: { item }, childItems: [], comboEEDDelta: delta, totalPrice: price });
    ctx._updateComboColumnVisibility([entry({ weight: 1 }, 1), entry({ recoil_modifier: -0.1, ergonomics_modifier: 2 }, 0, 0)]);
    for (const name of ["weight", "recoil", "ergo", "evo", "price", "rub-recoil", "balance"]) {
        assert.equal(classes.has(`hide-col-${name}`), false, name);
    }
    ctx._updateComboColumnVisibility([entry({ weight: "0", recoil_modifier: 0, ergonomics_modifier: 0 }, 1)]);
    for (const name of ["weight", "recoil", "ergo", "evo", "price", "rub-recoil", "balance", "acc", "heat", "vel"]) {
        assert.equal(classes.has(`hide-col-${name}`), true, name);
    }
    ctx._updateComboColumnVisibility([entry({ recoil_modifier: "0", ergonomics_modifier: "0" }, 0.05)]);
    assert.equal(classes.has("hide-col-recoil"), false); // Existing non-null/strict-zero semantics.
    assert.equal(classes.has("hide-col-evo"), true); // The threshold is strictly greater than 0.05.
});
