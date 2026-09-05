"""In-memory endpoint fixtures: run in CI without a downloaded game database."""

import asyncio
import json
import os
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

os.environ.setdefault("IP_HASH_SECRET", "reachability-test-secret")
os.environ.setdefault("ADMIN_API_KEY", "reachability-test-admin")
os.environ.setdefault("DISABLE_BG_MIGRATE", "1")

from compatibility import CompatibilityIndex  # noqa: E402
from database import Base  # noqa: E402
from models_items import Item  # noqa: E402
from models_item_offers import ItemOffer  # noqa: E402
from models_slots import Slot  # noqa: E402
from models_slot_allowed import SlotAllowedItem  # noqa: E402
from optimizer.compat_map import build_compatibility_map  # noqa: E402
from optimizer.milp import build_and_solve  # noqa: E402
from optimizer.solver import (  # noqa: E402
    OptimizeParams,
    _load_candidates_and_prices,
    get_moa_floor,
    get_stat_ranges,
    optimize_weapon,
)
from stats import _compute_stats  # noqa: E402


@pytest.fixture
def db():
    # Import during execution, after all real-data tests have decided whether
    # a synced database exists. main's import creates an empty development DB.
    import main

    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    main._clear_solver_caches()
    with Session(engine) as session:
        yield session
    main._clear_solver_caches()
    engine.dispose()


def setup_graph(db, edges, required=(), fields=None):
    """edges maps (slot, owner) to candidates; all candidates initially priced."""
    fields = fields or {}
    ids = {"gun"} | {o for _, o in edges} | {i for values in edges.values() for i in values} | set(fields)
    for n, iid in enumerate(sorted(ids)):
        kwargs = dict(
            id=iid,
            name=iid,
            is_weapon=iid == "gun",
            weight=0.1 * (n + 1),
            base_ergonomics=30 if iid == "gun" else None,
            ergonomics_modifier=n + 1,
            recoil_vertical=100,
            recoil_horizontal=100,
            center_of_impact=1.0 if iid == "gun" else None,
        )
        kwargs.update(fields.get(iid, {}))
        db.add(Item(**kwargs))
        db.add(
            ItemOffer(
                item_id=iid, vendor_normalized="mechanic", trader_level=1, price=100, price_rub=100, currency="RUB"
            )
        )
    for (sid, owner), allowed in edges.items():
        db.add(Slot(id=sid, parent_item_id=owner, slot_name=sid, required=sid in required))
        for iid in allowed:
            db.add(SlotAllowedItem(slot_id=sid, allowed_item_id=iid))
    db.commit()


def test_market_disconnect_include_exemption_and_exclusion(db):
    setup_graph(db, {("root", "gun"): ["adapter", "other"], ("child", "adapter"): ["tip"]})
    db.query(ItemOffer).filter_by(item_id="adapter").delete()
    db.commit()
    params = OptimizeParams(include_items=["tip"])
    result = optimize_weapon(db, "gun", params)
    assert result["status"] == "infeasible"
    assert result["reason_details"][0]["key"] == "optimizer.reason.requiredItemUnavailable"
    result = optimize_weapon(db, "gun", OptimizeParams(include_items=["adapter", "tip"]))
    assert result["status"] == "optimal"
    assert set(result["selected_items"]) == {"adapter", "tip"}
    assert result["item_prices"]["adapter"]["no_price"] is True
    result = optimize_weapon(db, "gun", OptimizeParams(include_items=["tip"], exclude_items=["adapter"]))
    assert result["status"] == "infeasible"


def test_required_slots_reject_incomplete_builds_and_propagate(db):
    setup_graph(
        db,
        {("root", "gun"): ["adapter", "other"], ("child", "adapter"): ["tip"]},
        required=["root", "child"],
        fields={"adapter": {"ergonomics_modifier": 60}},
    )
    result = optimize_weapon(db, "gun", OptimizeParams(exclude_items=["tip"]))
    assert result["selected_items"] == ["other"]
    assert result["metrics"]["required_failure_candidate_count"] == 1
    result = optimize_weapon(db, "gun", OptimizeParams(exclude_items=["tip", "other"]))
    assert result["status"] == "infeasible"
    # Direct model callers must also forbid an incomplete owner, even without
    # preprocessing. The old model silently omitted this empty required slot.
    weapon = db.get(Item, "gun")
    mods = {i.id: i for i in db.query(Item).filter(Item.id != "gun")}
    result = build_and_solve(
        weapon,
        mods,
        build_compatibility_map(db, "gun"),
        ["adapter", "other"],
        {i: {"price_rub": 100} for i in mods},
        OptimizeParams(),
    )
    assert result["status"] == "optimal"
    assert result["selected_items"] == ["other"]


def test_empty_required_root_is_reported_even_with_other_candidates(db):
    setup_graph(db, {("root", "gun"): [], ("optional", "gun"): ["other"]}, required=["root"])
    result = optimize_weapon(db, "gun", OptimizeParams())
    assert result["status"] == "infeasible"
    assert result["reason_key"] == "optimizer.reason.requiredSlotUnavailable"


def test_auxiliary_ranges_use_same_reachable_candidates_and_ignore_include_constraints(db):
    setup_graph(
        db,
        {("root", "gun"): ["adapter", "mag10"], ("child", "adapter"): ["mag90"]},
        fields={
            "adapter": {"category_ids": "excluded"},
            "mag10": {"magazine_capacity": 10},
            "mag90": {"magazine_capacity": 90},
        },
    )
    params = OptimizeParams(exclude_categories=["excluded"], include_items=["mag90"])
    ranges = get_stat_ranges(db, "gun", params)
    assert ranges["ranges"]["mag_capacity"]["values"] == [10]
    floor = get_moa_floor(db, "gun", params)
    assert floor["status"] == "ok"
    assert floor["floor"] > 0
    result = optimize_weapon(db, "gun", params)
    assert result["status"] == "infeasible"


def test_request_views_do_not_leak_and_factory_parts_keep_pricing_exemption(db):
    setup_graph(
        db,
        {("root", "gun"): ["adapter", "other"], ("child", "adapter"): ["tip"]},
        fields={"gun": {"factory_attachment_ids": "adapter"}},
    )
    db.query(ItemOffer).filter_by(item_id="adapter").delete()
    db.commit()
    _, _, _, filtered = _load_candidates_and_prices(db, "gun", OptimizeParams(exclude_items=["adapter"]))
    _, _, _, unfiltered = _load_candidates_and_prices(db, "gun", OptimizeParams())
    assert set(filtered[0]) == {"other"}
    assert set(unfiltered[0]) == {"adapter", "other", "tip"}
    assert unfiltered[1]["adapter"]["price_rub"] == 0
    assert not unfiltered[1]["adapter"].get("no_price")


@pytest.mark.parametrize("nested", [False, True])
@pytest.mark.parametrize(
    "params, expected_vendor, expected_price",
    [
        (OptimizeParams(), "flea-market", 10),
        (OptimizeParams(player_level=1), "mechanic", 20),
        (OptimizeParams(flea_available=False, trader_levels={"mechanic": 1}), "prapor", 100),
        (OptimizeParams(flea_available=False, trader_levels={"mechanic": 0}), "prapor", 100),
    ],
)
def test_projected_offers_preserve_access_filters_and_price_selection(
    db, nested, params, expected_vendor, expected_price
):
    edges = {("root", "gun"): ["a"]}
    if nested:
        edges[("child", "a")] = []
    setup_graph(db, edges)
    db.query(ItemOffer).filter_by(item_id="a").delete()
    for vendor, level, price, flea in [
        ("prapor", 1, 100, False),
        ("mechanic", 4, 20, False),
        ("flea-market", None, 10, True),
        ("skier", 1, None, False),
    ]:
        db.add(
            ItemOffer(
                item_id="a",
                vendor_normalized=vendor,
                trader_level=level,
                price=price,
                currency="RUB",
                price_rub=price,
                is_flea=flea,
                min_level_flea=15 if flea else None,
            )
        )
    db.commit()
    _, _, _, (candidates, prices) = _load_candidates_and_prices(db, "gun", params)
    assert candidates == ["a"]
    assert prices["a"] == {
        "price": expected_price,
        "currency": "RUB",
        "price_rub": expected_price,
        "vendor": expected_vendor,
    }


def test_pruning_preserves_legacy_multi_parent_slot_constraints(db):
    setup_graph(
        db,
        {
            ("left", "gun"): ["a", "unavailable"],
            ("right", "gun"): ["b"],
            ("shared", "unavailable"): ["a", "b"],
        },
    )
    result = optimize_weapon(db, "gun", OptimizeParams(exclude_items=["unavailable"]))
    assert result["status"] == "optimal"
    # The existing item-level MILP imposes a mutex on the shared slot even
    # when its owner is absent. PR2 must not silently change that formulation.
    assert len(result["selected_items"]) == 1


def test_fixed_weapon_conflicts_still_cover_slots_of_removed_owners(db):
    setup_graph(
        db,
        {("root", "gun"): ["a", "b", "unavailable"], ("blocked", "unavailable"): ["a"]},
        fields={"gun": {"conflicting_slot_ids": "blocked"}},
    )
    result = optimize_weapon(db, "gun", OptimizeParams(exclude_items=["unavailable"]))
    assert result["status"] == "optimal"
    assert result["selected_items"] == ["b"]
    assert result["metrics"]["weapon_conflict_candidate_count"] == 1


async def consume(response):
    if isinstance(response, dict):
        return response
    async for chunk in response.body_iterator:
        for line in chunk.splitlines():
            if line.startswith("data: "):
                event = json.loads(line[6:])
                if event.get("type") == "result":
                    return event["data"]
    raise AssertionError("SSE stream ended without a result")


def combo(db, installed=(), excluded=()):
    import main

    main._clear_solver_caches()
    return asyncio.run(consume(main.combo_full("gun", list(installed), "root", "en", 10, 0, [], list(excluded), db)))


@pytest.mark.parametrize("external", [False, True])
def test_combo_keeps_partial_and_externally_conflicted_results(db, external):
    setup_graph(
        db,
        {
            ("root", "gun"): ["parent"],
            ("child", "parent"): ["adapter", "other"],
            ("nested", "adapter"): ["tip"],
        },
        required=["child", "nested"],
        fields={
            "parent": {"conflicting_item_ids": "adapter"},
            "installed": {"conflicting_item_ids": "adapter" if external else None},
        },
    )
    installed = ["installed"] if external else []
    with (
        patch.object(CompatibilityIndex, "blocked_edges", return_value={}),
        patch.object(CompatibilityIndex, "owner_blocked_edges", return_value={}),
    ):
        reference = combo(db, installed)
    actual = combo(db, installed)
    assert actual["combos"] == reference["combos"]
    assert not actual["truncated"]
    assert any(not c["child_items"] for c in actual["combos"])
    if external:
        assert any(c["conflict"] for c in actual["combos"])
    else:
        assert actual["metrics"]["pruned_candidate_edge_count"] == 2
        assert all(i["id"] != "adapter" for c in actual["combos"] for i in c["child_items"])


def test_combo_child_exclusions_do_not_exclude_root_or_alternative_path(db):
    setup_graph(
        db,
        {
            ("root", "gun"): ["parent"],
            ("child", "parent"): ["a", "b"],
            ("as", "a"): ["tip"],
            ("bs", "b"): ["tip"],
        },
    )
    result = combo(db, excluded=["parent", "a"])
    assert result["combos"]
    assert all(c["parent_item"]["id"] == "parent" for c in result["combos"])
    assert any({i["id"] for i in c["child_items"]} == {"b", "tip"} for c in result["combos"])


def test_combo_nested_owner_conflict_is_pruned_without_changing_results(db):
    setup_graph(
        db,
        {("root", "gun"): ["parent"], ("child", "parent"): ["adapter"], ("nested", "adapter"): ["tip"]},
        fields={"adapter": {"conflicting_item_ids": "tip"}},
    )
    with (
        patch.object(CompatibilityIndex, "blocked_edges", return_value={}),
        patch.object(CompatibilityIndex, "owner_blocked_edges", return_value={}),
    ):
        reference = combo(db)
    result = combo(db)
    assert result["combos"] == reference["combos"]
    assert result["metrics"]["pruned_candidate_edge_count"] == 1


def test_combo_snapshots_preserve_factory_stats_and_request_local_names(db):
    import main

    setup_graph(
        db,
        {("root", "gun"): ["parent"], ("child", "parent"): ["adapter"], ("nested", "adapter"): ["tip"]},
        fields={
            "gun": {
                "factory_attachment_ids": "parent,adapter",
                "factory_weight": 3.5,
                "factory_ergonomics": 70,
                "factory_recoil_vertical": 40,
                "factory_recoil_horizontal": 80,
            },
            "parent": {"name_zh": "父件", "short_name_zh": "父", "velocity_modifier": 5},
            "adapter": {"heat_factor": 1.3, "cooling_factor": 0.8, "durability_burn_factor": 1.4},
            "tip": {"center_of_impact": 0.12, "sighting_range": 300, "accuracy_modifier": 10},
        },
    )
    original_items = {i.id: i for i in db.query(Item).all()}
    for lang, strength, equipment in [("en", 10, 0), ("zh", 51, -0.1)]:
        result = asyncio.run(consume(main.combo_full("gun", [], "root", lang, strength, equipment, [], [], db)))
        assert len(result["combos"]) > 1
        for build in result["combos"]:
            ids = [build["parent_item"]["id"]] + [i["id"] for i in build["child_items"]]
            expected = _compute_stats(original_items["gun"], ids, original_items, strength, equipment)
            assert {key: build[key] for key in expected} == expected
            assert build["parent_item"]["name"] == ("父件" if lang == "zh" else "parent")
