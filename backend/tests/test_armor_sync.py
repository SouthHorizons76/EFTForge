"""Check how the sync turns tarkov.dev armor payloads into armor_pieces and armor_plate_slots."""

import os

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

CARRIER = {
    "id": "carrier",
    "name": "carrier Name",
    "properties": {
        "propertiesType": "ItemPropertiesArmor",
        # tarkov.dev aggregates; a holder's own values must not become a piece
        "class": 6,
        "durability": 510,
        "material": "Ceramic",
        "zones": ["Collider Type RibcageUp"],
        "armorSlots": [
            {
                "nameId": "Front_plate",
                "name": "Front_plate Name",
                "zones": ["Armor Zone Plate_Granit_SAPI_chest"],
                "allowedPlates": ["plate", "plate2"],
            },
            {
                "nameId": "Soft_armor_front",
                "name": "insert1 Name",
                "class": 3,
                "durability": 50,
                "armorMaterial": "Aramid",
                "armorType": "Heavy",
                "bluntThroughput": 0.33,
                "ricochetX": 0,
                "ricochetY": 0,
                "ricochetZ": 0,
                "zones": ["Collider Type RibcageUp", "Collider Type SpineTop"],
            },
        ],
    },
}
MASK = {
    "id": "mask",
    "name": "mask Name",
    "properties": {
        "propertiesType": "ItemPropertiesHelmet",
        "class": 5,
        "durability": 40,
        "material": "ArmoredSteel",
        "armorType": "Heavy",
        "bluntThroughput": 0.1,
        "ricochetX": 0.2,
        "ricochetY": 0.5,
        "ricochetZ": 70,
        "zones": ["Collider Type Eyes", "Collider Type Jaw"],
        "armorSlots": [],
    },
}
PLATE = {
    "id": "plate",
    "name": "plate Name",
    "properties": {
        "propertiesType": "ItemPropertiesArmorAttachment",
        "class": 5,
        "durability": 45,
        "material": "Ceramic",
        "armorType": "Heavy",
        "bluntThroughput": 0.2,
        "zones": ["Armor Zone Plate_Granit_SAPI_chest"],
        "armorSlots": [],
    },
}
PLAIN_RIG = {
    "id": "rig",
    "name": "rig Name",
    "properties": {"propertiesType": "ItemPropertiesChestRig", "capacity": 12, "grids": []},
}
AMMO = {"id": "ammo", "name": "ammo Name", "properties": {"propertiesType": "ItemPropertiesAmmo"}}

ITEMS = {item["id"]: item for item in (CARRIER, MASK, PLATE, PLAIN_RIG, AMMO)}
EN = {"insert1 Name": "Layers of aramid fiber", "mask Name": "Welding mask", "plate Name": "SAPI plate"}


@pytest.fixture(scope="module")
def sync():
    # Import lazily so collection does not initialize the application databases.
    os.environ.setdefault("IP_HASH_SECRET", "armor-test-secret")
    os.environ.setdefault("ADMIN_API_KEY", "armor-test-admin")
    import sync_tarkov_dev

    return sync_tarkov_dev


def _by_holder(rows):
    return {(row.holder_item_id, row.slot_name_id): row for row in rows}


def test_armor_kind_skips_unarmored_rigs(sync):
    assert sync._armor_kind("ItemPropertiesArmor", CARRIER["properties"]) == "armor"
    assert sync._armor_kind("ItemPropertiesChestRig", PLAIN_RIG["properties"]) is None
    assert sync._armor_kind("ItemPropertiesAmmo", {}) is None


def test_locked_slots_become_pieces_and_holder_aggregates_are_skipped(sync):
    pieces, _ = sync._build_armor_rows(ITEMS, EN, {})
    by_holder = _by_holder(pieces)

    assert set(by_holder) == {("carrier", "Soft_armor_front"), ("mask", None), ("plate", None)}
    insert = by_holder[("carrier", "Soft_armor_front")]
    assert insert.insert_item_id == "insert1"
    assert insert.name == "Layers of aramid fiber"
    assert (insert.armor_class, insert.durability, insert.material) == (3, 50, "Aramid")
    assert insert.body_colliders == "RibcageUp,SpineTop"
    assert insert.plate_colliders is None


def test_items_without_armor_slots_are_their_own_piece(sync):
    pieces, _ = sync._build_armor_rows(ITEMS, EN, {})
    by_holder = _by_holder(pieces)

    mask = by_holder[("mask", None)]
    assert (mask.armor_class, mask.material, mask.name) == (5, "ArmoredSteel", "Welding mask")
    assert (mask.ricochet_x, mask.ricochet_y, mask.ricochet_z) == (0.2, 0.5, 70)
    assert mask.body_colliders == "Eyes,Jaw"

    plate = by_holder[("plate", None)]
    assert plate.plate_colliders == "Plate_Granit_SAPI_chest"
    assert plate.body_colliders is None


def test_open_slots_become_plate_slots(sync):
    _, plate_slots = sync._build_armor_rows(ITEMS, EN, {})

    assert len(plate_slots) == 1
    slot = plate_slots[0]
    assert (slot.holder_item_id, slot.slot_name_id) == ("carrier", "Front_plate")
    assert slot.allowed_plate_ids == "plate,plate2"
    assert slot.plate_colliders == "Plate_Granit_SAPI_chest"


def test_blunt_reduce_flags_come_from_slot_filters():
    from extract_spt_stats import blunt_reduce_plate_slots

    spt_items = {
        "carrier": {
            "_props": {
                "Slots": [
                    {"_name": "Front_plate", "_props": {"filters": [{"bluntDamageReduceFromSoftArmor": True}]}},
                    {"_name": "Left_side_plate", "_props": {"filters": [{"bluntDamageReduceFromSoftArmor": False}]}},
                    {"_name": "mod_equipment", "_props": {"filters": []}},
                ]
            }
        },
        "ammo": {"_props": {}},
    }
    assert blunt_reduce_plate_slots(spt_items) == {"carrier": ["Front_plate"]}


def test_plate_slot_flags_apply_by_holder_and_slot(sync):
    from database import Base
    from models_armor import ArmorPlateSlot

    engine = create_engine("sqlite://")
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add_all(
        [
            ArmorPlateSlot(holder_item_id="carrier", slot_name_id="Front_plate"),
            ArmorPlateSlot(holder_item_id="carrier", slot_name_id="Back_plate"),
            ArmorPlateSlot(holder_item_id="other", slot_name_id="Front_plate"),
        ]
    )
    db.commit()

    sync._apply_plate_slot_flags(db, {"carrier": ["Front_plate"]})

    flags = {(s.holder_item_id, s.slot_name_id): s.blunt_reduce_from_soft_armor for s in db.query(ArmorPlateSlot)}
    assert flags == {
        ("carrier", "Front_plate"): True,
        ("carrier", "Back_plate"): False,
        ("other", "Front_plate"): False,
    }
    db.close()


def test_checked_in_armor_extract_has_the_globals_the_engine_needs():
    import json

    path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "spt_armor_stats.json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    armor_globals = data["globals"]
    assert armor_globals["class_resistance"][1:7] == [10, 20, 30, 40, 50, 60]
    assert {"Aramid", "Ceramic", "UHMWPE", "ArmoredSteel"} <= set(armor_globals["materials"])
    assert 0 < armor_globals["blunt_damage_reduce_from_soft_armor_mod"] <= 1
    assert data["plate_slots"]
