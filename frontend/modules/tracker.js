window.EFTForge = window.EFTForge || {};

/* ============================================================
   STAT TRACKER MODULE
   Displays stat changes in a 3-column layout: BUFFS / NERFS / MIXED.
   Supports search and weapon/attachment category filtering.
   Data window: last 7 days. Badge shows total combined items.
============================================================ */

window.EFTForge.tracker = (function () {

    var _cache       = null;
    var _searchQuery = '';
    var _typeFilter  = 'all'; // 'all' | 'weapons' | 'attachments'
    var _searchTimer = null;
    var _WINDOW_DAYS = 7;

    var _LOWER_IS_BETTER = {
        weight:            true,
        recoil_modifier:   true,
        recoil_vertical:   true,
        recoil_horizontal: true,
        center_of_impact:  true,
    };

    /* ===========================
       PUBLIC API
    =========================== */

    function showPanel() {
        var overlay  = document.getElementById('tracker-overlay');
        var backdrop = document.getElementById('tracker-backdrop');
        if (!overlay) return;

        overlay.classList.add('visible');
        if (backdrop) backdrop.classList.add('visible');
        document.getElementById('main-container')?.setAttribute('inert', '');
        if (document.activeElement) document.activeElement.blur();

        _updateTitle();
        _updateControlLabels();
        _loadData();
    }

    function hidePanel() {
        var overlay  = document.getElementById('tracker-overlay');
        var backdrop = document.getElementById('tracker-backdrop');
        if (overlay)  overlay.classList.remove('visible');
        if (backdrop) backdrop.classList.remove('visible');
        document.getElementById('main-container')?.removeAttribute('inert');
    }

    function onLangChange() {
        var overlay = document.getElementById('tracker-overlay');
        if (!overlay || !overlay.classList.contains('visible')) return;
        _updateTitle();
        _updateControlLabels();
        if (_cache) _renderEntries(_filter7d(_cache));
    }

    /* ===========================
       PRIVATE - DATA
    =========================== */

    function _cutoff7d() {
        var d = new Date();
        d.setUTCDate(d.getUTCDate() - _WINDOW_DAYS);
        d.setUTCHours(0, 0, 0, 0);
        return d;
    }

    function _filter7d(data) {
        var cutoff = _cutoff7d();
        return (data || []).filter(function (e) {
            if (!e.detected_at) return false;
            return new Date(e.detected_at) >= cutoff;
        });
    }

    function _updateBadge(data) {
        var btn = document.getElementById('tracker-btn');
        if (!btn) return;
        var count = _combineByItem(_filter7d(data)).length;
        btn.dataset.badge = count > 0 ? (count > 999 ? '999+' : String(count)) : '';
    }

    async function _loadData() {
        if (_cache) {
            _renderEntries(_filter7d(_cache));
            return;
        }

        _showLoading();

        try {
            var data = await EFTForge.api.fetchStatChangelog();
            _cache = data;
            _updateBadge(data);
            _renderEntries(_filter7d(data));
        } catch (err) {
            console.error('[tracker] Load error:', err);
            _showError();
        }
    }

    async function _prefetch() {
        try {
            var data = await EFTForge.api.fetchStatChangelog();
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
        var hasBuff = false, hasNerf = false;
        for (var i = 0; i < combinedEntry.stats.length; i++) {
            var s = combinedEntry.stats[i];
            if (s.old_value == null || s.new_value == null) continue;
            var lowerBetter = !!_LOWER_IS_BETTER[s.stat_name];
            var improved = lowerBetter ? (s.new_value < s.old_value) : (s.new_value > s.old_value);
            if (improved) hasBuff = true;
            else hasNerf = true;
        }
        if (hasBuff && hasNerf) return 'mixed';
        if (hasBuff) return 'buff';
        return 'nerf';
    }

    function _applyFilters(items) {
        var q = _searchQuery.toLowerCase().trim();
        return items.filter(function (item) {
            if (_typeFilter === 'weapons'     && !item.is_weapon) return false;
            if (_typeFilter === 'attachments' &&  item.is_weapon) return false;
            if (q) {
                var name   = (item.item_name    || '').toLowerCase();
                var nameZh = (item.item_name_zh || '').toLowerCase();
                if (!name.includes(q) && !nameZh.includes(q)) return false;
            }
            return true;
        });
    }

    /* ===========================
       PRIVATE - RENDERING
    =========================== */

    function _updateTitle() {
        var el = document.getElementById('tracker-header-title');
        if (el) el.textContent = EFTForge.lang.t('tracker.title');
    }

    function _updateControlLabels() {
        var t = EFTForge.lang.t;
        var s = document.getElementById('tracker-search');
        if (s) s.placeholder = t('tracker.search.placeholder') || 'Search items...';

        var labelMap = {
            'tracker-filter-all':        'tracker.filter.all',
            'tracker-filter-weapons':    'tracker.filter.weapons',
            'tracker-filter-attachments':'tracker.filter.attachments',
            'tracker-col-label-buff':    'tracker.col.buffs',
            'tracker-col-label-nerf':    'tracker.col.nerfs',
            'tracker-col-label-mixed':   'tracker.col.mixed',
        };
        Object.keys(labelMap).forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.textContent = t(labelMap[id]) || el.textContent;
        });
    }

    function _showLoading() {
        var hint = document.getElementById('tracker-no-change-hint');
        var columns = document.getElementById('tracker-columns');
        if (hint)    hint.style.display = 'none';
        if (columns) columns.style.display = '';
        var msg = EFTForge.lang.t('tracker.loading');
        ['buff', 'nerf', 'mixed'].forEach(function (col) {
            var el = document.getElementById('tracker-body-' + col);
            if (el) el.innerHTML = '<div class="tracker-empty">' + _esc(msg) + '</div>';
            var cnt = document.getElementById('tracker-count-' + col);
            if (cnt) cnt.textContent = '';
        });
    }

    function _showError() {
        var msg = EFTForge.lang.t('tracker.loadError');
        ['buff', 'nerf', 'mixed'].forEach(function (col) {
            var el = document.getElementById('tracker-body-' + col);
            if (el) el.innerHTML = '<div class="tracker-empty">' + _esc(msg) + '</div>';
        });
    }

    function _combineByItem(data) {
        var combined = [];
        var keyIndex = {};

        (data || []).forEach(function (entry) {
            var dateKey = entry.detected_at ? entry.detected_at.slice(0, 10) : 'unknown';
            var key = dateKey + '\x00' + entry.item_id;
            if (!keyIndex.hasOwnProperty(key)) {
                keyIndex[key] = combined.length;
                combined.push({
                    item_id:      entry.item_id,
                    item_name:    entry.item_name,
                    item_name_zh: entry.item_name_zh,
                    icon_link:    entry.icon_link,
                    is_weapon:    entry.is_weapon,
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
        var lang     = EFTForge.state && EFTForge.state.lang;
        var items    = _combineByItem(data);

        var hint    = document.getElementById('tracker-no-change-hint');
        var columns = document.getElementById('tracker-columns');
        if (items.length === 0) {
            if (hint) {
                hint.textContent = EFTForge.lang.t('tracker.empty');
                hint.style.display = '';
            }
            if (columns) columns.style.display = 'none';
            return;
        }
        if (hint)    hint.style.display = 'none';
        if (columns) columns.style.display = '';

        var filtered = _applyFilters(items);

        var buffs = filtered.filter(function (i) { return _classify(i) === 'buff';  });
        var nerfs = filtered.filter(function (i) { return _classify(i) === 'nerf';  });
        var mixed = filtered.filter(function (i) { return _classify(i) === 'mixed'; });

        _renderColumn('buff',  buffs,  lang);
        _renderColumn('nerf',  nerfs,  lang);
        _renderColumn('mixed', mixed,  lang);

        var setCount = function (id, val) {
            var el = document.getElementById(id);
            if (el) el.textContent = val;
        };
        setCount('tracker-count-buff',  buffs.length);
        setCount('tracker-count-nerf',  nerfs.length);
        setCount('tracker-count-mixed', mixed.length);
    }

    function _renderColumn(type, items, lang) {
        var body = document.getElementById('tracker-body-' + type);
        if (!body) return;

        if (!items.length) {
            body.innerHTML = '<div class="tracker-empty">-</div>';
            return;
        }

        var groups   = [];
        var groupMap = {};

        items.forEach(function (item) {
            var dateKey = item.detected_at ? item.detected_at.slice(0, 10) : 'unknown';
            if (!groupMap[dateKey]) {
                groupMap[dateKey] = [];
                groups.push(dateKey);
            }
            groupMap[dateKey].push(item);
        });

        var t        = EFTForge.lang.t;
        var html     = '';
        var globalIdx = 0;

        groups.forEach(function (dateKey) {
            html += '<div class="tracker-date-label">' + _esc(_formatDate(dateKey)) + '</div>';

            groupMap[dateKey].forEach(function (entry) {
                var name = (lang === 'zh' && entry.item_name_zh)
                    ? entry.item_name_zh
                    : (entry.item_name || entry.item_id);

                var animIdx  = Math.min(globalIdx, 25);
                var iconHtml = entry.icon_link
                    ? '<img class="tracker-item-icon" src="' + _esc(entry.icon_link) + '" alt="" loading="lazy">'
                    : '<div class="tracker-item-icon tracker-item-icon-placeholder"></div>';

                var statsHtml = '';
                entry.stats.forEach(function (s) {
                    var statLabel   = t('tracker.statLabel.' + s.stat_name) || s.stat_name;
                    var lowerBetter = !!_LOWER_IS_BETTER[s.stat_name];
                    var improved    = (s.old_value != null && s.new_value != null)
                                      ? (lowerBetter ? s.new_value < s.old_value : s.new_value > s.old_value)
                                      : false;
                    var changeClass = improved ? 'tracker-stat-up' : 'tracker-stat-down';
                    var oldStr      = s.old_value != null ? _fmtValForStat(s.stat_name, s.old_value) : '?';
                    var newStr      = s.new_value != null ? _fmtValForStat(s.stat_name, s.new_value) : '?';
                    var pctStr      = _fmtPct(s.old_value, s.new_value);

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

                html += (
                    '<div class="tracker-entry" style="--tr-i:' + animIdx + '">' +
                    iconHtml +
                    '<div class="tracker-entry-info">' +
                    '<div class="tracker-item-name">' + _esc(name) + '</div>' +
                    statsHtml +
                    '</div>' +
                    '</div>'
                );

                globalIdx++;
            });
        });

        body.innerHTML = html;
    }

    /* ===========================
       PRIVATE - HELPERS
    =========================== */

    function _formatDate(dateStr) {
        if (!dateStr || dateStr === 'unknown') return dateStr;
        try {
            var parts  = dateStr.split('-').map(Number);
            var d      = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
            var locale = EFTForge.state.lang === 'zh' ? 'zh-CN' : 'en-US';
            return d.toLocaleDateString(locale, {
                year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
            });
        } catch (_) {
            return dateStr;
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
        if (statName === 'recoil_modifier' || statName === 'accuracy_modifier') {
            var pv   = v * 100;
            var sign = pv >= 0 ? '+' : '';
            return sign + parseFloat(pv.toFixed(1)) + '%';
        }
        return _fmtVal(v);
    }

    function _fmtPct(oldVal, newVal) {
        if (oldVal == null || newVal == null) return 'N/A';
        if (oldVal === 0) return newVal > 0 ? '+∞' : newVal < 0 ? '-∞' : '0%';
        var pct  = ((newVal - oldVal) / Math.abs(oldVal)) * 100;
        var sign = pct >= 0 ? '+' : '';
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
            var overlay = document.getElementById('tracker-overlay');
            if (!overlay || !overlay.classList.contains('visible')) return;
            e.stopPropagation();
            hidePanel();
        }, true);

        var searchInput = document.getElementById('tracker-search');
        if (searchInput) {
            searchInput.addEventListener('input', function (e) {
                _searchQuery = e.target.value || '';
                clearTimeout(_searchTimer);
                _searchTimer = setTimeout(function () {
                    if (_cache) _renderEntries(_filter7d(_cache));
                }, 200);
            });
        }

        var filterWrap = document.getElementById('tracker-type-filter');
        if (filterWrap) {
            filterWrap.addEventListener('click', function (e) {
                var btn = e.target.closest('.tracker-filter-btn');
                if (!btn) return;
                _typeFilter = btn.dataset.filter || 'all';
                filterWrap.querySelectorAll('.tracker-filter-btn').forEach(function (b) {
                    b.classList.toggle('active', b === btn);
                });
                if (_cache) _renderEntries(_filter7d(_cache));
            });
        }

        _prefetch();
    }

    function reload() {
        _cache = null;
        var overlay = document.getElementById('tracker-overlay');
        if (overlay && overlay.classList.contains('visible')) {
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
