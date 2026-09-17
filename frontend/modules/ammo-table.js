window.EFTForge = window.EFTForge || {};

/* ============================================================
   AMMO TABLE MODULE
   Full ballistics chart modelled on the EFT wiki.
   Sections: How to read legend | Caliber quick-nav | Table
   Table columns: Caliber | Name | DMG | Pen | Pen Chance% | Pen Dev |
                  Armor% | Post-Pen% | Frag% | Rico% | Acc% | Recoil |
                  Feed Malf% | Misfire% | Lt Bleed% | Hv Bleed% | m/s |
                  Heat | Dura Burn | Class 1-6 effectiveness
============================================================ */

window.EFTForge.ammoTable = (function () {

    let _cache      = null;
    let _cacheLang  = null;
    let _sortCol    = 'penetration_power';
    let _sortAsc    = true;
    const _globalSort = false;
    let _search     = '';

    /* ---- Caliber display names.
       Ammo and weapon items share the same caliber IDs, so config.js
       CALIBER_DISPLAY_MAP is the single source of truth. Look up live so the
       two never drift apart. ---- */
    function _calName(cal) {
        const map = (window.EFTForge && EFTForge.config && EFTForge.config.CALIBER_DISPLAY_MAP) || {};
        return map[cal] || cal;
    }

    /* ---- Armor class effectiveness ----
       Mirrors the in-game ammo screen's discrete scale instead of a 0-6 number.

       Each armor class C (1-6) has an effective durability of C * 10:
       - pen >= C*10  -> the round beats that class reliably -> "Very High".
       - The first class the round can NOT beat is the "stopping" class; its
         rating comes from the ones digit of the pen value:
             8-9 -> High, 6-7 -> Medium, 3-5 -> Low, 0-2 -> Very Low.
       - Every class above the stopping class is already stopped -> "Very Low".

       Tier keys (strong -> weak): vhigh | high | med | low | vlow. ---- */

    // Multi-pellet ammo: tagged "buckshot", or fires several projectiles like
    // the Piranha (10 pellets, but typed "bullet"). A 2-projectile Dual Sabot
    // slug stays a slug, so require 3+ pellets for the untagged case.
    // Used to keep buckshot grouped above slugs in the per-caliber sort.
    function _isBuckshot(row) {
        return row.ammo_type === 'buckshot' || (row.projectile_count || 1) >= 3;
    }

    function _digitTier(pen) {
        const d = pen % 10;
        if (d >= 8) return 'high';   // 8-9
        if (d >= 6) return 'med';    // 6-7
        if (d >= 3) return 'low';    // 3-5
        return 'vlow';               // 0-2
    }

    function _calcEff(pen, classIdx) {
        if (pen == null) return null;
        const dur = (classIdx + 1) * 10;          // this class's effective durability
        if (pen >= dur) return 'vhigh';
        // Not beaten: the stopping class (first one not beaten) gets the digit
        // tier; any class beyond it is already stopped -> very low.
        const prevDur = classIdx * 10;            // class below this one
        if (classIdx === 0 || pen >= prevDur) return _digitTier(pen);
        return 'vlow';
    }

    /* ===========================
       PUBLIC API
    =========================== */

    function showPanel() {
        const overlay  = document.getElementById('ammo-overlay');
        const backdrop = document.getElementById('ammo-backdrop');
        if (!overlay) return;

        overlay.classList.add('visible');
        if (backdrop) backdrop.classList.add('visible');
        document.getElementById('main-container')?.setAttribute('inert', '');
        if (document.activeElement) document.activeElement.blur();

        _updateStaticText();
        _loadData();
    }

    function hidePanel() {
        const overlay  = document.getElementById('ammo-overlay');
        const backdrop = document.getElementById('ammo-backdrop');
        if (overlay)  overlay.classList.remove('visible');
        if (backdrop) backdrop.classList.remove('visible');
        document.getElementById('main-container')?.removeAttribute('inert');
    }

    function onLangChange() {
        const overlay = document.getElementById('ammo-overlay');
        if (!overlay || !overlay.classList.contains('visible')) return;
        _updateStaticText();
        _loadData();
    }

    function init() {
        const closeBtn = document.getElementById('ammo-close-btn');
        if (closeBtn) closeBtn.addEventListener('click', hidePanel);

        const backdrop = document.getElementById('ammo-backdrop');
        if (backdrop) backdrop.addEventListener('click', hidePanel);

        const searchEl = document.getElementById('ammo-search');
        if (searchEl) {
            searchEl.addEventListener('input', function () {
                _search = searchEl.value.trim().toLowerCase();
                if (_cache) _render();
            });
        }

        _buildDisclaimer();
        _buildCaliberNav();
        _buildDenotationNotes();
    }

    /* ===========================
       PRIVATE - DATA
    =========================== */

    async function _loadData() {
        const lang = (window.EFTForge.state && window.EFTForge.state.lang) || 'en';
        if (_cache && _cacheLang === lang) { _render(); return; }
        _cache = null;

        const container = document.getElementById('ammo-table-container');
        if (container) container.innerHTML = '<div class="ammo-loading">' + _t('ammo.loading') + '</div>';

        try {
            const res  = await fetch(EFTForge.config.API_BASE + '/ammo/all?lang=' + lang);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            _cache = await res.json();
            _cacheLang = lang;
            // Rebuild chips now that we have the real caliber keys from the API
            const chipsWrap = document.querySelector('.ammo-cal-chips-wrap');
            if (chipsWrap) _renderCaliberChips(chipsWrap);
            _render();
        } catch (err) {
            console.error('[ammo-table] load error:', err);
            const c = document.getElementById('ammo-table-container');
            if (c) c.innerHTML = '<div class="ammo-error">' + _t('ammo.loadError') + '</div>';
        }
    }

    /* ===========================
       PRIVATE - RENDER
    =========================== */

    function _render() {
        const container = document.getElementById('ammo-table-container');
        if (!container || !_cache) return;

        // Flatten all rows, apply search + category filter
        let rows = _getFilteredRows();

        if (rows.length === 0) {
            container.innerHTML = '<div class="ammo-no-results">' + _t('ammo.noResults') + '</div>';
            return;
        }

        if (_globalSort) {
            rows = _sortRows(rows);
            container.innerHTML = '';
            container.appendChild(_buildTable(rows, false));
        } else {
            // Group by caliber, sort within each group
            const groups = _groupByCaliber(rows);
            container.innerHTML = '';
            const table = _buildTable(groups, true);
            container.appendChild(table);
        }

        _updateCaliberNavHighlight();
    }

    function _getFilteredRows() {
        if (!_cache) return [];
        const all = [];
        const cals = Object.keys(_cache);
        cals.forEach(function (cal) {
            const rows = _cache[cal] || [];
            rows.forEach(function (r) {
                if (!_search || r.name.toLowerCase().includes(_search)) {
                    all.push(r);
                }
            });
        });
        return all;
    }

    function _groupByCaliber(rows) {
        // Maintain caliber order from keys (sorted server-side by caliber name)
        const seen = [];
        const map  = {};
        rows.forEach(function (r) {
            const cal = r.caliber || 'Unknown';
            if (!map[cal]) { map[cal] = []; seen.push(cal); }
            map[cal].push(r);
        });
        return seen.map(function (cal) {
            return { caliber: cal, rows: _sortGroupRows(map[cal]) };
        });
    }

    function _sortGroupRows(rows) {
        // Within a caliber, keep buckshot/pellet ammo as a top block and
        // slugs (and anything else) as a block below, each sorted independently
        // by the active sort column. Only shotgun-type calibers mix the two.
        const sorted = _sortRows(rows);
        const buck = [], rest = [];
        sorted.forEach(function (r) {
            (_isBuckshot(r) ? buck : rest).push(r);
        });
        if (buck.length === 0 || rest.length === 0) return sorted;
        return buck.concat(rest);
    }

    function _sortVal(row, col) {
        // Damage column sorts by effective total (pellets x per-pellet damage)
        if (col === 'damage' && row.damage != null) {
            return row.damage * (row.projectile_count || 1);
        }
        return row[col];
    }

    function _sortRows(rows) {
        return rows.slice().sort(function (a, b) {
            const va = _sortVal(a, _sortCol);
            const vb = _sortVal(b, _sortCol);
            if (va == null && vb == null) return 0;
            if (va == null) return 1;
            if (vb == null) return -1;
            if (typeof va === 'string') {
                const cmp = va.localeCompare(vb);
                return _sortAsc ? cmp : -cmp;
            }
            return _sortAsc ? va - vb : vb - va;
        });
    }

    /* ---- Table DOM builder ---- */

    function _buildTable(data, grouped) {
        const tbl = document.createElement('table');
        tbl.className = 'ammo-table';

        // Header
        const thead = document.createElement('thead');
        const hRow  = document.createElement('tr');

        const cols = _getColumns(grouped);
        cols.forEach(function (col) {
            const th = document.createElement('th');
            th.className = 'ammo-th';
            if (col.key) {
                th.dataset.col = col.key;
                th.classList.add('ammo-th-sortable');
                if (_sortCol === col.key) {
                    th.classList.add(_sortAsc ? 'ammo-sort-asc' : 'ammo-sort-desc');
                }
                th.addEventListener('click', function () { _onSortClick(col.key); });
            }
            if (col.class) th.classList.add(col.class);
            th.textContent = col.label;
            if (col.tip) th.title = col.tip;
            hRow.appendChild(th);
        });
        thead.appendChild(hRow);
        tbl.appendChild(thead);

        // Body
        const tbody = document.createElement('tbody');
        if (grouped) {
            data.forEach(function (group) {
                _appendGroupRows(tbody, group.caliber, group.rows, cols);
            });
        } else {
            data.forEach(function (row) {
                tbody.appendChild(_buildDataRow(row, cols));
            });
        }
        tbl.appendChild(tbody);
        return tbl;
    }

    function _appendGroupRows(tbody, caliber, rows, cols) {
        if (!rows || rows.length === 0) return;
        const anchor = _calName(caliber);
        // Anchor row (caliber header)
        const hr = document.createElement('tr');
        hr.className = 'ammo-caliber-row';
        hr.id = 'ammo-cal-' + _safeId(caliber);
        const td = document.createElement('td');
        td.colSpan = cols.length;
        td.className = 'ammo-caliber-label';
        td.textContent = anchor;
        hr.appendChild(td);
        tbody.appendChild(hr);

        rows.forEach(function (row) {
            tbody.appendChild(_buildDataRow(row, cols));
        });
    }

    function _buildDataRow(row, cols) {
        const tr = document.createElement('tr');
        tr.className = 'ammo-data-row';

        cols.forEach(function (col) {
            const td = document.createElement('td');
            td.className = 'ammo-td';
            if (col.class) td.classList.add(col.class);

            if (col.key === '_caliber') {
                td.textContent = _calName(row.caliber) || row.caliber || '';
            } else if (col.key === '_icon') {
                _renderAmmoIconCell(td, row);
            } else if (col.key === 'name') {
                _renderNameCell(td, row);
            } else if (col.key === 'damage') {
                _renderDamageCell(td, row);
            } else if (col.key === 'accuracy_modifier' || col.key === 'recoil_modifier') {
                _renderDeltaCell(td, row[col.key], col.key === 'recoil_modifier', col.key === 'recoil_modifier');
            } else if (col.key === 'light_bleed_delta' || col.key === 'heavy_bleed_delta') {
                _renderBleedCell(td, row[col.key]);
            } else if (col.key && col.key.startsWith('_class')) {
                const classIdx = parseInt(col.key.replace('_class', ''), 10) - 1;
                _renderEffCell(td, row, classIdx);
            } else if (col.key === 'fragmentation_chance' || col.key === 'ricochet_chance' ||
                       col.key === 'penetration_chance' || col.key === 'penetration_damage_mod' ||
                       col.key === 'malf_feed_chance' || col.key === 'misfire_chance') {
                td.textContent = row[col.key] ? Math.round(row[col.key] * 100) + '%' : '';
            } else if (col.key === 'velocity') {
                td.textContent = row.velocity ? Math.round(row.velocity) : '';
            } else if (col.key === 'heat_factor' || col.key === 'durability_burn_factor' ||
                       col.key === 'penetration_power_deviation') {
                td.textContent = row[col.key] ? _round2(row[col.key]) : '';
            } else if (col.key === 'trader_price_rub') {
                _renderPriceCell(td, row);
            } else {
                const v = (col.key && row[col.key]) ? row[col.key] : '';
                td.textContent = v;
            }

            tr.appendChild(td);
        });

        return tr;
    }

    function _renderDamageCell(td, row) {
        const dmg = row.damage;
        if (dmg == null) { td.textContent = ''; return; }
        const pellets = row.projectile_count || 1;
        if (pellets > 1) {
            // Shotgun / pellet ammo: damage column is per-pellet; show count x per-pellet
            td.textContent = pellets + '×' + dmg;
            td.title = (_t('ammo.col.dmgTotal') || 'Total') + ': ' + (pellets * dmg);
            td.classList.add('ammo-dmg-multi');
        } else {
            td.textContent = dmg;
        }
    }

    function _renderAmmoIconCell(td, row) {
        td.innerHTML = '';
        if (!row.icon_link) return;
        const wrapper = document.createElement('div');
        wrapper.className = 'ammo-icon-wrapper';
        const img = document.createElement('img');
        img.className = 'ammo-icon-img';
        img.src = row.icon_link;
        img.alt = '';
        img.loading = 'lazy';
        wrapper.appendChild(img);
        if (row.short_name) {
            const sn = document.createElement('div');
            sn.className = 'slot-shortname';
            sn.textContent = row.short_name;
            wrapper.appendChild(sn);
        }
        td.appendChild(wrapper);
    }

    function _renderNameCell(td, row) {
        td.innerHTML = '';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = row.name || '';
        td.appendChild(nameSpan);

        // tarkov.dev ammoType is never "subsonic"; detect by muzzle velocity below ~343 m/s
        const isSubsonic = (row.velocity != null && row.velocity < 343) ||
                         (row.ammo_type && row.ammo_type.toLowerCase().includes('subsonic'));
        if (isSubsonic) {
            const sSup = document.createElement('sup');
            sSup.className = 'ammo-sup ammo-sup-sub';
            sSup.textContent = 'S';
            sSup.title = _t('ammo.sup.subsonic');
            td.appendChild(sSup);
        }
        if (row.tracer) {
            const tc = _sanitizeColor(row.tracer_color);
            const tSup = document.createElement('sup');
            tSup.className = 'ammo-sup ammo-sup-tracer';
            tSup.textContent = 'T';
            if (tc) tSup.style.color = tc;
            tSup.title = _t(tc ? 'ammo.sup.tracer.' + tc : 'ammo.sup.tracer');
            td.appendChild(tSup);
        }
    }

    function _renderDeltaCell(td, val, invert, noPct) {
        if (val == null) { td.textContent = ''; return; }
        // tarkov.dev stores accuracy/recoil modifiers as fractions (-0.05 = -5%)
        const pct = Math.round(val * 100);
        if (pct === 0) { td.textContent = ''; return; }
        td.textContent = (pct > 0 ? '+' : '') + pct + (noPct ? '' : '%');
        // For recoil, higher is worse, so invert: positive = red, negative = green.
        const good = invert ? (pct < 0) : (pct > 0);
        td.classList.add(good ? 'delta-pos' : 'delta-neg');
    }

    function _renderBleedCell(td, val) {
        if (val == null || val === 0) { td.textContent = ''; return; }
        // tarkov.dev stores bleed modifiers as fractions (0.35 = +35%)
        const pct = Math.round(val * 100);
        if (pct === 0) { td.textContent = ''; return; }
        td.textContent = (pct > 0 ? '+' : '') + pct + '%';
    }

    function _renderEffCell(td, row, classIdx) {
        const tier = _calcEff(row.penetration_power, classIdx);
        if (tier === null) { td.textContent = ''; return; }
        td.textContent = _t('ammo.eff.' + tier);
        td.classList.add('ammo-eff');
        td.classList.add('eff-' + tier);
    }

    function _renderPriceCell(td, row) {
        if (!row.trader_price_rub) { td.textContent = ''; return; }
        td.textContent = row.trader_price_rub.toLocaleString() + ' ₽';
    }

    /* ---- Column definitions ---- */

    function _getColumns(grouped) {
        const t = _t.bind(null);
        const cols = [];

        if (!grouped) {
            cols.push({ key: '_caliber', label: t('ammo.col.caliber'), class: 'ammo-col-caliber' });
        }
        cols.push({ key: '_icon', label: '', class: 'ammo-col-icon' });
        cols.push({ key: 'name',                label: t('ammo.col.name'),       class: 'ammo-col-name' });
        cols.push({ key: 'damage',              label: t('ammo.col.dmg'),         class: 'ammo-col-num', tip: t('ammo.col.dmgTip') });
        cols.push({ key: 'penetration_power',   label: t('ammo.col.pen'),         class: 'ammo-col-num', tip: t('ammo.col.penTip') });
        cols.push({ key: 'penetration_chance',  label: t('ammo.col.penChance'),   class: 'ammo-col-num', tip: t('ammo.col.penChanceTip') });
        cols.push({ key: 'penetration_power_deviation', label: t('ammo.col.penDev'), class: 'ammo-col-num', tip: t('ammo.col.penDevTip') });
        cols.push({ key: 'armor_damage',        label: t('ammo.col.armorDmg'),    class: 'ammo-col-num', tip: t('ammo.col.armorDmgTip') });
        cols.push({ key: 'penetration_damage_mod', label: t('ammo.col.postPen'),  class: 'ammo-col-num', tip: t('ammo.col.postPenTip') });
        cols.push({ key: 'fragmentation_chance', label: t('ammo.col.frag'),       class: 'ammo-col-num', tip: t('ammo.col.fragTip') });
        cols.push({ key: 'ricochet_chance',      label: t('ammo.col.rico'),       class: 'ammo-col-num', tip: t('ammo.col.ricoTip') });
        cols.push({ key: 'accuracy_modifier',   label: t('ammo.col.acc'),         class: 'ammo-col-delta', tip: t('ammo.col.accTip') });
        cols.push({ key: 'recoil_modifier',     label: t('ammo.col.recoil'),      class: 'ammo-col-delta', tip: t('ammo.col.recoilTip') });
        cols.push({ key: 'malf_feed_chance',    label: t('ammo.col.feedMalf'),    class: 'ammo-col-num', tip: t('ammo.col.feedMalfTip') });
        cols.push({ key: 'misfire_chance',      label: t('ammo.col.misfire'),     class: 'ammo-col-num', tip: t('ammo.col.misfireTip') });
        cols.push({ key: 'light_bleed_delta',   label: t('ammo.col.ltBleed'),     class: 'ammo-col-delta', tip: t('ammo.col.ltBleedTip') });
        cols.push({ key: 'heavy_bleed_delta',   label: t('ammo.col.hvBleed'),     class: 'ammo-col-delta', tip: t('ammo.col.hvBleedTip') });
        cols.push({ key: 'velocity',            label: t('ammo.col.velocity'),    class: 'ammo-col-num', tip: t('ammo.col.velocityTip') });
        cols.push({ key: 'heat_factor',         label: t('ammo.col.heat'),        class: 'ammo-col-num', tip: t('ammo.col.heatTip') });
        cols.push({ key: 'durability_burn_factor', label: t('ammo.col.duraBurn'), class: 'ammo-col-num', tip: t('ammo.col.duraBurnTip') });
        cols.push({ key: '_class1', label: '1', class: 'ammo-col-class', tip: t('ammo.col.class1Tip') });
        cols.push({ key: '_class2', label: '2', class: 'ammo-col-class', tip: t('ammo.col.class2Tip') });
        cols.push({ key: '_class3', label: '3', class: 'ammo-col-class', tip: t('ammo.col.class3Tip') });
        cols.push({ key: '_class4', label: '4', class: 'ammo-col-class', tip: t('ammo.col.class4Tip') });
        cols.push({ key: '_class5', label: '5', class: 'ammo-col-class', tip: t('ammo.col.class5Tip') });
        cols.push({ key: '_class6', label: '6', class: 'ammo-col-class', tip: t('ammo.col.class6Tip') });
        return cols;
    }

    /* ===========================
       PRIVATE - DISCLAIMER
    =========================== */

    function _buildDisclaimer() {
        const el = document.getElementById('ammo-disclaimer');
        if (!el) return;
        el.innerHTML = '';
        el.appendChild(document.createTextNode(_t('ammo.disclaimer.pre')));
        const a = document.createElement('a');
        a.href = 'https://escapefromtarkov.fandom.com/wiki/Ballistics';
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = _t('ammo.disclaimer.link');
        a.className = 'ammo-disclaimer-link';
        el.appendChild(a);
        el.appendChild(document.createTextNode(_t('ammo.disclaimer.post')));
    }

    /* ===========================
       PRIVATE - CALIBER NAV
    =========================== */

    function _buildCaliberNav() {
        const navEl = document.getElementById('ammo-caliber-nav');
        if (!navEl) return;
        navEl.innerHTML = '';
        const chipsWrap = document.createElement('div');
        chipsWrap.className = 'ammo-cal-chips-wrap';
        navEl.appendChild(chipsWrap);
        _renderCaliberChips(chipsWrap);
    }

    // 0 = rifle/LMG/DMR, 1 = pistol/SMG/revolver, 2 = shotgun, 3 = grenade/special
    const _CALIBER_TYPE_LABELS = ['ammo.calType.rifle', 'ammo.calType.pistol', 'ammo.calType.shotgun', 'ammo.calType.special'];

    const _CALIBER_TYPE = {
        'Caliber545x39': 0, 'Caliber556x45NATO': 0, 'Caliber58x42': 0, 'Caliber68x51': 0,
        'Caliber762x39': 0, 'Caliber762x51': 0, 'Caliber762x54R': 0,
        'Caliber762x35': 0, 'Caliber784x49': 0, 'Caliber86x70': 0,
        'Caliber366TKM': 0, 'Caliber93x64': 0, 'Caliber9x39': 0,
        'Caliber127x55': 0, 'Caliber127x99': 0,
        'Caliber762x25TT': 1,
        'Caliber9x18PM': 1, 'Caliber9x18PMM': 1, 'Caliber9x19PARA': 1,
        'Caliber9x21': 1, 'Caliber57x28': 1, 'Caliber46x30': 1,
        'Caliber9x33R': 1, 'Caliber1143x23ACP': 1, 'Caliber127x33': 1,
        'Caliber12g': 2, 'Caliber20g': 2, 'Caliber23x75': 2,
        'Caliber20x1mm': 3,
        'Caliber40x46': 3, 'Caliber40mmRU': 3, 'Caliber26x75': 3,
    };

    function _renderCaliberChips(container) {
        if (!container) return;
        container.innerHTML = '';
        // Use actual cache keys once data is loaded so chips match real table sections
        const cals = _cache ? Object.keys(_cache) : [];
        cals.sort(function (a, b) {
            const ta = _CALIBER_TYPE[a] != null ? _CALIBER_TYPE[a] : 99;
            const tb = _CALIBER_TYPE[b] != null ? _CALIBER_TYPE[b] : 99;
            if (ta !== tb) return ta - tb;
            return _calName(a).localeCompare(_calName(b));
        });
        const grid = document.createElement('div');
        grid.className = 'ammo-cal-grid';
        let lastType = -1;
        cals.forEach(function (cal) {
            const typeIdx = _CALIBER_TYPE[cal] != null ? _CALIBER_TYPE[cal] : 99;
            if (typeIdx !== lastType) {
                lastType = typeIdx;
                const lbl = document.createElement('div');
                lbl.className = 'ammo-cal-type-label';
                lbl.textContent = _t(_CALIBER_TYPE_LABELS[typeIdx] || ('ammo.calType.' + typeIdx));
                grid.appendChild(lbl);
            }
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ammo-cal-chip';
            chip.textContent = _calName(cal);
            chip.addEventListener('click', function () {
                const target = document.getElementById('ammo-cal-' + _safeId(cal));
                if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            grid.appendChild(chip);
        });
        container.appendChild(grid);
    }

    function _updateCaliberNavHighlight() { /* no-op: category tabs removed */ }

    /* ===========================
       PRIVATE - DENOTATION NOTES
    =========================== */

    function _buildDenotationNotes() {
        const el = document.getElementById('ammo-notes');
        if (!el) return;
        el.innerHTML =
            '<sup class="ammo-sup ammo-sup-sub">S</sup> ' + _t('ammo.note.subsonic') +
            ' ' +
            '<sup class="ammo-sup ammo-sup-tracer">T</sup> ' + _t('ammo.note.tracer');
    }

    /* ===========================
       PRIVATE - SORTING
    =========================== */

    function _onSortClick(colKey) {
        if (_sortCol === colKey) {
            _sortAsc = !_sortAsc;
        } else {
            _sortCol = colKey;
            _sortAsc = true;
        }
        if (_cache) _render();
    }

    /* ===========================
       PRIVATE - HELPERS
    =========================== */

    function _t(key) {
        if (window.EFTForge && EFTForge.lang && EFTForge.lang.t) {
            return EFTForge.lang.t(key);
        }
        return key;
    }

    function _safeId(str) {
        return (str || '').replace(/[^a-zA-Z0-9]/g, '_');
    }

    function _round2(n) {
        return Math.round(n * 100) / 100;
    }

    function _sanitizeColor(color) {
        // Returns a valid CSS color for the tracer mark, or null to fall back to
        // the default CSS color. Whitelisted to prevent XSS.
        if (!color) return null;
        if (/^#[0-9a-fA-F]{3,6}$/.test(color)) return color;
        // tarkov.dev names tracers like "tracerRed"/"tracerGreen"; strip prefix.
        const lower = color.toLowerCase().replace(/^tracer/, '');
        // EFT only has red, green and yellow tracers - there are no white tracers.
        const valid = ['red', 'green', 'yellow'];
        return valid.indexOf(lower) !== -1 ? lower : null;
    }

    function _updateStaticText() {
        const titleEl = document.getElementById('ammo-panel-title');
        if (titleEl) titleEl.textContent = _t('ammo.title');
        const searchEl = document.getElementById('ammo-search');
        if (searchEl) searchEl.placeholder = _t('ammo.searchPlaceholder');
        const navTitle = document.getElementById('ammo-nav-title');
        if (navTitle) navTitle.textContent = _t('ammo.nav.title');
        _buildDenotationNotes();
        _buildDisclaimer();
        _buildCaliberNav();
    }

    /* ===========================
       EXPOSE
    =========================== */

    // Scripts are loaded at the end of <body> so DOM is ready; init immediately.
    init();

    return { showPanel: showPanel, hidePanel: hidePanel, onLangChange: onLangChange };

}());
