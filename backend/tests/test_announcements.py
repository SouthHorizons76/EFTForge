"""GET /announcements must never be cached on the way to the app, and an unchanged list
answers 304 so the app's short poll stays cheap."""

import json
import os
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from starlette.requests import Request

os.environ.setdefault("IP_HASH_SECRET", "announcements-test-secret")
os.environ.setdefault("ADMIN_API_KEY", "announcements-test-admin")


@pytest.fixture
def db(tmp_path):
    import main  # noqa: F401 - registers every model
    from database_builds import BuildsBase

    engine = create_engine(f"sqlite:///{tmp_path / 'builds.db'}", connect_args={"check_same_thread": False})
    BuildsBase.metadata.create_all(engine)
    session = sessionmaker(autocommit=False, autoflush=False, bind=engine)()
    yield session
    session.close()


def _request(if_none_match=None):
    headers = [(b"if-none-match", if_none_match.encode())] if if_none_match else []
    return Request({"type": "http", "method": "GET", "path": "/announcements", "headers": headers})


def _add(db, message, expires_at=None):
    from models_builds import ServerAnnouncement

    db.add(ServerAnnouncement(message=message, level="info", expires_at=expires_at, dismissible=True))
    db.commit()


def test_list_is_never_cached_and_revalidates(db):
    from routers.announcements import get_announcements

    _add(db, "hello")
    res = get_announcements(_request(), db)
    assert res.status_code == 200
    assert res.headers["Cache-Control"] == "private, no-cache"
    assert [a["message"] for a in json.loads(res.body)] == ["hello"]

    etag = res.headers["ETag"]
    same = get_announcements(_request(etag), db)
    assert same.status_code == 304 and same.body == b""
    assert same.headers["ETag"] == etag
    # nginx's gzip sends our ETag back weak
    assert get_announcements(_request("W/" + etag), db).status_code == 304


def test_new_and_expired_announcements_change_the_etag(db):
    from routers.announcements import get_announcements

    first = get_announcements(_request(), db)
    assert json.loads(first.body) == []

    _add(db, "maintenance at 20:00")
    changed = get_announcements(_request(first.headers["ETag"]), db)
    assert changed.status_code == 200
    assert [a["message"] for a in json.loads(changed.body)] == ["maintenance at 20:00"]

    _add(db, "gone", expires_at=datetime.now(timezone.utc) - timedelta(minutes=1))
    after = get_announcements(_request(changed.headers["ETag"]), db)
    assert after.status_code == 304
