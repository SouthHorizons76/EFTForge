"""Keep the variant sweep honest.

The sweep is only worth reading if its synthetic card sits where real cards sit. Too clean
and every group passes; too degraded and the sweep reports failures the game would never
produce. These checks pin the card against the same pinned references the hand-checked
accuracy test uses, without running the full several-minute sweep.
"""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("cv2")
np = pytest.importorskip("numpy")

from recognition.icons import compare_group, read_image
from recognition.variant_sweep import CARD_PIXELS, card_rng, decide, render_card, variant_groups

DATA = Path(__file__).parent / "data"
CASES = json.loads((DATA / "icon_ground_truth.json").read_text(encoding="utf-8"))["cases"]


def reference_ids():
    return [case["expected_item_id"] for case in CASES if case["expected_item_id"]]


def test_rendered_card_arrives_at_screenshot_resolution():
    reference = read_image(DATA / "icon_references" / f"{reference_ids()[0]}.webp")
    card = render_card(reference, np.random.default_rng(0))
    assert card.shape == (CARD_PIXELS, CARD_PIXELS, 3)
    assert card.dtype == np.uint8


def test_synthetic_card_sits_where_real_cards_sit():
    """A sweep whose cards are cleaner or dirtier than the game's predicts nothing."""
    rng = np.random.default_rng(7)
    measured = []
    for item_id in reference_ids():
        reference = read_image(DATA / "icon_references" / f"{item_id}.webp")
        result = compare_group(render_card(reference, rng), [reference], 1)[0]
        if result:
            measured.append(result)
    assert len(measured) >= 15
    shape = float(np.median([row["shape_score"] for row in measured]))
    color = float(np.median([row["color_error"] for row in measured]))
    chroma = float(np.median([row["chroma_error"] for row in measured]))
    # Generous bands: the point is to catch drift into "trivially easy" or "impossible",
    # not to pin a constant. Real cards are the centre of each range.
    assert 0.88 <= shape <= 0.99, shape
    assert 0.005 <= color <= 0.05, color
    assert 0.001 <= chroma <= 0.015, chroma


def test_a_card_is_matched_to_the_reference_it_was_built_from():
    rng = np.random.default_rng(3)
    case = next(c for c in CASES if c["expected_item_id"] and c["label"] == "Chevron")
    group = [c["item_id"] for c in case["candidates"] if c["text_similarity"] >= 0.98]
    references = [read_image(DATA / "icon_references" / f"{item_id}.webp") for item_id in group]
    truth = group.index(case["expected_item_id"])
    card = render_card(references[truth], rng)
    evidence = decide(group, {item_id: item_id for item_id in group}, compare_group(card, references, 1))
    assert evidence["status"] == "supported", evidence.get("reason")
    assert evidence["best_item_id"] == case["expected_item_id"]


def test_variant_groups_only_reports_names_worth_disambiguating():
    items = {
        "weapon": {"id": "weapon", "short_name": "GUN", "is_weapon": True},
        "a": {"id": "a", "short_name": "MBUS FS", "is_weapon": False},
        "b": {"id": "b", "short_name": "MBUS FS", "is_weapon": False},
        "c": {"id": "c", "short_name": "Alone", "is_weapon": False},
        "unreachable": {"id": "unreachable", "short_name": "MBUS FS", "is_weapon": False},
    }
    catalog = SimpleNamespace(items=items, reachable=lambda _: {"a", "b", "c"})
    groups = variant_groups(catalog)
    assert [group["short_name"] for group in groups] == ["mbusfs"]
    assert sorted(groups[0]["item_ids"]) == ["a", "b"]


def test_group_order_does_not_depend_on_traversal_order():
    """`reachable` hands back a set and Python randomizes string hashing per process, so a
    sweep that walked groups in that order gave a different answer on every run."""
    items = {
        "weapon": {"id": "weapon", "short_name": "GUN", "is_weapon": True},
        "a": {"id": "a", "short_name": "MBUS", "is_weapon": False},
        "b": {"id": "b", "short_name": "MBUS", "is_weapon": False},
        "c": {"id": "c", "short_name": "UCS", "is_weapon": False},
        "d": {"id": "d", "short_name": "UCS", "is_weapon": False},
    }
    forwards = variant_groups(SimpleNamespace(items=items, reachable=lambda _: ["a", "b", "c", "d"]))
    backwards = variant_groups(SimpleNamespace(items=items, reachable=lambda _: ["d", "c", "b", "a"]))
    assert forwards == backwards
    assert [group["short_name"] for group in forwards] == ["mbus", "ucs"]


def test_each_card_is_seeded_from_its_own_item():
    """Seeding one stream across the whole sweep made every card depend on the group order."""
    assert card_rng(1, "item").random() == card_rng(1, "item").random()
    assert card_rng(1, "item").random() != card_rng(1, "other").random()
    assert card_rng(1, "item").random() != card_rng(2, "item").random()
