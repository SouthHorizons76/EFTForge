window.EFTForge = window.EFTForge || {};

window.EFTForge.state = {
    // Language - saved preference wins; first-time visitors get zh only if their browser reports a zh locale
    lang: localStorage.getItem("eftforge_lang") || (navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en"),

    // Traders (id -> { name, normalizedName, imageLink, image4xLink })
    traders:        {},
    tradersByNorm:  {},

    // Gun list
    allGuns:      [],
    currentGun:   null,

    // Build
    buildTree:        null,
    factoryTree:      null, // server-resolved factory attachment tree, set on selectGun
    factoryPairsKey:  null, // canonical key of the gun's factory config, set on selectGun

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
    lastSightingRange:     null,
    lastTrueErgo:                  0,
    lastOverswing:  false,
    lastArmStamina: 0,
    lastBaseWeight:           0,
    lastHeatFactor:           null,
    lastCoolingFactor:        null,
    lastDurabilityBurnFactor: null,
    currentEquipErgoModifier: 0,

    // Attachment table
    attachmentSort: { key: "recoil", direction: "asc" },
    comboSort:      { key: "recoil", direction: "asc" },
    comboErgoWeight: parseInt(localStorage.getItem("eftforge_combo_ergo_weight") ?? "25", 10),
    lastProcessedItems: [],
    lastParentNode:     null,
    lastSlot:           null,
    currentSearchQuery: "",

    // Publish confirm mode - true while publish panel is showing; disables slot interactions
    publishMode: false,

    // Community build loaded from public list - shows author/name in placeholder until attachments diverge
    communityBuild: null, // { pairsKey, authorName, avatarUrl, buildName } | null

    // Compare mode
    compareMode:            false,
    purchasableOnly:        false,
    compareBaselineId:      null,
    compareBaselineEntry:   null,
    compareBaselineSlotPath: null, // e.g. ["stockSlotId", "childStockSlotId"]

    // Stats controls
    assumeFullMag: true,
    hiddenStatsOpen: false,

    // Ammo lookup (id -> ammo object with price fields)
    ammoMap: {},

    // UBGL grenade ammo lookup (id -> ammo object with price fields)
    ubglAmmoMap: {},

    // Price view
    priceView:      false,
    priceMode:      "pvp", // "pvp" | "pve" | "pvpSeason"
    fleaCachePvp:      {},
    fleaCachePve:      {},
    fleaCacheSeasonal: {},
    fleaLastFetched: null, // ISO string timestamp of last full flea fetch

    // Trader loyalty levels (normalizedName -> 1-4, default 4 = max)
    traderLevels: {},

    // Attachment ratings (item_id -> { likes, dislikes, user_vote })
    ratingsCache: {},

    // Combo recommender
    comboMode:         false,
    graphMode:         false,
    lastComboItems:    [],
    lastComboWasCapped: false,
    combosCache:       {},

    // Undo / redo history (session-scoped, cleared on gun switch)
    buildHistory: [], // array of serialized pairs strings (past states, newest last)
    buildFuture:  [], // array of serialized pairs strings (redo stack)

    // Build tabs (desktop only) - open build sessions
    // Each: { id, gunId, pinned, buildName, communityBuild, pairs, ammoId, ubglAmmoId, collapsedSlots }
    tabs:        [],
    activeTabId: null,
};
