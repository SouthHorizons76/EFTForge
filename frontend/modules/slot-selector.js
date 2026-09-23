window.EFTForge = window.EFTForge || {};

/* exported handleVoteClick, openSlotSelector, changeSort, updateComboBalance, togglePurchasableOnly,
   toggleCompareMode, setComboView -- called from other modules or index.html attributes */

// ---------------------------------------------------
// Price helpers for the attachment table
// ---------------------------------------------------

function _getPriceRub(item) {
    const hasTrader = item.trader_vendor && item.trader_price_rub != null;
    const traderAvail = hasTrader &&
        (EFTForge.state.traderLevels[item.trader_vendor] ?? 4) >= (item.trader_min_level ?? 1);
    const fleaCache = EFTForge.state.priceMode === "pve" ? EFTForge.state.fleaCachePve
        : EFTForge.state.priceMode === "pvpSeason" ? EFTForge.state.fleaCacheSeasonal
        : EFTForge.state.fleaCachePvp;
    const fleaPrice = fleaCache?.[item.id] ?? null;
    if (traderAvail && (fleaPrice === null || item.trader_price_rub <= fleaPrice)) return item.trader_price_rub;
    return fleaPrice;
}

function _attPriceCellContent(item) {
    const hasTrader = item.trader_vendor && item.trader_price_rub != null;
    const traderAvail = hasTrader &&
        (EFTForge.state.traderLevels[item.trader_vendor] ?? 4) >= (item.trader_min_level ?? 1);
    const fleaCache = EFTForge.state.priceMode === "pve" ? EFTForge.state.fleaCachePve
        : EFTForge.state.priceMode === "pvpSeason" ? EFTForge.state.fleaCacheSeasonal
        : EFTForge.state.fleaCachePvp;
    const fleaPrice = fleaCache?.[item.id] ?? null;

    let bestPrice, vendorHtml;
    if (traderAvail && (fleaPrice === null || item.trader_price_rub <= fleaPrice)) {
        bestPrice = item.trader_price_rub;
        const trader = EFTForge.state.tradersByNorm?.[item.trader_vendor];
        const imgSrc = trader?.imageLink || "";
        vendorHtml = imgSrc
            ? `<img class="att-price-portrait" src="${escapeHtml(imgSrc)}" onerror="this.style.display='none'" />`
            : `<span class="att-price-vendor">${escapeHtml(item.trader_vendor)}</span>`;
    } else if (fleaPrice !== null) {
        bestPrice = fleaPrice;
        const { t } = EFTForge.lang;
        vendorHtml = `<span class="att-price-flea">${escapeHtml(t("stats.fleaLabel"))}</span>`;
    } else {
        return `-`;
    }
    return `<div class="att-price-wrap">${vendorHtml}<span>${_formatPrice(bestPrice)}</span></div>`;
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

// ---------------------------------------------------
// Attachment favorites
// ---------------------------------------------------

let _favorites = null;
let _favoritesFilter = false;

function _getFavorites() {
    if (!_favorites) {
        try { _favorites = new Set(JSON.parse(localStorage.getItem("eftforge_favorites") || "[]")); }
        catch { _favorites = new Set(); }
    }
    return _favorites;
}

function _saveFavorites() {
    try { localStorage.setItem("eftforge_favorites", JSON.stringify([..._getFavorites()])); } catch {}
}

function toggleFavoritesFilter() {
    _favoritesFilter = !_favoritesFilter;
    const btn = document.getElementById("favorites-filter-btn");
    if (btn) btn.classList.toggle("active", _favoritesFilter);
    applyAttachmentSort();
}
window.toggleFavoritesFilter = toggleFavoritesFilter;

function handleFavClick(event, itemId) {
    event.stopPropagation();
    const favs = _getFavorites();
    if (favs.has(itemId)) favs.delete(itemId);
    else favs.add(itemId);
    _saveFavorites();
    document.querySelectorAll(`.att-fav-btn[data-item-id="${CSS.escape(itemId)}"]`).forEach(btn => {
        btn.classList.toggle("active", favs.has(itemId));
    });
    applyAttachmentSort();
}
window.handleFavClick = handleFavClick;

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
        accFill:      rows[3]?.querySelector(".stat-bar-fill"),
        accVal:       rows[3]?.querySelector(".stat-bar-track .stat-bar-value"),
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
    const { ergoFill, ergoVal, rvFill, rvVal, rhFill, rhVal, accFill, accVal } = _statBarEls;
    if (ergoFill) ergoFill.style.width = Math.min(EFTForge.state.lastTotalErgo, 100) + "%";
    if (ergoVal)  ergoVal.textContent  = formatStat(EFTForge.state.lastTotalErgo);
    if (rvFill)   rvFill.style.width   = EFTForge.state.lastRecoilV !== null ? Math.min(Math.round(EFTForge.state.lastRecoilV), 500) / 5 + "%" : "0%";
    if (rvVal)    rvVal.textContent    = EFTForge.state.lastRecoilV !== null ? Math.round(EFTForge.state.lastRecoilV) : "-";
    if (rhFill)   rhFill.style.width   = EFTForge.state.lastRecoilH !== null ? Math.min(Math.round(EFTForge.state.lastRecoilH), 500) / 5 + "%" : "0%";
    if (rhVal)    rhVal.textContent    = EFTForge.state.lastRecoilH !== null ? Math.round(EFTForge.state.lastRecoilH) : "-";
    const moa = EFTForge.state.lastAccuracyMoa ?? null;
    if (accFill)  accFill.style.width  = moa !== null ? Math.min(moa / 10, 1) * 100 + "%" : "0%";
    if (accVal)   accVal.textContent   = moa !== null ? moa.toFixed(2) + " MOA" : "-";
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

let _slotLoadSeq = 0;

function _buildHeaderImgHtml(parentNode, slot, gunImg) {
    if (EFTForge.state.gridView) {
        const installedItem = parentNode?.children?.[slot.id]?.item;
        if (installedItem?.icon_link) {
            return `<div class="att-table-icon-preview"><img class="att-table-gun-img" src="${escapeHtml(installedItem.icon_link)}" alt="" /><div class="slot-shortname">${escapeHtml(installedItem.short_name)}</div></div>`;
        }
        const placeholderFile = window._SLOT_PLACEHOLDER_MAP?.[slot.slot_name];
        if (placeholderFile) {
            return `<img class="att-table-gun-img att-table-slot-placeholder" src="./assets/images/slot_placeholders/${escapeHtml(placeholderFile)}" alt="" />`;
        }
        return "";
    }
    // In list view, prefer the generated composite image if one exists
    const listSrc     = window._bpGetLastImageUrl?.() || gunImg;
    const listOpacity = window._bpIsInflight?.() ? ' style="opacity:0.35"' : '';
    return listSrc ? `<div class="bp-gun-img-wrap"><img class="att-table-gun-img" src="${escapeHtml(listSrc)}"${listOpacity} alt="" />${_bpWorkingLogoHtml()}</div>` : "";
}

function updateAttTableHeaderImg() {
    const parentNode = EFTForge.state.lastParentNode;
    const slot = EFTForge.state.lastSlot;
    if (!parentNode || !slot) return;

    const header = document.querySelector(".att-table-header");
    if (!header) return;

    const gun = EFTForge.state.currentGun;
    const gunImg = gun?.image_512_link || gun?.icon_link || "";
    const newHtml = _buildHeaderImgHtml(parentNode, slot, gunImg);

    // Also match .bp-gun-img-wrap so the whole wrapper is replaced
    const existing = header.querySelector(".att-table-icon-preview") ?? header.querySelector(".bp-gun-img-wrap") ?? header.querySelector(".att-table-gun-img");
    if (newHtml) {
        const tmp = document.createElement("div");
        tmp.innerHTML = newHtml;
        const newImg = tmp.firstElementChild;
        if (existing) {
            existing.replaceWith(newImg);
        } else {
            header.insertBefore(newImg, header.firstChild);
        }
    } else if (existing) {
        existing.remove();
    }
}
window.updateAttTableHeaderImg = updateAttTableHeaderImg;

async function openSlotSelector(parentNode, slot) {
    const seq = ++_slotLoadSeq;
    const _stale = () => seq !== _slotLoadSeq;

    // If this slot is already open, just re-open the mobile drawer and return
    if (EFTForge.state.lastParentNode === parentNode && EFTForge.state.lastSlot && EFTForge.state.lastSlot.id === slot.id) {
        openMobileRightPanel();
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

    EFTForge.state.currentSearchQuery = "";
    EFTForge.state.lastComboItems = [];
    EFTForge.state.comboMode = false;
    EFTForge.state.graphMode = false;
    _cleanupGraphState();
    _comboAvailableChecked = false;
    _abortComboCalc();
    _disconnectComboObserver();

  const box = document.getElementById("attachment-table-container");

  const { t, tSlot } = EFTForge.lang;

  const gun = EFTForge.state.currentGun;
  const gunImg = gun?.image_512_link || gun?.icon_link || "";

  // In grid view: show the installed attachment icon (or slot placeholder) instead of the gun
  const headerImgHtml = _buildHeaderImgHtml(parentNode, slot, gunImg);

  box.classList.remove("table-slide-in");
  void box.offsetWidth; // force reflow so removing+re-adding the class always retriggers
  box.classList.add("table-slide-in");
  box.addEventListener("animationend", () => box.classList.remove("table-slide-in"), { once: true });

  box.innerHTML = `
        <div class="att-table-header">
            ${headerImgHtml}
            <h3>${t("ui.selectAttFor")}<strong>${escapeHtml(tSlot(slot.slot_name))}</strong></h3>
            <div class="att-table-header-toggles">
                <button id="favorites-filter-btn" class="compare-toggle${_favoritesFilter ? ' active' : ''}" onclick="toggleFavoritesFilter()">
                    ★ ${t("ui.favorites")}
                    <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                </button>
                <button id="purchasable-toggle-btn" class="compare-toggle${EFTForge.state.purchasableOnly ? ' active' : ''}" onclick="togglePurchasableOnly()" data-tooltip="${escapeHtml(t("ui.purchasableOnlyTip"))}">
                    ${t("ui.purchasableOnly")}
                    <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                </button>
                <button id="compare-toggle-btn" class="compare-toggle${EFTForge.state.compareMode ? ' active' : ''}" onclick="toggleCompareMode()">
                    ${t("ui.compare")}
                    <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                </button>
                <div id="combo-view-btns" class="combo-view-btns">
                    <button id="combo-list-btn" class="toggle-btn${(!EFTForge.state.comboMode && !EFTForge.state.graphMode) ? ' active' : ''}" onclick="setListView()">${t("ui.comboList")}</button>
                    <button id="combo-combo-btn" class="toggle-btn${EFTForge.state.comboMode ? ' active' : ''}" onclick="setComboView(true)" style="display:none;">${t("ui.combo")}</button>
                    <button id="graph-view-btn" class="toggle-btn${EFTForge.state.graphMode ? ' active' : ''}" onclick="setGraphView(true)">${t("ui.graph")}</button>
                </div>
            </div>
            <button id="att-table-close-btn" class="att-table-close-btn">&#x2715;</button>
        </div>

        <div id="compare-hint" class="compare-mode-hint" style="display:none;"></div>

        <input
            type="text"
            id="attachment-search"
            placeholder="${escapeHtml(t("placeholder.attSearch"))}"
            class="search-input"
        />

        <div id="balance-controls" class="balance-controls" style="display:none;">
            <span class="balance-label">${escapeHtml(t("ui.balanceRecoil"))}</span>
            <input type="range" id="balance-slider" min="0" max="100" value="${EFTForge.state.comboErgoWeight}"
                   oninput="updateComboBalance(this.value)" onclick="event.stopPropagation()">
            <span class="balance-label">${escapeHtml(t("ui.balanceErgo"))}</span>
            <span id="balance-value" class="balance-value">${EFTForge.state.comboErgoWeight}%</span>
        </div>

        <table class="attachment-table hide-col-rub-recoil hide-col-balance">

            <thead>
                <tr>
                    <th id="th-name" onclick="changeSort('name')">
                        ${t("th.name")} <span class="sort-indicator"></span>
                    </th>
                    <th id="th-price" onclick="changeSort('price')" data-tooltip="${escapeHtml(t('th.priceTooltip'))}">
                        ${t("th.price")} <span class="sort-indicator"></span>
                    </th>
                    <th id="th-rub-recoil" onclick="changeSort('rub-recoil')" data-tooltip="${escapeHtml(t('th.rubRecoilTooltip'))}">
                        ${t("th.rubRecoil")} <span class="sort-indicator"></span>
                    </th>
                    <th id="th-weight" onclick="changeSort('weight')">
                        ${t("th.weight")} <span class="sort-indicator"></span>
                    </th>
                    <th id="th-recoil" onclick="changeSort('recoil')">
                        <span id="th-recoil-label">${t("th.recoil")}</span> <span class="sort-indicator"></span>
                    </th>
                    <th id="th-acc" onclick="changeSort('acc')">
                        ${t("th.accuracy")} <span class="sort-indicator"></span>
                    </th>
                    <th id="th-ergo" onclick="changeSort('ergo')">
                        ${t("th.ergo")} <span class="sort-indicator"></span>
                    </th>
                    <th id="th-evo" onclick="changeSort('evo')">
                        ${t("th.evoErgo")} <span class="sort-indicator"></span>
                    </th>
                    <th id="th-balance" onclick="changeSort('balance')" data-tooltip="${escapeHtml(t('th.balanceTooltip'))}">
                        ${t("th.balance")} <span class="sort-indicator"></span>
                    </th>
                    <th id="th-heat" onclick="changeSort('heat')">
                        ${t("th.heatCoolBurn")} <span class="sort-indicator"></span>
                    </th>
                    <th id="th-vel" onclick="changeSort('vel')">
                        ${t("th.muzzleVelocity")} <span class="sort-indicator"></span>
                    </th>
                </tr>
            </thead>

            <tbody id="attachment-body"></tbody>
        </table>
    `;

  const rightPanel = document.querySelector(".right-panel");
  if (rightPanel) rightPanel.scrollTop = 0;

  // Wire up the close button rendered in the header HTML above
  document.getElementById("att-table-close-btn").addEventListener("click", () => {
      box.innerHTML = "";
      const placeholder = document.getElementById("attachment-placeholder");
      placeholder.style.display = "";
      placeholder.classList.remove("placeholder-slide-in");
      void placeholder.offsetWidth;
      placeholder.classList.add("placeholder-slide-in");
      placeholder.addEventListener("animationend", () => placeholder.classList.remove("placeholder-slide-in"), { once: true });
      document.querySelectorAll(".tree-slot.active-slot")
          .forEach(el => el.classList.remove("active-slot"));
      EFTForge.state.lastSlot       = null;
      EFTForge.state.lastParentNode = null;
  });

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
      if (_stale()) { stopPanelLoading(slotOverlay); return; }
  }

  // Non-blocking: fetch ratings in the background; update cells when ready.
  // Desktop local mode: ratings are a community feature - skip entirely.
  if (!EFTForge.config.COMMUNITY_DISABLED) {
      EFTForge.api.fetchBulkRatings(items.map(i => i.id)).then(ratings => {
          Object.assign(EFTForge.state.ratingsCache, ratings);
          _refreshRatingCells();
      }).catch(() => {});
  }

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
      openMobileRightPanel();
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
  if (_stale()) { stopPanelLoading(slotOverlay); return; }

  window._devLastBatchResult = { slotId: slot.id, slotName: slot.slot_name, gunId: EFTForge.state.currentGun?.id, result: batchResult };

  const baseData = batchResult.base;
  const baseEED = parseFloat(baseData.evo_ergo_delta ?? 0);
  const baseRecoilV = baseData.recoil_vertical ?? null;
  const baseRecoilH = baseData.recoil_horizontal ?? null;
  const baseErgo = parseFloat(baseData.total_ergo ?? 0);
  const baseAccuracyMoa = baseData.accuracy_moa ?? null;
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
          simAccuracyMoa: r.accuracy_moa ?? null,
          simWeight: parseFloat(r.total_weight ?? 0),
          simEED: parseFloat(r.evo_ergo_delta ?? 0),
          baseErgo,
          baseRecoilV,
          baseRecoilH,
          baseAccuracyMoa,
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
  openMobileRightPanel();

  // Background flea fetch - re-sort once prices land so the price column populates
  const slotId = slot.id;
  ensureFleaPrices(items.map(i => i.id)).then(() => {
      if (EFTForge.state.lastSlot?.id === slotId) applyAttachmentSort();
  }).catch(() => {});
}

// Silently refetches candidate stats for the slot currently open in the attachment
// table, without tearing down the DOM (search text, scroll position, etc. survive).
// Needed after the build changes elsewhere while the table stays open: a candidate's
// simErgo/simRecoilV/simRecoilH/simWeight/simEED were computed against the installed-ids
// snapshot at fetch time, so removing an attachment elsewhere (e.g. resolving a conflict)
// leaves those simulated values stale even after the conflict flag itself is cleared.
let _reprocessOpenSlotGen = 0;
async function _reprocessOpenSlot() {
    const myGen = ++_reprocessOpenSlotGen;
    const parentNode = EFTForge.state.lastParentNode;
    const slot = EFTForge.state.lastSlot;
    if (!parentNode || !slot || !EFTForge.state.currentGun) return;

    const items = EFTForge.state.lastProcessedItems.map(e => e.item);
    if (!items.length) return;

    const baseAttachmentIds = collectAttachmentIds(EFTForge.state.buildTree);
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

    const cacheKey = `${slot.id}__${slotEmptiedIds.slice().sort().join(",")}`;

    if (EFTForge.state.processedCache[cacheKey]) {
        if (myGen !== _reprocessOpenSlotGen) return;
        EFTForge.state.lastProcessedItems = EFTForge.state.processedCache[cacheKey];
        applyAttachmentSort();
        return;
    }

    let removedSubtreeWeight = 0;
    if (parentNode.children[slot.id]) {
        const removedNode = parentNode.children[slot.id];
        const collectWeights = (node) => {
            removedSubtreeWeight += node.item.weight ?? 0;
            for (const sid in node.children) collectWeights(node.children[sid]);
        };
        collectWeights(removedNode);
    }

    const { t } = EFTForge.lang;
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
        console.error("Failed to reprocess attachments:", err);
        return;
    }

    // Bail if the user navigated to a different slot, or a newer reprocess/open superseded
    // this one, while the request was in flight - avoids an older response clobbering fresher data
    if (EFTForge.state.lastParentNode !== parentNode || EFTForge.state.lastSlot !== slot) return;
    if (myGen !== _reprocessOpenSlotGen) return;

    const baseData = batchResult.base;
    const baseEED = parseFloat(baseData.evo_ergo_delta ?? 0);
    const baseRecoilV = baseData.recoil_vertical ?? null;
    const baseRecoilH = baseData.recoil_horizontal ?? null;
    const baseErgo = parseFloat(baseData.total_ergo ?? 0);
    const baseAccuracyMoa = baseData.accuracy_moa ?? null;
    const currentBuildBaseWeight = parseFloat(baseData.total_weight ?? 0) + removedSubtreeWeight;

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
            simAccuracyMoa: r.accuracy_moa ?? null,
            simWeight: parseFloat(r.total_weight ?? 0),
            simEED: parseFloat(r.evo_ergo_delta ?? 0),
            baseErgo,
            baseRecoilV,
            baseRecoilH,
            baseAccuracyMoa,
            baseWeight: currentBuildBaseWeight,
            baseEED,
        };
    }).filter(Boolean);

    cacheSet(EFTForge.state.processedCache, cacheKey, processedItems);
    EFTForge.state.lastProcessedItems = processedItems;

    applyAttachmentSort();
}

function applyAttachmentSearch(query) {
    EFTForge.state.currentSearchQuery = query.toLowerCase();
    applyAttachmentSort();
}

function applyAttachmentSort() {
  if (EFTForge.state.comboMode) {
      applyComboSort();
      return;
  }
  if (EFTForge.state.graphMode) {
      const svgWrap = document.getElementById("graph-svg-wrap");
      if (svgWrap) _buildGraphSVG(svgWrap);
      return;
  }

  const dir = EFTForge.state.attachmentSort.direction === "asc" ? 1 : -1;

  let itemsToRender = EFTForge.state.currentSearchQuery
      ? EFTForge.state.lastProcessedItems.filter(entry =>
          entry.sortName.includes(EFTForge.state.currentSearchQuery)
        )
      : EFTForge.state.lastProcessedItems;

  if (EFTForge.state.purchasableOnly) {
      itemsToRender = itemsToRender.filter(entry => {
          const item = entry.item;
          if (!item.trader_vendor || item.trader_price_rub == null) return false;
          const requiredLevel = item.trader_min_level ?? 1;
          const userLevel = EFTForge.state.traderLevels[item.trader_vendor] ?? 4;
          return userLevel >= requiredLevel;
      });
  }

  if (_favoritesFilter) {
      const favs = _getFavorites();
      itemsToRender = itemsToRender.filter(entry => favs.has(entry.item.id));
  }

  const _favSet = _getFavorites();

  itemsToRender.sort((a, b) => {
    // Favorites always pin to top
    const aFav = _favSet.has(a.item.id);
    const bFav = _favSet.has(b.item.id);
    if (aFav !== bFav) return aFav ? -1 : 1;

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

        case "acc":
            // Sort by COI (barrel MOA) if available, else by accuracy_modifier; items with neither sort last
            {
                const aVal = a.item.center_of_impact ?? (a.item.accuracy_modifier != null ? a.item.accuracy_modifier / 1000 + 999 : 9999);
                const bVal = b.item.center_of_impact ?? (b.item.accuracy_modifier != null ? b.item.accuracy_modifier / 1000 + 999 : 9999);
                primary = aVal - bVal;
            }
            break;

        case "price":
            {
                const ap = _getPriceRub(a.item);
                const bp = _getPriceRub(b.item);
                if (ap === null && bp === null) { primary = 0; break; }
                if (ap === null) return 1;
                if (bp === null) return -1;
                primary = ap - bp;
            }
            break;

        case "heat":
            primary = (a.item.heat_factor ?? 1) - (b.item.heat_factor ?? 1);
            break;

        case "vel":
            primary = (a.item.velocity_modifier ?? 0) - (b.item.velocity_modifier ?? 0);
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
  _updateColumnVisibility(itemsToRender);

  if (!_comboAvailableChecked) _checkComboAvailability();
}

function _updateColumnVisibility(items) {
    const table = document.querySelector(".attachment-table");
    if (!table) return;

    const hasWeight  = items.some(e => parseFloat(e.item.weight ?? 0) !== 0);
    const hasRecoil  = items.some(e => e.item.recoil_modifier != null && e.item.recoil_modifier !== 0);
    const hasAcc     = items.some(e =>
        e.item.center_of_impact != null ||
        (e.item.accuracy_modifier != null && e.item.accuracy_modifier !== 0)
    );
    const hasErgo    = items.some(e => e.item.ergonomics_modifier != null && e.item.ergonomics_modifier !== 0);
    const hasEvo     = hasErgo && items.some(e => Math.abs(e.contribution) > 0.05);
    const hasPrice   = items.some(e => _getPriceRub(e.item) !== null);
    const hasHeat    = items.some(e =>
        e.item.heat_factor != null || e.item.cooling_factor != null || e.item.durability_burn_factor != null
    );
    const hasVel     = items.some(e => e.item.velocity_modifier != null && e.item.velocity_modifier !== 0);

    table.classList.toggle("hide-col-weight", !hasWeight);
    table.classList.toggle("hide-col-recoil", !hasRecoil);
    table.classList.toggle("hide-col-acc",    !hasAcc);
    table.classList.toggle("hide-col-ergo",   !hasErgo);
    table.classList.toggle("hide-col-evo",    !hasEvo);
    table.classList.toggle("hide-col-price",  !hasPrice);
    table.classList.toggle("hide-col-heat",   !hasHeat);
    table.classList.toggle("hide-col-vel",    !hasVel);
    // Combo-only columns - always hidden in list mode
    table.classList.add("hide-col-rub-recoil", "hide-col-balance");
}

function changeSort(key) {
  if (EFTForge.state.comboMode) {
    const bestDir = { recoil: "asc", weight: "asc", ergo: "desc", evo: "desc", price: "asc", name: "asc", "rub-recoil": "asc", balance: "desc" };
    if (EFTForge.state.comboSort.key === key) {
      EFTForge.state.comboSort.direction = EFTForge.state.comboSort.direction === "asc" ? "desc" : "asc";
    } else {
      EFTForge.state.comboSort.key       = key;
      EFTForge.state.comboSort.direction = bestDir[key] ?? "asc";
    }
    applyAttachmentSort();
    return;
  }

  const sortState = EFTForge.state.attachmentSort;
  if (sortState.key === key) {
    sortState.direction = sortState.direction === "asc" ? "desc" : "asc";
  } else {
    sortState.key = key;
    if (key === "recoil") {
      sortState.direction = "asc";
    } else if (key === "evo") {
      sortState.direction = "desc";
    } else if (key === "price") {
      sortState.direction = "asc";
    } else {
      sortState.direction = "asc";
    }
  }

  applyAttachmentSort();
}

function updateSortIndicators() {
  const sortState = EFTForge.state.comboMode
      ? EFTForge.state.comboSort
      : EFTForge.state.attachmentSort;

  const headers = ["name", "weight", "recoil", "ergo", "acc", "evo", "rub-recoil", "price", "balance", "heat", "vel"];
  headers.forEach(key => {
    const th = document.getElementById(`th-${key}`);
    if (!th) return;
    th.querySelector(".sort-indicator").textContent = "";
    th.classList.remove("active-sort");
  });

  const activeTh = document.getElementById(`th-${sortState.key}`);
  if (!activeTh) return;
  activeTh.classList.add("active-sort");
  activeTh.querySelector(".sort-indicator").textContent =
      sortState.direction === "asc" ? " ▲" : " ▼";

  const balanceControls = document.getElementById("balance-controls");
  if (balanceControls) {
      const show = EFTForge.state.comboMode && sortState.key === "balance";
      balanceControls.style.display = show ? "flex" : "none";
  }
}

function updateComboBalance(value) {
    EFTForge.state.comboErgoWeight = parseInt(value, 10);
    localStorage.setItem("eftforge_combo_ergo_weight", value);
    const label = document.getElementById("balance-value");
    if (label) label.textContent = `${value}%`;
    const slider = document.getElementById("balance-slider");
    if (slider) slider.value = value;
    applyComboSort();
}

function togglePurchasableOnly() {
    EFTForge.state.purchasableOnly = !EFTForge.state.purchasableOnly;
    const btn = document.getElementById("purchasable-toggle-btn");
    if (btn) btn.classList.toggle("active", EFTForge.state.purchasableOnly);
    if (EFTForge.state.comboMode) applyComboSort();
    else applyAttachmentSort();
}

function toggleCompareMode() {
    if (isMobileLayout()) return;
    // Disable combo mode if enabling compare
    if (!EFTForge.state.compareMode && EFTForge.state.comboMode) {
        _abortComboCalc();
        EFTForge.state.comboMode = false;
        EFTForge.state.lastComboItems = [];
        _updateViewBtns();
    }

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
    EFTForge.utils.updateBlobColor();
    applyAttachmentSort();
}

// Helper: animate a delta bar in using double-rAF to avoid forced reflow
function _animateDeltaBarIn(deltaEl) {
    if (deltaEl._showRaf != null) { cancelAnimationFrame(deltaEl._showRaf); deltaEl._showRaf = null; }
    if (parseFloat(deltaEl.style.left) < 0) {
        deltaEl.style.transform = "scaleX(0)";
        deltaEl.style.opacity = "0";
        return;
    }
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

// recoil_modifier is a non-nullable DB column (models_items.py: default=0), so
// items that don't affect recoil at all - pistol grips, for example - come
// back as 0.0 rather than null. There's no separate "not applicable" value to
// key off, so I treat literal 0 the same as missing, same convention already
// used for velocity_modifier's cell (_velCellHtml).
function _recoilCellText(recoilModifier, recoilPercent) {
    return (recoilModifier == null || recoilModifier === 0) ? "-" : `${formatStat(recoilPercent)}%`;
}

function _hcbSegmentHtml(value, positiveIsGood) {
    if (value == null) return `<span>-</span>`;
    const pct = (value - 1) * 100;
    if (Math.abs(pct) < 0.05) return `<span>0%</span>`;
    const isGood = positiveIsGood ? pct > 0 : pct < 0;
    const cls = isGood ? "positive" : "negative";
    return `<span class="${cls}">${pct > 0 ? "+" : ""}${pct.toFixed(1)}%</span>`;
}

function _heatCoolBurnCellHtml(item) {
    const h = item.heat_factor, c = item.cooling_factor, b = item.durability_burn_factor;
    if (h == null && c == null && b == null) return `<td class="hcb-cell">-</td>`;
    // Order matches the header: Heat / Cooling / Burn. Heat and Burn are bad when higher; Cooling is good when higher.
    const html = `${_hcbSegmentHtml(h, false)}/${_hcbSegmentHtml(c, true)}/${_hcbSegmentHtml(b, false)}`;
    return `<td class="hcb-cell">${html}</td>`;
}

function _velCellHtml(item) {
    const v = item.velocity_modifier ?? null;
    if (v == null || v === 0) return `<td class="vel-cell">-</td>`;
    const cls = v > 0 ? "positive" : "negative";
    return `<td class="vel-cell"><span class="${cls}">${v > 0 ? "+" : ""}${v.toFixed(1)}%</span></td>`;
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
          <td>${_attPriceCellContent(blItem)}</td>
          <td class="col-combo-only"></td>
          <td>${ghostStats ? ghostStats.weight.toFixed(3) : parseFloat(blItem.weight ?? 0).toFixed(3)}</td>
          <td>${ghostStats ? `${formatStat(ghostStats.recoilPct)}%` : _recoilCellText(blItem.recoil_modifier, bl.recoilPercent)}</td>
          <td class="acc-cell">${(() => {
              const coi = blItem.center_of_impact ?? null;
              const am  = blItem.accuracy_modifier ?? null;
              if (coi !== null) {
                  return `<span class="acc-coi-val">${(coi * 34.3).toFixed(2)} MOA</span>`;
              } else if (am !== null && am !== 0) {
                  return `<span class="${am < 0 ? "positive" : "negative"}">${am > 0 ? "+" : ""}${am.toFixed(1)}%</span>`;
              }
              return `-`;
          })()}</td>
          <td class="${(ghostStats ? ghostStats.ergo : bl.ergoModifier) >= 0 ? "ergo-positive" : "ergo-negative"}">${(ghostStats ? ghostStats.ergo : bl.ergoModifier) >= 0 ? "+" : ""}${formatStat(ghostStats ? ghostStats.ergo : bl.ergoModifier)}</td>
          <td class="${(ghostStats ? ghostStats.contrib : bl.contribution) >= 0 ? "evo-positive" : "evo-negative"}">${(ghostStats ? ghostStats.contrib : bl.contribution) >= 0 ? "+" : ""}${(ghostStats ? ghostStats.contrib : bl.contribution).toFixed(1)}</td>
          <td class="col-combo-only"></td>
          ${_heatCoolBurnCellHtml(blItem)}
          ${_velCellHtml(blItem)}
      `;

      ghostRow.addEventListener("mouseenter", () => {
          if (!_statBarEls || !_statBarEls.ergoFill?.isConnected) _cacheStatBarEls();
          if (!_statBarEls) return;
          const { ergoFill, ergoVal, rvFill, rvVal, rhFill, rhVal, accFill, accVal } = _statBarEls;
          [ergoFill, rvFill, rhFill, accFill].forEach(fill => {
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
          if (bl.simAccuracyMoa !== null) {
              if (accFill) accFill.style.width = Math.min(bl.simAccuracyMoa / 10, 1) * 100 + "%";
              if (accVal)  accVal.textContent = bl.simAccuracyMoa.toFixed(2) + " MOA";
          }
      });

      ghostRow.addEventListener("mouseleave", () => {
          if (!_statBarEls) return;
          const { ergoFill, ergoVal, rvFill, rvVal, rhFill, rhVal, accFill, accVal } = _statBarEls;
          [ergoFill, rvFill, rhFill, accFill].forEach(fill => {
              if (!fill) return;
              const deltaEl = fill.parentElement.querySelector(".delta-bar");
              if (deltaEl) _animateDeltaBarOut(deltaEl);
          });
          if (ergoVal) ergoVal.textContent = formatStat(bl.simErgo);
          if (rvVal)   rvVal.textContent   = bl.simRecoilV !== null ? Math.round(bl.simRecoilV) : "-";
          if (rhVal)   rhVal.textContent   = bl.simRecoilH !== null ? Math.round(bl.simRecoilH) : "-";
          if (accVal)  accVal.textContent  = bl.simAccuracyMoa !== null ? bl.simAccuracyMoa.toFixed(2) + " MOA" : "-";
      });

      fragment.appendChild(ghostRow);
  }

  for (const entry of items) {

    const { item, contribution, recoilPercent, ergoModifier } = entry;

    const row = document.createElement("tr");
    row.dataset.itemId = item.id;

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

    // Accuracy cell content: barrel COI takes priority over % modifier
    const itemCOI = item.center_of_impact ?? null;
    const itemAccMod = item.accuracy_modifier ?? null;
    let accCellContent;
    if (itemCOI !== null) {
        accCellContent = `<span class="acc-coi-val">${(itemCOI * 34.3).toFixed(2)} MOA</span>`;
    } else if (itemAccMod !== null && itemAccMod !== 0) {
        const cls = itemAccMod > 0 ? "positive" : "negative";
        accCellContent = `<span class="${cls}">${itemAccMod > 0 ? "+" : ""}${itemAccMod.toFixed(1)}%</span>`;
    } else {
        accCellContent = `-`;
    }
    const accCell = `<td class="acc-cell">${accCellContent}</td>`;

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

        recoilCell = `<td>${_recoilCellText(item.recoil_modifier, recoilPercent)}${rD !== 0
            ? `<div class="cmp-delta ${rD < 0 ? "positive" : "negative"}">${fmtD(rD, 1)}%</div>` : ""}</td>`;

        ergoCell = `<td class="${ergoModifier >= 0 ? "ergo-positive" : "ergo-negative"}">${ergoModifier >= 0 ? "+" : ""}${formatStat(ergoModifier)}${eD !== 0
            ? `<div class="cmp-delta ${eD > 0 ? "positive" : "negative"}">${fmtD(eD, 1)}</div>` : ""}</td>`;

        evoCell = `<td class="${contribution >= 0 ? "evo-positive" : "evo-negative"}">${contribution >= 0 ? "+" : ""}${contribution.toFixed(1)}${evD !== 0
            ? `<div class="cmp-delta ${evD > 0 ? "positive" : "negative"}">${fmtD(evD, 1)}</div>` : ""}</td>`;
    } else {
        weightCell   = `<td>${parseFloat(item.weight ?? 0).toFixed(3)}</td>`;
        recoilCell   = `<td>${_recoilCellText(item.recoil_modifier, recoilPercent)}</td>`;
        ergoCell     = `<td class="${ergoModifier >= 0 ? "ergo-positive" : "ergo-negative"}">${ergoModifier >= 0 ? "+" : ""}${formatStat(ergoModifier)}</td>`;
        evoCell      = `<td class="${contribution >= 0 ? "evo-positive" : "evo-negative"}">${contribution >= 0 ? "+" : ""}${contribution.toFixed(1)}</td>`;
    }

    const isFav = _getFavorites().has(item.id);
    row.innerHTML = `
        <td class="name-cell">
            <div class="attachment-name-wrapper">

                <button class="att-fav-btn${isFav ? ' active' : ''}" data-item-id="${escapeHtml(item.id)}" onclick="handleFavClick(event,'${escapeHtml(item.id)}')" title="${escapeHtml(t('ui.favorites'))}">★</button>

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
                    ${EFTForge._dev?.showItemIds ? `<div class="dev-item-id-badge" data-id="${escapeHtml(item.id)}">${escapeHtml(item.id)}</div>` : ""}
                    ${item.task_unlock_name ? `<div class="att-task-unlock">${escapeHtml(t("ui.taskUnlock"))}${escapeHtml((EFTForge.state.lang === "zh" && item.task_unlock_name_zh) ? item.task_unlock_name_zh : item.task_unlock_name)}</div>` : ""}
                    ${(() => {
                        if (EFTForge.config.COMMUNITY_DISABLED) return "";
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

        <td>${_attPriceCellContent(item)}</td>
        <td class="col-combo-only"></td>
        ${weightCell}
        ${recoilCell}
        ${accCell}
        ${ergoCell}
        ${evoCell}
        <td class="col-combo-only"></td>
        ${_heatCoolBurnCellHtml(item)}
        ${_velCellHtml(item)}
    `;

    row.addEventListener("mouseenter", () => {
        if (entry.hasConflict) return;
        // Re-cache if the stats panel was rebuilt (e.g. after an install)
        if (!_statBarEls || !_statBarEls.ergoFill?.isConnected) _cacheStatBarEls();
        if (!_statBarEls) return;

        // In compare mode with a baseline: use baseline stats as reference
        // Otherwise: use the current build's stats
        let refErgo, refRecoilV, refRecoilH, refAccuracyMoa, refWeight, refEED;
        if (EFTForge.state.compareMode && EFTForge.state.compareBaselineId) {
            const bl = EFTForge.state.lastProcessedItems.find(
                e => String(e.item.id) === EFTForge.state.compareBaselineId
            ) || EFTForge.state.compareBaselineEntry;
            if (bl) {
                refErgo        = bl.simErgo;
                refRecoilV     = bl.simRecoilV;
                refRecoilH     = bl.simRecoilH;
                refAccuracyMoa = bl.simAccuracyMoa ?? null;
                refWeight      = bl.simWeight;
                refEED         = bl.simEED;
            } else {
                refErgo        = EFTForge.state.lastTotalErgo;
                refRecoilV     = EFTForge.state.lastRecoilV;
                refRecoilH     = EFTForge.state.lastRecoilH;
                refAccuracyMoa = EFTForge.state.lastAccuracyMoa ?? null;
                refWeight      = EFTForge.state.lastTotalWeight;
                refEED         = EFTForge.state.lastEED;
            }
        } else {
            refErgo        = EFTForge.state.lastTotalErgo;
            refRecoilV     = EFTForge.state.lastRecoilV;
            refRecoilH     = EFTForge.state.lastRecoilH;
            refAccuracyMoa = EFTForge.state.lastAccuracyMoa ?? null;
            refWeight      = EFTForge.state.lastTotalWeight;
            refEED         = EFTForge.state.lastEED;
        }

        const { ergoFill, ergoVal, rvFill, rvVal, rhFill, rhVal, accFill, accVal } = _statBarEls;

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

        // Accuracy bar (lower MOA = better = more fill, cap at 3 MOA)
        if (entry.simAccuracyMoa !== null && refAccuracyMoa !== null && accFill) {
            const accBase  = Math.min(refAccuracyMoa / 10, 1) * 100;
            const accDelta = entry.simAccuracyMoa - refAccuracyMoa;
            const accSim   = Math.min((refAccuracyMoa + accDelta) / 10, 1) * 100;
            accFill.style.width = accBase + "%";
            let deltaEl = accFill.parentElement.querySelector(".delta-bar");
            if (!deltaEl) {
                deltaEl = document.createElement("div");
                deltaEl.className = "delta-bar";
                accFill.parentElement.appendChild(deltaEl);
            }
            if (accDelta !== 0) {
                deltaEl.style.left = Math.min(accBase, accSim) + "%";
                deltaEl.style.width = Math.abs(accSim - accBase) + "%";
                deltaEl.style.background = accDelta <= 0 ? "#4CAF50" : "#f44336";
                // Delta bar tracks MOA value direction: MOA up (worse) extends right, MOA down (better) shrinks from right
                deltaEl.style.borderRadius = accDelta > 0 ? "0 3px 3px 0" : "3px";
                deltaEl.style.transformOrigin = accDelta > 0 ? "left" : "right";
                deltaEl.style.display = "";
                _animateDeltaBarIn(deltaEl);
            } else {
                _animateDeltaBarOut(deltaEl);
            }
            if (accVal) {
                const deltaText = accDelta !== 0
                    ? ` <span style="color:${accDelta <= 0 ? "#4CAF50" : "#f44336"}">(${accDelta > 0 ? "+" : ""}${accDelta.toFixed(2)})</span>`
                    : "";
                accVal.innerHTML = `<span style="color:#eee">${refAccuracyMoa.toFixed(2)} MOA</span>${deltaText}`;
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

        const { ergoFill, ergoVal, rvFill, rvVal, rhFill, rhVal, accFill, accVal } = _statBarEls;

        // Animate delta bars out
        [ergoFill, rvFill, rhFill, accFill].forEach(fill => {
            if (!fill) return;
            const deltaEl = fill.parentElement.querySelector(".delta-bar");
            if (deltaEl) _animateDeltaBarOut(deltaEl);
        });

        // In compare mode with a baseline: restore to baseline stats; otherwise current build
        let displayErgo, displayRv, displayRh, displayAcc;
        if (EFTForge.state.compareMode && EFTForge.state.compareBaselineId) {
            const bl = EFTForge.state.lastProcessedItems.find(
                e => String(e.item.id) === EFTForge.state.compareBaselineId
            ) || EFTForge.state.compareBaselineEntry;
            if (bl) {
                displayErgo = bl.simErgo;
                displayRv   = bl.simRecoilV;
                displayRh   = bl.simRecoilH;
                displayAcc  = bl.simAccuracyMoa ?? null;
            } else {
                displayErgo = EFTForge.state.lastTotalErgo;
                displayRv   = EFTForge.state.lastRecoilV;
                displayRh   = EFTForge.state.lastRecoilH;
                displayAcc  = EFTForge.state.lastAccuracyMoa ?? null;
            }
        } else {
            displayErgo = EFTForge.state.lastTotalErgo;
            displayRv   = EFTForge.state.lastRecoilV;
            displayRh   = EFTForge.state.lastRecoilH;
            displayAcc  = EFTForge.state.lastAccuracyMoa ?? null;
        }

        if (ergoFill) ergoFill.style.width = Math.min(displayErgo, 100) + "%";
        if (ergoVal)  ergoVal.textContent  = formatStat(displayErgo);
        if (rvFill)   rvFill.style.width   = displayRv !== null ? Math.min(Math.round(displayRv), 500) / 5 + "%" : "0%";
        if (rvVal)    rvVal.textContent    = displayRv !== null ? Math.round(displayRv) : "-";
        if (rhFill)   rhFill.style.width   = displayRh !== null ? Math.min(Math.round(displayRh), 500) / 5 + "%" : "0%";
        if (rhVal)    rhVal.textContent    = displayRh !== null ? Math.round(displayRh) : "-";
        if (accFill)  accFill.style.width  = displayAcc !== null ? Math.min(displayAcc / 10, 1) * 100 + "%" : "0%";
        if (accVal)   accVal.textContent   = displayAcc !== null ? displayAcc.toFixed(2) + " MOA" : "-";

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

    // Swipe-left to remove (touch devices - auto-registered by MutationObserver in app.js)
    // Disabled on mobile: table rows scroll horizontally to show stats, swipe-to-remove
    // lives in the workbench tree slots instead.
    if (!isMobileLayout() && installedId && String(installedId) === String(item.id)) {
        row.classList.add("swipe-removable");
        row._swipeRemoveFn = () => {
            if (EFTForge.state.publishMode) return;
            removeAttachment(EFTForge.state.lastParentNode, EFTForge.state.lastSlot.id, true);
            closeMobileRightPanel();
        };
    }

    row.addEventListener("click", () => {

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
            replaceToast(
                "attachment-conflict",
                t("toast.attachmentConflict"),
                `${item.name}\n${entry.conflictName}`
            );

            if (EFTForge.state.gridView) {
                const conflictsWithGun = entry.conflictingItemId && entry.conflictingItemId === EFTForge.state.currentGun?.id;
                if (conflictsWithGun) {
                    flashGunCellInGrid();
                } else {
                    if (entry.conflictingItemId) flashConflictInGrid(entry.conflictingItemId);
                    if (entry.conflictingSlotId) flashConflictSlotInGrid(entry.conflictingSlotId);
                }
            } else {
                if (entry.conflictingItemId) flashConflictInTree(EFTForge.state.buildTree, entry.conflictingItemId);
                if (entry.conflictingSlotId) flashConflictSlotInTree(entry.conflictingSlotId);
            }

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

  if (items.length === 0) {
      const emptyRow = document.createElement("tr");
      emptyRow.className = "att-empty-row";
      emptyRow.innerHTML = `<td colspan="9" style="text-align:center;padding:18px 0;color:#666;font-size:13px;">${t("ui.noAttachments")}</td>`;
      fragment.appendChild(emptyRow);
  }

  tbody.appendChild(fragment);
  _initMarqueeText(tbody, { hoverOnly: !isMobileLayout() });
  _cacheStatBarEls();
}

// ============================================================
// COMBO MODE
// ============================================================

// Keep combo search boundaries independent of attachment-grid placement rules.
const _COMBO_ASSEMBLY_SLOT_NAMES = ["Receiver", "Handguard", "Catch", "Barrel", "Gas Block", "Muzzle"];

// Return [{parentNode, slotId}, ...] from fromNode to targetNode through successive
// children, or null if not found. Return an empty array when the nodes are identical.
function _findAncestorPath(fromNode, targetNode) {
    if (fromNode === targetNode) return [];
    for (const [slotId, childNode] of Object.entries(fromNode.children || {})) {
        if (childNode === targetNode) return [{ parentNode: fromNode, slotId }];
        const sub = _findAncestorPath(childNode, targetNode);
        if (sub !== null) return [{ parentNode: fromNode, slotId }, ...sub];
    }
    return null;
}

// Find the effective combo root for the current slot selection.
// Treat assembly slots as their own roots and stop their descendants at the nearest
// assembly boundary. Bubble other slots up to the gun's direct child slot.
function _findComboRootSlot() {
    const tree         = EFTForge.state.buildTree;
    const targetParent = EFTForge.state.lastParentNode;
    const targetSlotId = EFTForge.state.lastSlot?.id;
    if (!tree || !targetParent || !targetSlotId) return { parentNode: targetParent, slotId: targetSlotId };

    const assemblySlots = new Set(_COMBO_ASSEMBLY_SLOT_NAMES);

    // Keep a selected assembly slot as its own combo root.
    if (assemblySlots.has(EFTForge.state.lastSlot?.slot_name)) {
        return { parentNode: targetParent, slotId: targetSlotId, isLeftQueueRoot: true };
    }

    // Direct child of gun root - return as-is
    if (targetParent === tree) return { parentNode: tree, slotId: targetSlotId, isLeftQueueRoot: false };

    // Walk path from gun root down to targetParent
    const path = _findAncestorPath(tree, targetParent);
    if (path && path.length > 0) {
        // Find the deepest assembly boundary along the path.
        for (let i = path.length - 1; i >= 0; i--) {
            const { parentNode, slotId } = path[i];
            const slots = EFTForge.state.slotCache[parentNode.item.id] || [];
            const slot  = slots.find(s => s.id === slotId);
            if (slot && assemblySlots.has(slot.slot_name)) {
                return { parentNode, slotId, isLeftQueueRoot: true };
            }
        }
        // Fall back to the gun root's direct child when no assembly boundary applies.
        return { parentNode: tree, slotId: path[0].slotId, isLeftQueueRoot: false };
    }

    return { parentNode: targetParent, slotId: targetSlotId, isLeftQueueRoot: false };
}

const _comboChildSlotCache   = {};   // item_id -> slots[]  (used only for availability check)
let _comboAvailableChecked = false; // true once we've finished the availability check for the current slot
let _comboAbortController  = null;  // AbortController for the in-flight comboFull request
let _comboCalcInFlight     = false; // true while a comboFull fetch is in progress
let _comboRequestGen       = 0;     // only the current request may update the view

const _COMBO_BATCH_SIZE  = 60;
let _comboLazyItems      = [];   // full sorted list for lazy rendering
let _comboLazyRendered   = 0;    // rows currently in the DOM
let _comboLazyObserver   = null; // kept for legacy disconnect calls
let _comboScrollListener = null; // scroll listener driving lazy batch loading
let _comboLoadGen        = 0;    // incremented on each new load to cancel stale rAF callbacks
let _comboSpacer         = null; // <tr> that reserves height for unrendered rows
let _comboRowHeight      = 65;   // measured px per row, updated on first render


function _disconnectComboObserver() {
    if (_comboLazyObserver) {
        _comboLazyObserver.disconnect();
        _comboLazyObserver = null;
    }
    if (_comboScrollListener) {
        const sr = document.querySelector(".right-panel");
        if (sr) sr.removeEventListener("scroll", _comboScrollListener);
        _comboScrollListener = null;
    }
    _comboLoadGen++;
    _comboSpacer = null;
}

function _abortComboCalc() {
    _comboRequestGen++;
    if (_comboAbortController) {
        _comboAbortController.abort();
        _comboAbortController = null;
    }
    _comboCalcInFlight = false;
}

function _updateViewBtns() {
    const inList = !EFTForge.state.comboMode && !EFTForge.state.graphMode;
    document.getElementById("combo-list-btn")?.classList.toggle("active", inList);
    document.getElementById("graph-view-btn")?.classList.toggle("active", EFTForge.state.graphMode);
    document.getElementById("combo-combo-btn")?.classList.toggle("active", EFTForge.state.comboMode);
}


function setListView() {
    const wasCombo = EFTForge.state.comboMode;
    const wasGraph = EFTForge.state.graphMode;
    if (!wasCombo && !wasGraph) return;

    if (wasCombo) {
        _abortComboCalc();
        _disconnectComboObserver();
        EFTForge.state.comboMode = false;
        EFTForge.state.lastComboItems = [];
    }
    if (wasGraph) {
        EFTForge.state.graphMode = false;
        _cleanupGraphState();
        document.getElementById("attachment-graph")?.remove();
        const table = document.querySelector(".attachment-table");
        if (table) table.style.display = "";
        const searchInput = document.getElementById("attachment-search");
        if (searchInput) searchInput.style.display = "";
    }

    _updateViewBtns();
    _updateGraphHeader();
    const _recoilLabelList = document.getElementById("th-recoil-label");
    if (_recoilLabelList) _recoilLabelList.textContent = EFTForge.lang.t("th.recoil");

    const slideTable = document.querySelector(".attachment-table");
    if (slideTable) {
        slideTable.classList.remove("table-slide-in");
        void slideTable.offsetWidth;
        slideTable.classList.add("table-slide-in");
        slideTable.addEventListener("animationend", () => slideTable.classList.remove("table-slide-in"), { once: true });
    }

    applyAttachmentSort();
}


function setComboView(wantCombo) {
    if (!wantCombo) { setListView(); return; }
    if (EFTForge.state.comboMode) return;

    if (EFTForge.state.graphMode) {
        EFTForge.state.graphMode = false;
        _cleanupGraphState();
        document.getElementById("attachment-graph")?.remove();
        const table = document.querySelector(".attachment-table");
        if (table) table.style.display = "";
        const searchInput = document.getElementById("attachment-search");
        if (searchInput) searchInput.style.display = "";
    }

    EFTForge.state.comboMode = true;
    _updateViewBtns();
    _updateGraphHeader();
    const _recoilLabelCombo = document.getElementById("th-recoil-label");
    if (_recoilLabelCombo) _recoilLabelCombo.textContent = EFTForge.lang.t("th.recoil");

    const slideTableCombo = document.querySelector(".attachment-table");
    if (slideTableCombo) {
        slideTableCombo.classList.remove("table-slide-in");
        void slideTableCombo.offsetWidth;
        slideTableCombo.classList.add("table-slide-in");
        slideTableCombo.addEventListener("animationend", () => slideTableCombo.classList.remove("table-slide-in"), { once: true });
    }

    if (EFTForge.state.compareMode) {
        EFTForge.state.compareMode = false;
        EFTForge.state.compareBaselineId = null;
        EFTForge.state.compareBaselineEntry = null;
        EFTForge.state.compareBaselineSlotPath = null;
        const cmpBtn = document.getElementById("compare-toggle-btn");
        if (cmpBtn) cmpBtn.classList.remove("active");
    }
    openComboView();
}

async function _checkComboAvailability() {
    _comboAvailableChecked = true;
    const { slotId: rootSlotId } = _findComboRootSlot();

    // If we are inside a sub-slot of an already-installed item, that item by
    // definition has child slots. The root-level combo is always calculable.
    if (rootSlotId !== EFTForge.state.lastSlot?.id) {
        _showComboToggle(true);
        return;
    }

    // Root-level slot: check whether any items in it have child slots.
    const validItems = EFTForge.state.lastProcessedItems.filter(e => !e.hasConflict);
    if (!validItems.length) return;

    // Phase 1: check existing caches
    for (const entry of validItems) {
        if (_comboChildSlotCache.hasOwnProperty(entry.item.id)) {
            if (_comboChildSlotCache[entry.item.id].length > 0) { _showComboToggle(true); return; }
            continue;
        }
        const sc = EFTForge.state.slotCache[entry.item.id];
        if (sc && sc.some(s => s.has_allowed_items)) { _showComboToggle(true); return; }
    }

    // Phase 2: fetch uncached items in parallel; show as soon as one has child slots
    const uncached = validItems.filter(e =>
        !_comboChildSlotCache.hasOwnProperty(e.item.id) &&
        !EFTForge.state.slotCache[e.item.id]
    );
    if (!uncached.length) return;

    const batch = uncached.slice(0, 20);
    let found = false;
    await Promise.allSettled(batch.map(async entry => {
        if (found || !_comboAvailableChecked) return;
        try {
            const slots = await fetchItemSlots(entry.item.id);
            const filtered = slots.filter(s => s.has_allowed_items);
            _comboChildSlotCache[entry.item.id] = filtered;
            if (filtered.length > 0 && !found) { found = true; _showComboToggle(true); }
        } catch { /* ignore */ }
    }));
}

function _showComboToggle(visible) {
    const btn       = document.getElementById("combo-combo-btn");
    const container = document.getElementById("combo-view-btns");
    if (btn)       btn.style.display = visible ? "" : "none";
    if (container) container.classList.toggle("has-combo", visible);
}


async function openComboView() {
    if (!EFTForge.state.lastSlot || !EFTForge.state.lastParentNode) return;
    // Cache hits and already-resolved fetches must also invalidate the old request.
    _abortComboCalc();
    const requestGen = _comboRequestGen;
    const requestTree = EFTForge.state.buildTree;
    const requestSlot = EFTForge.state.lastSlot;
    const requestParent = EFTForge.state.lastParentNode;
    _disconnectComboObserver();

    const { t } = EFTForge.lang;

    // Calculate from the selected assembly boundary or the gun's direct child slot.
    const { parentNode: rootParentNode, slotId: rootSlotId, isLeftQueueRoot } = _findComboRootSlot();

    // Build slot-emptied IDs: remove everything installed under the root slot
    const baseIds = collectAttachmentIds(EFTForge.state.buildTree);
    let slotEmptiedIds = baseIds;
    if (rootParentNode.children[rootSlotId]) {
        const installedNode = rootParentNode.children[rootSlotId];
        const idsToRemove = new Set([installedNode.item.id, ...collectAttachmentIds(installedNode)]);
        slotEmptiedIds = baseIds.filter(id => !idsToRemove.has(id));
    }

    const comboRequest = {
        base_item_id:             EFTForge.state.currentGun.id,
        installed_ids:            slotEmptiedIds,
        root_slot_id:              rootSlotId,
        lang:                      _lang(),
        strength_level:            EFTForge.state.currentStrengthLevel ?? 10,
        equip_ergo_modifier:       EFTForge.state.currentEquipErgoModifier ?? 0,
        exclude_child_slot_names: isLeftQueueRoot
                                      ? _COMBO_ASSEMBLY_SLOT_NAMES.filter(n => n !== EFTForge.state.lastSlot?.slot_name) : [],
        exclude_item_ids:          EFTForge.config.COMBO_EXCLUDE_ITEM_IDS ?? [],
    };
    // Gun/tab switches clear the slot without necessarily starting another
    // combo request. Its old response must not populate that new context either.
    const isCurrentView = () => requestGen === _comboRequestGen
        && EFTForge.state.comboMode
        && EFTForge.state.buildTree === requestTree
        && EFTForge.state.lastSlot === requestSlot
        && EFTForge.state.lastParentNode === requestParent
        && EFTForge.state.currentGun?.id === comboRequest.base_item_id;
    const isCurrentRequest = () => isCurrentView() && _lang() === comboRequest.lang
        && (EFTForge.state.currentStrengthLevel ?? 10) === comboRequest.strength_level
        && (EFTForge.state.currentEquipErgoModifier ?? 0) === comboRequest.equip_ergo_modifier;
    const cacheKey = `combo__${JSON.stringify({
        base_item_id: comboRequest.base_item_id,
        root_slot_id: comboRequest.root_slot_id,
        installed_ids: comboRequest.installed_ids.slice().sort(),
        lang: comboRequest.lang,
        strength_level: comboRequest.strength_level,
        equip_ergo_modifier: comboRequest.equip_ergo_modifier,
        exclude_child_slot_names: comboRequest.exclude_child_slot_names.slice().sort(),
        exclude_item_ids: comboRequest.exclude_item_ids.slice().sort(),
    })}`;

    if (EFTForge.state.combosCache[cacheKey]) {
        const cachedCombo = EFTForge.state.combosCache[cacheKey];
        EFTForge.state.lastComboItems     = cachedCombo.items;
        EFTForge.state.lastComboWasCapped = !!cachedCombo.truncated;
        if (cachedCombo.truncated) {
            showToast(t("ui.comboTruncatedTitle"), t("ui.comboTruncatedMsg"), 8000, "#f5a623");
        }
        applyComboSort();
        return;
    }

    EFTForge.state.lastComboItems = [];
    EFTForge.state.lastComboWasCapped = false;
    const tbody = document.getElementById("attachment-body");
    if (tbody) {
        _clearMarqueeTimers();
        tbody.innerHTML = `<tr><td colspan="10" class="combo-status-row">
            <div class="combo-loading-main" id="combo-loading-main">${escapeHtml(t("ui.comboLoading"))}</div>
            <div class="combo-loading-progress" id="combo-loading-progress"></div>
        </td></tr>`;
    }

    // Animate the dots on the loading label
    let _loadingDots = 1;
    const _loadingBaseText = t("ui.comboLoading");
    const _dotsInterval = setInterval(() => {
        if (!isCurrentRequest()) return;
        const el = document.getElementById("combo-loading-main");
        if (el) el.textContent = _loadingBaseText + ".".repeat(_loadingDots);
        _loadingDots = _loadingDots >= 3 ? 1 : _loadingDots + 1;
    }, 500);

    _comboAbortController = new AbortController();
    _comboCalcInFlight = true;
    const signal = _comboAbortController.signal;

    let result;
    let processedCombos;
    try {
        result = await comboFull(comboRequest, signal, (ev) => {
            if (!isCurrentRequest()) return;
            const progressEl = document.getElementById("combo-loading-progress");
            if (!progressEl) return;
            const text = t(ev.capped ? "ui.comboProgressCapped" : "ui.comboProgress")
                .replace("{slot}",     ev.slot)
                .replace("{parent}",   ev.parent)
                .replace("{frontier}", ev.frontier)
                .replace("{cap}",      ev.cap);
            progressEl.textContent = text;
        });
        if (!isCurrentRequest()) {
            // A setting changed while receiving: refresh the same view with its
            // current inputs instead of leaving a finished loading row behind.
            if (isCurrentView()) return openComboView();
            return;
        }
        processedCombos = _prepareComboItems(result);
    } catch (err) {
        if (!isCurrentRequest()) {
            if (isCurrentView()) return openComboView();
            return;
        }
        if (err.name === "AbortError") return;
        console.error("Combo full failed:", err);
        if (tbody && EFTForge.state.comboMode) {
            tbody.innerHTML = `<tr><td colspan="10" class="combo-status-row combo-error">${escapeHtml(t("ui.comboError"))}</td></tr>`;
        }
        EFTForge.state.comboMode = false;
        _updateViewBtns();
        return;
    } finally {
        clearInterval(_dotsInterval);
        if (requestGen === _comboRequestGen) {
            _comboCalcInFlight = false;
            _comboAbortController = null;
        }
    }

    if (result.truncated) {
        showToast(t("ui.comboTruncatedTitle"), t("ui.comboTruncatedMsg"), 8000, "#f5a623");
    }

    EFTForge.state.combosCache[cacheKey] = {
        items: processedCombos,
        truncated: !!result.truncated,
        truncationReasons: result.truncation_reasons ?? [],
    };
    EFTForge.state.lastComboItems        = processedCombos;
    EFTForge.state.lastComboWasCapped    = !!result.truncated;

    applyComboSort();
}

function _prepareComboItems(result) {
    const compact = result.response_format === "items-v1";
    if ((result.response_format != null && result.response_format !== "legacy" && !compact)
        || !Array.isArray(result.combos)) {
        throw new Error("Invalid combo response format");
    }
    const resolveItem = id => {
        const item = result.items?.[id];
        if (!item || item.id !== id) throw new Error(`Missing combo item: ${id}`);
        return item;
    };
    // Prices depend on the current market/player settings. Memoize only within
    // this preparation, never across requests or settings changes.
    const metadata = new Map();
    const itemMeta = item => {
        let entry = metadata.get(item.id);
        if (!entry) {
            entry = { price: _getPriceRub(item), name: item.name.toLowerCase() };
            metadata.set(item.id, entry);
        }
        return entry;
    };

    const base       = result.base;
    const baseEED     = parseFloat(base.evo_ergo_delta ?? 0);
    const baseRecoilV = base.recoil_vertical ?? null;
    const baseErgo    = parseFloat(base.total_ergo ?? 0);
    const baseWeight  = parseFloat(base.total_weight ?? 0);

    return result.combos.map(combo => {
        const parent = compact ? resolveItem(combo.parent_item_id) : combo.parent_item;
        const children = compact ? combo.child_item_ids.map(resolveItem) : combo.child_items;
        const simEED     = parseFloat(combo.evo_ergo_delta ?? 0);
        const simErgo    = parseFloat(combo.total_ergo ?? 0);
        const simWeight  = parseFloat(combo.total_weight ?? 0);
        const simRecoilV = combo.recoil_vertical ?? null;
        const simRecoilH = combo.recoil_horizontal ?? null;
        const comboEEDDelta    = simEED - baseEED;
        const comboErgoDelta   = simErgo - baseErgo;
        const comboWeightDelta = simWeight - baseWeight;
        const comboRecoilPct   = parseFloat(parent.recoil_modifier ?? 0) * 100
            + children.reduce((s, ci) => s + parseFloat(ci.recoil_modifier ?? 0) * 100, 0);

        let totalPrice = 0; let hasPrice = false;
        let sortName = itemMeta(parent).name;
        for (const item of [parent, ...children]) {
            const p = itemMeta(item).price;
            if (p !== null) { totalPrice += p; hasPrice = true; }
        }
        for (const child of children) sortName += " " + itemMeta(child).name;
        const finalPrice = hasPrice ? totalPrice : null;

        // ₽/Recoil: rubles per 1% recoil reduction; null when no price or no recoil reduction
        const comboRublePerRecoil = (finalPrice !== null && comboRecoilPct < 0)
            ? finalPrice / Math.abs(comboRecoilPct)
            : null;

        return {
            parentEntry:                { item: parent, hasConflict: false,
                                          recoilPercent: parseFloat(parent.recoil_modifier ?? 0) * 100,
                                          sortName: itemMeta(parent).name },
            childItems:                 children,
            childSlotIds:               combo.child_slot_ids,
            childSlotParentItemIds:     combo.child_slot_parent_item_ids ?? [],
            allChildSlotIds:            combo.all_child_slot_ids,
            allNestedSlotIds:           combo.all_nested_slot_ids ?? combo.all_child_slot_ids,
            conflict:                   combo.conflict || null,
            sortName, simEED, simErgo, simWeight, simRecoilV, simRecoilH,
            comboEEDDelta, comboErgoDelta, comboWeightDelta, comboRecoilPct,
            totalPrice: finalPrice,
            comboRublePerRecoil,
        };
    });
}

function applyComboSort() {
    const items = EFTForge.state.lastComboItems;
    if (!items || !items.length) {
        if (_comboCalcInFlight) return;
        const { t } = EFTForge.lang;
        const tbody = document.getElementById("attachment-body");
        if (tbody) tbody.innerHTML = `<tr><td colspan="10" class="combo-status-row">${escapeHtml(t("ui.comboNone"))}</td></tr>`;
        return;
    }

    const query = EFTForge.state.currentSearchQuery;
    const { key: sortKey, direction: sortDir } = EFTForge.state.comboSort;
    const dir    = sortDir === "asc" ? 1 : -1;

    const isBuyable = item => {
        if (!item.trader_vendor || item.trader_price_rub == null) return false;
        return (EFTForge.state.traderLevels[item.trader_vendor] ?? 4) >= (item.trader_min_level ?? 1);
    };

    let sorted = query ? items.filter(e => e.sortName.includes(query)) : [...items];
    if (EFTForge.state.purchasableOnly)
        sorted = sorted.filter(e => isBuyable(e.parentEntry.item) && e.childItems.every(isBuyable));

    sorted.sort((a, b) => {
        let primary;
        switch (sortKey) {
            case "name":    primary = a.sortName < b.sortName ? -1 : a.sortName > b.sortName ? 1 : 0; break;
            case "recoil":  primary = a.comboRecoilPct - b.comboRecoilPct; break;
            case "ergo":    primary = a.comboErgoDelta - b.comboErgoDelta; break;
            case "evo":     primary = a.comboEEDDelta  - b.comboEEDDelta;  break;
            case "weight":  primary = a.comboWeightDelta - b.comboWeightDelta; break;
            case "price": {
                const ap = a.totalPrice; const bp = b.totalPrice;
                if (ap === null && bp === null) { primary = 0; break; }
                if (ap === null) return 1;
                if (bp === null) return -1;
                primary = ap - bp; break;
            }
            case "rub-recoil": {
                const ap = a.comboRublePerRecoil; const bp = b.comboRublePerRecoil;
                if (ap === null && bp === null) { primary = 0; break; }
                if (ap === null) return 1;
                if (bp === null) return -1;
                primary = ap - bp; break;
            }
            case "balance": {
                const w = EFTForge.state.comboErgoWeight / 100;
                const scoreA = (-a.comboRecoilPct * (1 - w)) + (a.comboErgoDelta * w);
                const scoreB = (-b.comboRecoilPct * (1 - w)) + (b.comboErgoDelta * w);
                primary = scoreA - scoreB; break;
            }
            default: primary = 0;
        }
        if (primary !== 0) return primary * dir;

        // Secondary: break ties by ergo delta (higher = better, so descending)
        const ergoDiff = b.comboErgoDelta - a.comboErgoDelta;
        if (ergoDiff !== 0) return ergoDiff;

        // Tertiary: alphabetical
        return a.sortName < b.sortName ? -1 : a.sortName > b.sortName ? 1 : 0;
    });

    updateSortIndicators();
    _renderComboRows(sorted);
    _updateComboColumnVisibility(sorted);
}

function _updateComboColumnVisibility(items) {
    const table = document.querySelector(".attachment-table");
    if (!table) return;

    let hasWeight = false, hasRecoil = false, hasErgo = false, hasEED = false, hasPrice = false;
    for (const entry of items) {
        hasEED ||= Math.abs(entry.comboEEDDelta) > 0.05;
        hasPrice ||= entry.totalPrice !== null;
        if (!hasWeight || !hasRecoil || !hasErgo) {
            for (const item of [entry.parentEntry.item, ...entry.childItems]) {
                hasWeight ||= parseFloat(item.weight ?? 0) !== 0;
                hasRecoil ||= item.recoil_modifier != null && item.recoil_modifier !== 0;
                hasErgo   ||= item.ergonomics_modifier != null && item.ergonomics_modifier !== 0;
                if (hasWeight && hasRecoil && hasErgo) break;
            }
        }
        if (hasWeight && hasRecoil && hasErgo && hasEED && hasPrice) break;
    }
    const hasEvo = hasErgo && hasEED;

    table.classList.toggle("hide-col-weight", !hasWeight);
    table.classList.toggle("hide-col-recoil", !hasRecoil);
    table.classList.add("hide-col-acc");
    table.classList.toggle("hide-col-ergo",   !hasErgo);
    table.classList.toggle("hide-col-evo",         !hasEvo);
    table.classList.toggle("hide-col-price",       !hasPrice);
    table.classList.toggle("hide-col-rub-recoil",  !(hasRecoil && hasPrice));
    table.classList.toggle("hide-col-balance",     !(hasRecoil && hasErgo));
    // Heat/cooling/durability-burn and velocity modifier are per-item stats with no combo aggregation - always hidden here
    table.classList.add("hide-col-heat");
    table.classList.add("hide-col-vel");
}

function _isComboInstalled(entry) {
    const { parentNode: rootParentNode, slotId: rootSlotId } = _findComboRootSlot();
    const installedNode = rootParentNode?.children?.[rootSlotId];
    if (!installedNode || String(installedNode.item.id) !== String(entry.parentEntry.item.id)) return false;

    // Build item-id -> node map for the full installed subtree
    const nodeById = {};
    function collectNodes(node) {
        nodeById[String(node.item.id)] = node;
        for (const child of Object.values(node.children || {})) collectNodes(child);
    }
    collectNodes(installedNode);

    const parentItemId = String(entry.parentEntry.item.id);

    // Check each combo slot has the right item under the right parent node
    for (let i = 0; i < entry.childSlotIds.length; i++) {
        const sid          = entry.childSlotIds[i];
        const expectedId   = String(entry.childItems[i].id);
        const ownerItemId  = String(entry.childSlotParentItemIds?.[i] ?? parentItemId);
        const ownerNode    = nodeById[ownerItemId];
        if (!ownerNode) return false;
        const actual = String(ownerNode.children[sid]?.item?.id ?? "");
        if (expectedId !== actual) return false;
    }

    // Check no slot that the combo explored has an extra item the combo left empty
    const knownSlotSet = new Set(entry.allNestedSlotIds ?? entry.allChildSlotIds ?? entry.childSlotIds);
    const comboSlotSet  = new Set(entry.childSlotIds);
    function checkNoExtra(node) {
        for (const sid of Object.keys(node.children || {})) {
            if (knownSlotSet.has(sid) && !comboSlotSet.has(sid)) return false;
        }
        for (const child of Object.values(node.children || {})) {
            if (!checkNoExtra(child)) return false;
        }
        return true;
    }
    return checkNoExtra(installedNode);
}

function _buildComboRow(entry) {
    const { parentEntry, childItems } = entry;
    const parentItem = parentEntry.item;

    const row = document.createElement("tr");
    row._comboEntry = entry;
    if (entry.conflict) {
        row.classList.add("conflict-row");
    } else if (_isComboInstalled(entry)) {
        row.classList.add("attachment-row-installed");
    }

    let iconAreaHtml;
    if (!childItems.length) {
        iconAreaHtml = `<div class="attachment-icon-wrapper">
            <img src="${escapeHtml(parentItem.icon_link)}" class="attachment-icon" loading="lazy" decoding="async" onerror="this.style.display='none'" />
            <div class="slot-shortname">${escapeHtml(parentItem.short_name)}</div>
        </div>`;
    } else {
        iconAreaHtml = `<div class="attachment-icon-wrapper ghost-combo-icon">
            <img src="${escapeHtml(parentItem.icon_link)}" class="attachment-icon" loading="lazy" decoding="async" onerror="this.style.display='none'" />
            <div class="slot-shortname">${escapeHtml(parentItem.short_name)}</div>
        </div>`;
        for (const ci of childItems) {
            iconAreaHtml += `<div class="ghost-combo-plus">+</div>
            <div class="attachment-icon-wrapper ghost-combo-icon">
                <img src="${escapeHtml(ci.icon_link)}" class="attachment-icon" loading="lazy" decoding="async" onerror="this.style.display='none'" />
                <div class="slot-shortname">${escapeHtml(ci.short_name)}</div>
            </div>`;
        }
    }

    const fmtSign = (v, d = 1) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;

    let priceCellHtml;
    if (!childItems.length) {
        priceCellHtml = _attPriceCellContent(parentItem);
    } else {
        const allItems = [parentItem, ...childItems];
        let total = 0; let valid = true;
        for (const it of allItems) { const p = _getPriceRub(it); if (p === null) { valid = false; break; } total += p; }
        priceCellHtml = valid
            ? `<div class="att-price-wrap"><span class="combo-price-sum">&#931;</span><span>${_formatPrice(total)}</span></div>`
            : `-`;
    }

    const ergoCls   = entry.comboErgoDelta >= 0 ? "ergo-positive" : "ergo-negative";
    const evoCls    = entry.comboEEDDelta  >= 0 ? "evo-positive" : "evo-negative";

    const rrCellHtml = entry.comboRublePerRecoil !== null
        ? `<div class="att-price-wrap"><span>${_formatPrice(Math.round(entry.comboRublePerRecoil))}</span></div>`
        : `-`;

    const bw = EFTForge.state.comboErgoWeight / 100;
    const balanceScore = (-entry.comboRecoilPct * (1 - bw)) + (entry.comboErgoDelta * bw);
    const balanceCls = balanceScore >= 0 ? "positive" : "negative";

    row.innerHTML = `
        <td class="name-cell combo-name-cell"><div class="combo-icon-scroll"><div class="combo-marquee">${iconAreaHtml}</div></div></td>
        <td>${priceCellHtml}</td>
        <td>${rrCellHtml}</td>
        <td>${fmtSign(entry.comboWeightDelta, 3)}</td>
        <td>${fmtSign(entry.comboRecoilPct)}%</td>
        <td class="acc-cell"></td>
        <td class="${ergoCls}">${entry.comboErgoDelta >= 0 ? "+" : ""}${formatStat(entry.comboErgoDelta)}</td>
        <td class="${evoCls}">${fmtSign(entry.comboEEDDelta)}</td>
        <td class="${balanceCls}">${fmtSign(balanceScore)}</td>
    `;

    const _iconScroll   = row.querySelector(".combo-icon-scroll");
    const _comboMarquee = _iconScroll?.querySelector(".combo-marquee");
    if (_iconScroll && _comboMarquee) {
        let _elGen = 0;
        const _sleep = ms => new Promise(r => setTimeout(r, ms));

        row.addEventListener("mouseenter", () => {
            _elGen++;
            const myGen = _elGen;
            requestAnimationFrame(async () => {
                if (_elGen !== myGen) return;
                const overflow = _comboMarquee.offsetWidth - _iconScroll.clientWidth;
                if (overflow <= 2) return;
                const dur = Math.max(1200, (overflow / 45) * 1000);

                async function runCycle() {
                    if (_elGen !== myGen) return;
                    _comboMarquee.style.transition = "none";
                    _comboMarquee.style.transform  = "translateX(0)";
                    _comboMarquee.style.opacity    = "1";

                    if (_elGen !== myGen) return;
                    _comboMarquee.style.transition = `transform ${dur}ms linear`;
                    _comboMarquee.style.transform  = `translateX(-${overflow}px)`;
                    await _sleep(dur);
                    if (_elGen !== myGen) return;

                    await _sleep(700);
                    if (_elGen !== myGen) return;

                    _comboMarquee.style.transition = "opacity 0.35s ease";
                    _comboMarquee.style.opacity    = "0";
                    await _sleep(400);
                    if (_elGen !== myGen) return;

                    _comboMarquee.style.transition = "none";
                    _comboMarquee.style.transform  = "translateX(0)";

                    await new Promise(resolve =>
                        requestAnimationFrame(() => requestAnimationFrame(resolve))
                    );
                    if (_elGen !== myGen) return;

                    _comboMarquee.style.transition = "opacity 0.35s ease";
                    _comboMarquee.style.opacity    = "1";

                    await _sleep(1500);
                    runCycle();
                }

                runCycle();
            });
        });

        row.addEventListener("mouseleave", () => {
            _elGen++;
            _comboMarquee.style.transition = "none";
            _comboMarquee.style.transform  = "translateX(0)";
            _comboMarquee.style.opacity    = "1";
        });
    }

    if (childItems.length > 0) {
        const allItems = [parentItem, ...childItems];
        let breakdownValid = true;
        const parts = allItems.map(it => {
            const p = _getPriceRub(it);
            if (p === null) breakdownValid = false;
            return { it, p };
        });
        if (breakdownValid) {
            const total = parts.reduce((s, x) => s + x.p, 0);
            const fleaCache = EFTForge.state.priceMode === "pve" ? EFTForge.state.fleaCachePve
        : EFTForge.state.priceMode === "pvpSeason" ? EFTForge.state.fleaCacheSeasonal
        : EFTForge.state.fleaCachePvp;
            const rows = parts.map(({ it, p }) => {
                const hasTrader = it.trader_vendor && it.trader_price_rub != null;
                const traderAvail = hasTrader &&
                    (EFTForge.state.traderLevels[it.trader_vendor] ?? 4) >= (it.trader_min_level ?? 1);
                const fleaPrice = fleaCache?.[it.id] ?? null;
                let vendorHtml;
                if (traderAvail && (fleaPrice === null || it.trader_price_rub <= fleaPrice)) {
                    const trader = EFTForge.state.tradersByNorm?.[it.trader_vendor];
                    const imgSrc = trader?.imageLink || "";
                    vendorHtml = imgSrc
                        ? `<img src="${escapeHtml(imgSrc)}" class="price-bd-vendor" onerror="this.style.display='none'" />`
                        : `<span class="price-bd-vendor-label">${escapeHtml(it.trader_vendor)}</span>`;
                } else {
                    const { t } = EFTForge.lang;
                    vendorHtml = `<span class="price-bd-flea">${escapeHtml(t("stats.fleaLabel"))}</span>`;
                }
                return `<div class="price-bd-row">` +
                    `<img src="${escapeHtml(it.icon_link)}" class="price-bd-icon" onerror="this.style.display='none'" />` +
                    `<span class="price-bd-name">${escapeHtml(it.short_name)}</span>` +
                    vendorHtml +
                    `<span class="price-bd-price">${_formatPrice(p)}</span>` +
                    `</div>`;
            }).join("");
            const html = `<div class="price-bd">${rows}<div class="price-bd-total"><span>&#931;</span><span>${_formatPrice(total)}</span></div></div>`;
            row.children[1].dataset.tooltipHtml = html;
        }
    }

    row.addEventListener("mouseenter", () => {
        if (!_statBarEls || !_statBarEls.ergoFill?.isConnected) _cacheStatBarEls();
        if (!_statBarEls) return;
        const { ergoFill, ergoVal, rvFill, rvVal, rhFill, rhVal } = _statBarEls;
        const refErgo    = EFTForge.state.lastTotalErgo;
        const refRecoilV = EFTForge.state.lastRecoilV;
        const refRecoilH = EFTForge.state.lastRecoilH;

        const ergoDelta = entry.simErgo - refErgo;
        if (ergoFill) {
            ergoFill.style.width = Math.min(refErgo, 100) + "%";
            let dEl = ergoFill.parentElement.querySelector(".delta-bar");
            if (!dEl) { dEl = document.createElement("div"); dEl.className = "delta-bar"; ergoFill.parentElement.appendChild(dEl); }
            if (ergoDelta !== 0) {
                const base = Math.min(refErgo, 100); const sim = Math.min(refErgo + ergoDelta, 100);
                dEl.style.left = Math.min(base, sim) + "%"; dEl.style.width = Math.abs(sim - base) + "%";
                dEl.style.background = ergoDelta >= 0 ? "#4CAF50" : "#f44336";
                dEl.style.borderRadius = ergoDelta >= 0 ? "0 3px 3px 0" : "3px";
                dEl.style.transformOrigin = ergoDelta >= 0 ? "left" : "right";
                dEl.style.display = ""; _animateDeltaBarIn(dEl);
            } else { _animateDeltaBarOut(dEl); }
        }
        if (ergoVal) { const dt = ergoDelta !== 0 ? ` <span style="color:${ergoDelta >= 0 ? "#4CAF50" : "#f44336"}">(${ergoDelta > 0 ? "+" : ""}${formatStat(ergoDelta)})</span>` : ""; ergoVal.innerHTML = `<span style="color:#eee">${formatStat(refErgo)}</span>${dt}`; }

        if (entry.simRecoilV !== null && refRecoilV !== null && rvFill) {
            const rvBase = Math.min(refRecoilV, 500) / 5; const rvDelta = entry.simRecoilV - refRecoilV;
            const rvSim  = Math.min(Math.max(refRecoilV + rvDelta, 0), 500) / 5;
            rvFill.style.width = rvBase + "%";
            let dEl = rvFill.parentElement.querySelector(".delta-bar");
            if (!dEl) { dEl = document.createElement("div"); dEl.className = "delta-bar"; rvFill.parentElement.appendChild(dEl); }
            if (rvDelta !== 0) {
                dEl.style.left = Math.min(rvBase, rvSim) + "%"; dEl.style.width = Math.abs(rvSim - rvBase) + "%";
                dEl.style.background = rvDelta <= 0 ? "#4CAF50" : "#f44336";
                dEl.style.borderRadius = rvDelta > 0 ? "0 3px 3px 0" : "3px";
                dEl.style.transformOrigin = rvDelta > 0 ? "left" : "right";
                dEl.style.display = ""; _animateDeltaBarIn(dEl);
            } else { _animateDeltaBarOut(dEl); }
            if (rvVal) { const dt = rvDelta !== 0 ? ` <span style="color:${rvDelta <= 0 ? "#4CAF50" : "#f44336"}">(${rvDelta > 0 ? "+" : ""}${Math.round(rvDelta)})</span>` : ""; rvVal.innerHTML = `<span style="color:#eee">${Math.round(refRecoilV)}</span>${dt}`; }
        }

        if (entry.simRecoilH !== null && refRecoilH !== null && rhFill) {
            const rhBase = Math.min(refRecoilH, 500) / 5; const rhDelta = entry.simRecoilH - refRecoilH;
            const rhSim  = Math.min(Math.max(refRecoilH + rhDelta, 0), 500) / 5;
            rhFill.style.width = rhBase + "%";
            let dEl = rhFill.parentElement.querySelector(".delta-bar");
            if (!dEl) { dEl = document.createElement("div"); dEl.className = "delta-bar"; rhFill.parentElement.appendChild(dEl); }
            if (rhDelta !== 0) {
                dEl.style.left = Math.min(rhBase, rhSim) + "%"; dEl.style.width = Math.abs(rhSim - rhBase) + "%";
                dEl.style.background = rhDelta <= 0 ? "#4CAF50" : "#f44336";
                dEl.style.borderRadius = rhDelta > 0 ? "0 3px 3px 0" : "3px";
                dEl.style.transformOrigin = rhDelta > 0 ? "left" : "right";
                dEl.style.display = ""; _animateDeltaBarIn(dEl);
            } else { _animateDeltaBarOut(dEl); }
            if (rhVal) { const dt = rhDelta !== 0 ? ` <span style="color:${rhDelta <= 0 ? "#4CAF50" : "#f44336"}">(${rhDelta > 0 ? "+" : ""}${Math.round(rhDelta)})</span>` : ""; rhVal.innerHTML = `<span style="color:#eee">${Math.round(refRecoilH)}</span>${dt}`; }
        }

        let displayWeight = entry.simWeight;
        let displayEED    = entry.simEED;
        if (EFTForge.state.assumeFullMag) {
            // Find which magazine would be loaded after installing the combo
            let magCap = entry.parentEntry.item.magazine_capacity > 0
                ? entry.parentEntry.item.magazine_capacity
                : (entry.childItems.find(ci => ci.magazine_capacity > 0)?.magazine_capacity ?? null);
            // If combo doesn't include a magazine, find the currently installed one
            if (magCap == null && EFTForge.state.buildTree) {
                const stack = [EFTForge.state.buildTree];
                outer: while (stack.length) {
                    const node = stack.pop();
                    for (const id in node.children) {
                        const child = node.children[id];
                        if (child.item?.magazine_capacity > 0) { magCap = child.item.magazine_capacity; break outer; }
                        stack.push(child);
                    }
                }
            }
            if (magCap != null) {
                const ammoSelect = document.getElementById("ammo-select");
                const ammoWeightPerRound = EFTForge.state.ammoWeightMap?.[ammoSelect?.value] ?? 0;
                displayWeight += ammoWeightPerRound * magCap;
                displayEED    -= 15 * ammoWeightPerRound * magCap;
            }
        }
        _setExtraStats(displayWeight, displayEED);
    });

    row.addEventListener("mouseleave", () => {
        if (!_statBarEls || !_statBarEls.ergoFill?.isConnected) _cacheStatBarEls();
        [_statBarEls?.ergoFill, _statBarEls?.rvFill, _statBarEls?.rhFill, _statBarEls?.accFill].forEach(fill => {
            if (!fill) return;
            const dEl = fill.parentElement.querySelector(".delta-bar");
            if (dEl) _animateDeltaBarOut(dEl);
        });
        _restoreStatBarsToCurrent();
    });

    row.addEventListener("click", async () => {
        if (entry.conflict) {
            const { t } = EFTForge.lang;
            const conflictText = t(entry.conflict.reason_key) + (entry.conflict.reason_name ?? "");
            replaceToast("attachment-conflict", t("toast.attachmentConflict"), `${parentItem.name}\n${conflictText}`);
            if (EFTForge.state.gridView) {
                const conflictsWithGun = entry.conflict.conflicting_item_id === EFTForge.state.currentGun?.id;
                if (conflictsWithGun) {
                    flashGunCellInGrid();
                } else {
                    if (entry.conflict.conflicting_item_id) flashConflictInGrid(entry.conflict.conflicting_item_id);
                    if (entry.conflict.conflicting_slot_id) flashConflictSlotInGrid(entry.conflict.conflicting_slot_id);
                }
            } else {
                if (entry.conflict.conflicting_item_id) flashConflictInTree(EFTForge.state.buildTree, entry.conflict.conflicting_item_id);
                if (entry.conflict.conflicting_slot_id) flashConflictSlotInTree(entry.conflict.conflicting_slot_id);
            }
            return;
        }

        if (_isComboInstalled(entry)) return;

        const { parentNode: rootParentNode, slotId: rootSlotId } = _findComboRootSlot();
        if (!rootParentNode || !rootSlotId) return;

        rootParentNode.children[rootSlotId] = { item: parentItem, children: {} };
        const newNode = rootParentNode.children[rootSlotId];
        const _nodeByItemId = { [String(parentItem.id)]: newNode };
        for (let i = 0; i < entry.childItems.length; i++) {
            const ci          = entry.childItems[i];
            const slotId      = entry.childSlotIds[i];
            const ownerItemId = String(entry.childSlotParentItemIds?.[i] ?? parentItem.id);
            const ownerNode   = _nodeByItemId[ownerItemId] ?? newNode;
            ownerNode.children[slotId] = { item: ci, children: {} };
            _nodeByItemId[String(ci.id)] = ownerNode.children[slotId];
        }

        EFTForge.state.processedCache = {};
        EFTForge.state.combosCache    = {};

        refreshBuildStats();
        _refreshComboHighlights();
        await renderFullTree(true);
        flashSlot(rootParentNode, rootSlotId, "install");
        for (let i = 0; i < entry.childItems.length; i++) {
            const ownerItemId = String(entry.childSlotParentItemIds?.[i] ?? parentItem.id);
            const ownerNode   = _nodeByItemId[ownerItemId] ?? newNode;
            flashSlot(ownerNode, entry.childSlotIds[i], "install");
        }
        if (typeof updateAttTableHeaderImg === "function") updateAttTableHeaderImg();
    });

    return row;
}

function _renderNextComboBatch(tbody) {
    const sentinel = tbody.querySelector(".combo-load-sentinel");
    const fragment = document.createDocumentFragment();
    const end = Math.min(_comboLazyRendered + _COMBO_BATCH_SIZE, _comboLazyItems.length);
    for (let i = _comboLazyRendered; i < end; i++) {
        fragment.appendChild(_buildComboRow(_comboLazyItems[i]));
    }
    _comboLazyRendered = end;
    if (sentinel) tbody.insertBefore(fragment, sentinel);
    else tbody.appendChild(fragment);
    if (_comboSpacer) {
        const remaining = _comboLazyItems.length - _comboLazyRendered;
        _comboSpacer.firstElementChild.style.height = remaining > 0 ? `${remaining * _comboRowHeight}px` : "0";
    }
}

function _refreshComboHighlights() {
    const tbody = document.getElementById("attachment-body");
    if (!tbody) return;
    tbody.querySelectorAll("tr").forEach(tr => {
        const entry = tr._comboEntry;
        if (!entry) return;
        tr.classList.toggle("conflict-row", !!entry.conflict);
        tr.classList.toggle("attachment-row-installed", !entry.conflict && _isComboInstalled(entry));
    });
}

function _renderComboRows(items) {
    _disconnectComboObserver();
    _clearMarqueeTimers();
    _statBarEls = null;
    _comboLazyItems    = items;
    _comboLazyRendered = 0;

    const tbody = document.getElementById("attachment-body");
    tbody.innerHTML = "";

    _renderNextComboBatch(tbody);

    if (_comboLazyRendered < _comboLazyItems.length) {
        // Measure actual row height so the spacer accurately represents the full list
        const sampleRow = tbody.querySelector("tr");
        _comboRowHeight = (sampleRow && sampleRow.getBoundingClientRect().height > 0)
            ? sampleRow.getBoundingClientRect().height : 52;

        const sentinel = document.createElement("tr");
        sentinel.className = "combo-load-sentinel";
        sentinel.innerHTML = `<td colspan="10"></td>`;
        tbody.appendChild(sentinel);

        // Spacer reserves height for unrendered rows so the scrollbar shows the full size upfront
        _comboSpacer = document.createElement("tr");
        _comboSpacer.className = "combo-spacer";
        const spacerTd = document.createElement("td");
        spacerTd.colSpan = 10;
        spacerTd.style.padding = "0";
        spacerTd.style.height = `${(_comboLazyItems.length - _comboLazyRendered) * _comboRowHeight}px`;
        _comboSpacer.appendChild(spacerTd);
        tbody.appendChild(_comboSpacer);

        const scrollRoot = document.querySelector(".right-panel");
        const myLoadGen  = ++_comboLoadGen;

        function _tryRenderMore() {
            if (_comboLoadGen !== myLoadGen) return;
            if (_comboLazyRendered >= _comboLazyItems.length) {
                const s = tbody.querySelector(".combo-load-sentinel");
                if (s) s.remove();
                if (_comboSpacer) { _comboSpacer.remove(); _comboSpacer = null; }
                _disconnectComboObserver();
                _initMarqueeText(tbody, { hoverOnly: !isMobileLayout() });
                _cacheStatBarEls();
                return;
            }
            const thisSentinel = tbody.querySelector(".combo-load-sentinel");
            if (!thisSentinel || !scrollRoot) return;
            const sentinelTop = thisSentinel.getBoundingClientRect().top;
            const rootBottom  = scrollRoot.getBoundingClientRect().bottom;
            if (sentinelTop > rootBottom + 400) return;
            _renderNextComboBatch(tbody);
            requestAnimationFrame(_tryRenderMore);
        }

        _comboScrollListener = _tryRenderMore;
        scrollRoot.addEventListener("scroll", _comboScrollListener, { passive: true });
        requestAnimationFrame(_tryRenderMore);
    }

    _initMarqueeText(tbody, { hoverOnly: !isMobileLayout() });
    _cacheStatBarEls();
}

(function _initHeaderPinListener() {
    const scrollRoot = document.querySelector(".right-panel");
    if (!scrollRoot) return;
    scrollRoot.addEventListener("scroll", () => {
        const table = document.querySelector(".attachment-table");
        if (table) table.classList.toggle("header-pinned", scrollRoot.scrollTop > 10);
    }, { passive: true });
    setupEdgePanScroll(scrollRoot);
}());
