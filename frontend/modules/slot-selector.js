window.EFTForge = window.EFTForge || {};

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

    EFTForge.state.currentSearchQuery = "";

  const box = document.getElementById("attachment-table-container");

  const { t, tSlot } = EFTForge.lang;

  box.innerHTML = `
        <h3>${t("ui.selectAttFor")}${escapeHtml(tSlot(slot.slot_name))}</h3>

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
          items = await fetchSlotAllowedItems(slot.id);
          cacheSet(EFTForge.state.allowedCache, slot.id, items);
      } catch (err) {
          stopPanelLoading(slotOverlay);
          console.error("Failed to load allowed items:", err);
          showToast(t("toast.connectionError"), t("toast.attachListFailed"), 5000);
          return;
      }
  }

  const baseAttachmentIds = collectAttachmentIds(EFTForge.state.buildTree);

  // Build the slot-emptied ID list once — same baseline for every candidate
  const slotEmptiedIds = [...baseAttachmentIds];
  if (parentNode.children[slot.id]) {
      const installedNode = parentNode.children[slot.id];
      const idsToRemove = new Set([
          installedNode.item.id,
          ...collectAttachmentIds(installedNode)
      ]);
      for (let i = slotEmptiedIds.length - 1; i >= 0; i--) {
          if (idsToRemove.has(slotEmptiedIds[i])) {
              slotEmptiedIds.splice(i, 1);
          }
      }
  }

  // Cache key: slot ID + current build state so cache invalidates when build changes
  const cacheKey = `${slot.id}__${slotEmptiedIds.sort().join(",")}`;

  if (EFTForge.state.processedCache[cacheKey]) {
      EFTForge.state.lastProcessedItems = EFTForge.state.processedCache[cacheKey];
      EFTForge.state.lastParentNode = parentNode;
      EFTForge.state.lastSlot = slot;
      applyAttachmentSort();
      stopPanelLoading(slotOverlay);
      return;
  }

  // EED of the build with this slot empty — the baseline every candidate is measured against
  let baseData;
  try {
      baseData = await calculateBuild({
          base_item_id: EFTForge.state.currentGun.id,
          attachment_ids: slotEmptiedIds
      });
  } catch (err) {
      stopPanelLoading(slotOverlay);
      console.error("Failed to calculate base stats:", err);
      showToast(t("toast.connectionError"), t("toast.serverUnreachable"), 5000);
      return;
  }
  const baseEED = parseFloat(baseData.evo_ergo_delta ?? 0);
  const baseRecoilV = baseData.recoil_vertical ?? null;
  const baseRecoilH = baseData.recoil_horizontal ?? null;
  const baseErgo = parseFloat(baseData.total_ergo ?? 0);

  // Sum weights of the installed subtree being replaced
  let removedSubtreeWeight = 0;
  if (parentNode.children[slot.id]) {
      const removedNode = parentNode.children[slot.id];
      const collectWeights = (node) => {
          removedSubtreeWeight += node.item.weight || 0;
          for (const sid in node.children) collectWeights(node.children[sid]);
      };
      collectWeights(removedNode);
  }
  const currentBuildBaseWeight = parseFloat(baseData.total_weight ?? 0) + removedSubtreeWeight;

  // Fire all validation and EED requests in parallel instead of sequentially
  let processedItems;
  try {
  processedItems = await Promise.all(items.map(async (item) => {

      const [validationData, simData] = await Promise.all([
          validateBuild({
              base_item_id: EFTForge.state.currentGun.id,
              installed_ids: slotEmptiedIds,
              slot_id: slot.id,
              candidate_id: item.id,
              lang: _lang()
          }),
          calculateBuild({
              base_item_id: EFTForge.state.currentGun.id,
              attachment_ids: [...slotEmptiedIds, item.id]
          })
      ]);

      const hasConflict = !validationData.valid;
      const conflictName = validationData.reason_key
          ? t(validationData.reason_key) + (validationData.reason_name ?? "")
          : null;
      const contribution = parseFloat(simData.evo_ergo_delta ?? 0) - baseEED;
      const recoilPercent = parseFloat(item.recoil_modifier ?? 0) * 100;

      return {
          item,
          contribution,
          recoilPercent,
          ergoModifier: parseFloat(item.ergonomics_modifier ?? 0),
          hasConflict,
          conflictName,
          conflictingItemId: validationData.conflicting_item_id ?? null,
          conflictingSlotId: validationData.conflicting_slot_id ?? null,
          simErgo: parseFloat(simData.total_ergo ?? 0),
          simRecoilV: simData.recoil_vertical ?? null,
          simRecoilH: simData.recoil_horizontal ?? null,
          simWeight: parseFloat(simData.total_weight ?? 0),
          simEED: parseFloat(simData.evo_ergo_delta ?? 0),
          baseErgo,
          baseRecoilV,
          baseRecoilH,
          baseWeight: currentBuildBaseWeight,
          baseEED,
      };
  }));
  } catch (err) {
      stopPanelLoading(slotOverlay);
      console.error("Failed to process attachments:", err);
      showToast(t("toast.connectionError"), t("toast.attachDataFailed"), 5000);
      return;
  }

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
}

function applyAttachmentSearch(query) {
    EFTForge.state.currentSearchQuery = query.toLowerCase();
    applyAttachmentSort();
}

function applyAttachmentSort() {
  const dir = EFTForge.state.attachmentSort.direction === "asc" ? 1 : -1;

  const itemsToRender = EFTForge.state.currentSearchQuery
      ? EFTForge.state.lastProcessedItems.filter(entry =>
          entry.item.name.toLowerCase().includes(EFTForge.state.currentSearchQuery)
        )
      : EFTForge.state.lastProcessedItems;

  itemsToRender.sort((a, b) => {

    // ---------- PRIMARY SORT ----------
    let primary;

    switch (EFTForge.state.attachmentSort.key) {
        case "name":
            primary = a.item.name.localeCompare(b.item.name);
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
    return a.item.name.localeCompare(b.item.name);
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

function renderAttachmentRows(items) {

  _clearMarqueeTimers();

  const tbody = document.getElementById("attachment-body");
  tbody.innerHTML = "";

  for (const entry of items) {

    const { item, contribution, recoilPercent, ergoModifier } = entry;

    const installedId =
        EFTForge.state.lastParentNode?.children?.[EFTForge.state.lastSlot.id]?.item?.id;

    const row = document.createElement("tr");

    if (entry.hasConflict) {
        row.classList.add("conflict-row");
    }

    if (
        installedId &&
        String(installedId) === String(item.id)
    ) {
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

        <td>${
            Math.abs(recoilPercent - Math.round(recoilPercent)) < 0.001
                ? Math.round(recoilPercent)
                : recoilPercent.toFixed(1)
        }%</td>

        <td class="${ergoModifier >= 0 ? "ergo-positive" : "ergo-negative"}">
            ${
                ergoModifier >= 0 ? "+" : ""
            }${
                Math.abs(ergoModifier - Math.round(ergoModifier)) < 0.001
                    ? Math.round(ergoModifier)
                    : ergoModifier.toFixed(1)
            }
        </td>

        <td class="${contribution >= 0 ? "positive" : "negative"}">
            ${contribution >= 0 ? "+" : ""}${contribution.toFixed(1)}
        </td>
    `;

    row.addEventListener("mouseenter", () => {
        if (entry.hasConflict) return;

        const statBarRows = document.querySelectorAll(".stat-bar-row");
        if (statBarRows.length < 3) return;

        const installedId = EFTForge.state.lastParentNode?.children?.[EFTForge.state.lastSlot?.id]?.item?.id;
        const installedEntry = installedId
            ? EFTForge.state.lastProcessedItems.find(e => e.item.id === installedId)
            : null;

        const installedSimErgo = EFTForge.state.lastTotalErgo;
        const installedSimRecoilV = EFTForge.state.lastRecoilV;
        const installedSimRecoilH = EFTForge.state.lastRecoilH;

        // Ergo
        const ergoFill = statBarRows[0].querySelector(".stat-bar-fill");
        const ergoVal = statBarRows[0].querySelector(".stat-bar-track .stat-bar-value");
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
                deltaEl.style.position = "absolute";
                deltaEl.style.left = Math.min(ergoBaseWidth, ergoSimWidth) + "%";
                deltaEl.style.width = Math.abs(ergoSimWidth - ergoBaseWidth) + "%";
                deltaEl.style.height = "100%";
                deltaEl.style.background = ergoDelta >= 0 ? "#4CAF50" : "#f44336";
                deltaEl.style.borderRadius = ergoDelta >= 0 ? "0 3px 3px 0" : "3px";
                deltaEl.style.display = "";
            } else {
                deltaEl.style.display = "none";
            }
        }
        if (ergoVal) {
            const deltaText = ergoDelta !== 0
                ? ` <span style="color:${ergoDelta >= 0 ? "#4CAF50" : "#f44336"}">(${ergoDelta > 0 ? "+" : ""}${Math.abs(ergoDelta - Math.round(ergoDelta)) < 0.001 ? Math.round(ergoDelta) : ergoDelta.toFixed(1)})</span>`
                : "";
            ergoVal.innerHTML = `<span style="color:#eee">${Math.abs(EFTForge.state.lastTotalErgo - Math.round(EFTForge.state.lastTotalErgo)) < 0.001 ? Math.round(EFTForge.state.lastTotalErgo) : EFTForge.state.lastTotalErgo.toFixed(1)}</span>${deltaText}`;
        }

        // Ver. Recoil
        const rvFill = statBarRows[1].querySelector(".stat-bar-fill");
        const recoilVVal = statBarRows[1].querySelector(".stat-bar-track .stat-bar-value");
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
                deltaEl.style.position = "absolute";
                deltaEl.style.left = Math.min(rvBase, rvSim) + "%";
                deltaEl.style.width = Math.abs(rvSim - rvBase) + "%";
                deltaEl.style.height = "100%";
                deltaEl.style.background = rvDelta <= 0 ? "#4CAF50" : "#f44336";
                deltaEl.style.borderRadius = rvDelta > 0 ? "0 3px 3px 0" : "3px";
                deltaEl.style.display = "";
            } else {
                deltaEl.style.display = "none";
            }
            if (recoilVVal) {
                const deltaText = rvDelta !== 0
                    ? ` <span style="color:${rvDelta <= 0 ? "#4CAF50" : "#f44336"}">(${rvDelta > 0 ? "+" : ""}${Math.round(rvDelta)})</span>`
                    : "";
                recoilVVal.innerHTML = `<span style="color:#eee">${Math.round(EFTForge.state.lastRecoilV)}</span>${deltaText}`;
            }
        }

        // Hor. Recoil
        const rhFill = statBarRows[2].querySelector(".stat-bar-fill");
        const recoilHVal = statBarRows[2].querySelector(".stat-bar-track .stat-bar-value");
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
                deltaEl.style.position = "absolute";
                deltaEl.style.left = Math.min(rhBase, rhSim) + "%";
                deltaEl.style.width = Math.abs(rhSim - rhBase) + "%";
                deltaEl.style.height = "100%";
                deltaEl.style.background = rhDelta <= 0 ? "#4CAF50" : "#f44336";
                deltaEl.style.borderRadius = rhDelta > 0 ? "0 3px 3px 0" : "3px";
                deltaEl.style.display = "";
            } else {
                deltaEl.style.display = "none";
            }
            if (recoilHVal) {
                const deltaText = rhDelta !== 0
                    ? ` <span style="color:${rhDelta <= 0 ? "#4CAF50" : "#f44336"}">(${rhDelta > 0 ? "+" : ""}${Math.round(rhDelta)})</span>`
                    : "";
                recoilHVal.innerHTML = `<span style="color:#eee">${Math.round(EFTForge.state.lastRecoilH)}</span>${deltaText}`;
            }
        }
    });

    row.addEventListener("mouseleave", () => {
        const statBarRows = document.querySelectorAll(".stat-bar-row");
        if (statBarRows.length < 3) return;

        // Ergo
        const ergoTrack = statBarRows[0].querySelector(".stat-bar-track");
        if (ergoTrack) {
            ergoTrack.innerHTML = `
                <div class="stat-bar-fill ergo-bar" style="width:${Math.min(EFTForge.state.lastTotalErgo, 100)}%;"></div>
                <div class="stat-bar-value">${Math.abs(EFTForge.state.lastTotalErgo - Math.round(EFTForge.state.lastTotalErgo)) < 0.001 ? Math.round(EFTForge.state.lastTotalErgo) : EFTForge.state.lastTotalErgo.toFixed(1)}</div>
            `;
        }

        // Ver. Recoil
        const recoilVTrack = statBarRows[1].querySelector(".stat-bar-track");
        if (recoilVTrack) {
            recoilVTrack.innerHTML = `
                <div class="stat-bar-fill recoil-bar" style="width:${EFTForge.state.lastRecoilV !== null ? Math.min(EFTForge.state.lastRecoilV, 500) / 5 : 0}%;"></div>
                <div class="stat-bar-value">${EFTForge.state.lastRecoilV !== null ? Math.round(EFTForge.state.lastRecoilV) : "—"}</div>
            `;
        }

        // Hor. Recoil
        const recoilHTrack = statBarRows[2].querySelector(".stat-bar-track");
        if (recoilHTrack) {
            recoilHTrack.innerHTML = `
                <div class="stat-bar-fill recoil-bar" style="width:${EFTForge.state.lastRecoilH !== null ? Math.min(EFTForge.state.lastRecoilH, 500) / 5 : 0}%;"></div>
                <div class="stat-bar-value">${EFTForge.state.lastRecoilH !== null ? Math.round(EFTForge.state.lastRecoilH) : "—"}</div>
            `;
        }
    });

    row.addEventListener("click", () => {

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

    tbody.appendChild(row);
  }

  _initMarqueeText(tbody);
}
