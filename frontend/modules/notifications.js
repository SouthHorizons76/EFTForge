window.EFTForge = window.EFTForge || {};

/* exported _clearNewCommentBuildId, _claimArenaCommentIds, _startNotificationPolling -- called from other modules or index.html attributes */

/* ============================================================
   NOTIFICATIONS
   Polls for community notifications (comments, announcements)
   and shows them as toasts.
============================================================ */

/* ===========================
   NOTIFICATION POLLING
=========================== */

let _notifPollInterval = null;
const _SEEN_ANNOUNCEMENTS_KEY = "eft_seen_announcements";
const _seenStaticThisSession = new Set(); // resets on page load so offline toasts re-show on refresh

function _getSeenAnnouncements() {
    try { return new Set(JSON.parse(localStorage.getItem(_SEEN_ANNOUNCEMENTS_KEY) || "[]")); }
    catch { return new Set(); }
}

function _markAnnouncementSeen(id) {
    const seen = _getSeenAnnouncements();
    seen.add(id);
    localStorage.setItem(_SEEN_ANNOUNCEMENTS_KEY, JSON.stringify([...seen]));
}

function _showBanToast(bannedUntil, reason) {
    const reasonLine = reason ? "\n" + t("notify.banReason").replace("{reason}", reason) : "";
    if (!bannedUntil) {
        showToast(t("notify.bannedTitle"), t("notify.bannedPermanent") + reasonLine, 8000);
        return;
    }
    const expiry      = new Date(bannedUntil);
    const hours       = Math.ceil((expiry.getTime() - Date.now()) / 3600000);
    const durationStr = hours >= 24 ? `${Math.round(hours / 24)} days` : `${hours} hours`;
    const dateStr     = expiry.toLocaleString();
    showToast(
        t("notify.bannedTitle"),
        t("notify.banned").replace("{duration}", durationStr).replace("{date}", dateStr) + reasonLine,
        10000
    );
}

async function _checkStoredBan() {
    const hadStoredBan = !!localStorage.getItem("eftforge_ban");

    try {
        // Always verify against the server - localStorage can be stale
        const status = await EFTForge.api.fetchBanStatus();
        if (!status) return;

        if (status.is_banned) {
            localStorage.setItem("eftforge_ban", JSON.stringify({ banned_until: status.banned_until, reason: status.reason ?? null }));
            _showBanToast(status.banned_until, status.reason ?? null);
        } else {
            // Not banned on server - clear any stale entry and show unbanned toast once
            if (hadStoredBan) {
                localStorage.removeItem("eftforge_ban");
                showToast(t("notify.unbannedTitle"), t("notify.unbanned"), 8000, "#4CAF50");
            }
        }
    } catch { /* network error - fall back to localStorage */
        try {
            const raw = localStorage.getItem("eftforge_ban");
            if (!raw) return;
            const { banned_until, reason } = JSON.parse(raw);
            if (!banned_until || new Date(banned_until) > new Date()) {
                _showBanToast(banned_until ?? null, reason ?? null);
            } else {
                localStorage.removeItem("eftforge_ban");
            }
        } catch { /* malformed entry - ignore */ }
    }
}

// Builds with comments the user hasn't opened yet: gun builds under the first key, Arena
// presets under the second, so the Builds button and Arena's Presets button each count their own
const _NEW_COMMENT_KEY = "eftforge_new_comment_builds";
const _NEW_ARENA_COMMENT_KEY = "eftforge_new_comment_arena";

function _readIds(key) {
    try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); }
    catch { return new Set(); }
}

function _writeIds(key, ids) {
    try { localStorage.setItem(key, JSON.stringify([...ids])); } catch { /* storage full or blocked */ }
}

/** Every build with new comments, or only one game's ("arena", or "main" for gun builds). */
function _getNewCommentBuildIds(game) {
    if (game === "arena") return _readIds(_NEW_ARENA_COMMENT_KEY);
    if (game === "main") return _readIds(_NEW_COMMENT_KEY);
    return new Set([..._readIds(_NEW_COMMENT_KEY), ..._readIds(_NEW_ARENA_COMMENT_KEY)]);
}

function _addNewCommentBuildId(buildId, game) {
    const key = game === "arena" ? _NEW_ARENA_COMMENT_KEY : _NEW_COMMENT_KEY;
    const ids = _readIds(key);
    ids.add(buildId);
    _writeIds(key, ids);
}

function _clearNewCommentBuildId(buildId) {
    [_NEW_COMMENT_KEY, _NEW_ARENA_COMMENT_KEY].forEach(key => {
        const ids = _readIds(key);
        if (ids.delete(buildId)) _writeIds(key, ids);
    });
}

/**
 * The user's own published Arena presets, once listed: notes from before the server said
 * which game a comment was on landed with the gun builds, so move theirs over.
 */
function _claimArenaCommentIds(presetIds) {
    const main = _readIds(_NEW_COMMENT_KEY);
    const arena = _readIds(_NEW_ARENA_COMMENT_KEY);
    let moved = false;
    presetIds.forEach(id => {
        if (!main.delete(id)) return;
        arena.add(id);
        moved = true;
    });
    if (!moved) return;
    _writeIds(_NEW_COMMENT_KEY, main);
    _writeIds(_NEW_ARENA_COMMENT_KEY, arena);
    _updateNewCommentBadge();
}

function _badgeText(count) {
    return count > 0 ? (count > 99 ? "99+" : String(count)) : "";
}

function _updateNewCommentBadge() {
    const count = _getNewCommentBuildIds("main").size;
    const btn = document.getElementById("builds-btn");
    if (btn) btn.dataset.badge = _badgeText(count);
    const tabBtn = document.querySelector('#builds-dialog .modal-tab[data-target="bm-tab-community"]');
    if (tabBtn) tabBtn.classList.toggle("has-new-comment", count > 0);

    const arenaCount = _getNewCommentBuildIds("arena").size;
    const arenaBtn = document.getElementById("arena-presets-nav-btn");
    if (arenaBtn) arenaBtn.dataset.badge = _badgeText(arenaCount);
    const arenaTab = document.querySelector('#arena-my-presets-dialog .modal-tab[data-target="arena-mp-tab-published"]');
    if (arenaTab) arenaTab.classList.toggle("has-new-comment", arenaCount > 0);
}

async function _pollNotifications() {
    let notes;
    try {
        notes = await EFTForge.api.fetchNotifications();
    } catch {
        return;
    }
    if (!Array.isArray(notes) || notes.length === 0) return;

    for (const note of notes) {
        if (note.type === "unlist") {
            const name = note.data?.build_name || "";
            showToast(
                t("notify.unlistedTitle"),
                t("notify.buildUnlisted").replace("{name}", name),
                6000
            );
        } else if (note.type === "arena_unlist") {
            // A game data update left a published Arena preset with problems, so it came out
            const name = note.data?.build_name || "";
            const cls = note.data?.class_name || "";
            showToast(
                t("notify.arenaUnlistedTitle"),
                t("notify.arenaUnlisted").replace("{name}", name).replace("{class}", cls),
                10000,
                "#c0504d"
            );
        } else if (note.type === "ban") {
            const bannedUntil = note.data?.banned_until ?? null;
            const reason      = note.data?.reason ?? null;
            // persist so the reminder fires on every subsequent page load
            localStorage.setItem("eftforge_ban", JSON.stringify({ banned_until: bannedUntil, reason }));
            _showBanToast(bannedUntil, reason);
        } else if (note.type === "unban") {
            localStorage.removeItem("eftforge_ban");
            showToast(t("notify.unbannedTitle"), t("notify.unbanned"), 8000, "#4CAF50");
        } else if (note.type === "new_comment") {
            const buildId = note.data?.build_id;
            if (buildId != null) {
                _addNewCommentBuildId(buildId, note.data?.game);
                _updateNewCommentBadge();
            }
        }
    }
}

/* ===========================
   ANNOUNCEMENTS
   Polled far more often than notifications so one sent from the admin API shows up
   within ANNOUNCEMENT_POLL_MS on every open page, plus right away when a hidden tab
   comes back, the window regains focus or the network returns. The server answers an
   unchanged list with a 304, so the short interval costs next to nothing.
=========================== */

const _ANNOUNCEMENT_POLL_MS = 30 * 1000;
const _ANNOUNCEMENT_LEVEL_COLORS = {
    info:     "#4a90d9",
    success:  "#4CAF50",
    warning:  "#f5a623",
    error:    "#e74c3c",
    critical: "#9b59b6",
};
let _announcementPollInterval = null;
let _announcementPollInFlight = false;
// Toasts on screen, by announcement id, so we can take them down again: a server
// announcement the admin deleted or that expired, or an offline notice once the
// server answers again (a non dismissible maintenance notice would otherwise stay up
// until the page reloads)
const _liveAnnouncementToasts = new Map();
const _staticAnnouncementToasts = new Map();

function _showAnnouncementToast(item) {
    return showToast(
        t("notify.announcementTitle"),
        item.message,
        0,
        _ANNOUNCEMENT_LEVEL_COLORS[item.level] || _ANNOUNCEMENT_LEVEL_COLORS.info,
        null,
        item.dismissible ?? true
    );
}

function _closeAnnouncementToastsExcept(toasts, keepIds) {
    for (const [id, toast] of toasts) {
        if (keepIds.has(String(id)) && toast.isConnected) continue;
        dismissToast(toast);
        toasts.delete(id);
    }
}

function _isExpired(item) {
    if (!item.expires_at) return false;
    // The server writes naive UTC timestamps; read them as UTC
    const raw = String(item.expires_at);
    const when = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw + "Z");
    return !isNaN(when) && when <= Date.now();
}

function _applyLiveAnnouncements(items) {
    // The server answers, so any offline notice is out of date
    _closeAnnouncementToastsExcept(_staticAnnouncementToasts, new Set());

    const liveIds = new Set(items.map(i => String(i.id)));
    _closeAnnouncementToastsExcept(_liveAnnouncementToasts, liveIds);

    const seen = _getSeenAnnouncements();
    // Prune server IDs (numeric) that no longer exist; keep string IDs from the offline file
    const pruned = [...seen].filter(id => isNaN(Number(id)) || liveIds.has(String(id)));
    if (pruned.length !== seen.size) {
        try { localStorage.setItem(_SEEN_ANNOUNCEMENTS_KEY, JSON.stringify(pruned)); } catch { /* storage full or blocked */ }
    }

    for (const item of items) {
        if (seen.has(item.id) || _liveAnnouncementToasts.has(item.id)) continue;
        // Remember it in this page too, so blocked storage can't make it pop up every poll
        try { _markAnnouncementSeen(item.id); } catch { /* storage full or blocked */ }
        _liveAnnouncementToasts.set(item.id, _showAnnouncementToast(item));
    }
}

function _applyStaticAnnouncements(items) {
    const current = items.filter(i => i && i.id != null && i.message && !_isExpired(i));
    // A notice taken out of the file (or expired) while the server is still down goes away too
    _closeAnnouncementToastsExcept(_staticAnnouncementToasts, new Set(current.map(i => String(i.id))));

    // Session only tracking, so the notice shows again on every page load while the backend is down
    for (const item of current) {
        if (_seenStaticThisSession.has(item.id)) continue;
        _seenStaticThisSession.add(item.id);
        _staticAnnouncementToasts.set(item.id, _showAnnouncementToast(item));
    }
}

async function _pollAnnouncements() {
    // A slow backend can take up to the fetch timeout, so don't stack polls behind it
    if (_announcementPollInFlight) return;
    _announcementPollInFlight = true;
    try {
        let items;
        try {
            items = await EFTForge.api.fetchAnnouncements();
        } catch {
            try {
                items = await EFTForge.api.fetchStaticAnnouncements();
            } catch {
                return;
            }
            _applyStaticAnnouncements(items);
            return;
        }
        _applyLiveAnnouncements(items);
    } finally {
        _announcementPollInFlight = false;
    }
}

function _startAnnouncementPolling() {
    _pollAnnouncements();
    window.addEventListener("focus", _pollAnnouncements);
    window.addEventListener("online", _pollAnnouncements);
    if (_announcementPollInterval) clearInterval(_announcementPollInterval);
    // Hidden tabs wait for the visibilitychange poll instead
    _announcementPollInterval = setInterval(() => {
        if (document.hidden) return;
        _pollAnnouncements();
    }, _ANNOUNCEMENT_POLL_MS);
}

function _startNotificationPolling() {
    _checkStoredBan();
    _updateNewCommentBadge();
    _pollNotifications();
    _startAnnouncementPolling();
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            _pollNotifications();
            _pollAnnouncements();
        }
    });
    if (_notifPollInterval) clearInterval(_notifPollInterval);
    // Hidden tabs wait for the visibilitychange poll above instead.
    _notifPollInterval = setInterval(() => {
        if (document.hidden) return;
        _pollNotifications();
    }, 5 * 60 * 1000);
}
