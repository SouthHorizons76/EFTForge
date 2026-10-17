"""Exact-stat checks and sound linear rows for the TED floor and overswing limit.

A build clears a TED margin m when its effective ergo E reaches m + 100 - 300 / W
above 3 kg (just m at or below it). That boundary is concave in the weight W, so a
chord between two weights sits under it on that interval. The weight band search
in milp._solve_with_outer_ted uses one chord per band, which can only admit extra
builds, never exclude a valid one; the exact check here then rejects the extras.
"""

import math

from stats import SWAY_START_KG

TED_FLOOR_EPSILON = 1e-7
_WEIGHT_RECIPROCAL = 100.0 * SWAY_START_KG


class TedOuterConstraint:
    """Optimistic affine ergo/weight model of a request plus its exact acceptance check."""

    def __init__(self, solve_stats, idx, min_true_ergo_delta=None, prevent_overswing=False):
        self.solve_stats = solve_stats
        self.idx = idx
        self.min_true_ergo_delta = min_true_ergo_delta
        self.prevent_overswing = prevent_overswing
        self.margin = None
        self.weight_lower_bound = SWAY_START_KG
        if min_true_ergo_delta is not None:
            if not math.isfinite(min_true_ergo_delta):
                raise ValueError("TrueErgo floor must be finite")
            # Permit every unrounded value whose exported two-decimal TED can pass.
            rounded_floor = min_true_ergo_delta
            if abs(rounded_floor) <= 101.0:
                rounded_floor = math.ceil((rounded_floor - TED_FLOOR_EPSILON) * 100.0 - 1e-8) / 100.0
            self.margin = rounded_floor - 0.005 - TED_FLOOR_EPSILON
        if prevent_overswing:
            self.margin = max(0.0, self.margin) if self.margin is not None else 0.0
        self._prepare_affine_stats()

    def _prepare_affine_stats(self):
        weapon, mods = self.solve_stats.weapon, self.solve_stats.mods
        scale = 1.0 + self.solve_stats.equip_ergo_modifier
        if not math.isfinite(scale) or scale < 0:
            raise ValueError("Equipment ergonomics scale must be finite and nonnegative")
        base_ergo = getattr(weapon, "base_ergonomics", None) or 0.0
        base_weight = getattr(weapon, "weight", None) or 0.0
        self.ergo_constant = base_ergo
        self.weight_constant = base_weight
        self.ergo_coefficients = {self.idx[i]: getattr(mods[i], "ergonomics_modifier", None) or 0.0 for i in self.idx}
        self.weight_coefficients = {self.idx[i]: self.solve_stats.item_weights[i] for i in self.idx}

        factory_ids = set(filter(None, (getattr(weapon, "factory_attachment_ids", None) or "").split(",")))
        if factory_ids and factory_ids <= self.idx.keys():
            factory_ergo = getattr(weapon, "factory_ergonomics", None) or base_ergo
            factory_weight = getattr(weapon, "factory_weight", None) or base_weight
            factory_ergo_sum = math.fsum(getattr(mods[i], "ergonomics_modifier", None) or 0.0 for i in factory_ids)
            factory_weight_sum = math.fsum(getattr(mods[i], "weight", None) or 0.0 for i in factory_ids)
            # Overestimate ergo and underestimate weight for either preset state.
            self.ergo_constant += max(0.0, factory_ergo - base_ergo - factory_ergo_sum)
            self.weight_constant += min(0.0, factory_weight - base_weight - factory_weight_sum)

        ammo = getattr(self.solve_stats, "ammo", None)
        grenade = getattr(self.solve_stats, "ubgl_grenade", None)
        has_ammo = ammo is not None and getattr(ammo, "is_ammo", False)
        has_grenade = (
            grenade is not None
            and getattr(grenade, "is_ammo", False)
            and bool(getattr(grenade, "caliber", None))
            and bool(getattr(grenade, "weight", None))
        )
        grenade_items = {
            i
            for i in self.idx
            if has_grenade
            and getattr(mods[i], "caliber", None) == grenade.caliber
            and not getattr(mods[i], "is_ammo", False)
        }
        if has_ammo or grenade_items:
            # Cover the rounded base and every subsequent loaded-weight round.
            self.ergo_constant += 0.005
            self.weight_constant -= 0.0005
            for i, column in self.idx.items():
                if has_ammo and getattr(mods[i], "magazine_capacity", None):
                    self.weight_coefficients[column] -= 0.0005
                if i in grenade_items:
                    self.weight_coefficients[column] -= 0.0005

        self.ergo_constant *= scale
        self.ergo_coefficients = {column: scale * coefficient for column, coefficient in self.ergo_coefficients.items()}
        values = [
            self.ergo_constant,
            self.weight_constant,
            *self.ergo_coefficients.values(),
            *self.weight_coefficients.values(),
        ]
        if not all(math.isfinite(value) for value in values):
            raise ValueError("Aiming constraint coefficients must be finite")
        self.weight_upper_bound = self.weight_constant + math.fsum(
            max(0.0, value) for value in self.weight_coefficients.values()
        )
        if not math.isfinite(self.weight_upper_bound):
            raise ValueError("Aiming constraint weight bound must be finite")
        if self.margin is not None and self.margin > 0:
            self.weight_upper_bound = min(self.weight_upper_bound, _WEIGHT_RECIPROCAL / self.margin)

    def narrow_weight_range(self, lower, upper):
        """Fit the chords to the weights a build can actually reach.

        Chords only have to stay under the boundary where builds exist, so a proven
        [lower, upper] weight range (an LP relaxation bound) keeps them much closer
        to it than the default 3 kg to theoretical-maximum span.
        """
        if math.isfinite(upper):
            self.weight_upper_bound = min(self.weight_upper_bound, upper)
        if math.isfinite(lower) and SWAY_START_KG < lower < self.weight_upper_bound:
            self.weight_lower_bound = lower

    def accepts_stats(self, stats):
        if self.prevent_overswing and stats["overswing"]:
            return False
        return (
            self.min_true_ergo_delta is None or stats["true_ergo_delta"] >= self.min_true_ergo_delta - TED_FLOOR_EPSILON
        )

    def point(self, selected):
        """Optimistic (ergo, weight) of a selection under the affine model."""
        columns = [self.idx[i] for i in selected]
        ergo = self.ergo_constant + math.fsum(self.ergo_coefficients[column] for column in columns)
        weight = self.weight_constant + math.fsum(self.weight_coefficients[column] for column in columns)
        return ergo, weight

    def required_ergo(self, weight):
        if weight <= SWAY_START_KG:
            return self.margin
        return self.margin + 100.0 - _WEIGHT_RECIPROCAL / weight

    def secant(self, a, b):
        """Slope and intercept of the boundary's chord between weights a and b (both >= 3 kg)."""
        slope = _WEIGHT_RECIPROCAL / (a * b)
        return slope, self.margin + 100.0 - _WEIGHT_RECIPROCAL / a - _WEIGHT_RECIPROCAL / b

    def row(self, slope, intercept):
        """Coefficients and right-hand side for ergo >= slope * weight + intercept."""
        coefficients = {
            column: self.ergo_coefficients[column] - slope * self.weight_coefficients[column]
            for column in self.idx.values()
        }
        return coefficients, intercept - (self.ergo_constant - slope * self.weight_constant)

    def add_necessary_rows(self, cb):
        """Rows every passing build satisfies: the ergo floor, the weight cap and the
        chord across the whole proven weight range."""
        if self.margin > 100.0:
            cb.ge({}, 1.0)
            return
        # Reuse the existing nonnegative raw-ergo model instead of adding a clamp.
        cb.ge(self.ergo_coefficients, self.margin - self.ergo_constant)
        if self.margin > 0:
            cb.le(self.weight_coefficients, _WEIGHT_RECIPROCAL / self.margin - self.weight_constant)
        if self.weight_upper_bound > self.weight_lower_bound:
            cb.ge(*self.row(*self.secant(self.weight_lower_bound, self.weight_upper_bound)))
