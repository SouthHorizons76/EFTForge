import requests
import time
from database import SessionLocal, Base, engine
from models_items import Item
from models_slots import Slot
from models_slot_allowed import SlotAllowedItem

GRAPHQL_URL = "https://api.tarkov.dev/graphql"

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

    print("Clearing database...")
    db.query(SlotAllowedItem).delete()
    db.query(Slot).delete()
    db.query(Item).delete()
    db.commit()

    print("Fetching tarkov.dev graph...")

    max_retries = 3
    response = None

    for attempt in range(max_retries):
        try:
            response = requests.post(
                GRAPHQL_URL,
                json={"query": QUERY},
                timeout=60,
            )
            response.raise_for_status()
            break
        except Exception as e:
            print(f"Fetch attempt {attempt + 1} failed: {e}")
            if attempt == max_retries - 1:
                raise
            time.sleep(2)

    json_data = response.json()

    if "errors" in json_data:
        print("GraphQL errors:")
        print(json_data["errors"])
        return

    data = json_data["data"]["items"]
    print("Total items fetched:", len(data))

    items_to_add = []

    # Store preset attachments temporarily
    weapon_presets = {}

    for item in data:
        properties = item.get("properties")
        
        categories = item.get("categories") or []
        weapon_category = None

        for cat in categories:
            name = cat.get("name")
            if name in [
                "Assault rifle",
                "Submachine gun",
                "Marksman rifle",
                "Sniper rifle",
                "Shotgun",
                "Handgun",
                "Revolver",
                "Assault Carbine",
                "Machine Gun",
                "Grenade Launcher",
            ]:
                weapon_category = name
                break

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

                # --- Determine handgun ---
                is_handgun = False
                for cat in categories:
                    if cat.get("name") in ["Handgun", "Revolver"]:
                        is_handgun = True
                        break

                # Override long-gun revolvers
                REVOLVER_LONG_GUN_IDS = {
                    "60db29ce99594040e04c4a27",  # MTs-255-12
                    "6275303a9f372d6ea97f9ec7",  # Milkor M32A1
                }

                if item["id"] in REVOLVER_LONG_GUN_IDS:
                    is_handgun = False

                weapon_category = "Handgun" if is_handgun else "Primary"

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

    print("Items inserted.")

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

    print("Slot graph built.")

    # -----------------------------
    # FACTORY PRESET SIMULATION
    # -----------------------------

    print("Simulating factory presets...")

    for weapon_id, attachment_ids in weapon_presets.items():
        weapon = db.query(Item).filter(Item.id == weapon_id).first()
        if not weapon:
            continue

        total_weight = weapon.weight or 0
        total_ergo = weapon.base_ergonomics or 0
        total_recoil_modifier = 0.0

        for att_id in attachment_ids:
            if att_id == weapon_id:
                continue

            attachment = db.query(Item).filter(Item.id == att_id).first()
            if not attachment:
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
    db.close()

    print("Sync complete.")


if __name__ == "__main__":
    sync_items()