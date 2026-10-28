window.EFTForge = window.EFTForge || {};

/* exported showPublishConfirmPanel, _loadMyCommunityBuilds -- called from other modules or index.html attributes */

/* ============================================================
   BUILD PUBLISHING
   The publish confirm panel, and the My Community Builds tab of
   the builds dialog (the user's own published builds).
============================================================ */

/* ===========================
   PUBLISH CONFIRM PANEL
=========================== */

function showPublishConfirmPanel(buildName, entryId) {
    if (blockedInBeta()) return;
    EFTForge.state.publishMode = true;
    EFTForge.builder3d?.onPublishModeChange();
    document.getElementById("panel-resizer")?.classList.add("publish-mode");

    if (isMobileLayout()) {
        const tray = document.getElementById("mobile-publish-tray");
        if (tray) tray.textContent = t("publish.mobileTray");
        document.body.classList.add("mobile-publish-mode");
        openMobileRightPanel();
    }

    const gun = EFTForge.state.currentGun;

    const placeholder    = document.getElementById("attachment-placeholder");
    const tableContainer = document.getElementById("attachment-table-container");

    // clear the attachment table
    tableContainer.innerHTML = "";

    const imgSrc = window._bpGetLastImageUrl?.() || gun.image_512_link || gun.icon_link || "";

    const { builds: _allBuilds } = loadSavedBuilds();
    const _publishEntry = _allBuilds.find(b => b.id === entryId);

    placeholder.style.display = "flex";
    placeholder.innerHTML = `
        <div class="placeholder-inner" id="publish-confirm-panel" style="white-space:normal; max-width:100%; box-sizing:border-box;">
            <img id="gun-display-image" src="${escapeHtml(imgSrc)}"
                 style="${imgSrc ? "" : "display:none;"}max-height:120px; object-fit:contain; margin-bottom:16px;" />
            <div style="font-size:22px; font-weight:700; color:#f5c542; margin-bottom:8px;">
                ${escapeHtml(buildName)}
            </div>
            ${_tagChipsHtml(_publishEntry?.tags ?? [])}
            <div style="font-size:13px; color:#aaa; margin-bottom:4px; text-align:center; line-height:1.6;">
                ${escapeHtml(t("publish.confirm"))}
            </div>
            <div style="font-size:11px; color:#666; margin-bottom:12px; text-align:center;">
                ${escapeHtml(t("publish.confirmSub"))}
            </div>
            <div style="font-size:11px; font-weight:700; color:#c0392b; background:#1a0a0a; border:1px solid #5a1a1a; border-radius:4px; padding:8px 12px; margin-bottom:20px; text-align:center; line-height:1.6; white-space:normal; max-width:min(420px, 100%);">
                ${escapeHtml(t("publish.nameWarning"))}
            </div>
            <div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:center;">
                <button class="modal-btn" id="pub-btn-cancel">${escapeHtml(t("publish.btnCancel"))}</button>
                <button class="modal-btn" id="pub-btn-modify">${escapeHtml(t("publish.btnModify"))}</button>
                <button class="modal-btn primary" id="pub-btn-confirm">${escapeHtml(t("publish.btnConfirm"))}</button>
            </div>
        </div>
    `;

    document.getElementById("pub-btn-cancel").addEventListener("click",  _cancelPublish);
    document.getElementById("pub-btn-modify").addEventListener("click",  _modifyPublish);
    document.getElementById("pub-btn-confirm").addEventListener("click", () => _confirmPublish(buildName, entryId));
}

function _cancelPublish() {
    document.body.classList.remove("mobile-publish-mode");
    closeMobileRightPanel();
    EFTForge.state.publishMode = false;
    _restoreNormalPlaceholder({ restoreView: false });
    returnToGunSelection();
}

function _modifyPublish() {
    document.body.classList.remove("mobile-publish-mode");
    closeMobileRightPanel();
    EFTForge.state.publishMode = false;
    _restoreNormalPlaceholder();
    syncBuildDisplayName();
}

function _restoreNormalPlaceholder({ restoreView = true } = {}) {
    document.getElementById("panel-resizer")?.classList.remove("publish-mode");
    const gun         = EFTForge.state.currentGun;
    const placeholder = document.getElementById("attachment-placeholder");
    const baseSrc     = gun.image_512_link || gun.icon_link || "";
    const genSrc      = window._bpIsEnabled?.() ? (window._bpGetPlaceholderUrl?.() || "") : "";
    const imgSrc      = genSrc || baseSrc;

    placeholder.innerHTML = `
        <div class="placeholder-inner">
            <div class="bp-display-wrap"><img id="gun-display-image" class="gun-display-image"
                 src="${escapeHtml(imgSrc)}"
                 ${imgSrc ? "" : 'style="display:none;"'} />${_bpWorkingLogoHtml()}</div>
            <div id="gun-display-name" class="gun-display-name">
                ${escapeHtml(gun.name)}
            </div>
            <div id="build-display-tags" class="build-display-tags">${_tagChipsHtml(_currentBuildTags())}</div>
            <strong><em id="placeholder-main">${escapeHtml(t("placeholder.modding"))}</em></strong>
            <span class="placeholder-sub">
                <strong><em id="placeholder-sub">${escapeHtml(t(isMobileLayout() ? "placeholder.longPress" : "placeholder.rightClick"))}</em></strong>
            </span>
        </div>
    `;
    EFTForge.optimizer?.onPlaceholderRestore();
    EFTForge.builder3d?.onPublishModeChange({ restoreView });
}

async function _confirmPublish(buildName, entryId) {
    const confirmBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("pub-btn-confirm"));
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = t("publish.publishing");
    }

    const gun   = EFTForge.state.currentGun;
    const pairs = collectSlotPairs(EFTForge.state.buildTree);
    const ammoSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById("ammo-select"));
    const ammoId = ammoSelect?.value || null;

    const stats = {
        ergo:      EFTForge.state.lastTotalErgo  ?? null,
        recoil_v:  EFTForge.state.lastRecoilV    ?? null,
        recoil_h:  EFTForge.state.lastRecoilH    ?? null,
        weight:    EFTForge.state.lastTotalWeight ?? null,
        true_ergo_delta: EFTForge.state.lastTrueErgo   ?? null,
        overswing: EFTForge.state.lastOverswing   ?? null,
        arm_stam:  EFTForge.state.lastArmStamina  ?? null,
    };

    const userProfile = EFTForge.profile ? EFTForge.profile.getProfile() : {};

    try {
        const { builds: _publishBuilds } = loadSavedBuilds();
        const _publishLocalEntry = _publishBuilds.find(b => b.id === entryId);

        const result = await EFTForge.api.publishBuild({
            gun_id:            gun.id,
            build_name:        buildName,
            pairs,
            stats,
            ammo_id:           ammoId,
            author_username:   userProfile.username   || null,
            author_avatar_url: userProfile.avatar_url || null,
            tags:              _publishLocalEntry?.tags ?? [],
        });

        // Mark this build as published so its button shows "Published" (greyed out)
        if (entryId) {
            const published = new Set(JSON.parse(localStorage.getItem("eftforge_published_ids") || "[]"));
            published.add(entryId);
            localStorage.setItem("eftforge_published_ids", JSON.stringify([...published]));
            // Store the server build ID so we can unlist it directly if the local entry is deleted
            if (result?.id) {
                const saveData = loadSavedBuilds();
                const localEntry = saveData.builds.find(b => b.id === entryId);
                if (localEntry) {
                    localEntry.publishedId = result.id;
                    persistSavedBuilds(saveData);
                }
            }
        }

        document.body.classList.remove("mobile-publish-mode");
        closeMobileRightPanel();
        EFTForge.state.publishMode = false;
        _restoreNormalPlaceholder();
        syncBuildDisplayName();
        showToast(t("toast.publishSuccess"), t("toast.publishSuccessMsg"), 3000, "#4CAF50");
    } catch (err) {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = t("publish.btnConfirm");
        }
        let msg = err.message || "";
        if (msg === "rate_limit") msg = t("toast.publishRateLimit");
        else if (msg === "community_builds_limit_reached") msg = t("toast.publishLimitReached");
        else if (msg.includes("banned") || msg.includes("ban")) msg = t("toast.publishBanned");
        showToast(t("toast.publishFailed"), msg, 4500);
    }
}


/* ===========================
   MY COMMUNITY BUILDS (builds dialog tab)
=========================== */

async function _loadMyCommunityBuilds() {
    const { t } = EFTForge.lang;
    try {
        const builds = await EFTForge.api.fetchMyBuilds();
        _renderMyCommunityBuilds(builds);
        if (builds.length > 0) {
            EFTForge.api.fetchBulkBuildRatings(builds.map(b => b.id)).then(ratings => {
                EFTForge.state.buildRatingsCache = Object.assign(EFTForge.state.buildRatingsCache || {}, ratings);
                _refreshBuildRatingCells();
            }).catch(() => {});
        }
    } catch {
        const container = document.getElementById("my-community-list");
        if (container) container.innerHTML = `<div style="color:#888; font-size:13px; font-style:italic; padding:4px 0;">${t("modal.myCommunityError")}</div>`;
    }
}

function _renderMyCommunityBuilds(builds) {
    const container = document.getElementById("my-community-list");
    if (!container) return;
    container._myBuilds = builds || [];
    _applyMyCommunityFilter();
}

function _applyMyCommunityFilter() {
    const container = document.getElementById("my-community-list");
    if (!container || !container._myBuilds) return;
    const { t } = EFTForge.lang;
    const lang = EFTForge.state.lang;

    const query = (/** @type {HTMLInputElement | null} */ (document.getElementById("my-community-search"))?.value || "").trim().toLowerCase();

    let builds = container._myBuilds;
    if (query) {
        builds = builds.filter(b => {
            const gun       = gunById(b.gun_id);
            const buildName = (b.build_name || "").toLowerCase();
            // Cards show the short name, but keep the full name searchable too
            const gunName   = ((gun && gun.name) || b.gun_name || "").toLowerCase();
            const gunShort  = ((gun && gun.short_name) || "").toLowerCase();
            return buildName.includes(query) || gunName.includes(query) || gunShort.includes(query);
        });
    }

    const countEl = document.getElementById("my-community-count");
    if (countEl) {
        const total = container._myBuilds.length;
        const shown = builds.length;
        countEl.textContent = query ? `${shown} / ${total}` : `${total}`;
    }

    if (builds.length === 0) {
        const msg = query ? t("cb.noMatch") : t("modal.myCommunityEmpty");
        container.innerHTML = `<div style="color:#555; font-size:13px; font-style:italic; padding:4px 0; grid-column:1/-1;">${msg}</div>`;
        return;
    }

    container._displayedMyBuilds = builds;

    const _newCommentIds = _getNewCommentBuildIds();

    container.innerHTML = builds.map((b, idx) => {
        const gunObj     = gunById(b.gun_id);
        const gunName    = (gunObj && (gunObj.short_name || gunObj.name)) || b.gun_name || "";
        const gunImgSrc  = gunObj ? (gunObj.image_512_link || gunObj.icon_link || "") : "";
        const cardImgSrc = b.card_image_url || gunImgSrc;

        const s        = b.stats || {};
        const hasStats = b.stats !== null && b.stats !== undefined;
        const fmtErgo  = hasStats && s.ergo      != null ? parseFloat(s.ergo).toFixed(1)                           : "-";
        const fmtVRec  = hasStats && s.recoil_v  != null ? Math.round(s.recoil_v)                                  : "-";
        const fmtHRec  = hasStats && s.recoil_h  != null ? Math.round(s.recoil_h)                                  : "-";
        const te       = hasStats ? _buildTrueErgo(s) : null;
        const fmtTE    = te != null ? fmtTrueErgo(te) : "-";
        const fmtOS    = hasStats && s.overswing != null ? (s.overswing ? t("stats.yes") : t("stats.no"))          : "-";
        const teClass  = te != null ? (te >= 0 ? "positive" : "negative") : "";
        const osClass  = hasStats && s.overswing != null ? (s.overswing ? "negative" : "positive")                 : "";

        const publishedAt = b.published_at ? new Date(b.published_at + "Z") : null;
        const fmtDate = publishedAt
            ? publishedAt.toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric" })
            : "";

        const featuredLabel = b.is_featured
            ? `<div class="cb-featured-label">${t("cb.featured")}</div>`
            : "";

        return `
            <div class="cb-card${b.is_featured ? " featured" : ""}">
                ${featuredLabel}
                <div class="cb-gun-area">
                    ${cardImgSrc ? `<img class="cb-gun-img" src="${escapeHtml(cardImgSrc)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${escapeHtml(gunImgSrc)}" onerror="this.onerror=null; this.src=this.dataset.fallback;" />` : ""}
                </div>
                <div class="cb-card-body">
                    <div class="cb-build-name"><span class="marquee-text">${escapeHtml(b.build_name)}</span></div>
                    <div class="cb-publish-date">${fmtDate}</div>
                    <div style="color:#555; font-size:12px; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(gunName)}</div>
                    <div class="cb-load-count">${b.load_count ?? 0} ${t("cb.loads")}</div>
                    ${(b.tags ?? []).length > 0 ? `<div class="cb-card-tags">${(b.tags).map(tag => `<span class="build-tag-chip" data-tag="${escapeHtml(tag)}">${escapeHtml(t("tag." + tag))}</span>`).join("")}</div>` : ""}
                </div>
                <div class="cb-stats">
                    <div class="cb-stat"><div class="cb-stat-label">${t("stats.ergo")}</div><div class="cb-stat-val">${fmtErgo}</div></div>
                    <div class="cb-stat"><div class="cb-stat-label">${t("cb.statCost")}</div><div class="cb-stat-val">-</div></div>
                    <div class="cb-stat"><div class="cb-stat-label">${t("stats.verRecoil")}</div><div class="cb-stat-val">${fmtVRec}</div></div>
                    <div class="cb-stat"><div class="cb-stat-label">${t("stats.horRecoil")}</div><div class="cb-stat-val">${fmtHRec}</div></div>
                    <div class="cb-stat"><div class="cb-stat-label">${t("stats.trueErgo")}</div><div class="cb-stat-val ${teClass}">${fmtTE}</div></div>
                    <div class="cb-stat"><div class="cb-stat-label">${t("cb.statOverswing")}</div><div class="cb-stat-val ${osClass}">${fmtOS}</div></div>
                </div>
                <div class="cb-stats-note">${t("cb.statsNote")}</div>
                <div class="cb-card-footer">
                    <div class="cb-rating att-rating" data-build-id="${b.id}">
                        <button class="att-vote-btn att-vote-like" data-tooltip="${escapeHtml(t("cb.rating.like"))}"
                                onclick="handleBuildVoteClick(event,${b.id},'like')">
                            <img src="./assets/images/icon-fir.png" class="att-vote-icon" />
                            <span class="att-vote-count">0</span>
                        </button>
                    </div>
                    <button class="saved-build-btn unlist-btn" data-build-id="${b.id}"
                            onclick="_confirmUnlistMyBuild(this,'${b.id}')">${t("modal.unlistBtn")}</button>
                    <button class="saved-build-btn cb-comments-toggle-btn${_newCommentIds.has(b.id) ? " has-new-comment" : ""}" data-build-id="${b.id}"
                            onclick="_toggleBuildComments(event,${b.id})">${t("cb.comments")}${b.comment_count > 0 ? ` (${b.comment_count})` : ""}</button>
                    <button class="saved-build-btn load-btn" data-my-idx="${idx}"
                            onclick="_loadMyCommunityBuildByIdx(this.dataset.myIdx)">${t("ui.load")}</button>
                </div>
                <div class="cb-comments-section" id="cb-comments-${b.id}" style="display:none;"></div>
            </div>
        `;
    }).join("");

    _initMarqueeText(container, { hoverOnly: true, hoverTarget: ".cb-card" });
    _refreshBuildRatingCells();
}

function _confirmUnlistMyBuild(btn, buildId) {
    if (blockedInBeta()) return;
    if (btn.dataset.confirming === "1") {
        _unlistMyBuild(btn, buildId);
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
window._confirmUnlistMyBuild = _confirmUnlistMyBuild;

async function _unlistMyBuild(btn, buildId) {
    try {
        await EFTForge.api.unlistBuild(buildId);

        const published = new Set(JSON.parse(localStorage.getItem("eftforge_published_ids") || "[]"));
        const saveData = loadSavedBuilds();
        let localChanged = false;
        for (const entry of saveData.builds) {
            if (entry.publishedId === buildId) {
                delete entry.publishedId;
                published.delete(entry.id);
                localChanged = true;
            }
        }
        localStorage.setItem("eftforge_published_ids", JSON.stringify([...published]));
        if (localChanged) persistSavedBuilds(saveData);

        const card = btn.closest(".cb-card");
        if (card) card.remove();

        renderSavedBuildsList(/** @type {HTMLInputElement | null} */ (document.getElementById("builds-search-input"))?.value ?? "");
        showToast(t("toast.unlistSuccess"), t("toast.unlistSuccessMsg"), 3000, "#4CAF50");
    } catch (err) {
        showToast(t("toast.unlistFailed"), err.message || "", 3500);
    }
}
