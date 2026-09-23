"""Verify conservative slot roles and the shared slot endpoint contract."""

import asyncio
import json
import os
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

os.environ.setdefault("IP_HASH_SECRET", "slot-semantics-test-secret")
os.environ.setdefault("ADMIN_API_KEY", "slot-semantics-test-admin")
os.environ.setdefault("DISABLE_BG_MIGRATE", "1")

from database import Base
from models_items import Item
from models_slot_allowed import SlotAllowedItem
from models_slots import Slot
from slot_semantics import SLOT_ROLES, category_role, slot_role

FOREGRIP = "55818af64bdc2d5b648b4570"
SCOPE = "55818ae44bdc2dde698b456c"
REFLEX = "55818ad54bdc2ddc698b4569"
MOUNT = "55818b224bdc2dde698b456f"


@pytest.mark.parametrize(
    "game_name, expected",
    [
        ("mod_reciever", "receiver"),
        ("mod_receiver", "receiver"),
        ("mod_handguard", "handguard"),
        ("mod_catch", "catch"),
        ("mod_barrel", "barrel"),
        ("mod_gas_block", "gas_block"),
        ("mod_muzzle_001", "muzzle"),
        ("mod_stock_003", "stock"),
        ("mod_stock_akms", "stock"),
        ("mod_stock_axis", "stock"),
        ("mod_scope_002", "scope"),
        ("mod_sight_rear", "rear_sight"),
        ("mod_sight_front", "front_sight"),
        ("mod_magazine", "magazine"),
        ("mod_pistol_grip", "pistol_grip"),
        ("mod_pistol_grip_akms", "pistol_grip"),
        ("mod_pistolgrip_001", "grip"),
        ("mod_foregrip", "foregrip"),
        ("mod_bipod", "bipod"),
        ("mod_charge_001", "charge"),
        ("mod_tactical001", "tactical"),
        ("mod_tactical_2", "tactical"),
        ("mod_flashlight", "tactical"),
        ("mod_mount_006", "mount"),
        ("mod_launcher", "launcher"),
        ("mod_nvg", "shroud"),
        ("mod_trigger", "trigger"),
        ("camora_005", "chamber"),
        ("mod_hammer", "hammer"),
        ("mod_future_scope", "unknown"),
        ("Scope", "unknown"),
        ("", "unknown"),
        (None, "unknown"),
    ],
)
def test_raw_names_and_aliases(game_name, expected):
    assert slot_role(game_name) == expected
    assert expected in SLOT_ROLES


@pytest.mark.parametrize(
    "categories, expected",
    [
        ([FOREGRIP, FOREGRIP], "foregrip"),
        ([SCOPE, REFLEX], "scope"),
        ([SCOPE, MOUNT], "mount"),
        ([FOREGRIP, SCOPE], "mount"),
        ([SCOPE, None], "mount"),
        ([SCOPE, "unrecognized-category"], "mount"),
        ([f"{FOREGRIP},{SCOPE}"], "mount"),
        (["55818ac54bdc2d5b648b456e"], "mount"),
        ([], "mount"),
    ],
)
def test_generic_mount_requires_unanimous_known_semantics(categories, expected):
    assert slot_role("mod_mount_000", categories) == expected
    assert slot_role("mod_scope", categories) == "scope"
    assert slot_role(None, categories) == "unknown"


def test_category_ancestors_do_not_change_a_known_role():
    assert category_role(f"54009119af1c881c07000029, {FOREGRIP},5448fe124bdc2da5018b4567") == "foregrip"
    assert category_role(None) == "unknown"


@pytest.fixture
def db():
    # Delay main's startup until execution so collection stays safe for real-data tests.
    import main  # noqa: F401

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add_all(
            [
                Item(
                    id="gun", name="gun", is_weapon=True, weight=1, base_ergonomics=30, factory_attachment_ids="adapter"
                ),
                Item(id="adapter", name="adapter", weight=0.1),
                Item(id="scope", name="Not an optic", category_ids=SCOPE, attachment_category="Foregrip"),
                Item(id="reflex", name="Another misleading label", category_ids=REFLEX, attachment_category="Stock"),
                Item(id="foregrip", name="Scope", category_ids=FOREGRIP, attachment_category="Scope"),
            ]
        )
        specs = [
            ("root", "gun", "mod_reciever", True, ["adapter"]),
            ("optic", "adapter", "mod_mount_000", False, ["scope", "reflex"]),
            ("mixed", "adapter", "mod_mount_001", False, ["scope", "foregrip"]),
            ("unknown", "adapter", "mod_future", False, ["scope"]),
            ("empty", "adapter", "mod_scope", True, []),
        ]
        for sid, owner, game_name, required, candidates in specs:
            session.add(
                Slot(id=sid, parent_item_id=owner, slot_game_name=game_name, slot_name="Stock", required=required)
            )
            session.add_all(SlotAllowedItem(slot_id=sid, allowed_item_id=iid) for iid in candidates)
        session.commit()
        yield session
    engine.dispose()


def test_slot_api_contract_is_identical_for_single_batch_and_factory_init(db):
    import main

    async def request_json(method, path, body=None, query=b""):
        messages = []
        received = False

        async def receive():
            nonlocal received
            if not received:
                received = True
                return {"type": "http.request", "body": json.dumps(body).encode() if body is not None else b""}
            await asyncio.Event().wait()

        async def send(message):
            messages.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.4"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "query_string": query,
            "headers": [(b"host", b"localhost"), (b"content-type", b"application/json")],
            "client": ("127.0.0.1", 9000),
            "server": ("localhost", 80),
        }
        await asyncio.wait_for(main.app(scope, receive, send), 10)
        assert next(message for message in messages if message["type"] == "http.response.start")["status"] == 200
        return json.loads(
            b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
        )

    async def request():
        single = {}
        for owner in ["gun", "adapter"]:
            single[owner] = await request_json("GET", f"/items/{owner}/slots")
        batch = await request_json("POST", "/items/slots/batch", {"item_ids": ["gun", "adapter", "missing"]})
        init = await request_json("GET", "/guns/gun/init", query=b"lang=zh")
        assert batch["missing"] == []
        for owner in single:
            assert single[owner] == batch[owner] == init["slots_by_item"][owner]
        slots = {slot["id"]: slot for group in single.values() for slot in group}
        assert {sid: slot["slot_role"] for sid, slot in slots.items()} == {
            "root": "receiver",
            "optic": "scope",
            "mixed": "mount",
            "unknown": "unknown",
            "empty": "scope",
        }
        assert slots["root"]["required"] is True
        assert slots["optic"]["required"] is False
        assert slots["empty"]["has_allowed_items"] is False

    with patch.dict(main.app.dependency_overrides, {main.get_db: lambda: db}):
        asyncio.run(request())


def test_slot_semantics_lookup_is_batched_and_missing_items_remain_ambiguous(db):
    import main

    for index in range(50):
        sid = f"repeated-{index}"
        db.add(Slot(id=sid, parent_item_id="gun", slot_game_name="mod_mount_000"))
        db.add(SlotAllowedItem(slot_id=sid, allowed_item_id="scope"))
    db.add(SlotAllowedItem(slot_id="optic", allowed_item_id="missing-item"))
    db.commit()
    slots = db.query(Slot).all()
    statements = []

    def record_statement(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(db.bind, "before_cursor_execute", record_statement)
    try:
        result = {slot["id"]: slot for slot in main._slot_dtos(db, slots)}
    finally:
        event.remove(db.bind, "before_cursor_execute", record_statement)
    assert len(statements) == 2
    assert result["optic"]["slot_role"] == "mount"
    assert all(result[f"repeated-{index}"]["slot_role"] == "scope" for index in range(50))
    assert main._slot_dtos(db, []) == []


@pytest.mark.parametrize("lang", ["en", "zh"])
def test_installed_item_roles_survive_every_build_loading_path(db, lang):
    import main
    from models_item_offers import ItemOffer
    from tests.test_reachability_integration import consume

    adapter = db.get(Item, "adapter")
    adapter.category_ids = "55818a104bdc2db9688b4569"
    adapter.attachment_category = "Scope"
    adapter.attachment_category_zh = "Translated optic label"
    for item in db.query(Item).all():
        item.name_zh = f"Translated {item.id}"
    db.get(Item, "gun").factory_attachment_ids = "adapter,scope"
    db.get(Slot, "root").slot_game_name = "mod_mount_000"
    db.add(Item(id="untyped", name="Scope", name_zh="Translated scope", weight=0.1))
    db.add_all(
        [
            SlotAllowedItem(slot_id="root", allowed_item_id="scope"),
            SlotAllowedItem(slot_id="root", allowed_item_id="untyped"),
        ]
    )
    for item_id in ["adapter", "scope", "reflex", "foregrip", "untyped"]:
        db.add(
            ItemOffer(
                item_id=item_id, vendor_normalized="mechanic", trader_level=1, price=100, price_rub=100, currency="RUB"
            )
        )
    db.commit()
    main._clear_solver_caches()

    expected = {
        "adapter": "handguard",
        "scope": "scope",
        "reflex": "scope",
        "foregrip": "foregrip",
        "untyped": "unknown",
    }

    def assert_roles(records):
        by_id = {record["id"]: record for record in records}
        assert by_id
        for item_id, record in by_id.items():
            assert record["attachment_role"] == expected[item_id]
            if lang == "zh":
                expected_name = f"Translated {item_id}" if item_id != "untyped" else "Translated scope"
                assert record["name"] == expected_name
        return by_id

    def tree_items(tree):
        for node in tree.values():
            yield node["item"]
            yield from tree_items(node["children"])

    try:
        # Keep the mixed slot generic while giving its installed handguard a usable role.
        assert main.get_item_slots("gun", db)[0]["slot_role"] == "mount"
        slot_ids = ["root", "optic", "mixed"]
        singles = assert_roles(item for sid in slot_ids for item in main.get_allowed_items(sid, lang, db))
        assert set(singles) == set(expected)
        batch = main.get_allowed_items_batch(slot_ids, lang, db)
        assert assert_roles(item for items in batch.values() for item in items) == singles
        factory = main.get_gun_init("gun", lang=lang, db=db)
        assert set(assert_roles(tree_items(factory["factory_tree"]))) == {"adapter", "scope"}

        combo_roles = []
        for response_format in ["legacy", "items-v1"]:
            result = asyncio.run(
                consume(main.combo_full("gun", [], "root", lang, 10, 0, [], [], db, response_format=response_format))
            )
            if response_format == "items-v1":
                records = list(result["items"].values())
            else:
                records = [item for combo in result["combos"] for item in [combo["parent_item"], *combo["child_items"]]]
            # Allow frontier pruning while checking both the parent and child serializers.
            by_id = assert_roles(records)
            assert {"adapter", "scope"} <= set(by_id)
            combo_roles.append({item_id: item["attachment_role"] for item_id, item in by_id.items()})
        assert combo_roles[0] == combo_roles[1]
    finally:
        main._clear_solver_caches()
