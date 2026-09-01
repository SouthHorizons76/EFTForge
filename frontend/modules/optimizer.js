window.EFTForge = window.EFTForge || {};

/* ============================================================
   WEAPON OPTIMIZER
   Optimize and Gunsmith tabs. Explore (Pareto curves) is a separate
   follow-up tab, added once its backend solver piece exists - see
   backend/optimizer/solver.py's module docstring.

   Entry point is the gradient edge-tab on the attachment placeholder
   panel (see #optimizer-edge-tab in index.html), not a header nav
   button. Opens this drawer, same show/hide pattern as Ammo Ballistics
   and the Leaderboard (#optimizer-overlay / #optimizer-backdrop).

   "Use this build" applies the result to the CURRENT tab in place via
   loadBuildFromPayload() and closes the drawer - it does not open a
   new tab. That's a deliberate difference from the external ?build=
   URL import flow (importBuildFromCode -> createTabFromPayload), which
   is a separate, unrelated hand-off path.
============================================================ */

window.EFTForge.optimizer = (function () {

    // Gunsmith tasks are being re-curated for the current wipe - the backend
    // (GET /build/gunsmith-tasks, POST /build/gunsmith-solve) and this tab's
    // UI are fully implemented and tested, just hidden from players until the
    // task data is ready. Flip this back to true to re-expose it.
    const GUNSMITH_ENABLED = false;

    let _activeTab = 'optimize';  // 'optimize' | 'gunsmith'
    let _result = null;   // last successful solve response, or null
    let _solving = false;
    let _error = null;

    let _gunsmithTasks = null;      // cached GET /build/gunsmith-tasks response
    let _gunsmithTasksPromise = null;

    // Priority weights, 0-100 each. They don't need to sum to 100 - the solver
    // (milp.py's _weighted_objective) only compares their ratio after scaling
    // each axis by its own price/recoil range, so this is purely a display
    // convention borrowed from the reference optimizer's ternary plot.
    let _ergoWeight = 33;
    let _recoilWeight = 34;
    let _priceWeight = 33;
    let _useEvoErgo = false;
    let _weightUiMode = localStorage.getItem('eftforge-optimizer-weight-ui') || 'triangle'; // 'triangle' | 'sliders'
    let _fleaAvailable = true;
    let _preventOverswing = false;

    // Mod Filter (GET /build/mods) - cached per weapon+lang so switching tabs
    // or re-rendering doesn't refetch.
    let _modFilterData = null;      // { weaponId, lang, mods: [{id,name,icon}] }
    let _modFilterPromise = null;
    let _includedModIds = [];
    let _excludedModIds = [];
    let _modSearch = '';

    // Collapsible section state, matching the reference optimizer's Collapse
    // defaultActiveKey behavior (Weight Adjustment and Hard Constraints start
    // open; Mod Filter and Market & Trader Access start collapsed).
    const _sectionOpen = { weight: true, constraints: true, modFilter: false, market: false };

    function _sectionHeaderHtml(id, titleKey) {
        return `
            <div class="optimizer-section-header" data-section-toggle="${id}">
                <span class="optimizer-section-chevron">&#9656;</span>
                <span class="optimizer-section-title">${_t(titleKey)}</span>
                <button type="button" class="optimizer-section-reset-btn" data-section-reset="${id}" title="${_escape(_t('optimizer.resetSection'))}">&#8635;</button>
            </div>
        `;
    }

    function _toggleSection(id) {
        _sectionOpen[id] = !_sectionOpen[id];
        const section = document.querySelector(`.optimizer-section[data-section="${id}"]`);
        const body = section?.querySelector('[data-section-body]');
        if (section) section.classList.toggle('open', _sectionOpen[id]);
        if (body) body.style.display = _sectionOpen[id] ? '' : 'none';
    }

    function _wireSection(id, onReset) {
        document.querySelector(`[data-section-toggle="${id}"]`)?.addEventListener('click', () => _toggleSection(id));
        document.querySelector(`[data-section-reset="${id}"]`)?.addEventListener('click', (ev) => {
            ev.stopPropagation();
            onReset();
        });
    }

    // Lets the user bail out of a slow solve instead of being stuck staring
    // at "Solving...". This only abandons the fetch client-side - a solve
    // already running on the server keeps running (a synchronous HiGHS call
    // can't be interrupted mid-flight from outside), it just stops waiting
    // on it and frees the drawer back up.
    let _abortController = null;

    function _t(key) { return window.t ? window.t(key) : key; }

    /* ===========================
       PUBLIC API
    =========================== */

    function showPanel() {
        const overlay = document.getElementById('optimizer-overlay');
        const backdrop = document.getElementById('optimizer-backdrop');
        if (!overlay) return;

        overlay.classList.add('visible');
        if (backdrop) backdrop.classList.add('visible');
        document.getElementById('main-container')?.setAttribute('inert', '');
        if (document.activeElement) document.activeElement.blur();

        _result = null;
        _error = null;
        _render();
    }

    function hidePanel() {
        const overlay = document.getElementById('optimizer-overlay');
        const backdrop = document.getElementById('optimizer-backdrop');
        if (overlay) overlay.classList.remove('visible');
        if (backdrop) backdrop.classList.remove('visible');
        document.getElementById('main-container')?.removeAttribute('inert');
        // Otherwise a solve left running behind a closed drawer could still
        // resolve later and pop a stale result into a future, unrelated session.
        _abortController?.abort();
        _resultImgAbort?.abort();
    }

    function onLangChange() {
        const label = document.getElementById('optimizer-edge-tab-label');
        if (label) label.textContent = _t('optimizer.title');

        // The panel header ships hardcoded as "OPTIMIZER" in index.html; sync it
        // with the active language here (this also runs from init() on first paint).
        const panelTitle = document.getElementById('optimizer-panel-title');
        if (panelTitle) panelTitle.textContent = _t('optimizer.title');

        const overlay = document.getElementById('optimizer-overlay');
        if (!overlay || !overlay.classList.contains('visible')) return;
        _render();
    }

    function init() {
        const closeBtn = document.getElementById('optimizer-close-btn');
        if (closeBtn) closeBtn.addEventListener('click', hidePanel);
        const backdrop = document.getElementById('optimizer-backdrop');
        if (backdrop) backdrop.addEventListener('click', hidePanel);

        // A few flows (build-manager.js's publish-confirm screen and
        // _restoreNormalPlaceholder) rebuild #attachment-placeholder's
        // innerHTML wholesale and don't know about the edge-tab, so it would
        // otherwise get wiped out the first time either of those runs.
        // Watching and re-appending here keeps this self-contained instead of
        // patching every current (and future) place that rebuilds the panel.
        const placeholder = document.getElementById('attachment-placeholder');
        if (placeholder) {
            _ensureEdgeTab(placeholder);
            new MutationObserver(() => _ensureEdgeTab(placeholder)).observe(placeholder, { childList: true });
        }
        onLangChange(); // sync the edge-tab label with the saved language preference on first paint
    }

    function _ensureEdgeTab(placeholder) {
        if (document.getElementById('optimizer-edge-tab')) return;
        const tab = document.createElement('div');
        tab.id = 'optimizer-edge-tab';
        tab.className = 'optimizer-edge-tab';
        tab.addEventListener('click', showPanel);
        tab.innerHTML = `<span class="optimizer-edge-tab-label" id="optimizer-edge-tab-label">${_t('optimizer.title')}</span>`;
        placeholder.appendChild(tab);
    }

    /* ===========================
       SHARED HELPERS
    =========================== */

    function _creditHtml() {
        const link = `<a href="https://ahaimk01.github.io/tarkov-weapon-optimizer/" target="_blank" rel="noopener noreferrer">${_t('optimizer.creditLinkText')}</a>`;
        return window.tFmt ? window.tFmt('optimizer.creditText', { link }) : '';
    }

    function _escape(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }

    function _switchTab(tab) {
        _activeTab = tab;
        _result = null;
        _error = null;
        _render();
    }

    /* ===========================
       ROOT RENDER (tab strip + active tab's form)
    =========================== */

    function _render() {
        const body = document.getElementById('optimizer-panel-body');
        if (!body) return;

        if (!GUNSMITH_ENABLED) _activeTab = 'optimize';

        const tabStripHtml = GUNSMITH_ENABLED ? `
            <div class="modal-row">
                <button class="toggle-btn ${_activeTab === 'optimize' ? 'active' : ''}" id="optimizer-tab-optimize">${_t('optimizer.tabOptimize')}</button>
                <button class="toggle-btn ${_activeTab === 'gunsmith' ? 'active' : ''}" id="optimizer-tab-gunsmith">${_t('optimizer.tabGunsmith')}</button>
            </div>
        ` : '';

        body.innerHTML = `
            ${tabStripHtml}
            <div id="optimizer-tab-content"></div>
        `;

        // Lives outside .optimizer-panel-body as a fixed watermark (see styles.css
        // .optimizer-credit), so it's set once here rather than rebuilt on every
        // tab switch along with the rest of the panel body.
        const credit = document.getElementById('optimizer-credit');
        if (credit) credit.innerHTML = _creditHtml();

        if (GUNSMITH_ENABLED) {
            document.getElementById('optimizer-tab-optimize').addEventListener('click', () => _switchTab('optimize'));
            document.getElementById('optimizer-tab-gunsmith').addEventListener('click', () => _switchTab('gunsmith'));
        }

        if (_activeTab === 'optimize') _renderOptimizeTab();
        else _renderGunsmithTab();
    }

    /* ===========================
       OPTIMIZE TAB
    =========================== */

    /* ---------------------------
       Ternary weight-control widget
       Layout math ported from the reference optimizer's TernaryPlot.tsx.
    --------------------------- */

    const TP_WIDTH = 300, TP_PAD_X = 50, TP_PAD_TOP = 38, TP_PAD_BOTTOM = 25;
    const TP_SIDE = TP_WIDTH - TP_PAD_X * 2;
    const TP_TRI_H = TP_SIDE * (Math.sqrt(3) / 2);
    const TP_HEIGHT = TP_PAD_TOP + TP_TRI_H + TP_PAD_BOTTOM;
    // Extend the viewBox horizontally (symmetrically, so the triangle stays centered)
    // so the outer corner labels don't clip - the right one ("Recoil" / the wider CJK
    // 后坐力) sits past the triangle's right vertex and was running off the edge.
    const TP_VIEW_X = -16;
    const TP_VIEW_W = TP_WIDTH - 2 * TP_VIEW_X;
    const TP_TOP = { x: TP_WIDTH / 2, y: TP_PAD_TOP };
    const TP_LEFT = { x: TP_PAD_X, y: TP_PAD_TOP + TP_TRI_H };
    const TP_RIGHT = { x: TP_WIDTH - TP_PAD_X, y: TP_PAD_TOP + TP_TRI_H };

    function _tpToSvg(ergo, recoil, price) {
        const total = ergo + recoil + price;
        const e = ergo / total, r = recoil / total, p = price / total;
        return {
            x: e * TP_TOP.x + r * TP_RIGHT.x + p * TP_LEFT.x,
            y: e * TP_TOP.y + r * TP_RIGHT.y + p * TP_LEFT.y,
        };
    }

    function _tpToBarycentric(x, y) {
        const x1 = TP_TOP.x - TP_LEFT.x, y1 = TP_TOP.y - TP_LEFT.y;
        const x2 = TP_RIGHT.x - TP_LEFT.x, y2 = TP_RIGHT.y - TP_LEFT.y;
        const xp = x - TP_LEFT.x, yp = y - TP_LEFT.y;
        const det = x1 * y2 - x2 * y1;
        const e = (xp * y2 - yp * x2) / det;
        const r = (x1 * yp - y1 * xp) / det;
        const p = 1 - e - r;
        return {
            e: Math.max(0, Math.min(1, e)),
            r: Math.max(0, Math.min(1, r)),
            p: Math.max(0, Math.min(1, p)),
        };
    }

    function _tpGridLinesHtml() {
        const lines = [];
        for (let i = 1; i < 10; i++) {
            const t = i / 10;
            const segs = [
                [_tpToSvg(1 - t, t, 0), _tpToSvg(1 - t, 0, t)],
                [_tpToSvg(t, 0, 1 - t), _tpToSvg(0, t, 1 - t)],
                [_tpToSvg(t, 1 - t, 0), _tpToSvg(0, 1 - t, t)],
            ];
            for (const [a, b] of segs) {
                lines.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#333" stroke-width="0.5" />`);
            }
        }
        return lines.join('');
    }

    function _ergoAxisLabel() {
        return _useEvoErgo ? _t('optimizer.evoErgoShort') : _t('optimizer.ergonomics');
    }

    function _setWeights(ergo, recoil, price) {
        _ergoWeight = ergo;
        _recoilWeight = recoil;
        _priceWeight = price;
        _updateWeightVisuals();
    }

    function _updateWeightVisuals() {
        const total = _ergoWeight + _recoilWeight + _priceWeight;
        const pctErgo = total > 0 ? Math.round(_ergoWeight / total * 100) : 33;
        const pctRecoil = total > 0 ? Math.round(_recoilWeight / total * 100) : 34;
        const pctPrice = total > 0 ? 100 - pctErgo - pctRecoil : 33;

        const point = document.getElementById('optimizer-tp-point');
        if (point) {
            const svgPos = _tpToSvg(_ergoWeight, _recoilWeight, _priceWeight);
            point.setAttribute('cx', svgPos.x);
            point.setAttribute('cy', svgPos.y);
        }
        const pctErgoEl = document.getElementById('optimizer-tp-pct-ergo');
        const pctRecoilEl = document.getElementById('optimizer-tp-pct-recoil');
        const pctPriceEl = document.getElementById('optimizer-tp-pct-price');
        if (pctErgoEl) pctErgoEl.textContent = `${pctErgo}%`;
        if (pctRecoilEl) pctRecoilEl.textContent = `${pctRecoil}%`;
        if (pctPriceEl) pctPriceEl.textContent = `${pctPrice}%`;

        const ergoSlider = document.getElementById('optimizer-ergo-weight');
        const recoilSlider = document.getElementById('optimizer-recoil-weight');
        const priceSlider = document.getElementById('optimizer-price-weight');
        if (ergoSlider) ergoSlider.value = _ergoWeight;
        if (recoilSlider) recoilSlider.value = _recoilWeight;
        if (priceSlider) priceSlider.value = _priceWeight;
        const ergoLabel = document.getElementById('optimizer-ergo-weight-label');
        const recoilLabel = document.getElementById('optimizer-recoil-weight-label');
        const priceLabel = document.getElementById('optimizer-price-weight-label');
        if (ergoLabel) ergoLabel.textContent = `${_ergoAxisLabel()}: ${_ergoWeight} (${pctErgo}%)`;
        if (recoilLabel) recoilLabel.textContent = `${_t('optimizer.recoil')}: ${_recoilWeight} (${pctRecoil}%)`;
        if (priceLabel) priceLabel.textContent = `${_t('optimizer.price')}: ${_priceWeight} (${pctPrice}%)`;
    }

    function _tpApplyPoint(clientX, clientY) {
        const svg = document.getElementById('optimizer-tp-svg');
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const x = TP_VIEW_X + (clientX - rect.left) * (TP_VIEW_W / rect.width);
        const y = (clientY - rect.top) * (TP_HEIGHT / rect.height);
        const { e, r, p } = _tpToBarycentric(x, y);
        const total = e + r + p;
        const ergoNorm = Math.round((e / total) * 100);
        const recoilNorm = Math.round((r / total) * 100);
        const priceNorm = 100 - ergoNorm - recoilNorm;
        _setWeights(ergoNorm, recoilNorm, priceNorm);
    }

    function _tpHandleMouseDown(ev) {
        ev.preventDefault();
        const svg = document.getElementById('optimizer-tp-svg');
        if (svg) svg.style.cursor = 'grabbing';
        _tpApplyPoint(ev.clientX, ev.clientY);
        const handleMove = (moveEv) => _tpApplyPoint(moveEv.clientX, moveEv.clientY);
        const handleUp = () => {
            if (svg) svg.style.cursor = 'crosshair';
            window.removeEventListener('mousemove', handleMove);
            window.removeEventListener('mouseup', handleUp);
        };
        window.addEventListener('mousemove', handleMove);
        window.addEventListener('mouseup', handleUp);
    }

    function _weightWidgetHtml() {
        if (_weightUiMode === 'sliders') {
            return `
                <div class="optimizer-weight-slider-row">
                    <span class="stat-label" id="optimizer-ergo-weight-label"></span>
                    <input type="range" id="optimizer-ergo-weight" min="0" max="100" step="1" value="${_ergoWeight}">
                </div>
                <div class="optimizer-weight-slider-row">
                    <span class="stat-label" id="optimizer-recoil-weight-label"></span>
                    <input type="range" id="optimizer-recoil-weight" min="0" max="100" step="1" value="${_recoilWeight}">
                </div>
                <div class="optimizer-weight-slider-row">
                    <span class="stat-label" id="optimizer-price-weight-label"></span>
                    <input type="range" id="optimizer-price-weight" min="0" max="100" step="1" value="${_priceWeight}">
                </div>
            `;
        }
        return `
            <svg id="optimizer-tp-svg" viewBox="${TP_VIEW_X} 0 ${TP_VIEW_W} ${TP_HEIGHT}" class="optimizer-ternary-svg">
                <polygon points="${TP_TOP.x},${TP_TOP.y} ${TP_RIGHT.x},${TP_RIGHT.y} ${TP_LEFT.x},${TP_LEFT.y}"
                    fill="#111" stroke="#444" stroke-width="1.5" />
                <g>${_tpGridLinesHtml()}</g>
                <g class="optimizer-tp-labels">
                    <text x="${TP_TOP.x}" y="${TP_TOP.y - 22}" text-anchor="middle" class="optimizer-tp-pct optimizer-tp-ergo" id="optimizer-tp-pct-ergo"></text>
                    <text x="${TP_TOP.x}" y="${TP_TOP.y - 6}" text-anchor="middle" class="optimizer-tp-corner optimizer-tp-ergo">${_ergoAxisLabel()}</text>
                    <text x="${TP_RIGHT.x + 15}" y="${TP_RIGHT.y + 4}" class="optimizer-tp-corner optimizer-tp-recoil">${_t('optimizer.recoil')}</text>
                    <text x="${TP_RIGHT.x + 15}" y="${TP_RIGHT.y + 18}" class="optimizer-tp-pct optimizer-tp-recoil" id="optimizer-tp-pct-recoil"></text>
                    <text x="${TP_LEFT.x - 15}" y="${TP_LEFT.y + 4}" text-anchor="end" class="optimizer-tp-corner optimizer-tp-price">${_t('optimizer.price')}</text>
                    <text x="${TP_LEFT.x - 15}" y="${TP_LEFT.y + 18}" text-anchor="end" class="optimizer-tp-pct optimizer-tp-price" id="optimizer-tp-pct-price"></text>
                </g>
                <circle id="optimizer-tp-point" r="6" class="optimizer-tp-point" />
            </svg>
        `;
    }

    function _renderWeightWidget() {
        const el = document.getElementById('optimizer-weight-widget');
        if (!el) return;
        el.innerHTML = _weightWidgetHtml();

        if (_weightUiMode === 'sliders') {
            document.getElementById('optimizer-ergo-weight').addEventListener('input', (e) => _setWeights(Number(e.target.value), _recoilWeight, _priceWeight));
            document.getElementById('optimizer-recoil-weight').addEventListener('input', (e) => _setWeights(_ergoWeight, Number(e.target.value), _priceWeight));
            document.getElementById('optimizer-price-weight').addEventListener('input', (e) => _setWeights(_ergoWeight, _recoilWeight, Number(e.target.value)));
        } else {
            document.getElementById('optimizer-tp-svg').addEventListener('mousedown', _tpHandleMouseDown);
        }
        _updateWeightVisuals();
    }

    function _setWeightUiMode(mode) {
        if (mode === _weightUiMode) return;
        _weightUiMode = mode;
        localStorage.setItem('eftforge-optimizer-weight-ui', mode);
        document.getElementById('optimizer-weight-ui-sliders-btn')?.classList.toggle('active', mode === 'sliders');
        document.getElementById('optimizer-weight-ui-triangle-btn')?.classList.toggle('active', mode === 'triangle');
        _renderWeightWidget();
    }

    function _setUseEvoErgo(value) {
        _useEvoErgo = value;
        document.getElementById('optimizer-evo-ergo-toggle')?.classList.toggle('active', value);
        _renderWeightWidget();
    }

    function _setFleaAvailable(value) {
        _fleaAvailable = value;
        document.getElementById('optimizer-flea-toggle')?.classList.toggle('active', value);
        _refreshStatRanges();
    }

    // Budget's achievable range depends on which items are purchasable at all
    // right now, so a Flea/Trader Access change invalidates the cached
    // GET /build/stat-ranges response and re-applies the fresh one.
    function _refreshStatRanges() {
        const weaponId = window.EFTForge.state?.currentGun?.id;
        if (!weaponId) return;
        _statRanges = null;
        _exactMoaFloor = null;
        _fetchStatRanges(weaponId).then(ranges => {
            _applyStatRanges(ranges);
            if (_useExactMoaFloor && _constraintState.maxSpread?.on) _fetchExactMoaFloor();
            else _renderConstraints();
        }).catch(() => {});
    }

    function _setPreventOverswing(value) {
        _preventOverswing = value;
        document.getElementById('optimizer-overswing-toggle')?.classList.toggle('active', value);
    }

    /* ---------------------------
       Trader Access - reuses the price panel's own trader-levels widget
       (stats-panel.js) so a change here updates the exact same
       EFTForge.state.traderLevels everywhere else, instead of maintaining a
       second copy of that state.
    --------------------------- */

    function _renderTraderAccessWidget() {
        const el = document.getElementById('optimizer-trader-access-widget');
        if (!el) return;
        el.innerHTML = traderLevelsBodyHtml();
        attachTraderLevelsListeners(el);
    }

    function onTraderLevelsChange() {
        _renderTraderAccessWidget();
        _refreshStatRanges();
    }

    /* ---------------------------
       Mod Filter - force-include/exclude a specific item from the solve,
       via GET /build/mods (reachable mods for the current weapon).
    --------------------------- */

    function _fetchModFilterData(weaponId) {
        const lang = (window.EFTForge.state && window.EFTForge.state.lang) || 'en';
        if (_modFilterData && _modFilterData.weaponId === weaponId && _modFilterData.lang === lang) {
            return Promise.resolve(_modFilterData);
        }
        if (_modFilterPromise) return _modFilterPromise;
        _modFilterPromise = fetch(`${EFTForge.config.API_BASE}/build/mods?weapon_id=${weaponId}&lang=${lang}`)
            .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
            .then(data => {
                _modFilterData = { weaponId, lang, mods: data.mods };
                return _modFilterData;
            })
            .finally(() => { _modFilterPromise = null; });
        return _modFilterPromise;
    }

    function _filterTagsHtml(ids, lookup, cls) {
        return ids.map(id => {
            const name = lookup.find(x => x.id === id)?.name || id;
            const sign = cls === 'include' ? '+' : '-';
            return `<span class="optimizer-filter-tag optimizer-filter-tag-${cls}" data-remove-id="${_escape(id)}">${sign} ${_escape(name)} &times;</span>`;
        }).join('');
    }

    function _modFilterHtml() {
        const modTags = _filterTagsHtml(_includedModIds, _modFilterData.mods, 'include')
            + _filterTagsHtml(_excludedModIds, _modFilterData.mods, 'exclude');

        return `
            <div class="optimizer-filter-group">
                <span class="optimizer-filter-hint">${_t('optimizer.filterByItemHint')}</span>
                <div class="optimizer-filter-search-wrap">
                    <input type="text" class="optimizer-input" id="optimizer-mod-search" placeholder="${_t('optimizer.searchMods')}" autocomplete="off" value="${_escape(_modSearch)}">
                    <div class="optimizer-filter-results" id="optimizer-mod-results"></div>
                </div>
                <div class="optimizer-filter-tags">${modTags}</div>
            </div>
        `;
    }

    function _renderModResults() {
        const el = document.getElementById('optimizer-mod-results');
        if (!el) return;
        const q = _modSearch.trim().toLowerCase();
        if (!q) { el.innerHTML = ''; return; }
        const matches = _modFilterData.mods
            .filter(m => !_includedModIds.includes(m.id) && !_excludedModIds.includes(m.id) && (m.name || '').toLowerCase().includes(q))
            .slice(0, 8);
        if (!matches.length) {
            el.innerHTML = `<div class="optimizer-filter-empty">${_t('optimizer.noMatches')}</div>`;
            return;
        }
        el.innerHTML = matches.map(m => `
            <div class="optimizer-filter-result-row">
                <img class="optimizer-filter-result-icon" src="${_escape(m.icon || '')}" onerror="this.style.visibility='hidden'">
                <span>${_escape(m.name)}</span>
                <span class="optimizer-filter-result-actions">
                    <button type="button" class="optimizer-filter-add-btn optimizer-filter-add-include" data-add-include="${_escape(m.id)}">+</button>
                    <button type="button" class="optimizer-filter-add-btn optimizer-filter-add-exclude" data-add-exclude="${_escape(m.id)}">-</button>
                </span>
            </div>
        `).join('');
        el.querySelectorAll('[data-add-include]').forEach(btn => btn.addEventListener('click', () => {
            _includedModIds.push(btn.dataset.addInclude);
            _modSearch = '';
            _renderModFilterWidget();
        }));
        el.querySelectorAll('[data-add-exclude]').forEach(btn => btn.addEventListener('click', () => {
            _excludedModIds.push(btn.dataset.addExclude);
            _modSearch = '';
            _renderModFilterWidget();
        }));
    }

    function _renderModFilterWidget() {
        const el = document.getElementById('optimizer-mod-filter-widget');
        if (!el) return;

        const weaponId = window.EFTForge.state?.currentGun?.id;
        if (!_modFilterData || _modFilterData.weaponId !== weaponId) {
            el.innerHTML = `<div class="optimizer-filter-loading">${_t('optimizer.loadingMods')}</div>`;
            if (!weaponId) return;
            _fetchModFilterData(weaponId).then(() => _renderModFilterWidget()).catch(() => {
                el.innerHTML = `<div class="optimizer-error">${_t('optimizer.modsLoadFailed')}</div>`;
            });
            return;
        }

        el.innerHTML = _modFilterHtml();

        const modInput = document.getElementById('optimizer-mod-search');
        modInput.addEventListener('input', () => { _modSearch = modInput.value; _renderModResults(); });
        _renderModResults();

        el.querySelectorAll('[data-remove-id]').forEach(tag => tag.addEventListener('click', () => {
            const id = tag.dataset.removeId;
            _includedModIds = _includedModIds.filter(m => m !== id);
            _excludedModIds = _excludedModIds.filter(m => m !== id);
            _renderModFilterWidget();
        }));
    }

    /* ---------------------------
       Hard constraints - on/off toggle + slider, mirroring the reference
       optimizer's WeightAdjuster.tsx constraints panel. Fixed ranges here
       match the reference exactly (it doesn't compute these dynamically
       either) - only min_mag_capacity and max_moa get a per-weapon dynamic
       range there, via availableMagCapacities/moaRange in its App.tsx.
    --------------------------- */

    const CONSTRAINT_DEFS = [
        { key: 'budget', label: 'optimizer.budget', min: 10000, max: 2000000, step: 10000, default: 200000, unit: '₽' },
        { key: 'minErgo', label: 'optimizer.minErgo', min: 1, max: 100, step: 1, default: 40 },
    ];

    let _constraintState = {};
    let _magCapacityValues = null;   // [10, 20, 30, ...] - GET /build/stat-ranges' mag_capacity.values, sorted
    let _moaRange = null;            // { min, max } - GET /build/stat-ranges' fast/approximate moa range
    let _exactMoaFloor = null;       // number | null - GET /build/moa-floor result, fetched on demand
    let _fetchingMoaFloor = false;
    let _useExactMoaFloor = localStorage.getItem('eftforge-optimizer-exact-moa-floor') !== 'false';
    let _statRanges = null;          // { weaponId, ranges } - GET /build/stat-ranges response, cached per weapon
    let _statRangesPromise = null;

    function _resetConstraintValues() {
        _constraintState = {};
        for (const def of CONSTRAINT_DEFS) _constraintState[def.key] = { on: false, value: def.default };
        _constraintState.minMag = { on: false, value: 0 };
        _constraintState.maxSpread = { on: false, value: 0 };
    }

    // Full reset for opening the panel on a (possibly different) weapon -
    // also drops the cached per-weapon ranges, unlike _resetConstraintValues()
    // which the "reset section" button uses (same weapon, no need to refetch).
    function _resetConstraintState() {
        _resetConstraintValues();
        _magCapacityValues = null;
        _moaRange = null;
        _exactMoaFloor = null;
        _fetchingMoaFloor = false;
    }

    function _applyStatRanges(ranges) {
        _magCapacityValues = (ranges && ranges.mag_capacity && ranges.mag_capacity.values) || null;
        _moaRange = (ranges && ranges.moa) || null;
        // If the user toggled either constraint on before this fetch resolved,
        // it was left at its placeholder value (0) - backfill it now so the
        // slider and its readout agree instead of showing "0" at rest.
        if (_constraintState.minMag?.on && !_constraintState.minMag.value && _magCapacityValues?.length) {
            _constraintState.minMag.value = _magCapacityValues[0];
        }
        if (_constraintState.maxSpread?.on && !_constraintState.maxSpread.value && _moaRange) {
            _constraintState.maxSpread.value = _moaRange.max;
        }
    }

    function _fetchStatRanges(weaponId) {
        if (_statRanges && _statRanges.weaponId === weaponId) return Promise.resolve(_statRanges.ranges);
        if (_statRangesPromise) return _statRangesPromise;
        const state = window.EFTForge.state || {};
        const body = {
            weapon_id: weaponId,
            trader_levels: state.traderLevels || null,
            flea_available: _fleaAvailable,
        };
        _statRangesPromise = fetch(`${EFTForge.config.API_BASE}/build/stat-ranges`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
            .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
            .then(data => {
                _statRanges = { weaponId, ranges: data.ranges };
                return _statRanges.ranges;
            })
            .finally(() => { _statRangesPromise = null; });
        return _statRangesPromise;
    }

    function _fetchExactMoaFloor() {
        const weaponId = window.EFTForge.state?.currentGun?.id;
        if (!weaponId || _fetchingMoaFloor) return;
        _fetchingMoaFloor = true;
        _refreshMoaSliderIfMounted();
        const state = window.EFTForge.state || {};
        const body = {
            weapon_id: weaponId,
            trader_levels: state.traderLevels || null,
            flea_available: _fleaAvailable,
        };
        fetch(`${EFTForge.config.API_BASE}/build/moa-floor`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
            .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
            .then(data => { _exactMoaFloor = data.floor; })
            .catch(() => { _exactMoaFloor = null; })
            .finally(() => { _fetchingMoaFloor = false; _refreshMoaSliderIfMounted(); });
    }

    // Refreshes just the MOA slider's bounds/ticks (and its spinner) in place so a
    // floor fetch never tears down and rebuilds the surrounding toggle pills - doing
    // so would replace their DOM nodes mid-click and kill the compare-toggle's CSS
    // transition (it animates a class change on a persisting element, not a fresh one).
    function _refreshMoaSliderIfMounted() {
        const detail = document.querySelector('[data-constraint-detail="maxSpread"]');
        const wrap = detail?.querySelector('[data-moa-slider-wrap]');
        if (wrap) _renderMoaSliderWrap(detail);
        else _renderConstraints();
    }

    function _moaSliderMin() {
        if (_useExactMoaFloor && _exactMoaFloor != null) return _exactMoaFloor;
        return _moaRange ? _moaRange.min : 0;
    }

    // Each constraint's markup is split into a static toggle-row (the compare-toggle
    // pill, never rebuilt after its first render) and a `data-constraint-detail`
    // slot that gets its innerHTML swapped on toggle. Keeping the pill itself alive
    // across clicks is what lets its CSS transition animate the on/off state change.

    function _plainConstraintHtml(def) {
        const state = _constraintState[def.key];
        return `
            <div class="optimizer-constraint-item">
                <div class="optimizer-toggle-row">
                    <span class="stat-label">${_t(def.label)}</span>
                    <button type="button" class="compare-toggle${state.on ? ' active' : ''}" data-constraint="${def.key}">
                        <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                    </button>
                </div>
                <div data-constraint-detail="${def.key}">${_plainConstraintDetailHtml(def)}</div>
            </div>
        `;
    }

    function _plainConstraintDetailHtml(def) {
        const state = _constraintState[def.key];
        if (!state.on) return '';
        return `
            <div class="optimizer-constraint-slider-row" data-constraint-slider="${def.key}">
                <div class="optimizer-slider-track">
                    <input type="range" min="${def.min}" max="${def.max}" step="${def.step}" value="${state.value}">
                    <div class="optimizer-slider-ticks"><span>${def.min}</span><span>${def.max}</span></div>
                </div>
                <input type="number" class="optimizer-input" min="${def.min}" max="${def.max}" step="${def.step}" value="${state.value}">
                ${def.unit ? `<span class="input-suffix">${def.unit}</span>` : ''}
            </div>
        `;
    }

    function _wirePlainConstraintDetail(def, detail) {
        const row = detail.querySelector(`[data-constraint-slider="${def.key}"]`);
        if (!row) return;
        const [range, number] = row.querySelectorAll('input');
        range.addEventListener('input', () => _setConstraintValue(def.key, Number(range.value)));
        number.addEventListener('input', () => _setConstraintValue(def.key, Number(number.value)));
    }

    function _minMagHtml() {
        const state = _constraintState.minMag;
        return `
            <div class="optimizer-constraint-item">
                <div class="optimizer-toggle-row">
                    <span class="stat-label">${_t('optimizer.minMagCapacity')}</span>
                    <button type="button" class="compare-toggle${state.on ? ' active' : ''}" data-constraint="minMag">
                        <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                    </button>
                </div>
                <div data-constraint-detail="minMag">${_minMagDetailHtml()}</div>
            </div>
        `;
    }

    function _minMagDetailHtml() {
        const state = _constraintState.minMag;
        if (!state.on) return '';
        if (!_magCapacityValues) {
            return `<div class="optimizer-filter-loading">${_t('optimizer.loadingMods')}</div>`;
        }
        if (_magCapacityValues.length <= 1) {
            const only = _magCapacityValues[0] || 0;
            return `<div class="optimizer-constraint-static">${only} ${_t('optimizer.roundsUnit')}</div>`;
        }
        const minVal = _magCapacityValues[0];
        const maxVal = _magCapacityValues[_magCapacityValues.length - 1];
        let index = _magCapacityValues.indexOf(state.value);
        if (index === -1) {
            let closestIdx = 0;
            let closestDiff = Infinity;
            for (let i = 0; i < _magCapacityValues.length; i++) {
                const diff = Math.abs(_magCapacityValues[i] - state.value);
                if (diff < closestDiff) {
                    closestDiff = diff;
                    closestIdx = i;
                }
            }
            index = closestIdx;
        }
        return `
            <div class="optimizer-constraint-slider-row" data-constraint-slider="minMag" data-mag-slider>
                <div class="optimizer-slider-track">
                    <input type="range" min="0" max="${_magCapacityValues.length - 1}" step="1" value="${index}">
                    <div class="optimizer-slider-ticks" data-mag-ticks>
                        ${_magCapacityValues.map((v, i) => `<span class="${i === index ? 'active' : ''}">${v}</span>`).join('')}
                    </div>
                </div>
                <input type="number" class="optimizer-input" min="${minVal}" max="${maxVal}" step="1" value="${state.value || minVal}">
                <span class="input-suffix">${_t('optimizer.roundsUnit')}</span>
            </div>
        `;
    }

    function _wireMinMagDetail(detail) {
        const row = detail.querySelector('[data-mag-slider]');
        if (!row) return;
        const [range, number] = row.querySelectorAll('input');
        range?.addEventListener('input', () => _setMinMagIndex(Number(range.value)));
        number?.addEventListener('input', () => _setMinMagValue(Number(number.value)));
    }

    function _maxSpreadHtml() {
        const state = _constraintState.maxSpread;
        return `
            <div class="optimizer-constraint-item">
                <div class="optimizer-toggle-row">
                    <span class="stat-label">${_t('optimizer.maxSpread')}</span>
                    <button type="button" class="compare-toggle${state.on ? ' active' : ''}" data-constraint="maxSpread">
                        <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                    </button>
                </div>
                <div data-constraint-detail="maxSpread">${_maxSpreadDetailHtml()}</div>
            </div>
        `;
    }

    // The exact-floor sub-toggle lives outside `data-moa-slider-wrap` so a floor
    // refetch (which only changes the slider's bounds/ticks) can replace the wrap's
    // innerHTML without also tearing down - and thus un-animating - that pill.
    function _maxSpreadDetailHtml() {
        const state = _constraintState.maxSpread;
        if (!state.on) return '';
        return `
            <div class="optimizer-toggle-row">
                <span class="stat-label" title="${_escape(_t('optimizer.exactSliderFloorTooltip'))}">${_t('optimizer.exactSliderFloor')} <span class="optimizer-help-icon">?</span></span>
                <span style="display:flex;align-items:center;">
                    <button type="button" class="compare-toggle${_useExactMoaFloor ? ' active' : ''}" id="optimizer-exact-floor-toggle">
                        <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                    </button>
                    <span class="optimizer-spinner" data-moa-spinner style="${_fetchingMoaFloor ? '' : 'display:none;'}"></span>
                </span>
            </div>
            <div data-moa-slider-wrap>${_moaSliderWrapHtml()}</div>
        `;
    }

    function _moaSliderWrapHtml() {
        const state = _constraintState.maxSpread;
        const min = _moaSliderMin();
        const max = _moaRange ? Math.max(_moaRange.max, min + 0.01) : Math.max(min + 0.01, 20);
        return `
            <div class="optimizer-constraint-slider-row" data-constraint-slider="maxSpread">
                <div class="optimizer-slider-track">
                    <input type="range" min="${min}" max="${max}" step="0.01" value="${state.value}">
                    <div class="optimizer-slider-ticks"><span>${min.toFixed(2)}</span><span>${max.toFixed(2)}</span></div>
                </div>
                <input type="number" class="optimizer-input" min="${min}" max="${max}" step="0.01" value="${state.value}">
                <span class="input-suffix">${_t('optimizer.moaUnit')}</span>
            </div>
        `;
    }

    function _wireMoaSliderWrap(detail) {
        const row = detail.querySelector('[data-constraint-slider="maxSpread"]');
        if (!row) return;
        const [range, number] = row.querySelectorAll('input');
        range.addEventListener('input', () => _setMaxSpreadValue(Number(range.value)));
        number.addEventListener('input', () => _setMaxSpreadValue(Number(number.value)));
    }

    function _renderMoaSliderWrap(detail) {
        const wrap = detail.querySelector('[data-moa-slider-wrap]');
        if (wrap) {
            wrap.innerHTML = _moaSliderWrapHtml();
            _wireMoaSliderWrap(detail);
        }
        const spinner = detail.querySelector('[data-moa-spinner]');
        if (spinner) spinner.style.display = _fetchingMoaFloor ? '' : 'none';
    }

    function _wireMaxSpreadDetail(detail) {
        const exactFloorToggle = detail.querySelector('#optimizer-exact-floor-toggle');
        exactFloorToggle?.addEventListener('click', () => {
            const value = !_useExactMoaFloor;
            _useExactMoaFloor = value;
            localStorage.setItem('eftforge-optimizer-exact-moa-floor', String(value));
            exactFloorToggle.classList.toggle('active', value);
            if (value && _exactMoaFloor == null) _fetchExactMoaFloor();
            else _renderMoaSliderWrap(detail);
        });
        _wireMoaSliderWrap(detail);
    }

    function _setConstraintValue(key, value) {
        const def = CONSTRAINT_DEFS.find(d => d.key === key);
        const state = _constraintState[key];
        state.value = Math.min(def.max, Math.max(def.min, value));
        const row = document.querySelector(`[data-constraint-slider="${key}"]`);
        if (!row) return;
        const [range, number] = row.querySelectorAll('input');
        range.value = state.value;
        number.value = state.value;
    }

    function _setMinMagIndex(index) {
        if (!_magCapacityValues || !_magCapacityValues.length) return;
        const clampedIndex = Math.max(0, Math.min(_magCapacityValues.length - 1, index));
        _constraintState.minMag.value = _magCapacityValues[clampedIndex];
        const row = document.querySelector('[data-mag-slider]');
        if (row) {
            const [range, number] = row.querySelectorAll('input');
            if (range) range.value = clampedIndex;
            if (number) number.value = _constraintState.minMag.value;
        }
        const ticks = document.querySelectorAll('[data-mag-ticks] span');
        ticks.forEach((el, i) => el.classList.toggle('active', i === clampedIndex));
    }

    function _setMinMagValue(value) {
        if (!_magCapacityValues || !_magCapacityValues.length) return;
        const minVal = _magCapacityValues[0];
        const maxVal = _magCapacityValues[_magCapacityValues.length - 1];
        const val = isNaN(value) ? minVal : value;
        const clampedValue = Math.min(maxVal, Math.max(minVal, val));
        _constraintState.minMag.value = clampedValue;

        let index = _magCapacityValues.indexOf(clampedValue);
        if (index === -1) {
            let closestIdx = 0;
            let closestDiff = Infinity;
            for (let i = 0; i < _magCapacityValues.length; i++) {
                const diff = Math.abs(_magCapacityValues[i] - clampedValue);
                if (diff < closestDiff) {
                    closestDiff = diff;
                    closestIdx = i;
                }
            }
            index = closestIdx;
        }

        const row = document.querySelector('[data-mag-slider]');
        if (row) {
            const range = row.querySelector('input[type="range"]');
            if (range) range.value = index;
        }
        const ticks = document.querySelectorAll('[data-mag-ticks] span');
        ticks.forEach((el, i) => el.classList.toggle('active', _magCapacityValues[i] === clampedValue));
    }

    function _setMaxSpreadValue(value) {
        const min = _moaSliderMin();
        const max = _moaRange ? Math.max(_moaRange.max, min + 0.01) : Math.max(min + 0.01, 20);
        const state = _constraintState.maxSpread;
        state.value = Math.min(max, Math.max(min, value));
        const row = document.querySelector('[data-constraint-slider="maxSpread"]');
        if (!row) return;
        const [range, number] = row.querySelectorAll('input');
        range.value = state.value;
        number.value = state.value;
    }

    function _constraintsHtml() {
        return CONSTRAINT_DEFS.map(_plainConstraintHtml).join('') + _minMagHtml() + _maxSpreadHtml();
    }

    function _renderConstraints() {
        const el = document.getElementById('optimizer-constraints-widget');
        if (!el) return;
        el.innerHTML = _constraintsHtml();

        for (const def of CONSTRAINT_DEFS) {
            const toggle = el.querySelector(`[data-constraint="${def.key}"]`);
            const detail = el.querySelector(`[data-constraint-detail="${def.key}"]`);
            toggle.addEventListener('click', () => {
                const on = !_constraintState[def.key].on;
                _constraintState[def.key].on = on;
                toggle.classList.toggle('active', on);
                detail.innerHTML = _plainConstraintDetailHtml(def);
                _wirePlainConstraintDetail(def, detail);
            });
            _wirePlainConstraintDetail(def, detail);
        }

        const magToggle = el.querySelector('[data-constraint="minMag"]');
        const magDetail = el.querySelector('[data-constraint-detail="minMag"]');
        magToggle.addEventListener('click', () => {
            const on = !_constraintState.minMag.on;
            _constraintState.minMag.on = on;
            if (on && _magCapacityValues && _magCapacityValues.length && !_constraintState.minMag.value) {
                _constraintState.minMag.value = _magCapacityValues[0];
            }
            magToggle.classList.toggle('active', on);
            magDetail.innerHTML = _minMagDetailHtml();
            _wireMinMagDetail(magDetail);
        });
        _wireMinMagDetail(magDetail);

        const spreadToggle = el.querySelector('[data-constraint="maxSpread"]');
        const spreadDetail = el.querySelector('[data-constraint-detail="maxSpread"]');
        spreadToggle.addEventListener('click', () => {
            const on = !_constraintState.maxSpread.on;
            _constraintState.maxSpread.on = on;
            if (on && !_constraintState.maxSpread.value && _moaRange) _constraintState.maxSpread.value = _moaRange.max;
            spreadToggle.classList.toggle('active', on);
            spreadDetail.innerHTML = _maxSpreadDetailHtml();
            _wireMaxSpreadDetail(spreadDetail);
            if (on && _useExactMoaFloor && _exactMoaFloor == null) _fetchExactMoaFloor();
        });
        _wireMaxSpreadDetail(spreadDetail);
    }

    function _renderOptimizeTab() {
        const content = document.getElementById('optimizer-tab-content');
        if (!content) return;

        _ergoWeight = 33;
        _recoilWeight = 34;
        _priceWeight = 33;
        _useEvoErgo = false;
        _fleaAvailable = true;
        _preventOverswing = false;
        _resetConstraintState();
        _includedModIds = [];
        _excludedModIds = [];
        _modSearch = '';

        const currentGun = window.EFTForge.state && window.EFTForge.state.currentGun;
        const weaponId = currentGun ? currentGun.id : null;

        content.innerHTML = `
          <div class="optimizer-two-pane">
            <div class="optimizer-config-pane">
            <div class="optimizer-section${_sectionOpen.weight ? ' open' : ''}" data-section="weight">
                ${_sectionHeaderHtml('weight', 'optimizer.weightAdjustment')}
                <div class="optimizer-section-body" data-section-body style="${_sectionOpen.weight ? '' : 'display:none;'}">
                    <div class="optimizer-preset-row">
                        <button type="button" class="optimizer-preset-btn" id="optimizer-preset-recoil">${_t('optimizer.presetRecoil')}</button>
                        <button type="button" class="optimizer-preset-btn" id="optimizer-preset-ergo">${_t('optimizer.presetErgo')}</button>
                        <button type="button" class="optimizer-preset-btn" id="optimizer-preset-balanced">${_t('optimizer.presetBalanced')}</button>
                        <button type="button" class="optimizer-preset-btn" id="optimizer-preset-min-operable">${_t('optimizer.presetMinOperable')}</button>
                        <button type="button" class="optimizer-preset-btn" id="optimizer-preset-performance">${_t('optimizer.presetPerformance')}</button>
                        <button type="button" class="optimizer-preset-btn" id="optimizer-preset-recoil-focus">${_t('optimizer.presetRecoilFocus')}</button>
                        <button type="button" class="optimizer-preset-btn" id="optimizer-preset-ergo-focus">${_t('optimizer.presetErgoFocus')}</button>
                    </div>
                    <div class="optimizer-toggle-row">
                        <span class="stat-label">${_t('optimizer.useEvoErgo')}</span>
                        <button type="button" class="compare-toggle${_useEvoErgo ? ' active' : ''}" id="optimizer-evo-ergo-toggle">
                            <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                        </button>
                    </div>
                    <div class="optimizer-toggle-row">
                        <span class="stat-label">${_t('optimizer.weightUiLabel')}</span>
                        <div class="optimizer-segmented">
                            <button type="button" class="optimizer-segmented-btn ${_weightUiMode === 'sliders' ? 'active' : ''}" id="optimizer-weight-ui-sliders-btn">${_t('optimizer.weightUiSliders')}</button>
                            <button type="button" class="optimizer-segmented-btn ${_weightUiMode === 'triangle' ? 'active' : ''}" id="optimizer-weight-ui-triangle-btn">${_t('optimizer.weightUiTriangle')}</button>
                        </div>
                    </div>
                    <div id="optimizer-weight-widget"></div>
                </div>
            </div>

            <div class="optimizer-section${_sectionOpen.constraints ? ' open' : ''}" data-section="constraints">
                ${_sectionHeaderHtml('constraints', 'optimizer.constraints')}
                <div class="optimizer-section-body" data-section-body style="${_sectionOpen.constraints ? '' : 'display:none;'}">
                    <div class="optimizer-toggle-row">
                        <span class="stat-label">${_t('optimizer.preventOverswing')}</span>
                        <button type="button" class="compare-toggle${_preventOverswing ? ' active' : ''}" id="optimizer-overswing-toggle">
                            <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                        </button>
                    </div>
                    <div id="optimizer-constraints-widget"></div>
                </div>
            </div>

            <div class="optimizer-section${_sectionOpen.modFilter ? ' open' : ''}" data-section="modFilter">
                ${_sectionHeaderHtml('modFilter', 'optimizer.modFilter')}
                <div class="optimizer-section-body" data-section-body style="${_sectionOpen.modFilter ? '' : 'display:none;'}">
                    <div id="optimizer-mod-filter-widget"></div>
                </div>
            </div>

            <div class="optimizer-section${_sectionOpen.market ? ' open' : ''}" data-section="market">
                ${_sectionHeaderHtml('market', 'optimizer.marketAccess')}
                <div class="optimizer-section-body" data-section-body style="${_sectionOpen.market ? '' : 'display:none;'}">
                    <div class="optimizer-toggle-row">
                        <span class="stat-label">${_t('optimizer.fleaAvailable')}</span>
                        <button type="button" class="compare-toggle${_fleaAvailable ? ' active' : ''}" id="optimizer-flea-toggle">
                            <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                        </button>
                    </div>
                    <div id="optimizer-trader-access-widget"></div>
                </div>
            </div>

            <button class="modal-btn primary full-width" id="optimizer-solve-btn">${_t('optimizer.solve')}</button>
            </div>

            <div class="optimizer-results-pane" id="optimizer-results-pane"></div>
          </div>
        `;

        // Mirrors the main attachment table's header-pinned toggle (styles.css
        // .attachment-table.header-pinned), but scoped to this pane's own scroll
        // instead of .right-panel since the results pane now scrolls independently.
        const resultsPane = document.getElementById('optimizer-results-pane');
        resultsPane.addEventListener('scroll', () => {
            const table = resultsPane.querySelector('.optimizer-manifest-table');
            if (table) table.classList.toggle('header-pinned', resultsPane.scrollTop > 10);
        }, { passive: true });

        document.getElementById('optimizer-preset-recoil').addEventListener('click', () => _setWeights(0, 100, 0));
        document.getElementById('optimizer-preset-ergo').addEventListener('click', () => _setWeights(100, 0, 0));
        document.getElementById('optimizer-preset-balanced').addEventListener('click', () => _setWeights(33, 34, 33));
        document.getElementById('optimizer-preset-min-operable').addEventListener('click', () => _setWeights(0, 0, 100));
        document.getElementById('optimizer-preset-performance').addEventListener('click', () => _setWeights(48, 48, 2));
        document.getElementById('optimizer-preset-recoil-focus').addEventListener('click', () => _setWeights(20, 70, 10));
        document.getElementById('optimizer-preset-ergo-focus').addEventListener('click', () => _setWeights(70, 20, 10));
        document.getElementById('optimizer-evo-ergo-toggle').addEventListener('click', () => _setUseEvoErgo(!_useEvoErgo));
        document.getElementById('optimizer-weight-ui-sliders-btn').addEventListener('click', () => _setWeightUiMode('sliders'));
        document.getElementById('optimizer-weight-ui-triangle-btn').addEventListener('click', () => _setWeightUiMode('triangle'));
        _renderWeightWidget();
        _wireSection('weight', () => _setWeights(33, 34, 33));

        document.getElementById('optimizer-overswing-toggle').addEventListener('click', () => _setPreventOverswing(!_preventOverswing));
        _renderConstraints();
        if (weaponId) {
            _fetchStatRanges(weaponId).then(ranges => {
                _applyStatRanges(ranges);
                _renderConstraints();
            }).catch(() => {});
        }
        _wireSection('constraints', () => {
            _setPreventOverswing(false);
            _resetConstraintValues();
            _renderConstraints();
        });

        _renderModFilterWidget();
        _wireSection('modFilter', () => {
            _includedModIds = [];
            _excludedModIds = [];
            _modSearch = '';
            _renderModFilterWidget();
        });

        document.getElementById('optimizer-flea-toggle').addEventListener('click', () => _setFleaAvailable(!_fleaAvailable));
        _wireSection('market', () => {
            _setFleaAvailable(true);
            resetTraderLevels();
        });
        _renderTraderAccessWidget();

        document.getElementById('optimizer-solve-btn').addEventListener('click', _solveOptimize);
        _renderResult();
    }

    async function _solveOptimize() {
        const weaponId = window.EFTForge.state?.currentGun?.id;
        if (!weaponId) return;

        _solving = true;
        _error = null;
        _result = null;
        _renderResult();

        const state = window.EFTForge.state || {};
        const body = {
            weapon_id: weaponId,
            use_evo_ergo: _useEvoErgo,
            ergo_weight: _ergoWeight / 100,
            recoil_weight: _recoilWeight / 100,
            price_weight: _priceWeight / 100,
            max_price: _constraintState.budget.on ? _constraintState.budget.value : null,
            min_ergonomics: _constraintState.minErgo.on ? _constraintState.minErgo.value : null,
            min_mag_capacity: _constraintState.minMag.on ? _constraintState.minMag.value : null,
            max_moa: _constraintState.maxSpread.on ? _constraintState.maxSpread.value : null,
            prevent_overswing: _preventOverswing,
            include_items: _includedModIds.length ? _includedModIds : null,
            exclude_items: _excludedModIds.length ? _excludedModIds : null,
            flea_available: _fleaAvailable,
            trader_levels: state.traderLevels || null,
            strength_level: state.currentStrengthLevel ?? 10,
            equip_ergo_modifier: state.currentEquipErgoModifier ?? 0,
        };

        await _runSolve(`${EFTForge.config.API_BASE}/build/optimize`, body);
    }

    /* ===========================
       GUNSMITH TAB
    =========================== */

    function _fetchGunsmithTasks() {
        if (_gunsmithTasks) return Promise.resolve(_gunsmithTasks);
        if (_gunsmithTasksPromise) return _gunsmithTasksPromise;

        const lang = (window.EFTForge.state && window.EFTForge.state.lang) || 'en';
        _gunsmithTasksPromise = fetch(`${EFTForge.config.API_BASE}/build/gunsmith-tasks?lang=${lang}`)
            .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
            .then(data => { _gunsmithTasks = data.tasks; return _gunsmithTasks; })
            .finally(() => { _gunsmithTasksPromise = null; });
        return _gunsmithTasksPromise;
    }

    async function _renderGunsmithTab() {
        const content = document.getElementById('optimizer-tab-content');
        if (!content) return;

        content.innerHTML = `<div class="optimizer-result">${_t('optimizer.loadingTasks')}</div>`;

        let tasks;
        try {
            tasks = await _fetchGunsmithTasks();
        } catch {
            content.innerHTML = `<div class="optimizer-result"><div class="optimizer-error">${_t('optimizer.tasksLoadFailed')}</div></div>`;
            return;
        }
        if (_activeTab !== 'gunsmith') return; // user switched tabs while this was loading

        const options = tasks.map(t => `<option value="${_escape(t.task_name)}">${_escape(t.task_name)}</option>`).join('');

        content.innerHTML = `
            <div class="optimizer-field">
                <label class="modal-label">${_t('optimizer.task')}</label>
                <select id="optimizer-gunsmith-task" class="optimizer-input">${options}</select>
            </div>
            <div id="optimizer-gunsmith-info"></div>
            <div class="optimizer-toggle-row">
                <span class="stat-label">${_t('optimizer.fleaAvailable')}</span>
                <button type="button" class="compare-toggle active" id="optimizer-gunsmith-flea-available">
                    <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                </button>
            </div>
            <button class="modal-btn primary full-width" id="optimizer-gunsmith-solve-btn">${_t('optimizer.solve')}</button>
            <div id="optimizer-result-container"></div>
        `;

        const select = document.getElementById('optimizer-gunsmith-task');
        select.addEventListener('change', () => _renderGunsmithTaskInfo(tasks));
        _renderGunsmithTaskInfo(tasks);

        document.getElementById('optimizer-gunsmith-flea-available').addEventListener('click', (e) => {
            e.currentTarget.classList.toggle('active');
        });
        document.getElementById('optimizer-gunsmith-solve-btn').addEventListener('click', _solveGunsmith);
        _renderResult();
    }

    function _renderGunsmithTaskInfo(tasks) {
        const select = document.getElementById('optimizer-gunsmith-task');
        const info = document.getElementById('optimizer-gunsmith-info');
        if (!select || !info) return;
        const task = tasks.find(t => t.task_name === select.value);
        if (!task) { info.innerHTML = ''; return; }

        const c = task.constraints || {};
        const constraintTags = Object.entries({
            [_t('optimizer.minErgo')]: c.min_ergonomics,
            [_t('optimizer.maxRecoilSum')]: c.max_recoil_sum,
            [_t('optimizer.minMagCapacity')]: c.min_mag_capacity,
            [_t('optimizer.minSightingRange')]: c.min_sighting_range,
            [_t('optimizer.maxWeight')]: c.max_weight,
        }).filter(([, v]) => v != null).map(([label, v]) => `<span class="stat-label">${label}: <span class="stat-value" style="display:inline;">${v}</span></span>`).join('');

        const requiredNames = task.required_item_names.length
            ? `<div class="stat-label">${_t('optimizer.requiredItems')}: ${task.required_item_names.map(_escape).join(', ')}</div>`
            : '';

        info.innerHTML = `
            <div class="optimizer-result">
                <div class="modal-label" style="margin:0;">${_escape(task.weapon_name)}</div>
                ${constraintTags}
                ${requiredNames}
            </div>
        `;
    }

    async function _solveGunsmith() {
        const select = document.getElementById('optimizer-gunsmith-task');
        const taskName = select?.value;
        if (!taskName) return;

        _solving = true;
        _error = null;
        _result = null;
        _renderResult();

        const state = window.EFTForge.state || {};
        const body = {
            task_name: taskName,
            flea_available: document.getElementById('optimizer-gunsmith-flea-available').classList.contains('active'),
            trader_levels: state.traderLevels || null,
            strength_level: state.currentStrengthLevel ?? 10,
            equip_ergo_modifier: state.currentEquipErgoModifier ?? 0,
        };

        await _runSolve(`${EFTForge.config.API_BASE}/build/gunsmith-solve`, body);
    }

    /* ===========================
       SOLVE (shared) + RESULT
    =========================== */

    async function _runSolve(url, body) {
        _abortController = new AbortController();
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: _abortController.signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.status === 'optimal') {
                _result = data;
            } else {
                _error = data.reason || _t('optimizer.infeasible');
            }
        } catch (err) {
            _error = err.name === 'AbortError' ? _t('optimizer.cancelled') : _t('optimizer.solveFailed');
        } finally {
            _solving = false;
            _abortController = null;
            _renderResult();
        }
    }

    function _cancelSolve() {
        _abortController?.abort();
    }

    // Padlock and no-entry glyphs for the manifest's lock/ban buttons - inline SVG
    // (not emoji) so they inherit currentColor and stay crisp at 14px, matching the
    // reference optimizer's per-item lock/ban controls that sit where the attachment
    // table normally puts its favorite star.
    const _LOCK_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
    const _BAN_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/></svg>';

    function _resultsContainer() {
        return document.getElementById('optimizer-results-pane')
            || document.getElementById('optimizer-result-container');
    }

    function _gunForResult() {
        const byId = (typeof gunById === 'function' && _result && _result.gun_id) ? gunById(_result.gun_id) : null;
        return byId || (window.EFTForge.state && window.EFTForge.state.currentGun) || null;
    }

    // One animated stat bar, deliberately the same markup the main stats panel
    // (stats-panel.js) and the tab-preview tooltip (tab-manager.js) use, so the fill
    // grows from 0% to data-target once mounted (see the rAF sweep in _renderResult).
    function _statBarRowHtml(labelKey, fillClass, target, valueText) {
        return `
            <div class="stat-bar-row">
                <div class="stat-bar-label">${_t(labelKey)}</div>
                <div class="stat-bar-track">
                    <div class="stat-bar-fill ${fillClass}" style="width:0%"${target !== null ? ` data-target="${target}"` : ''}></div>
                    <div class="stat-bar-value">${valueText}</div>
                </div>
            </div>`;
    }

    // The results readout, mirroring the main "Current Build" stats panel
    // (stats-panel.js updateStatsPanel) - the same bars/subsection layout, formatting
    // and stats.* translation keys - so an optimized build reads identically to a
    // hand-built one. Arm stamina and muzzle velocity are dropped: the optimizer picks
    // no ammo, so there's no muzzle velocity to show, and arm stamina isn't one of the
    // axes it optimizes. Total cost (the optimizer's own headline number) takes the
    // price panel's cost-total-row slot at the bottom.
    function _statTilesHtml(s) {
        const totalErgo = parseFloat(s.total_ergo ?? 0);
        const ergoText = Math.abs(totalErgo - Math.round(totalErgo)) < 0.001 ? Math.round(totalErgo) : totalErgo.toFixed(1);
        const ergoTarget = Math.max(0, Math.min(totalErgo, 100));

        const rv = s.recoil_vertical;
        const rh = s.recoil_horizontal;
        const rvText = rv != null ? Math.round(rv) : '-';
        const rhText = rh != null ? Math.round(rh) : '-';
        const rvTarget = rv != null ? Math.min(Math.round(rv), 500) / 5 : 0;
        const rhTarget = rh != null ? Math.min(Math.round(rh), 500) / 5 : 0;

        const moa = s.accuracy_moa;
        const accText = moa != null ? moa.toFixed(2) + ' MOA' : '-';
        const accTarget = moa != null ? Math.min(moa / 10, 1) * 100 : 0;

        const eed = parseFloat(s.evo_ergo_delta ?? 0);
        const eedText = `${eed > 0 ? '+' : ''}${eed.toFixed(1)}`;
        const eedClass = eed >= 0 ? 'positive' : 'negative';
        const overswingClass = s.overswing ? 'negative' : 'positive';
        const overswingText = s.overswing ? _t('stats.yes') : _t('stats.no');

        const sighting = s.sighting_range;
        const sightingRow = sighting != null
            ? `<div class="stat-row"><span class="stat-label">${_t('stats.sightingRange')}</span><span>${sighting} m</span></div>`
            : '';

        const cost = _result.grand_total_rub != null ? _result.grand_total_rub : _result.total_price_rub;

        return `
            <div class="stats-section">
                <div class="section-title stats-title-row"><span>${_t('stats.title')}</span></div>
                <div class="optimizer-results-split">
                    <div class="optimizer-results-statsblock">
                        <div class="optimizer-results-bars">
                            ${_statBarRowHtml('stats.ergo', 'ergo-bar', ergoTarget, ergoText)}
                            ${_statBarRowHtml('stats.verRecoil', 'recoil-bar', rvTarget, rvText)}
                            ${_statBarRowHtml('stats.horRecoil', 'recoil-bar', rhTarget, rhText)}
                            ${_statBarRowHtml('stats.accuracy', 'accuracy-bar', accTarget, accText)}
                        </div>
                        <div class="stats-divider"></div>
                        <div class="optimizer-results-substats stat-subsection">
                            <div class="stat-row"><span class="stat-label">${_t('stats.weight')}</span><span>${s.total_weight.toFixed(3)} kg</span></div>
                            <div class="stat-row"><span class="stat-label">${_t('stats.eedLabelShort')}</span><span class="${eedClass}">${eedText}</span></div>
                            <div class="stat-row"><span class="stat-label">${_t('stats.overswing')}</span><span class="${overswingClass}">${overswingText}</span></div>
                            ${sightingRow}
                        </div>
                    </div>
                    <div class="optimizer-results-gunimg">
                        <img id="optimizer-result-gun-img" class="optimizer-result-gun-img" alt="" onerror="this.style.visibility='hidden'">
                        <button class="modal-btn primary optimizer-use-build-inline" id="optimizer-use-build-btn">${_t('optimizer.useThisBuild')}</button>
                    </div>
                </div>
                <div class="cost-total-row">
                    <span>${_t('stats.totalCost')}</span>
                    <span>${_formatPrice(cost)}</span>
                </div>
            </div>
        `;
    }

    // The solved build's full gun image, driven by the exact same rules as the main
    // placeholder / tab-preview gun image (build-preview.js): a server-generated
    // composite of the actual build when the image-gen toggle is on, and the static
    // factory-preset asset when it's off (or when the admin/local kill-switch is set).
    // Scoped to this <img> and its own abort/generation counter so it never touches the
    // shared _bp* state that manages the main build image.
    let _resultImgAbort = null;
    let _resultImgGen = 0;

    async function _loadResultGunImage() {
        const imgEl = document.getElementById('optimizer-result-gun-img');
        if (!imgEl || !_result) return;
        const gun = _gunForResult();
        if (!gun) return;

        const gen = ++_resultImgGen;
        const pairs = _result.slot_pairs || [];
        const key = pairs.map(p => p.join(':')).sort().join(',');

        // Static default (toggle off, factory config, or kill-switch): the preset
        // composite, same fallback the placeholder resets to. Bare receiver when the
        // build somehow has no attachments.
        const staticSrc = key === ''
            ? (gun.bare_image_512_link || gun.image_512_link || gun.icon_link || '')
            : (gun.image_512_link || gun.icon_link || '');
        imgEl.referrerPolicy = '';
        imgEl.style.opacity = '';
        imgEl.style.filter = '';
        imgEl.style.visibility = '';
        imgEl.src = staticSrc;

        // Toggle off, admin/local kill-switch, or a build that maps to a static asset
        // (bare receiver / untouched factory preset) - keep the static image, no request.
        if (!window._bpIsEnabled?.() || window._bpIsGloballyDisabled?.()) return;
        if (key === '' || key === EFTForge.state.factoryPairsKey) return;

        // Warm slotCache for any parts _bpBuildSptItemsForPairs needs to resolve slot
        // names (same warm-up the tab preview does before generating an arbitrary build).
        const uncached = [...new Set(pairs.map(([, iid]) => iid).filter(iid => !EFTForge.state.slotCache[iid]))];
        if (uncached.length) {
            try {
                const batch = await fetchItemSlotsBatch(uncached);
                for (const [iid, slots] of Object.entries(batch)) cacheSet(EFTForge.state.slotCache, iid, slots);
            } catch (_) { /* generation below just skips any still-unresolved slots */ }
        }
        if (gen !== _resultImgGen) return;

        const sptData = _bpBuildSptItemsForPairs(gun, pairs);
        if (!sptData) return;

        imgEl.style.opacity = '0.35';
        imgEl.style.filter = 'brightness(0.85)';
        _resultImgAbort?.abort();
        _resultImgAbort = new AbortController();
        try {
            const resp = await fetch(`${EFTForge.config.API_BASE}/build-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sptData),
                signal: _resultImgAbort.signal,
            });
            if (!resp.ok) return;
            const data = await resp.json();
            if (data.image_url && gen === _resultImgGen) imgEl.src = data.image_url;
        } catch (_) {
            // Network failure or aborted - leave the static preset image showing.
        } finally {
            if (gen === _resultImgGen) {
                imgEl.style.opacity = '';
                imgEl.style.filter = '';
            }
            _resultImgAbort = null;
        }
    }

    function _baseKindLabel(base) {
        return _t(base && base.kind === 'preset' ? 'optimizer.factoryPreset' : 'optimizer.baseReceiver');
    }

    // Renders a {price_rub, vendor} price blip (trader portrait or a flea tag) -
    // shared by the weapon card's base cost and the manifest table's per-item
    // price cell, both driven by the solve's own item_prices rather than an
    // independently re-picked "cheapest overall" price.
    function _priceBlipHtml(priced) {
        if (!priced || priced.price_rub == null) return '<span class="att-price-flea">-</span>';
        const isFlea = !priced.vendor || priced.vendor === 'flea-market';
        let vendorHtml;
        if (isFlea) {
            vendorHtml = `<span class="att-price-flea">${_escape(_t('stats.fleaLabel'))}</span>`;
        } else {
            const trader = window.EFTForge.state.tradersByNorm && window.EFTForge.state.tradersByNorm[priced.vendor];
            const img = (trader && trader.imageLink) || '';
            vendorHtml = img
                ? `<img class="att-price-portrait" src="${_escape(img)}" onerror="this.style.display='none'">`
                : `<span class="att-price-vendor">${_escape(priced.vendor)}</span>`;
        }
        return `<div class="att-price-wrap">${vendorHtml}<span>${_formatPrice(priced.price_rub)}</span></div>`;
    }

    // The card art follows the chosen base and prefers the 512px image: the preset's
    // composite (image_512_link) when starting from the factory preset, the bare
    // receiver (bare_image_512_link) when starting from the base receiver.
    function _baseImage(gun, kind) {
        if (!gun) return '';
        if (kind === 'preset') {
            return gun.image_512_link || gun.preset_icon_link || gun.icon_link || '';
        }
        return gun.bare_image_512_link || gun.icon_link || gun.image_512_link || '';
    }

    function _weaponCardHtml() {
        const gun = _gunForResult();
        const gunName = gun ? gun.name : '';
        const base = _result.base || { kind: 'receiver', price_rub: null };
        const gunImg = _baseImage(gun, base.kind);
        return `
            <div class="optimizer-weapon-card">
                <img class="optimizer-weapon-card-img" src="${_escape(gunImg)}" onerror="this.style.visibility='hidden'" alt="">
                <div class="optimizer-weapon-card-info">
                    <div class="optimizer-weapon-card-name">${_escape(gunName)}</div>
                    <div class="optimizer-weapon-card-sub">${_escape(_baseKindLabel(base))}</div>
                </div>
                <div class="optimizer-weapon-card-price">${_priceBlipHtml(base)}</div>
            </div>
        `;
    }

    function _manifestTheadHtml() {
        return `
            <thead>
                <tr>
                    <th>${_t('th.name')}</th>
                    <th>${_t('th.price')}</th>
                    <th>${_t('th.rubRecoil')}</th>
                    <th>${_t('th.weight')}</th>
                    <th>${_t('th.recoilList')}</th>
                    <th>${_t('th.accuracy')}</th>
                    <th>${_t('th.ergo')}</th>
                    <th>${_t('th.evoErgo')}</th>
                    <th>${_t('th.balance')}</th>
                    <th>${_t('th.heatCoolBurn')}</th>
                    <th>${_t('th.muzzleVelocity')}</th>
                </tr>
            </thead>
        `;
    }

    // One manifest row, deliberately mirroring the attachment table's cell layout and
    // classes (slot-selector.js) so it inherits the exact same styling and column set.
    // The two differences the results panel wants: the favorite star is replaced by a
    // lock/ban pair, and the like/dislike rating block is dropped.
    function _manifestRowHtml(item) {
        const evo = (_result.evo_contributions && _result.evo_contributions[item.id]) || 0;
        const recoilPercent = parseFloat(item.recoil_modifier ?? 0) * 100;
        const ergoModifier = parseFloat(item.ergonomics_modifier ?? 0);

        const itemCOI = item.center_of_impact ?? null;
        const itemAccMod = item.accuracy_modifier ?? null;
        let accContent;
        if (itemCOI !== null) {
            accContent = `<span class="acc-coi-val">${(itemCOI * 34.3).toFixed(2)} MOA</span>`;
        } else if (itemAccMod !== null && itemAccMod !== 0) {
            const cls = itemAccMod > 0 ? 'positive' : 'negative';
            accContent = `<span class="${cls}">${itemAccMod > 0 ? '+' : ''}${itemAccMod.toFixed(1)}%</span>`;
        } else {
            accContent = '-';
        }

        const locked = _includedModIds.includes(item.id);
        const banned = _excludedModIds.includes(item.id);
        const sid = escapeHtml(item.id);

        return `
            <tr data-item-id="${sid}">
                <td class="name-cell">
                    <div class="attachment-name-wrapper">
                        <div class="optimizer-lockban">
                            <button type="button" class="optimizer-lock-btn${locked ? ' active' : ''}" data-lock-id="${sid}" title="${escapeHtml(_t('optimizer.lockItem'))}">${_LOCK_SVG}</button>
                            <button type="button" class="optimizer-ban-btn${banned ? ' active' : ''}" data-ban-id="${sid}" title="${escapeHtml(_t('optimizer.banItem'))}">${_BAN_SVG}</button>
                        </div>
                        <div class="attachment-icon-wrapper">
                            <img src="${escapeHtml(item.icon_link)}" class="attachment-icon" loading="lazy" decoding="async" onerror="this.style.display='none'" />
                            <div class="slot-shortname">${escapeHtml(item.short_name)}</div>
                        </div>
                        <div class="att-name-and-rating">
                            <div class="attachment-name-text"><span class="marquee-text">${escapeHtml(item.name)}</span></div>
                        </div>
                    </div>
                </td>
                <td>${_priceBlipHtml((_result.item_prices && _result.item_prices[item.id]) || null)}</td>
                <td class="col-combo-only"></td>
                <td>${parseFloat(item.weight ?? 0).toFixed(3)}</td>
                <td>${formatStat(recoilPercent)}%</td>
                <td class="acc-cell">${accContent}</td>
                <td class="${ergoModifier >= 0 ? 'ergo-positive' : 'ergo-negative'}">${ergoModifier >= 0 ? '+' : ''}${formatStat(ergoModifier)}</td>
                <td class="${evo >= 0 ? 'evo-positive' : 'evo-negative'}">${evo >= 0 ? '+' : ''}${evo.toFixed(1)}</td>
                <td class="col-combo-only"></td>
                ${_heatCoolBurnCellHtml(item)}
                ${_velCellHtml(item)}
            </tr>
        `;
    }

    function _renderResult() {
        const container = _resultsContainer();
        if (!container) return;

        if (_solving) {
            container.innerHTML = `
                <div class="optimizer-result optimizer-results-status">
                    <div class="optimizer-spinner optimizer-spinner-lg"></div>
                    <div>${_t('optimizer.solving')}</div>
                    <button class="modal-btn" id="optimizer-cancel-btn">${_t('modal.cancel')}</button>
                </div>
            `;
            document.getElementById('optimizer-cancel-btn').addEventListener('click', _cancelSolve);
            return;
        }
        if (_error) {
            container.innerHTML = `<div class="optimizer-result optimizer-results-status"><div class="optimizer-error">${_escape(_error)}</div></div>`;
            return;
        }
        if (!_result) {
            container.innerHTML = `<div class="optimizer-results-empty">${_t('optimizer.resultsPlaceholder')}</div>`;
            return;
        }

        const s = _result.final_stats;
        container.innerHTML = `
            <div class="optimizer-results">
                <div class="optimizer-status-bar">
                    <button type="button" class="modal-btn primary optimizer-reoptimize-btn" id="optimizer-reoptimize-btn">${_t('optimizer.reoptimize')}</button>
                    <div class="optimizer-status-meta">
                        <span class="optimizer-status-ok">&#10003;</span>
                        <span class="optimizer-status-label">${_t('optimizer.statusOptimal')}</span>
                        ${_result.solve_ms != null ? `<span class="optimizer-badge">${_result.solve_ms} ms</span>` : ''}
                    </div>
                </div>

                ${_statTilesHtml(s)}

                <div class="optimizer-manifest">
                    ${_weaponCardHtml()}

                    <div class="optimizer-manifest-header">
                        <span class="optimizer-manifest-title">${_t('optimizer.buildManifest')}</span>
                    </div>
                    <div class="optimizer-manifest-table-wrap">
                        <table class="attachment-table hide-col-rub-recoil hide-col-balance optimizer-manifest-table">
                            ${_manifestTheadHtml()}
                            <tbody id="optimizer-manifest-body">
                                <tr><td colspan="11" class="optimizer-manifest-loading">${_t('optimizer.loadingItems')}</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('optimizer-reoptimize-btn').addEventListener('click', _solveOptimize);
        document.getElementById('optimizer-use-build-btn').addEventListener('click', _useBuild);

        // Grow the stat bars from 0% to their targets, same as the main stats panel.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            container.querySelectorAll('.stat-bar-fill[data-target]').forEach(el => {
                el.style.width = el.dataset.target + '%';
            });
        }));

        _loadResultGunImage();
        _populateManifest(_result);
    }

    async function _resolveSelectedItems(result) {
        const pairs = result.slot_pairs || [];
        const need = [...new Set(pairs.map(p => p[0]).filter(sid => !EFTForge.state.allowedCache[sid]))];
        if (need.length) {
            const batch = await fetchSlotAllowedItemsBatch(need);
            for (const [sid, items] of Object.entries(batch)) cacheSet(EFTForge.state.allowedCache, sid, items);
        }
        const out = [];
        for (const [slotId, itemId] of pairs) {
            const allowed = EFTForge.state.allowedCache[slotId];
            const item = allowed && allowed.find(i => i.id === itemId);
            if (item) out.push(item);
        }
        return out;
    }

    async function _populateManifest(result) {
        let resolved = [];
        try { resolved = await _resolveSelectedItems(result); } catch { resolved = []; }
        if (_result !== result) return; // a newer solve superseded this one
        try { await ensureFleaPrices(resolved.map(i => i.id)); } catch {}
        if (_result !== result) return;

        const body = document.getElementById('optimizer-manifest-body');
        if (!body) return;
        if (!resolved.length) {
            body.innerHTML = `<tr><td colspan="11" class="optimizer-manifest-loading">${_t('optimizer.noItems')}</td></tr>`;
            return;
        }
        body.innerHTML = resolved.map(_manifestRowHtml).join('');
        _wireManifestButtons();
    }

    function _wireManifestButtons() {
        const body = document.getElementById('optimizer-manifest-body');
        if (!body) return;
        body.querySelectorAll('[data-lock-id]').forEach(btn =>
            btn.addEventListener('click', () => _toggleManifestLock(btn.dataset.lockId)));
        body.querySelectorAll('[data-ban-id]').forEach(btn =>
            btn.addEventListener('click', () => _toggleManifestBan(btn.dataset.banId)));
    }

    // Lock pins a part (force-include); ban forbids it (exclude). Both feed the exact
    // same _includedModIds/_excludedModIds the Attachment Filtering section drives, so
    // the two surfaces stay one source of truth - the user then hits Re-optimize.
    function _toggleManifestLock(id) {
        if (_includedModIds.includes(id)) {
            _includedModIds = _includedModIds.filter(x => x !== id);
        } else {
            _includedModIds.push(id);
            _excludedModIds = _excludedModIds.filter(x => x !== id);
        }
        _syncFilterSurfaces();
    }

    function _toggleManifestBan(id) {
        if (_excludedModIds.includes(id)) {
            _excludedModIds = _excludedModIds.filter(x => x !== id);
        } else {
            _excludedModIds.push(id);
            _includedModIds = _includedModIds.filter(x => x !== id);
        }
        _syncFilterSurfaces();
    }

    function _syncFilterSurfaces() {
        document.querySelectorAll('#optimizer-manifest-body [data-lock-id]').forEach(b =>
            b.classList.toggle('active', _includedModIds.includes(b.dataset.lockId)));
        document.querySelectorAll('#optimizer-manifest-body [data-ban-id]').forEach(b =>
            b.classList.toggle('active', _excludedModIds.includes(b.dataset.banId)));
        // Keep the Attachment Filtering section's tags in sync if it's mounted.
        if (document.getElementById('optimizer-mod-filter-widget')) _renderModFilterWidget();
    }

    async function _useBuild() {
        if (!_result) return;
        await loadBuildFromPayload({ v: 1, g: _result.gun_id, p: _result.slot_pairs });
        hidePanel();
    }

    // Scripts are loaded at the end of <body> so DOM is ready; init immediately.
    init();

    return { showPanel, hidePanel, onLangChange, onTraderLevelsChange };

}());
