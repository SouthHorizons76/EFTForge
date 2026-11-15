"""Gun builds the game won't equip (a required slot left empty) never publish, and ones
published before a data update made them so are taken out and their publisher told.
Only made-up data."""

import json
import os
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from starlette.requests import Request

os.environ.setdefault("IP_HASH_SECRET", "build-check-test-secret")
os.environ.setdefault("ADMIN_API_KEY", "build-check-test-admin")

CLIENT = str(uuid.uuid4())
GUN, RECEIVER, BARREL, MAG, MOUNT, RING = ("%024x" % (0xA00 + i) for i in range(6))
S_RECEIVER, S_MAG, S_BARREL, S_MOUNT_A, S_MOUNT_B, S_RING = ("%024x" % (0xB00 + i) for i in range(6))


@pytest.fixture
def dbs(tmp_path, monkeypatch):
    import main  # noqa: F401 - registers every model
    from database import Base
    from database_builds import BuildsBase
    from models_items import Item
    from models_slots import Slot
    from routers import community_builds

    main_engine = create_engine("sqlite://")
    Base.metadata.create_all(main_engine)
    builds_engine = create_engine(f"sqlite:///{tmp_path / 'builds.db'}", connect_args={"check_same_thread": False})
    BuildsBase.metadata.create_all(builds_engine)
    monkeypatch.setattr(community_builds, "_publish_last", {})

    db = sessionmaker(bind=main_engine)()
    db.add_all(
        [
            Item(id=GUN, name="Rifle", short_name="R", is_weapon=True, weight=1, ergonomics_modifier=0),
            *(
                Item(id=i, name=n, short_name=n, weight=0.1, ergonomics_modifier=0)
                for i, n in ((RECEIVER, "Receiver"), (BARREL, "Barrel"), (MAG, "Mag"), (MOUNT, "Mount"), (RING, "Ring"))
            ),
            Slot(id=S_RECEIVER, parent_item_id=GUN, slot_name="Receiver", required=True),
            Slot(id=S_MAG, parent_item_id=GUN, slot_name="Magazine", required=True),
            Slot(id=S_MOUNT_A, parent_item_id=GUN, slot_name="Mount", required=False),
            Slot(id=S_MOUNT_B, parent_item_id=GUN, slot_name="Mount", required=False),
            Slot(id=S_BARREL, parent_item_id=RECEIVER, slot_name="Barrel", required=True),
            Slot(id=S_RING, parent_item_id=MOUNT, slot_name="Ring", required=True),
        ]
    )
    db.commit()
    yield db, sessionmaker(autocommit=False, autoflush=False, bind=builds_engine)()
    db.close()


COMPLETE = [[S_RECEIVER, RECEIVER], [S_MAG, MAG], [S_BARREL, BARREL]]


def _missing(db, pairs):
    from services.build_check import missing_required, required_slots

    return sorted(name for _, _, name in missing_required(required_slots(db), GUN, pairs))


def test_every_required_slot_of_every_part_counts(dbs):
    db, _ = dbs
    assert _missing(db, []) == ["Magazine", "Receiver"]
    assert _missing(db, [[S_RECEIVER, RECEIVER], [S_MAG, MAG]]) == ["Barrel"]
    assert _missing(db, COMPLETE) == []
    # a part on the build twice needs its required slot filled twice
    twice = COMPLETE + [[S_MOUNT_A, MOUNT], [S_MOUNT_B, MOUNT], [S_RING, RING]]
    assert _missing(db, twice) == ["Ring"]
    assert _missing(db, twice + [[S_RING, RING]]) == []


def _publish(db, builds_db, pairs):
    from routers.community_builds import publish_build

    request = Request({"type": "http", "method": "POST", "path": "/", "headers": [], "client": ("10.0.0.1", 1)})
    return publish_build(
        request=request,
        background_tasks=BackgroundTasks(),
        x_client_id=CLIENT,
        gun_id=GUN,
        build_name="Test",
        pairs=pairs,
        stats=None,
        ammo_id=None,
        author_username=None,
        author_avatar_url=None,
        tags=None,
        db=builds_db,
        db_main=db,
    )


def test_a_build_missing_a_required_part_is_refused(dbs):
    db, builds_db = dbs
    with pytest.raises(HTTPException) as err:
        _publish(db, builds_db, [[S_RECEIVER, RECEIVER], [S_MAG, MAG]])
    assert err.value.status_code == 422 and err.value.detail == "missing_required_parts:Barrel"
    assert _publish(db, builds_db, COMPLETE)["id"]


def test_a_data_update_unpublishes_broken_builds_and_tells_the_publisher(dbs):
    from models_builds import PendingNotification, PublicBuild
    from models_slots import Slot
    from routers.community_builds import get_notifications
    from services import build_check

    db, builds_db = dbs
    fine = _publish(db, builds_db, COMPLETE)
    # a data update gives the barrel a required muzzle slot the published build leaves empty
    db.add(Slot(id="%024x" % 0xBFF, parent_item_id=BARREL, slot_name="Muzzle", required=True))
    db.commit()
    builds_db.add(
        PublicBuild(gun_id=GUN, gun_name="Rifle", build_name="Arena one", game="arena", pairs_json="[]", ip_hash="x")
    )
    builds_db.commit()

    assert build_check.recheck_published(builds_db, db) == 1
    # the Arena preset isn't a gun build and stays
    assert [b.build_name for b in builds_db.query(PublicBuild)] == ["Arena one"]
    assert fine["id"] not in [b.id for b in builds_db.query(PublicBuild)]
    (note,) = builds_db.query(PendingNotification).all()
    assert note.type == "build_unlist"
    assert json.loads(note.data_json) == {"build_name": "Test", "gun_id": GUN, "gun_name": "Rifle", "slots": ["Muzzle"]}
    (delivered,) = get_notifications(CLIENT, builds_db)
    assert delivered["type"] == "build_unlist"
    assert build_check.recheck_published(builds_db, db) == 0


def test_a_data_update_breaking_too_many_builds_at_once_unlists_none(dbs):
    from models_builds import PendingNotification, PublicBuild
    from models_slots import Slot
    from services import build_check

    db, builds_db = dbs
    pairs = json.dumps(COMPLETE)
    builds_db.add_all(
        PublicBuild(gun_id=GUN, gun_name="Rifle", build_name=f"B{i}", pairs_json=pairs, ip_hash=f"h{i}")
        for i in range(30)
    )
    builds_db.commit()
    # broken data: a required slot every published build leaves empty
    db.add(Slot(id="%024x" % 0xBFF, parent_item_id=BARREL, slot_name="Muzzle", required=True))
    db.commit()

    assert build_check.recheck_published(builds_db, db) is None
    assert builds_db.query(PublicBuild).count() == 30
    assert builds_db.query(PendingNotification).count() == 0
    # by hand, once the data is known right
    assert build_check.recheck_published(builds_db, db, force=True) == 30
    assert builds_db.query(PublicBuild).count() == 0


def test_the_unlist_guard_allows_a_few_or_a_small_share():
    from services.build_check import unlist_allowed

    assert unlist_allowed(10, 10, "t")  # a handful may always go
    assert unlist_allowed(50, 500, "t")  # a tenth may go
    assert not unlist_allowed(11, 20, "t")
    assert not unlist_allowed(51, 500, "t")


def test_the_slot_payloads_say_which_slots_are_required(dbs):
    from routers.catalog import get_item_slots, get_item_slots_batch

    db, _ = dbs
    by_id = {s["id"]: s["required"] for s in get_item_slots(GUN, db)}
    assert by_id[S_RECEIVER] is True and by_id[S_MOUNT_A] is False
    assert get_item_slots_batch([RECEIVER], db)[RECEIVER][0]["required"] is True
