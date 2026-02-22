const API_BASE = "http://127.0.0.1:8000";

let allGuns = [];
let currentGun = null;
let buildTree = null;
let slotCache = {};
let allowedCache = {};
let currentBuildData = null;

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

  guns
    .sort((a, b) => (b.base_ergo ?? 0) - (a.base_ergo ?? 0))
    .forEach(gun => {
      const li = document.createElement("li");

      li.innerHTML = `
        <div class="gun-list-item">
          <img src="${gun.icon_link}" class="gun-list-icon">
          <div>
            <div>${gun.name}</div>
            <div class="gun-base-ergo">
              Base Ergo: ${gun.base_ergo ?? 0}
            </div>
          </div>
        </div>
      `;

      li.onclick = () => selectGun(gun, li);
      list.appendChild(li);
    });
}

async function selectGun(gun, liElement) {
  currentGun = gun;
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

  await renderFullTree();
  await refreshBuildStats();
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

  const res = await fetch(`${API_BASE}/build/calculate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_item_id: currentGun.id,
      attachment_ids: attachmentIds
    })
  });

  const data = await res.json();
  updateStatsPanel(data);
}

function updateStatsPanel(data) {
  const box = document.getElementById("stats");

  const eed = parseFloat(data.evo_ergo_delta ?? 0);
  const baseErgo = parseFloat(data.base_ergo ?? 0);
  const totalErgo = parseFloat(data.total_ergo ?? 0);
  const totalWeight = parseFloat(data.total_weight ?? 0);
  const baseWeight = parseFloat(data.base_weight ?? 0);

  const eedClass = eed >= 0 ? "positive" : "negative";
  const overswingClass = data.overswing ? "negative" : "positive";

  box.innerHTML = `
    <h3>Factory Stats</h3>
    <div><strong>Ergo:</strong> ${totalErgo.toFixed(1)}</div>
    <div><strong>Weight:</strong> ${totalWeight.toFixed(3)} kg</div>

    <hr />

    <h3>Current Build</h3>
    <div><strong>Total Weight:</strong> ${totalWeight.toFixed(3)} kg</div>

    <div>
      <strong>EvoErgoDelta:</strong>
      <span class="${eedClass}">
        ${eed > 0 ? "+" : ""}${eed.toFixed(1)}
      </span>
    </div>

    <div>
      <strong>OverSwing:</strong>
      <span class="${overswingClass}">
        ${data.overswing ? "YES" : "NO"}
      </span>
    </div>
  `;
}

/* ===========================
   TREE RENDERING
=========================== */

async function renderFullTree() {
  const box = document.getElementById("slots");
  box.innerHTML = "<h3>Attachment Tree</h3>";
  await renderNode(buildTree, 0);
}

async function renderNode(node, depth) {
  let slots;

  if (slotCache[node.item.id]) {
    slots = slotCache[node.item.id];
  } else {
    const res = await fetch(`${API_BASE}/items/${node.item.id}/slots`);
    slots = await res.json();
    slotCache[node.item.id] = slots;
  }

  const box = document.getElementById("slots");

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
      await renderNode(installed, depth + 1);
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
  const body = document.getElementById("attachment-body");
  body.innerHTML = "";

  for (const entry of lastProcessedItems) {
    const { item, contribution, recoilPercent } = entry;

    const row = document.createElement("tr");
    row.style.cursor = "pointer";

    row.innerHTML = `
        <td>
        <div class="attachment-name-cell">
            <img src="${item.icon_link}" class="attachment-icon">
            <span>${item.name}</span>
        </div>
        </td>
      <td>${parseFloat(item.weight ?? 0).toFixed(3)}</td>
      <td>${recoilPercent > 0 ? "+" : ""}${recoilPercent}</td>
      <td class="${contribution >= 0 ? "positive" : "negative"}">
        ${contribution > 0 ? "+" : ""}${contribution.toFixed(1)}
      </td>
    `;

    row.onclick = () => {
      installAttachment(lastParentNode, lastSlot.id, item);
    };

    body.appendChild(row);
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