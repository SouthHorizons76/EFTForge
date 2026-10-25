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
    monkeypatch.setattr(atlas, "ATLAS_ARENA_EXPORT_DIR", "")
    monkeypatch.setattr(atlas, "ATLAS_KEYS_FILE", str(tmp_path / "keys.json"))
    monkeypatch.setattr(atlas, "ATLAS_PUBLIC_DELAY_HOURS", 12.0)
    monkeypatch.setattr(atlas, "ATLAS_ENTRY_FILE", str(tmp_path / "runtime" / "atlas_entry_shown"))
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

    for value_id in ("1", "../0", "x", "0\n"):
        with pytest.raises(HTTPException) as e:
            atlas.atlas_set_value("01d0002", value_id, _request(), x_atlas_key=None, x_admin_key=None)
        assert e.value.status_code == 404


def test_serve_refuses_paths_outside_sets(atlas, tmp_path):
    (tmp_path / "export" / "secret.json").write_text("{}", encoding="utf-8")
    for path in (tmp_path / "export" / "index.json", tmp_path / "export" / "sets" / ".." / "secret.json"):
        with pytest.raises(HTTPException) as e:
            atlas._serve(str(path), True)
        assert e.value.status_code == 404
    assert atlas._serve(str(tmp_path / "export" / "sets" / "01d0002.json"), True).status_code == 200


def test_arena_has_its_own_folder_under_the_same_gate(atlas, tmp_path, monkeypatch):
    # not configured: Arena is a 503 while EFT keeps working
    with pytest.raises(HTTPException) as e:
        atlas.atlas_arena_index(_request(), Response(), x_atlas_key=None, x_admin_key=None)
    assert e.value.status_code == 503
    assert atlas.atlas_index(_request(), Response(), x_atlas_key=None, x_admin_key=None)["game"] == "eft"

    arena = tmp_path / "arena"
    (arena / "sets" / "a7e0001").mkdir(parents=True)
    now = datetime.now(timezone.utc)
    sets = [
        {
            "id": "a7e0001",
            "game": "arena",
            "detected": (now - timedelta(hours=1)).isoformat(),
            "version": "0.6",
            "total": 1,
        },
        {
            "id": "a7e0002",
            "game": "arena",
            "detected": (now - timedelta(hours=20)).isoformat(),
            "version": "0.6",
            "total": 3,
        },
    ]
    (arena / "index.json").write_text(json.dumps({"sets": sets}), encoding="utf-8")
    for s in sets:
        (arena / "sets" / f"{s['id']}.json").write_text(json.dumps({"id": s["id"]}), encoding="utf-8")
    (arena / "sets" / "a7e0001" / "0.json").write_text('{"big": true}', encoding="utf-8")
    monkeypatch.setattr(atlas, "ATLAS_ARENA_EXPORT_DIR", str(arena))

    index = atlas.atlas_arena_index(_request(), Response(), x_atlas_key=None, x_admin_key=None)
    assert index["game"] == "arena"
    assert [(s["id"], s["locked"]) for s in index["sets"]] == [("a7e0001", True), ("a7e0002", False)]
    assert (
        json.loads(atlas.atlas_arena_set("a7e0002", _request(), x_atlas_key=None, x_admin_key=None).body)["id"]
        == "a7e0002"
    )
    for call in (
        lambda: atlas.atlas_arena_set("a7e0001", _request(), x_atlas_key=None, x_admin_key=None),
        lambda: atlas.atlas_arena_set_value("a7e0001", "0", _request(), x_atlas_key=None, x_admin_key=None),
        # each game only serves its own sets
        lambda: atlas.atlas_arena_set("01d0002", _request(), x_atlas_key=None, x_admin_key=None),
        lambda: atlas.atlas_set("a7e0002", _request(), x_atlas_key=None, x_admin_key=None),
    ):
        with pytest.raises(HTTPException) as e:
            call()
        assert e.value.status_code == 404

    # the same keys open Arena's early sets
    key = _new_key(atlas)["key"]
    fresh = atlas.atlas_arena_set_value("a7e0001", "0", _request(), x_atlas_key=key, x_admin_key=None)
    assert json.loads(fresh.body) == {"big": True}
    assert fresh.headers["Cache-Control"] == "private, no-store"


def test_entry_button_is_hidden_until_the_admin_shows_it(atlas):
    response = Response()
    assert atlas.atlas_entry(response) == {"shown": False}
    assert response.headers["Cache-Control"] == "no-store"

    assert atlas.admin_set_atlas_entry(shown=True) == {"shown": True}
    assert atlas.atlas_entry(Response()) == {"shown": True}
    assert atlas.admin_get_atlas_entry() == {"shown": True}

    # hiding it twice is fine, and the page's own data stays public meanwhile
    assert atlas.admin_set_atlas_entry(shown=False) == {"shown": False}
    assert atlas.admin_set_atlas_entry(shown=False) == {"shown": False}
    assert atlas.atlas_entry(Response()) == {"shown": False}
    assert atlas.atlas_index(_request(), Response(), x_atlas_key=None, x_admin_key=None)["sets"]


def test_entry_switch_is_admin_only(atlas):
    from routers.shared import require_admin

    gated = {
        (route.path, method)
        for route in atlas.router.routes
        for method in route.methods
        if any(dep.call is require_admin for dep in route.dependant.dependencies)
    }
    assert {("/admin/atlas/entry", "GET"), ("/admin/atlas/entry", "POST")} <= gated
    assert ("/atlas/api/entry", "GET") not in gated


def _matching_dir(atlas, tmp_path, monkeypatch, now, lines, latest=True):
    directory = tmp_path / "matching"
    directory.mkdir()
    monkeypatch.setattr(atlas, "ATLAS_MATCHING_DIR", str(directory))
    atlas._matching_cache.clear()
    by_day = {}
    for line in lines:
        day = datetime.fromtimestamp(line["time"], timezone.utc).date().isoformat()
        by_day.setdefault(day, []).append(json.dumps(line))
    for day, rows in by_day.items():
        (directory / f"{day}.jsonl").write_text("\n".join(rows) + "\n", encoding="utf-8")
    if latest:
        (directory / "latest.json").write_text(
            json.dumps(
                {
                    "time": int(now.timestamp()) - 60,
                    "dataCenters": [
                        {"region": "EUR", "dataCenter": "Europe West", "avgTimeAwait": 31, "ip": ["192.0.2.1"]},
                        {"region": "ASI", "dataCenter": "Japan", "avgTimeAwait": 144, "ip": ["192.0.2.2"]},
                    ],
                }
            ),
            encoding="utf-8",
        )
    return directory


def test_matching_serves_latest_waits_without_ips(atlas, tmp_path, monkeypatch):
    now = datetime.now(timezone.utc)
    _matching_dir(atlas, tmp_path, monkeypatch, now, [])
    response = Response()
    payload = atlas.atlas_matching(response, hours=24)
    assert payload["datacenters"] == [
        {"region": "EUR", "name": "Europe West", "wait": 31},
        {"region": "ASI", "name": "Japan", "wait": 144},
    ]
    assert "192.0.2.1" not in json.dumps(payload)
    assert payload["updated"] and payload["hours"] == 24
    assert response.headers["Cache-Control"] == "public, max-age=60"


def test_matching_history_averages_buckets_across_days(atlas, tmp_path, monkeypatch):
    now = datetime(2026, 10, 25, 0, 30, tzinfo=timezone.utc)
    t = int(now.timestamp())
    lines = [
        {"time": t - 3600, "avgTimeAwait": {"Europe West": 30, "Japan": 100}},  # 2026-10-24
        {"time": t - 3590, "avgTimeAwait": {"Europe West": 40, "Japan": True}},  # not a wait: dropped
        {"time": t - 100, "avgTimeAwait": {"Europe West": 50, "Gone": 70}},  # 2026-10-25
        {"time": t - 30 * 3600, "avgTimeAwait": {"Europe West": 999}},  # older than the range
    ]
    directory = _matching_dir(atlas, tmp_path, monkeypatch, now, lines)
    (directory / "2026-10-25.jsonl").write_text(
        (directory / "2026-10-25.jsonl").read_text(encoding="utf-8") + '{"time": 1, "avgTim', encoding="utf-8"
    )  # a line cut short mid-write is skipped
    payload = atlas.matching_payload(str(directory), 24, now=now)
    history = payload["history"]
    assert history["start"] == t - 24 * 3600 and history["step"] == 300
    series = history["series"]
    assert list(series) == ["Europe West", "Japan", "Gone"]  # latest first, then history-only
    assert all(len(v) == 288 for v in series.values())
    # t - 3600 and t - 3590 share a 300 s bucket
    assert [v for v in series["Europe West"] if v is not None] == [35, 50]
    assert [v for v in series["Japan"] if v is not None] == [100]
    assert [v for v in series["Gone"] if v is not None] == [70]

    # a short range keeps buckets at least 300 s wide, wider than Ripper's ~100 s polling
    short = atlas.matching_payload(str(directory), 6, now=now)["history"]
    assert short["step"] == 300 and len(short["series"]["Europe West"]) == 72


def test_matching_range_and_configuration(atlas, tmp_path, monkeypatch):
    monkeypatch.setattr(atlas, "ATLAS_MATCHING_DIR", "")
    atlas._matching_cache.clear()
    with pytest.raises(HTTPException) as e:
        atlas.atlas_matching(Response(), hours=24)
    assert e.value.status_code == 503
    for hours in (0, 169):
        with pytest.raises(HTTPException) as e:
            atlas.atlas_matching(Response(), hours=hours)
        assert e.value.status_code == 422

    # nothing recorded yet: an empty answer, not an error
    now = datetime.now(timezone.utc)
    _matching_dir(atlas, tmp_path, monkeypatch, now, [], latest=False)
    payload = atlas.atlas_matching(Response(), hours=6)
    assert payload["datacenters"] == [] and payload["updated"] is None and payload["history"]["series"] == {}
