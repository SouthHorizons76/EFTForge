window.EFTForge = window.EFTForge || {};

/* ============================================================
   BUILD MANAGER
   Save, Reset, and Share build functionality.
   Accesses globals defined in app.js (EFTForge.state.buildTree, EFTForge.state.currentGun, etc.)
============================================================ */

async function resetBuild() {
    if (!EFTForge.state.currentGun) return;

    // Reset tree to gun root only
    EFTForge.state.buildTree = { item: EFTForge.state.currentGun, children: {} };

    // Reinstall factory attachments
    if (EFTForge.state.currentGun.factory_attachment_ids) {
        const factoryIds = Array.isArray(EFTForge.state.currentGun.factory_attachment_ids)
            ? EFTForge.state.currentGun.factory_attachment_ids
            : EFTForge.state.currentGun.factory_attachment_ids.split(",");

        for (const id of factoryIds) {
            if (id && id.trim() !== "") {
                await installFactoryAttachment(EFTForge.state.buildTree, id.trim());
            }
        }
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

    await renderFullTree(false);
    await refreshBuildStats();
    flashTree("reset");
    const { t: _t } = EFTForge.lang;
    showToast(_t("toast.resetTitle"), _t("toast.resetMsg"), 2500, "#4CAF50");
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

    await renderFullTree(false);
    await refreshBuildStats();
    flashTree("strip");
    const { t: _t2 } = EFTForge.lang;
    showToast(_t2("toast.strippedTitle"), _t2("toast.strippedMsg"), 2500, "#FF9800");
}

/* ===========================
   BUILD SERIALIZATION
=========================== */

// BFS walk → [[slotId, itemId], ...] in parents-before-children order
function collectSlotPairs(node) {
    const pairs = [];
    const queue = [node];
    while (queue.length > 0) {
        const current = queue.shift();
        for (const slotId in current.children) {
            pairs.push([slotId, current.children[slotId].item.id]);
            queue.push(current.children[slotId]);
        }
    }
    return pairs;
}

// Encode current build to a compressed URL-safe string
function encodeBuild() {
    const pairs = collectSlotPairs(EFTForge.state.buildTree);
    const payload = { v: 1, g: EFTForge.state.currentGun.id, p: pairs };
    return LZString.compressToEncodedURIComponent(JSON.stringify(payload));
}

// Decode a build code → { v, g, p } or null on error
function decodeBuildCode(code) {
    try {
        const json = LZString.decompressFromEncodedURIComponent(code.trim());
        if (!json) throw new Error("Decompression failed");
        const payload = JSON.parse(json);
        if (payload.v !== 1) throw new Error("Unknown version");
        if (typeof payload.g !== "string") throw new Error("Missing gun ID");
        if (!Array.isArray(payload.p)) throw new Error("Missing slot pairs");
        return payload;
    } catch {
        return null;
    }
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
}

function saveCurrentBuild(name, overwrite = false) {
    if (!EFTForge.state.currentGun || !EFTForge.state.buildTree) return;
    const trimmed = (name || "").trim().slice(0, 60);
    if (!trimmed) {
        showToast(t("toast.saveFailed"), t("toast.saveFailedMsg"), 2500);
        return;
    }
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
    } else {
        data.builds.unshift({
            id: Date.now().toString(36),
            name: trimmed,
            gunId: EFTForge.state.currentGun.id,
            gunName: EFTForge.state.currentGun.name,
            savedAt: Date.now(),
            code
        });
        if (data.builds.length > 50) data.builds = data.builds.slice(0, 50);
    }
    persistSavedBuilds(data);
    const dlg = document.getElementById("save-build-dialog");
    if (dlg) dlg.remove();
    const { t: _tSave } = EFTForge.lang;
    showToast(_tSave("toast.savedTitle"), `"${escapeHtml(trimmed)}" ${_tSave("toast.savedMsg")}`, 2500, "#4CAF50");
    renderSavedBuildsList();
}

function deleteSavedBuild(id) {
    const data = loadSavedBuilds();
    data.builds = data.builds.filter(b => b.id !== id);
    persistSavedBuilds(data);
    renderSavedBuildsList();
}

function _confirmDeleteBuild(btn, id) {
    if (btn.dataset.confirming === "1") {
        deleteSavedBuild(id);
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

async function copyBuildCode(code) {
    const { t } = EFTForge.lang;
    try {
        await navigator.clipboard.writeText(code);
        showToast(t("modal.copied"), t("toast.codeCopiedMsg"), 2000, "#4CAF50");
    } catch {
        showToast(t("toast.copyFailed"), t("toast.clipboardFailed"), 3000);
    }
}

/* ===========================
   UI — SAVE DIALOG
=========================== */

function showSaveBuildDialog() {
    if (!EFTForge.state.currentGun) return;
    const overlay = _createModalOverlay("save-build-dialog", t("modal.saveAndShare"), {
        closeId: "modal-close-x",
        bodyId:  "save-build-modal-body",
    });
    if (!overlay) return;
    _renderSaveBuildBody(EFTForge.state.currentGun.name);
}

function _renderSaveBuildBody(prefill) {
    const body = document.getElementById("save-build-modal-body");
    if (!body || !EFTForge.state.currentGun) return;
    const { t } = EFTForge.lang;

    body.innerHTML = `
        <div class="modal-section">
            <div class="modal-label">${t("modal.save")}</div>
            <div class="modal-row">
                <input id="save-build-name" type="text" class="search-input"
                       style="font-size: 13px; margin:0; flex:1; min-width:0;"
                       placeholder="${escapeHtml(t("modal.saveName"))}"
                       maxlength="60"
                       value="${escapeHtml(prefill ?? EFTForge.state.currentGun.name)}" />
                <button class="modal-btn primary" id="modal-save-btn">${t("modal.saveBtn")}</button>
            </div>
        </div>

        <hr class="modal-divider" />

        <div class="modal-section">
            <div class="modal-label">${t("modal.share")}</div>
            <button class="modal-btn full-width" id="modal-copy-btn">${t("modal.copyBtn")}</button>
        </div>
    `;

    const input = document.getElementById("save-build-name");
    input.focus();
    input.select();

    document.getElementById("modal-save-btn").addEventListener("click", () => {
        saveCurrentBuild(input.value);
    });

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            saveCurrentBuild(input.value);
        }
    });

    document.getElementById("modal-copy-btn").addEventListener("click", async () => {
        const btn = document.getElementById("modal-copy-btn");
        const { t: _tc } = EFTForge.lang;
        await copyBuildCode(encodeBuild());
        if (btn) {
            btn.textContent = _tc("modal.copied");
            setTimeout(() => { if (btn) btn.textContent = _tc("modal.copyBtn"); }, 2000);
        }
    });
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

/* ===========================
   UI — BUILDS DIALOG
=========================== */

function showBuildsDialog() {
    const { t } = EFTForge.lang;
    const overlay = _createModalOverlay("builds-dialog", t("modal.builds"), {
        closeId:  "builds-modal-close",
        bodyId:   "builds-dialog-body",
        maxWidth: "520px",
    });
    if (!overlay) return;

    document.getElementById("builds-dialog-body").innerHTML = `
        <div class="modal-section">
            <div class="modal-label" style="display:flex; align-items:center; gap:6px;">
                ${t("modal.builds")} <span id="saved-builds-count" style="font-weight:400; letter-spacing:0; color:#555;"></span>
            </div>
            <input id="builds-search-input" type="text" class="search-input"
                   style="font-size: 13px; margin:0 0 8px 0; width:100%; box-sizing:border-box;"
                   placeholder="${escapeHtml(t("modal.searchBuilds"))}" />
            <div id="saved-builds-list" style="max-height:300px; overflow-y:auto; scrollbar-width:thin; scrollbar-color:#444 #111;"></div>
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

    renderSavedBuildsList();

    const searchInput = document.getElementById("builds-search-input");
    searchInput.addEventListener("input", () => renderSavedBuildsList(searchInput.value));

    const modalWindow = overlay.querySelector(".modal-window");

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
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        showDrop();
    });
    overlay.addEventListener("dragleave", (e) => {
        if (!overlay.contains(e.relatedTarget)) hideDrop();
    });
    overlay.addEventListener("drop", (e) => {
        e.preventDefault();
        hideDrop();
        const file = e.dataTransfer.files[0];
        if (!file) return;
        _processBackupFile(file);
    });
}

/* ===========================
   UI — SAVED BUILDS LIST
=========================== */

function renderSavedBuildsList(query = "") {
    _clearMarqueeTimers();

    const list = document.getElementById("saved-builds-list");
    const countEl = document.getElementById("saved-builds-count");
    if (!list || !countEl) return;

    const { builds } = loadSavedBuilds();

    const q = query.trim().toLowerCase();
    const filtered = q
        ? builds.filter(b =>
            b.name.toLowerCase().includes(q) ||
            b.gunName.toLowerCase().includes(q)
          )
        : builds;

    countEl.textContent = builds.length > 0 ? `(${builds.length})` : "";

    const { t } = EFTForge.lang;

    if (builds.length === 0) {
        list.innerHTML = `<div style="color:#555; font-size:13px; font-style:italic; padding:4px 0 2px 0;">${t("modal.noBuilds")}</div>`;
        return;
    }

    if (filtered.length === 0) {
        list.innerHTML = `<div style="color:#555; font-size:13px; font-style:italic; padding:4px 0 2px 0;">${t("modal.noMatch")}</div>`;
        return;
    }

    list.innerHTML = filtered.map(entry => {
        const safeId = escapeHtml(entry.id);
        return `
            <div class="saved-build-card">
                <div class="saved-build-info">
                    <div class="saved-build-name"><span class="marquee-text">${escapeHtml(entry.name)}</span></div>
                    <div class="saved-build-gun">${escapeHtml(entry.gunName)}</div>
                </div>
                <div class="saved-build-actions">
                    <button class="saved-build-btn load-btn"
                            data-id="${safeId}"
                            onclick="_loadSavedBuildById(this.dataset.id)">${t("ui.load")}</button>
                    <button class="saved-build-btn copy-btn"
                            data-id="${safeId}"
                            onclick="_copySavedBuildById(this.dataset.id)">${t("ui.copy")}</button>
                    <button class="saved-build-btn delete-btn"
                            data-id="${safeId}"
                            onclick="_confirmDeleteBuild(this, this.dataset.id)">&#x2715;</button>
                </div>
            </div>
        `;
    }).join("");

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
    await loadBuildFromPayload(payload, entry.name);
}

async function _copySavedBuildById(id) {
    const { builds } = loadSavedBuilds();
    const entry = builds.find(b => b.id === id);
    if (entry) await copyBuildCode(entry.code);
}

/* ===========================
   BUILD RECONSTRUCTION
=========================== */

// Build a synchronous map: slotId → parent tree node.
// Uses EFTForge.state.slotCache (populated by installFactoryAttachment + pre-warm steps).
function buildSlotParentMap(node, map) {
    const slots = EFTForge.state.slotCache[node.item.id];
    if (slots) {
        for (const slot of slots) map[slot.id] = node;
    }
    for (const childSlotId in node.children) {
        buildSlotParentMap(node.children[childSlotId], map);
    }
}

// Load a build from a decoded payload { g: gunId, p: [[slotId, itemId], ...] }
async function loadBuildFromPayload({ g: gunId, p: pairs }, buildName = null) {
    const gun = EFTForge.state.allGuns.find(g => g.id === gunId);
    if (!gun) {
        showToast(t("toast.loadFailed"), t("toast.unknownWeapon"), 3500);
        return;
    }

    // Clear EFTForge.state.currentGun so selectGun's early-return guard never fires
    EFTForge.state.currentGun = null;
    const dummyEl = { classList: { add() {}, remove() {} } };
    await selectGun(gun, dummyEl);
    // selectGun populates EFTForge.state.slotCache for the gun and all factory items — but we
    // don't want factory attachments in the tree; pairs represent the complete build.
    EFTForge.state.buildTree.children = {};

    // Ensure gun's own slots are in EFTForge.state.slotCache (handles guns with no factory attachments)
    if (!EFTForge.state.slotCache[gun.id]) {
        try {
            const slots = await fetchItemSlots(gun.id);
            cacheSet(EFTForge.state.slotCache, gun.id, slots);
        } catch {}
    }

    if (!pairs || pairs.length === 0) {
        await renderFullTree(false);
        await refreshBuildStats();
        const label0 = buildName ? `"${buildName}"` : `${gun.name} build`;
        showToast(t("toast.buildLoaded"), label0 + t("toast.loadedSuffix"), 2500, "#4CAF50");
        return;
    }

    // Pre-fetch allowed-items for any slots not yet in EFTForge.state.allowedCache
    const uncachedSlotIds = [...new Set(
        pairs.map(([sid]) => sid).filter(sid => !EFTForge.state.allowedCache[sid])
    )];
    await Promise.all(uncachedSlotIds.map(async sid => {
        try {
            const allowed = await fetchSlotAllowedItems(sid);
            cacheSet(EFTForge.state.allowedCache, sid, allowed);
        } catch {}
    }));

    // BFS install — pairs are in parent-before-child order
    let missingCount = 0;
    for (const [slotId, itemId] of pairs) {
        const allowed = EFTForge.state.allowedCache[slotId];
        if (!allowed) { missingCount++; continue; }

        const itemObj = allowed.find(i => i.id === itemId);
        if (!itemObj) { missingCount++; continue; }

        // Build slot→parent map from current tree using EFTForge.state.slotCache
        const slotToParent = {};
        buildSlotParentMap(EFTForge.state.buildTree, slotToParent);

        const parentNode = slotToParent[slotId];
        if (!parentNode) { missingCount++; continue; }

        parentNode.children[slotId] = { item: itemObj, children: {} };

        // Pre-warm EFTForge.state.slotCache for the newly placed item so its child slots
        // appear in the map for subsequent pairs
        if (!EFTForge.state.slotCache[itemObj.id]) {
            try {
                const slots = await fetchItemSlots(itemObj.id);
                cacheSet(EFTForge.state.slotCache, itemObj.id, slots);
            } catch {}
        }
    }

    EFTForge.state.processedCache = {};
    EFTForge.state.collapsedSlots = {};
    EFTForge.state.lastParentNode = null;
    EFTForge.state.lastSlot = null;
    await renderFullTree(false);
    await refreshBuildStats();

    const label = buildName ? `"${buildName}"` : `${gun.name} build`;
    if (missingCount > 0) {
        showToast(t("toast.partialLoad"), tFmt("toast.partialLoadMsg", { n: missingCount }), 5000);
    } else {
        showToast(t("toast.buildLoaded"), label + t("toast.loadedSuffix"), 2500, "#4CAF50");
    }
}

// Import a build from a raw code string (from the import input)
async function importBuildFromCode(code) {
    if (!code || !code.trim()) return;
    const payload = decodeBuildCode(code.trim());
    if (!payload) {
        showToast(t("toast.importFailed"), t("toast.invalidBuildCode"), 3500);
        return;
    }
    const dlg = document.getElementById("builds-dialog");
    if (dlg) dlg.remove();
    await loadBuildFromPayload(payload); // no name — uses gun name in toast
}

/* ===========================
   BACKUP EXPORT / IMPORT
=========================== */

function exportBuildsBackup() {
    const data = loadSavedBuilds();
    if (!data.builds.length) {
        showToast(t("toast.noBuildsToExportTitle"), t("toast.noBuildsToExport"), 2500, "#f44336");
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
    if (backup.appVersion !== EFTForge.config.APP_VERSION) {
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

    // Merge mode — filter out ID duplicates, then detect name conflicts
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
                <span style="color:#555; font-size:12px;"> — ${escapeHtml(build.gunName)}</span>
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
    overlay.querySelectorAll(".mc-res-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const i = parseInt(btn.dataset.idx);
            const action = btn.dataset.action;
            resolutions[i] = action;

            // Update active state for this row's buttons
            overlay.querySelectorAll(`.mc-res-btn[data-idx="${i}"]`).forEach(b => {
                b.classList.toggle("mc-active", b.dataset.action === action);
            });

            // Show/hide rename input
            const renameRow = document.getElementById(`mc-rename-row-${i}`);
            renameRow.style.display = action === "rename" ? "" : "none";
            if (action === "rename") {
                document.getElementById(`mc-rename-input-${i}`).focus();
                document.getElementById(`mc-rename-input-${i}`).select();
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

            const newName = document.getElementById(`mc-rename-input-${i}`).value.trim().slice(0, 60);

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
                const newName = document.getElementById(`mc-rename-input-${i}`).value.trim().slice(0, 60);
                return { build: { ...build, name: newName }, action: "add" };
            }
            return { build, action: resolutions[i] };
        });

        overlay.remove();
        _finalizeMerge(cleanToAdd, resolvedList, existingBuilds);
    });
}

function _finalizeMerge(cleanToAdd, resolvedList, existingBuilds) {
    let workingBuilds = [...existingBuilds];

    // Apply overwrites — replace the existing build with the same name+gunId
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
        const input = document.getElementById("import-code-input");
        if (input) {
            input.value = text;
            input.focus();
        }
    } catch {
        showToast(t("toast.pasteFailed"), t("toast.clipboardFailed"), 3000);
    }
}
