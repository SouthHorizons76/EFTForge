window.EFTForge = window.EFTForge || {};

function _readMidBuildSnapshot() {
    try {
        const raw = localStorage.getItem("eftforge_session_snapshot");
        if (!raw) return null;
        const snap = JSON.parse(raw);
        // Only treat as mid-build if it has a gunId, a build code, and is NOT a saved build
        return (snap?.gunId && snap?.code && !snap.buildName) ? snap : null;
    } catch (_) { return null; }
}

function _applyMidBuildIndicator() {
    document.querySelectorAll(".gun-card.mid-build").forEach(c => c.classList.remove("mid-build"));
    const snap = _readMidBuildSnapshot();
    if (!snap) return;
    const card = document.querySelector(`.gun-card[data-gun-id="${CSS.escape(snap.gunId)}"]`);
    if (!card) return;
    if (card.classList.contains("gun-card-entering")) {
        card.addEventListener("animationend", () => card.classList.add("mid-build"), { once: true });
    } else {
        card.classList.add("mid-build");
    }
}

async function _selectGunOrRestoreSnapshot(gun, card) {
    const snap = _readMidBuildSnapshot();
    if (snap && snap.gunId === gun.id) {
        clearSessionSnapshot();
        card.classList.remove("mid-build");
        const payload = decodeBuildCode(snap.code);
        if (payload) {
            await loadBuildFromPayload(payload, null, true);
            // loadBuildFromPayload uses a dummyEl, manually mark the card
            document.querySelectorAll(".gun-card").forEach(c => c.classList.remove("selected"));
            card.classList.add("selected");
        } else {
            await selectGun(gun, card);
        }
    } else if (snap) {
        showDiscardChangesModal(snap, () => selectGun(gun, card));
    } else {
        await selectGun(gun, card);
    }
}

let _initialRender = true;
let _cachedGunCards = []; // [{card, rect}, ...]
let _gunProximityHandler = null;
let _gunProximityLeaveHandler = null;
let _rafPending = false;
let _gunResizeObserver = null;
let _hoveredTiltCard = null;

function _updateGunCardRects() {
  for (const entry of _cachedGunCards) {
    entry.rect = entry.card.getBoundingClientRect();
  }
}

function attachGunCardProximityEffect() {
  const container = document.getElementById("weapon-selector");
  if (!container) return;

  if (_gunProximityHandler) {
    container.removeEventListener("mousemove", _gunProximityHandler);
    container.removeEventListener("mouseleave", _gunProximityLeaveHandler);
    container.removeEventListener("scroll", _updateGunCardRects);
  }

  _rafPending = false;
  _updateGunCardRects();

  const MAX_TILT = 12; // degrees
  const IMG_SHIFT = 4; // px - subtle counter-drift gives the card a window/depth illusion

  function springBack(card) {
    const img = card.querySelector("img");

    card.style.transition = "border-color 0.15s ease, transform 0.6s ease-out";
    card.style.removeProperty("transform");
    const onDone = (e) => {
      if (e.propertyName !== "transform") return;
      card.removeEventListener("transitionend", onDone);
      card.style.removeProperty("transition");
    };
    card.addEventListener("transitionend", onDone);

    if (img) {
      img.style.transition = "transform 0.6s ease-out";
      img.style.removeProperty("transform");
      img.addEventListener("transitionend", () => img.style.removeProperty("transition"), { once: true });
    }
  }

  _gunProximityHandler = (e) => {
    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(() => {
      // Spotlight glow on all cards
      for (const { card, rect } of _cachedGunCards) {
        card.style.setProperty("--mouse-x", (e.clientX - rect.left) + "px");
        card.style.setProperty("--mouse-y", (e.clientY - rect.top) + "px");
      }

      // 3D tilt on hovered card only
      const target = e.target.closest(".gun-card");
      if (_hoveredTiltCard && _hoveredTiltCard !== target) {
        springBack(_hoveredTiltCard);
        _hoveredTiltCard = null;
      }
      if (target) {
        // Clear any spring-back transition so tilt tracks the mouse directly
        target.style.removeProperty("transition");

        const r = target.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width  / 2)) / (r.width  / 2);
        const dy = (e.clientY - (r.top  + r.height / 2)) / (r.height / 2);
        target.style.transform = `perspective(500px) rotateX(${(-dy * MAX_TILT).toFixed(2)}deg) rotateY(${(dx * MAX_TILT).toFixed(2)}deg) translateY(-2px) scale(1.02)`;

        // Counter-translate the image so it appears to float at a different depth
        const img = target.querySelector("img");
        if (img) {
          img.style.removeProperty("transition");
          img.style.transform = `scale(1.05) translate(${(-dx * IMG_SHIFT).toFixed(2)}px, ${(-dy * IMG_SHIFT).toFixed(2)}px)`;
        }

        _hoveredTiltCard = target;
      }

      _rafPending = false;
    });
  };

  _gunProximityLeaveHandler = () => {
    for (const { card } of _cachedGunCards) {
      card.style.removeProperty("--mouse-x");
      card.style.removeProperty("--mouse-y");
    }
    if (_hoveredTiltCard) {
      springBack(_hoveredTiltCard);
      _hoveredTiltCard = null;
    }
  };

  container.addEventListener("mousemove", _gunProximityHandler);
  container.addEventListener("mouseleave", _gunProximityLeaveHandler);
  container.addEventListener("scroll", _updateGunCardRects, { passive: true });

  if (!_gunResizeObserver) {
    _gunResizeObserver = new ResizeObserver(_updateGunCardRects);
    _gunResizeObserver.observe(container);
  }
}

function updateToggleUI() {
  const primaryBtn = document.getElementById("primary-btn");
  const handgunBtn = document.getElementById("handgun-btn");
  const caliberBtn = document.getElementById("sort-caliber-btn");
  const classBtn   = document.getElementById("sort-class-btn");

  primaryBtn.classList.toggle("active", !EFTForge.state.showHandguns);
  handgunBtn.classList.toggle("active", EFTForge.state.showHandguns);
  caliberBtn.classList.toggle("active", !EFTForge.state.sortByClass);
  classBtn.classList.toggle("active", EFTForge.state.sortByClass);
}

function returnToGunSelection() {

    EFTForge.state.currentGun = null;
    EFTForge.state.buildTree = null;
    EFTForge.state.lastParentNode = null;
    EFTForge.state.lastSlot = null;
    EFTForge.state.lastProcessedItems = [];
    EFTForge.state.currentSearchQuery = "";

    // Always reset to modding view so the next gun opens with build panels visible
    if (EFTForge.state.priceView) _applyViewMode(false);

    const container = document.getElementById("main-container");
    container.classList.add("no-gun");
    updateMobileTabBarVisibility();

    document.getElementById("left-build-area").style.display = "none";

    const weaponSelector = document.getElementById("weapon-selector");
    weaponSelector.style.removeProperty("display");
    weaponSelector.classList.add("panel-enter");
    weaponSelector.addEventListener("animationend", () => weaponSelector.classList.remove("panel-enter"), { once: true });

    document.getElementById("attachment-table-container").innerHTML = "";
    document.getElementById("attachment-placeholder").style.display = "flex";

    const statsBox = document.getElementById("stats");
    if (statsBox) statsBox.innerHTML = "";

    document.querySelectorAll(".tree-slot.active-slot")
        .forEach(el => el.classList.remove("active-slot"));

    const gunDisplayName = document.getElementById("gun-display-name");
    const gunDisplayImage = document.getElementById("gun-display-image");
    if (gunDisplayName) gunDisplayName.textContent = "";
    if (gunDisplayImage) gunDisplayImage.style.display = "none";

    document.querySelectorAll(".gun-card")
        .forEach(card => card.classList.remove("selected"));

    _applyMidBuildIndicator();
}

function focusGunSearch(initialChar) {
  const input = document.getElementById("gun-search");
  if (!input) return;

  input.focus();
  input.value = initialChar;
  input.dispatchEvent(new Event("input"));
}

function focusAttachmentSearch(initialChar) {
  const input = document.getElementById("attachment-search");
  if (!input) return;

  input.focus();
  input.value = initialChar;
  input.dispatchEvent(new Event("input"));
}

function clearSearch() {
  const gunInput = document.getElementById("gun-search");
  const attachmentInput = document.getElementById("attachment-search");

  if (gunInput) {
    gunInput.value = "";
    gunInput.dispatchEvent(new Event("input"));
  }

  if (attachmentInput) {
    attachmentInput.value = "";
    attachmentInput.dispatchEvent(new Event("input"));
  }
}

function renderGunList(guns, forceStagger = false) {
  const list = document.getElementById("guns");
  list.innerHTML = "";

  const doStagger = _initialRender || forceStagger;
  if (_initialRender) _initialRender = false;
  let cardIndex = 0;

  const grouped = {};

  guns.forEach(g => {

    const isHandgun =
      g.weapon_category === "Handgun" ||
      g.weapon_category === "Revolver";

    const isToyGun = g.caliber === "Caliber20x1mm";

    // Primary mode
    if (!EFTForge.state.showHandguns) {
      if (isHandgun && !isToyGun) return;
    }

    // Pistol mode
    if (EFTForge.state.showHandguns) {
      if (!isHandgun && !isToyGun) return;
    }

    const nameLower = g.name.toLowerCase();
    const rawCaliber = g.caliber;

    // Remove signal cartridges (26x75)
    if (rawCaliber === "Caliber26x75") return;

    // Remove rocket launchers
    if (nameLower.includes("rocket") || nameLower.includes("rshg")) return;

    let groupKey;
    if (EFTForge.state.sortByClass) {
      groupKey = isToyGun ? "__toy__" : (g.weapon_category || "Primary");
    } else {
      groupKey = EFTForge.config.CALIBER_DISPLAY_MAP[g.caliber];
      if (!groupKey) {
        console.warn("Unmapped caliber detected:", g.caliber);
        groupKey = "Other";
      }
    }

    if (!grouped[groupKey]) grouped[groupKey] = [];
    grouped[groupKey].push(g);
  });

  const caliberOrder = EFTForge.config.CALIBER_ORDER;
  const classOrder   = EFTForge.config.CLASS_ORDER;

  const sortedGroups = Object.keys(grouped).sort((a, b) => {
    if (EFTForge.state.sortByClass) {
      if (a === "__toy__") return -1;
      if (b === "__toy__") return 1;
      const ai = classOrder.indexOf(a);
      const bi = classOrder.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    } else {
      if (a === "20x1mm disk") return -1;
      if (b === "20x1mm disk") return 1;
      if (a === "Other") return 1;
      if (b === "Other") return -1;
      const aIndex = caliberOrder.indexOf(a);
      const bIndex = caliberOrder.indexOf(b);
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    }
  });

  sortedGroups.forEach(groupName => {
    const header = document.createElement("div");
    header.style.gridColumn = "1 / -1";
    header.className = "caliber-header";
    header.textContent = EFTForge.state.sortByClass ? tClass(groupName === "__toy__" ? "Handgun" : groupName) : groupName;
    list.appendChild(header);

    grouped[groupName]
      .sort((a, b) => (b.base_ergo ?? 0) - (a.base_ergo ?? 0))
      .forEach(gun => {
        const card = document.createElement("div");
        card.className = "gun-card";
        card.dataset.gunId = gun.id;
        if (doStagger) {
          card.classList.add("gun-card-entering");
          card.style.animationDelay = `${cardIndex * 22}ms`;
          card.addEventListener("animationend", () => card.classList.remove("gun-card-entering"), { once: true });
          cardIndex++;
        }
        card.innerHTML = `
          <img src="${escapeHtml(gun.image_512_link || gun.icon_link)}" />
          <div class="gun-name">${escapeHtml(gun.name)}</div>
        `;
        card.onclick = gun.caliber === 'Caliber20x1mm'
            ? () => _selectGunOrRestoreSnapshot(gun, card).then(() => EFTForge.news.showSecretPost())
            : () => _selectGunOrRestoreSnapshot(gun, card);
        list.appendChild(card);
      });
  });

  _cachedGunCards = Array.from(list.querySelectorAll(".gun-card")).map(card => ({ card, rect: null }));
  attachGunCardProximityEffect();
  _applyMidBuildIndicator();
}

async function selectGun(gun, liElement) {
    // If clicking same gun, do nothing
    if (EFTForge.state.currentGun && EFTForge.state.currentGun.id === gun.id) {
        return;
    }

  EFTForge.state.currentGun = gun;
  EFTForge.state.currentEquipErgoModifier = 0;

    // Switch layout from full selector mode to dual panel mode
    const container = document.getElementById("main-container");
        container.classList.remove("no-gun");
        switchToMobileTab("build");
        updateMobileTabBarVisibility();
        // Switch left panel to build mode
        document.getElementById("weapon-selector").style.display = "none";

        const buildArea = document.getElementById("left-build-area");
        buildArea.style.display = "flex";
        buildArea.classList.add("panel-enter");
        buildArea.addEventListener("animationend", () => buildArea.classList.remove("panel-enter"), { once: true });
        updateViewToggleLabels();

    // Reset right panel state
    document.getElementById("attachment-table-container").innerHTML = "";
    EFTForge.state.communityBuild = null;

    // clear publish confirm panel if it was showing
    if (EFTForge.state.publishMode) {
        EFTForge.state.publishMode = false;
        if (typeof _restoreNormalPlaceholder === "function") _restoreNormalPlaceholder();
    }

    const placeholder = document.getElementById("attachment-placeholder");
    if (placeholder) {
        placeholder.style.display = "flex";
    }

    EFTForge.state.lastParentNode = null;
    EFTForge.state.lastSlot = null;
    EFTForge.state.lastProcessedItems = [];

  EFTForge.state.buildTree = {
    item: gun,
    children: {}
  };

    document.querySelectorAll(".gun-card")
        .forEach(card => card.classList.remove("selected"));

    liElement.classList.add("selected");

  const imageSrc = gun.image_512_link || gun.icon_link;

    const gunDisplayImage = document.getElementById("gun-display-image");
    const gunDisplayName = document.getElementById("gun-display-name");

    if (gunDisplayImage && gunDisplayName) {
        gunDisplayName.textContent = gun.name;
        if (imageSrc) {
            gunDisplayImage.src = imageSrc;
            gunDisplayImage.style.display = "block";
        } else {
            gunDisplayImage.style.display = "none";
        }
    }

  const selectGunOverlay = startPanelLoading(document.querySelector(".left-panel"), 1000);

  // INSTALL FACTORY ATTACHMENTS
  if (gun.factory_attachment_ids) {

    const factoryIds = Array.isArray(gun.factory_attachment_ids)
      ? gun.factory_attachment_ids
      : gun.factory_attachment_ids.split(",");

    for (const id of factoryIds) {
      if (id && id.trim() !== "") {
        await installFactoryAttachment(EFTForge.state.buildTree, id.trim());
      }
    }
  }

    EFTForge.state.factoryPairsKey = _pairsKey(collectSlotPairs(EFTForge.state.buildTree));

    await renderFullTree();
    await loadAmmoForGun(gun);
    await refreshBuildStats();
    stopPanelLoading(selectGunOverlay);
    updateGunBuildsBadge(gun.id);
}

async function loadAmmoForGun(gun) {

  const ammoSelect = document.getElementById("ammo-select");
  if (!ammoSelect) return;

  ammoSelect.innerHTML = "";

  if (!gun.caliber) return;

  let ammoList;
  try {
    ammoList = await fetchAmmo(gun.caliber);
  } catch (err) {
    console.error("Failed to load ammo:", err);
    showToast(t("toast.connectionError"), t("toast.ammoLoadFailed") + " " + (EFTForge.config.IS_LOCAL_DEV ? t("toast.networkHintDev") : t("toast.networkHintProd")), 5000);
    return;
  }

  if (ammoList.length === 0) {
    ammoSelect.innerHTML = `<option value="">${t("ui.noAmmoFound")}</option>`;
    return;
  }

  const ammoWeightMap = {};
  const ammoMap = {};
  ammoList.forEach(ammo => {
    const option = document.createElement("option");
    option.value = ammo.id;
    option.textContent = `${ammo.name} (${ammo.weight.toFixed(3)}kg)`;
    ammoSelect.appendChild(option);
    ammoWeightMap[ammo.id] = ammo.weight;
    ammoMap[ammo.id] = ammo;
  });
  EFTForge.state.ammoWeightMap = ammoWeightMap;
  EFTForge.state.ammoMap = ammoMap;

  // Restore saved ammo preference for this caliber, else default to first
  const ammoPrefs = JSON.parse(localStorage.getItem("eftforge_ammo_prefs") || "{}");
  const savedAmmo = ammoPrefs[gun.caliber];
  if (savedAmmo) {
    ammoSelect.value = savedAmmo;
  }
  if (!ammoSelect.value) {
    ammoSelect.selectedIndex = 0;
  }
  // Sync the custom dropdown trigger after programmatic value assignment
  ammoSelect.dispatchEvent(new Event("input"));
}

async function installFactoryAttachment(node, attachmentId, allFactoryIds = null) {

  if (!allFactoryIds) {
    allFactoryIds = Array.isArray(EFTForge.state.currentGun.factory_attachment_ids)
      ? EFTForge.state.currentGun.factory_attachment_ids
      : EFTForge.state.currentGun.factory_attachment_ids.split(",");
  }

  // Get slots (cached)
  let slots;

  if (EFTForge.state.slotCache[node.item.id]) {
    slots = EFTForge.state.slotCache[node.item.id];
  } else {
    try {
      slots = await fetchItemSlots(node.item.id);
      cacheSet(EFTForge.state.slotCache, node.item.id, slots);
    } catch (err) {
      console.error("Failed to load slots for factory attachment:", err);
      return;
    }
  }

  for (const slot of slots) {

    let allowed;

    if (EFTForge.state.allowedCache[slot.id]) {
      allowed = EFTForge.state.allowedCache[slot.id];
    } else {
      try {
        allowed = await fetchSlotAllowedItems(slot.id);
        cacheSet(EFTForge.state.allowedCache, slot.id, allowed);
      } catch (err) {
        console.error("Failed to load allowed items for slot:", err);
        continue;
      }
    }

    const match = allowed.find(i => i.id === attachmentId);

    if (match) {

      node.children[slot.id] = {
        item: match,
        children: {}
      };

      for (const nextId of allFactoryIds) {
        if (nextId !== attachmentId) {
          await installFactoryAttachment(node.children[slot.id], nextId, allFactoryIds);
        }
      }

      return;
    }
  }
}
