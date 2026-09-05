import json
import logging
import os
import requests
import time
from dotenv import load_dotenv

load_dotenv()
from datetime import datetime, timezone
from database import SessionLocal, Base, engine
from database_changelog import ChangelogSessionLocal, ChangelogBase, changelog_engine
from models_items import Item
from models_slots import Slot
from models_slot_allowed import SlotAllowedItem
from models_traders import Trader
from models_stat_changelog import StatChangeLog
from models_item_offers import ItemOffer
from models_weapon_presets import WeaponDefaultPreset
from solver_cache_epoch import bump_solver_cache_epoch

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

MAX_RETRIES = 3
RETRY_DELAY_SECS = 2

# tarkov.dev requires a user agent on all API requests, and a generic one
# (python-requests/x.y) risks being blocked as suspected abuse. Identify the
# project and link both the live site and the repo so they can see what it is.
USER_AGENT = "EFTForge (+https://eftforge.com; +https://github.com/SouthHorizons76/EFTForge)"

# Snapshot file persists the last known item stats across DB resets.
# Written at the end of every sync; read at the start of the next one.
# Anchored to RUNTIME_DIR (backend dir on web/dev, the app data dir in desktop
# mode) so these land in the right place regardless of the process cwd.
from config import RUNTIME_DIR as _RUNTIME_DIR

SNAPSHOT_FILE = os.path.join(_RUNTIME_DIR, "stat_snapshot.json")

# Records when a sync last completed, regardless of trigger (cron, hyperactive
# mode, or a dev background sync) - read by GET /sync-status for display.
LAST_SYNC_FILE = os.path.join(_RUNTIME_DIR, "last_sync.json")

# Stats tracked per category. Changes to these fields are logged on every sync.
_WEAPON_STATS = [
    "recoil_vertical",
    "recoil_horizontal",
    "base_ergonomics",
    "center_of_impact",
    "weight",
]
_ATTACHMENT_STATS = [
    "ergonomics_modifier",
    "recoil_modifier",
    "accuracy_modifier",
    "weight",
    "heat_factor",
    "cooling_factor",
    "durability_burn_factor",
    "velocity_modifier",
]
_AMMO_STATS = [
    "ammo_damage",
    "penetration_power",
    "armor_damage",
    "velocity",
    "fragmentation_chance",
    "heat_factor",
    "durability_burn_factor",
]
# Tolerance for float comparisons (avoids noise from floating-point representation)
_FLOAT_EPS = 1e-4


def _snapshot_items(db) -> dict:
    """Capture tracked stats for weapons and weapon-slot attachments before the wipe."""
    attachment_ids = {row[0] for row in db.query(SlotAllowedItem.allowed_item_id).distinct().all()}

    snapshot = {}
    for item in db.query(Item).all():
        if item.is_weapon:
            tracked = _WEAPON_STATS
        elif not item.is_ammo and item.id in attachment_ids:
            tracked = _ATTACHMENT_STATS
        elif item.is_ammo:
            tracked = _AMMO_STATS
        else:
            continue
        snapshot[item.id] = {
            "name": item.name,
            "stats": {s: getattr(item, s) for s in tracked},
        }
    return snapshot


def _floats_differ(a, b) -> bool:
    """Return True if two nullable float values are meaningfully different."""
    if a is None and b is None:
        return False
    if a is None or b is None:
        return True
    return abs(a - b) > _FLOAT_EPS


_NOT_YET_TRACKED = (
    object()
)  # sentinel: distinguishes "stat wasn't tracked in the old snapshot" from "stat was tracked and its value was null"

# stat_name used to flag a changelog row as "brand new item" rather than a stat
# diff - old_value/new_value are left null and the frontend renders it distinctly.
_NEW_ITEM_STAT = "new_item"


def _build_change_logs(db, snapshot: dict, sync_source: str, sync_time: datetime) -> list:
    """Compare current DB state against pre-wipe snapshot, return change log rows."""
    if not snapshot:
        return []

    items = db.query(Item).filter(Item.id.in_(list(snapshot.keys()))).all()
    logs = []

    for item in items:
        prev = snapshot[item.id]
        if item.is_weapon:
            tracked = _WEAPON_STATS
        elif item.is_ammo:
            tracked = _AMMO_STATS
        else:
            tracked = _ATTACHMENT_STATS

        for stat in tracked:
            old_val = prev["stats"].get(stat, _NOT_YET_TRACKED)
            if old_val is _NOT_YET_TRACKED:
                # This stat wasn't part of the tracked list when the snapshot was taken (e.g. a
                # newly-added stat like heat_factor) - not a real in-game change, skip it so the
                # first sync after adding a new tracked stat doesn't flood the tracker.
                continue
            new_val = getattr(item, stat)
            if _floats_differ(old_val, new_val):
                logs.append(
                    StatChangeLog(
                        item_id=item.id,
                        item_name=prev["name"],
                        stat_name=stat,
                        old_value=old_val,
                        new_value=new_val,
                        detected_at=sync_time,
                        sync_source=sync_source,
                    )
                )

    return logs


def _build_new_item_logs(db, snapshot: dict, sync_source: str, sync_time: datetime) -> list:
    """Flag items that exist now but weren't in the pre-sync snapshot as brand new
    additions (new weapon, attachment, or ammo added to the game/DB), so the tracker
    can surface them even though there's no prior value to diff against.

    Skipped entirely when snapshot is empty (first-ever sync / snapshot file missing)
    so that run doesn't log every single item in the DB as "new".
    """
    if not snapshot:
        return []

    attachment_ids = {row[0] for row in db.query(SlotAllowedItem.allowed_item_id).distinct().all()}

    logs = []
    for item in db.query(Item).all():
        if item.id in snapshot:
            continue
        if not (item.is_weapon or item.is_ammo or item.id in attachment_ids):
            continue
        logs.append(
            StatChangeLog(
                item_id=item.id,
                item_name=item.name,
                stat_name=_NEW_ITEM_STAT,
                old_value=None,
                new_value=None,
                detected_at=sync_time,
                sync_source=sync_source,
            )
        )
    return logs


def _load_snapshot_from_file() -> dict:
    """Load the last-known item stats from disk (survives DB resets)."""
    if not os.path.exists(SNAPSHOT_FILE):
        return {}
    try:
        with open(SNAPSHOT_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.warning("Could not read snapshot file - starting fresh. Reason: %s", e)
        return {}


def _save_snapshot_to_file(db) -> None:
    """Write current item stats to disk so the next sync can diff against them."""
    snapshot = _snapshot_items(db)
    try:
        with open(SNAPSHOT_FILE, "w", encoding="utf-8") as f:
            json.dump(snapshot, f)
        logger.info("Snapshot saved (%d items).", len(snapshot))
    except Exception as e:
        logger.warning("Could not write snapshot file: %s", e)


def _save_last_sync_time(sync_time: datetime) -> None:
    """Record when this sync completed, so the frontend can show data freshness."""
    try:
        with open(LAST_SYNC_FILE, "w", encoding="utf-8") as f:
            json.dump({"last_synced_at": sync_time.isoformat()}, f)
    except Exception as e:
        logger.warning("Could not write last-sync file: %s", e)


# -----------------------------------------------------------------------------
# tarkov.dev JSON API (https://json.tarkov.dev)
# -----------------------------------------------------------------------------
# The GraphQL endpoint (api.tarkov.dev/graphql) has been replaced by the
# natively-supported static JSON API. Each endpoint returns a language-neutral
# base payload whose translatable string fields hold placeholder tokens like
# "<id> Name"; the real strings live in a per-language overlay fetched by
# appending "_<lang>" to the path (e.g. /regular/items_en). The placeholder
# token IS the lookup key into the overlay's flat {token: string} map.
#
# Notable shape differences vs. GraphQL that this module adapts to:
#   - properties.__typename            -> properties.propertiesType
#   - item.categories[].name           -> category id strings resolved via itemCategories
#   - properties.defaultPreset object  -> preset id string resolved via items map
#   - slot.filters.allowedItems[].id   -> plain id strings
#   - item.conflictingItems[].id       -> plain id strings
#   - item.buyFor[]                    -> item.buyFromTrader[] (trader id, not vendor object)
#   - Item.accuracyModifier (percent)  -> properties.accuracyModifier (fraction; x100 here)
#   - cameraRecoil / convergence       -> absent (backfilled from SPT game files)
JSON_API_BASE = "https://json.tarkov.dev"
GAME_MODE = "regular"

EXCLUDED_VENDOR_NAMES = {"ragman", "ref", "fence", "flea-market"}


def _fetch_json(url, timeout, label):
    """GET a JSON endpoint with retries. Raises on final failure."""
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.get(url, timeout=timeout, headers={"User-Agent": USER_AGENT})
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.RequestException as e:
            logger.warning("%s fetch attempt %d failed: %s", label, attempt + 1, e)
            if attempt == MAX_RETRIES - 1:
                raise
            time.sleep(RETRY_DELAY_SECS)


def _fetch_json_optional(url, timeout, label):
    """GET a JSON endpoint with retries. Returns None on final failure (non-fatal)."""
    try:
        return _fetch_json(url, timeout, label)
    except requests.exceptions.RequestException:
        logger.warning("Could not fetch %s - continuing without it.", label)
        return None


def _overlay_map(payload):
    """Extract the flat {token: translated_string} map from an overlay response."""
    if not payload:
        return {}
    return payload.get("data") or {}


def _localize(overlay, token, default=None):
    """Resolve a placeholder token to its translated string via an overlay map."""
    if token is None:
        return default
    return overlay.get(token, default)


def _leaf_category_id(cat_ids, item_categories):
    """Pick the most specific ("leaf") category id out of an item's raw category
    id list. tarkov.dev lists an item's full ancestor chain (e.g. a reflex sight
    carries both "Compact reflex sight" and its parents "Sights"/"Functional
    mod"/...), so this drops any id that is another listed id's parent, then -
    if more than one candidate remains (an item spanning unrelated branches) -
    keeps whichever sits deepest in the category tree."""
    cat_ids = [cid for cid in (cat_ids or []) if cid in item_categories]
    if not cat_ids:
        return None
    parents_present = {item_categories[cid].get("parent") for cid in cat_ids}
    candidates = [cid for cid in cat_ids if cid not in parents_present]
    if not candidates:
        candidates = cat_ids
    if len(candidates) == 1:
        return candidates[0]

    def _depth(cid):
        depth = 0
        seen = set()
        while cid and cid not in seen:
            seen.add(cid)
            cid = item_categories.get(cid, {}).get("parent")
            depth += 1
        return depth

    return max(candidates, key=_depth)


def _sync_item_offers(db, items_map, trader_norm_map):
    """Populate item_offers with every trader offer (all loyalty levels, no
    vendor exclusions - the optimizer needs Ref/Fence/Ragman available and
    filters them per-request instead) plus one synthesized flea-market row per
    item, mirroring how the original optimizer's jsonApiAdapter.ts synthesizes
    flea pricing from the same fields since this JSON API has no flea entry
    inside buyFromTrader itself.

    Barter offers are skipped entirely - json.tarkov.dev doesn't expose them
    (only the old, currently-down GraphQL endpoint did).
    """
    offer_rows = []
    for item in items_map.values():
        item_id = item["id"]
        for offer in item.get("buyFromTrader") or []:
            vendor = trader_norm_map.get(offer.get("trader"))
            if not vendor:
                continue
            offer_rows.append(
                ItemOffer(
                    item_id=item_id,
                    vendor_normalized=vendor,
                    trader_level=offer.get("minTraderLevel"),
                    price=offer.get("price"),
                    currency=offer.get("currency"),
                    price_rub=offer.get("priceRUB"),
                    is_flea=False,
                )
            )

        # Flea: no dedicated field on this API, so synthesize one row from the
        # market-stats fields already on the item (same approach the optimizer's
        # own adapter uses). Prefer avg24hPrice; fall back to lastLowPrice for
        # items with too little recent flea activity to have a 24h average.
        flea_price = item.get("avg24hPrice") or item.get("lastLowPrice")
        if flea_price:
            offer_rows.append(
                ItemOffer(
                    item_id=item_id,
                    vendor_normalized="flea-market",
                    trader_level=None,
                    price=flea_price,
                    currency="RUB",
                    price_rub=flea_price,
                    is_flea=True,
                    min_level_flea=item.get("minLevelForFlea"),
                )
            )

    db.bulk_save_objects(offer_rows)
    db.commit()
    logger.info("Item offers synced (%d rows).", len(offer_rows))


def _sync_weapon_default_presets(db, weapon_default_preset_ids):
    """Persist the weapon -> default-preset-item-id map so the optimizer can price
    the factory configuration as an alternative base. Table is created by
    Base.metadata.create_all if it doesn't exist yet; we wipe and repopulate."""
    db.query(WeaponDefaultPreset).delete()
    rows = [
        WeaponDefaultPreset(weapon_id=weapon_id, preset_id=preset_id)
        for weapon_id, preset_id in weapon_default_preset_ids.items()
    ]
    db.bulk_save_objects(rows)
    db.commit()
    logger.info("Weapon default-preset map synced (%d rows).", len(rows))


def _sync_spt_hidden_stats(db):
    """
    Supplementary sync from a local SPT items.json.
    Only fills fields that are still null after the tarkov.dev sync.
    Skipped silently if SPT_ITEMS_PATH is not set or the file does not exist.
    """
    spt_path = os.environ.get("SPT_ITEMS_PATH", "")
    fallback_path = os.path.join(os.path.dirname(__file__), "spt_weapon_stats.json")

    if spt_path and os.path.isfile(spt_path):
        source = spt_path
        full_file = True
    elif os.path.isfile(fallback_path):
        source = fallback_path
        full_file = False
    else:
        logger.info("No SPT data source found - skipping SPT supplementary sync.")
        return

    logger.info("Loading SPT data from %s ...", source)
    try:
        with open(source, encoding="utf-8") as f:
            raw = json.load(f)
    except Exception as e:
        logger.error("Failed to load SPT data: %s - skipping.", e)
        return

    # Full items.json has {id: {_props: {...}}}; extracted file has {id: {field: val}}
    def get_props(item_id):
        entry = raw.get(item_id)
        if not entry:
            return {}
        return entry.get("_props", entry) if full_file else entry

    weapons = db.query(Item).filter(Item.is_weapon == True).all()
    updated = 0

    for weapon in weapons:
        props = get_props(weapon.id)
        if not props:
            continue
        changed = False

        # Map: (db_column, _props_field)
        # tarkov.dev fields take priority - only fill if still null
        spt_fields = [
            ("aim_sensitivity", "AimSensitivity"),
            ("cam_angle_step", "CameraToWeaponAngleStep"),
            ("mount_cam_snap", "MountCameraSnapMultiplier"),
            ("mount_h_rec", "MountHorizontalRecoilMultiplier"),
            ("mount_v_rec", "MountVerticalRecoilMultiplier"),
            ("mount_breath", "MountingVerticalOutOfBreathMultiplier"),
            ("rec_hand_rot", "RecoilCategoryMultiplierHandRotation"),
            ("rec_force_back", "RecoilForceBack"),
            ("rec_force_up", "RecoilForceUp"),
            ("rec_return_speed", "RecoilReturnSpeedHandRotation"),
            # tarkov.dev API fields - use SPT as fallback if null
            ("center_of_impact", "CenterOfImpact"),
            ("camera_recoil", "CameraRecoil"),
            ("convergence", "Convergence"),
        ]

        for db_col, spt_key in spt_fields:
            if getattr(weapon, db_col) is None and spt_key in props:
                val = props[spt_key]
                # AimSensitivity can be a nested array - take scalar only
                if isinstance(val, list):
                    val = val[0][0] if val and isinstance(val[0], list) else None
                if val is not None:
                    setattr(weapon, db_col, val)
                    changed = True

        if changed:
            updated += 1

    db.commit()
    logger.info("SPT supplementary sync complete - updated %d weapons.", updated)


def sync_items(sync_source: str = "scheduled"):
    Base.metadata.create_all(bind=engine)
    ChangelogBase.metadata.create_all(bind=changelog_engine)
    db = SessionLocal()
    changelog_db = ChangelogSessionLocal()

    # Load the snapshot written by the previous sync. Using a file means this
    # survives DB resets (reset.py deletes tarkov.db before calling sync).
    sync_time = datetime.now(timezone.utc)
    pre_sync_snapshot = _load_snapshot_from_file()
    logger.info("Loaded pre-sync snapshot (%d items).", len(pre_sync_snapshot))

    logger.info("Clearing database...")
    db.query(SlotAllowedItem).delete()
    db.query(ItemOffer).delete()
    db.query(Slot).delete()
    db.query(Item).delete()
    db.commit()

    logger.info("Fetching tarkov.dev items...")

    base = _fetch_json(f"{JSON_API_BASE}/{GAME_MODE}/items", 60, "items")
    items_map = base["data"]["items"]  # {id: item}
    item_categories = base["data"]["itemCategories"]  # {id: {name(token), normalizedName, ...}}
    logger.info("Total items fetched: %d", len(items_map))

    # Localization overlays. English is required (item names must never be raw
    # placeholder tokens); Chinese is optional and skipped gracefully if missing.
    logger.info("Fetching localization overlays...")
    en = _overlay_map(_fetch_json(f"{JSON_API_BASE}/{GAME_MODE}/items_en", 60, "items_en"))
    zh = _overlay_map(_fetch_json_optional(f"{JSON_API_BASE}/{GAME_MODE}/items_zh", 60, "items_zh"))

    # Resolve category id strings to English display names so the weapon-class
    # matching below keeps working against WEAPON_CLASS_PRIORITY.
    cat_name_en = {cid: _localize(en, c.get("name"), c.get("normalizedName")) for cid, c in item_categories.items()}
    # Same, in Chinese, for the optimizer's attachment_category grouping below.
    cat_name_zh = {cid: _localize(zh, c.get("name"), c.get("normalizedName")) for cid, c in item_categories.items()}
    # tarkov.dev's own zh locale leaves some Handbook categories untranslated
    # (returns the English string verbatim) - patch the ones that can actually
    # show up as a weapon attachment's leaf category.
    cat_name_zh["5a74651486f7744e73386dd1"] = "辅助配件"  # Auxiliary Mod

    items_to_add = []

    # Store preset attachments temporarily
    weapon_presets = {}
    # weapon id -> its default preset's own item id (that preset is a separate
    # purchasable item; the optimizer prices it as an alternative base).
    weapon_default_preset_ids = {}

    for item in items_map.values():
        properties = item.get("properties")

        category_names = [cat_name_en.get(cid) for cid in (item.get("categories") or [])]
        weapon_category = None

        leaf_category_id = _leaf_category_id(item.get("categories"), item_categories)
        attachment_category = cat_name_en.get(leaf_category_id) if leaf_category_id else None
        attachment_category_zh = cat_name_zh.get(leaf_category_id) if leaf_category_id else None

        # Priority order: more specific classes before broader parents.
        # e.g. an assault carbine also carries "Assault rifle" (parent category),
        # so we take the highest-priority (most specific) match.
        # Both spellings are listed for each class to handle API inconsistencies.
        WEAPON_CLASS_PRIORITY = [
            "Assault carbine",  # must precede "Assault rifle"
            "Marksman rifle",
            "Sniper rifle",
            "Machinegun",  # actual tarkov.dev API name
            "Machine gun",  # fallback
            "Machine Gun",  # fallback
            "SMG",  # tarkov.dev API
            "Submachine gun",  # fallback
            "Shotgun",
            "Handgun",
            "Revolver",
            "Assault rifle",
            "Grenade launcher",  # tarkov.dev API (lowercase l)
            "Grenade Launcher",  # fallback
        ]
        best_priority = len(WEAPON_CLASS_PRIORITY)
        for name in category_names:
            if name in WEAPON_CLASS_PRIORITY:
                p = WEAPON_CLASS_PRIORITY.index(name)
                if p < best_priority:
                    best_priority = p
                    weapon_category = name

        typename = None
        recoilmodifier = 0
        base_ergonomics = 0
        sighting_range = None
        is_weapon = False
        preset_attachment_ids = []
        caliber = None
        magazine_capacity = None
        is_ammo = False
        conflicting_item_ids = []
        conflicting_slot_ids = []
        recoil_vertical = None
        recoil_horizontal = None
        center_of_impact = None
        camera_snap = None
        deviation_curve = None
        deviation_max = None
        recoil_angle = None
        camera_recoil = None
        convergence = None
        recoil_dispersion = None
        ammo_damage = None
        penetration_power = None
        armor_damage = None
        velocity = None
        ammo_tracer = None
        ammo_tracer_color = None
        ammo_type = None
        penetration_chance = None
        penetration_power_deviation = None
        projectile_count = None
        fragmentation_chance = None
        ricochet_chance = None
        stack_max_size = None
        ammo_accuracy_mod = None
        ammo_recoil_mod = None
        light_bleed_delta = None
        heavy_bleed_delta = None
        heat_factor = None
        cooling_factor = None
        durability_burn_factor = None
        velocity_modifier = None

        item_weight = item.get("weight") or 0
        # tarkov.dev GraphQL exposed Item.accuracyModifier as a percentage; the JSON
        # API only carries the raw fraction under properties, so scale by 100. Ammo and
        # weapons never carried a top-level accuracy modifier, so they stay null.
        accuracy_modifier = None

        icon_link = item.get("iconLink")
        base_image_link = item.get("baseImageLink")
        image_512_link = None
        bare_image_512_link = None
        preset_icon_link = None

        if properties:
            typename = properties.get("propertiesType")

            if typename not in ("ItemPropertiesAmmo", "ItemPropertiesWeapon"):
                acc = properties.get("accuracyModifier")
                if acc is not None:
                    # round() avoids float noise from the x100 scaling (e.g. 7.0000000001)
                    accuracy_modifier = round(acc * 100, 4)

            # --------------------------
            # Weapon
            # --------------------------
            if typename == "ItemPropertiesWeapon":
                is_weapon = True
                base_ergonomics = properties.get("ergonomics") or 0
                caliber = properties.get("caliber")
                sighting_range = properties.get("sightingRange")
                recoil_vertical = properties.get("recoilVertical")
                recoil_horizontal = properties.get("recoilHorizontal")
                center_of_impact = properties.get("centerOfImpact")
                camera_snap = properties.get("cameraSnap")
                deviation_curve = properties.get("deviationCurve")
                deviation_max = properties.get("deviationMax")
                recoil_angle = properties.get("recoilAngle")
                # cameraRecoil / convergence are not exposed by the JSON API; they are
                # left null here and backfilled from SPT game files by
                # _sync_spt_hidden_stats() below.
                recoil_dispersion = properties.get("recoilDispersion")

                # Override weapons that tarkov.dev mis-categorizes or where the
                # API parent category wins over what the game actually calls them.
                WEAPON_CLASS_OVERRIDES = {
                    # Long-gun revolvers (tarkov.dev calls them "Revolver" but they're not pistols)
                    "60db29ce99594040e04c4a27": "Shotgun",  # MTs-255-12
                    "6275303a9f372d6ea97f9ec7": "Grenade launcher",  # Milkor M32A1 (lowercase to match API)
                    # Carbines that tarkov.dev only tags "Assault rifle"
                    "5c07c60e0db834002330051f": "Assault carbine",  # ADAR 2-15
                    "628b5638ad252a16da6dd245": "Assault carbine",  # SAG AK-545
                    "628b9c37a733087d0d7fe84b": "Assault carbine",  # SAG AK-545 Short
                    "5d43021ca4b9362eab4b5e25": "Assault carbine",  # Lone Star TX-15 DML
                    "59e6152586f77473dc057aa1": "Assault carbine",  # VPO-136 Vepr-KM
                    "59e6687d86f77411d949b251": "Assault carbine",  # VPO-209 .366 TKM
                    "5f2a9575926fd9352339381f": "Assault carbine",  # Kel-Tec RFB
                }
                if item["id"] in WEAPON_CLASS_OVERRIDES:
                    weapon_category = WEAPON_CLASS_OVERRIDES[item["id"]]

                # Fallback if no class matched from the categories loop
                if weapon_category is None:
                    weapon_category = "Primary"
                    logger.warning(
                        "[UNMATCHED] %s - categories: %s", _localize(en, item.get("name"), item["id"]), category_names
                    )

                bare_image_512_link = item.get("image512pxLink")
                image_512_link = bare_image_512_link

                # --------------------------
                # Default Preset Handling
                # The JSON API returns defaultPreset as a preset item id; look it up in
                # the items map for the composed images and the contained attachments.
                # --------------------------
                preset_id = properties.get("defaultPreset")
                default_preset = items_map.get(preset_id) if preset_id else None
                if preset_id:
                    weapon_default_preset_ids[item["id"]] = preset_id
                if default_preset:
                    preset_image = default_preset.get("image512pxLink")
                    if preset_image:
                        image_512_link = preset_image
                    preset_icon_link = default_preset.get("iconLink") or None
                    for entry in default_preset.get("containsItems", []):
                        if entry.get("item"):
                            preset_attachment_ids.append(entry["item"])

                weapon_presets[item["id"]] = preset_attachment_ids

            # --------------------------
            # Recoil Modifier
            # --------------------------
            if typename in ["ItemPropertiesWeaponMod", "ItemPropertiesBarrel", "ItemPropertiesScope"]:
                recoilmodifier = properties.get("recoilModifier") or 0
            if typename == "ItemPropertiesScope":
                sighting_range = properties.get("sightingRange")
            if typename == "ItemPropertiesBarrel":
                center_of_impact = properties.get("centerOfImpact")
                deviation_curve = properties.get("deviationCurve")
                deviation_max = properties.get("deviationMax")
            if typename in ["ItemPropertiesWeaponMod", "ItemPropertiesBarrel"]:
                heat_factor = properties.get("heatFactor")
                cooling_factor = properties.get("coolingFactor")
                durability_burn_factor = properties.get("durabilityBurnFactor")
                # Muzzle velocity % modifier - NOT under properties like the other mod stats;
                # the JSON API only exposes this as a top-level Item field (mirrors the GraphQL
                # schema's Item.velocity, distinct from ItemPropertiesAmmo.initialSpeed). Already
                # a plain percentage (e.g. -2 for -2%), no scaling needed.
                velocity_modifier = item.get("velocity")

            # --------------------------
            # Magazine
            # --------------------------
            if typename == "ItemPropertiesMagazine":
                magazine_capacity = properties.get("capacity")

            # --------------------------
            # Ammo
            # --------------------------
            if typename == "ItemPropertiesAmmo":
                caliber = properties.get("caliber")
                is_ammo = True
                ammo_damage = properties.get("damage")
                penetration_power = properties.get("penetrationPower")
                penetration_chance = properties.get("penetrationChance")
                penetration_power_deviation = properties.get("penetrationPowerDeviation")
                armor_damage = properties.get("armorDamage")
                velocity = properties.get("initialSpeed")
                ammo_tracer = properties.get("tracer")
                ammo_tracer_color = properties.get("tracerColor")
                ammo_type = properties.get("ammoType")
                projectile_count = properties.get("projectileCount")
                fragmentation_chance = properties.get("fragmentationChance")
                ricochet_chance = properties.get("ricochetChance")
                stack_max_size = properties.get("stackMaxSize")
                ammo_accuracy_mod = properties.get("accuracyModifier")
                ammo_recoil_mod = properties.get("recoilModifier")
                light_bleed_delta = properties.get("lightBleedModifier")
                heavy_bleed_delta = properties.get("heavyBleedModifier")
                heat_factor = properties.get("heatFactor")
                durability_burn_factor = properties.get("durabilityBurnFactor")

        # --------------------------
        # UBGL caliber overrides
        # UBGLs are synced as weapon mods and get no caliber from the API.
        # Map their IDs to the grenade caliber they accept.
        # --------------------------
        UBGL_CALIBER_MAP = {
            "62e7e7bbe6da9612f743f1e0": "Caliber40mmRU",  # GP-25 Kostyor 40mm
            "6357c98711fb55120211f7e1": "Caliber40x46",  # M203 40mm
        }
        if item["id"] in UBGL_CALIBER_MAP:
            caliber = UBGL_CALIBER_MAP[item["id"]]

        # --------------------------
        # Conflict Extraction
        # The JSON API returns conflictingItems as plain id strings.
        # --------------------------
        if item.get("conflictingItems"):
            conflicting_item_ids = list(item["conflictingItems"])

        if item.get("conflictingSlotIds"):
            conflicting_slot_ids = item["conflictingSlotIds"]

        db_item = Item(
            id=item["id"],
            name=_localize(en, item.get("name"), item.get("name")),
            short_name=_localize(en, item.get("shortName")),
            name_zh=_localize(zh, item.get("name")),
            short_name_zh=_localize(zh, item.get("shortName")),
            weight=item_weight,
            ergonomics_modifier=item.get("ergonomicsModifier") or 0,
            recoil_modifier=recoilmodifier,
            accuracy_modifier=accuracy_modifier,
            icon_link=icon_link,
            base_image_link=base_image_link,
            image_512_link=image_512_link,
            bare_image_512_link=bare_image_512_link if is_weapon else None,
            preset_icon_link=preset_icon_link if is_weapon else None,
            is_weapon=is_weapon,
            sighting_range=sighting_range,
            base_ergonomics=base_ergonomics,
            weapon_category=weapon_category,
            category_ids=",".join(item.get("categories") or []) or None,
            attachment_category=attachment_category,
            attachment_category_zh=attachment_category_zh,
            factory_ergonomics=None,
            factory_weight=None,
            factory_attachment_ids=",".join(preset_attachment_ids) if is_weapon else None,
            caliber=caliber,
            magazine_capacity=magazine_capacity,
            is_ammo=is_ammo,
            ammo_damage=ammo_damage,
            penetration_power=penetration_power,
            penetration_chance=penetration_chance,
            penetration_power_deviation=penetration_power_deviation,
            armor_damage=armor_damage,
            velocity=velocity,
            tracer=ammo_tracer,
            tracer_color=ammo_tracer_color,
            ammo_type=ammo_type,
            projectile_count=projectile_count,
            fragmentation_chance=fragmentation_chance,
            ricochet_chance=ricochet_chance,
            stack_max_size=stack_max_size,
            ammo_accuracy_modifier=ammo_accuracy_mod,
            ammo_recoil_modifier=ammo_recoil_mod,
            light_bleed_delta=light_bleed_delta,
            heavy_bleed_delta=heavy_bleed_delta,
            conflicting_item_ids=",".join(conflicting_item_ids) if conflicting_item_ids else None,
            conflicting_slot_ids=",".join(conflicting_slot_ids) if conflicting_slot_ids else None,
            recoil_vertical=recoil_vertical,
            recoil_horizontal=recoil_horizontal,
            factory_recoil_vertical=None,
            factory_recoil_horizontal=None,
            center_of_impact=center_of_impact,
            camera_snap=camera_snap,
            deviation_curve=deviation_curve,
            deviation_max=deviation_max,
            recoil_angle=recoil_angle,
            camera_recoil=camera_recoil,
            convergence=convergence,
            recoil_dispersion=recoil_dispersion,
            heat_factor=heat_factor,
            cooling_factor=cooling_factor,
            durability_burn_factor=durability_burn_factor,
            velocity_modifier=velocity_modifier,
        )

        items_to_add.append(db_item)

    db.bulk_save_objects(items_to_add)
    db.commit()

    logger.info("Items inserted.")

    # Build slot graph
    slots_to_add = []
    allowed_links_to_add = []
    seen_allowed_pairs = set()

    for item in items_map.values():
        properties = item.get("properties")
        if not properties:
            continue

        for slot in properties.get("slots", []):
            slot_id = slot["id"]

            slots_to_add.append(
                Slot(
                    id=slot_id,
                    parent_item_id=item["id"],
                    slot_name=_localize(en, slot.get("name"), slot.get("name")),
                    slot_game_name=slot.get("nameId"),
                    required=bool(slot.get("required", False)),
                )
            )

            filters = slot.get("filters") or {}
            # allowedItems is a list of plain item id strings in the JSON API.
            allowed_items = filters.get("allowedItems") or []

            for allowed in allowed_items:
                pair = (slot_id, allowed)

                if pair in seen_allowed_pairs:
                    continue

                seen_allowed_pairs.add(pair)

                allowed_links_to_add.append(
                    SlotAllowedItem(
                        slot_id=slot_id,
                        allowed_item_id=allowed,
                    )
                )

    if slots_to_add:
        db.bulk_save_objects(slots_to_add)

    if allowed_links_to_add:
        db.bulk_save_objects(allowed_links_to_add)

    db.commit()

    logger.info("Slot graph built.")

    # -----------------------------
    # FACTORY PRESET SIMULATION
    # -----------------------------

    logger.info("Simulating factory presets...")

    # Batch-load all weapon and attachment items needed for preset simulation
    all_preset_ids = set(weapon_presets.keys())
    for ids in weapon_presets.values():
        all_preset_ids.update(ids)
    preset_item_map = {item.id: item for item in db.query(Item).filter(Item.id.in_(all_preset_ids)).all()}

    for weapon_id, attachment_ids in weapon_presets.items():
        weapon = preset_item_map.get(weapon_id)
        if not weapon:
            logger.warning("Preset simulation: weapon %s not found in DB - skipping", weapon_id)
            continue

        total_weight = weapon.weight or 0
        total_ergo = weapon.base_ergonomics or 0
        total_recoil_modifier = 0.0

        for att_id in attachment_ids:
            if att_id == weapon_id:
                continue

            attachment = preset_item_map.get(att_id)
            if not attachment:
                logger.warning(
                    "Preset simulation: attachment %s for weapon '%s' not found - skipping", att_id, weapon.name
                )
                continue

            total_weight += attachment.weight or 0
            total_ergo += attachment.ergonomics_modifier or 0
            total_recoil_modifier += attachment.recoil_modifier or 0

        weapon.factory_weight = total_weight
        weapon.factory_ergonomics = total_ergo

        if weapon.recoil_vertical is not None:
            weapon.factory_recoil_vertical = round(weapon.recoil_vertical * (1 + total_recoil_modifier))
        if weapon.recoil_horizontal is not None:
            weapon.factory_recoil_horizontal = round(weapon.recoil_horizontal * (1 + total_recoil_modifier))

    db.commit()

    # ------------------------------------------
    # Fetch tasks (English + Chinese names) for trader task-unlock resolution.
    # buyFromTrader.taskUnlock is a plain task id, so we build id -> name maps here.
    # ------------------------------------------
    logger.info("Fetching tasks and localizing task names...")
    task_name_en = {}
    task_name_zh = {}
    tasks_base = _fetch_json_optional(f"{JSON_API_BASE}/{GAME_MODE}/tasks", 60, "tasks")
    if tasks_base is not None:
        tasks_data = (tasks_base.get("data") or {}).get("tasks") or {}
        tasks_en = _overlay_map(_fetch_json_optional(f"{JSON_API_BASE}/{GAME_MODE}/tasks_en", 60, "tasks_en"))
        tasks_zh = _overlay_map(_fetch_json_optional(f"{JSON_API_BASE}/{GAME_MODE}/tasks_zh", 60, "tasks_zh"))
        for tid, task in tasks_data.items():
            token = task.get("name")
            task_name_en[tid] = _localize(tasks_en, token)
            task_name_zh[tid] = _localize(tasks_zh, token)
        logger.info("Task name maps built (%d tasks).", len(task_name_en))

    # ------------------------------------------
    # Fetch traders. The trader id -> normalizedName map is also used to filter
    # excluded vendors out of the buy-price computation below.
    # ------------------------------------------
    logger.info("Fetching traders...")
    trader_norm_map = {}
    traders_payload = _fetch_json_optional(f"{JSON_API_BASE}/{GAME_MODE}/traders", 30, "traders")
    if traders_payload is not None:
        traders_data = traders_payload.get("data") or {}
        traders_en = _overlay_map(_fetch_json_optional(f"{JSON_API_BASE}/{GAME_MODE}/traders_en", 30, "traders_en"))
        db.query(Trader).delete()
        db.commit()
        trader_rows = []
        for tid, t in traders_data.items():
            norm = t.get("normalizedName")
            trader_norm_map[tid] = norm
            trader_rows.append(
                Trader(
                    id=tid,
                    name=_localize(traders_en, t.get("name"), norm),
                    normalized_name=norm,
                    image_link=t.get("imageLink"),
                    image_4x_link=None,  # not provided by the JSON API
                )
            )
        db.bulk_save_objects(trader_rows)
        db.commit()
        logger.info("Traders inserted (%d).", len(trader_rows))

    # ------------------------------------------
    # Full multi-trader/flea offer list, for the optimizer's budget and
    # trader-loyalty-level constraints. Item.trader_price/trader_vendor below
    # stay a separate, simpler "cheapest eligible offer" view for every other
    # page - this table is additive, not a replacement.
    # ------------------------------------------
    logger.info("Syncing full item offer list...")
    _sync_item_offers(db, items_map, trader_norm_map)

    logger.info("Syncing weapon default-preset map...")
    _sync_weapon_default_presets(db, weapon_default_preset_ids)

    # ------------------------------------------
    # Compute cheapest trader buy price per item from the already-fetched items.
    # ------------------------------------------
    logger.info("Computing trader prices from item buy offers...")
    updates = []
    for item in items_map.values():
        buy_for = item.get("buyFromTrader") or []
        allowed = [b for b in buy_for if trader_norm_map.get(b.get("trader")) not in EXCLUDED_VENDOR_NAMES]
        cheapest = min(allowed, key=lambda b: b.get("priceRUB") or float("inf")) if allowed else None
        task_unlock_id = cheapest.get("taskUnlock") if cheapest else None
        updates.append(
            {
                "id": item["id"],
                "trader_price": cheapest["price"] if cheapest else None,
                "trader_price_rub": cheapest["priceRUB"] if cheapest else None,
                "trader_currency": cheapest["currency"] if cheapest else None,
                "trader_vendor": trader_norm_map.get(cheapest["trader"]) if cheapest else None,
                "trader_min_level": cheapest.get("minTraderLevel") if cheapest else None,
                "task_unlock_id": task_unlock_id,
                "task_unlock_name": task_name_en.get(task_unlock_id) if task_unlock_id else None,
                "task_unlock_name_zh": task_name_zh.get(task_unlock_id) if task_unlock_id else None,
            }
        )
    db.bulk_update_mappings(Item, updates)
    db.commit()
    logger.info("Trader prices synced (%d items).", len(updates))

    # Diff new stats against the pre-sync snapshot and persist any changes,
    # plus flag items that are entirely new since the last sync.
    change_logs = _build_change_logs(db, pre_sync_snapshot, sync_source, sync_time)
    change_logs += _build_new_item_logs(db, pre_sync_snapshot, sync_source, sync_time)
    if change_logs:
        changelog_db.bulk_save_objects(change_logs)
        changelog_db.commit()
        logger.info("Logged %d stat change(s) from this sync.", len(change_logs))
    else:
        logger.info("No stat changes detected.")

    # ------------------------------------------
    # SPT supplementary sync (optional, local only)
    # ------------------------------------------
    _sync_spt_hidden_stats(db)

    # Write fresh snapshot to disk for the next sync to diff against
    _save_snapshot_to_file(db)
    _save_last_sync_time(sync_time)

    # Scratch-DB workers are followed by an atomic copy into the live DB; their
    # parent publishes the generation only after that copy finishes.
    if os.environ.get("EFTFORGE_SKIP_SOLVER_CACHE_EPOCH") != "1":
        bump_solver_cache_epoch()

    db.close()
    changelog_db.close()

    logger.info("Sync complete.")


if __name__ == "__main__":
    sync_items()
