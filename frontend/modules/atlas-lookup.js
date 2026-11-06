/* global _buildGridDOM -- attachment-grid.js, loaded after this file */
window.EFTForge = window.EFTForge || {};
// The builder's Kitbash! "working" logo, which the attachment grid puts in its gun cell. This
// page always has its drawing already (build-preview.js isn't loaded), so the logo stays out.
window._bpWorkingLogoHtml = window._bpWorkingLogoHtml || (() => '');
// The builder's shared state, as far as the attachment grid (attachment-grid.js, loaded after
// this file) reads it: it sets gridView at load and keeps its slot lists in slotCache.
window.EFTForge.state = window.EFTForge.state || { lang: 'en', slotCache: {} };

/* ============================================================
   ATLAS PLAYER LOOKUP (testing)
   Standalone page at /atlas/lookup, not linked from anywhere yet. Takes a nickname (found
   with /atlas/api/lookup/search) or an account ID and shows what the game's profile screen
   shows of that player, from /atlas/api/lookup, which gets it from Atlas' upstream provider; the backend adds pictures,
   Kitbash! drawings, armor classes and each weapon's builder payload.

   Built from EFTForge's own pieces:
   - the header: level badge and prestige icon from tarkov.dev, the ending's badge from the
     game (assets/images/atlas-lookup/endings), and the overall stats;
   - each weapon: the builder's gun display (.bp-display-wrap); a click turns it into the
     builder's attachment grid itself (attachment-grid.js: collectAllVisibleSlots,
     computeGridPositions, _buildGridDOM), read only, with a link into the builder;
   - the gear: the Ballistics Workbench's loadout board (.bw-slot over the PMC), laid out
     like the game's gear panel (TarkTetris theme.js GEAR_SLOTS) with the plates and helmet
     attachments around their parent as the workbench places them (armor-sim.js).
   Admin only (lookups stay within the upstream provider's limits), with the same stored key as the
   Atlas page. Data goes into the page through textContent or element properties; the only
   innerHTML is utils.js shortNameHtml, which escapes first.
============================================================ */

window.EFTForge.atlasLookup = (function () {

    const API = '/atlas/api/lookup';
    const LANG_STORAGE = 'eftforge_lang';       // shared with the rest of the site
    const KEY_STORAGE  = 'eftforge_atlas_key';  // shared with the Atlas page
    const LAST_STORAGE = 'eftforge_atlas_lookup_last';
    const ART = '/assets/images/ballistics-loadout/';
    const ENDING_ART = '/assets/images/atlas-lookup/endings/';

    const WEAPON_SLOTS = ['FirstPrimaryWeapon', 'SecondPrimaryWeapon', 'Holster'];

    const STRINGS = {
        en: {
            pageTitle: 'Atlas - Player Lookup (test)',
            returnTo:  'Return to',
            title:     'Player lookup',
            badge:     'TEST',
            note:      'What a player\'s profile shows in the season mode, gear included, by nickname or account ID. Lookups come from Atlas\' upstream provider; they\'re paced, and repeats within a minute come from cache.',
            query:     'Nickname or account ID',
            lookup:    'Look up',
            keyPrompt: 'Admin key',
            saveKey:   'Save key',
            loading:   'Looking up...',
            found:     n => `${n} players found. Pick one:`,
            level:     'Level',
            prestige:  'Prestige',
            ending:    'Ending',
            noEnding:  'None yet',
            account:   'Account',
            exp:       'Experience',
            when:      'Looked up',
            cached:    'cached',
            achievements: 'Achievements',
            weapons:   'Weapons',
            gear:      'Gear',
            stats:     'Overall',
            pmc:       'PMC',
            scav:      'Scav',
            openBuilder:'Open in EFTForge',
            showGrid:  'Show the attachment grid',
            showImage: 'Show the gun',
            partial:   'Some parts aren\'t in EFTForge\'s data yet and are left out of the builder.',
            gridFailed:'The attachment grid couldn\'t be loaded.',
            empty:     'Empty',
            nothing:   'Nothing equipped.',
            errKey:    'This needs the admin key.',
            errBad:    'Enter a nickname (3 to 15 letters, digits, _ . -) or an account ID.',
            errNoMatch:'No player with that nickname.',
            errRate:   'Too many lookups. Try again later.',
            errSession:'Atlas\' upstream provider can\'t look players up right now. Try again later.',
            errBackend:'The game backend refused the lookup.',
            errNotFound:'No profile came back for that account.',
            errUnavailable:'Player lookup isn\'t set up here (ATLAS_LOOKUP_URL), or Atlas\' upstream provider isn\'t reachable.',
            errNetwork:'Couldn\'t reach the server.',
            stat: {
                raids: 'Raids', survived: 'Survived', kia: 'KIA', mia: 'Missing in action', awol: 'AWOL',
                kills: 'Kills', pmcKills: 'PMC kills', online: 'Online', runs: 'Run-throughs', transits: 'Transits',
                rate: 'Survival rate', streak: 'Survived in a row', leave: 'Leave rate', kd: 'K/D',
            },
            slots: {
                FirstPrimaryWeapon: 'On sling', SecondPrimaryWeapon: 'On back', Holster: 'Holster',
                Scabbard: 'Sheath', Headwear: 'Headwear', Earpiece: 'Earpiece', FaceCover: 'Face cover',
                Eyewear: 'Eyewear', ArmorVest: 'Body armor', TacticalVest: 'Tactical rig', Backpack: 'Backpack',
                ArmBand: 'Armband', SecuredContainer: 'Pouch',
                front_plate: 'Front plate', back_plate: 'Back plate', left_side_plate: 'Left plate',
                right_side_plate: 'Right plate', attachment: 'Helmet attachment',
            },
        },
        zh: {
            pageTitle: 'Atlas - 玩家查询（测试）',
            returnTo:  '返回',
            title:     '玩家查询',
            badge:     '测试',
            note:      '按昵称或账号 ID 显示玩家在赛季模式中的资料，包括当前装备。查询数据来自 Atlas 的上游数据源，有频率限制，一分钟内的重复查询使用缓存。',
            query:     '昵称或账号 ID',
            lookup:    '查询',
            keyPrompt: '管理员密钥',
            saveKey:   '保存密钥',
            loading:   '查询中...',
            found:     n => `找到 ${n} 名玩家，请选择：`,
            level:     '等级',
            prestige:  '威望',
            ending:    '结局',
            noEnding:  '尚无',
            account:   '账号',
            exp:       '经验',
            when:      '查询时间',
            cached:    '缓存',
            achievements: '成就',
            weapons:   '武器',
            gear:      '装备',
            stats:     '总览',
            pmc:       'PMC',
            scav:      'Scav',
            openBuilder:'在 EFTForge 中打开',
            showGrid:  '显示配件网格',
            showImage: '显示枪械',
            partial:   '部分配件尚未收录于 EFTForge 数据，已在改枪器中省略。',
            gridFailed:'无法加载配件网格。',
            empty:     '空',
            nothing:   '没有装备。',
            errKey:    '需要管理员密钥。',
            errBad:    '请输入昵称（3 到 15 个字母、数字或 _ . -）或账号 ID。',
            errNoMatch:'没有该昵称的玩家。',
            errRate:   '查询过多，请稍后再试。',
            errSession:'Atlas 的上游数据源暂时无法查询玩家，请稍后再试。',
            errBackend:'游戏后端拒绝了这次查询。',
            errNotFound:'该账号没有返回资料。',
            errUnavailable:'此处未配置玩家查询（ATLAS_LOOKUP_URL），或无法连接 Atlas 的上游数据源。',
            errNetwork:'无法连接服务器。',
            stat: {
                raids: '战局', survived: '存活', kia: '阵亡', mia: '失踪', awol: '擅离',
                kills: '击杀', pmcKills: 'PMC 击杀', online: '在线时长', runs: '跑刀', transits: '转移',
                rate: '存活率', streak: '连续存活', leave: '离开率', kd: 'K/D',
            },
            slots: {
                FirstPrimaryWeapon: '主武器(吊索)', SecondPrimaryWeapon: '主武器(背部)', Holster: '枪套',
                Scabbard: '刀鞘', Headwear: '头部装备', Earpiece: '耳机', FaceCover: '面部装备',
                Eyewear: '眼部装备', ArmorVest: '身体护甲', TacticalVest: '战术胸挂', Backpack: '背包',
                ArmBand: '臂带', SecuredContainer: '安全箱栏',
                front_plate: '前插板', back_plate: '后插板', left_side_plate: '左插板',
                right_side_plate: '右插板', attachment: '头盔配件',
            },
        },
    };

    let _lang = 'en';
    let _last = null;              // the last profile shown, redrawn on a language switch
    const _levels = new Map();     // account id -> level, from searches
    const _gridOpen = new Set();   // weapon slots shown as the attachment grid

    /* ===========================
       HELPERS
    =========================== */

    function readStorage(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    }

    function writeStorage(key, value) {
        try {
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        } catch { /* private mode: the page still works, it just forgets */ }
    }

    function t(key) {
        const table = STRINGS[_lang] || STRINGS.en;
        return key in table ? table[key] : STRINGS.en[key];
    }

    function $(id) { return document.getElementById(id); }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function img(src, className) {
        const node = document.createElement('img');
        if (className) node.className = className;
        node.src = src;
        node.alt = '';
        node.decoding = 'async';
        node.draggable = false;
        node.addEventListener('error', () => node.remove());
        return node;
    }

    function shortHtml(node, text) {
        node.innerHTML = window.EFTForge.utils ? window.EFTForge.utils.shortNameHtml(text) : '';   // escapes first
        if (!window.EFTForge.utils) node.textContent = text;
        return node;
    }

    function names(node) {
        const mine = _lang === 'zh' ? node.ch : node.en;
        const other = _lang === 'zh' ? node.en : node.ch;
        return { mine: mine || {}, other: other || {} };
    }

    // The item's name in the page's language, falling back to the other one, then its id.
    function itemName(node) {
        const { mine, other } = names(node);
        return mine.name || other.name || node.tpl || '?';
    }

    function shortName(node) {
        const { mine, other } = names(node);
        return mine.short || other.short || itemName(node);
    }

    function slotLabel(slot) {
        const table = (_lang === 'zh' ? STRINGS.zh : STRINGS.en).slots;
        return table[slot] || slot.replace(/^mod_/, '').replace(/_\d+$/, '').replace(/_/g, ' ');
    }

    // An attachment's slot as the builder names it (tSlot), when the backend matched it
    function partLabel(node) {
        if (node.slot_name && window.EFTForge.lang) return window.EFTForge.lang.tSlot(node.slot_name);
        return slotLabel(node.slot);
    }

    function formatTime(iso) {
        const d = new Date(iso);
        return isNaN(d.getTime()) ? String(iso || '') : d.toLocaleString(_lang === 'zh' ? 'zh-CN' : 'en-US');
    }

    function errorText(status, code) {
        if (status === 403) return t('errKey');
        if (status === 422 || code === 'bad_account' || code === 'bad_nickname') return t('errBad');
        if (status === 429) return t('errRate');
        if (code === 'session') return t('errSession');
        if (code === 'backend') return t('errBackend');
        if (code === 'not_found') return t('errNotFound');
        if (status === 0) return t('errNetwork');
        return t('errUnavailable');
    }

    // A builder link for a weapon's payload, or null (build-codes.js not loaded, or no payload)
    function builderLink(build) {
        if (!build || !build.payload || typeof encodeBuildCode !== 'function') return null;
        try {
            return '/?build=' + encodeURIComponent(encodeBuildCode(build.payload, 2));
        } catch {
            return null;
        }
    }

    // tarkov.dev's art for a level (a badge per 5 levels) and a prestige level
    function levelBadge(level) {
        return level ? `https://assets.tarkov.dev/player-level-group-${Math.floor(level / 5) + 1}.png` : null;
    }

    function prestigeIcon(prestige) {
        return prestige ? `https://assets.tarkov.dev/prestige-${prestige}-icon.webp` : null;
    }

    /* ===========================
       STATS
    =========================== */

    // A counter whose key holds every one of `parts`, as tarkov.dev reads overAllCounters
    function counter(side, ...parts) {
        const found = ((side && side.counters) || []).find(([key]) => parts.every(p => key.includes(p)));
        return found ? found[1] : 0;
    }

    function percent(part, whole) {
        return whole ? `${(part * 100 / whole).toFixed(0)} %` : '-';
    }

    function hours(seconds) {
        if (typeof seconds !== 'number') return '-';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return `${h.toLocaleString()}h${String(m).padStart(2, '0')}m`;
    }

    // The game's overall tab, for one side ("Pmc" or "Scav")
    function sideStats(side, tag) {
        const raids = counter(side, 'Sessions', tag);
        const survived = counter(side, 'ExitStatus', 'Survived', tag);
        const left = counter(side, 'ExitStatus', 'Left', tag);
        const deaths = counter(side, 'Deaths') || counter(side, 'ExitStatus', 'Killed', tag);
        const pmcKills = counter(side, 'KilledPmc');
        return [
            ['raids', raids.toLocaleString()],
            ['survived', survived.toLocaleString()],
            ['kia', counter(side, 'ExitStatus', 'Killed', tag).toLocaleString()],
            ['mia', counter(side, 'ExitStatus', 'MissingInAction', tag).toLocaleString()],
            ['awol', left.toLocaleString()],
            ['kills', counter(side, 'Kills').toLocaleString()],
            ['pmcKills', pmcKills.toLocaleString()],
            ['online', hours(side && side.time)],
            ['runs', counter(side, 'ExitStatus', 'Runner', tag).toLocaleString()],
            ['transits', counter(side, 'ExitStatus', 'Transit', tag).toLocaleString()],
            ['rate', percent(survived, raids)],
            ['streak', counter(side, 'LongestWinStreak', tag).toLocaleString()],
            ['leave', percent(left, raids)],
            ['kd', deaths ? (pmcKills / deaths).toFixed(2) : '-'],
        ];
    }

    /* ===========================
       HEADER
    =========================== */

    function renderHeader(data) {
        const level = data.level ?? _levels.get(String(data.accountId));
        const player = $('atlas-lookup-player');
        player.replaceChildren();

        const rank = el('div', 'atlas-lookup-rank');
        const badge = levelBadge(level);
        if (badge) rank.appendChild(img(badge, 'atlas-lookup-level-badge'));
        rank.appendChild(el('div', 'atlas-lookup-level', level ?? '-'));
        player.appendChild(rank);

        const who = el('div', 'atlas-lookup-who');
        const side = String(data.side || '').toLowerCase();
        const line = el('div', 'atlas-lookup-nameline');
        line.appendChild(el('span', 'atlas-lookup-side ' + (side === 'bear' ? 'bear' : side === 'usec' ? 'usec' : ''),
            (data.side || '?').toUpperCase()));
        line.appendChild(el('span', 'atlas-lookup-nick', data.nickname || data.accountId));
        who.appendChild(line);
        const facts = el('div', 'atlas-lookup-facts');
        const fact = (label, value) => {
            const f = el('span', 'atlas-lookup-fact');
            f.appendChild(el('span', 'stat-label', label));
            f.appendChild(el('span', 'atlas-lookup-fact-value', value));
            facts.appendChild(f);
        };
        fact(t('exp'), typeof data.experience === 'number' ? data.experience.toLocaleString() : '-');
        const ach = data.achievements || {};
        if (typeof ach.count === 'number') fact(t('achievements'), ach.total ? `${ach.count} / ${ach.total}` : String(ach.count));
        fact(t('account'), String(data.accountId));
        fact(t('when'), formatTime(data.looked_up) + (data.cached ? ` (${t('cached')})` : ''));
        who.appendChild(facts);
        player.appendChild(who);

        const marks = el('div', 'atlas-lookup-marks');
        const prestige = el('div', 'atlas-lookup-mark');
        prestige.appendChild(el('div', 'atlas-lookup-mark-label', t('prestige')));
        const pIcon = prestigeIcon(data.prestigeLevel);
        if (pIcon) prestige.appendChild(img(pIcon, 'atlas-lookup-mark-img'));
        else prestige.appendChild(el('div', 'atlas-lookup-mark-none', '×'));
        marks.appendChild(prestige);

        const ending = el('div', 'atlas-lookup-mark');
        ending.appendChild(el('div', 'atlas-lookup-mark-label', t('ending')));
        const end = data.ending;
        if (end && end.systemName) {
            ending.appendChild(img(ENDING_ART + encodeURIComponent(end.systemName) + '.png', 'atlas-lookup-mark-img'));
            ending.title = String((_lang === 'zh' ? end.ch : end.en) || end.en || end.systemName).replace(/\s*\n\s*/g, ' ');
        } else {
            ending.appendChild(el('div', 'atlas-lookup-mark-none', '×'));
            ending.title = t('noEnding');
        }
        marks.appendChild(ending);
        player.appendChild(marks);

        const stats = $('atlas-lookup-stats');
        stats.replaceChildren();
        const labels = t('stat');
        for (const [tag, key] of [['Pmc', 'pmc'], ['Scav', 'scav']]) {
            const side = data.stats && data.stats[key];
            if (!side) continue;
            const row = el('div', 'atlas-lookup-stat-row');
            row.appendChild(el('div', 'atlas-lookup-stat-side', t(key)));
            const grid = el('div', 'atlas-lookup-stat-grid');
            for (const [name, value] of sideStats(side, tag)) {
                const cell = el('div', 'atlas-lookup-stat');
                cell.appendChild(el('div', 'atlas-lookup-stat-value', value));
                cell.appendChild(el('div', 'stat-label', labels[name]));
                grid.appendChild(cell);
            }
            row.appendChild(grid);
            stats.appendChild(row);
        }
    }

    /* ===========================
       WEAPONS: the builder's gun display, then its attachment grid
    =========================== */

    // A weapon from the upstream provider as the builder's tree: {item, children: {our slot id: node}}
    function builderTree(node) {
        const tree = {
            item: {
                id: node.tpl, name: itemName(node), short_name: shortName(node),
                icon_link: node.icon || '', image_512_link: node.render || node.image || node.icon || '',
            },
            children: {},
        };
        for (const child of node.children || []) {
            if (child.slot_id) tree.children[child.slot_id] = builderTree(child);
        }
        return tree;
    }

    // The builder's own grid for this weapon, read only. attachment-grid.js reads the gun
    // being built from EFTForge.state, so each grid is laid out with its own gun set there.
    async function showGrid(node, box) {
        const root = builderTree(node);
        const entries = await collectAllVisibleSlots(root);
        const state = EFTForge.state;
        const saved = { buildTree: state.buildTree, currentGun: state.currentGun };
        state.buildTree = root;
        state.currentGun = root.item;
        try {
            const { positions, gunRow, totalRows } = computeGridPositions(entries);
            box.replaceChildren();
            _buildGridDOM(entries, positions, gunRow, totalRows, box);
        } finally {
            state.buildTree = saved.buildTree;
            state.currentGun = saved.currentGun;
        }
        // Nothing here installs or removes parts: the cells only show what's in them
        box.querySelectorAll('.ag-cell').forEach(cell => {
            const c = /** @type {HTMLElement} */ (cell);
            c.onclick = null;
            c.oncontextmenu = null;
            c.style.cursor = 'default';
            const installed = c.dataset.installedItemId;
            if (installed) c.title = c.querySelector('.ag-label')?.textContent || '';
        });
        if (typeof _initMarqueeText === 'function') {
            _initMarqueeText(box, { hoverOnly: true, hoverTarget: '.ag-cell, .ag-gun-cell' });
        }
    }

    function weaponCard(node) {
        const card = el('section', 'atlas-lookup-weapon');
        const head = el('div', 'section-title atlas-lookup-card-head');
        head.appendChild(el('span', 'atlas-lookup-card-slot', slotLabel(node.slot)));
        const toggle = el('span', 'tree-view-toggle');
        const imageBtn = el('button', 'toggle-btn', '▭');
        const gridBtn = el('button', 'toggle-btn', '☷');
        imageBtn.title = t('showImage');
        gridBtn.title = t('showGrid');
        toggle.appendChild(imageBtn);
        toggle.appendChild(gridBtn);
        const link = builderLink(node.build);
        if (link) {
            const open = /** @type {HTMLAnchorElement} */ (el('a', 'modal-btn primary atlas-lookup-open', t('openBuilder')));
            open.href = link;
            open.target = '_blank';
            open.rel = 'noopener';
            if (node.build && !node.build.complete) open.title = t('partial');
            toggle.appendChild(open);
        }
        head.appendChild(toggle);
        card.appendChild(head);

        // The builder's gun display: the drawing of this build and its name
        const display = el('div', 'placeholder-inner atlas-lookup-display');
        display.title = t('showGrid');
        const wrap = el('div', 'bp-display-wrap');
        const picture = node.render || node.image || node.icon;
        if (picture) wrap.appendChild(img(picture, 'gun-display-image'));
        display.appendChild(wrap);
        display.appendChild(el('div', 'gun-display-name', itemName(node)));
        card.appendChild(display);

        const grid = el('div', 'atlas-lookup-grid');
        card.appendChild(grid);

        let built = false;
        const show = async (asGrid) => {
            if (asGrid) _gridOpen.add(node.slot); else _gridOpen.delete(node.slot);
            imageBtn.classList.toggle('active', !asGrid);
            gridBtn.classList.toggle('active', asGrid);
            display.hidden = asGrid;
            grid.hidden = !asGrid;
            if (!asGrid || built) return;
            built = true;
            try {
                await showGrid(node, grid);
            } catch (err) {
                built = false;
                console.warn('[atlas-lookup] attachment grid:', err);
                grid.replaceChildren(el('div', 'atlas-empty error', t('gridFailed')));
            }
        };
        display.addEventListener('click', () => show(true));
        imageBtn.addEventListener('click', () => show(false));
        gridBtn.addEventListener('click', () => show(true));
        show(_gridOpen.has(node.slot));
        return card;
    }

    /* ===========================
       GEAR: the Ballistics Workbench's loadout board, laid out like the game's gear panel
    =========================== */

    // Board units are the workbench's: 125 px slots with a 131 by 20 header 22 above them,
    // 56 px inserts 8 from their parent, the columns 197 apart so inserts fit between them,
    // the PMC (512 by 768) at the workbench's offset. The slots keep the game's gear panel
    // order (TarkTetris theme.js GEAR_SLOTS): earpiece, headwear, face cover; armband, body
    // armor, eyewear; the weapons below with the holster and sheath beside them. The
    // containers' column (rig, backpack, pouch) follows on the right, as in the game.
    const BOARD_W = 791;
    const BOARD_H = 955;
    const SLOT = 125;
    const INSERT = 56;
    const INSERT_GAP = 8;
    const COL = [37.5, 234.5, 431.5, 628.5];
    const ROW = [120, 361, 630, 800];
    const GEAR_LAYOUT = [
        { slot: 'Earpiece', x: COL[0], y: ROW[0] },
        { slot: 'Headwear', x: COL[1], y: ROW[0] },
        { slot: 'FaceCover', x: COL[2], y: ROW[0] },
        { slot: 'ArmBand', x: COL[0], y: ROW[1], h: 44 },
        { slot: 'ArmorVest', x: COL[1], y: ROW[1] },
        { slot: 'Eyewear', x: COL[2], y: ROW[1] },
        { slot: 'FirstPrimaryWeapon', x: COL[0], y: ROW[2], w: 310 },
        { slot: 'Holster', x: COL[2], y: ROW[2] },
        { slot: 'SecondPrimaryWeapon', x: COL[0], y: ROW[3], w: 310 },
        { slot: 'Scabbard', x: COL[2], y: ROW[3] },
        { slot: 'TacticalVest', x: COL[3], y: ROW[0] },
        { slot: 'Backpack', x: COL[3], y: ROW[1] },
        { slot: 'SecuredContainer', x: COL[3], y: ROW[2] },
    ];
    // Empty slot art: the workbench's placements where it has them (styles.css .bw-art-*), and
    // TarkTetris' back image rects (in slot px) for the rest, centred at native size otherwise
    const SLOT_ART = {
        Headwear: { file: 'Headwear.png', kind: 'headwear' },
        FaceCover: { file: 'Face_cover.png', kind: 'face_cover' },
        Eyewear: { file: 'Eyewear.png', kind: 'eyewear' },
        ArmorVest: { file: 'Bodyarmor.png', kind: 'armor' },
        TacticalVest: { file: 'TacticalVest.png', kind: 'rig' },
        Earpiece: { file: 'Earpiece.png', rect: [13, 11, 99, 103] },
        ArmBand: { file: 'ArmBand.png', rect: [22.5, -3, 80, 50] },
        FirstPrimaryWeapon: { file: 'On_belt.png', rect: [27, -1.5, 256, 128] },
        SecondPrimaryWeapon: { file: 'On_belt.png', rect: [27, -1.5, 256, 128] },
        Holster: { file: 'Holster.png', rect: [-1.5, -1.5, 128, 128] },
        Scabbard: { file: 'Scabbard.png', rect: [-1, 42.5, 127, 40] },
        Backpack: { file: 'Backpack.png', rect: [-1.5, -1.5, 128, 128] },
        SecuredContainer: { file: 'SecuredContainer.png', rect: [-1.5, -1.5, 128, 128] },
    };
    const PLATE_SPOTS = { front_plate: 'front', back_plate: 'back', left_side_plate: 'left', right_side_plate: 'right' };
    // Helmet attachments around the helmet, by how many it has (armor-sim.js ATTACHMENT_SPOTS)
    const ATTACHMENT_SPOTS = {
        1: ['left'], 2: ['left', 'right'], 3: ['left-top', 'right', 'left-bottom'],
        4: ['left-top', 'right-top', 'left-bottom', 'right-bottom'],
    };
    // The game's inventory tints behind a slot's icon (armor-sim.js SLOT_COLORS)
    const SLOT_COLORS = {
        blue: 'rgba(28, 65, 86, 0.302)', yellow: 'rgba(104, 102, 40, 0.302)', green: 'rgba(21, 45, 0, 0.302)',
        red: 'rgba(109, 36, 24, 0.302)', black: 'rgba(0, 0, 0, 0.302)', grey: 'rgba(29, 29, 29, 0.302)',
        violet: 'rgba(76, 42, 85, 0.302)', orange: 'rgba(60, 25, 0, 0.302)', default: 'rgba(127, 127, 127, 0.302)',
    };

    function place(x, y, w, h) {
        return `left:${x * 100 / BOARD_W}%;top:${y * 100 / BOARD_H}%;width:${w * 100 / BOARD_W}%;height:${h * 100 / BOARD_H}%`;
    }

    // Where an insert sits around its parent at (x, y) (armor-sim.js _insertSpot)
    function insertSpot(spot, x, y) {
        const left = x - INSERT_GAP - INSERT;
        const right = x + SLOT + INSERT_GAP;
        const middle = y + (SLOT - INSERT) / 2;
        const centre = x + (SLOT - INSERT) / 2;
        switch (spot) {
            case 'back': return [centre, y - 44 - INSERT_GAP - INSERT];
            case 'front': return [centre, y + SLOT + 22 + INSERT_GAP];
            case 'left': return [left, middle];
            case 'right': return [right, middle];
            case 'left-top': return [left, y + 4];
            case 'left-bottom': return [left, y + SLOT - 4 - INSERT];
            case 'right-top': return [right, y + 4];
            case 'right-bottom': return [right, y + SLOT - 4 - INSERT];
            default: return [right, middle];
        }
    }

    // One slot, as armor-sim.js _slotHtml draws it: a header bar over a body with the slot art
    // until something is in it, then the tint, the icon, the short name and the class badge
    function boardSlot(slot, label, node, x, y, w, h, insert) {
        const tile = el('div', 'bw-slot' + (insert ? ' bw-slot-insert' : '') + (node ? ' is-equipped' : ''));
        tile.setAttribute('style', place(x, y, w, h));
        tile.title = insert ? `${label}${node ? ': ' + itemName(node) : ''}` : node ? itemName(node) : label;
        const header = el('div', 'bw-slot-header', label);
        if (w !== SLOT || h !== SLOT) {
            // The workbench's header (131 by 20, 22 above) is in percent of a 125 px slot
            header.style.left = `${-3 * 100 / w}%`;
            header.style.width = `${(w + 6) * 100 / w}%`;
            header.style.top = `${-22 * 100 / h}%`;
            header.style.height = `${20 * 100 / h}%`;
        }
        tile.appendChild(header);
        const body = el('div', 'bw-slot-body');
        if (node) {
            const color = el('span', 'bw-slot-color');
            color.style.background = SLOT_COLORS[node.bg] || SLOT_COLORS.default;
            body.appendChild(color);
            const picture = node.render || node.image || node.icon;
            if (picture) body.appendChild(img(picture, 'bw-slot-icon'));
            body.appendChild(shortHtml(el('span', 'bw-slot-short'), shortName(node)));
            if (node.armor_class >= 1 && node.armor_class <= 6) {
                const cls = img(`${ART}armor_class_${node.armor_class}.png`, 'bw-armor-class');
                cls.alt = String(node.armor_class);
                body.appendChild(cls);
            }
        } else if (SLOT_ART[slot]) {
            const art = SLOT_ART[slot];
            const pic = img(ART + art.file, 'bw-slot-art' + (art.kind ? ' bw-art-' + art.kind : ''));
            if (art.rect) {
                const [ax, ay, aw, ah] = art.rect;
                pic.style.left = `${ax * 100 / w}%`;
                pic.style.top = `${ay * 100 / h}%`;
                pic.style.width = `${aw * 100 / w}%`;
                pic.style.height = `${ah * 100 / h}%`;
            }
            body.appendChild(pic);
        }
        tile.appendChild(body);
        return tile;
    }

    function renderBoard(data) {
        const bySlot = new Map((data.slots || []).map(s => [s.slot, s]));
        const board = $('atlas-lookup-board');
        board.replaceChildren();
        for (const spot of GEAR_LAYOUT) {
            const node = bySlot.get(spot.slot) || null;
            const w = spot.w || SLOT;
            const h = spot.h || SLOT;
            board.appendChild(boardSlot(spot.slot, slotLabel(spot.slot), node, spot.x, spot.y, w, h, false));
            if (!node) continue;
            if (spot.slot === 'Headwear') {
                // Attachments (mod_ slots), not the helmet's built-in armor sections
                const parts = (node.children || []).filter(c => c.slot.startsWith('mod_')).slice(0, 4);
                const spots = ATTACHMENT_SPOTS[parts.length] || [];
                parts.forEach((part, i) => {
                    const [ix, iy] = insertSpot(spots[i], spot.x, spot.y);
                    board.appendChild(boardSlot(part.slot, slotLabel('attachment'), part, ix, iy, INSERT, INSERT, true));
                });
            } else if (spot.slot === 'ArmorVest' || spot.slot === 'TacticalVest') {
                for (const child of node.children || []) {
                    const where = PLATE_SPOTS[child.slot.toLowerCase()];
                    if (!where) continue;
                    const [ix, iy] = insertSpot(where, spot.x, spot.y);
                    board.appendChild(boardSlot(child.slot, slotLabel(child.slot.toLowerCase()), child, ix, iy, INSERT, INSERT, true));
                }
            }
        }
    }

    /* ===========================
       PAGE
    =========================== */

    function renderResult(data) {
        renderHeader(data);
        const bySlot = new Map((data.slots || []).map(s => [s.slot, s]));
        const weapons = $('atlas-lookup-weapons');
        weapons.replaceChildren();
        const equipped = WEAPON_SLOTS.filter(s => bySlot.has(s));
        $('atlas-lookup-weapons-wrap').hidden = !equipped.length;
        for (const slot of equipped) weapons.appendChild(weaponCard(bySlot.get(slot)));
        renderBoard(data);
        $('atlas-lookup-nothing').hidden = bySlot.size > 0;
        $('atlas-lookup-result').hidden = false;
    }

    function showStatus(text, isError) {
        const status = $('atlas-lookup-status');
        status.textContent = text;
        status.classList.toggle('error', !!isError);
        status.hidden = !text;
    }

    /* ===========================
       LOOKUP
    =========================== */

    // Digits are an account ID; anything else that could be a nickname is searched first.
    function queryKind(text) {
        if (/^[0-9]{1,12}$/.test(text)) return 'account';
        if (/^[A-Za-z0-9_.-]{3,15}$/.test(text)) return 'nickname';
        return null;
    }

    // {ok, status, body}, with the admin key the Atlas page stored, if any.
    async function getJSON(path) {
        const headers = {};
        const key = readStorage(KEY_STORAGE);
        if (key && !key.startsWith('atl_')) headers['X-Admin-Key'] = key;
        try {
            const res = await fetch(`${EFTForge.config?.API_BASE || ''}${path}`, { headers });
            return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
        } catch {
            return { ok: false, status: 0, body: null };
        }
    }

    function showError(res) {
        const detail = res.body && res.body.detail;
        showStatus(errorText(res.status, detail && detail.error), true);
        $('atlas-lookup-key').hidden = res.status !== 403;
    }

    function showChoices(players) {
        const list = $('atlas-lookup-choices');
        list.replaceChildren();
        for (const p of players) {
            const btn = document.createElement('button');
            btn.className = 'modal-btn atlas-lookup-choice';
            btn.type = 'button';
            btn.textContent = `${p.nickname} · ${p.side || '-'} · ${t('level')} ${p.level ?? '-'}`;
            btn.addEventListener('click', () => view(p.accountId));
            list.appendChild(btn);
        }
        list.hidden = !players.length;
    }

    async function run(fn) {
        const go = /** @type {HTMLButtonElement} */ ($('atlas-lookup-go'));
        go.disabled = true;
        try { await fn(); } finally { go.disabled = false; }
    }

    function view(accountId) {
        return run(async () => {
            $('atlas-lookup-result').hidden = true;
            $('atlas-lookup-choices').hidden = true;
            showStatus(t('loading'), false);
            const res = await getJSON(`${API}?accountId=${encodeURIComponent(accountId)}`);
            if (!res.ok) { showError(res); return; }
            $('atlas-lookup-key').hidden = true;
            showStatus('', false);
            _last = res.body;
            _gridOpen.clear();
            renderResult(res.body);
        });
    }

    async function lookup(text) {
        const kind = queryKind(text);
        if (!kind) {
            showStatus(t('errBad'), true);
            return;
        }
        writeStorage(LAST_STORAGE, text);
        if (kind === 'account') {
            await view(text);
            return;
        }
        let players = null;
        await run(async () => {
            $('atlas-lookup-result').hidden = true;
            $('atlas-lookup-choices').hidden = true;
            showStatus(t('loading'), false);
            const res = await getJSON(`${API}/search?nickname=${encodeURIComponent(text)}`);
            if (!res.ok) { showError(res); return; }
            $('atlas-lookup-key').hidden = true;
            players = (res.body && res.body.players) || [];
        });
        if (!players) return;
        for (const p of players) _levels.set(String(p.accountId), p.level);
        if (!players.length) { showStatus(t('errNoMatch'), true); return; }
        if (players.length === 1) { await view(players[0].accountId); return; }
        const found = /** @type {(n: number) => string} */ (t('found'));
        showStatus(found(players.length), false);
        showChoices(players);
    }

    /* ===========================
       LANGUAGE, INIT
    =========================== */

    function applyLanguage() {
        EFTForge.state.lang = _lang;   // lang.js (tSlot) and api.js read it from here
        document.documentElement.lang = _lang === 'zh' ? 'zh-CN' : 'en';
        document.title = t('pageTitle');
        document.querySelectorAll('[data-atlas-text]').forEach(node => {
            node.textContent = t(node.getAttribute('data-atlas-text'));
        });
        $('atlas-lookup-account').placeholder = t('query');
        $('atlas-lookup-key-input').placeholder = t('keyPrompt');
        if (_last) renderResult(_last);
    }

    function init() {
        _lang = readStorage(LANG_STORAGE) === 'zh' ? 'zh' : 'en';
        const select = /** @type {HTMLSelectElement} */ ($('lang-select'));
        select.value = _lang;
        select.addEventListener('change', () => {
            _lang = select.value === 'zh' ? 'zh' : 'en';
            writeStorage(LANG_STORAGE, _lang);
            applyLanguage();
        });
        const input = /** @type {HTMLInputElement} */ ($('atlas-lookup-account'));
        input.value = readStorage(LAST_STORAGE) || '';
        $('atlas-lookup-form').addEventListener('submit', e => {
            e.preventDefault();
            lookup(input.value.trim());
        });
        $('atlas-lookup-key-save').addEventListener('click', () => {
            const keyInput = /** @type {HTMLInputElement} */ ($('atlas-lookup-key-input'));
            const key = keyInput.value.trim();
            if (!key) return;
            writeStorage(KEY_STORAGE, key);
            keyInput.value = '';
            lookup(input.value.trim());
        });
        applyLanguage();
    }

    return {
        init,
        // pure helpers, for frontend/tests/atlas-lookup.test.js
        _test: {
            itemName, shortName, slotLabel, partLabel, errorText, queryKind, builderLink, builderTree,
            levelBadge, prestigeIcon, counter, sideStats, insertSpot,
        },
    };
})();

// After the scripts below it have loaded, so the attachment grid is there for a profile
// opened straight away from the remembered query
if (typeof document !== 'undefined' && document.getElementById('atlas-lookup-app')) {
    document.addEventListener('DOMContentLoaded', () => window.EFTForge.atlasLookup.init());
}
