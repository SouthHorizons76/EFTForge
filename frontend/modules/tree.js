window.EFTForge = window.EFTForge || {};

/* exported updateSlotIcon, flashTree, flashConflictInTree, flashConflictSlotInTree, installAttachment,
   collectAttachmentIds, undoBuildAction, redoBuildAction -- called from other modules or index.html attributes */

let _publishLockedToastTs = 0;
function _showPublishLockedToast() {
    const now = Date.now();
    if (now - _publishLockedToastTs < 2500) return;
    _publishLockedToastTs = now;
    const { t } = EFTForge.lang;
    showToast(t("publish.slotLockedTitle"), t("publish.slotLockedMsg"), 3000, "#f5a623");
}

function _priceChipHtml(item) {
    const hasTrader = item.trader_vendor && item.trader_price_rub != null;
    const traderAvailable = hasTrader &&
        (EFTForge.state.traderLevels[item.trader_vendor] ?? 4) >= (item.trader_min_level ?? 1);

    if (traderAvailable) {
        const trader  = EFTForge.state.tradersByNorm?.[item.trader_vendor];
        const imgSrc  = trader?.imageLink || "";
        const portrait = imgSrc
            ? `<img class="price-chip-portrait" src="${escapeHtml(imgSrc)}" onerror="this.style.display='none'" />`
            : `<span class="price-chip-vendor">${escapeHtml(item.trader_vendor)}</span>`;
        return `<div class="price-chip">${portrait}<span class="price-chip-value">${_formatPrice(item.trader_price_rub)}</span></div>`;
    }

    const fleaCache = EFTForge.state.priceMode === "pve" ? EFTForge.state.fleaCachePve
        : EFTForge.state.priceMode === "pvpSeason" ? EFTForge.state.fleaCacheSeasonal
        : EFTForge.state.fleaCachePvp;
    const fleaPrice = fleaCache?.[item.id];
    if (fleaPrice != null) {
        const { t } = EFTForge.lang;
        return `<div class="price-chip"><span class="price-chip-flea">${escapeHtml(t("stats.fleaLabel"))}</span><span class="price-chip-value">${_formatPrice(fleaPrice)}</span></div>`;
    }

    return "";
}

async function renderFullTree(preserveScroll = true) {
    const { t } = EFTForge.lang;

    const container = document.getElementById("slots");
    if (!container) return;

    const previousScroll = preserveScroll ? container.scrollTop : 0;

    const placeholder = document.getElementById("attachment-placeholder");

    if (!EFTForge.state.lastSlot) {
        placeholder.style.display = "flex";
        document.getElementById("attachment-table-container").innerHTML = "";
    }

    container.innerHTML = `
        <div class="stats-section">
            <div class="section-title">
                ${t("tree.title")}
                <span class="tree-swipe-hint">${t("tree.swipeHint")}</span>
                <span class="tree-view-toggle">
                    <button class="compare-toggle bp-imggen-toggle${_bpEnabled && !_bpGlobalDisabled ? ' active' : ''}${_bpGlobalDisabled ? ' bp-imggen-globally-disabled' : ''}" onclick="toggleImgGen()" ${_bpGlobalDisabled ? `data-tooltip="${_bpDisabledTip()}"` : ''} style="margin-right:6px;" aria-label="Kitbash! ${t("ui.imgGen")}">
                        ${_bpToggleLogoHtml()}${t("ui.imgGen")}
                        <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                    </button>
                    <button class="toggle-btn ag-export-img-btn" data-tooltip="${t("build.exportImg")}" onclick="exportBuildImage()" style="margin-right:4px;"><svg width="13" height="13" viewBox="0 0 13 13" fill="none" style="display:block"><polyline points="6.5,1 6.5,8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><polyline points="3.5,6 6.5,9 9.5,6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><rect x="1.5" y="10.5" width="10" height="1" rx="0.5" fill="currentColor"/></svg></button>
                    <button id="view-list-btn" class="toggle-btn${!EFTForge.state.gridView ? ' active' : ''}" onclick="showListView()">&#9776;</button>
                    <button id="view-grid-btn" class="toggle-btn${EFTForge.state.gridView  ? ' active' : ''}" onclick="showGridView()">&#9783;</button>
                </span>
            </div>
            <div id="tree-content"></div>
        </div>
    `;

    const treeBox = document.getElementById("tree-content");
    if (!treeBox) return;

    await renderNode(EFTForge.state.buildTree, 0, treeBox);

    // Re-apply active slot highlight immediately after tree is built
    if (EFTForge.state.lastParentNode && EFTForge.state.lastSlot) {
        const activeSlotEl = findSlotElement(EFTForge.state.lastParentNode, EFTForge.state.lastSlot.id);
        if (activeSlotEl) activeSlotEl.classList.add("active-slot");
    }

    if (preserveScroll) {
        container.scrollTop = previousScroll;
    }
}

async function renderNode(node, depth, parentElement) {
    const { tSlot } = EFTForge.lang;

    let slots;

    if (EFTForge.state.slotCache[node.item.id]) {
        slots = EFTForge.state.slotCache[node.item.id];
    } else {
        try {
            slots = await fetchItemSlots(node.item.id);
            cacheSet(EFTForge.state.slotCache, node.item.id, slots);
        } catch (err) {
            console.error("Failed to load slots for tree node:", err);
            return;
        }
    }

    for (const slot of slots) {

        const installed = node.children[slot.id];

        // Skip slots with no available attachments (removed from game but slot remains)
        if (!installed && !slot.has_allowed_items) continue;

        let hasChildSlots = false;

        if (installed) {

            let childSlots;

            if (EFTForge.state.slotCache[installed.item.id]) {
                childSlots = EFTForge.state.slotCache[installed.item.id];
            } else {
                try {
                    childSlots = await fetchItemSlots(installed.item.id);
                    cacheSet(EFTForge.state.slotCache, installed.item.id, childSlots);
                } catch (err) {
                    console.error("Failed to load child slots for tree node:", err);
                    childSlots = [];
                }
            }

            hasChildSlots = childSlots.some(cs => installed.children[cs.id] || cs.has_allowed_items);
        }

        const isCollapsed = EFTForge.state.collapsedSlots[slot.id] === true;

        const wrapper = document.createElement("div");
        wrapper.className = "tree-slot";
        wrapper.dataset.slotId = slot.id;
        wrapper.dataset.parentItemId = node.item.id;
        wrapper.dataset.depth = depth;
        wrapper.classList.add(`depth-${depth}`);
        wrapper.dataset.slotName = slot.slot_name;

        const arrow = (installed && hasChildSlots)
            ? (EFTForge.state.collapsedSlots[slot.id] ? "▶" : "▼")
            : "";

        wrapper.innerHTML = `
            <div class="tree-slot-inner">
                <div class="tree-slot-name ${hasChildSlots ? "collapsible" : ""}">
                    ${arrow} ${escapeHtml(tSlot(slot.slot_name))}
                </div>
                <div class="tree-slot-item">
                    ${
                        installed
                        ? `
                        <div class="tree-slot-icon">
                            <img src="${escapeHtml(installed.item.icon_link)}" />
                            <div class="slot-shortname">
                                ${escapeHtml(installed.item.short_name)}
                            </div>
                        </div>
                        `
                        : _slotPlaceholderHtml(slot.slot_name)
                    }
                </div>
            </div>
        `;

        const nameEl = wrapper.querySelector(".tree-slot-name");

        // NAME CLICK → collapse only if slot has children
        nameEl.onclick = (e) => {

            e.stopPropagation();

            if (installed && hasChildSlots) {

                const isCollapsing = !EFTForge.state.collapsedSlots[slot.id];
                EFTForge.state.collapsedSlots[slot.id] = isCollapsing;

                if (isCollapsing) {

                    // Animate collapse on existing DOM before rebuild
                    const childContainer = wrapper.nextElementSibling;
                    if (childContainer) {
                        childContainer.style.height = childContainer.scrollHeight + "px";
                        childContainer.style.opacity = "1";
                        void childContainer.offsetHeight;
                        childContainer.style.height = "0px";
                        childContainer.style.opacity = "0";
                    }

                    setTimeout(() => renderFullTree(false), 150);

                } else {

                    // Rebuild to inject child nodes, then find the new container by slot ID
                    renderFullTree(false).then(() => {

                        // Find the freshly rendered slot wrapper by slot ID and parent item ID
                        const newWrapper = document.querySelector(
                            `.tree-slot[data-slot-id="${slot.id}"][data-parent-item-id="${node.item.id}"]`
                        );

                        if (!newWrapper) return;

                        const newContainer = newWrapper.nextElementSibling;
                        if (!newContainer || !newContainer.classList.contains("tree-children")) return;

                        // Start from 0 and animate to full height
                        newContainer.style.height = "0px";
                        newContainer.style.opacity = "0";
                        void newContainer.offsetHeight;

                        newContainer.style.height = newContainer.scrollHeight + "px";
                        newContainer.style.opacity = "1";

                        newContainer.addEventListener("transitionend", () => {
                            newContainer.style.height = "";
                            newContainer.style.opacity = "";
                        }, { once: true });
                    });
                }

                return;
            }

            openSlotSelector(node, slot);
        };

        // CLICK ANYWHERE ELSE → open selector
        wrapper.onclick = () => {
            if (EFTForge.state.publishMode) { _showPublishLockedToast(); return; }
            openSlotSelector(node, slot);
        };

        // RIGHT CLICK → remove attachment
        wrapper.oncontextmenu = (e) => {

            e.preventDefault();

            if (EFTForge.state.publishMode) { _showPublishLockedToast(); return; }

            const currentInstalled = node.children[slot.id];
            if (!currentInstalled) return;

            removeAttachment(node, slot.id);
        };

        // SWIPE LEFT → remove attachment (mobile; auto-registered by MutationObserver)
        if (installed) {
            const inner = wrapper.querySelector(".tree-slot-inner");
            if (inner) {
                inner.classList.add("swipe-removable");
                inner._swipeRemoveFn = () => {
                    if (EFTForge.state.publishMode) return;
                    if (node.children[slot.id]) removeAttachment(node, slot.id);
                };
            }
        }

        parentElement.appendChild(wrapper);

        // Store the slot's DOM wrapper on the parent node keyed by slot ID.
        // This is set regardless of whether anything is installed, so
        // updateSlotIcon can always find the correct element even for
        // freshly installed attachments that have no _slotEl yet.
        if (!node._slotEls) node._slotEls = {};
        node._slotEls[slot.id] = wrapper;

        const childContainer = document.createElement("div");
        childContainer.className = "tree-children";

        parentElement.appendChild(childContainer);

        if (installed && hasChildSlots && !isCollapsed) {
            await renderNode(installed, depth + 1, childContainer);
        }
    }
}

function findSlotElement(parentNode, slotId) {

    // The DOM wrapper for a slot is stored on its parent node under _slotEls,
    // keyed by slot ID - unique per tree position regardless of item ID
    return parentNode._slotEls?.[slotId] || null;
}

function updateSlotIcon(parentNode, slotId, item) {

    const slotElement = findSlotElement(parentNode, slotId);
    if (!slotElement) return;

    const iconBox = slotElement.querySelector(".tree-slot-item");

    iconBox.innerHTML = `
        ${_priceChipHtml(item)}
        <div class="tree-slot-icon">
            <img src="${escapeHtml(item.icon_link)}" />
            <div class="slot-shortname">
                ${escapeHtml(item.short_name)}
            </div>
        </div>
    `;

    flashSlot(parentNode, slotId);
}

function flashSlot(parentNode, slotId, type = "install") {

    const slotElement = findSlotElement(parentNode, slotId);
    if (!slotElement) return;

    slotElement.classList.remove("slot-flash-install", "slot-flash-remove");
    void slotElement.offsetWidth;

    const cls = type === "remove" ? "slot-flash-remove" : "slot-flash-install";
    slotElement.classList.add(cls);

    slotElement.addEventListener("animationend", () => {
        slotElement.classList.remove(cls);
    }, { once: true });
}

function flashTree(type) {
    const slots = document.getElementById("slots");
    if (!slots) return;

    const rect = slots.getBoundingClientRect();
    const overlay = document.createElement("div");
    overlay.className = `tree-flash-overlay ${type}`;
    overlay.style.position = "fixed";
    overlay.style.top    = rect.top + "px";
    overlay.style.left   = rect.left + "px";
    overlay.style.width  = rect.width + "px";
    overlay.style.height = rect.height + "px";
    document.body.appendChild(overlay);

    overlay.addEventListener("animationend", () => overlay.remove(), { once: true });
}

function flashConflictInTree(node, conflictingItemId) {
    // Walk the tree to find which slot contains the conflicting item,
    // then flash that slot's element
    for (const slotId in node.children) {
        const child = node.children[slotId];
        if (child.item.id === conflictingItemId) {
            flashConflictSlotElement(node._slotEls?.[slotId]);
            return;
        }
        flashConflictInTree(child, conflictingItemId);
    }
}

function flashConflictSlotInTree(conflictingSlotId) {
    // Walk all nodes in the tree to find the slot element by slot ID
    function walk(node) {
        if (node._slotEls?.[conflictingSlotId]) {
            flashConflictSlotElement(node._slotEls[conflictingSlotId]);
            return true;
        }
        for (const slotId in node.children) {
            if (walk(node.children[slotId])) return true;
        }
        return false;
    }
    walk(EFTForge.state.buildTree);
}

function flashConflictSlotElement(el) {
    if (!el) return;

    const panel = document.getElementById("slots");
    if (!panel) return;

    // Calculate where the element sits relative to the scroll panel
    const panelRect = panel.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();

    const targetScrollTop =
        panel.scrollTop +
        (elRect.top - panelRect.top) -
        (panelRect.height / 2) +
        (elRect.height / 2);

    const startScrollTop = panel.scrollTop;
    const distance = targetScrollTop - startScrollTop;
    const duration = 200;
    let startTime = null;

    function easeInOutCubic(t) {
        return t < 0.5
            ? 4 * t * t * t
            : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    function animateScroll(timestamp) {
        if (!startTime) startTime = timestamp;
        const elapsed = timestamp - startTime;
        const progress = Math.min(elapsed / duration, 1);

        panel.scrollTop = startScrollTop + distance * easeInOutCubic(progress);

        if (progress < 1) {
            requestAnimationFrame(animateScroll);
        }
    }

    requestAnimationFrame(animateScroll);

    let count = 0;

    function doFlash() {
        if (count >= 2) return;
        count++;

        el.classList.remove("slot-flash-conflict");
        void el.offsetWidth;
        el.classList.add("slot-flash-conflict");

        el.addEventListener("animationend", () => {
            el.classList.remove("slot-flash-conflict");
            setTimeout(doFlash, 30);
        }, { once: true });
    }

    // Delay flash until scroll animation has landed
    setTimeout(doFlash, 220);
}

async function installAttachment(parentNode, slotId, item) {
    pushBuildHistory();

    parentNode.children[slotId] = { item, children: {} };

    EFTForge.state.processedCache = {};
    refreshBuildStats();
    applyAttachmentSort();

    let childSlots;
    if (EFTForge.state.slotCache[item.id]) {
        childSlots = EFTForge.state.slotCache[item.id];
    } else {
        try {
            childSlots = await fetchItemSlots(item.id);
            cacheSet(EFTForge.state.slotCache, item.id, childSlots);
        } catch (err) {
            console.error("Failed to load child slots after install:", err);
            childSlots = [];
        }
    }

    await renderFullTree(true);
    flashSlot(parentNode, slotId, "install");
    if (typeof updateAttTableHeaderImg === "function") updateAttTableHeaderImg();

    if (childSlots.length > 0) {
        // Flash all newly revealed child slots with subtle grey
        const installedNode = parentNode.children[slotId];
        if (installedNode && installedNode._slotEls) {
            Object.values(installedNode._slotEls).forEach(el => {
                el.classList.remove("slot-flash-reveal");
                void el.offsetWidth;
                el.classList.add("slot-flash-reveal");
                el.addEventListener("animationend", () => {
                    el.classList.remove("slot-flash-reveal");
                }, { once: true });
            });
        }
    }
}

function removeAttachment(parentNode, slotId, keepTableOpen = false) {
    pushBuildHistory();

    const removedNode = parentNode.children[slotId];

    const removedNodes = new Set();

    function collect(node) {
        if (!node) return;
        removedNodes.add(node);
        for (const childSlot in node.children) {
            collect(node.children[childSlot]);
        }
    }

    collect(removedNode);

    // Clear collapsed state for the removed slot and its entire subtree
    // so reinstalling an attachment doesn't inherit a stale collapsed state
    delete EFTForge.state.collapsedSlots[slotId];
    removedNodes.forEach(node => {
        for (const childSlotId in node.children) {
            delete EFTForge.state.collapsedSlots[childSlotId];
        }
    });

    delete parentNode.children[slotId];
    EFTForge.state.processedCache = {};

    const directSlotRemoved =
        EFTForge.state.lastParentNode === parentNode &&
        EFTForge.state.lastSlot &&
        EFTForge.state.lastSlot.id === slotId;

    const subtreeRemoved =
        EFTForge.state.lastParentNode && removedNodes.has(EFTForge.state.lastParentNode);

    if ((directSlotRemoved || subtreeRemoved) && !keepTableOpen) {
        EFTForge.state.lastParentNode = null;
        EFTForge.state.lastSlot = null;

        document.getElementById("attachment-table-container").innerHTML = "";

        const placeholder = document.getElementById("attachment-placeholder");
        if (placeholder) {
            placeholder.style.display = "flex";
        }
    }

    // Only remove gold border if the active slot is the one being removed
    if ((directSlotRemoved || subtreeRemoved) && !keepTableOpen) {
        document.querySelectorAll(".tree-slot.active-slot")
            .forEach(el => el.classList.remove("active-slot"));
    }

    if (keepTableOpen && (directSlotRemoved || subtreeRemoved)) {
        applyAttachmentSort();
    }

    // If the table is still open (same slot with keepTableOpen, or a different slot
    // entirely), clear stale conflict states for instant feedback, then silently refetch
    // stats in the background - simErgo/simRecoilV/simRecoilH/simWeight/simEED were
    // computed against the pre-removal installed-ids snapshot and are now stale after
    // *any* attachment removal (not just one that resolves a conflict), so the hover
    // delta bars need fresh numbers or they won't match what actually gets installed.
    if (EFTForge.state.lastParentNode && EFTForge.state.lastSlot && EFTForge.state.lastProcessedItems.length > 0) {
        const removedItemIds = new Set([...removedNodes].map(n => n.item.id));

        for (const entry of EFTForge.state.lastProcessedItems) {
            if (entry.hasConflict && removedItemIds.has(entry.conflictingItemId)) {
                entry.hasConflict = false;
                entry.conflictName = null;
                entry.conflictingItemId = null;
                entry.conflictingSlotId = null;
            }
        }

        applyAttachmentSort();
        if (typeof _reprocessOpenSlot === "function") _reprocessOpenSlot();

        // Same for combo mode: clear stale conflict on combo entries whose
        // conflicting item was just removed, then update highlights in place.
        if (EFTForge.state.comboMode && EFTForge.state.lastComboItems?.length > 0) {
            let comboClear = false;
            for (const entry of EFTForge.state.lastComboItems) {
                if (entry.conflict && removedItemIds.has(entry.conflict.conflicting_item_id)) {
                    entry.conflict = null;
                    comboClear = true;
                }
            }
            if (comboClear) {
                EFTForge.state.combosCache = {};
                if (typeof _refreshComboHighlights === "function") _refreshComboHighlights();
            }
        }
    }

    // Immediately patch the slot icon to empty
    const slotElement = findSlotElement(parentNode, slotId);
    if (slotElement) {
        const iconBox = slotElement.querySelector(".tree-slot-item");
        if (iconBox) {
            iconBox.innerHTML = _slotPlaceholderHtml(slotElement.dataset.slotName);
            if (typeof updateAttTableHeaderImg === "function") updateAttTableHeaderImg();
        }

        // Collapse child container instantly via height animation
        const childContainer = slotElement.nextElementSibling;
        if (childContainer && childContainer.classList.contains("tree-children")) {
            childContainer.style.height = childContainer.scrollHeight + "px";
            childContainer.style.opacity = "1";

            // Force reflow so the browser registers the starting height
            void childContainer.offsetHeight;

            childContainer.style.height = "0px";
            childContainer.style.opacity = "0";
        }
    }

    // Strip swipe state so .swipe-removable::after doesn't conflict with the flash ::after
    if (slotElement) {
        const inner = slotElement.querySelector(".tree-slot-inner");
        if (inner) {
            inner.classList.remove("swipe-removable", "swipe-revealing");
            inner.style.transform = "";
        }
    }

    refreshBuildStats();

    renderFullTree(true).then(() => {
        flashSlot(parentNode, slotId, "remove");
    });
}

function collectAttachmentIds(node) {
  let ids = [];
  for (const slotId in node.children) {
    const child = node.children[slotId];
    ids.push(child.item.id);
    ids = ids.concat(collectAttachmentIds(child));
  }
  return ids;
}

// ---------------------------------------------------
// Undo / Redo
// ---------------------------------------------------

function pushBuildHistory() {
    if (!EFTForge.state.buildTree) return;
    const pairs = collectSlotPairs(EFTForge.state.buildTree);
    EFTForge.state.buildHistory.push(pairs);
    if (EFTForge.state.buildHistory.length > 30) EFTForge.state.buildHistory.shift();
    EFTForge.state.buildFuture = [];
}

async function _restoreBuildFromPairs(pairs) {
    if (!EFTForge.state.buildTree || !EFTForge.state.currentGun) return;

    EFTForge.state.buildTree.children = {};
    EFTForge.state.processedCache = {};

    for (const [slotId, itemId] of pairs) {
        if (!EFTForge.state.allowedCache[slotId]) {
            try {
                const allowed = await fetchSlotAllowedItems(slotId);
                cacheSet(EFTForge.state.allowedCache, slotId, allowed);
            } catch {}
        }
        const allowed = EFTForge.state.allowedCache[slotId];
        if (!allowed) continue;

        const itemObj = allowed.find(i => i.id === itemId);
        if (!itemObj) continue;

        const slotToParent = {};
        buildSlotParentMap(EFTForge.state.buildTree, slotToParent);

        const parentNode = slotToParent[slotId];
        if (!parentNode) continue;

        parentNode.children[slotId] = { item: itemObj, children: {} };

        if (!EFTForge.state.slotCache[itemObj.id]) {
            try {
                const slots = await fetchItemSlots(itemObj.id);
                cacheSet(EFTForge.state.slotCache, itemObj.id, slots);
            } catch {}
        }
    }

    // Close the attachment table since the build state changed
    const box = document.getElementById("attachment-table-container");
    if (box) box.innerHTML = "";
    const placeholder = document.getElementById("attachment-placeholder");
    if (placeholder) placeholder.style.display = "flex";
    document.querySelectorAll(".tree-slot.active-slot").forEach(el => el.classList.remove("active-slot"));
    EFTForge.state.lastSlot       = null;
    EFTForge.state.lastParentNode = null;

    await renderFullTree(false);
    await refreshBuildStats();
    syncBuildDisplayName();
}

async function undoBuildAction() {
    if (!EFTForge.state.buildHistory.length) return;
    const currentPairs = collectSlotPairs(EFTForge.state.buildTree);
    EFTForge.state.buildFuture.push(currentPairs);
    if (EFTForge.state.buildFuture.length > 30) EFTForge.state.buildFuture.shift();
    await _restoreBuildFromPairs(EFTForge.state.buildHistory.pop());
}

async function redoBuildAction() {
    if (!EFTForge.state.buildFuture.length) return;
    const currentPairs = collectSlotPairs(EFTForge.state.buildTree);
    EFTForge.state.buildHistory.push(currentPairs);
    if (EFTForge.state.buildHistory.length > 30) EFTForge.state.buildHistory.shift();
    await _restoreBuildFromPairs(EFTForge.state.buildFuture.pop());
}
