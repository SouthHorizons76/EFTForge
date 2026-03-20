
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
    })
    .catch(err => console.warn("Could not load traders:", err));

  async function tryLoadGuns(isRetry = false) {
    try {
      EFTForge.state.allGuns = await fetchGuns();
      renderGunList(EFTForge.state.allGuns);
      stopPanelLoading(loadingOverlay);
    } catch (err) {
      console.error("Failed to load guns:", err);
      if (!isRetry) {
        showToast(t("toast.connectionError"), t("toast.backendDown") + " " + (EFTForge.config.IS_LOCAL_DEV ? t("toast.networkHintDev") : t("toast.networkHintProd")), 7000);
      }
      setTimeout(() => tryLoadGuns(true), 5000);
    }
  }

  tryLoadGuns();

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
        // Don't hijack keypresses while any modal is open
        if (document.querySelector(".modal-overlay")) return;

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
        EFTForge.state.showHandguns = false;
        updateToggleUI();
        renderFilteredGunList(true);
    });

    document.getElementById("handgun-btn").addEventListener("click", () => {
        EFTForge.state.showHandguns = true;
        updateToggleUI();
        renderFilteredGunList(true);
    });

    document.getElementById("sort-caliber-btn").addEventListener("click", () => {
        EFTForge.state.sortByClass = false;
        updateToggleUI();
        renderFilteredGunList(true);
    });

    document.getElementById("sort-class-btn").addEventListener("click", () => {
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
   MOBILE TABS
=========================== */

function isMobileLayout() {
    const hasTouch = navigator.maxTouchPoints > 0;
    const hasCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
    const mobileUA = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);
    return (hasTouch && hasCoarsePointer) || (hasTouch && mobileUA);
}

function switchToMobileTab(tab) {
    const container = document.getElementById("main-container");
    const tabBar    = document.getElementById("mobile-tab-bar");
    if (!container || !tabBar) return;

    container.dataset.mobileTab = tab;

    tabBar.querySelectorAll(".mobile-tab-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.tab === tab);
    });

}

function updateMobileTabBarVisibility() {
    const tabBar    = document.getElementById("mobile-tab-bar");
    const container = document.getElementById("main-container");
    if (!tabBar || !container) return;

    if (!isMobileLayout()) {
        tabBar.style.display = "none";
        return;
    }

    const hasGun = !container.classList.contains("no-gun");
    tabBar.style.display = hasGun ? "flex" : "none";
}

/* ===========================
   PANEL RESIZER
=========================== */

function initPanelResizer() {
    // Resizer is hidden on mobile; skip setup to avoid invalid width constraints
    if (isMobileLayout()) return;

    const resizer   = document.getElementById("panel-resizer");
    const leftPanel = document.querySelector(".left-panel");
    const container = document.getElementById("main-container");

    const DEFAULT_WIDTH = 520;
    const MIN_LEFT      = 520;
    const MIN_RIGHT     = 720;

    const saved = parseInt(localStorage.getItem("eftforge_panel_width"));
    leftPanel.style.width = (saved >= MIN_LEFT ? saved : DEFAULT_WIDTH) + "px";

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
    });

    document.addEventListener("mouseup", () => {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove("dragging");
        document.body.style.cursor     = "";
        document.body.style.userSelect = "";
        localStorage.setItem("eftforge_panel_width", leftPanel.offsetWidth);
    });
}

/* ===========================
   DAILY SYNC NOTICE
=========================== */

function scheduleSyncNotice() {
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
    setInterval(checkAndNotify, 60000);
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
   TARKOV CLOCK
=========================== */

function initTarkovClock() {
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

    function isDay(hours) {
        return hours >= 6 && hours < 22;
    }

    // Returns a color string for the time label based on proximity to noon (warmest yellow)
    // or midnight (most purple), so the color drifts subtly as in-game time passes.
    function timeColor(ms) {
        const { hours, minutes, seconds } = msToTime(ms);
        const frac = hours + minutes / 60 + seconds / 3600;

        if (frac >= 6 && frac < 22) {
            // Day: peak yellow at 12:00, fade to neutral gray at 6:00/22:00
            const dist = Math.abs(frac - 12);     // 0 at noon, up to 6 at edges
            const t    = Math.min(dist / 6, 1);   // 0=noon, 1=edge-of-day
            // noon: rgb(200,160,48) ~#c8a030  |  edge: rgb(136,136,136) #888
            const r = Math.round(200 - 64 * t);
            const g = Math.round(160 - 24 * t);
            const b = Math.round(48  + 88 * t);
            return `rgb(${r},${g},${b})`;
        } else {
            // Night: peak purple at midnight, fades slightly toward 22:00/6:00
            const distFromMidnight = frac >= 22 ? 24 - frac : frac;  // 0 at midnight
            const t = Math.min(distFromMidnight / 6, 1);  // 0=midnight, 1=edge
            // midnight: rgb(96,96,128) #606080  |  edge: rgb(96,96,96) #606060
            const b = Math.round(128 - 32 * t);
            return `rgb(96,96,${b})`;
        }
    }

    function applyEntry(dotId, timeId, ms) {
        const { hours, minutes, seconds } = msToTime(ms);
        const day = isDay(hours);

        const dotEl  = document.getElementById(dotId);
        const timeEl = document.getElementById(timeId);
        if (!dotEl || !timeEl) return;

        timeEl.textContent = String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
        dotEl.className    = "tarkov-dot " + (day ? "tarkov-dot-day"        : "tarkov-dot-night");
        timeEl.className   = "tarkov-clock-time " + (day ? "tarkov-clock-time-day" : "tarkov-clock-time-night");
        timeEl.style.color = timeColor(ms);
    }

    function tick() {
        const base = Date.now() * 7;
        applyEntry("tarkov-dot-left",  "tarkov-time-left",  (base + LEFT_OFFSET_MS)  % 86_400_000);
        applyEntry("tarkov-dot-right", "tarkov-time-right", (base + RIGHT_OFFSET_MS) % 86_400_000);
    }

    tick();
    // Update every ~143ms (1000/7) so Tarkov seconds don't visibly skip
    setInterval(tick, Math.floor(1000 / 7));
}

/* ===========================
   MOBILE WARNING
=========================== */

function mobileWarning() {
    if (!isMobileLayout()) return;
    const { t } = EFTForge.lang;
    showToast(t("toast.mobileWarningTitle"), t("toast.mobileWarningMsg"), 10000, "#f5a623");
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
                    <a href="https://github.com/Morph1ne1076/EFTForge/issues/new" target="_blank" rel="noopener noreferrer" class="modal-close-btn" style="text-decoration:none; font-size:11px; letter-spacing:1px; display:inline-flex; align-items:center;">${t("about.reportBug")}</a>
                    <button class="modal-close-btn" id="about-modal-close">&#x2715;</button>
                </div>
            </div>
            <div class="modal-body" style="gap:16px;">

                <div style="display:flex; align-items:center; justify-content:space-between; user-select:none;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <img src="./assets/images/EFTForge1080x1080.png" alt="EFTForge Logo" style="width:40px; height:40px; object-fit:contain; opacity:0.9; flex-shrink:0;" />
                        <span style="font-size:22px; font-weight:700; color:#f5c542; letter-spacing:2px;">EFTForge</span>
                    </div>
                    <span style="font-size:13px; color:#555; letter-spacing:1px;">
                        ${escapeHtml(EFTForge.config.APP_VERSION)} - ${escapeHtml(EFTForge.config.APP_BUILD_DATE.slice(0, 10))}
                    </span>
                </div>

                <div>
                    <a href="https://github.com/Morph1ne1076/EFTForge"
                       target="_blank" rel="noopener noreferrer"
                       style="color:#4e8fd4; font-size:13px; letter-spacing:0.5px; text-decoration:none;">
                        https://github.com/Morph1ne1076/EFTForge
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

    function makeFlagImg(src) {
        const img = document.createElement("img");
        img.src = src;
        img.className = "select-option-flag";
        return img;
    }

    function syncTrigger() {
        const selected = sel.options[sel.selectedIndex];
        trigger.innerHTML = "";
        if (selected) {
            if (selected.dataset.img) trigger.appendChild(makeFlagImg(selected.dataset.img));
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
            if (opt.dataset.img) item.appendChild(makeFlagImg(opt.dataset.img));
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

    // Sync lang select value and update the custom trigger
    const langSelect = document.getElementById("lang-select");
    if (langSelect) {
        langSelect.value = EFTForge.state.lang;
        langSelect.dispatchEvent(new Event("input"));
    }

    // Header buttons
    const aboutBtn = document.getElementById("about-btn");
    const newsBtn  = document.getElementById("news-btn");
    const buildsBtn = document.getElementById("builds-btn");
    if (aboutBtn)  aboutBtn.textContent  = t("btn.about");
    if (newsBtn)   newsBtn.textContent   = t("btn.news");
    if (buildsBtn) buildsBtn.textContent = t("btn.builds");

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

    // Right panel placeholder text
    const placeholderMain = document.getElementById("placeholder-main");
    const placeholderSub  = document.getElementById("placeholder-sub");
    if (placeholderMain) placeholderMain.textContent = t("placeholder.modding");
    const isTouch = navigator.maxTouchPoints > 0;
    if (placeholderSub) placeholderSub.textContent = isTouch ? t("placeholder.longPress") : t("placeholder.rightClick");

    // Mobile tab bar labels
    const buildTab = document.querySelector("#mobile-tab-bar [data-tab='build']");
    const attTab   = document.querySelector("#mobile-tab-bar [data-tab='attachments']");
    if (buildTab) buildTab.textContent = t("tab.build");
    if (attTab)   attTab.textContent   = t("tab.attachments");
}

async function switchLang(lang) {
    if (EFTForge.state.lang === lang) return;

    EFTForge.state.lang = lang;
    localStorage.setItem("eftforge_lang", lang);

    applyStaticTranslations();
    if (window.EFTForge && EFTForge.news) EFTForge.news.onLangChange();

    // Clear caches - item names are baked into cached objects
    EFTForge.state.slotCache      = {};
    EFTForge.state.allowedCache   = {};
    EFTForge.state.processedCache = {};

    const previousGunId = EFTForge.state.currentGun?.id ?? null;
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

    // Re-select the previously open weapon with new language data
    if (previousGunId) {
        const gun = EFTForge.state.allGuns.find(g => g.id === previousGunId);
        if (gun) await selectGun(gun, { classList: { add() {}, remove() {} } });
    }
}