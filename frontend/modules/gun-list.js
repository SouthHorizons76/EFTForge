window.EFTForge = window.EFTForge || {};

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

    const container = document.getElementById("main-container");
    container.classList.add("no-gun");

    document.getElementById("weapon-selector").style.removeProperty("display");

    document.getElementById("left-build-area").style.display = "none";

    document.getElementById("attachment-table-container").innerHTML = "";
    document.getElementById("attachment-placeholder").style.display = "flex";

    document.querySelectorAll(".tree-slot.active-slot")
        .forEach(el => el.classList.remove("active-slot"));

    const gunDisplayName = document.getElementById("gun-display-name");
    const gunDisplayImage = document.getElementById("gun-display-image");
    if (gunDisplayName) gunDisplayName.textContent = "";
    if (gunDisplayImage) gunDisplayImage.style.display = "none";

    document.querySelectorAll(".gun-card")
        .forEach(card => card.classList.remove("selected"));
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

function renderGunList(guns) {
  const list = document.getElementById("guns");
  list.innerHTML = "";

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
      groupKey = g.weapon_category || "Primary";
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
    header.textContent = EFTForge.state.sortByClass ? (EFTForge.config.CLASS_DISPLAY_NAMES[groupName] ?? groupName) : groupName;
    list.appendChild(header);

    grouped[groupName]
      .sort((a, b) => (b.base_ergo ?? 0) - (a.base_ergo ?? 0))
      .forEach(gun => {
        const card = document.createElement("div");
        card.className = "gun-card";
        card.innerHTML = `
          <img src="${escapeHtml(gun.image_512_link || gun.icon_link)}" />
          <div class="gun-name">${escapeHtml(gun.name)}</div>
        `;
        card.onclick = () => selectGun(gun, card);
        list.appendChild(card);
      });
  });
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
        // Switch left panel to build mode
        document.getElementById("weapon-selector").style.display = "none";

        document.getElementById("left-build-area").style.display = "flex";

    // Reset right panel state
    document.getElementById("attachment-table-container").innerHTML = "";

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

    await renderFullTree();
    await loadAmmoForGun(gun);
    await refreshBuildStats();
    stopPanelLoading(selectGunOverlay);
}

async function loadAmmoForGun(gun) {

  const ammoSelect = document.getElementById("ammo-select");
  if (!ammoSelect) return;

  // Save currently selected ammo before clearing
  const previouslySelected = ammoSelect.value;

  ammoSelect.innerHTML = "";

  if (!gun.caliber) return;

  let ammoList;
  try {
    ammoList = await fetchAmmo(gun.caliber);
  } catch (err) {
    console.error("Failed to load ammo:", err);
    showToast("Connection Error", "Could not load ammo data. Is the backend running?", 5000);
    return;
  }

  if (ammoList.length === 0) {
    ammoSelect.innerHTML = `<option value="">No ammo found</option>`;
    return;
  }

  ammoList.forEach(ammo => {
    const option = document.createElement("option");
    option.value = ammo.id;
    option.textContent = `${ammo.name} (${ammo.weight.toFixed(3)}kg)`;
    ammoSelect.appendChild(option);
  });

  // Restore previous selection if possible
  if (previouslySelected) {
    ammoSelect.value = previouslySelected;
  }

  // If nothing selected yet, default to first
  if (!ammoSelect.value) {
    ammoSelect.selectedIndex = 0;
  }
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
