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
    var _SECRET_POST = {
        id:      'secret-about',
        title:   'About the Dev',
        title_zh: '关于开发者',
        date:    '2026-03-19',
        tags:    [],
        file:    'secret-about.md',
        file_zh: 'secret-about.zh.md',
        _secret: true,
    };

    var _DEV_POST = {
        id:          'dev-md-test',
        title:       '[DEV] Markdown Test',
        date:        new Date().toISOString().slice(0, 10),
        tags:        ['dev'],
        summary:     'Localhost only - tests all markdown elements, images, and video.',
        file:        'dev-md-test.md',
        title_media: './news/images/test.gif',
        _dev:        true
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

        // ESC key in capture phase - fires before app.js's bubble-phase listener
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
        document.getElementById('main-container')?.setAttribute('inert', '');
        if (document.activeElement) document.activeElement.blur();

        _updateHeaderTitle(EFTForge.lang.t('news.title'));
        _setHash('news');

        if (!_manifest) {
            _showLoading();
            try {
                var res = await fetch('./news/manifest.json', { cache: 'no-cache' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                _manifest = await res.json();
                _injectDevPost();
                _injectSecretPost();
            } catch (err) {
                console.error('[news] Failed to load manifest:', err);
                _showError(EFTForge.lang.t('news.loadError'));
                return;
            }
        }

        _animateOut('back', function () { _renderPostList(); });
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
                _injectSecretPost();
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

        _animateOut('forward', function () { _renderPost(post, markdown); });
    }

    function hidePage() {
        var overlay  = document.getElementById('news-overlay');
        var backdrop = document.getElementById('news-backdrop');
        if (!overlay) return;

        overlay.classList.remove('visible');
        if (backdrop) backdrop.classList.remove('visible');
        document.getElementById('main-container')?.removeAttribute('inert');

        _currentView   = 'list';
        _currentPostId = null;

        // Mark the latest non-dev post as seen so it won't auto-open again
        var seenPost = (_manifest && _manifest.posts || []).find(function (p) { return !p._dev; });
        if (seenPost) localStorage.setItem(SEEN_KEY, seenPost.id);

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
       PRIVATE - DEV POST INJECTION
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

    function _injectSecretPost() {
        var posts = _manifest.posts || [];
        var alreadyInjected = posts.some(function (p) { return p.id === _SECRET_POST.id; });
        if (!alreadyInjected) {
            _manifest.posts = posts.concat([_SECRET_POST]);
        }
    }

    /* ===========================
       PRIVATE - NEW POST CHECK
    =========================== */

    async function _checkForNewPost() {
        try {
            var res = await fetch('./news/manifest.json', { cache: 'no-cache' });
            if (!res.ok) return;
            _manifest = await res.json();
            _injectDevPost();
            _injectSecretPost();

            var posts = (_manifest.posts || []).filter(function (p) { return !p._dev; });
            if (posts.length === 0) return;

            var latestId = posts[0].id;
            var seenId   = localStorage.getItem(SEEN_KEY);

            if (seenId !== latestId) {
                showPost(latestId);
            }
        } catch (_) {
            // Fail silently - never annoy the user over a missing manifest
        }
    }

    /* ===========================
       PRIVATE - RENDERING
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

        // Regular posts first (newest→oldest), dev posts pinned to bottom; secret posts never shown
        var regularPosts = posts.filter(function (p) { return !p._dev && !p._secret; });
        var devPosts     = posts.filter(function (p) { return  p._dev; });
        posts = regularPosts.concat(devPosts);

        var cards = posts.map(function (post) {
            var title   = (lang === 'zh' && post.title_zh)   ? post.title_zh   : post.title;
            var summary = (lang === 'zh' && post.summary_zh) ? post.summary_zh : (post.summary || '');
            var tags    = (post.tags || []).map(function (tag) {
                var tagClass = 'news-card-tag news-card-tag--' + tag.toLowerCase().replace(/\s+/g, '-');
                return '<span class="' + tagClass + '">' + escapeHtml(tag) + '</span>';
            }).join('');

            var media    = post.title_media;
            var isLogo   = false;
            if (!media && (post.tags || []).indexOf('patch-notes') !== -1) {
                media  = './assets/images/EFTForge1080x1080.png';
                isLogo = true;
            }

            var mediaHtml = '';
            if (media) {
                if (isLogo) {
                    mediaHtml = '<div class="news-card-media-wrap news-card-logo-bg"><img src="' + media + '" alt=""></div>';
                } else if (post.thumbnail) {
                    var wrapStyle = post.thumbnail_style ? ' style="' + post.thumbnail_style + '"' : '';
                    var imgStyle  = 'width:100%;height:100%;object-fit:cover;' + (post.thumbnail_img_style || '');
                    mediaHtml = '<div class="news-card-media-wrap"' + wrapStyle + '><img class="news-card-media" src="' + post.thumbnail + '" alt="" style="' + imgStyle + '"></div>';
                } else {
                    var ext = media.split('.').pop().toLowerCase();
                    var isVideo = (ext === 'mp4' || ext === 'webm' || ext === 'ogg');
                    if (isVideo) {
                        mediaHtml = '<div class="news-card-media-wrap"><video class="news-card-media" src="' + media + '#t=0.001" preload="metadata"></video></div>';
                    } else if (ext === 'gif') {
                        mediaHtml = '<div class="news-card-media-wrap"><canvas class="news-card-media" data-gif-src="' + media + '"></canvas></div>';
                    } else {
                        mediaHtml = '<div class="news-card-media-wrap"><img class="news-card-media" src="' + media + '" alt=""></div>';
                    }
                }
            }

            return [
                '<div class="news-post-card' + (post._dev ? ' news-post-card--dev' : '') + '" onclick="EFTForge.news.showPost(\'' + post.id + '\')">',
                mediaHtml,
                '  <div class="news-card-text">',
                '    <div class="news-card-title">' + escapeHtml(title) + '</div>',
                '    <div class="news-card-date">' + escapeHtml(_formatDate(post.date)) + '</div>',
                tags    ? '    <div class="news-card-tags">'    + tags    + '</div>' : '',
                summary ? '    <div class="news-card-summary">' + escapeHtml(summary) + '</div>' : '',
                '  </div>',
                '</div>'
            ].join('\n');
        }).join('\n');

        body.innerHTML = '<div class="news-page news-page--back"><div class="news-post-grid">' + cards + '</div></div>';

        // Freeze GIF thumbnails by drawing first frame to canvas
        body.querySelectorAll('canvas.news-card-media[data-gif-src]').forEach(function (canvas) {
            var img = new Image();
            img.onload = function () {
                canvas.width  = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext('2d').drawImage(img, 0, 0);
            };
            img.src = canvas.dataset.gifSrc;
        });
    }

    function _renderPost(post, markdown) {
        var body = document.getElementById('news-body');
        if (!body) return;

        var tags = (post.tags || []).map(function (tag) {
            var tagClass = 'news-card-tag news-card-tag--' + tag.toLowerCase().replace(/\s+/g, '-');
                return '<span class="' + tagClass + '">' + escapeHtml(tag) + '</span>';
        }).join('');

        // Configure marked - allow raw HTML for <video> and other embeds
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
            '<div class="news-page"><div class="news-post-view">',
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
            '</div></div>'
        ].join('\n');

        body.scrollTop = 0;

        // Build title media hero - overlays the first <h1> on top of the media
        var _titleMedia    = post.title_media;
        var _titleMediaLogo = false;
        if (!_titleMedia && (post.tags || []).indexOf('patch-notes') !== -1) {
            _titleMedia     = './assets/images/EFTForge1080x1080.png';
            _titleMediaLogo = true;
        }

        if (_titleMedia) {
            post = Object.assign({}, post, { title_media: _titleMedia });
        }

        if (post.title_media) {
            var firstH1 = body.querySelector('.news-post-content h1');
            if (firstH1) {
                var ext = post.title_media.split('.').pop().toLowerCase();
                var isVideo = (ext === 'mp4' || ext === 'webm' || ext === 'ogg');

                var mediaEl;
                if (isVideo) {
                    mediaEl = document.createElement('video');
                    mediaEl.src      = post.title_media;
                    mediaEl.autoplay = true;
                    mediaEl.loop     = true;
                    mediaEl.muted    = true;
                    mediaEl.setAttribute('playsinline', '');
                    mediaEl.setAttribute('preload', 'auto');
                } else {
                    mediaEl = document.createElement('img');
                    mediaEl.src = post.title_media;
                    mediaEl.alt = '';
                }

                var overlay = document.createElement('div');
                overlay.className = 'news-title-overlay';
                overlay.appendChild(firstH1);

                var hero = document.createElement('div');
                hero.className = 'news-title-hero' + (_titleMediaLogo ? ' news-title-hero--logo' : '');
                hero.appendChild(mediaEl);
                hero.appendChild(overlay);

                var content = body.querySelector('.news-post-content');
                content.insertAdjacentElement('afterbegin', hero);
            }
        }

        // Apply default video behaviour: autoplay, loop, muted, no controls
        // Posts can opt back in to controls by adding data-controls="true"
        body.querySelectorAll('a[href]').forEach(function (a) {
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
        });

        body.querySelectorAll('video').forEach(function (v) {
            if (v.dataset.controls === 'true') {
                v.setAttribute('controls', '');
            } else {
                v.removeAttribute('controls');
            }
            v.autoplay = v.dataset.autoplay !== 'false';
            v.loop     = v.dataset.loop     !== 'false';
            v.muted    = true;
            v.setAttribute('playsinline', '');
        });
    }

    function _animateOut(direction, callback) {
        var body = document.getElementById('news-body');
        var page = body && body.querySelector('.news-page');
        if (!page) { callback(); return; }
        var cls = direction === 'forward' ? 'news-page--exit-left' : 'news-page--exit-right';
        page.classList.add(cls);
        setTimeout(callback, 160);
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
       PRIVATE - HASH ROUTING
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
       PRIVATE - UTILITIES
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

    function showSecretPost() {
        showPost(_SECRET_POST.id);
    }

    return { init, showPage, showPost, showSecretPost, hidePage, onLangChange };

})();
