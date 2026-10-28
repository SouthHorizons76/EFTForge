window.EFTForge = window.EFTForge || {};

/* exported resetBuild, stripBuild, showDiscardChangesModal, _confirmDeleteBuild, showSaveBuildDialog,
   _confirmDeleteSavePanelBuild, showBuildsDialog, showGunBuildsDialog, _loadSavedBuildById,
   _copySavedBuildById, _tryRepublishBuild, importBuildFromCode, exportBuildsBackup, importBuildsFromFile,
   pasteImportCode, _buildTrueErgo, _currentBuildTags -- called from other modules or index.html attributes */

/* ============================================================
   BUILD MANAGER
   Save, Reset, and Share build functionality.
   Accesses globals defined in app.js (EFTForge.state.buildTree, EFTForge.state.currentGun, etc.)
============================================================ */

const _communityCountCache = {}; // gunId -> number, populated after first fetch

// Build tags state
let _pendingBuildTags = [];           // tags being edited in the current save dialog
const _activeTagFilters = new Set();  // currently active tag filter chips (saved builds list)
let _buildsListGunId = null;          // gunId context for the active builds list

// A published build's TrueErgoDelta. Builds published before it stored only the old EED,
// so I work theirs out from the weight and ergo they saved (no equipment modifier, which
// those builds never recorded).
function _buildTrueErgo(stats) {
    if (!stats) return null;
    if (stats.true_ergo_delta != null) return parseFloat(stats.true_ergo_delta);
    if (stats.weight != null && stats.ergo != null) return calcTrueErgoDelta(parseFloat(stats.ergo), parseFloat(stats.weight));
    return null;
}

function _tagChipsHtml(tags) {
    if (!tags || tags.length === 0) return "";
    const { t } = EFTForge.lang;
    const chips = tags.map(tag => `<span class="build-tag-chip" data-tag="${escapeHtml(tag)}">${escapeHtml(t("tag." + tag))}</span>`).join("");
    return `<div style="display:flex;flex-wrap:wrap;gap:4px;justify-content:center;margin-bottom:10px;">${chips}</div>`;
}

function _currentBuildTags() {
    const gun = EFTForge.state.currentGun;
    if (!gun) return [];
    const currentKey = _pairsKey(collectSlotPairs(EFTForge.state.buildTree));
    const { builds } = loadSavedBuilds();
    const match = builds.find(b => {
        if (b.gunId !== gun.id) return false;
        const payload = decodeBuildCode(b.code);
        return payload && _pairsKey(payload.p) === currentKey;
    });
    return match?.tags ?? [];
}

async function updateGunBuildsBadge(gunId) {
    if (!gunId) return;
    const btn = document.getElementById("gun-builds-btn");
    if (!btn) return;

    const { builds } = loadSavedBuilds();
    const savedCount = builds.filter(b => b.gunId === gunId).length;
    const cachedCommunity = _communityCountCache[gunId] ?? null;

    const _applyBadge = (community) => {
        const total = savedCount + (community ?? 0);
        btn.dataset.badge = total > 0 ? String(total) : "";
    };

    // Apply immediately with whatever we have cached
    _applyBadge(cachedCommunity);

    // Desktop local mode: community features are off - badge counts saved builds only
    if (EFTForge.config.COMMUNITY_DISABLED) return;

    // Fetch community count if not yet cached
    if (cachedCommunity === null) {
        try {
            const publicBuilds = await EFTForge.api.fetchPublicBuilds(gunId);
            const count = Array.isArray(publicBuilds) ? publicBuilds.length : 0;
            _communityCountCache[gunId] = count;
            if (EFTForge.state.currentGun?.id === gunId) {
                const b = document.getElementById("gun-builds-btn");
                if (b) _applyBadge(count);
            }
        } catch (_) {
            _communityCountCache[gunId] = 0;
        }
    }
}

async function resetBuild() {
    if (!EFTForge.state.currentGun) return;

    // Reset tree to gun root only, then reapply the server-resolved factory tree.
    // Using the stored factoryTree (from selectGun) guarantees the same slot IDs and
    // nesting structure that the server computed - avoids the client-side ordering bugs
    // in installFactoryAttachment when multiple items share the same slot type.
    EFTForge.state.buildTree = { item: EFTForge.state.currentGun, children: {} };
    if (EFTForge.state.factoryTree) {
        _applyTree(EFTForge.state.buildTree, EFTForge.state.factoryTree);
    }

    // Clear UI state
    EFTForge.state.lastParentNode = null;
    EFTForge.state.lastSlot = null;
    EFTForge.state.lastProcessedItems = [];
    EFTForge.state.processedCache = {};
    EFTForge.state.collapsedSlots = {};

    // Close attachment selector table, restore placeholder
    document.getElementById("attachment-placeholder").style.display = "";
    document.getElementById("attachment-table-container").innerHTML = "";
    document.querySelectorAll(".tree-slot.active-slot")
        .forEach(el => el.classList.remove("active-slot"));
    closeMobileRightPanel();

    await renderFullTree(false);
    await refreshBuildStats();
    flashTree("reset");
    const { t: _t } = EFTForge.lang;
    replaceToast("build-reset-strip", _t("toast.resetTitle"), _t("toast.resetMsg"), 2500, "#4CAF50");
}

async function stripBuild() {
    if (!EFTForge.state.currentGun) return;

    // Reset tree to gun root only, no factory attachments
    EFTForge.state.buildTree = { item: EFTForge.state.currentGun, children: {} };

    // Clear UI state
    EFTForge.state.lastParentNode = null;
    EFTForge.state.lastSlot = null;
    EFTForge.state.lastProcessedItems = [];
    EFTForge.state.processedCache = {};
    EFTForge.state.collapsedSlots = {};

    // Close attachment selector table, restore placeholder
    document.getElementById("attachment-placeholder").style.display = "";
    document.getElementById("attachment-table-container").innerHTML = "";
    document.querySelectorAll(".tree-slot.active-slot")
        .forEach(el => el.classList.remove("active-slot"));
    closeMobileRightPanel();

    await renderFullTree(false);
    await refreshBuildStats();
    flashTree("strip");
    const { t: _t2 } = EFTForge.lang;
    replaceToast("build-reset-strip", _t2("toast.strippedTitle"), _t2("toast.strippedMsg"), 2500, "#f5a623");
}


// Update gun-display-name to match a saved build name if the current build
// matches one, otherwise fall back to the gun's own name
function syncBuildDisplayName() {
    const gun = EFTForge.state.currentGun;
    const el = document.getElementById("gun-display-name");
    if (!el || !gun) return;

    const currentKey = _pairsKey(collectSlotPairs(EFTForge.state.buildTree));

    // Community build display: show author + build name while the attachment set matches.
    // Once the user changes anything, clear it and never re-apply.
    if (EFTForge.state.communityBuild) {
        if (currentKey === EFTForge.state.communityBuild.pairsKey) {
            const { authorName, avatarUrl, buildName, cardImageUrl } = EFTForge.state.communityBuild;
            const avatarSrc = proxyAvatarUrl(avatarUrl) || "./assets/images/tarkovcitizen.jpg";
            const avatarHtml = `<img src="${escapeHtml(avatarSrc)}"
                        style="width:20px;height:20px;border-radius:50%;object-fit:cover;background:#2a2a2a;flex-shrink:0;"
                        onerror="this.src='./assets/images/tarkovcitizen.jpg';this.onerror=null;" />`;
            el.innerHTML = `
                <div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:2px;">
                    ${avatarHtml}
                    <span style="font-size:14px;font-weight:400;color:#aaa;">${escapeHtml(authorName)}'s</span>
                </div>
                <div>${escapeHtml(buildName)}</div>
            `;
            if (cardImageUrl) {
                const gunImg = /** @type {HTMLImageElement | null} */ (document.getElementById("gun-display-image"));
                if (gunImg) {
                    gunImg.src = cardImageUrl;
                    gunImg.style.display = "";
                    gunImg.referrerPolicy = "no-referrer";
                }
            }
            // Re-run now that communityBuild is authoritatively set - cancels/overrides any
            // generation scheduleBuildPreview() may have already kicked off from the render
            // that happened before this function got a chance to populate communityBuild.
            window.scheduleBuildPreview?.();
            EFTForge.tabs?.syncActiveTab({ buildName, communityBuild: EFTForge.state.communityBuild });
            // skip snapshot persistence for community builds
            return;
        }
        // User changed attachments - clear community build state and revert placeholder image
        const gunImg = /** @type {HTMLImageElement | null} */ (document.getElementById("gun-display-image"));
        if (gunImg) {
            const defaultSrc = gun.image_512_link || gun.icon_link || "";
            gunImg.src = defaultSrc;
            gunImg.referrerPolicy = "";
            if (!defaultSrc) gunImg.style.display = "none";
        }
        EFTForge.state.communityBuild = null;
    }

    const { builds } = loadSavedBuilds();
    const match = builds.find(b => {
        if (b.gunId !== gun.id) return false;
        const payload = decodeBuildCode(b.code);
        return payload && _pairsKey(payload.p) === currentKey;
    });

    const displayName = match ? match.name : gun.name;
    el.textContent = displayName;

    const tagsEl = document.getElementById("build-display-tags");
    if (tagsEl) tagsEl.innerHTML = _tagChipsHtml(match?.tags ?? []);

    EFTForge.tabs?.syncActiveTab({ buildName: match ? match.name : null, communityBuild: null });

    // Mobile-only: persist a session snapshot so a page refresh can offer to restore
    // this state. Desktop persists via the tab strip (eftforge_tabs_v1) instead.
    if (document.body.dataset.mobile === "true") {
        // Skip factory config - nothing worth restoring.
        const isFactory = currentKey === EFTForge.state.factoryPairsKey;
        if (!isFactory) {
            try {
                localStorage.setItem("eftforge_session_snapshot", JSON.stringify({
                    gunId:     gun.id,
                    code:      encodeBuild(),
                    gunName:   displayName,
                    gunImage:  gun.image_512_link || gun.icon_link || null,
                    buildName: match ? match.name : null,
                }));
            } catch (_) {}
        } else {
            clearSessionSnapshot();
        }
    }
}

function clearSessionSnapshot() {
    try { localStorage.removeItem("eftforge_session_snapshot"); } catch (_) {}
}

function showDiscardChangesModal(snapshot, onDiscard) {
    const { t } = EFTForge.lang;
    const modalImg = window._bpGetLastImageUrl?.() || snapshot.gunImage;
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
        <div class="modal-window" style="max-width:340px; text-align:center;">
            <div class="modal-header">
                <span class="modal-title">${escapeHtml(t("modal.discardTitle"))}</span>
            </div>
            <div class="modal-body" style="flex-direction:column; align-items:center; gap:12px;">
                ${modalImg
                    ? `<img src="${escapeHtml(modalImg)}" style="max-height:100px; max-width:100%; object-fit:contain;" />`
                    : ""}
                <div style="font-size:16px; font-weight:700; color:#f5c542;">${escapeHtml(snapshot.gunName)}</div>
                <div style="font-size:12px; color:#888;">${escapeHtml(t("modal.discardSubtitle"))}</div>
                <div class="modal-row" style="width:100%; margin-top:4px;">
                    <button class="modal-btn full-width" id="discard-confirm-btn" style="border-color:#c0392b; color:#e74c3c;">${escapeHtml(t("modal.discardConfirm"))}</button>
                    <button class="modal-btn full-width" id="discard-cancel-btn">${escapeHtml(t("modal.discardCancel"))}</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const dismiss = () => overlay.remove();
    let _mdOnBackdrop = false;
    overlay.addEventListener("mousedown", e => { _mdOnBackdrop = e.target === overlay; });
    overlay.addEventListener("click", e => { if (e.target === overlay && _mdOnBackdrop) dismiss(); });
    overlay.querySelector("#discard-cancel-btn").addEventListener("click", dismiss);
    overlay.querySelector("#discard-confirm-btn").addEventListener("click", () => {
        clearSessionSnapshot();
        overlay.remove();
        onDiscard();
    });
}


// Encode current build with the smallest supported dictionary format.
function encodeBuild() {
    const payload = { v: 1, g: EFTForge.state.currentGun.id, p: collectSlotPairs(EFTForge.state.buildTree) };
    const ammoId = /** @type {HTMLSelectElement | null} */ (document.getElementById("ammo-select"))?.value;
    const ubglAmmoId = /** @type {HTMLSelectElement | null} */ (document.getElementById("ubgl-ammo-select"))?.value;
    if (ammoId) payload.a = ammoId;
    if (ubglAmmoId) payload.ua = ubglAmmoId;
    return encodeBuildCode(payload);
}

// Apply a saved ammo ID to the ammo-select after a build is loaded.
// Only sets if the option exists in the current caliber's list.
function _applyPayloadAmmo(ammoId) {
    if (!ammoId) return;
    const sel = /** @type {HTMLSelectElement | null} */ (document.getElementById("ammo-select"));
    if (!sel) return;
    if (!Array.from(sel.options).some(o => o.value === ammoId)) return;
    sel.value = ammoId;
    // Sync pref so the custom dropdown label updates
    const caliber = EFTForge.state.currentGun?.caliber;
    if (caliber) {
        const prefs = JSON.parse(localStorage.getItem("eftforge_ammo_prefs") || "{}");
        prefs[caliber] = ammoId;
        localStorage.setItem("eftforge_ammo_prefs", JSON.stringify(prefs));
    }
    sel.dispatchEvent(new Event("input"));
}

// Apply a saved UBGL ammo ID to ubgl-ammo-select after a build is loaded.
function _applyPayloadUbglAmmo(ubglAmmoId) {
    if (!ubglAmmoId) return;
    const sel = /** @type {HTMLSelectElement | null} */ (document.getElementById("ubgl-ammo-select"));
    if (!sel) return;
    if (!Array.from(sel.options).some(o => o.value === ubglAmmoId)) return;
    sel.value = ubglAmmoId;
    const ubglItem = detectInstalledUbgl();
    if (ubglItem?.caliber) {
        const prefs = JSON.parse(localStorage.getItem("eftforge_ubgl_ammo_prefs") || "{}");
        prefs[ubglItem.caliber] = ubglAmmoId;
        localStorage.setItem("eftforge_ubgl_ammo_prefs", JSON.stringify(prefs));
    }
    sel.dispatchEvent(new Event("input"));
}


/* ===========================
   LOCAL STORAGE
=========================== */

function loadSavedBuilds() {
    try {
        const raw = localStorage.getItem("eftforge_builds");
        if (!raw) return { version: 1, builds: [] };
        const data = JSON.parse(raw);
        if (data.version !== 1 || !Array.isArray(data.builds)) {
            return { version: 1, builds: [] };
        }
        return data;
    } catch {
        return { version: 1, builds: [] };
    }
}

function persistSavedBuilds(data) {
    try {
        localStorage.setItem("eftforge_builds", JSON.stringify(data));
    } catch (e) {
        if (e.name === "QuotaExceededError") {
            showToast(t("toast.storageFull"), t("toast.storageFullMsg"), 4000);
        }
    }
    if (EFTForge.state.currentGun) updateGunBuildsBadge(EFTForge.state.currentGun.id);
}

function saveCurrentBuild(name, overwrite = false, tags = null) {
    if (!EFTForge.state.currentGun || !EFTForge.state.buildTree) return;
    const trimmed = (name || "").trim().slice(0, 60);
    if (!trimmed) {
        showToast(t("toast.saveFailed"), t("toast.saveFailedMsg"), 2500);
        return;
    }
    const finalTags = (tags ?? _pendingBuildTags).slice(0, 5);
    const data = loadSavedBuilds();
    const duplicate = data.builds.find(
        b => b.gunId === EFTForge.state.currentGun.id && b.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (duplicate && !overwrite) {
        _renderOverwriteConfirmation(trimmed);
        return;
    }
    const code = encodeBuild();
    if (duplicate && overwrite) {
        duplicate.code = code;
        duplicate.savedAt = Date.now();
        duplicate.tags = finalTags;
    } else {
        data.builds.unshift({
            id: Date.now().toString(36),
            name: trimmed,
            gunId: EFTForge.state.currentGun.id,
            gunName: EFTForge.state.currentGun.name,
            savedAt: Date.now(),
            tags: finalTags,
            code
        });
        if (data.builds.length > 500) data.builds = data.builds.slice(0, 500);
    }
    persistSavedBuilds(data);
    syncBuildDisplayName();
    const dlg = document.getElementById("save-build-dialog");
    if (dlg) dlg.remove();
    const { t: _tSave } = EFTForge.lang;
    showToast(_tSave("toast.savedTitle"), `"${escapeHtml(trimmed)}" ${_tSave("toast.savedMsg")}`, 2500, "#4CAF50");
    renderSavedBuildsList();
}

function deleteSavedBuild(id, gunId = null) {
    const data = loadSavedBuilds();
    const entry = data.builds.find(b => b.id === id);
    const publishedServerId = entry?.publishedId ?? null;

    data.builds = data.builds.filter(b => b.id !== id);
    persistSavedBuilds(data);
    syncBuildDisplayName();

    // The beta never unlists: the live copy stays published and still marked as ours
    if (publishedServerId && !EFTForge.config.COMMUNITY_READ_ONLY) {
        const published = new Set(JSON.parse(localStorage.getItem("eftforge_published_ids") || "[]"));
        published.delete(id);
        localStorage.setItem("eftforge_published_ids", JSON.stringify([...published]));
        EFTForge.api.unlistBuild(publishedServerId).catch(() => {});
    }

    renderSavedBuildsList("", gunId);
}

function _showDeletePublishedConfirm(id, gunId = null) {
    const { t } = EFTForge.lang;
    const overlay = _createModalOverlay("delete-published-confirm", t("modal.deletePublishedTitle"), {
        closeId: "del-pub-close",
        bodyId:  "del-pub-body",
    });
    if (!overlay) return;

    document.getElementById("del-pub-body").innerHTML = `
        <div class="modal-section">
            <p style="color:#ccc; font-size:14px; margin:0 0 16px 0; line-height:1.5;">${t("modal.deletePublishedBody")}</p>
            <div class="modal-row">
                <button class="modal-btn full-width" id="del-pub-cancel">${t("modal.cancel")}</button>
                <button class="modal-btn full-width" id="del-pub-confirm"
                        style="border-color:#f44336; color:#f44336;">${t("modal.deleteAndUnlist")}</button>
            </div>
        </div>
    `;

    document.getElementById("del-pub-cancel").addEventListener("click", () => overlay.remove());
    document.getElementById("del-pub-confirm").addEventListener("click", () => {
        overlay.remove();
        deleteSavedBuild(id, gunId);
        if (gunId) _renderSavePanelBuilds(gunId);
    });
}

function _confirmDeleteBuild(btn, id, gunId) {
    if (btn.dataset.confirming === "1") {
        const { builds } = loadSavedBuilds();
        const entry = builds.find(b => b.id === id);
        // Local mode can't manage published builds - delete locally only,
        // the community copy stays untouched until the user reconnects.
        if (entry?.publishedId && !EFTForge.config.COMMUNITY_DISABLED && !EFTForge.config.COMMUNITY_READ_ONLY) {
            _showDeletePublishedConfirm(id, gunId || null);
            return;
        }
        deleteSavedBuild(id, gunId || null);
        return;
    }

    btn.dataset.confirming = "1";
    btn.textContent = t("ui.confirm");
    btn.style.background = "#3d0f0f";
    btn.style.color = "#eee";
    btn.style.borderColor = "#f44336";

    const revert = () => {
        btn.dataset.confirming = "";
        btn.innerHTML = "&#x2715;";
        btn.style.background = "";
        btn.style.color = "";
        btn.style.borderColor = "";
        btn.removeEventListener("mouseleave", revert);
    };
    btn.addEventListener("mouseleave", revert);
}

async function _copyToClipboard(text, messageKey) {
    const { t } = EFTForge.lang;
    try {
        await navigator.clipboard.writeText(text);
        showToast(t("modal.copied"), t(messageKey), 2000, "#4CAF50");
    } catch {
        showToast(t("toast.copyFailed"), t("toast.clipboardFailed"), 3000);
    }
}

async function copyBuildCode(code) {
    await _copyToClipboard(code, "toast.codeCopiedMsg");
}

// The desktop app runs on a localhost origin nobody else can open, so its
// links point at the live site. The web keeps its own origin so local dev and
// mirrors link back to themselves.
function buildShareLink(code) {
    const base = EFTForge.config.IS_DESKTOP
        ? "https://eftforge.com/"
        : window.location.origin + window.location.pathname;
    return `${base}?build=${encodeURIComponent(code)}`;
}

async function copyBuildLink(code) {
    await _copyToClipboard(buildShareLink(code), "toast.linkCopiedMsg");
}

/* ===========================
   UI - SAVE DIALOG
=========================== */

function showSaveBuildDialog() {
    if (!EFTForge.state.currentGun) return;
    const overlay = _createModalOverlay("save-build-dialog", t("modal.saveAndShare"), {
        closeId:  "modal-close-x",
        bodyId:   "save-build-modal-body",
        maxWidth: "560px",
    });
    if (!overlay) return;
    _renderSaveBuildBody(EFTForge.state.currentGun.name);
}

const BUILD_TAG_PRESETS = ["meta", "budget", "cqb", "sniper", "recoil", "ergo", "pve", "beginner", "hybrid"];

function _renderPresetTagChips(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const { t } = EFTForge.lang;
    container.innerHTML = BUILD_TAG_PRESETS.map(key => {
        const active = _pendingBuildTags.includes(key);
        return `<button class="build-tag-chip${active ? ' active' : ''}" data-tag="${key}" onclick="_togglePendingTag('${key}')">${escapeHtml(t("tag." + key))}</button>`;
    }).join("");
}

function _togglePendingTag(key) {
    const idx = _pendingBuildTags.indexOf(key);
    if (idx >= 0) _pendingBuildTags.splice(idx, 1);
    else if (_pendingBuildTags.length < 5) _pendingBuildTags.push(key);
    _renderPresetTagChips("tag-chips-container");
}
window._togglePendingTag = _togglePendingTag;

function _renderSaveBuildBody(prefill, existingTags = null) {
    const body = document.getElementById("save-build-modal-body");
    if (!body || !EFTForge.state.currentGun) return;
    const { t } = EFTForge.lang;

    _pendingBuildTags = existingTags ? existingTags.slice() : [];

    const gun = EFTForge.state.currentGun;
    body.innerHTML = `
        <div class="modal-section">
            <div class="modal-label">${t("modal.save")}</div>
            <div class="modal-row">
                <input id="save-build-name" type="text" class="search-input"
                       style="font-size: 13px; margin:0; flex:1; min-width:0;"
                       placeholder="${escapeHtml(t("modal.saveName"))}"
                       maxlength="60"
                       value="${escapeHtml(prefill ?? gun.name)}" />
                <button class="modal-btn primary" id="modal-save-btn">${t("modal.saveBtn")}</button>
            </div>
            <div class="build-tag-input-row" id="tag-input-row">
                <div id="tag-chips-container" class="build-tag-chips-edit"></div>
            </div>
        </div>

        <hr class="modal-divider" />

        <div class="modal-section">
            <div class="modal-label">${t("modal.share")}</div>
            <div class="modal-row">
                <button class="modal-btn full-width" id="modal-copy-btn">${t("modal.copyBtn")}</button>
                <button class="modal-btn full-width" id="modal-copy-link-btn">${t("modal.copyLinkBtn")}</button>
            </div>
        </div>

        <hr class="modal-divider" />

        <div class="modal-section">
            <div class="modal-label" style="display:flex; align-items:center; gap:6px;">
                ${t("modal.myBuilds")} <span style="color:#f5c542; font-weight:700;">${escapeHtml(gun.name)}</span>
            </div>
            ${EFTForge.config.COMMUNITY_DISABLED ? "" : `<div style="font-size:12px; color:#555; margin-bottom:8px;">${t(isMobileLayout() ? "modal.publishHintMobile" : "modal.publishHint")}</div>`}
            <div id="save-panel-builds-list" style="max-height:220px; overflow-y:auto; scrollbar-width:thin; scrollbar-color:#444 #111;"></div>
        </div>
    `;

    const input = /** @type {HTMLInputElement | null} */ (document.getElementById("save-build-name"));
    input.focus();
    input.select();

    _renderPresetTagChips("tag-chips-container");

    document.getElementById("modal-save-btn").addEventListener("click", () => {
        saveCurrentBuild(input.value);
    });

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            saveCurrentBuild(input.value);
        }
    });

    const wireCopyButton = (id, labelKey, copy) => {
        const btn = document.getElementById(id);
        btn.addEventListener("click", async () => {
            const { t: _tc } = EFTForge.lang;
            await copy(encodeBuild());
            btn.textContent = _tc("modal.copied");
            setTimeout(() => { btn.textContent = _tc(labelKey); }, 2000);
        });
    };
    wireCopyButton("modal-copy-btn", "modal.copyBtn", copyBuildCode);
    wireCopyButton("modal-copy-link-btn", "modal.copyLinkBtn", copyBuildLink);

    _renderSavePanelBuilds(gun.id);
}

function _renderOverwriteConfirmation(name) {
    const body = document.getElementById("save-build-modal-body");
    if (!body) return;

    body.innerHTML = `
        <div class="modal-section">
            <div style="font-size:14px; line-height:1.6; margin-bottom:14px;">
                <strong style="color:#eee;">"${escapeHtml(name)}"</strong>
                <span style="color:#aaa;">${t("modal.alreadyExists")}</span><br>
                <span style="color:#777; font-size:13px;">${t("modal.overwriteConfirm")}</span>
            </div>
            <div class="modal-row">
                <button class="modal-btn full-width" id="overwrite-cancel-btn">${t("ui.cancel")}</button>
                <button class="modal-btn primary full-width" id="overwrite-confirm-btn">${t("ui.overwrite")}</button>
            </div>
        </div>
    `;

    document.getElementById("overwrite-confirm-btn").addEventListener("click", () => {
        saveCurrentBuild(name, true);
    });

    document.getElementById("overwrite-cancel-btn").addEventListener("click", () => {
        _renderSaveBuildBody(name);
    });
}

function _renderSavePanelBuilds(gunId) {
    const list = document.getElementById("save-panel-builds-list");
    if (!list) return;
    const { t } = EFTForge.lang;
    const { builds } = loadSavedBuilds();
    const pool = builds.filter(b => b.gunId === gunId);
    const publishedIds = new Set(JSON.parse(localStorage.getItem("eftforge_published_ids") || "[]"));

    if (pool.length === 0) {
        list.innerHTML = `<div style="color:#555; font-size:13px; font-style:italic; padding:4px 0 2px 0;">${t("modal.noBuilds")}</div>`;
        return;
    }

    list.innerHTML = pool.map(entry => {
        const safeId = escapeHtml(entry.id);
        const isPublished = publishedIds.has(entry.id);
        const publishBtnHtml = EFTForge.config.COMMUNITY_DISABLED
            ? ""
            : isPublished
            ? `<button class="saved-build-btn publish-btn"
                       data-id="${safeId}"
                       style="opacity:0.4; cursor:default;"
                       onclick="_tryRepublishBuild(this.dataset.id)">${t("modal.publishedBtn")}</button>`
            : `<button class="saved-build-btn publish-btn"
                       data-id="${safeId}"
                       onclick="_publishSavedBuildById(this.dataset.id)">${t("modal.publishBtn")}</button>`;
        return `
            <div class="saved-build-card">
                <div class="saved-build-info">
                    <div class="saved-build-name"><span class="marquee-text">${escapeHtml(entry.name)}</span></div>
                </div>
                <div class="saved-build-actions">
                    <button class="saved-build-btn copy-btn"
                            data-id="${safeId}"
                            onclick="_copySavedBuildById(this.dataset.id)">${t("ui.copy")}</button>
                    ${publishBtnHtml}
                    <button class="saved-build-btn delete-btn"
                            data-id="${safeId}"
                            onclick="_confirmDeleteSavePanelBuild(this, this.dataset.id, '${escapeHtml(gunId)}')">&#x2715;</button>
                </div>
            </div>
        `;
    }).join("");

    _initMarqueeText(list);
}

function _confirmDeleteSavePanelBuild(btn, id, gunId) {
    if (btn.dataset.confirming === "1") {
        const { builds } = loadSavedBuilds();
        const entry = builds.find(b => b.id === id);
        if (entry?.publishedId && !EFTForge.config.COMMUNITY_DISABLED && !EFTForge.config.COMMUNITY_READ_ONLY) {
            _showDeletePublishedConfirm(id, gunId);
            return;
        }
        deleteSavedBuild(id);
        _renderSavePanelBuilds(gunId);
        return;
    }
    btn.dataset.confirming = "1";
    btn.textContent = t("ui.confirm");
    btn.style.background = "#3d0f0f";
    btn.style.color = "#eee";
    btn.style.borderColor = "#f44336";

    const reset = () => {
        if (btn.dataset.confirming !== "1") return;
        delete btn.dataset.confirming;
        btn.textContent = "\u2715";
        btn.style.background = "";
        btn.style.color = "";
        btn.style.borderColor = "";
    };
    setTimeout(reset, 3000);
    btn.addEventListener("mouseleave", reset, { once: true });
}

/* ===========================
   UI - BUILDS DIALOG
=========================== */

/* Desktop local mode: shown wherever community content would render.
   The connect button flips the app to connected mode and reloads. */
function _communityLocalPromptHtml() {
    const { t } = EFTForge.lang;
    return `
        <div style="display:flex; flex-direction:column; align-items:center; gap:12px;
                    padding:22px 16px; text-align:center;">
            <div style="color:#888; font-size:13px; line-height:1.6; max-width:420px;">${t("cb.localModeMsg")}</div>
            <button class="modal-btn primary" onclick="EFTForge.desktopSettings && EFTForge.desktopSettings.goOnline(this)">${t("cb.goOnlineBtn")}</button>
        </div>`;
}

function showBuildsDialog() {
    const { t } = EFTForge.lang;
    let _myCommunityLoaded = false;

    const overlay = _createModalOverlay("builds-dialog", t("modal.builds"), {
        closeId:  "builds-modal-close",
        bodyId:   "builds-dialog-body",
        maxWidth: "820px",
        tabs: [
            { id: "bm-tab-saves",     label: t("modal.tabMyBuilds") },
            { id: "bm-tab-community", label: t("modal.tabCommunity") },
        ],
        onTabSwitch(tabId) {
            if (tabId === "bm-tab-community" && !_myCommunityLoaded && !EFTForge.config.COMMUNITY_DISABLED) {
                _myCommunityLoaded = true;
                _loadMyCommunityBuilds();
            }
        },
    });
    if (!overlay) return;
    _updateNewCommentBadge();

    document.getElementById("bm-tab-saves").innerHTML = `
        <div class="modal-section">
            <div class="modal-label" style="display:flex; align-items:center; gap:6px;">
                ${t("modal.builds")} <span id="saved-builds-count" style="font-weight:400; letter-spacing:0; color:#555;"></span>
            </div>
            <input id="builds-search-input" type="text" class="search-input"
                   style="font-size: 13px; margin:0 0 8px 0; width:100%; box-sizing:border-box;"
                   placeholder="${escapeHtml(t("modal.searchBuilds"))}" />
            <div id="saved-builds-list"></div>
        </div>

        <hr class="modal-divider" />

        <div class="modal-section">
            <div class="modal-label">${t("modal.import")}</div>
            <div style="display:flex; gap:6px; align-items:center;">
                <input id="import-code-input" type="text" class="search-input"
                       style="margin:0; flex:1;"
                       placeholder="${escapeHtml(t("modal.pasteBuildCode"))}" />
                <button class="modal-btn" onclick="pasteImportCode()">${t("modal.pasteBtn")}</button>
                <button class="modal-btn primary"
                        onclick="importBuildFromCode(document.getElementById('import-code-input').value)">${t("modal.importBtn")}</button>
            </div>
        </div>

        <hr class="modal-divider" />

        <div class="modal-section">
            <div class="modal-label">${t("modal.backup")}</div>
            <div class="modal-row">
                <button class="modal-btn full-width" onclick="exportBuildsBackup()">${t("modal.exportBtn")}</button>
                <button class="modal-btn full-width" onclick="importBuildsFromFile()">${t("modal.importFile")}</button>
            </div>
        </div>
    `;

    document.getElementById("bm-tab-community").innerHTML = EFTForge.config.COMMUNITY_DISABLED
        ? _communityLocalPromptHtml()
        : `
        <div class="modal-section">
            <div style="display:flex; align-items:center; gap:6px; margin-bottom:8px;">
                <input id="my-community-search" type="text" class="search-input"
                       style="font-size:13px; margin:0; flex:1;"
                       placeholder="${escapeHtml(t("modal.searchBuilds"))}" />
                <span id="my-community-count" style="font-size:11px; color:#555; white-space:nowrap;"></span>
            </div>
            <div id="my-community-list">
                <div style="color:#555; font-size:13px; font-style:italic; padding:4px 0 2px 0;">${t("modal.myCommunityLoading")}</div>
            </div>
        </div>
    `;

    renderSavedBuildsList();

    const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById("builds-search-input"));
    searchInput.addEventListener("input", () => renderSavedBuildsList(searchInput.value));

    const myCommunitySearch = document.getElementById("my-community-search");
    if (myCommunitySearch) myCommunitySearch.addEventListener("input", _applyMyCommunityFilter);

    const modalWindow = /** @type {HTMLElement | null} */ (overlay.querySelector(".modal-window"));

    const dropHint = document.createElement("div");
    dropHint.style.cssText = `
        display:none; position:absolute; inset:0; border-radius:10px;
        background:rgba(0,0,0,0.6); pointer-events:none;
        align-items:center; justify-content:center;
        font-size:16px; font-weight:700; letter-spacing:0.05em;
        color:#f5c542;
    `;
    dropHint.textContent = t("modal.dropToImport");
    modalWindow.style.position = "relative";
    modalWindow.appendChild(dropHint);

    const showDrop = () => {
        modalWindow.style.outline = "2px solid #f5c542";
        modalWindow.style.outlineOffset = "-2px";
        dropHint.style.display = "flex";
    };
    const hideDrop = () => {
        modalWindow.style.outline = "";
        modalWindow.style.outlineOffset = "";
        dropHint.style.display = "none";
    };

    overlay.addEventListener("dragover", (e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        if (!document.getElementById("bm-tab-saves")?.classList.contains("active")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        showDrop();
    });
    overlay.addEventListener("dragleave", (e) => {
        if (!overlay.contains(/** @type {Node | null} */ (e.relatedTarget))) hideDrop();
    });
    overlay.addEventListener("drop", (e) => {
        e.preventDefault();
        hideDrop();
        const file = e.dataTransfer.files[0];
        if (!file) return;
        _processBackupFile(file);
    });
}

async function showGunBuildsDialog() {
    if (!EFTForge.state.currentGun) return;
    const { t } = EFTForge.lang;
    const gunId   = EFTForge.state.currentGun.id;
    const gunName = EFTForge.state.currentGun.name;

    _activeCbTagFilters.clear();

    const overlay = _createModalOverlay("builds-dialog", t("modal.exploreBuilds"), {
        closeId:  "builds-modal-close",
        bodyId:   "builds-dialog-body",
        maxWidth: "820px",
    });
    if (!overlay) return;

    document.getElementById("builds-dialog-body").innerHTML = `
        <div class="modal-section">
            <div class="modal-label" style="display:flex; align-items:center; gap:6px;">
                ${t("modal.myBuilds")} <span style="color:#f5c542; font-weight:700;">${escapeHtml(gunName)}</span> <span id="saved-builds-count" style="font-weight:400; letter-spacing:0; color:#555;"></span>
            </div>
            <input id="builds-search-input" type="text" class="search-input"
                   style="font-size:13px; margin:0 0 8px 0; width:100%; box-sizing:border-box;"
                   placeholder="${escapeHtml(t("modal.searchBuildsGun"))}" />
            <div id="saved-builds-list"></div>
        </div>
        <hr class="modal-divider" />
        <div class="modal-section">
            <div class="modal-label" style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                ${t("modal.communityBuilds")}<span class="cb-info-icon" data-tooltip="${escapeHtml(t("cb.infoTooltip"))}">?</span>
                <span style="color:#f5c542; font-weight:700;">${escapeHtml(gunName)}</span>
                <span id="public-builds-count" class="cb-count-label"></span>
            </div>
            ${EFTForge.config.COMMUNITY_DISABLED ? _communityLocalPromptHtml() : `
            <div class="cb-controls">
                <input id="cb-search-input" type="text" class="search-input cb-search-input"
                       placeholder="${escapeHtml(t("cb.searchPlaceholder"))}" />
                <select id="cb-sort-select" class="cb-sort-select">
                    <option value="default">${escapeHtml(t("cb.sort.default"))}</option>
                    <option value="newest">${escapeHtml(t("cb.sort.newest"))}</option>
                    <option value="loads">${escapeHtml(t("cb.sort.loads"))}</option>
                    <option value="rating">${escapeHtml(t("cb.sort.rating"))}</option>
                    <option value="true_ergo_delta">${escapeHtml(t("cb.sort.trueErgo"))}</option>
                    <option value="recoil">${escapeHtml(t("cb.sort.recoil"))}</option>
                    <option value="price">${escapeHtml(t("cb.sort.price"))}</option>
                </select>
            </div>
            <div id="cb-tag-filter-row" class="build-tag-filter-row" style="padding:4px 0; margin-bottom:4px; border-bottom:1px solid #222; display:flex; flex-wrap:wrap; gap:4px; min-height:0;"></div>
            <div id="public-builds-list">
                <div style="color:#555; font-size:13px; font-style:italic; padding:4px 0 2px 0;">${t("modal.publishLoading")}</div>
            </div>
            `}
        </div>
    `;

    renderSavedBuildsList("", gunId);

    const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById("builds-search-input"));
    searchInput.addEventListener("input", () => renderSavedBuildsList(searchInput.value, gunId));

    if (!EFTForge.config.COMMUNITY_DISABLED) {
        _renderPublicBuilds(gunId);

        const cbSearch = document.getElementById("cb-search-input");
        const cbSort   = document.getElementById("cb-sort-select");
        if (cbSearch) cbSearch.addEventListener("input",  _applyPublicBuildsFilter);
        if (cbSort)   cbSort.addEventListener("change",   _applyPublicBuildsFilter);
        setupCustomSelect("cb-sort-select");
    }
}

/* ===========================
   UI - SAVED BUILDS LIST
=========================== */

function _toggleTagFilter(tag) {
    if (_activeTagFilters.has(tag)) _activeTagFilters.delete(tag);
    else _activeTagFilters.add(tag);
    const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById("builds-search-input"));
    renderSavedBuildsList(searchInput?.value ?? "", _buildsListGunId);
}
window._toggleTagFilter = _toggleTagFilter;

function renderSavedBuildsList(query = "", gunId = null, showPublish = true) {
    // Desktop local mode: publishing is a community feature - builds stay
    // saved locally and become publishable once the user connects.
    showPublish = showPublish && !EFTForge.config.COMMUNITY_DISABLED;
    _buildsListGunId = gunId;
    _clearMarqueeTimers();

    const list = document.getElementById("saved-builds-list");
    const countEl = document.getElementById("saved-builds-count");
    if (!list || !countEl) return;

    const { builds } = loadSavedBuilds();

    const pool = gunId ? builds.filter(b => b.gunId === gunId) : builds;
    const q = query.trim().toLowerCase();

    // Collect all unique tags from the pool for the filter bar
    const allTags = [...new Set(pool.flatMap(b => b.tags ?? []))].sort();
    // Remove any active filters that no longer exist in the pool
    for (const tag of [..._activeTagFilters]) {
        if (!allTags.includes(tag)) _activeTagFilters.delete(tag);
    }

    let filtered = q
        ? pool.filter(b =>
            b.name.toLowerCase().includes(q) ||
            b.gunName.toLowerCase().includes(q)
          )
        : pool;

    if (_activeTagFilters.size > 0) {
        filtered = filtered.filter(b =>
            [..._activeTagFilters].every(tag => (b.tags ?? []).includes(tag))
        );
    }

    countEl.textContent = pool.length > 0 ? `(${pool.length})` : "";

    const { t } = EFTForge.lang;

    // Tag filter row (only shown if there are tags)
    const tagFilterHtml = allTags.length > 0
        ? `<div class="build-tag-filter-row">
            <span class="build-tag-filter-label">${escapeHtml(t("modal.tagFilterLabel"))}</span>
            ${allTags.map(tag =>
                `<button class="build-tag-chip${_activeTagFilters.has(tag) ? ' active' : ''}" data-tag="${escapeHtml(tag)}" onclick="_toggleTagFilter('${escapeHtml(tag)}')">${escapeHtml(t("tag." + tag))}</button>`
            ).join("")}
           </div>`
        : "";

    if (pool.length === 0) {
        list.innerHTML = `<div style="color:#555; font-size:13px; font-style:italic; padding:4px 0 2px 0;">${t("modal.noBuilds")}</div>`;
        return;
    }

    if (filtered.length === 0) {
        list.innerHTML = tagFilterHtml + `<div style="color:#555; font-size:13px; font-style:italic; padding:4px 0 2px 0;">${t("modal.noMatch")}</div>`;
        return;
    }

    const publishedIds = showPublish
        ? new Set(JSON.parse(localStorage.getItem("eftforge_published_ids") || "[]"))
        : null;

    const gunLookup = new Map((EFTForge.state.allGuns || []).map(g => [g.id, g.name]));

    const buildCardsHtml = filtered.map(entry => {
        const safeId = escapeHtml(entry.id);
        const displayGunName = gunLookup.get(entry.gunId) || entry.gunName;
        let publishBtnHtml = "";
        if (showPublish) {
            const isPublished = publishedIds.has(entry.id);
            publishBtnHtml = isPublished
                ? `<button class="saved-build-btn publish-btn"
                               data-id="${safeId}"
                               style="opacity:0.4; cursor:default;"
                               onclick="_tryRepublishBuild(this.dataset.id)">${t("modal.publishedBtn")}</button>`
                : `<button class="saved-build-btn publish-btn"
                           data-id="${safeId}"
                           onclick="_publishSavedBuildById(this.dataset.id)">${t("modal.publishBtn")}</button>`;
        }
        const tagsHtml = (entry.tags ?? []).length > 0
            ? `<div class="saved-build-tags">${(entry.tags).map(tag => `<span class="build-tag-chip" data-tag="${escapeHtml(tag)}">${escapeHtml(t("tag." + tag))}</span>`).join("")}</div>`
            : "";
        return `
            <div class="saved-build-card">
                <div class="saved-build-info">
                    <div class="saved-build-name"><span class="marquee-text">${escapeHtml(entry.name)}</span></div>
                    <div class="saved-build-gun"><span class="marquee-text">${escapeHtml(displayGunName)}</span></div>
                    ${tagsHtml}
                </div>
                <div class="saved-build-actions">
                    <button class="saved-build-btn load-btn"
                            data-id="${safeId}"
                            onclick="_loadSavedBuildById(this.dataset.id)">${t("ui.load")}</button>
                    <button class="saved-build-btn copy-btn"
                            data-id="${safeId}"
                            onclick="_copySavedBuildById(this.dataset.id)">${t("ui.copy")}</button>
                    ${publishBtnHtml}
                    <button class="saved-build-btn delete-btn"
                            data-id="${safeId}"
                            data-gun-id="${escapeHtml(gunId || '')}"
                            onclick="_confirmDeleteBuild(this, this.dataset.id, this.dataset.gunId || null)">&#x2715;</button>
                </div>
            </div>
        `;
    }).join("");

    list.innerHTML = tagFilterHtml + buildCardsHtml;
    _initMarqueeText(list);
}

// Helpers to avoid passing raw codes/IDs inline in HTML (XSS safety)
async function _loadSavedBuildById(id) {
    const { builds } = loadSavedBuilds();
    const entry = builds.find(b => b.id === id);
    if (!entry) return;
    const payload = decodeBuildCode(entry.code);
    if (!payload) {
        showToast(t("toast.loadFailed"), t("toast.codeCorrupted"), 3500);
        return;
    }
    const dlg = document.getElementById("builds-dialog");
    if (dlg) dlg.remove();
    if (document.body.dataset.mobile !== "true") {
        await EFTForge.tabs.createTabFromPayload(payload, entry.name, null, false);
    } else {
        await loadBuildFromPayload(payload, entry.name);
    }
}

async function _copySavedBuildById(id) {
    const { builds } = loadSavedBuilds();
    const entry = builds.find(b => b.id === id);
    if (entry) await copyBuildLink(convertBuildCode(entry.code) || entry.code);
}

async function _tryRepublishBuild(id) {
    const saveData = loadSavedBuilds();
    const entry = saveData.builds.find(b => b.id === id);
    if (!entry) return;

    const publishedId = entry.publishedId;
    if (!publishedId) {
        const published = new Set(JSON.parse(localStorage.getItem("eftforge_published_ids") || "[]"));
        published.delete(id);
        localStorage.setItem("eftforge_published_ids", JSON.stringify([...published]));
        _publishSavedBuildById(id);
        return;
    }

    try {
        const myBuilds = await EFTForge.api.fetchMyBuilds();
        if (myBuilds.some(b => b.id === publishedId)) return; // still live on server
    } catch { /* network error - fall through and allow republish */ }

    // Build no longer exists on server - clear stale local state and republish
    const published = new Set(JSON.parse(localStorage.getItem("eftforge_published_ids") || "[]"));
    published.delete(id);
    localStorage.setItem("eftforge_published_ids", JSON.stringify([...published]));
    const localEntry = saveData.builds.find(b => b.id === id);
    if (localEntry) {
        delete localEntry.publishedId;
        persistSavedBuilds(saveData);
    }
    _publishSavedBuildById(id);
}

async function _publishSavedBuildById(id) {
    const { builds } = loadSavedBuilds();
    const entry = builds.find(b => b.id === id);
    if (!entry) return;

    const payload = decodeBuildCode(entry.code);
    if (!payload) {
        showToast(t("toast.loadFailed"), t("toast.codeCorrupted"), 3500);
        return;
    }

    document.getElementById("builds-dialog")?.remove();
    document.getElementById("save-build-dialog")?.remove();

    // load the build silently (no "Build Loaded" toast)
    if (document.body.dataset.mobile !== "true") {
        await EFTForge.tabs.createTabFromPayload(payload, entry.name, null, true);
    } else {
        await loadBuildFromPayload(payload, entry.name, true);
    }

    // replace the placeholder with the publish confirm panel
    showPublishConfirmPanel(entry.name, entry.id);
}

/* ===========================
   BUILD RECONSTRUCTION
=========================== */

// Load a build from a decoded payload { g: gunId, p: [[slotId, itemId], ...] }
// collapsedSlots: the tree-collapse state to install alongside the build. Tabs
// pass their own so switching to one restores it in the SAME render as the build
// itself - without it the caller has to reapply the state and pay a second full
// renderFullTree() just to reflect it.
/**
 * @param {{ v?: number, g: string, p: any[], a?: string | null, ua?: string | null }} payload
 * @param {string | null} [buildName]
 * @param {boolean} [silent]
 * @param {{ collapsedSlots?: any }} [options]
 */
async function loadBuildFromPayload({ g: gunId, p: pairs, a: ammoId = null, ua: ubglAmmoId = null }, buildName = null, silent = false, { collapsedSlots = null } = {}) {
    const gun = gunById(gunId);
    if (!gun) {
        showToast(t("toast.loadFailed"), t("toast.unknownWeapon"), 3500);
        return;
    }

    // Clear EFTForge.state.currentGun so selectGun's early-return guard never fires
    EFTForge.state.currentGun = null;
    const dummyEl = { classList: { add() {}, remove() {} } };
    // Its factory tree render would be discarded three lines down - skip it.
    await selectGun(gun, dummyEl, { skipTreeRender: true, awaitBuildImage: !!pairs?.length });
    // selectGun populates EFTForge.state.slotCache for the gun and all factory items - but we
    // don't want factory attachments in the tree; pairs represent the complete build.
    EFTForge.state.buildTree.children = {};

    // The selectGun overlay is already gone but the factory tree is still rendered.
    // Clear it immediately and show a new overlay while we install the build.
    const slotsContainer = document.getElementById("slots");
    if (slotsContainer) slotsContainer.innerHTML = "";
    const buildLoadOverlay = startPanelLoading(document.querySelector(".left-panel"));

    // Ensure gun's own slots are in EFTForge.state.slotCache (handles guns with no factory attachments)
    if (!EFTForge.state.slotCache[gun.id]) {
        try {
            const slots = await fetchItemSlots(gun.id);
            cacheSet(EFTForge.state.slotCache, gun.id, slots);
        } catch {}
    }

    if (!pairs || pairs.length === 0) {
        EFTForge.state.collapsedSlots = collapsedSlots || {};
        await renderFullTree(false);
        stopPanelLoading(buildLoadOverlay);
        _applyPayloadAmmo(ammoId);
        _applyPayloadUbglAmmo(ubglAmmoId);
        await refreshBuildStats();
        syncBuildDisplayName();
        if (!silent) {
            const label0 = buildName ? `"${buildName}"` : `${gun.name} build`;
            showToast(t("toast.buildLoaded"), label0 + t("toast.loadedSuffix"), 2500, "#4CAF50");
        }
        return;
    }

    // Batch pre-warm both caches in two parallel requests instead of N individual fetches
    const uncachedSlotIds = [...new Set(
        pairs.map(([sid]) => sid).filter(sid => !EFTForge.state.allowedCache[sid])
    )];
    const uncachedItemIds = [...new Set(
        pairs.map(([, iid]) => iid).filter(iid => !EFTForge.state.slotCache[iid])
    )];
    const [batchAllowed, batchItemSlots] = await Promise.all([
        uncachedSlotIds.length ? fetchSlotAllowedItemsBatch(uncachedSlotIds).catch(() => ({})) : Promise.resolve({}),
        uncachedItemIds.length ? fetchItemSlotsBatch(uncachedItemIds).catch(() => ({})) : Promise.resolve({}),
    ]);
    for (const [sid, items] of Object.entries(batchAllowed)) {
        cacheSet(EFTForge.state.allowedCache, sid, items);
    }
    for (const [iid, slots] of Object.entries(batchItemSlots)) {
        cacheSet(EFTForge.state.slotCache, iid, slots);
    }

    // BFS install - pairs are in parent-before-child order; both caches are fully warm
    let missingCount = 0;
    const parents = createSlotParentResolver(EFTForge.state.buildTree, id => EFTForge.state.slotCache[id]);
    for (const [slotId, itemId] of pairs) {
        const allowed = EFTForge.state.allowedCache[slotId];
        if (!allowed) { missingCount++; continue; }

        const itemObj = allowed.find(i => i.id === itemId);
        if (!itemObj) { missingCount++; continue; }

        const parentNode = parents.parentFor(slotId);
        if (!parentNode) { missingCount++; continue; }

        const node = { item: itemObj, children: {} };
        parentNode.children[slotId] = node;
        parents.addNode(node);
    }

    EFTForge.state.processedCache = {};
    EFTForge.state.collapsedSlots = collapsedSlots || {};
    EFTForge.state.lastParentNode = null;
    EFTForge.state.lastSlot = null;
    await renderFullTree(false);
    stopPanelLoading(buildLoadOverlay);
    _applyPayloadAmmo(ammoId);
    _applyPayloadUbglAmmo(ubglAmmoId);
    await refreshBuildStats();
    syncBuildDisplayName();

    if (!silent) {
        const label = buildName ? `"${buildName}"` : `${gun.name} build`;
        if (missingCount > 0) {
            showToast(t("toast.partialLoad"), tFmt("toast.partialLoadMsg", { n: missingCount }), 5000);
        } else {
            showToast(t("toast.buildLoaded"), label + t("toast.loadedSuffix"), 2500, "#4CAF50");
        }
    }
}

// Import a build from the import input or a ?build= link. The input takes a
// bare code or a full link, so strip any link down to its code first.
async function importBuildFromCode(code) {
    const extracted = extractBuildCode(code);
    if (!extracted) return;
    const payload = decodeBuildCode(extracted);
    if (!payload) {
        showToast(t("toast.importFailed"), t("toast.invalidBuildCode"), 3500);
        return;
    }
    const dlg = document.getElementById("builds-dialog");
    if (dlg) dlg.remove();
    if (document.body.dataset.mobile !== "true") {
        await EFTForge.tabs.createTabFromPayload(payload, null, null, false); // no name - uses gun name in toast
    } else {
        await loadBuildFromPayload(payload); // no name - uses gun name in toast
    }
}

/* ===========================
   BACKUP EXPORT / IMPORT
=========================== */

function exportBuildsBackup() {
    const data = loadSavedBuilds();
    if (!data.builds.length) {
        showToast(t("toast.noBuildsToExportTitle"), t("toast.noBuildsToExport"), 2500, "#e74c3c");
        return;
    }
    const backup = {
        appVersion: EFTForge.config.APP_VERSION,
        exportedAt: Date.now(),
        builds: data.builds
    };
    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `eftforge-builds-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(t("toast.exportedTitle"), tFmt("toast.exportedCountMsg", { n: data.builds.length }), 2500, "#4CAF50");
}

function importBuildsFromFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.addEventListener("change", async () => {
        const file = input.files[0];
        if (!file) return;
        await _processBackupFile(file);
    });
    input.click();
}

async function _processBackupFile(file) {
    try {
        const text = await file.text();
        const backup = JSON.parse(text);
        if (!backup.appVersion || !Array.isArray(backup.builds)) {
            showToast(t("toast.importFailed"), t("toast.invalidFile"), 3500);
            return;
        }
        _showBackupModeModal(backup);
    } catch {
        showToast(t("toast.importFailed"), t("toast.readFileFailed"), 3500);
    }
}

function _showBackupModeModal(backup) {
    const overlay = _createModalOverlay("backup-mode-dialog", t("modal.importBackup"), {
        closeId:  "backup-mode-close",
        bodyId:   "backup-mode-body",
        maxWidth: "400px",
    });
    if (!overlay) return;

    document.getElementById("backup-mode-body").innerHTML = `
        <div class="modal-section">
            <div style="font-size:13px; color:#aaa; margin-bottom:14px; line-height:1.6;">
                <span style="color:#eee;">${escapeHtml(tFmt("modal.backupInfo", { n: backup.builds.length, v: backup.appVersion }))}</span>
            </div>
            <div class="modal-label">${t("modal.importMode")}</div>
            <div class="modal-row">
                <button class="modal-btn primary full-width" id="backup-merge-btn">${t("modal.mergeBtn")}</button>
                <button class="modal-btn full-width" id="backup-overwrite-btn">${t("modal.overwriteAllBtn")}</button>
            </div>
        </div>
    `;

    document.getElementById("backup-merge-btn").addEventListener("click", () => {
        _maybeWarnVersionThenApply(backup, "merge");
    });
    const overwriteBtn = document.getElementById("backup-overwrite-btn");
    overwriteBtn.addEventListener("click", () => {
        if (overwriteBtn.dataset.confirming === "1") {
            _maybeWarnVersionThenApply(backup, "overwrite");
            return;
        }

        overwriteBtn.dataset.confirming = "1";
        overwriteBtn.textContent = t("ui.confirm");
        overwriteBtn.style.background = "#3d0f0f";
        overwriteBtn.style.borderColor = "#f44336";

        const revert = () => {
            overwriteBtn.dataset.confirming = "";
            overwriteBtn.textContent = t("modal.overwriteAllBtn");
            overwriteBtn.style.background = "";
            overwriteBtn.style.borderColor = "";
            overwriteBtn.removeEventListener("mouseleave", revert);
        };
        overwriteBtn.addEventListener("mouseleave", revert);
    });
}

function _maybeWarnVersionThenApply(backup, mode) {
    // Web and desktop builds of the same release differ only by the
    // "-desktop" suffix - don't warn when moving backups between them.
    const _baseVersion = v => String(v || "").replace(/-desktop$/, "");
    if (_baseVersion(backup.appVersion) !== _baseVersion(EFTForge.config.APP_VERSION)) {
        const body = document.getElementById("backup-mode-body");
        if (!body) return;

        body.innerHTML = `
            <div class="modal-section">
                <div style="font-size:14px; line-height:1.6; margin-bottom:14px;">
                    <span style="color:#f5c542;">${t("modal.versionMismatch")}</span><br>
                    <span style="color:#aaa; font-size:13px;">
                        ${escapeHtml(tFmt("modal.versionMismatchDesc", { version: backup.appVersion, current: EFTForge.config.APP_VERSION }))}
                    </span>
                </div>
                <div class="modal-label">${t("modal.areYouSure")}</div>
                <div class="modal-row">
                    <button class="modal-btn full-width" id="backup-warn-cancel">${t("ui.cancel")}</button>
                    <button class="modal-btn primary full-width" id="backup-warn-continue">${t("ui.continue")}</button>
                </div>
            </div>
        `;

        document.getElementById("backup-warn-cancel").addEventListener("click", () => {
            document.getElementById("backup-mode-dialog")?.remove();
        });
        document.getElementById("backup-warn-continue").addEventListener("click", () => {
            _applyBackupImport(backup, mode);
        });
    } else {
        _applyBackupImport(backup, mode);
    }
}

function _applyBackupImport(backup, mode) {
    document.getElementById("backup-mode-dialog")?.remove();

    if (mode === "overwrite") {
        persistSavedBuilds({ version: 1, builds: backup.builds });
        renderSavedBuildsList();
        showToast(t("toast.backupImportedTitle"), tFmt("toast.backupLoadedMsg", { n: backup.builds.length }), 2500, "#4CAF50");
        return;
    }

    // Merge mode - filter out ID duplicates, then detect name conflicts
    const existing = loadSavedBuilds();
    const existingIds = new Set(existing.builds.map(b => b.id));
    const idFiltered = backup.builds.filter(b => !existingIds.has(b.id));

    const nameConflicts = [];
    const cleanToAdd = [];

    for (const b of idFiltered) {
        const hasNameConflict = existing.builds.some(
            e => e.gunId === b.gunId && e.name.toLowerCase() === b.name.toLowerCase()
        );
        if (hasNameConflict) {
            nameConflicts.push(b);
        } else {
            cleanToAdd.push(b);
        }
    }

    if (nameConflicts.length === 0) {
        _finalizeMerge(cleanToAdd, [], existing.builds);
        return;
    }

    _resolveMergeConflicts(nameConflicts, cleanToAdd, existing.builds);
}

// Shows all name conflicts at once in a single list modal.
function _resolveMergeConflicts(conflicts, cleanToAdd, existingBuilds) {
    // Per-conflict state: "skip" | "overwrite" | "rename"
    const resolutions = conflicts.map(() => "skip");

    const rowsHtml = conflicts.map((build, i) => `
        <div class="mc-conflict-row" id="mc-row-${i}" style="padding:10px 0; border-bottom:1px solid #222;">
            <div style="font-size:13px; margin-bottom:8px; line-height:1.5;">
                <span style="color:#eee;">"${escapeHtml(build.name)}"</span>
                <span style="color:#555; font-size:12px;"> - ${escapeHtml(build.gunName)}</span>
            </div>
            <div style="display:flex; gap:5px; flex-wrap:wrap;">
                <button class="modal-btn mc-res-btn" data-idx="${i}" data-action="overwrite">${t("ui.overwrite")}</button>
                <button class="modal-btn mc-res-btn mc-active" data-idx="${i}" data-action="skip">${t("ui.skip")}</button>
                <button class="modal-btn mc-res-btn" data-idx="${i}" data-action="rename">${t("ui.rename")}</button>
            </div>
            <div id="mc-rename-row-${i}" style="display:none; margin-top:7px;">
                <input id="mc-rename-input-${i}" type="text" class="search-input"
                       style="font-size:13px; margin:0; width:100%; box-sizing:border-box;"
                       placeholder="${escapeHtml(t("modal.newBuildName"))}"
                       maxlength="60"
                       value="${escapeHtml(build.name)}" />
                <div id="mc-rename-err-${i}" style="font-size:12px; color:#f44336; min-height:14px; margin-top:3px;"></div>
            </div>
        </div>
    `).join("");

    const countLabel = `<span style="font-size:12px; color:#555; margin-left:auto; margin-right:10px;">${conflicts.length} ${conflicts.length !== 1 ? t("modal.conflicts") : t("modal.conflict")}</span>`;
    _createModalOverlay("merge-conflict-dialog", t("modal.nameConflicts"), {
        closeId:    "mc-close-btn",
        bodyId:     "mc-dialog-body",
        maxWidth:   "460px",
        titleExtra: countLabel,
    });

    document.getElementById("mc-dialog-body").innerHTML = `
        <div class="modal-section">
            <div style="font-size:13px; color:#777; margin-bottom:10px;">
                ${t("modal.conflictsDesc")}
            </div>
            <div id="mc-conflict-list" style="max-height:360px; overflow-y:auto; scrollbar-width:thin; scrollbar-color:#444 #111;">
                ${rowsHtml}
            </div>
        </div>
        <div class="modal-row" style="margin-top:14px;">
            <button class="modal-btn full-width" id="mc-cancel-btn">${t("ui.cancel")}</button>
            <button class="modal-btn primary full-width" id="mc-confirm-btn">${t("modal.confirmAll")}</button>
        </div>
    `;

    // Inject active-button style if not already present
    if (!document.getElementById("mc-btn-style")) {
        const style = document.createElement("style");
        style.id = "mc-btn-style";
        style.textContent = `.mc-active { background:#333 !important; color:#eee !important; border-color:#666 !important; }`;
        document.head.appendChild(style);
    }

    const overlay = document.getElementById("merge-conflict-dialog");

    // Resolution button toggle logic
    /** @type {NodeListOf<HTMLElement>} */ (overlay.querySelectorAll(".mc-res-btn")).forEach(btn => {
        btn.addEventListener("click", () => {
            const i = parseInt(btn.dataset.idx);
            const action = btn.dataset.action;
            resolutions[i] = action;

            // Update active state for this row's buttons
            /** @type {NodeListOf<HTMLElement>} */ (overlay.querySelectorAll(`.mc-res-btn[data-idx="${i}"]`)).forEach(b => {
                b.classList.toggle("mc-active", b.dataset.action === action);
            });

            // Show/hide rename input
            const renameRow = document.getElementById(`mc-rename-row-${i}`);
            renameRow.style.display = action === "rename" ? "" : "none";
            if (action === "rename") {
                /** @type {HTMLInputElement} */ (document.getElementById(`mc-rename-input-${i}`)).focus();
                /** @type {HTMLInputElement} */ (document.getElementById(`mc-rename-input-${i}`)).select();
            }
            // Clear any prior error
            document.getElementById(`mc-rename-err-${i}`).textContent = "";
        });
    });

    // mc-close-btn and overlay-backdrop are already wired by _createModalOverlay
    document.getElementById("mc-cancel-btn").addEventListener("click", () => overlay.remove());

    document.getElementById("mc-confirm-btn").addEventListener("click", () => {
        // Validate all rename inputs before proceeding
        let hasError = false;
        const renamedNames = []; // track names chosen this batch to catch intra-batch duplicates

        for (let i = 0; i < conflicts.length; i++) {
            const errEl = document.getElementById(`mc-rename-err-${i}`);
            errEl.textContent = "";

            if (resolutions[i] !== "rename") continue;

            const newName = /** @type {HTMLInputElement} */ (document.getElementById(`mc-rename-input-${i}`)).value.trim().slice(0, 60);

            if (!newName) {
                errEl.textContent = t("modal.nameEmpty");
                hasError = true;
                continue;
            }
            const conflictsWithExisting = existingBuilds.some(
                e => e.gunId === conflicts[i].gunId && e.name.toLowerCase() === newName.toLowerCase()
            );
            if (conflictsWithExisting) {
                errEl.textContent = t("modal.nameTaken");
                hasError = true;
                continue;
            }
            const batchKey = `${conflicts[i].gunId}|${newName.toLowerCase()}`;
            if (renamedNames.includes(batchKey)) {
                errEl.textContent = t("modal.nameDuplicate");
                hasError = true;
                continue;
            }
            renamedNames.push(batchKey);
        }

        if (hasError) return;

        // Build resolvedList from current state
        const resolvedList = conflicts.map((build, i) => {
            if (resolutions[i] === "rename") {
                const newName = /** @type {HTMLInputElement} */ (document.getElementById(`mc-rename-input-${i}`)).value.trim().slice(0, 60);
                return { build: { ...build, name: newName }, action: "add" };
            }
            return { build, action: resolutions[i] };
        });

        overlay.remove();
        _finalizeMerge(cleanToAdd, resolvedList, existingBuilds);
    });
}

function _finalizeMerge(cleanToAdd, resolvedList, existingBuilds) {
    const workingBuilds = [...existingBuilds];

    // Apply overwrites - replace the existing build with the same name+gunId
    for (const { build, action } of resolvedList) {
        if (action === "overwrite") {
            const idx = workingBuilds.findIndex(
                e => e.gunId === build.gunId && e.name.toLowerCase() === build.name.toLowerCase()
            );
            if (idx !== -1) workingBuilds[idx] = { ...build, id: workingBuilds[idx].id };
        }
    }

    // Collect new builds to prepend (clean + renamed/added resolutions)
    const toAdd = [
        ...cleanToAdd,
        ...resolvedList.filter(r => r.action === "add").map(r => r.build)
    ];

    const merged = [...toAdd, ...workingBuilds].slice(0, 50);
    persistSavedBuilds({ version: 1, builds: merged });
    renderSavedBuildsList();

    const totalImported = toAdd.length + resolvedList.filter(r => r.action === "overwrite").length;
    showToast(t("toast.backupImportedTitle"), tFmt("toast.backupMergedMsg", { n: totalImported }), 2500, "#4CAF50");
}

// Paste from clipboard into the import input
async function pasteImportCode() {
    try {
        const text = await navigator.clipboard.readText();
        const input = /** @type {HTMLInputElement | null} */ (document.getElementById("import-code-input"));
        if (input) {
            input.value = text;
            input.focus();
        }
    } catch {
        showToast(t("toast.pasteFailed"), t("toast.clipboardFailed"), 3000);
    }
}
