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

// Cached references to the stat bar DOM elements (stable while panel is open)
let _statBarEls = null;

function _cacheStatBarEls() {
    const rows = document.querySelectorAll(".stat-bar-row");
    if (rows.length < 3) { _statBarEls = null; return; }
    _statBarEls = {
        ergoFill: rows[0].querySelector(".stat-bar-fill"),
        ergoVal:  rows[0].querySelector(".stat-bar-track .stat-bar-value"),
        rvFill:   rows[1].querySelector(".stat-bar-fill"),
        rvVal:    rows[1].querySelector(".stat-bar-track .stat-bar-value"),
        rhFill:   rows[2].querySelector(".stat-bar-fill"),
        rhVal:    rows[2].querySelector(".stat-bar-track .stat-bar-value"),
    };
}

async function openSlotSelector(parentNode, slot) {

    // If this slot is already open, do nothing
    if (EFTForge.state.lastParentNode === parentNode && EFTForge.state.lastSlot && EFTForge.state.lastSlot.id === slot.id) {
        return;
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

  box.innerHTML = `
        <div class="att-table-header">
            ${gunImg ? `<img class="att-table-gun-img" src="${escapeHtml(gunImg)}" alt="" />` : ""}
            <h3>${t("ui.selectAttFor")}<strong>${escapeHtml(tSlot(slot.slot_name))}</strong></h3>
        </div>

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

  const baseAttachmentIds = collectAttachmentIds(EFTForge.state.buildTree);

  // Build the slot-emptied ID list: current build minus the replaced subtree — O(n) with filter
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

// Helper: animate a delta bar in using double-rAF to avoid forced reflow
function _animateDeltaBarIn(deltaEl) {
    deltaEl.style.transform = "scaleX(0)";
    deltaEl.style.opacity = "0";
    requestAnimationFrame(() => requestAnimationFrame(() => {
        deltaEl.style.transform = "scaleX(1)";
        deltaEl.style.opacity = "1";
    }));
}

function _animateDeltaBarOut(deltaEl) {
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

  // Build all rows into a DocumentFragment — single reflow on append
  const fragment = document.createDocumentFragment();

  for (const entry of items) {

    const { item, contribution, recoilPercent, ergoModifier } = entry;

    const row = document.createElement("tr");

    if (entry.hasConflict) {
        row.classList.add("conflict-row");
    }

    if (installedId && String(installedId) === String(item.id)) {
        row.classList.add("attachment-row-installed");
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

                <div class="attachment-name-text"><span class="marquee-text">${escapeHtml(item.name)}</span></div>

            </div>
        </td>

        <td>${parseFloat(item.weight ?? 0).toFixed(3)}</td>

        <td>${formatStat(recoilPercent)}%</td>

        <td class="${ergoModifier >= 0 ? "ergo-positive" : "ergo-negative"}">
            ${ergoModifier >= 0 ? "+" : ""}${formatStat(ergoModifier)}
        </td>

        <td class="${contribution >= 0 ? "positive" : "negative"}">
            ${contribution >= 0 ? "+" : ""}${contribution.toFixed(1)}
        </td>
    `;

    row.addEventListener("mouseenter", () => {
        if (entry.hasConflict) return;
        // Re-cache if the stats panel was rebuilt (e.g. after an install)
        if (!_statBarEls || !_statBarEls.ergoFill?.isConnected) _cacheStatBarEls();
        if (!_statBarEls) return;

        const { ergoFill, ergoVal, rvFill, rvVal, rhFill, rhVal } = _statBarEls;

        const installedSimErgo = EFTForge.state.lastTotalErgo;
        const installedSimRecoilV = EFTForge.state.lastRecoilV;
        const installedSimRecoilH = EFTForge.state.lastRecoilH;

        // Ergo bar
        const ergoDelta = entry.simErgo - installedSimErgo;
        const ergoBaseWidth = Math.min(EFTForge.state.lastTotalErgo, 100);
        const ergoSimWidth = Math.min(EFTForge.state.lastTotalErgo + ergoDelta, 100);

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
            ergoVal.innerHTML = `<span style="color:#eee">${formatStat(EFTForge.state.lastTotalErgo)}</span>${deltaText}`;
        }

        // Ver. Recoil bar
        if (entry.simRecoilV !== null && installedSimRecoilV !== null && rvFill) {
            const rvBase = Math.min(EFTForge.state.lastRecoilV, 500) / 5;
            const rvDelta = entry.simRecoilV - installedSimRecoilV;
            const rvSim = Math.min(Math.max(EFTForge.state.lastRecoilV + rvDelta, 0), 500) / 5;
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
                rvVal.innerHTML = `<span style="color:#eee">${Math.round(EFTForge.state.lastRecoilV)}</span>${deltaText}`;
            }
        }

        // Hor. Recoil bar
        if (entry.simRecoilH !== null && installedSimRecoilH !== null && rhFill) {
            const rhBase = Math.min(EFTForge.state.lastRecoilH, 500) / 5;
            const rhDelta = entry.simRecoilH - installedSimRecoilH;
            const rhSim = Math.min(Math.max(EFTForge.state.lastRecoilH + rhDelta, 0), 500) / 5;
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
                rhVal.innerHTML = `<span style="color:#eee">${Math.round(EFTForge.state.lastRecoilH)}</span>${deltaText}`;
            }
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

        // Reset value text
        if (ergoVal) ergoVal.textContent = formatStat(EFTForge.state.lastTotalErgo);
        if (rvVal) rvVal.textContent = EFTForge.state.lastRecoilV !== null ? Math.round(EFTForge.state.lastRecoilV) : "—";
        if (rhVal) rhVal.textContent = EFTForge.state.lastRecoilH !== null ? Math.round(EFTForge.state.lastRecoilH) : "—";
    });

    // Long-press to remove (touch devices — mirrors right-click behaviour)
    let _longPressTimer = null;
    let _longPressFired = false;

    row.addEventListener("touchstart", () => {
        _longPressFired = false;
        _longPressTimer = setTimeout(() => {
            _longPressFired = true;
            _longPressTimer = null;
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
  _initMarqueeText(tbody);
  _cacheStatBarEls();
}
