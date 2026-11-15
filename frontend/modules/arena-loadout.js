window.EFTForge = window.EFTForge || {};

/* ============================================================
   ARENA LOADOUT
   Arena mode's front page and preset builder (arena.js). Arena opens on a class picker in
   place of the gun list (#arena-class-picker): each preset class, and BlastGang, whose
   shop has its own page (arena-shop.js). A class opens straight into its loadout: a whole
   Arena preset, the way the game's preset editor builds one. Fill the gear slots, the
   weapons and what the rig and pockets carry, and watch the preset's meta points against
   the class's limits. Every item the class may not carry, and every weapon part the armory
   bans for it, shows up as a problem. The class tabs across the top switch between them.

   The page swaps the builder's left and right panel content like the Ballistics
   Workbench does (.arena-loadout-mode on #main-container). The board is laid out in the
   Atlas Arena player lookup's own coordinates (atlas-lookup.js GEAR_LAYOUT, which follows
   the game's gear panel), drawn with the workbench's slot tiles, with the rig's grids and
   the pockets beside it. The right panel is the game's item list: weapons, equipment, meds,
   magazines and ammo tabs, each with its filter column, switching to whatever a slot or
   cell takes when it's clicked. A weapon is a full build: "Edit in builder" opens it in the gun builder, the stats
   panel's Save to loadout button brings it back, and the builder's Back returns here.

   Each class keeps its own loadout in localStorage, so they survive reloads. Arena's own
   data comes from /arena/config, /arena/items, /armor/items and /guns, all with ?game=arena.
============================================================ */

window.EFTForge.arenaLoadout = (function () {

    const STORE_KEY = 'eftforge_arena_loadouts_v2';
    // Before each class had its own: one loadout, for whichever class was picked
    const OLD_STORE_KEY = 'eftforge_arena_loadout_v1';
    const ART = 'assets/images/ballistics-loadout/';
    const TYPE_ART = 'assets/images/arena/weapon-types/';
    // The right panel's category tabs, as the game's preset editor has them. Grenades have no
    // tab: the game's preset editor has no way to carry one.
    const CARRY_ART = 'assets/images/arena/carry/';
    const MED_ART = 'assets/images/arena/meds/';
    const TABS = ['weapons', 'equipment', 'meds', 'mags', 'ammo'];
    const CARRY_TABS = ['meds', 'mags', 'ammo'];
    const TAB_ART = {
        weapons: 'assets/images/arena/tabs/weapons.webp', equipment: 'assets/images/arena/tabs/equipment.webp',
        meds: CARRY_ART + 'medical.webp', mags: CARRY_ART + 'magazine.webp', ammo: CARRY_ART + 'ammo.webp',
    };
    // The equipment tab's filter column, top to bottom as the game has it. The knife is the
    // weapons tab's last filter, as in the game.
    const EQUIP_FILTERS = ['ArmorVest', 'Eyewear', 'Headwear', 'TacticalVest', 'Earpiece', 'FaceCover'];
    // The equipment filters that open into an armored and a plain one, as the game's do
    const EQUIP_SPLITS = ['Eyewear', 'Headwear', 'TacticalVest', 'FaceCover'];
    const MELEE = 'melee';
    // The meds tab's: medkits, injury treatment, pills, injectors, by handbook category
    const MED_FILTERS = [
        { key: 'medkits', cat: '5b47574386f77428ca22b338' },
        { key: 'injury', cat: '5b47574386f77428ca22b339' },
        { key: 'pills', cat: '5b47574386f77428ca22b337' },
        { key: 'injectors', cat: '5b47574386f77428ca22b33a' },
    ];
    // The rig and pockets: 63 px cells, drawn at the game's own size (the rig's slot tile at
    // 125 px, as big as the board's); every Arena preset has four single-cell pockets
    const CELL = 63;
    const CARRY_SCALE = 1;
    const POCKETS = [[1, 1], [1, 1], [1, 1], [1, 1]];
    // The equipment tab's filter icons, by gear slot, plus a plate and a helmet part
    const GEAR_ART = 'assets/images/arena/gear/';
    const ARENA_ART = 'assets/images/arena/';
    // Each class's icon in ARENA_ART/classes/, by the class key /arena/config gives
    const CLASS_ICONS = { Assault: 'assault', CQB: 'enforcer', Recon: 'scout', Marksman: 'marksman' };
    // What open() takes for BlastGang's shop in place of a class id
    const BLAST_GANG = 'blastgang';
    // The weapon list's type filters, in the game's order, by the weapon_category they cover
    const WEAPON_TYPES = [
        { key: 'assault-rifles', cats: ['Assault rifle'] },
        { key: 'carbines', cats: ['Assault carbine'] },
        { key: 'marksman-rifles', cats: ['Marksman rifle'] },
        { key: 'sniper-rifles', cats: ['Sniper rifle'] },
        { key: 'smgs', cats: ['SMG', 'Submachine gun'] },
        { key: 'machine-guns', cats: ['Machinegun', 'Machine gun', 'Machine Gun'] },
        { key: 'shotguns', cats: ['Shotgun'] },
        { key: 'grenade-launchers', cats: ['Grenade launcher', 'Grenade Launcher'] },
        { key: 'pistols', cats: ['Handgun', 'Revolver'] },
    ];

    // The Atlas Arena board (atlas-lookup.js): 125 px slots with a 131 by 20 header bar 22 above,
    // 48 px inserts 4 from their parent, four columns and four rows on a 738 by 772 board
    const SLOT = 125;
    const INSERT = 48;
    const INSERT_GAP = 4;
    const COL = [6, 189, 372, 555];
    const ROW = [78, 281, 484, 639];
    const WEAPON_W = COL[2] - COL[0] - 16;
    // What we draw of that board: just the slots and their headers, so the board sits centered
    // in its column. The rig isn't on it: it heads the middle column, over its own grids.
    const BOARD_X = COL[0] - 3;
    const BOARD_Y = ROW[0] - 22;
    const BOARD_W = COL[2] + SLOT + 3 - BOARD_X;
    const BOARD_H = ROW[3] + SLOT - BOARD_Y;
    const BOARD_FRAME = { x: BOARD_X, y: BOARD_Y, w: BOARD_W, h: BOARD_H };
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

    let _active = false;
    let _wired = false;
    let _view = 'loadout';     // 'loadout', or 'shop' while BlastGang's shop is open
    let _data = null;          // {guns, gear, armor}: by id, loaded on first entry
    let _dataPromise = null;
    const _points = {};        // item id -> /arena/points dto (meta points, classes, capacity)
    let _store = { byClass: {} };
    let _loadout = _empty();   // the selected class's loadout, held in _store.byClass
    let _pick = _freshPick();  // the right panel's tab, filters, search, and what a pick fills
    let _editing = null;       // {cls, key}: the weapon slot whose build is open in the builder
    let _resetArmed = false;

    function _empty() {
        return { weapons: {}, gear: {}, carried: [] };
    }

    function _clean(raw) {
        if (!raw || typeof raw !== 'object') return _empty();
        return { weapons: raw.weapons || {}, gear: raw.gear || {}, carried: Array.isArray(raw.carried) ? raw.carried : [] };
    }

    function _load() {
        _store = { byClass: {} };
        try {
            const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
            if (raw && raw.byClass && typeof raw.byClass === 'object') {
                Object.keys(raw.byClass).forEach(function (id) { _store.byClass[id] = _clean(raw.byClass[id]); });
            } else {
                // The single loadout from before goes to the class it was built for
                const old = JSON.parse(localStorage.getItem(OLD_STORE_KEY) || 'null');
                const cls = localStorage.getItem('eftforge_arena_class');
                if (old && cls) _store.byClass[cls] = _clean(old);
            }
        } catch { /* private mode or a broken entry: start empty */ }
        _bind();
    }

    // Point _loadout at the selected class's loadout
    function _bind() {
        const cls = EFTForge.arena && EFTForge.arena.classId();
        if (!cls) {
            _loadout = _empty();
            return;
        }
        if (!_store.byClass[cls]) _store.byClass[cls] = _empty();
        _loadout = _store.byClass[cls];
    }

    function _save() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(_store)); } catch { /* private mode or full */ }
    }

    /* ===========================
       OPEN AND CLOSE
    =========================== */

    /**
     * Open a class's loadout, or BlastGang's shop for BLAST_GANG. Without a target, the
     * class picked last.
     * @param {string} [target]
     */
    async function open(target) {
        if (!EFTForge.arena || !EFTForge.arena.isActive()) return;
        // Nothing is being edited any more, so leaving the builder below doesn't come back here
        _editing = null;
        EFTForge.arenaShop && EFTForge.arenaShop.clearEditing();
        if (EFTForge.state.currentGun) returnToGunSelection();
        EFTForge.tabs && EFTForge.tabs.deactivateActiveTab && EFTForge.tabs.deactivateActiveTab();
        const container = document.getElementById('main-container');
        if (!container) return;
        _wire();
        container.classList.remove('no-gun');
        container.classList.add('arena-loadout-mode');
        // The shop keeps the page's old two panel layout (styles.css arena-shop-mode)
        container.classList.toggle('arena-shop-mode', target === BLAST_GANG);
        _active = true;
        _pick = _freshPick();
        _view = target === BLAST_GANG ? 'shop' : 'loadout';
        if (typeof _syncHeaderExpand === 'function') _syncHeaderExpand();
        _renderLoading();
        try {
            await _ensureData();
            if (_view === 'loadout') {
                if (target) EFTForge.arena.setClass(target);
                _bind();
                await _ensurePoints(_loadoutIds());
            } else {
                await EFTForge.arenaShop.load();
            }
        } catch (err) {
            console.warn('[arena-loadout] load failed:', err);
            const left = document.getElementById('arena-left-body');
            if (left) left.innerHTML = '<div class="atlas-empty error">' + escapeHtml(_t(_view === 'shop' ? 'arena.shop.unavailable' : 'arena.loadFailed')) + '</div>';
            return;
        }
        if (_active) render();
    }

    function leave() {
        if (!_active) return;
        _active = false;
        _pick = _freshPick();
        const container = document.getElementById('main-container');
        if (container) {
            container.classList.remove('arena-loadout-mode', 'arena-shop-mode');
            if (!(EFTForge.state && EFTForge.state.currentGun)) {
                container.classList.add('no-gun');
                if (typeof _syncHeaderScrollOnly === 'function') _syncHeaderScrollOnly();
            }
        }
        if (typeof closeMobileRightPanel === 'function') closeMobileRightPanel();
        renderLanding();
    }

    function isActive() { return _active; }
    function editingSlot() { return _editing ? _editing.key : null; }

    /** Where the builder's Back goes from the weapon open in it: its loadout or the shop. */
    function resumeTarget() {
        if (!EFTForge.arena || !EFTForge.arena.isActive()) return null;
        if (EFTForge.arenaShop && EFTForge.arenaShop.editingItem()) return BLAST_GANG;
        return _editing ? _editing.cls : null;
    }

    /* ===========================
       THE CLASS PICKER (Arena's front page)
    =========================== */

    /** Draw the class picker the left panel shows in Arena in place of the gun list. */
    function renderLanding() {
        const arena = EFTForge.arena;
        const box = document.getElementById('arena-class-picker');
        if (!box || !arena || !arena.isActive()) return;
        const classes = arena.classes();
        if (!classes.length) {
            // The class names come with Arena's config; draw once it's here
            arena.loadConfig().then(function (config) { if (config && config.classes.length) renderLanding(); })
                .catch(function (err) { console.warn('[arena] config:', err); });
            return;
        }
        const guns = (EFTForge.state && EFTForge.state.allGuns) || [];
        // A banner: the name on top, the class's icon (BlastGang's logo) in the middle, its limits at the foot
        const card = function (id, name, lines, icon) {
            const art = id === BLAST_GANG
                ? '<span class="arena-class-card-art"><img class="arena-class-card-logo" src="' + ARENA_ART + 'blastgang.webp" alt="" draggable="false"></span>'
                : '<span class="arena-class-card-art">' + (icon ? '<img class="arena-class-card-icon" src="' + ARENA_ART + 'classes/' + icon + '.webp" alt="" draggable="false">' : '') + '</span>';
            return '<button type="button" class="arena-class-card" data-arena-open="' + escapeHtml(id) + '">' +
                '<span class="arena-class-card-name">' + escapeHtml(name) + '</span>' + art +
                '<span class="arena-class-card-lines">' +
                lines.map(function (l) { return '<span class="arena-class-card-line">' + escapeHtml(l) + '</span>'; }).join('') + '</span></button>';
        };
        const cards = classes.map(function (c) {
            const count = guns.filter(function (g) { return arena.allowedForClass(g, c.id); }).length;
            const lines = [];
            if (c.meta_min != null && c.meta_max != null) lines.push(tFmt('arena.limit', { min: arena.formatMeta(c.meta_min), max: arena.formatMeta(c.meta_max) }));
            if (count) lines.push(tFmt('arena.classWeapons', { n: count }));
            return card(c.id, c.name, lines, CLASS_ICONS[c.key]);
        }).join('') + card(BLAST_GANG, _t('arena.shop.tab'), [_t('arena.shop.cardSub')], null);
        box.innerHTML = '<div class="section-title">' + escapeHtml(_t('arena.pickClass')) + '</div>' +
            '<div class="arena-class-cards">' + cards + '</div>';
        box.querySelectorAll('[data-arena-open]').forEach(function (node) {
            node.addEventListener('click', function () { open(/** @type {HTMLElement} */ (node).dataset.arenaOpen); });
        });
        if (!_active) _renderLandingRight();
    }

    function _renderLandingRight() {
        const right = document.getElementById('arena-right');
        if (!right) return;
        right.innerHTML = '<div class="attachment-placeholder bw-placeholder arena-placeholder"><div class="placeholder-inner">' +
            '<strong><em>' + escapeHtml(_t('arena.landing')) + '</em></strong>' +
            '<span class="placeholder-sub"><strong><em>' + escapeHtml(_t('arena.landingSub')) + '</em></strong></span></div></div>';
    }

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
        _loadout.carried.forEach(function (c) { if (c.where) carried += _carriedMeta(c); });
        return { weapons: weapons, gear: gear, carried: carried, mods: mods, total: weapons + gear + carried };
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
        // Gear that can't be worn together (an armored rig and body armor, a mask and a helmet)
        if (_data) {
            const seen = new Set();
            GEAR_SLOTS.forEach(function (key) {
                const worn = _loadout.gear[key];
                const conflict = worn ? _gearConflict(worn.id, key) : null;
                if (!conflict) return;
                const pair = [key, conflict.slot].sort().join('/');
                if (seen.has(pair)) return;
                seen.add(pair);
                out.push({ slot: key, text: named(worn.id) + ' / ' + named(conflict.id) });
            });
        }
        const cls = arena.currentClass();
        const sum = totals().total;
        if (cls && cls.meta_max != null && sum > cls.meta_max) {
            out.push({ slot: null, text: tFmt('arena.overLimit', { n: arena.formatMeta(sum - cls.meta_max) }) });
        }
        _loadout.carried.forEach(function (c) {
            if (!c.where) out.push({ slot: 'carried', text: ((_item(c.id) || {}).short_name || c.id) + ': ' + _t('arena.noRoom') });
        });
        return out;
    }

    /* ===========================
       RENDER: LEFT
    =========================== */

    function _renderLoading() {
        const left = document.getElementById('arena-left-body');
        if (left) left.innerHTML = '<div class="arena-loading"><span class="atlas-lookup-throbber"></span></div>';
        document.getElementById('arena-carry')?.replaceChildren();
        _renderRight();
    }

    function render() {
        if (!_active) return;
        const left = document.getElementById('arena-left-body');
        if (!left) return;
        const carry = document.getElementById('arena-carry');
        if (_view === 'shop') {
            // The shop has no rig or pockets
            if (carry) carry.replaceChildren();
            const right = document.getElementById('arena-right');
            EFTForge.arenaShop.render(left, right, _classHtml());
            wireClassTabs(left);
            return;
        }
        _normalize();
        left.innerHTML = _classHtml() + _metaHtml() + _problemsHtml() +
            '<div class="stats-section arena-board-section"><div class="arena-board" id="arena-board"></div></div>' + _snapshotHtml();
        _renderBoard();
        _renderCarry();
        _wireLeft(left);
        _renderRight();
    }

    // The class tabs across the top, as the game's preset editor has them, BlastGang last
    function _classHtml() {
        const classes = EFTForge.arena.classes();
        if (!classes.length) return '';
        const current = _view === 'shop' ? BLAST_GANG : EFTForge.arena.classId();
        const tab = function (id, name, icon) {
            return '<button type="button" class="toggle-btn' + (id === current ? ' active' : '') + (id === BLAST_GANG ? ' arena-tab-blastgang' : '') +
                '" data-arena-tab="' + escapeHtml(id) + '" aria-pressed="' + (id === current) + '">' +
                (icon ? '<img class="arena-tab-icon" src="' + ARENA_ART + 'classes/' + icon + '.webp" alt="" draggable="false">' : '') +
                escapeHtml(name) + '</button>';
        };
        return '<div class="arena-class-row" role="tablist">' + classes.map(function (c) { return tab(c.id, c.name, CLASS_ICONS[c.key]); }).join('') +
            tab(BLAST_GANG, _t('arena.shop.tab'), null) + '</div>';
    }

    /** Wire the class tabs _classHtml drew inside `root`. */
    function wireClassTabs(root) {
        root.querySelectorAll('[data-arena-tab]').forEach(function (node) {
            node.addEventListener('click', function () {
                const id = /** @type {HTMLElement} */ (node).dataset.arenaTab;
                const current = _view === 'shop' ? BLAST_GANG : EFTForge.arena.classId();
                if (id !== current) open(id);
            });
        });
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

    function _problemsHtml() {
        const list = problems();
        if (!list.length) return '';
        return '<div class="stats-section arena-problems"><div class="section-title">' + escapeHtml(_t('arena.violations')) + '</div>' +
            list.map(function (p) { return '<div class="arena-problem">' + escapeHtml(p.text) + '</div>'; }).join('') + '</div>';
    }

    function _snapshotHtml() {
        const snapshot = (EFTForge.arena.config() || {}).snapshot || {};
        return snapshot.version ? '<div class="arena-snapshot-note">' + escapeHtml(tFmt('arena.snapshot', { version: snapshot.version })) + '</div>' : '';
    }

    /* ===========================
       KITBASH! DRAWINGS
       A weapon's slot shows Kitbash!'s drawing of its whole build, loaded with its rounds, and
       a helmet wearing attachments its drawing with them, as the builder and the armor
       simulator draw them (/build-image). The item's own picture shows meanwhile, and stays
       where Kitbash! can't draw it.
    =========================== */

    const _drawings = new Map(); // build key -> data URL, null once it failed, or 'working'

    function _kitbashOff() {
        return !!(EFTForge.config && EFTForge.config.COMMUNITY_DISABLED);
    }

    function _drawing(key, draw) {
        const known = _drawings.get(key);
        if (known === 'working') return null;
        if (known !== undefined) return known;
        if (_kitbashOff()) return null;
        _drawings.set(key, 'working');
        draw();
        return null;
    }

    async function _requestDrawing(key, body) {
        let url = null;
        let busy = false;
        try {
            const res = await fetch(EFTForge.config.API_BASE + '/build-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            busy = res.status === 429;
            const data = res.ok ? await res.json() : null;
            url = data && data.image_url ? data.image_url : null;
        } catch (err) {
            busy = true;
            console.warn('[arena-loadout] Kitbash! could not draw:', err);
        }
        _drawings.set(key, url);
        // A busy renderer only holds for now: ask again a little later, not on every redraw
        if (busy) setTimeout(function () { if (_drawings.get(key) === null) _drawings.delete(key); }, 8000);
        if (_active && url) {
            // The shop's cards are drawn the same way (arena-shop.js)
            if (_view === 'shop') render();
            else {
                _renderBoard();
                _renderCarry();
            }
        }
    }

    function _weaponDrawing(weapon) {
        const pairs = weapon.pairs || [];
        const key = 'w|' + weapon.gunId + '|' + pairs.map(function (p) { return p.join(':'); }).join(',') + '|' + (weapon.ammoId || '');
        return _drawing(key, async function () {
            try {
                // The builder's slot cache names each part's slot for Kitbash!
                const cache = EFTForge.state.slotCache;
                const uncached = Array.from(new Set([weapon.gunId].concat(pairs.map(function (p) { return p[1]; })))).filter(function (id) { return !cache[id]; });
                if (uncached.length) {
                    const batch = await EFTForge.api.fetchItemSlotsBatch(uncached);
                    Object.keys(batch).forEach(function (id) { cacheSet(cache, id, batch[id]); });
                }
                const spt = _bpBuildSptItemsForPairs({ id: weapon.gunId }, pairs);
                if (!spt) { _drawings.set(key, null); return; }
                const ammo = weapon.ammoId ? { assume_full_mag: true, selected_ammo_id: weapon.ammoId } : {};
                await _requestDrawing(key, Object.assign({}, spt, ammo, { source: 'preview' }));
            } catch (err) {
                console.warn('[arena-loadout] Kitbash! weapon:', err);
                _drawings.set(key, null);
            }
        });
    }

    function _helmetDrawing(worn) {
        const slots = Object.keys(worn.parts || {}).sort();
        if (!slots.length) return null;
        const key = 'h|' + worn.id + '|' + slots.map(function (slot) { return slot + '=' + worn.parts[slot]; }).join(',');
        return _drawing(key, function () {
            // Kitbash! takes the helmet as SPT items; any 24 hex ids do
            const root = '000000000000000000000000';
            const items = [{ _id: root, _tpl: worn.id, parentId: 'hideout', slotId: 'hideout' }].concat(slots.map(function (slot, i) {
                return { _id: root.slice(0, -2) + String(i + 1).padStart(2, '0'), _tpl: worn.parts[slot], parentId: root, slotId: slot };
            }));
            _requestDrawing(key, { id: worn.id, items: items, source: 'armor' });
        });
    }

    /* ===========================
       GEAR CONFLICTS
       What the game won't let be worn together, as the armor simulator checks it: an armored
       rig and body armor, the items' own conflict lists (helmet parts included), and gear
       that covers the head or eyes.
    =========================== */

    function _gearRow(id) {
        const gear = (_data && _data.gear[id]) || {};
        const armor = (_data && _data.armor[id]) || {};
        return {
            id: id,
            name: armor.name || gear.name || id,
            conflicting_ids: (armor.conflicting_ids || []).concat(gear.conflicting_ids || []),
            blocks_headwear: !!(armor.blocks_headwear || gear.blocks_headwear),
            blocks_eyewear: !!(armor.blocks_eyewear || gear.blocks_eyewear),
        };
    }

    function _isArmoredRig(id) {
        const armor = _data && _data.armor[id];
        return !!(armor && (((armor.pieces || []).length) || ((armor.plate_slots || []).length)));
    }

    // Everything worn but what's in `skipSlot`, each with the slot it's in (a helmet part in Headwear)
    function _wornExcept(skipSlot) {
        const out = [];
        GEAR_SLOTS.forEach(function (slot) {
            const worn = _loadout.gear[slot];
            if (!worn || slot === skipSlot) return;
            out.push({ slot: slot, row: _gearRow(worn.id) });
            if (slot === 'Headwear') Object.values(worn.parts || {}).forEach(function (id) { out.push({ slot: slot, row: _gearRow(id) }); });
        });
        return out;
    }

    /** The slot holding what `id` can't be worn with in `slot` ('Headwear' for a helmet part), or null. */
    function _gearConflict(id, slot) {
        // An armored rig takes the body armor's place
        if (slot === 'TacticalVest' && _isArmoredRig(id) && _loadout.gear.ArmorVest) return { slot: 'ArmorVest', id: _loadout.gear.ArmorVest.id };
        if (slot === 'ArmorVest' && _loadout.gear.TacticalVest && _isArmoredRig(_loadout.gear.TacticalVest.id)) return { slot: 'TacticalVest', id: _loadout.gear.TacticalVest.id };
        const mine = _gearRow(id);
        for (const entry of _wornExcept(slot)) {
            const other = entry.row;
            if (mine.conflicting_ids.indexOf(other.id) !== -1 || other.conflicting_ids.indexOf(mine.id) !== -1 ||
                (mine.blocks_headwear && entry.slot === 'Headwear') || (mine.blocks_eyewear && entry.slot === 'Eyewear') ||
                (other.blocks_headwear && slot === 'Headwear') || (other.blocks_eyewear && slot === 'Eyewear')) {
                return { slot: entry.slot, id: other.id };
            }
        }
        return null;
    }

    function _conflictText(conflict) {
        return tFmt('arena.conflictWith', { name: (_item(conflict.id) || _gearRow(conflict.id)).name || '' });
    }

    // Flash the board slot in the way
    function _flashSlot(slot) {
        document.querySelectorAll('[data-arena-key="' + slot + '"]').forEach(function (node) {
            node.classList.remove('arena-slot-flash');
            void (/** @type {HTMLElement} */ (node)).offsetWidth;
            node.classList.add('arena-slot-flash');
            setTimeout(function () { node.classList.remove('arena-slot-flash'); }, 1200);
        });
    }

    /* ===========================
       THE BOARD
    =========================== */

    // A tile's place in a frame of the board's coordinates (the board, or the rig's own)
    function _place(x, y, w, h, frame) {
        return 'left:' + ((x - frame.x) * 100 / frame.w) + '%;top:' + ((y - frame.y) * 100 / frame.h) + '%;width:' + (w * 100 / frame.w) + '%;height:' + (h * 100 / frame.h) + '%';
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
     * @param {{ key: string, art: string|null, item: any, picture: string|null, mp: number|null, locked: boolean, insert: boolean, rounds?: string }} t
     */
    function _tile(t, x, y, w, h, frame) {
        const tile = document.createElement('div');
        tile.className = 'bw-slot' + (t.insert ? ' bw-slot-insert' : '') + (t.item ? ' is-equipped' : '') +
            (t.locked ? ' arena-slot-locked' : '') + (_targetKey() === t.key ? ' active-slot' : '');
        tile.setAttribute('style', _place(x, y, w, h, frame || BOARD_FRAME));
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
            // A weapon's rounds, bottom right as the game shows them
            if (t.rounds) {
                const rounds = document.createElement('span');
                rounds.className = 'bw-slot-dura arena-rounds';
                rounds.textContent = t.rounds;
                body.appendChild(rounds);
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
        GEAR_LAYOUT.forEach(function (spot) { _drawSpot(board, spot, BOARD_FRAME); });
        _wireTiles(board);
    }

    // One slot and its plates or helmet parts, into `board` in `frame`'s coordinates
    function _drawSpot(board, spot, frame) {
        const w = spot.w || SLOT;
        const h = spot.h || SLOT;
        const key = spot.slot;
        if (WEAPON_SLOTS.indexOf(key) !== -1) {
            const weapon = _loadout.weapons[key];
            const gun = weapon ? _item(weapon.gunId) : null;
            const ids = weapon ? [weapon.gunId].concat((weapon.pairs || []).map(function (p) { return p[1]; }), weapon.ammoId ? [weapon.ammoId] : []) : [];
            board.appendChild(_tile({
                key: key, art: key, item: gun, picture: gun ? (_weaponDrawing(weapon) || gun.image_512_link || gun.icon_link) : null,
                mp: weapon ? _weaponMeta(weapon).total : null, locked: !!weapon && _locked(ids, gun), insert: false,
                rounds: weapon ? _roundsText(weapon) : '',
            }, spot.x, spot.y, w, h, frame));
            return;
        }
        const worn = _loadout.gear[key];
        const item = worn ? (_data.armor[worn.id] || _item(worn.id)) : null;
        const ids = worn ? [worn.id].concat(Object.values(worn.plates || {}), Object.values(worn.parts || {})) : [];
        const drawing = worn && key === 'Headwear' ? _helmetDrawing(worn) : null;
        board.appendChild(_tile({
            key: key, art: key, item: item, picture: item ? (drawing || item.image_link || item.icon_link) : null,
            mp: worn ? _gearMeta(worn) : null, locked: !!worn && _locked(ids, null), insert: false,
        }, spot.x, spot.y, w, h, frame));
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
                }, xy[0], xy[1], INSERT, INSERT, frame));
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
                }, xy[0], xy[1], INSERT, INSERT, frame));
            });
        }
    }

    function _wireTiles(board) {
        board.querySelectorAll('[data-arena-key]').forEach(function (node) {
            const tile = /** @type {HTMLElement} */ (node);
            const key = tile.dataset.arenaKey;
            tile.addEventListener('click', function () { _openSlot(key); });
            tile.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _openSlot(key); }
            });
            tile.addEventListener('contextmenu', function (e) { _slotMenu(e, key); });
            // An equipped slot can be dragged: onto another slot of its kind, or onto the list to discard
            tile.addEventListener('pointerdown', function (e) {
                if (!tile.classList.contains('is-equipped')) return;
                const icon = /** @type {HTMLImageElement | null} */ (tile.querySelector('.bw-slot-icon'));
                _pressItem(e, { kind: 'slot', key: key, id: null, size: [1, 1], grid: false, picture: icon ? icon.src : '', fallback: '' });
            });
        });
    }

    /* ===========================
       THE PICKER'S STATE
       The right panel is always the game's item list: five category tabs across the top
       (weapons, equipment, meds, magazines, ammo), each with its own filter column. A board
       slot, a rig or pocket cell, or a magazine in the rig switches the tab to what it takes.
    =========================== */

    function _freshPick() {
        // target: {kind: 'slot', key} | {kind: 'container', where: 'rig' | 'pockets'} | {kind: 'load', index} | null
        return { tab: 'weapons', filters: {}, target: null, search: '' };
    }

    function _targetKey() {
        const t = _pick.target;
        return t && t.kind === 'slot' ? t.key : null;
    }

    function _showPicker() {
        _renderBoard();
        _renderCarry();
        _renderRight();
        if (typeof openMobileRightPanel === 'function') openMobileRightPanel();
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

    // A board slot: the tab that fills it, aimed at it
    async function _openSlot(key) {
        const parts = key.split(':');
        _pick.search = '';
        _pick.target = { kind: 'slot', key: key };
        if (parts.length === 3) {
            const allowed = _insertAllowed(key);
            // The armor catalog has no class rules: /arena/points has them
            try { await _ensurePoints(allowed); } catch (err) { console.warn('[arena-loadout] points:', err); }
            _pick.tab = 'equipment';
        } else if (WEAPON_SLOTS.indexOf(key) !== -1) {
            _pick.tab = 'weapons';
            const weapon = _loadout.weapons[key];
            const gun = weapon ? _item(weapon.gunId) : null;
            _pick.filters.weapons = gun ? _typeOf(gun) : (key === 'Holster' ? 'pistols' : null);
        } else if (key === 'Scabbard') {
            _pick.tab = 'weapons';
            _pick.filters.weapons = MELEE;
        } else {
            _pick.tab = 'equipment';
            _pick.filters.equipment = key;
            _pick.equipSub = null;
        }
        _showPicker();
    }

    function _insertAllowed(key) {
        const parts = key.split(':');
        const worn = _loadout.gear[parts[0]];
        const armor = worn && _data.armor[worn.id];
        if (!armor) return [];
        const list = parts[1] === 'plate' ? armor.plate_slots : armor.attachment_slots;
        const slot = (list || []).find(function (s) { return s.slot === parts[2]; });
        return slot ? (slot.allowed_plate_ids || slot.allowed_ids || []) : [];
    }

    // An armor row with the meta points and classes /arena/points knows for it
    function _withPoints(row) {
        const extra = _points[row.id];
        return extra ? Object.assign({}, row, { meta_points: extra.meta_points, arena_class_ids: extra.arena_class_ids }) : row;
    }

    let _compat = null;        // {key, mags: {magazine id: weapon slot}, calibers: Set}

    function _compatKey() {
        return JSON.stringify(WEAPON_SLOTS.map(function (k) {
            const w = _loadout.weapons[k];
            return w ? [k, w.gunId, w.pairs] : null;
        }));
    }

    // What the loadout's weapons take, as the game narrows its magazine and ammo tabs: the
    // magazines their magazine slots allow (anywhere in the build), and their calibers
    async function _carryCompat() {
        const cacheKey = _compatKey();
        if (_compat && _compat.key === cacheKey) return _compat;
        const weapons = WEAPON_SLOTS.map(function (k) { return { key: k, w: _loadout.weapons[k] }; }).filter(function (x) { return x.w; });
        const calibers = new Set();
        const mags = {};
        const owners = {};
        const magSlotByKey = {};
        weapons.forEach(function (x) {
            const gun = _item(x.w.gunId);
            if (gun && gun.caliber) calibers.add(gun.caliber);
            [x.w.gunId].concat((x.w.pairs || []).map(function (p) { return p[1]; })).forEach(function (id) { owners[id] = owners[id] || x.key; });
        });
        const ids = Object.keys(owners);
        if (ids.length) {
            const slotsBy = await EFTForge.api.fetchItemSlotsBatch(ids);
            const magSlots = {};
            ids.forEach(function (id) {
                (slotsBy[id] || []).forEach(function (slot) { if (slot.slot_game_name === 'mod_magazine') magSlots[slot.id] = owners[id]; });
            });
            const slotIds = Object.keys(magSlots);
            slotIds.forEach(function (slotId) { if (!magSlotByKey[magSlots[slotId]]) magSlotByKey[magSlots[slotId]] = slotId; });
            if (slotIds.length) {
                const allowed = await EFTForge.api.fetchSlotAllowedItemsBatch(slotIds);
                slotIds.forEach(function (slotId) {
                    (allowed[slotId] || []).forEach(function (item) { if (!mags[item.id]) mags[item.id] = magSlots[slotId]; });
                });
            }
        }
        _compat = { key: cacheKey, mags: mags, calibers: calibers, magSlots: magSlotByKey };
        return _compat;
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

    // Where a weapon picked without a slot in mind goes: a pistol in the holster, a long gun
    // on the sling, else on the back, else in place of the one on the sling
    function _autoWeaponSlot(gun) {
        if (gun.gear_slot === 'Holster') return 'Holster';
        if (!_loadout.weapons.FirstPrimaryWeapon) return 'FirstPrimaryWeapon';
        if (!_loadout.weapons.SecondPrimaryWeapon) return 'SecondPrimaryWeapon';
        return 'FirstPrimaryWeapon';
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
        _pick.target = { kind: 'slot', key: key };
        await _ensurePoints(_loadoutIds());
        _changed();
    }

    function _editWeapon(key) {
        const weapon = _loadout.weapons[key];
        if (!weapon || typeof loadBuildFromPayload !== 'function') return;
        const editing = { cls: EFTForge.arena.classId(), key: key, ready: false };
        _editing = editing;
        Promise.resolve(loadBuildFromPayload({ g: weapon.gunId, p: weapon.pairs || [], a: weapon.ammoId || null }))
            .then(function () { editing.ready = true; syncEditedWeapon(); });
    }

    /** The builder's parts become the loadout weapon's on every change (no Save). Its rounds
     *  are the loadout's: they're loaded and unloaded there. */
    function syncEditedWeapon() {
        const state = EFTForge.state;
        if (!_editing || !_editing.ready || !state.currentGun || !state.buildTree || typeof collectSlotPairs !== 'function') return;
        _load();
        const loadout = _store.byClass[_editing.cls];
        const weapon = loadout && loadout.weapons[_editing.key];
        if (!weapon || weapon.gunId !== state.currentGun.id) return;
        weapon.pairs = collectSlotPairs(state.buildTree);
        _save();
    }

    /** The stats panel's Save to loadout: the build open in the builder goes back to its slot. */
    async function saveEditedWeapon() {
        const state = EFTForge.state;
        if (!_editing || !state.currentGun || typeof collectSlotPairs !== 'function') return;
        const ammoSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById('ammo-select'));
        _load();
        if (!_store.byClass[_editing.cls]) _store.byClass[_editing.cls] = _empty();
        _store.byClass[_editing.cls].weapons[_editing.key] = {
            gunId: state.currentGun.id,
            pairs: collectSlotPairs(state.buildTree),
            ammoId: ammoSelect && ammoSelect.value ? ammoSelect.value : null,
        };
        _save();
        showToast(_t('arena.loadout'), _t('arena.savedToLoadout'), 2500, '#407d9b');
    }

    function _changed() {
        _save();
        if (_active) render();
    }

    function _wireLeft(left) {
        wireClassTabs(left);
    }

    /* ===========================
       THE RIG AND POCKETS (the middle column)
       The rig's grids as the game's rig window lays them out (data/arena-rig-layouts.js), and
       the four single-cell pockets every Arena preset has. A carried item sits at a cell:
       {id, count, ammoId, where: 'rig' | 'pockets', grid, x, y, r (turned)}. One a new rig
       can't hold goes to the first free spot, or waits unplaced.
    =========================== */

    function _sizeOf(id) {
        const item = (_data && _data.gear[id]) || _item(id) || {};
        return [item.width || 1, item.height || 1];
    }

    function _dims(c) {
        const size = _sizeOf(c.id);
        return c.r ? [size[1], size[0]] : size;
    }

    function _gridsOf(where) {
        if (where === 'pockets') return POCKETS;
        const rig = _loadout.gear.TacticalVest;
        const item = rig && _data ? _data.gear[rig.id] : null;
        return (item && item.grids) || [];
    }

    // {"where:grid": Set of "x,y"} for every placed item but `skip`
    function _taken(skip) {
        const taken = {};
        _loadout.carried.forEach(function (c, index) {
            if (index === skip || !c.where) return;
            _mark(taken, c);
        });
        return taken;
    }

    function _mark(taken, c) {
        const d = _dims(c);
        const key = c.where + ':' + c.grid;
        taken[key] = taken[key] || new Set();
        for (let y = c.y; y < c.y + d[1]; y++) for (let x = c.x; x < c.x + d[0]; x++) taken[key].add(x + ',' + y);
    }

    function _free(taken, where, grid, x, y, w, h) {
        const g = _gridsOf(where)[grid];
        if (!g || x < 0 || y < 0 || x + w > g[0] || y + h > g[1]) return false;
        const used = taken[where + ':' + grid];
        if (!used) return true;
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (used.has(xx + ',' + yy)) return false;
        return true;
    }

    // The first spot that holds the item, upright first, row by row in each grid in turn
    function _findSpot(taken, id, wheres) {
        const size = _sizeOf(id);
        for (const where of wheres) {
            const grids = _gridsOf(where);
            for (let grid = 0; grid < grids.length; grid++) {
                for (let y = 0; y < grids[grid][1]; y++) {
                    for (let x = 0; x < grids[grid][0]; x++) {
                        if (_free(taken, where, grid, x, y, size[0], size[1])) return { where: where, grid: grid, x: x, y: y, r: 0 };
                        if (size[0] !== size[1] && _free(taken, where, grid, x, y, size[1], size[0])) return { where: where, grid: grid, x: x, y: y, r: 1 };
                    }
                }
            }
        }
        return null;
    }

    // Every carried item at a free spot of its own, the way the stored loadout and the rig
    // allow; an item left without one is marked unplaced
    function _normalize() {
        const taken = {};
        _loadout.carried.forEach(function (c) {
            const d = c.where ? _dims(c) : null;
            if (c.where && typeof c.grid === 'number' && _free(taken, c.where, c.grid, c.x, c.y, d[0], d[1])) {
                _mark(taken, c);
                return;
            }
            const spot = _findSpot(taken, c.id, c.where === 'pockets' ? ['pockets', 'rig'] : ['rig', 'pockets']);
            if (spot) {
                Object.assign(c, spot);
                _mark(taken, c);
            } else {
                c.where = null;
            }
        });
    }

    // Put a picked item in the selected container (or at `forced`, where a drag dropped it)
    function _addCarried(row, forced) {
        const entry = { id: row.id, count: row.carry_kind === 'ammo' ? (row.stack_max_size || 30) : 1 };
        // A magazine comes empty: rounds are loaded by hand (drag them on, Ctrl+click them, or
        // click the magazine)
        const taken = _taken(-1);
        const t = _pick.target;
        let spot = null;
        if (forced) {
            spot = forced;
        } else if (t && t.kind === 'container') {
            // The selected container first, then the other
            spot = _findSpot(taken, row.id, t.where === 'pockets' ? ['pockets', 'rig'] : ['rig', 'pockets']);
        } else {
            spot = _findSpot(taken, row.id, ['rig', 'pockets']);
        }
        if (!spot) {
            showToast(_t('arena.loadout'), _t('arena.noRoom'), 2500, '#c0504d');
            return;
        }
        _loadout.carried.push(Object.assign(entry, spot));
        _changed();
    }

    // The rig's slot tile (and its plates, if it takes any) in a frame of its own, drawn at the
    // grids' scale
    // The rig slot's frame: the tile and its header, and room for the plates the rig takes
    function _rigFrame(rigId) {
        const armor = rigId && _data.armor[rigId];
        const sides = new Set(((armor && armor.plate_slots) || []).map(function (slot) {
            return PLATE_SPOTS[String(slot.slot).toLowerCase()];
        }).filter(Boolean));
        const pad = INSERT + INSERT_GAP;
        const x = -3 - (sides.has('left') ? pad : 0);
        const y = -22 - (sides.has('back') ? pad : 0);
        return { x: x, y: y, w: SLOT + 3 + (sides.has('right') ? pad : 0) - x, h: SLOT + (sides.has('front') ? pad : 0) - y };
    }

    // Where a rig's grids sit: its own layout, else one row 6 px apart. {spots, width, height}
    function _gridLayout(rigId, grids) {
        const layouts = EFTForge.arenaRigLayouts || { layouts: {}, rigs: {} };
        const layout = rigId ? layouts.layouts[layouts.rigs[rigId]] : null;
        const spots = [];
        if (layout && layout.grids.length === grids.length) {
            // Trimmed to the grids themselves: the layout's frame has uneven margins, which
            // would sit the grids off center in their outline
            let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
            layout.grids.forEach(function (r, i) {
                const w = grids[i][0] * CELL + 1;
                const h = grids[i][1] * CELL + 1;
                minX = Math.min(minX, r[0]);
                minY = Math.min(minY, r[1]);
                maxX = Math.max(maxX, r[0] + w);
                maxY = Math.max(maxY, r[1] + h);
            });
            layout.grids.forEach(function (r) { spots.push([r[0] - minX, r[1] - minY]); });
            return { spots: spots, width: maxX - minX, height: maxY - minY };
        }
        let x = 0;
        let height = 0;
        grids.forEach(function (g) {
            spots.push([x, 0]);
            x += g[0] * CELL + 1 + 6;
            height = Math.max(height, g[1] * CELL + 1);
        });
        return { spots: spots, width: Math.max(0, x - 6), height: height };
    }

    let _carryWidth = 0;
    // The middle column's width: what the widest rig Arena has needs (its slot with its plates,
    // the gap, its grids and their outline), so a big rig never squeezes the board's column
    function _reserveCarryWidth() {
        if (!_carryWidth) {
            let widest = POCKETS.length * (CELL + 1 + 6);
            Object.values(_data.gear).forEach(function (item) {
                if (item.gear_slot !== 'TacticalVest') return;
                const grids = item.grids || [];
                widest = Math.max(widest, _rigFrame(item.id).w + 12 + _gridLayout(item.id, grids).width + 10);
            });
            _carryWidth = Math.ceil(widest * CARRY_SCALE);
        }
        return _carryWidth;
    }

    function _rigSlotView() {
        const worn = _loadout.gear.TacticalVest;
        const frame = _rigFrame(worn ? worn.id : null);
        const board = document.createElement('div');
        board.className = 'arena-board arena-rig-board';
        board.style.width = (frame.w * CARRY_SCALE) + 'px';
        board.style.height = (frame.h * CARRY_SCALE) + 'px';
        board.style.setProperty('--frame-w', String(frame.w));
        _drawSpot(board, { slot: 'TacticalVest', x: 0, y: 0 }, frame);
        _wireTiles(board);
        return board;
    }

    // The item alone on a transparent background (tarkov.dev's base image): its grid image
    // carries the short name and background color already, which we draw ourselves
    function _gridImage(id) {
        const item = (_data && _data.gear[id]) || {};
        return item.image_link || ('https://assets.tarkov.dev/' + id + '-base-image.webp');
    }

    function _renderCarry() {
        const box = document.getElementById('arena-carry');
        if (!box || !_data) return;
        box.style.setProperty('--carry-w', _reserveCarryWidth() + 'px');
        // The rig's slot beside its grids, as the game's middle column has them, the pockets under
        const top = document.createElement('div');
        top.className = 'arena-carry-top';
        top.append(_rigSlotView(), _containerPanel('rig'));
        box.replaceChildren(top, _containerPanel('pockets'));
        const unplaced = _loadout.carried.map(function (c, index) { return { c: c, index: index }; }).filter(function (x) { return !x.c.where; });
        if (unplaced.length) {
            const strip = document.createElement('div');
            strip.className = 'arena-carry-unplaced';
            strip.innerHTML = '<div class="arena-carry-unplaced-title">' + escapeHtml(_t('arena.unplaced')) + '</div>' +
                unplaced.map(function (x) {
                    const item = _item(x.c.id) || {};
                    return '<button type="button" class="arena-carry-unplaced-item" data-index="' + x.index + '" data-tooltip="' + escapeHtml(_t('arena.remove')) + '">' +
                        escapeHtml(item.short_name || item.name || x.c.id) + ' &#x2715;</button>';
                }).join('');
            strip.querySelectorAll('[data-index]').forEach(function (node) {
                node.addEventListener('click', function () {
                    _loadout.carried.splice(Number(/** @type {HTMLElement} */ (node).dataset.index), 1);
                    _changed();
                });
            });
            box.appendChild(strip);
        }
    }

    // One container window: a header with the meta points of what's inside, then its grids
    function _containerPanel(where) {
        const arena = EFTForge.arena;
        const panel = document.createElement('div');
        panel.className = 'arena-carry-panel';
        let mp = 0;
        _loadout.carried.forEach(function (c) { if (c.where === where) mp += _carriedMeta(c); });
        const head = document.createElement('div');
        head.className = 'arena-carry-head';
        head.innerHTML = '<span class="arena-carry-label">' + escapeHtml(_t(where === 'rig' ? 'arena.rig' : 'arena.pockets')) + '</span>' +
            '<span class="arena-meta">' + escapeHtml(arena.formatMeta(mp)) + '</span>';
        panel.appendChild(head);

        const grids = _gridsOf(where);
        if (!grids.length) {
            const empty = document.createElement('div');
            empty.className = 'arena-carry-empty';
            empty.textContent = _t('arena.noRig');
            panel.appendChild(empty);
            return panel;
        }
        const area = document.createElement('div');
        const t = _pick.target;
        area.className = 'arena-carry-area' + (t && t.kind === 'container' && t.where === where ? ' is-active' : '');
        area.dataset.where = where;
        // The whole rig or pockets is one target, as in the game: anywhere in it opens the rig's
        // magazines or the pockets' meds, and what's picked goes in it where it fits
        area.addEventListener('click', function () {
            _pick.target = { kind: 'container', where: where };
            _pick.tab = where === 'pockets' ? 'meds' : 'mags';
            _pick.search = '';
            _showPicker();
        });
        const rig = where === 'rig' ? _loadout.gear.TacticalVest : null;
        const placed = _gridLayout(rig ? rig.id : null, grids);
        const spots = placed.spots;
        const width = placed.width;
        const height = placed.height;
        const scale = document.createElement('div');
        scale.className = 'arena-carry-scale';
        scale.style.width = (width * CARRY_SCALE) + 'px';
        scale.style.height = (height * CARRY_SCALE) + 'px';
        const inner = document.createElement('div');
        inner.className = 'arena-carry-inner';
        inner.style.width = width + 'px';
        inner.style.height = height + 'px';
        inner.style.transform = 'scale(' + CARRY_SCALE + ')';
        grids.forEach(function (g, index) {
            inner.appendChild(_gridView(where, index, g, spots[index]));
        });
        scale.appendChild(inner);
        area.appendChild(scale);
        panel.appendChild(area);
        return panel;
    }

    function _gridView(where, index, g, spot) {
        const grid = document.createElement('div');
        grid.className = 'arena-cgrid';
        grid.dataset.where = where;
        grid.dataset.grid = String(index);
        grid.style.left = spot[0] + 'px';
        grid.style.top = spot[1] + 'px';
        grid.style.width = (g[0] * CELL + 1) + 'px';
        grid.style.height = (g[1] * CELL + 1) + 'px';
        _loadout.carried.forEach(function (c, i) {
            if (c.where !== where || c.grid !== index) return;
            grid.appendChild(_carriedView(c, i));
        });
        return grid;
    }

    function _carriedView(c, index) {
        const item = _item(c.id) || {};
        const gear = (_data && _data.gear[c.id]) || item;
        const d = _dims(c);
        const size = _sizeOf(c.id);
        const el = document.createElement('div');
        el.className = 'arena-citem' + (_pick.target && _pick.target.kind === 'load' && _pick.target.index === index ? ' is-target' : '') +
            (!EFTForge.arena.allowedForClass(gear) ? ' is-locked' : '');
        el.dataset.index = String(index);
        el.style.left = (c.x * CELL) + 'px';
        el.style.top = (c.y * CELL) + 'px';
        el.style.width = (d[0] * CELL + 1) + 'px';
        el.style.height = (d[1] * CELL + 1) + 'px';
        el.style.background = SLOT_COLORS[gear.background_color] || SLOT_COLORS.default;
        const img = document.createElement('img');
        img.className = 'arena-citem-img';
        img.alt = '';
        img.draggable = false;
        img.src = _gridImage(c.id);
        img.addEventListener('error', function () {
            if (gear.icon_link && img.src !== gear.icon_link) img.src = gear.icon_link;
            else img.remove();
        }, { once: false });
        // Turned items keep the picture's own proportions, a quarter turn around the middle
        const iw = size[0] * CELL;
        const ih = size[1] * CELL;
        img.style.width = iw + 'px';
        img.style.height = ih + 'px';
        img.style.left = ((d[0] * CELL + 1 - iw) / 2) + 'px';
        img.style.top = ((d[1] * CELL + 1 - ih) / 2) + 'px';
        if (c.r) img.style.transform = 'rotate(90deg)';
        el.appendChild(img);
        const name = document.createElement('span');
        // The site's own top right short name (.slot-shortname, shortNameHtml)
        name.className = 'slot-shortname';
        name.innerHTML = shortNameHtml(item.short_name || item.name || '');
        el.appendChild(name);
        let count = '';
        if (gear.carry_kind === 'magazine' && gear.magazine_capacity) count = (c.ammoId ? gear.magazine_capacity : 0) + '/' + gear.magazine_capacity;
        else if (gear.carry_kind === 'ammo') count = String(c.count || 1);
        if (count) {
            el.classList.add('has-count');
            const n = document.createElement('span');
            n.className = 'arena-citem-count';
            n.textContent = count;
            el.appendChild(n);
        }
        // What it all costs: the stack, or the magazine with its rounds
        const mp = document.createElement('span');
        mp.className = 'arena-citem-mp arena-meta';
        mp.textContent = EFTForge.arena.formatMeta(_carriedMeta(c));
        el.appendChild(mp);
        el.dataset.tooltip = (item.name || '') + (c.ammoId && _item(c.ammoId) ? ' (' + (_item(c.ammoId).short_name || '') + ')' : '');
        el.addEventListener('pointerdown', function (e) {
            _pressItem(e, {
                kind: 'carried', index: index, id: c.id, size: _sizeOf(c.id), r: c.r ? 1 : 0, grid: true,
                picture: _gridImage(c.id), fallback: gear.icon_link || '',
            });
        });
        el.addEventListener('click', function (e) {
            // Ctrl+click moves it to the other container
            if (e.ctrlKey || e.metaKey) {
                e.stopPropagation();
                _quickMove(index);
                return;
            }
            // A magazine opens the ammo it can be loaded with; anything else selects its container
            if (gear.carry_kind === 'magazine') {
                e.stopPropagation();
                _pick.target = { kind: 'load', index: index };
                _pick.tab = 'ammo';
                _pick.search = '';
                _showPicker();
            }
        });
        el.addEventListener('contextmenu', function (e) { _carriedMenu(e, index); });
        return el;
    }

    /* ===========================
       INTERACTIONS: the context menu, Ctrl and Alt clicks, drag and drop
       As the game's preset editor (and TarkTetris) has them. Right click opens an item's menu:
       a weapon's Modding, Unload ammo, Unload (its magazine into the rig), Remove mag and
       Discard; gear's Modding and Discard; a carried magazine's Unload ammo, Duplicate and
       Discard. Ctrl+click moves a carried item to the other container. Dragging moves a carried
       item (R turns it), drops a list card into the rig, the pockets or a slot, and a magazine
       onto the weapon it fits.
    =========================== */

    const MENU_ART = 'assets/images/arena/menu/';
    const DRAG_THRESHOLD = 10;

    let _menuEl = null;

    function _closeMenu() {
        if (_menuEl) _menuEl.remove();
        _menuEl = null;
        document.removeEventListener('pointerdown', _menuOutside, true);
        document.removeEventListener('keydown', _menuKey, true);
        window.removeEventListener('blur', _closeMenu);
    }

    function _menuOutside(e) {
        if (_menuEl && !_menuEl.contains(/** @type {Node} */ (e.target))) _closeMenu();
    }

    function _menuKey(e) {
        if (e.key === 'Escape') _closeMenu();
    }

    /** @param {{ icon: string, label: string, danger?: boolean, run: function }[]} entries */
    function _openMenu(e, entries) {
        e.preventDefault();
        e.stopPropagation();
        _closeMenu();
        if (!entries.length) return;
        const menu = document.createElement('div');
        menu.className = 'arena-menu';
        menu.setAttribute('role', 'menu');
        entries.forEach(function (entry, index) {
            // The game sets the destructive entries apart at the bottom
            if (entry.danger && index > 0 && !entries[index - 1].danger) {
                const gap = document.createElement('div');
                gap.className = 'arena-menu-gap';
                menu.appendChild(gap);
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'arena-menu-item' + (entry.danger ? ' is-danger' : '');
            button.setAttribute('role', 'menuitem');
            button.innerHTML = '<img src="' + MENU_ART + entry.icon + '.webp" alt="" draggable="false"><span>' + escapeHtml(entry.label) + '</span>';
            button.addEventListener('click', function () {
                _closeMenu();
                entry.run();
            });
            menu.appendChild(button);
        });
        document.body.appendChild(menu);
        // Opens down and right of the cursor, kept on screen
        const rect = menu.getBoundingClientRect();
        menu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - rect.width - 4)) + 'px';
        menu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - rect.height - 4)) + 'px';
        _menuEl = menu;
        document.addEventListener('pointerdown', _menuOutside, true);
        document.addEventListener('keydown', _menuKey, true);
        window.addEventListener('blur', _closeMenu);
    }

    // The pair of a weapon's build that holds its magazine, or -1
    function _magPairIndex(weapon) {
        return (weapon.pairs || []).findIndex(function (pair) {
            const part = _item(pair[1]);
            return !!(part && (part.magazine_capacity > 0 || part.carry_kind === 'magazine'));
        });
    }

    // A board slot's menu: a weapon's and gear's entries, a plate's or helmet part's Discard
    function _slotMenu(e, key) {
        const entries = [];
        const parts = key.split(':');
        if (WEAPON_SLOTS.indexOf(key) !== -1) {
            const weapon = _loadout.weapons[key];
            if (!weapon) return;
            const magIndex = _magPairIndex(weapon);
            entries.push({ icon: 'modding', label: _t('arena.menu.modding'), run: function () { _editWeapon(key); } });
            if (weapon.ammoId) {
                entries.push({ icon: 'unload-ammo', label: _t('arena.menu.unloadAmmo'), run: function () { _unloadWeaponAmmo(key); } });
            }
            if (magIndex !== -1) {
                entries.push({ icon: 'unload', label: _t('arena.menu.unload'), run: function () { _unloadWeapon(key); } });
                entries.push({ icon: 'discard', label: _t('arena.menu.removeMag'), danger: true, run: function () {
                    weapon.pairs.splice(magIndex, 1);
                    _changed();
                } });
            }
            entries.push({ icon: 'discard', label: _t('arena.menu.discard'), danger: true, run: function () { _clearSlot(key); } });
        } else if (parts.length === 3) {
            const worn = _loadout.gear[parts[0]];
            const store = parts[1] === 'plate' ? 'plates' : 'parts';
            if (!worn || !(worn[store] || {})[parts[2]]) return;
            entries.push({ icon: 'discard', label: _t('arena.menu.discard'), danger: true, run: function () { _clearSlot(key); } });
        } else {
            const worn = _loadout.gear[key];
            if (!worn) return;
            // Modding opens what the gear takes: its first plate or helmet part slot
            const armor = _data.armor[worn.id];
            const first = armor && ((armor.plate_slots || []).find(function (s) { return PLATE_SPOTS[String(s.slot).toLowerCase()]; }) ||
                (armor.attachment_slots || [])[0]);
            if (first) {
                const insertKey = key + ':' + (armor.plate_slots && armor.plate_slots.indexOf(first) !== -1 ? 'plate' : 'part') + ':' + first.slot;
                entries.push({ icon: 'modding', label: _t('arena.menu.modding'), run: function () { _openSlot(insertKey); } });
            }
            entries.push({ icon: 'discard', label: _t('arena.menu.discard'), danger: true, run: function () { _clearSlot(key); } });
        }
        _openMenu(e, entries);
    }

    // A carried item's menu
    function _carriedMenu(e, index) {
        const c = _loadout.carried[index];
        if (!c) return;
        const gear = (_data && _data.gear[c.id]) || _item(c.id) || {};
        const entries = [];
        if (gear.carry_kind === 'magazine' && c.ammoId) {
            entries.push({ icon: 'unload-ammo', label: _t('arena.menu.unloadAmmo'), run: function () { _unloadMagAmmo(index); } });
        }
        entries.push({ icon: 'duplicate', label: _t('arena.menu.duplicate'), run: function () { _duplicate(index); } });
        entries.push({ icon: 'discard', label: _t('arena.menu.discard'), danger: true, run: function () {
            _loadout.carried.splice(index, 1);
            if (_pick.target && _pick.target.kind === 'load') _pick.target = null;
            _changed();
        } });
        _openMenu(e, entries);
    }

    /* ---- Loading and unloading rounds ---- */

    function _capacityOf(id) {
        const item = (_data && _data.gear[id]) || _item(id) || {};
        return item.magazine_capacity || 0;
    }

    // The caliber a carried magazine takes: the gun it fits (the loadout's weapons)
    function _magCaliber(magId) {
        const key = _compat && _compat.mags[magId];
        const weapon = key ? _loadout.weapons[key] : null;
        const gun = weapon ? _item(weapon.gunId) : null;
        return gun ? gun.caliber : null;
    }

    // What a weapon holds, the chamber counted, as the game's slot shows it: 31/31 for a loaded
    // 30 round magazine, 0/31 unloaded, 1/1 with just a round chambered
    function _roundsText(weapon) {
        const mag = _weaponMagIn(weapon);
        const max = (mag ? _capacityOf(mag) : 0) + 1;
        return (weapon.ammoId ? max : 0) + '/' + max;
    }

    function _weaponMagIn(weapon) {
        const index = _magPairIndex(weapon);
        return index === -1 ? null : weapon.pairs[index][1];
    }

    // `count` rounds into the rig and pockets: topping up stacks of the same round first, then
    // new stacks where they fit. False, changing nothing, when there's no room for them all.
    function _putAmmo(ammoId, count) {
        const max = ((_data && _data.gear[ammoId]) || {}).stack_max_size || count;
        const plan = [];
        let left = count;
        _loadout.carried.forEach(function (c, index) {
            if (left <= 0 || c.id !== ammoId || !c.where) return;
            const room = Math.max(0, max - (c.count || 0));
            if (room) {
                const add = Math.min(room, left);
                plan.push({ index: index, add: add });
                left -= add;
            }
        });
        const added = [];
        const taken = _taken(-1);
        while (left > 0) {
            const spot = _findSpot(taken, ammoId, ['rig', 'pockets']);
            if (!spot) return false;
            const stack = Object.assign({ id: ammoId, count: Math.min(max, left) }, spot);
            _mark(taken, stack);
            added.push(stack);
            left -= stack.count;
        }
        plan.forEach(function (p) { _loadout.carried[p.index].count += p.add; });
        added.forEach(function (stack) { _loadout.carried.push(stack); });
        return true;
    }

    // Take `count` rounds from a carried stack (it goes once empty)
    function _takeAmmo(index, count) {
        const stack = _loadout.carried[index];
        if (!stack) return;
        stack.count = (stack.count || 1) - count;
        if (stack.count <= 0) _loadout.carried.splice(index, 1);
    }

    function _noRoom() {
        replaceToast('arena-room', _t('arena.loadout'), _t('arena.noRoom'));
    }

    // Unload ammo on a magazine: its rounds go into the rig or pockets
    function _unloadMagAmmo(index) {
        const c = _loadout.carried[index];
        if (!c || !c.ammoId) return;
        const ammoId = c.ammoId;
        c.ammoId = null;
        if (!_putAmmo(ammoId, _capacityOf(c.id))) {
            c.ammoId = ammoId;
            _noRoom();
            return;
        }
        _changed();
    }

    // Unload ammo on a weapon empties its magazine and chamber; the rounds are gone, not put in
    // the rig or pockets
    function _unloadWeaponAmmo(key) {
        const weapon = _loadout.weapons[key];
        if (!weapon || !weapon.ammoId) return;
        weapon.ammoId = null;
        _changed();
    }

    // Rounds onto a carried magazine: it fills from them (a stack gives what it has)
    function _loadMag(magIndex, ammoId, stackIndex) {
        const mag = _loadout.carried[magIndex];
        if (!mag) return;
        mag.ammoId = ammoId;
        if (stackIndex != null) _takeAmmo(stackIndex, _capacityOf(mag.id));
        _changed();
    }

    // Rounds onto a weapon: its magazine and chamber, or just the chamber without a magazine
    function _loadWeaponAmmo(key, ammoId, stackIndex) {
        const weapon = _loadout.weapons[key];
        if (!weapon) return;
        const mag = _weaponMagIn(weapon);
        weapon.ammoId = ammoId;
        if (stackIndex != null) _takeAmmo(stackIndex, (mag ? _capacityOf(mag) : 0) + 1);
        _changed();
    }

    // Ctrl+click on rounds in the list, one step a click: a weapon of their caliber with nothing
    // loaded (its magazine and chamber), then the empty magazines in the rig and pockets in
    // their grid order, then, with everything full, a whole stack
    async function _quickLoadAmmo(row) {
        try { await _carryCompat(); } catch (err) { console.warn('[arena-loadout] magazine fit:', err); }
        const caliber = row.caliber;
        const weaponKey = WEAPON_SLOTS.find(function (key) {
            const weapon = _loadout.weapons[key];
            const gun = weapon ? _item(weapon.gunId) : null;
            return !!(gun && gun.caliber === caliber && !weapon.ammoId);
        });
        if (weaponKey) {
            _loadout.weapons[weaponKey].ammoId = row.id;
            _changed();
            return;
        }
        const order = { rig: 0, pockets: 1 };
        const empty = _loadout.carried.map(function (c, index) { return { c: c, index: index }; })
            .filter(function (x) { return x.c.where && !x.c.ammoId && _capacityOf(x.c.id) > 0 && _magCaliber(x.c.id) === caliber; })
            .sort(function (a, b) {
                return order[a.c.where] - order[b.c.where] || a.c.grid - b.c.grid || a.c.y - b.c.y || a.c.x - b.c.x;
            });
        if (empty.length) {
            empty[0].c.ammoId = row.id;
            _changed();
            return;
        }
        _addCarried(row);
    }

    // Unload: the weapon's magazine, loaded as it was, goes into the rig (else the pockets)
    function _unloadWeapon(key) {
        const weapon = _loadout.weapons[key];
        const magIndex = weapon ? _magPairIndex(weapon) : -1;
        if (magIndex === -1) return;
        const magId = weapon.pairs[magIndex][1];
        const spot = _findSpot(_taken(-1), magId, ['rig', 'pockets']);
        if (!spot) {
            replaceToast('arena-room', _t('arena.loadout'), _t('arena.noRoom'));
            return;
        }
        weapon.pairs.splice(magIndex, 1);
        _loadout.carried.push(Object.assign({ id: magId, count: 1, ammoId: weapon.ammoId || null }, spot));
        _changed();
    }

    function _duplicate(index) {
        const c = _loadout.carried[index];
        const spot = _findSpot(_taken(-1), c.id, c.where === 'pockets' ? ['pockets', 'rig'] : ['rig', 'pockets']);
        if (!spot) {
            replaceToast('arena-room', _t('arena.loadout'), _t('arena.noRoom'));
            return;
        }
        _loadout.carried.push(Object.assign({}, c, spot));
        _changed();
    }

    // Ctrl+click: a carried item goes to the other container, where it fits
    function _quickMove(index) {
        const c = _loadout.carried[index];
        if (!c) return;
        const other = c.where === 'pockets' ? 'rig' : 'pockets';
        const spot = _findSpot(_taken(index), c.id, [other]);
        if (!spot) {
            replaceToast('arena-room', _t('arena.loadout'), _t('arena.noRoom'));
            return;
        }
        Object.assign(c, spot);
        _changed();
    }

    // A magazine dropped on the weapon it fits goes in; the one it replaces takes its place
    function _loadMagazine(index, key) {
        const c = _loadout.carried[index];
        const weapon = _loadout.weapons[key];
        const slotId = _compat && _compat.magSlots ? _compat.magSlots[key] : null;
        if (!c || !weapon || !_compat || _compat.mags[c.id] !== key) return false;
        const magIndex = _magPairIndex(weapon);
        const old = magIndex !== -1 ? weapon.pairs[magIndex] : null;
        const spot = { where: c.where, grid: c.grid, x: c.x, y: c.y, r: c.r };
        _loadout.carried.splice(index, 1);
        if (old) {
            weapon.pairs[magIndex] = [old[0], c.id];
            // The old magazine takes the new one's place, or the first free one
            const taken = _taken(-1);
            const size = _sizeOf(old[1]);
            const back = _free(taken, spot.where, spot.grid, spot.x, spot.y, size[0], size[1]) ? Object.assign({}, spot, { r: 0 })
                : _free(taken, spot.where, spot.grid, spot.x, spot.y, size[1], size[0]) ? Object.assign({}, spot, { r: 1 })
                    : _findSpot(taken, old[1], ['rig', 'pockets']);
            if (back) _loadout.carried.push(Object.assign({ id: old[1], count: 1, ammoId: weapon.ammoId || null }, back));
        } else if (slotId) {
            weapon.pairs.push([slotId, c.id]);
        } else {
            return false;
        }
        if (c.ammoId) weapon.ammoId = c.ammoId;
        _changed();
        return true;
    }

    /* ---- Drag and drop ---- */

    let _drag = null;          // {kind, index | row, w, h, r, x0, y0, started, ghost, over}
    let _swallowClick = false;

    function _pressItem(e, info) {
        if (e.button !== 0 || e.ctrlKey || e.altKey || e.metaKey) return;
        _drag = Object.assign({ x0: e.clientX, y0: e.clientY, started: false, r: 0 }, info);
        window.addEventListener('pointermove', _dragMove);
        window.addEventListener('pointerup', _dragEnd);
        window.addEventListener('keydown', _dragKey);
    }

    function _dragSize() {
        const size = _drag.size;
        return _drag.r ? [size[1], size[0]] : size;
    }

    // The item list, red while something worn or carried is dragged: a drop there discards it
    function _showDiscardZone() {
        const right = document.getElementById('arena-right');
        const panel = right ? /** @type {HTMLElement | null} */ (right.closest('.right-panel')) : null;
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        const zone = document.createElement('div');
        zone.className = 'arena-discard-zone';
        zone.style.left = rect.left + 'px';
        zone.style.top = rect.top + 'px';
        zone.style.width = rect.width + 'px';
        zone.style.height = rect.height + 'px';
        zone.innerHTML = '<div class="arena-discard-label"><img src="' + MENU_ART + 'discard.webp" alt="" draggable="false"><span>' +
            escapeHtml(_t('arena.dropDiscard')) + '</span></div>';
        document.body.appendChild(zone);
    }

    function _hideDiscardZone() {
        document.querySelectorAll('.arena-discard-zone').forEach(function (node) { node.remove(); });
    }

    // What a plate or helmet part slot holds, for swaps
    function _insertId(key) {
        const parts = key.split(':');
        const worn = _loadout.gear[parts[0]];
        return worn ? ((parts[1] === 'plate' ? worn.plates : worn.parts) || {})[parts[2]] || null : null;
    }

    function _beginDrag() {
        _drag.started = true;
        _closeMenu();
        if (!(_compat && _compat.key === _compatKey())) _carryCompat().catch(function () { /* checked again on drop */ });
        if (_drag.kind !== 'card') _showDiscardZone();
        const ghost = document.createElement('div');
        ghost.className = 'arena-ghost';
        const img = document.createElement('img');
        img.alt = '';
        img.src = _drag.picture;
        img.addEventListener('error', function () { if (_drag && _drag.fallback && img.src !== _drag.fallback) img.src = _drag.fallback; });
        ghost.appendChild(img);
        document.body.appendChild(ghost);
        _drag.ghost = ghost;
        _drag.img = img;
        _sizeGhost();
        document.body.classList.add('arena-dragging');
    }

    // The ghost is the item at the grids' size (a card's picture for gear and weapons)
    function _sizeGhost() {
        const d = _dragSize();
        const cell = CELL * CARRY_SCALE;
        const w = _drag.grid ? d[0] * cell : 110;
        const h = _drag.grid ? d[1] * cell : 70;
        _drag.ghost.style.width = w + 'px';
        _drag.ghost.style.height = h + 'px';
        const size = _drag.size;
        _drag.img.style.width = (_drag.grid ? size[0] * cell : w) + 'px';
        _drag.img.style.height = (_drag.grid ? size[1] * cell : h) + 'px';
        _drag.img.style.transform = _drag.grid && _drag.r ? 'rotate(90deg)' : '';
    }

    function _dragKey(e) {
        if (!_drag || !_drag.started || !_drag.grid) return;
        if (e.key === 'r' || e.key === 'R') {
            _drag.r = _drag.r ? 0 : 1;
            _sizeGhost();
            _dragOver(_drag.lastX, _drag.lastY);
        }
    }

    function _dragMove(e) {
        if (!_drag) return;
        if (!_drag.started) {
            if (Math.hypot(e.clientX - _drag.x0, e.clientY - _drag.y0) < DRAG_THRESHOLD) return;
            _beginDrag();
        }
        _drag.lastX = e.clientX;
        _drag.lastY = e.clientY;
        const rect = _drag.ghost.getBoundingClientRect();
        _drag.ghost.style.left = (e.clientX - rect.width / 2) + 'px';
        _drag.ghost.style.top = (e.clientY - rect.height / 2) + 'px';
        _dragOver(e.clientX, e.clientY);
    }

    function _clearOver() {
        document.querySelectorAll('.arena-drop-mark').forEach(function (node) { node.remove(); });
        document.querySelectorAll('.arena-drop-ok, .arena-drop-bad').forEach(function (node) { node.classList.remove('arena-drop-ok', 'arena-drop-bad'); });
    }

    // What's under the cursor and whether the dragged item can go there, marked green or red
    function _dragOver(x, y) {
        _clearOver();
        _drag.over = null;
        const under = document.elementFromPoint(x, y);
        if (!under) return;
        const zone = under.closest('.arena-discard-zone');
        if (zone) {
            zone.classList.add('arena-drop-ok');
            _drag.over = { type: 'discard' };
            return;
        }
        // Rounds onto a magazine in the rig or pockets load it
        const itemEl = /** @type {HTMLElement | null} */ (under.closest('.arena-citem'));
        const caliber = _dragAmmoCaliber();
        if (itemEl && caliber) {
            const index = Number(itemEl.dataset.index);
            const target = _loadout.carried[index];
            const isMag = target && _capacityOf(target.id) > 0 && !(_drag.kind === 'carried' && _drag.index === index);
            if (isMag) {
                const ok = _magCaliber(target.id) === caliber;
                itemEl.classList.add(ok ? 'arena-drop-ok' : 'arena-drop-bad');
                if (ok) _drag.over = { type: 'mag', index: index };
                return;
            }
        }
        const gridEl = /** @type {HTMLElement | null} */ (under.closest('.arena-cgrid'));
        if (gridEl && _drag.grid) {
            const where = gridEl.dataset.where;
            const grid = Number(gridEl.dataset.grid);
            const g = _gridsOf(where)[grid];
            if (!g) return;
            const rect = gridEl.getBoundingClientRect();
            const scale = rect.width / (g[0] * CELL + 1);
            const d = _dragSize();
            // The item hangs centered on the cursor; its top left cell is where it lands
            const cx = Math.round(((x - rect.left) / scale - d[0] * CELL / 2) / CELL);
            const cy = Math.round(((y - rect.top) / scale - d[1] * CELL / 2) / CELL);
            const ok = _free(_taken(_drag.kind === 'carried' ? _drag.index : -1), where, grid, cx, cy, d[0], d[1]);
            const mark = document.createElement('div');
            mark.className = 'arena-drop-mark ' + (ok ? 'is-ok' : 'is-bad');
            mark.style.left = (Math.max(0, cx) * CELL) + 'px';
            mark.style.top = (Math.max(0, cy) * CELL) + 'px';
            mark.style.width = (Math.min(d[0], g[0]) * CELL + 1) + 'px';
            mark.style.height = (Math.min(d[1], g[1]) * CELL + 1) + 'px';
            gridEl.appendChild(mark);
            if (ok) _drag.over = { type: 'cell', spot: { where: where, grid: grid, x: cx, y: cy, r: _drag.r } };
            return;
        }
        const area = /** @type {HTMLElement | null} */ (under.closest('.arena-carry-area'));
        if (area && _drag.grid) {
            const where = area.dataset.where;
            const spot = _findSpot(_taken(_drag.kind === 'carried' ? _drag.index : -1), _drag.id, [where]);
            area.classList.add(spot ? 'arena-drop-ok' : 'arena-drop-bad');
            if (spot) _drag.over = { type: 'cell', spot: spot };
            return;
        }
        const tile = /** @type {HTMLElement | null} */ (under.closest('[data-arena-key]'));
        if (tile) {
            const key = tile.dataset.arenaKey;
            const ok = _dropsOnSlot(key);
            tile.classList.add(ok ? 'arena-drop-ok' : 'arena-drop-bad');
            if (ok) _drag.over = { type: 'slot', key: key };
        }
    }

    // The caliber of the rounds being dragged (a stack in the rig or an ammo card), or null
    function _dragAmmoCaliber() {
        if (!_drag) return null;
        const id = _drag.kind === 'carried' ? (_loadout.carried[_drag.index] || {}).id : _drag.kind === 'card' ? _drag.row.id : null;
        const gear = id && _data ? _data.gear[id] : null;
        return gear && gear.carry_kind === 'ammo' ? gear.caliber : null;
    }

    // Whether the dragged item goes in board slot `key`
    function _dropsOnSlot(key) {
        // Rounds onto a weapon of their caliber load it
        const caliber = _dragAmmoCaliber();
        if (caliber) {
            const weapon = _loadout.weapons[key];
            const gun = weapon ? _item(weapon.gunId) : null;
            return !!gun && gun.caliber === caliber;
        }
        if (_drag.kind === 'slot') {
            const from = _drag.key;
            if (from === key) return false;
            if (WEAPON_SLOTS.indexOf(from) !== -1 && WEAPON_SLOTS.indexOf(key) !== -1) {
                // Both guns have to fit where they land: no long gun in the holster
                const a = _loadout.weapons[from];
                const b = _loadout.weapons[key];
                const fits = function (w, slot) { const gun = w && _data.guns[w.gunId]; return !!gun && gun.gear_slot === SLOT_KIND[slot]; };
                return fits(a, key) && (!b || fits(b, from));
            }
            const fp = from.split(':');
            const tp = key.split(':');
            if (fp.length === 3 && tp.length === 3 && fp[1] === tp[1]) {
                const id = _insertId(from);
                const other = _insertId(key);
                return !!id && _insertAllowed(key).indexOf(id) !== -1 && (!other || _insertAllowed(from).indexOf(other) !== -1);
            }
            return false;
        }
        if (_drag.kind === 'carried') {
            // A magazine onto the weapon it fits
            const c = _loadout.carried[_drag.index];
            return !!(c && _compat && _compat.mags[c.id] === key && _loadout.weapons[key]);
        }
        const row = _drag.row;
        if (!row || !EFTForge.arena.allowedForClass(row)) return false;
        const parts = key.split(':');
        if (parts.length === 3) return _insertAllowed(key).indexOf(row.id) !== -1;
        if (WEAPON_SLOTS.indexOf(key) !== -1) return !!_data.guns[row.id] && row.gear_slot === SLOT_KIND[key];
        if (row.gear_slot !== key) return false;
        return key === 'Scabbard' || !_gearConflict(row.id, key);
    }

    function _dragEnd() {
        window.removeEventListener('pointermove', _dragMove);
        window.removeEventListener('pointerup', _dragEnd);
        window.removeEventListener('keydown', _dragKey);
        const drag = _drag;
        _drag = null;
        if (!drag || !drag.started) return;
        // The click that ends a drag isn't a click on what's under it
        _swallowClick = true;
        setTimeout(function () { _swallowClick = false; }, 0);
        _clearOver();
        _hideDiscardZone();
        drag.ghost.remove();
        document.body.classList.remove('arena-dragging');
        const over = drag.over;
        if (!over) return;
        if (over.type === 'mag' || (over.type === 'slot' && _dragAmmoCaliberOf(drag))) {
            const ammoId = drag.kind === 'carried' ? _loadout.carried[drag.index].id : drag.row.id;
            const stack = drag.kind === 'carried' ? drag.index : null;
            if (over.type === 'mag') _loadMag(over.index, ammoId, stack);
            else _loadWeaponAmmo(over.key, ammoId, stack);
            return;
        }
        if (over.type === 'discard') {
            if (drag.kind === 'carried') {
                _loadout.carried.splice(drag.index, 1);
                if (_pick.target && _pick.target.kind === 'load') _pick.target = null;
                _changed();
            } else if (drag.kind === 'slot') {
                _clearSlot(drag.key);
            }
            return;
        }
        if (drag.kind === 'slot') {
            const from = drag.key;
            const key = over.key;
            if (WEAPON_SLOTS.indexOf(from) !== -1) {
                const moving = _loadout.weapons[from];
                const staying = _loadout.weapons[key];
                _loadout.weapons[key] = moving;
                if (staying) _loadout.weapons[from] = staying;
                else delete _loadout.weapons[from];
            } else {
                const fp = from.split(':');
                const tp = key.split(':');
                const store = fp[1] === 'plate' ? 'plates' : 'parts';
                const a = _loadout.gear[fp[0]];
                const b = _loadout.gear[tp[0]];
                const moving = _insertId(from);
                const staying = _insertId(key);
                b[store] = b[store] || {};
                b[store][tp[2]] = moving;
                if (staying) a[store][fp[2]] = staying;
                else delete a[store][fp[2]];
            }
            _pick.target = { kind: 'slot', key: key };
            _changed();
            return;
        }
        if (drag.kind === 'carried') {
            const c = _loadout.carried[drag.index];
            if (!c) return;
            if (over.type === 'cell') {
                Object.assign(c, over.spot);
                _changed();
            } else if (over.type === 'slot') {
                _loadMagazine(drag.index, over.key);
            }
            return;
        }
        const row = drag.row;
        if (over.type === 'cell') {
            _addCarried(row, over.spot);
            return;
        }
        const key = over.key;
        const parts = key.split(':');
        if (parts.length === 3) {
            const worn = _loadout.gear[parts[0]];
            const store = parts[1] === 'plate' ? 'plates' : 'parts';
            if (!worn) return;
            worn[store] = worn[store] || {};
            worn[store][parts[2]] = row.id;
            _changed();
        } else if (WEAPON_SLOTS.indexOf(key) !== -1) {
            _pickWeapon(key, row);
        } else {
            _pickGear(key, row);
        }
    }

    function _dragAmmoCaliberOf(drag) {
        const saved = _drag;
        _drag = drag;
        const caliber = _dragAmmoCaliber();
        _drag = saved;
        return caliber;
    }

    // Swallow the click a finished drag ends with, before anything under it sees it
    document.addEventListener('click', function (e) {
        if (!_swallowClick) return;
        _swallowClick = false;
        e.stopPropagation();
        e.preventDefault();
    }, true);

    /* ===========================
       RENDER: RIGHT (the game's item list)
    =========================== */

    function _renderRight() {
        const right = document.getElementById('arena-right');
        if (!right) return;
        // The shop draws its own (arena-shop.js)
        if (!_active || !_data || _view === 'shop') {
            right.innerHTML = '';
            return;
        }
        // Magazines and ammo follow the loadout's weapons, which may take a request to learn
        if ((_pick.tab === 'mags' || _pick.tab === 'ammo') && !(_compat && _compat.key === _compatKey())) {
            right.innerHTML = _tabsHtml() + '<div class="arena-loading"><span class="atlas-lookup-throbber"></span></div>';
            _wireTabs(right);
            _carryCompat().then(function () { if (_active) _renderRight(); })
                .catch(function (err) {
                    console.warn('[arena-loadout] magazine fit:', err);
                    _compat = { key: _compatKey(), mags: {}, calibers: new Set(), failed: true };
                    if (_active) _renderRight();
                });
            return;
        }
        const list = _listFor();
        const query = _pick.search.trim().toLowerCase();
        const rows = list.rows.filter(function (r) {
            return !query || String(r.name || '').toLowerCase().indexOf(query) !== -1 || String(r.short_name || '').toLowerCase().indexOf(query) !== -1;
        }).sort(function (a, b) {
            const am = list.weapons ? _gunMeta(a) : (a.meta_points || 0);
            const bm = list.weapons ? _gunMeta(b) : (b.meta_points || 0);
            return bm - am || String(a.name).localeCompare(String(b.name));
        });
        const arena = EFTForge.arena;
        const filterButton = function (f) {
            const active = list.filter === f.key;
            return '<button type="button" class="arena-wtype' + (active ? ' active' : '') + (f.cls ? ' ' + f.cls : '') + '" data-filter="' + escapeHtml(f.key) + '" aria-pressed="' + active + '" ' +
                'data-tooltip="' + escapeHtml(f.label) + '" aria-label="' + escapeHtml(f.label) + '">' +
                '<img src="' + f.art + '" alt="" draggable="false">' +
                (f.cls && f.cls.indexOf('is-armored') !== -1 ? '<span class="arena-wtype-plus" aria-hidden="true">+</span>' : '') + '</button>';
        };
        const conflicts = rows.map(function (row) { return list.conflictOf && row.id !== list.current ? list.conflictOf(row) : null; });
        const cards = rows.map(function (row, index) {
            return list.weapons ? _weaponCard(row, index, list.current) : _itemCard(row, index, list.current, conflicts[index]);
        }).join('');
        const weapon = list.slot && WEAPON_SLOTS.indexOf(list.slot) !== -1 ? _loadout.weapons[list.slot] : null;
        right.innerHTML = _tabsHtml() +
            '<div class="att-table-header arena-pick-head"><h3>' + (list.slot && list.slot !== 'load' ? escapeHtml(_t('arena.selectFor')) + '<strong>' + escapeHtml(list.title) + '</strong>' : '<strong>' + escapeHtml(list.title) + '</strong>') + '</h3>' +
            (weapon ? '<button type="button" class="back-button arena-edit-weapon" id="arena-edit-weapon">' + escapeHtml(_t('arena.editInBuilder')) + '</button>' : '') + '</div>' +
            '<div class="arena-wpick">' +
            '<div class="arena-wtypes" role="group">' + list.filters.map(filterButton).join('') + '</div>' +
            '<div class="arena-wpick-main">' +
            '<input type="text" id="arena-picker-search" class="search-input" placeholder="' + escapeHtml(_t('arena.searchPlaceholder')) + '" value="' + escapeHtml(_pick.search) + '">' +
            (rows.length ? '<div class="' + (list.weapons ? 'arena-wgrid' : 'arena-igrid') + '">' + cards + '</div>' : '<div class="ammo-no-results">' + escapeHtml(list.empty) + '</div>') +
            '</div></div>';

        _wireTabs(right);
        right.querySelector('#arena-edit-weapon')?.addEventListener('click', function () { _editWeapon(list.slot); });
        right.querySelectorAll('[data-filter]').forEach(function (node) {
            node.addEventListener('click', function () {
                const key = /** @type {HTMLElement} */ (node).dataset.filter;
                if (key === list.filter) return;
                if (_pick.tab === 'equipment') {
                    // The equipment column picks the slot the list fills
                    if (key === 'plate' || key === 'attachment') return;
                    // "Eyewear:armored" and the like narrow the slot's list; a slot clears that
                    const parts = key.split(':');
                    _pick.equipSub = parts[1] ? { slot: parts[0], sub: parts[1] } : null;
                    _pick.filters.equipment = parts[0];
                    _pick.target = { kind: 'slot', key: parts[0] };
                    _renderBoard();
                } else if (_pick.tab === 'weapons') {
                    // The knife filter fills the melee slot; a gun type leaves it
                    _pick.filters.weapons = key;
                    if (key === MELEE) _pick.target = { kind: 'slot', key: 'Scabbard' };
                    else if (_targetKey() === 'Scabbard') _pick.target = null;
                    _renderBoard();
                } else {
                    _pick.filters[_pick.tab] = key;
                }
                _renderRight();
            });
        });
        const search = /** @type {HTMLInputElement | null} */ (right.querySelector('#arena-picker-search'));
        if (search) {
            search.addEventListener('input', function () {
                _pick.search = search.value;
                const caret = search.selectionStart;
                _renderRight();
                const again = /** @type {HTMLInputElement | null} */ (document.getElementById('arena-picker-search'));
                if (again) { again.focus(); again.setSelectionRange(caret, caret); }
            });
        }
        right.querySelectorAll('[data-pick]').forEach(function (node) {
            const card = /** @type {HTMLElement} */ (node);
            const row = rows[Number(card.dataset.pick)];
            card.addEventListener('pointerdown', function (e) {
                if (!row || conflicts[Number(card.dataset.pick)] || (list.slot === 'load')) return;
                const carry = !!row.carry_kind;
                _pressItem(e, {
                    kind: 'card', row: row, id: row.id, size: carry ? _sizeOf(row.id) : [1, 1], grid: carry,
                    picture: carry ? _gridImage(row.id) : (row.image_512_link || row.image_link || row.icon_link || ''),
                    fallback: row.icon_link || '',
                });
            });
            card.addEventListener('click', function (e) {
                if (!row || !arena.allowedForClass(row) || (row.id === list.current && !list.repeatable)) return;
                // Ctrl+click on rounds loads what's empty first, a stack once everything's full
                if ((e.ctrlKey || e.metaKey) && row.carry_kind === 'ammo' && list.slot !== 'load') {
                    _quickLoadAmmo(row);
                    return;
                }
                const conflict = conflicts[Number(card.dataset.pick)];
                if (conflict) {
                    // The game won't wear the two together: say what's in the way and show where
                    replaceToast('arena-conflict', _t('arena.conflictTitle'), (row.name || '') + '\n' + _conflictText(conflict));
                    _flashSlot(conflict.slot);
                    return;
                }
                list.onPick(row);
            });
        });
    }

    function _tabsHtml() {
        return '<div class="arena-cats" role="tablist">' + TABS.map(function (tab) {
            const active = _pick.tab === tab;
            return '<button type="button" class="arena-cat' + (active ? ' active' : '') + '" data-cat="' + tab + '" role="tab" aria-selected="' + active + '" ' +
                'data-tooltip="' + escapeHtml(_t('arena.tab.' + tab)) + '" aria-label="' + escapeHtml(_t('arena.tab.' + tab)) + '">' +
                '<img src="' + TAB_ART[tab] + '" alt="" draggable="false"></button>';
        }).join('') + '</div>';
    }

    function _wireTabs(root) {
        root.querySelectorAll('[data-cat]').forEach(function (node) {
            node.addEventListener('click', function () {
                const tab = /** @type {HTMLElement} */ (node).dataset.cat;
                if (tab === _pick.tab) return;
                _pick.tab = tab;
                _pick.search = '';
                // Keep the rig or pockets selected while staying on what they hold
                const t = _pick.target;
                const keep = t && ((t.kind === 'container' && CARRY_TABS.indexOf(tab) !== -1) ||
                    (t.kind === 'slot' && tab === 'weapons' && (WEAPON_SLOTS.indexOf(t.key) !== -1 || t.key === 'Scabbard')));
                if (!keep) _pick.target = null;
                if (tab === 'equipment') _pick.target = { kind: 'slot', key: _pick.filters.equipment || EQUIP_FILTERS[0] };
                _renderBoard();
                _renderCarry();
                _renderRight();
            });
        });
    }

    // What the open tab lists, its filter column, and what picking a card does
    function _listFor() {
        const arena = EFTForge.arena;
        const t = _pick.target;
        const slotKey = t && t.kind === 'slot' ? t.key : null;
        if (_pick.tab === 'weapons') {
            const meleeButton = { key: MELEE, art: GEAR_ART + 'Scabbard.webp', label: _slotLabel('Scabbard') };
            if (slotKey === 'Scabbard' || _pick.filters.weapons === MELEE) {
                // The knife: what the melee slot takes, under the gun types' filters
                const current = _loadout.gear.Scabbard ? _loadout.gear.Scabbard.id : null;
                const guns = Object.values(_data.guns).filter(function (g) { return arena.allowedForClass(g); });
                const types = WEAPON_TYPES.filter(function (type) { return guns.some(function (g) { return _typeOf(g) === type.key; }); });
                _pick.filters.weapons = MELEE;
                return {
                    slot: 'Scabbard', current: current, filter: MELEE, title: _slotLabel('Scabbard'),
                    filters: types.map(function (type) { return { key: type.key, art: TYPE_ART + type.key + '.webp', label: _typeLabel(type.key) }; }).concat([meleeButton]),
                    rows: Object.values(_data.gear).filter(function (i) { return i.gear_slot === 'Scabbard' && (i.id === current || arena.allowedForClass(i)); }),
                    empty: _t('ammo.noResults'),
                    onPick: function (row) { _pickGear('Scabbard', row); },
                };
            }
            const slot = slotKey && WEAPON_SLOTS.indexOf(slotKey) !== -1 ? slotKey : null;
            const current = slot && _loadout.weapons[slot] ? _loadout.weapons[slot].gunId : null;
            let guns = Object.values(_data.guns).filter(function (g) { return g.id === current || arena.allowedForClass(g); });
            if (slot) guns = guns.filter(function (g) { return g.gear_slot === SLOT_KIND[slot]; });
            const present = WEAPON_TYPES.filter(function (type) { return guns.some(function (g) { return _typeOf(g) === type.key; }); });
            let filter = _pick.filters.weapons;
            if (!present.some(function (type) { return type.key === filter; })) filter = present[0] ? present[0].key : null;
            _pick.filters.weapons = filter;
            return {
                weapons: true, slot: slot, current: current, filter: filter,
                title: slot ? _slotLabel(slot) : _t('arena.tab.weapons'),
                filters: present.map(function (type) { return { key: type.key, art: TYPE_ART + type.key + '.webp', label: _typeLabel(type.key) }; }).concat([meleeButton]),
                rows: guns.filter(function (g) { return _typeOf(g) === filter; }),
                empty: _t('arena.noWeapons'),
                onPick: function (gun) { _pickWeapon(slot || _autoWeaponSlot(gun), gun); },
            };
        }
        if (_pick.tab === 'equipment') {
            const gearFilters = EQUIP_FILTERS.map(function (key) { return { key: key, art: GEAR_ART + key + '.webp', label: _slotLabel(key) }; });
            if (slotKey && slotKey.split(':').length === 3) {
                // A plate or helmet part: what that insert slot takes, its category shown last
                const parts = slotKey.split(':');
                const kind = parts[1] === 'plate' ? 'plate' : 'attachment';
                const worn = _loadout.gear[parts[0]];
                const store = kind === 'plate' ? 'plates' : 'parts';
                const current = worn ? (worn[store] || {})[parts[2]] || null : null;
                return {
                    slot: slotKey, current: current, filter: kind, title: _slotLabel(kind),
                    filters: gearFilters.concat([{ key: kind, art: GEAR_ART + kind + '.webp', label: _slotLabel(kind) }]),
                    rows: _insertAllowed(slotKey).map(function (id) { return _data.armor[id] ? _withPoints(_data.armor[id]) : null; })
                        .filter(function (r) { return r && (r.id === current || arena.allowedForClass(r)); }),
                    // A helmet part counts as part of the helmet
                    conflictOf: kind === 'attachment' ? function (row) { return _gearConflict(row.id, 'Headwear'); } : null,
                    empty: _t('ammo.noResults'),
                    onPick: function (row) {
                        if (!worn) return;
                        worn[store] = worn[store] || {};
                        worn[store][parts[2]] = row.id;
                        _changed();
                    },
                };
            }
            const key = EQUIP_FILTERS.indexOf(slotKey) !== -1 ? slotKey : (_pick.filters.equipment || EQUIP_FILTERS[0]);
            _pick.filters.equipment = key;
            const current = _loadout.gear[key] ? _loadout.gear[key].id : null;
            // The open filter shows its armored and plain ones under it; one of them narrows the list
            const sub = _pick.equipSub && _pick.equipSub.slot === key ? _pick.equipSub.sub : null;
            const filters = [];
            gearFilters.forEach(function (f) {
                // A filter that opens shows a corner mark, as the game's do
                const opens = EQUIP_SPLITS.indexOf(f.key) !== -1;
                const split = opens && f.key === key;
                filters.push(Object.assign({}, f, opens ? { cls: 'is-expandable' + (split ? ' is-open' : '') } : {}));
                if (!split) return;
                filters.push({ key: key + ':armored', art: f.art, label: _t('arena.sub.' + key + '.armored'), cls: 'is-sub is-armored' });
                filters.push({ key: key + ':plain', art: f.art, label: _t('arena.sub.' + key + '.plain'), cls: 'is-sub is-plain' });
            });
            return {
                slot: key, current: current, filter: sub ? key + ':' + sub : key, title: _slotLabel(key), filters: filters,
                rows: Object.values(_data.gear).filter(function (i) {
                    if (i.gear_slot !== key || !(i.id === current || arena.allowedForClass(i))) return false;
                    return !sub || (sub === 'armored') === !!_data.armor[i.id];
                }).map(function (i) { return _data.armor[i.id] ? Object.assign({}, i, { pieces: _data.armor[i.id].pieces }) : i; }),
                conflictOf: function (row) { return _gearConflict(row.id, key); },
                empty: _t('ammo.noResults'),
                onPick: function (row) { _pickGear(key, row); },
            };
        }
        const carryBase = function (kind) {
            return Object.values(_data.gear).filter(function (i) { return i.carry_kind === kind && arena.allowedForClass(i); });
        };
        const compat = _compat && !_compat.failed ? _compat : null;
        if (_pick.tab === 'meds') {
            let filter = _pick.filters.meds;
            if (!MED_FILTERS.some(function (f) { return f.key === filter; })) filter = MED_FILTERS[0].key;
            _pick.filters.meds = filter;
            const cat = MED_FILTERS.find(function (f) { return f.key === filter; }).cat;
            return {
                current: null, filter: filter, repeatable: true, title: _t('arena.tab.meds'),
                filters: MED_FILTERS.map(function (f) { return { key: f.key, art: MED_ART + f.key + '.webp', label: _t('arena.med.' + f.key) }; }),
                rows: carryBase('medical').filter(function (i) { return i.category_id === cat; }),
                empty: _t('ammo.noResults'),
                onPick: _addCarried,
            };
        }
        if (_pick.tab === 'mags') {
            return {
                current: null, filter: 'magazine', repeatable: true, title: _t('arena.tab.mags'),
                filters: [{ key: 'magazine', art: CARRY_ART + 'magazine.webp', label: _t('arena.tab.mags') }],
                rows: carryBase('magazine').filter(function (i) { return !compat || !!compat.mags[i.id]; }),
                empty: _t('arena.noCarried'),
                onPick: _addCarried,
            };
        }
        // Ammo: the loadout's calibers, or just the one a magazine being loaded takes
        let calibers = compat ? compat.calibers : null;
        let loading = null;
        if (t && t.kind === 'load') {
            loading = _loadout.carried[t.index] || null;
            const owner = loading && compat && compat.mags[loading.id] ? _loadout.weapons[compat.mags[loading.id]] : null;
            const gun = owner ? _item(owner.gunId) : null;
            if (gun && gun.caliber) calibers = new Set([gun.caliber]);
        }
        return {
            current: loading ? loading.ammoId || null : null, filter: 'ammo', repeatable: !loading,
            slot: loading ? 'load' : null,
            title: loading ? tFmt('arena.loadMag', { name: (_item(loading.id) || {}).short_name || '' }) : _t('arena.tab.ammo'),
            filters: [{ key: 'ammo', art: CARRY_ART + 'ammo.webp', label: _t('arena.tab.ammo') }],
            rows: carryBase('ammo').filter(function (i) { return !calibers || calibers.has(i.caliber); }),
            empty: _t('arena.noCarried'),
            onPick: function (row) {
                if (loading) {
                    loading.ammoId = row.id;
                    _changed();
                } else {
                    _addCarried(row);
                }
            },
        };
    }

    // What a card says under its name, the way the game's cards do
    function _cardLines(row) {
        const lines = [];
        const pieces = row.pieces || ((_data.armor[row.id] || {}).pieces);
        if (row.carry_kind === 'magazine') {
            if (row.magazine_capacity) lines.push(String(row.magazine_capacity) + ' ' + _t('arena.rounds'));
        } else if (row.carry_kind === 'ammo' || (row.caliber && !row.is_weapon && row.damage != null)) {
            lines.push(_caliberLabel(row));
            if (row.damage != null) lines.push(row.damage + ' / ' + (row.penetration_power != null ? row.penetration_power : '-'));
        } else if (pieces && pieces.length) {
            const cls = Math.max.apply(null, pieces.map(function (x) { return x.armor_class || 0; }));
            if (cls > 0) lines.push(tFmt('arena.armorClass', { n: cls }));
        } else if (row.grids && row.grids.length) {
            lines.push(tFmt('arena.cellsCount', { n: row.grids.reduce(function (sum, g) { return sum + g[0] * g[1]; }, 0) }));
        }
        return lines;
    }

    function _itemCard(row, index, current, conflict) {
        const locked = !EFTForge.arena.allowedForClass(row);
        const picture = row.image_link || row.icon_link || '';
        const tip = locked ? _t('arena.lockedClass') : conflict ? (row.name || '') + ': ' + _conflictText(conflict) : (row.name || '');
        return '<button type="button" class="arena-icard' + (row.id === current ? ' is-current' : '') + (locked ? ' is-locked' : '') + (conflict ? ' is-conflict' : '') + '" data-pick="' + index + '"' +
            ' data-tooltip="' + escapeHtml(tip) + '">' +
            '<span class="arena-wcard-mp arena-meta">' + escapeHtml(EFTForge.arena.formatMeta(row.meta_points || 0)) + '</span>' +
            '<span class="arena-wcard-head"><span class="slot-shortname">' + shortNameHtml(row.short_name || row.name || '') + '</span>' +
            _cardLines(row).map(function (l) { return '<span class="arena-wcard-cal">' + escapeHtml(l) + '</span>'; }).join('') + '</span>' +
            (picture ? '<img class="arena-icard-img" src="' + escapeHtml(picture) + '" alt="" loading="lazy" decoding="async" draggable="false" onerror="this.style.visibility=\'hidden\'">' : '') +
            (locked ? '<span class="arena-icard-lock" aria-hidden="true">&#x1F512;</span>' : '') +
            '</button>';
    }

    function _weaponCard(gun, index, current) {
        const locked = !EFTForge.arena.allowedForClass(gun);
        return '<button type="button" class="arena-wcard' + (gun.id === current ? ' is-current' : '') + (locked ? ' is-locked' : '') + '" data-pick="' + index + '"' +
            (locked ? ' data-tooltip="' + escapeHtml(_t('arena.lockedClass')) + '"' : '') + '>' +
            '<span class="arena-wcard-mp arena-meta">' + escapeHtml(EFTForge.arena.formatMeta(_gunMeta(gun))) + '</span>' +
            '<span class="arena-wcard-head"><span class="slot-shortname">' + shortNameHtml(gun.short_name || gun.name || '') + '</span>' +
            '<span class="arena-wcard-cal">' + escapeHtml(_caliberLabel(gun)) + '</span></span>' +
            '<img class="arena-wcard-img" src="' + escapeHtml(gun.image_512_link || gun.icon_link || '') + '" alt="" loading="lazy" decoding="async" draggable="false" onerror="this.style.visibility=\'hidden\'">' +
            '</button>';
    }

    function _typeOf(gun) {
        const type = WEAPON_TYPES.find(function (t) { return t.cats.indexOf(gun.weapon_category) !== -1; });
        return type ? type.key : null;
    }

    function _typeLabel(key) {
        const type = WEAPON_TYPES.find(function (t) { return t.key === key; });
        return type && typeof tClass === 'function' ? tClass(type.cats[0]) : key;
    }

    function _caliberLabel(gun) {
        const map = (EFTForge.config && EFTForge.config.CALIBER_DISPLAY_MAP) || {};
        return map[gun.caliber] || String(gun.caliber || '').replace(/^Caliber/, '');
    }

    // A weapon card's meta points: its default preset, as the game's list shows them
    function _gunMeta(gun) {
        return typeof gun.preset_meta_points === 'number' ? gun.preset_meta_points : (gun.meta_points || 0);
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
            if (_view === 'shop') {
                EFTForge.arenaShop.reset();
                render();
                return;
            }
            const cls = EFTForge.arena.classId();
            if (cls) _store.byClass[cls] = _empty();
            _bind();
            _pick = _freshPick();
            _changed();
        });
        _updateStaticText();
        document.addEventListener('arena-class-change', function () {
            _bind();
            if (_active && _view === 'loadout') render();
        });
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
    }

    function onLangChange() {
        _updateStaticText();
        // Names come from the server in the page's language: every cached item is in the old one
        Object.keys(_points).forEach(function (id) { delete _points[id]; });
        _data = null;
        _dataPromise = null;
        if (_active) {
            open(_view === 'shop' ? BLAST_GANG : undefined);
        } else {
            // The class names come back in the new language (arena.js onLangChange)
            renderLanding();
        }
    }

    function _t(key) { return (EFTForge.lang && EFTForge.lang.t) ? EFTForge.lang.t(key) : key; }

    _load();

    return {
        BLAST_GANG: BLAST_GANG,
        open: open,
        leave: leave,
        renderLanding: renderLanding,
        resumeTarget: resumeTarget,
        wireClassTabs: wireClassTabs,
        isActive: isActive,
        editingSlot: editingSlot,
        saveEditedWeapon: saveEditedWeapon,
        syncEditedWeapon: syncEditedWeapon,
        weaponDrawing: _weaponDrawing,
        totals: totals,
        problems: problems,
        render: render,
        onLangChange: onLangChange,
    };

}());
