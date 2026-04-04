window.EFTForge = window.EFTForge || {};

const _isLocalDev = ["localhost", "127.0.0.1"].includes(location.hostname);

window.EFTForge.config = {
    // On localhost the backend runs on a separate port; in production the API is
    // served from the same origin (e.g. behind an nginx proxy), so relative paths work.
    API_BASE: _isLocalDev ? "http://127.0.0.1:8000" : "",

    IS_LOCAL_DEV: _isLocalDev,

    APP_VERSION:    "v1.1.0",
    APP_BUILD_DATE: "2026-04-04T16:06:42.506Z", // UTC - run new Date().toISOString() in console when bumping version

    CALIBER_DISPLAY_MAP: {
        "Caliber20x1mm":      "20x1mm disk",
        "Caliber762x39":      "7.62x39",
        "Caliber762x51":      "7.62x51",
        "Caliber762x54R":     "7.62x54R",
        "Caliber556x45NATO":  "5.56x45",
        "Caliber545x39":      "5.45x39",
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
        "Caliber26x75":       "26x75mm Flare",
        "Caliber30Carbine":   ".30 Carbine",
        "Caliber9x33R":       ".357 Magnum",
        "Caliber46x30":       "4.6x30",
        "Caliber338LM":       ".338 LM",
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
        "5.45x39", "5.56x45", "6.8x51",
        "7.62x39", "7.62x51", "7.62x54R", "7.62x25 TT",
        ".300 BLK", ".308", ".338 LM", ".366 TKM", "9.3x64",
        "9x18", "9x19", "9x21", "9x39", "5.7x28", "4.6x30", ".357 Magnum",
        ".45 ACP", ".50 AE", ".30 Carbine",
        "12/70", "20/70", "23x75",
        "12.7x55", "40x46 Grenade", ".50 BMG",
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
};
