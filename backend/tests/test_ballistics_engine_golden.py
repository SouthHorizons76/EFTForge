"""Keep the browser's copy of the ballistics engine in step with ballistics.py.

frontend/modules/ballistics-engine.js is a by-hand port of ballistics.py. The golden file
holds what this engine answers for a spread of setups, and frontend/tests/ballistics-engine.test.js
checks the port against it. This test checks the file still matches the engine, so changing
ballistics.py fails here until the file is rewritten, and then fails on the frontend until the
port follows. Rewrite it with:
    python tests/test_ballistics_engine_golden.py
"""

import dataclasses
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ballistics  # noqa: E402

GOLDEN = os.path.join(os.path.dirname(__file__), "data", "ballistics_engine_golden.json")
_MC = os.path.join(os.path.dirname(__file__), "data", "ballistics_golden.json")


def _layer(**values):
    return ballistics.ArmorLayer(**values)


def _cases():
    """(name, ammo, hp, simulate options) covering every branch the engine has."""
    with open(_MC, encoding="utf-8") as f:
        reference = json.load(f)["cases"]
    cases = []
    for case in reference:
        collider = case["plate_collider"]
        cases.append(
            (
                case["name"],
                case["ammo"],
                case["hp"],
                {
                    "plates": case["plates"],
                    "soft_layers": case["soft_layers"],
                    "plate_collider": collider,
                    "speed_ratio": case["speed_ratio"],
                    "heavy_vest_skill": case["heavy_vest_skill"],
                },
            )
        )
    plate = dict(
        armor_class=5,
        max_durability=55,
        durability=55,
        material="Ceramic",
        blunt_throughput=0.3,
        armor_type="Heavy",
        blunt_reduce_from_soft_armor=True,
        ricochet_x=0.3,
        ricochet_y=0.1,
        ricochet_z=45,
    )
    soft = dict(
        armor_class=3, max_durability=50, durability=42.5, material="Aramid", blunt_throughput=0.3, armor_type="Light"
    )
    helmet = dict(
        armor_class=4,
        max_durability=30,
        durability=30,
        material="Combined",
        blunt_throughput=0.2,
        armor_type="Light",
        ricochet_x=0.8,
        ricochet_y=0.4,
        ricochet_z=30,
    )
    collider = {"penetration_level": 10.0, "penetration_chance": 0.5, "penetration_damage_mod": 0.2}
    m855a1 = {"damage": 49, "penetration": 44, "armor_damage": 52, "penetration_deviation": 1.5}
    cases += [
        (
            "ricochet_plate_and_soft_at_angle",
            m855a1,
            85,
            {"plates": [plate], "soft_layers": [soft], "plate_collider": collider, "angle": 60, "max_shots": 20},
        ),
        (
            "ricochet_helmet",
            {"damage": 54, "penetration": 37, "armor_damage": 44},
            35,
            {"soft_layers": [helmet], "angle": 50},
        ),
        (
            "buckshot_into_soft",
            {"damage": 37, "penetration": 5, "armor_damage": 26, "penetration_deviation": 0.5},
            85,
            {"soft_layers": [soft], "projectiles": 8, "max_shots": 6},
        ),
        (
            "stomach_with_spread_and_range",
            {"damage": 62, "penetration": 30, "armor_damage": 40, "penetration_damage_mod": -0.1},
            70 + 102.3,
            {"soft_layers": [soft], "speed_ratio": 0.83, "heavy_vest_skill": 0.4},
        ),
        ("no_armor", {"damage": 40.5, "penetration": 20, "armor_damage": 30}, 60.7, {}),
    ]
    return cases


def _shots(ammo, hp, options):
    layered = {"max_shots": 30, **options}
    for key in ("plates", "soft_layers"):
        layered[key] = [_layer(**layer) for layer in options.get(key, [])]
    if options.get("plate_collider"):
        layered["plate_collider"] = ballistics.PlateCollider(**options["plate_collider"])
    result = ballistics.simulate(ballistics.Ammo(**ammo), hp, armor_globals=ballistics.load_armor_globals(), **layered)
    return [dataclasses.asdict(shot) for shot in result.shots]


def _through_cases():
    """(name, ammo, simulate_through options) for bullets going on through one body part into
    another. Spots name their armor by index into "layers", and their body collider by name."""
    bare = {"armor_class": 3, "max_durability": 50, "durability": 50, "material": "Aramid", "blunt_throughput": 0.3}
    worn = {**bare, "durability": 31.5}
    plate = {
        "armor_class": 4,
        "max_durability": 45,
        "durability": 45,
        "material": "Ceramic",
        "blunt_throughput": 0.3,
        "armor_type": "Heavy",
        "blunt_reduce_from_soft_armor": True,
    }
    mandible = {
        "armor_class": 4,
        "max_durability": 30,
        "durability": 30,
        "material": "Combined",
        "blunt_throughput": 0.2,
        "ricochet_x": 0.6,
        "ricochet_y": 0.3,
        "ricochet_z": 35,
    }
    helmet = {**mandible, "max_durability": 40, "durability": 36, "material": "Aramid", "ricochet_z": 25}
    chest_plate = {"penetration_level": 0.0, "penetration_chance": 1.0, "penetration_damage_mod": 1.0}
    m855a1 = {"damage": 49, "penetration": 44, "armor_damage": 52, "penetration_deviation": 1.5}
    return [
        (
            "bare_arm_into_bare_thorax",
            {**m855a1, "penetration_damage_mod": 0.15},
            {
                "layers": [],
                "entry": {"body_part": "LeftArm", "hp": 60, "body_collider": "LeftUpperArm"},
                "exit": {"body_part": "Chest", "hp": 85},
            },
        ),
        (
            "armored_forearm_into_stomach_at_range",
            {"damage": 56, "penetration": 28, "armor_damage": 40, "penetration_deviation": 1.0},
            {
                "layers": [worn, bare],
                "entry": {"body_part": "RightArm", "hp": 41.5, "soft_layers": [0], "body_collider": "RightForearm"},
                "exit": {"body_part": "Stomach", "hp": 70, "soft_layers": [1], "angle": 40},
                "speed_ratio": 0.8,
                "heavy_vest_skill": 0.2,
                # Two parts that don't kill take many shots; these cover every branch already
                "max_shots": 8,
            },
        ),
        (
            "neck_into_jaw_through_one_mandible",
            {"damage": 53, "penetration": 58, "armor_damage": 60, "penetration_deviation": 1.2},
            {
                "layers": [mandible, helmet],
                "entry": {
                    "body_part": "Chest",
                    "hp": 85,
                    "soft_layers": [0],
                    "body_collider": "NeckFront",
                    "angle": 50,
                },
                "exit": {"body_part": "Head", "hp": 35, "soft_layers": [1, 0]},
            },
        ),
        (
            "calf_into_other_leg_buckshot",
            {"damage": 37, "penetration": 8, "armor_damage": 26, "penetration_deviation": 0.5},
            {
                "layers": [],
                "entry": {"body_part": "LeftLeg", "hp": 65, "body_collider": "LeftCalf"},
                "exit": {"body_part": "RightLeg", "hp": 65},
                "projectiles": 8,
                "max_shots": 4,
            },
        ),
        (
            "arm_into_plated_thorax",
            {"damage": 50, "penetration": 52, "armor_damage": 45, "penetration_deviation": 1.0},
            {
                "layers": [plate, bare],
                "entry": {"body_part": "LeftArm", "hp": 60, "body_collider": "LeftUpperArm"},
                "exit": {
                    "body_part": "Chest",
                    "hp": 85,
                    "plates": [0],
                    "soft_layers": [1],
                    "plate_collider": chest_plate,
                },
            },
        ),
    ]


def _spot(values, armor_globals):
    values = dict(values)
    for key in ("plates", "soft_layers"):
        values[key] = tuple(values.get(key, ()))
    if values.get("plate_collider"):
        values["plate_collider"] = ballistics.PlateCollider(**values["plate_collider"])
    if values.get("body_collider"):
        values["body_collider"] = ballistics.PlateCollider(**armor_globals.body_colliders[values["body_collider"]])
    return ballistics.Spot(**values)


def _through_shots(ammo, options, armor_globals):
    run = {"max_shots": 30, **options}
    layers = [_layer(**layer) for layer in run.pop("layers")]
    entry = _spot(run.pop("entry"), armor_globals)
    exit_spot = _spot(run.pop("exit"), armor_globals)
    result = ballistics.simulate_through(
        ballistics.Ammo(**ammo), layers, entry, exit_spot, armor_globals=armor_globals, **run
    )
    return [dataclasses.asdict(shot) for shot in result.shots]


def _death_vectors(armor_globals):
    """[entry part, entry hp, exit part, exit hp, entry damage, exit damage, dies] on both sides
    of the boundary for each kind of pair."""
    rows = []
    for entry, entry_hp, exit_part, exit_hp, damages in [
        ("LeftArm", 60, "Chest", 85, [(100, 80.6), (100, 80.7), (835.5, 0), (835.52, 0)]),
        ("RightLeg", 65, "LeftLeg", 65, [(300, 300), (350, 330), (600, 100)]),
        ("LeftArm", 42, "Stomach", 70, [(42, 69.9), (200, 200), (400, 250)]),
        ("Chest", 85, "Head", 35, [(84.9, 34.9), (85, 0), (0, 35)]),
        ("Head", 35, "Chest", 85, [(34.99, 84.99), (20, 85)]),
        ("RightArm", 60, "Head", 35, [(60, 34.9), (120, 30), (200, 30)]),
    ]:
        for entry_damage, exit_damage in damages:
            dies = ballistics.two_part_death(
                armor_globals.health, entry, entry_hp, exit_part, exit_hp, entry_damage, exit_damage
            )
            rows.append([entry, entry_hp, exit_part, exit_hp, entry_damage, exit_damage, dies])
    return rows


def build():
    armor_globals = ballistics.load_armor_globals()
    golden = {
        "simulate": [],
        "simulate_through": [],
        "two_part_death": _death_vectors(armor_globals),
        "spread_capacity": {},
        "flight": [],
        "zeroing": [],
        "degradation": [],
    }
    for name, ammo, hp, options in _cases():
        golden["simulate"].append(
            {"name": name, "ammo": ammo, "hp": hp, "options": options, "shots": _shots(ammo, hp, options)}
        )
    for name, ammo, options in _through_cases():
        golden["simulate_through"].append(
            {"name": name, "ammo": ammo, "options": options, "shots": _through_shots(ammo, options, armor_globals)}
        )
    for part in armor_globals.health["parts"]:
        golden["spread_capacity"][part] = ballistics.spread_capacity(part, armor_globals.health)
    shots = [(940, 4.0, 5.7, 0.31), (315, 15.2, 9.0, 0.15), (880, 3.4, 5.6, 0.264), (415, 1.94, 18.5, 0.08)]
    for shot in shots:
        path = ballistics.flight_path(*shot, 600)
        golden["flight"].append(
            {"shot": shot, "max_distance": 600, "points": [dataclasses.asdict(point) for point in path[::25]]}
        )
    distances = [0, 25, 50, 100, 150, 200, 300, 400, 500, 600]
    for shot, zero_shot, zero in [(shots[0], shots[0], 100), (shots[2], shots[0], 200), (shots[1], shots[1], 50)]:
        rows = ballistics.zeroing_table(shot, zero_shot, zero, 0.05, distances)
        golden["zeroing"].append(
            {
                "shot": shot,
                "zero_shot": zero_shot,
                "zero_distance": zero,
                "sight_height": 0.05,
                "distances": distances,
                "rows": [dataclasses.asdict(row) for row in rows],
            }
        )
    for ratio in (0.0, 0.35, 0.8, 1.0, 1.4):
        golden["degradation"].append([ratio, ballistics.degradation_factor(ratio, armor_globals)])
    return golden


def _close(expected, actual, path="golden"):
    if isinstance(expected, dict):
        assert expected.keys() == actual.keys(), path
        for key in expected:
            _close(expected[key], actual[key], f"{path}.{key}")
    elif isinstance(expected, (list, tuple)):
        assert len(expected) == len(actual), path
        for i, (e, a) in enumerate(zip(expected, actual)):
            _close(e, a, f"{path}[{i}]")
    elif isinstance(expected, float) or isinstance(actual, float):
        assert math.isclose(expected, actual, rel_tol=1e-9, abs_tol=1e-12), f"{path}: {expected} != {actual}"
    else:
        assert expected == actual, f"{path}: {expected} != {actual}"


def test_golden_file_matches_the_engine():
    with open(GOLDEN, encoding="utf-8") as f:
        stored = json.load(f)
    _close(json.loads(json.dumps(build())), stored)


if __name__ == "__main__":
    with open(GOLDEN, "w", encoding="utf-8") as f:
        json.dump(build(), f, indent=1)
        f.write("\n")
    print("Wrote", GOLDEN)
