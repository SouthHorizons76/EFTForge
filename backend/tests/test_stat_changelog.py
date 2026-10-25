"""Check the Stat Tracker's changelog endpoints against throwaway databases."""

import os
from types import SimpleNamespace
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def api():
    # Import lazily so collection does not initialize the application databases.
    os.environ.setdefault("IP_HASH_SECRET", "changelog-test-secret")
    os.environ.setdefault("ADMIN_API_KEY", "changelog-test-admin")
    import main  # noqa: F401 - creates the app databases
    from database import Base
    from database_changelog import ChangelogBase
    from models_items import Item
    from models_slot_allowed import SlotAllowedItem
    from models_stat_changelog import StatChangeLog
    from routers import stat_changelog

    return SimpleNamespace(
        Base=Base,
        ChangelogBase=ChangelogBase,
        Item=Item,
        SlotAllowedItem=SlotAllowedItem,
        StatChangeLog=StatChangeLog,
        stat_changelog=stat_changelog,
    )


@pytest.fixture
def sessions(api):
    items_engine = create_engine("sqlite://")
    changelog_engine = create_engine("sqlite://")
    api.Base.metadata.create_all(bind=items_engine)
    api.ChangelogBase.metadata.create_all(bind=changelog_engine)
    db = sessionmaker(bind=items_engine)()
    changelog_db = sessionmaker(bind=changelog_engine)()

    db.add_all(
        [
            api.Item(id="gun", name="Gun", is_weapon=True, is_ammo=False),
            api.Item(id="round", name="Round", is_weapon=False, is_ammo=True),
            api.Item(id="grip", name="Grip", is_weapon=False, is_ammo=False),
            api.Item(id="junk", name="Junk", is_weapon=False, is_ammo=False),
            api.SlotAllowedItem(slot_id="slot", allowed_item_id="grip"),
        ]
    )
    db.commit()
    yield db, changelog_db
    db.close()
    changelog_db.close()


def log(changelog_db, api, item_id, stat, when):
    changelog_db.add(
        api.StatChangeLog(
            item_id=item_id, item_name=item_id, stat_name=stat, old_value=1.0, new_value=2.0, detected_at=when
        )
    )


def test_history_outlives_the_recent_window_and_is_served_by_day(api, sessions):
    db, changelog_db = sessions
    now = datetime.now(timezone.utc)
    old = datetime(2025, 3, 14, 9, 30, tzinfo=timezone.utc)
    log(changelog_db, api, "gun", "weight", now)
    log(changelog_db, api, "gun", "weight", old)
    log(changelog_db, api, "gun", "center_of_impact", old)
    log(changelog_db, api, "grip", "ergonomics_modifier", old + timedelta(hours=14))
    log(changelog_db, api, "round", "velocity", old - timedelta(hours=10))  # 23:30 the previous UTC day
    log(changelog_db, api, "junk", "weight", old)  # not a weapon, ammo or attachment
    log(changelog_db, api, "missing", "weight", old)  # item since removed from the game
    changelog_db.commit()

    recent = api.stat_changelog.get_stat_changelog(date=None, db=db, changelog_db=changelog_db)
    assert [(r["item_id"], r["stat_name"]) for r in recent] == [("gun", "weight")]

    day = api.stat_changelog.get_stat_changelog(date="2025-03-14", db=db, changelog_db=changelog_db)
    assert sorted((r["item_id"], r["stat_name"]) for r in day) == [
        ("grip", "ergonomics_modifier"),
        ("gun", "center_of_impact"),
        ("gun", "weight"),
    ]
    assert all(r["detected_at"].startswith("2025-03-14") for r in day)

    dates = api.stat_changelog.get_stat_changelog_dates(db=db, changelog_db=changelog_db)
    assert dates == [
        {"date": now.strftime("%Y-%m-%d"), "item_count": 1},
        {"date": "2025-03-14", "item_count": 2},
        {"date": "2025-03-13", "item_count": 1},
    ]


def test_rejects_a_malformed_date(api, sessions):
    db, changelog_db = sessions
    with pytest.raises(HTTPException) as error:
        api.stat_changelog.get_stat_changelog(date="14-03-2025", db=db, changelog_db=changelog_db)
    assert error.value.status_code == 422
