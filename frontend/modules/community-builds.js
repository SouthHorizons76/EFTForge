window.EFTForge = window.EFTForge || {};

/* exported handleBuildVoteClick, _loadPublicBuildByIdx, _loadMyCommunityBuildByIdx, _confirmUnlistByIdx -- called from other modules or index.html attributes */

/* ============================================================
   COMMUNITY BUILDS
   Browsing other players' published builds for the current gun:
   list, tag filters, ratings and comments.
============================================================ */

// Tag filters picked in the community builds list.
const _activeCbTagFilters = new Set();

/* ===========================
   COMMUNITY BUILDS
=========================== */

function _refreshBuildRatingCells() {
    /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".cb-rating[data-build-id]")).forEach(div => {
        const id      = div.dataset.buildId;
        const data    = (EFTForge.state.buildRatingsCache || {})[id];
        if (!data) return;
        const likeBtn = div.querySelector(".att-vote-like");
        if (likeBtn) {
            likeBtn.querySelector(".att-vote-count").textContent = data.likes;
            likeBtn.classList.toggle("active", data.user_vote === "like");
        }
    });
}

async function handleBuildVoteClick(event, buildId, vote) {
    event.stopPropagation();
    const idStr = String(buildId);
    EFTForge.state.buildRatingsCache = EFTForge.state.buildRatingsCache || {};
    const current  = EFTForge.state.buildRatingsCache[idStr] || { likes: 0, user_vote: null };
    const isLiked  = current.user_vote === "like";

    // Optimistic update
    const optimistic = { likes: isLiked ? Math.max(0, current.likes - 1) : current.likes + 1, user_vote: isLiked ? null : "like" };
    EFTForge.state.buildRatingsCache[idStr] = optimistic;
    _refreshBuildRatingCells();

    try {
        const result = isLiked
            ? await EFTForge.api.deleteBuildVote(buildId)
            : await EFTForge.api.postBuildVote(buildId, vote);
        EFTForge.state.buildRatingsCache[idStr] = { likes: result.likes, user_vote: result.user_vote };
    } catch {
        EFTForge.state.buildRatingsCache[idStr] = current;
    }
    _refreshBuildRatingCells();
}

async function _renderPublicBuilds(gunId) {
    const container = document.getElementById("public-builds-list");
    if (!container) return;

    let builds;
    try {
        builds = await EFTForge.api.fetchPublicBuilds(gunId);
    } catch (err) {
        const isKillSwitch = err.message === "community_builds_disabled";
        container.innerHTML = `<div style="color:${isKillSwitch ? "#888" : "#f44336"}; font-size:13px; ${isKillSwitch ? "font-style:italic;" : ""} padding:4px 0 2px 0;">${t(isKillSwitch ? "modal.communityBuildsUnavailable" : "modal.publicBuildsError")}</div>`;
        return;
    }

    // Keep badge in sync - dialog fetch is authoritative
    _communityCountCache[gunId] = Array.isArray(builds) ? builds.length : 0;
    if (EFTForge.state.currentGun?.id === gunId) updateGunBuildsBadge(gunId);

    if (builds.length >= 500) {
        showToast(t("cb.limitReachedTitle"), t("cb.limitReachedMsg"), 6000);
    }

    if (!builds || builds.length === 0) {
        container.innerHTML = `<div style="color:#555; font-size:13px; font-style:italic; padding:4px 0 2px 0;">${t("modal.noPublicBuilds")}</div>`;
        container._publicBuilds = [];
        const countEl = document.getElementById("public-builds-count");
        if (countEl) countEl.textContent = "";
        return;
    }

    // Pre-compute live prices so sorting by price works correctly.
    // Uses the same min(flea, trader) logic as the price panel.
    const traderPriceMap = {};
    for (const g of (EFTForge.state.allGuns || [])) {
        if (g.id && g.trader_price_rub != null) traderPriceMap[g.id] = g.trader_price_rub;
    }
    for (const items of Object.values(EFTForge.state.allowedCache || {})) {
        if (!Array.isArray(items)) continue;
        for (const item of items) {
            if (item.id && item.trader_price_rub != null && !(item.id in traderPriceMap))
                traderPriceMap[item.id] = item.trader_price_rub;
        }
    }
    const _pickCheaper = (a, b) => a == null ? b : b == null ? a : Math.min(a, b);

    for (const b of builds) {
        const allItemIds = [b.gun_id, ...(b.pairs || []).map(p => p[1])];
        const liveTotal = allItemIds.reduce((sum, id) => {
            const price = _pickCheaper(fleaPriceFor(id) ?? null, traderPriceMap[id] ?? null);
            return sum + (price ?? 0);
        }, 0);
        b._livePrice = liveTotal > 0 ? liveTotal : (b.total_price_rub || 0);
    }

    container._publicBuilds = builds;
    _applyPublicBuildsFilter();

    // Non-blocking: fetch build ratings in the background, update cells when ready
    EFTForge.api.fetchBulkBuildRatings(builds.map(b => b.id)).then(ratings => {
        EFTForge.state.buildRatingsCache = Object.assign(EFTForge.state.buildRatingsCache || {}, ratings);
        _refreshBuildRatingCells();
    }).catch(() => {});
}

function _toggleCbTagFilter(tag) {
    if (_activeCbTagFilters.has(tag)) _activeCbTagFilters.delete(tag);
    else _activeCbTagFilters.add(tag);
    _applyPublicBuildsFilter();
}
window._toggleCbTagFilter = _toggleCbTagFilter;

function _renderCbTagFilterRow(pool) {
    const { t } = EFTForge.lang;
    const allTags = [...new Set(pool.flatMap(b => b.tags ?? []))];
    if (allTags.length === 0) {
        const row = document.getElementById("cb-tag-filter-row");
        if (row) row.innerHTML = "";
        return;
    }
    for (const tag of [..._activeCbTagFilters]) {
        if (!allTags.includes(tag)) _activeCbTagFilters.delete(tag);
    }
    const row = document.getElementById("cb-tag-filter-row");
    if (!row) return;
    row.innerHTML = allTags.map(tag =>
        `<button class="build-tag-chip${_activeCbTagFilters.has(tag) ? " active" : ""}" data-tag="${escapeHtml(tag)}" onclick="_toggleCbTagFilter('${escapeHtml(tag)}')">${escapeHtml(t("tag." + tag))}</button>`
    ).join("");
}

function _applyPublicBuildsFilter() {
    const container = document.getElementById("public-builds-list");
    if (!container || !container._publicBuilds) return;

    const query  = (/** @type {HTMLInputElement | null} */ (document.getElementById("cb-search-input"))?.value  || "").trim().toLowerCase();
    const sortBy = /** @type {HTMLSelectElement | null} */ (document.getElementById("cb-sort-select"))?.value || "default";

    let builds = [...container._publicBuilds];

    if (query) {
        builds = builds.filter(b => {
            const name     = (b.build_name             || "").toLowerCase();
            const author   = (b.author_display_name    || "").toLowerCase();
            const authorZh = (b.author_display_name_zh || "").toLowerCase();
            return name.includes(query) || author.includes(query) || authorZh.includes(query);
        });
    }

    if (_activeCbTagFilters.size > 0) {
        builds = builds.filter(b =>
            [..._activeCbTagFilters].every(tag => (b.tags ?? []).includes(tag))
        );
    }

    const ratings = EFTForge.state.buildRatingsCache || {};
    switch (sortBy) {
        case "newest":
            builds.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
            break;
        case "loads":
            builds.sort((a, b) => (b.load_count || 0) - (a.load_count || 0));
            break;
        case "rating":
            builds.sort((a, b) => (ratings[b.id]?.likes || 0) - (ratings[a.id]?.likes || 0));
            break;
        case "true_ergo_delta":
        case "eed":
            builds.sort((a, b) => (_buildTrueErgo(b.stats) ?? -Infinity) - (_buildTrueErgo(a.stats) ?? -Infinity));
            break;
        case "recoil":
            builds.sort((a, b) => (a.stats?.recoil_v ?? Infinity) - (b.stats?.recoil_v ?? Infinity));
            break;
        case "price":
            builds.sort((a, b) => (a._livePrice || Infinity) - (b._livePrice || Infinity));
            break;
        default:
            builds.sort((a, b) => {
                if (b.is_featured !== a.is_featured) return b.is_featured ? 1 : -1;
                return new Date(b.published_at).getTime() - new Date(a.published_at).getTime();
            });
    }

    _renderCbTagFilterRow(container._publicBuilds);

    const countEl = document.getElementById("public-builds-count");
    if (countEl) {
        const total = container._publicBuilds.length;
        const shown = builds.length;
        countEl.textContent = (query || _activeCbTagFilters.size > 0) ? `${shown} / ${total}` : `${total}`;
    }

    if (builds.length === 0) {
        const msg = query ? t("cb.noMatch") : t("modal.noPublicBuilds");
        container.innerHTML = `<div style="color:#555; font-size:13px; font-style:italic; padding:4px 0 2px 0; grid-column:1/-1;">${msg}</div>`;
        container._displayedBuilds = [];
        return;
    }

    container._displayedBuilds = builds;
    _clearMarqueeTimers();

    const lang = EFTForge.state.lang;
    container.innerHTML = builds.map((b, idx) => {
        let authorName, avatarSrc;
        if (b.is_admin_build) {
            authorName = lang === "zh"
                ? (b.author_display_name_zh || b.author_display_name || "Morph1ne")
                : (b.author_display_name || "Morph1ne");
            avatarSrc = proxyAvatarUrl(b.author_avatar_url) || "./news/images/devProfilePic.jpg";
        } else {
            authorName = b.user_display_name || t("modal.anonymousAuthor");
            avatarSrc  = proxyAvatarUrl(b.user_avatar_url) || "./assets/images/tarkovcitizen.jpg";
        }

        const featuredLabel = b.is_featured
            ? `<div class="cb-featured-label">${t("cb.featured")}</div>`
            : "";

        const unlistBtn = b.is_mine
            ? `<button class="saved-build-btn unlist-btn" data-pub-idx="${idx}"
                       onclick="_confirmUnlistByIdx(this, this.dataset.pubIdx)">${t("modal.unlistBtn")}</button>`
            : "";

        const gunObj    = (EFTForge.state.allGuns || []).find(g => g.id === b.gun_id);
        const gunImgSrc = gunObj ? (gunObj.image_512_link || gunObj.icon_link || "") : "";
        const cardImgSrc = b.card_image_url || gunImgSrc;

        const s        = b.stats || {};
        const hasStats = b.stats !== null && b.stats !== undefined;

        const fmtErgo   = hasStats && s.ergo      != null ? parseFloat(s.ergo).toFixed(1)                           : "-";
        const fmtVRec   = hasStats && s.recoil_v  != null ? Math.round(s.recoil_v)                                  : "-";
        const fmtHRec   = hasStats && s.recoil_h  != null ? Math.round(s.recoil_h)                                  : "-";
        const te        = hasStats ? _buildTrueErgo(s) : null;
        const fmtTE     = te != null ? fmtTrueErgo(te) : "-";
        const fmtOS     = hasStats && s.overswing != null ? (s.overswing ? t("stats.yes") : t("stats.no"))          : "-";
        const teClass   = te != null ? (te >= 0 ? "positive" : "negative") : "";
        const osClass   = hasStats && s.overswing != null ? (s.overswing ? "negative" : "positive")                 : "";

        const fmtPrice = b._livePrice ? _formatPrice(b._livePrice) : "-";

        const publishedAt = b.published_at ? new Date(b.published_at + "Z") : null;
        const fmtDate = publishedAt
            ? publishedAt.toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric" })
            : "";

        return `
            <div class="cb-card${b.is_featured ? " featured" : ""}">
                ${featuredLabel}
                <div class="cb-gun-area">
                    ${cardImgSrc ? `<img class="cb-gun-img" src="${escapeHtml(cardImgSrc)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${escapeHtml(gunImgSrc)}" onerror="this.onerror=null; this.src=this.dataset.fallback;" />` : ""}
                </div>
                <div class="cb-card-body">
                    <div class="cb-build-name">
                        <span class="marquee-text">${escapeHtml(b.build_name)}</span>
                    </div>
                    <div class="cb-publish-date">${fmtDate}</div>
                    <div class="cb-author">
                        <img src="${escapeHtml(avatarSrc)}" class="cb-avatar" loading="lazy" onerror="this.src='./assets/images/tarkovcitizen.jpg';this.onerror=null;" />
                        <span class="cb-author-name"><span class="marquee-text">${escapeHtml(authorName)}</span></span>
                    </div>
                    <div class="cb-load-count">${b.load_count ?? 0} ${t("cb.loads")}</div>
                    ${(b.tags ?? []).length > 0 ? `<div class="cb-card-tags">${(b.tags).map(tag => `<span class="build-tag-chip" data-tag="${escapeHtml(tag)}">${escapeHtml(t("tag." + tag))}</span>`).join("")}</div>` : ""}
                </div>
                <div class="cb-stats">
                    <div class="cb-stat"><div class="cb-stat-label">${t("stats.ergo")}</div><div class="cb-stat-val">${fmtErgo}</div></div>
                    <div class="cb-stat"><div class="cb-stat-label">${t("cb.statCost")}</div><div class="cb-stat-val cb-price">${fmtPrice}</div></div>
                    <div class="cb-stat"><div class="cb-stat-label">${t("stats.verRecoil")}</div><div class="cb-stat-val">${fmtVRec}</div></div>
                    <div class="cb-stat"><div class="cb-stat-label">${t("stats.horRecoil")}</div><div class="cb-stat-val">${fmtHRec}</div></div>
                    <div class="cb-stat"><div class="cb-stat-label">${t("stats.trueErgo")}</div><div class="cb-stat-val ${teClass}">${fmtTE}</div></div>
                    <div class="cb-stat"><div class="cb-stat-label">${t("cb.statOverswing")}</div><div class="cb-stat-val ${osClass}">${fmtOS}</div></div>
                </div>
                <div class="cb-stats-note">${t("cb.statsNote")}</div>
                <div class="cb-card-footer">
                    <div class="cb-rating att-rating" data-build-id="${b.id}">
                        <button class="att-vote-btn att-vote-like" data-tooltip="${escapeHtml(t("cb.rating.like"))}" onclick="handleBuildVoteClick(event,${b.id},'like')"><img src="./assets/images/icon-fir.png" class="att-vote-icon" /><span class="att-vote-count">0</span></button>
                    </div>
                    ${unlistBtn}
                    <button class="saved-build-btn cb-comments-toggle-btn" data-build-id="${b.id}"
                            onclick="_toggleBuildComments(event,${b.id})">${t("cb.comments")}${b.comment_count > 0 ? ` (${b.comment_count})` : ""}</button>
                    <button class="saved-build-btn load-btn" data-pub-idx="${idx}"
                            onclick="_loadPublicBuildByIdx(this.dataset.pubIdx)">${t("ui.load")}</button>
                </div>
                <div class="cb-comments-section" id="cb-comments-${b.id}" style="display:none;"></div>
            </div>
        `;
    }).join("");

    _initMarqueeText(container, { hoverOnly: true, hoverTarget: ".cb-card" });
    _refreshBuildRatingCells();
}

async function _loadPublicBuildByIdx(idx) {
    const container = document.getElementById("public-builds-list");
    if (!container) return;

    const pool  = container._displayedBuilds || container._publicBuilds;
    if (!pool) return;
    const build = pool[parseInt(idx, 10)];
    if (!build || !build.pairs) return;

    const lang = EFTForge.state.lang;
    let authorName, avatarUrl;
    if (build.is_admin_build) {
        authorName = lang === "zh"
            ? (build.author_display_name_zh || build.author_display_name || "Morph1ne")
            : (build.author_display_name || "Morph1ne");
        avatarUrl = proxyAvatarUrl(build.author_avatar_url) || "./news/images/devProfilePic.jpg";
    } else {
        authorName = build.user_display_name || t("modal.anonymousAuthor");
        avatarUrl  = proxyAvatarUrl(build.user_avatar_url) || null;
    }

    const communityBuildInfo = {
        pairsKey:      _pairsKey(build.pairs),
        authorName,
        avatarUrl,
        buildName:     build.build_name,
        cardImageUrl:  build.card_image_url || null,
    };

    const dlg = document.getElementById("builds-dialog");
    if (dlg) dlg.remove();

    EFTForge.api.recordBuildLoad(build.id);

    const payload = { g: build.gun_id, p: build.pairs, a: build.ammo_id || null };
    if (document.body.dataset.mobile !== "true") {
        await EFTForge.tabs.createTabFromPayload(payload, build.build_name, communityBuildInfo, false);
    } else {
        await loadBuildFromPayload(payload, build.build_name);
        // Set after loadBuildFromPayload (which calls selectGun internally, clearing communityBuild).
        // syncBuildDisplayName was already called at the end of loadBuildFromPayload, so call it again
        // now that communityBuild is populated.
        EFTForge.state.communityBuild = communityBuildInfo;
        syncBuildDisplayName();
    }
}

async function _loadMyCommunityBuildByIdx(idx) {
    const container = document.getElementById("my-community-list");
    if (!container) return;

    const pool  = container._displayedMyBuilds || container._myBuilds;
    if (!pool) return;
    const build = pool[parseInt(idx, 10)];
    if (!build || !build.pairs) return;

    const { t } = EFTForge.lang;
    const communityBuildInfo = {
        pairsKey:     _pairsKey(build.pairs),
        authorName:   build.user_display_name || t("modal.anonymousAuthor"),
        avatarUrl:    build.user_avatar_url   || null,
        buildName:    build.build_name,
        cardImageUrl: build.card_image_url    || null,
    };

    const dlg = document.getElementById("builds-dialog");
    if (dlg) dlg.remove();

    EFTForge.api.recordBuildLoad(build.id);

    const payload = { g: build.gun_id, p: build.pairs, a: build.ammo_id || null };
    if (document.body.dataset.mobile !== "true") {
        await EFTForge.tabs.createTabFromPayload(payload, build.build_name, communityBuildInfo, false);
    } else {
        await loadBuildFromPayload(payload, build.build_name);
        EFTForge.state.communityBuild = communityBuildInfo;
        syncBuildDisplayName();
    }
}

function _isAdminSession() {
    return !!localStorage.getItem("eftforge_admin_key");
}

async function _toggleBuildComments(event, buildId) {
    event.stopPropagation();
    const section = document.getElementById(`cb-comments-${buildId}`);
    if (!section) return;
    const isOpen = section.style.display !== "none";
    if (isOpen) {
        section.style.display = "none";
        return;
    }
    section.style.display = "block";
    _clearNewCommentBuildId(buildId);
    _updateNewCommentBadge();
    document.querySelectorAll(`.cb-comments-toggle-btn[data-build-id="${buildId}"]`).forEach(b => b.classList.remove("has-new-comment"));
    _renderBuildCommentsSection(section, buildId);
}
window._toggleBuildComments = _toggleBuildComments;

async function _renderBuildCommentsSection(section, buildId) {
    const { t } = EFTForge.lang;
    section.innerHTML = `<div class="cb-comments-loading">${t("cb.commentsLoading")}</div>`;
    let comments = [];
    try {
        comments = await EFTForge.api.fetchBuildComments(buildId);
    } catch {
        section.innerHTML = `<div class="cb-comments-error">${t("cb.commentsError")}</div>`;
        return;
    }
    _renderCommentsContent(section, buildId, comments);
}

function _renderCommentsContent(section, buildId, comments) {
    const { t } = EFTForge.lang;
    const lang = EFTForge.state.lang;
    const isAdmin = _isAdminSession();
    const commentsHtml = comments.length === 0
        ? `<div class="cb-no-comments">${t("cb.noComments")}</div>`
        : comments.map(c => {
            const dt = new Date(c.created_at + "Z");
            const fmtDt = dt.toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric" });
            let deleteBtn = "";
            if (isAdmin) deleteBtn = ` <button class="cb-comment-delete-btn" onclick="_deleteComment(event,${c.id},${buildId})">&#x2715;</button>`;
            else if (c.is_mine) deleteBtn = ` <button class="cb-comment-delete-btn" onclick="_deleteOwnComment(event,${c.id},${buildId})">&#x2715;</button>`;
            const commentAuthor = c.user_display_name || t("modal.anonymousAuthor");
            const commentAvatar = proxyAvatarUrl(c.user_avatar_url) || "./assets/images/tarkovcitizen.jpg";
            return `<div class="cb-comment" data-comment-id="${c.id}">
                <div class="cb-comment-author">
                    <img class="cb-avatar loaded" src="${escapeHtml(commentAvatar)}" onerror="this.src='./assets/images/tarkovcitizen.jpg'" />
                    <span class="cb-comment-author-name">${escapeHtml(commentAuthor)}</span>
                    <span class="cb-comment-date">${fmtDt}${deleteBtn}</span>
                </div>
                <div class="cb-comment-content">${escapeHtml(c.content)}</div>
            </div>`;
        }).join("");

    // Mobile is read-only for community builds - no publishing, no commenting
    const formHtml = document.body.dataset.mobile === "true" ? "" : `
        <div class="cb-comment-form">
            <textarea class="cb-comment-textarea" placeholder="${escapeHtml(t("cb.commentPlaceholder"))}" maxlength="280" rows="2"></textarea>
            <div class="cb-comment-form-footer">
                <span class="cb-comment-charcount">0 / 280</span>
                <button class="modal-btn primary cb-comment-submit">${t("cb.commentSubmit")}</button>
            </div>
        </div>
    `;

    section.innerHTML = `
        <div class="cb-comments-list">${commentsHtml}</div>
        ${formHtml}
    `;

    if (!formHtml) return;

    const textarea = section.querySelector(".cb-comment-textarea");
    const charCount = section.querySelector(".cb-comment-charcount");
    const submitBtn = section.querySelector(".cb-comment-submit");

    textarea.addEventListener("input", () => {
        charCount.textContent = `${textarea.value.length} / 280`;
    });

    submitBtn.addEventListener("click", async () => {
        const content = textarea.value.trim();
        if (!content) return;
        submitBtn.disabled = true;
        submitBtn.textContent = "...";
        try {
            const newComment = await EFTForge.api.postBuildComment(buildId, content);
            comments.push(newComment);
            _renderCommentsContent(section, buildId, comments);
            const { t: _tc } = EFTForge.lang;
            const toggleBtn = document.querySelector(`.cb-comments-toggle-btn[data-build-id="${buildId}"]`);
            if (toggleBtn) toggleBtn.textContent = `${_tc("cb.comments")} (${comments.length})`;
        } catch (err) {
            submitBtn.disabled = false;
            submitBtn.textContent = t("cb.commentSubmit");
            showToast(t("toast.connectionError"), err.message || t("cb.commentError"), 3500);
        }
    });
}

async function _deleteComment(event, commentId, buildId) {
    event.stopPropagation();
    const { t } = EFTForge.lang;
    try {
        await EFTForge.api.adminDeleteComment(commentId);
        const section = document.getElementById(`cb-comments-${buildId}`);
        if (section) {
            const commentEl = section.querySelector(`[data-comment-id="${commentId}"]`);
            if (commentEl) commentEl.remove();
            const remaining = section.querySelectorAll(".cb-comment").length;
            const toggleBtn = document.querySelector(`.cb-comments-toggle-btn[data-build-id="${buildId}"]`);
            if (toggleBtn) toggleBtn.textContent = remaining > 0 ? `${t("cb.comments")} (${remaining})` : t("cb.comments");
        }
    } catch (err) {
        showToast(t("toast.connectionError"), err.message || t("cb.deleteCommentFailed"), 3000);
    }
}
window._deleteComment = _deleteComment;

async function _deleteOwnComment(event, commentId, buildId) {
    event.stopPropagation();
    const { t } = EFTForge.lang;
    try {
        await EFTForge.api.deleteOwnComment(buildId, commentId);
        const section = document.getElementById(`cb-comments-${buildId}`);
        if (section) {
            const commentEl = section.querySelector(`[data-comment-id="${commentId}"]`);
            if (commentEl) commentEl.remove();
            const remaining = section.querySelectorAll(".cb-comment").length;
            const toggleBtn = document.querySelector(`.cb-comments-toggle-btn[data-build-id="${buildId}"]`);
            if (toggleBtn) toggleBtn.textContent = remaining > 0 ? `${t("cb.comments")} (${remaining})` : t("cb.comments");
        }
    } catch (err) {
        showToast(t("toast.connectionError"), err.message || t("cb.deleteCommentFailed"), 3000);
    }
}
window._deleteOwnComment = _deleteOwnComment;

function _confirmUnlistByIdx(btn, idx) {
    if (btn.dataset.confirming === "1") {
        _unlistPublicBuildByIdx(idx);
        return;
    }
    btn.dataset.confirming = "1";
    btn.textContent = t("ui.confirm");
    btn.style.background = "#3d0f0f";
    btn.style.color = "#eee";
    btn.style.borderColor = "#f44336";

    const reset = () => {
        if (btn.dataset.confirming !== "1") return;
        delete btn.dataset.confirming;
        btn.textContent = t("modal.unlistBtn");
        btn.style.background = "";
        btn.style.color = "";
        btn.style.borderColor = "";
    };
    setTimeout(reset, 3000);
    btn.addEventListener("mouseleave", reset, { once: true });
}

async function _unlistPublicBuildByIdx(idx) {
    const container = document.getElementById("public-builds-list");
    if (!container) return;

    const pool  = container._displayedBuilds || container._publicBuilds;
    if (!pool) return;
    const build = pool[parseInt(idx, 10)];
    if (!build) return;

    try {
        await EFTForge.api.unlistBuild(build.id);

        // Remove from published-ids so the Publish button becomes active again
        const published = new Set(JSON.parse(localStorage.getItem("eftforge_published_ids") || "[]"));
        const saveData = loadSavedBuilds();
        let localChanged = false;
        for (const entry of saveData.builds) {
            if (entry.publishedId === build.id) {
                delete entry.publishedId;
                published.delete(entry.id);
                localChanged = true;
            } else if (!entry.publishedId && entry.gunId === build.gun_id && entry.name === build.build_name) {
                // Legacy fallback for builds published before publishedId was stored
                published.delete(entry.id);
            }
        }
        localStorage.setItem("eftforge_published_ids", JSON.stringify([...published]));
        if (localChanged) persistSavedBuilds(saveData);

        showToast(t("toast.unlistSuccess"), t("toast.unlistSuccessMsg"), 3000, "#4CAF50");
        const refreshGunId = EFTForge.state.currentGun?.id || build.gun_id;
        renderSavedBuildsList("", refreshGunId);
        _renderPublicBuilds(refreshGunId);
    } catch (err) {
        showToast(t("toast.unlistFailed"), err.message || "", 3500);
    }
}
