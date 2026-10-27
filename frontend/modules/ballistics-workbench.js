window.EFTForge = window.EFTForge || {};

/* ============================================================
   BALLISTICS WORKBENCH
   The Ballistics header button opens this page in the gun builder's own layout: the
   left panel holds the tool switcher and each tool's controls, the right panel each
   tool's results. A slot on the left pops an item table out on the right, the same
   way picking an attachment does. On desktop it lives in its own build tab
   (tab-manager.js); on mobile it opens as a page with the builder's drawer.

   The tools themselves live in armor-sim.js (simulator), ballistics-tools.js
   (effectiveness chart, armor data, drop table) and ammo-table.js (ammo table).
============================================================ */

window.EFTForge.workbench = (function () {

    const TOOLS = ['armor', 'chart', 'sheets', 'flight', 'ammo'];
    const TOOL_KEY = 'eftforge_workbench_tool';

    let _active = false;
    let _tool = 'armor';
    let _picker = null;     // the open picker's options and its sort/search state
    // The build the workbench was opened from: entering closes that build like the back
    // button does, so the tools read its gun, ammo and velocity from here instead
    let _snapshot = null;

    try {
        const saved = localStorage.getItem(TOOL_KEY);
        if (TOOLS.indexOf(saved) !== -1) _tool = saved;
    } catch { /* private mode */ }

    /* ===========================
       OPEN AND CLOSE
    =========================== */

    // The header button: a tab on desktop, the page itself on mobile
    async function open() {
        if (EFTForge.tabs && EFTForge.tabs.openBallisticsTab && document.body.dataset.mobile !== 'true') {
            await EFTForge.tabs.openBallisticsTab();
        } else {
            enter();
        }
    }

    function enter() {
        // Remember the open build, then leave it the same way the back button does
        const state = EFTForge.state || {};
        if (state.currentGun) {
            const ammoSelect = /** @type {HTMLSelectElement | null} */ (_el('ammo-select'));
            _snapshot = {
                serial: (_snapshot ? _snapshot.serial : 0) + 1,
                gunId: state.currentGun.id,
                gunName: state.currentGun.name,
                ammoId: ammoSelect && ammoSelect.value ? ammoSelect.value : null,
                velocityPct: state.lastVelocityModifierPct,
            };
            returnToGunSelection();
        }
        const container = _el('main-container');
        container.classList.remove('no-gun');
        container.classList.add('ballistics-mode');
        _active = true;
        _syncHeaderExpand();
        _updateStaticText();
        setTool(_tool);
        const left = _el('ballistics-left');
        const leftPanel = document.querySelector('.left-panel');
        if (leftPanel) leftPanel.scrollTop = 0;
        left.classList.add('panel-enter');
        left.addEventListener('animationend', function () { left.classList.remove('panel-enter'); }, { once: true });
    }

    function leave() {
        if (!_active) return;
        _active = false;
        closePicker();
        closeMobileRightPanel();
        const container = _el('main-container');
        container.classList.remove('ballistics-mode');
        if (!(EFTForge.state && EFTForge.state.currentGun)) {
            container.classList.add('no-gun');
            _syncHeaderScrollOnly();
        }
    }

    function isActive() { return _active; }

    /* ===========================
       TOOLS
    =========================== */

    function setTool(tool) {
        if (TOOLS.indexOf(tool) === -1) tool = 'armor';
        _tool = tool;
        try { localStorage.setItem(TOOL_KEY, tool); } catch { /* private mode */ }
        closePicker();
        closeMobileRightPanel();
        document.querySelectorAll('#ballistics-left [data-bw-tool], #ballistics-right [data-bw-tool]').forEach(function (node) {
            const el = /** @type {HTMLElement} */ (node);
            const mine = el.dataset.bwTool === tool;
            if (el.classList.contains('toggle-btn')) {
                el.classList.toggle('active', mine);
                el.setAttribute('role', 'tab');
                el.setAttribute('aria-selected', String(mine));
                el.setAttribute('aria-controls', 'bw-left-' + el.dataset.bwTool);
            }
            else el.hidden = !mine;
        });
        if (!_active) return;
        if (tool === 'armor') {
            EFTForge.armorSim && EFTForge.armorSim.show();
        } else if (tool === 'ammo') {
            EFTForge.ammoTable && EFTForge.ammoTable.show();
        } else if (EFTForge.ballisticsTools) {
            EFTForge.ballisticsTools.show(tool);
        }
        // The browse tables are the point of these tools, so phones go straight to them
        if (tool === 'chart' || tool === 'sheets' || tool === 'ammo') openMobileRightPanel();
    }

    function currentTool() { return _tool; }

    /** The build the workbench was last opened from, or null: {serial, gunId, gunName, ammoId, velocityPct}. */
    function buildSnapshot() { return _snapshot; }

    /* ===========================
       ITEM PICKER
       A slot on the left opens this on the right: a sortable, searchable table of the
       items that fit, like the gun builder's attachment table.
    =========================== */

    /**
     * @param {{ title: string, rows: any[], columns: any[], selectedId?: string|null,
     *           onPick: (row: any) => void, onClear?: (() => void) | null,
     *           sort?: { key: string, asc: boolean }, onClose?: (() => void) | null }} options
     */
    function openPicker(options) {
        closePicker();
        _picker = Object.assign({ search: '', sort: options.sort || { key: 'name', asc: true } }, options);
        const right = _el('ballistics-right');
        right.classList.add('bw-picking');
        const box = _el('bw-picker');
        box.classList.remove('table-slide-in');
        void box.offsetWidth; // re-trigger the slide-in on every open
        box.classList.add('table-slide-in');
        box.addEventListener('animationend', function () { box.classList.remove('table-slide-in'); }, { once: true });
        _renderPicker();
        const panel = /** @type {HTMLElement | null} */ (document.querySelector('.right-panel'));
        if (panel) panel.scrollTop = 0;
        openMobileRightPanel();
        const search = /** @type {HTMLInputElement | null} */ (_el('bw-picker-search'));
        if (search && !isMobileLayout()) search.focus();
    }

    function closePicker() {
        const right = _el('ballistics-right');
        if (!right || !_picker) return;
        const onClose = _picker.onClose;
        _picker = null;
        right.classList.remove('bw-picking');
        _el('bw-picker').innerHTML = '';
        if (onClose) onClose();
        closeMobileRightPanel();
    }

    function _renderPicker() {
        const p = _picker;
        const box = _el('bw-picker');
        const oldScroll = box.querySelector('.bw-table-scroll');
        const scrollLeft = oldScroll ? oldScroll.scrollLeft : 0;
        let html = '<div class="att-table-header">' +
            '<h3>' + escapeHtml(p.title) + '</h3>' +
            '<div class="att-table-header-toggles">' +
            (p.onClear ? '<button type="button" class="toggle-btn bw-picker-clear" id="bw-picker-clear">' + escapeHtml(_t('workbench.remove')) + '</button>' : '') +
            '</div>' +
            '<button type="button" class="att-table-close-btn" id="bw-picker-close" aria-label="' + escapeHtml(_t('workbench.back')) + '">&#x2715;</button></div>' +
            '<input type="text" id="bw-picker-search" class="search-input" placeholder="' + escapeHtml(_t('workbench.search')) + '" value="' + escapeHtml(p.search) + '">' +
            '<div class="bw-table-scroll"><table class="bw-picker-table"><thead><tr>';
        const rows = _pickerRows();
        p.columns.forEach(function (col) {
            const sorted = p.sort.key === col.key ? (p.sort.asc ? ' sort-asc' : ' sort-desc') : '';
            html += '<th class="bw-sortable' + sorted + '" data-col="' + escapeHtml(col.key) + '"' +
                (sorted ? ' aria-sort="' + (p.sort.asc ? 'ascending' : 'descending') + '"' : '') +
                (col.tip ? ' data-tooltip="' + escapeHtml(col.tip) + '"' : '') + '><button type="button" class="bw-sort-button">' + escapeHtml(col.label) +
                ' <span class="sort-indicator">' + (sorted ? (p.sort.asc ? '&#9650;' : '&#9660;') : '') + '</span></button></th>';
        });
        html += '</tr></thead><tbody>';
        rows.forEach(function (row, index) {
            const selected = p.selectedId && row.id === p.selectedId;
            html += '<tr class="bw-picker-row' + (selected ? ' bw-selected' : '') + '" tabindex="0" data-index="' + index + '">';
            p.columns.forEach(function (col, i) {
                html += i === 0 ? '<td class="name-cell">' + _nameCell(row) + '</td>' : '<td>' + col.render(row) + '</td>';
            });
            html += '</tr>';
        });
        html += '</tbody></table></div>';
        if (rows.length === 0) html += '<div class="ammo-no-results">' + escapeHtml(_t('ammo.noResults')) + '</div>';
        box.innerHTML = html;
        box.querySelector('.bw-table-scroll').scrollLeft = scrollLeft;

        _el('bw-picker-close').addEventListener('click', closePicker);
        const clear = _el('bw-picker-clear');
        if (clear) clear.addEventListener('click', function () {
            const onClear = p.onClear;
            closePicker();
            onClear();
        });
        const search = /** @type {HTMLInputElement} */ (_el('bw-picker-search'));
        search.addEventListener('input', function () {
            p.search = search.value;
            const caret = search.selectionStart;
            _renderPicker();
            const again = /** @type {HTMLInputElement} */ (_el('bw-picker-search'));
            again.focus();
            again.setSelectionRange(caret, caret);
        });
        box.querySelectorAll('th[data-col]').forEach(function (th) {
            th.addEventListener('click', function () {
                const key = /** @type {HTMLElement} */ (th).dataset.col;
                p.sort = { key: key, asc: key === p.sort.key ? !p.sort.asc : key === 'name' };
                _renderPicker();
                const active = box.querySelector('th[aria-sort] button');
                if (active) /** @type {HTMLElement} */ (active).focus({ preventScroll: true });
            });
        });
        box.querySelectorAll('tr.bw-picker-row').forEach(function (tr) {
            tr.addEventListener('keydown', function (event) {
                const key = /** @type {KeyboardEvent} */ (event).key;
                if (key === 'Enter' || key === ' ') {
                    event.preventDefault();
                    /** @type {HTMLElement} */ (tr).click();
                }
            });
            tr.addEventListener('click', function () {
                const row = rows[Number(/** @type {HTMLElement} */ (tr).dataset.index)];
                const onPick = p.onPick;
                closePicker();
                closeMobileRightPanel();
                onPick(row);
            });
        });
    }

    function _pickerRows() {
        const p = _picker;
        let rows = p.rows;
        const query = p.search.trim().toLowerCase();
        if (query) {
            rows = rows.filter(function (row) {
                return (row.name || '').toLowerCase().indexOf(query) !== -1 ||
                    (row.short_name || '').toLowerCase().indexOf(query) !== -1;
            });
        }
        const col = p.columns.find(function (c) { return c.key === p.sort.key; }) || p.columns[0];
        const value = col.sort || function (row) { return row[col.key]; };
        return rows.slice().sort(function (a, b) {
            let va = value(a);
            let vb = value(b);
            if (va == null && vb == null) return 0;
            if (va == null) return 1;
            if (vb == null) return -1;
            if (typeof va === 'string') { va = va.toLowerCase(); vb = String(vb).toLowerCase(); }
            const cmp = va < vb ? -1 : va > vb ? 1 : 0;
            return p.sort.asc ? cmp : -cmp;
        });
    }

    function _nameCell(row) {
        return '<div class="attachment-name-wrapper"><div class="attachment-icon-wrapper">' +
            (row.icon_link ? '<img src="' + escapeHtml(row.icon_link) + '" class="attachment-icon" loading="lazy" decoding="async" onerror="this.style.display=\'none\'">' : '') +
            '<div class="slot-shortname">' + escapeHtml(row.short_name || '') + '</div></div>' +
            '<div class="att-name-and-rating"><div class="attachment-name-text">' + escapeHtml(row.name || '') + '</div></div></div>';
    }

    /* ===========================
       TEXT
    =========================== */

    function _updateStaticText() {
        const title = _el('bw-title');
        if (title) title.textContent = _t('workbench.title');
        const back = _el('bw-back-btn');
        if (back) back.textContent = '← ' + _t('workbench.back');
        document.querySelectorAll('#bw-nav [data-bw-tool]').forEach(function (btn) {
            btn.textContent = _t('workbench.tool.' + /** @type {HTMLElement} */ (btn).dataset.bwTool);
        });
    }

    // The tools refresh themselves (each gets its own onLangChange); we only redo our text
    function onLangChange() {
        _updateStaticText();
        if (_picker) closePicker();
    }

    function init() {
        _updateStaticText();
        _el('bw-back-btn').addEventListener('click', function () { returnToGunSelection(); });
        document.querySelectorAll('#bw-nav [data-bw-tool]').forEach(function (btn) {
            btn.addEventListener('click', function () { setTool(/** @type {HTMLElement} */ (btn).dataset.bwTool); });
        });
        // Escape closes a picker, the way it does nothing harmful anywhere else
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && _picker) closePicker();
        });
        // Give every tool table our shared scrollbar and release it when its table changes.
        const right = _el('ballistics-right');
        const scrollbars = new Map();
        const observer = new MutationObserver(function () {
            scrollbars.forEach(function (bar, node) {
                if (!right.contains(node)) {
                    bar.dispose();
                    scrollbars.delete(node);
                }
            });
            right.querySelectorAll('.bw-table-scroll').forEach(function (node) {
                if (scrollbars.has(node)) return;
                const bar = setupCustomScrollbar(node, { axis: 'x' });
                if (bar) scrollbars.set(node, bar);
            });
        });
        observer.observe(right, { childList: true, subtree: true });
    }

    /** @returns {any} */
    function _el(id) { return document.getElementById(id); }

    function _t(key) { return (EFTForge.lang && EFTForge.lang.t) ? EFTForge.lang.t(key) : key; }

    // Scripts load at the end of <body>, so the panels' markup is already there
    init();

    return {
        open: open,
        enter: enter,
        leave: leave,
        isActive: isActive,
        setTool: setTool,
        currentTool: currentTool,
        buildSnapshot: buildSnapshot,
        openPicker: openPicker,
        closePicker: closePicker,
        onLangChange: onLangChange,
    };

}());
