window.EFTForge = window.EFTForge || {};

/* ============================================================
   ARENA: BLASTGANG SHOP
   BlastGang has no presets to build. Every round both teams buy their weapons, armor and
   helmets from a shop, and what a player sets up is the shop itself: which weapons sit in
   each of its slots (three Eco, Common and Elite, two Pistol, Special and Sniper, a helmet
   and two kinds of armor) and how each weapon is built. This is the game's Shop settings
   screen: the Attacker / Defense switch picks the side (each side's shop sells its own
   lineup, at its own prices), a slot pops out the alternatives in its category, and a
   weapon opens in the gun builder, where the stats panel holds its build to the meta point
   range the game allows it.

   arena-loadout.js owns the page (the class tabs, open and leave, the builder's Back) and
   hands this module the left and right panels while BlastGang's tab is open. The shop's
   data is /arena/blastgang. What the user sets up is kept in localStorage.
============================================================ */

window.EFTForge.arenaShop = (function () {

    const STORE_KEY = 'eftforge_arena_shop_v1';
    const SIDES = ['attack', 'defense'];
    // The Shop settings screen's columns as the game lays them out: the gear, then each
    // weapon tier over the row below it
    const COLUMNS = [
        ['Helmets', 'Armor', 'HeavyArmor'],
        ['CrapStorm', 'Pistol'],
        ['HoboGun', 'SpecialGun'],
        ['UberGun', 'SniperGun'],
    ];
    // The game's screen gives each kind of gear one slot
    const GEAR_TYPES = ['Helmets', 'Armor', 'HeavyArmor'];
    const WEAPON_TYPES = ['CrapStorm', 'HoboGun', 'UberGun', 'Pistol', 'SpecialGun', 'SniperGun'];
    // The kit's slots, in the order the left panel lists them
    const KIT_SLOTS = ['Holster', 'Scabbard', 'Headwear', 'Earpiece', 'FaceCover', 'Eyewear', 'ArmorVest', 'TacticalVest'];

    let _data = null;          // /arena/blastgang
    let _dataPromise = null;
    let _byId = {};            // shop item id -> item
    const _points = {};        // item id -> /arena/points dto, for kit names and custom builds
    let _store = _emptyStore();
    let _active = null;        // {type, index}: the slot whose alternatives are out
    let _editing = null;       // the shop item id whose weapon is open in the builder

    function _emptyStore() {
        return { side: 'attack', attack: {}, defense: {}, builds: {} };
    }

    function _load() {
        _store = _emptyStore();
        try {
            const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
            if (raw && typeof raw === 'object') {
                _store.side = raw.side === 'defense' ? 'defense' : 'attack';
                SIDES.forEach(function (side) { if (raw[side] && typeof raw[side] === 'object') _store[side] = raw[side]; });
                if (raw.builds && typeof raw.builds === 'object') _store.builds = raw.builds;
            }
        } catch { /* private mode or a broken entry: the defaults */ }
    }

    function _save() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(_store)); } catch { /* private mode or full */ }
    }

    /* ===========================
       DATA
    =========================== */

    /** Fetch the shop once, and the names of what the kits hold. */
    function load() {
        if (_data) return Promise.resolve(_data);
        if (!_dataPromise) {
            _dataPromise = EFTForge.api.fetchArenaBlastGang().then(async function (data) {
                _data = data;
                _byId = Object.fromEntries(data.items.map(function (i) { return [i.id, i]; }));
                const ids = [];
                Object.values(data.kits || {}).forEach(function (kit) {
                    const walk = function (node) { if (node.id) ids.push(node.id); (node.children || []).forEach(walk); };
                    kit.forEach(walk);
                });
                await _ensurePoints(ids);
                return data;
            }).catch(function (err) {
                _dataPromise = null;
                throw err;
            });
        }
        return _dataPromise;
    }

    async function _ensurePoints(ids) {
        const missing = Array.from(new Set(ids.filter(function (id) { return id && !_points[id]; })));
        if (!missing.length) return;
        Object.assign(_points, await EFTForge.api.fetchArenaPoints(missing));
    }

    function _price(item, side) {
        return side === 'defense' ? item.price_defense : item.price_attack;
    }

    function _count(type) {
        if (GEAR_TYPES.indexOf(type) !== -1) return 1;
        return (_data && _data.slots && _data.slots[type]) || 0;
    }

    // What a slot of `type` can hold on `side`: what the side can buy and a slot can take
    function _choices(type, side) {
        return _data.items.filter(function (i) { return i.type === type && i.slot_available && _price(i, side) > 0; });
    }

    // The game's own lineup: its starter lots first, then the cheapest
    function _defaults(type, side) {
        const choices = _choices(type, side);
        const starters = choices.filter(function (i) { return i.starter_lot; });
        const rest = choices.filter(function (i) { return !i.starter_lot; })
            .sort(function (a, b) { return _price(a, side) - _price(b, side); });
        return starters.concat(rest).map(function (i) { return i.id; });
    }

    /** The shop item ids in `type`'s slots on `side`, mended against the current data. */
    function _lineup(type, side) {
        const allowed = new Set(_choices(type, side).map(function (i) { return i.id; }));
        const count = _count(type);
        const kept = [];
        (_store[side][type] || []).forEach(function (id) {
            if (allowed.has(id) && kept.indexOf(id) === -1 && kept.length < count) kept.push(id);
        });
        _defaults(type, side).forEach(function (id) {
            if (kept.length < count && kept.indexOf(id) === -1) kept.push(id);
        });
        _store[side][type] = kept;
        return kept;
    }

    function _isWeapon(item) { return WEAPON_TYPES.indexOf(item.type) !== -1; }

    // A weapon's build meta points: the game's own build, or the user's from the builder
    function _buildMeta(item) {
        const build = _store.builds[item.id];
        if (!build) return item.meta_points;
        const ids = [item.item_id].concat((build.pairs || []).map(function (p) { return p[1]; }));
        if (ids.some(function (id) { return !_points[id]; })) return null;
        return ids.reduce(function (sum, id) { return sum + (_points[id].meta_points || 0); }, 0);
    }

    /* ===========================
       RENDER
    =========================== */

    let _left = null;
    let _right = null;
    let _tabsHtml = '';

    /** Draw the shop into the loadout page's panels, with arena-loadout.js's class tabs on top. */
    function render(left, right, tabsHtml) {
        _left = left;
        _right = right;
        _tabsHtml = tabsHtml || '';
        if (!_data) return;
        _renderLeft();
        _renderRight();
    }

    function _redraw() {
        if (_left && _left.isConnected) _renderLeft();
        if (_right && _right.isConnected) _renderRight();
    }

    function _renderLeft() {
        const side = _store.side;
        const sideButton = function (key, label) {
            return '<button type="button" class="arena-shop-side is-' + key + (side === key ? ' active' : '') + '" data-side="' + key + '" aria-pressed="' + (side === key) + '">' +
                escapeHtml(_t(label)) + '</button>';
        };
        _left.innerHTML = _tabsHtml +
            '<div class="arena-shop-sides" role="group">' + sideButton('attack', 'arena.shop.attack') + sideButton('defense', 'arena.shop.defense') + '</div>' +
            '<div class="stats-section arena-shop-kit"><div class="section-title">' + escapeHtml(_t('arena.shop.kit')) + '</div>' + _kitHtml(side) + '</div>' +
            '<div class="stats-section arena-shop-notes"><p>' + escapeHtml(_t('arena.shop.about')) + '</p></div>' +
            '<button type="button" class="back-button arena-shop-open-mobile" id="arena-shop-open-mobile">' + escapeHtml(_t('arena.shop.title')) + '</button>';
        _left.querySelectorAll('[data-side]').forEach(function (node) {
            node.addEventListener('click', function () {
                const next = /** @type {HTMLElement} */ (node).dataset.side === 'defense' ? 'defense' : 'attack';
                if (next === _store.side) return;
                _store.side = next;
                _active = null;
                _save();
                _redraw();
            });
        });
        _left.querySelector('#arena-shop-open-mobile')?.addEventListener('click', function () {
            if (typeof openMobileRightPanel === 'function') openMobileRightPanel();
        });
        EFTForge.arenaLoadout && EFTForge.arenaLoadout.wireClassTabs(_left);
    }

    // What the side starts every round with: its worn gear, then what the rig and pockets carry
    function _kitHtml(side) {
        const kit = (_data.kits || {})[side] || [];
        const worn = KIT_SLOTS.map(function (slot) { return kit.find(function (n) { return n.slot === slot && n.id; }); }).filter(Boolean);
        const carried = {};
        kit.forEach(function (node) {
            if (node.slot !== 'Pockets' && node.slot !== 'TacticalVest') return;
            (node.children || []).forEach(function (child) {
                if (!child.id) return;
                carried[child.id] = (carried[child.id] || 0) + (child.count || 1);
            });
        });
        const row = function (id, count) {
            const item = _points[id] || { name: id };
            return '<div class="arena-ov-row">' +
                (EFTForge.arena.itemIcon(item) ? '<img class="arena-ov-icon" src="' + escapeHtml(EFTForge.arena.itemIcon(item)) + '" alt="" onerror="this.style.visibility=\'hidden\'">' : '<span class="arena-ov-icon"></span>') +
                '<span class="arena-ov-name">' + escapeHtml(item.name || item.short_name || '') + '</span>' +
                (count > 1 ? '<span class="arena-shop-kit-count">&times;' + count + '</span>' : '') + '</div>';
        };
        const rows = worn.map(function (n) { return row(n.id, 1); }).join('') +
            Object.keys(carried).map(function (id) { return row(id, carried[id]); }).join('');
        return rows ? '<div class="arena-ov-list">' + rows + '</div>' : '<div class="arena-problem is-ok">-</div>';
    }

    function _formatPrice(n) {
        return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' $';
    }

    function _cardHtml(item, type, index, side) {
        const active = _active && _active.type === type && _active.index === index;
        if (!item) {
            return '<button type="button" class="arena-shop-card is-empty' + (active ? ' is-active' : '') + '" data-type="' + type + '" data-index="' + index + '"></button>';
        }
        const custom = !!_store.builds[item.id];
        // A weapon is drawn by Kitbash! as it's sold (or as built here), like the loadout's slots
        const build = _store.builds[item.id];
        const drawing = _isWeapon(item) && EFTForge.arenaLoadout
            ? EFTForge.arenaLoadout.weaponDrawing({ gunId: item.item_id, pairs: build ? build.pairs || [] : item.pairs || [], ammoId: null })
            : null;
        return '<button type="button" class="arena-shop-card' + (active ? ' is-active' : '') + (_isWeapon(item) ? '' : ' is-gear') + '" data-type="' + type + '" data-index="' + index + '">' +
            '<span class="arena-shop-card-name">' + escapeHtml(item.short_name || item.name || '') + '</span>' +
            '<img class="arena-shop-card-img" src="' + escapeHtml(drawing || item.image_link || item.icon_link || '') + '" alt="" loading="lazy" decoding="async" draggable="false" onerror="this.style.visibility=\'hidden\'">' +
            (custom ? '<span class="arena-shop-card-custom">' + escapeHtml(_t('arena.shop.custom')) + '</span>' : '') +
            '<span class="arena-shop-card-foot"><span class="arena-shop-card-ammo">' + escapeHtml(item.ammo_name || '') + '</span>' +
            '<span class="arena-shop-card-price">' + escapeHtml(_formatPrice(_price(item, side))) + '</span></span></button>';
    }

    function _renderRight() {
        const side = _store.side;
        const columns = COLUMNS.map(function (types) {
            return '<div class="arena-shop-col' + (types === COLUMNS[0] ? ' is-gear' : '') + '">' + types.map(function (type) {
                const lineup = _lineup(type, side);
                const count = _count(type);
                let cells = '';
                for (let i = 0; i < count; i++) cells += _cardHtml(_byId[lineup[i]] || null, type, i, side);
                return '<section class="arena-shop-cat"><div class="arena-shop-cat-head">' + escapeHtml(_t('arena.shop.cat.' + type)) + '</div>' +
                    '<div class="arena-shop-cells">' + cells + '</div></section>';
            }).join('') + '</div>';
        }).join('');
        _right.innerHTML = '<div class="arena-shop is-' + side + '">' +
            '<div class="arena-shop-title">' + escapeHtml(_t('arena.shop.title')) + '</div>' +
            '<div class="arena-shop-body"><div class="arena-shop-grid">' + columns + '</div>' +
            '<aside class="arena-shop-alt">' + _altHtml(side) + '</aside></div></div>';
        _save();

        _right.querySelectorAll('.arena-shop-card').forEach(function (node) {
            const card = /** @type {HTMLElement} */ (node);
            card.addEventListener('click', function () {
                const type = card.dataset.type;
                const index = Number(card.dataset.index);
                _active = _active && _active.type === type && _active.index === index ? null : { type: type, index: index };
                _renderRight();
            });
        });
        _right.querySelector('#arena-shop-alt-close')?.addEventListener('click', function () {
            _active = null;
            _renderRight();
        });
        _right.querySelector('#arena-shop-edit')?.addEventListener('click', function () {
            const item = _byId[_lineup(_active.type, side)[_active.index]];
            if (item) _edit(item);
        });
        _right.querySelector('#arena-shop-factory')?.addEventListener('click', function () {
            const item = _byId[_lineup(_active.type, side)[_active.index]];
            if (!item) return;
            delete _store.builds[item.id];
            _save();
            _renderRight();
        });
        _right.querySelectorAll('.arena-shop-alt-row').forEach(function (node) {
            node.addEventListener('click', function () { _pick(/** @type {HTMLElement} */ (node).dataset.id); });
        });
    }

    // The alternatives a slot pops out, or the game's hint while none is picked
    function _altHtml(side) {
        if (!_active) return '<div class="arena-shop-hint">' + escapeHtml(_t('arena.shop.hint')) + '</div>';
        const lineup = _lineup(_active.type, side);
        const current = _byId[lineup[_active.index]] || null;
        let head = '<div class="arena-shop-alt-head"><span>' + escapeHtml(_t('arena.shop.cat.' + _active.type)) + '</span>' +
            '<button type="button" class="att-table-close-btn" id="arena-shop-alt-close" aria-label="' + escapeHtml(_t('workbench.back')) + '">&#x2715;</button></div>';
        if (current) {
            const arena = EFTForge.arena;
            const lines = [];
            if (_isWeapon(current) && current.meta_max) {
                const meta = _buildMeta(current);
                const outside = meta != null && (meta > current.meta_max || meta < (current.meta_min || 0));
                lines.push('<div class="arena-shop-alt-line' + (outside ? ' is-over' : '') + '">' +
                    escapeHtml(tFmt('arena.shop.build', { mp: meta == null ? '...' : arena.formatMeta(meta) })) +
                    ' <span class="arena-shop-alt-dim">' + escapeHtml(tFmt('arena.shop.range', { min: arena.formatMeta(current.meta_min || 0), max: arena.formatMeta(current.meta_max) })) + '</span></div>');
                if (meta == null) {
                    const build = _store.builds[current.id];
                    _ensurePoints([current.item_id].concat((build.pairs || []).map(function (p) { return p[1]; })))
                        .then(function () { if (_right && _right.isConnected) _renderRight(); })
                        .catch(function (err) { console.warn('[arena-shop] points:', err); });
                }
            }
            if (current.spare_ammo) {
                lines.push('<div class="arena-shop-alt-line">' + escapeHtml(tFmt(current.is_magazine === false ? 'arena.shop.spareRounds' : 'arena.shop.spareMags', { n: current.spare_ammo })) + '</div>');
            }
            const buttons = _isWeapon(current)
                ? '<div class="arena-shop-alt-actions"><button type="button" class="back-button arena-edit-weapon" id="arena-shop-edit">' + escapeHtml(_t('arena.editInBuilder')) + '</button>' +
                  (_store.builds[current.id] ? '<button type="button" class="back-button" id="arena-shop-factory">' + escapeHtml(_t('arena.shop.factory')) + '</button>' : '') + '</div>'
                : '';
            head += '<div class="arena-shop-alt-current"><div class="arena-shop-alt-name">' + escapeHtml(current.name || '') + '</div>' + lines.join('') + buttons + '</div>';
        }
        const rows = _choices(_active.type, side).slice().sort(function (a, b) {
            return _price(a, side) - _price(b, side) || String(a.short_name).localeCompare(String(b.short_name));
        }).map(function (item) {
            const isCurrent = current && item.id === current.id;
            const inShop = !isCurrent && lineup.indexOf(item.id) !== -1;
            return '<button type="button" class="arena-shop-alt-row' + (isCurrent ? ' is-current' : '') + '" data-id="' + escapeHtml(item.id) + '">' +
                '<img class="arena-shop-alt-img" src="' + escapeHtml(EFTForge.arena.itemIcon(item)) + '" alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'">' +
                '<span class="arena-shop-alt-text"><span class="arena-shop-alt-rname">' + escapeHtml(item.short_name || item.name || '') + '</span>' +
                '<span class="arena-shop-alt-sub">' + escapeHtml(item.ammo_name || '') + (inShop ? ' <em>' + escapeHtml(_t('arena.shop.inShop')) + '</em>' : '') + '</span></span>' +
                '<span class="arena-shop-card-price">' + escapeHtml(_formatPrice(_price(item, side))) + '</span></button>';
        }).join('');
        return head + '<div class="arena-shop-alt-list">' + rows + '</div>';
    }

    // Put `id` in the open slot; one already elsewhere in the category trades places with it
    function _pick(id) {
        if (!_active) return;
        const side = _store.side;
        const lineup = _lineup(_active.type, side).slice();
        const from = lineup.indexOf(id);
        if (from === _active.index) return;
        if (from !== -1) lineup[from] = lineup[_active.index];
        lineup[_active.index] = id;
        _store[side][_active.type] = lineup;
        _save();
        _renderRight();
    }

    /* ===========================
       THE BUILDER
    =========================== */

    let _editReady = false;    // the build is in the builder, so its changes are the user's

    function _edit(item) {
        if (typeof loadBuildFromPayload !== 'function') return;
        const build = _store.builds[item.id];
        _editing = item.id;
        _editReady = false;
        Promise.resolve(loadBuildFromPayload({ g: item.item_id, p: build ? build.pairs || [] : item.pairs || [], a: item.ammo_id || null }))
            .then(function () { _editReady = _editing === item.id; syncEditedWeapon(); });
    }

    /** The builder's build becomes the shop weapon's, on every change (no Save). */
    function syncEditedWeapon() {
        const state = EFTForge.state;
        const item = editingItem();
        if (!item || !_editReady || !state.currentGun || !state.buildTree || typeof collectSlotPairs !== 'function') return;
        const pairs = collectSlotPairs(state.buildTree);
        const same = JSON.stringify(pairs) === JSON.stringify(item.pairs || []);
        _load();
        if (same) delete _store.builds[item.id];
        else _store.builds[item.id] = { pairs: pairs, ammoId: null };
        _save();
    }

    /** The shop item whose weapon is open in the builder, or null (another gun opened since doesn't count). */
    function editingItem() {
        const item = _editing ? _byId[_editing] || null : null;
        const gun = EFTForge.state && EFTForge.state.currentGun;
        return item && (!gun || gun.id === item.item_id) ? item : null;
    }

    function clearEditing() { _editing = null; }

    /** The stats panel's Save: the build open in the builder becomes the shop weapon's. */
    function saveEditedWeapon() {
        const state = EFTForge.state;
        const item = editingItem();
        if (!item || !state.currentGun || typeof collectSlotPairs !== 'function') return;
        const ammoSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById('ammo-select'));
        _load();
        _store.builds[item.id] = { pairs: collectSlotPairs(state.buildTree), ammoId: ammoSelect && ammoSelect.value ? ammoSelect.value : null };
        _save();
        showToast(_t('arena.shop.title'), _t('arena.shop.saved'), 2500, '#407d9b');
    }

    /** The left panel's Reset: the open side's lineup goes back to the game's. */
    function reset() {
        _store[_store.side] = {};
        _active = null;
        _save();
    }

    function onLangChange() {
        // Names come from the server in the page's language, the kit's cached ones too
        Object.keys(_points).forEach(function (id) { delete _points[id]; });
        _data = null;
        _dataPromise = null;
    }

    function _t(key) { return (EFTForge.lang && EFTForge.lang.t) ? EFTForge.lang.t(key) : key; }

    _load();

    return {
        load: load,
        render: render,
        reset: reset,
        editingItem: editingItem,
        clearEditing: clearEditing,
        saveEditedWeapon: saveEditedWeapon,
        syncEditedWeapon: syncEditedWeapon,
        onLangChange: onLangChange,
    };

}());
