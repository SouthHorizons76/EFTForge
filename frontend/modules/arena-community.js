window.EFTForge = window.EFTForge || {};

/* ============================================================
   ARENA PRESETS: SAVE, SHARE AND THE COMMUNITY
   The loadout page's Save / Share and Explore Presets buttons, Arena's take on the
   builder's Save / Share and Explore Builds (build-manager.js):

   - Save / Share saves the class loadout on show under a name (kept in localStorage per
     class), copies it as a share code or a ?arena= link, and lists the class's saved
     presets, each of which can be published from there, as saved builds are.
   - Explore Presets lists the class's saved presets (load, copy, publish, delete, and
     import a code) over the community's presets for the class: liked, commented on and
     loaded like community builds, their cards showing the loadout's board where a gun
     build's show its stats.

   A loaded preset opens in a tab of its own on desktop (tab-manager.js) and becomes the
   class's loadout on mobile. Published presets are community builds on the server
   (routers/arena_presets.py), so likes, comments, load counts and unlisting reuse the
   calls and helpers community-builds.js has for gun builds.
============================================================ */

window.EFTForge.arenaCommunity = (function () {

    const SAVED_KEY = 'eftforge_arena_presets';
    const MAX_SAVED = 500;
    const SAVE_DIALOG = 'arena-save-dialog';
    const EXPLORE_DIALOG = 'arena-explore-dialog';
    const PUBLISH_DIALOG = 'arena-publish-dialog';
    // A share code: this, then the LZString of {c: class id, l: loadout}
    const CODE_PREFIX = 'A1';
    // A ?arena= code waiting for the reload into Arena mode
    const PENDING_KEY = 'eftforge_pending_arena_preset';
    const _countCache = {};   // class id -> how many community presets it has, once fetched
    let _presets = [];        // the Explore dialog's community presets
    let _shown = [];          // those its search and sort leave, in order
    let _classId = null;      // the open dialog's class

    function _t(key) { return EFTForge.lang.t(key); }
    function _loadout() { return EFTForge.arenaLoadout; }
    function _mobile() { return document.body.dataset.mobile === 'true'; }
    function _off() { return !!EFTForge.config.COMMUNITY_DISABLED; }

    /** The class the loadout page is on. */
    function _currentClass() {
        const cur = _loadout() && _loadout().current();
        return cur ? cur.classId : EFTForge.arena.classId();
    }

    function _classTitleHtml(classId) {
        const icon = _loadout().classIconUrl(classId);
        return (icon ? '<img class="arena-cb-class-icon" src="' + escapeHtml(icon) + '" alt="">' : '') +
            '<span class="arena-cb-class">' + escapeHtml(_loadout().className(classId)) + '</span>';
    }

    /* ===========================
       SAVED PRESETS (localStorage)
       [{id, name, classId, savedAt, loadout, publishedId?}], newest first
    =========================== */

    function _saved() {
        try {
            const raw = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
            return Array.isArray(raw) ? raw.filter(function (p) { return p && p.id && p.classId; }) : [];
        } catch {
            return [];
        }
    }

    function _persist(list) {
        try {
            localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, MAX_SAVED)));
        } catch (e) {
            if (e && e.name === 'QuotaExceededError') showToast(_t('toast.storageFull'), _t('toast.storageFullMsg'), 4000);
        }
        syncButtons();
    }

    function _savedFor(classId) {
        return _saved().filter(function (p) { return p.classId === classId; });
    }

    /* ===========================
       SHARE CODES
    =========================== */

    function encodeCode(classId, loadout) {
        return CODE_PREFIX + LZString.compressToEncodedURIComponent(JSON.stringify({ c: classId, l: _loadout().copyLoadout(loadout) }));
    }

    /** {classId, loadout} from a code or a link holding one, or null. */
    function decodeCode(text) {
        let code = String(text || '').trim();
        const inLink = code.match(/[?&]arena=([^&#\s]+)/);
        if (inLink) code = decodeURIComponent(inLink[1]);
        if (code.indexOf(CODE_PREFIX) !== 0) return null;
        try {
            const data = JSON.parse(LZString.decompressFromEncodedURIComponent(code.slice(CODE_PREFIX.length)) || 'null');
            if (!data || typeof data.c !== 'string' || !data.l || typeof data.l !== 'object') return null;
            return { classId: data.c, loadout: _loadout().copyLoadout(data.l) };
        } catch {
            return null;
        }
    }

    // The desktop app's own origin is localhost, so its links point at the live site
    function _shareLink(code) {
        const base = EFTForge.config.IS_DESKTOP ? 'https://eftforge.com/' : window.location.origin + window.location.pathname;
        return base + '?arena=' + encodeURIComponent(code);
    }

    async function _copy(text, messageKey) {
        try {
            await navigator.clipboard.writeText(text);
            showToast(_t('modal.copied'), _t(messageKey), 2000, '#4CAF50');
            return true;
        } catch {
            showToast(_t('toast.copyFailed'), _t('toast.clipboardFailed'), 3000);
            return false;
        }
    }

    /** Open a preset from a code or link. */
    async function importCode(text) {
        const preset = decodeCode(text);
        if (!preset) {
            showToast(_t('toast.importFailed'), _t('arena.cb.badCode'), 3500);
            return false;
        }
        if (!EFTForge.arena.classes().some(function (c) { return c.id === preset.classId; })) {
            showToast(_t('toast.importFailed'), _t('arena.cb.unknownClass'), 3500);
            return false;
        }
        await _open(preset.classId, preset.loadout, null);
        return true;
    }

    /**
     * A ?arena= link. The link leaves the address bar straight away; a page in the main game
     * hands the code to the Arena page it reloads into (sessionStorage), which opens it once
     * Arena's classes are here.
     */
    async function checkUrlParam() {
        const params = new URLSearchParams(window.location.search);
        let code = params.get('arena');
        if (code) {
            params.delete('arena');
            const rest = params.toString();
            history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : '') + window.location.hash);
        } else {
            try { code = sessionStorage.getItem(PENDING_KEY); } catch { code = null; }
        }
        try { sessionStorage.removeItem(PENDING_KEY); } catch { /* private mode */ }
        if (!code) return;
        const arena = EFTForge.arena;
        if (!arena.isActive()) {
            if (!arena.isAvailable()) {
                showToast(_t('toast.importFailed'), _t('arena.cb.noArena'), 3500);
                return;
            }
            try { sessionStorage.setItem(PENDING_KEY, code); } catch { /* private mode: the code is lost */ }
            arena.setMode(true);
            return;
        }
        try {
            await arena.loadConfig();
        } catch {
            showToast(_t('toast.importFailed'), _t('arena.loadFailed'), 3500);
            return;
        }
        await importCode(code);
    }

    // A preset into a tab of its own (desktop) or its class's loadout (mobile)
    async function _open(classId, loadout, name) {
        if (!_mobile() && EFTForge.tabs && EFTForge.tabs.openArenaPreset) {
            await EFTForge.tabs.openArenaPreset(classId, loadout, name);
        } else {
            _loadout().replaceLoadout(classId, loadout);
        }
    }

    /* ===========================
       THE LOADOUT PAGE'S BUTTONS
    =========================== */

    /** The Explore Presets button's count: the class's saved presets and community presets. */
    async function syncButtons() {
        const btn = document.getElementById('arena-presets-btn');
        const classId = _currentClass();
        if (!btn || !classId) return;
        const apply = function () {
            const n = _savedFor(classId).length + (_countCache[classId] || 0);
            btn.dataset.badge = n > 0 ? String(n) : '';
        };
        apply();
        if (_off() || _countCache[classId] !== undefined) return;
        _countCache[classId] = 0;
        try {
            const presets = await EFTForge.api.fetchArenaPresets(classId);
            _countCache[classId] = Array.isArray(presets) ? presets.length : 0;
        } catch {
            delete _countCache[classId];
        }
        if (_currentClass() === classId) apply();
    }

    function _wireButtons() {
        document.getElementById('arena-save-btn')?.addEventListener('click', function () { showSaveDialog(); });
        document.getElementById('arena-presets-btn')?.addEventListener('click', function () { showExploreDialog(); });
        _updateStaticText();
    }

    function _updateStaticText() {
        const save = document.getElementById('arena-save-btn');
        if (save) save.textContent = _t(_mobile() ? 'btn.saveShareShort' : 'btn.saveShare');
        const explore = document.getElementById('arena-presets-btn');
        if (explore) explore.textContent = _t(_mobile() ? 'btn.gunBuildsShort' : 'arena.cb.explore');
    }

    /* ===========================
       SAVE / SHARE
    =========================== */

    function showSaveDialog() {
        const cur = _loadout() && _loadout().current();
        if (!cur || !cur.classId) return;
        const overlay = _createModalOverlay(SAVE_DIALOG, escapeHtml(_t('modal.saveAndShare')), { maxWidth: '560px' });
        if (!overlay) return;
        const tab = cur.tabId ? (EFTForge.state.tabs || []).find(function (t) { return t.id === cur.tabId; }) : null;
        _renderSaveBody(cur, (tab && tab.name) || _loadout().className(cur.classId));
    }

    function _renderSaveBody(cur, prefill) {
        const body = document.getElementById(SAVE_DIALOG + '-body');
        if (!body) return;
        body.innerHTML =
            '<div class="modal-section">' +
            '<div class="modal-label">' + escapeHtml(_t('arena.cb.save')) + '</div>' +
            '<div class="modal-row">' +
            '<input id="arena-save-name" type="text" class="search-input arena-save-name" maxlength="60" placeholder="' + escapeHtml(_t('arena.cb.namePlaceholder')) + '" value="' + escapeHtml(prefill) + '" />' +
            '<button class="modal-btn primary" id="arena-save-confirm">' + escapeHtml(_t('modal.saveBtn')) + '</button>' +
            '</div></div>' +
            '<hr class="modal-divider" />' +
            '<div class="modal-section">' +
            '<div class="modal-label">' + escapeHtml(_t('arena.cb.share')) + '</div>' +
            '<div class="modal-row">' +
            '<button class="modal-btn full-width" id="arena-copy-code">' + escapeHtml(_t('modal.copyBtn')) + '</button>' +
            '<button class="modal-btn full-width" id="arena-copy-link">' + escapeHtml(_t('modal.copyLinkBtn')) + '</button>' +
            '</div></div>' +
            '<hr class="modal-divider" />' +
            '<div class="modal-section">' +
            '<div class="modal-label">' + escapeHtml(_t('arena.cb.import')) + '</div>' +
            '<div class="modal-row arena-import-row">' +
            '<input id="arena-import-code" type="text" class="search-input" placeholder="' + escapeHtml(_t('arena.cb.pasteCode')) + '" />' +
            '<button class="modal-btn" id="arena-import-paste">' + escapeHtml(_t('modal.pasteBtn')) + '</button>' +
            '<button class="modal-btn primary" id="arena-import-btn">' + escapeHtml(_t('modal.importBtn')) + '</button>' +
            '</div></div>' +
            '<hr class="modal-divider" />' +
            '<div class="modal-section">' +
            '<div class="modal-label arena-cb-title">' + escapeHtml(_t('arena.cb.myPresets')) + ' ' + _classTitleHtml(cur.classId) + '</div>' +
            (_off() ? '' : '<div class="arena-cb-hint">' + escapeHtml(_t(_mobile() ? 'modal.publishHintMobile' : 'arena.cb.publishHint')) + '</div>') +
            '<div id="arena-save-list" class="arena-saved-list arena-saved-list-short"></div>' +
            '</div>';

        const input = /** @type {HTMLInputElement} */ (document.getElementById('arena-save-name'));
        input.focus();
        input.select();
        const save = function () { _save(cur, input.value, false); };
        document.getElementById('arena-save-confirm').addEventListener('click', save);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); save(); } });
        const wireCopy = function (id, labelKey, text, messageKey) {
            const btn = document.getElementById(id);
            btn.addEventListener('click', async function () {
                if (!(await _copy(text(), messageKey))) return;
                btn.textContent = _t('modal.copied');
                setTimeout(function () { btn.textContent = _t(labelKey); }, 2000);
            });
        };
        wireCopy('arena-copy-code', 'modal.copyBtn', function () { return encodeCode(cur.classId, cur.loadout); }, 'arena.cb.codeCopied');
        wireCopy('arena-copy-link', 'modal.copyLinkBtn', function () { return _shareLink(encodeCode(cur.classId, cur.loadout)); }, 'toast.linkCopiedMsg');
        _wireImport(SAVE_DIALOG);
        _renderSavedList('arena-save-list', cur.classId, '', false);
    }

    // The Save / Share dialog's import field: a code or link opens, and the dialog closes
    function _wireImport(dialogId) {
        const input = /** @type {HTMLInputElement} */ (document.getElementById('arena-import-code'));
        const run = async function () {
            if (await importCode(input.value)) document.getElementById(dialogId)?.remove();
        };
        document.getElementById('arena-import-btn').addEventListener('click', run);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
        document.getElementById('arena-import-paste').addEventListener('click', async function () {
            try { input.value = await navigator.clipboard.readText(); } catch { /* the clipboard is off limits */ }
        });
    }

    function _save(cur, rawName, overwrite) {
        const name = String(rawName || '').trim().slice(0, 60);
        if (!name) {
            showToast(_t('toast.saveFailed'), _t('arena.cb.nameNeeded'), 2500);
            return;
        }
        if (_loadout().isEmptyLoadout(cur.loadout)) {
            showToast(_t('toast.saveFailed'), _t('arena.cb.emptyLoadout'), 3000);
            return;
        }
        const list = _saved();
        const same = list.find(function (p) { return p.classId === cur.classId && p.name.toLowerCase() === name.toLowerCase(); });
        if (same && !overwrite) {
            _renderOverwrite(cur, name);
            return;
        }
        const loadout = _loadout().copyLoadout(cur.loadout);
        if (same) {
            same.loadout = loadout;
            same.savedAt = Date.now();
        } else {
            list.unshift({ id: Date.now().toString(36), name: name, classId: cur.classId, savedAt: Date.now(), loadout: loadout });
        }
        _persist(list);
        // The tab is named after what it was saved as, until it changes
        if (cur.tabId && EFTForge.tabs && EFTForge.tabs.nameArenaTab) EFTForge.tabs.nameArenaTab(cur.tabId, name);
        document.getElementById(SAVE_DIALOG)?.remove();
        showToast(_t('arena.cb.savedTitle'), '"' + name + '" ' + _t('arena.cb.savedMsg'), 2500, '#4CAF50');
    }

    function _renderOverwrite(cur, name) {
        const body = document.getElementById(SAVE_DIALOG + '-body');
        if (!body) return;
        body.innerHTML = '<div class="modal-section">' +
            '<div class="arena-overwrite"><strong>"' + escapeHtml(name) + '"</strong> <span>' + escapeHtml(_t('arena.cb.alreadyExists')) + '</span><br>' +
            '<span class="arena-overwrite-sub">' + escapeHtml(_t('arena.cb.overwriteConfirm')) + '</span></div>' +
            '<div class="modal-row">' +
            '<button class="modal-btn full-width" id="arena-overwrite-cancel">' + escapeHtml(_t('ui.cancel')) + '</button>' +
            '<button class="modal-btn primary full-width" id="arena-overwrite-confirm">' + escapeHtml(_t('ui.overwrite')) + '</button>' +
            '</div></div>';
        document.getElementById('arena-overwrite-confirm').addEventListener('click', function () { _save(cur, name, true); });
        document.getElementById('arena-overwrite-cancel').addEventListener('click', function () { _renderSaveBody(cur, name); });
    }

    // A class's saved presets: Load (Explore only), Copy, Publish and delete on each
    function _renderSavedList(listId, classId, query, withLoad) {
        const list = document.getElementById(listId);
        if (!list) return;
        const pool = _savedFor(classId);
        const q = (query || '').trim().toLowerCase();
        const shown = q ? pool.filter(function (p) { return p.name.toLowerCase().includes(q); }) : pool;
        const count = document.getElementById('arena-saved-count');
        if (count) count.textContent = pool.length ? '(' + pool.length + ')' : '';
        if (shown.length === 0) {
            list.innerHTML = '<div class="arena-cb-note">' + escapeHtml(_t(pool.length ? 'modal.noMatch' : 'arena.cb.noSaved')) + '</div>';
            return;
        }
        list.innerHTML = shown.map(function (p) {
            const id = escapeHtml(p.id);
            const publish = _off() || _mobile() ? '' : p.publishedId
                ? '<button class="saved-build-btn publish-btn is-published" data-saved-republish="' + id + '">' + escapeHtml(_t('modal.publishedBtn')) + '</button>'
                : '<button class="saved-build-btn publish-btn" data-saved-publish="' + id + '">' + escapeHtml(_t('modal.publishBtn')) + '</button>';
            return '<div class="saved-build-card">' +
                '<div class="saved-build-info"><div class="saved-build-name"><span class="marquee-text">' + escapeHtml(p.name) + '</span></div></div>' +
                '<div class="saved-build-actions">' +
                (withLoad ? '<button class="saved-build-btn load-btn" data-saved-load="' + id + '">' + escapeHtml(_t('ui.load')) + '</button>' : '') +
                '<button class="saved-build-btn copy-btn" data-saved-copy="' + id + '">' + escapeHtml(_t('ui.copy')) + '</button>' +
                publish +
                '<button class="saved-build-btn delete-btn" data-saved-delete="' + id + '">&#x2715;</button>' +
                '</div></div>';
        }).join('');
        const byId = function (node, attr) {
            const id = /** @type {HTMLElement} */ (node).getAttribute(attr);
            return _saved().find(function (p) { return p.id === id; }) || null;
        };
        list.querySelectorAll('[data-saved-load]').forEach(function (node) {
            node.addEventListener('click', function () {
                const p = byId(node, 'data-saved-load');
                if (!p) return;
                document.getElementById(EXPLORE_DIALOG)?.remove();
                _open(p.classId, p.loadout, p.name);
            });
        });
        list.querySelectorAll('[data-saved-copy]').forEach(function (node) {
            node.addEventListener('click', function () {
                const p = byId(node, 'data-saved-copy');
                if (p) _copy(_shareLink(encodeCode(p.classId, p.loadout)), 'toast.linkCopiedMsg');
            });
        });
        list.querySelectorAll('[data-saved-publish]').forEach(function (node) {
            node.addEventListener('click', function () { const p = byId(node, 'data-saved-publish'); if (p) _publishSaved(p.id); });
        });
        list.querySelectorAll('[data-saved-republish]').forEach(function (node) {
            node.addEventListener('click', function () { const p = byId(node, 'data-saved-republish'); if (p) _tryRepublish(p.id); });
        });
        list.querySelectorAll('[data-saved-delete]').forEach(function (node) {
            node.addEventListener('click', function () {
                _confirmDelete(/** @type {HTMLButtonElement} */ (node), function () {
                    const p = byId(node, 'data-saved-delete');
                    if (!p) return;
                    _persist(_saved().filter(function (x) { return x.id !== p.id; }));
                    // Deleting a published preset takes it out of the community too, as a saved build's does
                    if (p.publishedId && !_off() && !EFTForge.config.COMMUNITY_READ_ONLY) {
                        EFTForge.api.unlistBuild(p.publishedId).then(function () {
                            delete _countCache[p.classId];
                            syncButtons();
                        }).catch(function () { /* still listed: unlist it from the community list */ });
                    }
                    _renderSavedList(listId, classId, _searchValue('arena-saved-search'), withLoad);
                });
            });
        });
        _initMarqueeText(list);
    }

    function _searchValue(id) {
        const input = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
        return input ? input.value : '';
    }

    // The first click arms it, like every other delete and unlist button
    function _confirmDelete(btn, run) {
        if (btn.dataset.confirming === '1') {
            run();
            return;
        }
        const label = btn.innerHTML;
        btn.dataset.confirming = '1';
        btn.textContent = _t('ui.confirm');
        btn.classList.add('confirming');
        const reset = function () {
            if (btn.dataset.confirming !== '1') return;
            delete btn.dataset.confirming;
            btn.innerHTML = label;
            btn.classList.remove('confirming');
        };
        setTimeout(reset, 3000);
        btn.addEventListener('mouseleave', reset, { once: true });
    }

    /* ===========================
       PUBLISHING A SAVED PRESET
       As a saved build is published: it opens first, then the confirmation shows over it.
    =========================== */

    async function _publishSaved(id) {
        if (_off() || _mobile() || blockedInBeta()) return;
        const entry = _saved().find(function (p) { return p.id === id; });
        if (!entry) return;
        document.getElementById(SAVE_DIALOG)?.remove();
        document.getElementById(EXPLORE_DIALOG)?.remove();
        await _open(entry.classId, entry.loadout, entry.name);
        // The problems are the loadout's on show, which is now this one
        if (_loadout().problems().length) {
            showToast(_t('modal.publishBtn'), _t('arena.cb.fixProblems'), 4000, '#c0504d');
            return;
        }
        const overlay = _createModalOverlay(PUBLISH_DIALOG, escapeHtml(_t('arena.cb.publishTitle')), { maxWidth: '520px' });
        if (!overlay) return;
        document.getElementById(PUBLISH_DIALOG + '-body').innerHTML = '<div class="modal-section arena-publish">' +
            '<div class="arena-publish-name">' + escapeHtml(entry.name) + '</div>' +
            '<div class="arena-publish-class">' + _classTitleHtml(entry.classId) + '</div>' +
            '<div class="arena-publish-preview">' + (_loadout().summaryHtml(entry.loadout, entry.classId) || '') + '</div>' +
            '<div class="arena-publish-confirm">' + escapeHtml(_t('arena.cb.publishConfirm')) + '</div>' +
            '<div class="arena-publish-sub">' + escapeHtml(_t('publish.confirmSub')) + '</div>' +
            '<div class="arena-publish-warning">' + escapeHtml(_t('publish.nameWarning')) + '</div>' +
            '<div class="modal-row arena-publish-actions">' +
            '<button class="modal-btn" id="arena-publish-cancel">' + escapeHtml(_t('publish.btnCancel')) + '</button>' +
            '<button class="modal-btn primary" id="arena-publish-confirm">' + escapeHtml(_t('publish.btnConfirm')) + '</button>' +
            '</div></div>';
        document.getElementById('arena-publish-cancel').addEventListener('click', function () { overlay.remove(); });
        document.getElementById('arena-publish-confirm').addEventListener('click', function () { _confirmPublish(entry); });
    }

    async function _confirmPublish(entry) {
        const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('arena-publish-confirm'));
        if (!btn || btn.disabled) return;
        btn.disabled = true;
        btn.textContent = _t('publish.publishing');
        const profile = EFTForge.profile ? EFTForge.profile.getProfile() : {};
        let result;
        try {
            result = await EFTForge.api.publishArenaPreset({
                class_id: entry.classId,
                build_name: entry.name,
                loadout: entry.loadout,
                author_username: profile.username || null,
                author_avatar_url: profile.avatar_url || null,
            });
        } catch (err) {
            btn.disabled = false;
            btn.textContent = _t('publish.btnConfirm');
            let msg = err.message || '';
            if (msg === 'rate_limit') msg = _t('toast.publishRateLimit');
            else if (msg === 'community_builds_limit_reached') msg = _t('arena.cb.limitReached');
            else if (msg.includes('ban')) msg = _t('toast.publishBanned');
            showToast(_t('toast.publishFailed'), msg, 4500);
            return;
        }
        const list = _saved();
        const saved = list.find(function (p) { return p.id === entry.id; });
        if (saved && result && result.id) {
            saved.publishedId = result.id;
            _persist(list);
        }
        document.getElementById(PUBLISH_DIALOG)?.remove();
        delete _countCache[entry.classId];
        syncButtons();
        showToast(_t('toast.publishSuccess'), _t('arena.cb.published'), 3000, '#4CAF50');
    }

    // "Published": nothing to do while it's still listed, else publish it again
    async function _tryRepublish(id) {
        const entry = _saved().find(function (p) { return p.id === id; });
        if (!entry) return;
        try {
            const mine = await EFTForge.api.fetchMyArenaPresets();
            if (mine.some(function (p) { return p.id === entry.publishedId; })) return;
        } catch { /* can't tell: let it publish again */ }
        const list = _saved();
        const saved = list.find(function (p) { return p.id === id; });
        if (saved) {
            delete saved.publishedId;
            _persist(list);
        }
        _publishSaved(id);
    }

    /* ===========================
       EXPLORE PRESETS
    =========================== */

    async function showExploreDialog() {
        const classId = _currentClass();
        if (!classId) return;
        _classId = classId;
        _presets = [];
        _shown = [];
        const overlay = _createModalOverlay(EXPLORE_DIALOG, escapeHtml(_t('arena.cb.exploreTitle')), { maxWidth: '920px' });
        if (!overlay) return;
        document.getElementById(EXPLORE_DIALOG + '-body').innerHTML =
            '<div class="modal-section">' +
            '<div class="modal-label arena-cb-title">' + escapeHtml(_t('arena.cb.myPresets')) + ' ' + _classTitleHtml(classId) +
            ' <span id="arena-saved-count" class="arena-saved-count"></span></div>' +
            '<input id="arena-saved-search" type="text" class="search-input arena-cb-search" placeholder="' + escapeHtml(_t('arena.cb.searchSaved')) + '" />' +
            '<div id="arena-explore-saved" class="arena-saved-list"></div>' +
            '</div>' +
            '<hr class="modal-divider" />' +
            '<div class="modal-section">' +
            '<div class="modal-label arena-cb-title">' + escapeHtml(_t('arena.cb.communityPresets')) + ' ' + _classTitleHtml(classId) +
            ' <span id="arena-cb-count" class="cb-count-label"></span></div>' +
            (_off() ? _communityLocalPromptHtml() :
                '<div class="cb-controls">' +
                '<input id="arena-cb-search" type="text" class="search-input cb-search-input" placeholder="' + escapeHtml(_t('cb.searchPlaceholder')) + '" />' +
                '<select id="arena-cb-sort" class="cb-sort-select">' +
                ['default', 'newest', 'loads', 'rating'].map(function (s) {
                    return '<option value="' + s + '">' + escapeHtml(_t('cb.sort.' + s)) + '</option>';
                }).join('') +
                '<option value="meta">' + escapeHtml(_t('arena.cb.sortMeta')) + '</option>' +
                '</select></div>' +
                '<div id="arena-cb-list" class="arena-cb-list"><div class="arena-cb-note">' + escapeHtml(_t('modal.publishLoading')) + '</div></div>') +
            '</div>';

        const savedSearch = /** @type {HTMLInputElement} */ (document.getElementById('arena-saved-search'));
        savedSearch.addEventListener('input', function () { _renderSavedList('arena-explore-saved', classId, savedSearch.value, true); });
        _renderSavedList('arena-explore-saved', classId, '', true);

        if (_off()) return;
        document.getElementById('arena-cb-search').addEventListener('input', _applyFilter);
        document.getElementById('arena-cb-sort').addEventListener('change', _applyFilter);
        setupCustomSelect('arena-cb-sort');
        await _fetch(classId);
    }

    async function _fetch(classId) {
        let presets;
        try {
            presets = await EFTForge.api.fetchArenaPresets(classId);
            // Every slot's picture and meta points, before the cards draw
            await _loadout().ensureItems(presets.map(function (p) { return p.loadout; }));
        } catch (err) {
            const list = document.getElementById('arena-cb-list');
            if (!list || _classId !== classId) return;
            const killed = err && err.message === 'community_builds_disabled';
            list.innerHTML = '<div class="arena-cb-note' + (killed ? '' : ' is-error') + '">' +
                escapeHtml(_t(killed ? 'modal.communityBuildsUnavailable' : 'modal.publicBuildsError')) + '</div>';
            return;
        }
        if (_classId !== classId || !document.getElementById(EXPLORE_DIALOG)) return;
        _countCache[classId] = presets.length;
        syncButtons();
        presets.forEach(function (p) { p._meta = _loadout().totals(p.loadout).total; });
        _presets = presets;
        _applyFilter();
        EFTForge.api.fetchBulkBuildRatings(presets.map(function (p) { return p.id; })).then(function (ratings) {
            EFTForge.state.buildRatingsCache = Object.assign(EFTForge.state.buildRatingsCache || {}, ratings);
            _refreshBuildRatingCells();
            const sort = /** @type {HTMLSelectElement | null} */ (document.getElementById('arena-cb-sort'));
            if (sort && sort.value === 'rating') _applyFilter();
        }).catch(function () { /* the likes stay at 0 */ });
    }

    function _authorOf(p) {
        if (p.is_admin_build) {
            const zh = EFTForge.state.lang === 'zh';
            return {
                name: (zh && p.author_display_name_zh) || p.author_display_name || 'Morph1ne',
                avatar: proxyAvatarUrl(p.author_avatar_url) || './news/images/devProfilePic.jpg',
            };
        }
        return {
            name: p.user_display_name || _t('modal.anonymousAuthor'),
            avatar: proxyAvatarUrl(p.user_avatar_url) || './assets/images/tarkovcitizen.jpg',
        };
    }

    function _applyFilter() {
        const list = document.getElementById('arena-cb-list');
        if (!list) return;
        const sortEl = /** @type {HTMLSelectElement | null} */ (document.getElementById('arena-cb-sort'));
        const query = _searchValue('arena-cb-search').trim().toLowerCase();
        const sort = sortEl ? sortEl.value : 'default';
        let shown = _presets.filter(function (p) {
            if (!query) return true;
            return (p.build_name || '').toLowerCase().includes(query) || _authorOf(p).name.toLowerCase().includes(query);
        });
        const ratings = EFTForge.state.buildRatingsCache || {};
        const newest = function (a, b) { return new Date(b.published_at).getTime() - new Date(a.published_at).getTime(); };
        shown = shown.slice().sort(function (a, b) {
            if (sort === 'newest') return newest(a, b);
            if (sort === 'loads') return (b.load_count || 0) - (a.load_count || 0);
            if (sort === 'rating') return ((ratings[b.id] || {}).likes || 0) - ((ratings[a.id] || {}).likes || 0);
            if (sort === 'meta') return a._meta - b._meta;
            if (b.is_featured !== a.is_featured) return b.is_featured ? 1 : -1;
            return newest(a, b);
        });
        _shown = shown;

        const count = document.getElementById('arena-cb-count');
        if (count) count.textContent = query ? shown.length + ' / ' + _presets.length : String(_presets.length);
        if (shown.length === 0) {
            list.innerHTML = '<div class="arena-cb-note">' + escapeHtml(_t(query ? 'cb.noMatch' : 'arena.cb.none')) + '</div>';
            return;
        }
        _clearMarqueeTimers();
        const lang = EFTForge.state.lang;
        const fresh = _getNewCommentBuildIds();
        list.innerHTML = shown.map(function (p, idx) { return _cardHtml(p, idx, lang, fresh); }).join('');
        list.querySelectorAll('[data-arena-load]').forEach(function (node) {
            node.addEventListener('click', function () { _load(Number(/** @type {HTMLElement} */ (node).dataset.arenaLoad)); });
        });
        list.querySelectorAll('[data-arena-unlist]').forEach(function (node) {
            const btn = /** @type {HTMLButtonElement} */ (node);
            btn.addEventListener('click', function () { _confirmDelete(btn, function () { _unlist(btn, Number(btn.dataset.arenaUnlist)); }); });
        });
        _initMarqueeText(list, { hoverOnly: true, hoverTarget: '.cb-card' });
        _refreshBuildRatingCells();
    }

    function _cardHtml(p, idx, lang, fresh) {
        const author = _authorOf(p);
        const published = p.published_at ? new Date(p.published_at + 'Z') : null;
        const date = published
            ? published.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })
            : '';
        return '<div class="cb-card arena-cb-card' + (p.is_featured ? ' featured' : '') + '">' +
            (p.is_featured ? '<div class="cb-featured-label">' + escapeHtml(_t('cb.featured')) + '</div>' : '') +
            '<div class="cb-card-body">' +
            '<div class="cb-build-name"><span class="marquee-text">' + escapeHtml(p.build_name) + '</span></div>' +
            '<div class="cb-publish-date">' + escapeHtml(date) + '</div>' +
            '<div class="cb-author"><img src="' + escapeHtml(author.avatar) + '" class="cb-avatar" loading="lazy" onerror="this.src=\'./assets/images/tarkovcitizen.jpg\';this.onerror=null;" />' +
            '<span class="cb-author-name"><span class="marquee-text">' + escapeHtml(author.name) + '</span></span></div>' +
            '<div class="cb-load-count">' + (p.load_count || 0) + ' ' + escapeHtml(_t('cb.loads')) + '</div>' +
            '</div>' +
            '<div class="arena-cb-slots">' + (_loadout().summaryHtml(p.loadout, p.class_id) || '') + '</div>' +
            '<div class="cb-card-footer">' +
            '<div class="cb-rating att-rating" data-build-id="' + p.id + '">' +
            '<button class="att-vote-btn att-vote-like" data-tooltip="' + escapeHtml(_t('cb.rating.like')) + '" onclick="handleBuildVoteClick(event,' + p.id + ',\'like\')">' +
            '<img src="./assets/images/icon-fir.png" class="att-vote-icon" /><span class="att-vote-count">0</span></button></div>' +
            (p.is_mine ? '<button class="saved-build-btn unlist-btn" data-arena-unlist="' + p.id + '">' + escapeHtml(_t('modal.unlistBtn')) + '</button>' : '') +
            '<button class="saved-build-btn cb-comments-toggle-btn' + (fresh.has(p.id) ? ' has-new-comment' : '') + '" data-build-id="' + p.id + '" ' +
            'onclick="_toggleBuildComments(event,' + p.id + ')">' + escapeHtml(_t('cb.comments')) + (p.comment_count > 0 ? ' (' + p.comment_count + ')' : '') + '</button>' +
            '<button class="saved-build-btn load-btn" data-arena-load="' + idx + '">' + escapeHtml(_t('ui.load')) + '</button>' +
            '</div>' +
            '<div class="cb-comments-section" id="cb-comments-' + p.id + '" style="display:none;"></div>' +
            '</div>';
    }

    async function _load(idx) {
        const preset = _shown[idx];
        if (!preset) return;
        document.getElementById(EXPLORE_DIALOG)?.remove();
        EFTForge.api.recordBuildLoad(preset.id);
        await _open(preset.class_id, preset.loadout, preset.build_name);
    }

    async function _unlist(btn, id) {
        if (blockedInBeta()) return;
        btn.disabled = true;
        try {
            await EFTForge.api.unlistBuild(id);
        } catch (err) {
            btn.disabled = false;
            showToast(_t('toast.unlistFailed'), err.message || '', 3500);
            return;
        }
        // A saved preset published as this one can be published again
        const list = _saved();
        list.forEach(function (p) { if (p.publishedId === id) delete p.publishedId; });
        _persist(list);
        _presets = _presets.filter(function (p) { return p.id !== id; });
        if (_classId) {
            _countCache[_classId] = _presets.length;
            _renderSavedList('arena-explore-saved', _classId, _searchValue('arena-saved-search'), true);
        }
        _applyFilter();
        syncButtons();
        showToast(_t('toast.unlistSuccess'), _t('toast.unlistSuccessMsg'), 3000, '#4CAF50');
    }

    function onLangChange() {
        _updateStaticText();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _wireButtons);
    else _wireButtons();

    return {
        syncButtons: syncButtons,
        showSaveDialog: showSaveDialog,
        showExploreDialog: showExploreDialog,
        encodeCode: encodeCode,
        decodeCode: decodeCode,
        importCode: importCode,
        checkUrlParam: checkUrlParam,
        onLangChange: onLangChange,
    };

}());
