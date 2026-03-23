window.EFTForge = window.EFTForge || {};

/* ============================================================
   LEADERBOARD MODULE
   Ranked list of top-rated community builds and attachments.

   Modes:   builds | attachments
   Periods: 2w (last 14 days, default) | all (all time)
   Sort:    likes (default) | dislikes (attachments only)

   Builds are clickable - clicking loads the build into the
   builder exactly like the community builds panel does.
============================================================ */

window.EFTForge.leaderboard = (function () {

    var _mode      = 'builds';
    var _period    = '2w';
    var _sort      = 'likes';
    var _category  = 'all';
    var _gunFilter = 'all';
    var _cache     = {};  // keyed by "mode:period:sort"
    var _categoryBadgeObserver = null;

    var _clearMarqueeTimers = EFTForge.utils._clearMarqueeTimers;
    var _initMarqueeText    = EFTForge.utils._initMarqueeText;

    /* ===========================
       PUBLIC API
    =========================== */

    function showPanel() {
        var overlay  = document.getElementById('leaderboard-overlay');
        var backdrop = document.getElementById('leaderboard-backdrop');
        if (!overlay) return;

        // reset filter dropdowns to defaults each open
        _period    = '2w';
        _sort      = 'likes';
        _category  = 'all';
        _gunFilter = 'all';

        overlay.classList.add('visible');
        if (backdrop) backdrop.classList.add('visible');

        _renderControls();
        _loadData();
    }

    function hidePanel() {
        var overlay  = document.getElementById('leaderboard-overlay');
        var backdrop = document.getElementById('leaderboard-backdrop');
        if (overlay)  overlay.classList.remove('visible');
        if (backdrop) backdrop.classList.remove('visible');
    }

    function onLangChange() {
        var overlay = document.getElementById('leaderboard-overlay');
        if (!overlay || !overlay.classList.contains('visible')) return;
        _renderControls();
        // re-render cached data in new language
        var key = _cacheKey();
        if (_cache[key]) {
            _renderEntries(_cache[key]);
        }
    }

    /* ===========================
       PRIVATE - CONTROLS
    =========================== */

    function _cacheKey() {
        return _mode + ':' + _period + ':' + _sort;
    }

    function _renderControls() {
        var t = EFTForge.lang.t;

        // update header title
        var title = document.getElementById('leaderboard-header-title');
        if (title) title.textContent = t('lb.title');

        // mode toggle
        var buildsBtn = document.getElementById('lb-mode-builds');
        var attBtn    = document.getElementById('lb-mode-att');
        if (buildsBtn) {
            var infoSpan = document.getElementById('lb-builds-info-btn');
            buildsBtn.textContent = t('lb.builds') + ' ';
            if (infoSpan) buildsBtn.appendChild(infoSpan);
            buildsBtn.classList.toggle('active', _mode === 'builds');
        }
        if (attBtn) {
            attBtn.textContent = t('lb.attachments');
            attBtn.classList.toggle('active', _mode === 'attachments');
        }

        // period dropdown
        _refreshCustomSelect('lb-period-select', [
            { value: '2w',  label: t('lb.period2w') },
            { value: 'all', label: t('lb.periodAll') },
        ], _period);

        // sort + category dropdowns - only visible for attachments
        var isAtt = _mode === 'attachments';
        var sortRow = document.getElementById('lb-sort-row');
        if (sortRow) sortRow.style.display = isAtt ? '' : 'none';

        _refreshCustomSelect('lb-sort-select', [
            { value: 'likes',    label: t('lb.sortLikes') },
            { value: 'dislikes', label: t('lb.sortDislikes') },
        ], _sort);

        var catRow = document.getElementById('lb-category-row');
        if (catRow) catRow.style.display = isAtt ? '' : 'none';

        // build category options from full known slot list
        var _allSlots = [
            'Barrel', 'Muzzle', 'Stock', 'Handguard', 'Scope',
            'Front Sight', 'Rear Sight', 'Pistol Grip', 'Magazine',
            'Gas Block', 'Foregrip', 'Ch. Handle', 'Mount', 'Tactical',
            'Bipod', 'Receiver', 'Ubgl', 'Grip', 'Trigger', 'Hammer',
            'Chamber', 'Catch',
        ];
        var catOptions = [{ value: 'all', label: t('lb.categoryAll') }];
        _allSlots.forEach(function (slot) {
            catOptions.push({ value: slot, label: t('slot.' + slot) || slot });
        });
        // ensure current _category is valid; reset if not
        if (!catOptions.find(function (o) { return o.value === _category; })) {
            _category = 'all';
        }
        _refreshCustomSelect('lb-category-select', catOptions, _category);
        _attachCategoryBadge();

        // gun filter row - only visible for builds
        var gunRow = document.getElementById('lb-gun-row');
        if (gunRow) gunRow.style.display = _mode === 'builds' ? '' : 'none';
        _updateGunInputLabel();

        var infoBtn = document.getElementById('lb-builds-info-btn');
        if (infoBtn) infoBtn.dataset.tooltip = t('lb.buildsInfo');

        var capLabel = document.getElementById('lb-cap-label');
        if (capLabel) capLabel.textContent = _getCapLabel();

    }

    function _getCapLabel() {
        var t = EFTForge.lang.t;
        if (_mode === 'builds') {
            return _period === '2w' ? t('lb.top10') : t('lb.top50');
        } else {
            return _period === '2w' ? t('lb.top20') : t('lb.top100');
        }
    }

    /* ===========================
       PRIVATE - DATA LOADING
    =========================== */

    async function _loadData() {
        var key = _cacheKey();
        if (_cache[key]) {
            _renderEntries(_cache[key]);
            return;
        }

        _showLoading();

        try {
            var data;
            if (_mode === 'builds') {
                data = await EFTForge.api.fetchLeaderboardBuilds(_period);
            } else {
                data = await EFTForge.api.fetchLeaderboardAttachments(_period, _sort);
            }
            _cache[key] = data;
            _renderEntries(data);
        } catch (err) {
            console.error('[leaderboard] Load error:', err);
            _showError();
        }
    }

    /* ===========================
       PRIVATE - RENDERING
    =========================== */

    function _showLoading() {
        var body = document.getElementById('leaderboard-body');
        if (!body) return;
        var t = EFTForge.lang.t;
        body.innerHTML = '<div class="lb-loading">' + t('news.loading') + '</div>';
    }

    function _showError() {
        var body = document.getElementById('leaderboard-body');
        if (!body) return;
        var t = EFTForge.lang.t;
        body.innerHTML = '<div class="lb-empty">' + t('lb.loadError') + '</div>';
    }

    function _renderEntries(data) {
        var body = document.getElementById('leaderboard-body');
        if (!body) return;
        _clearMarqueeTimers();

        var t    = EFTForge.lang.t;
        var lang = EFTForge.state && EFTForge.state.lang;

        if (!data || data.length === 0) {
            body.innerHTML = '<div class="lb-empty">' + t('lb.empty') + '</div>';
            return;
        }

        var html = '<ol class="lb-list">';

        if (_mode === 'builds') {
            var allGuns    = (EFTForge.state && EFTForge.state.allGuns) || [];
            var buildData  = _gunFilter === 'all' ? data : data.filter(function (e) { return e.gun_id === _gunFilter; });
            if (buildData.length === 0) {
                body.innerHTML = '<div class="lb-empty">' + t('lb.empty') + '</div>';
                return;
            }
            html += buildData.map(function (entry, idx) {
                var authorName = lang === 'zh'
                    ? (entry.author_display_name_zh || entry.author_display_name || 'Tarkov Citizen')
                    : (entry.author_display_name || 'Tarkov Citizen');
                var rankClass = entry.rank === 1 ? ' lb-rank-gold' : entry.rank === 2 ? ' lb-rank-silver' : entry.rank === 3 ? ' lb-rank-bronze' : '';
                var gunObj    = allGuns.find(function (g) { return g.id === entry.gun_id; });
                var gunName   = (gunObj && gunObj.name) || entry.gun_name || entry.gun_id;
                var imgSrc    = entry.card_image_url || (gunObj && (gunObj.image_512_link || gunObj.icon_link)) || '';
                var imgHtml   = imgSrc
                    ? '<img class="lb-build-img" src="' + _escHtml(imgSrc) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
                    : '<div class="lb-build-img-placeholder"></div>';
                var avatarSrc = entry.author_avatar_url || (entry.is_admin_build ? './news/images/devProfilePic.jpg' : './assets/images/tarkovcitizen.jpg');
                var avatarHtml = '<img class="lb-author-avatar" src="' + _escHtml(avatarSrc) + '" alt="" loading="lazy" referrerpolicy="no-referrer">';
                return (
                    '<li class="lb-entry lb-entry-build" style="--lb-i:' + idx + '" data-idx="' + (_cache[_cacheKey()].indexOf(entry)) + '">' +
                    '<span class="lb-rank' + rankClass + '">' + entry.rank + '</span>' +
                    imgHtml +
                    '<div class="lb-entry-info">' +
                    '<div class="lb-build-name"><span class="marquee-text">' + _escHtml(entry.build_name) + '</span></div>' +
                    '<div class="lb-build-meta">' + _escHtml(gunName) + '</div>' +
                    '<div class="lb-build-author">' + avatarHtml + '<span>' + _escHtml(authorName) + '</span></div>' +
                    '</div>' +
                    '<div class="lb-vote-count"><img src="./assets/images/icon-fir.png" class="lb-vote-icon lb-vote-icon-like"> ' + entry.like_count + '</div>' +
                    '</li>'
                );
            }).join('');
        } else {
            var voteKey       = _sort === 'likes' ? 'like_count' : 'dislike_count';
            var voteIcon      = _sort === 'likes' ? './assets/images/icon-fir.png' : './assets/images/Battlestate Games.svg';
            var voteIconClass = _sort === 'likes' ? 'lb-vote-icon lb-vote-icon-like' : 'lb-vote-icon lb-vote-icon-dislike';
            var filtered = _category === 'all' ? data : data.filter(function (e) { return e.item_category === _category; });
            if (filtered.length === 0) {
                body.innerHTML = '<div class="lb-empty">' + t('lb.empty') + '</div>';
                return;
            }
            html += filtered.map(function (entry, idx) {
                var name = (lang === 'zh' && entry.item_name_zh) ? entry.item_name_zh : (entry.item_name || entry.item_id);
                var rankClass = entry.rank === 1 ? ' lb-rank-gold' : entry.rank === 2 ? ' lb-rank-silver' : entry.rank === 3 ? ' lb-rank-bronze' : '';
                var iconHtml = entry.icon_link
                    ? '<img class="lb-att-icon" src="' + _escHtml(entry.icon_link) + '" alt="" loading="lazy">'
                    : '<div class="lb-att-icon-placeholder"></div>';
                return (
                    '<li class="lb-entry lb-entry-att" style="--lb-i:' + idx + '">' +
                    '<span class="lb-rank' + rankClass + '">' + entry.rank + '</span>' +
                    iconHtml +
                    '<div class="lb-entry-info">' +
                    '<div class="lb-att-name"><span class="marquee-text">' + _escHtml(name) + '</span></div>' +
                    '</div>' +
                    '<div class="lb-vote-count"><img src="' + voteIcon + '" class="' + voteIconClass + '"> ' + entry[voteKey] + '</div>' +
                    '</li>'
                );
            }).join('');

        }

        html += '</ol>';
        body.innerHTML = html;

        _initMarqueeText(body, { hoverOnly: true, hoverTarget: 'li' });

        // attach click handlers for build entries
        if (_mode === 'builds') {
            body.querySelectorAll('.lb-entry-build').forEach(function (el) {
                el.addEventListener('click', function () {
                    var idx = parseInt(el.dataset.idx, 10);
                    var entry = (_cache[_cacheKey()] || [])[idx];
                    if (entry) _loadBuild(entry);
                });
            });
        }
    }

    async function _loadBuild(build) {
        if (!build || !build.pairs) return;

        var lang = EFTForge.state && EFTForge.state.lang;
        var authorName = lang === 'zh'
            ? (build.author_display_name_zh || build.author_display_name || 'Tarkov Citizen')
            : (build.author_display_name || 'Tarkov Citizen');
        var avatarUrl = build.author_avatar_url || (build.is_admin_build ? './news/images/devProfilePic.jpg' : null);

        var communityBuildInfo = {
            pairsKey:     _pairsKey(build.pairs),
            authorName:   authorName,
            avatarUrl:    avatarUrl,
            buildName:    build.build_name,
            cardImageUrl: build.card_image_url || null,
        };

        hidePanel();

        EFTForge.api.recordBuildLoad(build.build_id);

        await loadBuildFromPayload({ g: build.gun_id, p: build.pairs, a: build.ammo_id || null }, build.build_name);

        // set after loadBuildFromPayload (which clears communityBuild internally)
        EFTForge.state.communityBuild = communityBuildInfo;
        syncBuildDisplayName();
    }

    /* ===========================
       PRIVATE - TOGGLE HANDLERS
    =========================== */

    function _setMode(mode) {
        if (_mode === mode) return;
        _mode      = mode;
        _gunFilter = 'all';
        if (_mode === 'builds') _sort = 'likes';  // builds have no dislike sort
        _renderControls();
        _loadData();
    }

    function _setPeriod(period) {
        if (_period === period) return;
        _period = period;
        _renderControls();
        _loadData();
    }

    function _setSort(sort) {
        if (_sort === sort) return;
        _sort = sort;
        _category = 'all';  // reset category when sort changes (new data fetched)
        _renderControls();
        _loadData();
    }

    function _setGunFilter(gunId) {
        if (_gunFilter === gunId) return;
        _gunFilter = gunId;
        _updateGunInputLabel();
        var cached = _cache[_cacheKey()];
        if (cached) _renderEntries(cached);
    }

    function _updateGunInputLabel() {
        var input = document.getElementById('lb-gun-input');
        if (!input) return;
        var t = EFTForge.lang.t;
        if (_gunFilter === 'all') {
            input.value = '';
            input.placeholder = t('lb.gunFilterAll');
        } else {
            var allGuns = (EFTForge.state && EFTForge.state.allGuns) || [];
            var gun = allGuns.find(function (g) { return g.id === _gunFilter; });
            input.value = gun ? gun.name : _gunFilter;
            input.placeholder = '';
        }
    }

    function _setCategory(cat) {
        if (_category === cat) return;
        _category = cat;
        var cached = _cache[_cacheKey()];
        if (cached) _renderEntries(cached);
    }

    /* ===========================
       PRIVATE - HELPERS
    =========================== */

    function _initGunSelect() {
        var input    = document.getElementById('lb-gun-input');
        var dropdown = document.getElementById('lb-gun-dropdown');
        if (!input || !dropdown) return;

        function _buildList(query) {
            var t       = EFTForge.lang.t;
            var allGuns = (EFTForge.state && EFTForge.state.allGuns) || [];
            var q       = query.trim().toLowerCase();
            dropdown.innerHTML = '';

            // "All" option
            var allOpt = document.createElement('div');
            allOpt.className = 'lb-gun-option' + (_gunFilter === 'all' ? ' selected' : '');
            allOpt.textContent = t('lb.gunFilterAll');
            allOpt.addEventListener('mousedown', function (e) {
                e.preventDefault();
                _setGunFilter('all');
                dropdown.classList.remove('open');
            });
            dropdown.appendChild(allOpt);

            var filtered = q
                ? allGuns.filter(function (g) { return g.name.toLowerCase().indexOf(q) !== -1; })
                : allGuns;

            filtered.forEach(function (gun) {
                var opt = document.createElement('div');
                opt.className = 'lb-gun-option' + (_gunFilter === gun.id ? ' selected' : '');
                opt.textContent = gun.name;
                opt.addEventListener('mousedown', function (e) {
                    e.preventDefault();
                    _setGunFilter(gun.id);
                    dropdown.classList.remove('open');
                    input.blur();
                });
                dropdown.appendChild(opt);
            });
        }

        input.addEventListener('focus', function () {
            _buildList('');
            dropdown.classList.add('open');
        });

        input.addEventListener('input', function () {
            _buildList(input.value);
            dropdown.classList.add('open');
        });

        input.addEventListener('blur', function () {
            // slight delay so mousedown on options fires first
            setTimeout(function () { dropdown.classList.remove('open'); }, 150);
            // restore display label on blur
            _updateGunInputLabel();
        });

        // clear input text when focused so user can type a new search
        input.addEventListener('focus', function () {
            if (_gunFilter !== 'all') input.value = '';
        });
    }

    function _attachCategoryBadge() {
        if (_categoryBadgeObserver) {
            _categoryBadgeObserver.disconnect();
            _categoryBadgeObserver = null;
        }
        var wrapper = document.getElementById('lb-category-select-custom');
        if (!wrapper) return;
        var trigger = wrapper.querySelector('.custom-select-trigger');
        if (!trigger) return;
        function _addBadge() {
            if (!trigger.querySelector('.beta-badge')) {
                var badge = document.createElement('span');
                badge.className = 'beta-badge';
                badge.style.cssText = 'margin-left:6px; flex-shrink:0;';
                badge.textContent = 'BETA';
                trigger.appendChild(badge);
            }
        }
        _addBadge();
        _categoryBadgeObserver = new MutationObserver(_addBadge);
        _categoryBadgeObserver.observe(trigger, { childList: true });
    }

    function _refreshCustomSelect(id, options, currentValue) {
        var sel = document.getElementById(id);
        if (!sel) return;
        // update option labels (triggers MutationObserver in setupCustomSelect)
        var existing = document.getElementById(id + '-custom');
        if (existing) existing.remove();
        while (sel.options.length) sel.remove(0);
        options.forEach(function (opt) {
            var o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.label;
            if (opt.value === currentValue) o.selected = true;
            sel.appendChild(o);
        });
        setupCustomSelect(id);
    }

    function _escHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // mirror of _pairsKey in build-manager.js
    function _pairsKey(pairs) {
        if (!pairs || !pairs.length) return '';
        return pairs.slice().sort(function (a, b) {
            return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
        }).map(function (p) { return p[0] + ':' + p[1]; }).join('|');
    }

    /* ===========================
       SELF-INIT
    =========================== */

    function _init() {
        // wire up mode toggle buttons
        var modeButtons = [
            { id: 'lb-mode-builds', fn: function () { _setMode('builds'); } },
            { id: 'lb-mode-att',    fn: function () { _setMode('attachments'); } },
        ];
        modeButtons.forEach(function (item) {
            var el = document.getElementById(item.id);
            if (el) el.addEventListener('click', item.fn);
        });

        _initGunSelect();

        // wire up period and sort dropdowns
        var periodSel = document.getElementById('lb-period-select');
        if (periodSel) periodSel.addEventListener('change', function (e) { _setPeriod(e.target.value); });

        var sortSel = document.getElementById('lb-sort-select');
        if (sortSel) sortSel.addEventListener('change', function (e) { _setSort(e.target.value); });

        var catSel = document.getElementById('lb-category-select');
        if (catSel) catSel.addEventListener('change', function (e) { _setCategory(e.target.value); });

        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            var overlay = document.getElementById('leaderboard-overlay');
            if (!overlay || !overlay.classList.contains('visible')) return;
            e.stopPropagation();
            hidePanel();
        }, true);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _init);
    } else {
        _init();
    }

    return { showPanel, hidePanel, onLangChange };

})();
