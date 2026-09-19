"""Compare ambiguous card candidates with cached transparent item references."""

import hashlib
import json
import os
import re
import shutil
from itertools import combinations
from pathlib import Path
from urllib.parse import urlparse

import cv2
import numpy as np

# Compare on a canvas larger than a 65px card. The mask has to be eroded to drop reference
# edge pixels that blended into the card background, and at card resolution that erosion
# eats most of a thin part such as a charging handle.
CANVAS = 96

# The card's chrome never belongs to the item: a border, the label band at the top whose
# height follows the wrapped line count, and the two status badges in the bottom corners.
# Badge colour tracks stock and purchase state, so leaving it in would hand a red cart to
# every red variant. Everything is a fraction of the card, so any screenshot scale works.
LABEL_BAND = {0: 0.156, 1: 0.234, 2: 0.422, 3: 0.578}
ICON_BOX = (0.063, 0.797, 0.922)  # left, bottom, right
BADGE_TOP = 0.672
BADGE_COLUMNS = ((0.047, 0.328), (0.688, 0.938))

# Alignment search. Keep the scale range tight: a reference allowed to shrink freely hides
# inside a quiet patch of card background and scores well on a few dozen pixels.
COARSE_SCALES = (0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15)
COARSE_OFFSETS = (-6, -3, 0, 3, 6)
FINE_SCALES = (-0.05, -0.025, 0.0, 0.025, 0.05)
FINE_OFFSETS = (-2, -1, 0, 1, 2)

MIN_COMPARED_FRACTION = 0.02  # of the canvas, so the floor follows CANVAS
MIN_COVERAGE = 0.35  # of the aligned reference that has to land on comparable card pixels
MIN_CONTRAST = 4.0  # grey levels; a flat crop or a flat reference carries no structure
SILHOUETTE_IOU = 0.92  # above this, two references are the same part in another colour

# Structure carries most of the evidence when the competing parts differ in shape, and
# none of it when they are one part in two colours, which is what the chroma term is for.
SHAPE_WEIGHT, COLOR_WEIGHT, CHROMA_WEIGHT = 0.55, 0.25, 0.2
COLOR_SCALE, CHROMA_SCALE = 0.12, 0.03

# Experimental gates, not calibrated probabilities.
MIN_SCORE = 0.67
MIN_SHAPE = 0.65
MAX_COLOR_ERROR = 0.10
MIN_MARGIN = 0.04

# Widen the tie window and icons start answering a question OCR already settled; narrow it
# and genuine variants drop out of the comparison.
GROUP_WINDOW = 0.02
MAX_GROUP = 8


class IconCache:
    def __init__(self, directory, download=False):
        self.directory = Path(directory)
        self.download = download
        self.loaded = {}

    def get(self, item):
        item_id = item["id"]
        if item_id in self.loaded:
            return self.loaded[item_id]
        url = item.get("base_image_link")
        if not url:
            result = (None, "missing_reference_url")
        elif not re.fullmatch(r"[a-zA-Z0-9_-]+", item_id):
            result = (None, "invalid_item_id")
        else:
            key = hashlib.sha256(url.encode()).hexdigest()[:16]
            path = self.directory / f"{item_id}-{key}.webp"
            try:
                if not path.exists() and self.download:
                    self._fetch(url, path)
                reference = read_image(path) if path.exists() else None
                if reference is None:
                    result = (None, "reference_not_cached")
                elif reference.ndim != 3 or reference.shape[2] != 4:
                    result = (None, "reference_has_no_alpha")
                else:
                    result = (reference, "cached")
            except (OSError, ValueError, cv2.error) as exc:
                result = (None, f"reference_unavailable: {exc}")
        self.loaded[item_id] = result
        return result

    def _fetch(self, url, path):
        try:
            import requests
        except ImportError as exc:
            raise OSError(f"Install requests to download references: {exc}") from exc

        # Fetch public catalog assets only, and never follow a redirect elsewhere.
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.netloc != "assets.tarkov.dev":
            raise ValueError("Unsupported reference host")
        try:
            with requests.get(
                url,
                headers={"User-Agent": "EFTForge"},
                timeout=(5, 15),
                stream=True,
                allow_redirects=False,
            ) as response:
                response.raise_for_status()
                if response.status_code != 200:
                    raise ValueError("Reference response was not an image download")
                data = bytearray()
                for chunk in response.iter_content(65536):
                    data.extend(chunk)
                    if len(data) > 4 * 1024 * 1024:
                        raise ValueError("Reference exceeds 4 MiB")
        except requests.RequestException as exc:
            raise OSError(f"Reference download failed: {type(exc).__name__}") from exc
        decoded = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
        if decoded is None or decoded.ndim != 3 or decoded.shape[2] != 4:
            raise ValueError("Reference is not a transparent image")
        self.directory.mkdir(parents=True, exist_ok=True)
        # Write through a temporary name so an interrupted run cannot leave a half file
        # that later looks cached. Cache keys include the source URL.
        pending = path.with_name(path.name + f".{os.getpid()}.part")
        try:
            pending.write_bytes(data)
            os.replace(pending, path)
        finally:
            pending.unlink(missing_ok=True)


def read_image(path):
    return cv2.imdecode(np.frombuffer(Path(path).read_bytes(), dtype=np.uint8), cv2.IMREAD_UNCHANGED)


def _canvas(reference, size=CANVAS):
    height, width = reference.shape[:2]
    scale = size / max(height, width)
    width, height = max(1, round(width * scale)), max(1, round(height * scale))
    small = cv2.resize(reference, (width, height), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((size, size, 4), dtype=np.uint8)
    x, y = (size - width) // 2, (size - height) // 2
    canvas[slice(y, y + height), slice(x, x + width)] = small
    return canvas


def usable_region(size, label_lines):
    """Mask the card pixels that can show the item, in canvas coordinates."""
    left, bottom, right = ICON_BOX
    mask = np.zeros((size, size), dtype=bool)
    top = round(size * LABEL_BAND.get(min(max(label_lines, 0), 3), LABEL_BAND[3]))
    mask[slice(top, round(size * bottom)), slice(round(size * left), round(size * right))] = True
    for first, last in BADGE_COLUMNS:
        mask[slice(round(size * BADGE_TOP), size), slice(round(size * first), round(size * last))] = False
    return mask


def _warp(template, scale, dx, dy):
    size = template.shape[0]
    centre = size / 2 * (1 - scale)
    matrix = np.float32([[scale, 0, centre + dx], [0, scale, centre + dy]])
    return cv2.warpAffine(template, matrix, (size, size))


def _measure(source, aligned, usable, kernel):
    """Score one placement of one reference, or return None when it cannot be judged."""
    opaque = cv2.erode((aligned[:, :, 3] >= 240).astype(np.uint8), kernel) > 0
    visible = int(opaque.sum())
    mask = opaque & usable
    compared = int(mask.sum())
    if not visible or compared < round(MIN_COMPARED_FRACTION * usable.size):
        return None
    observed, expected = source[mask], aligned[:, :, :3][mask].astype(np.float32)
    observed_gray, expected_gray = observed.mean(axis=1), expected.mean(axis=1)
    if min(float(observed_gray.std()), float(expected_gray.std())) < MIN_CONTRAST:
        return None
    shape = max(0.0, float(np.corrcoef(observed_gray, expected_gray)[0, 1]))
    # Card lighting washes the render out against the flat catalog asset, so a tan part and
    # a grey one end up only a few levels apart overall while their channel balance still
    # separates cleanly. Measure both: how far the colour is off, and which way it leans.
    difference = np.abs(observed - expected).mean(axis=1)
    balance = np.abs((observed - observed_gray[:, None]) - (expected - expected_gray[:, None])).mean(axis=1)
    # Drop the worst tenth of the pixels. A connector line crossing the card, a blended
    # edge, or a single specular highlight should not outweigh the body of the part.
    keep = max(1, int(compared * 0.9))
    color_error = float(np.sort(difference)[:keep].mean() / 255)
    chroma_error = float(np.sort(balance)[:keep].mean() / 255)
    agreement = (
        SHAPE_WEIGHT * shape
        + COLOR_WEIGHT * float(np.exp(-color_error / COLOR_SCALE))
        + CHROMA_WEIGHT * float(np.exp(-chroma_error / CHROMA_SCALE))
    )
    return {
        "score": round(agreement, 4),
        "shape_score": round(shape, 4),
        "color_error": round(color_error, 4),
        "chroma_error": round(chroma_error, 4),
        "compared_pixels": compared,
        "coverage": round(compared / visible, 4),
        "mask": mask,
        "aligned": aligned,
    }


def _search(source, usable, templates, kernel, objective):
    """Find the placement that maximizes `objective` across every template at once."""
    best = None

    def consider(scale, dx, dy):
        nonlocal best
        measured = [_measure(source, _warp(template, scale, dx, dy), usable, kernel) for template in templates]
        if any(entry is None for entry in measured):
            return
        value = objective(measured)
        if best is None or value > best[0]:
            best = (value, (scale, dx, dy), measured)

    for scale in COARSE_SCALES:
        for dx in COARSE_OFFSETS:
            for dy in COARSE_OFFSETS:
                consider(scale, dx, dy)
    if best is None:
        return None
    scale, dx, dy = best[1]
    for offset in FINE_SCALES:
        for step_x in FINE_OFFSETS:
            for step_y in FINE_OFFSETS:
                consider(round(scale + offset, 4), dx + step_x, dy + step_y)
    return best


def _silhouettes_agree(templates):
    """Decide whether the references are one part rendered in several colours."""
    masks = [template[:, :, 3] >= 240 for template in templates]
    for first, second in combinations(masks, 2):
        union = int((first | second).sum())
        if not union or int((first & second).sum()) / union < SILHOUETTE_IOU:
            return False
    return True


def compare_group(crop, references, label_lines=1):
    """Compare one card crop against competing references on equal terms.

    References that differ only in colour are placed once, together, so the colour
    evidence comes from the same pixels. Fitting each one separately would answer a
    colour question by comparing two different crops of the card.
    """
    source = cv2.resize(crop[:, :, :3], (CANVAS, CANVAS), interpolation=cv2.INTER_AREA).astype(np.float32)
    usable = usable_region(CANVAS, label_lines)
    kernel = np.ones((3, 3), np.uint8)
    templates = [_canvas(reference) for reference in references]
    shared = len(templates) > 1 and _silhouettes_agree(templates)
    if shared:
        # Let structure alone place the group. Deciding the placement on the full score
        # would let one variant's colour choose the pixels its own colour is judged on.
        found = _search(source, usable, templates, kernel, lambda m: max(e["shape_score"] for e in m))
        results = [None] * len(templates) if found is None else found[2]
        placements = [found[1] if found else None] * len(templates)
    else:
        results, placements = [], []
        for template in templates:
            found = _search(source, usable, [template], kernel, lambda m: m[0]["score"])
            results.append(found[2][0] if found else None)
            placements.append(found[1] if found else None)
    compared = []
    for result, placement in zip(results, placements):
        if result is None:
            compared.append(None)
            continue
        preview = source.astype(np.uint8).copy()
        preview[result["mask"]] = result["aligned"][:, :, :3][result["mask"]]
        compared.append(
            {
                **{key: value for key, value in result.items() if key not in ("mask", "aligned")},
                "scale": placement[0],
                "offset": [placement[1], placement[2]],
                "alignment": "shared" if shared else "independent",
                "preview": preview,
            }
        )
    return compared


def compare_icon(card, reference, label_lines=1):
    """Return separate color and structure evidence plus the aligned preview."""
    return compare_group(card, [reference], label_lines)[0]


def _tied_group(candidates):
    """Take the candidates OCR could not separate: everything inside the tie window."""
    best = max(candidate["text_similarity"] for candidate in candidates)
    return [candidate for candidate in candidates if candidate["text_similarity"] >= best - GROUP_WINDOW]


def _load_crop(card, crops_dir):
    name = card.get("crop") or ""
    if not name:
        return None, "card_crop_unavailable"
    path = (crops_dir / name).resolve()
    if not path.is_relative_to(crops_dir) or not path.is_file():
        return None, "card_crop_unavailable"
    try:
        crop = read_image(path)
    except (OSError, cv2.error):
        crop = None
    if crop is None or crop.ndim != 3 or crop.shape[2] < 3:
        return None, "invalid_card_crop"
    return (path, crop), None


def _decide(evidence, scored, group, attempted):
    """Apply the gates, and record which one abstained so a run can be diagnosed."""
    if len(scored) < attempted:
        uncompared = [match for match in evidence["matches"] if "score" not in match]
        evidence["reason"] = (
            "reference_missing_for_a_variant"
            if any(match["reference_status"] != "cached" for match in uncompared)
            else "not_all_variants_comparable"
        )
        return
    best, runner_up = scored[0], scored[1]
    margin = best["score"] - runner_up["score"]
    evidence.update(best_item_id=best["item_id"], margin=round(margin, 4))
    evidence["status"] = "ambiguous"
    if best["coverage"] < MIN_COVERAGE:
        evidence["reason"] = "reference_barely_overlaps_the_icon"
    elif best["shape_score"] < MIN_SHAPE or best["score"] < MIN_SCORE:
        # Either none of these variants is installed here, or the card shows the part with
        # its own children fitted, which no bare reference can explain.
        evidence["reason"] = "no_variant_explains_the_icon"
    elif best["color_error"] > MAX_COLOR_ERROR:
        evidence["reason"] = "color_disagrees"
    elif margin < MIN_MARGIN:
        evidence["reason"] = "variants_too_close_to_separate"
    else:
        evidence.pop("reason", None)
        evidence["status"] = "supported"
        for candidate in group:
            # Preserve alternatives, but penalize visually contradicted variants in the
            # beam before duplicate templates can consume its capacity.
            candidate["icon_penalty"] = round(best["score"] - candidate["icon_match"]["score"], 4)


def apply_icon_evidence(catalog, report, crops_dir, cache, output_dir):
    """Rerank the candidates OCR left tied, but only when every one was comparable."""
    crops_dir, output_dir = Path(crops_dir).resolve(), Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    summary = {"compared_cards": 0, "supported_cards": 0, "cards": [], "mode": "tied_candidates"}
    for card in report["cards"]:
        candidates = card["candidates"]
        for candidate in candidates:
            candidate.pop("icon_penalty", None)
            candidate.pop("icon_match", None)
        card.pop("icon_evidence", None)
        if len(candidates) < 2:
            continue
        group = _tied_group(candidates)
        if len(group) < 2:
            continue
        evidence = {"card_index": card["card_index"], "status": "insufficient_evidence", "matches": []}
        card["icon_evidence"] = evidence
        summary["cards"].append(evidence)
        if len(group) > MAX_GROUP:
            evidence["reason"] = "too_many_tied_candidates"
            continue
        loaded, problem = _load_crop(card, crops_dir)
        if problem:
            evidence["reason"] = problem
            continue
        crop_path, crop = loaded
        # Preserve compared crops so an icon replay can itself be replayed offline.
        saved_crop = output_dir / crop_path.relative_to(crops_dir)
        if saved_crop.resolve() != crop_path:
            saved_crop.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(crop_path, saved_crop)
        references = []
        for candidate in group:
            reference, status = cache.get(catalog.items[candidate["item_id"]])
            match = {"item_id": candidate["item_id"], "name": candidate["name"], "reference_status": status}
            candidate["icon_match"] = match
            evidence["matches"].append(match)
            references.append(reference)
        previews, preview_columns = [crop[:, :, :3]], ["observed"]
        if all(reference is not None for reference in references):
            lines = max(1, len(card.get("ocr_lines", []) or []))
            for match, compared in zip(evidence["matches"], compare_group(crop, references, lines)):
                if compared is None:
                    continue
                previews.append(compared.pop("preview"))
                preview_columns.append(match["item_id"])
                match.update(compared)
        scored = sorted([match for match in evidence["matches"] if "score" in match], key=lambda m: -m["score"])
        if scored:
            summary["compared_cards"] += 1
        _decide(evidence, scored, group, len(evidence["matches"]))
        if evidence["status"] == "supported":
            summary["supported_cards"] += 1
            # Keep every alternative, but let supported evidence lead its own tie so the
            # report reads the same way with and without reconstruction.
            candidates.sort(
                key=lambda row: (
                    -row["text_similarity"],
                    row.get("icon_penalty", 0.0),
                    not row.get("literal_exact", False),
                    row["item_id"],
                )
            )
        preview_name = f"icon-card-{card['card_index']:03d}.png"
        strip = [cv2.resize(tile, (192, 192), interpolation=cv2.INTER_NEAREST) for tile in previews]
        cv2.imencode(".png", np.concatenate(strip, axis=1))[1].tofile(str(output_dir / preview_name))
        evidence["preview"] = preview_name
        evidence["preview_columns"] = preview_columns
    (output_dir / "icon-report.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    report["icon_recognition"] = summary
    return summary
