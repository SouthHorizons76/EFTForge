"""Check the armor catalog and zones the browser's ballistics engine reads."""

import os
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

AMMO = "a" * 24
BUCKSHOT = "b" * 24
VEST = "c" * 24
PLATE = "d" * 24
HELMET = "e" * 24
SHIELD = "f" * 24
MASK = "1" * 24
OTHER_VEST = "2" * 24
GLASSES = "3" * 24
EARS = "5" * 24
VISOR_MASK = "6" * 24

HEADWEAR = "5a341c4086f77401f2541505"
FACE_COVER = "5a341c4686f77469e155819e"
ARMOR_VEST = "5448e54d4bdc2dcc718b4568"
PLATE_CATEGORY = "644120aa86ffbe10ee032b6f"


@pytest.fixture(scope="module")
def api():
    # Import lazily so collection does not initialize the application databases.
    os.environ.setdefault("IP_HASH_SECRET", "armor-api-test-secret")
    os.environ.setdefault("ADMIN_API_KEY", "armor-api-test-admin")
    import main  # noqa: F401 - registers every model
    from database import Base
    from models_armor import ArmorDefaultInsert, ArmorPiece, ArmorPlateSlot
    from models_items import Item
    from models_slot_allowed import SlotAllowedItem
    from models_slots import Slot
    from routers import armor

    return SimpleNamespace(
        Base=Base,
        ArmorDefaultInsert=ArmorDefaultInsert,
        ArmorPiece=ArmorPiece,
        ArmorPlateSlot=ArmorPlateSlot,
        Item=Item,
        Slot=Slot,
        SlotAllowedItem=SlotAllowedItem,
        armor=armor,
    )


@pytest.fixture
def db(api):
    engine = create_engine("sqlite://")
    api.Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    item = api.Item
    session.add_all(
        [
            item(
                id=AMMO,
                name="PS",
                is_ammo=True,
                ammo_damage=61,
                penetration_power=35,
                armor_damage=52,
                velocity=700,
                bullet_mass_grams=7.9,
                bullet_diameter_mm=7.92,
                ballistic_coefficient=0.367,
            ),
            item(
                id=BUCKSHOT,
                name="Buck",
                is_ammo=True,
                ammo_damage=37,
                penetration_power=3,
                armor_damage=26,
                projectile_count=8,
            ),
            item(id=VEST, name="Carrier", armor_kind="armor", category_ids=ARMOR_VEST),
            item(id=OTHER_VEST, name="Other carrier", armor_kind="armor", category_ids=ARMOR_VEST),
            item(id=PLATE, name="SAPI", armor_kind="attachment", category_ids=PLATE_CATEGORY),
            item(id=HELMET, name="Helmet", armor_kind="helmet", category_ids=HEADWEAR),
            item(id=SHIELD, name="Shield", armor_kind="attachment", category_ids=""),
            item(id=EARS, name="Ear armor", armor_kind="attachment", category_ids="", conflicting_item_ids=MASK),
            item(id=MASK, name="Mask", armor_kind="helmet", category_ids=FACE_COVER),
            item(id=VISOR_MASK, name="Visor mask", armor_kind="helmet", category_ids=FACE_COVER, blocks_eyewear=True),
            item(id=GLASSES, name="Glasses", armor_kind="eyewear", category_ids=""),
        ]
    )
    # The helmet takes the shield in one slot and the ear armor in another
    session.add_all(
        [
            api.Slot(id="slot-shield", parent_item_id=HELMET, slot_game_name="mod_equipment_000"),
            api.Slot(id="slot-ears", parent_item_id=HELMET, slot_game_name="mod_equipment_001"),
            api.SlotAllowedItem(slot_id="slot-shield", allowed_item_id=SHIELD),
            api.SlotAllowedItem(slot_id="slot-ears", allowed_item_id=EARS),
            api.ArmorDefaultInsert(holder_item_id=VEST, slot_name_id="Front_plate", item_id=PLATE),
            api.ArmorDefaultInsert(holder_item_id=HELMET, slot_name_id="mod_equipment_000", item_id=SHIELD),
        ]
    )
    piece = api.ArmorPiece
    session.add_all(
        [
            piece(
                holder_item_id=VEST,
                slot_name_id="Soft_armor_front",
                name="Aramid",
                armor_class=2,
                durability=34,
                material="Aramid",
                armor_type="Light",
                blunt_throughput=0.33,
                body_colliders="RibcageUp,RibcageLow",
            ),
            piece(
                holder_item_id=PLATE,
                armor_class=5,
                durability=50,
                material="Ceramic",
                armor_type="Heavy",
                blunt_throughput=0.3,
                plate_colliders="Plate_Granit_SAPI_chest",
            ),
            piece(
                holder_item_id=HELMET,
                slot_name_id="Helmet_top",
                armor_class=4,
                durability=30,
                material="Aramid",
                armor_type="Light",
                blunt_throughput=0.2,
                body_colliders="ParietalHead",
            ),
            piece(
                holder_item_id=SHIELD,
                armor_class=2,
                durability=30,
                material="Glass",
                armor_type="Light",
                blunt_throughput=0.1,
                body_colliders="Eyes",
            ),
            piece(
                holder_item_id=GLASSES,
                armor_class=1,
                durability=25,
                material="Glass",
                armor_type="None",
                blunt_throughput=0.9,
                body_colliders="Eyes",
            ),
            piece(
                holder_item_id=MASK,
                armor_class=3,
                durability=35,
                material="UHMWPE",
                armor_type="Light",
                blunt_throughput=0.12,
                body_colliders="Eyes,Jaw",
            ),
        ]
    )
    session.add(
        api.ArmorPlateSlot(
            holder_item_id=VEST,
            slot_name_id="Front_plate",
            plate_colliders="Plate_Granit_SAPI_chest",
            allowed_plate_ids=PLATE,
            blunt_reduce_from_soft_armor=True,
        )
    )
    session.commit()
    yield session
    session.close()


def test_armor_items_lists_pieces_and_plate_slots(api, db):
    items = {item["id"]: item for item in api.armor.armor_items("en", db)}
    assert items[VEST]["kind"] == "armor"
    assert items[VEST]["equipment_slot"] == "armor"
    assert items[HELMET]["equipment_slot"] == "headwear"
    assert items[MASK]["equipment_slot"] == "face_cover"
    assert items[PLATE]["equipment_slot"] is None
    assert items[GLASSES]["equipment_slot"] == "eyewear"
    # 34 durability of aramid (destructibility 0.1875) soaks 181.3 raw armor damage
    assert items[VEST]["pieces"][0]["effective_durability"] == pytest.approx(34 / 0.1875)
    assert "speed_penalty" in items[VEST] and "weight" in items[VEST]
    assert items[VEST]["pieces"][0]["body_colliders"] == ["RibcageUp", "RibcageLow"]
    assert items[VEST]["plate_slots"] == [
        {
            "slot": "Front_plate",
            "plate_colliders": ["Plate_Granit_SAPI_chest"],
            "allowed_plate_ids": [PLATE],
            "blunt_reduce_from_soft_armor": True,
            "default_id": PLATE,
        }
    ]
    assert items[HELMET]["attachment_slots"] == [
        {"slot": "mod_equipment_000", "allowed_ids": [SHIELD], "default_id": SHIELD},
        {"slot": "mod_equipment_001", "allowed_ids": [EARS], "default_id": None},
    ]
    assert items[EARS]["conflicting_ids"] == [MASK]
    assert items[VISOR_MASK]["blocks_eyewear"] is True and items[MASK]["blocks_eyewear"] is False
    assert AMMO not in items


def test_zones_map_colliders_and_plates(api):
    zones = api.armor.armor_zones()
    assert zones["body_parts"]["RibcageUp"] == "Chest"
    assert zones["body_parts"]["RibcageLow"] == "Stomach"
    assert zones["body_parts"]["Eyes"] == "Head"
    assert zones["plates"]["Plate_Granit_SAPI_chest"] == {"collider": "RibcageUp", "body_part": "Chest"}
    assert zones["max_hp"]["Stomach"] == 70
