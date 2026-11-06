/* eslint-env node */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../modules/atlas-lookup.js"), "utf8");
const ctx = vm.createContext({ window: {} });
vm.runInContext(source, ctx);
const m = ctx.window.EFTForge.atlasLookup._test;
const plain = value => JSON.parse(JSON.stringify(value));

test("item names fall back to the other language, then the template id", () => {
    assert.equal(m.itemName({ tpl: "x", en: { name: "Rifle" }, ch: { name: "" } }), "Rifle");
    assert.equal(m.itemName({ tpl: "x", en: { name: "" }, ch: { name: "步枪" } }), "步枪");
    assert.equal(m.itemName({ tpl: "x", en: {}, ch: {} }), "x");
    assert.equal(m.shortName({ tpl: "x", en: { name: "Rifle", short: "RFL" } }), "RFL");
});

test("slots read as the game names them", () => {
    assert.equal(m.slotLabel("FirstPrimaryWeapon"), "On sling");
    assert.equal(m.slotLabel("front_plate"), "Front plate");
    assert.equal(m.slotLabel("mod_mount_001"), "mount");
    // Without lang.js loaded, a matched slot falls back to the game's own name
    assert.equal(m.partLabel({ slot: "mod_scope", slot_name: "Scope" }), "scope");
});

test("errors from the upstream provider map to what the viewer can do", () => {
    assert.equal(m.errorText(403), "This needs the admin key.");
    assert.equal(m.errorText(503, "session"), "Atlas' upstream provider can't look players up right now. Try again later.");
    assert.equal(m.errorText(502, "backend"), "The game backend refused the lookup.");
    assert.equal(m.errorText(429), "Too many lookups. Try again later.");
});

test("digits are an account ID, anything nickname-shaped is searched", () => {
    assert.equal(m.queryKind("1000002"), "account");
    assert.equal(m.queryKind("target_x"), "nickname");
    assert.equal(m.queryKind("ab"), null);
    assert.equal(m.queryKind("a b"), null);
});

test("no builder link without build-codes.js or a payload", () => {
    assert.equal(m.builderLink(null), null);
    assert.equal(m.builderLink({ payload: { v: 1, g: "x", p: [] } }), null);
});

test("a weapon becomes the builder's tree, by our slot ids, skipping unmatched parts", () => {
    const gun = { tpl: "gun", render: "data:x", en: { name: "AK", short: "AK" }, children: [
        { slot: "mod_reciever", slot_id: "s-rec", tpl: "rec", icon: "r.webp", en: { short: "DLR" },
          children: [{ slot: "mod_scope", slot_id: "s-scope", tpl: "scope", children: [] }] },
        { slot: "patron_in_weapon", tpl: "bp", children: [] },
    ] };
    const tree = plain(m.builderTree(gun));
    assert.equal(tree.item.id, "gun");
    assert.equal(tree.item.image_512_link, "data:x");
    assert.deepEqual(Object.keys(tree.children), ["s-rec"]);
    assert.equal(tree.children["s-rec"].item.short_name, "DLR");
    assert.deepEqual(Object.keys(tree.children["s-rec"].children), ["s-scope"]);
});

test("level badges and prestige icons are tarkov.dev's", () => {
    assert.equal(m.levelBadge(57), "https://assets.tarkov.dev/player-level-group-12.png");
    assert.equal(m.levelBadge(4), "https://assets.tarkov.dev/player-level-group-1.png");
    assert.equal(m.levelBadge(79), "https://assets.tarkov.dev/player-level-group-16.png");
    assert.equal(m.levelBadge(null), null);
    assert.equal(m.prestigeIcon(2), "https://assets.tarkov.dev/prestige-2-icon.webp");
    assert.equal(m.prestigeIcon(0), null);
});

test("overall stats read the game's counters", () => {
    const pmc = { time: 11039413, counters: [
        [["Sessions", "Pmc"], 383], [["ExitStatus", "Killed", "Pmc"], 187], [["Kills"], 2570], [["Deaths"], 187],
        [["KilledPmc"], 277], [["ExitStatus", "Survived", "Pmc"], 169], [["LongestWinStreak", "Pmc"], 11],
        [["ExitStatus", "Runner", "Pmc"], 5], [["ExitStatus", "Transit", "Pmc"], 22],
    ] };
    const stats = Object.fromEntries(plain(m.sideStats(pmc, "Pmc")));
    assert.equal(stats.raids, "383");
    assert.equal(stats.survived, "169");
    assert.equal(stats.kia, "187");
    assert.equal(stats.mia, "0");
    assert.equal(stats.online, "3,066h30m");
    assert.equal(stats.rate, "44 %");
    assert.equal(stats.kd, "1.48");
    assert.equal(stats.streak, "11");
});

test("inserts sit around their parent as in the workbench", () => {
    assert.deepEqual(plain(m.insertSpot("front", 234.5, 361)), [269, 516]);
    assert.deepEqual(plain(m.insertSpot("back", 234.5, 361)), [269, 253]);
    assert.deepEqual(plain(m.insertSpot("left", 234.5, 120)), [170.5, 154.5]);
});

test("containers open when something is inside them", () => {
    assert.equal(m.hasInside({ contents: [{ tpl: "x" }] }), true);
    assert.equal(m.hasInside({ ammo: [{ tpl: "a", count: 30 }] }), true);
    assert.equal(m.hasInside({ contents: [], children: [{ tpl: "plate" }] }), false);
    assert.equal(m.hasInside(null), false);
});

test("a container lists its items in grid order, then its rounds", () => {
    const tiles = m.insideTiles({
        contents: [
            { tpl: "low", x: 0, y: 2 },
            { tpl: "right", x: 3, y: 0, count: 5 },
            { tpl: "left", x: 0, y: 0 },
        ],
        ammo: [{ tpl: "ps", count: 60 }],
    });
    assert.deepEqual(plain(tiles.map(e => [e.node.tpl, e.index, e.count])),
        [["left", 2, 0], ["right", 1, 5], ["low", 0, 0], ["ps", -1, 60]]);
});

test("the open path follows containers down and stops where it no longer matches", () => {
    const wallet = { tpl: "wallet", contents: [{ tpl: "cash", count: 5 }] };
    const slots = [{ slot: "Backpack", tpl: "pack", contents: [{ tpl: "ledx" }, wallet] }];
    assert.deepEqual(plain(m.openTrail(slots, { slot: "Backpack", path: [1] }).map(n => n.tpl)), ["pack", "wallet"]);
    // The ledx holds nothing, so the path stops at the backpack
    assert.deepEqual(plain(m.openTrail(slots, { slot: "Backpack", path: [0, 3] }).map(n => n.tpl)), ["pack"]);
    assert.deepEqual(plain(m.openTrail(slots, { slot: "TacticalVest", path: [] })), []);
    assert.deepEqual(plain(m.openTrail(slots, null)), []);
});

test("weapons and containers with grids open even when empty", () => {
    assert.equal(m.openable({ build: { payload: {} } }), true);
    assert.equal(m.openable({ grid: { w: 189, h: 191, grids: [] }, contents: [] }), true);
    assert.equal(m.openable({ tpl: "helmet", children: [{ tpl: "visor" }] }), false);
    const trail = m.openTrail([{ slot: "Backpack", tpl: "pack", grid: { grids: [] }, contents: [{ tpl: "case", grid: { grids: [] } }] }],
        { slot: "Backpack", path: [0] });
    assert.deepEqual(plain(trail.map(n => n.tpl)), ["pack", "case"]);
});

test("the primary weapon opens first, then the back one, then the pistol", () => {
    const gun = slot => ({ slot, build: { payload: {} } });
    assert.deepEqual(plain(m.firstOpen([gun("Holster"), gun("FirstPrimaryWeapon")])), { slot: "FirstPrimaryWeapon", path: [] });
    assert.deepEqual(plain(m.firstOpen([gun("Holster")])), { slot: "Holster", path: [] });
    assert.equal(m.firstOpen([{ slot: "Headwear" }]), null);
});

test("an item sits at its cells, turned when it lies the other way", () => {
    assert.deepEqual(plain(m.placement({ size: [2, 1], x: 3, y: 1 })), { x: 189, y: 63, w: 127, h: 64, baseW: 127, baseH: 64 });
    assert.deepEqual(plain(m.placement({ size: [2, 1], x: 0, y: 0, rotated: true })), { x: 0, y: 0, w: 64, h: 127, baseW: 127, baseH: 64 });
    assert.deepEqual(plain(m.placement({})), { x: 0, y: 0, w: 64, h: 64, baseW: 64, baseH: 64 });
});
