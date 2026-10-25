/* eslint-env node */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../modules/atlas-matching.js"), "utf8");
const ctx = vm.createContext({ window: {} });
vm.runInContext(source, ctx);
const m = ctx.window.EFTForge.atlasMatching._test;
const plain = value => JSON.parse(JSON.stringify(value));

const DCS = [
    { region: "EUR", name: "Europe West", wait: 31 },
    { region: "ASI", name: "Japan", wait: 144 },
    { region: "ME", name: "Me   Dubai", wait: 646 },
    { region: "EUR", name: "Europe East", wait: 43 },
    { region: "SAM", name: "Sa   Colombia", wait: null },
];

test("waits read as minutes and seconds, and get a tone", () => {
    assert.equal(m.formatWait(31), "0:31");
    assert.equal(m.formatWait(646), "10:46");
    assert.equal(m.formatWait(59.6), "1:00");
    assert.equal(m.formatWait(null), "-");
    assert.equal(m.waitTone(60), "fast");
    assert.equal(m.waitTone(61), "ok");
    assert.equal(m.waitTone(181), "slow");
    assert.equal(m.waitTone(null), "");
});

test("a region prefix in the backend's name is dropped only when it repeats the region", () => {
    assert.equal(m.displayName("Me   Dubai", "ME"), "Dubai");
    assert.equal(m.displayName("Sa   Colombia", "SAM"), "Colombia");
    assert.equal(m.displayName("Af Nigeria", "AF"), "Nigeria");
    assert.equal(m.displayName("Europe West", "EUR"), "Europe West");
    assert.equal(m.displayName("Me   Dubai", "EUR"), "Me Dubai");
});

test("stats skip gaps", () => {
    assert.deepEqual(plain(m.seriesStats([30, null, 50, 40])), { min: 30, avg: 40, max: 50 });
    assert.deepEqual(plain(m.seriesStats([null])), { min: null, avg: null, max: null });
});

test("regions are listed fastest first, each with its quickest datacenter", () => {
    const regions = m.regionSummaries(DCS);
    assert.deepEqual(plain(regions.map(r => r.region)), ["EUR", "ASI", "ME", "SAM"]);
    assert.equal(regions[0].count, 2);
    assert.equal(regions[0].fastest.name, "Europe West");
    assert.equal(regions[3].fastest, null);  // no wait reported: listed last
});

test("rows sort by wait, region or name, with unknown waits last", () => {
    assert.deepEqual(plain(m.sortRows(DCS, "wait").map(r => r.name)), ["Europe West", "Europe East", "Japan", "Me   Dubai", "Sa   Colombia"]);
    assert.deepEqual(plain(m.sortRows(DCS, "region").map(r => r.name)), ["Japan", "Europe West", "Europe East", "Me   Dubai", "Sa   Colombia"]);
    // by the shown name: "Colombia", "Dubai", ...
    assert.deepEqual(plain(m.sortRows(DCS, "name").map(r => r.name)), ["Sa   Colombia", "Me   Dubai", "Europe East", "Europe West", "Japan"]);
    assert.equal(DCS[0].name, "Europe West");  // the input stays as it was
});

test("sparklines split at gaps and scale from zero to the series' max", () => {
    // points sit in the middle of their bucket: 3.75, 11.25, 26.25 of 30
    const segments = m.sparkSegments([0, 100, null, 50], 30, 12);
    assert.equal(segments.length, 2);
    assert.equal(segments[0], "3.8,11 11.3,1");
    assert.equal(segments[1], "26.3,6 27.3,6");   // a lone point becomes a short dash
    assert.deepEqual(plain(m.sparkSegments([null, 5, null], 30, 12)), ["15,1 16,1"]);
    assert.deepEqual(plain(m.sparkSegments([], 20, 12)), []);
});

test("the crosshair snaps to the bucket under the pointer, at its middle", () => {
    assert.equal(m.bucketAt(0, 288), 0);
    assert.equal(m.bucketAt(0.5, 288), 144);
    assert.equal(m.bucketAt(1, 288), 287);      // the right edge is the last bucket
    assert.equal(m.bucketAt(-0.1, 288), 0);     // a pointer just outside stays on the ends
    assert.equal(m.bucketAt(1.3, 288), 287);
    assert.equal(m.bucketX(0, 4), 0.125);
    assert.equal(m.bucketX(3, 4), 0.875);
});

test("axis ticks fall on whole UTC+8 hours or days, none at the edges", () => {
    const start = Date.UTC(2026, 9, 25, 0, 0) / 1000;   // 08:00 UTC+8
    const hourly = m.timeTicks(start, 300, 288, 24);    // every 3 h over 24 h
    const local = tick => new Date((tick.t + 8 * 3600) * 1000).getUTCHours();
    assert.deepEqual(plain(hourly.map(local)), [9, 12, 15, 18, 21, 0, 3, 6]);
    assert.ok(Math.abs(hourly[0].x - 1 / 24) < 1e-9);
    const daily = m.timeTicks(start, 2100, 288, 168);
    assert.ok(daily.length >= 6 && daily.every(tick => local(tick) === 0));
    assert.deepEqual(plain(m.timeTicks(start, 300, 72, 6).map(local)), [9, 10, 11, 12, 13]);
});

test("the detail chart's wait axis uses clean steps just past the max", () => {
    assert.deepEqual(plain(m.waitTicks(41)), { top: 45, ticks: [0, 15, 30, 45] });
    assert.deepEqual(plain(m.waitTicks(100)), { top: 120, ticks: [0, 30, 60, 90, 120] });
    assert.deepEqual(plain(m.waitTicks(646)), { top: 900, ticks: [0, 300, 600, 900] });
    assert.deepEqual(plain(m.waitTicks(1)), { top: 15, ticks: [0, 15] });
});

test("the detail chart's line and wash split at gaps and close on the baseline", () => {
    const paths = m.detailPaths([0, 60, null, 30], 60, 1000, 100);
    assert.equal(paths.length, 2);
    assert.equal(paths[0].line, "M125,100 L375,0");
    assert.equal(paths[0].area, "M125,100 L375,0 L375,100 L125,100 Z");
    assert.equal(paths[1].line, "M874,50 L876,50");   // a lone point becomes a short dash
    assert.deepEqual(plain(m.detailPaths([null, null], 60)), []);
});

test("axis ticks follow the viewer's own zone, half hours and daylight saving included", () => {
    const start = Date.UTC(2026, 9, 25, 0, 0) / 1000;
    const localHour = offset => tick => new Date((tick.t + offset(tick.t)) * 1000).getUTCHours();
    const edt = () => -4 * 3600;
    assert.deepEqual(plain(m.timeTicks(start, 300, 288, 24, edt).map(localHour(edt))), [21, 0, 3, 6, 9, 12, 15, 18]);
    const india = () => 5.5 * 3600;   // ticks on whole Indian hours, i.e. :30 past in UTC
    const ist = m.timeTicks(start, 300, 72, 6, india);
    assert.ok(ist.length && ist.every(tick => (tick.t + india()) % 3600 === 0));
    // clocks go back an hour mid-range (EDT to EST): daily ticks stay on local midnight
    const change = start + 3 * 86400;
    const us = t => (t < change ? -4 : -5) * 3600;
    const daily = m.timeTicks(start, 2100, 288, 168, us);
    assert.ok(daily.length >= 6 && daily.every(tick => localHour(us)(tick) === 0));
});
