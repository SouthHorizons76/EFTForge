const API_BASE = "http://127.0.0.1:8000";

let allGuns = [];
let currentGun = null;
let buildTree = null;
let slotCache = {};
let allowedCache = {};
let processedCache = {};
let showHandguns = false;
let collapsedSlots = {};
let currentStrengthLevel = 10;
let lastTotalWeight = 0;
let lastTotalErgo = 0;

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
   INITIAL LOAD
=========================== */

init();

async function init() {
  try {
    const res = await fetch(`${API_BASE}/guns`);
    allGuns = await res.json();
    renderGunList(allGuns);
  } catch (err) {
    console.error("Failed to load guns:", err);
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

    // ESC clears current search
    if (e.key === "Escape") {
        clearSearch();
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

  primaryBtn.classList.toggle("active", !showHandguns);
  handgunBtn.classList.toggle("active", showHandguns);
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
    document.getElementById("guns").style.removeProperty("display");
    document.getElementById("gun-search").style.removeProperty("display");
    document.querySelector(".weapon-toggle").style.removeProperty("display");

    document.getElementById("left-build-area").style.display = "none";

    document.getElementById("attachment-table-container").innerHTML = "";
    document.getElementById("attachment-placeholder").style.display = "flex";

    document.getElementById("current-gun-label").textContent = "No Gun Selected";
    document.getElementById("header-gun-image").style.display = "none";

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

    //  REMOVE SIGNAL CARTRIDGES (26x75)
    if (rawCaliber === "Caliber26x75") {
        return;
    }

    //  REMOVE ROCKET LAUNCHERS
    if (
        nameLower.includes("rocket") ||
        nameLower.includes("rshg")
    ) {
        return;
    }

    //  KEEP EVERYTHING ELSE

    let cal = CALIBER_DISPLAY_MAP[g.caliber];

    if (!cal) {
        console.warn("Unmapped caliber detected:", g.caliber);
        cal = "Other";
    }

    if (!grouped[cal]) grouped[cal] = [];
    grouped[cal].push(g);
    });

  const caliberOrder = [
    // Toy gun always manually forced above this
    "5.45x39",
    "5.56x45",
    "6.8x51",

    "7.62x39",
    "7.62x51",
    "7.62x54R",
    "7.62x25 TT",

    ".300 BLK",
    ".308",
    ".338 LM",
    ".366 TKM",
    "9.3x64",

    "9x18",
    "9x19",
    "9x21",
    "9x39",
    "5.7x28",
    "4.6x30",
    ".357 Magnum",

    ".45 ACP",
    ".50 AE",

    ".30 Carbine",

    "12/70",
    "20/70",
    "23x75",

    "12.7x55",
    "40x46 Grenade",

    ".50 BMG"
    ];

    Object.keys(grouped)
        .sort((a, b) => {

            if (a === "20x1mm disk") return -1;
            if (b === "20x1mm disk") return 1;

            if (a === "Other") return 1;
            if (b === "Other") return -1;

            const aIndex = caliberOrder.indexOf(a);
            const bIndex = caliberOrder.indexOf(b);

            if (aIndex === -1) return 1;
            if (bIndex === -1) return -1;

            return aIndex - bIndex;
        })

        .forEach(caliber => {

            const header = document.createElement("div");
            header.style.gridColumn = "1 / -1";
            header.className = "caliber-header";

            header.textContent = caliber === "Other"
                ? "Other"
                : caliber;

            list.appendChild(header);

            grouped[caliber]
                .sort((a,b) => (b.base_ergo ?? 0) - (a.base_ergo ?? 0))
                .forEach(gun => {
                    const card = document.createElement("div");
                    card.className = "gun-card";

                    card.innerHTML = `
                        <img src="${gun.image_512_link || gun.icon_link}" />
                        <div class="gun-name">${gun.name}</div>
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
        document.getElementById("guns").style.display = "none";
        document.getElementById("gun-search").style.display = "none";
        document.querySelector(".weapon-toggle").style.display = "none";

        document.getElementById("left-build-area").style.display = "block";

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

  document.getElementById("current-gun-label").textContent = gun.name;

    const headerImage = document.getElementById("header-gun-image");

    const imageSrc = gun.image_512_link || gun.icon_link;

    if (imageSrc) {
    headerImage.src = imageSrc;
    headerImage.style.display = "block";
    } else {
    headerImage.style.display = "none";
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

    await loadAmmoForGun(currentGun);

    const statsData = await refreshBuildStats();

    updateStatsPanel(statsData);
    await renderFullTree();
}

async function loadAmmoForGun(gun) {

  const ammoSelect = document.getElementById("ammo-select");
  if (!ammoSelect) return;

  // Save currently selected ammo before clearing
  const previouslySelected = ammoSelect.value;

  ammoSelect.innerHTML = "";

  if (!gun.caliber) return;

  const res = await fetch(`${API_BASE}/ammo/${gun.caliber}`);
  const ammoList = await res.json();

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
    const res = await fetch(`${API_BASE}/items/${node.item.id}/slots`);
    slots = await res.json();
    slotCache[node.item.id] = slots;
  }

  for (const slot of slots) {

    let allowed;

    if (allowedCache[slot.id]) {
      allowed = allowedCache[slot.id];
    } else {
      const allowedRes = await fetch(`${API_BASE}/slots/${slot.id}/allowed-items`);
      allowed = await allowedRes.json();
      allowedCache[slot.id] = allowed;
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

    // Load ammo BEFORE first refresh
    await loadAmmoForGun(currentGun);

    // Now run first calculation
    await refreshBuildStats();

    return;
  }

  const content = document.getElementById("stats-content");

  const eed = parseFloat(data.evo_ergo_delta ?? 0);
  const totalErgo = parseFloat(data.total_ergo ?? 0);
  const totalWeight = parseFloat(data.total_weight ?? 0);
  lastTotalWeight = totalWeight;
  lastTotalErgo = totalErgo;

  const eedClass = eed >= 0 ? "positive" : "negative";
  const overswingClass = data.overswing ? "negative" : "positive";

  const armStamina = parseFloat(data.arm_stamina ?? 0);

  const currentStrength = currentStrengthLevel;
  const panelOpen = document.getElementById("stamina-panel") !== null;

  content.innerHTML = `
    <div class="stats-section">
      <div class="section-title">CURRENT BUILD</div>

      <div class="stat-bar-row">
        <div class="stat-bar-label">Ergo</div>
        <div class="stat-bar-track">
          <div class="stat-bar-fill ergo-bar" style="width:${Math.min(totalErgo, 100)}%"></div>
        </div>
        <div class="stat-bar-value">${totalErgo.toFixed(1)}</div>
      </div>

      <div class="stat-bar-row">
        <div class="stat-bar-label">Ver. Recoil</div>
        <div class="stat-bar-track">
          <div class="stat-bar-fill recoil-bar" style="width:${data.recoil_vertical !== null && data.recoil_vertical !== undefined ? Math.min(Math.round(data.recoil_vertical), 1000) / 10 : 0}%"></div>
        </div>
        <div class="stat-bar-value">${data.recoil_vertical !== null && data.recoil_vertical !== undefined ? Math.round(data.recoil_vertical) : "—"}</div>
      </div>

      <div class="stat-bar-row">
        <div class="stat-bar-label">Hor. Recoil</div>
        <div class="stat-bar-track">
          <div class="stat-bar-fill recoil-bar" style="width:${data.recoil_horizontal !== null && data.recoil_horizontal !== undefined ? Math.min(Math.round(data.recoil_horizontal), 1000) / 10 : 0}%"></div>
        </div>
        <div class="stat-bar-value">${data.recoil_horizontal !== null && data.recoil_horizontal !== undefined ? Math.round(data.recoil_horizontal) : "—"}</div>
      </div>

      <div class="stats-divider"></div>

      <div>Weight: <span>${totalWeight.toFixed(3)} kg</span></div>
      <div>
        EvoErgoDelta:
        <span class="${eedClass}">
          ${eed > 0 ? "+" : ""}${eed.toFixed(1)}
        </span>
      </div>
      <div>
        OverSwing:
        <span class="${overswingClass}">
          ${data.overswing ? "YES" : "NO"}
        </span>
      </div>
      <div style="display:flex; align-items:center;">
        Arm Stamina:
        <span style="margin-left:4px;">${armStamina.toFixed(1)}s</span>
        <span class="stamina-info-btn" id="stamina-info-btn" title="Configure strength level">i</span>
      </div>
    </div>
  `;

  // Toggle panel on i button click
  document.getElementById("stamina-info-btn").addEventListener("click", () => {
      const existing = document.getElementById("stamina-panel");
      if (existing) {
          existing.remove();
      } else {
          const panel = document.createElement("div");
          panel.className = "stamina-panel";
          panel.id = "stamina-panel";
          panel.innerHTML = `
              <span class="beta-badge">BETA</span>
                <div class="stamina-disclaimer">Seconds until arm stamina depletes while standing. Expected deviation ±0.5s</div>
              <div class="strength-control">
                  <label>Strength Level</label>
                  <div class="strength-input-row">
                      <input type="range" id="strength-slider" min="0" max="51" step="1" value="${currentStrengthLevel}" />
                      <input type="number" id="strength-input" min="0" max="51" value="${currentStrengthLevel}" />
                  </div>
              </div>
          `;
          document.getElementById("stamina-info-btn").closest("div").after(panel);
          wireStrengthControls();
      }
  });

  // If panel was already open, move it back in under the stamina row
  // without rebuilding the slider — just re-attach it from the old DOM
  if (panelOpen) {
      const existingPanel = document.getElementById("stamina-panel");
      if (!existingPanel) {
          const panel = document.createElement("div");
          panel.className = "stamina-panel";
          panel.id = "stamina-panel";
          panel.innerHTML = `
              <span class="beta-badge">BETA</span>
                <div class="stamina-disclaimer">Seconds until arm stamina depletes while standing. Expected deviation ±0.5s</div>
              <div class="strength-control">
                  <label>Strength Level</label>
                  <div class="strength-input-row">
                      <input type="range" id="strength-slider" min="0" max="51" step="1" value="${currentStrengthLevel}" />
                      <input type="number" id="strength-input" min="0" max="51" value="${currentStrengthLevel}" />
                  </div>
              </div>
          `;
          document.getElementById("stamina-info-btn").closest("div").after(panel);
          wireStrengthControls();
      }
  }
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
        const armStamina = (
            (85.5 / (lastTotalWeight + 0.65))
            + 9.15
            + 0.06477 * lastTotalErgo
        ) / 1.04 * (1 + currentStrengthLevel * 0.004);

        const staminaSpan = document.querySelector("#stamina-info-btn")?.previousElementSibling;
        if (staminaSpan) staminaSpan.textContent = armStamina.toFixed(1) + "s";
    });

    slider.addEventListener("change", () => {
        refreshBuildStats();
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

    if (preserveScroll) {
        container.scrollTop = previousScroll;
    }
}

async function renderNode(node, depth, parentElement) {

    let slots;

    if (slotCache[node.item.id]) {
        slots = slotCache[node.item.id];
    } else {
        const res = await fetch(`${API_BASE}/items/${node.item.id}/slots`);
        slots = await res.json();
        slotCache[node.item.id] = slots;
    }

    for (const slot of slots) {

        const installed = node.children[slot.id];

        let hasChildSlots = false;

        if (installed) {

            let childSlots;

            if (slotCache[installed.item.id]) {
                childSlots = slotCache[installed.item.id];
            } else {
                const res = await fetch(`${API_BASE}/items/${installed.item.id}/slots`);
                childSlots = await res.json();
                slotCache[installed.item.id] = childSlots;
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
                    ${arrow} ${slot.slot_name}
                </div>
                <div class="tree-slot-item">
                    ${
                        installed
                        ? `
                        <div class="tree-slot-icon">
                            <img src="${installed.item.icon_link}" />
                            <div class="slot-shortname">
                                ${installed.item.short_name || ""}
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
            <img src="${item.icon_link}" />
            <div class="slot-shortname">
                ${item.short_name || ""}
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

/* ===========================
   TABLE SLOT SELECTOR
=========================== */

async function openSlotSelector(parentNode, slot) {

    // If this slot is already open, do nothing
    if (lastParentNode === parentNode && lastSlot && lastSlot.id === slot.id) {
        return;
    }

    // Hide placeholder
    document.getElementById("attachment-placeholder").style.display = "none";

    currentSearchQuery = "";

  const box = document.getElementById("attachment-table-container");

  box.innerHTML = `
        <h3>Select Attachment for ${slot.slot_name}</h3>

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
      const res = await fetch(`${API_BASE}/slots/${slot.id}/allowed-items`);
      items = await res.json();
      allowedCache[slot.id] = items;
  }

  const baseAttachmentIds = collectAttachmentIds(buildTree);

  // Build the slot-emptied ID list once — same baseline for every candidate
  const slotEmptiedIds = [...baseAttachmentIds];
  if (parentNode.children[slot.id]) {
      const existingId = parentNode.children[slot.id].item.id;
      const index = slotEmptiedIds.indexOf(existingId);
      if (index > -1) slotEmptiedIds.splice(index, 1);
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
  const baseRes = await fetch(`${API_BASE}/build/calculate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_item_id: currentGun.id,
      attachment_ids: slotEmptiedIds
    })
  });

  const baseData = await baseRes.json();
  const baseEED = parseFloat(baseData.evo_ergo_delta ?? 0);

  // Fire all validation and EED requests in parallel instead of sequentially
  const processedItems = await Promise.all(items.map(async (item) => {

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
          conflictName
      };
  }));

  processedCache[cacheKey] = processedItems;
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
                        src="${item.icon_link || ''}" 
                        class="attachment-icon"
                        loading="lazy"
                        decoding="async"
                        onerror="this.style.display='none'"
                    />

                    <div class="slot-shortname">
                        ${item.short_name || ""}
                    </div>
                </div>

                <span>${item.name}</span>

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

    row.addEventListener("click", () => {

        if (entry.hasConflict) {
            showToast(
                "Attachment Conflict",
                `${item.name}\n${entry.conflictName}`
            );
            return;
        }

        installAttachment(lastParentNode, lastSlot.id, item);
    });
    tbody.appendChild(row);
  }
}

/* ===========================
   TREE MANAGEMENT
=========================== */

async function installAttachment(parentNode, slotId, item) {

    parentNode.children[slotId] = { item, children: {} };

    refreshBuildStats();
    applyAttachmentSort();

    let childSlots;
    if (slotCache[item.id]) {
        childSlots = slotCache[item.id];
    } else {
        const res = await fetch(`${API_BASE}/items/${item.id}/slots`);
        childSlots = await res.json();
        slotCache[item.id] = childSlots;
    }

    if (childSlots.length > 0) {
        await renderFullTree(true);

        // Flash parent slot green
        flashSlot(parentNode, slotId, "install");

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
    } else {
        updateSlotIcon(parentNode, slotId, item);
    }
}

function removeAttachment(parentNode, slotId) {

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

    const directSlotRemoved =
        lastParentNode === parentNode &&
        lastSlot &&
        lastSlot.id === slotId;

    const subtreeRemoved =
        lastParentNode && removedNodes.has(lastParentNode);

    if (directSlotRemoved || subtreeRemoved) {
        lastParentNode = null;
        lastSlot = null;

        document.getElementById("attachment-table-container").innerHTML = "";

        const placeholder = document.getElementById("attachment-placeholder");
        if (placeholder) {
            placeholder.style.display = "flex";
        }
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
    setTimeout(() => renderFullTree(true), 300);
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