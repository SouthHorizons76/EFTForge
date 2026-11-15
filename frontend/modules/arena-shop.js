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
    // The board's slots a player picks from the shop's lists (one each, free), by the shop
    // type that fills them. The pistol and body armor are the kit's own.
    const BOARD_TYPES = { TacticalVest: 'Vest', Earpiece: 'Headphones' };
    const FREE_TYPES = ['Vest', 'Headphones'];
    // The board's slots that take anything the presets' own equipment list has for them. The
    // cap slot only takes headwear without armor (the shop sells the helmets).
    const GEAR_SLOTS = ['Headwear', 'FaceCover', 'Eyewear', 'Scabbard'];
    const CAP = 'Headwear';

    let _data = null;          // /arena/blastgang
    let _dataPromise = null;
    let _byId = {};            // shop item id -> item
    const _points = {};        // item id -> /arena/points dto, for kit names and custom builds
    let _store = _emptyStore();
    let _active = null;        // {type, index}, or {gear: slot} for a board gear slot: the slot whose alternatives are out
    let _editing = null;       // the shop item id whose weapon is open in the builder
    const _kitWeapons = {};    // side -> the kit's pistol as a loadout weapon {gunId, pairs, ammoId, magLoads}

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
                await _loadKitWeapons(data);
                // The board's items: the kits' and everything its slots can swap to
                if (EFTForge.arenaLoadout) {
                    const boardIds = ids.concat(data.items.filter(function (i) { return FREE_TYPES.indexOf(i.type) !== -1; }).map(function (i) { return i.item_id; }));
                    await EFTForge.arenaLoadout.ensureIds(boardIds);
                }
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

    // The kits' pistols as builds: the kit names each part's slot, a build its slot's id
    async function _loadKitWeapons(data) {
        const holsters = {};
        const ids = [];
        SIDES.forEach(function (side) {
            const node = ((data.kits || {})[side] || []).find(function (n) { return n.slot === 'Holster' && n.id; });
            if (!node) return;
            holsters[side] = node;
            const walk = function (n) { ids.push(n.id); (n.children || []).forEach(walk); };
            walk(node);
        });
        if (!ids.length) return;
        const slots = await EFTForge.api.fetchItemSlotsBatch(Array.from(new Set(ids)));
        Object.keys(holsters).forEach(function (side) {
            const weapon = { gunId: holsters[side].id, pairs: [], ammoId: null, magLoads: [] };
            const walk = function (n) {
                (n.children || []).forEach(function (child) {
                    if (child.slot === 'patron_in_weapon') { weapon.ammoId = child.id; return; }
                    if (child.slot === 'cartridges') { weapon.magLoads.push([child.id, child.count || 1]); return; }
                    const slot = (slots[n.id] || []).find(function (s) { return s.slot_game_name === child.slot; });
                    if (!slot) return;
                    weapon.pairs.push([slot.id, child.id]);
                    walk(child);
                });
            };
            walk(holsters[side]);
            if (!weapon.magLoads.length) delete weapon.magLoads;
            _kitWeapons[side] = weapon;
        });
    }

    function _price(item, side) {
        return side === 'defense' ? item.price_defense : item.price_attack;
    }

    function _count(type) {
        if (GEAR_TYPES.indexOf(type) !== -1 || FREE_TYPES.indexOf(type) !== -1) return 1;
        return (_data && _data.slots && _data.slots[type]) || 0;
    }

    // What a slot of `type` can hold on `side`: whatever the side can buy. The data's
    // isSlotAvailable (slot_available) is false for most helmets and armors, which the game's
    // Shop settings lists all the same, so it doesn't count here.
    function _choices(type, side) {
        return _data.items.filter(function (i) { return i.type === type && _price(i, side) > 0; });
    }

    // The game's own lineup: its starter lots first, then the cheapest. A board slot starts
    // with what the side's kit wears in it.
    function _defaults(type, side) {
        const choices = _choices(type, side);
        const slot = Object.keys(BOARD_TYPES).find(function (k) { return BOARD_TYPES[k] === type; });
        if (slot) {
            const worn = _kitNode(side, slot);
            const own = worn && choices.find(function (i) { return i.item_id === worn.id; });
            return (own ? [own] : []).concat(choices.filter(function (i) { return i !== own; })).map(function (i) { return i.id; });
        }
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
            '<div class="stats-section arena-shop-kit"><div class="section-title">' + escapeHtml(_t('arena.shop.kit')) + '</div>' +
                '<div class="arena-shop-board-wrap"></div>' + _kitHtml(side) + '</div>' +
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
        _mountBoard(side);
        _left.querySelector('#arena-shop-open-mobile')?.addEventListener('click', function () {
            if (typeof openMobileRightPanel === 'function') openMobileRightPanel();
        });
        EFTForge.arenaLoadout && EFTForge.arenaLoadout.wireClassTabs(_left);
    }

    function _kitNode(side, slot) {
        return (((_data && _data.kits) || {})[side] || []).find(function (n) { return n.slot === slot && n.id; }) || null;
    }

    // Whether the user emptied board slot `slot` on `side` (right click): '' in its pick
    function _removed(side, slot) {
        return (_store[side].gear || {})[slot] === '';
    }

    function _setGear(side, slot, id) {
        _store[side].gear = Object.assign({}, _store[side].gear || {}, { [slot]: id });
    }

    // The item a board gear slot wears on `side`: the user's pick while the list still has
    // it, nothing once emptied, else the kit's
    function _gearPick(side, slot) {
        const picked = (_store[side].gear || {})[slot];
        if (picked === '') return null;
        const choices = EFTForge.arenaLoadout ? EFTForge.arenaLoadout.gearChoices(slot, slot === CAP) : [];
        if (picked && choices.some(function (i) { return i.id === picked; })) return picked;
        return (_kitNode(side, slot) || {}).id || null;
    }

    // The side's kit as a loadout for the board, with what the user picked for its slots
    function _kitLoadout(side) {
        const loadout = { weapons: {}, gear: {}, carried: [] };
        ['Headwear', 'Earpiece', 'FaceCover', 'Eyewear', 'ArmorVest', 'TacticalVest', 'Scabbard'].forEach(function (slot) {
            // The body armor is whatever the shop's I Armor slot holds, as the game's board shows it
            const type = BOARD_TYPES[slot] || (slot === 'ArmorVest' ? 'Armor' : null);
            if (BOARD_TYPES[slot] && _removed(side, slot)) return;
            const picked = type ? _byId[_lineup(type, side)[0]] : null;
            const id = picked ? picked.item_id : GEAR_SLOTS.indexOf(slot) !== -1 ? _gearPick(side, slot) : (_kitNode(side, slot) || {}).id;
            if (id) loadout.gear[slot] = { id: id };
        });
        if (_kitWeapons[side]) loadout.weapons.Holster = _kitWeapons[side];
        return loadout;
    }

    // The board slot whose list is out, or null
    function _activeSlot() {
        if (!_active) return null;
        if (_active.gear) return _active.gear;
        return Object.keys(BOARD_TYPES).find(function (k) { return BOARD_TYPES[k] === _active.type; }) || null;
    }

    // The board: every slot but the pistol and body armor opens its list on the right
    function _mountBoard(side) {
        const wrap = _left.querySelector('.arena-shop-board-wrap');
        const arenaLoadout = EFTForge.arenaLoadout;
        if (!wrap || !arenaLoadout) return;
        const board = arenaLoadout.shopBoard(_kitLoadout(side), _activeSlot());
        if (!board) return;
        wrap.replaceChildren(board);
        board.querySelectorAll('[data-arena-key]').forEach(function (node) {
            const tile = /** @type {HTMLElement} */ (node);
            const slot = tile.dataset.arenaKey;
            const type = BOARD_TYPES[slot];
            if (!type && GEAR_SLOTS.indexOf(slot) === -1) {
                tile.classList.add('arena-shop-fixed');
                tile.removeAttribute('tabindex');
                // The pistol shows its hover card in place of the tooltip, as the presets' guns do
                if (slot === 'Holster' && _kitWeapons[side]) {
                    _wireHover(tile, function () {
                        const icon = /** @type {HTMLImageElement | null} */ (tile.querySelector('.bw-slot-icon'));
                        const weapon = _kitWeapons[side];
                        return { weapon: weapon, picture: icon ? icon.src : undefined, ammoId: weapon.ammoId || null, noMeta: true };
                    });
                } else {
                    tile.title = _t('arena.shop.fixed');
                }
                return;
            }
            const toggle = function () {
                _active = _activeSlot() === slot ? null : type ? { type: type, index: 0 } : { gear: slot };
                _redraw();
                if (_active && document.body.dataset.mobile === 'true' && typeof openMobileRightPanel === 'function') openMobileRightPanel();
            };
            tile.addEventListener('click', toggle);
            // Right click empties the slot, as the game's does
            tile.addEventListener('contextmenu', function (e) {
                e.preventDefault();
                if (!tile.classList.contains('is-equipped')) return;
                _setGear(side, slot, '');
                _save();
                _redraw();
            });
            tile.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
            });
        });
    }

    // What the rig and pockets carry into every round
    function _kitHtml(side) {
        const kit = (_data.kits || {})[side] || [];
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
        const rows = Object.keys(carried).map(function (id) { return row(id, carried[id]); }).join('');
        return rows ? '<div class="arena-ov-list">' + rows + '</div>' : '';
    }

    // A shop item as it's sold, drawn by Kitbash!: a weapon with its build (or the one made
    // here), a helmet with its parts. Null for anything else, and while a drawing is on its way.
    // As sold, it's the server's own drawing (services/shop_art.py, drawn ahead of time and
    // kept by the browser); only a weapon rebuilt here asks Kitbash! for a drawing of its own.
    function _drawingOf(item) {
        if (!item) return null;
        const build = _store.builds[item.id];
        if (build && _isWeapon(item) && EFTForge.arenaLoadout) {
            return EFTForge.arenaLoadout.weaponDrawing({ gunId: item.item_id, pairs: build.pairs || [], ammoId: null });
        }
        return item.drawing_url ? EFTForge.config.API_BASE + item.drawing_url : null;
    }

    // An img's onerror: a drawing that won't load gives way to the plain 512 px picture, and
    // that to nothing
    function _imgFallback(item) {
        const plain = item.image_link || item.icon_link || '';
        if (!plain) return "this.style.visibility='hidden'";
        return escapeHtml("if (this.dataset.fell) { this.style.visibility='hidden'; } else { this.dataset.fell = '1'; this.src = " + JSON.stringify(plain) + "; }");
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
        const drawing = _drawingOf(item);
        return '<button type="button" class="arena-shop-card' + (active ? ' is-active' : '') + (_isWeapon(item) ? '' : ' is-gear') + '" data-type="' + type + '" data-index="' + index + '">' +
            '<span class="arena-shop-card-name">' + escapeHtml(item.short_name || item.name || '') + '</span>' +
            '<img class="arena-shop-card-img" src="' + escapeHtml(drawing || item.image_link || item.icon_link || '') + '" alt="" loading="lazy" decoding="async" draggable="false" onerror="' + _imgFallback(item) + '">' +
            // The game's modding button, top left: the weapon opens in the builder. A span, since
            // the card is a button already.
            (_isWeapon(item) ? '<span class="arena-shop-card-edit" role="button" tabindex="0" title="' + escapeHtml(_t('arena.editInBuilder')) + '" aria-label="' + escapeHtml(_t('arena.editInBuilder')) + '">' +
                '<img src="assets/images/arena/menu/modding.webp" alt="" draggable="false"></span>' : '') +
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
        // The picker keeps its scroll while it shows the same list (a pick redraws it)
        const oldList = /** @type {HTMLElement | null} */ (_right.querySelector('.arena-shop-alt-list'));
        const listKey = _active ? side + '|' + (_active.gear || _active.type) : null;
        const keepScroll = oldList && oldList.dataset.key === listKey ? oldList.scrollTop : 0;
        _right.innerHTML = '<div class="arena-shop is-' + side + '">' +
            '<div class="arena-shop-title">' + escapeHtml(_t('arena.shop.title')) + '</div>' +
            '<div class="arena-shop-body"><div class="arena-shop-grid">' + columns + '</div>' +
            '<aside class="arena-shop-alt">' + _altHtml(side) + '</aside></div></div>';
        const newList = /** @type {HTMLElement | null} */ (_right.querySelector('.arena-shop-alt-list'));
        if (newList && listKey) {
            newList.dataset.key = listKey;
            if (keepScroll) newList.scrollTop = keepScroll;
        }
        _save();

        _right.querySelectorAll('.arena-shop-card').forEach(function (node) {
            const card = /** @type {HTMLElement} */ (node);
            card.addEventListener('click', function () {
                const type = card.dataset.type;
                const index = Number(card.dataset.index);
                _active = _active && _active.type === type && _active.index === index ? null : { type: type, index: index };
                _redraw();
            });
            // A card dragged onto another of its category trades places with it, as in the game
            if (!card.classList.contains('is-empty')) card.addEventListener('pointerdown', function (e) { _hoverHide(); _pressCard(e, card); });
            const cardItem = _byId[_lineup(card.dataset.type, side)[Number(card.dataset.index)]];
            if (cardItem && _isWeapon(cardItem)) _wireHover(card, function () { return _shopWeaponSpec(cardItem); });
            const edit = card.querySelector('.arena-shop-card-edit');
            if (edit) {
                const open = function (e) {
                    e.stopPropagation();
                    e.preventDefault();
                    const item = _byId[_lineup(card.dataset.type, side)[Number(card.dataset.index)]];
                    if (item) _edit(item);
                };
                edit.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
                edit.addEventListener('click', open);
                edit.addEventListener('keydown', function (e) {
                    const key = /** @type {KeyboardEvent} */ (e).key;
                    if (key === 'Enter' || key === ' ') open(e);
                });
            }
        });
        _right.querySelector('#arena-shop-alt-close')?.addEventListener('click', function () {
            _active = null;
            _redraw();
        });
        _right.querySelector('#arena-shop-factory')?.addEventListener('click', function () {
            const item = _byId[_lineup(_active.type, side)[_active.index]];
            if (!item) return;
            delete _store.builds[item.id];
            _save();
            _renderRight();
        });
        _right.querySelectorAll('.arena-shop-alt-row').forEach(function (node) {
            const row = /** @type {HTMLElement} */ (node);
            row.addEventListener('click', function () { _pick(row.dataset.id); });
            row.addEventListener('pointerdown', function (e) { _press(e, row); });
        });
    }

    /* ===========================
       THE WEAPON HOVER CARD
       arena-loadout.js's, as the presets' gun slots show it: the build's picture, name and
       stats, here with the rounds the shop sells it with.
    =========================== */

    // A shop weapon as the hover card takes it
    function _shopWeaponSpec(item) {
        const build = _store.builds[item.id];
        // Sold loaded: a round chambered and the magazine full of what the shop sells it with
        const names = {};
        if (item.ammo_id && item.ammo_name) names[item.ammo_id] = item.ammo_name;
        return {
            weapon: { gunId: item.item_id, pairs: build ? build.pairs || [] : item.pairs || [], ammoId: item.ammo_id || null },
            picture: _drawingOf(item) || item.image_link || undefined,
            ammoId: item.ammo_id || null,
            names: names,
        };
    }

    // The card waits for the cursor to rest a second, so moving across the shop doesn't flash it
    const HOVER_DELAY = 1000;

    function _wireHover(node, spec) {
        const loadout = EFTForge.arenaLoadout;
        if (!loadout || !loadout.hoverWeapon) return;
        node.addEventListener('mouseenter', function (e) { if (!_drag) loadout.hoverWeapon(spec(), e.clientX, e.clientY, HOVER_DELAY); });
        node.addEventListener('mousemove', function (e) { loadout.hoverMove(e.clientX, e.clientY); });
        node.addEventListener('mouseleave', function () { loadout.hoverHide(); });
    }

    function _hoverHide() {
        if (EFTForge.arenaLoadout && EFTForge.arenaLoadout.hoverHide) EFTForge.arenaLoadout.hoverHide();
    }

    /* ===========================
       DRAG AND DROP
       A list item can be dragged onto any slot it fits, as on the presets' screen: a shop
       card of its category, or the board slot whose list it's from. Green over one, red over
       another slot.
    =========================== */

    const DRAG_THRESHOLD = 10;
    // {id, from, x0, y0, started, ghost, over, card}: `card` is the shop card being moved, null
    // for an item from the list
    let _drag = null;

    function _press(e, row) {
        if (e.button !== 0 || !_active) return;
        _drag = { id: row.dataset.id, from: Object.assign({}, _active), x0: e.clientX, y0: e.clientY, started: false, ghost: null, over: null, card: null,
            picture: (/** @type {HTMLImageElement | null} */ (row.querySelector('.arena-shop-alt-img')) || { src: '' }).src };
        _listen();
    }

    function _pressCard(e, card) {
        if (e.button !== 0) return;
        const from = { type: card.dataset.type, index: Number(card.dataset.index) };
        const id = _lineup(from.type, _store.side)[from.index];
        if (!id) return;
        _drag = { id: id, from: from, x0: e.clientX, y0: e.clientY, started: false, ghost: null, over: null, card: card, picture: '' };
        _listen();
    }

    function _listen() {
        window.addEventListener('pointermove', _dragMove);
        window.addEventListener('pointerup', _dragEnd);
    }

    // The ghost: a moved card is the card itself at its size, a list item its picture
    function _makeGhost() {
        const ghost = document.createElement('div');
        ghost.className = 'arena-ghost arena-shop-ghost';
        if (_drag.card) {
            const rect = _drag.card.getBoundingClientRect();
            const copy = /** @type {HTMLElement} */ (_drag.card.cloneNode(true));
            copy.classList.remove('is-active');
            copy.style.width = rect.width + 'px';
            copy.style.height = rect.height + 'px';
            ghost.appendChild(copy);
            _drag.dx = _drag.x0 - rect.left;
            _drag.dy = _drag.y0 - rect.top;
            // The category's cells, where it can go, outlined as the game does. Their places are
            // taken now: the cards slide between them while the drag goes on.
            _drag.cells = [];
            _right.querySelectorAll('.arena-shop-card[data-type="' + _drag.from.type + '"]').forEach(function (node) {
                const cell = /** @type {HTMLElement} */ (node);
                cell.classList.add('arena-shop-drop-zone');
                _drag.cells[Number(cell.dataset.index)] = { node: cell, rect: cell.getBoundingClientRect() };
            });
            _drag.card.classList.add('is-lifted');
        } else {
            ghost.style.width = '110px';
            ghost.style.height = '70px';
            if (_drag.picture) {
                const img = document.createElement('img');
                img.alt = '';
                img.src = _drag.picture;
                img.style.width = '110px';
                img.style.height = '70px';
                ghost.appendChild(img);
            }
            _drag.dx = 55;
            _drag.dy = 35;
        }
        return ghost;
    }

    function _dragMove(e) {
        if (!_drag) return;
        if (!_drag.started) {
            if (Math.hypot(e.clientX - _drag.x0, e.clientY - _drag.y0) < DRAG_THRESHOLD) return;
            _drag.started = true;
            _drag.ghost = _makeGhost();
            document.body.appendChild(_drag.ghost);
            document.body.classList.add('arena-dragging');
        }
        _drag.ghost.style.left = (e.clientX - _drag.dx) + 'px';
        _drag.ghost.style.top = (e.clientY - _drag.dy) + 'px';
        _dragOver(e.clientX, e.clientY);
    }

    function _clearOver() {
        document.querySelectorAll('.arena-shop-drop-ok, .arena-shop-drop-bad').forEach(function (node) {
            node.classList.remove('arena-shop-drop-ok', 'arena-shop-drop-bad');
        });
    }

    // The slot under the cursor, and where a drop there puts the item ({type, index} or {gear}), or null
    function _dragOver(x, y) {
        _clearOver();
        _drag.over = null;
        const under = document.elementFromPoint(x, y);
        if (!under) return;
        const from = _drag.from;
        // A moved card goes by its category's cells where they were, not by the cards sliding
        // over them, and the others make room for it
        if (_drag.card) {
            const at = _drag.cells.findIndex(function (cell) {
                return cell && x >= cell.rect.left && x <= cell.rect.right && y >= cell.rect.top && y <= cell.rect.bottom;
            });
            _shiftCards(at === -1 ? from.index : at);
            if (at !== -1) {
                if (at !== from.index) _drag.over = { type: from.type, index: at };
                return;
            }
            const other = /** @type {HTMLElement | null} */ (under.closest('.arena-shop-card, .arena-shop-board [data-arena-key]'));
            if (other) other.classList.add('arena-shop-drop-bad');
            return;
        }
        const card = /** @type {HTMLElement | null} */ (under.closest('.arena-shop-card'));
        const tile = /** @type {HTMLElement | null} */ (under.closest('.arena-shop-board [data-arena-key]'));
        let target = null;
        let node = null;
        if (card) {
            node = card;
            if (!from.gear && card.dataset.type === from.type) target = { type: from.type, index: Number(card.dataset.index) };
        } else if (tile) {
            node = tile;
            const key = tile.dataset.arenaKey;
            if (from.gear ? key === from.gear : BOARD_TYPES[key] === from.type) target = from.gear ? { gear: key } : { type: from.type, index: 0 };
        }
        if (!node) return;
        node.classList.add(target ? 'arena-shop-drop-ok' : 'arena-shop-drop-bad');
        _drag.over = target;
    }

    function _dragEnd() {
        window.removeEventListener('pointermove', _dragMove);
        window.removeEventListener('pointerup', _dragEnd);
        const drag = _drag;
        _drag = null;
        if (!drag || !drag.started) return;
        _clearOver();
        if (drag.ghost) drag.ghost.remove();
        document.querySelectorAll('.arena-shop-drop-zone, .arena-shop-card.is-lifted').forEach(function (node) {
            node.classList.remove('arena-shop-drop-zone', 'is-lifted');
            /** @type {HTMLElement} */ (node).style.transform = '';
        });
        document.body.classList.remove('arena-dragging');
        // The click that ends a drag isn't a pick. It comes in the same task as the pointerup,
        // if at all, so the guard goes right after.
        window.addEventListener('click', _swallow, true);
        setTimeout(function () { window.removeEventListener('click', _swallow, true); }, 0);
        if (!drag.over) return;
        if (drag.card) {
            _swap(drag.from.type, drag.from.index, drag.over.index);
            return;
        }
        _active = drag.over;
        _pick(drag.id);
        _redraw();
    }

    // The order a category takes with its card at `from` moved to `to`, the ones between
    // moved over one: old index by new place
    function _order(count, from, to) {
        const order = [];
        for (let i = 0; i < count; i++) order.push(i);
        order.splice(to, 0, order.splice(from, 1)[0]);
        return order;
    }

    // Slide the category's cards to where they'd be with the moved one dropped at `to`
    function _shiftCards(to) {
        const cells = _drag.cells;
        _order(cells.length, _drag.from.index, to).forEach(function (old, place) {
            const cell = cells[old];
            const dest = cells[place];
            if (!cell || !dest) return;
            const dx = dest.rect.left - cell.rect.left;
            const dy = dest.rect.top - cell.rect.top;
            cell.node.style.transform = dx || dy ? 'translate(' + dx + 'px, ' + dy + 'px)' : '';
        });
    }

    // Move a category's card from slot `a` to slot `b`, the ones between moving over, as the
    // game does; the open slot's list follows its card
    function _swap(type, a, b) {
        if (a === b) return;
        const side = _store.side;
        const lineup = _lineup(type, side).slice();
        const order = _order(lineup.length, a, b);
        _store[side][type] = order.map(function (old) { return lineup[old]; });
        if (_active && _active.type === type) {
            _active = { type: type, index: order.indexOf(_active.index) };
        }
        _save();
        _redraw();
    }

    function _swallow(e) {
        e.stopPropagation();
        e.preventDefault();
    }

    // The alternatives a slot pops out, or the game's hint while none is picked
    function _altHtml(side) {
        if (!_active) return '<div class="arena-shop-hint">' + escapeHtml(_t('arena.shop.hint')) + '</div>';
        if (_active.gear) return _gearAltHtml(side, _active.gear);
        const lineup = _lineup(_active.type, side);
        const boardSlot = _activeSlot();
        const current = boardSlot && _removed(side, boardSlot) ? null : _byId[lineup[_active.index]] || null;
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
            // Editing is the card's own button; the list keeps the way back to the game's build
            const buttons = _isWeapon(current) && _store.builds[current.id]
                ? '<div class="arena-shop-alt-actions"><button type="button" class="back-button" id="arena-shop-factory">' + escapeHtml(_t('arena.shop.factory')) + '</button></div>'
                : '';
            head += '<div class="arena-shop-alt-current"><div class="arena-shop-alt-name">' + escapeHtml(current.name || '') + '</div>' + lines.join('') + buttons + '</div>';
        }
        const rows = _choices(_active.type, side).filter(function (item) {
            // Nor is what this slot or another of the category holds already (an emptied board
            // slot offers its old item again)
            if (current && item.id === current.id) return false;
            const at = lineup.indexOf(item.id);
            return at === -1 || at === _active.index;
        }).sort(function (a, b) {
            // A fixed order (the id breaks ties between same named items), so a pick moves nothing
            return _price(a, side) - _price(b, side) || String(a.short_name).localeCompare(String(b.short_name)) || String(a.id).localeCompare(String(b.id));
        }).map(function (item) {
            return _altTileHtml(item, false, escapeHtml(item.ammo_name || ''), FREE_TYPES.indexOf(item.type) === -1 ? _formatPrice(_price(item, side)) : '');
        }).join('');
        return head + '<div class="arena-shop-alt-list' + (WEAPON_TYPES.indexOf(_active.type) !== -1 ? ' is-guns' : '') + '">' + rows + '</div>';
    }

    // One item of the list, as the game's tiles have it: name top right, picture, then what it
    // fires (or that it's in the shop already) and its price along the bottom. `subHtml` is HTML.
    function _altTileHtml(item, isCurrent, subHtml, price) {
        // Drawn by Kitbash! like the shop's cards; the borderless 512 px picture while the
        // drawing is on its way
        const drawing = _drawingOf(item);
        const picture = drawing || item.image_link || item.icon_link || '';
        return '<button type="button" class="arena-shop-alt-row' + (isCurrent ? ' is-current' : '') + '" data-id="' + escapeHtml(item.id) + '"' +
            ' title="' + escapeHtml(item.name || '') + '">' +
            '<span class="arena-shop-alt-rname">' + escapeHtml(item.short_name || item.name || '') + '</span>' +
            '<img class="arena-shop-alt-img" src="' + escapeHtml(picture) + '" alt="" loading="lazy" decoding="async" draggable="false" onerror="' + _imgFallback(item) + '">' +
            (subHtml || price ? '<span class="arena-shop-alt-foot"><span class="arena-shop-alt-sub">' + (subHtml || '') + '</span>' +
                (price ? '<span class="arena-shop-card-price">' + escapeHtml(price) + '</span>' : '') + '</span>' : '') +
            '</button>';
    }

    // A board gear slot's list: everything the presets' equipment list has for the slot
    function _gearAltHtml(side, slot) {
        const current = _gearPick(side, slot);
        const name = function (i) { return String(i.short_name || i.name || ''); };
        const head = '<div class="arena-shop-alt-head"><span>' + escapeHtml(_t('arena.shop.cat.' + slot)) + '</span>' +
            '<button type="button" class="att-table-close-btn" id="arena-shop-alt-close" aria-label="' + escapeHtml(_t('workbench.back')) + '">&#x2715;</button></div>';
        const rows = EFTForge.arenaLoadout.gearChoices(slot, slot === CAP).filter(function (item) { return item.id !== current; }).sort(function (a, b) {
            // A fixed order: what's in the slot stays where it is, so a pick moves nothing
            return name(a).localeCompare(name(b)) || String(a.id).localeCompare(String(b.id));
        }).map(function (item) {
            return _altTileHtml(item, false, '', '');
        }).join('');
        // Melee weapons are weapons: the wide tiles, one to a row
        return head + '<div class="arena-shop-alt-list' + (slot === 'Scabbard' ? ' is-guns' : '') + '">' + rows + '</div>';
    }

    // Put `id` in the open slot; one already elsewhere in the category trades places with it
    function _pick(id) {
        if (!_active) return;
        const side = _store.side;
        if (_active.gear) {
            _setGear(side, _active.gear, id);
            _save();
            _redraw();
            return;
        }
        // A board slot emptied by right click wears what's picked again
        const boardSlot = _activeSlot();
        if (boardSlot && _removed(side, boardSlot)) {
            const gear = Object.assign({}, _store[side].gear);
            delete gear[boardSlot];
            _store[side].gear = gear;
            if (_lineup(_active.type, side)[_active.index] === id) {
                _save();
                _redraw();
                return;
            }
        }
        const lineup = _lineup(_active.type, side).slice();
        const from = lineup.indexOf(id);
        if (from === _active.index) return;
        if (from !== -1) lineup[from] = lineup[_active.index];
        lineup[_active.index] = id;
        _store[side][_active.type] = lineup;
        _save();
        _redraw();
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
