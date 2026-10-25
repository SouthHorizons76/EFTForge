window.EFTForge = window.EFTForge || {};

/* ============================================================
   ATLAS SERVERS PAGE
   Standalone page at /atlas/matching, next to the change trackers at /atlas and
   /atlas/arena. Shows the average matchmaking wait per datacenter that Ripper
   polls from the game's launcher API, served by /atlas/api/matching: the latest
   wait, a sparkline of the chosen range, and its min, average and max. Live
   data, no time gate and no key.
   Everything from the data goes in through textContent, never innerHTML.
============================================================ */

window.EFTForge.atlasMatching = (function () {

    const API = '/atlas/api/matching';
    const LANG_STORAGE  = 'eftforge_lang';   // shared with the rest of the site
    const HOURS_STORAGE = 'eftforge_atlas_matching_hours';
    const SORT_STORAGE  = 'eftforge_atlas_matching_sort';
    const HOURS = [6, 24, 168];
    const SORTS = ['wait', 'region', 'name'];
    const REFRESH_MS = 120000;   // Ripper polls about every 100 s
    const STALE_SECONDS = 900;   // older than this, the page says the numbers have stopped updating
    const FAST_SECONDS = 60;
    const OK_SECONDS = 180;
    const SPARK_W = 160;
    const SPARK_H = 28;
    const SVG_NS = 'http://www.w3.org/2000/svg';

    const STRINGS = {
        en: {
            pageTitle:    'Atlas - Server Matching Times',
            gameLabel:    'Game',
            gameEft:      'Tarkov',
            gameArena:    'Arena',
            gameMatching: 'Servers',
            returnTo:     'Return to',
            tzLabel:      'Time zone',
            tzLocal:      'Local',
            regions:      'Regions',
            allRegions:   'All regions',
            fastest:      (name, wait) => `Fastest: ${name} ${wait}`,
            dcCount:      n => `${n} datacenter${n === 1 ? '' : 's'}`,
            rangeLabel:   'Range',
            range6h:      '6 h',
            range24h:     '24 h',
            range7d:      '7 d',
            sortLabel:    'Sort',
            sortWait:     'Wait',
            sortRegion:   'Region',
            sortName:     'Name',
            title:        'Average matching time',
            updated:      time => `Updated ${time}`,
            source:       'Reported by the game\'s backend per datacenter, refreshed about every 100 seconds.',
            stale:        'These numbers have stopped updating.',
            colRegion:    'Region',
            colDatacenter:'Datacenter',
            colNow:       'Now',
            colTrend:     h => h === 168 ? 'Last 7 days' : `Last ${h} hours`,
            colMin:       'Min',
            colAvg:       'Avg',
            colMax:       'Max',
            loading:      'Loading...',
            emptyTitle:   'No data yet',
            emptyText:    'Matching times appear here once the first sample is recorded.',
            errorTitle:   'Unavailable',
            errorText:    'The matching times couldn\'t be loaded. Try again in a moment.',
            retry:        'Retry',
            regionNames:  { EUR: 'Europe', USA: 'North America', RUS: 'Russia', ASI: 'Asia', SAM: 'Latin America',
                            OCE: 'Oceania', ME: 'Middle East', AF: 'Africa' },
        },
        zh: {
            pageTitle:    'Atlas - 服务器匹配时间',
            gameLabel:    '游戏',
            gameEft:      '逃离塔科夫',
            gameArena:    '竞技场',
            gameMatching: '服务器',
            returnTo:     '返回',
            tzLabel:      '时区',
            tzLocal:      '本地',
            regions:      '地区',
            allRegions:   '全部地区',
            fastest:      (name, wait) => `最快：${name} ${wait}`,
            dcCount:      n => `${n} 个数据中心`,
            rangeLabel:   '范围',
            range6h:      '6 小时',
            range24h:     '24 小时',
            range7d:      '7 天',
            sortLabel:    '排序',
            sortWait:     '等待',
            sortRegion:   '地区',
            sortName:     '名称',
            title:        '平均匹配时间',
            updated:      time => `更新于 ${time}`,
            source:       '由游戏后端按数据中心提供，约每 100 秒刷新一次。',
            stale:        '这些数据已停止更新。',
            colRegion:    '地区',
            colDatacenter:'数据中心',
            colNow:       '当前',
            colTrend:     h => h === 168 ? '最近 7 天' : `最近 ${h} 小时`,
            colMin:       '最短',
            colAvg:       '平均',
            colMax:       '最长',
            loading:      '加载中...',
            emptyTitle:   '暂无数据',
            emptyText:    '记录到第一组数据后，匹配时间会显示在这里。',
            errorTitle:   '暂不可用',
            errorText:    '无法加载匹配时间，请稍后再试。',
            retry:        '重试',
            regionNames:  { EUR: '欧洲', USA: '北美', RUS: '俄罗斯', ASI: '亚洲', SAM: '拉丁美洲',
                            OCE: '大洋洲', ME: '中东', AF: '非洲' },
        },
    };

    /* ===========================
       PURE HELPERS
    =========================== */

    // 31 -> "0:31", 646 -> "10:46"
    function formatWait(seconds) {
        if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '-';
        const s = Math.round(seconds);
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }

    function waitTone(seconds) {
        if (typeof seconds !== 'number') return '';
        return seconds <= FAST_SECONDS ? 'fast' : seconds <= OK_SECONDS ? 'ok' : 'slow';
    }

    // The backend's names carry a region prefix on some entries ("Me   Dubai", "Sa   Colombia");
    // drop it when it repeats the region, and squeeze the spacing either way.
    function displayName(name, region) {
        const n = String(name || '').replace(/\s+/g, ' ').trim();
        const m = /^([A-Za-z]{2}) (.+)$/.exec(n);
        return m && String(region || '').toUpperCase().startsWith(m[1].toUpperCase()) ? m[2] : n;
    }

    function seriesStats(values) {
        const nums = (values || []).filter(v => typeof v === 'number');
        if (!nums.length) return { min: null, avg: null, max: null };
        const sum = nums.reduce((a, b) => a + b, 0);
        return { min: Math.min(...nums), avg: Math.round(sum / nums.length), max: Math.max(...nums) };
    }

    // One summary per region, fastest region first: how many datacenters and which is quickest.
    function regionSummaries(datacenters) {
        const byRegion = new Map();
        for (const dc of datacenters) {
            const entry = byRegion.get(dc.region) || { region: dc.region, count: 0, fastest: null };
            entry.count++;
            if (typeof dc.wait === 'number' && (!entry.fastest || dc.wait < entry.fastest.wait)) entry.fastest = dc;
            byRegion.set(dc.region, entry);
        }
        const waitOf = e => e.fastest ? e.fastest.wait : Infinity;
        return [...byRegion.values()].sort((a, b) => waitOf(a) - waitOf(b) || a.region.localeCompare(b.region));
    }

    function sortRows(rows, sort) {
        const waitOf = r => typeof r.wait === 'number' ? r.wait : Infinity;
        const byName = (a, b) => displayName(a.name, a.region).localeCompare(displayName(b.name, b.region));
        const copy = [...rows];
        if (sort === 'name') return copy.sort(byName);
        if (sort === 'region') return copy.sort((a, b) => a.region.localeCompare(b.region) || waitOf(a) - waitOf(b) || byName(a, b));
        return copy.sort((a, b) => waitOf(a) - waitOf(b) || byName(a, b));
    }

    // Where bucket i of n sits across the range, 0 to 1: its middle, so the sparklines, the
    // time axis and the crosshair all agree on where a moment is.
    function bucketX(i, n) {
        return n > 0 ? (i + 0.5) / n : 0;
    }

    // The bucket under a pointer at fraction x (0 to 1) of the range.
    function bucketAt(x, n) {
        return Math.max(0, Math.min(n - 1, Math.floor(x * n)));
    }

    // Axis ticks for a range: whole hours or days in the shown zone, as {t, x} with x 0 to 1.
    // offsetOf(t) is the zone's offset from UTC in seconds at t (UTC+8 unless given); we walk
    // the range in quarter hours and keep the moments that are whole in that zone, so a
    // daylight-saving change or a half-hour zone still lands on the right local times.
    /**
     * @param {number} start
     * @param {number} step
     * @param {number} n
     * @param {number} hours
     * @param {(t: number) => number} [offsetOf]
     */
    function timeTicks(start, step, n, hours, offsetOf = () => 8 * 3600) {
        const every = hours <= 6 ? 3600 : hours <= 24 ? 3 * 3600 : 86400;
        const end = start + n * step;
        const ticks = [];
        for (let t = Math.ceil(start / 900) * 900; t <= end; t += 900) {
            if ((((t + offsetOf(t)) % every) + every) % every !== 0) continue;
            const x = (t - start) / (end - start);
            if (x > 0.02 && x < 0.98) ticks.push({ t, x });   // none hugging an edge
        }
        return ticks;
    }

    // Polyline point lists for a sparkline, split wherever the series has a gap (null).
    // The y axis runs from 0 to the series' max, so a flat line reads as steady, not as zero.
    function sparkSegments(values, width = SPARK_W, height = SPARK_H) {
        const list = values || [];
        const max = Math.max(1, ...list.filter(v => typeof v === 'number'));
        const segments = [];
        let current = [];
        list.forEach((v, i) => {
            if (typeof v !== 'number') {
                if (current.length) segments.push(current);
                current = [];
                return;
            }
            const x = +(bucketX(i, list.length) * width).toFixed(1);
            const y = +(height - 1 - (v / max) * (height - 2)).toFixed(1);
            current.push(`${x},${y}`);
        });
        if (current.length) segments.push(current);
        // a lone point would draw nothing; stretch it into a dot-sized dash
        return segments.map(points => points.length === 1 ? [points[0], points[0].replace(/^([\d.]+)/, x => String(+x + 1))] : points).map(p => p.join(' '));
    }

    // The detail chart's y axis: 0 up to just past the max, in clean steps (15 s, 30 s, whole
    // minutes...), about four of them. top is where the axis ends.
    function waitTicks(max) {
        const steps = [15, 30, 60, 120, 300, 600, 900, 1800, 3600];
        const step = steps.find(s => max / s <= 4) || steps[steps.length - 1];
        const top = Math.max(step, Math.ceil(max / step) * step);
        const ticks = [];
        for (let v = 0; v <= top; v += step) ticks.push(v);
        return { top, ticks };
    }

    // The detail chart's line and its wash, one {line, area} path pair per stretch without a
    // gap, in a width x height box whose y runs from top (at 0) down to 0 seconds (at height).
    function detailPaths(values, top, width = 1000, height = 100) {
        const list = values || [];
        const stretches = [];
        let current = [];
        list.forEach((v, i) => {
            if (typeof v !== 'number') {
                if (current.length) stretches.push(current);
                current = [];
                return;
            }
            current.push([+(bucketX(i, list.length) * width).toFixed(1), +(height - (v / top) * height).toFixed(1)]);
        });
        if (current.length) stretches.push(current);
        return stretches.map(points => {
            // a lone point would draw nothing; widen it into a short flat dash
            if (points.length === 1) points = [[points[0][0] - 1, points[0][1]], [points[0][0] + 1, points[0][1]]];
            const line = `M${points.map(p => p.join(',')).join(' L')}`;
            const first = points[0][0];
            const last = points[points.length - 1][0];
            return { line, area: `${line} L${last},${height} L${first},${height} Z` };
        });
    }

    /* ===========================
       STATE
    =========================== */

    let _lang = 'en';
    let _hours = 24;
    let _sort = 'region';
    let _region = '';    // '' = all regions
    let _data = null;     // the last /atlas/api/matching answer
    let _error = false;
    let _loadToken = 0;
    let _refreshTimer = 0;
    let _cross = -1;     // the bucket the crosshair is on, -1 = none (the Now column shows now)
    let _expanded = '';  // the datacenter whose detail chart is open, '' = none
    let _view = { start: 0, step: 0, count: 0, ticks: [], rows: [], nowHeader: null };   // the rendered table

    function t(key, ...args) {
        const s = (STRINGS[_lang] || STRINGS.en)[key];
        return typeof s === 'function' ? s(...args) : s;
    }

    function readStorage(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    }

    function writeStorage(key, value) {
        try { localStorage.setItem(key, value); } catch { /* private mode: the choice just won't persist */ }
    }

    function $(id) { return document.getElementById(id); }

    function el(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
    }

    function regionName(code) {
        return t('regionNames')[code] || code;
    }

    // UTC+8, or the viewer's own zone if they switched to it, always labelled, like the change trackers
    function formatTime(iso) {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        const opts = { ...EFTForge.utils.atlasZoneOptions(), month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
        const text = new Intl.DateTimeFormat(_lang === 'zh' ? 'zh-CN' : 'en-US', /** @type {any} */ (opts)).format(d);
        const zone = EFTForge.utils.atlasZoneLabel(d);
        return _lang === 'zh' ? `${text}（${zone}）` : `${text} (${zone})`;
    }

    /* ===========================
       ENTRANCE
    =========================== */

    // The change trackers' staggered entrance: the rows on screen rise in one after another,
    // once per page visit (the first render with data, or arriving through the page swipe).
    let _entranceRegions = true;
    let _entranceRows = true;

    // Measure visible rows together before adding animation styles, as atlas.js does.
    /**
     * @param {HTMLElement} container
     * @param {string} selector
     */
    function staggerVisible(container, selector) {
        container.querySelectorAll('.atlas-entering').forEach(node => node.classList.remove('atlas-entering'));
        const bounds = container.getBoundingClientRect();
        const visible = Array.from(/** @type {NodeListOf<HTMLElement>} */ (container.querySelectorAll(selector))).filter(node => {
            const r = node.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.bottom > bounds.top && r.top < bounds.bottom;
        });
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return visible.length > 0;
        visible.forEach((node, i) => {
            node.style.setProperty('--atlas-entrance-delay', `${i * 22}ms`);
            node.classList.add('atlas-entering');
            node.addEventListener('animationend', function finish(e) {
                if (e.target !== node || e.animationName !== 'gunCardEntrance') return;
                node.classList.remove('atlas-entering');
                node.style.removeProperty('--atlas-entrance-delay');
                node.removeEventListener('animationend', finish);
            });
        });
        return visible.length > 0;
    }

    function enterRegions() {
        if (_entranceRegions && staggerVisible($('atlas-region-list'), '.atlas-region-item')) _entranceRegions = false;
    }

    function enterRows() {
        if (_entranceRows && staggerVisible($('atlas-matching-table'), '.atlas-matching-row')) _entranceRows = false;
    }

    // page-swipe.js calls this when the page arrives through the swipe from EFTForge
    function startPageEntrances() {
        _entranceRegions = _entranceRows = true;
        enterRegions();
        enterRows();
    }

    /* ===========================
       RENDER
    =========================== */

    function applyStaticText() {
        document.documentElement.lang = _lang === 'zh' ? 'zh-CN' : 'en';
        document.title = t('pageTitle');
        $('atlas-game-switch').setAttribute('aria-label', t('gameLabel'));
        $('atlas-tz-switch').setAttribute('aria-label', t('tzLabel'));
        document.querySelectorAll('[data-atlas-text]').forEach(node => {
            node.textContent = t(/** @type {HTMLElement} */ (node).dataset.atlasText);
        });
        const langSelect = /** @type {HTMLSelectElement} */ ($('lang-select'));
        if (langSelect.value !== _lang) {
            langSelect.value = _lang;
            langSelect.dispatchEvent(new Event('input'));   // refresh the custom select's trigger
        }
        syncToggles();
    }

    function syncToggles() {
        document.querySelectorAll('[data-atlas-hours]').forEach(b =>
            b.classList.toggle('active', Number(/** @type {HTMLElement} */ (b).dataset.atlasHours) === _hours));
        document.querySelectorAll('[data-atlas-sort]').forEach(b =>
            b.classList.toggle('active', /** @type {HTMLElement} */ (b).dataset.atlasSort === _sort));
        const local = EFTForge.utils.atlasLocalTime();
        document.querySelectorAll('[data-atlas-tz]').forEach(b =>
            b.classList.toggle('active', (/** @type {HTMLElement} */ (b).dataset.atlasTz === 'local') === local));
    }

    // Times, axis ticks and the crosshair's readout redraw in the chosen zone; nothing is
    // refetched, the server only ever sends UTC.
    function setLocalTime(local) {
        if (local === EFTForge.utils.atlasLocalTime()) return;
        EFTForge.utils.setAtlasLocalTime(local);
        syncToggles();
        render();
    }

    function renderRegions() {
        const list = $('atlas-region-list');
        const datacenters = _data ? _data.datacenters : [];
        if (!datacenters.length) {
            list.replaceChildren(el('div', 'atlas-empty', _data || _error ? '' : t('loading')));
            return;
        }
        const item = (code, label, meta) => {
            const btn = el('button', 'atlas-set-item atlas-region-item');
            btn.type = 'button';
            btn.classList.toggle('active', _region === code);
            const top = el('div', 'atlas-set-top');
            top.appendChild(el('span', 'atlas-set-date', label));
            btn.appendChild(top);
            btn.appendChild(el('div', 'atlas-set-meta', meta));
            btn.addEventListener('click', () => {
                _region = code;
                renderRegions();
                renderTable();
            });
            return btn;
        };
        const nodes = [item('', t('allRegions'), t('dcCount', datacenters.length))];
        for (const r of regionSummaries(datacenters)) {
            const meta = r.fastest
                ? t('fastest', displayName(r.fastest.name, r.region), formatWait(r.fastest.wait))
                : t('dcCount', r.count);
            const node = item(r.region, regionName(r.region), meta);
            if (r.fastest) node.querySelector('.atlas-set-meta').classList.add(`atlas-wait-${waitTone(r.fastest.wait)}`);
            nodes.push(node);
        }
        list.replaceChildren(...nodes);
        enterRegions();
    }

    function renderHead() {
        const head = $('atlas-matching-head');
        const title = el('div', 'atlas-set-title', t('title'));
        const nodes = [title];
        if (_data && _data.updated) {
            const sub = el('div', 'atlas-set-sub', t('updated', formatTime(_data.updated)));
            const age = (Date.parse(_data.server_time) - Date.parse(_data.updated)) / 1000;
            if (age > STALE_SECONDS) sub.appendChild(el('span', 'atlas-matching-stale', ` ${t('stale')}`));
            nodes.push(sub);
        }
        nodes.push(el('div', 'atlas-set-sub atlas-matching-source', t('source')));
        head.replaceChildren(...nodes);
    }

    function spark(values, ticks) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('class', 'atlas-spark');
        svg.setAttribute('aria-hidden', 'true');
        // hairlines under the line at the axis ticks, so a dip can be placed in time
        for (const tick of ticks) {
            const grid = document.createElementNS(SVG_NS, 'line');
            const x = String(+(tick.x * SPARK_W).toFixed(1));
            grid.setAttribute('x1', x);
            grid.setAttribute('x2', x);
            grid.setAttribute('y1', '0');
            grid.setAttribute('y2', String(SPARK_H));
            grid.setAttribute('class', 'atlas-spark-grid');
            svg.appendChild(grid);
        }
        for (const points of sparkSegments(values)) {
            const line = document.createElementNS(SVG_NS, 'polyline');
            line.setAttribute('points', points);
            svg.appendChild(line);
        }
        return svg;
    }

    function waitCell(seconds, cls) {
        const cell = el('span', cls, formatWait(seconds));
        const tone = waitTone(seconds);
        if (tone) cell.classList.add(`atlas-wait-${tone}`);
        return cell;
    }

    function showState(title, text, { error = false, retry = false } = {}) {
        const card = el('div', `atlas-state${error ? ' error' : ''}`);
        const head = el('div', 'atlas-state-head');
        head.appendChild(el('span', 'atlas-state-title', title));
        card.appendChild(head);
        const body = el('div', 'atlas-state-body');
        body.appendChild(el('p', 'atlas-state-text', text));
        if (retry) {
            const row = el('div', 'atlas-state-actions');
            const btn = el('button', 'modal-btn primary', t('retry'));
            btn.type = 'button';
            btn.addEventListener('click', () => load());
            row.appendChild(btn);
            body.appendChild(row);
        }
        card.appendChild(body);
        $('atlas-matching-table').replaceChildren(card);
    }

    function renderTable() {
        if (_error && !_data) {
            showState(t('errorTitle'), t('errorText'), { error: true, retry: true });
            return;
        }
        if (!_data) {
            $('atlas-matching-table').replaceChildren(el('div', 'atlas-empty', t('loading')));
            return;
        }
        if (!_data.datacenters.length) {
            showState(t('emptyTitle'), t('emptyText'));
            return;
        }
        const history = _data.history || { start: 0, step: 0, series: {} };
        const series = history.series || {};
        const count = Math.max(0, ...Object.values(series).map(v => v.length));
        const ticks = count ? timeTicks(history.start, history.step, count, _data.hours, EFTForge.utils.atlasZoneOffset) : [];
        _view = { start: history.start, step: history.step, count, ticks, rows: [], nowHeader: null };
        const rows = sortRows(_data.datacenters.filter(dc => !_region || dc.region === _region), _sort);

        const header = el('div', 'atlas-matching-row atlas-matching-header');
        header.appendChild(el('span', 'atlas-matching-region', t('colRegion')));
        header.appendChild(el('span', 'atlas-matching-name', t('colDatacenter')));
        _view.nowHeader = el('span', 'atlas-matching-now', t('colNow'));
        header.appendChild(_view.nowHeader);
        // the trend column's header is its time axis, under the range's name
        const axis = el('span', 'atlas-matching-trend atlas-matching-axis');
        axis.appendChild(el('span', 'atlas-matching-axis-title', t('colTrend', _data.hours)));
        for (const tick of ticks) {
            const label = el('span', 'atlas-matching-tick', formatTick(tick.t));
            label.style.left = `${tick.x * 100}%`;
            axis.appendChild(label);
        }
        header.appendChild(axis);
        for (const key of ['colMin', 'colAvg', 'colMax']) header.appendChild(el('span', 'atlas-matching-stat', t(key)));

        const nodes = [header];
        for (const dc of rows) {
            const values = series[dc.name] || [];
            const stats = seriesStats(values);
            const row = el('div', 'atlas-matching-row');
            row.tabIndex = 0;   // focus a row, then left/right walk it through time
            row.appendChild(el('span', 'atlas-matching-region', dc.region));
            row.lastChild.title = regionName(dc.region);
            const name = displayName(dc.name, dc.region);
            row.appendChild(el('span', 'atlas-matching-name', name));
            const now = waitCell(dc.wait, 'atlas-matching-now');
            row.appendChild(now);
            const trend = el('span', 'atlas-matching-trend');
            trend.appendChild(spark(values, ticks));
            trend.appendChild(el('span', 'atlas-matching-cross'));
            row.appendChild(trend);
            row.appendChild(waitCell(stats.min, 'atlas-matching-stat'));
            row.appendChild(waitCell(stats.avg, 'atlas-matching-stat'));
            row.appendChild(waitCell(stats.max, 'atlas-matching-stat'));
            const ref = { key: dc.name, row, now, trend, name, wait: dc.wait, values, detail: null };
            _view.rows.push(ref);
            row.setAttribute('aria-expanded', 'false');
            row.addEventListener('click', () => toggleDetail(ref));
            trend.addEventListener('pointermove', e => {
                const r = trend.getBoundingClientRect();
                setCross(bucketAt((e.clientX - r.left) / r.width, count), ref, e.clientX, e.clientY);
            });
            trend.addEventListener('pointerleave', () => clearCross());
            row.addEventListener('keydown', e => {
                if (e.target !== row) return;
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleDetail(ref);
                    return;
                }
                if (!count) return;
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    e.preventDefault();
                    const from = _cross < 0 ? count : _cross;
                    setCross(Math.max(0, Math.min(count - 1, from + (e.key === 'ArrowRight' ? 1 : -1))), ref);
                } else if (e.key === 'Escape') clearCross();
            });
            row.addEventListener('blur', () => clearCross());
            nodes.push(row);
        }
        const table = $('atlas-matching-table');
        table.classList.remove('crossing');
        table.replaceChildren(...nodes);
        _cross = -1;
        // a row left open stays open through a re-sort, a new range or the refresh
        const open = _view.rows.find(r => r.key === _expanded);
        if (open) openDetail(open);
        enterRows();
    }

    /* ===========================
       DETAIL CHART
    =========================== */

    function svgNode(tag, attrs) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
        return node;
    }

    // The bigger chart under a clicked row: the same range with a wait axis and a time axis,
    // the line over a light wash, and the shared crosshair with a dot on the line.
    function detailChart(ref) {
        const stats = seriesStats(ref.values);
        const { top, ticks: waits } = waitTicks(Math.max(stats.max || 0, ref.wait || 0, 1));
        const plot = el('div', 'atlas-detail-plot');
        const svg = svgNode('svg', { viewBox: '0 0 1000 100', preserveAspectRatio: 'none', class: 'atlas-detail-svg', 'aria-hidden': 'true' });
        for (const v of waits) {
            const y = +(100 - (v / top) * 100).toFixed(2);
            svg.appendChild(svgNode('line', { x1: 0, x2: 1000, y1: y, y2: y, class: 'atlas-detail-grid' }));
            const label = el('span', 'atlas-detail-ylabel', formatWait(v));
            label.style.top = `${y}%`;
            plot.appendChild(label);
        }
        for (const tick of _view.ticks) {
            const x = +(tick.x * 1000).toFixed(1);
            svg.appendChild(svgNode('line', { x1: x, x2: x, y1: 0, y2: 100, class: 'atlas-detail-grid' }));
            const label = el('span', 'atlas-detail-xlabel', formatTick(tick.t));
            label.style.left = `${tick.x * 100}%`;
            plot.appendChild(label);
        }
        for (const p of detailPaths(ref.values, top)) {
            svg.appendChild(svgNode('path', { d: p.area, class: 'atlas-detail-area' }));
            svg.appendChild(svgNode('path', { d: p.line, class: 'atlas-detail-line' }));
        }
        plot.prepend(svg);
        plot.appendChild(el('span', 'atlas-matching-cross'));
        const dot = el('span', 'atlas-detail-dot');
        dot.hidden = true;
        plot.appendChild(dot);
        plot.addEventListener('pointermove', e => {
            const r = plot.getBoundingClientRect();
            setCross(bucketAt((e.clientX - r.left) / r.width, _view.count), ref, e.clientX, e.clientY);
        });
        plot.addEventListener('pointerleave', () => clearCross());
        const node = el('div', 'atlas-matching-detail');
        node.appendChild(plot);
        return { node, dot, top };
    }

    function openDetail(ref) {
        ref.detail = detailChart(ref);
        ref.row.after(ref.detail.node);
        ref.row.setAttribute('aria-expanded', 'true');
        ref.row.classList.add('expanded');
    }

    function closeDetail(ref) {
        ref.detail.node.remove();
        ref.detail = null;
        ref.row.setAttribute('aria-expanded', 'false');
        ref.row.classList.remove('expanded');
    }

    // One detail open at a time: opening a row closes the last; clicking it again closes it.
    function toggleDetail(ref) {
        const open = _view.rows.find(r => r.detail);
        if (open) closeDetail(open);
        if (open === ref) {
            _expanded = '';
            return;
        }
        _expanded = ref.key;
        openDetail(ref);
        if (_cross >= 0) setCross(_cross, ref);
    }

    /* ===========================
       CROSSHAIR
    =========================== */

    // A moment in the range: the start of bucket i.
    function bucketTime(i) {
        return new Date((_view.start + i * _view.step) * 1000).toISOString();
    }

    function formatTick(t) {
        const opts = _data.hours > 24
            ? { ...EFTForge.utils.atlasZoneOptions(), month: '2-digit', day: '2-digit' }
            : { ...EFTForge.utils.atlasZoneOptions(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
        return new Intl.DateTimeFormat(_lang === 'zh' ? 'zh-CN' : 'en-US', /** @type {any} */ (opts)).format(new Date(t * 1000));
    }

    // The moment in the narrow Now header: the time, with the date too on the 7-day range.
    function formatShort(t) {
        const opts = { ...EFTForge.utils.atlasZoneOptions(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
        if (_data.hours > 24) Object.assign(opts, { month: '2-digit', day: '2-digit' });
        return new Intl.DateTimeFormat(_lang === 'zh' ? 'zh-CN' : 'en-US', /** @type {any} */ (opts)).format(new Date(t * 1000));
    }

    function tip() {
        let node = $('atlas-matching-tip');
        if (!node) {
            node = el('div', 'atlas-matching-tip');
            node.id = 'atlas-matching-tip';
            node.setAttribute('role', 'status');
            document.body.appendChild(node);
        }
        return node;
    }

    // Put every row at bucket i: the line moves on all sparklines together, the Now column
    // becomes that moment's waits, and the tooltip names the hovered row's. Without a
    // pointer position (keyboard), the tooltip sits under the focused row's line.
    function setCross(i, ref, clientX = null, clientY = null) {
        if (!_view.count) return;
        _cross = i;
        const table = $('atlas-matching-table');
        table.classList.add('crossing');
        table.style.setProperty('--atlas-cross', `${bucketX(i, _view.count) * 100}%`);
        _view.nowHeader.textContent = formatShort(_view.start + i * _view.step);
        _view.nowHeader.classList.add('atlas-matching-then');
        for (const r of _view.rows) {
            const v = r.values[i];
            r.now.textContent = formatWait(v);
            r.now.className = `atlas-matching-now atlas-matching-then${waitTone(v) ? ` atlas-wait-${waitTone(v)}` : ''}`;
            // the open detail chart marks the value on its line; a gap there shows no dot
            if (r.detail) {
                r.detail.dot.hidden = typeof v !== 'number';
                if (typeof v === 'number') {
                    r.detail.dot.style.left = `${bucketX(i, _view.count) * 100}%`;
                    r.detail.dot.style.top = `${(1 - v / r.detail.top) * 100}%`;
                }
            }
        }
        const node = tip();
        const value = ref.values[i];
        node.replaceChildren(
            el('div', 'atlas-matching-tip-value', formatWait(value)),
            el('div', 'atlas-matching-tip-name', ref.name),
            el('div', 'atlas-matching-tip-time', formatTime(bucketTime(i))),
        );
        node.hidden = false;
        if (clientX == null) {
            const r = ref.trend.getBoundingClientRect();
            clientX = r.left + bucketX(i, _view.count) * r.width;
            clientY = r.bottom;
        }
        // keep it inside the window, to the side of the pointer away from the nearer edge
        const w = node.offsetWidth;
        const h = node.offsetHeight;
        const left = clientX + 14 + w > window.innerWidth - 8 ? clientX - 14 - w : clientX + 14;
        node.style.left = `${Math.max(8, left)}px`;
        node.style.top = `${Math.max(8, Math.min(clientY + 14, window.innerHeight - h - 8))}px`;
    }

    function clearCross() {
        if (_cross < 0) return;
        _cross = -1;
        $('atlas-matching-table').classList.remove('crossing');
        const node = $('atlas-matching-tip');
        if (node) node.hidden = true;
        if (!_view.nowHeader) return;
        _view.nowHeader.textContent = t('colNow');
        _view.nowHeader.classList.remove('atlas-matching-then');
        for (const r of _view.rows) {
            r.now.textContent = formatWait(r.wait);
            r.now.className = `atlas-matching-now${waitTone(r.wait) ? ` atlas-wait-${waitTone(r.wait)}` : ''}`;
            if (r.detail) r.detail.dot.hidden = true;
        }
    }

    function render() {
        renderHead();
        renderRegions();
        renderTable();
    }

    /* ===========================
       LOAD
    =========================== */

    async function load() {
        const token = ++_loadToken;
        clearTimeout(_refreshTimer);
        if (!_data) renderTable();
        try {
            const res = await fetch(`${EFTForge.config?.API_BASE || ''}${API}?hours=${_hours}`);
            if (!res.ok) throw new Error(String(res.status));
            const data = await res.json();
            if (token !== _loadToken) return;
            _data = data;
            _error = false;
            // a region that's gone from the data falls back to all regions
            if (_region && !_data.datacenters.some(dc => dc.region === _region)) _region = '';
        } catch {
            if (token !== _loadToken) return;
            _error = true;   // keep showing the last numbers we had, if any
        }
        render();
        _refreshTimer = setTimeout(load, REFRESH_MS);
    }

    function setLang(lang) {
        if (lang === _lang) return;
        _lang = lang;
        writeStorage(LANG_STORAGE, lang);
        applyStaticText();
        render();
    }

    function init() {
        EFTForge.utils.initDotParallax(
            document.querySelector('.atlas-bg-dots'),
            document.querySelector('.atlas-bg')
        );
        const stored = readStorage(LANG_STORAGE);
        _lang = stored === 'zh' || stored === 'en' ? stored
            : (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
        const hours = Number(readStorage(HOURS_STORAGE));
        _hours = HOURS.includes(hours) ? hours : 24;
        const sort = readStorage(SORT_STORAGE);
        // region first, like the launcher's own server list
        _sort = SORTS.includes(sort) ? sort : 'region';
        setupCustomSelect('lang-select');
        document.querySelectorAll('[data-atlas-game]').forEach(a => {
            const current = /** @type {HTMLElement} */ (a).dataset.atlasGame === 'matching';
            a.classList.toggle('active', current);
            if (current) a.setAttribute('aria-current', 'page');
        });
        applyStaticText();
        render();

        $('lang-select').addEventListener('change', e => setLang(/** @type {HTMLSelectElement} */ (e.target).value));
        document.querySelectorAll('[data-atlas-tz]').forEach(btn => btn.addEventListener('click', () =>
            setLocalTime(/** @type {HTMLElement} */ (btn).dataset.atlasTz === 'local')));
        document.querySelectorAll('[data-atlas-hours]').forEach(btn => {
            btn.addEventListener('click', () => {
                const h = Number(/** @type {HTMLElement} */ (btn).dataset.atlasHours);
                if (h === _hours) return;
                _hours = h;
                writeStorage(HOURS_STORAGE, String(h));
                syncToggles();
                load();
            });
        });
        document.querySelectorAll('[data-atlas-sort]').forEach(btn => {
            btn.addEventListener('click', () => {
                _sort = /** @type {HTMLElement} */ (btn).dataset.atlasSort;
                writeStorage(SORT_STORAGE, _sort);
                syncToggles();
                renderTable();
            });
        });
        // the rows move under a scroll, so the line and tooltip would point at the wrong one
        $('atlas-matching-table').addEventListener('scroll', () => clearCross(), { passive: true });
        // back on the tab after a while: fetch now rather than wait for the timer
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && _data
                && Date.now() - Date.parse(_data.server_time) > REFRESH_MS) load();
        });
        load();
    }

    return {
        init,
        startPageEntrances,
        // pure helpers, for frontend/tests/atlas-matching.test.js
        _test: { formatWait, waitTone, displayName, seriesStats, regionSummaries, sortRows, sparkSegments, bucketX, bucketAt, timeTicks,
                 waitTicks, detailPaths },
    };
})();

if (typeof document !== 'undefined' && document.getElementById('atlas-matching-app')) {
    window.EFTForge.atlasMatching.init();
}
