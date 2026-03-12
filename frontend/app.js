
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
    showToast("Connection Error", "Could not load weapon list. Is the backend running?", 7000);
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
        renderGunList(EFTForge.state.allGuns);
    });

    document.getElementById("handgun-btn").addEventListener("click", () => {
        EFTForge.state.showHandguns = true;
        updateToggleUI();
        renderGunList(EFTForge.state.allGuns);
    });

    document.getElementById("sort-caliber-btn").addEventListener("click", () => {
        EFTForge.state.sortByClass = false;
        updateToggleUI();
        renderGunList(EFTForge.state.allGuns);
    });

    document.getElementById("sort-class-btn").addEventListener("click", () => {
        EFTForge.state.sortByClass = true;
        updateToggleUI();
        renderGunList(EFTForge.state.allGuns);
    });

    renderSavedBuildsList();
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
                <span class="modal-title">ABOUT EFTFORGE</span>
                <div style="display:flex; align-items:center; gap:4px;">
                    <a href="https://github.com/Morph1ne1076/EFTForge/issues/new" target="_blank" rel="noopener noreferrer" class="modal-close-btn" style="text-decoration:none; font-size:11px; letter-spacing:1px; display:inline-flex; align-items:center;">Report Bug</a>
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
                    <p style="margin:0 0 10px 0;">
                        Game content and materials are trademarks and copyrights of
                        <strong style="color:#bbb;">Battlestate Games</strong> and its licensors.
                        All rights reserved.
                    </p>
                    <p style="margin:0 0 10px 0;">
                        EFTForge is an unofficial fan-made tool and is not affiliated with,
                        endorsed by, or in any way officially connected with Battlestate Games.
                    </p>
                    <p style="margin:0;">
                        All in-game data is sourced from the
                        <a href="https://tarkov.dev/api" target="_blank" rel="noopener noreferrer"
                           style="color:#888; text-decoration:underline; text-underline-offset:3px;">tarkov.dev API</a>.
                    </p>
                </div>

                <hr class="modal-divider" style="margin:0;" />

                <div style="font-size:12px; color:#444; letter-spacing:0.5px;">
                    &copy; 2026 Morph1ne. All Rights Reserved.
                </div>

            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    document.getElementById("about-modal-close").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
}