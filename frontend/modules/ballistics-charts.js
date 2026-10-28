window.EFTForge = window.EFTForge || {};

/* ============================================================
   BALLISTICS CHARTS
   The Ballistics Workbench's line charts, drawn as plain SVG: one y axis, up to three
   series, a crosshair that snaps to the nearest distance or shot and a tooltip listing
   every series there. The drop table and the armor simulator both draw through line().
============================================================ */

window.EFTForge.bwCharts = (function () {

    const SVG_NS = 'http://www.w3.org/2000/svg';
    // Picked with the dataviz palette checker against the panel surface: these three stay
    // apart for every pair, color blind or not. The first is the round being looked at.
    const SERIES_COLORS = ['#c98500', '#3987e5', '#d55181'];
    const HEIGHT = 240;
    const PAD = { top: 14, right: 16, bottom: 34, left: 52 };
    const LABEL_GAP = 12;

    // Each host's resize watcher and latest spec, so a resize redraws without the caller
    const _hosts = new WeakMap();

    /**
     * Draw a line chart into host, replacing whatever it held.
     * spec: {
     *   series: [{ name, color, points: [{x, y}], band?: [{x, lo, hi}] }],
     *   xLabel, yLabel, xFormat?(x), yFormat?(y), tipTitle?(x), tipValue?(y, series),
     *   refs?: [{ y, label }], focusX?, onPick?(x), dots?, yMin?, yMax?, integerX?
     * }
     */
    function line(host, spec) {
        let entry = _hosts.get(host);
        if (!entry) {
            entry = { spec: spec, width: 0, observer: null };
            _hosts.set(host, entry);
            if (typeof ResizeObserver !== 'undefined') {
                entry.observer = new ResizeObserver(function () {
                    const current = _hosts.get(host);
                    // A redrawn panel drops the old chart, so stop watching it
                    if (!host.isConnected) { entry.observer.disconnect(); _hosts.delete(host); return; }
                    if (current && Math.abs(host.clientWidth - current.width) > 1) _draw(host, current);
                });
                entry.observer.observe(host);
            }
        }
        entry.spec = spec;
        _draw(host, entry);
    }

    function _draw(host, entry) {
        const spec = entry.spec;
        const width = Math.max(260, host.clientWidth || 600);
        entry.width = host.clientWidth;
        const series = spec.series.filter(function (s) { return s.points.length > 0; });
        host.textContent = '';
        host.classList.add('bw-chart');
        if (series.length === 0) return;

        // End labels need room on the right once there is more than one line to tell apart,
        // as wide as the longest name so none of them gets cut short
        const labelled = series.length > 1;
        const labelW = labelled ? Math.max.apply(null, series.map(function (s) { return _textWidth(s.name, host); })) : 0;
        const pad = Object.assign({}, PAD, { right: labelled ? Math.max(74, Math.ceil(labelW) + 16) : PAD.right });
        const plotW = width - pad.left - pad.right;
        const plotH = HEIGHT - pad.top - pad.bottom;

        const xs = [];
        let yLo = Infinity;
        let yHi = -Infinity;
        series.forEach(function (s) {
            s.points.forEach(function (p) {
                if (xs.indexOf(p.x) === -1) xs.push(p.x);
                yLo = Math.min(yLo, p.y);
                yHi = Math.max(yHi, p.y);
            });
            (s.band || []).forEach(function (b) { yLo = Math.min(yLo, b.lo); yHi = Math.max(yHi, b.hi); });
        });
        (spec.refs || []).forEach(function (r) { yLo = Math.min(yLo, r.y); yHi = Math.max(yHi, r.y); });
        xs.sort(function (a, b) { return a - b; });
        if (spec.yMin != null) yLo = spec.yMin;
        if (spec.yMax != null) yHi = spec.yMax;
        if (yHi - yLo < 1e-9) { yHi += 1; yLo -= 1; }
        const yTicks = _niceTicks(yLo, yHi, 5);
        yLo = Math.min(yLo, yTicks[0]);
        yHi = Math.max(yHi, yTicks[yTicks.length - 1]);
        const xLo = xs[0];
        const xHi = xs[xs.length - 1] === xLo ? xLo + 1 : xs[xs.length - 1];
        const xTicks = spec.integerX
            ? _niceTicks(xLo, xHi, Math.min(8, xs.length)).filter(function (t) { return Number.isInteger(t); })
            : _niceTicks(xLo, xHi, 6);

        const sx = function (x) { return pad.left + (x - xLo) / (xHi - xLo) * plotW; };
        const sy = function (y) { return pad.top + (1 - (y - yLo) / (yHi - yLo)) * plotH; };
        const xFormat = spec.xFormat || _plain;
        const yFormat = spec.yFormat || _plain;

        const svg = _node('svg', { viewBox: '0 0 ' + width + ' ' + HEIGHT, width: width, height: HEIGHT, class: 'bw-chart-svg', 'aria-hidden': 'true' });

        yTicks.forEach(function (t) {
            if (t < yLo - 1e-9 || t > yHi + 1e-9) return;
            svg.appendChild(_node('line', { x1: pad.left, x2: pad.left + plotW, y1: sy(t), y2: sy(t), class: 'bw-chart-grid' }));
            svg.appendChild(_text(yFormat(t), { x: pad.left - 8, y: sy(t) + 4, class: 'bw-chart-tick', 'text-anchor': 'end' }));
        });
        xTicks.forEach(function (t) {
            if (t < xLo - 1e-9 || t > xHi + 1e-9) return;
            svg.appendChild(_text(xFormat(t), { x: sx(t), y: pad.top + plotH + 16, class: 'bw-chart-tick', 'text-anchor': 'middle' }));
        });
        svg.appendChild(_node('line', { x1: pad.left, x2: pad.left + plotW, y1: pad.top + plotH, y2: pad.top + plotH, class: 'bw-chart-axis' }));
        svg.appendChild(_text(spec.xLabel || '', { x: pad.left + plotW, y: HEIGHT - 4, class: 'bw-chart-axis-label', 'text-anchor': 'end' }));
        svg.appendChild(_text(spec.yLabel || '', { x: pad.left, y: pad.top - 4, class: 'bw-chart-axis-label', 'text-anchor': 'start' }));

        (spec.refs || []).forEach(function (r) {
            svg.appendChild(_node('line', { x1: pad.left, x2: pad.left + plotW, y1: sy(r.y), y2: sy(r.y), class: 'bw-chart-ref' }));
            if (r.label) svg.appendChild(_text(r.label, { x: pad.left + 6, y: sy(r.y) - 5, class: 'bw-chart-ref-label' }));
        });

        if (spec.focusX != null && spec.focusX >= xLo && spec.focusX <= xHi) {
            svg.appendChild(_node('line', { x1: sx(spec.focusX), x2: sx(spec.focusX), y1: pad.top, y2: pad.top + plotH, class: 'bw-chart-focus' }));
        }

        series.forEach(function (s) {
            if (!s.band || s.band.length < 2) return;
            const upper = s.band.map(function (b) { return sx(b.x) + ',' + sy(b.hi); });
            const lower = s.band.slice().reverse().map(function (b) { return sx(b.x) + ',' + sy(b.lo); });
            svg.appendChild(_node('polygon', { points: upper.concat(lower).join(' '), class: 'bw-chart-band', fill: s.color }));
        });
        // Drawn back to front, so the round being looked at sits on top
        series.slice().reverse().forEach(function (s) {
            svg.appendChild(_node('polyline', {
                points: s.points.map(function (p) { return sx(p.x) + ',' + sy(p.y); }).join(' '),
                class: 'bw-chart-line', stroke: s.color,
            }));
            if (spec.dots) {
                s.points.forEach(function (p) {
                    svg.appendChild(_node('circle', { cx: sx(p.x), cy: sy(p.y), r: 4, class: 'bw-chart-dot', fill: s.color }));
                });
            }
        });

        if (labelled) {
            // Each line's name at its last point, nudged apart so two close ends stay readable
            const ends = series.map(function (s) {
                const last = s.points[s.points.length - 1];
                return { s: s, x: sx(last.x), y: sy(last.y) };
            }).sort(function (a, b) { return a.y - b.y; });
            for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + LABEL_GAP);
            ends.forEach(function (end) {
                svg.appendChild(_text(end.s.name, { x: end.x + 8, y: Math.min(end.y + 4, pad.top + plotH), class: 'bw-chart-end-label' }));
            });
        }

        const hover = _node('g', { class: 'bw-chart-hover' });
        hover.style.display = 'none';
        const hair = _node('line', { y1: pad.top, y2: pad.top + plotH, class: 'bw-chart-hair' });
        hover.appendChild(hair);
        const markers = series.map(function (s) {
            const mark = _node('circle', { r: 4.5, class: 'bw-chart-marker', fill: s.color });
            hover.appendChild(mark);
            return mark;
        });
        svg.appendChild(hover);
        host.appendChild(svg);

        if (series.length > 1) host.insertBefore(_legend(series), svg);

        const tip = document.createElement('div');
        tip.className = 'bw-chart-tip';
        tip.style.display = 'none';
        host.appendChild(tip);

        const hit = _node('rect', { x: pad.left, y: pad.top, width: plotW, height: plotH, class: 'bw-chart-hit' });
        svg.appendChild(hit);
        svg.removeAttribute('aria-hidden');
        svg.setAttribute('tabindex', '0');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', (spec.yLabel || '') + ' / ' + (spec.xLabel || ''));

        let shown = -1;
        const show = function (index) {
            shown = index;
            const x = xs[index];
            hover.style.display = '';
            hair.setAttribute('x1', String(sx(x)));
            hair.setAttribute('x2', String(sx(x)));
            tip.textContent = '';
            const title = document.createElement('div');
            title.className = 'bw-chart-tip-title';
            title.textContent = spec.tipTitle ? spec.tipTitle(x) : xFormat(x);
            tip.appendChild(title);
            series.forEach(function (s, i) {
                const p = s.points.find(function (pt) { return pt.x === x; });
                markers[i].style.display = p ? '' : 'none';
                if (!p) return;
                markers[i].setAttribute('cx', String(sx(x)));
                markers[i].setAttribute('cy', String(sy(p.y)));
                const row = document.createElement('div');
                row.className = 'bw-chart-tip-row';
                const key = document.createElement('span');
                key.className = 'bw-chart-key';
                key.style.background = s.color;
                const value = document.createElement('strong');
                value.textContent = spec.tipValue ? spec.tipValue(p.y, s, p) : yFormat(p.y);
                const name = document.createElement('span');
                name.textContent = s.name;
                row.append(key, value, name);
                tip.appendChild(row);
            });
            tip.style.display = '';
            // Keep the tooltip beside the crosshair, flipping sides near the right edge
            const left = sx(x) + 14;
            const flip = left + tip.offsetWidth > width - 4;
            tip.style.left = (flip ? sx(x) - 14 - tip.offsetWidth : left) + 'px';
            tip.style.top = (svg.offsetTop + pad.top) + 'px';
        };
        const hide = function () {
            shown = -1;
            hover.style.display = 'none';
            tip.style.display = 'none';
        };
        const nearest = function (event) {
            const box = svg.getBoundingClientRect();
            const x = xLo + ((event.clientX - box.left) * (width / box.width) - pad.left) / plotW * (xHi - xLo);
            let best = 0;
            xs.forEach(function (value, i) { if (Math.abs(value - x) < Math.abs(xs[best] - x)) best = i; });
            return best;
        };
        hit.addEventListener('pointermove', function (event) { show(nearest(event)); });
        hit.addEventListener('pointerleave', hide);
        if (spec.onPick) {
            hit.classList.add('is-pickable');
            hit.addEventListener('click', function (event) { spec.onPick(xs[nearest(event)]); });
        }
        // Arrow keys walk the crosshair along the points, Enter picks the one it's on
        svg.addEventListener('keydown', function (event) {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Enter') return;
            event.preventDefault();
            if (event.key === 'Enter') {
                if (spec.onPick && shown !== -1) spec.onPick(xs[shown]);
                return;
            }
            let start = shown;
            if (start === -1) start = spec.focusX != null && xs.indexOf(spec.focusX) !== -1 ? xs.indexOf(spec.focusX) : 0;
            else start += event.key === 'ArrowLeft' ? -1 : 1;
            show(Math.min(Math.max(start, 0), xs.length - 1));
        });
        svg.addEventListener('blur', hide);
    }

    function _legend(series) {
        const legend = document.createElement('div');
        legend.className = 'bw-chart-legend';
        series.forEach(function (s) {
            const item = document.createElement('span');
            item.className = 'bw-chart-legend-item';
            const key = document.createElement('span');
            key.className = 'bw-chart-key';
            key.style.background = s.color;
            const name = document.createElement('span');
            name.textContent = s.name;
            item.append(key, name);
            legend.appendChild(item);
        });
        return legend;
    }

    // Round tick steps (1, 2 or 5 times a power of ten) covering lo..hi
    function _niceTicks(lo, hi, count) {
        const raw = (hi - lo) / Math.max(1, count);
        const power = Math.pow(10, Math.floor(Math.log10(raw)));
        const step = [1, 2, 5, 10].map(function (m) { return m * power; }).find(function (s) { return s >= raw; }) || 10 * power;
        const ticks = [];
        for (let t = Math.floor(lo / step) * step; t <= hi + step * 0.5; t += step) {
            ticks.push(Math.round(t / step) * step);
            if (ticks.length > 50) break;
        }
        if (ticks[ticks.length - 1] < hi) ticks.push(ticks[ticks.length - 1] + step);
        return ticks;
    }

    function _plain(value) {
        return String(Math.round(value * 100) / 100);
    }

    let _measure = null;

    // Width of an end label in the host's font, which .bw-chart-end-label sets at 11px
    function _textWidth(text, host) {
        if (!_measure) _measure = document.createElement('canvas').getContext('2d');
        if (!_measure) return String(text || '').length * 6.5;
        _measure.font = '11px ' + getComputedStyle(host).fontFamily;
        return _measure.measureText(String(text || '')).width;
    }

    function _node(tag, attrs) {
        const node = document.createElementNS(SVG_NS, tag);
        Object.keys(attrs).forEach(function (key) { node.setAttribute(key, String(attrs[key])); });
        return node;
    }

    function _text(content, attrs) {
        const node = _node('text', attrs);
        node.textContent = content;
        return node;
    }

    return { line: line, SERIES_COLORS: SERIES_COLORS };

}());
