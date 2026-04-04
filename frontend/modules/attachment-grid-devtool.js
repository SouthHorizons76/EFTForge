/**
 * attachment-grid-devtool.js
 *
 * Visual drag-and-drop layout editor for the attachment grid.
 * LOCALHOST ONLY - exits immediately on any other hostname.
 *
 * Usage:
 *   1. Open the app on localhost.
 *   2. Click the "Grid Dev" button (bottom-right corner).
 *   3. Drag slot cells to the correct grid position.
 *      Right-click an overridden cell to clear its override.
 *   4. Click "Export" to copy the override map to clipboard,
 *      then paste into attachment-grid.js as _AG_OVERRIDES.
 *
 * Overrides are persisted in localStorage so they survive page reloads.
 * They are keyed by slot.id (e.g. "mod_charge_001") -> { col, vrow }.
 */
(function () {
    'use strict';

    // --- Production gate ---
    if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;

    // ============================================================
    // STATE
    // ============================================================

    let devModeActive = false;
    let draggingSlotId = null;

    // localOverrides: only what the user has added/changed on top of the hardcoded base.
    // This is what gets counted, exported, and saved to localStorage.
    /** @type {Record<string, {col: number, vrow: number, flexible?: boolean}>} */
    let localOverrides = {};
    try {
        localOverrides = JSON.parse(localStorage.getItem('ag_slot_overrides') || '{}');
    } catch (_) {}

    // overrides: merged set (hardcoded base + localOverrides) - used by the renderer.
    /** @type {Record<string, {col: number, vrow: number, flexible?: boolean}>} */
    let overrides = Object.assign({}, window._AG_OVERRIDES_BASE || {}, localOverrides);

    // Expose merged result to computeGridPositions in attachment-grid.js
    window._AG_OVERRIDES = overrides;

    // ============================================================
    // PERSISTENCE
    // ============================================================

    function _rebuildMerged() {
        overrides = Object.assign({}, window._AG_OVERRIDES_BASE || {}, localOverrides);
        window._AG_OVERRIDES = overrides;
    }

    function saveOverrides() {
        localStorage.setItem('ag_slot_overrides', JSON.stringify(localOverrides));
        _rebuildMerged();
    }

    function setOverride(slotId, col, vrow) {
        // Preserve flexible flag if this slot already has a local override
        const flexible = localOverrides[slotId]?.flexible || false;
        localOverrides[slotId] = { col, vrow, ...(flexible ? { flexible: true } : {}) };
        saveOverrides();
    }

    function toggleFlexible(slotId) {
        // Work on localOverrides; if the base has this entry, copy it first
        if (!localOverrides[slotId]) {
            const base = (window._AG_OVERRIDES_BASE || {})[slotId];
            if (!base) return;
            localOverrides[slotId] = Object.assign({}, base);
        }
        if (localOverrides[slotId].flexible) {
            delete localOverrides[slotId].flexible;
        } else {
            localOverrides[slotId].flexible = true;
        }
        saveOverrides();
    }

    function clearOverride(slotId) {
        delete localOverrides[slotId];
        saveOverrides();
    }

    function clearAllOverrides() {
        localOverrides = {};
        localStorage.removeItem('ag_slot_overrides');
        _rebuildMerged();
    }

    // ============================================================
    // RE-RENDER HELPER
    // ============================================================

    function rerender() {
        window.renderFullTree && window.renderFullTree(false);
    }

    // ============================================================
    // GHOST CELL INJECTION
    // ============================================================

    function applyDevMode() {
        const grid = document.querySelector('.attachment-grid');
        if (!grid) return;

        const rowMatch = grid.style.gridTemplateRows.match(/repeat\((\d+)/);
        if (!rowMatch) return;
        const totalRows = parseInt(rowMatch[1]);

        const gunCell = grid.querySelector('.ag-gun-cell');
        const gunRow  = gunCell ? parseInt(gunCell.style.gridRow) : 1;

        // Mark the grid so CSS can target dev-mode state
        grid.setAttribute('data-ag-dev', '1');

        // Build a set of already-occupied (col, row) positions
        const occupied = new Set();
        grid.querySelectorAll('.ag-cell').forEach(cell => {
            occupied.add(`${cell.style.gridColumn},${cell.style.gridRow}`);
        });
        // Gun cell occupies cols 7-9
        if (gunCell) {
            for (let c = 7; c <= 9; c++) {
                occupied.add(`${c},${gunRow}`);
            }
        }

        // Add ghost cells for every unoccupied position
        for (let col = 1; col <= 10; col++) {
            for (let row = 1; row <= totalRows; row++) {
                if (occupied.has(`${col},${row}`)) continue;
                const ghost = _makeGhostCell(col, row, gunRow);
                grid.appendChild(ghost);
            }
        }

        // Augment existing slot cells: draggable + ID label + override indicator
        grid.querySelectorAll('.ag-cell').forEach(cell => {
            _augmentSlotCell(cell, gunRow);
        });

        // Also augment extras cells - they live in .ag-extras outside the grid
        // but still need to be draggable so they can be repositioned into the grid.
        const wrapper   = grid.closest('.attachment-grid-wrapper');
        const extrasDiv = wrapper?.querySelector('.ag-extras');
        if (extrasDiv) {
            extrasDiv.setAttribute('data-ag-dev', '1');
            extrasDiv.querySelectorAll('.ag-cell').forEach(cell => {
                _augmentExtrasCell(cell);
            });
        }

        // Add expand-row strips above and below the grid so the user can
        // drag slots into a brand-new row beyond the current bounds.
        if (wrapper) {
            const topVrow    = 1 - gunRow;           // vrow of CSS row 1
            const bottomVrow = totalRows - gunRow;   // vrow of last CSS row
            wrapper.insertBefore(_makeExpandStrip(topVrow - 1, 'Add row above'), grid);
            const anchor = extrasDiv || null;
            if (anchor) {
                wrapper.insertBefore(_makeExpandStrip(bottomVrow + 1, 'Add row below'), anchor);
            } else {
                wrapper.appendChild(_makeExpandStrip(bottomVrow + 1, 'Add row below'));
            }
        }
    }

    function _makeGhostCell(col, row, gunRow) {
        const ghost = document.createElement('div');
        ghost.className = 'ag-dev-ghost';
        ghost.style.gridColumn = String(col);
        ghost.style.gridRow    = String(row);
        ghost.dataset.col      = String(col);
        ghost.dataset.vrow     = String(row - gunRow);

        ghost.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            ghost.classList.add('ag-dev-drag-over');
        });
        ghost.addEventListener('dragleave', () => {
            ghost.classList.remove('ag-dev-drag-over');
        });
        ghost.addEventListener('drop', e => {
            e.preventDefault();
            ghost.classList.remove('ag-dev-drag-over');
            if (!draggingSlotId) return;
            setOverride(draggingSlotId, parseInt(ghost.dataset.col), parseInt(ghost.dataset.vrow));
            draggingSlotId = null;
            rerender();
        });
        return ghost;
    }

    // Creates a full-width strip of 10 drop zones that represent a new row
    // at the given vrow (one above the current top or one below the current bottom).
    function _makeExpandStrip(vrow, label) {
        const strip = document.createElement('div');
        strip.className = 'ag-dev-expand-strip';
        strip.setAttribute('data-ag-dev', '1');

        const hdr = document.createElement('div');
        hdr.className = 'ag-dev-expand-label';
        hdr.textContent = `${label} (vrow ${vrow > 0 ? '+' : ''}${vrow})`;
        strip.appendChild(hdr);

        const cells = document.createElement('div');
        cells.className = 'ag-dev-expand-cells';
        for (let col = 1; col <= 10; col++) {
            const cell = document.createElement('div');
            cell.className = 'ag-dev-expand-cell';
            cell.textContent = col;
            cell.addEventListener('dragover', e => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                cell.classList.add('ag-dev-drag-over');
            });
            cell.addEventListener('dragleave', () => {
                cell.classList.remove('ag-dev-drag-over');
            });
            cell.addEventListener('drop', e => {
                e.preventDefault();
                cell.classList.remove('ag-dev-drag-over');
                if (!draggingSlotId) return;
                setOverride(draggingSlotId, col, vrow);
                draggingSlotId = null;
                rerender();
            });
            cells.appendChild(cell);
        }
        strip.appendChild(cells);
        return strip;
    }

    function _augmentSlotCell(cell, gunRow) {
        // overrideKey is the unique composite key set by _buildGridDOM in attachment-grid.js.
        // It is slot.id @ parentNode.item.id [# instanceIndex] and is unique even when
        // two identical items expose slots with the same slot.id.
        const overrideKey = cell.dataset.overrideKey;
        if (!overrideKey) return;

        const col  = parseInt(cell.style.gridColumn) || 0;
        const row  = parseInt(cell.style.gridRow) || 0;
        const vrow = row - gunRow;

        // Draggable
        cell.setAttribute('draggable', 'true');
        cell.addEventListener('dragstart', e => {
            draggingSlotId = overrideKey;
            e.dataTransfer.effectAllowed = 'move';
        });
        cell.addEventListener('dragend', () => { draggingSlotId = null; });

        // Accept drops from other slots
        cell.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            cell.classList.add('ag-dev-drag-over');
        });
        cell.addEventListener('dragleave', () => {
            cell.classList.remove('ag-dev-drag-over');
        });
        cell.addEventListener('drop', e => {
            e.preventDefault();
            cell.classList.remove('ag-dev-drag-over');
            if (!draggingSlotId || draggingSlotId === overrideKey) return;
            setOverride(draggingSlotId, col, vrow);
            draggingSlotId = null;
            rerender();
        });

        // Right-click to clear local override (only affects localOverrides, not base)
        cell.addEventListener('contextmenu', e => {
            e.preventDefault();
            e.stopPropagation();
            if (localOverrides[overrideKey]) {
                clearOverride(overrideKey);
                rerender();
            }
        });

        // Show overrideKey (cyan strip) + position badge
        const idLabel = document.createElement('div');
        idLabel.className = 'ag-dev-id-label';
        idLabel.textContent = overrideKey;
        cell.appendChild(idLabel);

        const posBadge = document.createElement('div');
        posBadge.className = 'ag-dev-pos-badge';
        posBadge.textContent = `${col},${vrow > 0 ? '+' : ''}${vrow}`;
        cell.appendChild(posBadge);

        // Green outline only for locally-added overrides; base overrides get no highlight.
        if (localOverrides[overrideKey]) {
            const ov = localOverrides[overrideKey];
            cell.classList.add('ag-dev-overridden');
            if (ov.flexible) cell.classList.add('ag-dev-flexible');

            // Flexible toggle button ("~" = flexible, "•" = fixed)
            const flexBtn = document.createElement('div');
            flexBtn.className = 'ag-dev-flex-btn';
            flexBtn.title = ov.flexible
                ? 'Flexible: yields to auto-placed slots, scans down when pushed. Click to fix.'
                : 'Fixed: holds position, auto-placed slots route around it. Click to make flexible.';
            flexBtn.textContent = ov.flexible ? '~' : '•';
            flexBtn.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                toggleFlexible(overrideKey);
                rerender();
            });
            cell.appendChild(flexBtn);
        }
    }

    function _augmentExtrasCell(cell) {
        const overrideKey = cell.dataset.overrideKey;
        if (!overrideKey) return;

        cell.setAttribute('draggable', 'true');
        cell.addEventListener('dragstart', e => {
            draggingSlotId = overrideKey;
            e.dataTransfer.effectAllowed = 'move';
        });
        cell.addEventListener('dragend', () => { draggingSlotId = null; });

        // Right-click clears local override if one exists
        cell.addEventListener('contextmenu', e => {
            e.preventDefault();
            e.stopPropagation();
            if (localOverrides[overrideKey]) { clearOverride(overrideKey); rerender(); }
        });

        const idLabel = document.createElement('div');
        idLabel.className = 'ag-dev-id-label';
        idLabel.textContent = overrideKey;
        cell.appendChild(idLabel);

        const posBadge = document.createElement('div');
        posBadge.className = 'ag-dev-pos-badge';
        posBadge.textContent = 'extras';
        cell.appendChild(posBadge);

        if (localOverrides[overrideKey]) cell.classList.add('ag-dev-overridden');
    }

    // ============================================================
    // EXPORT
    // ============================================================

    function exportOverrides() {
        const entries = Object.entries(localOverrides)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, pos]) => {
                const parts = [`col: ${pos.col}`, `vrow: ${pos.vrow}`];
                if (pos.flexible) parts.push('flexible: true');
                return `    "${id}": { ${parts.join(', ')} }`;
            })
            .join(',\n');
        const text = `// ${Object.keys(localOverrides).length} new override(s)\n{\n${entries}\n}`;
        navigator.clipboard.writeText(text).then(() => {
            _showToast(`${Object.keys(localOverrides).length} new override(s) copied.`);
        }).catch(() => {
            prompt('Copy this:', text);
        });
    }

    // ============================================================
    // DEV TOOLBAR UI
    // ============================================================

    function toggleDevMode() {
        devModeActive = !devModeActive;
        _updateToolbar();
        rerender();
    }

    function _updateToolbar() {
        const btn      = document.getElementById('ag-dev-toggle');
        const controls = document.getElementById('ag-dev-controls');
        const status   = document.getElementById('ag-dev-status');
        if (!btn) return;
        btn.textContent = devModeActive ? '[ON] Grid Dev' : '[OFF] Grid Dev';
        btn.style.color = devModeActive ? '#0f0' : '#aaa';
        controls.style.display = devModeActive ? 'flex' : 'none';
        if (status) {
            const n = Object.keys(localOverrides).length;
            status.textContent = n > 0 ? `${n} new override${n > 1 ? 's' : ''}` : '';
        }
    }

    function _injectToolbar() {
        if (document.getElementById('ag-dev-toolbar')) return;

        const bar = document.createElement('div');
        bar.id = 'ag-dev-toolbar';
        bar.innerHTML = `
            <button id="ag-dev-toggle">[OFF] Grid Dev</button>
            <span id="ag-dev-controls" style="display:none">
                <button id="ag-dev-export">Export</button>
                <button id="ag-dev-clear-all">Clear All</button>
                <span id="ag-dev-status"></span>
            </span>
        `;
        document.body.appendChild(bar);

        document.getElementById('ag-dev-toggle').onclick    = toggleDevMode;
        document.getElementById('ag-dev-export').onclick    = exportOverrides;
        document.getElementById('ag-dev-clear-all').onclick = () => {
            if (confirm('Clear ALL slot position overrides?')) {
                clearAllOverrides();
                rerender();
            }
        };

        _updateToolbar();
    }

    // ============================================================
    // TOAST
    // ============================================================

    function _showToast(msg) {
        const t = document.createElement('div');
        t.className = 'ag-dev-toast';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2500);
    }

    // ============================================================
    // CSS
    // ============================================================

    function _injectCSS() {
        const style = document.createElement('style');
        style.textContent = `
            #ag-dev-toolbar {
                position: fixed;
                bottom: 10px;
                right: 10px;
                z-index: 9999;
                display: flex;
                align-items: center;
                gap: 6px;
                background: #111;
                border: 1px solid #555;
                border-radius: 6px;
                padding: 5px 10px;
                font-size: 12px;
                font-family: monospace;
            }
            #ag-dev-toolbar button {
                cursor: pointer;
                background: #222;
                color: #ccc;
                border: 1px solid #555;
                border-radius: 3px;
                padding: 2px 8px;
                font-size: 11px;
                font-family: monospace;
            }
            #ag-dev-toolbar button:hover { background: #333; }
            #ag-dev-controls { display: flex; align-items: center; gap: 6px; }
            #ag-dev-status { color: #888; font-size: 10px; }

            /* Expand-row strips (above / below the grid) */
            .ag-dev-expand-strip {
                margin: 2px 0;
                opacity: 0.45;
                transition: opacity 0.15s;
            }
            .ag-dev-expand-strip:hover,
            .ag-dev-expand-strip:has(.ag-dev-drag-over) {
                opacity: 1;
            }
            .ag-dev-expand-label {
                font-size: 9px;
                font-family: monospace;
                color: #666;
                padding: 1px 3px;
                letter-spacing: 0.02em;
            }
            .ag-dev-expand-cells {
                display: grid;
                grid-template-columns: repeat(10, 48px);
            }
            .ag-dev-expand-cell {
                box-sizing: border-box;
                height: 22px;
                border: 1px dashed #3a3a3a;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 8px;
                color: #555;
                cursor: crosshair;
            }
            .ag-dev-expand-cell.ag-dev-drag-over {
                background: rgba(255, 220, 0, 0.25);
                border-color: #ff0;
                color: #ff0;
            }

            /* Ghost drop-zone cells */
            .ag-dev-ghost {
                box-sizing: border-box;
                border: 1px dashed #333;
                pointer-events: all;
                cursor: crosshair;
                min-height: 58px;
            }
            .ag-dev-ghost.ag-dev-drag-over {
                background: rgba(255, 255, 0, 0.18);
                border: 1px solid #ff0;
            }

            /* Slot cell augmentation in dev mode (grid + extras) */
            [data-ag-dev] .ag-cell {
                cursor: grab;
                position: relative;
            }
            [data-ag-dev] .ag-cell.ag-dev-drag-over {
                outline: 2px solid #ff0;
            }
            [data-ag-dev] .ag-cell.ag-dev-overridden {
                outline: 2px solid #0f0;
            }
            [data-ag-dev] .ag-cell.ag-dev-flexible {
                outline: 2px solid #fa0;
            }
            .ag-dev-flex-btn {
                position: absolute;
                bottom: 1px;
                left: 1px;
                background: rgba(0, 0, 0, 0.78);
                color: #fa0;
                font-size: 9px;
                font-family: monospace;
                padding: 0 3px;
                cursor: pointer;
                z-index: 21;
                line-height: 1.5;
                border-radius: 2px;
            }
            .ag-dev-flex-btn:hover { background: rgba(255, 170, 0, 0.25); }

            /* Slot ID overlay (top strip) */
            .ag-dev-id-label {
                position: absolute;
                top: 0; left: 0; right: 0;
                background: rgba(0, 0, 0, 0.88);
                color: #0ff;
                font-size: 6.5px;
                font-family: monospace;
                padding: 1px 2px;
                pointer-events: none;
                z-index: 20;
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
                line-height: 1.3;
            }
            /* (col, vrow) badge (bottom-right) */
            .ag-dev-pos-badge {
                position: absolute;
                bottom: 11px;
                right: 1px;
                background: rgba(0, 0, 0, 0.75);
                color: #fa0;
                font-size: 6px;
                font-family: monospace;
                padding: 0 2px;
                pointer-events: none;
                z-index: 20;
                line-height: 1.4;
            }

            /* Toast */
            .ag-dev-toast {
                position: fixed;
                bottom: 60px;
                right: 14px;
                background: #0a0a0a;
                color: #0f0;
                border: 1px solid #0f0;
                border-radius: 4px;
                padding: 6px 12px;
                font-size: 12px;
                font-family: monospace;
                z-index: 99999;
                pointer-events: none;
                animation: ag-dev-fadein 0.15s ease;
            }
            @keyframes ag-dev-fadein { from { opacity: 0; } to { opacity: 1; } }
        `;
        document.head.appendChild(style);
    }

    // ============================================================
    // WRAP renderFullTree
    // ============================================================

    // Wait until attachment-grid.js has set window.renderFullTree, then wrap it.
    function _wrapRenderFullTree() {
        const original = window.renderFullTree;
        window.renderFullTree = async function (...args) {
            await original(...args);
            if (devModeActive) applyDevMode();
            _updateToolbar(); // keep override count badge current
        };
    }

    // ============================================================
    // INIT
    // ============================================================

    function init() {
        _injectCSS();
        _injectToolbar();
        _wrapRenderFullTree();
        console.log(
            '[AG DevTool] Active on localhost. ' +
            `${Object.keys(window._AG_OVERRIDES_BASE || {}).length} base override(s) + ` +
            `${Object.keys(localOverrides).length} local override(s). ` +
            'Click "Grid Dev" to start.'
        );
    }

    // Public API for the dev modal
    window._agDevTool = {
        toggle:   toggleDevMode,
        isActive: () => devModeActive,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
