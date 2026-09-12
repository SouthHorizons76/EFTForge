"""Exercise sampled tradeoffs with small, real MILP models and no game download."""

import math
import os
from unittest.mock import patch

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

os.environ.setdefault("IP_HASH_SECRET", "explore-test-secret")
os.environ.setdefault("ADMIN_API_KEY", "explore-test-admin")

from database import Base  # noqa: E402
from models_items import Item  # noqa: E402
from models_item_offers import ItemOffer  # noqa: E402
from models_slots import Slot  # noqa: E402
from models_slot_allowed import SlotAllowedItem  # noqa: E402
from models_weapon_presets import WeaponDefaultPreset  # noqa: E402, F401
from optimizer.explore import explore_weapon, frontier_points  # noqa: E402
from optimizer.explore_request import ExploreRequest  # noqa: E402
from optimizer.solver import OptimizeParams  # noqa: E402
from stats import _compute_stats  # noqa: E402


@pytest.fixture
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(
            Item(
                id="gun",
                name="gun",
                is_weapon=True,
                base_ergonomics=30,
                weight=2,
                recoil_vertical=100,
                recoil_horizontal=150,
                center_of_impact=0.05,
            )
        )
        session.add(Slot(id="slot", parent_item_id="gun", slot_name="stock", required=True))
        for iid, ergo, recoil, price in [("a", 0, -0.5, 100), ("b", 10, -0.3, 200), ("c", 20, -0.1, 400)]:
            session.add(
                Item(id=iid, name=iid, is_weapon=False, ergonomics_modifier=ergo, recoil_modifier=recoil, weight=0.1)
            )
            session.add(SlotAllowedItem(slot_id="slot", allowed_item_id=iid))
            session.add(
                ItemOffer(
                    item_id=iid,
                    vendor_normalized="mechanic",
                    trader_level=1,
                    price=price,
                    price_rub=price,
                    currency="RUB",
                )
            )
        session.add(
            ItemOffer(
                item_id="gun", vendor_normalized="mechanic", trader_level=1, price=1000, price_rub=1000, currency="RUB"
            )
        )
        session.commit()
        yield session
    engine.dispose()


@pytest.mark.parametrize("tradeoff,expected", [("price", 3), ("recoil", 3), ("ergo", 1)])
def test_real_frontiers_have_valid_builds_and_correct_stats(db, tradeoff, expected):
    result = explore_weapon(db, "gun", OptimizeParams(), tradeoff, 10)
    assert result["complete"]
    assert len(result["points"]) == expected
    weapon = db.get(Item, "gun")
    mods = {i.id: i for i in db.query(Item).filter(Item.is_weapon == False)}  # noqa: E712
    for point in result["points"]:
        build = point["build"]
        assert build["status"] == "optimal"
        assert len(build["slot_pairs"]) == 1
        assert build["slot_pairs"][0][0] == "slot"
        stats = _compute_stats(weapon, build["selected_items"], mods)
        assert {key: build["final_stats"][key] for key in stats} == stats
        assert point["price"] == 1000 + build["total_price_rub"]
    assert frontier_points(result["points"], tradeoff) == result["points"]


def test_constraints_and_filters_apply_to_every_sample(db):
    params = OptimizeParams(max_price=200, min_ergonomics=35, exclude_items=["c"], max_recoil_v=75)
    result = explore_weapon(db, "gun", params, "price", 10)
    assert [p["build"]["selected_items"] for p in result["points"]] == [["b"]]
    assert params.min_ergonomics == 35
    assert params.use_tchebycheff
    locked = explore_weapon(db, "gun", OptimizeParams(include_items=["c"]), "recoil", 10)
    assert [p["build"]["selected_items"] for p in locked["points"]] == [["c"]]


def test_recoil_price_sweep_finds_intermediate_build(db):
    for iid, price in [("a", 400), ("b", 200), ("c", 100)]:
        offer = db.query(ItemOffer).filter(ItemOffer.item_id == iid).one()
        offer.price = offer.price_rub = price
    db.commit()
    result = explore_weapon(db, "gun", OptimizeParams(), "ergo", 10)
    assert [p["build"]["selected_items"] for p in result["points"]] == [["a"], ["b"], ["c"]]


def test_api_holds_shared_solver_slot_for_entire_curve(db, monkeypatch):
    from contextlib import contextmanager
    from starlette.requests import Request
    import main

    events = []

    @contextmanager
    def slot(ip):
        events.append("acquire")
        yield
        events.append("release")

    def solve(*args):
        assert events == ["rate", "acquire"]
        events.append("solve")
        return explore_weapon(*args)

    monkeypatch.setattr(main, "_check_solve_rate_limit", lambda ip: events.append("rate"))
    monkeypatch.setattr(main, "_solve_slot", slot)
    monkeypatch.setattr(main, "explore_weapon", solve)
    request = Request({"type": "http", "headers": [], "client": ("203.0.113.80", 1234)})
    result = main.build_explore(request, ExploreRequest(weapon_id="gun", steps=10, max_price=200), db)
    assert events == ["rate", "acquire", "solve", "release"]
    assert result["points"]
    assert all(p["build"]["total_price_rub"] <= 200 for p in result["points"])


def test_api_rejects_unknown_weapon_before_solver(db, monkeypatch):
    from fastapi import HTTPException
    from starlette.requests import Request
    import main

    monkeypatch.setattr(main, "_check_solve_rate_limit", lambda ip: None)
    request = Request({"type": "http", "headers": [], "client": ("203.0.113.80", 1234)})
    with pytest.raises(HTTPException) as error:
        main.build_explore(request, ExploreRequest(weapon_id="missing"), db)
    assert error.value.status_code == 404


def test_market_and_infeasibility_are_respected(db):
    result = explore_weapon(db, "gun", OptimizeParams(trader_levels={"mechanic": 0}, flea_available=False))
    assert result["points"] == []
    assert result["status"] == "infeasible"


def test_loaded_magazine_weight_filters_candidates(db):
    db.add(Item(id="ammo", name="ammo", is_ammo=True, weight=0.05))
    for iid, capacity in [("a", 10), ("b", 20), ("c", 30)]:
        db.get(Item, iid).magazine_capacity = capacity
    db.commit()
    result = explore_weapon(db, "gun", OptimizeParams(selected_ammo_id="ammo", max_weight=2.7))
    assert result["points"]
    for point in result["points"]:
        assert point["build"]["selected_items"] == ["a"]
        assert point["build"]["final_stats"]["total_weight"] == 2.6


def test_deadline_retains_incumbents_and_stops_new_solves(db):
    from optimizer import explore

    real_solve = explore.optimize_weapon
    now = [0.0]

    def timed_solve(*args, **kwargs):
        # Inspect the shared deadline, then let the real solver use its own clock.
        assert kwargs.pop("deadline") == 30
        result = real_solve(*args, **kwargs)
        now[0] = 31
        return result

    with patch.object(explore.time, "perf_counter", side_effect=lambda: now[0]), patch.object(
        explore, "optimize_weapon", side_effect=timed_solve
    ) as solve:
        result = explore_weapon(db, "gun", OptimizeParams())
    assert solve.call_count == 1
    assert result["points"]
    assert not result["complete"]
    assert result["status"] == "partial"


def test_timeout_without_incumbent_is_not_infeasible(db):
    with patch("optimizer.explore.optimize_weapon", return_value={"status": "timeout"}):
        result = explore_weapon(db, "gun", OptimizeParams())
    assert result["status"] == "partial"
    assert result["points"] == []


def test_duplicate_coordinates_keep_cheapest_build():
    a = {"ergo": 40, "recoil_v": 60, "price": 300}
    b = {"ergo": 40, "recoil_v": 60, "price": 200}
    worse = {"ergo": 30, "recoil_v": 80, "price": 100}
    assert frontier_points([a, b, worse], "price") == [b]


@pytest.mark.parametrize(
    "field,value",
    [
        ("steps", 9),
        ("steps", 82),
        ("tradeoff", "bad"),
        ("max_price", math.nan),
        ("max_recoil_v", math.inf),
        ("max_weight", -1),
        ("strength_level", 52),
    ],
)
def test_request_rejects_invalid_parameters(field, value):
    with pytest.raises(ValidationError):
        ExploreRequest(weapon_id="gun", **{field: value})
