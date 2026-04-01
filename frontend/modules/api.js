window.EFTForge = window.EFTForge || {};

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

async function fetchAmmo(caliber) {
    const res = await fetch(`${_base()}/ammo/${caliber}?lang=${_lang()}`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function fetchGunInit(gunId, { selectedAmmoId = null, assumeFullMag = true } = {}) {
    const params = new URLSearchParams({ lang: _lang(), strength_level: EFTForge.state.currentStrengthLevel });
    if (EFTForge.state.currentEquipErgoModifier) params.set("equip_ergo_modifier", EFTForge.state.currentEquipErgoModifier);
    if (selectedAmmoId) params.set("selected_ammo_id", selectedAmmoId);
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

async function fetchFleaPrices(itemIds, gameMode = "regular") {
    const query = `{ items(ids: ${JSON.stringify(itemIds)}, gameMode: ${gameMode}) { id avg24hPrice } }`;
    const res = await fetch("https://api.tarkov.dev/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`tarkov.dev error: ${res.status}`);
    const json = await res.json();
    return Object.fromEntries((json.data?.items || []).map(i => [i.id, i.avg24hPrice]));
}

async function fetchBulkRatings(itemIds) {
    if (!itemIds || itemIds.length === 0) return {};
    const ids = encodeURIComponent(itemIds.join(","));
    const res = await fetch(`${_base()}/ratings/attachments/bulk?ids=${ids}`, {
        headers: { "X-Client-ID": _getClientId() },
    });
    if (!res.ok) return {};
    const json = await res.json();
    return json.ratings || {};
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
    const ids = encodeURIComponent(buildIds.join(","));
    const res = await fetch(`${_base()}/ratings/builds/bulk?ids=${ids}`, {
        headers: { "X-Client-ID": _getClientId() },
    });
    if (!res.ok) return {};
    const json = await res.json();
    return json.ratings || {};
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

function sendHeartbeat() {
    try {
        fetch(`${_base()}/heartbeat`, {
            method:  "POST",
            headers: { "X-Client-ID": _getClientId() },
        }).catch(() => {});
    } catch (_) {}
}

async function fetchActiveUsers() {
    const res = await fetch(`${_base()}/active-users`);
    if (!res.ok) return null;
    return res.json();
}

EFTForge.api = { fetchTraders, fetchGuns, fetchGunInit, fetchAmmo, fetchItemSlots, fetchSlotAllowedItems, calculateBuild, validateBuild, batchProcessCandidates, fetchFleaPrices, fetchBulkRatings, postVote, deleteVote, fetchBulkBuildRatings, postBuildVote, deleteBuildVote, publishBuild, fetchPublicBuilds, recordBuildLoad, unlistBuild, fetchBanStatus, fetchNotifications, fetchAnnouncements, fetchLeaderboardBuilds, fetchLeaderboardAttachments, sendHeartbeat, fetchActiveUsers };
