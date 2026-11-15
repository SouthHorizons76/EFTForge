"""Armor ballistics: what a run of shots into one spot does to armor and the body part behind it.

Every formula here matches the game's own rules. Instead of sampling random shots we track
the exact probability of every reachable state (remaining HP plus each armor layer's
durability) shot by shot, so the kill chances come out exact up to the rounding we use to
merge near-identical states.

A shot into a spot covered by a plate is two hits in game: the plate collider first, then
the body collider behind it, where the soft armor sits. What the bullet keeps between the
two depends on per-collider values on the player model (PlateCollider below). Those aren't
in any data file we sync, so callers pass them in.

A bullet can also go on through a limb, the neck or the head into another body part, which
takes its own full hit (simulate_through). The torso and pelvis colliders always stop it.
"""

import collections
import functools
import json
import math
import os
import time
from dataclasses import dataclass, field

# A shot's penetration is mean + deviation * u, with u uniform within one of six
# equal-width bins spanning [-1, 1], picked with these weights.
_PEN_DEVIATION_BIN_WEIGHTS = (0.021, 0.136, 0.341, 0.341, 0.136, 0.025)
# The spread is about one point of penetration on most ammo, so a sample per bin is plenty
_PEN_SAMPLES_PER_BIN = 1

# HP is tracked as a distribution on this grid, with a remaining HP between two grid points
# split between them. Durabilities are rounded instead: armor wear has hard thresholds (a
# piece breaking at exactly 0, the minimum loss of 1), and splitting a durability across
# one of those would flip outcomes that should stay put. At these sizes the kill chances
# stay within about 0.001 of an exact answer.
_HP_GRID_STEP = 0.05
_DURABILITY_STEP = 0.1
# Drop branches too unlikely to change any reported number
_MIN_STATE_PROBABILITY = 1e-12


@dataclass(frozen=True)
class ArmorGlobals:
    class_resistance: tuple  # indexed by armor class
    destructibility: dict  # material name -> destructibility
    blunt_damage_reduce_from_soft_armor_mod: float
    damage_degradation_coefficient: float
    # {"parts": {body part: {max, over_damage_received}}, "over_damage_factor": {body part: factor}}
    health: dict = field(default_factory=dict)
    # {body collider: {penetration_level, penetration_chance, penetration_damage_mod}}
    body_colliders: dict = field(default_factory=dict)


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
    # Ricochet chance at 90 degrees (x) and at the angle it starts (z, y there)
    ricochet_x: float = 0.0
    ricochet_y: float = 0.0
    ricochet_z: float = 0.0


@dataclass(frozen=True)
class PlateCollider:
    """Values a collider on the player model carries for bullets passing through it: a plate
    collider, or a body collider (BodyPartColliderSettings in the game's globals)."""

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
    # What this shot's bullets run into, over the targets still alive when it's fired: the
    # chance each layer stops the bullet (blocks or deflects it), the chance it gets through
    # every layer to the body, and the damage it deals then. None where nothing applies.
    stop_chance: list | None = None
    penetration_chance: float | None = None
    penetration_damage: float | None = None


@dataclass
class SimulationResult:
    shots: list = field(default_factory=list)
    # True when the run hit its time budget before the kill chance settled
    truncated: bool = False

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
        health=data.get("health", {}),
        body_colliders=data.get("body_colliders", {}),
    )


_LETHAL_PARTS = ("Head", "Chest")


def spread_capacity(body_part, health):
    """Damage a target can take past `body_part` reaching 0 before its head or thorax does,
    with every other part at full health. 0 for the head and thorax themselves.

    Once a part is at 0, the game spreads the damage past it (times that part's over-damage
    factor) over every other part still alive, in proportion to their max HP and each one's
    over-damage received multiplier. Below 0 the part hit and this capacity both drain 1:1,
    so a run of hits into one part kills like a single pool of its HP plus this. We follow
    the spread continuously; parts going down mid-hit is the only thing that ignores."""
    if body_part in _LETHAL_PARTS:
        return 0.0
    parts = health["parts"]
    factor = health["over_damage_factor"][body_part]
    alive = {name: float(values["max"]) for name, values in parts.items() if name != body_part}
    absorbed = 0.0
    while alive:
        total_max = sum(parts[name]["max"] for name in alive)
        # Overflow it takes to bring each live part to 0 at the current spread rates
        to_zero = {
            name: hp / (factor * parts[name]["over_damage_received"] * parts[name]["max"] / total_max)
            for name, hp in alive.items()
        }
        first = min(to_zero, key=to_zero.get)
        step = to_zero[first]
        absorbed += step
        if first in _LETHAL_PARTS:
            return absorbed
        for name in alive:
            alive[name] -= step * factor * parts[name]["over_damage_received"] * parts[name]["max"] / total_max
        del alive[first]
    return absorbed


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
    return _real_resistance(durability, max_durability, armor_globals.class_resistance[armor_class], penetration)


@functools.lru_cache(maxsize=1 << 16)
def _real_resistance(durability, max_durability, class_resistance, penetration):
    # Every branch of a hit asks for the same layer, durability and pen, so we remember them
    durability_percent = durability / max_durability * 100
    real = (121 - 5000 / (durability_percent * 2 + 45)) * class_resistance * 0.01
    cf = min(max(penetration / (real + 12), 0.6), 1.0)
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


# Bullet flight: the path in fixed 0.01 s steps with G1 drag (this table: Mach number,
# drag coefficient) and gravity.
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
# How long we follow a bullet at most
_MAX_FLIGHT_TIME = 13.0


@dataclass
class FlightPoint:
    time: float
    distance: float  # downrange, in meters
    drop: float  # below the line it was fired along, in meters
    speed: float


def g1_drag(speed):
    """G1 drag coefficient at this speed.

    The row is picked as if rows were 0.05 Mach apart, which they aren't past Mach 0.6,
    and interpolated from the row before it. That's what matches the game's trajectories."""
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

    The speed is that of the step the bullet is in when it hits, not a blend of the two
    steps around it, which is what matches the game; time and drop are interpolated."""
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


@dataclass
class ZeroingRow:
    distance: float
    impact: float  # meters above (+) or below (-) the line of sight
    correction_mrad: float  # milliradians to hold or dial; negative means aim lower
    speed: float
    time: float


def zeroing_table(shot, zero_shot, zero_distance, sight_height, distances):
    """[ZeroingRow] for `shot` fired from a weapon zeroed at `zero_distance` meters with
    `zero_shot`, out to as far as `shot` flies through `distances`.

    Each shot is (muzzle speed, bullet mass in grams, diameter in mm, ballistic coefficient).
    The game zeros a weapon with its default ammo, not what's loaded: it tilts the barrel so
    that round crosses the sight line at the zero distance, with the sight line level and
    `sight_height` meters above the bore. We tilt the level trajectory by that small angle."""
    reach = max(max(distances), zero_distance)
    zero_hit = arrival(flight_path(*zero_shot, zero_distance), zero_distance)
    if zero_hit is None:
        return None
    # Barrel slope that brings the zeroing round up to the sight line at the zero distance
    slope = (sight_height + zero_hit.drop) / zero_distance
    path = flight_path(*shot, reach)
    rows = []
    for distance in distances:
        if distance <= 0:
            rows.append(ZeroingRow(0.0, -sight_height, 0.0, shot[0], 0.0))
            continue
        hit = arrival(path, distance)
        if hit is None:
            break
        impact = -hit.drop + slope * distance - sight_height
        rows.append(ZeroingRow(distance, impact, -impact / distance * 1000, hit.speed, hit.time))
    return rows


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


def deflect_chance(layer, angle):
    """Chance a layer ricochets a shot coming in `angle` degrees off straight-on.

    Past the layer's ricochet_z angle the chance slides from ricochet_y (at ricochet_z) up
    to ricochet_x (at 90 degrees). Layers with no ricochet_x never deflect."""
    if layer.ricochet_x <= 0 or angle <= layer.ricochet_z or layer.ricochet_z >= 90:
        return 0.0
    t = _clamp((angle - 90) / (layer.ricochet_z - 90), 0.0, 1.0)
    return layer.ricochet_x + (layer.ricochet_y - layer.ricochet_x) * t


def collider_hit(
    layers, durabilities, damage, penetration, ammo, armor_globals, is_plate, heavy_vest_skill=0.0, angle=0.0
):
    """Every outcome of one bullet hitting one collider covered by `layers`, in the order the
    game checks them.

    Returns [(probability, new durabilities, damage to the body part, blocked by index or None,
    deflected by index or None)].
    """
    # Each layer first gets a chance to ricochet the bullet, which ends the checks. Otherwise
    # every live layer rolls with the bullet's full penetration until one of them blocks it.
    chances = []
    for layer, durability in zip(layers, durabilities):
        if durability <= 0:
            chances.append(None)
        else:
            real, _, _ = real_resistance(
                durability, layer.max_durability, layer.armor_class, penetration, armor_globals
            )
            chances.append(penetration_chance(real, penetration))
    deflects = [deflect_chance(layer, angle) for layer in layers]

    outcomes = []

    def settle(probability, blocker, deflector):
        if probability <= 0:
            return
        new_durabilities, body_damage = _apply_layers(
            layers,
            durabilities,
            damage,
            penetration,
            ammo,
            armor_globals,
            is_plate,
            heavy_vest_skill,
            blocker,
            deflector,
        )
        outcomes.append((probability, new_durabilities, body_damage, blocker, deflector))

    def walk(index, probability, blocker):
        if probability <= 0:
            return
        if index == len(layers):
            settle(probability, blocker, None)
            return
        deflect = deflects[index]
        if deflect > 0:
            settle(probability * deflect, blocker, index)
        rest = probability * (1 - deflect)
        if blocker is None and chances[index] is not None:
            walk(index + 1, rest * (1 - chances[index]), index)
            walk(index + 1, rest * chances[index], None)
        else:
            walk(index + 1, rest, blocker)

    walk(0, 1.0, None)
    return outcomes


def _apply_layers(
    layers, durabilities, damage, penetration, ammo, armor_globals, is_plate, heavy_vest_skill, blocker, deflector=None
):
    """Run the bullet through each layer once the rolls have settled which one (if any) blocks
    or deflects it."""
    armor_damage = ammo.armor_damage / 100
    new_durabilities = list(durabilities)
    stopped = False
    for index, layer in enumerate(layers):
        throughput = layer.blunt_throughput
        if layer.armor_type == "Heavy":
            throughput *= 1 - heavy_vest_skill
        if stopped:
            # Layers behind the one that stopped the bullet only soften the blunt damage
            damage *= throughput
            continue
        durability = new_durabilities[index]
        if durability <= 0:
            # A broken layer does nothing to the bullet, though it can still have deflected it
            stopped = index == deflector
            continue
        if deflector is not None:
            # Each layer the deflected bullet reaches halves it again
            damage /= 2
            armor_damage /= 2
            penetration /= 2
        if layer.blunt_reduce_from_soft_armor:
            throughput *= armor_globals.blunt_damage_reduce_from_soft_armor_mod

        entry_penetration = penetration
        real, class_resistance, cf = real_resistance(
            durability, layer.max_durability, layer.armor_class, entry_penetration, armor_globals
        )
        destructibility = armor_globals.destructibility[layer.material]
        if index in (blocker, deflector):
            loss = (
                penetration * armor_damage * min(max(entry_penetration / class_resistance, 0.6), 1.1) * destructibility
            )
            damage *= throughput * min(max(1 - 0.03 * (real - entry_penetration), 0.2), 1.0)
            stopped = True
        else:
            if is_plate:
                # A plate hit itself hurts nothing once it's penetrated; the body hit behind it does
                damage = 0.0
            damage *= cf
            penetration *= cf
            loss = (
                penetration * armor_damage * min(max(entry_penetration / class_resistance, 0.5), 0.9) * destructibility
            )
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
    angle=0.0,
):
    """Every outcome of one shot: [(probability, new durabilities, total body damage, index of
    the layer that stopped the bullet or None if it reached the body)].

    `durabilities` covers the plates first, then the soft layers. A bullet the plate collider
    stops counts as stopped by the last plate."""
    return [
        outcome[:4]
        for outcome in _spot_outcomes(
            ammo,
            plates,
            soft_layers,
            durabilities,
            ammo.damage,
            shot_penetration,
            armor_globals,
            speed_ratio,
            plate_collider,
            heavy_vest_skill,
            angle,
        )
    ]


def _spot_outcomes(
    ammo,
    plates,
    soft_layers,
    durabilities,
    damage,
    penetration,
    armor_globals,
    speed_ratio,
    plate_collider,
    heavy_vest_skill,
    angle,
):
    """shot_outcomes for a bullet arriving with `damage` and `penetration` before this hit's
    speed loss, plus a fifth value: (damage, penetration, speed ratio) of the bullet as it hit
    the body collider, for the outcomes where it got through to the body, else None."""
    first = degradation_factor(speed_ratio, armor_globals)
    damage = damage * first
    penetration = penetration * first
    plate_count = len(plates)

    if not plates:
        outcomes = []
        for p, durs, dealt, blocker, deflector in collider_hit(
            soft_layers, durabilities, damage, penetration, ammo, armor_globals, False, heavy_vest_skill, angle
        ):
            stop = _stopped_by(blocker, deflector)
            outcomes.append((p, durs, dealt, stop, (damage, penetration, speed_ratio) if stop is None else None))
        return outcomes
    if plate_collider is None:
        raise ValueError("a shot into a plate needs the plate collider values")

    plate_durabilities = durabilities[:plate_count]
    soft_durabilities = durabilities[plate_count:]
    # CF for the continuing bullet comes from the first plate as it was before this hit wore it
    first_plate = plates[0]

    outcomes = []
    for p, new_plates, plate_damage, blocker, deflector in collider_hit(
        plates, plate_durabilities, damage, penetration, ammo, armor_globals, True, heavy_vest_skill, angle
    ):
        _, _, cf = real_resistance(
            plate_durabilities[0], first_plate.max_durability, first_plate.armor_class, penetration, armor_globals
        )
        # A block, a ricochet or too little pen left to get through the collider ends the shot
        if blocker is not None or deflector is not None or penetration * cf <= plate_collider.penetration_level:
            stop = _stopped_by(blocker, deflector)
            outcomes.append(
                (p, [*new_plates, *soft_durabilities], plate_damage, plate_count - 1 if stop is None else stop, None)
            )
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

        for q, new_soft, body_damage, blocker, deflector in collider_hit(
            soft_layers,
            soft_durabilities,
            next_damage,
            next_penetration,
            ammo,
            armor_globals,
            False,
            heavy_vest_skill,
            angle,
        ):
            stop = _stopped_by(blocker, deflector)
            outcomes.append(
                (
                    p * q,
                    [*new_plates, *new_soft],
                    plate_damage + body_damage,
                    None if stop is None else plate_count + stop,
                    (next_damage, next_penetration, next_speed) if stop is None else None,
                )
            )
    return outcomes


def _stopped_by(blocker, deflector):
    return blocker if deflector is None else deflector


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
    step = _DURABILITY_STEP
    return tuple(0.0 if d <= 0 else max(round(round(d / step) * step, 6), step) for d in durabilities)


def _apply_hp_damage(hp_bins, dealt, branch, into):
    """Add the HP distribution after taking `dealt` damage (times `branch`) into `into`, and
    return the probability mass killed.

    Distributions are sparse {bin: probability}, bin i meaning exactly i * _HP_GRID_STEP HP
    left: each durability state only comes from a few hit sequences, so only a few bins are
    ever filled. A remaining HP between two bins is split between them, and anything still
    alive never lands in bin 0."""
    shift = dealt / _HP_GRID_STEP
    whole = int(shift)
    frac = shift - whole
    killed = 0.0
    if frac <= 0:
        for index, probability in hp_bins.items():
            # Bins at or below the damage dealt are kills
            if index <= whole:
                killed += probability * branch
            else:
                into[index - whole] += probability * branch
        return killed
    upper_share = branch * (1 - frac)
    lower_share = branch * frac
    for index, probability in hp_bins.items():
        if index <= whole:
            killed += probability * branch
            continue
        upper = index - whole
        into[upper] += probability * upper_share
        # Never let a live target land on 0 HP
        into[upper - 1 if upper > 1 else 1] += probability * lower_share
    return killed


def _merge_outcomes(outcomes):
    """Outcomes that lead to the same state with the same damage, added together."""
    merged = {}
    for probability, state, dealt in outcomes:
        key = (state, round(dealt, 9))
        merged[key] = merged.get(key, 0.0) + probability
    return [(probability, state, dealt) for (state, dealt), probability in merged.items()]


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
    angle=0.0,
    deadline=None,
):
    """Kill chance and armor wear after each of up to `max_shots` shots into the same spot.

    The target dies once the body part behind the armor reaches 0 HP (thorax or head).
    Buckshot fires `projectiles` pellets per shot, each its own bullet with its own
    penetration roll, hitting one after another; we assume every pellet lands on the spot.
    `angle` is how far off straight-on (in degrees) every shot comes in, for ricochets.
    With a `deadline` (a time.monotonic() value) we stop after the shot that passes it and
    mark the result truncated."""
    armor_globals = armor_globals or load_armor_globals()
    layers = [*plates, *soft_layers]
    samples = penetration_samples(ammo)

    # One HP distribution per durability state, since far fewer durability states exist
    # than HP values
    start = {}
    for value, share in _snap(hp, _HP_GRID_STEP):
        index = int(round(value / _HP_GRID_STEP))
        start[index] = start.get(index, 0.0) + share
    states = {tuple(layer.durability for layer in layers): start}
    killed = 0.0
    result = SimulationResult()

    # The same durability states come back shot after shot, so remember their outcomes
    cache = {}

    def outcomes_for(durabilities):
        """(merged outcomes, (stop chance per layer, penetration chance, penetration chance
        times the damage then)) for one bullet into `durabilities`."""
        entry = cache.get(durabilities)
        if entry is None:
            outcomes = []
            stops = [0.0] * len(layers)
            through = through_damage = 0.0
            for weight, shot_penetration in samples:
                for p, new_durabilities, dealt, stop in shot_outcomes(
                    ammo,
                    plates,
                    soft_layers,
                    list(durabilities),
                    shot_penetration,
                    armor_globals,
                    speed_ratio,
                    plate_collider,
                    heavy_vest_skill,
                    angle,
                ):
                    outcomes.append((weight * p, _durability_key(new_durabilities), dealt))
                    if stop is None:
                        through += weight * p
                        through_damage += weight * p * dealt
                    else:
                        stops[stop] += weight * p
            cache[durabilities] = entry = (_merge_outcomes(outcomes), (stops, through, through_damage))
        return entry

    for shot in range(1, max_shots + 1):
        # Sum what every bullet of this shot runs into, weighted by how likely each live state is
        faced = through = through_damage = 0.0
        stops = [0.0] * len(layers)
        for _ in range(projectiles):
            next_states = {}
            for durabilities, hp_bins in states.items():
                outcomes, (state_stops, state_through, state_damage) = outcomes_for(durabilities)
                mass = sum(hp_bins.values())
                faced += mass
                for i, chance in enumerate(state_stops):
                    stops[i] += mass * chance
                through += mass * state_through
                through_damage += mass * state_damage
                for branch, state, dealt in outcomes:
                    target = next_states.get(state)
                    if target is None:
                        target = next_states[state] = collections.defaultdict(float)
                    killed += _apply_hp_damage(hp_bins, dealt, branch, target)
            states = {d: h for d, h in next_states.items() if sum(h.values()) >= _MIN_STATE_PROBABILITY}

        masses = {durabilities: sum(h.values()) for durabilities, h in states.items()}
        alive = sum(masses.values())
        if alive > 0:
            durability_alive = [
                sum(mass * durabilities[i] for durabilities, mass in masses.items()) / alive for i in range(len(layers))
            ]
            hp_alive = (
                sum(index * probability for h in states.values() for index, probability in h.items())
                * _HP_GRID_STEP
                / alive
            )
        else:
            durability_alive, hp_alive = None, None
        result.shots.append(
            ShotResult(
                shot=shot,
                kill_chance=killed,
                durability_alive=durability_alive,
                hp_alive=hp_alive,
                stop_chance=[s / faced for s in stops] if faced > 0 else None,
                penetration_chance=through / faced if faced > 0 else None,
                penetration_damage=through_damage / through if through > 0 else None,
            )
        )
        if killed >= stop_at_kill_chance or not states:
            break
        if deadline is not None and time.monotonic() > deadline:
            result.truncated = True
            break
    return result


@dataclass(frozen=True)
class Spot:
    """One of the two spots a simulate_through bullet hits, with its armor as indexes into the
    run's shared layers (one piece can cover both spots, like a mandible over the neck and jaw)."""

    body_part: str
    hp: float  # the body part's HP when the run starts
    plates: tuple = ()
    soft_layers: tuple = ()
    plate_collider: PlateCollider | None = None
    # The body collider's own values, which decide whether the bullet goes on through it
    body_collider: PlateCollider | None = None
    angle: float = 0.0


@dataclass
class ThroughShotResult(ShotResult):
    # hp_alive and penetration_chance/damage are the entry spot's; these are the exit spot's.
    # pass_chance is the chance the bullet goes on through the entry into the exit spot.
    exit_hp_alive: float | None = None
    pass_chance: float | None = None
    exit_penetration_chance: float | None = None
    exit_penetration_damage: float | None = None


def pass_through(body_shot, soft_layers, soft_durabilities, collider, ammo, armor_globals):
    """(damage, penetration, speed ratio) the bullet carries on with after hitting a body
    collider as `body_shot`, before the next hit's own speed loss, or None if it stops there.

    The game checks penetration times CF of the first armor over the collider against the
    collider's level, then keeps a share of damage and pen set by how far past the level the
    bullet was, takes CF of that armor again and loses speed by the collider's penetration
    chance. Armor wear from this hit only lands after, so CF uses the durability before it."""
    damage, penetration, speed_ratio = body_shot
    armor = None
    if soft_layers:
        armor = (soft_durabilities[0], soft_layers[0].max_durability, soft_layers[0].armor_class)
    cf = 1.0 if armor is None else real_resistance(*armor, penetration, armor_globals)[2]
    if penetration * cf <= collider.penetration_level:
        return None
    keep = _clamp(
        (penetration - collider.penetration_level) / 100
        + collider.penetration_damage_mod
        + ammo.penetration_damage_mod,
        0.0,
        1.0,
    )
    next_penetration = penetration * keep
    cf = 1.0 if armor is None else real_resistance(*armor, next_penetration, armor_globals)[2]
    return (
        damage * keep * cf,
        next_penetration * cf,
        speed_ratio * _lerp(0.8, 1.0, collider.penetration_chance),
    )


_SPREAD_TIE = 1e-9
# Damage to a part whose loss doesn't kill sits on this coarser grid. It only reaches the head
# or thorax as spread, at most about a quarter of it (stomach into thorax), so it moves them
# no more than their own grid does; and two such parts kill only past a pool of 350 or more.
_SPREAD_GRID_STEP = 0.2


def _grid_step(body_part):
    return _HP_GRID_STEP if body_part in _LETHAL_PARTS else _SPREAD_GRID_STEP


def two_part_death(health, entry_part, entry_hp, exit_part, exit_hp, entry_damage, exit_damage):
    """Whether `entry_damage` into one body part and `exit_damage` into another kill a target
    with every other part at full health.

    We take the two as arriving together in proportion, and follow every part's HP through
    each part going down: a part at 0 spreads what it's hit with over the parts still alive
    the way spread_capacity has it, and the target dies once its head or thorax reaches 0."""
    parts = health["parts"]
    factors = health["over_damage_factor"]
    hp = {name: float(values["max"]) for name, values in parts.items()}
    hp[entry_part] = float(entry_hp)
    hp[exit_part] = float(exit_hp)
    direct = {entry_part: entry_damage, exit_part: exit_damage}
    progress = 0.0
    while True:
        rates = {name: 0.0 for name, left in hp.items() if left > 0}
        total_max = sum(parts[name]["max"] for name in rates)
        for name, damage in direct.items():
            if damage <= 0:
                continue
            if name in rates:
                rates[name] += damage
                continue
            for other in rates:
                share = factors[name] * parts[other]["over_damage_received"] * parts[other]["max"] / total_max
                rates[other] += damage * share
        going = {name: hp[name] / rate for name, rate in rates.items() if rate > 0}
        if not going:
            return False
        first = min(going, key=going.get)
        step = going[first]
        if progress + step > 1.0:
            return False
        progress += step
        for name, rate in rates.items():
            hp[name] -= rate * step
        hp[first] = 0.0
        # Parts spread over in proportion to their max HP all go down together, so anything
        # within rounding of 0 went down with the first one
        for name in rates:
            if hp[name] <= _SPREAD_TIE:
                hp[name] = 0.0
                if name in _LETHAL_PARTS:
                    return True


def _spread_damage(bins, entry_dealt, exit_dealt, steps, branch, into):
    """Add the 2D damage distribution after `entry_dealt` and `exit_dealt` more (times
    `branch`) into `into`. Bins are (i, j): i and j grid `steps` of damage dealt so far to the
    entry and exit parts, with damage between two grid points split between them."""
    entry_shift = entry_dealt / steps[0]
    exit_shift = exit_dealt / steps[1]
    entry_whole, exit_whole = int(entry_shift), int(exit_shift)
    entry_frac, exit_frac = entry_shift - entry_whole, exit_shift - exit_whole
    moves = [
        (di, dj, share_i * share_j)
        for di, share_i in ((entry_whole, 1 - entry_frac), (entry_whole + 1, entry_frac))
        for dj, share_j in ((exit_whole, 1 - exit_frac), (exit_whole + 1, exit_frac))
        if share_i * share_j > 0
    ]
    for (i, j), probability in bins.items():
        for di, dj, share in moves:
            into[(i + di, j + dj)] += probability * branch * share


def simulate_through(
    ammo,
    layers,
    entry_spot,
    exit_spot,
    armor_globals=None,
    health=None,
    speed_ratio=1.0,
    heavy_vest_skill=0.0,
    max_shots=50,
    stop_at_kill_chance=0.9999,
    projectiles=1,
    deadline=None,
):
    """simulate for shots into `entry_spot` whose bullets can go on through its body collider
    into `exit_spot`, on another body part, which then takes its own hit.

    `layers` is every armor layer the two spots use, and each Spot names its own by index,
    plates first as simulate wants them. A piece both spots use wears from both hits. The game
    gives no damage to a later hit on a body part the bullet already hit, so the two spots
    have to be on different parts. `health` defaults to the game's own."""
    armor_globals = armor_globals or load_armor_globals()
    health = health or armor_globals.health
    if entry_spot.body_part == exit_spot.body_part:
        raise ValueError("a bullet does no damage to the body part it already hit")
    if entry_spot.body_collider is None:
        raise ValueError("passing through needs the entry body collider values")
    samples = penetration_samples(ammo)
    entry_indexes = (*entry_spot.plates, *entry_spot.soft_layers)
    exit_indexes = (*exit_spot.plates, *exit_spot.soft_layers)
    entry_plates = [layers[i] for i in entry_spot.plates]
    entry_plate_count = len(entry_plates)
    entry_soft = [layers[i] for i in entry_spot.soft_layers]
    exit_plates = [layers[i] for i in exit_spot.plates]
    exit_soft = [layers[i] for i in exit_spot.soft_layers]

    # Each durability state holds a sparse 2D distribution of damage dealt to the two parts,
    # since spread damage ties them together and one HP pool can't stand for both
    steps = (_grid_step(entry_spot.body_part), _grid_step(exit_spot.body_part))
    states = {tuple(layer.durability for layer in layers): {(0, 0): 1.0}}
    killed = 0.0
    result = SimulationResult()
    cache = {}
    deaths = {}

    def dies(i, j):
        dead = deaths.get((i, j))
        if dead is None:
            dead = deaths[(i, j)] = two_part_death(
                health,
                entry_spot.body_part,
                entry_spot.hp,
                exit_spot.body_part,
                exit_spot.hp,
                i * steps[0],
                j * steps[1],
            )
        return dead

    def replaced(durabilities, indexes, values):
        out = list(durabilities)
        for index, value in zip(indexes, values):
            out[index] = value
        return out

    def outcomes_for(durabilities):
        """(merged outcomes, tallies) for one bullet into `durabilities`, the tallies being
        (stop chance per layer, entry penetration chance, times its damage, pass chance, exit
        penetration chance, times its damage)."""
        cached = cache.get(durabilities)
        if cached is not None:
            return cached
        outcomes = []
        stops = [0.0] * len(layers)
        through = through_damage = passed = exit_through = exit_damage = 0.0
        entry_durabilities = [durabilities[i] for i in entry_indexes]
        entry_soft_before = entry_durabilities[entry_plate_count:]
        for weight, shot_penetration in samples:
            for p, new_entry, dealt, stop, body_shot in _spot_outcomes(
                ammo,
                entry_plates,
                entry_soft,
                entry_durabilities,
                ammo.damage,
                shot_penetration,
                armor_globals,
                speed_ratio,
                entry_spot.plate_collider,
                heavy_vest_skill,
                entry_spot.angle,
            ):
                branch = weight * p
                worn = replaced(durabilities, entry_indexes, new_entry)
                if stop is not None:
                    stops[entry_indexes[stop]] += branch
                    outcomes.append((branch, _durability_key(worn), dealt, 0.0))
                    continue
                through += branch
                through_damage += branch * dealt
                child = pass_through(
                    body_shot, entry_soft, entry_soft_before, entry_spot.body_collider, ammo, armor_globals
                )
                if child is None:
                    outcomes.append((branch, _durability_key(worn), dealt, 0.0))
                    continue
                passed += branch
                for q, new_exit, exit_dealt, exit_stop, _ in _spot_outcomes(
                    ammo,
                    exit_plates,
                    exit_soft,
                    [worn[i] for i in exit_indexes],
                    child[0],
                    child[1],
                    armor_globals,
                    child[2],
                    exit_spot.plate_collider,
                    heavy_vest_skill,
                    exit_spot.angle,
                ):
                    if exit_stop is None:
                        exit_through += branch * q
                        exit_damage += branch * q * exit_dealt
                    else:
                        stops[exit_indexes[exit_stop]] += branch * q
                    state = _durability_key(replaced(worn, exit_indexes, new_exit))
                    outcomes.append((branch * q, state, dealt, exit_dealt))
        merged = {}
        for probability, state, dealt, exit_dealt in outcomes:
            key = (state, round(dealt, 9), round(exit_dealt, 9))
            merged[key] = merged.get(key, 0.0) + probability
        cached = cache[durabilities] = (
            [(probability, state, dealt, exit_dealt) for (state, dealt, exit_dealt), probability in merged.items()],
            (stops, through, through_damage, passed, exit_through, exit_damage),
        )
        return cached

    for shot in range(1, max_shots + 1):
        faced = through = through_damage = passed = exit_through = exit_damage = 0.0
        stops = [0.0] * len(layers)
        for _ in range(projectiles):
            next_states = {}
            for durabilities, bins in states.items():
                # One shot here can take far longer than the whole budget, so past the deadline
                # we drop the shot we're on and keep the ones already done
                if deadline is not None and result.shots and time.monotonic() > deadline:
                    result.truncated = True
                    return result
                outcomes, tallies = outcomes_for(durabilities)
                state_stops, state_through, state_damage, state_passed, state_exit, state_exit_damage = tallies
                mass = sum(bins.values())
                faced += mass
                for i, chance in enumerate(state_stops):
                    stops[i] += mass * chance
                through += mass * state_through
                through_damage += mass * state_damage
                passed += mass * state_passed
                exit_through += mass * state_exit
                exit_damage += mass * state_exit_damage
                for branch, state, dealt, exit_dealt in outcomes:
                    target = next_states.get(state)
                    if target is None:
                        target = next_states[state] = collections.defaultdict(float)
                    _spread_damage(bins, dealt, exit_dealt, steps, branch, target)
            states = {}
            for durabilities, bins in next_states.items():
                alive_bins = {}
                for cell, probability in bins.items():
                    if dies(*cell):
                        killed += probability
                    else:
                        alive_bins[cell] = probability
                if sum(alive_bins.values()) >= _MIN_STATE_PROBABILITY:
                    states[durabilities] = alive_bins

        masses = {durabilities: sum(bins.values()) for durabilities, bins in states.items()}
        alive = sum(masses.values())
        exit_hp_alive = None
        if alive > 0:
            durability_alive = [
                sum(mass * durabilities[i] for durabilities, mass in masses.items()) / alive for i in range(len(layers))
            ]
            # HP each of the two parts has left after its direct hits, 0 once it's down
            cells = [(cell, probability) for bins in states.values() for cell, probability in bins.items()]
            hp_alive = sum(p * max(0.0, entry_spot.hp - i * steps[0]) for (i, _), p in cells) / alive
            exit_hp_alive = sum(p * max(0.0, exit_spot.hp - j * steps[1]) for (_, j), p in cells) / alive
        else:
            durability_alive, hp_alive = None, None
        result.shots.append(
            ThroughShotResult(
                shot=shot,
                kill_chance=killed,
                durability_alive=durability_alive,
                hp_alive=hp_alive,
                stop_chance=[s / faced for s in stops] if faced > 0 else None,
                penetration_chance=through / faced if faced > 0 else None,
                penetration_damage=through_damage / through if through > 0 else None,
                exit_hp_alive=exit_hp_alive,
                pass_chance=passed / faced if faced > 0 else None,
                exit_penetration_chance=exit_through / faced if faced > 0 else None,
                exit_penetration_damage=exit_damage / exit_through if exit_through > 0 else None,
            )
        )
        if killed >= stop_at_kill_chance or not states:
            break
        if deadline is not None and time.monotonic() > deadline:
            result.truncated = True
            break
    return result
