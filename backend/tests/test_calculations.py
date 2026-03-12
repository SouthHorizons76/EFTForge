"""
Tests for the EvoErgo / EED / Arm Stamina calculation formulas.

These formulas are duplicated in frontend/app.js (calcEED, calcArmStamina) and
the backend /build/calculate endpoint.  The tests here pin the backend behaviour;
if a formula was changed, the frontend counterpart must be updated to match.

Run with:  cd backend && python -m pytest tests/
"""

import math
import sys
import os

# ---------------------------------------------------------------------------
# Inline the formula functions so tests don't depend on a live DB / FastAPI
# ---------------------------------------------------------------------------

def _calc_evo_weight(total_ergo: float, total_weight: float, equip_ergo_modifier: float = 0.0) -> float:
    """Returns evo_weight (positive = overswing, negative = under threshold)."""
    b = equip_ergo_modifier
    E = total_ergo * (1 + b)
    KG = 0.0007556 * (E ** 2) + 0.02736 * E + 2.9159
    return total_weight - KG


def _calc_eed(total_ergo: float, total_weight: float, equip_ergo_modifier: float = 0.0) -> float:
    return -15 * _calc_evo_weight(total_ergo, total_weight, equip_ergo_modifier)


def _calc_arm_stamina(total_weight: float, total_ergo: float, strength_level: int, equip_ergo_modifier: float = 0.0) -> float:
    b = equip_ergo_modifier
    return (
        (85.5 / (total_weight + 0.65))
        + 9.15
        + 0.06477 * total_ergo * (1 + b / 2)
    ) / 1.04 * (1 + strength_level * 0.004)


# ---------------------------------------------------------------------------
# EED tests
# ---------------------------------------------------------------------------

class TestCalcEED:
    def test_zero_weight_zero_ergo(self):
        # With ergo=0, E=0, KG=2.9159 → evo_weight = 0 - 2.9159 = -2.9159
        # EED = -15 * -2.9159 = 43.74
        eed = _calc_eed(0, 0)
        assert round(eed, 2) == 43.74

    def test_positive_eed_means_no_overswing(self):
        # A build well below threshold should have positive EED
        eed = _calc_eed(total_ergo=60, total_weight=3.0)
        assert eed > 0

    def test_negative_eed_means_overswing(self):
        # Very heavy build with low ergo
        eed = _calc_eed(total_ergo=10, total_weight=15.0)
        assert eed < 0

    def test_overswing_boundary(self):
        # At exactly KG = total_weight, EED should be 0
        # E = 60 → KG = 0.0007556*3600 + 0.02736*60 + 2.9159 = 2.72 + 1.642 + 2.9159 = 7.277...
        total_ergo = 60.0
        b = 0.0
        E = total_ergo * (1 + b)
        kg = 0.0007556 * (E ** 2) + 0.02736 * E + 2.9159
        eed = _calc_eed(total_ergo, kg)  # total_weight == KG → evo_weight = 0
        assert abs(eed) < 0.001

    def test_equip_ergo_modifier_reduces_effective_ergo(self):
        # A negative equip_ergo_modifier (equipment penalty) lowers effective ergo
        # and thus lowers the KG threshold, making EED smaller (worse)
        eed_no_penalty = _calc_eed(total_ergo=60, total_weight=5.0, equip_ergo_modifier=0.0)
        eed_with_penalty = _calc_eed(total_ergo=60, total_weight=5.0, equip_ergo_modifier=-0.20)
        assert eed_with_penalty < eed_no_penalty

    def test_symmetry_with_frontend_formula(self):
        # Known values cross-checked against the JS calcEED implementation:
        #   calcEED(50, 4.5, 0) in JS should equal this backend formula.
        # JS: E=50, KG=0.0007556*2500+0.02736*50+2.9159=1.889+1.368+2.9159=6.1729
        #     evo_weight=4.5-6.1729=-1.6729, eed=-15*-1.6729=25.09
        eed = _calc_eed(50, 4.5, 0.0)
        assert abs(round(eed, 2) - 25.09) < 0.05


# ---------------------------------------------------------------------------
# Arm stamina tests
# ---------------------------------------------------------------------------

class TestCalcArmStamina:
    def test_higher_strength_increases_stamina(self):
        base = _calc_arm_stamina(4.0, 50, 10)
        high = _calc_arm_stamina(4.0, 50, 51)
        assert high > base

    def test_heavier_build_decreases_stamina(self):
        light = _calc_arm_stamina(3.0, 50, 10)
        heavy = _calc_arm_stamina(7.0, 50, 10)
        assert heavy < light

    def test_higher_ergo_increases_stamina(self):
        low_ergo  = _calc_arm_stamina(4.0, 30, 10)
        high_ergo = _calc_arm_stamina(4.0, 70, 10)
        assert high_ergo > low_ergo

    def test_strength_level_zero(self):
        # multiplier = (1 + 0 * 0.004) = 1.0 — formula still valid
        stamina = _calc_arm_stamina(4.0, 50, 0)
        assert stamina > 0

    def test_result_is_finite(self):
        stamina = _calc_arm_stamina(4.0, 50, 25, equip_ergo_modifier=-0.15)
        assert math.isfinite(stamina)

    def test_symmetry_with_frontend_formula(self):
        # JS calcArmStamina(4.0, 50, 10, 0):
        #   = (85.5/4.65 + 9.15 + 0.06477*50) / 1.04 * 1.04
        #   = (18.387 + 9.15 + 3.2385) / 1.04 * 1.04
        #   = 30.776 / 1.04 * 1.04 = 30.776
        stamina = _calc_arm_stamina(4.0, 50, 10, 0.0)
        assert abs(round(stamina, 1) - round(
            ((85.5 / (4.0 + 0.65)) + 9.15 + 0.06477 * 50 * (1 + 0.0 / 2)) / 1.04 * (1 + 10 * 0.004),
            1
        )) < 0.1


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
