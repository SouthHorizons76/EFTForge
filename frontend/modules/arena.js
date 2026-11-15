window.EFTForge = window.EFTForge || {};

/* ============================================================
   ARENA MODE
   The header's PvP / Arena switch turns the whole builder over to EFT: Arena's own item
   data: its stats, its armory (only what an Arena preset can hold), and meta points in
   place of prices. The backend only has that data where Arena's game data snapshot is
   configured; /data-version says so, and without it the switch never shows.

   Switching reloads the page in the other mode, so nothing either mode has cached (slot
   tables, allowed items, flea prices, open tabs) can ever be read by the other. The
   catalog calls carry ?game=arena (api.js), and the price helpers in slot-selector.js,
   tree.js and stats-panel.js ask here first, so every price column, chip, sort and total
   shows meta points instead.

   Loaded right after lang.js, before api.js reads the mode.
============================================================ */

window.EFTForge.arena = (function () {

    const MODE_KEY = 'eftforge_game_mode';
    const CLASS_KEY = 'eftforge_arena_class';
    const ARENA = 'arena';

    let _requested = false;
    try { _requested = localStorage.getItem(MODE_KEY) === ARENA; } catch { /* private mode */ }
    // Arena until the server says it has no Arena data, then the main game for good
    let _active = _requested;
    let _available = null;     // null until /data-version answers
    let _config = null;        // /arena/config: classes, stock presets
    let _configPromise = null;
    let _configLang = null;    // the language _configPromise asked for: class names come in it
    let _classId = null;
    try { _classId = localStorage.getItem(CLASS_KEY); } catch { /* private mode */ }

    if (_active) {
        document.documentElement.classList.add('arena-mode');
        // Arena's gun list opens on its preset classes (gun-list.js) rather than calibers
        if (EFTForge.state) EFTForge.state.sortByClass = true;
    }

    function isActive() { return _active; }
    function isAvailable() { return _available === true; }

    /** The query parameter every item request carries in Arena mode, or "". */
    function query() { return _active ? 'game=arena' : ''; }

    /** `path` with this mode's query parameter added. */
    function withGame(path) {
        if (!_active) return path;
        return path + (path.includes('?') ? '&' : '?') + 'game=arena';
    }

    /** localStorage key for state one mode must never read from the other (open tabs). */
    function storageKey(base) { return _active ? base + '_arena' : base; }

    // api.js hands us what /data-version said. Arena was asked for but isn't there: fall
    // back to the main game before the first catalog request goes out.
    function setAvailable(available) {
        _available = !!available;
        if (_active && !_available) {
            _active = false;
            document.documentElement.classList.remove('arena-mode');
            // Back to the main game's own default view
            if (EFTForge.state) EFTForge.state.sortByClass = false;
            if (typeof updateToggleUI === 'function') updateToggleUI();
            try { localStorage.setItem(MODE_KEY, 'pvp'); } catch { /* private mode */ }
        }
        _syncSwitch();
    }

    function setMode(arena) {
        if (arena === _active) return;
        try { localStorage.setItem(MODE_KEY, arena ? ARENA : 'pvp'); } catch { /* private mode */ }
        location.reload();
    }

    /* ===========================
       HEADER SWITCH
    =========================== */

    function _syncSwitch() {
        const box = document.getElementById('game-mode-switch');
        if (!box) return;
        box.style.display = _available || _active ? '' : 'none';
        box.querySelectorAll('[data-game-mode]').forEach(function (node) {
            const btn = /** @type {HTMLElement} */ (node);
            const mine = (btn.dataset.gameMode === ARENA) === _active;
            btn.classList.toggle('active', mine);
            btn.setAttribute('aria-pressed', String(mine));
        });
    }

    function _wireSwitch() {
        // The gun list's Caliber / Class buttons show the view Arena opens on
        if (_active && typeof updateToggleUI === 'function') updateToggleUI();
        const box = document.getElementById('game-mode-switch');
        if (!box) return;
        box.querySelectorAll('[data-game-mode]').forEach(function (node) {
            node.addEventListener('click', function () {
                setMode(/** @type {HTMLElement} */ (node).dataset.gameMode === ARENA);
            });
        });
        _syncSwitch();
    }

    /* ===========================
       CLASSES
    =========================== */

    /** /arena/config, fetched once: {classes, presets, pocket_grids, snapshot}. */
    function loadConfig() {
        if (!_active) return Promise.resolve(null);
        if (!_configPromise || _configLang !== _lang()) {
            _configLang = _lang();
            _configPromise = EFTForge.api.catalogFetch('/arena/config?lang=' + _configLang)
                .then(function (res) {
                    if (!res.ok) throw new Error('arena config ' + res.status);
                    return res.json();
                })
                .then(function (config) {
                    _config = config;
                    if (!_config.classes.some(function (c) { return c.id === _classId; })) {
                        _classId = _config.classes.length ? _config.classes[0].id : null;
                    }
                    return config;
                })
                .catch(function (err) {
                    _configPromise = null;
                    throw err;
                });
        }
        return _configPromise;
    }

    function config() { return _config; }

    /** After a language switch: the class names, fetched again in the new language. */
    function onLangChange() {
        return _active ? loadConfig().catch(function (err) { console.warn('[arena] config:', err); }) : Promise.resolve();
    }
    function classes() { return _config ? _config.classes : []; }
    function classId() { return _classId; }
    function currentClass() {
        return classes().find(function (c) { return c.id === _classId; }) || null;
    }

    function setClass(id) {
        if (id === _classId) return;
        _classId = id;
        try { localStorage.setItem(CLASS_KEY, id); } catch { /* private mode */ }
        document.dispatchEvent(new CustomEvent('arena-class-change'));
    }

    /** Whether the preset class may carry `item` (no list means every class may). */
    function allowedForClass(item, cls) {
        const ids = item && item.arena_class_ids;
        cls = cls === undefined ? _classId : cls;
        return !cls || !ids || ids.length === 0 || ids.indexOf(cls) !== -1;
    }

    /** Whether the class may put `item` on `gun`: the armory bans some parts per weapon. */
    function allowedOnGun(item, gun, cls) {
        cls = cls === undefined ? _classId : cls;
        const banned = gun && cls && ((gun.arena_excluded_mods || {})[cls] || []).concat((gun.arena_excluded_ammo || {})[cls] || []);
        return !banned || banned.indexOf(item.id) === -1;
    }

    /** The BlastGang shop weapon open in the builder, whose own rules replace the class's. */
    function _shopItem() {
        return (EFTForge.arenaShop && EFTForge.arenaShop.editingItem()) || null;
    }

    /** What the rules the builder applies right now depend on: the class, or a shop weapon. */
    function ruleKey() {
        const shop = _shopItem();
        return shop ? 'shop:' + shop.id : String(_classId);
    }

    /** Why the current class (or shop weapon) may not use `item`, or null when it may. */
    function restriction(item, gun) {
        if (!_active || !item) return null;
        const shop = _shopItem();
        if (shop) return gun && (shop.excluded_mods || []).indexOf(item.id) !== -1 ? 'weapon' : null;
        if (!allowedForClass(item)) return 'class';
        if (gun && !allowedOnGun(item, gun)) return 'weapon';
        return null;
    }

    /* ===========================
       META POINTS
    =========================== */

    function metaOf(item) {
        return item && typeof item.meta_points === 'number' ? item.meta_points : null;
    }

    /** Meta points the way the game shows them: whole, or one decimal for a single round. */
    function formatMeta(n) {
        if (n == null) return '';
        const rounded = Math.abs(n) < 100 && n % 1 !== 0 ? Math.round(n * 10) / 10 : Math.round(n);
        return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ' + _t('arena.mp');
    }

    function _lockHtml(item, gun) {
        const why = restriction(item, gun);
        if (!why) return '';
        const tip = why === 'class' ? _t('arena.lockedClass') : _shopItem() ? _t('arena.shop.lockedPart') : _t('arena.lockedWeapon');
        return '<span class="arena-lock" data-tooltip="' + escapeHtml(tip) + '">&#x1F512;</span>';
    }

    /** The attachment table's price cell in Arena mode. */
    function metaCellHtml(item, gun) {
        const mp = metaOf(item);
        if (mp == null) return '-';
        const locked = restriction(item, gun);
        return '<div class="att-price-wrap arena-meta' + (locked ? ' is-locked' : '') + '">' +
            _lockHtml(item, gun) + '<span>' + escapeHtml(formatMeta(mp)) + '</span></div>';
    }

    /** The build tree's price chip in Arena mode. */
    function metaChipHtml(item, gun) {
        const mp = metaOf(item);
        if (mp == null) return '';
        const locked = restriction(item, gun);
        return '<div class="price-chip arena-meta' + (locked ? ' is-locked' : '') + '">' + _lockHtml(item, gun) +
            '<span class="price-chip-value">' + escapeHtml(formatMeta(mp)) + '</span></div>';
    }

    /** A weapon card's corner badge in the gun list: its default preset, as it comes. */
    function gunCardBadgeHtml(gun) {
        if (!_active) return '';
        const mp = typeof gun.preset_meta_points === 'number' ? gun.preset_meta_points : metaOf(gun);
        return mp == null ? '' : '<div class="arena-gun-badge arena-meta">' + escapeHtml(formatMeta(mp)) + '</div>';
    }

    /** The meta points of the build open in the builder, part by part. */
    function buildMeta() {
        const state = EFTForge.state;
        const gun = state.currentGun;
        if (!_active || !gun) return null;
        const parts = [{ item: gun, count: 1 }];
        const walk = function (node) {
            for (const slotId in (node && node.children) || {}) {
                parts.push({ item: node.children[slotId].item, count: 1 });
                walk(node.children[slotId]);
            }
        };
        walk(state.buildTree);
        // A loaded magazine and the chambered round, as the game's own presets count them
        const ammoSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById('ammo-select'));
        const ammo = ammoSelect && ammoSelect.value ? state.ammoMap[ammoSelect.value] : null;
        const magazine = parts.find(function (p) { return p.item && p.item.magazine_capacity > 0; });
        if (ammo && state.assumeFullMag !== false) {
            parts.push({ item: ammo, count: (magazine ? magazine.item.magazine_capacity : 0) + 1 });
        }
        let total = 0;
        let mods = 0;
        let weapon = 0;
        const locked = [];
        parts.forEach(function (part, index) {
            const mp = (metaOf(part.item) || 0) * part.count;
            total += mp;
            if (part.item !== ammo) weapon += mp;
            if (index > 0 && part.item !== ammo) mods += mp;
            if (restriction(part.item, index > 0 ? gun : null)) locked.push(part.item);
        });
        // weapon: the gun and its parts without the rounds, which a BlastGang shop weapon's range counts
        return { parts: parts, total: total, mods: mods, weapon: weapon, ammo: ammo, locked: locked };
    }

    /* ===========================
       BUILDER: the stats panel's meta row and the Meta view
    =========================== */

    // The bar's full width: the class limit (every class shares it at the moment)
    function _barMax() {
        const cls = currentClass();
        if (cls && cls.meta_max) return cls.meta_max;
        const maxes = classes().map(function (c) { return c.meta_max || 0; });
        return Math.max.apply(null, maxes.concat([10000]));
    }

    /**
     * The meta points bar the stats panel shows under its other main stats, or "" outside
     * Arena. `prevWidth` is the bar's width before this redraw, so it slides like the others.
     */
    function statBarHtml(prevWidth) {
        const meta = buildMeta();
        if (!meta) return '';
        const shop = _shopItem();
        if (shop && shop.meta_max) return _shopBarHtml(meta, shop, prevWidth);
        const share = meta.total > 0 ? Math.round(meta.mods * 100 / meta.total) : 0;
        const target = Math.max(0, Math.min(meta.total / _barMax(), 1)) * 100;
        const tip = tFmt('arena.modShare', { pct: share }) + '. ' + _t('arena.modShareTip') +
            (meta.locked.length ? ' ' + tFmt('arena.lockedParts', { n: meta.locked.length }) : '');
        return '<div class="stat-bar-row arena-meta-row' + (meta.locked.length ? ' is-locked' : '') + '">' +
            '<div class="stat-bar-label" data-tooltip="' + escapeHtml(tip) + '">' + escapeHtml(_t('arena:stats.priceView')) + '</div>' +
            '<div class="stat-bar-track">' +
            '<div class="stat-bar-fill arena-meta-bar" style="width:' + (prevWidth || '0%') + '" data-target="' + target + '"></div>' +
            '<div class="stat-bar-value">' + (meta.locked.length ? '<span class="arena-lock">&#x1F512;</span>' : '') +
            '<span id="stat-meta-value">' + escapeHtml(formatMeta(meta.total)) + '</span></div>' +
            '</div></div>';
    }

    // A BlastGang shop weapon: its build against the range the game holds it to
    function _shopBarHtml(meta, shop, prevWidth) {
        const min = shop.meta_min || 0;
        const out = meta.weapon > shop.meta_max || meta.weapon < min || meta.locked.length > 0;
        const target = Math.max(0, Math.min(meta.weapon / shop.meta_max, 1)) * 100;
        const tip = tFmt('arena.shop.range', { min: formatMeta(min), max: formatMeta(shop.meta_max) }) + '. ' + _t('arena.shop.rangeTip') +
            (meta.locked.length ? ' ' + tFmt('arena.shop.lockedParts', { n: meta.locked.length }) : '');
        return '<div class="stat-bar-row arena-meta-row' + (out ? ' is-locked' : '') + '">' +
            '<div class="stat-bar-label" data-tooltip="' + escapeHtml(tip) + '">' + escapeHtml(_t('arena:stats.priceView')) + '</div>' +
            '<div class="stat-bar-track">' +
            '<div class="stat-bar-fill arena-meta-bar" style="width:' + (prevWidth || '0%') + '" data-target="' + target + '"></div>' +
            (min > 0 ? '<div class="arena-shop-bar-min" style="left:' + (min * 100 / shop.meta_max) + '%"></div>' : '') +
            '<div class="stat-bar-value">' + (meta.locked.length ? '<span class="arena-lock">&#x1F512;</span>' : '') +
            '<span id="stat-meta-value">' + escapeHtml(formatMeta(meta.weapon)) + '</span>' +
            '<span class="arena-shop-bar-max"> / ' + escapeHtml(formatMeta(shop.meta_max)) + '</span></div>' +
            '</div></div>';
    }

    /** The meta bar's full width, in meta points. */
    function metaBarMax() {
        const shop = _shopItem();
        return shop && shop.meta_max ? shop.meta_max : _barMax();
    }

    /**
     * What installing `entry` in `slot` would do to the build's meta points, for the stat
     * bars' hover preview: {current, delta}, or null outside Arena. The part it replaces
     * goes with everything mounted on it; a magazine of another size loads that many more
     * or fewer rounds while the full magazine is counted.
     */
    function hoverMeta(entry, parentNode, slot) {
        const meta = buildMeta();
        if (!meta || !entry || !entry.item) return null;
        const subtree = function (node) {
            let total = metaOf(node.item) || 0;
            for (const id in node.children || {}) total += subtree(node.children[id]);
            return total;
        };
        const installed = parentNode && slot && parentNode.children ? parentNode.children[slot.id] : null;
        let delta = (metaOf(entry.item) || 0) - (installed ? subtree(installed) : 0);
        (entry.childItems || []).forEach(function (child) { delta += metaOf(child) || 0; });
        if (meta.ammo && EFTForge.state.assumeFullMag !== false && entry.item.magazine_capacity != null) {
            const before = installed && installed.item ? (installed.item.magazine_capacity || 0) : 0;
            delta += (metaOf(meta.ammo) || 0) * ((entry.item.magazine_capacity || 0) - before);
        }
        return { current: meta.total, delta: delta };
    }

    /** No Save button: a loadout or shop weapon open in the builder keeps itself in sync. */
    function saveButtonHtml() { return ''; }

    // The stats panel redraws after every change to the build: that's when the weapon open
    // from the loadout or the shop takes the builder's build
    function wireStatsRow() {
        if (!_active) return;
        if (_shopItem()) EFTForge.arenaShop.syncEditedWeapon();
        else if (EFTForge.arenaLoadout && EFTForge.arenaLoadout.editingSlot()) EFTForge.arenaLoadout.syncEditedWeapon();
    }

    /** The builder's Meta view (its Price view in the main game). */
    function renderMetaOverview(panel) {
        const meta = buildMeta();
        if (!meta) return;
        const gun = EFTForge.state.currentGun;
        const rows = meta.parts.map(function (part, index) {
            const item = part.item;
            const mp = (metaOf(item) || 0) * part.count;
            const locked = restriction(item, index > 0 ? gun : null);
            return '<div class="arena-ov-row' + (locked ? ' is-locked' : '') + '">' +
                (item.icon_link ? '<img class="arena-ov-icon" src="' + escapeHtml(item.icon_link) + '" alt="" onerror="this.style.display=\'none\'">' : '<span class="arena-ov-icon"></span>') +
                '<span class="arena-ov-name">' + escapeHtml(item.name || item.short_name || '') + (part.count > 1 ? ' &times;' + part.count : '') + '</span>' +
                _lockHtml(item, index > 0 ? gun : null) +
                '<span class="arena-ov-mp arena-meta">' + escapeHtml(formatMeta(mp)) + '</span></div>';
        }).join('');
        const cls = currentClass();
        panel.innerHTML = '<div class="stats-section arena-overview">' +
            '<div class="section-title">' + escapeHtml(_t('arena.metaBreakdown')) + '</div>' +
            '<div class="arena-ov-list">' + rows + '</div>' +
            '<div class="arena-ov-total"><span>&#931;</span><span class="arena-meta">' + escapeHtml(formatMeta(meta.total)) + '</span></div>' +
            (cls && cls.meta_max ? '<div class="arena-ov-note">' + escapeHtml(tFmt('arena.weaponOfClass', {
                pct: Math.round(meta.total * 100 / cls.meta_max), cls: cls.name, max: formatMeta(cls.meta_max),
            })) + '</div>' : '') +
            '</div>';
    }

    // A class change redraws whatever shows locks
    document.addEventListener('arena-class-change', async function () {
        if (!_active) return;
        const state = EFTForge.state;
        if (state.currentGun) {
            // The ammo list follows the class too (gun-list.js loadAmmoForGun), and the
            // stats below read the round it picks
            if (typeof loadAmmoForGun === 'function') await loadAmmoForGun(state.currentGun);
            if (typeof renderFullTree === 'function') renderFullTree();
            if (typeof applyAttachmentSort === 'function') applyAttachmentSort();
            if (typeof refreshBuildStats === 'function') refreshBuildStats();
            if (state.priceView && typeof renderPriceOverview === 'function') renderPriceOverview();
        }
    });

    function _t(key) { return (EFTForge.lang && EFTForge.lang.t) ? EFTForge.lang.t(key) : key; }
    function _lang() { return (EFTForge.state && EFTForge.state.lang) || 'en'; }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _wireSwitch);
    else _wireSwitch();

    return {
        isActive: isActive,
        isAvailable: isAvailable,
        query: query,
        withGame: withGame,
        storageKey: storageKey,
        setAvailable: setAvailable,
        setMode: setMode,
        loadConfig: loadConfig,
        onLangChange: onLangChange,
        config: config,
        classes: classes,
        classId: classId,
        currentClass: currentClass,
        setClass: setClass,
        allowedForClass: allowedForClass,
        allowedOnGun: allowedOnGun,
        restriction: restriction,
        ruleKey: ruleKey,
        metaOf: metaOf,
        formatMeta: formatMeta,
        metaCellHtml: metaCellHtml,
        metaChipHtml: metaChipHtml,
        gunCardBadgeHtml: gunCardBadgeHtml,
        buildMeta: buildMeta,
        statBarHtml: statBarHtml,
        metaBarMax: metaBarMax,
        hoverMeta: hoverMeta,
        saveButtonHtml: saveButtonHtml,
        wireStatsRow: wireStatsRow,
        renderMetaOverview: renderMetaOverview,
    };

}());
