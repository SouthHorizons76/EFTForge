window.EFTForge = window.EFTForge || {};

/* ============================================================
   STAT TRACKER MODULE
   Displays a chronological log of attachment and weapon stat
   changes detected during syncs from tarkov.dev.

   Only shows entries from the last 7 days. The count of those
   entries is shown as a badge on the header Tracker button and
   is fetched silently in the background on page load.

   Entries are grouped by detection date (newest first).
   Each entry shows the item icon, name, changed stat, old
   and new values, and the percentage delta.
============================================================ */

window.EFTForge.tracker = (function () {

    var _cache = null;
    var _WINDOW_DAYS = 7;

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
        var count = _filter7d(data).length;
        btn.dataset.badge = count > 0 ? (count > 99 ? '99+' : String(count)) : '';
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
       PRIVATE - RENDERING
    =========================== */

    function _updateTitle() {
        var el = document.getElementById('tracker-header-title');
        if (el) el.textContent = EFTForge.lang.t('tracker.title');
    }

    function _showLoading() {
        var body = document.getElementById('tracker-body');
        if (body) body.innerHTML = '<div class="tracker-empty">' + _esc(EFTForge.lang.t('tracker.loading')) + '</div>';
    }

    function _showError() {
        var body = document.getElementById('tracker-body');
        if (body) body.innerHTML = '<div class="tracker-empty">' + _esc(EFTForge.lang.t('tracker.loadError')) + '</div>';
    }

    function _renderEntries(data) {
        var body = document.getElementById('tracker-body');
        if (!body) return;

        var t    = EFTForge.lang.t;
        var lang = EFTForge.state && EFTForge.state.lang;

        if (!data || data.length === 0) {
            body.innerHTML = '<div class="tracker-empty">' + _esc(t('tracker.empty')) + '</div>';
            return;
        }

        // group by date (YYYY-MM-DD extracted from detected_at ISO string)
        var groups   = [];
        var groupMap = {};

        data.forEach(function (entry) {
            var dateKey = entry.detected_at ? entry.detected_at.slice(0, 10) : 'unknown';
            if (!groupMap[dateKey]) {
                groupMap[dateKey] = [];
                groups.push(dateKey);
            }
            groupMap[dateKey].push(entry);
        });

        var html = '';

        groups.forEach(function (dateKey) {
            var entries = groupMap[dateKey];
            html += '<div class="tracker-date-group">';
            html += '<div class="tracker-date-label">' + _esc(_formatDate(dateKey)) + '</div>';

            entries.forEach(function (entry, idx) {
                var name      = (lang === 'zh' && entry.item_name_zh) ? entry.item_name_zh : (entry.item_name || entry.item_id);
                var statLabel = t('tracker.statLabel.' + entry.stat_name) || entry.stat_name;
                var oldVal    = entry.old_value;
                var newVal    = entry.new_value;
                var changeClass = newVal > oldVal ? 'tracker-stat-up' : 'tracker-stat-down';
                var oldStr    = oldVal != null ? _fmtVal(oldVal) : '?';
                var newStr    = newVal != null ? _fmtVal(newVal) : '?';
                var pctStr    = _fmtPct(oldVal, newVal);

                var iconHtml = entry.icon_link
                    ? '<img class="tracker-item-icon" src="' + _esc(entry.icon_link) + '" alt="" loading="lazy">'
                    : '<div class="tracker-item-icon tracker-item-icon-placeholder"></div>';

                html += (
                    '<div class="tracker-entry" style="--tr-i:' + idx + '">' +
                    iconHtml +
                    '<div class="tracker-entry-info">' +
                    '<div class="tracker-item-name">' + _esc(name) + '</div>' +
                    '<div class="tracker-stat-row">' +
                    '<span class="tracker-stat-label">' + _esc(statLabel) + '</span>' +
                    '<span class="tracker-stat-change ' + changeClass + '">' +
                    _esc(oldStr) + ' \u2192 ' + _esc(newStr) +
                    '<span class="tracker-stat-pct">(' + _esc(pctStr) + ')</span>' +
                    '</span>' +
                    '</div>' +
                    '</div>' +
                    '</div>'
                );
            });

            html += '</div>';
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

    function _fmtPct(oldVal, newVal) {
        if (oldVal == null || newVal == null) return 'N/A';
        if (oldVal === 0) return newVal > 0 ? '+\u221e' : newVal < 0 ? '-\u221e' : '0%';
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

        // silent background fetch so the badge is populated at page load
        _prefetch();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _init);
    } else {
        _init();
    }

    // clears the cache and re-renders/re-badges with fresh data (used by devtool)
    function reload() {
        _cache = null;
        var overlay = document.getElementById('tracker-overlay');
        if (overlay && overlay.classList.contains('visible')) {
            _loadData();
        } else {
            _prefetch();
        }
    }

    return { showPanel, hidePanel, onLangChange, reload };

})();
