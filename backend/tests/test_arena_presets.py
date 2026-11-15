"""Community Arena presets: publishing a class loadout, listing it, and keeping it out of
everything that means gun builds. Only made-up data (tests/snapshot_fixture.py)."""

import json
import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from starlette.requests import Request

from tests import snapshot_fixture as fx
from tests.test_arena import arena  # noqa: F401 - the built Arena database fixture

os.environ.setdefault("IP_HASH_SECRET", "arena-test-secret")
os.environ.setdefault("ADMIN_API_KEY", "arena-test-admin")

CLIENT = str(uuid.uuid4())
OTHER = str(uuid.uuid4())


@pytest.fixture
def builds(tmp_path, monkeypatch):
    import main  # noqa: F401 - registers every model
    from database_builds import BuildsBase
    from routers import community_builds

    engine = create_engine(f"sqlite:///{tmp_path / 'builds.db'}", connect_args={"check_same_thread": False})
    BuildsBase.metadata.create_all(engine)
    # every test starts off the publish cooldown
    monkeypatch.setattr(community_builds, "_publish_last", {})
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


def _request():
    return Request({"type": "http", "method": "POST", "path": "/", "headers": [], "client": ("10.0.0.1", 1)})


def _loadout():
    return {
        "weapons": {
            "FirstPrimaryWeapon": {
                "gunId": fx.RIFLE,
                "pairs": [[fx.S_GRIP, fx.GRIP_A], [fx.S_MAG, fx.MAGAZINE]],
                "ammoId": fx.ROUND_A,
                "junk": "dropped",
            }
        },
        "gear": {"ArmorVest": {"id": fx.VEST, "plates": {"front_plate": fx.PLATE_A}}},
        "carried": [{"id": fx.MEDKIT, "count": 1, "where": "pockets", "grid": 0, "x": 0, "y": 0, "r": False}],
    }


def _publish(arena_db, builds_db, client=CLIENT, loadout=None, class_id=fx.CLASS_ASSAULT, name="Rush"):
    from routers.arena_presets import publish_arena_preset

    return publish_arena_preset(
        request=_request(),
        x_client_id=client,
        class_id=class_id,
        build_name=name,
        loadout=_loadout() if loadout is None else loadout,
        author_username="tester",
        author_avatar_url=None,
        db=builds_db,
        db_arena=arena_db,
    )


def test_a_published_preset_lists_for_its_class_only(arena, builds):  # noqa: F811
    from routers.arena_presets import get_my_arena_presets, get_public_arena_presets

    arena_db, builds_db = arena["session"](), builds()
    result = _publish(arena_db, builds_db)

    (preset,) = get_public_arena_presets(fx.CLASS_ASSAULT, OTHER, builds_db)
    assert preset["id"] == result["id"] and preset["build_name"] == "Rush"
    assert preset["class_id"] == fx.CLASS_ASSAULT and preset["class_name"] == "Assault"
    assert preset["is_mine"] is False and preset["user_display_name"] == "tester"
    # stored as a loadout holds it, without keys a loadout doesn't have
    rifle = preset["loadout"]["weapons"]["FirstPrimaryWeapon"]
    assert rifle == {
        "gunId": fx.RIFLE,
        "pairs": [[fx.S_GRIP, fx.GRIP_A], [fx.S_MAG, fx.MAGAZINE]],
        "ammoId": fx.ROUND_A,
    }
    assert preset["loadout"]["carried"][0]["where"] == "pockets"

    # an empty magazine in a loaded gun keeps its flag; a stray one on an unloaded gun doesn't
    loadout = _loadout()
    loadout["weapons"]["FirstPrimaryWeapon"]["magEmpty"] = True
    loadout["weapons"]["Holster"] = {"gunId": fx.PISTOL, "pairs": [], "ammoId": None, "magEmpty": True}
    from routers.arena_presets import clean_loadout

    clean, _ = clean_loadout(loadout)
    assert clean["weapons"]["FirstPrimaryWeapon"]["magEmpty"] is True
    assert "magEmpty" not in clean["weapons"]["Holster"]

    # round counts in a gun's magazine and in a carried one are kept
    loadout["weapons"]["FirstPrimaryWeapon"]["magRounds"] = 12
    loadout["carried"].append({"id": fx.MAGAZINE, "count": 1, "ammoId": fx.ROUND_A, "rounds": 25})
    clean, _ = clean_loadout(loadout)
    assert clean["weapons"]["FirstPrimaryWeapon"]["magRounds"] == 12
    assert clean["carried"][-1]["rounds"] == 25

    # mixed rounds, bottom up, are kept, and their rounds must be in the armory
    loadout["carried"][-1]["loads"] = [[fx.ROUND_A, 25], [fx.ROUND_B, 25]]
    loadout["weapons"]["FirstPrimaryWeapon"]["magLoads"] = [[fx.ROUND_B, 10], [fx.ROUND_A, 5]]
    clean, ids = clean_loadout(loadout)
    assert clean["carried"][-1]["loads"] == [[fx.ROUND_A, 25], [fx.ROUND_B, 25]]
    assert clean["weapons"]["FirstPrimaryWeapon"]["magLoads"] == [[fx.ROUND_B, 10], [fx.ROUND_A, 5]]
    assert fx.ROUND_B in ids
    loadout["carried"][-1]["loads"] = [[fx.ROUND_A, 0]]
    with pytest.raises(HTTPException):
        clean_loadout(loadout)

    assert get_public_arena_presets(fx.CLASS_MARKSMAN, CLIENT, builds_db) == []
    (mine,) = get_my_arena_presets(CLIENT, builds_db)
    assert mine["is_mine"] is True and mine["like_count"] == 0
    arena_db.close()
    builds_db.close()


def test_presets_stay_out_of_the_gun_builds(arena, builds):  # noqa: F811
    from models_builds import BuildRating
    from routers.community_builds import get_my_builds, get_public_builds
    from routers.leaderboard import get_leaderboard_builds

    arena_db, builds_db = arena["session"](), builds()
    result = _publish(arena_db, builds_db)
    builds_db.add(BuildRating(build_id=result["id"], like_count=3, dislike_count=0))
    builds_db.commit()

    assert get_my_builds(CLIENT, builds_db) == []
    assert get_public_builds(fx.CLASS_ASSAULT, CLIENT, builds_db) == []
    assert get_leaderboard_builds("all", builds_db) == []
    arena_db.close()
    builds_db.close()


@pytest.mark.parametrize(
    "loadout, detail",
    [
        ({"weapons": {}, "gear": {}, "carried": []}, "The loadout is empty."),
        ({"gear": {"Backpack": {"id": fx.VEST}}}, "loadout.gear has an unknown slot."),
        ({"gear": {"ArmorVest": {"id": fx.NOT_IN_ARMORY}}}, "Unknown item IDs"),
        ({"carried": [{"id": fx.MEDKIT, "count": 0}]}, "count"),
        ({"carried": [{"id": fx.MEDKIT, "where": "backpack"}]}, "rig or the pockets"),
        ({"weapons": {"Holster": {"gunId": fx.PISTOL, "pairs": [["only one"]]}}}, "Each pair"),
    ],
)
def test_a_bad_loadout_is_refused(arena, builds, loadout, detail):  # noqa: F811
    arena_db, builds_db = arena["session"](), builds()
    with pytest.raises(HTTPException) as err:
        _publish(arena_db, builds_db, loadout=loadout)
    assert err.value.status_code == 422 and detail in str(err.value.detail)
    arena_db.close()
    builds_db.close()


def test_an_unknown_class_and_the_shared_cooldown_are_refused(arena, builds):  # noqa: F811
    from models_builds import PublicBuild

    arena_db, builds_db = arena["session"](), builds()
    with pytest.raises(HTTPException) as err:
        _publish(arena_db, builds_db, class_id="nope")
    assert err.value.status_code == 422
    _publish(arena_db, builds_db)
    # one publish a minute, whatever was published
    with pytest.raises(HTTPException) as err:
        _publish(arena_db, builds_db, name="Again")
    assert err.value.status_code == 429
    stored = json.loads(builds_db.query(PublicBuild).one().loadout_json)
    assert set(stored) == {"weapons", "gear", "carried"}
    arena_db.close()
    builds_db.close()
