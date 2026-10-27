window.EFTForge = window.EFTForge || {};

/* ============================================================
   BALLISTICS TOOLS
   Two of the Ballistics Workbench's tools, each with its controls in the left panel and
   its table in the right one: the precomputed ammo effectiveness chart (GET /armor/chart)
   and the drop and zeroing table (POST /ammo/flight). ballistics-workbench.js calls show().
   The armor data sheets live in the armor simulator's item table (armor-sim.js).
============================================================ */

window.EFTForge.ballisticsTools = (function () {

    const CHART_KINDS = ['body', 'plate', 'helmet'];
    const AMMO_ART = './assets/images/ballistics-loadout/patron_in_weapon.png';
    const RUN_DELAY = 450;

    let _data = null;           // { lang, armor, armorById, ammo, ammoById, chart }
    let _loading = null;

    let _chartKind = 'body';
    let _chartCaliber = '';
    let _chartLevel = 0;        // 0 = shots for a 50% kill chance, 1 = for 90%

    const DEFAULT_FLIGHT = { ammo: '', zero: 100, sight: 5, max: 500, step: 25, velocity: 0 };
    const FLIGHT_LIMITS = {
        zero: [10, 1000, 25], sight: [0, 20, 0.5], max: [25, 1000, 25], step: [5, 200, 5], velocity: [-90, 200, 0.1],
    };
    const _flightSettings = Object.assign({}, DEFAULT_FLIGHT);
    let _flightWeapon = null;   // the build's weapon, whose default ammo sets the zero
    let _flightSnapshot = 0;    // the last build snapshot the drop table filled in from
    let _flightPicking = false; // the ammo slot's picker is open
    let _flightTimer = null;
    let _flightRunning = false;
    let _flightResult = null;
    let _flightRevision = 0;

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
        else if (tool === 'flight') _showFlight();
    }

    function onLangChange() {
        _data = null;
        _flightResult = null;
        _flightRevision++;
        const wb = EFTForge.workbench;
        if (wb && wb.isActive() && ['chart', 'flight'].indexOf(wb.currentTool()) !== -1) show(wb.currentTool());
    }

    // The workbench's Reset button on the drop table
    function resetFlight() {
        Object.assign(_flightSettings, DEFAULT_FLIGHT);
        _flightWeapon = null;
        EFTForge.workbench.closePicker();
        _renderFlightLeft();
        _scheduleFlight();
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

    function _toggleRow(attr, values, current, label) {
        return '<div class="bw-toggle-row">' + values.map(function (value) {
            return '<button type="button" class="toggle-btn' + (String(value) === String(current) ? ' active' : '') +
                '" ' + attr + '="' + value + '">' + _esc(label(value)) + '</button>';
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
            right.innerHTML = EFTForge.workbench.placeholderHtml({ main: _t('chart.missing') });
            return;
        }
        const calibers = [];
        chart.ammo.forEach(function (row) { if (calibers.indexOf(row.caliber) === -1) calibers.push(row.caliber); });
        calibers.sort(function (a, b) { return _calName(a).localeCompare(_calName(b)); });

        let html = '<div class="stats-section"><div class="section-title">' + _esc(_t('workbench.tool.chart')) + '</div>' +
            _toggleRow('data-chart-kind', CHART_KINDS, _chartKind, function (k) { return _t('chart.kind.' + k); }) +
            _toggleRow('data-chart-level', [0, 1], _chartLevel, function (l) { return _t(l === 0 ? 'armorSim.col.stk50' : 'armorSim.col.stk90'); }) +
            '<div class="bw-note">' + _esc(_t('chart.intro')) + '</div></div>' +
            '<div class="stats-section"><div class="section-title">' + _esc(_t('armorSim.col.caliber')) + '</div>' +
            '<div class="ammo-cal-grid">' +
            '<button type="button" class="ammo-cal-chip bw-chip-all' + (_chartCaliber === '' ? ' active' : '') + '" data-chart-caliber="">' + _esc(_t('chart.allCalibers')) + '</button>';
        calibers.forEach(function (cal) {
            html += '<button type="button" class="ammo-cal-chip' + (cal === _chartCaliber ? ' active' : '') + '" data-chart-caliber="' + _esc(cal) + '">' + _esc(_calName(cal)) + '</button>';
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

        let html = '<div class="att-table-header"><h3>' + _esc(_t('workbench.tool.chart')) + ' <strong>' +
            _esc(_t('chart.kind.' + _chartKind)) + (_chartCaliber ? ' · ' + _esc(_calName(_chartCaliber)) : '') + '</strong></h3></div>' +
            '<div class="bw-note">' + _esc(_tFmt('chart.computed', { when: (chart.computed_at || '').slice(0, 10) })) + '</div>';
        html += '<div class="bw-table-scroll"><table class="ammo-table bw-chart-table"><thead><tr><th class="ammo-th ammo-col-name bw-sticky-col">' + _esc(_t('armorSim.col.ammo')) + '</th>';
        setups.forEach(function (setup) {
            html += '<th class="ammo-th bw-chart-th" data-tooltip="' + _esc(_setupTitle(setup)) + '"><div class="bw-chart-col-name">' + _esc(_setupName(setup)) +
                '</div><div class="bw-chart-col-class">' + _esc(_t('armorSim.classShort')) + ' ' + setup.armor_class + '</div></th>';
        });
        html += '</tr></thead><tbody>';

        let lastCaliber = null;
        chart.ammo.forEach(function (row, ammoIndex) {
            if (_chartCaliber && row.caliber !== _chartCaliber) return;
            if (!_chartCaliber && row.caliber !== lastCaliber) {
                lastCaliber = row.caliber;
                html += '<tr class="ammo-caliber-row"><td colspan="' + (setups.length + 1) + '"><span class="bw-sticky-label">' + _esc(_calName(row.caliber)) + '</span></td></tr>';
            }
            const ammo = _data.ammoById[row.id];
            const label = ammo ? (ammo.short_name || ammo.name) : row.id;
            const stats = ammo ? ((ammo.projectile_count || 1) > 1 ? ammo.projectile_count + '×' : '') + ammo.damage + ' / ' + ammo.penetration_power : '';
            html += '<tr class="ammo-data-row"><td class="ammo-td ammo-col-name bw-sticky-col"' + (ammo ? ' data-tooltip="' + _esc(ammo.name) + '"' : '') + '>' + _esc(label) +
                ' <span class="bw-chart-ammo-stats">' + _esc(stats) + '</span></td>';
            setups.forEach(function (setup) {
                const value = chart.grid[ammoIndex][setup.index][_chartLevel];
                html += '<td class="ammo-td ammo-eff eff-' + _stkTier(value) + '">' + (value == null ? '>' + chart.max_shots : value) + '</td>';
            });
            html += '</tr>';
        });
        html += '</tbody></table></div>';
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
        return _setupItems(setup).map(function (item) { return item.name; }).join(', ');
    }

    /* ===========================
       DROP AND ZEROING TABLE
       Laid out like the armor simulator: the round sits in a slot that opens the item
       table, and the table works itself out again after every change.
    =========================== */

    function _showFlight() {
        // Fill in the build the workbench was just opened from
        const snap = EFTForge.workbench && EFTForge.workbench.buildSnapshot();
        if (snap && snap.serial !== _flightSnapshot) _flightUseBuild();
        if (!_data.ammoById[_flightSettings.ammo]) _flightSettings.ammo = '';
        _renderFlightLeft();
        _renderFlightResults();
        if (_flightSettings.ammo && !_flightResult && !_flightRunning) _scheduleFlight(0);
    }

    function _renderFlightLeft() {
        const left = _el('bw-left-flight');
        if (!left) return;
        const snap = EFTForge.workbench && EFTForge.workbench.buildSnapshot();
        const ammo = _data.ammoById[_flightSettings.ammo] || null;
        const field = function (key, labelKey, tipKey) {
            const limits = FLIGHT_LIMITS[key];
            return '<div class="optimizer-field"><label class="modal-label" for="dt-' + key + '"' +
                (tipKey ? ' data-tooltip="' + _esc(_t(tipKey)) + '"' : '') + '>' + _esc(_t(labelKey)) + '</label>' +
                '<input type="number" class="optimizer-input" id="dt-' + key + '" min="' + limits[0] + '" max="' + limits[1] +
                '" step="' + limits[2] + '" value="' + _flightSettings[key] + '"></div>';
        };
        // The same slot as the armor simulator's ammo slot
        let body = '<img class="bw-slot-art bw-art-ammo" src="' + AMMO_ART + '" alt="">';
        if (ammo) {
            const damage = (ammo.projectile_count || 1) > 1 ? ammo.projectile_count + '×' + ammo.damage : ammo.damage;
            body = EFTForge.armorSim.slotColorHtml(ammo) + '<img class="bw-slot-icon" src="' + _esc(ammo.base_image_link || ammo.icon_link || '') + '" alt="" decoding="async">' +
                '<span class="bw-slot-short">' + _esc(ammo.short_name || '') + '</span>' +
                '<span class="bw-slot-stat" data-tooltip="' + _esc(_t('armorSim.col.dmgPen')) + '">' + _esc(damage + ' / ' + ammo.penetration_power) + '</span>';
        }
        const slotLabel = _t('armorSim.slot.ammo');
        left.innerHTML = `
            <div class="stats-section">
                <div class="section-title">${_esc(_t('workbench.tool.flight'))}</div>
                <div class="bw-inserts-row">
                    <div class="bw-slot bw-slot-ammo${ammo ? ' is-equipped' : ''}${_flightPicking ? ' active-slot' : ''}" id="dt-ammo-slot" role="button" tabindex="0"
                        aria-label="${_esc(slotLabel + (ammo ? ': ' + ammo.name : ''))}"${ammo ? ' data-tooltip="' + _esc(ammo.name) + '"' : ''}>
                        <div class="bw-slot-header">${_esc(slotLabel)}</div>
                        <div class="bw-slot-body">${body}</div>
                    </div>
                </div>
                <div class="stats-divider"></div>
                <div class="optimizer-field-row">${field('zero', 'flight.zero')}${field('sight', 'flight.sight', 'flight.sightTip')}</div>
                <div class="optimizer-field-row">${field('max', 'flight.max')}${field('step', 'flight.step')}</div>
                <div class="optimizer-field-row">${field('velocity', 'armorSim.velocity', 'armorSim.velocityTip')}</div>
                <div class="stats-divider"></div>
                <div class="bw-note">${_esc(_flightWeapon ? _tFmt('flight.weapon', { weapon: _flightWeapon.name }) : _t('flight.noWeapon'))}</div>
                ${_flightWeapon ? '<button type="button" class="modal-btn full-width" id="dt-clear-weapon">' + _esc(_t('flight.clearWeapon')) + '</button>' : ''}
                ${snap ? '<button type="button" class="modal-btn full-width" id="dt-use-build">' + _esc(_tFmt('armorSim.useLastBuild', { gun: snap.gunName })) + '</button>' : ''}
                <button type="button" class="modal-btn full-width bw-mobile-only" id="dt-show-results">${_esc(_t('armorSim.showResults'))}</button>
            </div>
            <div class="stats-section bw-notes-section"><div class="bw-note">${_esc(_t('flight.intro'))}</div></div>`;

        const ammoSlot = _el('dt-ammo-slot');
        ammoSlot.addEventListener('click', _openAmmoPicker);
        ammoSlot.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            _openAmmoPicker();
        });
        Object.keys(FLIGHT_LIMITS).forEach(function (key) {
            const input = _el('dt-' + key);
            const limits = FLIGHT_LIMITS[key];
            input.addEventListener('input', function () {
                const value = parseFloat(input.value);
                if (!isFinite(value)) return;
                _flightSettings[key] = Math.min(Math.max(value, limits[0]), limits[1]);
                _scheduleFlight();
            });
            input.addEventListener('change', function () { input.value = String(_flightSettings[key]); });
        });
        const clearWeapon = _el('dt-clear-weapon');
        if (clearWeapon) clearWeapon.addEventListener('click', function () {
            _flightWeapon = null;
            _renderFlightLeft();
            _scheduleFlight();
        });
        const useBuild = _el('dt-use-build');
        if (useBuild) useBuild.addEventListener('click', function () {
            _flightUseBuild();
            _renderFlightLeft();
        });
        _el('dt-show-results').addEventListener('click', function () { openMobileRightPanel(); });
    }

    function _openAmmoPicker() {
        const rows = _data.ammo.filter(function (row) { return row.velocity && row.penetration_power != null; });
        EFTForge.workbench.openPicker({
            slotName: _t('armorSim.slot.ammo'),
            art: AMMO_ART,
            rows: rows,
            columns: EFTForge.armorSim.ammoColumns(),
            key: 'flight-ammo',
            currentId: function () { return _flightSettings.ammo || null; },
            sort: { key: 'penetration_power', asc: false },
            onPick: function (row) {
                _flightSettings.ammo = row.id;
                _renderFlightLeft();
                EFTForge.workbench.flashSlot(_el('dt-ammo-slot'), 'install');
                _scheduleFlight(0);
            },
            onClose: function () {
                _flightPicking = false;
                const slot = _el('dt-ammo-slot');
                if (slot) slot.classList.remove('active-slot');
            },
        });
        _flightPicking = true;
        _el('dt-ammo-slot').classList.add('active-slot');
    }

    function _flightUseBuild() {
        const snap = EFTForge.workbench && EFTForge.workbench.buildSnapshot();
        if (!snap) return;
        _flightSnapshot = snap.serial;
        if (snap.ammoId && _data.ammoById[snap.ammoId]) _flightSettings.ammo = snap.ammoId;
        if (snap.velocityPct != null) _flightSettings.velocity = Math.round(snap.velocityPct * 100) / 100;
        _flightWeapon = { id: snap.gunId, name: snap.gunName };
        _scheduleFlight(0);
    }

    // Work the table out again once the player pauses, like the armor simulator
    function _scheduleFlight(delay) {
        _flightRevision++;
        clearTimeout(_flightTimer);
        _flightTimer = setTimeout(function () { _flightTimer = null; _runFlight(); }, delay == null ? RUN_DELAY : delay);
        const right = _el('bw-right-flight');
        if (right) right.classList.toggle('bw-running', !!_flightResult);
    }

    async function _runFlight() {
        if (!_flightSettings.ammo) { _flightResult = null; _renderFlightResults(); return; }
        if (_flightRunning) { _scheduleFlight(); return; }
        _flightRunning = true;
        const revision = _flightRevision;
        const payload = {
            ammo_id: _flightSettings.ammo,
            weapon_id: _flightWeapon ? _flightWeapon.id : null,
            zero_distance: _flightSettings.zero,
            sight_height_cm: _flightSettings.sight,
            max_distance: _flightSettings.max,
            step: _flightSettings.step,
            velocity_modifier_pct: _flightSettings.velocity,
        };
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
                _flightResult = { error: res.status === 429 ? _t('armorSim.tooFast') : typeof detail === 'string' ? detail : _t('armorSim.runError') };
            } else {
                _flightResult = { data: data, payload: payload };
            }
        } catch (err) {
            console.error('[ballistics-tools] flight error:', err);
            if (revision === _flightRevision) _flightResult = { error: _t('armorSim.runError') };
        } finally {
            _flightRunning = false;
            if (revision === _flightRevision) _renderFlightResults();
        }
    }

    function _renderFlightResults() {
        const right = _el('bw-right-flight');
        if (!right) return;
        right.classList.remove('bw-running');
        if (!_flightSettings.ammo || !_flightResult) {
            right.innerHTML = EFTForge.workbench.placeholderHtml({
                art: AMMO_ART,
                main: _t(_flightSettings.ammo ? 'armorSim.running' : 'flight.placeholder'),
            });
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
        let html = '<div class="att-table-header">' +
            (ammo && ammo.icon_link ? '<div class="att-table-icon-preview"><img class="att-table-gun-img" src="' + _esc(ammo.icon_link) +
                '" alt=""><div class="slot-shortname">' + _esc(ammo.short_name || '') + '</div></div>' : '') +
            '<h3>' + _esc(_t('workbench.tool.flight')) + ' <strong>' + _esc(ammo ? ammo.name : '') + '</strong></h3></div>' +
            '<div class="bw-result-meta">' + _esc(_tFmt('flight.summary', { speed: Math.round(data.muzzle_speed), zero: payload.zero_distance })) +
            ' · ' + _esc(_tFmt('flight.zeroedWith', { ammo: zeroAmmo ? zeroAmmo.name : '' })) + '</div>';
        html += '<div class="bw-table-scroll"><table class="attachment-table bw-table"><thead><tr>' +
            ['flight.col.distance', 'flight.col.impact', 'flight.col.hold', 'flight.col.speed', 'flight.col.time', 'flight.col.damage', 'flight.col.pen']
                .map(function (key) { return '<th>' + _esc(_t(key)) + '</th>'; }).join('') + '</tr></thead><tbody>';
        data.rows.forEach(function (row) {
            const zero = Math.abs(row.distance - payload.zero_distance) < 1e-6;
            html += '<tr' + (zero ? ' class="attachment-row-installed"' : '') + '><td>' + Math.round(row.distance) + '</td>' +
                '<td>' + _signed(row.impact_cm, 1) + '</td>' +
                '<td>' + (row.distance > 0 ? _signed(row.correction_mrad, 2) : '') + '</td>' +
                '<td>' + Math.round(row.speed) + '</td>' +
                '<td>' + Math.round(row.time * 1000) + '</td>' +
                '<td>' + (row.damage == null ? '' : _num(row.damage, 1)) + '</td>' +
                '<td>' + (row.penetration == null ? '' : _num(row.penetration, 1)) + '</td></tr>';
        });
        html += '</tbody></table></div><div class="bw-note">' + _esc(_t('flight.method')) + '</div>';
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

    function _signed(value, digits) {
        const fixed = Number(value).toFixed(digits);
        return Number(fixed) > 0 ? '+' + fixed : fixed;
    }

    return { show: show, resetFlight: resetFlight, onLangChange: onLangChange };

}());
