window.EFTForge = window.EFTForge || {};

/* ============================================================
   BALLISTICS TOOLS
   Three of the Ballistics Workbench's tools, each with its controls in the left panel
   and its table in the right one: the precomputed ammo effectiveness chart
   (GET /armor/chart), the armor and plate data sheets (GET /armor/items) and the drop
   and zeroing table (POST /ammo/flight). ballistics-workbench.js calls show().
============================================================ */

window.EFTForge.ballisticsTools = (function () {

    const CHART_KINDS = ['body', 'plate', 'helmet'];
    const SHEET_KINDS = ['armor', 'rig', 'helmet', 'plate', 'face_cover', 'eyewear', 'attachment'];

    let _data = null;           // { lang, armor, armorById, ammo, ammoById, chart }
    let _loading = null;

    let _chartKind = 'body';
    let _chartCaliber = '';
    let _chartLevel = 0;        // 0 = shots for a 50% kill chance, 1 = for 90%

    let _sheetKind = 'armor';
    let _sheetSearch = '';
    let _sheetSort = { col: 'armor_class', asc: false };

    let _flightWeapon = null;   // the build's weapon, whose default ammo sets the zero
    let _flightSnapshot = 0;    // the last build snapshot the drop table filled in from
    let _flightRunning = false;
    let _flightResult = null;
    let _flightRevision = 0;
    const _flightSettings = { ammo: '', zero: 100, sight: 5, max: 500, step: 25, velocity: 0 };

    /* ===========================
       PUBLIC
    =========================== */

    async function show(tool) {
        const left = _el('bw-left-' + tool);
        if (!left) return;
        try {
            if (!_data || _data.lang !== _lang()) {
                left.innerHTML = '<div class="ammo-loading">' + _esc(_t('armorSim.loading')) + '</div>';
                await _load();
                if (_data.lang !== _lang()) return show(tool);
            }
        } catch (err) {
            console.error('[ballistics-tools] load error:', err);
            left.innerHTML = '<div class="ammo-error">' + _esc(_t('armorSim.loadError')) + '</div>';
            return;
        }
        if (tool === 'chart') _renderChart();
        else if (tool === 'sheets') _renderSheets();
        else if (tool === 'flight') _showFlight();
    }

    function onLangChange() {
        _saveFlightSettings();
        _data = null;
        _flightResult = null;
        _flightRevision++;
        // The drop table's form is only built once, so drop it to rebuild in the new language
        const flightLeft = _el('bw-left-flight');
        const select = _el('dt-ammo-custom');
        if (select) select.dispatchEvent(new Event('eftforge:dispose-select'));
        if (flightLeft) flightLeft.innerHTML = '';
        const wb = EFTForge.workbench;
        if (wb && wb.isActive() && ['chart', 'sheets', 'flight'].indexOf(wb.currentTool()) !== -1) show(wb.currentTool());
    }

    /* ===========================
       DATA
    =========================== */

    function _load() {
        if (_loading) return _loading;
        const lang = _lang();
        _loading = Promise.all([
            EFTForge.api.catalogFetch('/armor/items?lang=' + lang),
            EFTForge.api.catalogFetch('/ammo/all?lang=' + lang),
            fetch(EFTForge.config.API_BASE + '/armor/chart').catch(function () { return null; }),
        ]).then(async function ([armorRes, ammoRes, chartRes]) {
            if (!armorRes.ok || !ammoRes.ok) throw new Error('HTTP ' + armorRes.status + '/' + ammoRes.status);
            const armor = await armorRes.json();
            const ammoByCaliber = await ammoRes.json();
            const ammo = [];
            Object.keys(ammoByCaliber).forEach(function (cal) { ammo.push.apply(ammo, ammoByCaliber[cal] || []); });
            _data = {
                lang: lang,
                armor: armor,
                armorById: _index(armor),
                ammo: ammo,
                ammoById: _index(ammo),
                chart: chartRes && chartRes.ok ? await chartRes.json().catch(function () { return null; }) : null,
            };
        }).finally(function () { _loading = null; });
        return _loading;
    }

    function _index(rows) {
        const out = {};
        rows.forEach(function (row) { out[row.id] = row; });
        return out;
    }

    function _calName(cal) {
        const map = (EFTForge.config && EFTForge.config.CALIBER_DISPLAY_MAP) || {};
        return map[cal] || cal || '';
    }

    function _maxClass(item) {
        return item.pieces.reduce(function (best, p) { return Math.max(best, p.armor_class || 0); }, 0);
    }

    function _toggleRow(attr, values, current, labelKey) {
        return '<div class="modal-row armor-sim-toggle bw-toggle-wrap">' + values.map(function (value) {
            return '<button type="button" class="toggle-btn' + (String(value) === String(current) ? ' active' : '') +
                '" ' + attr + '="' + value + '">' + _esc(_t(labelKey(value))) + '</button>';
        }).join('') + '</div>';
    }

    /* ===========================
       EFFECTIVENESS CHART
    =========================== */

    // Fewer shots is better for the shooter: 1 is the strongest tier, more than 12 the weakest
    function _stkTier(value) {
        if (value == null) return 'vlow';
        if (value <= 1) return 'vhigh';
        if (value <= 3) return 'high';
        if (value <= 6) return 'med';
        if (value <= 12) return 'low';
        return 'vlow';
    }

    function _renderChart() {
        const left = _el('bw-left-chart');
        const right = _el('bw-right-chart');
        const chart = _data.chart;
        if (!chart) {
            left.innerHTML = '';
            right.innerHTML = '<div class="ammo-error">' + _esc(_t('chart.missing')) + '</div>';
            return;
        }
        const calibers = [];
        chart.ammo.forEach(function (row) { if (calibers.indexOf(row.caliber) === -1) calibers.push(row.caliber); });
        calibers.sort(function (a, b) { return _calName(a).localeCompare(_calName(b)); });

        let html = '<div class="stats-section bw-section"><div class="section-title">' + _esc(_t('workbench.tool.chart')) + '</div>' +
            '<div class="armor-sim-note">' + _esc(_t('chart.intro')) + '</div>' +
            _toggleRow('data-chart-kind', CHART_KINDS, _chartKind, function (k) { return 'chart.kind.' + k; }) +
            _toggleRow('data-chart-level', [0, 1], _chartLevel, function (l) { return l === 0 ? 'armorSim.col.stk50' : 'armorSim.col.stk90'; }) +
            '</div><div class="stats-section bw-section"><div class="section-title">' + _esc(_t('armorSim.col.caliber')) + '</div>' +
            '<div class="bw-list">' +
            '<button type="button" class="bw-list-item' + (_chartCaliber === '' ? ' active' : '') + '" data-chart-caliber="">' + _esc(_t('chart.allCalibers')) + '</button>';
        calibers.forEach(function (cal) {
            html += '<button type="button" class="bw-list-item' + (cal === _chartCaliber ? ' active' : '') + '" data-chart-caliber="' + _esc(cal) + '">' + _esc(_calName(cal)) + '</button>';
        });
        html += '</div></div>';
        left.innerHTML = html;

        left.querySelectorAll('[data-chart-kind]').forEach(function (btn) {
            btn.addEventListener('click', function () { _chartKind = /** @type {HTMLElement} */ (btn).dataset.chartKind; _renderChart(); });
        });
        left.querySelectorAll('[data-chart-level]').forEach(function (btn) {
            btn.addEventListener('click', function () { _chartLevel = Number(/** @type {HTMLElement} */ (btn).dataset.chartLevel); _renderChart(); });
        });
        left.querySelectorAll('[data-chart-caliber]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                _chartCaliber = /** @type {HTMLElement} */ (btn).dataset.chartCaliber;
                _renderChart();
                openMobileRightPanel();
            });
        });
        _renderChartTable();
    }

    function _renderChartTable() {
        const right = _el('bw-right-chart');
        const chart = _data.chart;
        const setups = chart.setups.map(function (setup, index) { return Object.assign({ index: index }, setup); })
            .filter(function (setup) { return setup.kind === _chartKind; });
        setups.sort(function (a, b) {
            return a.armor_class - b.armor_class || _setupName(a).localeCompare(_setupName(b));
        });

        let html = '<div class="att-table-header"><h3>' + _esc(_t('chart.kind.' + _chartKind)) +
            (_chartCaliber ? ' · ' + _esc(_calName(_chartCaliber)) : '') + '</h3></div>';
        html += '<div class="bw-table-scroll"><table class="armor-sim-table chart-table"><thead><tr><th class="chart-ammo-col">' + _esc(_t('armorSim.col.ammo')) + '</th>';
        setups.forEach(function (setup) {
            html += '<th title="' + _esc(_setupTitle(setup)) + '"><div class="chart-col-name">' + _esc(_setupName(setup)) +
                '</div><div class="chart-col-class">' + _esc(_t('armorSim.classShort')) + ' ' + setup.armor_class + '</div></th>';
        });
        html += '</tr></thead><tbody>';

        let lastCaliber = null;
        chart.ammo.forEach(function (row, ammoIndex) {
            if (_chartCaliber && row.caliber !== _chartCaliber) return;
            if (!_chartCaliber && row.caliber !== lastCaliber) {
                lastCaliber = row.caliber;
                html += '<tr class="chart-caliber-row"><td colspan="' + (setups.length + 1) + '">' + _esc(_calName(row.caliber)) + '</td></tr>';
            }
            const ammo = _data.ammoById[row.id];
            const label = ammo ? (ammo.short_name || ammo.name) : row.id;
            const stats = ammo ? ((ammo.projectile_count || 1) > 1 ? ammo.projectile_count + '×' : '') + ammo.damage + ' / ' + ammo.penetration_power : '';
            html += '<tr><td class="chart-ammo-col" title="' + _esc(ammo ? ammo.name : '') + '">' + _esc(label) +
                ' <span class="chart-ammo-stats">' + _esc(stats) + '</span></td>';
            setups.forEach(function (setup) {
                const value = chart.grid[ammoIndex][setup.index][_chartLevel];
                html += '<td class="ammo-eff eff-' + _stkTier(value) + '">' + (value == null ? '>' + chart.max_shots : value) + '</td>';
            });
            html += '</tr>';
        });
        html += '</tbody></table></div>';
        html += '<div class="armor-sim-note">' + _esc(_tFmt('chart.computed', { when: (chart.computed_at || '').slice(0, 10) })) + '</div>';
        right.innerHTML = html;
    }

    function _setupItems(setup) {
        return setup.item_ids.map(function (id) { return _data.armorById[id]; }).filter(Boolean);
    }

    function _setupName(setup) {
        const items = _setupItems(setup);
        if (items.length === 0) return '?';
        const first = items[0].short_name || items[0].name;
        return items.length > 1 ? first + ' +' + (items.length - 1) : first;
    }

    function _setupTitle(setup) {
        return _setupItems(setup).map(function (item) { return item.name; }).join('\n');
    }

    /* ===========================
       ARMOR DATA SHEETS
    =========================== */

    function _sheetKindOf(item) {
        if (item.kind === 'attachment') {
            const plate = item.pieces.some(function (p) { return p.plate_colliders.length > 0; });
            return plate ? 'plate' : 'attachment';
        }
        if (item.equipment_slot === 'headwear') return 'helmet';
        return item.equipment_slot;
    }

    function _sheetRow(item) {
        const pieces = item.pieces;
        const materials = [];
        const areas = [];
        let durability = 0;
        let effective = 0;
        let minBlunt = Infinity;
        let maxBlunt = -Infinity;
        pieces.forEach(function (p) {
            durability += p.durability || 0;
            effective += p.effective_durability || 0;
            if (materials.indexOf(p.material) === -1) materials.push(p.material);
            p.body_colliders.forEach(function (c) { if (areas.indexOf(c) === -1) areas.push(c); });
            p.plate_colliders.forEach(function (c) { if (areas.indexOf(c) === -1) areas.push(c); });
            minBlunt = Math.min(minBlunt, p.blunt_throughput);
            maxBlunt = Math.max(maxBlunt, p.blunt_throughput);
        });
        return {
            item: item,
            name: item.name,
            armor_class: _maxClass(item),
            durability: durability,
            effective_durability: effective,
            materials: materials.map(function (m) { return _t('armorSim.material.' + m); }).join(', '),
            blunt: pieces.length ? (minBlunt === maxBlunt ? _pct(minBlunt) : _pct(minBlunt) + ' - ' + _pct(maxBlunt)) : '',
            blunt_sort: pieces.length ? maxBlunt : null,
            areas: areas,
            plate_slots: item.plate_slots.length,
            weight: item.weight,
            speed_penalty: item.speed_penalty,
            turn_penalty: item.turn_penalty,
            ergo_penalty: item.ergo_penalty,
            trader_price_rub: item.trader_price_rub,
        };
    }

    function _areaName(area) {
        const collider = _t('armorSim.collider.' + area);
        if (collider !== 'armorSim.collider.' + area) return collider;
        return area.replace(/^Plate_/, '').replace(/_/g, ' ');
    }

    const SHEET_COLUMNS = [
        { key: 'name', label: 'sheets.col.name' },
        { key: 'armor_class', label: 'armorSim.classShort', num: true },
        { key: 'durability', label: 'sheets.col.durability', num: true, tip: 'sheets.col.durabilityTip' },
        { key: 'effective_durability', label: 'sheets.col.effective', num: true, tip: 'sheets.col.effectiveTip' },
        { key: 'materials', label: 'sheets.col.material' },
        { key: 'blunt_sort', label: 'sheets.col.blunt', num: true, tip: 'sheets.col.bluntTip' },
        { key: 'areas', label: 'sheets.col.areas' },
        { key: 'plate_slots', label: 'sheets.col.plates', num: true },
        { key: 'weight', label: 'sheets.col.weight', num: true },
        { key: 'speed_penalty', label: 'sheets.col.speed', num: true },
        { key: 'turn_penalty', label: 'sheets.col.turn', num: true },
        { key: 'ergo_penalty', label: 'sheets.col.ergo', num: true },
        { key: 'trader_price_rub', label: 'sheets.col.price', num: true },
    ];

    function _renderSheets() {
        const left = _el('bw-left-sheets');
        let html = '<div class="stats-section bw-section"><div class="section-title">' + _esc(_t('workbench.tool.sheets')) + '</div>' +
            '<input type="text" class="search-input" id="sheets-search" placeholder="' + _esc(_t('sheets.search')) + '" value="' + _esc(_sheetSearch) + '">' +
            '<div class="bw-list">';
        SHEET_KINDS.forEach(function (kind) {
            const count = _data.armor.filter(function (item) { return item.pieces.length > 0 && _sheetKindOf(item) === kind; }).length;
            html += '<button type="button" class="bw-list-item' + (kind === _sheetKind ? ' active' : '') + '" data-sheet-kind="' + kind + '">' +
                _esc(_t('sheets.kind.' + kind)) + '<span class="bw-list-count">' + count + '</span></button>';
        });
        html += '</div></div>';
        left.innerHTML = html;

        left.querySelectorAll('[data-sheet-kind]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                _sheetKind = /** @type {HTMLElement} */ (btn).dataset.sheetKind;
                left.querySelectorAll('[data-sheet-kind]').forEach(function (other) { other.classList.toggle('active', other === btn); });
                _renderSheetTable();
                openMobileRightPanel();
            });
        });
        const search = /** @type {HTMLInputElement} */ (_el('sheets-search'));
        search.addEventListener('input', function () {
            _sheetSearch = search.value.trim().toLowerCase();
            _renderSheetTable();
        });
        _renderSheetTable();
    }

    function _renderSheetTable() {
        const right = _el('bw-right-sheets');
        let rows = _data.armor.filter(function (item) {
            return item.pieces.length > 0 && _sheetKindOf(item) === _sheetKind;
        }).map(_sheetRow);
        if (_sheetSearch) {
            rows = rows.filter(function (row) { return row.name.toLowerCase().indexOf(_sheetSearch) !== -1; });
        }
        const col = _sheetSort.col;
        rows.sort(function (a, b) {
            let va = col === 'areas' ? a.areas.length : a[col];
            let vb = col === 'areas' ? b.areas.length : b[col];
            if (va == null && vb == null) return 0;
            if (va == null) return 1;
            if (vb == null) return -1;
            if (typeof va === 'string') { va = va.toLowerCase(); vb = String(vb).toLowerCase(); }
            const cmp = va < vb ? -1 : va > vb ? 1 : 0;
            return _sheetSort.asc ? cmp : -cmp;
        });

        let html = '<div class="att-table-header"><h3>' + _esc(_t('sheets.kind.' + _sheetKind)) + '</h3></div>' +
            '<div class="bw-table-scroll"><table class="armor-sim-table sheets-table"><thead><tr><th></th>';
        SHEET_COLUMNS.forEach(function (c) {
            const sorted = c.key === _sheetSort.col ? (_sheetSort.asc ? ' ammo-sort-asc' : ' ammo-sort-desc') : '';
            html += '<th class="ammo-th-sortable' + sorted + '" data-sheet-col="' + c.key + '"' +
                (c.tip ? ' data-tooltip="' + _esc(_t(c.tip)) + '"' : '') +
                (sorted ? ' aria-sort="' + (_sheetSort.asc ? 'ascending' : 'descending') + '"' : '') +
                '><button type="button" class="bw-sort-button">' + _esc(_t(c.label)) + '</button></th>';
        });
        html += '</tr></thead><tbody>';
        rows.forEach(function (row) {
            html += '<tr><td>' + (row.item.icon_link ? '<img class="sheets-icon" src="' + _esc(row.item.icon_link) + '" alt="" loading="lazy">' : '') + '</td>';
            html += '<td class="sheets-name">' + _esc(row.name) + '</td>';
            html += '<td>' + row.armor_class + '</td>';
            html += '<td>' + _num(row.durability, 0) + '</td>';
            html += '<td>' + _num(row.effective_durability, 0) + '</td>';
            html += '<td class="sheets-text">' + _esc(row.materials) + '</td>';
            html += '<td>' + _esc(row.blunt) + '</td>';
            html += '<td class="sheets-text" title="' + _esc(row.areas.map(_areaName).join(', ')) + '">' + row.areas.length + '</td>';
            html += '<td>' + (row.plate_slots || '') + '</td>';
            html += '<td>' + (row.weight == null ? '' : _num(row.weight, 2)) + '</td>';
            html += '<td>' + _signedPct(row.speed_penalty) + '</td>';
            html += '<td>' + _signedPct(row.turn_penalty) + '</td>';
            html += '<td>' + _signedPct(row.ergo_penalty) + '</td>';
            html += '<td>' + (row.trader_price_rub ? row.trader_price_rub.toLocaleString() + ' ₽' : '') + '</td></tr>';
        });
        html += '</tbody></table></div>';
        if (rows.length === 0) html += '<div class="ammo-no-results">' + _esc(_t('ammo.noResults')) + '</div>';
        right.innerHTML = html;

        right.querySelectorAll('[data-sheet-col]').forEach(function (th) {
            th.addEventListener('click', function () {
                const key = /** @type {HTMLElement} */ (th).dataset.sheetCol;
                _sheetSort = { col: key, asc: key === _sheetSort.col ? !_sheetSort.asc : key === 'name' };
                _renderSheetTable();
            });
        });
    }

    /* ===========================
       DROP AND ZEROING TABLE
    =========================== */

    function _showFlight() {
        if (!_el('dt-form')) _renderFlightForm();
        // Fill in the build the workbench was just opened from
        const snap = EFTForge.workbench && EFTForge.workbench.buildSnapshot();
        if (snap && snap.serial !== _flightSnapshot) _flightUseBuild();
        _renderWeaponNote();
        _renderFlightResults();
    }

    function _renderFlightForm() {
        const left = _el('bw-left-flight');
        let options = '';
        const byCaliber = {};
        _data.ammo.forEach(function (row) {
            if (!row.velocity) return;
            (byCaliber[row.caliber] = byCaliber[row.caliber] || []).push(row);
        });
        Object.keys(byCaliber).sort(function (a, b) { return _calName(a).localeCompare(_calName(b)); }).forEach(function (cal) {
            options += '<optgroup label="' + _esc(_calName(cal)) + '">';
            byCaliber[cal].forEach(function (row) {
                options += '<option value="' + _esc(row.id) + '">' + _esc(row.name) + ' (' + Math.round(row.velocity) + ' m/s)</option>';
            });
            options += '</optgroup>';
        });
        left.innerHTML = `
            <div class="stats-section bw-section" id="dt-form">
                <div class="section-title">${_esc(_t('workbench.tool.flight'))}</div>
                <div class="armor-sim-note">${_esc(_t('flight.intro'))}</div>
                <div class="armor-sim-field"><label for="dt-ammo" id="dt-ammo-label">${_esc(_t('armorSim.ammo'))}</label><select id="dt-ammo">${options}</select></div>
                <div class="armor-sim-row">
                    <label class="armor-sim-field"><span>${_esc(_t('flight.zero'))}</span>
                        <input type="number" id="dt-zero" min="10" max="1000" step="25" value="100"></label>
                    <label class="armor-sim-field"><span data-tooltip="${_esc(_t('flight.sightTip'))}">${_esc(_t('flight.sight'))}</span>
                        <input type="number" id="dt-sight" min="0" max="20" step="0.5" value="5"></label>
                </div>
                <div class="armor-sim-row">
                    <label class="armor-sim-field"><span>${_esc(_t('flight.max'))}</span>
                        <input type="number" id="dt-max" min="25" max="1000" step="25" value="500"></label>
                    <label class="armor-sim-field"><span>${_esc(_t('flight.step'))}</span>
                        <input type="number" id="dt-step" min="5" max="200" step="5" value="25"></label>
                </div>
                <label class="armor-sim-field"><span data-tooltip="${_esc(_t('armorSim.velocityTip'))}">${_esc(_t('armorSim.velocity'))}</span>
                    <input type="number" id="dt-velocity" min="-90" max="200" step="0.1" value="0"></label>
                <button type="button" class="armor-sim-link-btn" id="dt-use-build" hidden></button>
                <div class="armor-sim-note" id="dt-weapon"></div>
                <button type="button" class="armor-sim-run" id="dt-run">${_esc(_t('flight.run'))}</button>
            </div>`;
        Object.keys(_flightSettings).forEach(function (key) {
            const input = _el('dt-' + key);
            if (key !== 'ammo' || _data.ammoById[_flightSettings.ammo]) input.value = String(_flightSettings[key]);
            input.addEventListener('input', _invalidateFlight);
            input.addEventListener('change', _invalidateFlight);
        });
        const ammoSelect = setupCustomSelect('dt-ammo');
        if (ammoSelect) ammoSelect.querySelector('.custom-select-trigger').setAttribute('aria-labelledby', 'dt-ammo-label');
        _el('dt-run').disabled = _flightRunning;
        const useBuild = _el('dt-use-build');
        if (useBuild) useBuild.addEventListener('click', _flightUseBuild);
        _el('dt-run').addEventListener('click', _runFlight);
        _renderWeaponNote();
    }

    function _saveFlightSettings() {
        if (!_el('dt-form')) return;
        Object.keys(_flightSettings).forEach(function (key) {
            const input = _el('dt-' + key);
            _flightSettings[key] = key === 'ammo' ? input.value :
                _numberFrom(input.id, _flightSettings[key], Number(input.min), Number(input.max));
        });
    }

    function _invalidateFlight() {
        _saveFlightSettings();
        _flightRevision++;
        _flightResult = null;
        _renderFlightResults();
    }

    function _flightUseBuild() {
        const snap = EFTForge.workbench && EFTForge.workbench.buildSnapshot();
        if (!snap) return;
        _flightSnapshot = snap.serial;
        const select = _el('dt-ammo');
        if (snap.ammoId && select.querySelector('option[value="' + snap.ammoId + '"]')) select.value = snap.ammoId;
        select.dispatchEvent(new Event('input'));
        if (snap.velocityPct != null) _el('dt-velocity').value = String(Math.round(snap.velocityPct * 100) / 100);
        _flightWeapon = { id: snap.gunId, name: snap.gunName };
        _invalidateFlight();
        _renderWeaponNote();
    }

    function _renderWeaponNote() {
        const note = _el('dt-weapon');
        if (!note) return;
        const snap = EFTForge.workbench && EFTForge.workbench.buildSnapshot();
        const useBuild = _el('dt-use-build');
        useBuild.hidden = !snap;
        if (snap) useBuild.textContent = _tFmt('armorSim.useLastBuild', { gun: snap.gunName });
        if (!_flightWeapon) {
            note.textContent = _t('flight.noWeapon');
            return;
        }
        note.innerHTML = _esc(_tFmt('flight.weapon', { weapon: _flightWeapon.name })) +
            ' <button type="button" class="armor-sim-link-btn" id="dt-clear-weapon">' + _esc(_t('flight.clearWeapon')) + '</button>';
        _el('dt-clear-weapon').addEventListener('click', function () {
            _flightWeapon = null;
            _invalidateFlight();
            _renderWeaponNote();
        });
    }

    function _numberFrom(id, fallback, low, high) {
        const value = parseFloat(_el(id).value);
        return isFinite(value) ? Math.min(Math.max(value, low), high) : fallback;
    }

    async function _runFlight() {
        if (_flightRunning) return;
        _flightRunning = true;
        const btn = _el('dt-run');
        btn.disabled = true;
        const revision = _flightRevision;
        _saveFlightSettings();
        const payload = {
            ammo_id: _flightSettings.ammo,
            weapon_id: _flightWeapon ? _flightWeapon.id : null,
            zero_distance: _flightSettings.zero,
            sight_height_cm: _flightSettings.sight,
            max_distance: _flightSettings.max,
            step: _flightSettings.step,
            velocity_modifier_pct: _flightSettings.velocity,
        };
        Object.keys(_flightSettings).forEach(function (key) { _el('dt-' + key).value = String(_flightSettings[key]); });
        _flightResult = null;
        _renderFlightResults();
        try {
            const res = await fetch(EFTForge.config.API_BASE + '/ammo/flight', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(function () { return null; });
            if (revision !== _flightRevision) return;
            if (!res.ok) {
                const detail = data && data.detail;
                _flightResult = { error: typeof detail === 'string' ? detail : _t('armorSim.runError') };
            } else {
                _flightResult = { data: data, payload: payload };
            }
        } catch (err) {
            console.error('[ballistics-tools] flight error:', err);
            if (revision === _flightRevision) _flightResult = { error: _t('armorSim.runError') };
        } finally {
            _flightRunning = false;
            btn.disabled = false;
            const currentButton = _el('dt-run');
            if (currentButton) currentButton.disabled = false;
            _renderFlightResults();
            const wb = EFTForge.workbench;
            if (revision === _flightRevision && wb && wb.isActive() && wb.currentTool() === 'flight') openMobileRightPanel();
        }
    }

    function _renderFlightResults() {
        const right = _el('bw-right-flight');
        if (!_flightResult) {
            right.innerHTML = '<div class="armor-sim-placeholder">' + _esc(_t(_flightRunning ? 'armorSim.running' : 'flight.placeholder')) + '</div>';
            return;
        }
        if (_flightResult.error) {
            right.innerHTML = '<div class="ammo-error">' + _esc(_flightResult.error) + '</div>';
            return;
        }
        const data = _flightResult.data;
        const payload = _flightResult.payload;
        const ammo = _data.ammoById[data.ammo_id];
        const zeroAmmo = _data.ammoById[data.zero_ammo_id];
        let html = '<div class="armor-sim-summary"><div class="armor-sim-big-meta">' +
            '<div class="armor-sim-ammo-name">' + _esc(ammo ? ammo.name : '') + '</div>' +
            '<div>' + _esc(_tFmt('flight.summary', { speed: Math.round(data.muzzle_speed), zero: payload.zero_distance })) + '</div>' +
            '<div class="armor-sim-flight">' + _esc(_tFmt('flight.zeroedWith', { ammo: zeroAmmo ? zeroAmmo.name : '' })) + '</div>' +
            '</div></div>';
        html += '<div class="bw-table-scroll"><table class="armor-sim-table"><thead><tr>' +
            ['flight.col.distance', 'flight.col.impact', 'flight.col.hold', 'flight.col.speed', 'flight.col.time', 'flight.col.damage', 'flight.col.pen']
                .map(function (key) { return '<th>' + _esc(_t(key)) + '</th>'; }).join('') + '</tr></thead><tbody>';
        data.rows.forEach(function (row) {
            const zero = Math.abs(row.distance - payload.zero_distance) < 1e-6;
            html += '<tr' + (zero ? ' class="is-current"' : '') + '><td>' + Math.round(row.distance) + '</td>' +
                '<td>' + _signed(row.impact_cm, 1) + '</td>' +
                '<td>' + (row.distance > 0 ? _signed(row.correction_mrad, 2) : '') + '</td>' +
                '<td>' + Math.round(row.speed) + '</td>' +
                '<td>' + Math.round(row.time * 1000) + '</td>' +
                '<td>' + (row.damage == null ? '' : _num(row.damage, 1)) + '</td>' +
                '<td>' + (row.penetration == null ? '' : _num(row.penetration, 1)) + '</td></tr>';
        });
        html += '</tbody></table></div><div class="armor-sim-note">' + _esc(_t('flight.method')) + '</div>';
        right.innerHTML = html;
    }

    /* ===========================
       HELPERS
    =========================== */

    /** @returns {any} */
    function _el(id) { return document.getElementById(id); }

    function _lang() { return (EFTForge.state && EFTForge.state.lang) || 'en'; }

    function _t(key) { return (EFTForge.lang && EFTForge.lang.t) ? EFTForge.lang.t(key) : key; }

    function _tFmt(key, vars) { return (EFTForge.lang && EFTForge.lang.tFmt) ? EFTForge.lang.tFmt(key, vars) : key; }

    function _esc(text) { return EFTForge.utils.escapeHtml(String(text == null ? '' : text)); }

    function _num(value, digits) { return value == null ? '' : Number(value).toFixed(digits); }

    function _pct(fraction) { return Math.round(fraction * 100) + '%'; }

    function _signedPct(fraction) {
        if (fraction == null || fraction === 0) return '';
        const pct = Math.round(fraction * 100);
        return (pct > 0 ? '+' : '') + pct + '%';
    }

    function _signed(value, digits) {
        const fixed = Number(value).toFixed(digits);
        return Number(fixed) > 0 ? '+' + fixed : fixed;
    }

    return { show: show, onLangChange: onLangChange };

}());
