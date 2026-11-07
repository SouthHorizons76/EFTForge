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
    assert.equal(m.errorInfo(503, "session").text, "Atlas' upstream provider can't look players up right now. Try again later.");
    assert.equal(m.errorInfo(502, "backend").title, "Lookup refused");
    // a rate limit says how long to wait; a full house says to retry shortly
    assert.equal(m.errorInfo(429, "rate", 42).text, "Too many lookups from your connection. Try again in 42 seconds.");
    assert.equal(m.errorInfo(429, "busy").title, "Lookups busy");
    assert.equal(m.errorInfo(503, "unavailable").title, "Player lookup unavailable");
    // only what another game mode might answer offers the other modes
    assert.equal(m.errorInfo(404, "not_found").modes, "try");
    assert.match(m.errorInfo(404, "not_found").text, /switch the mode above/);
    assert.equal(m.errorInfo(404, "mode").modes, "pick");
    // an account that never played the mode
    assert.equal(m.errorInfo(404, "no_profile").title, "No profile in this game mode");
    assert.match(m.errorInfo(404, "no_profile").text, /^That account has no profile in PVP S\./);
    assert.equal(m.errorInfo(502, "backend").modes, null);
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

test("level badges are the game's, one per five levels; prestige icons are tarkov.dev's", () => {
    assert.equal(m.rankIcon(57), "/assets/images/atlas-lookup/ui/rank60.webp");
    assert.equal(m.rankIcon(4), "/assets/images/atlas-lookup/ui/rank5.webp");
    assert.equal(m.rankIcon(79), "/assets/images/atlas-lookup/ui/rank80.webp");
    assert.equal(m.rankIcon(80), "/assets/images/atlas-lookup/ui/rank80.webp");
    assert.equal(m.rankIcon(null), null);
    assert.equal(m.prestigeIcon(2), "https://assets.tarkov.dev/prestige-2-icon.webp");
    assert.equal(m.prestigeIcon(0), null);
});

test("the dashboard reads the game's counters, PMC and Scav together", () => {
    const pmc = { time: 11039413, counters: [
        [["Sessions", "Pmc"], 383], [["ExitStatus", "Killed", "Pmc"], 187], [["Kills"], 2570], [["Deaths"], 187],
        [["KilledPmc"], 277], [["ExitStatus", "Survived", "Pmc"], 169], [["LongestWinStreak", "Pmc"], 11],
        [["ExitStatus", "Runner", "Pmc"], 5], [["ExitStatus", "Transit", "Pmc"], 22],
    ] };
    const scav = { time: 7920, counters: [
        [["Sessions", "Scav"], 24], [["ExitStatus", "Survived", "Scav"], 18], [["Kills"], 24], [["Deaths"], 6],
        [["KilledPmc"], 1], [["ExitStatus", "Left", "Scav"], 1], [["LongestWinStreak", "Scav"], 7],
    ] };
    const pmcOnly = plain(m.dashStats({ pmc, scav }, "pmc"));
    assert.equal(pmcOnly.raids, 383);
    assert.equal(pmcOnly.survivalRate, 44);
    assert.equal(pmcOnly.kd, "1.48");
    const all = plain(m.dashStats({ pmc, scav }, "overall"));
    const first = Object.fromEntries(all.first);
    const second = Object.fromEntries(all.second);
    assert.equal(first.raids, 407);
    assert.equal(first.survived, 209);    // 169 + 18 survived and 22 transits, as the game counts them
    assert.equal(first.kills, 278);      // "(K) Kills" is players killed, as in game
    assert.equal(first.awol, 1);
    assert.equal(first.online, "3066h30m");   // the account's time, never added up
    assert.equal(second.streak, 18);     // the PMC's and the Scav's added, as in game
    assert.equal(second.kd, "1.44");
    assert.equal(second.lifespan, "-");
    assert.equal(all.aiKills, 2594 - 278);
    assert.equal(all.transits, 22);
});

test("big numbers are split in threes with spaces, as in game", () => {
    assert.equal(m.spaced(15095378), "15 095 378");
    assert.equal(m.spaced(812), "812");
    assert.equal(m.spaced(undefined), "-");
});

test("skills fall in the game's classes", () => {
    assert.equal(m.skillClass("Endurance"), "physical");
    assert.equal(m.skillClass("Charisma"), "mental");
    assert.equal(m.skillClass("AimDrills"), "combat");
    assert.equal(m.skillClass("HideoutManagement"), "practical");
});

test("achievement progress reads as the game writes it", () => {
    const prog = plain(m.achievementProgress({ total: 131, done: new Array(31).fill({}) }));
    assert.deepEqual([prog.done, prog.total], [31, 131]);
    assert.equal(prog.text, "31 out of 131 achievements earned (24%)");
});

test("inserts sit around their parent as in the workbench", () => {
    assert.deepEqual(plain(m.insertSpot("front", 189, 281)), [227.5, 410]);
    assert.deepEqual(plain(m.insertSpot("back", 189, 281)), [227.5, 207]);
    assert.deepEqual(plain(m.insertSpot("left", 189, 100)), [137, 138.5]);
});

test("only weapons open below the board", () => {
    assert.equal(m.openable({ build: { payload: {} } }), true);
    assert.equal(m.openable({ tpl: "pack", children: [] }), false);
    assert.equal(m.openable({ tpl: "helmet", children: [{ tpl: "visor" }] }), false);
    assert.equal(m.openable(null), false);
});

test("achievement icons are tarkov.dev's", () => {
    assert.equal(m.achievementIcon("6512ea46f7a078264a4376e4"),
        "https://assets.tarkov.dev/achievement-6512ea46f7a078264a4376e4-icon.webp");
    assert.equal(m.achievementIcon("../x"), null);
});

test("editions read from the member category bits", () => {
    assert.deepEqual(plain(m.editions(1026)), ["EOD", "Unheard"]);
    assert.deepEqual(plain(m.editions(2)), ["EOD"]);
    assert.deepEqual(plain(m.editions(0)), []);
    assert.deepEqual(plain(m.editions(null)), []);
});

test("modifier icons from tarkov.dev by the modifier's id, only when it looks like one", () => {
    assert.equal(m.perkIcon({ id: "69c41a19cd28c936320a7523" }),
        "https://assets.tarkov.dev/69c41a19cd28c936320a7523.webp");
    assert.equal(m.perkIcon({ id: "../x" }), null);
    assert.equal(m.perkIcon({ id: null }), null);
});

test("a modifier's hover card has its name, points and a line per effect, escaped", () => {
    const html = m.perkTooltipHtml({ id: "p", points: 3,
        en: { name: "Osteo<b>", description: "• Limb fracture chance +25%\n• Fall damage +25%" } });
    assert.match(html, /Osteo&lt;b&gt;/);
    assert.match(html, /\+3 points/);
    assert.match(html, /<li>Limb fracture chance \+25%<\/li><li>Fall damage \+25%<\/li>/);
    assert.doesNotMatch(html, /<b>/);
});

test("tables sort numbers and text, blanks last either way", () => {
    const rows = [{ v: 2 }, { v: null }, { v: 10 }, { v: 1 }];
    assert.deepEqual(plain(m.sortRows(rows, r => r.v, 1).map(r => r.v)), [1, 2, 10, null]);
    assert.deepEqual(plain(m.sortRows(rows, r => r.v, -1).map(r => r.v)), [10, 2, 1, null]);
    const names = [{ v: "b" }, { v: "" }, { v: "a" }];
    assert.deepEqual(plain(m.sortRows(names, r => r.v, 1).map(r => r.v)), ["a", "b", ""]);
});

test("skills sort as the game sorts them, and filter by class", () => {
    const skills = [
        { id: "Endurance", progress: 1800, lastAccess: 3 },
        { id: "Charisma", progress: 2600, lastAccess: 1 },
        { id: "Metabolism", progress: 5100, lastAccess: 2 },
    ];
    // the game's own order (physical, then mental...), whatever order the profile sends them in
    assert.deepEqual(plain(m.skillOrder(skills, "default", "all").map(s => s.id)), ["Endurance", "Metabolism", "Charisma"]);
    assert.deepEqual(plain(m.skillOrder(skills, "level", "all").map(s => s.id)), ["Metabolism", "Charisma", "Endurance"]);
    assert.deepEqual(plain(m.skillOrder(skills, "recent", "all").map(s => s.id)), ["Endurance", "Metabolism", "Charisma"]);
    assert.deepEqual(plain(m.skillOrder(skills, "default", "mental").map(s => s.id)), ["Charisma"]);
});

test("last active is the latest skill gain or achievement, as tarkov.dev guesses it", () => {
    const data = {
        skills: { common: [{ id: "Endurance", lastAccess: 1700000000 }, { id: "Charisma", lastAccess: 0 }] },
        achievements: { done: [{ id: "a", at: 1750000000 }, { id: "b", at: 1600000000 }] },
    };
    assert.equal(m.lastActive(data), 1750000000);
    assert.equal(m.lastActive({ skills: { common: [{ lastAccess: 1700000000 }] } }), 1700000000);
    assert.equal(m.lastActive({}), 0);
});
