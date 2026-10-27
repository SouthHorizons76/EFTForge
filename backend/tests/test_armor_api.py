"""Check the armor endpoints build the right layers, in the game's order, from synced armor rows."""

import os
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
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
    from models_armor import ArmorPiece, ArmorPlateSlot
    from models_items import Item
    from routers import armor
    from services import solve_limits

    return SimpleNamespace(
        Base=Base, ArmorPiece=ArmorPiece, ArmorPlateSlot=ArmorPlateSlot, Item=Item, armor=armor, limits=solve_limits
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
            item(id=MASK, name="Mask", armor_kind="helmet", category_ids=FACE_COVER),
            item(id=GLASSES, name="Glasses", armor_kind="eyewear", category_ids=""),
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


def _simulate(api, db, **body):
    # Each call counts against the per-IP request throttle, so start from a clean slate
    api.limits._solve_request_last.clear()
    payload = api.armor.SimulateRequest(**body)
    request = SimpleNamespace(client=SimpleNamespace(host="test"), headers={})
    return api.armor.armor_simulate(request, payload, db)


def test_soft_armor_thorax_hit(api, db):
    result = _simulate(api, db, ammo_id=AMMO, equipment=[{"item_id": VEST}], collider="RibcageUp")
    assert result["hp"] == 85
    assert result["plates"] == []
    assert [layer["slot"] for layer in result["soft_layers"]] == ["Soft_armor_front"]
    chances = [shot["kill_chance"] for shot in result["shots"]]
    assert chances == sorted(chances) and chances[-1] > 0.99
    assert result["shots_to_kill"] is not None


def test_durability_percent_scales_every_piece(api, db):
    result = _simulate(
        api,
        db,
        ammo_id=AMMO,
        equipment=[{"item_id": VEST, "durability_percent": 50}],
        collider="RibcageUp",
    )
    assert result["soft_layers"][0]["durability"] == pytest.approx(17)


def test_helmet_attachment_comes_before_face_cover(api, db):
    # Listed mask first on purpose: the game checks Headwear (and its attachments) first
    result = _simulate(
        api,
        db,
        ammo_id=AMMO,
        equipment=[{"item_id": GLASSES}, {"item_id": MASK}, {"item_id": HELMET, "attachments": [SHIELD]}],
        collider="Eyes",
    )
    assert result["hp"] == 35
    # Headwear (and its attachments), then face cover, then eyewear
    assert [layer["item_id"] for layer in result["soft_layers"]] == [SHIELD, MASK, GLASSES]


def test_plate_hit_puts_the_flagged_plate_first(api, db):
    body = dict(
        ammo_id=AMMO,
        equipment=[{"item_id": VEST, "plates": {"Front_plate": {"item_id": PLATE}}}],
        collider="RibcageUp",
        plate_collider="Plate_Granit_SAPI_chest",
    )
    # The plate zone's own values come from the game files, so nothing else is needed
    result = _simulate(api, db, **body)
    assert result["body_part"] == "Chest"
    assert [layer["item_id"] for layer in result["plates"]] == [PLATE]
    assert [layer["slot"] for layer in result["soft_layers"]] == ["Soft_armor_front"]

    plates, _, _ = api.armor.build_layers(db, api.armor.SimulateRequest(**body), api.armor._armor_globals())
    assert plates[0].blunt_reduce_from_soft_armor is True


@pytest.mark.parametrize(
    "body, status",
    [
        (dict(ammo_id="0" * 24), 404),
        (dict(ammo_id="not-an-id"), 400),
        (dict(hp=50, collider="Eyes"), 422),  # more than a head's 35
        (dict(plate_collider="Plate_Granit_SAPI_back"), 422),  # back plate isn't in front of the chest
        (dict(plate_collider="Plate_Nonexistent"), 422),
        (dict(equipment=[{"item_id": VEST}, {"item_id": OTHER_VEST}]), 422),
        (dict(equipment=[{"item_id": PLATE}]), 422),
        (dict(equipment=[{"item_id": VEST, "attachments": [SHIELD]}]), 422),
        (dict(equipment=[{"item_id": VEST, "plates": {"Back_plate": {"item_id": PLATE}}}]), 422),
        (dict(equipment=[{"item_id": "9" * 24}]), 404),
    ],
)
def test_bad_requests_are_rejected(api, db, body, status):
    full = dict(ammo_id=AMMO, equipment=[], collider="RibcageUp")
    full.update(body)
    with pytest.raises(HTTPException) as error:
        _simulate(api, db, **full)
    assert error.value.status_code == status


def test_armor_items_lists_pieces_and_plate_slots(api, db):
    items = {item["id"]: item for item in api.armor.armor_items("en", db)}
    assert items[VEST]["kind"] == "armor"
    assert items[VEST]["equipment_slot"] == "armor"
    assert items[HELMET]["equipment_slot"] == "headwear"
    assert items[MASK]["equipment_slot"] == "face_cover"
    assert items[PLATE]["equipment_slot"] is None
    assert items[GLASSES]["equipment_slot"] == "eyewear"
    assert items[VEST]["pieces"][0]["body_colliders"] == ["RibcageUp", "RibcageLow"]
    assert items[VEST]["plate_slots"] == [
        {"slot": "Front_plate", "plate_colliders": ["Plate_Granit_SAPI_chest"], "allowed_plate_ids": [PLATE]}
    ]
    assert AMMO not in items


def test_distance_flies_the_bullet_and_weakens_the_hit(api, db):
    base = dict(ammo_id=AMMO, equipment=[{"item_id": VEST}], collider="RibcageUp")
    close = _simulate(api, db, **base)
    far = _simulate(api, db, distance=300, velocity_modifier_pct=1.8, **base)

    assert close["flight"] is None
    assert far["flight"]["muzzle_speed"] == pytest.approx(712.6)
    assert 0 < far["flight"]["speed_ratio"] < 1
    assert far["flight"]["drop"] > 0
    # Slower on arrival means less damage, so no shot kills more often from range
    for near_shot, far_shot in zip(close["shots"], far["shots"]):
        assert far_shot["kill_chance"] <= near_shot["kill_chance"] + 1e-9


def test_distance_needs_flight_data_and_excludes_speed_ratio(api, db):
    base = dict(equipment=[], collider="RibcageUp")
    with pytest.raises(HTTPException) as error:
        _simulate(api, db, ammo_id=AMMO, distance=100, speed_ratio=0.8, **base)
    assert error.value.status_code == 422
    db.query(api.Item).filter(api.Item.id == AMMO).update({"ballistic_coefficient": None})
    with pytest.raises(HTTPException) as error:
        _simulate(api, db, ammo_id=AMMO, distance=100, **base)
    assert error.value.status_code == 422


def test_buckshot_fires_every_pellet_and_caps_the_shots(api, db):
    result = _simulate(
        api,
        db,
        ammo_id=BUCKSHOT,
        equipment=[{"item_id": VEST}],
        collider="RibcageUp",
        max_shots=40,
        hp=85,
    )
    assert result["projectiles"] == 8
    # 320 pellet hits at most, so 8 pellets allow 40 shots at most
    assert len(result["shots"]) <= 40


def test_neck_hits_drain_the_thorax(api, db):
    result = _simulate(api, db, ammo_id=AMMO, equipment=[], collider="NeckFront")
    assert (result["body_part"], result["hp"]) == ("Chest", 85)


def test_zones_map_colliders_and_plates(api):
    zones = api.armor.armor_zones()
    assert zones["body_parts"]["RibcageUp"] == "Chest"
    assert zones["body_parts"]["RibcageLow"] == "Stomach"
    assert zones["body_parts"]["Eyes"] == "Head"
    assert zones["plates"]["Plate_Granit_SAPI_chest"] == {"collider": "RibcageUp", "body_part": "Chest"}
    assert zones["max_hp"]["Stomach"] == 70


def test_stomach_hits_spread_until_the_thorax_goes(api, db):
    result = _simulate(api, db, ammo_id=AMMO, equipment=[], collider="RibcageLow")
    assert result["body_part"] == "Stomach"
    assert result["hp"] == 70
    assert result["spread_hp"] == pytest.approx(352.38, abs=0.01)
    # 61 damage a shot through a 422 HP pool: the 7th shot kills
    assert result["shots_to_kill"] == 7


def test_angle_reaches_the_engine(api, db):
    straight = _simulate(api, db, ammo_id=AMMO, equipment=[{"item_id": HELMET}], collider="ParietalHead")
    angled = _simulate(api, db, ammo_id=AMMO, equipment=[{"item_id": HELMET}], collider="ParietalHead", angle=80)
    # The test helmet has no ricochet values, so the angle changes nothing
    assert [s["kill_chance"] for s in angled["shots"]] == [s["kill_chance"] for s in straight["shots"]]


def test_compare_ranks_every_round_in_the_caliber(api, db):
    db.query(api.Item).filter(api.Item.id.in_([AMMO, BUCKSHOT])).update({"caliber": "Caliber762x39"})
    db.add(
        api.Item(
            id="4" * 24,
            name="PS weak",
            is_ammo=True,
            caliber="Caliber762x39",
            ammo_damage=40,
            penetration_power=10,
            armor_damage=20,
        )
    )
    db.commit()
    api.limits._solve_request_last.clear()
    payload = api.armor.SimulateRequest(ammo_id=AMMO, equipment=[{"item_id": VEST}], collider="RibcageUp")
    request = SimpleNamespace(client=SimpleNamespace(host="test"), headers={})
    result = api.armor.armor_compare(request, payload, db)
    rows = {row["ammo_id"]: row for row in result["ammo"]}
    assert set(rows) == {AMMO, BUCKSHOT, "4" * 24}
    assert rows[AMMO]["shots_to_kill_50"] <= rows["4" * 24]["shots_to_kill_50"]
    assert rows[BUCKSHOT]["projectiles"] == 8
