window.EFTForge = window.EFTForge || {};

const _base = () => EFTForge.config.API_BASE;
const _post = (path, body) => fetch(`${_base()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
});

async function fetchGuns() {
    const res = await fetch(`${_base()}/guns`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function fetchAmmo(caliber) {
    const res = await fetch(`${_base()}/ammo/${caliber}`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function fetchItemSlots(itemId) {
    const res = await fetch(`${_base()}/items/${itemId}/slots`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function fetchSlotAllowedItems(slotId) {
    const res = await fetch(`${_base()}/slots/${slotId}/allowed-items`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function calculateBuild(payload) {
    const res = await _post("/build/calculate", payload);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function validateBuild(payload) {
    const res = await _post("/build/validate", payload);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

EFTForge.api = { fetchGuns, fetchAmmo, fetchItemSlots, fetchSlotAllowedItems, calculateBuild, validateBuild };
