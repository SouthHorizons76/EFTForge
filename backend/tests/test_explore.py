"""Exercise sampled tradeoffs with small, real MILP models and no game download."""

import math
import os
from unittest.mock import patch

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

os.environ.setdefault("IP_HASH_SECRET", "explore-test-secret")
os.environ.setdefault("ADMIN_API_KEY", "explore-test-admin")

from database import Base  # noqa: E402
from models_items import Item  # noqa: E402
from models_item_offers import ItemOffer  # noqa: E402
from models_slots import Slot  # noqa: E402
from models_slot_allowed import SlotAllowedItem  # noqa: E402
from models_weapon_presets import WeaponDefaultPreset  # noqa: E402, F401
from optimizer.explore import explore_weapon, explore_weapon_stream, frontier_points  # noqa: E402
from optimizer.explore_request import ExploreRequest  # noqa: E402
from optimizer.solver import OptimizeParams  # noqa: E402
from stats import _compute_stats  # noqa: E402


@pytest.fixture
def db():
    # StaticPool + check_same_thread=False: the streaming-response test drains
    # build_explore's generator via Starlette's iterate_in_threadpool, which can
    # call next() from a different OS thread each time - the same cross-thread
    # access the real app's engine (database.py) already allows in production.
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
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


def test_empty_explore_explains_locked_and_banned_item(db):
    result = explore_weapon(db, "gun", OptimizeParams(include_items=["a"], exclude_items=["a"]), steps=10)
    assert result["status"] == "infeasible"
    assert result["reason_details"] == [{"key": "optimizer.reason.lockedItemBanned", "params": {"item": "a"}}]


def test_empty_explore_explains_locked_and_banned_category(db):
    db.get(Item, "a").category_ids = "stocks"
    db.commit()
    result = explore_weapon(db, "gun", OptimizeParams(include_items=["a"], exclude_categories=["stocks"]), steps=10)
    assert result["reason_details"][0]["key"] == "optimizer.reason.lockedCategoryBanned"


@pytest.mark.parametrize(
    "limits,reason",
    [
        ({"min_ergonomics": 60}, "min_ergonomics"),
        ({"max_price": 50}, "max_price"),
        ({"min_ergonomics": 45, "max_recoil_v": 60}, "min_ergonomics"),
        ({"min_ergonomics": 60, "max_recoil_v": 10}, "combinedStats"),
    ],
)
def test_empty_explore_diagnoses_stat_relaxations_without_returning_invalid_builds(db, limits, reason):
    params = OptimizeParams(**limits)
    result = explore_weapon(db, "gun", params, steps=10)
    assert result["status"] == "infeasible"
    assert result["points"] == []
    assert result["reason_key"] == f"optimizer.reason.relax.{reason}"
    assert result["diagnostic_solve_count"] > 0
    for name, value in limits.items():
        assert getattr(params, name) == value


def test_empty_explore_preserves_precheck_reason(db):
    result = explore_weapon(db, "gun", OptimizeParams(max_weight=1), steps=10)
    assert result["reason_details"][0]["key"] == "optimizer.reason.baseWeightExceedsLimit"


def test_diagnosis_does_not_treat_timeout_as_proof(db):
    from optimizer.explore import _diagnose_empty_explore

    with patch("optimizer.explore.time.perf_counter", return_value=0), patch(
        "optimizer.explore.optimize_weapon", return_value={"status": "timeout"}
    ) as solve:
        result = _diagnose_empty_explore(db, "gun", OptimizeParams(min_ergonomics=60), [], 30)
    assert result["reason_key"] == "optimizer.reason.constraintsConflict"
    assert solve.call_args.kwargs["deadline"] == 30
    with patch("optimizer.explore.time.perf_counter", return_value=30), patch(
        "optimizer.explore.optimize_weapon"
    ) as solve:
        _diagnose_empty_explore(db, "gun", OptimizeParams(min_ergonomics=60), [], 30)
    solve.assert_not_called()


def test_min_ergonomics_still_enforced_with_true_ergo_on(db):
    result = explore_weapon(db, "gun", OptimizeParams(min_ergonomics=35, use_true_ergo=True), "price", 10)
    assert result["points"]
    for point in result["points"]:
        assert point["build"]["final_stats"]["total_ergo"] >= 35


def test_max_ergonomics_caps_every_sample(db):
    result = explore_weapon(db, "gun", OptimizeParams(max_ergonomics=40), "price", 10)
    assert result["points"]
    for point in result["points"]:
        assert point["build"]["final_stats"]["total_ergo"] <= 40


def test_ergo_boundary_leeway_avoids_a_bad_recoil_cliff(db):
    # "d" sits just 1 ergo point below "c" (the raw ergo-max item) but has far
    # better recoil - a real Tarkov-shaped cliff (chunky, non-monotonic mod
    # stats), not a synthetic edge case. Without the leeway search, the
    # boundary point is a pure ergo-maximize that only ever sees "c" (ergo 20)
    # and never even considers "d" (ergo 19), landing the graph's edge on the
    # worse-recoil build purely because it's 1 point higher on ergo.
    db.add(Item(id="d", name="d", is_weapon=False, ergonomics_modifier=19, recoil_modifier=-0.9, weight=0.1))
    db.add(SlotAllowedItem(slot_id="slot", allowed_item_id="d"))
    db.add(
        ItemOffer(item_id="d", vendor_normalized="mechanic", trader_level=1, price=500, price_rub=500, currency="RUB")
    )
    db.commit()

    events = list(explore_weapon_stream(db, "gun", OptimizeParams(), "price", 10))
    high = next(e for e in events if e.get("phase") == "boundary_high")
    assert high["point"]["build"]["selected_items"] == ["d"]
    assert high["point"]["ergo"] == 49
    assert high["point"]["recoil_v"] == pytest.approx(10.0)

    # The discarded high-ergo/bad-recoil probe ("c" at ergo 50) must not leak
    # into the graph as its own point once a better nearby trade won instead.
    result = next(e for e in events if e["type"] == "result")["data"]
    assert ("c",) not in {tuple(p["build"]["selected_items"]) for p in result["points"]}


def test_true_ergo_toggle_changes_the_ergo_boundary_pick(db):
    # "c" wins on raw ergonomics (20, vs "b"'s 10) but its weight is heavy enough
    # to tank TrueErgo far below "b"'s - so the plain axis solve
    # (maximize raw ergo) and the TrueErgo solve (maximize TrueErgo) should disagree
    # on which build is the curve's high-ergo boundary point.
    db.get(Item, "c").weight = 5.0
    db.commit()

    plain_events = list(explore_weapon_stream(db, "gun", OptimizeParams(), "price", 10))
    plain_high = next(e for e in plain_events if e.get("phase") == "boundary_high")
    assert plain_high["point"]["build"]["selected_items"] == ["c"]

    te_events = list(explore_weapon_stream(db, "gun", OptimizeParams(use_true_ergo=True), "price", 10))
    te_high = next(e for e in te_events if e.get("phase") == "boundary_high")
    assert te_high["point"]["build"]["selected_items"] == ["b"]

    # The low boundary never involves ergo at all (it's a pure min-recoil solve,
    # no floor), so it's untouched either way - only the ergo-axis boundary and
    # (see the sweep test below) the interior points change.
    plain_low = next(e for e in plain_events if e.get("phase") == "boundary_low")
    te_low = next(e for e in te_events if e.get("phase") == "boundary_low")
    assert plain_low["point"]["build"]["selected_items"] == te_low["point"]["build"]["selected_items"]


def test_true_ergo_toggle_keeps_the_heavy_item_out_of_every_interior_point(db):
    # Same heavy "c" as above. Under the plain raw-ergo floor, "c" is still the
    # only item with enough raw ergo to clear the sweep's upper bounds, so it
    # wins several interior/"balanced" points too, not just the boundary - the
    # exact problem this whole feature exists to fix. Under the TrueErgo floor,
    # "b" alone clears every one of those same bounds (its TrueErgo covers the
    # entire low-to-high TrueErgo span on its own), so "c" - genuinely worse on
    # weight-adjusted ergonomics than "b" despite its higher raw number - should
    # never win a single point, boundary or interior.
    db.get(Item, "c").weight = 5.0
    db.commit()

    plain = explore_weapon(db, "gun", OptimizeParams(), "price", 10)
    plain_picks = {tuple(p["build"]["selected_items"]) for p in plain["points"]}
    assert ("c",) in plain_picks

    te = explore_weapon(db, "gun", OptimizeParams(use_true_ergo=True), "price", 10)
    te_picks = {tuple(p["build"]["selected_items"]) for p in te["points"]}
    assert ("c",) not in te_picks
    assert ("b",) in te_picks


def test_true_ergo_toggle_has_no_effect_on_the_ergo_tradeoff(db):
    # tradeoff="ergo" never solves a dedicated "max ergo" boundary point (it
    # sweeps recoil while minimizing price instead), so there's nothing for
    # use_true_ergo to change here - it should just run the same as it always does.
    db.get(Item, "c").weight = 5.0
    db.commit()
    plain = explore_weapon(db, "gun", OptimizeParams(), "ergo", 10)
    te = explore_weapon(db, "gun", OptimizeParams(use_true_ergo=True), "ergo", 10)
    assert [p["build"]["selected_items"] for p in plain["points"]] == [
        p["build"]["selected_items"] for p in te["points"]
    ]


def test_explore_request_accepts_use_true_ergo():
    req = ExploreRequest(weapon_id="gun", use_true_ergo=True)
    assert req.optimize_params().use_true_ergo is True


def test_recoil_price_sweep_finds_intermediate_build(db):
    for iid, price in [("a", 400), ("b", 200), ("c", 100)]:
        offer = db.query(ItemOffer).filter(ItemOffer.item_id == iid).one()
        offer.price = offer.price_rub = price
    db.commit()
    result = explore_weapon(db, "gun", OptimizeParams(), "ergo", 10)
    assert [p["build"]["selected_items"] for p in result["points"]] == [["a"], ["b"], ["c"]]


def test_api_holds_shared_solver_slot_for_entire_curve(db, monkeypatch):
    import asyncio
    import json
    from contextlib import contextmanager
    from starlette.requests import Request
    import main
    from optimizer.explore import explore_weapon_stream

    events = []

    @contextmanager
    def slot(ip):
        events.append("acquire")
        yield
        events.append("release")

    def solve(*args):
        assert events == ["rate", "acquire"]
        events.append("solve")
        yield from explore_weapon_stream(db, *args)

    monkeypatch.setattr(main, "_check_solve_rate_limit", lambda ip: events.append("rate"))
    monkeypatch.setattr(main, "_solve_slot", slot)
    monkeypatch.setattr(main, "stream_explore", solve)
    request = Request({"type": "http", "headers": [], "client": ("203.0.113.80", 1234)})
    response = main.build_explore(request, ExploreRequest(weapon_id="gun", steps=10, max_price=200), db)

    async def _drain():
        return [chunk async for chunk in response.body_iterator]

    chunks = asyncio.run(_drain())
    events_lines = [json.loads(chunk.removeprefix("data: ")) for chunk in chunks]
    result = events_lines[-1]["data"]
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


@pytest.mark.parametrize("spec_version", ["2.3", "2.4"])
@pytest.mark.parametrize("disconnect_after_progress", [False, True])
def test_api_disconnect_releases_slot_and_allows_next_solve(
    db, monkeypatch, tmp_path, spec_version, disconnect_after_progress
):
    import asyncio
    import json
    import threading

    import main
    from optimizer.cancellation import check_cancelled

    started = threading.Event()
    progress_sent = threading.Event()
    stopped = threading.Event()
    ip = "203.0.113.81"
    monkeypatch.setattr(main, "_SOLVE_LOCK_DIR", str(tmp_path))
    monkeypatch.setattr(main, "_SOLVE_CONCURRENCY_SEM", threading.BoundedSemaphore(1))
    monkeypatch.setattr(main, "_check_solve_rate_limit", lambda ip: None)

    def solve(*args):
        started.set()
        try:
            if disconnect_after_progress:
                yield {"type": "progress", "done": 1}
            while True:
                check_cancelled()
                stopped.wait(0.01)
        finally:
            stopped.set()

    monkeypatch.setattr(main, "stream_explore", solve)
    main.app.dependency_overrides[main.get_db] = lambda: db

    async def run(disconnect):
        body_sent = False
        sent = []

        async def receive():
            nonlocal body_sent
            if not body_sent:
                body_sent = True
                return {"type": "http.request", "body": json.dumps({"weapon_id": "gun", "steps": 10}).encode()}
            if not disconnect:
                await asyncio.Event().wait()
            while not started.is_set() or (disconnect_after_progress and not progress_sent.is_set()):
                await asyncio.sleep(0.01)
            return {"type": "http.disconnect"}

        async def send(message):
            sent.append(message)
            if message["type"] == "http.response.body" and b"progress" in message.get("body", b""):
                progress_sent.set()

        await asyncio.wait_for(
            main.app(
                {
                    "type": "http",
                    "method": "POST",
                    "path": "/build/explore",
                    "query_string": b"",
                    "headers": [(b"content-type", b"application/json")],
                    "client": (ip, 1234),
                    "scheme": "http",
                    "server": ("localhost", 8000),
                    "http_version": "1.1",
                    "asgi": {"spec_version": spec_version},
                },
                receive,
                send,
            ),
            timeout=5,
        )
        return sent

    try:
        asyncio.run(run(True))
        assert stopped.is_set()
        assert not list(tmp_path.iterdir())

        def completed(*args):
            yield {"type": "result", "data": {"points": [], "complete": True}}

        monkeypatch.setattr(main, "stream_explore", completed)
        sent = asyncio.run(run(False))
        assert sent[0]["status"] == 200
        assert b'"complete": true' in b"".join(message.get("body", b"") for message in sent)
        assert not list(tmp_path.iterdir())
        assert main._SOLVE_CONCURRENCY_SEM.acquire(blocking=False)
        main._SOLVE_CONCURRENCY_SEM.release()
    finally:
        main.app.dependency_overrides.pop(main.get_db, None)


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


def test_use_true_ergo_ranks_the_frontier_by_true_ergo_not_raw_ergo():
    # "heavy" wins on raw ergo but loses badly on TrueErgo once weight is
    # accounted for; "light" is the reverse. Each should win the frontier under
    # the metric that actually favors it.
    heavy = {"ergo": 60, "true_ergo_delta": -0.5, "recoil_v": 50, "price": 100}
    light = {"ergo": 40, "true_ergo_delta": 1.5, "recoil_v": 50, "price": 100}
    plain = frontier_points([heavy, light], "price", use_true_ergo=False)
    assert plain == [heavy]

    te = frontier_points([heavy, light], "price", use_true_ergo=True)
    assert te == [light]


@pytest.mark.parametrize(
    "field,value",
    [
        ("steps", 9),
        ("steps", 82),
        ("tradeoff", "bad"),
        ("max_price", math.nan),
        ("max_recoil_v", math.inf),
        ("max_ergonomics", -1),
        ("max_weight", -1),
        ("strength_level", 52),
    ],
)
def test_request_rejects_invalid_parameters(field, value):
    with pytest.raises(ValidationError):
        ExploreRequest(weapon_id="gun", **{field: value})
