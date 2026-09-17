"""
One-time extraction script: reads SPT items.json and writes spt_weapon_stats.json
and spt_ammo_stats.json containing only the hidden stat _props fields we need.

Run this locally whenever SPT updates:
    python extract_spt_stats.py

Requires SPT_ITEMS_PATH to be set in .env or as an environment variable.
"""

import json
import os
from dotenv import load_dotenv

load_dotenv()

WEAPON_FIELDS = [
    "CenterOfImpact",
    "CameraToWeaponAngleStep",
    "MountCameraSnapMultiplier",
    "MountHorizontalRecoilMultiplier",
    "MountVerticalRecoilMultiplier",
    "MountingVerticalOutOfBreathMultiplier",
    "RecoilCategoryMultiplierHandRotation",
    "RecoilForceBack",
    "RecoilForceUp",
    "RecoilReturnSpeedHandRotation",
    "RecoilCamera",
    "bFirerate",
    "RecoilDampingHandRotation",
    "RecoilReturnPathDampingHandRotation",
    "RecoilReturnPathOffsetHandRotation",
    "RecoilStableIndexShot",
    "RecoilStableAngleIncreaseStep",
    "RecoilPosZMult",
]

# {x,y,z} vector props where only some axes carry a meaningful value.
# Maps source prop -> list of (output field name, axis) to pull out as scalars.
WEAPON_VECTOR_FIELDS = {
    "ProgressRecoilAngleOnStable": [("RecoilStableAngle", "y")],
    "RecoilCenter": [("RecoilCenterY", "y"), ("RecoilCenterZ", "z")],
}

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

# tarkov.dev has no equivalent for any of these - post-penetration damage
# retention and ammo-specific malfunction/misfire risk.
AMMO_FIELDS = [
    "PenetrationDamageMod",
    "MalfFeedChance",
    "MisfireChance",
]

# Parent ID for the Ammo item class in EFT's item hierarchy
AMMO_PARENT = "5485a8684bdc2da71d8b4567"


def _extract(data, parents, fields, vector_fields=None):
    out = {}
    for item_id, item in data.items():
        if item.get("_parent") not in parents:
            continue

        props = item.get("_props", {})
        extracted = {}
        for field in fields:
            if field in props:
                extracted[field] = props[field]

        for src_field, axis_map in (vector_fields or {}).items():
            vec = props.get(src_field)
            if not vec:
                continue
            for out_name, axis in axis_map:
                if axis in vec:
                    extracted[out_name] = vec[axis]

        if extracted:
            out[item_id] = extracted
    return out


def _write(out, filename, label):
    out_path = os.path.join(os.path.dirname(__file__), filename)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))

    size_kb = os.path.getsize(out_path) / 1024
    print(f"Written {len(out)} {label} to {out_path} ({size_kb:.1f} KB)")


def main():
    spt_path = os.environ.get("SPT_ITEMS_PATH", "")
    if not spt_path or not os.path.isfile(spt_path):
        print(f"ERROR: SPT_ITEMS_PATH not set or file not found: {spt_path!r}")
        return

    print(f"Loading {spt_path} ...")
    with open(spt_path, encoding="utf-8") as f:
        data = json.load(f)

    weapons = _extract(data, WEAPON_PARENTS, WEAPON_FIELDS, WEAPON_VECTOR_FIELDS)
    _write(weapons, "spt_weapon_stats.json", "weapons")

    ammo = _extract(data, {AMMO_PARENT}, AMMO_FIELDS)
    _write(ammo, "spt_ammo_stats.json", "ammo")


if __name__ == "__main__":
    main()
