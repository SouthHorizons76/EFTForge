const API_BASE = "http://127.0.0.1:8000";

let allGuns = [];
let currentGun = null;
let buildTree = null;
let slotCache = {};
let allowedCache = {};
let processedCache = {};
let showHandguns = false;
let sortByClass = false;
let collapsedSlots = {};
let currentStrengthLevel = 10;
let lastTotalWeight = 0;
let lastTotalErgo = 0;
let lastRecoilV = null;
let lastRecoilH = null;
let lastEED = 0;
let lastBaseWeight = 0;

const CALIBER_DISPLAY_MAP = {
    "Caliber20x1mm": "20x1mm disk",
    "Caliber762x39": "7.62x39",
    "Caliber762x51": "7.62x51",
    "Caliber762x54R": "7.62x54R",
    "Caliber556x45NATO": "5.56x45",
    "Caliber545x39": "5.45x39",
    "Caliber9x19PARA": "9x19",
    "Caliber9x18PM": "9x18",
    "Caliber9x18PMM": "9x18",  
    "Caliber9x21": "9x21",
    "Caliber9x39": "9x39",
    "Caliber57x28": "5.7x28",
    "Caliber366TKM": ".366 TKM",
    "Caliber127x55": "12.7x55",
    "Caliber12g": "12/70",
    "Caliber20g": "20/70",
    "Caliber23x75": "23x75",
    "Caliber1143x23ACP": ".45 ACP",
    "Caliber127x99": ".50 BMG",
    "Caliber762x25TT": "7.62x25 TT",
    "Caliber784x49": ".308",
    "Caliber762x35": ".300 BLK",
    "Caliber68x51": "6.8x51",
    "Caliber40x46": "40x46 Grenade",
    "Caliber26x75": "26x75 Flare",
    "Caliber30Carbine": ".30 Carbine",
    "Caliber9x33R": ".357 Magnum",
    "Caliber46x30": "4.6x30",
    "Caliber338LM": ".338 LM",
    "Caliber86x70": ".338 LM",
    "Caliber127x33": ".50 AE",
    "Caliber93x64": "9.3x64",
};

/* ===========================
   UTILITIES
=========================== */

const CACHE_MAX = 300;

function cacheSet(cache, key, value) {
    if (Object.keys(cache).length >= CACHE_MAX) {
        // Drop the oldest ~half to avoid thrashing on a full cache
        const keys = Object.keys(cache);
        for (let i = 0; i < Math.floor(CACHE_MAX / 2); i++) delete cache[keys[i]];
    }
    cache[key] = value;
}

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

const CLASS_DISPLAY_NAMES = {
    "Assault rifle":   "Assault Rifles",
    "Assault carbine": "Assault Carbines",
    "Marksman rifle":  "Marksman Rifles",
    "Sniper rifle":    "Sniper Rifles",
    "Machinegun":      "Light Machine Guns",
    "Machine gun":     "Light Machine Guns",
    "Machine Gun":     "Light Machine Guns",
    "SMG":             "Submachine Guns",
    "Submachine gun":  "Submachine Guns",
    "Shotgun":         "Shotguns",
    "Handgun":         "Handguns",
    "Revolver":        "Revolvers",
    "Grenade launcher":"Grenade Launchers",
    "Grenade Launcher":"Grenade Launchers",
    "Primary":         "Other",
};

function calcArmStamina(weight, ergo, strengthLevel) {
    return (
        (85.5 / (weight + 0.65))
        + 9.15
        + 0.06477 * ergo
    ) / 1.04 * (1 + strengthLevel * 0.004);
}

/* ===========================
   INITIAL LOAD
=========================== */

init();

async function init() {
  try {
    const res = await fetch(`${API_BASE}/guns`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    allGuns = await res.json();
    renderGunList(allGuns);
  } catch (err) {
    console.error("Failed to load guns:", err);
    showToast("Connection Error", "Could not load weapon list. Is the backend running?", 7000);
  }

  document
    .getElementById("gun-search")
    .addEventListener("input", (e) => {
        const query = e.target.value.toLowerCase();

        const filtered = allGuns.filter(g =>
        g.name.toLowerCase().includes(query)
        );

        renderGunList(filtered);
    });

    document.addEventListener("keydown", (e) => {
    // ESC clears search regardless of focus
    if (e.key === "Escape") {
        clearSearch();
        document.activeElement.blur();
        return;
    }

    // Ignore if user is already typing in an input
    const tag = document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    // Ignore control keys
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Only react to printable characters
    if (e.key.length === 1) {
        e.preventDefault();

        const gunInput = document.getElementById("gun-search");
        const attachmentInput = document.getElementById("attachment-search");

        if (gunInput && gunInput.offsetParent !== null) {
            focusGunSearch(e.key);
        }
        else if (attachmentInput && attachmentInput.offsetParent !== null) {
            focusAttachmentSearch(e.key);
        }
        }
    });

    document.getElementById("primary-btn").addEventListener("click", () => {
        showHandguns = false;
        updateToggleUI();
        renderGunList(allGuns);
    });

    document.getElementById("handgun-btn").addEventListener("click", () => {
        showHandguns = true;
        updateToggleUI();
        renderGunList(allGuns);
    });

    document.getElementById("sort-caliber-btn").addEventListener("click", () => {
        sortByClass = false;
        updateToggleUI();
        renderGunList(allGuns);
    });

    document.getElementById("sort-class-btn").addEventListener("click", () => {
        sortByClass = true;
        updateToggleUI();
        renderGunList(allGuns);
    });
}

function showToast(title, message, duration = 3000) {

    const container = document.getElementById("toast-container");

    const toast = document.createElement("div");
    toast.className = "toast";

    toast.innerHTML = `
        <div class="toast-title">${title}</div>
        <div class="toast-body">${message}</div>
    `;

    container.appendChild(toast);

    // Trigger animation
    setTimeout(() => {
        toast.classList.add("show");
    }, 10);

    // Auto remove
    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => {
            container.removeChild(toast);
        }, 250);
    }, duration);
}

function updateToggleUI() {
  const primaryBtn = document.getElementById("primary-btn");
  const handgunBtn = document.getElementById("handgun-btn");
  const caliberBtn = document.getElementById("sort-caliber-btn");
  const classBtn   = document.getElementById("sort-class-btn");

  primaryBtn.classList.toggle("active", !showHandguns);
  handgunBtn.classList.toggle("active", showHandguns);
  caliberBtn.classList.toggle("active", !sortByClass);
  classBtn.classList.toggle("active", sortByClass);
}

function returnToGunSelection() {

    currentGun = null;
    buildTree = null;
    lastParentNode = null;
    lastSlot = null;
    lastProcessedItems = [];
    currentSearchQuery = "";

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

/* ===========================
   ATTACHMENT TABLE STATE
=========================== */

let attachmentSort = {
  key: "recoil",
  direction: "asc"
};

let lastProcessedItems = [];
let lastParentNode = null;
let lastSlot = null;

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

/* ===========================
   GUN LIST
=========================== */

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
    if (!showHandguns) {
      if (isHandgun && !isToyGun) return;
    }

    // Pistol mode
    if (showHandguns) {
      if (!isHandgun && !isToyGun) return;
    }

    const nameLower = g.name.toLowerCase();
    const rawCaliber = g.caliber;

    // Remove signal cartridges (26x75)
    if (rawCaliber === "Caliber26x75") return;

    // Remove rocket launchers
    if (nameLower.includes("rocket") || nameLower.includes("rshg")) return;

    let groupKey;
    if (sortByClass) {
      groupKey = g.weapon_category || "Primary";
    } else {
      groupKey = CALIBER_DISPLAY_MAP[g.caliber];
      if (!groupKey) {
        console.warn("Unmapped caliber detected:", g.caliber);
        groupKey = "Other";
      }
    }

    if (!grouped[groupKey]) grouped[groupKey] = [];
    grouped[groupKey].push(g);
  });

  const caliberOrder = [
    "5.45x39", "5.56x45", "6.8x51",
    "7.62x39", "7.62x51", "7.62x54R", "7.62x25 TT",
    ".300 BLK", ".308", ".338 LM", ".366 TKM", "9.3x64",
    "9x18", "9x19", "9x21", "9x39", "5.7x28", "4.6x30", ".357 Magnum",
    ".45 ACP", ".50 AE", ".30 Carbine",
    "12/70", "20/70", "23x75",
    "12.7x55", "40x46 Grenade", ".50 BMG",
  ];

  const classOrder = [
    "Assault rifle", "Assault carbine", "Marksman rifle", "Sniper rifle",
    "Machinegun", "Machine gun", "Machine Gun",
    "SMG", "Submachine gun",
    "Shotgun",
    "Handgun", "Revolver",
    "Grenade launcher", "Grenade Launcher",
    "Primary",
  ];

  const sortedGroups = Object.keys(grouped).sort((a, b) => {
    if (sortByClass) {
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
    header.textContent = sortByClass ? (CLASS_DISPLAY_NAMES[groupName] ?? groupName) : groupName;
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
    if (currentGun && currentGun.id === gun.id) {
        return;
    }

  currentGun = gun;

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

    lastParentNode = null;
    lastSlot = null;
    lastProcessedItems = [];

  buildTree = {
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

  // INSTALL FACTORY ATTACHMENTS
  if (gun.factory_attachment_ids) {

    const factoryIds = Array.isArray(gun.factory_attachment_ids)
      ? gun.factory_attachment_ids
      : gun.factory_attachment_ids.split(",");

    for (const id of factoryIds) {
      if (id && id.trim() !== "") {
        await installFactoryAttachment(buildTree, id.trim());
      }
    }
  }

    await renderFullTree();
    await refreshBuildStats();
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
    const res = await fetch(`${API_BASE}/ammo/${gun.caliber}`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    ammoList = await res.json();
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
    allFactoryIds = Array.isArray(currentGun.factory_attachment_ids)
      ? currentGun.factory_attachment_ids
      : currentGun.factory_attachment_ids.split(",");
  }

  // Get slots (cached)
  let slots;

  if (slotCache[node.item.id]) {
    slots = slotCache[node.item.id];
  } else {
    try {
      const res = await fetch(`${API_BASE}/items/${node.item.id}/slots`);
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      slots = await res.json();
      cacheSet(slotCache, node.item.id, slots);
    } catch (err) {
      console.error("Failed to load slots for factory attachment:", err);
      return;
    }
  }

  for (const slot of slots) {

    let allowed;

    if (allowedCache[slot.id]) {
      allowed = allowedCache[slot.id];
    } else {
      try {
        const allowedRes = await fetch(`${API_BASE}/slots/${slot.id}/allowed-items`);
        if (!allowedRes.ok) throw new Error(`Server error: ${allowedRes.status}`);
        allowed = await allowedRes.json();
        cacheSet(allowedCache, slot.id, allowed);
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

/* ===========================
   BUILD CALCULATION
=========================== */

async function refreshBuildStats() {
  if (!currentGun) return null;

  const attachmentIds = collectAttachmentIds(buildTree);

  const toggle = document.getElementById("full-mag-toggle");
  const ammoSelect = document.getElementById("ammo-select");
  const assumeFull = toggle ? toggle.checked : false;
  const selectedAmmo = ammoSelect ? ammoSelect.value : null;
  const strengthLevel = currentStrengthLevel;

  try {
      const res = await fetch(`${API_BASE}/build/calculate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
              base_item_id: currentGun.id,
              attachment_ids: attachmentIds,
              assume_full_mag: assumeFull,
              selected_ammo_id: selectedAmmo,
              strength_level: strengthLevel
          })
      });

      if (!res.ok) throw new Error(`Server error: ${res.status}`);

      const data = await res.json();
      updateStatsPanel(data);
      return data;

  } catch (err) {
      console.error("Failed to calculate build stats:", err);
      showToast("Connection Error", "Could not reach the server. Is the backend running?", 5000);
      return null;
  }
}

async function updateStatsPanel(data) {

  const statsBox = document.getElementById("stats");

  if (!currentGun) {
    statsBox.innerHTML = `
      <div style="opacity:0.5; padding:40px; text-align:center;">
        Select a weapon to begin
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
        <label>
          <input type="checkbox" id="full-mag-toggle" checked>
          Assume Full Magazine
        </label>
        <select id="ammo-select"></select>
      </div>

      <div id="stats-content"></div>
    `;

    document
      .getElementById("full-mag-toggle")
      .addEventListener("change", refreshBuildStats);

    document
      .getElementById("ammo-select")
      .addEventListener("change", refreshBuildStats);

    await loadAmmoForGun(currentGun);
    await refreshBuildStats();
    return;
  }

  const content = document.getElementById("stats-content");

  const eed = parseFloat(data.evo_ergo_delta ?? 0);
  const totalErgo = parseFloat(data.total_ergo ?? 0);
  const totalWeight = parseFloat(data.total_weight ?? 0);
  lastTotalWeight = totalWeight;
  lastTotalErgo = totalErgo;
  lastRecoilV = data.recoil_vertical ?? null;
  lastRecoilH = data.recoil_horizontal ?? null;
  lastEED = parseFloat(data.evo_ergo_delta ?? 0);

  const eedClass = eed >= 0 ? "positive" : "negative";
  const overswingClass = data.overswing ? "negative" : "positive";

  const armStamina = parseFloat(data.arm_stamina ?? 0);

  content.innerHTML = `
    <div class="stats-section">
      <div class="section-title">CURRENT BUILD</div>

      <div class="stat-bar-row">
        <div class="stat-bar-label">Ergo</div>
        <div class="stat-bar-track">
          <div class="stat-bar-fill ergo-bar" style="width:${Math.min(totalErgo, 100)}%"></div>
          <div class="stat-bar-value">${Math.abs(totalErgo - Math.round(totalErgo)) < 0.001 ? Math.round(totalErgo) : totalErgo.toFixed(1)}</div>
        </div>
      </div>

      <div class="stat-bar-row">
        <div class="stat-bar-label">Ver. Recoil</div>
        <div class="stat-bar-track">
          <div class="stat-bar-fill recoil-bar" style="width:${data.recoil_vertical !== null && data.recoil_vertical !== undefined ? Math.min(Math.round(data.recoil_vertical), 500) / 5 : 0}%"></div>
          <div class="stat-bar-value">${data.recoil_vertical !== null && data.recoil_vertical !== undefined ? Math.round(data.recoil_vertical) : "—"}</div>
        </div>
      </div>

      <div class="stat-bar-row">
        <div class="stat-bar-label">Hor. Recoil</div>
        <div class="stat-bar-track">
          <div class="stat-bar-fill recoil-bar" style="width:${data.recoil_horizontal !== null && data.recoil_horizontal !== undefined ? Math.min(Math.round(data.recoil_horizontal), 500) / 5 : 0}%"></div>
          <div class="stat-bar-value">${data.recoil_horizontal !== null && data.recoil_horizontal !== undefined ? Math.round(data.recoil_horizontal) : "—"}</div>
        </div>
      </div>

      <div class="stats-divider"></div>

      <div class="stat-row stat-row-weight"><span class="stat-label">Weight:</span><span>${totalWeight.toFixed(3)} kg</span></div>
      <div class="stat-row stat-row-eed">
        <span class="stat-label">EvoErgoDelta:</span>
        <span class="${eedClass}">${eed > 0 ? "+" : ""}${eed.toFixed(1)}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">OverSwing:</span>
        <span class="${overswingClass}">${data.overswing ? "YES" : "NO"}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Arm Stamina<span class="stamina-info-btn" id="stamina-info-btn" title="Configure strength level">i</span>:</span>
        <span>${armStamina.toFixed(1)}s</span>
      </div>
    </div>
  `;

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
              <span class="beta-badge">BETA</span>
                <div class="stamina-disclaimer">Seconds until arm stamina depletes while standing.<br>Expected deviation ±0.5s</div>
              <div class="strength-control">
                  <label>Strength Level</label>
                  <div class="strength-input-row">
                      <input type="range" id="strength-slider" min="0" max="51" step="1" value="${currentStrengthLevel}" />
                      <input type="number" id="strength-input" min="0" max="51" value="${currentStrengthLevel}" />
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
}

function wireStrengthControls() {
    const slider = document.getElementById("strength-slider");
    const numInput = document.getElementById("strength-input");
    if (!slider || !numInput) return;

    // Use "input" only to update the label and number box live while dragging
    // Do NOT call refreshBuildStats here — it rebuilds the DOM and kills the drag
    slider.addEventListener("input", () => {
        currentStrengthLevel = parseInt(slider.value);
        numInput.value = currentStrengthLevel;

        // Recalculate arm stamina inline without triggering a DOM rebuild
        const armStamina = calcArmStamina(lastTotalWeight, lastTotalErgo, currentStrengthLevel);

        const staminaSpan = document.querySelector("#stamina-info-btn")?.closest(".stat-row")?.lastElementChild;
        if (staminaSpan) staminaSpan.textContent = armStamina.toFixed(1) + "s";
    });

    slider.addEventListener("change", () => {
        // Update the display directly instead of triggering a full rebuild
        const armStamina = calcArmStamina(lastTotalWeight, lastTotalErgo, currentStrengthLevel);

        const staminaSpan = document.querySelector("#stamina-info-btn")?.closest(".stat-row")?.lastElementChild;
        if (staminaSpan) staminaSpan.textContent = armStamina.toFixed(1) + "s";
    });

    numInput.addEventListener("change", () => {
        let val = parseInt(numInput.value);
        if (isNaN(val)) val = 10;
        val = Math.max(0, Math.min(51, val));
        currentStrengthLevel = val;
        numInput.value = val;
        slider.value = val;
        refreshBuildStats();
    });

    numInput.addEventListener("input", () => {
        numInput.value = numInput.value.replace(/[^0-9]/g, "");
        let val = parseInt(numInput.value);
        if (isNaN(val)) return;
        val = Math.max(0, Math.min(51, val));
        currentStrengthLevel = val;
        numInput.value = val;
        slider.value = val;

        const armStamina = calcArmStamina(lastTotalWeight, lastTotalErgo, currentStrengthLevel);

        const staminaSpan = document.querySelector("#stamina-info-btn")?.closest(".stat-row")?.lastElementChild;
        if (staminaSpan) staminaSpan.textContent = armStamina.toFixed(1) + "s";
    });
}

/* ===========================
   TREE RENDERING
=========================== */

async function renderFullTree(preserveScroll = true) {

    const container = document.getElementById("slots");
    if (!container) return;

    const previousScroll = preserveScroll ? container.scrollTop : 0;

    const placeholder = document.getElementById("attachment-placeholder");

    if (!lastSlot) {
        placeholder.style.display = "flex";
        document.getElementById("attachment-table-container").innerHTML = "";
    }

    container.innerHTML = `
        <div class="stats-section">
            <div class="section-title">ATTACHMENT TREE</div>
            <div id="tree-content"></div>
        </div>
    `;

    const treeBox = document.getElementById("tree-content");
    if (!treeBox) return;

    await renderNode(buildTree, 0, treeBox);

    // Re-apply active slot highlight immediately after tree is built
    if (lastParentNode && lastSlot) {
        const activeSlotEl = findSlotElement(lastParentNode, lastSlot.id);
        if (activeSlotEl) activeSlotEl.classList.add("active-slot");
    }

    if (preserveScroll) {
        container.scrollTop = previousScroll;
    }
}

async function renderNode(node, depth, parentElement) {

    let slots;

    if (slotCache[node.item.id]) {
        slots = slotCache[node.item.id];
    } else {
        try {
            const res = await fetch(`${API_BASE}/items/${node.item.id}/slots`);
            if (!res.ok) throw new Error(`Server error: ${res.status}`);
            slots = await res.json();
            cacheSet(slotCache, node.item.id, slots);
        } catch (err) {
            console.error("Failed to load slots for tree node:", err);
            return;
        }
    }

    for (const slot of slots) {

        const installed = node.children[slot.id];

        let hasChildSlots = false;

        if (installed) {

            let childSlots;

            if (slotCache[installed.item.id]) {
                childSlots = slotCache[installed.item.id];
            } else {
                try {
                    const res = await fetch(`${API_BASE}/items/${installed.item.id}/slots`);
                    if (!res.ok) throw new Error(`Server error: ${res.status}`);
                    childSlots = await res.json();
                    cacheSet(slotCache, installed.item.id, childSlots);
                } catch (err) {
                    console.error("Failed to load child slots for tree node:", err);
                    childSlots = [];
                }
            }

            hasChildSlots = childSlots.length > 0;
        }

        const isCollapsed = collapsedSlots[slot.id] === true;

        const wrapper = document.createElement("div");
        wrapper.className = "tree-slot";
        wrapper.dataset.slotId = slot.id;
        wrapper.dataset.parentItemId = node.item.id;
        wrapper.dataset.depth = depth;
        wrapper.classList.add(`depth-${depth}`);
        wrapper.dataset.slotName = slot.slot_name;

        const arrow = (installed && hasChildSlots)
            ? (collapsedSlots[slot.id] ? "▶" : "▼")
            : "";

        wrapper.innerHTML = `
            <div class="tree-slot-inner">
                <div class="tree-slot-name ${hasChildSlots ? "collapsible" : ""}">
                    ${arrow} ${escapeHtml(slot.slot_name)}
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
                        : `<div class="empty-slot">+</div>`
                    }
                </div>
            </div>
        `;

        const nameEl = wrapper.querySelector(".tree-slot-name");

        // NAME CLICK → collapse only if slot has children
        nameEl.onclick = (e) => {

            e.stopPropagation();

            if (installed && hasChildSlots) {

                const isCollapsing = !collapsedSlots[slot.id];
                collapsedSlots[slot.id] = isCollapsing;

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
            openSlotSelector(node, slot);
        };

        // RIGHT CLICK → remove attachment
        wrapper.oncontextmenu = (e) => {

            e.preventDefault();

            const currentInstalled = node.children[slot.id];
            if (!currentInstalled) return;

            removeAttachment(node, slot.id);
        };

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

function findNodeInTree(treeNode, targetParentNode, targetSlotId) {

    // Walk the build tree to find the installed node that sits at
    // targetParentNode[targetSlotId], and return it
    if (treeNode === targetParentNode) {
        return treeNode.children[targetSlotId] || null;
    }

    for (const slotId in treeNode.children) {
        const result = findNodeInTree(treeNode.children[slotId], targetParentNode, targetSlotId);
        if (result) return result;
    }

    return null;
}

function findSlotElement(parentNode, slotId) {

    // The DOM wrapper for a slot is stored on its parent node under _slotEls,
    // keyed by slot ID — unique per tree position regardless of item ID
    return parentNode._slotEls?.[slotId] || null;
}

function updateSlotIcon(parentNode, slotId, item) {

    const slotElement = findSlotElement(parentNode, slotId);
    if (!slotElement) return;

    const iconBox = slotElement.querySelector(".tree-slot-item");

    iconBox.innerHTML = `
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
    walk(buildTree);
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

/* ===========================
   TABLE SLOT SELECTOR
=========================== */

async function openSlotSelector(parentNode, slot) {

    // If this slot is already open, do nothing
    if (lastParentNode === parentNode && lastSlot && lastSlot.id === slot.id) {
        return;
    }

    // Immediately highlight the selected slot
    document.querySelectorAll(".tree-slot.active-slot")
        .forEach(el => el.classList.remove("active-slot"));

    const activeSlotEl = findSlotElement(parentNode, slot.id);
    if (activeSlotEl) activeSlotEl.classList.add("active-slot");

    // Hide placeholder
    document.getElementById("attachment-placeholder").style.display = "none";

    currentSearchQuery = "";

  const box = document.getElementById("attachment-table-container");

  box.innerHTML = `
        <h3>Select Attachment for ${escapeHtml(slot.slot_name)}</h3>

        <input
            type="text"
            id="attachment-search"
            placeholder="Start typing to search..."
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
                        Name <span class="sort-indicator"></span>
                    </th>
                    <th id="th-weight" onclick="changeSort('weight')">
                        Weight (kg) <span class="sort-indicator"></span>
                    </th>
                    <th id="th-recoil" onclick="changeSort('recoil')">
                        Recoil <span class="sort-indicator"></span>
                    </th>
                    <th id="th-ergo" onclick="changeSort('ergo')">
                        Ergo <span class="sort-indicator"></span>
                    </th>
                    <th id="th-evo" onclick="changeSort('evo')">
                        EvoErgo <span class="sort-indicator"></span>
                    </th>
                </tr>
            </thead>

            <tbody id="attachment-body"></tbody>
        </table>
    `;

  let items;
  if (allowedCache[slot.id]) {
      items = allowedCache[slot.id];
  } else {
      try {
          const res = await fetch(`${API_BASE}/slots/${slot.id}/allowed-items`);
          if (!res.ok) throw new Error(`Server error: ${res.status}`);
          items = await res.json();
          cacheSet(allowedCache, slot.id, items);
      } catch (err) {
          console.error("Failed to load allowed items:", err);
          showToast("Connection Error", "Could not load attachment list. Is the backend running?", 5000);
          return;
      }
  }

  const baseAttachmentIds = collectAttachmentIds(buildTree);

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

  if (processedCache[cacheKey]) {
      lastProcessedItems = processedCache[cacheKey];
      lastParentNode = parentNode;
      lastSlot = slot;
      applyAttachmentSort();
      return;
  }

  // EED of the build with this slot empty — the baseline every candidate is measured against
  let baseData;
  try {
      const baseRes = await fetch(`${API_BASE}/build/calculate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
              base_item_id: currentGun.id,
              attachment_ids: slotEmptiedIds
          })
      });
      if (!baseRes.ok) throw new Error(`Server error: ${baseRes.status}`);
      baseData = await baseRes.json();
  } catch (err) {
      console.error("Failed to calculate base stats:", err);
      showToast("Connection Error", "Could not reach the server. Is the backend running?", 5000);
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

      const [validationRes, simRes] = await Promise.all([
          fetch(`${API_BASE}/build/validate`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                  base_item_id: currentGun.id,
                  installed_ids: slotEmptiedIds,
                  slot_id: slot.id,
                  candidate_id: item.id
              })
          }),
          fetch(`${API_BASE}/build/calculate`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                  base_item_id: currentGun.id,
                  attachment_ids: [...slotEmptiedIds, item.id]
              })
          })
      ]);

      if (!validationRes.ok || !simRes.ok) throw new Error("Server error during attachment processing");

      const validationData = await validationRes.json();
      const simData = await simRes.json();

      const hasConflict = !validationData.valid;
      const conflictName = validationData.reason ?? null;
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
      console.error("Failed to process attachments:", err);
      showToast("Connection Error", "Could not load attachment data. Is the backend running?", 5000);
      return;
  }

  cacheSet(processedCache, cacheKey, processedItems);
  lastProcessedItems = processedItems;

  const searchInput = document.getElementById("attachment-search");
  if (searchInput) {
      searchInput.addEventListener("input", (e) => {
          applyAttachmentSearch(e.target.value);
      });
  }

  lastParentNode = parentNode;
  lastSlot = slot;

  applyAttachmentSort();
}

/* ===========================
   ATTACHMENT TABLE SEARCH
=========================== */

let currentSearchQuery = "";

function applyAttachmentSearch(query) {
    currentSearchQuery = query.toLowerCase();
    applyAttachmentSort();
}

function applyAttachmentSort() {
  const dir = attachmentSort.direction === "asc" ? 1 : -1;

  const itemsToRender = currentSearchQuery
      ? lastProcessedItems.filter(entry =>
          entry.item.name.toLowerCase().includes(currentSearchQuery)
        )
      : lastProcessedItems;

  itemsToRender.sort((a, b) => {

    // ---------- PRIMARY SORT ----------
    let primary;

    switch (attachmentSort.key) {
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
    if (attachmentSort.key === "recoil") {
      const evoDiff = b.contribution - a.contribution;
      if (evoDiff !== 0) return evoDiff;
    }

    // ---------- TERTIARY SORT ----------
    return a.item.name.localeCompare(b.item.name);
  });

  updateSortIndicators();
  renderAttachmentRows(itemsToRender);
}

/* ===========================
   TABLE SORTING
=========================== */

function changeSort(key) {
  if (attachmentSort.key === key) {
    attachmentSort.direction =
      attachmentSort.direction === "asc"
        ? "desc"
        : "asc";
  } else {
    attachmentSort.key = key;

    // Default directions per column
    if (key === "recoil") {
      attachmentSort.direction = "asc"; // strongest reduction first
    } else if (key === "evo") {
      attachmentSort.direction = "desc"; // highest evo first
    } else {
      attachmentSort.direction = "asc";
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
    `th-${attachmentSort.key}`
  );

  if (!activeTh) return;

  activeTh.classList.add("active-sort");

  const span = activeTh.querySelector(".sort-indicator");

  span.textContent =
    attachmentSort.direction === "asc" ? " ▲" : " ▼";
}

function renderAttachmentRows(items) {

  const tbody = document.getElementById("attachment-body");
  tbody.innerHTML = "";

  for (const entry of items) {

    const { item, contribution, recoilPercent, ergoModifier } = entry;

    const installedId =
        lastParentNode?.children?.[lastSlot.id]?.item?.id;

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

                <span>${escapeHtml(item.name)}</span>

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

        const installedId = lastParentNode?.children?.[lastSlot?.id]?.item?.id;
        const installedEntry = installedId
            ? lastProcessedItems.find(e => e.item.id === installedId)
            : null;

        const installedSimErgo = lastTotalErgo;
        const installedSimRecoilV = lastRecoilV;
        const installedSimRecoilH = lastRecoilH;

        // Ergo
        const ergoFill = statBarRows[0].querySelector(".stat-bar-fill");
        const ergoVal = statBarRows[0].querySelector(".stat-bar-track .stat-bar-value");
        const ergoDelta = entry.simErgo - installedSimErgo;
        const ergoBaseWidth = Math.min(lastTotalErgo, 100);
        const ergoSimWidth = Math.min(lastTotalErgo + ergoDelta, 100);

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
                deltaEl.style.borderRadius = ergoDelta >= 0 ? "0 3px 3px 0" : "3px 0 0 3px";
                deltaEl.style.display = "";
            } else {
                deltaEl.style.display = "none";
            }
        }
        if (ergoVal) {
            const deltaText = ergoDelta !== 0
                ? ` <span style="color:${ergoDelta >= 0 ? "#4CAF50" : "#f44336"}">(${ergoDelta > 0 ? "+" : ""}${Math.abs(ergoDelta - Math.round(ergoDelta)) < 0.001 ? Math.round(ergoDelta) : ergoDelta.toFixed(1)})</span>`
                : "";
            ergoVal.innerHTML = `<span style="color:#eee">${Math.abs(lastTotalErgo - Math.round(lastTotalErgo)) < 0.001 ? Math.round(lastTotalErgo) : lastTotalErgo.toFixed(1)}</span>${deltaText}`;
        }

        // Ver. Recoil
        const rvFill = statBarRows[1].querySelector(".stat-bar-fill");
        const recoilVVal = statBarRows[1].querySelector(".stat-bar-track .stat-bar-value");
        if (entry.simRecoilV !== null && installedSimRecoilV !== null && rvFill) {
            const rvBase = Math.min(lastRecoilV, 500) / 5;
            const rvDelta = entry.simRecoilV - installedSimRecoilV;
            const rvSim = Math.min(Math.max(lastRecoilV + rvDelta, 0), 500) / 5;
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
                deltaEl.style.borderRadius = rvDelta > 0 ? "0 3px 3px 0" : "3px 0 0 3px";
                deltaEl.style.display = "";
            } else {
                deltaEl.style.display = "none";
            }
            if (recoilVVal) {
                const deltaText = rvDelta !== 0
                    ? ` <span style="color:${rvDelta <= 0 ? "#4CAF50" : "#f44336"}">(${rvDelta > 0 ? "+" : ""}${Math.round(rvDelta)})</span>`
                    : "";
                recoilVVal.innerHTML = `<span style="color:#eee">${Math.round(lastRecoilV)}</span>${deltaText}`;
            }
        }

        // Hor. Recoil
        const rhFill = statBarRows[2].querySelector(".stat-bar-fill");
        const recoilHVal = statBarRows[2].querySelector(".stat-bar-track .stat-bar-value");
        if (entry.simRecoilH !== null && installedSimRecoilH !== null && rhFill) {
            const rhBase = Math.min(lastRecoilH, 500) / 5;
            const rhDelta = entry.simRecoilH - installedSimRecoilH;
            const rhSim = Math.min(Math.max(lastRecoilH + rhDelta, 0), 500) / 5;
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
                deltaEl.style.borderRadius = rhDelta > 0 ? "0 3px 3px 0" : "3px 0 0 3px";
                deltaEl.style.display = "";
            } else {
                deltaEl.style.display = "none";
            }
            if (recoilHVal) {
                const deltaText = rhDelta !== 0
                    ? ` <span style="color:${rhDelta <= 0 ? "#4CAF50" : "#f44336"}">(${rhDelta > 0 ? "+" : ""}${Math.round(rhDelta)})</span>`
                    : "";
                recoilHVal.innerHTML = `<span style="color:#eee">${Math.round(lastRecoilH)}</span>${deltaText}`;
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
                <div class="stat-bar-fill ergo-bar" style="width:${Math.min(lastTotalErgo, 100)}%;"></div>
                <div class="stat-bar-value">${Math.abs(lastTotalErgo - Math.round(lastTotalErgo)) < 0.001 ? Math.round(lastTotalErgo) : lastTotalErgo.toFixed(1)}</div>
            `;
        }

        // Ver. Recoil
        const recoilVTrack = statBarRows[1].querySelector(".stat-bar-track");
        if (recoilVTrack) {
            recoilVTrack.innerHTML = `
                <div class="stat-bar-fill recoil-bar" style="width:${lastRecoilV !== null ? Math.min(lastRecoilV, 500) / 5 : 0}%;"></div>
                <div class="stat-bar-value">${lastRecoilV !== null ? Math.round(lastRecoilV) : "—"}</div>
            `;
        }

        // Hor. Recoil
        const recoilHTrack = statBarRows[2].querySelector(".stat-bar-track");
        if (recoilHTrack) {
            recoilHTrack.innerHTML = `
                <div class="stat-bar-fill recoil-bar" style="width:${lastRecoilH !== null ? Math.min(lastRecoilH, 500) / 5 : 0}%;"></div>
                <div class="stat-bar-value">${lastRecoilH !== null ? Math.round(lastRecoilH) : "—"}</div>
            `;
        }
    });

    row.addEventListener("click", () => {

        if (entry.hasConflict) {
            showToast(
                "Attachment Conflict",
                `${item.name}\n${entry.conflictName}`
            );

            if (entry.conflictingItemId) {
                flashConflictInTree(buildTree, entry.conflictingItemId);
            }
            if (entry.conflictingSlotId) {
                flashConflictSlotInTree(entry.conflictingSlotId);
            }

            return;
        }

        const alreadyInstalled = lastParentNode?.children?.[lastSlot.id]?.item?.id === item.id;
        if (alreadyInstalled) return;

        installAttachment(lastParentNode, lastSlot.id, item);
    });

    row.addEventListener("contextmenu", (e) => {
        e.preventDefault();

        const installedId = lastParentNode?.children?.[lastSlot.id]?.item?.id;
        if (installedId && String(installedId) === String(item.id)) {
            removeAttachment(lastParentNode, lastSlot.id, true);
        }
    });

    tbody.appendChild(row);
  }
}

/* ===========================
   TREE MANAGEMENT
=========================== */

async function installAttachment(parentNode, slotId, item) {

    parentNode.children[slotId] = { item, children: {} };

    processedCache = {};
    refreshBuildStats();
    applyAttachmentSort();

    let childSlots;
    if (slotCache[item.id]) {
        childSlots = slotCache[item.id];
    } else {
        try {
            const res = await fetch(`${API_BASE}/items/${item.id}/slots`);
            if (!res.ok) throw new Error(`Server error: ${res.status}`);
            childSlots = await res.json();
            cacheSet(slotCache, item.id, childSlots);
        } catch (err) {
            console.error("Failed to load child slots after install:", err);
            childSlots = [];
        }
    }

    await renderFullTree(true);
    flashSlot(parentNode, slotId, "install");

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
    delete collapsedSlots[slotId];
    removedNodes.forEach(node => {
        for (const childSlotId in node.children) {
            delete collapsedSlots[childSlotId];
        }
    });

    delete parentNode.children[slotId];
    processedCache = {};

    const directSlotRemoved =
        lastParentNode === parentNode &&
        lastSlot &&
        lastSlot.id === slotId;

    const subtreeRemoved =
        lastParentNode && removedNodes.has(lastParentNode);

    if ((directSlotRemoved || subtreeRemoved) && !keepTableOpen) {
        lastParentNode = null;
        lastSlot = null;

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

    // Immediately patch the slot icon to empty
    const slotElement = findSlotElement(parentNode, slotId);
    if (slotElement) {
        const iconBox = slotElement.querySelector(".tree-slot-item");
        if (iconBox) {
            iconBox.innerHTML = `<div class="empty-slot">+</div>`;
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

    flashSlot(parentNode, slotId, "remove");
    refreshBuildStats();

    const isActiveSlot = directSlotRemoved || subtreeRemoved;

    setTimeout(async () => {
        await renderFullTree(true);
    }, 300);
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