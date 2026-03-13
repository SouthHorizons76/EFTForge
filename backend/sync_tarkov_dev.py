import logging
import requests
import time
from database import SessionLocal, Base, engine
from models_items import Item
from models_slots import Slot
from models_slot_allowed import SlotAllowedItem

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

MAX_RETRIES = 3
RETRY_DELAY_SECS = 2

GRAPHQL_URL = "https://api.tarkov.dev/graphql"

QUERY_ZH = """
{
  items(lang: zh) {
    id
    name
    shortName
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
        recoilVertical
        recoilHorizontal

        defaultPreset {
          image512pxLink
          containsItems {
            item { id }
          }
        }

        slots {
          id
          name
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
        slots {
          id
          name
          filters {
            allowedItems { id }
          }
        }
      }

      ... on ItemPropertiesBarrel {
        recoilModifier
        slots {
          id
          name
          filters {
            allowedItems { id }
          }
        }
      }
    }
  }
}
"""

def sync_items():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()

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
        is_weapon = False
        preset_attachment_ids = []
        caliber = None
        magazine_capacity = None
        is_ammo = False
        conflicting_item_ids = []
        conflicting_slot_ids = []
        recoil_vertical = None
        recoil_horizontal = None

        item_weight = item.get("weight") or 0
        
        icon_link = item.get("iconLink")
        image_512_link = None
        
        if properties:
            typename = properties.get("__typename")

            # --------------------------
            # Weapon
            # --------------------------
            if typename == "ItemPropertiesWeapon":
                is_weapon = True
                base_ergonomics = properties.get("ergonomics") or 0
                caliber = properties.get("caliber")
                recoil_vertical = properties.get("recoilVertical")
                recoil_horizontal = properties.get("recoilHorizontal")

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
                    logger.warning("[UNMATCHED] %s — categories: %s", item['name'], raw_names)

                image_512_link = item.get("image512pxLink")

                default_preset = properties.get("defaultPreset")
                if default_preset:
                    preset_image = default_preset.get("image512pxLink")
                    if preset_image:
                        image_512_link = preset_image

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
            icon_link=icon_link,
            image_512_link=image_512_link,
            is_weapon=is_weapon,
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
            logger.warning("Preset simulation: weapon %s not found in DB — skipping", weapon_id)
            continue

        total_weight = weapon.weight or 0
        total_ergo = weapon.base_ergonomics or 0
        total_recoil_modifier = 0.0

        for att_id in attachment_ids:
            if att_id == weapon_id:
                continue

            attachment = preset_item_map.get(att_id)
            if not attachment:
                logger.warning("Preset simulation: attachment %s for weapon '%s' not found — skipping", att_id, weapon.name)
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
                logger.warning("Could not fetch Chinese names — skipping.")
                zh_response = None
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
            logger.error("GraphQL errors in ZH response — skipping Chinese names.")

    db.close()

    logger.info("Sync complete.")


if __name__ == "__main__":
    sync_items()