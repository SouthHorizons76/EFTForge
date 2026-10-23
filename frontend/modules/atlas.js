window.EFTForge = window.EFTForge || {};

/* ============================================================
   ATLAS PAGE
   Standalone page at /atlas, and at /atlas/arena for Arena (the same page; the path
   picks the game). Lists the game data change sets served by /atlas/api (Arena's by
   /atlas/api/arena), newest first. Without an access key the
   backend only returns sets older than its public delay; a key saved here
   (localStorage, this browser only) goes out as X-Atlas-Key and unlocks all of them.
   Render the full diff so its scrollbar reflects every row, and populate collapsed
   groups when opened.
   Everything from the data goes in through textContent, never innerHTML.
============================================================ */

window.EFTForge.atlas = (function () {

    const GAME = typeof location !== 'undefined' && /^\/atlas\/arena(\/|$)/i.test(location.pathname) ? 'arena' : 'eft';
    const API  = GAME === 'arena' ? '/atlas/api/arena' : '/atlas/api';
    const KEY_STORAGE  = 'eftforge_atlas_key';   // one key for both games
    const LANG_STORAGE = 'eftforge_lang';   // shared with the rest of the site
    const ID_RE         = /^[0-9a-f]{24}$/;
    const LEADING_ID_RE = /^([0-9a-f]{24})(?: |$)/;   // "<id>" or a locale key like "<id> Name"
    const AUTO_OPEN     = 12;    // open every group when a view has this few
    const SEARCH_VALUE_CHARS = 4000;  // how much of a big value the search looks at
    const LARGE_CHARS        = 1500;  // values longer than this collapse unless "large values" is on
    const LAYOUT_STORAGE = 'eftforge_atlas_layout';
    const TOC_STORAGE    = 'eftforge_atlas_toc';   // '0' when the file list is collapsed
    const ICON_URL = id => `https://assets.tarkov.dev/${id}-icon.webp`;
    const ENTRANCE_DIFFS = '.atlas-file-heading, .atlas-group-summary, .atlas-row, .atlas-raw-node, .atlas-raw-line';
    let _entranceSets = true;
    let _entranceDiffs = true;

    // Measure visible rows together before adding animation styles, as we do for the gun grid.
    /**
     * @param {HTMLElement} container
     * @param {string} selector
     */
    function visibleEntranceRows(container, selector) {
        const bounds = container.getBoundingClientRect();
        const candidates = /** @type {NodeListOf<HTMLElement>} */ (container.querySelectorAll(selector));
        return Array.from(candidates).filter(node => {
            const r = node.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.bottom > bounds.top && r.top < bounds.bottom
                && r.right > bounds.left && r.left < bounds.right;
        });
    }

    function staggerVisible(container, selector) {
        if (_breached) return false;
        container.querySelectorAll('.atlas-entering').forEach(node => node.classList.remove('atlas-entering'));
        const visible = visibleEntranceRows(container, selector);
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return visible.length > 0;
        visible.forEach((node, i) => {
            node.style.setProperty('--atlas-entrance-delay', `${i * 22}ms`);
            node.classList.add('atlas-entering');
            node.addEventListener('animationend', function finish(e) {
                if (e.target !== node || e.animationName !== 'gunCardEntrance') return;
                node.classList.remove('atlas-entering');
                node.style.removeProperty('--atlas-entrance-delay');
                node.removeEventListener('animationend', finish);
            });
        });
        return visible.length > 0;
    }

    function enterVisibleSets() {
        if (_entranceSets && staggerVisible($('atlas-set-list'), '.atlas-set-item')) _entranceSets = false;
    }

    function enterVisibleDiffs() {
        if (_entranceDiffs && staggerVisible($('atlas-groups'), ENTRANCE_DIFFS)) _entranceDiffs = false;
    }

    function startPageEntrances() {
        _entranceSets = _entranceDiffs = true;
        enterVisibleSets();
        enterVisibleDiffs();
    }

    const STRINGS = {
        en: {
            pageTitle:       game => game === 'arena' ? 'Atlas - Arena Change Tracker' : 'Atlas - Change Tracker',
            gameLabel:       'Game',
            gameEft:         'Tarkov',
            gameArena:       'Arena',
            sets:            'Change sets',
            loading:       'Loading...',
            noSets:          'No change sets yet.',
            lockedTitle:     'Not public yet',
            lockedText:      h => `Change sets go public ${h} hours after they are detected.`,
            countdown:       (h, m) => h ? `${h} h ${m} min` : `${m} min`,
            countdownSoon:   'Less than a minute',
            factOpens:       'Opens',
            factLeft:        'Time left',
            factRequest:     'Request',
            factStatus:      'Status',
            factSearch:      'Search',
            factFile:        'File',
            factKinds:       'Kinds shown',
            noResponse:      'No response',
            none:            'None',
            reqIndex:        'Change set list',
            reqSet:          id => `Change set ${id}`,
            haveKey:         'If you are provided an access key, please enter it below.',
            enterKey:        'Enter access key',
            keyTitle:        'Access key not accepted',
            rateTitle:       'Too many attempts',
            unavailableTitle: 'Atlas is unavailable',
            networkTitle:    'Connection problem',
            setErrTitle:     'Could not load this change set',
            retry:           'Try again',
            noMatchTitle:    'No matching changes',
            noMatchText:     'Nothing in this set matches the search, file and kinds you picked.',
            clearFilters:    'Clear filters',
            noSetsTitle:     'No change sets yet',
            noSetsText:      'Changes show up here as soon as they are detected.',
            accessPublic:    'Public',
            accessKey:       'Whitelist',
            accessAdmin:     'Admin',
            breach:          'The watermark on this page was removed or covered, so its contents were cleared. Reload the page to continue.',
            keyBtn:          'Access key',
            keyPlaceholder:  'Paste your access key',
            keySave:         'Save',
            keyRemove:       'Remove',
            confirm:         'Confirm?',
            keyNote:         'Stored in this browser only.',
            keyRejected:     'Key rejected',
            keyHeading:      'Access',
            keyId:           'Watermark id',
            keyName:         'Name',
            unread:          'Not opened yet',
            badgeOn:         'New change set badge: on',
            badgeOff:        'New change set badge: off',
            keyEnding:       'Key',
            keyWhitelist:    'Whitelist key',
            keyAdmin:        'Admin key',
            errKey:          'This access key was not accepted. It may be wrong, expired or revoked.',
            errRate:         'Too many wrong keys. Try again in a few minutes.',
            errUnavailable:  'Atlas is not available right now.',
            errNetwork:      'Could not reach the server.',
            errSet:          'This change set could not be loaded.',
            search:          'Search names, ids, paths, values',
            byFile:          'File',
            byItem:          'Item',
            viewLabel:       'View',
            tocTitle:        'FILES',
            tocHint:         '[ ] to jump',
            tocCollapse:     'Hide file list',
            tocExpand:       'Show file list',
            groupByLabel:    'Group by',
            showLabel:       'Show',
            added:           'Added',
            removed:         'Removed',
            changed:         'Changed',
            allFiles:        'All files',
            changes:         n => n === 1 ? '1 change' : `${n} changes`,
            files:           n => n === 1 ? '1 file' : `${n} files`,
            wholeFile:       '(whole file)',
            detected:        'Detected',
            version:         'Version',
            showing:         (n, total) => `Showing ${n} of ${total}`,
            layoutGrouped:   'Grouped',
            layoutRaw:       'Raw diff',
            showValue:       'Show value',
            hideValue:       'Hide value',
            valueLines:      n => `${n.toLocaleString('en-US')} ${n === 1 ? 'line' : 'lines'}`,
            loadingValue:    'Loading value...',
            errValue:        'Could not load this value. Click to try again.',
            tagOld:          '(Old)',
            tagNew:          '(New)',
            tagRemoved:      '(Removed)',
            exportBtn:       'Export',
            exporting:       'Exporting...',
            exportFailed:    'Export failed',
        },
        zh: {
            pageTitle:       game => game === 'arena' ? 'Atlas - 竞技场变动追踪器' : 'Atlas - 变动追踪器',
            gameLabel:       '游戏',
            gameEft:         '逃离塔科夫',
            gameArena:       '竞技场',
            sets:            '变动记录',
            loading:       '加载中...',
            noSets:          '暂无变动记录。',
            lockedTitle:     '尚未公开',
            lockedText:      h => `变动记录在检测到 ${h} 小时后公开。`,
            countdown:       (h, m) => h ? `${h} 小时 ${m} 分钟` : `${m} 分钟`,
            countdownSoon:   '不到一分钟',
            factOpens:       '公开时间',
            factLeft:        '剩余时间',
            factRequest:     '请求',
            factStatus:      '状态',
            factSearch:      '搜索',
            factFile:        '文件',
            factKinds:       '显示类型',
            noResponse:      '无响应',
            none:            '无',
            reqIndex:        '变动记录列表',
            reqSet:          id => `变动记录 ${id}`,
            haveKey:         '如果您获得了访问密钥，请在下方输入。',
            enterKey:        '输入访问密钥',
            keyTitle:        '访问密钥无效',
            rateTitle:       '尝试次数过多',
            unavailableTitle: 'Atlas 暂不可用',
            networkTitle:    '连接出现问题',
            setErrTitle:     '无法加载该变动记录',
            retry:           '重试',
            noMatchTitle:    '没有匹配的变动',
            noMatchText:     '该记录中没有符合当前搜索、文件和类型筛选的变动。',
            clearFilters:    '清除筛选',
            noSetsTitle:     '暂无变动记录',
            noSetsText:      '检测到变动后会立即显示在这里。',
            accessPublic:    '公开',
            accessKey:       '白名单',
            accessAdmin:     '管理员',
            breach:          '本页面的水印被移除或遮挡，内容已清空。请刷新页面后继续。',
            keyBtn:          '访问密钥',
            keyPlaceholder:  '粘贴访问密钥',
            keySave:         '保存',
            keyRemove:       '移除',
            confirm:         '确认？',
            keyNote:         '仅保存在此浏览器中。',
            keyRejected:     '密钥无效',
            keyHeading:      '访问权限',
            keyId:           '水印编号',
            keyName:         '名称',
            unread:          '尚未查看',
            badgeOn:         '新变动记录角标：开',
            badgeOff:        '新变动记录角标：关',
            keyEnding:       '密钥',
            keyWhitelist:    '白名单密钥',
            keyAdmin:        '管理员密钥',
            errKey:          '访问密钥无效，可能有误、已过期或已被撤销。',
            errRate:         '错误次数过多，请几分钟后再试。',
            errUnavailable:  'Atlas 暂不可用。',
            errNetwork:      '无法连接服务器。',
            errSet:          '无法加载该变动记录。',
            search:          '搜索名称、ID、路径、数值',
            byFile:          '文件',
            byItem:          '物品',
            viewLabel:       '视图',
            tocTitle:        '文件',
            tocHint:         '[ ] 键切换',
            tocCollapse:     '收起文件列表',
            tocExpand:       '展开文件列表',
            groupByLabel:    '分组依据',
            showLabel:       '显示',
            added:           '新增',
            removed:         '移除',
            changed:         '修改',
            allFiles:        '全部文件',
            changes:         n => `${n} 处变动`,
            files:           n => `${n} 个文件`,
            wholeFile:       '（整个文件）',
            detected:        '检测时间',
            version:         '版本',
            showing:         (n, total) => `显示 ${n} / ${total}`,
            layoutGrouped:   '分组',
            layoutRaw:       '原始差异',
            showValue:       '显示内容',
            hideValue:       '隐藏内容',
            valueLines:      n => `${n.toLocaleString('zh-CN')} 行`,
            loadingValue:    '加载中……',
            errValue:        '无法加载该内容，点击重试。',
            tagOld:          '（旧）',
            tagNew:          '（新）',
            tagRemoved:      '（移除）',
            exportBtn:       '导出',
            exporting:       '导出中……',
            exportFailed:    '导出失败',
        },
    };

    /* ===========================
       DATA (no DOM, unit tested)
    =========================== */

    function idIn(seg) {
        if (typeof seg !== 'string') return null;
        const m = LEADING_ID_RE.exec(seg);
        return m ? m[1] : null;
    }

    // The backend's names map uses "ch" for Chinese; the app's language code is "zh".
    function nameOf(id, names, lang) {
        const n = names && names[id];
        if (!n) return null;
        return (lang === 'zh' ? (n.ch || n.en) : (n.en || n.ch)) || null;
    }

    // "client/items/prices/<trader>" -> "items/prices/Ragman"
    function fileLabel(file, names, lang) {
        return file.replace(/^client\//, '').split('/')
            .map(part => (ID_RE.test(part) && nameOf(part, names, lang)) || part)
            .join('/');
    }

    function clip(value) {
        if (value === undefined) return '';
        const s = typeof value === 'string' ? value : JSON.stringify(value);
        return s.length > SEARCH_VALUE_CHARS ? s.slice(0, SEARCH_VALUE_CHARS) : s;
    }

    // Flatten a set into one row per change. Each row knows which path segment it
    // groups under: the first one carrying an id (an item, trader, quest...), or the
    // first key under "data" when there is none.
    function prepare(set) {
        const names = set.names || {};
        const rows = [];
        (set.files || []).forEach((f, fileIdx) => {
            const fileIds = f.file.split('/').filter(p => ID_RE.test(p));
            for (const change of f.changes || []) {
                const path = change.path || [];
                const start = path[0] === 'data' ? 1 : 0;
                let at = -1;
                for (let i = start; i < path.length; i++) {
                    if (idIn(path[i])) { at = i; break; }
                }
                if (at === -1 && path.length > start) at = start;
                const id = at >= 0 ? idIn(path[at]) : null;
                const words = [f.file, ...path.map(String)];
                for (const i of [...fileIds, ...path.map(idIn)]) {
                    if (i && names[i]) words.push(names[i].en || '', names[i].ch || '');
                }
                for (const v of [change.old, change.new]) {
                    if (typeof v === 'string' && ID_RE.test(v) && names[v]) words.push(names[v].en || '', names[v].ch || '');
                    words.push(clip(v));
                }
                rows.push({ file: f.file, fileIdx, change, at, id, search: words.join('\n').toLowerCase() });
            }
        });
        return rows;
    }

    // kinds: the change kinds to keep (any iterable), or null for all of them
    function filterRows(rows, { kinds = null, file = '', query = '' } = {}) {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const keep = kinds ? new Set(kinds) : null;
        return rows.filter(r =>
            (!keep || keep.has(r.change.kind)) &&
            (!file || r.file === file) &&
            terms.every(t => r.search.includes(t)));
    }

    // mode "file": one group per file and segment; "item": one group per id across
    // files (rows without an id still group per file and segment).
    function groupRows(rows, mode) {
        const groups = new Map();
        for (const r of rows) {
            const seg = r.at >= 0 ? String(r.change.path[r.at]) : '';
            const key = mode === 'item' && r.id ? r.id : `${r.file}\u0000${r.id || seg}`;
            let g = groups.get(key);
            if (!g) {
                g = { key, id: r.id, seg: r.id ? r.id : seg, file: r.file, fileIdx: r.fileIdx,
                      files: new Set(), rows: [], counts: { added: 0, removed: 0, changed: 0 } };
                groups.set(key, g);
            }
            g.files.add(r.file);
            g.rows.push(r);
            g.counts[r.change.kind] = (g.counts[r.change.kind] || 0) + 1;
        }
        return [...groups.values()];
    }

    // The path below the group's own segment. A locale key like "<id> Description"
    // keeps its "Description" part.
    function restPath(row) {
        const path = row.change.path || [];
        if (row.at < 0) return path.slice();
        const seg = path[row.at];
        const rest = path.slice(row.at + 1);
        if (row.id && typeof seg === 'string' && seg.length > row.id.length) rest.unshift(seg.slice(row.id.length + 1));
        return rest;
    }

    function numericDelta(oldV, newV) {
        if (typeof oldV !== 'number' || typeof newV !== 'number') return null;
        const d = Number((newV - oldV).toPrecision(12));
        return d === 0 ? null : d;
    }

    // {"$atlas_value": n, "bytes": size} stands in for a value too large for the set
    // file; the value itself is fetched from /atlas/api/sets/<id>/values/<n> on demand.
    function largeRef(v) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
        const ref = v['$atlas_value'];
        return Number.isInteger(ref) && typeof v.bytes === 'number' ? { ref, bytes: v.bytes } : null;
    }

    // A scalar as the grouped view shows it: JSON, except that a string's line breaks
    // stay real breaks instead of turning into \n. Every other escape stays visible.
    function scalarText(v) {
        if (typeof v !== 'string') return JSON.stringify(v);
        return `"${v.split('\n').map(part => JSON.stringify(part).slice(1, -1)).join('\n')}"`;
    }

    function formatBytes(n) {
        if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
        if (n >= 1024) return `${Math.round(n / 1024)} KB`;
        return `${n} B`;
    }

    // Raw view order: by file, then by path compared segment by segment as strings,
    // the same order the text reports use.
    function compareRows(a, b) {
        if (a.fileIdx !== b.fileIdx) return a.fileIdx - b.fileIdx;
        const pa = a.change.path || [], pb = b.change.path || [];
        for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
            const x = String(pa[i]), y = String(pb[i]);
            if (x !== y) return x < y ? -1 : 1;
        }
        return pa.length - pb.length;
    }

    // "(+0.21%)" for a changed number, like the text diffs; null when it doesn't apply.
    function percentChange(oldV, newV) {
        if (typeof oldV !== 'number' || typeof newV !== 'number' || oldV === 0 || oldV === newV) return null;
        const pct = (newV - oldV) / Math.abs(oldV) * 100;
        return `(${pct > 0 ? '+' : ''}${pct.toFixed(2)}%)`;
    }

    // The raw view as a flat list of lines, laid out like tarkov-changes' diffs: per
    // file, a tree of path segments where each segment is printed once (indented four
    // spaces per level) and the changes hang under it. A changed value prints Old/New
    // under its own key; an added or removed key prints "(New) ['key']: value" under
    // its parent. Rows must already be sorted (compareRows).
    function rawEntries(rows) {
        const out = [];
        let file = null;
        let stack = [];
        for (const r of rows) {
            if (r.file !== file) {
                file = r.file;
                stack = [];
                out.push({ type: 'file', file });
            }
            const { kind, old: oldV, new: newV } = r.change;
            const path = r.change.path || [];
            const nodes = kind === 'changed' ? path : path.slice(0, -1);
            let common = 0;
            while (common < stack.length && common < nodes.length && stack[common] === String(nodes[common])) common++;
            for (let d = common; d < nodes.length; d++) out.push({ type: 'node', depth: d, seg: nodes[d] });
            stack = nodes.map(String);
            const depth = Math.max(path.length - 1, 0);
            const key = kind === 'changed' || !path.length ? null : path[path.length - 1];
            if (kind !== 'added') out.push({ type: 'leaf', sign: '-', tag: kind === 'removed' ? 'removed' : 'old', depth, key, value: oldV });
            if (kind !== 'removed') {
                out.push({ type: 'leaf', sign: '+', tag: 'new', depth, key, value: newV,
                           pct: kind === 'changed' ? percentChange(oldV, newV) : null });
            }
        }
        return out;
    }

    // The refs of every large value a set holds in place of the value itself.
    function largeRefsIn(set) {
        const refs = new Set();
        for (const f of set.files || []) {
            for (const c of f.changes || []) {
                for (const v of [c.old, c.new]) {
                    const ext = largeRef(v);
                    if (ext) refs.add(ext.ref);
                }
            }
        }
        return [...refs];
    }

    // The whole set as text, laid out like the raw view. A file has no tooltips, so a
    // known id keeps its id and gets its name after it. values maps a large value's ref
    // to the value itself, so those print in full.
    function exportText(set, lang, values) {
        const s = STRINGS[lang] || STRINGS.en;
        const names = set.names || {};
        const key = seg => {
            const text = String(seg);
            const id = idIn(text);
            const name = id ? nameOf(id, names, lang) : null;
            return name ? `['${text}'] ${name}` : `['${text}']`;
        };
        const scalar = v => {
            if (typeof v !== 'string') return JSON.stringify(v);
            const name = ID_RE.test(v) ? nameOf(v, names, lang) : null;
            return name ? `${v} (${name})` : v;
        };
        const lines = [`${s.version}: ${set.version}`, `${s.detected}: ${set.detected}`, s.changes(set.total)];
        for (const e of rawEntries(prepare(set).sort(compareRows))) {
            if (e.type === 'file') {
                lines.push('', `${e.file}/response.json`);
                continue;
            }
            if (e.type === 'node') {
                lines.push(' '.repeat(4 * e.depth) + key(e.seg));
                continue;
            }
            const ext = largeRef(e.value);
            const v = ext ? values.get(ext.ref) : e.value;
            const tag = e.tag === 'new' ? s.tagNew : e.tag === 'old' ? s.tagOld : s.tagRemoved;
            const text = v !== null && typeof v === 'object' ? JSON.stringify(v, null, 2) : scalar(v);
            const [first, ...rest] = text.split('\n');
            const indent = `${e.sign}${' '.repeat(4 * e.depth + 4)}`;
            lines.push(`${e.sign}${' '.repeat(4 * e.depth)}${tag} ${e.key != null ? `${key(e.key)}: ` : ''}${first}${e.pct ? ` ${e.pct}` : ''}`);
            for (const l of rest) lines.push(indent + l);
        }
        return lines.join('\n') + '\n';
    }

    function exportName(set) {
        return `atlas-${set.game === 'arena' ? 'arena-' : ''}${set.version}-${set.id}.txt`.replace(/[^\w.-]+/g, '_');
    }

    /* ===========================
       STATE
    =========================== */

    let _lang     = 'en';
    let _index    = null;     // backend index response
    let _setId    = null;
    let _set      = null;     // the selected set as served
    let _rows     = [];       // prepare(_set)
    let _groups   = [];       // current view
    let _layout   = 'grouped';   // 'grouped' | 'raw'
    let _rawLines = [];          // raw view, rawEntries()
    let _mode     = 'file';
    const _kinds  = new Set(['added', 'removed', 'changed']);   // kinds shown
    let _file     = '';
    let _query    = '';
    let _searchTimer = null;
    let _loadToken   = 0;
    let _tocFiles    = [];   // files in the navigator, in list order
    let _tocActive   = '';
    let _countdownTimer = 0;
    let _clockOffset = 0;      // server clock minus ours, from the last index
    const _autoReloaded = new Map();   // set id -> when the countdown last reloaded for it
    let _redrawState = null;   // redraws the state panel on a language switch
    const _setCache  = new Map();
    const _valueCache = new Map();   // '<set id>/<n>' -> Promise of a large value

    function t(key, ...args) {
        const s = (STRINGS[_lang] || STRINGS.en)[key];
        return typeof s === 'function' ? s(...args) : s;
    }

    function readStorage(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    }

    function writeStorage(key, value) {
        try {
            if (value == null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        } catch { /* private mode: the key just won't persist */ }
    }

    function $(id) { return document.getElementById(id); }

    function el(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
    }

    // Show UTC+8 in both languages, regardless of the browser's local zone.
    function formatTime(iso) {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        if (_lang === 'zh') {
            const text = new Intl.DateTimeFormat('zh-CN', {
                timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric',
                hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
            }).format(d);
            return `${text}（UTC+8）`;
        }
        const text = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit',
        }).format(d);
        return `${text} (UTC+8)`;
    }

    /* ===========================
       API
    =========================== */

    async function getJSON(path) {
        const headers = {};
        const key = readStorage(KEY_STORAGE);
        // Access keys all start with atl_; anything else in the field is the admin key
        if (key) headers[key.startsWith('atl_') ? 'X-Atlas-Key' : 'X-Admin-Key'] = key;
        let res;
        try {
            res = await fetch(`${EFTForge.config?.API_BASE || ''}${path}`, { headers });
        } catch {
            throw { status: 0 };
        }
        if (!res.ok) throw { status: res.status };
        return res.json();
    }

    function errorText(err, fallback) {
        const status = err && err.status;
        if (status === 403) return t('errKey');
        if (status === 429) return t('errRate');
        if (status === 503) return t('errUnavailable');
        if (status === 0) return t('errNetwork');
        return fallback;
    }

    /* ===========================
       HEADER, KEY PANEL, LANGUAGE
    =========================== */

    function applyStaticText() {
        document.documentElement.lang = _lang === 'zh' ? 'zh-CN' : 'en';
        document.title = t('pageTitle', GAME);
        $('atlas-game-switch').setAttribute('aria-label', t('gameLabel'));
        $('atlas-key-btn').setAttribute('aria-label', t('keyBtn'));
        $('atlas-key-heading').textContent = t('keyHeading');
        $('atlas-toc-toggle').dataset.tooltip = t($('atlas-toc').classList.contains('collapsed') ? 'tocExpand' : 'tocCollapse');
        $('atlas-sets-title').textContent = t('sets');
        renderBadgeToggle();
        /** @type {HTMLInputElement} */ ($('atlas-key-input')).placeholder = t('keyPlaceholder');
        $('atlas-key-save').textContent = t('keySave');
        clearConfirm($('atlas-key-remove'));
        $('atlas-key-remove').textContent = t('keyRemove');
        $('atlas-key-note').textContent = t('keyNote');
        /** @type {HTMLInputElement} */ ($('atlas-search')).placeholder = t('search');
        document.querySelectorAll('[data-atlas-text]').forEach(node => {
            node.textContent = t(/** @type {HTMLElement} */ (node).dataset.atlasText);
        });
        const langSelect = /** @type {HTMLSelectElement} */ ($('lang-select'));
        if (langSelect.value !== _lang) {
            langSelect.value = _lang;
            langSelect.dispatchEvent(new Event('input'));   // refresh the custom select's trigger
        }
        if (!$('atlas-key-panel').hidden) renderKeyPanel();
        else $('atlas-key-remove').hidden = !readStorage(KEY_STORAGE);
        if (!_set) renderKindChips(null);
        syncToggles();
    }

    function syncToggles() {
        document.querySelectorAll('[data-atlas-layout]').forEach(b =>
            b.classList.toggle('active', /** @type {HTMLElement} */ (b).dataset.atlasLayout === _layout));
        document.querySelectorAll('[data-atlas-mode]').forEach(b =>
            b.classList.toggle('active', /** @type {HTMLElement} */ (b).dataset.atlasMode === _mode));
        document.querySelectorAll('[data-atlas-kind]').forEach(b => {
            const kind = /** @type {HTMLElement} */ (b).dataset.atlasKind;
            b.classList.toggle('active', _kinds.has(kind));
            b.setAttribute('aria-pressed', String(_kinds.has(kind)));
        });
        $('atlas-mode-toggle').hidden = _layout === 'raw';
    }

    function setLang(lang) {
        if (lang === _lang || _breached) return;
        _lang = lang;
        writeStorage(LANG_STORAGE, lang);
        applyStaticText();
        renderAccess();
        renderSetList();
        if (_set) renderSet();
        else if (_redrawState) _redrawState();
    }

    function toggleKeyPanel(open) {
        const panel = $('atlas-key-panel');
        panel.hidden = open == null ? !panel.hidden : !open;
        $('atlas-key-btn').setAttribute('aria-expanded', String(!panel.hidden));
        if (panel.hidden) return;
        renderKeyPanel();
        placeKeyPanel();
        if (!$('atlas-key-input').hidden) $('atlas-key-input').focus();
    }

    // Align the left edge with the button so we can open toward the right without clipping.
    function placeKeyPanel() {
        const panel = $('atlas-key-panel');
        if (panel.hidden) return;
        const r = $('atlas-key-btn').getBoundingClientRect();
        const top = Math.min(Math.round(r.bottom + 8), window.innerHeight - 12);
        const left = Math.max(12, Math.min(Math.round(r.left), window.innerWidth - panel.offsetWidth - 12));
        panel.style.top = `${top}px`;
        panel.style.left = `${left}px`;
        panel.style.right = 'auto';
        panel.style.maxHeight = `${Math.max(0, window.innerHeight - top - 12)}px`;
    }

    // A saved key the server accepted: show what it is (the watermark id, the end of the
    // key) and Remove. Otherwise (none, or one that was rejected): the input to enter one.
    function renderKeyPanel() {
        const key = readStorage(KEY_STORAGE);
        const accepted = !!key && !!_index && _index.access !== 'public';
        const rejected = !!key && _accessStatus === 403;
        const info = $('atlas-key-info');
        info.hidden = !accepted;
        for (const id of ['atlas-key-input', 'atlas-key-save', 'atlas-key-note']) $(id).hidden = accepted;
        $('atlas-key-remove').hidden = !key;
        $('atlas-key-error').hidden = !rejected;
        if (rejected) $('atlas-key-error').textContent = t('errKey');
        if (!accepted) return;
        const tail = `${key.startsWith('atl_') ? 'atl_' : ''}…${key.slice(-4)}`;
        const rows = _index.access === 'admin'
            ? [[t('keyHeading'), t('keyAdmin')], [t('keyEnding'), tail]]
            : [[t('keyHeading'), t('keyWhitelist')], [t('keyName'), _index.viewer_name], [t('keyId'), _index.viewer],
               [t('keyEnding'), tail]];
        info.replaceChildren();
        for (const [label, value] of rows) {
            if (!value) continue;
            info.appendChild(el('span', 'atlas-key-label', label));
            info.appendChild(el('span', 'atlas-key-value', value));
        }
    }

    function saveKey() {
        const input = /** @type {HTMLInputElement} */ ($('atlas-key-input'));
        const key = input.value.trim();
        if (!key) return;
        writeStorage(KEY_STORAGE, key);
        input.value = '';
        toggleKeyPanel(false);
        reload();
    }

    // Two clicks to act, like the main app's delete buttons: the first turns the button
    // red and asks to confirm; it reverts after 3 s or when the pointer leaves.
    const _confirmTimers = new WeakMap();   // button -> its pending revert

    function confirmClick(btn, action) {
        if (btn.dataset.confirming === '1') {
            // put the button back before acting: it may be hidden now and shown again later
            clearConfirm(btn);
            action();
            return;
        }
        btn.dataset.confirming = '1';
        btn.dataset.confirmLabel = btn.textContent;
        btn.textContent = t('confirm');
        btn.style.background = '#3d0f0f';
        btn.style.color = '#eee';
        btn.style.borderColor = '#f44336';
        _confirmTimers.set(btn, setTimeout(() => clearConfirm(btn), 3000));
        btn.addEventListener('mouseleave', () => clearConfirm(btn), { once: true });
    }

    function clearConfirm(btn) {
        clearTimeout(_confirmTimers.get(btn));
        _confirmTimers.delete(btn);
        if (btn.dataset.confirming !== '1') return;
        delete btn.dataset.confirming;
        btn.textContent = btn.dataset.confirmLabel || '';
        delete btn.dataset.confirmLabel;
        btn.style.background = '';
        btn.style.color = '';
        btn.style.borderColor = '';
    }

    function removeKey() {
        writeStorage(KEY_STORAGE, null);
        toggleKeyPanel(false);
        reload();
    }

    // The header pill: the access level, or that the saved key was rejected.
    let _accessStatus = 0;   // HTTP status of the last failed index request
    function renderAccess(status = 0) {
        _accessStatus = status;
        const btn = $('atlas-key-btn');
        const rejected = status === 403 && !!readStorage(KEY_STORAGE);
        const level = _index ? _index.access : null;
        btn.classList.toggle('rejected', rejected);
        btn.classList.toggle('unlocked', !rejected && (level === 'key' || level === 'admin'));
        $('atlas-access-label').textContent = rejected ? t('keyRejected')
            : level === 'admin' ? t('accessAdmin')
            : level === 'key' ? t('accessKey')
            : level === 'public' ? t('accessPublic')
            : t('keyBtn');
        if (!$('atlas-key-panel').hidden) renderKeyPanel();
    }

    /* ===========================
       SET LIST
    =========================== */

    // Now on the server's clock. Whether a set is public is only ever decided by the
    // server; this keeps the countdown right when the viewer's clock is off.
    function serverNow() {
        return Date.now() + _clockOffset;
    }

    function renderSetList() {
        if (_breached) return;
        const list = $('atlas-set-list');
        list.replaceChildren();
        if (!_index) return;
        if (!_index.sets.length) {
            list.appendChild(el('div', 'atlas-empty', t('noSets')));
            return;
        }
        // numbered oldest first: the newest set (top of the list) has the highest number.
        // Every viewer gets every set listed, so the numbers are the same for everyone.
        const read = EFTForge.utils.atlasReadIds(GAME);
        const now = serverNow();
        _index.sets.forEach((s, i) => {
            const item = el('button', 'atlas-set-item');
            item.type = 'button';
            item.dataset.setId = s.id;
            item.classList.toggle('active', s.id === _setId);
            item.classList.toggle('locked', !!s.locked);
            item.classList.toggle('unread', EFTForge.utils.isAtlasUnread(s, now, read));
            const top = el('div', 'atlas-set-top');
            top.appendChild(el('span', 'atlas-set-num', `#${_index.sets.length - i}`));
            top.appendChild(el('span', 'atlas-set-date', formatTime(s.detected)));
            const dot = el('span', 'atlas-set-unread');
            dot.dataset.tooltip = t('unread');
            top.appendChild(dot);
            item.appendChild(top);
            const fileCount = s.files ? Object.keys(s.files).length : (s.file_count || 0);
            item.appendChild(el('div', 'atlas-set-ver', s.version));
            item.appendChild(el('div', 'atlas-set-meta', `${t('changes', s.total)} · ${t('files', fileCount)}`));
            item.addEventListener('click', () => selectSet(s.id));
            list.appendChild(item);
        });
        enterVisibleSets();
    }

    /* ===========================
       ONE SET
    =========================== */

    /* ===========================
       STATE PANEL
       One card for every "nothing to show here" case: an icon, a title, what's going
       on, and buttons that do something about it.
    =========================== */

    const ICONS = {
        lock:   ['rect:5,11,14,10,2', 'path:M8 11V7a4 4 0 0 1 8 0v4', 'path:M12 15v2'],
        alert:  ['circle:12,12,9', 'path:M12 7.5v5.5', 'path:M12 16.2v.3'],
        search: ['circle:11,11,6.5', 'path:M16 16l4.5 4.5', 'path:M8.5 11h5'],
        empty:  ['rect:3.5,5,17,14,2', 'path:M3.5 13h5l1.5 2.5h4L15.5 13h5'],
    };

    function icon(name) {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.6');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        for (const part of ICONS[name]) {
            const [tag, spec] = part.split(':');
            const node = document.createElementNS(ns, tag);
            if (tag === 'path') node.setAttribute('d', spec);
            else {
                const n = spec.split(',');
                if (tag === 'circle') { node.setAttribute('cx', n[0]); node.setAttribute('cy', n[1]); node.setAttribute('r', n[2]); }
                else { node.setAttribute('x', n[0]); node.setAttribute('y', n[1]); node.setAttribute('width', n[2]); node.setAttribute('height', n[3]); node.setAttribute('rx', n[4]); }
            }
            svg.appendChild(node);
        }
        return svg;
    }

    // Shows the card in the change list. noSet: there's no set behind it, so the view
    // and filter rows go too. redraw: rebuilds it after a language switch.
    // facts: [label, text or node] rows under the explanation.
    function showState({ iconName, tone = '', title, lines = [], facts = [], actions = [], noSet = true, redraw = null }) {
        const card = el('div', `atlas-state ${tone}`);
        const head = el('div', 'atlas-state-head');
        head.appendChild(icon(iconName));
        head.appendChild(el('span', 'atlas-state-title', title));
        card.appendChild(head);
        const body = el('div', 'atlas-state-body');
        for (const line of lines) body.appendChild(el('p', 'atlas-state-text', line));
        if (facts.length) {
            const list = el('dl', 'atlas-state-facts');
            for (const [label, value] of facts) {
                list.appendChild(el('dt', null, label));
                const dd = el('dd');
                if (value instanceof Node) dd.appendChild(value);
                else dd.textContent = value;
                list.appendChild(dd);
            }
            body.appendChild(list);
        }
        if (actions.length) {
            const row = el('div', 'atlas-state-actions');
            for (const act of actions) {
                const btn = el('button', act.primary ? 'modal-btn primary' : 'modal-btn', act.label);
                btn.type = 'button';
                btn.addEventListener('click', act.onClick);
                row.appendChild(btn);
            }
            body.appendChild(row);
        }
        card.appendChild(body);
        document.querySelector('.atlas-main').classList.toggle('atlas-no-set', noSet);
        _redrawState = redraw;
        $('atlas-groups').replaceChildren(card);
    }

    function stopCountdown() {
        clearInterval(_countdownTimer);
        _countdownTimer = 0;
    }

    // The card for a failed request, by status, with what can be done about it.
    function showError(err, { title = t('unavailableTitle'), text = t('errUnavailable'), request = '',
                              retry = null, redraw = null }) {
        const status = err && err.status;
        const facts = [
            ...(request ? [[t('factRequest'), request]] : []),
            [t('factStatus'), status ? `HTTP ${status}` : t('noResponse')],
        ];
        if (status === 403 && readStorage(KEY_STORAGE)) {
            showState({ iconName: 'lock', tone: 'error', title: t('keyTitle'), lines: [t('errKey')], facts, redraw, actions: [
                { label: t('enterKey'), primary: true, onClick: e => { e.stopPropagation(); toggleKeyPanel(true); } },
                { label: t('keyRemove'), onClick: e => confirmClick(/** @type {HTMLElement} */ (e.currentTarget), removeKey) },
            ] });
            return;
        }
        const [ttl, txt] = status === 429 ? [t('rateTitle'), t('errRate')]
            : status === 0 ? [t('networkTitle'), t('errNetwork')]
            : status === 503 ? [t('unavailableTitle'), t('errUnavailable')]
            : [title, text];
        showState({ iconName: 'alert', tone: 'error', title: ttl, lines: [txt], facts, redraw,
                    actions: retry ? [{ label: t('retry'), primary: true, onClick: retry }] : [] });
    }

        // Empty the main column: no set, no counts, no file list.
    function clearSetView() {
        stopCountdown();
        _redrawState = null;
        document.querySelector('.atlas-main').classList.remove('atlas-no-set');
        _set = null;
        _rows = [];
        _file = '';
        $('atlas-set-head').replaceChildren();
        $('atlas-groups').replaceChildren();
        $('atlas-count').textContent = '';
        renderKindChips(null);
        _tocFiles = [];
        $('atlas-toc').hidden = true;
        const select = /** @type {HTMLSelectElement} */ ($('atlas-file-select'));
        const all = el('option', null, t('allFiles'));
        all.value = '';
        select.replaceChildren(all);
        select.value = '';
        select.dispatchEvent(new Event('input'));
    }

    // The set's two headline facts side by side: when it was detected and which game
    // version it came from.
    function setTitle(detected, version) {
        const title = el('div', 'atlas-set-title');
        title.appendChild(el('span', null, formatTime(detected)));
        const ver = el('span', 'atlas-set-version');
        ver.appendChild(el('span', 'atlas-set-version-label', t('version')));
        ver.appendChild(document.createTextNode(version));
        title.appendChild(ver);
        return title;
    }

    function showLockedSet(entry) {
        clearSetView();
        const head = $('atlas-set-head');
        head.appendChild(setTitle(entry.detected, entry.version));
        head.appendChild(el('div', 'atlas-set-sub', `${t('changes', entry.total)} · ${t('files', entry.file_count || 0)}`));
        const countdown = el('span', 'atlas-state-countdown');
        const tick = () => {
            const left = new Date(entry.public_at).getTime() - serverNow();
            if (left <= 0) {
                // it just went public: fetch the index again and it opens normally. If our
                // clock runs ahead of the server's the set is still locked after that, so
                // reload at most once a minute per set instead of looping.
                const last = _autoReloaded.get(entry.id) || 0;
                if (Date.now() - last > 60000) {
                    _autoReloaded.set(entry.id, Date.now());
                    stopCountdown();
                    reload();
                    return;
                }
                countdown.textContent = t('countdownSoon');
                return;
            }
            const mins = Math.ceil(left / 60000);
            countdown.textContent = mins <= 1 && left < 60000 ? t('countdownSoon') : t('countdown', Math.floor(mins / 60), mins % 60);
        };
        const isPublic = _index && _index.access === 'public';
        showState({
            iconName: 'lock',
            tone: 'error',
            title: t('lockedTitle'),
            lines: [t('lockedText', _index ? _index.delay_hours : 12), ...(isPublic ? [t('haveKey')] : [])],
            facts: [
                [t('factOpens'), formatTime(entry.public_at)],
                [t('factLeft'), countdown],
            ],
            actions: isPublic ? [{ label: t('enterKey'), primary: true, onClick: e => { e.stopPropagation(); toggleKeyPanel(true); } }] : [],
            redraw: () => showLockedSet(entry),
        });
        tick();
        _countdownTimer = window.setInterval(tick, 15000);
    }

    // A set this viewer sees before the public does. Only these carry the watermark.
    function isEarlyAccess(entry) {
        return !!entry && !entry.locked && Date.parse(entry.public_at) > serverNow();
    }

    // What the watermark names: the key's name and its id, or just the id for a key
    // created without a name.
    function viewerLabel() {
        if (!_index || !_index.viewer) return null;
        return _index.viewer_name ? `${_index.viewer_name} · ${_index.viewer}` : _index.viewer;
    }

    // Opening a set reads it: it loses its unread mark here and its count on the badge.
    function markRead(id) {
        EFTForge.utils.markAtlasRead(id, _index ? _index.sets.map(s => s.id) : [], GAME);
        const item = /** @type {HTMLElement | null} */ (document.querySelector(`.atlas-set-item[data-set-id="${CSS.escape(id)}"]`));
        if (item) item.classList.remove('unread');
    }

    function renderBadgeToggle() {
        const btn = $('atlas-badge-toggle');
        const hidden = EFTForge.utils.atlasBadgeHidden();
        btn.classList.toggle('off', hidden);
        btn.setAttribute('aria-pressed', String(!hidden));
        btn.setAttribute('aria-label', t(hidden ? 'badgeOff' : 'badgeOn'));
        btn.dataset.tooltip = t(hidden ? 'badgeOff' : 'badgeOn');
        if (EFTForge.tooltip && EFTForge.tooltip.refresh) EFTForge.tooltip.refresh(btn);
    }

    async function selectSet(id) {
        if (_breached) return;
        _setId = id;
        history.replaceState(null, '', `#${id}`);
        renderSetList();
        const token = ++_loadToken;
        const body = $('atlas-groups');
        $('atlas-set-head').replaceChildren();
        const entry = _index && _index.sets.find(s => s.id === id);
        if (entry && entry.locked) {
            applyWatermark(null);
            showLockedSet(entry);
            return;
        }
        clearSetView();
        body.replaceChildren(el('div', 'atlas-empty', t('loading')));
        try {
            // an early access set renders only once its watermark is up; a public one has none
            const [set, marked] = await Promise.all([
                _setCache.get(id) || getJSON(`${API}/sets/${encodeURIComponent(id)}`),
                applyWatermark((isEarlyAccess(entry) && viewerLabel()) || null),
            ]);
            if (!marked) {
                breach();
                return;
            }
            if (token !== _loadToken) return;
            _setCache.set(id, set);
            _set = set;
            markRead(id);
            _rows = prepare(set);
            _file = '';
            renderSet();
        } catch (err) {
            if (token !== _loadToken) return;
            _set = null;
            showError(err, { title: t('setErrTitle'), text: t('errSet'), request: t('reqSet', id), retry: () => selectSet(id),
                             redraw: () => selectSet(id) });
        }
    }

    function renderSet() {
        if (_breached) return;
        const head = $('atlas-set-head');
        head.replaceChildren();
        head.appendChild(setTitle(_set.detected, _set.version));
        head.appendChild(el('div', 'atlas-set-sub', `${t('changes', _set.total)} · ${t('files', (_set.files || []).length)}`));
        renderFileSelect();
        renderView();
    }

    function renderFileSelect() {
        const select = /** @type {HTMLSelectElement} */ ($('atlas-file-select'));
        select.replaceChildren();
        const all = el('option', null, t('allFiles'));
        all.value = '';
        select.appendChild(all);
        for (const f of _set.files || []) {
            const opt = el('option', null, `${fileLabel(f.file, _set.names, _lang)} (${f.changes.length})`);
            opt.value = f.file;
            select.appendChild(opt);
        }
        select.value = _file;
        select.dispatchEvent(new Event('input'));   // the custom select rebuilt from the new options; sync its trigger
    }

    const KIND_SIGNS = { added: '+', removed: '−', changed: '~' };

    function renderKindChips(rows) {
        const counts = { added: 0, removed: 0, changed: 0 };
        if (rows) for (const r of rows) counts[r.change.kind] = (counts[r.change.kind] || 0) + 1;
        document.querySelectorAll('[data-atlas-kind]').forEach(node => {
            const kind = /** @type {HTMLElement} */ (node).dataset.atlasKind;
            node.replaceChildren(el('span', 'atlas-kind-sign', KIND_SIGNS[kind]), el('span', null, t(kind)));
            if (rows) node.appendChild(el('span', 'atlas-kind-num', counts[kind].toLocaleString()));
        });
    }

    function clearFilters() {
        _query = '';
        _file = '';
        for (const kind of ['added', 'removed', 'changed']) _kinds.add(kind);
        /** @type {HTMLInputElement} */ ($('atlas-search')).value = '';
        const select = /** @type {HTMLSelectElement} */ ($('atlas-file-select'));
        select.value = '';
        select.dispatchEvent(new Event('input'));
        syncToggles();
        renderView();
    }

    /* ===========================
       FILE NAVIGATOR
       Every response file in the current view with its change count; a click scrolls
       there, and highlight the file being read as the list scrolls. [ and ] step
       to the previous / next file.
    =========================== */

    function fileAnchor(file) {
        const a = el('div', 'atlas-file-anchor');
        a.dataset.file = file;
        return a;
    }

    function renderToc(rows) {
        const toc = $('atlas-toc');
        const counts = new Map();
        for (const r of rows || []) counts.set(r.file, (counts.get(r.file) || 0) + 1);
        // files only make sections when the list is by file (or raw)
        const byFile = _layout === 'raw' || _mode === 'file';
        _tocFiles = byFile ? [...counts.keys()] : [];
        _tocActive = '';
        toc.hidden = _tocFiles.length < 2;
        const list = $('atlas-toc-list');
        list.replaceChildren();
        for (const file of _tocFiles) {
            const item = el('button', 'atlas-toc-item');
            item.type = 'button';
            item.dataset.file = file;
            item.dataset.tooltip = `${file}/response.json`;
            item.appendChild(el('span', 'atlas-toc-name', fileLabel(file, _set.names, _lang)));
            item.appendChild(el('span', 'atlas-toc-count', counts.get(file).toLocaleString()));
            item.addEventListener('click', () => jumpToFile(file));
            list.appendChild(item);
        }
        if (_tocFiles.length) markToc(_tocFiles[0]);
    }

    function setTocCollapsed(collapsed) {
        $('atlas-toc').classList.toggle('collapsed', collapsed);
        const btn = $('atlas-toc-toggle');
        btn.setAttribute('aria-expanded', String(!collapsed));
        btn.dataset.tooltip = t(collapsed ? 'tocExpand' : 'tocCollapse');
        EFTForge.tooltip?.refresh(btn);
        writeStorage(TOC_STORAGE, collapsed ? '0' : null);
    }

    function markToc(file) {
        if (file === _tocActive) return;
        _tocActive = file;
        for (const item of $('atlas-toc-list').children) {
            const on = /** @type {HTMLElement} */ (item).dataset.file === file;
            item.classList.toggle('active', on);
            if (on) item.scrollIntoView({ block: 'nearest' });
        }
    }

    function findAnchor(file) {
        for (const a of $('atlas-groups').querySelectorAll('.atlas-file-anchor')) {
            if (/** @type {HTMLElement} */ (a).dataset.file === file) return /** @type {HTMLElement} */ (a);
        }
        return null;
    }

    // Scroll directly to the file's section now that every section is rendered.
    function jumpToFile(file) {
        const body = $('atlas-groups');
        const target = findAnchor(file);
        if (!target) return;
        body.scrollTo({ top: target.offsetTop });
        markToc(file);
    }

    function stepFile(delta) {
        if (!_tocFiles.length) return;
        const i = Math.max(0, _tocFiles.indexOf(_tocActive));
        const next = _tocFiles[Math.min(_tocFiles.length - 1, Math.max(0, i + delta))];
        if (next) jumpToFile(next);
    }

    // which section the top of the list is in
    function spyToc() {
        if (!_tocFiles.length) return;
        const top = $('atlas-groups').scrollTop + 4;
        let current = _tocFiles[0];
        for (const a of $('atlas-groups').querySelectorAll('.atlas-file-anchor')) {
            const anchorEl = /** @type {HTMLElement} */ (a);
            if (anchorEl.offsetTop <= top) current = anchorEl.dataset.file;
            else break;
        }
        markToc(current);
    }

    function renderView() {
        if (_breached) return;
        // the chips count what the search and file filter leave, before the kind filter
        const base = filterRows(_rows, { file: _file, query: _query });
        renderKindChips(base);
        const rows = base.filter(r => _kinds.has(r.change.kind));
        const body = $('atlas-groups');
        body.replaceChildren();
        body.scrollTop = 0;
        $('atlas-count').textContent = rows.length === _rows.length
            ? t('changes', rows.length)
            : t('showing', rows.length, _rows.length);
        if (!rows.length) {
            renderToc(null);
            const fileName = _file ? fileLabel(_file, _set.names, _lang) : t('allFiles');
            const kinds = ['added', 'removed', 'changed'].filter(k => _kinds.has(k)).map(k => t(k)).join(' · ') || t('none');
            showState({ iconName: 'search', title: t('noMatchTitle'), lines: [t('noMatchText')], noSet: false,
                        facts: [[t('factSearch'), _query.trim() || t('none')], [t('factFile'), fileName], [t('factKinds'), kinds]],
                        actions: [{ label: t('clearFilters'), primary: true, onClick: clearFilters }] });
            return;
        }
        _redrawState = null;
        document.querySelector('.atlas-main').classList.remove('atlas-no-set');
        renderToc(rows);
        if (_layout === 'raw') {
            _rawLines = rawEntries(rows.slice().sort(compareRows));
            renderRawDiff();
        } else {
            _groups = groupRows(rows, _mode);
            renderGroupedDiff();
        }
    }

    function renderRawDiff() {
        const body = $('atlas-groups');
        let list = body.querySelector('.atlas-raw-list');
        if (!list) { list = el('div', 'atlas-raw-list'); body.appendChild(list); }
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < _rawLines.length; i++) {
            const e = _rawLines[i];
            if (e.type === 'file') {
                fragment.appendChild(fileAnchor(e.file));
                const heading = el('div', 'atlas-file-heading', `${e.file}/response.json`);
                const label = fileLabel(e.file, _set.names, _lang);
                if (label !== e.file.replace(/^client\//, '')) heading.appendChild(el('span', 'atlas-locale-name', ` ${label}`));
                fragment.appendChild(heading);
            } else if (e.type === 'node') {
                const line = el('div', 'atlas-raw-node', ' '.repeat(4 * e.depth));
                appendKey(line, e.seg);
                fragment.appendChild(line);
            } else {
                fragment.appendChild(rawLeaf(e));
            }
        }
        list.appendChild(fragment);
        enterVisibleDiffs();
    }

    // ['key'], with a known id swapped for its name (id on hover), and a locale key
    // like "<id> Name" kept as is with the name after it.
    function appendKey(line, seg) {
        const text = String(seg);
        const id = idIn(text);
        const name = id ? nameOf(id, _set.names, _lang) : null;
        if (name && text === id) {
            const span = el('span', 'atlas-raw-named', `['${name}']`);
            span.dataset.tooltip = id;
            line.appendChild(span);
            return;
        }
        line.appendChild(document.createTextNode(`['${text}']`));
        if (name) line.appendChild(el('span', 'atlas-locale-name', ` ${name}`));
    }

    // Scalars print bare like the text diffs: strings without quotes, ids as names.
    function rawScalar(v) {
        if (typeof v === 'string') {
            const name = ID_RE.test(v) ? nameOf(v, _set.names, _lang) : null;
            return { text: name || v, title: name ? v : null };
        }
        return { text: JSON.stringify(v), title: null };
    }

    function rawLeaf(e) {
        const cls = e.sign === '+' ? 'added' : 'removed';
        const entry = el('div', `atlas-raw-entry ${cls}`);
        const first = el('div', 'atlas-raw-line');
        entry.appendChild(first);
        const tag = t(e.tag === 'new' ? 'tagNew' : e.tag === 'old' ? 'tagOld' : 'tagRemoved');
        first.appendChild(document.createTextNode(`${e.sign}${' '.repeat(4 * e.depth)}${tag} `));
        if (e.key != null) {
            appendKey(first, e.key);
            first.appendChild(document.createTextNode(': '));
        }
        const v = e.value;
        const indent = `${e.sign}${' '.repeat(4 * e.depth + 4)}`;
        const block = value => {
            const text = value !== null && typeof value === 'object' ? JSON.stringify(value, null, 2) : rawScalar(value).text;
            return el('div', 'atlas-raw-line atlas-raw-block', text.split('\n').map(l => indent + l).join('\n'));
        };
        const ext = largeRef(v);
        if (ext) {
            const setId = _set.id;
            largeToggle(null, first, entry, async () => block(await loadValue(setId, ext.ref)));
            return entry;
        }
        const isObject = v !== null && typeof v === 'object';
        const text = isObject ? JSON.stringify(v, null, 2) : rawScalar(v).text;
        if (text.length > LARGE_CHARS) {
            // the whole value goes in a block below, behind a show/hide button
            largeToggle(text.split('\n').length, first, entry, () => block(v));
            return entry;
        }
        if (isObject) {
            const lines = text.split('\n');
            first.appendChild(document.createTextNode(lines[0]));
            if (lines.length > 1) {
                entry.appendChild(el('div', 'atlas-raw-line', lines.slice(1).map(l => indent + l).join('\n')));
            }
            return entry;
        }
        const scalar = rawScalar(v);
        const span = el('span', scalar.title ? 'atlas-raw-named' : null, scalar.text);
        if (scalar.title) span.dataset.tooltip = scalar.title;
        first.appendChild(span);
        if (e.pct) first.appendChild(document.createTextNode(` ${e.pct}`));
        return entry;
    }

    function renderGroupedDiff() {
        const body = $('atlas-groups');
        const autoOpen = _groups.length <= AUTO_OPEN;
        const fragment = document.createDocumentFragment();
        let prevFile = null;
        for (let i = 0; i < _groups.length; i++) {
            const g = _groups[i];
            if (_mode === 'file' && g.file !== prevFile) {
                fragment.appendChild(fileAnchor(g.file));
                fragment.appendChild(el('div', 'atlas-file-heading', fileLabel(g.file, _set.names, _lang)));
                prevFile = g.file;
            }
            fragment.appendChild(groupElement(g, autoOpen));
        }
        body.appendChild(fragment);
        enterVisibleDiffs();
    }

    function groupElement(g, open) {
        const details = document.createElement('details');
        details.className = 'atlas-group';
        const summary = el('summary', 'atlas-group-summary');
        const name = g.id ? nameOf(g.id, _set.names, _lang) : null;
        // tarkov.dev has icons for items only; quests, offers and the like 404, so the
        // image removes itself
        if (g.id && name) {
            const icon = /** @type {HTMLImageElement} */ (el('img', 'atlas-icon'));
            icon.alt = '';
            icon.loading = 'lazy';
            icon.decoding = 'async';
            icon.addEventListener('error', () => icon.remove(), { once: true });
            icon.src = ICON_URL(g.id);
            summary.appendChild(icon);
        }
        const label = el('span', 'atlas-group-label');
        label.appendChild(el('span', 'atlas-group-name', name || g.seg || t('wholeFile')));
        if (g.id && name) label.appendChild(el('span', 'atlas-id', g.id));
        summary.appendChild(label);
        if (_mode === 'item') {
            for (const f of g.files) summary.appendChild(el('span', 'atlas-file-chip', fileLabel(f, _set.names, _lang)));
        }
        const counts = el('span', 'atlas-counts');
        for (const kind of ['added', 'removed', 'changed']) {
            if (!g.counts[kind]) continue;
            const c = el('span', `atlas-count atlas-kind-${kind}`, String(g.counts[kind]));
            c.dataset.tooltip = t(kind);
            counts.appendChild(c);
        }
        summary.appendChild(counts);
        details.appendChild(summary);

        let populated = false;
        const rowsBox = el('div', 'atlas-rows');
        details.appendChild(rowsBox);
        const renderRows = () => {
            if (populated) return;
            const fragment = document.createDocumentFragment();
            for (const row of g.rows) fragment.appendChild(rowElement(row, g));
            rowsBox.appendChild(fragment);
            populated = true;
        };
        details.addEventListener('toggle', () => {
            if (details.open) renderRows();
        });
        details.open = open;
        if (open) renderRows();
        return details;
    }

    function rowElement(r, g) {
        const c = r.change;
        const row = el('div', `atlas-row atlas-kind-${c.kind}`);
        const where = el('div', 'atlas-row-path');
        where.appendChild(el('span', `atlas-kind-tag atlas-kind-${c.kind}`, t(c.kind)));
        if (_mode === 'item' && g.files.size > 1) where.appendChild(el('span', 'atlas-file-chip', fileLabel(r.file, _set.names, _lang)));
        const rest = restPath(r);
        if (!rest.length && r.at < 0) where.appendChild(el('span', 'atlas-seg', t('wholeFile')));
        rest.forEach((seg, i) => {
            if (typeof seg === 'number') {
                where.appendChild(el('span', 'atlas-seg atlas-seg-index', `[${seg}]`));
                return;
            }
            if (i > 0) where.appendChild(el('span', 'atlas-seg-dot', '.'));
            const id = idIn(seg);
            const label = id ? nameOf(id, _set.names, _lang) : null;
            const node = el('span', label ? 'atlas-seg atlas-seg-named' : 'atlas-seg', label ? label + seg.slice(24) : seg);
            if (label) node.dataset.tooltip = seg;
            where.appendChild(node);
        });
        row.appendChild(where);

        const values = el('div', 'atlas-row-values');
        if (c.kind !== 'added') values.appendChild(valueElement(c.old, 'atlas-old'));
        if (c.kind === 'changed') values.appendChild(el('span', 'atlas-arrow', '→'));
        if (c.kind !== 'removed') values.appendChild(valueElement(c.new, 'atlas-new'));
        const delta = c.kind === 'changed' ? numericDelta(c.old, c.new) : null;
        if (delta != null) values.appendChild(el('span', `atlas-delta ${delta > 0 ? 'up' : 'down'}`, `${delta > 0 ? '+' : ''}${delta}`));
        row.appendChild(values);
        return row;
    }

    function plainValue(v, cls) {
        if (v !== null && typeof v === 'object') return el('pre', `atlas-json ${cls}`, JSON.stringify(v, null, 2));
        if (typeof v === 'string' && ID_RE.test(v)) {
            const label = nameOf(v, _set.names, _lang);
            const node = el('span', `atlas-value ${cls}`, label || v);
            if (label) {
                node.classList.add('atlas-value-named');
                node.dataset.tooltip = v;
            }
            return node;
        }
        return el('span', `atlas-value ${cls}`, scalarText(v));
    }

    // A value over LARGE_CHARS starts closed behind a show/hide button; one too large for
    // the set file is fetched on first open.
    function valueElement(v, cls) {
        const ext = largeRef(v);
        if (ext) {
            const box = el('div', 'atlas-large');
            const setId = _set.id;
            largeToggle(null, box, box, async () => plainValue(await loadValue(setId, ext.ref), cls));
            return box;
        }
        const text = v !== null && typeof v === 'object' ? JSON.stringify(v, null, 2) : scalarText(v);
        if (text.length <= LARGE_CHARS) return plainValue(v, cls);
        const box = el('div', 'atlas-large');
        largeToggle(text.split('\n').length, box, box, () => plainValue(v, cls));
        return box;
    }

    function loadValue(setId, ref) {
        const key = `${setId}/${ref}`;
        if (!_valueCache.has(key)) {
            const pending = getJSON(`${API}/sets/${encodeURIComponent(setId)}/values/${ref}`);
            pending.catch(() => _valueCache.delete(key));   // a failed fetch can be retried
            _valueCache.set(key, pending);
        }
        return _valueCache.get(key);
    }

    // Count logical lines in the displayed value, fetching external values only when opened.
    function largeToggle(lines, buttonHost, blockHost, load) {
        const toggle = el('button', 'atlas-reveal');
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', 'false');
        const label = el('span', 'atlas-reveal-label');
        const count = el('span', 'atlas-reveal-count');
        toggle.append(label, count);
        const updateLabel = text => {
            label.textContent = text;
            count.hidden = lines == null;
            count.textContent = lines == null ? '' : t('valueLines', lines);
        };
        buttonHost.appendChild(toggle);
        let block = null;
        let busy = false;
        const setShown = async shown => {
            if (shown && !block) {
                busy = true;
                toggle.disabled = true;
                toggle.setAttribute('aria-busy', 'true');
                updateLabel(t('loadingValue'));
                try {
                    block = await load();
                    lines = (block.textContent || '').split('\n').length;
                } catch (err) {
                    updateLabel(errorText(err, t('errValue')));
                    return;
                } finally {
                    busy = false;
                    toggle.disabled = false;
                    toggle.removeAttribute('aria-busy');
                }
                blockHost.appendChild(block);
            }
            if (block) block.hidden = !shown;
            toggle.setAttribute('aria-expanded', String(shown));
            updateLabel(t(shown ? 'hideValue' : 'showValue'));
        };
        toggle.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            if (!busy) setShown(!(block && !block.hidden));
        });
        setShown(false);
    }

    /* ===========================
       WATERMARK
       Anyone with a key or the admin key sees the page tiled with who they are (the
       key's id from the admin key list, never the key), so a leaked screenshot names
       the key to revoke. The tile sits in a fixed layer over everything. A guard
       re-checks it on every DOM change and every second; if it's gone, hidden, covered,
       shrunk, filtered or swapped, we drop the loaded data and blank the page until a
       reload.
       This only stops editing the page in DevTools: someone who pauses our scripts
       first, or calls the API with the key directly, gets around it, so the id in a
       leak is still what matters.
    =========================== */

    const WM_Z = 2147483647;
    const WM_TILE = { w: 440, h: 260 };
    let _wm = null;          // { viewer, url, overlay, observer, timer, pending }
    let _wmWanted = null;    // the viewer the latest applyWatermark() call asked for
    let _breached = false;

    // A canvas only draws a web font that has finished loading, so wait for Bender
    // (both weights), but not forever: after 2 s the tile falls back to Arial.
    function bender() {
        if (!document.fonts || !document.fonts.load) return Promise.resolve();
        const loads = Promise.all([document.fonts.load('bold 18px Bender'), document.fonts.load('13px Bender')]);
        return Promise.race([loads, new Promise(resolve => setTimeout(resolve, 2000))]).catch(() => {});
    }

    function watermarkTile(viewer) {
        const canvas = document.createElement('canvas');
        const scale = window.devicePixelRatio || 1;
        canvas.width = WM_TILE.w * scale;
        canvas.height = WM_TILE.h * scale;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.scale(scale, scale);
        ctx.translate(WM_TILE.w / 2, WM_TILE.h / 2);
        ctx.rotate(-24 * Math.PI / 180);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.075)';
        // a long name shrinks to fit the tile instead of running into the next one
        ctx.font = 'bold 18px Bender, Arial, sans-serif';
        const room = WM_TILE.w - 40;
        const width = ctx.measureText(viewer).width;
        if (width > room) ctx.font = `bold ${Math.max(10, Math.floor(18 * room / width))}px Bender, Arial, sans-serif`;
        ctx.fillText(viewer, 0, -12);
        ctx.font = '13px Bender, Arial, sans-serif';
        ctx.fillText(new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', 0, 14);
        return canvas.toDataURL('image/png');
    }

    function paint(node, props) {
        for (const [k, v] of Object.entries(props)) node.style.setProperty(k, v, 'important');
    }

    async function applyWatermark(viewer) {
        _wmWanted = viewer;
        if (_wm && _wm.viewer === viewer) return true;
        removeWatermark();
        if (!viewer) return true;
        await bender();
        if (_breached) return false;
        // a later selection (a public set, say) asked for something else while we waited
        if (_wmWanted !== viewer) return true;
        removeWatermark();   // a call that started while we waited may have put one up
        const url = watermarkTile(viewer);
        if (!url) return false;
        const overlay = document.createElement('div');
        overlay.setAttribute('aria-hidden', 'true');
        const tile = `url("${url}")`;
        const size = `${WM_TILE.w}px ${WM_TILE.h}px`;
        paint(overlay, {
            position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
            'z-index': String(WM_Z), 'pointer-events': 'none', display: 'block',
            visibility: 'visible', opacity: '1', 'background-image': tile,
            'background-repeat': 'repeat', 'background-size': size,
        });
        document.body.appendChild(overlay);
        _wm = { viewer, url, overlay, observer: null, timer: 0, pending: false };
        _wm.observer = new MutationObserver(scheduleCheck);
        _wm.observer.observe(document.documentElement, {
            subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'id'],
        });
        // stylesheet edits in DevTools don't show up as mutations
        _wm.timer = window.setInterval(checkWatermark, 1000);
        return watermarkIntact();
    }

    function removeWatermark() {
        if (!_wm) return;
        _wm.observer.disconnect();
        clearInterval(_wm.timer);
        _wm.overlay.remove();
        _wm = null;
    }

    function scheduleCheck() {
        if (!_wm || _wm.pending) return;
        _wm.pending = true;
        requestAnimationFrame(() => {
            if (!_wm) return;
            _wm.pending = false;
            checkWatermark();
        });
    }

    function watermarkIntact() {
        const o = _wm.overlay;
        if (!o.isConnected || o.parentNode !== document.body || document.body.lastElementChild !== o) return false;
        if (o.childNodes.length) return false;
        const cs = getComputedStyle(o);
        if (cs.display !== 'block' || cs.visibility !== 'visible' || cs.position !== 'fixed') return false;
        if (Number(cs.opacity) < 1 || cs.zIndex !== String(WM_Z)) return false;
        if (!cs.backgroundImage.includes(_wm.url)) return false;
        if (cs.filter !== 'none' || cs.transform !== 'none' || cs.clipPath !== 'none') return false;
        if (cs.mixBlendMode !== 'normal' || (cs.getPropertyValue('mask-image') || 'none') !== 'none') return false;
        if ((cs.getPropertyValue('-webkit-mask-image') || 'none') !== 'none') return false;
        const r = o.getBoundingClientRect();
        return !(r.left > 0 || r.top > 0 || r.right < window.innerWidth - 1 || r.bottom < window.innerHeight - 1);
    }

    function checkWatermark() {
        if (_wm && !_breached && !watermarkIntact()) breach();
    }

    // Throw away everything loaded and leave only a notice. Nothing renders again until
    // the page is reloaded.
    function breach() {
        _breached = true;
        _loadToken++;
        if (_wm) {
            _wm.observer.disconnect();
            clearInterval(_wm.timer);
            _wm = null;
        }
        _index = null;
        _set = null;
        _rows = [];
        _groups = [];
        _rawLines = [];
        _setCache.clear();
        _valueCache.clear();
        document.body.replaceChildren(el('div', 'atlas-breach', t('breach')));
    }

    /* ===========================
       EXPORT
    =========================== */

    let _exporting = false;

    async function exportSet() {
        if (!_set || _exporting || _breached) return;
        const set = _set;
        const btn = /** @type {HTMLButtonElement} */ ($('atlas-export'));
        _exporting = true;
        btn.disabled = true;
        btn.textContent = t('exporting');
        let failed = false;
        try {
            const values = new Map();
            await Promise.all(largeRefsIn(set).map(async ref => values.set(ref, await loadValue(set.id, ref))));
            if (_breached) return;
            const url = URL.createObjectURL(new Blob([exportText(set, _lang, values)], { type: 'text/plain;charset=utf-8' }));
            // click the link without adding it to the page: anything after the watermark
            // in <body> counts as covering it
            const a = document.createElement('a');
            a.href = url;
            a.download = exportName(set);
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch {
            failed = true;
        } finally {
            _exporting = false;
            btn.disabled = false;
            btn.textContent = t(failed ? 'exportFailed' : 'exportBtn');
            if (failed) setTimeout(() => { if (!_exporting) btn.textContent = t('exportBtn'); }, 3000);
        }
    }

    /* ===========================
       LOAD
    =========================== */

    async function reload() {
        if (_breached) return;
        // a reload can mean a different key (or none): keep nothing the last one fetched
        _setCache.clear();
        _valueCache.clear();
        _index = null;
        _set = null;
        applyWatermark(null);
        renderAccess();
        $('atlas-set-list').replaceChildren(el('div', 'atlas-empty', t('loading')));
        $('atlas-set-head').replaceChildren();
        clearSetView();
        try {
            _index = await getJSON(`${API}/index`);
        } catch (err) {
            $('atlas-set-list').replaceChildren();
            renderAccess(err && err.status);
            const show = () => showError(err, { request: t('reqIndex'), retry: reload, redraw: show });
            show();
            return;
        }
        if (_breached) return;
        const serverTime = Date.parse(_index.server_time);
        _clockOffset = Number.isFinite(serverTime) ? serverTime - Date.now() : 0;
        renderAccess();
        const wanted = location.hash.slice(1);
        const first = _index.sets.find(s => s.id === wanted)
            || _index.sets.find(s => !s.locked) || _index.sets[0];
        _setId = first ? first.id : null;
        if (first) await selectSet(first.id);
        else {
            renderSetList();
            const empty = () => showState({ iconName: 'empty', title: t('noSetsTitle'), lines: [t('noSetsText')], redraw: empty });
            empty();
        }
    }

    function init() {
        EFTForge.utils.initDotParallax(
            document.querySelector('.atlas-bg-dots'),
            document.querySelector('.atlas-bg')
        );
        const stored = readStorage(LANG_STORAGE);
        _lang = stored === 'zh' || stored === 'en' ? stored
            : (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
        _layout = readStorage(LAYOUT_STORAGE) === 'raw' ? 'raw' : 'grouped';
        setupCustomSelect('lang-select');
        setupCustomSelect('atlas-file-select');
        document.querySelectorAll('[data-atlas-game]').forEach(a => {
            const current = /** @type {HTMLElement} */ (a).dataset.atlasGame === GAME;
            a.classList.toggle('active', current);
            if (current) a.setAttribute('aria-current', 'page');
        });
        applyStaticText();

        $('lang-select').addEventListener('change', e => setLang(/** @type {HTMLSelectElement} */ (e.target).value));
        $('atlas-key-btn').addEventListener('click', e => {
            e.stopPropagation();
            toggleKeyPanel();
        });
        document.addEventListener('click', e => {
            const panel = $('atlas-key-panel');
            if (!panel.hidden && e.target instanceof Node && !panel.contains(e.target)) toggleKeyPanel(false);
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && !$('atlas-key-panel').hidden) toggleKeyPanel(false);
        });
        window.addEventListener('resize', placeKeyPanel);
        document.querySelector('.header-scroll').addEventListener('scroll', placeKeyPanel, { passive: true });
        new ResizeObserver(placeKeyPanel).observe($('atlas-key-panel'));
        setTocCollapsed(readStorage(TOC_STORAGE) === '0');
        $('atlas-toc-toggle').addEventListener('click', () =>
            setTocCollapsed(!$('atlas-toc').classList.contains('collapsed')));
        let spyPending = false;
        $('atlas-groups').addEventListener('scroll', () => {
            if (spyPending) return;
            spyPending = true;
            requestAnimationFrame(() => { spyPending = false; spyToc(); });
        }, { passive: true });
        document.addEventListener('keydown', e => {
            if (e.key !== '[' && e.key !== ']') return;
            const target = /** @type {HTMLElement} */ (e.target);
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            e.preventDefault();
            stepFile(e.key === ']' ? 1 : -1);
        });
        $('atlas-key-save').addEventListener('click', saveKey);
        $('atlas-export').addEventListener('click', exportSet);
        $('atlas-badge-toggle').addEventListener('click', () => {
            EFTForge.utils.setAtlasBadgeHidden(!EFTForge.utils.atlasBadgeHidden());
            renderBadgeToggle();
        });
        $('atlas-key-remove').addEventListener('click', e => confirmClick(/** @type {HTMLElement} */ (e.currentTarget), removeKey));
        $('atlas-key-input').addEventListener('keydown', e => {
            if (e.key === 'Enter') saveKey();
            if (e.key === 'Escape') toggleKeyPanel(false);
        });
        $('atlas-search').addEventListener('input', e => {
            clearTimeout(_searchTimer);
            const value = /** @type {HTMLInputElement} */ (e.target).value;
            _searchTimer = setTimeout(() => {
                _query = value;
                if (_set) renderView();
            }, 200);
        });
        $('atlas-file-select').addEventListener('change', e => {
            _file = /** @type {HTMLSelectElement} */ (e.target).value;
            if (_set) renderView();
        });
        // one handler per toggle group: set the state, light the buttons, re-render
        const onToggle = (selector, apply) => {
            document.querySelectorAll(selector).forEach(btn => {
                btn.addEventListener('click', () => {
                    apply(/** @type {HTMLElement} */ (btn).dataset);
                    syncToggles();
                    if (_set) renderView();
                });
            });
        };
        onToggle('[data-atlas-layout]', d => {
            _layout = d.atlasLayout;
            writeStorage(LAYOUT_STORAGE, _layout);
        });
        onToggle('[data-atlas-mode]', d => { _mode = d.atlasMode; });
        onToggle('[data-atlas-kind]', d => {
            if (_kinds.has(d.atlasKind)) _kinds.delete(d.atlasKind);
            else _kinds.add(d.atlasKind);
        });
        window.addEventListener('hashchange', () => {
            const id = location.hash.slice(1);
            if (_index && id !== _setId && _index.sets.some(s => s.id === id)) selectSet(id);
        });
        reload();
    }

    return {
        init,
        startPageEntrances,
        // pure helpers, for frontend/tests/atlas.test.js
        _test: { idIn, nameOf, fileLabel, prepare, filterRows, groupRows, restPath, numericDelta, largeRef, scalarText, formatBytes, compareRows, percentChange, rawEntries, largeRefsIn, exportText, exportName },
    };
})();

if (typeof document !== 'undefined' && document.getElementById('atlas-app')) {
    window.EFTForge.atlas.init();
}
