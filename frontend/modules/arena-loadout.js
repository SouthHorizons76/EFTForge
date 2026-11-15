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

   On desktop each loadout is a tab of the tab bar (tab-manager.js, kind "arena"): a class
   card opens a new one the way picking a gun opens a build tab, and the tab keeps the
   loadout. On mobile, which has no tabs, each class keeps one loadout in localStorage.
   Arena's own data comes from /arena/config, /arena/items, /armor/items and /guns, all
   with ?game=arena.
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
    // What resumeTarget() hands open() to go back to a tab: this and the tab's id
    const TAB_PREFIX = 'tab:';
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
    // BlastGang's board (shopBoard): the game's Shop settings screen puts the gear in two
    // columns with the character between them, the cap (never a helmet: the shop sells those),
    // earpiece, face cover and pistol on the left; the eyewear, body armor, rig and melee
    // weapon on the right
    const SHOP_ROW = [78, 225, 372, 519];
    const SHOP_LAYOUT = [
        { slot: 'Headwear', x: COL[0], y: SHOP_ROW[0] },
        { slot: 'Earpiece', x: COL[0], y: SHOP_ROW[1] },
        { slot: 'FaceCover', x: COL[0], y: SHOP_ROW[2] },
        { slot: 'Holster', x: COL[0], y: SHOP_ROW[3] },
        { slot: 'Eyewear', x: COL[2], y: SHOP_ROW[0] },
        { slot: 'ArmorVest', x: COL[2], y: SHOP_ROW[1] },
        { slot: 'TacticalVest', x: COL[2], y: SHOP_ROW[2] },
        { slot: 'Scabbard', x: COL[2], y: SHOP_ROW[3] },
    ];
    const SHOP_FRAME = { x: BOARD_X, y: BOARD_Y, w: BOARD_W, h: SHOP_ROW[3] + SLOT - BOARD_Y };
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
    let _editing = null;       // {cls, key, tabId}: the weapon slot whose build is open in the builder
    let _resetArmed = false;
    let _tabId = null;         // desktop: the tab whose loadout is on show, which every change saves to

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

    /** Whether loadouts live in the tab bar's tabs (desktop) rather than one per class. */
    function _tabsOn() {
        return !!(EFTForge.tabs && EFTForge.tabs.openArenaTab) && document.body.dataset.mobile !== 'true';
    }

    // Point _loadout at the selected class's loadout. A tab brings its own on desktop.
    function _bind() {
        if (_tabsOn()) return;
        const cls = EFTForge.arena && EFTForge.arena.classId();
        if (!cls) {
            _loadout = _empty();
            return;
        }
        if (!_store.byClass[cls]) _store.byClass[cls] = _empty();
        _loadout = _store.byClass[cls];
    }

    function _save() {
        if (_tabsOn()) {
            if (_tabId) EFTForge.tabs.saveArenaTab(_tabId, _loadout);
            return;
        }
        try { localStorage.setItem(STORE_KEY, JSON.stringify(_store)); } catch { /* private mode or full */ }
    }

    /** The loadouts kept per class from before tabs, to open as the first tabs: [{classId, loadout}]. */
    function legacyLoadouts() {
        return Object.keys(_store.byClass).map(function (id) { return { classId: id, loadout: _store.byClass[id] }; })
            .filter(function (entry) { return !isEmptyLoadout(entry.loadout); });
    }

    function isEmptyLoadout(loadout) {
        const l = _clean(loadout);
        return !Object.keys(l.weapons).some(function (k) { return l.weapons[k]; }) &&
            !Object.keys(l.gear).some(function (k) { return l.gear[k]; }) && l.carried.length === 0;
    }

    // JSON with every object's keys sorted, so two equal loadouts always give the same string
    function _stable(value) {
        if (Array.isArray(value)) return '[' + value.map(_stable).join(',') + ']';
        if (value && typeof value === 'object') {
            return '{' + Object.keys(value).sort().filter(function (k) { return value[k] !== undefined && value[k] !== null; })
                .map(function (k) { return JSON.stringify(k) + ':' + _stable(value[k]); }).join(',') + '}';
        }
        return JSON.stringify(value === undefined ? null : value);
    }

    /** A string that's equal for equal loadouts, for spotting a loadout that's already open. */
    function loadoutKey(loadout) {
        return _stable(_clean(loadout));
    }

    /** A deep copy of `loadout` in the shape a loadout has. */
    function copyLoadout(loadout) {
        return _clean(JSON.parse(JSON.stringify(loadout || null)));
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
        // Back from a weapon opened in the builder: the tab it came from
        if (typeof target === 'string' && target.indexOf(TAB_PREFIX) === 0) {
            await EFTForge.tabs.switchToTab(target.slice(TAB_PREFIX.length));
            return;
        }
        // On desktop BlastGang's card reopens the user's own shop, in its one tab
        if (_tabsOn() && target === BLAST_GANG) {
            await EFTForge.tabs.openShopTab();
            return;
        }
        // On desktop a class opens in a tab, like a gun does
        if (_tabsOn()) {
            const cls = target || EFTForge.arena.classId();
            if (cls) await EFTForge.tabs.openArenaTab(cls);
            return;
        }
        await _show(target, false);
    }

    /**
     * Show tab `tabId`'s loadout. tab-manager.js calls this when an Arena tab is switched to,
     * and marks the tab active once it's started.
     * @param {string} tabId
     * @param {{ classId: string, loadout: any }} tab
     */
    async function enterTab(tabId, tab) {
        if (!EFTForge.arena || !EFTForge.arena.isActive()) return;
        _leaveBuilder();
        _tabId = tabId;
        _loadout = _clean(tab.loadout);
        // A shop tab: the user's own shop, or the community shop it holds
        if (tab.classId === BLAST_GANG && EFTForge.arenaShop) EFTForge.arenaShop.useStore(tabId, !!(/** @type {any} */ (tab).own));
        await _show(tab.classId, true);
    }

    // Close a build open in the builder without coming back here, as the back button does
    function _leaveBuilder() {
        // Nothing is being edited any more, so leaving the builder doesn't come back here
        _editing = null;
        EFTForge.arenaShop && EFTForge.arenaShop.clearEditing();
        if (EFTForge.state.currentGun) returnToGunSelection();
    }

    /**
     * Mobile, which has no tabs: a community preset becomes its class's loadout, which opens.
     * @param {string} classId
     * @param {any} loadout
     */
    function replaceLoadout(classId, loadout) {
        if (_tabsOn() || !classId) return;
        _load();
        _store.byClass[classId] = copyLoadout(loadout);
        try { localStorage.setItem(STORE_KEY, JSON.stringify(_store)); } catch { /* private mode or full */ }
        _show(classId, false);
    }

    /** The tab whose loadout is on show, or null. */
    function tabId() { return _active && _view === 'loadout' ? _tabId : null; }

    /** The loadout on show and its class, for publishing it. */
    function current() {
        if (!_active) return null;
        // The shop on show, as a shared shop is
        if (_view === 'shop') return { classId: BLAST_GANG, loadout: EFTForge.arenaShop.snapshot(), tabId: _tabId, shop: true };
        return { classId: EFTForge.arena.classId(), loadout: _loadout, tabId: _tabId, shop: false };
    }

    // `fromTab`: a tab's loadout is being shown, and that tab stays the active one
    async function _show(target, fromTab) {
        _leaveBuilder();
        if (!fromTab) {
            EFTForge.tabs && EFTForge.tabs.deactivateActiveTab && EFTForge.tabs.deactivateActiveTab();
            if (_tabsOn()) {
                _tabId = null;
                _loadout = _empty();
            }
        }
        const container = document.getElementById('main-container');
        if (!container) return;
        _wire();
        container.classList.remove('no-gun');
        container.classList.add('arena-loadout-mode');
        // The shop keeps the page's old two panel layout (styles.css arena-shop-mode)
        container.classList.toggle('arena-shop-mode', target === BLAST_GANG);
        // No tab (mobile): the shop is the user's own
        if (target === BLAST_GANG && !fromTab && EFTForge.arenaShop) EFTForge.arenaShop.useStore(null, true);
        _active = true;
        _pick = _freshPick();
        _view = target === BLAST_GANG ? 'shop' : 'loadout';
        if (typeof _syncHeaderExpand === 'function') _syncHeaderExpand();
        _renderLoading();
        try {
            await _ensureData();
            // The shop's left panel is as wide as the loadout's board column, which is what the
            // loadout's left panel leaves after the rig and pockets (styles.css arena-shop-mode)
            container.style.setProperty('--arena-carry-w', _reserveCarryWidth() + 'px');
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
        // The Community button's count is the class's
        if (_active && EFTForge.arenaCommunity) EFTForge.arenaCommunity.syncButtons();
    }

    function leave() {
        if (!_active) return;
        _wtHide();
        _closeSplit();
        _active = false;
        _pick = _freshPick();
        // A weapon being edited keeps its own tab in _editing
        if (_tabsOn()) {
            _tabId = null;
            _loadout = _empty();
        }
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
        _syncBlob();
    }

    function isActive() { return _active; }
    function editingSlot() { return _editing ? _editing.key : null; }

    /**
     * What the weapon open in the builder belongs to, for the banner over its placeholder
     * (arena.js): a BlastGang shop weapon (`shop`), a loadout's weapon (its class, and the
     * preset's name while its tab shows one), or nothing.
     * @returns {{ shop: boolean, logo?: string, icon?: string | null, cls?: string, name?: string | null } | null}
     */
    function builderContext() {
        if (EFTForge.arenaShop && EFTForge.arenaShop.editingItem()) return { shop: true, logo: ARENA_ART + 'blastgang.webp' };
        const gun = EFTForge.state && EFTForge.state.currentGun;
        if (!_editing || !gun) return null;
        // A weapon opened from the loadout, not another gun loaded since
        const loadout = _editing.tabId ? EFTForge.tabs.arenaTabLoadout(_editing.tabId) : _store.byClass[_editing.cls];
        const weapon = loadout && loadout.weapons[_editing.key];
        if (weapon && weapon.gunId !== gun.id) return null;
        const name = _editing.tabId && EFTForge.tabs.arenaTabPresetName ? EFTForge.tabs.arenaTabPresetName(_editing.tabId) : null;
        return { shop: false, icon: classIconUrl(_editing.cls), cls: className(_editing.cls), name: name };
    }

    /** Where the builder's Back goes from the weapon open in it: its loadout or the shop. */
    function resumeTarget() {
        if (!EFTForge.arena || !EFTForge.arena.isActive()) return null;
        // Back to the shop's tab when it's in one
        if (EFTForge.arenaShop && EFTForge.arenaShop.editingItem()) {
            const shopTab = _tabsOn() ? EFTForge.arenaShop.tabId() : null;
            return shopTab ? TAB_PREFIX + shopTab : BLAST_GANG;
        }
        if (_editing && _editing.tabId) return TAB_PREFIX + _editing.tabId;
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

    // The server takes at most 300 ids a request (routers/shared.py MAX_INSTALLED_IDS)
    const POINTS_CHUNK = 300;

    async function _ensurePoints(ids) {
        const missing = Array.from(new Set(ids.filter(function (id) { return id && !_points[id]; })));
        if (missing.length === 0) return;
        const chunks = [];
        for (let i = 0; i < missing.length; i += POINTS_CHUNK) chunks.push(missing.slice(i, i + POINTS_CHUNK));
        const found = await Promise.all(chunks.map(function (chunk) { return EFTForge.api.fetchArenaPoints(chunk); }));
        found.forEach(function (batch) { Object.assign(_points, batch); });
    }

    // Every item id a loadout uses (the one on show without one)
    function _loadoutIds(loadout) {
        const l = loadout ? _clean(loadout) : _loadout;
        const ids = [];
        WEAPON_SLOTS.forEach(function (key) {
            const w = l.weapons[key];
            if (!w) return;
            ids.push(w.gunId);
            (w.pairs || []).forEach(function (pair) { ids.push(pair[1]); });
            if (w.ammoId) ids.push(w.ammoId);
            (Array.isArray(w.magLoads) ? w.magLoads : []).forEach(function (load) { if (load && load[0]) ids.push(load[0]); });
        });
        GEAR_SLOTS.forEach(function (key) {
            const g = l.gear[key];
            if (!g) return;
            ids.push(g.id);
            Object.values(g.plates || {}).forEach(function (id) { ids.push(id); });
            Object.values(g.parts || {}).forEach(function (id) { ids.push(id); });
        });
        l.carried.forEach(function (c) {
            ids.push(c.id);
            if (c.ammoId) ids.push(c.ammoId);
            (Array.isArray(c.loads) ? c.loads : []).forEach(function (load) { if (load && load[0]) ids.push(load[0]); });
        });
        return ids.filter(Boolean);
    }

    /** Load what drawing `loadouts` needs: the item lists and every item's meta points. */
    async function ensureItems(loadouts) {
        await _ensureData();
        const ids = [];
        (loadouts || []).forEach(function (l) { Array.prototype.push.apply(ids, _loadoutIds(l || _empty())); });
        await _ensurePoints(ids);
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
        // The rounds in its magazine and the chambered one, as the game's own presets count them
        let ammo = w.ammoId ? _mp(w.ammoId) : 0;
        _weaponLoadsOf(w, capacity).forEach(function (load) { ammo += _mp(load[0]) * load[1]; });
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
        if (item && item.magazine_capacity > 0) _magLoads(c).forEach(function (load) { each += _mp(load[0]) * load[1]; });
        return each * (c.count || 1);
    }

    /** A loadout's meta points by group (the one on show without one). */
    function totals(loadout) {
        const l = loadout ? _clean(loadout) : _loadout;
        let weapons = 0;
        let mods = 0;
        WEAPON_SLOTS.forEach(function (key) {
            const m = _weaponMeta(l.weapons[key]);
            weapons += m.total;
            mods += m.mods;
        });
        let gear = 0;
        GEAR_SLOTS.forEach(function (key) { gear += _gearMeta(l.gear[key]); });
        let carried = 0;
        l.carried.forEach(function (c) { if (c.where) carried += _carriedMeta(c); });
        return { weapons: weapons, gear: gear, carried: carried, mods: mods, total: weapons + gear + carried };
    }

    /* ===========================
       THE BOARD DRAWN SMALL
       Another loadout on the board's own slot tiles, for a tab's hover preview (like the
       Ballistics Workbench tab's) and a community preset's card. Laid out as the workbench
       preview lays its board, plus what an Arena preset adds: the earpiece in the ammo's
       spot, and the weapons and melee weapon in two rows under it. Body armor and a rig
       share the middle as they do there: a rig moves into the armor's spot when it's worn
       alone. Nothing here starts a Kitbash! drawing, it shows the ones already made.
    =========================== */

    let _previewing = false;   // drawing a board that isn't the one on show
    let _previewDraws = false; // and it may ask Kitbash! for the drawings it lacks (a tab's preview)
    let _previewClass = null;  // that board's class, which its locks follow

    // The workbench preview's middle row, from the board's own columns and rows
    function _previewLayout(l) {
        const armorSpot = { slot: 'ArmorVest', x: COL[1], y: ROW[1] };
        const rigSpot = { slot: 'TacticalVest', x: COL[0], y: ROW[1] };
        const middle = l.gear.ArmorVest ? [rigSpot, armorSpot]
            : l.gear.TacticalVest ? [{ slot: 'TacticalVest', x: COL[1], y: ROW[1] }]
                : [rigSpot, armorSpot];
        return GEAR_LAYOUT.filter(function (spot) { return spot.slot !== 'ArmorVest'; }).concat(middle);
    }

    /**
     * `loadout` on the board's slot tiles, or null until ensureItems() has loaded what it needs.
     * `draw`: ask Kitbash! for the drawings it doesn't have yet, as a tab's hover preview does
     * (the builder's tab preview draws a tab's build too); "arena-drawing-done" on document
     * says when one is in. Without it only drawings already made show, as on community cards,
     * which could otherwise ask for hundreds.
     * @param {any} loadout
     * @param {string} classId
     * @param {boolean} [draw]
     */
    function boardHtml(loadout, classId, draw) {
        if (!_data) return null;
        const saved = _loadout;
        const l = _clean(loadout);
        _loadout = l;
        _previewing = true;
        _previewDraws = !!draw;
        _previewClass = classId || null;
        try {
            const board = document.createElement('div');
            board.className = 'arena-board arena-board-preview';
            _previewLayout(l).forEach(function (spot) { _drawSpot(board, spot, BOARD_FRAME); });
            board.querySelectorAll('[tabindex]').forEach(function (node) { node.removeAttribute('tabindex'); });
            return board.outerHTML;
        } finally {
            _loadout = saved;
            _previewing = false;
            _previewDraws = false;
            _previewClass = null;
        }
    }

    // While shopBoard() draws BlastGang's kit
    let _kitBoard = false;
    // What the board held before the change being drawn (_changed), for its slot flashes
    /** @type {Record<string, string> | null} */
    let _flashBefore = null;

    /**
     * BlastGang's kit on the board's slot tiles, laid out as the game's Shop settings screen
     * has them: two columns with the character between, a cap where the helmet goes (the shop
     * sells those) and no long guns. Meta points and plates don't count in BlastGang, so neither shows. Tiles
     * keep their data-arena-key for arena-shop.js to wire; `active` marks the open one.
     * Null until ensureIds() has loaded what it needs.
     * @param {any} loadout
     * @param {string | null} active
     */
    function shopBoard(loadout, active) {
        if (!_data) return null;
        const saved = _loadout;
        _loadout = _clean(loadout);
        _kitBoard = true;
        _previewing = true;
        _previewDraws = true;
        _previewClass = null;
        try {
            const board = document.createElement('div');
            board.className = 'arena-board arena-shop-board';
            board.style.setProperty('--frame-w', String(SHOP_FRAME.w));
            SHOP_LAYOUT.forEach(function (spot) { _drawSpot(board, spot, SHOP_FRAME); });
            // Nor does the pistol's round count: the kit's pistol isn't loaded up here
            board.querySelectorAll('.bw-slot-insert, .arena-meta, .arena-rounds').forEach(function (node) { node.remove(); });
            board.querySelectorAll('[data-arena-key]').forEach(function (node) {
                const tile = /** @type {HTMLElement} */ (node);
                tile.classList.remove('arena-slot-locked');
                tile.classList.toggle('active-slot', tile.dataset.arenaKey === active);
            });
            return board;
        } finally {
            _loadout = saved;
            _kitBoard = false;
            _previewing = false;
            _previewDraws = false;
        }
    }

    /**
     * Everything gear slot `slot` takes, as the presets' equipment list has it (no class rules).
     * `plain`: only what has no armor, as the shop's cap slot takes.
     * @param {string} slot
     * @param {boolean} [plain]
     */
    function gearChoices(slot, plain) {
        if (!_data) return [];
        return Object.values(_data.gear).filter(function (i) { return i.gear_slot === slot && !(plain && _data.armor[i.id]); });
    }

    /**
     * What keeps `id` from being worn in `slot` with the rest of `loadout` (the presets' own
     * gear conflict check), as {slot, id, text}, or null. `id` is an item id, not a shop id.
     * @param {any} loadout
     * @param {string} id
     * @param {string} slot
     */
    /** An item's name, for another module's messages. @param {string} id */
    function itemName(id) {
        const item = _item(id);
        return (item && (item.name || item.short_name)) || _gearRow(id).name;
    }

    function gearConflictIn(loadout, id, slot) {
        if (!_data || !id) return null;
        const saved = _loadout;
        _loadout = _clean(loadout);
        try {
            const conflict = _gearConflict(id, slot);
            return conflict ? { slot: conflict.slot, id: conflict.id, text: _conflictText(conflict) } : null;
        } finally {
            _loadout = saved;
        }
    }

    /** Load the item lists and the meta points records of `ids`, which the board draws from. */
    async function ensureIds(ids) {
        await _ensureData();
        await _ensurePoints(ids || []);
    }

    /**
     * A community preset's card: the board drawn small with its meta points against the
     * class's limits under it, or null until ensureItems() has loaded what it needs.
     * @param {any} loadout
     * @param {string} classId
     */
    function summaryHtml(loadout, classId) {
        const board = boardHtml(loadout, classId);
        if (board === null) return null;
        const arena = EFTForge.arena;
        const l = _clean(loadout);
        const sum = totals(l);
        const cls = arena.classes().find(function (c) { return c.id === classId; });
        const max = cls && cls.meta_max ? cls.meta_max : null;
        const min = cls && cls.meta_min != null ? cls.meta_min : null;
        const state = max != null && sum.total > max ? 'over' : min != null && sum.total < min ? 'under' : 'ok';
        let count = 0;
        l.carried.forEach(function (c) { if (c.where) count += 1; });
        return board + '<div class="arena-sum-foot"><span class="arena-sum-meta is-' + state + '">' + escapeHtml(arena.formatMeta(sum.total)) +
            (max != null ? '<span class="arena-sum-max"> / ' + escapeHtml(arena.formatMeta(max)) + '</span>' : '') + '</span>' +
            '<span class="arena-sum-carried">' + escapeHtml(tFmt('arena.sumCarried', { n: count })) + '</span></div>';
    }

    /** The class's name, or "" while Arena's config isn't here. */
    function className(classId) {
        if (classId === BLAST_GANG) return _t('arena.shop.tab');
        const cls = EFTForge.arena.classes().find(function (c) { return c.id === classId; });
        return cls ? cls.name : '';
    }

    /** The class's small icon, or null. */
    function classIconUrl(classId) {
        if (classId === BLAST_GANG) return ARENA_ART + 'blastgang.webp';
        const cls = EFTForge.arena.classes().find(function (c) { return c.id === classId; });
        const icon = cls && CLASS_ICONS[cls.key];
        return icon ? ARENA_ART + 'classes/' + icon + '.webp' : null;
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
            (Array.isArray(w.magLoads) ? w.magLoads : []).forEach(function (load) { if (load && load[0] && load[0] !== w.ammoId) check(load[0], key, gun); });
        });
        GEAR_SLOTS.forEach(function (key) {
            const g = _loadout.gear[key];
            if (!g) return;
            check(g.id, key, null);
            Object.values(g.plates || {}).forEach(function (id) { check(id, key, null); });
            Object.values(g.parts || {}).forEach(function (id) { check(id, key, null); });
        });
        // Kept from before mounts counted: a helmet's headset worn on its own
        const ear = _loadout.gear.Earpiece;
        if (ear && _isMountOnly(ear.id)) out.push({ slot: 'Earpiece', text: named(ear.id) + ': ' + _t('arena.needsMount') });
        _loadout.carried.forEach(function (c) {
            check(c.id, 'carried', null);
            const loaded = new Set([c.ammoId].concat((Array.isArray(c.loads) ? c.loads : []).map(function (load) { return load && load[0]; })));
            loaded.forEach(function (id) { if (id) check(id, 'carried', null); });
        });
        // Gear that can't be worn together (an armored rig and body armor, a mask and a helmet),
        // plates and helmet parts included
        if (_data) {
            _gearConflicts().forEach(function (pair) {
                out.push({ slot: pair[0].slot, text: named(pair[0].id) + ' / ' + named(pair[1].id) });
            });
        }
        const cls = arena.currentClass();
        const sum = totals().total;
        if (cls && cls.meta_max != null && sum > cls.meta_max) {
            out.push({ slot: null, overLimit: true, text: tFmt('arena.overLimit', { n: arena.formatMeta(sum - cls.meta_max) }) });
        }
        // Shown by the meta bar like the upper limit, so it's left out of the problem list too
        if (cls && cls.meta_min != null && sum < cls.meta_min) {
            out.push({ slot: null, overLimit: true, text: tFmt('arena.underLimit', { n: arena.formatMeta(cls.meta_min - sum) }) });
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
            _renderClassRow();
            EFTForge.arenaShop.render(left, right, '');
            _syncBlob();
            return;
        }
        _normalize();
        _renderClassRow();
        left.innerHTML = _metaHtml() +
            '<div class="stats-section arena-board-section"><div class="arena-board" id="arena-board"></div></div>' + _snapshotHtml();
        _renderBoard();
        _renderCarry();
        _wireLeft(left);
        _renderRight();
        _syncBlob();
    }

    /**
     * Whether the preset on show is outside its class's meta point range: the loadout page's, or
     * the one whose weapon is open in the builder. The background glow turns red for it
     * (utils.js _updateBlobColor).
     */
    function overBudget() {
        const arena = EFTForge.arena;
        if (!arena || !arena.isActive()) return false;
        // BlastGang's shop: any problem with the side on show, or with its weapon open in the builder
        const shop = EFTForge.arenaShop;
        if (_active && _view === 'shop') return !!(shop && shop.issues().length);
        if (!_active && !_editing && shop && shop.editingItem()) return shop.editedOut();
        let loadout = null;
        if (_active && _view === 'loadout') loadout = _loadout;
        else if (_editing && !_active) {
            loadout = _editing.tabId ? EFTForge.tabs.arenaTabLoadout(_editing.tabId) : (_store.byClass[_editing.cls] || null);
        }
        if (!loadout) return false;
        const cls = arena.currentClass();
        if (!cls) return false;
        // Under the class's floor is as much a problem as over its limit
        const total = totals(loadout).total;
        return (cls.meta_max != null && total > cls.meta_max) || (cls.meta_min != null && total < cls.meta_min);
    }

    function _syncBlob() {
        if (EFTForge.utils && EFTForge.utils.updateBlobColor) EFTForge.utils.updateBlobColor();
    }

    // The builder's parts into the meta points the loadout counts from, so a weapon open in
    // the builder counts in full while it's edited
    function _rememberBuilderItems(node) {
        Object.values((node && node.children) || {}).forEach(function (child) {
            if (child.item && typeof child.item.meta_points === 'number' && !_points[child.item.id]) _points[child.item.id] = child.item;
            _rememberBuilderItems(child);
        });
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
            '</div></div>' + _problemsHtml() + '</div>';
    }

    // The problems, at the foot of the meta points panel. Being over the class's limit is
    // already its status line, so it isn't listed again.
    function _problemsHtml() {
        const list = problems().filter(function (p) { return !p.overLimit; });
        if (!list.length) return '';
        return '<div class="arena-problems"><div class="arena-problems-title">' + escapeHtml(_t('arena.violations')) + '</div>' +
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
        // A community card only shows drawings already made
        if (_previewing && !_previewDraws) return null;
        if (_kitbashOff()) return null;
        _drawings.set(key, 'working');
        Promise.resolve(draw()).then(function () {
            // A tab's hover preview waiting on it redraws
            document.dispatchEvent(new CustomEvent('arena-drawing-done'));
            // A drawing that came to nothing: the slot stops waiting on it and shows the
            // picture it has (one that worked redraws in _requestDrawing)
            if (typeof _drawings.get(key) === 'string' || !_active || _view !== 'loadout') return;
            _renderBoard();
            _renderCarry();
        });
        return null;
    }

    // /build-image lets only a few renders queue (routers/images.py) and answers 429 past them,
    // so a list of drawings (the shop's picker can ask for a dozen at once) goes a few at a time
    const DRAW_AT_ONCE = 4;
    let _drawsInFlight = 0;
    const _drawQueue = [];

    async function _requestDrawing(key, body) {
        if (_drawsInFlight >= DRAW_AT_ONCE) await new Promise(function (resolve) { _drawQueue.push(resolve); });
        _drawsInFlight += 1;
        try {
            await _requestDrawingNow(key, body);
        } finally {
            _drawsInFlight -= 1;
            const next = _drawQueue.shift();
            if (next) next();
        }
    }

    async function _requestDrawingNow(key, body) {
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
        // The shop redraws then, so its cards and picker ask again on their own instead of
        // waiting for something else to redraw them
        if (busy) {
            setTimeout(function () {
                if (_drawings.get(key) !== null) return;
                _drawings.delete(key);
                if (_active && _view === 'shop') render();
            }, 8000);
        }
        if (_active && url) {
            // The shop's cards are drawn the same way (arena-shop.js)
            if (_view === 'shop') render();
            else {
                _renderBoard();
                _renderCarry();
            }
        }
    }

    function _weaponKey(weapon) {
        return 'w|' + weapon.gunId + '|' + (weapon.pairs || []).map(function (p) { return p.join(':'); }).join(',') + '|' + (_weaponAmmoId(weapon) || '') + (_weaponMagRounds(weapon) > 0 ? '' : '|e');
    }

    /** Whether Kitbash! is still drawing `weapon`'s build. */
    function _weaponDrawingWorking(weapon) {
        return _drawings.get(_weaponKey(weapon)) === 'working';
    }

    // A gun's picture while it has no drawing: its factory preset from tarkov.dev (the /guns
    // list has it; the meta points record a loadout reads first doesn't), never the receiver
    function _gunPicture(gunId) {
        const gun = (_data && _data.guns[gunId]) || _item(gunId);
        return (gun && (gun.image_512_link || gun.preset_icon_link || gun.icon_link)) || null;
    }

    function _weaponDrawing(weapon) {
        const pairs = weapon.pairs || [];
        const key = _weaponKey(weapon);
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
                const fires = _weaponAmmoId(weapon);
                const ammo = fires ? { assume_full_mag: _weaponMagRounds(weapon) > 0, selected_ammo_id: fires } : {};
                await _requestDrawing(key, Object.assign({}, spt, ammo, { source: 'preview' }));
            } catch (err) {
                console.warn('[arena-loadout] Kitbash! weapon:', err);
                _drawings.set(key, null);
            }
        });
    }

    /**
     * A published preset's drawings, stored on Gitee when it was published
     * (services/arena_drawings.py), filed under the keys its board would ask Kitbash! for, so
     * its card shows them without asking. `drawings` is {slot: url}: a weapon slot, or
     * Headwear for the helmet with its parts.
     * @param {any} loadout
     * @param {Record<string, string> | null | undefined} drawings
     */
    function useDrawings(loadout, drawings) {
        if (!drawings || !loadout) return;
        const l = _clean(loadout);
        WEAPON_SLOTS.forEach(function (slot) {
            const w = l.weapons[slot];
            if (w && drawings[slot] && typeof _drawings.get(_weaponKey(w)) !== 'string') _drawings.set(_weaponKey(w), drawings[slot]);
        });
        const helmet = l.gear.Headwear;
        const key = helmet ? _helmetKey(helmet) : null;
        if (key && drawings.Headwear && typeof _drawings.get(key) !== 'string') _drawings.set(key, drawings.Headwear);
    }

    // A helmet's drawing key, or null for one wearing no parts
    function _helmetKey(worn) {
        const slots = Object.keys(worn.parts || {}).sort();
        if (!slots.length) return null;
        return 'h|' + worn.id + '|' + slots.map(function (slot) { return slot + '=' + worn.parts[slot]; }).join(',');
    }

    function _helmetDrawing(worn) {
        const key = _helmetKey(worn);
        if (!key) return null;
        const slots = Object.keys(worn.parts || {}).sort();
        return _drawing(key, function () {
            // Kitbash! takes the helmet as SPT items; any 24 hex ids do
            const root = '000000000000000000000000';
            const items = [{ _id: root, _tpl: worn.id, parentId: 'hideout', slotId: 'hideout' }].concat(slots.map(function (slot, i) {
                return { _id: root.slice(0, -2) + String(i + 1).padStart(2, '0'), _tpl: worn.parts[slot], parentId: root, slotId: slot };
            }));
            return _requestDrawing(key, { id: worn.id, items: items, source: 'armor' });
        });
    }

    /* ===========================
       GEAR CONFLICTS
       What the game won't let be worn together, for every worn item, plate and helmet part:
       an armored rig and body armor, the items' own conflict lists, the equipment slots an
       item keeps empty (a mask over the eyes, a helmet over the ears), and the slots of
       another item it can't be next to while they hold something (a gas mask and a visor).
    =========================== */

    // The equipment slot each blocks_ flag keeps empty
    const BLOCKS = { Headwear: 'blocks_headwear', Earpiece: 'blocks_earpiece', FaceCover: 'blocks_facecover', Eyewear: 'blocks_eyewear' };

    function _gearRow(id) {
        const gear = (_data && _data.gear[id]) || {};
        const armor = (_data && _data.armor[id]) || {};
        const row = {
            id: id,
            name: armor.name || gear.name || id,
            conflicting_ids: (armor.conflicting_ids || []).concat(gear.conflicting_ids || []),
            conflicting_slots: (armor.conflicting_slots || []).concat(gear.conflicting_slots || []),
        };
        Object.values(BLOCKS).forEach(function (flag) { row[flag] = !!(armor[flag] || gear[flag]); });
        return row;
    }

    /**
     * An armor's or armored rig's class as the game shows it: the highest of its built-in
     * armor and its plates. `plates` is what it holds ({slot: id}); without it, the plates it
     * comes with. 0 for what has no armor.
     * @param {string} id
     * @param {Object<string, string>} [plates]
     */
    function _armorClass(id, plates) {
        const armor = _data && _data.armor[id];
        if (!armor) return 0;
        const best = function (item) {
            return ((item && item.pieces) || []).reduce(function (n, p) { return Math.max(n, p.armor_class || 0); }, 0);
        };
        let cls = best(armor);
        const held = plates || {};
        (armor.plate_slots || []).forEach(function (slot) {
            const plateId = plates ? held[slot.slot] : slot.default_id;
            if (plateId) cls = Math.max(cls, best(_data.armor[plateId]));
        });
        return cls;
    }

    /**
     * An armor's hover card (armor-sim.js armorCardHtml): its built-in armor and plates with
     * their class, durability and material. `plates` as _armorClass() takes them. '' for
     * what has no armor.
     * @param {string} id
     * @param {Object<string, string>} [plates]
     * @param {string} [note]
     */
    function armorCardHtml(id, plates, note) {
        const armor = _data && _data.armor[id];
        const sim = EFTForge.armorSim;
        if (!armor || !sim || !sim.armorCardHtml) return '';
        const held = (armor.plate_slots || []).map(function (slot) {
            const plateId = plates ? (plates[slot.slot] || null) : slot.default_id;
            return { slot: slot.slot, item: plateId ? _data.armor[plateId] : null };
        });
        return sim.armorCardHtml(armor, held, note);
    }

    function _isArmoredRig(id) {
        const armor = _data && _data.armor[id];
        return !!(armor && (((armor.pieces || []).length) || ((armor.plate_slots || []).length)));
    }

    // Everything `gear` wears: {slot, place, id}, `place` being 'parts:<slot>' or 'plates:<slot>'
    // for a helmet part or a plate, null for the worn item itself
    function _wornEntries(gear) {
        const out = [];
        GEAR_SLOTS.forEach(function (slot) {
            const worn = gear[slot];
            if (!worn) return;
            out.push({ slot: slot, place: null, id: worn.id });
            ['parts', 'plates'].forEach(function (store) {
                Object.keys(worn[store] || {}).forEach(function (name) {
                    if (worn[store][name]) out.push({ slot: slot, place: store + ':' + name, id: worn[store][name] });
                });
            });
        });
        return out;
    }

    // The name of the insert slot an entry sits in, or null for a worn item
    function _placeName(entry) {
        return entry.place ? entry.place.slice(entry.place.indexOf(':') + 1) : null;
    }

    // Whether `x` can't be next to the slot conflicts' side of `y`: `y` holds a filled slot `x`
    // names, or `y` fills a slot `x` names on the item holding it
    function _slotHit(x, y, gear) {
        const worn = gear[y.slot];
        return _gearRow(x.id).conflicting_slots.some(function (c) {
            if (c.item === y.id && worn && ((worn.parts || {})[c.slot] || (worn.plates || {})[c.slot])) return true;
            if (_placeName(y) !== c.slot || !worn) return false;
            return worn.id === c.item || Object.values(worn.parts || {}).indexOf(c.item) !== -1;
        });
    }

    // Whether two worn entries of `gear` can't be worn together
    function _entriesConflict(a, b, gear) {
        const ra = _gearRow(a.id);
        const rb = _gearRow(b.id);
        if (ra.conflicting_ids.indexOf(b.id) !== -1 || rb.conflicting_ids.indexOf(a.id) !== -1) return true;
        // An item never keeps its own slot empty (a face cover blocks face covers)
        if (a.slot !== b.slot && ((BLOCKS[b.slot] && ra[BLOCKS[b.slot]]) || (BLOCKS[a.slot] && rb[BLOCKS[a.slot]]))) return true;
        if (a.slot === 'TacticalVest' && b.slot === 'ArmorVest' && !a.place && !b.place && _isArmoredRig(a.id)) return true;
        if (b.slot === 'TacticalVest' && a.slot === 'ArmorVest' && !a.place && !b.place && _isArmoredRig(b.id)) return true;
        return _slotHit(a, b, gear) || _slotHit(b, a, gear);
    }

    /**
     * What keeps `id` from going into `slot` with the rest of the loadout, as {slot, id} of
     * what's in the way, or null. `place` puts it in an insert slot of what `slot` wears
     * ('parts:<slot>' for a helmet part, 'plates:<slot>' for a plate); without it, `id` is
     * worn in `slot` in place of what's there, plates and parts too.
     * @param {string} id
     * @param {string} slot
     * @param {string} [place]
     */
    function _gearConflict(id, slot, place) {
        // A headset made for a helmet's mount goes on the helmet, as the game puts it there
        if (!place && slot === 'Earpiece' && _isMountOnly(id)) {
            const mount = _mountSlotFor(id);
            const helmet = _loadout.gear.Headwear;
            if (!mount) return { slot: 'Headwear', id: helmet ? helmet.id : null, noMount: true };
            return _gearConflict(id, 'Headwear', 'parts:' + mount);
        }
        const gear = Object.assign({}, _loadout.gear);
        if (place) {
            const worn = gear[slot];
            if (!worn) return null;
            const store = place.slice(0, place.indexOf(':'));
            const copy = Object.assign({}, worn);
            copy[store] = Object.assign({}, worn[store] || {}, { [place.slice(store.length + 1)]: id });
            gear[slot] = copy;
        } else {
            gear[slot] = { id: id };
        }
        const mine = { slot: slot, place: place || null, id: id };
        for (const other of _wornEntries(gear)) {
            if (other.slot === slot && other.place === mine.place) continue;
            if (_entriesConflict(mine, other, gear)) return { slot: other.slot, id: other.id };
        }
        return null;
    }

    /** Every pair of worn items, plates and helmet parts of the loadout that can't be worn together. */
    function _gearConflicts() {
        const gear = _loadout.gear;
        const entries = _wornEntries(gear);
        const out = [];
        entries.forEach(function (a, i) {
            entries.forEach(function (b, j) {
                if (j > i && _entriesConflict(a, b, gear)) out.push([a, b]);
            });
        });
        return out;
    }

    // Whether `id` is a headset only a helmet's mount takes (/arena/items mount_only)
    function _isMountOnly(id) {
        return !!(_data && _data.gear[id] && _data.gear[id].mount_only);
    }

    // The worn helmet's part slot that takes headset `id`, or null
    function _mountSlotFor(id) {
        const helmet = _loadout.gear.Headwear;
        const armor = helmet && _data && _data.armor[helmet.id];
        const slot = ((armor && armor.attachment_slots) || []).slice(0, 4).find(function (s) {
            return (s.allowed_ids || []).indexOf(id) !== -1;
        });
        return slot ? slot.slot : null;
    }

    function _conflictText(conflict) {
        if (conflict.noMount) return _t('arena.needsMount');
        return tFmt('arena.conflictWith', { name: (_item(conflict.id) || _gearRow(conflict.id)).name || '' });
    }

    /* ===========================
       SLOT FLASHES
       The gun builder's sweeps (ballistics-workbench.js runs them on .bw-slot-body): green
       for an install, red for a removal, grey for the slots an install revealed, and the
       double red pulse on the slot a refused pick runs into.
    =========================== */

    // Pulse the board slot in the way
    function _flashSlot(slot) {
        const wb = EFTForge.workbench;
        if (!wb) return;
        document.querySelectorAll('[data-arena-key="' + slot + '"]').forEach(function (node) {
            wb.flashConflict(/** @type {HTMLElement} */ (node));
        });
    }

    /**
     * What every slot on a board holds, key to item id ('' when empty), to diff against
     * once the board is drawn again
     * @param {Element | null} board
     * @returns {Record<string, string> | null}
     */
    function boardItems(board) {
        if (!board || !board.isConnected) return null;
        /** @type {Record<string, string>} */
        const out = {};
        board.querySelectorAll('[data-arena-key]').forEach(function (node) {
            const tile = /** @type {HTMLElement} */ (node);
            out[tile.dataset.arenaKey] = tile.dataset.arenaItem || '';
        });
        // What the rig and pockets hold, by where each item sits (_carriedView)
        board.querySelectorAll('[data-carry-key]').forEach(function (node) {
            const el = /** @type {HTMLElement} */ (node);
            out['carry:' + el.dataset.carryKey] = el.dataset.carrySig || '';
        });
        return out;
    }

    // A sweep over part of a rig or pockets grid: the item cells have no slot body of their own,
    // and a removed item's cells have nothing left to sweep
    function _carryFlash(grid, left, top, width, height, type) {
        const flash = document.createElement('div');
        flash.className = 'arena-cflash slot-flash-' + type;
        flash.style.left = left + 'px';
        flash.style.top = top + 'px';
        flash.style.width = width + 'px';
        flash.style.height = height + 'px';
        grid.appendChild(flash);
        const done = function () { flash.remove(); };
        flash.addEventListener('animationend', done, { once: true });
        setTimeout(done, 1000);
    }

    /**
     * Whether an item that left a place in `before` (boardItems of the board and carry box)
     * only moved: the loadout still holds at least as many of it. A move flashes its new
     * place green and leaves the old one alone.
     * @param {Record<string, string>} before
     * @returns {(id: string) => boolean}
     */
    function _movedTest(before) {
        /** @type {Record<string, number>} */
        const was = {};
        // Carried stacks count by how many they hold, so merging one into another is a move too
        Object.keys(before).forEach(function (k) {
            if (k.indexOf('carry:') !== 0) {
                if (before[k]) was[before[k]] = (was[before[k]] || 0) + 1;
                return;
            }
            const sig = (before[k] || '').split('|');
            if (sig[0]) was[sig[0]] = (was[sig[0]] || 0) + (Number(sig[1]) || 1);
        });
        /** @type {Record<string, number>} */
        const held = {};
        const add = function (id, n) { if (id) held[id] = (held[id] || 0) + (n || 1); };
        WEAPON_SLOTS.forEach(function (key) { const w = _loadout.weapons[key]; if (w) add(w.gunId); });
        GEAR_SLOTS.forEach(function (key) {
            const g = _loadout.gear[key];
            if (!g) return;
            add(g.id);
            Object.values(g.plates || {}).forEach(function (id) { add(id); });
            Object.values(g.parts || {}).forEach(function (id) { add(id); });
        });
        _loadout.carried.forEach(function (c) { if (c.where) add(c.id, c.count || 1); });
        return function (id) { return !!id && (held[id] || 0) >= (was[id] || 0); };
    }

    /**
     * The middle column's sweeps after a change: the rig slot as the board's slots, a new or
     * changed item green, a removed one's cells red, and a new rig's grids grey, as the
     * builder reveals the slots a part brings
     * @param {Record<string, string> | null} before
     * @param {Element | null} box
     */
    function _flashCarryChanges(before, box) {
        if (!before || !box || !EFTForge.workbench) return;
        const moved = _movedTest(before);
        flashBoardChanges(before, box, moved);
        const rigTile = /** @type {HTMLElement | null} */ (box.querySelector('[data-arena-key="TacticalVest"]'));
        const rigChanged = !!rigTile && 'TacticalVest' in before && before.TacticalVest !== (rigTile.dataset.arenaItem || '');
        const gridOf = function (where, index) {
            return box.querySelector('.arena-cgrid[data-where="' + where + '"][data-grid="' + index + '"]');
        };
        if (rigChanged) {
            box.querySelectorAll('.arena-cgrid[data-where="rig"]').forEach(function (grid) {
                const g = /** @type {HTMLElement} */ (grid);
                _carryFlash(g, 0, 0, g.offsetWidth, g.offsetHeight, 'reveal');
            });
        }
        const now = {};
        box.querySelectorAll('[data-carry-key]').forEach(function (node) {
            const el = /** @type {HTMLElement} */ (node);
            const key = el.dataset.carryKey;
            now[key] = true;
            if (rigChanged && key.indexOf('rig|') === 0) return;
            if (before['carry:' + key] === (el.dataset.carrySig || '')) return;
            const grid = el.parentElement;
            if (grid) _carryFlash(grid, el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight, 'install');
        });
        Object.keys(before).forEach(function (k) {
            if (k.indexOf('carry:') !== 0 || now[k.slice(6)]) return;
            const p = k.slice(6).split('|');
            if (rigChanged && p[0] === 'rig') return;
            if (moved((before[k] || '').split('|')[0])) return;
            const grid = gridOf(p[0], p[1]);
            if (!grid) return;
            _carryFlash(grid, Number(p[2]) * CELL, Number(p[3]) * CELL, Number(p[4]) * CELL + 1, Number(p[5]) * CELL + 1, 'remove');
        });
    }

    /**
     * Sweep the slots whose item changed since `before` (boardItems of the board this one
     * replaced). A plate or helmet part slot under a changed vest or helmet is revealed, as
     * the builder reveals an installed part's child slots.
     * @param {Record<string, string> | null} before
     * @param {Element | null} board
     * @param {(id: string) => boolean} [moved] whether an item gone from a slot only moved, so
     *     its old slot doesn't flash
     */
    function flashBoardChanges(before, board, moved) {
        const wb = EFTForge.workbench;
        if (!before || !board || !wb) return;
        board.querySelectorAll('[data-arena-key]').forEach(function (node) {
            const tile = /** @type {HTMLElement} */ (node);
            const key = tile.dataset.arenaKey;
            const now = tile.dataset.arenaItem || '';
            const parts = key.split(':');
            if (parts.length === 3) {
                const parent = /** @type {HTMLElement | null} */ (board.querySelector('[data-arena-key="' + parts[0] + '"]'));
                const parentNow = parent ? parent.dataset.arenaItem || '' : '';
                if (!(key in before) || before[parts[0]] !== parentNow) {
                    wb.flashSlot(tile, 'reveal');
                    return;
                }
            }
            if (!(key in before) || before[key] === now) return;
            if (!now && moved && moved(before[key])) return;
            wb.flashSlot(tile, now ? 'install' : 'remove');
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
     * @param {{ key: string, id?: string|null, art: string|null, item: any, picture: string|null, mp: number|null, locked: boolean, insert: boolean, rounds?: string, working?: boolean, armorClass?: number }} t
     */
    function _tile(t, x, y, w, h, frame) {
        const tile = document.createElement('div');
        tile.className = 'bw-slot' + (t.insert ? ' bw-slot-insert' : '') + (t.item ? ' is-equipped' : '') +
            (t.locked ? ' arena-slot-locked' : '') + (_targetKey() === t.key ? ' active-slot' : '');
        tile.setAttribute('style', _place(x, y, w, h, frame || BOARD_FRAME));
        tile.tabIndex = 0;
        tile.dataset.arenaKey = t.key;
        // What it holds, for the slot flashes (flashBoardChanges)
        tile.dataset.arenaItem = (t.item && t.id) || '';
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
            } else if (t.working && typeof _bpWorkingLogoHtml === 'function') {
                tile.classList.add('kb-working-slot');
                body.insertAdjacentHTML('beforeend', _bpWorkingLogoHtml());
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
            const armorClass = t.armorClass != null ? t.armorClass
                : t.item.pieces && t.item.pieces.length ? Math.max.apply(null, t.item.pieces.map(function (p) { return p.armor_class || 0; })) : 0;
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
        const cls = _previewing ? _previewClass : undefined;
        return ids.some(function (id) {
            const item = _item(id);
            return !item || !arena.allowedForClass(item, cls) || (gun && !arena.allowedOnGun(item, gun, cls));
        });
    }

    function _renderBoard() {
        const board = document.getElementById('arena-board');
        if (!board) return;
        // The tile a weapon's hover card belongs to is about to go
        _wtHide();
        board.replaceChildren();
        GEAR_LAYOUT.forEach(function (spot) { _drawSpot(board, spot, BOARD_FRAME); });
        _wireTiles(board);
        if (_flashBefore) flashBoardChanges(_flashBefore, board, _movedTest(_flashBefore));
    }

    // One slot and its plates or helmet parts, into `board` in `frame`'s coordinates
    function _drawSpot(board, spot, frame) {
        const w = spot.w || SLOT;
        const h = spot.h || SLOT;
        const key = spot.slot;
        if (WEAPON_SLOTS.indexOf(key) !== -1) {
            const weapon = _loadout.weapons[key];
            const gun = weapon ? _item(weapon.gunId) : null;
            const ids = weapon ? [weapon.gunId].concat((weapon.pairs || []).map(function (p) { return p[1]; }), weapon.ammoId ? [weapon.ammoId] : [],
                _weaponLoads(weapon).map(function (load) { return load[0]; })) : [];
            // While Kitbash! draws the build the slot waits for it (with its working logo),
            // as the builder's own previews do, instead of showing another picture first
            const drawing = weapon ? _weaponDrawing(weapon) : null;
            const working = !!weapon && !drawing && _weaponDrawingWorking(weapon);
            board.appendChild(_tile({
                key: key, id: weapon ? weapon.gunId : null, art: key, item: gun, picture: gun ? (drawing || (working ? null : _gunPicture(weapon.gunId))) : null,
                working: working,
                mp: weapon ? _weaponMeta(weapon).total : null, locked: !!weapon && _locked(ids, gun), insert: false,
                rounds: weapon ? _roundsText(weapon) : '',
            }, spot.x, spot.y, w, h, frame));
            return;
        }
        const worn = _loadout.gear[key];
        const item = worn ? (_data.armor[worn.id] || _item(worn.id)) : null;
        const ids = worn ? [worn.id].concat(Object.values(worn.plates || {}), Object.values(worn.parts || {})) : [];
        const drawing = worn && key === 'Headwear' ? _helmetDrawing(worn) : null;
        // The highest class of it and the plates in it. BlastGang's kit draws no plates and
        // wears its armor as sold, with the plates it comes with.
        const plates = _kitBoard ? undefined : (worn && worn.plates) || {};
        const gearTile = _tile({
            key: key, id: worn ? worn.id : null, art: key, item: item, picture: item ? (drawing || item.image_link || item.icon_link) : null,
            mp: worn ? _gearMeta(worn) : null, locked: !!worn && _locked(ids, null), insert: false,
            armorClass: worn ? _armorClass(worn.id, plates) : 0,
        }, spot.x, spot.y, w, h, frame);
        // Armor shows its inserts and plates on hover, as the armor simulator's slots do
        const card = worn ? armorCardHtml(worn.id, plates) : '';
        if (card) gearTile.dataset.tooltipHtml = card;
        board.appendChild(gearTile);
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
                const partTile = _tile({
                    key: key + ':part:' + slot.slot, id: partId, art: null, item: part, picture: part ? (part.image_link || part.icon_link) : null,
                    mp: null, locked: !!partId && _locked([partId], null), insert: true,
                }, xy[0], xy[1], INSERT, INSERT, frame);
                const partCard = partId ? armorCardHtml(partId) : '';
                if (partCard) partTile.dataset.tooltipHtml = partCard;
                board.appendChild(partTile);
            });
        } else if (key === 'ArmorVest' || key === 'TacticalVest') {
            (armor.plate_slots || []).forEach(function (slot) {
                const where = PLATE_SPOTS[String(slot.slot).toLowerCase()];
                if (!where) return;
                const plateId = (worn.plates || {})[slot.slot];
                const plate = plateId ? (_data.armor[plateId] || _item(plateId)) : null;
                const xy = _insertSpot(where, spot.x, spot.y);
                const plateTile = _tile({
                    key: key + ':plate:' + slot.slot, id: plateId, art: null, item: plate, picture: plate ? (plate.image_link || plate.icon_link) : null,
                    mp: null, locked: !!plateId && _locked([plateId], null), insert: true,
                }, xy[0], xy[1], INSERT, INSERT, frame);
                const plateCard = plateId ? armorCardHtml(plateId) : '';
                if (plateCard) plateTile.dataset.tooltipHtml = plateCard;
                board.appendChild(plateTile);
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
            // A weapon shows its build's stats and its rounds on hover
            if (WEAPON_SLOTS.indexOf(key) !== -1 && tile.classList.contains('is-equipped')) {
                tile.addEventListener('mouseenter', function (e) { _wtScheduleShow(key, e.clientX, e.clientY); });
                tile.addEventListener('mousemove', function (e) { _wtMove(e.clientX, e.clientY); });
                tile.addEventListener('mouseleave', _wtHide);
                _addEditButton(tile, key);
            }
            // An equipped slot can be dragged: onto another slot of its kind, or onto the list to discard
            tile.addEventListener('pointerdown', function (e) {
                _wtHide();
                if (!tile.classList.contains('is-equipped')) return;
                const icon = /** @type {HTMLImageElement | null} */ (tile.querySelector('.bw-slot-icon'));
                _pressItem(e, { kind: 'slot', key: key, id: null, size: [1, 1], grid: false, picture: icon ? icon.src : '', fallback: '', source: tile.querySelector('.bw-slot-body') || icon });
            });
        });
    }

    // The shop cards' modding button (arena-shop.js), top left of an equipped weapon slot: the
    // weapon opens in the builder. A span, since the slot handles clicks and drags of its own.
    function _addEditButton(tile, key) {
        const body = tile.querySelector('.bw-slot-body');
        if (!body) return;
        const label = _t('arena.editInBuilder');
        const edit = document.createElement('span');
        edit.className = 'arena-shop-card-edit arena-slot-edit';
        edit.setAttribute('role', 'button');
        edit.tabIndex = 0;
        edit.title = label;
        edit.setAttribute('aria-label', label);
        edit.innerHTML = '<img src="assets/images/arena/menu/modding.webp" alt="" draggable="false">';
        const open = function (e) {
            e.stopPropagation();
            e.preventDefault();
            _wtHide();
            _editWeapon(key);
        };
        edit.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        edit.addEventListener('click', open);
        edit.addEventListener('keydown', function (e) {
            const k = /** @type {KeyboardEvent} */ (e).key;
            if (k === 'Enter' || k === ' ') open(e);
        });
        body.appendChild(edit);
    }

    /* ===========================
       A WEAPON'S HOVER CARD
       Hovering a weapon slot shows what the builder's tab preview shows for a build
       (tab-manager.js _tpStatsHtml): its drawing, its name and its current build panel, with
       the rounds loaded in it and its meta points.
    =========================== */

    const WT_DELAY = 150;
    const _wtStats = new Map();   // build key -> /build/calculate's answer
    let _wtEl = null;
    let _wtTimer = null;
    let _wtGen = 0;
    let _wtX = 0;
    let _wtY = 0;

    function _wtEnsureEl() {
        if (_wtEl) return _wtEl;
        _wtEl = document.createElement('div');
        _wtEl.id = 'arena-weapon-tooltip';
        document.body.appendChild(_wtEl);
        return _wtEl;
    }

    // `key`: a weapon slot, or {mag: carried index} for a magazine in the rig or pockets
    function _wtScheduleShow(key, x, y, delay) {
        _wtX = x;
        _wtY = y;
        clearTimeout(_wtTimer);
        if (_drag) return;
        _wtTimer = setTimeout(function () {
            if (typeof key === 'object' && key.mag !== undefined) _wtShowMag(key.mag);
            else _wtShow(key);
        }, delay || WT_DELAY);
    }

    function _wtMove(x, y) {
        _wtX = x;
        _wtY = y;
        if (_wtEl && _wtEl.classList.contains('visible')) _wtPosition();
    }

    function _wtHide() {
        clearTimeout(_wtTimer);
        _wtGen++;
        if (_wtEl) _wtEl.classList.remove('visible');
    }

    // The card goes once the pointer or a key leaves `anchor` behind, or it leaves the page
    function _wtWatchAnchor(anchor, gen) {
        const check = function (e) {
            if (gen !== _wtGen) return stop();
            const inside = anchor.isConnected && (e.type !== 'pointermove' || anchor.contains(/** @type {Node} */ (e.target)));
            if (!inside) {
                stop();
                _wtHide();
            }
        };
        const stop = function () {
            document.removeEventListener('pointermove', check, true);
            document.removeEventListener('keydown', check, true);
        };
        document.addEventListener('pointermove', check, true);
        document.addEventListener('keydown', check, true);
    }

    function _wtPosition() {
        if (!_wtEl) return;
        const margin = 8;
        const w = _wtEl.offsetWidth;
        const h = _wtEl.offsetHeight;
        let left = _wtX + 14;
        if (left + w > window.innerWidth - margin) left = _wtX - w - 14;
        let top = _wtY + 18;
        if (top + h > window.innerHeight - margin) top = _wtY - h - 18;
        _wtEl.style.left = Math.max(margin, left) + 'px';
        _wtEl.style.top = Math.max(margin, top) + 'px';
    }

    /**
     * The rounds list both hover cards show: one row a kind of round, top of the magazine first
     * (as they come out), each with its picture, name and count; `chamber` heads it, marked.
     * With nothing loaded, a line that says so. `total`: the count the slot shows.
     * @param {string|null} chamber
     * @param {any[]} loads bottom up
     * @param {string} total
     */
    /**
     * `names`: names to use for rounds the item lists don't have ({item id: name}), as some of
     * BlastGang's shop rounds aren't armory items
     * @param {string | null} chamber
     * @param {Array<[string, number]>} loads
     * @param {string} total
     * @param {Object<string, string>} [names]
     */
    function _roundsListHtml(chamber, loads, total, names) {
        const rows = [];
        if (chamber) rows.push({ id: chamber, n: 1, chamber: true });
        loads.slice().reverse().forEach(function (load) { rows.push({ id: load[0], n: load[1], chamber: false }); });
        const head = '<div class="arena-wt-rounds-head"><span>' + escapeHtml(_t('arena.wtRounds')) + '</span>' +
            '<span class="arena-wt-ammo-count">' + escapeHtml(total) + '</span></div>';
        if (!rows.length) {
            return head + '<div class="arena-wt-ammo is-empty"><span class="arena-wt-ammo-name">' + escapeHtml(_t('arena.wtNoAmmo')) + '</span></div>';
        }
        return head + rows.map(function (row) {
            const ammo = (_data && _data.gear[row.id]) || _item(row.id) || {};
            return '<div class="arena-wt-ammo' + (row.chamber ? ' is-chamber' : '') + '">' +
                (ammo.icon_link ? '<img class="arena-wt-ammo-icon" src="' + escapeHtml(ammo.icon_link) + '" alt="" onerror="this.remove()">' : '<span class="arena-wt-ammo-icon"></span>') +
                '<span class="arena-wt-ammo-name">' + escapeHtml(ammo.name || ammo.short_name || (names && names[row.id]) || row.id) + '</span>' +
                (row.chamber ? '<span class="arena-wt-ammo-tag">' + escapeHtml(_t('arena.wtChamber')) + '</span>' : '') +
                '<span class="arena-wt-ammo-count">' + escapeHtml('×' + row.n) + '</span></div>';
        }).join('');
    }

    // A magazine in the rig or pockets: its picture, name, the rounds in it and their meta points
    function _wtShowMag(index) {
        const c = _loadout.carried[index];
        if (!_active || !c || _drag) return;
        _wtGen++;
        const item = (_data && _data.gear[c.id]) || _item(c.id) || {};
        const picture = _gridImage(c.id);
        let roundsMp = 0;
        _magLoads(c).forEach(function (load) { roundsMp += _mp(load[0]) * load[1]; });
        const el = _wtEnsureEl();
        el.innerHTML = '<div class="tab-preview-img-wrap arena-wt-mag-img">' +
            (picture ? '<img class="tab-preview-img" src="' + escapeHtml(picture) + '" alt="" onerror="this.remove()">' : '') + '</div>' +
            '<div class="tab-preview-gunname">' + escapeHtml(item.name || item.short_name || '') + '</div>' +
            _roundsListHtml(null, _magLoads(c), _magRounds(c) + '/' + _capacityOf(c.id)) +
            '<div class="arena-wt-meta"><span>' + escapeHtml(_t('arena:stats.priceView')) + '</span>' +
            '<span class="arena-meta">' + escapeHtml(EFTForge.arena.formatMeta(_carriedMeta(c))) + '</span></div>' +
            (roundsMp ? '<div class="arena-wt-meta-sub"><span>' + escapeHtml(_t('arena.wtRounds')) + '</span>' +
                '<span class="arena-meta">' + escapeHtml(EFTForge.arena.formatMeta(roundsMp)) + '</span></div>' : '');
        el.classList.add('visible');
        _wtPosition();
    }

    /**
     * A weapon's hover card: a loadout slot's (its key), or one the BlastGang shop or a
     * community preset card hands over (hoverWeapon): {weapon, picture, ammoId, names,
     * noRounds, noMeta, anchor}. `anchor`: the element it belongs to, for cards that can go
     * without a mouseleave (a dialog closing under the cursor).
     * @param {string | {weapon: any, picture?: string, ammoId?: string | null, names?: Object<string, string>, noRounds?: boolean, noMeta?: boolean, anchor?: Element}} target
     */
    async function _wtShow(target) {
        const spec = typeof target === 'string' ? (_loadout.weapons[target] ? { weapon: _loadout.weapons[target] } : null) : target;
        // A slot's key means the loadout on show; a handed over weapon shows anywhere
        if ((typeof target === 'string' && !_active) || !spec || !spec.weapon || _drag) return;
        if (spec.anchor && !spec.anchor.isConnected) return;
        const weapon = spec.weapon;
        const gen = ++_wtGen;
        if (typeof target !== 'string') {
            // A shop weapon's parts and rounds may not be loaded yet: its magazine's capacity
            // and the rounds' names come from them
            const ids = [weapon.gunId].concat((weapon.pairs || []).map(function (p) { return p[1]; }), weapon.ammoId ? [weapon.ammoId] : [],
                (Array.isArray(weapon.magLoads) ? weapon.magLoads : []).map(function (load) { return load[0]; }));
            try { await _ensurePoints(ids); } catch { /* shown with what we have */ }
            if (gen !== _wtGen) return;
        }
        const gun = (_data && _data.guns[weapon.gunId]) || _item(weapon.gunId) || {};
        const known = spec.picture !== undefined ? spec.picture : _drawings.get(_weaponKey(weapon));
        const working = known === 'working';
        const picture = typeof known === 'string' && !working ? known : working ? '' : (_gunPicture(weapon.gunId) || '');
        // The shop's guns fire what the shop sells them with, with full magazines
        const fires = spec.ammoId !== undefined ? spec.ammoId : _weaponAmmoId(weapon);
        const fullMag = spec.ammoId !== undefined ? !!spec.ammoId : _weaponMagRounds(weapon) > 0;
        const el = _wtEnsureEl();
        el.innerHTML = '<div class="tab-preview-img-wrap' + (working ? ' kb-working' : '') + '">' +
            (picture ? '<img class="tab-preview-img" src="' + escapeHtml(picture) + '" alt="">' : '') +
            (working && typeof _bpWorkingLogoHtml === 'function' ? _bpWorkingLogoHtml() : '') + '</div>' +
            '<div class="tab-preview-gunname">' + escapeHtml(gun.name || gun.short_name || '') + '</div>' +
            (spec.noRounds ? '' : _roundsListHtml(weapon.ammoId || null, _weaponLoads(weapon), _roundsText(weapon), spec.names)) +
            '<div class="stats-divider"></div>' +
            '<div class="tab-preview-stats"><div class="ammo-loading">' + escapeHtml(_t('armorSim.loading')) + '</div></div>' +
            (spec.noMeta ? '' : '<div class="arena-wt-meta"><span>' + escapeHtml(_t('arena:stats.priceView')) + '</span>' +
                '<span class="arena-meta">' + escapeHtml(EFTForge.arena.formatMeta(_weaponMeta(weapon).total)) + '</span></div>');
        el.classList.add('visible');
        _wtPosition();
        if (spec.anchor) _wtWatchAnchor(spec.anchor, gen);

        const statsKey = _weaponKey(weapon) + '|' + (fires || '') + (fullMag ? '' : '|e') + '|' + (EFTForge.state.currentStrengthLevel || 0) + '|' + (EFTForge.state.currentEquipErgoModifier || 0);
        let data = _wtStats.get(statsKey);
        if (!data) {
            try {
                data = await EFTForge.api.calculateBuild({
                    base_item_id: weapon.gunId,
                    attachment_ids: (weapon.pairs || []).map(function (p) { return p[1]; }),
                    assume_full_mag: fullMag,
                    selected_ammo_id: fires,
                    selected_ubgl_ammo_id: null,
                    strength_level: EFTForge.state.currentStrengthLevel,
                    equip_ergo_modifier: EFTForge.state.currentEquipErgoModifier,
                });
                _wtStats.set(statsKey, data);
            } catch (err) {
                console.warn('[arena-loadout] weapon stats:', err);
                data = null;
            }
        }
        if (gen !== _wtGen) return;
        const stats = el.querySelector('.tab-preview-stats');
        if (!stats) return;
        if (!data || typeof _tpStatsHtml !== 'function') {
            stats.innerHTML = '<div class="ammo-error">' + escapeHtml(_t('armorSim.loadError')) + '</div>';
        } else {
            stats.innerHTML = _tpStatsHtml(data);
            // The bars grow in, as the tab preview's do
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    if (gen !== _wtGen) return;
                    stats.querySelectorAll('.stat-bar-fill[data-target]').forEach(function (node) {
                        const fill = /** @type {HTMLElement} */ (node);
                        fill.style.width = fill.dataset.target + '%';
                    });
                });
            });
        }
        _wtPosition();
    }

    /**
     * The loadout's weapon hover card for a weapon of BlastGang's shop, at the cursor:
     * {weapon: {gunId, pairs, ...}, picture, ammoId, noRounds, noMeta}.
     * @param {any} spec
     * @param {number} x
     * @param {number} y
     * @param {number} [delay] how long the cursor has to rest first, in ms
     */
    function hoverWeapon(spec, x, y, delay) { _wtScheduleShow(spec, x, y, delay); }

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
        if (_previewing) return null;
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
        const fits = {};            // magazine id -> every weapon slot whose gun takes it
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
                    const weapon = _loadout.weapons[magSlots[slotId]];
                    (allowed[slotId] || []).forEach(function (item) {
                        // A magazine the rest of the gun rules out (a Mosin's AA762R with a
                        // wooden stock on) neither fits it nor shows in its magazine tab
                        if (weapon && _magConflicts(item, slotId, weapon, magSlots)) return;
                        if (!mags[item.id]) mags[item.id] = magSlots[slotId];
                        fits[item.id] = fits[item.id] || [];
                        if (fits[item.id].indexOf(magSlots[slotId]) === -1) fits[item.id].push(magSlots[slotId]);
                    });
                });
            }
        }
        _compat = { key: cacheKey, mags: mags, fits: fits, calibers: calibers, magSlots: magSlotByKey };
        return _compat;
    }

    function _idList(value) {
        if (Array.isArray(value)) return value;
        return typeof value === 'string' && value ? value.split(',') : [];
    }

    /**
     * Whether magazine `mag` (an allowed item row of magazine slot `slotId`) can't go on `weapon`
     * with the parts it has: either names the other as conflicting, the magazine rules out a slot
     * a part fills, or a part rules out the magazine's slot. Both ways round, since the data
     * often names a conflict on one side only (services/arena_preset_check.py weapon_conflicts).
     * The magazine it would replace doesn't count.
     * @param {any} mag
     * @param {string} slotId
     * @param {any} weapon
     * @param {Record<string, string>} magSlots
     */
    function _magConflicts(mag, slotId, weapon, magSlots) {
        const parts = (weapon.pairs || []).filter(function (p) { return !magSlots[p[0]]; });
        const installed = [weapon.gunId].concat(parts.map(function (p) { return p[1]; }));
        const itemsOut = new Set(_idList(mag.conflicting_item_ids));
        const slotsOut = new Set(_idList(mag.conflicting_slot_ids));
        if (parts.some(function (p) { return slotsOut.has(p[0]); })) return true;
        return installed.some(function (id) {
            if (itemsOut.has(id)) return true;
            const part = _item(id);
            if (!part) return false;
            return _idList(part.conflicting_ids).concat(_idList(part.conflicting_item_ids)).indexOf(mag.id) !== -1 ||
                _idList(part.conflicting_slot_ids).indexOf(slotId) !== -1;
        });
    }

    /** Whether magazine `magId` can go into the gun in weapon slot `key`: it fits, and the
     *  class may put it on that gun. */
    function _magFits(magId, key) {
        const weapon = _loadout.weapons[key];
        if (!weapon || !_compat || !_compat.fits || (_compat.fits[magId] || []).indexOf(key) === -1) return false;
        const mag = _item(magId);
        const gun = _item(weapon.gunId);
        return !mag || (EFTForge.arena.allowedForClass(mag) && (!gun || EFTForge.arena.allowedOnGun(mag, gun)));
    }

    function _pickGear(key, row) {
        // A helmet's headset from the earpiece list goes onto the helmet's mount
        if (key === 'Earpiece' && _isMountOnly(row.id)) {
            const helmet = _loadout.gear.Headwear;
            const mount = _mountSlotFor(row.id);
            if (!helmet || !mount) return;
            helmet.parts = helmet.parts || {};
            helmet.parts[mount] = row.id;
            _changed();
            return;
        }
        const worn = { id: row.id };
        const armor = _data.armor[row.id];
        if (armor) {
            // What the item comes with: its default plates and helmet attachments
            (armor.plate_slots || []).forEach(function (s) {
                if (s.default_id && _data.armor[s.default_id]) { worn.plates = worn.plates || {}; worn.plates[s.slot] = s.default_id; }
            });
            (armor.attachment_slots || []).forEach(function (s) {
                // A helmet's headset mount takes headsets, which aren't armor
                if (s.default_id && (_data.armor[s.default_id] || _data.gear[s.default_id])) { worn.parts = worn.parts || {}; worn.parts[s.slot] = s.default_id; }
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
        const weapon = { gunId: gun.id, pairs: pairs, ammoId: ammo ? ammo.id : null };
        // Put it on only once its points are in, so a board drawn meanwhile still shows the
        // slot as it was and the change sweeps it
        await _ensurePoints(_loadoutIds().concat([gun.id], pairs.map(function (p) { return p[1]; }), ammo ? [ammo.id] : []));
        _loadout.weapons[key] = weapon;
        _pick.target = { kind: 'slot', key: key };
        _changed();
    }

    function _editWeapon(key) {
        const weapon = _loadout.weapons[key];
        if (!weapon || typeof loadBuildFromPayload !== 'function') return;
        const editing = { cls: EFTForge.arena.classId(), key: key, tabId: _tabsOn() ? _tabId : null, ready: false };
        _editing = editing;
        Promise.resolve(loadBuildFromPayload({ g: weapon.gunId, p: weapon.pairs || [], a: _weaponAmmoId(weapon) }))
            .then(function () { editing.ready = true; syncEditedWeapon(); });
    }

    /** The builder's parts become the loadout weapon's on every change (no Save). Its rounds
     *  are the loadout's: they're loaded and unloaded there. */
    function syncEditedWeapon() {
        const state = EFTForge.state;
        if (!_editing || !_editing.ready || !state.currentGun || !state.buildTree || typeof collectSlotPairs !== 'function') return;
        _rememberBuilderItems(state.buildTree);
        if (_editing.tabId) {
            const loadout = EFTForge.tabs.arenaTabLoadout(_editing.tabId);
            const w = loadout && loadout.weapons[_editing.key];
            if (!w || !_takeGun(w, state.currentGun)) return;
            w.pairs = collectSlotPairs(state.buildTree);
            EFTForge.tabs.saveArenaTab(_editing.tabId, loadout);
            _syncBlob();
            return;
        }
        _load();
        const loadout = _store.byClass[_editing.cls];
        const weapon = loadout && loadout.weapons[_editing.key];
        if (!weapon || !_takeGun(weapon, state.currentGun)) return;
        weapon.pairs = collectSlotPairs(state.buildTree);
        _save();
        _syncBlob();
    }

    // Whether the loadout weapon `w` follows `gun`, the one open in the builder. A saved,
    // shared or community build of another gun loaded there replaces it when that gun fits
    // the slot; its rounds stay loaded while the caliber's the same.
    function _takeGun(w, gun) {
        if (w.gunId === gun.id) return true;
        const row = (_data && _data.guns[gun.id]) || gun;
        if (row.gear_slot && row.gear_slot !== SLOT_KIND[_editing.key]) return false;
        const fires = _weaponAmmoId(w);
        const ammo = fires ? _item(fires) : null;
        if (!ammo || ammo.caliber !== gun.caliber) {
            w.ammoId = null;
            delete w.magRounds;
            delete w.magLoads;
            delete w.magEmpty;
        }
        w.gunId = gun.id;
        _points[gun.id] = _points[gun.id] || row;
        return true;
    }

    /** The stats panel's Save to loadout: the build open in the builder goes back to its slot. */
    async function saveEditedWeapon() {
        const state = EFTForge.state;
        if (!_editing || !state.currentGun || typeof collectSlotPairs !== 'function') return;
        const ammoSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById('ammo-select'));
        const weapon = {
            gunId: state.currentGun.id,
            pairs: collectSlotPairs(state.buildTree),
            ammoId: ammoSelect && ammoSelect.value ? ammoSelect.value : null,
        };
        if (_editing.tabId) {
            const loadout = EFTForge.tabs.arenaTabLoadout(_editing.tabId);
            if (!loadout) return;
            loadout.weapons[_editing.key] = weapon;
            EFTForge.tabs.saveArenaTab(_editing.tabId, loadout);
        } else {
            _load();
            if (!_store.byClass[_editing.cls]) _store.byClass[_editing.cls] = _empty();
            _store.byClass[_editing.cls].weapons[_editing.key] = weapon;
            _save();
        }
        showToast(_t('arena.loadout'), _t('arena.savedToLoadout'), 2500, '#407d9b');
    }

    function _changed() {
        _save();
        if (!_active) return;
        // Only a change sweeps the slots it touched: the board drawn again for anything
        // else (a class switch, a finished drawing) doesn't
        const board = boardItems(document.getElementById('arena-board'));
        const carry = boardItems(document.getElementById('arena-carry'));
        _flashBefore = board || carry ? Object.assign({}, board, carry) : null;
        try {
            render();
        } finally {
            _flashBefore = null;
        }
    }

    function _wireLeft(left) {
        wireClassTabs(left);
    }

    // The class tabs sit under the page's buttons, outside the scrolling body, so the two rows
    // share their edges
    function _renderClassRow() {
        const box = document.getElementById('arena-class-tabs');
        if (!box) return;
        box.innerHTML = _classHtml();
        wireClassTabs(box);
        // The body's scrollbar room, which the button rows leave too (styles.css --arena-gutter)
        const body = document.getElementById('arena-left-body');
        const main = box.parentElement;
        if (body && main && body.offsetWidth) main.style.setProperty('--arena-gutter', (body.offsetWidth - body.clientWidth) + 'px');
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
        if (_flashBefore) _flashCarryChanges(_flashBefore, box);
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
        // Where it sits and what it is, for the slot flashes (_flashCarryChanges)
        el.dataset.carryKey = [c.where, c.grid, c.x, c.y, d[0], d[1]].join('|');
        el.dataset.carrySig = c.id + '|' + (c.count || 1) + '|' + JSON.stringify(_magLoads(c));
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
        if (gear.carry_kind === 'magazine' && gear.magazine_capacity) count = _magRounds(c) + '/' + gear.magazine_capacity;
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
        if (gear.carry_kind === 'magazine') {
            // A magazine shows what's in it on hover, as a weapon does
            el.addEventListener('mouseenter', function (e) { _wtScheduleShow({ mag: index }, e.clientX, e.clientY); });
            el.addEventListener('mousemove', function (e) { _wtMove(e.clientX, e.clientY); });
            el.addEventListener('mouseleave', _wtHide);
        } else {
            el.dataset.tooltip = item.name || '';
        }
        el.addEventListener('pointerdown', function (e) {
            _wtHide();
            _pressItem(e, {
                kind: 'carried', index: index, id: c.id, size: _sizeOf(c.id), r: c.r ? 1 : 0, grid: true,
                picture: _gridImage(c.id), fallback: gear.icon_link || '',
            });
        });
        el.addEventListener('click', function (e) {
            // Ctrl+click: a magazine goes into a gun it fits that has none; anything else (or a
            // magazine no gun wants) moves to the other container
            if (e.ctrlKey || e.metaKey) {
                e.stopPropagation();
                if (gear.carry_kind === 'magazine') _quickMag(c.id, index);
                else _quickMove(index);
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
            if (_weaponLoaded(weapon)) {
                entries.push({ icon: 'unload-ammo', label: _t('arena.menu.unloadAmmo'), run: function () { _unloadWeaponAmmo(key); } });
            }
            if (magIndex !== -1) {
                entries.push({ icon: 'unload', label: _t('arena.menu.unload'), run: function () { _unloadWeapon(key); } });
                entries.push({ icon: 'discard', label: _t('arena.menu.removeMag'), danger: true, run: function () {
                    weapon.pairs.splice(magIndex, 1);
                    delete weapon.magEmpty;
                    delete weapon.magRounds;
                    delete weapon.magLoads;
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

    /* Rounds. A magazine holds rounds in the order they went in, as the game's do: a different
       round goes on top of what's there. Its contents are "loads", [[ammo id, count], ...]
       from the bottom up.
       - A carried magazine: `ammoId` is its top round. One kind of round is just `ammoId` and
         `rounds` (none recorded: full); more than one is `loads`.
       - A weapon: `ammoId` is its chambered round. Its magazine holds `magRounds` of that same
         round (none recorded: full; the old `magEmpty` flag: none), or `magLoads` for anything
         else (mixed, or another round than the chambered one, or rounds with none chambered). */

    // Loads, cleaned: positive counts, neighbours of one round merged, `cap` rounds at most
    function _cleanLoads(loads, cap) {
        const out = [];
        let room = cap;
        (loads || []).forEach(function (load) {
            if (!Array.isArray(load) || !load[0] || room <= 0) return;
            const n = Math.min(room, Math.floor(Number(load[1]) || 0));
            if (n <= 0) return;
            room -= n;
            const top = out[out.length - 1];
            if (top && top[0] === load[0]) top[1] += n;
            else out.push([load[0], n]);
        });
        return out;
    }

    function _sumLoads(loads) {
        return loads.reduce(function (sum, load) { return sum + load[1]; }, 0);
    }

    // A carried magazine's loads, bottom up
    function _magLoads(c) {
        if (!c) return [];
        const cap = _capacityOf(c.id);
        if (Array.isArray(c.loads)) return _cleanLoads(c.loads, cap);
        if (!c.ammoId) return [];
        return _cleanLoads([[c.ammoId, typeof c.rounds === 'number' ? c.rounds : cap]], cap);
    }

    function _setMagLoads(c, loads) {
        const cap = _capacityOf(c.id);
        const clean = _cleanLoads(loads, cap);
        delete c.rounds;
        delete c.loads;
        if (!clean.length) {
            c.ammoId = null;
            return;
        }
        c.ammoId = clean[clean.length - 1][0];
        if (clean.length > 1) c.loads = clean;
        else if (clean[0][1] < cap) c.rounds = clean[0][1];
    }

    // Rounds in a carried magazine
    function _magRounds(c) {
        return _sumLoads(_magLoads(c));
    }

    // A carried magazine holding `n` of `ammoId` and nothing else (none: empty)
    function _setMagRounds(c, ammoId, n) {
        _setMagLoads(c, ammoId && n > 0 ? [[ammoId, Math.min(n, _capacityOf(c.id))]] : []);
    }

    // A weapon's magazine loads, bottom up, for a magazine of `capacity`
    function _weaponLoadsOf(w, capacity) {
        if (!w || !capacity) return [];
        if (Array.isArray(w.magLoads)) return _cleanLoads(w.magLoads, capacity);
        if (!w.ammoId || w.magEmpty) return [];
        return _cleanLoads([[w.ammoId, typeof w.magRounds === 'number' ? w.magRounds : capacity]], capacity);
    }

    function _weaponCap(weapon) {
        const mag = _weaponMagIn(weapon);
        return mag ? _capacityOf(mag) : 0;
    }

    function _weaponLoads(weapon) {
        return _weaponLoadsOf(weapon, _weaponCap(weapon));
    }

    function _weaponMagRounds(weapon) {
        return _sumLoads(_weaponLoads(weapon));
    }

    // A weapon with `chamberId` chambered (none: empty chamber) and `loads` in its magazine
    function _setWeaponLoads(weapon, chamberId, loads) {
        const cap = _weaponCap(weapon);
        const clean = _cleanLoads(loads, cap);
        delete weapon.magEmpty;
        delete weapon.magRounds;
        delete weapon.magLoads;
        weapon.ammoId = chamberId || null;
        if (!clean.length) {
            if (chamberId && cap) weapon.magRounds = 0;
            return;
        }
        if (clean.length === 1 && clean[0][0] === chamberId) {
            if (clean[0][1] < cap) weapon.magRounds = clean[0][1];
            return;
        }
        weapon.magLoads = clean;
    }

    // The round a weapon fires next: its chambered one, else its magazine's top one
    function _weaponAmmoId(weapon) {
        if (!weapon) return null;
        if (weapon.ammoId) return weapon.ammoId;
        const loads = _weaponLoads(weapon);
        return loads.length ? loads[loads.length - 1][0] : null;
    }

    // Whether a weapon holds any rounds
    function _weaponLoaded(weapon) {
        return !!weapon && (!!weapon.ammoId || _weaponMagRounds(weapon) > 0);
    }

    // What a weapon holds, the chamber counted, as the game's slot shows it: 31/31 for a loaded
    // 30 round magazine, 0/31 unloaded, 1/1 with just a round chambered
    function _roundsText(weapon) {
        const max = _weaponCap(weapon) + 1;
        const loaded = (weapon.ammoId ? 1 : 0) + _weaponMagRounds(weapon);
        return loaded + '/' + max;
    }

    function _weaponMagIn(weapon) {
        const index = _magPairIndex(weapon);
        return index === -1 ? null : weapon.pairs[index][1];
    }

    // Take `count` rounds from a carried stack (it goes once empty)
    function _takeAmmo(index, count) {
        const stack = _loadout.carried[index];
        if (!stack) return;
        stack.count = (stack.count || 1) - count;
        if (stack.count <= 0) _loadout.carried.splice(index, 1);
    }

    // Unload ammo on a carried magazine empties it; like a weapon's, the rounds are gone, not
    // put in the rig or pockets
    function _unloadMagAmmo(index) {
        const c = _loadout.carried[index];
        if (!c || !_magRounds(c)) return;
        _setMagLoads(c, []);
        _changed();
    }

    // Unload ammo on a weapon empties its magazine and chamber; the rounds are gone, not put in
    // the rig or pockets
    function _unloadWeaponAmmo(key) {
        const weapon = _loadout.weapons[key];
        if (!_weaponLoaded(weapon)) return;
        _setWeaponLoads(weapon, null, []);
        _changed();
    }

    // Rounds onto a carried magazine: on top of what it holds, as many as the stack has and the
    // magazine has room for (from the list, to full)
    function _loadMag(magIndex, ammoId, stackIndex) {
        const mag = _loadout.carried[magIndex];
        if (!mag) return;
        const loads = _magLoads(mag);
        const stack = stackIndex != null ? _loadout.carried[stackIndex] : null;
        const take = Math.min(_capacityOf(mag.id) - _sumLoads(loads), stack ? stack.count || 1 : Infinity);
        if (!(take > 0)) return;
        _setMagLoads(mag, loads.concat([[ammoId, take]]));
        if (stack) _takeAmmo(stackIndex, take);
        _changed();
    }

    // Rounds onto a weapon: an empty chamber first, then on top of its magazine, as many as the
    // stack has and there's room for (from the list, to full)
    function _loadWeaponAmmo(key, ammoId, stackIndex) {
        const weapon = _loadout.weapons[key];
        if (!weapon) return;
        const loads = _weaponLoads(weapon);
        const stack = stackIndex != null ? _loadout.carried[stackIndex] : null;
        let left = stack ? stack.count || 1 : Infinity;
        let used = 0;
        let chamber = weapon.ammoId || null;
        if (!chamber && left > 0) {
            chamber = ammoId;
            left -= 1;
            used += 1;
        }
        const into = Math.min(_weaponCap(weapon) - _sumLoads(loads), left);
        if (into > 0) {
            loads.push([ammoId, into]);
            used += into;
        }
        if (!(used > 0)) return;
        _setWeaponLoads(weapon, chamber, loads);
        if (stack) _takeAmmo(stackIndex, used);
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
            if (!(gun && gun.caliber === caliber)) return false;
            return !weapon.ammoId || _weaponMagRounds(weapon) < _weaponCap(weapon);
        });
        if (weaponKey) {
            _loadWeaponAmmo(weaponKey, row.id, null);
            return;
        }
        const order = { rig: 0, pockets: 1 };
        const empty = _loadout.carried.map(function (c, index) { return { c: c, index: index }; })
            .filter(function (x) { return x.c.where && !x.c.ammoId && _capacityOf(x.c.id) > 0 && _magCaliber(x.c.id) === caliber; })
            .sort(function (a, b) {
                return order[a.c.where] - order[b.c.where] || a.c.grid - b.c.grid || a.c.y - b.c.y || a.c.x - b.c.x;
            });
        if (empty.length) {
            _setMagRounds(empty[0].c, row.id, Infinity);
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
        const loads = _weaponLoads(weapon);
        const chamber = weapon.ammoId || null;
        weapon.pairs.splice(magIndex, 1);
        const out = Object.assign({ id: magId, count: 1 }, spot);
        _setMagLoads(out, loads);
        _loadout.carried.push(out);
        // The chambered round stays
        _setWeaponLoads(weapon, chamber, []);
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

    /**
     * Ctrl+click on a magazine: into the first gun (sling, back, holster) it fits that has no
     * magazine, with its rounds if it's carried and loaded. Else what Ctrl+click does
     * otherwise: a carried one moves to the other container, one from the list is added.
     * @param {string} magId
     * @param {number|null} carriedIndex
     * @param {any} [row] the list's row, for a magazine from the list
     */
    async function _quickMag(magId, carriedIndex, row) {
        try { await _carryCompat(); } catch (err) { console.warn('[arena-loadout] magazine fit:', err); }
        const key = WEAPON_SLOTS.find(function (k) {
            const weapon = _loadout.weapons[k];
            return !!weapon && _magPairIndex(weapon) === -1 && _magFits(magId, k);
        });
        if (key) {
            _magIntoWeapon(key, magId, carriedIndex);
            return;
        }
        if (carriedIndex != null) _quickMove(carriedIndex);
        else if (row) _addCarried(row);
    }

    // A carried magazine into the weapon in `key`
    function _loadMagazine(index, key) {
        const c = _loadout.carried[index];
        if (!c || !_magFits(c.id, key)) return false;
        return _magIntoWeapon(key, c.id, index);
    }

    /**
     * Magazine `magId` into the weapon in `key`, from the carried item at `carriedIndex` or,
     * without one, new from the list (empty). The magazine it replaces goes into the rig or
     * pockets with the weapon's rounds: where the new one was, else the first free spot; with
     * no room for it, nothing changes.
     */
    function _magIntoWeapon(key, magId, carriedIndex) {
        const weapon = _loadout.weapons[key];
        if (!weapon || !_magFits(magId, key)) return false;
        const slotId = _compat.magSlots ? _compat.magSlots[key] : null;
        const magIndex = _magPairIndex(weapon);
        const old = magIndex !== -1 ? weapon.pairs[magIndex] : null;
        if (!old && !slotId) return false;
        const c = carriedIndex != null ? _loadout.carried[carriedIndex] : null;
        const spot = c ? { where: c.where, grid: c.grid, x: c.x, y: c.y, r: c.r } : null;
        // The rounds in the magazine going in, and in the one coming out
        const loads = c ? _magLoads(c) : [];
        const oldLoads = _weaponLoads(weapon);
        let back = null;
        if (old) {
            // Where the old magazine goes, worked out with the new one already out of the way
            const taken = _taken(carriedIndex != null ? carriedIndex : -1);
            const size = _sizeOf(old[1]);
            back = spot && spot.where && _free(taken, spot.where, spot.grid, spot.x, spot.y, size[0], size[1]) ? Object.assign({}, spot, { r: 0 })
                : spot && spot.where && _free(taken, spot.where, spot.grid, spot.x, spot.y, size[1], size[0]) ? Object.assign({}, spot, { r: 1 })
                    : _findSpot(taken, old[1], ['rig', 'pockets']);
            if (!back) {
                replaceToast('arena-room', _t('arena.loadout'), _t('arena.noRoom'));
                return false;
            }
        }
        if (carriedIndex != null) _loadout.carried.splice(carriedIndex, 1);
        if (old) {
            weapon.pairs[magIndex] = [old[0], magId];
            const out = Object.assign({ id: old[1], count: 1 }, back);
            _setMagLoads(out, oldLoads);
            _loadout.carried.push(out);
        } else {
            weapon.pairs.push([slotId, magId]);
        }
        // The chambered round stays; a gun with none chambers the new magazine's top round, as
        // the game's presets count a loaded magazine and a chambered round. An empty magazine
        // leaves just what's chambered.
        const chamber = weapon.ammoId || (loads.length ? loads[loads.length - 1][0] : null);
        _setWeaponLoads(weapon, chamber, loads);
        _changed();
        return true;
    }

    /* ---- Drag and drop ---- */

    let _drag = null;          // {kind, index | row, w, h, r, x0, y0, started, ghost, over}
    let _swallowClick = false;

    function _pressItem(e, info) {
        if (e.button !== 0 || e.altKey) return;
        // Ctrl+drag on a carried stack, or on a stackable item in the list, splits it, as in the
        // game (a Ctrl+click that doesn't move still does what Ctrl+click does); Ctrl does
        // nothing else here
        let split = false;
        if (e.ctrlKey || e.metaKey) {
            if (!_splittable(info)) return;
            split = true;
        }
        _drag = Object.assign({ x0: e.clientX, y0: e.clientY, started: false, r: 0, split: split }, info);
        window.addEventListener('pointermove', _dragMove);
        window.addEventListener('pointerup', _dragEnd);
        window.addEventListener('keydown', _dragKey);
        window.addEventListener('keyup', _dragKey);
    }

    // How many of an item the list hands over at once: a whole stack of rounds, else one
    // (as _addCarried adds them)
    function _listCount(row) {
        return row && row.carry_kind === 'ammo' ? (row.stack_max_size || 30) : 1;
    }

    // The stack a drag carries: a carried one, or one the list hands over ({id, count})
    function _dragStack(drag) {
        if (!drag) return null;
        if (drag.kind === 'carried') return _loadout.carried[drag.index] || null;
        if (drag.kind === 'card' && drag.row && drag.row.carry_kind && EFTForge.arena.allowedForClass(drag.row)) {
            return { id: drag.row.id, count: _listCount(drag.row) };
        }
        return null;
    }

    // Whether a drag can be a split: a stack of more than one, carried or from the list
    function _splittable(drag) {
        const c = _dragStack(drag);
        return !!c && (c.count || 1) > 1;
    }

    function _canSplit() {
        return _splittable(_drag);
    }

    // Ctrl is read through the whole drag, as the game's GridView.CanAccept reads it every frame:
    // held over a free spot or a stack of the same item, the drop moves part of the stack
    // (TarkTetris drag.js partial())
    function _setSplit(on) {
        const split = !!on && _canSplit();
        if (split === !!_drag.split) return false;
        _drag.split = split;
        return true;
    }

    // How many of a stack fit in one: its stack size (stack_max_size). Only rounds come with
    // one, so anything without it (magazines, meds, grenades) doesn't stack at all
    function _stackMax(id) {
        const item = (_data && _data.gear[id]) || _item(id) || {};
        return item.stack_max_size > 0 ? item.stack_max_size : 1;
    }

    /**
     * What dropping carried stack `c` onto carried stack `t` does (TarkTetris dropOnItem): with
     * Ctrl, a transfer of as many as fit, never the whole stack; without, a merge when it all
     * fits, else the same transfer. {type: 'merge' | 'transfer', count} or null.
     */
    function _stackDrop(c, t, partial) {
        if (!c || !t || c === t || c.id !== t.id) return null;
        const room = _stackMax(t.id) - (t.count || 1);
        const count = c.count || 1;
        if (!partial && count <= room) return { type: 'merge', count: count };
        // A split or transfer never takes the whole stack (ItemManipulator.GetMaxSplitCount),
        // the list's included, as in the game
        const n = Math.min(count - 1, room);
        return n > 0 ? { type: 'transfer', count: n } : null;
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

    // The board slot a picker row would be installed in, for its ghost's size: a weapon's
    // holster or sling, a worn item's own slot (the rig's sits beside the rig and pockets)
    function _slotBodyFor(row) {
        const key = row.gear_slot === 'Primary' ? 'FirstPrimaryWeapon' : row.gear_slot;
        if (!key) return null;
        return document.querySelector('#arena-board [data-arena-key="' + key + '"] .bw-slot-body, #arena-carry [data-arena-key="' + key + '"] .bw-slot-body');
    }

    // The ghost is the item at full size, as TarkTetris draws a dragged item at its size in the
    // inventory: a grid item at the grids' cell size, anything else (weapons, worn gear) as big
    // as it shows installed, the size of its loadout slot (a card's picture when it has none)
    function _sizeGhost() {
        const d = _dragSize();
        const cell = CELL * CARRY_SCALE;
        const from = !_drag.grid && _drag.source ? _drag.source.getBoundingClientRect() : null;
        const w = _drag.grid ? d[0] * cell : from && from.width > 0 ? Math.max(48, from.width) : 110;
        const h = _drag.grid ? d[1] * cell : from && from.height > 0 ? Math.max(48, from.height) : 70;
        _drag.ghost.style.width = w + 'px';
        _drag.ghost.style.height = h + 'px';
        const size = _drag.size;
        _drag.img.style.width = (_drag.grid ? size[0] * cell : w) + 'px';
        _drag.img.style.height = (_drag.grid ? size[1] * cell : h) + 'px';
        _drag.img.style.transform = _drag.grid && _drag.r ? 'rotate(90deg)' : '';
    }

    function _dragKey(e) {
        if (!_drag || !_drag.started || !_drag.grid) return;
        if (e.key === 'Control' || e.key === 'Meta') {
            if (_setSplit(e.type === 'keydown')) _dragOver(_drag.lastX, _drag.lastY);
            return;
        }
        if (e.type !== 'keydown') return;
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
        _setSplit(e.ctrlKey || e.metaKey);
        const rect = _drag.ghost.getBoundingClientRect();
        _drag.ghost.style.left = (e.clientX - rect.width / 2) + 'px';
        _drag.ghost.style.top = (e.clientY - rect.height / 2) + 'px';
        _dragOver(e.clientX, e.clientY);
    }

    function _clearOver() {
        document.querySelectorAll('.arena-drop-mark').forEach(function (node) { node.remove(); });
        document.querySelectorAll('.arena-drop-ok, .arena-drop-bad, .arena-drop-split').forEach(function (node) { node.classList.remove('arena-drop-ok', 'arena-drop-bad', 'arena-drop-split'); });
    }

    // What's under the cursor and whether the dragged item can go there, marked green or red
    // The carried item a drag leaves behind, whose cells it may land on: none for a split,
    // whose stack stays where it is
    function _dragSkip() {
        return _drag.kind === 'carried' && !_drag.split ? _drag.index : -1;
    }

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
        // A stack onto another of the same item merges or transfers into it, yellow as in the
        // game; red when it has no room
        if (itemEl && (_drag.kind === 'carried' || _drag.kind === 'card')) {
            const index = Number(itemEl.dataset.index);
            const c = _dragStack(_drag);
            const t = _loadout.carried[index];
            if (c && t && !(_drag.kind === 'carried' && index === _drag.index) && c.id === t.id) {
                const op = _stackDrop(c, t, !!_drag.split);
                itemEl.classList.add(op ? 'arena-drop-split' : 'arena-drop-bad');
                if (op) _drag.over = { type: 'stack', index: index };
                return;
            }
        }
        const caliber = _dragAmmoCaliber();
        if (itemEl && caliber) {
            const index = Number(itemEl.dataset.index);
            const target = _loadout.carried[index];
            const isMag = target && _capacityOf(target.id) > 0 && !(_drag.kind === 'carried' && _drag.index === index);
            if (isMag) {
                // Not when it's already full
                const ok = _magCaliber(target.id) === caliber && _magRounds(target) < _capacityOf(target.id);
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
            const px = (x - rect.left) / scale;
            const py = (y - rect.top) / scale;
            // Only over the cells themselves: the grid is drawn a pixel wider and taller than
            // them, for the last cell's border, and that pixel isn't a place to drop
            if (px < 0 || py < 0 || px >= g[0] * CELL || py >= g[1] * CELL) return;
            const d = _dragSize();
            // The item hangs centered on the cursor; its top left cell is where it lands
            const cx = Math.round((px - d[0] * CELL / 2) / CELL);
            const cy = Math.round((py - d[1] * CELL / 2) / CELL);
            const ok = _free(_taken(_dragSkip()), where, grid, cx, cy, d[0], d[1]);
            // The footprint, clipped to the grid as the game's highlight is (TarkTetris drag.js)
            const x0 = Math.max(0, Math.min(g[0], cx));
            const y0 = Math.max(0, Math.min(g[1], cy));
            const x1 = Math.max(0, Math.min(g[0], cx + d[0]));
            const y1 = Math.max(0, Math.min(g[1], cy + d[1]));
            if (x1 > x0 && y1 > y0) {
                const mark = document.createElement('div');
                // Yellow where the drop splits the stack
                mark.className = 'arena-drop-mark ' + (ok ? (_drag.split ? 'is-split' : 'is-ok') : 'is-bad');
                mark.style.left = (x0 * CELL) + 'px';
                mark.style.top = (y0 * CELL) + 'px';
                mark.style.width = ((x1 - x0) * CELL + 1) + 'px';
                mark.style.height = ((y1 - y0) * CELL + 1) + 'px';
                gridEl.appendChild(mark);
            }
            if (ok) _drag.over = { type: 'cell', spot: { where: where, grid: grid, x: cx, y: cy, r: _drag.r } };
            return;
        }
        const area = /** @type {HTMLElement | null} */ (under.closest('.arena-carry-area'));
        if (area && _drag.grid) {
            const where = area.dataset.where;
            const spot = _findSpot(_taken(_dragSkip()), _drag.id, [where]);
            area.classList.add(spot ? (_drag.split ? 'arena-drop-split' : 'arena-drop-ok') : 'arena-drop-bad');
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
            if (!gun || gun.caliber !== caliber) return false;
            // Not when it's already full
            return !(weapon.ammoId && _weaponMagRounds(weapon) >= _weaponCap(weapon));
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
            // A magazine onto a weapon it fits
            const c = _loadout.carried[_drag.index];
            return !!c && _magFits(c.id, key);
        }
        const row = _drag.row;
        if (!row || !EFTForge.arena.allowedForClass(row)) return false;
        // A magazine from the list goes into a weapon it fits, never into a gear slot
        if (row.carry_kind === 'magazine') return WEAPON_SLOTS.indexOf(key) !== -1 && _magFits(row.id, key);
        const parts = key.split(':');
        if (parts.length === 3) {
            return _insertAllowed(key).indexOf(row.id) !== -1 && !_gearConflict(row.id, parts[0], (parts[1] === 'plate' ? 'plates:' : 'parts:') + parts[2]);
        }
        if (WEAPON_SLOTS.indexOf(key) !== -1) return !!_data.guns[row.id] && row.gear_slot === SLOT_KIND[key];
        if (row.gear_slot !== key) return false;
        return key === 'Scabbard' || !_gearConflict(row.id, key);
    }

    function _dragEnd() {
        window.removeEventListener('pointermove', _dragMove);
        window.removeEventListener('pointerup', _dragEnd);
        window.removeEventListener('keydown', _dragKey);
        window.removeEventListener('keyup', _dragKey);
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
        if (over.type === 'stack') {
            if (drag.kind === 'card') _listOnStack(drag.row, over.index, !!drag.split);
            else _dropOnStack(drag.index, over.index, !!drag.split);
            return;
        }
        if (drag.split && over.type === 'cell') {
            if (drag.kind === 'card') _listSplitAt(drag.row, over.spot);
            else _splitAt(drag.index, over.spot);
            return;
        }
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
            if (row.carry_kind === 'magazine') _magIntoWeapon(key, row.id, null);
            else _pickWeapon(key, row);
        } else {
            _pickGear(key, row);
        }
    }

    /* ---- Splitting a stack ----
       A port of TarkTetris' split (src/ui/split.js, src/engine/stacks.js), which follows the
       game's SplitDialog, StepSlider and ItemManipulator:
       - Ctrl+drop on a free spot splits off up to min(count - 1, stack size); on a stack of the
         same item it transfers up to min(count - 1, room in it). More than one opens the
         dialog (SPLIT or TRANSFER), exactly one just moves.
       - From the item list, Ctrl+drag a stackable item: the list hands over a whole stack and
         it splits like any other (1..one less than it, or the room in the stack it's dropped
         on), through the same dialog.
       - The dialog is a modal from the site's modal factory (_createModalOverlay), centred as
         every modal is. Values 1..max starting at max / 2 + 1, the value field focused. The
         slider has at most 24 notches of ceil(max / 24) and snaps to them; typing clamps to
         1..max and moves the slider to the closest notch. As in the game, after it opens or
         after typing the handle sits one notch left of the value (TarkTetris copies that as
         is, so we do too).
       - Enter or Accept accepts; Escape, Cancel, the close button or the backdrop cancels. */

    const SPLIT_SLIDER = 220;
    const SPLIT_HANDLE = 14;
    let _splitEl = null;
    let _splitState = null;

    // StepSlider.Show: the notch values and the slider's range
    function _stepSlider(max) {
        const one = Math.ceil(max / 24);
        let num = 24;
        if (Math.trunc(max / one) < 24) num = Math.ceil(max / one);
        const flag = one === 1;
        const values = [];
        for (let i = flag ? 1 : 0; i < num; i++) values.push(Math.max(1, Math.ceil(one * i)));
        values.push(Math.max(1, max));
        return { values: values, notches: values.length - 1, sliderMax: flag ? num : num + 1 };
    }

    // StepSlider.GetIndexOfClosest: the closest value's 0-based index (ties to the later), or the
    // count when value >= max
    function _indexOfClosest(values, value, max) {
        if (value >= max) return values.length;
        let best = values[0];
        values.slice(1).forEach(function (v) { best = Math.abs(best - value) >= Math.abs(v - value) ? v : best; });
        return values.indexOf(best);
    }

    const SPLIT_DIALOG = 'arena-split-dialog';

    function _closeSplit() {
        if (!_splitEl) return null;
        const st = _splitState;
        _splitEl.remove();
        _splitEl = null;
        _splitState = null;
        document.removeEventListener('keydown', _splitKey, true);
        return st;
    }

    function _splitAccept() {
        const st = _closeSplit();
        if (st) st.onAccept(st.value);
    }

    function _splitKey(e) {
        if (!_splitEl) return;
        // The modal's own close button or backdrop took it away: nothing left to listen for
        if (!_splitEl.isConnected) {
            _closeSplit();
            return;
        }
        if (e.isComposing) return;
        if (e.code === 'Enter' || e.code === 'NumpadEnter') {
            e.preventDefault();
            e.stopPropagation();
            _splitAccept();
        } else if (e.code === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            _closeSplit();
        }
    }

    /**
     * The split dialog, a modal from the site's modal factory (utils.js _createModalOverlay).
     * title: 'split' | 'transfer'; max: the most that can move; onAccept(count).
     */
    function _showSplit(title, max, onAccept) {
        _closeSplit();
        const overlay = _createModalOverlay(SPLIT_DIALOG, escapeHtml(_t('arena.split.' + title)), { maxWidth: '380px' });
        if (!overlay) return;
        const s = _stepSlider(max);
        const st = { max: max, s: s, slider: 1, value: 0, onAccept: onAccept };
        const notches = Array.from({ length: s.notches + 1 }, function (_, i) {
            return '<div class="arena-split-notch" style="left:' + (i * SPLIT_SLIDER / Math.max(1, s.notches)) + 'px"></div>';
        }).join('');
        document.getElementById(SPLIT_DIALOG + '-body').innerHTML = '<div class="modal-section">' +
            '<div class="arena-split-body">' +
            '<div class="arena-split-slider" style="width:' + SPLIT_SLIDER + 'px">' +
            '<div class="arena-split-track">' + notches + '</div>' +
            '<div class="arena-split-handle"></div></div>' +
            '<input class="search-input arena-split-input" type="text" inputmode="numeric"></div>' +
            '<div class="modal-row arena-split-actions">' +
            '<button type="button" class="modal-btn full-width arena-split-cancel">' + escapeHtml(_t('ui.cancel')) + '</button>' +
            '<button type="button" class="modal-btn primary full-width arena-split-accept">' + escapeHtml(_t('arena.split.accept')) + '</button>' +
            '</div></div>';
        const area = /** @type {HTMLElement} */ (overlay.querySelector('.arena-split-slider'));
        const handle = /** @type {HTMLElement} */ (overlay.querySelector('.arena-split-handle'));
        const input = /** @type {HTMLInputElement} */ (overlay.querySelector('.arena-split-input'));

        const setSlider = function (v) {
            st.slider = Math.max(1, Math.min(s.sliderMax, v));
            handle.style.left = (((st.slider - 1) / Math.max(1, s.sliderMax - 1)) * SPLIT_SLIDER - SPLIT_HANDLE / 2) + 'px';
        };
        // StepSlider.SetCurrentValue
        const setValue = function (real, sliderValue) {
            setSlider(sliderValue);
            st.value = Math.max(1, Math.min(max, real));
            if (input.value !== String(st.value)) input.value = String(st.value);
        };
        // Slider.onValueChanged: realValues[value - 1]
        const fromSlider = function (v) {
            setSlider(v);
            const real = s.values[st.slider - 1];
            if (real !== st.value) setValue(real, st.slider);
        };
        const pointerToSlider = function (e) {
            const b = area.getBoundingClientRect();
            const k = Math.max(0, Math.min(1, (e.clientX - b.left) / b.width));
            fromSlider(Math.round(1 + k * (s.sliderMax - 1)));
        };
        area.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            pointerToSlider(e);
            const move = function (ev) { pointerToSlider(ev); };
            const up = function () { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
        });
        // Digits only: anything else typed is refused, and pasted text keeps just its digits
        input.addEventListener('beforeinput', function (e) {
            if (e.data && /\D/.test(e.data) && e.inputType === 'insertText') e.preventDefault();
        });
        // The value field: onValueChanged and onEndEdit
        input.addEventListener('input', function () {
            if (/\D/.test(input.value)) input.value = input.value.replace(/\D/g, '');
            let n = parseInt(input.value, 10);
            if (Number.isNaN(n)) n = 1;
            if (n === st.value) return;
            n = Math.max(1, Math.min(max, n));
            setValue(n, _indexOfClosest(s.values, n, max));
            input.value = String(n);
        });
        input.addEventListener('blur', function () { input.value = String(st.value); });
        overlay.querySelector('.arena-split-cancel').addEventListener('click', function () { _closeSplit(); });
        overlay.querySelector('.arena-split-accept').addEventListener('click', _splitAccept);

        _splitEl = overlay;
        _splitState = st;
        document.addEventListener('keydown', _splitKey, true);

        // Show: SetCurrentValue(max / 2 + 1, the closest notch); the slider callback runs first
        const start = Math.trunc(max / 2) + 1;
        const index = _indexOfClosest(s.values, start, max);
        fromSlider(index);
        setValue(start, index);
        input.focus();
        input.select();
    }

    // Ctrl+drop on a free spot: SplitMax, through the dialog when more than one can go
    function _splitAt(index, spot) {
        const c = _loadout.carried[index];
        if (!c) return;
        const most = Math.min((c.count || 1) - 1, _stackMax(c.id));
        if (most <= 0) return;
        const split = function (n) {
            // SplitExact: exactly n, if the stack and the spot still allow it
            if (_loadout.carried.indexOf(c) === -1 || !(n > 0 && (c.count || 1) - n > 0)) return;
            const size = _sizeOf(c.id);
            const d = spot.r ? [size[1], size[0]] : size;
            if (!_free(_taken(-1), spot.where, spot.grid, spot.x, spot.y, d[0], d[1])) {
                replaceToast('arena-room', _t('arena.loadout'), _t('arena.noRoom'));
                return;
            }
            c.count -= n;
            _loadout.carried.push(Object.assign({ id: c.id, count: n }, spot));
            _changed();
        };
        if (most > 1) _showSplit('split', most, split);
        else split(1);
    }

    // Ctrl+drop from the list on a free spot: SplitMax of the stack the list hands over, so
    // 1..one less than it, as the game's preset editor does
    function _listSplitAt(row, spot) {
        const most = Math.min(_listCount(row) - 1, _stackMax(row.id));
        if (most <= 0 || !EFTForge.arena.allowedForClass(row)) return;
        const add = function (n) {
            const size = _sizeOf(row.id);
            const d = spot.r ? [size[1], size[0]] : size;
            if (!(n > 0) || !_free(_taken(-1), spot.where, spot.grid, spot.x, spot.y, d[0], d[1])) {
                replaceToast('arena-room', _t('arena.loadout'), _t('arena.noRoom'));
                return;
            }
            _loadout.carried.push(Object.assign({ id: row.id, count: n }, spot));
            _changed();
        };
        if (most > 1) _showSplit('split', most, add);
        else add(1);
    }

    // The list's item onto a carried stack of it: a merge, or as many as it has room for; with
    // Ctrl, how many through the dialog
    function _listOnStack(row, toIndex, partial) {
        const t = _loadout.carried[toIndex];
        const op = _stackDrop({ id: row.id, count: _listCount(row) }, t, partial);
        if (!op || !EFTForge.arena.allowedForClass(row)) return;
        const top = function (n) {
            if (_loadout.carried.indexOf(t) === -1) return;
            const room = _stackMax(t.id) - (t.count || 1);
            if (!(n > 0) || n > room) return;
            t.count = (t.count || 1) + n;
            _changed();
        };
        if (partial && op.count > 1) _showSplit('transfer', op.count, top);
        else top(op.count);
    }

    // A stack onto another of the same item: merge or transfer (TarkTetris dropOnItem); with
    // Ctrl the transfer goes through the dialog when more than one can go
    function _dropOnStack(fromIndex, toIndex, partial) {
        const c = _loadout.carried[fromIndex];
        const t = _loadout.carried[toIndex];
        const op = _stackDrop(c, t, partial);
        if (!op) return;
        if (op.type === 'merge') {
            t.count = (t.count || 1) + (c.count || 1);
            _loadout.carried.splice(fromIndex, 1);
            _changed();
            return;
        }
        const transfer = function (n) {
            // TransferExact: exactly n, if both stacks still allow it
            if (_loadout.carried.indexOf(c) === -1 || _loadout.carried.indexOf(t) === -1) return;
            const now = _stackDrop(c, t, true);
            if (!now || now.count < n) return;
            c.count -= n;
            t.count = (t.count || 1) + n;
            _changed();
        };
        if (partial && op.count > 1) _showSplit('transfer', op.count, transfer);
        else transfer(op.count);
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
        right.innerHTML = _tabsHtml() +
            '<div class="att-table-header arena-pick-head"><h3>' + (list.slot && list.slot !== 'load' ? escapeHtml(_t('arena.selectFor')) + '<strong>' + escapeHtml(list.title) + '</strong>' : '<strong>' + escapeHtml(list.title) + '</strong>') + '</h3></div>' +
            '<div class="arena-wpick">' +
            '<div class="arena-wtypes" role="group">' + list.filters.map(filterButton).join('') + '</div>' +
            '<div class="arena-wpick-main">' +
            '<input type="text" id="arena-picker-search" class="search-input" placeholder="' + escapeHtml(_t('arena.searchPlaceholder')) + '" value="' + escapeHtml(_pick.search) + '">' +
            (rows.length ? '<div class="' + (list.weapons ? 'arena-wgrid' : 'arena-igrid') + '">' + cards + '</div>' : '<div class="ammo-no-results">' + escapeHtml(list.empty) + '</div>') +
            '</div></div>';

        _wireTabs(right);
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
                    source: carry ? null : _slotBodyFor(row) || card.querySelector('img'),
                });
            });
            card.addEventListener('click', function (e) {
                if (!row || !arena.allowedForClass(row) || (row.id === list.current && !list.repeatable)) return;
                // Ctrl+click on rounds loads what's empty first, a stack once everything's full
                if ((e.ctrlKey || e.metaKey) && row.carry_kind === 'ammo' && list.slot !== 'load') {
                    _quickLoadAmmo(row);
                    return;
                }
                // Ctrl+click on a magazine puts it in a gun it fits that has none first
                if ((e.ctrlKey || e.metaKey) && row.carry_kind === 'magazine') {
                    _quickMag(row.id, null, row);
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
                    // A helmet's headset mount lists the headsets made for it (/arena/items rows)
                    rows: _insertAllowed(slotKey).map(function (id) { return _data.armor[id] ? _withPoints(_data.armor[id]) : (_data.gear[id] || null); })
                        .filter(function (r) { return r && (r.id === current || arena.allowedForClass(r)); }),
                    // Checked in its own place, against the helmet or vest and its other inserts too
                    conflictOf: function (row) { return _gearConflict(row.id, parts[0], store + ':' + parts[2]); },
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
                    _setMagRounds(loading, row.id, Infinity);
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
        if (row.carry_kind === 'magazine') {
            if (row.magazine_capacity) lines.push(String(row.magazine_capacity) + ' ' + _t('arena.rounds'));
        } else if (row.carry_kind === 'ammo' || (row.caliber && !row.is_weapon && row.damage != null)) {
            lines.push(_caliberLabel(row));
        } else if (_cardClass(row)) {
            // Armor says its class with the badge instead (_itemCard)
        } else if (row.grids && row.grids.length) {
            lines.push(tFmt('arena.cellsCount', { n: row.grids.reduce(function (sum, g) { return sum + g[0] * g[1]; }, 0) }));
        }
        return lines;
    }

    // A card's armor class, with the plates it comes with as the game's cards show it; 0 for
    // what has no armor
    function _cardClass(row) {
        if (_data.armor[row.id]) return _armorClass(row.id);
        const pieces = row.pieces || [];
        return pieces.length ? Math.max.apply(null, pieces.map(function (x) { return x.armor_class || 0; })) : 0;
    }

    function _itemCard(row, index, current, conflict) {
        const locked = !EFTForge.arena.allowedForClass(row);
        const picture = row.image_link || row.icon_link || '';
        // The game's class badge, bottom left as the board's slots have it
        const armorClass = _cardClass(row);
        const tip = locked ? _t('arena.lockedClass') : conflict ? (row.name || '') + ': ' + _conflictText(conflict) : (row.name || '');
        // Armor shows its card, with the plates it comes with and why it can't be picked on top
        const card = armorCardHtml(row.id, undefined, locked ? _t('arena.lockedClass') : conflict ? _conflictText(conflict) : '');
        return '<button type="button" class="arena-icard' + (row.id === current ? ' is-current' : '') + (locked ? ' is-locked' : '') + (conflict ? ' is-conflict' : '') + '" data-pick="' + index + '"' +
            (card ? ' data-tooltip-html="' + escapeHtml(card) + '"' : ' data-tooltip="' + escapeHtml(tip) + '"') + '>' +
            '<span class="arena-wcard-mp arena-meta">' + escapeHtml(EFTForge.arena.formatMeta(row.meta_points || 0)) + '</span>' +
            '<span class="arena-wcard-head"><span class="slot-shortname">' + shortNameHtml(row.short_name || row.name || '') + '</span>' +
            _cardLines(row).map(function (l) { return '<span class="arena-wcard-cal">' + escapeHtml(l) + '</span>'; }).join('') + '</span>' +
            (picture ? '<img class="arena-icard-img" src="' + escapeHtml(picture) + '" alt="" loading="lazy" decoding="async" draggable="false" onerror="this.style.visibility=\'hidden\'">' : '') +
            (armorClass >= 1 && armorClass <= 6 ? '<img class="arena-icard-class" src="' + ART + 'armor_class_' + armorClass + '.png" alt="' +
                escapeHtml(tFmt('arena.armorClass', { n: armorClass })) + '" draggable="false">' : '') +
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
            if (_tabsOn()) {
                _loadout = _empty();
            } else {
                const cls = EFTForge.arena.classId();
                if (cls) _store.byClass[cls] = _empty();
                _bind();
            }
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
            if (_view === 'shop') _show(BLAST_GANG, _tabsOn() && !!_tabId);
            else if (_tabsOn() && _tabId) _show(EFTForge.arena.classId(), true);
            else open();
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
        enterTab: enterTab,
        tabId: tabId,
        current: current,
        replaceLoadout: replaceLoadout,
        legacyLoadouts: legacyLoadouts,
        isEmptyLoadout: isEmptyLoadout,
        loadoutKey: loadoutKey,
        copyLoadout: copyLoadout,
        ensureItems: ensureItems,
        summaryHtml: summaryHtml,
        useDrawings: useDrawings,
        boardHtml: boardHtml,
        shopBoard: shopBoard,
        hoverWeapon: hoverWeapon,
        hoverMove: _wtMove,
        hoverHide: _wtHide,
        ensureIds: ensureIds,
        gearChoices: gearChoices,
        gearConflictIn: gearConflictIn,
        itemName: itemName,
        armorCardHtml: armorCardHtml,
        flashSlot: _flashSlot,
        boardItems: boardItems,
        flashBoardChanges: flashBoardChanges,
        className: className,
        classIconUrl: classIconUrl,
        leave: leave,
        renderLanding: renderLanding,
        resumeTarget: resumeTarget,
        wireClassTabs: wireClassTabs,
        isActive: isActive,
        editingSlot: editingSlot,
        builderContext: builderContext,
        saveEditedWeapon: saveEditedWeapon,
        syncEditedWeapon: syncEditedWeapon,
        weaponDrawing: _weaponDrawing,
        totals: totals,
        problems: problems,
        render: render,
        overBudget: overBudget,
        onLangChange: onLangChange,
    };

}());
