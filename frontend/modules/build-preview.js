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

let _bpInflight       = false;
let _bpPendingKey     = null;   // key waiting to be generated
let _bpLastKey        = null;   // key of the image currently displayed
let _bpLastImageUrl   = null;   // URL currently displayed

// --- Helpers -------------------------------------------------

function _bpPairsKey() {
    const tree = EFTForge.state.buildTree;
    if (!tree) return "";
    // reuse the same key logic as the rest of the app
    return collectSlotPairs(tree).map(p => p.join(":")).sort().join(",");
}

// Walk buildTree and build the SPT-format items array.
// Each item needs: _id, _tpl, slotId (game name like mod_barrel), parentId.
// We resolve slot names from EFTForge.state.slotCache.
function _bpBuildSptItems() {
    const gun  = EFTForge.state.currentGun;
    const tree = EFTForge.state.buildTree;
    if (!gun || !tree) return null;

    const gunInstanceId = gun.id + ":root";
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
            const slotName = slotMeta?.slot_name;
            if (!slotName) continue; // can't resolve - skip

            // Deterministic instance ID so the same build always hits cache
            const instanceId = parentInstanceId + ":" + slotName;
            items.push({
                _id:      instanceId,
                _tpl:     child.item.id,
                slotId:   slotName,
                parentId: parentInstanceId,
            });
            walk(child, child.item.id, instanceId);
        }
    }

    walk(tree, gun.id, gunInstanceId);
    return { id: gun.id, items };
}

// Update every image element that should show the build preview.
function _bpApplyImageUrl(url) {
    _bpLastImageUrl = url;

    // 1. The gun cell in the attachment grid (the centrepiece of the spatial layout)
    const gunCellImg = document.querySelector(".ag-gun-cell img");
    if (gunCellImg) {
        gunCellImg.src            = url || (EFTForge.state.currentGun?.image_512_link || EFTForge.state.currentGun?.icon_link || "");
        gunCellImg.style.opacity  = "1";
    }

    // 2. The placeholder panel header image (visible when no slot is selected)
    const placeholderImg = document.getElementById("gun-display-image");
    if (placeholderImg && url) {
        placeholderImg.src           = url;
        placeholderImg.style.display = "";
        placeholderImg.style.opacity = "1";
        // Widen the max-height so the taller composite image isn't squashed
        placeholderImg.style.maxHeight = "200px";
    }
}

// Show a "generating..." state on the gun cell while waiting.
function _bpSetLoading(isLoading) {
    const gunCellImg = document.querySelector(".ag-gun-cell img");
    if (gunCellImg) gunCellImg.style.opacity = isLoading ? "0.35" : "1";
}

// --- Core generate function ----------------------------------

async function _bpGenerate(key) {
    _bpInflight = true;
    _bpSetLoading(true);

    try {
        const sptData = _bpBuildSptItems();
        if (!sptData || sptData.items.length < 2) {
            // Only the gun itself, no attachments - fall back to plain gun image
            _bpApplyImageUrl(null);
            return;
        }

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
            return;
        }

        const data = await resp.json();
        if (data.image_url) {
            _bpLastKey = key;
            _bpApplyImageUrl(data.image_url);
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
    if (!EFTForge.state.gridView || !EFTForge.state.currentGun) return;

    const key = _bpPairsKey();

    // Already showing this key - nothing to do
    if (key === _bpLastKey && _bpLastImageUrl) return;

    // If the key changed (new gun or build changed), immediately revert to
    // the plain gun image so the stale composite doesn't linger
    if (key !== _bpLastKey) {
        _bpApplyImageUrl(null);
    }

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
    _bpLastKey      = null;
    _bpLastImageUrl = null;
    _bpPendingKey   = null;
}

// --- Hook into renderFullTree --------------------------------
// attachment-grid.js has already overridden window.renderFullTree
// to dispatch between grid and list. We chain on top of that.

(function () {
    const _prev = window.renderFullTree;
    window.renderFullTree = function (preserveScroll) {
        const result = _prev(preserveScroll);
        if (EFTForge.state.gridView && EFTForge.state.currentGun) {
            Promise.resolve(result).then(() => scheduleBuildPreview()).catch(() => {});
        }
        return result;
    };
})();

window.scheduleBuildPreview = scheduleBuildPreview;
window.resetBuildPreview    = resetBuildPreview;
