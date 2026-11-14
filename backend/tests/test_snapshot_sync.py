"""Following another server's game data snapshots (services/snapshots.py) and publishing
our own (routers/snapshots.py). Made-up data only (tests/snapshot_fixture.py)."""

import json
import os

import pytest

from tests import snapshot_fixture as fx

os.environ.setdefault("IP_HASH_SECRET", "snapshot-sync-test-secret")
os.environ.setdefault("ADMIN_API_KEY", "snapshot-sync-test-admin")


class FakeResponse:
    def __init__(self, status, body: bytes):
        self.status_code = status
        self._body = body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return json.loads(self._body)

    def iter_content(self, chunk_size=1):
        for i in range(0, len(self._body), chunk_size):
            end = i + chunk_size
            yield self._body[i:end]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeSource:
    """A source server publishing one snapshot per game."""

    def __init__(self, files: dict):
        self.files = files  # game -> (file name, snapshot dict)
        self.downloads = []

    def get(self, url, **kwargs):
        game, name = url.split("/snapshots/", 1)[1].split("/", 1)
        if game not in self.files:
            return FakeResponse(404, b"{}")
        file_name, snap = self.files[game]
        if name == "index.json":
            entry = {"file": file_name, "id": snap["id"], "detected": snap["detected"], "version": snap["version"]}
            return FakeResponse(200, json.dumps({"snapshots": [entry]}).encode())
        self.downloads.append(name)
        if name != file_name:
            return FakeResponse(404, b"{}")
        return FakeResponse(200, json.dumps(snap).encode())


@pytest.fixture
def follower(tmp_path, monkeypatch):
    import main  # noqa: F401 - registers every model
    from services import snapshots

    monkeypatch.setattr(snapshots, "SNAPSHOT_SOURCE_URL", "https://source.example")
    monkeypatch.setattr(snapshots, "GAME_SNAPSHOT_PATH", str(tmp_path / "eft"))
    monkeypatch.setattr(snapshots, "ARENA_SNAPSHOT_PATH", str(tmp_path / "arena"))
    return snapshots


def test_a_new_snapshot_is_downloaded_once(follower, tmp_path):
    snap = fx.make_snapshot()
    source = FakeSource({"arena": ("abc1234.json", snap)})
    assert follower.fetch_remote("arena", source) is True
    assert json.loads((tmp_path / "arena" / "abc1234.json").read_text(encoding="utf-8"))["id"] == "abc1234"
    index = json.loads((tmp_path / "arena" / "index.json").read_text(encoding="utf-8"))
    assert index["snapshots"][0]["file"] == "abc1234.json"
    # the same one again: only the index is read
    assert follower.fetch_remote("arena", source) is False
    assert source.downloads == ["abc1234.json"]


def test_a_newer_snapshot_replaces_the_old_one(follower, tmp_path):
    first = fx.make_snapshot()
    follower.fetch_remote("arena", FakeSource({"arena": ("abc1234.json", first)}))
    second = {**fx.make_snapshot(), "id": "def5678", "version": "0.0.0.2", "detected": "2026-01-02T00:00:00+00:00"}
    assert follower.fetch_remote("arena", FakeSource({"arena": ("def5678.json", second)})) is True
    assert sorted(os.listdir(tmp_path / "arena")) == ["def5678.json", "index.json"]


def test_a_broken_download_keeps_what_we_had(follower, tmp_path):
    from game_snapshot import SnapshotError

    follower.fetch_remote("arena", FakeSource({"arena": ("abc1234.json", fx.make_snapshot())}))
    broken = {**fx.make_snapshot(), "id": "bad0000", "format": 99}
    with pytest.raises(SnapshotError):
        follower.fetch_remote("arena", FakeSource({"arena": ("bad0000.json", broken)}))
    assert sorted(os.listdir(tmp_path / "arena")) == ["abc1234.json", "index.json"]


def test_a_source_without_the_game_changes_nothing(follower, tmp_path):
    assert follower.fetch_remote("eft", FakeSource({})) is False
    assert not (tmp_path / "eft").exists()


def test_names_that_are_paths_are_refused(follower, tmp_path):
    source = FakeSource({"arena": ("../escape.json", fx.make_snapshot())})
    assert follower.fetch_remote("arena", source) is False
    assert source.downloads == []


def test_the_main_game_snapshot_is_applied_once(tmp_path, monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    import database
    import game_snapshot
    from database import Base
    from models_items import Item
    from services import snapshots

    engine = create_engine(f"sqlite:///{tmp_path / 'main.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)
    with session() as db:
        db.add(Item(id=fx.RIFLE, name="rifle", weight=2.5, is_weapon=True))
        db.commit()
    folder = tmp_path / "eft"
    folder.mkdir()
    (folder / "abc1234.json").write_text(json.dumps(fx.make_snapshot()), encoding="utf-8")
    (folder / "index.json").write_text(
        json.dumps({"snapshots": [{"file": "abc1234.json", "detected": "2026-01-01T00:00:00+00:00"}]}), encoding="utf-8"
    )
    monkeypatch.setattr(database, "SessionLocal", session)
    monkeypatch.setattr(snapshots, "GAME_SNAPSHOT_PATH", str(folder))
    monkeypatch.setattr(game_snapshot, "_applied_file", lambda: str(tmp_path / "applied.json"))
    epochs = []
    import solver_cache_epoch

    monkeypatch.setattr(solver_cache_epoch, "bump_solver_cache_epoch", lambda: epochs.append(1))
    import ammo_chart

    monkeypatch.setattr(ammo_chart, "start_refresh", lambda: None)

    assert snapshots.apply_game_snapshot() is True
    with session() as db:
        assert db.get(Item, fx.RIFLE).weight == 3.0
    assert game_snapshot.applied_snapshot()["version"] == "0.0.0.1"
    assert snapshots.apply_game_snapshot() is False
    assert epochs == [1]


def _get(path):
    import asyncio

    import main

    sent = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [(b"host", b"localhost")],
        "client": ("127.0.0.1", 9000),
        "server": ("localhost", 80),
    }
    asyncio.run(main.app(scope, receive, send))
    start = next(m for m in sent if m["type"] == "http.response.start")
    headers = {k.decode(): v.decode() for k, v in start["headers"]}
    return start["status"], headers, b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")


def test_the_server_publishes_the_snapshot_it_uses(follower, tmp_path):
    follower.fetch_remote("arena", FakeSource({"arena": ("abc1234.json", fx.make_snapshot())}))
    status, headers, body = _get("/snapshots/arena/index.json")
    assert status == 200 and json.loads(body)["snapshots"][0]["file"] == "abc1234.json"
    assert "max-age=60" in headers["cache-control"]
    status, headers, body = _get("/snapshots/arena/abc1234.json")
    assert status == 200 and json.loads(body)["id"] == "abc1234"
    assert "immutable" in headers["cache-control"]
    # only the snapshot in use, and only known games
    assert _get("/snapshots/arena/other.json")[0] == 404
    assert _get("/snapshots/pve/index.json")[0] == 404
    assert _get("/snapshots/eft/index.json")[0] == 404
