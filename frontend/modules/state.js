window.EFTForge = window.EFTForge || {};

window.EFTForge.state = {
    // Language
    lang: localStorage.getItem("eftforge_lang") || "zh",

    // Traders (id -> { name, normalizedName, imageLink, image4xLink })
    traders:        {},
    tradersByNorm:  {},

    // Gun list
    allGuns:      [],
    currentGun:   null,

    // Build
    buildTree:        null,
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
    lastEED:                  0,
    lastOverswing:  false,
    lastArmStamina: 0,
    lastBaseWeight:           0,
    currentEquipErgoModifier: 0,

    // Attachment table
    attachmentSort: { key: "recoil", direction: "asc" },
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
    compareBaselineId:      null,
    compareBaselineEntry:   null,
    compareBaselineSlotPath: null, // e.g. ["stockSlotId", "childStockSlotId"]

    // Stats controls
    assumeFullMag: true,
    hiddenStatsOpen: false,

    // Ammo lookup (id -> ammo object with price fields)
    ammoMap: {},

    // Price view
    priceView:      false,
    pveMode:        false,
    fleaCachePvp:   {},
    fleaCachePve:   {},
    fleaLastFetched: null, // ISO string timestamp of last full flea fetch

    // Trader loyalty levels (normalizedName -> 1-4, default 4 = max)
    traderLevels: {},

    // Attachment ratings (item_id -> { likes, dislikes, user_vote })
    ratingsCache: {},
};
