/* eslint-env node */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const LZString = require("../lzstring.min.js");

const source = fs.readFileSync(path.join(__dirname, "../modules/build-codes.js"), "utf8");
const EFTForge = {};
const context = vm.createContext({
    window: { EFTForge }, EFTForge, LZString, TextEncoder, TextDecoder, btoa, atob,
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../data/build-code-catalog-v1.js"), "utf8"), context);
vm.runInContext(source, context);
const plain = value => JSON.parse(JSON.stringify(value));
const encode = (payload, format) => context.encodeBuildCode(payload, format);
const decode = code => plain(context.decodeBuildCode(code));
const convert = (code, format) => context.convertBuildCode(code, format);

const oldCode = "N4IgbiBcCMA0IHMogKwEMDGA2LATAnAEboYBmGALAAxXRYDM9++A7GiPAA5QDaPqmHAWKZy1WgyatcHVPmyToADiykWLamSoV89QoXwgAurH4khREmJp1GzFqVkkWAJgCm+Clcr1SerPjQQVjGpgIKwt7itlJKVLJYVEosbjj00PQuuBS40C4YStCkBFiEoWaCeJailDaSzIVOmChUuGjQUTYsyrguyeXhFiJktRJ2+EouTRgsjGheNdH4LgxUblMmFRHVI9H1E-TTLRjKnWNMStkD5lXD1ucNFE5YFBho+LikFIS4GFn0KGgFCUhC8AWu8jSHhUag0VDIhCYLES7HgKBeII62h+fwI2SUIK8SieRhMIHYkFQeFIblIk16rio+lwOEJ6JYIAAvkA";

test("the existing share code converts to a shorter code without losing pairs or ammo", () => {
    const original = decode(oldCode);
    const compact = convert(oldCode, 2);
    assert.equal(original.p.length, 8);
    assert.ok(compact.startsWith("2."));
    assert.ok(compact.length < oldCode.length * 0.6);
    assert.deepEqual(decode(compact), original);
    assert.deepEqual(decode(convert(compact, 1)), original);
});

test("empty builds, UBGL ammo and nonstandard IDs round trip in both formats", () => {
    const payloads = [
        { v: 1, g: "5ac66d9b5acfc4001633997a", p: [] },
        { v: 1, g: "weapon:alpha", p: [["slot:1", "item:one"], ["slot:2", "item:two"]],
            a: "ammo:regular", ua: "ammo:grenade" },
        { v: 1, g: "5ac66d9b5acfc4001633997a", p: [
            ["5ac66d9b5acfc4001633997d", "59c6633186f7740cf0493bb9"],
            ["5ac66d9b5acfc4001633997f", "59c6633186f7740cf0493bb9"],
        ], ua: "56dfef82d2720bbd668b4567" },
    ];
    for (const payload of payloads) {
        const compact = encode(payload);
        assert.deepEqual(decode(compact), payload);
        assert.deepEqual(decode(convert(compact, 1)), payload);
        assert.deepEqual(decode(convert(encode(payload, 1), 2)), payload);
    }
});

test("invalid compact codes fail without reaching build loading", () => {
    const valid = encode({ v: 1, g: "5ac66d9b5acfc4001633997a", p: [] });
    assert.equal(context.decodeBuildCode(valid.slice(0, -2)), null);
    assert.equal(context.decodeBuildCode(valid + "A"), null);
    assert.equal(context.decodeBuildCode("2.not+url-safe"), null);
    assert.equal(context.convertBuildCode("bad code", 2), null);
});

// Compare against a fixture produced independently with Python and CRC-HQX.
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "data/build-code-golden.json"), "utf8"));

test("the 11-attachment example shrinks from 298 to 29 characters", () => {
    assert.deepEqual(decode(golden.v2), golden.payload);
    assert.equal(convert(golden.v2), golden.v3);
    assert.equal(encode(golden.payload), golden.v3);
    assert.equal(golden.v3.length, 29);
    assert.deepEqual(decode(golden.v3), golden.payload);
    assert.deepEqual(decode(convert(golden.v3, 1)), golden.payload);
    assert.deepEqual(decode(convert(golden.v3, 2)), golden.payload);
    assert.equal(convert(convert(golden.v3, 1)), golden.v3);
});

test("dictionary codes retain both ammo selections and repeated attachment pairs", () => {
    const payload = plain(golden.payload);
    payload.ua = payload.a;
    payload.p.push([...payload.p[0]]);
    assert.ok(encode(payload).startsWith("3."));
    assert.deepEqual(decode(encode(payload)), payload);
});

test("preserve known attachments outside the frozen slot candidate list", () => {
    const payload = plain(golden.payload);
    payload.p[payload.p.length - 1][1] = payload.g;
    assert.ok(encode(payload).startsWith("3."));
    assert.deepEqual(decode(encode(payload)), payload);
});

test("unknown items, unknown slots and non-parent-first order use lossless v2", () => {
    for (const change of [
        payload => { payload.p[0][1] = "future-item"; },
        payload => { payload.p[0][0] = "future-slot"; },
        payload => { payload.p.reverse(); },
    ]) {
        const payload = plain(golden.payload);
        change(payload);
        const code = encode(payload);
        assert.ok(code.startsWith("2."));
        assert.deepEqual(decode(code), payload);
    }
});

test("dictionary checksum rejects changed bytes and every truncated prefix", () => {
    for (let end = 2; end < golden.v3.length; end++) {
        assert.equal(context.decodeBuildCode(golden.v3.slice(0, end)), null);
    }
    for (let index = 2; index < golden.v3.length; index++) {
        const code = golden.v3.slice(0, index) + (golden.v3[index] === "A" ? "B" : "A") + golden.v3.slice(index + 1);
        assert.equal(context.decodeBuildCode(code), null);
    }
});

test("a missing catalog keeps full-ID exports usable and rejects catalog codes", () => {
    const catalog = EFTForge.buildCodeCatalogs[1];
    delete EFTForge.buildCodeCatalogs[1];
    try {
        const code = encode(golden.payload);
        assert.ok(code.startsWith("2."));
        assert.deepEqual(decode(code), golden.payload);
        assert.equal(context.decodeBuildCode(golden.v3), null);
    } finally {
        EFTForge.buildCodeCatalogs[1] = catalog;
    }
});

test("slot parents go to the first copy of a duplicated part with that slot free", () => {
    const slots = {
        gun: [{ id: "s_handguard" }],
        handguard: [{ id: "s_mount_a" }, { id: "s_cover" }],
        cover: [{ id: "s_mount_b" }],
        rail: [{ id: "s_tactical" }],
        ring: [{ id: "s_ring" }],
    };
    // Build 2190's layout: a handguard rail and a cover rail, each with its own Tactical part.
    const pairs = [
        ["s_handguard", "handguard"], ["s_mount_a", "rail"], ["s_cover", "cover"], ["s_tactical", "ring"],
        ["s_mount_b", "rail"], ["s_ring", "light"], ["s_tactical", "laser"],
    ];
    const root = { item: { id: "gun" }, children: {} };
    const parents = context.createSlotParentResolver(root, id => slots[id]);
    for (const [slotId, itemId] of pairs) {
        const parent = parents.parentFor(slotId);
        assert.ok(parent, `no parent for ${slotId}`);
        const node = { item: { id: itemId }, children: {} };
        parent.children[slotId] = node;
        parents.addNode(node);
    }
    const handguard = root.children.s_handguard;
    const railA = handguard.children.s_mount_a;
    const railB = handguard.children.s_cover.children.s_mount_b;
    assert.equal(railA.children.s_tactical.item.id, "ring");
    assert.equal(railA.children.s_tactical.children.s_ring.item.id, "light");
    assert.equal(railB.children.s_tactical.item.id, "laser");
    assert.deepEqual(plain(context.collectSlotPairs(root)), pairs);
    assert.equal(parents.parentFor("s_tactical"), null);
});

test("imports accept a bare code or any link carrying it in build=", () => {
    const extract = text => context.extractBuildCode(text);
    assert.equal(extract(`  ${oldCode}  `), oldCode);
    assert.equal(extract(`https://eftforge.com/?build=${encodeURIComponent(oldCode)}`), oldCode);
    assert.equal(extract(`https://www.eftforge.com/?lang=zh&build=${oldCode}#top`), oldCode);
    assert.equal(extract(`http://127.0.0.1:5500/?build=${encodeURIComponent("3.abc_-")}&x=1`), "3.abc_-");
    assert.equal(extract(""), "");
    assert.deepEqual(decode(extract(`https://eftforge.com/?build=${encodeURIComponent(oldCode)}`)), decode(oldCode));
});
