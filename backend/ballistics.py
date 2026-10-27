"""Armor ballistics: what a run of shots into one spot does to armor and the body part behind it.

Every formula here matches the game's own rules. Instead of sampling random shots we track
the exact probability of every reachable state (remaining HP plus each armor layer's
durability) shot by shot, so the kill chances come out exact up to the rounding we use to
merge near-identical states.

A shot into a spot covered by a plate is two hits in game: the plate collider first, then
the body collider behind it, where the soft armor sits. What the bullet keeps between the
two depends on per-collider values on the player model (PlateCollider below). Those aren't
in any data file we sync, so callers pass them in.
"""

import json
import math
import os
from dataclasses import dataclass, field

import numpy as np

# The game draws a shot's penetration as mean + deviation * u, where u is uniform within
# one of six equal-width bins spanning [-1, 1], picked with these weights.
_PEN_DEVIATION_BIN_WEIGHTS = (0.021, 0.136, 0.341, 0.341, 0.136, 0.025)
# The spread is about one point of penetration on most ammo, so a sample per bin is plenty
_PEN_SAMPLES_PER_BIN = 1

# HP is tracked as a distribution on this grid, with a remaining HP between two grid points
# split between them. Durabilities are rounded instead: armor wear has hard thresholds (a
# piece breaking at exactly 0, the minimum loss of 1), and splitting a durability across
# one of those would flip outcomes that should stay put. At these sizes the kill chances
# stay within about 0.001 of an exact answer.
_HP_GRID_STEP = 0.05
_DURABILITY_DECIMALS = 1
# Drop branches too unlikely to change any reported number
_MIN_STATE_PROBABILITY = 1e-12


@dataclass(frozen=True)
class ArmorGlobals:
    class_resistance: tuple  # indexed by armor class
    destructibility: dict  # material name -> destructibility
    blunt_damage_reduce_from_soft_armor_mod: float
    damage_degradation_coefficient: float


@dataclass(frozen=True)
class Ammo:
    damage: float
    penetration: float
    armor_damage: float  # percent, as tarkov.dev and the item templates list it
    penetration_deviation: float = 0.0
    penetration_damage_mod: float = 0.0


@dataclass(frozen=True)
class ArmorLayer:
    armor_class: int
    max_durability: float
    durability: float
    material: str
    blunt_throughput: float
    armor_type: str = "Light"
    # Plates in a slot flagged bluntDamageReduceFromSoftArmor
    blunt_reduce_from_soft_armor: bool = False


@dataclass(frozen=True)
class PlateCollider:
    """Values the plate collider on the player model carries for bullets passing through it."""

    penetration_level: float
    penetration_chance: float
    penetration_damage_mod: float


@dataclass
class ShotResult:
    shot: int
    kill_chance: float  # chance the target is dead after this many shots
    # Averages over the outcomes where the target is still alive, i.e. what the next shot
    # faces. Durabilities are per layer, plates first. None once every outcome is a kill.
    durability_alive: list | None
    hp_alive: float | None


@dataclass
class SimulationResult:
    shots: list = field(default_factory=list)

    def shots_to_kill(self, chance=0.5):
        """First shot whose kill chance reaches `chance`, or None if none of them did."""
        for result in self.shots:
            if result.kill_chance >= chance:
                return result.shot
        return None


def load_armor_globals(path=None):
    """ArmorGlobals from the checked-in spt_armor_stats.json (or another extract)."""
    path = path or os.path.join(os.path.dirname(__file__), "spt_armor_stats.json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)["globals"]
    return ArmorGlobals(
        class_resistance=tuple(data["class_resistance"]),
        destructibility={name: values["destructibility"] for name, values in data["materials"].items()},
        blunt_damage_reduce_from_soft_armor_mod=data["blunt_damage_reduce_from_soft_armor_mod"],
        damage_degradation_coefficient=data["damage_degradation_coefficient"],
    )


def load_player_colliders(path=None):
    """The player model's colliders from spt_armor_stats.json: {"body_parts": {collider: body
    part}, "plates": {plate zone: {collider, body_part, penetration_level, ...}}}."""
    path = path or os.path.join(os.path.dirname(__file__), "spt_armor_stats.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)["colliders"]


def _clamp(value, low, high):
    return min(max(value, low), high)


def _lerp(a, b, t):
    return a + (b - a) * _clamp(t, 0.0, 1.0)


def real_resistance(durability, max_durability, armor_class, penetration, armor_globals):
    """(real resistance, class resistance, CF) for one armor piece against one bullet.

    CF is how much of the bullet's damage and penetration survive passing through it."""
    durability_percent = durability / max_durability * 100
    class_resistance = armor_globals.class_resistance[armor_class]
    real = (121 - 5000 / (durability_percent * 2 + 45)) * class_resistance * 0.01
    cf = _clamp(penetration / (real + 12), 0.6, 1.0)
    return real, class_resistance, cf


def penetration_chance(real, penetration):
    """Chance in [0, 1] that a bullet with this penetration gets through this resistance."""
    if real >= penetration + 15:
        return 0.0
    if real < penetration:
        if real > penetration - 15:
            return (penetration / (real * 0.9 - penetration) + 100) / 100
        return 1.0
    return 0.4 * (real - penetration - 15) ** 2 / 100


# Bullet flight. The game precomputes each bullet's path in fixed 0.01 s steps with G1 drag
# (this table: Mach number, drag coefficient) and gravity.
_G1_DRAG = (
    (0.0, 0.2629),
    (0.05, 0.2558),
    (0.1, 0.2487),
    (0.15, 0.2413),
    (0.2, 0.2344),
    (0.25, 0.2278),
    (0.3, 0.2214),
    (0.35, 0.2155),
    (0.4, 0.2104),
    (0.45, 0.2061),
    (0.5, 0.2032),
    (0.55, 0.202),
    (0.6, 0.2034),
    (0.7, 0.2165),
    (0.725, 0.223),
    (0.75, 0.2313),
    (0.775, 0.2417),
    (0.8, 0.2546),
    (0.825, 0.2706),
    (0.85, 0.2901),
    (0.875, 0.3136),
    (0.9, 0.3415),
    (0.925, 0.3734),
    (0.95, 0.4084),
    (0.975, 0.4448),
    (1, 0.4805),
    (1.025, 0.5136),
    (1.05, 0.5427),
    (1.075, 0.5677),
    (1.1, 0.5883),
    (1.125, 0.6053),
    (1.15, 0.6191),
    (1.2, 0.6393),
    (1.25, 0.6518),
    (1.3, 0.6589),
    (1.35, 0.6621),
    (1.4, 0.6625),
    (1.45, 0.6607),
    (1.5, 0.6573),
    (1.55, 0.6528),
    (1.6, 0.6474),
    (1.65, 0.6413),
    (1.7, 0.6347),
    (1.75, 0.628),
    (1.8, 0.621),
    (1.85, 0.6141),
    (1.9, 0.6072),
    (1.95, 0.6003),
    (2, 0.5934),
    (2.05, 0.5867),
    (2.1, 0.5804),
    (2.15, 0.5743),
    (2.2, 0.5685),
    (2.25, 0.563),
    (2.3, 0.5577),
    (2.35, 0.5527),
    (2.4, 0.5481),
    (2.45, 0.5438),
    (2.5, 0.5397),
    (2.6, 0.5325),
    (2.7, 0.5264),
    (2.8, 0.5211),
    (2.9, 0.5168),
    (3, 0.5133),
    (3.1, 0.5105),
    (3.2, 0.5084),
    (3.3, 0.5067),
    (3.4, 0.5054),
    (3.5, 0.504),
    (3.6, 0.503),
    (3.7, 0.5022),
    (3.8, 0.5016),
    (3.9, 0.501),
    (4, 0.5006),
    (4.2, 0.4998),
    (4.4, 0.4995),
    (4.6, 0.4992),
    (4.8, 0.499),
    (5, 0.4988),
)
_SPEED_OF_SOUND = 343.0
_GRAVITY = 9.81
_FLIGHT_STEP = 0.01
# The game stops following a bullet after this long
_MAX_FLIGHT_TIME = 13.0


@dataclass
class FlightPoint:
    time: float
    distance: float  # downrange, in meters
    drop: float  # below the line it was fired along, in meters
    speed: float


def g1_drag(speed):
    """G1 drag coefficient at this speed, looked up the way the game does it.

    The game picks the table row as if rows were 0.05 Mach apart, which they aren't past
    Mach 0.6, and interpolates from the row before it. We copy that rather than fix it."""
    index = int(math.floor(speed / _SPEED_OF_SOUND / 0.05))
    if index <= 0:
        return 0.0
    if index > len(_G1_DRAG) - 1:
        return _G1_DRAG[-1][1]
    low_speed = _G1_DRAG[index - 1][0] * _SPEED_OF_SOUND
    high_speed = _G1_DRAG[index][0] * _SPEED_OF_SOUND
    low_drag = _G1_DRAG[index - 1][1]
    return (_G1_DRAG[index][1] - low_drag) / (high_speed - low_speed) * (speed - low_speed) + low_drag


def muzzle_speed(initial_speed, velocity_modifier_pct=0.0):
    """Ammo's listed speed after the weapon's and its mods' summed velocity percentages."""
    return initial_speed * (1 + velocity_modifier_pct / 100)


def flight_path(speed, bullet_mass_grams, bullet_diameter_mm, ballistic_coefficient, max_distance):
    """[FlightPoint] every 0.01 s for a level shot, until it passes `max_distance` meters."""
    mass = bullet_mass_grams / 1000
    diameter = bullet_diameter_mm / 1000
    form = mass * 0.0014223 / (diameter * diameter * ballistic_coefficient)
    slowdown = 1.2 * diameter * diameter * math.pi / 4

    vx, vy, x, y, time = speed, 0.0, 0.0, 0.0, 0.0
    points = [FlightPoint(time, x, 0.0, speed)]
    while x < max_distance and time < _MAX_FLIGHT_TIME:
        magnitude = math.hypot(vx, vy)
        if magnitude <= 0:
            break
        drag = slowdown * -(g1_drag(magnitude) * form) * magnitude * magnitude / (mass * 2)
        ax = drag * vx / magnitude
        ay = drag * vy / magnitude - _GRAVITY
        x, y = x + vx * _FLIGHT_STEP + 5e-05 * ax, y + vy * _FLIGHT_STEP + 5e-05 * ay
        vx, vy = vx + ax * _FLIGHT_STEP, vy + ay * _FLIGHT_STEP
        time += _FLIGHT_STEP
        points.append(FlightPoint(time, x, -y, math.hypot(vx, vy)))
    return points


def arrival(points, distance):
    """FlightPoint the bullet hits with at `distance`, or None if it never gets there.

    The game reports the speed of the step the bullet is in when it hits, not a blend of
    the two steps around it, so we do the same; time and drop are interpolated."""
    for before, after in zip(points, points[1:]):
        if after.distance >= distance:
            share = (distance - before.distance) / (after.distance - before.distance)
            return FlightPoint(
                time=before.time + (after.time - before.time) * share,
                distance=distance,
                drop=before.drop + (after.drop - before.drop) * share,
                speed=before.speed,
            )
    return None


def degradation_factor(speed_ratio, armor_globals):
    """Share of damage and penetration a bullet keeps on impact at this fraction of muzzle speed."""
    ratio = _clamp(speed_ratio, 0.0, 1.0)
    return ratio + (1 - ratio) * _clamp(armor_globals.damage_degradation_coefficient, 0.0, 1.0)


def penetration_samples(ammo):
    """[(probability, penetration)] covering the game's spread of shot penetration."""
    if not ammo.penetration_deviation:
        return [(1.0, float(ammo.penetration))]
    samples = []
    width = 2 / len(_PEN_DEVIATION_BIN_WEIGHTS)
    step = width / _PEN_SAMPLES_PER_BIN
    for index, weight in enumerate(_PEN_DEVIATION_BIN_WEIGHTS):
        low = -1 + index * width
        for sample in range(_PEN_SAMPLES_PER_BIN):
            u = low + (sample + 0.5) * step
            samples.append((weight / _PEN_SAMPLES_PER_BIN, ammo.penetration + ammo.penetration_deviation * u))
    return samples


def collider_hit(layers, durabilities, damage, penetration, ammo, armor_globals, is_plate, heavy_vest_skill=0.0):
    """Every outcome of one bullet hitting one collider covered by `layers`, in the order the
    game checks them.

    Returns [(probability, new durabilities, damage to the body part, blocked by index or None)].
    """
    # Every live layer rolls with the bullet's full penetration until one of them blocks it
    chances = []
    for layer, durability in zip(layers, durabilities):
        if durability <= 0:
            chances.append(None)
        else:
            real, _, _ = real_resistance(
                durability, layer.max_durability, layer.armor_class, penetration, armor_globals
            )
            chances.append(penetration_chance(real, penetration))

    outcomes = []
    reach = 1.0
    for blocker in [*range(len(layers)), None]:
        if blocker is None:
            probability = reach
        elif chances[blocker] is None:
            continue
        else:
            probability = reach * (1 - chances[blocker])
            reach *= chances[blocker]
        if probability <= 0:
            continue
        new_durabilities, body_damage = _apply_layers(
            layers, durabilities, damage, penetration, ammo, armor_globals, is_plate, heavy_vest_skill, blocker
        )
        outcomes.append((probability, new_durabilities, body_damage, blocker))
    return outcomes


def _apply_layers(layers, durabilities, damage, penetration, ammo, armor_globals, is_plate, heavy_vest_skill, blocker):
    """Run the bullet through each layer once the rolls have settled which one (if any) blocks it."""
    armor_damage = ammo.armor_damage / 100
    new_durabilities = list(durabilities)
    blocked = False
    for index, layer in enumerate(layers):
        throughput = layer.blunt_throughput
        if layer.armor_type == "Heavy":
            throughput *= 1 - heavy_vest_skill
        if blocked:
            # Layers behind the one that stopped the bullet only soften the blunt damage
            damage *= throughput
            continue
        durability = new_durabilities[index]
        if durability <= 0:
            continue
        if layer.blunt_reduce_from_soft_armor:
            throughput *= armor_globals.blunt_damage_reduce_from_soft_armor_mod

        entry_penetration = penetration
        real, class_resistance, cf = real_resistance(
            durability, layer.max_durability, layer.armor_class, entry_penetration, armor_globals
        )
        destructibility = armor_globals.destructibility[layer.material]
        if index == blocker:
            loss = penetration * armor_damage * _clamp(entry_penetration / class_resistance, 0.6, 1.1) * destructibility
            damage *= throughput * _clamp(1 - 0.03 * (real - entry_penetration), 0.2, 1.0)
            blocked = True
        else:
            if is_plate:
                # A plate hit itself hurts nothing once it's penetrated; the body hit behind it does
                damage = 0.0
            damage *= cf
            penetration *= cf
            loss = penetration * armor_damage * _clamp(entry_penetration / class_resistance, 0.5, 0.9) * destructibility
        new_durabilities[index] = max(0.0, durability - max(1.0, loss))
    return new_durabilities, damage


def shot_outcomes(
    ammo,
    plates,
    soft_layers,
    durabilities,
    shot_penetration,
    armor_globals,
    speed_ratio=1.0,
    plate_collider=None,
    heavy_vest_skill=0.0,
):
    """Every outcome of one shot: [(probability, new durabilities, total body damage)].

    `durabilities` covers the plates first, then the soft layers."""
    first = degradation_factor(speed_ratio, armor_globals)
    damage = ammo.damage * first
    penetration = shot_penetration * first
    plate_count = len(plates)

    if not plates:
        return [
            (p, durs, dealt)
            for p, durs, dealt, _ in collider_hit(
                soft_layers, durabilities, damage, penetration, ammo, armor_globals, False, heavy_vest_skill
            )
        ]
    if plate_collider is None:
        raise ValueError("a shot into a plate needs the plate collider values")

    plate_durabilities = durabilities[:plate_count]
    soft_durabilities = durabilities[plate_count:]
    # The game reads CF for the continuing bullet from the first plate, before this hit wears it
    first_plate = plates[0]

    outcomes = []
    for p, new_plates, plate_damage, blocker in collider_hit(
        plates, plate_durabilities, damage, penetration, ammo, armor_globals, True, heavy_vest_skill
    ):
        _, _, cf = real_resistance(
            plate_durabilities[0], first_plate.max_durability, first_plate.armor_class, penetration, armor_globals
        )
        if blocker is not None or penetration * cf <= plate_collider.penetration_level:
            outcomes.append((p, [*new_plates, *soft_durabilities], plate_damage))
            continue

        keep = _clamp(
            (penetration - plate_collider.penetration_level) / 100
            + plate_collider.penetration_damage_mod
            + ammo.penetration_damage_mod,
            0.0,
            1.0,
        )
        next_penetration = penetration * keep
        _, _, cf = real_resistance(
            plate_durabilities[0], first_plate.max_durability, first_plate.armor_class, next_penetration, armor_globals
        )
        next_speed = speed_ratio * _lerp(0.8, 1.0, plate_collider.penetration_chance)
        second = degradation_factor(next_speed, armor_globals)
        next_damage = damage * keep * cf * second
        next_penetration *= cf * second

        for q, new_soft, body_damage, _ in collider_hit(
            soft_layers, soft_durabilities, next_damage, next_penetration, ammo, armor_globals, False, heavy_vest_skill
        ):
            outcomes.append((p * q, [*new_plates, *new_soft], plate_damage + body_damage))
    return outcomes


def _snap(value, step):
    """[(grid value, share)] splitting a positive `value` between its two neighboring grid points."""
    below = int(value // step) * step
    share_above = (value - below) / step
    if below <= 0 or share_above < 1e-9:
        # Never move a positive value onto 0, and skip zero-weight neighbors
        return [(round(below + step if below <= 0 else below, 6), 1.0)]
    if share_above > 1 - 1e-9:
        return [(round(below + step, 6), 1.0)]
    return [(round(below, 6), 1 - share_above), (round(below + step, 6), share_above)]


def _durability_key(durabilities):
    """Durabilities rounded for merging states. A live piece never rounds down to destroyed."""
    smallest = 10**-_DURABILITY_DECIMALS
    return tuple(0.0 if d <= 0 else max(round(d, _DURABILITY_DECIMALS), smallest) for d in durabilities)


def _apply_hp_damage(hp_bins, dealt):
    """(HP distribution after taking `dealt` damage, probability mass killed).

    Bin i holds the chance of having exactly i * _HP_GRID_STEP HP left. A remaining HP between
    two bins is split between them, and anything still alive never lands in bin 0."""
    shift = dealt / _HP_GRID_STEP
    whole = int(shift)
    frac = shift - whole
    size = len(hp_bins)
    # Bins at or below the damage dealt are kills
    cut = whole + 1
    killed = float(hp_bins[:cut].sum())
    after = np.zeros(size)
    alive = hp_bins[cut:]
    if alive.size:
        # Bin i lands between bins i - whole - 1 and i - whole
        landing = size - whole
        after[1:landing] += alive * (1 - frac)
        after[: landing - 1] += alive * frac
        after[1] += after[0]
        after[0] = 0.0
    return after, killed


def simulate(
    ammo,
    hp,
    soft_layers=(),
    plates=(),
    armor_globals=None,
    plate_collider=None,
    speed_ratio=1.0,
    heavy_vest_skill=0.0,
    max_shots=50,
    stop_at_kill_chance=0.9999,
    projectiles=1,
):
    """Kill chance and armor wear after each of up to `max_shots` shots into the same spot.

    The target dies once the body part behind the armor reaches 0 HP (thorax or head).
    Buckshot fires `projectiles` pellets per shot, each its own bullet with its own
    penetration roll, hitting one after another; we assume every pellet lands on the spot."""
    armor_globals = armor_globals or load_armor_globals()
    layers = [*plates, *soft_layers]
    samples = penetration_samples(ammo)

    # One HP distribution per durability state, since far fewer durability states exist
    # than HP values
    bins = int(math.ceil(hp / _HP_GRID_STEP)) + 1
    start = np.zeros(bins)
    for value, share in _snap(hp, _HP_GRID_STEP):
        start[int(round(value / _HP_GRID_STEP))] += share
    hp_values = np.arange(bins) * _HP_GRID_STEP
    states = {tuple(layer.durability for layer in layers): start}
    killed = 0.0
    result = SimulationResult()

    # The same durability states come back shot after shot, so remember their outcomes
    cache = {}

    def outcomes_for(durabilities):
        outcomes = cache.get(durabilities)
        if outcomes is None:
            outcomes = []
            for weight, shot_penetration in samples:
                for p, new_durabilities, dealt in shot_outcomes(
                    ammo,
                    plates,
                    soft_layers,
                    list(durabilities),
                    shot_penetration,
                    armor_globals,
                    speed_ratio,
                    plate_collider,
                    heavy_vest_skill,
                ):
                    outcomes.append((weight * p, _durability_key(new_durabilities), dealt))
            cache[durabilities] = outcomes
        return outcomes

    for shot in range(1, max_shots + 1):
        for _ in range(projectiles):
            next_states = {}
            for durabilities, hp_bins in states.items():
                for branch, state, dealt in outcomes_for(durabilities):
                    after, dead = _apply_hp_damage(hp_bins, dealt)
                    killed += branch * dead
                    target = next_states.get(state)
                    if target is None:
                        next_states[state] = after * branch
                    else:
                        target += after * branch
            states = {d: h for d, h in next_states.items() if h.sum() >= _MIN_STATE_PROBABILITY}

        alive = sum(float(h.sum()) for h in states.values())
        if alive > 0:
            durability_alive = [
                sum(float(h.sum()) * durabilities[i] for durabilities, h in states.items()) / alive
                for i in range(len(layers))
            ]
            hp_alive = sum(float(h @ hp_values) for h in states.values()) / alive
        else:
            durability_alive, hp_alive = None, None
        result.shots.append(
            ShotResult(shot=shot, kill_chance=killed, durability_alive=durability_alive, hp_alive=hp_alive)
        )
        if killed >= stop_at_kill_chance or not states:
            break
    return result
