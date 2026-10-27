"""Check the armor ballistics engine against hand-worked numbers and the shared golden curves."""

import json
import os

import pytest

import ballistics as B

GOLDEN_PATH = os.path.join(os.path.dirname(__file__), "data", "ballistics_golden.json")


@pytest.fixture(scope="module")
def armor_globals():
    return B.load_armor_globals()


def test_real_resistance_at_full_durability(armor_globals):
    real, class_resistance, cf = B.real_resistance(50, 50, 4, 44, armor_globals)
    assert real == pytest.approx(40.236735, abs=1e-5)
    assert class_resistance == 40
    assert cf == pytest.approx(0.842319, abs=1e-5)


def test_real_resistance_drops_with_durability(armor_globals):
    real, _, _ = B.real_resistance(25, 50, 4, 44, armor_globals)
    assert real == pytest.approx(34.606897, abs=1e-5)


@pytest.mark.parametrize(
    "real, penetration, expected",
    [
        (40, 20, 0.0),  # resistance 15+ above pen never lets it through
        (40, 30, 0.1),
        (40, 40, 0.9),
        (40, 50, 0.964286),
        (10, 50, 1.0),  # resistance 15+ below pen always does
    ],
)
def test_penetration_chance_branches(real, penetration, expected):
    assert B.penetration_chance(real, penetration) == pytest.approx(expected, abs=1e-6)


def test_degradation_keeps_half_at_zero_speed(armor_globals):
    assert B.degradation_factor(1.0, armor_globals) == pytest.approx(1.0)
    assert B.degradation_factor(0.6, armor_globals) == pytest.approx(0.8)
    assert B.degradation_factor(0.0, armor_globals) == pytest.approx(0.5)


def test_penetration_samples_cover_the_spread():
    samples = B.penetration_samples(B.Ammo(50, 40, 40, penetration_deviation=2))
    assert sum(p for p, _ in samples) == pytest.approx(1.0)
    assert all(38 <= pen <= 42 for _, pen in samples)
    assert B.penetration_samples(B.Ammo(50, 40, 40)) == [(1.0, 40.0)]


def test_single_hit_block_and_penetration(armor_globals):
    layer = B.ArmorLayer(3, 40, 40, "Aramid", 0.3)
    outcomes = B.collider_hit([layer], [40], 60, 30, B.Ammo(60, 30, 50), armor_globals, is_plate=False)
    by_blocker = {blocker: (p, durs, dealt) for p, durs, dealt, blocker in outcomes}

    p, durs, dealt = by_blocker[0]
    assert p == pytest.approx(0.121180, abs=1e-6)
    assert durs[0] == pytest.approx(37.1875, abs=1e-6)
    assert dealt == pytest.approx(17.904122, abs=1e-6)

    p, durs, dealt = by_blocker[None]
    assert p == pytest.approx(0.878820, abs=1e-6)
    assert durs[0] == pytest.approx(38.199575, abs=1e-6)
    assert dealt == pytest.approx(42.676731, abs=1e-6)


def test_destroyed_layer_is_skipped(armor_globals):
    broken = B.ArmorLayer(2, 40, 0, "Aramid", 0.35)
    outcomes = B.collider_hit([broken], [0], 61, 35, B.Ammo(61, 35, 52), armor_globals, is_plate=False)
    assert outcomes == [(1.0, [0], 61, None)]


def test_plate_block_uses_flagged_blunt_and_gate_can_stop_the_bullet(armor_globals):
    plate = B.ArmorLayer(5, 50, 50, "Ceramic", 0.3, "Heavy", blunt_reduce_from_soft_armor=True)
    soft = B.ArmorLayer(3, 40, 40, "Aramid", 0.3)
    outcomes = B.shot_outcomes(
        B.Ammo(49, 44, 47),
        [plate],
        [soft],
        [50, 40],
        44,
        armor_globals,
        plate_collider=B.PlateCollider(penetration_level=100, penetration_chance=0.3, penetration_damage_mod=0.57),
    )
    assert sum(p for p, _, _ in outcomes) == pytest.approx(1.0)
    blocked, through = sorted(outcomes, key=lambda o: -o[2])
    assert blocked[2] == pytest.approx(7.1541, abs=1e-4)  # includes the 0.6 soft armor multiplier
    # Penetrated plates deal nothing themselves, and nothing gets past a collider gate of 100
    assert through[2] == 0.0
    assert through[1][1] == 40


def test_plate_shot_needs_collider_values(armor_globals):
    plate = B.ArmorLayer(5, 50, 50, "Ceramic", 0.3, "Heavy")
    with pytest.raises(ValueError):
        B.shot_outcomes(B.Ammo(49, 44, 47), [plate], [], [50], 44, armor_globals)


def test_kill_chance_only_grows(armor_globals):
    result = B.simulate(
        B.Ammo(61, 35, 52, 1), 85, soft_layers=[B.ArmorLayer(3, 50, 50, "Aramid", 0.3)], armor_globals=armor_globals
    )
    chances = [shot.kill_chance for shot in result.shots]
    assert chances == sorted(chances)
    assert chances[-1] >= 0.9999
    assert result.shots_to_kill() is not None


def _golden_cases():
    with open(GOLDEN_PATH, encoding="utf-8") as f:
        data = json.load(f)
    return [(case, data["tolerance"]) for case in data["cases"]]


@pytest.mark.parametrize("case, tolerance", _golden_cases(), ids=lambda c: c["name"] if isinstance(c, dict) else "")
def test_golden_kill_chance_curves(case, tolerance, armor_globals):
    collider = case["plate_collider"]
    result = B.simulate(
        B.Ammo(**case["ammo"]),
        case["hp"],
        soft_layers=[B.ArmorLayer(**layer) for layer in case["soft_layers"]],
        plates=[B.ArmorLayer(**layer) for layer in case["plates"]],
        armor_globals=armor_globals,
        plate_collider=B.PlateCollider(**collider) if collider else None,
        speed_ratio=case["speed_ratio"],
        heavy_vest_skill=case["heavy_vest_skill"],
        max_shots=len(case["kill_chance"]),
    )
    ours = [shot.kill_chance for shot in result.shots]
    # The simulation stops once a kill is all but certain; treat the shots it skipped as kills
    ours += [ours[-1]] * (len(case["kill_chance"]) - len(ours))
    for shot, (got, expected) in enumerate(zip(ours, case["kill_chance"]), start=1):
        assert got == pytest.approx(expected, abs=tolerance), f"shot {shot}"


def test_g1_drag_lookup_quirks():
    # Below Mach 0.05 there's no drag at all, and past the table the last row holds
    assert B.g1_drag(10) == 0.0
    assert B.g1_drag(343 * 10) == pytest.approx(0.4988)
    # Rows are picked as if 0.05 Mach apart: Mach 0.62 lands on row 12 (Mach 0.6) and
    # interpolates from row 11 (Mach 0.55)
    assert B.g1_drag(343 * 0.62) == pytest.approx(0.202 + (0.2034 - 0.202) / (0.05 * 343) * (343 * 0.07), abs=1e-6)


def test_muzzle_speed_adds_velocity_percentages():
    assert B.muzzle_speed(900, 0) == 900
    assert B.muzzle_speed(900, -2.5) == pytest.approx(877.5)


def test_flight_slows_and_drops_the_bullet():
    path = B.flight_path(945, 4, 5.7, 0.233, 500)
    speeds = [point.speed for point in path]
    drops = [point.drop for point in path]
    assert speeds == sorted(speeds, reverse=True)
    assert drops == sorted(drops)
    # Regression anchors for M855A1 out of a rifle with no velocity mods
    assert B.arrival(path, 100).speed == pytest.approx(816, abs=1)
    assert B.arrival(path, 300).drop == pytest.approx(0.70, abs=0.01)
    assert B.arrival(path, 5000) is None


def test_arrival_uses_the_speed_of_the_step_it_hits_in():
    path = B.flight_path(700, 7.9, 7.92, 0.367, 50)
    hit = B.arrival(path, 30)
    before = max((p for p in path if p.distance <= 30), key=lambda p: p.distance)
    assert hit.speed == before.speed
