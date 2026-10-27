"""
One-time extraction script: reads SPT items.json and writes spt_weapon_stats.json
and spt_ammo_stats.json containing only the hidden stat _props fields we need, plus
spt_armor_stats.json with the armor data tarkov.dev doesn't carry (plate slot blunt
flags from items.json, armor class/material values from globals.json).

Run this locally whenever SPT updates:
    python extract_spt_stats.py

Requires SPT_ITEMS_PATH to be set in .env or as an environment variable. globals.json
is found next to it in the SPT database folder, or set SPT_GLOBALS_PATH.

The player model's hit colliders (which body part each one drains, and the values plate
colliders carry) live in a Unity asset bundle. Reading it needs UnityPy, a dev-only extra
(pip install UnityPy); without it the colliders already in spt_armor_stats.json are kept.
The bundle is found inside the SPT install, or set PLAYER_BUNDLE_PATH.
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


def blunt_reduce_plate_slots(data):
    """{holder item id: [slot names]} for plate slots flagged bluntDamageReduceFromSoftArmor.

    The flag sits on the slot's filter entry, not on the slot itself."""
    out = {}
    for item_id, item in data.items():
        for slot in (item.get("_props") or {}).get("Slots") or []:
            filters = (slot.get("_props") or {}).get("filters") or []
            if filters and filters[0].get("bluntDamageReduceFromSoftArmor"):
                out.setdefault(item_id, []).append(slot.get("_name"))
    return out


def armor_globals(globals_data):
    """The armor values the ballistics math reads from the game's global config."""
    config = globals_data.get("config", globals_data)
    return {
        # Indexed by armor class; class 0 is unarmored
        "class_resistance": [entry["resistance"] for entry in config["armor"]["class"]],
        "materials": {
            name: {
                "destructibility": values["Destructibility"],
                "explosion_destructibility": values["ExplosionDestructibility"],
            }
            for name, values in config["ArmorMaterials"].items()
        },
        "blunt_damage_reduce_from_soft_armor_mod": config["BluntDamageReduceFromSoftArmorMod"],
        # How much of a bullet's damage and pen survive when it has lost all its speed
        "damage_degradation_coefficient": config["Ballistic"]["GlobalDamageDegradationCoefficient"],
    }


# Game enum values for the collider fields stored in the player bundle
_COLLIDER_TYPES = {
    0: "HeadCommon",
    1: "RibcageUp",
    3: "Pelvis",
    4: "LeftUpperArm",
    5: "LeftForearm",
    6: "RightUpperArm",
    7: "RightForearm",
    8: "LeftThigh",
    9: "LeftCalf",
    10: "RightThigh",
    11: "RightCalf",
    12: "ParietalHead",
    13: "BackHead",
    14: "Ears",
    15: "Eyes",
    16: "Jaw",
    17: "NeckFront",
    18: "NeckBack",
    19: "RightSideChestUp",
    20: "LeftSideChestUp",
    21: "SpineTop",
    22: "SpineDown",
    23: "PelvisBack",
    24: "RightSideChestDown",
    25: "LeftSideChestDown",
    26: "RibcageLow",
}
_BODY_PARTS = {0: "Head", 1: "Chest", 2: "Stomach", 3: "LeftArm", 4: "RightArm", 5: "LeftLeg", 6: "RightLeg"}
_PLATE_COLLIDERS = {
    1: "Plate_Granit_SAPI_chest",
    2: "Plate_Granit_SAPI_back",
    4: "Plate_Granit_SSAPI_side_left_high",
    8: "Plate_Granit_SSAPI_side_left_low",
    16: "Plate_Granit_SSAPI_side_right_high",
    32: "Plate_Granit_SSAPI_side_right_low",
    64: "Plate_Korund_chest",
    128: "Plate_6B13_back",
    256: "Plate_Korund_side_left_high",
    512: "Plate_Korund_side_left_low",
    1024: "Plate_Korund_side_right_high",
    2048: "Plate_Korund_side_right_low",
}


def player_colliders(bundle_path):
    """{"body_parts": {collider: body part}, "plates": {plate zone: values}} from the player bundle.

    A body collider's own penetration values are replaced at runtime by the globals'
    BodyPartColliderSettings, so we only keep its body part. Plate colliders keep theirs."""
    import UnityPy

    body_parts, plates = {}, {}
    for obj in UnityPy.load(bundle_path).objects:
        if obj.type.name != "MonoBehaviour":
            continue
        tree = obj.read_typetree()
        if "BodyPartColliderType" not in tree or "BodyPartType" not in tree:
            continue
        collider = _COLLIDER_TYPES.get(tree["BodyPartColliderType"])
        body_part = _BODY_PARTS.get(tree["BodyPartType"])
        plate = _PLATE_COLLIDERS.get(tree.get("ArmorPlateColliderType"))
        if plate:
            plates[plate] = {
                "collider": collider,
                "body_part": body_part,
                "penetration_level": tree["PenetrationLevel"],
                "penetration_chance": round(tree["PenetrationChance"], 6),
                "penetration_damage_mod": round(tree["penetrationDamageMod"], 6),
                "fragmentation_chance": round(tree["FragmentationChance"], 6),
            }
        elif collider:
            body_parts[collider] = body_part
    return {"body_parts": dict(sorted(body_parts.items())), "plates": dict(sorted(plates.items()))}


def _player_bundle_path(items_path):
    explicit = os.environ.get("PLAYER_BUNDLE_PATH", "")
    if explicit:
        return explicit
    # items.json sits in <install>/SPT_Runtime/SPT_Data/database/templates/
    install = items_path
    for _ in range(5):
        install = os.path.dirname(install)
    return os.path.join(
        install,
        "EscapeFromTarkov_Data",
        "StreamingAssets",
        "Windows",
        "assets",
        "content",
        "commonprefabs",
        "playersuperior.bundle",
    )


def _existing_colliders():
    path = os.path.join(os.path.dirname(__file__), "spt_armor_stats.json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f).get("colliders")
    except (OSError, ValueError):
        return None


def _globals_path(items_path):
    explicit = os.environ.get("SPT_GLOBALS_PATH", "")
    if explicit:
        return explicit
    # SPT keeps items.json in database/templates/ and globals.json in database/
    return os.path.join(os.path.dirname(os.path.dirname(items_path)), "globals.json")


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

    globals_path = _globals_path(spt_path)
    if not os.path.isfile(globals_path):
        print(f"ERROR: SPT globals.json not found: {globals_path!r} - set SPT_GLOBALS_PATH")
        return
    with open(globals_path, encoding="utf-8") as f:
        globals_data = json.load(f)
    armor = {
        "globals": armor_globals(globals_data),
        "plate_slots": blunt_reduce_plate_slots(data),
    }
    bundle = _player_bundle_path(spt_path)
    try:
        armor["colliders"] = player_colliders(bundle)
    except ImportError:
        print("UnityPy isn't installed - keeping the colliders already in spt_armor_stats.json")
        armor["colliders"] = _existing_colliders()
    except OSError as error:
        print(f"Could not read the player bundle {bundle!r} ({error}) - keeping the existing colliders")
        armor["colliders"] = _existing_colliders()
    _write(armor, "spt_armor_stats.json", "armor sections")


if __name__ == "__main__":
    main()
