"""The No Iron Sights toggle drops every iron sight, including AK-12 style rear sight bases."""

from optimizer.explore_request import ExploreRequest
from optimizer.milp import IRON_SIGHT_CATEGORY_ID
from optimizer.solver import OptimizeParams, optimize_weapon
from tests import test_reachability_integration
from tests.test_reachability_integration import setup_graph

db = test_reachability_integration.db

IRON = {"category_ids": IRON_SIGHT_CATEGORY_ID, "ergonomics_modifier": 20}
IRON_IDS = {"front_sight", "rear_base", "rear_sight"}


def setup_ak12_sights(db):
    # Mirror the AK-12: the rear sight sits on its own rear sight base, and both
    # carry the iron sight category alongside a plain front sight.
    setup_graph(
        db,
        {
            ("mod_sight_front", "gun"): ["front_sight"],
            ("mod_sight_rear", "gun"): ["rear_base", "reflex"],
            ("mod_sight_rear_child", "rear_base"): ["rear_sight"],
        },
        fields={"front_sight": IRON, "rear_base": IRON, "rear_sight": IRON},
    )


def test_iron_sights_are_picked_without_the_toggle(db):
    setup_ak12_sights(db)
    result = optimize_weapon(db, "gun", OptimizeParams())
    assert result["status"] == "optimal"
    assert IRON_IDS <= set(result["selected_items"])


def test_ban_iron_sights_drops_front_rear_and_rear_base(db):
    setup_ak12_sights(db)
    result = optimize_weapon(db, "gun", OptimizeParams(ban_iron_sights=True))
    assert result["status"] == "optimal"
    assert not IRON_IDS & set(result["selected_items"])
    assert "reflex" in result["selected_items"]


def test_locked_iron_sight_names_the_toggle(db):
    setup_ak12_sights(db)
    result = optimize_weapon(db, "gun", OptimizeParams(ban_iron_sights=True, include_items=["rear_sight"]))
    assert result["status"] == "infeasible"
    assert result["reason_details"][0]["key"] == "optimizer.reason.lockedIronSightBanned"


def test_explore_request_passes_the_toggle_through():
    params = ExploreRequest(weapon_id="gun", ban_iron_sights=True).optimize_params()
    assert params.ban_iron_sights is True
