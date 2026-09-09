"""Guard constraint semantics when reusing sparse matrices across solves."""

import numpy as np
from scipy.optimize import Bounds, milp

from optimizer.milp import ConstraintBuilder


def test_new_cut_changes_solution_without_mutating_previous_matrix():
    cb = ConstraintBuilder(3)
    cb.ge({0: 1, 1: 1}, 1)
    cb.le({0: 1, 1: 1, 2: 0}, 1)
    cb.eq({2: 1}, 0)
    original = cb.build()

    def solve(constraints):
        result = milp([1, 2, 0], bounds=Bounds(0, 1), integrality=1, constraints=constraints)
        assert result.status == 0
        return result.x

    np.testing.assert_allclose(solve(original), [1, 0, 0])
    np.testing.assert_allclose(solve(cb.build()), [1, 0, 0])
    cb.le({0: 1}, 0)
    np.testing.assert_allclose(solve(cb.build()), [0, 1, 0])
    np.testing.assert_allclose(solve(original), [1, 0, 0])


def test_empty_coefficient_row_can_still_make_model_infeasible():
    cb = ConstraintBuilder(2)
    cb.ge({0: 0}, 1)
    result = milp([1, 0], bounds=Bounds(0, 1), integrality=1, constraints=cb.build())
    assert result.status == 2


def test_copied_constraints_keep_the_new_auxiliary_column():
    base = ConstraintBuilder(2)
    base.eq({0: 1, 1: 1}, 1)
    base.build()
    extended = ConstraintBuilder(3)
    extended.rows.extend(base.rows)
    extended.ge({2: 1, 0: -2, 1: -1}, 0)
    result = milp([0, 0, 1], bounds=Bounds(0, [1, 1, 100]), integrality=[1, 1, 0], constraints=extended.build())
    assert result.status == 0
    np.testing.assert_allclose(result.x, [0, 1, 1])
