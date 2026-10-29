/* ============================================================
   DESKTOP APP SETTINGS
   Only active inside the packaged desktop app (the local backend
   injects window.__EFTFORGE_DESKTOP__ into index.html). Self-exits
   on the website and in normal local dev, like the devtool modules.

   Uses the site's own modal factory (_createModalOverlay), t() and
   modal-* classes. Provides:
     - header "Settings" nav button (cog icon)
     - settings modal: community mode / close behavior / update source /
       item data sync
     - EFTForge.desktopSettings.goOnline() - used by the local-mode
       prompts in build-manager to switch to connected mode
     - EFTForge.desktopSettings.setCloseAction() - used by
       window-controls.js's close-choice modal to persist "remember my
       choice" (same close_action setting this modal's own radios write)
     - local mode: hides the community-only header buttons
       (leaderboards, profile)
============================================================ */
(function () {
    if (!window.__EFTFORGE_DESKTOP__) return;

    window.EFTForge = window.EFTForge || {};

    const _base = () => (EFTForge.config ? EFTForge.config.API_BASE : "");
    let _syncPollTimer = null;

    async function _postSetting(patch) {
        const res = await fetch(`${_base()}/desktop/settings`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    /* Switch to connected mode and reload - the entry point from the
       "connect to EFTForge.com" prompts shown in local mode. */
    async function goOnline(btnEl) {
        if (btnEl) { btnEl.disabled = true; btnEl.textContent = "..."; }
        try {
            await _postSetting({ community_mode: "connected" });
            window.location.reload();
        } catch (e) {
            if (btnEl) { btnEl.disabled = false; btnEl.textContent = t("cb.goOnlineBtn"); }
            showToast(t("toast.connectionError"), String(e), 4000);
        }
    }

    function _fmtSyncTime(iso) {
        if (!iso) return t("dt.never");
        try {
            return new Date(iso).toLocaleString(EFTForge.state?.lang === "zh" ? "zh-CN" : "en-US");
        } catch { return iso; }
    }

    /* ---------------- app update progress ---------------- */
    // Rust emits these while the Tauri updater downloads a new app version
    // (see prompt_and_install in desktop/src-tauri/src/main.rs). The download
    // runs in the background with the app fully usable, so without feedback
    // it looks like nothing is happening until the app suddenly closes for
    // the install - surface it as a badge on the header Settings button plus
    // a live progress section inside this modal.
    let _upd = { phase: "idle", version: "", downloaded: 0, total: 0, message: "" };

    function _updPct() {
        if (!_upd.total) return null;
        return Math.min(100, Math.floor((_upd.downloaded / _upd.total) * 100));
    }

    function _refreshUpdateUi() {
        const btn = document.getElementById("desktop-settings-btn");
        if (btn) {
            if (_upd.phase === "downloading") {
                const pct = _updPct();
                btn.dataset.badge = pct === null ? "↓" : `${pct}%`;
            } else if (_upd.phase === "installing") {
                btn.dataset.badge = "↓";
            } else if (_upd.phase === "error") {
                btn.dataset.badge = "!";
            } else {
                btn.dataset.badge = "";
            }
        }
        const box = document.getElementById("dt-update-progress");
        if (box) _renderUpdateProgress(box);
    }

    function _renderUpdateProgress(box) {
        if (_upd.phase === "idle") {
            box.style.display = "none";
            box.innerHTML = "";
            return;
        }
        box.style.display = "";
        if (_upd.phase === "downloading") {
            const pct = _updPct();
            const mb = (v) => (v / 1048576).toFixed(1);
            const detail = _upd.total
                ? `${mb(_upd.downloaded)} / ${mb(_upd.total)} MB`
                : `${mb(_upd.downloaded)} MB`;
            box.innerHTML = `
                <div style="font-size:12px; color:#c9a53c;">${escapeHtml(t("dt.updDownloading").replace("{v}", _upd.version))}</div>
                <div style="height:6px; background:#222; border:1px solid #333; margin-top:6px;">
                    <div id="dt-update-bar" style="height:100%; width:${pct === null ? 100 : pct}%; background:#9a8866;"></div>
                </div>
                <div id="dt-update-detail" style="font-size:11px; color:#888; margin-top:4px;">${pct === null ? "" : pct + "% - "}${detail}</div>`;
        } else if (_upd.phase === "installing") {
            box.innerHTML = `<div style="font-size:12px; color:#7ba05b;">${t("dt.updInstalling")}</div>`;
        } else if (_upd.phase === "error") {
            box.innerHTML = `<div style="font-size:12px; color:#f44336;">${t("dt.updError")}${escapeHtml(_upd.message)}</div>`;
        }
    }

    function _initUpdateEvents() {
        // Needs the Tauri IPC bridge - present in the packaged app only.
        if (!window.__TAURI__) return;
        const listen = window.__TAURI__.event.listen;
        listen("update-download-started", (e) => {
            _upd = { phase: "downloading", version: (e.payload && e.payload.version) || "", downloaded: 0, total: 0, message: "" };
            _refreshUpdateUi();
        });
        listen("update-download-progress", (e) => {
            _upd.phase = "downloading";
            _upd.downloaded = (e.payload && e.payload.downloaded) || 0;
            if (e.payload && e.payload.total) _upd.total = e.payload.total;
            _refreshUpdateUi();
        });
        listen("update-installing", () => {
            _upd.phase = "installing";
            _refreshUpdateUi();
        });
        listen("update-error", (e) => {
            _upd.phase = "error";
            _upd.message = String((e.payload && e.payload.message) || "");
            _refreshUpdateUi();
        });
    }

    /* ---------------- modal ---------------- */

    async function showPanel() {
        const overlay = _createModalOverlay("desktop-settings-modal", t("stg.title"), { maxWidth: "500px" });
        if (!overlay) return;
        if (_syncPollTimer) { clearInterval(_syncPollTimer); _syncPollTimer = null; }

        const body = document.getElementById("desktop-settings-modal-body");
        body.innerHTML = `<div style="color:#555; font-size:13px; font-style:italic;">...</div>`;
        try {
            const [infoRes, syncRes] = await Promise.all([
                fetch(`${_base()}/desktop/settings`,    { cache: "no-store" }),
                fetch(`${_base()}/desktop/sync-status`, { cache: "no-store" }),
            ]);
            _renderBody(body, await infoRes.json(), await syncRes.json());
        } catch (e) {
            body.innerHTML = `<div style="color:#f44336; font-size:13px;">${escapeHtml(String(e))}</div>`;
        }
    }

    function _modeOptionHtml(value, current) {
        const name = value === "connected" ? t("dt.modeConnected") : t("dt.modeLocal");
        const desc = value === "connected" ? t("dt.modeConnectedDesc") : t("dt.modeLocalDesc");
        return `
            <label style="display:flex; gap:10px; align-items:flex-start; padding:6px 0; cursor:pointer;">
                <input type="radio" name="dt-mode" value="${value}" ${current === value ? "checked" : ""}
                       style="margin-top:3px; accent-color:#9a8866; cursor:pointer;" />
                <span style="min-width:0;">
                    <span style="display:block; font-size:13px; font-weight:700; color:#ddd;">${name}</span>
                    <span style="display:block; font-size:12px; color:#888; margin-top:2px; line-height:1.45;">${desc}</span>
                </span>
            </label>`;
    }

    const _CLOSE_NAME_KEY = { tray: "dt.closeTray", exit: "dt.closeExit" };
    const _CLOSE_DESC_KEY = { tray: "dt.closeTrayDesc", exit: "dt.closeExitDesc" };

    function _closeOptionHtml(value, current) {
        return `
            <label style="display:flex; gap:10px; align-items:flex-start; padding:6px 0; cursor:pointer;">
                <input type="radio" name="dt-close" value="${value}" ${current === value ? "checked" : ""}
                       style="margin-top:3px; accent-color:#9a8866; cursor:pointer;" />
                <span style="min-width:0;">
                    <span style="display:block; font-size:13px; font-weight:700; color:#ddd;">${t(_CLOSE_NAME_KEY[value])}</span>
                    <span style="display:block; font-size:12px; color:#888; margin-top:2px; line-height:1.45;">${t(_CLOSE_DESC_KEY[value])}</span>
                </span>
            </label>`;
    }

    /* Used by window-controls.js's close-choice modal to persist the
       "remember my choice" checkbox - shares this module's _postSetting
       so both places write the same close_action key the same way. */
    async function setCloseAction(action) {
        try { await _postSetting({ close_action: action }); } catch { /* best-effort - worst case the modal just asks again next time */ }
    }

    function _renderBody(body, info, syncStatus) {
        const settings = info.settings || {};

        body.innerHTML = `
            <div class="modal-section" style="gap:2px;">
                <div class="modal-label">${t("dt.sectionCommunity")}</div>
                ${_modeOptionHtml("connected", settings.community_mode)}
                ${_modeOptionHtml("local",     settings.community_mode)}
                <div id="dt-mode-status" style="display:none; font-size:12px; align-items:center; gap:8px; margin-top:4px;">
                    <span id="dt-mode-status-text">${t("dt.modeChanged")}</span>
                    <button class="modal-btn primary" id="dt-mode-reload-btn" style="font-size:11px;">${t("dt.reloadNow")}</button>
                </div>
            </div>

            <hr class="modal-divider">

            <div class="modal-section" style="gap:2px;">
                <div class="modal-label">${t("dt.sectionClose")}</div>
                ${_closeOptionHtml("tray", settings.close_action)}
                ${_closeOptionHtml("exit", settings.close_action)}
                <span id="dt-close-status" style="font-size:11px; color:#7ba05b;"></span>
            </div>

            <hr class="modal-divider">

            <div class="modal-section" style="gap:6px;">
                <div class="modal-label">${t("dt.sectionUpdates")}</div>
                <select id="dt-src-select">
                    <option value="auto">${escapeHtml(t("dt.srcAuto"))}</option>
                    <option value="gitee">Gitee</option>
                    <option value="github">GitHub</option>
                </select>
                <div style="font-size:11px; color:#666;">${t("dt.updateSourceHint")} <span id="dt-src-status" style="color:#7ba05b;"></span></div>
                <div id="dt-update-progress" style="display:none; margin-top:2px;"></div>
            </div>

            <hr class="modal-divider">

            <div class="modal-section" style="gap:6px;">
                <div class="modal-label">${t("dt.sectionData")}</div>
                <div id="dt-sync-line" style="font-size:12px; color:#888;">${t("dt.lastSynced")}${escapeHtml(_fmtSyncTime(syncStatus && syncStatus.last_synced_at))}</div>
                <button id="dt-sync-btn" class="modal-btn full-width">${t("dt.syncNow")}</button>
                <div id="dt-sync-status" style="font-size:12px; display:none;"></div>
            </div>

            <hr class="modal-divider">

            ${EFTForge.season?.current ? `
            <div id="dt-season-toggle"></div>

            <hr class="modal-divider">
            ` : ""}

            <div class="modal-section" style="gap:6px;">
                <div class="modal-label">${t("perf.section")}</div>
                <div class="hidden-stats-grid" id="dt-perf-body"></div>
            </div>

            <hr class="modal-divider">

            <div style="font-size:11px; color:#555; line-height:1.7; word-break:break-all;">
                ${t("dt.appVersion")}${escapeHtml(EFTForge.config.APP_VERSION)}<br>
                ${t("dt.dataDir")}${escapeHtml(info.data_dir || "?")}
            </div>
        `;

        // --- seasonal theme toggle: only drawn while a season runs ---
        EFTForge.season?.mountSetting(body.querySelector("#dt-season-toggle"));

        // --- performance metrics: 1s refresh, only while this modal is open ---
        EFTForge.perfMetrics.mount(body.querySelector("#dt-perf-body"), body.closest(".modal-overlay"));

        // --- community mode ---
        // Picking a radio only stages the choice in the UI - it is NOT sent to
        // the backend until "Reload Now" is clicked. The running page (and the
        // backend's own in-memory behavior) only actually switches mode on that
        // reload, so persisting on every radio click let the settings file say
        // one thing while the app kept running in the old mode - reopening this
        // modal without ever reloading showed the newly *picked* mode as if it
        // were already in effect. Only committing on "Reload Now" keeps the
        // saved setting matched to what's actually running at all times.
        const originalMode = settings.community_mode;
        const modeStatus = body.querySelector("#dt-mode-status");
        const modeStatusText = body.querySelector("#dt-mode-status-text");
        const modeReloadBtn = body.querySelector("#dt-mode-reload-btn");
        body.querySelectorAll('input[name="dt-mode"]').forEach(input => {
            input.addEventListener("change", () => {
                if (input.value === originalMode) {
                    modeStatus.style.display = "none";
                    return;
                }
                modeStatusText.style.color = "#c9a53c";
                modeStatusText.textContent = t("dt.modeChanged");
                modeStatus.style.display = "flex";
            });
        });
        modeReloadBtn.addEventListener("click", async () => {
            const selected = body.querySelector('input[name="dt-mode"]:checked');
            if (!selected) return;
            modeReloadBtn.disabled = true;
            try {
                await _postSetting({ community_mode: selected.value });
                window.location.reload();
            } catch (e) {
                modeReloadBtn.disabled = false;
                modeStatusText.style.color = "#f44336";
                modeStatusText.textContent = String(e);
            }
        });

        // --- close behavior ---
        const closeStatus = body.querySelector("#dt-close-status");
        body.querySelectorAll('input[name="dt-close"]').forEach(input => {
            input.addEventListener("change", async () => {
                try {
                    await _postSetting({ close_action: input.value });
                    closeStatus.textContent = "✓";
                    setTimeout(() => { closeStatus.textContent = ""; }, 1500);
                } catch (e) {
                    closeStatus.style.color = "#f44336";
                    closeStatus.textContent = String(e);
                }
            });
        });

        // --- app update download progress (if one is running right now) ---
        _renderUpdateProgress(body.querySelector("#dt-update-progress"));

        // --- update source ---
        const srcSelect = body.querySelector("#dt-src-select");
        const srcStatus = body.querySelector("#dt-src-status");
        srcSelect.value = settings.update_source || "auto";
        // Site-wide custom dropdown UI (app.js); hides the native select.
        if (typeof setupCustomSelect === "function") setupCustomSelect("dt-src-select");
        srcSelect.addEventListener("change", async () => {
            try {
                await _postSetting({ update_source: srcSelect.value });
                srcStatus.textContent = "✓";
                setTimeout(() => { srcStatus.textContent = ""; }, 1500);
            } catch (e) {
                srcStatus.style.color = "#f44336";
                srcStatus.textContent = String(e);
            }
        });

        // --- item data sync ---
        const syncLine   = body.querySelector("#dt-sync-line");
        const syncBtn    = body.querySelector("#dt-sync-btn");
        const syncStatEl = body.querySelector("#dt-sync-status");

        const _pollSync = () => {
            if (_syncPollTimer) clearInterval(_syncPollTimer);
            _syncPollTimer = setInterval(async () => {
                try {
                    const res = await fetch(`${_base()}/desktop/sync-status`, { cache: "no-store" });
                    const status = await res.json();
                    if (status.running) return;
                    clearInterval(_syncPollTimer);
                    _syncPollTimer = null;
                    syncBtn.disabled = false;
                    syncLine.textContent = t("dt.lastSynced") + _fmtSyncTime(status.last_synced_at);
                    syncStatEl.style.display = "";
                    if (status.error) {
                        syncStatEl.style.color = "#f44336";
                        syncStatEl.textContent = t("dt.syncError") + status.error;
                    } else if (status.changed) {
                        syncStatEl.style.color = "#c9a53c";
                        syncStatEl.innerHTML = `${t("dt.syncChanged")} <button class="modal-btn primary" style="font-size:11px;" onclick="window.location.reload()">${t("dt.reloadNow")}</button>`;
                    } else {
                        syncStatEl.style.color = "#7ba05b";
                        syncStatEl.textContent = t("dt.syncUnchanged");
                    }
                } catch { /* backend briefly busy - keep polling */ }
            }, 2000);
        };

        syncBtn.addEventListener("click", async () => {
            syncBtn.disabled = true;
            syncStatEl.style.display = "";
            syncStatEl.style.color = "#888";
            syncStatEl.textContent = t("dt.syncRunning");
            try {
                await fetch(`${_base()}/desktop/sync`, { method: "POST" });
                _pollSync();
            } catch (e) {
                syncBtn.disabled = false;
                syncStatEl.style.color = "#f44336";
                syncStatEl.textContent = t("dt.syncError") + String(e);
            }
        });

        if (syncStatus && syncStatus.running) {
            syncBtn.disabled = true;
            syncStatEl.style.display = "";
            syncStatEl.style.color = "#888";
            syncStatEl.textContent = t("dt.syncRunning");
            _pollSync();
        }
    }

    /* ---------------- bootstrap ---------------- */

    function _init() {
        // Local mode: leaderboards and the community profile are community
        // features - remove their header entry points entirely.
        if (EFTForge.config && EFTForge.config.COMMUNITY_DISABLED) {
            ["leaderboard-btn", "profile-nav-btn"].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = "none";
            });
        }

        const nav = document.querySelector(".header-nav");
        if (!nav) return;
        const btn = document.createElement("button");
        btn.id = "desktop-settings-btn";
        btn.className = "header-nav-btn";
        btn.addEventListener("click", showPanel);
        btn.innerHTML =
            '<span class="header-nav-btn-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
            '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/>' +
            '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
            '</svg></span>' +
            '<span class="header-nav-btn-label"></span>';
        btn.querySelector(".header-nav-btn-label").textContent = t("dt.navLabel");

        const profileBtn = document.getElementById("profile-nav-btn");
        if (profileBtn) nav.insertBefore(btn, profileBtn);
        else nav.appendChild(btn);

        _initUpdateEvents();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _init);
    } else {
        _init();
    }

    window.EFTForge.desktopSettings = { showPanel, goOnline, setCloseAction };
})();
