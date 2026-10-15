"""Player-level flea gating: parts whose only priced offer is a flea listing
above the player's level stay out of the candidate pool, even when allow_unpriced
would otherwise admit genuinely unpriced parts. Trader-locked parts deliberately
stay on the allow_unpriced path."""

from models_item_offers import ItemOffer
from optimizer.solver import OptimizeParams, _load_candidates_and_prices, optimize_weapon
from tests.test_reachability_integration import db, setup_graph  # noqa: F401


def _flea_only(db, item_id, min_level_flea):  # noqa: F811
    # Replace setup_graph's mechanic offer with a single level-gated flea listing.
    db.query(ItemOffer).filter_by(item_id=item_id).delete()
    db.add(
        ItemOffer(
            item_id=item_id,
            vendor_normalized="flea-market",
            trader_level=None,
            price=10,
            price_rub=10,
            currency="RUB",
            is_flea=True,
            min_level_flea=min_level_flea,
        )
    )
    db.commit()


def test_flea_level_locked_part_is_excluded_despite_allow_unpriced(db):  # noqa: F811
    setup_graph(db, {("stock", "gun"): ["locked", "other"]})
    _flea_only(db, "locked", 40)
    params = OptimizeParams(player_level=20, allow_unpriced=True, recoil_weight=0.0)
    _, _, _, (candidates, prices) = _load_candidates_and_prices(db, "gun", params)
    assert "locked" not in candidates
    assert "other" in candidates
    result = optimize_weapon(db, "gun", params)
    assert result["status"] == "optimal"
    assert "locked" not in result["selected_items"]


def test_high_enough_player_level_unlocks_the_flea_part(db):  # noqa: F811
    setup_graph(db, {("stock", "gun"): ["locked", "other"]})
    _flea_only(db, "locked", 40)
    params = OptimizeParams(player_level=79, allow_unpriced=True, recoil_weight=0.0)
    _, _, _, (candidates, prices) = _load_candidates_and_prices(db, "gun", params)
    assert "locked" in candidates
    assert prices["locked"]["vendor"] == "flea-market"


def test_genuinely_unpriced_part_is_still_admitted(db):  # noqa: F811
    setup_graph(db, {("stock", "gun"): ["arena"]})
    db.query(ItemOffer).filter_by(item_id="arena").delete()
    db.commit()
    params = OptimizeParams(player_level=20, allow_unpriced=True)
    _, _, _, (candidates, _) = _load_candidates_and_prices(db, "gun", params)
    assert "arena" in candidates


def test_trader_level_locked_part_is_still_admitted_by_allow_unpriced(db):  # noqa: F811
    setup_graph(db, {("stock", "gun"): ["locked", "other"]})
    db.query(ItemOffer).filter_by(item_id="locked").delete()
    db.add(
        ItemOffer(
            item_id="locked",
            vendor_normalized="mechanic",
            trader_level=4,
            price=50,
            price_rub=50,
            currency="RUB",
            is_flea=False,
        )
    )
    db.commit()
    params = OptimizeParams(trader_levels={"mechanic": 1}, allow_unpriced=True, recoil_weight=0.0)
    _, _, _, (candidates, _) = _load_candidates_and_prices(db, "gun", params)
    # The lock check is flea-only by design: a part the player cannot buy at their
    # current trader levels still enters through the allow_unpriced path.
    assert "locked" in candidates
    assert "other" in candidates


def test_flea_level_locked_magazine_stays_in_the_candidate_pool(db):  # noqa: F811
    setup_graph(
        db,
        {("stock", "gun"): ["lockedmag", "other"]},
        fields={"lockedmag": {"magazine_capacity": 30}},
    )
    _flea_only(db, "lockedmag", 40)
    params = OptimizeParams(player_level=20, allow_unpriced=True, recoil_weight=0.0)
    _, _, _, (candidates, prices) = _load_candidates_and_prices(db, "gun", params)
    # Magazines keep the pricing exemption they had before the lock check: dropping
    # them would shrink the min-mag-capacity slider's range.
    assert "lockedmag" in candidates
    assert prices["lockedmag"].get("no_price") is True


def test_flea_switch_off_ignores_player_level(db):  # noqa: F811
    setup_graph(db, {("stock", "gun"): ["fleaonly", "other"]})
    _flea_only(db, "fleaonly", 40)
    params = OptimizeParams(player_level=20, flea_available=False, allow_unpriced=True)
    _, _, _, (candidates, _) = _load_candidates_and_prices(db, "gun", params)
    # Flea is off entirely, so the level gate is irrelevant: the part falls back
    # to the unpriced path and allow_unpriced admits it as before.
    assert "fleaonly" in candidates


def test_force_included_locked_part_stays_selectable(db):  # noqa: F811
    setup_graph(db, {("stock", "gun"): ["locked", "other"]})
    _flea_only(db, "locked", 40)
    params = OptimizeParams(player_level=20, allow_unpriced=True, include_items=["locked"])
    _, _, _, (candidates, _) = _load_candidates_and_prices(db, "gun", params)
    assert "locked" in candidates


def test_is_level_locked_classifies_offers(db):  # noqa: F811
    from optimizer.pricing import is_level_locked

    def offer(is_flea, price_rub=10, min_level_flea=None, vendor="mechanic", game_mode=None):
        return {
            "vendor_normalized": vendor,
            "trader_level": None,
            "price_rub": price_rub,
            "is_flea": is_flea,
            "min_level_flea": min_level_flea,
            "game_mode": game_mode,
        }

    flea_gated = offer(True, min_level_flea=40, vendor="flea-market")
    assert is_level_locked([flea_gated], True, 20, "pvp") is True
    assert is_level_locked([flea_gated], True, 79, "pvp") is False
    assert is_level_locked([flea_gated], True, None, "pvp") is False
    assert is_level_locked([flea_gated], False, 20, "pvp") is False
    assert is_level_locked([flea_gated], True, 20, "pve") is False

    # Trader offers never count as locked: loyalty gating stays on allow_unpriced.
    assert is_level_locked([offer(False)], True, None, "pvp") is False

    assert is_level_locked([offer(False, price_rub=None)], True, 20, "pvp") is False
    assert is_level_locked([], True, 20, "pvp") is False
