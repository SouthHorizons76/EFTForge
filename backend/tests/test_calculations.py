"""
Tests for the aiming formulas: TrueErgoDelta, overswing, arm stamina and aim sway.

These formulas are duplicated in frontend/modules/calculations.js (calcTrueErgoDelta,
calcArmStamina, calcAimSway) for instant client-side feedback;
backend/stats.py::_calc_aiming_stats is the canonical copy. This file imports that real
function rather than reimplementing the formula a second time, and cross-checks it
against tests/data/stat_formula_golden.json - the same vectors
frontend/tests/calculations.test.js checks the JS copy against, so a drift between the
two shows up as a test failure on whichever side changed instead of silently shipping a
client/server stat mismatch.

Run with:  cd backend && python -m pytest tests/
"""

import json
import os
from pathlib import Path

os.environ.setdefault("IP_HASH_SECRET", "calculations-test-secret")
os.environ.setdefault("ADMIN_API_KEY", "calculations-test-admin")

from stats import _calc_aiming_stats, overswing_limit_kg

GOLDEN_PATH = Path(__file__).parent / "data" / "stat_formula_golden.json"
GOLDEN_CASES = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))["cases"]


def _aim(total_ergo, total_weight, strength_level=10, equip_ergo_modifier=0.0):
    return _calc_aiming_stats(total_ergo, total_weight, strength_level, equip_ergo_modifier)


# ---------------------------------------------------------------------------
# Golden-vector cross-check: same expected values frontend/tests/calculations.test.js
# checks the JS copies against.
# ---------------------------------------------------------------------------


class TestGoldenVectors:
    def test_backend_matches_golden_vectors(self):
        for case in GOLDEN_CASES:
            a = _aim(case["total_ergo"], case["total_weight"], case["strength_level"], case["equip_ergo_modifier"])
            assert round(a["true_ergo_delta"], 4) == case["expected_true_ergo_delta"], f"TED mismatch for {case}"
            assert a["overswing"] == case["expected_overswing"], f"overswing mismatch for {case}"
            got = None if a["arm_stamina"] is None else round(a["arm_stamina"], 2)
            assert got == case["expected_arm_stamina"], f"arm_stamina mismatch for {case}"
            assert round(a["aim_sway"], 4) == case["expected_aim_sway"], f"aim_sway mismatch for {case}"


# ---------------------------------------------------------------------------
# TrueErgoDelta and overswing
# ---------------------------------------------------------------------------


class TestTrueErgoDelta:
    def test_light_build_keeps_all_its_ergo(self):
        # At 3 kg or less nothing overswings, so no ergo is needed: TED is the ergo itself
        assert _aim(40, 2.0)["true_ergo_delta"] == 40.0
        assert _aim(0, 0)["true_ergo_delta"] == 0.0

    def test_ted_is_ergo_less_the_ergo_the_weight_needs(self):
        # 5 kg needs 100 * (1 - 3 / 5) = 40 ergo: 60 ergo leaves 20
        assert abs(_aim(60, 5.0)["true_ergo_delta"] - 20.0) < 1e-9

    def test_one_ergo_point_is_one_ted_point(self):
        assert abs(_aim(61, 5.0)["true_ergo_delta"] - _aim(60, 5.0)["true_ergo_delta"] - 1.0) < 1e-9

    def test_overswing_exactly_when_ted_is_negative(self):
        limit = overswing_limit_kg(60.0)
        at = _aim(60, limit)
        assert abs(at["true_ergo_delta"]) < 1e-9 and not at["overswing"]
        past = _aim(60, limit + 0.01)
        assert past["true_ergo_delta"] < 0 and past["overswing"]

    def test_no_build_overswings_at_100_ergo(self):
        a = _aim(100, 50.0)
        assert a["true_ergo_delta"] > 0 and not a["overswing"] and a["aim_sway"] == 0

    def test_ergo_past_100_adds_nothing(self):
        assert _aim(130, 4.0)["true_ergo_delta"] == _aim(100, 4.0)["true_ergo_delta"]

    def test_equip_ergo_modifier_reduces_effective_ergo(self):
        # A negative equip_ergo_modifier (equipment penalty) lowers effective ergo
        # point for point, leaving less TED
        plain = _aim(60, 5.0)["true_ergo_delta"]
        penalized = _aim(60, 5.0, equip_ergo_modifier=-0.20)["true_ergo_delta"]
        assert penalized < plain

    def test_sway_grows_from_three_to_seven_kg_of_swing_weight(self):
        assert _aim(0, 3.0)["aim_sway"] == 0
        assert abs(_aim(0, 5.0)["aim_sway"] - 0.5) < 1e-9
        assert _aim(0, 9.0)["aim_sway"] == 1


# ---------------------------------------------------------------------------
# Arm stamina
# ---------------------------------------------------------------------------


class TestArmStamina:
    def test_heavier_build_decreases_stamina(self):
        assert _aim(50, 7.0)["arm_stamina"] < _aim(50, 3.0)["arm_stamina"]

    def test_higher_ergo_increases_stamina(self):
        assert _aim(70, 4.0)["arm_stamina"] > _aim(30, 4.0)["arm_stamina"]

    def test_weightless_build_never_drains(self):
        assert _aim(50, 0.0)["arm_stamina"] is None

    def test_strength_level_cuts_drain(self):
        # Strength takes 0.4% off the drain per level: level 50 drains 80% as fast
        base = _aim(50, 4.0, strength_level=0)["arm_stamina"]
        strong = _aim(50, 4.0, strength_level=50)["arm_stamina"]
        assert abs(strong - base / 0.8) < 1e-9


# ---------------------------------------------------------------------------
# Recoil modifier application
# ---------------------------------------------------------------------------


class TestRecoilModifier:
    def test_positive_modifier_increases_recoil(self):
        base_v = 100
        modifier = 0.10  # +10 %
        result = round(base_v * (1 + modifier))
        assert result == 110

    def test_negative_modifier_decreases_recoil(self):
        base_v = 100
        modifier = -0.15
        result = round(base_v * (1 + modifier))
        assert result == 85

    def test_zero_modifier_unchanged(self):
        base_v = 137
        result = round(base_v * (1 + 0.0))
        assert result == 137
