/* ============================================================
   BUILD MANAGER
   Save, Reset, and Share build functionality.
   Accesses globals defined in app.js (buildTree, currentGun, etc.)
============================================================ */

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
    if (document.getElementById("save-build-dialog")) return;

    const overlay = document.createElement("div");
    overlay.id = "save-build-dialog";
    overlay.className = "modal-overlay";

    overlay.innerHTML = `
        <div class="modal-window" id="save-build-modal-window">
            <div class="modal-header">
                <span class="modal-title">SAVE &amp; SHARE</span>
                <button class="modal-close-btn" id="modal-close-x">&#x2715;</button>
            </div>
            <div class="modal-body" id="save-build-modal-body"></div>
        </div>
    `;

    document.body.appendChild(overlay);

    _renderSaveBuildBody(currentGun.name);

    document.getElementById("modal-close-x").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
}

function _renderSaveBuildBody(prefill) {
    const body = document.getElementById("save-build-modal-body");
    if (!body || !currentGun) return;

    body.innerHTML = `
        <div class="modal-section">
            <div class="modal-label">SAVE BUILD</div>
            <div class="modal-row">
                <input id="save-build-name" type="text" class="search-input"
                       style="margin:0; flex:1; min-width:0;"
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
    if (document.getElementById("builds-dialog")) return;

    const overlay = document.createElement("div");
    overlay.id = "builds-dialog";
    overlay.className = "modal-overlay";

    overlay.innerHTML = `
        <div class="modal-window" style="max-width:520px;">
            <div class="modal-header">
                <span class="modal-title">SAVED BUILDS</span>
                <button class="modal-close-btn" id="builds-modal-close">&#x2715;</button>
            </div>
            <div class="modal-body">

                <div class="modal-section">
                    <div class="modal-label" style="display:flex; align-items:center; gap:6px;">
                        BUILDS <span id="saved-builds-count" style="font-weight:400; letter-spacing:0; color:#555;"></span>
                    </div>
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

            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    renderSavedBuildsList();

    document.getElementById("builds-modal-close").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
}

/* ===========================
   UI — SAVED BUILDS LIST
=========================== */

function renderSavedBuildsList() {
    const list = document.getElementById("saved-builds-list");
    const countEl = document.getElementById("saved-builds-count");
    if (!list || !countEl) return;

    const { builds } = loadSavedBuilds();

    countEl.textContent = builds.length > 0 ? `(${builds.length})` : "";

    if (builds.length === 0) {
        list.innerHTML = `<div style="color:#555; font-size:13px; font-style:italic; padding:4px 0 2px 0;">No saved builds yet.</div>`;
        return;
    }

    list.innerHTML = builds.map(entry => {
        const safeId = escapeHtml(entry.id);
        return `
            <div class="saved-build-card">
                <div class="saved-build-info">
                    <div class="saved-build-name">${escapeHtml(entry.name)}</div>
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
                            onclick="deleteSavedBuild(this.dataset.id)">&#x2715;</button>
                </div>
            </div>
        `;
    }).join("");
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
