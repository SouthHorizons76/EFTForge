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


def _shop():
    return {
        "side": "defense",
        "attack": {
            "UberGun": [fx.SHOP_RIFLE, fx.SHOP_GONE],
            "Armor": [fx.SHOP_VEST],
            "Ulta": [fx.SHOP_RIFLE],
            "gear": {"Headwear": fx.HELMET, "Earpiece": ""},
        },
        "defense": {},
        "builds": {fx.SHOP_RIFLE: {"pairs": [[fx.S_GRIP, fx.GRIP_A]], "ammoId": None}, fx.SHOP_GONE: {"pairs": []}},
    }


def test_a_blastgang_shop_publishes_and_lists_as_its_own_class(arena, builds):  # noqa: F811
    from routers.arena_presets import BLAST_GANG, get_public_arena_presets

    arena_db, builds_db = arena["session"](), builds()
    result = _publish(arena_db, builds_db, loadout=_shop(), class_id=BLAST_GANG, name="My shop")
    (shop,) = get_public_arena_presets(BLAST_GANG, OTHER, builds_db)
    assert shop["id"] == result["id"] and shop["class_name"] == "BlastGang"
    # the side on show isn't shared; an item the shop data lacks, or of another type, drops out
    assert shop["loadout"] == {
        "attack": {
            "UberGun": [fx.SHOP_RIFLE],
            "Armor": [fx.SHOP_VEST],
            "gear": {"Headwear": fx.HELMET, "Earpiece": ""},
        },
        "defense": {},
        "builds": {fx.SHOP_RIFLE: {"pairs": [[fx.S_GRIP, fx.GRIP_A]], "ammoId": None}},
    }
    # class presets don't list it, nor it them
    assert get_public_arena_presets(fx.CLASS_ASSAULT, OTHER, builds_db) == []
    arena_db.close()
    builds_db.close()


@pytest.mark.parametrize(
    "change, detail",
    [
        (lambda s: s["builds"][fx.SHOP_RIFLE]["pairs"].append([fx.S_GRIP, fx.GRIP_B]), "doesn't allow"),
        (lambda s: s["attack"]["gear"].update({"Backpack": fx.CAP}), "unknown slot"),
        (lambda s: s["attack"]["gear"].update({"Headwear": fx.NOT_IN_ARMORY}), "Unknown item IDs"),
        (lambda s: s.update({"attack": {}, "builds": {}}), "The shop is empty."),
    ],
)
def test_a_bad_shop_is_refused(arena, builds, change, detail):  # noqa: F811
    from routers.arena_presets import BLAST_GANG

    arena_db, builds_db = arena["session"](), builds()
    shop = _shop()
    change(shop)
    with pytest.raises(HTTPException) as err:
        _publish(arena_db, builds_db, loadout=shop, class_id=BLAST_GANG)
    assert err.value.status_code == 422 and detail in str(err.value.detail)
    arena_db.close()
    builds_db.close()


# ---- Problems: refused on publish, and taken out once a data update brings them ----


def _problems(arena_db, class_id, loadout):
    from services import arena_preset_check as check

    return check.preset_problems(check.Rules(arena_db), class_id, loadout)


def test_the_fixture_loadout_and_shop_have_no_problems(arena):  # noqa: F811
    from routers.arena_presets import BLAST_GANG, clean_loadout

    arena_db = arena["session"]()
    clean, _ = clean_loadout(_loadout())
    assert _problems(arena_db, fx.CLASS_ASSAULT, clean) == []
    assert _problems(arena_db, BLAST_GANG, _shop()) == []
    arena_db.close()


@pytest.mark.parametrize(
    "change, problem",
    [
        # grip B is the marksman's only
        (lambda lo: lo["weapons"]["FirstPrimaryWeapon"]["pairs"].append([fx.S_SIGHT, fx.GRIP_B]), "class"),
        # the assault class may not load round B into the rifle
        (lambda lo: lo["weapons"]["FirstPrimaryWeapon"].update({"ammoId": fx.ROUND_B}), "weapon"),
        # 200 medkits of 51 points each go over the 10 000 limit
        (lambda lo: lo["carried"][0].update({"count": 200}), "over_limit"),
        # nor do they count while they're not in the rig or pockets
        (lambda lo: lo["carried"].append({"id": fx.MEDKIT, "count": 200}), None),
    ],
)
def test_a_loadouts_problems(arena, change, problem):  # noqa: F811
    from routers.arena_presets import clean_loadout

    arena_db = arena["session"]()
    loadout = _loadout()
    change(loadout)
    clean, _ = clean_loadout(loadout)
    assert _problems(arena_db, fx.CLASS_ASSAULT, clean) == ([problem] if problem else [])
    arena_db.close()


def test_a_shop_builds_range_counts(arena):  # noqa: F811
    from routers.arena_presets import BLAST_GANG

    arena_db = arena["session"]()
    shop = _shop()
    # 1000 + 100 + 200 + 160 + 260 + 500 is over the rifle's 2000
    shop["builds"][fx.SHOP_RIFLE]["pairs"] += [
        [fx.S_BARREL, fx.BARREL],
        [fx.S_MUZZLE, fx.BRAKE],
        [fx.S_SIGHT, fx.SIGHT],
        [fx.S_LAUNCHER, fx.LAUNCHER],
    ]
    assert _problems(arena_db, BLAST_GANG, shop) == ["shop_range"]
    # the bare rifle is its 1000 minimum exactly, which is in range
    shop["builds"][fx.SHOP_RIFLE]["pairs"] = []
    assert _problems(arena_db, BLAST_GANG, shop) == []
    arena_db.close()


def test_a_shop_boards_gear_conflicts_count(arena):  # noqa: F811
    from routers.arena_presets import BLAST_GANG

    arena_db = arena["session"]()
    shop = _shop()
    # the cap can't be worn with the vest the attack side's armor slot holds
    shop["attack"]["gear"]["Headwear"] = fx.CAP
    assert _problems(arena_db, BLAST_GANG, shop) == ["conflict"]
    # an emptied cap slot wears nothing to clash with
    shop["attack"]["gear"]["Headwear"] = ""
    assert _problems(arena_db, BLAST_GANG, shop) == []
    arena_db.close()


def test_publishing_a_preset_with_problems_is_refused(arena, builds):  # noqa: F811
    arena_db, builds_db = arena["session"](), builds()
    loadout = _loadout()
    loadout["carried"][0]["count"] = 200
    with pytest.raises(HTTPException) as err:
        _publish(arena_db, builds_db, loadout=loadout)
    assert err.value.status_code == 422 and err.value.detail == "arena_problems:over_limit"
    arena_db.close()
    builds_db.close()


def test_a_data_update_unpublishes_broken_presets_and_tells_the_publisher(arena, builds):  # noqa: F811
    from models_builds import PendingNotification, PublicBuild
    from routers.community_builds import get_notifications
    from services import arena_preset_check as check

    arena_db, builds_db = arena["session"](), builds()
    fine = _publish(arena_db, builds_db, name="Fine")
    # published under rules that let it through: the round the class may no longer load
    broken = _loadout()
    broken["weapons"]["FirstPrimaryWeapon"]["ammoId"] = fx.ROUND_B
    row = PublicBuild(
        game="arena",
        gun_id=fx.CLASS_ASSAULT,
        gun_name="Assault",
        build_name="Broken",
        pairs_json="[]",
        loadout_json=json.dumps(broken),
        ip_hash=builds_db.query(PublicBuild).one().ip_hash,
    )
    builds_db.add(row)
    builds_db.commit()

    assert check.recheck_published(builds_db, arena_db) == 1
    assert [b.id for b in builds_db.query(PublicBuild)] == [fine["id"]]
    (note,) = builds_db.query(PendingNotification).all()
    assert note.type == "arena_unlist"
    assert json.loads(note.data_json) == {
        "build_name": "Broken",
        "class_id": fx.CLASS_ASSAULT,
        "class_name": "Assault",
        "problems": ["weapon"],
    }
    (delivered,) = get_notifications(CLIENT, builds_db)
    assert delivered["type"] == "arena_unlist" and delivered["data"]["build_name"] == "Broken"
    # nothing else to take out the next time
    assert check.recheck_published(builds_db, arena_db) == 0
    arena_db.close()
    builds_db.close()


def test_a_helmets_headset_worn_on_its_own_is_a_problem(arena):  # noqa: F811
    from routers.arena_presets import clean_loadout
    from services import arena_preset_check as check

    arena_db = arena["session"]()
    rules = check.Rules(arena_db)
    loadout = _loadout()
    loadout["gear"]["Earpiece"] = {"id": fx.CAP}
    clean, _ = clean_loadout(loadout)
    rules.mount_only = {fx.CAP}
    assert "mount_only" in check.loadout_problems(rules, fx.CLASS_ASSAULT, clean)
    rules.mount_only = set()
    assert "mount_only" not in check.loadout_problems(rules, fx.CLASS_ASSAULT, clean)
    arena_db.close()
