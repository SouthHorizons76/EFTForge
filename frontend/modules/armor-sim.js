window.EFTForge = window.EFTForge || {};

/* ============================================================
   ARMOR SIMULATOR
   Second tab of the Ballistics drawer. Pick ammo, range, the spot that gets hit and
   the armor worn, and POST /armor/simulate works out the kill chance and armor wear
   shot by shot. The page only collects inputs and draws results; every number comes
   from the backend engine.
============================================================ */

window.EFTForge.armorSim = (function () {

    // The order the area picker lists colliders in. Which body part each one drains comes
    // from /armor/zones; only head and thorax areas show, since a stomach at 0 HP doesn't kill.
    const AREA_ORDER = ['ParietalHead', 'BackHead', 'Ears', 'Eyes', 'Jaw', 'HeadCommon',
                        'RibcageUp', 'SpineTop', 'LeftSideChestUp', 'RightSideChestUp', 'NeckFront', 'NeckBack'];
    const BODY_PART_FOR = { head: 'Head', thorax: 'Chest' };
    const CARRIER_SLOTS = ['rig', 'armor'];
    // In the order the game checks them
    const EQUIPMENT_SLOTS = ['headwear', 'face_cover', 'eyewear', 'rig', 'armor'];
    const ATTACHMENT_SELECTS = 2;
    const MAX_SHOTS = 30;
    const TAB_KEY = 'eftforge_ballistics_tab';

    let _armor = null;          // GET /armor/items
    let _ammo = null;           // GET /ammo/all, keyed by caliber
    let _zones = null;          // GET /armor/zones
    let _dataLang = null;
    let _loading = null;
    let _running = false;
    let _bodyPart = 'thorax';
    let _lastResult = null;

    /* ===========================
       TABS
    =========================== */

    function _showTab(tab) {
        const onArmor = tab === 'armor';
        _el('ammo-table-body').hidden = onArmor;
        _el('armor-sim-body').hidden = !onArmor;
        _el('ammo-tab-table').classList.toggle('active', !onArmor);
        _el('ammo-tab-armor').classList.toggle('active', onArmor);
        try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
        if (onArmor && _isPanelOpen()) _open();
    }

    function init() {
        const tableTab = _el('ammo-tab-table');
        const armorTab = _el('ammo-tab-armor');
        if (!tableTab || !armorTab) return;
        tableTab.addEventListener('click', function () { _showTab('table'); });
        armorTab.addEventListener('click', function () { _showTab('armor'); });
        _updateTabLabels();
        let saved = null;
        try { saved = localStorage.getItem(TAB_KEY); } catch { /* private mode */ }
        if (saved === 'armor') _showTab('armor');
    }

    function _updateTabLabels() {
        const tableTab = _el('ammo-tab-table');
        const armorTab = _el('ammo-tab-armor');
        if (tableTab) tableTab.textContent = _t('ammo.tab.table');
        if (armorTab) armorTab.textContent = _t('ammo.tab.armor');
    }

    // ammo-table.js calls this when the drawer opens, so we only load once it's seen
    function onPanelShow() {
        const body = _el('armor-sim-body');
        if (body && !body.hidden) _open();
    }

    function onLangChange() {
        _updateTabLabels();
        const body = _el('armor-sim-body');
        if (body && !body.hidden && _isPanelOpen()) _open();
        else _dataLang = null;  // names are baked into the cached data; refetch on next open
    }

    function _isPanelOpen() {
        const overlay = _el('ammo-overlay');
        return !!overlay && overlay.classList.contains('visible');
    }

    /* ===========================
       DATA
    =========================== */

    async function _open() {
        const lang = _lang();
        if (_armor && _ammo && _zones && _dataLang === lang) {
            if (!_el('as-form')) _renderForm();
            return;
        }
        const body = _el('armor-sim-body');
        body.innerHTML = '<div class="ammo-loading">' + _t('armorSim.loading') + '</div>';
        if (!_loading) {
            _loading = Promise.all([
                EFTForge.api.catalogFetch('/armor/items?lang=' + lang),
                EFTForge.api.catalogFetch('/ammo/all?lang=' + lang),
                EFTForge.api.catalogFetch('/armor/zones'),
            ]).then(async function ([armorRes, ammoRes, zonesRes]) {
                if (!armorRes.ok || !ammoRes.ok || !zonesRes.ok) {
                    throw new Error('HTTP ' + armorRes.status + '/' + ammoRes.status + '/' + zonesRes.status);
                }
                _armor = await armorRes.json();
                _ammo = await ammoRes.json();
                _zones = await zonesRes.json();
                _dataLang = lang;
            }).finally(function () { _loading = null; });
        }
        try {
            await _loading;
            _renderForm();
        } catch (err) {
            console.error('[armor-sim] load error:', err);
            body.innerHTML = '<div class="ammo-error">' + _t('armorSim.loadError') + '</div>';
        }
    }

    function _ammoById(id) {
        for (const cal in _ammo) {
            const row = (_ammo[cal] || []).find(function (r) { return r.id === id; });
            if (row) return row;
        }
        return null;
    }

    function _armorById(id) {
        return (_armor || []).find(function (item) { return item.id === id; }) || null;
    }

    function _usableAmmo(row) {
        return row.penetration_power != null && row.damage != null && row.armor_damage != null;
    }

    function _maxClass(item) {
        return item.pieces.reduce(function (best, p) { return Math.max(best, p.armor_class || 0); }, 0);
    }

    /* ===========================
       FORM
    =========================== */

    function _renderForm() {
        const body = _el('armor-sim-body');
        const esc = EFTForge.utils.escapeHtml;

        let equipmentHtml = '';
        EQUIPMENT_SLOTS.forEach(function (slot) {
            equipmentHtml += _equipmentRow('as-eq-' + slot, _t('armorSim.slot.' + slot), _itemsForSlot(slot));
            if (slot === 'headwear') {
                for (let i = 0; i < ATTACHMENT_SELECTS; i++) {
                    equipmentHtml += _equipmentRow('as-att-' + i, _t('armorSim.slot.attachment'), _helmetAttachments(), true);
                }
            }
        });

        body.innerHTML = `
            <div class="armor-sim-layout" id="as-form">
                <div class="armor-sim-inputs">
                    <div class="armor-sim-note">${esc(_t('armorSim.intro'))}</div>

                    <div class="armor-sim-section-title">${esc(_t('armorSim.section.shot'))}</div>
                    <label class="armor-sim-field">
                        <span>${esc(_t('armorSim.ammo'))}</span>
                        <select id="as-ammo">${_ammoOptions()}</select>
                    </label>
                    <div class="armor-sim-row">
                        <label class="armor-sim-field">
                            <span>${esc(_t('armorSim.distance'))}</span>
                            <input type="number" id="as-distance" min="0" max="1000" step="5" value="50">
                        </label>
                        <label class="armor-sim-field">
                            <span title="${esc(_t('armorSim.velocityTip'))}">${esc(_t('armorSim.velocity'))}</span>
                            <input type="number" id="as-velocity" min="-90" max="200" step="0.1" value="0">
                        </label>
                    </div>
                    <button type="button" class="armor-sim-link-btn" id="as-use-build">${esc(_t('armorSim.useBuild'))}</button>

                    <div class="armor-sim-section-title">${esc(_t('armorSim.section.target'))}</div>
                    <div class="modal-row armor-sim-toggle">
                        <button type="button" class="toggle-btn" data-part="thorax">${esc(_t('armorSim.part.thorax'))}</button>
                        <button type="button" class="toggle-btn" data-part="head">${esc(_t('armorSim.part.head'))}</button>
                    </div>
                    <label class="armor-sim-field">
                        <span>${esc(_t('armorSim.area'))}</span>
                        <select id="as-area"></select>
                    </label>
                    <div class="armor-sim-coverage" id="as-coverage"></div>
                    <label class="armor-sim-check" id="as-plate-hit-wrap" hidden>
                        <input type="checkbox" id="as-plate-hit" checked>
                        <span id="as-plate-hit-label"></span>
                    </label>

                    <div class="armor-sim-section-title">${esc(_t('armorSim.section.armor'))}</div>
                    ${equipmentHtml}

                    <button type="button" class="armor-sim-run" id="as-run">${esc(_t('armorSim.run'))}</button>
                </div>
                <div class="armor-sim-results" id="as-results">
                    <div class="armor-sim-placeholder">${esc(_t('armorSim.placeholder'))}</div>
                </div>
            </div>`;

        body.querySelectorAll('.armor-sim-toggle .toggle-btn').forEach(function (btn) {
            btn.addEventListener('click', function () { _setBodyPart(btn.dataset.part); });
        });
        // Plate rows come and go with the chosen carrier, so listen on the whole form
        _el('as-form').addEventListener('change', function (event) {
            const target = /** @type {HTMLElement} */ (event.target);
            const carrier = CARRIER_SLOTS.find(function (slot) { return target.id === 'as-eq-' + slot; });
            if (carrier) _renderPlateRows(carrier);
            _updateHints();
        });
        _el('as-use-build').addEventListener('click', _useBuild);
        _el('as-run').addEventListener('click', _run);

        _setBodyPart(_bodyPart);
        if (EFTForge.state && EFTForge.state.currentGun) _useBuild();
        if (_lastResult) _renderResults(_lastResult);
    }

    function _equipmentRow(id, label, items, isAttachment) {
        const esc = EFTForge.utils.escapeHtml;
        let options = '<option value="">' + esc(_t('armorSim.none')) + '</option>';
        items.forEach(function (item) {
            options += '<option value="' + esc(item.id) + '">' + esc(item.name) +
                ' (' + esc(_t('armorSim.classShort')) + ' ' + _maxClass(item) + ')</option>';
        });
        const durability = isAttachment ? '' :
            '<input type="number" class="armor-sim-dura" id="' + id + '-dura" min="0" max="100" step="1" value="100" title="' +
            esc(_t('armorSim.durabilityTip')) + '"><span class="armor-sim-pct">%</span>';
        const plates = CARRIER_SLOTS.some(function (slot) { return id === 'as-eq-' + slot; })
            ? '<div class="armor-sim-plates" id="' + id + '-plates"></div>' : '';
        return '<div class="armor-sim-equip' + (isAttachment ? ' armor-sim-equip-sub' : '') + '">' +
            '<span class="armor-sim-equip-label">' + esc(label) + '</span>' +
            '<select id="' + id + '">' + options + '</select>' + durability + '</div>' + plates;
    }

    // One plate picker per plate slot on the chosen carrier, listing only plates that fit
    function _renderPlateRows(slot) {
        const container = _el('as-eq-' + slot + '-plates');
        const carrier = _armorById(_el('as-eq-' + slot).value);
        const esc = EFTForge.utils.escapeHtml;
        if (!carrier) { container.innerHTML = ''; return; }
        container.innerHTML = carrier.plate_slots.map(function (plateSlot) {
            const id = 'as-plate-' + slot + '-' + plateSlot.slot;
            let options = '<option value="">' + esc(_t('armorSim.none')) + '</option>';
            plateSlot.allowed_plate_ids.map(_armorById).filter(Boolean).forEach(function (plate) {
                options += '<option value="' + esc(plate.id) + '">' + esc(plate.name) +
                    ' (' + esc(_t('armorSim.classShort')) + ' ' + _maxClass(plate) + ')</option>';
            });
            return '<div class="armor-sim-equip armor-sim-equip-plate">' +
                '<span class="armor-sim-equip-label">' + esc(_plateSlotName(plateSlot.slot)) + '</span>' +
                '<select id="' + esc(id) + '" data-plate-slot="' + esc(plateSlot.slot) + '">' + options + '</select>' +
                '<input type="number" class="armor-sim-dura" id="' + esc(id) + '-dura" min="0" max="100" step="1" value="100" title="' +
                esc(_t('armorSim.durabilityTip')) + '"><span class="armor-sim-pct">%</span></div>';
        }).join('');
    }

    function _plateSlotName(slotName) {
        const key = 'armorSim.plateSlot.' + slotName.toLowerCase();
        const label = _t(key);
        return label === key ? slotName.replace(/_/g, ' ') : label;
    }

    // {slot name: {item_id, durability_percent}} for the plates chosen on one carrier
    function _chosenPlates(slot) {
        const out = {};
        const container = _el('as-eq-' + slot + '-plates');
        if (!container) return out;
        container.querySelectorAll('select[data-plate-slot]').forEach(function (sel) {
            const select = /** @type {HTMLSelectElement} */ (sel);
            if (!select.value) return;
            const dura = parseFloat(_el(select.id + '-dura').value);
            out[select.dataset.plateSlot] = {
                item_id: select.value,
                durability_percent: isFinite(dura) ? Math.min(Math.max(dura, 0), 100) : 100,
            };
        });
        return out;
    }

    // The plate zone a shot into the chosen area goes through first, if a chosen plate covers it
    function _plateZoneForArea() {
        const collider = _el('as-area').value;
        for (const slot of CARRIER_SLOTS) {
            const carrier = _armorById(_el('as-eq-' + slot).value);
            if (!carrier) continue;
            const chosen = _chosenPlates(slot);
            for (const plateSlot of carrier.plate_slots) {
                const choice = chosen[plateSlot.slot];
                if (!choice) continue;
                const plate = _armorById(choice.item_id);
                for (const zone of plateSlot.plate_colliders) {
                    const info = _zones.plates[zone];
                    const covers = plate && plate.pieces.some(function (p) { return p.plate_colliders.indexOf(zone) !== -1; });
                    if (info && info.collider === collider && covers) return { zone: zone, plate: plate };
                }
            }
        }
        return null;
    }

    function _itemsForSlot(slot) {
        return (_armor || []).filter(function (item) {
            return item.equipment_slot === slot && item.pieces.length > 0;
        });
    }

    function _helmetAttachments() {
        // Face shields, ear armor and the like: attachments that protect body areas (not plates)
        return (_armor || []).filter(function (item) {
            return item.kind === 'attachment' && item.pieces.some(function (p) { return p.body_colliders.length > 0; });
        });
    }

    function _ammoOptions() {
        const esc = EFTForge.utils.escapeHtml;
        const calName = function (cal) {
            const map = (EFTForge.config && EFTForge.config.CALIBER_DISPLAY_MAP) || {};
            return map[cal] || cal;
        };
        let html = '';
        Object.keys(_ammo || {}).sort(function (a, b) { return calName(a).localeCompare(calName(b)); }).forEach(function (cal) {
            const rows = (_ammo[cal] || []).filter(_usableAmmo);
            if (rows.length === 0) return;
            html += '<optgroup label="' + esc(calName(cal)) + '">';
            rows.slice().sort(function (a, b) { return (a.penetration_power || 0) - (b.penetration_power || 0); }).forEach(function (r) {
                const pellets = r.projectile_count || 1;
                const damage = pellets > 1 ? pellets + '×' + r.damage : String(r.damage);
                html += '<option value="' + esc(r.id) + '">' + esc(r.name) + ' (' + damage + ' / ' + r.penetration_power + ')</option>';
            });
            html += '</optgroup>';
        });
        return html;
    }

    function _setBodyPart(part) {
        _bodyPart = part;
        document.querySelectorAll('#armor-sim-body .armor-sim-toggle .toggle-btn').forEach(function (btn) {
            btn.classList.toggle('active', /** @type {HTMLElement} */ (btn).dataset.part === part);
        });
        const area = _el('as-area');
        const esc = EFTForge.utils.escapeHtml;
        const wanted = BODY_PART_FOR[part];
        area.innerHTML = AREA_ORDER.filter(function (collider) {
            return _zones.body_parts[collider] === wanted;
        }).map(function (collider) {
            return '<option value="' + collider + '">' + esc(_t('armorSim.collider.' + collider)) + '</option>';
        }).join('');
        _updateHints();
    }

    function _useBuild() {
        const ammoSelect = _el('ammo-select');
        const simAmmo = _el('as-ammo');
        if (ammoSelect && ammoSelect.value && simAmmo.querySelector('option[value="' + ammoSelect.value + '"]')) {
            simAmmo.value = ammoSelect.value;
        }
        const pct = EFTForge.state && EFTForge.state.lastVelocityModifierPct;
        if (pct != null) _el('as-velocity').value = String(Math.round(pct * 100) / 100);
    }

    function _equippedItems() {
        return EQUIPMENT_SLOTS.map(function (slot) {
            const id = _el('as-eq-' + slot).value;
            return id ? { slot: slot, item: _armorById(id) } : null;
        }).filter(Boolean);
    }

    function _attachmentItems() {
        const ids = [];
        for (let i = 0; i < ATTACHMENT_SELECTS; i++) {
            const id = _el('as-att-' + i).value;
            if (id && ids.indexOf(id) === -1) ids.push(id);
        }
        return ids.map(_armorById).filter(Boolean);
    }

    // Tell the player which worn pieces cover the chosen area, so an unprotected spot
    // doesn't look like a broken result
    function _updateHints() {
        const coverage = _el('as-coverage');
        if (!coverage) return;
        const collider = _el('as-area').value;
        const covering = [];
        const helmetChosen = !!_el('as-eq-headwear').value;
        _equippedItems().forEach(function (entry) {
            if (entry.item.pieces.some(function (p) { return p.body_colliders.indexOf(collider) !== -1; })) {
                covering.push(entry.item.short_name || entry.item.name);
            }
        });
        if (helmetChosen) {
            _attachmentItems().forEach(function (item) {
                if (item.pieces.some(function (p) { return p.body_colliders.indexOf(collider) !== -1; })) {
                    covering.push(item.short_name || item.name);
                }
            });
        }
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

    /* ===========================
       RUN
    =========================== */

    function _payload() {
        const attachments = _attachmentItems().map(function (item) { return item.id; });
        const equipment = _equippedItems().map(function (entry) {
            const dura = parseFloat(_el('as-eq-' + entry.slot + '-dura').value);
            return {
                item_id: entry.item.id,
                durability_percent: isFinite(dura) ? Math.min(Math.max(dura, 0), 100) : 100,
                plates: CARRIER_SLOTS.indexOf(entry.slot) !== -1 ? _chosenPlates(entry.slot) : {},
                attachments: entry.slot === 'headwear' ? attachments : [],
            };
        });
        const plateZone = _plateZoneForArea();
        const throughPlate = !!plateZone && _el('as-plate-hit').checked;
        const distance = parseFloat(_el('as-distance').value);
        const velocity = parseFloat(_el('as-velocity').value);
        return {
            ammo_id: _el('as-ammo').value,
            equipment: equipment,
            collider: _el('as-area').value,
            plate_collider: throughPlate ? plateZone.zone : null,
            distance: isFinite(distance) ? Math.min(Math.max(distance, 0), 1000) : 0,
            velocity_modifier_pct: isFinite(velocity) ? velocity : 0,
            max_shots: MAX_SHOTS,
        };
    }

    async function _run() {
        if (_running) return;
        const payload = _payload();
        if (!payload.ammo_id) return;
        _running = true;
        const btn = _el('as-run');
        btn.disabled = true;
        btn.textContent = _t('armorSim.running');
        const results = _el('as-results');
        try {
            const res = await fetch(EFTForge.config.API_BASE + '/armor/simulate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(function () { return null; });
            if (!res.ok) {
                results.innerHTML = '<div class="ammo-error">' + EFTForge.utils.escapeHtml(_errorText(res.status, data)) + '</div>';
                return;
            }
            _lastResult = { request: payload, response: data };
            _renderResults(_lastResult);
        } catch (err) {
            console.error('[armor-sim] simulate error:', err);
            results.innerHTML = '<div class="ammo-error">' + EFTForge.utils.escapeHtml(_t('armorSim.runError')) + '</div>';
        } finally {
            _running = false;
            btn.disabled = false;
            btn.textContent = _t('armorSim.run');
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
       RESULTS
    =========================== */

    function _renderResults(result) {
        const results = _el('as-results');
        if (!results) return;
        const esc = EFTForge.utils.escapeHtml;
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

        results.innerHTML = `
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
                    <div>${esc(_tFmt('armorSim.target', { part: _t(data.body_part === 'Head' ? 'armorSim.part.head' : 'armorSim.part.thorax'), hp: data.hp, area: _t('armorSim.collider.' + result.request.collider) }))}</div>
                    ${flightHtml}
                </div>
            </div>
            <div class="armor-sim-section-title">${esc(_t('armorSim.section.layers'))}</div>
            ${layersHtml}
            <div class="armor-sim-section-title">${esc(_t('armorSim.section.chance'))}</div>
            ${barsHtml}
            <div class="armor-sim-section-title">${esc(_t('armorSim.section.perShot'))}</div>
            ${tableHtml}
            ${data.projectiles > 1 ? '<div class="armor-sim-note">' + esc(_tFmt('armorSim.pellets', { n: data.projectiles })) + '</div>' : ''}
            <div class="armor-sim-note">${esc(_t('armorSim.method'))}</div>`;
    }

    /* ===========================
       HELPERS
    =========================== */

    /** @returns {any} */
    function _el(id) { return document.getElementById(id); }

    function _lang() { return (EFTForge.state && EFTForge.state.lang) || 'en'; }

    function _t(key) {
        return (EFTForge.lang && EFTForge.lang.t) ? EFTForge.lang.t(key) : key;
    }

    function _tFmt(key, vars) {
        return (EFTForge.lang && EFTForge.lang.tFmt) ? EFTForge.lang.tFmt(key, vars) : key;
    }

    function _pct(chance) {
        const pct = chance * 100;
        if (pct > 0 && pct < 0.1) return '<0.1%';
        if (pct < 100 && pct > 99.9) return '>99.9%';
        return pct.toFixed(1) + '%';
    }

    function _num(n) { return (Math.round(n * 10) / 10).toFixed(1); }

    // Scripts load at the end of <body>, so the drawer's markup is already there
    init();

    return { onLangChange: onLangChange, onPanelShow: onPanelShow };

}());
