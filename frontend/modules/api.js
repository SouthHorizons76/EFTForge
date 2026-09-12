window.EFTForge = window.EFTForge || {};

/* exported fetchGraphSearchableItems -- called from other modules */

const _base = () => EFTForge.config.API_BASE;
const _lang = () => (EFTForge.state && EFTForge.state.lang) || "en";
const _post = (path, body) => fetch(`${_base()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
});

// generate and persist a UUID v4 as the stable client identity token
function _getClientId() {
    let id = localStorage.getItem("eftforge_client_id");
    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem("eftforge_client_id", id);
    }
    return id;
}

// headers for build write requests that require client identity
const _clientHeaders = () => ({
    "Content-Type": "application/json",
    "X-Client-ID":  _getClientId(),
});

const _postWithId = (path, body) => fetch(`${_base()}${path}`, {
    method:  "POST",
    headers: _clientHeaders(),
    body:    JSON.stringify(body),
});

async function fetchTraders() {
    const res = await fetch(`${_base()}/traders`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function fetchGuns() {
    const res = await fetch(`${_base()}/guns?lang=${_lang()}`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function fetchGraphSearchableItems() {
    const res = await fetch(`${_base()}/graph/searchable-items`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function fetchAmmo(caliber) {
    const res = await fetch(`${_base()}/ammo/${caliber}?lang=${_lang()}`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function fetchGunInit(gunId, { selectedAmmoId = null, selectedUbglAmmoId = null, assumeFullMag = true } = {}) {
    const params = new URLSearchParams({ lang: _lang(), strength_level: EFTForge.state.currentStrengthLevel });
    if (EFTForge.state.currentEquipErgoModifier) params.set("equip_ergo_modifier", EFTForge.state.currentEquipErgoModifier);
    if (selectedAmmoId) params.set("selected_ammo_id", selectedAmmoId);
    if (selectedUbglAmmoId) params.set("selected_ubgl_ammo_id", selectedUbglAmmoId);
    params.set("assume_full_mag", assumeFullMag);
    const res = await fetch(`${_base()}/guns/${gunId}/init?${params}`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function fetchItemSlots(itemId) {
    const res = await fetch(`${_base()}/items/${itemId}/slots`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function fetchSlotAllowedItems(slotId) {
    const res = await fetch(`${_base()}/slots/${slotId}/allowed-items?lang=${_lang()}`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function fetchSlotAllowedItemsBatch(slotIds) {
    const res = await _post("/slots/allowed-items/batch", { slot_ids: slotIds, lang: _lang() });
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json(); // { slotId: [items...] }
}

async function fetchItemSlotsBatch(itemIds) {
    const res = await _post("/items/slots/batch", { item_ids: itemIds });
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json(); // { itemId: [slots...] }
}

async function calculateBuild(payload) {
    const res = await _post("/build/calculate", payload);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function validateBuild(payload) {
    const res = await _post("/build/validate", payload);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function batchProcessCandidates(payload) {
    const res = await _post("/build/batch-process", payload);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function comboBatchProcess(payload) {
    const res = await _post("/build/combo-batch-process", payload);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

// Shared reader for our hand-rolled SSE-over-fetch endpoints (combo-full, explore):
// parses "data: {...}\n\n" frames off the response body as they arrive, routing
// "progress" events to onProgress and returning the "result" event's data.
async function _readEventStream(res, signal, onProgress) {
    const checkAbort = () => {
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    };
    // Empty candidate sets use a normal JSON response, including on older servers.
    if (res.headers.get("content-type")?.split(";")[0].trim() === "application/json") {
        const result = await res.json();
        checkAbort();
        return result;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fragments = [];
    let dataLines = [];
    let skipLF = false;
    const acceptLine = line => {
        if (line === "") {
            if (!dataLines.length) return null;
            const event = JSON.parse(dataLines.join("\n"));
            dataLines = [];
            return event;
        }
        if (line.startsWith("data:")) dataLines.push(line.slice(line[5] === " " ? 6 : 5));
        return null;
    };
    try {
        while (true) {
            checkAbort();
            const { done, value } = await reader.read();
            checkAbort();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            let from = 0;
            if (skipLF && text.length) {
                if (text[0] === "\n") from = 1;
                skipLF = false;
            }
            // Scan only this chunk. A large unfinished JSON line is joined once,
            // when its terminator arrives, instead of copied/scanned on every read.
            const breaks = /[\r\n]/g;
            breaks.lastIndex = from;
            let match;
            while ((match = breaks.exec(text))) {
                fragments.push(text.slice(from, match.index));
                const line = fragments.length === 1 ? fragments[0] : fragments.join("");
                fragments = [];
                from = match.index + 1;
                if (match[0] === "\r") {
                    if (text[from] === "\n") from++;
                    else if (from === text.length) skipLF = true;
                }
                breaks.lastIndex = from;
                const event = acceptLine(line);
                if (!event) continue;
                if (event.type === "progress") onProgress?.(event);
                checkAbort();
                if (event.type === "result") return event.data;
                if (event.type === "error") throw new Error(event.message ?? "stream error");
            }
            if (from < text.length) fragments.push(text.slice(from));
        }
        throw new Error("stream ended without result");
    } finally {
        fragments = dataLines = [];
        try { await reader.cancel(); } catch { /* Preserve the original error. */ }
        reader.releaseLock();
    }
}

async function comboFull(payload, signal, onProgress) {
    const res = await fetch(`${_base()}/build/combo-full`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ response_format: "items-v1", ...payload }),
        signal,
    });
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return _readEventStream(res, signal, onProgress);
}

// Explore's 429s (busy/already-solving) are surfaced as a real HTTP status - the
// solver slot is acquired before the streaming response starts (see main.py's
// build_explore) - so the caller can read err.status/err.reasonKey to decide
// whether to retry, same as it already does for the other solve endpoints.
async function exploreStream(payload, signal, onProgress) {
    const res = await fetch(`${_base()}/build/explore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
    });
    if (!res.ok) {
        const data = await res.json().catch(() => null);
        const error = new Error(`Server error: ${res.status}`);
        error.status = res.status;
        error.reasonKey = data?.detail?.reason_key;
        throw error;
    }
    return _readEventStream(res, signal, onProgress);
}

// tarkov.dev's JSON API serves the full item list per game mode (avg24hPrice
// included on each item) rather than a per-id GraphQL query. We memoize the
// {id: avg24hPrice} map per game mode so the chunked callers don't re-download
// the (large, CDN-cached) payload once per chunk. A failed fetch is not cached.
// refetchFleaPrices() forces fresh data via EFTForge.api.clearFleaPriceCache().
const _fleaMapPromises = {};

function clearFleaPriceCache() {
    for (const k of Object.keys(_fleaMapPromises)) delete _fleaMapPromises[k];
}

function _loadFleaMap(gameMode) {
    if (!_fleaMapPromises[gameMode]) {
        _fleaMapPromises[gameMode] = (async () => {
            const res = await fetch(`https://json.tarkov.dev/${gameMode}/items`);
            if (!res.ok) throw new Error(`tarkov.dev error: ${res.status}`);
            const json = await res.json();
            const items = json.data?.items || {};
            const out = {};
            for (const it of Object.values(items)) out[it.id] = it.avg24hPrice ?? null;
            return out;
        })().catch(err => {
            delete _fleaMapPromises[gameMode]; // allow retry on the next call
            throw err;
        });
    }
    return _fleaMapPromises[gameMode];
}

async function fetchFleaPrices(itemIds, gameMode = "regular") {
    const map = await _loadFleaMap(gameMode);
    const out = {};
    for (const id of itemIds) out[id] = map[id] ?? null;
    return out;
}

const RATINGS_BULK_CHUNK_SIZE = 200;

function _chunk(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
}

async function fetchBulkRatings(itemIds) {
    if (!itemIds || itemIds.length === 0) return {};
    const chunks = _chunk(itemIds, RATINGS_BULK_CHUNK_SIZE);
    const results = await Promise.all(
        chunks.map(async (chunk) => {
            const ids = encodeURIComponent(chunk.join(","));
            const res = await fetch(`${_base()}/ratings/attachments/bulk?ids=${ids}`, {
                headers: { "X-Client-ID": _getClientId() },
            });
            if (!res.ok) return {};
            const json = await res.json();
            return json.ratings || {};
        })
    );
    return Object.assign({}, ...results);
}

async function postVote(itemId, vote) {
    const res = await _postWithId(`/ratings/attachments/${itemId}/vote`, { vote });
    if (!res.ok) throw new Error(`Vote failed: ${res.status}`);
    return res.json();
}

async function deleteVote(itemId) {
    const res = await fetch(`${_base()}/ratings/attachments/${itemId}/vote`, {
        method:  "DELETE",
        headers: { "X-Client-ID": _getClientId() },
    });
    if (!res.ok) throw new Error(`Delete vote failed: ${res.status}`);
    return res.json();
}

async function fetchBulkBuildRatings(buildIds) {
    if (!buildIds || buildIds.length === 0) return {};
    const chunks = _chunk(buildIds, RATINGS_BULK_CHUNK_SIZE);
    const results = await Promise.all(
        chunks.map(async (chunk) => {
            const ids = encodeURIComponent(chunk.join(","));
            const res = await fetch(`${_base()}/ratings/builds/bulk?ids=${ids}`, {
                headers: { "X-Client-ID": _getClientId() },
            });
            if (!res.ok) return {};
            const json = await res.json();
            return json.ratings || {};
        })
    );
    return Object.assign({}, ...results);
}

async function postBuildVote(buildId, vote) {
    const res = await _postWithId(`/ratings/builds/${buildId}/vote`, { vote });
    if (!res.ok) throw new Error(`Vote failed: ${res.status}`);
    return res.json();
}

async function deleteBuildVote(buildId) {
    const res = await fetch(`${_base()}/ratings/builds/${buildId}/vote`, {
        method:  "DELETE",
        headers: { "X-Client-ID": _getClientId() },
    });
    if (!res.ok) throw new Error(`Delete vote failed: ${res.status}`);
    return res.json();
}

async function publishBuild(payload) {
    // payload: { gun_id, build_name, pairs }
    const res = await _postWithId("/builds/publish", payload);
    if (res.status === 429) {
        const json = await res.json().catch(() => ({}));
        throw Object.assign(new Error("rate_limit"), { detail: json.detail });
    }
    if (res.status === 409) {
        const json = await res.json().catch(() => ({}));
        if (json.detail === "community_builds_limit_reached")
            throw new Error("community_builds_limit_reached");
    }
    if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.detail || `Server error: ${res.status}`);
    }
    return res.json();
}

async function fetchPublicBuilds(gunId) {
    // include X-Client-ID so server can mark is_mine on each build
    const res = await fetch(`${_base()}/builds/public?gun_id=${encodeURIComponent(gunId)}`, {
        headers: { "X-Client-ID": _getClientId() },
    });
    if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.detail || `Server error: ${res.status}`);
    }
    return res.json();
}

async function recordBuildLoad(buildId) {
    try {
        await fetch(`${_base()}/builds/${buildId}/load`, { method: "POST" });
    } catch (_) {}
}

async function unlistBuild(buildId) {
    const res = await fetch(`${_base()}/builds/${buildId}`, {
        method:  "DELETE",
        headers: { "X-Client-ID": _getClientId() },
    });
    if (res.status === 403) throw new Error("forbidden");
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return true;
}

async function fetchBanStatus() {
    const res = await fetch(`${_base()}/builds/ban-status`, {
        headers: { "X-Client-ID": _getClientId() },
    });
    if (!res.ok) return null;
    return res.json();
}

async function fetchNotifications() {
    const res = await fetch(`${_base()}/builds/notifications`, {
        headers: { "X-Client-ID": _getClientId() },
    });
    if (!res.ok) return [];
    return res.json();
}

async function fetchAnnouncements() {
    const res = await fetch(`${_base()}/announcements`);
    if (!res.ok) throw new Error(`announcements ${res.status}`);
    return res.json();
}

async function fetchStaticAnnouncements() {
    const url = EFTForge.config.STATIC_ANNOUNCEMENTS_URL;
    if (!url) return [];
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) return [];
    return res.json();
}

async function fetchLeaderboardBuilds(period) {
    const res = await fetch(`${_base()}/leaderboard/builds?period=${encodeURIComponent(period)}`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function fetchLeaderboardAttachments(period, sort) {
    const res = await fetch(`${_base()}/leaderboard/attachments?period=${encodeURIComponent(period)}&sort=${encodeURIComponent(sort)}`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function fetchStatChangelog() {
    const res = await fetch(`${_base()}/stat-changelog`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function fetchSyncStatus() {
    const res = await fetch(`${_base()}/sync-status`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function fetchBuildComments(buildId) {
    const res = await fetch(`${_base()}/builds/${encodeURIComponent(buildId)}/comments`, {
        headers: { "X-Client-ID": _getClientId() },
    });
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function deleteOwnComment(buildId, commentId) {
    const res = await fetch(`${_base()}/builds/${encodeURIComponent(buildId)}/comments/${encodeURIComponent(commentId)}`, {
        method:  "DELETE",
        headers: { "X-Client-ID": _getClientId() },
    });
    if (!res.ok) throw new Error(`Delete comment failed: ${res.status}`);
    return res.json();
}

async function postBuildComment(buildId, content) {
    const profile = (EFTForge.profile && EFTForge.profile.getProfile()) || {};
    const res = await fetch(`${_base()}/builds/${encodeURIComponent(buildId)}/comments`, {
        method:  "POST",
        headers: _clientHeaders(),
        body:    JSON.stringify({
            content,
            user_display_name: profile.username   || null,
            user_avatar_url:   profile.avatar_url || null,
        }),
    });
    if (!res.ok) {
        let detail = `Error ${res.status}`;
        try { detail = (await res.json()).detail || detail; } catch {}
        throw new Error(detail);
    }
    return res.json();
}

async function adminDeleteComment(commentId) {
    const adminKey = localStorage.getItem("eftforge_admin_key") || "";
    const res = await fetch(`${_base()}/admin/builds/comments/${encodeURIComponent(commentId)}`, {
        method:  "DELETE",
        headers: { "X-Admin-Key": adminKey },
    });
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function uploadAvatar(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            const b64 = e.target.result.split(",")[1];
            try {
                const res = await fetch(`${_base()}/profile/avatar`, {
                    method:  "POST",
                    headers: _clientHeaders(),
                    body:    JSON.stringify({ image_b64: b64, mime_type: file.type }),
                });
                if (!res.ok) {
                    const j = await res.json().catch(() => ({}));
                    reject(new Error(j.detail || `Upload failed: ${res.status}`));
                    return;
                }
                resolve(await res.json());
            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = () => reject(new Error("Failed to read image file."));
        reader.readAsDataURL(file);
    });
}

async function updateUserProfile(username, avatarUrl) {
    const res = await fetch(`${_base()}/profile/update`, {
        method:  "POST",
        headers: _clientHeaders(),
        body:    JSON.stringify({ username: username || null, avatar_url: avatarUrl || null }),
    });
    if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail || `Server error: ${res.status}`);
    }
    return res.json();
}

async function transferPreview(oldUuid) {
    const res = await fetch(`${_base()}/profile/transfer/preview`, {
        method:  "POST",
        headers: _clientHeaders(),
        body:    JSON.stringify({ old_uuid: oldUuid }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.detail || `Server error: ${res.status}`);
    return j;
}

async function transferAccount(oldUuid) {
    const profile = EFTForge.profile ? EFTForge.profile.getProfile() : {};
    const res = await fetch(`${_base()}/profile/transfer`, {
        method:  "POST",
        headers: _clientHeaders(),
        body:    JSON.stringify({
            old_uuid:   oldUuid,
            username:   profile.username   || null,
            avatar_url: profile.avatar_url || null,
        }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.detail || `Server error: ${res.status}`);
    return j;
}

async function fetchMyBuilds() {
    const res = await fetch(`${_base()}/builds/mine`, {
        headers: { "X-Client-ID": _getClientId() },
    });
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

EFTForge.api = { fetchTraders, fetchGuns, fetchGunInit, fetchAmmo, fetchItemSlots, fetchSlotAllowedItems, fetchSlotAllowedItemsBatch, fetchItemSlotsBatch, calculateBuild, validateBuild, batchProcessCandidates, comboBatchProcess, comboFull, exploreStream, fetchFleaPrices, clearFleaPriceCache, fetchBulkRatings, postVote, deleteVote, fetchBulkBuildRatings, postBuildVote, deleteBuildVote, publishBuild, fetchPublicBuilds, fetchMyBuilds, recordBuildLoad, unlistBuild, fetchBanStatus, fetchNotifications, fetchAnnouncements, fetchStaticAnnouncements, fetchLeaderboardBuilds, fetchLeaderboardAttachments, fetchStatChangelog, fetchSyncStatus, fetchBuildComments, postBuildComment, deleteOwnComment, adminDeleteComment, uploadAvatar, updateUserProfile, transferPreview, transferAccount };
