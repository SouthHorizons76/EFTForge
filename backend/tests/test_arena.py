"""Arena mode: its database built from a snapshot, and the routes that read it.

Only made-up data (tests/snapshot_fixture.py): no real game data belongs in this repo."""

import json
import os

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from tests import snapshot_fixture as fx

os.environ.setdefault("IP_HASH_SECRET", "arena-test-secret")
os.environ.setdefault("ADMIN_API_KEY", "arena-test-admin")


@pytest.fixture
def arena(tmp_path, monkeypatch):
    """A built Arena database in tmp_path, with every module pointed at it."""
    import main  # noqa: F401 - registers every model
    import database_arena
    import sync_arena
    from services import arena as arena_service

    engine = create_engine(f"sqlite:///{tmp_path / 'arena.db'}", connect_args={"check_same_thread": False})
    session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    for module in (database_arena, sync_arena, arena_service):
        monkeypatch.setattr(module, "arena_engine", engine, raising=False)
    monkeypatch.setattr(database_arena, "ArenaSessionLocal", session)
    monkeypatch.setattr(sync_arena, "ArenaSessionLocal", session)
    # No tarkov.db to borrow from: everything has to come from the snapshot
    monkeypatch.setattr(sync_arena, "_main_rows", lambda: {})
    monkeypatch.setattr(sync_arena, "_copy_table", lambda db, model: 0)
    snapshot = tmp_path / "arena.json"
    snapshot.write_text(json.dumps(fx.make_snapshot()), encoding="utf-8")
    monkeypatch.setattr(sync_arena, "ARENA_SNAPSHOT_PATH", str(snapshot))
    monkeypatch.setattr(arena_service, "ARENA_SNAPSHOT_PATH", str(snapshot))
    monkeypatch.setattr(arena_service, "_available", (0.0, False))
    summary = sync_arena.sync_arena()
    return {"summary": summary, "session": session, "engine": engine, "path": snapshot}


def test_the_build_keeps_the_armory_only(arena):
    from models_items import Item

    db = arena["session"]()
    ids = {row.id for row in db.query(Item)}
    assert fx.RIFLE in ids and fx.VEST in ids
    # not in the armory, and built into its holder: neither is a pickable item
    assert fx.NOT_IN_ARMORY not in ids and fx.SOFT_INSERT not in ids
    rifle = db.get(Item, fx.RIFLE)
    assert rifle.name == "Test rifle" and rifle.name_zh == "测试步枪"
    assert rifle.icon_link == f"https://assets.tarkov.dev/{fx.RIFLE}-icon.webp"
    # the factory preset drops what the armory lacks
    assert rifle.factory_attachment_ids == f"{fx.RIFLE},{fx.GRIP_A},{fx.BARREL},{fx.BRAKE}"
    assert rifle.factory_ergonomics == 50 + 8 - 5 - 2
    assert rifle.trader_price is None
    db.close()


def test_slots_only_offer_armory_items(arena):
    from models_slot_allowed import SlotAllowedItem

    db = arena["session"]()
    allowed = {r.allowed_item_id for r in db.query(SlotAllowedItem).filter_by(slot_id=fx.S_SIGHT)}
    assert allowed == {fx.SIGHT}
    db.close()


def test_meta_points_classes_and_exclusions(arena):
    from models_arena import ArenaItem

    db = arena["session"]()
    rifle = db.get(ArenaItem, fx.RIFLE)
    assert rifle.meta_points == 1000 and rifle.class_ids == fx.CLASS_ASSAULT and rifle.gear_slot == "Primary"
    assert json.loads(rifle.excluded_mods) == {fx.CLASS_ASSAULT: [fx.GRIP_B]}
    assert json.loads(rifle.excluded_ammo) == {fx.CLASS_ASSAULT: [fx.ROUND_B]}
    # the vest's built-in soft armor counts into the vest
    assert db.get(ArenaItem, fx.VEST).meta_points == 401
    assert db.get(ArenaItem, fx.PISTOL).gear_slot == "Holster"
    rig = db.get(ArenaItem, fx.RIG)
    assert rig.gear_slot == "TacticalVest" and json.loads(rig.grids) == [[1, 2], [2, 2]]
    assert db.get(ArenaItem, fx.MAGAZINE).carry_kind == "magazine"
    assert db.get(ArenaItem, fx.MEDKIT).carry_kind == "medical"
    db.close()


def test_classes_and_stock_presets(arena):
    from services import arena as arena_service

    db = arena["session"]()
    classes = arena_service.setting(db, "classes")
    assert [(c["key"], c["name"], c["meta_min"], c["meta_max"]) for c in classes] == [
        ("Assault", "Assault", 7500, 10000),
        ("Marksman", "Marksman", 7000, 9500),
    ]
    (preset,) = arena_service.setting(db, "presets")
    assert preset["class_id"] == fx.CLASS_ASSAULT
    slots = [g["slot"] for g in preset["gear"]]
    assert slots == ["FirstPrimaryWeapon", "ArmorVest", "Pockets"]
    rifle = preset["gear"][0]
    assert [c["id"] for c in rifle["children"]] == [fx.GRIP_A, fx.MAGAZINE]
    assert rifle["children"][1]["children"][0] == {"slot": "cartridges", "id": fx.ROUND_A, "count": 30, "children": []}
    # the vest's built-in insert isn't an item of the preset
    assert [c["id"] for c in preset["gear"][1]["children"]] == [fx.PLATE_A]
    assert preset["gear"][2]["children"][0]["id"] == fx.MEDKIT
    db.close()


def test_blast_gang_shop(arena):
    from routers.arena import arena_blast_gang

    db = arena["session"]()
    shop = arena_blast_gang("en", db)
    assert shop["slots"] == {"UberGun": 3, "Armor": 2, "Ulta": 0}
    rifle, vest = shop["items"]
    assert (rifle["id"], rifle["type"], rifle["item_id"]) == (fx.SHOP_RIFLE, "UberGun", fx.RIFLE)
    assert (rifle["price_attack"], rifle["price_defense"], rifle["starter_lot"]) == (3000, 0, True)
    assert (rifle["meta_min"], rifle["meta_max"], rifle["spare_ammo"]) == (1000, 2000, 3)
    assert (rifle["ammo_id"], rifle["ammo_name"]) == (fx.ROUND_A, "RA")
    # The build as builder pairs, parent before child: the loaded rounds aren't part of it,
    # and a part the armory lacks is dropped
    assert rifle["pairs"] == [
        [fx.S_GRIP, fx.GRIP_A],
        [fx.S_BARREL, fx.BARREL],
        [fx.S_MUZZLE, fx.BRAKE],
        [fx.S_MAG, fx.MAGAZINE],
    ]
    assert rifle["excluded_mods"] == [fx.GRIP_B]
    assert rifle["name"] == "Test rifle"
    # Every part's meta points, as the game's range counts them
    assert rifle["meta_points"] == 1000 + 100 + 200 + 160 + 900 + 130 + 12.5
    # Armor keeps its plates by slot name; a built-in insert isn't one
    assert vest["inserts"] == [["front_plate", fx.PLATE_A]]
    assert (vest["slot_available"], vest["unlock"]) == (False, True)
    assert [g["slot"] for g in shop["kits"]["attack"]] == ["Holster", "Scabbard"]
    db.close()


def test_a_weapon_only_arena_has_is_drawn_by_kitbash(arena):
    import sync_arena
    from models_items import Item

    db = arena["session"]()
    rifle = db.get(Item, fx.RIFLE)
    # No tarkov.db row to borrow from, so no tarkov.dev picture: the placeholder that sends
    # /guns to the Kitbash! image route, as for the main game's new weapons
    assert rifle.image_512_link == sync_arena.UNKNOWN_IMAGE_512
    assert rifle.bare_image_512_link == sync_arena.UNKNOWN_IMAGE_512
    db.close()


def test_an_unchanged_snapshot_is_not_rebuilt(arena):
    import sync_arena

    assert arena["summary"]["items"] > 0
    assert sync_arena.sync_arena() is None


def test_a_snapshot_without_an_armory_is_refused(arena, tmp_path):
    import sync_arena
    from game_snapshot import SnapshotError

    snapshot = fx.make_snapshot()
    del snapshot["arena"]
    with pytest.raises(SnapshotError):
        sync_arena.build_arena_db(snapshot)


def _call(path, query=""):
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
        "query_string": query.encode(),
        "headers": [(b"host", b"localhost")],
        "client": ("127.0.0.1", 9000),
        "server": ("localhost", 80),
    }
    asyncio.run(main.app(scope, receive, send))
    status = next(m for m in sent if m["type"] == "http.response.start")["status"]
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, json.loads(body) if body else None


def test_routes_read_the_arena_database_when_asked(arena, monkeypatch):
    from routers import shared

    monkeypatch.setattr(shared, "ArenaSessionLocal", arena["session"])
    from routers import arena as arena_router

    monkeypatch.setattr(arena_router, "ArenaSessionLocal", arena["session"])
    status, guns = _call("/guns", "game=arena")
    assert status == 200
    rifle = next(g for g in guns if g["id"] == fx.RIFLE)
    assert rifle["meta_points"] == 1000 and rifle["arena_class_ids"] == [fx.CLASS_ASSAULT]
    assert rifle["arena_excluded_mods"] == {fx.CLASS_ASSAULT: [fx.GRIP_B]}
    # the default preset: the rifle, grip A, the barrel and its brake
    assert rifle["preset_meta_points"] == 1000 + 100 + 200 + 160
    status, allowed = _call(f"/slots/{fx.S_GRIP}/allowed-items", "game=arena")
    assert status == 200 and {a["id"]: a["meta_points"] for a in allowed} == {fx.GRIP_A: 100, fx.GRIP_B: 150}
    status, config = _call("/arena/config", "lang=zh")
    assert status == 200 and config["classes"][0]["name"] == "突击"
    status, items = _call("/arena/items")
    assert status == 200
    assert {i["id"]: i["gear_slot"] or i["carry_kind"] for i in items}[fx.RIG] == "TacticalVest"


def test_the_main_game_never_carries_arena_fields(arena, monkeypatch, tmp_path):
    from database import Base
    from models_items import Item
    from routers import shared

    engine = create_engine(f"sqlite:///{tmp_path / 'main.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add(Item(id=fx.RIFLE, name="main rifle", is_weapon=True, weight=3))
    db.commit()
    import main

    monkeypatch.setitem(main.app.dependency_overrides, shared.get_db, lambda: db)
    status, guns = _call("/guns")
    assert status == 200 and guns[0]["name"] == "main rifle" and "meta_points" not in guns[0]
    db.close()


def test_arena_answers_503_without_its_data(monkeypatch):
    import main  # noqa: F401
    from services import arena as arena_service

    monkeypatch.setattr(arena_service, "ARENA_SNAPSHOT_PATH", "")
    monkeypatch.setattr(arena_service, "_available", (0.0, False))
    assert _call("/guns", "game=arena")[0] == 503
    assert _call("/arena/config")[0] == 503
    status, version = _call("/data-version")
    assert status == 200 and version["arena"] is False


def test_points_for_a_loadout(arena, monkeypatch):
    import asyncio

    import main
    from routers import arena as arena_router

    monkeypatch.setattr(arena_router, "ArenaSessionLocal", arena["session"])
    sent = []
    body = json.dumps({"item_ids": [fx.MAGAZINE, fx.ROUND_A, "f" * 24]}).encode()

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/arena/points",
        "raw_path": b"/arena/points",
        "query_string": b"",
        "headers": [(b"host", b"localhost"), (b"content-type", b"application/json")],
        "client": ("127.0.0.1", 9000),
        "server": ("localhost", 80),
    }
    asyncio.run(main.app(scope, receive, send))
    points = json.loads(b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body"))
    assert set(points) == {fx.MAGAZINE, fx.ROUND_A}
    assert points[fx.MAGAZINE]["magazine_capacity"] == 30
    assert points[fx.ROUND_A]["meta_points"] == 12.5
