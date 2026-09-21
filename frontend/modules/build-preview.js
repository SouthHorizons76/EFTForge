window.EFTForge = window.EFTForge || {};

/* exported _bpBuildSptItemsForPairs -- called from other modules */

// ============================================================
// LIVE BUILD IMAGE PREVIEW
//
// Converts the current buildTree into SPT-format items and sends
// them to the backend, which draws the build with Kitbash!.
// The returned image URL is displayed in the gun cell of the
// attachment grid and in the placeholder panel.
//
// Slot names (mod_barrel, mod_stock, ...) come from slotCache
// which stores {id, slot_name} for every slot we've seen.
// ============================================================

let _bpInflight         = false;
let _bpAbortController  = null;   // AbortController for the current in-flight fetch
let _bpRevision = 0;
let _bpDesiredId = null;
let _bpLastGunId = null;
let _bpLastKey          = null;   // key of the image currently displayed
let _bpLastAmmoKey      = "";     // and the rounds loaded into it (see _bpAmmoKey)
let _bpLastImageUrl     = null;   // URL currently displayed in the gun cell
let _bpPlaceholderUrl   = null;   // URL shown on the placeholder (persists across attachment changes)
let _bpLastIsCommunityCard = false; // true when the above URLs are a Gitee-hosted community build card - needs referrerPolicy="no-referrer"

// --- Img gen enabled toggle ----------------------------------

const _BP_STORAGE_KEY = "eftforge_imggen_enabled";

// One-time migration: force the toggle off for everyone the first time this
// ships, regardless of whatever value was stored before. Once the marker is
// set, we go back to respecting whatever the user has chosen since.
const _BP_DEFAULT_OFF_MIGRATION_KEY = "eftforge_imggen_default_off_v1";
if (!localStorage.getItem(_BP_DEFAULT_OFF_MIGRATION_KEY)) {
    localStorage.setItem(_BP_STORAGE_KEY, "false");
    localStorage.setItem(_BP_DEFAULT_OFF_MIGRATION_KEY, "1");
}

let _bpEnabled = localStorage.getItem(_BP_STORAGE_KEY) !== "false";

// True when an admin has globally disabled image generation server-side, the
// server has no Kitbash! install, or the desktop app runs in local mode
// (previews are drawn by EFTForge.com, so they can never work locally).
let _bpGlobalDisabled = !!(window.EFTForge?.config?.COMMUNITY_DISABLED);

// Tooltip for the disabled toggle - local mode gets its own explanation.
function _bpDisabledTip() {
    return EFTForge.lang.t(
        EFTForge.config?.COMMUNITY_DISABLED ? "bp.localModeTip" : "toast.imgGenDisabledTip"
    );
}

function _bpApplyGlobalDisabledClass() {
    const tip = _bpGlobalDisabled ? _bpDisabledTip() : null;
    document.querySelectorAll(".bp-imggen-toggle").forEach(btn => {
        btn.classList.toggle("bp-imggen-globally-disabled", _bpGlobalDisabled);
        if (tip) {
            btn.dataset.tooltip = tip;
        } else {
            delete btn.dataset.tooltip;
        }
    });
}

function _bpSetGlobalDisabled(disabled) {
    _bpGlobalDisabled = disabled;
    _bpApplyGlobalDisabledClass();
    if (disabled) {
        // Abort any in-flight generation
        _bpCancelPending();
    }
}

async function initBpGlobalStatus() {
    // Desktop local mode: /build-image is blocked entirely - stay disabled
    // without asking the server.
    if (EFTForge.config?.COMMUNITY_DISABLED) {
        _bpSetGlobalDisabled(true);
        return;
    }
    try {
        const resp = await fetch(`${EFTForge.config.API_BASE}/build-image/status`);
        if (resp.ok) {
            const data = await resp.json();
            if (typeof data.disabled === "boolean") {
                _bpSetGlobalDisabled(data.disabled);
            }
        }
    } catch (_) {}
}

window.initBpGlobalStatus = initBpGlobalStatus;

function toggleImgGen() {
    if (_bpGlobalDisabled) return;
    _bpApplyToggle(!_bpEnabled);
}

function _bpApplyToggle(next) {
    _bpEnabled = next;
    localStorage.setItem(_BP_STORAGE_KEY, String(_bpEnabled));

    // Update all toggle buttons (rendered in both tree.js and attachment-grid.js)
    document.querySelectorAll(".bp-imggen-toggle").forEach(btn => {
        btn.classList.toggle("active", _bpEnabled);
    });

    if (!_bpEnabled) {
        // Clear any in-progress state and revert images to static tarkov.dev sources
        _bpCancelPending();
        _bpLastGunId = null;
        _bpLastKey        = null;
        _bpLastImageUrl   = null;
        _bpPlaceholderUrl = null;
        _bpLastIsCommunityCard = false;
        const gun = EFTForge.state.currentGun;
        if (gun) {
            const staticSrc  = gun.image_512_link || gun.icon_link || "";
            const gunCellImg = document.querySelector(".ag-gun-cell img");
            if (gunCellImg) { gunCellImg.src = staticSrc; gunCellImg.style.opacity = ""; gunCellImg.style.filter = ""; }
            const tableImg = _bpGetListViewImg();
            if (tableImg) { tableImg.src = staticSrc; tableImg.style.opacity = "1"; }
            const placeholder = document.getElementById("gun-display-image");
            if (placeholder) { placeholder.src = staticSrc; }
        }
    } else if (EFTForge.state.currentGun) {
        scheduleBuildPreview();
    }
}

window.toggleImgGen = toggleImgGen;

// --- Helpers -------------------------------------------------

// In list view the gun img lives in the attachment table header, not the grid gun cell.
function _bpGetListViewImg() {
    return document.querySelector(".att-table-header .att-table-gun-img");
}

function _bpPairsKey() {
    const tree = EFTForge.state.buildTree;
    if (!tree) return "";
    // reuse the same key logic as the rest of the app
    return collectSlotPairs(tree).map(p => p.join(":")).sort().join(",");
}

// The rounds a render loads, as /build-image takes them: with "Assume Full
// Magazine" on, the build's magazine holding the selected ammo and a UBGL its
// grenade. Null when nothing would be drawn loaded, so the image (and its cache
// entry) stays the empty build's. Every magazine in the game sits in mod_magazine.
function _bpAmmoFor(ammoId, ubglAmmoId, hasMagazine) {
    if (!hasMagazine) ammoId = null;
    if (!(EFTForge.state.assumeFullMag ?? true) || !(ammoId || ubglAmmoId)) return null;
    return { assume_full_mag: true, selected_ammo_id: ammoId || null, selected_ubgl_ammo_id: ubglAmmoId || null };
}

// Whether (gun, pairs) fills a mod_magazine slot, by the slot names cached for
// the gun and its parts; null while any of those is not cached yet.
function _bpPairsHaveMagazine(gun, pairs) {
    const names = {};
    for (const id of [gun.id, ...pairs.map(([, iid]) => iid)]) {
        const slots = EFTForge.state.slotCache[id];
        if (!slots) return null;
        for (const s of slots) names[s.id] = s.slot_game_name || s.slot_name;
    }
    return pairs.some(([sid]) => names[sid] === "mod_magazine");
}

// The builder's selected rounds loaded into `sptData` (default: the live build).
// The UBGL selector keeps its last value while its row is hidden, so only count
// it when a UBGL is installed.
function _bpAmmo(sptData = _bpBuildSptItems()) {
    const ubglRow = document.getElementById("ubgl-ammo-row");
    const ubgl = ubglRow && ubglRow.style.display !== "none"
        ? document.getElementById("ubgl-ammo-select")?.value : null;
    const hasMagazine = !!sptData?.items.some(it => it.slotId === "mod_magazine");
    return _bpAmmoFor(document.getElementById("ammo-select")?.value, ubgl, hasMagazine);
}

function _bpAmmoKey(ammo) {
    return ammo ? `${ammo.selected_ammo_id || ""}+${ammo.selected_ubgl_ammo_id || ""}` : "";
}

// What a live preview image depends on: the parts and the rounds in them.
function _bpViewKey() {
    return _bpPairsKey() + "#" + _bpAmmoKey(_bpAmmo());
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

// Walk an install tree ({children: {slotId: {item, children}}}) and build the
// SPT-format items array. Each item needs: _id, _tpl, slotId (game name like
// mod_barrel), parentId. We resolve slot names from EFTForge.state.slotCache.
function _bpWalkTreeToSptItems(gun, tree) {
    // Use a 24-char hex key for the gun instance so the API sees a valid ObjectId,
    // stable so parentId references in our attachments line up.
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
            if (!slotMeta) return false;

            // Use the EFT internal slot name (mod_pistol_grip, mod_barrel, etc.)
            // which is what Kitbash! expects for slotId.
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
            if (!walk(child, child.item.id, instanceId)) return false;
        }
        return true;
    }

    // Decline incomplete payloads instead of silently dropping attachments.
    if (!tree || !walk(tree, gun.id, gunInstanceId)) return null;
    return { id: gun.id, items };
}

function _bpBuildSptItems() {
    const gun  = EFTForge.state.currentGun;
    const tree = EFTForge.state.buildTree;
    if (!gun || !tree) return null;
    return _bpWalkTreeToSptItems(gun, tree);
}

// Reconstruct a minimal install tree from flat [slotId, itemId] pairs (the
// shape a tab record stores its build in) using the global slotCache to
// resolve each pair's parent node - same linkage logic as build-manager.js's
// buildSlotParentMap, just re-run per pair since we don't have a live tree.
// Pairs are expected in parent-before-child order (how collectSlotPairs emits
// them), matching every place pairs are produced in this codebase.
function _bpTreeFromPairs(gun, pairs) {
    const root = { item: { id: gun.id }, children: {} };

    // slotId -> the node that owns that slot. Built once from the root and
    // extended as each node is attached: a newly attached node can only ever
    // contribute its own slots, so re-walking the whole tree per pair (which is
    // what this used to do, quadratic in attachment count) buys nothing.
    const slotToParent = {};
    function addSlots(node) {
        const slots = EFTForge.state.slotCache[node.item.id] || [];
        for (const slot of slots) slotToParent[slot.id] = node;
    }
    addSlots(root);

    for (const [slotId, itemId] of pairs) {
        const parent = slotToParent[slotId];
        if (!parent) return null;
        const node = { item: { id: itemId }, children: {} };
        parent.children[slotId] = node;
        addSlots(node);
    }
    return root;
}

// Same as _bpBuildSptItems but for an arbitrary (gun, pairs) instead of the
// live currentGun/buildTree - used by the tab hover preview to generate an
// image for a background tab without disturbing the active build's state.
function _bpBuildSptItemsForPairs(gun, pairs) {
    if (!gun) return null;
    return _bpWalkTreeToSptItems(gun, _bpTreeFromPairs(gun, pairs || []));
}

let _bpStateNotificationPending = false;

function _bpNotifyStateChange() {
    if (_bpStateNotificationPending) return;
    _bpStateNotificationPending = true;
    // Publish the settled state after synchronous reset/update steps finish.
    queueMicrotask(() => {
        _bpStateNotificationPending = false;
        window.dispatchEvent(new Event("eftforge:build-preview-change"));
    });
}

// Re-stamp the placeholder after successful generation and tree renders.
function _bpSetPlaceholder(url) {
    const img = document.getElementById("gun-display-image");
    if (!img) return;
    img.src            = url;
    img.style.display  = "";
    img.style.opacity  = "1";
    img.referrerPolicy = _bpLastIsCommunityCard ? "no-referrer" : "";
}

// Update every image element that should show the build preview.
// Reset every target to the factory image when generation fails.
function _bpApplyImageUrl(url) {
    _bpLastImageUrl        = url;
    _bpLastIsCommunityCard = false;
    const fallback  = EFTForge.state.currentGun?.image_512_link || EFTForge.state.currentGun?.icon_link || "";

    if (EFTForge.state.gridView) {
        // Grid view: target the gun cell (recreated each render)
        const gunCellImg = document.querySelector(".ag-gun-cell img");
        if (gunCellImg) {
            gunCellImg.src            = url || fallback;
            gunCellImg.style.opacity  = "";
            gunCellImg.style.filter   = "";
            gunCellImg.referrerPolicy = "";
        }
    } else {
        // List view: target the gun img in the attachment table header
        const tableImg = _bpGetListViewImg();
        if (tableImg) {
            tableImg.src            = url || fallback;
            tableImg.style.opacity  = "1";
            tableImg.referrerPolicy = "";
        }
    }

    _bpPlaceholderUrl = url || fallback;
    _bpSetPlaceholder(_bpPlaceholderUrl);
    _bpNotifyStateChange();
}

// Apply a static image (tarkov.dev asset, or - when isCommunityCard is set - a
// Gitee-hosted community build card) to the target image and the placeholder
// without firing a render request. Stores the url in _bpPlaceholderUrl so
// it is re-stamped correctly after every renderFullTree cycle.
function _bpApplyStatic(staticUrl, isCommunityCard = false) {
    _bpLastImageUrl        = staticUrl || null;
    _bpPlaceholderUrl      = staticUrl || null;
    _bpLastIsCommunityCard = isCommunityCard;

    const referrerPolicy = isCommunityCard ? "no-referrer" : "";

    if (EFTForge.state.gridView) {
        const gunCellImg = document.querySelector(".ag-gun-cell img");
        if (gunCellImg) {
            gunCellImg.src            = staticUrl || "";
            gunCellImg.style.opacity  = "";
            gunCellImg.style.filter   = "";
            gunCellImg.referrerPolicy = referrerPolicy;
        }
    } else {
        const tableImg = _bpGetListViewImg();
        if (tableImg) {
            tableImg.src            = staticUrl || "";
            tableImg.style.opacity  = "1";
            tableImg.referrerPolicy = referrerPolicy;
        }
    }

    if (staticUrl) _bpSetPlaceholder(staticUrl);
    _bpNotifyStateChange();
}

// Show a "generating..." state while waiting for the API.
function _bpSetLoading(isLoading) {
    if (isLoading && !_bpEnabled) return;

    if (EFTForge.state.gridView) {
        const gunCellImg = document.querySelector(".ag-gun-cell img");
        if (gunCellImg) {
            gunCellImg.style.opacity = isLoading ? "0.35" : "";
            gunCellImg.style.filter  = isLoading ? "brightness(0.85)" : "";
        }
    } else {
        const tableImg = _bpGetListViewImg();
        if (tableImg) tableImg.style.opacity = isLoading ? "0.35" : "1";
    }

    const phImg = document.getElementById("gun-display-image");
    if (phImg) phImg.style.opacity = isLoading ? "0.35" : "1";
    _bpNotifyStateChange();
}

// Returns a Promise that resolves once the given img element's current src
// has finished loading (or immediately if already complete / on error).
// Caps at 5 s so a broken image never leaves the UI permanently dimmed.
function _bpWaitForImgLoad(img) {
    return new Promise(resolve => {
        if (!img || img.complete) { resolve(); return; }
        const done = () => {
            clearTimeout(timer);
            img.removeEventListener("load", done);
            img.removeEventListener("error", done);
            resolve();
        };
        const timer = setTimeout(done, 5000);
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
    });
}

// --- Core generate function ----------------------------------

// Wait for a pause in editing before asking the server for a render.
const _BP_DEBOUNCE_MS = 1500;
let _bpDebounceTimer = null;

function _bpCancelPending() {
    ++_bpRevision;
    clearTimeout(_bpDebounceTimer);
    _bpDebounceTimer = null;
    _bpAbortController?.abort();
    _bpAbortController = null;
    _bpDesiredId = null;
    _bpInflight = false;
    _bpSetLoading(false);
}

async function _bpGenerate(snapshot, revision) {
    const { gunId, key, ammoKey, payload } = snapshot;
    const current = () => revision === _bpRevision && _bpEnabled && !_bpGlobalDisabled
        && EFTForge.state.currentGun?.id === gunId && _bpViewKey() === key + "#" + ammoKey;
    if (!current()) return;

    const controller = new AbortController();
    _bpAbortController = controller;
    const signal = controller.signal;
    _bpInflight = true;
    _bpSetLoading(true);
    try {
        const resp = await fetch(`${EFTForge.config.API_BASE}/build-image`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...payload, source: "preview" }),
            signal,
        });
        if (!current()) return;
        if (!resp.ok) {
            _bpApplyImageUrl(null);
            if (resp.status === 503) {
                // An admin turned generation off since the page loaded.
                _bpSetGlobalDisabled(true);
            } else if (resp.status === 422) {
                // Only a weapon Kitbash! cannot draw fails the build; parts it
                // cannot draw are left out of the image instead.
                const detail = (await resp.json().catch(() => null))?.detail;
                if (!current()) return;
                const t = EFTForge.lang.t;
                const msg = detail?.code === "unsupported_weapon" ? "toast.imgGenGunUnsupportedMsg" : "toast.imgGenFailedMsg";
                EFTForge.utils.replaceToast("build-preview", t("toast.imgGenFailed"), t(msg), 4000, "#e74c3c");
            }
            return;
        }
        const data = await resp.json();
        if (!current()) return;
        if (!data.image_url) {
            _bpApplyImageUrl(null);
            return;
        }
        if (data.skipped?.length) {
            const t = EFTForge.lang.t;
            EFTForge.utils.replaceToast("build-preview", t("toast.imgGenPartial"), t("toast.imgGenPartialMsg"), 4000, "#f5a623");
        }
        _bpLastKey = key;
        _bpLastAmmoKey = ammoKey;
        _bpLastGunId = gunId;
        _bpApplyImageUrl(data.image_url);
        const targetImg = EFTForge.state.gridView
            ? document.querySelector(".ag-gun-cell img") : _bpGetListViewImg();
        await Promise.all([
            _bpWaitForImgLoad(targetImg),
            _bpWaitForImgLoad(document.getElementById("gun-display-image")),
        ]);
    } catch (err) {
        if (err.name !== "AbortError" && current()) {
            console.warn("[build-preview] failed:", err);
            _bpApplyImageUrl(null);
        }
    } finally {
        // Only release state owned by this revision, including after image loading.
        if (revision === _bpRevision) {
            _bpInflight = false;
            _bpAbortController = null;
            _bpDesiredId = null;
            _bpSetLoading(false);
        }
    }
}

function scheduleBuildPreview() {
    const gun = EFTForge.state.currentGun;
    if (!_bpEnabled || _bpGlobalDisabled || !gun) return;
    const key = _bpPairsKey();
    const ammo = _bpAmmo();
    const ammoKey = _bpAmmoKey(ammo);
    const identity = JSON.stringify([gun.id, key, ammoKey]);
    const cb = EFTForge.state.communityBuild;
    const cardUrl = cb?.pairsKey === key ? cb.cardImageUrl : null;
    if (!cardUrl && identity === _bpDesiredId) return;

    // Invalidate old work immediately, even when returning to the displayed build.
    _bpCancelPending();
    if (_bpLastGunId !== gun.id) {
        _bpLastKey = null;
        _bpLastImageUrl = null;
        _bpPlaceholderUrl = null;
    }
    // The factory icon is the game's own, with an empty magazine: loaded, render it.
    if (cardUrl || key === "" || (key === EFTForge.state.factoryPairsKey && !ammo)) {
        const url = cardUrl || (key === "" ? gun.bare_image_512_link : null)
            || gun.image_512_link || gun.icon_link;
        _bpLastKey = key;
        _bpLastAmmoKey = ammoKey;
        _bpLastGunId = gun.id;
        _bpApplyStatic(url, !!cardUrl);
        return;
    }
    if (key === _bpLastKey && ammoKey === _bpLastAmmoKey && _bpLastGunId === gun.id && _bpLastImageUrl) return;

    // Capture the payload now so later edits cannot change a queued build.
    const payload = _bpBuildSptItems();
    if (!payload) {
        _bpApplyImageUrl(null);
        return;
    }
    _bpDesiredId = identity;
    const revision = _bpRevision;
    _bpInflight = true;
    _bpSetLoading(true);
    _bpDebounceTimer = setTimeout(() => {
        _bpDebounceTimer = null;
        _bpGenerate({ gunId: gun.id, key, ammoKey, payload: { ...payload, ...ammo } }, revision);
    }, _BP_DEBOUNCE_MS);
}

// Fetch the generated build image URL for export purposes.
// Always fires a fresh API request regardless of the _bpEnabled toggle.
// Returns the generated URL on success, or the appropriate static fallback.
async function _bpFetchForExport() {
    const gun = EFTForge.state.currentGun;
    if (!gun) return null;

    const key = _bpPairsKey();
    const ammo = _bpAmmo();

    // Already have a valid generated URL for this exact build - reuse it.
    if (key === _bpLastKey && _bpAmmoKey(ammo) === _bpLastAmmoKey && gun.id === _bpLastGunId && _bpLastImageUrl) return _bpLastImageUrl;

    // Bare/stripped build
    if (key === "") return gun.bare_image_512_link || gun.image_512_link || gun.icon_link || null;

    // Factory configuration, magazines empty as in the game's icon
    if (key === EFTForge.state.factoryPairsKey && !ammo) return gun.image_512_link || gun.icon_link || null;

    // Custom build - fire a dedicated export request (does not interfere with the
    // normal inflight since it uses its own fetch and doesn't update shared state).
    const sptData = _bpBuildSptItems();
    if (!sptData) return null;
    try {
        const resp = await fetch(
            `${EFTForge.config.API_BASE}/build-image`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...sptData, ...ammo, source: "export" }) }
        );
        if (!resp.ok) return null;
        const data = await resp.json();
        return data.image_url || null;
    } catch {
        return null;
    }
}

window.fetchBuildImageForExport = _bpFetchForExport;

// Reset state when the gun changes
function resetBuildPreview() {
    _bpCancelPending();
    _bpLastGunId = null;
    _bpLastKey        = null;
    _bpLastImageUrl   = null;
    _bpPlaceholderUrl = null;
    _bpLastIsCommunityCard = false;
}

// --- Hook into renderFullTree --------------------------------
// attachment-grid.js has already overridden window.renderFullTree
// to dispatch between grid and list. We chain on top of that.

(function () {
    const _prev = window.renderFullTree;
    window.renderFullTree = function (preserveScroll) {
        const result = _prev(preserveScroll);
        if (EFTForge.state.currentGun) {
            Promise.resolve(result).then(() => {
                if (_bpEnabled && _bpLastImageUrl && _bpLastGunId === EFTForge.state.currentGun?.id) {
                    if (EFTForge.state.gridView) {
                        // Re-stamp the gun cell - renderFullTree recreates the ag-gun-cell
                        // element from scratch with the factory image src every render.
                        const gunCellImg = document.querySelector(".ag-gun-cell img");
                        if (gunCellImg) {
                            gunCellImg.src            = _bpLastImageUrl;
                            gunCellImg.style.opacity  = _bpInflight ? "0.35" : "";
                            gunCellImg.style.filter   = _bpInflight ? "brightness(0.85)" : "";
                            gunCellImg.referrerPolicy = _bpLastIsCommunityCard ? "no-referrer" : "";
                        }
                    } else {
                        // Re-stamp the table header gun img - updateAttTableHeaderImg()
                        // resets it to the factory image src every render.
                        const tableImg = _bpGetListViewImg();
                        if (tableImg) {
                            tableImg.src            = _bpLastImageUrl;
                            tableImg.style.opacity  = _bpInflight ? "0.35" : "1";
                            tableImg.referrerPolicy = _bpLastIsCommunityCard ? "no-referrer" : "";
                        }
                    }
                }
                // Re-stamp the placeholder after every render - the render cycle
                // resets gun-display-image src to the factory image.
                if (_bpPlaceholderUrl && _bpLastGunId === EFTForge.state.currentGun?.id) {
                    _bpSetPlaceholder(_bpPlaceholderUrl);
                    if (_bpInflight) {
                        const phImg = document.getElementById("gun-display-image");
                        if (phImg) phImg.style.opacity = "0.35";
                    }
                }
                scheduleBuildPreview();
            }).catch(() => {});
        }
        return result;
    };
})();

// Expose state for slot-selector.js, which builds header HTML directly
// and needs to use the generated URL and match the current loading opacity.
window._bpGetLastImageUrl     = () => _bpLastGunId === EFTForge.state.currentGun?.id ? _bpLastImageUrl : null;
window._bpGetLastKey          = () => _bpLastGunId === EFTForge.state.currentGun?.id
    && _bpLastAmmoKey === _bpAmmoKey(_bpAmmo()) ? _bpLastKey : null;
window._bpAmmoFor             = _bpAmmoFor;
window._bpPairsHaveMagazine   = _bpPairsHaveMagazine;
window._bpAmmo                = _bpAmmo;
window._bpAmmoKey             = _bpAmmoKey;
window._bpGetPlaceholderUrl   = () => _bpLastGunId === EFTForge.state.currentGun?.id ? _bpPlaceholderUrl : null;
window._bpIsInflight          = () => _bpInflight;
window._bpIsEnabled           = () => _bpEnabled;
window._bpIsGloballyDisabled  = () => _bpGlobalDisabled;

window.scheduleBuildPreview = scheduleBuildPreview;
window.resetBuildPreview    = resetBuildPreview;
