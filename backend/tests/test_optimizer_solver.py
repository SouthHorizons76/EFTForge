"""Tests for the MVP weapon build optimizer (optimizer/solver.py).

These run against the real, already-synced dev DB (backend/tarkov.db) rather
than a fixture DB - the solver's correctness depends on real slot/conflict/
offer data that isn't worth hand-modeling in a fixture, and every other build
feature in this repo (Combo Calculator, etc.) is only ever exercised against
real synced data too. Skipped automatically if that DB hasn't been synced yet
- CI never syncs one, and (deliberately) never sets IP_HASH_SECRET/
ADMIN_API_KEY either, so `database`/`config` must not be imported at module
level: config.py raises at import time when those are missing, which would
crash collection before pytest ever gets to evaluate the skip marker below.

Run with:  cd backend && python -m pytest tests/test_optimizer_solver.py
"""

import os

import pytest

M4A1_ID = "5447a9cd4bdc2dbd208b4567"
AK74N_ID = "5644bd2b4bdc2d3b4c8b4572"
SVDS_ID = "5c46fbd72e2216398b5a8c9c"

_HAS_DB = os.path.exists(os.path.join(os.path.dirname(__file__), "..", "tarkov.db"))

pytestmark = pytest.mark.skipif(
    not _HAS_DB,
    reason="requires a synced tarkov.db - run sync_tarkov_dev.py first",
)

if _HAS_DB:
    from database import SessionLocal
    from stats import _compute_stats, apply_full_mag_ammo
    from optimizer.solver import optimize_weapon, OptimizeParams


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


class TestUnconstrainedOptimize:
    def test_m4a1_solves_optimal(self, db):
        result = optimize_weapon(db, M4A1_ID, OptimizeParams())
        assert result["status"] == "optimal"
        assert isinstance(result["selected_items"], list)
        assert isinstance(result["slot_pairs"], list)
        assert result["metrics"]["reachable_candidate_count"] >= result["metrics"]["market_candidate_count"]
        assert result["metrics"]["variable_count"] == result["metrics"]["pruned_candidate_count"]
        assert result["metrics"]["pruned_candidate_count"] <= result["metrics"]["market_candidate_count"]
        assert result["metrics"]["constraint_count"] > 0
        assert result["metrics"]["solver_ms"] >= 0
        # every slot pair is a well-formed [slot_id, item_id] pair referencing a selected item
        selected_set = set(result["selected_items"])
        for pair in result["slot_pairs"]:
            assert len(pair) == 2
            assert pair[1] in selected_set

    def test_ak74n_solves_optimal(self, db):
        result = optimize_weapon(db, AK74N_ID, OptimizeParams())
        assert result["status"] == "optimal"

    def test_final_stats_match_compute_stats_directly(self, db):
        """The solver must report exactly what stats._compute_stats() (plus the shared
        assume_full_mag post-processing, since no ammo was selected here) would say for
        the same attachment set - no second, divergent stat formula."""
        result = optimize_weapon(db, M4A1_ID, OptimizeParams())
        assert result["status"] == "optimal"

        from models_items import Item

        weapon = db.query(Item).filter(Item.id == M4A1_ID).first()
        mods = {m.id: m for m in db.query(Item).filter(Item.id.in_(result["selected_items"])).all()}
        expected = _compute_stats(weapon, result["selected_items"], mods)
        apply_full_mag_ammo(expected, mods, ammo=None, ubgl_grenade=None, strength_level=10, equip_ergo_modifier=0.0)
        assert result["final_stats"] == expected


class TestAssumeFullMagAmmo:
    """Part 2 of GitHub #37's follow-up: the optimizer's post-solve final_stats/
    evo_contributions must fold in the magazine's loaded ammo weight the same way
    /build/calculate does for a manually-built weapon, gated on assume_full_mag -
    same toggle, same stats.apply_full_mag_ammo() call, applied to whichever
    magazine the solve actually picked."""

    AMMO_ID = "54527a984bdc2d4e668b4567"  # 5.56x45mm M855, 0.012kg

    def test_ammo_adds_magazine_capacity_weight_to_final_stats(self, db):
        bare = optimize_weapon(db, M4A1_ID, OptimizeParams(min_mag_capacity=60))
        loaded = optimize_weapon(db, M4A1_ID, OptimizeParams(min_mag_capacity=60, selected_ammo_id=self.AMMO_ID))
        assert bare["status"] == loaded["status"] == "optimal"
        assert loaded["selected_items"] == bare["selected_items"]  # ammo doesn't change which parts are chosen

        from models_items import Item

        mag = next(m for m in db.query(Item).filter(Item.id.in_(loaded["selected_items"])).all() if m.magazine_capacity)
        ammo = db.query(Item).filter(Item.id == self.AMMO_ID).first()
        expected_added_weight = round((ammo.weight or 0) * mag.magazine_capacity, 3)

        assert loaded["final_stats"]["total_weight"] == round(
            bare["final_stats"]["total_weight"] + expected_added_weight, 3
        )
        assert bare["final_stats"]["muzzle_velocity"] is None
        assert loaded["final_stats"]["muzzle_velocity"] is not None

        assert bare["ammo_fill"] is None
        assert loaded["ammo_fill"] == {
            "item_id": self.AMMO_ID,
            "capacity": mag.magazine_capacity,
            "price": loaded["ammo_fill"]["price"],
        }

    def test_assume_full_mag_off_ignores_selected_ammo(self, db):
        result = optimize_weapon(
            db, M4A1_ID, OptimizeParams(min_mag_capacity=60, selected_ammo_id=self.AMMO_ID, assume_full_mag=False)
        )
        assert result["status"] == "optimal"
        assert result["final_stats"]["muzzle_velocity"] is None
        assert result["ammo_fill"] is None

    def test_evo_contributions_of_non_magazine_parts_are_unaffected_by_ammo(self, db):
        """The ammo-weight delta must not leak into every other part's marginal
        EvoErgo contribution - only the magazine's own contribution should change
        when ammo is toggled on, since removing any other part still leaves the
        magazine (and its assumed ammo) in the 'without' subset."""
        bare = optimize_weapon(db, M4A1_ID, OptimizeParams(min_mag_capacity=60))
        loaded = optimize_weapon(db, M4A1_ID, OptimizeParams(min_mag_capacity=60, selected_ammo_id=self.AMMO_ID))
        assert bare["status"] == loaded["status"] == "optimal"

        from models_items import Item

        mag_id = next(
            m.id for m in db.query(Item).filter(Item.id.in_(loaded["selected_items"])).all() if m.magazine_capacity
        )
        for item_id in loaded["selected_items"]:
            if item_id == mag_id:
                continue
            assert loaded["evo_contributions"][item_id] == pytest.approx(bare["evo_contributions"][item_id], abs=1e-6)


class TestEvoErgoMode:
    def test_solves_optimal(self, db):
        result = optimize_weapon(db, M4A1_ID, OptimizeParams(use_evo_ergo=True))
        assert result["status"] == "optimal"
        assert "evo_ergo_delta" in result["final_stats"]

    def test_beats_or_matches_plain_weighted_objective_on_eed(self, db):
        """EvoErgo mode explicitly searches for the best ergo/weight tradeoff
        (true EED), so it should never do worse on that specific metric than
        the plain weighted objective, which doesn't optimize for it at all."""
        plain = optimize_weapon(db, M4A1_ID, OptimizeParams())
        evo = optimize_weapon(db, M4A1_ID, OptimizeParams(use_evo_ergo=True))
        assert plain["status"] == "optimal"
        assert evo["status"] == "optimal"
        assert evo["final_stats"]["evo_ergo_delta"] >= plain["final_stats"]["evo_ergo_delta"]

    def test_explicit_k_override_matches_manual_stats_call(self, db):
        """A pinned evo_ergo_k should skip the sweep and solve once - just
        confirms the override path runs and still reports real, consistent stats."""
        result = optimize_weapon(db, M4A1_ID, OptimizeParams(use_evo_ergo=True, evo_ergo_k=0.15))
        assert result["status"] == "optimal"

        from models_items import Item

        weapon = db.query(Item).filter(Item.id == M4A1_ID).first()
        mods = {m.id: m for m in db.query(Item).filter(Item.id.in_(result["selected_items"])).all()}
        expected = _compute_stats(weapon, result["selected_items"], mods)
        apply_full_mag_ammo(expected, mods, ammo=None, ubgl_grenade=None, strength_level=10, equip_ergo_modifier=0.0)
        assert result["final_stats"] == expected

    def test_finds_the_dominant_magazine_from_issue_37(self, db):
        """Regression test for GitHub #37: at a 60-round capacity floor, the
        old fixed 6-anchor grid settled on Magpul PMAG D-60 even though
        SureFire MAG5-60 is lighter for the same capacity and gives a
        strictly better true EED once actually tried - the true optimum sat
        between two anchors the static grid never solved at. The per-anchor
        refinement (re-anchoring at each candidate's own achieved ergo)
        should now reach it."""
        MAG5_60_ID = "544a37c44bdc2d25388b4567"
        PMAG_D60_ID = "59c1383d86f774290a37e0ca"
        result = optimize_weapon(db, M4A1_ID, OptimizeParams(use_evo_ergo=True, min_mag_capacity=60))
        assert result["status"] == "optimal"
        assert MAG5_60_ID in result["selected_items"]
        assert PMAG_D60_ID not in result["selected_items"]

    def test_eed_does_not_worsen_as_ergo_weight_increases(self, db):
        """Regression test for GitHub #37: sweeping the weight slider further
        toward ergo used to sometimes pick a *worse* true EED than a lower
        ergo weight (the old selection picked whichever of 6 candidates had
        the highest raw EED, ignoring how each candidate scored on the
        recoil/price weights actually used to solve it). With the true
        blended score deciding the winner, more ergo weight should never
        make the reported EED worse."""
        prev_eed = None
        for ergo_w in (0.001, 0.14, 0.34, 0.66, 1.0):
            result = optimize_weapon(
                db,
                M4A1_ID,
                OptimizeParams(
                    use_evo_ergo=True,
                    min_mag_capacity=60,
                    ergo_weight=ergo_w,
                    recoil_weight=max(1 - ergo_w, 0.001),
                    price_weight=0.0,
                ),
            )
            assert result["status"] == "optimal"
            eed = result["final_stats"]["evo_ergo_delta"]
            if prev_eed is not None:
                assert eed >= prev_eed - 1e-6
            prev_eed = eed

    def test_eed_does_not_worsen_with_prevent_overswing_and_suppressor(self, db):
        """Regression test for GitHub #37: with prevent_overswing + a forced
        suppressor, a 7% ergo weight used to score *worse* on EED than a
        ~0% ergo weight (1.92 vs 0.26). The candidates were both real
        sweep results and the selection did pick the better-scoring one -
        but price_weight=0.0 was silently floored to TIEBREAK for that
        comparison, so a ~41,000 RUB price gap between the two candidates
        outvoted the EED difference the caller actually asked to weight.
        The true score must honor a literal 0% weight instead of flooring it."""
        prev_eed = None
        for ergo_w in (0.0001, 0.07, 0.42, 0.46, 1.0):
            result = optimize_weapon(
                db,
                M4A1_ID,
                OptimizeParams(
                    use_evo_ergo=True,
                    prevent_overswing=True,
                    require_suppressor=True,
                    ergo_weight=ergo_w,
                    recoil_weight=max(1 - ergo_w, 0.0001),
                    price_weight=0.0,
                ),
            )
            assert result["status"] == "optimal"
            eed = result["final_stats"]["evo_ergo_delta"]
            if prev_eed is not None:
                assert eed >= prev_eed - 1e-6
            prev_eed = eed

    def test_reports_optimal_when_every_attempt_actually_was(self, db):
        """Regression test: the per-anchor refinement dedupes an anchor whose
        chain lands exactly on a k some other anchor already tried (see
        MAX_EVO_ERGO_REFINE_ITERS's tried_k set) - that's a redundant solve
        correctly skipped, not a sign the sweep ran out of time. The result
        used to get mislabeled "feasible (time limit reached)" purely
        because that anchor's own solve never ran, even though every solve
        that *did* run reported a true optimum and the 30s budget was barely
        touched."""
        result = optimize_weapon(
            db,
            M4A1_ID,
            OptimizeParams(
                use_evo_ergo=True,
                prevent_overswing=True,
                require_suppressor=True,
                ergo_weight=0.54,
                recoil_weight=0.46,
                price_weight=0.0,
            ),
        )
        assert result["status"] == "optimal"
        assert result["reason"] is None

    def test_literal_zero_weight_does_not_cliff_against_the_next_ui_tick(self, db):
        """Regression test: a literal 0% weight zeroed that axis out of the
        selection score entirely (only the discrete anchor-refined candidates
        that survive TIEBREAK-floored generation are ever compared, and with
        zero weight none of them could distinguish themselves on ergo at
        all), so the solver picked among otherwise-close candidates with zero
        regard for it - a real jump between 0% and the smallest tick the UI
        can actually send (1%, since the frontend only ever sends whole
        percentages). Confirmed on plain main before this fix: ergo_weight=0
        gave ergo 29, 0.01 gave ergo 41 - a 12-point gap.

        WEIGHT_FLOOR shrinks this a lot (to ~5 points here) but can't close
        it entirely: going any higher risks reintroducing the TIEBREAK price-
        override bug this same score already had to be fixed for once (see
        test_eed_does_not_worsen_with_prevent_overswing_and_suppressor) - that
        fix is the higher priority since it was an actual reported bug, not a
        rough edge at one corner of the triangle."""
        zero = optimize_weapon(db, M4A1_ID, OptimizeParams(use_evo_ergo=True, ergo_weight=0.0, recoil_weight=1.0))
        one_pct = optimize_weapon(db, M4A1_ID, OptimizeParams(use_evo_ergo=True, ergo_weight=0.01, recoil_weight=0.99))
        assert zero["status"] == one_pct["status"] == "optimal"
        ergo_gap = abs(zero["final_stats"]["total_ergo"] - one_pct["final_stats"]["total_ergo"])
        assert ergo_gap <= 6.0


class TestSlotPairOrdering:
    def test_pairs_are_parent_before_child(self, db):
        """frontend/modules/build-manager.js's loadBuildFromPayload installs
        slot_pairs with a single BFS pass and looks up each pair's parent by
        slot id - a child arriving before its parent gets silently dropped.
        This pins the ordering guarantee _order_pairs_parent_first provides."""
        from optimizer.compat_map import build_compatibility_map

        result = optimize_weapon(db, M4A1_ID, OptimizeParams())
        assert result["status"] == "optimal"
        assert result["slot_pairs"], "expected at least one attachment for this to be a meaningful check"

        compat_map = build_compatibility_map(db, M4A1_ID)
        seen_items = set()
        for slot_id, item_id in result["slot_pairs"]:
            owner = compat_map.slot_owner.get(slot_id)
            if owner != M4A1_ID:
                assert owner in seen_items, f"slot {slot_id}'s owner {owner} appears after its child {item_id}"
            seen_items.add(item_id)


class TestBudgetConstraint:
    def test_lower_budget_never_exceeds_it(self, db):
        unconstrained = optimize_weapon(db, M4A1_ID, OptimizeParams())
        assert unconstrained["status"] == "optimal"
        half_budget = unconstrained["total_price_rub"] // 2

        constrained = optimize_weapon(db, M4A1_ID, OptimizeParams(max_price=half_budget))
        assert constrained["status"] == "optimal"
        assert constrained["total_price_rub"] <= half_budget
        # a tighter budget can never do better than the unconstrained optimum
        assert constrained["total_price_rub"] <= unconstrained["total_price_rub"]


class TestInfeasibleConstraints:
    def test_impossible_min_ergonomics_is_infeasible(self, db):
        result = optimize_weapon(db, M4A1_ID, OptimizeParams(min_ergonomics=100_000))
        assert result["status"] == "infeasible"
        assert result["reason"]

    def test_impossible_mag_capacity_is_infeasible(self, db):
        result = optimize_weapon(db, M4A1_ID, OptimizeParams(min_mag_capacity=100_000))
        assert result["status"] == "infeasible"


class TestPreventOverswing:
    def test_never_returns_an_overswinging_build(self, db):
        for weapon_id in (M4A1_ID, AK74N_ID, SVDS_ID):
            result = optimize_weapon(db, weapon_id, OptimizeParams(prevent_overswing=True))
            assert result["status"] == "optimal"
            assert result["final_stats"]["overswing"] is False

    def test_svds_suppressed_is_satisfiable(self, db):
        """Regression test: a non-overswinging suppressed SVDS build exists,
        but the old fixed 5-anchor tangent-cut grid ANDed a cut anchored near
        the bottom of the weapon's whole reachable ergo range - extrapolated
        out to where real builds land, that single cut alone rejected every
        one of them, always reporting infeasible."""
        result = optimize_weapon(
            db,
            SVDS_ID,
            OptimizeParams(
                require_suppressor=True, prevent_overswing=True, ergo_weight=1.0, recoil_weight=0.01, price_weight=0.01
            ),
        )
        assert result["status"] == "optimal"
        assert result["final_stats"]["overswing"] is False

    def test_matches_unconstrained_when_already_non_overswinging(self, db):
        """If the ordinary optimum already doesn't overswing, adding the
        constraint should change nothing about that result."""
        baseline = optimize_weapon(db, M4A1_ID, OptimizeParams())
        assert baseline["status"] == "optimal"
        assert baseline["final_stats"]["overswing"] is False

        constrained = optimize_weapon(db, M4A1_ID, OptimizeParams(prevent_overswing=True))
        assert constrained["status"] == "optimal"
        assert constrained["selected_items"] == baseline["selected_items"]


class TestIncludeExcludeItems:
    def test_include_items_forces_selection(self, db):
        baseline = optimize_weapon(db, M4A1_ID, OptimizeParams())
        assert baseline["status"] == "optimal"
        assert baseline["selected_items"], "expected M4A1's unconstrained optimum to include at least one mod"
        forced_item = baseline["selected_items"][0]

        result = optimize_weapon(db, M4A1_ID, OptimizeParams(include_items=[forced_item]))
        assert result["status"] == "optimal"
        assert forced_item in result["selected_items"]

    def test_exclude_items_removes_it_from_candidates(self, db):
        baseline = optimize_weapon(db, M4A1_ID, OptimizeParams())
        assert baseline["status"] == "optimal"
        assert baseline["selected_items"]
        excluded_item = baseline["selected_items"][0]

        result = optimize_weapon(db, M4A1_ID, OptimizeParams(exclude_items=[excluded_item]))
        assert result["status"] == "optimal"
        assert excluded_item not in result["selected_items"]


class TestTchebycheffMode:
    def test_on_by_default(self, db):
        result = optimize_weapon(db, M4A1_ID, OptimizeParams())
        assert result["status"] == "optimal"

    def test_opt_out_still_works(self, db):
        """use_tchebycheff=False must keep giving the plain weighted-sum
        behavior other tests/callers may still rely on."""
        result = optimize_weapon(db, M4A1_ID, OptimizeParams(use_tchebycheff=False))
        assert result["status"] == "optimal"

    def test_50_50_lands_meaningfully_between_the_extremes(self, db):
        """The whole point of Tchebycheff over weighted-sum: weighted-sum's
        fixed per-unit exchange rate made a 50/50 split behave almost
        identically to 100% recoil (ergo barely moved off its recoil-only
        floor - see the GitHub #37/Discord thread this was built to fix).
        Tchebycheff normalizes each axis against what's actually achievable,
        so 50/50 should land well above the pure-recoil ergo floor - most of
        the way to the pure-ergo ceiling, not stuck near the bottom."""
        pure_recoil = optimize_weapon(
            db, M4A1_ID, OptimizeParams(ergo_weight=0.0001, recoil_weight=1.0, price_weight=0.0)
        )
        pure_ergo = optimize_weapon(
            db, M4A1_ID, OptimizeParams(ergo_weight=1.0, recoil_weight=0.0001, price_weight=0.0)
        )
        balanced = optimize_weapon(db, M4A1_ID, OptimizeParams(ergo_weight=0.5, recoil_weight=0.5, price_weight=0.0))
        assert pure_recoil["status"] == pure_ergo["status"] == balanced["status"] == "optimal"

        ergo_floor = pure_recoil["final_stats"]["total_ergo"]
        ergo_ceiling = pure_ergo["final_stats"]["total_ergo"]
        ergo_balanced = balanced["final_stats"]["total_ergo"]
        # how far balanced climbed from the recoil-only floor toward the
        # ergo-only ceiling, as a fraction - old weighted-sum measured well
        # under 10% here; Tchebycheff should clear well over half.
        progress = (ergo_balanced - ergo_floor) / (ergo_ceiling - ergo_floor)
        assert progress > 0.5

    def test_prevent_overswing_stays_satisfiable(self, db):
        """Regression test: computing the three Tchebycheff ideal points each
        via prevent_overswing's own adaptive cut search used to share (and
        mutate) the same constraint builder across all three axes plus the
        final solve - cuts anchored while chasing one axis's extreme aren't
        necessarily relevant to another, and accumulating them all
        recreated the exact "several ANDed tangent cuts jointly exclude
        every non-overswinging build" failure prevent_overswing's adaptive
        design exists to avoid (see TestPreventOverswing's SVDS test). Each
        axis must search with its own isolated cut set."""
        result = optimize_weapon(
            db,
            SVDS_ID,
            OptimizeParams(
                require_suppressor=True, prevent_overswing=True, ergo_weight=1.0, recoil_weight=0.01, price_weight=0.01
            ),
        )
        assert result["status"] == "optimal"
        assert result["final_stats"]["overswing"] is False

    def test_extreme_single_axis_weights_still_solve(self, db):
        for kwargs in (
            {"ergo_weight": 1.0, "recoil_weight": 0.0, "price_weight": 0.0},
            {"ergo_weight": 0.0, "recoil_weight": 1.0, "price_weight": 0.0},
            {"ergo_weight": 0.0, "recoil_weight": 0.0, "price_weight": 1.0},
        ):
            result = optimize_weapon(db, M4A1_ID, OptimizeParams(**kwargs))
            assert result["status"] == "optimal"

    def test_literal_zero_weight_does_not_cliff_against_the_next_ui_tick(self, db):
        """Regression test: a literal 0% weight zeroed that axis out of both
        the z-constraint and the tie-break augmentation term entirely, so
        capped_ergo (or recoil/price) was a free variable with zero pressure
        on it - an arbitrary tie-break that could land far from what even a
        1% weight (the smallest tick the UI can actually send) would pick.
        Confirmed identical on plain main before this fix: ergo_weight=0 gave
        ergo 39, but 0.01 gave ergo 39.5 only after passing through a much
        larger jump at smaller test increments. WEIGHT_FLOOR keeps every
        axis in play for tie-breaking even at a literal 0% weight."""
        zero = optimize_weapon(db, M4A1_ID, OptimizeParams(ergo_weight=0.0, recoil_weight=1.0, price_weight=0.0))
        one_pct = optimize_weapon(db, M4A1_ID, OptimizeParams(ergo_weight=0.01, recoil_weight=0.99, price_weight=0.0))
        assert zero["status"] == one_pct["status"] == "optimal"
        ergo_gap = abs(zero["final_stats"]["total_ergo"] - one_pct["final_stats"]["total_ergo"])
        assert ergo_gap <= 1.0
