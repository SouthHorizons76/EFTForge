"""Wire compatibility, cache reuse and endpoint boundaries without game data."""

import asyncio
from copy import deepcopy
import json
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from combo_transport import combo_result_event, format_combo_result
from tests.test_reachability_integration import consume, setup_graph


@pytest.fixture
def db():
    # Import after collection so real-data tests can detect an absent game DB.
    import main  # noqa: F401 - creates the app databases
    from database import Base
    from services import solver_cache

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    solver_cache.clear_solver_caches()
    with Session(engine) as session:
        yield session
    solver_cache.clear_solver_caches()
    engine.dispose()


def expand(result):
    """Reconstruct the public legacy contract, preserving all other fields."""
    if result.get("response_format") != "items-v1":
        return result
    items = result["items"]
    restored = {k: v for k, v in result.items() if k not in ("response_format", "items", "combos")}
    restored["combos"] = []
    for combo in result["combos"]:
        row = {k: v for k, v in combo.items() if k not in ("parent_item_id", "child_item_ids")}
        row["parent_item"] = items[combo["parent_item_id"]]
        row["child_items"] = [items[iid] for iid in combo["child_item_ids"]]
        restored["combos"].append(row)
    return restored


def test_wire_round_trip_preserves_repeated_placements_and_does_not_mutate_cache():
    parent = {"id": "p", "name": "父件", "price": None}
    child = {"id": "c", "name": "子件🔧", "price": 0}
    combo = {
        "parent_item": parent,
        "child_items": [child, child],
        "child_slot_ids": ["s1", "s2"],
        "child_slot_parent_item_ids": ["p", "c"],
        "all_child_slot_ids": ["s1"],
        "all_nested_slot_ids": ["s2", "s2"],
        "conflict": {"conflicting_item_id": "external", "conflict_name": "外部"},
        "total_ergo": 1.23456789,
    }
    result = {
        "base": {"total_weight": 3.0},
        "combos": [combo, {**combo, "child_items": []}],
        "timed_out": False,
        "truncated": True,
        "truncation_reasons": ["frontier_cap", "nested_expansion_limit"],
        "metrics": {"frontier_cap_hits": 1},
    }
    snapshot = deepcopy(result)
    legacy = combo_result_event(result, "legacy")
    assert legacy == f"data: {json.dumps({'type': 'result', 'data': result})}\n\n"
    wire = json.loads(combo_result_event(result, "items-v1")[6:])["data"]
    assert list(wire["items"]) == ["p", "c"]
    assert wire["combos"][0]["child_item_ids"] == ["c", "c"]
    assert expand(wire) == snapshot
    assert result == snapshot
    assert format_combo_result(result, "legacy") is result


def test_unknown_format_is_rejected_by_encoder():
    with pytest.raises(ValueError, match="Unknown combo response format"):
        format_combo_result({"combos": []}, "future")


def request(db, response_format="legacy", **overrides):
    import main  # noqa: F401 - creates the app databases
    from routers import combo

    args = dict(
        base_item_id="gun",
        installed_ids=[],
        root_slot_id="root",
        lang="en",
        strength_level=10,
        equip_ergo_modifier=0,
        exclude_child_slot_names=[],
        exclude_item_ids=[],
        db=db,
        response_format=response_format,
    )
    args.update(overrides)
    return asyncio.run(consume(combo.combo_full(**args)))


@pytest.mark.parametrize("first_format", ["legacy", "items-v1"])
def test_formats_share_the_solver_cache_and_keep_request_context(db, first_format):
    import main  # noqa: F401 - creates the app databases
    from services import solver_cache

    setup_graph(
        db,
        {("root", "gun"): ["p"], ("child", "p"): ["a", "b"]},
        fields={"p": {"name_zh": "父件"}, "installed": {"conflicting_item_ids": "a"}},
    )
    first = request(db, first_format, installed_ids=["installed"])
    assert first["metrics"]["cache_hit"] is False
    cached_before = deepcopy(solver_cache.COMBO_FULL_CACHE)
    second_format = "items-v1" if first_format == "legacy" else "legacy"
    # Any attempt to solve again would need to query the graph.
    with patch.object(db, "query", side_effect=AssertionError("wire format caused another solve")):
        second = request(db, second_format, installed_ids=["installed"])
    assert second["metrics"]["cache_hit"] is True
    assert len(solver_cache.COMBO_FULL_CACHE) == 1
    assert solver_cache.COMBO_FULL_CACHE == cached_before
    a, b = expand(first), expand(second)
    assert a["combos"] == b["combos"]
    assert a["base"] == b["base"]
    assert any(c["conflict"] for c in a["combos"])
    assert {k: v for k, v in a.items() if k != "metrics"} == {k: v for k, v in b.items() if k != "metrics"}
    for changes in [
        {"lang": "zh"},
        {"strength_level": 51},
        {"equip_ergo_modifier": -0.1},
        {"exclude_item_ids": ["a"]},
        {"exclude_child_slot_names": ["child"]},
    ]:
        changed = request(db, "items-v1", installed_ids=["installed"], **changes)
        assert changed["metrics"]["cache_hit"] is False
    assert changed["items"]["p"]["name"] == "p"
    solver_cache.clear_solver_caches()
    assert request(db, "items-v1", installed_ids=["installed"])["metrics"]["cache_hit"] is False


def test_child_conflicting_with_the_weapon_is_marked(db):
    # Issue #70: TRAX 2 lists the Saiga-9 itself as a conflict, and installed_ids never hold the weapon.
    setup_graph(
        db,
        {("root", "gun"): ["p"], ("child", "p"): ["a", "b"]},
        fields={"a": {"conflicting_item_ids": "gun"}},
    )
    combos = request(db)["combos"]
    with_a = [c for c in combos if any(ci["id"] == "a" for ci in c["child_items"])]
    assert with_a
    assert all(c["conflict"] and c["conflict"]["conflicting_item_id"] == "gun" for c in with_a)
    assert all(not c["conflict"] for c in combos if c not in with_a)


@pytest.mark.parametrize("response_format", ["legacy", "items-v1"])
def test_empty_root_uses_json_and_direct_call_default_stays_legacy(db, response_format):
    import main  # noqa: F401 - creates the app databases
    from routers import combo

    setup_graph(db, {("root", "gun"): []})
    result = request(db, response_format)
    assert result["combos"] == []
    assert result["truncated"] is False
    if response_format == "items-v1":
        assert result["items"] == {}
        assert result["response_format"] == "items-v1"
    legacy = combo.combo_full("gun", [], "root", "en", 10, 0, [], [], db)
    assert isinstance(legacy, dict)
    assert "response_format" not in legacy
    assert expand(result)["base"] == legacy["base"]


def test_compact_format_keeps_frontier_limit_and_truncation_metadata(db):
    import main  # noqa: F401 - creates the app databases
    from routers import combo

    setup_graph(db, {("root", "gun"): ["p"], ("child", "p"): ["a", "b", "c"]})
    with patch.object(combo, "_COMBO_FRONTIER_CAP", 2):
        compact = request(db, "items-v1")
        legacy = request(db)
    assert compact["truncated"] is True
    assert compact["truncation_reasons"] == ["frontier_cap"]
    assert compact["metrics"]["frontier_cap_hits"] > 0
    assert expand(compact)["combos"] == legacy["combos"]


def test_http_rejects_unknown_format_before_solving(db):
    import main
    from routers import shared
    from services import solver_cache

    async def send_request():
        sent = False
        messages = []

        async def receive():
            nonlocal sent
            if not sent:
                sent = True
                return {
                    "type": "http.request",
                    "body": json.dumps(
                        {
                            "base_item_id": "gun",
                            "installed_ids": [],
                            "root_slot_id": "root",
                            "response_format": "future",
                        }
                    ).encode(),
                    "more_body": False,
                }
            await asyncio.Event().wait()

        async def send(message):
            messages.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.4"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/build/combo-full",
            "query_string": b"",
            "headers": [(b"host", b"localhost"), (b"content-type", b"application/json")],
            "client": ("127.0.0.1", 9000),
            "server": ("localhost", 80),
        }
        await asyncio.wait_for(main.app(scope, receive, send), 10)
        assert next(m for m in messages if m["type"] == "http.response.start")["status"] == 422
        body = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
        assert json.loads(body)["detail"][0]["loc"] == ["body", "response_format"]

    with patch.dict(main.app.dependency_overrides, {shared.get_db: lambda: db}):
        asyncio.run(send_request())
    assert not solver_cache.COMBO_FULL_CACHE
