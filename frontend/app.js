const API_BASE = "http://127.0.0.1:8000";

let allGuns = [];
let currentGun = null;
let buildTree = null;
let slotCache = {};
let allowedCache = {};
let currentBuildData = null;

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

/* ===========================
   GUN LIST
=========================== */

function renderGunList(guns) {
  const list = document.getElementById("guns");
  list.innerHTML = "";

  const grouped = {};

  guns.forEach(g => {

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

    const header = document.createElement("li");

    if (caliber === "Other") {
        header.innerHTML = `<strong style="opacity:0.6;">Other</strong>`;
    } else {
        header.innerHTML = `<strong>${caliber}</strong>`;
    }

    header.style.marginTop = "15px";
    header.style.cursor = "default";
    header.style.opacity = "0.7";
    list.appendChild(header);

    grouped[caliber]
      .sort((a,b) => (b.base_ergo ?? 0) - (a.base_ergo ?? 0))
      .forEach(gun => {

        const li = document.createElement("li");

        li.innerHTML = `
            <div class="gun-list-item">
                <img src="${gun.icon_link}" class="gun-list-icon">
                <div>
                <div>${gun.name}</div>
                </div>
            </div>
            `;

        li.onclick = () => selectGun(gun, li);
        list.appendChild(li);
      });
  });
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

async function selectGun(gun, liElement) {
    // If clicking same gun, do nothing
    if (currentGun && currentGun.id === gun.id) {
        return;
    }

  currentGun = gun;

    // Reset stats panel completely for new gun
    document.getElementById("stats").innerHTML = "";

  currentBuildData = null;

  buildTree = {
    item: gun,
    children: {}
  };

  document.querySelectorAll("#guns li")
    .forEach(li => li.classList.remove("selected-gun"));

  liElement.classList.add("selected-gun");

  document.getElementById("current-gun-label").textContent = gun.name;

  const headerImage = document.getElementById("header-gun-image");

  if (gun.icon_link) {
    headerImage.src = gun.icon_link;
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
  await refreshBuildStats();
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

      // Now recursively try installing remaining factory parts
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
  if (!currentGun) return;

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

async function renderFullTree() {

  const container = document.getElementById("slots");

  container.innerHTML = `
    <div class="stats-section">
      <div class="section-title">ATTACHMENT TREE</div>
      <div id="tree-content"></div>
    </div>
  `;

  const treeBox = document.getElementById("tree-content");

  if (!treeBox) return;

  await renderNode(buildTree, 0, treeBox);
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

  const box = parentElement;

  for (const slot of slots) {
    const wrapper = document.createElement("div");
    wrapper.style.marginLeft = `${depth * 20}px`;
    wrapper.style.cursor = "pointer";

    const installed = node.children[slot.id];

    wrapper.innerHTML = `
      <strong>${slot.slot_name}</strong>
      ${installed ? ` → ${installed.item.name}` : ""}
    `;

    if (installed) wrapper.style.color = "#4CAF50";

    wrapper.onclick = () => {
      installed
        ? removeAttachment(node, slot.id)
        : openSlotSelector(node, slot);
    };

    box.appendChild(wrapper);

    if (installed) {
      await renderNode(installed, depth + 1, parentElement);
    }
  }
}

/* ===========================
   TABLE SLOT SELECTOR
=========================== */

async function openSlotSelector(parentNode, slot) {
  const box = document.getElementById("slots");

  box.innerHTML = `
    <h3>Select Attachment for ${slot.slot_name}</h3>
    <button onclick="renderFullTree()">← Back</button>

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
            Weight <span class="sort-indicator"></span>
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
    const simulatedIds = [...baseAttachmentIds];

    if (parentNode.children[slot.id]) {
      const existingId = parentNode.children[slot.id].item.id;
      const index = simulatedIds.indexOf(existingId);
      if (index > -1) simulatedIds.splice(index, 1);
    }

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

    const recoilPercent = Math.round(
      parseFloat(item.recoil_modifier ?? 0) * 100
    );

    processedItems.push({ item, contribution, recoilPercent });
  }

  lastProcessedItems = processedItems;
  lastParentNode = parentNode;
  lastSlot = slot;

  applyAttachmentSort();
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

    const row = document.createElement("tr");

    row.innerHTML = `
        <td class="name-cell">
            <div class="attachment-name-wrapper">
            <img 
                src="${item.icon_link || item.icon || item.image || ''}" 
                class="attachment-icon"
                onerror="this.style.display='none'"
            />
            <span>${item.name}</span>
            </div>
        </td>

        <td>${parseFloat(item.weight ?? 0).toFixed(3)}</td>

        <td>${recoilPercent}%</td>

        <td class="${contribution >= 0 ? "positive" : "negative"}">
            ${contribution >= 0 ? "+" : ""}${contribution.toFixed(1)}
        </td>
        `;

    row.addEventListener("click", () => {
        // Remove existing attachment in this slot (if any)
        if (lastParentNode.children[lastSlot.id]) {
            delete lastParentNode.children[lastSlot.id];
        }

        // Install selected attachment
        lastParentNode.children[lastSlot.id] = {
            item: item,
            children: {}
        };

        // Re-render full attachment tree
        renderFullTree();

        // Recalculate stats
        refreshBuildStats();
        });

    row.onclick = () => {
      installAttachment(lastParentNode, lastSlot, item);
    };

    tbody.appendChild(row);
  }
}

/* ===========================
   TREE MANAGEMENT
=========================== */

function installAttachment(parentNode, slotId, item) {
  parentNode.children[slotId] = { item, children: {} };
  renderFullTree();
  refreshBuildStats();
}

function removeAttachment(parentNode, slotId) {
    delete parentNode.children[slotId];

    renderFullTree();
    refreshBuildStats();
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