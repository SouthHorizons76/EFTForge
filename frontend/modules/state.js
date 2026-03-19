window.EFTForge = window.EFTForge || {};

window.EFTForge.state = {
    // Language
    lang: localStorage.getItem("eftforge_lang") || "zh",

    // Traders (id → { name, imageLink, image4xLink })
    traders: {},

    // Gun list
    allGuns:      [],
    currentGun:   null,

    // Build
    buildTree:    null,

    // Caches
    slotCache:      {},
    allowedCache:   {},
    processedCache: {},

    // Gun list UI
    showHandguns: false,
    sortByClass:  false,

    // Build tree UI
    collapsedSlots: {},

    // Stats
    currentStrengthLevel:    parseInt(localStorage.getItem("eftforge_strength_level") ?? "10"),
    lastTotalWeight:          0,
    lastTotalErgo:            0,
    lastRecoilV:           null,
    lastRecoilH:           null,
    lastEED:                  0,
    lastBaseWeight:           0,
    currentEquipErgoModifier: 0,

    // Attachment table
    attachmentSort: { key: "recoil", direction: "asc" },
    lastProcessedItems: [],
    lastParentNode:     null,
    lastSlot:           null,
    currentSearchQuery: "",
};
