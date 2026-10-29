window.EFTForge = window.EFTForge || {};

/* ============================================================
   BALLISTICS TOOLS
   Two of the Ballistics Workbench's tools, each with its controls in the left panel and
   its table in the right one: the precomputed ammo effectiveness chart (GET /armor/chart)
   and the drop and zeroing table (worked out by ballistics-engine.js) with its charts and scope view, drawn
   through ballistics-charts.js. ballistics-workbench.js calls show().
   The armor data sheets live in the armor simulator's item table (armor-sim.js).
============================================================ */

window.EFTForge.ballisticsTools = (function () {

    const CHART_KINDS = ['body', 'plate', 'helmet'];
    const AMMO_ART = './assets/images/ballistics-loadout/patron_in_weapon.png';
    const RUN_DELAY = 450;

    let _data = null;           // { lang, armor, armorById, ammo, ammoById, engine, chart }
    let _loading = null;

    let _chartKind = 'body';
    let _chartCaliber = '';
    let _chartLevel = 0;        // 0 = shots for a 50% kill chance, 1 = for 90%
    let _chartSearch = '';      // the caliber panel's ammo filter, as typed

    // compare holds two slots of rounds flown alongside the first, '' for an empty slot.
    // moa is the weapon's accuracy before the round's own modifier, 0 when we don't know it.
    const DEFAULT_FLIGHT = { ammo: '', compare: ['', ''], zero: 100, sight: 5, max: 500, step: 25, velocity: 0, moa: 0 };
    const FLIGHT_LIMITS = {
        zero: [10, 1000, 25], sight: [0, 20, 0.5], max: [25, 1000, 25], step: [5, 200, 5], velocity: [-90, 200, 0.1], moa: [0, 30, 0.01],
    };
    const FLIGHT_VIEWS = ['trajectory', 'speed', 'damage', 'pen'];
    const SCOPE_ZOOMS = [1, 4, 8];
    // Half the scope's field of view in mrad at 1x, so 4x shows about what a real 4x scope does
    const SCOPE_FIELD = 50;
    const SPEED_OF_SOUND = 343;
    // A Tarkov MOA of spread puts a round up to this many mrad off the aim point (2.9089 cm at 100 m)
    const MRAD_PER_MOA = 0.29089;
    const _flightSettings = _defaultFlight();
    // The build's weapon, whose default ammo sets the zero unless zeroSelf has the loaded round
    // zero itself. zeroAmmoId is that default ammo, once a result has named it.
    let _flightWeapon = null;   // { id, name, zeroSelf?, zeroAmmoId? }
    let _flightUsedSnapshot = 0; // the snapshot its button was last clicked for, which hides the button
    let _flightPicking = null;  // which slot's picker is open: 'main', '0' or '1'
    let _flightView = 'trajectory';
    let _scopeZoom = 4;
    let _flightFocus = null;    // the distance the scope looks at and the table and charts mark
    let _flightRounds = null;   // the last result as [{ ammo, rows, color }], the first being the main round
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

    // A copy of the chart picks and drop table settings for the workbench tab to keep
    function getState() {
        return {
            chart: { kind: _chartKind, caliber: _chartCaliber, level: _chartLevel },
            flight: Object.assign({}, _flightSettings, { compare: _flightSettings.compare.slice() }),
            flightView: { view: _flightView, zoom: _scopeZoom, focus: _flightFocus },
            flightWeapon: _flightWeapon ? Object.assign({}, _flightWeapon) : null,
        };
    }

    // A workbench tab's saved picks, or the defaults for a new tab
    function setState(state) {
        const saved = state || {};
        const chart = saved.chart || {};
        _chartKind = typeof chart.kind === 'string' ? chart.kind : 'body';
        _chartCaliber = typeof chart.caliber === 'string' ? chart.caliber : '';
        _chartLevel = chart.level === 1 ? 1 : 0;
        Object.assign(_flightSettings, _defaultFlight(), saved.flight || {});
        const compare = Array.isArray(_flightSettings.compare) ? _flightSettings.compare : [];
        _flightSettings.compare = [0, 1].map(function (i) { return typeof compare[i] === 'string' ? compare[i] : ''; });
        const view = saved.flightView || {};
        _flightView = FLIGHT_VIEWS.indexOf(view.view) !== -1 ? view.view : 'trajectory';
        _scopeZoom = SCOPE_ZOOMS.indexOf(view.zoom) !== -1 ? view.zoom : 4;
        _flightFocus = typeof view.focus === 'number' ? view.focus : null;
        _flightWeapon = saved.flightWeapon && saved.flightWeapon.id ? Object.assign({}, saved.flightWeapon) : null;
        _flightPicking = null;
        _flightRounds = null;
        clearTimeout(_flightTimer);
        _flightTimer = null;
        _flightResult = null;
        _flightRevision++;
    }

    // The workbench's Reset button on the drop table
    function resetFlight() {
        Object.assign(_flightSettings, _defaultFlight());
        _flightWeapon = null;
        _flightFocus = null;
        EFTForge.workbench.closePicker();
        _renderFlightLeft();
        _scheduleFlight();
    }

    function _defaultFlight() {
        return Object.assign({}, DEFAULT_FLIGHT, { compare: DEFAULT_FLIGHT.compare.slice() });
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
                // What the ballistics engine runs on, one object per load so the worker gets it once
                engine: { items: armor, ammo: ammo },
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
        // Every pick on the chart redraws it, so the tab saves the picks here
        EFTForge.workbench.saveToTab();
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

        let html = '<div class="stats-section"><div class="section-title">' + _esc(_t('workbench.tool.chart')) + '</div>' +
            _toggleRow('data-chart-kind', CHART_KINDS, _chartKind, function (k) { return _t('chart.kind.' + k); }) +
            _toggleRow('data-chart-level', [0, 1], _chartLevel, function (l) { return _t(l === 0 ? 'armorSim.col.stk50' : 'armorSim.col.stk90'); }) +
            '<div class="bw-note">' + _esc(_t('chart.intro')) + '</div></div>' +
            '<div class="stats-section"><div class="section-title">' + _esc(_t('ammo.nav.title')) + '</div>' +
            '<input type="text" class="search-input" id="bw-chart-search" placeholder="' + _esc(_t('ammo.searchPlaceholder')) + '" value="' + _esc(_chartSearch) + '">' +
            '<div class="ammo-cal-grid">' +
            '<button type="button" class="ammo-cal-chip bw-chip-all' + (_chartCaliber === '' ? ' active' : '') + '" data-chart-caliber="">' + _esc(_t('chart.allCalibers')) + '</button>';
        EFTForge.ammoTable.caliberGroups(calibers).forEach(function (group) {
            html += '<div class="ammo-cal-type-label">' + _esc(group.label) + '</div>';
            group.calibers.forEach(function (cal) {
                html += '<button type="button" class="ammo-cal-chip' + (cal === _chartCaliber ? ' active' : '') + '" data-chart-caliber="' + _esc(cal) + '">' + _esc(_calName(cal)) + '</button>';
            });
        });
        html += '</div></div>';
        left.innerHTML = html;

        // Typing only redraws the table, so the box keeps its focus
        const search = /** @type {HTMLInputElement} */ (left.querySelector('#bw-chart-search'));
        search.addEventListener('input', function () {
            _chartSearch = search.value;
            _renderChartTable();
        });

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
        // No sideways scroller of its own: the panel scrolls, so the header sticks like the ammo table's
        html += '<table class="ammo-table bw-chart-table"><thead><tr>' +
            '<th class="ammo-th ammo-col-icon bw-sticky-col"></th>' +
            '<th class="ammo-th ammo-col-name bw-sticky-col bw-sticky-col-2">' + _esc(_t('ammo.col.name')) + '</th>' +
            '<th class="ammo-th ammo-col-num">' + _esc(_t('ammo.col.dmg')) + '</th>' +
            '<th class="ammo-th ammo-col-num">' + _esc(_t('ammo.col.pen')) + '</th>';
        setups.forEach(function (setup) {
            const first = _setupItems(setup)[0];
            const icon = first && first.icon_link;
            html += '<th class="ammo-th bw-chart-th" data-tooltip-html="' + _esc(_setupCardHtml(setup)) + '">' +
                '<div class="bw-chart-col-icon">' + (icon ? '<img src="' + _esc(icon) + '" alt="" loading="lazy" decoding="async">' : '') + '</div>' +
                '<div class="bw-chart-col-name">' + _esc(_setupName(setup)) + '</div>' +
                '<div class="bw-chart-col-class">' + _classBadge(setup.armor_class) + _esc(_t('armorSim.classShort') + ' ' + setup.armor_class) + '</div></th>';
        });
        html += '</tr></thead><tbody>';
        const columns = setups.length + 4;

        const search = _chartSearch.trim().toLowerCase();
        let lastCaliber = null;
        let shown = 0;
        chart.ammo.forEach(function (row, ammoIndex) {
            if (_chartCaliber && row.caliber !== _chartCaliber) return;
            const ammo = _data.ammoById[row.id];
            if (search && !(ammo && ammo.name.toLowerCase().includes(search))) return;
            shown++;
            if (!_chartCaliber && row.caliber !== lastCaliber) {
                lastCaliber = row.caliber;
                html += '<tr class="ammo-caliber-row"><td class="ammo-caliber-label" colspan="' + columns + '"><span class="bw-sticky-label">' + _esc(_calName(row.caliber)) + '</span></td></tr>';
            }
            const pellets = ammo ? ammo.projectile_count || 1 : 1;
            html += '<tr class="ammo-data-row"><td class="ammo-td ammo-col-icon bw-sticky-col">' +
                (ammo && ammo.icon_link ? '<div class="ammo-icon-wrapper"><img class="ammo-icon-img" src="' + _esc(ammo.icon_link) + '" alt="" loading="lazy">' +
                    (ammo.short_name ? '<div class="slot-shortname">' + EFTForge.utils.shortNameHtml(ammo.short_name) + '</div>' : '') + '</div>' : '') + '</td>' +
                '<td class="ammo-td ammo-col-name bw-sticky-col bw-sticky-col-2">' + _esc(ammo ? ammo.name : row.id) + '</td>' +
                '<td class="ammo-td ammo-col-num' + (pellets > 1 ? ' ammo-dmg-multi' : '') + '">' +
                    (ammo ? (pellets > 1 ? pellets + '×' : '') + ammo.damage : '') + '</td>' +
                '<td class="ammo-td ammo-col-num">' + (ammo ? ammo.penetration_power : '') + '</td>';
            setups.forEach(function (setup) {
                const value = chart.grid[ammoIndex][setup.index][_chartLevel];
                html += '<td class="ammo-td ammo-eff eff-' + _stkTier(value) + '">' + (value == null ? '>' + chart.max_shots : value) + '</td>';
            });
            html += '</tr>';
        });
        html += '</tbody></table>';
        if (shown === 0) html += '<div class="ammo-no-results">' + _esc(_t('ammo.noResults')) + '</div>';
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

    function _classBadge(armorClass) {
        return armorClass >= 1 && armorClass <= 6
            ? '<img class="bw-builtin-class" src="./assets/images/ballistics-loadout/armor_class_' + armorClass + '.png" alt="">' : '';
    }

    // Hovering a column lists every item it stands for with its picture, and the plate
    // a carrier is worn with, in the armor simulator's built-in armor card
    function _setupCardHtml(setup) {
        const items = _setupItems(setup);
        const plateIds = setup.plate_ids || [];
        const rows = items.map(function (item) {
            const plate = _data.armorById[plateIds[setup.item_ids.indexOf(item.id)]];
            return '<div class="bw-builtin-row"><div class="bw-builtin-art">' +
                (item.icon_link ? '<img src="' + _esc(item.icon_link) + '" alt="">' : '') + '</div><div class="bw-builtin-text">' +
                '<div class="bw-builtin-head"><span class="bw-builtin-name">' + _esc(item.name) + '</span></div>' +
                (plate ? '<div class="bw-builtin-areas">' + _esc(_tFmt('chart.withPlate', { plate: plate.name })) + '</div>' : '') +
                '</div></div>';
        }).join('');
        const title = items.length > 1 ? _tFmt('chart.sameArmor', { count: items.length }) : (items[0] ? items[0].name : '?');
        return '<div class="bw-builtin-card bw-chart-card-tip"><div class="bw-builtin-title">' + _esc(title) + '</div>' +
            '<div class="bw-builtin-label">' + _classBadge(setup.armor_class) + _esc(_t('armorSim.classShort') + ' ' + setup.armor_class) + '</div>' +
            rows + '</div>';
    }

    /* ===========================
       DROP AND ZEROING TABLE
       Laid out like the armor simulator: the round sits in a slot that opens the item
       table, and the table works itself out again after every change.
    =========================== */

    function _showFlight() {
        if (!_data.ammoById[_flightSettings.ammo]) _flightSettings.ammo = '';
        _flightSettings.compare = _flightSettings.compare.map(function (id) { return _data.ammoById[id] ? id : ''; });
        _renderFlightLeft();
        _renderFlightResults();
        if (_flightSettings.ammo && !_flightResult && !_flightRunning) _scheduleFlight(0);
    }

    // The same slot as the armor simulator's ammo slot. color keys a compared round to its lines.
    function _ammoSlotHtml(which, label, ammo, color) {
        let body = '<img class="bw-slot-art bw-art-ammo" src="' + AMMO_ART + '" alt="">';
        if (ammo) {
            const damage = (ammo.projectile_count || 1) > 1 ? ammo.projectile_count + '×' + ammo.damage : ammo.damage;
            body = EFTForge.armorSim.slotColorHtml(ammo) + '<img class="bw-slot-icon" src="' + _esc(ammo.base_image_link || ammo.icon_link || '') + '" alt="" decoding="async">' +
                '<span class="bw-slot-short">' + _esc(ammo.short_name || '') + '</span>' +
                '<span class="bw-slot-stat" data-tooltip="' + _esc(_t('armorSim.col.dmgPen')) + '">' + _esc(damage + ' / ' + ammo.penetration_power) + '</span>';
        }
        const tip = ammo ? ammo.name : which === 'main' ? '' : _t('flight.compareTip');
        return '<div class="bw-slot bw-slot-ammo' + (ammo ? ' is-equipped' : '') + (which !== 'main' && !ammo ? ' bw-slot-optional' : '') +
            (_flightPicking === which ? ' active-slot' : '') + '" data-dt-slot="' + which + '" role="button" tabindex="0"' +
            ' aria-label="' + _esc(label + (ammo ? ': ' + ammo.name : '')) + '"' + (tip ? ' data-tooltip="' + _esc(tip) + '"' : '') + '>' +
            '<div class="bw-slot-header">' + (color ? '<span class="bw-series-key" style="background:' + color + '"></span>' : '') + _esc(label) + '</div>' +
            '<div class="bw-slot-body">' + body + '</div></div>';
    }

    function _renderFlightLeft() {
        const left = _el('bw-left-flight');
        if (!left) return;
        const snap = EFTForge.workbench && EFTForge.workbench.buildSnapshot();
        const ammo = _data.ammoById[_flightSettings.ammo] || null;
        const colors = EFTForge.bwCharts.SERIES_COLORS;
        const field = function (key, labelKey, tipKey) {
            const limits = FLIGHT_LIMITS[key];
            return '<div class="optimizer-field"><label class="modal-label" for="dt-' + key + '"' +
                (tipKey ? ' data-tooltip="' + _esc(_t(tipKey)) + '"' : '') + '>' + _esc(_t(labelKey)) + '</label>' +
                '<input type="number" class="optimizer-input" id="dt-' + key + '" min="' + limits[0] + '" max="' + limits[1] +
                '" step="' + limits[2] + '" value="' + _flightSettings[key] + '"></div>';
        };
        // The compare slots only show up once there is a round to compare against
        let slots = _ammoSlotHtml('main', _t('armorSim.slot.ammo'), ammo, ammo && _flightSettings.compare.some(Boolean) ? colors[0] : null);
        if (ammo) {
            _flightSettings.compare.forEach(function (id, i) {
                slots += _ammoSlotHtml(String(i), _t('flight.compareSlot'), _data.ammoById[id] || null, colors[i + 1]);
            });
        }
        left.innerHTML = `
            <div class="stats-section">
                <div class="section-title">${_esc(_t('workbench.tool.flight'))}</div>
                <div class="bw-inserts-row">${slots}</div>
                ${ammo ? '<div class="bw-note">' + _esc(_t('flight.compareHint')) + '</div>' : ''}
                <div class="stats-divider"></div>
                <div class="optimizer-field-row">${field('zero', 'flight.zero')}${field('sight', 'flight.sight', 'flight.sightTip')}</div>
                <div class="optimizer-field-row">${field('max', 'flight.max')}${field('step', 'flight.step')}</div>
                <div class="optimizer-field-row">${field('velocity', 'armorSim.velocity', 'armorSim.velocityTip')}${field('moa', 'flight.accuracy', 'flight.accuracyTip')}</div>
                <div class="stats-divider"></div>
                ${_zeroChoiceHtml()}
                ${snap && snap.serial !== _flightUsedSnapshot ? '<button type="button" class="modal-btn full-width bw-use-build" id="dt-use-build">' +
                    _esc(_tFmt('flight.useBuild', { gun: snap.label })) + '<span class="bw-use-build-sub">' + _esc(_t('flight.useBuildSub')) + '</span></button>' : ''}
                <button type="button" class="modal-btn full-width bw-mobile-only" id="dt-show-results">${_esc(_t('armorSim.showResults'))}</button>
            </div>
            <div class="stats-section bw-notes-section"><div class="bw-note">${_esc(_t('flight.intro'))}</div></div>`;

        left.querySelectorAll('[data-dt-slot]').forEach(function (node) {
            const which = /** @type {HTMLElement} */ (node).dataset.dtSlot;
            node.addEventListener('click', function () { _openAmmoPicker(which); });
            node.addEventListener('keydown', function (event) {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                _openAmmoPicker(which);
            });
            if (which === 'main') return;
            // Right click or a swipe takes a compared round out, like the armor simulator's slots
            const remove = function () { _setCompare(Number(which), ''); };
            node.addEventListener('contextmenu', function (event) {
                if (!_flightSettings.compare[Number(which)]) return;
                event.preventDefault();
                remove();
            });
            if (typeof addSwipeToRemove === 'function' && _flightSettings.compare[Number(which)]) {
                addSwipeToRemove(node.querySelector('.bw-slot-body'), remove);
            }
        });
        Object.keys(FLIGHT_LIMITS).forEach(function (key) {
            const input = _el('dt-' + key);
            const limits = FLIGHT_LIMITS[key];
            input.addEventListener('input', function () {
                const value = parseFloat(input.value);
                if (!isFinite(value)) return;
                _flightSettings[key] = Math.min(Math.max(value, limits[0]), limits[1]);
                // Accuracy only changes how the results are drawn, so there's nothing to rerun
                if (key === 'moa') {
                    EFTForge.workbench.saveToTab();
                    _renderFlightResults();
                    return;
                }
                _scheduleFlight();
            });
            input.addEventListener('change', function () { input.value = String(_flightSettings[key]); });
        });
        left.querySelectorAll('[data-dt-zero]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                const self = /** @type {HTMLElement} */ (btn).dataset.dtZero === 'self';
                if (!_flightWeapon || !!_flightWeapon.zeroSelf === self) return;
                _flightWeapon.zeroSelf = self;
                _renderFlightLeft();
                _scheduleFlight(0);
            });
        });
        const useBuild = _el('dt-use-build');
        if (useBuild) useBuild.addEventListener('click', function () {
            _flightUseBuild();
            _renderFlightLeft();
        });
        _el('dt-show-results').addEventListener('click', function () { openMobileRightPanel(); });
    }

    // Without a weapon the round can only zero itself; with one, the player picks which round
    // sets the zero, and can flip back and forth
    function _zeroChoiceHtml() {
        if (!_flightWeapon) return '<div class="bw-note">' + _esc(_t('flight.noWeapon')) + '</div>';
        const self = !!_flightWeapon.zeroSelf;
        const zeroAmmo = _data.ammoById[_flightWeapon.zeroAmmoId];
        const ammo = _data.ammoById[_flightSettings.ammo];
        const option = function (value, label, active) {
            return '<button type="button" class="toggle-btn' + (active ? ' active' : '') + '" data-dt-zero="' + value + '">' + _esc(label) + '</button>';
        };
        return '<div class="optimizer-field"><span class="modal-label">' + _esc(_t('flight.zeroWith')) + '</span>' +
            '<div class="bw-toggle-row">' +
            option('weapon', zeroAmmo ? _tFmt('flight.zeroDefaultAmmo', { ammo: zeroAmmo.short_name || zeroAmmo.name }) : _t('flight.zeroDefault'), !self) +
            option('self', ammo ? _tFmt('flight.zeroSelfAmmo', { ammo: ammo.short_name || ammo.name }) : _t('flight.zeroSelf'), self) +
            '</div></div>' +
            '<div class="bw-note">' + _esc(_tFmt(self ? 'flight.weaponSelf' : 'flight.weapon', { weapon: _flightWeapon.name })) + '</div>';
    }

    function _slotEl(which) {
        return document.querySelector('#bw-left-flight [data-dt-slot="' + which + '"]');
    }

    function _openAmmoPicker(which) {
        const main = which === 'main';
        const current = _data.ammoById[_flightSettings.ammo];
        // Any caliber can be compared: one the weapon can't fire is zeroed with itself
        const rows = _data.ammo.filter(function (row) {
            if (!row.velocity || row.penetration_power == null) return false;
            return main || row.id !== current.id;
        });
        EFTForge.workbench.openPicker({
            slotName: main ? _t('armorSim.slot.ammo') : _t('flight.compareSlot'),
            art: AMMO_ART,
            artKind: 'ammo',
            rows: rows,
            ammoTable: true,
            key: 'flight-ammo-' + which,
            currentId: function () { return (main ? _flightSettings.ammo : _flightSettings.compare[Number(which)]) || null; },
            sort: { key: 'penetration_power', asc: false },
            onPick: function (row) {
                if (main) {
                    _flightSettings.ammo = row.id;
                    // The new main round leaves the comparison if it was in it
                    _flightSettings.compare = _flightSettings.compare.map(function (id) { return id === row.id ? '' : id; });
                    _renderFlightLeft();
                    EFTForge.workbench.flashSlot(_slotEl('main'), 'install');
                    _scheduleFlight(0);
                } else {
                    _setCompare(Number(which), row.id);
                    EFTForge.workbench.flashSlot(_slotEl(which), 'install');
                }
            },
            onRemove: main ? null : function () {
                _setCompare(Number(which), '');
                EFTForge.workbench.closePicker();
            },
            onClose: function () {
                _flightPicking = null;
                const slot = _slotEl(which);
                if (slot) slot.classList.remove('active-slot');
            },
        });
        _flightPicking = which;
        const slot = _slotEl(which);
        if (slot) slot.classList.add('active-slot');
    }

    function _setCompare(index, id) {
        // The same round in both slots would just draw one line over the other
        if (id && _flightSettings.compare.indexOf(id) !== -1) return;
        _flightSettings.compare[index] = id;
        _renderFlightLeft();
        _scheduleFlight(0);
    }

    // The button's job: fill in the build the workbench was opened from, only when asked
    function _flightUseBuild() {
        const snap = EFTForge.workbench && EFTForge.workbench.buildSnapshot();
        if (!snap) return;
        _flightUsedSnapshot = snap.serial;
        if (snap.ammoId && _data.ammoById[snap.ammoId]) {
            _flightSettings.ammo = snap.ammoId;
            _flightSettings.compare = _flightSettings.compare.map(function (id) { return id === snap.ammoId ? '' : id; });
        }
        if (snap.velocityPct != null) _flightSettings.velocity = Math.round(snap.velocityPct * 100) / 100;
        // The build's MOA already carries its loaded round's modifier, which we take back out
        // so each round in the table gets its own
        if (snap.accuracyMoa != null) {
            const loaded = snap.ammoApplied ? _data.ammoById[snap.ammoId] : null;
            _flightSettings.moa = Math.round(snap.accuracyMoa / _ammoAccuracyFactor(loaded) * 100) / 100;
        }
        _flightWeapon = { id: snap.gunId, name: snap.gunName };
        _scheduleFlight(0);
    }

    // Same as backend/stats.py::ammo_accuracy_factor: a bonus divides MOA, a penalty multiplies it
    function _ammoAccuracyFactor(ammo) {
        const acc = (ammo && ammo.accuracy_modifier) || 0;
        return acc <= 0 ? (100 + Math.abs(acc)) / 100 : 100 / (100 + acc);
    }

    // How far a round can land from the aim point at this distance, in cm, or null without an MOA
    function _spreadCm(ammo, distance) {
        if (!(_flightSettings.moa > 0)) return null;
        return _flightSettings.moa * _ammoAccuracyFactor(ammo) * MRAD_PER_MOA * distance / 10;
    }

    // Work the table out again once the player pauses, like the armor simulator
    function _scheduleFlight(delay) {
        EFTForge.workbench.saveToTab();
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
            compare_ammo_ids: _flightSettings.compare.filter(Boolean),
            weapon_id: _flightWeapon && !_flightWeapon.zeroSelf ? _flightWeapon.id : null,
            zero_distance: _flightSettings.zero,
            sight_height_cm: _flightSettings.sight,
            max_distance: _flightSettings.max,
            step: _flightSettings.step,
            velocity_modifier_pct: _flightSettings.velocity,
        };
        try {
            // The weapon's default ammo sets the zero; one we don't know zeros the loaded round
            const gun = payload.weapon_id && ((EFTForge.state && EFTForge.state.allGuns) || []).find(function (g) { return g.id === payload.weapon_id; });
            const request = Object.assign({}, payload, { zero_ammo_id: gun && gun.default_ammo_id && _data.ammoById[gun.default_ammo_id] ? gun.default_ammo_id : null });
            // Worked out on the player's own machine by the ballistics engine's worker
            const res = await EFTForge.ballisticsLocal.flight(request, _data.engine);
            const data = res.data;
            if (revision !== _flightRevision) return;
            if (!res.ok) {
                const detail = data && data.detail;
                _flightResult = { error: typeof detail === 'string' ? detail : _t('armorSim.runError') };
            } else {
                _flightResult = { data: data, payload: payload };
                // Name the weapon's default ammo on its zero button, in place so a field being typed in keeps focus
                if (payload.weapon_id && _flightWeapon && _flightWeapon.id === payload.weapon_id && _flightWeapon.zeroAmmoId !== data.zero_ammo_id) {
                    _flightWeapon.zeroAmmoId = data.zero_ammo_id;
                    const zeroAmmo = _data.ammoById[data.zero_ammo_id];
                    const button = document.querySelector('#bw-left-flight [data-dt-zero="weapon"]');
                    if (button && zeroAmmo) button.textContent = _tFmt('flight.zeroDefaultAmmo', { ammo: zeroAmmo.short_name || zeroAmmo.name });
                    EFTForge.workbench.saveToTab();
                }
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
        _flightRounds = null;
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
        const colors = EFTForge.bwCharts.SERIES_COLORS;
        // Each compared round keeps the color of the slot it sits in
        _flightRounds = [{ ammo: ammo, rows: data.rows, color: colors[0] }];
        (data.compare || []).forEach(function (entry) {
            const slot = _flightSettings.compare.indexOf(entry.ammo_id);
            if (slot === -1 || !_data.ammoById[entry.ammo_id]) return;
            _flightRounds.push({
                ammo: _data.ammoById[entry.ammo_id], rows: entry.rows, color: colors[slot + 1],
                ownZero: entry.zero_ammo_id === entry.ammo_id && entry.zero_ammo_id !== data.zero_ammo_id,
            });
        });
        const rows = data.rows;
        const reach = rows.filter(function (row) { return row.distance > 0; });
        if (reach.length && !reach.some(function (row) { return row.distance === _flightFocus; })) {
            // Start the scope past the zero, where the drop starts to matter
            const wanted = _flightFocus != null ? _flightFocus : payload.zero_distance * 2;
            _flightFocus = reach.reduce(function (best, row) {
                return Math.abs(row.distance - wanted) < Math.abs(best.distance - wanted) ? row : best;
            }).distance;
        }

        let html = '<div class="att-table-header">' +
            (ammo && ammo.icon_link ? '<div class="att-table-icon-preview"><img class="att-table-gun-img" src="' + _esc(ammo.icon_link) +
                '" alt=""><div class="slot-shortname">' + EFTForge.utils.shortNameHtml(ammo.short_name || '') + '</div></div>' : '') +
            '<h3>' + _esc(_t('workbench.tool.flight')) + ' <strong>' + _esc(ammo ? ammo.name : '') + '</strong></h3></div>' +
            '<div class="bw-result-meta">' + _esc(_tFmt('flight.summary', { speed: Math.round(data.muzzle_speed), zero: payload.zero_distance })) +
            ' · ' + _esc(_tFmt('flight.zeroedWith', { ammo: zeroAmmo ? zeroAmmo.name : '' })) +
            (_flightSettings.moa > 0 ? ' · ' + _esc(_tFmt('flight.moaWith', { moa: (_flightSettings.moa * _ammoAccuracyFactor(ammo)).toFixed(2) })) : '') + '</div>';

        const cell = function (value, label) {
            return '<div class="bw-summary-cell"><span class="bw-summary-value">' + _esc(value) +
                '</span><span class="bw-summary-label">' + _esc(label) + '</span></div>';
        };
        const last = rows[rows.length - 1];
        const subsonic = rows.find(function (row) { return row.speed < SPEED_OF_SOUND; });
        html += '<div class="bw-summary">' +
            cell(Math.round(data.muzzle_speed) + ' ' + _t('flight.unit.speed'), _t('flight.stat.muzzle')) +
            cell(subsonic ? Math.round(subsonic.distance) + ' m' : '> ' + Math.round(last.distance) + ' m', _t('flight.stat.subsonic')) +
            cell(_signed(last.impact_cm, 1) + ' ' + _t('flight.unit.cm'), _tFmt('flight.stat.impactAt', { d: Math.round(last.distance) })) +
            (_flightSettings.moa > 0 ? cell('±' + _spreadCm(ammo, 100).toFixed(1) + ' ' + _t('flight.unit.cm'), _t('flight.stat.spread100')) : '') +
            '</div>';

        html += '<div class="bw-flight-visuals">' +
            '<div class="bw-card bw-chart-card">' +
            _toggleRow('data-dt-view', FLIGHT_VIEWS, _flightView, function (v) { return _t('flight.view.' + v); }) +
            '<div id="dt-chart"></div>' +
            '<div class="bw-note">' + _esc(_t('flight.chartHint')) + '</div></div>' +
            '<div class="bw-card bw-scope-card" id="dt-scope"></div></div>';

        const spread = _flightSettings.moa > 0;
        const columns = ['flight.col.distance', 'flight.col.impact', 'flight.col.hold']
            .concat(spread ? ['flight.col.spread'] : [])
            .concat(['flight.col.speed', 'flight.col.time', 'flight.col.damage', 'flight.col.pen']);
        html += '<h4 class="bw-subheading">' + _esc(_tFmt('flight.tableFor', { ammo: ammo ? ammo.short_name || ammo.name : '' })) + '</h4>' +
            '<div class="bw-table-scroll"><table class="attachment-table bw-table bw-flight-table"><thead><tr>' +
            columns.map(function (key) { return '<th>' + _esc(_t(key)) + '</th>'; }).join('') + '</tr></thead><tbody>';
        rows.forEach(function (row) {
            const zero = Math.abs(row.distance - payload.zero_distance) < 1e-6;
            const classes = (zero ? 'attachment-row-installed' : '') + (row.distance === _flightFocus ? ' bw-row-focus' : '');
            html += '<tr data-distance="' + row.distance + '"' + (classes.trim() ? ' class="' + classes.trim() + '"' : '') +
                (row.distance > 0 ? ' tabindex="0"' : '') + '><td>' + Math.round(row.distance) + '</td>' +
                '<td>' + _signed(row.impact_cm, 1) + '</td>' +
                '<td>' + (row.distance > 0 ? _signed(row.correction_mrad, 2) : '') + '</td>' +
                (spread ? '<td>' + (row.distance > 0 ? '±' + _spreadCm(ammo, row.distance).toFixed(1) : '') + '</td>' : '') +
                '<td>' + Math.round(row.speed) + '</td>' +
                '<td>' + Math.round(row.time * 1000) + '</td>' +
                '<td>' + (row.damage == null ? '' : _num(row.damage, 1)) + '</td>' +
                '<td>' + (row.penetration == null ? '' : _num(row.penetration, 1)) + '</td></tr>';
        });
        html += '</tbody></table></div><div class="bw-note">' + _esc(_t('flight.method')) + '</div>';
        right.innerHTML = html;

        right.querySelectorAll('[data-dt-view]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                _flightView = /** @type {HTMLElement} */ (btn).dataset.dtView;
                right.querySelectorAll('[data-dt-view]').forEach(function (other) { other.classList.toggle('active', other === btn); });
                EFTForge.workbench.saveToTab();
                _drawFlightChart();
            });
        });
        right.querySelectorAll('.bw-flight-table tr[data-distance]').forEach(function (tr) {
            const distance = Number(/** @type {HTMLElement} */ (tr).dataset.distance);
            if (!(distance > 0)) return;
            tr.addEventListener('click', function () { _setFocus(distance); });
            tr.addEventListener('keydown', function (event) {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                _setFocus(distance);
            });
        });
        _drawFlightChart();
        _renderScope();
    }

    // One distance drives the scope, the chart's marker and the table's highlighted row
    function _setFocus(distance, fromSlider) {
        if (!_flightRounds || distance === _flightFocus) return;
        _flightFocus = distance;
        EFTForge.workbench.saveToTab();
        _drawFlightChart();
        _updateScope();
        document.querySelectorAll('#bw-right-flight .bw-flight-table tr[data-distance]').forEach(function (tr) {
            tr.classList.toggle('bw-row-focus', Number(/** @type {HTMLElement} */ (tr).dataset.distance) === distance);
        });
        if (!fromSlider) {
            const slider = /** @type {HTMLInputElement | null} */ (_el('dt-scope-range'));
            const reach = _scopeDistances();
            if (slider) slider.value = String(reach.indexOf(distance));
        }
    }

    function _drawFlightChart() {
        const host = _el('dt-chart');
        if (!host || !_flightRounds) return;
        const view = _flightView;
        const value = {
            trajectory: function (row) { return row.impact_cm; },
            speed: function (row) { return row.speed; },
            damage: function (row) { return row.damage; },
            pen: function (row) { return row.penetration; },
        }[view];
        const unit = { trajectory: _t('flight.unit.cm'), speed: _t('flight.unit.speed'), damage: '', pen: '' }[view];
        const series = _flightRounds.map(function (round, i) {
            const points = round.rows.filter(function (row) { return value(row) != null; })
                .map(function (row) { return { x: row.distance, y: value(row) }; });
            const entry = { name: round.ammo.short_name || round.ammo.name, color: round.color, points: points };
            // The main round's spread drawn around its path, so the reader sees how much the drop matters
            if (view === 'trajectory' && i === 0 && _flightSettings.moa > 0) {
                entry.band = round.rows.map(function (row) {
                    const r = _spreadCm(round.ammo, row.distance);
                    return { x: row.distance, lo: row.impact_cm - r, hi: row.impact_cm + r };
                });
            }
            return entry;
        });
        const refs = [];
        if (view === 'trajectory') refs.push({ y: 0, label: _t('flight.sightLine') });
        if (view === 'speed') {
            // Only worth a line when a round gets near it
            const slowest = Math.min.apply(null, series.map(function (s) { return Math.min.apply(null, s.points.map(function (p) { return p.y; })); }));
            if (slowest < SPEED_OF_SOUND * 1.3) refs.push({ y: SPEED_OF_SOUND, label: _t('flight.soundBarrier') });
        }
        const digits = view === 'speed' ? 0 : 1;
        EFTForge.bwCharts.line(host, {
            series: series,
            xLabel: _t('flight.col.distance'),
            yLabel: _t({ trajectory: 'flight.col.impact', speed: 'flight.col.speed', damage: 'flight.col.damage', pen: 'flight.col.pen' }[view]),
            xFormat: function (x) { return String(Math.round(x)); },
            yFormat: function (y) { return view === 'trajectory' ? _signed(y, 0) : String(Math.round(y)); },
            tipTitle: function (x) { return Math.round(x) + ' m'; },
            tipValue: function (y) { return (view === 'trajectory' ? _signed(y, digits) : _num(y, digits)) + (unit ? ' ' + unit : ''); },
            refs: refs,
            focusX: _flightFocus,
            onPick: function (x) { if (x > 0) _setFocus(x); },
        });
    }

    /* ===========================
       SCOPE VIEW
       Looking through the sight at a 1.8 m figure at the focused distance, aimed at the
       middle of the chest: where each round lands, and how far the spread reaches.
    =========================== */

    // Meters from the chest aim point, y up: [x0, y0, x1, y1, corner radius]
    const FIGURE = [
        [-0.05, 0.25, 0.05, 0.34, 0.02],    // neck
        [-0.20, -0.30, 0.20, 0.27, 0.06],   // chest
        [-0.17, -0.58, 0.17, -0.28, 0.04],  // stomach
        [-0.30, -0.52, -0.21, 0.22, 0.04],  // arms
        [0.21, -0.52, 0.30, 0.22, 0.04],
        [-0.17, -1.38, -0.02, -0.56, 0.04], // legs
        [0.02, -1.38, 0.17, -0.56, 0.04],
    ];
    const HEAD = { y: 0.43, r: 0.11 };

    function _scopeDistances() {
        return _flightRounds ? _flightRounds[0].rows.filter(function (row) { return row.distance > 0; }).map(function (row) { return row.distance; }) : [];
    }

    function _renderScope() {
        const box = _el('dt-scope');
        if (!box) return;
        const reach = _scopeDistances();
        if (reach.length === 0) { box.innerHTML = ''; return; }
        box.innerHTML = '<div class="bw-scope-layout"><div class="bw-scope-view" id="dt-scope-view"></div><div class="bw-scope-side">' +
            '<div class="bw-scope-head"><span class="bw-scope-title">' + _esc(_t('flight.scope')) + '</span>' +
            '<div class="bw-toggle-row bw-scope-zoom">' + SCOPE_ZOOMS.map(function (zoom) {
                return '<button type="button" class="toggle-btn' + (zoom === _scopeZoom ? ' active' : '') + '" data-dt-zoom="' + zoom + '">' + zoom + '×</button>';
            }).join('') + '</div></div>' +
            '<div class="bw-scope-range"><input type="range" class="bw-range" id="dt-scope-range" min="0" max="' + (reach.length - 1) +
            '" step="1" value="' + Math.max(0, reach.indexOf(_flightFocus)) + '" aria-label="' + _esc(_t('flight.col.distance')) + '">' +
            '<span class="bw-scope-distance" id="dt-scope-distance"></span></div>' +
            '<div class="bw-scope-readout" id="dt-scope-readout"></div>' +
            '<div class="bw-note">' + _esc(_t('flight.scopeNote')) + '</div></div></div>';
        box.querySelectorAll('[data-dt-zoom]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                _scopeZoom = Number(/** @type {HTMLElement} */ (btn).dataset.dtZoom);
                box.querySelectorAll('[data-dt-zoom]').forEach(function (other) { other.classList.toggle('active', other === btn); });
                EFTForge.workbench.saveToTab();
                _updateScope();
            });
        });
        const range = /** @type {HTMLInputElement} */ (_el('dt-scope-range'));
        range.addEventListener('input', function () { _setFocus(reach[Number(range.value)], true); });
        _updateScope();
    }

    function _updateScope() {
        const view = _el('dt-scope-view');
        if (!view || !_flightRounds) return;
        const distance = _flightFocus;
        const main = _flightRounds[0];
        const row = main.rows.find(function (r) { return r.distance === distance; });
        if (!row) return;
        const half = SCOPE_FIELD / _scopeZoom;  // mrad from the center to the edge
        const unit = function (mrad) { return mrad / half; };
        const meters = function (m) { return unit(m * 1000 / distance); };
        const f = function (n) { return n.toFixed(4); };

        let svg = '<svg viewBox="-1 -1 2 2" class="bw-scope-svg" role="img" aria-label="' + _esc(_t('flight.scope')) + '">' +
            '<defs><clipPath id="dt-scope-clip"><circle r="0.98"></circle></clipPath></defs>' +
            '<circle r="0.98" class="bw-scope-glass"></circle><g clip-path="url(#dt-scope-clip)">';
        FIGURE.forEach(function (part) {
            const x = meters(part[0]);
            const y = -meters(part[3]);
            svg += '<rect class="bw-scope-figure" x="' + f(x) + '" y="' + f(y) + '" width="' + f(meters(part[2] - part[0])) +
                '" height="' + f(meters(part[3] - part[1])) + '" rx="' + f(meters(part[4])) + '"></rect>';
        });
        svg += '<circle class="bw-scope-figure" cy="' + f(-meters(HEAD.y)) + '" r="' + f(meters(HEAD.r)) + '"></circle>';

        // Mil ticks along both crosshair lines, longer with a number on the labelled ones
        const step = half > 20 ? 5 : 1;
        const every = half > 20 ? 10 : half > 8 ? 5 : 2;
        for (let m = step; m < half; m += step) {
            const labelled = m % every === 0;
            const len = labelled ? 0.06 : 0.035;
            [m, -m].forEach(function (v) {
                const p = unit(v);
                svg += '<line class="bw-scope-tick" x1="' + f(p) + '" x2="' + f(p) + '" y1="' + -len + '" y2="' + len + '"></line>' +
                    '<line class="bw-scope-tick" y1="' + f(p) + '" y2="' + f(p) + '" x1="' + -len + '" x2="' + len + '"></line>';
            });
            if (labelled) {
                svg += '<text class="bw-scope-label" x="' + f(unit(m)) + '" y="0.135" text-anchor="middle">' + m + '</text>' +
                    '<text class="bw-scope-label" x="0.085" y="' + f(unit(m) + 0.021) + '">' + m + '</text>';
            }
        }
        svg += '<line class="bw-scope-hair" x1="-1" x2="1" y1="0" y2="0"></line><line class="bw-scope-hair" y1="-1" y2="1" x1="0" x2="0"></line>' +
            '<line class="bw-scope-post" x1="-1" x2="-0.6" y1="0" y2="0"></line><line class="bw-scope-post" x1="0.6" x2="1" y1="0" y2="0"></line>' +
            '<line class="bw-scope-post" y1="0.6" y2="1" x1="0" x2="0"></line>';

        // The main round's spread, then every round's point of impact with the main one on top
        const spread = _spreadCm(main.ammo, distance);
        const mainY = -meters(row.impact_cm / 100);
        if (spread != null) {
            svg += '<circle class="bw-scope-spread" cy="' + f(mainY) + '" r="' + f(meters(spread / 100)) + '" stroke="' + main.color + '" fill="' + main.color + '"></circle>';
        }
        _flightRounds.slice().reverse().forEach(function (round) {
            const hit = round.rows.find(function (r) { return r.distance === distance; });
            if (!hit) return;
            const y = -meters(hit.impact_cm / 100);
            if (Math.abs(y) > 0.95) {
                // Off the glass: a marker at the edge pointing the way it went
                const edge = y > 0 ? 0.9 : -0.9;
                const tip = y > 0 ? 0.97 : -0.97;
                svg += '<polygon class="bw-scope-off" fill="' + round.color + '" points="-0.04,' + edge + ' 0.04,' + edge + ' 0,' + tip + '"></polygon>';
                return;
            }
            svg += '<circle class="bw-scope-hit" cy="' + f(y) + '" r="0.03" fill="' + round.color + '"></circle>';
        });
        svg += '</g><circle r="0.98" class="bw-scope-ring"></circle></svg>';
        view.innerHTML = svg;

        _el('dt-scope-distance').textContent = Math.round(distance) + ' m';
        const lands = function (cm) {
            if (Math.abs(cm) < 0.05) return _t('flight.onAim');
            return _tFmt(cm < 0 ? 'flight.low' : 'flight.high', { cm: Math.abs(cm).toFixed(1) });
        };
        // Every round at this distance, so comparing them needs no hovering
        const spreadOn = _flightSettings.moa > 0;
        let readout = '<table class="attachment-table bw-table bw-static-table bw-scope-table"><thead><tr>' +
            ['armorSim.col.ammo', 'flight.col.lands', 'flight.col.hold'].concat(spreadOn ? ['flight.col.spread'] : [])
                .concat(['flight.col.speed', 'flight.col.time', 'flight.col.damage', 'flight.col.pen'])
                .map(function (key) { return '<th>' + _esc(_t(key)) + '</th>'; }).join('') + '</tr></thead><tbody>';
        _flightRounds.forEach(function (round) {
            const hit = round.rows.find(function (r) { return r.distance === distance; });
            readout += '<tr><td><span class="bw-scope-round"><span class="bw-series-key" style="background:' + round.color + '"></span>' +
                _esc(round.ammo.short_name || round.ammo.name) + '</span>' +
                (round.ownZero ? ' <span class="bw-chip" data-tooltip="' + _esc(_t('flight.ownZeroTip')) + '">' + _esc(_t('flight.ownZero')) + '</span>' : '') + '</td>';
            if (!hit) {
                readout += '<td colspan="' + (spreadOn ? 7 : 6) + '">-</td></tr>';
                return;
            }
            readout += '<td><strong>' + _esc(lands(hit.impact_cm)) + '</strong></td>' +
                '<td>' + _signed(hit.correction_mrad, 2) + '</td>' +
                (spreadOn ? '<td>±' + _spreadCm(round.ammo, distance).toFixed(1) + '</td>' : '') +
                '<td>' + Math.round(hit.speed) + '</td>' +
                '<td>' + Math.round(hit.time * 1000) + '</td>' +
                '<td>' + (hit.damage == null ? '' : _num(hit.damage, 1)) + '</td>' +
                '<td>' + (hit.penetration == null ? '' : _num(hit.penetration, 1)) + '</td></tr>';
        });
        readout += '</tbody></table>';
        _el('dt-scope-readout').innerHTML = readout;
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

    return { show: show, resetFlight: resetFlight, onLangChange: onLangChange, getState: getState, setState: setState };

}());
