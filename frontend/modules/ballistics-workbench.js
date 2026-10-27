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

    const TOOLS = ['armor', 'chart', 'flight', 'ammo'];
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
        closePicker(true);
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
        closePicker(true);
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
        // Only the tools with settings have anything to reset
        _el('bw-reset-btn').hidden = tool !== 'armor' && tool !== 'flight';
        if (!_active) return;
        if (tool === 'armor') {
            EFTForge.armorSim && EFTForge.armorSim.show();
        } else if (tool === 'ammo') {
            EFTForge.ammoTable && EFTForge.ammoTable.show();
        } else if (EFTForge.ballisticsTools) {
            EFTForge.ballisticsTools.show(tool);
        }
        // The browse tables are the point of these tools, so phones go straight to them
        if (tool === 'chart' || tool === 'ammo') openMobileRightPanel();
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
     * Works like the gun builder's attachment table: picking a row installs it and the table
     * stays open on the slot; right clicking the installed row takes it out again.
     * @param {{ key: string, slotName: string, art?: string, artKind?: string, rows: any[], columns: any[],
     *           currentId: () => (string|null), onPick: (row: any) => void, onRemove?: ((row: any) => void) | null,
     *           sort?: { key: string, asc: boolean },
     *           conflictFor?: ((row: any) => any) | null, onConflict?: ((row: any, conflict: any) => void) | null,
     *           onClose?: (() => void) | null }} options
     */
    function openPicker(options) {
        // The slot that's already open only brings the phone drawer back, like the builder
        if (_picker && _picker.key === options.key) {
            openMobileRightPanel();
            return;
        }
        closePicker(true);
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

    // Redraw the open picker in place, keeping its search and sort (an install, prices arriving)
    function refreshPicker() {
        if (_picker) _renderPicker();
    }

    /** The slot key the picker is open on, or null. */
    function pickerKey() { return _picker ? _picker.key : null; }

    // `quiet` skips the placeholder's slide-in, for when another table replaces this one
    function closePicker(quiet) {
        const right = _el('ballistics-right');
        if (!right || !_picker) return;
        const onClose = _picker.onClose;
        _picker = null;
        right.classList.remove('bw-picking');
        _el('bw-picker').innerHTML = '';
        if (onClose) onClose();
        if (quiet === true) return;
        const tool = /** @type {HTMLElement | null} */ (right.querySelector('.bw-right-tool:not([hidden])'));
        if (tool) {
            tool.classList.remove('placeholder-slide-in');
            void tool.offsetWidth;
            tool.classList.add('placeholder-slide-in');
            tool.addEventListener('animationend', function () { tool.classList.remove('placeholder-slide-in'); }, { once: true });
        }
    }

    function _renderPicker() {
        const p = _picker;
        const box = _el('bw-picker');
        const oldScroll = box.querySelector('.bw-table-scroll');
        const scrollLeft = oldScroll ? oldScroll.scrollLeft : 0;
        const rows = _pickerRows();
        const currentId = p.currentId();
        // The header shows what's in the slot now, or the slot's art, like the grid view's table
        const selected = currentId ? p.rows.find(function (row) { return row.id === currentId; }) : null;
        let headerImg = '';
        if (selected && selected.icon_link) {
            headerImg = '<div class="att-table-icon-preview"><img class="att-table-gun-img" src="' + escapeHtml(selected.icon_link) +
                '" alt=""><div class="slot-shortname">' + escapeHtml(selected.short_name || '') + '</div></div>';
        } else if (p.art) {
            // An empty slot shows as the loadout draws it: a square hatched box with the slot art
            headerImg = '<div class="bw-picker-art bw-slot-body"><img class="bw-slot-art bw-art-' + escapeHtml(p.artKind || '') +
                '" src="' + escapeHtml(p.art) + '" alt=""></div>';
        }
        let html = '<div class="att-table-header">' + headerImg +
            '<h3>' + escapeHtml(_t('workbench.selectFor')) + '<strong>' + escapeHtml(p.slotName) + '</strong></h3>' +
            '<button type="button" class="att-table-close-btn" id="bw-picker-close" aria-label="' + escapeHtml(_t('workbench.back')) + '">&#x2715;</button></div>' +
            '<input type="text" id="bw-picker-search" class="search-input" placeholder="' + escapeHtml(_t('placeholder.attSearch')) + '" value="' + escapeHtml(p.search) + '">' +
            '<div class="bw-table-scroll"><table class="attachment-table bw-table bw-picker-table"><thead><tr>';
        p.columns.forEach(function (col) {
            const sorted = p.sort.key === col.key;
            html += '<th class="' + (sorted ? 'active-sort' : '') + '" data-col="' + escapeHtml(col.key) + '"' +
                (sorted ? ' aria-sort="' + (p.sort.asc ? 'ascending' : 'descending') + '"' : '') +
                (col.tip ? ' data-tooltip="' + escapeHtml(col.tip) + '"' : '') + '><button type="button" class="bw-sort-button">' + escapeHtml(col.label) +
                ' <span class="sort-indicator">' + (sorted ? (p.sort.asc ? ' &#9650;' : ' &#9660;') : '') + '</span></button></th>';
        });
        html += '</tr></thead><tbody>';
        // Rows the slot can't take next to the rest of the loadout, red like the builder's
        const conflicts = rows.map(function (row) { return p.conflictFor ? p.conflictFor(row) : null; });
        rows.forEach(function (row, index) {
            const isSelected = currentId && row.id === currentId;
            html += '<tr class="bw-picker-row' + (isSelected ? ' attachment-row-installed' : '') + (conflicts[index] ? ' conflict-row' : '') +
                '" tabindex="0" data-index="' + index + '">';
            p.columns.forEach(function (col, i) {
                html += i === 0 ? '<td>' + _nameCell(row) + '</td>' : '<td>' + col.render(row) + '</td>';
            });
            html += '</tr>';
        });
        html += '</tbody></table></div>';
        if (rows.length === 0) html += '<div class="ammo-no-results">' + escapeHtml(_t('ammo.noResults')) + '</div>';
        box.innerHTML = html;
        box.querySelector('.bw-table-scroll').scrollLeft = scrollLeft;

        _el('bw-picker-close').addEventListener('click', closePicker);
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
                const index = Number(/** @type {HTMLElement} */ (tr).dataset.index);
                const row = rows[index];
                if (conflicts[index]) {
                    if (p.onConflict) p.onConflict(row, conflicts[index]);
                    return;
                }
                if (row.id === p.currentId()) return;
                p.onPick(row);
                if (_picker === p) _renderPicker();
            });
            tr.addEventListener('contextmenu', function (event) {
                event.preventDefault();
                const row = rows[Number(/** @type {HTMLElement} */ (tr).dataset.index)];
                if (row.id !== p.currentId() || !p.onRemove) return;
                p.onRemove(row);
                if (_picker === p) _renderPicker();
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

    /* ===========================
       SLOT FLASHES
       The gun builder's sweeps on the tools' slots: green for an install, red for a
       removal, grey for slots an install revealed, and the double red pulse that points
       at the slot a conflicting pick runs into.
    =========================== */

    /** @param {HTMLElement} slot @param {'install'|'remove'|'reveal'} type */
    function flashSlot(slot, type) {
        const cls = 'slot-flash-' + type;
        slot.classList.remove('slot-flash-install', 'slot-flash-remove', 'slot-flash-reveal');
        void slot.offsetWidth;
        slot.classList.add(cls);
        slot.addEventListener('animationend', function () { slot.classList.remove(cls); }, { once: true });
    }

    /** @param {HTMLElement} slot */
    function flashConflict(slot) {
        slot.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        let count = 0;
        const pulse = function () {
            if (count >= 2 || !slot.isConnected) return;
            count++;
            slot.classList.remove('slot-flash-conflict');
            void slot.offsetWidth;
            slot.classList.add('slot-flash-conflict');
            slot.addEventListener('animationend', function () {
                slot.classList.remove('slot-flash-conflict');
                setTimeout(pulse, 30);
            }, { once: true });
        };
        // Wait for the scroll to land, as the builder does
        setTimeout(pulse, 220);
    }

    // The right panel's empty state: the builder's dashed placeholder with the slot art
    /** @param {{ art?: string, main: string, sub?: string }} options */
    function placeholderHtml(options) {
        return '<div class="attachment-placeholder bw-placeholder"><div class="placeholder-inner">' +
            (options.art ? '<img class="bw-placeholder-art" src="' + escapeHtml(options.art) + '" alt="">' : '') +
            '<strong><em>' + escapeHtml(options.main) + '</em></strong>' +
            (options.sub ? '<span class="placeholder-sub"><strong><em>' + escapeHtml(options.sub) + '</em></strong></span>' : '') +
            '</div></div>';
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
        const back = _el('bw-back-btn');
        if (back) back.textContent = '← ' + _t('workbench.back');
        const reset = _el('bw-reset-btn');
        if (reset) reset.textContent = '↺ ' + _t('workbench.reset');
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
        _el('bw-reset-btn').addEventListener('click', function () {
            if (_tool === 'armor') EFTForge.armorSim && EFTForge.armorSim.reset();
            else if (_tool === 'flight') EFTForge.ballisticsTools && EFTForge.ballisticsTools.resetFlight();
        });
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
        refreshPicker: refreshPicker,
        pickerKey: pickerKey,
        flashSlot: flashSlot,
        flashConflict: flashConflict,
        placeholderHtml: placeholderHtml,
        onLangChange: onLangChange,
    };

}());
