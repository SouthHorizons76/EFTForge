window.EFTForge = window.EFTForge || {};

// ---------------------------------------------------
// Price View helpers
// ---------------------------------------------------

function _collectInstalledItemsFlat(node, result = []) {
    for (const slotId in node.children) {
        const child = node.children[slotId];
        result.push(child.item);
        _collectInstalledItemsFlat(child, result);
    }
    return result;
}

function _saveFleaCache() {
    try {
        const ts = new Date().toISOString();
        sessionStorage.setItem("eftforge_flea_pvp", JSON.stringify(EFTForge.state.fleaCachePvp));
        sessionStorage.setItem("eftforge_flea_pve", JSON.stringify(EFTForge.state.fleaCachePve));
        sessionStorage.setItem("eftforge_flea_ts",  ts);
        EFTForge.state.fleaLastFetched = ts;
    } catch (_) {}
}

function restoreFleaCache() {
    try {
        const pvp = sessionStorage.getItem("eftforge_flea_pvp");
        const pve = sessionStorage.getItem("eftforge_flea_pve");
        const ts  = sessionStorage.getItem("eftforge_flea_ts");
        if (pvp) EFTForge.state.fleaCachePvp  = JSON.parse(pvp);
        if (pve) EFTForge.state.fleaCachePve  = JSON.parse(pve);
        if (ts)  EFTForge.state.fleaLastFetched = ts;
        EFTForge.state.pveMode = localStorage.getItem("eftforge_pve_mode") === "1";
        const tl = localStorage.getItem("eftforge_trader_levels");
        if (tl) EFTForge.state.traderLevels = JSON.parse(tl);
    } catch (_) {}
}

function _saveTraderLevels() {
    try {
        localStorage.setItem("eftforge_trader_levels", JSON.stringify(EFTForge.state.traderLevels));
    } catch (_) {}
}

let _fleaFetching = false;
let _fleaDotsInterval = null;
let _traderLevelsOpen = false;

// Only these traders sell weapon-relevant items with loyalty level gates
const _TRADER_LEVEL_WHITELIST = ["prapor", "skier", "peacekeeper", "mechanic", "jaeger"];

function _startRefetchAnimation() {
    const btn = document.getElementById("flea-refetch-btn");
    if (!btn) return;
    btn.disabled = true;
    const { t } = EFTForge.lang;
    const label = t("stats.refetchingFlea");
    let dots = 1;
    btn.textContent = label + ".";
    _fleaDotsInterval = setInterval(() => {
        dots = dots >= 3 ? 1 : dots + 1;
        btn.textContent = label + ".".repeat(dots);
    }, 500);
}

function _stopRefetchAnimation() {
    clearInterval(_fleaDotsInterval);
    _fleaDotsInterval = null;
    const btn = document.getElementById("flea-refetch-btn");
    if (!btn) return;
    btn.disabled = false;
    const { t } = EFTForge.lang;
    btn.textContent = t("stats.refetchFlea");
}

async function refetchFleaPrices() {
    if (_fleaFetching) return;
    _fleaFetching = true;
    _startRefetchAnimation();

    EFTForge.state.fleaCachePvp  = {};
    EFTForge.state.fleaCachePve  = {};
    EFTForge.state.fleaLastFetched = null;
    sessionStorage.removeItem("eftforge_flea_pvp");
    sessionStorage.removeItem("eftforge_flea_pve");
    sessionStorage.removeItem("eftforge_flea_ts");

    try {
        const { t: _t } = EFTForge.lang;
        const ids = await fetch(`${EFTForge.config.API_BASE}/items/ids`).then(r => r.json());
        showToast(_t("stats.fleaMarket"), `${_t("stats.fleaFetching")} ${ids.length} ${_t("stats.fleaFetchingItems")}`, 4000, "#c8a84b");
        const CHUNK = 300;
        for (let i = 0; i < ids.length; i += CHUNK) {
            await new Promise(resolve => setTimeout(resolve, 0));
            await ensureFleaPrices(ids.slice(i, i + CHUNK));
        }
        showToast(_t("stats.fleaMarket"), _t("stats.fleaUpdated"), 3000, "#4caf50");
        if (EFTForge.state.priceView) renderPriceOverview();
    } catch (_) {
    } finally {
        _fleaFetching = false;
        _stopRefetchAnimation();
    }
}

async function ensureFleaPrices(itemIds) {
    const missing = itemIds.filter(id => !(id in EFTForge.state.fleaCachePvp));
    if (missing.length === 0) return;
    try {
        const [pvp, pve] = await Promise.all([
            fetchFleaPrices(missing, "regular"),
            fetchFleaPrices(missing, "pve"),
        ]);
        Object.assign(EFTForge.state.fleaCachePvp, pvp);
        Object.assign(EFTForge.state.fleaCachePve, pve);
        _saveFleaCache();
    } catch (err) {
        console.warn("Could not fetch flea prices:", err);
    }
}

async function renderPriceOverview() {
    const { t } = EFTForge.lang;
    const panel = document.getElementById("price-overview");
    if (!panel) return;

    const gun = EFTForge.state.currentGun;
    if (!gun) {
        panel.innerHTML = `<div style="opacity:0.5; padding:40px; text-align:center;">${t("stats.selectWeapon")}</div>`;
        return;
    }

    const installedItems = _collectInstalledItemsFlat(EFTForge.state.buildTree);
    const ammoSelect = document.getElementById("ammo-select");
    const selectedAmmoId = ammoSelect?.value || null;
    const ammo = selectedAmmoId ? EFTForge.state.ammoMap[selectedAmmoId] : null;
    const magItem = installedItems.find(it => it.magazine_capacity > 0);
    const magCap = magItem?.magazine_capacity || 1;

    const allIds = [gun.id, ...installedItems.map(i => i.id)];
    if (ammo) allIds.push(ammo.id);

    const missingIds = allIds.filter(id => !(id in EFTForge.state.fleaCachePvp));
    let _fetchDotsInterval = null;
    if (missingIds.length > 0) {
        const label = t("stats.fetchingFleaPrices");
        let dots = 1;
        panel.innerHTML = `<div class="price-fetch-placeholder"><span id="price-fetch-label">${escapeHtml(label)}.</span></div>`;
        _fetchDotsInterval = setInterval(() => {
            const el = document.getElementById("price-fetch-label");
            if (el) {
                dots = dots >= 3 ? 1 : dots + 1;
                el.textContent = label + ".".repeat(dots);
            }
        }, 500);
    }

    await ensureFleaPrices(allIds);
    if (_fetchDotsInterval) { clearInterval(_fetchDotsInterval); _fetchDotsInterval = null; }

    const pve = EFTForge.state.pveMode;
    const fleaCache = pve ? EFTForge.state.fleaCachePve : EFTForge.state.fleaCachePvp;

    function _priceInfoForItem(item) {
        let traderPrice = null;
        if (item.trader_price_rub != null && item.trader_vendor != null) {
            const requiredLevel = item.trader_min_level ?? 1;
            const userLevel = EFTForge.state.traderLevels[item.trader_vendor] ?? 4;
            if (userLevel >= requiredLevel) {
                traderPrice = { priceRub: item.trader_price_rub, vendorNorm: item.trader_vendor, isFlea: false };
            }
        }
        const fleaPrice = fleaCache[item.id] != null
            ? { priceRub: fleaCache[item.id], vendorNorm: null, isFlea: true }
            : null;
        if (traderPrice && fleaPrice) {
            return fleaPrice.priceRub < traderPrice.priceRub ? fleaPrice : traderPrice;
        }
        return traderPrice || fleaPrice || null;
    }

    function _portrait(vendorNorm) {
        if (!vendorNorm) {
            return `<span class="cost-flea-icon">${t("stats.fleaLabel")}</span>`;
        }
        const trader = EFTForge.state.tradersByNorm?.[vendorNorm];
        const src = trader?.imageLink || "";
        const traderName = trader?.name || vendorNorm;
        return src
            ? `<img class="cost-trader-portrait" src="${escapeHtml(src)}" data-tooltip="${escapeHtml(traderName)}" onerror="this.style.display='none'" />`
            : `<span class="cost-trader-text" data-tooltip="${escapeHtml(traderName)}">${escapeHtml(vendorNorm)}</span>`;
    }

    function _itemIcon(iconLink) {
        if (!iconLink) return "";
        return `<img class="cost-item-icon" src="${escapeHtml(iconLink)}" onerror="this.style.display='none'" />`;
    }

    // Portrait-sized blank spacer to keep alignment when portrait is omitted
    const _portraitSpacer = `<span style="width:18px;height:18px;flex-shrink:0;display:inline-block;"></span>`;

    function _costRow(name, priceInfo, iconLink, opts = {}) {
        const { noPortrait = false, labelOverride = null } = opts;
        const icon = _itemIcon(iconLink);
        const nameHtml = `<div class="cost-item-name-wrap"><span class="cost-item-name marquee-text">${escapeHtml(name)}</span></div>`;
        const portraitHtml = noPortrait ? _portraitSpacer : (priceInfo ? _portrait(priceInfo.vendorNorm) : _portraitSpacer);
        const priceHtml = labelOverride != null
            ? `<span class="cost-no-price">${escapeHtml(labelOverride)}</span>`
            : priceInfo
                ? `<span class="cost-price">${_formatPrice(priceInfo.priceRub)}</span>`
                : `<span class="cost-no-price">-</span>`;
        return `<div class="cost-row">
            <div class="cost-row-label">
                ${portraitHtml}
                ${icon}
                ${nameHtml}
            </div>
            ${priceHtml}
        </div>`;
    }

    const factorySet = new Set(gun.factory_attachment_ids || []);

    let totalRub = 0;
    let rows = "";

    // Gun is bought on flea with its factory config - use flea price, preset icon, no portrait
    const gunFleaPrice = fleaCache[gun.id];
    const gunPriceInfo = gunFleaPrice != null ? { priceRub: gunFleaPrice, vendorNorm: null, isFlea: true } : null;
    rows += _costRow(gun.name || gun.short_name || "Weapon", gunPriceInfo, gun.preset_icon_link || gun.icon_link, { noPortrait: true });
    if (gunPriceInfo) totalRub += gunPriceInfo.priceRub;

    for (const att of installedItems) {
        const attName = att.name || att.short_name || "?";
        if (factorySet.has(att.id)) {
            // Factory attachments included in flea gun price - show label only, no price
            rows += _costRow(attName, null, att.icon_link, { noPortrait: true, labelOverride: t("stats.factoryIncluded") });
            continue;
        }
        const attPrice = _priceInfoForItem(att);
        rows += _costRow(attName, attPrice, att.icon_link);
        if (attPrice) totalRub += attPrice.priceRub;
    }

    if (ammo) {
        const ammoPrice = _priceInfoForItem(ammo);
        const ammoName = `${ammo.name || ammo.short_name || t("stats.ammoRow")} x${magCap}`;
        const ammoIcon = _itemIcon(ammo.icon_link);
        const ammoNameHtml = `<div class="cost-item-name-wrap"><span class="cost-item-name marquee-text">${escapeHtml(ammoName)}</span></div>`;
        if (ammoPrice) {
            const ammoTotal = ammoPrice.priceRub * magCap;
            totalRub += ammoTotal;
            rows += `<div class="cost-row">
                <div class="cost-row-label">
                    ${_portrait(ammoPrice.vendorNorm)}
                    ${ammoIcon}
                    ${ammoNameHtml}
                </div>
                <span class="cost-price">${_formatPrice(ammoTotal)}</span>
            </div>`;
        } else {
            rows += _costRow(ammoName, null, ammo.icon_link);
        }
    }

    const pveBtnActive = pve ? "active" : "";
    const ts = EFTForge.state.fleaLastFetched;
    const tsLabel = ts
        ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "-";

    // Build trader levels rows - whitelist only, preserving display order
    const tradersByNorm = EFTForge.state.tradersByNorm || {};
    const traderList = _TRADER_LEVEL_WHITELIST
        .map(norm => tradersByNorm[norm])
        .filter(Boolean);

    let traderLevelRowsHtml = "";
    for (const tr of traderList) {
        const currentLevel = EFTForge.state.traderLevels[tr.normalizedName] ?? 4;
        const portrait = tr.imageLink
            ? `<img class="cost-trader-portrait" src="${escapeHtml(tr.imageLink)}" onerror="this.style.display='none'" />`
            : `<span class="cost-trader-text">${escapeHtml(tr.normalizedName)}</span>`;
        let levelBtns = "";
        for (let lv = 1; lv <= 4; lv++) {
            const cls = lv <= currentLevel ? "trader-level-btn active" : "trader-level-btn";
            levelBtns += `<button class="${cls}" data-trader="${escapeHtml(tr.normalizedName)}" data-level="${lv}">${lv}</button>`;
        }
        traderLevelRowsHtml += `<div class="trader-level-row">
            ${portrait}
            <span class="trader-level-name">${escapeHtml(tr.name)}</span>
            <div class="trader-level-btns">${levelBtns}</div>
        </div>`;
    }

    // Determine if all traders are at the same level (to highlight the master row)
    const _allLevels = _TRADER_LEVEL_WHITELIST.map(n => EFTForge.state.traderLevels[n] ?? 4);
    const _globalLevel = _allLevels.every(l => l === _allLevels[0]) ? _allLevels[0] : null;

    let globalBtns = "";
    for (let lv = 1; lv <= 4; lv++) {
        const cls = lv <= (_globalLevel ?? 0) ? "trader-level-btn active" : "trader-level-btn";
        globalBtns += `<button class="${cls}" data-level="${lv}" id="trader-level-all-${lv}">${lv}</button>`;
    }

    const levelsOpenCls = _traderLevelsOpen ? " open" : "";
    const levelsBodyStyle = _traderLevelsOpen ? "" : "height:0;opacity:0;overflow:hidden";

    panel.innerHTML = `
        <div class="stats-section">
            <div class="cost-section-header">
                <div class="section-title">${t("stats.buildCost")}</div>
                <button class="compare-toggle ${pveBtnActive}" id="pve-mode-toggle">
                    ${t("stats.pveModeLabel")}
                    <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                </button>
            </div>
            <div class="cost-meta-row">
                <div class="cost-flea-ts">${t("stats.fleaTs")} ${escapeHtml(tsLabel)} &middot; <button id="flea-refetch-btn" class="cost-flea-refetch-btn">${t("stats.refetchFlea")}</button></div>
                <button class="trader-levels-toggle-btn${levelsOpenCls}" id="trader-levels-toggle">
                    <span class="trader-levels-label">${t("stats.traderLevels")}</span>
                    <span class="trader-levels-arrow">&#9660;</span>
                </button>
            </div>
            <div class="trader-levels-body" id="trader-levels-body" style="${levelsBodyStyle}">
                <div class="trader-level-row trader-level-master-row">
                    <span class="trader-level-name">${t("stats.traderLevelsAll")}</span>
                    <div class="trader-level-btns">${globalBtns}</div>
                </div>
                <div class="trader-levels-divider"></div>
                ${traderLevelRowsHtml}
            </div>
            ${rows}
            <div class="cost-total-row">
                <span>${t("stats.totalCost")}</span>
                <span>${_formatPrice(totalRub)}</span>
            </div>
        </div>
    `;

    document.getElementById("pve-mode-toggle")?.addEventListener("click", (e) => {
        EFTForge.state.pveMode = !EFTForge.state.pveMode;
        localStorage.setItem("eftforge_pve_mode", EFTForge.state.pveMode ? "1" : "0");
        e.currentTarget.classList.toggle("active", EFTForge.state.pveMode);
        setTimeout(() => renderPriceOverview(), 220);
    });

    document.getElementById("trader-levels-toggle")?.addEventListener("click", () => {
        _traderLevelsOpen = !_traderLevelsOpen;
        const body = document.getElementById("trader-levels-body");
        const btn  = document.getElementById("trader-levels-toggle");
        if (btn) btn.classList.toggle("open", _traderLevelsOpen);
        if (!body) return;
        if (_traderLevelsOpen) {
            body.style.overflow = "hidden";
            body.style.height = "0px";
            body.style.opacity = "0";
            void body.offsetHeight;
            body.style.height = body.scrollHeight + "px";
            body.style.opacity = "1";
            body.addEventListener("transitionend", (e) => {
                if (e.propertyName !== "height") return;
                body.style.height = "";
                body.style.overflow = "";
                body.style.opacity = "";
            }, { once: true });
        } else {
            body.style.height = body.scrollHeight + "px";
            body.style.opacity = "1";
            body.style.overflow = "hidden";
            void body.offsetHeight;
            body.style.height = "0px";
            body.style.opacity = "0";
        }
    });

    for (let lv = 1; lv <= 4; lv++) {
        document.getElementById(`trader-level-all-${lv}`)?.addEventListener("click", (e) => {
            const level = parseInt(e.currentTarget.dataset.level, 10);
            for (const norm of _TRADER_LEVEL_WHITELIST) {
                EFTForge.state.traderLevels[norm] = level;
            }
            _saveTraderLevels();
            renderPriceOverview();
            renderFullTree();
        });
    }

    panel.querySelectorAll(".trader-level-btn:not([id^='trader-level-all-'])").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const traderNorm = e.currentTarget.dataset.trader;
            const level = parseInt(e.currentTarget.dataset.level, 10);
            EFTForge.state.traderLevels[traderNorm] = level;
            _saveTraderLevels();
            renderPriceOverview();
            renderFullTree();
        });
    });

    const refetchBtn = document.getElementById("flea-refetch-btn");
    if (refetchBtn) {
        refetchBtn.addEventListener("click", refetchFleaPrices);
        if (_fleaFetching) _startRefetchAnimation();
    }

    _initMarqueeText(panel);
}

// ---------------------------------------------------
// Hidden stats panel insert/remove helpers
// ---------------------------------------------------

function _insertHiddenStatsPanel() {
  const { t } = EFTForge.lang;
  const gun = EFTForge.state.currentGun;
  if (!gun) return;
  const fmt = (v, decimals = 2, spt = false) => v != null ? parseFloat(v).toFixed(decimals) : (spt ? "?" : "-");
  const fmtInt = (v) => v != null ? v : "-";
  const rows = [
    [t("hidden.aimPlane"),      fmt(gun.center_of_impact),                                                        t("hidden.tip.aimPlane")],
    [t("hidden.aimSens"),       fmt(gun.aim_sensitivity, 2, true),                                                t("hidden.tip.aimSens")],
    [t("hidden.camAngleStep"),  fmt(gun.cam_angle_step, 2, true),                                                 t("hidden.tip.camAngleStep")],
    [t("hidden.camSnap"),       fmt(gun.camera_snap, 1),                                                          t("hidden.tip.camSnap")],
    [t("hidden.devCurve"),      fmt(gun.deviation_curve),                                                         t("hidden.tip.devCurve")],
    [t("hidden.devMax"),        fmt(gun.deviation_max, 1),                                                        t("hidden.tip.devMax")],
    [t("hidden.mountCamSnap"),  gun.mount_cam_snap != null ? "\u00d7" + parseFloat(gun.mount_cam_snap).toFixed(0) : "?", t("hidden.tip.mountCamSnap")],
    [t("hidden.mountHRec"),     gun.mount_h_rec    != null ? "\u00d7" + parseFloat(gun.mount_h_rec).toFixed(2)   : "?", t("hidden.tip.mountHRec")],
    [t("hidden.mountVRec"),     gun.mount_v_rec    != null ? "\u00d7" + parseFloat(gun.mount_v_rec).toFixed(2)   : "?", t("hidden.tip.mountVRec")],
    [t("hidden.mountBreath"),   gun.mount_breath   != null ? "\u00d7" + parseFloat(gun.mount_breath).toFixed(1)  : "?", t("hidden.tip.mountBreath")],
    [t("hidden.recAngle"),      fmtInt(gun.recoil_angle) + (gun.recoil_angle != null ? "\u00b0" : ""),           t("hidden.tip.recAngle")],
    [t("hidden.recHandRot"),    gun.rec_hand_rot   != null ? "\u00d7" + parseFloat(gun.rec_hand_rot).toFixed(2)  : "?", t("hidden.tip.recHandRot")],
    [t("hidden.recDispersion"), fmtInt(gun.recoil_dispersion),                                                    t("hidden.tip.recDispersion")],
    [t("hidden.recForceBack"),  gun.rec_force_back != null ? gun.rec_force_back : "?",                            t("hidden.tip.recForceBack")],
    [t("hidden.recForceUp"),    gun.rec_force_up   != null ? gun.rec_force_up   : "?",                            t("hidden.tip.recForceUp")],
    [t("hidden.recReturnSpeed"), fmt(gun.rec_return_speed, 1, true),                                              t("hidden.tip.recReturnSpeed")],
  ];
  const rowsHtml = rows.map(([label, val, tip]) =>
    `<div class="hidden-stat-row" data-tooltip="${escapeHtml(tip)}"><span class="hidden-stat-label">${label}</span><span class="hidden-stat-value">${val}</span></div>`
  ).join("");
  const panel = document.createElement("div");
  panel.className = "stamina-panel";
  panel.id = "hidden-stats-panel";
  panel.innerHTML = `<div class="hidden-stats-grid">${rowsHtml}</div>`;
  document.getElementById("hidden-stats-anchor").after(panel);
  panel.style.height = "0px";
  panel.style.opacity = "0";
  void panel.offsetHeight;
  panel.style.height = panel.scrollHeight + "px";
  panel.style.opacity = "1";
  panel.addEventListener("transitionend", () => {
    panel.style.height = "";
    panel.style.opacity = "";
  }, { once: true });
  EFTForge.state.hiddenStatsOpen = true;
  const btn = document.getElementById("hidden-stats-btn");
  if (btn) btn.classList.add("open");
}

function _removeHiddenStatsPanel() {
  const { t } = EFTForge.lang;
  const existing = document.getElementById("hidden-stats-panel");
  if (!existing) return;
  existing.style.height = existing.scrollHeight + "px";
  existing.style.opacity = "1";
  void existing.offsetHeight;
  existing.style.height = "0px";
  existing.style.opacity = "0";
  existing.style.marginTop = "0px";
  existing.style.padding = "0px";
  existing.style.borderWidth = "0px";
  setTimeout(() => existing.remove(), 200);
  EFTForge.state.hiddenStatsOpen = false;
  const btn = document.getElementById("hidden-stats-btn");
  if (btn) btn.classList.remove("open");
}

// ---------------------------------------------------
// Price View toggle (called from index.html onclick)
// ---------------------------------------------------

function _applyViewMode(priceView) {
    const { t } = EFTForge.lang;
    EFTForge.state.priceView = priceView;
    const tableContainer = document.getElementById("attachment-table-container");
    if (tableContainer.innerHTML) {
        tableContainer.innerHTML = "";
        const placeholder = document.getElementById("attachment-placeholder");
        if (placeholder) placeholder.style.display = "flex";
    }

    const stats    = document.getElementById("stats");
    const slots    = document.getElementById("slots");
    const price    = document.getElementById("price-overview");

    const _animateIn = (el) => {
        el.classList.remove("panel-enter");
        void el.offsetWidth; // force reflow to restart animation
        el.classList.add("panel-enter");
        el.addEventListener("animationend", () => el.classList.remove("panel-enter"), { once: true });
    };

    stats.style.display = priceView ? "none" : "";
    slots.style.display = priceView ? "none" : "";
    price.style.display = priceView ? "flex"  : "none";

    if (priceView) {
        _animateIn(price);
    } else {
        _animateIn(stats);
        _animateIn(slots);
    }

    document.getElementById("view-build-btn")?.classList.toggle("active", !priceView);
    document.getElementById("view-price-btn")?.classList.toggle("active",  priceView);
}

function showBuildView() {
    if (!EFTForge.state.priceView) return;
    _applyViewMode(false);
    refreshBuildStats();
}

function showPriceView() {
    if (EFTForge.state.priceView) return;
    _applyViewMode(true);
    renderPriceOverview();
}

function updateViewToggleLabels() {
    const { t } = EFTForge.lang;
    const buildBtn = document.getElementById("view-build-btn");
    const priceBtn = document.getElementById("view-price-btn");
    if (buildBtn) buildBtn.textContent = t("stats.buildView");
    if (priceBtn) priceBtn.textContent = t("stats.priceView");
}

// ---------------------------------------------------
// Build stats refresh
// ---------------------------------------------------

async function refreshBuildStats() {
  if (!EFTForge.state.currentGun) return null;

  syncBuildDisplayName();

  const attachmentIds = collectAttachmentIds(EFTForge.state.buildTree);

  const ammoSelect = document.getElementById("ammo-select");
  const assumeFull = EFTForge.state.assumeFullMag ?? true;
  const selectedAmmo = ammoSelect ? ammoSelect.value : null;
  const strengthLevel = EFTForge.state.currentStrengthLevel;

  if (EFTForge.state.priceView) {
      renderPriceOverview();
      return null;
  }

  try {
      const data = await calculateBuild({
          base_item_id: EFTForge.state.currentGun.id,
          attachment_ids: attachmentIds,
          assume_full_mag: assumeFull,
          selected_ammo_id: selectedAmmo,
          strength_level: strengthLevel,
          equip_ergo_modifier: EFTForge.state.currentEquipErgoModifier
      });
      await updateStatsPanel(data);
      return data;

  } catch (err) {
      console.error("Failed to calculate build stats:", err);
      showToast(t("toast.connectionError"), t("toast.serverUnreachable") + " " + (EFTForge.config.IS_LOCAL_DEV ? t("toast.networkHintDev") : t("toast.networkHintProd")), 5000);
      return null;
  }
}

async function updateStatsPanel(data, { preloadedAmmo = null, _fromInit = false } = {}) {
  const { t } = EFTForge.lang;

  const statsBox = document.getElementById("stats");

  if (!EFTForge.state.currentGun) {
    statsBox.innerHTML = `
      <div style="opacity:0.5; padding:40px; text-align:center;">
        ${t("stats.selectWeapon")}
      </div>
    `;
    return;
  }

    if (!data) {
        return;
    }

  // Create controls once
  if (!document.getElementById("stats-content")) {

    statsBox.innerHTML = `
      <div class="mag-controls">
        <button class="compare-toggle active" id="full-mag-toggle">
          ${t("stats.fullMag")}
          <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
        </button>
        <select id="ammo-select"></select>
      </div>

      <div id="stats-content"></div>
    `;

    document
      .getElementById("full-mag-toggle")
      .addEventListener("click", () => {
        EFTForge.state.assumeFullMag = !EFTForge.state.assumeFullMag;
        document.getElementById("full-mag-toggle")
            .classList.toggle("active", EFTForge.state.assumeFullMag);
        refreshBuildStats();
      });

    document
      .getElementById("ammo-select")
      .addEventListener("change", () => {
        const caliber = EFTForge.state.currentGun?.caliber;
        if (caliber) {
          const sel = document.getElementById("ammo-select");
          const prefs = JSON.parse(localStorage.getItem("eftforge_ammo_prefs") || "{}");
          prefs[caliber] = sel.value;
          localStorage.setItem("eftforge_ammo_prefs", JSON.stringify(prefs));
        }
        refreshBuildStats();
      });

    setupCustomSelect("ammo-select");

    await loadAmmoForGun(EFTForge.state.currentGun, preloadedAmmo);
    // If we have preloaded stats, render directly without an extra calculateBuild call
    if (_fromInit) {
      await updateStatsPanel(data);
    } else {
      await refreshBuildStats();
    }
    return;
  }

  const content = document.getElementById("stats-content");

  const savedStaminaPanel = document.getElementById("stamina-panel");
  const savedEquipErgoPanel = document.getElementById("equip-ergo-panel");
  savedStaminaPanel?.remove();
  savedEquipErgoPanel?.remove();
  document.getElementById("hidden-stats-panel")?.remove();

  const eed = parseFloat(data.evo_ergo_delta ?? 0);
  const totalErgo = parseFloat(data.total_ergo ?? 0);
  const totalWeight = parseFloat(data.total_weight ?? 0);
  EFTForge.state.lastTotalWeight = totalWeight;
  EFTForge.state.lastTotalErgo = totalErgo;
  EFTForge.state.lastRecoilV = data.recoil_vertical ?? null;
  EFTForge.state.lastRecoilH = data.recoil_horizontal ?? null;
  EFTForge.state.lastEED = parseFloat(data.evo_ergo_delta ?? 0);
  EFTForge.state.lastOverswing  = data.overswing ?? false;
  EFTForge.state.lastArmStamina = parseFloat(data.arm_stamina ?? 0);

  const eedClass = eed >= 0 ? "positive" : "negative";
  const overswingClass = data.overswing ? "negative" : "positive";

  const armStamina = parseFloat(data.arm_stamina ?? 0);

  // Snapshot current fill widths so the transition starts from the previous value
  const prevFills = content.querySelectorAll(".stat-bar-fill");
  const isFirstRender = prevFills.length === 0;
  const prevErgoW = prevFills[0]?.style.width || "0%";
  const prevRVW   = prevFills[1]?.style.width || "0%";
  const prevRHW   = prevFills[2]?.style.width || "0%";

  if (isFirstRender) {
    content.style.height = "0";
    content.style.overflow = "hidden";
    content.style.opacity = "0";
  }

  content.innerHTML = `
    <div class="stats-section">
      <div class="section-title stats-title-row">
        <span>${t("stats.title")}</span>
        <button class="hidden-stats-btn${EFTForge.state.hiddenStatsOpen ? " open" : ""}" id="hidden-stats-btn" data-tooltip="${t("hidden.tooltip")}"><span class="hidden-stats-label">${t("hidden.title")}</span><span class="hidden-stats-arrow">&#9660;</span></button>
      </div>

      <div class="stat-bar-row">
        <div class="stat-bar-label">${t("stats.ergo")}</div>
        <div class="stat-bar-track">
          <div class="stat-bar-fill ergo-bar" style="width:${prevErgoW}" data-target="${Math.min(totalErgo, 100)}"></div>
          <div class="stat-bar-value">${Math.abs(totalErgo - Math.round(totalErgo)) < 0.001 ? Math.round(totalErgo) : totalErgo.toFixed(1)}</div>
        </div>
      </div>

      <div class="stat-bar-row">
        <div class="stat-bar-label">${t("stats.verRecoil")}</div>
        <div class="stat-bar-track">
          <div class="stat-bar-fill recoil-bar" style="width:${prevRVW}" data-target="${data.recoil_vertical !== null && data.recoil_vertical !== undefined ? Math.min(Math.round(data.recoil_vertical), 500) / 5 : 0}"></div>
          <div class="stat-bar-value">${data.recoil_vertical !== null && data.recoil_vertical !== undefined ? Math.round(data.recoil_vertical) : "-"}</div>
        </div>
      </div>

      <div class="stat-bar-row">
        <div class="stat-bar-label">${t("stats.horRecoil")}</div>
        <div class="stat-bar-track">
          <div class="stat-bar-fill recoil-bar" style="width:${prevRHW}" data-target="${data.recoil_horizontal !== null && data.recoil_horizontal !== undefined ? Math.min(Math.round(data.recoil_horizontal), 500) / 5 : 0}"></div>
          <div class="stat-bar-value">${data.recoil_horizontal !== null && data.recoil_horizontal !== undefined ? Math.round(data.recoil_horizontal) : "-"}</div>
        </div>
      </div>

      <div class="stats-divider"></div>

      <div class="stat-row stat-row-weight"><span class="stat-label">${t("stats.weight")}</span><span>${totalWeight.toFixed(3)} kg</span></div>
      <div class="stat-row stat-row-eed">
        <span class="stat-label">${t("stats.eed")}<span class="stamina-info-btn${eed >= 0 && eed < 7 && EFTForge.state.currentEquipErgoModifier === 0 ? " eed-warn-active" : ""}" id="equip-ergo-info-btn" data-tooltip="${t("stats.configEquipErgoTooltip")}">i</span>:</span>
        <span id="eed-value-span" class="${eedClass}">${eed > 0 ? "+" : ""}${eed.toFixed(1)}</span>${eed >= 0 && eed < 7 && EFTForge.state.currentEquipErgoModifier === 0 ? `<span class="eed-warning-icon" data-tooltip="${t("stats.eedWarnTooltip")}">⚠</span>` : ""}
      </div>
      <div class="stat-row">
        <span class="stat-label">${t("stats.overswing")}</span>
        <span id="overswing-value-span" class="${overswingClass}">${data.overswing ? t("stats.yes") : t("stats.no")}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">${t("stats.armStamina")}<span class="stamina-info-btn" id="stamina-info-btn" data-tooltip="${t("stats.configStrengthTooltip")}">i</span>:</span>
        <span>${armStamina.toFixed(1)}s</span>
      </div>
      <div id="hidden-stats-anchor"></div>
    </div>
  `;

  // Recreate hidden stats panel fresh (with current language) if it was open
  if (EFTForge.state.hiddenStatsOpen && EFTForge.state.currentGun) {
    _insertHiddenStatsPanel();
  }

  // Hidden stats button
  document.getElementById("hidden-stats-btn")?.addEventListener("click", () => {
    if (document.getElementById("hidden-stats-panel")) {
      _removeHiddenStatsPanel();
    } else {
      _insertHiddenStatsPanel();
    }
  });

  // On first render, grow height from 0 so the tree slides down smoothly
  if (isFirstRender) {
    const targetHeight = content.scrollHeight;
    content.style.transition = "height 0.3s ease, opacity 0.25s ease";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      content.style.height = targetHeight + "px";
      content.style.opacity = "1";
    }));
    const onHeightDone = (e) => {
      if (e.propertyName !== "height") return;
      content.removeEventListener("transitionend", onHeightDone);
      content.style.height = "";
      content.style.overflow = "";
      content.style.opacity = "";
      content.style.transition = "";
    };
    content.addEventListener("transitionend", onHeightDone);
  }

  // Animate stat bar fills from 0 to their target widths
  requestAnimationFrame(() => requestAnimationFrame(() => {
    content.querySelectorAll(".stat-bar-fill[data-target]").forEach(el => {
      el.style.width = el.dataset.target + "%";
    });
  }));

  // Toggle panel on i button click
  document.getElementById("stamina-info-btn").addEventListener("click", () => {
      const existing = document.getElementById("stamina-panel");
      if (existing) {
          existing.style.height = existing.scrollHeight + "px";
          existing.style.opacity = "1";
          void existing.offsetHeight;
          existing.style.height = "0px";
          existing.style.opacity = "0";
          existing.style.marginTop = "0px";
          existing.style.padding = "0px";
          existing.style.borderWidth = "0px";
          setTimeout(() => existing.remove(), 200);
      } else {
          const panel = document.createElement("div");
          panel.className = "stamina-panel";
          panel.id = "stamina-panel";
          panel.innerHTML = `
              <span class="beta-badge">${t("stats.beta")}</span>
                <div class="stamina-disclaimer">${t("stats.staminaDisclaimer").replace("\n", "<br>")}</div>
              <div class="strength-control">
                  <label style="color:#eee;">${t("stats.strengthLv")}</label>
                  <div class="strength-input-row">
                      <input type="range" id="strength-slider" min="0" max="51" step="1" value="${EFTForge.state.currentStrengthLevel}" />
                      <input type="number" id="strength-input" min="0" max="51" value="${EFTForge.state.currentStrengthLevel}" />
                  </div>
              </div>
          `;
          document.getElementById("stamina-info-btn").closest(".stat-row").after(panel);

          panel.style.height = "0px";
          panel.style.opacity = "0";
          void panel.offsetHeight;
          panel.style.height = panel.scrollHeight + "px";
          panel.style.opacity = "1";
          panel.addEventListener("transitionend", () => {
              panel.style.height = "";
              panel.style.opacity = "";
          }, { once: true });

          wireStrengthControls();
      }
  });

  // Make the EED warning triangle also open the same panel
  document.querySelector(".eed-warning-icon")?.addEventListener("click", () =>
      document.getElementById("equip-ergo-info-btn")?.click()
  );

  // Toggle equip ergo panel on i button click
  document.getElementById("equip-ergo-info-btn").addEventListener("click", () => {
      const existing = document.getElementById("equip-ergo-panel");
      if (existing) {
          existing.style.height = existing.scrollHeight + "px";
          existing.style.opacity = "1";
          void existing.offsetHeight;
          existing.style.height = "0px";
          existing.style.opacity = "0";
          existing.style.marginTop = "0px";
          existing.style.padding = "0px";
          existing.style.borderWidth = "0px";
          setTimeout(() => existing.remove(), 200);
      } else {
          const panel = document.createElement("div");
          panel.className = "stamina-panel";
          panel.id = "equip-ergo-panel";
          panel.innerHTML = `
                <div class="stamina-disclaimer"><strong style="color:#eee;">${t("stats.eedLabel")}</strong> ${t("stats.eedDesc")}</div>
                <div class="stamina-disclaimer"><strong style="color:#eee;">${t("stats.overswing")}</strong> ${t("stats.overswingDesc")}</div>
              <div class="strength-control">
                  <label style="color:#eee;">${t("stats.equipErgoLabel")}</label>
                  <div class="stamina-disclaimer">${t("stats.equipErgoDisclaimer")}</div>
                  <div class="strength-input-row">
                      <input type="range" id="equip-ergo-slider" min="0" max="100" step="1" value="${Math.round(-EFTForge.state.currentEquipErgoModifier * 100)}" />
                      <span class="input-prefix">-</span><input type="number" id="equip-ergo-input" min="0" max="100" value="${Math.round(-EFTForge.state.currentEquipErgoModifier * 100)}" />
                      <span class="input-suffix">%</span>
                  </div>
              </div>
          `;
          document.getElementById("overswing-value-span").closest(".stat-row").after(panel);

          panel.style.height = "0px";
          panel.style.opacity = "0";
          void panel.offsetHeight;
          panel.style.height = panel.scrollHeight + "px";
          panel.style.opacity = "1";
          panel.addEventListener("transitionend", () => {
              panel.style.height = "";
              panel.style.opacity = "";
          }, { once: true });

          wireEquipErgoControls();
      }
  });

  if (savedStaminaPanel) {
    document.getElementById("stamina-info-btn")?.closest(".stat-row")?.after(savedStaminaPanel);
    wireStrengthControls();
  }
  if (savedEquipErgoPanel) {
    document.getElementById("overswing-value-span")?.closest(".stat-row")?.after(savedEquipErgoPanel);
    wireEquipErgoControls();
  }
}

function wireStrengthControls() {
    const slider = document.getElementById("strength-slider");
    const numInput = document.getElementById("strength-input");
    if (!slider || !numInput) return;

    // Use "input" only to update the label and number box live while dragging
    // Do NOT call refreshBuildStats here - it rebuilds the DOM and kills the drag
    slider.addEventListener("input", () => {
        EFTForge.state.currentStrengthLevel = parseInt(slider.value);
        numInput.value = EFTForge.state.currentStrengthLevel;

        // Recalculate arm stamina inline without triggering a DOM rebuild
        const armStamina = calcArmStamina(EFTForge.state.lastTotalWeight, EFTForge.state.lastTotalErgo, EFTForge.state.currentStrengthLevel, EFTForge.state.currentEquipErgoModifier);

        const staminaSpan = document.querySelector("#stamina-info-btn")?.closest(".stat-row")?.lastElementChild;
        if (staminaSpan) staminaSpan.textContent = armStamina.toFixed(1) + "s";
    });

    slider.addEventListener("change", () => {
        // Update the display directly instead of triggering a full rebuild
        localStorage.setItem("eftforge_strength_level", EFTForge.state.currentStrengthLevel);
        const armStamina = calcArmStamina(EFTForge.state.lastTotalWeight, EFTForge.state.lastTotalErgo, EFTForge.state.currentStrengthLevel, EFTForge.state.currentEquipErgoModifier);

        const staminaSpan = document.querySelector("#stamina-info-btn")?.closest(".stat-row")?.lastElementChild;
        if (staminaSpan) staminaSpan.textContent = armStamina.toFixed(1) + "s";
    });

    numInput.addEventListener("change", () => {
        let val = parseInt(numInput.value);
        if (isNaN(val)) val = 10;
        val = Math.max(0, Math.min(51, val));
        EFTForge.state.currentStrengthLevel = val;
        numInput.value = val;
        slider.value = val;
        localStorage.setItem("eftforge_strength_level", val);
        refreshBuildStats();
    });

    numInput.addEventListener("input", () => {
        numInput.value = numInput.value.replace(/[^0-9]/g, "");
        let val = parseInt(numInput.value);
        if (isNaN(val)) return;
        val = Math.max(0, Math.min(51, val));
        EFTForge.state.currentStrengthLevel = val;
        numInput.value = val;
        slider.value = val;

        const armStamina = calcArmStamina(EFTForge.state.lastTotalWeight, EFTForge.state.lastTotalErgo, EFTForge.state.currentStrengthLevel, EFTForge.state.currentEquipErgoModifier);

        const staminaSpan = document.querySelector("#stamina-info-btn")?.closest(".stat-row")?.lastElementChild;
        if (staminaSpan) staminaSpan.textContent = armStamina.toFixed(1) + "s";
    });
}

function wireEquipErgoControls() {
    const slider = document.getElementById("equip-ergo-slider");
    const numInput = document.getElementById("equip-ergo-input");
    if (!slider || !numInput) return;

    function updateEquipErgoDisplay() {
        const eed = calcEED(EFTForge.state.lastTotalErgo, EFTForge.state.lastTotalWeight, EFTForge.state.currentEquipErgoModifier);
        const overswing = eed < 0;

        const eedSpan = document.getElementById("eed-value-span");
        if (eedSpan) {
            eedSpan.className = eed >= 0 ? "positive" : "negative";
            eedSpan.textContent = (eed > 0 ? "+" : "") + eed.toFixed(1);
        }

        const eedRow = eedSpan?.closest(".stat-row-eed");
        const infoBtn = document.getElementById("equip-ergo-info-btn");
        if (eedRow) {
            const existing = eedRow.querySelector(".eed-warning-icon");
            if (eed >= 0 && eed < 7 && EFTForge.state.currentEquipErgoModifier === 0) {
                if (!existing) {
                    const icon = document.createElement("span");
                    icon.className = "eed-warning-icon";
                    icon.dataset.tooltip = t("stats.eedWarnTooltip");
                    icon.textContent = "⚠";
                    icon.style.cursor = "pointer";
                    icon.addEventListener("click", () => document.getElementById("equip-ergo-info-btn")?.click());
                    eedSpan.after(icon);
                }
                infoBtn?.classList.add("eed-warn-active");
            } else {
                existing?.remove();
                infoBtn?.classList.remove("eed-warn-active");
            }
        }

        const overswingSpan = document.getElementById("overswing-value-span");
        if (overswingSpan) {
            overswingSpan.className = overswing ? "negative" : "positive";
            overswingSpan.textContent = overswing ? t("stats.yes") : t("stats.no");
        }

        const armStamina = calcArmStamina(EFTForge.state.lastTotalWeight, EFTForge.state.lastTotalErgo, EFTForge.state.currentStrengthLevel, EFTForge.state.currentEquipErgoModifier);
        const staminaSpan = document.querySelector("#stamina-info-btn")?.closest(".stat-row")?.lastElementChild;
        if (staminaSpan) staminaSpan.textContent = armStamina.toFixed(1) + "s";
    }

    slider.addEventListener("input", () => {
        EFTForge.state.currentEquipErgoModifier = -parseInt(slider.value) / 100;
        numInput.value = Math.round(-EFTForge.state.currentEquipErgoModifier * 100);
        updateEquipErgoDisplay();
    });

    slider.addEventListener("change", () => {
        updateEquipErgoDisplay();
    });

    numInput.addEventListener("change", () => {
        let val = parseInt(numInput.value);
        if (isNaN(val)) val = 0;
        val = Math.max(0, Math.min(100, val));
        EFTForge.state.currentEquipErgoModifier = -val / 100;
        numInput.value = val;
        slider.value = val;
        refreshBuildStats();
    });

    numInput.addEventListener("input", () => {
        numInput.value = numInput.value.replace(/[^0-9]/g, "");
        let val = parseInt(numInput.value);
        if (isNaN(val)) return;
        val = Math.max(0, Math.min(100, val));
        EFTForge.state.currentEquipErgoModifier = -val / 100;
        numInput.value = val;
        slider.value = val;
        updateEquipErgoDisplay();
    });
}

function closeConfigPanel(id) {
    const panel = document.getElementById(id);
    if (!panel) return;
    panel.style.height = panel.scrollHeight + "px";
    panel.style.opacity = "1";
    void panel.offsetHeight;
    panel.style.height = "0px";
    panel.style.opacity = "0";
    panel.style.marginTop = "0px";
    panel.style.padding = "0px";
    panel.style.borderWidth = "0px";
    setTimeout(() => panel.remove(), 200);
}

document.addEventListener("click", (e) => {
    if (!e.target.closest("#slots")) return;
    closeConfigPanel("stamina-panel");
    closeConfigPanel("equip-ergo-panel");
    if (document.getElementById("hidden-stats-panel")) {
        _removeHiddenStatsPanel();
    }
}, true);
