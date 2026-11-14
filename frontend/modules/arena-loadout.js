window.EFTForge = window.EFTForge || {};

/* ============================================================
   ARENA LOADOUT
   Arena mode's preset builder (arena.js): a whole Arena preset, the way the game's preset
   editor builds one. Pick a class, fill the gear slots, the weapons and what the rig and
   pockets carry, and watch the preset's meta points against the class's limits. Every
   item a class may not carry, and every weapon part the armory bans for it, shows up as a
   problem.

   The page swaps the builder's left and right panel content like the Ballistics
   Workbench does (.arena-loadout-mode on #main-container). The board is laid out in the
   Atlas Arena player lookup's own coordinates (atlas-lookup.js GEAR_LAYOUT, which follows
   the game's gear panel), drawn with the workbench's slot tiles. A weapon is a full build:
   "Edit in builder" opens it in the gun builder, and the stats panel's Save to loadout
   button brings it back.

   The loadout is kept in localStorage, so it survives reloads. Arena's own data comes
   from /arena/config, /arena/items, /armor/items and /guns, all with ?game=arena.
============================================================ */

window.EFTForge.arenaLoadout = (function () {

    const STORE_KEY = 'eftforge_arena_loadout_v1';
    const ART = 'assets/images/ballistics-loadout/';

    // The Atlas Arena board (atlas-lookup.js): 125 px slots with a 131 by 20 header bar 22 above,
    // 48 px inserts 4 from their parent, four columns and four rows on a 738 by 772 board
    const BOARD_W = 738;
    const BOARD_H = 772;
    const SLOT = 125;
    const INSERT = 48;
    const INSERT_GAP = 4;
    const COL = [6, 189, 372, 555];
    const ROW = [78, 281, 484, 639];
    const WEAPON_W = COL[2] - COL[0] - 16;
    // Arena's presets have no backpack, pouch or armband (atlas-lookup.js ARENA_HIDDEN_SLOTS)
    const GEAR_LAYOUT = [
        { slot: 'Earpiece', x: COL[0], y: ROW[0] },
        { slot: 'Headwear', x: COL[1], y: ROW[0] },
        { slot: 'FaceCover', x: COL[2], y: ROW[0] },
        { slot: 'ArmorVest', x: COL[1], y: ROW[1] },
        { slot: 'Eyewear', x: COL[2], y: ROW[1] },
        { slot: 'FirstPrimaryWeapon', x: COL[0], y: ROW[2], w: WEAPON_W },
        { slot: 'Holster', x: COL[2], y: ROW[2] },
        { slot: 'SecondPrimaryWeapon', x: COL[0], y: ROW[3], w: WEAPON_W },
        { slot: 'Scabbard', x: COL[2], y: ROW[3] },
        { slot: 'TacticalVest', x: COL[3], y: ROW[1] },
    ];
    const WEAPON_SLOTS = ['FirstPrimaryWeapon', 'SecondPrimaryWeapon', 'Holster'];
    const GEAR_SLOTS = ['Headwear', 'Earpiece', 'FaceCover', 'Eyewear', 'ArmorVest', 'TacticalVest', 'Scabbard'];
    // The arena item gear_slot each loadout slot takes
    const SLOT_KIND = { FirstPrimaryWeapon: 'Primary', SecondPrimaryWeapon: 'Primary', Holster: 'Holster' };
    const SLOT_ART = {
        Headwear: { file: 'Headwear.png', kind: 'headwear' },
        FaceCover: { file: 'Face_cover.png', kind: 'face_cover' },
        Eyewear: { file: 'Eyewear.png', kind: 'eyewear' },
        ArmorVest: { file: 'Bodyarmor.png', kind: 'armor' },
        TacticalVest: { file: 'TacticalVest.png', kind: 'rig' },
        Earpiece: { file: 'Earpiece.png', rect: [13, 11, 99, 103] },
        FirstPrimaryWeapon: { file: 'On_belt.png', rect: [27, -1.5, 256, 128] },
        SecondPrimaryWeapon: { file: 'On_belt.png', rect: [27, -1.5, 256, 128] },
        Holster: { file: 'Holster.png', rect: [-1.5, -1.5, 128, 128] },
        Scabbard: { file: 'Scabbard.png', rect: [-1, 42.5, 127, 40] },
    };
    const PLATE_SPOTS = { front_plate: 'front', back_plate: 'back', left_side_plate: 'left', right_side_plate: 'right' };
    const ATTACHMENT_SPOTS = {
        1: ['left'], 2: ['left', 'right'], 3: ['left-top', 'right', 'left-bottom'],
        4: ['left-top', 'right-top', 'left-bottom', 'right-bottom'],
    };
    const SLOT_COLORS = {
        blue: 'rgba(28, 65, 86, 0.302)', yellow: 'rgba(104, 102, 40, 0.302)', green: 'rgba(21, 45, 0, 0.302)',
        red: 'rgba(109, 36, 24, 0.302)', black: 'rgba(0, 0, 0, 0.302)', grey: 'rgba(29, 29, 29, 0.302)',
        violet: 'rgba(76, 42, 85, 0.302)', orange: 'rgba(60, 25, 0, 0.302)', default: 'rgba(127, 127, 127, 0.302)',
    };
    const SLOT_LABELS = {
        en: {
            Earpiece: 'Earpiece', Headwear: 'Headwear', FaceCover: 'Face cover', ArmorVest: 'Body armor',
            Eyewear: 'Eyewear', FirstPrimaryWeapon: 'On sling', Holster: 'Holster', SecondPrimaryWeapon: 'On back',
            Scabbard: 'Melee weapon', TacticalVest: 'Tactical rig', plate: 'Plate', attachment: 'Attachment',
        },
        zh: {
            Earpiece: '耳机', Headwear: '头部装备', FaceCover: '面部装备', ArmorVest: '防弹衣',
            Eyewear: '眼部装备', FirstPrimaryWeapon: '主武器', Holster: '手枪套', SecondPrimaryWeapon: '副武器',
            Scabbard: '近战武器', TacticalVest: '战术胸挂', plate: '插板', attachment: '配件',
        },
    };
    const CARRY_KINDS = ['magazine', 'ammo', 'medical', 'grenade'];

    let _active = false;
    let _wired = false;
    let _data = null;          // {guns, gear, armor}: by id, loaded on first entry
    let _dataPromise = null;
    const _points = {};        // item id -> /arena/points dto (meta points, classes, capacity)
    let _loadout = _empty();
    let _picker = null;        // {key, title, rows, onPick, search, sort}
    let _editing = null;       // the weapon slot whose build is open in the builder
    let _resetArmed = false;

    function _empty() {
        return { weapons: {}, gear: {}, carried: [] };
    }

    function _load() {
        try {
            const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
            if (raw && typeof raw === 'object') {
                _loadout = { weapons: raw.weapons || {}, gear: raw.gear || {}, carried: Array.isArray(raw.carried) ? raw.carried : [] };
            }
        } catch { _loadout = _empty(); }
    }

    function _save() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(_loadout)); } catch { /* private mode or full */ }
    }

    /* ===========================
       OPEN AND CLOSE
    =========================== */

    async function open() {
        if (!EFTForge.arena || !EFTForge.arena.isActive()) return;
        if (EFTForge.state.currentGun) returnToGunSelection();
        EFTForge.tabs && EFTForge.tabs.deactivateActiveTab && EFTForge.tabs.deactivateActiveTab();
        const container = document.getElementById('main-container');
        if (!container) return;
        _wire();
        container.classList.remove('no-gun');
        container.classList.add('arena-loadout-mode');
        _active = true;
        _editing = null;
        if (typeof _syncHeaderExpand === 'function') _syncHeaderExpand();
        document.getElementById('arena-loadout-btn')?.classList.add('active');
        _renderLoading();
        try {
            await _ensureData();
            await _ensurePoints(_loadoutIds());
        } catch (err) {
            console.warn('[arena-loadout] load failed:', err);
            const left = document.getElementById('arena-left-body');
            if (left) left.innerHTML = '<div class="atlas-empty error">' + escapeHtml(_t('arena.loadFailed')) + '</div>';
            return;
        }
        if (_active) render();
    }

    function leave() {
        if (!_active) return;
        _active = false;
        _picker = null;
        const container = document.getElementById('main-container');
        if (container) {
            container.classList.remove('arena-loadout-mode');
            if (!(EFTForge.state && EFTForge.state.currentGun)) {
                container.classList.add('no-gun');
                if (typeof _syncHeaderScrollOnly === 'function') _syncHeaderScrollOnly();
            }
        }
        document.getElementById('arena-loadout-btn')?.classList.remove('active');
        if (typeof closeMobileRightPanel === 'function') closeMobileRightPanel();
    }

    function isActive() { return _active; }
    function editingSlot() { return _editing; }

    /* ===========================
       DATA
    =========================== */

    function _ensureData() {
        if (_data) return Promise.resolve(_data);
        if (!_dataPromise) {
            _dataPromise = Promise.all([
                EFTForge.arena.loadConfig(),
                EFTForge.api.fetchArenaItems(),
                EFTForge.api.fetchArmorItems(),
                EFTForge.state.allGuns && EFTForge.state.allGuns.length ? EFTForge.state.allGuns : EFTForge.api.fetchGuns(),
            ]).then(function (results) {
                const byId = function (list) { return Object.fromEntries(list.map(function (x) { return [x.id, x]; })); };
                _data = { gear: byId(results[1]), armor: byId(results[2]), guns: byId(results[3]) };
                [results[1], results[2], results[3]].forEach(function (list) {
                    list.forEach(function (item) { if (!_points[item.id] && typeof item.meta_points === 'number') _points[item.id] = item; });
                });
                return _data;
            }).catch(function (err) {
                _dataPromise = null;
                throw err;
            });
        }
        return _dataPromise;
    }

    async function _ensurePoints(ids) {
        const missing = ids.filter(function (id) { return id && !_points[id]; });
        if (missing.length === 0) return;
        const found = await EFTForge.api.fetchArenaPoints(Array.from(new Set(missing)));
        Object.assign(_points, found);
    }

    // Every item id the loadout uses
    function _loadoutIds() {
        const ids = [];
        WEAPON_SLOTS.forEach(function (key) {
            const w = _loadout.weapons[key];
            if (!w) return;
            ids.push(w.gunId);
            (w.pairs || []).forEach(function (pair) { ids.push(pair[1]); });
            if (w.ammoId) ids.push(w.ammoId);
        });
        GEAR_SLOTS.forEach(function (key) {
            const g = _loadout.gear[key];
            if (!g) return;
            ids.push(g.id);
            Object.values(g.plates || {}).forEach(function (id) { ids.push(id); });
            Object.values(g.parts || {}).forEach(function (id) { ids.push(id); });
        });
        _loadout.carried.forEach(function (c) { ids.push(c.id); if (c.ammoId) ids.push(c.ammoId); });
        return ids.filter(Boolean);
    }

    function _item(id) {
        return (id && (_points[id] || (_data && (_data.gear[id] || _data.armor[id] || _data.guns[id])))) || null;
    }

    function _mp(id) {
        const item = _item(id);
        return item && typeof item.meta_points === 'number' ? item.meta_points : 0;
    }

    /* ===========================
       COUNTING
    =========================== */

    function _weaponMeta(w) {
        if (!w) return { total: 0, mods: 0 };
        let mods = 0;
        let capacity = 0;
        (w.pairs || []).forEach(function (pair) {
            mods += _mp(pair[1]);
            const part = _item(pair[1]);
            if (part && part.magazine_capacity > 0) capacity = part.magazine_capacity;
        });
        // A loaded magazine and the chambered round, as the game's own presets count them
        const ammo = w.ammoId ? _mp(w.ammoId) * (capacity + 1) : 0;
        return { total: _mp(w.gunId) + mods + ammo, mods: mods };
    }

    function _gearMeta(g) {
        if (!g) return 0;
        let total = _mp(g.id);
        Object.values(g.plates || {}).forEach(function (id) { total += _mp(id); });
        Object.values(g.parts || {}).forEach(function (id) { total += _mp(id); });
        return total;
    }

    function _carriedMeta(c) {
        let each = _mp(c.id);
        const item = _item(c.id);
        if (c.ammoId && item && item.magazine_capacity > 0) each += _mp(c.ammoId) * item.magazine_capacity;
        return each * (c.count || 1);
    }

    function totals() {
        let weapons = 0;
        let mods = 0;
        WEAPON_SLOTS.forEach(function (key) {
            const m = _weaponMeta(_loadout.weapons[key]);
            weapons += m.total;
            mods += m.mods;
        });
        let gear = 0;
        GEAR_SLOTS.forEach(function (key) { gear += _gearMeta(_loadout.gear[key]); });
        let carried = 0;
        _loadout.carried.forEach(function (c) { carried += _carriedMeta(c); });
        return { weapons: weapons, gear: gear, carried: carried, mods: mods, total: weapons + gear + carried };
    }

    // Inventory cells: a rig's grids, the pockets' four single cells
    function _cells(where) {
        let total = 0;
        if (where === 'rig') {
            const rig = _loadout.gear.TacticalVest ? _item(_loadout.gear.TacticalVest.id) : null;
            ((rig && rig.grids) || []).forEach(function (g) { total += g[0] * g[1]; });
        } else {
            ((EFTForge.arena.config() || {}).pocket_grids || [[1, 1], [1, 1], [1, 1], [1, 1]]).forEach(function (g) { total += g[0] * g[1]; });
        }
        let used = 0;
        _loadout.carried.forEach(function (c) {
            if ((c.where || 'rig') !== where) return;
            const item = _item(c.id) || {};
            const size = (item.width || 1) * (item.height || 1);
            const stacks = item.carry_kind === 'ammo' ? Math.ceil((c.count || 1) / (item.stack_max_size || 1)) : (c.count || 1);
            used += size * stacks;
        });
        return { used: used, total: total };
    }

    /** What keeps the loadout from being a valid preset for the selected class. */
    function problems() {
        const arena = EFTForge.arena;
        const out = [];
        const named = function (id) { const item = _item(id); return (item && (item.short_name || item.name)) || id; };
        const check = function (id, slot, gun) {
            const item = _item(id);
            if (!item) {
                out.push({ slot: slot, text: named(id) + ': ' + _t('arena.notInArmory') });
                return;
            }
            if (!arena.allowedForClass(item)) out.push({ slot: slot, text: named(id) + ': ' + _t('arena.lockedClass') });
            else if (gun && !arena.allowedOnGun(item, gun)) out.push({ slot: slot, text: named(id) + ': ' + _t('arena.lockedWeapon') });
        };
        WEAPON_SLOTS.forEach(function (key) {
            const w = _loadout.weapons[key];
            if (!w) return;
            const gun = _item(w.gunId);
            check(w.gunId, key, null);
            (w.pairs || []).forEach(function (pair) { check(pair[1], key, gun); });
            if (w.ammoId) check(w.ammoId, key, gun);
        });
        GEAR_SLOTS.forEach(function (key) {
            const g = _loadout.gear[key];
            if (!g) return;
            check(g.id, key, null);
            Object.values(g.plates || {}).forEach(function (id) { check(id, key, null); });
            Object.values(g.parts || {}).forEach(function (id) { check(id, key, null); });
        });
        _loadout.carried.forEach(function (c) {
            check(c.id, 'carried', null);
            if (c.ammoId) check(c.ammoId, 'carried', null);
        });
        // Worn armor that can't go together (a full face mask and a helmet)
        const worn = GEAR_SLOTS.map(function (key) { return _loadout.gear[key] && { key: key, item: _data && _data.armor[_loadout.gear[key].id] }; })
            .filter(function (w) { return w && w.item; });
        worn.forEach(function (a, i) {
            worn.slice(i + 1).forEach(function (b) {
                if ((a.item.conflicting_ids || []).indexOf(b.item.id) !== -1 || (b.item.conflicting_ids || []).indexOf(a.item.id) !== -1) {
                    out.push({ slot: b.key, text: named(a.item.id) + ' / ' + named(b.item.id) });
                }
            });
        });
        const cls = arena.currentClass();
        const sum = totals().total;
        if (cls && cls.meta_max != null && sum > cls.meta_max) {
            out.push({ slot: null, text: tFmt('arena.overLimit', { n: arena.formatMeta(sum - cls.meta_max) }) });
        }
        ['rig', 'pockets'].forEach(function (where) {
            const cells = _cells(where);
            if (cells.used > cells.total) {
                out.push({ slot: 'carried', text: _t(where === 'rig' ? 'arena.rig' : 'arena.pockets') + ': ' + tFmt('arena.cells', cells) });
            }
        });
        return out;
    }

    /* ===========================
       RENDER: LEFT
    =========================== */

    function _renderLoading() {
        const left = document.getElementById('arena-left-body');
        if (left) left.innerHTML = '<div class="arena-loading"><span class="atlas-lookup-throbber"></span></div>';
        _renderRight();
    }

    function render() {
        if (!_active) return;
        const left = document.getElementById('arena-left-body');
        if (!left) return;
        left.innerHTML = _classHtml() + _metaHtml() + _presetHtml() +
            '<div class="stats-section arena-board-section"><div class="arena-board" id="arena-board"></div></div>' + _carriedHtml();
        _renderBoard();
        _wireLeft(left);
        _renderRight();
    }

    function _classHtml() {
        const classes = EFTForge.arena.classes();
        if (!classes.length) return '';
        const current = EFTForge.arena.classId();
        return '<div class="arena-class-row" role="tablist">' + classes.map(function (c) {
            return '<button type="button" class="toggle-btn' + (c.id === current ? ' active' : '') + '" data-arena-class="' + escapeHtml(c.id) + '" aria-pressed="' + (c.id === current) + '">' + escapeHtml(c.name) + '</button>';
        }).join('') + '</div>';
    }

    function _metaHtml() {
        const arena = EFTForge.arena;
        const sum = totals();
        const cls = arena.currentClass();
        const max = cls && cls.meta_max ? cls.meta_max : null;
        const min = cls && cls.meta_min != null ? cls.meta_min : null;
        let status = '';
        let state = 'ok';
        if (max != null && sum.total > max) {
            state = 'over';
            status = tFmt('arena.overLimit', { n: arena.formatMeta(sum.total - max) });
        } else if (min != null && sum.total < min) {
            state = 'under';
            status = tFmt('arena.underLimit', { n: arena.formatMeta(min - sum.total) });
        } else if (max != null) {
            status = _t('arena.withinLimit');
        }
        const pct = max ? Math.min(sum.total / max, 1) * 100 : 0;
        const minPct = max && min != null ? Math.min(min / max, 1) * 100 : null;
        const share = sum.total > 0 ? Math.round(sum.mods * 100 / sum.total) : 0;
        const group = function (key, value) {
            return '<div class="stat-row"><span class="stat-label">' + escapeHtml(_t(key)) + '</span><span class="arena-meta">' + escapeHtml(arena.formatMeta(value)) + '</span></div>';
        };
        return '<div class="stats-section arena-meta-section">' +
            '<div class="section-title">' + escapeHtml(_t('arena.weaponMeta')) + '</div>' +
            '<div class="arena-meta-total"><span class="arena-meta">' + escapeHtml(arena.formatMeta(sum.total)) + '</span>' +
            (max != null ? '<span class="arena-meta-max"> / ' + escapeHtml(arena.formatMeta(max)) + '</span>' : '') + '</div>' +
            '<div class="arena-meta-bar is-' + state + '"><div class="arena-meta-fill" style="width:' + pct + '%"></div>' +
            (minPct != null ? '<div class="arena-meta-min" style="left:' + minPct + '%"></div>' : '') + '</div>' +
            '<div class="arena-meta-status is-' + state + '">' + escapeHtml(status) +
            (min != null && max != null ? ' <span class="arena-meta-range">' + escapeHtml(tFmt('arena.limit', { min: arena.formatMeta(min), max: arena.formatMeta(max) })) + '</span>' : '') + '</div>' +
            '<div class="stat-subsection-cols arena-meta-groups"><div class="stat-col">' +
            group('arena.groupWeapons', sum.weapons) + group('arena.groupGear', sum.gear) + '</div><div class="stat-col">' +
            group('arena.groupCarried', sum.carried) +
            '<div class="stat-row"><span class="stat-label" data-tooltip="' + escapeHtml(_t('arena.modShareTip')) + '">' + escapeHtml(tFmt('arena.weaponMods', { pct: share })) + '</span></div>' +
            '</div></div></div>';
    }

    function _presetHtml() {
        const presets = (EFTForge.arena.config() || {}).presets || [];
        if (!presets.length) return '';
        const classes = EFTForge.arena.classes();
        const className = function (id) { const c = classes.find(function (x) { return x.id === id; }); return c ? c.name : ''; };
        return '<div class="arena-preset-row"><select id="arena-preset-select" class="arena-preset-select" aria-label="' + escapeHtml(_t('arena.stockPreset')) + '">' +
            '<option value="">' + escapeHtml(_t('arena.stockPresetPick')) + '</option>' +
            presets.map(function (p, i) {
                return '<option value="' + i + '">' + escapeHtml(String(p.name).replace(/^\d+\.\s*/, '').replace(/_/g, ' ')) + ' (' + escapeHtml(className(p.class_id)) + ')</option>';
            }).join('') + '</select></div>';
    }

    function _carriedHtml() {
        const arena = EFTForge.arena;
        const rows = _loadout.carried.map(function (c, index) {
            const item = _item(c.id) || { name: c.id };
            const locked = !arena.allowedForClass(item) || (c.ammoId && !arena.allowedForClass(_item(c.ammoId) || {}));
            const ammoSelect = item.magazine_capacity > 0 ? _ammoSelectHtml(index, c.ammoId) : '';
            return '<div class="arena-carried-row' + (locked ? ' is-locked' : '') + '" data-index="' + index + '">' +
                (item.icon_link ? '<img class="arena-ov-icon" src="' + escapeHtml(item.icon_link) + '" alt="" onerror="this.style.display=\'none\'">' : '<span class="arena-ov-icon"></span>') +
                '<span class="arena-carried-name">' + escapeHtml(item.short_name || item.name || '') + '</span>' +
                ammoSelect +
                '<select class="arena-carried-where" data-index="' + index + '">' +
                '<option value="rig"' + ((c.where || 'rig') === 'rig' ? ' selected' : '') + '>' + escapeHtml(_t('arena.rig')) + '</option>' +
                '<option value="pockets"' + (c.where === 'pockets' ? ' selected' : '') + '>' + escapeHtml(_t('arena.pockets')) + '</option></select>' +
                '<input type="number" class="arena-carried-count" min="1" max="999" value="' + (c.count || 1) + '" data-index="' + index + '" aria-label="' + escapeHtml(_t('arena.count')) + '">' +
                '<span class="arena-ov-mp arena-meta">' + escapeHtml(arena.formatMeta(_carriedMeta(c))) + '</span>' +
                '<button type="button" class="arena-carried-remove" data-index="' + index + '" aria-label="' + escapeHtml(_t('arena.remove')) + '">&#x2715;</button></div>';
        }).join('');
        const cells = function (where) {
            const c = _cells(where);
            return '<span class="arena-cells' + (c.used > c.total ? ' is-over' : '') + '" data-tooltip="' + escapeHtml(_t('arena.cellsTip')) + '">' +
                escapeHtml(_t(where === 'rig' ? 'arena.rig' : 'arena.pockets')) + ' ' + escapeHtml(tFmt('arena.cells', c)) + '</span>';
        };
        return '<div class="stats-section arena-carried-section">' +
            '<div class="section-title stats-title-row"><span>' + escapeHtml(_t('arena.carried')) + '</span>' +
            '<span class="arena-cells-row">' + cells('rig') + cells('pockets') + '</span></div>' +
            rows +
            '<button type="button" class="back-button arena-add-carried" id="arena-add-carried">' + escapeHtml(_t('arena.addCarried')) + '</button></div>';
    }

    function _ammoOptions() {
        return Object.values((_data && _data.gear) || {}).filter(function (i) { return i.carry_kind === 'ammo'; })
            .sort(function (a, b) { return String(a.caliber).localeCompare(String(b.caliber)) || String(a.name).localeCompare(String(b.name)); });
    }

    function _ammoSelectHtml(index, current) {
        return '<select class="arena-carried-ammo" data-index="' + index + '" aria-label="' + escapeHtml(_t('arena.loadedWith')) + '">' +
            '<option value="">' + escapeHtml(_t('arena.empty')) + '</option>' +
            _ammoOptions().map(function (a) {
                return '<option value="' + escapeHtml(a.id) + '"' + (a.id === current ? ' selected' : '') + '>' + escapeHtml(a.short_name || a.name) + '</option>';
            }).join('') + '</select>';
    }

    /* ===========================
       THE BOARD
    =========================== */

    function _place(x, y, w, h) {
        return 'left:' + (x * 100 / BOARD_W) + '%;top:' + (y * 100 / BOARD_H) + '%;width:' + (w * 100 / BOARD_W) + '%;height:' + (h * 100 / BOARD_H) + '%';
    }

    function _insertSpot(spot, x, y) {
        const left = x - INSERT_GAP - INSERT;
        const right = x + SLOT + INSERT_GAP;
        const middle = y + (SLOT - INSERT) / 2;
        const center = x + (SLOT - INSERT) / 2;
        switch (spot) {
            case 'back': return [center, y - 22 - INSERT_GAP - INSERT];
            case 'front': return [center, y + SLOT + INSERT_GAP];
            case 'left': return [left, middle];
            case 'right': return [right, middle];
            case 'left-top': return [left, y + 4];
            case 'left-bottom': return [left, y + SLOT - 4 - INSERT];
            case 'right-top': return [right, y + 4];
            case 'right-bottom': return [right, y + SLOT - 4 - INSERT];
            default: return [right, middle];
        }
    }

    function _slotLabel(key) {
        const table = SLOT_LABELS[(EFTForge.state && EFTForge.state.lang) === 'zh' ? 'zh' : 'en'];
        return table[key] || key;
    }

    /**
     * One tile, as the Atlas board draws it (atlas-lookup.js boardSlot)
     * @param {{ key: string, art: string|null, item: any, picture: string|null, mp: number|null, locked: boolean, insert: boolean }} t
     */
    function _tile(t, x, y, w, h) {
        const tile = document.createElement('div');
        tile.className = 'bw-slot' + (t.insert ? ' bw-slot-insert' : '') + (t.item ? ' is-equipped' : '') +
            (t.locked ? ' arena-slot-locked' : '') + (_picker && _picker.key === t.key ? ' active-slot' : '');
        tile.setAttribute('style', _place(x, y, w, h));
        tile.tabIndex = 0;
        tile.dataset.arenaKey = t.key;
        const header = document.createElement('div');
        header.className = 'bw-slot-header';
        header.textContent = _slotLabel(t.insert ? (t.key.indexOf(':plate:') !== -1 ? 'plate' : 'attachment') : t.key);
        if (w !== SLOT || h !== SLOT) {
            header.style.left = (-3 * 100 / w) + '%';
            header.style.width = ((w + 6) * 100 / w) + '%';
            header.style.top = (-22 * 100 / h) + '%';
            header.style.height = (20 * 100 / h) + '%';
        }
        tile.appendChild(header);
        const body = document.createElement('div');
        body.className = 'bw-slot-body';
        if (t.item) {
            const color = document.createElement('span');
            color.className = 'bw-slot-color';
            color.style.background = SLOT_COLORS[t.item.background_color] || SLOT_COLORS.default;
            body.appendChild(color);
            if (t.picture) {
                const icon = document.createElement('img');
                icon.className = 'bw-slot-icon';
                icon.src = t.picture;
                icon.alt = '';
                icon.addEventListener('error', function () { icon.remove(); });
                body.appendChild(icon);
            }
            const short = document.createElement('span');
            short.className = 'bw-slot-short';
            short.innerHTML = shortNameHtml(t.item.short_name || t.item.name || '');
            body.appendChild(short);
            if (t.mp != null) {
                const stat = document.createElement('span');
                stat.className = 'bw-slot-stat arena-meta';
                stat.textContent = EFTForge.arena.formatMeta(t.mp);
                body.appendChild(stat);
            }
            const armorClass = t.item.pieces && t.item.pieces.length ? Math.max.apply(null, t.item.pieces.map(function (p) { return p.armor_class || 0; })) : 0;
            if (armorClass >= 1 && armorClass <= 6) {
                const cls = document.createElement('img');
                cls.className = 'bw-armor-class';
                cls.src = ART + 'armor_class_' + armorClass + '.png';
                cls.alt = String(armorClass);
                body.appendChild(cls);
            }
        } else if (t.art) {
            const art = SLOT_ART[t.art];
            const pic = document.createElement('img');
            pic.className = 'bw-slot-art' + (art && art.kind ? ' bw-art-' + art.kind : '');
            pic.src = ART + (art ? art.file : (t.insert ? 'armor_plate.png' : 'mod_equipment.png'));
            pic.alt = '';
            if (art && art.rect) {
                pic.style.left = (art.rect[0] * 100 / w) + '%';
                pic.style.top = (art.rect[1] * 100 / h) + '%';
                pic.style.width = (art.rect[2] * 100 / w) + '%';
                pic.style.height = (art.rect[3] * 100 / h) + '%';
            } else if (!art) {
                pic.className += t.key.indexOf(':plate:') !== -1 ? ' bw-art-plate' : ' bw-art-attachment';
            }
            body.appendChild(pic);
        }
        tile.appendChild(body);
        return tile;
    }

    function _locked(ids, gun) {
        const arena = EFTForge.arena;
        return ids.some(function (id) {
            const item = _item(id);
            return !item || !arena.allowedForClass(item) || (gun && !arena.allowedOnGun(item, gun));
        });
    }

    function _renderBoard() {
        const board = document.getElementById('arena-board');
        if (!board) return;
        board.replaceChildren();
        GEAR_LAYOUT.forEach(function (spot) {
            const w = spot.w || SLOT;
            const h = spot.h || SLOT;
            const key = spot.slot;
            if (WEAPON_SLOTS.indexOf(key) !== -1) {
                const weapon = _loadout.weapons[key];
                const gun = weapon ? _item(weapon.gunId) : null;
                const ids = weapon ? [weapon.gunId].concat((weapon.pairs || []).map(function (p) { return p[1]; }), weapon.ammoId ? [weapon.ammoId] : []) : [];
                board.appendChild(_tile({
                    key: key, art: key, item: gun, picture: gun ? (gun.image_512_link || gun.icon_link) : null,
                    mp: weapon ? _weaponMeta(weapon).total : null, locked: !!weapon && _locked(ids, gun), insert: false,
                }, spot.x, spot.y, w, h));
                return;
            }
            const worn = _loadout.gear[key];
            const item = worn ? (_data.armor[worn.id] || _item(worn.id)) : null;
            const ids = worn ? [worn.id].concat(Object.values(worn.plates || {}), Object.values(worn.parts || {})) : [];
            board.appendChild(_tile({
                key: key, art: key, item: item, picture: item ? (item.image_link || item.icon_link) : null,
                mp: worn ? _gearMeta(worn) : null, locked: !!worn && _locked(ids, null), insert: false,
            }, spot.x, spot.y, w, h));
            if (!worn || !item) return;
            const armor = _data.armor[worn.id];
            if (!armor) return;
            if (key === 'Headwear') {
                const slots = (armor.attachment_slots || []).slice(0, 4);
                const spots = ATTACHMENT_SPOTS[slots.length] || [];
                slots.forEach(function (slot, i) {
                    const partId = (worn.parts || {})[slot.slot];
                    const part = partId ? _item(partId) : null;
                    const xy = _insertSpot(spots[i], spot.x, spot.y);
                    board.appendChild(_tile({
                        key: key + ':part:' + slot.slot, art: null, item: part, picture: part ? (part.image_link || part.icon_link) : null,
                        mp: null, locked: !!partId && _locked([partId], null), insert: true,
                    }, xy[0], xy[1], INSERT, INSERT));
                });
            } else if (key === 'ArmorVest' || key === 'TacticalVest') {
                (armor.plate_slots || []).forEach(function (slot) {
                    const where = PLATE_SPOTS[String(slot.slot).toLowerCase()];
                    if (!where) return;
                    const plateId = (worn.plates || {})[slot.slot];
                    const plate = plateId ? (_data.armor[plateId] || _item(plateId)) : null;
                    const xy = _insertSpot(where, spot.x, spot.y);
                    board.appendChild(_tile({
                        key: key + ':plate:' + slot.slot, art: null, item: plate, picture: plate ? (plate.image_link || plate.icon_link) : null,
                        mp: null, locked: !!plateId && _locked([plateId], null), insert: true,
                    }, xy[0], xy[1], INSERT, INSERT));
                });
            }
        });
        board.querySelectorAll('[data-arena-key]').forEach(function (node) {
            const tile = /** @type {HTMLElement} */ (node);
            const key = tile.dataset.arenaKey;
            tile.addEventListener('click', function () { _openSlot(key); });
            tile.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _openSlot(key); }
            });
            tile.addEventListener('contextmenu', function (e) {
                e.preventDefault();
                _clearSlot(key);
            });
        });
    }

    /* ===========================
       FILLING SLOTS
    =========================== */

    function _clearSlot(key) {
        const parts = key.split(':');
        if (parts.length === 3) {
            const worn = _loadout.gear[parts[0]];
            if (worn) delete (parts[1] === 'plate' ? (worn.plates || {}) : (worn.parts || {}))[parts[2]];
        } else if (WEAPON_SLOTS.indexOf(key) !== -1) {
            delete _loadout.weapons[key];
        } else {
            delete _loadout.gear[key];
        }
        _changed();
    }

    function _openSlot(key) {
        const parts = key.split(':');
        let rows;
        let current = null;
        let onPick;
        if (parts.length === 3) {
            const worn = _loadout.gear[parts[0]];
            const armor = worn && _data.armor[worn.id];
            if (!armor) return;
            const list = parts[1] === 'plate' ? armor.plate_slots : armor.attachment_slots;
            const slot = (list || []).find(function (s) { return s.slot === parts[2]; });
            const allowed = slot ? (slot.allowed_plate_ids || slot.allowed_ids || []) : [];
            rows = allowed.map(function (id) { return _data.armor[id]; }).filter(Boolean);
            const store = parts[1] === 'plate' ? 'plates' : 'parts';
            current = (worn[store] || {})[parts[2]] || null;
            onPick = function (row) {
                worn[store] = worn[store] || {};
                worn[store][parts[2]] = row.id;
                _changed();
            };
        } else if (WEAPON_SLOTS.indexOf(key) !== -1) {
            rows = Object.values(_data.guns).filter(function (g) { return g.gear_slot === SLOT_KIND[key]; });
            current = _loadout.weapons[key] ? _loadout.weapons[key].gunId : null;
            onPick = function (row) { _pickWeapon(key, row); };
        } else {
            rows = Object.values(_data.gear).filter(function (i) { return i.gear_slot === key; })
                .map(function (i) { return _data.armor[i.id] ? Object.assign({}, i, { pieces: _data.armor[i.id].pieces }) : i; });
            current = _loadout.gear[key] ? _loadout.gear[key].id : null;
            onPick = function (row) { _pickGear(key, row); };
        }
        _picker = { key: key, title: _slotLabel(parts.length === 3 ? (parts[1] === 'plate' ? 'plate' : 'attachment') : key), rows: rows, current: current, onPick: onPick, search: '', sort: { key: 'mp', asc: false } };
        _renderBoard();
        _renderRight();
        if (typeof openMobileRightPanel === 'function') openMobileRightPanel();
    }

    function _openCarriedPicker() {
        const rows = Object.values(_data.gear).filter(function (i) { return CARRY_KINDS.indexOf(i.carry_kind) !== -1; });
        _picker = {
            key: 'carried', title: _t('arena.carried'), rows: rows, current: null, search: '', sort: { key: 'mp', asc: false },
            onPick: function (row) {
                const primary = _loadout.weapons.FirstPrimaryWeapon || _loadout.weapons.SecondPrimaryWeapon || _loadout.weapons.Holster;
                const entry = { id: row.id, count: row.carry_kind === 'ammo' ? (row.stack_max_size || 30) : 1, where: 'rig' };
                if (row.carry_kind === 'magazine' && primary && primary.ammoId) entry.ammoId = primary.ammoId;
                _loadout.carried.push(entry);
                _changed();
            },
        };
        _renderBoard();
        _renderRight();
        if (typeof openMobileRightPanel === 'function') openMobileRightPanel();
    }

    function _pickGear(key, row) {
        const worn = { id: row.id };
        const armor = _data.armor[row.id];
        if (armor) {
            // What the item comes with: its default plates and helmet attachments
            (armor.plate_slots || []).forEach(function (s) {
                if (s.default_id && _data.armor[s.default_id]) { worn.plates = worn.plates || {}; worn.plates[s.slot] = s.default_id; }
            });
            (armor.attachment_slots || []).forEach(function (s) {
                if (s.default_id && _data.armor[s.default_id]) { worn.parts = worn.parts || {}; worn.parts[s.slot] = s.default_id; }
            });
        }
        _loadout.gear[key] = worn;
        _changed();
    }

    // A picked weapon starts as its factory preset, loaded with the ammo it's zeroed for
    async function _pickWeapon(key, gun) {
        let init;
        try {
            init = await EFTForge.api.fetchGunInit(gun.id);
        } catch (err) {
            console.warn('[arena-loadout] weapon init failed:', err);
            return;
        }
        const pairs = [];
        const walk = function (tree) {
            Object.keys(tree || {}).forEach(function (slotId) {
                const node = tree[slotId];
                pairs.push([slotId, node.item.id]);
                _points[node.item.id] = _points[node.item.id] || node.item;
                walk(node.children);
            });
        };
        walk(init.factory_tree);
        (init.ammo || []).forEach(function (a) { _points[a.id] = _points[a.id] || a; });
        const allowedAmmo = (init.ammo || []).filter(function (a) {
            return EFTForge.arena.allowedForClass(a) && EFTForge.arena.allowedOnGun(a, gun);
        });
        const ammo = allowedAmmo.find(function (a) { return a.id === gun.default_ammo_id; }) || allowedAmmo[0] || (init.ammo || [])[0] || null;
        _loadout.weapons[key] = { gunId: gun.id, pairs: pairs, ammoId: ammo ? ammo.id : null };
        await _ensurePoints(_loadoutIds());
        _changed();
    }

    function _editWeapon(key) {
        const weapon = _loadout.weapons[key];
        if (!weapon || typeof loadBuildFromPayload !== 'function') return;
        _editing = key;
        loadBuildFromPayload({ g: weapon.gunId, p: weapon.pairs || [], a: weapon.ammoId || null });
    }

    /** The stats panel's Save to loadout: the build open in the builder goes back to its slot. */
    async function saveEditedWeapon() {
        const state = EFTForge.state;
        if (!_editing || !state.currentGun || typeof collectSlotPairs !== 'function') return;
        const ammoSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById('ammo-select'));
        _load();
        _loadout.weapons[_editing] = {
            gunId: state.currentGun.id,
            pairs: collectSlotPairs(state.buildTree),
            ammoId: ammoSelect && ammoSelect.value ? ammoSelect.value : null,
        };
        _save();
        showToast(_t('arena.loadout'), _t('arena.savedToLoadout'), 2500, '#407d9b');
    }

    async function _applyPreset(preset) {
        const next = _empty();
        const weaponNodes = preset.gear.filter(function (g) { return WEAPON_SLOTS.indexOf(g.slot) !== -1; });
        const weaponIds = [];
        const collect = function (node) {
            if (node.id) weaponIds.push(node.id);
            node.children.forEach(collect);
        };
        weaponNodes.forEach(collect);
        const slotsBy = weaponIds.length ? await EFTForge.api.fetchItemSlotsBatch(Array.from(new Set(weaponIds))) : {};
        weaponNodes.forEach(function (node) {
            const pairs = [];
            let ammoId = null;
            const walk = function (parent) {
                parent.children.forEach(function (child) {
                    if (child.slot === 'cartridges' || child.slot === 'patron_in_weapon') {
                        ammoId = ammoId || child.id;
                        return;
                    }
                    const slot = (slotsBy[parent.id] || []).find(function (s) { return s.slot_game_name === child.slot; });
                    if (!slot) return;
                    pairs.push([slot.id, child.id]);
                    walk(child);
                });
            };
            walk(node);
            next.weapons[node.slot] = { gunId: node.id, pairs: pairs, ammoId: ammoId };
        });
        const addCarried = function (node, where) {
            const ammo = node.children.find(function (c) { return c.slot === 'cartridges'; });
            const ammoId = ammo ? ammo.id : null;
            const same = next.carried.find(function (c) { return c.id === node.id && (c.ammoId || null) === ammoId && c.where === where; });
            if (same) same.count += node.count || 1;
            else next.carried.push({ id: node.id, count: node.count || 1, ammoId: ammoId, where: where });
        };
        preset.gear.forEach(function (node) {
            if (node.slot === 'Pockets') {
                node.children.forEach(function (c) { if (c.id) addCarried(c, 'pockets'); });
                return;
            }
            if (GEAR_SLOTS.indexOf(node.slot) === -1) return;
            const worn = { id: node.id };
            const armor = _data.armor[node.id];
            node.children.forEach(function (child) {
                const plateSlot = armor && (armor.plate_slots || []).find(function (s) { return String(s.slot).toLowerCase() === String(child.slot).toLowerCase(); });
                if (plateSlot) {
                    worn.plates = worn.plates || {};
                    worn.plates[plateSlot.slot] = child.id;
                } else if (String(child.slot).indexOf('mod_') === 0) {
                    worn.parts = worn.parts || {};
                    worn.parts[child.slot] = child.id;
                } else if (node.slot === 'TacticalVest') {
                    addCarried(child, 'rig');
                }
            });
            next.gear[node.slot] = worn;
        });
        _loadout = next;
        EFTForge.arena.setClass(preset.class_id);
        await _ensurePoints(_loadoutIds());
        _changed();
    }

    function _changed() {
        _save();
        if (!_active) return;
        _picker && (_picker.current = _currentFor(_picker.key));
        render();
    }

    function _currentFor(key) {
        if (key === 'carried') return null;
        const parts = key.split(':');
        if (parts.length === 3) {
            const worn = _loadout.gear[parts[0]];
            return worn ? ((parts[1] === 'plate' ? worn.plates : worn.parts) || {})[parts[2]] || null : null;
        }
        if (WEAPON_SLOTS.indexOf(key) !== -1) return _loadout.weapons[key] ? _loadout.weapons[key].gunId : null;
        return _loadout.gear[key] ? _loadout.gear[key].id : null;
    }

    function _wireLeft(left) {
        left.querySelectorAll('[data-arena-class]').forEach(function (node) {
            node.addEventListener('click', function () {
                EFTForge.arena.setClass(/** @type {HTMLElement} */ (node).dataset.arenaClass);
                render();
            });
        });
        const preset = /** @type {HTMLSelectElement | null} */ (left.querySelector('#arena-preset-select'));
        if (preset) {
            preset.addEventListener('change', function () {
                const chosen = ((EFTForge.arena.config() || {}).presets || [])[Number(preset.value)];
                if (preset.value !== '' && chosen) _applyPreset(chosen);
            });
        }
        left.querySelector('#arena-add-carried')?.addEventListener('click', _openCarriedPicker);
        left.querySelectorAll('.arena-carried-count').forEach(function (node) {
            const input = /** @type {HTMLInputElement} */ (node);
            input.addEventListener('change', function () {
                const entry = _loadout.carried[Number(input.dataset.index)];
                if (!entry) return;
                entry.count = Math.max(1, Math.min(999, Math.round(Number(input.value) || 1)));
                _changed();
            });
        });
        left.querySelectorAll('.arena-carried-where').forEach(function (node) {
            const select = /** @type {HTMLSelectElement} */ (node);
            select.addEventListener('change', function () {
                const entry = _loadout.carried[Number(select.dataset.index)];
                if (entry) { entry.where = select.value === 'pockets' ? 'pockets' : 'rig'; _changed(); }
            });
        });
        left.querySelectorAll('.arena-carried-ammo').forEach(function (node) {
            const select = /** @type {HTMLSelectElement} */ (node);
            select.addEventListener('change', function () {
                const entry = _loadout.carried[Number(select.dataset.index)];
                if (entry) { entry.ammoId = select.value || null; _changed(); }
            });
        });
        left.querySelectorAll('.arena-carried-remove').forEach(function (node) {
            node.addEventListener('click', function () {
                _loadout.carried.splice(Number(/** @type {HTMLElement} */ (node).dataset.index), 1);
                _changed();
            });
        });
    }

    /* ===========================
       RENDER: RIGHT (the picker, or the loadout's summary)
    =========================== */

    function _renderRight() {
        const right = document.getElementById('arena-right');
        if (!right) return;
        if (!_active || !_data) {
            right.innerHTML = '';
            return;
        }
        if (_picker) _renderPicker(right);
        else _renderSummary(right);
    }

    function _renderSummary(right) {
        const list = problems();
        const snapshot = (EFTForge.arena.config() || {}).snapshot || {};
        right.innerHTML = '<div class="attachment-placeholder bw-placeholder arena-placeholder"><div class="placeholder-inner">' +
            '<strong><em>' + escapeHtml(_t('arena.placeholder')) + '</em></strong>' +
            '<span class="placeholder-sub"><strong><em>' + escapeHtml(_t('arena.placeholderSub')) + '</em></strong></span></div></div>' +
            '<div class="stats-section arena-problems"><div class="section-title">' + escapeHtml(_t('arena.violations')) + '</div>' +
            (list.length
                ? list.map(function (p) { return '<div class="arena-problem">' + escapeHtml(p.text) + '</div>'; }).join('')
                : '<div class="arena-problem is-ok">' + escapeHtml(_t('arena.noViolations')) + '</div>') +
            '</div>' +
            (snapshot.version ? '<div class="arena-snapshot-note">' + escapeHtml(tFmt('arena.snapshot', { version: snapshot.version })) + '</div>' : '');
    }

    function _pickerRows() {
        const p = _picker;
        const query = p.search.trim().toLowerCase();
        const rows = query ? p.rows.filter(function (r) {
            return String(r.name || '').toLowerCase().indexOf(query) !== -1 || String(r.short_name || '').toLowerCase().indexOf(query) !== -1;
        }) : p.rows.slice();
        const dir = p.sort.asc ? 1 : -1;
        rows.sort(function (a, b) {
            if (p.sort.key === 'name') return dir * String(a.name).localeCompare(String(b.name));
            return dir * ((a.meta_points || 0) - (b.meta_points || 0));
        });
        return rows;
    }

    function _detail(row) {
        if (row.caliber && row.carry_kind !== 'magazine') return String(row.caliber).replace(/^Caliber/, '');
        if (row.magazine_capacity) return row.magazine_capacity + ' rd';
        const pieces = row.pieces || (_data.armor[row.id] || {}).pieces;
        if (pieces && pieces.length) return 'Class ' + Math.max.apply(null, pieces.map(function (x) { return x.armor_class || 0; }));
        if (row.grids && row.grids.length) return row.grids.reduce(function (s, g) { return s + g[0] * g[1]; }, 0) + ' cells';
        return row.weight != null ? Number(row.weight).toFixed(2) + ' kg' : '';
    }

    function _renderPicker(right) {
        const p = _picker;
        const arena = EFTForge.arena;
        const rows = _pickerRows();
        const isWeapon = WEAPON_SLOTS.indexOf(p.key) !== -1;
        const weapon = isWeapon ? _loadout.weapons[p.key] : null;
        const arrow = function (key) { return p.sort.key === key ? (p.sort.asc ? ' &#9650;' : ' &#9660;') : ''; };
        let html = '<div class="att-table-header"><h3>' + escapeHtml(_t('arena.selectFor')) + '<strong>' + escapeHtml(p.title) + '</strong></h3>' +
            (weapon ? '<button type="button" class="back-button arena-edit-weapon" id="arena-edit-weapon">' + escapeHtml(_t('arena.editInBuilder')) + '</button>' : '') +
            '<button type="button" class="att-table-close-btn" id="arena-picker-close" aria-label="' + escapeHtml(_t('workbench.back')) + '">&#x2715;</button></div>' +
            '<input type="text" id="arena-picker-search" class="search-input" placeholder="' + escapeHtml(_t('arena.searchPlaceholder')) + '" value="' + escapeHtml(p.search) + '">' +
            '<table class="attachment-table bw-table arena-picker-table"><thead><tr>' +
            '<th data-col="name"><button type="button" class="bw-sort-button">' + escapeHtml(_t('th.name')) + arrow('name') + '</button></th>' +
            '<th data-col="detail"></th>' +
            '<th data-col="mp"><button type="button" class="bw-sort-button">' + escapeHtml(_t('arena.mp')) + arrow('mp') + '</button></th>' +
            '</tr></thead><tbody>';
        rows.forEach(function (row, index) {
            const locked = !arena.allowedForClass(row);
            html += '<tr class="bw-picker-row' + (row.id === p.current ? ' attachment-row-installed' : '') + (locked ? ' conflict-row arena-row-locked' : '') + '" tabindex="0" data-index="' + index + '"' +
                (locked ? ' data-tooltip="' + escapeHtml(_t('arena.lockedClass')) + '"' : '') + '>' +
                '<td><div class="attachment-name-wrapper"><div class="attachment-icon-wrapper">' +
                (row.icon_link ? '<img src="' + escapeHtml(row.icon_link) + '" class="attachment-icon" loading="lazy" decoding="async" onerror="this.style.display=\'none\'">' : '') +
                '<div class="slot-shortname">' + shortNameHtml(row.short_name || '') + '</div></div>' +
                '<div class="att-name-and-rating"><div class="attachment-name-text">' + escapeHtml(row.name || '') + '</div></div></div></td>' +
                '<td class="arena-detail">' + escapeHtml(_detail(row)) + '</td>' +
                '<td>' + arena.metaCellHtml(row, null) + '</td></tr>';
        });
        html += '</tbody></table>';
        if (!rows.length) html += '<div class="ammo-no-results">' + escapeHtml(_t('ammo.noResults')) + '</div>';
        right.innerHTML = html;

        right.querySelector('#arena-picker-close')?.addEventListener('click', function () {
            _picker = null;
            _renderBoard();
            _renderRight();
        });
        right.querySelector('#arena-edit-weapon')?.addEventListener('click', function () { _editWeapon(p.key); });
        const search = /** @type {HTMLInputElement | null} */ (right.querySelector('#arena-picker-search'));
        if (search) {
            search.addEventListener('input', function () {
                p.search = search.value;
                const caret = search.selectionStart;
                _renderRight();
                const again = /** @type {HTMLInputElement | null} */ (document.getElementById('arena-picker-search'));
                if (again) { again.focus(); again.setSelectionRange(caret, caret); }
            });
        }
        right.querySelectorAll('th[data-col]').forEach(function (node) {
            const key = /** @type {HTMLElement} */ (node).dataset.col;
            if (key === 'detail') return;
            node.addEventListener('click', function () {
                p.sort = { key: key, asc: key === p.sort.key ? !p.sort.asc : key === 'name' };
                _renderRight();
            });
        });
        right.querySelectorAll('tr.bw-picker-row').forEach(function (node) {
            const tr = /** @type {HTMLElement} */ (node);
            const row = rows[Number(tr.dataset.index)];
            const pick = function () {
                if (!arena.allowedForClass(row) || (row.id === p.current && p.key !== 'carried')) return;
                p.onPick(row);
            };
            tr.addEventListener('click', pick);
            tr.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
            });
        });
    }

    /* ===========================
       SETUP
    =========================== */

    function _wire() {
        if (_wired) return;
        _wired = true;
        document.getElementById('arena-back-btn')?.addEventListener('click', function () { returnToGunSelection(); });
        const reset = document.getElementById('arena-reset-btn');
        reset?.addEventListener('click', function () {
            // The first click only arms it, like every other confirm button
            if (!_resetArmed) {
                _resetArmed = true;
                reset.classList.add('confirming');
                reset.textContent = _t('ui.confirm');
                setTimeout(_disarmReset, 3000);
                return;
            }
            _disarmReset();
            _loadout = _empty();
            _picker = null;
            _changed();
        });
        _updateStaticText();
        document.addEventListener('arena-class-change', function () { if (_active) render(); });
    }

    function _disarmReset() {
        _resetArmed = false;
        const reset = document.getElementById('arena-reset-btn');
        if (!reset) return;
        reset.classList.remove('confirming');
        reset.textContent = '↺ ' + _t('workbench.reset');
    }

    function _updateStaticText() {
        const back = document.getElementById('arena-back-btn');
        if (back) back.textContent = '← ' + _t('workbench.back');
        _disarmReset();
        const btn = document.getElementById('arena-loadout-label');
        if (btn) btn.textContent = _t('arena.loadout');
    }

    function onLangChange() {
        _updateStaticText();
        if (_active) {
            // Names come from the server in the page's language
            _data = null;
            _dataPromise = null;
            open();
        }
    }

    function _t(key) { return (EFTForge.lang && EFTForge.lang.t) ? EFTForge.lang.t(key) : key; }

    _load();

    return {
        open: open,
        leave: leave,
        isActive: isActive,
        editingSlot: editingSlot,
        saveEditedWeapon: saveEditedWeapon,
        totals: totals,
        problems: problems,
        render: render,
        onLangChange: onLangChange,
    };

}());
