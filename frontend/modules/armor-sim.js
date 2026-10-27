window.EFTForge = window.EFTForge || {};

/* ============================================================
   ARMOR SIMULATOR
   Keep shot settings, target controls and the equipment layout on the left. Open an
   item table on the right when a slot is clicked; clear equipment on right click.
   Run POST /armor/simulate after changes and show kill chance and armor wear on the right.
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
        thorax: ['Chest'],
        head: ['Head'],
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
    const ATTACHMENT_SLOTS = 2;
    const MAX_SHOTS = 30;
    const RUN_DELAY = 450;
    const RETRY_DELAY = 1100;

    let _armor = null;          // GET /armor/items
    let _ammo = null;           // GET /ammo/all, flattened
    let _zones = null;          // GET /armor/zones
    let _dataLang = null;
    let _loading = null;

    const _settings = { distance: 50, angle: 0, velocity: 0, part: 'thorax', collider: 'RibcageUp', throughPlate: true };
    // ammo: id; equipment: {slot: {id, durability, plates: {plate slot: {id, durability}}}}; attachments: [id]
    const _loadout = { ammo: null, equipment: {}, attachments: [] };
    let _activeSlot = null;     // the slot whose picker is open, highlighted on the left
    let _appliedSnapshot = 0;   // the last build snapshot we filled in from

    let _lastResult = null;
    let _runTimer = null;
    let _running = false;
    let _runAgain = false;

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
        _applySnapshot();
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

    // The stats panel's "vs armor" button: open the workbench on this tool with the build
    async function openFromBuild() {
        const wb = EFTForge.workbench;
        if (!wb) return;
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
            _dataLang = lang;
        }).finally(function () { _loading = null; });
        return _loading;
    }

    // Fill in the ammo and velocity of the build the workbench was just opened from
    function _applySnapshot() {
        const snap = EFTForge.workbench && EFTForge.workbench.buildSnapshot();
        if (!snap || snap.serial === _appliedSnapshot) return;
        _appliedSnapshot = snap.serial;
        if (snap.ammoId && _ammoById(snap.ammoId)) _loadout.ammo = snap.ammoId;
        if (snap.velocityPct != null) _settings.velocity = Math.round(snap.velocityPct * 100) / 100;
        _scheduleRun();
    }

    /* ===========================
       LEFT: SETTINGS, TARGET, LOADOUT
    =========================== */

    function _renderLeft() {
        const left = _el('bw-left-armor');
        _disposeAreaSelect();
        const snap = EFTForge.workbench && EFTForge.workbench.buildSnapshot();
        left.innerHTML = `
            <div class="stats-section bw-section">
                <div class="section-title">${_esc(_t('armorSim.section.shot'))}</div>
                <div class="armor-sim-row">
                    <label class="armor-sim-field"><span>${_esc(_t('armorSim.distance'))}</span>
                        <input type="number" id="as-distance" min="0" max="1000" step="5" value="${_settings.distance}"></label>
                    <label class="armor-sim-field"><span data-tooltip="${_esc(_t('armorSim.angleTip'))}">${_esc(_t('armorSim.angle'))}</span>
                        <input type="number" id="as-angle" min="0" max="89" step="5" value="${_settings.angle}"></label>
                    <label class="armor-sim-field"><span data-tooltip="${_esc(_t('armorSim.velocityTip'))}">${_esc(_t('armorSim.velocity'))}</span>
                        <input type="number" id="as-velocity" min="-90" max="200" step="0.1" value="${_settings.velocity}"></label>
                </div>
                ${snap ? '<button type="button" class="armor-sim-link-btn" id="as-use-build">' +
                    _esc(_tFmt('armorSim.useLastBuild', { gun: snap.gunName })) + '</button>' : ''}
            </div>
            <div class="stats-section bw-section">
                <div class="section-title">${_esc(_t('armorSim.section.target'))}</div>
                <div class="modal-row armor-sim-toggle">
                    ${Object.keys(BODY_PARTS_FOR).map(function (part) {
                        return '<button type="button" class="toggle-btn' + (part === _settings.part ? ' active' : '') +
                            '" data-part="' + part + '">' + _esc(_t('armorSim.part.' + part)) + '</button>';
                    }).join('')}
                </div>
                <div class="armor-sim-field"><label for="as-area" id="as-area-label">${_esc(_t('armorSim.area'))}</label><select id="as-area">${_areaOptions()}</select></div>
                <div class="armor-sim-coverage" id="as-coverage"></div>
                <div class="optimizer-toggle-row" id="as-plate-hit-wrap" hidden>
                    <span id="as-plate-hit-label"></span>
                    <button type="button" class="compare-toggle${_settings.throughPlate ? ' active' : ''}" id="as-plate-hit" role="switch" aria-checked="${_settings.throughPlate}" aria-labelledby="as-plate-hit-label">
                        <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                    </button>
                </div>
            </div>
            <div class="stats-section bw-section">
                <div class="section-title">${_esc(_t('armorSim.section.loadout'))}
                    <span class="bw-slot-hint">${_esc(_t(isMobileLayout() ? 'armorSim.swipeHint' : 'armorSim.rightClickHint'))}</span></div>
                <div class="bw-slots">${_slotsHtml()}</div>
            </div>
            <button type="button" class="armor-sim-run bw-mobile-only" id="as-show-results">${_esc(_t('armorSim.showResults'))}</button>`;

        const areaSelect = setupCustomSelect('as-area');
        if (areaSelect) areaSelect.querySelector('.custom-select-trigger').setAttribute('aria-labelledby', 'as-area-label');
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
            _el(spec.id).addEventListener('input', function (event) {
                const value = parseFloat(/** @type {HTMLInputElement} */ (event.target).value);
                if (!isFinite(value)) return;
                _settings[spec.key] = Math.min(Math.max(value, spec.low), spec.high);
                _scheduleRun();
            });
            _el(spec.id).addEventListener('change', function (event) {
                /** @type {HTMLInputElement} */ (event.target).value = String(_settings[spec.key]);
            });
        });
        const useBuild = _el('as-use-build');
        if (useBuild) useBuild.addEventListener('click', function () {
            _appliedSnapshot = 0;
            _applySnapshot();
            _renderLeft();
        });
        // Phones keep the results in the drawer, which nothing else here opens
        _el('as-show-results').addEventListener('click', function () { openMobileRightPanel(); });
        _wireSlots(left);
        _updateHints();
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

    /* ---- Slots ---- */

    // Match TarkTetris's headwear, face cover, body armor and eyewear positions.
    // Use the free left-hand position for the rig and keep ammo outside the worn gear.
    function _slotsHtml() {
        let html = '<div class="bw-loadout-equipment">';
        ['headwear', 'face_cover', 'rig', 'armor', 'eyewear'].forEach(function (slot) {
            const worn = _loadout.equipment[slot];
            const item = worn ? _armorById(worn.id) : null;
            html += _slotCard('eq:' + slot, _t('armorSim.slot.' + slot), item, worn ? worn.durability : null, slot);
        });
        html += '</div><div class="bw-loadout-ammo">' +
            _slotCard('ammo', _t('armorSim.slot.ammo'), _ammoById(_loadout.ammo), null, 'ammo') + '</div>';
        ['headwear', 'rig', 'armor'].forEach(function (slot) {
            const worn = _loadout.equipment[slot];
            const item = worn ? _armorById(worn.id) : null;
            if (!item) return;
            let children = '';
            if (slot === 'headwear') {
                for (let i = 0; i < ATTACHMENT_SLOTS; i++) {
                    children += _slotCard('att:' + i, _t('armorSim.slot.attachment') + ' ' + (i + 1),
                        _armorById(_loadout.attachments[i]), null, 'attachment');
                }
            }
            if (CARRIER_SLOTS.indexOf(slot) !== -1) {
                item.plate_slots.forEach(function (plateSlot) {
                    const plate = worn.plates[plateSlot.slot];
                    children += _slotCard('plate:' + slot + ':' + plateSlot.slot, _plateSlotName(plateSlot.slot),
                        plate ? _armorById(plate.id) : null, plate ? plate.durability : null, 'plate');
                });
            }
            if (children) {
                html += '<section class="bw-loadout-children" aria-label="' + _esc(item.name) + '">' +
                    '<div class="bw-loadout-parent"><span>' + _esc(_t('armorSim.slot.' + slot)) + '</span>' +
                    '<span class="bw-loadout-parent-name">' + _esc(item.short_name || item.name) + '</span></div>' +
                    '<div class="bw-loadout-inserts">' + children + '</div></section>';
            }
        });
        return html;
    }

    function _slotCard(key, label, item, durability, kind) {
        const active = key === _activeSlot ? ' active-slot' : '';
        const placeholder = '<img class="bw-slot-placeholder" src="./assets/images/ballistics-loadout/' + SLOT_ART[kind] + '" alt="">';
        const visual = '<span class="bw-slot-visual">' + placeholder +
            (item && item.icon_link ? '<img class="bw-slot-image" src="' + _esc(item.icon_link) +
                '" alt="" loading="lazy" decoding="async" onerror="this.remove()">' : '') + '</span>';
        const name = item ? item.short_name || item.name : '';
        const armorClass = item && kind !== 'ammo' ? _maxClass(item) : 0;
        const dura = durability == null ? '' :
            '<label class="bw-slot-dura" data-tooltip="' + _esc(_t('armorSim.durabilityTip')) + '">' +
            '<span class="bw-slot-dura-label">' + _esc(_t('sheets.col.durability')) + '</span>' +
            '<input type="number" class="armor-sim-dura" data-dura-for="' + _esc(key) +
            '" aria-label="' + _esc(label + ' - ' + _t('sheets.col.durability')) +
            '" min="0" max="100" step="1" value="' + durability + '"><span>%</span></label>';
        return '<div class="bw-slot bw-gear-card bw-gear-' + kind + active + (item ? ' is-equipped' : '') +
            '" data-bw-slot="' + _esc(key) + '">' +
            '<button type="button" class="bw-slot-pick" aria-label="' + _esc(_tFmt('armorSim.pickTitle', { slot: label })) +
            '"' + (item ? ' data-tooltip="' + _esc(item.name) + '"' : '') + '>' +
            '<span class="bw-slot-label">' + _esc(label) + '</span>' + visual +
            (item ? '<span class="bw-slot-caption">' + _esc(name) + '</span>' : '') + '</button>' +
            (armorClass ? '<span class="bw-slot-class">' + _esc(_t('armorSim.classShort')) + ' ' + armorClass + '</span>' : '') +
            dura + '</div>';
    }

    function _wireSlots(root) {
        root.querySelectorAll('[data-bw-slot]').forEach(function (node) {
            const row = /** @type {HTMLElement} */ (node);
            const key = row.dataset.bwSlot;
            row.addEventListener('click', function (event) {
                if (/** @type {Element} */ (event.target).closest('.bw-slot-dura')) return;
                _openSlot(key);
            });
            row.addEventListener('contextmenu', function (event) {
                if (/** @type {Element} */ (event.target).closest('.bw-slot-dura')) return;
                event.preventDefault();
                EFTForge.workbench.closePicker();
                _clearSlot(key);
            });
            if (key !== 'ammo') addSwipeToRemove(row, function () {
                EFTForge.workbench.closePicker();
                _clearSlot(key);
            });
        });
        root.querySelectorAll('[data-dura-for]').forEach(function (node) {
            const input = /** @type {HTMLInputElement} */ (node);
            input.addEventListener('click', function (event) { event.stopPropagation(); });
            input.addEventListener('input', function () {
                const value = parseFloat(input.value);
                if (!isFinite(value)) return;
                const target = _slotTarget(input.dataset.duraFor);
                if (target) target.durability = Math.min(Math.max(value, 0), 100);
                _scheduleRun();
            });
            input.addEventListener('change', function () {
                const target = _slotTarget(input.dataset.duraFor);
                if (target) input.value = String(target.durability);
            });
        });
    }

    // The loadout entry a durability box edits: a worn item or a plate in one of its slots
    function _slotTarget(key) {
        const parts = key.split(':');
        if (parts[0] === 'eq') return _loadout.equipment[parts[1]] || null;
        if (parts[0] === 'plate') {
            const worn = _loadout.equipment[parts[1]];
            return worn ? worn.plates[parts[2]] || null : null;
        }
        return null;
    }

    function _openSlot(key) {
        const wb = EFTForge.workbench;
        const parts = key.split(':');
        let rows;
        let selected = null;
        let title;
        let onPick;
        let onClear = null;
        if (parts[0] === 'ammo') {
            rows = _ammo;
            selected = _loadout.ammo;
            title = _t('armorSim.slot.ammo');
            onPick = function (row) { _loadout.ammo = row.id; };
        } else if (parts[0] === 'eq') {
            const slot = parts[1];
            rows = _armor.filter(function (item) { return item.equipment_slot === slot && item.pieces.length > 0; });
            selected = _loadout.equipment[slot] ? _loadout.equipment[slot].id : null;
            title = _t('armorSim.slot.' + slot);
            onPick = function (row) {
                const old = _loadout.equipment[slot];
                _loadout.equipment[slot] = { id: row.id, durability: old ? old.durability : 100, plates: {} };
                if (slot === 'headwear') _loadout.attachments = [];
            };
            if (selected) onClear = function () { _clearSlot(key); };
        } else if (parts[0] === 'att') {
            const index = Number(parts[1]);
            rows = _armor.filter(function (item) {
                return item.kind === 'attachment' && item.pieces.some(function (p) { return p.body_colliders.length > 0; });
            });
            selected = _loadout.attachments[index] || null;
            title = _t('armorSim.slot.attachment');
            onPick = function (row) { _loadout.attachments[index] = row.id; };
            if (selected) onClear = function () { _clearSlot(key); };
        } else {
            const worn = _loadout.equipment[parts[1]];
            const carrier = worn ? _armorById(worn.id) : null;
            const plateSlot = carrier ? carrier.plate_slots.find(function (s) { return s.slot === parts[2]; }) : null;
            if (!plateSlot) return;
            rows = plateSlot.allowed_plate_ids.map(_armorById).filter(Boolean);
            selected = worn.plates[parts[2]] ? worn.plates[parts[2]].id : null;
            title = _plateSlotName(parts[2]);
            onPick = function (row) {
                const old = worn.plates[parts[2]];
                worn.plates[parts[2]] = { id: row.id, durability: old ? old.durability : 100 };
            };
            if (selected) onClear = function () { _clearSlot(key); };
        }
        wb.openPicker({
            title: _tFmt('armorSim.pickTitle', { slot: title }),
            rows: rows,
            columns: parts[0] === 'ammo' ? _ammoColumns() : _armorColumns(),
            selectedId: selected,
            sort: parts[0] === 'ammo' ? { key: 'penetration_power', asc: false } : { key: 'armor_class', asc: false },
            onPick: function (row) {
                onPick(row);
                _renderLeft();
                _scheduleRun();
            },
            onClear: onClear,
            onClose: function () {
                _activeSlot = null;
                _highlightSlot();
            },
        });
        _activeSlot = key;
        _highlightSlot();
    }

    function _clearSlot(key) {
        const parts = key.split(':');
        if (parts[0] === 'ammo') return; // a run always needs a round
        if (parts[0] === 'eq') {
            delete _loadout.equipment[parts[1]];
            if (parts[1] === 'headwear') _loadout.attachments = [];
        } else if (parts[0] === 'att') {
            _loadout.attachments[Number(parts[1])] = null;
        } else {
            const worn = _loadout.equipment[parts[1]];
            if (worn) delete worn.plates[parts[2]];
        }
        _renderLeft();
        _scheduleRun();
    }

    function _highlightSlot() {
        document.querySelectorAll('#bw-left-armor [data-bw-slot]').forEach(function (node) {
            const row = /** @type {HTMLElement} */ (node);
            row.classList.toggle('active-slot', row.dataset.bwSlot === _activeSlot);
        });
    }

    function _ammoColumns() {
        return [
            { key: 'name', label: _t('sheets.col.name') },
            { key: 'caliber', label: _t('armorSim.col.caliber'), render: function (r) { return _esc(_calName(r.caliber)); }, sort: function (r) { return _calName(r.caliber); } },
            { key: 'damage', label: _t('armorSim.col.damage'), render: function (r) { return (r.projectile_count || 1) > 1 ? r.projectile_count + '×' + r.damage : String(r.damage); }, sort: function (r) { return r.damage * (r.projectile_count || 1); } },
            { key: 'penetration_power', label: _t('armorSim.col.pen'), render: function (r) { return String(r.penetration_power); } },
            { key: 'armor_damage', label: _t('armorSim.col.armorDamage'), render: function (r) { return r.armor_damage + '%'; } },
            { key: 'velocity', label: _t('armorSim.col.speed'), render: function (r) { return r.velocity ? String(Math.round(r.velocity)) : ''; } },
        ];
    }

    function _armorColumns() {
        const sum = function (field) { return function (item) { return item.pieces.reduce(function (t, p) { return t + (p[field] || 0); }, 0); }; };
        const durability = sum('durability');
        const effective = sum('effective_durability');
        return [
            { key: 'name', label: _t('sheets.col.name') },
            { key: 'armor_class', label: _t('armorSim.classShort'), render: function (r) { return String(_maxClass(r)); }, sort: _maxClass },
            { key: 'durability', label: _t('sheets.col.durability'), render: function (r) { return String(Math.round(durability(r))); }, sort: durability },
            { key: 'effective', label: _t('sheets.col.effective'), tip: _t('sheets.col.effectiveTip'), render: function (r) { return String(Math.round(effective(r))); }, sort: effective },
            { key: 'material', label: _t('sheets.col.material'), render: function (r) { return _esc(_materials(r)); }, sort: _materials },
            { key: 'weight', label: _t('sheets.col.weight'), render: function (r) { return r.weight == null ? '' : r.weight.toFixed(2); } },
            { key: 'price', label: _t('sheets.col.price'), render: function (r) { return r.trader_price_rub ? r.trader_price_rub.toLocaleString() + ' ₽' : ''; }, sort: function (r) { return r.trader_price_rub; } },
        ];
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
        coverage.classList.toggle('armor-sim-uncovered', covering.length === 0);

        const plateZone = _plateZoneForArea();
        _el('as-plate-hit-wrap').hidden = !plateZone;
        if (plateZone) {
            _el('as-plate-hit-label').textContent = _tFmt('armorSim.plateHit', { plate: plateZone.plate.short_name || plateZone.plate.name });
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
            _loadout.attachments.forEach(function (id) { const item = _armorById(id); if (item) out.push(item); });
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
        const attachments = _loadout.attachments.filter(Boolean);
        const equipment = EQUIPMENT_SLOTS.filter(function (slot) { return _loadout.equipment[slot]; }).map(function (slot) {
            const worn = _loadout.equipment[slot];
            const plates = {};
            Object.keys(worn.plates).forEach(function (name) {
                plates[name] = { item_id: worn.plates[name].id, durability_percent: worn.plates[name].durability };
            });
            return {
                item_id: worn.id,
                durability_percent: worn.durability,
                plates: plates,
                attachments: slot === 'headwear' ? attachments : [],
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
        _lastResult = null;
        _renderRight();
        clearTimeout(_runTimer);
        _runTimer = setTimeout(_run, delay == null ? RUN_DELAY : delay);
    }

    async function _run() {
        if (!_loadout.ammo) { _renderRight(); return; }
        if (_running) { _runAgain = true; return; }
        _running = true;
        _runAgain = false;
        const payload = _payload();
        const requestKey = JSON.stringify(payload);
        const right = _el('bw-right-armor');
        right.classList.add('bw-running');
        try {
            const res = await fetch(EFTForge.config.API_BASE + '/armor/simulate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(function () { return null; });
            if (requestKey !== JSON.stringify(_payload())) {
                _runAgain = true;
                return;
            }
            if (res.status === 429) {
                // We asked again too soon: try once more in a moment
                _runAgain = true;
            } else if (!res.ok) {
                _lastResult = { error: _errorText(res.status, data) };
            } else {
                _lastResult = { request: payload, response: data };
            }
        } catch (err) {
            console.error('[armor-sim] simulate error:', err);
            if (requestKey === JSON.stringify(_payload())) _lastResult = { error: _t('armorSim.runError') };
            else _runAgain = true;
        } finally {
            _running = false;
            right.classList.remove('bw-running');
            _renderRight();
            if (_runAgain) _scheduleRun(RETRY_DELAY);
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
        if (!_loadout.ammo) {
            right.innerHTML = '<div class="armor-sim-placeholder">' + _esc(_t('armorSim.pickAmmoFirst')) + '</div>';
            return;
        }
        if (!_lastResult) {
            right.innerHTML = '<div class="armor-sim-placeholder">' + _esc(_t('armorSim.running')) + '</div>';
            return;
        }
        if (_lastResult.error) {
            right.innerHTML = '<div class="ammo-error">' + _esc(_lastResult.error) + '</div>';
            return;
        }
        right.innerHTML = _resultsHtml(_lastResult);
        _el('as-compare-btn').addEventListener('click', function () { _compare(_lastResult.request); });
    }

    function _resultsHtml(result) {
        const esc = _esc;
        const data = result.response;
        const ammo = _ammoById(result.request.ammo_id);
        const shots = data.shots || [];
        const firstAt = function (chance) {
            const hit = shots.find(function (s) { return s.kill_chance >= chance; });
            return hit ? String(hit.shot) : '>' + shots.length;
        };

        let flightHtml = '';
        if (data.flight) {
            const f = data.flight;
            flightHtml = '<div class="armor-sim-flight">' + esc(_tFmt('armorSim.flight', {
                distance: Math.round(f.distance),
                speed: Math.round(f.speed),
                pct: Math.round(f.speed_ratio * 100),
                drop: Math.round(f.drop * 100),
                time: Math.round(f.time * 1000),
            })) + '</div>';
        }

        // Plates first, in the order the engine reports durabilities
        const plateCount = (data.plates || []).length;
        const layers = (data.plates || []).concat(data.soft_layers || []);
        let layersHtml = '<div class="armor-sim-layers">';
        if (layers.length === 0) {
            layersHtml += '<div class="armor-sim-note">' + esc(_t('armorSim.noLayers')) + '</div>';
        }
        layers.forEach(function (layer, i) {
            const tag = i < plateCount ? ' <span class="armor-sim-layer-tag">' + esc(_t('armorSim.layerPlate')) + '</span>' : '';
            layersHtml += '<div class="armor-sim-layer"><span class="armor-sim-layer-idx">' + (i + 1) + '</span>' +
                '<span class="armor-sim-layer-name">' + esc(layer.name || '') + tag + '</span>' +
                '<span class="armor-sim-layer-stat">' + esc(_t('armorSim.classShort')) + ' ' + layer.armor_class + '</span>' +
                '<span class="armor-sim-layer-stat">' + _num(layer.durability) + ' / ' + _num(layer.max_durability) + '</span>' +
                '<span class="armor-sim-layer-stat">' + esc(_t('armorSim.material.' + layer.material)) + '</span></div>';
        });
        layersHtml += '</div>';

        let barsHtml = '<div class="armor-sim-bars">';
        shots.forEach(function (s) {
            const pct = s.kill_chance * 100;
            barsHtml += '<div class="armor-sim-bar-row"><span class="armor-sim-bar-label">' + s.shot + '</span>' +
                '<div class="armor-sim-bar-track"><div class="armor-sim-bar-fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
                '<span class="armor-sim-bar-value">' + _pct(s.kill_chance) + '</span></div>';
        });
        barsHtml += '</div>';

        let tableHtml = '<table class="armor-sim-table"><thead><tr><th>' + esc(_t('armorSim.col.shot')) + '</th><th>' +
            esc(_t('armorSim.col.kill')) + '</th><th title="' + esc(_t('armorSim.col.hpTip')) + '">' + esc(_t('armorSim.col.hp')) + '</th>';
        layers.forEach(function (layer, i) {
            tableHtml += '<th title="' + esc(layer.name || '') + '">' + esc(_tFmt('armorSim.col.layer', { n: i + 1 })) + '</th>';
        });
        tableHtml += '</tr></thead><tbody>';
        shots.forEach(function (s) {
            tableHtml += '<tr><td>' + s.shot + '</td><td>' + _pct(s.kill_chance) + '</td><td>' +
                (s.hp_alive == null ? '-' : _num(s.hp_alive)) + '</td>';
            layers.forEach(function (_, i) {
                const d = s.durability_alive ? s.durability_alive[i] : null;
                tableHtml += '<td>' + (d == null ? '-' : _num(d)) + '</td>';
            });
            tableHtml += '</tr>';
        });
        tableHtml += '</tbody></table>';

        return `
            <div class="armor-sim-summary">
                <div class="armor-sim-big">
                    <span class="armor-sim-big-value">${esc(firstAt(0.5))}</span>
                    <span class="armor-sim-big-label">${esc(_t('armorSim.shotsToKill50'))}</span>
                </div>
                <div class="armor-sim-big">
                    <span class="armor-sim-big-value">${esc(firstAt(0.9))}</span>
                    <span class="armor-sim-big-label">${esc(_t('armorSim.shotsToKill90'))}</span>
                </div>
                <div class="armor-sim-big-meta">
                    <div class="armor-sim-ammo-name">${esc(ammo ? ammo.name : '')}</div>
                    <div>${esc(_tFmt('armorSim.target', { part: _t('armorSim.bodyPart.' + data.body_part), hp: data.hp, area: _t('armorSim.collider.' + result.request.collider) }))}</div>
                    ${flightHtml}
                </div>
            </div>
            <div class="armor-sim-section-title">${esc(_t('armorSim.section.layers'))}</div>
            ${layersHtml}
            <div class="armor-sim-section-title">${esc(_t('armorSim.section.chance'))}</div>
            ${barsHtml}
            <div class="armor-sim-section-title">${esc(_t('armorSim.section.perShot'))}</div>
            <div class="bw-table-scroll">${tableHtml}</div>
            ${data.spread_hp > 0 ? '<div class="armor-sim-note">' + esc(_tFmt('armorSim.spread', {
                part: _t('armorSim.bodyPart.' + data.body_part), hp: data.hp, spread: Math.round(data.spread_hp),
            })) + '</div>' : ''}
            ${data.projectiles > 1 ? '<div class="armor-sim-note">' + esc(_tFmt('armorSim.pellets', { n: data.projectiles })) + '</div>' : ''}
            ${data.truncated ? '<div class="armor-sim-note armor-sim-warn">' + esc(_t('armorSim.truncated')) + '</div>' : ''}
            <div class="armor-sim-note">${esc(_t('armorSim.method'))}</div>
            <div class="armor-sim-section-title">${esc(_t('armorSim.section.compare'))}</div>
            <div class="armor-sim-note">${esc(_t('armorSim.compareHint'))}</div>
            <button type="button" class="armor-sim-link-btn" id="as-compare-btn">${esc(_t('armorSim.compare'))}</button>
            <div id="as-compare"></div>`;
    }

    /* ===========================
       COMPARE
    =========================== */

    let _comparing = false;

    // Every round in the same caliber against the same armor and target, ranked
    async function _compare(request) {
        if (_comparing) return;
        _comparing = true;
        const btn = _el('as-compare-btn');
        const box = _el('as-compare');
        btn.disabled = true;
        box.innerHTML = '<div class="armor-sim-note">' + _esc(_t('armorSim.comparing')) + '</div>';
        try {
            const res = await fetch(EFTForge.config.API_BASE + '/armor/compare', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
            });
            const data = await res.json().catch(function () { return null; });
            if (!res.ok) {
                box.innerHTML = '<div class="ammo-error">' + _esc(_errorText(res.status, data)) + '</div>';
                return;
            }
            if (box.isConnected && JSON.stringify(request) === JSON.stringify(_payload())) {
                _renderCompare(data.ammo || [], request.ammo_id);
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
        let html = '<div class="bw-table-scroll"><table class="armor-sim-table armor-sim-compare"><thead><tr><th>' + _esc(_t('armorSim.col.ammo')) +
            '</th><th>' + _esc(_t('armorSim.col.dmgPen')) + '</th><th>' + _esc(_t('armorSim.col.stk50')) +
            '</th><th>' + _esc(_t('armorSim.col.stk90')) + '</th></tr></thead><tbody>';
        rows.forEach(function (row) {
            const ammo = _ammoById(row.ammo_id);
            const name = ammo ? ammo.name : row.name;
            const damage = row.projectiles > 1 ? row.projectiles + '×' + row.damage : String(row.damage);
            const stk = function (value) {
                if (row.skipped) return _esc(_t('armorSim.compareSkipped'));
                return value == null ? '>' + MAX_SHOTS : String(value);
            };
            html += '<tr class="armor-sim-compare-row' + (row.ammo_id === currentId ? ' is-current' : '') +
                '" data-ammo="' + _esc(row.ammo_id) + '"><td>' + _esc(name) + '</td><td>' + _esc(damage) + ' / ' +
                row.penetration + '</td><td>' + stk(row.shots_to_kill_50) + '</td><td>' + stk(row.shots_to_kill_90) + '</td></tr>';
        });
        html += '</tbody></table></div>';
        const box = _el('as-compare');
        if (!box) return;
        box.innerHTML = html;
        box.querySelectorAll('.armor-sim-compare-row').forEach(function (tr) {
            tr.addEventListener('click', function () {
                const id = /** @type {HTMLElement} */ (tr).dataset.ammo;
                if (!_ammoById(id)) return;
                _loadout.ammo = id;
                _renderLeft();
                _scheduleRun(0);
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

    function _calName(cal) {
        const map = (EFTForge.config && EFTForge.config.CALIBER_DISPLAY_MAP) || {};
        return map[cal] || cal || '';
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

    return { show: show, onLangChange: onLangChange, openFromBuild: openFromBuild };

}());
