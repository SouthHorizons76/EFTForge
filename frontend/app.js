const API_BASE = "http://127.0.0.1:8000";

let allGuns = [];
let currentGun = null;
let buildTree = null;
let slotCache = {};
let allowedCache = {};
let currentBuildData = null;
let showHandguns = false;

// === CALIBER NAMING ===

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

    const container = document.getElementById("main-container");
    container.classList.add("no-gun");

    // Show weapon selector
    document.getElementById("weapon-selector").style.display = "block";
    document.getElementById("guns").style.display = "grid";
    document.getElementById("gun-search").style.display = "block";
    document.querySelector(".weapon-toggle").style.display = "flex";

    // Hide build area
    document.getElementById("left-build-area").style.display = "none";

    // Clear right panel
    document.getElementById("attachment-table-container").innerHTML = "";

    // Restore placeholder
    const placeholder = document.getElementById("attachment-placeholder");
    if (placeholder) {
        placeholder.style.display = "flex";
    }

    // Reset header
    document.getElementById("current-gun-label").textContent = "No Gun Selected";
    document.getElementById("header-gun-image").style.display = "none";

    // Remove any previous gun highlight
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

  currentBuildData = null;

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

    const graphImage = document.getElementById("graph-gun-image");
    if (graphImage) {
        graphImage.src = gun.image_512_link || gun.icon_link;
    }

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
    await renderGraphBaseSlots();
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
   BASE STATS
=========================== */

function loadBaseStats() {
  const box = document.getElementById("stats");

  box.innerHTML = `
    <h3>Weapon Stats</h3>
    <div>Base Ergo: ${currentGun.base_ergo ?? 0}</div>
    <div>Base Weight: ${parseFloat(currentGun.weight ?? 0).toFixed(3)} kg</div>
    <hr />
  `;

  refreshBuildStats();
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

  const res = await fetch(`${API_BASE}/build/calculate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_item_id: currentGun.id,
      attachment_ids: attachmentIds,
      assume_full_mag: assumeFull,
      selected_ammo_id: selectedAmmo
    })
  });

  const data = await res.json();

  updateStatsPanel(data);

  console.log("Toggle state:", assumeFull);
  console.log("Selected ammo:", selectedAmmo);

  return data;
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

  const eedClass = eed >= 0 ? "positive" : "negative";
  const overswingClass = data.overswing ? "negative" : "positive";

  content.innerHTML = `
    <div class="stats-section">
      <div class="section-title">CURRENT BUILD</div>
      <div>Total Ergo: ${totalErgo.toFixed(1)}</div>
      <div>Total Weight: ${totalWeight.toFixed(3)} kg</div>
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
    </div>
  `;
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

        const wrapper = document.createElement("div");
        wrapper.className = "tree-slot";
        wrapper.dataset.slotId = slot.id;
        wrapper.style.marginLeft = `${depth * 20}px`;
        wrapper.dataset.depth = depth;

        wrapper.innerHTML = `
            <div class="tree-slot-inner">
                <div class="tree-slot-name">${slot.slot_name}</div>
                <div class="tree-slot-item">
                    ${
                        installed
                        ? `<img src="${installed.item.icon_link}" />`
                        : `<div class="empty-slot">+</div>`
                    }
                </div>
            </div>
        `;

        // LEFT CLICK
        wrapper.onclick = (e) => {

            // Prevent right click from triggering left click
            if (e.button === 2) return;

            if (installed) {
                // Inspect child slots instead of removing
                openSlotSelector(node, slot);
            } else {
                openSlotSelector(node, slot);
            }
        };

        // RIGHT CLICK = REMOVE
        wrapper.oncontextmenu = (e) => {

            e.preventDefault();

            const currentInstalled = node.children[slot.id];

            if (!currentInstalled) return;

            removeAttachment(node, slot.id);
        };

        parentElement.appendChild(wrapper);

        if (installed) {
            await renderNode(installed, depth + 1, parentElement);
        }
    }
}

/* ===========================
   TABLE SLOT SELECTOR
=========================== */

async function openSlotSelector(parentNode, slot) {

    // Hide placeholder
document.getElementById("attachment-placeholder").style.display = "none";

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
                <col style="width: 60%;" />
                <col style="width: 13%;" />
                <col style="width: 13%;" />
                <col style="width: 14%;" />
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
                    <th id="th-evo" onclick="changeSort('evo')">
                        EvoErgo <span class="sort-indicator"></span>
                    </th>
                </tr>
            </thead>

            <tbody id="attachment-body"></tbody>
        </table>
    `;

  const res = await fetch(`${API_BASE}/slots/${slot.id}/allowed-items`);
  const items = await res.json();

  const baseAttachmentIds = collectAttachmentIds(buildTree);

  const baseRes = await fetch(`${API_BASE}/build/calculate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_item_id: currentGun.id,
      attachment_ids: baseAttachmentIds
    })
  });

  const baseData = await baseRes.json();
  const baseEED = parseFloat(baseData.evo_ergo_delta ?? 0);

  const processedItems = [];

  for (const item of items) {

        let hasConflict = false;
        let conflictName = null;

        const simulatedIds = [...baseAttachmentIds];

        // Remove existing attachment first
        if (parentNode.children[slot.id]) {
            const existingId = parentNode.children[slot.id].item.id;
            const index = simulatedIds.indexOf(existingId);
            if (index > -1) simulatedIds.splice(index, 1);
        }

        // Validate candidate
        const validationRes = await fetch(`${API_BASE}/build/validate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                base_item_id: currentGun.id,
                installed_ids: simulatedIds,
                slot_id: slot.id,
                candidate_id: item.id
            })
        });

        const validationData = await validationRes.json();

        if (!validationData.valid) {
            hasConflict = true;
            conflictName = validationData.reason;
        }

        // Simulate with candidate installed
        simulatedIds.push(item.id);

        const simRes = await fetch(`${API_BASE}/build/calculate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                base_item_id: currentGun.id,
                attachment_ids: simulatedIds
            })
        });

        const simData = await simRes.json();

        const contribution =
            parseFloat(simData.evo_ergo_delta ?? 0) - baseEED;

        const recoilPercent =
            parseFloat(item.recoil_modifier ?? 0) * 100;

        processedItems.push({
            item,
            contribution,
            recoilPercent,
            hasConflict,
            conflictName
        });
    }

  lastProcessedItems = processedItems;

  document
    .getElementById("attachment-search")
    .addEventListener("input", (e) => {
        applyAttachmentSearch(e.target.value);
    });

  lastParentNode = parentNode;
  lastSlot = slot;

  applyAttachmentSort();
}

/* ===========================
   ATTACHMENT TABLE SEARCH
=========================== */

function applyAttachmentSearch(query) {
  const lower = query.toLowerCase();

  const filtered = lastProcessedItems.filter(entry =>
    entry.item.name.toLowerCase().includes(lower)
  );

  const original = lastProcessedItems;
  lastProcessedItems = filtered;

  applyAttachmentSort();

  lastProcessedItems = original;
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

function applyAttachmentSort() {
  const dir = attachmentSort.direction === "asc" ? 1 : -1;

  lastProcessedItems.sort((a, b) => {

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

      default:
        primary = 0;
    }

    if (primary !== 0) return primary * dir;

    // ---------- SECONDARY SORT ----------
    // If sorting by recoil, tie-break by evoergo (DESC)
    if (attachmentSort.key === "recoil") {
      const evoDiff = b.contribution - a.contribution;
      if (evoDiff !== 0) return evoDiff;
    }

    // ---------- TERTIARY SORT ----------
    // Final fallback = alphabetical
    return a.item.name.localeCompare(b.item.name);
  });

  updateSortIndicators();
  renderAttachmentRows();
}

function updateSortIndicators() {
  const headers = ["name", "weight", "recoil", "evo"];

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

function renderAttachmentRows() {

  const tbody = document.getElementById("attachment-body");
  tbody.innerHTML = "";

  for (const entry of lastProcessedItems) {

    const { item, contribution, recoilPercent } = entry;

    const installedId =
        lastParentNode?.children?.[lastSlot.id]?.item?.id;

    const row = document.createElement("tr");

    // Apply conflict styling (if any)
    if (entry.hasConflict) {
        row.classList.add("conflict-row");
    }

    // Apply installed highlight
    if (
        installedId &&
        String(installedId) === String(item.id)
    ) {
        row.classList.add("attachment-row-installed");
    }

    row.innerHTML = `
        <td class="name-cell">
            <div class="attachment-name-wrapper">
                <img 
                    src="${item.icon_link || ''}" 
                    class="attachment-icon"
                    loading="lazy"
                    decoding="async"
                    onerror="this.style.display='none'"
                />
                <span>${item.name}</span>
            </div>
        </td>

        <td>${parseFloat(item.weight ?? 0).toFixed(3)}</td>

        <td>${
            Math.abs(recoilPercent - Math.round(recoilPercent)) < 0.001
                ? Math.round(recoilPercent)
                : recoilPercent.toFixed(1)
        }%</td>

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

function installAttachment(parentNode, slotId, item) {
    parentNode.children[slotId] = { item, children: {} };
    refreshBuildStats();
    renderAttachmentRows();
    updateSingleSlotUI(parentNode, slotId);
}

function removeAttachment(parentNode, slotId) {

    delete parentNode.children[slotId];

    if (lastParentNode === parentNode && lastSlot?.id === slotId) {

        lastParentNode = null;
        lastSlot = null;

        document.getElementById("attachment-table-container").innerHTML = "";

        const placeholder = document.getElementById("attachment-placeholder");
        if (placeholder) {
            placeholder.style.display = "flex";
        }
    }

    refreshBuildStats();
    updateSingleSlotUI(parentNode, slotId);
}

async function updateSingleSlotUI(parentNode, slotId) {

    const wrapper = document.querySelector(
        `.tree-slot[data-slot-id="${slotId}"]`
    );

    if (!wrapper) return;

    const currentDepth = parseInt(wrapper.dataset.depth);

    const installed = parentNode.children[slotId];

    // Update slot icon
    const itemContainer = wrapper.querySelector(".tree-slot-item");

    if (installed) {
        itemContainer.innerHTML =
            `<img src="${installed.item.icon_link}" />`;
    } else {
        itemContainer.innerHTML =
            `<div class="empty-slot">+</div>`;
    }

    // Remove ALL deeper descendants
    let next = wrapper.nextElementSibling;

    while (next) {
        const nextDepth = parseInt(next.dataset.depth);

        if (isNaN(nextDepth) || nextDepth <= currentDepth) break;

        const toRemove = next;
        next = next.nextElementSibling;
        toRemove.remove();
    }

    // Re-render children if installed
    if (installed) {

        // Create a temporary fragment
        const fragment = document.createDocumentFragment();

        await renderNode(
            installed,
            currentDepth + 1,
            fragment
        );

        // Insert children immediately after this wrapper
        let insertAfter = wrapper;

        Array.from(fragment.children).forEach(child => {
            insertAfter.after(child);
            insertAfter = child;
        });
    }
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

function classifySlot(slot) {

    const nameId = slot.name_id;

    if (!nameId) {
        console.warn("Missing name_id:", slot);
        return "left";
    }

    // -----------------------------
    // RIGHT SIDE
    // -----------------------------
    if (nameId.startsWith("mod_stock"))
        return "right";

    // -----------------------------
    // BOTTOM
    // -----------------------------
    if (
        nameId.startsWith("mod_magazine") ||
        nameId.startsWith("mod_pistol_grip") ||
        nameId.startsWith("mod_pistolgrip") ||
        nameId.startsWith("mod_launcher") ||
        nameId.startsWith("mod_bipod") ||
        nameId === "mod_charge_001" ||
        nameId === "mod_mount" // This is in bottom for the G36 magwell mount slot
    )
        return "bottom";

    // -----------------------------
    // TOP
    // -----------------------------
    if (
        nameId.startsWith("mod_sight_rear") ||
        nameId.startsWith("mod_scope")
    )
        return "top";

    // -----------------------------
    // LEFT STRUCTURAL CHAIN
    // -----------------------------
    if (
        nameId.startsWith("mod_reciever") || // BSG WHAT THE FUCK IS THIS???????
        nameId.startsWith("mod_barrel") ||
        nameId.startsWith("mod_handguard") ||
        nameId.startsWith("mod_gas_block") ||
        nameId.startsWith("mod_muzzle") ||
        nameId.startsWith("mod_mount")
    )
        return "left";

    // -----------------------------
    // INTERNAL HANDGUN PARTS
    // -----------------------------
    if (
        nameId.startsWith("mod_trigger") ||
        nameId.startsWith("mod_hammer") ||
        nameId.startsWith("mod_catch")
    )
        return "left";

    return "left";
}

/* ===========================
   GRAPH GEOMETRY ENGINE
=========================== */

function getStructuralRoleFromNameId(nameId) {

    if (!nameId) return null;

    if (nameId.startsWith("mod_reciever"))
        return "receiver";

    if (nameId.startsWith("mod_handguard"))
        return "handguard";

    if (nameId.startsWith("mod_barrel"))
        return "barrel";

    if (nameId.startsWith("mod_gas_block"))
        return "gas_block";

    if (nameId.startsWith("mod_muzzle"))
        return "muzzle";

    if (nameId.startsWith("mod_mount"))
        return "side_rail";

    if (nameId.startsWith("mod_magazine"))
        return "magazine";

    if (
        nameId.startsWith("mod_pistol_grip") ||
        nameId.startsWith("mod_pistolgrip")
    )
        return "pistol_grip";

    if (nameId.startsWith("mod_launcher"))
        return "underbarrel";

    if (nameId.startsWith("mod_bipod"))
        return "lower_accessory";

    if (nameId.startsWith("mod_sight_front"))
        return "front_sight";

    if (nameId.startsWith("mod_sight_rear"))
        return "rear_sight";

    if (nameId === "mod_charge")
        return "charging_handle";

    if (nameId === "mod_charge_001")
        return "bolt_release";

    if (nameId.startsWith("mod_scope"))
        return "top_rail";

    return null;
}

async function renderGraphBaseSlots() {

    const layer = document.getElementById("graph-slots-layer");
    const frame = document.querySelector(".gun-frame");

    if (!layer || !frame || !currentGun || !buildTree) return;

    layer.innerHTML = "";

    const renderedSlotIds = new Set();

    const res = await fetch(`${API_BASE}/items/${buildTree.item.id}/slots`);
    const baseSlots = await res.json();

    const containerRect = layer.getBoundingClientRect();
    const rect = frame.getBoundingClientRect();

    const slotSize = 56;

    // 3x1 border dimensions
    const borderWidth = slotSize * 3;
    const borderHeight = slotSize;

    // Center the 3x1 border in container
    const frameLeft = (containerRect.width - borderWidth) / 2;
    const frameTop = (containerRect.height - borderHeight) / 2;

    // =====================================
    // Bucket slots by direction
    // =====================================

    const buckets = {
        left: [],
        right: [],
        top: [],
        bottom: []
    };

    for (const slot of baseSlots) {

        const direction = classifySlot(slot);

        if (buckets[direction]) {
            buckets[direction].push(slot);
        }
    }

    // =====================================
    // LEFT STRUCTURAL QUEUE (STRICT ORDER)
    // =====================================

    const structuralOrder = [
        "receiver",
        "handguard",
        "barrel",
        "gas_block",
        "muzzle"
    ];

    // Map actual slots by structural role
    const structuralSlots = {};

    for (const slot of buckets.left) {
        const role = getStructuralRoleFromNameId(slot.name_id);
        if (role && structuralOrder.includes(role)) {
            structuralSlots[role] = slot;
        }
    }

    // Compute theoretical positions first
    const leftPositionMap = {};
    let currentIndex = 0;

    for (const role of structuralOrder) {

        const slot = structuralSlots[role];

        if (!slot) continue; // compression happens here

        const node = createGraphNode(slot);

        const left =
            frameLeft - slotSize * (currentIndex + 1);

        node.style.left = `${left}px`;
        node.style.top = `${frameTop}px`;

        layer.appendChild(node);
        renderedSlotIds.add(slot.id);

        leftPositionMap[role] = left;

        currentIndex++;
    }

    // =====================================
    // STOCK (RIGHT OF 3x1 BORDER)
    // =====================================

    let stockX = null;
    let stockY = null;

    const stockSlot = baseSlots.find(s =>
        s.name_id?.startsWith("mod_stock")
    );

    if (stockSlot) {

        const node = createGraphNode(stockSlot);

        stockX = frameLeft + borderWidth;
        stockY = frameTop;

        node.style.left = `${stockX}px`;
        node.style.top = `${stockY}px`;

        layer.appendChild(node);
        renderedSlotIds.add(stockSlot.id);
    }

    // =====================================
    // NORMAL CHARGING HANDLE (TOP OF STOCK)
    // =====================================

    const chargingHandleSlot = baseSlots.find(s =>
        s.name_id === "mod_charge"
    );

    if (chargingHandleSlot && stockX !== null) {

        const node = createGraphNode(chargingHandleSlot);

        node.style.left = `${stockX}px`;
        node.style.top = `${stockY - slotSize}px`;

        layer.appendChild(node);
        renderedSlotIds.add(chargingHandleSlot.id);
    }

    // =====================================
    // UBGL (BOTTOM OF GAS BLOCK)
    // =====================================

    const ubglSlot = baseSlots.find(s =>
        s.name_id?.startsWith("mod_launcher")
    );

    if (ubglSlot && leftPositionMap["gas_block"] !== undefined) {

        const node = createGraphNode(ubglSlot);

        node.style.left = `${leftPositionMap["gas_block"]}px`;
        node.style.top = `${frameTop + slotSize}px`;

        layer.appendChild(node);
        renderedSlotIds.add(ubglSlot.id);
    }

    // =====================================
    // FRONT SIGHT (TOP OF MUZZLE OR FLOAT)
    // =====================================

    const frontSightSlot = baseSlots.find(s =>
        s.name_id?.startsWith("mod_sight_front")
    );

    if (frontSightSlot) {

        let muzzleX;

        if (leftPositionMap["muzzle"] !== undefined) {

            // Normal case — muzzle exists
            muzzleX = leftPositionMap["muzzle"];

        } else {

            // Floating case — compute compressed index
            const compressedRoles = structuralOrder.filter(role =>
                structuralSlots[role] !== undefined
            );

            const muzzleIndex =
                compressedRoles.indexOf("muzzle");

            // If muzzle not in compressed chain,
            // treat it as the outermost position
            const floatingIndex =
                muzzleIndex === -1
                    ? compressedRoles.length
                    : muzzleIndex;

            muzzleX =
                frameLeft - slotSize * (floatingIndex + 1);
        }

        const node = createGraphNode(frontSightSlot);

        node.style.left = `${muzzleX}px`;
        node.style.top = `${frameTop - slotSize}px`;

        layer.appendChild(node);
        renderedSlotIds.add(frontSightSlot.id);
    }

    // =====================================
    // RIGHT
    // =====================================

    buckets.right.forEach((slot, index) => {

        // Skip stock (already rendered explicitly)
        if (slot.name_id?.startsWith("mod_stock")) {
            return;
        }

        const node = createGraphNode(slot);

        node.style.left = `${frameLeft + slotSize * 3}px`;

        node.style.top =
            `${frameTop + slotSize * index}px`;

        layer.appendChild(node);
        renderedSlotIds.add(slot.id);
    });

    // =====================================
    // BOTTOM
    // =====================================

    const bottomColumns = {
        left: [],
        middle: [],
        right: []
    };

    for (const slot of buckets.bottom) {

        const nameId = slot.name_id || "";

        // ---------------------------------
        // LEFT COLUMN
        // ---------------------------------
        if (
            nameId === "mod_charge_001" ||      // M4 bolt release
            nameId === "mod_mount" ||           // G36 magwell mount
            nameId.startsWith("mod_bipod")      // LMG bipods
        ) {

            bottomColumns.left.push(slot);

        }
        // ---------------------------------
        // MIDDLE COLUMN
        // ---------------------------------
        else if (nameId.startsWith("mod_magazine")) {

            bottomColumns.middle.push(slot);

        }
        // ---------------------------------
        // RIGHT COLUMN
        // ---------------------------------
        else if (
            nameId.startsWith("mod_pistol_grip") ||
            nameId.startsWith("mod_pistolgrip")
        ) {

            bottomColumns.right.push(slot);

        }
    }

    const bottomOrder = ["left", "middle", "right"];

    bottomOrder.forEach((col, colIndex) => {

        bottomColumns[col].forEach((slot, rowIndex) => {

            const node = createGraphNode(slot);

            const left = frameLeft + slotSize * colIndex;
            const top = frameTop + slotSize * (rowIndex + 1);

            node.style.left = `${left}px`;
            node.style.top = `${top}px`;

            layer.appendChild(node);
            renderedSlotIds.add(slot.id);
        });
    });

    // =====================================
    // TOP (STRICT 3-COLUMN RULE 6)
    // =====================================

    const topColumns = {
        tactical: [],
        scope: [],
        rear_sight: []
    };

    // Bucket strictly by structural role
    for (const slot of buckets.top) {

        const role = getStructuralRoleFromNameId(slot.name_id);

        if (role === "rear_sight") {
            topColumns.rear_sight.push(slot);
        }
        else if (role === "top_rail") {
            topColumns.scope.push(slot);
        }
        else {
            // Everything else considered tactical
            topColumns.tactical.push(slot);
        }
    }

    // Fixed left → right order
    const topOrder = [
        "tactical",
        "scope",
        "rear_sight"
    ];

    topOrder.forEach((role, colIndex) => {

        const slotsInColumn = topColumns[role];

        slotsInColumn.forEach((slot, rowIndex) => {

            const node = createGraphNode(slot);

            const left = frameLeft + slotSize * colIndex;
            const top = frameTop - slotSize * (rowIndex + 1);

            node.style.left = `${left}px`;
            node.style.top = `${top}px`;

            layer.appendChild(node);
            renderedSlotIds.add(slot.id);
        });
    });
}

function createGraphNode(slot) {

    const node = document.createElement("div");
    node.className = "graph-slot";

    node.textContent =
        slot.slot_name.split(" ")[0];

    node.onclick = () => {
        openSlotSelector(buildTree, slot);
    };

    return node;
}

// Slot debugger
const DEBUG_VERIFY_GRAPH = true;

async function debugScanAllGuns() {

    console.log("=== STARTING FULL name_id CLASSIFICATION SCAN ===");

    const unmapped = new Set();
    const allNameIds = new Set();
    const directionBuckets = {
        left: new Set(),
        right: new Set(),
        top: new Set(),
        bottom: new Set()
    };

    const res = await fetch(`${API_BASE}/guns`);
    const guns = await res.json();

    for (const gun of guns) {

        const slotRes = await fetch(`${API_BASE}/items/${gun.id}/slots`);
        const baseSlots = await slotRes.json();

        for (const slot of baseSlots) {

            const nameId = slot.name_id;

            if (!nameId) {
                console.warn("Slot missing name_id:", slot);
                continue;
            }

            allNameIds.add(nameId);

            const direction = classifySlot(slot);

            if (!directionBuckets[direction]) {
                unmapped.add(nameId);
            } else {
                directionBuckets[direction].add(nameId);
            }
        }
    }

    // -----------------------------
    // REPORT
    // -----------------------------

    console.log("=== UNIQUE name_id VALUES ===");
    console.table(Array.from(allNameIds).sort());

    console.log("=== CLASSIFIED BY DIRECTION ===");

    for (const dir in directionBuckets) {
        console.log(`\n--- ${dir.toUpperCase()} ---`);
        console.table(Array.from(directionBuckets[dir]).sort());
    }

    console.log("=== UNMAPPED name_id VALUES ===");

    if (unmapped.size === 0) {
        console.log("None. All slots classified.");
    } else {
        console.table(Array.from(unmapped).sort());
    }

    console.log("=== SCAN COMPLETE ===");
}