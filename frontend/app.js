
/* ===========================
   INITIAL LOAD
=========================== */

init();
devVersionCheck();

async function init() {
  const loadingOverlay = startPanelLoading(document.querySelector(".left-panel"));
  try {
    EFTForge.state.allGuns = await fetchGuns();
    renderGunList(EFTForge.state.allGuns);
  } catch (err) {
    console.error("Failed to load guns:", err);
    showToast(t("toast.connectionError"), t("toast.backendDown") + " " + (EFTForge.config.IS_LOCAL_DEV ? t("toast.networkHintDev") : t("toast.networkHintProd")), 7000);
  } finally {
    stopPanelLoading(loadingOverlay);
  }

  document
    .getElementById("gun-search")
    .addEventListener("input", (e) => {
        const query = e.target.value.toLowerCase();

        const filtered = EFTForge.state.allGuns.filter(g =>
        g.name.toLowerCase().includes(query)
        );

        renderGunList(filtered);
    });

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
        renderGunList(EFTForge.state.allGuns, true);
    });

    document.getElementById("handgun-btn").addEventListener("click", () => {
        EFTForge.state.showHandguns = true;
        updateToggleUI();
        renderGunList(EFTForge.state.allGuns, true);
    });

    document.getElementById("sort-caliber-btn").addEventListener("click", () => {
        EFTForge.state.sortByClass = false;
        updateToggleUI();
        renderGunList(EFTForge.state.allGuns, true);
    });

    document.getElementById("sort-class-btn").addEventListener("click", () => {
        EFTForge.state.sortByClass = true;
        updateToggleUI();
        renderGunList(EFTForge.state.allGuns, true);
    });

    applyStaticTranslations();

    renderSavedBuildsList();

    scheduleSyncNotice();

    initPanelResizer();
}

/* ===========================
   MOBILE TABS
=========================== */

function isMobileLayout() {
    const w = window.innerWidth, h = window.innerHeight;
    if (w <= 768 && h > w) return true;           // portrait phone
    if (h <= 600 && w <= 1024) return true;        // landscape phone
    return false;
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

    const files = ["app.js", "build-manager.js", "index.html"];
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
   UI — ABOUT DIALOG
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

                <div style="display:flex; align-items:baseline; justify-content:space-between;">
                    <span style="font-size:22px; font-weight:700; color:#f5c542; letter-spacing:2px;">EFTForge</span>
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
   LANGUAGE
=========================== */

function applyStaticTranslations() {
    const { t } = EFTForge.lang;

    // Sync lang select value
    const langSelect = document.getElementById("lang-select");
    if (langSelect) langSelect.value = EFTForge.state.lang;

    // Header buttons
    const aboutBtn = document.getElementById("about-btn");
    const buildsBtn = document.getElementById("builds-btn");
    if (aboutBtn)  aboutBtn.textContent  = t("btn.about");
    if (buildsBtn) buildsBtn.textContent = t("btn.builds");

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
    const saveShareBtn = document.getElementById("save-share-btn");
    if (backBtn)      backBtn.textContent      = t("btn.back");
    if (resetBtn)     resetBtn.textContent     = t("btn.reset");
    if (stripBtn)     stripBtn.textContent     = t("btn.strip");
    if (saveShareBtn) saveShareBtn.textContent = t("btn.saveShare");

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

    // Clear caches — item names are baked into cached objects
    EFTForge.state.slotCache      = {};
    EFTForge.state.allowedCache   = {};
    EFTForge.state.processedCache = {};

    const previousGunId = EFTForge.state.currentGun?.id ?? null;
    if (EFTForge.state.currentGun) returnToGunSelection();

    const loadingOverlay = startPanelLoading(document.querySelector(".left-panel"));
    try {
        EFTForge.state.allGuns = await fetchGuns();
        renderGunList(EFTForge.state.allGuns);
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