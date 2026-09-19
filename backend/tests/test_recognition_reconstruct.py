"""Check reconstruction against small catalogs with known slot trees."""

import json
import sqlite3
from types import SimpleNamespace

import pytest

from recognition.catalog import Catalog, analyze
from recognition.reconstruct import SearchLimits, encode_payload, import_payload, reconstruct, validate_tree


@pytest.fixture
def catalog(tmp_path):
    path = tmp_path / "reconstruction.db"
    stat_columns = (
        "factory_attachment_ids base_ergonomics weight factory_ergonomics factory_weight "
        "factory_recoil_vertical factory_recoil_horizontal recoil_vertical recoil_horizontal "
        "velocity_modifier ergonomics_modifier recoil_modifier center_of_impact accuracy_modifier "
        "heat_factor cooling_factor durability_burn_factor sighting_range"
    ).split()
    with sqlite3.connect(path) as db:
        db.execute(
            "CREATE TABLE items (id TEXT, name TEXT, short_name TEXT, name_zh TEXT, short_name_zh TEXT, "
            "is_weapon INTEGER, icon_link TEXT, conflicting_item_ids TEXT, conflicting_slot_ids TEXT, "
            + ", ".join(stat_columns)
            + ")"
        )
        db.executescript(
            "CREATE TABLE slots (id TEXT, parent_item_id TEXT, slot_name TEXT, required INTEGER);"
            "CREATE TABLE slot_allowed_items (slot_id TEXT, allowed_item_id TEXT);"
        )
        for item_id, label in [
            ("gun", "Test rifle"),
            ("mount", "Mount"),
            ("scope", "Scope"),
            ("tan", "Scope"),
            ("light", "Light"),
            ("barrel", "Barrel"),
        ]:
            values = {key: None for key in stat_columns}
            values.update(
                weight=3 if item_id == "gun" else 0.1,
                base_ergonomics=50,
                recoil_vertical=100,
                recoil_horizontal=200,
                sighting_range=100,
                center_of_impact=None,
            )
            if item_id in ("scope", "tan"):
                values.update(ergonomics_modifier=5 if item_id == "tan" else -5)
            db.execute(
                "INSERT INTO items VALUES (" + ",".join("?" for _ in range(9 + len(stat_columns))) + ")",
                [item_id, label, label, None, None, item_id == "gun", None, None, None]
                + [values[key] for key in stat_columns],
            )
        db.executemany(
            "INSERT INTO slots VALUES (?, ?, ?, ?)",
            [
                ("rail", "gun", "Rail", 0),
                ("rail2", "gun", "Rail", 0),
                ("optic", "mount", "Scope", 0),
                ("barrel_slot", "gun", "Barrel", 1),
            ],
        )
        db.executemany(
            "INSERT INTO slot_allowed_items VALUES (?, ?)",
            [
                ("rail", "mount"),
                ("rail2", "mount"),
                ("rail", "light"),
                ("rail2", "light"),
                ("optic", "scope"),
                ("optic", "tan"),
                ("barrel_slot", "barrel"),
            ],
        )
    return Catalog(path)


def run(catalog, labels, panel=None, limits=None):
    report = analyze(
        catalog, {"weapon_text": "Test rifle", "cards": [{"text": text} for text in labels], "stats_panel": panel or {}}
    )
    return reconstruct(catalog, report, limits or SearchLimits(seconds=2, max_inferred=0))


def test_reconstruct_parent_chain_and_required_parts(catalog):
    candidate = run(catalog, ["Scope", "Barrel", "Mount"])["candidates"][0]
    assert candidate["validation"] == {"valid": True, "errors": [], "missing_required_slots": []}
    assert not candidate["unresolved_card_indices"]
    assert not candidate["inferred_instances"]
    assert candidate["completeness"] == "observations_accounted_for"
    pairs = candidate["payload"]["p"]
    assert pairs.index(["optic", "scope"]) > pairs.index(["rail", "mount"])


def test_stats_rank_tied_variants_and_missing_panel_stays_uncertain(catalog):
    panel = {"fields": {"total_ergo": {"status": "read", "value": 55}}}
    candidates = run(catalog, ["Mount", "Scope", "Barrel"], panel)["candidates"]
    assert "tan" in candidates[0]["attachment_ids"]
    assert candidates[0]["display_unit_error"] == 0
    assert candidates[0]["stat_comparison"]["status"] == "insufficient_evidence"
    assert any("scope" in candidate["attachment_ids"] for candidate in candidates)
    assert run(catalog, ["Mount"])["candidates"][0]["display_unit_error"] is None


def test_leaf_duplicates_use_two_distinct_slots(catalog):
    best = run(catalog, ["Light", "Light", "Barrel"])["candidates"][0]
    assert best["attachment_ids"].count("light") == 2
    assert len({n["instance_id"] for n in best["nodes"]}) == 4
    assert best["payload"] is not None


def test_single_slot_capacity_leaves_extra_card_unresolved(catalog):
    best = run(catalog, ["Barrel", "Barrel"])["candidates"][0]
    assert best["attachment_ids"] == ["barrel"]
    assert len(best["unresolved_card_indices"]) == 1


def test_hidden_adapter_is_inferred_and_marked_for_review(catalog):
    best = run(catalog, ["Scope", "Barrel"], limits=SearchLimits(seconds=2))["candidates"][0]
    assert "mount" in best["attachment_ids"]
    assert len(best["inferred_instances"]) == 1
    assert best["completeness"] == "partial"
    assert not best["unresolved_card_indices"]


def test_missing_required_and_unknown_card_are_not_filled(catalog):
    best = run(catalog, ["????", "NONE"])["candidates"][0]
    assert best["unresolved_card_indices"] == [0]
    assert best["validation"]["missing_required_slots"] == [{"parent_instance_id": "root", "slot_id": "barrel_slot"}]
    assert best["attachment_ids"] == []


@pytest.mark.parametrize("field,value", [("conflicting_item_ids", "mount"), ("conflicting_slot_ids", "optic")])
def test_conflicts_do_not_depend_on_install_order(catalog, field, value):
    catalog.items["light"][field] = value
    for labels in (["Mount", "Light"], ["Light", "Mount"]):
        for candidate in run(catalog, labels)["candidates"]:
            assert not {"light", "mount"}.issubset(candidate["attachment_ids"])


def test_duplicate_parent_instances_with_children_withhold_flat_export(catalog):
    best = run(catalog, ["Mount", "Mount", "Scope", "Scope", "Barrel"])["candidates"][0]
    assert best["attachment_ids"].count("mount") == 2
    assert not best["unresolved_card_indices"]
    assert best["payload"] is None
    assert best["export_status"] == "ambiguous_parent_instances"


def test_validator_rejects_disconnected_and_reused_slot_trees(catalog):
    candidate = run(catalog, ["Barrel"])["candidates"][0]
    nodes = candidate["nodes"]
    invalid = nodes + [{**nodes[1], "instance_id": "another"}]
    validation = validate_tree(catalog, "gun", invalid)
    assert "occupied_slot" in validation["errors"]
    assert "reused_card" in validation["errors"]
    assert import_payload(catalog, "gun", invalid) is None
    invalid = [nodes[0], {**nodes[1], "parent_instance_id": "absent"}]
    assert "invalid_parent_slot" in validate_tree(catalog, "gun", invalid)["errors"]


def test_budget_returns_reviewable_partial_results(catalog):
    result = run(catalog, ["Mount", "Scope", "Barrel"], limits=SearchLimits(max_expansions=1))
    assert "budget" in result["search"]["truncated_by"]
    assert result["search"]["expansions"] == 1
    assert result["candidates"][0]["unresolved_card_indices"]


def test_unresolved_weapon(catalog):
    assert reconstruct(catalog, analyze(catalog, {"cards": []}))["status"] == "weapon_unresolved"


def test_export_code_round_trip(catalog):
    lzstring = pytest.importorskip("lzstring")
    payload = run(catalog, ["Mount", "Scope", "Barrel"])["candidates"][0]["payload"]
    assert json.loads(lzstring.LZString.decompressFromEncodedURIComponent(encode_payload(payload))) == payload


def test_literal_candidate_precedes_folded_variant(catalog):
    catalog.items["scope"].update(short_name="AB0", name="AB0")
    catalog.items["tan"].update(short_name="ABO", name="ABO")
    candidates = catalog.rank("ABO", {"scope", "tan"})
    assert candidates[0]["item_id"] == "tan"
    assert candidates[0]["literal_exact"]
    assert not candidates[1]["literal_exact"]


def test_icon_evidence_breaks_same_text_same_stats_ties(catalog):
    catalog.items["scope"]["ergonomics_modifier"] = catalog.items["tan"]["ergonomics_modifier"]
    report = analyze(
        catalog, {"weapon_text": "Test rifle", "cards": [{"text": "Mount"}, {"text": "Scope"}, {"text": "Barrel"}]}
    )
    for candidate in report["cards"][1]["candidates"]:
        candidate["icon_penalty"] = 0 if candidate["item_id"] == "tan" else 0.3
    result = reconstruct(catalog, report, SearchLimits(max_inferred=0))
    assert "tan" in result["candidates"][0]["attachment_ids"]
    assert result["candidates"][0]["icon_penalty"] == 0
    assert any("scope" in candidate["attachment_ids"] for candidate in result["candidates"])


def test_keep_all_candidates_tied_at_catalog_cutoff(catalog):
    ids = set()
    for index in range(7):
        item_id = f"same{index}"
        catalog.items[item_id] = {**catalog.items["scope"], "id": item_id}
        ids.add(item_id)
    assert len(catalog.rank("Scope", ids)) == 5
    assert len(catalog.rank("Scope", ids, include_ties=True)) == 7


def test_cycles_cannot_infer_copies_of_ancestors(catalog):
    slot = {"id": "cycle", "parent_item_id": "scope", "slot_name": "Mount", "required": False}
    catalog.slots["cycle"] = slot
    catalog.slots_by_parent["scope"].append(slot)
    catalog.allowed["cycle"].add("mount")
    edge = {"slot_id": "cycle", "parent_item_id": "scope", "allowed_item_id": "mount", "slot_name": "Mount"}
    catalog.by_parent["scope"].append(edge)
    catalog.by_item["mount"].append(edge)
    result = run(catalog, ["Mount", "Mount", "Mount", "Scope"], limits=SearchLimits(seconds=2))
    assert all(candidate["attachment_ids"].count("mount") <= 2 for candidate in result["candidates"])
    assert result["candidates"][0]["unresolved_card_indices"]


def test_deadline_retains_a_valid_partial_tree(catalog, monkeypatch):
    ticks = iter([0])
    monkeypatch.setattr("recognition.reconstruct.time", SimpleNamespace(monotonic=lambda: next(ticks, 2)))
    result = run(catalog, ["Mount", "Scope"], limits=SearchLimits(seconds=1))
    assert "budget" in result["search"]["truncated_by"]
    assert result["candidates"][0]["validation"]["valid"]
    assert result["candidates"][0]["unresolved_card_indices"] == [0, 1]


@pytest.mark.parametrize("kwargs", [{"seconds": float("nan")}, {"beam_width": 0}, {"max_inferred": -1}])
def test_reject_invalid_search_limits(kwargs):
    with pytest.raises(ValueError):
        SearchLimits(**kwargs)


def test_cli_exports_review_artifacts_without_ocr(catalog, tmp_path, monkeypatch):
    lzstring = pytest.importorskip("lzstring")
    from recognition.__main__ import main

    source = tmp_path / "observations.json"
    source.write_text(json.dumps({"weapon_text": "Test rifle", "cards": [{"text": "Barrel"}]}), encoding="utf-8")
    output = tmp_path / "result"
    monkeypatch.setattr(
        "sys.argv",
        [
            "recognition",
            "--db",
            str(tmp_path / "reconstruction.db"),
            "--observations",
            str(source),
            "--reconstruct",
            "--output",
            str(output),
        ],
    )
    main()
    report = json.loads((output / "report.json").read_text(encoding="utf-8"))
    candidate = json.loads((output / "candidate-01.json").read_text(encoding="utf-8"))
    code = (output / "candidate-01.code.txt").read_text(encoding="utf-8")
    assert candidate == report["reconstruction"]["candidates"][0]
    assert json.loads(lzstring.LZString.decompressFromEncodedURIComponent(code)) == {
        "v": 1,
        "g": "gun",
        "p": [["barrel_slot", "barrel"]],
    }
    with pytest.raises(SystemExit):
        main()
    assert (output / "candidate-01.code.txt").read_text(encoding="utf-8") == code
