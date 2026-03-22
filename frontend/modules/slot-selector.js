window.EFTForge = window.EFTForge || {};

/* ===========================
   MOBILE ATTACHMENT MODAL
=========================== */

function showMobileAttachmentModal(item, entry) {
    const existing = document.getElementById("mobile-att-modal");
    if (existing) existing.remove();

    const { t } = EFTForge.lang;
    const alreadyInstalled =
        EFTForge.state.lastParentNode?.children?.[EFTForge.state.lastSlot.id]?.item?.id != null &&
        String(EFTForge.state.lastParentNode.children[EFTForge.state.lastSlot.id].item.id) === String(item.id);

    const { contribution, recoilPercent, ergoModifier } = entry;
    const weight = parseFloat(item.weight ?? 0).toFixed(3);

    const recoilText  = `${recoilPercent  >= 0 ? "+" : ""}${formatStat(recoilPercent)}%`;
    const ergoText    = `${ergoModifier   >= 0 ? "+" : ""}${formatStat(ergoModifier)}`;
    const contribText = `${contribution   >= 0 ? "+" : ""}${contribution.toFixed(1)}`;

    const ergoClass   = ergoModifier   >= 0 ? "ergo-positive" : "ergo-negative";
    const contribClass= contribution   >= 0 ? "positive"      : "negative";

    const overlay = document.createElement("div");
    overlay.id = "mobile-att-modal";
    overlay.className = "modal-overlay";

    overlay.innerHTML = `
        <div class="modal-window" style="max-width:340px;">
            <div class="modal-header">
                <span class="modal-title">${t("modal.installAttachment") || "Install Attachment"}</span>
                <button class="modal-close-btn" id="att-modal-close">&#x2715;</button>
            </div>
            <div class="modal-body">
                <div style="display:flex; align-items:center; gap:12px;">
                    <img src="${escapeHtml(item.icon_link || "")}"
                         style="width:56px;height:56px;object-fit:contain;flex-shrink:0;background:#1a1a1a;border-radius:4px;"
                         onerror="this.style.display='none'" />
                    <span style="font-size:14px;font-weight:700;color:#eee;line-height:1.35;">${escapeHtml(item.name)}</span>
                </div>
                <hr class="modal-divider" />
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 16px;font-size:13px;">
                    <div><div style="color:#777;font-size:11px;letter-spacing:0.5px;margin-bottom:2px;">${t("modal.weight")}</div><span style="font-weight:700;">${weight} kg</span></div>
                    <div><div style="color:#777;font-size:11px;letter-spacing:0.5px;margin-bottom:2px;">${t("modal.recoil")}</div><span style="font-weight:700;">${recoilText}</span></div>
                    <div><div style="color:#777;font-size:11px;letter-spacing:0.5px;margin-bottom:2px;">${t("modal.ergo")}</div><span class="${ergoClass}" style="font-weight:700;">${ergoText}</span></div>
                    <div><div style="color:#777;font-size:11px;letter-spacing:0.5px;margin-bottom:2px;">${t("modal.evoErgo")}</div><span class="${contribClass}" style="font-weight:700;">${contribText}</span></div>
                </div>
                <div style="display:flex;gap:8px;margin-top:4px;">
                    <button class="modal-btn full-width" id="att-modal-cancel">${t("modal.cancel")}</button>
                    ${alreadyInstalled
                        ? `<button class="modal-btn full-width" id="att-modal-action" style="border-color:#f44336;color:#f44336;">${t("modal.remove")}</button>`
                        : `<button class="modal-btn primary full-width" id="att-modal-action">${t("modal.install")}</button>`
                    }
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    document.getElementById("att-modal-close").addEventListener("click", close);
    document.getElementById("att-modal-cancel").addEventListener("click", close);
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

    document.getElementById("att-modal-action").addEventListener("click", () => {
        close();
        if (alreadyInstalled) {
            removeAttachment(EFTForge.state.lastParentNode, EFTForge.state.lastSlot.id, true);
        } else {
            installAttachment(EFTForge.state.lastParentNode, EFTForge.state.lastSlot.id, item);
        }
    });
}

// ---------------------------------------------------
// Rating vote localStorage helpers
// ---------------------------------------------------

function _getLocalVotes() {
    try { return JSON.parse(localStorage.getItem("eftforge_votes") || "{}"); }
    catch { return {}; }
}

function _setLocalVote(itemId, vote) {
    const v = _getLocalVotes();
    if (vote === null || vote === undefined) delete v[itemId];
    else v[itemId] = vote;
    localStorage.setItem("eftforge_votes", JSON.stringify(v));
}

function _refreshRatingCells() {
    document.querySelectorAll(".att-rating[data-item-id]").forEach(div => {
        const id   = div.dataset.itemId;
        const data = EFTForge.state.ratingsCache[id];
        if (!data) return;
        const likeBtn    = div.querySelector(".att-vote-like");
        const dislikeBtn = div.querySelector(".att-vote-dislike");
        if (likeBtn) {
            likeBtn.querySelector(".att-vote-count").textContent = data.likes;
            likeBtn.classList.toggle("active", data.user_vote === "like");
        }
        if (dislikeBtn) {
            dislikeBtn.querySelector(".att-vote-count").textContent = data.dislikes;
            dislikeBtn.classList.toggle("active", data.user_vote === "dislike");
        }
    });
}

async function handleVoteClick(event, itemId, vote) {
    event.stopPropagation();

    const current     = EFTForge.state.ratingsCache[itemId] || { likes: 0, dislikes: 0, user_vote: null };
    const currentVote = current.user_vote ?? null;
    const isSame      = currentVote === vote;

    // Optimistic update
    const optimistic = { likes: current.likes, dislikes: current.dislikes, user_vote: isSame ? null : vote };
    if (isSame) {
        if (vote === "like")    optimistic.likes    = Math.max(0, optimistic.likes    - 1);
        if (vote === "dislike") optimistic.dislikes = Math.max(0, optimistic.dislikes - 1);
    } else {
        if (vote === "like")    { optimistic.likes++;    if (currentVote === "dislike") optimistic.dislikes = Math.max(0, optimistic.dislikes - 1); }
        if (vote === "dislike") { optimistic.dislikes++; if (currentVote === "like")    optimistic.likes    = Math.max(0, optimistic.likes    - 1); }
    }
    EFTForge.state.ratingsCache[itemId] = optimistic;
    _refreshRatingCells();

    try {
        const result = isSame
            ? await EFTForge.api.deleteVote(itemId)
            : await EFTForge.api.postVote(itemId, vote);
        EFTForge.state.ratingsCache[itemId] = {
            likes:     result.likes,
            dislikes:  result.dislikes,
            user_vote: result.user_vote,
        };
        _setLocalVote(itemId, result.user_vote);
    } catch {
        // Revert on failure
        EFTForge.state.ratingsCache[itemId] = current;
    }
    _refreshRatingCells();
}

// Cached references to the stat bar DOM elements (stable while panel is open)
let _statBarEls = null;

function _animateSectionTitle(el) {
    el.classList.remove("section-title-anim");
    void el.offsetWidth; // force reflow so removing+re-adding restarts the animation
    el.classList.add("section-title-anim");
}

function _cacheStatBarEls() {
    const rows = document.querySelectorAll(".stat-bar-row");
    if (rows.length < 3) { _statBarEls = null; return; }
    _statBarEls = {
        ergoFill:     rows[0].querySelector(".stat-bar-fill"),
        ergoVal:      rows[0].querySelector(".stat-bar-track .stat-bar-value"),
        rvFill:       rows[1].querySelector(".stat-bar-fill"),
        rvVal:        rows[1].querySelector(".stat-bar-track .stat-bar-value"),
        rhFill:       rows[2].querySelector(".stat-bar-fill"),
        rhVal:        rows[2].querySelector(".stat-bar-track .stat-bar-value"),
        weightVal:    document.querySelector(".stat-row-weight span:last-child"),
        eedVal:       document.getElementById("eed-value-span"),
        sectionTitle: document.querySelector(".section-title"),
    };
}

function _setExtraStats(weight, eed) {
    if (!_statBarEls) return;
    const { weightVal, eedVal } = _statBarEls;
    if (weightVal) weightVal.textContent = weight.toFixed(3) + " kg";
    if (eedVal) {
        eedVal.className = eed >= 0 ? "positive" : "negative";
        eedVal.textContent = (eed > 0 ? "+" : "") + eed.toFixed(1);
    }
}

// Restores all stat bars and extra stats to the current build's actual values.
// Does NOT touch the section title - callers handle that if needed.
function _restoreStatBarsToCurrent() {
    if (!_statBarEls || !_statBarEls.ergoVal?.isConnected) _cacheStatBarEls();
    if (!_statBarEls) return;
    const { ergoFill, ergoVal, rvFill, rvVal, rhFill, rhVal } = _statBarEls;
    if (ergoFill) ergoFill.style.width = Math.min(EFTForge.state.lastTotalErgo, 100) + "%";
    if (ergoVal)  ergoVal.textContent  = formatStat(EFTForge.state.lastTotalErgo);
    if (rvFill)   rvFill.style.width   = EFTForge.state.lastRecoilV !== null ? Math.min(Math.round(EFTForge.state.lastRecoilV), 500) / 5 + "%" : "0%";
    if (rvVal)    rvVal.textContent    = EFTForge.state.lastRecoilV !== null ? Math.round(EFTForge.state.lastRecoilV) : "-";
    if (rhFill)   rhFill.style.width   = EFTForge.state.lastRecoilH !== null ? Math.min(Math.round(EFTForge.state.lastRecoilH), 500) / 5 + "%" : "0%";
    if (rhVal)    rhVal.textContent    = EFTForge.state.lastRecoilH !== null ? Math.round(EFTForge.state.lastRecoilH) : "-";
    _setExtraStats(EFTForge.state.lastTotalWeight, EFTForge.state.lastEED);
}

// Returns the slot-ID path from root down to targetSlotId, or null if not found.
// e.g. gun → stockSlot → bufferTubeNode → childStockSlot  =>  ["stockSlotId", "childStockSlotId"]
function _findSlotPath(root, targetParentNode, targetSlotId) {
    if (root === targetParentNode) return [targetSlotId];
    for (const slotId in root.children) {
        const sub = _findSlotPath(root.children[slotId], targetParentNode, targetSlotId);
        if (sub) return [slotId, ...sub];
    }
    return null;
}

async function openSlotSelector(parentNode, slot) {

    // If this slot is already open, do nothing
    if (EFTForge.state.lastParentNode === parentNode && EFTForge.state.lastSlot && EFTForge.state.lastSlot.id === slot.id) {
        return;
    }

    // If compare mode is active, only persist it when the new slot shares the same
    // top-level branch as the baseline (e.g. both under the stock tree).
    // Cross-branch navigation (stock → scope) clears compare state entirely.
    if (EFTForge.state.compareMode && EFTForge.state.compareBaselineSlotPath && EFTForge.state.buildTree) {
        const newPath = _findSlotPath(EFTForge.state.buildTree, parentNode, slot.id);
        const bsp = EFTForge.state.compareBaselineSlotPath;
        const crossBranch = !newPath || newPath[0] !== bsp[0];
        // Also clear the baseline (but keep compare mode) when navigating into a child slot
        // of the slot where the baseline was set - combining the baseline item with a child
        // slot item would be nonsensical (they can't both be installed simultaneously).
        const insideBaseline = !crossBranch && newPath.length > bsp.length
            && bsp.every((id, i) => newPath[i] === id);
        if (crossBranch) {
            EFTForge.state.compareMode = false;
            EFTForge.state.compareBaselineId = null;
            EFTForge.state.compareBaselineEntry = null;
            EFTForge.state.compareBaselineSlotPath = null;
        } else if (insideBaseline) {
            EFTForge.state.compareBaselineId = null;
            EFTForge.state.compareBaselineEntry = null;
            EFTForge.state.compareBaselineSlotPath = null;
            _restoreStatBarsToCurrent();
        }
    }

    // Immediately highlight the selected slot
    document.querySelectorAll(".tree-slot.active-slot")
        .forEach(el => el.classList.remove("active-slot"));

    const activeSlotEl = findSlotElement(parentNode, slot.id);
    if (activeSlotEl) activeSlotEl.classList.add("active-slot");

    // Hide placeholder
    document.getElementById("attachment-placeholder").style.display = "none";

    // On mobile, auto-switch to the attachments tab
    switchToMobileTab("attachments");

    EFTForge.state.currentSearchQuery = "";

  const box = document.getElementById("attachment-table-container");

  const { t, tSlot } = EFTForge.lang;

  const gun = EFTForge.state.currentGun;
  const gunImg = gun?.image_512_link || gun?.icon_link || "";

  box.classList.remove("table-slide-in");
  void box.offsetWidth; // force reflow so removing+re-adding the class always retriggers
  box.classList.add("table-slide-in");
  box.addEventListener("animationend", () => box.classList.remove("table-slide-in"), { once: true });

  box.innerHTML = `
        <div class="att-table-header">
            ${gunImg ? `<img class="att-table-gun-img" src="${escapeHtml(gunImg)}" alt="" />` : ""}
            <h3>${t("ui.selectAttFor")}<strong>${escapeHtml(tSlot(slot.slot_name))}</strong></h3>
            <button id="compare-toggle-btn" class="compare-toggle${EFTForge.state.compareMode ? ' active' : ''}" onclick="toggleCompareMode()">
                ${t("ui.compare")}
                <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
            </button>
        </div>

        <div id="compare-hint" class="compare-mode-hint" style="display:none;"></div>

        <input
            type="text"
            id="attachment-search"
            placeholder="${escapeHtml(t("placeholder.attSearch"))}"
            class="search-input"
        />

        <table class="attachment-table">
            <colgroup>
                <col style="width: 52%;" />
                <col style="width: 12%;" />
                <col style="width: 12%;" />
                <col style="width: 12%;" />
                <col style="width: 12%;" />
            </colgroup>

            <thead>
                <tr>
                    <th id="th-name" onclick="changeSort('name')">
                        ${t("th.name")} <span class="sort-indicator"></span>
                    </th>
                    <th id="th-weight" onclick="changeSort('weight')">
                        ${t("th.weight")} <span class="sort-indicator"></span>
                    </th>
                    <th id="th-recoil" onclick="changeSort('recoil')">
                        ${t("th.recoil")} <span class="sort-indicator"></span>
                    </th>
                    <th id="th-ergo" onclick="changeSort('ergo')">
                        ${t("th.ergo")} <span class="sort-indicator"></span>
                    </th>
                    <th id="th-evo" onclick="changeSort('evo')">
                        ${t("th.evoErgo")} <span class="sort-indicator"></span>
                    </th>
                </tr>
            </thead>

            <tbody id="attachment-body"></tbody>
        </table>
    `;

  const slotOverlay = startPanelLoading(document.querySelector(".right-panel"), 1000);

  let items;
  if (EFTForge.state.allowedCache[slot.id]) {
      items = EFTForge.state.allowedCache[slot.id];
  } else {
      try {
          items = await withTimeout(fetchSlotAllowedItems(slot.id));
          cacheSet(EFTForge.state.allowedCache, slot.id, items);
      } catch (err) {
          stopPanelLoading(slotOverlay);
          console.error("Failed to load allowed items:", err);
          showToast(t("toast.connectionError"), t("toast.attachListFailed") + " " + (EFTForge.config.IS_LOCAL_DEV ? t("toast.networkHintDev") : t("toast.networkHintProd")), 5000);
          return;
      }
  }

  // Non-blocking: fetch ratings in the background; update cells when ready
  EFTForge.api.fetchBulkRatings(items.map(i => i.id)).then(ratings => {
      Object.assign(EFTForge.state.ratingsCache, ratings);
      _refreshRatingCells();
  }).catch(() => {});

  const baseAttachmentIds = collectAttachmentIds(EFTForge.state.buildTree);

  // Build the slot-emptied ID list: current build minus the replaced subtree - O(n) with filter
  let slotEmptiedIds;
  if (parentNode.children[slot.id]) {
      const installedNode = parentNode.children[slot.id];
      const idsToRemove = new Set([
          installedNode.item.id,
          ...collectAttachmentIds(installedNode)
      ]);
      slotEmptiedIds = baseAttachmentIds.filter(id => !idsToRemove.has(id));
  } else {
      slotEmptiedIds = baseAttachmentIds;
  }

  // Cache key: slot ID + current build state so cache invalidates when build changes
  const cacheKey = `${slot.id}__${slotEmptiedIds.slice().sort().join(",")}`;

  if (EFTForge.state.processedCache[cacheKey]) {
      EFTForge.state.lastProcessedItems = EFTForge.state.processedCache[cacheKey];
      EFTForge.state.lastParentNode = parentNode;
      EFTForge.state.lastSlot = slot;
      applyAttachmentSort();
      stopPanelLoading(slotOverlay);
      _cacheStatBarEls();
      return;
  }

  // Sum weights of the installed subtree being replaced
  let removedSubtreeWeight = 0;
  if (parentNode.children[slot.id]) {
      const removedNode = parentNode.children[slot.id];
      const collectWeights = (node) => {
          removedSubtreeWeight += node.item.weight ?? 0;
          for (const sid in node.children) collectWeights(node.children[sid]);
      };
      collectWeights(removedNode);
  }

  // Single batch request: baseline + all candidate validation + calculation
  let batchResult;
  try {
      batchResult = await withTimeout(batchProcessCandidates({
          base_item_id: EFTForge.state.currentGun.id,
          installed_ids: slotEmptiedIds,
          slot_id: slot.id,
          candidate_ids: items.map(i => i.id),
          lang: _lang(),
          strength_level: EFTForge.state.currentStrengthLevel ?? 10,
          equip_ergo_modifier: EFTForge.state.currentEquipErgoModifier ?? 0,
      }), 30000);
  } catch (err) {
      stopPanelLoading(slotOverlay);
      console.error("Failed to process attachments:", err);
      showToast(t("toast.connectionError"), t("toast.attachDataFailed") + " " + (EFTForge.config.IS_LOCAL_DEV ? t("toast.networkHintDev") : t("toast.networkHintProd")), 5000);
      return;
  }

  const baseData = batchResult.base;
  const baseEED = parseFloat(baseData.evo_ergo_delta ?? 0);
  const baseRecoilV = baseData.recoil_vertical ?? null;
  const baseRecoilH = baseData.recoil_horizontal ?? null;
  const baseErgo = parseFloat(baseData.total_ergo ?? 0);
  const currentBuildBaseWeight = parseFloat(baseData.total_weight ?? 0) + removedSubtreeWeight;

  // Map candidate results by item_id for O(1) lookup
  const candidateResultMap = new Map(batchResult.candidates.map(r => [r.item_id, r]));

  const processedItems = items.map(item => {
      const r = candidateResultMap.get(item.id);
      if (!r) return null;

      const hasConflict = !r.valid;
      const conflictName = r.reason_key
          ? t(r.reason_key) + (r.reason_name ?? "")
          : null;
      const contribution = parseFloat(r.evo_ergo_delta ?? 0) - baseEED;
      const recoilPercent = parseFloat(item.recoil_modifier ?? 0) * 100;

      return {
          item,
          sortName: item.name.toLowerCase(),
          contribution,
          recoilPercent,
          ergoModifier: parseFloat(item.ergonomics_modifier ?? 0),
          hasConflict,
          conflictName,
          conflictingItemId: r.conflicting_item_id ?? null,
          conflictingSlotId: r.conflicting_slot_id ?? null,
          simErgo: parseFloat(r.total_ergo ?? 0),
          simRecoilV: r.recoil_vertical ?? null,
          simRecoilH: r.recoil_horizontal ?? null,
          simWeight: parseFloat(r.total_weight ?? 0),
          simEED: parseFloat(r.evo_ergo_delta ?? 0),
          baseErgo,
          baseRecoilV,
          baseRecoilH,
          baseWeight: currentBuildBaseWeight,
          baseEED,
      };
  }).filter(Boolean);

  cacheSet(EFTForge.state.processedCache, cacheKey, processedItems);
  EFTForge.state.lastProcessedItems = processedItems;

  const searchInput = document.getElementById("attachment-search");
  if (searchInput) {
      searchInput.addEventListener("input", (e) => {
          applyAttachmentSearch(e.target.value);
      });
  }

  EFTForge.state.lastParentNode = parentNode;
  EFTForge.state.lastSlot = slot;

  applyAttachmentSort();
  stopPanelLoading(slotOverlay);
  _cacheStatBarEls();
}

function applyAttachmentSearch(query) {
    EFTForge.state.currentSearchQuery = query.toLowerCase();
    applyAttachmentSort();
}

function applyAttachmentSort() {
  const dir = EFTForge.state.attachmentSort.direction === "asc" ? 1 : -1;

  const itemsToRender = EFTForge.state.currentSearchQuery
      ? EFTForge.state.lastProcessedItems.filter(entry =>
          entry.sortName.includes(EFTForge.state.currentSearchQuery)
        )
      : EFTForge.state.lastProcessedItems;

  itemsToRender.sort((a, b) => {

    // ---------- PRIMARY SORT ----------
    let primary;

    switch (EFTForge.state.attachmentSort.key) {
        case "name":
            primary = a.sortName < b.sortName ? -1 : a.sortName > b.sortName ? 1 : 0;
            break;

        case "weight":
            primary =
            parseFloat(a.item.weight ?? 0) -
            parseFloat(b.item.weight ?? 0);
            break;

        case "recoil":
            primary = a.recoilPercent - b.recoilPercent;
            break;

        case "evo":
            primary = a.contribution - b.contribution;
            break;

        case "ergo":
            primary = a.ergoModifier - b.ergoModifier;
            break;

        default:
            primary = 0;
    }

    if (primary !== 0) return primary * dir;

    // ---------- SECONDARY SORT ----------
    if (EFTForge.state.attachmentSort.key === "recoil") {
      const evoDiff = b.contribution - a.contribution;
      if (evoDiff !== 0) return evoDiff;
    }

    // ---------- TERTIARY SORT ----------
    return a.sortName < b.sortName ? -1 : a.sortName > b.sortName ? 1 : 0;
  });

  updateSortIndicators();
  renderAttachmentRows(itemsToRender);
}

function changeSort(key) {
  if (EFTForge.state.attachmentSort.key === key) {
    EFTForge.state.attachmentSort.direction =
      EFTForge.state.attachmentSort.direction === "asc"
        ? "desc"
        : "asc";
  } else {
    EFTForge.state.attachmentSort.key = key;

    // Default directions per column
    if (key === "recoil") {
      EFTForge.state.attachmentSort.direction = "asc"; // strongest reduction first
    } else if (key === "evo") {
      EFTForge.state.attachmentSort.direction = "desc"; // highest evo first
    } else {
      EFTForge.state.attachmentSort.direction = "asc";
    }
  }

  applyAttachmentSort();
}

function updateSortIndicators() {
  const headers = ["name", "weight", "recoil", "ergo", "evo"];

  headers.forEach(key => {
    const th = document.getElementById(`th-${key}`);
    if (!th) return;

    const span = th.querySelector(".sort-indicator");
    span.textContent = "";

    th.classList.remove("active-sort");
  });

  const activeTh = document.getElementById(
    `th-${EFTForge.state.attachmentSort.key}`
  );

  if (!activeTh) return;

  activeTh.classList.add("active-sort");

  const span = activeTh.querySelector(".sort-indicator");

  span.textContent =
    EFTForge.state.attachmentSort.direction === "asc" ? " ▲" : " ▼";
}

function toggleCompareMode() {
    EFTForge.state.compareMode = !EFTForge.state.compareMode;
    if (!EFTForge.state.compareMode) {
        EFTForge.state.compareBaselineId = null;
        EFTForge.state.compareBaselineEntry = null;
        EFTForge.state.compareBaselineSlotPath = null;
        _restoreStatBarsToCurrent();
        if (!_statBarEls) _cacheStatBarEls();
        const sectionTitle = _statBarEls?.sectionTitle;
        if (sectionTitle) {
            sectionTitle.textContent = t("stats.title");
            sectionTitle.style.color = "";
            sectionTitle.style.borderLeftColor = "";
            _animateSectionTitle(sectionTitle);
        }
    } else {
        // Entering compare mode - update section title
        if (!_statBarEls || !_statBarEls.sectionTitle?.isConnected) _cacheStatBarEls();
        const sectionTitle = _statBarEls?.sectionTitle;
        if (sectionTitle) {
            sectionTitle.textContent = t("stats.compareMode");
            sectionTitle.style.color = "#00c8b4";
            sectionTitle.style.borderLeftColor = "#00c8b4";
            _animateSectionTitle(sectionTitle);
        }
    }
    const btn = document.getElementById("compare-toggle-btn");
    if (btn) btn.classList.toggle("active", EFTForge.state.compareMode);
    applyAttachmentSort();
}

// Helper: animate a delta bar in using double-rAF to avoid forced reflow
function _animateDeltaBarIn(deltaEl) {
    if (deltaEl._showRaf != null) { cancelAnimationFrame(deltaEl._showRaf); deltaEl._showRaf = null; }
    deltaEl.style.transform = "scaleX(0)";
    deltaEl.style.opacity = "0";
    deltaEl._showRaf = requestAnimationFrame(() => {
        deltaEl._showRaf = requestAnimationFrame(() => {
            deltaEl._showRaf = null;
            deltaEl.style.transform = "scaleX(1)";
            deltaEl.style.opacity = "1";
        });
    });
}

function _animateDeltaBarOut(deltaEl) {
    if (deltaEl._showRaf != null) { cancelAnimationFrame(deltaEl._showRaf); deltaEl._showRaf = null; }
    deltaEl.style.transform = "scaleX(0)";
    deltaEl.style.opacity = "0";
}

function renderAttachmentRows(items) {

  _clearMarqueeTimers();
  _statBarEls = null; // will be re-cached after append

  const tbody = document.getElementById("attachment-body");
  tbody.innerHTML = "";

  const installedId =
      EFTForge.state.lastParentNode?.children?.[EFTForge.state.lastSlot.id]?.item?.id;

  const { t } = EFTForge.lang;

  // Update compare mode hint bar
  const hintEl = document.getElementById("compare-hint");
  if (hintEl) {
      if (EFTForge.state.compareMode) {
          hintEl.textContent = EFTForge.state.compareBaselineId
              ? t("ui.compareHintBaseline")
              : t("ui.compareHintSelect");
          hintEl.style.display = "";
      } else {
          hintEl.style.display = "none";
      }
  }

  // Resolve baseline entry - check current slot first, fall back to stored cross-slot entry
  let baselineEntry = EFTForge.state.compareMode && EFTForge.state.compareBaselineId
      ? EFTForge.state.lastProcessedItems.find(
            e => String(e.item.id) === EFTForge.state.compareBaselineId
        )
      : null;

  const isCrossSlotBaseline = !baselineEntry && EFTForge.state.compareMode && !!EFTForge.state.compareBaselineEntry;
  if (isCrossSlotBaseline) baselineEntry = EFTForge.state.compareBaselineEntry;

  // For cross-slot baseline, compute combined stats (baseline item + its parent contributions)
  // using sim* values (total build) minus the current slot's base* (build without any slot item)
  let ghostStats = null;
  if (isCrossSlotBaseline && EFTForge.state.lastProcessedItems.length > 0) {
      const pb = EFTForge.state.lastProcessedItems[0];
      const bl = baselineEntry;
      ghostStats = {
          weight:    bl.simWeight - pb.baseWeight,
          ergo:      bl.simErgo   - pb.baseErgo,
          contrib:   bl.simEED    - pb.baseEED,
          recoilPct: (pb.baseRecoilV && bl.simRecoilV !== null)
              ? (bl.simRecoilV / pb.baseRecoilV - 1) * 100
              : bl.recoilPercent,
      };
  }

  // Build all rows into a DocumentFragment - single reflow on append
  const fragment = document.createDocumentFragment();

  // Ghost row: baseline from a different slot pinned at the top of this table
  if (isCrossSlotBaseline) {
      const bl = EFTForge.state.compareBaselineEntry;
      const blItem = bl.item;

      // Find the parent item installed in the current slot (the item that carries the baseline child)
      const parentEntry = installedId != null
          ? EFTForge.state.lastProcessedItems.find(e => String(e.item.id) === String(installedId))
          : null;
      const parentItem = parentEntry?.item ?? null;

      const ghostRow = document.createElement("tr");
      ghostRow.classList.add("compare-baseline-row");

      // Build the icon area: if there is a parent item, show [parent icon] + [child icon] side by side
      const iconAreaHtml = parentItem
          ? `<div class="attachment-icon-wrapper ghost-combo-icon">
                 <img src="${escapeHtml(parentItem.icon_link)}" class="attachment-icon" loading="lazy" decoding="async" onerror="this.style.display='none'" />
                 <div class="slot-shortname">${escapeHtml(parentItem.short_name)}</div>
             </div>
             <div class="ghost-combo-plus">+</div>
             <div class="attachment-icon-wrapper ghost-combo-icon">
                 <img src="${escapeHtml(blItem.icon_link)}" class="attachment-icon" loading="lazy" decoding="async" onerror="this.style.display='none'" />
                 <div class="slot-shortname">${escapeHtml(blItem.short_name)}</div>
             </div>`
          : `<div class="attachment-icon-wrapper">
                 <img src="${escapeHtml(blItem.icon_link)}" class="attachment-icon" loading="lazy" decoding="async" onerror="this.style.display='none'" />
                 <div class="slot-shortname">${escapeHtml(blItem.short_name)}</div>
             </div>`;

      // Build the name line: "Parent name + Child name" or just child name
      const nameHtml = parentItem
          ? `${escapeHtml(parentItem.short_name)} + ${escapeHtml(blItem.name)}`
          : escapeHtml(blItem.name);

      ghostRow.innerHTML = `
          <td class="name-cell">
              <div class="attachment-name-wrapper">
                  ${iconAreaHtml}
                  <div style="min-width:0;flex:1;">
                      <div class="attachment-name-text"><span class="marquee-text">${nameHtml}</span></div>
                      <div class="cmp-baseline-tag">◈ ${t("ui.compareBaseline")}</div>
                  </div>
              </div>
          </td>
          <td>${ghostStats ? ghostStats.weight.toFixed(3) : parseFloat(blItem.weight ?? 0).toFixed(3)}</td>
          <td>${ghostStats ? formatStat(ghostStats.recoilPct) : formatStat(bl.recoilPercent)}%</td>
          <td class="${(ghostStats ? ghostStats.ergo : bl.ergoModifier) >= 0 ? "ergo-positive" : "ergo-negative"}">${(ghostStats ? ghostStats.ergo : bl.ergoModifier) >= 0 ? "+" : ""}${formatStat(ghostStats ? ghostStats.ergo : bl.ergoModifier)}</td>
          <td class="${(ghostStats ? ghostStats.contrib : bl.contribution) >= 0 ? "positive" : "negative"}">${(ghostStats ? ghostStats.contrib : bl.contribution) >= 0 ? "+" : ""}${(ghostStats ? ghostStats.contrib : bl.contribution).toFixed(1)}</td>
      `;

      ghostRow.addEventListener("mouseenter", () => {
          if (!_statBarEls || !_statBarEls.ergoFill?.isConnected) _cacheStatBarEls();
          if (!_statBarEls) return;
          const { ergoFill, ergoVal, rvFill, rvVal, rhFill, rhVal } = _statBarEls;
          [ergoFill, rvFill, rhFill].forEach(fill => {
              if (!fill) return;
              const deltaEl = fill.parentElement.querySelector(".delta-bar");
              if (deltaEl) _animateDeltaBarOut(deltaEl);
          });
          if (ergoFill) ergoFill.style.width = Math.min(bl.simErgo, 100) + "%";
          if (ergoVal)  ergoVal.textContent = formatStat(bl.simErgo);
          if (bl.simRecoilV !== null) {
              if (rvFill) rvFill.style.width = Math.min(bl.simRecoilV, 500) / 5 + "%";
              if (rvVal)  rvVal.textContent = Math.round(bl.simRecoilV);
          }
          if (bl.simRecoilH !== null) {
              if (rhFill) rhFill.style.width = Math.min(bl.simRecoilH, 500) / 5 + "%";
              if (rhVal)  rhVal.textContent = Math.round(bl.simRecoilH);
          }
      });

      ghostRow.addEventListener("mouseleave", () => {
          if (!_statBarEls) return;
          const { ergoFill, ergoVal, rvFill, rvVal, rhFill, rhVal } = _statBarEls;
          [ergoFill, rvFill, rhFill].forEach(fill => {
              if (!fill) return;
              const deltaEl = fill.parentElement.querySelector(".delta-bar");
              if (deltaEl) _animateDeltaBarOut(deltaEl);
          });
          if (ergoVal) ergoVal.textContent = formatStat(bl.simErgo);
          if (rvVal)   rvVal.textContent   = bl.simRecoilV !== null ? Math.round(bl.simRecoilV) : "-";
          if (rhVal)   rhVal.textContent   = bl.simRecoilH !== null ? Math.round(bl.simRecoilH) : "-";
      });

      fragment.appendChild(ghostRow);
  }

  for (const entry of items) {

    const { item, contribution, recoilPercent, ergoModifier } = entry;

    const row = document.createElement("tr");

    if (entry.hasConflict) {
        row.classList.add("conflict-row");
    }

    if (installedId && String(installedId) === String(item.id)) {
        row.classList.add("attachment-row-installed");
    }

    const isBaselineRow = EFTForge.state.compareMode && !!EFTForge.state.compareBaselineId &&
        String(item.id) === EFTForge.state.compareBaselineId;

    if (isBaselineRow) {
        row.classList.add("compare-baseline-row");
    }

    // Build stat cells - add delta badges when comparing against a baseline
    const showDeltas = EFTForge.state.compareMode && !!baselineEntry && !isBaselineRow;

    let weightCell, recoilCell, ergoCell, evoCell;

    if (showDeltas) {
        let wD, rD, eD, evD;
        if (isCrossSlotBaseline && ghostStats) {
            // Sim-based deltas: fair comparison accounting for parent contributions
            wD  = entry.simWeight - baselineEntry.simWeight;
            rD  = entry.recoilPercent - ghostStats.recoilPct;
            eD  = entry.simErgo   - baselineEntry.simErgo;
            evD = entry.simEED    - baselineEntry.simEED;
        } else {
            wD  = parseFloat(item.weight ?? 0) - parseFloat(baselineEntry.item.weight ?? 0);
            rD  = entry.recoilPercent - baselineEntry.recoilPercent;
            eD  = entry.ergoModifier  - baselineEntry.ergoModifier;
            evD = entry.contribution  - baselineEntry.contribution;
        }

        const fmtD = (v, d) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;

        weightCell = `<td>${parseFloat(item.weight ?? 0).toFixed(3)}${wD !== 0
            ? `<div class="cmp-delta ${wD < 0 ? "positive" : "negative"}">${fmtD(wD, 3)}</div>` : ""}</td>`;

        recoilCell = `<td>${formatStat(recoilPercent)}%${rD !== 0
            ? `<div class="cmp-delta ${rD < 0 ? "positive" : "negative"}">${fmtD(rD, 1)}%</div>` : ""}</td>`;

        ergoCell = `<td class="${ergoModifier >= 0 ? "ergo-positive" : "ergo-negative"}">${ergoModifier >= 0 ? "+" : ""}${formatStat(ergoModifier)}${eD !== 0
            ? `<div class="cmp-delta ${eD > 0 ? "positive" : "negative"}">${fmtD(eD, 1)}</div>` : ""}</td>`;

        evoCell = `<td class="${contribution >= 0 ? "positive" : "negative"}">${contribution >= 0 ? "+" : ""}${contribution.toFixed(1)}${evD !== 0
            ? `<div class="cmp-delta ${evD > 0 ? "positive" : "negative"}">${fmtD(evD, 1)}</div>` : ""}</td>`;
    } else {
        weightCell = `<td>${parseFloat(item.weight ?? 0).toFixed(3)}</td>`;
        recoilCell = `<td>${formatStat(recoilPercent)}%</td>`;
        ergoCell   = `<td class="${ergoModifier >= 0 ? "ergo-positive" : "ergo-negative"}">${ergoModifier >= 0 ? "+" : ""}${formatStat(ergoModifier)}</td>`;
        evoCell    = `<td class="${contribution >= 0 ? "positive" : "negative"}">${contribution >= 0 ? "+" : ""}${contribution.toFixed(1)}</td>`;
    }

    row.innerHTML = `
        <td class="name-cell">
            <div class="attachment-name-wrapper">

                <div class="attachment-icon-wrapper">
                    <img
                        src="${escapeHtml(item.icon_link)}"
                        class="attachment-icon"
                        loading="lazy"
                        decoding="async"
                        onerror="this.style.display='none'"
                    />

                    <div class="slot-shortname">
                        ${escapeHtml(item.short_name)}
                    </div>
                </div>

                <div class="att-name-and-rating">
                    <div class="attachment-name-text"><span class="marquee-text">${escapeHtml(item.name)}</span></div>
                    ${(() => {
                        const rd  = EFTForge.state.ratingsCache[item.id] || {};
                        const lv  = _getLocalVotes();
                        const uv  = rd.user_vote ?? lv[item.id] ?? null;
                        const lks = rd.likes    ?? 0;
                        const dls = rd.dislikes ?? 0;
                        const sid = escapeHtml(item.id);
                        return `<div class="att-rating" data-item-id="${sid}">
                            <button class="att-vote-btn att-vote-like${uv === 'like' ? ' active' : ''}" data-tooltip="${escapeHtml(t('rating.like'))}" onclick="handleVoteClick(event,'${sid}','like')"><img src="./assets/images/icon-fir.png" class="att-vote-icon" /><span class="att-vote-count">${lks}</span></button>
                            <button class="att-vote-btn att-vote-dislike${uv === 'dislike' ? ' active' : ''}" data-tooltip="${escapeHtml(t('rating.dislike'))}" onclick="handleVoteClick(event,'${sid}','dislike')"><img src="./assets/images/Battlestate Games.svg" class="att-vote-icon" /><span class="att-vote-count">${dls}</span></button>
                        </div>`;
                    })()}
                </div>

            </div>
        </td>

        ${weightCell}
        ${recoilCell}
        ${ergoCell}
        ${evoCell}
    `;

    row.addEventListener("mouseenter", () => {
        if (entry.hasConflict) return;
        // Re-cache if the stats panel was rebuilt (e.g. after an install)
        if (!_statBarEls || !_statBarEls.ergoFill?.isConnected) _cacheStatBarEls();
        if (!_statBarEls) return;

        // In compare mode with a baseline: use baseline stats as reference
        // Otherwise: use the current build's stats
        let refErgo, refRecoilV, refRecoilH, refWeight, refEED;
        if (EFTForge.state.compareMode && EFTForge.state.compareBaselineId) {
            const bl = EFTForge.state.lastProcessedItems.find(
                e => String(e.item.id) === EFTForge.state.compareBaselineId
            ) || EFTForge.state.compareBaselineEntry;
            if (bl) {
                refErgo    = bl.simErgo;
                refRecoilV = bl.simRecoilV;
                refRecoilH = bl.simRecoilH;
                refWeight  = bl.simWeight;
                refEED     = bl.simEED;
            } else {
                refErgo    = EFTForge.state.lastTotalErgo;
                refRecoilV = EFTForge.state.lastRecoilV;
                refRecoilH = EFTForge.state.lastRecoilH;
                refWeight  = EFTForge.state.lastTotalWeight;
                refEED     = EFTForge.state.lastEED;
            }
        } else {
            refErgo    = EFTForge.state.lastTotalErgo;
            refRecoilV = EFTForge.state.lastRecoilV;
            refRecoilH = EFTForge.state.lastRecoilH;
            refWeight  = EFTForge.state.lastTotalWeight;
            refEED     = EFTForge.state.lastEED;
        }

        const { ergoFill, ergoVal, rvFill, rvVal, rhFill, rhVal } = _statBarEls;

        // Ergo bar
        const ergoDelta    = entry.simErgo - refErgo;
        const ergoBaseWidth = Math.min(refErgo, 100);
        const ergoSimWidth  = Math.min(refErgo + ergoDelta, 100);

        if (ergoFill) {
            ergoFill.style.width = ergoBaseWidth + "%";
            let deltaEl = ergoFill.parentElement.querySelector(".delta-bar");
            if (!deltaEl) {
                deltaEl = document.createElement("div");
                deltaEl.className = "delta-bar";
                ergoFill.parentElement.appendChild(deltaEl);
            }
            if (ergoDelta !== 0) {
                deltaEl.style.left = Math.min(ergoBaseWidth, ergoSimWidth) + "%";
                deltaEl.style.width = Math.abs(ergoSimWidth - ergoBaseWidth) + "%";
                deltaEl.style.background = ergoDelta >= 0 ? "#4CAF50" : "#f44336";
                deltaEl.style.borderRadius = ergoDelta >= 0 ? "0 3px 3px 0" : "3px";
                deltaEl.style.transformOrigin = ergoDelta >= 0 ? "left" : "right";
                deltaEl.style.display = "";
                _animateDeltaBarIn(deltaEl);
            } else {
                _animateDeltaBarOut(deltaEl);
            }
        }
        if (ergoVal) {
            const deltaText = ergoDelta !== 0
                ? ` <span style="color:${ergoDelta >= 0 ? "#4CAF50" : "#f44336"}">(${ergoDelta > 0 ? "+" : ""}${formatStat(ergoDelta)})</span>`
                : "";
            ergoVal.innerHTML = `<span style="color:#eee">${formatStat(refErgo)}</span>${deltaText}`;
        }

        // Ver. Recoil bar
        if (entry.simRecoilV !== null && refRecoilV !== null && rvFill) {
            const rvBase  = Math.min(refRecoilV, 500) / 5;
            const rvDelta = entry.simRecoilV - refRecoilV;
            const rvSim   = Math.min(Math.max(refRecoilV + rvDelta, 0), 500) / 5;
            rvFill.style.width = rvBase + "%";
            let deltaEl = rvFill.parentElement.querySelector(".delta-bar");
            if (!deltaEl) {
                deltaEl = document.createElement("div");
                deltaEl.className = "delta-bar";
                rvFill.parentElement.appendChild(deltaEl);
            }
            if (rvDelta !== 0) {
                deltaEl.style.left = Math.min(rvBase, rvSim) + "%";
                deltaEl.style.width = Math.abs(rvSim - rvBase) + "%";
                deltaEl.style.background = rvDelta <= 0 ? "#4CAF50" : "#f44336";
                deltaEl.style.borderRadius = rvDelta > 0 ? "0 3px 3px 0" : "3px";
                deltaEl.style.transformOrigin = rvDelta > 0 ? "left" : "right";
                deltaEl.style.display = "";
                _animateDeltaBarIn(deltaEl);
            } else {
                _animateDeltaBarOut(deltaEl);
            }
            if (rvVal) {
                const deltaText = rvDelta !== 0
                    ? ` <span style="color:${rvDelta <= 0 ? "#4CAF50" : "#f44336"}">(${rvDelta > 0 ? "+" : ""}${Math.round(rvDelta)})</span>`
                    : "";
                rvVal.innerHTML = `<span style="color:#eee">${Math.round(refRecoilV)}</span>${deltaText}`;
            }
        }

        // Hor. Recoil bar
        if (entry.simRecoilH !== null && refRecoilH !== null && rhFill) {
            const rhBase  = Math.min(refRecoilH, 500) / 5;
            const rhDelta = entry.simRecoilH - refRecoilH;
            const rhSim   = Math.min(Math.max(refRecoilH + rhDelta, 0), 500) / 5;
            rhFill.style.width = rhBase + "%";
            let deltaEl = rhFill.parentElement.querySelector(".delta-bar");
            if (!deltaEl) {
                deltaEl = document.createElement("div");
                deltaEl.className = "delta-bar";
                rhFill.parentElement.appendChild(deltaEl);
            }
            if (rhDelta !== 0) {
                deltaEl.style.left = Math.min(rhBase, rhSim) + "%";
                deltaEl.style.width = Math.abs(rhSim - rhBase) + "%";
                deltaEl.style.background = rhDelta <= 0 ? "#4CAF50" : "#f44336";
                deltaEl.style.borderRadius = rhDelta > 0 ? "0 3px 3px 0" : "3px";
                deltaEl.style.transformOrigin = rhDelta > 0 ? "left" : "right";
                deltaEl.style.display = "";
                _animateDeltaBarIn(deltaEl);
            } else {
                _animateDeltaBarOut(deltaEl);
            }
            if (rhVal) {
                const deltaText = rhDelta !== 0
                    ? ` <span style="color:${rhDelta <= 0 ? "#4CAF50" : "#f44336"}">(${rhDelta > 0 ? "+" : ""}${Math.round(rhDelta)})</span>`
                    : "";
                rhVal.innerHTML = `<span style="color:#eee">${Math.round(refRecoilH)}</span>${deltaText}`;
            }
        }

        // Weight and EED deltas must be computed against a "no-ammo" reference so the
        // ammo weight (present in lastTotalWeight/lastEED but absent from batch simWeight/simEED)
        // cancels out. In compare mode the baseline is already no-ammo so use it directly.
        // In normal mode, find the currently installed item's batch simWeight/simEED (also no-ammo).
        //
        // For magazines with different capacities the ammo does NOT cancel: hovering a
        // 50-round drum vs an installed 10-round mag means 40 extra rounds of ammo when
        // assumeFullMag is on. We correct for this with the capacity delta * ammo weight.
        const { weightVal, eedVal } = _statBarEls;
        let refWeightForDelta, refEEDForDelta;
        let installedMagCap = null;
        if (EFTForge.state.compareMode && EFTForge.state.compareBaselineId) {
            refWeightForDelta = refWeight;
            refEEDForDelta    = refEED;
        } else {
            const installedItemId = String(
                EFTForge.state.lastParentNode?.children?.[EFTForge.state.lastSlot?.id]?.item?.id ?? ""
            );
            const installedEntry = installedItemId
                ? EFTForge.state.lastProcessedItems?.find(e => String(e.item.id) === installedItemId)
                : null;
            refWeightForDelta = installedEntry?.simWeight ?? entry.baseWeight;
            refEEDForDelta    = installedEntry?.simEED    ?? entry.baseEED;
            installedMagCap   = installedEntry?.item?.magazine_capacity ?? null;
        }

        // Ammo capacity correction: only when assumeFullMag is on, both items are mags, and ammo is selected
        let magCapWeightCorrection = 0;
        let magCapEEDCorrection    = 0;
        const candidateMagCap = entry.item?.magazine_capacity ?? null;
        if (EFTForge.state.assumeFullMag && candidateMagCap != null && installedMagCap != null) {
            const ammoSelect = document.getElementById("ammo-select");
            const ammoWeightPerRound = EFTForge.state.ammoWeightMap?.[ammoSelect?.value] ?? 0;
            const capDiff = candidateMagCap - installedMagCap;
            magCapWeightCorrection = ammoWeightPerRound * capDiff;
            // EED = -15 * (weight - KG), so adding ammo weight reduces EED by 15 * weight
            magCapEEDCorrection    = -15 * ammoWeightPerRound * capDiff;
        }

        if (weightVal) {
            const weightDelta = (entry.simWeight - refWeightForDelta) + magCapWeightCorrection;
            const deltaText = weightDelta !== 0
                ? ` <span style="color:${weightDelta <= 0 ? "#4CAF50" : "#f44336"}">(${weightDelta > 0 ? "+" : ""}${weightDelta.toFixed(3)} kg)</span>`
                : "";
            weightVal.innerHTML = `<span style="color:#eee">${refWeight.toFixed(3)} kg</span>${deltaText}`;
        }
        if (eedVal) {
            const eedDelta = (entry.simEED - refEEDForDelta) + magCapEEDCorrection;
            const deltaText = eedDelta !== 0
                ? ` <span style="color:${eedDelta >= 0 ? "#4CAF50" : "#f44336"}">(${eedDelta > 0 ? "+" : ""}${eedDelta.toFixed(1)})</span>`
                : "";
            eedVal.className = refEED >= 0 ? "positive" : "negative";
            eedVal.innerHTML = `${refEED > 0 ? "+" : ""}${refEED.toFixed(1)}${deltaText}`;
        }
    });

    row.addEventListener("mouseleave", () => {
        if (!_statBarEls) return;

        const { ergoFill, ergoVal, rvFill, rvVal, rhFill, rhVal } = _statBarEls;

        // Animate delta bars out
        [ergoFill, rvFill, rhFill].forEach(fill => {
            if (!fill) return;
            const deltaEl = fill.parentElement.querySelector(".delta-bar");
            if (deltaEl) _animateDeltaBarOut(deltaEl);
        });

        // In compare mode with a baseline: restore to baseline stats; otherwise current build
        let displayErgo, displayRv, displayRh;
        if (EFTForge.state.compareMode && EFTForge.state.compareBaselineId) {
            const bl = EFTForge.state.lastProcessedItems.find(
                e => String(e.item.id) === EFTForge.state.compareBaselineId
            ) || EFTForge.state.compareBaselineEntry;
            if (bl) {
                displayErgo = bl.simErgo;
                displayRv   = bl.simRecoilV;
                displayRh   = bl.simRecoilH;
            } else {
                displayErgo = EFTForge.state.lastTotalErgo;
                displayRv   = EFTForge.state.lastRecoilV;
                displayRh   = EFTForge.state.lastRecoilH;
            }
        } else {
            displayErgo = EFTForge.state.lastTotalErgo;
            displayRv   = EFTForge.state.lastRecoilV;
            displayRh   = EFTForge.state.lastRecoilH;
        }

        if (ergoFill) ergoFill.style.width = Math.min(displayErgo, 100) + "%";
        if (ergoVal)  ergoVal.textContent  = formatStat(displayErgo);
        if (rvFill)   rvFill.style.width   = displayRv !== null ? Math.min(Math.round(displayRv), 500) / 5 + "%" : "0%";
        if (rvVal)    rvVal.textContent    = displayRv !== null ? Math.round(displayRv) : "-";
        if (rhFill)   rhFill.style.width   = displayRh !== null ? Math.min(Math.round(displayRh), 500) / 5 + "%" : "0%";
        if (rhVal)    rhVal.textContent    = displayRh !== null ? Math.round(displayRh) : "-";

        // Restore weight and EED to baseline stats (if set) or current build
        if (EFTForge.state.compareMode && EFTForge.state.compareBaselineId) {
            const bl = EFTForge.state.lastProcessedItems.find(
                e => String(e.item.id) === EFTForge.state.compareBaselineId
            ) || EFTForge.state.compareBaselineEntry;
            _setExtraStats(
                bl ? bl.simWeight : EFTForge.state.lastTotalWeight,
                bl ? bl.simEED    : EFTForge.state.lastEED
            );
        } else {
            _setExtraStats(EFTForge.state.lastTotalWeight, EFTForge.state.lastEED);
        }
    });

    // Long-press to remove (touch devices - mirrors right-click behaviour)
    let _longPressTimer = null;
    let _longPressFired = false;

    row.addEventListener("touchstart", () => {
        _longPressFired = false;
        _longPressTimer = setTimeout(() => {
            _longPressFired = true;
            _longPressTimer = null;
            if (EFTForge.state.publishMode) return;
            const installedId = EFTForge.state.lastParentNode?.children?.[EFTForge.state.lastSlot.id]?.item?.id;
            if (installedId && String(installedId) === String(item.id)) {
                removeAttachment(EFTForge.state.lastParentNode, EFTForge.state.lastSlot.id, true);
            }
        }, 600);
    }, { passive: true });

    ["touchend", "touchmove", "touchcancel"].forEach(evt => {
        row.addEventListener(evt, () => {
            if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
        }, { passive: true });
    });

    row.addEventListener("click", () => {
        // Suppress click fired after a long-press
        if (_longPressFired) { _longPressFired = false; return; }

        // In compare mode: set clicked row as baseline instead of installing
        if (EFTForge.state.compareMode) {
            if (entry.hasConflict) return;
            EFTForge.state.compareBaselineId = String(item.id);
            EFTForge.state.compareBaselineEntry = entry;
            EFTForge.state.compareBaselineSlotPath = EFTForge.state.buildTree
                ? _findSlotPath(EFTForge.state.buildTree, EFTForge.state.lastParentNode, EFTForge.state.lastSlot.id)
                : null;
            applyAttachmentSort();
            // Update weight and EED immediately to reflect the new baseline
            if (!_statBarEls || !_statBarEls.weightVal?.isConnected) _cacheStatBarEls();
            _setExtraStats(entry.simWeight, entry.simEED);
            return;
        }

        if (entry.hasConflict) {
            showToast(
                t("toast.attachmentConflict"),
                `${item.name}\n${entry.conflictName}`
            );

            if (entry.conflictingItemId) {
                flashConflictInTree(EFTForge.state.buildTree, entry.conflictingItemId);
            }
            if (entry.conflictingSlotId) {
                flashConflictSlotInTree(entry.conflictingSlotId);
            }

            return;
        }

        // On mobile/landscape phone: show confirmation modal with stats before installing/removing
        if (isMobileLayout()) {
            showMobileAttachmentModal(item, entry);
            return;
        }

        const alreadyInstalled = EFTForge.state.lastParentNode?.children?.[EFTForge.state.lastSlot.id]?.item?.id === item.id;
        if (alreadyInstalled) return;

        installAttachment(EFTForge.state.lastParentNode, EFTForge.state.lastSlot.id, item);
    });

    row.addEventListener("contextmenu", (e) => {
        e.preventDefault();

        const installedId = EFTForge.state.lastParentNode?.children?.[EFTForge.state.lastSlot.id]?.item?.id;
        if (installedId && String(installedId) === String(item.id)) {
            removeAttachment(EFTForge.state.lastParentNode, EFTForge.state.lastSlot.id, true);
        }
    });

    fragment.appendChild(row);
  }

  tbody.appendChild(fragment);
  _initMarqueeText(tbody, { hoverOnly: true });
  _cacheStatBarEls();
}
