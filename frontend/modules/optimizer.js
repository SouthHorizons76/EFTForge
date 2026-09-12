window.EFTForge = window.EFTForge || {};

/* ============================================================
   WEAPON OPTIMIZER
   Generate individual builds or explore tradeoffs for the selected gun.

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

    // Explore mode has superseded single-build Optimize as the default flow.
    // Optimize's UI and solve path are untouched, just hidden from players.
    // Flip this back to true to re-expose it.
    const OPTIMIZE_ENABLED = false;

    let _activeTab = OPTIMIZE_ENABLED ? 'optimize' : 'explore';  // 'optimize' | 'explore' | 'gunsmith'
    let _explore = null;
    let _exploreTradeoff = 'price';
    let _exploreSteps = 20;
    let _exploreSelected = 0;
    let _exploreChartData = null;
    // Ctrl+scroll/drag zoom-pan state for the solved-builds chart, same model as
    // the attachment Graph view's _graphView (see graph.js): null = auto-fit to
    // the current point set, otherwise a manually zoomed/panned data-space window.
    let _exploreView = null;
    let _exploreViewTarget = null;   // lerp target for smooth ctrl+scroll zoom
    let _exploreZoomLerpRaf = null;  // rAF handle for zoom lerp loop
    let _exploreLerpEndNull = false; // whether the current lerp should end with _exploreView = null (reset)
    let _exploreZoomController = null; // AbortController for the current svg's wheel/drag listeners
    let _explorePanState = null;     // { last: {sx, sy} } while middle-button drag active
    let _explorePanRaf = null;
    let _explorePanDelta = null;
    let _exploreSelectPointFn = null; // current selectPoint(index) closure, reused by zoom-only rebuilds
    let _exploreScrollHintTimer = null; // debounce timer for the plain-scroll hint overlay
    let _exploreScrollHintShown = false; // true after the hint has fired once this session
    // Same unbounded-zoom hazard as the attachment Graph view (see graph.js's
    // GRAPH_MIN/MAX_ZOOM_RATIO comment): without a floor, repeated ctrl+scroll
    // zoom-in shrinks the domain span toward a floating-point-underflowed 0,
    // turning the axis mapping into NaN/Infinity and permanently wedging the
    // zoom lerp's rAF loop (its "done" check can never be true against NaN).
    const EXPLORE_MIN_ZOOM_RATIO = 0.02; // deepest zoom-in: 2% of the auto-fit span
    const EXPLORE_MAX_ZOOM_RATIO = 75;   // furthest zoom-out: 75x the auto-fit span
    // Secret: reach the hard zoom-out ceiling above and the curve is swapped for
    // a warning sign - a little payoff for the folks who scroll all the way out.
    // Tied to the ceiling (with a small tolerance for the lerp's approach) rather
    // than an arbitrary earlier ratio, since the ceiling is now a fixed, stable
    // window (see _clampExploreZoomSpan) - once you're pinned there this stays
    // showing no matter how much further you scroll, and any zoom-in exits it.
    const EXPLORE_EASTER_EGG_RATIO = EXPLORE_MAX_ZOOM_RATIO - 0.5;
    const EXPLORE_EASTER_EGG_IMG = './news/images/ee/thefuture.jpg';
    function _clampExploreZoomSpan(min, max, autoMin, autoMax) {
        const autoSpan = autoMax - autoMin;
        const minSpan = autoSpan * EXPLORE_MIN_ZOOM_RATIO;
        const maxSpan = autoSpan * EXPLORE_MAX_ZOOM_RATIO;
        const span = max - min;
        if (span > maxSpan) {
            // Hard ceiling: always recenter on the data itself, not on wherever
            // the cursor happened to be anchoring the zoom - otherwise every
            // further zoom-out tick keeps recomputing a same-width-but-differently
            // -centered window, which never visibly stops even though the span
            // itself is capped (the points just keep sliding off to one side).
            const autoMid = (autoMin + autoMax) / 2;
            return [autoMid - maxSpan / 2, autoMid + maxSpan / 2];
        }
        if (span < minSpan) {
            // No such drift concern zooming in - keep following the cursor so
            // continuing to scroll in at the floor still pans toward it.
            const mid = (min + max) / 2;
            return [mid - minSpan / 2, mid + minSpan / 2];
        }
        return [min, max];
    }
    // True for exactly the one chart (re)build right after a solve completes -
    // lets _renderExploreChart play the "lock-on" ring once on the point the
    // system auto-selected, without replaying it on later rebuilds that aren't
    // a fresh solve (e.g. leaving the Explore tab and coming back).
    let _exploreJustSolved = false;
    let _settingsWeaponId = null;
    let _disposeManifestMarquee = null;
    let _result = null;   // last successful solve response, or null
    let _solving = false;
    let _waitingForSlot = false;  // true between retries while every solver slot is busy
    let _error = null;

    // Live progress from an in-flight Explore stream: { phase, done, total, points,
    // previewBuild }. points/previewBuild grow as real per-step solves complete, so
    // the results pane can populate itself before the sweep finishes - see
    // _renderSolvingResult. null whenever not solving the explore tab.
    let _solveProgress = null;
    let _solveRenderPending = false;
    let _solveStartedAt = null;   // Date.now() when the current explore solve began, or null
    let _solveElapsedTimer = null;
    // True during _playDiscardAnimation, after the stream has already delivered its
    // last progress tick. That tick's own _scheduleSolveRender is still pending a
    // rAF at that point (rAF fires on the next paint, well after this flips true),
    // and when it fires _updateSolvingResult would otherwise recompute the phase/
    // detail text from that stale last-step _solveProgress - stomping the "Selecting
    // the best builds..." copy right back to e.g. "Minimizing recoil". Checked by
    // _solveProgressLabel/_solveProgressDetail so any such late render still shows
    // the selecting copy instead of undoing it.
    let _solveSelecting = false;

    let _gunsmithTasks = null;      // cached GET /build/gunsmith-tasks response
    let _gunsmithTasksPromise = null;

    // Priority weights, 0-100 each. They don't need to sum to 100 - the solver
    // (milp.py's _weighted_objective) only compares their ratio after scaling
    // each axis by its own price/recoil range, so this is purely a display
    // convention borrowed from the reference optimizer's ternary plot.
    function _loadWeight(key, fallback) {
        const stored = localStorage.getItem(key);
        return stored === null ? fallback : Number(stored);
    }
    let _ergoWeight = _loadWeight('eftforge-optimizer-ergo-weight', 33);
    let _recoilWeight = _loadWeight('eftforge-optimizer-recoil-weight', 34);
    let _priceWeight = _loadWeight('eftforge-optimizer-price-weight', 33);
    let _useEvoErgo = localStorage.getItem('eftforge-optimizer-use-evo-ergo') === 'true';
    let _weightUiMode = localStorage.getItem('eftforge-optimizer-weight-ui') || 'triangle'; // 'triangle' | 'sliders'
    let _fleaAvailable = localStorage.getItem('eftforge-optimizer-flea-available') !== 'false';
    let _preventOverswing = localStorage.getItem('eftforge-optimizer-prevent-overswing') === 'true';
    let _requireSuppressor = localStorage.getItem('eftforge-optimizer-require-suppressor') === 'true';

    // User-defined weight presets, stored alongside (not merged into) the 7
    // built-in ones below. Each entry is {id, name, ergo, recoil, price}.
    function _loadCustomPresets() {
        try {
            const parsed = JSON.parse(localStorage.getItem('eftforge-optimizer-custom-presets') || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    function _saveCustomPresets() {
        localStorage.setItem('eftforge-optimizer-custom-presets', JSON.stringify(_customPresets));
    }
    let _customPresets = _loadCustomPresets();
    let _presetAddOpen = false;

    // Mod Filter (GET /build/mods) - cached per weapon+lang so switching tabs
    // or re-rendering doesn't refetch.
    let _modFilterData = null;      // { weaponId, lang, mods: [{id,name,short_name,icon,category,category_priority}] }
    let _modFilterPromise = null;
    let _includedModIds = [];
    let _excludedModIds = [];
    let _modSearch = '';            // category-view search query
    let _modCategoryFilter = '';    // category-view dropdown selection ('' = all)
    // The tile grid can hold hundreds of icons - only build it once per
    // weapon/reset and let the collapse animation just show/hide the already-
    // built DOM, instead of rebuilding it (and re-triggering image decode)
    // every time the section is toggled open.
    let _modFilterBodyRendered = false;
    // True while the picker is popped out full-size over the results pane
    // (see _renderExpandedPicker) instead of sitting in its usual sidebar spot.
    let _pickerExpanded = false;

    // Collapsible section state, matching the reference optimizer's Collapse
    // defaultActiveKey behavior (Weight Adjustment and Hard Constraints start
    // open; Mod Filter and Market & Trader Access start collapsed).
    let _sectionOpen = { weight: true, constraints: true, modFilter: false, market: false };

    // Results-panel "Retained from Preset" group - starts collapsed, unlike the
    // Weight Adjustment/Hard Constraints sections, since it's supplementary info
    // rather than something the user needs to act on for every solve.
    let _retainedOpen = false;

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
        section?.classList.toggle('open', _sectionOpen[id]);
    }

    function _wireSection(id, onReset) {
        document.querySelector(`[data-section-toggle="${id}"]`)?.addEventListener('click', () => _toggleSection(id));
        document.querySelector(`[data-section-reset="${id}"]`)?.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const btn = ev.currentTarget;
            btn.classList.remove('reset-pulse');
            void btn.offsetWidth; // restart the animation on rapid repeat clicks
            btn.classList.add('reset-pulse');
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
    function _tFmt(key, vars) { return window.tFmt ? window.tFmt(key, vars) : _t(key); }

    // Backend infeasibility responses carry either reason_details (a list, from
    // the cheap pre-checks in feasibility.py that can flag several problems at
    // once) or a single reason_key (from the MILP build itself, which only ever
    // fails for one cause at a time). Older/unmapped reasons fall back to the
    // raw English `reason` text so nothing goes silently blank.
    function _formatReason(data) {
        if (Array.isArray(data.reason_details) && data.reason_details.length) {
            return data.reason_details.map(r => _tFmt(r.key, r.params || {})).join('; ');
        }
        if (data.reason_key) return _tFmt(data.reason_key, data.reason_params || {});
        return data.reason || _t('optimizer.infeasible');
    }

    /* ===========================
       PUBLIC API
    =========================== */

    function showPanel() {
        if (isMobileLayout()) return;
        const overlay = document.getElementById('optimizer-overlay');
        const backdrop = document.getElementById('optimizer-backdrop');
        if (!overlay) return;

        overlay.classList.add('visible');
        if (backdrop) backdrop.classList.add('visible');
        // Holds the edge-tab rail in its expanded (hover) look for as long as the
        // drawer is open, independent of the mouse - see .optimizer-edge-tab-drawer-open
        // in styles.css.
        document.getElementById('optimizer-edge-tab')?.classList.add('optimizer-edge-tab-drawer-open');
        document.getElementById('main-container')?.setAttribute('inert', '');
        if (document.activeElement) document.activeElement.blur();

        // Keep the last solved build on screen across a close/reopen of the drawer,
        // but only for the gun it was actually solved for - reopening on a different
        // gun should land back on the placeholder rather than show a stale build.
        const currentGunId = window.EFTForge.state?.currentGun?.id;
        if (!_result || _result.gun_id !== currentGunId) _result = null;
        if (_explore?.gun_id !== currentGunId) _explore = null;
        _error = null;
        _render(true);
    }

    function hidePanel() {
        const overlay = document.getElementById('optimizer-overlay');
        const backdrop = document.getElementById('optimizer-backdrop');
        if (overlay) overlay.classList.remove('visible');
        if (backdrop) backdrop.classList.remove('visible');
        document.getElementById('optimizer-edge-tab')?.classList.remove('optimizer-edge-tab-drawer-open');
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
        _render(true);
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
        // Skipped while publishMode is true: showPublishConfirmPanel sets it before
        // wiping the placeholder for its confirm screen, and the rail has no reason
        // to show there. build-manager.js flips it back to false before
        // _restoreNormalPlaceholder runs, so the tab correctly reappears once the
        // user leaves that screen (cancel, modify, or confirm).
        // Keep the optimizer desktop-only, same as community publishing/comments
        // (see #profile-nav-btn's mobile hide in styles.css) - the constraint
        // widgets and ternary drag-plot aren't built for touch. Skip creating the
        // edge-tab entirely here rather than just CSS-hiding it, so there's no
        // element left for showPanel() to be invoked against on mobile.
        const placeholder = document.getElementById('attachment-placeholder');
        if (placeholder && !isMobileLayout()) {
            _ensureEdgeTab(placeholder);
            // The static tab in index.html ships with optimizer-edge-tab-pulse-snap
            // hardcoded (so a first-ever visitor gets the pre-expanded intro state
            // from their very first paint - see pulse()'s comment). _ensureEdgeTab
            // no-ops when that element already exists, so a returning user (whose
            // localStorage already says they've seen it) needs it stripped
            // explicitly here instead, or it'd render stuck expanded forever with
            // nothing left to ever remove it. This runs synchronously before the
            // browser's first paint (this script isn't deferred/async), so there's
            // no visible flash either way.
            if (_hasPulsed) document.getElementById('optimizer-edge-tab')?.classList.remove('optimizer-edge-tab-pulse-snap');
            new MutationObserver(() => {
                if (!EFTForge.state.publishMode) _ensureEdgeTab(placeholder);
            }).observe(placeholder, { childList: true });
        }
        onLangChange(); // sync the edge-tab label with the saved language preference on first paint
    }

    // Keep this markup in sync with the static #optimizer-edge-tab in index.html -
    // this rebuilds it after a wholesale placeholder innerHTML replace wipes it out.
    // The logo is the reference optimizer's crosshair-reticle favicon.
    function _edgeTabInnerHtml() {
        return `
            <div class="optimizer-edge-tab-glow optimizer-edge-tab-glow-rest"></div>
            <div class="optimizer-edge-tab-glow optimizer-edge-tab-glow-hover"></div>
            <div class="optimizer-edge-tab-clip">
                <span class="optimizer-edge-tab-content">
                    <svg class="optimizer-edge-tab-logo" viewBox="0 0 128 128" fill="none" stroke="currentColor" aria-hidden="true">
                        <circle cx="64" cy="64" r="56" stroke-width="8"/>
                        <circle cx="64" cy="64" r="28" stroke-width="6"/>
                        <circle cx="64" cy="64" r="6" fill="currentColor" stroke="none"/>
                        <line x1="64" y1="4" x2="64" y2="28" stroke-width="6"/>
                        <line x1="64" y1="100" x2="64" y2="124" stroke-width="6"/>
                        <line x1="4" y1="64" x2="28" y2="64" stroke-width="6"/>
                        <line x1="100" y1="64" x2="124" y2="64" stroke-width="6"/>
                    </svg>
                    <span class="optimizer-edge-tab-label" id="optimizer-edge-tab-label">${_t('optimizer.title')}</span>
                </span>
            </div>
        `;
    }

    function _ensureEdgeTab(placeholder) {
        if (document.getElementById('optimizer-edge-tab')) return;
        const tab = document.createElement('div');
        tab.id = 'optimizer-edge-tab';
        // Only pre-expanded (see pulse()'s comment) if this user has never seen the
        // intro (tracked in localStorage, not just this session). Without this
        // check, a placeholder rebuild later on (e.g. _restoreNormalPlaceholder
        // after the publish-confirm flow) would recreate the tab already-expanded
        // again, but pulse() would never fire again to collapse it - leaving it
        // stuck expanded for good.
        tab.className = _hasPulsed ? 'optimizer-edge-tab' : 'optimizer-edge-tab optimizer-edge-tab-pulse-snap';
        tab.addEventListener('click', showPanel);
        tab.innerHTML = _edgeTabInnerHtml();
        placeholder.appendChild(tab);
    }

    // Draws the eye to the optimizer rail the very first time this user ever opens a
    // gun's build panel (called from selectGun in gun-list.js), by replaying the
    // rail's own mouse-leave collapse - no bespoke pulse animation. The tab already ships
    // with .optimizer-edge-tab-pulse-snap applied (index.html / _ensureEdgeTab above)
    // so it's rendered fully expanded, transitions disabled, from its very first
    // paint - there's nothing before that first paint for it to have collapsed FROM,
    // so there's no collapsed-then-snapped-open flicker to begin with. Removing the
    // class after a short hold is then just a normal style change back to rest,
    // which the base rule's own transition (the collapse curve) picks up and
    // animates - the only motion that ever plays is that one-time collapse.
    // Deferred two frames before removing it because selectGun un-hides the right
    // panel (removes .no-gun) in the same tick; we wait for that reveal to commit
    // and re-query the current tab (the MutationObserver may have re-appended it as
    // a fresh node) before touching it.
    const PULSE_HOLD_MS = 555; // how long the rail stays expanded before collapsing

    // Once-ever gate, persisted in localStorage (not sessionStorage/in-memory): once
    // this user has seen the intro on any visit, it must never play again, on any
    // future page load or refresh either.
    const PULSE_SEEN_KEY = 'eftforge_optimizer_intro_pulsed';
    let _hasPulsed = localStorage.getItem(PULSE_SEEN_KEY) === 'true';

    function pulse() {
        // Don't burn the once-ever "seen it" flag on a device that never gets
        // the edge-tab in the first place - a mobile-first visitor should still
        // get the intro pulse the first time they show up on desktop.
        if (isMobileLayout() || _hasPulsed) return;
        _hasPulsed = true;
        localStorage.setItem(PULSE_SEEN_KEY, 'true');
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const tab = document.getElementById('optimizer-edge-tab');
            if (!tab) return;
            setTimeout(() => tab.classList.remove('optimizer-edge-tab-pulse-snap'), PULSE_HOLD_MS);
        }));
    }

    /* ===========================
       SHARED HELPERS
    =========================== */

    function _creditHtml() {
        const link = `<a href="https://ahaimk01.github.io/tarkov-weapon-optimizer/" target="_blank" rel="noopener noreferrer">${_t('optimizer.creditLinkText')}</a>`;
        const text = window.tFmt ? window.tFmt('optimizer.creditText', { link }) : '';
        // Same crosshair-reticle mark as the panel header/edge-tab (_edgeTabInnerHtml),
        // shrunk down to sit inline with the watermark text.
        const logo = `
            <svg class="optimizer-credit-logo" viewBox="0 0 128 128" fill="none" stroke="currentColor" aria-hidden="true">
                <circle cx="64" cy="64" r="56" stroke-width="8"/>
                <circle cx="64" cy="64" r="28" stroke-width="6"/>
                <circle cx="64" cy="64" r="6" fill="currentColor" stroke="none"/>
                <line x1="64" y1="4" x2="64" y2="28" stroke-width="6"/>
                <line x1="64" y1="100" x2="64" y2="124" stroke-width="6"/>
                <line x1="4" y1="64" x2="28" y2="64" stroke-width="6"/>
                <line x1="100" y1="64" x2="124" y2="64" stroke-width="6"/>
            </svg>`;
        return `${logo}<span>${text}</span>`;
    }

    function _escape(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }

    function _switchTab(tab) {
        if (_solving) return;
        _activeTab = tab;
        _result = tab === 'explore' ? (_explore?.points[_exploreSelected]?.build || null) : null;
        _error = null;
        _render(true);
    }

    /* ===========================
       ROOT RENDER (tab strip + active tab's form)
    =========================== */

    function _render(preserveSettings = false) {
        const body = document.getElementById('optimizer-panel-body');
        if (!body) return;

        if (!GUNSMITH_ENABLED && _activeTab === 'gunsmith') _activeTab = OPTIMIZE_ENABLED ? 'optimize' : 'explore';
        if (!OPTIMIZE_ENABLED && _activeTab === 'optimize') _activeTab = 'explore';

        // With only one mode enabled, the toggle row has nothing to switch between -
        // hide it rather than show a single-button strip.
        const showTabStrip = OPTIMIZE_ENABLED || GUNSMITH_ENABLED;

        const tabStripHtml = !showTabStrip ? '' : `
            <div class="modal-row">
                ${OPTIMIZE_ENABLED ? `<button class="toggle-btn ${_activeTab === 'optimize' ? 'active' : ''}" id="optimizer-tab-optimize" ${_solving ? 'disabled' : ''}>${_t('optimizer.tabOptimize')}</button>` : ''}
                <button class="toggle-btn ${_activeTab === 'explore' ? 'active' : ''}" id="optimizer-tab-explore" ${_solving ? 'disabled' : ''}>${_t('optimizer.tabExplore')}</button>
                ${GUNSMITH_ENABLED ? `<button class="toggle-btn ${_activeTab === 'gunsmith' ? 'active' : ''}" id="optimizer-tab-gunsmith">${_t('optimizer.tabGunsmith')}</button>` : ''}
            </div>
        `;

        body.innerHTML = `
            ${tabStripHtml}
            <div id="optimizer-tab-content"></div>
        `;

        // Lives outside .optimizer-panel-body as a fixed watermark (see styles.css
        // .optimizer-credit), so it's set once here rather than rebuilt on every
        // tab switch along with the rest of the panel body.
        const credit = document.getElementById('optimizer-credit');
        if (credit) credit.innerHTML = _creditHtml();

        document.getElementById('optimizer-tab-optimize')?.addEventListener('click', () => _switchTab('optimize'));
        document.getElementById('optimizer-tab-explore')?.addEventListener('click', () => _switchTab('explore'));
        document.getElementById('optimizer-tab-gunsmith')?.addEventListener('click', () => _switchTab('gunsmith'));

        if (_activeTab !== 'gunsmith') {
            _renderOptimizeTab(preserveSettings);
            if (_activeTab === 'explore') _renderExploreControls();
        }
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

    function _customPresetRowHtml() {
        const items = _customPresets.map(p => `
            <div class="optimizer-preset-custom-item">
                <button type="button" class="optimizer-preset-btn optimizer-preset-btn-custom" data-preset-apply="${_escape(p.id)}">${_escape(p.name)}</button>
                <button type="button" class="optimizer-preset-delete-btn" data-preset-delete="${_escape(p.id)}" data-tooltip="${_escape(_t('optimizer.presetDeleteTitle'))}">&#x2715;</button>
            </div>
        `).join('');
        return `${items}<button type="button" class="optimizer-preset-add-btn" id="optimizer-preset-add-btn" title="${_escape(_t('optimizer.presetSaveTitle'))}">+</button>`;
    }

    function _confirmDeletePreset(btn, id) {
        if (btn.dataset.confirming === '1') {
            _customPresets = _customPresets.filter(p => p.id !== id);
            _saveCustomPresets();
            _renderCustomPresetRow();
            return;
        }
        btn.dataset.confirming = '1';
        btn.classList.add('confirming');
        btn.dataset.tooltip = _t('ui.confirm');
        window.EFTForge.tooltip?.refresh(btn);
        const reset = () => {
            if (btn.dataset.confirming !== '1') return;
            delete btn.dataset.confirming;
            btn.classList.remove('confirming');
            btn.dataset.tooltip = _t('optimizer.presetDeleteTitle');
            window.EFTForge.tooltip?.refresh(btn);
        };
        setTimeout(reset, 3000);
        btn.addEventListener('mouseleave', reset, { once: true });
    }

    function _renderCustomPresetRow() {
        const el = document.getElementById('optimizer-preset-custom-row');
        if (!el) return;
        el.innerHTML = _customPresetRowHtml();

        el.querySelectorAll('[data-preset-apply]').forEach(btn => {
            btn.addEventListener('click', () => {
                const preset = _customPresets.find(p => p.id === btn.dataset.presetApply);
                if (preset) _setWeights(preset.ergo, preset.recoil, preset.price);
            });
        });
        el.querySelectorAll('[data-preset-delete]').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                _confirmDeletePreset(btn, btn.dataset.presetDelete);
            });
        });
        document.getElementById('optimizer-preset-add-btn').addEventListener('click', _toggleAddPresetForm);
    }

    function _presetAddFormHtml() {
        return `
            <input type="text" class="optimizer-input optimizer-preset-name-input" id="optimizer-preset-name-input"
                   placeholder="${_escape(_t('optimizer.presetNamePlaceholder'))}" maxlength="30">
            <button type="button" class="optimizer-preset-btn" id="optimizer-preset-add-confirm">${_t('modal.saveBtn')}</button>
            <button type="button" class="optimizer-preset-btn" id="optimizer-preset-add-cancel">${_t('ui.cancel')}</button>
        `;
    }

    function _toggleAddPresetForm() {
        const row = document.getElementById('optimizer-preset-add-row');
        if (!row) return;
        _presetAddOpen = !_presetAddOpen;
        if (!_presetAddOpen) {
            row.classList.remove('open');
            row.innerHTML = '';
            return;
        }
        row.classList.add('open');
        row.innerHTML = _presetAddFormHtml();
        const input = document.getElementById('optimizer-preset-name-input');
        input.focus();
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') _confirmAddPreset();
            else if (ev.key === 'Escape') _toggleAddPresetForm();
        });
        document.getElementById('optimizer-preset-add-confirm').addEventListener('click', _confirmAddPreset);
        document.getElementById('optimizer-preset-add-cancel').addEventListener('click', _toggleAddPresetForm);
    }

    function _confirmAddPreset() {
        const input = document.getElementById('optimizer-preset-name-input');
        const name = input.value.trim().slice(0, 30);
        if (!name) {
            input.focus();
            return;
        }
        _customPresets.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name,
            ergo: _ergoWeight,
            recoil: _recoilWeight,
            price: _priceWeight,
        });
        _saveCustomPresets();
        _toggleAddPresetForm();
        _renderCustomPresetRow();
    }

    function _setWeights(ergo, recoil, price) {
        _ergoWeight = ergo;
        _recoilWeight = recoil;
        _priceWeight = price;
        localStorage.setItem('eftforge-optimizer-ergo-weight', String(ergo));
        localStorage.setItem('eftforge-optimizer-recoil-weight', String(recoil));
        localStorage.setItem('eftforge-optimizer-price-weight', String(price));
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
            document.getElementById('optimizer-tp-svg')?.addEventListener('mousedown', _tpHandleMouseDown);
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
        localStorage.setItem('eftforge-optimizer-use-evo-ergo', String(value));
        document.getElementById('optimizer-evo-ergo-toggle')?.classList.toggle('active', value);
        _renderWeightWidget();
    }

    function _setFleaAvailable(value) {
        _fleaAvailable = value;
        localStorage.setItem('eftforge-optimizer-flea-available', String(value));
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
        localStorage.setItem('eftforge-optimizer-prevent-overswing', String(value));
        document.getElementById('optimizer-overswing-toggle')?.classList.toggle('active', value);
    }

    function _setRequireSuppressor(value) {
        _requireSuppressor = value;
        localStorage.setItem('eftforge-optimizer-require-suppressor', String(value));
        document.getElementById('optimizer-suppressor-toggle')?.classList.toggle('active', value);
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

    // Icon+shortname tile for the category view - a click on + / - drives the
    // same _includedModIds/_excludedModIds arrays everything else reads.
    function _partTileHtml(item) {
        const isIncluded = _includedModIds.includes(item.id);
        const isExcluded = _excludedModIds.includes(item.id);
        const stateClass = isIncluded ? ' mf-tile-included' : (isExcluded ? ' mf-tile-excluded' : '');
        return `
            <div class="mf-tile${stateClass}">
                <div class="mf-tile-icon-wrap attachment-icon-wrapper">
                    <img class="attachment-icon" src="${_escape(item.icon_link || item.icon || '')}" loading="lazy" decoding="async" data-tooltip="${_escape(item.name || '')}" onerror="this.style.visibility='hidden'">
                    <div class="slot-shortname">${_escape(item.short_name || '')}</div>
                    <button type="button" class="mf-tile-btn mf-tile-require${isIncluded ? ' active' : ''}" data-require-id="${_escape(item.id)}">+</button>
                    <button type="button" class="mf-tile-btn mf-tile-ban${isExcluded ? ' active' : ''}" data-ban-id="${_escape(item.id)}">-</button>
                </div>
            </div>
        `;
    }

    // Sights/scopes, then tactical devices, sort ahead of everything else -
    // driven by the language-agnostic category_priority the backend derives
    // from tarkov.dev's raw category ids (0/1), default 2 for everything else.
    function _sortCategoriesByPriority(catNames, priorityByCat) {
        return [...catNames].sort((a, b) => {
            const pa = priorityByCat.get(a) ?? 2;
            const pb = priorityByCat.get(b) ?? 2;
            return pa !== pb ? pa - pb : a.localeCompare(b);
        });
    }

    // Groups a flat item list by its resolved Handbook category (falls back to
    // "Other" for items without one) and renders a header + tile grid per group.
    function _groupedTilesHtml(items) {
        if (!items.length) return `<div class="optimizer-filter-empty">${_t('optimizer.noMatches')}</div>`;
        const groups = new Map();
        const priorityByCat = new Map();
        for (const item of items) {
            const cat = item.category || _t('optimizer.otherCategory');
            if (!groups.has(cat)) groups.set(cat, []);
            groups.get(cat).push(item);
            const p = item.category_priority ?? 2;
            if (!priorityByCat.has(cat) || p < priorityByCat.get(cat)) priorityByCat.set(cat, p);
        }
        const sortedCats = _sortCategoriesByPriority(groups.keys(), priorityByCat);
        return sortedCats.map(cat => `
            <div class="mf-tile-group">
                <div class="mf-tile-group-header">${_escape(cat)}</div>
                <div class="mf-tile-grid">${groups.get(cat).map(_partTileHtml).join('')}</div>
            </div>
        `).join('');
    }

    // Wires every tile's +/- button inside container to the shared lock/ban
    // toggles (also used by the results-manifest table), then re-renders
    // whatever local surface onChange points at so the tile highlight/counts
    // reflect the new state immediately.
    function _wireTileButtons(container, onChange) {
        container.querySelectorAll('[data-require-id]').forEach(btn => btn.addEventListener('click', () => {
            _toggleManifestLock(btn.dataset.requireId);
            onChange();
        }));
        container.querySelectorAll('[data-ban-id]').forEach(btn => btn.addEventListener('click', () => {
            _toggleManifestBan(btn.dataset.banId);
            onChange();
        }));
    }

    // Flat, togglable view of every attachment reachable anywhere on this
    // weapon (GET /build/mods), grouped by Handbook category.
    function _renderModFilterCategoryView(container, expanded = false) {
        const priorityByCat = new Map();
        for (const m of _modFilterData.mods) {
            if (!m.category) continue;
            const p = m.category_priority ?? 2;
            if (!priorityByCat.has(m.category) || p < priorityByCat.get(m.category)) priorityByCat.set(m.category, p);
        }
        const categoryNames = new Set(_modFilterData.mods.map(m => m.category).filter(Boolean));
        const categories = _sortCategoriesByPriority(categoryNames, priorityByCat);
        container.innerHTML = `
            <div class="mf-picker-toolbar">
                <input type="text" class="optimizer-input" id="mf-cat-search" placeholder="${_t('optimizer.searchMods')}" autocomplete="off" value="${_escape(_modSearch)}">
                <select class="optimizer-input mf-category-select" id="mf-cat-select">
                    <option value="">${_t('optimizer.allCategories')}</option>
                    ${categories.map(c => `<option value="${_escape(c)}"${c === _modCategoryFilter ? ' selected' : ''}>${_escape(c)}</option>`).join('')}
                </select>
                ${expanded ? '' : `<button type="button" class="mf-picker-expand-btn" id="mf-picker-expand-btn" title="${_escape(_t('optimizer.expandPicker'))}">&#x3E;&#x3E;&#x3E;</button>`}
            </div>
            <span class="optimizer-filter-hint">${_t('optimizer.pickerHint')}</span>
            <div class="mf-tile-scroll${expanded ? ' mf-tile-scroll-expanded' : ''}" id="mf-cat-results"></div>
        `;

        if (!expanded) {
            document.getElementById('mf-picker-expand-btn').addEventListener('click', () => {
                _pickerExpanded = true;
                _renderModFilterWidget();
                _renderResult();
                _swipePicker(document.getElementById('mf-view-body'), 'right');
                _swipePicker(_resultsContainer(), 'right');
            });
        }

        // The picker sits at the bottom of .optimizer-config-pane, which has its
        // own scrollbar. Without this, a wheel gesture over the picker scrolls
        // the picker's short inner list instead of the pane, so the user can
        // never wheel-scroll the pane past it. Route wheel input to the pane
        // until the pane itself is scrolled all the way down, then hand control
        // to the picker's own scroll like normal. Not needed once expanded - it
        // fills the whole results pane and isn't nested inside another scroller.
        const pickerScroll = document.getElementById('mf-cat-results');
        const configPane = pickerScroll.closest('.optimizer-config-pane');
        if (configPane) {
            pickerScroll.addEventListener('wheel', (e) => {
                const atBottom = configPane.scrollTop + configPane.clientHeight >= configPane.scrollHeight - 1;
                if (!atBottom) {
                    e.preventDefault();
                    configPane.scrollTop += e.deltaY;
                }
            }, { passive: false });
        }

        function renderResults() {
            const resultsEl = document.getElementById('mf-cat-results');
            if (!resultsEl) return;
            const q = _modSearch.trim().toLowerCase();
            const filtered = _modFilterData.mods.filter(m =>
                (!q || (m.name || '').toLowerCase().includes(q)) &&
                (!_modCategoryFilter || m.category === _modCategoryFilter)
            );
            resultsEl.innerHTML = _groupedTilesHtml(filtered);
            _wireTileButtons(resultsEl, renderResults);
        }

        // The grid can hold hundreds of tiles, so rebuilding it on every single
        // keystroke stalls the main thread while typing - debounce it instead.
        let searchDebounce = null;
        document.getElementById('mf-cat-search').addEventListener('input', (e) => {
            _modSearch = e.target.value;
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(renderResults, 120);
        });
        document.getElementById('mf-cat-select').addEventListener('change', (e) => {
            _modCategoryFilter = e.target.value;
            renderResults();
        });
        if (typeof setupCustomSelect === 'function') setupCustomSelect('mf-cat-select');
        renderResults();
    }

    function _renderModFilterWidget() {
        const el = document.getElementById('optimizer-mod-filter-widget');
        if (!el) return;

        const weaponId = window.EFTForge.state?.currentGun?.id;
        const lang = (window.EFTForge.state && window.EFTForge.state.lang) || 'en';
        if (!_modFilterData || _modFilterData.weaponId !== weaponId || _modFilterData.lang !== lang) {
            el.innerHTML = `<div class="optimizer-filter-loading">${_t('optimizer.loadingMods')}</div>`;
            _modFilterBodyRendered = false;
            if (!weaponId) return;
            _fetchModFilterData(weaponId).then(() => _renderModFilterWidget()).catch(() => {
                el.innerHTML = `<div class="optimizer-error">${_t('optimizer.modsLoadFailed')}</div>`;
            });
            return;
        }

        const modTags = _filterTagsHtml(_includedModIds, _modFilterData.mods, 'include')
            + _filterTagsHtml(_excludedModIds, _modFilterData.mods, 'exclude');

        el.innerHTML = `
            <div class="optimizer-filter-group">
                ${modTags ? `<div class="optimizer-filter-tags">${modTags}</div>` : ''}
                <div id="mf-view-body"></div>
            </div>
        `;

        el.querySelectorAll('[data-remove-id]').forEach(tag => tag.addEventListener('click', () => {
            const id = tag.dataset.removeId;
            _includedModIds = _includedModIds.filter(m => m !== id);
            _excludedModIds = _excludedModIds.filter(m => m !== id);
            _renderModFilterWidget();
            _syncManifestIcons();
            _refreshExpandedPicker();
        }));

        // While popped out over the results pane, the real toolbar/grid lives
        // there instead - leave a short note here rather than building it twice.
        if (_pickerExpanded) {
            document.getElementById('mf-view-body').innerHTML =
                `<div class="optimizer-filter-expanded-note">${_t('optimizer.pickerExpandedNote')}</div>`;
            _modFilterBodyRendered = false;
            return;
        }

        // The tile grid can hold hundreds of icons - only build it while the
        // section is actually visible, so opening the drawer (and toggling
        // every other section) doesn't pay for it up front.
        if (_sectionOpen.modFilter) {
            _renderModFilterCategoryView(document.getElementById('mf-view-body'));
            _modFilterBodyRendered = true;
        }
    }

    // The Attachment Filtering picker, when popped out, renders into the results
    // pane (see _renderExpandedPicker) instead of its usual spot in the sidebar.
    // Anything that mutates filter state from a control the popout doesn't own
    // (the sidebar's tag pills, its section-reset button) needs this to keep the
    // popped-out grid from going stale.
    function _refreshExpandedPicker() {
        if (_pickerExpanded) _renderResult();
    }

    // Retriggerable directional entrance swipe for the pop-out/collapse transition,
    // mirroring the .table-slide-in idiom used elsewhere (slot-selector.js, graph.js):
    // remove -> force reflow -> add -> clean up on animationend so it always retriggers.
    // 'right' plays on expand (sidebar's placeholder and the results-pane popout both
    // swipe in from the left); 'left' plays on collapse (the reverse).
    function _swipePicker(el, dir) {
        if (!el) return;
        const cls = dir === 'right' ? 'picker-swipe-in-right' : 'picker-swipe-in-left';
        el.classList.remove('picker-swipe-in-right', 'picker-swipe-in-left');
        void el.offsetWidth;
        el.classList.add(cls);
        el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
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

    // Only persist the budget constraint across panel reopens - minErgo/minMag/
    // maxSpread stay session-only.
    function _persistBudgetConstraint() {
        localStorage.setItem('eftforge-optimizer-budget-on', String(_constraintState.budget.on));
        localStorage.setItem('eftforge-optimizer-budget-value', String(_constraintState.budget.value));
    }

    function _loadPersistedBudget() {
        _constraintState.budget.on = localStorage.getItem('eftforge-optimizer-budget-on') === 'true';
        const storedValue = Number(localStorage.getItem('eftforge-optimizer-budget-value'));
        if (!Number.isNaN(storedValue) && storedValue > 0) _constraintState.budget.value = storedValue;
    }

    // Full reset for opening the panel on a (possibly different) weapon -
    // also drops the cached per-weapon ranges, unlike _resetConstraintValues()
    // which the "reset section" button uses (same weapon, no need to refetch).
    function _resetConstraintState() {
        _resetConstraintValues();
        _loadPersistedBudget();
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
        const index = Math.max(0, _magCapacityValues.indexOf(state.value));
        return `
            <div class="optimizer-constraint-slider-row" data-mag-slider>
                <div class="optimizer-slider-track">
                    <input type="range" min="0" max="${_magCapacityValues.length - 1}" step="1" value="${index}">
                    <div class="optimizer-slider-ticks" data-mag-ticks>
                        ${_magCapacityValues.map((v, i) => `<span class="${i === index ? 'active' : ''}">${v}</span>`).join('')}
                    </div>
                </div>
            </div>
        `;
    }

    function _wireMinMagDetail(detail) {
        const magSlider = detail.querySelector('[data-mag-slider] input[type="range"]');
        magSlider?.addEventListener('input', () => _setMinMagIndex(Number(magSlider.value)));
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
        if (key === 'budget') _persistBudgetConstraint();
        const row = document.querySelector(`[data-constraint-slider="${key}"]`);
        if (!row) return;
        const [range, number] = row.querySelectorAll('input');
        range.value = state.value;
        number.value = state.value;
    }

    function _setMinMagIndex(index) {
        if (!_magCapacityValues) return;
        _constraintState.minMag.value = _magCapacityValues[index];
        const ticks = document.querySelectorAll('[data-mag-ticks] span');
        ticks.forEach((el, i) => el.classList.toggle('active', i === index));
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
                if (def.key === 'budget') _persistBudgetConstraint();
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

    function _renderOptimizeTab(preserveSettings = false) {
        const content = document.getElementById('optimizer-tab-content');
        if (!content) return;

        // Reload every persisted Weight Adjustment setting from localStorage on
        // each panel open instead of resetting to a hardcoded default - weights,
        // evo ergo, prevent overswing, require suppressor and flea availability
        // (plus the budget constraint, via _resetConstraintState -> _loadPersistedBudget
        // below) all survive a panel close/reopen this way.
        _ergoWeight = _loadWeight('eftforge-optimizer-ergo-weight', 33);
        _recoilWeight = _loadWeight('eftforge-optimizer-recoil-weight', 34);
        _priceWeight = _loadWeight('eftforge-optimizer-price-weight', 33);
        _useEvoErgo = localStorage.getItem('eftforge-optimizer-use-evo-ergo') === 'true';
        _fleaAvailable = localStorage.getItem('eftforge-optimizer-flea-available') !== 'false';
        _preventOverswing = localStorage.getItem('eftforge-optimizer-prevent-overswing') === 'true';
        _requireSuppressor = localStorage.getItem('eftforge-optimizer-require-suppressor') === 'true';
        _customPresets = _loadCustomPresets();
        _presetAddOpen = false;
        const settingsWeaponId = window.EFTForge.state?.currentGun?.id;
        if (!preserveSettings || _settingsWeaponId !== settingsWeaponId) {
            _resetConstraintState();
            _includedModIds = [];
            _excludedModIds = [];
        }
        _settingsWeaponId = settingsWeaponId;
        _modSearch = '';
        _modCategoryFilter = '';
        _modFilterBodyRendered = false;
        _pickerExpanded = false;

        const currentGun = window.EFTForge.state && window.EFTForge.state.currentGun;
        const weaponId = currentGun ? currentGun.id : null;

        content.innerHTML = `
          <div class="optimizer-two-pane">
            <div class="optimizer-config-pane">
            <div class="optimizer-section${_sectionOpen.weight ? ' open' : ''}" data-section="weight">
                ${_sectionHeaderHtml('weight', 'optimizer.weightAdjustment')}
                <div class="optimizer-section-body" data-section-body>
                  <div class="optimizer-section-body-inner">
                   <div class="optimizer-section-body-content">
                    <div class="optimizer-preset-row">
                        <button type="button" class="optimizer-preset-btn" id="optimizer-preset-recoil">${_t('optimizer.presetRecoil')}</button>
                        <button type="button" class="optimizer-preset-btn" id="optimizer-preset-ergo">${_t('optimizer.presetErgo')}</button>
                        <button type="button" class="optimizer-preset-btn" id="optimizer-preset-balanced">${_t('optimizer.presetBalanced')}</button>
                        <button type="button" class="optimizer-preset-btn" id="optimizer-preset-min-operable">${_t('optimizer.presetMinOperable')}</button>
                        <button type="button" class="optimizer-preset-btn" id="optimizer-preset-performance">${_t('optimizer.presetPerformance')}</button>
                        <button type="button" class="optimizer-preset-btn" id="optimizer-preset-recoil-focus">${_t('optimizer.presetRecoilFocus')}</button>
                        <button type="button" class="optimizer-preset-btn" id="optimizer-preset-ergo-focus">${_t('optimizer.presetErgoFocus')}</button>
                        <span class="optimizer-preset-custom-slot" id="optimizer-preset-custom-row"></span>
                    </div>
                    <div class="optimizer-preset-add-row" id="optimizer-preset-add-row"></div>
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
                </div>
            </div>

            <div class="optimizer-section${_sectionOpen.constraints ? ' open' : ''}" data-section="constraints">
                ${_sectionHeaderHtml('constraints', 'optimizer.constraints')}
                <div class="optimizer-section-body" data-section-body>
                  <div class="optimizer-section-body-inner">
                   <div class="optimizer-section-body-content">
                    <div class="optimizer-toggle-row">
                        <span class="stat-label">${_t('optimizer.preventOverswing')}</span>
                        <button type="button" class="compare-toggle${_preventOverswing ? ' active' : ''}" id="optimizer-overswing-toggle">
                            <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                        </button>
                    </div>
                    <div class="optimizer-toggle-row">
                        <span class="stat-label">${_t('optimizer.requireSuppressor')}</span>
                        <button type="button" class="compare-toggle${_requireSuppressor ? ' active' : ''}" id="optimizer-suppressor-toggle">
                            <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                        </button>
                    </div>
                    <div id="optimizer-constraints-widget"></div>
                   </div>
                  </div>
                </div>
            </div>

            <div class="optimizer-section${_sectionOpen.market ? ' open' : ''}" data-section="market">
                ${_sectionHeaderHtml('market', 'optimizer.marketAccess')}
                <div class="optimizer-section-body" data-section-body>
                  <div class="optimizer-section-body-inner">
                   <div class="optimizer-section-body-content">
                    <div class="optimizer-toggle-row">
                        <span class="stat-label">${_t('optimizer.fleaAvailable')}</span>
                        <button type="button" class="compare-toggle${_fleaAvailable ? ' active' : ''}" id="optimizer-flea-toggle">
                            <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                        </button>
                    </div>
                    <div id="optimizer-trader-access-widget"></div>
                   </div>
                  </div>
                </div>
            </div>

            <div class="optimizer-section${_sectionOpen.modFilter ? ' open' : ''}" data-section="modFilter">
                ${_sectionHeaderHtml('modFilter', 'optimizer.modFilter')}
                <div class="optimizer-section-body" data-section-body>
                  <div class="optimizer-section-body-inner">
                   <div class="optimizer-section-body-content">
                    <div id="optimizer-mod-filter-widget"></div>
                   </div>
                  </div>
                </div>
            </div>

            </div>

            <div class="optimizer-results-pane" id="optimizer-results-pane"></div>
          </div>
        `;

        // Mirrors the main attachment table's header-pinned toggle (styles.css
        // .attachment-table.header-pinned), but scoped to this pane's own scroll
        // instead of .right-panel since the results pane now scrolls independently.
        const resultsPane = document.getElementById('optimizer-results-pane');
        if (resultsPane) {
            let pinnedTable = null;
            let isHeaderPinned = false;
            resultsPane.addEventListener('scroll', () => {
                const table = resultsPane.querySelector('.optimizer-manifest-table');
                if (!table) return;
                if (table !== pinnedTable) {
                    pinnedTable = table;
                    isHeaderPinned = table.classList.contains('header-pinned');
                }
                const shouldPin = resultsPane.scrollTop > 10;
                if (shouldPin !== isHeaderPinned) {
                    isHeaderPinned = shouldPin;
                    table.classList.toggle('header-pinned', shouldPin);
                }
            }, { passive: true });
            setupEdgePanScroll(resultsPane);
        }

        document.getElementById('optimizer-preset-recoil').addEventListener('click', () => _setWeights(0, 100, 0));
        document.getElementById('optimizer-preset-ergo').addEventListener('click', () => _setWeights(100, 0, 0));
        document.getElementById('optimizer-preset-balanced').addEventListener('click', () => _setWeights(33, 34, 33));
        document.getElementById('optimizer-preset-min-operable').addEventListener('click', () => _setWeights(0, 0, 100));
        document.getElementById('optimizer-preset-performance').addEventListener('click', () => _setWeights(48, 48, 2));
        document.getElementById('optimizer-preset-recoil-focus').addEventListener('click', () => _setWeights(20, 70, 10));
        document.getElementById('optimizer-preset-ergo-focus').addEventListener('click', () => _setWeights(70, 20, 10));
        _renderCustomPresetRow();
        document.getElementById('optimizer-evo-ergo-toggle').addEventListener('click', () => _setUseEvoErgo(!_useEvoErgo));
        document.getElementById('optimizer-weight-ui-sliders-btn').addEventListener('click', () => _setWeightUiMode('sliders'));
        document.getElementById('optimizer-weight-ui-triangle-btn').addEventListener('click', () => _setWeightUiMode('triangle'));
        _renderWeightWidget();
        _wireSection('weight', () => _setWeights(33, 34, 33));

        document.getElementById('optimizer-overswing-toggle').addEventListener('click', () => _setPreventOverswing(!_preventOverswing));
        document.getElementById('optimizer-suppressor-toggle').addEventListener('click', () => _setRequireSuppressor(!_requireSuppressor));
        _renderConstraints();
        if (weaponId) {
            _fetchStatRanges(weaponId).then(ranges => {
                _applyStatRanges(ranges);
                _renderConstraints();
            }).catch(() => {});
        }
        _wireSection('constraints', () => {
            _setPreventOverswing(false);
            _setRequireSuppressor(false);
            _resetConstraintValues();
            _persistBudgetConstraint();
            _renderConstraints();
        });

        _renderModFilterWidget();
        _wireSection('modFilter', () => {
            _includedModIds = [];
            _excludedModIds = [];
            _modSearch = '';
            _modCategoryFilter = '';
            _renderModFilterWidget();
            _syncManifestIcons();
            _refreshExpandedPicker();
        });
        // _wireSection above already flipped _sectionOpen.modFilter by the time
        // this runs (both listeners are on the same toggle element). Build the
        // tile grid the first time the section is opened; on every later
        // toggle the DOM is already there, so just let the CSS transition
        // show/hide it instead of rebuilding (and re-decoding every icon).
        document.querySelector('[data-section-toggle="modFilter"]')?.addEventListener('click', () => {
            if (_sectionOpen.modFilter && !_modFilterBodyRendered) _renderModFilterWidget();
        });

        document.getElementById('optimizer-flea-toggle').addEventListener('click', () => _setFleaAvailable(!_fleaAvailable));
        _wireSection('market', () => {
            _setFleaAvailable(true);
            resetTraderLevels();
        });
        _renderTraderAccessWidget();

        _renderResult();
    }

    async function _solveOptimize() {
        if (_solving) return;
        if (_activeTab === 'explore') {
            const invalid = document.querySelector('.optimizer-config-pane input:invalid');
            if (invalid) { invalid.reportValidity(); return; }
        }
        const weaponId = window.EFTForge.state?.currentGun?.id;
        if (!weaponId) return;

        _solving = true;
        _error = null;
        _result = null;
        _renderResult();

        const state = window.EFTForge.state || {};
        const ammoSelect = document.getElementById('ammo-select');
        const ubglAmmoSelect = document.getElementById('ubgl-ammo-select');
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
            require_suppressor: _requireSuppressor,
            include_items: _includedModIds.length ? _includedModIds : null,
            exclude_items: _excludedModIds.length ? _excludedModIds : null,
            flea_available: _fleaAvailable,
            trader_levels: state.traderLevels || null,
            strength_level: state.currentStrengthLevel ?? 10,
            equip_ergo_modifier: state.currentEquipErgoModifier ?? 0,
            // Fills the solved build's magazine(s) with whatever ammo is currently selected in
            // the main builder, same as the "assume full mag" toggle already does for the stats
            // panel - so the results panel's weight/EED/overswing/arm_stamina are computed the
            // same way the main builder would show them for this same set of parts.
            assume_full_mag: state.assumeFullMag ?? true,
            selected_ammo_id: ammoSelect ? ammoSelect.value : null,
            selected_ubgl_ammo_id: ubglAmmoSelect ? (ubglAmmoSelect.value || null) : null,
        };

        if (_activeTab === 'explore') await _solveExplore(body);
        else await _runSolve(`${EFTForge.config.API_BASE}/build/optimize`, body);
    }

    function _renderExploreControls() {
        const pane = document.querySelector('.optimizer-config-pane');
        if (!pane) return;
        const weightSection = pane.querySelector('[data-section="weight"]');
        weightSection.hidden = true;
        const controls = document.createElement('div');
        controls.className = 'optimizer-result optimizer-explore-controls';
        controls.innerHTML = `
            <div class="optimizer-section-title">${_t('optimizer.exploreStrategy')}</div>
            <p class="optimizer-explore-hint">${_t('optimizer.exploreHint')}</p>
            <label class="stat-label" for="optimizer-explore-axis">${_t('optimizer.exploreAxes')}</label>
            <select id="optimizer-explore-axis" class="optimizer-explore-native">
                ${['price', 'recoil', 'ergo'].map(axis => `<option value="${axis}" ${axis === _exploreTradeoff ? 'selected' : ''}>${_t('optimizer.exploreAxes.' + axis)}</option>`).join('')}
            </select>
            <label class="stat-label" for="optimizer-explore-steps" data-tooltip="${_escape(_t('optimizer.exploreResolutionTip'))}">${_t('optimizer.exploreResolution')}</label>
            <div class="optimizer-constraint-slider-row">
                <div class="optimizer-slider-track">
                    <input id="optimizer-explore-steps" type="range" min="10" max="81" step="1" value="${_exploreSteps}">
                    <div class="optimizer-slider-ticks"><span>10</span><span>81</span></div>
                </div>
                <input id="optimizer-explore-steps-number" class="optimizer-input" type="number" min="10" max="81" step="1" required value="${_exploreSteps}" aria-label="${_escape(_t('optimizer.exploreResolution'))}">
            </div>
        `;
        pane.prepend(controls);
        // Keep the shared requirement switches alive, including their listeners.
        for (const id of ['optimizer-overswing-toggle', 'optimizer-suppressor-toggle']) {
            const row = document.getElementById(id)?.closest('.optimizer-toggle-row');
            if (row) controls.appendChild(row);
        }
        setupCustomSelect('optimizer-explore-axis');
        document.getElementById('optimizer-explore-axis').addEventListener('change', e => {
            _exploreTradeoff = e.target.value;
        });
        const range = document.getElementById('optimizer-explore-steps');
        const number = document.getElementById('optimizer-explore-steps-number');
        const syncSteps = e => {
            if (!e.target.checkValidity() || e.target.value === '') return;
            _exploreSteps = Number(e.target.value);
            range.value = number.value = _exploreSteps;
        };
        range.addEventListener('input', syncSteps);
        number.addEventListener('input', syncSteps);
    }

    // Coalesces bursts of progress events (a trivial weapon can solve a step in
    // well under a frame) into at most one repaint per animation frame, instead
    // of a full results-pane rebuild per event.
    function _scheduleSolveRender() {
        if (_solveRenderPending) return;
        _solveRenderPending = true;
        requestAnimationFrame(() => {
            _solveRenderPending = false;
            if (_solving) _renderBuildResult();
        });
    }

    async function _solveExplore(body) {
        delete body.use_evo_ergo;
        delete body.ergo_weight;
        delete body.recoil_weight;
        delete body.price_weight;
        Object.assign(body, { tradeoff: _exploreTradeoff, steps: _exploreSteps });
        _explore = null;
        _exploreSelected = 0;
        _solveProgress = { phase: null, done: 0, total: _exploreSteps + 1, points: [], previewBuild: null };
        _solveStartedAt = Date.now();
        _solveElapsedTimer = setInterval(_tickSolveElapsed, 100);
        const controller = new AbortController();
        _abortController = controller;
        const signal = controller.signal;
        _renderResult();
        try {
            const deadline = Date.now() + _SERVER_BUSY_MAX_WAIT_MS;
            for (;;) {
                if (_waitingForSlot) {
                    _waitingForSlot = false;
                    _renderResult();
                }
                let data;
                try {
                    data = await exploreStream(body, signal, ev => {
                        // The two boundary solves (minimize/maximize a single axis with
                        // no constraint on the other) are real points, but they're
                        // deliberately extreme - way off the eventual curve - so they're
                        // kept out of the live chart's point set entirely; only "sweep"
                        // steps, which trace the curve itself, feed it. They still update
                        // the live preview stats/gun image below, same as any other point.
                        const forChart = ev.point && ev.phase === 'sweep';
                        _solveProgress = {
                            phase: ev.phase,
                            axis: ev.axis,
                            bound_stat: ev.bound_stat,
                            bound_value: ev.bound_value,
                            done: ev.done,
                            total: ev.total,
                            points: forChart ? [..._solveProgress.points, ev.point] : _solveProgress.points,
                            previewBuild: ev.point ? ev.point.build : _solveProgress.previewBuild,
                        };
                        _scheduleSolveRender();
                    });
                } catch (err) {
                    if (err.status === 429 && err.reasonKey === 'optimizer.reason.serverBusy' && Date.now() < deadline) {
                        _waitingForSlot = true;
                        _renderResult();
                        await _sleep(_SERVER_BUSY_RETRY_DELAY_MS, signal);
                        continue;
                    }
                    if (err.status) {
                        _error = err.reasonKey ? _t(err.reasonKey) : _t('optimizer.solveFailed');
                        return;
                    }
                    throw err;
                }
                if (_solveProgress?.points?.length) await _playDiscardAnimation(_solveProgress.points, data.points, signal);
                _explore = { ...data, request: body };
                _exploreJustSolved = true;
                _result = data.points[0]?.build || null;
                if (!_result) _error = _t(data.complete ? 'optimizer.infeasible' : 'optimizer.exploreNoPoints');
                break;
            }
        } catch (err) {
            _error = _t(err.name === 'AbortError' ? 'optimizer.cancelled' : 'optimizer.solveFailed');
        } finally {
            _solving = false;
            _waitingForSlot = false;
            _solveProgress = null;
            _solveSelecting = false;
            clearInterval(_solveElapsedTimer);
            _solveElapsedTimer = null;
            _solveStartedAt = null;
            cancelAnimationFrame(_liveChartRafId);
            _liveChartRafId = null;
            _liveChartDomain = null;
            _liveChartTarget = null;
            if (_abortController === controller) _abortController = null;
            _renderResult();
        }
    }

    function _explorePointLabel(p, i) {
        return `${i + 1} · ${_t('optimizer.ergonomics')} ${p.ergo} · ${_t('optimizer.recoil')} ${p.recoil_v} · ${_formatPrice(p.price)}`;
    }

    // Builds just the <svg> markup for the solved-builds chart, driven by
    // _exploreView (null = auto-fit). Kept separate from _renderExploreChart so
    // pan/zoom frames can replace only the <svg> - rebuilding the whole chart
    // (title, hint text, the <select> and its custom dropdown) on every wheel
    // tick/lerp frame would be wasteful and would tear down an open dropdown.
    function _buildExploreSvgMarkup() {
        const { points, tradeoff } = _explore;
        const xKey = tradeoff === 'ergo' ? 'recoil_v' : 'ergo';
        const yKey = tradeoff === 'price' ? 'recoil_v' : 'price';
        const xLabel = _t(xKey === 'ergo' ? 'optimizer.ergonomics' : 'optimizer.recoil');
        const yLabel = _t(yKey === 'price' ? 'optimizer.price' : 'optimizer.recoil');
        const xs = points.map(p => p[xKey]), ys = points.map(p => p[yKey]);
        const minX = Math.min(...xs), minY = Math.min(...ys);
        const spanX = Math.max(...xs) - minX || 1, spanY = Math.max(...ys) - minY || 1;
        const ML = 78, MT = 35, PW = 490, PH = 210;
        // Auto-fit domain (the data's own range) - always the reset/pan-fallback
        // target, independent of whatever _exploreView is currently showing.
        const dxMin = minX, dxMax = minX + spanX, dyMin = minY, dyMax = minY + spanY;
        const { xMin, xMax, yMin, yMax } = _exploreView || { xMin: dxMin, xMax: dxMax, yMin: dyMin, yMax: dyMax };
        const mapX = v => ML + (v - xMin) / (xMax - xMin) * PW;
        const mapY = v => (MT + PH) - (v - yMin) / (yMax - yMin) * PH;
        const toDataX = sx => xMin + (sx - ML) / PW * (xMax - xMin);
        const toDataY = sy => yMin + ((MT + PH) - sy) / PH * (yMax - yMin);
        const px = p => mapX(p[xKey]);
        const py = p => mapY(p[yKey]);
        const fmt = (v, key) => key === 'price' ? _formatPrice(v) : String(Math.round(v));
        const pointLabel = _explorePointLabel;
        const pointTooltipHtml = p => {
            const s = p.build?.final_stats;
            if (!s) return null;
            const bar = (labelKey, fillClass, pct, text) => `
                <div class="stat-bar-row">
                    <div class="stat-bar-label">${_t(labelKey)}</div>
                    <div class="stat-bar-track">
                        <div class="stat-bar-fill ${fillClass}" style="width:${pct}%"></div>
                        <div class="stat-bar-value">${text}</div>
                    </div>
                </div>`;
            const totalErgo = parseFloat(s.total_ergo ?? 0);
            const ergoText = Math.abs(totalErgo - Math.round(totalErgo)) < 0.001 ? Math.round(totalErgo) : totalErgo.toFixed(1);
            const rv = s.recoil_vertical, rh = s.recoil_horizontal, moa = s.accuracy_moa;
            const eed = parseFloat(s.evo_ergo_delta ?? 0);
            const sighting = s.sighting_range;
            const html = `
                <div class="optimizer-point-tooltip">
                    ${bar('stats.ergo', 'ergo-bar', Math.max(0, Math.min(totalErgo, 100)), ergoText)}
                    ${bar('stats.verRecoil', 'recoil-bar', rv != null ? Math.min(Math.round(rv), 500) / 5 : 0, rv != null ? Math.round(rv) : '-')}
                    ${bar('stats.horRecoil', 'recoil-bar', rh != null ? Math.min(Math.round(rh), 500) / 5 : 0, rh != null ? Math.round(rh) : '-')}
                    ${bar('stats.accuracy', 'accuracy-bar', moa != null ? Math.min(moa / 10, 1) * 100 : 0, moa != null ? moa.toFixed(2) + ' MOA' : '-')}
                    <div class="stats-divider"></div>
                    <div class="stat-subsection">
                    <div class="stat-subsection-cols">
                    <div class="stat-col">
                        <div class="stat-row"><span class="stat-label">${_t('stats.eedLabelShort')}</span><span class="${eed >= 0 ? 'positive' : 'negative'}">${eed > 0 ? '+' : ''}${eed.toFixed(1)}</span></div>
                        <div class="stat-row"><span class="stat-label">${_t('stats.overswing')}</span><span class="${s.overswing ? 'negative' : 'positive'}">${s.overswing ? _t('stats.yes') : _t('stats.no')}</span></div>
                    </div>
                    <div class="stat-col">
                        <div class="stat-row"><span class="stat-label">${_t('stats.weight')}</span><span>${s.total_weight.toFixed(3)} kg</span></div>
                        ${sighting != null ? `<div class="stat-row"><span class="stat-label">${_t('stats.sightingRange')}</span><span>${sighting} m</span></div>` : ''}
                    </div>
                    </div>
                    </div>
                </div>`;
            // Collapse the indentation/newlines from the template literal above - the
            // tooltip briefly flips from white-space:normal back to the base #eft-tooltip
            // rule's pre-line while it fades out (EFTForge.tooltip.hide() drops the
            // html-tip class immediately, before the opacity transition finishes), which
            // would otherwise render all that inter-tag whitespace as visible line breaks
            // for a frame - a brief but jarring "tooltip balloons in size" flash.
            return html.replace(/>\s+</g, '><').trim();
        };
        const ticks = Array.from({ length: 5 }, (_, i) => {
            const xv = xMin + i * (xMax - xMin) / 4, yv = yMin + i * (yMax - yMin) / 4;
            const x = mapX(xv), y = mapY(yv);
            return `<line x1="${ML}" y1="${y.toFixed(2)}" x2="${ML + PW}" y2="${y.toFixed(2)}" class="optimizer-explore-grid"/>
                <text x="${(ML - 10).toFixed(2)}" y="${(y + 4).toFixed(2)}" text-anchor="end">${_escape(fmt(yv, yKey))}</text>
                <text x="${x.toFixed(2)}" y="${MT + PH + 20}" text-anchor="middle">${_escape(fmt(xv, xKey))}</text>`;
        }).join('');
        const zoomed = _exploreView !== null;
        // Only clip once actually zoomed - the default auto-fit domain has points
        // sitting exactly on the plot edges by design (see original px/py), and
        // clipping unconditionally would slice those edge dots into half-moons.
        const clipAttr = zoomed ? ' clip-path="url(#optimizer-explore-clip)"' : '';
        // Secret: scroll out far enough past the data and the curve gives way to
        // a warning sign instead - the reset button (and right-click-to-reset)
        // still work normally, so zooming back in un-panics the chart.
        const easterEgg = zoomed && Math.max(
            (xMax - xMin) / (dxMax - dxMin),
            (yMax - yMin) / (dyMax - dyMin),
        ) >= EXPLORE_EASTER_EGG_RATIO;
        const plotContent = easterEgg
            ? `<image href="${EXPLORE_EASTER_EGG_IMG}" x="${ML}" y="${MT}" width="${PW}" height="${PH}" preserveAspectRatio="xMidYMid meet"/>`
            : `<polyline points="${points.map(p => `${px(p).toFixed(2)},${py(p).toFixed(2)}`).join(' ')}" class="optimizer-explore-line"/>
                    ${points.map((p, i) => {
                        const tipHtml = pointTooltipHtml(p);
                        const tipAttr = tipHtml ? `data-tooltip-html="${escapeHtml(tipHtml)}"` : `data-tooltip="${_escape(pointLabel(p, i))}"`;
                        const selected = i === _exploreSelected;
                        // Plays once, only on the point the system auto-selected right after
                        // this solve finished - not on a later rebuild of the same result
                        // (leaving and returning to the tab) or on a manually-clicked point,
                        // which instead reuses this same DOM via the branch above.
                        const lockOn = _exploreJustSolved && selected;
                        const x = px(p).toFixed(2), y = py(p).toFixed(2);
                        // The visible dot (r=5/7) is a small target to hit precisely, so a
                        // transparent, larger circle carries the actual hover/click/focus
                        // interaction - the <g> wrapper is what's hovered/focused, and CSS
                        // routes its state down to the dot for the fill-color feedback.
                        return `<g class="optimizer-explore-point-hit" data-point="${i}" tabindex="0" role="button" aria-pressed="${selected}" aria-label="${_escape(pointLabel(p, i))}" ${tipAttr}>
                            <circle cx="${x}" cy="${y}" r="12" class="optimizer-explore-point-hitarea"/>
                            ${lockOn ? `<circle cx="${x}" cy="${y}" r="7" class="optimizer-explore-point-lockon"/>` : ''}
                            <circle cx="${x}" cy="${y}" r="7" class="optimizer-explore-point-pulse${selected ? ' selected' : ''}"/>
                            <circle cx="${x}" cy="${y}" r="${selected ? 7 : 5}" class="optimizer-explore-point${selected ? ' selected' : ''}"/>
                        </g>`;
                    }).join('')}`;
        const svg = `
            <svg viewBox="0 0 610 300" role="group" aria-label="${_escape(_t('optimizer.exploreAxes.' + tradeoff))}">
                <defs><clipPath id="optimizer-explore-clip"><rect x="${ML}" y="${MT}" width="${PW}" height="${PH}"/></clipPath></defs>
                ${easterEgg ? '' : `${ticks}<text x="78" y="18">${_escape(yLabel)}</text><text x="323" y="293" text-anchor="middle">${_escape(xLabel)}</text>`}
                <g${clipAttr}>
                    ${plotContent}
                </g>
                ${zoomed ? `<g class="optimizer-explore-reset-btn" style="cursor:pointer" data-tooltip="${escapeHtml(_t('graph.resetZoom'))}">
                    <rect x="580" y="35" width="18" height="18" rx="3" fill="#1a1a1a" stroke="#3a3a3a" stroke-width="0.8"/>
                    <text x="589" y="47" text-anchor="middle" style="font-size:11px" fill="#888" font-family="Arial,sans-serif">&#x21BA;</text>
                </g>` : ''}
            </svg>`;
        return { svg, ML, MT, PW, PH, dxMin, dxMax, dyMin, dyMax, toDataX, toDataY };
    }

    function _renderExploreChart(existingChart = null, opts = {}) {
        if (!_explore?.points.length || _pickerExpanded) return;
        const container = _resultsContainer();
        if (!container) return;
        // Lives inside the merged stats-section body (see _statTilesHtml) so the curve
        // and the selected point's stat/gun preview sit side by side as one card.
        const mergedBody = container.querySelector('#optimizer-explore-merged-body');
        if (!mergedBody) return;

        // Pan/zoom frame: only the plotted <svg> needs to change, everything else
        // (title, hint text, select + custom dropdown) stays exactly as it is.
        if (opts.zoomOnly && existingChart) {
            const oldSvg = existingChart.querySelector('svg');
            const ctx = _buildExploreSvgMarkup();
            if (oldSvg) oldSvg.outerHTML = ctx.svg;
            _wireExploreChartZoom(existingChart, ctx);
            return;
        }

        // Reuse the curve and its custom select when only the chosen build changes.
        if (existingChart && _exploreChartData === _explore) {
            // Remove the solve ring before reinserting the chart so it cannot replay.
            existingChart.querySelectorAll('.optimizer-explore-point-lockon').forEach(ring => ring.remove());
            mergedBody.prepend(existingChart);
            existingChart.querySelectorAll('[data-point]').forEach(el => {
                const selected = Number(el.dataset.point) === _exploreSelected;
                el.setAttribute('aria-pressed', String(selected));
                const dot = el.querySelector('.optimizer-explore-point');
                dot.classList.toggle('selected', selected);
                dot.setAttribute('r', selected ? '7' : '5');
                el.querySelector('.optimizer-explore-point-pulse').classList.toggle('selected', selected);
            });
            const select = existingChart.querySelector('select');
            select.value = _exploreSelected;
            select.dispatchEvent(new Event('input'));
            return;
        }

        // Brand-new dataset (a fresh solve, not just a reselect) - drop any manual
        // zoom/pan from the previous curve so the new points always open auto-fit.
        _exploreView = null;
        _exploreViewTarget = null;
        if (_exploreZoomLerpRaf) { cancelAnimationFrame(_exploreZoomLerpRaf); _exploreZoomLerpRaf = null; }

        const { points, complete } = _explore;
        const ctx = _buildExploreSvgMarkup();
        const chart = document.createElement('div');
        chart.className = 'optimizer-explore-chart';
        chart.innerHTML = `
            <div class="optimizer-section-title">${_t('optimizer.exploreChartTitle')}</div>
            <p class="optimizer-explore-hint">${_t('optimizer.exploreSelectHint')}</p>
            <p class="optimizer-explore-hint optimizer-explore-zoom-hint">${_t('graph.hintScroll')} · ${_t('graph.hintPan')} · ${_t('graph.hintBoxZoom')} · ${_t('graph.hintReset')}</p>
            ${!complete ? `<p class="optimizer-explore-partial">${_t('optimizer.explorePartial')}</p>` : ''}
            <div class="optimizer-explore-svg-wrap">${ctx.svg}</div>
            <label class="stat-label" for="optimizer-explore-point">${_t('optimizer.exploreBuild')} (${points.length})</label>
            <select id="optimizer-explore-point" class="optimizer-explore-native">
                ${points.map((p, i) => `<option value="${i}" ${i === _exploreSelected ? 'selected' : ''}>${_escape(_explorePointLabel(p, i))}</option>`).join('')}
            </select>
        `;
        mergedBody.prepend(chart);
        _exploreChartData = _explore;
        _exploreJustSolved = false;
        chart.querySelectorAll('.optimizer-explore-point-lockon').forEach(ring => {
            ring.addEventListener('animationend', () => ring.remove(), { once: true });
        });
        const selectPoint = index => {
            if (_solving || index === _exploreSelected) return;
            _exploreSelected = index;
            _result = points[index].build;
            _error = null;
            EFTForge.tooltip?.hide();
            _renderResult();
        };
        _exploreSelectPointFn = selectPoint;
        chart.querySelectorAll('[data-point]').forEach(el => {
            el.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    const index = Number(el.dataset.point);
                    selectPoint(index);
                    _resultsContainer()?.querySelector(`[data-point="${index}"]`)?.focus();
                }
            });
        });
        setupCustomSelect('optimizer-explore-point');
        document.getElementById('optimizer-explore-point').addEventListener('change', e => {
            selectPoint(Number(e.target.value));
            document.querySelector('#optimizer-explore-point-custom .custom-select-trigger')?.focus();
        });
        _wireExploreChartZoom(chart, ctx);
    }

    // Nudges the user toward ctrl+scroll the first time they try a plain scroll
    // over the chart (which the wheel handler otherwise just swallows to stop
    // the page scrolling under the cursor) - same one-shot-per-session overlay
    // as the attachment Graph view's _showGraphScrollHint (see graph.js).
    function _showExploreScrollHint(chart) {
        if (_exploreScrollHintShown) return;
        const wrap = chart.querySelector('.optimizer-explore-svg-wrap');
        if (!wrap) return;
        _exploreScrollHintShown = true;
        let hint = wrap.querySelector('.graph-scroll-hint');
        if (!hint) {
            hint = document.createElement('div');
            hint.className = 'graph-scroll-hint';
            hint.innerHTML = `<span>${escapeHtml(_t('graph.hintScroll'))}</span>`;
            wrap.appendChild(hint);
        }
        hint.classList.add('graph-scroll-hint-active');
        clearTimeout(_exploreScrollHintTimer);
        _exploreScrollHintTimer = setTimeout(() => {
            hint.classList.remove('graph-scroll-hint-active');
        }, 1150);
    }

    // Ctrl+scroll-to-zoom, drag-to-pan, box-zoom and right-click-to-reset for the
    // solved-builds chart - the same interaction set as the attachment Graph
    // view's _buildGraphSVG (see graph.js), scaled down to this chart's fixed
    // 610x300 viewBox and single line-of-points plot (no clustering/icons/crosshair).
    function _wireExploreChartZoom(chart, ctx) {
        const svg = chart.querySelector('svg');
        if (!svg) return;
        const { ML, MT, PW, PH, dxMin, dxMax, dyMin, dyMax, toDataX, toDataY } = ctx;

        _exploreZoomController?.abort();
        _exploreZoomController = new AbortController();
        const { signal } = _exploreZoomController;

        function svgPoint(e) {
            const rect = svg.getBoundingClientRect();
            return { sx: (e.clientX - rect.left) / rect.width * 610, sy: (e.clientY - rect.top) / rect.height * 300 };
        }
        function inPlot(sx, sy) { return sx >= ML && sx <= ML + PW && sy >= MT && sy <= MT + PH; }

        function runLerpStep() {
            const base = _exploreView || { xMin: dxMin, xMax: dxMax, yMin: dyMin, yMax: dyMax };
            const tgt = _exploreViewTarget;
            if (!tgt) { _exploreZoomLerpRaf = null; return; }
            const LERP = 0.25;
            const nx = {
                xMin: base.xMin + (tgt.xMin - base.xMin) * LERP,
                xMax: base.xMax + (tgt.xMax - base.xMax) * LERP,
                yMin: base.yMin + (tgt.yMin - base.yMin) * LERP,
                yMax: base.yMax + (tgt.yMax - base.yMax) * LERP,
            };
            const span = Math.max(Math.abs(tgt.xMax - tgt.xMin) || 1, Math.abs(tgt.yMax - tgt.yMin) || 1);
            const done = Math.abs(nx.xMin - tgt.xMin) < span * 0.005 &&
                         Math.abs(nx.xMax - tgt.xMax) < span * 0.005 &&
                         Math.abs(nx.yMin - tgt.yMin) < span * 0.005 &&
                         Math.abs(nx.yMax - tgt.yMax) < span * 0.005;
            _exploreView = done ? (_exploreLerpEndNull ? null : { ...tgt }) : nx;
            if (done) { _exploreViewTarget = null; _exploreZoomLerpRaf = null; _exploreLerpEndNull = false; }
            _renderExploreChart(chart, { zoomOnly: true });
            if (!done) _exploreZoomLerpRaf = requestAnimationFrame(runLerpStep);
        }
        function resetZoom() {
            if (_exploreView === null) return;
            _exploreLerpEndNull = true;
            _exploreViewTarget = { xMin: dxMin, xMax: dxMax, yMin: dyMin, yMax: dyMax };
            if (_exploreZoomLerpRaf) return;
            _exploreZoomLerpRaf = requestAnimationFrame(runLerpStep);
        }

        svg.querySelector('.optimizer-explore-reset-btn')?.addEventListener('click', e => {
            e.stopPropagation();
            resetZoom();
        }, { signal });

        svg.addEventListener('contextmenu', e => {
            e.preventDefault();
            if (inPlot(svgPoint(e).sx, svgPoint(e).sy)) resetZoom();
        }, { signal });

        let wheelAccum = 0, panAccumX = 0, panAccumY = 0, wheelRaf = null;
        let lastWheelPt = { sx: ML + PW / 2, sy: MT + PH / 2 };

        svg.addEventListener('wheel', e => {
            const pt = svgPoint(e);
            if (!inPlot(pt.sx, pt.sy)) return;
            e.preventDefault();
            const isPan = !e.ctrlKey && (e.deltaX !== 0 || (e.deltaMode === 0 && Math.abs(e.deltaY) < 50));
            if (isPan) {
                const rect = svg.getBoundingClientRect();
                panAccumX += e.deltaX / rect.width * 610 * 0.5;
                panAccumY += e.deltaY / rect.height * 300 * 0.5;
            } else if (e.ctrlKey) {
                lastWheelPt = pt;
                wheelAccum += e.deltaY * 2;
            } else {
                _showExploreScrollHint(chart);
                return;
            }
            if (wheelRaf) return;
            wheelRaf = requestAnimationFrame(() => {
                wheelRaf = null;
                const cur = _exploreView || { xMin: dxMin, xMax: dxMax, yMin: dyMin, yMax: dyMax };
                let hasZoom = false;
                if (wheelAccum !== 0) {
                    hasZoom = true;
                    _exploreLerpEndNull = false;
                    const factor = Math.pow(1.5, wheelAccum / 400);
                    wheelAccum = 0;
                    const cx = toDataX(lastWheelPt.sx), cy = toDataY(lastWheelPt.sy);
                    const base = _exploreViewTarget || cur;
                    _exploreViewTarget = {
                        xMin: cx + (base.xMin - cx) * factor, xMax: cx + (base.xMax - cx) * factor,
                        yMin: cy + (base.yMin - cy) * factor, yMax: cy + (base.yMax - cy) * factor,
                    };
                    [_exploreViewTarget.xMin, _exploreViewTarget.xMax] = _clampExploreZoomSpan(_exploreViewTarget.xMin, _exploreViewTarget.xMax, dxMin, dxMax);
                    [_exploreViewTarget.yMin, _exploreViewTarget.yMax] = _clampExploreZoomSpan(_exploreViewTarget.yMin, _exploreViewTarget.yMax, dyMin, dyMax);
                }
                if (panAccumX !== 0 || panAccumY !== 0) {
                    const base = _exploreViewTarget || cur;
                    const dDataX = panAccumX / PW * (base.xMax - base.xMin);
                    const dDataY = -panAccumY / PH * (base.yMax - base.yMin);
                    panAccumX = 0; panAccumY = 0;
                    if (hasZoom) {
                        _exploreViewTarget = {
                            xMin: _exploreViewTarget.xMin + dDataX, xMax: _exploreViewTarget.xMax + dDataX,
                            yMin: _exploreViewTarget.yMin + dDataY, yMax: _exploreViewTarget.yMax + dDataY,
                        };
                    } else {
                        _exploreView = {
                            xMin: base.xMin + dDataX, xMax: base.xMax + dDataX,
                            yMin: base.yMin + dDataY, yMax: base.yMax + dDataY,
                        };
                        _renderExploreChart(chart, { zoomOnly: true });
                        return;
                    }
                }
                if (!hasZoom) return;
                if (_exploreZoomLerpRaf) return;
                _exploreZoomLerpRaf = requestAnimationFrame(runLerpStep);
            });
        }, { passive: false, signal });

        let dragState = null;
        svg.addEventListener('mousedown', e => {
            if (e.button === 1) {
                e.preventDefault();
                const pt = svgPoint(e);
                if (!inPlot(pt.sx, pt.sy)) return;
                _explorePanState = { last: pt };
                svg.style.cursor = 'grabbing';
                return;
            }
            if (e.button !== 0) return;
            const pt = svgPoint(e);
            if (!inPlot(pt.sx, pt.sy)) return;
            e.preventDefault();
            const boxEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            boxEl.setAttribute('class', 'graph-zoom-box');
            boxEl.setAttribute('x', pt.sx.toFixed(1)); boxEl.setAttribute('y', pt.sy.toFixed(1));
            boxEl.setAttribute('width', '0'); boxEl.setAttribute('height', '0');
            svg.appendChild(boxEl);
            dragState = { start: pt, moved: false, boxEl };
        }, { signal });

        window.addEventListener('mousemove', e => {
            if (_explorePanState) {
                const pt = svgPoint(e);
                const dx = pt.sx - _explorePanState.last.sx, dy = pt.sy - _explorePanState.last.sy;
                _explorePanState.last = pt;
                if (!_explorePanDelta) _explorePanDelta = { x: 0, y: 0 };
                _explorePanDelta.x += dx; _explorePanDelta.y += dy;
                if (!_explorePanRaf) {
                    _explorePanRaf = requestAnimationFrame(() => {
                        _explorePanRaf = null;
                        const d = _explorePanDelta; _explorePanDelta = null;
                        const cur = _exploreView || { xMin: dxMin, xMax: dxMax, yMin: dyMin, yMax: dyMax };
                        _exploreView = {
                            xMin: cur.xMin - d.x / PW * (cur.xMax - cur.xMin),
                            xMax: cur.xMax - d.x / PW * (cur.xMax - cur.xMin),
                            yMin: cur.yMin + d.y / PH * (cur.yMax - cur.yMin),
                            yMax: cur.yMax + d.y / PH * (cur.yMax - cur.yMin),
                        };
                        _renderExploreChart(chart, { zoomOnly: true });
                    });
                }
                return;
            }
            if (!dragState) return;
            const pt = svgPoint(e);
            const dx = pt.sx - dragState.start.sx, dy = pt.sy - dragState.start.sy;
            if (!dragState.moved && Math.hypot(dx, dy) < 4) return;
            dragState.moved = true;
            dragState.boxEl.setAttribute('x', Math.min(pt.sx, dragState.start.sx).toFixed(1));
            dragState.boxEl.setAttribute('y', Math.min(pt.sy, dragState.start.sy).toFixed(1));
            dragState.boxEl.setAttribute('width', Math.abs(dx).toFixed(1));
            dragState.boxEl.setAttribute('height', Math.abs(dy).toFixed(1));
        }, { signal });

        window.addEventListener('mouseup', e => {
            if (e.button === 1 && _explorePanState) {
                _explorePanState = null;
                svg.style.cursor = '';
                return;
            }
            if (!dragState) return;
            const state = dragState;
            dragState = null;
            state.boxEl.remove();

            if (!state.moved) {
                // A plain click (no drag) - forward to the point under the cursor,
                // same as a native click would, since preventDefault on this
                // mousedown suppresses the browser's own click event.
                const hit = e.target.closest?.('.optimizer-explore-point-hit');
                if (hit && chart.contains(hit)) _exploreSelectPointFn?.(Number(hit.dataset.point));
                return;
            }

            const { sx: ex, sy: ey } = svgPoint(e);
            const x1 = Math.max(Math.min(ex, state.start.sx), ML);
            const x2 = Math.min(Math.max(ex, state.start.sx), ML + PW);
            const y1 = Math.max(Math.min(ey, state.start.sy), MT);
            const y2 = Math.min(Math.max(ey, state.start.sy), MT + PH);
            if (x2 - x1 < 4 || y2 - y1 < 4) return;
            const bx1 = toDataX(x1), bx2 = toDataX(x2);
            const by1 = toDataY(y1), by2 = toDataY(y2);
            _exploreLerpEndNull = false;
            const [bxMin, bxMax] = _clampExploreZoomSpan(Math.min(bx1, bx2), Math.max(bx1, bx2), dxMin, dxMax);
            const [byMin, byMax] = _clampExploreZoomSpan(Math.min(by1, by2), Math.max(by1, by2), dyMin, dyMax);
            _exploreView = { xMin: bxMin, xMax: bxMax, yMin: byMin, yMax: byMax };
            _renderExploreChart(chart, { zoomOnly: true });
        }, { signal });

        if (_explorePanState) svg.style.cursor = 'grabbing';
    }

    /* ===========================
       EXPLORE LIVE CHART
       While a sweep is running, the curve isn't just appended to - the visible
       axis range keeps growing as new (ergo, recoil/price) samples land further
       out than anything solved so far. Rather than re-fitting the axes and
       snapping to the new range every tick (jarring, and any single outlier
       sample would blow the zoom out immediately), the chart's own DOM persists
       across ticks and a small rAF loop continuously eases the *displayed* axis
       range toward the *current* data's range - so it reads as a camera zooming
       out smoothly to keep including new dots, rather than a jump cut.
    =========================== */

    let _liveChartDomain = null;   // currently displayed (eased) {minX, spanX, minY, spanY}
    let _liveChartTarget = null;   // latest true fit for the current point set
    let _liveChartRafId = null;
    let _liveChartLastFrameTime = null;

    function _lerp(a, b, t) { return a + (b - a) * t; }
    function _lerpDomain(a, b, t) {
        return {
            minX: _lerp(a.minX, b.minX, t), spanX: _lerp(a.spanX, b.spanX, t),
            minY: _lerp(a.minY, b.minY, t), spanY: _lerp(a.spanY, b.spanY, t),
        };
    }

    // 15% padding on each side so points never sit flush against the plot edge -
    // most noticeable on the very first one or two samples, which would otherwise
    // render as a single dot glued to a corner.
    function _computeChartDomain(points, xKey, yKey) {
        const xs = points.map(p => p[xKey]), ys = points.map(p => p[yKey]);
        const rawMinX = Math.min(...xs), rawMinY = Math.min(...ys);
        const rawSpanX = Math.max(...xs) - rawMinX || 1;
        const rawSpanY = Math.max(...ys) - rawMinY || 1;
        const padX = rawSpanX * 0.15, padY = rawSpanY * 0.15;
        return {
            minX: rawMinX - padX, spanX: rawSpanX + padX * 2,
            minY: rawMinY - padY, spanY: rawSpanY + padY * 2,
        };
    }

    function _chartPx(domain, xKey, p) { return 78 + (p[xKey] - domain.minX) / domain.spanX * 490; }
    function _chartPy(domain, yKey, p) { return 245 - (p[yKey] - domain.minY) / domain.spanY * 210; }

    // "Nice" step size for ~5 gridlines across a span (1/2/5 x a power of ten) -
    // the same rounding rule most chart libraries use, so tick values read as
    // 10/20/50 rather than the raw span/5. Ticks are then positioned with
    // _chartPx/_chartPy like anything else on the chart, so as the domain
    // widens the *lines themselves* spread out and change count - a visible
    // grid density change is what actually reads as the camera zooming out;
    // relabeling lines that stay in the same 5 fixed pixel spots (the previous
    // approach) doesn't.
    function _niceTickStep(span, targetCount = 5) {
        const raw = span / targetCount || 1;
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const norm = raw / mag;
        const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
        return step * mag;
    }
    function _axisTicks(min, span) {
        const step = _niceTickStep(span);
        const ticks = [];
        for (let v = Math.ceil(min / step) * step; v <= min + span + step * 1e-6; v += step) ticks.push(v);
        return ticks;
    }

    function _buildLiveChartSkeleton(tradeoff, xLabel, yLabel) {
        const chart = document.createElement('div');
        chart.className = 'optimizer-explore-chart';
        chart.innerHTML = `
            <div class="optimizer-section-title">${_t('optimizer.exploreChartTitle')}</div>
            <svg viewBox="0 0 610 300" role="img" aria-label="${_escape(_t('optimizer.exploreAxes.' + tradeoff))}">
                <g class="optimizer-explore-live-ticks"></g>
                <text x="78" y="18">${_escape(yLabel)}</text><text x="323" y="293" text-anchor="middle">${_escape(xLabel)}</text>
                <polyline class="optimizer-explore-line" points=""/>
                <g class="optimizer-explore-live-points"></g>
            </svg>
        `;
        return chart;
    }

    // Repaints one frame at the given (possibly mid-transition) domain: axis
    // ticks and the polyline are cheap enough to just regenerate outright, and
    // any newly-arrived points get a dot appended before every point's position
    // is refreshed against the current domain.
    function _paintLiveChart(chart, points, xKey, yKey, domain) {
        const svg = chart.querySelector('svg');
        const fmt = (v, key) => key === 'price' ? _formatPrice(v) : String(Math.round(v));
        const yTicksHtml = _axisTicks(domain.minY, domain.spanY).map(v => {
            const y = _chartPy(domain, yKey, { [yKey]: v });
            return `<line x1="78" y1="${y}" x2="568" y2="${y}" class="optimizer-explore-grid"/>
                <text x="68" y="${y + 4}" text-anchor="end">${_escape(fmt(v, yKey))}</text>`;
        }).join('');
        const xTicksHtml = _axisTicks(domain.minX, domain.spanX).map(v => {
            const x = _chartPx(domain, xKey, { [xKey]: v });
            return `<text x="${x}" y="265" text-anchor="middle">${_escape(fmt(v, xKey))}</text>`;
        }).join('');
        svg.querySelector('.optimizer-explore-live-ticks').innerHTML = yTicksHtml + xTicksHtml;

        svg.querySelector('.optimizer-explore-line').setAttribute(
            'points', points.map(p => `${_chartPx(domain, xKey, p)},${_chartPy(domain, yKey, p)}`).join(' ')
        );

        const pointsGroup = svg.querySelector('.optimizer-explore-live-points');
        while (pointsGroup.childElementCount < points.length) {
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('class', 'optimizer-explore-point');
            circle.setAttribute('r', '4');
            pointsGroup.appendChild(circle);
        }
        const dots = pointsGroup.children;
        points.forEach((p, i) => {
            dots[i].setAttribute('cx', _chartPx(domain, xKey, p));
            dots[i].setAttribute('cy', _chartPy(domain, yKey, p));
        });
    }

    function _liveChartFrame(chart, xKey, yKey, now) {
        if (!_solving || !document.body.contains(chart)) {
            _liveChartRafId = null;
            _liveChartLastFrameTime = null;
            return;
        }
        const dt = _liveChartLastFrameTime != null ? now - _liveChartLastFrameTime : 16.67;
        _liveChartLastFrameTime = now;
        if (_liveChartTarget) {
            // Exponential ease toward the target, framerate-independent: ~90%
            // of the way there after about 400ms at 60fps.
            const t = 1 - Math.exp(-dt / 180);
            _liveChartDomain = _lerpDomain(_liveChartDomain, _liveChartTarget, t);
            _paintLiveChart(chart, _solveProgress?.points || [], xKey, yKey, _liveChartDomain);
        }
        _liveChartRafId = requestAnimationFrame(ts => _liveChartFrame(chart, xKey, yKey, ts));
    }

    // Entry point called from the solving-placeholder renderer on every progress
    // tick. Builds the chart once; after that it just updates the target domain -
    // the running rAF loop above picks up both the new target and any newly
    // arrived points on its own next frame.
    function _renderLiveChart(points, tradeoff) {
        if (!points.length || _pickerExpanded) return;
        const container = _resultsContainer();
        if (!container) return;
        const mergedBody = container.querySelector('#optimizer-explore-merged-body');
        if (!mergedBody) return;

        const xKey = tradeoff === 'ergo' ? 'recoil_v' : 'ergo';
        const yKey = tradeoff === 'price' ? 'recoil_v' : 'price';
        const targetDomain = _computeChartDomain(points, xKey, yKey);

        let chart = mergedBody.querySelector('.optimizer-explore-chart');
        if (!chart) {
            const xLabel = _t(xKey === 'ergo' ? 'optimizer.ergonomics' : 'optimizer.recoil');
            const yLabel = _t(yKey === 'price' ? 'optimizer.price' : 'optimizer.recoil');
            chart = _buildLiveChartSkeleton(tradeoff, xLabel, yLabel);
            mergedBody.prepend(chart);
            // Snap straight to the first cluster - only domain changes *after*
            // this first paint animate.
            _liveChartDomain = targetDomain;
            _paintLiveChart(chart, points, xKey, yKey, _liveChartDomain);
            cancelAnimationFrame(_liveChartRafId);
            _liveChartLastFrameTime = null;
            _liveChartRafId = requestAnimationFrame(ts => _liveChartFrame(chart, xKey, yKey, ts));
        }
        _liveChartTarget = targetDomain;
    }

    // Runs once a solve's stream has fully finished, against the live chart
    // that's still mounted (the final frontier curve hasn't replaced it yet -
    // see the call site in _solveExplore). Sweep points that got sampled but
    // didn't survive the Pareto filter (frontierPoints) get a beat to read as
    // "considered, then ruled out" instead of just disappearing the instant the
    // chart swaps to the finished curve: each discarded dot turns red in place,
    // holds briefly, then fades, staggered slightly across dots so it reads as
    // a sweep rather than everything flashing at once. The elapsed-time clock
    // is stopped for the duration since the actual solving is already done -
    // this is pure post-solve presentation.
    function _playDiscardAnimation(rawPoints, frontierPoints, signal) {
        const chart = _resultsContainer()?.querySelector('.optimizer-explore-chart .optimizer-explore-live-points');
        if (!chart) return Promise.resolve();
        const isKept = p => frontierPoints.some(f => f.ergo === p.ergo && f.recoil_v === p.recoil_v && f.price === p.price);
        const discardedIdx = [];
        rawPoints.forEach((p, i) => { if (!isKept(p)) discardedIdx.push(i); });
        if (!discardedIdx.length) return Promise.resolve();

        clearInterval(_solveElapsedTimer);
        // Flip before touching the DOM: the last progress tick's own
        // _scheduleSolveRender is still pending a rAF at this point, and once it
        // fires it must see this flag and print the same copy, not stomp it back
        // to that tick's now-stale phase/detail text (see the flag's declaration).
        _solveSelecting = true;
        const phaseEl = document.querySelector('.optimizer-solve-phase');
        if (phaseEl) phaseEl.textContent = _solveProgressLabel();
        const detailEl = document.querySelector('.optimizer-solve-detail');
        if (detailEl) detailEl.textContent = _solveProgressDetail();
        const cancelBtn = document.getElementById('optimizer-cancel-btn');
        if (cancelBtn) cancelBtn.disabled = true;

        const STAGGER_MS = 35, TURN_MS = 280, HOLD_MS = 90, FADE_MS = 380;
        const dots = chart.children;
        discardedIdx.forEach((idx, order) => {
            const dot = dots[idx];
            if (!dot) return;
            const delay = order * STAGGER_MS;
            setTimeout(() => dot.classList.add('discarding'), delay);
            setTimeout(() => dot.classList.add('discarded'), delay + TURN_MS + HOLD_MS);
        });
        const totalMs = (discardedIdx.length - 1) * STAGGER_MS + TURN_MS + HOLD_MS + FADE_MS;
        return _sleep(totalMs, signal);
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

    // Every solver slot busy (optimizer.reason.serverBusy) is retried automatically
    // instead of surfacing an error the user has to notice and re-click past - up to
    // _SERVER_BUSY_MAX_WAIT_MS total, then it gives up like any other failure. The
    // *other* 429s (alreadySolving, tooManyRequests) are not retried: alreadySolving
    // usually means this same tab's own prior click is still in flight, and silently
    // looping on that would mask a stuck request instead of surfacing it.
    const _SERVER_BUSY_RETRY_DELAY_MS = 1500;
    const _SERVER_BUSY_MAX_WAIT_MS = 45000;

    // rejects with the same AbortError shape fetch() throws, so both share one catch.
    function _sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            const onAbort = () => {
                clearTimeout(id);
                reject(new DOMException('Aborted', 'AbortError'));
            };
            const id = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    async function _runSolve(url, body) {
        _abortController = new AbortController();
        const signal = _abortController.signal;
        const deadline = Date.now() + _SERVER_BUSY_MAX_WAIT_MS;
        try {
            for (;;) {
                if (_waitingForSlot) {
                    _waitingForSlot = false;
                    _renderResult();
                }
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal,
                });
                if (res.status === 429) {
                    const data = await res.json().catch(() => null);
                    const key = data?.detail?.reason_key;
                    if (key === 'optimizer.reason.serverBusy' && Date.now() < deadline) {
                        _waitingForSlot = true;
                        _renderResult();
                        await _sleep(_SERVER_BUSY_RETRY_DELAY_MS, signal);
                        continue;
                    }
                    _error = key ? _t(key) : _t('optimizer.solveFailed');
                    return;
                }
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (data.status === 'optimal' || data.status === 'feasible') {
                    _result = data;
                } else {
                    _error = _formatReason(data);
                }
                return;
            }
        } catch (err) {
            _error = err.name === 'AbortError' ? _t('optimizer.cancelled') : _t('optimizer.solveFailed');
        } finally {
            _solving = false;
            _waitingForSlot = false;
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
        const isFeasible = _result.status === 'feasible';
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

        // Explore's individual points never carry their own solve_ms (that field is
        // stamped on by the /build/optimize endpoint wrapper, which explore_weapon()
        // bypasses) - show the batch's total processing_ms instead so the badge isn't
        // just silently missing on that tab.
        const solveMs = _activeTab === 'explore' ? _explore?.processing_ms : _result.solve_ms;
        const statusBarHtml = `
            <div class="optimizer-status-bar">
                <button type="button" class="modal-btn primary optimizer-reoptimize-btn" id="optimizer-reoptimize-btn">${_t('optimizer.reoptimize')}</button>
                <div class="optimizer-status-meta">
                    <span class="optimizer-status-ok${isFeasible ? ' warning' : ''}">${isFeasible ? '&#9888;' : '&#10003;'}</span>
                    <span class="optimizer-status-label">${_t(isFeasible ? 'optimizer.statusFeasible' : 'optimizer.statusOptimal')}</span>
                    ${solveMs != null ? `<span class="optimizer-badge">${Math.round(solveMs)} ms</span>` : ''}
                </div>
            </div>`;
        const barsHtml = `
            <div class="optimizer-results-bars">
                ${_statBarRowHtml('stats.ergo', 'ergo-bar', ergoTarget, ergoText)}
                ${_statBarRowHtml('stats.verRecoil', 'recoil-bar', rvTarget, rvText)}
                ${_statBarRowHtml('stats.horRecoil', 'recoil-bar', rhTarget, rhText)}
                ${_statBarRowHtml('stats.accuracy', 'accuracy-bar', accTarget, accText)}
            </div>`;
        const substatsHtml = `
            <div class="optimizer-results-substats stat-subsection">
                <div class="stat-subsection-cols">
                <div class="stat-col">
                <div class="stat-row"><span class="stat-label">${_t('stats.eedLabelShort')}</span><span class="${eedClass}">${eedText}</span></div>
                <div class="stat-row"><span class="stat-label">${_t('stats.overswing')}</span><span class="${overswingClass}">${overswingText}</span></div>
                </div>
                <div class="stat-col">
                <div class="stat-row"><span class="stat-label">${_t('stats.weight')}</span><span>${s.total_weight.toFixed(3)} kg</span></div>
                ${sightingRow}
                </div>
                </div>
            </div>`;
        const gunImgHtml = `
            <div class="bp-gun-img-wrap" id="optimizer-result-gun-img-wrap">
                <img id="optimizer-result-gun-img" class="optimizer-result-gun-img" alt="" onerror="this.style.visibility='hidden'">
            </div>`;
        const costRowHtml = `
            <div class="cost-total-row">
                <span>${_t('stats.totalCost')}</span>
                <span>${_formatPrice(cost)}</span>
            </div>`;

        // Explore tab: the sampled-curve chart gets prepended into
        // #optimizer-explore-merged-body (see _renderExploreChart) so the graph and
        // the selected point's stat/gun preview read as one card side by side, instead
        // of two stacked boxes for what is really a single pick-a-point interaction.
        if (_activeTab === 'explore') {
            return `
                <div class="stats-section optimizer-explore-stats">
                    ${statusBarHtml}
                    <div class="stats-divider"></div>
                    <div class="optimizer-explore-merged-body" id="optimizer-explore-merged-body">
                        <div class="optimizer-explore-preview-col">
                            ${gunImgHtml}
                            ${barsHtml}
                            <div class="stats-divider"></div>
                            ${substatsHtml}
                            ${costRowHtml}
                            <button class="modal-btn primary optimizer-use-build-inline" id="optimizer-use-build-btn">${_t('optimizer.useThisBuild')}</button>
                        </div>
                    </div>
                </div>
            `;
        }

        return `
            <div class="stats-section">
                ${statusBarHtml}
                <div class="stats-divider"></div>
                <div class="optimizer-results-split">
                    <div class="optimizer-results-statsblock">
                        ${barsHtml}
                        <div class="stats-divider"></div>
                        ${substatsHtml}
                    </div>
                    <div class="optimizer-results-gunimg">
                        ${gunImgHtml}
                        <button class="modal-btn primary optimizer-use-build-inline" id="optimizer-use-build-btn">${_t('optimizer.useThisBuild')}</button>
                    </div>
                </div>
                ${costRowHtml}
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

    // Queue overlay for the result image, mirroring _bpSetQueued (build-preview.js)
    // and _tpSetQueued (tab-manager.js) - same icon/tooltip, scoped to this panel's
    // own wrapper instead of touching the shared placeholder/tooltip containers.
    function _setResultQueued(isQueued) {
        const wrap = document.getElementById('optimizer-result-gun-img-wrap');
        if (!wrap) return;
        let ov = wrap.querySelector('.bp-queue-overlay');
        if (isQueued && !ov) {
            ov = document.createElement('img');
            ov.className = 'bp-queue-overlay';
            ov.src = './assets/images/queue.png';
            ov.alt = '';
            ov.title = _t('toast.imgGenQueuedMsg');
            wrap.appendChild(ov);
        } else if (!isQueued && ov) {
            ov.remove();
        }
    }

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
        const signal = _resultImgAbort.signal;
        try {
            // Queue status check, same as build-preview.js/_bpGenerate and
            // tab-manager.js/_tpLoadImage - best-effort, a failed check just
            // means no overlay rather than blocking the generation itself.
            try {
                const busyResp = await fetch(`${EFTForge.config.API_BASE}/build-image/busy`, { signal });
                if (busyResp.ok) {
                    const busyData = await busyResp.json();
                    if (gen === _resultImgGen && busyData.busy) _setResultQueued(true);
                }
            } catch (_) {}
            if (gen !== _resultImgGen) return;

            const resp = await fetch(`${EFTForge.config.API_BASE}/build-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sptData),
                signal,
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
                _setResultQueued(false);
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
        if (!priced || priced.price_rub == null || priced.no_price) return '-';
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

    // Ammo needed to fill the solved build's magazine(s) - mirrors the weapon card's
    // layout/classes directly beneath it, driven by solver.py's ammo_fill (already
    // priced under the same trader/flea access the rest of the manifest uses). Reads
    // name/icon from the main builder's own ammoMap (see stats-panel.js) since it's
    // the exact same ammo the caller had selected there - no separate lookup needed.
    function _ammoFillHtml() {
        const fill = _result && _result.ammo_fill;
        if (!fill) return '';
        const ammo = window.EFTForge.state.ammoMap && window.EFTForge.state.ammoMap[fill.item_id];
        const name = ammo ? ammo.name : fill.item_id;
        const icon = ammo ? ammo.icon_link : '';
        const shortName = ammo ? ammo.short_name : '';
        // Same {price_rub, vendor, no_price} shape _priceBlipHtml expects, just scaled from
        // a single round's price up to the full magazine capacity's worth.
        const priced = fill.price && fill.price.price_rub != null
            ? { ...fill.price, price_rub: fill.price.price_rub * fill.capacity }
            : null;
        return `
            <div class="optimizer-weapon-card optimizer-ammo-fill-card">
                <div class="attachment-icon-wrapper">
                    <img src="${_escape(icon)}" class="attachment-icon" loading="lazy" decoding="async" onerror="this.style.display='none'">
                    <div class="slot-shortname">${_escape(shortName)}</div>
                </div>
                <div class="optimizer-weapon-card-info">
                    <div class="optimizer-weapon-card-name">${_escape(name)}</div>
                    <div class="optimizer-weapon-card-sub">${_escape(_tFmt('optimizer.ammoFillSub', { count: fill.capacity }))}</div>
                </div>
                <div class="optimizer-weapon-card-price">${_priceBlipHtml(priced)}</div>
            </div>
        `;
    }

    // Shell for the "Retained from Preset" group - only rendered when the solve
    // priced the build off the factory preset AND at least one selected part came
    // bundled with it (see solver.py's retained_from_preset). The item rows
    // themselves are filled in by _populateManifest once resolved, same async
    // hand-off the build manifest table below it uses.
    function _retainedFromPresetHtml() {
        const ids = (_result && _result.retained_from_preset) || [];
        if (!ids.length) return '';
        return `
            <div class="optimizer-section optimizer-retained-section${_retainedOpen ? ' open' : ''}" data-section="retained">
                <div class="optimizer-section-header" data-section-toggle="retained">
                    <span class="optimizer-section-chevron">&#9656;</span>
                    <span class="optimizer-section-title">${_t('optimizer.retainedFromPreset')}</span>
                    <span class="optimizer-retained-count">${ids.length}</span>
                </div>
                <div class="optimizer-section-body" data-section-body>
                    <div class="optimizer-section-body-inner">
                        <div class="optimizer-section-body-content optimizer-retained-grid" id="optimizer-retained-body">
                            <div class="optimizer-manifest-loading">${_t('optimizer.loadingItems')}</div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    function _wireRetainedSection() {
        document.querySelector('[data-section-toggle="retained"]')?.addEventListener('click', () => {
            _retainedOpen = !_retainedOpen;
            document.querySelector('.optimizer-section[data-section="retained"]')?.classList.toggle('open', _retainedOpen);
        });
    }

    // One retained-part icon: just the icon square with its short name overlaid,
    // exactly like the attachment table's own icon cell - no separate row, no
    // stats, since these parts weren't optimization choices to weigh.
    function _retainedItemHtml(item) {
        return `
            <div class="attachment-icon-wrapper" title="${escapeHtml(item.name)}">
                <img src="${escapeHtml(item.icon_link)}" class="attachment-icon" loading="lazy" decoding="async" onerror="this.style.display='none'" />
                <div class="slot-shortname">${escapeHtml(item.short_name)}</div>
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
                    <th>${_t('th.recoil')}</th>
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
                <td>${_recoilCellText(item.recoil_modifier, recoilPercent)}</td>
                <td class="acc-cell">${accContent}</td>
                <td class="${ergoModifier >= 0 ? 'ergo-positive' : 'ergo-negative'}">${ergoModifier >= 0 ? '+' : ''}${formatStat(ergoModifier)}</td>
                <td class="${evo >= 0 ? 'evo-positive' : 'evo-negative'}">${evo >= 0 ? '+' : ''}${evo.toFixed(1)}</td>
                <td class="col-combo-only"></td>
                ${_heatCoolBurnCellHtml(item)}
                ${_velCellHtml(item)}
            </tr>
        `;
    }

    // Chevron wave pulled straight from the publish-confirm resizer hint
    // (.panel-resizer-publish-hint / pub-chevron-pulse in styles.css) - same
    // animation, mirrored on both sides so each group's arrows point in and the
    // wave travels the same direction they point, converging on the button.
    function _solveButtonHtml() {
        return `
            <div class="optimizer-go-row">
                <span class="optimizer-go-chevrons optimizer-go-chevrons-left">
                    <span>&#x3E;</span><span>&#x3E;</span><span>&#x3E;</span>
                </span>
                <button class="modal-btn primary optimizer-go-btn" id="optimizer-solve-btn">${_t('optimizer.solve')}</button>
                <span class="optimizer-go-chevrons optimizer-go-chevrons-right">
                    <span>&#x3C;</span><span>&#x3C;</span><span>&#x3C;</span>
                </span>
            </div>
        `;
    }

    // Pre-solve results pane: same dashed-border/centered-gun-art layout as the main
    // panel's #attachment-placeholder (build-manager.js _restoreNormalPlaceholder), but
    // with the click-slot hint swapped for the solve prompt + GO! button. The gun art is
    // always the static base 512px image - never the composited build render the main
    // placeholder can show - since there's no build yet to composite.
    function _emptyStateHtml() {
        const gun = _gunForResult();
        const imgSrc = gun ? (gun.image_512_link || gun.icon_link || '') : '';
        const imgHtml = imgSrc
            ? `<img class="optimizer-placeholder-gun-img" src="${_escape(imgSrc)}" onerror="this.style.display='none'" alt="">`
            : '';
        const nameHtml = gun ? `<div class="optimizer-placeholder-gun-name">${_escape(gun.name)}</div>` : '';
        return `
            <div class="optimizer-results-empty">
                ${imgHtml}
                ${nameHtml}
                <div>${_t(_activeTab === 'explore' ? 'optimizer.explorePlaceholder' : 'optimizer.resultsPlaceholder')}</div>
                ${_solveButtonHtml()}
            </div>
        `;
    }

    // Pops the Attachment Filtering picker out to fill the results pane in
    // place of whatever it would normally show (status/error/empty/result) -
    // see _pickerExpanded. Closing it just re-runs _renderResult(), which
    // naturally falls through to whichever of those states is current.
    function _renderExpandedPicker(container) {
        const weaponId = window.EFTForge.state?.currentGun?.id;
        const lang = (window.EFTForge.state && window.EFTForge.state.lang) || 'en';
        const dataReady = _modFilterData && _modFilterData.weaponId === weaponId && _modFilterData.lang === lang;
        container.innerHTML = `
            <div class="optimizer-picker-popout">
                <button type="button" class="optimizer-picker-popout-close" id="optimizer-picker-popout-close">&#x3C;&#x3C;&#x3C;</button>
                <div class="optimizer-picker-popout-title">${_t('optimizer.modFilter')}</div>
                <div class="optimizer-picker-popout-body" id="mf-view-body-expanded">
                    ${dataReady ? '' : `<div class="optimizer-filter-loading">${_t('optimizer.loadingMods')}</div>`}
                </div>
            </div>
        `;
        document.getElementById('optimizer-picker-popout-close').addEventListener('click', () => {
            _pickerExpanded = false;
            _renderModFilterWidget();
            _renderResult();
            _swipePicker(document.getElementById('mf-view-body'), 'left');
            _swipePicker(_resultsContainer(), 'left');
        });
        if (dataReady) _renderModFilterCategoryView(document.getElementById('mf-view-body-expanded'), true);
    }

    // Dashes/zeroes for the stat panel before the first sampled point has landed -
    // same shape _statTilesHtml expects from a real final_stats object.
    function _blankExploreStats() {
        return {
            total_ergo: 0,
            recoil_vertical: null,
            recoil_horizontal: null,
            accuracy_moa: null,
            evo_ergo_delta: 0,
            overswing: false,
            total_weight: 0,
            sighting_range: null,
        };
    }

    // Main phase line: what the solver is actually optimizing this call - "ergo" is
    // always a maximization (higher is better), price/recoil are minimized.
    function _solveProgressLabel() {
        if (_waitingForSlot) return _t('optimizer.waitingForSlot');
        if (_solveSelecting) return _t('optimizer.exploreSelecting');
        const p = _solveProgress;
        // Falls back to the generic "Solving..." label if a server predating the
        // per-axis progress fields (or any other unrecognized axis) is ever hit,
        // instead of interpolating a raw, untranslated key into the UI.
        if (!p || !p.phase || !['price', 'recoil', 'ergo'].includes(p.axis)) return _t('optimizer.solving');
        const stat = _t('optimizer.exploreObjective.' + p.axis);
        const verbKey = p.axis === 'ergo' ? 'optimizer.exploreVerb.maximize' : 'optimizer.exploreVerb.minimize';
        return _t(verbKey).replace('{stat}', stat);
    }

    // Secondary line: the epsilon-constraint bound this call is solving against
    // (sweep steps only - the two boundary calls are unconstrained), plus the
    // step count within the sweep.
    function _solveProgressDetail() {
        if (_solveSelecting) return '';
        const p = _solveProgress;
        if (!p || !p.phase) return '';
        const parts = [];
        if (p.bound_stat === 'ergo') {
            parts.push(_t('optimizer.exploreConstraint.ergoMin').replace('{value}', Math.round(p.bound_value)));
        } else if (p.bound_stat === 'recoil_v') {
            parts.push(_t('optimizer.exploreConstraint.recoilMax').replace('{value}', Math.round(p.bound_value)));
        }
        parts.push(_t('optimizer.exploreStepCount').replace('{done}', p.done).replace('{total}', p.total));
        return parts.join(' · ');
    }

    function _formatSolveElapsed() {
        if (_solveStartedAt == null) return '0.0s';
        return ((Date.now() - _solveStartedAt) / 1000).toFixed(1) + 's';
    }

    // Ticks independently of the progress-driven re-renders (a slow single step
    // shouldn't leave the clock looking frozen) - just a text update, not a
    // rebuild of the overlay/placeholder markup.
    function _tickSolveElapsed() {
        const el = document.getElementById('optimizer-solve-elapsed');
        if (el) el.textContent = _formatSolveElapsed();
    }

    // Cheap static-asset swap only, no server-render fetch - the real per-build
    // composite (_loadResultGunImage) is generated once for the final result.
    // Firing that on every progress tick would queue a render request per sampled
    // point, up to ~80 for one sweep.
    function _setPreviewGunImage(build) {
        const imgEl = document.getElementById('optimizer-result-gun-img');
        const gun = _gunForResult();
        if (!imgEl || !gun) return;
        const pairs = build?.slot_pairs || [];
        const key = pairs.map(p => p.join(':')).sort().join(',');
        imgEl.style.opacity = '';
        imgEl.style.filter = '';
        imgEl.style.visibility = '';
        imgEl.src = key === ''
            ? (gun.bare_image_512_link || gun.image_512_link || gun.icon_link || '')
            : (gun.image_512_link || gun.icon_link || '');
    }

    // Copies the outcome of re-running a template into the live DOM element-by-
    // element (matched positionally, since both sides came from the same template
    // and are therefore in the same order) instead of replacing innerHTML - so
    // elements that are already on screen (a spinner mid-spin, a bar mid-transition)
    // keep running instead of being torn down and restarted from scratch.
    function _syncBySelector(liveRoot, freshRoot, selector, apply) {
        const liveEls = liveRoot.querySelectorAll(selector);
        const freshEls = freshRoot.querySelectorAll(selector);
        liveEls.forEach((el, i) => { if (freshEls[i]) apply(el, freshEls[i]); });
    }

    // Patches the bars/substats/status/cost of an already-mounted stats panel to
    // match a new final_stats object, without touching any other element in
    // `content` - in particular without recreating .stat-bar-fill, so its existing
    // width transitions from its current value instead of snapping back to 0
    // first. Shared by the live solving placeholder and by switching between
    // already-solved Explore points, so bars never reset just because the
    // underlying build changed while the panel stayed on screen.
    function _patchStatsPanel(content, statsHtml) {
        const fresh = document.createElement('div');
        fresh.innerHTML = statsHtml;
        _syncBySelector(content, fresh, '.stat-bar-fill', (live, src) => {
            // Keep data-target current too, not just style.width - _buildSolvingResult's
            // one-time "grow in" rAF reads data-target when it fires a couple of frames
            // later, and it needs to see this tick's value rather than the stale one
            // baked in at mount, or it'd yank the bar back to that old value.
            live.dataset.target = src.dataset.target ?? '0';
            live.style.width = (src.dataset.target ?? 0) + '%';
        });
        _syncBySelector(content, fresh, '.stat-bar-value', (live, src) => {
            live.textContent = src.textContent;
        });
        _syncBySelector(content, fresh, '.optimizer-results-substats .stat-row > span:last-child', (live, src) => {
            live.className = src.className;
            live.textContent = src.textContent;
        });
        _syncBySelector(content, fresh, '.cost-total-row span:last-child', (live, src) => {
            live.textContent = src.textContent;
        });
        _syncBySelector(content, fresh, '.optimizer-status-ok', (live, src) => {
            live.className = src.className;
            live.innerHTML = src.innerHTML;
        });
        _syncBySelector(content, fresh, '.optimizer-status-label', (live, src) => {
            live.textContent = src.textContent;
        });
    }

    function _statsHtmlForPreview(build) {
        const savedResult = _result;
        _result = build || {
            status: 'optimal', grand_total_rub: null, total_price_rub: null,
            final_stats: _blankExploreStats(), slot_pairs: [],
        };
        const html = _statTilesHtml(_result.final_stats);
        _result = savedResult;
        return html;
    }

    // First paint of the solving placeholder: full markup, bars growing in from 0
    // like a freshly-mounted result panel. Subsequent progress ticks go through
    // _updateSolvingResult instead, which patches this same DOM in place.
    function _buildSolvingResult(container) {
        const preview = _solveProgress?.previewBuild || null;
        const statsHtml = _statsHtmlForPreview(preview);
        const p = _solveProgress;
        const pct = p?.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
        container.innerHTML = `
            <div class="optimizer-solve-shell">
                <div class="optimizer-results optimizer-solve-content" inert>
                    ${statsHtml}
                </div>
                <div class="optimizer-solve-overlay">
                    <div class="optimizer-spinner optimizer-spinner-lg"></div>
                    <div class="optimizer-solve-phase">${_escape(_solveProgressLabel())}</div>
                    <div class="optimizer-solve-detail">${_waitingForSlot ? '' : _escape(_solveProgressDetail())}</div>
                    <div class="optimizer-solve-elapsed" id="optimizer-solve-elapsed">${_formatSolveElapsed()}</div>
                    <div class="optimizer-solve-progress-track">
                        <div class="optimizer-solve-progress-fill" style="width:${_waitingForSlot ? 0 : pct}%"></div>
                    </div>
                    <button class="modal-btn" id="optimizer-cancel-btn">${_t('modal.cancel')}</button>
                </div>
            </div>
        `;
        document.getElementById('optimizer-cancel-btn').addEventListener('click', _cancelSolve);

        requestAnimationFrame(() => requestAnimationFrame(() => {
            container.querySelectorAll('.stat-bar-fill[data-target]').forEach(el => {
                el.style.width = el.dataset.target + '%';
            });
        }));

        _setPreviewGunImage(preview);
        if (p?.points.length) _renderLiveChart(p.points, _exploreTradeoff);
    }

    // Repeat progress ticks: patch the existing shell in place - spinner and bars
    // keep animating from wherever they currently are instead of resetting.
    function _updateSolvingResult(shell) {
        const preview = _solveProgress?.previewBuild || null;
        const content = shell.querySelector('.optimizer-solve-content');
        if (content) _patchStatsPanel(content, _statsHtmlForPreview(preview));

        const p = _solveProgress;
        const pct = p?.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
        const phaseEl = shell.querySelector('.optimizer-solve-phase');
        if (phaseEl) phaseEl.textContent = _solveProgressLabel();
        const detailEl = shell.querySelector('.optimizer-solve-detail');
        if (detailEl) detailEl.textContent = _waitingForSlot ? '' : _solveProgressDetail();
        const fillEl = shell.querySelector('.optimizer-solve-progress-fill');
        if (fillEl) fillEl.style.width = (_waitingForSlot ? 0 : pct) + '%';

        _setPreviewGunImage(preview);
        if (p?.points.length) _renderLiveChart(p.points, _exploreTradeoff);
    }

    // While an Explore sweep runs: the same result-panel markup the finished solve
    // uses (_statTilesHtml) plus a self-animating chart (_renderLiveChart) render
    // immediately, blank until the first real sampled build lands, then refreshed
    // in place as each subsequent
    // point streams in - bars, gun preview and chart curve all filling in live. An
    // inert dimmed copy of that panel sits under an overlaid spinner/phase-label/
    // cancel button, so it reads as "the result is assembling behind the overlay"
    // rather than a bare throbber. Only the very first call builds the DOM; later
    // calls patch it in place so the spinner and bar transitions never restart.
    function _renderSolvingResult(container) {
        const shell = container.querySelector('.optimizer-solve-shell');
        if (shell) _updateSolvingResult(shell);
        else _buildSolvingResult(container);
    }

    function _renderResult() {
        const existingChart = _resultsContainer()?.querySelector('.optimizer-explore-chart');
        _disposeManifestMarquee?.();
        _disposeManifestMarquee = null;
        _renderBuildResult();
        // While solving, _renderSolvingResult/_renderLiveChart already own the
        // chart entirely - calling this too can reuse a stale finished chart (see
        // its existingChart/_exploreChartData check) since _explore isn't nulled
        // out until _solveExplore actually starts running, a tick after this
        // render already fired with _solving true (e.g. right after clicking
        // Re-optimize).
        if (_activeTab === 'explore' && !_solving) _renderExploreChart(existingChart);
        for (const id of ['optimizer-tab-optimize', 'optimizer-tab-explore', 'optimizer-tab-gunsmith']) {
            const button = document.getElementById(id);
            if (button) button.disabled = _solving;
        }
        document.querySelector('.optimizer-config-pane')?.toggleAttribute('inert', _solving);
    }

    function _renderBuildResult() {
        const container = _resultsContainer();
        if (!container) return;

        if (_pickerExpanded) {
            _renderExpandedPicker(container);
            return;
        }

        if (_solving) {
            if (_activeTab === 'explore') { _renderSolvingResult(container); return; }
            const statusText = _waitingForSlot ? _t('optimizer.waitingForSlot') : _t('optimizer.solving');
            container.innerHTML = `
                <div class="optimizer-result optimizer-results-status">
                    <div class="optimizer-spinner optimizer-spinner-lg"></div>
                    <div>${statusText}</div>
                    <button class="modal-btn" id="optimizer-cancel-btn">${_t('modal.cancel')}</button>
                </div>
            `;
            document.getElementById('optimizer-cancel-btn').addEventListener('click', _cancelSolve);
            return;
        }
        if (_error) {
            container.innerHTML = `
                <div class="optimizer-result optimizer-results-status">
                    <div class="optimizer-error">${_escape(_error)}</div>
                    ${_solveButtonHtml()}
                </div>
            `;
            document.getElementById('optimizer-solve-btn').addEventListener('click', _solveOptimize);
            return;
        }
        if (!_result) {
            container.innerHTML = _emptyStateHtml();
            document.getElementById('optimizer-solve-btn').addEventListener('click', _solveOptimize);
            return;
        }

        const s = _result.final_stats;
        // Direct-child check (not just "does .optimizer-results exist anywhere"):
        // right after a solve finishes, the container can still hold the previous
        // tick's solving placeholder, whose .optimizer-solve-content also carries
        // the optimizer-results class, just nested a level deeper - that stale DOM
        // needs the full rebuild below, not a patch.
        if (_activeTab === 'explore' && container.querySelector(':scope > .optimizer-results')) {
            _patchFinishedResult(container, s);
        } else {
            _buildFinishedResult(container, s);
        }
    }

    // Everything under .optimizer-manifest - split out so both the full build and
    // the patch path (which only replaces this section, not the stats above it)
    // share one template instead of two copies drifting apart.
    function _manifestSectionHtml() {
        return `
            ${_weaponCardHtml()}
            ${_ammoFillHtml()}
            ${_retainedFromPresetHtml()}

            <div class="optimizer-manifest-header">
                <span class="optimizer-manifest-title">${_t('optimizer.buildManifest')}</span>
            </div>
            <div class="optimizer-manifest-table-wrap">
                <table class="attachment-table hide-col-rub-recoil hide-col-balance hide-col-acc hide-col-heat hide-col-vel optimizer-manifest-table">
                    ${_manifestTheadHtml()}
                    <tbody id="optimizer-manifest-body">
                        <tr><td colspan="11" class="optimizer-manifest-loading">${_t('optimizer.loadingItems')}</td></tr>
                    </tbody>
                </table>
            </div>
        `;
    }

    function _buildFinishedResult(container, s) {
        container.innerHTML = `
            <div class="optimizer-results">
                ${_statTilesHtml(s)}

                <div class="optimizer-manifest">
                    ${_manifestSectionHtml()}
                </div>
            </div>
        `;
        document.getElementById('optimizer-reoptimize-btn').addEventListener('click', _solveOptimize);
        document.getElementById('optimizer-use-build-btn').addEventListener('click', _useBuild);
        _wireRetainedSection();

        // Grow the stat bars from 0% to their targets, same as the main stats panel.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            container.querySelectorAll('.stat-bar-fill[data-target]').forEach(el => {
                el.style.width = el.dataset.target + '%';
            });
        }));

        _loadResultGunImage();
        _populateManifest(_result);
    }

    // Switching between already-solved Explore points: the stats/bars panel is
    // patched in place (see _patchStatsPanel) so bars transition from their
    // current width instead of resetting to 0, while the manifest/gun image -
    // which genuinely need to reflect a different build's parts - still refresh
    // in full, same as always.
    function _patchFinishedResult(container, s) {
        const results = container.querySelector(':scope > .optimizer-results');
        _patchStatsPanel(results, _statTilesHtml(s));

        const manifestSection = results.querySelector('.optimizer-manifest');
        if (manifestSection) {
            manifestSection.innerHTML = _manifestSectionHtml();
            _wireRetainedSection();
        }

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

        // Parts retained from the factory preset get pulled out into their own group
        // (see _retainedFromPresetHtml) rather than cluttering the manifest as if
        // they'd been actively chosen alongside the optimized ones.
        const retainedIds = new Set(result.retained_from_preset || []);
        const retainedBody = document.getElementById('optimizer-retained-body');
        if (retainedBody) {
            const retainedItems = resolved.filter(i => retainedIds.has(i.id));
            retainedBody.innerHTML = retainedItems.map(_retainedItemHtml).join('');
        }

        const body = document.getElementById('optimizer-manifest-body');
        if (!body) return;
        const manifestItems = resolved.filter(i => !retainedIds.has(i.id));
        if (!manifestItems.length) {
            body.innerHTML = `<tr><td colspan="11" class="optimizer-manifest-loading">${_t('optimizer.noItems')}</td></tr>`;
            return;
        }
        body.innerHTML = manifestItems.map(_manifestRowHtml).join('');
        _wireManifestButtons();
        _disposeManifestMarquee?.();
        _disposeManifestMarquee = _initMarqueeText(body, { hoverOnly: !isMobileLayout() });
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

    // The manifest table's lock/ban icons are just a read of _includedModIds/
    // _excludedModIds taken at render time (see _manifestRowHtml) - anything that
    // mutates those two arrays from the *other* direction (the Attachment Filtering
    // section's tags/reset) needs to call this too, or the icons go stale until the
    // next re-optimize re-renders the whole table.
    function _syncManifestIcons() {
        document.querySelectorAll('#optimizer-manifest-body [data-lock-id]').forEach(b =>
            b.classList.toggle('active', _includedModIds.includes(b.dataset.lockId)));
        document.querySelectorAll('#optimizer-manifest-body [data-ban-id]').forEach(b =>
            b.classList.toggle('active', _excludedModIds.includes(b.dataset.banId)));
    }

    function _syncFilterSurfaces() {
        _syncManifestIcons();
        // Surface the change: a lock/ban from the manifest table edits the same
        // Attachment Filtering section, so pop it open if the user has it collapsed.
        // Must happen before the _renderModFilterWidget() call below, since that's
        // what decides whether to build the (lazily-rendered) tile grid.
        if (!_sectionOpen.modFilter) {
            _sectionOpen.modFilter = true;
            document.querySelector('.optimizer-section[data-section="modFilter"]')?.classList.add('open');
        }
        // Keep the Attachment Filtering section's tags/tiles in sync if it's mounted.
        if (document.getElementById('optimizer-mod-filter-widget')) _renderModFilterWidget();
    }

    async function _useBuild() {
        if (!_result) return;
        const ammo = _activeTab === 'explore' && _explore ? {
            a: _explore.request.selected_ammo_id || null,
            ua: _explore.request.selected_ubgl_ammo_id || null,
        } : {};
        await loadBuildFromPayload({ v: 1, g: _result.gun_id, p: _result.slot_pairs, ...ammo });
        hidePanel();
    }

    // Scripts are loaded at the end of <body> so DOM is ready; init immediately.
    init();

    return { showPanel, hidePanel, onLangChange, onTraderLevelsChange, pulse };

}());
