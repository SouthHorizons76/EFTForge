window.EFTForge = window.EFTForge || {};

// Set by the desktop app's local backend, which injects a flag object into
// index.html: { appVersion, adminKey }. The desktop app deliberately behaves
// like a dev environment (devtools and all localhost-gated features enabled) -
// it's the user's own machine and own data.
const _desktop = window.__EFTFORGE_DESKTOP__ || null;

const _isLocalDev = ["localhost", "127.0.0.1"].includes(location.hostname);

window.EFTForge.config = {
    // On localhost the backend runs on a separate port; in production and in
    // the desktop app the API is served from the same origin, so relative
    // paths work.
    API_BASE: (_isLocalDev && !_desktop) ? "http://127.0.0.1:8000" : "",

    IS_LOCAL_DEV: _isLocalDev,

    IS_DESKTOP: !!_desktop,
    DESKTOP:    _desktop,

    // Desktop local mode: community features (community builds, ratings,
    // comments, publishing, leaderboards, profile) are stripped from the UI
    // until the user explicitly connects to EFTForge.com live services.
    COMMUNITY_DISABLED: !!(_desktop && _desktop.communityMode === "local"),

    // Static announcements fetched as fallback when the backend is unreachable.
    // Edit frontend/offline/announcements.json and deploy - nginx serves it at the same path in production.
    // Format: [{id, message, level, expires_at, dismissible}] - use string IDs like "maint-2026-05-25".
    STATIC_ANNOUNCEMENTS_URL: "/offline/announcements.json",

    APP_VERSION:    "Development Build",
    APP_BUILD_DATE: "2026-09-05T17:07:41.153Z", // new Date().toISOString()

    CALIBER_DISPLAY_MAP: {
        "Caliber20x1mm":      "20x1mm disk",
        "Caliber762x39":      "7.62x39",
        "Caliber762x51":      "7.62x51",
        "Caliber762x54R":     "7.62x54R",
        "Caliber556x45NATO":  "5.56x45",
        "Caliber545x39":      "5.45x39",
        "Caliber58x42":       "5.8x42",
        "Caliber9x19PARA":    "9x19",
        "Caliber9x18PM":      "9x18",
        "Caliber9x18PMM":     "9x18",
        "Caliber9x21":        "9x21",
        "Caliber9x39":        "9x39",
        "Caliber57x28":       "5.7x28",
        "Caliber366TKM":      ".366 TKM",
        "Caliber127x55":      "12.7x55",
        "Caliber12g":         "12/70",
        "Caliber20g":         "20/70",
        "Caliber23x75":       "23x75",
        "Caliber1143x23ACP":  ".45 ACP",
        "Caliber127x99":      ".50 BMG",
        "Caliber762x25TT":    "7.62x25 TT",
        "Caliber784x49":      ".308",
        "Caliber762x35":      ".300 BLK",
        "Caliber68x51":       "6.8x51",
        "Caliber40x46":       "40x46mm Grenade",
        "Caliber40mmRU":      "40mm VOG",
        "Caliber26x75":       "26x75mm Flare",
        "Caliber9x33R":       ".357 Magnum",
        "Caliber46x30":       "4.6x30",
        "Caliber86x70":       ".338 LM",
        "Caliber127x33":      ".50 AE",
        "Caliber93x64":       "9.3x64",
    },

    CLASS_DISPLAY_NAMES: {
        "Assault rifle":    "Assault Rifles",
        "Assault carbine":  "Assault Carbines",
        "Marksman rifle":   "Marksman Rifles",
        "Sniper rifle":     "Sniper Rifles",
        "Machinegun":       "Light Machine Guns",
        "Machine gun":      "Light Machine Guns",
        "Machine Gun":      "Light Machine Guns",
        "SMG":              "Submachine Guns",
        "Submachine gun":   "Submachine Guns",
        "Shotgun":          "Shotguns",
        "Handgun":          "Handguns",
        "Revolver":         "Revolvers",
        "Grenade launcher": "Grenade Launchers",
        "Grenade Launcher": "Grenade Launchers",
        "Primary":          "Other",
    },

    CALIBER_ORDER: [
        "5.45x39", "5.56x45", "5.8x42", "6.8x51",
        "7.62x39", "7.62x51", "7.62x54R", "7.62x25 TT",
        ".300 BLK", ".308", ".338 LM", ".366 TKM", "9.3x64",
        "9x18", "9x19", "9x21", "9x39", "5.7x28", "4.6x30", ".357 Magnum",
        ".45 ACP", ".50 AE",
        "12/70", "20/70", "23x75",
        "12.7x55", "40x46mm Grenade", "40mm VOG", ".50 BMG",
    ],

    CLASS_ORDER: [
        "Assault rifle", "Assault carbine", "Marksman rifle", "Sniper rifle",
        "Machinegun", "Machine gun", "Machine Gun",
        "SMG", "Submachine gun",
        "Shotgun",
        "Handgun", "Revolver",
        "Grenade launcher", "Grenade Launcher",
        "Primary",
    ],

    // Item IDs to exclude from combo calc child/grandchild slots.
    // Add item IDs here to prevent them from appearing as combo options.
    COMBO_EXCLUDE_ITEM_IDS: [
        "6269545d0e57f218e4548ca2",
        "689c8b454b91399db3085f2a",
        "669a6a4a525be1d2d004b8eb",
        "5b7be47f5acfc400170e2dd2",
        "6269220d70b6c02e665f2635",
        "689c8981bce76ccfbf01862f",
        "646f6322f43d0c5d62063715",
        "5cc9c20cd7f00c001336c65d",
        "5a7b483fe899ef0016170d15",
        "6267c6396b642f77f56f5c1c",
        "57d17e212459775a1179a0f5",
        "5a800961159bd4315e3a1657",
        "5b07dd285acfc4001754240d",
        "6272379924e29f06af4d5ecb",
        "6272370ee4013c5d7e31f418",
        "56def37dd2720bec348b456a",
        "5d2369418abbc306c62e0c80",
        "560d657b4bdc2da74d8b4572",
        "5a5f1ce64f39f90b401987bc",
        "544909bb4bdc2d6f028b4577",
        "68bedc0365e7dcf94f0cb0fc",
        "57fd23e32459772d0805bcf1",
        "61605d88ffa6e502ac5e7eeb",
        "626becf9582c3e319310b837",
        "5c06595c0db834001a66af6c",
        "644a3df63b0b6f03e101e065",
        "5c5952732e2216398b5abda2",
        "5649a2464bdc2d91118b45a8",
        "6388c4478d895f557a0c6512",
        "671126b049e181972e0681fa",
        "623c2f652febb22c2777d8d7",
        "59e0be5d86f7742d48765bd2",
        "67112695fe5c8bf33f02476d",
        "59e0bdb186f774156f04ce82",
        "5b30bc165acfc40016387293",
        "676175bb48fa5c377e06fc36",
        "6644920d49817dc7d505ca71",
        "5888961624597754281f93f3",
        "6357c98711fb55120211f7e1",
        "5b800ed086f7747baf6e2f9e",
        "5b84038986f774774913b0c1",
        "689c8a2b4b91399db3085f27",
        "67111094d1758189fc0bd223",
        "5a9d6d00a2750c5c985b5305",
        "623c2f4242aee3103f1c44b7",
        "5b4736a986f774040571e998",
        "5b7be4575acfc400161d0832",
        "5b7be4645acfc400170e2dcc",
        "68712b57a1be89347f0d8179",
        "58a56f8d86f774651579314c",
        "62444cd3674028188b052799",
        "67069d3bb29a2cd338033390",
        "616554fe50224f204c1da2aa",
        "58d39d3d86f77445bb794ae7",
        "61714b2467085e45ef140b2c",
        "5b31163c5acfc400153b71cb",
        "577d128124597739d65d0e56",
        "6985bed26be2752c150e6898",
        "58d2664f86f7747fec5834f6",
        "615d8d878004cc50514c3233",
        "5c7d55f52e221644f31bff6a",
        "57ae0171245977343c27bfcf",
        "616584766ef05c2ce828ef57",
        "5a33b652c4a28232996e407c",
        "5a33b2c9c4a282000c5a9511",
        "5649a2464bdc2d91118b45a8",
        "688a0bf28cdd409ce60911ce",
        "544909bb4bdc2d6f028b4577",
        "68bedc0365e7dcf94f0cb0fc",
        "57fd23e32459772d0805bcf1",
        "570fd721d2720bc5458b4596",
        "5d10b49bd7ad1a1a560708b0",
        "5c06595c0db834001a66af6c",
        "61605d88ffa6e502ac5e7eeb",
        "644a3df63b0b6f03e101e065",
        "584984812459776a704a82a6",
        "655f13e0a246670fb0373245",
        "58491f3324597764bc48fa02",
        "584924ec24597768f12ae244",
        "591c4efa86f7741030027726",
        "5c5952732e2216398b5abda2",
        "5d2da1e948f035477b1ce2ba",
        "6165ac8c290d254f5e6b2f6c", 
        "6985beb1812f88c79b0eed39",
        "558022b54bdc2dac148b458d",
        "68a5ab09c44fa287ba0a97b5",
        "570fd6c2d2720bc6458b457f",
        "570fd79bd2720bc7458b4583",
        "64785e7c19d732620e045e15",
        "5c0505e00db834001b735073",
        "59f9d81586f7744c7506ee62",
        "60a23797a37c940de7062d02",
        "5b30b0dc5acfc400153b7124",
        "609a63b6e2ff132951242d09",
        "671126a210d67adb5b08e925",
        "628120d309427b40ab14e76d",
        "628120dd308cb521f87a8fa1",
        "682317390ee6ef08a60e4547",
        "627bce33f21bc425b06ab967",
        "5c1cdd302e221602b3137250",
        "5b3a337e5acfc4704b4a19a0",
    ],
};

// Desktop app: the local backend generates its own admin key (it only grants
// admin over the user's own local data - /admin is never proxied to prod).
// Keep localStorage in sync so the existing admin tools work out of the box.
if (_desktop && _desktop.adminKey) {
    try { localStorage.setItem("eftforge_admin_key", _desktop.adminKey); } catch {}
}

// Desktop builds show a distinct version string everywhere the app version
// appears (about modal, settings modal, backups): e.g. "v1.4.7-desktop".
if (_desktop) {
    window.EFTForge.config.APP_VERSION += "-desktop";
}
