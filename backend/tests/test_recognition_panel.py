"""Check panel parsing, conservative comparisons, and shared build-stat calculation."""

import sqlite3
from types import SimpleNamespace

import pytest

from recognition.panel import FIELDS, compare_stats, evaluate_builds, parse_panel


def line(text, x, y, width=100, score=0.99):
    return {"text": text, "score": score, "box": [[x, y], [x + width, y], [x + width, y + 12], [x, y + 12]]}


def test_parse_shuffled_panel_rows_and_units():
    lines = [
        line("84.8", 300, 40),
        line("ERGONOMICS", 0, 40),
        line("WEIGHT", 0, 20),
        line("3.850", 300, 20),
        line("ACCURACY", 0, 60),
        line("1,47 MOA", 300, 60),
        line("SIGHTING RANGE 1500", 0, 80),
        line("VERTICAL RECOIL", 0, 100),
        line("64", 300, 100),
        line("HORIZONTAL RECOIL", 0, 120),
        line("185", 300, 120),
    ]
    panel = parse_panel(lines)
    assert panel["status"] == "complete"
    assert {k: r["value"] for k, r in panel["fields"].items()} == {
        "total_ergo": 84.8,
        "total_weight": 3.85,
        "accuracy_moa": 1.47,
        "sighting_range": 1500,
        "recoil_vertical": 64,
        "recoil_horizontal": 185,
    }


def test_hidden_and_unreadable_panels_are_not_zeroes():
    assert parse_panel([line("INFO", 0, 0)])["status"] == "not_detected"
    assert parse_panel([line("ACCURACY 1.4? MOA", 0, 0)])["fields"] == {}
    panel = parse_panel([line("ERGONOMICS", 0, 0), line("84.8", 300, 0, score=0.4)])
    assert panel["fields"]["total_ergo"]["status"] == "low_confidence"
    assert compare_stats(panel, {"total_ergo": 84.8})["compared_fields"] == 0


def test_conflicting_ocr_values_require_review():
    panel = parse_panel([line("ERGONOMICS 84.8", 0, 0), line("ERGONOMICS 34.8", 0, 30)])
    assert panel["fields"]["total_ergo"]["status"] == "ambiguous"
    assert compare_stats(panel, {"total_ergo": 84.8})["status"] == "insufficient_evidence"


def complete_panel():
    values = dict(total_ergo=84.8, accuracy_moa=1.47, sighting_range=1500, recoil_vertical=64, recoil_horizontal=185)
    return {"fields": {key: {"value": value, "status": "read"} for key, value in values.items()}}


def test_precision_weight_and_partial_evidence():
    panel = complete_panel()
    values = {key: row["value"] for key, row in panel["fields"].items()}
    panel["fields"]["total_weight"] = {"value": 4.1, "status": "read"}
    result = compare_stats(panel, {**values, "total_ergo": 84.84, "total_weight": 3.1})
    assert result["status"] == "stats_agree"
    assert result["weight"] == {"observed": 4.1, "calculated": 3.1}
    assert compare_stats(panel, {**values, "total_ergo": 84.86})["status"] == "stats_differ"
    assert compare_stats(panel, {"total_ergo": 84.8})["status"] == "insufficient_evidence"
    assert compare_stats(panel)["status"] == "insufficient_evidence"


def test_compare_candidate_builds_uses_shared_calculation(tmp_path):
    path = tmp_path / "items.db"
    columns = [
        "base_ergonomics",
        "weight",
        "factory_ergonomics",
        "factory_weight",
        "factory_recoil_vertical",
        "factory_recoil_horizontal",
        "recoil_vertical",
        "recoil_horizontal",
        "velocity_modifier",
        "ergonomics_modifier",
        "recoil_modifier",
        "is_weapon",
        "center_of_impact",
        "accuracy_modifier",
        "heat_factor",
        "cooling_factor",
        "durability_burn_factor",
        "sighting_range",
    ]
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE items (id TEXT, factory_attachment_ids TEXT, " + ", ".join(columns) + ")")
        for item_id, fields in [
            (
                "gun",
                {
                    "is_weapon": 1,
                    "base_ergonomics": 50,
                    "weight": 3,
                    "recoil_vertical": 100,
                    "recoil_horizontal": 200,
                    "center_of_impact": 0.1,
                    "sighting_range": 100,
                },
            ),
            ("mod", {"ergonomics_modifier": 5, "weight": 0.1, "recoil_modifier": -0.1}),
        ]:
            values = [item_id, None] + [fields.get(key) for key in columns]
            db.execute("INSERT INTO items VALUES (" + ",".join("?" for _ in values) + ")", values)
    catalog = SimpleNamespace(items={"gun": {"is_weapon": True}}, reachable=lambda _: {"mod"})
    panel = {
        "fields": {
            key: {"value": value, "status": "read"}
            for key, value in {
                "total_ergo": 55,
                "accuracy_moa": 3.44,
                "sighting_range": 100,
                "recoil_vertical": 90,
                "recoil_horizontal": 180,
            }.items()
        }
    }
    report = {"weapon_id": "gun", "stats_panel": panel}
    builds = [{"name": "bare", "attachment_ids": []}, {"name": "match", "attachment_ids": ["mod"]}]
    results = evaluate_builds(path, catalog, report, builds)
    assert results[0]["name"] == "match"
    assert results[0]["stat_comparison"]["status"] == "stats_agree"
    assert results[0]["slot_validity"] == "not_checked"
    assert results[1]["stat_comparison"]["status"] == "stats_differ"
    with pytest.raises(ValueError, match="unreachable"):
        evaluate_builds(path, catalog, report, [{"attachment_ids": ["unknown"]}])


def test_every_comparison_field_is_reported_when_panel_missing():
    result = compare_stats({})
    assert set(result["fields"]) == set(FIELDS)
