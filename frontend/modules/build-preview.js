window.EFTForge = window.EFTForge || {};

// ============================================================
// LIVE BUILD IMAGE PREVIEW
//
// Converts the current buildTree into SPT-format items, sends
// them to our backend proxy, which forwards to the tarkov-changes
// image-gen API (image-gen.tarkov-changes.com/api/generate-build).
// The returned image URL is displayed in the gun cell of the
// attachment grid and in the placeholder panel.
//
// Slot names (mod_barrel, mod_stock, ...) come from slotCache
// which stores {id, slot_name} for every slot we've seen.
// ============================================================

let _bpInflight         = false;
let _bpPendingKey       = null;   // key waiting to be generated
let _bpLastKey          = null;   // key of the image currently displayed
let _bpLastImageUrl     = null;   // URL currently displayed in the gun cell
let _bpPlaceholderUrl   = null;   // URL shown on the placeholder (persists across attachment changes)

// --- Img gen enabled toggle ----------------------------------

const _BP_STORAGE_KEY = "eftforge_imggen_enabled";
let _bpEnabled = localStorage.getItem(_BP_STORAGE_KEY) !== "false";

function toggleImgGen() {
    _bpEnabled = !_bpEnabled;
    localStorage.setItem(_BP_STORAGE_KEY, String(_bpEnabled));

    // Update all toggle buttons (rendered in both tree.js and attachment-grid.js)
    document.querySelectorAll(".bp-imggen-toggle").forEach(btn => {
        btn.classList.toggle("active", _bpEnabled);
    });

    if (!_bpEnabled) {
        // Clear any in-progress state and revert images to static tarkov.dev sources
        clearTimeout(_bpDebounceTimer);
        _bpPendingKey     = null;
        _bpLastKey        = null;
        _bpLastImageUrl   = null;
        _bpPlaceholderUrl = null;
        const gun = EFTForge.state.currentGun;
        if (gun) {
            const gunCellImg = document.querySelector(".ag-gun-cell img");
            if (gunCellImg) { gunCellImg.src = gun.image_512_link || gun.icon_link || ""; gunCellImg.style.opacity = "1"; }
            const placeholder = document.getElementById("gun-display-image");
            if (placeholder) { placeholder.src = gun.image_512_link || gun.icon_link || ""; }
        }
    } else if (EFTForge.state.currentGun) {
        scheduleBuildPreview();
    }
}

window.toggleImgGen = toggleImgGen;

// --- Helpers -------------------------------------------------

function _bpPairsKey() {
    const tree = EFTForge.state.buildTree;
    if (!tree) return "";
    // reuse the same key logic as the rest of the app
    return collectSlotPairs(tree).map(p => p.join(":")).sort().join(",");
}

// Produce a deterministic 24-char hex string from an arbitrary string.
// The API requires MongoDB ObjectId-style _id values (24 hex chars).
// We use a simple but stable two-seed MurmurHash-inspired mix so the same
// build always maps to the same IDs (cache-friendly) without needing crypto.
function _bpHex24(str) {
    let h1 = 0x6b4a1c7f, h2 = 0x3e9d5a2b, h3 = 0xd1e4c7a9;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x9e3779b9) >>> 0;
        h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
        h3 = Math.imul(h3 ^ c, 0xc2b2ae35) >>> 0;
        h1 ^= (h2 >>> 13) ^ (h3 >>> 7);
        h2 ^= (h1 >>> 17) ^ (h3 >>> 5);
        h3 ^= (h1 >>> 11) ^ (h2 >>> 19);
    }
    h1 = (h1 ^ h2 ^ h3) >>> 0;
    h2 = (h2 ^ (h1 * 0x27d4eb2d)) >>> 0;
    h3 = (h3 ^ (h2 * 0x165667b1)) >>> 0;
    return [h1, h2, h3].map(v => ('00000000' + v.toString(16)).slice(-8)).join('');
}

// Walk buildTree and build the SPT-format items array.
// Each item needs: _id, _tpl, slotId (game name like mod_barrel), parentId.
// We resolve slot names from EFTForge.state.slotCache.
function _bpBuildSptItems() {
    const gun  = EFTForge.state.currentGun;
    const tree = EFTForge.state.buildTree;
    if (!gun || !tree) return null;

    // Use a 24-char hex key for the gun instance so the API sees a valid ObjectId.
    // The merge script replaces items[0] with the site's natural gun item anyway,
    // but we still need a stable key to track parentId references in our attachments.
    const gunInstanceId = _bpHex24(gun.id + ":root");
    const items = [{
        _id:      gunInstanceId,
        _tpl:     gun.id,
        slotId:   "hideout",
        parentId: "hideout",
    }];

    function walk(node, parentItemId, parentInstanceId) {
        const parentSlots = EFTForge.state.slotCache[parentItemId] || [];
        for (const slotId in node.children) {
            const child    = node.children[slotId];
            const slotMeta = parentSlots.find(s => s.id === slotId);
            if (!slotMeta) continue; // slot not in cache - skip

            // Use the EFT internal slot name (mod_pistol_grip, mod_barrel, etc.)
            // which is what the image-gen API expects for slotId.
            // Fall back to slot_name (display name) only if slot_game_name is absent.
            const gameSlotName = slotMeta.slot_game_name || slotMeta.slot_name;

            // Deterministic 24-char hex instance ID
            const instanceId = _bpHex24(parentInstanceId + ":" + gameSlotName);
            items.push({
                _id:      instanceId,
                _tpl:     child.item.id,
                slotId:   gameSlotName,
                parentId: parentInstanceId,
            });
            walk(child, child.item.id, instanceId);
        }
    }

    walk(tree, gun.id, gunInstanceId);
    return { id: gun.id, items };
}

// Apply url to the placeholder element. Called on success and after every
// renderFullTree to re-stamp the image over whatever the render put there.
function _bpSetPlaceholder(url) {
    const img = document.getElementById("gun-display-image");
    if (!img) return;
    img.src           = url;
    img.style.display = "";
    img.style.opacity = "1";
}

// Update every image element that should show the build preview.
// Passing null resets the gun cell to the factory image but leaves
// the placeholder showing the last generated image.
function _bpApplyImageUrl(url) {
    _bpLastImageUrl = url;

    // Gun cell: always reflects current state (factory while regenerating)
    const gunCellImg = document.querySelector(".ag-gun-cell img");
    if (gunCellImg) {
        gunCellImg.src           = url || (EFTForge.state.currentGun?.image_512_link || EFTForge.state.currentGun?.icon_link || "");
        gunCellImg.style.opacity = "1";
    }

    // Placeholder: only update when we have a real generated URL so it
    // keeps showing the previous composite while a new one is generating.
    if (url) {
        _bpPlaceholderUrl = url;
        _bpSetPlaceholder(url);
    }
}

// Apply a static tarkov.dev image to both the gun cell and the placeholder
// without firing an image-gen request. Stores the url in _bpPlaceholderUrl
// so it is re-stamped correctly after every renderFullTree cycle.
function _bpApplyStatic(staticUrl) {
    _bpLastImageUrl   = staticUrl || null;
    _bpPlaceholderUrl = staticUrl || null;

    const gunCellImg = document.querySelector(".ag-gun-cell img");
    if (gunCellImg) {
        gunCellImg.src           = staticUrl || "";
        gunCellImg.style.opacity = "1";
    }

    if (staticUrl) _bpSetPlaceholder(staticUrl);
}

// Show a "generating..." state while waiting for the API.
function _bpSetLoading(isLoading) {
    if (!_bpEnabled) return;
    const gunCellImg = document.querySelector(".ag-gun-cell img");
    if (gunCellImg) gunCellImg.style.opacity = isLoading ? "0.35" : "1";

    // Dim the placeholder only when there is a generated image showing there.
    if (_bpPlaceholderUrl) {
        const img = document.getElementById("gun-display-image");
        if (img) img.style.opacity = isLoading ? "0.35" : "1";
    }
}

// Returns a Promise that resolves once the given img element's current src
// has finished loading (or immediately if already complete / on error).
// Caps at 5 s so a broken image never leaves the UI permanently dimmed.
function _bpWaitForImgLoad(img) {
    return new Promise(resolve => {
        if (!img || img.complete) { resolve(); return; }
        const done = () => resolve();
        img.addEventListener("load",  done, { once: true });
        img.addEventListener("error", done, { once: true });
        setTimeout(resolve, 5000);
    });
}

// --- Core generate function ----------------------------------

async function _bpGenerate(key) {
    const gun = EFTForge.state.currentGun;

    // No attachments - use bare gun body image from tarkov.dev.
    if (key === "") {
        _bpLastKey = key;
        _bpApplyStatic(gun.bare_image_512_link || gun.image_512_link || gun.icon_link);
        return;
    }

    // Factory configuration - factoryPairsKey uses the same collectSlotPairs
    // format as _bpPairsKey, so a direct string compare is reliable.
    if (key === EFTForge.state.factoryPairsKey) {
        _bpLastKey = key;
        _bpApplyStatic(gun.image_512_link || gun.icon_link);
        return;
    }

    // Custom build - fire the image gen request.
    _bpInflight = true;
    _bpSetLoading(true);

    try {
        const sptData = _bpBuildSptItems();
        if (!sptData) {
            _bpApplyImageUrl(null);
            return;
        }

        // Check if another user's generation is already in flight on the server.
        // The server serializes requests through a single lock, so we'll be queued.
        try {
            const busyResp = await fetch(`${EFTForge.config.API_BASE}/build-image/busy`);
            if (busyResp.ok) {
                const busyData = await busyResp.json();
                if (busyData.busy) {
                    const t = EFTForge.lang.t;
                    EFTForge.utils.showToast(t("toast.imgGenQueued"), t("toast.imgGenQueuedMsg"), 5000, "#f5c542");
                }
            }
        } catch (_) {}

        const resp = await fetch(
            `${EFTForge.config.API_BASE}/build-image`,
            {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify(sptData),
            }
        );

        if (!resp.ok) {
            console.warn("[build-preview] backend returned", resp.status);
            _bpApplyImageUrl(null);
            if (resp.status === 502) {
                const t = EFTForge.lang.t;
                EFTForge.utils.showToast(t("toast.imgGenFailed"), t("toast.imgGenFailedMsg"), 4000, "#f44336");
            }
            return;
        }

        const data = await resp.json();
        if (data.image_url) {
            _bpLastKey = key;
            _bpApplyImageUrl(data.image_url);
            // Wait for both visible images to finish loading before undimming.
            // Without this the opacity resets while the browser is still fetching
            // the new src, causing a visible flash of the dimmed factory image.
            const gunCellImg  = document.querySelector(".ag-gun-cell img");
            const placeholder = document.getElementById("gun-display-image");
            await Promise.all([
                _bpWaitForImgLoad(gunCellImg),
                _bpWaitForImgLoad(placeholder),
            ]);
        } else {
            console.warn("[build-preview] no image_url in response", data);
            _bpApplyImageUrl(null);
        }
    } catch (err) {
        console.warn("[build-preview] failed:", err);
        _bpApplyImageUrl(null);
    } finally {
        _bpInflight = false;
        _bpSetLoading(false);

        // If a newer key arrived while we were in-flight, generate it now
        if (_bpPendingKey && _bpPendingKey !== _bpLastKey) {
            const next = _bpPendingKey;
            _bpPendingKey = null;
            _bpGenerate(next);
        }
    }
}

// --- Debounced public entry point ----------------------------

let _bpDebounceTimer = null;

function scheduleBuildPreview() {
    if (!_bpEnabled || !EFTForge.state.gridView || !EFTForge.state.currentGun) return;

    const key = _bpPairsKey();

    // Already showing this key - nothing to do
    if (key === _bpLastKey && _bpLastImageUrl) return;

    _bpPendingKey = key;
    clearTimeout(_bpDebounceTimer);
    _bpDebounceTimer = setTimeout(() => {
        if (!_bpInflight) {
            const k = _bpPendingKey;
            _bpPendingKey = null;
            _bpGenerate(k);
        }
        // If inflight, the finally-block will pick up _bpPendingKey
    }, 350);
}

// Reset state when the gun changes
function resetBuildPreview() {
    clearTimeout(_bpDebounceTimer);
    _bpLastKey        = null;
    _bpLastImageUrl   = null;
    _bpPlaceholderUrl = null;
    _bpPendingKey     = null;
}

// --- Hook into renderFullTree --------------------------------
// attachment-grid.js has already overridden window.renderFullTree
// to dispatch between grid and list. We chain on top of that.

(function () {
    const _prev = window.renderFullTree;
    window.renderFullTree = function (preserveScroll) {
        const result = _prev(preserveScroll);
        if (EFTForge.state.gridView && EFTForge.state.currentGun) {
            Promise.resolve(result).then(() => {
                // Re-stamp the placeholder after every render - the render cycle
                // Re-stamp the gun cell - renderFullTree recreates the ag-gun-cell
                // element from scratch with the factory image src every render.
                if (_bpEnabled && _bpLastImageUrl) {
                    const gunCellImg = document.querySelector(".ag-gun-cell img");
                    if (gunCellImg) {
                        gunCellImg.src           = _bpLastImageUrl;
                        gunCellImg.style.opacity = _bpInflight ? "0.35" : "1";
                    }
                }
                // resets gun-display-image src to the factory image.
                if (_bpPlaceholderUrl) _bpSetPlaceholder(_bpPlaceholderUrl);
                scheduleBuildPreview();
            }).catch(() => {});
        }
        return result;
    };
})();

window.scheduleBuildPreview = scheduleBuildPreview;
window.resetBuildPreview    = resetBuildPreview;
