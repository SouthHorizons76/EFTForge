window.EFTForge = window.EFTForge || {};

/* ============================================================
   ATLAS HEADER: GAME MODE SWITCH, SERVERS AND PLAYERS
   The middle of every Atlas page's header: the game mode toggle (PvE, PvP,
   PvP Season, Arena), then the Changes, Servers and Players buttons. One toggle for
   the whole site, so the mode is remembered and the next Atlas page opens on it.
   Each page says which modes it has something for:
   - a mode with a link goes to that page (the change trackers: season at /atlas,
     Arena at /atlas/arena, PvP at /atlas/pvp, PvE at /atlas/pve);
   - a mode in `available` stays on the page and calls onSelect (the player lookup);
   - any other mode is shown but can't be picked yet.
   The labels follow the page's language select.
============================================================ */

window.EFTForge.atlasMode = (function () {

    const MODE_STORAGE = 'eftforge_atlas_mode';
    const LANG_STORAGE = 'eftforge_lang';   // shared with the rest of the site
    const MODES = ['pve', 'pvp', 'season', 'arena'];
    // the change tracker of each mode (PvP's and PvE's are empty until they have change sets)
    const TRACKERS = { pve: '/atlas/pve', pvp: '/atlas/pvp', season: '/atlas', arena: '/atlas/arena' };

    const STRINGS = {
        en: { pve: 'PvE', pvp: 'PvP', season: 'PvP S', arena: 'Arena',
              seasonFull: 'PvP Season', label: 'Game mode', soon: 'Coming soon',
              changes: 'Changes', servers: 'Servers', players: 'Players',
              eftOnly: 'Average matching times are for EFT only' },
        zh: { pve: 'PvE', pvp: 'PvP', season: 'PvP S', arena: '竞技场',
              seasonFull: 'PvP 赛季', label: '游戏模式', soon: '即将推出',
              changes: '变动', servers: '服务器', players: '玩家',
              eftOnly: '平均匹配时间仅适用于逃离塔科夫' },
    };

    /** @type {{ page: string, current: string | null, links: Record<string, string>, available: string[], onSelect: ((mode: string) => void) | null, locked: string }} */
    let _opts = { page: '', current: null, links: {}, available: [], onSelect: null, locked: '' };

    function readStorage(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    }
    function writeStorage(key, value) {
        try { localStorage.setItem(key, value); } catch { /* private window: the switch still works */ }
    }

    // The last mode picked anywhere on Atlas, season when there's none yet
    function stored() {
        const mode = readStorage(MODE_STORAGE);
        return mode && MODES.includes(mode) ? mode : 'season';
    }

    function lang() {
        const select = /** @type {HTMLSelectElement | null} */ (document.getElementById('lang-select'));
        const value = select && select.value ? select.value : readStorage(LANG_STORAGE);
        return value === 'zh' ? 'zh' : 'en';
    }

    const samePath = href => href.replace(/\/+$/, '') === location.pathname.replace(/\/+$/, '');

    function render() {
        const s = /** @type {Record<string, string>} */ (STRINGS[lang()]);
        const root = document.getElementById('atlas-mode-switch');
        if (root) {
            root.setAttribute('aria-label', s.label);
            root.querySelectorAll('[data-atlas-gamemode]').forEach(node => {
                const btn = /** @type {HTMLAnchorElement} */ (node);
                const mode = btn.dataset.atlasGamemode || '';
                const href = _opts.links[mode];
                const usable = !_opts.locked && (Boolean(href) || _opts.available.includes(mode));
                const current = mode === _opts.current;
                btn.textContent = s[mode];
                btn.classList.toggle('active', current);
                btn.classList.toggle('is-disabled', !usable);
                if (current) btn.setAttribute('aria-current', 'true'); else btn.removeAttribute('aria-current');
                if (href) btn.setAttribute('href', href); else btn.removeAttribute('href');
                btn.setAttribute('role', href ? 'link' : 'button');
                btn.tabIndex = usable ? 0 : -1;
                if (usable) btn.removeAttribute('aria-disabled'); else btn.setAttribute('aria-disabled', 'true');
                // the short "PvP S" spelled out on hover, and why a mode can't be picked yet
                btn.title = _opts.locked ? s[_opts.locked] : !usable ? s.soon : mode === 'season' ? s.seasonFull : '';
            });
        }
        document.querySelectorAll('[data-atlas-page]').forEach(node => {
            const btn = /** @type {HTMLElement} */ (node);
            const page = btn.dataset.atlasPage || '';
            const label = btn.querySelector('.profile-nav-label');
            if (label) label.textContent = s[page];
            // the change tracker of the mode on the switch, season's when that mode has none
            if (page === 'changes') btn.setAttribute('href', TRACKERS[_opts.current || stored()] || TRACKERS.season);
            btn.classList.toggle('active', page === _opts.page);
            if (page === _opts.page) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
        });
    }

    function pick(mode) {
        if (mode === _opts.current) return;
        writeStorage(MODE_STORAGE, mode);
        _opts.current = mode;
        render();
        if (_opts.onSelect) _opts.onSelect(mode);
    }

    // a plain click on the page we're already on does nothing; a modified one still opens a tab
    function isPlain(e) {
        const m = /** @type {MouseEvent} */ (e);
        return m.button === 0 && !m.ctrlKey && !m.metaKey && !m.shiftKey && !m.altKey;
    }

    /**
     * Sets the header up for this page.
     * @param {{ page?: string, current?: string | null, links?: Record<string, string>,
     *           available?: string[], onSelect?: (mode: string) => void, locked?: string }} [options]
     *   page: 'changes', 'servers' or 'players' lights that button up;
     *   current: the mode this page shows (a change tracker knows it from its path);
     *   left out, the remembered one if the page has it, else none;
     *   locked: a page with nothing per mode greys every mode out, with this string's text as the reason.
     * @returns {string | null} the mode the switch starts on
     */
    function init(options = {}) {
        const links = options.links || {};
        const available = options.available || [];
        let current = options.current;
        if (current === undefined) {
            const mode = stored();
            current = links[mode] || available.includes(mode) ? mode : null;
        }
        _opts = { page: options.page || '', current, links, available, onSelect: options.onSelect || null, locked: options.locked || '' };
        // a page that shows one mode makes it the remembered one, so the next page opens on it
        if (current) writeStorage(MODE_STORAGE, current);

        const root = document.getElementById('atlas-mode-switch');
        if (root) {
            root.addEventListener('click', e => {
                const btn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-atlas-gamemode]'));
                if (!btn) return;
                const mode = btn.dataset.atlasGamemode || '';
                if (btn.classList.contains('is-disabled')) { e.preventDefault(); return; }
                const href = _opts.links[mode];
                if (href) {
                    if (!isPlain(e)) return;
                    if (samePath(href)) e.preventDefault();
                    else writeStorage(MODE_STORAGE, mode);
                    return;
                }
                e.preventDefault();
                pick(mode);
            });
            root.addEventListener('keydown', e => {
                const btn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-atlas-gamemode]'));
                if (!btn || btn.getAttribute('role') !== 'button') return;
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    btn.click();
                }
            });
        }
        document.querySelectorAll('[data-atlas-page]').forEach(node => {
            const btn = /** @type {HTMLAnchorElement} */ (node);
            btn.addEventListener('click', e => {
                if (isPlain(e) && samePath(btn.getAttribute('href') || '')) e.preventDefault();
            });
        });
        const select = document.getElementById('lang-select');
        if (select) select.addEventListener('change', render);
        render();
        return current;
    }

    // Picks a mode from elsewhere on the page (the players page's own switch), as a click on
    // the header's would: only one this page has, and never a link (that's a page change)
    function select(mode) {
        if (_opts.locked || _opts.links[mode] || !_opts.available.includes(mode)) return;
        pick(mode);
    }

    return { init, render, select, stored, TRACKERS, MODES };
})();
