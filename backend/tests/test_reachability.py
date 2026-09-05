"""Soundness checks for shared pruning, independent of the production solver."""

from itertools import combinations, product
from types import SimpleNamespace

from compatibility import CompatibilityIndex


def index(edges, owners, required=(), items=None):
    slots = [SimpleNamespace(id=s, parent_item_id=o, required=s in required) for s, o in owners.items()]
    return CompatibilityIndex(slots, edges, items or {})


def test_alternative_parent_survives_and_disconnected_cycle_does_not():
    graph = index(
        {"root": ["a", "b"], "as": ["c"], "bs": ["c"], "cs": ["d"], "ds": ["c"]},
        {"root": "gun", "as": "a", "bs": "b", "cs": "c", "ds": "d"},
    )
    assert graph.prune(["root"], {"b", "c", "d"}).item_ids == {"b", "c", "d"}
    assert graph.prune(["root"], {"c", "d"}).item_ids == set()


def test_required_failure_cascades_but_optional_empty_slot_is_valid():
    graph = index(
        {"root": ["a", "optional"], "as": ["b"], "bs": ["missing"], "os": ["missing"]},
        {"root": "gun", "as": "a", "bs": "b", "os": "optional"},
        required=["root", "as", "bs"],
    )
    result = graph.prune(["root"], {"a", "b", "optional"}, require_complete=True)
    assert result.item_ids == {"optional"}
    assert not result.empty_required_roots
    assert result.required_failure_count == 2
    assert graph.prune(["root"], {"a", "b", "optional"}).item_ids == {"a", "b", "optional"}
    assert graph.prune(["root"], {"a", "b"}, require_complete=True).empty_required_roots == {"root"}


def test_blocking_one_placement_does_not_block_other_slots_or_mutate_index():
    graph = index({"left": ["a"], "right": ["a"]}, {"left": "gun", "right": "gun"})
    result = graph.prune(["left", "right"], {"a"}, blocked_edges={"left": {"a"}})
    assert result.item_ids == {"a"}
    assert result.slot_items["left"] == ()
    assert result.slot_items["right"] == ("a",)
    assert graph.slot_items["left"] == ("a",)
    assert graph.prune(["left"], {"a"}).item_ids == {"a"}


def test_conflict_index_preserves_both_directions_and_slot_context():
    def item(item_conflicts="", slot_conflicts=""):
        return SimpleNamespace(conflicting_item_ids=item_conflicts, conflicting_slot_ids=slot_conflicts)

    graph = index(
        {"left": ["a", "b", "c", "d"], "right": ["a", "b", "c", "d"]},
        {"left": "gun", "right": "gun", "owned": "fixed"},
        items={"fixed": item("a", "left"), "b": item("fixed"), "c": item(slot_conflicts="owned")},
    )
    blocked = graph.blocked_edges({"fixed"})
    assert blocked == {"left": {"a", "b", "c", "d"}, "right": {"a", "b", "c"}}


def test_prefiltered_and_filtered_graphs_propagate_identical_required_failures():
    # Exercise both adjacency reuse and filtered views with a cascade through
    # a shared child. A later request must still see the original edges.
    edges = {"root": ["a", "b", "removed"], "as": ["c"], "bs": ["c"], "cs": []}
    owners = {"root": "gun", "as": "a", "bs": "b", "cs": "c"}
    available = {"a", "b", "c"}
    full = index(edges, owners, ["as", "cs"])
    filtered = index({s: [i for i in ids if i in available] for s, ids in edges.items()}, owners, ["as", "cs"])
    expected = full.prune(["root"], available, require_complete=True)
    actual = filtered.prune(["root"], available, require_complete=True)
    assert actual == expected
    assert actual.item_ids == {"b"}
    assert filtered.prune(["root"], available).item_ids == available


def test_exhaustive_small_graphs_never_lose_a_valid_complete_configuration():
    # Enumerate concrete slot placements (including empty), then independently
    # require selected owners to be rooted and all their required slots filled.
    # This oracle does not use the pruning implementation or the MILP model.
    edges = {"root": ["a", "b"], "as": ["c"], "bs": ["c"], "cs": ["d"]}
    owners = {"root": "gun", "as": "a", "bs": "b", "cs": "c"}
    ids = {"a", "b", "c", "d"}
    for flags in product([False, True], repeat=len(edges)):
        required = {s for s, flag in zip(edges, flags) if flag}
        graph = index(edges, owners, required)
        for count in range(5):
            for subset in combinations(sorted(ids), count):
                available = set(subset)
                result = graph.prune(["root"], available, require_complete=True)
                choices = [[None] + [i for i in values if i in available] for values in edges.values()]
                for placement in product(*choices):
                    selected = {i for i in placement if i is not None}
                    if len(selected) != sum(i is not None for i in placement):
                        continue  # one concrete copy of each candidate
                    picked = dict(zip(edges, placement))
                    reached = {"gun"}
                    for _ in range(len(edges)):
                        reached |= {i for s, i in picked.items() if i and owners[s] in reached}
                    if not selected <= reached:
                        continue
                    if any(owners[s] in reached and picked[s] is None for s in required):
                        continue
                    assert selected <= result.item_ids
                    assert not result.empty_required_roots
