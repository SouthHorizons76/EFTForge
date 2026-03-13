window.EFTForge = window.EFTForge || {};

const _base = () => EFTForge.config.API_BASE;
const _lang = () => (EFTForge.state && EFTForge.state.lang) || "en";
const _post = (path, body) => fetch(`${_base()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
});

async function fetchGuns() {
    const res = await fetch(`${_base()}/guns?lang=${_lang()}`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function fetchAmmo(caliber) {
    const res = await fetch(`${_base()}/ammo/${caliber}?lang=${_lang()}`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function fetchItemSlots(itemId) {
    const res = await fetch(`${_base()}/items/${itemId}/slots`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

async function fetchSlotAllowedItems(slotId) {
    const res = await fetch(`${_base()}/slots/${slotId}/allowed-items?lang=${_lang()}`);
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

async function batchProcessCandidates(payload) {
    const res = await _post("/build/batch-process", payload);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json();
}

EFTForge.api = { fetchGuns, fetchAmmo, fetchItemSlots, fetchSlotAllowedItems, calculateBuild, validateBuild, batchProcessCandidates };
