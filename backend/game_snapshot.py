"""Reads a game data snapshot: the game's own item definitions, trimmed to what we use.

A snapshot is a JSON file in the game's own shape, written by a data provider outside this
repository. Nothing here fetches one. Where a snapshot is configured (config.py's
GAME_SNAPSHOT_PATH and ARENA_SNAPSHOT_PATH) its values are first-party and fresh on patch
day; where none is, everything keeps working from tarkov.dev alone.

    {
      "format": 1,
      "game": "eft" | "arena",
      "version": "0.6.2.0.48720",          the client build the data came from
      "id": "<any stable id of this data state>",
      "detected": "2026-11-13T12:05:59+00:00",
      "items": {"<id>": {"_name", "_parent", "_type": "Item" | "Node", "_props": {...}}},
      "locale": {"en": {"<id> Name": ..., "<id> ShortName": ...}, "ch": {...}},
      "presets": {"<preset id>": {"_encyclopedia", "_name", "_items": [{_id, _tpl, parentId, slotId}]}},
      "arena": {...}                        Arena only, see sync_arena.py
    }

The path is either that file, or a folder holding index.json
({"snapshots": [{"file", "detected", "version", "id"}]}) beside several of them, of which
we take the newest. There is no waiting period: the builder always runs on the newest
data there is.

GameData turns the items into our models' column values. Units follow what the tarkov.dev
sync stores (sync_tarkov_dev.py), so a column means the same whichever source filled it:
tests/test_game_snapshot.py pins the conversions.
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

FORMAT = 1
INDEX_FILE = "index.json"

# The game's item class nodes we branch on, by their _name
WEAPON = "Weapon"
MOD = "Mod"
AMMO = "Ammo"
MAGAZINE = "Magazine"
BARREL = "Barrel"
SIGHTS = "Sights"

# weapon_category as the tarkov.dev sync writes it, by the weapon's class node
WEAPON_CATEGORY_BY_NODE = {
    "AssaultCarbine": "Assault carbine",
    "MarksmanRifle": "Marksman rifle",
    "SniperRifle": "Sniper rifle",
    "MachineGun": "Machinegun",
    "Smg": "SMG",
    "Shotgun": "Shotgun",
    "Pistol": "Handgun",
    "Revolver": "Revolver",
    "AssaultRifle": "Assault rifle",
    "GrenadeLauncher": "Grenade launcher",
}

# The weapon skill a weapon levels, by its class node (extract_spt_stats.py keeps the same
# table by node id)
WEAPON_SKILL_BY_NODE = {
    "Pistol": "Pistol",
    "Revolver": "Revolver",
    "Smg": "SMG",
    "AssaultRifle": "Assault",
    "AssaultCarbine": "Assault",
    "Shotgun": "Shotgun",
    "SniperRifle": "Sniper",
    "MachineGun": "LMG",
    "MarksmanRifle": "DMR",
}

# armor_kind by class node, nearest ancestor first. Rigs and eyewear only count with armor.
_ARMOR_KIND_BY_NODE = {
    "Armor": "armor",
    "Vest": "rig",
    "Headwear": "helmet",
    "ArmoredEquipment": "attachment",
    "ArmorPlate": "attachment",
    "BuiltInInserts": "attachment",
    "Visors": "eyewear",
    "FaceCover": "helmet",
}

# Slot conflicts the game itself ignores, {item id: slot ids}. The AX-15 4 inch handguard
# lists the A2 20 inch barrel's muzzle, gas block and launcher slots, which would lock that
# barrel's required gas block, yet in game the full build works.
IGNORED_CONFLICTING_SLOT_IDS = {
    "63f4ba71f31d4a33b87bd046": {  # AR-15 Aeroknox AX-15 4 inch M-LOK handguard
        "68a63ac58e1fe612970728f4",  # A2 20 inch barrel muzzle
        "68a63ac58e1fe612970728f5",  # A2 20 inch barrel gas block
        "68a63ac58e1fe612970728f6",  # A2 20 inch barrel launcher
    },
}

# Slot labels tarkov.dev words differently from the game's own, by the slot's name id or
# that id with its number dropped
_SLOT_LABEL_ALIASES = {
    "mod_equipment_000": "Gear",
    "mod_equipment_001": "Gear",
    "camora": "Chamber",
    "mod_flashlight": "Tactical",
    "mod_stock_akms": "Stock",
    "mod_stock_axis": "Stock",
}

# (column, prop) pairs copied as they are
_WEAPON_PROPS = [
    ("caliber", "ammoCaliber"),
    ("sighting_range", "SightingRange"),
    ("recoil_vertical", "RecoilForceUp"),
    ("recoil_horizontal", "RecoilForceBack"),
    ("center_of_impact", "CenterOfImpact"),
    ("camera_snap", "CameraSnap"),
    ("deviation_curve", "DeviationCurve"),
    ("deviation_max", "DeviationMax"),
    ("recoil_angle", "RecoilAngle"),
    ("camera_recoil", "RecoilCamera"),
    ("recoil_dispersion", "RecolDispersion"),
    ("fire_rate", "bFirerate"),
    ("velocity_modifier", "Velocity"),
    ("default_ammo_id", "defAmmo"),
    ("cam_angle_step", "CameraToWeaponAngleStep"),
    ("mount_cam_snap", "MountCameraSnapMultiplier"),
    ("mount_h_rec", "MountHorizontalRecoilMultiplier"),
    ("mount_v_rec", "MountVerticalRecoilMultiplier"),
    ("mount_breath", "MountingVerticalOutOfBreathMultiplier"),
    ("rec_hand_rot", "RecoilCategoryMultiplierHandRotation"),
    ("rec_force_back", "RecoilForceBack"),
    ("rec_force_up", "RecoilForceUp"),
    ("rec_return_speed", "RecoilReturnSpeedHandRotation"),
    ("recoil_damping_hand_rot", "RecoilDampingHandRotation"),
    ("recoil_return_path_damping", "RecoilReturnPathDampingHandRotation"),
    ("recoil_return_path_offset", "RecoilReturnPathOffsetHandRotation"),
    ("recoil_stable_index_shot", "RecoilStableIndexShot"),
    ("recoil_stable_angle_step", "RecoilStableAngleIncreaseStep"),
    ("recoil_pos_z_mult", "RecoilPosZMult"),
]

_AMMO_PROPS = [
    ("caliber", "Caliber"),
    ("ammo_damage", "Damage"),
    ("penetration_power", "PenetrationPower"),
    ("penetration_chance", "PenetrationChanceObstacle"),
    ("penetration_power_deviation", "PenetrationPowerDiviation"),
    ("ballistic_coefficient", "BallisticCoeficient"),
    ("bullet_mass_grams", "BulletMassGram"),
    ("bullet_diameter_mm", "BulletDiameterMilimeters"),
    ("armor_damage", "ArmorDamage"),
    ("velocity", "InitialSpeed"),
    ("tracer", "Tracer"),
    ("tracer_color", "TracerColor"),
    ("ammo_type", "ammoType"),
    ("projectile_count", "ProjectileCount"),
    ("fragmentation_chance", "FragmentationChance"),
    ("ricochet_chance", "RicochetChance"),
    ("stack_max_size", "StackMaxSize"),
    ("light_bleed_delta", "LightBleedingDelta"),
    ("heavy_bleed_delta", "HeavyBleedingDelta"),
    ("heat_factor", "HeatFactor"),
    ("durability_burn_factor", "DurabilityBurnModificator"),
    ("penetration_damage_mod", "PenetrationDamageMod"),
    ("malf_feed_chance", "MalfFeedChance"),
    ("misfire_chance", "MisfireChance"),
]

_MOD_PROPS = [
    ("heat_factor", "HeatFactor"),
    ("cooling_factor", "CoolFactor"),
    ("durability_burn_factor", "DurabilityBurnModificator"),
    ("velocity_modifier", "Velocity"),
    ("loudness", "Loudness"),
]

# Mod factors stored empty when the game says exactly 1. They are the only columns where
# item_columns() answers None on purpose: everywhere else None means the data has no value.
NEUTRAL_AT_ONE = {"heat_factor", "cooling_factor", "durability_burn_factor"}

# Every stat column item_columns() can fill. An item's value for a column it has no say in
# (a weapon's magazine_capacity) is absent, never None, so an overwrite leaves it alone.
STAT_COLUMNS = sorted(
    {column for column, _ in _WEAPON_PROPS + _AMMO_PROPS + _MOD_PROPS}
    | {
        "weight",
        "ergonomics_modifier",
        "base_ergonomics",
        "recoil_modifier",
        "accuracy_modifier",
        "magazine_capacity",
        "ammo_accuracy_modifier",
        "ammo_recoil_modifier",
        "recoil_stable_angle",
        "recoil_center_y",
        "recoil_center_z",
        "speed_penalty",
        "turn_penalty",
        "ergo_penalty",
        "blocks_headwear",
        "blocks_eyewear",
    }
)


class SnapshotError(Exception):
    """The configured snapshot can't be used. The caller carries on without it."""


def _parse_time(value) -> datetime | None:
    try:
        when = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return when if when.tzinfo else when.replace(tzinfo=timezone.utc)


def pick_snapshot_file(path: str) -> str | None:
    """The snapshot file to read for `path`, or None when there is none.

    A file is taken as it is. In a folder, index.json lists the candidates and we take
    the newest one that is there."""
    if not path:
        return None
    if os.path.isfile(path):
        return path
    index_path = os.path.join(path, INDEX_FILE)
    if not os.path.isfile(index_path):
        return None
    try:
        with open(index_path, encoding="utf-8") as f:
            entries = json.load(f).get("snapshots") or []
    except (OSError, ValueError, AttributeError) as exc:
        raise SnapshotError(f"unreadable snapshot index {index_path}: {exc}") from exc
    best = None
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        detected = _parse_time(entry.get("detected"))
        name = entry.get("file")
        # A plain file name only: the index never gets to point outside its own folder
        if not detected or not isinstance(name, str) or os.path.basename(name) != name:
            continue
        if not os.path.isfile(os.path.join(path, name)):
            continue
        if best is None or detected > best[0]:
            best = (detected, name)
    return os.path.join(path, best[1]) if best else None


def load_snapshot(file_path: str) -> dict:
    try:
        with open(file_path, encoding="utf-8") as f:
            snapshot = json.load(f)
    except (OSError, ValueError) as exc:
        raise SnapshotError(f"unreadable snapshot {file_path}: {exc}") from exc
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("items"), dict):
        raise SnapshotError(f"{file_path} is not a game snapshot")
    if snapshot.get("format") != FORMAT:
        raise SnapshotError(f"{file_path} has snapshot format {snapshot.get('format')!r}, we read {FORMAT}")
    return snapshot


def _number(value):
    """A game number as a float or int, or None. Some arrive as strings ("3")."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        try:
            number = float(value)
        except ValueError:
            return None
        return int(number) if number.is_integer() else number
    return None


def _fraction(value):
    """A game percentage (-9) as the fraction we store (-0.09)."""
    number = _number(value)
    return None if number is None else round(number / 100, 6)


def _slot_label(name_id: str, locale: dict) -> str:
    """A slot's English name the way tarkov.dev shows it: the game's own label for the slot
    ("MOD_PISTOL_GRIP" is "PISTOL GRIP"), numbered slots sharing their base name's."""
    alias = _SLOT_LABEL_ALIASES.get(name_id) or _SLOT_LABEL_ALIASES.get(name_id.rstrip("0123456789").rstrip("_"))
    if alias:
        return alias
    key = name_id.upper()
    text = locale.get(key)
    if text is None:
        base = key.rstrip("0123456789").rstrip("_")
        text = locale.get(base)
    if text is None:
        text = key.removeprefix("MOD_").replace("_", " ")
    return " ".join(word.capitalize() for word in str(text).split())


class GameData:
    """One snapshot's items, read into our models' terms."""

    def __init__(self, snapshot: dict):
        self.snapshot = snapshot
        self.entries: dict = snapshot["items"]
        locale = snapshot.get("locale") or {}
        self.en: dict = locale.get("en") or {}
        self.zh: dict = locale.get("ch") or {}
        self._chains: dict[str, tuple] = {}
        self._children: dict[str, list] | None = None
        self.item_ids = [
            item_id
            for item_id, entry in self.entries.items()
            if isinstance(entry, dict) and entry.get("_type") == "Item" and isinstance(entry.get("_props"), dict)
        ]
        self._item_set = set(self.item_ids)
        # Every slot id in the data, to tell a conflicting slot from a conflicting item
        self._slot_ids = {
            slot.get("_id")
            for item_id in self.item_ids
            for slot in self.entries[item_id]["_props"].get("Slots") or []
            if isinstance(slot, dict)
        }

    # ------------------------------------------------------------------
    # The class tree
    # ------------------------------------------------------------------

    def chain(self, item_id: str) -> tuple:
        """The item's own id, then each parent's up to the root."""
        cached = self._chains.get(item_id)
        if cached is not None:
            return cached
        out, seen, current = [], set(), item_id
        while current in self.entries and current not in seen:
            seen.add(current)
            out.append(current)
            current = self.entries[current].get("_parent")
        self._chains[item_id] = tuple(out)
        return self._chains[item_id]

    def nodes(self, item_id: str) -> list:
        """The _name of each class the item belongs to, nearest first."""
        return [self.entries[node_id].get("_name") for node_id in self.chain(item_id)[1:]]

    def is_a(self, item_id: str, node_name: str) -> bool:
        return node_name in self.nodes(item_id)

    def descendants(self, node_id: str) -> list:
        """Every item under a class node (or the item itself)."""
        if node_id in self._item_set:
            return [node_id]
        if self._children is None:
            self._children = {}
            for entry_id, entry in self.entries.items():
                if isinstance(entry, dict):
                    self._children.setdefault(entry.get("_parent"), []).append(entry_id)
        out, stack = [], [node_id]
        while stack:
            for child in self._children.get(stack.pop(), ()):
                if child in self._item_set:
                    out.append(child)
                else:
                    stack.append(child)
        return out

    def props(self, item_id: str) -> dict:
        return self.entries[item_id]["_props"]

    # ------------------------------------------------------------------
    # Names
    # ------------------------------------------------------------------

    def name(self, item_id: str, lang: str = "en", short: bool = False):
        table = self.zh if lang == "zh" else self.en
        return table.get(f"{item_id} {'ShortName' if short else 'Name'}")

    # ------------------------------------------------------------------
    # Item columns
    # ------------------------------------------------------------------

    def armor_kind(self, item_id: str):
        props = self.props(item_id)
        for node in self.nodes(item_id):
            kind = _ARMOR_KIND_BY_NODE.get(node)
            if kind is None:
                continue
            # A cap or a plain rig is that class too, but only what protects counts
            return kind if self._has_armor(props) else None
        return None

    def _has_armor(self, props: dict) -> bool:
        if (_number(props.get("armorClass")) or 0) > 0:
            return True
        return any(self._slot_filter(slot).get("Plate") for slot in props.get("Slots") or [])

    def item_columns(self, item_id: str) -> dict:
        """The stat columns this item's own data decides, in the units the tarkov.dev sync
        stores. A column the item has no say in is left out."""
        props = self.props(item_id)
        nodes = self.nodes(item_id)
        out = {"weight": _number(props.get("Weight")) or 0}

        if WEAPON in nodes:
            ergonomics = _number(props.get("Ergonomics")) or 0
            out["ergonomics_modifier"] = ergonomics
            out["base_ergonomics"] = ergonomics
            for column, prop in _WEAPON_PROPS:
                if prop in props:
                    out[column] = props[prop]
            # A flare gun names the whole ammo class here, which zeroes nothing
            if out.get("default_ammo_id") not in self._item_set:
                out.pop("default_ammo_id", None)
            stable = props.get("ProgressRecoilAngleOnStable")
            if isinstance(stable, dict):
                out["recoil_stable_angle"] = _number(stable.get("y"))
            center = props.get("RecoilCenter")
            if isinstance(center, dict):
                out["recoil_center_y"] = _number(center.get("y"))
                out["recoil_center_z"] = _number(center.get("z"))
        elif AMMO in nodes:
            for column, prop in _AMMO_PROPS:
                if prop in props:
                    out[column] = props[prop]
            out["ammo_accuracy_modifier"] = _fraction(props.get("ammoAccr"))
            out["ammo_recoil_modifier"] = _fraction(props.get("ammoRec"))
        elif MOD in nodes:
            out["ergonomics_modifier"] = _number(props.get("Ergonomics")) or 0
            # tarkov.dev's sync keeps a magazine's recoil at 0 and so do we
            if MAGAZINE in nodes:
                cartridges = props.get("Cartridges") or []
                if cartridges and isinstance(cartridges[0], dict):
                    out["magazine_capacity"] = _number(cartridges[0].get("_max_count"))
            else:
                out["recoil_modifier"] = _fraction(props.get("Recoil")) or 0
                # Sights carry these too, always neutral, and tarkov.dev's sync skips them
                for column, prop in () if SIGHTS in nodes else _MOD_PROPS:
                    if prop not in props:
                        continue
                    # A factor of exactly 1 changes nothing, and tarkov.dev leaves it empty
                    out[column] = None if column in NEUTRAL_AT_ONE and props[prop] == 1 else props[prop]
                if "Launcher" in nodes:
                    out["caliber"] = self._launcher_caliber(props)
            accuracy = _number(props.get("Accuracy"))
            if accuracy is not None:
                out["accuracy_modifier"] = accuracy
            if SIGHTS in nodes and "SightingRange" in props:
                out["sighting_range"] = props["SightingRange"]
            if BARREL in nodes:
                for column, prop in (
                    ("center_of_impact", "CenterOfImpact"),
                    ("deviation_curve", "DeviationCurve"),
                    ("deviation_max", "DeviationMax"),
                ):
                    if prop in props:
                        out[column] = props[prop]

        if self.armor_kind(item_id):
            out["speed_penalty"] = _fraction(props.get("speedPenaltyPercent"))
            out["turn_penalty"] = _fraction(props.get("mousePenalty"))
            out["ergo_penalty"] = _fraction(props.get("weaponErgonomicPenalty"))
            out["blocks_headwear"] = bool(props.get("BlocksHeadwear"))
            out["blocks_eyewear"] = bool(props.get("BlocksEyewear"))
        return out

    def _launcher_caliber(self, props: dict):
        """An underbarrel launcher has no caliber of its own: it fires what its chamber takes."""
        for chamber in props.get("Chambers") or []:
            for ammo_id in self._slot_filter(chamber).get("Filter") or []:
                if ammo_id in self._item_set:
                    caliber = self.props(ammo_id).get("Caliber")
                    if caliber:
                        return caliber
        return None

    def weapon_category(self, item_id: str):
        for node in self.nodes(item_id):
            if node in WEAPON_CATEGORY_BY_NODE:
                return WEAPON_CATEGORY_BY_NODE[node]
        return "Primary" if self.is_a(item_id, WEAPON) else None

    def weapon_skill(self, item_id: str):
        for node in self.nodes(item_id):
            if node in WEAPON_SKILL_BY_NODE:
                return WEAPON_SKILL_BY_NODE[node]
        return None

    def category_ids(self, item_id: str) -> list:
        return list(self.chain(item_id)[1:])

    # ------------------------------------------------------------------
    # Slots and conflicts
    # ------------------------------------------------------------------

    @staticmethod
    def _slot_filter(slot: dict) -> dict:
        filters = (slot.get("_props") or {}).get("filters") or []
        return filters[0] if filters and isinstance(filters[0], dict) else {}

    def slots(self, item_id: str) -> list:
        """The item's mod slots as {id, name, name_id, required, allowed}. A filter that
        names a class takes every item under it."""
        out = []
        for slot in self.props(item_id).get("Slots") or []:
            if not isinstance(slot, dict) or not slot.get("_id") or self.is_armor_slot(slot):
                continue
            allowed, seen = [], set()
            for entry in self._slot_filter(slot).get("Filter") or []:
                for allowed_id in self.descendants(entry):
                    if allowed_id not in seen:
                        seen.add(allowed_id)
                        allowed.append(allowed_id)
            name_id = slot.get("_name") or ""
            out.append(
                {
                    "id": slot["_id"],
                    "name_id": name_id,
                    "name": _slot_label(name_id, self.en),
                    "required": bool(slot.get("_required")),
                    "allowed": allowed,
                }
            )
        return out

    @classmethod
    def is_armor_slot(cls, slot: dict) -> bool:
        """A plate slot or a built-in armor section, which live in the armor tables."""
        slot_filter = cls._slot_filter(slot)
        return "Plate" in slot_filter or "locked" in slot_filter

    def conflicts(self, item_id: str) -> tuple:
        """(conflicting item ids, conflicting slot ids). The game lists both together."""
        item_ids, slot_ids = [], []
        ignored = IGNORED_CONFLICTING_SLOT_IDS.get(item_id, ())
        for entry in self.props(item_id).get("ConflictingItems") or []:
            if entry in self._slot_ids:
                if entry not in ignored:
                    slot_ids.append(entry)
            else:
                for conflicting in self.descendants(entry) if entry in self.entries else [entry]:
                    item_ids.append(conflicting)
        return item_ids, slot_ids

    # ------------------------------------------------------------------
    # Presets
    # ------------------------------------------------------------------

    def default_presets(self) -> dict:
        """{base item id: (preset id, [{"tpl", "slot", "parent_tpl"}...])} for each item's
        default preset: the one the game's encyclopedia shows for it."""
        out = {}
        for preset_id, preset in (self.snapshot.get("presets") or {}).items():
            if not isinstance(preset, dict):
                continue
            base_id = preset.get("_encyclopedia")
            items = preset.get("_items") or []
            if not base_id or base_id not in self._item_set or base_id in out:
                continue
            by_id = {part.get("_id"): part for part in items if isinstance(part, dict)}
            parts = []
            for part in items:
                if not isinstance(part, dict) or part.get("_tpl") not in self._item_set:
                    continue
                parent = by_id.get(part.get("parentId"))
                parts.append(
                    {
                        "tpl": part["_tpl"],
                        "slot": part.get("slotId"),
                        "parent_tpl": parent.get("_tpl") if parent else None,
                    }
                )
            out[base_id] = (preset_id, parts)
        return out

    # ------------------------------------------------------------------
    # Armor
    # ------------------------------------------------------------------

    def _piece_stats(self, props: dict) -> dict:
        ricochet = props.get("RicochetParams") if isinstance(props.get("RicochetParams"), dict) else {}
        return {
            "armor_class": _number(props.get("armorClass")),
            "durability": _number(props.get("MaxDurability", props.get("Durability"))),
            "material": props.get("ArmorMaterial"),
            "armor_type": props.get("ArmorType"),
            "blunt_throughput": _number(props.get("BluntThroughput")),
            "ricochet_x": _number(ricochet.get("x")),
            "ricochet_y": _number(ricochet.get("y")),
            "ricochet_z": _number(ricochet.get("z")),
        }

    def armor_rows(self) -> tuple:
        """(pieces, plate slots, default inserts) as column dicts for models_armor.py.

        A locked slot is a built-in armor section: its insert item carries the stats. An
        open one takes plates. An item with a class and no armor slots is the armor itself.
        """
        pieces, plate_slots, defaults = [], [], []
        presets = self.default_presets()
        for item_id in self.item_ids:
            if self.armor_kind(item_id) is None:
                continue
            props = self.props(item_id)
            armor_slots = [s for s in props.get("Slots") or [] if isinstance(s, dict) and self.is_armor_slot(s)]
            for slot in armor_slots:
                slot_filter = self._slot_filter(slot)
                name_id = slot.get("_name")
                insert_id = slot_filter.get("Plate") or None
                if slot_filter.get("locked"):
                    if insert_id not in self._item_set:
                        continue
                    insert = self.props(insert_id)
                    if not (_number(insert.get("armorClass")) or 0) > 0:
                        continue
                    pieces.append(
                        {
                            "holder_item_id": item_id,
                            "slot_name_id": name_id,
                            "insert_item_id": insert_id,
                            "name": self.name(insert_id),
                            "name_zh": self.name(insert_id, "zh"),
                            "body_colliders": ",".join(slot_filter.get("armorColliders") or []) or None,
                            "plate_colliders": ",".join(slot_filter.get("armorPlateColliders") or []) or None,
                            **self._piece_stats(insert),
                        }
                    )
                else:
                    allowed = [a for entry in slot_filter.get("Filter") or [] for a in self.descendants(entry)]
                    plate_slots.append(
                        {
                            "holder_item_id": item_id,
                            "slot_name_id": name_id,
                            "plate_colliders": ",".join(slot_filter.get("armorPlateColliders") or []) or None,
                            "allowed_plate_ids": ",".join(allowed) or None,
                            "blunt_reduce_from_soft_armor": bool(slot_filter.get("bluntDamageReduceFromSoftArmor")),
                        }
                    )
                    # What the item is sold with (its preset) comes before the slot's own default
                    sold_with = next(
                        (
                            part["tpl"]
                            for part in presets.get(item_id, (None, []))[1]
                            if part["parent_tpl"] == item_id and (part["slot"] or "").lower() == (name_id or "").lower()
                        ),
                        None,
                    )
                    default_id = sold_with or insert_id
                    if default_id in self._item_set:
                        defaults.append({"holder_item_id": item_id, "slot_name_id": name_id, "item_id": default_id})
            if not armor_slots and (_number(props.get("armorClass")) or 0) > 0:
                pieces.append(
                    {
                        "holder_item_id": item_id,
                        "slot_name_id": None,
                        "insert_item_id": None,
                        "name": self.name(item_id),
                        "name_zh": self.name(item_id, "zh"),
                        "body_colliders": ",".join(props.get("armorColliders") or []) or None,
                        "plate_colliders": ",".join(props.get("armorPlateColliders") or []) or None,
                        **self._piece_stats(props),
                    }
                )

        # The attachments a helmet comes with, from its default preset, slot by slot
        for base_id, (_, parts) in presets.items():
            if self.armor_kind(base_id) is None:
                continue
            for part in parts:
                if part["parent_tpl"] != base_id or not part["slot"] or not part["slot"].startswith("mod_"):
                    continue
                if self.armor_kind(part["tpl"]) == "attachment":
                    defaults.append({"holder_item_id": base_id, "slot_name_id": part["slot"], "item_id": part["tpl"]})
        return pieces, plate_slots, defaults


# ----------------------------------------------------------------------
# Applying a snapshot to the main game's tarkov.db
# ----------------------------------------------------------------------

_FLOAT_EPS = 1e-4


def _values_differ(old, new) -> bool:
    if isinstance(old, (int, float)) and isinstance(new, (int, float)):
        return abs(old - new) > _FLOAT_EPS
    return old != new


def file_stamp(file_path: str) -> str:
    """Changes whenever the snapshot file does."""
    stat = os.stat(file_path)
    return f"{os.path.basename(file_path)}:{stat.st_mtime_ns}:{stat.st_size}"


def _applied_file() -> str:
    from config import RUNTIME_DIR

    return os.path.join(RUNTIME_DIR, "game_snapshot_applied.json")


def applied_snapshot() -> dict:
    """{"stamp", "version", "detected", "applied_at"} of the snapshot tarkov.db last took
    its stats from, or {}."""
    try:
        with open(_applied_file(), encoding="utf-8") as f:
            value = json.load(f)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def apply_to_main_db(db, file_path: str) -> int:
    """Overwrite tarkov.db's item stats with the snapshot's. tarkov.dev is a step behind
    the game on patch day; a snapshot is the game's data itself.

    Only the stat columns change. Names, images, categories, prices, offers, slots and
    conflicts stay tarkov.dev's, and so does every item the snapshot doesn't know. Returns
    how many values changed, and records which snapshot was applied."""
    from models_items import Item

    data = GameData(load_snapshot(file_path))
    known = set(data.item_ids)
    items = db.query(Item).all()
    changed_items = changed_values = 0
    for item in items:
        if item.id not in known:
            continue
        # A rocket is ammo to the game and not to tarkov.dev: we only refresh what the
        # sync already treats as ammo, never retype an item
        if data.is_a(item.id, AMMO) and not item.is_ammo:
            continue
        changed = False
        for column, value in data.item_columns(item.id).items():
            # None means the snapshot has no value, except where empty is the value
            if value is None and column not in NEUTRAL_AT_ONE:
                continue
            # tarkov.dev works this label out itself (a flash round is "flashbang")
            if column == "ammo_type":
                continue
            current = getattr(item, column)
            # tarkov.dev leaves a stat empty where the game says zero. That is no change,
            # and writing the zero would log one for every such item in the Stat Tracker.
            if current is None and not value:
                continue
            if _values_differ(current, value):
                setattr(item, column, value)
                changed = True
                changed_values += 1
        changed_items += changed
    db.commit()

    # The factory figures were simulated from tarkov.dev's part stats, so run them again
    by_id = {item.id: item for item in items}
    for weapon in items:
        if not weapon.is_weapon or not weapon.factory_attachment_ids:
            continue
        total_weight = weapon.weight or 0
        total_ergo = weapon.base_ergonomics or 0
        total_recoil_modifier = 0.0
        for part_id in weapon.factory_attachment_ids.split(","):
            part = by_id.get(part_id)
            if part is None or part_id == weapon.id:
                continue
            total_weight += part.weight or 0
            total_ergo += part.ergonomics_modifier or 0
            total_recoil_modifier += part.recoil_modifier or 0
        weapon.factory_weight = total_weight
        weapon.factory_ergonomics = total_ergo
        if weapon.recoil_vertical is not None:
            weapon.factory_recoil_vertical = round(weapon.recoil_vertical * (1 + total_recoil_modifier))
        if weapon.recoil_horizontal is not None:
            weapon.factory_recoil_horizontal = round(weapon.recoil_horizontal * (1 + total_recoil_modifier))
    db.commit()

    record = {
        "stamp": file_stamp(file_path),
        "version": data.snapshot.get("version"),
        "detected": data.snapshot.get("detected"),
        "applied_at": time.time(),
    }
    try:
        tmp = _applied_file() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(record, f)
        os.replace(tmp, _applied_file())
    except OSError as exc:
        logger.warning("Could not record the applied game snapshot: %s", exc)
    logger.info(
        "Game snapshot %s applied: %d value(s) on %d item(s) differed from tarkov.dev.",
        record["version"] or os.path.basename(file_path),
        changed_values,
        changed_items,
    )
    return changed_values
