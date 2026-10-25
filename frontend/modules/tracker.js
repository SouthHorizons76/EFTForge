window.EFTForge = window.EFTForge || {};

/* ============================================================
   STAT TRACKER MODULE
   Displays stat changes in a 4-column layout: NEW / BUFFS / NERFS / MIXED.
   NEW covers weapons, attachments, and ammo the db picked up that weren't
   present in the previous sync (see backend _build_new_item_logs).
   Supports search and weapon/attachment category filtering.
   Opens on the last 7 days (the badge counts those); the period picker
   pages back through every past sync day, since the history is never pruned.
   Each column renders incrementally via IntersectionObserver so
   large changelogs never block the main thread.
============================================================ */

window.EFTForge.tracker = (function () {

    let _cache       = null;  // recent window rows, also feeds the badge
    let _dates       = null;  // [{ date, item_count }] every day with changes, newest first
    let _dayCache    = {};    // 'YYYY-MM-DD' -> rows for that one day
    let _period      = 'recent'; // 'recent' | 'YYYY-MM-DD'
    let _searchQuery = '';
    let _typeFilter  = 'all'; // 'all' | 'weapons' | 'attachments'
    let _searchTimer = null;
    const _WINDOW_DAYS = 7;
    const _PAGE_SIZE   = 40;   // items rendered per IntersectionObserver trigger

    // Matches backend sync_tarkov_dev._NEW_ITEM_STAT - flags a row as "brand new
    // item" rather than a stat diff.
    const _NEW_ITEM_STAT = 'new_item';

    // Per-column incremental render state
    const _colObservers = {};  // type -> IntersectionObserver
    const _colState     = {};  // type -> { flat: [], cursor: 0, lang: '' }

    const _LOWER_IS_BETTER = {
        weight:                  true,
        recoil_modifier:         true,
        recoil_vertical:         true,
        recoil_horizontal:       true,
        center_of_impact:        true,
        heat_factor:             true,
        durability_burn_factor:  true,
        // cooling_factor is intentionally absent - higher is better there, same as the default.
    };

    /* ===========================
       PUBLIC API
    =========================== */

    function showPanel() {
        const overlay  = document.getElementById('tracker-overlay');
        const backdrop = document.getElementById('tracker-backdrop');
        if (!overlay) return;

        overlay.classList.add('visible');
        if (backdrop) backdrop.classList.add('visible');
        document.getElementById('main-container')?.setAttribute('inert', '');
        if (document.activeElement) /** @type {HTMLElement} */ (document.activeElement).blur();

        _updateTitle();
        _updateControlLabels();
        _updateLastSynced();
        // a language switch while we were closed skips the picker, so relabel it here
        _refreshPeriodSelect();
        _loadDates();
        _loadData();
    }

    function hidePanel() {
        const overlay  = document.getElementById('tracker-overlay');
        const backdrop = document.getElementById('tracker-backdrop');
        if (overlay)  overlay.classList.remove('visible');
        if (backdrop) backdrop.classList.remove('visible');
        document.getElementById('main-container')?.removeAttribute('inert');
    }

    function onLangChange() {
        const overlay = document.getElementById('tracker-overlay');
        if (!overlay || !overlay.classList.contains('visible')) return;
        _updateTitle();
        _updateControlLabels();
        _updateLastSynced();
        _refreshPeriodSelect();
        _rerender();
    }

    /* ===========================
       PRIVATE - DATA
    =========================== */

    function _cutoff7d() {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - _WINDOW_DAYS);
        d.setUTCHours(0, 0, 0, 0);
        return d;
    }

    function _filter7d(data) {
        const cutoff = _cutoff7d();
        return (data || []).filter(function (e) {
            if (!e.detected_at) return false;
            return new Date(e.detected_at) >= cutoff;
        });
    }

    function _updateBadge(data) {
        const btn = document.getElementById('tracker-btn');
        if (!btn) return;
        const count = _combineByItem(_filter7d(data)).length;
        btn.dataset.badge = count > 0 ? (count > 999 ? '999+' : String(count)) : '';
    }

    // Rows for the selected period, or null while they haven't loaded yet.
    function _viewData() {
        if (_period === 'recent') return _cache ? _filter7d(_cache) : null;
        return _dayCache[_period] || null;
    }

    function _rerender() {
        const data = _viewData();
        if (data) _renderEntries(data);
    }

    async function _loadData() {
        const data = _viewData();
        if (data) {
            _renderEntries(data);
            return;
        }

        const period = _period;
        _showLoading();

        try {
            if (period === 'recent') {
                const rows = await EFTForge.api.fetchStatChangelog();
                _cache = rows;
                _updateBadge(rows);
            } else {
                _dayCache[period] = await EFTForge.api.fetchStatChangelog(period);
            }
        } catch (err) {
            console.error('[tracker] Load error:', err);
            if (period === _period) _showError();
            return;
        }
        // The user may have picked another period while this one was in flight.
        if (period === _period) _rerender();
    }

    async function _loadDates() {
        if (_dates) return;
        try {
            _dates = await EFTForge.api.fetchStatChangelogDates();
        } catch (_) {
            // fail silently - the picker just keeps only the recent window
            return;
        }
        _refreshPeriodSelect();
    }

    function _setPeriod(period) {
        if (period === _period) return;
        _period = period;
        _loadData();
    }

    function _refreshPeriodSelect() {
        const sel = /** @type {HTMLSelectElement | null} */ (document.getElementById('tracker-period-select'));
        if (!sel) return;
        const t = EFTForge.lang.t;
        const options = [{ value: 'recent', label: t('tracker.period.recent') }];
        (_dates || []).forEach(function (d) {
            options.push({
                value: d.date,
                label: EFTForge.lang.tFmt('tracker.period.day', { date: _formatDate(d.date), count: d.item_count }),
            });
        });
        // Fall back to the recent window if the picked day is no longer listed.
        const stale = !options.some(function (o) { return o.value === _period; });
        if (stale) _period = 'recent';

        document.getElementById('tracker-period-select-custom')?.remove();
        while (sel.options.length) sel.remove(0);
        options.forEach(function (opt) {
            const o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.label;
            if (opt.value === _period) o.selected = true;
            sel.appendChild(o);
        });
        setupCustomSelect('tracker-period-select');
        if (stale) _loadData();
    }

    async function _updateLastSynced() {
        const el = document.getElementById('tracker-last-synced');
        if (!el) return;
        try {
            const status = await EFTForge.api.fetchSyncStatus();
            if (status && status.last_synced_at) {
                el.textContent = EFTForge.lang.tFmt('tracker.lastSynced', { date: _formatSyncTime(status.last_synced_at) });
                return;
            }
        } catch (_) {
            // fail silently - not critical info
        }
        el.textContent = '';
    }

    async function _prefetch() {
        try {
            const data = await EFTForge.api.fetchStatChangelog();
            _cache = data;
            _updateBadge(data);
        } catch (_) {
            // fail silently - badge stays empty, panel will retry on open
        }
    }

    /* ===========================
       PRIVATE - CLASSIFICATION & FILTERING
    =========================== */

    function _classify(combinedEntry) {
        if (combinedEntry.stats.length === 1 && combinedEntry.stats[0].stat_name === _NEW_ITEM_STAT) {
            return 'new';
        }
        let hasBuff = false, hasNerf = false;
        for (let i = 0; i < combinedEntry.stats.length; i++) {
            const s = combinedEntry.stats[i];
            if (s.old_value == null || s.new_value == null) continue;
            const lowerBetter = !!_LOWER_IS_BETTER[s.stat_name];
            const improved = lowerBetter ? (s.new_value < s.old_value) : (s.new_value > s.old_value);
            if (improved) hasBuff = true;
            else hasNerf = true;
        }
        if (hasBuff && hasNerf) return 'mixed';
        if (hasBuff) return 'buff';
        return 'nerf';
    }

    function _applyFilters(items) {
        const q = _searchQuery.toLowerCase().trim();
        return items.filter(function (item) {
            if (_typeFilter === 'weapons'     && !item.is_weapon) return false;
            if (_typeFilter === 'attachments' && (item.is_weapon || item.is_ammo)) return false;
            if (_typeFilter === 'ammo'        && !item.is_ammo)  return false;
            if (q) {
                const name   = (item.item_name    || '').toLowerCase();
                const nameZh = (item.item_name_zh || '').toLowerCase();
                if (!name.includes(q) && !nameZh.includes(q)) return false;
            }
            return true;
        });
    }

    /* ===========================
       PRIVATE - RENDERING
    =========================== */

    function _updateTitle() {
        const el = document.getElementById('tracker-header-title');
        if (el) el.textContent = EFTForge.lang.t('tracker.title');
    }

    function _updateControlLabels() {
        const t = EFTForge.lang.t;
        const s = /** @type {HTMLInputElement | null} */ (document.getElementById('tracker-search'));
        if (s) s.placeholder = t('tracker.search.placeholder') || 'Search items...';

        const labelMap = {
            'tracker-filter-all':        'tracker.filter.all',
            'tracker-filter-weapons':    'tracker.filter.weapons',
            'tracker-filter-attachments':'tracker.filter.attachments',
            'tracker-filter-ammo':       'tracker.filter.ammo',
            'tracker-col-label-new':     'tracker.col.new',
            'tracker-col-label-buff':    'tracker.col.buffs',
            'tracker-col-label-nerf':    'tracker.col.nerfs',
            'tracker-col-label-mixed':   'tracker.col.mixed',
        };
        Object.keys(labelMap).forEach(function (id) {
            const el = document.getElementById(id);
            if (el) el.textContent = t(labelMap[id]) || el.textContent;
        });

        const noteText = document.getElementById('tracker-note-text');
        if (noteText) noteText.textContent = t('tracker.note');
        const noteAtlas = document.getElementById('tracker-note-atlas');
        if (noteAtlas) noteAtlas.textContent = t('tracker.noteAtlas');
    }

    function _showLoading() {
        const hint = document.getElementById('tracker-no-change-hint');
        const columns = document.getElementById('tracker-columns');
        if (hint)    hint.style.display = 'none';
        if (columns) columns.style.display = '';
        const msg = EFTForge.lang.t('tracker.loading');
        ['new', 'buff', 'nerf', 'mixed'].forEach(function (col) {
            _destroyColumnObserver(col);
            const el = document.getElementById('tracker-body-' + col);
            if (el) el.innerHTML = '<div class="tracker-empty">' + _esc(msg) + '</div>';
            const cnt = document.getElementById('tracker-count-' + col);
            if (cnt) cnt.textContent = '';
        });
    }

    function _showError() {
        const msg = EFTForge.lang.t('tracker.loadError');
        ['new', 'buff', 'nerf', 'mixed'].forEach(function (col) {
            _destroyColumnObserver(col);
            const el = document.getElementById('tracker-body-' + col);
            if (el) el.innerHTML = '<div class="tracker-empty">' + _esc(msg) + '</div>';
        });
    }

    function _combineByItem(data) {
        const combined = [];
        const keyIndex = {};

        (data || []).forEach(function (entry) {
            const dateKey = entry.detected_at ? entry.detected_at.slice(0, 10) : 'unknown';
            const key = dateKey + '\x00' + entry.item_id;
            if (!keyIndex.hasOwnProperty(key)) {
                keyIndex[key] = combined.length;
                combined.push({
                    item_id:      entry.item_id,
                    item_name:    entry.item_name,
                    item_name_zh: entry.item_name_zh,
                    icon_link:    entry.icon_link,
                    is_weapon:    entry.is_weapon,
                    is_ammo:      entry.is_ammo,
                    detected_at:  entry.detected_at,
                    stats: [],
                });
            }
            combined[keyIndex[key]].stats.push({
                stat_name: entry.stat_name,
                old_value: entry.old_value,
                new_value: entry.new_value,
            });
        });

        return combined;
    }

    function _renderEntries(data) {
        const lang  = EFTForge.state && EFTForge.state.lang;
        const items = _combineByItem(data);

        const hint    = document.getElementById('tracker-no-change-hint');
        const columns = document.getElementById('tracker-columns');
        if (items.length === 0) {
            if (hint) {
                hint.textContent = EFTForge.lang.t(_period === 'recent' ? 'tracker.empty' : 'tracker.emptyDay');
                hint.style.display = '';
            }
            if (columns) columns.style.display = 'none';
            ['new', 'buff', 'nerf', 'mixed'].forEach(function (col) { _destroyColumnObserver(col); });
            return;
        }
        if (hint)    hint.style.display = 'none';
        if (columns) columns.style.display = '';

        const filtered = _applyFilters(items);

        const news  = filtered.filter(function (i) { return _classify(i) === 'new';   });
        const buffs = filtered.filter(function (i) { return _classify(i) === 'buff';  });
        const nerfs = filtered.filter(function (i) { return _classify(i) === 'nerf';  });
        const mixed = filtered.filter(function (i) { return _classify(i) === 'mixed'; });

        _renderColumn('new',   news,   lang);
        _renderColumn('buff',  buffs,  lang);
        _renderColumn('nerf',  nerfs,  lang);
        _renderColumn('mixed', mixed,  lang);

        const setCount = function (id, val) {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };
        setCount('tracker-count-new',   news.length);
        setCount('tracker-count-buff',  buffs.length);
        setCount('tracker-count-nerf',  nerfs.length);
        setCount('tracker-count-mixed', mixed.length);
    }

    /* ===========================
       PRIVATE - INCREMENTAL COLUMN RENDERING
    =========================== */

    function _destroyColumnObserver(type) {
        if (_colObservers[type]) {
            _colObservers[type].disconnect();
            _colObservers[type] = null;
        }
    }

    // Build a flat list of {kind:'date',label} | {kind:'item',entry,globalIdx}
    // preserving the date-group order but allowing O(1) cursor advancement.
    function _buildFlat(items) {
        const groups   = [];
        const groupMap = {};
        items.forEach(function (item) {
            const dateKey = item.detected_at ? item.detected_at.slice(0, 10) : 'unknown';
            if (!groupMap[dateKey]) { groupMap[dateKey] = []; groups.push(dateKey); }
            groupMap[dateKey].push(item);
        });
        const flat = [];
        let globalIdx = 0;
        groups.forEach(function (dateKey) {
            flat.push({ kind: 'date', label: _formatDate(dateKey) });
            groupMap[dateKey].forEach(function (entry) {
                flat.push({ kind: 'item', entry: entry, globalIdx: globalIdx });
                globalIdx++;
            });
        });
        return flat;
    }

    function _entryHtml(entry, globalIdx, lang) {
        const name = (lang === 'zh' && entry.item_name_zh)
            ? entry.item_name_zh
            : (entry.item_name || entry.item_id);
        const animIdx  = Math.min(globalIdx, 25);
        const iconHtml = entry.icon_link
            ? '<img class="tracker-item-icon" src="' + _esc(entry.icon_link) + '" alt="" loading="lazy">'
            : '<div class="tracker-item-icon tracker-item-icon-placeholder"></div>';

        const t = EFTForge.lang.t;
        const isNew = entry.stats.length === 1 && entry.stats[0].stat_name === _NEW_ITEM_STAT;
        const newBadgeHtml = isNew ? '<span class="tracker-new-badge">+</span>' : '';
        let statsHtml = '';
        if (!isNew) {
            entry.stats.forEach(function (s) {
                const statLabel   = t('tracker.statLabel.' + s.stat_name) || s.stat_name;
                const lowerBetter = !!_LOWER_IS_BETTER[s.stat_name];
                const improved    = (s.old_value != null && s.new_value != null)
                                  ? (lowerBetter ? s.new_value < s.old_value : s.new_value > s.old_value)
                                  : false;
                const changeClass = improved ? 'tracker-stat-up' : 'tracker-stat-down';
                const oldStr      = _fmtValForStat(s.stat_name, s.old_value);
                const newStr      = _fmtValForStat(s.stat_name, s.new_value);
                const pctStr      = _fmtPct(s.old_value, s.new_value);
                statsHtml += (
                    '<div class="tracker-stat-row">' +
                    '<span class="tracker-stat-label">' + _esc(statLabel) + '</span>' +
                    '<span class="tracker-stat-change ' + changeClass + '">' +
                    _esc(oldStr) + ' → ' + _esc(newStr) +
                    '<span class="tracker-stat-pct">(' + _esc(pctStr) + ')</span>' +
                    '</span>' +
                    '</div>'
                );
            });
        }

        return (
            '<div class="tracker-entry" style="--tr-i:' + animIdx + '">' +
            iconHtml +
            '<div class="tracker-entry-info">' +
            '<div class="tracker-item-name">' +
            '<span class="tracker-item-name-wrap"><span class="marquee-text">' + _esc(name) + '</span></span>' +
            newBadgeHtml +
            '</div>' +
            statsHtml +
            '</div>' +
            '</div>'
        );
    }

    function _appendItems(type) {
        const body = document.getElementById('tracker-body-' + type);
        if (!body) return;
        const state = _colState[type];
        if (!state) return;

        // Remove existing sentinel before appending more content
        const sentinel = body.querySelector('.tracker-sentinel');
        if (sentinel) sentinel.remove();

        const flat   = state.flat;
        const cursor = state.cursor;
        const end    = Math.min(cursor + _PAGE_SIZE, flat.length);

        if (cursor >= flat.length) return;

        let html = '';
        for (let i = cursor; i < end; i++) {
            const f = flat[i];
            if (f.kind === 'date') {
                html += '<div class="tracker-date-label">' + _esc(f.label) + '</div>';
            } else {
                html += _entryHtml(f.entry, f.globalIdx, state.lang);
            }
        }

        if (html) {
            // insertAdjacentHTML is faster than innerHTML for appending
            body.insertAdjacentHTML('beforeend', html);
        }

        // Re-scan the whole body for marquee targets - cheap at this page size, and
        // simpler than diffing which nodes are new. Tear down the previous scope first
        // so hovering doesn't double-attach listeners to already-rendered entries.
        if (state.marqueeDispose) state.marqueeDispose();
        state.marqueeDispose = EFTForge.utils._initMarqueeText(body, { hoverOnly: true, hoverTarget: '.tracker-entry' });

        state.cursor = end;

        if (end < flat.length) {
            const s = document.createElement('div');
            s.className = 'tracker-sentinel';
            body.appendChild(s);

            _destroyColumnObserver(type);
            // Use the column body as root so intersection is relative to
            // the column's own scroll viewport, not the window.
            const observer = new IntersectionObserver(function (entries) {
                if (entries[0].isIntersecting) {
                    _destroyColumnObserver(type);
                    _appendItems(type);
                }
            }, { root: body, rootMargin: '120px' });
            observer.observe(s);
            _colObservers[type] = observer;
        }
    }

    function _renderColumn(type, items, lang) {
        const body = document.getElementById('tracker-body-' + type);
        if (!body) return;

        _destroyColumnObserver(type);
        if (_colState[type]?.marqueeDispose) _colState[type].marqueeDispose();

        if (!items.length) {
            body.innerHTML = '<div class="tracker-empty">-</div>';
            return;
        }

        body.innerHTML = '';
        _colState[type] = { flat: _buildFlat(items), cursor: 0, lang: lang };
        _appendItems(type);
    }

    /* ===========================
       PRIVATE - HELPERS
    =========================== */

    function _formatDate(dateStr) {
        if (!dateStr || dateStr === 'unknown') return dateStr;
        try {
            const parts  = dateStr.split('-').map(Number);
            const d      = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
            const locale = EFTForge.state.lang === 'zh' ? 'zh-CN' : 'en-US';
            return d.toLocaleDateString(locale, {
                year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
            });
        } catch (_) {
            return dateStr;
        }
    }

    function _formatSyncTime(isoStr) {
        try {
            const d      = new Date(isoStr);
            const locale = EFTForge.state.lang === 'zh' ? 'zh-CN' : 'en-US';
            return d.toLocaleString(locale, {
                year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });
        } catch (_) {
            return isoStr;
        }
    }

    function _fmtVal(v) {
        if (v == null) return '?';
        return parseFloat(v.toFixed(2)).toString();
    }

    function _fmtValForStat(statName, v) {
        if (v == null) return '?';
        if (statName === 'center_of_impact') {
            return parseFloat((v * 34.36).toFixed(2)) + ' MOA';
        }
        if (statName === 'recoil_modifier') {
            // Stored as a fraction (e.g. -0.05) - scale to percent for display.
            const pv   = v * 100;
            const sign = pv >= 0 ? '+' : '';
            return sign + parseFloat(pv.toFixed(1)) + '%';
        }
        if (statName === 'accuracy_modifier') {
            // Unlike recoil_modifier, already stored in whole-percent scale
            // (see sync_tarkov_dev.py's `round(acc * 100, 4)`) - no further scaling needed.
            const aSign = v >= 0 ? '+' : '';
            return aSign + parseFloat(v.toFixed(1)) + '%';
        }
        if (statName === 'heat_factor' || statName === 'cooling_factor' || statName === 'durability_burn_factor') {
            const fv    = (v - 1) * 100;
            const fSign = fv >= 0 ? '+' : '';
            return fSign + parseFloat(fv.toFixed(1)) + '%';
        }
        if (statName === 'velocity_modifier') {
            const vSign = v >= 0 ? '+' : '';
            return vSign + parseFloat(v.toFixed(1)) + '%';
        }
        if (statName === 'loudness') {
            return (v > 0 ? '+' : '') + v;
        }
        return _fmtVal(v);
    }

    function _fmtPct(oldVal, newVal) {
        if (oldVal == null || newVal == null) return 'N/A';
        if (oldVal === 0) return newVal > 0 ? '+∞' : newVal < 0 ? '-∞' : '0%';
        const pct  = ((newVal - oldVal) / Math.abs(oldVal)) * 100;
        const sign = pct >= 0 ? '+' : '';
        return sign + parseFloat(pct.toFixed(1)) + '%';
    }

    function _esc(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /* ===========================
       SELF-INIT
    =========================== */

    function _init() {
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            const overlay = document.getElementById('tracker-overlay');
            if (!overlay || !overlay.classList.contains('visible')) return;
            e.stopPropagation();
            hidePanel();
        }, true);

        const searchInput = document.getElementById('tracker-search');
        if (searchInput) {
            searchInput.addEventListener('input', function (e) {
                _searchQuery = /** @type {HTMLInputElement} */ (e.target).value || '';
                clearTimeout(_searchTimer);
                _searchTimer = setTimeout(_rerender, 200);
            });
        }

        const filterWrap = document.getElementById('tracker-type-filter');
        if (filterWrap) {
            filterWrap.addEventListener('click', function (e) {
                const btn = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('.tracker-filter-btn'));
                if (!btn) return;
                _typeFilter = btn.dataset.filter || 'all';
                filterWrap.querySelectorAll('.tracker-filter-btn').forEach(function (b) {
                    b.classList.toggle('active', b === btn);
                });
                _rerender();
            });
        }

        const periodSel = document.getElementById('tracker-period-select');
        if (periodSel) {
            periodSel.addEventListener('change', function (e) { _setPeriod(/** @type {HTMLSelectElement} */ (e.target).value); });
            _refreshPeriodSelect();
        }

        // Go the way the header's Atlas button goes: the live site in the browser on
        // desktop, /atlas on the web. A middle click still opens the link in a new tab.
        const noteAtlas = document.getElementById('tracker-note-atlas');
        if (noteAtlas) {
            noteAtlas.addEventListener('click', function (e) {
                const atlasBtn = document.getElementById('atlas-btn');
                if (!atlasBtn) return;
                e.preventDefault();
                atlasBtn.click();
            });
        }

        _prefetch();
    }

    function reload() {
        _cache = null;
        _dates = null;
        _dayCache = {};
        const overlay = document.getElementById('tracker-overlay');
        if (overlay && overlay.classList.contains('visible')) {
            _loadDates();
            _loadData();
        } else {
            _prefetch();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _init);
    } else {
        _init();
    }

    return { showPanel, hidePanel, onLangChange, reload };

})();
