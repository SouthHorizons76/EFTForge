window.EFTForge = window.EFTForge || {};

/* ============================================================
   ARMOR SIMULATOR
   Laid out like the gun builder: the target settings and the loadout (TarkTetris's
   gear panel) on the left, an item table on the right when a slot is clicked (right click
   or swipe empties it), and the results on the right once a run has finished.
   Runs the ballistics engine (ballistics-engine.js) on the player's own machine after every change, like the builder's stats.
============================================================ */

window.EFTForge.armorSim = (function () {

    // The order the area picker lists colliders in. Which body part each one drains comes
    // from /armor/zones.
    const AREA_ORDER = ['ParietalHead', 'BackHead', 'Ears', 'Eyes', 'Jaw', 'HeadCommon',
                        'RibcageUp', 'SpineTop', 'LeftSideChestUp', 'RightSideChestUp', 'NeckFront', 'NeckBack',
                        'RibcageLow', 'SpineDown', 'LeftSideChestDown', 'RightSideChestDown', 'Pelvis', 'PelvisBack',
                        'LeftUpperArm', 'LeftForearm', 'RightUpperArm', 'RightForearm',
                        'LeftThigh', 'LeftCalf', 'RightThigh', 'RightCalf'];
    const BODY_PARTS_FOR = {
        head: ['Head'],
        thorax: ['Chest'],
        stomach: ['Stomach'],
        arms: ['LeftArm', 'RightArm'],
        legs: ['LeftLeg', 'RightLeg'],
    };
    // In the order the game checks them
    const EQUIPMENT_SLOTS = ['headwear', 'face_cover', 'eyewear', 'rig', 'armor'];
    const CARRIER_SLOTS = ['rig', 'armor'];
    const SLOT_ART = {
        ammo: 'patron_in_weapon.png', headwear: 'Headwear.png', face_cover: 'Face_cover.png',
        eyewear: 'Eyewear.png', rig: 'TacticalVest.png', armor: 'Bodyarmor.png',
        plate: 'armor_plate.png', attachment: 'mod_equipment.png',
    };
    const MAX_SHOTS = 30;
    const RUN_DELAY = 450;
    const RETRY_DELAY = 1100;
    // Finished runs we can show again without working them out again: the oldest go first past
    // the cap, and none outlive the age limit, so a sync mid session can't keep old numbers up
    const RESULT_CACHE_MAX = 40;
    const RESULT_CACHE_AGE_MS = 10 * 60 * 1000;

    let _armor = null;          // GET /armor/items
    let _ammo = null;           // GET /ammo/all, flattened
    let _zones = null;          // GET /armor/zones
    let _engineData = null;     // { items, ammo } for the ballistics engine (ballistics-engine.js)
    let _dataLang = null;
    let _loading = null;
    let _duraPop = null;        // the open durability popover: {key, node, anchor, saved, pending, confirmed}
    let _duraAllParts = true;   // a main item's popover edits every part in it, or the item alone

    const DEFAULT_SETTINGS = { distance: 50, angle: 0, velocity: 0, part: 'thorax', collider: 'RibcageUp', throughPlate: true };
    const _settings = Object.assign({}, DEFAULT_SETTINGS);
    // ammo: id; equipment: {slot: {id, durability, inserts?: {built-in insert slot: durability},
    // plates: {plate slot: {id, durability}}}};
    // attachments: {helmet slot: id}; attachmentDurability: {helmet slot: {durability}}, full when missing
    const _loadout = { ammo: null, equipment: {}, attachments: {}, attachmentDurability: {} };
    let _activeSlot = null;     // the slot whose picker is open, highlighted on the left
    let _usedSnapshot = 0;      // the build snapshot its button was last clicked for, which hides the button
    let _useBuildOnShow = false; // the stats panel's vs armor button asked for the build once the data is in

    let _lastResult = null;     // stays on screen while the next run is out, like the builder's stats
    let _runTimer = null;
    let _running = false;
    let _runAgain = false;
    const _resultCache = new Map(); // request JSON -> {response, at}, oldest first

    /* ===========================
       SHOW
    =========================== */

    async function show() {
        const left = _el('bw-left-armor');
        if (!left) return;
        try {
            if (!_armor || _dataLang !== _lang()) {
                _disposeAreaSelect();
                left.innerHTML = '<div class="ammo-loading">' + _esc(_t('armorSim.loading')) + '</div>';
                await _load();
                if (_dataLang !== _lang()) return show();
            }
        } catch (err) {
            console.error('[armor-sim] load error:', err);
            left.innerHTML = '<div class="ammo-error">' + _esc(_t('armorSim.loadError')) + '</div>';
            return;
        }
        _pruneLoadout();
        if (_useBuildOnShow) {
            _useBuildOnShow = false;
            _applySnapshot();
        }
        _renderLeft();
        _renderRight();
        if (_loadout.ammo && !_lastResult) _scheduleRun();
    }

    function onLangChange() {
        _dataLang = null;
        _lastResult = null;
        const wb = EFTForge.workbench;
        if (wb && wb.isActive() && wb.currentTool() === 'armor') show();
    }

    // The workbench's Reset button: empty every slot and put the settings back
    function reset() {
        Object.assign(_settings, DEFAULT_SETTINGS);
        _loadout.equipment = {};
        _loadout.attachments = {};
        _loadout.attachmentDurability = {};
        _lastResult = null;
        EFTForge.workbench.closePicker();
        _renderLeft();
        _scheduleRun();
    }

    // A copy of the settings and loadout for the workbench tab to keep
    function getState() {
        return JSON.parse(JSON.stringify({ settings: _settings, loadout: _loadout }));
    }

    // A workbench tab's saved settings and loadout, or the defaults for a new tab. The items
    // are checked against the catalog once it's loaded, in show()
    function setState(state) {
        _closeDuraPop();
        const saved = state ? JSON.parse(JSON.stringify(state)) : {};
        Object.keys(_settings).forEach(function (k) { delete _settings[k]; });
        Object.assign(_settings, DEFAULT_SETTINGS, saved.settings || {});
        const loadout = saved.loadout || {};
        _loadout.ammo = loadout.ammo || null;
        _loadout.equipment = loadout.equipment || {};
        _loadout.attachments = loadout.attachments || {};
        _loadout.attachmentDurability = loadout.attachmentDurability || {};
        _activeSlot = null;
        _lastResult = null;
        _lastCompare = null;
    }

    // Drop anything a saved loadout names that the catalog no longer has
    function _pruneLoadout() {
        if (_loadout.ammo && !_ammoById(_loadout.ammo)) _loadout.ammo = null;
        Object.keys(_loadout.equipment).forEach(function (slot) {
            const worn = _loadout.equipment[slot];
            if (!worn || !_armorById(worn.id)) { delete _loadout.equipment[slot]; return; }
            worn.plates = worn.plates || {};
            Object.keys(worn.plates).forEach(function (name) {
                if (!worn.plates[name] || !_armorById(worn.plates[name].id)) delete worn.plates[name];
            });
        });
        Object.keys(_loadout.attachments).forEach(function (slot) {
            if (!_armorById(_loadout.attachments[slot])) {
                delete _loadout.attachments[slot];
                delete _loadout.attachmentDurability[slot];
            }
        });
    }

    // The stats panel's "vs armor" button: open the workbench on this tool with the build's
    // ammo and velocity, the one way in that takes them without the button
    async function openFromBuild() {
        const wb = EFTForge.workbench;
        if (!wb) return;
        _useBuildOnShow = true;
        await wb.open();
        wb.setTool('armor');
    }

    function _load() {
        if (_loading) return _loading;
        const lang = _lang();
        _loading = Promise.all([
            EFTForge.api.catalogFetch('/armor/items?lang=' + lang),
            EFTForge.api.catalogFetch('/ammo/all?lang=' + lang),
            EFTForge.api.catalogFetch('/armor/zones'),
        ]).then(async function ([armorRes, ammoRes, zonesRes]) {
            if (!armorRes.ok || !ammoRes.ok || !zonesRes.ok) {
                throw new Error('HTTP ' + armorRes.status + '/' + ammoRes.status + '/' + zonesRes.status);
            }
            _armor = await armorRes.json();
            const byCaliber = await ammoRes.json();
            _ammo = [];
            Object.keys(byCaliber).forEach(function (cal) { _ammo.push.apply(_ammo, byCaliber[cal] || []); });
            _ammo = _ammo.filter(function (row) {
                return row.penetration_power != null && row.damage != null && row.armor_damage != null;
            });
            _zones = await zonesRes.json();
            // What the ballistics engine runs on, one object per load so the worker gets it once
            _engineData = { items: _armor, ammo: _ammo };
            _dataLang = lang;
            // Fresh item data may come with new stats, so nothing worked out before it stays
            _resultCache.clear();
            _lastCompare = null;
        }).finally(function () { _loading = null; });
        return _loading;
    }

    // The button's job: fill in the ammo and velocity of the build the workbench was opened
    // from. Nothing comes over from the build until the player asks for it
    function _applySnapshot() {
        const snap = EFTForge.workbench && EFTForge.workbench.buildSnapshot();
        if (!snap) return;
        _usedSnapshot = snap.serial;
        if (snap.ammoId && _ammoById(snap.ammoId)) _loadout.ammo = snap.ammoId;
        if (snap.velocityPct != null) _settings.velocity = Math.round(snap.velocityPct * 100) / 100;
        _scheduleRun();
    }

    /* ===========================
       LEFT: TARGET, LOADOUT
    =========================== */

    function _renderLeft() {
        const left = _el('bw-left-armor');
        _closeDuraPop();
        _disposeAreaSelect();
        const snap = EFTForge.workbench && EFTForge.workbench.buildSnapshot();
        left.innerHTML = `
            <div class="stats-section">
                <div class="section-title">${_esc(_t('armorSim.section.target'))}</div>
                <div class="bw-toggle-row">
                    ${Object.keys(BODY_PARTS_FOR).map(function (part) {
                        return '<button type="button" class="toggle-btn' + (part === _settings.part ? ' active' : '') +
                            '" data-part="' + part + '">' + _esc(_t('armorSim.part.' + part)) + '</button>';
                    }).join('')}
                </div>
                <div class="optimizer-field">
                    <label class="modal-label" for="as-area" id="as-area-label">${_esc(_t('armorSim.area'))}</label>
                    <select id="as-area">${_areaOptions()}</select>
                </div>
                <div class="bw-coverage" id="as-coverage"></div>
                <div class="optimizer-toggle-row" id="as-plate-hit-wrap" hidden>
                    <span class="bw-toggle-label" id="as-plate-hit-label"></span>
                    <button type="button" class="compare-toggle${_settings.throughPlate ? ' active' : ''}" id="as-plate-hit" role="switch" aria-checked="${_settings.throughPlate}" aria-labelledby="as-plate-hit-label">
                        <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                    </button>
                </div>
                <div class="stats-divider"></div>
                <div class="bw-slider-fields">
                    ${_sliderField('as-distance', 'armorSim.distance', null, 0, 1000, 5, 5, _settings.distance)}
                    ${_sliderField('as-angle', 'armorSim.angle', 'armorSim.angleTip', 0, 89, 1, 1, _settings.angle)}
                    ${_sliderField('as-velocity', 'armorSim.velocity', 'armorSim.velocityTip', -90, 200, 1, 0.1, _settings.velocity)}
                </div>
                ${snap && snap.serial !== _usedSnapshot ? '<button type="button" class="modal-btn full-width bw-use-build" id="as-use-build">' +
                    _esc(_tFmt('armorSim.useLastBuild', { gun: snap.label })) + '</button>' : ''}
            </div>
            <div class="stats-section">
                <div class="section-title">${_esc(_t('armorSim.section.loadout'))}
                    <span class="tree-swipe-hint">${_esc(_t('armorSim.swipeHint'))}</span></div>
                ${_loadoutHtml()}
                <button type="button" class="modal-btn full-width bw-mobile-only" id="as-show-results"${_lastResult ? '' : ' hidden'}>${_esc(_t('armorSim.showResults'))}</button>
            </div>`;

        setupCustomSelect('as-area');
        const areaTrigger = left.querySelector('#as-area-custom .custom-select-trigger');
        if (areaTrigger) areaTrigger.setAttribute('aria-labelledby', 'as-area-label');
        left.querySelectorAll('[data-part]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                _settings.part = /** @type {HTMLElement} */ (btn).dataset.part;
                const areas = _areasFor(_settings.part);
                if (areas.indexOf(_settings.collider) === -1) _settings.collider = areas[0];
                _renderLeft();
                _scheduleRun();
            });
        });
        _el('as-area').addEventListener('change', function (event) {
            _settings.collider = /** @type {HTMLSelectElement} */ (event.target).value;
            _scheduleRun();
        });
        _el('as-plate-hit').addEventListener('click', function () {
            _settings.throughPlate = !_settings.throughPlate;
            _el('as-plate-hit').classList.toggle('active', _settings.throughPlate);
            _el('as-plate-hit').setAttribute('aria-checked', String(_settings.throughPlate));
            _scheduleRun();
        });
        [
            { id: 'as-distance', key: 'distance', low: 0, high: 1000 },
            { id: 'as-angle', key: 'angle', low: 0, high: 89 },
            { id: 'as-velocity', key: 'velocity', low: -90, high: 200 },
        ].forEach(function (spec) {
            // The slider and the field move together; the field takes finer steps than the slider
            const field = /** @type {HTMLInputElement} */ (_el(spec.id));
            const range = /** @type {HTMLInputElement} */ (_el(spec.id + '-range'));
            const apply = function (raw) {
                const value = parseFloat(raw);
                if (!isFinite(value)) return false;
                _settings[spec.key] = Math.min(Math.max(value, spec.low), spec.high);
                range.value = String(_settings[spec.key]);
                _scheduleRun();
                return true;
            };
            field.addEventListener('input', function () { apply(field.value); });
            field.addEventListener('change', function () { field.value = String(_settings[spec.key]); });
            range.addEventListener('input', function () {
                if (apply(range.value)) field.value = String(_settings[spec.key]);
            });
        });
        const useBuild = _el('as-use-build');
        if (useBuild) useBuild.addEventListener('click', function () {
            _applySnapshot();
            _renderLeft();
            const ammoSlot = _slotEl('ammo');
            if (ammoSlot) EFTForge.workbench.flashSlot(ammoSlot, 'install');
            EFTForge.workbench.refreshPicker();
        });
        // Phones keep the results in the drawer, which nothing else here opens
        _el('as-show-results').addEventListener('click', function () { openMobileRightPanel(); });
        _wireSlots(left);
        _updateHints();
    }

    // A label over a slider with a number field beside it, both editing the same setting;
    // the three of them share one row
    function _sliderField(id, labelKey, tipKey, min, max, sliderStep, fieldStep, value) {
        const label = _esc(_t(labelKey));
        return '<div class="optimizer-field"><label class="modal-label" for="' + id + '"' +
            (tipKey ? ' data-tooltip="' + _esc(_t(tipKey)) + '"' : '') + '>' + label + '</label>' +
            '<div class="bw-slider-field"><input type="range" id="' + id + '-range" aria-label="' + label + '" min="' + min +
            '" max="' + max + '" step="' + sliderStep + '" value="' + value + '">' +
            '<input type="number" class="optimizer-input" id="' + id + '" min="' + min + '" max="' + max +
            '" step="' + fieldStep + '" value="' + value + '"></div></div>';
    }

    function _disposeAreaSelect() {
        const wrapper = _el('as-area-custom');
        if (wrapper) wrapper.dispatchEvent(new Event('eftforge:dispose-select'));
    }

    function _areasFor(part) {
        const wanted = BODY_PARTS_FOR[part];
        return AREA_ORDER.filter(function (collider) { return wanted.indexOf(_zones.body_parts[collider]) !== -1; });
    }

    function _areaOptions() {
        return _areasFor(_settings.part).map(function (collider) {
            return '<option value="' + collider + '"' + (collider === _settings.collider ? ' selected' : '') + '>' +
                _esc(_t('armorSim.collider.' + collider)) + '</option>';
        }).join('');
    }

    /* ---- Loadout ---- */

    // TarkTetris's gear panel: 125 px slots with their 20 px header bars, 3 x 2 of them. Ammo
    // takes the free earpiece spot and the rig the free left one. The columns sit 72 px apart
    // and a 72 px band runs between the rows, so the 56 px insert slots fit around their
    // parent: plates go back above, front below and sides beside it, helmet attachments
    // beside the helmet. Everything is laid out on a 594 x 434 canvas scaled to the panel.
    const GEAR_W = 594;
    const GEAR_H = 434;
    const SLOT = 125;
    const INSERT = 56;
    const INSERT_GAP = 8;
    const COLUMNS = [72, 269, 466];
    const ROWS = [22, 241];
    const GEAR_LAYOUT = [
        { slot: 'ammo', x: COLUMNS[0], y: ROWS[0] },
        { slot: 'headwear', x: COLUMNS[1], y: ROWS[0] },
        { slot: 'face_cover', x: COLUMNS[2], y: ROWS[0] },
        { slot: 'rig', x: COLUMNS[0], y: ROWS[1] },
        { slot: 'armor', x: COLUMNS[1], y: ROWS[1] },
        { slot: 'eyewear', x: COLUMNS[2], y: ROWS[1] },
    ];

    function _place(x, y, size) {
        return 'left:' + (x * 100 / GEAR_W) + '%;top:' + (y * 100 / GEAR_H) + '%;width:' + (size * 100 / GEAR_W) +
            '%;height:' + (size * 100 / GEAR_H) + '%';
    }

    // Where an insert sits around its parent at (x, y)
    function _insertSpot(spot, x, y) {
        const left = x - INSERT_GAP - INSERT;
        const right = x + SLOT + INSERT_GAP;
        const middle = y + (SLOT - INSERT) / 2;
        const centre = x + (SLOT - INSERT) / 2;
        switch (spot) {
            case 'back': return [centre, y - 22 - INSERT_GAP - INSERT];
            case 'front': return [centre, y + SLOT + INSERT_GAP];
            case 'left': return [left, middle];
            case 'right': return [right, middle];
            case 'left-top': return [left, y + 4];
            case 'left-bottom': return [left, y + SLOT - 4 - INSERT];
            default: return [right, middle];
        }
    }

    const PLATE_SPOTS = { front_plate: 'front', back_plate: 'back', left_side_plate: 'left', right_side_plate: 'right' };
    // Helmet attachment slots in order, by how many the helmet has
    const ATTACHMENT_SPOTS = { 1: ['left'], 2: ['left', 'right'], 3: ['left-top', 'right', 'left-bottom'] };

    // Body armor and an armored rig rule each other out, so once one is worn we drop the
    // other's slot, and a worn rig moves into the armor's spot in the middle
    function _gearLayout() {
        const eq = _loadout.equipment;
        if (eq.armor) return GEAR_LAYOUT.filter(function (spot) { return spot.slot !== 'rig'; });
        if (!eq.rig) return GEAR_LAYOUT;
        return GEAR_LAYOUT.filter(function (spot) { return spot.slot !== 'armor'; }).map(function (spot) {
            return spot.slot === 'rig' ? { slot: 'rig', x: COLUMNS[1], y: ROWS[1] } : spot;
        });
    }

    function _loadoutHtml() {
        let html = '<div class="bw-gear">';
        _gearLayout().forEach(function (spot) {
            const style = _place(spot.x, spot.y, SLOT);
            if (spot.slot === 'ammo') {
                html += _slotHtml('ammo', _t('armorSim.slot.ammo'), _ammoById(_loadout.ammo), null, 'ammo', style);
                return;
            }
            const worn = _loadout.equipment[spot.slot];
            const item = worn ? _armorById(worn.id) : null;
            html += _slotHtml('eq:' + spot.slot, _t('armorSim.slot.' + spot.slot), item, worn ? worn.durability : null, spot.slot, style);
            if (!item) return;
            if (spot.slot === 'headwear') {
                const slots = _attachmentSlots(item);
                const spots = ATTACHMENT_SPOTS[Math.min(slots.length, 3)] || [];
                slots.slice(0, 3).forEach(function (helmetSlot, i) {
                    const at = _insertSpot(spots[i], spot.x, spot.y);
                    html += _slotHtml('att:' + helmetSlot.slot,
                        _t('armorSim.slot.attachment') + (slots.length > 1 ? ' ' + (i + 1) : ''),
                        _armorById(_loadout.attachments[helmetSlot.slot]), _attachmentDurability(helmetSlot.slot), 'attachment',
                        _place(at[0], at[1], INSERT));
                });
            } else if (CARRIER_SLOTS.indexOf(spot.slot) !== -1) {
                item.plate_slots.forEach(function (plateSlot) {
                    const where = PLATE_SPOTS[plateSlot.slot.toLowerCase()];
                    if (!where) return;
                    const at = _insertSpot(where, spot.x, spot.y);
                    const plate = worn.plates[plateSlot.slot];
                    html += _slotHtml('plate:' + spot.slot + ':' + plateSlot.slot, _plateSlotName(plateSlot.slot),
                        plate ? _armorById(plate.id) : null, plate ? plate.durability : null, 'plate', _place(at[0], at[1], INSERT));
                });
            }
        });
        return html + '</div>';
    }

    // One slot: a header bar over a square body showing the slot art until something is in it
    function _slotHtml(key, label, item, durability, kind, style) {
        const isAmmo = kind === 'ammo';
        // Plates and helmet attachments: small slots around their parent, named by their tooltip
        const insert = kind === 'plate' || kind === 'attachment';
        let body = '<img class="bw-slot-art bw-art-' + kind + '" src="./assets/images/ballistics-loadout/' + SLOT_ART[kind] + '" alt="">';
        if (item) {
            const drawn = key === 'eq:headwear' ? _helmetImage(item) : null;
            body = slotColorHtml(item) + '<img class="bw-slot-icon" src="' + _esc((drawn && drawn.url) || _staticImage(item)) + '" alt="" decoding="async">' +
                (drawn && drawn.working ? _bpWorkingLogoHtml() : '') +
                '<span class="bw-slot-short">' + _esc(item.short_name || '') + '</span>';
            if (isAmmo) {
                const damage = (item.projectile_count || 1) > 1 ? item.projectile_count + '×' + item.damage : item.damage;
                body += '<span class="bw-slot-stat" data-tooltip="' + _esc(_t('armorSim.col.dmgPen')) + '">' +
                    _esc(damage + ' / ' + item.penetration_power) + '</span>';
            } else if (_wornClass(key, item) >= 1 && _wornClass(key, item) <= 6) {
                // The game's roman numeral badge in the bottom left corner, as TarkTetris draws it
                const level = _wornClass(key, item);
                body += '<img class="bw-armor-class" src="./assets/images/ballistics-loadout/armor_class_' + level + '.png" alt="' +
                    _esc(_t('armorSim.classShort') + ' ' + level) + '">';
            }
            if (durability != null) {
                // Main equipment totals every part in it; its plates and attachments keep their own
                const tip = _duraParts(key).length > 1 ? 'armorSim.totalDurabilityTip' : 'armorSim.durabilityTip';
                body += '<button type="button" class="bw-slot-dura" data-dura-for="' + _esc(key) + '" data-dura-label="' + _esc(label) +
                    '" data-tooltip="' + _esc(_t(tip)) + '" aria-label="' + _esc(label + ' - ' + _t('sheets.col.durability')) + '">' +
                    _esc(_duraReadout(key).text) + '</button>';
            }
        }
        const drawing = key === 'eq:headwear' && item && _helmetImage(item);
        const tooltip = insert ? label + (item ? ': ' + item.name : '') : item ? item.name : '';
        const card = item && !insert && !isAmmo ? _builtInCardHtml(key, item) : '';
        return '<div class="bw-slot bw-slot-' + kind + (insert ? ' bw-slot-insert' : '') + (item ? ' is-equipped' : '') +
            (key === _activeSlot ? ' active-slot' : '') + (drawing && drawing.working ? ' kb-working-slot' : '') +
            '" data-bw-slot="' + _esc(key) + '" role="button" tabindex="0"' + (style ? ' style="' + style + '"' : '') +
            ' aria-label="' + _esc(label + (item ? ': ' + item.name : '')) + '"' +
            (card ? ' data-tooltip-html="' + _esc(card) + '"' : tooltip ? ' data-tooltip="' + _esc(tooltip) + '"' : '') + '>' +
            '<div class="bw-slot-header">' + _esc(label) + '</div>' +
            '<div class="bw-slot-body">' + body + '</div></div>';
    }

    function _wireSlots(root) {
        root.querySelectorAll('[data-bw-slot]').forEach(function (node) {
            const row = /** @type {HTMLElement} */ (node);
            const key = row.dataset.bwSlot;
            row.addEventListener('click', function (event) {
                if (/** @type {Element} */ (event.target).closest('.bw-slot-dura')) return;
                _openSlot(key);
            });
            row.addEventListener('keydown', function (event) {
                const pressed = /** @type {KeyboardEvent} */ (event).key;
                if (event.target !== row || (pressed !== 'Enter' && pressed !== ' ')) return;
                event.preventDefault();
                _openSlot(key);
            });
            row.addEventListener('contextmenu', function (event) {
                event.preventDefault();
                if (/** @type {Element} */ (event.target).closest('.bw-slot-dura')) return;
                _clearSlot(key, false);
            });
            if (key !== 'ammo' && row.classList.contains('is-equipped')) {
                addSwipeToRemove(row.querySelector('.bw-slot-body'), function () { _clearSlot(key, false); });
            }
        });
        root.querySelectorAll('[data-dura-for]').forEach(function (node) {
            const button = /** @type {HTMLElement} */ (node);
            button.addEventListener('click', function (event) {
                event.stopPropagation();
                if (_duraPop && _duraPop.key === button.dataset.duraFor) _closeDuraPop();
                else _openDuraPop(button);
            });
            button.addEventListener('keydown', function (event) { event.stopPropagation(); });
        });
    }

    /* ===========================
       DURABILITY POPOVER
    =========================== */

    // The parts one readout covers, as {target, item}: a plate or attachment alone, a main item
    // with every plate and helmet attachment in it, like the game's total on the parent
    function _duraParts(key) {
        const target = _slotTarget(key);
        const item = _armorById(_currentId(key));
        if (!target || !item) return [];
        const parts = [{ target: target, item: item }];
        const add = function (partKey) {
            const partTarget = _slotTarget(partKey);
            const partItem = _armorById(_currentId(partKey));
            if (partTarget && partItem) parts.push({ target: partTarget, item: partItem });
        };
        const slot = key.split(':');
        if (slot[0] !== 'eq') return parts;
        const worn = _loadout.equipment[slot[1]];
        Object.keys(worn.plates).forEach(function (name) { add('plate:' + slot[1] + ':' + name); });
        if (slot[1] === 'headwear') {
            _attachmentSlots(item).forEach(function (helmetSlot) {
                if (_loadout.attachments[helmetSlot.slot]) add('att:' + helmetSlot.slot);
            });
        }
        return parts;
    }

    // The game's durability readout: current over max of the armor pieces it covers, with the
    // matching percent, falling back to a plain percent when none of them has armor pieces
    function _duraReadout(key, parts) {
        if (!parts) parts = _duraParts(key);
        let current = 0;
        let max = 0;
        parts.forEach(function (part) {
            part.item.pieces.forEach(function (p) {
                max += p.durability || 0;
                current += (p.durability || 0) * _piecePercent(part.target, p) / 100;
            });
        });
        const short = function (n) { return String(Math.round(n * 10) / 10); };
        if (max > 0) return { text: short(current) + '/' + short(max), percent: Math.round(current / max * 1000) / 10 };
        const percent = parts.length ? parts[0].target.durability : 100;
        return { text: short(percent) + '%', percent: percent };
    }

    // Every readout in the loadout, since a part's change moves its parent's total too, and
    // the hover cards listing the built-in armor's durability
    function _refreshDuraReadouts() {
        const left = _el('bw-left-armor');
        if (!left) return;
        left.querySelectorAll('[data-dura-for]').forEach(function (node) {
            node.textContent = _duraReadout(/** @type {HTMLElement} */ (node).dataset.duraFor).text;
        });
        left.querySelectorAll('[data-bw-slot^="eq:"]').forEach(function (node) {
            const slot = /** @type {HTMLElement} */ (node);
            const item = _armorById(_currentId(slot.dataset.bwSlot));
            const card = item ? _builtInCardHtml(slot.dataset.bwSlot, item) : '';
            if (card) slot.dataset.tooltipHtml = card;
        });
    }

    /* ---- Built-in armor card ---- */

    // The game's picture of each built-in insert, by slot, and the order the card lists them in
    const INSERT_ART = ['soft_armor_front', 'soft_armor_back', 'soft_armor_left', 'soft_armor_right', 'collar',
        'shoulder_l', 'shoulder_r', 'groin', 'groin_back', 'helmet_top', 'helmet_back', 'helmet_ears', 'helmet_eyes', 'helmet_jaw'];

    // An item's built-in inserts in the card's order; none for an item that is armor itself
    // (a plate, a face shield)
    function _builtInPieces(item) {
        const rank = function (p) { const i = INSERT_ART.indexOf(p.slot.toLowerCase()); return i === -1 ? INSERT_ART.length : i; };
        return item.pieces.filter(function (p) { return p.slot; }).sort(function (a, b) { return rank(a) - rank(b); });
    }

    // A piece's durability percent: a built-in insert's own when it has one, else its item's
    function _piecePercent(target, piece) {
        const own = target.inserts && piece.slot ? target.inserts[piece.slot] : null;
        return own != null ? own : target.durability;
    }

    function _pieceReadout(target, piece) {
        const short = function (n) { return String(Math.round(n * 10) / 10); };
        return short(piece.durability * _piecePercent(target, piece) / 100) + '/' + short(piece.durability);
    }

    function _insertArtHtml(piece) {
        const slot = piece.slot.toLowerCase();
        return INSERT_ART.indexOf(slot) !== -1 ? '<img src="./assets/images/ballistics-loadout/inserts/' + slot + '.png" alt="">' : '';
    }

    // Hovering a worn item lists its built-in soft or integrated armor, like the game's
    // inspect window: each insert's picture, class, durability and the areas it covers
    function _builtInCardHtml(key, item) {
        const worn = _slotTarget(key);
        const pieces = _builtInPieces(item);
        if (!worn || !pieces.length) return '';
        const rows = pieces.map(function (p) {
            const art = _insertArtHtml(p);
            const badge = p.armor_class >= 1 && p.armor_class <= 6
                ? '<img class="bw-builtin-class" src="./assets/images/ballistics-loadout/armor_class_' + p.armor_class + '.png" alt="' +
                    _esc(_t('armorSim.classShort') + ' ' + p.armor_class) + '">' : '';
            const areas = p.body_colliders.map(_areaName).join(', ');
            return '<div class="bw-builtin-row"><div class="bw-builtin-art">' + art + '</div><div class="bw-builtin-text">' +
                '<div class="bw-builtin-head">' + badge + '<span class="bw-builtin-name">' + _esc(_insertName(p.slot)) + '</span>' +
                '<span class="bw-builtin-dura">' + _pieceReadout(worn, p) + '</span></div>' +
                (areas ? '<div class="bw-builtin-areas">' + _esc(areas) + '</div>' : '') + '</div></div>';
        }).join('');
        return '<div class="bw-builtin-card"><div class="bw-builtin-title">' + _esc(item.name) + '</div>' +
            '<div class="bw-builtin-label">' + _esc(_t('armorSim.builtInArmor')) + '</div>' + rows + '</div>';
    }

    function _insertName(slotName) {
        const key = 'armorSim.insert.' + slotName.toLowerCase();
        const label = _t(key);
        return label === key ? slotName.replace(/_/g, ' ') : label;
    }

    function _openDuraPop(anchor) {
        _closeDuraPop();
        const key = anchor.dataset.duraFor;
        const parts = _duraParts(key);
        if (!parts.length) return;
        const main = parts[0];
        const inserts = key.indexOf('eq:') === 0 ? _builtInPieces(main.item) : [];
        const label = _esc(_t('sheets.col.durability'));
        const node = document.createElement('div');
        node.className = 'bw-dura-pop';
        node.setAttribute('role', 'dialog');
        node.setAttribute('aria-label', anchor.dataset.duraLabel + ' - ' + _t('sheets.col.durability'));
        node.innerHTML = '<div class="bw-dura-pop-head"><span class="bw-dura-pop-title">' + _esc(anchor.dataset.duraLabel) + '</span>' +
            '<span class="bw-dura-pop-value"></span></div>' +
            (parts.length > 1 || inserts.length > 1 ? '<div class="bw-toggle-row bw-dura-pop-scope" role="radiogroup">' +
                ['all', 'main'].map(function (scope) {
                    const on = (scope === 'all') === _duraAllParts;
                    return '<button type="button" class="toggle-btn' + (on ? ' active' : '') + '" role="radio" aria-checked="' + on +
                        '" data-dura-scope="' + scope + '" data-tooltip="' + _esc(_t('armorSim.duraScope.' + scope + 'Tip')) + '">' +
                        _esc(_t('armorSim.duraScope.' + scope)) + '</button>';
                }).join('') + '</div>' : '') +
            '<div class="bw-dura-pop-body"></div>';
        document.body.appendChild(node);
        // Keep what every part started at, so Escape can put it back; the results only rerun
        // once a value is confirmed (slider let go, field committed), not on every step
        const saved = parts.map(function (part) {
            return { target: part.target, durability: part.target.durability, inserts: part.target.inserts };
        });
        _duraPop = { key: key, node: node, anchor: anchor, saved: saved, pending: false, confirmed: false };
        anchor.classList.add('open');

        const value = /** @type {HTMLElement} */ (node.querySelector('.bw-dura-pop-value'));
        const body = /** @type {HTMLElement} */ (node.querySelector('.bw-dura-pop-body'));
        const sliderHtml = function (name) {
            return '<div class="bw-dura-pop-row"><input type="range" min="0" max="100" step="1" aria-label="' + name + '">' +
                '<input type="number" min="0" max="100" step="1" aria-label="' + name + '"><span class="input-suffix">%</span></div>';
        };
        // Item only on an item with several inserts gives each insert its own slider
        const perInsert = function () { return !_duraAllParts && inserts.length > 1; };
        const showHead = function () {
            value.textContent = _duraReadout(key, _duraAllParts ? parts : [main]).text;
            _refreshDuraReadouts();
        };
        // Every pair on show, so a change to one (the overall slider, an insert) moves the others
        let syncs = [];
        // One slider and field pair: read() gives its percent, write(percent) stores it, and
        // after() repaints anything else the pair owns
        const wire = function (row, read, write, after) {
            const range = /** @type {HTMLInputElement} */ (row.querySelector('input[type="range"]'));
            const field = /** @type {HTMLInputElement} */ (row.querySelector('input[type="number"]'));
            const sync = function (fromField) {
                range.value = String(read());
                if (!fromField) field.value = String(read());
                if (after) after();
            };
            syncs.push(sync);
            const apply = function (raw, fromField) {
                const parsed = parseFloat(raw);
                if (!isFinite(parsed)) return;
                write(Math.min(Math.max(parsed, 0), 100));
                syncs.forEach(function (other) { other(other === sync && fromField); });
                showHead();
                if (_duraPop) _duraPop.pending = true;
            };
            range.addEventListener('input', function () { apply(range.value, false); });
            range.addEventListener('change', _confirmDura);
            field.addEventListener('input', function () { apply(field.value, true); });
            field.addEventListener('change', function () { sync(false); _confirmDura(); });
            field.addEventListener('keydown', function (event) {
                if (/** @type {KeyboardEvent} */ (event).key === 'Enter') _closeDuraPop(true);
            });
            sync(false);
            return field;
        };
        const render = function () {
            node.classList.toggle('bw-dura-pop-wide', perInsert());
            syncs = [];
            let first = null;
            if (perInsert()) {
                const allName = _esc(_t('armorSim.allSoftArmor'));
                body.innerHTML = '<div class="bw-dura-insert bw-dura-insert-all" data-insert="all"><div class="bw-dura-insert-head">' +
                    '<span class="bw-builtin-name">' + allName + '</span><span class="bw-builtin-dura"></span></div>' +
                    sliderHtml(allName + ' - ' + label) + '</div>' +
                    inserts.map(function (p, i) {
                        const name = _esc(_insertName(p.slot));
                        return '<div class="bw-dura-insert" data-insert="' + i + '"><div class="bw-dura-insert-head">' +
                            '<span class="bw-builtin-art">' + _insertArtHtml(p) + '</span><span class="bw-builtin-name">' + name + '</span>' +
                            '<span class="bw-builtin-dura"></span></div>' + sliderHtml(name + ' - ' + label) + '</div>';
                    }).join('');
                // The overall slider: every insert at one percent, starting from their weighted total
                const allRow = /** @type {HTMLElement} */ (body.querySelector('[data-insert="all"]'));
                const allReadout = /** @type {HTMLElement} */ (allRow.querySelector('.bw-builtin-dura'));
                first = wire(allRow, function () { return _duraReadout(key, [main]).percent; }, function (percent) {
                    main.target.durability = percent;
                    delete main.target.inserts;
                }, function () { allReadout.textContent = _duraReadout(key, [main]).text; });
                inserts.forEach(function (p, i) {
                    const row = /** @type {HTMLElement} */ (body.querySelector('[data-insert="' + i + '"]'));
                    const readout = /** @type {HTMLElement} */ (row.querySelector('.bw-builtin-dura'));
                    wire(row, function () { return _piecePercent(main.target, p); }, function (percent) {
                        const own = Object.assign({}, main.target.inserts);
                        own[p.slot] = percent;
                        main.target.inserts = own;
                    }, function () { readout.textContent = _pieceReadout(main.target, p); });
                });
            } else {
                // One value for every part it covers, which drops any insert's own value
                const edited = _duraAllParts ? parts : [main];
                body.innerHTML = sliderHtml(label);
                first = wire(body, function () { return _duraReadout(key, edited).percent; }, function (percent) {
                    edited.forEach(function (part) {
                        part.target.durability = percent;
                        delete part.target.inserts;
                    });
                });
            }
            showHead();
            _placeDuraPop();
            return first;
        };
        node.querySelectorAll('[data-dura-scope]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                _duraAllParts = /** @type {HTMLElement} */ (btn).dataset.duraScope === 'all';
                node.querySelectorAll('[data-dura-scope]').forEach(function (other) {
                    const on = other === btn;
                    other.classList.toggle('active', on);
                    other.setAttribute('aria-checked', String(on));
                });
                render();
            });
        });
        const field = render();
        field.focus();
        field.select();
        document.addEventListener('pointerdown', _onDuraOutside, true);
        document.addEventListener('keydown', _onDuraKey, true);
        window.addEventListener('resize', _closeDuraPopNow);
        window.addEventListener('scroll', _placeDuraPop, true);
    }

    // Below the readout, or above it when the window runs out, kept inside the window sideways
    function _placeDuraPop() {
        if (!_duraPop) return;
        if (!_duraPop.anchor.isConnected) { _closeDuraPop(); return; }
        const at = _duraPop.anchor.getBoundingClientRect();
        const node = _duraPop.node;
        const width = node.offsetWidth;
        const height = node.offsetHeight;
        const gap = 6;
        let top = at.bottom + gap;
        if (top + height > window.innerHeight - 8 && at.top - gap - height > 8) top = at.top - gap - height;
        const left = Math.min(Math.max(at.right - width, 8), window.innerWidth - width - 8);
        node.style.top = Math.round(top) + 'px';
        node.style.left = Math.round(left) + 'px';
    }

    // Rerun the results on a confirmed value, once per change
    function _confirmDura() {
        if (!_duraPop || !_duraPop.pending) return;
        _duraPop.pending = false;
        _duraPop.confirmed = true;
        _scheduleRun();
    }

    // Closing confirms anything still unconfirmed, unless cancel puts back what the parts
    // started at (rerunning only if the results had already moved off them)
    function _closeDuraPop(refocus, cancel) {
        if (!_duraPop) return;
        const pop = _duraPop;
        if (cancel !== true) _confirmDura();
        const anchor = pop.anchor;
        pop.node.remove();
        anchor.classList.remove('open');
        _duraPop = null;
        if (cancel === true && (pop.pending || pop.confirmed)) {
            pop.saved.forEach(function (entry) {
                entry.target.durability = entry.durability;
                if (entry.inserts) entry.target.inserts = entry.inserts;
                else delete entry.target.inserts;
            });
            _refreshDuraReadouts();
            if (pop.confirmed) _scheduleRun();
        }
        document.removeEventListener('pointerdown', _onDuraOutside, true);
        document.removeEventListener('keydown', _onDuraKey, true);
        window.removeEventListener('resize', _closeDuraPopNow);
        window.removeEventListener('scroll', _placeDuraPop, true);
        if (refocus === true && anchor.isConnected) anchor.focus();
    }

    function _closeDuraPopNow() { _closeDuraPop(); }

    function _onDuraOutside(event) {
        if (!_duraPop) return;
        const hit = /** @type {Node} */ (event.target);
        if (_duraPop.node.contains(hit) || _duraPop.anchor.contains(hit)) return;
        _closeDuraPop();
    }

    function _onDuraKey(event) {
        if (/** @type {KeyboardEvent} */ (event).key !== 'Escape') return;
        event.stopPropagation();
        _closeDuraPop(true, true);
    }

    // The loadout entry a durability box edits: a worn item or a plate in one of its slots
    function _slotTarget(key) {
        const parts = key.split(':');
        if (parts[0] === 'eq') return _loadout.equipment[parts[1]] || null;
        if (parts[0] === 'att') {
            if (!_loadout.attachments[parts[1]]) return null;
            return _loadout.attachmentDurability[parts[1]] || (_loadout.attachmentDurability[parts[1]] = { durability: 100 });
        }
        if (parts[0] === 'plate') {
            const worn = _loadout.equipment[parts[1]];
            return worn ? worn.plates[parts[2]] || null : null;
        }
        return null;
    }

    // The durability box value for the attachment in helmet slot `slot`, or null when it's empty
    function _attachmentDurability(slot) {
        if (!_loadout.attachments[slot]) return null;
        const entry = _loadout.attachmentDurability[slot];
        return entry ? entry.durability : 100;
    }

    // What's in a slot now, by slot key
    function _currentId(key) {
        const parts = key.split(':');
        if (parts[0] === 'ammo') return _loadout.ammo;
        if (parts[0] === 'eq') return _loadout.equipment[parts[1]] ? _loadout.equipment[parts[1]].id : null;
        if (parts[0] === 'att') return _loadout.attachments[parts[1]] || null;
        const worn = _loadout.equipment[parts[1]];
        return worn && worn.plates[parts[2]] ? worn.plates[parts[2]].id : null;
    }

    // Whether `key` is one of the insert slots of the worn item in equipment slot `eqKey`
    function _isInsertOf(key, eqKey) {
        const slot = eqKey.split(':')[1];
        return key.indexOf('plate:' + slot + ':') === 0 || (slot === 'headwear' && key.indexOf('att:') === 0);
    }

    function _openSlot(key) {
        const wb = EFTForge.workbench;
        const parts = key.split(':');
        let rows;
        let slotName;
        let art;
        if (parts[0] === 'ammo') {
            rows = _ammo;
            slotName = _t('armorSim.slot.ammo');
            art = 'ammo';
        } else if (parts[0] === 'eq') {
            rows = _armor.filter(function (item) { return item.equipment_slot === parts[1] && item.pieces.length > 0; });
            slotName = _t('armorSim.slot.' + parts[1]);
            art = parts[1];
        } else if (parts[0] === 'att') {
            const helmet = _loadout.equipment.headwear ? _armorById(_loadout.equipment.headwear.id) : null;
            const helmetSlot = helmet ? _attachmentSlots(helmet).find(function (s) { return s.slot === parts[1]; }) : null;
            if (!helmetSlot) return;
            rows = helmetSlot.rows;
            slotName = _t('armorSim.slot.attachment');
            art = 'attachment';
        } else {
            const worn = _loadout.equipment[parts[1]];
            const carrier = worn ? _armorById(worn.id) : null;
            const plateSlot = carrier ? carrier.plate_slots.find(function (s) { return s.slot === parts[2]; }) : null;
            if (!plateSlot) return;
            rows = plateSlot.allowed_plate_ids.map(_armorById).filter(Boolean);
            slotName = _plateSlotName(parts[2]);
            art = 'plate';
        }
        wb.openPicker({
            key: key,
            slotName: slotName,
            art: './assets/images/ballistics-loadout/' + SLOT_ART[art],
            artKind: art,
            rows: rows,
            ammoTable: parts[0] === 'ammo',
            columns: parts[0] === 'ammo' ? undefined : _armorColumns(key === 'eq:armor' || key === 'eq:rig'),
            currentId: function () { return _currentId(key); },
            sort: parts[0] === 'ammo' ? { key: 'penetration_power', asc: false } : { key: 'armor_class', asc: false },
            conflictFor: parts[0] === 'ammo' ? null : function (row) { return _conflictFor(row, key); },
            onConflict: function (row, conflict) {
                replaceToast('armor-conflict', _t('armorSim.conflictTitle'), row.name + '\n' + conflict.message);
                const slot = _slotEl(conflict.key);
                if (slot) wb.flashConflict(slot);
            },
            onPick: function (row) {
                _install(key, row);
                // A new round is all a run needs, so get the table out of the way of its results
                if (parts[0] === 'ammo') wb.closePicker();
            },
            // A run always needs a round, so the ammo slot never empties
            onRemove: parts[0] === 'ammo' ? null : function () { _clearSlot(key, true); },
            onClose: function () {
                _activeSlot = null;
                _highlightSlot();
            },
        });
        _activeSlot = key;
        _highlightSlot();
    }

    // Put `row` in slot `key`, then flash it the way the builder flashes an installed part,
    // and the insert slots a new worn item brings along the way it flashes revealed slots
    function _install(key, row) {
        const parts = key.split(':');
        if (parts[0] === 'ammo') {
            _loadout.ammo = row.id;
        } else if (parts[0] === 'eq') {
            // A new item comes the way the game sells it, with its default plates and
            // attachments, except any of them the rest of the loadout rules out (an Altyn's
            // face shield over worn eyewear): those stay off, like a part the builder refuses
            const present = _present(key);
            const plates = {};
            const attachments = {};
            let refused = null;
            _defaultInserts(row, key).forEach(function (part) {
                const conflict = _partConflict(part, present);
                if (conflict) {
                    refused = refused || { part: part.item, conflict: conflict };
                    return;
                }
                const name = part.key.split(':').pop();
                if (part.key.indexOf('att:') === 0) attachments[name] = part.item.id;
                else plates[name] = { id: part.item.id, durability: 100 };
            });
            const old = _loadout.equipment[parts[1]];
            _loadout.equipment[parts[1]] = { id: row.id, durability: old ? old.durability : 100, plates: plates };
            if (parts[1] === 'headwear') {
                _loadout.attachments = attachments;
                _loadout.attachmentDurability = {};
            }
            if (refused) {
                replaceToast('armor-conflict', _t('armorSim.conflictTitle'), refused.part.name + '\n' + refused.conflict.message);
                const blocker = refused.conflict.key;
                setTimeout(function () {
                    const el = _slotEl(blocker);
                    if (el) EFTForge.workbench.flashConflict(el);
                }, 0);
            }
        } else if (parts[0] === 'att') {
            _loadout.attachments[parts[1]] = row.id;
        } else {
            const worn = _loadout.equipment[parts[1]];
            if (!worn) return;
            const old = worn.plates[parts[2]];
            worn.plates[parts[2]] = { id: row.id, durability: old ? old.durability : 100 };
        }
        _renderLeft();
        const wb = EFTForge.workbench;
        const slot = _slotEl(key);
        if (slot) wb.flashSlot(slot, 'install');
        if (parts[0] === 'eq') {
            document.querySelectorAll('#bw-left-armor [data-bw-slot]').forEach(function (node) {
                const el = /** @type {HTMLElement} */ (node);
                if (_isInsertOf(el.dataset.bwSlot, key)) wb.flashSlot(el, 'reveal');
            });
        }
        _scheduleRun();
    }

    // Empty slot `key`. Like the builder's removeAttachment: a table open on that slot, or on
    // one of the removed item's inserts, closes unless `keepTableOpen`; any other table stays
    // and refreshes, since what conflicts may have changed
    function _clearSlot(key, keepTableOpen) {
        const parts = key.split(':');
        if (parts[0] === 'ammo' || !_currentId(key)) return;
        const wb = EFTForge.workbench;
        const open = wb.pickerKey();
        const affected = open === key || (parts[0] === 'eq' && open !== null && _isInsertOf(open, key));
        if (affected && !keepTableOpen) wb.closePicker();
        if (parts[0] === 'eq') {
            delete _loadout.equipment[parts[1]];
            if (parts[1] === 'headwear') {
                _loadout.attachments = {};
                _loadout.attachmentDurability = {};
            }
        } else if (parts[0] === 'att') {
            delete _loadout.attachments[parts[1]];
            delete _loadout.attachmentDurability[parts[1]];
        } else {
            const worn = _loadout.equipment[parts[1]];
            if (worn) delete worn.plates[parts[2]];
        }
        _renderLeft();
        const slot = _slotEl(key);
        if (slot) wb.flashSlot(slot, 'remove');
        wb.refreshPicker();
        _scheduleRun();
    }

    function _slotEl(key) {
        return /** @type {HTMLElement | null} */ (document.querySelector('#bw-left-armor [data-bw-slot="' + key + '"]'));
    }

    /* ---- Slot images ---- */

    // TarkTetris's item icons: the game's full size inventory image, and for a helmet
    // wearing attachments a Kitbash! drawing of the whole thing (plates never show)
    const _helmetImages = new Map(); // build key -> data URL, null once it failed, or 'working'

    // The game's inventory tints at its 77/255 background alpha, as TarkTetris draws them
    const SLOT_COLORS = {
        blue: 'rgba(28, 65, 86, 0.302)', yellow: 'rgba(104, 102, 40, 0.302)', green: 'rgba(21, 45, 0, 0.302)',
        red: 'rgba(109, 36, 24, 0.302)', black: 'rgba(0, 0, 0, 0.302)', grey: 'rgba(29, 29, 29, 0.302)',
        violet: 'rgba(76, 42, 85, 0.302)', orange: 'rgba(60, 25, 0, 0.302)', default: 'rgba(127, 127, 127, 0.302)',
    };

    // Shared with the drop table's ammo slot
    function slotColorHtml(item) {
        const color = SLOT_COLORS[item.background_color] || SLOT_COLORS.default;
        return '<span class="bw-slot-color" style="background:' + color + '"></span>';
    }

    function _staticImage(item) {
        return item.image_link || item.base_image_link || item.icon_link || '';
    }

    // {url, working} for the worn helmet, or null to show its own image
    function _helmetImage(helmet) {
        const slots = Object.keys(_loadout.attachments).sort();
        if (!slots.length || (EFTForge.config && EFTForge.config.COMMUNITY_DISABLED)) return null;
        const key = helmet.id + '|' + slots.map(function (slot) { return slot + '=' + _loadout.attachments[slot]; }).join(',');
        const known = _helmetImages.get(key);
        if (known === 'working') return { url: null, working: true };
        if (known !== undefined) return known ? { url: known, working: false } : null;
        _helmetImages.set(key, 'working');
        _drawHelmet(key, helmet, slots);
        return { url: null, working: true };
    }

    async function _drawHelmet(key, helmet, slots) {
        // Kitbash! takes the build as SPT items; any 24 hex ids do
        const root = '000000000000000000000000';
        const items = [{ _id: root, _tpl: helmet.id, parentId: 'hideout', slotId: 'hideout' }].concat(slots.map(function (slot, i) {
            return { _id: root.slice(0, -2) + String(i + 1).padStart(2, '0'), _tpl: _loadout.attachments[slot], parentId: root, slotId: slot };
        }));
        let url = null;
        let retry = false;
        try {
            const res = await fetch(EFTForge.config.API_BASE + '/build-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: helmet.id, items: items, source: 'armor' }),
            });
            // Too many requests only holds for now, so the next look at this helmet asks again
            retry = res.status === 429;
            const data = res.ok ? await res.json() : null;
            url = data && data.image_url ? data.image_url : null;
        } catch (err) {
            retry = true;
            console.warn('[armor-sim] Kitbash! could not draw the helmet:', err);
        }
        if (retry) _helmetImages.delete(key);
        else _helmetImages.set(key, url);
        _refreshHelmetSlot(!retry);
    }

    // Swap the finished drawing (or the helmet's own image) into the slot, if it's still worn.
    // After a refused request we show the helmet's own image without asking again yet.
    function _refreshHelmetSlot(askAgain) {
        const slot = document.querySelector('#bw-left-armor [data-bw-slot="eq:headwear"]');
        const worn = _loadout.equipment.headwear;
        const helmet = worn ? _armorById(worn.id) : null;
        if (!slot || !helmet) return;
        const drawn = askAgain ? _helmetImage(helmet) : null;
        const img = /** @type {HTMLImageElement | null} */ (slot.querySelector('.bw-slot-icon'));
        if (img) img.src = (drawn && drawn.url) || _staticImage(helmet);
        slot.classList.toggle('kb-working-slot', !!(drawn && drawn.working));
        const body = slot.querySelector('.bw-slot-body');
        if (body && drawn && drawn.working && !body.querySelector('.kb-working-logo')) {
            body.insertAdjacentHTML('beforeend', _bpWorkingLogoHtml());
        }
    }

    /* ---- Armor class ---- */

    // What a carrier or rig is listed with: its best plate, counting the plates it comes
    // with; anything else its own armor, so a helmet shows the helmet's class
    function _listedClass(item) {
        let best = _maxClass(item);
        item.plate_slots.forEach(function (plateSlot) {
            const plate = plateSlot.default_id ? _armorById(plateSlot.default_id) : null;
            if (plate) best = Math.max(best, _maxClass(plate));
        });
        return best;
    }

    // A worn carrier counts the plates in it now instead
    function _wornClass(key, item) {
        const worn = key.indexOf('eq:') === 0 ? _loadout.equipment[key.slice(3)] : null;
        if (!worn || !item.plate_slots.length) return _maxClass(item);
        let best = _maxClass(item);
        Object.keys(worn.plates).forEach(function (name) {
            const plate = _armorById(worn.plates[name].id);
            if (plate) best = Math.max(best, _maxClass(plate));
        });
        return best;
    }

    function _defaultPlates(carrier) {
        const plates = {};
        carrier.plate_slots.forEach(function (plateSlot) {
            if (plateSlot.default_id && _armorById(plateSlot.default_id)) plates[plateSlot.slot] = { id: plateSlot.default_id, durability: 100 };
        });
        return plates;
    }

    function _defaultAttachments(helmet) {
        const attachments = {};
        _attachmentSlots(helmet).forEach(function (helmetSlot) {
            if (helmetSlot.default_id && _armorById(helmetSlot.default_id)) attachments[helmetSlot.slot] = helmetSlot.default_id;
        });
        return attachments;
    }

    // A helmet's slots that take armor, each with the armor items that fit it
    function _attachmentSlots(helmet) {
        return (helmet.attachment_slots || []).map(function (helmetSlot) {
            const rows = helmetSlot.allowed_ids.map(_armorById).filter(function (item) { return item && item.pieces.length > 0; });
            return Object.assign({ rows: rows }, helmetSlot);
        }).filter(function (helmetSlot) { return helmetSlot.rows.length > 0; });
    }

    /* ---- Conflicts ---- */

    function _equipmentOf(key) {
        const parts = key.split(':');
        return parts[0] === 'att' ? 'headwear' : parts[1];
    }

    // Every item in the loadout with its slot key, leaving out the slot about to be refilled
    // and, when that's a worn item, the plates and attachments that go with it
    function _present(skipKey) {
        const out = [];
        EQUIPMENT_SLOTS.forEach(function (slot) {
            const worn = _loadout.equipment[slot];
            const item = worn ? _armorById(worn.id) : null;
            if (!item || skipKey === 'eq:' + slot) return;
            out.push({ item: item, key: 'eq:' + slot });
            Object.keys(worn.plates).forEach(function (name) {
                const plate = _armorById(worn.plates[name].id);
                const key = 'plate:' + slot + ':' + name;
                if (plate && key !== skipKey) out.push({ item: plate, key: key });
            });
            if (slot !== 'headwear') return;
            Object.keys(_loadout.attachments).forEach(function (name) {
                const attachment = _armorById(_loadout.attachments[name]);
                const key = 'att:' + name;
                if (attachment && key !== skipKey) out.push({ item: attachment, key: key });
            });
        });
        return out;
    }

    // Why the game wouldn't let `item` into slot `key` next to the rest of the loadout, the
    // same rules POST /armor/simulate checks: {message, key of the slot in the way} or null
    function _conflictFor(item, key) {
        // An armored rig takes the body armor's place
        const rival = key === 'eq:rig' ? 'armor' : key === 'eq:armor' ? 'rig' : null;
        if (rival && _loadout.equipment[rival]) {
            const other = _armorById(_loadout.equipment[rival].id);
            return { message: _tFmt('armorSim.conflict.blocked', { item: other.name }), key: 'eq:' + rival };
        }
        return _partConflict({ item: item, key: key }, _present(key));
    }

    // Whether one part, headed for slot part.key, runs into anything in `present`
    function _partConflict(part, present) {
        const mine = _equipmentOf(part.key);
        for (const entry of present) {
            const other = entry.item;
            const theirs = _equipmentOf(entry.key);
            if (part.item.conflicting_ids.indexOf(other.id) !== -1 || other.conflicting_ids.indexOf(part.item.id) !== -1) {
                return { message: _tFmt('armorSim.conflict.item', { item: other.name }), key: entry.key };
            }
            if ((part.item.blocks_headwear && theirs === 'headwear' && mine !== 'headwear') ||
                (part.item.blocks_eyewear && theirs === 'eyewear' && mine !== 'eyewear') ||
                (other.blocks_headwear && mine === 'headwear' && theirs !== 'headwear') ||
                (other.blocks_eyewear && mine === 'eyewear' && theirs !== 'eyewear')) {
                return { message: _tFmt('armorSim.conflict.blocked', { item: other.name }), key: entry.key };
            }
        }
        return null;
    }

    // The plates or helmet attachments `item` would come with in equipment slot `key`
    function _defaultInserts(item, key) {
        const slot = key.split(':')[1];
        const out = [];
        if (slot === 'headwear') {
            const attachments = _defaultAttachments(item);
            Object.keys(attachments).forEach(function (name) {
                out.push({ item: _armorById(attachments[name]), key: 'att:' + name });
            });
        } else if (CARRIER_SLOTS.indexOf(slot) !== -1) {
            const plates = _defaultPlates(item);
            Object.keys(plates).forEach(function (name) {
                out.push({ item: _armorById(plates[name].id), key: 'plate:' + slot + ':' + name });
            });
        }
        return out.filter(function (part) { return part.item; });
    }

    function _highlightSlot() {
        document.querySelectorAll('#bw-left-armor [data-bw-slot]').forEach(function (node) {
            const row = /** @type {HTMLElement} */ (node);
            row.classList.toggle('active-slot', row.dataset.bwSlot === _activeSlot);
        });
    }

    // The item table doubles as the armor data sheet: every column the game's armor stats
    // give, with plate slots only where the slot holds carriers
    function _armorColumns(carriers) {
        const sum = function (field) { return function (item) { return item.pieces.reduce(function (t, p) { return t + (p[field] || 0); }, 0); }; };
        const durability = sum('durability');
        const effective = sum('effective_durability');
        const blunt = function (item) {
            return item.pieces.length ? Math.max.apply(null, item.pieces.map(function (p) { return p.blunt_throughput || 0; })) : null;
        };
        const areas = function (item) {
            const out = [];
            item.pieces.forEach(function (p) {
                p.body_colliders.concat(p.plate_colliders).forEach(function (c) { if (out.indexOf(c) === -1) out.push(c); });
            });
            return out;
        };
        const signedPct = function (fraction) {
            if (fraction == null || fraction === 0) return '';
            const pct = Math.round(fraction * 100);
            return (pct > 0 ? '+' : '') + pct + '%';
        };
        /** @type {any[]} */
        const columns = [
            { key: 'name', label: _t('sheets.col.name') },
            { key: 'armor_class', label: _t('armorSim.classShort'), tip: _t('armorSim.classTip'), render: function (r) { return String(_listedClass(r)); }, sort: _listedClass },
            { key: 'durability', label: _t('sheets.col.durability'), tip: _t('sheets.col.durabilityTip'), render: function (r) { return String(Math.round(durability(r))); }, sort: durability },
            { key: 'effective', label: _t('sheets.col.effective'), tip: _t('sheets.col.effectiveTip'), render: function (r) { return String(Math.round(effective(r))); }, sort: effective },
            { key: 'material', label: _t('sheets.col.material'), render: function (r) { return _esc(_materials(r)); }, sort: _materials },
            { key: 'blunt', label: _t('sheets.col.blunt'), tip: _t('sheets.col.bluntTip'), render: function (r) { return _bluntText(r); }, sort: blunt },
            { key: 'areas', label: _t('sheets.col.areas'), render: function (r) {
                const list = areas(r);
                return '<span data-tooltip="' + _esc(list.map(_areaName).join('\n')) + '">' + list.length + '</span>';
            }, sort: function (r) { return areas(r).length; } },
        ];
        if (carriers) {
            columns.push({ key: 'plate_slots', label: _t('sheets.col.plates'), render: function (r) { return r.plate_slots.length ? String(r.plate_slots.length) : ''; }, sort: function (r) { return r.plate_slots.length; } });
        }
        return columns.concat([
            { key: 'weight', label: _t('sheets.col.weight'), render: function (r) { return r.weight == null ? '' : r.weight.toFixed(2); } },
            { key: 'speed_penalty', label: _t('sheets.col.speed'), render: function (r) { return signedPct(r.speed_penalty); } },
            { key: 'turn_penalty', label: _t('sheets.col.turn'), render: function (r) { return signedPct(r.turn_penalty); } },
            { key: 'ergo_penalty', label: _t('sheets.col.ergo'), render: function (r) { return signedPct(r.ergo_penalty); } },
        ]);
    }

    function _bluntText(item) {
        if (!item.pieces.length) return '';
        const values = item.pieces.map(function (p) { return Math.round((p.blunt_throughput || 0) * 100); });
        const low = Math.min.apply(null, values);
        const high = Math.max.apply(null, values);
        return low === high ? low + '%' : low + '% - ' + high + '%';
    }

    function _areaName(area) {
        const key = 'armorSim.collider.' + area;
        const name = _t(key);
        return name !== key ? name : area.replace(/^Plate_/, '').replace(/_/g, ' ');
    }

    function _materials(item) {
        const out = [];
        item.pieces.forEach(function (p) {
            const name = _t('armorSim.material.' + p.material);
            if (out.indexOf(name) === -1) out.push(name);
        });
        return out.join(', ');
    }

    /* ---- Hints ---- */

    // Tell the player which worn pieces cover the chosen area, so an unprotected spot
    // doesn't look like a broken result
    function _updateHints() {
        const coverage = _el('as-coverage');
        if (!coverage) return;
        const collider = _settings.collider;
        const covering = [];
        _worn().forEach(function (item) {
            if (item.pieces.some(function (p) { return p.body_colliders.indexOf(collider) !== -1; })) {
                covering.push(item.short_name || item.name);
            }
        });
        coverage.textContent = covering.length
            ? _t('armorSim.coveredBy') + ' ' + covering.join(', ')
            : _t('armorSim.uncovered');
        coverage.classList.toggle('bw-uncovered', covering.length === 0);

        const plateZone = _plateZoneForArea();
        _el('as-plate-hit-wrap').hidden = !plateZone;
        if (plateZone) {
            const plateName = { plate: plateZone.plate.short_name || plateZone.plate.name };
            const label = _el('as-plate-hit-label');
            label.textContent = _tFmt('armorSim.plateHit', plateName);
            label.dataset.tooltip = _tFmt('armorSim.plateHitTip', plateName);
        }
    }

    // Every worn item plus the helmet's attachments
    function _worn() {
        const out = [];
        EQUIPMENT_SLOTS.forEach(function (slot) {
            const worn = _loadout.equipment[slot];
            const item = worn ? _armorById(worn.id) : null;
            if (item) out.push(item);
        });
        if (_loadout.equipment.headwear) {
            Object.keys(_loadout.attachments).forEach(function (name) {
                const item = _armorById(_loadout.attachments[name]);
                if (item) out.push(item);
            });
        }
        return out;
    }

    // The plate zone a shot into the chosen area goes through first, if a chosen plate covers it
    function _plateZoneForArea() {
        for (const slot of CARRIER_SLOTS) {
            const worn = _loadout.equipment[slot];
            const carrier = worn ? _armorById(worn.id) : null;
            if (!carrier) continue;
            for (const plateSlot of carrier.plate_slots) {
                const choice = worn.plates[plateSlot.slot];
                const plate = choice ? _armorById(choice.id) : null;
                if (!plate) continue;
                for (const zone of plateSlot.plate_colliders) {
                    const info = _zones.plates[zone];
                    const covers = plate.pieces.some(function (p) { return p.plate_colliders.indexOf(zone) !== -1; });
                    if (info && info.collider === _settings.collider && covers) return { zone: zone, plate: plate };
                }
            }
        }
        return null;
    }

    /* ===========================
       RUN
    =========================== */

    function _payload() {
        const attachments = Object.keys(_loadout.attachments).map(function (name) { return _loadout.attachments[name]; });
        const attachmentDurability = {};
        Object.keys(_loadout.attachments).forEach(function (name) {
            attachmentDurability[_loadout.attachments[name]] = _attachmentDurability(name);
        });
        const equipment = EQUIPMENT_SLOTS.filter(function (slot) { return _loadout.equipment[slot]; }).map(function (slot) {
            const worn = _loadout.equipment[slot];
            const plates = {};
            Object.keys(worn.plates).forEach(function (name) {
                plates[name] = { item_id: worn.plates[name].id, durability_percent: worn.plates[name].durability };
            });
            return {
                item_id: worn.id,
                durability_percent: worn.durability,
                piece_durability: worn.inserts || {},
                plates: plates,
                attachments: slot === 'headwear' ? attachments : [],
                attachment_durability: slot === 'headwear' ? attachmentDurability : {},
            };
        });
        const plateZone = _plateZoneForArea();
        return {
            ammo_id: _loadout.ammo,
            equipment: equipment,
            collider: _settings.collider,
            plate_collider: plateZone && _settings.throughPlate ? plateZone.zone : null,
            distance: _settings.distance,
            angle: _settings.angle,
            velocity_modifier_pct: _settings.velocity,
            max_shots: MAX_SHOTS,
        };
    }

    // Every change runs the simulation again once the player pauses, like the gun
    // builder's stats; a change while a run is out queues one more run after it
    function _scheduleRun(delay) {
        _updateHints();
        // Every change to the settings or loadout comes through here, so the tab saves it here
        EFTForge.workbench.saveToTab();
        clearTimeout(_runTimer);
        // A setup we already worked out shows at once, with no wait and no request
        if (!_running && _loadout.ammo) {
            const payload = _payload();
            const cached = _cachedResult(JSON.stringify(payload));
            if (cached) {
                _runTimer = null;
                _lastResult = { request: payload, response: cached };
                _renderRight();
                _markRunning();
                return;
            }
        }
        _runTimer = setTimeout(function () { _runTimer = null; _run(); }, delay == null ? RUN_DELAY : delay);
        _markRunning();
    }

    function _cachedResult(key) {
        const entry = _resultCache.get(key);
        if (!entry) return null;
        _resultCache.delete(key);
        if (Date.now() - entry.at > RESULT_CACHE_AGE_MS) return null;
        // Move it to the back so the setups the user flips between stay in
        _resultCache.set(key, entry);
        return entry.response;
    }

    function _cacheResult(key, response) {
        // A run cut short by the engine's deadline is partial, so work it out again next time
        if (!response || response.truncated) return;
        _resultCache.delete(key);
        _resultCache.set(key, { response: response, at: Date.now() });
        while (_resultCache.size > RESULT_CACHE_MAX) _resultCache.delete(_resultCache.keys().next().value);
    }

    function _markRunning() {
        const right = _el('bw-right-armor');
        if (right) right.classList.toggle('bw-running', (_running || !!_runTimer) && !!_lastResult);
        const showResults = _el('as-show-results');
        if (showResults) showResults.hidden = !_lastResult;
    }

    async function _run() {
        if (!_loadout.ammo) { _lastResult = null; _renderRight(); _markRunning(); return; }
        if (_running) { _runAgain = true; return; }
        _running = true;
        _runAgain = false;
        _markRunning();
        const payload = _payload();
        const requestKey = JSON.stringify(payload);
        try {
            // Worked out on the player's own machine, answered the way POST /armor/simulate would
            const res = await EFTForge.ballisticsLocal.simulate(payload, _engineData);
            const data = res.data;
            if (requestKey !== JSON.stringify(_payload())) {
                _runAgain = true;
                return;
            }
            if (!res.ok) {
                _lastResult = { error: _errorText(res.status, data) };
            } else {
                _lastResult = { request: payload, response: data };
                _cacheResult(requestKey, data);
            }
        } catch (err) {
            console.error('[armor-sim] simulate error:', err);
            if (requestKey === JSON.stringify(_payload())) _lastResult = { error: _t('armorSim.runError') };
            else _runAgain = true;
        } finally {
            _running = false;
            if (_runAgain) {
                _scheduleRun(RETRY_DELAY);
            } else {
                _renderRight();
                _markRunning();
            }
        }
    }

    function _errorText(status, data) {
        if (status === 429) return _t('armorSim.tooFast');
        const detail = data && data.detail;
        if (typeof detail === 'string') return detail;
        if (detail && detail.message) return detail.message;
        return _t('armorSim.runError');
    }

    /* ===========================
       RIGHT: RESULTS
    =========================== */

    function _renderRight() {
        const right = _el('bw-right-armor');
        if (!right) return;
        if (!_loadout.ammo || !_lastResult) {
            right.innerHTML = EFTForge.workbench.placeholderHtml({
                art: './assets/images/ballistics-loadout/' + SLOT_ART.ammo,
                main: _t(_loadout.ammo ? 'armorSim.running' : 'armorSim.pickAmmoFirst'),
                sub: _t(isMobileLayout() ? 'armorSim.swipeHint' : 'armorSim.rightClickHint'),
            });
            return;
        }
        if (_lastResult.error) {
            right.innerHTML = '<div class="ammo-error">' + _esc(_lastResult.error) + '</div>';
            return;
        }
        right.innerHTML = _resultsHtml(_lastResult);
        _wireShotChart(_lastResult);
        _markRunning();
        _el('as-compare-btn').addEventListener('click', function () { _compare(_lastResult.request); });
        // Only while the round is still one of its rows, so a round of another caliber drops it
        if (_lastCompare && _lastCompare.key === _compareKey(_payload()) &&
            _lastCompare.rows.some(function (row) { return row.ammo_id === _loadout.ammo; })) {
            _renderCompare(_lastCompare.rows, _loadout.ammo);
        }
    }

    function _resultsHtml(result) {
        const esc = _esc;
        const data = result.response;
        const ammo = _ammoById(result.request.ammo_id);
        const shots = data.shots || [];
        const area = _t('armorSim.collider.' + result.request.collider);

        let html = '<div class="att-table-header">' +
            (ammo && ammo.icon_link ? '<div class="att-table-icon-preview"><img class="att-table-gun-img" src="' + esc(ammo.icon_link) +
                '" alt=""><div class="slot-shortname">' + esc(ammo.short_name || '') + '</div></div>' : '') +
            '<h3>' + esc(ammo ? ammo.name : '') + ' &#x2192; <strong>' + esc(area) + '</strong></h3></div>';
        html += '<div class="bw-result-meta">' + esc(_tFmt('armorSim.target', {
            part: _t('armorSim.bodyPart.' + data.body_part), hp: data.hp, area: area,
        }));
        if (data.flight) {
            const f = data.flight;
            html += ' · ' + esc(_tFmt('armorSim.flight', {
                distance: Math.round(f.distance),
                speed: Math.round(f.speed),
                pct: Math.round(f.speed_ratio * 100),
                drop: Math.round(f.drop * 100),
                time: Math.round(f.time * 1000),
            }));
        }
        html += '</div>';

        const firstAt = function (chance) {
            const hit = shots.find(function (s) { return s.kill_chance >= chance; });
            const n = hit ? hit.shot : shots.length;
            return _tFmt(n === 1 && hit ? 'armorSim.stat.shot' : 'armorSim.stat.shots', { n: hit ? String(n) : '>' + n });
        };
        const cell = function (value, label) {
            return '<div class="bw-summary-cell"><span class="bw-summary-value">' + esc(value) +
                '</span><span class="bw-summary-label">' + esc(label) + '</span></div>';
        };
        html += '<div class="bw-summary">' +
            cell(firstAt(0.5), _t('armorSim.col.stk50')) +
            cell(firstAt(0.9), _t('armorSim.col.stk90')) +
            cell(shots.length ? _pct(shots[0].kill_chance) : '-', _t('armorSim.stat.firstShot')) +
            cell(data.flight ? Math.round(data.flight.speed) + ' m/s' : '-', _t('armorSim.stat.speed')) +
            '</div>';

        // Plates first, in the order the engine reports durabilities
        const plateCount = (data.plates || []).length;
        const layers = (data.plates || []).concat(data.soft_layers || []);
        html += '<h4 class="bw-subheading">' + esc(_t('armorSim.section.layers')) + '</h4>';
        if (layers.length === 0) {
            html += '<div class="bw-note">' + esc(_t('armorSim.noLayers')) + '</div>';
        } else {
            html += '<table class="attachment-table bw-table bw-static-table"><thead><tr><th>' + esc(_t('sheets.col.name')) + '</th><th>' +
                esc(_t('armorSim.classShort')) + '</th><th>' + esc(_t('sheets.col.durability')) + '</th><th>' +
                esc(_t('sheets.col.material')) + '</th></tr></thead><tbody>';
            layers.forEach(function (layer, i) {
                const item = _armorById(layer.item_id);
                const name = (i < plateCount || !item ? layer.name : item.name) || '';
                // Its layer number, matching the shot table's columns, and what kind of layer it is:
                // a built-in insert names itself with its picture, since its durability is the
                // insert's own rather than the whole item's
                const number = _tFmt('armorSim.col.layer', { n: i + 1 }) + ' · ';
                const tag = i >= plateCount && layer.slot
                    ? '<span class="bw-chip bw-chip-insert">' + esc(number) + _insertArtHtml({ slot: layer.slot }) +
                        esc(_insertName(layer.slot)) + '</span>'
                    : '<span class="bw-chip">' + esc(number + _layerKind(item, i < plateCount)) + '</span>';
                html += '<tr><td>' + _nameCell(item ? item.icon_link : null, item ? item.short_name : '', name, tag) + '</td>' +
                    '<td>' + layer.armor_class + '</td><td>' + _num(layer.durability) + ' / ' + _num(layer.max_durability) + '</td>' +
                    '<td>' + esc(_t('armorSim.material.' + layer.material)) + '</td></tr>';
            });
            html += '</tbody></table>';
        }

        html += '<h4 class="bw-subheading">' + esc(_t('armorSim.section.perShot')) + '</h4>';
        if (shots.length > 1) {
            html += '<div class="bw-card bw-chart-card bw-shot-chart">' +
                '<div class="bw-toggle-row">' + ['kill', 'armor'].map(function (view) {
                    const off = view === 'armor' && layers.length === 0;
                    return '<button type="button" class="toggle-btn' + (view === _shotChartView && !off ? ' active' : '') + '" data-as-chart="' + view + '"' +
                        (off ? ' disabled' : '') + '>' + esc(_t('armorSim.chart.' + view)) + '</button>';
                }).join('') + '</div><div id="as-shot-chart"></div></div>';
        }
        html += '<div class="bw-table-scroll"><table class="attachment-table bw-table bw-static-table bw-shot-table"><thead><tr><th>' +
            esc(_t('armorSim.col.shot')) + '</th><th>' + esc(_t('armorSim.col.kill')) + '</th><th data-tooltip="' +
            esc(_t('armorSim.col.hpTip')) + '">' + esc(_t('armorSim.col.hp')) + '</th>';
        layers.forEach(function (layer, i) {
            html += '<th data-tooltip="' + esc(layer.name || '') + '">' + esc(_tFmt('armorSim.col.layer', { n: i + 1 })) + '</th>';
        });
        html += '</tr></thead><tbody>';
        shots.forEach(function (s) {
            html += '<tr><td>' + s.shot + '</td><td><div class="bw-chance"><div class="bw-chance-track"><div class="bw-chance-fill" style="width:' +
                (s.kill_chance * 100).toFixed(1) + '%"></div></div><span>' + _pct(s.kill_chance) + '</span></div></td><td>' +
                (s.hp_alive == null ? '-' : _num(s.hp_alive)) + '</td>';
            layers.forEach(function (_, i) {
                const d = s.durability_alive ? s.durability_alive[i] : null;
                html += '<td>' + (d == null ? '-' : _num(d)) + '</td>';
            });
            html += '</tr>';
        });
        html += '</tbody></table></div>';

        if (data.spread_hp > 0) {
            html += '<div class="bw-note">' + esc(_tFmt('armorSim.spread', {
                part: _t('armorSim.bodyPart.' + data.body_part), hp: data.hp, spread: Math.round(data.spread_hp),
            })) + '</div>';
        }
        if (data.projectiles > 1) html += '<div class="bw-note">' + esc(_tFmt('armorSim.pellets', { n: data.projectiles })) + '</div>';
        if (data.truncated) html += '<div class="bw-note bw-warn">' + esc(_t('armorSim.truncated')) + '</div>';
        html += '<div class="bw-note">' + esc(_t('armorSim.method')) + '</div>';

        html += '<h4 class="bw-subheading">' + esc(_t('armorSim.section.compare')) + '</h4>' +
            '<div class="bw-note">' + esc(_t('armorSim.compareHint')) + '</div>' +
            '<button type="button" class="modal-btn primary bw-compare-btn" id="as-compare-btn">' + esc(_t('armorSim.compare')) + '</button>' +
            '<div id="as-compare"></div>';
        return html;
    }

    let _shotChartView = 'kill';

    // Kill chance by shot, or what each layer has left of its durability
    function _wireShotChart(result) {
        const host = _el('as-shot-chart');
        if (!host) return;
        const data = result.response;
        const layers = (data.plates || []).concat(data.soft_layers || []);
        const view = layers.length === 0 ? 'kill' : _shotChartView;
        document.querySelectorAll('#bw-right-armor [data-as-chart]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                _shotChartView = /** @type {HTMLElement} */ (btn).dataset.asChart;
                document.querySelectorAll('#bw-right-armor [data-as-chart]').forEach(function (other) { other.classList.toggle('active', other === btn); });
                _wireShotChart(result);
            });
        });
        const shots = data.shots || [];
        const colors = EFTForge.bwCharts.SERIES_COLORS;
        let series;
        if (view === 'kill') {
            series = [{ name: _t('armorSim.chart.kill'), color: colors[0], points: shots.map(function (s) { return { x: s.shot, y: s.kill_chance * 100 }; }) }];
        } else {
            // The chart keeps to three lines to stay readable, and the outer layers matter most
            series = layers.slice(0, colors.length).map(function (layer, i) {
                return {
                    name: _tFmt('armorSim.col.layer', { n: i + 1 }),
                    color: colors[i],
                    points: shots.filter(function (s) { return s.durability_alive && s.durability_alive[i] != null; }).map(function (s) {
                        return { x: s.shot, y: layer.max_durability ? s.durability_alive[i] / layer.max_durability * 100 : 0 };
                    }),
                };
            });
        }
        EFTForge.bwCharts.line(host, {
            series: series,
            xLabel: _t('armorSim.col.shot'),
            yLabel: _t(view === 'kill' ? 'armorSim.chart.killAxis' : 'armorSim.chart.armorAxis'),
            yMin: 0,
            yMax: 100,
            integerX: true,
            dots: shots.length <= 30,
            xFormat: function (x) { return String(x); },
            yFormat: function (y) { return Math.round(y) + '%'; },
            tipTitle: function (x) { return _tFmt('armorSim.chart.shotN', { n: x }); },
            tipValue: function (y) { return (Math.round(y * 10) / 10).toFixed(1) + '%'; },
            refs: view === 'kill' ? [{ y: 50, label: _t('armorSim.col.stk50') }, { y: 90, label: _t('armorSim.col.stk90') }] : [],
        });
    }

    // A carrier's own layer is its soft armor; anything else on the head goes by its slot
    function _layerKind(item, isPlate) {
        if (isPlate) return _t('armorSim.layerPlate');
        if (!item || CARRIER_SLOTS.indexOf(item.equipment_slot) !== -1) return _t('armorSim.layerSoft');
        return _t('armorSim.slot.' + (item.equipment_slot || 'attachment'));
    }

    // tagHtml is a ready built chip, so a chip can carry a picture
    function _nameCell(icon, shortName, name, tagHtml) {
        return '<div class="attachment-name-wrapper"><div class="attachment-icon-wrapper">' +
            (icon ? '<img src="' + _esc(icon) + '" class="attachment-icon" alt="" loading="lazy" decoding="async">' : '') +
            '<div class="slot-shortname">' + _esc(shortName || '') + '</div></div>' +
            '<div class="att-name-and-rating"><div class="attachment-name-text">' + _esc(name) +
            (tagHtml ? ' ' + tagHtml : '') + '</div></div></div>';
    }

    /* ===========================
       COMPARE
    =========================== */

    let _comparing = false;
    let _lastCompare = null;    // { key, rows }: stays open while the user switches between its rounds

    // Every setting but the round itself, so picking another round from the table keeps it
    function _compareKey(request) {
        const rest = Object.assign({}, request);
        delete rest.ammo_id;
        return JSON.stringify(rest);
    }

    // Every round in the same caliber against the same armor and target, ranked
    async function _compare(request) {
        if (_comparing) return;
        _comparing = true;
        const btn = _el('as-compare-btn');
        const box = _el('as-compare');
        btn.disabled = true;
        box.innerHTML = '<div class="bw-note">' + _esc(_t('armorSim.comparing')) + '</div>';
        try {
            const res = await EFTForge.ballisticsLocal.compare(request, _engineData);
            const data = res.data;
            if (!res.ok) {
                box.innerHTML = '<div class="ammo-error">' + _esc(_errorText(res.status, data)) + '</div>';
                return;
            }
            if (box.isConnected && _compareKey(request) === _compareKey(_payload())) {
                _lastCompare = { key: _compareKey(request), rows: data.ammo || [] };
                _renderCompare(_lastCompare.rows, _loadout.ammo);
            }
        } catch (err) {
            console.error('[armor-sim] compare error:', err);
            box.innerHTML = '<div class="ammo-error">' + _esc(_t('armorSim.runError')) + '</div>';
        } finally {
            _comparing = false;
            if (btn.isConnected) btn.disabled = false;
        }
    }

    function _renderCompare(rows, currentId) {
        const rank = function (row) { return row.shots_to_kill_50 == null ? Infinity : row.shots_to_kill_50; };
        rows.sort(function (a, b) {
            return rank(a) - rank(b) || (b.penetration - a.penetration);
        });
        let html = '<table class="attachment-table bw-table bw-compare-table"><thead><tr><th>' + _esc(_t('armorSim.col.ammo')) +
            '</th><th>' + _esc(_t('armorSim.col.dmgPen')) + '</th><th>' + _esc(_t('armorSim.col.stk50')) +
            '</th><th>' + _esc(_t('armorSim.col.stk90')) + '</th></tr></thead><tbody>';
        rows.forEach(function (row) {
            const ammo = _ammoById(row.ammo_id);
            const damage = row.projectiles > 1 ? row.projectiles + '×' + row.damage : String(row.damage);
            const stk = function (value) {
                if (row.skipped) return _esc(_t('armorSim.compareSkipped'));
                return value == null ? '>' + MAX_SHOTS : String(value);
            };
            html += '<tr class="bw-compare-row' + (row.ammo_id === currentId ? ' attachment-row-installed' : '') +
                '" tabindex="0" data-ammo="' + _esc(row.ammo_id) + '"><td>' +
                _nameCell(ammo ? ammo.icon_link : null, ammo ? ammo.short_name : '', ammo ? ammo.name : row.name, null) +
                '</td><td>' + _esc(damage) + ' / ' + row.penetration + '</td><td>' + stk(row.shots_to_kill_50) +
                '</td><td>' + stk(row.shots_to_kill_90) + '</td></tr>';
        });
        html += '</tbody></table>';
        const box = _el('as-compare');
        if (!box) return;
        box.innerHTML = html;
        box.querySelectorAll('.bw-compare-row').forEach(function (tr) {
            const pick = function () {
                const ammo = _ammoById(/** @type {HTMLElement} */ (tr).dataset.ammo);
                if (!ammo || ammo.id === _loadout.ammo) return;
                _install('ammo', ammo);
                EFTForge.workbench.refreshPicker();
            };
            tr.addEventListener('click', pick);
            tr.addEventListener('keydown', function (event) {
                const key = /** @type {KeyboardEvent} */ (event).key;
                if (key === 'Enter' || key === ' ') { event.preventDefault(); pick(); }
            });
        });
    }

    /* ===========================
       HELPERS
    =========================== */

    function _ammoById(id) {
        return id ? (_ammo || []).find(function (row) { return row.id === id; }) || null : null;
    }

    function _armorById(id) {
        return id ? (_armor || []).find(function (item) { return item.id === id; }) || null : null;
    }

    function _maxClass(item) {
        return item.pieces.reduce(function (best, p) { return Math.max(best, p.armor_class || 0); }, 0);
    }

    function _plateSlotName(slotName) {
        const key = 'armorSim.plateSlot.' + slotName.toLowerCase();
        const label = _t(key);
        return label === key ? slotName.replace(/_/g, ' ') : label;
    }

    /** @returns {any} */
    function _el(id) { return document.getElementById(id); }

    function _lang() { return (EFTForge.state && EFTForge.state.lang) || 'en'; }

    function _t(key) { return (EFTForge.lang && EFTForge.lang.t) ? EFTForge.lang.t(key) : key; }

    function _tFmt(key, vars) { return (EFTForge.lang && EFTForge.lang.tFmt) ? EFTForge.lang.tFmt(key, vars) : key; }

    function _esc(text) { return EFTForge.utils.escapeHtml(String(text == null ? '' : text)); }

    function _pct(chance) {
        const pct = chance * 100;
        if (pct > 0 && pct < 0.1) return '<0.1%';
        if (pct < 100 && pct > 99.9) return '>99.9%';
        return pct.toFixed(1) + '%';
    }

    function _num(n) { return (Math.round(n * 10) / 10).toFixed(1); }

    return {
        show: show, reset: reset, onLangChange: onLangChange, openFromBuild: openFromBuild, slotColorHtml: slotColorHtml,
        getState: getState, setState: setState,
    };

}());
