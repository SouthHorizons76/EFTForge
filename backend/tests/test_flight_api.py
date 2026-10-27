"""Check the drop and zeroing table endpoint against a small synced catalog."""

import os
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

FAST = "a" * 24
SLOW = "b" * 24
NO_FLIGHT = "c" * 24
RIFLE = "d" * 24


@pytest.fixture(scope="module")
def api():
    # Import lazily so collection does not initialize the application databases.
    os.environ.setdefault("IP_HASH_SECRET", "flight-test-secret")
    os.environ.setdefault("ADMIN_API_KEY", "flight-test-admin")
    import main  # noqa: F401 - registers every model
    from database import Base
    from models_items import Item
    from routers import flight

    return SimpleNamespace(Base=Base, Item=Item, flight=flight)


@pytest.fixture
def db(api):
    engine = create_engine("sqlite://")
    api.Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    flight = dict(bullet_mass_grams=4, bullet_diameter_mm=5.7, ballistic_coefficient=0.233)
    session.add_all(
        [
            api.Item(id=FAST, name="Fast", is_ammo=True, velocity=945, ammo_damage=49, penetration_power=44, **flight),
            api.Item(id=SLOW, name="Slow", is_ammo=True, velocity=850, ammo_damage=50, penetration_power=30, **flight),
            api.Item(id=NO_FLIGHT, name="Odd", is_ammo=True, velocity=None, ammo_damage=10, penetration_power=1),
            api.Item(id=RIFLE, name="Rifle", is_weapon=True, default_ammo_id=SLOW),
        ]
    )
    session.commit()
    yield session
    session.close()


def _table(api, db, **body):
    return api.flight.ammo_flight(api.flight.FlightRequest(**body), db)


def test_table_zeroes_on_the_loaded_round_by_default(api, db):
    result = _table(api, db, ammo_id=FAST, zero_distance=100, max_distance=300, step=50)
    rows = {row["distance"]: row for row in result["rows"]}
    assert result["zero_ammo_id"] == FAST
    assert rows[100]["impact_cm"] == pytest.approx(0.0, abs=1e-4)
    assert rows[0]["impact_cm"] == pytest.approx(-5.0)
    # Slower on arrival means less damage and pen left
    assert rows[300]["damage"] < rows[0]["damage"]
    assert rows[300]["penetration"] < rows[0]["penetration"]


def test_weapon_zeroes_with_its_default_ammo(api, db):
    result = _table(api, db, ammo_id=FAST, weapon_id=RIFLE, zero_distance=100, max_distance=100, step=50)
    assert result["zero_ammo_id"] == SLOW
    assert {row["distance"]: row for row in result["rows"]}[100]["impact_cm"] > 0


def test_ammo_without_flight_data_is_rejected(api, db):
    with pytest.raises(HTTPException) as error:
        _table(api, db, ammo_id=NO_FLIGHT)
    assert error.value.status_code == 422
