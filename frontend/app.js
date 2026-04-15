
// Guard variables - declared at top to avoid TDZ errors from hoisted function calls below.
let _syncNoticeInterval = null;
let _clockInterval      = null;
let _langSwitching      = false;


/* ===========================
   GUN LIST FILTER
=========================== */

function renderFilteredGunList(forceReset = false) {
    const query = document.getElementById("gun-search")?.value.toLowerCase() ?? "";
    const filtered = query
        ? EFTForge.state.allGuns.filter(g => g.name.toLowerCase().includes(query))
        : EFTForge.state.allGuns;
    renderGunList(filtered, forceReset);
}

/* ===========================
   INITIAL LOAD
=========================== */

init();
devVersionCheck();
mobileWarning();
initTarkovClock();

async function init() {
  const loadingOverlay = startPanelLoading(document.querySelector(".left-panel"));

  fetchTraders()
    .then(traders => {
      EFTForge.state.traders = Object.fromEntries(traders.map(t => [t.id, t]));
      EFTForge.state.tradersByNorm = Object.fromEntries(
        traders.filter(t => t.normalizedName).map(t => [t.normalizedName, t])
      );
    })
    .catch(err => console.warn("Could not load traders:", err));

  async function tryLoadGuns(isRetry = false) {
    try {
      EFTForge.state.allGuns = await fetchGuns();
      renderGunList(EFTForge.state.allGuns);
      stopPanelLoading(loadingOverlay);
      // Highlight any gun with an unfinished mid-build from before the page was refreshed
      _applyMidBuildIndicator();
      // Auto-load a build from the ?build= URL parameter (for external site integrations)
      _checkUrlBuildParam();
      // Restore flea cache from sessionStorage before prefetching so F5 reloads skip the fetch.
      restoreFleaCache();
      // Auto-refetch if cached data is older than 1 hour, otherwise only fetch missing items.
      const FLEA_TTL_MS = 60 * 60 * 1000;
      const cacheAge = EFTForge.state.fleaLastFetched
          ? Date.now() - new Date(EFTForge.state.fleaLastFetched).getTime()
          : Infinity;
      // Piggyback update check on the same 1-hour TTL as flea data.
      checkForUpdate();
      if (cacheAge > FLEA_TTL_MS) {
          refetchFleaPrices();
      } else {
          const _idsCtrl = new AbortController();
          setTimeout(() => _idsCtrl.abort(), 10000);
          fetch(`${EFTForge.config.API_BASE}/items/ids`, { signal: _idsCtrl.signal })
            .then(r => r.json())
            .then(async ids => {
              const missing = ids.filter(id => !(id in EFTForge.state.fleaCachePvp));
              if (missing.length === 0) return;
              const { t: _t } = EFTForge.lang;
              showToast(_t("stats.fleaMarket"), `${_t("stats.fleaFetching")} ${missing.length} ${_t("stats.fleaFetchingItems")}`, 4000, "#c8a84b");
              const CHUNK = 300;
              for (let i = 0; i < missing.length; i += CHUNK) {
                await new Promise(resolve => setTimeout(resolve, 0));
                await ensureFleaPrices(missing.slice(i, i + CHUNK));
              }
              showToast(_t("stats.fleaMarket"), _t("stats.fleaCached"), 3000, "#4caf50");
            })
            .catch(err => console.warn("Could not fetch item IDs for flea cache:", err));
      }
    } catch (err) {
      console.error("Failed to load guns:", err);
      if (!isRetry) {
        showToast(t("toast.connectionError"), t("toast.backendDown") + " " + (EFTForge.config.IS_LOCAL_DEV ? t("toast.networkHintDev") : t("toast.networkHintProd")), 7000);
      }
      setTimeout(() => tryLoadGuns(true), 5000);
    }
  }

  tryLoadGuns();
  _startNotificationPolling();
  document
    .getElementById("gun-search")
    .addEventListener("input", () => renderFilteredGunList());


    document.addEventListener("keydown", (e) => {
    // ESC closes modal or clears search
    if (e.key === "Escape") {
        const modal = document.querySelector(".modal-overlay");
        if (modal) { modal.remove(); return; }
        clearSearch();
        document.activeElement.blur();
        return;
    }

    // Ignore if user is already typing in an input
    const tag = document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    // Ignore control keys
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Only react to printable characters
    if (e.key.length === 1) {
        // Don't hijack keypresses while any modal or drawer is open
        if (document.querySelector(".modal-overlay")) return;
        if (document.getElementById("main-container")?.hasAttribute("inert")) return;

        e.preventDefault();

        const gunInput = document.getElementById("gun-search");
        const attachmentInput = document.getElementById("attachment-search");

        if (gunInput && gunInput.offsetParent !== null) {
            focusGunSearch(e.key);
        }
        else if (attachmentInput && attachmentInput.offsetParent !== null) {
            focusAttachmentSearch(e.key);
        }
        }
    });

    document.getElementById("primary-btn").addEventListener("click", () => {
        if (!EFTForge.state.showHandguns) return;
        EFTForge.state.showHandguns = false;
        updateToggleUI();
        renderFilteredGunList(true);
    });

    document.getElementById("handgun-btn").addEventListener("click", () => {
        if (EFTForge.state.showHandguns) return;
        EFTForge.state.showHandguns = true;
        updateToggleUI();
        renderFilteredGunList(true);
    });

    document.getElementById("sort-caliber-btn").addEventListener("click", () => {
        if (!EFTForge.state.sortByClass) return;
        EFTForge.state.sortByClass = false;
        updateToggleUI();
        renderFilteredGunList(true);
    });

    document.getElementById("sort-class-btn").addEventListener("click", () => {
        if (EFTForge.state.sortByClass) return;
        EFTForge.state.sortByClass = true;
        updateToggleUI();
        renderFilteredGunList(true);
    });

    applyStaticTranslations();

    setupCustomSelect("lang-select");

    renderSavedBuildsList();

    scheduleSyncNotice();

    initPanelResizer();
}

/* ===========================
   MOBILE WARNING
=========================== */

function isMobileLayout() {
    const hasTouch = navigator.maxTouchPoints > 0;
    const hasCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
    const mobileUA = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);
    return (hasTouch && hasCoarsePointer) || (hasTouch && mobileUA);
}

/* ===========================
   PANEL RESIZER
=========================== */

function initPanelResizer() {

    if (isMobileLayout()) return;

    const resizer   = document.getElementById("panel-resizer");
    const leftPanel = document.querySelector(".left-panel");
    const container = document.getElementById("main-container");

    const DEFAULT_WIDTH = 554;
    const MIN_LEFT      = 554;
    const MIN_RIGHT     = 720;

    const saved = parseInt(localStorage.getItem("eftforge_panel_width"));
    const maxInit = container.offsetWidth - MIN_RIGHT - resizer.offsetWidth;
    leftPanel.style.width = (saved >= MIN_LEFT && saved <= maxInit ? saved : DEFAULT_WIDTH) + "px";

    let dragging = false;
    let startX, startW;

    resizer.addEventListener("mousedown", e => {
        dragging = true;
        startX   = e.clientX;
        startW   = leftPanel.offsetWidth;
        resizer.classList.add("dragging");
        document.body.style.cursor     = "col-resize";
        document.body.style.userSelect = "none";
        e.preventDefault();
    });

    document.addEventListener("mousemove", e => {
        if (!dragging) return;
        const maxWidth = container.offsetWidth - MIN_RIGHT - resizer.offsetWidth;
        const newWidth = Math.min(maxWidth, Math.max(MIN_LEFT, startW + (e.clientX - startX)));
        leftPanel.style.width = newWidth + "px";
    }, { passive: true });

    document.addEventListener("mouseup", () => {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove("dragging");
        document.body.style.cursor     = "";
        document.body.style.userSelect = "";
        localStorage.setItem("eftforge_panel_width", leftPanel.offsetWidth);
    });

    let resizeAnimFrame = null;
    window.addEventListener("resize", () => {
        if (isMobileLayout()) return;
        if (dragging) return;
        cancelAnimationFrame(resizeAnimFrame);
        resizeAnimFrame = requestAnimationFrame(() => {
            if (container.classList.contains("no-gun")) return;
            const maxWidth = container.offsetWidth - MIN_RIGHT - resizer.offsetWidth;
            const current  = leftPanel.offsetWidth;
            if (current <= maxWidth) return;
            const clamped = Math.max(MIN_LEFT, maxWidth);
            leftPanel.style.transition = "width 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94)";
            leftPanel.style.width = clamped + "px";
            leftPanel.addEventListener("transitionend", () => {
                leftPanel.style.transition = "";
                localStorage.setItem("eftforge_panel_width", clamped);
            }, { once: true });
        });
    });
}

/* ===========================
   DAILY SYNC NOTICE
=========================== */

function scheduleSyncNotice() {
    if (_syncNoticeInterval !== null) return;
    // Sync runs at 04:00 CST (UTC+8). Warn from 03:58 to 04:01.
    const SYNC_HOUR   = 4;
    const WARN_START  = 58; // minutes before SYNC_HOUR (i.e. 03:58)
    const WARN_END_M  = 1;  // minutes after SYNC_HOUR to keep warning (i.e. 04:01)

    function getCSTDate() {
        const now = new Date();
        return new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
    }

    function checkAndNotify() {
        const cst  = getCSTDate();
        const h    = cst.getHours();
        const m    = cst.getMinutes();

        const inWindow =
            (h === SYNC_HOUR - 1 && m >= WARN_START) ||
            (h === SYNC_HOUR     && m <= WARN_END_M);

        if (!inWindow) return;

        const todayKey = `eftforge_sync_notice_${cst.toISOString().slice(0, 10)}`;
        if (localStorage.getItem(todayKey)) return;
        localStorage.setItem(todayKey, "1");

        const { t } = EFTForge.lang;
        showToast(t("toast.syncNoticeTitle"), t("toast.syncNoticeMsg"), 12000, "#f5a623");
    }

    checkAndNotify();
    _syncNoticeInterval = setInterval(checkAndNotify, 60000);
}

/* ===========================
   DEV VERSION CHECK
=========================== */

async function devVersionCheck() {
    if (!["localhost", "127.0.0.1"].includes(location.hostname)) return;

    const files = ["app.js", "modules/build-manager.js", "index.html"];
    const buildDate = new Date(EFTForge.config.APP_BUILD_DATE);

    let latestModified = null;
    let latestFile = null;

    await Promise.all(files.map(async file => {
        try {
            const res = await fetch(`./${file}`, { method: "HEAD", cache: "no-store" });
            const lm = res.headers.get("Last-Modified");
            if (!lm) return;
            const d = new Date(lm);
            if (!latestModified || d > latestModified) {
                latestModified = d;
                latestFile = file;
            }
        } catch { /* ignore */ }
    }));

    if (!latestModified) return;

    if (latestModified <= buildDate) return;

    const banner = document.createElement("div");
    banner.id = "dev-version-warning";
    banner.style.cssText = `
        position: fixed;
        bottom: 20px;
        left: 20px;
        background: #1c1500;
        border-left: 4px solid #f5c542;
        color: #eee;
        padding: 12px 16px;
        border-radius: 6px;
        font-family: "Bender", Arial, sans-serif;
        font-size: 13px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        z-index: 9998;
        cursor: pointer;
        max-width: 300px;
        line-height: 1.5;
    `;
    banner.innerHTML = `
        <div style="font-weight:700; color:#f5c542; margin-bottom:5px;">&#9888; Dev: Update Version Info</div>
        <div style="color:#aaa; font-weight:500;">
            <strong style="color:#ccc;">${escapeHtml(latestFile)}</strong> was modified after
            <strong style="color:#ccc;">${escapeHtml(EFTForge.config.APP_BUILD_DATE)}</strong> (UTC).<br>
            Bump <strong style="color:#eee;">EFTForge.config.APP_VERSION</strong> and
            <strong style="color:#eee;">EFTForge.config.APP_BUILD_DATE</strong> in modules/config.js.
        </div>
        <div style="font-size:11px; color:#555; margin-top:8px;">Click to dismiss</div>
    `;
    banner.addEventListener("click", () => banner.remove());
    document.body.appendChild(banner);
}

/* ===========================
   UPDATE CHECKER
=========================== */

// Returns the server's APP_BUILD_DATE as a Date, or null on any failure.
async function _fetchRemoteBuildDate() {
    try {
        const res = await fetch(`./modules/config.js?_uc=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return null;
        const text = await res.text();
        const match = text.match(/APP_BUILD_DATE:\s*["']([^"']+)["']/);
        if (!match) return null;
        const d = new Date(match[1]);
        return isNaN(d.getTime()) ? null : d;
    } catch { return null; }
}

async function checkForUpdate() {
    // Skip on localhost - devVersionCheck handles dev warnings.
    if (["localhost", "127.0.0.1"].includes(location.hostname)) return;

    const UPDATE_CHECK_KEY  = "eftforge_update_check_ts";
    const SERVER_BOOT_KEY   = "eftforge_server_boot";
    const TTL_MS = 60 * 60 * 1000;

    // Check if the backend restarted since we last ran - a new SERVER_START_TIME
    // means a fresh deploy landed and we should bypass the local TTL.
    let bypassTtl = false;
    try {
        const hRes = await fetch(`${EFTForge.config.API_BASE}/health`, { cache: "no-store" });
        if (hRes.ok) {
            const { started } = await hRes.json();
            const lastBoot = localStorage.getItem(SERVER_BOOT_KEY);
            if (started && String(started) !== lastBoot) {
                localStorage.setItem(SERVER_BOOT_KEY, String(started));
                bypassTtl = true;
            }
        }
    } catch { /* non-fatal - fall through to TTL check */ }

    if (!bypassTtl) {
        const lastCheck = localStorage.getItem(UPDATE_CHECK_KEY);
        if (lastCheck && (Date.now() - Number(lastCheck)) < TTL_MS) return;
    }

    // Mark the check time regardless of outcome so we don't hammer on every load.
    localStorage.setItem(UPDATE_CHECK_KEY, String(Date.now()));

    const serverBuildDate = await _fetchRemoteBuildDate();
    if (!serverBuildDate) return;

    const localBuildDate = new Date(EFTForge.config.APP_BUILD_DATE);
    if (serverBuildDate <= localBuildDate) return;

    // New deployment detected - show a persistent toast with an update button.
    const { t: _t } = EFTForge.lang;
    showToast(
        _t("toast.updateAvailableTitle"),
        _t("toast.updateAvailableMsg"),
        0,
        "#4caf50",
        [{ label: _t("toast.updateNow"), onClick: () => window.location.reload() }]
    );
}

/* ===========================
   TARKOV CLOCK
=========================== */

function initTarkovClock() {
    if (_clockInterval !== null) return;
    // Tarkov runs at 7x real time, anchored to UTC with a +3h (Moscow) offset.
    // Left and right server clocks are always 12 hours apart.
    // Derived empirically: at 12:26:30 UTC, left showed 18:05:34 => offset = +10800s.
    // Day = 05:45-21:30 per wiki (dawn/sunset), using round boundaries for the indicator.
    const LEFT_OFFSET_MS  = 10_800_000; // +3 h
    const RIGHT_OFFSET_MS = 54_000_000; // +3 h + 12 h

    function msToTime(ms) {
        const totalSec = Math.floor(ms / 1000);
        return {
            hours:   Math.floor(totalSec / 3600),
            minutes: Math.floor((totalSec % 3600) / 60),
            seconds: totalSec % 60,
        };
    }

    // Returns a 0-1 progress value that peaks at 1 at noon and 0 at midnight,
    // using a cosine curve so colors ease in/out smoothly throughout the full day cycle.
    function dayProgress(ms) {
        const { hours, minutes, seconds } = msToTime(ms);
        const frac = hours + minutes / 60 + seconds / 3600;
        return (1 - Math.cos(frac * Math.PI / 12)) / 2;
    }

    // Returns a color string for the time label - warm yellow at noon, cool purple at midnight,
    // with a continuous cosine curve so there's no hard jump at dawn or dusk.
    function timeColor(ms) {
        const t = dayProgress(ms);
        // midnight: rgb(96,96,128) #606080  |  noon: rgb(200,160,48) ~#c8a030
        const r = Math.round(96  + 104 * t);
        const g = Math.round(96  +  64 * t);
        const b = Math.round(128 -  80 * t);
        return `rgb(${r},${g},${b})`;
    }

    // Returns a color string for the dot - warm amber at noon, muted blue-purple at midnight.
    function dotColor(ms) {
        const t = dayProgress(ms);
        // midnight: rgb(90,90,138) #5a5a8a  |  noon: rgb(196,149,42) #c4952a
        const r = Math.round(90  + 106 * t);
        const g = Math.round(90  +  59 * t);
        const b = Math.round(138 -  96 * t);
        return `rgb(${r},${g},${b})`;
    }

    // Cache last-written values per entry to skip redundant DOM writes.
    const _clockCache = {};

    function applyEntry(dotId, timeId, ms) {
        const { hours, minutes, seconds } = msToTime(ms);

        const dotEl  = document.getElementById(dotId);
        const timeEl = document.getElementById(timeId);
        if (!dotEl || !timeEl) return;

        const timeStr = String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
        const dotBg   = dotColor(ms);
        const timeFg  = timeColor(ms);

        const cache = _clockCache[dotId] || (_clockCache[dotId] = {});
        if (timeStr !== cache.timeStr) { timeEl.textContent = timeStr; cache.timeStr = timeStr; }
        if (dotBg   !== cache.dotBg)   { dotEl.style.background = dotBg;  cache.dotBg = dotBg; }
        if (timeFg  !== cache.timeFg)  { timeEl.style.color = timeFg;     cache.timeFg = timeFg; }
    }

    function tick() {
        const base = Date.now() * 7;
        applyEntry("tarkov-dot-left",  "tarkov-time-left",  (base + LEFT_OFFSET_MS)  % 86_400_000);
        applyEntry("tarkov-dot-right", "tarkov-time-right", (base + RIGHT_OFFSET_MS) % 86_400_000);
    }

    tick();
    // Update every ~143ms (1000/7) so Tarkov seconds don't visibly skip
    _clockInterval = setInterval(tick, Math.floor(1000 / 7));
}

/* ===========================
   MOBILE WARNING
=========================== */

function mobileWarning() {
    if (!isMobileLayout()) return;
    document.body.dataset.mobile = "true";

    const { t } = EFTForge.lang;
    showToast(t("toast.mobileWarningTitle"), t("toast.mobileWarningMsg"), 6000, "#c8a84b");

    const backBtn = document.getElementById("mobile-drawer-back");
    if (backBtn) backBtn.addEventListener("click", closeMobileRightPanel);

    const publishTray = document.getElementById("mobile-publish-tray");
    if (publishTray) publishTray.addEventListener("click", openMobileRightPanel);

    document.addEventListener("pointerdown", (e) => {
        if (!document.body.classList.contains("mobile-right-open")) return;
        const rp = document.querySelector(".right-panel");
        if (rp && !rp.contains(e.target)) closeMobileRightPanel();
    });

    _initSwipeObserver();

    // Fix display mode when orientation changes (e.g. rotate phone while gun is selected)
    window.matchMedia("(orientation: landscape)").addEventListener("change", (e) => {
        const buildArea = document.getElementById("left-build-area");
        if (!buildArea || buildArea.style.display === "none" || buildArea.style.display === "") return;
        buildArea.style.display = e.matches ? "grid" : "flex";
    });
}

function openMobileRightPanel() {
    if (!isMobileLayout()) return;
    document.body.classList.add("mobile-right-open");
    const rp = document.querySelector(".right-panel");
    if (rp) rp.scrollTop = 0;
}

function closeMobileRightPanel() {
    document.body.classList.remove("mobile-right-open");
}

function addSwipeToRemove(el, onRemove) {
    const THRESHOLD = 72;
    let startX = 0, startY = 0, tracking = false, dx = 0;
    el.addEventListener("touchstart", (e) => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        tracking = true; dx = 0;
    }, { passive: true });
    el.addEventListener("touchmove", (e) => {
        if (!tracking) return;
        dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        if (Math.abs(dy) > Math.abs(dx) + 10) { tracking = false; return; }
        if (dx < 0) {
            el.classList.add("swipe-revealing");
            el.style.transform = `translateX(${Math.max(dx, -THRESHOLD)}px)`;
            e.preventDefault();
        }
    }, { passive: false });
    el.addEventListener("touchend", () => {
        if (!tracking) return;
        tracking = false;
        el.classList.remove("swipe-revealing");
        el.style.transform = "";
        if (dx <= -THRESHOLD) onRemove();
    }, { passive: true });
    el.addEventListener("touchcancel", () => {
        tracking = false;
        el.classList.remove("swipe-revealing");
        el.style.transform = "";
    }, { passive: true });
}

function _initSwipeObserver() {
    const applySwipe = (root) => {
        const targets = root.classList?.contains("swipe-removable")
            ? [root, ...root.querySelectorAll(".swipe-removable")]
            : (root.querySelectorAll?.(".swipe-removable") ?? []);
        for (const el of targets) {
            if (el._swipeAttached || !el._swipeRemoveFn) continue;
            el._swipeAttached = true;
            addSwipeToRemove(el, el._swipeRemoveFn);
        }
    };
    const obs = new MutationObserver((mutations) => {
        for (const m of mutations)
            for (const added of m.addedNodes)
                if (added.nodeType === 1) applySwipe(added);
    });
    const slots = document.getElementById("slots");
    const tableBox = document.getElementById("attachment-table-container");
    if (slots) obs.observe(slots, { childList: true, subtree: true });
    if (tableBox) obs.observe(tableBox, { childList: true, subtree: true });
}

/* ===========================
   UI - ABOUT DIALOG
=========================== */

function showAboutDialog() {
    if (document.getElementById("about-dialog")) return;

    const overlay = document.createElement("div");
    overlay.id = "about-dialog";
    overlay.className = "modal-overlay";

    overlay.innerHTML = `
        <div class="modal-window" style="max-width:440px;">
            <div class="modal-header">
                <span class="modal-title">${t("about.title")}</span>
                <div style="display:flex; align-items:center; gap:4px;">
                    <a href="https://github.com/SouthHorizons76/EFTForge/issues/new" target="_blank" rel="noopener noreferrer" class="modal-close-btn" style="text-decoration:none; font-size:11px; letter-spacing:1px; display:inline-flex; align-items:center;">${t("about.reportBug")}</a>
                    <button class="modal-close-btn" id="about-modal-close">&#x2715;</button>
                </div>
            </div>
            <div class="modal-body" style="gap:16px;">

                <div style="display:flex; align-items:center; justify-content:space-between; user-select:none;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <img src="./assets/images/EFTForge1080x1080.png" alt="EFTForge Logo" style="width:40px; height:40px; object-fit:contain; opacity:0.9; flex-shrink:0;" />
                        <span style="font-size:22px; font-weight:700; color:#f5c542; letter-spacing:2px;">EFTForge</span>
                    </div>
                    <div style="display:flex; flex-direction:column; align-items:flex-end; gap:5px;">
                        <span style="font-size:13px; color:#555; letter-spacing:1px;">
                            ${escapeHtml(EFTForge.config.APP_VERSION)} - ${escapeHtml(EFTForge.config.APP_BUILD_DATE.slice(0, 10))}
                        </span>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span id="about-update-status" style="font-size:12px;"></span>
                            <button id="about-check-update-btn" class="cost-flea-refetch-btn">${t("about.checkForUpdates")}</button>
                        </div>
                    </div>
                </div>

                <div>
                    <a href="https://github.com/SouthHorizons76/EFTForge"
                       target="_blank" rel="noopener noreferrer"
                       style="color:#4e8fd4; font-size:13px; letter-spacing:0.5px; text-decoration:none;">
                        https://github.com/SouthHorizons76/EFTForge
                    </a>
                </div>

                <hr class="modal-divider" style="margin:0;" />

                <div style="font-size:13px; color:#888; line-height:1.75;">
                    <p style="margin:0 0 10px 0;">${t("about.disclaimer1")}</p>
                    <p style="margin:0 0 10px 0;">${t("about.disclaimer2")}</p>
                    <p style="margin:0;">
                        ${t("about.dataSource")}
                        <a href="https://tarkov.dev/api" target="_blank" rel="noopener noreferrer"
                           style="color:#888; text-decoration:underline; text-underline-offset:3px;">tarkov.dev API</a>.
                    </p>
                </div>

                <hr class="modal-divider" style="margin:0;" />

                <div style="font-size:12px; color:#444; letter-spacing:0.5px;">
                    ${t("about.copyright")}
                </div>

            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    document.getElementById("about-modal-close").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    document.getElementById("about-check-update-btn").addEventListener("click", async function () {
        const { t: _t } = EFTForge.lang;
        const btn    = this;
        const status = document.getElementById("about-update-status");
        btn.disabled = true;
        btn.textContent = _t("about.checking");
        status.textContent = "";

        const serverDate = await _fetchRemoteBuildDate();

        btn.disabled = false;
        btn.textContent = _t("about.checkForUpdates");

        if (!serverDate) {
            status.style.color = "#f44336";
            status.textContent = _t("about.updateServerError");
            return;
        }

        const localDate = new Date(EFTForge.config.APP_BUILD_DATE);
        if (serverDate <= localDate) {
            status.style.color = "#4caf50";
            status.textContent = _t("about.upToDate");
            return;
        }

        status.style.color = "#f44336";
        status.textContent = _t("about.updateAvailable");
        btn.textContent = _t("about.updateNow");
        btn.addEventListener("click", () => window.location.reload(), { once: true });
    });
}

/* ===========================
   CUSTOM SELECT
=========================== */

function setupCustomSelect(selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return null;

    const wrapper = document.createElement("div");
    wrapper.className = "custom-select-wrapper";
    wrapper.id = selectId + "-custom";
    sel.parentNode.insertBefore(wrapper, sel.nextSibling);

    const trigger = document.createElement("div");
    trigger.className = "custom-select-trigger";
    wrapper.appendChild(trigger);

    const list = document.createElement("div");
    list.className = "custom-select-list";
    wrapper.appendChild(list);

    function syncTrigger() {
        const selected = sel.options[sel.selectedIndex];
        trigger.innerHTML = "";
        if (selected) {
            trigger.appendChild(document.createTextNode(selected.textContent));
        }
        list.querySelectorAll(".custom-select-option").forEach(item => {
            item.classList.toggle("selected", item.dataset.value === sel.value);
        });
    }

    function rebuild() {
        list.innerHTML = "";
        Array.from(sel.options).forEach((opt, i) => {
            const item = document.createElement("div");
            item.className = "custom-select-option" + (opt.selected ? " selected" : "");
            item.dataset.value = opt.value;
            item.style.setProperty("--i", i);
            item.appendChild(document.createTextNode(opt.textContent));
            item.addEventListener("click", () => {
                sel.value = opt.value;
                sel.dispatchEvent(new Event("change"));
                wrapper.classList.remove("open");
                syncTrigger();
            });
            list.appendChild(item);
        });
        syncTrigger();
    }

    trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        // close any other open custom selects
        document.querySelectorAll(".custom-select-wrapper.open").forEach(w => {
            if (w !== wrapper) w.classList.remove("open");
        });
        wrapper.classList.toggle("open");
    });

    document.addEventListener("click", () => wrapper.classList.remove("open"));

    // rebuild when options are added/removed
    const observer = new MutationObserver(rebuild);
    observer.observe(sel, { childList: true });

    // sync trigger when value is set programmatically via input event
    sel.addEventListener("input", syncTrigger);

    rebuild();
    return wrapper;
}

/* ===========================
   LANGUAGE
=========================== */

function applyStaticTranslations() {
    const { t } = EFTForge.lang;

    document.title = EFTForge.state.lang === "zh" ? "EFTForge - 配置实验室" : "EFTForge - Forge Your Meta";

    const beianFooter = document.querySelector(".beian-footer:not(.copyright-footer)");
    const copyrightFooter = document.querySelector(".copyright-footer");
    const isZh = EFTForge.state.lang === "zh";
    if (beianFooter) beianFooter.style.display = isZh ? "" : "none";
    if (copyrightFooter) copyrightFooter.style.display = isZh ? "none" : "";

    // Sync lang select value and update the custom trigger
    const langSelect = document.getElementById("lang-select");
    if (langSelect) {
        langSelect.value = EFTForge.state.lang;
        langSelect.dispatchEvent(new Event("input"));
    }

    // Header buttons
    const aboutBtn       = document.getElementById("about-btn");
    const newsBtn        = document.getElementById("news-btn");
    const buildsBtn      = document.getElementById("builds-btn");
    const leaderboardBtn = document.getElementById("leaderboard-btn");
    const trackerBtn     = document.getElementById("tracker-btn");
    if (aboutBtn)        aboutBtn.textContent       = t("btn.about");
    if (newsBtn)         newsBtn.textContent        = t("btn.news");
    if (buildsBtn)       buildsBtn.textContent      = t("btn.builds");
    if (leaderboardBtn)  leaderboardBtn.textContent = t("btn.leaderboard");
    if (trackerBtn)      trackerBtn.textContent     = t("btn.tracker");

    if (EFTForge.leaderboard) EFTForge.leaderboard.onLangChange();
    if (EFTForge.tracker)     EFTForge.tracker.onLangChange();

    const newsCloseBtn = document.getElementById("news-close-btn");
    if (newsCloseBtn) newsCloseBtn.textContent = "\u2715";

    // Weapon selector toggles
    const primaryBtn  = document.getElementById("primary-btn");
    const handgunBtn  = document.getElementById("handgun-btn");
    const caliberBtn  = document.getElementById("sort-caliber-btn");
    const classBtn    = document.getElementById("sort-class-btn");
    if (primaryBtn)  primaryBtn.textContent  = t("btn.primary");
    if (handgunBtn)  handgunBtn.textContent  = t("btn.pistol");
    if (caliberBtn)  caliberBtn.textContent  = t("btn.caliber");
    if (classBtn)    classBtn.textContent    = t("btn.class");

    // Gun search placeholder
    const gunSearch = document.getElementById("gun-search");
    if (gunSearch) gunSearch.placeholder = t("placeholder.gunSearch");

    // Left-build-area buttons
    const backBtn      = document.getElementById("back-btn");
    const resetBtn     = document.getElementById("reset-btn");
    const stripBtn     = document.getElementById("strip-btn");
    const saveShareBtn  = document.getElementById("save-share-btn");
    const gunBuildsBtn  = document.getElementById("gun-builds-btn");
    if (backBtn)      backBtn.textContent      = t("btn.back");
    if (resetBtn)     resetBtn.textContent     = t("btn.reset");
    if (stripBtn)     stripBtn.textContent     = t("btn.strip");
    if (saveShareBtn) saveShareBtn.textContent = t("btn.saveShare");
    if (gunBuildsBtn) gunBuildsBtn.innerHTML   = t("btn.gunBuilds");
    updateViewToggleLabels();

    // Right panel placeholder text
    const placeholderMain = document.getElementById("placeholder-main");
    const placeholderSub  = document.getElementById("placeholder-sub");
    if (placeholderMain) placeholderMain.textContent = t("placeholder.modding");
    const isTouch = navigator.maxTouchPoints > 0;
    if (placeholderSub) placeholderSub.textContent = isTouch ? t("placeholder.longPress") : t("placeholder.rightClick");

}

// Mark images as loaded to dismiss the placeholder shimmer.
// useCapture=true catches load events from all img elements, including those
// injected via innerHTML after this listener is registered.
document.addEventListener("load", e => {
    if (e.target.tagName === "IMG") e.target.classList.add("loaded");
}, true);

async function switchLang(lang) {
    if (EFTForge.state.lang === lang) return;
    if (_langSwitching) return;
    _langSwitching = true;

    // Snapshot build state before teardown - item names in cached objects are language-specific
    const previousGunId = EFTForge.state.currentGun?.id ?? null;
    let snapshotCode = null;
    let snapshotBuildName = null;
    if (EFTForge.state.currentGun) {
        const pairs = collectSlotPairs(EFTForge.state.buildTree);
        const isFactory = _pairsKey(pairs) === EFTForge.state.factoryPairsKey;
        if (!isFactory) {
            snapshotCode = encodeBuild();
            // gun-display-name shows the saved build name when one is matched, otherwise gun.name
            const nameEl = document.getElementById("gun-display-name");
            const displayedName = nameEl?.textContent ?? "";
            if (displayedName && displayedName !== EFTForge.state.currentGun.name) {
                snapshotBuildName = displayedName;
            }
        }
    }

    EFTForge.state.lang = lang;
    localStorage.setItem("eftforge_lang", lang);

    applyStaticTranslations();
    if (window.EFTForge && EFTForge.news)    EFTForge.news.onLangChange();
    if (window.EFTForge && EFTForge.tracker) EFTForge.tracker.onLangChange();

    // Clear caches - item names are baked into cached objects
    EFTForge.state.slotCache      = {};
    EFTForge.state.allowedCache   = {};
    EFTForge.state.processedCache = {};

    if (EFTForge.state.currentGun) returnToGunSelection();

    const loadingOverlay = startPanelLoading(document.querySelector(".left-panel"));
    try {
        EFTForge.state.allGuns = await fetchGuns();
        renderFilteredGunList();
    } catch (err) {
        console.error("Failed to reload guns after language switch:", err);
    } finally {
        stopPanelLoading(loadingOverlay);
    }

    // Restore previously open weapon with its build state in the new language
    try {
        if (previousGunId) {
            const gun = EFTForge.state.allGuns.find(g => g.id === previousGunId);
            if (gun) {
                if (snapshotCode) {
                    const payload = decodeBuildCode(snapshotCode);
                    if (payload) {
                        await loadBuildFromPayload(payload, snapshotBuildName, true);
                        const { t: _t } = EFTForge.lang;
                        showToast(_t("toast.stateRestored"), _t("toast.stateRestoredMsg"), 3000, "#4CAF50");
                    } else {
                        await selectGun(gun, { classList: { add() {}, remove() {} } });
                    }
                } else {
                    await selectGun(gun, { classList: { add() {}, remove() {} } });
                }
            }
        }
    } finally {
        _langSwitching = false;
    }
}

/* ===========================
   GLOBAL TOOLTIP
=========================== */

(function initTooltip() {
    const tip = document.getElementById("eft-tooltip");
    if (!tip) return;

    let activeTarget = null;
    let _tipW = 0;
    let _tipH = 0;

    const OFFSET_X = 14;
    const OFFSET_Y = 18;

    function position(cx, cy) {
        const margin = 8;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // Default: below-right of cursor; flip when near viewport edges
        let left = cx + OFFSET_X;
        if (left + _tipW > vw - margin) left = cx - _tipW - OFFSET_X;

        let top = cy + OFFSET_Y;
        if (top + _tipH > vh - margin) top = cy - _tipH - OFFSET_Y;

        tip.style.left = left + "px";
        tip.style.top  = top  + "px";
    }

    function show(target, cx, cy) {
        const text = target.dataset.tooltip;
        if (!text) return;
        tip.textContent = text;
        tip.classList.add("visible");
        activeTarget = target;
        // Read dimensions once after content is set; reused on every mousemove.
        _tipW = tip.offsetWidth;
        _tipH = tip.offsetHeight;
        position(cx, cy);
    }

    function hide() {
        tip.classList.remove("visible");
        activeTarget = null;
    }

    document.addEventListener("mousemove", (e) => {
        if (activeTarget) position(e.clientX, e.clientY);
    }, { passive: true });

    document.addEventListener("mouseover", (e) => {
        let target = e.target.closest("[data-tooltip]");

        // Convert native title attributes to data-tooltip on first hover so
        // the browser never shows its default tooltip (e.g. from markdown content)
        if (!target) {
            const titled = e.target.closest("[title]");
            if (titled) {
                const text = titled.getAttribute("title");
                if (text) {
                    titled.dataset.tooltip = text;
                    titled.removeAttribute("title");
                    target = titled;
                }
            }
        }

        if (!target) { hide(); return; }
        if (target === activeTarget) return;
        show(target, e.clientX, e.clientY);
    });

    // Hide when mouse leaves the document
    document.addEventListener("mouseleave", hide, true);
})();

/* ===========================
   DEV MODAL (localhost only)
=========================== */

(function () {
    if (location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;

    const DEV_SETTINGS_KEY = "eftforge_devtools";

    function _loadSettings() {
        try { return JSON.parse(localStorage.getItem(DEV_SETTINGS_KEY) || "{}"); } catch (_) { return {}; }
    }

    function _saveSetting(key, value) {
        const s = _loadSettings();
        s[key] = value;
        try { localStorage.setItem(DEV_SETTINGS_KEY, JSON.stringify(s)); } catch (_) {}
    }

    function _injectDevButton() {
        const btn = document.createElement("button");
        btn.id = "dev-modal-btn";
        btn.className = "dev-modal-trigger";
        btn.textContent = "DEV";
        btn.onclick = showDevModal;
        const header = document.querySelector("header");
        if (header) header.appendChild(btn);

        // Restore saved toolbar visibility
        const toolbar = document.getElementById("ag-dev-toolbar");
        if (toolbar && _loadSettings().gridToolbar === false) {
            toolbar.style.display = "none";
        }
    }

    // ── Debugger: Conflict ──────────────────────────────────────
    function _runConflictDebugger() {
        const items = EFTForge.state.lastProcessedItems;
        if (!items || items.length === 0)
            return '<span class="dev-out-warn">No processed items - open a slot selector first.</span>';

        const slot = EFTForge.state.lastSlot;
        const gun  = EFTForge.state.currentGun;
        let out = `<span class="dev-out-dim">Slot: ${slot?.slot_name ?? "?"} (${slot?.id ?? "?"})</span>\n`;
        out    += `<span class="dev-out-dim">Gun:  ${gun?.name ?? "?"} (${gun?.id ?? "?"})</span>\n`;
        out    += `<span class="dev-out-dim">Items checked: ${items.length}</span>\n\n`;

        const conflicts = items.filter(e => e.hasConflict);
        if (conflicts.length === 0) {
            out += '<span class="dev-out-ok">No conflicts detected in current slot.</span>';
            return out;
        }

        out += `<span class="dev-out-warn">${conflicts.length} conflict(s) found:</span>\n\n`;

        const byType = {};
        for (const e of conflicts) {
            const key = e.conflictName ?? "(not in allowed set)";
            (byType[key] = byType[key] || []).push(e);
        }

        for (const [type, entries] of Object.entries(byType)) {
            out += `<span class="dev-out-warn">[${escapeHtml(type)}]</span>\n`;
            for (const e of entries) {
                out += `  <span class="dev-out-error">✗</span> ${escapeHtml(e.item.name)}`;
                if (e.conflictingItemId)  out += `\n    <span class="dev-out-dim">conflictingItemId: ${escapeHtml(e.conflictingItemId)}</span>`;
                if (e.conflictingSlotId)  out += `\n    <span class="dev-out-dim">conflictingSlotId: ${escapeHtml(e.conflictingSlotId)}</span>`;
                out += "\n";
            }
            out += "\n";
        }

        return out;
    }

    // ── Debugger: Build State ───────────────────────────────────
    function _runBuildStateDebugger() {
        const tree = EFTForge.state.buildTree;
        if (!tree) return '<span class="dev-out-warn">No build tree - select a gun first.</span>';

        function _walk(node, depth) {
            const indent = "  ".repeat(depth);
            let s = `${indent}<span class="dev-out-ok">${escapeHtml(node.item.name)}</span>`;
            s    += ` <span class="dev-out-dim">(${escapeHtml(node.item.id)})</span>\n`;
            for (const [slotId, child] of Object.entries(node.children)) {
                s += `${indent}  <span class="dev-out-dim">slot: ${escapeHtml(slotId)}</span>\n`;
                s += _walk(child, depth + 2);
            }
            return s;
        }

        const slotCount  = (function count(n) { return Object.keys(n.children).reduce((a, k) => a + 1 + count(n.children[k]), 0); })(tree);
        let out = `<span class="dev-out-dim">Installed attachments: ${slotCount}</span>\n\n`;
        out += _walk(tree, 0);
        return out;
    }

    // ── Debugger: API Response ──────────────────────────────────
    function _runApiResponseDebugger() {
        const data = window._devLastBatchResult;
        if (!data) return '<span class="dev-out-warn">No API response cached - open a slot selector first.</span>';

        let out = `<span class="dev-out-dim">Slot: ${escapeHtml(data.slotName)} (${escapeHtml(data.slotId)})</span>\n`;
        out    += `<span class="dev-out-dim">Gun:  ${escapeHtml(data.gunId ?? "?")}</span>\n\n`;

        const { base, candidates } = data.result;
        out += `<span class="dev-out-ok">Base stats:</span>\n`;
        out += `  ergo=${base.total_ergo}  weight=${base.total_weight}  recoilV=${base.recoil_vertical}  recoilH=${base.recoil_horizontal}\n\n`;

        const invalid   = candidates.filter(c => !c.valid);
        const valid     = candidates.filter(c =>  c.valid);
        out += `<span class="dev-out-ok">Valid candidates: ${valid.length}</span>  `;
        out += `<span class="dev-out-error">Invalid: ${invalid.length}</span>\n\n`;

        if (invalid.length > 0) {
            out += `<span class="dev-out-warn">Invalid candidates (first 20):</span>\n`;
            for (const c of invalid.slice(0, 20)) {
                out += `  <span class="dev-out-error">✗</span> ${escapeHtml(c.item_id)}`;
                if (c.reason_key) out += `  <span class="dev-out-dim">${escapeHtml(c.reason_key)} - ${escapeHtml(c.reason_name ?? "")}</span>`;
                out += "\n";
            }
        }

        return out;
    }

    function _bindDebugger(btnId, outputId, runFn) {
        const btn = document.getElementById(btnId);
        const out = document.getElementById(outputId);
        if (!btn || !out) return;
        btn.addEventListener("click", () => {
            const wasVisible = out.classList.contains("visible");
            if (wasVisible) {
                out.classList.remove("visible");
                btn.textContent = "RUN";
                return;
            }
            out.innerHTML = runFn();
            out.classList.add("visible");
            btn.textContent = "HIDE";
        });
    }

    const _OVERLAP_STORAGE_KEY = "eftforge_overlap_scan_result";

    function _bindGridOverlapScanner(btnId, outputId) {
        const btn = document.getElementById(btnId);
        const out = document.getElementById(outputId);
        if (!btn || !out) return;

        // Restore last saved result so it survives the modal being closed and reopened
        const savedResult = localStorage.getItem(_OVERLAP_STORAGE_KEY);
        if (savedResult) {
            out.innerHTML = savedResult;
            out.classList.add("visible");
            btn.textContent = "HIDE";
        }

        let _running = false;
        let _stopped = false;

        btn.addEventListener("click", async () => {
            // STOP: abort a running scan
            if (_running) {
                _stopped = true;
                btn.textContent = "...";
                btn.disabled = true;
                return;
            }
            // HIDE: toggle off a finished result
            if (out.classList.contains("visible")) {
                out.classList.remove("visible");
                btn.textContent = "RUN";
                return;
            }

            _running = true;
            _stopped = false;
            btn.textContent = "STOP";
            btn.disabled = false;
            out.innerHTML = "Scanning...";
            out.classList.add("visible");

            const allGuns = (EFTForge.state && EFTForge.state.allGuns) || [];
            if (allGuns.length === 0) {
                out.innerHTML = "No guns loaded yet - open a gun first.";
                btn.textContent = "RUN";
                _running = false;
                return;
            }

            const issues    = [];
            const seenIssue = new Set(); // dedup: same overlap found via different install paths
            const savedSlotCache   = Object.assign({}, EFTForge.state.slotCache || {});
            const allowedItemCache = {}; // slotId -> items[] - separate from slotCache (slots vs allowed items)

            // Collect parentItemIds that appear in FIXED (non-flexible) overrides.
            // Only fixed overrides hard-place slots without collision checks, so only they
            // can produce genuine cell overlaps with other fixed overrides.
            const fixedOverrideParentIds = new Set();
            for (const [key, ov] of Object.entries(window._AG_OVERRIDES || {})) {
                if (ov.flexible) continue;
                const at = key.lastIndexOf("@");
                if (at !== -1) fixedOverrideParentIds.add(key.slice(at + 1));
            }

            // Timer
            const startTime = Date.now();
            function elapsed() {
                const s = Math.floor((Date.now() - startTime) / 1000);
                const m = Math.floor(s / 60);
                return `${m}:${String(s % 60).padStart(2, "0")}`;
            }
            const timerInterval = setInterval(() => {
                if (!_running) { clearInterval(timerInterval); return; }
                // Re-render status without resetting counters - just refresh the timer line
                const el = out.querySelector(".overlap-timer");
                if (el) el.textContent = `Elapsed: ${elapsed()}`;
            }, 1000);

            async function fetchAllowed(slotId) {
                if (allowedItemCache[slotId]) return allowedItemCache[slotId];
                try {
                    const items = await fetchSlotAllowedItems(slotId);
                    allowedItemCache[slotId] = items || [];
                } catch (_) {
                    allowedItemCache[slotId] = [];
                }
                return allowedItemCache[slotId];
            }

            // Run computeGridPositions on whatever is currently in tree and record any overlaps.
            // context is an array of installed item names for the report.
            async function checkTree(tree, gun, context) {
                let slotEntries;
                try { slotEntries = await collectAllVisibleSlots(tree); }
                catch (_) { return; }

                const { positions } = computeGridPositions(slotEntries);
                const seen = new Map();
                for (let i = 0; i < slotEntries.length; i++) {
                    const pos = positions.get(i);
                    if (!pos || pos.extras || pos.col == null) continue;
                    const cell       = `${pos.col},${pos.row}`;
                    const slotName   = slotEntries[i].slot.slot_name;
                    const parentName = slotEntries[i].parentNode.item.name || slotEntries[i].parentNode.item.id;
                    if (seen.has(cell)) {
                        const pair = [seen.get(cell), `${slotName} (parent: ${parentName})`].sort().join("|");
                        const key  = `${gun.id}|${cell}|${pair}`;
                        if (!seenIssue.has(key)) {
                            seenIssue.add(key);
                            const via = context.length ? `  [via: ${context.join(" + ")}]` : "";
                            issues.push(
                                `${gun.name}${via}  -  col ${pos.col} row ${pos.row}: ` +
                                `"${seen.get(cell)}" overlaps with "${slotName}" (parent: ${parentName})`
                            );
                        }
                    } else {
                        seen.set(cell, `${slotName} (parent: ${parentName})`);
                    }
                }
            }

            // DFS: for every visible empty slot in the current tree, try installing each
            // candidate item (fixed-override parents first, then a small sample of others).
            // Keeps installed items in place while recursing so sibling-slot combinations
            // are tested simultaneously - e.g. front attachment + rear attachment together.
            // installedIds guards against re-installing the same item in the same DFS path.
            let yieldTick     = 0;
            let combosChecked = 0;
            let currentGunName  = "";
            let currentSlotName = "";
            let currentItemName = "";

            function updateStatus(gi) {
                const issueStr = issues.length ? `  <span style="color:#ef9a9a;">(${issues.length} found)</span>` : "";
                out.innerHTML =
                    `[${gi + 1}/${allGuns.length}] ${currentGunName}${issueStr}\n` +
                    `<span class="overlap-timer">Elapsed: ${elapsed()}</span>\n` +
                    `Combos checked: ${combosChecked}\n` +
                    `Slot: ${currentSlotName || "-"}\n` +
                    `Item: ${currentItemName || "-"}`;
            }

            async function dfs(tree, gun, depth, installedIds, context, gi) {
                if (_stopped || depth > 3) return;

                let slotEntries;
                try { slotEntries = await collectAllVisibleSlots(tree); }
                catch (_) { return; }

                for (const { slot, parentNode } of slotEntries) {
                    if (_stopped) return;
                    if (parentNode.children[slot.id]) continue; // slot already filled

                    const allowed = await fetchAllowed(slot.id);
                    // Prioritize fixed-override parents; include a small sample of others
                    // so flexible-override collisions and plain auto-placement edge cases
                    // are also exercised.
                    const priority = allowed.filter(i => fixedOverrideParentIds.has(i.id));
                    const rest     = allowed.filter(i => !fixedOverrideParentIds.has(i.id)).slice(0, 2);
                    const toTry    = [...priority, ...rest];

                    for (const item of toTry) {
                        if (_stopped) return;
                        if (installedIds.has(item.id)) continue; // cycle guard

                        currentSlotName = slot.slot_name;
                        currentItemName = (depth === 0 ? "" : "  ".repeat(depth) + "↳ ") + (item.name || item.id);

                        parentNode.children[slot.id] = { item, children: {} };
                        installedIds.add(item.id);

                        combosChecked++;
                        await checkTree(tree, gun, [...context, item.name || item.id]);
                        await dfs(tree, gun, depth + 1, installedIds, [...context, item.name || item.id], gi);

                        delete parentNode.children[slot.id];
                        installedIds.delete(item.id);

                        if (++yieldTick % 10 === 0) {
                            updateStatus(gi);
                            await new Promise(r => setTimeout(r, 0));
                        }
                    }
                }
            }

            // Step 1: check the user's current build as-is - catches deliberate test cases
            const buildTree = EFTForge.state && EFTForge.state.buildTree;
            if (buildTree && buildTree.item) {
                out.innerHTML = `Scanning current build...\n<span class="overlap-timer">Elapsed: ${elapsed()}</span>`;
                await checkTree(buildTree, buildTree.item, ["current build"]);
            }

            // Step 2: per-gun DFS across all attachment combinations
            for (let gi = 0; gi < allGuns.length; gi++) {
                if (_stopped) break;
                const gun = allGuns[gi];
                currentGunName  = gun.name;
                currentSlotName = "";
                currentItemName = "";
                updateStatus(gi);

                const stubTree = { item: gun, children: {} };

                await checkTree(stubTree, gun, []);
                await dfs(stubTree, gun, 0, new Set(), [], gi);

                await new Promise(r => setTimeout(r, 0));
            }

            clearInterval(timerInterval);
            EFTForge.state.slotCache = Object.assign(savedSlotCache, EFTForge.state.slotCache);

            const stoppedNote = _stopped ? `<span style="color:#ffcc80;">[stopped early]  </span>` : "";
            const timeNote    = `<span style="color:#888;">  (${elapsed()})</span>`;
            let finalHtml;
            if (issues.length === 0) {
                finalHtml = `${stoppedNote}<span style="color:#81c784;">No overlaps found across ${allGuns.length} guns.</span>${timeNote}`;
            } else {
                finalHtml =
                    `${stoppedNote}<span style="color:#ef9a9a;">${issues.length} overlap(s) found:</span>${timeNote}\n\n` +
                    issues.join("\n");
            }

            out.innerHTML = finalHtml;
            localStorage.setItem(_OVERLAP_STORAGE_KEY, finalHtml);

            // Print full report to the browser console
            console.group(`[EFTForge] Grid Overlap Scan - ${issues.length} issue(s) found (${elapsed()})`);
            if (issues.length === 0) {
                console.log("No overlaps found.");
            } else {
                issues.forEach(line => console.warn(line));
            }
            console.groupEnd();

            btn.textContent = "HIDE";
            btn.disabled = false;
            _running = false;
            _stopped = false;
        });
    }

    function showDevModal() {
        if (document.getElementById("dev-modal-overlay")) return;

        const overlay = document.createElement("div");
        overlay.id = "dev-modal-overlay";
        overlay.className = "modal-overlay";

        const toolbar = document.getElementById("ag-dev-toolbar");
        const toolbarVisible = toolbar ? toolbar.style.display !== "none" : false;

        overlay.innerHTML = `
            <div class="modal-window" style="max-width:480px; max-height:85vh; display:flex; flex-direction:column;">
                <div class="modal-header">
                    <span class="modal-title">DEVELOPER TOOLS</span>
                    <button class="modal-close-btn" id="dev-modal-close">&#x2715;</button>
                </div>
                <div style="overflow-y:auto; flex:1;">
                    <div class="modal-body" style="gap:0; padding:0;">

                        <div class="dev-modal-section-label">Grid</div>
                        <div class="dev-modal-row">
                            <span class="dev-modal-row-label">Grid position editor</span>
                            <button id="dev-grid-tool-toggle" class="dev-modal-toggle${toolbarVisible ? " active" : ""}">
                                ${toolbarVisible ? "ON" : "OFF"}
                            </button>
                        </div>

                        <div class="dev-modal-section-label" style="padding-top:18px;">Debuggers</div>

                        <div class="dev-debugger-row">
                            <span class="dev-debugger-row-label">Conflict detection</span>
                            <button id="dev-dbg-conflict-btn" class="dev-debugger-run-btn">RUN</button>
                        </div>
                        <div id="dev-dbg-conflict-out" class="dev-debugger-output"></div>

                        <div class="dev-debugger-row">
                            <span class="dev-debugger-row-label">Build state inspector</span>
                            <button id="dev-dbg-build-btn" class="dev-debugger-run-btn">RUN</button>
                        </div>
                        <div id="dev-dbg-build-out" class="dev-debugger-output"></div>

                        <div class="dev-debugger-row">
                            <span class="dev-debugger-row-label">API response inspector</span>
                            <button id="dev-dbg-api-btn" class="dev-debugger-run-btn">RUN</button>
                        </div>
                        <div id="dev-dbg-api-out" class="dev-debugger-output"></div>

                        <div class="dev-debugger-row">
                            <span class="dev-debugger-row-label">Grid overlap scan all guns (~1 hour)</span>
                            <button id="dev-dbg-grid-overlap-btn" class="dev-debugger-run-btn">RUN</button>
                        </div>
                        <div id="dev-dbg-grid-overlap-out" class="dev-debugger-output"></div>

                        <div class="dev-modal-section-label" style="padding-top:18px;">Stat Tracker</div>
                        <div class="dev-debugger-row">
                            <span class="dev-debugger-row-label">Inject fake stat changes</span>
                            <button id="dev-tracker-inject-btn" class="dev-debugger-run-btn">RUN</button>
                        </div>
                        <div id="dev-tracker-inject-out" class="dev-debugger-output"></div>

                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        document.getElementById("dev-modal-close").addEventListener("click", () => overlay.remove());
        overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

        document.getElementById("dev-grid-tool-toggle").addEventListener("click", function () {
            const tb = document.getElementById("ag-dev-toolbar");
            if (!tb) return;
            const nowVisible = tb.style.display !== "none";
            tb.style.display = nowVisible ? "none" : "";
            this.textContent = nowVisible ? "OFF" : "ON";
            this.classList.toggle("active", !nowVisible);
            _saveSetting("gridToolbar", !nowVisible);
        });

        _bindDebugger("dev-dbg-conflict-btn", "dev-dbg-conflict-out", _runConflictDebugger);
        _bindDebugger("dev-dbg-build-btn",    "dev-dbg-build-out",    _runBuildStateDebugger);
        _bindDebugger("dev-dbg-api-btn",      "dev-dbg-api-out",      _runApiResponseDebugger);
        _bindGridOverlapScanner("dev-dbg-grid-overlap-btn", "dev-dbg-grid-overlap-out");

        document.getElementById("dev-tracker-inject-btn").addEventListener("click", function () {
            const out = document.getElementById("dev-tracker-inject-out");
            if (!window.EFTForge?._dev?.trackerInject) {
                out.textContent = "tracker-devtool.js not loaded.";
                out.style.display = "block";
                return;
            }
            const count = EFTForge._dev.trackerInject();
            out.textContent = `Injected ${count} fake entries. Open the Tracker panel to see them.`;
            out.style.display = "block";
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _injectDevButton);
    } else {
        _injectDevButton();
    }
}());

/* ===========================
   URL BUILD PARAM AUTO-LOAD
=========================== */

function _checkUrlBuildParam() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("build");
    if (!code) return;
    // Remove the param from the URL so a refresh doesn't re-trigger the import
    const cleanUrl = window.location.pathname + window.location.hash;
    history.replaceState(null, "", cleanUrl);
    // Small delay to let the gun list UI finish rendering before we auto-load
    setTimeout(() => importBuildFromCode(code), 150);
}