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
   Standalone page at /atlas/players, linked from every Atlas page's header (Players). Takes a nickname (found
   with /atlas/api/lookup/search) or an account ID and shows what the game's profile screen
   shows of that player, from /atlas/api/lookup, which gets it from Atlas' upstream provider; the backend adds pictures,
   Kitbash! drawings, armor classes and each weapon's builder payload.

   The result is one page in Atlas' look, laid out in the game's 1920 px coordinates (from
   UI dumps of the game) with the game's art (assets/images/atlas-lookup) and scaled to the
   page, a section after another:
   - the other player profile window as the live game draws it: the character panel
     (level, side, ending, prestige, league badge, the loadout board where the game draws
     the model, nickname, experience, battle pass), the EFT dashboard, then rare
     achievements (tarkov.dev's icons), favorite weapons and items, and the selected
     modifiers. The board is the Ballistics
     Workbench's loadout slots (.bw-slot), laid out like the game's gear panel (TarkTetris
     theme.js GEAR_SLOTS) with plates and helmet attachments around their parent as the
     workbench places them (armor-sim.js);
   - statistics: every counter, for the PMC and the Scav together and apart;
   - a weapon clicked on the board pops out beside it as the builder's own attachment grid
     (attachment-grid.js: collectAllVisibleSlots, computeGridPositions, _buildGridDOM),
     read only, with a link into the builder, as EFTForge's advanced stats popover does;
   - skills and achievements: the level and experience bar across, the skills (as the
     character screen's tab draws them) on the left, the achievements on the right as a
     compact table sortable by any column.
   Under the board, a row has what the game's window doesn't show (account ID, highest league
   rank, editions owned and displayed, last active, lookup time).
   What's inside a player's rig, backpack and pouch never shows: the game only shares it
   with friends of the account the lookups come from.
   Admin only (lookups stay within the upstream provider's limits), with the same stored key as the
   Atlas page. Data goes into the page through textContent or element properties; the only
   markup is utils.js shortNameHtml and the hover cards (data-tooltip-html), both escaped first.
============================================================ */

window.EFTForge.atlasLookup = (function () {

    const API = '/atlas/api/lookup';
    const LANG_STORAGE = 'eftforge_lang';       // shared with the rest of the site
    const KEY_STORAGE  = 'eftforge_atlas_key';  // shared with the Atlas page
    const LAST_STORAGE = 'eftforge_atlas_lookup_last';
    const ART = '/assets/images/ballistics-loadout/';
    const ENDING_ART = '/assets/images/atlas-lookup/endings/';
    // Skill and seasonal modifier icons come straight from tarkov.dev, sparing our bandwidth
    const TARKOV_DEV_ART = 'https://assets.tarkov.dev/';
    // The game's icons for the dashboard's first line, and for the editions
    const STAT_ART = '/assets/images/atlas-lookup/stats/';
    // Arena's own art: its stat and level bar icons, level badges, edition icons, battle pass
    const ARENA_ART = '/assets/images/atlas-lookup/arena/';
    const EDITION_ART = '/assets/images/atlas-lookup/editions/';
    const LEAGUE_ART = '/assets/images/atlas-lookup/leagues/';   // <rank>.webp


    const STRINGS = {
        en: {
            pageTitle: 'Atlas - Player Lookup (test)',
            returnTo:  'Return to',
            tzLabel:   'Time zone',
            tzLocal:   'Local',
            title:     'Player lookup',
            badge:     'TEST',
            note:      'What a player\'s profile shows in the game mode picked above, gear included, by nickname or account ID. Lookups come from Atlas\' upstream provider; they\'re paced, and repeats within a minute come from cache.',
            query:     'Nickname or account ID',
            lookup:    'Look up',
            keyPrompt: 'Admin key',
            saveKey:   'Save key',
            loading:   'Looking up...',
            found:     n => `${n} players found. Pick one:`,
            level:     'Level',
            levelColon:'Level:',
            prestige:  'PRESTIGE',
            ending:    'ENDING',
            accountId: 'Account ID',
            leagueBest:'Highest rank',
            when:      'Looked up',
            lastActive:'Last active',
            cached:    'cached',
            edition:   'Edition',
            seasonal:  'Seasonal rewards',
            tabs:      { overall: 'OVERALL', gear: 'GEAR', skills: 'SKILLS', achievements: 'ACHIEVEMENTS' },
            modes:     { pve: 'PVE', pvp: 'PVP', season: 'PVP S', arena: 'ARENA' },
            statistics:'STATISTICS',
            statViews: { overall: 'OVERALL', pmc: 'PMC', scav: 'SCAV' },
            statRows: {
                raids: 'Raids', survived: 'Survived', rate: 'Survival rate', kd: 'K/D', totalKd: 'K/D (all kills)', pmcKills: 'Kills (players)',
                aiKills: 'Kills (AI)', kia: 'KIA', mia: 'Missing in action', awol: 'AWOL',
                runs: 'Run-throughs', transits: 'Transits', leave: 'Leave rate', streak: 'Survived in a row', online: 'Online',
            },
            lastUsed:  'last leveled',
            achRarity: 'Rarity',
            skillShow: 'Show:',
            skillSort: 'Sort:',
            skillTypes:{ all: 'All types', physical: 'Physical', mental: 'Mental', combat: 'Combat', practical: 'Practical' },
            skillSorts:{ default: 'Default', level: 'Most leveled', recent: 'Most recent' },
            noSkills:  'No skills of this type.',
            skillsAndAchievements: 'SKILLS & ACHIEVEMENTS',
            achName:   'Achievement',
            displayed: 'Displayed edition',
            transits:  'Transits',
            aiKills:   'AI kills',
            passProgress:'PROGRESS',
            seasonLabel:n => `SEASON ${n}`,
            passName:  name => `${name} BATTLE PASS`,
            mini:      { raids: 'R: ', kills: 'K: ', leave: 'L/R: ', rate: 'S/R: ', kd: 'K/D: ', online: 'Online: ' },
            // as the game's Arena profile words them
            arenaDash: {
                victories: 'Victories', winrate: 'Win rate', kills: 'Kills', headshots: 'Headshot kills',
                deaths: 'Deaths', online: 'Online', kd: 'K/D', winStreak: 'Highest win streak',
                loseStreak: 'Highest lose streak', losses: 'Defeats', left: 'Matches quit', games: 'Matches played',
                wins: 'Victories', winRate: 'Win rate',
            },
            playerAchievements: 'Player achievements',
            arenaPass: 'Battle pass level',
            // Arena's statistics cards: the worked-out rows, then every counter the game keeps
            arenaRows: {
                registered: 'Registration date', kd: 'K/D', winRate: 'Win rate, %',
                avgKills: 'Average kills per match', headshotRate: 'Headshot kill rate, %',
            },
            arenaCounters: {
                GamesCount: 'Matches played', ArenaWins: 'Victories', ClearWinsCount: 'Flawless victories',
                ArenaLoses: 'Defeats', GamesLeft: 'Matches quit', Kills: 'Player kills', Deaths: 'Deaths',
                Assists: 'Kill assists', Headshots: 'Headshot kills', KnifeKills: 'Melee weapon kills',
                GreanadeKills: 'Grenade kills', DoubleKills: 'Double kills', OverKills: 'Overkills', Ace: 'Aces',
                KilledSavage: 'Scav kills', TeammateKills: 'Teammate kills', ViewerKills: 'Spectator kills',
                GrenadeBlinded: 'Enemies blinded', DamageDealt: 'Damage dealt', HealthRestore: 'Health restored',
                MaxGameKillsCount: 'Most kills in a match', KillsWithoutDeaths: 'Current match kill streak',
                MaxKillsWithoutDeaths: 'Highest match kill streak', LongestKillStreak: 'Longest kill streak',
                WinStreak: 'Current win streak', LongestWinStreak: 'Highest win streak',
                LoseStreak: 'Current lose streak', LongestLoseStreak: 'Highest lose streak',
                Objectives: 'Objectives', ObjectivePoints: 'Objective points', ActivatedObjectCound: 'Devices planted',
                DeactivatedObjectCound: 'Devices defused', ExplodedObjectCound: 'Devices exploded',
                RoundMvpCount: 'Round MVPs received', MatchMvpCount: 'Match MVPs received', BestArp: 'Best ARP',
                KillsExperience: 'Kill XP', HealExperience: 'Healing XP', WinExperience: 'Victory XP',
                MaxWinExperience: 'Most victory XP in a match', MoneyCollected: 'Money earned',
            },
            arenaPasses: 'Battle passes',
            passFrom: date => `Pass of ${date}`,
            prestigeMode: mode => `Prestige earned in ${mode}`,
            // the backend calls PvP "regular"
            prestigeModes: { regular: 'PvP', pve: 'PvE' },
            endingsReached: 'Endings reached',
            // each card's title, as the game's Arena profile writes them ("BlastGang statistics")
            arenaModes: {
                UnrankedOverall: 'Overall', UnrankedTeamFight: 'TeamFight', UnrankedLastHero: 'LastHero',
                UnrankedCheckPoint: 'CheckPoint', UnrankedBlastGang: 'BlastGang', UnrankedShootOutDuo: 'ShootOut',
            },
            modeStats: name => `${name} statistics`,
            registered:'Registered',
            dash: {
                raids: '(R) Raids', survived: '(S) Survived', kia: 'KIA', mia: 'Missing In Action (MIA)', awol: '(L) AWOL',
                kills: '(K) Kills', online: 'Online', runs: '(RT) Run-throughs', rate: '(S/R) Survival rate', lifespan: 'Average life span',
                streak: 'S in a row', leave: '(L/R) Leave rate', kd: '(K/D)', lifetime: 'Account lifetime',
            },
            modifiers: 'SELECTED MODIFIERS',
            noModifiers:'Player has not selected any modifiers',
            bonuses:   'Positive (-)',
            drawbacks: 'Negative (+)',
            points:    n => `${n > 0 ? '+' : ''}${n} points`,
            noneSelected:'No modifiers selected',
            rareAchievements: 'Rare achievements',
            achievements: 'Achievements',
            achProgress: (n, total, pct) => `${n} out of ${total} achievements earned (${pct}%)`,
            earnedBy:  pct => `Achievement earned by ${pct}% players`,
            noAchievements:'No earned achievements',
            achDescription:'Achievement description',
            achPlayers:'% of all players',
            achDate:   'Collection date',
            favWeapons:'Favorite weapons',
            favorites: 'Favorite items',
            noFavWeapons:'No favorite weapons',
            noFavItems:'No favorite items',
            killedBy:  'Killed by',
            with:      'using',
            expCurrent:'current: ',
            expRemaining:'remaining: ',
            eliteLevel:'ELITE Level',
            maxed:     'maxed',
            skillClass:{ physical: 'Ph', mental: 'M', combat: 'C', practical: 'P' },
            openBuilder:'Open in EFTForge',
            partial:   'Some parts aren\'t in EFTForge\'s data yet and are left out of the builder.',
            gridFailed:'The attachment grid couldn\'t be loaded.',
            close:     'Close',
            ammoSlot:  'Magazine',
            chamberSlot:'Chamber',
            rarity: { Common: 'Common', Rare: 'Rare', Legendary: 'Legendary', Seasonal: 'Seasonal' },
            editions: { EOD: 'EOD', Unheard: 'Unheard', Sherpa: 'Sherpa', Emissary: 'Emissary', Developer: 'Developer' },
            errKey:    'This needs the admin key.',
            errBad:    'Enter a nickname (3 to 15 letters, digits, _ . -) or an account ID.',
            errNoMatch:'No player with that nickname.',
            errRate:   'Too many lookups. Try again later.',
            errSession:'Atlas\' upstream provider can\'t look players up right now. Try again later.',
            errBackend:'The game backend refused the lookup.',
            errNotFound:'No profile came back for that account.',
            errUnavailable:'Player lookup isn\'t set up here (ATLAS_LOOKUP_URL), or Atlas\' upstream provider isn\'t reachable.',
            errNetwork:'Couldn\'t reach the server.',
            errMode:   'There\'s no account to look players up from in this game mode yet.',
            // after an error another game mode might not have
            tryOtherModes:'The player may play another game mode: switch the mode above and look them up again.',
            pickOtherMode:'Pick another game mode above.',
            errNoProfile: mode => `That account has no profile in ${mode}.`,
            // the error card, as the change tracker draws its own
            errTitles: {
                key: 'Admin key needed', bad: 'Not a nickname or account ID', rate: 'Too many lookups',
                session: 'Lookup unavailable for now', backend: 'Lookup refused', notFound: 'No profile found',
                noMatch: 'No player found', mode: 'No account for this game mode', network: 'Server unreachable',
                noProfile: 'No profile in this game mode',
                unavailable: 'Player lookup unavailable',
            },
            factQuery: 'Looked up',
            factMode:  'Game mode',
            factStatus:'Status',
            noResponse:'No response',
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
            tzLabel:   '时区',
            tzLocal:   '本地',
            title:     '玩家查询',
            badge:     '测试',
            note:      '按昵称或账号 ID 显示玩家在上方所选游戏模式中的资料，包括当前装备。查询数据来自 Atlas 的上游数据源，有频率限制，一分钟内的重复查询使用缓存。',
            query:     '昵称或账号 ID',
            lookup:    '查询',
            keyPrompt: '管理员密钥',
            saveKey:   '保存密钥',
            loading:   '查询中...',
            found:     n => `找到 ${n} 名玩家，请选择：`,
            level:     '等级',
            levelColon:'等级：',
            prestige:  '转生',
            ending:    '结局',
            accountId: '账号 ID',
            leagueBest:'最高段位',
            when:      '查询时间',
            lastActive:'最近活跃',
            cached:    '缓存',
            edition:   '游戏版本',
            seasonal:  '赛季奖励',
            tabs:      { overall: '总览', gear: '装备', skills: '技能', achievements: '成就' },
            modes:     { pve: 'PVE', pvp: 'PVP', season: 'PVP 赛季', arena: '竞技场' },
            statistics:'统计数据',
            statViews: { overall: '总览', pmc: 'PMC', scav: 'SCAV' },
            statRows: {
                raids: '战局数', survived: '幸存数', rate: '幸存率', kd: 'K/D', totalKd: 'K/D（全部击杀）', pmcKills: '击杀数（玩家）',
                aiKills: '击杀数（AI）', kia: '阵亡次数', mia: '行动中失踪', awol: '擅离职守',
                runs: '匆匆逃离', transits: '转移', leave: '擅离率', streak: '连续幸存数', online: '在线',
            },
            lastUsed:  '最后提升',
            achRarity: '稀有度',
            skillShow: '显示:',
            skillSort: '排序:',
            skillTypes:{ all: '所有类型', physical: '生理', mental: '精神', combat: '战斗', practical: '实用' },
            skillSorts:{ default: '默认', level: '等级最高', recent: '最新增长' },
            noSkills:  '没有该类型的技能。',
            skillsAndAchievements: '技能与成就',
            achName:   '成就',
            displayed: '资料页图标',
            transits:  '转移',
            aiKills:   'AI 击杀数',
            passProgress:'进度',
            seasonLabel:n => `第 ${n} 赛季`,
            passName:  name => `${name} 战斗通行证`,
            mini:      { raids: '战局数: ', kills: '击杀数: ', leave: '擅离率: ', rate: '存活率: ', kd: 'K/D: ', online: '在线: ' },
            arenaDash: {
                victories: '胜局数', winrate: '胜率', kills: '击杀数', headshots: '爆头击杀数',
                deaths: '阵亡数', online: '在线', kd: 'K/D比', winStreak: '最高连胜次数',
                loseStreak: '最高连败次数', losses: '战败数', left: '擅离次数', games: '总对局数',
                wins: '胜局数', winRate: '胜率',
            },
            playerAchievements: '玩家成就',
            arenaPass: '通行证等级',
            arenaRows: {
                registered: '注册时间', kd: 'K/D比', winRate: '胜率, %',
                avgKills: '场均击杀', headshotRate: '爆头击杀率, %',
            },
            arenaCounters: {
                GamesCount: '总对局数', ArenaWins: '胜局数', ClearWinsCount: '完胜次数',
                ArenaLoses: '战败数', GamesLeft: '擅离次数', Kills: '玩家击杀数', Deaths: '阵亡数',
                Assists: '助攻数', Headshots: '爆头击杀数', KnifeKills: '近战武器击杀数',
                GreanadeKills: '手雷击杀数', DoubleKills: '双杀', OverKills: '超杀', Ace: 'ACE',
                KilledSavage: 'Scav 击杀数', TeammateKills: '击杀队友数', ViewerKills: '观战击杀数',
                GrenadeBlinded: '致盲敌人数', DamageDealt: '造成伤害', HealthRestore: '恢复生命值',
                MaxGameKillsCount: '单局最多击杀', KillsWithoutDeaths: '当前单局连杀',
                MaxKillsWithoutDeaths: '最高单局连杀', LongestKillStreak: '最长连杀',
                WinStreak: '当前连胜', LongestWinStreak: '最高连胜次数',
                LoseStreak: '当前连败', LongestLoseStreak: '最高连败次数',
                Objectives: '目标', ObjectivePoints: '目标分数', ActivatedObjectCound: '安放装置数',
                DeactivatedObjectCound: '拆除装置数', ExplodedObjectCound: '引爆装置数',
                RoundMvpCount: '回合 MVP 次数', MatchMvpCount: '全场 MVP 次数', BestArp: '最佳 ARP',
                KillsExperience: '击杀经验', HealExperience: '治疗经验', WinExperience: '胜利经验',
                MaxWinExperience: '单局最高胜利经验', MoneyCollected: '获得金钱',
            },
            arenaPasses: '通行证',
            passFrom: date => `${date}的通行证`,
            prestigeMode: mode => `转生获得于 ${mode}`,
            prestigeModes: { regular: 'PvP', pve: 'PvE' },
            endingsReached: '已达成结局',
            arenaModes: {
                UnrankedOverall: '总体', UnrankedTeamFight: 'TeamFight', UnrankedLastHero: 'LastHero',
                UnrankedCheckPoint: 'CheckPoint', UnrankedBlastGang: 'BlastGang', UnrankedShootOutDuo: 'ShootOut',
            },
            modeStats: name => `${name}统计`,
            registered:'注册时间',
            dash: {
                raids: '(R) 战局数', survived: '(S) 幸存数', kia: '阵亡次数', mia: '行动中失踪 (MIA)', awol: '(L) 擅离职守',
                kills: '(K) 击杀数', online: '在线', runs: '(RT) 匆匆逃离', rate: '(S/R) 幸存率', lifespan: '平均存活时间',
                streak: '连续幸存数', leave: '(LR) 擅离率', kd: '(K/D)', lifetime: '账户存在时间',
            },
            modifiers: '已选定的修正效果',
            noModifiers:'玩家未选择任何修正效果',
            bonuses:   '正面增益 (-)',
            drawbacks: '负面效果 (+)',
            points:    n => `${n > 0 ? '+' : ''}${n} 点数`,
            noneSelected:'未选择修正效果',
            rareAchievements: '稀有成就',
            achievements: '成就',
            achProgress: (n, total, pct) => `已达成 ${total} 个成就中的 ${n} 个（${pct}%）`,
            earnedBy:  pct => `有 ${pct}%玩家获得了此成就`,
            noAchievements:'尚未取得成就',
            achDescription:'成就描述',
            achPlayers:'% 玩家',
            achDate:   '达成时间',
            favWeapons:'最爱武器',
            favorites: '最爱物品',
            noFavWeapons:'暂无最爱武器',
            noFavItems:'暂无最爱物品',
            killedBy:  '击杀者为',
            with:      '使用',
            expCurrent:'当前经验值: ',
            expRemaining:'剩余经验值: ',
            eliteLevel:'精英等级',
            maxed:     '最大',
            skillClass:{ physical: 'Ph', mental: 'M', combat: 'C', practical: 'P' },
            openBuilder:'在 EFTForge 中打开',
            partial:   '部分配件尚未收录于 EFTForge 数据，已在改枪器中省略。',
            gridFailed:'无法加载配件网格。',
            close:     '关闭',
            ammoSlot:  '弹匣',
            chamberSlot:'枪膛',
            rarity: { Common: '普通', Rare: '罕见', Legendary: '传奇', Seasonal: '赛季' },
            editions: { EOD: 'Edge of Darkness', Unheard: '无名者版本', Sherpa: '夏尔巴人', Emissary: '使者', Developer: '开发团队' },
            errKey:    '需要管理员密钥。',
            errBad:    '请输入昵称（3 到 15 个字母、数字或 _ . -）或账号 ID。',
            errNoMatch:'没有该昵称的玩家。',
            errRate:   '查询过多，请稍后再试。',
            errSession:'Atlas 的上游数据源暂时无法查询玩家，请稍后再试。',
            errBackend:'游戏后端拒绝了这次查询。',
            errNotFound:'该账号没有返回资料。',
            errUnavailable:'此处未配置玩家查询（ATLAS_LOOKUP_URL），或无法连接 Atlas 的上游数据源。',
            errNetwork:'无法连接服务器。',
            errMode:   '该游戏模式暂时没有可用于查询玩家的账号。',
            tryOtherModes:'该玩家可能在其他游戏模式中游玩，可在上方切换游戏模式后重新查询。',
            pickOtherMode:'请在上方选择其他游戏模式。',
            errNoProfile: mode => `该账号在 ${mode} 模式下没有资料。`,
            errTitles: {
                key: '需要管理员密钥', bad: '无法识别的输入', rate: '查询过于频繁',
                session: '暂时无法查询', backend: '查询被拒绝', notFound: '未找到资料',
                noMatch: '未找到玩家', mode: '该模式暂无查询账号', network: '无法连接服务器',
                noProfile: '该模式下没有资料',
                unavailable: '玩家查询不可用',
            },
            factQuery: '查询内容',
            factMode:  '游戏模式',
            factStatus:'状态',
            noResponse:'无响应',
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
    let _failed = null;            // what the last lookup that failed asked for, retried in another mode
    const _levels = new Map();     // account id -> level, from searches
    let _open = null;              // the open weapon: a board slot, or 'fav:<n>' for favorites[n]

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

    // EFTForge's own hover tooltip (utils.js, #eft-tooltip) instead of the browser's
    function tip(node, text) {
        if (text) node.dataset.tooltip = text;
        else delete node.dataset.tooltip;
        return node;
    }

    // The same with markup; every piece of data in `html` must already be escaped
    function tipHtml(node, html) {
        node.dataset.tooltipHtml = html;
        return node;
    }

    function escapeHtml(text) {
        return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

    // In the zone the header's UTC+8 / Local switch picks; withZone adds which one it is
    function formatTime(iso, withZone = false) {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso || '');
        const text = d.toLocaleString(_lang === 'zh' ? 'zh-CN' : 'en-US', EFTForge.utils.atlasZoneOptions());
        return withZone ? `${text} (${EFTForge.utils.atlasZoneLabel(d)})` : text;
    }

    // Two sentences one after the other: a space between them in English, none in Chinese
    function sentences(a, b) {
        return _lang === 'zh' ? `${a}${b}` : `${a} ${b}`;
    }

    // An error's card: its title, its text, its icon, and whether another game mode might
    // have what this one didn't ('try': the player may be there; 'pick': this mode has no account)
    function errorInfo(status, code) {
        const titles = /** @type {Record<string, string>} */ (t('errTitles'));
        const info = (kind, text, iconName = 'alert', modes = null) => ({ title: titles[kind], text, iconName, modes });
        if (status === 403) return info('key', t('errKey'), 'lock');
        if (status === 422 || code === 'bad_account' || code === 'bad_nickname') return info('bad', t('errBad'), 'search');
        if (status === 429) return info('rate', t('errRate'));
        if (code === 'session') return info('session', t('errSession'));
        if (code === 'backend') return info('backend', t('errBackend'));
        if (code === 'not_found') return info('notFound', sentences(t('errNotFound'), t('tryOtherModes')), 'search', 'try');
        // the account exists but never played this mode
        if (code === 'no_profile') {
            const mode = /** @type {Record<string, string>} */ (t('modes'))[_mode] || _mode;
            return info('noProfile', sentences(/** @type {(m: string) => string} */ (t('errNoProfile'))(mode), t('tryOtherModes')), 'search', 'try');
        }
        if (code === 'mode') return info('mode', sentences(t('errMode'), t('pickOtherMode')), 'search', 'pick');
        if (status === 0) return info('network', t('errNetwork'));
        return info('unavailable', t('errUnavailable'));
    }

    // The change tracker's icons for its cards (atlas.js ICONS)
    const STATE_ICONS = {
        lock:   ['rect:5,11,14,10,2', 'path:M8 11V7a4 4 0 0 1 8 0v4', 'path:M12 15v2'],
        alert:  ['circle:12,12,9', 'path:M12 7.5v5.5', 'path:M12 16.2v.3'],
        search: ['circle:11,11,6.5', 'path:M16 16l4.5 4.5', 'path:M8.5 11h5'],
    };

    function stateIcon(name) {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        for (const [k, v] of [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.6'],
            ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) svg.setAttribute(k, v);
        for (const part of STATE_ICONS[name] || STATE_ICONS.alert) {
            const [tag, spec] = part.split(':');
            const node = document.createElementNS(ns, tag);
            const n = spec.split(',');
            if (tag === 'path') node.setAttribute('d', spec);
            else if (tag === 'circle') { node.setAttribute('cx', n[0]); node.setAttribute('cy', n[1]); node.setAttribute('r', n[2]); }
            else {
                node.setAttribute('x', n[0]); node.setAttribute('y', n[1]); node.setAttribute('width', n[2]);
                node.setAttribute('height', n[3]); node.setAttribute('rx', n[4]);
            }
            svg.appendChild(node);
        }
        return svg;
    }

    // The error as the change tracker shows its own: a card with the icon and title in a red
    // band, what went wrong (with a hint to switch modes where another might have the player),
    // what was looked up, in which mode, and the answer's status
    function showErrorCard(info, query, status) {
        _failed = query;
        const modes = /** @type {Record<string, string>} */ (t('modes'));
        const card = el('div', 'atlas-state error');
        const head = el('div', 'atlas-state-head');
        head.appendChild(stateIcon(info.iconName));
        head.appendChild(el('span', 'atlas-state-title', info.title));
        card.appendChild(head);
        const body = el('div', 'atlas-state-body');
        body.appendChild(el('p', 'atlas-state-text', info.text));
        const facts = el('dl', 'atlas-state-facts');
        for (const [label, value] of [
            ...(query ? [[t('factQuery'), query]] : []),
            [t('factMode'), modes[_mode] || _mode],
            ...(status !== undefined ? [[t('factStatus'), status ? `HTTP ${status}` : t('noResponse')]] : []),
        ]) {
            facts.appendChild(el('dt', null, label));
            facts.appendChild(el('dd', null, value));
        }
        body.appendChild(facts);
        card.appendChild(body);
        const box = $('atlas-lookup-status');
        box.classList.remove('error');
        box.classList.add('has-card');
        box.replaceChildren(card);
        box.hidden = false;
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

    // tarkov.dev's art for a prestige level
    function prestigeIcon(prestige) {
        return prestige ? `https://assets.tarkov.dev/prestige-${prestige}-icon.webp` : null;
    }

    // An achievement's icon: tarkov.dev's for EFT's, our own copy for Arena's (tarkov.dev has none)
    function achievementIcon(id, arena = false) {
        if (!/^[0-9a-f]{24}$/.test(String(id))) return null;
        return arena ? `${ARENA_ART}achievements/${id}.webp` : `https://assets.tarkov.dev/achievement-${id}-icon.webp`;
    }

    // The game's picture of a skill, named by its id (a skill we have no picture for just
    // shows its name: img() drops a picture that fails to load)
    function skillIcon(id) {
        return /^[A-Za-z]+$/.test(String(id)) ? `${TARKOV_DEV_ART}skill-${id}-icon.webp` : null;
    }

    // The page's language out of {en, ch}, falling back to English
    function loc(pair) {
        if (!pair) return '';
        return (_lang === 'zh' ? pair.ch : pair.en) || pair.en || '';
    }

    function unixTime(seconds) {
        return typeof seconds === 'number' && seconds > 0 ? formatTime(seconds * 1000) : '-';
    }

    // When the player was last seen doing something, as tarkov.dev guesses it: the latest of
    // their skills' last gains and their achievements' dates (unix seconds; 0 if neither)
    function lastActive(data) {
        const skills = (data && data.skills && data.skills.common) || [];
        const done = (data && data.achievements && data.achievements.done) || [];
        const times = [...skills.map(s => s.lastAccess), ...done.map(a => a.at)];
        return Math.max(0, ...times.filter(n => typeof n === 'number' && isFinite(n)));
    }

    // A league rank's numeral, as the game writes it after the rank's name
    function rankNumeral(rank) {
        return ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][rank - 1] || String(rank);
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

    // The sides a dashboard view adds up: OVERALL is the PMC and the Scav together, as in game
    function viewSides(stats, view) {
        const sides = [];
        if (view !== 'scav' && stats && stats.pmc) sides.push([stats.pmc, 'Pmc']);
        if (view !== 'pmc' && stats && stats.scav) sides.push([stats.scav, 'Scav']);
        return sides;
    }

    // One counter over a view's sides; `parts` name the side's own tag as '$'
    function viewCounter(sides, ...parts) {
        return sides.reduce((sum, [side, tag]) => sum + counter(side, ...parts.map(p => (p === '$' ? tag : p))), 0);
    }

    function percentOf(part, whole) {
        return whole ? Math.round(part * 100 / whole) : 0;
    }

    // Time online as the dashboard writes it (3068h42m) and as the level bar does (3068.7h)
    function hours(seconds) {
        if (typeof seconds !== 'number') return '-';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return `${h}h${String(m).padStart(2, '0')}m`;
    }

    function shortHours(seconds) {
        return typeof seconds === 'number' ? `${(seconds / 3600).toFixed(2)}h` : '-';
    }

    // The game's overall dashboard for a view: its first line (each with the game's icon)
    // and its second. "(K) Kills" is players killed, as in game; average life span and
    // account lifetime aren't in what the lookup gets. Transits and AI kills go on the info line.
    function dashStats(stats, view) {
        const sides = viewSides(stats, view);
        const c = (...parts) => viewCounter(sides, ...parts);
        const raids = c('Sessions', '$');
        const survived = c('ExitStatus', 'Survived', '$');
        const left = c('ExitStatus', 'Left', '$');
        const pmcKills = c('KilledPmc');
        const deaths = c('Deaths');
        // Each side's time is the account's whole time online, so it's never added up
        const time = Math.max(0, ...sides.map(([side]) => (typeof side.time === 'number' ? side.time : 0)));
        // The game adds the PMC's and the Scav's longest streaks, and its dashboard counts a
        // transit as surviving (the level bar's survival rate doesn't)
        const streak = viewCounter(sides, 'LongestWinStreak', '$');
        const transits = c('ExitStatus', 'Transit', '$');
        const kept = survived + transits;
        return {
            raids, pmcKills, time,
            survivalRate: percentOf(survived, raids),
            leaveRate: percentOf(left, raids),
            kd: deaths ? (pmcKills / deaths).toFixed(2) : '0',
            deaths,
            first: [
                ['raids', raids], ['survived', kept], ['kia', c('ExitStatus', 'Killed', '$')],
                ['mia', c('ExitStatus', 'MissingInAction', '$')], ['awol', left], ['kills', pmcKills],
                ['online', hours(time)],
            ],
            second: [
                ['runs', c('ExitStatus', 'Runner', '$')], ['rate', `${percentOf(kept, raids)} %`],
                ['lifespan', '-'], ['streak', streak],
                ['leave', `${percentOf(left, raids)} %`], ['kd', deaths ? (pmcKills / deaths).toFixed(2) : '0'],
                ['lifetime', '-'],
            ],
            transits,
            aiKills: Math.max(0, c('Kills') - pmcKills),
            // every kill, players and AI alike, per death (the game's K/D counts players only)
            totalKd: deaths ? (c('Kills') / deaths).toFixed(2) : '0',
        };
    }

    /* ===========================
       ARENA: no PMC or Scav, raids, skills, favorites or modifiers; its counters come per
       Arena mode instead (UnrankedOverall, UnrankedTeamFight...)
    =========================== */

    const ARENA_MODES = ['UnrankedOverall', 'UnrankedTeamFight', 'UnrankedLastHero', 'UnrankedCheckPoint',
        'UnrankedBlastGang', 'UnrankedShootOutDuo'];
    // The order Arena's counters are listed in on the statistics cards
    const ARENA_COUNTER_ORDER = ['GamesCount', 'ArenaWins', 'ClearWinsCount', 'ArenaLoses', 'GamesLeft', 'Kills',
        'Deaths', 'Assists', 'Headshots', 'KnifeKills', 'GreanadeKills', 'DoubleKills', 'OverKills', 'Ace',
        'KilledSavage', 'TeammateKills', 'ViewerKills', 'GrenadeBlinded', 'DamageDealt', 'HealthRestore',
        'MaxGameKillsCount', 'KillsWithoutDeaths', 'MaxKillsWithoutDeaths', 'LongestKillStreak', 'WinStreak',
        'LongestWinStreak', 'LoseStreak', 'LongestLoseStreak', 'Objectives', 'ObjectivePoints',
        'ActivatedObjectCound', 'DeactivatedObjectCound', 'ExplodedObjectCound', 'RoundMvpCount', 'MatchMvpCount',
        'BestArp', 'KillsExperience', 'HealExperience', 'WinExperience', 'MaxWinExperience', 'MoneyCollected'];
    // Streaks still running, which only mean something per mode
    const ARENA_CURRENT_COUNTERS = ['WinStreak', 'LoseStreak', 'KillsWithoutDeaths'];

    // Arena's seasons by battle pass id: the number, the name and the emblem in ARENA_ART/passes/
    // (Season 0 has none), and each finished season's top level (the data only has the running
    // pass's). A pass not listed here shows its title from the data, or when it began
    const ARENA_SEASONS = {
        '67b8ac64cfb91e762e03ef32': { number: 0, max: 150 },
        '68c7f09ef2c815c21c0ab1fc': { number: 1, name: 'TEMPUS CAMPIONUM', icon: 'season1', max: 120 },
        '69cd05d6ddad8594db0700ca': { number: 2, name: 'CASUS BELLI', icon: 'season2', max: 100 },
        '6a7ef35bf1520fccd107be5d': { number: 3, name: 'MORBUS IMPERIUM', icon: 'season3' },
    };

    // BATTLE PASSES: the player's level in every pass, newest first, each with its season's
    // emblem; the running one out of its top level
    function passesPanel(panels, data) {
        const passes = (data.battlePasses || []).slice().reverse();
        if (!passes.length) return;
        const box = panel(panels, t('arenaPasses'), 'Achivement_icon');
        const row = el('div', 'ga-passes');
        for (const pass of passes) {
            const season = ARENA_SEASONS[pass.id];
            const entry = el('div', 'ga-pass-entry' + (pass.current ? ' is-current' : ''));
            const art = el('div', 'ga-pass-art');
            // each season's metal medallion (its Legendary achievement's art)
            if (season && season.icon) art.appendChild(img(`${ARENA_ART}passes/${season.icon}.webp`, 'ga-pass-icon'));
            entry.appendChild(art);
            const text = el('div', 'ga-pass-text');
            text.appendChild(el('div', 'ga-pass-season-name', season
                ? /** @type {(n: number) => string} */ (t('seasonLabel'))(season.number)
                : (pass.title || passLabel(pass.id))));
            if (season && season.name) text.appendChild(el('div', 'ga-pass-title-name', season.name));
            // a maxed pass says so; the running one counts toward its top level
            const max = typeof pass.max === 'number' ? pass.max : season && season.max;
            const maxed = typeof max === 'number' && pass.level >= max;
            text.appendChild(el('div', 'ga-pass-level', maxed ? `${pass.level} (MAX)`
                : typeof max === 'number' ? `${pass.level} / ${max}` : String(pass.level)));
            entry.appendChild(text);
            row.appendChild(entry);
        }
        box.appendChild(row);
    }

    // A battle pass the data gives no name for, by the month it began (its id's timestamp)
    function passLabel(id) {
        const seconds = parseInt(String(id).slice(0, 8), 16);
        if (!Number.isFinite(seconds)) return String(id);
        const date = new Date(seconds * 1000).toLocaleDateString(_lang === 'zh' ? 'zh-CN' : 'en-US',
            { ...EFTForge.utils.atlasZoneOptions(), year: 'numeric', month: 'short' });
        return /** @type {(d: string) => string} */ (t('passFrom'))(date);
    }

    // Each Arena mode's logo in ARENA_ART/modes/ (the overall card keeps its text title)
    const ARENA_MODE_LOGOS = {
        UnrankedTeamFight: 'TeamFight', UnrankedLastHero: 'LastHero', UnrankedCheckPoint: 'CheckPoint',
        UnrankedBlastGang: 'BlastGang', UnrankedShootOutDuo: 'ShootOut', UnrankedShootOut: 'ShootOut',
    };

    function isArena(data) {
        return !!(data && data.arenaStats);
    }

    // One Arena mode's numbers, with its rates worked out
    function arenaNumbers(counters) {
        const c = key => (counters && typeof counters[key] === 'number' ? counters[key] : 0);
        const games = c('GamesCount');
        const wins = c('ArenaWins');
        const kills = c('Kills');
        const deaths = c('Deaths');
        return {
            games, wins, losses: c('ArenaLoses'), winRate: `${percentOf(wins, games)} %`,
            // the profile writes the win rate as a fraction (0.81)
            winFraction: games ? (wins / games).toFixed(2) : '0',
            loseStreak: c('LongestLoseStreak'),
            kills, deaths, kd: deaths ? (kills / deaths).toFixed(2) : '0',
            assists: c('Assists'), headshots: c('Headshots'), damage: c('DamageDealt'),
            mvps: c('MatchMvpCount'), roundMvps: c('RoundMvpCount'), bestArp: c('BestArp'),
            winStreak: c('LongestWinStreak'), killStreak: c('LongestKillStreak'), left: c('GamesLeft'),
        };
    }

    // The overall counters: Arena's own overall card keeps only some of them, so the rest
    // are the modes' added up
    function arenaOverall(arenaStats) {
        const modes = (arenaStats && arenaStats.modes) || {};
        const overall = { ...(modes.UnrankedOverall || {}) };
        const others = Object.entries(modes).filter(([mode]) => mode !== 'UnrankedOverall').map(([, c]) => c);
        const keys = new Set(others.flatMap(c => Object.keys(c)));
        for (const key of keys) {
            // a current streak belongs to one mode and doesn't add up
            if (typeof overall[key] === 'number' || ARENA_CURRENT_COUNTERS.includes(key)) continue;
            const values = others.map(c => (typeof c[key] === 'number' ? c[key] : 0));
            // records are the best of any mode, everything else the modes' total
            overall[key] = /^(Longest|Max|Best)/.test(key) ? Math.max(0, ...values) : values.reduce((a, b) => a + b, 0);
        }
        return overall;
    }

    // The Arena modes the player has counters for, in the game's order, unknown ones last
    function arenaModeKeys(arenaStats) {
        const keys = Object.keys((arenaStats && arenaStats.modes) || {});
        return [...ARENA_MODES.filter(k => keys.includes(k)), ...keys.filter(k => !ARENA_MODES.includes(k))];
    }

    // Big numbers as the game writes them: groups of three split by spaces
    function spaced(n) {
        return typeof n === 'number' ? Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : '-';
    }

    // The game's level badge: one per five levels, the next five up (level 79 shows rank80)
    function rankIcon(level, arena = false) {
        if (typeof level !== 'number' || level < 1) return null;
        // Arena draws its own set of badges, on the same five-level steps
        return `${arena ? ARENA_ART + 'ranks/' : UI}rank${Math.min(80, (Math.floor(level / 5) + 1) * 5)}.webp`;
    }

    /* ===========================
       THE ACCOUNT FACTS: what the lookup knows of the account that the game's profile window
       doesn't show, in a row under the character panel's board
    =========================== */

    function accountFacts(data) {
        const grid = el('div', 'ga-facts');
        const fact = (label, value) => {
            const f = el('div', 'ga-fact');
            f.appendChild(el('div', 'ga-fact-label', label));
            const v = el('div', 'ga-fact-value');
            if (value instanceof Node) v.appendChild(value); else v.textContent = value;
            f.appendChild(v);
            grid.appendChild(f);
        };
        // Each edition as the game badges it, its icon before its name
        const editionList = list => {
            const out = el('span', 'ga-editions');
            for (const name of list) {
                const item = el('span', 'ga-edition-item');
                item.appendChild(img(EDITION_ART + name + '.webp', 'ga-edition-icon'));
                item.appendChild(el('span', '', /** @type {Record<string, string>} */ (t('editions'))[name] || name));
                out.appendChild(item);
            }
            return out;
        };
        // The league badge shows the current rank, so only the best one reached is here
        const league = data.league;
        fact(t('accountId'), String(data.accountId));
        fact(t('leagueBest'), league && league.max ? `${loc(league.maxName)} ${rankNumeral(league.max)}`.trim() : '-');
        const owned = editions(data.memberCategory);
        fact(t('edition'), owned.length ? editionList(owned) : '-');
        const shown = editions(data.selectedMemberCategory);
        fact(t('displayed'), shown.length ? editionList(shown) : '-');
        fact(t('lastActive'), unixTime(lastActive(data)));
        // every ending reached (EFT): its badge, its name on hover
        if (!isArena(data)) {
            const reached = (data.endingsReached || []).filter(e => e.systemName);
            const row = el('span', 'ga-endings');
            for (const e of reached) {
                const badge = img(ENDING_ART + encodeURIComponent(e.systemName) + '.webp', 'ga-ending-icon');
                row.appendChild(tip(badge, String((_lang === 'zh' ? e.ch : e.en) || e.en || e.systemName).replace(/\s*\n\s*/g, ' ')));
            }
            fact(t('endingsReached'), reached.length ? row : '-');
        }
        if (isArena(data) && data.registered) fact(t('registered'), unixTime(data.registered));
        return grid;
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
    // The rounds a weapon is loaded with: each type in its magazines with how many (the
    // provider already folds a magazine's cartridges per type), and the one in the chamber
    function loadedAmmo(node) {
        const mag = new Map();
        const chamber = [];
        const walk = n => {
            for (const a of n.ammo || []) {
                const seen = mag.get(a.tpl);
                mag.set(a.tpl, seen ? { ...seen, count: (seen.count || 0) + (a.count || 0) } : { ...a });
            }
            for (const c of n.children || []) {
                if (c.slot === 'patron_in_weapon') chamber.push(c);
                else walk(c);
            }
        };
        walk(node);
        return { mag: [...mag.values()], chamber };
    }

    // An ammo cell built like the grid's own (.ag-cell), with the count in its corner, no hover card
    function ammoCell(round, label, count) {
        const cell = el('div', 'tree-slot ag-cell atlas-lookup-ammo-cell');
        const inner = el('div', 'tree-slot-inner');
        const item = el('div', 'tree-slot-item');
        if (round.icon) item.appendChild(img(round.icon, 'ag-icon'));
        item.appendChild(el('div', 'slot-shortname', shortName(round)));
        inner.appendChild(item);
        if (count) inner.appendChild(el('span', 'atlas-lookup-ammo-count', `×${count}`));
        cell.appendChild(inner);
        const name = el('div', 'ag-label');
        name.appendChild(el('span', 'marquee-text', label));
        cell.appendChild(name);
        return cell;
    }

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
        trimGridColumns(box);
        // What it's loaded with, which the builder's grid has no slot for: a cell per round
        // type in its magazines, and the one in the chamber, after the grid's own extras
        const ammo = loadedAmmo(node);
        if (ammo.mag.length || ammo.chamber.length) {
            const wrapper = box.querySelector('.attachment-grid-wrapper') || box;
            let extras = wrapper.querySelector('.ag-extras');
            if (!extras) {
                extras = el('div', 'ag-extras');
                wrapper.appendChild(extras);
            }
            for (const round of ammo.mag) extras.appendChild(ammoCell(round, t('ammoSlot'), round.count));
            for (const round of ammo.chamber) extras.appendChild(ammoCell(round, t('chamberSlot'), 0));
        }
        // Nothing here installs or removes parts: the cells only show what's in them
        box.querySelectorAll('.ag-cell').forEach(cell => {
            const c = /** @type {HTMLElement} */ (cell);
            c.onclick = null;
            c.oncontextmenu = null;
            c.style.cursor = 'default';
        });
        if (typeof _initMarqueeText === 'function') {
            _initMarqueeText(box, { hoverOnly: true, hoverTarget: '.ag-cell, .ag-gun-cell' });
        }
    }

    // The builder's grid always has its ten columns, the gun in the 7th to 9th; a build that
    // doesn't reach the leftmost leaves them empty. Slide the grid left past those, so a panel
    // sized to its content has no empty strip on the left.
    function trimGridColumns(box) {
        const grid = /** @type {HTMLElement | null} */ (box.querySelector('.attachment-grid'));
        if (!grid) return;
        let first = Infinity;
        for (const cell of Array.from(grid.children)) {
            const start = parseInt(getComputedStyle(cell).gridColumnStart, 10);
            if (start > 0) first = Math.min(first, start);
        }
        const column = parseFloat(getComputedStyle(grid).gridTemplateColumns) || 56;
        if (Number.isFinite(first) && first > 1) grid.style.marginLeft = `${-(first - 1) * column}px`;
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
            if (node.build && !node.build.complete) tip(open, t('partial'));
            head.appendChild(open);
            card.appendChild(head);
        }
        const grid = el('div', 'atlas-lookup-grid');
        card.appendChild(grid);
        // The panel sizes to the grid, so place it again once the grid is in
        showGrid(node, grid).then(() => positionWeaponPopover()).catch(err => {
            console.warn('[atlas-lookup] attachment grid:', err);
            grid.replaceChildren(el('div', 'atlas-empty error', t('gridFailed')));
        });
        return card;
    }

    /* ===========================
       GEAR: the Ballistics Workbench's loadout board, laid out like the game's gear panel
    =========================== */

    // Board units are the workbench's: 125 px slots with a 131 by 20 header 22 above them.
    // Packed tighter than the workbench: 48 px inserts 4 from their parent, the columns just
    // far enough apart for a side plate or helmet attachment between them (183), and each
    // row just low enough for the back plate above an armor or rig in it. Inserts have no
    // header bar (styles.css .bw-slot-insert), so a plate sits 4 from its parent's edge.
    // The PMC (512 by 768) keeps the workbench's offset from the middle column. The slots
    // keep the game's gear panel order (TarkTetris theme.js GEAR_SLOTS): earpiece, headwear,
    // face cover; armband, body armor, eyewear; the weapons below with the holster and
    // sheath beside them. The containers' column (rig, backpack, pouch) follows on the
    // right, as in the game, with room on its right for an armored rig's side plate.
    const BOARD_W = 738;
    const BOARD_H = 772;
    const SLOT = 125;
    const INSERT = 48;
    const INSERT_GAP = 4;
    const COL = [6, 189, 372, 555];
    const ROW = [78, 281, 484, 639];
    const WEAPON_W = COL[2] - COL[0] - 16;
    const GEAR_LAYOUT = [
        { slot: 'Earpiece', x: COL[0], y: ROW[0] },
        { slot: 'Headwear', x: COL[1], y: ROW[0] },
        { slot: 'FaceCover', x: COL[2], y: ROW[0] },
        { slot: 'ArmBand', x: COL[0], y: ROW[1], h: 44 },
        { slot: 'ArmorVest', x: COL[1], y: ROW[1] },
        { slot: 'Eyewear', x: COL[2], y: ROW[1] },
        { slot: 'FirstPrimaryWeapon', x: COL[0], y: ROW[2], w: WEAPON_W },
        { slot: 'Holster', x: COL[2], y: ROW[2] },
        { slot: 'SecondPrimaryWeapon', x: COL[0], y: ROW[3], w: WEAPON_W },
        { slot: 'Scabbard', x: COL[2], y: ROW[3] },
        { slot: 'TacticalVest', x: COL[3], y: ROW[0] },
        { slot: 'Backpack', x: COL[3], y: ROW[1] },
        { slot: 'SecuredContainer', x: COL[3], y: ROW[2] },
    ];
    // Slots the Arena profile leaves off the board
    const ARENA_HIDDEN_SLOTS = ['Backpack', 'SecuredContainer', 'ArmBand'];
    // Empty slot art: the workbench's placements where it has them (styles.css .bw-art-*), and
    // TarkTetris' back image rects (in slot px) for the rest, centered at native size otherwise
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
        const center = x + (SLOT - INSERT) / 2;
        switch (spot) {
            // Right above the parent's header
            case 'back': return [center, y - 22 - INSERT_GAP - INSERT];
            case 'front': return [center, y + SLOT + INSERT_GAP];
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
        // a favorite weapon's tile is open when it's the one shown
        document.querySelectorAll('.ga-item[data-fav]').forEach(node => {
            const tile = /** @type {HTMLElement} */ (node);
            const open = tile.dataset.fav === _open;
            tile.classList.toggle('active-slot', open);
            tile.setAttribute('aria-expanded', String(open));
        });
        const arena = isArena(data);
        for (const spot of GEAR_LAYOUT) {
            // Arena's loadouts have no backpack, pouch or armband
            if (arena && ARENA_HIDDEN_SLOTS.includes(spot.slot)) continue;
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
        renderWeaponPopover(data);
    }

    /* ===========================
       THE OPEN WEAPON: beside the board on the GEAR tab
    =========================== */

    // Only weapons open beside the board (their build)
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
        tile.addEventListener('click', onOpen);
        tile.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
        });
    }

    // The open weapon's attachment grid pops out beside its tile on the board, over the page
    // as EFTForge's advanced stats popover does (styles.css .hidden-stats-popover): to the
    // tile's right or else its left, as wide as its grid. It sits on the page rather than the
    // window, so it scrolls with everything else at its full height.
    let _popoverData = null;

    function weaponPopover() {
        return $('atlas-lookup-weapon-pop');
    }

    function closeWeaponPopover() {
        const pop = weaponPopover();
        if (pop) {
            pop.classList.remove('show');
            pop.addEventListener('transitionend', () => pop.remove(), { once: true });
            setTimeout(() => pop.remove(), 250);
        }
        if (_open && _popoverData) {
            _open = null;
            renderBoard(_popoverData);   // the tile loses its open border
        }
        _popoverData = null;
    }

    function positionWeaponPopover() {
        const pop = weaponPopover();
        const tile = document.querySelector('#atlas-lookup-board .bw-slot.active-slot, .ga-item.active-slot');
        if (!pop || !tile) return;
        const margin = 10;
        const header = 76;   // the fixed site header and a little air
        const rect = tile.getBoundingClientRect();
        const width = pop.offsetWidth;
        let left = rect.right + margin;
        if (left + width + margin > window.innerWidth) left = Math.max(margin, rect.left - width - margin);
        // Level with the tile, lifted as far as it takes to open fully in view (never under the header)
        const fits = window.innerHeight - margin - pop.offsetHeight;
        const top = Math.max(header, Math.min(rect.top, fits));
        pop.style.left = `${left + window.scrollX}px`;
        pop.style.top = `${top + window.scrollY}px`;
    }

    // The node _open names: a board slot's, or a favorite's ('fav:<n>')
    function openNode(data) {
        if (!_open) return null;
        if (_open.startsWith('fav:')) return (data.favorites || [])[Number(_open.slice(4))] || null;
        return (data.slots || []).find(s => s.slot === _open) || null;
    }

    function renderWeaponPopover(data) {
        const shown = openNode(data);
        if (!openable(shown)) {
            const old = weaponPopover();
            if (old) old.remove();
            _popoverData = null;
            _open = null;
            return;
        }
        _popoverData = data;
        let pop = weaponPopover();
        const isNew = !pop;
        if (!pop) {
            pop = el('div', 'atlas-lookup-popover');
            pop.id = 'atlas-lookup-weapon-pop';
            pop.setAttribute('role', 'dialog');
            // Before #eft-tooltip, which has to stay the last thing on the page
            document.body.insertBefore(pop, $('eft-tooltip'));
        }
        pop.replaceChildren();
        const head = el('div', 'atlas-lookup-contents-head');
        const where = shown.slot ? slotLabel(shown.slot) : t('favWeapons');
        head.appendChild(el('span', 'atlas-lookup-crumb current', `${where}: ${itemName(shown)}`));
        const close = el('button', 'atlas-lookup-contents-close', t('close'));
        close.type = 'button';
        close.addEventListener('click', closeWeaponPopover);
        head.appendChild(close);
        pop.appendChild(head);
        pop.appendChild(weaponCard(shown));
        positionWeaponPopover();
        if (isNew) {
            void pop.offsetHeight;
            requestAnimationFrame(() => pop.classList.add('show'));
        } else {
            pop.classList.add('show');
        }
    }

    /* ===========================
       THE PAGE: the profile in the game's own 1920 px wide coordinates (the other player
       profile window and the character screen's tabs, as UI dumps of the game lay them
       out), one section under another, scaled as a whole to the page's width. Every x, y,
       width and height below is the game's, in px at 1920 by 1080, from its section's top.
    =========================== */

    const UI = '/assets/images/atlas-lookup/ui/';
    // Wider than the game's 1920, so the page fills a wide window with everything a bit
    // smaller than in game; the right side and the lower sections stretch across it
    const SCREEN_W = 2560;
    // The skill classes' badge colors and letters, in the game's skill order
    const SKILL_CLASSES = {
        physical: { color: '#67b1b8', skills: ['Endurance', 'Strength', 'Vitality', 'Health', 'StressResistance', 'Metabolism', 'Immunity'] },
        mental: { color: '#dcd7b9', skills: ['Perception', 'Intellect', 'Attention', 'Charisma'] },
        combat: { color: '#b85739', skills: ['Pistol', 'Revolver', 'SMG', 'Assault', 'Shotgun', 'Sniper', 'LMG', 'HMG', 'Launcher',
            'AttachedLauncher', 'Throwing', 'Melee', 'DMR', 'AimDrills', 'TroubleShooting'] },
        practical: { color: '#afdca9', skills: ['Surgery', 'CovertMovement', 'Search', 'MagDrills', 'LightVests', 'HeavyVests',
            'WeaponTreatment', 'Crafting', 'HideoutManagement'] },
    };
    // Every skill in the order the game's skills tab lists them
    const GAME_SKILL_ORDER = Object.values(SKILL_CLASSES).flatMap(c => c.skills);
    const ELITE_PROGRESS = 5100;   // level 51
    // The current season, for the battle pass banner. The game only names it in the banner's
    // own art, not in its data, so update this when a new season starts.
    const SEASON = { number: 1, name: 'KORD BREACH' };
    // The nickname's color for the edition a player shows
    const NAME_COLORS = { Unheard: '#55d0e6', EOD: '#d49000' };


    function at(node, x, y, w, h) {
        node.style.left = `${x}px`;
        node.style.top = `${y}px`;
        if (w !== undefined && w !== null) node.style.width = `${w}px`;
        if (h !== undefined && h !== null) node.style.height = `${h}px`;
        return node;
    }

    // An element placed at the game's coordinates inside `parent`
    function put(parent, tag, cls, x, y, w, h, text) {
        const node = at(el(tag, 'ga-abs' + (cls ? ' ' + cls : ''), text), x, y, w, h);
        parent.appendChild(node);
        return node;
    }

    function uiImg(name, cls) {
        return img(`${UI}${name}.webp`, cls);
    }

    // A white game icon drawn in the text's color (Atlas' gray, or its blue when selected)
    function uiMask(name, cls) {
        const icon = el('span', 'ga-mask' + (cls ? ' ' + cls : ''));
        icon.style.setProperty('--ga-mask', `url("${UI}${name}.webp")`);
        return icon;
    }

    function skillClass(id) {
        return Object.keys(SKILL_CLASSES).find(k => SKILL_CLASSES[k].skills.includes(id)) || 'practical';
    }

    // Size each section to what's in it, then scale the 1920 px page to the frame's width and
    // give the frame the scaled height
    function fitScreen() {
        const frame = $('atlas-lookup-frame');
        const screen = $('atlas-lookup-screen');
        if (!frame || !screen) return;
        screen.querySelectorAll('.ga-section-body').forEach(node => {
            const body = /** @type {HTMLElement} */ (node);
            let bottom = 0;
            for (const child of Array.from(body.children)) {
                const c = /** @type {HTMLElement} */ (child);
                bottom = Math.max(bottom, c.offsetTop + c.offsetHeight);
            }
            body.style.height = `${bottom}px`;
        });
        const scale = frame.clientWidth / SCREEN_W;
        screen.style.transform = `scale(${scale})`;
        frame.style.height = `${screen.offsetHeight * scale}px`;
    }

    // A slot box as the character panel draws PRESTIGE: a header bar, then a framed square
    function slotBox(parent, x, y, label, content, tooltip) {
        const box = put(parent, 'div', 'ga-slotbox', x, y, 128, 146);
        put(box, 'div', 'ga-slotbox-bg', 2, 22, 124, 123);
        put(box, 'div', 'ga-slotbox-border', 1, 21, 126, 125);
        put(box, 'div', 'ga-slotbox-head', 0, 0, 128, 20);
        put(box, 'div', 'ga-slotbox-label', 5, -1, 118, 22, label);
        const inner = put(box, 'div', 'ga-slotbox-inner', 2, 22, 124, 123);
        if (content) inner.appendChild(content);
        else inner.appendChild(at(uiImg('Cross', 'ga-abs'), 52, 51, 20, 20));
        if (tooltip) tip(box, tooltip);
        return box;
    }

    // The character panel (PlayerModelWithStats), wider than the game's so the loadout board
    // fits where the game draws the model: level bar; side, ending, prestige and league down
    // the left; the board; nickname, experience and battle pass
    const LEFT_W = 1000;
    function leftPanel(screen, data, x, y) {
        const panel = put(screen, 'div', 'ga-left', x, y, LEFT_W, 1245);
        const level = data.level ?? _levels.get(String(data.accountId));
        const bar = put(panel, 'div', 'ga-levelbar', 9, 11, LEFT_W - 18, 100);
        const arena = isArena(data);
        const rank = rankIcon(level, arena);
        if (rank) bar.appendChild(at(img(rank, 'ga-abs ga-contain'), 4, 6, 100, 88));
        put(bar, 'div', 'ga-level', 106, 0, 120, 100, level ?? '-');
        const mini = /** @type {Record<string, string>} */ (t('mini'));
        // the bar's full height, the columns centered in it (EFT's three rows, Arena's two)
        const miniCols = put(bar, 'div', 'ga-mini-cols', 426, 0, 180, 100);
        const miniStat = (col, label, value) => {
            const line = el('div', 'ga-mini');
            line.appendChild(el('span', '', label));
            line.appendChild(el('span', 'ga-mini-value', value));
            col.appendChild(line);
        };
        if (arena) {
            // As Arena's level bar has them: three columns of two, each behind the game's icon
            // (matches, K/D, win rate over kills, wins, matches quit)
            const a = arenaNumbers(arenaOverall(data.arenaStats));
            const tips = /** @type {Record<string, string>} */ (t('arenaDash'));
            for (const pair of [[['matches', 'games', a.games], ['kills', 'kills', a.kills]],
                [['kd', 'kd', a.kd], ['wins', 'wins', a.wins]],
                [['winrate', 'winRate', a.winFraction], ['quit', 'left', a.left]]]) {
                const col = el('div', 'ga-mini-col');
                for (const [icon, label, value] of pair) {
                    const line = el('div', 'ga-mini ga-mini-arena');
                    line.appendChild(img(`${ARENA_ART}mini/${icon}.webp`, 'ga-mini-icon'));
                    line.appendChild(el('span', 'ga-mini-value', String(value)));
                    col.appendChild(tip(line, tips[label]));
                }
                miniCols.appendChild(col);
            }
        } else {
            const colA = el('div', 'ga-mini-col');
            const colB = el('div', 'ga-mini-col');
            miniCols.append(colA, colB);
            // The PMC's own numbers, as the game shows them here (the dashboard adds the Scav's)
            const s = dashStats(data.stats, 'pmc');
            miniStat(colA, mini.raids, String(s.raids));
            miniStat(colA, mini.kills, String(s.pmcKills));
            miniStat(colA, mini.leave, `${s.leaveRate}%`);
            miniStat(colB, mini.rate, `${s.survivalRate}%`);
            miniStat(colB, mini.kd, s.kd);
            miniStat(colB, mini.online, shortHours(s.time));
        }
        // The nickname with the shown edition's icon, and the experience under it, centered on
        // the bar between the level and those numbers
        const shown = editions(data.selectedMemberCategory)[0];
        const who = put(bar, 'div', 'ga-barwho', 0, 15, LEFT_W - 18, 70);
        const name = el('div', 'ga-namerow');
        // Arena has its own edition icons, and a player icon when none is shown
        if (arena) name.appendChild(img(`${ARENA_ART}editions/${shown || 'Default'}.webp`, 'ga-edition'));
        else if (shown) name.appendChild(img(EDITION_ART + shown + '.webp', 'ga-edition'));
        const nick = el('span', 'ga-nick', data.nickname || data.accountId);
        nick.style.color = NAME_COLORS[shown] || '#c5c3b2';
        name.appendChild(nick);
        const exp = el('div', 'ga-exprow');
        exp.appendChild(uiImg('icon_experience_big', 'ga-exp-icon'));
        exp.appendChild(el('span', 'ga-exp', spaced(data.experience)));
        who.append(name, exp);

        // Side, then ending, prestige and the league badge below it (Arena has none of the three)
        const side = String(data.side || '').toLowerCase();
        if (side === 'usec' || side === 'bear') panel.appendChild(at(uiImg(`icon_${side}`, 'ga-abs'), 6, 127, 128, 128));
        if (arena) {
            // Arena's battle pass where EFT has ending and prestige: the running season's emblem
            // and the player's level in it, as the game draws them: the emblem in color and the
            // plate orange once the pass is maxed, before that the emblem greyed out and the plate
            // in the pass's own color
            const passes = data.battlePasses || [];
            const current = passes.find(p => p.current) || passes[passes.length - 1];
            if (current) {
                const maxed = typeof current.max === 'number' && current.level >= current.max;
                const emblem = img(`${ARENA_ART}bp-emblem.webp`, 'ga-abs ga-contain ga-bp-emblem' + (maxed ? '' : ' is-unfinished'));
                panel.appendChild(at(emblem, 30, 280, 80, 80));
                const plate = put(panel, 'div', 'ga-bp-level' + (maxed ? ' is-maxed' : ''), 32, 372, 75, 65);
                if (!maxed) plate.style.setProperty('--bp-color', current.color || '#006c87');
                plate.appendChild(el('span', 'ga-bp-level-text', String(current.level)));
                tip(plate, t('arenaPass'));
            }
        }
        const end = arena ? null : data.ending;
        const ending = end && end.systemName ? img(ENDING_ART + encodeURIComponent(end.systemName) + '.webp', 'ga-slotbox-img') : null;
        if (!arena) {
            slotBox(panel, 6, 260, t('ending'), ending,
                ending ? String((_lang === 'zh' ? end.ch : end.en) || end.en || end.systemName).replace(/\s*\n\s*/g, ' ') : null);
            const pIcon = prestigeIcon(data.prestigeLevel);
            // which game mode the prestige was earned in, on hover
            const pMode = data.prestigeLevel && data.prestigeGameMode
                ? /** @type {(m: string) => string} */ (t('prestigeMode'))(
                    /** @type {Record<string, string>} */ (t('prestigeModes'))[data.prestigeGameMode] || data.prestigeGameMode)
                : null;
            slotBox(panel, 6, 411, t('prestige'), pIcon ? img(pIcon, 'ga-slotbox-img') : null, pMode);
        }
        const league = data.league;
        if (league && league.rank) {
            const roman = rankNumeral(league.rank);
            const badge = put(panel, 'div', 'ga-league', 10, 567, 120, 120);
            const numeral = el('span', 'ga-league-numeral', roman);
            badge.appendChild(numeral);
            // The badge's edges are see-through, so the numeral only stays without a picture
            const pic = img(`${LEAGUE_ART}${league.rank}.webp`, 'ga-league-img');
            pic.addEventListener('load', () => numeral.remove());
            badge.appendChild(pic);
            tip(badge, `${(loc(league.name) || '').toUpperCase()} ${roman}`.trim());
        }

        // The loadout board, where the game draws the model (renderScreen fills it)
        const boardW = 840;
        const boardH = Math.round(boardW * BOARD_H / BOARD_W);
        const board = put(panel, 'div', 'atlas-lookup-board', 146, 127, boardW, boardH);
        board.id = 'atlas-lookup-board';

        // The account, in one row under the board, then the battle pass banner
        put(panel, 'div', 'ga-panelfacts', 0, 127 + boardH + 22, LEFT_W, 60).appendChild(accountFacts(data));
        // The season's progress: the battle pass, and the seasonal rewards beside it. Only the
        // PvP Season mode has a season, though the other modes' profiles carry the fields too
        const pass = data.battlePass;
        const rewards = data.seasonalRewards;
        if ((data.mode || _mode) === 'season' && ((pass && pass.total) || (rewards && rewards.total))) {
            const banner = put(panel, 'div', 'ga-pass', 27, 127 + boardH + 106, LEFT_W - 54, 112);
            const title = put(banner, 'div', 'ga-pass-title', 24, 0, 560, 112);
            title.appendChild(el('div', 'ga-pass-season', /** @type {(n: number) => string} */ (t('seasonLabel'))(SEASON.number)));
            title.appendChild(el('div', 'ga-pass-name', /** @type {(name: string) => string} */ (t('passName'))(SEASON.name)));
            const column = (x, label, p) => {
                if (!p || !p.total) return;
                put(banner, 'div', 'ga-pass-label', x, 34, 200, 16, label);
                put(banner, 'div', 'ga-pass-value', x, 54, 200, 26, `${p.completed} / ${p.total}`);
            };
            column(LEFT_W - 470, t('passProgress'), pass);
            column(LEFT_W - 230, t('seasonal').toUpperCase(), rewards);
        } else {
            // no banner: the panel ends under the account row, with the same margin below it
            panel.style.height = `${127 + boardH + 22 + 60 + 21}px`;
        }
        return panel;
    }

    // A panel on the profile's right side: a bordered header with an icon, then its body
    function panel(parent, title, icon) {
        const box = el('section', 'ga-panel');
        const head = el('div', 'ga-panel-head');
        if (icon) head.appendChild(uiMask(icon, 'ga-panel-icon'));
        head.appendChild(el('span', '', title));
        box.appendChild(head);
        const body = el('div', 'ga-panel-body');
        box.appendChild(body);
        parent.appendChild(box);
        return body;
    }

    // The game's progress bar: a frame, the gray gradient fill, a 1 px border
    function progressBar(parent, fraction, cls) {
        const bar = el('div', 'ga-progress' + (cls ? ' ' + cls : ''));
        const fill = el('div', 'ga-progress-fill');
        fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
        bar.appendChild(fill);
        parent.appendChild(bar);
        return bar;
    }

    // "31 out of 131 achievements earned (24%)", in the page's language
    // An achievement's hover card: its name, what it takes, and how many players have it
    function achievementTooltipHtml(a) {
        const name = loc({ en: a.en?.name, ch: a.ch?.name }) || a.id;
        const desc = loc({ en: a.en?.description, ch: a.ch?.description });
        const share = typeof a.percent === 'number'
            ? `<div class="ga-tip-sub">${escapeHtml(/** @type {(n: number) => string} */ (t('earnedBy'))(a.percent))}</div>` : '';
        return `<div class="atlas-lookup-perk-tip-name">${escapeHtml(name)}</div>${desc ? `<div>${escapeHtml(desc)}</div>` : ''}${share}`;
    }

    // "31/131", the count big, as the game's rare achievements panel shows it
    function bigCount(done, total) {
        const value = el('div', 'ga-bigcount');
        value.appendChild(el('span', 'ga-bigcount-n', done));
        value.appendChild(document.createTextNode(`/${total}`));
        return value;
    }

    function achievementProgress(ach) {
        const done = (ach.done || []).length;
        const total = ach.total || done;
        const fmt = /** @type {(n: number, total: number, pct: number) => string} */ (t('achProgress'));
        return { done, total, text: fmt(done, total, total ? Math.round(done * 100 / total) : 0) };
    }

    function itemTile(node, noLink = false) {
        const tile = el('div', 'ga-item');
        tile.style.background = SLOT_COLORS[node.bg] || SLOT_COLORS.default;
        const picture = node.render || node.image || node.icon;
        if (picture) tile.appendChild(img(picture, 'ga-item-img'));
        const tag = node.dogtag;
        if (tag && tag.nickname) {
            tile.appendChild(el('span', 'ga-item-name', tag.nickname));
            if (tag.level) tile.appendChild(el('span', 'ga-item-sub', tag.level));
        } else {
            tile.appendChild(shortHtml(el('span', 'ga-item-name'), shortName(node)));
        }
        let html = `<div class="atlas-lookup-perk-tip-name">${escapeHtml(itemName(node))}</div>`;
        if (tag) {
            html += `<div>${escapeHtml(tag.nickname)}${tag.level ? ` (${escapeHtml(t('level'))} ${tag.level})` : ''}</div>`;
            if (tag.killer) html += `<div>${escapeHtml(t('killedBy'))} ${escapeHtml(tag.killer)}</div>`;
            if (tag.weapon && loc(tag.weapon)) html += `<div>${escapeHtml(t('with'))} ${escapeHtml(loc(tag.weapon))}</div>`;
            if (tag.time) html += `<div class="ga-tip-sub">${escapeHtml(formatTime(tag.time))}</div>`;
        }
        tipHtml(tile, html);
        const link = noLink ? null : builderLink(node.build);
        if (!link) return tile;
        const a = /** @type {HTMLAnchorElement} */ (el('a', 'ga-item ga-item-link'));
        a.href = link;
        a.target = '_blank';
        a.rel = 'noopener';
        a.append(...Array.from(tile.childNodes));
        a.style.background = tile.style.background;
        tipHtml(a, html + (node.build.complete ? '' : `<div class="ga-tip-sub">${escapeHtml(t('partial'))}</div>`));
        return a;
    }

    // A player's name as a link to their lookup, as tarkov.dev links players: the page looks
    // them up in place (a new tab or window gets the address instead)
    function playerLink(name, accountId) {
        if (!accountId || !/^[0-9]{1,12}$/.test(accountId)) return document.createTextNode(name);
        const link = /** @type {HTMLAnchorElement} */ (el('a', 'ga-fav-link', name));
        link.href = `/atlas/players/?accountId=${encodeURIComponent(accountId)}`;
        link.addEventListener('click', e => {
            if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
            e.preventDefault();
            openPlayer(accountId, true);
        });
        return link;
    }

    // A favorite: its tile, and for a dogtag what's on it as tarkov.dev writes it: "<owner>
    // killed by <killer> using <weapon>", both players linked to their profiles, then when
    function favoriteEntry(node) {
        const tile = itemTile(node);
        const tag = node.dogtag;
        if (!tag) return tile;
        const entry = el('div', 'ga-fav');
        entry.appendChild(tile);
        const text = el('div', 'ga-fav-text');
        text.appendChild(el('div', 'ga-fav-name', itemName(node)));
        const line = el('div', 'ga-fav-line');
        line.appendChild(playerLink(tag.nickname, tag.accountId));
        if (tag.killer) {
            const status = tag.status === 'Killed by' || !tag.status ? t('killedBy') : tag.status;
            line.appendChild(document.createTextNode(` ${_lang === 'zh' ? status : status.toLowerCase()} `));
            line.appendChild(playerLink(tag.killer, tag.killerAccountId));
        }
        if (tag.weapon && loc(tag.weapon)) line.appendChild(document.createTextNode(` ${t('with')} ${loc(tag.weapon)}`));
        text.appendChild(line);
        if (tag.time) text.appendChild(el('div', 'ga-fav-time', formatTime(tag.time)));
        entry.appendChild(text);
        return entry;
    }

    // PROFILE: the other player profile window, as the live game draws it
    // The game modes a lookup can come from, in the switch's order. Each needs its own
    // account upstream; one without gets the provider's "mode" error (errMode)
    const GAME_MODES = [
        { key: 'pve', live: true },
        { key: 'pvp', live: true },
        { key: 'season', live: true },
        { key: 'arena', live: true },
    ];
    let _mode = 'season';   // the header's mode switch picks it (EFTForge.atlasMode, set up in init)

    function profileSection(body, data) {
        leftPanel(body, data, 24, 0);
        const rightX = 24 + LEFT_W + 16;
        const right = put(body, 'div', 'ga-right', rightX, 0, SCREEN_W - 24 - rightX);
        const statsW = SCREEN_W - 24 - rightX - 16;

        // Statistics: the game mode switch over the dashboard. Each mode needs its own account
        // to look players up from, so only the ones in GAME_MODES marked live can be picked
        const stats = el('div', 'ga-stats');
        stats.style.width = `${statsW}px`;
        right.appendChild(stats);
        put(stats, 'div', 'ga-stats-buttons', 0, 0, statsW, 50);
        const modes = /** @type {Record<string, string>} */ (t('modes'));
        // filling the band edge to edge, so its border is theirs (no double lines), each mode in
        // its color as in the header's switch
        const modeW = (statsW - 2) / GAME_MODES.length;
        GAME_MODES.forEach(({ key, live }, i) => {
            const state = key === _mode ? ' is-selected' : live ? '' : ' is-disabled';
            const last = i === GAME_MODES.length - 1 ? ' is-last' : '';
            const btn = put(stats, 'div', 'ga-btn ga-mode-btn' + state + last, i * modeW, 0, modeW, 49);
            btn.dataset.mode = key;
            btn.appendChild(el('span', 'ga-btn-label', modes[key]));
            if (key === _mode || !live) return;
            // the same as picking the mode in the header: both switches follow, and the
            // player is looked up again in that mode
            btn.setAttribute('role', 'button');
            btn.tabIndex = 0;
            btn.addEventListener('click', () => EFTForge.atlasMode.select(key));
            btn.addEventListener('keydown', e => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                EFTForge.atlasMode.select(key);
            });
        });
        const arena = isArena(data);
        const s = arena ? arenaDash(data) : dashStats(data.stats, 'overall');
        const labels = /** @type {Record<string, string>} */ (t(arena ? 'arenaDash' : 'dash'));
        const shown = value => (typeof value === 'number' ? value.toLocaleString('en-US') : value);
        // EFT's dashboard has seven columns, Arena's six, each line's first row with the game's icons
        const pitch = (statsW - 26) / s.first.length;
        const cellW = pitch - 20;
        s.first.forEach(([key, value], i) => {
            const x = 13 + i * pitch;
            const icon = arena ? `${ARENA_ART}stats/${key}.webp` : `${STAT_ART}${key}.webp`;
            stats.appendChild(at(img(icon, 'ga-abs ga-dash-icon'), x, 70, cellW, 36));
            put(stats, 'div', 'ga-dash-count', x, 106, cellW, 30, shown(value));
            put(stats, 'div', 'ga-dash-desc', x, 136, cellW, 57, labels[key]);
        });
        s.second.forEach(([key, value], i) => {
            const x = 13 + i * pitch;
            put(stats, 'div', 'ga-dash-count', x, 193, cellW, 35, shown(value));
            put(stats, 'div', 'ga-dash-desc', x, 228, cellW, 45, labels[key]);
        });

        const panels = el('div', 'ga-panels');
        panels.style.width = `${statsW}px`;
        right.appendChild(panels);

        // Rare achievements: the progress, then the nine rarest the player has
        const ach = data.achievements || {};
        const rare = panel(panels, t(arena ? 'playerAchievements' : 'rareAchievements'), 'Achivement_icon');
        const prog = achievementProgress(ach);
        const top = el('div', 'ga-ach-progress');
        top.appendChild(el('div', 'ga-ach-text', prog.text));
        const row = el('div', 'ga-ach-barrow');
        progressBar(row, prog.total ? prog.done / prog.total : 0);
        row.appendChild(bigCount(prog.done, prog.total));
        top.appendChild(row);
        rare.appendChild(top);
        const rarest = (ach.done || []).slice().sort((a, b) => (a.percent ?? 100) - (b.percent ?? 100)).slice(0, 9);
        const badges = el('div', 'ga-badges');
        if (!rarest.length) badges.appendChild(el('div', 'ga-empty', t('noAchievements')));
        for (const a of rarest) {
            const icon = achievementIcon(a.id, arena);
            const badge = el('div', 'ga-badge');
            if (icon) badge.appendChild(img(icon, 'ga-badge-img'));
            badges.appendChild(tipHtml(badge, achievementTooltipHtml(a)));
        }
        rare.appendChild(badges);
        // Arena keeps no favorites or seasonal modifiers, but has its battle passes
        if (arena) {
            passesPanel(panels, data);
            return;
        }

        // Favorite weapons, then everything else the player favorited
        const favorites = data.favorites || [];
        for (const [weapons, title, icon, empty] of [
            [true, t('favWeapons'), 'Favorite_weapon', t('noFavWeapons')],
            [false, t('favorites'), 'Favorite_item_achivement', t('noFavItems')],
        ]) {
            const box = panel(panels, /** @type {string} */ (title), /** @type {string} */ (icon));
            const list = favorites.filter(f => !!f.build === weapons);
            const items = el('div', 'ga-items');
            if (!list.length) items.appendChild(el('div', 'ga-empty', /** @type {string} */ (empty)));
            for (const f of list) {
                if (!weapons) {
                    items.appendChild(favoriteEntry(f));
                    continue;
                }
                // a weapon opens beside its tile as the board's do, its builder link in there
                const key = `fav:${favorites.indexOf(f)}`;
                const tile = itemTile(f, true);
                tile.classList.add('ga-item-link');   // a weapon's wide tile, as the link was
                tile.dataset.fav = key;
                expandable(tile, f, _open === key, () => {
                    _open = _open === key ? null : key;
                    renderBoard(data);
                });
                items.appendChild(tile);
            }
            box.appendChild(items);
        }

        // Selected modifiers: the bonuses on green, the drawbacks on red, an icon each. Seasonal
        // modifiers only exist in the PvP Season mode
        if ((data.mode || _mode) !== 'season') return;
        const own = (data.perks && data.perks.personal) || [];
        const mods = panel(panels, t('modifiers'), 'Achivement_icon');
        if (!own.length) mods.appendChild(el('div', 'ga-empty', t('noModifiers')));
        else {
            const halves = el('div', 'ga-mods');
            for (const [kind, list] of [
                ['bonus', own.filter(p => (p.points || 0) <= 0)],
                ['drawback', own.filter(p => (p.points || 0) > 0)],
            ]) {
                const half = el('div', 'ga-mods-half ' + kind);
                for (const p of list) half.appendChild(perkTile(p));
                halves.appendChild(half);
            }
            mods.appendChild(halves);
        }
    }

    // Arena's dashboard as the game lays it out: icons over victories, win rate, kills,
    // headshot kills, deaths and time online; then K/D, the streaks, defeats, quits and matches
    function arenaDash(data) {
        const a = arenaNumbers(arenaOverall(data.arenaStats));
        return {
            first: [['victories', a.wins], ['winrate', a.winFraction], ['kills', a.kills],
                ['headshots', a.headshots], ['deaths', a.deaths], ['online', arenaHours(data.arenaStats.time)]],
            second: [['kd', a.kd], ['winStreak', a.winStreak], ['loseStreak', a.loseStreak],
                ['losses', a.losses], ['left', a.left], ['games', a.games]],
        };
    }

    // Time online as Arena writes it: whole hours rounded, then the minutes ("1169h 42m")
    function arenaHours(seconds) {
        if (typeof seconds !== 'number') return '-';
        return `${Math.round(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    }

    // ARENA STATISTICS: a card per Arena mode, three to a row
    function arenaStatisticsSection(body, data) {
        const W = SCREEN_W - 48;
        const cardW = (W - 2 * 21) / 3;
        const wrap = put(body, 'div', 'ga-arena-cards', 24, 0, W, null);
        const modes = /** @type {Record<string, string>} */ (t('arenaModes'));
        const rows = /** @type {Record<string, string>} */ (t('arenaRows'));
        for (const mode of arenaModeKeys(data.arenaStats)) {
            const counters = mode === 'UnrankedOverall' ? arenaOverall(data.arenaStats) : data.arenaStats.modes[mode];
            const a = arenaNumbers(counters);
            const card = el('div', 'ga-statcard');
            card.style.width = `${cardW}px`;
            const head = el('div', 'ga-panel-head');
            // As in game: the mode's small logo, then "<mode> statistics"
            const logo = ARENA_MODE_LOGOS[mode];
            if (logo) head.appendChild(img(`${ARENA_ART}modes/${logo}.webp`, 'ga-mode-logo'));
            const name = modes[mode] || mode.replace(/^Unranked/, '');
            head.appendChild(el('span', '', /** @type {(name: string) => string} */ (t('modeStats'))(name)));
            card.appendChild(head);
            const list = el('div', 'ga-statlist');
            const line = (label, value) => {
                const row = el('div', 'ga-statrow');
                row.appendChild(el('span', 'ga-statrow-label', label));
                row.appendChild(el('span', 'ga-statrow-dots'));
                row.appendChild(el('span', 'ga-statrow-value', typeof value === 'number' ? value.toLocaleString('en-US') : value));
                list.appendChild(row);
            };
            // The worked-out rows first (the overall card opens with when the account was made),
            // then every counter the game keeps for the mode, in a fixed order, unknown ones last
            if (mode === 'UnrankedOverall' && data.registered) line(rows.registered, unixTime(data.registered));
            line(rows.kd, a.kd);
            if (typeof counters.ArenaWins === 'number') line(rows.winRate, `${percentOf(a.wins, a.games)}%`);
            line(rows.avgKills, a.games ? (a.kills / a.games).toFixed(2) : '0');
            if (typeof counters.Headshots === 'number') line(rows.headshotRate, `${percentOf(a.headshots, a.kills)}%`);
            const known = /** @type {Record<string, string>} */ (t('arenaCounters'));
            const keys = Object.keys(counters || {});
            for (const key of [...ARENA_COUNTER_ORDER.filter(k => keys.includes(k)), ...keys.filter(k => !ARENA_COUNTER_ORDER.includes(k))]) {
                line(known[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2'), counters[key]);
            }
            card.appendChild(list);
            wrap.appendChild(card);
        }
        if (!wrap.children.length) wrap.appendChild(el('div', 'ga-empty', '-'));
    }

    // STATISTICS: every counter the lookup has, for the PMC and the Scav together and apart,
    // as three cards side by side
    function statisticsSection(body, data) {
        const views = /** @type {Record<string, string>} */ (t('statViews'));
        const rows = /** @type {Record<string, string>} */ (t('statRows'));
        ['overall', 'pmc', 'scav'].forEach((view, i) => {
            const s = dashStats(data.stats, view);
            const cardW = (SCREEN_W - 48 - 2 * 21) / 3;
            const card = put(body, 'div', 'ga-statcard', 24 + i * (cardW + 21), 0, cardW, null);
            const head = el('div', 'ga-panel-head');
            head.appendChild(el('span', '', views[view]));
            card.appendChild(head);
            const list = el('div', 'ga-statlist');
            const first = Object.fromEntries(s.first);
            for (const [key, value] of [
                ['raids', s.raids], ['survived', first.survived], ['rate', `${percentOf(first.survived, s.raids)} %`],
                ['kd', s.kd], ['totalKd', s.totalKd], ['pmcKills', s.pmcKills], ['aiKills', s.aiKills],
                ['kia', first.kia], ['mia', first.mia], ['awol', first.awol], ['runs', Object.fromEntries(s.second).runs],
                ['transits', s.transits], ['leave', `${s.leaveRate} %`], ['streak', Object.fromEntries(s.second).streak],
                ['online', first.online],
            ]) {
                const line = el('div', 'ga-statrow');
                line.appendChild(el('span', 'ga-statrow-label', rows[key]));
                line.appendChild(el('span', 'ga-statrow-dots'));
                line.appendChild(el('span', 'ga-statrow-value', typeof value === 'number' ? value.toLocaleString('en-US') : value));
                list.appendChild(line);
            }
            card.appendChild(list);
        });
    }

    // The skills to show, in the order picked: the game's own (default), most leveled first,
    // or most recently leveled first; only one class of skill, or all
    let _skillSort = 'default';
    let _skillType = 'all';
    function skillOrder(skills, sort, type) {
        const list = (skills || []).filter(s => type === 'all' || skillClass(s.id) === type);
        if (sort === 'level') return list.slice().sort((a, b) => (b.progress || 0) - (a.progress || 0));
        if (sort === 'recent') return list.slice().sort((a, b) => (b.lastAccess || 0) - (a.lastAccess || 0));
        // The game's own order, class by class as SKILL_CLASSES lists them; not the order a
        // profile happens to send them in, which differs between modes. Unknown skills go last
        const rank = id => {
            const i = GAME_SKILL_ORDER.indexOf(id);
            return i < 0 ? GAME_SKILL_ORDER.length : i;
        };
        return list.map((s, i) => [s, i]).sort(([a, i], [b, j]) => (rank(a.id) - rank(b.id)) || (i - j)).map(([s]) => s);
    }

    // One skill as the skills tab draws it (Detailed Skill Panel), at (x, y), with when it
    // last went up
    function skillRow(parent, skill, x, y, w) {
        const row = put(parent, 'div', 'ga-skill', x, y, w, 100);
        const progress = skill.progress || 0;
        const elite = progress >= ELITE_PROGRESS;
        const level = Math.floor(progress / 100);
        put(row, 'div', 'ga-skill-frame' + (elite ? ' is-elite' : ''), -4, 0, 104, 104);
        const icon = skillIcon(skill.id);
        if (icon) row.appendChild(at(img(icon, 'ga-abs'), 3, 7, 90, 90));
        const badge = put(row, 'div', 'ga-skill-levelpanel', 0, 75, 25, 25);
        if (elite) badge.appendChild(at(uiImg('elite_icon', 'ga-abs'), 6, 6, 14, 14));
        else badge.appendChild(el('span', 'ga-skill-levelnum', level));
        const cls = SKILL_CLASSES[skillClass(skill.id)];
        const type = put(row, 'div', 'ga-skill-type', 110, 2, 25, 25);
        type.style.backgroundColor = cls.color;
        const letters = /** @type {Record<string, string>} */ (t('skillClass'));
        type.appendChild(el('span', '', letters[skillClass(skill.id)]));
        put(row, 'div', 'ga-skill-name', 138, 5, w - 138 - 210, 20, loc(skill.name) || skill.id);
        if (skill.lastAccess) {
            const day = new Date(skill.lastAccess * 1000).toLocaleDateString(_lang === 'zh' ? 'zh-CN' : 'en-US', EFTForge.utils.atlasZoneOptions());
            put(row, 'div', 'ga-skill-last', w - 203, 7, 200, 18, `${t('lastUsed')} ${day}`);
        }
        const bar = put(row, 'div', 'ga-skill-bar', 110, 41, w - 110, 27);
        const fill = put(bar, 'div', 'ga-skill-fill' + (elite ? ' is-elite' : ''), 0, 0, 0, 27);
        fill.style.width = `${elite ? 100 : progress % 100}%`;
        fill.setAttribute('aria-hidden', 'true');
        const levelText = put(row, 'div', 'ga-skill-level', 113, 70, 561, 21);
        if (elite) levelText.appendChild(el('span', 'ga-elite', t('eliteLevel')));
        else levelText.textContent = `${t('levelColon')} ${level}`;
        const prog = put(row, 'div', 'ga-skill-progress', w - 300, 74, 297, 21);
        if (elite) prog.appendChild(el('span', 'ga-skill-progress-value', t('maxed')));
        else {
            prog.appendChild(el('b', 'ga-skill-progress-value', (progress % 100).toFixed(2)));
            prog.appendChild(document.createTextNode('/100'));
        }
    }

    // SKILLS AND ACHIEVEMENTS: the level and experience bar across the page, then the skills
    // (two columns) on the left half and the achievements on the right half
    function skillsSection(body, data) {
        const W = SCREEN_W - 48;
        const prog = put(body, 'div', 'ga-skillprog', 24, 0, W, 159);
        const level = data.level ?? _levels.get(String(data.accountId));
        const rank = rankIcon(level);
        if (rank) prog.appendChild(at(img(rank, 'ga-abs ga-contain'), 116, 30, 100, 100));
        put(prog, 'div', 'ga-level', 221, 44, 120, 72, level ?? '-');
        const bounds = data.levelExp;
        if (typeof level === 'number' && bounds && bounds.next) {
            const nextRank = rankIcon(level + 1);
            if (nextRank) prog.appendChild(at(img(nextRank, 'ga-abs ga-contain'), W - 316, 30, 100, 100));
            put(prog, 'div', 'ga-level', W - 211, 44, 120, 72, level + 1);
        }
        const current = put(prog, 'div', 'ga-exptext', 320, 85, 600, 27);
        current.appendChild(el('span', 'ga-exptext-label', t('expCurrent')));
        current.appendChild(document.createTextNode(spaced(data.experience)));
        const bar = put(prog, 'div', 'ga-expbar', 319, 56, W - 646, 27);
        if (bounds && bounds.next && typeof data.experience === 'number') {
            const fill = put(bar, 'div', 'ga-expbar-fill', 0, 0, 0, 27);
            fill.style.width = `${100 * Math.max(0, Math.min(1, (data.experience - bounds.current) / (bounds.next - bounds.current)))}%`;
            const remaining = put(prog, 'div', 'ga-exptext is-right', W - 927, 85, 600, 27);
            remaining.appendChild(el('span', 'ga-exptext-label', t('expRemaining')));
            remaining.appendChild(document.createTextNode(spaced(bounds.next - data.experience)));
        }
        const skills = ((data.skills && data.skills.common) || []);
        const half = (W - 24) / 2;
        // The game's Show and sort options over the skills, redrawing only the list
        const tools = put(body, 'div', 'ga-skilltools', 24, 179, half, 44);
        const list = put(body, 'div', 'ga-skilllist', 24, 235, half, 0);
        const colW = (half - 24 - 25) / 2;
        // A bar down the middle between the skills and the achievements, as tall as the longer
        const divider = put(body, 'div', 'ga-divider', 24 + half + 11, 179, 2, 0);
        let achCard = null;
        const sizeDivider = () => {
            const bottom = Math.max(list.offsetTop + list.offsetHeight, achCard ? achCard.offsetTop + achCard.offsetHeight : 0);
            divider.style.height = `${Math.max(0, bottom - 179)}px`;
        };
        const draw = () => {
            list.replaceChildren();
            const shown = skillOrder(skills, _skillSort, _skillType);
            list.style.height = `${Math.ceil(shown.length / 2) * 134 + 20}px`;
            if (!shown.length) put(list, 'div', 'ga-empty', 0, 20, half, 40, t('noSkills'));
            shown.forEach((skill, i) => skillRow(list, skill, 24 + (i % 2) * (colW + 25), 20 + Math.floor(i / 2) * 134, colW));
            sizeDivider();
            fitScreen();
        };
        const group = (label, options, current, set) => {
            const box = el('div', 'ga-skilltools-group');
            box.appendChild(el('span', 'ga-skilltools-label', label));
            const buttons = options.map(([key, text]) => {
                const btn = /** @type {HTMLButtonElement} */ (el('button', 'ga-seg' + (key === current() ? ' is-selected' : ''), text));
                btn.type = 'button';
                btn.addEventListener('click', () => {
                    set(key);
                    buttons.forEach(b => b.classList.toggle('is-selected', b === btn));
                    draw();
                });
                box.appendChild(btn);
                return btn;
            });
            tools.appendChild(box);
        };
        const types = /** @type {Record<string, string>} */ (t('skillTypes'));
        group(t('skillShow'), [['all', types.all], ['physical', types.physical], ['mental', types.mental],
            ['combat', types.combat], ['practical', types.practical]], () => _skillType, v => { _skillType = v; });
        const sorts = /** @type {Record<string, string>} */ (t('skillSorts'));
        group(t('skillSort'), [['default', sorts.default], ['level', sorts.level], ['recent', sorts.recent]],
            () => _skillSort, v => { _skillSort = v; });
        achCard = achievementsCard(body, data, 24 + half + 24, 179, half);
        draw();
    }

    // Which column each table is sorted by, kept across redraws
    const _sort = {};

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
        const table = el('table', 'ga-table');
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
            const btn = el('button', 'ga-sort', c.label);
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
        const wrap = el('div', 'ga-table-wrap');
        wrap.appendChild(table);
        return wrap;
    }

    // An icon and a label in one table cell
    function iconCell(src, text) {
        const cell = el('span', 'ga-iconcell');
        if (src) cell.appendChild(img(src, 'ga-cellicon'));
        cell.appendChild(el('span', '', text));
        return cell;
    }

    // The achievements: a slim summary (the progress, how many of each rarity), then every
    // achievement the player has in a compact table, sortable by any column, newest first
    function achievementsCard(body, data, x, y, w) {
        const ach = data.achievements || {};
        const prog = achievementProgress(ach);
        const card = put(body, 'div', 'ga-ach-card', x, y, w);
        // As the game's achievements tab: the text over the bar with the big count beside it,
        // then each rarity's count in a column of its own ("Common - 17")
        const summary = el('div', 'ga-ach-summary');
        const main = el('div', 'ga-ach-summary-main');
        main.appendChild(el('div', 'ga-ach-text', prog.text));
        const row = el('div', 'ga-ach-barrow');
        progressBar(row, prog.total ? prog.done / prog.total : 0);
        row.appendChild(bigCount(prog.done, prog.total));
        main.appendChild(row);
        summary.appendChild(main);
        const rarities = /** @type {Record<string, string>} */ (t('rarity'));
        const counts = el('div', 'ga-ach-rarities');
        for (const r of ['Common', 'Rare', 'Legendary', 'Seasonal']) {
            const n = (ach.done || []).filter(a => a.rarity === r).length;
            // Seasonal only where the mode has them
            if (r === 'Seasonal' && !n) continue;
            counts.appendChild(el('div', `ga-ach-rarity is-${r.toLowerCase()}`, `${rarities[r]} - ${n}`));
        }
        summary.appendChild(counts);
        card.appendChild(summary);
        const done = ach.done || [];
        if (!done.length) {
            card.appendChild(el('div', 'ga-empty', t('noAchievements')));
            return card;
        }
        const name = a => loc({ en: a.en?.name, ch: a.ch?.name }) || a.id;
        const desc = a => loc({ en: a.en?.description, ch: a.ch?.description });
        const order = ['Common', 'Rare', 'Legendary', 'Seasonal'];
        card.appendChild(sortableTable('achievements', [
            { label: t('achName'), value: name, cell: a => iconCell(achievementIcon(a.id, isArena(data)), name(a)) },
            { label: t('achDescription'), value: desc, cell: desc, className: 'ga-table-desc' },
            { label: t('achRarity'), value: a => order.indexOf(a.rarity), desc: true,
                cell: a => el('span', `ga-ach-rarityname is-${String(a.rarity || 'common').toLowerCase()}`, rarities[a.rarity] || a.rarity || '-') },
            { label: t('achPlayers'), value: a => a.percent, cell: a => (typeof a.percent === 'number' ? `${a.percent}%` : '-'), className: 'num' },
            { label: t('achDate'), value: a => a.at, cell: a => unixTime(a.at), className: 'num', desc: true },
        ], done, { col: 4, dir: -1 }));
        return card;
    }

    // One section of the page: an Atlas header band with the game's icon, then its body,
    // which is laid out in the game's coordinates and sized to what's in it (fitScreen)
    function section(screen, icon, title) {
        const sec = el('section', 'ga-section');
        const head = el('div', 'ga-section-head');
        if (icon) head.appendChild(uiMask(icon, 'ga-section-icon'));
        head.appendChild(el('span', '', title));
        sec.appendChild(head);
        const body = el('div', 'ga-section-body');
        sec.appendChild(body);
        screen.appendChild(sec);
        return body;
    }

    function renderScreen(data) {
        const screen = $('atlas-lookup-screen');
        screen.replaceChildren();
        const titles = /** @type {Record<string, string>} */ (t('tabs'));
        profileSection(section(screen, 'tab_icon_overall', titles.overall), data);
        if (isArena(data)) {
            // Arena: its modes' counters, then the achievements (it has no skills)
            arenaStatisticsSection(section(screen, 'tab_icon_overall', t('statistics')), data);
            achievementsCard(section(screen, 'tab_icon_skills', t('achievements').toUpperCase()), data, 24, 0, SCREEN_W - 48);
        } else {
            statisticsSection(section(screen, 'tab_icon_overall', t('statistics')), data);
            skillsSection(section(screen, 'tab_icon_skills', t('skillsAndAchievements')), data);
        }
        renderBoard(data);
        // When this profile was looked up sits beside the search bar, not in the account row
        $('atlas-lookup-when').textContent =
            `${t('when')}: ${formatTime(data.looked_up, true)}${data.cached ? ` (${t('cached')})` : ''}`;
        fitScreen();
    }

    /* ===========================
       SEASONAL MODIFIERS: an icon each, with the game's text on hover
    =========================== */

    // A seasonal modifier's icon, tarkov.dev's copy named by the modifier's id
    function perkIcon(perk) {
        const id = perk && String(perk.id);
        return id && /^[0-9a-f]{24}$/.test(id) ? `${TARKOV_DEV_ART}${id}.webp` : null;
    }

    // A modifier's hover card: its name, its points, and what it does, a line each
    function perkTooltipHtml(perk) {
        const name = loc({ en: perk.en?.name, ch: perk.ch?.name }) || perk.id;
        const lines = loc({ en: perk.en?.description, ch: perk.ch?.description })
            .split('\n').map(line => line.replace(/^[\s•·-]+/, '').trim()).filter(Boolean);
        const fmt = /** @type {(n: number) => string} */ (t('points'));
        return `<div class="atlas-lookup-perk-tip-name">${escapeHtml(name)}</div>`
            + (perk.points ? `<div class="atlas-lookup-perk-tip-points">${escapeHtml(fmt(perk.points))}</div>` : '')
            + (lines.length ? `<ul class="atlas-lookup-perk-tip-list">${lines.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : '');
    }

    // One modifier: the game's icon, or its name while we have no icon for it
    function perkTile(perk) {
        const tile = el('span', 'atlas-lookup-perk');
        const icon = perkIcon(perk);
        if (icon) tile.appendChild(img(icon, 'atlas-lookup-perk-icon'));
        tile.appendChild(el('span', 'atlas-lookup-perk-name', loc({ en: perk.en?.name, ch: perk.ch?.name }) || perk.id));
        return tipHtml(tile, perkTooltipHtml(perk));
    }

    /* ===========================
       PAGE
    =========================== */

    function renderResult(data) {
        $('atlas-lookup-result').hidden = false;
        renderScreen(data);
    }

    function showStatus(text, isError) {
        const status = $('atlas-lookup-status');
        status.classList.remove('has-card');
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

    function showError(res, query) {
        const detail = res.body && res.body.detail;
        showErrorCard(errorInfo(res.status, detail && detail.error), query, res.status);
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
            const res = await getJSON(`${API}?accountId=${encodeURIComponent(accountId)}&mode=${encodeURIComponent(_mode)}`);
            if (!res.ok) { showError(res, String(accountId)); return; }
            $('atlas-lookup-key').hidden = true;
            showStatus('', false);
            _failed = null;
            _last = res.body;
            _open = null;   // a new profile opens no weapon until one is clicked
            renderResult(res.body);
        });
    }

    async function lookup(text) {
        $('atlas-lookup-when').textContent = '';
        const kind = queryKind(text);
        if (!kind) {
            showErrorCard(errorInfo(422, 'bad_nickname'), text);
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
            const res = await getJSON(`${API}/search?nickname=${encodeURIComponent(text)}&mode=${encodeURIComponent(_mode)}`);
            if (!res.ok) { showError(res, text); return; }
            $('atlas-lookup-key').hidden = true;
            players = (res.body && res.body.players) || [];
        });
        if (!players) return;
        for (const p of players) _levels.set(String(p.accountId), p.level);
        if (!players.length) {
            const titles = /** @type {Record<string, string>} */ (t('errTitles'));
            showErrorCard({ title: titles.noMatch, text: sentences(t('errNoMatch'), t('tryOtherModes')),
                iconName: 'search', modes: 'try' }, text);
            return;
        }
        _failed = null;
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
        $('atlas-tz-switch').setAttribute('aria-label', t('tzLabel'));
        if (_last) renderResult(_last);
    }

    // Look a player up by account ID from a link on the page: into the search box, the page
    // to the top, and the address (so Back returns to the player before)
    function openPlayer(accountId, push) {
        const input = /** @type {HTMLInputElement} */ ($('atlas-lookup-account'));
        input.value = accountId;
        if (push) history.pushState({ accountId }, '', `/atlas/players/?accountId=${encodeURIComponent(accountId)}`);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        lookup(accountId);
    }

    // A player named in the address (?accountId= or ?nickname=), as a link opens the page
    function playerFromAddress() {
        const params = new URLSearchParams(window.location.search);
        return (params.get('accountId') || params.get('nickname') || '').trim();
    }

    function init() {
        _lang = readStorage(LANG_STORAGE) === 'zh' ? 'zh' : 'en';
        const select = /** @type {HTMLSelectElement} */ ($('lang-select'));
        select.value = _lang;
        // the site's own dropdown in place of the native select, which styles.css hides
        setupCustomSelect('lang-select');
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
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && weaponPopover()) closeWeaponPopover();
        });
        document.addEventListener('mousedown', e => {
            const target = /** @type {Element} */ (e.target);
            if (!weaponPopover() || target.closest('#atlas-lookup-weapon-pop, #atlas-lookup-board .bw-slot.is-expandable')) return;
            closeWeaponPopover();
        });
        window.addEventListener('resize', positionWeaponPopover);
        // Back and forward step through the players opened from links
        window.addEventListener('popstate', () => {
            const id = playerFromAddress();
            if (id) openPlayer(id, false);
        });
        // Keep the game screen scaled to the page as the window changes
        if (typeof ResizeObserver === 'function') new ResizeObserver(() => fitScreen()).observe($('atlas-lookup-frame'));
        // The header's mode switch: only the modes with an account to look players up from
        _mode = EFTForge.atlasMode.init({
            page: 'players',
            available: GAME_MODES.filter(m => m.live).map(m => m.key),
            onSelect: mode => {
                _mode = mode;
                // a lookup that just failed is tried again in the new mode; otherwise the same
                // account is looked up in it (EFT's modes and Arena share account IDs)
                if (_failed) lookup(_failed);
                else if (_last && _last.accountId) view(String(_last.accountId));
            },
        }) || 'season';
        // UTC+8 or the viewer's own zone, shared with every Atlas page
        const syncZone = () => document.querySelectorAll('[data-atlas-tz]').forEach(b =>
            b.classList.toggle('active', (/** @type {HTMLElement} */ (b).dataset.atlasTz === 'local') === EFTForge.utils.atlasLocalTime()));
        document.querySelectorAll('[data-atlas-tz]').forEach(btn => btn.addEventListener('click', () => {
            const local = /** @type {HTMLElement} */ (btn).dataset.atlasTz === 'local';
            if (local === EFTForge.utils.atlasLocalTime()) return;
            EFTForge.utils.setAtlasLocalTime(local);
            syncZone();
            if (_last) renderResult(_last);
        }));
        syncZone();
        applyLanguage();
        const named = playerFromAddress();
        if (named) {
            input.value = named;
            lookup(named);
        }
    }

    return {
        init,
        // pure helpers, for frontend/tests/atlas-lookup.test.js
        _test: {
            itemName, shortName, slotLabel, partLabel, errorInfo, queryKind, builderLink, builderTree,
            prestigeIcon, achievementIcon, skillIcon, perkIcon, perkTooltipHtml, counter, insertSpot,
            openable, editions, dashStats, lastActive, spaced, rankIcon, skillClass, achievementProgress, sortRows, skillOrder,
        },
    };
})();

// After the scripts below it have loaded, so the attachment grid is there for a profile
// opened straight away from the remembered query
if (typeof document !== 'undefined' && document.getElementById('atlas-lookup-app')) {
    document.addEventListener('DOMContentLoaded', () => window.EFTForge.atlasLookup.init());
}
