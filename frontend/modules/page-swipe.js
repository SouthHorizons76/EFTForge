window.EFTForge = window.EFTForge || {};

/* ============================================================
   PAGE SWIPE
   EFTForge and Atlas are separate pages; moving between them is a cross-document
   view transition. Slide the content sideways, reveal the corner blob afterward,
   and animate the header independently; see css/styles.css
   "PAGE SWIPE" for the layer order and animations.
   Both pages put html.vt-swipe on for the transition: that class is what gives
   the header pieces their view-transition names, so the names exist
   only during an EFTForge <-> Atlas move. The old page adds it in pageswap
   (before its last frame is captured), the new page in pagereveal (before its
   first). Loaded in <head> on both pages so pagereveal is caught in time. Every
   other navigation (reloads, links within one side) stays instant, and browsers
   without cross-document view transitions just switch pages.
============================================================ */

(function () {
    const isAtlas = path => /^\/atlas(\/|$)/i.test(path);
    const pathOf = url => { try { return new URL(url).pathname; } catch { return null; } };

    // 'to-atlas' / 'to-eftforge' when the move crosses between the two, else null
    function crossing(fromPath, toPath) {
        if (fromPath == null || toPath == null) return null;
        const fromAtlas = isAtlas(fromPath);
        const toAtlas = isAtlas(toPath);
        if (fromAtlas === toAtlas) return null;
        return toAtlas ? 'to-atlas' : 'to-eftforge';
    }

    function start(vt, type, arriving = false) {
        if (!type) {
            vt.skipTransition();
            return;
        }
        const root = document.documentElement;
        root.classList.remove('vt-blob-reveal');
        root.classList.toggle('vt-blob-arriving', arriving);
        root.classList.add('vt-swipe');
        // Wait for the page switch before revealing tabs that may restore from the catalog mid-animation.
        if (arriving && type === 'to-eftforge') root.classList.add('vt-tabs-pending');
        vt.types.add(type);
        // each Atlas page loads only its own module: the change tracker's or the server list's
        if (arriving && type === 'to-atlas') (EFTForge.atlas || EFTForge.atlasMatching)?.startPageEntrances();
        const finish = () => {
            root.classList.remove('vt-swipe', 'vt-blob-arriving');
            if (arriving) root.classList.add('vt-blob-reveal');
            if (!root.classList.contains('vt-tabs-pending')) return;
            // Commit the hidden state before handing the strip back to its normal CSS transition.
            document.getElementById('tab-bar')?.getBoundingClientRect();
            requestAnimationFrame(() => root.classList.remove('vt-tabs-pending'));
        };
        vt.finished.then(finish, finish);
    }

    // leaving this page
    window.addEventListener('pageswap', (/** @type {any} */ e) => {
        if (!e.viewTransition) return;
        const to = e.activation && e.activation.entry ? pathOf(e.activation.entry.url) : null;
        start(e.viewTransition, crossing(location.pathname, to));
    });

    // arriving on this page
    window.addEventListener('pagereveal', (/** @type {any} */ e) => {
        if (!e.viewTransition) return;
        const nav = /** @type {any} */ (window).navigation;
        const from = nav && nav.activation && nav.activation.from ? pathOf(nav.activation.from.url) : null;
        start(e.viewTransition, crossing(from, location.pathname), true);
    });

    // back/forward cache: a page can come back with the class still on
    window.addEventListener('pageshow', e => {
        if (e.persisted) {
            document.documentElement.classList.remove('vt-swipe', 'vt-tabs-pending', 'vt-blob-reveal', 'vt-blob-arriving');
        }
    });
})();
