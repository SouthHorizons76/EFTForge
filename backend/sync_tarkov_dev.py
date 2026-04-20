import json
import logging
import os
import requests
import time
from dotenv import load_dotenv
load_dotenv()
from datetime import datetime, timezone
from database import SessionLocal, Base, engine
from models_items import Item
from models_slots import Slot
from models_slot_allowed import SlotAllowedItem
from models_traders import Trader
from models_stat_changelog import StatChangeLog

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

MAX_RETRIES = 3
RETRY_DELAY_SECS = 2

# Snapshot file persists the last known item stats across DB resets.
# Written at the end of every sync; read at the start of the next one.
SNAPSHOT_FILE = "stat_snapshot.json"

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
]
# Tolerance for float comparisons (avoids noise from floating-point representation)
_FLOAT_EPS = 1e-4


def _snapshot_items(db) -> dict:
    """Capture tracked stats for all weapons and attachments before the wipe."""
    snapshot = {}
    for item in db.query(Item).all():
        if item.is_weapon:
            tracked = _WEAPON_STATS
        elif not item.is_ammo:
            tracked = _ATTACHMENT_STATS
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


def _build_change_logs(db, snapshot: dict, sync_source: str, sync_time: datetime) -> list:
    """Compare current DB state against pre-wipe snapshot, return change log rows."""
    if not snapshot:
        return []

    items = db.query(Item).filter(Item.id.in_(list(snapshot.keys()))).all()
    logs = []

    for item in items:
        prev = snapshot[item.id]
        tracked = _WEAPON_STATS if item.is_weapon else _ATTACHMENT_STATS

        for stat in tracked:
            old_val = prev["stats"].get(stat)
            new_val = getattr(item, stat)
            if _floats_differ(old_val, new_val):
                logs.append(StatChangeLog(
                    item_id=item.id,
                    item_name=prev["name"],
                    stat_name=stat,
                    old_value=old_val,
                    new_value=new_val,
                    detected_at=sync_time,
                    sync_source=sync_source,
                ))

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


GRAPHQL_URL = "https://api.tarkov.dev/graphql"

QUERY_TRADERS = """
{
  traders {
    id
    name
    normalizedName
    imageLink
    image4xLink
  }
}
"""

EXCLUDED_VENDOR_NAMES = {"ragman", "ref", "fence", "flea-market"}

QUERY_PRICES = """
{
  items {
    id
    buyFor {
      vendor {
        name
        normalizedName
        ... on TraderOffer {
          minTraderLevel
          taskUnlock {
            id
            name
          }
        }
      }
      price
      currency
      priceRUB
    }
  }
}
"""

QUERY_ZH = """
{
  items(lang: zh) {
    id
    name
    shortName
  }
}
"""

QUERY_TASKS_ZH = """
{
  tasks(lang: zh) {
    id
    name
  }
}
"""

QUERY = """
{
  items {
    id
    name
    shortName
    weight
    ergonomicsModifier
    accuracyModifier
    gridImageLink
    image512pxLink
    iconLink

    conflictingItems { id }
    conflictingSlotIds

    categories {
      name
    }

    properties {
      __typename

      ... on ItemPropertiesWeapon {
        ergonomics
        caliber
        sightingRange
        recoilVertical
        recoilHorizontal
        centerOfImpact
        cameraSnap
        deviationCurve
        deviationMax
        recoilAngle
        cameraRecoil
        convergence
        recoilDispersion

        defaultPreset {
          iconLink
          image512pxLink
          containsItems {
            item { id }
          }
        }

        slots {
          id
          name
          nameId
          filters {
            allowedItems { id }
          }
        }
      }

      ... on ItemPropertiesWeaponMod {
        recoilModifier
        slots {
          id
          name
          nameId
          filters {
            allowedItems { id }
          }
        }
      }

      ... on ItemPropertiesMagazine {
        capacity
        slots {
          id
          name
          nameId
          filters {
            allowedItems { id }
          }
        }
      }

      ... on ItemPropertiesAmmo {
        caliber
      }

      ... on ItemPropertiesScope {
        recoilModifier
        sightingRange
        slots {
          id
          name
          nameId
          filters {
            allowedItems { id }
          }
        }
      }

      ... on ItemPropertiesBarrel {
        recoilModifier
        centerOfImpact
        deviationCurve
        deviationMax
        slots {
          id
          name
          nameId
          filters {
            allowedItems { id }
          }
        }
      }
    }
  }
}
"""

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
            ("aim_sensitivity",  "AimSensitivity"),
            ("cam_angle_step",   "CameraToWeaponAngleStep"),
            ("mount_cam_snap",   "MountCameraSnapMultiplier"),
            ("mount_h_rec",      "MountHorizontalRecoilMultiplier"),
            ("mount_v_rec",      "MountVerticalRecoilMultiplier"),
            ("mount_breath",     "MountingVerticalOutOfBreathMultiplier"),
            ("rec_hand_rot",     "RecoilCategoryMultiplierHandRotation"),
            ("rec_force_back",   "RecoilForceBack"),
            ("rec_force_up",     "RecoilForceUp"),
            ("rec_return_speed", "RecoilReturnSpeedHandRotation"),
            # tarkov.dev API fields - use SPT as fallback if null
            ("center_of_impact", "CenterOfImpact"),
            ("camera_recoil",    "CameraRecoil"),
            ("convergence",      "Convergence"),
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
    db = SessionLocal()

    # Load the snapshot written by the previous sync. Using a file means this
    # survives DB resets (reset.py deletes tarkov.db before calling sync).
    sync_time = datetime.now(timezone.utc)
    pre_sync_snapshot = _load_snapshot_from_file()
    logger.info("Loaded pre-sync snapshot (%d items).", len(pre_sync_snapshot))

    logger.info("Clearing database...")
    db.query(SlotAllowedItem).delete()
    db.query(Slot).delete()
    db.query(Item).delete()
    db.commit()

    logger.info("Fetching tarkov.dev graph...")

    response = None

    for attempt in range(MAX_RETRIES):
        try:
            response = requests.post(
                GRAPHQL_URL,
                json={"query": QUERY},
                timeout=60,
            )
            response.raise_for_status()
            break
        except requests.exceptions.RequestException as e:
            logger.warning("Fetch attempt %d failed: %s", attempt + 1, e)
            if attempt == MAX_RETRIES - 1:
                raise
            time.sleep(RETRY_DELAY_SECS)

    json_data = response.json()

    if "errors" in json_data:
        logger.error("GraphQL errors: %s", json_data["errors"])
        return

    data = json_data["data"]["items"]
    logger.info("Total items fetched: %d", len(data))

    items_to_add = []

    # Store preset attachments temporarily
    weapon_presets = {}

    for item in data:
        properties = item.get("properties")
        
        categories = item.get("categories") or []
        weapon_category = None

        # Priority order: more specific classes before broader parents.
        # e.g. an assault carbine also carries "Assault rifle" (parent category),
        # so we take the highest-priority (most specific) match.
        # Both spellings are listed for each class to handle API inconsistencies.
        WEAPON_CLASS_PRIORITY = [
            "Assault carbine",   # must precede "Assault rifle"
            "Marksman rifle",
            "Sniper rifle",
            "Machinegun",        # actual tarkov.dev API name
            "Machine gun",       # fallback
            "Machine Gun",       # fallback
            "SMG",               # tarkov.dev API
            "Submachine gun",    # fallback
            "Shotgun",
            "Handgun",
            "Revolver",
            "Assault rifle",
            "Grenade launcher",  # tarkov.dev API (lowercase l)
            "Grenade Launcher",  # fallback
        ]
        best_priority = len(WEAPON_CLASS_PRIORITY)
        for cat in categories:
            name = cat.get("name")
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

        item_weight = item.get("weight") or 0
        accuracy_modifier = item.get("accuracyModifier")

        icon_link = item.get("iconLink")
        image_512_link      = None
        bare_image_512_link = None
        preset_icon_link    = None
        
        if properties:
            typename = properties.get("__typename")

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
                camera_recoil = properties.get("cameraRecoil")
                convergence = properties.get("convergence")
                recoil_dispersion = properties.get("recoilDispersion")

                # Override weapons that tarkov.dev mis-categorizes or where the
                # API parent category wins over what the game actually calls them.
                WEAPON_CLASS_OVERRIDES = {
                    # Long-gun revolvers (tarkov.dev calls them "Revolver" but they're not pistols)
                    "60db29ce99594040e04c4a27": "Shotgun",           # MTs-255-12
                    "6275303a9f372d6ea97f9ec7": "Grenade launcher",  # Milkor M32A1 (lowercase to match API)
                    # Carbines that tarkov.dev only tags "Assault rifle"
                    "5c07c60e0db834002330051f": "Assault carbine",   # ADAR 2-15
                    "628b5638ad252a16da6dd245": "Assault carbine",   # SAG AK-545
                    "628b9c37a733087d0d7fe84b": "Assault carbine",   # SAG AK-545 Short
                    "5d43021ca4b9362eab4b5e25": "Assault carbine",   # Lone Star TX-15 DML
                    "59e6152586f77473dc057aa1": "Assault carbine",   # VPO-136 Vepr-KM
                    "59e6687d86f77411d949b251": "Assault carbine",   # VPO-209 .366 TKM
                    "5f2a9575926fd9352339381f": "Assault carbine",   # Kel-Tec RFB
                }
                if item["id"] in WEAPON_CLASS_OVERRIDES:
                    weapon_category = WEAPON_CLASS_OVERRIDES[item["id"]]

                # Fallback if no class matched from the categories loop
                if weapon_category is None:
                    weapon_category = "Primary"
                    raw_names = [c.get("name") for c in categories]
                    logger.warning("[UNMATCHED] %s - categories: %s", item['name'], raw_names)

                bare_image_512_link = item.get("image512pxLink")
                image_512_link      = bare_image_512_link

                default_preset = properties.get("defaultPreset")
                if default_preset:
                    preset_image = default_preset.get("image512pxLink")
                    if preset_image:
                        image_512_link = preset_image
                    preset_icon_link = default_preset.get("iconLink") or None

                # --------------------------
                # Default Preset Handling
                # --------------------------
                default_preset = properties.get("defaultPreset")
                if default_preset:
                    for entry in default_preset.get("containsItems", []):
                        if entry.get("item"):
                            preset_attachment_ids.append(entry["item"]["id"])

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
                deviation_curve  = properties.get("deviationCurve")
                deviation_max    = properties.get("deviationMax")

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

        # --------------------------
        # UBGL caliber overrides
        # UBGLs are synced as weapon mods and get no caliber from the API.
        # Map their IDs to the grenade caliber they accept.
        # --------------------------
        UBGL_CALIBER_MAP = {
            "62e7e7bbe6da9612f743f1e0": "Caliber40mmRU",   # GP-25 Kostyor 40mm
            "6357c98711fb55120211f7e1": "Caliber40x46",     # M203 40mm
        }
        if item["id"] in UBGL_CALIBER_MAP:
            caliber = UBGL_CALIBER_MAP[item["id"]]

        # --------------------------
        # Conflict Extraction
        # --------------------------
        if item.get("conflictingItems"):
            conflicting_item_ids = [
                c["id"] for c in item["conflictingItems"]
            ]

        if item.get("conflictingSlotIds"):
            conflicting_slot_ids = item["conflictingSlotIds"]
                
        db_item = Item(
            id=item["id"],
            name=item["name"],
            short_name=item.get("shortName"),
            weight=item_weight,
            ergonomics_modifier=item.get("ergonomicsModifier") or 0,
            recoil_modifier=recoilmodifier,
            accuracy_modifier=accuracy_modifier,
            icon_link=icon_link,
            image_512_link=image_512_link,
            bare_image_512_link=bare_image_512_link if is_weapon else None,
            preset_icon_link=preset_icon_link if is_weapon else None,
            is_weapon=is_weapon,
            sighting_range=sighting_range,
            base_ergonomics=base_ergonomics,
            weapon_category=weapon_category,
            factory_ergonomics=None,
            factory_weight=None,
            factory_attachment_ids=",".join(preset_attachment_ids) if is_weapon else None,
            caliber=caliber,
            magazine_capacity=magazine_capacity,
            is_ammo=is_ammo,
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
        )

        items_to_add.append(db_item)

    db.bulk_save_objects(items_to_add)
    db.commit()

    logger.info("Items inserted.")

    # Build slot graph
    slots_to_add = []
    allowed_links_to_add = []
    seen_allowed_pairs = set()

    for item in data:
        properties = item.get("properties")
        if not properties:
            continue

        for slot in properties.get("slots", []):
            slot_id = slot["id"]

            slots_to_add.append(
                Slot(
                    id=slot_id,
                    parent_item_id=item["id"],
                    slot_name=slot["name"],
                    slot_game_name=slot.get("nameId"),
                )
            )

            filters = slot.get("filters") or {}
            allowed_items = filters.get("allowedItems") or []

            for allowed in allowed_items:
                pair = (slot_id, allowed["id"])

                if pair in seen_allowed_pairs:
                    continue

                seen_allowed_pairs.add(pair)

                allowed_links_to_add.append(
                    SlotAllowedItem(
                        slot_id=slot_id,
                        allowed_item_id=allowed["id"],
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
    preset_item_map = {
        item.id: item
        for item in db.query(Item).filter(Item.id.in_(all_preset_ids)).all()
    }

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
                logger.warning("Preset simulation: attachment %s for weapon '%s' not found - skipping", att_id, weapon.name)
                continue

            total_weight += attachment.weight or 0
            total_ergo += attachment.ergonomics_modifier or 0
            total_recoil_modifier += attachment.recoil_modifier or 0

        weapon.factory_weight = total_weight
        weapon.factory_ergonomics = total_ergo

        if weapon.recoil_vertical is not None:
            weapon.factory_recoil_vertical = round(
                weapon.recoil_vertical * (1 + total_recoil_modifier)
            )
        if weapon.recoil_horizontal is not None:
            weapon.factory_recoil_horizontal = round(
                weapon.recoil_horizontal * (1 + total_recoil_modifier)
            )

    db.commit()

    # ------------------------------------------
    # Fetch Chinese (zh) names
    # ------------------------------------------
    logger.info("Fetching Chinese (zh) names...")
    zh_response = None
    for attempt in range(MAX_RETRIES):
        try:
            zh_response = requests.post(
                GRAPHQL_URL,
                json={"query": QUERY_ZH},
                timeout=60,
            )
            zh_response.raise_for_status()
            break
        except requests.exceptions.RequestException as e:
            logger.warning("ZH fetch attempt %d failed: %s", attempt + 1, e)
            if attempt == MAX_RETRIES - 1:
                logger.warning("Could not fetch Chinese names - skipping.")
                zh_response = None
            else:
                time.sleep(RETRY_DELAY_SECS)

    if zh_response is not None:
        zh_json = zh_response.json()
        if "errors" not in zh_json:
            zh_items = zh_json["data"]["items"]
            for zh_item in zh_items:
                db.query(Item).filter(Item.id == zh_item["id"]).update(
                    {
                        "name_zh": zh_item.get("name"),
                        "short_name_zh": zh_item.get("shortName"),
                    },
                    synchronize_session=False,
                )
            db.commit()
            logger.info("Chinese names applied (%d items).", len(zh_items))
        else:
            logger.error("GraphQL errors in ZH response - skipping Chinese names.")

    # ------------------------------------------
    # Fetch Chinese (zh) task names (map built here, applied during price sync)
    # ------------------------------------------
    logger.info("Fetching Chinese (zh) task names...")
    task_zh_map = {}
    tasks_zh_response = None
    for attempt in range(MAX_RETRIES):
        try:
            tasks_zh_response = requests.post(
                GRAPHQL_URL,
                json={"query": QUERY_TASKS_ZH},
                timeout=60,
            )
            tasks_zh_response.raise_for_status()
            break
        except requests.exceptions.RequestException as e:
            logger.warning("ZH tasks fetch attempt %d failed: %s", attempt + 1, e)
            if attempt == MAX_RETRIES - 1:
                logger.warning("Could not fetch Chinese task names - skipping.")
                tasks_zh_response = None
            else:
                time.sleep(RETRY_DELAY_SECS)

    if tasks_zh_response is not None:
        tasks_zh_json = tasks_zh_response.json()
        if "errors" not in tasks_zh_json:
            task_zh_map = {task["id"]: task["name"] for task in tasks_zh_json["data"]["tasks"]}
            logger.info("Chinese task name map built (%d tasks).", len(task_zh_map))
        else:
            logger.error("GraphQL errors in ZH tasks response - skipping.")

    # ------------------------------------------
    # Fetch traders
    # ------------------------------------------
    logger.info("Fetching traders...")
    trader_response = None
    for attempt in range(MAX_RETRIES):
        try:
            trader_response = requests.post(
                GRAPHQL_URL,
                json={"query": QUERY_TRADERS},
                timeout=30,
            )
            trader_response.raise_for_status()
            break
        except requests.exceptions.RequestException as e:
            logger.warning("Trader fetch attempt %d failed: %s", attempt + 1, e)
            if attempt == MAX_RETRIES - 1:
                logger.warning("Could not fetch traders - skipping.")
                trader_response = None
            else:
                time.sleep(RETRY_DELAY_SECS)

    if trader_response is not None:
        trader_json = trader_response.json()
        if "errors" not in trader_json:
            db.query(Trader).delete()
            db.commit()
            traders_data = trader_json["data"]["traders"]
            db.bulk_save_objects([
                Trader(
                    id=t["id"],
                    name=t["name"],
                    normalized_name=t.get("normalizedName"),
                    image_link=t.get("imageLink"),
                    image_4x_link=t.get("image4xLink"),
                )
                for t in traders_data
            ])
            db.commit()
            logger.info("Traders inserted (%d).", len(traders_data))
        else:
            logger.error("GraphQL errors in traders response - skipping.")

    # ------------------------------------------
    # Fetch trader prices
    # ------------------------------------------
    logger.info("Fetching trader prices...")
    price_response = None
    for attempt in range(MAX_RETRIES):
        try:
            price_response = requests.post(
                GRAPHQL_URL,
                json={"query": QUERY_PRICES},
                timeout=60,
            )
            price_response.raise_for_status()
            break
        except requests.exceptions.RequestException as e:
            logger.warning("Price fetch attempt %d failed: %s", attempt + 1, e)
            if attempt == MAX_RETRIES - 1:
                logger.warning("Could not fetch trader prices - skipping.")
                price_response = None
            else:
                time.sleep(RETRY_DELAY_SECS)

    if price_response is not None:
        price_json = price_response.json()
        if "errors" not in price_json:
            updates = []
            for item in price_json["data"]["items"]:
                buy_for = item.get("buyFor") or []
                allowed = [
                    b for b in buy_for
                    if (b.get("vendor") or {}).get("normalizedName") not in EXCLUDED_VENDOR_NAMES
                ]
                cheapest = min(allowed, key=lambda b: b.get("priceRUB") or float("inf")) if allowed else None
                task_unlock = cheapest["vendor"].get("taskUnlock") if cheapest else None
                updates.append({
                    "id":               item["id"],
                    "trader_price":     cheapest["price"]    if cheapest else None,
                    "trader_price_rub": cheapest["priceRUB"] if cheapest else None,
                    "trader_currency":  cheapest["currency"] if cheapest else None,
                    "trader_vendor":    cheapest["vendor"]["normalizedName"] if cheapest else None,
                    "trader_min_level": cheapest["vendor"].get("minTraderLevel") if cheapest else None,
                    "task_unlock_id":      task_unlock["id"]   if task_unlock else None,
                    "task_unlock_name":    task_unlock["name"] if task_unlock else None,
                    "task_unlock_name_zh": task_zh_map.get(task_unlock["id"]) if task_unlock else None,
                })
            db.bulk_update_mappings(Item, updates)
            db.commit()
            logger.info("Trader prices synced (%d items).", len(updates))
        else:
            logger.error("GraphQL errors in prices response - skipping.")

    # Diff new stats against the pre-sync snapshot and persist any changes
    change_logs = _build_change_logs(db, pre_sync_snapshot, sync_source, sync_time)
    if change_logs:
        db.bulk_save_objects(change_logs)
        db.commit()
        logger.info("Logged %d stat change(s) from this sync.", len(change_logs))
    else:
        logger.info("No stat changes detected.")

    # ------------------------------------------
    # SPT supplementary sync (optional, local only)
    # ------------------------------------------
    _sync_spt_hidden_stats(db)

    # Write fresh snapshot to disk for the next sync to diff against
    _save_snapshot_to_file(db)

    db.close()

    logger.info("Sync complete.")


if __name__ == "__main__":
    sync_items()