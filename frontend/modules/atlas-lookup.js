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
     game (assets/images/atlas-lookup/endings), league rank, edition and season progress,
     and the overall stats;
   - the gear: the Ballistics Workbench's loadout board (.bw-slot over the PMC), laid out
     like the game's gear panel (TarkTetris theme.js GEAR_SLOTS) with the plates and helmet
     attachments around their parent as the workbench places them (armor-sim.js);
   - below it, the weapon clicked on the board (the primary first): the builder's
     attachment grid itself (attachment-grid.js: collectAllVisibleSlots,
     computeGridPositions, _buildGridDOM), read only, with a link into the builder;
   - under both: seasonal modifiers, achievements (tarkov.dev's icons), skills, weapon
     mastering and favourite items, the tables sortable by any column.
   What's inside a player's rig, backpack and pouch never shows: the game only shares it
   with friends of the account the lookups come from.
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

    // Opened below the board when a profile comes in: the first of these the player carries
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
            openWeapon:'Click to see the build',
            gear:      'Gear',
            stats:     'Overall',
            pmc:       'PMC',
            scav:      'Scav',
            openBuilder:'Open in EFTForge',
            partial:   'Some parts aren\'t in EFTForge\'s data yet and are left out of the builder.',
            gridFailed:'The attachment grid couldn\'t be loaded.',
            nothing:   'Nothing equipped.',
            close:     'Close',
            league:    'League',
            best:      'best',
            edition:   'Edition',
            displayed: 'Displayed edition',
            battlePass:'Battle pass',
            seasonal:  'Seasonal rewards',
            modifiers: 'Seasonal modifiers',
            globalMods:'Global',
            bonuses:   'Bonuses',
            drawbacks: 'Drawbacks',
            points:    n => `${n > 0 ? '+' : ''}${n} points`,
            noneSelected:'None selected.',
            achName:   'Name',
            achDesc:   'Description',
            achPlayers:'Players',
            achDone:   'Completed',
            achRarity: 'Rarity',
            noAchievements:'No achievements yet.',
            skills:    'Skills',
            skill:     'Skill',
            skillLevel:'Level',
            lastUsed:  'Last leveled',
            mastering: 'Weapon mastering',
            weapon:    'Weapon',
            progress:  'Progress',
            kills:     'Kills',
            favorites: 'Favourite items',
            killedBy:  'Killed by',
            with:      'with',
            rarity: { Common: 'Common', Rare: 'Rare', Legendary: 'Legendary', Seasonal: 'Seasonal' },
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
                kills: 'Kills', pmcKills: 'PMC kills', aiKills: 'AI kills', online: 'Online', runs: 'Run-throughs', transits: 'Transits',
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
            openWeapon:'点击查看改装',
            gear:      '装备',
            stats:     '总览',
            pmc:       'PMC',
            scav:      'Scav',
            openBuilder:'在 EFTForge 中打开',
            partial:   '部分配件尚未收录于 EFTForge 数据，已在改枪器中省略。',
            gridFailed:'无法加载配件网格。',
            nothing:   '没有装备。',
            close:     '关闭',
            league:    '联赛',
            best:      '最高',
            edition:   '版本',
            displayed: '展示版本',
            battlePass:'通行证',
            seasonal:  '赛季奖励',
            modifiers: '赛季修正',
            globalMods:'全局',
            bonuses:   '增益',
            drawbacks: '减益',
            points:    n => `${n > 0 ? '+' : ''}${n} 点`,
            noneSelected:'未选择。',
            achName:   '名称',
            achDesc:   '描述',
            achPlayers:'玩家',
            achDone:   '完成时间',
            achRarity: '稀有度',
            noAchievements:'尚无成就。',
            skills:    '技能',
            skill:     '技能',
            skillLevel:'等级',
            lastUsed:  '最后提升',
            mastering: '武器精通',
            weapon:    '武器',
            progress:  '进度',
            kills:     '击杀',
            favorites: '收藏物品',
            killedBy:  '击杀者',
            with:      '使用',
            rarity: { Common: '普通', Rare: '稀有', Legendary: '传奇', Seasonal: '赛季' },
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
                kills: '击杀', pmcKills: 'PMC 击杀', aiKills: 'AI 击杀', online: '在线时长', runs: '跑刀', transits: '转移',
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
    let _open = null;              // the board slot whose weapon is shown below the board
    const _sort = {};              // table key -> {col, dir}, kept across redraws

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

    // tarkov.dev's icon for an achievement
    function achievementIcon(id) {
        return /^[0-9a-f]{24}$/.test(String(id)) ? `https://assets.tarkov.dev/achievement-${id}-icon.webp` : null;
    }

    // The page's language out of {en, ch}, falling back to English
    function loc(pair) {
        if (!pair) return '';
        return (_lang === 'zh' ? pair.ch : pair.en) || pair.en || '';
    }

    function unixTime(seconds) {
        return typeof seconds === 'number' && seconds > 0 ? formatTime(seconds * 1000) : '-';
    }

    // The game's editions among an account's member category bits
    /** @type {Array<[number, string]>} */
    const EDITION_BITS = [[2, 'EOD'], [1024, 'Unheard'], [256, 'Sherpa'], [512, 'Emissary'], [1, 'Developer']];

    function editions(category) {
        if (typeof category !== 'number') return [];
        return EDITION_BITS.filter(([bit]) => (category & bit) !== 0).map(([, name]) => name);
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
            ['aiKills', Math.max(0, counter(side, 'Kills') - pmcKills).toLocaleString()],
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
        const league = data.league;
        if (league) {
            const name = loc(league.name) || String(league.rank);
            const best = league.max && league.max !== league.rank ? ` (${t('best')}: ${loc(league.maxName) || league.max})` : '';
            fact(t('league'), name + best);
        }
        const owned = editions(data.memberCategory);
        if (owned.length) fact(t('edition'), owned.join(', '));
        const shown = editions(data.selectedMemberCategory);
        if (shown.length) fact(t('displayed'), shown.join(', '));
        const progress = (key, p) => { if (p && p.total) fact(t(key), `${p.completed} / ${p.total}`); };
        progress('battlePass', data.battlePass);
        progress('seasonal', data.seasonalRewards);
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
       WEAPONS: the builder's attachment grid
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

    // A weapon opened from the board or from a container: the builder's attachment grid for
    // it, with a link into the builder
    function weaponCard(node) {
        const card = el('section', 'atlas-lookup-weapon');
        const link = builderLink(node.build);
        if (link) {
            const head = el('div', 'atlas-lookup-card-head');
            const open = /** @type {HTMLAnchorElement} */ (el('a', 'modal-btn primary atlas-lookup-open', t('openBuilder')));
            open.href = link;
            open.target = '_blank';
            open.rel = 'noopener';
            if (node.build && !node.build.complete) open.title = t('partial');
            head.appendChild(open);
            card.appendChild(head);
        }
        const grid = el('div', 'atlas-lookup-grid');
        card.appendChild(grid);
        showGrid(node, grid).catch(err => {
            console.warn('[atlas-lookup] attachment grid:', err);
            grid.replaceChildren(el('div', 'atlas-empty error', t('gridFailed')));
        });
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
            const tile = boardSlot(spot.slot, slotLabel(spot.slot), node, spot.x, spot.y, w, h, false);
            board.appendChild(tile);
            if (!node) continue;
            if (openable(node)) {
                const open = _open === spot.slot;
                expandable(tile, node, open, () => {
                    _open = open ? null : spot.slot;
                    renderBoard(data);
                    if (_open) $('atlas-lookup-contents').scrollIntoView({ block: 'nearest' });
                });
            }
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
        renderContents(data);
    }

    /* ===========================
       THE OPEN WEAPON: below the board
    =========================== */

    // The weapon shown first: the primary, else the one on the back, else the pistol
    function firstOpen(slots) {
        return WEAPON_SLOTS.find(s => openable((slots || []).find(n => n.slot === s))) || null;
    }

    // Only weapons open below the board (their build)
    function openable(node) {
        return !!node && !!node.build;
    }

    // Let a tile open its weapon, by click or by Enter or Space
    function expandable(tile, node, open, onOpen) {
        tile.classList.add('is-expandable');
        if (open) tile.classList.add('active-slot');
        tile.tabIndex = 0;
        tile.setAttribute('role', 'button');
        tile.setAttribute('aria-expanded', String(open));
        tile.title = `${itemName(node)}\n${t('openWeapon')}`;
        tile.addEventListener('click', onOpen);
        tile.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
        });
    }

    function renderContents(data) {
        const panel = $('atlas-lookup-contents');
        panel.replaceChildren();
        const shown = _open && (data.slots || []).find(s => s.slot === _open);
        panel.hidden = !openable(shown);
        if (!openable(shown)) { _open = null; return; }

        const head = el('div', 'atlas-lookup-contents-head');
        head.appendChild(el('span', 'atlas-lookup-crumb current', `${slotLabel(shown.slot)}: ${itemName(shown)}`));
        const close = el('button', 'atlas-lookup-contents-close', t('close'));
        close.type = 'button';
        close.addEventListener('click', () => { _open = null; renderBoard(data); });
        head.appendChild(close);
        panel.appendChild(head);
        panel.appendChild(weaponCard(shown));
    }

    /* ===========================
       PROFILE SECTIONS: seasonal modifiers, achievements, skills, mastering, favourites
    =========================== */

    function section(title, count) {
        const box = el('section', 'stats-section atlas-lookup-section');
        const head = el('div', 'section-title', title);
        if (count) head.appendChild(el('span', 'atlas-lookup-section-count', count));
        box.appendChild(head);
        return box;
    }

    // Rows in a column's order: numbers and strings each their own way, blanks last either way
    function sortRows(rows, value, dir) {
        return rows.map((row, i) => ({ row, i, v: value(row) }))
            .sort((a, b) => {
                const blankA = a.v === null || a.v === undefined || a.v === '';
                const blankB = b.v === null || b.v === undefined || b.v === '';
                if (blankA || blankB) return blankA === blankB ? a.i - b.i : blankA ? 1 : -1;
                const c = typeof a.v === 'number' && typeof b.v === 'number'
                    ? a.v - b.v : String(a.v).localeCompare(String(b.v), _lang === 'zh' ? 'zh-CN' : 'en');
                return c * dir || a.i - b.i;
            })
            .map(x => x.row);
    }

    // A table sortable by any column. columns: [{label, value(row), cell(row) -> Node|string,
    // className, desc (first click sorts high to low)}]; the order stays in _sort[key].
    function sortableTable(key, columns, rows, initial) {
        const table = el('table', 'atlas-lookup-table');
        const head = el('tr');
        const body = el('tbody');
        const draw = () => {
            const { col, dir } = _sort[key] || initial;
            head.querySelectorAll('th').forEach((th, i) => {
                th.setAttribute('aria-sort', i === col ? (dir > 0 ? 'ascending' : 'descending') : 'none');
            });
            body.replaceChildren();
            for (const row of sortRows(rows, columns[col].value, dir)) {
                const tr = el('tr');
                for (const c of columns) {
                    const td = el('td', c.className || '');
                    const content = c.cell(row);
                    if (content instanceof Node) td.appendChild(content);
                    else td.textContent = content;
                    tr.appendChild(td);
                }
                body.appendChild(tr);
            }
        };
        columns.forEach((c, i) => {
            const th = el('th', c.className || '');
            const btn = el('button', 'atlas-lookup-sort', c.label);
            btn.type = 'button';
            btn.addEventListener('click', () => {
                const now = _sort[key] || initial;
                _sort[key] = { col: i, dir: now.col === i ? -now.dir : (c.desc ? -1 : 1) };
                draw();
            });
            th.appendChild(btn);
            head.appendChild(th);
        });
        const thead = el('thead');
        thead.appendChild(head);
        table.appendChild(thead);
        table.appendChild(body);
        draw();
        const wrap = el('div', 'atlas-lookup-table-wrap');
        wrap.appendChild(table);
        return wrap;
    }

    // An icon and a label in one table cell
    function iconCell(src, text, title) {
        const cell = el('span', 'atlas-lookup-iconcell');
        if (src) cell.appendChild(img(src, 'atlas-lookup-cellicon'));
        cell.appendChild(el('span', '', text));
        if (title) cell.title = title;
        return cell;
    }

    function perkChip(perk, kind) {
        const chip = el('span', 'atlas-lookup-perk ' + kind, loc({ en: perk.en?.name, ch: perk.ch?.name }) || perk.id);
        if (typeof perk.points === 'number' && perk.points) {
            const fmt = /** @type {(n: number) => string} */ (t('points'));
            chip.appendChild(el('span', 'atlas-lookup-perk-points', fmt(perk.points)));
        }
        chip.title = loc({ en: perk.en?.description, ch: perk.ch?.description }).replace(/\s*\n\s*/g, '\n');
        return chip;
    }

    // The season's global modifiers, then the player's own: bonuses cost points (below 0),
    // drawbacks earn them (above 0)
    function modifiersSection(perks) {
        const box = section(t('modifiers'));
        const row = (label, list, kind) => {
            const line = el('div', 'atlas-lookup-perk-row ' + kind);
            line.appendChild(el('div', 'atlas-lookup-perk-label', label));
            const chips = el('div', 'atlas-lookup-perk-chips');
            if (!list.length) chips.appendChild(el('span', 'atlas-lookup-muted', t('noneSelected')));
            for (const p of list) chips.appendChild(perkChip(p, kind));
            line.appendChild(chips);
            box.appendChild(line);
        };
        const own = perks.personal || [];
        row(t('globalMods'), perks.common || [], 'global');
        row(t('bonuses'), own.filter(p => (p.points || 0) <= 0), 'bonus');
        row(t('drawbacks'), own.filter(p => (p.points || 0) > 0), 'drawback');
        return box;
    }

    function achievementsSection(ach) {
        const done = ach.done || [];
        const box = section(t('achievements'), ach.total ? `${done.length} / ${ach.total}` : String(done.length));
        if (!done.length) {
            box.appendChild(el('div', 'atlas-empty', t('noAchievements')));
            return box;
        }
        const rarities = /** @type {Record<string, string>} */ (t('rarity'));
        const name = a => loc({ en: a.en?.name, ch: a.ch?.name }) || a.id;
        box.appendChild(sortableTable('achievements', [
            { label: t('achName'), value: name, cell: a => iconCell(achievementIcon(a.id), name(a)) },
            { label: t('achDesc'), value: a => loc({ en: a.en?.description, ch: a.ch?.description }),
                cell: a => loc({ en: a.en?.description, ch: a.ch?.description }), className: 'atlas-lookup-desc' },
            { label: t('achPlayers'), value: a => a.percent, cell: a => (typeof a.percent === 'number' ? `${a.percent}%` : '-'),
                className: 'num' },
            { label: t('achDone'), value: a => a.at, cell: a => unixTime(a.at), className: 'num', desc: true },
            { label: t('achRarity'), value: a => ['Common', 'Rare', 'Legendary', 'Seasonal'].indexOf(a.rarity),
                cell: a => el('span', 'atlas-lookup-rarity ' + String(a.rarity || '').toLowerCase(), rarities[a.rarity] || a.rarity || '-'),
                desc: true },
        ], done, { col: 3, dir: -1 }));
        return box;
    }

    // Skill levels are progress / 100; 51 is elite
    function skillLevel(progress) {
        return Math.floor((progress || 0)) / 100;
    }

    function skillsSection(skills) {
        const common = skills.common || [];
        const box = section(t('skills'));
        box.appendChild(sortableTable('skills', [
            { label: t('skill'), value: s => loc(s.name) || s.id, cell: s => loc(s.name) || s.id },
            { label: t('skillLevel'), value: s => s.progress, desc: true, className: 'num',
                cell: s => el('span', skillLevel(s.progress) >= 51 ? 'atlas-lookup-elite' : '', skillLevel(s.progress).toFixed(2)) },
            { label: t('lastUsed'), value: s => s.lastAccess, cell: s => unixTime(s.lastAccess), className: 'num', desc: true },
        ], common, { col: 1, dir: -1 }));
        return box;
    }

    function masteringName(m) {
        const w = m.weapon;
        if (!w) return m.id;
        const { mine, other } = names(w);
        return mine.short || other.short || mine.name || other.name || m.id;
    }

    function masteringSection(skills) {
        const list = skills.mastering || [];
        const box = section(t('mastering'));
        box.appendChild(sortableTable('mastering', [
            { label: t('weapon'), value: masteringName,
                cell: m => iconCell(m.weapon && m.weapon.icon, masteringName(m), m.weapon ? itemName(m.weapon) : m.id) },
            { label: t('progress'), value: m => m.progress, cell: m => Math.floor(m.progress || 0).toLocaleString(), className: 'num', desc: true },
            { label: t('kills'), value: m => m.kills, cell: m => (m.kills || 0).toLocaleString(), className: 'num', desc: true },
        ], list, { col: 1, dir: -1 }));
        return box;
    }

    // A favourite: its picture and name, a dogtag's face, a weapon's link into the builder
    function favoriteCard(node) {
        const card = el('div', 'atlas-lookup-fav');
        const pic = el('div', 'atlas-lookup-fav-pic');
        pic.style.background = SLOT_COLORS[node.bg] || SLOT_COLORS.default;
        const picture = node.render || node.image || node.icon;
        if (picture) pic.appendChild(img(picture, 'atlas-lookup-fav-img'));
        card.appendChild(pic);
        const text = el('div', 'atlas-lookup-fav-text');
        text.appendChild(el('div', 'atlas-lookup-fav-name', itemName(node)));
        const tag = node.dogtag;
        if (tag) {
            const line = [
                `${tag.nickname}${tag.level ? ` (${t('level')} ${tag.level})` : ''}`,
                tag.killer ? `${t('killedBy')} ${tag.killer}` : '',
                tag.weapon && loc(tag.weapon) ? `${t('with')} ${loc(tag.weapon)}` : '',
            ].filter(Boolean).join(' · ');
            text.appendChild(el('div', 'atlas-lookup-fav-tag', line));
            if (tag.time) text.appendChild(el('div', 'atlas-lookup-muted', formatTime(tag.time)));
        }
        const link = builderLink(node.build);
        if (link) {
            const open = /** @type {HTMLAnchorElement} */ (el('a', 'modal-btn primary atlas-lookup-open', t('openBuilder')));
            open.href = link;
            open.target = '_blank';
            open.rel = 'noopener';
            if (!node.build.complete) open.title = t('partial');
            text.appendChild(open);
        }
        card.appendChild(text);
        return card;
    }

    function favoritesSection(favorites) {
        const box = section(t('favorites'), String(favorites.length));
        const list = el('div', 'atlas-lookup-favs');
        for (const f of favorites) list.appendChild(favoriteCard(f));
        box.appendChild(list);
        return box;
    }

    function renderSections(data) {
        const host = $('atlas-lookup-sections');
        host.replaceChildren();
        const perks = data.perks || {};
        if ((perks.common || []).length || (perks.personal || []).length) host.appendChild(modifiersSection(perks));
        if ((data.favorites || []).length) host.appendChild(favoritesSection(data.favorites));
        if (data.achievements && Array.isArray(data.achievements.done)) host.appendChild(achievementsSection(data.achievements));
        const skills = data.skills || {};
        const tables = el('div', 'atlas-lookup-pair');
        if ((skills.common || []).length) tables.appendChild(skillsSection(skills));
        if ((skills.mastering || []).length) tables.appendChild(masteringSection(skills));
        if (tables.childElementCount) host.appendChild(tables);
    }

    /* ===========================
       PAGE
    =========================== */

    function renderResult(data) {
        renderHeader(data);
        const bySlot = new Map((data.slots || []).map(s => [s.slot, s]));
        renderBoard(data);
        renderSections(data);
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
            _open = firstOpen(res.body.slots);
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
        /** @type {HTMLInputElement} */ ($('atlas-lookup-account')).placeholder = t('query');
        /** @type {HTMLInputElement} */ ($('atlas-lookup-key-input')).placeholder = t('keyPrompt');
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
            levelBadge, prestigeIcon, achievementIcon, counter, sideStats, insertSpot,
            openable, firstOpen, editions, sortRows, skillLevel, masteringName,
        },
    };
})();

// After the scripts below it have loaded, so the attachment grid is there for a profile
// opened straight away from the remembered query
if (typeof document !== 'undefined' && document.getElementById('atlas-lookup-app')) {
    document.addEventListener('DOMContentLoaded', () => window.EFTForge.atlasLookup.init());
}
