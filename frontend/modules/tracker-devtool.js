/**
 * tracker-devtool.js
 *
 * Dev tool for the Stat Tracker panel. LOCALHOST ONLY - exits immediately
 * on any other hostname.
 *
 * Exposes EFTForge._dev.trackerInject() so the main dev-tools modal in
 * app.js can call it. Each call generates a fresh batch of random bogus
 * stat changes, monkey-patches EFTForge.api.fetchStatChangelog to return
 * them, and reloads the tracker panel if it is open.
 *
 * Returns the number of entries generated so the modal can display a
 * confirmation message.
 */
(function () {
    'use strict';

    if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;

    // ============================================================
    // FAKE DATA POOL
    // ============================================================

    const _FAKE_ATTACHMENTS = [
        { name: 'Gomidasu!',                            name_zh: 'Gomidasu！' },
        { name: 'Rail(ing your mom)',                   name_zh: '导轨（你的妈妈）' },
        { name: 'Zenit B-10M handguard',                name_zh: 'Zenit B-10M 护木' },
        { name: 'MP5 Navy 3-lug suppressor adapter',    name_zh: 'MP5 三卡口消声适配器' },
        { name: 'SAG AK-545 Short stock',               name_zh: 'SAG AK-545 短版枪托' },
        { name: 'Magpul MOE Carbine stock',             name_zh: 'Magpul MOE 卡宾枪托' },
        { name: 'B&T MP9/TP9 6-inch barrel',            name_zh: 'B&T MP9 6英寸枪管' },
        { name: 'Imported LaoGanMa',                    name_zh: '进口老干妈' },
        { name: 'CQBSS 8x scope',                       name_zh: 'CQBSS 8倍瞄准镜' },
        { name: 'Surefire SOCOM556-RC2 suppressor',     name_zh: 'Surefire SOCOM 消声器' },
        { name: 'Elcan SpecterDR 1-4x scope',           name_zh: 'Elcan SpecterDR 1-4x 瞄准镜' },
        { name: 'M4A1 14.5" CHF barrel',                name_zh: 'M4A1 14.5英寸冷锤枪管' },
        { name: 'Fortis SHIFT pistol grip',             name_zh: 'Fortis SHIFT 握把' },
        { name: 'SIG SAUER P226R stock grip',           name_zh: 'SIG P226R 原厂握把' },
        { name: 'Zenit PT-3 "Klassika" stock',          name_zh: 'Zenit PT-3 枪托' },
        { name: 'Seekins Precision NX15 handguard',     name_zh: 'Seekins Precision 护木' },
        { name: 'Potato',                               name_zh: '土豆' },
        { name: 'Hera Arms CQR pistol grip',            name_zh: 'Hera Arms CQR 握把' },
        { name: 'VS-33 foregrip',                       name_zh: 'VS-33 前握把' },
        { name: 'Mil-Spec M4 buffer tube',              name_zh: 'Mil-Spec M4 缓冲管' },
    ];

    const _FAKE_WEAPONS = [
        { name: 'AK-74M',                           name_zh: 'AK-74M' },
        { name: 'M4A1',                             name_zh: 'M4A1' },
        { name: 'HK 416A5',                         name_zh: 'HK 416A5' },
        { name: '2014 Honda Civic',                 name_zh: '2014 Honda Civic' },
        { name: 'DVL-10',                           name_zh: 'DVL-10' },
        { name: 'MP5 Navy 3-lug',                   name_zh: 'MP5 Navy' },
        { name: 'Remington R11 RSASS',              name_zh: 'Remington R11 RSASS' },
        { name: 'SV-98',                            name_zh: 'SV-98' },
        { name: 'MP7A2',                            name_zh: 'MP7A2' },
        { name: 'ADAR 2-15',                        name_zh: 'ADAR 2-15' },
    ];

    const _ATTACHMENT_STATS  = ['ergonomics_modifier', 'recoil_modifier', 'accuracy_modifier', 'weight'];
    const _WEAPON_STATS      = ['center_of_impact'];

    // Matches backend sync_tarkov_dev._NEW_ITEM_STAT
    const _NEW_ITEM_STAT = 'new_item';

    const _STAT_RANGES = {
        ergonomics_modifier: { min: -15,   max: 20,   step: 1,     decimals: 0 },
        // Fraction, not whole percent (e.g. -0.05 = -5%) - matches real recoil_modifier
        // storage. tracker.js's formatter scales this by 100 for display.
        recoil_modifier:     { min: -0.15, max: 0.10, step: 0.01,  decimals: 2 },
        // Already whole-percent scale (e.g. 7 = +7%) - matches real accuracy_modifier storage.
        accuracy_modifier:   { min: -15,   max: 15,   step: 1,     decimals: 0 },
        weight:              { min: 0.05,  max: 1.8,  step: 0.05,  decimals: 2 },
        center_of_impact:    { min: 0.2,   max: 1.5,  step: 0.025, decimals: 3 },
    };

    // ============================================================
    // HELPERS
    // ============================================================

    function _rnd(min, max, step) {
        const steps = Math.floor((max - min) / step);
        return min + Math.floor(Math.random() * (steps + 1)) * step;
    }

    function _round(v, dec) {
        return Math.round(v * Math.pow(10, dec)) / Math.pow(10, dec);
    }

    function _isoDate(daysAgo) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - daysAgo);
        return d.toISOString().slice(0, 10) + 'T00:00:00';
    }

    function _pick(arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    }

    // ============================================================
    // CORE - generate + inject
    // ============================================================

    function _makeEntry(item, statPool, date) {
        const stat    = _pick(statPool);
        const range   = _STAT_RANGES[stat];
        const oldVal  = _round(_rnd(range.min, range.max, range.step), range.decimals);
        const maxDelta = Math.max(range.step * 3, Math.abs(oldVal) * 0.30);
        let delta    = _round(_rnd(-maxDelta, maxDelta, range.step), range.decimals);
        if (delta === 0) delta = range.step;
        return {
            item_id:      'dev_' + Math.random().toString(36).slice(2, 9),
            item_name:    item.name,
            item_name_zh: item.name_zh,
            icon_link:    null,
            stat_name:    stat,
            old_value:    oldVal,
            new_value:    _round(oldVal + delta, range.decimals),
            detected_at:  date,
        };
    }

    function _makeNewItemEntry(item, date) {
        return {
            item_id:      'dev_' + Math.random().toString(36).slice(2, 9),
            item_name:    item.name,
            item_name_zh: item.name_zh,
            icon_link:    null,
            stat_name:    _NEW_ITEM_STAT,
            old_value:    null,
            new_value:    null,
            detected_at:  date,
        };
    }

    function injectNewBatch() {
        const entries = [];
        const numDates = 3 + Math.floor(Math.random() * 3);
        // A few days inside the recent window, plus older ones so the history picker
        // has something to page back through.
        const daysAgo = [];
        for (let d = 0; d < numDates; d++) daysAgo.push(Math.floor(d * 6 / Math.max(numDates - 1, 1)));
        daysAgo.push(15 + Math.floor(Math.random() * 10), 45 + Math.floor(Math.random() * 30), 200);
        daysAgo.forEach(function (ago) {
            const date = _isoDate(ago);
            const count = 2 + Math.floor(Math.random() * 7);
            for (let i = 0; i < count; i++) {
                const useWeapon = Math.random() < 0.25;
                entries.push(useWeapon
                    ? _makeEntry(_pick(_FAKE_WEAPONS),     _WEAPON_STATS,     date)
                    : _makeEntry(_pick(_FAKE_ATTACHMENTS), _ATTACHMENT_STATS, date)
                );
            }
            const newCount = Math.floor(Math.random() * 3);
            for (let n = 0; n < newCount; n++) {
                const pool = Math.random() < 0.25 ? _FAKE_WEAPONS : _FAKE_ATTACHMENTS;
                entries.push(_makeNewItemEntry(_pick(pool), date));
            }
        });

        // Mirror the backend: no date means the last 8 days, a date means that UTC day.
        EFTForge.api.fetchStatChangelog = function (date) {
            if (date) {
                return Promise.resolve(entries.filter(function (e) { return e.detected_at.slice(0, 10) === date; }));
            }
            const cutoff = _isoDate(8);
            return Promise.resolve(entries.filter(function (e) { return e.detected_at >= cutoff; }));
        };
        EFTForge.api.fetchStatChangelogDates = function () {
            const items = {};
            entries.forEach(function (e) {
                const day = e.detected_at.slice(0, 10);
                (items[day] = items[day] || new Set()).add(e.item_id);
            });
            return Promise.resolve(Object.keys(items).sort().reverse().map(function (day) {
                return { date: day, item_count: items[day].size };
            }));
        };
        if (window.EFTForge && EFTForge.tracker) EFTForge.tracker.reload();

        console.info('[tracker-devtool] Injected', entries.length, 'fake stat changes.');
        return entries.length;
    }

    // ============================================================
    // EXPOSE on EFTForge._dev namespace
    // ============================================================

    window.EFTForge = window.EFTForge || {};
    EFTForge._dev   = EFTForge._dev   || {};
    EFTForge._dev.trackerInject = injectNewBatch;

})();
