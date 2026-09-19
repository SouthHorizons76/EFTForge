"""Check color evidence, abstention, and offline reference handling."""

import json
from types import SimpleNamespace

import pytest

cv2 = pytest.importorskip("cv2")
np = pytest.importorskip("numpy")

from recognition.icons import (
    BADGE_COLUMNS,
    BADGE_TOP,
    CANVAS,
    IconCache,
    apply_icon_evidence,
    compare_group,
    compare_icon,
    usable_region,
)


def reference(color):
    image = np.zeros((64, 64, 4), dtype=np.uint8)
    for y in range(10, 55):
        x = 14 if y > 32 else 33
        shade = 0.55 + (y % 13) / 25
        image[y, x:53, :3] = np.array(color) * shade
        image[y, x:53, 3] = 255
    cv2.circle(image, (25, 41), 6, (15, 16, 18, 255), -1)
    return image


def other_shape(color):
    # A different part that happens to share a short name, not another colour of the same one.
    image = np.zeros((64, 64, 4), dtype=np.uint8)
    for y in range(12, 52):
        shade = 0.5 + (y % 9) / 18
        width = slice(8, 8 + (y - 10) // 2)
        image[y, width, :3] = np.array(color) * shade
        image[y, width, 3] = 255
    return image


def screenshot(ref, brightness=1, badge=(0, 230, 20)):
    image = np.full((64, 64, 3), (24, 20, 15), dtype=np.uint8)
    mask = ref[:, :, 3] > 0
    image[mask] = np.clip(ref[:, :, :3][mask] * brightness, 0, 255)
    cv2.putText(image, "MBUS", (4, 10), cv2.FONT_HERSHEY_SIMPLEX, 0.3, (170, 170, 170), 1)
    # The card paints a category badge bottom left and a purchase badge bottom right, both
    # over the item, and the purchase badge turns red when the part cannot be bought.
    cv2.rectangle(image, (4, 45), (20, 59), (90, 120, 60), -1)
    cv2.rectangle(image, (45, 45), (59, 61), badge, -1)
    return image


@pytest.mark.parametrize("color,other", [((35, 40, 45), (85, 105, 125)), ((85, 105, 125), (35, 40, 45))])
@pytest.mark.parametrize("brightness", [0.85, 1.0, 1.15])
def test_color_variants_survive_badges_labels_and_brightness(color, other, brightness):
    crop = screenshot(reference(color), brightness)
    correct = compare_icon(crop, reference(color))
    wrong = compare_icon(crop, reference(other))
    assert correct["score"] > wrong["score"] + 0.04
    assert correct["shape_score"] >= 0.65
    assert correct["color_error"] < wrong["color_error"]


def test_purchase_badge_color_never_reaches_the_comparison():
    # The purchase badge turns red when the part is unaffordable, which says nothing about
    # the part's colour. Reading one pixel of it would hand every red variant free evidence,
    # so the badge has to leave the measurement untouched, not merely outvoted.
    olive, red = (35, 70, 45), (30, 35, 150)
    keys = ("score", "shape_score", "color_error", "chroma_error", "compared_pixels")
    green_badge = screenshot(reference(olive), badge=(0, 230, 20))
    red_badge = screenshot(reference(olive), badge=(20, 25, 235))
    correct = compare_icon(green_badge, reference(olive))
    assert [correct[key] for key in keys] == [compare_icon(red_badge, reference(olive))[key] for key in keys]
    wrong = compare_icon(red_badge, reference(red))
    assert correct["score"] > wrong["score"] + 0.04
    assert correct["chroma_error"] < wrong["chroma_error"]


def test_usable_region_excludes_the_border_label_and_both_badges():
    mask = usable_region(CANVAS, label_lines=1)
    badge_row = round(CANVAS * BADGE_TOP) + 2
    assert not mask[:4].any() and not mask[-4:].any()
    assert not mask[: round(CANVAS * 0.2)].any()
    for first, last in BADGE_COLUMNS:
        assert not mask[badge_row, slice(round(CANVAS * first), round(CANVAS * last))].any()
    assert mask[badge_row, CANVAS // 2]
    assert mask[CANVAS // 2, CANVAS // 2]
    # A wrapped label eats further into the card, never less.
    assert usable_region(CANVAS, 3).sum() < mask.sum()


def test_color_variants_are_placed_once_so_the_same_pixels_are_compared():
    crop = screenshot(reference((85, 105, 125)))
    black, fde = compare_group(crop, [reference((35, 40, 45)), reference((85, 105, 125))])
    assert black["alignment"] == fde["alignment"] == "shared"
    assert (black["scale"], black["offset"]) == (fde["scale"], fde["offset"])
    assert black["compared_pixels"] == fde["compared_pixels"]
    assert fde["score"] > black["score"]


def test_differently_shaped_candidates_are_placed_independently():
    crop = screenshot(reference((85, 105, 125)))
    same, different = compare_group(crop, [reference((85, 105, 125)), other_shape((85, 105, 125))])
    assert same["alignment"] == different["alignment"] == "independent"
    assert same["shape_score"] > different["shape_score"]


def setup_case(tmp_path, identical=False, references=None, card=None):
    crops = tmp_path / "crops"
    crops.mkdir()
    black, fde = reference((35, 40, 45)), reference((85, 105, 125))
    cv2.imencode(".png", screenshot(fde))[1].tofile(str(crops / "card.png"))
    refs = references or {"black": fde if identical else black, "fde": fde}
    items = {key: {"id": key} for key in refs}
    candidates = [{"item_id": key, "name": key, "short_name": "MBUS FS", "text_similarity": 1.0} for key in items]
    report = {"cards": [{"card_index": 0, "crop": "card.png", "candidates": candidates, **(card or {})}]}
    cache = SimpleNamespace(get=lambda item: (refs[item["id"]], "cached"))
    return SimpleNamespace(items=items), report, crops, cache


def test_supported_variant_preserves_alternatives_and_replay_crops(tmp_path):
    catalog, report, crops, cache = setup_case(tmp_path)
    output = tmp_path / "output"
    summary = apply_icon_evidence(catalog, report, crops, cache, output)
    candidates = report["cards"][0]["candidates"]
    assert summary["supported_cards"] == 1
    assert summary["cards"][0]["best_item_id"] == "fde"
    # Every alternative survives; supported evidence only leads its own tie.
    assert [candidate["item_id"] for candidate in candidates] == ["fde", "black"]
    assert candidates[0]["icon_penalty"] == 0
    assert candidates[1]["icon_penalty"] > 0
    assert (output / "card.png").read_bytes() == (crops / "card.png").read_bytes()
    saved = json.loads((output / "icon-report.json").read_text(encoding="utf-8"))
    assert saved["cards"][0]["preview_columns"] == ["observed", "black", "fde"]


def test_identical_references_abstain(tmp_path):
    catalog, report, crops, cache = setup_case(tmp_path, identical=True)
    summary = apply_icon_evidence(catalog, report, crops, cache, tmp_path / "output")
    assert summary["cards"][0]["status"] == "ambiguous"
    assert summary["cards"][0]["reason"] == "variants_too_close_to_separate"
    assert all("icon_penalty" not in c for c in report["cards"][0]["candidates"])


def test_reference_that_barely_reaches_the_icon_area_abstains(tmp_path):
    # A three-line label leaves a thin strip of card, so a reference that fills its canvas
    # is judged on a fraction of itself. Rank it and the answer is mostly card chrome.
    rng = np.random.default_rng(3)
    wide = {}
    for key, tint in (("one", (1.0, 0.7, 0.5)), ("two", (0.5, 0.7, 1.0))):
        image = np.zeros((64, 64, 4), np.uint8)
        image[:, :, :3] = (rng.integers(40, 210, (64, 64, 3)) * np.array(tint)).clip(0, 255).astype(np.uint8)
        image[:, :, 3] = 255
        wide[key] = image
    catalog, report, crops, cache = setup_case(tmp_path, references=wide, card={"ocr_lines": [{}, {}, {}]})
    summary = apply_icon_evidence(catalog, report, crops, cache, tmp_path / "output")
    assert summary["supported_cards"] == 0
    assert summary["cards"][0]["reason"] == "reference_barely_overlaps_the_icon"


def test_missing_reference_cannot_make_the_only_loaded_variant_win(tmp_path):
    catalog, report, crops, _ = setup_case(tmp_path)
    cache = SimpleNamespace(
        get=lambda item: (
            (reference((85, 105, 125)), "cached") if item["id"] == "fde" else (None, "reference_not_cached")
        )
    )
    summary = apply_icon_evidence(catalog, report, crops, cache, tmp_path / "output")
    assert summary["cards"][0]["status"] == "insufficient_evidence"
    assert summary["cards"][0]["reason"] == "reference_missing_for_a_variant"
    assert all("icon_penalty" not in c for c in report["cards"][0]["candidates"])


def test_candidates_outside_the_tie_window_are_left_alone(tmp_path):
    catalog, report, crops, cache = setup_case(tmp_path)
    report["cards"][0]["candidates"][0]["text_similarity"] = 0.8
    summary = apply_icon_evidence(catalog, report, crops, cache, tmp_path / "output")
    assert summary["cards"] == []
    assert all("icon_match" not in c for c in report["cards"][0]["candidates"])


def test_tied_candidates_with_unrelated_short_names_are_still_compared(tmp_path):
    # OCR can leave two differently named parts tied, and the icon separates them even
    # though grouping by short name never would.
    references = {"sight": reference((85, 105, 125)), "handle": other_shape((85, 105, 125))}
    catalog, report, crops, cache = setup_case(tmp_path, references=references)
    report["cards"][0]["candidates"][1]["short_name"] = "MBUS RS"
    summary = apply_icon_evidence(catalog, report, crops, cache, tmp_path / "output")
    assert summary["cards"][0]["status"] == "supported"
    assert summary["cards"][0]["best_item_id"] == "sight"


def test_too_many_tied_candidates_abstains_without_downloading(tmp_path):
    references = {f"variant-{index}": reference((35 + index, 40, 45)) for index in range(9)}
    catalog, report, crops, _ = setup_case(tmp_path, references=references)
    fetched = []
    cache = SimpleNamespace(get=lambda item: fetched.append(item["id"]) or (references[item["id"]], "cached"))
    summary = apply_icon_evidence(catalog, report, crops, cache, tmp_path / "output")
    assert summary["cards"][0]["reason"] == "too_many_tied_candidates"
    assert fetched == []


@pytest.mark.parametrize("bad_crop", ["blank", "noise", "missing", "../outside.png", "corrupt"])
def test_unusable_crops_never_select_a_variant(tmp_path, bad_crop):
    catalog, report, crops, cache = setup_case(tmp_path)
    if bad_crop in ("blank", "noise"):
        image = (
            np.full((64, 64, 3), 30, np.uint8)
            if bad_crop == "blank"
            else np.random.default_rng(7).integers(0, 255, (64, 64, 3), dtype=np.uint8)
        )
        cv2.imencode(".png", image)[1].tofile(str(crops / "card.png"))
    elif bad_crop == "corrupt":
        (crops / "card.png").write_bytes(b"not an image")
    else:
        report["cards"][0]["crop"] = bad_crop
    summary = apply_icon_evidence(catalog, report, crops, cache, tmp_path / "output")
    assert summary["supported_cards"] == 0
    assert all("icon_penalty" not in c for c in report["cards"][0]["candidates"])


def test_reference_cache_offline_and_url_changes(tmp_path, monkeypatch):
    item = {"id": "item", "base_image_link": "https://assets.tarkov.dev/item-base-image.webp"}
    assert IconCache(tmp_path).get(item)[1] == "reference_not_cached"
    calls = []

    def fake_fetch(self, url, path):
        calls.append(url)
        path.parent.mkdir(parents=True, exist_ok=True)
        cv2.imencode(".png", reference((85, 105, 125)))[1].tofile(str(path))

    monkeypatch.setattr(IconCache, "_fetch", fake_fetch)
    cache = IconCache(tmp_path, download=True)
    assert cache.get(item)[0] is not None
    assert cache.get(item)[0] is not None
    assert len(calls) == 1
    assert IconCache(tmp_path).get(item)[0] is not None
    assert IconCache(tmp_path).get({**item, "base_image_link": item["base_image_link"] + "?v=2"})[0] is None


def test_cache_download_failure_abstains(tmp_path, monkeypatch):
    def fail(*_):
        raise OSError("unavailable")

    monkeypatch.setattr(IconCache, "_fetch", fail)
    image, status = IconCache(tmp_path, download=True).get(
        {"id": "item", "base_image_link": "https://assets.tarkov.dev/item.webp"}
    )
    assert image is None
    assert status.startswith("reference_unavailable")


def test_cache_rejects_non_asset_download_host(tmp_path):
    image, status = IconCache(tmp_path, download=True).get(
        {"id": "item", "base_image_link": "http://localhost/item.png"}
    )
    assert image is None
    assert "Unsupported reference host" in status


def test_failed_cache_write_leaves_no_partial_reference(tmp_path, monkeypatch):
    # A half written file at the cache path would read as "already downloaded" forever,
    # so the bytes land under a temporary name and only then take the real one.
    item = {"id": "item", "base_image_link": "https://assets.tarkov.dev/item.webp"}
    encoded = cv2.imencode(".png", reference((85, 105, 125)))[1].tobytes()

    class Response:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def raise_for_status(self):
            return None

        def iter_content(self, _):
            yield encoded

    requests = pytest.importorskip("requests")
    monkeypatch.setattr(requests, "get", lambda *a, **k: Response())
    monkeypatch.setattr("recognition.icons.os.replace", lambda *a: (_ for _ in ()).throw(OSError("disk full")))
    image, status = IconCache(tmp_path, download=True).get(item)
    assert image is None
    assert status.startswith("reference_unavailable")
    assert list(tmp_path.iterdir()) == []
