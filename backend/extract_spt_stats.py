"""
One-time extraction script: reads SPT items.json and writes spt_weapon_stats.json
containing only weapon IDs and the hidden stat _props fields we need.

Run this locally whenever SPT updates:
    python extract_spt_stats.py

Requires SPT_ITEMS_PATH to be set in .env or as an environment variable.
"""

import json
import os
from dotenv import load_dotenv

load_dotenv()

SPT_FIELDS = [
    "CenterOfImpact",
    "AimSensitivity",
    "CameraToWeaponAngleStep",
    "MountCameraSnapMultiplier",
    "MountHorizontalRecoilMultiplier",
    "MountVerticalRecoilMultiplier",
    "MountingVerticalOutOfBreathMultiplier",
    "RecoilCategoryMultiplierHandRotation",
    "RecoilForceBack",
    "RecoilForceUp",
    "RecoilReturnSpeedHandRotation",
    "CameraRecoil",
    "Convergence",
]

# Parent IDs for weapon types in EFT's item hierarchy
WEAPON_PARENTS = {
    "5422acb9af1c889c16000029",  # Pistol
    "5447b5cf4bdc2d65278b4567",  # Assault rifle
    "5447b5e04bdc2d62278b4567",  # Submachine gun
    "5447b5f14bdc2d61278b4567",  # Assault carbine
    "5447b5fc4bdc2d87278b4567",  # Bolt-action rifle
    "5447b6094bdc2dc3278b4567",  # Shotgun
    "5447b6194bdc2d67278b4567",  # Machinegun
    "5447b6254bdc2dc3278b4568",  # Sniper rifle
    "5447bed64bdc2d97278b4568",  # Special weapon
    "5447bedf4bdc2d87278b4568",  # Grenade launcher
    "617f1ef5e8b54b0998387733",  # Revolver
}


def main():
    spt_path = os.environ.get("SPT_ITEMS_PATH", "")
    if not spt_path or not os.path.isfile(spt_path):
        print(f"ERROR: SPT_ITEMS_PATH not set or file not found: {spt_path!r}")
        return

    print(f"Loading {spt_path} ...")
    with open(spt_path, encoding="utf-8") as f:
        data = json.load(f)

    out = {}
    for item_id, item in data.items():
        if item.get("_parent") not in WEAPON_PARENTS:
            continue

        props = item.get("_props", {})
        extracted = {}
        for field in SPT_FIELDS:
            if field in props:
                val = props[field]
                # AimSensitivity can be a nested array - flatten to scalar
                if isinstance(val, list):
                    val = val[0][0] if val and isinstance(val[0], list) else None
                extracted[field] = val

        if extracted:
            out[item_id] = extracted

    out_path = os.path.join(os.path.dirname(__file__), "spt_weapon_stats.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))

    size_kb = os.path.getsize(out_path) / 1024
    print(f"Written {len(out)} weapons to {out_path} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
