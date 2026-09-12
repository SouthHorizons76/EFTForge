/* eslint-env node */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../modules/api.js"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const data = { gun_id: "gun", points: [{ ergo: 40, recoil_v: 60, price: 1000 }], complete: true };
const progress = { type: "progress", phase: "boundary_low", done: 1, total: 3, point: null };
const stream = `data: ${JSON.stringify(progress)}\n\ndata: ${JSON.stringify({ type: "result", data })}\n\n`;

function request(options = {}) {
    const EFTForge = { config: { API_BASE: "" }, state: {} };
    const ctx = vm.createContext({ window: { EFTForge }, EFTForge, TextDecoder, DOMException });
    vm.runInContext(source, ctx);
    const controller = new AbortController();
    const bytes = Buffer.from(stream);
    let offset = 0;
    const events = [];
    ctx.fetch = async () => ({
        ok: options.status == null,
        status: options.status,
        headers: new Map([["content-type", "text/event-stream"]]),
        async json() { return options.errorBody ?? {}; },
        body: { getReader: () => ({
            async read() {
                if (offset === bytes.length) return { done: true };
                const value = bytes.subarray(offset);
                offset = bytes.length;
                return { done: false, value };
            },
            async cancel() {},
            releaseLock() {},
        }) },
    });
    const promise = ctx.exploreStream({ weapon_id: "gun" }, controller.signal, event => events.push(plain(event)));
    return { promise, events };
}

test("exploreStream resolves with the final result and forwards progress events", async () => {
    const run = request();
    assert.deepEqual(plain(await run.promise), data);
    assert.deepEqual(run.events, [progress]);
});

test("exploreStream surfaces a busy 429 with its reason_key instead of streaming", async () => {
    const run = request({ status: 429, errorBody: { detail: { reason_key: "optimizer.reason.serverBusy" } } });
    await assert.rejects(run.promise, err => {
        assert.equal(err.status, 429);
        assert.equal(err.reasonKey, "optimizer.reason.serverBusy");
        return true;
    });
    assert.deepEqual(run.events, []);
});
