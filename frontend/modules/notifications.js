window.EFTForge = window.EFTForge || {};

/* exported _clearNewCommentBuildId, _startNotificationPolling -- called from other modules or index.html attributes */

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

const _NEW_COMMENT_KEY = "eftforge_new_comment_builds";

function _getNewCommentBuildIds() {
    try { return new Set(JSON.parse(localStorage.getItem(_NEW_COMMENT_KEY) || "[]")); }
    catch { return new Set(); }
}

function _addNewCommentBuildId(buildId) {
    const ids = _getNewCommentBuildIds();
    ids.add(buildId);
    localStorage.setItem(_NEW_COMMENT_KEY, JSON.stringify([...ids]));
}

function _clearNewCommentBuildId(buildId) {
    const ids = _getNewCommentBuildIds();
    ids.delete(buildId);
    localStorage.setItem(_NEW_COMMENT_KEY, JSON.stringify([...ids]));
}

function _updateNewCommentBadge() {
    const ids = _getNewCommentBuildIds();
    const count = ids.size;
    const badge = count > 0 ? (count > 99 ? "99+" : String(count)) : "";

    const btn = document.getElementById("builds-btn");
    if (btn) btn.dataset.badge = badge;

    const tabBtn = document.querySelector('#builds-dialog .modal-tab[data-target="bm-tab-community"]');
    if (tabBtn) tabBtn.classList.toggle("has-new-comment", count > 0);
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
                _addNewCommentBuildId(buildId);
                _updateNewCommentBadge();
            }
        }
    }
}

async function _pollAnnouncements() {
    let items;
    let fromStatic = false;
    try {
        items = await EFTForge.api.fetchAnnouncements();
    } catch {
        try {
            items = await EFTForge.api.fetchStaticAnnouncements();
            fromStatic = true;
        } catch {
            return;
        }
    }
    if (!Array.isArray(items)) return;

    if (!fromStatic) {
        const seen = _getSeenAnnouncements();
        // Prune server IDs (numeric) that no longer exist; preserve string IDs from static file
        const liveIds = new Set(items.map(i => String(i.id)));
        const pruned = [...seen].filter(id => isNaN(Number(id)) || liveIds.has(String(id)));
        if (pruned.length !== seen.size)
            localStorage.setItem(_SEEN_ANNOUNCEMENTS_KEY, JSON.stringify(pruned));

        if (items.length === 0) return;
        const levelColor = {
            info:     "#4a90d9",
            success:  "#4CAF50",
            warning:  "#f5a623",
            error:    "#e74c3c",
            critical: "#9b59b6",
        };
        for (const item of items) {
            if (seen.has(item.id)) continue;
            _markAnnouncementSeen(item.id);
            showToast(t("notify.announcementTitle"), item.message, 0, levelColor[item.level] || "#4a90d9", null, item.dismissible ?? true);
        }
    } else {
        // Static fallback: use session-only tracking so the toast re-appears on every page load while backend is down
        if (items.length === 0) return;
        const levelColor = {
            info:     "#4a90d9",
            success:  "#4CAF50",
            warning:  "#f5a623",
            error:    "#e74c3c",
            critical: "#9b59b6",
        };
        for (const item of items) {
            if (_seenStaticThisSession.has(item.id)) continue;
            _seenStaticThisSession.add(item.id);
            showToast(t("notify.announcementTitle"), item.message, 0, levelColor[item.level] || "#4a90d9", null, item.dismissible ?? true);
        }
    }
}

function _startNotificationPolling() {
    _checkStoredBan();
    _updateNewCommentBadge();
    _pollNotifications();
    _pollAnnouncements();
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
        _pollAnnouncements();
    }, 5 * 60 * 1000);
}
