"""Check ambiguity and graph filtering without downloading OCR models."""

import sqlite3

import pytest

from recognition.catalog import Catalog, analyze, normalize, resolve_weapon


@pytest.fixture
def catalog(tmp_path):
    path = tmp_path / "catalog.db"
    with sqlite3.connect(path) as db:
        db.executescript(
            "CREATE TABLE items (id TEXT, name TEXT, short_name TEXT, name_zh TEXT, "
            "short_name_zh TEXT, is_weapon INTEGER, icon_link TEXT);"
            "CREATE TABLE slots (id TEXT, parent_item_id TEXT, slot_name TEXT);"
            "CREATE TABLE slot_allowed_items (slot_id TEXT, allowed_item_id TEXT);"
        )
        db.executemany(
            "INSERT INTO items VALUES (?, ?, ?, NULL, NULL, ?, NULL)",
            [
                ("gun", "Test rifle", "Test", 1),
                ("other", "Other rifle", "Other", 1),
                ("mount", "Scope mount", "Mount", 0),
                ("scope", "Razor scope", "Razor HD Gen.2", 0),
                ("variant", "Razor scope tan", "Razor HD Gen.2", 0),
                ("wrong", "Wrong rifle scope", "Razor HD Gen.2", 0),
            ],
        )
        db.executemany(
            "INSERT INTO slots VALUES (?, ?, ?)",
            [
                ("rail", "gun", "Mount"),
                ("optic", "mount", "Scope"),
                ("foreign", "other", "Scope"),
                ("cycle", "scope", "Cycle"),
            ],
        )
        db.executemany(
            "INSERT INTO slot_allowed_items VALUES (?, ?)",
            [
                ("rail", "mount"),
                ("optic", "scope"),
                ("optic", "variant"),
                ("foreign", "wrong"),
                ("cycle", "mount"),
            ],
        )
    return Catalog(path)


def test_filter_reachable_preserve_ambiguity(catalog):
    report = analyze(catalog, {"weapon_text": "Test rifle", "cards": [{"text": "Razor HD\nGen.2"}]})
    assert report["weapon_id"] == "gun"
    candidates = report["cards"][0]["candidates"]
    assert {row["item_id"] for row in candidates} == {"scope", "variant"}
    assert candidates[0]["possible_slots"] == [{"slot_id": "optic", "parent_item_id": "mount", "slot_name": "Scope"}]
    assert report["requires_review"]


def test_unknown_weapon_does_not_search_entire_catalog(catalog):
    report = analyze(catalog, {"weapon_text": "", "cards": [{"text": "Mount"}]})
    assert report["weapon_id"] is None
    assert report["cards"][0]["status"] == "unresolved"


def test_empty_unknown_and_duplicate_observations(catalog):
    report = analyze(catalog, {"cards": [{"text": text} for text in ("NONE", "???", "Mount", "Mount")]}, "gun")
    assert [card["status"] for card in report["cards"]] == ["empty", "unresolved", "candidates", "candidates"]
    assert len(report["cards"]) == 4


def test_invalid_override(catalog):
    with pytest.raises(ValueError, match="not a weapon"):
        analyze(catalog, {}, "scope")


def test_missing_db_is_not_created(tmp_path):
    path = tmp_path / "missing.db"
    with pytest.raises(sqlite3.OperationalError):
        Catalog(path)
    assert not path.exists()


def test_normalization():
    assert normalize('M-LOK 4.1"') == normalize("Ｍ－ＬＯＫ 4.1")
    # OCR reads the inch mark as a degree sign or an ordinal indicator, which NFKC would
    # otherwise fold into a trailing letter and count against the match.
    assert normalize("M-LOK 4.1º") == normalize('M-LOK 4.1"') == normalize("M-LOK 4.1°")


def test_confusable_glyphs_do_not_outrank_a_literal_match(catalog):
    from recognition.catalog import similarity

    catalog.items["mount"].update(short_name="GF MOD3")
    # Zero read as the letter O still reaches the right mount.
    assert catalog.rank("GF-M0D3", {"mount"})[0]["item_id"] == "mount"
    assert similarity(normalize("GF-M0D3"), normalize("GF MOD3")) == 1.0
    # Folding never invents a match between genuinely different names.
    assert similarity(normalize("MBUS FS"), normalize("MBUS RS")) < 1.0


def test_exact_weapon_title_wins_over_similar_model(catalog):
    catalog.items["gun"].update(name="Colt M4A1 5.56x45 assault rifle", short_name="M4A1")
    catalog.items["other"].update(name="Colt M16A1 5.56x45 assault rifle", short_name="M16A1")
    weapon_id, candidates = resolve_weapon(catalog, "Colt M4A1 5.56x45 assault rifle")
    assert candidates[0]["text_similarity"] - candidates[1]["text_similarity"] < 0.08
    assert weapon_id == "gun"
    catalog.items["other"].update(name=catalog.items["gun"]["name"])
    assert resolve_weapon(catalog, catalog.items["gun"]["name"])[0] is None


def test_overlay_filter_preserves_attachment_names():
    from recognition.vision import is_interface_label

    for label in ("RECE", "GAS BLOCK", "PIST. GRIP", "gas_block", "HANDGUARD", "BACK"):
        assert is_interface_label(label)
    for label in ("DP", "NONE", "Geis top", "Stock Pad", "Mount Adapter", "Pistol grip A2"):
        assert not is_interface_label(label)


def test_overlay_filter_rejects_clipped_slot_labels():
    from recognition.vision import is_interface_label

    # The weapon model cuts slot overlays, so OCR returns pieces of the real label.
    for label in ("ARD/ER", "MAGAZIN", "AS BLOCK", "ANDGUARD"):
        assert is_interface_label(label)
    # Short readings stay in: CR and UCS are real short names that appear inside slot words.
    for label in ("CR", "UCS", "CF 12", "T-LOK", "MCX 16"):
        assert not is_interface_label(label)


def test_wrapped_label_lines_group_into_one_card():
    from recognition.vision import group_label_lines

    lines = [
        {"text": "UCS", "score": 0.99, "left": 1500, "right": 1524, "top": 500, "bottom": 512},
        {"text": "CR", "score": 0.97, "left": 1500, "right": 1518, "top": 513, "bottom": 525},
        # A different card further down the screen must stay separate.
        {"text": "PMAG", "score": 0.98, "left": 1350, "right": 1386, "top": 680, "bottom": 692},
    ]
    blocks = group_label_lines(lines, 1.0)
    assert [block["text"] for block in blocks] == ["UCS CR", "PMAG"]
    assert blocks[0]["top"] == 500 and blocks[0]["score"] == 0.97


def test_separate_cards_on_one_row_are_not_grouped():
    from recognition.vision import group_label_lines

    lines = [
        {"text": "MCX", "score": 0.99, "left": 400, "right": 430, "top": 300, "bottom": 312},
        {"text": "MCX", "score": 0.99, "left": 500, "right": 530, "top": 300, "bottom": 312},
    ]
    assert [block["text"] for block in group_label_lines(lines, 1.0)] == ["MCX", "MCX"]


def test_longer_reading_replaces_a_clipped_one_but_never_a_different_name():
    from recognition.vision import _extends

    assert _extends("MCX", "MCX GEN1")
    assert _extends("UCS", "UCS CR")
    assert not _extends("MCX GEN1", "MCX")
    assert not _extends("MBUS FS", "MBUS RS")


def test_extraction_filters_both_ocr_paths_and_keeps_empty_and_duplicate_cards(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace

    cv2 = pytest.importorskip("cv2")
    np = pytest.importorskip("numpy")
    from recognition import vision

    image = np.zeros((1080, 1920, 3), dtype=np.uint8)
    texts = ["GAS BLOCK", "PIST. GRIP", "DP", "DP", "NONE", "NONE"]
    boxes = np.array([[[x, 400], [x + 30, 400], [x + 30, 412], [x, 412]] for x in range(400, 1000, 100)])
    # Draw a real card around each label the filters should keep, because a detection now
    # has to sit inside a visible border to count as a card.
    for x in range(600, 1000, 100):
        cv2.rectangle(image, (x - 8, 392), (x + 57, 457), (180, 180, 180), 1)
    image_path = tmp_path / "source.png"
    cv2.imencode(".png", image)[1].tofile(str(image_path))

    def fake_engine(*args, **kwargs):
        return SimpleNamespace(txts=texts, scores=[0.99] * len(texts), boxes=boxes)

    monkeypatch.setitem(sys.modules, "rapidocr", SimpleNamespace(RapidOCR=lambda: fake_engine))
    monkeypatch.setattr(vision, "read_text", lambda *args: ("Test rifle", []))
    monkeypatch.setattr(vision, "detect_cards", lambda image: [(300, 200, 65, 65)])
    monkeypatch.setattr(vision, "read_label", lambda *args: ("RECE", []))
    result = vision.extract(image_path, tmp_path / "out", lambda *args: True)
    # Repeated labels are separate cards: a build can carry the same attachment twice.
    assert [card["text"] for card in result["cards"]] == ["DP", "DP", "NONE", "NONE"]


def test_a_name_without_a_card_border_is_held_for_review(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace

    cv2 = pytest.importorskip("cv2")
    np = pytest.importorskip("numpy")
    from recognition import vision

    image_path = tmp_path / "source.png"
    # No borders anywhere: HAMR is printed on the weapon model, not on a card.
    cv2.imencode(".png", np.zeros((1080, 1920, 3), dtype=np.uint8))[1].tofile(str(image_path))
    boxes = np.array([[[973, 370], [1020, 370], [1020, 382], [973, 382]]])

    def fake_engine(*args, **kwargs):
        return SimpleNamespace(txts=["HAMR"], scores=[0.99], boxes=boxes)

    monkeypatch.setitem(sys.modules, "rapidocr", SimpleNamespace(RapidOCR=lambda: fake_engine))
    monkeypatch.setattr(vision, "read_text", lambda *args: ("Test rifle", []))
    monkeypatch.setattr(vision, "detect_cards", lambda image: [])
    monkeypatch.setattr(vision, "read_label", lambda *args: ("HAMR", []))
    result = vision.extract(image_path, tmp_path / "out", lambda *args: True)
    assert result["cards"] == []
    # Held for review rather than dropped: a border can also be hidden behind the weapon.
    region = next(row for row in result["review_regions"] if row["status"] == "unverified_card")
    assert region["fragments"][0]["text"] == "HAMR"
    assert region["border_support"] is None


def test_card_detection_deduplicates_borders():
    cv2 = pytest.importorskip("cv2")
    np = pytest.importorskip("numpy")
    from recognition.vision import detect_cards

    image = np.zeros((1080, 1920, 3), dtype=np.uint8)
    cv2.rectangle(image, (600, 200), (665, 265), (180, 180, 180), 1)
    boxes = detect_cards(image)
    assert len(boxes) == 1
    assert abs(boxes[0][0] - 600) <= 2


def test_broken_card_detected_from_three_edges():
    cv2 = pytest.importorskip("cv2")
    np = pytest.importorskip("numpy")
    from recognition.vision import detect_cards

    image = np.zeros((1080, 1920, 3), dtype=np.uint8)
    cv2.line(image, (900, 200), (965, 200), (180, 180, 180), 1)
    cv2.line(image, (900, 265), (965, 265), (180, 180, 180), 1)
    cv2.line(image, (965, 200), (965, 246), (180, 180, 180), 1)
    boxes = detect_cards(image)
    assert any(abs(x - 900) <= 3 and abs(y - 200) <= 3 for x, y, _, _ in boxes)


def test_overlap_region_preserves_two_hypotheses_without_identifying_items():
    cv2 = pytest.importorskip("cv2")
    np = pytest.importorskip("numpy")
    from recognition.overlap import find_overlap_regions

    image = np.zeros((1080, 1920, 3), dtype=np.uint8)
    cv2.rectangle(image, (625, 200), (690, 265), (150, 150, 150), 1)
    cv2.rectangle(image, (600, 200), (665, 265), (20, 20, 20), -1)
    cv2.rectangle(image, (600, 200), (665, 265), (150, 150, 150), 1)
    regions = find_overlap_regions(image, [])
    assert len(regions) == 1
    assert regions[0]["status"] == "unresolved_overlap"
    assert len(regions[0]["possible_card_boxes"]) == 2
    assert "item_id" not in regions[0]


def test_single_card_is_not_an_overlap_region():
    cv2 = pytest.importorskip("cv2")
    np = pytest.importorskip("numpy")
    from recognition.overlap import find_overlap_regions

    image = np.zeros((1080, 1920, 3), dtype=np.uint8)
    cv2.rectangle(image, (600, 200), (665, 265), (150, 150, 150), 1)
    assert find_overlap_regions(image, []) == []
