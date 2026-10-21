"""Atlas change-set endpoints: the public time gate, Atlas keys and admin access."""

import json
import os
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response


@pytest.fixture
def atlas(tmp_path, monkeypatch):
    os.environ.setdefault("IP_HASH_SECRET", "atlas-test-secret")
    os.environ.setdefault("ADMIN_API_KEY", "atlas-test-admin")
    from routers import atlas, shared

    monkeypatch.setattr(atlas, "ATLAS_EXPORT_DIR", str(tmp_path / "export"))
    monkeypatch.setattr(atlas, "ATLAS_KEYS_FILE", str(tmp_path / "keys.json"))
    monkeypatch.setattr(atlas, "ATLAS_PUBLIC_DELAY_HOURS", 12.0)
    monkeypatch.setattr(shared, "ADMIN_API_KEY", "atlas-test-admin")
    atlas._failures.clear()
    shared._admin_failures.clear()

    now = datetime.now(timezone.utc)
    sets = [
        {"id": "f00d001", "detected": (now - timedelta(hours=1)).isoformat(), "version": "1", "total": 2},
        {"id": "01d0002", "detected": (now - timedelta(hours=13)).isoformat(), "version": "1", "total": 5},
    ]
    (tmp_path / "export" / "sets").mkdir(parents=True)
    (tmp_path / "export" / "index.json").write_text(json.dumps({"sets": sets}), encoding="utf-8")
    for s in sets:
        (tmp_path / "export" / "sets" / f"{s['id']}.json").write_text(json.dumps({"id": s["id"]}), encoding="utf-8")
    return atlas


def _request(ip="203.0.113.7"):
    return SimpleNamespace(client=SimpleNamespace(host=ip), headers={})


def _new_key(atlas, **kw):
    return atlas.admin_create_atlas_key(name=kw.get("name", "tester"), expires_days=kw.get("expires_days"))


def test_public_sees_only_sets_older_than_the_delay(atlas):
    response = Response()
    index = atlas.atlas_index(_request(), response, x_atlas_key=None, x_admin_key=None)
    assert index["access"] == "public" and index["viewer"] is None
    assert abs(datetime.fromisoformat(index["server_time"]) - datetime.now(timezone.utc)) < timedelta(seconds=5)
    # every set is listed, but a fresh one only by its headline numbers
    fresh, old = index["sets"]
    assert fresh["id"] == "f00d001" and fresh["locked"] and fresh["total"] == 2 and fresh["public_at"]
    assert "files" not in fresh and fresh["file_count"] == 0
    assert old["id"] == "01d0002" and not old["locked"]
    assert response.headers["Cache-Control"] == "private, no-store"

    with pytest.raises(HTTPException) as e:
        atlas.atlas_set("f00d001", _request(), x_atlas_key=None, x_admin_key=None)
    assert e.value.status_code == 404  # same as a set that doesn't exist
    old = atlas.atlas_set("01d0002", _request(), x_atlas_key=None, x_admin_key=None)
    assert old.headers["Cache-Control"] == "public, max-age=3600"


def test_key_and_admin_see_everything_uncached(atlas):
    created = _new_key(atlas)
    key = created["key"]
    index = atlas.atlas_index(_request(), Response(), x_atlas_key=key, x_admin_key=None)
    assert index["access"] == "key" and len(index["sets"]) == 2
    assert not any(s["locked"] for s in index["sets"])
    # the watermark names the key by its admin-list id, never by the key itself
    assert index["viewer"] == created["id"] and key not in json.dumps(index)
    assert index["viewer_name"] == "tester"
    fresh = atlas.atlas_set("f00d001", _request(), x_atlas_key=key, x_admin_key=None)
    assert json.loads(fresh.body) == {"id": "f00d001"}
    assert fresh.headers["Cache-Control"] == "private, no-store"

    admin = atlas.atlas_index(_request(), Response(), x_atlas_key=None, x_admin_key="atlas-test-admin")
    assert (
        admin["access"] == "admin"
        and len(admin["sets"]) == 2
        and admin["viewer"] is None
        and admin["viewer_name"] is None
    )  # no watermark for the admin
    with pytest.raises(HTTPException) as e:
        atlas.atlas_index(_request(), Response(), x_atlas_key=None, x_admin_key="wrong")
    assert e.value.status_code == 403


def test_keys_are_hashed_revocable_and_expire(atlas):
    created = _new_key(atlas, name="friend")
    stored = json.loads(open(atlas.ATLAS_KEYS_FILE, encoding="utf-8").read())["keys"]
    assert created["key"] not in json.dumps(stored)
    assert [k["name"] for k in atlas.admin_list_atlas_keys()] == ["friend"]
    assert "hash" not in atlas.admin_list_atlas_keys()[0]

    atlas.admin_revoke_atlas_key(created["id"])
    with pytest.raises(HTTPException) as e:
        atlas.atlas_index(_request(), Response(), x_atlas_key=created["key"], x_admin_key=None)
    assert e.value.status_code == 403

    expired = _new_key(atlas, expires_days=-1)["key"]
    with pytest.raises(HTTPException):
        atlas.atlas_index(_request("198.51.100.1"), Response(), x_atlas_key=expired, x_admin_key=None)


def test_repeated_wrong_keys_lock_the_ip(atlas):
    for _ in range(atlas._MAX_FAILURES):
        with pytest.raises(HTTPException) as e:
            atlas.atlas_index(_request(), Response(), x_atlas_key="atl_wrong", x_admin_key=None)
        assert e.value.status_code == 403
    good = _new_key(atlas)["key"]
    with pytest.raises(HTTPException) as e:
        atlas.atlas_index(_request(), Response(), x_atlas_key=good, x_admin_key=None)
    assert e.value.status_code == 429
    assert atlas.atlas_index(_request("192.0.2.9"), Response(), x_atlas_key=good, x_admin_key=None)["access"] == "key"


def test_large_values_follow_their_set_gate(atlas, tmp_path):
    for set_id in ("f00d001", "01d0002"):
        (tmp_path / "export" / "sets" / set_id).mkdir()
        (tmp_path / "export" / "sets" / set_id / "0.json").write_text('{"big": true}', encoding="utf-8")

    with pytest.raises(HTTPException) as e:
        atlas.atlas_set_value("f00d001", "0", _request(), x_atlas_key=None, x_admin_key=None)
    assert e.value.status_code == 404  # not public yet

    key = _new_key(atlas)["key"]
    fresh = atlas.atlas_set_value("f00d001", "0", _request(), x_atlas_key=key, x_admin_key=None)
    assert json.loads(fresh.body) == {"big": True}
    assert fresh.headers["Cache-Control"] == "private, no-store"

    old = atlas.atlas_set_value("01d0002", "0", _request(), x_atlas_key=None, x_admin_key=None)
    assert old.headers["Cache-Control"] == "public, max-age=3600"

    for value_id in ("1", "../0", "x"):
        with pytest.raises(HTTPException) as e:
            atlas.atlas_set_value("01d0002", value_id, _request(), x_atlas_key=None, x_admin_key=None)
        assert e.value.status_code == 404
