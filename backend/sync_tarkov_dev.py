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
    weight
    ergonomicsModifier
    properties {
      __typename

      ... on ItemPropertiesWeapon {
        ergonomics
        slots {
          id
          name
          filters {
            allowedItems { id }
          }
        }
      }

      ... on ItemPropertiesWeaponMod {
        slots {
          id
          name
          filters {
            allowedItems { id }
          }
        }
      }

      ... on ItemPropertiesBarrel {
        slots {
          id
          name
          filters {
            allowedItems { id }
          }
        }
      }

      ... on ItemPropertiesMagazine {
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

    print("Status code:", response.status_code)

    json_data = response.json()

    if "errors" in json_data:
        print("GraphQL errors:")
        print(json_data["errors"])
        return

    if not json_data.get("data"):
        print("No data returned!")
        print(json_data)
        return

    data = json_data["data"]["items"]
    print("Total items fetched:", len(data))

    # --------------------------
    # Insert Items
    # --------------------------

    items_to_add = []

    for item in data:
        properties = item.get("properties")

        typename = None
        if properties:
            typename = properties.get("__typename")

        is_weapon = typename == "ItemPropertiesWeapon"

        base_ergonomics = 0
        if is_weapon and properties:
            base_ergonomics = properties.get("ergonomics") or 0

        db_item = Item(
            id=item["id"],
            name=item["name"],
            weight=item.get("weight") or 0,
            ergonomics_modifier=item.get("ergonomicsModifier") or 0,
            is_weapon=is_weapon,
            base_ergonomics=base_ergonomics,
        )

        items_to_add.append(db_item)

    db.bulk_save_objects(items_to_add)
    db.commit()

    print("Items inserted.")

    # --------------------------
    # Build Slot Graph
    # --------------------------

    print("Building slot graph...")

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
    db.close()

    print("Sync complete.")


if __name__ == "__main__":
    sync_items()