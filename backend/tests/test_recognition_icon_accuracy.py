"""Measure the icon matcher against hand-checked answers from real preset screenshots.

`data/icon_cards` holds card crops cut out of preset screenshots, `data/icon_references`
the transparent catalog images those cards were compared against, and
`data/icon_ground_truth.json` the answer for each card, read off the crop by eye. Five
cards have no answer: their icon shows the part with its own children fitted, a scope
sitting in its mount or a handguard carrying its base, so no bare reference can explain
them and abstaining is the only correct outcome.

The synthetic renders in test_recognition_icons.py pin the individual gates. This file
pins what they add up to on real cards, which is the only thing that says whether a
threshold change helped or hurt.
"""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

cv2 = pytest.importorskip("cv2")
pytest.importorskip("numpy")

from recognition.icons import apply_icon_evidence, read_image

DATA = Path(__file__).parent / "data"
CARDS, REFERENCES = DATA / "icon_cards", DATA / "icon_references"
GROUND_TRUTH = json.loads((DATA / "icon_ground_truth.json").read_text(encoding="utf-8"))["cases"]

# Raise this when a change earns it. Lowering it means real cards stopped being read
# correctly, which is a decision to argue for in review, not a number to quietly edit.
EXPECTED_CORRECT = 17


class FixtureCache:
    """Stand in for IconCache, reading pinned references instead of the download cache."""

    def get(self, item):
        path = REFERENCES / f"{item['id']}.webp"
        if not path.exists():
            return None, "reference_not_cached"
        return read_image(path), "cached"


@pytest.fixture(scope="module")
def measured(tmp_path_factory):
    report = {
        "cards": [
            {
                "card_index": index,
                "crop": case["crop"],
                "ocr_lines": [{}] * case["label_lines"],
                "candidates": [dict(candidate) for candidate in case["candidates"]],
            }
            for index, case in enumerate(GROUND_TRUTH)
        ]
    }
    items = {
        candidate["item_id"]: {"id": candidate["item_id"]} for case in GROUND_TRUTH for candidate in case["candidates"]
    }
    catalog = SimpleNamespace(items=items)
    summary = apply_icon_evidence(catalog, report, CARDS, FixtureCache(), tmp_path_factory.mktemp("icons"))
    evidence = {entry["card_index"]: entry for entry in summary["cards"]}
    return report, evidence


def verdict(case, evidence):
    supported = evidence is not None and evidence["status"] == "supported"
    expected = case["expected_item_id"]
    if expected is None:
        return "abstained_correctly" if not supported else "wrong"
    if not supported:
        return "abstained"
    return "correct" if evidence["best_item_id"] == expected else "wrong"


@pytest.mark.parametrize("case", GROUND_TRUTH, ids=[case["crop"][:-4] for case in GROUND_TRUTH])
def test_no_hand_checked_card_is_read_as_the_wrong_variant(case, measured):
    """Abstaining costs recall; naming the wrong variant puts a wrong part in the build."""
    _, evidence = measured
    index = GROUND_TRUTH.index(case)
    entry = evidence.get(index)
    assert verdict(case, entry) != "wrong", (
        f"{case['crop']} ({case['label']}): expected {case['expected_item_id'] or 'no supported answer'}, "
        f"got {entry and entry.get('best_item_id')} with status {entry and entry['status']}"
    )


def test_every_reference_the_comparison_needs_is_pinned(measured):
    """A deleted reference would turn into an abstention, which every other test tolerates."""
    _, evidence = measured
    unusable = {
        index: entry["reason"]
        for index, entry in evidence.items()
        if entry.get("reason") in ("reference_missing_for_a_variant", "card_crop_unavailable", "invalid_card_crop")
    }
    assert unusable == {}


def test_supported_reads_do_not_regress(measured):
    _, evidence = measured
    counts = {}
    for index, case in enumerate(GROUND_TRUTH):
        outcome = verdict(case, evidence.get(index))
        counts[outcome] = counts.get(outcome, 0) + 1
    assert counts.get("wrong", 0) == 0
    assert counts.get("correct", 0) >= EXPECTED_CORRECT, counts
    # Every card without an answer has to stay unanswered.
    assert counts.get("abstained_correctly", 0) == sum(1 for case in GROUND_TRUTH if not case["expected_item_id"])


def test_supported_reads_lead_their_own_tie(measured):
    """The report's first candidate is what a reader acts on, so it must match the evidence."""
    report, evidence = measured
    for card in report["cards"]:
        entry = evidence.get(card["card_index"])
        if entry and entry["status"] == "supported":
            assert card["candidates"][0]["item_id"] == entry["best_item_id"]
