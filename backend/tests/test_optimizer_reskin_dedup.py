"""_drop_dominated_reskins drops the strictly-dominated (pricier) twin of a
stat-identical, slot-identical "reskin" pair (e.g. the AR-15 Strike
Industries ARE tube's plain and Anodized Red colorways) before any solve
path runs, so ties can't leak the expensive one through."""

from types import SimpleNamespace

from optimizer.compat_map import CompatMap
from optimizer.solver import _drop_dominated_reskins


def make_item(**overrides):
    fields = dict(
        attachment_category="Stock",
        ergonomics_modifier=-0.5,
        recoil_modifier=-0.005,
        accuracy_modifier=0.0,
        weight=0.11,
        magazine_capacity=None,
        sighting_range=None,
        conflicting_item_ids=None,
        conflicting_slot_ids=None,
        category_ids="a,b",
        heat_factor=None,
        cooling_factor=None,
        durability_burn_factor=0.98,
        velocity_modifier=0.0,
    )
    fields.update(overrides)
    return SimpleNamespace(**fields)


def make_compat_map(slot_items, item_to_slots=None, required=None):
    cmap = CompatMap()
    cmap.slot_items = slot_items
    cmap.item_to_slots = item_to_slots or {}
    required = required or {}
    for slot_id in slot_items:
        cmap.slots_by_id[slot_id] = SimpleNamespace(id=slot_id, required=required.get(slot_id, False))
    return cmap


def test_identical_leaf_twins_keep_only_the_cheaper_one():
    cmap = make_compat_map({"stock_slot": ["cheap", "pricey"]})
    mods = {"cheap": make_item(), "pricey": make_item()}
    prices = {"cheap": {"price_rub": 13050}, "pricey": {"price_rub": 38072}}
    result = _drop_dominated_reskins(cmap, mods, ["cheap", "pricey"], prices, include=set(), factory_ids=set())
    assert result == ["cheap"]


def test_twins_with_identical_owned_child_slots_still_dedupe():
    # Mirrors the real ARE tube pair: each variant owns its own sling-mount
    # and endplate slots, but those slots accept the exact same children.
    cmap = make_compat_map(
        {
            "stock_slot": ["cheap", "pricey"],
            "cheap_sling": ["donor_a", "donor_b"],
            "pricey_sling": ["donor_a", "donor_b"],
        },
        item_to_slots={"cheap": ["cheap_sling"], "pricey": ["pricey_sling"]},
    )
    mods = {"cheap": make_item(), "pricey": make_item()}
    prices = {"cheap": {"price_rub": 13050}, "pricey": {"price_rub": 38072}}
    result = _drop_dominated_reskins(cmap, mods, ["cheap", "pricey"], prices, include=set(), factory_ids=set())
    assert result == ["cheap"]


def test_twins_with_different_owned_child_slots_are_not_merged():
    cmap = make_compat_map(
        {
            "stock_slot": ["cheap", "pricey"],
            "cheap_sling": ["donor_a"],
            "pricey_sling": ["donor_a", "donor_b"],
        },
        item_to_slots={"cheap": ["cheap_sling"], "pricey": ["pricey_sling"]},
    )
    mods = {"cheap": make_item(), "pricey": make_item()}
    prices = {"cheap": {"price_rub": 13050}, "pricey": {"price_rub": 38072}}
    result = _drop_dominated_reskins(cmap, mods, ["cheap", "pricey"], prices, include=set(), factory_ids=set())
    assert set(result) == {"cheap", "pricey"}


def test_differing_stat_disqualifies_the_pair():
    cmap = make_compat_map({"stock_slot": ["a", "b"]})
    mods = {"a": make_item(), "b": make_item(recoil_modifier=-0.006)}
    prices = {"a": {"price_rub": 13050}, "b": {"price_rub": 38072}}
    result = _drop_dominated_reskins(cmap, mods, ["a", "b"], prices, include=set(), factory_ids=set())
    assert set(result) == {"a", "b"}


def test_locked_item_is_never_dropped_even_if_pricier():
    cmap = make_compat_map({"stock_slot": ["cheap", "pricey"]})
    mods = {"cheap": make_item(), "pricey": make_item()}
    prices = {"cheap": {"price_rub": 13050}, "pricey": {"price_rub": 38072}}
    result = _drop_dominated_reskins(cmap, mods, ["cheap", "pricey"], prices, include={"pricey"}, factory_ids=set())
    assert set(result) == {"cheap", "pricey"}


def test_factory_twin_always_wins_regardless_of_its_own_market_price():
    # Reproduces the real bug: the weapon's factory-installed twin can carry
    # its own (sometimes higher) market price, but it still ships free with
    # the gun, so its non-factory twin must never be preferred over it.
    cmap = make_compat_map({"stock_slot": ["factory_twin", "market_twin"]})
    mods = {"factory_twin": make_item(), "market_twin": make_item()}
    prices = {"factory_twin": {"price_rub": 13050}, "market_twin": {"price_rub": 9000}}
    result = _drop_dominated_reskins(
        cmap, mods, ["factory_twin", "market_twin"], prices, include=set(), factory_ids={"factory_twin"}
    )
    assert result == ["factory_twin"]


def test_factory_item_is_never_itself_dropped():
    cmap = make_compat_map({"stock_slot": ["factory_a", "factory_b"]})
    mods = {"factory_a": make_item(), "factory_b": make_item()}
    prices = {"factory_a": {"price_rub": 5000}, "factory_b": {"price_rub": 1}}
    result = _drop_dominated_reskins(
        cmap,
        mods,
        ["factory_a", "factory_b"],
        prices,
        include=set(),
        factory_ids={"factory_a", "factory_b"},
    )
    assert set(result) == {"factory_a", "factory_b"}
