/* eslint-env node */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../modules/atlas.js"), "utf8");
const ctx = vm.createContext({ window: {} });
vm.runInContext(source, ctx);
const atlas = ctx.window.EFTForge.atlas._test;
const plain = value => JSON.parse(JSON.stringify(value));

const AMMO = "54527a984bdc2d4e668b4567";
const TRADER = "5ac3b934156ae10c4430e83c";
const set = {
    id: "abc1234",
    names: {
        [AMMO]: { en: "M855A1", ch: "M855A1弹" },
        [TRADER]: { en: "Ragman", ch: "耶格" },
    },
    files: [
        { file: "client/items", changes: [
            { path: ["data", AMMO, "_props", "PenetrationPower"], kind: "changed", old: 44, new: 45 },
            { path: ["data", AMMO, "_props", "Weight"], kind: "changed", old: 0.012, new: 0.0121 },
        ] },
        { file: "client/locale/en", changes: [
            { path: ["data", `${AMMO} Description`], kind: "changed", old: "a", new: "b" },
        ] },
        { file: `client/items/prices/${TRADER}`, changes: [
            { path: ["data", "barter_scheme", "6ad283d2a47e91baff0b144c", 0, 0, "count"], kind: "changed", old: 145.26, new: 145.47 },
        ] },
        { file: "client/globals", changes: [
            { path: ["data", "config", "SomeFlag"], kind: "added", new: true },
            { path: [], kind: "removed", old: { "$atlas_value": 0, bytes: 70000 } },
        ] },
    ],
};

test("ids are found whole or leading a locale key", () => {
    assert.equal(atlas.idIn(AMMO), AMMO);
    assert.equal(atlas.idIn(`${AMMO} Name`), AMMO);
    assert.equal(atlas.idIn(`${AMMO}x`), null);
    assert.equal(atlas.idIn(3), null);
});

test("names follow the language and fall back to the other one", () => {
    assert.equal(atlas.nameOf(AMMO, set.names, "zh"), "M855A1弹");
    assert.equal(atlas.nameOf(AMMO, { [AMMO]: { en: "M855A1", ch: null } }, "zh"), "M855A1");
    assert.equal(atlas.fileLabel(`client/items/prices/${TRADER}`, set.names, "en"), "items/prices/Ragman");
});

test("by file: one group per file and id or top level key", () => {
    const groups = atlas.groupRows(atlas.prepare(set), "file");
    assert.deepEqual(plain(groups.map(g => [g.file, g.seg, g.rows.length])), [
        ["client/items", AMMO, 2],
        ["client/locale/en", AMMO, 1],
        [`client/items/prices/${TRADER}`, "6ad283d2a47e91baff0b144c", 1],
        ["client/globals", "config", 1],
        ["client/globals", "", 1],
    ]);
});

test("by item: one id's changes across files share a group", () => {
    const groups = atlas.groupRows(atlas.prepare(set), "item");
    const ammo = groups.find(g => g.id === AMMO);
    assert.equal(ammo.rows.length, 3);
    assert.deepEqual([...ammo.files], ["client/items", "client/locale/en"]);
    assert.deepEqual(plain(ammo.counts), { added: 0, removed: 0, changed: 3 });
});

test("the shown path starts below the group and keeps a locale key's suffix", () => {
    const rows = atlas.prepare(set);
    assert.deepEqual(plain(atlas.restPath(rows[0])), ["_props", "PenetrationPower"]);
    assert.deepEqual(plain(atlas.restPath(rows[2])), ["Description"]);
    assert.deepEqual(plain(atlas.restPath(rows[3])), [0, 0, "count"]);
    assert.deepEqual(plain(atlas.restPath(rows[5])), []);
});

test("filters: kind, file and every search term, names included", () => {
    const rows = atlas.prepare(set);
    assert.equal(atlas.filterRows(rows, { kinds: ["added"] }).length, 1);
    assert.equal(atlas.filterRows(rows, { kinds: new Set(["added", "removed"]) }).length, 2);
    assert.equal(atlas.filterRows(rows, { kinds: [] }).length, 0);
    assert.equal(atlas.filterRows(rows, { file: "client/items" }).length, 2);
    assert.equal(atlas.filterRows(rows, { query: "m855a1弹" }).length, 3);
    assert.equal(atlas.filterRows(rows, { query: "ragman count" }).length, 1);
    assert.equal(atlas.filterRows(rows, { query: "penetration 45" }).length, 1);
    assert.equal(atlas.filterRows(rows, { query: "nothing-like-this" }).length, 0);
});

test("new items: a whole item added under data in client/items, with its other rows", () => {
    const NEW = "6a86e48f7fa69db5960f020b";
    const rows = atlas.prepare({
        names: {},
        files: [
            { file: "client/items", changes: [
                { path: ["data", NEW], kind: "added", new: { _id: NEW } },
                { path: ["data", AMMO, "_props", "Tracer"], kind: "added", new: true },
                { path: ["data", "Dogtag BEAR"], kind: "added", new: {} },
            ] },
            { file: "client/locale/en", changes: [
                { path: ["data", `${NEW} Name`], kind: "added", new: "EXFIL Brothers" },
                { path: ["data", AMMO], kind: "added", new: "not an item" },
            ] },
            { file: "client/globals", changes: [
                { path: ["data", NEW], kind: "added", new: {} },
            ] },
        ],
    });
    assert.deepEqual(plain(rows.map(r => atlas.isNewItem(r))), [true, false, false, false, false, false]);
    const ids = atlas.newItemIds(rows);
    assert.deepEqual(plain([...ids]), [NEW]);
    assert.equal(rows.filter(r => ids.has(r.id)).length, 3);
    assert.deepEqual(plain(rows.map(r => atlas.rowKind(r, ids))), ["new", "added", "added", "new", "added", "new"]);
});

test("numeric deltas drop float noise; large value markers are recognised", () => {
    assert.equal(atlas.numericDelta(145.26, 145.47), 0.21);
    assert.equal(atlas.numericDelta(1, 1), null);
    assert.equal(atlas.numericDelta("1", 2), null);
    assert.deepEqual(plain(atlas.largeRef({ "$atlas_value": 3, bytes: 70000 })), { ref: 3, bytes: 70000 });
    assert.equal(atlas.largeRef({ bytes: 1 }), null);
    assert.equal(atlas.largeRef({ "$atlas_value": "3", bytes: 1 }), null);
    assert.equal(atlas.largeRef([1]), null);
    assert.equal(atlas.formatBytes(70000), "68 KB");
    assert.equal(atlas.scalarText("a\nb"), '"a\nb"');
    assert.equal(atlas.scalarText('say "hi"\t\\n'), '"say \\"hi\\"\\t\\\\n"');
    assert.equal(atlas.scalarText(1.5), "1.5");
});

test("raw view: rows sort by file then path, and print as a tarkov-changes style tree", () => {
    const rows = atlas.prepare(set).slice().sort(atlas.compareRows);
    const lines = plain(atlas.rawEntries(rows)).map(e =>
        e.type === "file" ? `# ${e.file}`
        : e.type === "node" ? `${" ".repeat(4 * e.depth)}['${e.seg}']`
        : `${e.sign}${" ".repeat(4 * e.depth)}${e.tag}${e.key != null ? ` ['${e.key}']:` : ""} ${JSON.stringify(e.value)}${e.pct ? ` ${e.pct}` : ""}`);
    assert.deepEqual(lines, [
        "# client/items",
        "['data']",
        `    ['${AMMO}']`,
        "        ['_props']",
        "            ['PenetrationPower']",
        "-            old 44",
        "+            new 45 (+2.27%)",
        "            ['Weight']",
        "-            old 0.012",
        "+            new 0.0121 (+0.83%)",
        "# client/locale/en",
        "['data']",
        `    ['${AMMO} Description']`,
        "-    old \"a\"",
        "+    new \"b\"",
        `# client/items/prices/${TRADER}`,
        "['data']",
        "    ['barter_scheme']",
        "        ['6ad283d2a47e91baff0b144c']",
        "            ['0']",
        "                ['0']",
        "                    ['count']",
        "-                    old 145.26",
        "+                    new 145.47 (+0.14%)",
        "# client/globals",
        "-removed {\"$atlas_value\":0,\"bytes\":70000}",
        "['data']",
        "    ['config']",
        "+        new ['SomeFlag']: true",
    ]);
    assert.equal(atlas.percentChange(0, 5), null);
    assert.equal(atlas.percentChange(23.45, 23.4242039), "(-0.11%)");
});

test("export: the whole set as text, ids with names and large values in full", () => {
    const full = { ...set, version: "0.16.9.1", detected: "2026-10-20T08:00:00Z", total: 7 };
    assert.deepEqual(plain(atlas.largeRefsIn(full)), [0]);
    const text = atlas.exportText(full, "en", new Map([[0, { a: 1 }]]));
    const lines = text.split("\n");
    assert.deepEqual(lines.slice(0, 4), ["Version: 0.16.9.1", "Detected: 2026-10-20T08:00:00Z", "7 changes", ""]);
    assert.ok(lines.includes(`    ['${AMMO}'] M855A1`));
    assert.ok(lines.includes(`    ['${AMMO} Description'] M855A1`));
    assert.ok(lines.includes("+            (New) 45 (+2.27%)"));
    assert.ok(lines.includes("+        (New) ['SomeFlag']: true"));
    assert.deepEqual(lines.slice(lines.indexOf("client/globals/response.json") + 1, lines.indexOf("client/globals/response.json") + 4),
        ["-(Removed) {", "-      \"a\": 1", "-    }"]);
    assert.ok(atlas.exportText(full, "zh", new Map([[0, 1]])).includes(`['${AMMO}'] M855A1弹`));
    assert.equal(atlas.exportName({ id: "abc1234", version: "0.16 beta/1" }), "atlas-0.16_beta_1-abc1234.txt");
    assert.equal(atlas.exportName({ id: "abc1234", game: "arena", version: "0.6.1" }), "atlas-arena-0.6.1-abc1234.txt");
});

// /atlas/arena is the same page (atlas.js picks the game from the path), so the two
// files must never drift apart
test("the Arena page is a copy of the Atlas page", () => {
    const page = name => fs.readFileSync(path.join(__dirname, "..", "atlas", ...name), "utf8");
    assert.equal(page(["arena", "index.html"]), page(["index.html"]));
});
