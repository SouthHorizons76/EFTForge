// ===================================================================
//  GRAPH VIEW
//  Contains all graph-related state and logic.
//
//  Dependencies (globals from other modules):
//    t(), escapeHtml(), showToast(), _createModalOverlay() - utils/lang
//    EFTForge.state, EFTForge.config
//    fetchGraphSearchableItems() - api.js
//    applyAttachmentSort(), _updateViewBtns(), _updateGraphHeader() - slot-selector.js
//    _abortComboCalc(), _disconnectComboObserver() - slot-selector.js
// ===================================================================

// -- Persistent graph state --
let _graphView             = null;  // { xMin, xMax, yMin, yMax } | null = auto-fit
let _graphZoomController   = null;  // AbortController for wheel/drag window listeners
let _graphCrosshairEnabled = localStorage.getItem("eftforge_graph_crosshair") !== "0";
let _graphLabelsEnabled    = localStorage.getItem("eftforge_graph_labels")    !== "0";
let _graphHintsEnabled     = localStorage.getItem("eftforge_graph_hints")  !== "0";
let _graphIconScale        = Math.min(2.0, Math.max(1.0, parseFloat(localStorage.getItem("eftforge_graph_icon_scale") || "1.3")));
let _graphPanState         = null;  // { last: {sx,sy} } while middle-button drag active
let _graphPanRaf           = null;
let _graphPanDelta         = null;
let _graphClusterState     = {};    // clusterKey -> activeIndex
let _graphHoveredCluster   = null;  // { key, count } of cluster under pointer, for arrow-key cycling
let _graphHoveredItemId    = null;  // data-item-id of the dot currently under pointer
let _graphResizeTimer      = null;
let _graphViewTarget       = null;  // lerp target for smooth ctrl+scroll zoom
let _graphZoomLerpRaf      = null;  // rAF handle for zoom lerp loop
let _graphSVGInitDone      = false; // whether intro animation has played for this session
let _graphLerpEndNull      = false; // whether the current lerp should end with _graphView = null (reset)
let _graphScrollHintTimer  = null;  // debounce timer for plain-scroll hint overlay
let _graphScrollHintShown  = false; // true after hint has fired once this session

// Zoom is unbounded without this: repeated ctrl+scroll zoom-in shrinks the domain
// span toward 0, which eventually underflows in floating point and turns toX/toY
// into NaN/Infinity (divide-by-near-zero) - once that happens the lerp's "done"
// check (a delta-vs-target comparison) can never be true again since any compare
// against NaN is false, so the rAF loop spins forever on a garbled chart. Clamping
// every zoom step to a span within [autoSpan*MIN, autoSpan*MAX] keeps it a safe,
// finite range in both directions instead of trying to catch the NaN after the fact.
const GRAPH_MIN_ZOOM_RATIO = 0.02; // deepest zoom-in: 2% of the auto-fit span
const GRAPH_MAX_ZOOM_RATIO = 30;   // furthest zoom-out: 30x the auto-fit span
function _clampZoomSpan(min, max, autoMin, autoMax) {
    const autoSpan = autoMax - autoMin;
    const minSpan = autoSpan * GRAPH_MIN_ZOOM_RATIO;
    const maxSpan = autoSpan * GRAPH_MAX_ZOOM_RATIO;
    const span = max - min;
    if (span > maxSpan) {
        // Hard ceiling: always recenter on the data itself, not on wherever
        // the cursor happened to be anchoring the zoom - otherwise every
        // further zoom-out tick keeps recomputing a same-width-but-differently
        // -centered window, which never visibly stops even though the span
        // itself is capped (the points just keep sliding off to one side).
        const autoMid = (autoMin + autoMax) / 2;
        return [autoMid - maxSpan / 2, autoMid + maxSpan / 2];
    }
    if (span < minSpan) {
        // No such drift concern zooming in - keep following the cursor so
        // continuing to scroll in at the floor still pans toward it.
        const mid = (min + max) / 2;
        return [mid - minSpan / 2, mid + minSpan / 2];
    }
    return [min, max];
}

// -- Custom items (search & add feature) --
let _graphCustomItems      = [];    // array of custom plot items (see _addCustomGun/_addCustomAttachment)
let _graphCustomMode       = null;  // null | 'guns' | 'attachments'
let _graphGunXMetric       = localStorage.getItem("eftforge_graph_gun_x")  || "recoilVertical";
let _graphGunYMetric       = localStorage.getItem("eftforge_graph_gun_y")  || "ergoModifier";
let _graphAttXMetric       = localStorage.getItem("eftforge_graph_att_x")  || "recoilPercent";
let _graphAttYMetric       = localStorage.getItem("eftforge_graph_att_y")  || "ergoModifier";
let _graphSearchData       = null;  // cached { guns:[...], attachments:[...] } from API
let _graphSearchOpen       = false;
let _graphSearchQuery      = "";    // preserved across panel rebuilds
let _graphSearchFilter     = "all"; // "all" | "guns" | "attachments"

// Metric definitions shared by axis config strip and SVG renderer
const _GUN_METRICS = [
    { id: "recoilVertical",   shortKey: "graph.metricVRecoil",   axisKey: "graph.xLabelVertical",   getValue: e => e.recoilVertical,   lowerBetter: true  },
    { id: "recoilHorizontal", shortKey: "graph.metricHRecoil",   axisKey: "graph.xLabelHorizontal", getValue: e => e.recoilHorizontal, lowerBetter: true  },
    { id: "ergoModifier",     shortKey: "graph.metricErgo",      axisKey: "graph.metricErgo",       getValue: e => e.ergoModifier,     lowerBetter: false },
];
const _ATT_METRICS = [
    { id: "recoilPercent",    shortKey: "graph.metricRecoilMod", axisKey: "graph.xLabel",           getValue: e => e.recoilPercent,    lowerBetter: true  },
    { id: "contribution",     shortKey: "graph.metricEvoErgo",   axisKey: "graph.yLabel",           getValue: e => e.contribution,     lowerBetter: false },
    { id: "ergoModifier",     shortKey: "graph.metricErgo",      axisKey: "graph.yLabelErgo",       getValue: e => e.ergoModifier,     lowerBetter: false },
];

// ===================================================================
//  Header update (called from setListView too - must stay accessible)
// ===================================================================

function _updateGraphHeader() {
    const inGraph  = EFTForge.state.graphMode;
    const isCustom = _graphCustomMode !== null;
    const disp = inGraph ? "none" : "";
    document.getElementById("purchasable-toggle-btn").style.display = disp;
    document.getElementById("compare-toggle-btn").style.display = disp;
    document.getElementById("favorites-filter-btn").style.display = disp;
    const h3 = document.querySelector(".att-table-header h3");
    if (h3) {
        const textNode = h3.firstChild;
        if (textNode && textNode.nodeType === Node.TEXT_NODE) {
            if (inGraph && isCustom) textNode.nodeValue = t("graph.customGraph");
            else if (inGraph)        textNode.nodeValue = `${t("ui.graph")} - `;
            else                     textNode.nodeValue = t("ui.selectAttFor");
        }
        const strong = h3.querySelector("strong");
        if (strong) strong.style.display = (inGraph && isCustom) ? "none" : "";
    }
    const header = document.querySelector(".att-table-header");
    if (header) {
        const icon = header.querySelector(".att-table-icon-preview, .bp-gun-img-wrap, .att-table-gun-img");
        if (icon) icon.style.visibility = (inGraph && isCustom) ? "hidden" : "";
    }
}

// ===================================================================
//  View switching
// ===================================================================

// Resets all graph state variables. Called by setGraphView and by
// slot-selector.js when leaving graph mode via setListView/setComboView.
function _cleanupGraphState() {
    _graphZoomController?.abort();
    if (_graphZoomLerpRaf) { cancelAnimationFrame(_graphZoomLerpRaf); _graphZoomLerpRaf = null; }
    clearTimeout(_graphResizeTimer); _graphResizeTimer = null;
    _graphView        = null;
    _graphViewTarget  = null;
    _graphSVGInitDone = false;
    _graphLerpEndNull = false;
    _graphPanState    = null; _graphPanRaf  = null;
    _graphPanDelta    = null; _graphClusterState = {};
    _graphSearchOpen  = false;
    _graphSearchQuery = "";
    _graphCustomItems = [];
    _graphCustomMode  = null;
    clearTimeout(_graphScrollHintTimer); _graphScrollHintTimer = null;
    document.querySelector(".graph-scroll-hint")?.remove();
}

function setGraphView(wantGraph) {
    if (isMobileLayout() && wantGraph) return;
    if (EFTForge.state.graphMode === wantGraph) return;
    EFTForge.state.graphMode = wantGraph;

    const table       = document.querySelector(".attachment-table");
    const searchInput = document.getElementById("attachment-search");

    if (wantGraph) {
        if (EFTForge.state.comboMode) {
            _abortComboCalc();
            _disconnectComboObserver();
            EFTForge.state.comboMode = false;
            EFTForge.state.lastComboItems = [];
        }
        if (table) table.style.display = "none";
        if (searchInput) searchInput.style.display = "none";

        _graphView = null;
        let graphDiv = document.getElementById("attachment-graph");
        if (!graphDiv) {
            graphDiv = document.createElement("div");
            graphDiv.id = "attachment-graph";
            graphDiv.className = "att-graph-container";
            graphDiv.innerHTML =
                '<div class="graph-body" id="graph-body">' +
                  '<div class="graph-top-bar" id="graph-top-bar"></div>' +
                  '<div id="graph-svg-wrap"></div>' +
                  '<div class="graph-search-panel" id="graph-search-panel" style="display:none"></div>' +
                '</div>';
            table?.parentNode.insertBefore(graphDiv, table);
            graphDiv.classList.add("table-slide-in");
            graphDiv.addEventListener("animationend", () => graphDiv.classList.remove("table-slide-in"), { once: true });
        }
        _updateGraphTopBar();
        _buildGraphSVG(document.getElementById("graph-svg-wrap"));
    } else {
        _cleanupGraphState();
        document.getElementById("attachment-graph")?.remove();
        if (table) table.style.display = "";
        if (searchInput) searchInput.style.display = "";
        applyAttachmentSort();
    }

    _updateViewBtns();
    _updateGraphHeader();
}

// ===================================================================
//  Top bar  (Add Items / Clear)
// ===================================================================

function _closeGraphPanel() {
    if (!_graphSearchOpen) return;
    _graphSearchOpen = false;
    _updateGraphTopBar();
    const panel = document.getElementById("graph-search-panel");
    if (!panel) return;
    panel.classList.remove("graph-panel-open");
    panel.classList.add("graph-panel-closing");
    panel.addEventListener("animationend", () => {
        panel.style.display = "none";
        panel.classList.remove("graph-panel-closing");
    }, { once: true });
}

function _updateGraphTopBar() {
    const topBar = document.getElementById("graph-top-bar");
    if (topBar) topBar.innerHTML = "";  // button lives in the SVG now
}

// ===================================================================
//  Search panel
// ===================================================================

async function _buildGraphSearchPanel(panel) {
    const ph = escapeHtml(t("graph.searchPlaceholder"));
    panel.innerHTML =
        `<div class="graph-panel-strip graph-search-strip">` +
          `<div class="graph-search-bar">` +
            `<input class="graph-search-input" id="graph-search-input" placeholder="${ph}" autocomplete="off">` +
          `</div>` +
          `<div class="graph-search-filters" id="graph-search-filters">` +
            `<button class="gsf-btn${_graphSearchFilter === "all"         ? " gsf-active" : ""}" data-filter="all">${escapeHtml(t("graph.filterAll"))}</button>` +
            `<button class="gsf-btn${_graphSearchFilter === "guns"        ? " gsf-active" : ""}" data-filter="guns">${escapeHtml(t("graph.filterWeapons"))}</button>` +
            `<button class="gsf-btn${_graphSearchFilter === "attachments" ? " gsf-active" : ""}" data-filter="attachments">${escapeHtml(t("graph.filterAttachments"))}</button>` +
          `</div>` +
          `<div class="graph-search-results" id="graph-search-results">` +
            `<div class="graph-no-results">...</div>` +
          `</div>` +
        `</div>` +
        `<div class="graph-panel-strip graph-plotted-strip">` +
          `<div class="graph-sel-header" id="graph-sel-header">` +
            `<span class="graph-sel-label">${escapeHtml(t("graph.plotted"))}</span>` +
          `</div>` +
          `<div class="graph-sel-section" id="graph-sel-section"></div>` +
        `</div>` +
        `<div class="graph-panel-strip graph-axis-strip" id="graph-axis-strip"></div>`;

    _refreshGraphSelSection(panel);
    _buildGraphAxisStrip(panel);

    if (!_graphSearchData) {
        try {
            _graphSearchData = await fetchGraphSearchableItems();
        } catch (_) {
            const r = panel.querySelector("#graph-search-results");
            if (r) r.innerHTML = `<div class="graph-no-results">${escapeHtml(t("graph.noResults"))}</div>`;
            return;
        }
    }

    const input = panel.querySelector("#graph-search-input");
    if (input) {
        input.value = _graphSearchQuery;
        input.focus();
        input.addEventListener("input", () => {
            _graphSearchQuery = input.value;
            _renderGraphSearchResults(panel, input.value);
        });
    }

    panel.querySelectorAll(".gsf-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            _graphSearchFilter = btn.dataset.filter;
            panel.querySelectorAll(".gsf-btn").forEach(b => b.classList.toggle("gsf-active", b === btn));
            _renderGraphSearchResults(panel, _graphSearchQuery);
        });
    });

    _renderGraphSearchResults(panel, _graphSearchQuery);
}

function _refreshGraphSelSection(panel) {
    const zone   = panel?.querySelector("#graph-sel-section");
    const header = panel?.querySelector("#graph-sel-header");
    if (!zone) return;

    const inCustomMode = _graphCustomMode !== null;

    let displayItems, clickHandler, clearHandler;
    if (inCustomMode) {
        displayItems = _graphCustomItems.map(ci => ({ id: ci.customId, icon: ci.item.base_image_link || ci.item.icon_link || "", name: ci.item.name || ci.item.short_name || "" }));
        clickHandler = id => _removeCustomItem(id);
        clearHandler = _clearCustomItems;
    } else {
        const all   = EFTForge.state.lastProcessedItems || [];
        const query = EFTForge.state.currentSearchQuery || "";
        const items = query ? all.filter(e => e.sortName?.includes(query)) : all;
        displayItems = items.map(e => ({ id: e.item.id, icon: e.item?.base_image_link || e.item?.icon_link || "", name: e.item?.name || e.item?.short_name || "" }));
        clickHandler = id => _removeRegularItem(id);
        clearHandler = _clearRegularItems;
    }

    // Clear button only when there are items to act on
    let clearBtn = header?.querySelector(".graph-sel-clear-btn");
    if (displayItems.length > 0 && !clearBtn && header) {
        clearBtn = document.createElement("button");
        clearBtn.className = "graph-sel-clear-btn";
        clearBtn.textContent = t("graph.clearItems");
        header.appendChild(clearBtn);
    } else if (displayItems.length === 0 && clearBtn) {
        clearBtn.remove();
        clearBtn = null;
    }
    if (clearBtn) clearBtn.onclick = clearHandler;

    // Render item list
    let html = "";
    for (const { id, icon, name } of displayItems) {
        html +=
            `<div class="graph-search-item gsi-selected" data-item-id="${escapeHtml(id)}">` +
            `<img src="${escapeHtml(icon)}" onerror="this.style.visibility='hidden'">` +
            `<span class="graph-search-item-name">${escapeHtml(name)}</span>` +
            `</div>`;
    }
    zone.innerHTML = html || `<div class="graph-no-results">-</div>`;
    zone.querySelectorAll(".graph-search-item").forEach(el =>
        el.addEventListener("click", () => clickHandler(el.dataset.itemId))
    );
}

function _buildGraphAxisStrip(panel) {
    const strip = panel?.querySelector("#graph-axis-strip");
    if (!strip) return;

    const isMGun  = _graphCustomMode === "guns";
    const metrics = isMGun ? _GUN_METRICS : _ATT_METRICS;
    const xCur    = isMGun ? _graphGunXMetric : _graphAttXMetric;
    const yCur    = isMGun ? _graphGunYMetric : _graphAttYMetric;

    let html = `<div class="graph-sel-header"><span class="graph-sel-label">${escapeHtml(t("graph.axisConfig"))}</span></div>`;
    html += `<div class="graph-axis-body">`;

    for (const axisId of ["x", "y"]) {
        const currentId = axisId === "x" ? xCur : yCur;
        html += `<div class="graph-axis-section">`;
        html += `<div class="graph-axis-label">${escapeHtml(t(axisId === "x" ? "graph.xAxis" : "graph.yAxis"))}</div>`;
        for (const m of metrics) {
            const isSel = m.id === currentId;
            const cls   = `graph-axis-btn${isSel ? ` gab-${axisId}-sel` : ""}`;
            html += `<button class="${cls}" data-axis="${axisId}" data-metric="${m.id}">${escapeHtml(t(m.shortKey))}</button>`;
        }
        html += `</div>`;
    }

    html += `</div>`;
    strip.innerHTML = html;

    strip.querySelectorAll(".graph-axis-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const axis   = btn.dataset.axis;
            const metric = btn.dataset.metric;
            const isGun  = _graphCustomMode === "guns";
            let newX = isGun ? _graphGunXMetric : _graphAttXMetric;
            let newY = isGun ? _graphGunYMetric : _graphAttYMetric;
            if (axis === "x") {
                if (metric === newY) newY = newX;  // swap
                newX = metric;
            } else {
                if (metric === newX) newX = newY;  // swap
                newY = metric;
            }
            if (isGun) {
                _graphGunXMetric = newX; localStorage.setItem("eftforge_graph_gun_x", newX);
                _graphGunYMetric = newY; localStorage.setItem("eftforge_graph_gun_y", newY);
            } else {
                _graphAttXMetric = newX; localStorage.setItem("eftforge_graph_att_x", newX);
                _graphAttYMetric = newY; localStorage.setItem("eftforge_graph_att_y", newY);
            }
            _graphView = null;
            _rebuildCustomGraph();
        });
    });
}

function _renderGraphSearchResults(panel, query) {
    const resultsEl = panel.querySelector("#graph-search-results");
    if (!resultsEl || !_graphSearchData) return;

    const isZh = (EFTForge.state.lang || "en") === "zh";
    const q    = query.toLowerCase();

    function matchItem(item) {
        if (!q) return true;
        return (item.name          || "").toLowerCase().includes(q)
            || (item.short_name    || "").toLowerCase().includes(q)
            || (item.name_zh       || "").includes(q)
            || (item.short_name_zh || "").includes(q);
    }
    function dispName(item) { return isZh ? (item.name_zh || item.name) : item.name; }

    const { guns, attachments } = _graphSearchData;
    const showGuns = _graphSearchFilter !== "attachments";
    const showAtts = _graphSearchFilter !== "guns";
    const CAT_ORDER = [
        "Assault rifle", "Assault carbine", "Marksman rifle", "Sniper rifle",
        "SMG", "Submachine gun", "Shotgun", "Handgun", "Revolver",
        "Machinegun", "Machine gun", "Machine Gun",
        "Grenade launcher", "Grenade Launcher", "Primary",
    ];

    const selIds = new Set(_graphCustomItems.map(ci => ci.customId));

    const gunsByCategory = new Map();
    for (const gun of (showGuns ? guns : [])) {
        if (!matchItem(gun)) continue;
        const cat = gun.weapon_category || "Primary";
        if (!gunsByCategory.has(cat)) gunsByCategory.set(cat, []);
        gunsByCategory.get(cat).push(gun);
    }
    const sortedCats = [...gunsByCategory.keys()].sort((a, b) => {
        const ai = CAT_ORDER.indexOf(a), bi = CAT_ORDER.indexOf(b);
        return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
    });

    const matchedAtts = showAtts ? attachments.filter(matchItem) : [];
    let html = "";

    for (const cat of sortedCats) {
        const catGuns  = gunsByCategory.get(cat);
        const catLabel = t("class." + cat) || cat;
        let catHtml = "";
        for (const gun of catGuns) {
            const name = dispName(gun);
            for (const variant of ["factory", "stripped"]) {
                const customId = `${gun.id}:${variant}`;
                if (selIds.has(customId)) continue;  // pinned above - skip
                const isDis  = _graphCustomMode === "attachments";
                const badge  = escapeHtml(t(variant === "factory" ? "graph.gunFactory" : "graph.gunStripped"));
                const icon   = escapeHtml(variant === "factory"
                    ? (gun.image_512_link      || gun.icon_link || "")
                    : (gun.bare_image_512_link || gun.base_image_link || gun.icon_link || ""));
                const disTip = isDis ? ` data-tooltip="${escapeHtml(t("graph.disabledMixType"))}"` : "";
                catHtml += `<div class="graph-search-item${isDis ? " gsi-disabled" : ""}"${disTip} data-custom-id="${escapeHtml(customId)}" data-item-type="gun" data-variant="${variant}">`;
                catHtml += `<img src="${icon}" onerror="this.style.visibility='hidden'">`;
                catHtml += `<span class="graph-search-item-name">${escapeHtml(name)}</span>`;
                catHtml += `<span class="graph-search-item-badge">${badge}</span>`;
                catHtml += `</div>`;
            }
        }
        if (catHtml) html += `<div class="graph-search-cat-header">${escapeHtml(catLabel)}</div>` + catHtml;
    }

    const unselAtts = matchedAtts.filter(att => !selIds.has(att.id));
    if (unselAtts.length) {
        html += `<div class="graph-search-cat-header">${escapeHtml(t("graph.catAttachments"))}</div>`;
        for (const att of unselAtts) {
            const name     = dispName(att);
            const icon     = escapeHtml(att.base_image_link || att.icon_link || "");
            const isDis    = _graphCustomMode === "guns";
            const disTip   = isDis ? ` data-tooltip="${escapeHtml(t("graph.disabledMixType"))}"` : "";
            html += `<div class="graph-search-item${isDis ? " gsi-disabled" : ""}"${disTip} data-custom-id="${escapeHtml(att.id)}" data-item-type="attachment">`;
            html += `<img src="${icon}" onerror="this.style.visibility='hidden'">`;
            html += `<span class="graph-search-item-name">${escapeHtml(name)}</span>`;
            html += `</div>`;
        }
    }

    resultsEl.innerHTML = html || `<div class="graph-no-results">${escapeHtml(t("graph.noResults"))}</div>`;

    resultsEl.querySelectorAll(".graph-search-item:not(.gsi-disabled)").forEach(el => {
        el.addEventListener("click", () => {
            if (el.dataset.itemType === "gun") {
                const gunId = el.dataset.customId.split(":")[0];
                const gun   = _graphSearchData.guns.find(g => g.id === gunId);
                if (gun) _addCustomGun(gun, el.dataset.variant);
            } else {
                const att = _graphSearchData.attachments.find(a => a.id === el.dataset.customId);
                if (att) _addCustomAttachment(att);
            }
        });
    });
}

// ===================================================================
//  Custom item management
// ===================================================================

function _addCustomGun(gun, variant) {
    if (_graphCustomMode === "attachments") return;
    _graphCustomMode = "guns";

    const isZh      = (EFTForge.state.lang || "en") === "zh";
    const baseName  = isZh ? (gun.name_zh       || gun.name)       : gun.name;
    const baseShort = isZh ? (gun.short_name_zh  || gun.short_name) : gun.short_name;
    const varLabel  = t(variant === "factory" ? "graph.gunFactory" : "graph.gunStripped");
    const customId  = `${gun.id}:${variant}`;
    const isFactory = variant === "factory";

    const ergo = isFactory
        ? (gun.factory_ergonomics       ?? gun.base_ergonomics      ?? 0)
        : (gun.base_ergonomics          ?? 0);
    const recV = isFactory
        ? (gun.factory_recoil_vertical  ?? gun.recoil_vertical      ?? 0)
        : (gun.recoil_vertical          ?? 0);
    const recH = isFactory
        ? (gun.factory_recoil_horizontal ?? gun.recoil_horizontal   ?? 0)
        : (gun.recoil_horizontal         ?? 0);

    _graphCustomItems.push({
        customId,
        type:             "gun",
        recoilPercent:    0,
        ergoModifier:     ergo,
        contribution:     ergo,
        recoilVertical:   recV,
        recoilHorizontal: recH,
        hasConflict:      false,
        item: {
            id:              customId,
            name:            `${baseName} (${varLabel})`,
            short_name:      `${baseShort} (${varLabel})`,
            base_image_link: isFactory
                ? (gun.image_512_link      || gun.icon_link || "")
                : (gun.bare_image_512_link || gun.base_image_link || gun.icon_link || ""),
            icon_link: isFactory
                ? (gun.image_512_link || gun.icon_link || "")
                : (gun.icon_link      || ""),
        },
    });
    _graphView = null;
    _rebuildCustomGraph();
}

function _addCustomAttachment(att) {
    if (_graphCustomMode === "guns") return;
    _graphCustomMode = "attachments";

    const isZh = (EFTForge.state.lang || "en") === "zh";
    _graphCustomItems.push({
        customId:         att.id,
        type:             "attachment",
        recoilPercent:    (att.recoil_modifier    || 0) * 100,
        ergoModifier:     att.ergonomics_modifier  || 0,
        contribution:     att.ergonomics_modifier  || 0,
        recoilVertical:   0,
        recoilHorizontal: 0,
        hasConflict:      false,
        item: {
            id:              att.id,
            name:            isZh ? (att.name_zh       || att.name)       : att.name,
            short_name:      isZh ? (att.short_name_zh  || att.short_name) : att.short_name,
            base_image_link: att.base_image_link || att.icon_link || "",
            icon_link:       att.icon_link || "",
        },
    });
    _graphView = null;
    _rebuildCustomGraph();
}

function _removeCustomItem(customId) {
    _graphCustomItems = _graphCustomItems.filter(ci => ci.customId !== customId);
    if (_graphCustomItems.length === 0) _graphCustomMode = "empty";
    _rebuildCustomGraph();
}

function _clearCustomItems() {
    _graphCustomItems = [];
    _graphCustomMode  = null;
    _graphView        = null;
    _rebuildCustomGraph();
}

function _regularItemsToCustom() {
    const all   = EFTForge.state.lastProcessedItems || [];
    const query = EFTForge.state.currentSearchQuery || "";
    return (query ? all.filter(e => e.sortName?.includes(query)) : all).map(e => ({
        customId:         e.item.id,
        type:             "attachment",
        recoilPercent:    e.recoilPercent,
        ergoModifier:     e.ergoModifier,
        contribution:     e.contribution,
        recoilVertical:   0,
        recoilHorizontal: 0,
        hasConflict:      e.hasConflict,
        item:             e.item,
    }));
}

function _removeRegularItem(itemId) {
    const remaining = _regularItemsToCustom().filter(ci => ci.customId !== itemId);
    _graphCustomItems = remaining;
    _graphCustomMode  = remaining.length > 0 ? "attachments" : "empty";
    _graphView        = null;
    _rebuildCustomGraph();
}

function _clearRegularItems() {
    _graphCustomItems = [];
    _graphCustomMode  = "empty";  // neutral sentinel: keeps graph empty without locking search
    _graphView        = null;
    _rebuildCustomGraph();
}

function _rebuildCustomGraph() {
    _updateGraphTopBar();
    _updateGraphHeader();
    const panel = document.getElementById("graph-search-panel");
    if (panel && _graphSearchOpen) {
        _refreshGraphSelSection(panel);
        _buildGraphAxisStrip(panel);
        if (_graphSearchData) _renderGraphSearchResults(panel, _graphSearchQuery);
    }
    const svgWrap = document.getElementById("graph-svg-wrap");
    if (svgWrap) _buildGraphSVG(svgWrap);
}

// ===================================================================
//  Core SVG graph rendering
// ===================================================================

function _buildGraphSVG(container, { fromLerp = false } = {}) {
    if (!fromLerp && _graphZoomLerpRaf) {
        cancelAnimationFrame(_graphZoomLerpRaf);
        _graphZoomLerpRaf = null;
        _graphViewTarget  = null;
    }
    const isInitRender = !_graphSVGInitDone;
    _graphSVGInitDone = true;
    _graphZoomController?.abort();
    _graphZoomController = new AbortController();
    const { signal } = _graphZoomController;

    const isGunMode = _graphCustomMode === "guns";
    const isCustom  = _graphCustomMode !== null;

    const _metrics = isGunMode ? _GUN_METRICS : _ATT_METRICS;
    const xMDef    = _metrics.find(m => m.id === (isGunMode ? _graphGunXMetric : _graphAttXMetric)) || _metrics[0];
    const yMDef    = _metrics.find(m => m.id === (isGunMode ? _graphGunYMetric : _graphAttYMetric)) || _metrics[_metrics.length > 1 ? 1 : 0];

    const fmtVal = (mId, v) => {
        if (mId === "recoilVertical" || mId === "recoilHorizontal") return String(Math.round(v));
        if (mId === "recoilPercent") return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
        return `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
    };
    const fmtCh = (mId, v) => {
        if (mId === "recoilVertical")   return `V: ${Math.round(v)}`;
        if (mId === "recoilHorizontal") return `H: ${Math.round(v)}`;
        if (mId === "recoilPercent")    return `R: ${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
        if (mId === "contribution")     return `EE: ${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
        return `Ergo: ${v.toFixed(1)}`;
    };
    const tipLabel = mId => {
        if (mId === "recoilVertical")   return "V";
        if (mId === "recoilHorizontal") return "H";
        if (mId === "recoilPercent")    return t("graph.tooltipRecoil");
        if (mId === "contribution")     return t("graph.tooltipEvoErgo");
        return t("graph.tooltipErgo");
    };

    let items;
    if (isCustom) {
        items = _graphCustomItems;
    } else {
        const allItems = EFTForge.state.lastProcessedItems;
        if (!allItems || !allItems.length) { container.innerHTML = ""; return; }
        const query = EFTForge.state.currentSearchQuery;
        items = query ? allItems.filter(e => e.sortName.includes(query)) : allItems;
    }
    if (!items.length && !isCustom) { container.innerHTML = ""; return; }

    const _rightPanel  = container.closest(".right-panel");
    const _attHeader   = document.querySelector(".att-table-header");
    const _headerH     = _attHeader ? _attHeader.offsetHeight : 60;
    const _availH      = _rightPanel ? _rightPanel.clientHeight : window.innerHeight;
    const _targetH_px  = Math.max(_availH - _headerH - 48, 240);
    const _containerW  = Math.max(container.offsetWidth || 520, 300);
    container.style.height = _targetH_px + "px";
    const W = 520;
    const H = Math.max(Math.round(W * _targetH_px / _containerW), 180);
    const ML = 46, MR = 20, MT = 18, MB = 40;
    const PW = W - ML - MR, PH = H - MT - MB;

    // For axis range: use plotted items when available, else borrow regular items, else hard defaults
    const axisItems = items.length > 0 ? items
        : (!isGunMode ? (EFTForge.state.lastProcessedItems || []) : []);

    let dxMin, dxMax, dyMin, dyMax;
    if (axisItems.length > 0) {
        const xs = axisItems.map(e => xMDef.getValue(e));
        const ys = axisItems.map(e => yMDef.getValue(e));
        dxMin = Math.min(...xs); dxMax = Math.max(...xs);
        dyMin = Math.min(...ys); dyMax = Math.max(...ys);
    } else {
        const xRange = isGunMode ? [100, 400] : [-15, 15];
        const yRange = (isGunMode && yMDef.id === "ergoModifier") ? [30, 80] : [-15, 15];
        [dxMin, dxMax] = xRange; [dyMin, dyMax] = yRange;
    }

    const xRange = Math.max(dxMax - dxMin, isGunMode ? 20 : 0.5);
    const yRange = Math.max(dyMax - dyMin, isGunMode ? 10 : 1);
    dxMin -= xRange * 0.08; dxMax += xRange * 0.08;
    dyMin -= yRange * 0.10; dyMax += yRange * 0.10;
    if (!isGunMode) {
        if (dxMin > 0 && dxMin < xRange * 0.2)  dxMin = 0;
        if (dxMax < 0 && dxMax > -xRange * 0.2) dxMax = 0;
        if (dyMin > 0 && dyMin < yRange * 0.2)  dyMin = 0;
        if (dyMax < 0 && dyMax > -yRange * 0.2) dyMax = 0;
    }

    // Expand auto-fit so icon images don't get clipped at plot edges.
    // Each icon is centered ±iw/2 around the dot horizontally and sits (ih + ICON_GAP) above it.
    {
        const iw0  = 22 * _graphIconScale;
        const ih0  = 22 * _graphIconScale;
        const gap0 =  3 * _graphIconScale;
        const xPad = (iw0 / 2)    / PW * (dxMax - dxMin);
        const yPad = (ih0 + gap0) / PH * (dyMax - dyMin);
        dxMin -= xPad;
        dxMax += xPad;
        // Icons always extend upward from the dot; expand only the "top" data-space direction.
        if (yMDef.lowerBetter) dyMin -= yPad;
        else                   dyMax += yPad;
    }

    const { xMin, xMax, yMin, yMax } = _graphView || { xMin: dxMin, xMax: dxMax, yMin: dyMin, yMax: dyMax };

    // right = better: invert x for lower-is-better metrics (recoil), normal for higher-is-better (ergo)
    // up = better: normal y for higher-is-better (ergo), invert y for lower-is-better (recoil)
    const toX     = xMDef.lowerBetter
        ? x  => ML + (xMax - x)  / (xMax - xMin) * PW
        : x  => ML + (x - xMin)  / (xMax - xMin) * PW;
    const toY     = yMDef.lowerBetter
        ? y  => MT + (y - yMin)  / (yMax - yMin) * PH
        : y  => MT + (1 - (y - yMin) / (yMax - yMin)) * PH;
    const toDataX = xMDef.lowerBetter
        ? sx => xMax - (sx - ML) / PW * (xMax - xMin)
        : sx => xMin + (sx - ML) / PW * (xMax - xMin);
    const toDataY = yMDef.lowerBetter
        ? sy => yMin + (sy - MT) / PH * (yMax - yMin)
        : sy => yMin + (1 - (sy - MT) / PH) * (yMax - yMin);

    function niceTicks(lo, hi, target) {
        const range = hi - lo;
        const rough = range / target;
        const mag   = Math.pow(10, Math.floor(Math.log10(Math.abs(rough) || 1)));
        const norm  = rough / mag;
        const step  = norm <= 1.5 ? mag : norm <= 3 ? 2*mag : norm <= 7 ? 5*mag : 10*mag;
        const ticks = [];
        for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v = +(v + step).toFixed(10))
            ticks.push(+v.toFixed(8));
        return ticks;
    }

    const xTicks = niceTicks(xMin, xMax, 6);
    const yTicks = niceTicks(yMin, yMax, 5);

    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="att-graph-svg" preserveAspectRatio="none">`;
    s += `<defs>` +
         `<clipPath id="plot-clip"><rect x="${ML}" y="${MT}" width="${PW}" height="${PH}"/></clipPath>` +
         `<filter id="icon-shadow" x="-30%" y="-30%" width="160%" height="160%">` +
         `<feDropShadow dx="0" dy="0" stdDeviation="1.8" flood-color="#000" flood-opacity="0.85"/>` +
         `</filter>` +
         `</defs>`;
    s += `<rect x="${ML}" y="${MT}" width="${PW}" height="${PH}" fill="#0d0d0d" rx="2"/>`;

    s += `<g${isInitRender ? ' class="graph-grid-init"' : ''}>`;
    for (const tx of xTicks) {
        const sx = toX(tx).toFixed(1);
        s += `<line x1="${sx}" y1="${MT}" x2="${sx}" y2="${MT+PH}" stroke="#222" stroke-width="1"/>`;
    }
    for (const ty of yTicks) {
        const sy = toY(ty).toFixed(1);
        s += `<line x1="${ML}" y1="${sy}" x2="${ML+PW}" y2="${sy}" stroke="#222" stroke-width="1"/>`;
    }
    const zx = toX(0), zy = toY(0);
    if (zx >= ML && zx <= ML+PW) s += `<line x1="${zx.toFixed(1)}" y1="${MT}" x2="${zx.toFixed(1)}" y2="${MT+PH}" stroke="#363636" stroke-width="1" stroke-dasharray="4,3"/>`;
    if (zy >= MT && zy <= MT+PH) s += `<line x1="${ML}" y1="${zy.toFixed(1)}" x2="${ML+PW}" y2="${zy.toFixed(1)}" stroke="#363636" stroke-width="1" stroke-dasharray="4,3"/>`;
    s += `</g>`;

    s += `<g${isInitRender ? ' class="graph-labels-init"' : ''} font-size="8" fill="#555" font-family="Bender,Arial,sans-serif" style="user-select:none;pointer-events:none">`;
    for (const tx of xTicks) {
        const lbl = (xMDef.id === "recoilVertical" || xMDef.id === "recoilHorizontal")
            ? String(Math.round(tx))
            : tx === 0 ? "0" : `${tx>0?"+":""}${parseFloat(tx.toFixed(2))}${xMDef.id === "recoilPercent" ? "%" : ""}`;
        s += `<text x="${toX(tx).toFixed(1)}" y="${MT+PH+14}" text-anchor="middle">${lbl}</text>`;
    }
    for (const ty of yTicks) {
        const lbl = (yMDef.id === "recoilVertical" || yMDef.id === "recoilHorizontal")
            ? String(Math.round(ty))
            : ty === 0 ? "0" : `${ty>0?"+":""}${parseFloat(ty.toFixed(2))}`;
        s += `<text x="${ML-5}" y="${(toY(ty)+3.5).toFixed(1)}" text-anchor="end">${lbl}</text>`;
    }
    s += `<text x="${(ML+PW/2).toFixed(1)}" y="${H-4}" text-anchor="middle" fill="#666" style="user-select:none;pointer-events:none">${t(xMDef.axisKey)}</text>`;
    s += `<text x="8" y="${(MT+PH/2).toFixed(1)}" text-anchor="middle" fill="#666" transform="rotate(-90,8,${(MT+PH/2).toFixed(1)})" style="user-select:none;pointer-events:none">${t(yMDef.axisKey)}</text>`;
    s += `</g>`;

    const iw = 22 * _graphIconScale, ih = 22 * _graphIconScale;
    const FONT_SZ  = 4.5 * _graphIconScale;
    const ICON_GAP = 3   * _graphIconScale;
    const pts = [...items].sort((a, b) => (a.hasConflict ? 0 : 1) - (b.hasConflict ? 0 : 1));
    const xLblTip = tipLabel(xMDef.id);
    const yLblTip = tipLabel(yMDef.id);
    const plotPts = pts.map(e => {
        const xVal = xMDef.getValue(e);
        const yVal = yMDef.getValue(e);
        const ox   = toX(xVal), oy = toY(yVal);
        const xStr = fmtVal(xMDef.id, xVal);
        const yStr = fmtVal(yMDef.id, yVal);
        const cls  = `att-graph-dot${e.hasConflict ? "" : (isCustom ? " graph-custom-dot" : " att-graph-dot-click")}`;
        const shortName = e.item.short_name || e.item.name || "";
        return { e, ox, oy, xStr, yStr, cls, shortName };
    });

    {
        const posMap = new Map();
        for (const p of plotPts) {
            const k = `${p.ox.toFixed(2)},${p.oy.toFixed(2)}`;
            if (!posMap.has(k)) posMap.set(k, []);
            posMap.get(k).push(p);
        }
        const clusters = [...posMap.values()];

        s += `<g clip-path="url(#plot-clip)">`;
        let dotAnimIdx = 0;
        for (const cluster of clusters) {
            const isMulti   = cluster.length > 1;
            const key       = isMulti ? cluster.map(p => p.e.item.id).sort().join(",") : null;
            const activeIdx = isMulti ? ((_graphClusterState[key] ?? 0) % cluster.length) : 0;
            const p         = cluster[activeIdx];
            const { e, ox, oy, xStr, yStr, cls, shortName } = p;
            const x  = ox, y = oy - ih / 2 - ICON_GAP;
            const ix = (x - iw / 2).toFixed(1), iy = (y - ih / 2).toFixed(1);

            let tipAttr;
            if (isMulti) {
                let html = `<div class='graph-cluster-tip'>`;
                for (let i = 0; i < cluster.length; i++) {
                    const cp  = cluster[i];
                    const src = (cp.e.item.base_image_link || cp.e.item.icon_link || "").replace(/'/g, "%27");
                    html += `<div class='gct-row${i === activeIdx ? " gct-active" : ""}'>`;
                    html += `<img src='${src}' style='width:20px;height:20px;object-fit:contain'>`;
                    html += `<span>${escapeHtml(cp.shortName)}</span></div>`;
                }
                html += `<div class='gct-stats'>${xLblTip}: ${xStr} &nbsp; ${yLblTip}: ${yStr}</div>`;
                html += `<div class='gct-hint'>${t("graph.hintCycle")}</div></div>`;
                tipAttr = `data-tooltip-html="${escapeHtml(html)}"`;
            } else {
                const src = (e.item.base_image_link || e.item.icon_link || "").replace(/'/g, "%27");
                let html = `<div style='display:flex;align-items:center;gap:8px'>`;
                html += `<img src='${src}' style='width:36px;height:36px;object-fit:contain;flex-shrink:0'>`;
                html += `<div><div style='color:#ddd;font-size:12px;margin-bottom:3px'>${escapeHtml(e.item.name)}</div>`;
                html += `<div style='color:#888;font-size:11px'>${xLblTip}: ${xStr} &nbsp; ${yLblTip}: ${yStr}</div>`;
                html += `</div></div>`;
                tipAttr = `data-tooltip-html="${escapeHtml(html)}"`;
            }

            const _dotCls   = `${cls}${isMulti ? " graph-cluster" : ""}${isInitRender ? " graph-dot-appear" : ""}`;
            const _dotStyle = isInitRender ? ` style="--dot-i:${Math.min(dotAnimIdx, 20)}"` : ``;
            s += `<g class="${_dotCls}" data-item-id="${escapeHtml(String(e.item.id))}"${isMulti ? ` data-cluster-key="${escapeHtml(key)}" data-cluster-count="${cluster.length}"` : ""}${_dotStyle} ${tipAttr}>`;
            dotAnimIdx++;
            s += `<circle class="graph-dot-ring" cx="${ox.toFixed(1)}" cy="${oy.toFixed(1)}" r="4.5" fill="none" stroke="#f5c542" stroke-width="0.8" stroke-opacity="0" pointer-events="none"/>`;
            s += `<circle cx="${ox.toFixed(1)}" cy="${oy.toFixed(1)}" r="1.5" fill="#f5c542"/>`;
            s += `<image href="${escapeHtml(e.item.base_image_link || e.item.icon_link)}" x="${ix}" y="${iy}" width="${iw}" height="${ih}" preserveAspectRatio="xMidYMid meet" filter="url(#icon-shadow)"/>`;
            if (_graphLabelsEnabled) {
                const txY = (y + ih / 2 + FONT_SZ - 7).toFixed(1);
                s += `<text class="graph-item-name" x="${x.toFixed(1)}" y="${txY}" text-anchor="middle" font-size="${FONT_SZ}">${escapeHtml(shortName)}</text>`;
            }
            if (isMulti && _graphLabelsEnabled) {
                const bx = (x + iw / 2).toFixed(1);
                const by = (y - ih / 2).toFixed(1);
                s += `<circle cx="${bx}" cy="${by}" r="${(3.5 * _graphIconScale).toFixed(1)}" fill="#f5c542" pointer-events="none"/>`;
                s += `<text x="${bx}" y="${by}" text-anchor="middle" dominant-baseline="central" font-size="${(4.5 * _graphIconScale).toFixed(1)}" font-weight="bold" fill="#111" font-family="Bender,Arial,sans-serif" pointer-events="none" style="user-select:none">${cluster.length}</text>`;
            }
            s += `</g>`;
        }
        s += `</g>`;
    }

    // Crosshair overlay
    s += `<g id="graph-crosshair" visibility="hidden" pointer-events="none">`;
    s += `<g clip-path="url(#plot-clip)">`;
    s += `<line id="graph-ch-vt" stroke="#f5c542" stroke-width="0.6" stroke-opacity="0.25"/>`;
    s += `<line id="graph-ch-vb" stroke="#f5c542" stroke-width="0.6" stroke-opacity="0.25"/>`;
    s += `<line id="graph-ch-hl" stroke="#f5c542" stroke-width="0.6" stroke-opacity="0.25"/>`;
    s += `<line id="graph-ch-hr" stroke="#f5c542" stroke-width="0.6" stroke-opacity="0.25"/>`;
    s += `<circle id="graph-ch-dot" r="1.8" fill="none" stroke="#f5c542" stroke-width="0.7" stroke-opacity="0.5"/>`;
    s += `</g>`;
    s += `<text id="graph-ch-tx" font-size="7" fill="#f5c54299" font-family="Bender,Arial,sans-serif"/>`;
    s += `<text id="graph-ch-ty" font-size="7" fill="#f5c54299" font-family="Bender,Arial,sans-serif"/>`;
    s += `</g>`;

    s += `<rect x="${ML}" y="${MT}" width="${PW}" height="${PH}" fill="none" stroke="#2a2a2a" stroke-width="1" rx="2"/>`;

    if (_graphHintsEnabled) {
        const hintX = ML + PW - 5, hintY = MT + 9;
        s += `<g class="graph-hints-watermark" font-size="7" fill="#3a3a3a" font-family="Bender,Arial,sans-serif" text-anchor="end" style="user-select:none;pointer-events:none">`;
        s += `<text x="${hintX}" y="${hintY}">${t("graph.hintPan")}</text>`;
        s += `<text x="${hintX}" y="${hintY + 9}">${t("graph.hintScroll")}</text>`;
        s += `<text x="${hintX}" y="${hintY + 18}">${t("graph.hintBoxZoom")}</text>`;
        s += `<text x="${hintX}" y="${hintY + 27}">${t("graph.hintReset")}</text>`;
        s += `</g>`;
    }

    // Control buttons - vertical column on right side of SVG
    {
        const bx   = W - 16;
        const by0  = MT;
        const bGap = 16;

        // Slot 0: Crosshair toggle
        const chActive = _graphCrosshairEnabled;
        const ic = chActive ? "#f5c542" : "#555";
        s += `<g class="graph-ch-toggle-btn" style="cursor:pointer" data-tooltip="${chActive ? t("graph.hideCrosshair") : t("graph.showCrosshair")}">`;
        s += `<rect x="${bx}" y="${by0}" width="14" height="14" rx="2" fill="#1e1e1e" stroke="${chActive ? "#f5c542" : "#3a3a3a"}" stroke-width="0.5"/>`;
        s += `<svg x="${bx + 3}" y="${by0 + 3}" width="8" height="8" viewBox="0 0 18 18" fill="none">`;
        s += `<circle cx="9" cy="9" r="7.5" stroke="${ic}" stroke-width="1.5"/>`;
        s += `<circle cx="9" cy="9" r="3.5" stroke="${ic}" stroke-width="1.5"/>`;
        s += `<line x1="9" y1="1.5" x2="9" y2="5" stroke="${ic}" stroke-width="1.5" stroke-linecap="round"/>`;
        s += `<line x1="9" y1="13" x2="9" y2="16.5" stroke="${ic}" stroke-width="1.5" stroke-linecap="round"/>`;
        s += `<line x1="1.5" y1="9" x2="5" y2="9" stroke="${ic}" stroke-width="1.5" stroke-linecap="round"/>`;
        s += `<line x1="13" y1="9" x2="16.5" y2="9" stroke="${ic}" stroke-width="1.5" stroke-linecap="round"/>`;
        s += `</svg></g>`;

        // Slot 1: Labels toggle
        const lbActive = _graphLabelsEnabled;
        const lc = lbActive ? "#f5c542" : "#555";
        s += `<g class="graph-lbl-toggle-btn" style="cursor:pointer" data-tooltip="${lbActive ? t("graph.hideLabels") : t("graph.showLabels")}">`;
        s += `<rect x="${bx}" y="${by0 + bGap}" width="14" height="14" rx="2" fill="#1e1e1e" stroke="${lbActive ? "#f5c542" : "#3a3a3a"}" stroke-width="0.5"/>`;
        s += `<text x="${bx + 7}" y="${by0 + bGap + 10.5}" text-anchor="middle" font-size="8" font-weight="bold" fill="${lc}" font-family="Bender,Arial,sans-serif" style="user-select:none">A</text>`;
        s += `</g>`;

        const hintsSlot  = 2;
        const exportSlot = 3;
        const resetSlot  = 4;
        const scaleSlot  = 5;

        // Hints toggle
        const hActive = _graphHintsEnabled;
        const hc = hActive ? "#f5c542" : "#555";
        s += `<g class="graph-hints-toggle-btn" style="cursor:pointer" data-tooltip="${hActive ? t("graph.hideHints") : t("graph.showHints")}">`;
        s += `<rect x="${bx}" y="${by0 + bGap * hintsSlot}" width="14" height="14" rx="2" fill="#1e1e1e" stroke="${hActive ? "#f5c542" : "#3a3a3a"}" stroke-width="0.5"/>`;
        s += `<text x="${bx + 7}" y="${by0 + bGap * hintsSlot + 10.5}" text-anchor="middle" font-size="9" font-weight="bold" fill="${hc}" font-family="Bender,Arial,sans-serif" style="user-select:none">?</text>`;
        s += `</g>`;

        // Export button
        s += `<g class="graph-export-btn" style="cursor:pointer" data-tooltip="${t("graph.export")}">`;
        s += `<rect x="${bx}" y="${by0 + bGap * exportSlot}" width="14" height="14" rx="2" fill="#1e1e1e" stroke="#3a3a3a" stroke-width="0.5"/>`;
        s += `<svg x="${bx + 2}" y="${by0 + bGap * exportSlot + 2}" width="10" height="10" viewBox="0 0 18 18" fill="none">`;
        s += `<line x1="9" y1="2" x2="9" y2="12" stroke="#aaa" stroke-width="1.8" stroke-linecap="round"/>`;
        s += `<polyline points="5.5,9 9,13 12.5,9" stroke="#aaa" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
        s += `<line x1="3" y1="16.5" x2="15" y2="16.5" stroke="#aaa" stroke-width="1.8" stroke-linecap="round"/>`;
        s += `</svg></g>`;

        // Reset zoom button (only when zoomed)
        if (_graphView !== null) {
            s += `<g class="graph-reset-svg-btn" style="cursor:pointer" data-tooltip="${t("graph.resetZoom")}">`;
            s += `<rect x="${bx}" y="${by0 + bGap * resetSlot}" width="14" height="14" rx="2" fill="#1e1e1e" stroke="#3a3a3a" stroke-width="0.5"/>`;
            s += `<text x="${bx + 7}" y="${by0 + bGap * resetSlot + 10}" text-anchor="middle" font-size="9" fill="#888" font-family="Arial,sans-serif" style="user-select:none">&#x21BA;</text>`;
            s += `</g>`;
        }

        // Scale icon + vertical slider
        const scaleIconY = by0 + bGap * scaleSlot;
        const trackX     = bx + 7;
        const trackTop   = scaleIconY + 18;
        const trackBot   = H - MB + 8;
        const trackH_sv  = trackBot - trackTop;
        const scNorm     = (_graphIconScale - 1.0) / (2.0 - 1.0);
        const thumbY     = trackTop + trackH_sv * (1 - scNorm);

        s += `<g class="graph-scale-slider">`;
        s += `<g class="graph-scale-icon-g" data-tooltip="${escapeHtml(t("graph.iconScale"))}" style="cursor:default">`;
        s += `<rect x="${bx}" y="${scaleIconY}" width="14" height="14" fill="transparent" pointer-events="all"/>`;
        s += `<svg x="${bx + 2}" y="${scaleIconY + 2}" width="10" height="10" viewBox="0 0 18 18" fill="none">`;
        s += `<rect x="1" y="7" width="9" height="9" rx="1.5" stroke="#555" stroke-width="1.5"/>`;
        s += `<rect x="7" y="1" width="10" height="10" rx="1.5" stroke="#888" stroke-width="1.5"/>`;
        s += `</svg></g>`;
        s += `<line x1="${trackX}" y1="${trackTop}" x2="${trackX}" y2="${trackBot}" stroke="#252525" stroke-width="1.5" stroke-linecap="round"/>`;
        s += `<line x1="${trackX}" y1="${thumbY.toFixed(1)}" x2="${trackX}" y2="${trackBot}" stroke="#444" stroke-width="1.5" stroke-linecap="round"/>`;
        s += `<circle class="graph-scale-thumb" cx="${trackX}" cy="${thumbY.toFixed(1)}" r="2.5" fill="#444" stroke="#666" stroke-width="0.6" style="cursor:grab"/>`;
        s += `</g>`;
    }

    // Graph Properties button - top-left of SVG, above the plot area
    const rawPropsLabel = t("graph.graphProperties");
    const propsBtnLabel = escapeHtml(rawPropsLabel);
    const isZhLang  = (EFTForge.state.lang || "en") === "zh";
    const propsBtnW = Math.ceil(rawPropsLabel.length * (isZhLang ? 7 : 4.2)) + 10;
    const propsBtnH = 11, propsBtnX = ML, propsBtnY = 1;
    const propsFill   = _graphSearchOpen ? "#1a1800" : "#181818";
    const propsStroke = _graphSearchOpen ? "#f5c542" : "#333";
    const propsColor  = _graphSearchOpen ? "#f5c542" : "#888";
    s += `<g class="graph-props-btn" style="cursor:pointer">`;
    s += `<rect x="${propsBtnX}" y="${propsBtnY}" width="${propsBtnW}" height="${propsBtnH}" rx="2" fill="${propsFill}" stroke="${propsStroke}" stroke-width="0.6"/>`;
    s += `<text x="${propsBtnX + 5}" y="${propsBtnY + 8}" font-size="7" font-family="Bender,Arial,sans-serif" fill="${propsColor}" style="user-select:none;pointer-events:none">${propsBtnLabel}</text>`;
    s += `</g>`;

    s += `</svg>`;
    container.innerHTML = s;

    // Restore hover-dim state immediately after rebuild so cluster cycling doesn't flicker.
    // graph-instant suppresses the opacity transition for the first paint so new elements
    // don't animate from 1.0 → 0.2 (which was the visible flicker).
    if (_graphHoveredItemId) {
        const svg0 = container.querySelector("svg");
        // Cluster key is stable across cycles; item ID is used for single dots
        const el = svg0?.querySelector(`.att-graph-dot[data-cluster-key="${CSS.escape(_graphHoveredItemId)}"]`)
                ?? svg0?.querySelector(`.att-graph-dot[data-item-id="${CSS.escape(_graphHoveredItemId)}"]`);
        if (el) {
            svg0.classList.add("has-hover", "graph-instant");
            el.classList.add("graph-dot-hovered");
            requestAnimationFrame(() => svg0.classList.remove("graph-instant"));
        } else {
            _graphHoveredItemId = null;
        }
    }

    // ---- Interactions ----
    const svg = container.querySelector("svg");

    function svgPoint(e) {
        const rect = svg.getBoundingClientRect();
        return {
            sx: (e.clientX - rect.left) / rect.width  * W,
            sy: (e.clientY - rect.top)  / rect.height * H,
        };
    }
    function inPlot(sx, sy) {
        return sx >= ML && sx <= ML + PW && sy >= MT && sy <= MT + PH;
    }
    function _runLerpStep() {
        const base = _graphView || { xMin: dxMin, xMax: dxMax, yMin: dyMin, yMax: dyMax };
        const tgt = _graphViewTarget;
        if (!tgt) { _graphZoomLerpRaf = null; return; }
        const LERP = 0.25;
        const nx = {
            xMin: base.xMin + (tgt.xMin - base.xMin) * LERP,
            xMax: base.xMax + (tgt.xMax - base.xMax) * LERP,
            yMin: base.yMin + (tgt.yMin - base.yMin) * LERP,
            yMax: base.yMax + (tgt.yMax - base.yMax) * LERP,
        };
        const span = Math.max(Math.abs(tgt.xMax - tgt.xMin) || 1, Math.abs(tgt.yMax - tgt.yMin) || 1);
        const done = Math.abs(nx.xMin - tgt.xMin) < span * 0.005 &&
                     Math.abs(nx.xMax - tgt.xMax) < span * 0.005 &&
                     Math.abs(nx.yMin - tgt.yMin) < span * 0.005 &&
                     Math.abs(nx.yMax - tgt.yMax) < span * 0.005;
        _graphView = done ? (_graphLerpEndNull ? null : { ...tgt }) : nx;
        if (done) { _graphViewTarget = null; _graphZoomLerpRaf = null; _graphLerpEndNull = false; }
        _buildGraphSVG(container, { fromLerp: true });
        if (!done) _graphZoomLerpRaf = requestAnimationFrame(_runLerpStep);
    }
    function resetZoom() {
        if (_graphView === null) return;
        _graphLerpEndNull = true;
        _graphViewTarget = { xMin: dxMin, xMax: dxMax, yMin: dyMin, yMax: dyMax };
        if (_graphZoomLerpRaf) return;  // existing lerp will pick up the new target
        _graphZoomLerpRaf = requestAnimationFrame(_runLerpStep);
    }

    container.querySelector(".graph-reset-svg-btn")?.addEventListener("click", (e) => {
        e.stopPropagation(); resetZoom();
    });
    container.querySelector(".graph-ch-toggle-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        _graphCrosshairEnabled = !_graphCrosshairEnabled;
        localStorage.setItem("eftforge_graph_crosshair", _graphCrosshairEnabled ? "1" : "0");
        _buildGraphSVG(container);
    });
    container.querySelector(".graph-lbl-toggle-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        _graphLabelsEnabled = !_graphLabelsEnabled;
        localStorage.setItem("eftforge_graph_labels", _graphLabelsEnabled ? "1" : "0");
        _buildGraphSVG(container);
    });
    container.querySelector(".graph-hints-toggle-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        _graphHintsEnabled = !_graphHintsEnabled;
        localStorage.setItem("eftforge_graph_hints", _graphHintsEnabled ? "1" : "0");
        _buildGraphSVG(container);
    });
    container.querySelector(".graph-export-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        _exportGraph(container);
    });
    const propsBtn = container.querySelector(".graph-props-btn");
    if (propsBtn) {
        const pRect = propsBtn.querySelector("rect");
        const pText = propsBtn.querySelector("text");
        propsBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            _graphSearchOpen = !_graphSearchOpen;
            const panel = document.getElementById("graph-search-panel");
            if (panel) {
                if (_graphSearchOpen) {
                    panel.style.display = "";
                    panel.classList.remove("graph-panel-closing");
                    void panel.offsetWidth;
                    panel.classList.add("graph-panel-open");
                    panel.addEventListener("animationend", () => panel.classList.remove("graph-panel-open"), { once: true });
                    _buildGraphSearchPanel(panel);
                } else {
                    panel.classList.remove("graph-panel-open");
                    panel.classList.add("graph-panel-closing");
                    panel.addEventListener("animationend", () => {
                        panel.style.display = "none";
                        panel.classList.remove("graph-panel-closing");
                    }, { once: true });
                }
            }
            _buildGraphSVG(container);
        });
        propsBtn.addEventListener("mouseenter", () => {
            pRect.setAttribute("fill",   _graphSearchOpen ? "#252000" : "#222");
            pRect.setAttribute("stroke", _graphSearchOpen ? "#f5c542" : "#555");
            pText.setAttribute("fill",   "#f5c542");
        });
        propsBtn.addEventListener("mouseleave", () => {
            pRect.setAttribute("fill",   _graphSearchOpen ? "#1a1800" : "#181818");
            pRect.setAttribute("stroke", _graphSearchOpen ? "#f5c542" : "#333");
            pText.setAttribute("fill",   _graphSearchOpen ? "#f5c542" : "#888");
        });
    }

    // Position the panel below the SVG button (computed after layout)
    requestAnimationFrame(() => {
        const panel = document.getElementById("graph-search-panel");
        if (!panel || !svg) return;
        const topPx = Math.round((propsBtnY + propsBtnH + 2) / H * svg.offsetHeight);
        panel.style.top    = `${topPx}px`;
        panel.style.height = `calc(100% - ${topPx}px)`;
    });

    // Close panel on mousedown outside (mousedown because SVG's e.preventDefault on plot area suppresses click events)
    document.addEventListener("mousedown", e => {
        if (!_graphSearchOpen) return;
        const panel = document.getElementById("graph-search-panel");
        if (panel && !panel.contains(e.target) && propsBtn && !propsBtn.contains(e.target)) {
            _closeGraphPanel();
            _buildGraphSVG(container);
        }
    }, { signal });

    // Scale slider drag
    const scaleThumb = container.querySelector(".graph-scale-thumb");
    if (scaleThumb) {
        const TRACK_TOP = MT + 16 * (isGunMode ? 7 : 6) + 18;
        const TRACK_BOT = H - MB + 8;
        const TRACK_H   = TRACK_BOT - TRACK_TOP;

        scaleThumb.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            const startY   = e.clientY;
            const startVal = _graphIconScale;
            let latestY    = startY;
            let rafPending = false;

            function onMove(ev) {
                latestY = ev.clientY;
                if (rafPending) return;
                rafPending = true;
                requestAnimationFrame(() => {
                    rafPending = false;
                    const svgEl = container.querySelector("svg");
                    if (!svgEl) return;
                    const rect    = svgEl.getBoundingClientRect();
                    const dy      = latestY - startY;
                    const dScale  = -dy / (TRACK_H * (rect.height / H)) * (2.0 - 1.0);
                    const next    = Math.min(2.0, Math.max(1.0, startVal + dScale));
                    const snapped = Math.round(next * 20) / 20;
                    if (snapped === _graphIconScale) return;
                    _graphIconScale = snapped;
                    _buildGraphSVG(container);
                });
            }
            function onUp() {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup",   onUp);
                localStorage.setItem("eftforge_graph_icon_scale", String(_graphIconScale));
            }
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup",   onUp);
        }, { signal });
    }

    // Track hovered dot for flicker-free dim restoration after SVG rebuilds.
    // Use cluster key for cluster dots (stable across cycles) and item ID for singles.
    container.querySelectorAll(".att-graph-dot").forEach(dotEl => {
        dotEl.addEventListener("mouseenter", () => {
            _graphHoveredItemId = dotEl.dataset.clusterKey ?? dotEl.dataset.itemId;
            svg.classList.add("has-hover");
            dotEl.classList.add("graph-dot-hovered");
        }, { signal });
        dotEl.addEventListener("mouseleave", () => {
            _graphHoveredItemId = null;
            svg.classList.remove("has-hover");
            dotEl.classList.remove("graph-dot-hovered");
        }, { signal });
    });

    // Cluster scroll + arrow-key cycling
    container.querySelectorAll(".graph-cluster").forEach(clusterEl => {
        clusterEl.addEventListener("wheel", (e) => {
            e.preventDefault(); e.stopPropagation();
            const key   = clusterEl.dataset.clusterKey;
            const count = parseInt(clusterEl.dataset.clusterCount, 10);
            _graphClusterState[key] = ((_graphClusterState[key] ?? 0) + (e.deltaY > 0 ? 1 : -1) + count) % count;
            _buildGraphSVG(container);
        }, { passive: false, signal });
        clusterEl.addEventListener("mouseenter", () => {
            _graphHoveredCluster = { key: clusterEl.dataset.clusterKey, count: parseInt(clusterEl.dataset.clusterCount, 10) };
        }, { signal });
        clusterEl.addEventListener("mouseleave", () => {
            _graphHoveredCluster = null;
        }, { signal });
    });

    document.addEventListener("keydown", (e) => {
        if (!_graphHoveredCluster) return;
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        const { key, count } = _graphHoveredCluster;
        _graphClusterState[key] = ((_graphClusterState[key] ?? 0) + (e.key === "ArrowDown" ? 1 : -1) + count) % count;
        _buildGraphSVG(container);
    }, { signal });

    svg.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (inPlot(svgPoint(e).sx, svgPoint(e).sy)) resetZoom();
    }, { signal });

    // Wheel: zoom or pan
    let wheelAccum = 0, panAccumX = 0, panAccumY = 0, wheelRaf = null;
    let lastWheelPt = { sx: ML + PW / 2, sy: MT + PH / 2 };

    svg.addEventListener("wheel", (e) => {
        e.preventDefault();
        const pt = svgPoint(e);
        if (!inPlot(pt.sx, pt.sy)) return;

        const isPan = !e.ctrlKey && (e.deltaX !== 0 || (e.deltaMode === 0 && Math.abs(e.deltaY) < 50));
        if (isPan) {
            const rect = svg.getBoundingClientRect();
            panAccumX += e.deltaX / rect.width  * W * 0.5;
            panAccumY += e.deltaY / rect.height * H * 0.5;
        } else if (e.ctrlKey) {
            lastWheelPt = pt;
            wheelAccum += e.deltaY * 2;
        } else {
            _showGraphScrollHint(container);
            return;
        }

        if (wheelRaf) return;
        wheelRaf = requestAnimationFrame(() => {
            wheelRaf = null;
            const cur = _graphView || { xMin: dxMin, xMax: dxMax, yMin: dyMin, yMax: dyMax };
            let hasZoom = false;
            if (wheelAccum !== 0) {
                hasZoom = true;
                _graphLerpEndNull = false;  // zoom overrides any pending reset-to-null
                const factor = Math.pow(1.5, wheelAccum / 400);
                wheelAccum = 0;
                const cx = toDataX(lastWheelPt.sx), cy = toDataY(lastWheelPt.sy);
                const base = _graphViewTarget || cur;
                _graphViewTarget = {
                    xMin: cx + (base.xMin - cx) * factor, xMax: cx + (base.xMax - cx) * factor,
                    yMin: cy + (base.yMin - cy) * factor, yMax: cy + (base.yMax - cy) * factor,
                };
                [_graphViewTarget.xMin, _graphViewTarget.xMax] = _clampZoomSpan(_graphViewTarget.xMin, _graphViewTarget.xMax, dxMin, dxMax);
                [_graphViewTarget.yMin, _graphViewTarget.yMax] = _clampZoomSpan(_graphViewTarget.yMin, _graphViewTarget.yMax, dyMin, dyMax);
            }
            if (panAccumX !== 0 || panAccumY !== 0) {
                const base = _graphViewTarget || cur;
                const xSS = xMDef.lowerBetter ? -1 : 1;
                const ySS = yMDef.lowerBetter ? 1 : -1;
                const dDataX = xSS * panAccumX / PW * (base.xMax - base.xMin);
                const dDataY = ySS * panAccumY / PH * (base.yMax - base.yMin);
                panAccumX = 0; panAccumY = 0;
                if (hasZoom) {
                    _graphViewTarget = {
                        xMin: _graphViewTarget.xMin + dDataX, xMax: _graphViewTarget.xMax + dDataX,
                        yMin: _graphViewTarget.yMin + dDataY, yMax: _graphViewTarget.yMax + dDataY,
                    };
                } else {
                    _graphView = {
                        xMin: base.xMin + dDataX, xMax: base.xMax + dDataX,
                        yMin: base.yMin + dDataY, yMax: base.yMax + dDataY,
                    };
                    _buildGraphSVG(container);
                    return;
                }
            }
            if (!hasZoom) return;
            if (_graphZoomLerpRaf) return;  // lerp already running, picks up new target naturally
            _graphZoomLerpRaf = requestAnimationFrame(_runLerpStep);
        });
    }, { passive: false });

    // Middle-drag pan + box zoom / click
    let dragState = null;

    svg.addEventListener("mousedown", (e) => {
        if (e.button === 1) {
            e.preventDefault();
            const pt = svgPoint(e);
            if (!inPlot(pt.sx, pt.sy)) return;
            _graphPanState = { last: pt };
            svg.style.cursor = "grabbing";
            return;
        }
        if (e.button !== 0) return;
        const pt = svgPoint(e);
        if (!inPlot(pt.sx, pt.sy)) return;
        e.preventDefault();
        const boxEl = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        boxEl.setAttribute("class", "graph-zoom-box");
        boxEl.setAttribute("x", pt.sx.toFixed(1)); boxEl.setAttribute("y", pt.sy.toFixed(1));
        boxEl.setAttribute("width", "0");          boxEl.setAttribute("height", "0");
        svg.appendChild(boxEl);
        dragState = { start: pt, moved: false, boxEl };
    }, { signal });

    window.addEventListener("mousemove", (e) => {
        if (_graphPanState) {
            const pt = svgPoint(e);
            const dx = pt.sx - _graphPanState.last.sx;
            const dy = pt.sy - _graphPanState.last.sy;
            _graphPanState.last = pt;
            if (!_graphPanDelta) _graphPanDelta = { x: 0, y: 0 };
            _graphPanDelta.x += dx; _graphPanDelta.y += dy;
            if (!_graphPanRaf) {
                _graphPanRaf = requestAnimationFrame(() => {
                    _graphPanRaf = null;
                    const d   = _graphPanDelta; _graphPanDelta = null;
                    const cur = _graphView || { xMin: dxMin, xMax: dxMax, yMin: dyMin, yMax: dyMax };
                    const xPS = xMDef.lowerBetter ? 1 : -1;
                    const yPS = yMDef.lowerBetter ? -1 : 1;
                    _graphView = {
                        xMin: cur.xMin + xPS * d.x / PW * (cur.xMax - cur.xMin),
                        xMax: cur.xMax + xPS * d.x / PW * (cur.xMax - cur.xMin),
                        yMin: cur.yMin + yPS * d.y / PH * (cur.yMax - cur.yMin),
                        yMax: cur.yMax + yPS * d.y / PH * (cur.yMax - cur.yMin),
                    };
                    _buildGraphSVG(container);
                });
            }
            return;
        }
        if (!dragState) return;
        const pt = svgPoint(e);
        const dx = pt.sx - dragState.start.sx, dy = pt.sy - dragState.start.sy;
        if (!dragState.moved && Math.hypot(dx, dy) < 4) return;
        dragState.moved = true;
        dragState.boxEl.setAttribute("x",      Math.min(pt.sx, dragState.start.sx).toFixed(1));
        dragState.boxEl.setAttribute("y",      Math.min(pt.sy, dragState.start.sy).toFixed(1));
        dragState.boxEl.setAttribute("width",  Math.abs(dx).toFixed(1));
        dragState.boxEl.setAttribute("height", Math.abs(dy).toFixed(1));
    }, { signal });

    window.addEventListener("mouseup", (e) => {
        if (e.button === 1 && _graphPanState) {
            _graphPanState = null;
            svg.style.cursor = "";
            return;
        }
        if (!dragState) return;
        const state = dragState;
        dragState = null;
        state.boxEl.remove();

        if (!state.moved) {
            if (isCustom) {
                // Click on custom dot removes it from selection
                const dot = e.target.closest?.(".graph-custom-dot");
                if (dot) _removeCustomItem(dot.dataset.itemId);
            } else {
                // Click on normal dot scrolls to the attachment row
                const dot = e.target.closest?.(".att-graph-dot-click");
                if (dot) {
                    const itemId = dot.dataset.itemId;
                    setGraphView(false);
                    requestAnimationFrame(() => {
                        const row = document.querySelector(`tr[data-item-id="${CSS.escape(itemId)}"]`);
                        if (!row) return;
                        row.scrollIntoView({ block: "center", behavior: "smooth" });
                        row.classList.add("graph-row-highlight");
                        setTimeout(() => row.classList.remove("graph-row-highlight"), 1000);
                    });
                }
            }
            return;
        }

        const { sx: ex, sy: ey } = svgPoint(e);
        const x1 = Math.max(Math.min(ex, state.start.sx), ML);
        const x2 = Math.min(Math.max(ex, state.start.sx), ML + PW);
        const y1 = Math.max(Math.min(ey, state.start.sy), MT);
        const y2 = Math.min(Math.max(ey, state.start.sy), MT + PH);
        if (x2 - x1 < 4 || y2 - y1 < 4) return;
        const bx1 = toDataX(x1), bx2 = toDataX(x2);
        const by1 = toDataY(y1), by2 = toDataY(y2);
        const [bxMin, bxMax] = _clampZoomSpan(Math.min(bx1, bx2), Math.max(bx1, bx2), dxMin, dxMax);
        const [byMin, byMax] = _clampZoomSpan(Math.min(by1, by2), Math.max(by1, by2), dyMin, dyMax);
        _graphView = { xMin: bxMin, xMax: bxMax, yMin: byMin, yMax: byMax };
        _buildGraphSVG(container);
    }, { signal });

    // Crosshair
    const chGroup = svg.querySelector("#graph-crosshair");
    const chVT = svg.querySelector("#graph-ch-vt"), chVB = svg.querySelector("#graph-ch-vb");
    const chHL = svg.querySelector("#graph-ch-hl"), chHR = svg.querySelector("#graph-ch-hr");
    const chDot = svg.querySelector("#graph-ch-dot");
    const chTX  = svg.querySelector("#graph-ch-tx"), chTY = svg.querySelector("#graph-ch-ty");
    const CHGAP = 6;

    svg.addEventListener("mousemove", (e) => {
        const pt = svgPoint(e);
        if (!inPlot(pt.sx, pt.sy) || !_graphCrosshairEnabled) {
            chGroup.setAttribute("visibility", "hidden"); return;
        }
        const { sx, sy } = pt;
        chGroup.setAttribute("visibility", "visible");
        const f = v => v.toFixed(1);
        chVT.setAttribute("x1", f(sx)); chVT.setAttribute("x2", f(sx));
        chVT.setAttribute("y1", MT);    chVT.setAttribute("y2", f(Math.max(MT, sy - CHGAP)));
        chVB.setAttribute("x1", f(sx)); chVB.setAttribute("x2", f(sx));
        chVB.setAttribute("y1", f(Math.min(MT + PH, sy + CHGAP))); chVB.setAttribute("y2", MT + PH);
        chHL.setAttribute("x1", ML);    chHL.setAttribute("x2", f(Math.max(ML, sx - CHGAP)));
        chHL.setAttribute("y1", f(sy)); chHL.setAttribute("y2", f(sy));
        chHR.setAttribute("x1", f(Math.min(ML + PW, sx + CHGAP))); chHR.setAttribute("x2", ML + PW);
        chHR.setAttribute("y1", f(sy)); chHR.setAttribute("y2", f(sy));
        chDot.setAttribute("cx", f(sx)); chDot.setAttribute("cy", f(sy));

        const dataX = toDataX(sx), dataY = toDataY(sy);
        chTX.textContent = fmtCh(xMDef.id, dataX);
        chTY.textContent = fmtCh(yMDef.id, dataY);

        const tx = sx + CHGAP + 2 > ML + PW - 58 ? sx - CHGAP - 58 : sx + CHGAP + 2;
        const ty = sy > MT + PH - 18 ? sy - CHGAP - 5 : sy - CHGAP + 1;
        chTX.setAttribute("x", f(tx)); chTX.setAttribute("y", f(ty));
        chTY.setAttribute("x", f(tx)); chTY.setAttribute("y", f(ty + 8));
    }, { signal });

    svg.addEventListener("mouseleave", () => {
        chGroup?.setAttribute("visibility", "hidden");
    }, { signal });

    if (_graphPanState) svg.style.cursor = "grabbing";

    if (_rightPanel) {
        let _prevPanelW = _rightPanel.clientWidth;
        let _prevPanelH = _rightPanel.clientHeight;
        const _ro = new ResizeObserver(() => {
            const w = _rightPanel.clientWidth;
            const h = _rightPanel.clientHeight;
            if (w === _prevPanelW && h === _prevPanelH) return;
            _prevPanelW = w; _prevPanelH = h;
            clearTimeout(_graphResizeTimer);
            _graphResizeTimer = setTimeout(() => {
                if (!document.contains(container)) { _ro.disconnect(); return; }
                _buildGraphSVG(container);
            }, 150);
        });
        _ro.observe(_rightPanel);
        signal.addEventListener("abort", () => { _ro.disconnect(); clearTimeout(_graphResizeTimer); });
    }
}

// ===================================================================
//  Scroll hint overlay
// ===================================================================

function _showGraphScrollHint(container) {
    if (!_graphHintsEnabled || _graphScrollHintShown) return;
    const body = container.closest(".graph-body");
    if (!body) return;
    _graphScrollHintShown = true;
    let hint = body.querySelector(".graph-scroll-hint");
    if (!hint) {
        hint = document.createElement("div");
        hint.className = "graph-scroll-hint";
        hint.innerHTML = `<span>${escapeHtml(t("graph.hintScroll"))}</span>`;
        body.appendChild(hint);
    }
    hint.classList.add("graph-scroll-hint-active");
    clearTimeout(_graphScrollHintTimer);
    // 150ms fade-in + 1000ms hold before starting fade-out
    _graphScrollHintTimer = setTimeout(() => {
        hint.classList.remove("graph-scroll-hint-active");
    }, 1150);
}

// ===================================================================
//  Export
// ===================================================================

async function _exportGraph(container) {
    const svg = container.querySelector("svg");
    if (!svg) return;

    const toastEl = showToast(t("graph.exportGenerating"), t("graph.exportStatus1"), 0, "#4a90d9", null, false);

    try {
        const vb   = svg.getAttribute("viewBox")?.split(" ").map(Number) || [0, 0, 520, 320];
        const W    = vb[2], H = vb[3];
        const WPAD = 22;
        const EH   = H + WPAD;

        const clone = svg.cloneNode(true);
        clone.setAttribute("width",  String(W));
        clone.setAttribute("height", String(EH));
        clone.setAttribute("viewBox", `0 0 ${W} ${EH}`);
        for (const cls of [
            ".graph-ch-toggle-btn", ".graph-lbl-toggle-btn",
            ".graph-yaxis-toggle-btn", ".graph-xaxis-toggle-btn",
            ".graph-hints-toggle-btn", ".graph-reset-svg-btn", ".graph-export-btn",
            ".graph-hints-watermark", ".graph-scale-slider", ".graph-props-btn",
        ]) clone.querySelector(cls)?.remove();

        const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        bg.setAttribute("x", "0"); bg.setAttribute("y", "0");
        bg.setAttribute("width", String(W)); bg.setAttribute("height", String(EH));
        bg.setAttribute("fill", "#111");
        clone.insertBefore(bg, clone.firstChild);

        let wFontStyleText = "";
        try {
            const wResp = await fetch("./assets/images/title.svg");
            const wText = await wResp.text();
            const parser = new DOMParser();
            const wDoc  = parser.parseFromString(wText, "image/svg+xml");
            const wRoot = wDoc.documentElement;

            const wStyleEl = wRoot.querySelector("defs style");
            if (wStyleEl) wFontStyleText = wStyleEl.textContent;

            const srcW = parseFloat(wRoot.getAttribute("width")  || "301");
            const srcH = parseFloat(wRoot.getAttribute("height") || "88");
            const wmScale = Math.min(28 / srcH, 100 / srcW);
            const dw = srcW * wmScale, dh = srcH * wmScale;
            const wmY = EH - dh - 10;
            const nested = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            nested.setAttribute("x", "4");
            nested.setAttribute("y", wmY.toFixed(1));
            nested.setAttribute("width",   dw.toFixed(1));
            nested.setAttribute("height",  dh.toFixed(1));
            nested.setAttribute("viewBox", wRoot.getAttribute("viewBox") || `0 0 ${srcW} ${srcH}`);
            [...wRoot.childNodes].forEach(n => nested.appendChild(document.importNode(n, true)));
            clone.appendChild(nested);

            const now = new Date();
            const mm = String(now.getMonth() + 1).padStart(2, "0");
            const dd = String(now.getDate()).padStart(2, "0");
            const yyyy = now.getFullYear();
            const dateStr = (EFTForge.state.lang || "en") === "zh"
                ? `生成于${mm}/${dd}/${yyyy}`
                : `Generated: ${mm}/${dd}/${yyyy}`;
            const dateTxt = document.createElementNS("http://www.w3.org/2000/svg", "text");
            dateTxt.setAttribute("x", "6");
            dateTxt.setAttribute("y", String((wmY + dh + 3).toFixed(1)));
            dateTxt.setAttribute("font-size", "6");
            dateTxt.setAttribute("fill", "#555");
            dateTxt.setAttribute("font-family", "Bender,Arial,sans-serif");
            dateTxt.setAttribute("style", "user-select:none;pointer-events:none");
            dateTxt.textContent = dateStr;
            clone.appendChild(dateTxt);
        } catch {
            const fb = document.createElementNS("http://www.w3.org/2000/svg", "text");
            fb.setAttribute("x", "6"); fb.setAttribute("y", String(EH - 14));
            fb.setAttribute("font-size", "9"); fb.setAttribute("fill", "#555");
            fb.setAttribute("font-family", "Arial,sans-serif");
            fb.textContent = "EFTForge";
            clone.appendChild(fb);
            const now = new Date();
            const mm = String(now.getMonth() + 1).padStart(2, "0");
            const dd = String(now.getDate()).padStart(2, "0");
            const yyyy = now.getFullYear();
            const dateStr = (EFTForge.state.lang || "en") === "zh"
                ? `生成于${mm}/${dd}/${yyyy}`
                : `Generated: ${mm}/${dd}/${yyyy}`;
            const fbDate = document.createElementNS("http://www.w3.org/2000/svg", "text");
            fbDate.setAttribute("x", "6"); fbDate.setAttribute("y", String(EH - 4));
            fbDate.setAttribute("font-size", "6"); fbDate.setAttribute("fill", "#555");
            fbDate.setAttribute("font-family", "Arial,sans-serif");
            fbDate.textContent = dateStr;
            clone.appendChild(fbDate);
        }

        const defs = clone.querySelector("defs");
        if (defs) {
            const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
            style.textContent = `
                ${wFontStyleText}
                .graph-item-name { fill: #aaa; font-family: "Bender", Arial, sans-serif; font-weight: 600; }
            `;
            defs.insertBefore(style, defs.firstChild);
        }

        const proxyBase = `${EFTForge.config.API_BASE}/proxy-asset?url=`;
        const imgEls = [...clone.querySelectorAll("image")];
        setToastStatus(toastEl, tFmt("graph.exportStatus2", { n: imgEls.length }));
        await Promise.allSettled(imgEls.map(async (imgEl) => {
            const href = imgEl.getAttribute("href");
            if (!href || href.startsWith("data:")) return;
            try {
                const resp = await fetch(proxyBase + encodeURIComponent(href));
                if (!resp.ok) throw new Error("non-ok");
                const blob = await resp.blob();
                const dataUrl = await new Promise((res, rej) => {
                    const fr = new FileReader();
                    fr.onload = () => res(fr.result);
                    fr.onerror = rej;
                    fr.readAsDataURL(blob);
                });
                imgEl.setAttribute("href", dataUrl);
            } catch { imgEl.remove(); }
        }));

        setToastStatus(toastEl, t("graph.exportStatus3"));

        const SCALE = 4;
        const canvas = document.createElement("canvas");
        canvas.width  = W  * SCALE;
        canvas.height = EH * SCALE;
        const ctx = canvas.getContext("2d");

        const svgStr     = new XMLSerializer().serializeToString(clone);
        const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgStr)}`;

        await new Promise((resolve, reject) => {
            const tmpImg = new Image();
            tmpImg.onload = () => { ctx.drawImage(tmpImg, 0, 0, W * SCALE, EH * SCALE); resolve(); };
            tmpImg.onerror = reject;
            tmpImg.src = svgDataUrl;
        });

        toastEl?.remove();
        _showExportModal(canvas);
    } catch (err) {
        toastEl?.remove();
        console.error("Graph export failed:", err);
        showToast(t("graph.exportFailed"), "", 3000);
    }
}

function _showExportModal(canvas) {
    const overlay = _createModalOverlay("graph-export-modal", t("graph.exportTitle"), { maxWidth: "min(90vw, 860px)" });
    if (!overlay) return;

    const body = document.getElementById("graph-export-modal-body");
    body.style.gap = "10px";

    const preview = document.createElement("img");
    preview.className = "graph-export-preview";
    preview.src = canvas.toDataURL("image/png");
    preview.style.cursor = "zoom-in";
    preview.addEventListener("click", () => {
        if (window.EFTForge && EFTForge.mediaViewer) EFTForge.mediaViewer.open(preview.src);
    });

    const dlBtn = document.createElement("button");
    dlBtn.className = "modal-btn primary full-width";
    dlBtn.textContent = t("graph.exportDownload");
    dlBtn.addEventListener("click", () => {
        const a = document.createElement("a");
        a.download = `eftforge-graph-${Date.now()}.png`;
        a.href = preview.src;
        a.click();
    });

    body.appendChild(preview);
    body.appendChild(dlBtn);
}
