const API_BASE = "http://127.0.0.1:8000";

let allGuns = [];
let currentGun = null;
let buildTree = null;
let slotCache = {};
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
   GUN LIST
=========================== */

function renderGunList(guns) {
  const list = document.getElementById("guns");
  list.innerHTML = "";

  guns
    .sort((a, b) => b.base_ergo - a.base_ergo)
    .forEach(gun => {
      const li = document.createElement("li");
      li.textContent = `${gun.name} ｜ Base Ergo: ${gun.base_ergo}`;
      li.onclick = () => selectGun(gun, li);
      list.appendChild(li);
    });
}

function selectGun(gun, liElement) {
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

  loadBaseStats();
  renderFullTree();
}

/* ===========================
   BASE STATS
=========================== */

function loadBaseStats() {
  const box = document.getElementById("stats");

  box.innerHTML = `
    <h3>Weapon Stats</h3>
    <div>Base Ergo: ${currentGun.base_ergo}</div>
    <div>Base Weight: ${currentGun.weight} kg</div>
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

  try {
    const res = await fetch(`${API_BASE}/build/calculate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_item_id: currentGun.id,
        attachment_ids: attachmentIds
      })
    });

    const data = await res.json();
    currentBuildData = data;

    updateStatsPanel(data);
  } catch (err) {
    console.error("Build calculation failed:", err);
  }
}

function updateStatsPanel(data) {
  const box = document.getElementById("stats");

  const eedClass = data.evo_ergo_delta >= 0 ? "positive" : "negative";
  const overswingClass = data.overswing ? "negative" : "positive";

  box.innerHTML = `
    <h3>Weapon Stats</h3>
    <div>Base Ergo: ${data.base_ergo}</div>
    <div>Base Weight: ${data.base_weight} kg</div>
    <hr />
    <div><strong>Total Weight:</strong> ${data.total_weight} kg</div>
    <div>
      <strong>EvoErgoDelta:</strong>
      <span class="${eedClass}">
        ${data.evo_ergo_delta}
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
   RECURSIVE TREE RENDERING
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
    wrapper.style.marginTop = "5px";
    wrapper.style.cursor = "pointer";

    const installed = node.children[slot.id];

    wrapper.innerHTML = `
      <strong>${slot.slot_name}</strong>
      ${installed ? ` → ${installed.item.name}` : ""}
    `;

    if (installed) {
      wrapper.style.color = "#4CAF50";
    }

    wrapper.onclick = () => {
      if (installed) {
        removeAttachment(node, slot.id);
      } else {
        openSlotSelector(node, slot);
      }
    };

    box.appendChild(wrapper);

    if (installed) {
      await renderNode(installed, depth + 1);
    }
  }
}

async function openSlotSelector(parentNode, slot) {
  const res = await fetch(`${API_BASE}/slots/${slot.id}/allowed-items`);
  const items = await res.json();

  const box = document.getElementById("slots");

  box.innerHTML = `
    <h3>Select Attachment for ${slot.slot_name}</h3>
    <button onclick="renderFullTree()">← Back</button>
  `;

  const baseAttachmentIds = collectAttachmentIds(buildTree);

  // Get current build EED
  const baseRes = await fetch(`${API_BASE}/build/calculate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_item_id: currentGun.id,
      attachment_ids: baseAttachmentIds
    })
  });

  const baseData = await baseRes.json();
  const baseEED = parseFloat(baseData.evo_ergo_delta);

  for (const item of items) {
    const div = document.createElement("div");
    div.style.cursor = "pointer";
    div.style.marginBottom = "6px";

    // Simulate build WITH this attachment
    const simulatedIds = [...baseAttachmentIds];

    // If replacing existing attachment in slot
    if (parentNode.children[slot.id]) {
      const existingId = parentNode.children[slot.id].item.id;
      const index = simulatedIds.indexOf(existingId);
      if (index > -1) {
        simulatedIds.splice(index, 1);
      }
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
    const simulatedEED = parseFloat(simData.evo_ergo_delta);

    const contribution = (simulatedEED - baseEED).toFixed(2);
    const colorClass = contribution >= 0 ? "positive" : "negative";

    div.innerHTML = `
      ${item.name} ｜ ${item.weight ?? 0} kg ｜ 
      <span class="${colorClass}">
        EvoErgo ${contribution > 0 ? "+" : ""}${contribution}
      </span>
    `;

    div.onclick = () => {
      installAttachment(parentNode, slot.id, item);
    };

    box.appendChild(div);
  }

  if (parentNode.children[slot.id]) {
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove Attachment";
    removeBtn.onclick = () => {
      removeAttachment(parentNode, slot.id);
    };
    box.appendChild(removeBtn);
  }
}

function installAttachment(parentNode, slotId, item) {
  parentNode.children[slotId] = {
    item: item,
    children: {}
  };

  refreshAfterChange();
}

function removeAttachment(parentNode, slotId) {
  delete parentNode.children[slotId];
  refreshAfterChange();
}

async function refreshAfterChange() {
  await renderFullTree();
  await refreshBuildStats();
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