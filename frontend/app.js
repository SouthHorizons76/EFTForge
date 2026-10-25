/* exported _syncHeaderScrollOnly, showAboutDialog, switchLang -- called from other modules or index.html attributes */

// Guard variables - declared at top to avoid TDZ errors from hoisted function calls below.
let _syncNoticeInterval     = null;
let _syncStatusInterval     = null;
let _syncStatusToast        = null;
let _devSyncNoticeInterval  = null;
let _clockInterval      = null;
let _langSwitching      = false;
let _headerLastScroll   = 0;
let _headerAnimating    = false;
// Fade opacity ramps smoothly over this many px of scroll near each edge,
// instead of snapping straight to fully visible.
const HEADER_FADE_DISTANCE = 40;
let _headerMaxScroll = 0;

// Strip the cache-busting _v param added by the update checker so it doesn't
// linger in the address bar after a forced reload.
(function () {
    const u = new URL(window.location.href);
    if (u.searchParams.has("_v")) {
        u.searchParams.delete("_v");
        history.replaceState(null, "", u.toString());
    }
})();


/* ===========================
   GUN LIST FILTER
=========================== */

function renderFilteredGunList(forceReset = false) {
    const query = /** @type {HTMLInputElement | null} */ (document.getElementById("gun-search"))?.value.toLowerCase() ?? "";
    const filtered = query
        ? EFTForge.state.allGuns.filter(g => g.name.toLowerCase().includes(query))
        : EFTForge.state.allGuns;
    renderGunList(filtered, forceReset);
}

/* ===========================
   INITIAL LOAD
=========================== */

init();
mobileWarning();
largeScreenHint();
initTarkovClock();
initHeaderExpand();
initHeaderFades();
initBpGlobalStatus();

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
      // Highlight any gun with an unfinished mid-build from before the page was refreshed (mobile only)
      _applyMidBuildIndicator();
      // Desktop: silently restore whatever tabs were open before the page was refreshed
      await EFTForge.tabs.restoreTabsFromStorage();
      // Auto-load a build from the ?build= URL parameter (for external site integrations)
      _checkUrlBuildParam();
      // Restore flea cache from localStorage before prefetching so new tabs/reloads reuse it instead of refetching.
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
          EFTForge.api.catalogFetch("/items/ids", { signal: _idsCtrl.signal })
            .then(r => r.json())
            .then(async ids => {
              const fleaCache = fleaCacheFor(EFTForge.state.priceMode);
              const missing = ids.filter(id => !(id in fleaCache));
              if (missing.length === 0) {
                  // Prices are all cached, but a pre-upgrade cache may still lack the
                  // account level map: fill it quietly now instead of on first render.
                  ensureFleaPrices([]);
                  return;
              }
              const { t: _t } = EFTForge.lang;
              replaceToast("flea-fetch", _t("stats.fleaMarket"), `${_t("stats.fleaFetching")} ${missing.length} ${_t("stats.fleaFetchingItems")}`, 4000, "#f5a623");
              if (await ensureFleaPrices(missing)) {
                replaceToast("flea-fetch", _t("stats.fleaMarket"), _t("stats.fleaCached"), 3000, "#4caf50");
              }
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
        /** @type {HTMLElement} */ (document.activeElement).blur();
        return;
    }

    // Undo / Redo (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z)
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const tag2 = document.activeElement.tagName;
        if (tag2 !== "INPUT" && tag2 !== "TEXTAREA") {
            if (e.key === "z" && !e.shiftKey) {
                e.preventDefault();
                undoBuildAction();
                return;
            }
            if ((e.key === "y") || (e.key === "z" && e.shiftKey)) {
                e.preventDefault();
                redoBuildAction();
                return;
            }
        }
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

    const langCustom = setupCustomSelect("lang-select");
    if (langCustom) {
        const langTrigger = langCustom.querySelector(".custom-select-trigger");
        const langList    = /** @type {HTMLElement | null} */ (langCustom.querySelector(".custom-select-list"));
        langTrigger.addEventListener("click", () => {
            requestAnimationFrame(() => {
                if (!langCustom.classList.contains("open")) return;
                if (window.innerWidth <= 767) {
                    const rect = langTrigger.getBoundingClientRect();
                    langList.style.position = "fixed";
                    langList.style.top      = (rect.bottom + 4) + "px";
                    langList.style.left     = rect.left + "px";
                    langList.style.right    = "auto";
                    langList.style.minWidth = rect.width + "px";
                }
            });
        });
    }

    renderSavedBuildsList();

    scheduleSyncNotice();
    startSyncStatusPolling();
    initAtlasEntry();
    startDevSyncNoticePolling();

    initPanelResizer();
}

/* ===========================
   HEADER EXPAND
=========================== */

function _setHeaderExpanded(expanded) {
    if (isMobileLayout() && expanded) return;
    // Skip if already animating or already in the target state
    const header = document.querySelector("header");
    const alreadyExpanded = header.classList.contains("header-expanded");
    if (_headerAnimating || alreadyExpanded === expanded) return;

    _headerAnimating = true;
    const nav = /** @type {HTMLElement | null} */ (document.querySelector(".header-nav"));
    const lang = document.getElementById("lang-switcher");

    // Step 1: fade out
    if (nav)  nav.style.opacity  = "0";
    if (lang) lang.style.opacity = "0";

    // Step 2: after fade completes, snap state, then fade back in
    setTimeout(() => {
        header.classList.toggle("header-expanded", expanded);
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (nav)  nav.style.opacity  = "";
            if (lang) lang.style.opacity = "";
            setTimeout(() => { _headerAnimating = false; }, 150);
        }));
    }, 150);
}

function _syncHeaderExpand() {
    // Called on navigation changes - immediate state change, no animation
    _headerAnimating = false;
    const nav = /** @type {HTMLElement | null} */ (document.querySelector(".header-nav"));
    const lang = document.getElementById("lang-switcher");
    if (nav)  nav.style.opacity  = "";
    if (lang) lang.style.opacity = "";

    const container = document.getElementById("main-container");
    const isGunSelect = container.classList.contains("no-gun");
    // Mobile always stays collapsed
    document.querySelector("header").classList.toggle("header-expanded", isGunSelect && !isMobileLayout());
    const ws = document.getElementById("weapon-selector");
    _headerLastScroll = ws ? ws.scrollTop : 0;
}

function _syncHeaderScrollOnly() {
    // Re-sync scroll tracking without changing the expanded/collapsed state.
    // Used when returning to gun select so the header stays in whatever state it was.
    _headerAnimating = false;
    const nav = /** @type {HTMLElement | null} */ (document.querySelector(".header-nav"));
    const lang = document.getElementById("lang-switcher");
    if (nav)  nav.style.opacity  = "";
    if (lang) lang.style.opacity = "";
    const ws = document.getElementById("weapon-selector");
    _headerLastScroll = ws ? ws.scrollTop : 0;
}

function _onWeaponSelectorScroll() {
    const ws = document.getElementById("weapon-selector");
    if (!ws) return;
    // Clamp to valid range to ignore rubber-band overscroll (iOS/mobile bounce)
    const currentScroll = Math.max(0, Math.min(ws.scrollTop, ws.scrollHeight - ws.clientHeight));
    const delta = currentScroll - _headerLastScroll;
    // Ignore micro-bounces (e.g. rubber-band at scroll boundaries)
    if (Math.abs(delta) < 6) return;
    // At the bottom, content reflows from filter changes can trigger false collapses
    const atBottom = currentScroll + ws.clientHeight >= ws.scrollHeight - 10;
    if (_headerAnimating) return;
    if (delta < 0) {
        _setHeaderExpanded(true);
    } else if (!atBottom) {
        _setHeaderExpanded(false);
    }
    _headerLastScroll = currentScroll;
}

function initHeaderExpand() {
    const ws = document.getElementById("weapon-selector");
    if (ws) ws.addEventListener("scroll", _onWeaponSelectorScroll, { passive: true });
    _syncHeaderExpand();
}

/* ===========================
   HEADER OVERFLOW FADES
   Portrait phones can be too narrow for the header content, which becomes
   horizontally swipeable. These edge gradients mirror the tab bar's fades
   to hint that there's more to scroll to.
=========================== */

// scrollWidth/clientWidth are layout reads and the scroll handler below fires
// continuously during a swipe, so the extent is measured only when it can
// actually change (resize) and the per-event path reads only scrollLeft.
// _headerMaxScroll itself lives with the other guard variables at the top of
// this file - initHeaderFades() is called from the hoisted init block above
// this section, so a `let` declared here would still be in its TDZ by then.
function _measureHeaderScroll() {
    const scroll = document.querySelector(".header-scroll");
    _headerMaxScroll = scroll ? Math.max(0, scroll.scrollWidth - scroll.clientWidth) : 0;
}

function _updateHeaderFades() {
    const scroll = document.querySelector(".header-scroll");
    const fadeLeft = /** @type {HTMLElement | null} */ (document.querySelector(".header-fade-left"));
    const fadeRight = /** @type {HTMLElement | null} */ (document.querySelector(".header-fade-right"));
    if (!scroll || !fadeLeft || !fadeRight) return;

    const maxScroll = _headerMaxScroll;
    if (maxScroll <= 1) {
        fadeLeft.style.opacity = "0";
        fadeRight.style.opacity = "0";
        return;
    }

    const left = scroll.scrollLeft;
    const right = maxScroll - scroll.scrollLeft;
    fadeLeft.style.opacity = String(Math.max(0, Math.min(1, left / HEADER_FADE_DISTANCE)));
    fadeRight.style.opacity = String(Math.max(0, Math.min(1, right / HEADER_FADE_DISTANCE)));
}

function initHeaderFades() {
    const scroll = document.querySelector(".header-scroll");
    if (!scroll) return;
    scroll.addEventListener("scroll", () => {
        // A scroll event at all proves there's overflow, so a cached extent of 0
        // means header content grew since the last measure (badges, a longer
        // nav label) - re-measure rather than leave the fades stuck hidden.
        if (_headerMaxScroll <= 1) _measureHeaderScroll();
        _updateHeaderFades();
    }, { passive: true });

    // Coalesce resize bursts into one measure+paint per frame.
    let resizeRAF = null;
    window.addEventListener("resize", () => {
        if (resizeRAF) return;
        resizeRAF = requestAnimationFrame(() => {
            resizeRAF = null;
            _measureHeaderScroll();
            _updateHeaderFades();
        });
    });

    _measureHeaderScroll();
    _updateHeaderFades();
}

/* ===========================
   PANEL RESIZER
=========================== */

function initPanelResizer() {

    if (isMobileLayout()) return;

    const resizer   = document.getElementById("panel-resizer");
    const leftPanel = /** @type {HTMLElement | null} */ (document.querySelector(".left-panel"));
    const container = document.getElementById("main-container");

    const DEFAULT_WIDTH = 660;
    const MIN_LEFT      = 660;
    const MIN_RIGHT     = 720;

    const savedRaw = parseInt(localStorage.getItem("eftforge_panel_width"));
    const maxInit  = container.offsetWidth - MIN_RIGHT - resizer.offsetWidth;
    const initWidth = (savedRaw >= MIN_LEFT && savedRaw <= maxInit) ? savedRaw : DEFAULT_WIDTH;
    leftPanel.style.width = initWidth + "px";
    // Auto-correct legacy users whose saved width is below the new minimum
    if (!savedRaw || savedRaw < MIN_LEFT) {
        localStorage.setItem("eftforge_panel_width", String(initWidth));
    }

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
        localStorage.setItem("eftforge_panel_width", String(leftPanel.offsetWidth));
    });

    let resizeAnimFrame = null;
    window.addEventListener("resize", () => {
        if (isMobileLayout()) return;
        if (dragging) return;
        cancelAnimationFrame(resizeAnimFrame);
        resizeAnimFrame = requestAnimationFrame(() => {
            if (container.classList.contains("no-gun")) return;
            // The 3D view stretches the left panel over the whole build area, which would read
            // as far too wide here and overwrite the saved 2D width.
            if (EFTForge.builder3d?.isActive()) return;
            const maxWidth = container.offsetWidth - MIN_RIGHT - resizer.offsetWidth;
            const current  = leftPanel.offsetWidth;
            if (current <= maxWidth) return;
            const clamped = Math.max(MIN_LEFT, maxWidth);
            leftPanel.style.transition = "width 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94)";
            leftPanel.style.width = clamped + "px";
            leftPanel.addEventListener("transitionend", () => {
                leftPanel.style.transition = "";
                localStorage.setItem("eftforge_panel_width", String(clamped));
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
   LIVE SYNC STATUS POLLING
=========================== */

async function _checkSyncStatus() {
    try {
        const res = await fetch(`${EFTForge.config.API_BASE}/sync-status`, { cache: "no-store" });
        if (!res.ok) return;
        const { sync_running } = await res.json();
        if (sync_running) {
            if (!_syncStatusToast || !_syncStatusToast.isConnected) {
                const { t } = EFTForge.lang;
                _syncStatusToast = showToast(t("toast.syncRunningTitle"), t("toast.syncRunningMsg"), 0, "#f5a623");
            }
        } else if (_syncStatusToast && _syncStatusToast.isConnected) {
            _syncStatusToast.remove();
            _syncStatusToast = null;
        }
    } catch {
        // ignore - backend temporarily unreachable
    }
}

function startSyncStatusPolling() {
    if (_syncStatusInterval !== null) return;
    _checkSyncStatus();
    // Skip hidden tabs: people leave us open in the background while they play, and
    // every one of those polls would hit the server for a toast nobody can see.
    _syncStatusInterval = setInterval(() => {
        if (!document.hidden) _checkSyncStatus();
    }, 15000);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) _checkSyncStatus();
    });
}

/* ===========================
   DEV-ONLY BACKGROUND SYNC NOTICE
   reset.py starts the dev server instantly against the existing local DB and
   resyncs in the background; this polls for its "data actually changed" flag.
   Never runs outside localhost, so production is unaffected.
=========================== */

async function _checkDevSyncNotice() {
    if (!EFTForge.config.IS_LOCAL_DEV) return;
    try {
        const res = await fetch(`${EFTForge.config.API_BASE}/dev/sync-notice`, { cache: "no-store" });
        if (!res.ok) return;
        const { changed } = await res.json();
        if (!changed) return;

        const { t } = EFTForge.lang;
        showToast(
            t("toast.devDataUpdatedTitle"),
            t("toast.devDataUpdatedMsg"),
            0,
            "#4caf50",
            [{ label: t("toast.updateNow"), onClick: () => window.location.reload() }],
            false
        );
    } catch {
        // ignore - dev-only convenience check
    }
}

function startDevSyncNoticePolling() {
    if (!EFTForge.config.IS_LOCAL_DEV) return;
    if (_devSyncNoticeInterval !== null) return;
    _checkDevSyncNotice();
    _devSyncNoticeInterval = setInterval(_checkDevSyncNotice, 10000);
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
    // Skip on localhost - update checks are for deployed environments only.
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
        [{ label: _t("toast.updateNow"), onClick: () => {
            const u = new URL(window.location.href);
            u.searchParams.set("_v", String(Date.now()));
            window.location.replace(u);
        }}]
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

function largeScreenHint() {
    if (screen.width <= 1920) return;
    try { if (localStorage.getItem("eftforge_zoom_hint")) return; } catch {}
    const { t } = EFTForge.lang;
    showToast(t("toast.largeScreenTitle"), t("toast.largeScreenMsg"), 0, "#4a90d9", [
        { label: t("tab.manyTabsDismiss"), onClick: () => {
            try { localStorage.setItem("eftforge_zoom_hint", "1"); } catch {}
        }},
    ]);
}

function mobileWarning() {
    if (!isMobileLayout()) return;
    document.body.dataset.mobile = "true";

    const { t } = EFTForge.lang;
    showToast(t("toast.mobileWarningTitle"), t("toast.mobileWarningMsg"), 6000, "#f5a623");

    const _sb = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
    _sb("back-btn",      "btn.backShort");
    _sb("reset-btn",     "btn.resetShort");
    _sb("strip-btn",     "btn.stripShort");
    _sb("save-share-btn","btn.saveShareShort");
    _sb("gun-builds-btn","btn.gunBuildsShort");

    const rp = /** @type {HTMLElement | null} */ (document.querySelector(".right-panel"));
    if (rp) {
        let _swipeStartY = 0, _swipeTracking = false;
        rp.addEventListener("touchstart", (e) => {
            _swipeStartY = e.touches[0].clientY;
            _swipeTracking = rp.scrollTop === 0;
        }, { passive: true });
        rp.addEventListener("touchmove", (e) => {
            if (!_swipeTracking) return;
            if (rp.scrollTop > 0) { _swipeTracking = false; return; }
            const dy = e.touches[0].clientY - _swipeStartY;
            if (dy > 0) rp.style.transform = `translateY(${dy}px)`;
        }, { passive: true });
        rp.addEventListener("touchend", (e) => {
            if (!_swipeTracking) return;
            _swipeTracking = false;
            const dy = e.changedTouches[0].clientY - _swipeStartY;
            rp.style.transform = "";
            if (dy > 72) closeMobileRightPanel();
        }, { passive: true });
    }

    const publishTray = document.getElementById("mobile-publish-tray");
    if (publishTray) publishTray.addEventListener("click", openMobileRightPanel);

    const backdrop = document.getElementById("mobile-panel-backdrop");
    if (backdrop) backdrop.addEventListener("click", closeMobileRightPanel);

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
    const rp = /** @type {HTMLElement | null} */ (document.querySelector(".right-panel"));
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

// Fill in the Kitbash! row with the commit (and codename) the server's Kitbash!
// checkout is on and the game version its newest sprites were baked from. The row stays hidden
// when the server has no Kitbash!, knows neither, or the request fails. Desktop in
// connected mode gets the live server's Kitbash! through the community proxy. The status is shared with page load, so we only
// show the loading line while that first request is still out.
async function _loadAboutKitbashVersion() {
    // Desktop local mode never asks the server, same as the Image Generation toggle,
    // since its backend has no Kitbash! and blocks /build-image outright.
    if (EFTForge.config?.COMMUNITY_DISABLED) return;
    const cached = EFTForge.api.peekBuildImageStatus();
    if (cached) {
        _renderAboutKitbash(cached.kitbash);
        return;
    }
    const loading = document.getElementById("about-kitbash-loading");
    if (loading) loading.style.display = "flex";
    const label = EFTForge.lang.t("about.kitbashLoading");
    let dots = 1;
    const dotsInterval = setInterval(() => {
        dots = dots >= 3 ? 1 : dots + 1;
        const el = document.getElementById("about-kitbash-loading-text");
        if (el) el.textContent = label + ".".repeat(dots);
    }, 500);
    let kb = null;
    try {
        kb = (await EFTForge.api.fetchBuildImageStatus()).kitbash;
    } catch (_) {}
    clearInterval(dotsInterval);
    // The dialog may have been closed and reopened while we waited, so look it up again.
    const loadingNow = document.getElementById("about-kitbash-loading");
    if (loadingNow) loadingNow.style.display = "none";
    _renderAboutKitbash(kb);
}

function _renderAboutKitbash(kb) {
    const section = document.getElementById("about-kitbash");
    if (!section || !kb) return;
    let shown = false;
    if (typeof kb.commit === "string" && typeof kb.date === "string") {
        const ver = document.getElementById("about-kitbash-version");
        const codename = typeof kb.codename === "string" ? ` (${kb.codename})` : "";
        ver.textContent = `${kb.commit.slice(0, 7)}${codename} - ${kb.date.slice(0, 10)}`;
        // The release's own wordmark (assets/images/kitbash-wordmark-<codename>.png), else
        // the plain one.
        const mark = /** @type {HTMLImageElement | null} */ (document.getElementById("about-kitbash-wordmark"));
        if (mark && typeof kb.codename === "string" && /^[a-z0-9-]+$/i.test(kb.codename)) {
            mark.onerror = () => { mark.onerror = null; mark.src = "./assets/images/kitbash-for-eftforge-wordmark.png"; };
            mark.src = `./assets/images/kitbash-wordmark-${kb.codename.toLowerCase()}.png`;
            mark.alt = `Kitbash! ${kb.codename}`;
        }
        ver.style.display = "";
        shown = true;
    }
    if (typeof kb.gameVersion === "string") {
        const game = document.getElementById("about-kitbash-game");
        game.textContent = `${EFTForge.lang.t("about.kitbashGameVersion")}${kb.gameVersion}`;
        game.style.display = "";
        shown = true;
    }
    if (!shown) return;
    section.style.display = "flex";
    // Name Kitbash! in the affiliation disclaimer only once its row is actually on screen.
    const disclaimer = document.getElementById("about-disclaimer2");
    if (disclaimer) disclaimer.innerHTML = EFTForge.lang.t("about.disclaimer2Kitbash");
}

function showAboutDialog() {
    if (document.getElementById("about-dialog")) return;

    // Desktop already has its own Performance section in the desktop
    // settings modal (desktop-settings.js) - only show it here on the
    // website, which has no separate settings modal of its own anymore.
    const _showPerf = !(EFTForge.config && EFTForge.config.IS_DESKTOP);
    // Show the installer download links only on the website, since the
    // desktop app is already installed and updates itself.
    const _showDesktopDl = _showPerf;

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

                ${_showDesktopDl ? `
                <div class="about-desktop-dl">
                    <span class="about-desktop-dl-label">${t("about.desktopDownload")}</span>
                    <a href="https://github.com/SouthHorizons76/EFTForge/releases" target="_blank" rel="noopener noreferrer"
                       class="about-desktop-dl-link" title="${t("about.desktopGithub")}" aria-label="${t("about.desktopGithub")}">
                        <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
                    </a>
                    <a href="https://gitee.com/morph1ne/eftforge-gitee-mirror/releases" target="_blank" rel="noopener noreferrer"
                       class="about-desktop-dl-link" title="${t("about.desktopGitee")}" aria-label="${t("about.desktopGitee")}">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M11.984 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.016 0zm6.09 5.333c.328 0 .593.266.592.593v1.482a.594.594 0 0 1-.593.592H9.777c-.982 0-1.778.796-1.778 1.778v5.63c0 .327.266.592.593.592h5.63c.982 0 1.778-.796 1.778-1.778v-.296a.593.593 0 0 0-.592-.593h-4.15a.592.592 0 0 1-.592-.592v-1.482a.593.593 0 0 1 .593-.592h6.815c.327 0 .593.265.593.592v3.408a4 4 0 0 1-4 4H5.926a.593.593 0 0 1-.593-.593V9.778a4.444 4.444 0 0 1 4.445-4.444h8.296z"/></svg>
                    </a>
                </div>
                ` : ""}

                <div id="about-kitbash-loading" style="display:none; flex-direction:column; gap:16px;">
                    <hr class="modal-divider" style="margin:0;" />
                    <span id="about-kitbash-loading-text" style="font-size:13px; color:#555; letter-spacing:1px;">${t("about.kitbashLoading")}.</span>
                </div>

                <div id="about-kitbash" style="display:none; flex-direction:column; gap:16px;">
                    <hr class="modal-divider" style="margin:0;" />
                    <div style="display:flex; align-items:center; justify-content:space-between; user-select:none;">
                        <img id="about-kitbash-wordmark" src="./assets/images/kitbash-for-eftforge-wordmark.png" alt="Kitbash! for EFTForge" draggable="false" style="height:46px; width:auto; object-fit:contain; flex-shrink:0; -webkit-user-drag:none;" />
                        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:5px; font-size:13px; color:#555; letter-spacing:1px;">
                            <span id="about-kitbash-version" style="display:none;"></span>
                            <span id="about-kitbash-game" style="display:none;"></span>
                        </div>
                    </div>
                </div>

                <hr class="modal-divider" style="margin:0;" />

                <div style="font-size:13px; color:#888; line-height:1.75;">
                    <p style="margin:0 0 10px 0;">${t("about.disclaimer1")}</p>
                    <p id="about-disclaimer2" style="margin:0 0 10px 0;">${t("about.disclaimer2")}</p>
                    <p style="margin:0;">
                        ${t("about.dataSource")
                            .replace("{tarkovdev}", `<a href="https://tarkov.dev/api" target="_blank" rel="noopener noreferrer"
                           style="color:#888; text-decoration:underline; text-underline-offset:3px;">tarkov.dev API</a>`)
                            .replace("{spt}", `<a href="https://github.com/SP-Tushonka" target="_blank" rel="noopener noreferrer"
                           style="color:#888; text-decoration:underline; text-underline-offset:3px;">SP-Tushonka</a>`)}
                    </p>
                </div>

                ${_showPerf ? `
                <hr class="modal-divider" style="margin:0;" />

                <div class="modal-section" style="gap:6px;">
                    <div class="modal-label">${t("perf.section")}</div>
                    <div class="hidden-stats-grid" id="about-perf-body"></div>
                </div>
                ` : ""}

                <hr class="modal-divider" style="margin:0;" />

                <div style="display:flex; flex-direction:column; align-items:center; gap:12px;">
                    <button id="about-donate-toggle" class="cost-flea-refetch-btn" style="font-size:13px; padding:6px 16px;">${t("about.donateShow")}</button>
                    <div id="about-donate-qr" style="display:none; flex-direction:column; align-items:center; gap:12px;">
                        <div style="display:flex; gap:24px; justify-content:center;">
                            <div style="display:flex; flex-direction:column; align-items:center; gap:6px;">
                                <img src="./assets/images/dW.png" alt="WeChat Pay QR" draggable="false" style="width:120px; height:120px; object-fit:contain; border-radius:4px; user-select:none; -webkit-user-drag:none; pointer-events:none;" />
                                <span style="font-size:12px; color:#888; letter-spacing:0.5px; user-select:none;">${t("about.donateWechat")}</span>
                            </div>
                            <div style="display:flex; flex-direction:column; align-items:center; gap:6px;">
                                <img src="./assets/images/dA.png" alt="Alipay QR" draggable="false" style="width:120px; height:120px; object-fit:contain; border-radius:4px; user-select:none; -webkit-user-drag:none; pointer-events:none;" />
                                <span style="font-size:12px; color:#888; letter-spacing:0.5px; user-select:none;">${t("about.donateAlipay")}</span>
                            </div>
                        </div>
                        <p style="margin:0; font-size:13px; color:#555; text-align:center; line-height:1.6;">${t("about.donateDisclaimer")}</p>
                    </div>
                </div>

                <hr class="modal-divider" style="margin:0;" />

                <div style="font-size:12px; color:#444; letter-spacing:0.5px;">
                    ${t("about.copyright")}
                </div>

            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    if (_showPerf) EFTForge.perfMetrics.mount(document.getElementById("about-perf-body"), overlay);
    _loadAboutKitbashVersion();
    document.getElementById("about-modal-close").addEventListener("click", () => overlay.remove());
    let _mdOnBackdrop = false;
    overlay.addEventListener("mousedown", e => { _mdOnBackdrop = e.target === overlay; });
    overlay.addEventListener("click", (e) => { if (e.target === overlay && _mdOnBackdrop) overlay.remove(); });

    document.getElementById("about-donate-toggle").addEventListener("click", function () {
        const { t: _t } = EFTForge.lang;
        const qr = document.getElementById("about-donate-qr");
        const open = qr.style.display === "flex";
        qr.style.display = open ? "none" : "flex";
        this.textContent = open ? _t("about.donateShow") : _t("about.donateHide");
    });

    document.getElementById("about-check-update-btn").addEventListener("click", async function () {
        const { t: _t } = EFTForge.lang;
        const btn    = /** @type {HTMLButtonElement} */ (this);
        const status = document.getElementById("about-update-status");
        btn.disabled = true;
        btn.textContent = _t("about.checking");
        status.textContent = "";

        // Desktop app: there's no separate "deployed frontend" to compare
        // build dates against (the local backend just serves the copy
        // bundled in the app), so the web check below is meaningless here.
        // Delegate to the real Tauri/Rust updater instead, which checks the
        // Gitee/GitHub manifest per the user's Settings > update source and
        // (if found) handles the confirm-and-install dialog itself.
        if (EFTForge.config.IS_DESKTOP) {
            try {
                const result = await window.__TAURI__.core.invoke("manual_check_for_updates");
                btn.disabled = false;
                btn.textContent = _t("about.checkForUpdates");
                if (result.status === "available") {
                    status.style.color = "#4caf50";
                    status.textContent = _t("about.updateAvailable");
                } else if (result.status === "up_to_date") {
                    status.style.color = "#4caf50";
                    status.textContent = _t("about.upToDate");
                } else {
                    status.style.color = "#f44336";
                    status.textContent = result.message || _t("about.updateServerError");
                }
            } catch (e) {
                btn.disabled = false;
                btn.textContent = _t("about.checkForUpdates");
                status.style.color = "#f44336";
                status.textContent = String(e);
            }
            return;
        }

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
        btn.addEventListener("click", () => {
            const u = new URL(window.location.href);
            u.searchParams.set("_v", String(Date.now()));
            window.location.replace(u);
        }, { once: true });
    });
}

/* ===========================
   ATLAS ENTRY
=========================== */

// The desktop app's local backend has no Atlas data, so there the button opens the
// live site in the browser (the app routes outside links there) and shows no badge.
const ATLAS_LIVE_URL = "https://eftforge.com/atlas";
// Atlas covers both games, each with its own index; the badge counts them together.
const ATLAS_GAMES = { eft: "/atlas/api/index", arena: "/atlas/api/arena/index" };
const _atlasBadgeIndex = {};   // game -> the last index the badge counted from

// The button starts hidden and only appears once the admin has switched it on, so we
// wait for that before wiring it up or fetching its badge. /atlas itself works either way.
async function initAtlasEntry() {
    const btn = document.getElementById("atlas-btn");
    if (!btn) return;
    try {
        const res = await fetch(`${EFTForge.config.API_BASE}/atlas/api/entry`, { cache: "no-store" });
        if (!res.ok || !(await res.json()).shown) return;
    } catch (_) {
        return;  // can't tell, so we keep it hidden
    }
    btn.style.display = "";
    // the Stat Tracker's note links to Atlas only once the way in is switched on
    document.body.classList.add("atlas-entry-shown");
    // the header just got wider, so the overflow fades need a fresh measure
    _measureHeaderScroll();
    _updateHeaderFades();
    const desktop = EFTForge.config.IS_DESKTOP;
    btn.addEventListener("click", () => {
        if (desktop) window.open(ATLAS_LIVE_URL, "_blank");
        // straight to Arena's page when only Arena has something new
        else location.href = _atlasUnread("eft") === 0 && _atlasUnread("arena") > 0 ? "/atlas/arena" : "/atlas";
    });
    if (desktop) return;
    _loadAtlasBadge(btn);
    // Coming back from Atlas can restore this page as it was, without a fresh load, and a
    // restored page gets no storage events for what changed meanwhile. So whenever we are
    // shown again, recount from storage right away, then fetch again for new sets.
    window.addEventListener("pageshow", e => {
        _renderAtlasBadge(btn);
        if (e.persisted) _loadAtlasBadge(btn);
    });
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) _renderAtlasBadge(btn);
    });
    window.addEventListener("focus", () => _renderAtlasBadge(btn));
    // Atlas open in another tab: a set read or the badge switched off there shows here
    window.addEventListener("storage", e => {
        const u = EFTForge.utils;
        const readKeys = Object.values(u.ATLAS_READ_STORAGE);
        if (readKeys.includes(e.key) || e.key === u.ATLAS_BADGE_OFF_STORAGE) _renderAtlasBadge(btn);
    });
}

async function _fetchAtlasIndex(path, key) {
    const headers = {};
    // the Atlas page's rule: access keys start with atl_, anything else is the admin key
    if (key) headers[key.startsWith("atl_") ? "X-Atlas-Key" : "X-Admin-Key"] = key;
    return fetch(`${EFTForge.config.API_BASE}${path}`, { headers });
}

// The change sets this viewer can open that came out in the last week and they haven't
// opened in Atlas yet. With the key saved on the Atlas page a set counts as soon as it is
// detected; for the public, once it goes public.
async function _loadAtlasBadge(btn) {
    let key = null;
    try { key = localStorage.getItem("eftforge_atlas_key"); } catch { /* no storage, no key */ }
    await Promise.all(Object.entries(ATLAS_GAMES).map(async ([game, path]) => {
        try {
            let res = await _fetchAtlasIndex(path, key);
            // a rejected key still gets the public count rather than none
            if (key && (res.status === 403 || res.status === 429)) res = await _fetchAtlasIndex(path, null);
            if (!res.ok) return;
            _atlasBadgeIndex[game] = await res.json();
        } catch (_) {
            // no count for this game: Atlas being down is no reason to bother anyone here
        }
    }));
    _renderAtlasBadge(btn);
}

function _atlasUnread(game) {
    const index = _atlasBadgeIndex[game];
    if (!index) return 0;
    const u = EFTForge.utils;
    const now = Date.parse(index.server_time) || Date.now();
    const read = u.atlasReadIds(game);
    return (index.sets || []).filter(s => u.isAtlasUnread(s, now, read)).length;
}

function _renderAtlasBadge(btn) {
    if (!Object.keys(_atlasBadgeIndex).length) return;
    const count = EFTForge.utils.atlasBadgeHidden() ? 0 : _atlasUnread("eft") + _atlasUnread("arena");
    btn.dataset.badge = count > 0 ? (count > 99 ? "99+" : String(count)) : "";
}

/* ===========================
   LANGUAGE
=========================== */

function applyStaticTranslations() {
    const { t } = EFTForge.lang;

    document.title = EFTForge.state.lang === "zh" ? "EFTForge - 配置实验室" : "EFTForge - Forge Your Meta";

    const beianFooter = /** @type {HTMLElement | null} */ (document.querySelector(".beian-footer:not(.copyright-footer)"));
    const copyrightFooter = /** @type {HTMLElement | null} */ (document.querySelector(".copyright-footer"));
    const isDev = ["localhost", "127.0.0.1"].includes(location.hostname);
    const isZh = EFTForge.state.lang === "zh";
    const showBeian = !isDev && isZh;
    if (beianFooter) beianFooter.style.display = showBeian ? "" : "none";
    if (copyrightFooter) copyrightFooter.style.display = showBeian ? "none" : "";

    // Sync lang select value and update the custom trigger
    const langSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById("lang-select"));
    if (langSelect) {
        langSelect.value = EFTForge.state.lang;
        langSelect.dispatchEvent(new Event("input"));
    }

    // Header buttons - target only the label span to preserve SVG icon spans
    const setNavLabel = (id, key) => {
        const lbl = document.querySelector(`#${id} .header-nav-btn-label`);
        if (lbl) lbl.textContent = t(key);
    };
    setNavLabel("about-btn",       "btn.about");
    setNavLabel("desktop-settings-btn", "dt.navLabel");
    setNavLabel("news-btn",        "btn.news");
    setNavLabel("builds-btn",      "btn.builds");
    setNavLabel("leaderboard-btn", "btn.leaderboard");
    setNavLabel("tracker-btn",     "btn.tracker");
    const atlasBtn = document.getElementById("atlas-btn");
    if (atlasBtn) atlasBtn.dataset.tooltip = t("btn.atlas");
    setNavLabel("ammo-btn",        "btn.ammo");
    if (EFTForge.profile) EFTForge.profile.updateBtn();

    if (EFTForge.leaderboard) EFTForge.leaderboard.onLangChange();
    if (EFTForge.tracker)     EFTForge.tracker.onLangChange();
    if (EFTForge.ammoTable)   EFTForge.ammoTable.onLangChange();
    if (EFTForge.optimizer)   EFTForge.optimizer.onLangChange();

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
    const gunSearch = /** @type {HTMLInputElement | null} */ (document.getElementById("gun-search"));
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
    const target = /** @type {Element} */ (e.target);
    if (target.tagName === "IMG") target.classList.add("loaded");
}, true);

async function switchLang(lang) {
    if (EFTForge.state.lang === lang) return;
    if (_langSwitching) return;
    _langSwitching = true;

    // Snapshot build state before teardown - item names in cached objects are language-specific
    const previousGunId = EFTForge.state.currentGun?.id ?? null;
    // returnToGunSelection() below deactivates the open tab, so remember it and
    // reactivate it afterwards instead of reloading the build with no tab attached.
    const previousTabId = EFTForge.state.activeTabId ?? null;
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
    if (window.EFTForge && EFTForge.news)      EFTForge.news.onLangChange();
    if (window.EFTForge && EFTForge.tracker)   EFTForge.tracker.onLangChange();
    if (window.EFTForge && EFTForge.ammoTable) EFTForge.ammoTable.onLangChange();
    if (window.EFTForge && EFTForge.optimizer) EFTForge.optimizer.onLangChange();

    // Clear caches - item names are baked into cached objects
    EFTForge.state.slotCache      = {};
    EFTForge.state.allowedCache   = {};
    EFTForge.state.processedCache = {};
    _clearGunInitCache();

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
        if (previousTabId && EFTForge.state.tabs.some(tab => tab.id === previousTabId)) {
            // The tab record already holds the build, its name and its undo history,
            // and switching to it reloads everything in the new language.
            await EFTForge.tabs.switchToTab(previousTabId);
            if (snapshotCode) {
                const { t: _t } = EFTForge.lang;
                showToast(_t("toast.stateRestored"), _t("toast.stateRestoredMsg"), 3000, "#4CAF50");
            }
        } else if (previousGunId) {
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
        // Tab labels (gun short names) are language-specific - refresh them now that
        // allGuns has been re-fetched in the new language.
        EFTForge.tabs?.renderTabBar();
        _langSwitching = false;
    }
}

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
        // Placed right after the Tarkov clock (not appended to <header> with
        // absolute centering) so it can't drift into the nav buttons when the
        // header is narrower, e.g. the desktop app's window-controls layout.
        const tarkovClock = document.getElementById("tarkov-clock");
        if (tarkovClock) tarkovClock.insertAdjacentElement("afterend", btn);
        _fetchConnectedMode().then(state => btn.classList.toggle("dev-connected", !!state?.enabled));

        // Restore item ID overlay state
        window.EFTForge._dev = window.EFTForge._dev || {};
        EFTForge._dev.showItemIds = _loadSettings().showItemIds === true;

        // Click-to-copy delegation for item ID badges
        document.addEventListener("click", (e) => {
            const badge = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest(".dev-item-id-badge"));
            if (!badge) return;
            e.stopPropagation();
            const id = badge.dataset.id;
            navigator.clipboard.writeText(id).then(() => {
                const prev = badge.textContent;
                badge.textContent = "Copied!";
                badge.classList.add("dev-item-id-badge--copied");
                setTimeout(() => {
                    badge.textContent = prev;
                    badge.classList.remove("dev-item-id-badge--copied");
                }, 1000);
            });
        });
    }

    // ── Connected mode ──────────────────────────────────────────
    // The local backend forwards community reads to the live service while this
    // is on (backend/services/community_proxy.py). The desktop app has its own
    // switch in its settings, and the endpoint only exists on a reset.py dev
    // server, so we resolve to null anywhere else.
    async function _fetchConnectedMode() {
        if (EFTForge.config.IS_DESKTOP) return null;
        try {
            const res = await fetch(`${EFTForge.config.API_BASE}/dev/connected-mode`, { cache: "no-store" });
            return res.ok ? await res.json() : null;
        } catch (_) {
            return null;
        }
    }

    async function _setConnectedMode(enabled) {
        const res = await fetch(`${EFTForge.config.API_BASE}/dev/connected-mode`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async function _bindConnectedModeToggle() {
        const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById("dev-connected-toggle"));
        const hint = document.getElementById("dev-connected-hint");
        if (!btn || !hint) return;

        const state = await _fetchConnectedMode();
        if (!state) {
            hint.textContent = "Unavailable: start the backend through reset.py / launch.bat";
            return;
        }
        const render = (enabled) => {
            btn.disabled = false;
            btn.textContent = enabled ? "ON" : "OFF";
            btn.classList.toggle("active", enabled);
            hint.textContent = enabled
                ? `Read only from ${state.remote_origin}`
                : "Using local community databases";
        };
        render(state.enabled);

        btn.addEventListener("click", async () => {
            btn.disabled = true;
            try {
                await _setConnectedMode(!btn.classList.contains("active"));
                // Community views cache what they already loaded, so start clean.
                window.location.reload();
            } catch (err) {
                hint.textContent = `Toggle failed: ${err.message}`;
                btn.disabled = false;
            }
        });
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
        const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById(btnId));
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
        const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById(btnId));
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

        // The grid devtool injects its toolbar only once opted in, so existence is the visibility state
        const toolbarVisible = !!document.getElementById("ag-dev-toolbar");

        overlay.innerHTML = `
            <div class="modal-window" style="max-width:480px; max-height:85vh; display:flex; flex-direction:column;">
                <div class="modal-header">
                    <span class="modal-title">DEVELOPER TOOLS</span>
                    <button class="modal-close-btn" id="dev-modal-close">&#x2715;</button>
                </div>
                <div style="overflow-y:auto; flex:1;">
                    <div class="modal-body" style="gap:0; padding:0;">

                        ${EFTForge.config.IS_DESKTOP ? "" : `
                        <div class="dev-modal-section-label">Community Data</div>
                        <div class="dev-modal-row">
                            <span class="dev-modal-row-label">
                                Connected to live EFTForge.com
                                <span class="dev-modal-row-hint" id="dev-connected-hint">Checking...</span>
                            </span>
                            <button id="dev-connected-toggle" class="dev-modal-toggle" disabled>OFF</button>
                        </div>
                        `}

                        <div class="dev-modal-section-label"${EFTForge.config.IS_DESKTOP ? "" : ` style="padding-top:18px;"`}>Screenshot Mode</div>
                        <div class="dev-modal-row">
                            <span class="dev-modal-row-label" id="dev-capture-status"></span>
                            <div class="capture-modal-actions">
                                <button id="dev-capture-start" class="dev-debugger-run-btn">START</button>
                                <button id="dev-capture-restore" class="dev-debugger-run-btn">RESTORE ALL</button>
                            </div>
                        </div>
                        <div class="dev-modal-section-label">Grid</div>
                        <div class="dev-modal-row">
                            <span class="dev-modal-row-label">Grid position editor</span>
                            <button id="dev-grid-tool-toggle" class="dev-modal-toggle${toolbarVisible ? " active" : ""}">
                                ${toolbarVisible ? "ON" : "OFF"}
                            </button>
                        </div>

                        <div class="dev-modal-section-label" style="padding-top:18px;">Attachment Table</div>
                        <div class="dev-modal-row">
                            <span class="dev-modal-row-label">Show item IDs (click to copy)</span>
                            <button id="dev-id-overlay-toggle" class="dev-modal-toggle${EFTForge._dev?.showItemIds ? " active" : ""}">
                                ${EFTForge._dev?.showItemIds ? "ON" : "OFF"}
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

                        <div class="dev-modal-section-label" style="padding-top:18px;">Toast Notifications</div>
                        <div class="dev-modal-row">
                            <span class="dev-modal-row-label">Fire example toasts</span>
                            <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
                                <button id="dev-toast-info"     class="dev-debugger-run-btn" style="border-color:#4a90d9;color:#4a90d9;">INFO</button>
                                <button id="dev-toast-success"  class="dev-debugger-run-btn" style="border-color:#4CAF50;color:#4CAF50;">SUCCESS</button>
                                <button id="dev-toast-warning"  class="dev-debugger-run-btn" style="border-color:#f5a623;color:#f5a623;">WARNING</button>
                                <button id="dev-toast-error"    class="dev-debugger-run-btn" style="border-color:#e74c3c;color:#e74c3c;">ERROR</button>
                                <button id="dev-toast-critical" class="dev-debugger-run-btn" style="border-color:#9b59b6;color:#9b59b6;">CRITICAL</button>
                            </div>
                        </div>

                        <div class="dev-modal-section-label" style="padding-top:18px;">LocalStorage</div>
                        <div class="dev-modal-row">
                            <span class="dev-modal-row-label">eftforge_* keys</span>
                            <div style="display:flex;gap:6px;">
                                <button id="dev-ls-refresh-btn" class="dev-debugger-run-btn" style="display:none;">REFRESH</button>
                                <button id="dev-ls-toggle-btn" class="dev-debugger-run-btn">EXPAND</button>
                            </div>
                        </div>
                        <input id="dev-ls-search" class="dev-ls-search" type="text" placeholder="Filter keys…" style="display:none;">
                        <div id="dev-ls-list" class="dev-ls-list" style="display:none;"></div>

                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        document.getElementById("dev-modal-close").addEventListener("click", () => overlay.remove());
        _bindConnectedModeToggle();

        const capture = EFTForge._dev?.screenshotMode;
        function updateCaptureStatus() {
            const status = capture?.getStatus();
            document.getElementById('dev-capture-status').textContent = status
                ? `${status.mode} · ${status.changes} active edit(s)` : 'Unavailable';
            const start = /** @type {HTMLButtonElement | null} */ (document.getElementById('dev-capture-start'));
            start.textContent = status?.mode === 'idle' ? 'START' : 'RESUME';
            start.disabled = !capture;
            /** @type {HTMLButtonElement} */ (document.getElementById('dev-capture-restore')).disabled = !status?.changes;
        }
        updateCaptureStatus();
        document.getElementById('dev-capture-start').addEventListener('click', () => capture?.start());
        document.getElementById('dev-capture-restore').addEventListener('click', () => {
            capture?.restoreAll();
            updateCaptureStatus();
        });

        const _toastExamples = [
            { id: "dev-toast-info",     color: "#4a90d9", title: "Info",     msg: "This is an example info announcement." },
            { id: "dev-toast-success",  color: "#4CAF50", title: "Success",  msg: "Action completed successfully." },
            { id: "dev-toast-warning",  color: "#f5a623", title: "Warning",  msg: "Something may need your attention." },
            { id: "dev-toast-error",    color: "#e74c3c", title: "Error",    msg: "An error occurred. Please try again." },
            { id: "dev-toast-critical", color: "#9b59b6", title: "Critical", msg: "Critical system alert requiring immediate action." },
        ];
        _toastExamples.forEach(({ id, color, title, msg }) => {
            document.getElementById(id).addEventListener("click", () => showToast(title, msg, 5000, color));
        });
        let _mdOnBackdrop = false;
        overlay.addEventListener("mousedown", e => { _mdOnBackdrop = e.target === overlay; });
        overlay.addEventListener("click", (e) => { if (e.target === overlay && _mdOnBackdrop) overlay.remove(); });

        document.getElementById("dev-grid-tool-toggle").addEventListener("click", function () {
            const agDevTool = window._agDevTool;
            if (!agDevTool) return;
            const nowVisible = !!document.getElementById("ag-dev-toolbar");
            if (nowVisible) agDevTool.hide();
            else agDevTool.show();
            this.textContent = nowVisible ? "OFF" : "ON";
            this.classList.toggle("active", !nowVisible);
        });

        document.getElementById("dev-id-overlay-toggle").addEventListener("click", function () {
            const newVal = !(EFTForge._dev?.showItemIds === true);
            EFTForge._dev = EFTForge._dev || {};
            EFTForge._dev.showItemIds = newVal;
            _saveSetting("showItemIds", newVal);
            this.textContent = newVal ? "ON" : "OFF";
            this.classList.toggle("active", newVal);
            if (newVal) {
                /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#attachment-body tr[data-item-id]")).forEach(tr => {
                    if (tr.querySelector(".dev-item-id-badge")) return;
                    const nameText = tr.querySelector(".attachment-name-text");
                    if (!nameText) return;
                    const badge = document.createElement("div");
                    badge.className = "dev-item-id-badge";
                    badge.dataset.id = tr.dataset.itemId;
                    badge.textContent = tr.dataset.itemId;
                    nameText.insertAdjacentElement("afterend", badge);
                });
            } else {
                document.querySelectorAll(".dev-item-id-badge").forEach(el => el.remove());
            }
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

        let _lsFilterQuery = "";

        function _renderLsItems() {
            const container = document.getElementById("dev-ls-list");
            if (!container) return;
            const q = _lsFilterQuery.trim().toLowerCase();
            const keys = Object.keys(localStorage)
                .filter(k => k.startsWith("eftforge_"))
                .filter(k => !q || k.toLowerCase().includes(q))
                .sort();
            if (keys.length === 0) {
                container.innerHTML = `<div class="dev-ls-empty">${q ? "No keys match your filter." : "No eftforge_* keys found."}</div>`;
                return;
            }
            container.innerHTML = keys.map(k => {
                const val = localStorage.getItem(k) ?? "";
                const preview = val.length > 60 ? val.slice(0, 60) + "…" : val;
                return `<div class="dev-ls-row" data-key="${escapeHtml(k)}">
                    <div class="dev-ls-key">${escapeHtml(k.replace("eftforge_", ""))}</div>
                    <div class="dev-ls-val" title="${escapeHtml(val)}">${escapeHtml(preview)}</div>
                    <button class="dev-ls-clear-btn">CLEAR</button>
                </div>`;
            }).join("");
        }

        const _lsList = document.getElementById("dev-ls-list");
        const _lsRefreshBtn = document.getElementById("dev-ls-refresh-btn");
        const _lsToggleBtn = document.getElementById("dev-ls-toggle-btn");
        const _lsSearch = /** @type {HTMLInputElement | null} */ (document.getElementById("dev-ls-search"));
        let _lsExpanded = false;

        _lsToggleBtn.addEventListener("click", () => {
            _lsExpanded = !_lsExpanded;
            _lsList.style.display = _lsExpanded ? "" : "none";
            _lsRefreshBtn.style.display = _lsExpanded ? "" : "none";
            _lsSearch.style.display = _lsExpanded ? "" : "none";
            _lsToggleBtn.textContent = _lsExpanded ? "COLLAPSE" : "EXPAND";
            if (_lsExpanded) _renderLsItems();
        });

        _lsRefreshBtn.addEventListener("click", _renderLsItems);

        _lsSearch.addEventListener("input", () => {
            _lsFilterQuery = _lsSearch.value;
            _renderLsItems();
        });

        _lsList.addEventListener("click", e => {
            const btn = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest(".dev-ls-clear-btn"));
            if (!btn) return;
            const row = /** @type {HTMLElement | null} */ (btn.closest(".dev-ls-row"));
            const key = row?.dataset.key;
            if (!key) return;
            localStorage.removeItem(key);
            row.remove();
            if (_lsList.children.length === 0) {
                _lsList.innerHTML = `<div class="dev-ls-empty">${_lsFilterQuery.trim() ? "No keys match your filter." : "No eftforge_* keys found."}</div>`;
            }
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

/* ===========================
   DOT GRID PARALLAX
=========================== */

EFTForge.utils.initDotParallax(
    document.getElementById("page-bg-dots"),
    document.getElementById("main-container")
);

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
