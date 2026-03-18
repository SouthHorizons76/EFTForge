window.EFTForge = window.EFTForge || {};

/* ============================================================
   NEWS MODULE
   File-based blog/news page with markdown rendering via marked.js.

   Adding a new post:
     1. Create frontend/news/posts/YYYY-MM-DD-slug.md
     2. Add an entry to frontend/news/manifest.json (newest first)

   Image/video paths in .md files must be relative to the
   frontend root, e.g. ./news/images/screenshot.png

   Auto-open behaviour:
     On page load, if the latest post ID differs from the value
     stored in localStorage('eftforge_news_seen'), the drawer
     opens automatically. Closing the drawer saves the latest
     post ID so it won't auto-open again until a new post lands.
============================================================ */

window.EFTForge.news = (function () {

    var SEEN_KEY  = 'eftforge_news_seen';
    var _DEV_POST = {
        id:         'dev-md-test',
        title:      '[DEV] Markdown Test',
        date:       new Date().toISOString().slice(0, 10),
        tags:       ['dev'],
        summary:    'Localhost only - tests all markdown elements, images, and video.',
        file:       'dev-md-test.md',
        _dev:       true
    };

    var _manifest = null;
    var _currentView = 'list'; // 'list' | 'post'
    var _currentPostId = null;

    /* ===========================
       PUBLIC API
    =========================== */

    function init() {
        // Hash routing
        _handleHashOnLoad();
        window.addEventListener('hashchange', _onHashChange);

        // ESC key in capture phase — fires before app.js's bubble-phase listener
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            var overlay = document.getElementById('news-overlay');
            if (!overlay || !overlay.classList.contains('visible')) return;

            if (_currentView === 'post') {
                showPage();
            } else {
                hidePage();
            }
            e.stopImmediatePropagation();
        }, true);

        // Auto-open if there is an unseen post (only when not already on a #news hash)
        if (!location.hash.startsWith('#news')) {
            _checkForNewPost();
        }
    }

    async function showPage() {
        var overlay  = document.getElementById('news-overlay');
        var backdrop = document.getElementById('news-backdrop');
        if (!overlay) return;

        _currentView   = 'list';
        _currentPostId = null;

        overlay.classList.add('visible');
        if (backdrop) backdrop.classList.add('visible');

        _updateHeaderTitle(EFTForge.lang.t('news.title'));
        _setHash('news');

        if (!_manifest) {
            _showLoading();
            try {
                var res = await fetch('./news/manifest.json', { cache: 'no-cache' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                _manifest = await res.json();
                _injectDevPost();
            } catch (err) {
                console.error('[news] Failed to load manifest:', err);
                _showError(EFTForge.lang.t('news.loadError'));
                return;
            }
        }

        _renderPostList();
    }

    async function showPost(postId) {
        var overlay  = document.getElementById('news-overlay');
        var backdrop = document.getElementById('news-backdrop');
        if (!overlay) return;

        overlay.classList.add('visible');
        if (backdrop) backdrop.classList.add('visible');

        _currentView   = 'post';
        _currentPostId = postId;
        _updateHeaderTitle(EFTForge.lang.t('news.title'));
        _setHash('news/' + postId);

        if (!_manifest) {
            _showLoading();
            try {
                var res = await fetch('./news/manifest.json', { cache: 'no-cache' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                _manifest = await res.json();
                _injectDevPost();
            } catch (err) {
                _showError(EFTForge.lang.t('news.loadError'));
                return;
            }
        }

        var post = (_manifest.posts || []).find(function (p) { return p.id === postId; });
        if (!post) {
            _showError(EFTForge.lang.t('news.postNotFound'));
            return;
        }

        _showLoading();

        var lang = EFTForge.state.lang;
        var file = (lang === 'zh' && post.file_zh) ? post.file_zh : post.file;

        var markdown;
        try {
            var res = await fetch('./news/posts/' + file, { cache: 'no-cache' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            markdown = await res.text();
        } catch (err) {
            console.error('[news] Failed to load post:', err);
            _showError(EFTForge.lang.t('news.loadError'));
            return;
        }

        _renderPost(post, markdown);
    }

    function hidePage() {
        var overlay  = document.getElementById('news-overlay');
        var backdrop = document.getElementById('news-backdrop');
        if (!overlay) return;

        overlay.classList.remove('visible');
        if (backdrop) backdrop.classList.remove('visible');

        _currentView   = 'list';
        _currentPostId = null;

        // Mark the latest post as seen so it won't auto-open again
        if (_manifest && _manifest.posts && _manifest.posts.length > 0) {
            localStorage.setItem(SEEN_KEY, _manifest.posts[0].id);
        }

        if (location.hash.startsWith('#news')) {
            history.replaceState(null, '', location.pathname + location.search);
        }
    }

    // Called by switchLang() in app.js after a language change
    function onLangChange() {
        var overlay = document.getElementById('news-overlay');
        if (!overlay || !overlay.classList.contains('visible')) return;

        if (_currentView === 'list') {
            _renderPostList();
        } else if (_currentView === 'post' && _currentPostId) {
            showPost(_currentPostId);
        }
    }

    /* ===========================
       PRIVATE — DEV POST INJECTION
    =========================== */

    function _isDevMode() {
        var h = location.hostname;
        return h === 'localhost' || h === '127.0.0.1';
    }

    function _injectDevPost() {
        if (!_isDevMode()) return;
        var posts = _manifest.posts || [];
        var alreadyInjected = posts.some(function (p) { return p.id === _DEV_POST.id; });
        if (!alreadyInjected) {
            _manifest.posts = [_DEV_POST].concat(posts);
        }
    }

    /* ===========================
       PRIVATE — NEW POST CHECK
    =========================== */

    async function _checkForNewPost() {
        try {
            var res = await fetch('./news/manifest.json', { cache: 'no-cache' });
            if (!res.ok) return;
            _manifest = await res.json();
            _injectDevPost();

            var posts = _manifest.posts || [];
            if (posts.length === 0) return;

            var latestId = posts[0].id;
            var seenId   = localStorage.getItem(SEEN_KEY);

            if (seenId !== latestId) {
                showPage();
            }
        } catch (_) {
            // Fail silently — never annoy the user over a missing manifest
        }
    }

    /* ===========================
       PRIVATE — RENDERING
    =========================== */

    function _renderPostList() {
        var body = document.getElementById('news-body');
        if (!body) return;

        var posts = (_manifest && _manifest.posts) || [];
        var lang  = EFTForge.state.lang;

        _updateHeaderTitle(EFTForge.lang.t('news.title'));

        if (posts.length === 0) {
            body.innerHTML = '<div class="news-empty">' + escapeHtml(EFTForge.lang.t('news.noPosts')) + '</div>';
            return;
        }

        // Regular posts first (newest→oldest), dev posts pinned to bottom
        var regularPosts = posts.filter(function (p) { return !p._dev; });
        var devPosts     = posts.filter(function (p) { return  p._dev; });
        posts = regularPosts.concat(devPosts);

        var cards = posts.map(function (post) {
            var title   = (lang === 'zh' && post.title_zh)   ? post.title_zh   : post.title;
            var summary = (lang === 'zh' && post.summary_zh) ? post.summary_zh : (post.summary || '');
            var tags    = (post.tags || []).map(function (tag) {
                return '<span class="news-card-tag">' + escapeHtml(tag) + '</span>';
            }).join('');

            return [
                '<div class="news-post-card" onclick="EFTForge.news.showPost(\'' + post.id + '\')">',
                '  <div class="news-card-title">' + escapeHtml(title) + '</div>',
                '  <div class="news-card-date">' + escapeHtml(_formatDate(post.date)) + '</div>',
                tags    ? '  <div class="news-card-tags">'    + tags    + '</div>' : '',
                summary ? '  <div class="news-card-summary">' + escapeHtml(summary) + '</div>' : '',
                '</div>'
            ].join('\n');
        }).join('\n');

        body.innerHTML = '<div class="news-post-grid">' + cards + '</div>';
    }

    function _renderPost(post, markdown) {
        var body = document.getElementById('news-body');
        if (!body) return;

        var tags = (post.tags || []).map(function (tag) {
            return '<span class="news-card-tag">' + escapeHtml(tag) + '</span>';
        }).join('');

        // Configure marked — allow raw HTML for <video> and other embeds
        if (typeof marked !== 'undefined') {
            if (typeof marked.use === 'function') {
                marked.use({ mangle: false, headerIds: false });
            } else if (typeof marked.setOptions === 'function') {
                marked.setOptions({ mangle: false, headerIds: false });
            }
        }

        var htmlContent = (typeof marked !== 'undefined')
            ? marked.parse(markdown)
            : '<pre>' + escapeHtml(markdown) + '</pre>';

        body.innerHTML = [
            '<div class="news-post-view">',
            '  <button class="news-back-btn" style="margin-left:0; margin-bottom:20px;"',
            '    onclick="EFTForge.news.showPage()">',
            '    &#x2190; ' + escapeHtml(EFTForge.lang.t('news.backToList')),
            '  </button>',
            '  <div class="news-post-meta">',
            '    <span class="news-post-meta-date">' + escapeHtml(_formatDate(post.date)) + '</span>',
            tags ? '    <div class="news-card-tags">' + tags + '</div>' : '',
            '  </div>',
            '  <div class="news-post-content">',
            htmlContent,
            '  </div>',
            '</div>'
        ].join('\n');

        body.scrollTop = 0;
    }

    function _showLoading() {
        var body = document.getElementById('news-body');
        if (body) {
            body.innerHTML = '<div class="news-loading">' + escapeHtml(EFTForge.lang.t('news.loading')) + '</div>';
        }
    }

    function _showError(msg) {
        var body = document.getElementById('news-body');
        if (body) {
            body.innerHTML = '<div class="news-error">' + escapeHtml(msg) + '</div>';
        }
    }

    function _updateHeaderTitle(text) {
        var el = document.getElementById('news-header-title');
        if (el) el.textContent = text;
    }

    /* ===========================
       PRIVATE — HASH ROUTING
    =========================== */

    function _handleHashOnLoad() {
        var hash = location.hash;
        if (hash === '#news') {
            showPage();
        } else if (hash.startsWith('#news/')) {
            var postId = hash.slice('#news/'.length);
            if (postId) showPost(postId);
        }
    }

    function _onHashChange() {
        var hash = location.hash;
        if (hash === '#news') {
            showPage();
        } else if (hash.startsWith('#news/')) {
            var postId = hash.slice('#news/'.length);
            if (postId) showPost(postId);
        }
    }

    function _setHash(hash) {
        history.replaceState(null, '', '#' + hash);
    }

    /* ===========================
       PRIVATE — UTILITIES
    =========================== */

    function _formatDate(dateStr) {
        if (!dateStr) return '';
        try {
            var parts  = dateStr.split('-').map(Number);
            var d      = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
            var locale = EFTForge.state.lang === 'zh' ? 'zh-CN' : 'en-US';
            return d.toLocaleDateString(locale, {
                year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
            });
        } catch (_) {
            return dateStr;
        }
    }

    /* ===========================
       SELF-INIT
    =========================== */

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return { init, showPage, showPost, hidePage, onLangChange };

})();
