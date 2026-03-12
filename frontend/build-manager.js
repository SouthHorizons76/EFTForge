/* ============================================================
   BUILD MANAGER
   Save, Reset, and Share build functionality.
   Accesses globals defined in app.js (buildTree, currentGun, etc.)
============================================================ */

/* ===========================
   MODAL FACTORY
=========================== */

// Creates a standard modal overlay shell, appends it to body, and wires up
// close-button and backdrop-click dismissal.  Returns the overlay element, or
// null if a modal with that id is already open.
//
// opts:
//   closeId    – id for the ✕ button          (default: `${id}-close`)
//   bodyId     – id for the .modal-body div   (default: `${id}-body`)
//   maxWidth   – CSS max-width string         (default: none)
//   titleExtra – raw HTML inserted between title and close button (default: "")
function _createModalOverlay(id, title, opts = {}) {
    if (document.getElementById(id)) return null;
    const {
        closeId    = `${id}-close`,
        bodyId     = `${id}-body`,
        maxWidth   = "",
        titleExtra = "",
    } = opts;

    const overlay = document.createElement("div");
    overlay.id = id;
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
        <div class="modal-window"${maxWidth ? ` style="max-width:${maxWidth};"` : ""}>
            <div class="modal-header">
                <span class="modal-title">${title}</span>
                ${titleExtra}
                <button class="modal-close-btn" id="${closeId}" aria-label="Close dialog">&#x2715;</button>
            </div>
            <div class="modal-body" id="${bodyId}"></div>
        </div>
    `;

    document.body.appendChild(overlay);
    document.getElementById(closeId).addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    return overlay;
}

async function resetBuild() {
    if (!currentGun) return;

    // Reset tree to gun root only
    buildTree = { item: currentGun, children: {} };

    // Reinstall factory attachments
    if (currentGun.factory_attachment_ids) {
        const factoryIds = Array.isArray(currentGun.factory_attachment_ids)
            ? currentGun.factory_attachment_ids
            : currentGun.factory_attachment_ids.split(",");

        for (const id of factoryIds) {
            if (id && id.trim() !== "") {
                await installFactoryAttachment(buildTree, id.trim());
            }
        }
    }

    // Clear UI state
    lastParentNode = null;
    lastSlot = null;
    lastProcessedItems = [];
    processedCache = {};
    collapsedSlots = {};

    // Close attachment selector table, restore placeholder
    document.getElementById("attachment-placeholder").style.display = "";
    document.getElementById("attachment-table-container").innerHTML = "";
    document.querySelectorAll(".tree-slot.active-slot")
        .forEach(el => el.classList.remove("active-slot"));

    await renderFullTree(false);
    await refreshBuildStats();
    showToast("Build Reset", "Restored to factory configuration.", 2500, "#4CAF50");
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
    const pairs = collectSlotPairs(buildTree);
    const payload = { v: 1, g: currentGun.id, p: pairs };
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
            showToast("Storage Full", "Delete some saved builds to make room.", 4000);
        }
    }
}

function saveCurrentBuild(name, overwrite = false) {
    if (!currentGun || !buildTree) return;
    const trimmed = (name || "").trim().slice(0, 60);
    if (!trimmed) {
        showToast("Save Failed", "Please enter a build name.", 2500);
        return;
    }
    const data = loadSavedBuilds();
    const duplicate = data.builds.find(
        b => b.gunId === currentGun.id && b.name.toLowerCase() === trimmed.toLowerCase()
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
            gunId: currentGun.id,
            gunName: currentGun.name,
            savedAt: Date.now(),
            code
        });
        if (data.builds.length > 50) data.builds = data.builds.slice(0, 50);
    }
    persistSavedBuilds(data);
    const dlg = document.getElementById("save-build-dialog");
    if (dlg) dlg.remove();
    showToast("Build Saved", `"${escapeHtml(trimmed)}" saved.`, 2500, "#4CAF50");
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
    btn.textContent = "Confirm?";
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
    try {
        await navigator.clipboard.writeText(code);
        showToast("Copied!", "Build code copied to clipboard.", 2000, "#4CAF50");
    } catch {
        showToast("Copy Failed", "Could not access clipboard.", 3000);
    }
}

/* ===========================
   UI — SAVE DIALOG
=========================== */

function showSaveBuildDialog() {
    if (!currentGun) return;
    const overlay = _createModalOverlay("save-build-dialog", "SAVE &amp; SHARE", {
        closeId: "modal-close-x",
        bodyId:  "save-build-modal-body",
    });
    if (!overlay) return;
    _renderSaveBuildBody(currentGun.name);
}

function _renderSaveBuildBody(prefill) {
    const body = document.getElementById("save-build-modal-body");
    if (!body || !currentGun) return;

    body.innerHTML = `
        <div class="modal-section">
            <div class="modal-label">SAVE BUILD</div>
            <div class="modal-row">
                <input id="save-build-name" type="text" class="search-input"
                       style="font-size: 13px; margin:0; flex:1; min-width:0;"
                       placeholder="Build name..."
                       maxlength="60"
                       value="${escapeHtml(prefill ?? currentGun.name)}" />
                <button class="modal-btn primary" id="modal-save-btn">Save</button>
            </div>
        </div>

        <hr class="modal-divider" />

        <div class="modal-section">
            <div class="modal-label">SHARE BUILD</div>
            <button class="modal-btn full-width" id="modal-copy-btn">Copy Share Code</button>
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
        await copyBuildCode(encodeBuild());
        if (btn) {
            btn.textContent = "Copied!";
            setTimeout(() => { if (btn) btn.textContent = "Copy Share Code"; }, 2000);
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
                <span style="color:#aaa;"> already exists for this weapon.</span><br>
                <span style="color:#777; font-size:13px;">Do you want to overwrite it?</span>
            </div>
            <div class="modal-row">
                <button class="modal-btn full-width" id="overwrite-cancel-btn">Cancel</button>
                <button class="modal-btn primary full-width" id="overwrite-confirm-btn">Overwrite</button>
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
    const overlay = _createModalOverlay("builds-dialog", "SAVED BUILDS", {
        closeId:  "builds-modal-close",
        bodyId:   "builds-dialog-body",
        maxWidth: "520px",
    });
    if (!overlay) return;

    document.getElementById("builds-dialog-body").innerHTML = `
        <div class="modal-section">
            <div class="modal-label" style="display:flex; align-items:center; gap:6px;">
                BUILDS <span id="saved-builds-count" style="font-weight:400; letter-spacing:0; color:#555;"></span>
            </div>
            <input id="builds-search-input" type="text" class="search-input"
                   style="font-size: 13px; margin:0 0 8px 0; width:100%; box-sizing:border-box;"
                   placeholder="Search by build name or weapon..." />
            <div id="saved-builds-list" style="max-height:300px; overflow-y:auto; scrollbar-width:thin; scrollbar-color:#444 #111;"></div>
        </div>

        <hr class="modal-divider" />

        <div class="modal-section">
            <div class="modal-label">IMPORT BUILD</div>
            <div style="display:flex; gap:6px; align-items:center;">
                <input id="import-code-input" type="text" class="search-input"
                       style="margin:0; flex:1;"
                       placeholder="Paste build code to import..." />
                <button class="modal-btn" onclick="pasteImportCode()">Paste</button>
                <button class="modal-btn primary"
                        onclick="importBuildFromCode(document.getElementById('import-code-input').value)">Import</button>
            </div>
        </div>

        <hr class="modal-divider" />

        <div class="modal-section">
            <div class="modal-label">BACKUP</div>
            <div class="modal-row">
                <button class="modal-btn full-width" onclick="exportBuildsBackup()">Export Backup</button>
                <button class="modal-btn full-width" onclick="importBuildsFromFile()">Import from File</button>
            </div>
        </div>
    `;

    renderSavedBuildsList();

    const searchInput = document.getElementById("builds-search-input");
    searchInput.addEventListener("input", () => renderSavedBuildsList(searchInput.value));
}

/* ===========================
   UI — SAVED BUILDS LIST
=========================== */

// Monotonically-increasing generation counter.  Incrementing it cancels all
// running marquee cycles, which check the generation they started with before
// each await and bail out if it no longer matches.
let _marqueeGeneration = 0;

function _clearMarqueeTimers() {
    _marqueeGeneration++;
}

function _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function _initMarqueeText(container) {
    container.querySelectorAll(".marquee-text").forEach(el => {
        const parent = el.parentElement;
        if (!parent) return;

        // Measure after layout so offsetWidth is accurate
        requestAnimationFrame(async () => {
            const overflow = el.offsetWidth - parent.clientWidth;
            if (overflow <= 2) return;

            const scrollDuration = Math.max(1200, (overflow / 45) * 1000);
            const gen = _marqueeGeneration;

            async function runCycle() {
                if (_marqueeGeneration !== gen) return;

                // Snap to start
                el.style.transition = "none";
                el.style.transform = "translateX(0)";
                el.style.opacity = "1";

                // Phase 1 — pause at start
                await _sleep(800);
                if (_marqueeGeneration !== gen) return;

                // Phase 2 — scroll to end
                el.style.transition = `transform ${scrollDuration}ms linear`;
                el.style.transform = `translateX(-${overflow}px)`;
                await _sleep(scrollDuration);
                if (_marqueeGeneration !== gen) return;

                // Phase 3 — pause at end
                await _sleep(700);
                if (_marqueeGeneration !== gen) return;

                // Phase 4 — fade out
                el.style.transition = "opacity 0.35s ease";
                el.style.opacity = "0";
                await _sleep(400);
                if (_marqueeGeneration !== gen) return;

                // Phase 5 — snap back while invisible
                el.style.transition = "none";
                el.style.transform = "translateX(0)";

                // Phase 6 — fade in (double rAF ensures the transition
                // applies after the snap)
                await new Promise(resolve =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve))
                );
                if (_marqueeGeneration !== gen) return;

                el.style.transition = "opacity 0.35s ease";
                el.style.opacity = "1";

                await _sleep(1500);
                runCycle();
            }

            runCycle();
        });
    });
}

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

    if (builds.length === 0) {
        list.innerHTML = `<div style="color:#555; font-size:13px; font-style:italic; padding:4px 0 2px 0;">No saved builds yet.</div>`;
        return;
    }

    if (filtered.length === 0) {
        list.innerHTML = `<div style="color:#555; font-size:13px; font-style:italic; padding:4px 0 2px 0;">No builds match your search.</div>`;
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
                            onclick="_loadSavedBuildById(this.dataset.id)">Load</button>
                    <button class="saved-build-btn copy-btn"
                            data-id="${safeId}"
                            onclick="_copySavedBuildById(this.dataset.id)">Copy</button>
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
        showToast("Load Failed", "Build code is corrupted.", 3500);
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
// Uses slotCache (populated by installFactoryAttachment + pre-warm steps).
function buildSlotParentMap(node, map) {
    const slots = slotCache[node.item.id];
    if (slots) {
        for (const slot of slots) map[slot.id] = node;
    }
    for (const childSlotId in node.children) {
        buildSlotParentMap(node.children[childSlotId], map);
    }
}

// Load a build from a decoded payload { g: gunId, p: [[slotId, itemId], ...] }
async function loadBuildFromPayload({ g: gunId, p: pairs }, buildName = null) {
    const gun = allGuns.find(g => g.id === gunId);
    if (!gun) {
        showToast("Load Failed", "Unknown weapon in build code.", 3500);
        return;
    }

    // Clear currentGun so selectGun's early-return guard never fires
    currentGun = null;
    const dummyEl = { classList: { add() {}, remove() {} } };
    await selectGun(gun, dummyEl);
    // selectGun populates slotCache for the gun and all factory items — but we
    // don't want factory attachments in the tree; pairs represent the complete build.
    buildTree.children = {};

    // Ensure gun's own slots are in slotCache (handles guns with no factory attachments)
    if (!slotCache[gun.id]) {
        try {
            const res = await fetch(`${API_BASE}/items/${gun.id}/slots`);
            if (res.ok) cacheSet(slotCache, gun.id, await res.json());
        } catch {}
    }

    if (!pairs || pairs.length === 0) {
        await renderFullTree(false);
        await refreshBuildStats();
        const label0 = buildName ? `"${buildName}"` : `${gun.name} build`;
        showToast("Build Loaded", `${label0} loaded.`, 2500, "#4CAF50");
        return;
    }

    // Pre-fetch allowed-items for any slots not yet in allowedCache
    const uncachedSlotIds = [...new Set(
        pairs.map(([sid]) => sid).filter(sid => !allowedCache[sid])
    )];
    await Promise.all(uncachedSlotIds.map(async sid => {
        try {
            const res = await fetch(`${API_BASE}/slots/${sid}/allowed-items`);
            if (!res.ok) return;
            cacheSet(allowedCache, sid, await res.json());
        } catch {}
    }));

    // BFS install — pairs are in parent-before-child order
    let missingCount = 0;
    for (const [slotId, itemId] of pairs) {
        const allowed = allowedCache[slotId];
        if (!allowed) { missingCount++; continue; }

        const itemObj = allowed.find(i => i.id === itemId);
        if (!itemObj) { missingCount++; continue; }

        // Build slot→parent map from current tree using slotCache
        const slotToParent = {};
        buildSlotParentMap(buildTree, slotToParent);

        const parentNode = slotToParent[slotId];
        if (!parentNode) { missingCount++; continue; }

        parentNode.children[slotId] = { item: itemObj, children: {} };

        // Pre-warm slotCache for the newly placed item so its child slots
        // appear in the map for subsequent pairs
        if (!slotCache[itemObj.id]) {
            try {
                const res = await fetch(`${API_BASE}/items/${itemObj.id}/slots`);
                if (res.ok) cacheSet(slotCache, itemObj.id, await res.json());
            } catch {}
        }
    }

    processedCache = {};
    collapsedSlots = {};
    lastParentNode = null;
    lastSlot = null;
    await renderFullTree(false);
    await refreshBuildStats();

    const label = buildName ? `"${buildName}"` : `${gun.name} build`;
    if (missingCount > 0) {
        showToast(
            "Partial Load",
            `${missingCount} attachment(s) could not be found.\nGame data may have been updated.`,
            5000
        );
    } else {
        showToast("Build Loaded", `${label} loaded.`, 2500, "#4CAF50");
    }
}

// Import a build from a raw code string (from the import input)
async function importBuildFromCode(code) {
    if (!code || !code.trim()) return;
    const payload = decodeBuildCode(code.trim());
    if (!payload) {
        showToast("Import Failed", "Invalid or corrupted build code.", 3500);
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
    const backup = {
        appVersion: APP_VERSION,
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
    showToast("Backup Exported", `${data.builds.length} build(s) saved to file.`, 2500, "#4CAF50");
}

function importBuildsFromFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.addEventListener("change", async () => {
        const file = input.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const backup = JSON.parse(text);
            if (!backup.appVersion || !Array.isArray(backup.builds)) {
                showToast("Import Failed", "Invalid backup file.", 3500);
                return;
            }
            _showBackupModeModal(backup);
        } catch {
            showToast("Import Failed", "Could not read backup file.", 3500);
        }
    });
    input.click();
}

function _showBackupModeModal(backup) {
    const overlay = _createModalOverlay("backup-mode-dialog", "IMPORT BACKUP", {
        closeId:  "backup-mode-close",
        bodyId:   "backup-mode-body",
        maxWidth: "400px",
    });
    if (!overlay) return;

    document.getElementById("backup-mode-body").innerHTML = `
        <div class="modal-section">
            <div style="font-size:13px; color:#aaa; margin-bottom:14px; line-height:1.6;">
                <span style="color:#eee;">${escapeHtml(String(backup.builds.length))} build(s)</span>
                from version <span style="color:#eee;">${escapeHtml(backup.appVersion)}</span>
            </div>
            <div class="modal-label">IMPORT MODE</div>
            <div class="modal-row">
                <button class="modal-btn primary full-width" id="backup-merge-btn">Merge into Existing</button>
                <button class="modal-btn full-width" id="backup-overwrite-btn">Overwrite All</button>
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
        overwriteBtn.textContent = "Confirm?";
        overwriteBtn.style.background = "#3d0f0f";
        overwriteBtn.style.borderColor = "#f44336";

        const revert = () => {
            overwriteBtn.dataset.confirming = "";
            overwriteBtn.textContent = "Overwrite All";
            overwriteBtn.style.background = "";
            overwriteBtn.style.borderColor = "";
            overwriteBtn.removeEventListener("mouseleave", revert);
        };
        overwriteBtn.addEventListener("mouseleave", revert);
    });
}

function _maybeWarnVersionThenApply(backup, mode) {
    if (backup.appVersion !== APP_VERSION) {
        const body = document.getElementById("backup-mode-body");
        if (!body) return;

        body.innerHTML = `
            <div class="modal-section">
                <div style="font-size:14px; line-height:1.6; margin-bottom:14px;">
                    <span style="color:#f5c542;">&#9888; Version Mismatch</span><br>
                    <span style="color:#aaa; font-size:13px;">
                        This backup was created with
                        <strong style="color:#eee;">${escapeHtml(backup.appVersion)}</strong>
                        (current: <strong style="color:#eee;">${escapeHtml(APP_VERSION)}</strong>).
                        It may cause issues.
                    </span>
                </div>
                <div class="modal-label">ARE YOU SURE?</div>
                <div class="modal-row">
                    <button class="modal-btn full-width" id="backup-warn-cancel">Cancel</button>
                    <button class="modal-btn primary full-width" id="backup-warn-continue">Continue</button>
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
        showToast("Backup Imported", `${backup.builds.length} build(s) loaded.`, 2500, "#4CAF50");
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
                <button class="modal-btn mc-res-btn" data-idx="${i}" data-action="overwrite">Overwrite</button>
                <button class="modal-btn mc-res-btn mc-active" data-idx="${i}" data-action="skip">Skip</button>
                <button class="modal-btn mc-res-btn" data-idx="${i}" data-action="rename">Rename</button>
            </div>
            <div id="mc-rename-row-${i}" style="display:none; margin-top:7px;">
                <input id="mc-rename-input-${i}" type="text" class="search-input"
                       style="font-size:13px; margin:0; width:100%; box-sizing:border-box;"
                       placeholder="New build name..."
                       maxlength="60"
                       value="${escapeHtml(build.name)}" />
                <div id="mc-rename-err-${i}" style="font-size:12px; color:#f44336; min-height:14px; margin-top:3px;"></div>
            </div>
        </div>
    `).join("");

    const countLabel = `<span style="font-size:12px; color:#555; margin-left:auto; margin-right:10px;">${conflicts.length} conflict${conflicts.length !== 1 ? "s" : ""}</span>`;
    _createModalOverlay("merge-conflict-dialog", "NAME CONFLICTS", {
        closeId:    "mc-close-btn",
        bodyId:     "mc-dialog-body",
        maxWidth:   "460px",
        titleExtra: countLabel,
    });

    document.getElementById("mc-dialog-body").innerHTML = `
        <div class="modal-section">
            <div style="font-size:13px; color:#777; margin-bottom:10px;">
                These builds already exist. Choose how to handle each one.
            </div>
            <div id="mc-conflict-list" style="max-height:360px; overflow-y:auto; scrollbar-width:thin; scrollbar-color:#444 #111;">
                ${rowsHtml}
            </div>
        </div>
        <div class="modal-row" style="margin-top:14px;">
            <button class="modal-btn full-width" id="mc-cancel-btn">Cancel</button>
            <button class="modal-btn primary full-width" id="mc-confirm-btn">Confirm All</button>
        </div>
    `;

    // Inject active-button style if not already present
    if (!document.getElementById("mc-btn-style")) {
        const style = document.createElement("style");
        style.id = "mc-btn-style";
        style.textContent = `.mc-active { background:#333 !important; color:#eee !important; border-color:#666 !important; }`;
        document.head.appendChild(style);
    }

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
    const overlay = document.getElementById("merge-conflict-dialog");
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
                errEl.textContent = "Name cannot be empty.";
                hasError = true;
                continue;
            }
            const conflictsWithExisting = existingBuilds.some(
                e => e.gunId === conflicts[i].gunId && e.name.toLowerCase() === newName.toLowerCase()
            );
            if (conflictsWithExisting) {
                errEl.textContent = "That name already exists for this weapon.";
                hasError = true;
                continue;
            }
            const batchKey = `${conflicts[i].gunId}|${newName.toLowerCase()}`;
            if (renamedNames.includes(batchKey)) {
                errEl.textContent = "Duplicate rename within this import.";
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
    showToast("Backup Imported", `${totalImported} build(s) imported.`, 2500, "#4CAF50");
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
        showToast("Paste Failed", "Could not access clipboard.", 3000);
    }
}
