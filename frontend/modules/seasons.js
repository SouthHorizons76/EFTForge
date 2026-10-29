window.EFTForge = window.EFTForge || {};

/* ============================================================
   SEASONS
   Seasonal styles (Halloween, Christmas, ...). We pick the season whose date window
   holds today, put its id on <html data-season="...">, and css/seasons.css styles the
   page from that attribute. Loaded in <head>, so the attribute is on before the
   first paint and the page never flashes its normal look.

   Adding a season:
     1. Add an entry to SEASONS below (id, start/end as "MM-DD", both days included;
        a window may wrap the new year, e.g. "12-20" to "01-02").
     2. Add its html[data-season="<id>"] block to css/seasons.css.
     3. Give it a name ({ en, zh }, shown next to the toggle as "<name> <year>"), and
        optionally a tagline and decor ({ page, top }: builder names from DECOR below).
   The first entry whose window matches wins, so list narrower windows first.

   Previewing: ?season=<id> forces a season for this page load, ?season=off turns
   them off. localStorage "eftforge_season" does the same for good ("off" opts out,
   "auto" or nothing follows the calendar).

   Players turn the running season off with the toggle from mountSetting (the About
   modal, or the desktop app's settings), which only shows while a season runs and
   switches the page over on the spot. Turning it off only covers that one run of the
   season (say Halloween 2026): the next season, or the same one next year, shows
   again until they turn it off again.
============================================================ */

(function () {
    const SEASONS = [
        {
            id: "halloween",
            name: { en: "Halloween", zh: "万圣节" },
            start: "10-20",
            end: "11-02",
            decor: { top: "bunting", page: "blobSpider" },
        },
    ];

    const STORAGE_KEY = "eftforge_season";
    // The run of a season the player turned off, e.g. "halloween-2026" (runKey)
    const DISMISS_KEY = "eftforge_season_dismissed";

    // "MM-DD" -> MMDD as a number, so windows compare with plain < and >
    const dayKey = mmdd => Number(mmdd.replace("-", ""));

    function inWindow(season, date) {
        const today = (date.getMonth() + 1) * 100 + date.getDate();
        const start = dayKey(season.start);
        const end = dayKey(season.end);
        return start <= end
            ? today >= start && today <= end
            : today >= start || today <= end; // wraps the new year
    }

    // Names one run of a season by the year its window opened, so a window across the
    // new year keeps one name from December into January
    function runYear(season, date = new Date()) {
        const today = (date.getMonth() + 1) * 100 + date.getDate();
        const wraps = dayKey(season.start) > dayKey(season.end);
        return date.getFullYear() - (wraps && today <= dayKey(season.end) ? 1 : 0);
    }

    const runKey = (season, date = new Date()) => `${season.id}-${runYear(season, date)}`;

    function read(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    }

    let _urlSeason = null;
    try { _urlSeason = new URLSearchParams(location.search).get("season"); } catch {}

    function override() {
        const value = _urlSeason || read(STORAGE_KEY);
        return value && value !== "auto" ? value : null;
    }

    // The season running now (or being previewed), whether or not the player turned it off
    function current(date = new Date()) {
        const forced = override();
        if (forced === "off") return null;
        if (forced) return SEASONS.find(s => s.id === forced) || null;
        return SEASONS.find(s => inWindow(s, date)) || null;
    }

    const dismissed = (season, date = new Date()) => read(DISMISS_KEY) === runKey(season, date);

    // The season to show: the current one, unless the player turned this run of it off
    function resolve(date = new Date()) {
        const season = current(date);
        return season && !dismissed(season, date) ? season : null;
    }

    let active = resolve();

    function applyAttribute() {
        if (active) document.documentElement.dataset.season = active.id;
        else delete document.documentElement.dataset.season;
    }

    applyAttribute();

    /* ---------- Decor ----------
       A season's decor names a builder per spot: DECOR[name](layer, signal) fills the
       layer, and stops any timers of its own when signal aborts (the season switched
       off). Keep each one to a few elements, animated by transform/opacity only if at
       all: they sit on every page.
         page:   a layer inside #page-bg, between the glow and the vignette, so the
                 vignette darkens it like the rest of the backdrop
         top:    an overlay over the whole site, fixed at the top centre of the window, above
                 the header but under modals, letting clicks through; it drops in on load and
                 springs up out of the way while the cursor is over it (hangMotion).
                 Elements inside it with data-omega swing on their thread as it moves. */

    const NS = "http://www.w3.org/2000/svg";

    // Halloween charms for the bunting, each drawn around its hang point (0, 0) on the
    // string. Pennants tilt with the string; charms hang straight down on a thread.
    // SWING sets how each one moves (hangMotion): omega is its swing rate (rad/s, slower
    // on a longer thread), gain how hard the garland's jolts swing it, stretch how far
    // its thread gives when the garland stops short. Pennants are tied along their top
    // edge, so they barely swing and never stretch.
    const THREAD = len => `<path d="M0 0 V${len}" stroke="#8a7a6a" stroke-width="0.6"/>`;
    const CHARMS = {
        flag: color => `<path d="M-9 0 H9 L0 15 Z" fill="${color}"/>`,
        corn: () => `<path d="M-9 0 H9 L6 5 H-6 Z" fill="#f2c230"/>
            <path d="M-6 5 H6 L3 10 H-3 Z" fill="#e8661a"/>
            <path d="M-3 10 H3 L0 15 Z" fill="#f3ead8"/>`,
        pumpkin: () => `${THREAD(4)}
            <path d="M-0.8 5.5 L-0.3 2.5 H1.2 L0.9 5.5 Z" fill="#4a5a22"/>
            <ellipse cx="0" cy="11" rx="7.5" ry="6" fill="#d9581a"/>
            <ellipse cx="0" cy="11" rx="4" ry="6" fill="#ee7426"/>
            <path d="M-4.3 9.6 L-1.6 9.6 L-2.9 7.4 Z M1.6 9.6 L4.3 9.6 L2.9 7.4 Z M-4.4 12.2 Q0 16.4 4.4 12.2 Q0 14.2 -4.4 12.2 Z" fill="#2a1206"/>`,
        bat: () => `${THREAD(4)}
            <path transform="translate(-10 3) scale(0.3125)" fill="#6a3a80" d="M32 9c-1.6 0-2.6 1.6-2.6 1.6L27.6 8l-1 3.8C22.4 7 14.6 5.2 6.8 7.4c3.8 1.8 5.8 4.8 5.6 8-3-2-6.8-2.2-10.2-.2 6 .8 10.2 3.8 12.2 8 2.4-3 6.2-4 10.2-3 2.2.8 4 3.8 7.4 3.8s5.2-3 7.4-3.8c4-1 7.8 0 10.2 3 2-4.2 6.2-7.2 12.2-8-3.4-2-7.2-1.8-10.2.2-.2-3.2 1.8-6.2 5.6-8-7.8-2.2-15.6-.4-19.8 4.4l-1-3.8-1.8 2.6S33.6 9 32 9z"/>`,
        ghost: () => `${THREAD(3)}
            <path d="M-6 17 V9 A6 6 0 0 1 6 9 V17 L4 15 L2 17 L0 15 L-2 17 L-4 15 Z" fill="#e9e4da"/>
            <ellipse cx="-2.2" cy="9" rx="1.1" ry="1.5" fill="#1a1416"/>
            <ellipse cx="2.2" cy="9" rx="1.1" ry="1.5" fill="#1a1416"/>`,
        skull: () => `${THREAD(3)}
            <path d="M-5.5 8.5 A5.5 5.5 0 1 1 5.5 8.5 V11 H3.5 V13.5 H-3.5 V11 H-5.5 Z" fill="#e9e4da"/>
            <circle cx="-2.2" cy="8.2" r="1.5" fill="#1a1416"/>
            <circle cx="2.2" cy="8.2" r="1.5" fill="#1a1416"/>
            <path d="M-0.8 11 H0.8 L0 9.7 Z M-1.5 13.5 V12 M0 13.5 V12 M1.5 13.5 V12" fill="#1a1416" stroke="#1a1416" stroke-width="0.5"/>`,
        spider: () => `${THREAD(15)}
            <g stroke="#7a6a7e" stroke-width="0.8" fill="none" stroke-linecap="round">
                <path d="M-1.5 18 L-5 15 L-6.5 17 M-1.5 19 L-5.5 18 L-7 20.5 M-1.5 20 L-5 21.5 L-6 24 M-1.5 21 L-4 23.5 L-4.5 26"/>
                <path d="M1.5 18 L5 15 L6.5 17 M1.5 19 L5.5 18 L7 20.5 M1.5 20 L5 21.5 L6 24 M1.5 21 L4 23.5 L4.5 26"/>
            </g>
            <circle cx="0" cy="16.6" r="1.7" fill="#7a6a7e"/>
            <ellipse cx="0" cy="20.2" rx="2.6" ry="3" fill="#7a6a7e"/>`,
    };

    const SWING = {
        flag:    { omega: 12,  gain: 0.3, stretch: 0 },
        corn:    { omega: 12,  gain: 0.3, stretch: 0 },
        pumpkin: { omega: 8,   gain: 1,   stretch: 0.12 },
        bat:     { omega: 8,   gain: 1.3, stretch: 0.12 },
        ghost:   { omega: 9,   gain: 1,   stretch: 0.12 },
        skull:   { omega: 8.5, gain: 1,   stretch: 0.12 },
        spider:  { omega: 5,   gain: 1.6, stretch: 0.3 },
    };

    // The blob spider, drawn facing up around its middle (0, 0). Its legs are split into
    // the two sets a spider steps with in turn, so the gait can alternate them.
    const SPIDER_SVG = `<svg viewBox="-16 -16 32 32" aria-hidden="true">
        <g class="spider-legs-a">
            <path d="M-3 -1 L-8 -6 L-10 -11 M3.5 1 L9 -1 L13 -4 M-3.5 3.5 L-9 5 L-13 9 M3 6 L7 10 L9 15"/>
        </g>
        <g class="spider-legs-b">
            <path d="M3 -1 L8 -6 L10 -11 M-3.5 1 L-9 -1 L-13 -4 M3.5 3.5 L9 5 L13 9 M-3 6 L-7 10 L-9 15"/>
        </g>
        <circle cx="0" cy="-3" r="2.6"/>
        <ellipse cx="0" cy="4" rx="4" ry="5.5"/>
    </svg>`;

    // Walks the blob spider straight across the corner blob (centred at 85% / 90% of
    // #page-bg, see .page-bg-blob in styles.css), diagonally from its bottom left to its
    // upper right without stopping: in past the bottom edge, out past the right edge. Its
    // line runs a little to one side of the blob's centre or the other. The whole trip is
    // one compositor animation of its transform.
    async function crawlSpider(layer) {
        const W = layer.clientWidth, H = layer.clientHeight;
        if (!W || !H) return;
        const SPEED = 560, OUT = 64; // px/s, and how far past the edges it starts and ends (clear of its legs)
        const cx = W * 0.85, cy = H * 0.9;
        const side = (Math.random() * 2 - 1) * 60;
        // the 45 degree line x + y = cx + cy + side, from the bottom edge to the right edge
        const from = { x: cx + cy + side - (H + OUT), y: H + OUT };
        const to = { x: W + OUT, y: cx + cy + side - (W + OUT) };
        const pose = p => `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) rotate(45deg)`;

        const spider = document.createElement("div");
        spider.className = "blob-spider walking";
        spider.innerHTML = SPIDER_SVG;
        layer.appendChild(spider);
        try {
            await spider.animate([{ transform: pose(from) }, { transform: pose(to) }], {
                duration: Math.hypot(to.x - from.x, to.y - from.y) / SPEED * 1000,
                easing: "linear",
                fill: "forwards",
            }).finished;
        } catch { /* cancelled */ } finally {
            spider.remove();
        }
    }

    const DECOR = {
        // Now and then (1% a second, so about once every couple of minutes) a spider crawls over the
        // corner blob. Between crawls nothing runs but this one cheap roll.
        blobSpider(layer, signal) {
            if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
            let crawling = false;
            const timer = setInterval(() => {
                if (crawling || document.hidden || Math.random() >= 0.01) return;
                crawling = true;
                crawlSpider(layer).finally(() => { crawling = false; });
            }, 1000);
            signal.addEventListener("abort", () => clearInterval(timer));
        },

        // A garland sagging across the top of the window, hung from its edge: pennants
        // with charms between them, the spider dropping from the middle
        bunting(layer) {
            const W = 380, SAG = 16, TOP = 1;
            const strand = ["flag", "pumpkin", "corn", "bat", "flag", "ghost", "corn", "spider",
                            "corn", "skull", "flag", "bat", "corn", "pumpkin", "flag"];
            const flagColors = ["#e8661a", "#5a2e6e", "#b3201c"];
            const at = t => TOP + 4 * SAG * t * (1 - t); // the string's height along it
            let items = "", flags = 0;
            strand.forEach((name, i) => {
                const t = (i + 0.5) / strand.length;
                const x = (W * t).toFixed(1), y = at(t).toFixed(1);
                const pennant = name === "flag" || name === "corn";
                const tilt = pennant ? Math.atan2(4 * SAG * (1 - 2 * t), W) * 180 / Math.PI : 0;
                const art = CHARMS[name](name === "flag" ? flagColors[flags++ % flagColors.length] : undefined);
                // Alternate the swing's direction and vary its strength, so the charms
                // don't all move in step
                const { omega, gain, stretch } = SWING[name];
                const kick = gain * (i % 2 ? -1 : 1) * (0.75 + 0.5 * ((i * 7) % 5) / 4);
                items += `<g transform="translate(${x} ${y}) rotate(${tilt.toFixed(1)})">`
                    + `<g data-omega="${omega}" data-gain="${kick.toFixed(2)}" data-stretch="${stretch}">${art}</g></g>`;
            });
            layer.innerHTML = `<svg xmlns="${NS}" viewBox="0 0 ${W} 46" width="${W}" height="46" aria-hidden="true">
                <path d="M0 ${TOP} Q${W / 2} ${TOP + 2 * SAG} ${W} ${TOP}" fill="none" stroke="#6b5a4a" stroke-width="1"/>
                ${items}
            </svg>`;
        },
    };

    const SPOTS = {
        page: layer => {
            const bg = document.getElementById("page-bg");
            if (!bg) return false;
            bg.insertBefore(layer, bg.querySelector(".page-bg-vignette"));
            return true;
        },
        top: (layer, signal) => {
            document.body.appendChild(layer);
            dodgeCursor(layer, hangMotion(layer), signal);
            return true;
        },
    };

    // The top overlay's physics. The garland rides a soft spring toward where it hangs
    // (or tucked above the window while dodging), so it drops in with a bounce. Each
    // swinging piece is a damped pendulum kicked by the garland's acceleration, and its
    // thread a stiff spring that gives a little when the garland stops short. We only
    // run frames while something is still moving, and stop once it all settles.
    function hangMotion(layer) {
        const K = 110, C = 10;                 // the garland's spring and damping
        const SWING_DAMP = 2, KICK = 0.0025;  // pendulum damping, rad/s^2 per px/s^2
        const THREAD_K = 400, THREAD_C = 12;   // the threads' spring and damping
        const STEP = 1 / 120;
        const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const svg = layer.querySelector("svg");
        const pieces = Array.from(layer.querySelectorAll("[data-omega]"), el => {
            const d = /** @type {HTMLElement} */ (el).dataset;
            return { el, omega: +d.omega, gain: +d.gain, stretch: +d.stretch, th: 0, w: 0, s: 0, sv: 0 };
        });
        const tucked = () => -(layer.offsetHeight + 8);
        // px on screen per SVG unit, for the threads (which stretch in SVG units)
        const scale = () => layer.offsetWidth / ((svg && svg.viewBox.baseVal.width) || layer.offsetWidth);

        let y = tucked(), v = 0, target = y;
        let running = false, last = 0, acc = 0, unit = 1;

        function render() {
            layer.style.transform = `translate(-50%, ${y.toFixed(2)}px)`;
            for (const p of pieces) {
                p.el.setAttribute("transform", `translate(0 ${p.s.toFixed(2)}) rotate(${(p.th * 57.2958).toFixed(2)})`);
            }
        }

        function step(dt) {
            const a = K * (target - y) - C * v;
            v += a * dt;
            y += v * dt;
            for (const p of pieces) {
                const wa = -p.omega * p.omega * Math.sin(p.th) - SWING_DAMP * p.w + a * p.gain * KICK;
                p.w += wa * dt;
                p.th += p.w * dt;
                if (p.stretch) {
                    // the thread can give, but can't push the charm up past its hang point
                    const sa = -THREAD_K * p.s - THREAD_C * p.sv - (a / unit) * p.stretch;
                    p.sv += sa * dt;
                    p.s = Math.max(-0.5, p.s + p.sv * dt);
                }
            }
        }

        const settled = () => Math.abs(target - y) < 0.2 && Math.abs(v) < 1
            && pieces.every(p => Math.abs(p.th) < 0.005 && Math.abs(p.w) < 0.02 && Math.abs(p.s) < 0.02 && Math.abs(p.sv) < 0.05);

        function frame(t) {
            if (!layer.isConnected) return; // seasons were switched off
            const dt = last ? Math.min((t - last) / 1000, 0.05) : STEP; // a hidden tab pauses us
            last = t;
            acc += dt;
            while (acc >= STEP) {
                step(STEP);
                acc -= STEP;
            }
            if (settled()) {
                running = false;
                y = target;
                v = 0;
                for (const p of pieces) p.th = p.w = p.s = p.sv = 0;
                render();
                return;
            }
            render();
            requestAnimationFrame(frame);
        }

        function moveTo(next) {
            target = next;
            if (still) {
                y = target;
                render();
                return;
            }
            if (running) return;
            running = true;
            last = 0;
            acc = 0;
            unit = scale() || 1;
            requestAnimationFrame(frame);
        }

        render();
        // Give the page a moment to appear, then drop the garland in
        setTimeout(() => moveTo(0), 400);

        return { dodge: on => moveTo(on ? tucked() : 0) };
    }

    // The overlay lets clicks through, so it can't see the cursor itself: we watch the
    // pointer on the window and check it against where the layer hangs at rest (fixed,
    // top centre; its offset size ignores the motion). It comes back once the cursor is
    // clear of that spot by a margin, so it doesn't flutter at the edge.
    function dodgeCursor(layer, motion, signal) {
        const MARGIN = 24;
        let x = -1, y = -1, queued = false;
        const update = () => {
            queued = false;
            const w = layer.offsetWidth, h = layer.offsetHeight;
            const left = (window.innerWidth - w) / 2;
            const tucked = layer.classList.contains("season-dodged");
            const pad = tucked ? MARGIN : 0;
            const over = x >= left - pad && x <= left + w + pad && y >= 0 && y <= h + pad;
            if (over === tucked) return;
            layer.classList.toggle("season-dodged", over);
            motion.dodge(over);
        };
        window.addEventListener("pointermove", e => {
            if (e.pointerType === "touch") return;
            x = e.clientX;
            y = e.clientY;
            if (!queued) {
                queued = true;
                requestAnimationFrame(update);
            }
        }, { passive: true, signal });
        // The cursor left the window: let the garland back down
        document.documentElement.addEventListener("pointerleave", () => {
            if (!layer.classList.contains("season-dodged")) return;
            layer.classList.remove("season-dodged");
            motion.dodge(false);
        }, { signal });
    }

    // Aborted to take the decor down again, which drops its window listeners too
    let _decorAbort = null;

    function mountDecor() {
        if (!active || !active.decor) return;
        _decorAbort = new AbortController();
        for (const [spot, name] of Object.entries(active.decor)) {
            if (!SPOTS[spot] || !DECOR[name] || document.querySelector(`.season-decor-${spot}`)) continue;
            const layer = document.createElement("div");
            layer.className = `season-decor season-decor-${spot} season-decor-${name}`;
            DECOR[name](layer, _decorAbort.signal);
            if (!SPOTS[spot](layer, _decorAbort.signal)) layer.remove();
        }
    }

    function unmountDecor() {
        if (_decorAbort) _decorAbort.abort();
        _decorAbort = null;
        document.querySelectorAll(".season-decor").forEach(el => el.remove());
    }

    /* ---------- Text ---------- */

    let _defaultTagline = null;

    // Called from applyStaticTranslations (app.js), so the tagline follows language switches
    function applyText() {
        const tagline = document.querySelector(".header-tagline");
        if (!tagline || EFTForge.config?.IS_BETA) return; // the beta's tagline names the beta
        if (_defaultTagline === null) _defaultTagline = tagline.textContent;
        const lang = EFTForge.state?.lang === "zh" ? "zh" : "en";
        tagline.textContent = active?.tagline?.[lang] || _defaultTagline;
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", mountDecor, { once: true });
    } else {
        mountDecor();
    }

    /* ---------- Setting ---------- */

    const enabled = () => {
        const season = current();
        return !!season && !dismissed(season);
    };

    // Turn the running season on or off, and switch the page over right away. Off only
    // covers this run of it, so the next one shows again.
    function setEnabled(on) {
        const season = current();
        if (!season) return;
        try {
            if (on) localStorage.removeItem(DISMISS_KEY);
            else localStorage.setItem(DISMISS_KEY, runKey(season));
        } catch {}
        active = resolve();
        applyAttribute();
        unmountDecor();
        mountDecor();
        applyText();
    }

    // The on/off toggle, drawn into el (the About modal on the website, the desktop
    // app's settings modal). Those only draw it while a season runs
    // (EFTForge.season.current).
    // While it's on, the running season shows to the right of it, e.g. "Halloween 2026".
    function mountSetting(el) {
        const season = current();
        if (!el || !season) return;
        const { t } = EFTForge.lang;
        const lang = EFTForge.state?.lang === "zh" ? "zh" : "en";
        const name = `${season.name?.[lang] || season.id} ${runYear(season)}`;
        el.classList.add("season-setting");
        el.innerHTML = `
            <button type="button" class="compare-toggle season-setting-toggle">
                ${t("season.toggle")}
                <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
            </button>
            <span class="season-setting-name"></span>`;
        const btn = el.querySelector("button");
        const label = el.querySelector(".season-setting-name");
        label.textContent = name;
        const show = on => {
            btn.classList.toggle("active", on);
            label.hidden = !on;
        };
        show(enabled());
        btn.addEventListener("click", () => {
            const on = !enabled();
            setEnabled(on);
            show(on);
        });
    }

    window.EFTForge.season = {
        get active() { return active ? active.id : null; },
        get current() { const season = current(); return season ? season.id : null; },
        list: SEASONS.map(s => s.id),
        resolve,
        applyText,
        enabled,
        setEnabled,
        mountSetting,
    };
})();
