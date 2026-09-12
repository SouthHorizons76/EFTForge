/* Prepare temporary capture compositions without changing build state. */
(function () {
    if (!['localhost', '127.0.0.1'].includes(location.hostname) && !window.__EFTFORGE_DESKTOP__) return;

    let mode = 'idle';
    let selected = null;
    let hovered = null;
    let toolbar, hoverBox, selectedBox, summary, textPicker, textInput, editor;
    let textNodes = [];
    let frame = null;
    const past = [];
    const future = [];
    const buttons = {};
    const excluded = '[data-capture-chrome], #dev-modal-overlay, #eft-tooltip, #tab-preview-tooltip';

    function eligible(el) {
        return el instanceof Element && el !== document.body && el !== document.documentElement
            && !el.closest(excluded) && !el.matches('script, style, link, meta');
    }

    function typing(target) {
        return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
    }

    function getStatus() {
        return {
            mode,
            changes: past.filter(action => action.node.isConnected).length,
            canUndo: past.some(action => action.node.isConnected),
            canRedo: future.some(action => action.node.isConnected),
        };
    }

    function notify() {
        document.dispatchEvent(new CustomEvent('eftforge:capture-status', { detail: getStatus() }));
        update();
    }

    function apply(action, value) {
        if (!action.node.isConnected) return;
        if (action.property === 'text') action.node.nodeValue = value;
        else if (value.value) action.node.style.setProperty(action.property, value.value, value.priority);
        else action.node.style.removeProperty(action.property);
    }

    function commit(action) {
        apply(action, action.after);
        past.push(action);
        future.length = 0;
        notify();
    }

    function travel(from, to, key) {
        editor.hidden = true;
        while (from.length) {
            const action = from.pop();
            if (!action.node.isConnected) continue;
            apply(action, action[key]);
            to.push(action);
            break;
        }
        notify();
    }

    function restoreAll() {
        while (past.length) {
            const action = past.pop();
            apply(action, action.before);
        }
        future.length = 0;
        if (editor) editor.hidden = true;
        notify();
    }

    function hide(collapse = false) {
        if (!selected?.isConnected) return;
        const property = collapse ? 'display' : 'visibility';
        commit({
            node: selected, property,
            before: { value: selected.style.getPropertyValue(property), priority: selected.style.getPropertyPriority(property) },
            after: { value: collapse ? 'none' : 'hidden', priority: 'important' },
        });
        selected = hovered = null;
        editor.hidden = true;
        update();
    }

    function editText() {
        if (!selected?.isConnected) return;
        textNodes = [];
        const walker = document.createTreeWalker(selected, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const node = walker.currentNode;
            if (node.nodeValue.trim() && !node.parentElement.closest('script, style, textarea, [data-capture-chrome]')) textNodes.push(node);
        }
        textPicker.replaceChildren();
        textNodes.forEach((node, i) => {
            const option = document.createElement('option');
            option.value = i;
            option.textContent = node.nodeValue.trim().slice(0, 100);
            textPicker.append(option);
        });
        editor.hidden = false;
        textInput.disabled = !textNodes.length;
        textInput.value = textNodes[0]?.nodeValue || '';
        buttons.save.disabled = !textNodes.length;
        textInput.focus();
    }

    function selectParent() {
        if (eligible(selected?.parentElement)) {
            selected = selected.parentElement;
            editor.hidden = true;
            update();
        }
    }

    function rectangle(box, el) {
        const rect = el?.isConnected ? el.getBoundingClientRect() : null;
        box.hidden = mode !== 'editing' || !rect || !rect.width || !rect.height;
        if (!box.hidden) Object.assign(box.style, {
            left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
        });
    }

    function update() {
        if (!toolbar) return;
        if (!selected?.isConnected) selected = null;
        toolbar.hidden = mode !== 'editing';
        rectangle(hoverBox, hovered);
        rectangle(selectedBox, selected);
        const status = getStatus();
        summary.textContent = selected
            ? `${selected.tagName.toLowerCase()}${selected.id ? '#' + selected.id : ''}${Array.from(selected.classList).map(c => '.' + c).join('')} ${selected.textContent.trim().replace(/\s+/g, ' ').slice(0, 80)}`
            : `Click an element to select it. ${status.changes} active edit(s).`;
        for (const key of ['hide', 'collapse', 'text']) buttons[key].disabled = !selected;
        buttons.parent.disabled = !eligible(selected?.parentElement);
        buttons.undo.disabled = !status.canUndo;
        buttons.redo.disabled = !status.canRedo;
        buttons.restore.disabled = !past.length;
    }

    function tick() {
        update();
        frame = mode === 'editing' ? requestAnimationFrame(tick) : null;
    }

    function setMode(next) {
        mode = next;
        hovered = selected = null;
        if (editor) editor.hidden = true;
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        if (mode === 'editing') {
            EFTForge.tooltip?.hide();
            frame = requestAnimationFrame(tick);
        }
        notify();
    }

    function ensureChrome() {
        if (toolbar) return;
        toolbar = document.createElement('section');
        toolbar.className = 'capture-toolbar';
        toolbar.dataset.captureChrome = '';
        toolbar.setAttribute('aria-label', 'Screenshot Mode');
        const title = document.createElement('strong');
        title.textContent = 'SCREENSHOT MODE';
        summary = document.createElement('div');
        summary.className = 'capture-summary';
        const controls = document.createElement('div');
        controls.className = 'capture-controls';
        function button(key, label, action, parent = controls) {
            const el = document.createElement('button');
            el.type = 'button';
            el.textContent = label;
            el.addEventListener('click', action);
            buttons[key] = el;
            parent.append(el);
        }
        button('hide', 'Hide', () => hide());
        button('collapse', 'Collapse', () => hide(true));
        button('text', 'Edit Text', editText);
        button('parent', 'Select Parent', selectParent);
        button('undo', 'Undo', () => travel(past, future, 'before'));
        button('redo', 'Redo', () => travel(future, past, 'after'));
        button('preview', 'Preview', preview);
        button('restore', 'Restore All', restoreAll);
        button('exit', 'Exit', () => setMode('paused'));
        editor = document.createElement('div');
        editor.className = 'capture-text-editor';
        editor.hidden = true;
        textPicker = document.createElement('select');
        textPicker.setAttribute('aria-label', 'Text node to edit');
        textInput = document.createElement('textarea');
        textInput.setAttribute('aria-label', 'Replacement text');
        textPicker.addEventListener('change', () => { textInput.value = textNodes[Number(textPicker.value)]?.nodeValue || ''; });
        editor.append(textPicker, textInput);
        button('save', 'Apply Text', () => {
            const node = textNodes[Number(textPicker.value)];
            if (node?.isConnected && node.nodeValue !== textInput.value) {
                commit({ node, property: 'text', before: node.nodeValue, after: textInput.value });
            }
            editor.hidden = true;
        }, editor);
        button('cancel', 'Cancel', () => { editor.hidden = true; }, editor);
        const hint = document.createElement('small');
        hint.textContent = 'Delete: hide · Shift+Delete: collapse · Ctrl+Z/Y: undo/redo · Ctrl+Shift+S: preview/edit · Esc: deselect/pause. Exit keeps edits; Restore All removes them. Refresh resets everything.';
        toolbar.append(title, summary, controls, editor, hint);
        hoverBox = document.createElement('div');
        hoverBox.className = 'capture-outline';
        selectedBox = document.createElement('div');
        selectedBox.className = 'capture-outline capture-outline-selected';
        for (const el of [hoverBox, selectedBox]) {
            el.dataset.captureChrome = '';
            el.setAttribute('aria-hidden', 'true');
        }
        document.body.append(toolbar, hoverBox, selectedBox);
    }

    function start() {
        ensureChrome();
        document.getElementById('dev-modal-overlay')?.remove();
        setMode('editing');
    }

    function preview() {
        if (mode !== 'idle') setMode('preview');
    }

    // Capture pointer actions before application handlers can change the build.
    window.addEventListener('pointermove', e => {
        if (mode !== 'editing') return;
        hovered = eligible(e.target) ? e.target : null;
    }, true);
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
        window.addEventListener(type, e => {
            if (mode !== 'editing' || e.target.closest?.(excluded)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (type === 'click') {
                selected = eligible(e.target) ? e.target : null;
                editor.hidden = true;
                update();
            }
        }, true);
    }
    window.addEventListener('keydown', e => {
        if (mode === 'idle' || typing(e.target)) return;
        const key = e.key.toLowerCase();
        const modifier = e.ctrlKey || e.metaKey;
        let action;
        if (modifier && e.shiftKey && key === 's') action = () => mode === 'editing' ? preview() : start();
        else if (key === 'escape' && mode === 'preview') action = start;
        else if (mode === 'editing') {
            if (key === 'escape') action = () => {
                if (selected) { selected = null; editor.hidden = true; update(); }
                else setMode('paused');
            };
            else if (key === 'delete') action = () => hide(e.shiftKey);
            else if (modifier && key === 'z') action = () => e.shiftKey ? travel(future, past, 'after') : travel(past, future, 'before');
            else if (modifier && key === 'y') action = () => travel(future, past, 'after');
        }
        if (action) {
            e.preventDefault();
            e.stopImmediatePropagation();
            action();
        }
    }, true);

    window.EFTForge._dev = window.EFTForge._dev || {};
    EFTForge._dev.screenshotMode = { start, resume: start, preview, restoreAll, getStatus };
})();
