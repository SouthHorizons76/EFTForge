/* ============================================================
   BALLISTICS ENGINE
   backend/ballistics.py ported line for line, plus the requests the Ballistics Workbench
   makes of it (an armor simulation, a caliber comparison, a drop table), so its results
   are worked out on the player's own machine. The server only hands over the data.

   Keep it in step with ballistics.py by hand: backend/tests/data/ballistics_engine_golden.json
   holds the Python engine's own answers, and tests/ballistics-engine.test.js checks ours
   against them, so a change on one side only fails a test until the other side follows.
   The requests live only here, so tests/ballistics-requests.test.js covers them.

   This one file is also its own Web Worker. On the page it puts EFTForge.ballisticsLocal
   in place, which starts a worker from this same script (so it keeps its ?v= hash) and
   hands it the armor and ammo data; the worker runs the engine without freezing the page.
============================================================ */

(function () {

    /* ===========================
       ENGINE (ballistics.py)
    =========================== */

    // A shot's penetration is mean + deviation * u, with u uniform within one of six
    // equal-width bins spanning [-1, 1], picked with these weights.
    const PEN_DEVIATION_BIN_WEIGHTS = [0.021, 0.136, 0.341, 0.341, 0.136, 0.025];
    const PEN_SAMPLES_PER_BIN = 1;

    const HP_GRID_STEP = 0.05;
    const DURABILITY_STEP = 0.1;
    const MIN_STATE_PROBABILITY = 1e-12;
    const LETHAL_PARTS = ['Head', 'Chest'];

    // Python's round(): halves go to the even neighbor, which merging states depends on
    function pyRound(value, digits) {
        const scale = Math.pow(10, digits || 0);
        const scaled = value * scale;
        let rounded = Math.round(scaled);
        if (Math.abs(scaled % 1) === 0.5 && rounded % 2 !== 0) rounded -= 1;
        return rounded / scale;
    }

    // Python's float a // b, which can land one below Math.floor(a / b)
    function pyFloorDiv(a, b) {
        const mod = a % b;
        let div = (a - mod) / b;
        if (mod && ((b < 0) !== (mod < 0))) div -= 1;
        let floorDiv = Math.floor(div);
        if (div - floorDiv > 0.5) floorDiv += 1;
        return floorDiv;
    }

    function clamp(value, low, high) {
        return Math.min(Math.max(value, low), high);
    }

    function lerp(a, b, t) {
        return a + (b - a) * clamp(t, 0, 1);
    }

    // ArmorGlobals from the "globals" half of spt_armor_stats.json (GET /armor/constants)
    function loadArmorGlobals(data) {
        const destructibility = {};
        Object.keys(data.materials).forEach(function (name) { destructibility[name] = data.materials[name].destructibility; });
        return {
            class_resistance: data.class_resistance,
            destructibility: destructibility,
            blunt_damage_reduce_from_soft_armor_mod: data.blunt_damage_reduce_from_soft_armor_mod,
            damage_degradation_coefficient: data.damage_degradation_coefficient,
            health: data.health || {},
        };
    }

    // Damage a target can take past `bodyPart` reaching 0 before its head or thorax does
    function spreadCapacity(bodyPart, health) {
        if (LETHAL_PARTS.indexOf(bodyPart) !== -1) return 0;
        const parts = health.parts;
        const factor = health.over_damage_factor[bodyPart];
        const alive = new Map();
        Object.keys(parts).forEach(function (name) { if (name !== bodyPart) alive.set(name, Number(parts[name].max)); });
        let absorbed = 0;
        while (alive.size) {
            let totalMax = 0;
            alive.forEach(function (_, name) { totalMax += parts[name].max; });
            const rate = function (name) { return factor * parts[name].over_damage_received * parts[name].max / totalMax; };
            // Overflow it takes to bring each live part to 0 at the current spread rates
            let first = null;
            let step = Infinity;
            alive.forEach(function (hp, name) {
                const toZero = hp / rate(name);
                if (toZero < step) { step = toZero; first = name; }
            });
            absorbed += step;
            if (LETHAL_PARTS.indexOf(first) !== -1) return absorbed;
            alive.forEach(function (hp, name) { alive.set(name, hp - step * rate(name)); });
            alive.delete(first);
        }
        return absorbed;
    }

    // [real resistance, class resistance, CF] for one armor piece against one bullet
    function realResistance(durability, maxDurability, armorClass, penetration, armorGlobals) {
        const classResistance = armorGlobals.class_resistance[armorClass];
        const durabilityPercent = durability / maxDurability * 100;
        const real = (121 - 5000 / (durabilityPercent * 2 + 45)) * classResistance * 0.01;
        const cf = Math.min(Math.max(penetration / (real + 12), 0.6), 1.0);
        return [real, classResistance, cf];
    }

    function penetrationChance(real, penetration) {
        if (real >= penetration + 15) return 0;
        if (real < penetration) {
            if (real > penetration - 15) return (penetration / (real * 0.9 - penetration) + 100) / 100;
            return 1;
        }
        return 0.4 * Math.pow(real - penetration - 15, 2) / 100;
    }

    // Bullet flight: the G1 drag table (Mach number, drag coefficient)
    const G1_DRAG = [
        [0.0, 0.2629], [0.05, 0.2558], [0.1, 0.2487], [0.15, 0.2413], [0.2, 0.2344], [0.25, 0.2278],
        [0.3, 0.2214], [0.35, 0.2155], [0.4, 0.2104], [0.45, 0.2061], [0.5, 0.2032], [0.55, 0.202],
        [0.6, 0.2034], [0.7, 0.2165], [0.725, 0.223], [0.75, 0.2313], [0.775, 0.2417], [0.8, 0.2546],
        [0.825, 0.2706], [0.85, 0.2901], [0.875, 0.3136], [0.9, 0.3415], [0.925, 0.3734], [0.95, 0.4084],
        [0.975, 0.4448], [1, 0.4805], [1.025, 0.5136], [1.05, 0.5427], [1.075, 0.5677], [1.1, 0.5883],
        [1.125, 0.6053], [1.15, 0.6191], [1.2, 0.6393], [1.25, 0.6518], [1.3, 0.6589], [1.35, 0.6621],
        [1.4, 0.6625], [1.45, 0.6607], [1.5, 0.6573], [1.55, 0.6528], [1.6, 0.6474], [1.65, 0.6413],
        [1.7, 0.6347], [1.75, 0.628], [1.8, 0.621], [1.85, 0.6141], [1.9, 0.6072], [1.95, 0.6003],
        [2, 0.5934], [2.05, 0.5867], [2.1, 0.5804], [2.15, 0.5743], [2.2, 0.5685], [2.25, 0.563],
        [2.3, 0.5577], [2.35, 0.5527], [2.4, 0.5481], [2.45, 0.5438], [2.5, 0.5397], [2.6, 0.5325],
        [2.7, 0.5264], [2.8, 0.5211], [2.9, 0.5168], [3, 0.5133], [3.1, 0.5105], [3.2, 0.5084],
        [3.3, 0.5067], [3.4, 0.5054], [3.5, 0.504], [3.6, 0.503], [3.7, 0.5022], [3.8, 0.5016],
        [3.9, 0.501], [4, 0.5006], [4.2, 0.4998], [4.4, 0.4995], [4.6, 0.4992], [4.8, 0.499],
        [5, 0.4988],
    ];
    const SPEED_OF_SOUND = 343.0;
    const GRAVITY = 9.81;
    const FLIGHT_STEP = 0.01;
    const MAX_FLIGHT_TIME = 13.0;

    // The row is picked as if rows were 0.05 Mach apart, which they aren't past Mach 0.6,
    // and interpolated from the row before it. That's what matches the game's trajectories.
    function g1Drag(speed) {
        const index = Math.floor(speed / SPEED_OF_SOUND / 0.05);
        if (index <= 0) return 0;
        if (index > G1_DRAG.length - 1) return G1_DRAG[G1_DRAG.length - 1][1];
        const lowSpeed = G1_DRAG[index - 1][0] * SPEED_OF_SOUND;
        const highSpeed = G1_DRAG[index][0] * SPEED_OF_SOUND;
        const lowDrag = G1_DRAG[index - 1][1];
        return (G1_DRAG[index][1] - lowDrag) / (highSpeed - lowSpeed) * (speed - lowSpeed) + lowDrag;
    }

    function muzzleSpeed(initialSpeed, velocityModifierPct) {
        return initialSpeed * (1 + (velocityModifierPct || 0) / 100);
    }

    // [{time, distance, drop, speed}] every 0.01 s for a level shot, until it passes maxDistance
    function flightPath(speed, bulletMassGrams, bulletDiameterMm, ballisticCoefficient, maxDistance) {
        const mass = bulletMassGrams / 1000;
        const diameter = bulletDiameterMm / 1000;
        const form = mass * 0.0014223 / (diameter * diameter * ballisticCoefficient);
        const slowdown = 1.2 * diameter * diameter * Math.PI / 4;

        let vx = speed, vy = 0, x = 0, y = 0, time = 0;
        const points = [{ time: time, distance: x, drop: 0, speed: speed }];
        while (x < maxDistance && time < MAX_FLIGHT_TIME) {
            const magnitude = Math.hypot(vx, vy);
            if (magnitude <= 0) break;
            const drag = slowdown * -(g1Drag(magnitude) * form) * magnitude * magnitude / (mass * 2);
            const ax = drag * vx / magnitude;
            const ay = drag * vy / magnitude - GRAVITY;
            x = x + vx * FLIGHT_STEP + 5e-05 * ax;
            y = y + vy * FLIGHT_STEP + 5e-05 * ay;
            vx = vx + ax * FLIGHT_STEP;
            vy = vy + ay * FLIGHT_STEP;
            time += FLIGHT_STEP;
            points.push({ time: time, distance: x, drop: -y, speed: Math.hypot(vx, vy) });
        }
        return points;
    }

    // The point the bullet hits with at `distance`, or null if it never gets there. The speed
    // is that of the step it's in, not a blend; time and drop are interpolated.
    function arrival(points, distance) {
        for (let i = 0; i + 1 < points.length; i++) {
            const before = points[i], after = points[i + 1];
            if (after.distance >= distance) {
                const share = (distance - before.distance) / (after.distance - before.distance);
                return {
                    time: before.time + (after.time - before.time) * share,
                    distance: distance,
                    drop: before.drop + (after.drop - before.drop) * share,
                    speed: before.speed,
                };
            }
        }
        return null;
    }

    // [{distance, impact, correction_mrad, speed, time}] for `shot` out of a weapon zeroed at
    // zeroDistance with `zeroShot`. Shots are [muzzle speed, mass g, diameter mm, BC].
    function zeroingTable(shot, zeroShot, zeroDistance, sightHeight, distances) {
        const reach = Math.max(Math.max.apply(null, distances), zeroDistance);
        const zeroHit = arrival(flightPath(zeroShot[0], zeroShot[1], zeroShot[2], zeroShot[3], zeroDistance), zeroDistance);
        if (zeroHit === null) return null;
        // Barrel slope that brings the zeroing round up to the sight line at the zero distance
        const slope = (sightHeight + zeroHit.drop) / zeroDistance;
        const path = flightPath(shot[0], shot[1], shot[2], shot[3], reach);
        const rows = [];
        for (let i = 0; i < distances.length; i++) {
            const distance = distances[i];
            if (distance <= 0) {
                rows.push({ distance: 0, impact: -sightHeight, correction_mrad: 0, speed: shot[0], time: 0 });
                continue;
            }
            const hit = arrival(path, distance);
            if (hit === null) break;
            const impact = -hit.drop + slope * distance - sightHeight;
            rows.push({ distance: distance, impact: impact, correction_mrad: -impact / distance * 1000, speed: hit.speed, time: hit.time });
        }
        return rows;
    }

    function degradationFactor(speedRatio, armorGlobals) {
        const ratio = clamp(speedRatio, 0, 1);
        return ratio + (1 - ratio) * clamp(armorGlobals.damage_degradation_coefficient, 0, 1);
    }

    // [[probability, penetration]] covering the game's spread of shot penetration
    function penetrationSamples(ammo) {
        if (!ammo.penetration_deviation) return [[1, Number(ammo.penetration)]];
        const samples = [];
        const width = 2 / PEN_DEVIATION_BIN_WEIGHTS.length;
        const step = width / PEN_SAMPLES_PER_BIN;
        PEN_DEVIATION_BIN_WEIGHTS.forEach(function (weight, index) {
            const low = -1 + index * width;
            for (let sample = 0; sample < PEN_SAMPLES_PER_BIN; sample++) {
                const u = low + (sample + 0.5) * step;
                samples.push([weight / PEN_SAMPLES_PER_BIN, ammo.penetration + ammo.penetration_deviation * u]);
            }
        });
        return samples;
    }

    // Chance a layer ricochets a shot coming in `angle` degrees off straight-on
    function deflectChance(layer, angle) {
        const x = layer.ricochet_x || 0, y = layer.ricochet_y || 0, z = layer.ricochet_z || 0;
        if (x <= 0 || angle <= z || z >= 90) return 0;
        const t = clamp((angle - 90) / (z - 90), 0, 1);
        return x + (y - x) * t;
    }

    // Every outcome of one bullet hitting one collider covered by `layers`, in the game's
    // check order: [[probability, new durabilities, body damage, blocker index, deflector index]]
    function colliderHit(layers, durabilities, damage, penetration, ammo, armorGlobals, isPlate, heavyVestSkill, angle) {
        const chances = layers.map(function (layer, i) {
            if (durabilities[i] <= 0) return null;
            const real = realResistance(durabilities[i], layer.max_durability, layer.armor_class, penetration, armorGlobals)[0];
            return penetrationChance(real, penetration);
        });
        const deflects = layers.map(function (layer) { return deflectChance(layer, angle); });
        const outcomes = [];

        function settle(probability, blocker, deflector) {
            if (probability <= 0) return;
            const applied = applyLayers(layers, durabilities, damage, penetration, ammo, armorGlobals, isPlate, heavyVestSkill, blocker, deflector);
            outcomes.push([probability, applied[0], applied[1], blocker, deflector]);
        }

        function walk(index, probability, blocker) {
            if (probability <= 0) return;
            if (index === layers.length) { settle(probability, blocker, null); return; }
            const deflect = deflects[index];
            if (deflect > 0) settle(probability * deflect, blocker, index);
            const rest = probability * (1 - deflect);
            if (blocker === null && chances[index] !== null) {
                walk(index + 1, rest * (1 - chances[index]), index);
                walk(index + 1, rest * chances[index], null);
            } else {
                walk(index + 1, rest, blocker);
            }
        }

        walk(0, 1, null);
        return outcomes;
    }

    // Run the bullet through each layer once the rolls have settled which one (if any)
    // blocks or deflects it: [new durabilities, damage to the body part]
    function applyLayers(layers, durabilities, damage, penetration, ammo, armorGlobals, isPlate, heavyVestSkill, blocker, deflector) {
        let armorDamage = ammo.armor_damage / 100;
        const next = durabilities.slice();
        let stopped = false;
        for (let index = 0; index < layers.length; index++) {
            const layer = layers[index];
            let throughput = layer.blunt_throughput;
            if (layer.armor_type === 'Heavy') throughput *= 1 - heavyVestSkill;
            if (stopped) {
                // Layers behind the one that stopped the bullet only soften the blunt damage
                damage *= throughput;
                continue;
            }
            const durability = next[index];
            if (durability <= 0) {
                // A broken layer does nothing to the bullet, though it can still have deflected it
                stopped = index === deflector;
                continue;
            }
            if (deflector !== null) {
                // Each layer the deflected bullet reaches halves it again
                damage /= 2;
                armorDamage /= 2;
                penetration /= 2;
            }
            if (layer.blunt_reduce_from_soft_armor) throughput *= armorGlobals.blunt_damage_reduce_from_soft_armor_mod;

            const entryPenetration = penetration;
            const resistance = realResistance(durability, layer.max_durability, layer.armor_class, entryPenetration, armorGlobals);
            const real = resistance[0], classResistance = resistance[1], cf = resistance[2];
            const destructibility = armorGlobals.destructibility[layer.material];
            let loss;
            if (index === blocker || index === deflector) {
                loss = penetration * armorDamage * Math.min(Math.max(entryPenetration / classResistance, 0.6), 1.1) * destructibility;
                damage *= throughput * Math.min(Math.max(1 - 0.03 * (real - entryPenetration), 0.2), 1.0);
                stopped = true;
            } else {
                // A plate hit itself hurts nothing once it's penetrated; the body hit behind it does
                if (isPlate) damage = 0;
                damage *= cf;
                penetration *= cf;
                loss = penetration * armorDamage * Math.min(Math.max(entryPenetration / classResistance, 0.5), 0.9) * destructibility;
            }
            next[index] = Math.max(0, durability - Math.max(1, loss));
        }
        return [next, damage];
    }

    // Every outcome of one shot: [[probability, new durabilities, total body damage, index of the
    // layer that stopped the bullet or null if it reached the body]], the durabilities covering
    // the plates first, then the soft layers. A bullet the plate collider stops counts as
    // stopped by the last plate.
    function shotOutcomes(ammo, plates, softLayers, durabilities, shotPenetration, armorGlobals, speedRatio, plateCollider, heavyVestSkill, angle) {
        const first = degradationFactor(speedRatio, armorGlobals);
        const damage = ammo.damage * first;
        const penetration = shotPenetration * first;

        if (!plates.length) {
            return colliderHit(softLayers, durabilities, damage, penetration, ammo, armorGlobals, false, heavyVestSkill, angle)
                .map(function (o) { return [o[0], o[1], o[2], stoppedBy(o[3], o[4])]; });
        }
        if (!plateCollider) throw new Error('a shot into a plate needs the plate collider values');

        const plateDurabilities = durabilities.slice(0, plates.length);
        const softDurabilities = durabilities.slice(plates.length);
        // CF for the continuing bullet comes from the first plate as it was before this hit wore it
        const firstPlate = plates[0];
        const outcomes = [];
        colliderHit(plates, plateDurabilities, damage, penetration, ammo, armorGlobals, true, heavyVestSkill, angle).forEach(function (hit) {
            const p = hit[0], newPlates = hit[1], plateDamage = hit[2], blocker = hit[3], deflector = hit[4];
            let cf = realResistance(plateDurabilities[0], firstPlate.max_durability, firstPlate.armor_class, penetration, armorGlobals)[2];
            // A block, a ricochet or too little pen left to get through the collider ends the shot
            if (blocker !== null || deflector !== null || penetration * cf <= plateCollider.penetration_level) {
                const stop = stoppedBy(blocker, deflector);
                outcomes.push([p, newPlates.concat(softDurabilities), plateDamage, stop === null ? plates.length - 1 : stop]);
                return;
            }
            const keep = clamp(
                (penetration - plateCollider.penetration_level) / 100 + plateCollider.penetration_damage_mod + ammo.penetration_damage_mod,
                0, 1
            );
            let nextPenetration = penetration * keep;
            cf = realResistance(plateDurabilities[0], firstPlate.max_durability, firstPlate.armor_class, nextPenetration, armorGlobals)[2];
            const nextSpeed = speedRatio * lerp(0.8, 1.0, plateCollider.penetration_chance);
            const second = degradationFactor(nextSpeed, armorGlobals);
            const nextDamage = damage * keep * cf * second;
            nextPenetration *= cf * second;
            colliderHit(softLayers, softDurabilities, nextDamage, nextPenetration, ammo, armorGlobals, false, heavyVestSkill, angle).forEach(function (soft) {
                const stop = stoppedBy(soft[3], soft[4]);
                outcomes.push([p * soft[0], newPlates.concat(soft[1]), plateDamage + soft[2], stop === null ? null : plates.length + stop]);
            });
        });
        return outcomes;
    }

    function stoppedBy(blocker, deflector) {
        return deflector === null ? blocker : deflector;
    }

    // [[grid value, share]] splitting a positive value between its two neighboring grid points
    function snap(value, step) {
        const below = pyFloorDiv(value, step) * step;
        const shareAbove = (value - below) / step;
        if (below <= 0 || shareAbove < 1e-9) {
            // Never move a positive value onto 0, and skip zero-weight neighbors
            return [[pyRound(below <= 0 ? below + step : below, 6), 1]];
        }
        if (shareAbove > 1 - 1e-9) return [[pyRound(below + step, 6), 1]];
        return [[pyRound(below, 6), 1 - shareAbove], [pyRound(below + step, 6), shareAbove]];
    }

    // Durabilities rounded for merging states. A live piece never rounds down to destroyed.
    function durabilityKey(durabilities) {
        return durabilities.map(function (d) {
            return d <= 0 ? 0 : Math.max(pyRound(pyRound(d / DURABILITY_STEP, 0) * DURABILITY_STEP, 6), DURABILITY_STEP);
        });
    }

    // Add the HP distribution after taking `dealt` damage (times `branch`) into `into`, and
    // return the probability mass killed. Bin i means exactly i * HP_GRID_STEP HP left.
    function applyHpDamage(hpBins, dealt, branch, into) {
        const shift = dealt / HP_GRID_STEP;
        const whole = Math.trunc(shift);
        const frac = shift - whole;
        let killed = 0;
        if (frac <= 0) {
            hpBins.forEach(function (probability, index) {
                if (index <= whole) killed += probability * branch;
                else into.set(index - whole, (into.get(index - whole) || 0) + probability * branch);
            });
            return killed;
        }
        const upperShare = branch * (1 - frac);
        const lowerShare = branch * frac;
        hpBins.forEach(function (probability, index) {
            if (index <= whole) { killed += probability * branch; return; }
            const upper = index - whole;
            into.set(upper, (into.get(upper) || 0) + probability * upperShare);
            // Never let a live target land on 0 HP
            const lower = upper > 1 ? upper - 1 : 1;
            into.set(lower, (into.get(lower) || 0) + probability * lowerShare);
        });
        return killed;
    }

    // Outcomes that lead to the same state with the same damage, added together
    function mergeOutcomes(outcomes) {
        const merged = new Map();
        outcomes.forEach(function (o) {
            const dealt = pyRound(o[2], 9);
            const key = o[1].join(',') + '|' + dealt;
            const entry = merged.get(key);
            if (entry) entry[0] += o[0];
            else merged.set(key, [o[0], o[1], dealt]);
        });
        return Array.from(merged.values());
    }

    function shotsToKill(shots, chance) {
        for (let i = 0; i < shots.length; i++) {
            if (shots[i].kill_chance >= chance) return shots[i].shot;
        }
        return null;
    }

    /**
     * Kill chance and armor wear after each of up to max_shots shots into the same spot.
     * `deadline` is a Date.now() value: past it we stop after the current shot and mark
     * the result truncated. `on_shot`, when given, is handed the result so far after every shot.
     * Each shot also carries what its bullets run into, over the targets still alive when it's
     * fired: the chance each layer stops the bullet, the chance it gets through to the body,
     * and the damage it deals then.
     * @returns {{ shots: { shot: number, kill_chance: number, durability_alive: number[] | null, hp_alive: number | null, stop_chance: number[] | null, penetration_chance: number | null, penetration_damage: number | null }[], truncated: boolean }}
     */
    function simulate(ammo, hp, options) {
        const o = options || {};
        const softLayers = o.soft_layers || [];
        const plates = o.plates || [];
        const armorGlobals = o.armor_globals;
        const plateCollider = o.plate_collider || null;
        const speedRatio = o.speed_ratio == null ? 1 : o.speed_ratio;
        const heavyVestSkill = o.heavy_vest_skill || 0;
        const maxShots = o.max_shots == null ? 50 : o.max_shots;
        const stopAt = o.stop_at_kill_chance == null ? 0.9999 : o.stop_at_kill_chance;
        const projectiles = o.projectiles || 1;
        const angle = o.angle || 0;
        const deadline = o.deadline == null ? null : o.deadline;
        const onShot = o.on_shot || null;
        const layers = plates.concat(softLayers);
        const samples = penetrationSamples(ammo);

        // One HP distribution per durability state, since far fewer durability states exist than HP values
        const startBins = new Map();
        snap(hp, HP_GRID_STEP).forEach(function (pair) {
            const index = pyRound(pair[0] / HP_GRID_STEP, 0);
            startBins.set(index, (startBins.get(index) || 0) + pair[1]);
        });
        const startDurabilities = layers.map(function (layer) { return layer.durability; });
        let states = new Map([[startDurabilities.join(','), { durabilities: startDurabilities, bins: startBins }]]);
        let killed = 0;
        const result = { shots: [], truncated: false };

        // The same durability states come back shot after shot, so remember their outcomes, with
        // the stop chance per layer, the penetration chance and that chance times the damage then
        const cache = new Map();
        function outcomesFor(key, durabilities) {
            let entry = cache.get(key);
            if (!entry) {
                const all = [];
                const stops = layers.map(function () { return 0; });
                let through = 0, throughDamage = 0;
                samples.forEach(function (sample) {
                    shotOutcomes(ammo, plates, softLayers, durabilities, sample[1], armorGlobals, speedRatio, plateCollider, heavyVestSkill, angle)
                        .forEach(function (out) {
                            const p = sample[0] * out[0];
                            all.push([p, durabilityKey(out[1]), out[2]]);
                            if (out[3] === null) {
                                through += p;
                                throughDamage += p * out[2];
                            } else {
                                stops[out[3]] += p;
                            }
                        });
                });
                entry = { outcomes: mergeOutcomes(all), stops: stops, through: through, throughDamage: throughDamage };
                cache.set(key, entry);
            }
            return entry;
        }

        for (let shot = 1; shot <= maxShots; shot++) {
            // Sum what every bullet of this shot runs into, weighted by how likely each live state is
            let faced = 0, through = 0, throughDamage = 0;
            const stops = layers.map(function () { return 0; });
            for (let pellet = 0; pellet < projectiles; pellet++) {
                const nextStates = new Map();
                states.forEach(function (state, key) {
                    const entry = outcomesFor(key, state.durabilities);
                    let mass = 0;
                    state.bins.forEach(function (p) { mass += p; });
                    faced += mass;
                    entry.stops.forEach(function (chance, i) { stops[i] += mass * chance; });
                    through += mass * entry.through;
                    throughDamage += mass * entry.throughDamage;
                    entry.outcomes.forEach(function (out) {
                        const nextKey = out[1].join(',');
                        let target = nextStates.get(nextKey);
                        if (!target) {
                            target = { durabilities: out[1], bins: new Map() };
                            nextStates.set(nextKey, target);
                        }
                        killed += applyHpDamage(state.bins, out[2], out[0], target.bins);
                    });
                });
                states = new Map();
                nextStates.forEach(function (state, key) {
                    let mass = 0;
                    state.bins.forEach(function (p) { mass += p; });
                    if (mass >= MIN_STATE_PROBABILITY) states.set(key, state);
                });
            }

            let alive = 0;
            const masses = [];
            states.forEach(function (state) {
                let mass = 0;
                state.bins.forEach(function (p) { mass += p; });
                masses.push([state, mass]);
                alive += mass;
            });
            let durabilityAlive = null, hpAlive = null;
            if (alive > 0) {
                durabilityAlive = layers.map(function (_, i) {
                    let sum = 0;
                    masses.forEach(function (m) { sum += m[1] * m[0].durabilities[i]; });
                    return sum / alive;
                });
                let hpSum = 0;
                states.forEach(function (state) { state.bins.forEach(function (p, index) { hpSum += index * p; }); });
                hpAlive = hpSum * HP_GRID_STEP / alive;
            }
            result.shots.push({
                shot: shot,
                kill_chance: killed,
                durability_alive: durabilityAlive,
                hp_alive: hpAlive,
                stop_chance: faced > 0 ? stops.map(function (s) { return s / faced; }) : null,
                penetration_chance: faced > 0 ? through / faced : null,
                penetration_damage: through > 0 ? throughDamage / through : null,
            });
            if (killed >= stopAt || !states.size) break;
            if (deadline !== null && Date.now() > deadline) { result.truncated = true; break; }
            if (onShot) onShot(result);
        }
        return result;
    }

    /* ===========================
       REQUESTS
    =========================== */

    // The game checks armor slot by slot in this order
    const EQUIPMENT_SLOT_NAMES = ['headwear', 'face_cover', 'eyewear', 'rig', 'armor'];
    // Caps the pellet hits a buckshot run works through
    const MAX_PROJECTILE_HITS = 320;
    const SIMULATE_TIME_BUDGET_MS = 8000;
    const COMPARE_TIME_BUDGET_MS = 12000;
    const COMPARE_MAX_AMMO = 40;
    const FLIGHT_MAX_ROWS = 101;
    const PROGRESS_INTERVAL_MS = 80;

    // A request we turn down, with an HTTP-style status and the detail the page shows
    class RequestError {
        constructor(status, detail) {
            this.status = status;
            this.detail = detail;
        }
    }

    function fail(status, detail) { throw new RequestError(status, detail); }

    /**
     * Everything the requests read: GET /armor/items, the rounds from GET /ammo/all and
     * GET /armor/constants. Every request then works from this.
     * @param {{ items: any[], ammo: any[], constants: { globals: any, colliders: any } }} data
     */
    function createContext(data) {
        const ctx = {
            itemsById: new Map(),
            ammoById: new Map(),
            ammo: data.ammo,
            armorGlobals: loadArmorGlobals(data.constants.globals),
            colliders: data.constants.colliders,
        };
        data.items.forEach(function (item) { ctx.itemsById.set(item.id, item); });
        data.ammo.forEach(function (ammo) { ctx.ammoById.set(ammo.id, ammo); });
        return ctx;
    }

    function ammoOr404(ctx, ammoId) {
        const ammo = ctx.ammoById.get(ammoId);
        if (!ammo) fail(404, 'Ammo not found');
        if (ammo.damage == null || ammo.penetration_power == null || ammo.armor_damage == null) {
            fail(422, 'This ammo is missing damage or penetration data');
        }
        return ammo;
    }

    function engineAmmo(ammo) {
        return {
            damage: ammo.damage,
            penetration: ammo.penetration_power,
            armor_damage: ammo.armor_damage,
            penetration_deviation: ammo.penetration_power_deviation || 0,
            penetration_damage_mod: ammo.penetration_damage_mod || 0,
        };
    }

    function hasFlightData(ammo) {
        return !!(ammo.velocity && ammo.bullet_mass_grams && ammo.bullet_diameter_mm && ammo.ballistic_coefficient);
    }

    // Turn the request down when the worn items couldn't be worn together in game
    function checkLoadout(ranked) {
        const worn = {};
        ranked.forEach(function (pair) { worn[EQUIPMENT_SLOT_NAMES[pair.rank]] = pair; });
        if (worn.rig && worn.armor) fail(422, worn.rig.item.name + " can't be worn with body armor (" + worn.armor.item.name + ')');

        const present = [];
        Object.keys(worn).forEach(function (slotName) {
            const entry = worn[slotName];
            present.push([entry.item, slotName]);
            entry.attachments.forEach(function (attachment) { present.push([attachment, slotName]); });
            entry.plates.forEach(function (plate) { present.push([plate.item, slotName]); });
        });
        present.forEach(function (a, i) {
            present.forEach(function (b, j) {
                if (j > i && ((a[0].conflicting_ids || []).indexOf(b[0].id) !== -1 || (b[0].conflicting_ids || []).indexOf(a[0].id) !== -1)) {
                    fail(422, a[0].name + ' conflicts with ' + b[0].name);
                }
            });
        });
        present.forEach(function (pair) {
            if (pair[0].blocks_headwear && pair[1] !== 'headwear' && worn.headwear) fail(422, pair[0].name + " can't be worn with headwear");
            if (pair[0].blocks_eyewear && pair[1] !== 'eyewear' && worn.eyewear) fail(422, pair[0].name + " can't be worn with eyewear");
        });

        ranked.forEach(function (entry) {
            if (!entry.attachments.length) return;
            const ids = entry.attachments.map(function (a) { return a.id; });
            const slots = (entry.item.attachment_slots || []).map(function (s) { return [s.slot, s.allowed_ids || []]; });
            if (new Set(ids).size !== ids.length || fitAttachments(slots, ids) === null) {
                fail(422, "These attachments don't fit " + entry.item.name + "'s slots");
            }
        });
    }

    // {attachment id: slot name} with every attachment in its own slot, or null if they don't all fit
    function fitAttachments(slots, ids) {
        function place(index, taken) {
            if (index === ids.length) return {};
            for (let i = 0; i < slots.length; i++) {
                const slotName = slots[i][0];
                if (!taken.has(slotName) && slots[i][1].indexOf(ids[index]) !== -1) {
                    const rest = place(index + 1, new Set(taken).add(slotName));
                    if (rest !== null) { rest[ids[index]] = slotName; return rest; }
                }
            }
            return null;
        }
        return place(0, new Set());
    }

    function layerFor(piece, durabilityPercent, armorGlobals) {
        if (!(piece.material in armorGlobals.destructibility)) fail(422, 'Unknown armor material ' + piece.material);
        const ricochet = piece.ricochet || [];
        return {
            armor_class: piece.armor_class,
            max_durability: piece.durability,
            durability: piece.durability * durabilityPercent / 100,
            material: piece.material,
            blunt_throughput: piece.blunt_throughput,
            armor_type: piece.armor_type || 'None',
            blunt_reduce_from_soft_armor: false,
            ricochet_x: ricochet[0] || 0,
            ricochet_y: ricochet[1] || 0,
            ricochet_z: ricochet[2] || 0,
        };
    }

    // {plates, soft layers, descriptions} covering the requested spot, in the game's check order
    function buildLayers(ctx, payload) {
        const itemOr404 = function (id) {
            const item = ctx.itemsById.get(id);
            if (!item) fail(404, 'Unknown item ' + id);
            return item;
        };
        const ranked = (payload.equipment || []).map(function (equipped) {
            const item = itemOr404(equipped.item_id);
            const rank = EQUIPMENT_SLOT_NAMES.indexOf(item.equipment_slot);
            if (['armor', 'rig', 'helmet', 'eyewear'].indexOf(item.kind) === -1 || rank === -1) fail(422, item.name + " isn't worn armor");
            const plates = Object.keys(equipped.plates || {}).map(function (slotName) {
                const choice = equipped.plates[slotName];
                return { slot: slotName, item: itemOr404(choice.item_id), durability_percent: choice.durability_percent == null ? 100 : choice.durability_percent };
            });
            return {
                rank: rank,
                item: item,
                equipped: equipped,
                plates: plates,
                attachments: (equipped.attachments || []).map(itemOr404),
            };
        });
        const ranks = ranked.map(function (entry) { return entry.rank; });
        if (new Set(ranks).size !== ranks.length) fail(422, 'Only one item per equipment slot');
        ranked.sort(function (a, b) { return a.rank - b.rank; });
        checkLoadout(ranked);

        const armorGlobals = ctx.armorGlobals;
        const plates = [], softLayers = [], described = { plates: [], soft_layers: [] };
        const describe = function (target, piece, layer, item) {
            target.push({
                item_id: item.id,
                name: piece.slot == null ? item.name : (piece.name || item.name),
                slot: piece.slot,
                armor_class: layer.armor_class,
                durability: layer.durability,
                max_durability: layer.max_durability,
                material: layer.material,
            });
        };

        // Plates sit in unlocked armor slots, which the game moves ahead of everything else
        ranked.forEach(function (entry) {
            entry.plates.forEach(function (choice) {
                const slot = (entry.item.plate_slots || []).find(function (s) { return s.slot === choice.slot; });
                if (!slot || (slot.allowed_plate_ids || []).indexOf(choice.item.id) === -1) fail(422, choice.item.name + " doesn't fit " + choice.slot);
                if (payload.plate_collider == null || (slot.plate_colliders || []).indexOf(payload.plate_collider) === -1) return;
                (choice.item.pieces || []).forEach(function (piece) {
                    if ((piece.plate_colliders || []).indexOf(payload.plate_collider) === -1) return;
                    const layer = layerFor(piece, choice.durability_percent, armorGlobals);
                    if (slot.blunt_reduce_from_soft_armor) layer.blunt_reduce_from_soft_armor = true;
                    plates.push(layer);
                    describe(described.plates, piece, layer, choice.item);
                });
            });
        });

        ranked.forEach(function (entry) {
            const equipped = entry.equipped;
            const holders = [[entry.item, equipped.durability_percent == null ? 100 : equipped.durability_percent]];
            entry.attachments.forEach(function (attachment) {
                if (entry.item.kind !== 'helmet' || attachment.kind !== 'attachment') fail(422, attachment.name + " doesn't attach to " + entry.item.name);
                const durability = (equipped.attachment_durability || {})[attachment.id];
                holders.push([attachment, durability == null ? 100 : durability]);
            });
            const own = equipped.piece_durability || {};
            holders.forEach(function (holder) {
                (holder[0].pieces || []).forEach(function (piece) {
                    if ((piece.body_colliders || []).indexOf(payload.collider) === -1) return;
                    // A built-in insert's own durability only applies to that insert
                    const durabilityPercent = holder[0] === entry.item && piece.slot in own ? own[piece.slot] : holder[1];
                    const layer = layerFor(piece, durabilityPercent, armorGlobals);
                    softLayers.push(layer);
                    describe(described.soft_layers, piece, layer, holder[0]);
                });
            });
        });
        return { plates: plates, soft_layers: softLayers, described: described };
    }

    // [body part, its full HP, plate collider or null] for the spot the request hits
    function target(ctx, payload) {
        const bodyPart = ctx.colliders.body_parts[payload.collider];
        const parts = ctx.armorGlobals.health.parts || {};
        if (!(bodyPart in parts)) fail(422, 'No health data for ' + payload.collider);
        let plateCollider = null;
        if (payload.plate_collider != null) {
            const zone = ctx.colliders.plates[payload.plate_collider];
            if (!zone) fail(422, 'Unknown plate zone ' + payload.plate_collider);
            if (zone.collider !== payload.collider) fail(422, payload.plate_collider + " doesn't sit in front of " + payload.collider);
            const values = payload.plate_collider_values || zone;
            plateCollider = {
                penetration_level: values.penetration_level,
                penetration_chance: values.penetration_chance,
                penetration_damage_mod: values.penetration_damage_mod,
            };
        }
        return [bodyPart, parts[bodyPart].max, plateCollider];
    }

    // [where and how fast the bullet arrives or null, the speed ratio for the engine]
    function flightTo(ctx, ammo, payload) {
        if (payload.distance == null) return [null, payload.speed_ratio == null ? 1 : payload.speed_ratio];
        if (payload.speed_ratio != null) fail(422, 'Give either distance or speed_ratio, not both');
        if (!hasFlightData(ammo)) fail(422, 'This ammo has no flight data');
        const start = muzzleSpeed(ammo.velocity, payload.velocity_modifier_pct);
        const path = flightPath(start, ammo.bullet_mass_grams, ammo.bullet_diameter_mm, ammo.ballistic_coefficient, payload.distance);
        const hit = arrival(path, payload.distance);
        if (hit === null) fail(422, "The bullet doesn't reach that far");
        const speedRatio = Math.min(hit.speed / start, 1);
        return [{
            distance: hit.distance,
            muzzle_speed: start,
            speed: hit.speed,
            drop: hit.drop,
            time: hit.time,
            speed_ratio: speedRatio,
        }, speedRatio];
    }

    // Everything about a request that doesn't depend on the ammo: the target and the layers
    function prepare(ctx, payload) {
        const aimed = target(ctx, payload);
        const layers = buildLayers(ctx, payload);
        const fullHp = aimed[1];
        if (payload.hp != null && payload.hp > fullHp) fail(422, "hp can't exceed " + fullHp + ' for the ' + aimed[0]);
        return {
            body_part: aimed[0],
            part_hp: payload.hp || fullHp,
            // A stomach or limb at 0 doesn't kill: damage past it spreads until the thorax or head goes
            spread_hp: spreadCapacity(aimed[0], ctx.armorGlobals.health),
            plate_collider: aimed[2],
            plates: layers.plates,
            soft_layers: layers.soft_layers,
            described: layers.described,
        };
    }

    function run(ctx, ammo, payload, prepared, deadline, onShot) {
        const flight = flightTo(ctx, ammo, payload);
        const projectiles = Math.max(1, ammo.projectile_count || 1);
        const maxShots = Math.min(payload.max_shots == null ? 30 : payload.max_shots, Math.max(1, Math.floor(MAX_PROJECTILE_HITS / projectiles)));
        const result = simulate(engineAmmo(ammo), prepared.part_hp + prepared.spread_hp, {
            soft_layers: prepared.soft_layers,
            plates: prepared.plates,
            armor_globals: ctx.armorGlobals,
            plate_collider: prepared.plate_collider,
            speed_ratio: flight[1],
            heavy_vest_skill: payload.heavy_vest_skill || 0,
            max_shots: maxShots,
            projectiles: projectiles,
            angle: payload.angle || 0,
            deadline: deadline,
            on_shot: onShot ? function (partial) { onShot(partial, flight[0], projectiles, maxShots); } : null,
        });
        return [flight[0], projectiles, result];
    }

    function simulateResponse(ammo, prepared, flight, projectiles, result) {
        return {
            ammo_id: ammo.id,
            body_part: prepared.body_part,
            hp: prepared.part_hp,
            spread_hp: prepared.spread_hp,
            projectiles: projectiles,
            flight: flight,
            plates: prepared.described.plates,
            soft_layers: prepared.described.soft_layers,
            shots_to_kill: shotsToKill(result.shots, 0.5),
            truncated: result.truncated,
            shots: result.shots,
        };
    }

    /**
     * Kill chance and armor wear shot by shot for one ammo into one spot on the given armor.
     * `onProgress`, when given, gets { response, max_shots } after
     * every shot, the response holding the shots worked out so far.
     */
    function armorSimulate(ctx, payload, onProgress) {
        const ammo = ammoOr404(ctx, payload.ammo_id);
        const prepared = prepare(ctx, payload);
        const onShot = onProgress ? function (partial, flight, projectiles, maxShots) {
            onProgress({ response: simulateResponse(ammo, prepared, flight, projectiles, partial), max_shots: maxShots });
        } : null;
        const out = run(ctx, ammo, payload, prepared, Date.now() + SIMULATE_TIME_BUDGET_MS, onShot);
        return simulateResponse(ammo, prepared, out[0], out[1], out[2]);
    }

    // Shots to kill for every round in the picked one's caliber against the same setup
    function armorCompare(ctx, payload) {
        const picked = ammoOr404(ctx, payload.ammo_id);
        const prepared = prepare(ctx, payload);
        const rounds = ctx.ammo.filter(function (ammo) { return ammo.caliber === picked.caliber; })
            .sort(function (a, b) {
                if (a.penetration_power == null) return b.penetration_power == null ? 0 : 1;
                if (b.penetration_power == null) return -1;
                return b.penetration_power - a.penetration_power;
            })
            .slice(0, COMPARE_MAX_AMMO);
        const deadline = Date.now() + COMPARE_TIME_BUDGET_MS;
        const rows = [];
        rounds.forEach(function (ammo) {
            if (ammo.damage == null || ammo.penetration_power == null || ammo.armor_damage == null) return;
            const row = {
                ammo_id: ammo.id,
                name: ammo.name,
                damage: ammo.damage,
                penetration: ammo.penetration_power,
                projectiles: Math.max(1, ammo.projectile_count || 1),
            };
            rows.push(row);
            if (Date.now() > deadline) { row.skipped = true; return; }
            let result;
            try {
                result = run(ctx, ammo, payload, prepared, deadline)[2];
            } catch (err) {
                // This round has no flight data or doesn't reach the distance
                if (!(err instanceof RequestError)) throw err;
                row.skipped = true;
                return;
            }
            row.shots_to_kill_50 = shotsToKill(result.shots, 0.5);
            row.shots_to_kill_90 = shotsToKill(result.shots, 0.9);
            row.truncated = result.truncated;
        });
        return { caliber: picked.caliber, ammo: rows };
    }

    function flightShot(ammo, velocityModifierPct) {
        if (!hasFlightData(ammo)) fail(422, ammo.name + ' has no flight data');
        return [muzzleSpeed(ammo.velocity, velocityModifierPct), ammo.bullet_mass_grams, ammo.bullet_diameter_mm, ammo.ballistic_coefficient];
    }

    function flightAmmo(ctx, ammoId) {
        const ammo = ctx.ammoById.get(ammoId);
        if (!ammo) fail(404, 'Ammo not found');
        return ammo;
    }

    // [shot, rows or null when the zero is out of reach] for one round out of the zeroed weapon
    function flightRows(ctx, ammo, zeroShot, payload, distances) {
        const shot = flightShot(ammo, payload.velocity_modifier_pct);
        const table = zeroingTable(shot, zeroShot, payload.zero_distance, payload.sight_height_cm / 100, distances);
        if (table === null) return [shot, null];
        return [shot, table.map(function (row) {
            // What survives of damage and pen at the speed it arrives with
            const factor = degradationFactor(row.speed / shot[0], ctx.armorGlobals);
            return {
                distance: row.distance,
                impact_cm: row.impact * 100,
                correction_mrad: row.correction_mrad,
                speed: row.speed,
                time: row.time,
                damage: ammo.damage != null ? ammo.damage * factor : null,
                penetration: ammo.penetration_power != null ? ammo.penetration_power * factor : null,
            };
        })];
    }

    /**
     * Drop and zeroing table. The page resolves the weapon to its default ammo first and sends it
     * as zero_ammo_id, since the gun list lives there.
     */
    function ammoFlight(ctx, payload) {
        const settings = Object.assign({ zero_distance: 100, sight_height_cm: 5, velocity_modifier_pct: 0, max_distance: 500, step: 25 }, payload);
        const ammo = flightAmmo(ctx, settings.ammo_id);
        const zeroAmmo = settings.zero_ammo_id ? flightAmmo(ctx, settings.zero_ammo_id) : ammo;
        const distances = [];
        let distance = 0;
        while (distance <= settings.max_distance + 1e-9 && distances.length < FLIGHT_MAX_ROWS) {
            distances.push(pyRound(distance, 6));
            distance += settings.step;
        }
        const zeroShot = flightShot(zeroAmmo, settings.velocity_modifier_pct);
        const main = flightRows(ctx, ammo, zeroShot, settings, distances);
        if (main[1] === null) fail(422, "The zeroing round doesn't reach the zero distance");
        const compare = [];
        Array.from(new Set(settings.compare_ammo_ids || [])).forEach(function (compareId) {
            if (compareId === ammo.id) return;
            const other = flightAmmo(ctx, compareId);
            const sameWeapon = other.caliber === ammo.caliber;
            // A round we can't fly just drops out of the charts instead of failing the whole table
            let rows;
            try {
                rows = flightRows(ctx, other, sameWeapon ? zeroShot : flightShot(other, settings.velocity_modifier_pct), settings, distances);
            } catch (err) {
                if (!(err instanceof RequestError)) throw err;
                return;
            }
            if (rows[1] === null) return;
            compare.push({
                ammo_id: other.id,
                zero_ammo_id: sameWeapon ? zeroAmmo.id : other.id,
                muzzle_speed: rows[0][0],
                rows: rows[1],
            });
        });
        return { ammo_id: ammo.id, zero_ammo_id: zeroAmmo.id, muzzle_speed: main[0][0], rows: main[1], compare: compare };
    }

    const OPERATIONS = { simulate: armorSimulate, compare: armorCompare, flight: ammoFlight };

    // { ok, status, data } like a fetch would answer, errors included
    function handle(ctx, op, payload, onProgress) {
        try {
            return { ok: true, status: 200, data: OPERATIONS[op](ctx, payload, onProgress) };
        } catch (err) {
            if (err instanceof RequestError) return { ok: false, status: err.status, data: { detail: err.detail } };
            throw err;
        }
    }

    const engine = {
        pyRound: pyRound,
        loadArmorGlobals: loadArmorGlobals,
        spreadCapacity: spreadCapacity,
        realResistance: realResistance,
        penetrationChance: penetrationChance,
        g1Drag: g1Drag,
        muzzleSpeed: muzzleSpeed,
        flightPath: flightPath,
        arrival: arrival,
        zeroingTable: zeroingTable,
        degradationFactor: degradationFactor,
        deflectChance: deflectChance,
        simulate: simulate,
        shotsToKill: shotsToKill,
        createContext: createContext,
        handle: handle,
    };

    /* ===========================
       WORKER SIDE
    =========================== */

    const scope = /** @type {any} */ (typeof self !== 'undefined' ? self : globalThis);
    if (typeof document === 'undefined' && typeof scope.postMessage === 'function' && typeof scope.importScripts === 'function') {
        let context = null;
        scope.onmessage = function (event) {
            const message = event.data;
            if (message.type === 'data') {
                context = createContext(message.data);
                return;
            }
            // Progress goes out at most every PROGRESS_INTERVAL_MS, so a quick run sends none
            let lastProgress = Date.now();
            const onProgress = message.progress ? function (progress) {
                const now = Date.now();
                if (now - lastProgress < PROGRESS_INTERVAL_MS) return;
                lastProgress = now;
                scope.postMessage({ id: message.id, progress: progress });
            } : undefined;
            let reply;
            try {
                reply = handle(context, message.op, message.payload, onProgress);
            } catch (err) {
                console.error('[ballistics-engine] worker error:', err);
                reply = { ok: false, status: 500, data: { detail: String(err && err.message || err) } };
            }
            scope.postMessage({ id: message.id, reply: reply });
        };
        return;
    }

    /* ===========================
       PAGE SIDE
    =========================== */

    const root = /** @type {any} */ (typeof window !== 'undefined' ? window : scope);
    root.EFTForge = root.EFTForge || {};
    root.EFTForge.ballisticsEngine = engine;

    // Our own src carries the ?v= hash, so the worker loads the same version of this file
    const scriptSrc = typeof document !== 'undefined' && document.currentScript
        ? /** @type {HTMLScriptElement} */ (document.currentScript).src : null;

    let worker = null;
    let workerData = null;      // the data object the worker was last handed
    let nextId = 1;
    // id -> what it takes to send the request again. The worker runs requests one at a time
    // in the order they went out, so the first one here is the one it's working on.
    const pending = new Map();
    const CANCELLED = { ok: false, status: 0, cancelled: true, data: null };

    function startWorker() {
        worker = new Worker(/** @type {string} */ (scriptSrc));
        worker.onmessage = function (event) {
            const entry = pending.get(event.data.id);
            if (!entry) return;
            if (event.data.progress) {
                if (entry.onProgress) entry.onProgress(event.data.progress);
                return;
            }
            pending.delete(event.data.id);
            entry.resolve(event.data.reply);
        };
        worker.onerror = function (event) {
            console.error('[ballistics-engine] worker failed:', event.message);
            // Fail what's out and start over on the next request
            pending.forEach(function (entry) { entry.resolve({ ok: false, status: 500, data: { detail: event.message } }); });
            pending.clear();
            worker.terminate();
            worker = null;
            workerData = null;
        };
    }

    let constants = null;
    function loadConstants() {
        if (!constants) {
            constants = fetch(root.EFTForge.config.API_BASE + '/armor/constants')
                .then(function (res) {
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    return res.json();
                })
                .catch(function (err) { constants = null; throw err; });
        }
        return constants;
    }

    function post(id, entry) {
        if (!worker) startWorker();
        if (workerData !== entry.data) {
            workerData = entry.data;
            worker.postMessage({ type: 'data', data: { items: entry.data.items, ammo: entry.data.ammo, constants: entry.constants } });
        }
        worker.postMessage({ id: id, op: entry.op, payload: entry.payload, progress: !!entry.onProgress });
    }

    // Drop a request nobody wants any more. When it's the one the worker is busy with, we stop
    // the worker there and then, and hand whatever was waiting behind it to a fresh one.
    function cancel(id) {
        const entry = pending.get(id);
        if (!entry) return;
        const running = pending.keys().next().value === id;
        pending.delete(id);
        entry.resolve(CANCELLED);
        if (!running || !worker) return;
        worker.terminate();
        worker = null;
        workerData = null;
        pending.forEach(function (rest, restId) { post(restId, rest); });
    }

    /**
     * Run one request on the worker. `data` is { items, ammo } as the caller already has
     * them (the worker is handed it again only when it's a different object). `onProgress`
     * gets the worker's progress messages while the request is out. Aborting `signal` ends
     * the request at once with { ok: false, cancelled: true }.
     * @param {string} op
     * @param {any} payload
     * @param {{ items: any[], ammo: any[] }} data
     * @param {((progress: any) => void) | null} [onProgress]
     * @param {AbortSignal} [signal]
     * @returns {Promise<{ ok: boolean, status: number, data: any, cancelled?: boolean }>}
     */
    async function request(op, payload, data, onProgress, signal) {
        const constantsData = await loadConstants();
        if (signal && signal.aborted) return CANCELLED;
        const id = nextId++;
        return new Promise(function (resolve) {
            const entry = { resolve: resolve, onProgress: onProgress || null, op: op, payload: payload, data: data, constants: constantsData };
            pending.set(id, entry);
            post(id, entry);
            if (signal) signal.addEventListener('abort', function () { cancel(id); }, { once: true });
        });
    }

    root.EFTForge.ballisticsLocal = {
        // onProgress gets { response so far, max_shots } while the run goes on
        simulate: function (payload, data, onProgress, signal) { return request('simulate', payload, data, onProgress, signal); },
        compare: function (payload, data, signal) { return request('compare', payload, data, null, signal); },
        flight: function (payload, data) { return request('flight', payload, data); },
    };
})();
