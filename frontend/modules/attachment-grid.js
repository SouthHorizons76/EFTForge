window.EFTForge = window.EFTForge || {};

// ============================================================
// CONSTANTS
// ============================================================

const _AG_GUN_COL   = 7;   // gun spans CSS cols 7, 8, 9
const _AG_STOCK_COL = 10;

// Left-side attachment queue order (closest to gun = rightmost/last in array)
// "Catch" = mod_catch in Tarkov API (mainly pistols), sits between Handguard and Barrel
const _AG_LEFT_ORDER = ["Receiver", "Handguard", "Catch", "Barrel", "Gas Block", "Muzzle"];

// Top row (vrow -1), aligned to gun columns
const _AG_TOP_MAP = {
    "Scope":      _AG_GUN_COL + 1,  // col 8
    "Mount":      _AG_GUN_COL + 1,  // col 8 (dovetail mounts, AK74N etc.)
    "Rear Sight": _AG_GUN_COL + 2,  // col 9
};

// Bottom row (vrow +1), aligned to gun columns
const _AG_BOTTOM_MAP = {
    "Magazine":    _AG_GUN_COL + 1,  // col 8
    "Pistol Grip": _AG_GUN_COL + 2,  // col 9
};

// Bottom-left (vrow +1, col GUN_COL): LMG bipod, foregrip
// Note: "Catch" is in LEFT_ORDER now (pistol left-side slot), not here
const _AG_BOTTOM_LEFT = new Set(["Bipod", "Foregrip"]);

// Slots without a defined grid position - go to extras row below grid
const _AG_EXTRAS = new Set(["Grip", "Shroud", "Trigger", "Chamber", "Hammer"]);

// ============================================================
// SLOT PLACEHOLDER IMAGES
// ============================================================

const _SLOT_PLACEHOLDER_MAP = {
    "Barrel":       "mod_barrel.png",
    "Muzzle":       "mod_muzzle.png",
    "Stock":        "mod_stock.png",
    "Handguard":    "mod_handguard.png",
    "Scope":        "mod_scope.png",
    "Front Sight":  "mod_sight_front.png",
    "Rear Sight":   "mod_sight_rear.png",
    "Pistol Grip":  "mod_pistol_grip.png",
    "Grip":         "mod_pistol_grip.png",
    "Magazine":     "mod_magazine.png",
    "Gas Block":    "mod_gas_block.png",
    "Foregrip":     "mod_foregrip.png",
    "Ch. Handle":   "mod_charge.png",
    "Mount":        "mod_mount_000.png",
    "Tactical":     "mod_tactical_000.png",
    "Bipod":        "mod_bipod.png",
    "Receiver":     "mod_reciever.png",
    "Ubgl":         "mod_launcher.png",
    "Trigger":      "mod_trigger.png",
    "Hammer":       "mod_hammer.png",
    "Catch":        "mod_catch.png",
};

function _slotPlaceholderHtml(slotName, extraClass = "") {
    const file = _SLOT_PLACEHOLDER_MAP[slotName];
    if (!file) return `<div class="empty-slot">+</div>`;
    return `<img class="slot-placeholder-img${extraClass ? " " + extraClass : ""}" src="./assets/images/slot_placeholders/${file}" alt="" />`;
}
window._slotPlaceholderHtml = _slotPlaceholderHtml;
window._SLOT_PLACEHOLDER_MAP = _SLOT_PLACEHOLDER_MAP;

// ============================================================
// HARDCODED SLOT POSITION OVERRIDES
// Produced by the dev tool (attachment-grid-devtool.js).
// The devtool merges localStorage on top of these at runtime.
// ============================================================

window._AG_OVERRIDES = {
    "62811fbf09427b40ab14e76b@62811fbf09427b40ab14e767": { col: 9, vrow: -1, flexible: true },
    "62820f043e69a0418a7cb5f7@628120c21d5df4475f46a337": { col: 5, vrow: -2, flexible: true },
    "59bfe68886f7746004266206@59bfe68886f7746004266202": { col: 9, vrow: -1 },
    "5c07a8770db8340023300455@5c07a8770db8340023300450": { col: 9, vrow: -1 },
    "63f5ed14534b2c3d5479a67b@63f5ed14534b2c3d5479a677": { col: 9, vrow: -1 },
    "6357cd4b6bd1f226843c249f@55d3632e4bdc2d972f8b4569": { col: 3, vrow: 1, flexible: true },
    "55d35e074bdc2d882f8b456c@55d355e64bdc2d962f8b4569": { col: 9, vrow: -1, flexible: true },
    "55f57a5d4bdc2d972b8b4571@55d459824bdc2d892f8b4573": { col: 6, vrow: 1, flexible: true },
    "5648be684bdc2d3d1c8b4582@5644bd2b4bdc2d3b4c8b4572": { col: 7, vrow: 1 },
    "5649d5494bdc2d1b2b8b458b@5648ae314bdc2d3d1c8b457f": { col: 6, vrow: 1, flexible: true },
    "5649d5534bdc2d9d198b4569@5648ae314bdc2d3d1c8b457f": { col: 4, vrow: 1, flexible: true },
    "5649d6f84bdc2d9d198b456b@5648b4534bdc2d3d1c8b4580": { col: 4, vrow: 1, flexible: true },
    "5649d7694bdc2d79388b457f@55f84c3c4bdc2d5f408b4576": { col: 4, vrow: -1 },
    "5649d79a4bdc2d3d1c8b4587@55f84c3c4bdc2d5f408b4576": { col: 6, vrow: 1, flexible: true },
    "5649d7a74bdc2d3b4c8b457d@55f84c3c4bdc2d5f408b4576": { col: 4, vrow: 1, flexible: true },
    "56e3165fd2720b6c058b456c@55d459824bdc2d892f8b4573": { col: 4, vrow: -1 },
    "56ea8dc5d2720b67698b456e@56ea8d2fd2720b7c698b4570": { col: 3, vrow: -1 },
    "57838d2f2459774a256959b0@57838c962459774a1651ec63": { col: 6, vrow: -1, flexible: true },
    "57b33a0b2459771ee32dac59@57838ad32459774a17445cd2": { col: 9, vrow: -1 },
    "57c44e9a2459772d303d89a3@57c44dd02459772d2e0ae249": { col: 6, vrow: -1, flexible: true },
    "57c452612459772d2d75e495@57c44b372459772d2b39b8ce": { col: 9, vrow: -1, flexible: true },
    "57cffb3524597763887ef4c0@57cff947245977638e6f2a19": { col: 5, vrow: 1 },
    "57cffe7c24597763133760c7@57cffd8224597763b03fc609": { col: 5, vrow: 1 },
    "57cffe8e245977638e6f2a32@57cffddc24597763133760c6": { col: 5, vrow: 1 },
    "57cffe9f24597763b31685de@57cffe0024597763b03fc60b": { col: 5, vrow: 1 },
    "57cffeb624597763887ef4c9@57cffe20245977632f391a9d": { col: 5, vrow: 1 },
    "57e02a3824597706777d7ec7@57838c962459774a1651ec63": { col: 4, vrow: 1, flexible: true },
    "57ee5b702459771c30246a12@57ee59b42459771c7b045da5": { col: 6, vrow: 1 },
    "57ee5bb22459771c7b046669@57d14d2524597714373db789": { col: 6, vrow: 0 },
    "57f4cc8624597737a2564363@57f4c844245977379d5c14d1": { col: 6, vrow: 0 },
    "57ffa94b245977725b498add@57dc334d245977597164366f": { col: 6, vrow: -1 },
    "57ffad2e24597779f33d0f38@57ffa9f4245977728561e844": { col: 4, vrow: 1 },
    "57ffad5624597779f63b6528@57ffa9f4245977728561e844": { col: 6, vrow: 1 },
    "57ffaeb824597779fd511db1@57ffaea724597779f52b3a4d": { col: 4, vrow: -1 },
    "57ffb5d624597702841ea407@57ffaea724597779f52b3a4d": { col: 4, vrow: 2 },
    "58246acc24597753c0717aa2@57c44dd02459772d2e0ae249": { col: 4, vrow: 1, flexible: true },
    "5888984724597752415de72c@5888976c24597754281f93f5": { col: 6, vrow: 1 },
    "588b56d02459771481110ae4@588b56d02459771481110ae2": { col: 4, vrow: -1 },
    "588b56d02459771481110ae5@588b56d02459771481110ae2": { col: 6, vrow: 1, flexible: true },
    "588b56d02459771481110ae6@588b56d02459771481110ae2": { col: 4, vrow: 1, flexible: true },
    "5894a5b586f77426d259076b@5894a5b586f77426d2590767": { col: 9, vrow: -1 },
    "58a56f0186f774651703584d@5894a5b586f77426d2590767": { col: 5, vrow: -1 },
    "58a56f8d86f774651579314d@58a56f8d86f774651579314c": { col: 5, vrow: 1, flexible: true },
    "58a5761486f7746f8a5389ed@5894a42086f77426d2590762": { col: 5, vrow: 1, flexible: true },
    "58a5c12e86f7745d585a2b9f@58a5c12e86f7745d585a2b9e": { col: 5, vrow: 2, flexible: true },
    "5926c0df86f77462f647f768@5926c0df86f77462f647f764": { col: 9, vrow: -1 },
    "5926dfdc86f7742eb80708a0@5926c0df86f77462f647f764": { col: 8, vrow: -1 },
    "5926f2e086f7745aae644233@5926f2e086f7745aae644231": { col: 9, vrow: -1 },
    "5926f2e086f7745aae644236@5926f2e086f7745aae644231": { col: 8, vrow: -1 },
    "593d209886f7746ccd73e1cf@593d1fa786f7746da62d61ac": { col: 4, vrow: -1 },
    "593d20ca86f7746d946c00e3@593d1fa786f7746da62d61ac": { col: 6, vrow: 1, flexible: true },
    "593d20d786f7746bc72e89fe@593d1fa786f7746da62d61ac": { col: 5, vrow: 1, flexible: true },
    "593d20e586f7746cfb12602d@593d1fa786f7746da62d61ac": { col: 4, vrow: 1, flexible: true },
    "595cf16b86f77427440c32e4@595cf16b86f77427440c32e2": { col: 4, vrow: -1 },
    "595cfa8b86f77427437e845c@595cfa8b86f77427437e845b": { col: 4, vrow: -1 },
    "59c63b8586f7747b2204518a@59c63b4486f7747afb151c1c": { col: 3, vrow: 1, flexible: true },
    "59c63c2686f7747b787c8557@59c63b4486f7747afb151c1c": { col: 5, vrow: 1, flexible: true },
    "59c63cf786f7747afe54e68b@5926d33d86f77410de68ebc0": { col: 4, vrow: 1, flexible: true },
    "59ccfef686f7747ef96eef6c@59ccfdba86f7747f2109a587": { col: 5, vrow: 1 },
    "59d6088586f774275f374832@59d6088586f774275f37482f": { col: 7, vrow: 1 },
    "59e0bf6986f774156f04ce86@595cf16b86f77427440c32e2": { col: 5, vrow: 1, flexible: true },
    "59e0bfb886f7742d48765bd4@595cf16b86f77427440c32e2": { col: 5, vrow: 2, flexible: true },
    "59e0c03b86f774156f04ce87@595cfa8b86f77427437e845b": { col: 5, vrow: 1, flexible: true },
    "59e0c05086f774156f04ce88@595cfa8b86f77427437e845b": { col: 5, vrow: 2, flexible: true },
    "59e6152586f77473dc057aa4@59e6152586f77473dc057aa1": { col: 7, vrow: 1 },
    "59e6687d86f77411d949b254@59e6687d86f77411d949b251": { col: 7, vrow: 1 },
    "59eb7ebe86f7740b373438cf@59eb7ebe86f7740b373438ce": { col: 3, vrow: 1, flexible: true },
    "59eb7ebe86f7740b373438d0@59eb7ebe86f7740b373438ce": { col: 5, vrow: 1, flexible: true },
    "59ff346386f77477562ff5e5@59ff346386f77477562ff5e2": { col: 7, vrow: 1 },
    "5a01b37a86f77450561fda0d@59fb375986f7741b681b81a6": { col: 4, vrow: -1, flexible: true },
    "5a01b38d86f774504b2bebce@59fb375986f7741b681b81a6": { col: 5, vrow: 1, flexible: true },
    "5a01b3ae86f7742a0c7a0244@59fb375986f7741b681b81a6": { col: 5, vrow: 2, flexible: true },
    "5a0ec13bfcdbcb00165aa688@5a0ec13bfcdbcb00165aa685": { col: 7, vrow: 1 },
    "5a329052c4a28200741e22d4@5a329052c4a28200741e22d3": { col: 5, vrow: 1, flexible: true },
    "5a329052c4a28200741e22d5@5a329052c4a28200741e22d3": { col: 4, vrow: -1 },
    "5a69a5648dc32e000d46d1f3@5a69a2ed8dc32e000d46d1f1": { col: 10, vrow: 1, flexible: true },
    "5a954931159bd400160a65a2@5a9548c9159bd400133e97b3": { col: 6, vrow: 1, flexible: true },
    "5a95493e159bd42fda46a392@5a9548c9159bd400133e97b3": { col: 4, vrow: 1, flexible: true },
    "5a96725ba2750c00141e0776@5a957c3fa2750c00137fa5f7": { col: 6, vrow: -1 },
    "5a967268a2750c00321570f7@5a957c3fa2750c00137fa5f7": { col: 6, vrow: 1 },
    "5a967274a2750c00164f6ac4@5a957c3fa2750c00137fa5f7": { col: 4, vrow: 1 },
    "5a967280a2750c00141e0777@5a957c3fa2750c00137fa5f7": { col: 4, vrow: -1 },
    "5a9d5769a2750c00156aad2f@5a9d56c8a2750c0032157146": { col: 5, vrow: 1, flexible: true },
    "5a9d6d34a2750c00141e07de@5a9d6d34a2750c00141e07da": { col: 3, vrow: -1, flexible: true },
    "5a9d6e86a2750c00171b3f7b@5a9d6d21a2750c00137fa649": { col: 4, vrow: -1 },
    "5a9e5f18a2750c003215715c@5a9d6d21a2750c00137fa649": { col: 6, vrow: 1 },
    "5a9fc846a2750c00171b3faa@5a9fc7e6a2750c0032157184": { col: 4, vrow: -1, flexible: true },
    "5ab24fe2e5b5b000173b8b67@5aaf8e43e5b5b00015693246": { col: 7, vrow: -1 },
    "5ab373c810e8910019668c0d@5ab372a310e891001717f0d8": { col: 7, vrow: 1 },
    "5ab3741a10e8910018194499@5ab372a310e891001717f0d8": { col: 8, vrow: -2 },
    "5ab374c310e891001819449a@5ab372a310e891001717f0d8": { col: 7, vrow: -1 },
    "5ab375a710e891001819449b@5ab372a310e891001717f0d8": { col: 6, vrow: -1 },
    "5ab3767710e891001539566d@5ab372a310e891001717f0d8": { col: 6, vrow: 1 },
    "5ab376fd10e89100163d8536@5ab372a310e891001717f0d8": { col: 8, vrow: 2 },
    "5ab377f210e8910018194500@5ab372a310e891001717f0d8": { col: 7, vrow: 2 },
    "5ab37c9710e8910019668c75@5ab372a310e891001717f0d8": { col: 9, vrow: 1 },
    "5ab8e9fcd8ce870019439438@5ab8e9fcd8ce870019439434": { col: 7, vrow: 1 },
    "5abcbc27d8ce8700182eceef@5abcbc27d8ce8700182eceeb": { col: 7, vrow: 1 },
    "5ac4cd105acfc4001633985d@5ac4cd105acfc40016339859": { col: 7, vrow: 1 },
    "5ac66cb05acfc40198510a14@5ac66cb05acfc40198510a10": { col: 7, vrow: 1 },
    "5ac66d2e5acfc43b321d4b57@5ac66d2e5acfc43b321d4b53": { col: 7, vrow: 1 },
    "5ac66d9b5acfc40016339982@5ac66d9b5acfc4001633997a": { col: 9, vrow: -1 },
    "5addbf175acfc408fb13965d@5addbf175acfc408fb13965b": { col: 7, vrow: -1 },
    "5addc0b25acfc4001669f147@5addbfbb5acfc400194dbcf7": { col: 6, vrow: -1 },
    "5addc1045acfc4001669f148@5addbfd15acfc40015621bde": { col: 6, vrow: -1 },
    "5addc8b75acfc400194dbe2a@5addc7005acfc4001669f275": { col: 7, vrow: -1 },
    "5addc93c5acfc4001a5fc634@5addc7005acfc4001669f275": { col: 6, vrow: -1 },
    "5addc9815acfc400194dbe2b@5addc7005acfc4001669f275": { col: 6, vrow: 1, flexible: true },
    "5addca045acfc400194dbe2c@5addc7005acfc4001669f275": { col: 8, vrow: 2, flexible: true },
    "5addca615acfc408fb139820@5addc7005acfc4001669f275": { col: 7, vrow: 1, flexible: true },
    "5ae09cd35acfc400185c2d19@5ae09bff5acfc4001562219d": { col: 7, vrow: -1 },
    "5afd808a5acfc4001946e0ec@5afd7ded5acfc40017541f5e": { col: 7, vrow: 1 },
    "5afeb1b65acfc4771e1bd219@5afd7ded5acfc40017541f5e": { col: 9, vrow: 1 },
    "5b099bb25acfc400186331ea@5b099bb25acfc400186331e8": { col: 8, vrow: -1 },
    "5b0c24385acfc400175427a2@5b099a9d5acfc47a8607efe7": { col: 6, vrow: 1, flexible: true },
    "5b0c24415acfc4001863332e@5b099a9d5acfc47a8607efe7": { col: 4, vrow: 1, flexible: true },
    "5b0c24485acfc47a87735900@5b099a9d5acfc47a8607efe7": { col: 4, vrow: -1 },
    "5b237e945acfc400153af6e1@5b237e425acfc4771e1be0b6": { col: 4, vrow: -1, flexible: true },
    "5b2cfa535acfc432ff4db7a4@5b2cfa535acfc432ff4db7a0": { col: 5, vrow: 1, flexible: true },
    "5b30bc165acfc40016387295@5b30bc165acfc40016387293": { col: 4, vrow: 2, flexible: true },
    "5b30bc165acfc40016387295@5b30bc165acfc40016387293#1": { col: 6, vrow: 2, flexible: true },
    "5b3f7e0d5acfc4704b4a1deb@5ae08f0a5acfc408fb1398a1": { col: 9, vrow: -1 },
    "5b47384386f7744b5d748c61@5b237e425acfc4771e1be0b6": { col: 6, vrow: -1, flexible: true },
    "5b47388e86f774040571ea35@5b237e425acfc4771e1be0b6": { col: 6, vrow: 1, flexible: true },
    "5b47389886f774064a2a33f6@5b237e425acfc4771e1be0b6": { col: 5, vrow: 1, flexible: true },
    "5b7be1ca5acfc400170e2d32@5b7be1ca5acfc400170e2d2f": { col: 4, vrow: -1 },
    "5b7be1ca5acfc400170e2d33@5b7be1ca5acfc400170e2d2f": { col: 4, vrow: 1, flexible: true },
    "5b7be1ca5acfc400170e2d34@5b7be1ca5acfc400170e2d2f": { col: 6, vrow: 1, flexible: true },
    "5b7be1ca5acfc400170e2d35@5b7be1ca5acfc400170e2d2f": { col: 5, vrow: -1 },
    "5b7bea125acfc4001510965f@5b7be1ca5acfc400170e2d2f": { col: 5, vrow: 2, flexible: true },
    "5b7bea4a5acfc400170e2dda@5b7be2345acfc400196d524a": { col: 5, vrow: 1, flexible: true },
    "5b7bea5a5acfc43d10285092@5b7be2345acfc400196d524a": { col: 5, vrow: 2, flexible: true },
    "5b7bea895acfc4001b2475d0@5b7be2345acfc400196d524a": { col: 4, vrow: -1, flexible: true },
    "5b7bea965acfc4001a5c3e1a@5b7be2345acfc400196d524a": { col: 6, vrow: -1, flexible: true },
    "5b7bebc85acfc43bca706668@5b7bebc85acfc43bca706666": { col: 5, vrow: 1 },
    "5b7bebc85acfc43bca706669@5b7bebc85acfc43bca706666": { col: 5, vrow: 2, flexible: true },
    "5b7bebc85acfc43bca70666a@5b7bebc85acfc43bca706666": { col: 4, vrow: 1, flexible: true },
    "5b7bebc85acfc43bca70666b@5b7bebc85acfc43bca706666": { col: 6, vrow: 1, flexible: true },
    "5b7becb35acfc4001876c21b@5b7bebc85acfc43bca706666": { col: 4, vrow: -1 },
    "5b7bedd75acfc43d825283fb@5b7bedd75acfc43d825283f9": { col: 5, vrow: 1 },
    "5b7bedd75acfc43d825283fe@5b7bedd75acfc43d825283f9": { col: 5, vrow: 2, flexible: true },
    "5b7bedd75acfc43d825283ff@5b7bedd75acfc43d825283f9": { col: 4, vrow: -1 },
    "5b7bedd75acfc43d82528400@5b7bedd75acfc43d825283f9": { col: 5, vrow: -1 },
    "5b7bee755acfc400196d5385@5b7bee755acfc400196d5383": { col: 5, vrow: 1, flexible: true },
    "5b7bee755acfc400196d538a@5b7bee755acfc400196d5383": { col: 5, vrow: -1 },
    "5b80116a86f77471817cf19b@5b800e9286f7747a8b04f3ff": { col: 5, vrow: 1 },
    "5b80118a86f7747313089854@5b800e9286f7747a8b04f3ff": { col: 5, vrow: 2, flexible: true },
    "5b80242286f77429445e0b49@5b80242286f77429445e0b47": { col: 5, vrow: 1 },
    "5b80242286f77429445e0b4c@5b80242286f77429445e0b47": { col: 5, vrow: 2, flexible: true },
    "5bb20d53d4351e4502010a6e@5bb20d53d4351e4502010a69": { col: 9, vrow: -1 },
    "5bb20de5d4351e0035629e5c@5bb20de5d4351e0035629e59": { col: 4, vrow: -1 },
    "5bb20df1d4351e00347787d8@5bb20df1d4351e00347787d5": { col: 4, vrow: -1 },
    "5bb20dfcd4351e00334c9e27@5bb20dfcd4351e00334c9e24": { col: 4, vrow: -1 },
    "5bb210f6d4351e00320205da@5bb20de5d4351e0035629e59": { col: 6, vrow: 1, flexible: true },
    "5bb2110fd4351e44f824c182@5bb20de5d4351e0035629e59": { col: 4, vrow: 1, flexible: true },
    "5bb211bbd4351e4502010a8b@5bb20df1d4351e00347787d5": { col: 6, vrow: 1, flexible: true },
    "5bb211c4d4351e00367faf06@5bb20df1d4351e00347787d5": { col: 4, vrow: 1, flexible: true },
    "5bb212bfd4351e00853263ef@5bb20dfcd4351e00334c9e24": { col: 6, vrow: 1, flexible: true },
    "5bb212c5d4351e0034778875@5bb20dfcd4351e00334c9e24": { col: 4, vrow: 1, flexible: true },
    "5bbdb811d4351e45020113c9@5bbdb811d4351e45020113c7": { col: 7, vrow: -2, flexible: true },
    "5bbdbb25d4351e0034778ed6@5bbdb811d4351e45020113c7": { col: 6, vrow: -1, flexible: true },
    "5bbdbb2dd4351e00334caa94@5bbdb811d4351e45020113c7": { col: 8, vrow: -1, flexible: true },
    "5bbde96dd4351e003562b03a@5ae096d95acfc400185c2c81": { col: 9, vrow: 1 },
    "5beecc680db83400196194c6@5beec91a0db834001961942d": { col: 9, vrow: -1 },
    "5beeccbb0db83400196194c7@5beec3e30db8340019619424": { col: 4, vrow: -1 },
    "5bf2a0740db834001961993a@5beec3e30db8340019619424": { col: 5, vrow: -1 },
    "5bf3e03b0db834001d2c4aa0@5bf3e03b0db834001d2c4a9c": { col: 7, vrow: 1 },
    "5bf3e0490db83400196199b3@5bf3e0490db83400196199af": { col: 7, vrow: 1 },
    "5bf3f5b10db834001d2c4aaa@5beec9450db83400970084fd": { col: 9, vrow: -2, flexible: true },
    "5bfd35380db83400232fe5cf@5bfd35380db83400232fe5cc": { col: 9, vrow: 1 },
    "5bfd36290db834001966869d@5bfd36290db834001966869a": { col: 9, vrow: 1 },
    "5bfd36ad0db834001c38ef68@5bfd36ad0db834001c38ef66": { col: 9, vrow: 1 },
    "5bfd37c80db834001d23e845@5bfd37c80db834001d23e842": { col: 9, vrow: 1 },
    "5bfd384c0db834001a6691d6@5bfd384c0db834001a6691d3": { col: 9, vrow: 1 },
    "5bfd4cbe0db834001b7344a2@5bfd4cbe0db834001b73449f": { col: 7, vrow: -1 },
    "5bfd59dc0db834001d23e8e7@5bfd4cd60db834001c38f095": { col: 7, vrow: -1 },
    "5c0103bc0db834001a6698c1@5a329052c4a28200741e22d3": { col: 4, vrow: 1, flexible: true },
    "5c0103d20db834001b734cd0@5a329052c4a28200741e22d3": { col: 5, vrow: -1 },
    "5c0103dc0db834001b734cd1@5a329052c4a28200741e22d3": { col: 6, vrow: 1, flexible: true },
    "5c0103e40db834001c38f747@5a329052c4a28200741e22d3": { col: 7, vrow: -1, flexible: true },
    "5c0103f60db834001d23eec4@5a329052c4a28200741e22d3": { col: 5, vrow: 2, flexible: true },
    "5c013b390db83400232ff0bc@5c0000c00db834001a6697fc": { col: 3, vrow: 0 },
    "5c07ca370db834002a125a87@5926e16e86f7742f5a0f7ecb": { col: 3, vrow: 0 },
    "5c091fb40db834001f274773@5bfeb32b0db834001a6694d9": { col: 6, vrow: 1 },
    "5c0e2f26d174af02a9625119@5c0e2f26d174af02a9625114": { col: 9, vrow: -1 },
    "5c164ec42e2216152006bf75@5ab372a310e891001717f0d8": { col: 6, vrow: -2 },
    "5c164ed52e2216152006bf76@5ab372a310e891001717f0d8": { col: 9, vrow: -2 },
    "5c17664f2e2216398b5a7e40@5c17664f2e2216398b5a7e3c": { col: 5, vrow: 1 },
    "5c17664f2e2216398b5a7e43@5c17664f2e2216398b5a7e3c": { col: 5, vrow: 2, flexible: true },
    "5c3f46b62e221602b66cd67d@55d459824bdc2d892f8b4573": { col: 4, vrow: 1, flexible: true },
    "5c471d672e22164bef5d0784@5c46fbd72e2216398b5a8c9c": { col: 9, vrow: -1 },
    "5c471d722e221602b66cd9b0@5c46fbd72e2216398b5a8c9c": { col: 7, vrow: 1 },
    "5c47256b2e221602b3137e84@5c471c2d2e22164bef5d077f": { col: 7, vrow: -1 },
    "5c48a14f2e2216152006edd9@5c48a14f2e2216152006edd7": { col: 6, vrow: 1, flexible: true },
    "5c48a14f2e2216152006edda@5c48a14f2e2216152006edd7": { col: 5, vrow: 1, flexible: true },
    "5c48a14f2e2216152006eddb@5c48a14f2e2216152006edd7": { col: 7, vrow: 1, flexible: true },
    "5c5954702e2216398b5abdb8@5c59529a2e221602b177d160": { col: 5, vrow: 2, flexible: true },
    "5c5db5f22e2216000e5e47ec@5c5db5f22e2216000e5e47e8": { col: 5, vrow: 1, flexible: true },
    "5c5db63a2e2216000f1b284c@5c5db63a2e2216000f1b284a": { col: 5, vrow: 2 },
    "5c617ab82e2216000e37f5a3@5c617a5f2e2216000f1e81b3": { col: 4, vrow: 1, flexible: true },
    "5c6c2c9c2e2216000f2002e8@5c6c2c9c2e2216000f2002e4": { col: 5, vrow: 2, flexible: true },
    "5c6c2c9c2e2216000f2002eb@5c6c2c9c2e2216000f2002e4": { col: 4, vrow: -1 },
    "5c6d10e82e221601da357b09@5c6d10e82e221601da357b07": { col: 4, vrow: 1, flexible: true },
    "5c6d10e82e221601da357b0a@5c6d10e82e221601da357b07": { col: 6, vrow: 1, flexible: true },
    "5c6d10e82e221601da357b0b@5c6d10e82e221601da357b07": { col: 4, vrow: 2, flexible: true },
    "5c6d10e82e221601da357b0c@5c6d10e82e221601da357b07": { col: 6, vrow: 2, flexible: true },
    "5c6d10e82e221601da357b0d@5c6d10e82e221601da357b07": { col: 5, vrow: 2, flexible: true },
    "5c6d10fa2e221600106f3f2a@5c6d10fa2e221600106f3f23": { col: 4, vrow: -1 },
    "5c6d11072e2216000e69d2e8@5c6d11072e2216000e69d2e4": { col: 5, vrow: 2, flexible: true },
    "5c6d11072e2216000e69d2eb@5c6d11072e2216000e69d2e4": { col: 4, vrow: -1 },
    "5c6d11152e2216000f2003eb@5c6d11152e2216000f2003e7": { col: 5, vrow: 2, flexible: true },
    "5c6d11152e2216000f2003ee@5c6d11152e2216000f2003e7": { col: 4, vrow: -1 },
    "5c6d169c2e2216000f2004ee@5c6d10e82e221601da357b07": { col: 4, vrow: -1 },
    "5c6d5d8b2e221644fc630b3d@5c6d5d8b2e221644fc630b39": { col: 5, vrow: 2, flexible: true },
    "5c6d5d8b2e221644fc630b3f@5c6d5d8b2e221644fc630b39": { col: 4, vrow: -1 },
    "5c78f2492e221600114c9f0a@5c78f2492e221600114c9f04": { col: 4, vrow: -1 },
    "5c78f2612e221600114c9f13@5c78f2612e221600114c9f0d": { col: 4, vrow: -1 },
    "5c78f3aa2e221600106f468c@5c78f2492e221600114c9f04": { col: 1, vrow: 0, flexible: true },
    "5c78f4512e221644fc630e9b@5c78f2612e221600114c9f0d": { col: 1, vrow: 0, flexible: true },
    "5c7904552e221644fc630f9e@5c78f2492e221600114c9f04": { col: 4, vrow: 2, flexible: true },
    "5c79048b2e2216000f200d3b@5c78f2492e221600114c9f04": { col: 6, vrow: 2, flexible: true },
    "5c7905552e221644fc630f9f@5c78f2612e221600114c9f0d": { col: 5, vrow: 2, flexible: true },
    "5c79055f2e221600114ca119@5c78f2612e221600114c9f0d": { col: 4, vrow: 2, flexible: true },
    "5c7905672e221601da35820f@5c78f2612e221600114c9f0d": { col: 6, vrow: 2, flexible: true },
    "5c7905762e22160bc12c5e32@5c78f2492e221600114c9f04": { col: 5, vrow: 2, flexible: true },
    "5c79128e2e221644f31bfb31@5c46fbd72e2216398b5a8c9c": { col: 8, vrow: -1 },
    "5c9a25172e2216000f203151@5c9a25172e2216000f20314e": { col: 4, vrow: -1 },
    "5c9a25172e2216000f203152@5c9a25172e2216000f20314e": { col: 6, vrow: 1, flexible: true },
    "5c9a25172e2216000f203153@5c9a25172e2216000f20314e": { col: 4, vrow: 1, flexible: true },
    "5c9a26332e2216001219ea74@5c9a26332e2216001219ea70": { col: 6, vrow: 1, flexible: true },
    "5c9a26332e2216001219ea75@5c9a26332e2216001219ea70": { col: 4, vrow: 1, flexible: true },
    "5cbda4bfae9215000d50e06d@5cbda392ae92155f3c17c39f": { col: 4, vrow: 1, flexible: true },
    "5cde7afdd7f00c000d36b89f@5cde7afdd7f00c000d36b89d": { col: 5, vrow: 1, flexible: true },
    "5cde7afdd7f00c000d36b8a0@5cde7afdd7f00c000d36b89d": { col: 7, vrow: 1, flexible: true },
    "5cde7afdd7f00c000d36b8a1@5cde7afdd7f00c000d36b89d": { col: 6, vrow: 2 },
    "5cde7dc1d7f00c0010373bdd@5cde739cd7f00c0010373bd3": { col: 9, vrow: 1 },
    "5cde805fd7f00c000f261268@5cde7b43d7f00c000d36b93e": { col: 9, vrow: -1 },
    "5cdeac22d7f00c000f261692@5cdeac22d7f00c000f26168f": { col: 9, vrow: 1 },
    "5cdeae19d7f00c0010373edb@5cdeac22d7f00c000f26168f": { col: 7, vrow: -1 },
    "5cdeae20d7f00c0010373edc@5cdeac22d7f00c000f26168f": { col: 6, vrow: 1 },
    "5cdeae29d7f00c000e7ce171@5cdeac22d7f00c000f26168f": { col: 8, vrow: 2 },
    "5cdeae32d7f00c000f261696@5cdeac22d7f00c000f26168f": { col: 7, vrow: 2 },
    "5cdeae39d7f00c00110a6077@5cdeac22d7f00c000f26168f": { col: 7, vrow: 1 },
    "5cf10c62d7f00c065b4220c0@5bfebc530db834001d23eb65": { col: 9, vrow: -1 },
    "5cf4e3f3d7f00c06595bc7f4@5cf4e3f3d7f00c06595bc7f0": { col: 6, vrow: -1, flexible: true },
    "5cf4e3f3d7f00c06595bc7f5@5cf4e3f3d7f00c06595bc7f0": { col: 4, vrow: -1, flexible: true },
    "5cf4e4c5d7f00c05464b2942@5cf4e3f3d7f00c06595bc7f0": { col: 6, vrow: 1, flexible: true },
    "5cf4e4ced7f00c06595bc7f6@5cf4e3f3d7f00c06595bc7f0": { col: 4, vrow: 1, flexible: true },
    "5cf656f2d7f00c06585fb6ef@5cf656f2d7f00c06585fb6eb": { col: 4, vrow: -1, flexible: true },
    "5cf656f2d7f00c06585fb6f0@5cf656f2d7f00c06585fb6eb": { col: 6, vrow: 1, flexible: true },
    "5cf656f2d7f00c06585fb6f1@5cf656f2d7f00c06585fb6eb": { col: 6, vrow: -1, flexible: true },
    "5d00ede1d7ad1a0940739a78@5d00ede1d7ad1a0940739a76": { col: 5, vrow: 1, flexible: true },
    "5d00ede1d7ad1a0940739a79@5d00ede1d7ad1a0940739a76": { col: 4, vrow: -1 },
    "5d00ede1d7ad1a0940739a7a@5d00ede1d7ad1a0940739a76": { col: 6, vrow: 1, flexible: true },
    "5d00ede1d7ad1a0940739a7b@5d00ede1d7ad1a0940739a76": { col: 4, vrow: 1, flexible: true },
    "5d00ef6dd7ad1a0940739b18@5d00ef6dd7ad1a0940739b16": { col: 5, vrow: 1, flexible: true },
    "5d00ef6dd7ad1a0940739b19@5d00ef6dd7ad1a0940739b16": { col: 4, vrow: -1 },
    "5d00ef6dd7ad1a0940739b1a@5d00ef6dd7ad1a0940739b16": { col: 6, vrow: 1, flexible: true },
    "5d00ef6dd7ad1a0940739b1b@5d00ef6dd7ad1a0940739b16": { col: 4, vrow: 1, flexible: true },
    "5d00ef6dd7ad1a0940739b1e@5d00ef6dd7ad1a0940739b16": { col: 5, vrow: 2, flexible: true },
    "5d010d1cd7ad1a59283b1cea@5d010d1cd7ad1a59283b1ce7": { col: 4, vrow: 1, flexible: true },
    "5d010d1cd7ad1a59283b1ceb@5d010d1cd7ad1a59283b1ce7": { col: 6, vrow: 1, flexible: true },
    "5d010d98d7ad1a0940739c7a@5d010d1cd7ad1a59283b1ce7": { col: 4, vrow: -1, flexible: true },
    "5d010dacd7ad1a6f1b72d2f2@5d010d1cd7ad1a59283b1ce7": { col: 6, vrow: -1, flexible: true },
    "5d0236dad7ad1a0940739d2e@5d0236dad7ad1a0940739d29": { col: 9, vrow: 1 },
    "5d023b5fd7ad1a049d4aa7f4@5d0236dad7ad1a0940739d29": { col: 6, vrow: 1, flexible: true },
    "5d023b65d7ad1a0940739d33@5d0236dad7ad1a0940739d29": { col: 5, vrow: 1, flexible: true },
    "5d023b6cd7ad1a6f1b72d449@5d0236dad7ad1a0940739d29": { col: 7, vrow: 1, flexible: true },
    "5d122e7dd7ad1a07102d6d83@5d122e7bd7ad1a07102d6d7f": { col: 4, vrow: -1 },
    "5d122e7dd7ad1a07102d6d88@5d122e7bd7ad1a07102d6d7f": { col: 4, vrow: 2, flexible: true },
    "5d122e7dd7ad1a07102d6d89@5d122e7bd7ad1a07102d6d7f": { col: 6, vrow: 2, flexible: true },
    "5d123102d7ad1a004e475fed@5d123102d7ad1a004e475fe5": { col: 4, vrow: 2, flexible: true },
    "5d123102d7ad1a004e475fee@5d123102d7ad1a004e475fe5": { col: 6, vrow: 2, flexible: true },
    "5d15ce51d7ad1a1eff619096@5d15ce51d7ad1a1eff619092": { col: 4, vrow: 1, flexible: true },
    "5d19cd97d7ad1a4a992c9f55@5d19cd96d7ad1a4a992c9f52": { col: 4, vrow: 1, flexible: true },
    "5d19cd97d7ad1a4a992c9f56@5d19cd96d7ad1a4a992c9f52": { col: 6, vrow: 1, flexible: true },
    "5d247bbf8abbc305645f3b24@5d15ce51d7ad1a1eff619092": { col: 6, vrow: 1, flexible: true },
    "5d25d1d18abbc305525f09b5@5d25d0ac8abbc3054f3e61f7": { col: 6, vrow: 1 },
    "5d2dcff048f03505c610c3b8@5d15ce51d7ad1a1eff619092": { col: 5, vrow: 2, flexible: true },
    "5d2dd07348f035444e05603c@5d15ce51d7ad1a1eff619092": { col: 4, vrow: -1 },
    "5d2f261548f03576f500e7b9@5d2f261548f03576f500e7b7": { col: 6, vrow: 1 },
    "5d2f261548f03576f500e7ba@5d2f261548f03576f500e7b7": { col: 9, vrow: -1 },
    "5d2f261548f03576f500e7bd@5d2f261548f03576f500e7b7": { col: 8, vrow: -1 },
    "5d4405aaa4b9361e6a4e6bd8@5d4405aaa4b9361e6a4e6bd3": { col: 9, vrow: -1 },
    "5d4405f0a4b9361e6a4e6bdb@5d4405f0a4b9361e6a4e6bd9": { col: 4, vrow: -1 },
    "5d4405f0a4b9361e6a4e6bdd@5d4405f0a4b9361e6a4e6bd9": { col: 4, vrow: 1, flexible: true },
    "5d4405f0a4b9361e6a4e6bde@5d4405f0a4b9361e6a4e6bd9": { col: 4, vrow: 2, flexible: true },
    "5d4405f0a4b9361e6a4e6bdf@5d4405f0a4b9361e6a4e6bd9": { col: 6, vrow: 1, flexible: true },
    "5d4405f0a4b9361e6a4e6be0@5d4405f0a4b9361e6a4e6bd9": { col: 5, vrow: 2, flexible: true },
    "5d444418a4b93677c8374e16@5d4405f0a4b9361e6a4e6bd9": { col: 6, vrow: 2, flexible: true },
    "5d4aab30a4b9365435358c58@5d4aab30a4b9365435358c55": { col: 4, vrow: -1, flexible: true },
    "5d4aab30a4b9365435358c59@5d4aab30a4b9365435358c55": { col: 6, vrow: -1, flexible: true },
    "5d4aab30a4b9365435358c5a@5d4aab30a4b9365435358c55": { col: 6, vrow: 1, flexible: true },
    "5dcbd6b46ec07c0c4347a566@5dcbd6b46ec07c0c4347a564": { col: 6, vrow: 1, flexible: true },
    "5dcbd6b46ec07c0c4347a567@5dcbd6b46ec07c0c4347a564": { col: 5, vrow: 1, flexible: true },
    "5dcbd6b46ec07c0c4347a568@5dcbd6b46ec07c0c4347a564": { col: 7, vrow: 1, flexible: true },
    "5de8e67c4a9f347bc92edbd9@5de8e67c4a9f347bc92edbd7": { col: 8, vrow: -1 },
    "5de8e67c4a9f347bc92edbdc@5de8e67c4a9f347bc92edbd7": { col: 9, vrow: -1 },
    "5de8f237bbaf010b10528a72@5de8f237bbaf010b10528a70": { col: 4, vrow: 0 },
    "5de91a58883dde2175416468@5de8f237bbaf010b10528a70": { col: 5, vrow: 1 },
    "5de91b5db33c0951220c0662@5de8e67c4a9f347bc92edbd7": { col: 6, vrow: 1 },
    "5df25d3bfd6b4e6e2276dc9c@5df25d3bfd6b4e6e2276dc9a": { col: 5, vrow: -1, flexible: true },
    "5df25d3bfd6b4e6e2276dc9d@5df25d3bfd6b4e6e2276dc9a": { col: 6, vrow: -1, flexible: true },
    "5df25d3bfd6b4e6e2276dc9e@5df25d3bfd6b4e6e2276dc9a": { col: 6, vrow: 1, flexible: true },
    "5df388648b6c4240ba265202@5df25d3bfd6b4e6e2276dc9a": { col: 7, vrow: 1 },
    "5df389bdfd6b4e6e2276dcb2@5df35e59c41b2312ea3334d5": { col: 9, vrow: 1 },
    "5df8e4080b92095fd441e599@5df8e4080b92095fd441e594": { col: 9, vrow: -1 },
    "5df916dfbb49d91fb446d6bb@5df916dfbb49d91fb446d6b9": { col: 5, vrow: -1 },
    "5df916dfbb49d91fb446d6bc@5df916dfbb49d91fb446d6b9": { col: 4, vrow: -1 },
    "5df916dfbb49d91fb446d6bd@5df916dfbb49d91fb446d6b9": { col: 4, vrow: 1, flexible: true },
    "5df916dfbb49d91fb446d6be@5df916dfbb49d91fb446d6b9": { col: 5, vrow: 2, flexible: true },
    "5df916dfbb49d91fb446d6c2@5df916dfbb49d91fb446d6b9": { col: 5, vrow: 1, flexible: true },
    "5df916dfbb49d91fb446d6c3@5df916dfbb49d91fb446d6b9": { col: 6, vrow: 1, flexible: true },
    "5dfcd0e547101c39625f66fb@5dfcd0e547101c39625f66f9": { col: 6, vrow: 2, flexible: true },
    "5dfcd0e547101c39625f66fc@5dfcd0e547101c39625f66f9": { col: 8, vrow: 2, flexible: true },
    "5dfcd0e547101c39625f66fd@5dfcd0e547101c39625f66f9": { col: 7, vrow: 3, flexible: true },
    "5dfcd0e547101c39625f6700@5dfcd0e547101c39625f66f9": { col: 4, vrow: -1 },
    "5dfcd0e547101c39625f6701@5dfcd0e547101c39625f66f9": { col: 7, vrow: -1 },
    "5dfcd0e547101c39625f6703@5dfcd0e547101c39625f66f9": { col: 7, vrow: 2, flexible: true },
    "5dfce09d8b6c4240ba2652fe@5dfcd0e547101c39625f66f9": { col: 5, vrow: -1 },
    "5e00907ee9dc277128008b90@5e00903ae9dc277128008b87": { col: 7, vrow: 1 },
    "5e0090f7e9dc277128008b95@5e0090f7e9dc277128008b93": { col: 8, vrow: -1 },
    "5e0090f7e9dc277128008b96@5e0090f7e9dc277128008b93": { col: 9, vrow: -1 },
    "5e0090f7e9dc277128008b97@5e0090f7e9dc277128008b93": { col: 6, vrow: 1 },
    "5e56991336989c75ab4f03fa@5e56991336989c75ab4f03f6": { col: 5, vrow: 2, flexible: true },
    "5e56991336989c75ab4f03fb@5e56991336989c75ab4f03f6": { col: 4, vrow: -1 },
    "5e56a69c36989c75ab4f03ff@5e56991336989c75ab4f03f6": { col: 6, vrow: -1 },
    "5e56a832ca629c5b954f2e33@5e5699df2161e06ac158df6f": { col: 6, vrow: 1, flexible: true },
    "5e56a87f2642e66b0b680160@5e5699df2161e06ac158df6f": { col: 4, vrow: 1, flexible: true },
    "5e56a891c42ea42b0f3915fa@5e5699df2161e06ac158df6f": { col: 4, vrow: -1 },
    "5e56a8992161e06ac158df8f@5e5699df2161e06ac158df6f": { col: 5, vrow: 2, flexible: true },
    "5ea16acdfadf1d18c87b0789@5ea16acdfadf1d18c87b0784": { col: 4, vrow: -1 },
    "5ea16ada09aa976f2e7a51c2@5ea16ada09aa976f2e7a51be": { col: 5, vrow: 2, flexible: true },
    "5ea16ada09aa976f2e7a51c4@5ea16ada09aa976f2e7a51be": { col: 4, vrow: -1 },
    "5efaf417aeb21837e749c7f6@5efaf417aeb21837e749c7f2": { col: 6, vrow: 1, flexible: true },
    "5efaf417aeb21837e749c7f7@5efaf417aeb21837e749c7f2": { col: 5, vrow: 2, flexible: true },
    "5efafe76a2f64932a722aa74@5efaf417aeb21837e749c7f2": { col: 4, vrow: 1, flexible: true },
    "5f2aa49f9b44de6b1b4e68d7@5f2aa49f9b44de6b1b4e68d4": { col: 9, vrow: -1 },
    "5f3299142beb5b0b30768687@5f2aa47a200e2c0ee46efa71": { col: 6, vrow: 1 },
    "5f6331e097199b7db2128dc5@5f6331e097199b7db2128dc2": { col: 6, vrow: -1 },
    "5f6331e097199b7db2128dc7@5f6331e097199b7db2128dc2": { col: 6, vrow: 1, flexible: true },
    "5f6331e097199b7db2128dc8@5f6331e097199b7db2128dc2": { col: 4, vrow: 1, flexible: true },
    "5f6336bbda967c74a42e9934@5f6336bbda967c74a42e9932": { col: 4, vrow: 1, flexible: true },
    "5f6336bbda967c74a42e9935@5f6336bbda967c74a42e9932": { col: 6, vrow: 1, flexible: true },
    "5f6336bbda967c74a42e9939@5f6336bbda967c74a42e9932": { col: 5, vrow: 1, flexible: true },
    "5f6360d3ea26e63a816e4585@5f6331e097199b7db2128dc2": { col: 4, vrow: -1 },
    "5fbb976df9986c4cff3fe5f4@5fbb976df9986c4cff3fe5f2": { col: 7, vrow: 2, flexible: true },
    "5fbcc3e4d6fa9c00c571bb5d@5fbcc3e4d6fa9c00c571bb58": { col: 9, vrow: -1 },
    "5fc235db2770a0045c59c686@5fc235db2770a0045c59c683": { col: 4, vrow: -1 },
    "5fc235db2770a0045c59c688@5fc235db2770a0045c59c683": { col: 5, vrow: 2, flexible: true },
    "5fc278107283c4046c58148e@5fc278107283c4046c581489": { col: 9, vrow: -1 },
    "5fc3f2d5900b1d5091531e60@5fc3f2d5900b1d5091531e57": { col: 7, vrow: 1, flexible: true },
    "5fce176b1f152d4312622bcb@5fc3f2d5900b1d5091531e57": { col: 6, vrow: 1, flexible: true },
    "5fce1777480a9832e737d8a4@5fc3f2d5900b1d5091531e57": { col: 6, vrow: -1, flexible: true },
    "5fd9c705dc911e7ec961c45a@5fbcc3e4d6fa9c00c571bb58": { col: 4, vrow: -1 },
    "602e63fb6335467b0c5ac952@602e63fb6335467b0c5ac94d": { col: 9, vrow: -1 },
    "60339954d62c9b14ed777c09@60339954d62c9b14ed777c06": { col: 8, vrow: 2, flexible: true },
    "6033d3b2af437007501f2b03@60339954d62c9b14ed777c06": { col: 8, vrow: 1, flexible: true },
    "6034e3cb0ddce744014cb874@6034e3cb0ddce744014cb870": { col: 4, vrow: -1 },
    "6034e3d953a60014f970617f@6034e3d953a60014f970617b": { col: 5, vrow: 2, flexible: true },
    "6034e3d953a60014f9706180@6034e3d953a60014f970617b": { col: 4, vrow: -1 },
    "6034e3e20ddce744014cb87c@6034e3e20ddce744014cb878": { col: 5, vrow: 2, flexible: true },
    "6034e3e20ddce744014cb87d@6034e3e20ddce744014cb878": { col: 4, vrow: -1 },
    "606587a88900dc2d9a55b65e@606587a88900dc2d9a55b659": { col: 9, vrow: -1 },
    "6065880c132d4d12c81fd8dc@6065880c132d4d12c81fd8da": { col: 4, vrow: 1, flexible: true },
    "6065880c132d4d12c81fd8dd@6065880c132d4d12c81fd8da": { col: 6, vrow: 1, flexible: true },
    "6065880c132d4d12c81fd8df@6065880c132d4d12c81fd8da": { col: 5, vrow: 1, flexible: true },
    "6065881d1246154cad35d639@6065881d1246154cad35d637": { col: 4, vrow: 1, flexible: true },
    "6065881d1246154cad35d63a@6065881d1246154cad35d637": { col: 6, vrow: 1, flexible: true },
    "6065881d1246154cad35d63b@6065881d1246154cad35d637": { col: 5, vrow: 2, flexible: true },
    "6065881d1246154cad35d63d@6065881d1246154cad35d637": { col: 5, vrow: 1, flexible: true },
    "6093ba3ef2cb2e02a42acfe4@6065880c132d4d12c81fd8da": { col: 4, vrow: -1 },
    "6093bae3b0e443224b421cde@6065881d1246154cad35d637": { col: 4, vrow: -1 },
    "6165adcdd3a39d50044c1211@6165adcdd3a39d50044c120f": { col: 8, vrow: -1 },
    "6165adcdd3a39d50044c1214@6165adcdd3a39d50044c120f": { col: 9, vrow: -1 },
    "6165aeedfaa1272e431521e5@6165aeedfaa1272e431521e3": { col: 8, vrow: -1 },
    "6165aeedfaa1272e431521e8@6165aeedfaa1272e431521e3": { col: 9, vrow: -1 },
    "61703001d92c473c7702149d@61703001d92c473c77021497": { col: 4, vrow: -1 },
    "61703001d92c473c7702149e@61703001d92c473c77021497": { col: 6, vrow: 1, flexible: true },
    "61703001d92c473c7702149f@61703001d92c473c77021497": { col: 4, vrow: 1, flexible: true },
    "61712eae6c780c1e710c9a21@61712eae6c780c1e710c9a1d": { col: 4, vrow: -1 },
    "61712eae6c780c1e710c9a22@61712eae6c780c1e710c9a1d": { col: 6, vrow: 1, flexible: true },
    "61712eae6c780c1e710c9a23@61712eae6c780c1e710c9a1d": { col: 4, vrow: 1, flexible: true },
    "61713a8fd92c473c770214a6@61713a8fd92c473c770214a4": { col: 6, vrow: -1 },
    "61713a8fd92c473c770214a9@61713a8fd92c473c770214a4": { col: 9, vrow: -1 },
    "61816d4ad8e3106d9806c1f7@6165aeedfaa1272e431521e3": { col: 7, vrow: -1 },
    "61816df1d3a39d50044c13a0@61816df1d3a39d50044c139e": { col: 6, vrow: 2, flexible: true },
    "61816e711cb55961fa0fdc77@6165aeedfaa1272e431521e3": { col: 6, vrow: 1 },
    "61816e8a67085e45ef140c43@6165aeedfaa1272e431521e3": { col: 5, vrow: -1 },
    "61816f348004cc50514c3503@61816dfa6ef05c2ce828f1ad": { col: 5, vrow: 3, flexible: true },
    "61816f3f67085e45ef140c44@61816dfa6ef05c2ce828f1ad": { col: 5, vrow: 2, flexible: true },
    "61825bbdfaa1272e431523cc@6165adcdd3a39d50044c120f": { col: 7, vrow: -1 },
    "61825bd5cabb9b7ad90f4fd1@6165adcdd3a39d50044c120f": { col: 6, vrow: 1 },
    "61825bea6ef05c2ce828f1ca@6165adcdd3a39d50044c120f": { col: 5, vrow: -1 },
    "618405198004cc50514c3596@618405198004cc50514c3594": { col: 8, vrow: -1 },
    "618405198004cc50514c3598@618405198004cc50514c3594": { col: 9, vrow: -1, flexible: true },
    "618405198004cc50514c3599@618405198004cc50514c3594": { col: 7, vrow: -1, flexible: true },
    "618405198004cc50514c359b@618405198004cc50514c3594": { col: 6, vrow: 1, flexible: true },
    "618405198004cc50514c359c@618405198004cc50514c3594": { col: 5, vrow: 1, flexible: true },
    "618405198004cc50514c359d@618405198004cc50514c3594": { col: 5, vrow: -1 },
    "618426d96c780c1e710c9ba1@618426d96c780c1e710c9b9f": { col: 8, vrow: -1 },
    "618426d96c780c1e710c9ba3@618426d96c780c1e710c9b9f": { col: 9, vrow: -1, flexible: true },
    "618426d96c780c1e710c9ba4@618426d96c780c1e710c9b9f": { col: 7, vrow: -1, flexible: true },
    "618426d96c780c1e710c9ba6@618426d96c780c1e710c9b9f": { col: 6, vrow: 1, flexible: true },
    "618426d96c780c1e710c9ba7@618426d96c780c1e710c9b9f": { col: 5, vrow: 1, flexible: true },
    "618426d96c780c1e710c9ba8@618426d96c780c1e710c9b9f": { col: 5, vrow: -1 },
    "619502ff6db0f2477964e68a@5fbcc3e4d6fa9c00c571bb58": { col: 5, vrow: -1 },
    "61965d9058ef8c428c287e0f@61965d9058ef8c428c287e0d": { col: 3, vrow: -1, flexible: true },
    "61965d9058ef8c428c287e10@61965d9058ef8c428c287e0d": { col: 3, vrow: 2, flexible: true },
    "619666f4af1f5202c57a952f@619666f4af1f5202c57a952d": { col: 4, vrow: 1, flexible: true },
    "6196683558ef8c428c287e1f@619666f4af1f5202c57a952d": { col: 5, vrow: 2, flexible: true },
    "61966869de3cdf1d2614a8ec@619666f4af1f5202c57a952d": { col: 7, vrow: 1, flexible: true },
    "61966a6fed0429009f544bb7@61965d9058ef8c428c287e0d": { col: 3, vrow: 1, flexible: true },
    "61966e6818a3974e5e742806@61816df1d3a39d50044c139e": { col: 4, vrow: 1, flexible: true },
    "619b5db699fb192e74306653@619b5db699fb192e7430664f": { col: 4, vrow: -1 },
    "61f8d29fd8304f1daf1c0534@61f4012adfc9f01a816adda1": { col: 9, vrow: -1 },
    "61faaaa4236a9954fd4e94df@61faa91878830f069b6b7967": { col: 7, vrow: 1 },
    "622b3c081b89c677a33bcda9@622b3c081b89c677a33bcda6": { col: 7, vrow: -1, flexible: true },
    "622b3d5cf9cfc87d675d2dec@622b3d5cf9cfc87d675d2de9": { col: 9, vrow: -1, flexible: true },
    "622b4b705066e61cac73a756@622b3d5cf9cfc87d675d2de9": { col: 7, vrow: -1, flexible: true },
    "623063e994fc3f7b302a9699@623063e994fc3f7b302a9696": { col: 8, vrow: 2, flexible: true },
    "62307748a0460e5284636a0e@623063e994fc3f7b302a9696": { col: 8, vrow: 1, flexible: true },
    "623167c3be36ef48135b1295@622b3c081b89c677a33bcda6": { col: 7, vrow: -2, flexible: true },
    "623167e6b404d749377721b3@622b3c081b89c677a33bcda6": { col: 9, vrow: -1, flexible: true },
    "623c3c1f37b4b3147035773b@623c3c1f37b4b31470357737": { col: 6, vrow: 1 },
    "623c3c1f37b4b3147035773c@623c3c1f37b4b31470357737": { col: 6, vrow: -1 },
    "623c3c1f37b4b3147035773d@623c3c1f37b4b31470357737": { col: 7, vrow: 1 },
    "623c3cc6f081de3a00443028@623b2e9d11c3296b440d1638": { col: 9, vrow: 1 },
    "62444de49f47004c781903ee@62386b2adf47d66e835094b2": { col: 6, vrow: 1, flexible: true },
    "62444e307ba9d00d6d62b17a@62386b2adf47d66e835094b2": { col: 5, vrow: 1, flexible: true },
    "62444e4fd9d6d1219f41bbca@62386b2adf47d66e835094b2": { col: 7, vrow: 1, flexible: true },
    "62444e8e4b411719ea425cbb@62386b7153757417e93a4e9f": { col: 6, vrow: 1, flexible: true },
    "62444e9f674028188b05279d@62386b7153757417e93a4e9f": { col: 5, vrow: 1, flexible: true },
    "62444eaf4b411719ea425cbc@62386b7153757417e93a4e9f": { col: 7, vrow: 1, flexible: true },
    "62811fbf09427b40ab14e768@62811fbf09427b40ab14e767": { col: 8, vrow: -1 },
    "62811fbf09427b40ab14e76b@62811fbf09427b40ab14e767": { col: 9, vrow: -1 },
    "6281209662cba23f6c4d7a1a@6281209662cba23f6c4d7a19": { col: 5, vrow: -1, flexible: true },
    "6281209662cba23f6c4d7a1b@6281209662cba23f6c4d7a19": { col: 6, vrow: 2, flexible: true },
    "6281209662cba23f6c4d7a1c@6281209662cba23f6c4d7a19": { col: 4, vrow: 1, flexible: true },
    "6281209662cba23f6c4d7a1d@6281209662cba23f6c4d7a19": { col: 5, vrow: 1, flexible: true },
    "628157d3308cb521f87a8fab@6281204f308cb521f87a8f9b": { col: 7, vrow: 1, flexible: true },
    "628157d3308cb521f87a8fac@6281204f308cb521f87a8f9b": { col: 6, vrow: 1, flexible: true },
    "62820f043e69a0418a7cb5f8@628120c21d5df4475f46a337": { col: 4, vrow: -1 },
    "628a83c29179c324ed26950a@628a83c29179c324ed269508": { col: 4, vrow: -1, flexible: true },
    "628a83c29179c324ed26950b@628a83c29179c324ed269508": { col: 6, vrow: 1, flexible: true },
    "628b91a869015a4e1711ed93@628b916469015a4e1711ed8d": { col: 4, vrow: -1 },
    "628b9c0d717774443b15e9f5@628b9be6cff66b70c002b14c": { col: 9, vrow: -1 },
    "62e27a7865f0b1592a49e17c@62e27a7865f0b1592a49e17b": { col: 8, vrow: -1, flexible: true },
    "62e7c79cda5b3b57e805e2cc@62e7c72df68e7a0676050c77": { col: 7, vrow: -1, flexible: true },
    "62e7c8f91cd3fde4d503d694@62e7c8f91cd3fde4d503d690": { col: 8, vrow: -1 },
    "62ebd3075873407ff501deb7@62ebd290c427473eff0baafb": { col: 8, vrow: -1, flexible: true },
    "62ed19f695cc1748c83e65b4@62e15547db1a5c41971c1b5e": { col: 5, vrow: 1, flexible: true },
    "62ed19f695cc1748c83e65b5@62e15547db1a5c41971c1b5e": { col: 5, vrow: -1, flexible: true },
    "630e3a5c984633f1fb0e7c38@62e7c7f3c34ea971710c32fc": { col: 3, vrow: 0, flexible: true },
    "634eff66517ccc8a960fc736@634eff66517ccc8a960fc735": { col: 4, vrow: 0, flexible: true },
    "634eff66517ccc8a960fc737@634eff66517ccc8a960fc735": { col: 5, vrow: -1, flexible: true },
    "634eff66517ccc8a960fc738@634eff66517ccc8a960fc735": { col: 3, vrow: 0, flexible: true },
    "634f02331f9f536910079b52@634f02331f9f536910079b51": { col: 4, vrow: 0, flexible: true },
    "634f02331f9f536910079b53@634f02331f9f536910079b51": { col: 5, vrow: -1, flexible: true },
    "634f02331f9f536910079b54@634f02331f9f536910079b51": { col: 3, vrow: 0, flexible: true },
    "634f04d82e5def262d0b30c7@634f04d82e5def262d0b30c6": { col: 4, vrow: 1, flexible: true },
    "634f04d82e5def262d0b30c8@634f04d82e5def262d0b30c6": { col: 7, vrow: -1 },
    "634f05a21f9f536910079b57@634f05a21f9f536910079b56": { col: 4, vrow: 1, flexible: true },
    "634f05a21f9f536910079b58@634f05a21f9f536910079b56": { col: 7, vrow: -1 },
    "634f0cc8c5a4dae848069204@634f02d7517ccc8a960fc744": { col: 3, vrow: -1 },
    "634f0cddfc6902735b039204@634f036a517ccc8a960fc746": { col: 3, vrow: -1 },
    "6357cd4b6bd1f226843c249f@55d3632e4bdc2d972f8b4569": { col: 6, vrow: 1, flexible: true },
    "637b9c95551ab530cf46d09c@62e14904c2699c0ec93adc47": { col: 9, vrow: 1 },
    "637ba19df7ca6372bf2613d8@637ba19df7ca6372bf2613d7": { col: 5, vrow: -1, flexible: true },
    "637ba19df7ca6372bf2613d9@637ba19df7ca6372bf2613d7": { col: 5, vrow: 1, flexible: true },
    "63888bbd28e5cc32cc09d2b7@63888bbd28e5cc32cc09d2b6": { col: 5, vrow: -1 },
    "63888c3def5ebe45d03b8af7@63888bbd28e5cc32cc09d2b6": { col: 5, vrow: 1, flexible: true },
    "6389f1dfc879ce63f72fc43f@6389f1dfc879ce63f72fc43e": { col: 5, vrow: -1 },
    "6389f1dfc879ce63f72fc440@6389f1dfc879ce63f72fc43e": { col: 5, vrow: 1, flexible: true },
    "6389f220ee7bff07b2652001@6389f1dfc879ce63f72fc43e": { col: 4, vrow: -1 },
    "640b20b46167312ad961caaa@640b20359ab20e15ee445fa9": { col: 4, vrow: -1 },
    "640b21005af8590bd06a21c9@640b20359ab20e15ee445fa9": { col: 5, vrow: 2, flexible: true },
    "64119e5f2085aee50a044bd7@6410758c857473525b08bb77": { col: 6, vrow: -1 },
    "64527a3a7da7133e5a09ca9b@64527a3a7da7133e5a09ca99": { col: 4, vrow: 1, flexible: true },
    "64637076203536ad5600c992@64637076203536ad5600c990": { col: 9, vrow: 1 },
    "6464d89add30e025b10af06a@64637076203536ad5600c990": { col: 4, vrow: 1 },
    "647dd2b8a12ebf96c3031658@647dd2b8a12ebf96c3031655": { col: 6, vrow: 1, flexible: true },
    "647dd2b8a12ebf96c3031659@647dd2b8a12ebf96c3031655": { col: 4, vrow: 1, flexible: true },
    "647dd2b8a12ebf96c303165a@647dd2b8a12ebf96c3031655": { col: 5, vrow: 2, flexible: true },
    "6491c6f6ef312a876705191d@6491c6f6ef312a876705191b": { col: 7, vrow: 1, flexible: true },
    "6491c6f6ef312a876705191e@6491c6f6ef312a876705191b": { col: 6, vrow: -1 },
    "6491c77400a3073ac706d2d6@6491c6f6ef312a876705191b": { col: 5, vrow: 1 },
    "6492d7ff7df7d749100e29db@6492d7847363b8a52206bc52": { col: 10, vrow: -1 },
    "6492d7ff7df7d749100e29dc@6492d7847363b8a52206bc52": { col: 10, vrow: 1, flexible: true },
    "6499849fc93611967b03494c@6499849fc93611967b034949": { col: 7, vrow: 1 },
    "649ec2f3961514b22506b113@649ec2f3961514b22506b111": { col: 9, vrow: -1 },
    "64ca3d3954fc657e230529ce@64ca3d3954fc657e230529cc": { col: 9, vrow: 1 },
    "64ca3d3954fc657e230529d2@64ca3d3954fc657e230529cc": { col: 4, vrow: 1 },
    "6513f8f6e63f29908d0ffabd@6513f1798cb24472490ee331": { col: 9, vrow: 1 },
    "651450ce0e00edc794068378@651450ce0e00edc794068371": { col: 9, vrow: -1, flexible: true },
    "6516b176caa50259d91deb76@6516b129609aaf354b34b3a8": { col: 9, vrow: 2, flexible: true },
    "6529119424cbe3c74a05e5bf@6529119424cbe3c74a05e5bb": { col: 9, vrow: -1 },
    "65293d2817e14363030ad30b@6529119424cbe3c74a05e5bb": { col: 4, vrow: -1 },
    "65434bd790cfac6495197597@651bfe4d1065f87f082e7209": { col: 5, vrow: 1, flexible: true },
    "655cb6b5d680a544f30607fb@655cb6b5d680a544f30607fa": { col: 6, vrow: -1 },
    "6568aa57411da73c10040c8f@6568a6bf2c5fb7afc70bc424": { col: 5, vrow: 1, flexible: true },
    "65ae5046e343f0acc00824dd@65ae4f57e343f0acc00824da": { col: 6, vrow: 1, flexible: true },
    "65f064eec4da400cbb0dc200@65f064eec4da400cbb0dc1fe": { col: 9, vrow: -1 },
    "65fb045261d5829b2d0908ff@65fb023261d5829b2d090755": { col: 9, vrow: 1, flexible: true },
    "65fb045261d5829b2d090900@65fb023261d5829b2d090755": { col: 6, vrow: 2, flexible: true },
    "6601257f1347bc1a5f0f4db7@6601257f1347bc1a5f0f4db6": { col: 9, vrow: 2, flexible: true },
    "66012d003dff5074ed002e30@66012d003dff5074ed002e2c": { col: 7, vrow: 1, flexible: true },
    "66012d003dff5074ed002e31@66012d003dff5074ed002e2c": { col: 5, vrow: 1, flexible: true },
    "66012d64c752a02bbe05e69d@66012d64c752a02bbe05e69b": { col: 7, vrow: 1, flexible: true },
    "66012d64c752a02bbe05e69e@66012d64c752a02bbe05e69b": { col: 5, vrow: 1, flexible: true },
    "6615208aa031cbb5570e346b@6615208aa031cbb5570e346a": { col: 9, vrow: 2, flexible: true },
    "66152153a031cbb5570e3470@66152153a031cbb5570e346f": { col: 9, vrow: 2, flexible: true },
    "661ceb1b9311543c710414a1@661ceb1b9311543c7104149b": { col: 9, vrow: 1, flexible: true },
    "661ceb1b9311543c710414a2@661ceb1b9311543c7104149b": { col: 6, vrow: 2, flexible: true },
    "661cec09b2c6356b4d0c7a3c@661cec09b2c6356b4d0c7a36": { col: 9, vrow: 1, flexible: true },
    "661cec09b2c6356b4d0c7a3d@661cec09b2c6356b4d0c7a36": { col: 6, vrow: 2, flexible: true },
    "661fbe066751ee51930b01f4@661fbe066751ee51930b01f2": { col: 5, vrow: 1, flexible: true },
    "661fbe066751ee51930b01f5@661fbe066751ee51930b01f2": { col: 7, vrow: 1, flexible: true },
    "6644bbb36f8f0a01200c80ba@5d00ede1d7ad1a0940739a76": { col: 5, vrow: 2, flexible: true },
    "668031705014e211b4078047@668031705014e211b4078046": { col: 3, vrow: 0 },
    "6680326874b8f2050c0b9179@6680326874b8f2050c0b9178": { col: 8, vrow: -1 },
    "668e72351f673d509001b996@668e71a8dadf42204c032ce1": { col: 6, vrow: 1, flexible: true },
    "668ea3f68117e4968b0cff4b@668ea3f68117e4968b0cff4a": { col: 5, vrow: 1, flexible: true },
    "668ea3f68117e4968b0cff4c@668ea3f68117e4968b0cff4a": { col: 7, vrow: 1, flexible: true },
    "66992c29b9f31ddda10dd1c6@66992b349950f5f4cd06029f": { col: 7, vrow: 1 },
    "66993149558c59581e03c029@66993149558c59581e03c028": { col: 6, vrow: 1 },
    "66993149558c59581e03c02a@66993149558c59581e03c028": { col: 6, vrow: -1 },
    "6699343357df3e2b4e0a0da8@6698c89bfbc8142e60024b0e": { col: 3, vrow: 0 },
    "66b5eac923415935bb201a6f@5bbdb870d4351e00367fb67d": { col: 7, vrow: 1 },
    "66ffc6ceb7ff397142017c3c@66ffc6ceb7ff397142017c3a": { col: 4, vrow: 1, flexible: true },
    "66ffc6ceb7ff397142017c3e@66ffc6ceb7ff397142017c3a": { col: 5, vrow: 2, flexible: true },
    "66ffc6ceb7ff397142017c3f@66ffc6ceb7ff397142017c3a": { col: 7, vrow: 1, flexible: true },
    "66ffc72082d36dec82030c22@66ffc72082d36dec82030c1f": { col: 4, vrow: 1, flexible: true },
    "66ffc903fe9b382596065306@66ffc903fe9b382596065304": { col: 4, vrow: 1, flexible: true },
    "66ffe8e84358178d2803ae38@66ffe811f5d758d71101e89a": { col: 5, vrow: 2, flexible: true },
    "66ffe9cf6be19fd81e0ef73e@66ffe811f5d758d71101e89a": { col: 7, vrow: 1, flexible: true },
    "66ffe9cf6be19fd81e0ef741@66ffe811f5d758d71101e89a": { col: 4, vrow: 1, flexible: true },
    "66ffea06132225f0fe061397@66ffea06132225f0fe061394": { col: 5, vrow: 2, flexible: true },
    "66ffea06132225f0fe061398@66ffea06132225f0fe061394": { col: 7, vrow: 1, flexible: true },
    "66ffea06132225f0fe06139b@66ffea06132225f0fe061394": { col: 4, vrow: 1, flexible: true },
    "67069c8cee8138ed2f05ad37@67069c8cee8138ed2f05ad34": { col: 7, vrow: -1, flexible: true },
    "67069cbbb29a2cd33803338f@67069cbbb29a2cd33803338c": { col: 7, vrow: -1, flexible: true },
    "67069cf1af4890b09f0006ea@67069cf1af4890b09f0006e8": { col: 4, vrow: 1, flexible: true },
    "67069cf1af4890b09f0006eb@67069cf1af4890b09f0006e8": { col: 6, vrow: 1, flexible: true },
    "67069d02ad91f3a63c0bc2b2@67069d02ad91f3a63c0bc2b0": { col: 4, vrow: 1, flexible: true },
    "67069d02ad91f3a63c0bc2b3@67069d02ad91f3a63c0bc2b0": { col: 6, vrow: 1, flexible: true },
    "67069d8dad91f3a63c0bc2b6@67069d8dad91f3a63c0bc2b4": { col: 5, vrow: 1, flexible: true },
    "67069d8dad91f3a63c0bc2b7@67069d8dad91f3a63c0bc2b4": { col: 7, vrow: 1, flexible: true },
    "67069e8433268297c0021349@67069d8dad91f3a63c0bc2b4": { col: 6, vrow: 2, flexible: true },
    "6706a28474152fb7c209a68c@6565c3ab977bcc2dbb01c2e7": { col: 5, vrow: 1, flexible: true },
    "6706a2c8ee8138ed2f05ad38@65144f546ddb773afa0e35e1": { col: 5, vrow: 1, flexible: true },
    "67110d8d388bded67304ceb7@67110d8d388bded67304ceb4": { col: 7, vrow: -1, flexible: true },
    "67110dd41ad01bb88705347d@67110dd41ad01bb88705347b": { col: 8, vrow: -1, flexible: true },
    "6711130fb9f1b98e3e031ea5@6711107e1ad01bb88705347e": { col: 4, vrow: 1, flexible: true },
    "6711130fb9f1b98e3e031ea6@6711107e1ad01bb88705347e": { col: 6, vrow: 1, flexible: true },
    "6711130fb9f1b98e3e031ea7@6711107e1ad01bb88705347e": { col: 5, vrow: 2, flexible: true },
    "6712676e50ec477b9a07c7da@67069d66af4890b09f0006ec": { col: 6, vrow: 2, flexible: true },
    "6712689074e6b1fb090f9783@67069d66af4890b09f0006ec": { col: 7, vrow: 1, flexible: true },
    "671268e790b082c59d0b3995@67069d66af4890b09f0006ec": { col: 5, vrow: 1, flexible: true },
    "67127198373132f80f03f3ab@5fbc227aa56d053a3543f79e": { col: 5, vrow: 2, flexible: true },
    "67184929740a8154bd0a06a4@652910ef50dc782999054b97": { col: 5, vrow: 2, flexible: true },
    "6718519b2e2eeb98d406f3b6@5df25d3bfd6b4e6e2276dc9a": { col: 5, vrow: 2, flexible: true },
    "6718560654123af679059786@5de655be4a9f347bc92edb88": { col: 7, vrow: 1 },
    "671a66b76824ae343205326c@67110dd41ad01bb88705347b": { col: 9, vrow: -1, flexible: true },
    "671a673171ed251e6d0b456c@67110dd41ad01bb88705347b": { col: 7, vrow: -2, flexible: true },
    "673cb4dbe695740be0047a4c@673cb491280680de5e02ff36": { col: 8, vrow: -1 },
    "673cb51e093e0ea7fd0b8749@673cb51e093e0ea7fd0b8746": { col: 9, vrow: -1 },
    "673cb5d1280680de5e02ff40@673cb5d1280680de5e02ff3b": { col: 4, vrow: -1 },
    "673cb5d1280680de5e02ff42@673cb5d1280680de5e02ff3b": { col: 7, vrow: 1 },
    "673cb670093e0ea7fd0b874d@673cb5d1280680de5e02ff3b": { col: 4, vrow: 1, flexible: true },
    "673cb670093e0ea7fd0b874e@673cb5d1280680de5e02ff3b": { col: 6, vrow: 1, flexible: true },
    "673cb8035f3b8a633105bbf6@673cb5d1280680de5e02ff3b": { col: 5, vrow: 1, flexible: true },
    "67405ef125beb509e8070279@67405ef125beb509e8070276": { col: 7, vrow: 1 },
    "67405ef125beb509e807027d@67405ef125beb509e8070276": { col: 5, vrow: 1, flexible: true },
    "67405fd0812f476fb2020068@67405fd0812f476fb2020066": { col: 4, vrow: -1 },
    "67405fd0812f476fb2020069@67405fd0812f476fb2020066": { col: 7, vrow: 1 },
    "674d6121c09f69dfb201a892@674d6121c09f69dfb201a888": { col: 8, vrow: -1 },
    "674d62317075e056160e017b@674d6121c09f69dfb201a888": { col: 7, vrow: -1 },
    "6752ea4fc79e932ff5003256@67405fd0812f476fb2020066": { col: 5, vrow: 1, flexible: true },
    "676149fbe2cf1419500357f3@676149fbe2cf1419500357ee": { col: 5, vrow: 1, flexible: true },
    "67614a225152c0eaed08ec8a@67614a225152c0eaed08ec86": { col: 5, vrow: 1, flexible: true },
    "676177591f08ed5e8800b7ab@676177591f08ed5e8800b7a9": { col: 6, vrow: -1 },
    "676190eefc26d3500f0e1f86@5c5db63a2e2216000f1b284a": { col: 4, vrow: -1 },
    "6761912dfc26d3500f0e1f87@5c5db6302e2216000e5e47f0": { col: 4, vrow: -1 },
    "6762e8b2b396696c660f24b1@676177df1f08ed5e8800b7ae": { col: 4, vrow: -1, flexible: true },
    "6762e8d0a71e1d60d40cc918@676177df1f08ed5e8800b7ae": { col: 6, vrow: 1, flexible: true },
    "6762f35b088f826fb80a039f@676177591f08ed5e8800b7a9": { col: 5, vrow: -1 },
    "67643b3ee37e3bdde80b7d82@5f2aa46b878ef416f538b567": { col: 5, vrow: 1 },
    "67c5429fac40c364490664fa@67c5429fac40c364490664f8": { col: 5, vrow: 1, flexible: true },
    "67c5429fac40c364490664fb@67c5429fac40c364490664f8": { col: 7, vrow: 1, flexible: true },
    "67c5429fac40c364490664fc@67c5429fac40c364490664f8": { col: 6, vrow: 2, flexible: true },
    "67c542aeb032bbdb530201c8@67c542aeb032bbdb530201c6": { col: 5, vrow: 1, flexible: true },
    "67c542aeb032bbdb530201c9@67c542aeb032bbdb530201c6": { col: 7, vrow: 1, flexible: true },
    "67c542aeb032bbdb530201ca@67c542aeb032bbdb530201c6": { col: 6, vrow: 2, flexible: true },
    "67c542baac40c36449066502@67c542baac40c36449066500": { col: 5, vrow: 1, flexible: true },
    "67c542baac40c36449066503@67c542baac40c36449066500": { col: 7, vrow: 1, flexible: true },
    "67c542baac40c36449066504@67c542baac40c36449066500": { col: 6, vrow: 2, flexible: true },
    "67c542c126265106dd0697ad@67c542c126265106dd0697ab": { col: 7, vrow: 1 },
    "67c6e2a6dfae10466b011826@67c6de3ce39861860909e8e5": { col: 9, vrow: 2 },
    "67c6e37c4734b551ef09e4c6@67c6de3ce39861860909e8e5": { col: 10, vrow: -1 },
    "67caf11f7aefe5249203f52a@67c6de3ce39861860909e8e5": { col: 9, vrow: 1 },
    "67caf38c998d5a0fb809fe76@67c5425e26265106dd0697a7": { col: 9, vrow: -1 },
    "67caf63fc7958c252f0a1297@67c5412bb032bbdb530201ba": { col: 10, vrow: -2 },
    "67ff24b9079850d544096ea8@67ff24b9079850d544096ea6": { col: 5, vrow: 1, flexible: true },
    "67ff24b9079850d544096ea9@67ff24b9079850d544096ea6": { col: 7, vrow: 1, flexible: true },
    "67ff24b9079850d544096eaa@67ff24b9079850d544096ea6": { col: 6, vrow: 2, flexible: true },
    "67ff24c0abb53266190dfc68@67ff24c0abb53266190dfc66": { col: 5, vrow: 1, flexible: true },
    "67ff24c0abb53266190dfc69@67ff24c0abb53266190dfc66": { col: 7, vrow: 1, flexible: true },
    "67ff24c0abb53266190dfc6a@67ff24c0abb53266190dfc66": { col: 6, vrow: 2, flexible: true },
    "67ff26a2abb53266190dfc6e@67ff26a2abb53266190dfc6c": { col: 5, vrow: 1, flexible: true },
    "67ff26a2abb53266190dfc6f@67ff26a2abb53266190dfc6c": { col: 7, vrow: 1, flexible: true },
    "67ff26a2abb53266190dfc70@67ff26a2abb53266190dfc6c": { col: 6, vrow: 2, flexible: true },
    "67ff2780abb53266190dfc72@67c542baac40c36449066500": { col: 6, vrow: -1 },
    "67ff2792ea587611b0080958@67ff2792ea587611b0080956": { col: 5, vrow: 1, flexible: true },
    "67ff2792ea587611b0080959@67ff2792ea587611b0080956": { col: 7, vrow: 1, flexible: true },
    "67ff2792ea587611b008095a@67ff2792ea587611b0080956": { col: 6, vrow: 2, flexible: true },
    "67ff2792ea587611b008095c@67ff2792ea587611b0080956": { col: 6, vrow: -1 },
    "67ff279dea587611b008095f@67ff279dea587611b008095d": { col: 5, vrow: 1, flexible: true },
    "67ff279dea587611b0080960@67ff279dea587611b008095d": { col: 7, vrow: 1, flexible: true },
    "67ff279dea587611b0080961@67ff279dea587611b008095d": { col: 6, vrow: 2, flexible: true },
    "67ff279dea587611b0080963@67ff279dea587611b008095d": { col: 6, vrow: -1 },
    "680f47b20407db2e550c4313@680f47b20407db2e550c4311": { col: 6, vrow: 1, flexible: true },
    "680f47b20407db2e550c4314@680f47b20407db2e550c4311": { col: 7, vrow: 1, flexible: true },
    "680f47b20407db2e550c4315@680f47b20407db2e550c4311": { col: 5, vrow: 1, flexible: true },
    "680f47f58692125dc00a3347@680f47b20407db2e550c4311": { col: 6, vrow: 2, flexible: true },
    "680f52c8be6531f0ce0f0e20@680f47b20407db2e550c4311": { col: 5, vrow: -1, flexible: true },
    "680f55788692125dc00a3356@680f55788692125dc00a3354": { col: 6, vrow: 1, flexible: true },
    "680f55788692125dc00a3357@680f55788692125dc00a3354": { col: 5, vrow: 1, flexible: true },
    "680f55788692125dc00a3358@680f55788692125dc00a3354": { col: 7, vrow: 1, flexible: true },
    "680f55788692125dc00a335b@680f55788692125dc00a3354": { col: 6, vrow: 2, flexible: true },
    "680f55788692125dc00a335c@680f55788692125dc00a3354": { col: 5, vrow: -1, flexible: true },
    "680f55b71e275ac1230f2dc8@680f55b71e275ac1230f2dc6": { col: 6, vrow: 1, flexible: true },
    "680f55b71e275ac1230f2dc9@680f55b71e275ac1230f2dc6": { col: 7, vrow: 1, flexible: true },
    "680f55b71e275ac1230f2dca@680f55b71e275ac1230f2dc6": { col: 5, vrow: 1, flexible: true },
    "680f55b71e275ac1230f2dcd@680f55b71e275ac1230f2dc6": { col: 6, vrow: 2, flexible: true },
    "680f5953b93ecb502102816c@680f5953b93ecb502102816a": { col: 6, vrow: 1, flexible: true },
    "680f5953b93ecb502102816d@680f5953b93ecb502102816a": { col: 5, vrow: 1, flexible: true },
    "680f5953b93ecb502102816e@680f5953b93ecb502102816a": { col: 7, vrow: 1, flexible: true },
    "680f5953b93ecb5021028171@680f5953b93ecb502102816a": { col: 6, vrow: 2, flexible: true },
    "681096b551511048940afedb@681096b551511048940afed9": { col: 6, vrow: 1, flexible: true },
    "681096b551511048940afedc@681096b551511048940afed9": { col: 7, vrow: 1, flexible: true },
    "681096b551511048940afedd@681096b551511048940afed9": { col: 5, vrow: 1, flexible: true },
    "681096b551511048940afee0@681096b551511048940afed9": { col: 6, vrow: 2, flexible: true },
    "681096b551511048940afee1@681096b551511048940afed9": { col: 5, vrow: -1, flexible: true },
    "68109a1f327033533604170c@68109a1f327033533604170a": { col: 6, vrow: 1, flexible: true },
    "68109a1f327033533604170d@68109a1f327033533604170a": { col: 5, vrow: 1, flexible: true },
    "68109a1f327033533604170e@68109a1f327033533604170a": { col: 7, vrow: 1, flexible: true },
    "68109a1f3270335336041711@68109a1f327033533604170a": { col: 6, vrow: 2, flexible: true },
    "68109a1f3270335336041712@68109a1f327033533604170a": { col: 5, vrow: -1, flexible: true },
    "6810a469f6c2827d680d1f4e@6810a469f6c2827d680d1f4c": { col: 6, vrow: 1, flexible: true },
    "6810a469f6c2827d680d1f4f@6810a469f6c2827d680d1f4c": { col: 5, vrow: 1, flexible: true },
    "6810a469f6c2827d680d1f50@6810a469f6c2827d680d1f4c": { col: 7, vrow: 1, flexible: true },
    "6810aa1474bf67765c02e91c@6810aa1474bf67765c02e91a": { col: 6, vrow: 1, flexible: true },
    "6810aa1474bf67765c02e91d@6810aa1474bf67765c02e91a": { col: 5, vrow: 1, flexible: true },
    "6810aa1474bf67765c02e91e@6810aa1474bf67765c02e91a": { col: 7, vrow: 1, flexible: true },
    "6810ca87002deee76b04970d@6810ca87002deee76b04970b": { col: 6, vrow: -1, flexible: true },
    "6810cae8002deee76b04970e@6810ca87002deee76b04970b": { col: 6, vrow: 1, flexible: true },
    "6810d3d8dc7bbeec2f0081cb@6810d3d8dc7bbeec2f0081c9": { col: 6, vrow: -1, flexible: true },
    "6810d3d8dc7bbeec2f0081cc@6810d3d8dc7bbeec2f0081c9": { col: 6, vrow: 1, flexible: true },
    "6811f4854922782caa087446@6811f4854922782caa087440": { col: 5, vrow: 2, flexible: true },
    "68120dcbb90552f01004e5d0@68120dcbb90552f01004e5ca": { col: 5, vrow: 2, flexible: true },
    "6812180dc20f5c52bc04d6d1@6812180dc20f5c52bc04d6cc": { col: 5, vrow: 2, flexible: true },
    "681236df5cbf0518e00557a5@681236df5cbf0518e00557a0": { col: 5, vrow: 2, flexible: true },
    "68235c524adfc065fe06e3ad@682315b0f8d8f8681e0744b0": { col: 5, vrow: 2, flexible: true },
    "68235d107d3ccc3ca20f4d05@682315bdf8d8f8681e0744b5": { col: 5, vrow: 2, flexible: true },
    "68235e0d85791536f5008353@682315c58639961c6001dbe7": { col: 4, vrow: 1 },
    "68235e2285791536f5008354@682315c58639961c6001dbe7": { col: 6, vrow: 1 },
    "68235e2285791536f5008355@682315c58639961c6001dbe7": { col: 5, vrow: 2, flexible: true },
    "68235e3b85791536f5008356@682315c58639961c6001dbe7": { col: 5, vrow: -1 },
    "68235e5e4adfc065fe06e3ae@682315d08639961c6001dbec": { col: 4, vrow: 2, flexible: true },
    "68235e5e4adfc065fe06e3af@682315d08639961c6001dbec": { col: 6, vrow: 2, flexible: true },
    "683062c724bbff0de8013687@683060403b1bb49282023611": { col: 9, vrow: 1 },
    "68306426e4028d6e3f099185@68305fdc84a12bb973021fc0": { col: 5, vrow: -1, flexible: true },
    "68306426e4028d6e3f099186@68305fdc84a12bb973021fc0": { col: 7, vrow: -1, flexible: true },
    "6871284e9a353bb50606f3f1@6871284e9a353bb50606f3ed": { col: 8, vrow: 1, flexible: true },
    "6871284e9a353bb50606f3f5@6871284e9a353bb50606f3ed": { col: 9, vrow: -1, flexible: true },
    "68712a1e505fed5f370b162f@687128c4505fed5f370b1625": { col: 6, vrow: -1, flexible: true },
    "68712a1e505fed5f370b1630@687128c4505fed5f370b1625": { col: 7, vrow: 1, flexible: true },
    "68712a1e505fed5f370b1631@687128c4505fed5f370b1625": { col: 3, vrow: 0, flexible: true },
    "68712bd4251b8d4c6c04ec1d@68712bd4251b8d4c6c04ec19": { col: 7, vrow: -1 },
    "688b7ac6063fe8db180ab1e0@688b79b5eb234c75d900e050": { col: 6, vrow: -1 },
    "688b7ac6063fe8db180ab1e2@688b79b5eb234c75d900e050": { col: 7, vrow: 1 },
    "688c86420e99e554a90c0fd8@688c86420e99e554a90c0fd6": { col: 6, vrow: 1, flexible: true },
    "689166b6c2d6fa42e704475a@689166b6c2d6fa42e7044756": { col: 7, vrow: 1 },
    "689167248f19dbc8190728f0@689167248f19dbc8190728ed": { col: 9, vrow: -1 },
    "68916765fa628c6b9f0ed6f8@68916765fa628c6b9f0ed6f6": { col: 9, vrow: -2, flexible: true },
    "6895bd19d55f0ebf6a0c0308@6895bd19d55f0ebf6a0c0306": { col: 4, vrow: -1 },
    "6895bd19d55f0ebf6a0c030d@6895bd19d55f0ebf6a0c0306": { col: 5, vrow: 2, flexible: true },
    "6895becad55f0ebf6a0c0316@6895becad55f0ebf6a0c0311": { col: 9, vrow: -1 },
    "68a5dc0c2cd64a8b58023b89@68a5dc0c2cd64a8b58023b87": { col: 4, vrow: -1 },
    "68a5dc4eed35a7eac1048ff8@68a5dc4eed35a7eac1048ff6": { col: 4, vrow: 1, flexible: true },
    "68a5dc4eed35a7eac1048ff9@68a5dc4eed35a7eac1048ff6": { col: 6, vrow: 1, flexible: true },
    "68a5dc4eed35a7eac1048ffa@68a5dc4eed35a7eac1048ff6": { col: 5, vrow: -1, flexible: true },
    "68a63ac58e1fe612970728f6@68a63ac58e1fe612970728f2": { col: 6, vrow: 1 },
    "68a63cdac92ee33ffa01bf61@68a63cdac92ee33ffa01bf5f": { col: 4, vrow: -1 },
    "68a63cdac92ee33ffa01bf62@68a63cdac92ee33ffa01bf5f": { col: 6, vrow: 1, flexible: true },
    "68a63cdac92ee33ffa01bf63@68a63cdac92ee33ffa01bf5f": { col: 4, vrow: 1, flexible: true },
    "68a6e8fd4ac5b037cb0e9b8d@68a6e8fd4ac5b037cb0e9b86": { col: 5, vrow: 3, flexible: true },
    "68a6f3b27279296357007cd9@68a6f3b27279296357007cd7": { col: 4, vrow: 1, flexible: true },
    "68a6f3b27279296357007cda@68a6f3b27279296357007cd7": { col: 6, vrow: 1, flexible: true },
    "68a6f3b27279296357007cdb@68a6f3b27279296357007cd7": { col: 5, vrow: -1, flexible: true },
    "68a6fbb07279296357007ce4@68a6fbb07279296357007ce2": { col: 4, vrow: 1, flexible: true },
    "68a6fbb07279296357007ce5@68a6fbb07279296357007ce2": { col: 6, vrow: 1, flexible: true },
    "68a6fbb07279296357007ce6@68a6fbb07279296357007ce2": { col: 5, vrow: -1, flexible: true },
    "68a6fbfdd31595bb360c73bf@68a6fbfdd31595bb360c73bd": { col: 4, vrow: 1, flexible: true },
    "68a6fbfdd31595bb360c73c0@68a6fbfdd31595bb360c73bd": { col: 6, vrow: 1, flexible: true },
    "68a6fbfdd31595bb360c73c1@68a6fbfdd31595bb360c73bd": { col: 5, vrow: -1, flexible: true },
    "68a6ff732885e0bbd30bb6fc@68a6ff732885e0bbd30bb6f9": { col: 5, vrow: 3, flexible: true },
    "68a6ff952885e0bbd30bb700@68a6ff952885e0bbd30bb6fd": { col: 5, vrow: 3, flexible: true },
    "68a6fff085a17dc1cb008068@68a6fff085a17dc1cb008066": { col: 4, vrow: -1 },
    "68a7000d7708ac5120060529@68a7000d7708ac5120060527": { col: 4, vrow: -1 },
    "68aee764130c00663d08aeaf@68aee763130c00663d08aea8": { col: 8, vrow: -1 },
    "68aee764130c00663d08aeb0@68aee763130c00663d08aea8": { col: 7, vrow: 1 },
    "68aee764130c00663d08aeb2@68aee763130c00663d08aea8": { col: 7, vrow: -1 },
    "68aee8f8130c00663d08aeb5@68aee8f8130c00663d08aeb3": { col: 6, vrow: -1 },
    "68aee959e90403b3820d2556@68aee8f8130c00663d08aeb3": { col: 9, vrow: -1 },
    "68aee9fe130c00663d08aebc@68aee9fe130c00663d08aeb6": { col: 4, vrow: -1 },
    "68aeeb10130c00663d08aebd@68aee9fe130c00663d08aeb6": { col: 5, vrow: -1 },
    "68b320078152a172050ebd70@68aee9fe130c00663d08aeb6": { col: 3, vrow: 1 },
    "68b966e44b7f808d5609ac07@68b966e44b7f808d5609ac04": { col: 9, vrow: 1 },
    "68b967682d4272049d099227@68b966e44b7f808d5609ac04": { col: 7, vrow: -1 },
    "68bff6b5d84c26d6bf0c6b77@688c86420e99e554a90c0fd6": { col: 4, vrow: 1, flexible: true },
    "68c16e84fc90c174e50de1ad@68c16e84fc90c174e50de1a8": { col: 9, vrow: -1 },
    "68c170e383e2d814b0093f89@68c170e383e2d814b0093f87": { col: 4, vrow: 1, flexible: true },
    "68c170e383e2d814b0093f8a@68c170e383e2d814b0093f87": { col: 6, vrow: 1, flexible: true },
    "68c170e383e2d814b0093f8b@68c170e383e2d814b0093f87": { col: 5, vrow: 2, flexible: true },
    "68c170e383e2d814b0093f8d@68c170e383e2d814b0093f87": { col: 4, vrow: -1 },
    "68c294360f5ebd68290d6c1b@68c294360f5ebd68290d6c16": { col: 9, vrow: -1 },
    "68c2989dc9061bb2f50478fc@68c2989dc9061bb2f50478f6": { col: 4, vrow: -1 },
    "68caac28f42a4476cf0be2af@68caac28f42a4476cf0be2ac": { col: 6, vrow: 1, flexible: true },
    "68caac28f42a4476cf0be2b0@68caac28f42a4476cf0be2ac": { col: 4, vrow: 1, flexible: true },
    "68caac360bfe742288085e18@68caac360bfe742288085e16": { col: 4, vrow: -1 },
    "68caac360bfe742288085e19@68caac360bfe742288085e16": { col: 6, vrow: 1, flexible: true },
    "68caac360bfe742288085e1a@68caac360bfe742288085e16": { col: 4, vrow: 1, flexible: true },
    "68caac500bfe742288085e20@68caac500bfe742288085e1e": { col: 1, vrow: 0, flexible: true },
    "68cac5c11ac9a04bef08f4f1@68caac500bfe742288085e1e": { col: 2, vrow: 1 },
    "68cac8e69139682309011d10@68caac360bfe742288085e16": { col: 5, vrow: 2, flexible: true },
    "68cada38bda9c1a99f054d6b@68caac28f42a4476cf0be2ac": { col: 5, vrow: 2, flexible: true },
    "68cc2ae66e59cb54f4054f49@68cc2ae66e59cb54f4054f47": { col: 6, vrow: 1, flexible: true },
    "68cc2ae66e59cb54f4054f4a@68cc2ae66e59cb54f4054f47": { col: 4, vrow: 1, flexible: true },
    "68cc2ae66e59cb54f4054f4d@68cc2ae66e59cb54f4054f47": { col: 5, vrow: 2, flexible: true },
    "68d5676f43adc7372a0c8ae5@68d5676f43adc7372a0c8ae0": { col: 4, vrow: -1 },
    "68d5676f43adc7372a0c8ae6@68d5676f43adc7372a0c8ae0": { col: 5, vrow: -1 },
    "68d5676f43adc7372a0c8ae8@68d5676f43adc7372a0c8ae0": { col: 3, vrow: 1 },
    "6932ac58be542622170428af@6932ac58be542622170428aa": { col: 9, vrow: -1 },
    "6932aec6cccd2b808a043858@6932aec6cccd2b808a043856": { col: 4, vrow: -1 },
    "6932aec6cccd2b808a043859@6932aec6cccd2b808a043856": { col: 6, vrow: 1, flexible: true },
    "6932aec6cccd2b808a04385a@6932aec6cccd2b808a043856": { col: 4, vrow: 1, flexible: true },
    "6932aed9be542622170428b2@6932aed9be542622170428b0": { col: 4, vrow: 1, flexible: true },
    "6932aed9be542622170428b3@6932aed9be542622170428b0": { col: 6, vrow: 1, flexible: true },
    "6932aed9be542622170428b4@6932aed9be542622170428b0": { col: 4, vrow: -1 },
    "6932aed9be542622170428b7@6932aed9be542622170428b0": { col: 6, vrow: 2, flexible: true },
    "6932aed9be542622170428b8@6932aed9be542622170428b0": { col: 4, vrow: 2, flexible: true },
    "6932e4a33467465673019fca@6932aed9be542622170428b0": { col: 5, vrow: 1, flexible: true },
    "6932e4caa62147e1fe0c65b6@6932aed9be542622170428b0": { col: 5, vrow: 2, flexible: true },
    "6932e8a016ead46c44078bf5@6932aec6cccd2b808a043856": { col: 5, vrow: 1, flexible: true },
    "6932e8d13467465673019fcb@6932aec6cccd2b808a043856": { col: 5, vrow: 2, flexible: true },
    "6936bd64b2b5b688e50cde38@6936bd64b2b5b688e50cde36": { col: 4, vrow: -1 },
    "6936bd64b2b5b688e50cde39@6936bd64b2b5b688e50cde36": { col: 6, vrow: 1, flexible: true },
    "6936bd64b2b5b688e50cde3a@6936bd64b2b5b688e50cde36": { col: 4, vrow: 1, flexible: true },
    "6936bd64b2b5b688e50cde3c@6936bd64b2b5b688e50cde36": { col: 5, vrow: 1, flexible: true },
    "6936bd64b2b5b688e50cde3d@6936bd64b2b5b688e50cde36": { col: 5, vrow: 2, flexible: true },
    "6936bd6f4737190b66053ba8@6936bd6f4737190b66053ba6": { col: 4, vrow: 1, flexible: true },
    "6936bd6f4737190b66053ba9@6936bd6f4737190b66053ba6": { col: 6, vrow: 1, flexible: true },
    "6936bd6f4737190b66053baa@6936bd6f4737190b66053ba6": { col: 4, vrow: -1 },
    "6936bd6f4737190b66053bad@6936bd6f4737190b66053ba6": { col: 4, vrow: 2, flexible: true },
    "6936bd6f4737190b66053bae@6936bd6f4737190b66053ba6": { col: 6, vrow: 2, flexible: true },
    "6936bd6f4737190b66053baf@6936bd6f4737190b66053ba6": { col: 5, vrow: 1, flexible: true },
    "6936bd6f4737190b66053bb0@6936bd6f4737190b66053ba6": { col: 5, vrow: 2, flexible: true },
    "6936bde84737190b66053bb3@6936bde84737190b66053bb1": { col: 1, vrow: 0, flexible: true },
    "560d3fda4bdc2d20478b457d@55d48ebc4bdc2d8c2f8b456c": { col: 6, vrow: -1, flexible: true },
    "560d3fe34bdc2de22e8b457c@55d48ebc4bdc2d8c2f8b456c": { col: 4, vrow: -1, flexible: true },
    "560d493e4bdc2d26448b4577@55d45f484bdc2d972f8b456d": { col: 7, vrow: 1, flexible: true },
    "560d49504bdc2dcc4c8b4598@55d45f484bdc2d972f8b456d": { col: 5, vrow: 1, flexible: true },
    "56d5a80ed2720bd5418b456a@56d5a407d2720bb3418b456b": { col: 9, vrow: -1 },
    "56d5a81cd2720bdc418b456a@56d5a407d2720bb3418b456b": { col: 5, vrow: -1, flexible: true },
    "56def3c2d2720bd4328b456a@56d59856d2720bd8418b456a": { col: 7, vrow: 1, flexible: true },
    "571a29612459771fd90bb671@571a279b24597720b4066566": { col: 4, vrow: 0, flexible: true },
    "576a59ce2459771e7c64ef24@576a581d2459771e7b1bc4f1": { col: 7, vrow: 1, flexible: true },
    "5792111024597773c72397b5@54491c4f4bdc2db1078b4568": { col: 5, vrow: -1 },
    "58172a6d24597714a658fe64@56dee2bdd2720bc8328b4567": { col: 5, vrow: -1 },
    "582729a52459774a8d5eb0b8@5827272a24597748c74bdeea": { col: 4, vrow: -1, flexible: true },
    "582729b52459774abc128d33@5827272a24597748c74bdeea": { col: 6, vrow: 1, flexible: true },
    "582729c624597749585f70e9@5827272a24597748c74bdeea": { col: 4, vrow: 1, flexible: true },
    "58272b392459774b4c7b3cd0@58272b392459774b4c7b3ccd": { col: 4, vrow: -1, flexible: true },
    "58272b392459774b4c7b3cd1@58272b392459774b4c7b3ccd": { col: 6, vrow: 1, flexible: true },
    "58272b392459774b4c7b3cd2@58272b392459774b4c7b3ccd": { col: 4, vrow: 1, flexible: true },
    "59f98b4986f7746f546d2cf0@59f98b4986f7746f546d2cef": { col: 7, vrow: 1, flexible: true },
    "5a27b35cc4a28232996e3c73@5a27b281c4a28200741e1e52": { col: 6, vrow: 0, flexible: true },
    "5a27b419c4a282000a519dca@5a27b3d0c4a282000d721ec1": { col: 5, vrow: 0, flexible: true },
    "5a27bad7c4a282000b15184c@5a27bad7c4a282000b15184b": { col: 6, vrow: 1, flexible: true },
    "5a27bad7c4a282000b15184d@5a27bad7c4a282000b15184b": { col: 6, vrow: 0, flexible: true },
    "5a27bb70c4a28232996e3c76@5a27bad7c4a282000b15184b": { col: 8, vrow: 2, flexible: true },
    "5a27bb79c4a282000e496f7b@5a27bad7c4a282000b15184b": { col: 7, vrow: -1, flexible: true },
    "5a38f000c4a2826c6e06d7a5@5a38ef1fc4a282000b1521f6": { col: 9, vrow: 1 },
    "5a6b5b8a8dc32e001207faf4@5a6b5b8a8dc32e001207faf3": { col: 3, vrow: 0, flexible: true },
    "5a6b5e468dc32e001207faf6@5a6b5e468dc32e001207faf5": { col: 3, vrow: 0, flexible: true },
    "5a6b5ed88dc32e000c52ec87@5a6b5ed88dc32e000c52ec86": { col: 3, vrow: 0, flexible: true },
    "5a6f5e048dc32e00094b97db@5a6f5e048dc32e00094b97da": { col: 9, vrow: -1, flexible: true },
    "5a6f5f078dc32e00094b97de@5a6f5f078dc32e00094b97dd": { col: 9, vrow: -1 },
    "5a702d198dc32e000b452fc4@5a702d198dc32e000b452fc3": { col: 9, vrow: -1 },
    "5a7033908dc32e000a311393@5a7033908dc32e000a311392": { col: 9, vrow: -1 },
    "5a71e22f8dc32e00094b97f5@5a71e22f8dc32e00094b97f4": { col: 9, vrow: -1 },
    "5a71e41e8dc32e5a9c28b505@5a71e22f8dc32e00094b97f4": { col: 6, vrow: -1, flexible: true },
    "5a71e4f48dc32e001207fb27@5a71e4f48dc32e001207fb26": { col: 9, vrow: -1, flexible: true },
    "5a71e4f48dc32e001207fb29@5a71e4f48dc32e001207fb26": { col: 6, vrow: -1, flexible: true },
    "5a7828548dc32e5a9c28b519@5a7828548dc32e5a9c28b516": { col: 7, vrow: 1 },
    "5a78891dc5856700160166b9@5a788031c585673f2b5c1c79": { col: 7, vrow: -1, flexible: true },
    "5a788c3bc5856700177b0baa@5a788031c585673f2b5c1c79": { col: 5, vrow: -1, flexible: true },
    "5a789338c5856700137e6785@5a789261c5856700186c65d3": { col: 4, vrow: 1, flexible: true },
    "5a789345c58567001601718f@5a789261c5856700186c65d3": { col: 5, vrow: 2, flexible: true },
    "5a7898b7c585673f2b5c3cb8@5a787f7ac5856700177af660": { col: 5, vrow: 1 },
    "5a7ad4af51dfba0013379719@5a7ad4af51dfba0013379717": { col: 7, vrow: -1, flexible: true },
    "5a7ae0c351dfba0017554316@5a7ae0c351dfba0017554310": { col: 7, vrow: 1, flexible: true },
    "5a7afa25e899ef00135e31b2@5a7afa25e899ef00135e31b0": { col: 9, vrow: -1 },
    "5a7b4900e899ef197b331a2c@5a7b4900e899ef197b331a2a": { col: 7, vrow: -1, flexible: true },
    "5a7b4d2ce899ef0016170fbd@5a71e4f48dc32e001207fb26": { col: 4, vrow: 0, flexible: true },
    "5a9685b1a2750c0032157106@5a9685b1a2750c0032157104": { col: 9, vrow: -1 },
    "5aa66cabe5b5b055d0630d82@5aa66c72e5b5b00016327c93": { col: 7, vrow: -2, flexible: true },
    "5aa66cb7e5b5b0214e506e99@5aa66c72e5b5b00016327c93": { col: 5, vrow: -2, flexible: true },
    "5b1fa9b25acfc40018633c07@5b1fa9b25acfc40018633c01": { col: 7, vrow: 1 },
    "5b1faa0f5acfc40dc528aeb7@5b1faa0f5acfc40dc528aeb5": { col: 9, vrow: -1 },
    "5b2389515acfc4771e1be0c3@5b2389515acfc4771e1be0c0": { col: 7, vrow: -2, flexible: true },
    "5b238b355acfc47a8607fa82@5b2389515acfc4771e1be0c0": { col: 5, vrow: -2, flexible: true },
    "5b3642985acfc40017548632@5b363dea5acfc4771e1c5e7e": { col: 3, vrow: 0 },
    "5b3642db5acfc400153b766a@5b363e1b5acfc4771e1c5e80": { col: 3, vrow: 0, flexible: true },
    "5b3a08b25acfc4001754880e@5b3a08b25acfc4001754880c": { col: 7, vrow: -1, flexible: true },
    "5b7d2ae05acfc4001a5c401d@5a788068c5856700137e4c8f": { col: 5, vrow: -1, flexible: true },
    "5b7d2ae95acfc43d102853db@5a788068c5856700137e4c8f": { col: 7, vrow: -1, flexible: true },
    "5ba26c69d4351e00334c9483@5ba26383d4351e00334c93d9": { col: 5, vrow: 1, flexible: true },
    "5ba26c73d4351e0034777fa2@5ba26383d4351e00334c93d9": { col: 6, vrow: 1, flexible: true },
    "5ba26eaad4351e0034777fb6@5ba26acdd4351e003562908e": { col: 5, vrow: 0, flexible: true },
    "5bd70322209c4d00d7167b97@5bd70322209c4d00d7167b8f": { col: 6, vrow: 1, flexible: true },
    "5bd70322209c4d00d7167b98@5bd70322209c4d00d7167b8f": { col: 5, vrow: 1, flexible: true },
    "5bfe88ca0db834001808a11f@5bfe7fb30db8340018089fed": { col: 9, vrow: 1 },
    "5bffe7c50db834001d23ece3@5bffe7c50db834001d23ece1": { col: 9, vrow: -1 },
    "5bffe7c50db834001d23ece4@5bffe7c50db834001d23ece1": { col: 5, vrow: -1, flexible: true },
    "5c0009510db8340019669081@5c0009510db834001966907f": { col: 9, vrow: -1 },
    "5c0009510db8340019669082@5c0009510db834001966907f": { col: 5, vrow: -1, flexible: true },
    "5c010a700db834001d23ef5f@5c010a700db834001d23ef5d": { col: 9, vrow: -1 },
    "5c010a700db834001d23ef60@5c010a700db834001d23ef5d": { col: 5, vrow: -1, flexible: true },
    "5c0113620db83400232feed5@5c0111ab0db834001966914d": { col: 3, vrow: 0 },
    "5c0125fc0db834001a669aa5@5c0125fc0db834001a669aa3": { col: 9, vrow: -1 },
    "5c0125fc0db834001a669aa6@5c0125fc0db834001a669aa3": { col: 5, vrow: -1, flexible: true },
    "5c07a00c0db834001966a79e@5b3b713c5acfc4330140bd8d": { col: 7, vrow: 1 },
    "5cadc190ae921500103bb3bc@5cadc190ae921500103bb3b6": { col: 7, vrow: 1, flexible: true },
    "5cadc55cae921500103bb3c0@5cadc55cae921500103bb3be": { col: 9, vrow: -1 },
    "5cadc55cae921500103bb3c1@5cadc55cae921500103bb3be": { col: 5, vrow: -1 },
    "5cadfbf7ae92152ac412eef4@5cadfbf7ae92152ac412eeef": { col: 6, vrow: 0 },
    "5caf1bc1ae921576eb05cc77@5cadfbf7ae92152ac412eeef": { col: 6, vrow: -1 },
    "5caf1bd5ae9215755f417da1@5cadfbf7ae92152ac412eeef": { col: 7, vrow: 1 },
    "5cc087c9ae921547db318b9c@5cadfbf7ae92152ac412eeef": { col: 7, vrow: 2, flexible: true },
    "5cc087d0ae921500dc1fc310@5cadfbf7ae92152ac412eeef": { col: 6, vrow: 1, flexible: true },
    "5cc701aae4a949000e1ea45e@5cc701aae4a949000e1ea45c": { col: 5, vrow: 0 },
    "5cc837bed7f00c00117917f9@5cc82d76e24e8d00134b4b83": { col: 7, vrow: -1, flexible: true },
    "5cc837cbd7f00c0012066ad2@5cc82d76e24e8d00134b4b83": { col: 6, vrow: 0 },
    "5cc837ded7f00c000d3a6b59@5cc82d76e24e8d00134b4b83": { col: 7, vrow: 1 },
    "5cc8397ed7f00c000e257553@5cc700ede4a949033c734315": { col: 8, vrow: -1, flexible: true },
    "5cc8398ad7f00c000d3a6b5c@5cc700ede4a949033c734315": { col: 6, vrow: -1, flexible: true },
    "5cc83ac0d7f00c000e257554@5cc70102e4a949035e43ba74": { col: 6, vrow: -1, flexible: true },
    "5cc83acbd7f00c000f5f5eda@5cc70102e4a949035e43ba74": { col: 8, vrow: -1, flexible: true },
    "5cc83b50d7f00c000e257555@5cc7015ae4a949001152b4c6": { col: 6, vrow: -2, flexible: true },
    "5cc83b5dd7f00c000f5f5edb@5cc7015ae4a949001152b4c6": { col: 8, vrow: -2, flexible: true },
    "5cebed52d7f00c065a5ab311@5cc82796e24e8d000f5859a8": { col: 5, vrow: 1 },
    "5cf7acfcd7f00c1084477cf5@5cf7acfcd7f00c1084477cf2": { col: 8, vrow: -1, flexible: true },
    "5cf7acfcd7f00c1084477cf6@5cf7acfcd7f00c1084477cf2": { col: 6, vrow: -1, flexible: true },
    "5d3eb3b0a4b93615055e84d8@5d3eb3b0a4b93615055e84d2": { col: 7, vrow: 1 },
    "5d3eb44aa4b93650d64e497b@5d3eb44aa4b93650d64e4979": { col: 9, vrow: -1 },
    "5d3eb44aa4b93650d64e497c@5d3eb44aa4b93650d64e4979": { col: 5, vrow: -1 },
    "5d67abc1a4b93614ec501384@5d67abc1a4b93614ec50137f": { col: 7, vrow: 1 },
    "5dfe1e7859400025ea5150b2@560835c74bdc2dc8488b456f": { col: 7, vrow: -1 },
    "5dfe4008fca8e055d15b75ac@560836b64bdc2d57468b4567": { col: 7, vrow: -1 },
    "5dfe4036b33c0951220c0912@55d449444bdc2d962f8b456d": { col: 7, vrow: -1 },
    "5dfe4057e9dc277128008b42@560837154bdc2da74d8b4568": { col: 7, vrow: -1 },
    "5dfe407ab33c0951220c0913@560837544bdc2de22e8b456e": { col: 7, vrow: -1 },
    "5dfe40b6fca8e055d15b75ad@5608379a4bdc2d26448b4569": { col: 7, vrow: -1 },
    "5dfe40fefca8e055d15b75ae@588200af24597742fa221dfb": { col: 7, vrow: -1 },
    "5dfe411973d8eb11426f59b2@588200c224597743990da9ed": { col: 7, vrow: -1 },
    "5dfe4131f0dd306e765a2e38@588200cf2459774414733d55": { col: 7, vrow: -1 },
    "5dfe4173a3651922b360bf8c@56deec93d2720bec348b4568": { col: 7, vrow: -1 },
    "5e81c3cbac2bb513793cdc77@5e81c3cbac2bb513793cdc75": { col: 5, vrow: 0 },
    "5e81c3cbac2bb513793cdc7a@5e81c3cbac2bb513793cdc75": { col: 9, vrow: 2 },
    "5e81edc13397a21db957f6a3@5e81edc13397a21db957f6a1": { col: 9, vrow: -1 },
    "5e81edc13397a21db957f6a4@5e81edc13397a21db957f6a1": { col: 4, vrow: -1 },
    "5e8206f4cb2b95385c17759c@5e81c3cbac2bb513793cdc75": { col: 8, vrow: 1 },
    "5e820703ac2bb513793cdd0d@5e81c3cbac2bb513793cdc75": { col: 10, vrow: -1 },
    "5e82070e763d9f754677bf93@5e81c3cbac2bb513793cdc75": { col: 8, vrow: -1 },
    "5e848cc2988a8701445df1ec@5e848cc2988a8701445df1e8": { col: 7, vrow: 1 },
    "5e870397991fd70db46995cc@5e870397991fd70db46995c8": { col: 8, vrow: 1 },
    "5ecd055b46779c0def791545@5e81ebcd8e146c7080625e15": { col: 8, vrow: -1 },
    "5ecd05a0f31abe67c80ca1fb@5e81ebcd8e146c7080625e15": { col: 8, vrow: 1, flexible: true },
    "5ecd05a81099e932a15afc70@5e81ebcd8e146c7080625e15": { col: 7, vrow: 1, flexible: true },
    "5eea21647547d6330471b3cb@5eea21647547d6330471b3c9": { col: 6, vrow: 1, flexible: true },
    "5eea21647547d6330471b3cc@5eea21647547d6330471b3c9": { col: 5, vrow: 1, flexible: true },
    "5eea21647547d6330471b3cd@5eea21647547d6330471b3c9": { col: 6, vrow: 2, flexible: true },
    "5eeb2ff5ea4f8b73c827350e@5eeb2ff5ea4f8b73c827350b": { col: 9, vrow: -1, flexible: true },
    "5eeb2ff5ea4f8b73c827350f@5eeb2ff5ea4f8b73c827350b": { col: 9, vrow: 1, flexible: true },
    "5ef1b9f0c64c5d0dfc0571a4@5ef1b9f0c64c5d0dfc0571a1": { col: 9, vrow: 1 },
    "5ef5d9bc22584f36a62bc2a6@5e81c3cbac2bb513793cdc75": { col: 6, vrow: -1, flexible: true },
    "5ef5d9c76b0e105bd96c76db@5e81c3cbac2bb513793cdc75": { col: 7, vrow: 1, flexible: true },
    "5ef621945974e145cf763b38@5e81edc13397a21db957f6a1": { col: 4, vrow: 0 },
    "5eff475295cf7c48714a4f52@5eeb2ff5ea4f8b73c827350b": { col: 7, vrow: 1, flexible: true },
    "5eff475e27176e46940ce1b3@5eeb2ff5ea4f8b73c827350b": { col: 7, vrow: -1, flexible: true },
    "5eff476768051e2ccb1bb6e3@5eeb2ff5ea4f8b73c827350b": { col: 6, vrow: -1, flexible: true },
    "5eff4775d823312838614d84@5eeb2ff5ea4f8b73c827350b": { col: 5, vrow: -1, flexible: true },
    "5eff479f7ef6e714311aed49@5eeb2ff5ea4f8b73c827350b": { col: 10, vrow: -1, flexible: true },
    "5f36a0e5fbf956000b716b67@5f36a0e5fbf956000b716b65": { col: 5, vrow: 0 },
    "5f36a0e5fbf956000b716b6a@5f36a0e5fbf956000b716b65": { col: 9, vrow: 2, flexible: true },
    "5f36a0e5fbf956000b716b6b@5f36a0e5fbf956000b716b65": { col: 8, vrow: 1, flexible: true },
    "5f36a0e5fbf956000b716b6c@5f36a0e5fbf956000b716b65": { col: 10, vrow: -1, flexible: true },
    "5f36a0e5fbf956000b716b6d@5f36a0e5fbf956000b716b65": { col: 8, vrow: -1 },
    "5f36a0e5fbf956000b716b6e@5f36a0e5fbf956000b716b65": { col: 7, vrow: 1 },
    "5f3e7823ddc4f03b010e2047@5f3e7823ddc4f03b010e2045": { col: 9, vrow: -1 },
    "5f3e7823ddc4f03b010e2048@5f3e7823ddc4f03b010e2045": { col: 4, vrow: -1 },
    "5f3e7823ddc4f03b010e2049@5f3e7823ddc4f03b010e2045": { col: 4, vrow: 0 },
    "5f63418ef5750b524b45f11b@5f63418ef5750b524b45f116": { col: 6, vrow: -1, flexible: true },
    "5f63418ef5750b524b45f11c@5f63418ef5750b524b45f116": { col: 4, vrow: -1, flexible: true },
    "5f635bd3ea26e63a816e457d@5f63418ef5750b524b45f116": { col: 6, vrow: 1, flexible: true },
    "5f635bedf524050b633336e7@5f63418ef5750b524b45f116": { col: 4, vrow: 1, flexible: true },
    "5fc3f280900b1d5091531e56@5fb64bc92b1b027b1f50bcf2": { col: 7, vrow: 1, flexible: true },
    "5fc53bbb900b1d5091531e75@5fc3e272f8b6a877a729eac5": { col: 7, vrow: 1, flexible: true },
    "5fc53bc8900b1d5091531e76@5fc3e272f8b6a877a729eac5": { col: 6, vrow: 1, flexible: true },
    "5fc53bd82770a0045c59c6f8@5fc3e272f8b6a877a729eac5": { col: 6, vrow: -1, flexible: true },
    "5fce17bd1f152d4312622bcc@5fb64bc92b1b027b1f50bcf2": { col: 6, vrow: 1, flexible: true },
    "5fce17c9cd04c62af60d806c@5fb64bc92b1b027b1f50bcf2": { col: 6, vrow: -1, flexible: true },
    "60228925961b8d75ee233c34@60228924961b8d75ee233c32": { col: 9, vrow: -1 },
    "60228925961b8d75ee233c35@60228924961b8d75ee233c32": { col: 6, vrow: -1, flexible: true },
    "602a9740da11d6478d5a06e2@602a9740da11d6478d5a06dc": { col: 7, vrow: 1, flexible: true },
    "60785ce5132d4d12c81fd91c@60785ce5132d4d12c81fd918": { col: 6, vrow: -1, flexible: true },
    "60785ce5132d4d12c81fd91d@60785ce5132d4d12c81fd918": { col: 7, vrow: -1, flexible: true },
    "60785ce5132d4d12c81fd91f@60785ce5132d4d12c81fd918": { col: 5, vrow: 1, flexible: true },
    "60785ce5132d4d12c81fd921@60785ce5132d4d12c81fd918": { col: 9, vrow: -1, flexible: true },
    "607d7be26d0bd7580617bb3b@606eef756d0bd7580617baf8": { col: 10, vrow: -1, flexible: true },
    "607ea9218900dc2d9a55b6dd@606ee5c81246154cad35d65e": { col: 6, vrow: 1, flexible: true },
    "60acc28fab5d1052a56d9c10@6086b5731246154cad35d6c7": { col: 5, vrow: 1, flexible: true },
    "615d8dbd290d254f5e6b2ed8@615d8dbd290d254f5e6b2ed6": { col: 9, vrow: -1 },
    "615ef1d1568c120fdd2946ed@615d8dbd290d254f5e6b2ed6": { col: 6, vrow: -1, flexible: true },
    "61713cc4d8e3106d9806c10c@61713cc4d8e3106d9806c109": { col: 7, vrow: -2, flexible: true },
    "61713cc4d8e3106d9806c10d@61713cc4d8e3106d9806c109": { col: 5, vrow: -2, flexible: true },
    "6171407e50224f204c1da3c8@6171407e50224f204c1da3c5": { col: 7, vrow: -2, flexible: true },
    "6171407e50224f204c1da3c9@6171407e50224f204c1da3c5": { col: 5, vrow: -2, flexible: true },
    "6193a720f8ee7e52e42109ef@6193a720f8ee7e52e42109ed": { col: 5, vrow: 0 },
    "6193a720f8ee7e52e42109f3@6193a720f8ee7e52e42109ed": { col: 9, vrow: 1 },
    "6193a720f8ee7e52e42109f4@6193a720f8ee7e52e42109ed": { col: 10, vrow: -1 },
    "6193a720f8ee7e52e42109f5@6193a720f8ee7e52e42109ed": { col: 8, vrow: -1 },
    "6193a720f8ee7e52e42109f6@6193a720f8ee7e52e42109ed": { col: 7, vrow: 1 },
    "6193d382ed0429009f543e67@6193d382ed0429009f543e65": { col: 9, vrow: -1 },
    "6193d382ed0429009f543e68@6193d382ed0429009f543e65": { col: 5, vrow: -1 },
    "6194f41f9fb0c665d5490e77@6194f41f9fb0c665d5490e75": { col: 9, vrow: -1 },
    "6194f41f9fb0c665d5490e78@6194f41f9fb0c665d5490e75": { col: 5, vrow: -1 },
    "6194f5722d2c397d66003491@6194f5722d2c397d6600348f": { col: 9, vrow: -1 },
    "6194f5722d2c397d66003492@6194f5722d2c397d6600348f": { col: 5, vrow: -1 },
    "6194f5a318a3974e5e7421ed@6194f5a318a3974e5e7421eb": { col: 9, vrow: -1 },
    "6194f5a318a3974e5e7421ee@6194f5a318a3974e5e7421eb": { col: 5, vrow: -1 },
    "6194f5d418a3974e5e7421f1@6194f5d418a3974e5e7421ef": { col: 9, vrow: -1 },
    "6194f5d418a3974e5e7421f2@6194f5d418a3974e5e7421ef": { col: 5, vrow: -1 },
    "6194f644de3cdf1d2614a76b@6194efe07c6c7b169525f11b": { col: 4, vrow: 0 },
    "619d3a31142be829c6730450@612368f58b401f4f51239b33": { col: 8, vrow: -1 },
    "61a4c8884f95bc3b2c5dc975@61a4c8884f95bc3b2c5dc96f": { col: 7, vrow: 1 },
    "6259b864ebedf17603599e8b@6259b864ebedf17603599e88": { col: 7, vrow: 1, flexible: true },
    "626a8f75f7387003622dc9da@5a38ef1fc4a282000b1521f6": { col: 10, vrow: -1 },
    "628396ab8a8a6f1c687a8580@6275303a9f372d6ea97f9ec7": { col: 6, vrow: 1, flexible: true },
    "628396ecf21bc425b06ac324@6275303a9f372d6ea97f9ec7": { col: 8, vrow: 2, flexible: true },
    "6284bfa06a2b2104d614839e@6284bd5f95250a29bc628a30": { col: 9, vrow: -2, flexible: true },
    "6284bfc1eff7053cd97d00e7@6284bd5f95250a29bc628a30": { col: 7, vrow: -2, flexible: true },
    "63075cc5962d0247b029dc2b@63075cc5962d0247b029dc2a": { col: 9, vrow: -1, flexible: true },
    "63075cc5962d0247b029dc2c@63075cc5962d0247b029dc2a": { col: 6, vrow: -1, flexible: true },
    "63088377b5cd69678408714c@63088377b5cd696784087147": { col: 7, vrow: 1, flexible: true },
    "633ec7c2a6918cb895019c71@633ec7c2a6918cb895019c6c": { col: 7, vrow: 1, flexible: true },
    "6374a7a6417239a7bf00f041@5448bd6b4bdc2dfc2f8b4569": { col: 9, vrow: 1 },
    "637b6db5c49199abef0ac784@637b6d610aef6cfc5e02dd14": { col: 7, vrow: 1, flexible: true },
    "63c6ae0ace402fb40f05a109@6374a822e629013b9c0645c8": { col: 9, vrow: -1 },
    "63c80606ebf7085ac00475e4@579204f224597773d619e051": { col: 9, vrow: 1 },
    "63e0e38a69739d1115030438@56e0598dd2720bb5668b45a6": { col: 9, vrow: 1 },
    "6539301abf39af1cea1f1326@65392f611406374f82152ba5": { col: 5, vrow: -2, flexible: true },
    "65393038e5e89511d0676bf6@65392f611406374f82152ba5": { col: 6, vrow: -2, flexible: true },
    "653931da5db71d30ab1d6297@653931da5db71d30ab1d6296": { col: 5, vrow: -2, flexible: true },
    "653931da5db71d30ab1d6298@653931da5db71d30ab1d6296": { col: 6, vrow: -2, flexible: true },
    "668fe5a998b5ad715703ddd9@668fe5a998b5ad715703ddd6": { col: 9, vrow: 1 },
    "668fe60b56984d93550462c8@668fe60b56984d93550462c6": { col: 9, vrow: -1 },
    "669fa39b48fc9f8db6035a0f@669fa39b48fc9f8db6035a0c": { col: 9, vrow: 1 },
    "669fa3d176116c89840b1216@669fa39b48fc9f8db6035a0c": { col: 7, vrow: 1 },
    "669fa3d876116c89840b121a@669fa3d876116c89840b1217": { col: 9, vrow: 1 },
    "669fa3d876116c89840b121d@669fa3d876116c89840b1217": { col: 7, vrow: 1 },
    "669fa3f88abd2662d80eee7a@669fa3f88abd2662d80eee77": { col: 9, vrow: 1 },
    "669fa409933e898cce0c2169@669fa409933e898cce0c2166": { col: 9, vrow: 1 },
    "669fa4d97a09bc295603b498@669fa4d97a09bc295603b496": { col: 9, vrow: -1 },
    "669fa5019aa2a422600442f8@669fa5019aa2a422600442f6": { col: 9, vrow: -1 },
    "669fa5127a09bc295603b49b@669fa5127a09bc295603b499": { col: 9, vrow: -1 },
    "669fa5271bd4416eaa09b3d0@669fa5271bd4416eaa09b3ce": { col: 9, vrow: -1 },
    "6710cea72bb09af72f0e6bfa@6710cea62bb09af72f0e6bf8": { col: 6, vrow: 1, flexible: true },
    "6710cea72bb09af72f0e6bfc@6710cea62bb09af72f0e6bf8": { col: 8, vrow: 2, flexible: true },
    "6710cf0460e07cfc080a173f@6710cea62bb09af72f0e6bf8": { col: 7, vrow: -1, flexible: true },
    "67162f402a35d090a30f6c2d@576165642459773c7a400233": { col: 7, vrow: 1, flexible: true },
    "671a135093456689d50d6364@670fced86a7e274b1a0964e8": { col: 7, vrow: 1, flexible: true },
    "671a13b1cc18c44298005c14@670fd0a8d8d4eae4790c8187": { col: 7, vrow: 1, flexible: true },
    "674fe57721a9aa6be6045b9b@674fe57721a9aa6be6045b96": { col: 6, vrow: 1, flexible: true },
    "674fe57721a9aa6be6045b9c@674fe57721a9aa6be6045b96": { col: 4, vrow: 1, flexible: true },
    "674fe89a4472d471fb0f07da@674fe89a4472d471fb0f07d8": { col: 4, vrow: -1, flexible: true },
    "674fe89a4472d471fb0f07db@674fe89a4472d471fb0f07d8": { col: 6, vrow: -1, flexible: true },
    "674fe8b9362ea1f88b0e2790@674fe8b9362ea1f88b0e278d": { col: 6, vrow: -2, flexible: true },
    "674fe9a75e51f1c47c04ec2e@674fe9a75e51f1c47c04ec23": { col: 7, vrow: 1 },
    "674feb67325a128b42097497@674fe57721a9aa6be6045b96": { col: 5, vrow: -1, flexible: true },
    "674fec0d325a128b42097498@674fe89a4472d471fb0f07d8": { col: 3, vrow: -1, flexible: true },
    "6764991dd8ffd0b1b20716f9@6259c2c1d714855d182bad85": { col: 5, vrow: 1, flexible: true },
    "67d416e19bd76ef20f0e7440@67d416e19bd76ef20f0e743b": { col: 9, vrow: -1 },
    "67d41711358cdfa3450e8b28@67d416e19bd76ef20f0e743b": { col: 5, vrow: -1 },
    "67d417c023ec241bb70d4898@67d417c023ec241bb70d4896": { col: 4, vrow: 1, flexible: true },
    "68c170e383e2d814b0093f8c@68c170e383e2d814b0093f87": { col: 4, vrow: -1, flexible: true },
    "68c170e383e2d814b0093f8d@68c170e383e2d814b0093f87": { col: 5, vrow: -1, flexible: true },
    "68c2989dc9061bb2f50478fb@68c2989dc9061bb2f50478f6": { col: 4, vrow: -1, flexible: true },
    "68c2989dc9061bb2f50478fc@68c2989dc9061bb2f50478f6": { col: 5, vrow: -1, flexible: true },
};
// Snapshot of the hardcoded base so the devtool can diff and only persist changes to localStorage.
window._AG_OVERRIDES_BASE = Object.assign({}, window._AG_OVERRIDES);

// ============================================================
// PHASE 1 - COLLECT ALL VISIBLE SLOTS
// ============================================================

// Walks the entire build tree recursively (same rules as renderNode:
// skip slots with no allowed items unless something is installed).
// Returns flat array of { slot, parentNode, depth, parentSlotName }
// where parentSlotName = slot_name of the slot the parentNode's item was installed in.
async function collectAllVisibleSlots(rootNode) {
    const entries = [];

    async function walk(node, depth, parentSlotName) {
        let slots = EFTForge.state.slotCache[node.item.id];
        if (!slots) {
            try {
                slots = await fetchItemSlots(node.item.id);
                cacheSet(EFTForge.state.slotCache, node.item.id, slots);
            } catch (err) {
                console.error("[attachment-grid] Failed to load slots for", node.item.id, err);
                return;
            }
        }

        for (const slot of slots) {
            const installed = node.children[slot.id];
            if (!installed && !slot.has_allowed_items) continue;

            entries.push({ slot, parentNode: node, depth, parentSlotName });

            if (installed) {
                await walk(installed, depth + 1, slot.slot_name);
            }
        }
    }

    await walk(rootNode, 0, null);
    return entries;
}

// ============================================================
// PHASE 2 - COMPUTE GRID POSITIONS
// ============================================================

// Returns { positions: Map<index, {col, row, extras}>, gunRow, totalRows }
// Uses a virtual row system: vrow 0 = gun level, negative = above, positive = below.
// After computing all vrows, offsets everything so min vrow maps to CSS row 1.
function computeGridPositions(slotEntries) {
    const virtualPos = [];       // index -> { col, vrow, extras }
    const occupied   = new Set(); // "col,vrow" strings for collision detection

    function placeAt(col, vrow) {
        const key = `${col},${vrow}`;
        if (!occupied.has(key)) {
            occupied.add(key);
            return { col, vrow, extras: false };
        }
        return { col: null, vrow: null, extras: true };
    }

    // Scan upward from startVrow until a free cell is found
    function placeUp(col, startVrow) {
        for (let v = startVrow; v >= startVrow - 30; v--) {
            const r = placeAt(col, v);
            if (!r.extras) return r;
        }
        return { col: null, vrow: null, extras: true };
    }

    // Scan downward from startVrow until a free cell is found
    function placeDown(col, startVrow) {
        for (let v = startVrow; v <= startVrow + 30; v++) {
            const r = placeAt(col, v);
            if (!r.extras) return r;
        }
        return { col: null, vrow: null, extras: true };
    }

    // Place one row below parent, alternating left/right columns (for Mounts on left-side parents)
    function placeDiagonalDown(col) {
        for (let vrow = 1; vrow <= 10; vrow++) {
            for (const c of [col - 1, col + 1]) {
                if (c >= 1 && c < _AG_GUN_COL) {
                    const r = placeAt(c, vrow);
                    if (!r.extras) return r;
                }
            }
        }
        return { col: null, vrow: null, extras: true };
    }

    // --- Left-side queue ---
    // LEFT_ORDER is "closest to gun going outwards", so index 0 = closest = highest col.
    // i=0 (Receiver) -> col GUN_COL-1, i=1 (Handguard) -> col GUN_COL-2, etc.
    const allNames  = new Set(slotEntries.map(e => e.slot.slot_name));
    const leftQueue = _AG_LEFT_ORDER.filter(name => allNames.has(name));
    const leftColMap = {};
    leftQueue.forEach((name, i) => {
        leftColMap[name] = _AG_GUN_COL - 1 - i;
    });

    // Column to use for Front Sight (above Muzzle, or floating if no Muzzle)
    let muzzleCol;
    if (leftColMap["Muzzle"] != null) {
        muzzleCol = leftColMap["Muzzle"];
    } else if (leftQueue.length > 0) {
        // Float one column outward past the outermost (lowest-col) present left slot
        const outermostCol = leftColMap[leftQueue[leftQueue.length - 1]];
        muzzleCol = Math.max(1, outermostCol - 1);
    } else {
        muzzleCol = _AG_GUN_COL - 1;
    }

    let tacticalCount  = 0;
    // Bottom-left column counter: Foregrip/Bipod/bolt-release etc. fill col 7 → 6 → 5 …
    let bottomLeftVcol = _AG_GUN_COL;
    // Stock child rows stack downward from vrow 1
    let stockChildVrow = 1;
    function nextStockVrow() { return stockChildVrow++; }

    // Tracks how many times each (slot.id @ parentItem.id) pair has appeared so far.
    // Needed to build unique override keys when identical items expose identical slot names.
    const _ovCount = {};

    // Pre-pass: reserve all fixed dev-override positions in `occupied` before auto-placement runs.
    // This prevents auto-placed child slots from claiming a cell that has a manual override,
    // which would evict the manually-placed slot to extras.
    // Flexible overrides (ov.flexible = true) are NOT reserved - they yield to auto-placed slots
    // and instead scan downward from their preferred position when displaced.
    if (window._AG_OVERRIDES) {
        const _preCount = {};
        for (const { slot, parentNode } of slotEntries) {
            const _baseKey = `${slot.id}@${parentNode.item.id}`;
            const _idx     = (_preCount[_baseKey] = (_preCount[_baseKey] || 0) + 1) - 1;
            const _ovKey   = _idx === 0 ? _baseKey : `${_baseKey}#${_idx}`;
            if (_ovKey in window._AG_OVERRIDES) {
                const ov = window._AG_OVERRIDES[_ovKey];
                if (!ov.flexible) occupied.add(`${ov.col},${ov.vrow}`);
            }
        }
    }

    // Maps each installed item node -> { col, vrow } so its children can place relative to it.
    const installPos = new Map();

    // Flexible override slots are deferred so all auto-placed and child slots claim their
    // positions first. This ensures a child slot opened by an installed item correctly
    // pushes the flexible slot down rather than being forced below it.
    const _flexDeferred = []; // { i, ov }

    for (let i = 0; i < slotEntries.length; i++) {
        const { slot, parentNode, parentSlotName } = slotEntries[i];
        const name          = slot.slot_name;
        const isBaseGunSlot = (parentNode === EFTForge.state.buildTree);
        const installed     = parentNode.children[slot.id];

        const vPos = (function computePos() {
            // --- Dev tool position override (localhost only) ---
            if (window._AG_OVERRIDES) {
                const _baseKey = `${slot.id}@${parentNode.item.id}`;
                const _idx     = (_ovCount[_baseKey] = (_ovCount[_baseKey] || 0) + 1) - 1;
                const _ovKey   = _idx === 0 ? _baseKey : `${_baseKey}#${_idx}`;
                if (_ovKey in window._AG_OVERRIDES) {
                    const ov = window._AG_OVERRIDES[_ovKey];
                    if (ov.flexible) {
                        // Defer flexible overrides to a second pass so child slots placed
                        // by installed items can claim their positions first.
                        _flexDeferred.push({ i, ov });
                        // Record the preferred position in installPos immediately so child
                        // slots (processed in the same main loop pass) can place relative
                        // to this parent. The second pass may shift the actual position but
                        // children will still land in the right area.
                        if (installed) installPos.set(installed, { col: ov.col, vrow: ov.vrow });
                        return null; // placeholder; filled in second pass below
                    }
                    // Fixed: position was pre-reserved; force-place without collision check.
                    return { col: ov.col, vrow: ov.vrow, extras: false };
                }
            }

            // --- Extras: no defined position ---
            if (_AG_EXTRAS.has(name)) return { col: null, vrow: null, extras: true };

            // --- Left side queue ---
            // If the leftColMap position is already occupied (e.g. a muzzle attachment
            // that has its own "Muzzle" child slot), fall through to parent-relative logic
            // rather than going to extras.
            if (name in leftColMap) {
                const r = placeAt(leftColMap[name], 0);
                if (!r.extras) return r;
            }

            // --- Ch. Handle: primary above Stock; secondary falls to bottom-left row ---
            if (name === "Ch. Handle") {
                const primary = placeAt(_AG_STOCK_COL, -1);
                if (!primary.extras) return primary;
                return placeAt(bottomLeftVcol--, 1);
            }

            // --- Stock child slots: stack downward below Stock ---
            // Must come before name === "Stock" so a stock item's own "Stock" sub-slot
            // stacks below instead of colliding at (STOCK_COL, 0).
            if (parentSlotName === "Stock") {
                return placeAt(_AG_STOCK_COL, nextStockVrow());
            }

            // --- Stock (base gun slot) ---
            if (name === "Stock") return placeAt(_AG_STOCK_COL, 0);

            // --- Tactical: stack upward above gun (base gun slot only) ---
            if (name === "Tactical" && isBaseGunSlot) {
                tacticalCount++;
                return placeAt(_AG_GUN_COL, -tacticalCount);
            }

            // --- Top row: Scope, Mount, Rear Sight (base gun slot only) ---
            // placeUp scans upward so duplicate same-name slots (e.g. two Mount rails)
            // stack at vrow -2, -3, ... instead of falling to extras.
            if (name in _AG_TOP_MAP && isBaseGunSlot) {
                return placeUp(_AG_TOP_MAP[name], -1);
            }

            // --- Bottom row aligned to gun columns (base gun slots only) ---
            // placeDown scans downward so duplicate same-name slots stack below.
            if (name in _AG_BOTTOM_MAP && isBaseGunSlot) {
                return placeDown(_AG_BOTTOM_MAP[name], 1);
            }

            // --- Bottom-left: Bipod, Foregrip (base gun slots only) ---
            if (_AG_BOTTOM_LEFT.has(name) && isBaseGunSlot) {
                return placeAt(bottomLeftVcol--, 1);
            }

            // --- Front Sight: above Muzzle position ---
            if (name === "Front Sight") return placeAt(muzzleCol, -1);

            // --- Parent-relative placement ---
            // Children grow in the direction their parent item is from gun level.
            const pPos = installPos.get(parentNode);
            if (pPos != null) {
                if (pPos.vrow < 0) {
                    // Parent is above gun - children grow further upward
                    return placeUp(pPos.col, pPos.vrow - 1);
                }
                if (pPos.vrow > 0) {
                    // Parent is below gun - children grow further downward
                    return placeDown(pPos.col, pPos.vrow + 1);
                }
                // Parent is at gun level (vrow = 0) - use column to determine direction
                if (pPos.col < _AG_GUN_COL) {
                    // Left-side queue parent: Mount goes diagonal-below, Scope/Tactical go above
                    if (name === "Mount") return placeDiagonalDown(pPos.col);
                    if (name === "Scope" || name === "Tactical") return placeUp(pPos.col, -1);
                    return placeDown(pPos.col, 1);
                }
                // Gun column or right-side parent - children grow downward
                return placeDown(pPos.col, 1);
            }

            // --- Everything else: extras ---
            return { col: null, vrow: null, extras: true };
        })();

        virtualPos[i] = vPos;

        // Record where the installed item landed so its children can position relative to it
        if (installed && vPos && !vPos.extras) {
            installPos.set(installed, { col: vPos.col, vrow: vPos.vrow });
        }
    }

    // Second pass: place flexible overrides now that all auto-placed slots have claimed positions.
    for (const { i, ov } of _flexDeferred) {
        const pos = placeDown(ov.col, ov.vrow);
        virtualPos[i] = pos;
        // Update installPos with the actual final position (children were already placed using
        // the preferred position recorded above, but this keeps installPos accurate).
        const { slot: _s, parentNode: _pn } = slotEntries[i];
        const _inst = _pn.children[_s.id];
        if (_inst && pos && !pos.extras) installPos.set(_inst, { col: pos.col, vrow: pos.vrow });
    }

    // Convert virtual rows to CSS 1-indexed rows
    const validVrows = virtualPos
        .filter(v => v && !v.extras && v.vrow != null)
        .map(v => v.vrow);

    // Always include vrow 0 (gun level) to guarantee the gun cell has a row
    const minVrow   = validVrows.length > 0 ? Math.min(...validVrows, 0) : 0;
    const maxVrow   = validVrows.length > 0 ? Math.max(...validVrows, 0) : 0;
    const totalRows = maxVrow - minVrow + 1;
    const gunRow    = 0 - minVrow + 1;

    const positions = new Map();
    for (let i = 0; i < slotEntries.length; i++) {
        const vp = virtualPos[i] ?? { col: null, vrow: null, extras: true };
        if (vp.extras || vp.col == null) {
            positions.set(i, { col: null, row: null, extras: true });
        } else {
            positions.set(i, { col: vp.col, row: vp.vrow - minVrow + 1, extras: false });
        }
    }

    return { positions, gunRow, totalRows };
}

// ============================================================
// PHASE 3 - BUILD DOM
// ============================================================

function _clearAllSlotEls(node) {
    node._slotEls = {};
    for (const slotId in node.children) {
        _clearAllSlotEls(node.children[slotId]);
    }
}

function _createSlotCell(slot, parentNode, installed) {
    const { tSlot } = EFTForge.lang;

    const cell = document.createElement("div");
    // .tree-slot keeps compatibility with querySelectorAll(".tree-slot.active-slot") in slot-selector.js
    // .ag-cell applies grid-specific CSS overrides
    cell.className = "tree-slot ag-cell";
    cell.dataset.slotId       = slot.id;
    cell.dataset.parentItemId = parentNode.item.id;
    cell.dataset.slotName     = slot.slot_name;
    if (installed) cell.dataset.installedItemId = installed.item.id;

    const innerContent = installed
        ? `<img class="ag-icon" src="${escapeHtml(installed.item.icon_link)}" alt="" /><div class="slot-shortname">${escapeHtml(installed.item.short_name)}</div>`
        : _slotPlaceholderHtml(slot.slot_name, "ag-empty");

    // .tree-slot-inner needed by: flash CSS (::after pseudo), removeAttachment swipe strip
    // .tree-slot-item needed by: updateSlotIcon (querySelector(".tree-slot-item"))
    cell.innerHTML = `<div class="tree-slot-inner${installed ? " swipe-removable" : ""}"><div class="tree-slot-item">${innerContent}</div></div><div class="ag-label">${escapeHtml(tSlot(slot.slot_name))}</div>`;

    // Register swipe-to-remove handler (picked up by MutationObserver in app.js)
    if (installed) {
        const inner = cell.querySelector(".tree-slot-inner");
        inner._swipeRemoveFn = () => {
            if (EFTForge.state.publishMode) return;
            if (parentNode.children[slot.id]) removeAttachment(parentNode, slot.id);
        };
    }

    // Click: open slot selector
    cell.onclick = (e) => {
        e.stopPropagation();
        if (EFTForge.state.publishMode) { _showPublishLockedToast(); return; }
        openSlotSelector(parentNode, slot);
    };

    // Right-click: remove attachment
    cell.oncontextmenu = (e) => {
        e.preventDefault();
        if (EFTForge.state.publishMode) { _showPublishLockedToast(); return; }
        if (parentNode.children[slot.id]) removeAttachment(parentNode, slot.id);
    };

    return cell;
}

function _buildGridDOM(slotEntries, positions, gunRow, totalRows, container) {
    const wrapper = document.createElement("div");
    wrapper.className = "attachment-grid-wrapper";

    const grid = document.createElement("div");
    grid.id = "attachment-grid";
    grid.className = "attachment-grid";
    // Rows are dynamic; columns are defined in CSS
    grid.style.gridTemplateRows = `repeat(${totalRows}, 58px)`;

    // Gun image cell - spans 3 columns (cols 7, 8, 9)
    const gunCell = document.createElement("div");
    gunCell.id = "ag-gun-cell";
    gunCell.className = "ag-gun-cell";
    gunCell.style.gridColumn = "7 / 10";
    gunCell.style.gridRow    = String(gunRow);
    const gunSrc  = EFTForge.state.currentGun?.image_512_link || EFTForge.state.currentGun?.icon_link || "";
    const gunName = EFTForge.state.currentGun?.short_name || EFTForge.state.currentGun?.name || "";
    gunCell.innerHTML = `
        ${gunSrc ? `<img src="${escapeHtml(gunSrc)}" alt="" />` : ""}
        <div class="ag-label ag-gun-label">${escapeHtml(gunName)}</div>
    `;
    grid.appendChild(gunCell);

    const extrasDiv = document.createElement("div");
    extrasDiv.className = "ag-extras";
    let hasExtras = false;

    // Same instance counter as computeGridPositions - both iterate slotEntries in the same
    // order, so the resulting overrideKey for each entry will always match.
    const _domCount = {};

    // Maps each installed node -> the UID of the cell that holds it.
    // Used to link child cells to their exact parent cell for the hover pulse,
    // bypassing item IDs (which are shared across identical installed items).
    const _nodeToUid = new Map();
    let _uidSeq = 0;

    for (let i = 0; i < slotEntries.length; i++) {
        const { slot, parentNode } = slotEntries[i];
        const pos       = positions.get(i);
        const installed = parentNode.children[slot.id];
        const cell      = _createSlotCell(slot, parentNode, installed);

        // Unique cell ID for the parent-pulse lookup
        const uid = ++_uidSeq;
        cell.dataset.cellUid = uid;
        // Link this cell to its parent cell (if one exists)
        const parentUid = _nodeToUid.get(parentNode);
        if (parentUid != null) cell.dataset.parentCellUid = parentUid;
        // Record this cell's UID so its children can find it
        if (installed) _nodeToUid.set(installed, uid);

        // Compute and store a stable, unique key for the devtool override system.
        const _baseKey     = `${slot.id}@${parentNode.item.id}`;
        const _idx         = (_domCount[_baseKey] = (_domCount[_baseKey] || 0) + 1) - 1;
        cell.dataset.overrideKey = _idx === 0 ? _baseKey : `${_baseKey}#${_idx}`;

        if (pos.extras) {
            hasExtras = true;
            extrasDiv.appendChild(cell);
        } else {
            cell.style.gridColumn = String(pos.col);
            cell.style.gridRow    = String(pos.row);
            grid.appendChild(cell);
        }

        // Populate _slotEls so flashSlot / findSlotElement / updateSlotIcon work unchanged
        if (!parentNode._slotEls) parentNode._slotEls = {};
        parentNode._slotEls[slot.id] = cell;
    }

    wrapper.appendChild(grid);
    if (hasExtras) wrapper.appendChild(extrasDiv);
    // Parent pulse on child hover - uses an injected overlay div so it never
    // touches .tree-slot-inner::after and cannot interfere with flash animations.
    // Uses data-parent-cell-uid (set per-cell above) so identical installed items
    // are correctly distinguished - no item-ID ambiguity.
    let _pulseOverlay = null;
    wrapper.addEventListener("mouseover", e => {
        const cell = e.target.closest(".ag-cell");
        if (_pulseOverlay) { _pulseOverlay.remove(); _pulseOverlay = null; }
        if (!cell) return;
        const parentCellUid = cell.dataset.parentCellUid;
        if (!parentCellUid) return;
        const parentCell = wrapper.querySelector(`.ag-cell[data-cell-uid="${parentCellUid}"]`);
        if (parentCell) {
            _pulseOverlay = document.createElement("div");
            _pulseOverlay.className = "ag-pulse-overlay";
            parentCell.appendChild(_pulseOverlay);
        }
    });
    wrapper.addEventListener("mouseleave", () => {
        if (_pulseOverlay) { _pulseOverlay.remove(); _pulseOverlay = null; }
    });

    container.appendChild(wrapper);
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

async function renderAttachmentGrid(preserveScroll = true) {
    const { t } = EFTForge.lang;

    const container = document.getElementById("slots");
    if (!container) return;

    const previousScroll = preserveScroll ? container.scrollTop : 0;

    const placeholder = document.getElementById("attachment-placeholder");
    if (!EFTForge.state.lastSlot) {
        if (placeholder) placeholder.style.display = "flex";
        document.getElementById("attachment-table-container").innerHTML = "";
    }

    // Clear stale DOM element references before rebuilding
    if (EFTForge.state.buildTree) {
        _clearAllSlotEls(EFTForge.state.buildTree);
    }

    container.dataset.view = "grid";

    container.innerHTML = `
        <div class="stats-section">
            <div class="section-title">
                ${t("tree.title")}
                <span class="tree-swipe-hint">${t("tree.swipeHint")}</span>
                <span class="tree-view-toggle">
                    <button class="compare-toggle bp-imggen-toggle${_bpEnabled ? ' active' : ''}" onclick="toggleImgGen()" style="margin-right:6px;">
                        ${t("ui.imgGen")}
                        <span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>
                    </button>
                    <button id="view-list-btn" class="toggle-btn${!EFTForge.state.gridView ? ' active' : ''}" onclick="showListView()">&#9776;</button>
                    <button id="view-grid-btn" class="toggle-btn${EFTForge.state.gridView  ? ' active' : ''}" onclick="showGridView()">&#9783;</button>
                </span>
            </div>
            <div id="tree-content"></div>
        </div>
    `;

    const treeBox = document.getElementById("tree-content");
    if (!treeBox || !EFTForge.state.buildTree) return;

    // Phase 1: collect all visible slots from the entire build tree
    const slotEntries = await collectAllVisibleSlots(EFTForge.state.buildTree);

    // Phase 2: compute grid positions using slot placement rules
    const { positions, gunRow, totalRows } = computeGridPositions(slotEntries);

    // Phase 3: build and insert grid DOM
    _buildGridDOM(slotEntries, positions, gunRow, totalRows, treeBox);

    // Re-apply active slot highlight after rebuild
    if (EFTForge.state.lastParentNode && EFTForge.state.lastSlot) {
        const activeEl = findSlotElement(EFTForge.state.lastParentNode, EFTForge.state.lastSlot.id);
        if (activeEl) activeEl.classList.add("active-slot");
    }

    if (preserveScroll) {
        container.scrollTop = previousScroll;
    }
}

// ============================================================
// VIEW TOGGLE (List / Grid)
// ============================================================

// Save the original list renderer defined in tree.js before replacing it.
const _renderTreeList = window.renderFullTree;

// Dispatch to grid or list based on EFTForge.state.gridView.
window.renderFullTree = function (preserveScroll = true) {
    if (EFTForge.state.gridView) {
        return renderAttachmentGrid(preserveScroll);
    }
    return _renderTreeList(preserveScroll);
};

function _animateWorkbench() {
    const el = document.getElementById("tree-content");
    if (!el) return;
    el.classList.remove("panel-enter");
    void el.offsetWidth;
    el.classList.add("panel-enter");
    el.addEventListener("animationend", () => el.classList.remove("panel-enter"), { once: true });
}

function showGridView() {
    if (EFTForge.state.gridView) return;
    EFTForge.state.gridView = true;
    try { localStorage.setItem("eftforge_grid_view", "1"); } catch (_) {}
    _updateTreeViewToggle();
    renderAttachmentGrid(false).then(() => {
        _animateWorkbench();
        if (typeof updateAttTableHeaderImg === "function") updateAttTableHeaderImg();
    });
}
window.showGridView = showGridView;

function showListView() {
    if (!EFTForge.state.gridView) return;
    EFTForge.state.gridView = false;
    try { localStorage.removeItem("eftforge_grid_view"); } catch (_) {}
    const slotsEl = document.getElementById("slots");
    if (slotsEl) delete slotsEl.dataset.view;
    _updateTreeViewToggle();
    _renderTreeList(false).then(() => {
        _animateWorkbench();
        if (typeof updateAttTableHeaderImg === "function") updateAttTableHeaderImg();
    });
}
window.showListView = showListView;

function _updateTreeViewToggle() {
    // Buttons are re-created on each render with the correct active state baked in.
    // This is a no-op kept for the updateViewToggleLabels hook.
}
window._updateTreeViewToggle = _updateTreeViewToggle;

// Restore preference from localStorage on load.
if (localStorage.getItem("eftforge_grid_view") === "1") {
    EFTForge.state.gridView = true;
} else {
    EFTForge.state.gridView = true; // grid is the default
}

// ============================================================
// Grid conflict flash
// ============================================================

function _flashGridCell(cell) {
    if (!cell) return;
    const overlay = document.createElement("div");
    overlay.className = "ag-conflict-overlay";
    cell.appendChild(overlay);
    overlay.addEventListener("animationend", () => overlay.remove(), { once: true });
}

function flashConflictInGrid(conflictingItemId) {
    const grid = document.getElementById("attachment-grid");
    if (!grid) return;
    const cell = grid.querySelector(`.ag-cell[data-installed-item-id="${CSS.escape(conflictingItemId)}"]`);
    _flashGridCell(cell);
}
window.flashConflictInGrid = flashConflictInGrid;

function flashConflictSlotInGrid(conflictingSlotId) {
    const grid = document.getElementById("attachment-grid");
    if (!grid) return;
    const cell = grid.querySelector(`.ag-cell[data-slot-id="${CSS.escape(conflictingSlotId)}"]`);
    _flashGridCell(cell);
}
window.flashConflictSlotInGrid = flashConflictSlotInGrid;

function flashGunCellInGrid() {
    _flashGridCell(document.getElementById("ag-gun-cell"));
}
window.flashGunCellInGrid = flashGunCellInGrid;

// Exported for the dev-tools grid overlap scanner in app.js
window.collectAllVisibleSlots = collectAllVisibleSlots;
window.computeGridPositions   = computeGridPositions;

// ============================================================
// TEMPORARILY DISABLED - Flash animations
