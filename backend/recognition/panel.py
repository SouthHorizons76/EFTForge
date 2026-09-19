"""Read displayed build stats and compare them at the screenshot's precision."""

import math
import re
import sqlite3
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

# Keep backend result keys so candidate comparisons can reuse stats._compute_stats.
FIELDS = {
    "total_ergo": ("ERGONOMICS", 1, ""),
    "accuracy_moa": ("ACCURACY", 2, "MOA"),
    "sighting_range": ("SIGHTING RANGE", 0, ""),
    "recoil_vertical": ("VERTICAL RECOIL", 0, ""),
    "recoil_horizontal": ("HORIZONTAL RECOIL", 0, ""),
}
ADVISORY_FIELDS = {"total_weight": ("WEIGHT", 3, "")}
MIN_CONFIDENCE = 0.85


def _bounds(line):
    box = line.get("box")
    if not box:
        return None
    return min(p[0] for p in box), min(p[1] for p in box), max(p[0] for p in box), max(p[1] for p in box)


def parse_panel(lines):
    fields = {}
    for key, (label, decimals, unit) in (FIELDS | ADVISORY_FIELDS).items():
        readings = []
        for line in lines:
            text = line["text"].strip().upper()
            label_match = re.search(r"\b" + r"\s*".join(label.split()) + r"\b", text)
            bounds = _bounds(line)
            if label_match is None or bounds is None:
                continue
            # Accept combined label/value OCR or a separate value on the same row to its right.
            numeric_lines = [(text[slice(label_match.end(), None)].strip(), float(line["score"]))]
            for other in lines:
                other_bounds = _bounds(other)
                if other is line or other_bounds is None:
                    continue
                row_distance = abs((bounds[1] + bounds[3] - other_bounds[1] - other_bounds[3]) / 2)
                if other_bounds[0] >= bounds[2] and row_distance <= max(4, (bounds[3] - bounds[1]) * 0.65):
                    numeric_lines.append(
                        (other["text"].strip().upper(), min(float(line["score"]), float(other["score"])))
                    )
            for raw, confidence in numeric_lines:
                # Reject extra digits/words instead of guessing which number the OCR intended.
                match = re.fullmatch(r"(\d+(?:[.,]\d+)?)\s*" + re.escape(unit), raw)
                if not match:
                    continue
                number = match[1].replace(",", ".")
                value = float(number)
                readings.append(
                    {
                        "value": value,
                        "confidence": confidence,
                        "raw_text": raw,
                        "display_decimals": decimals,
                        "unit": unit,
                    }
                )
        if readings:
            reading = max(readings, key=lambda r: r["confidence"])
            reading["status"] = "read" if reading["confidence"] >= MIN_CONFIDENCE else "low_confidence"
            if len({r["value"] for r in readings}) > 1:
                reading["status"] = "ambiguous"
                reading["alternatives"] = readings
            fields[key] = reading
    reliable = sum(fields.get(key, {}).get("status") == "read" for key in FIELDS)
    return {
        "status": "complete" if reliable == len(FIELDS) else "partial" if fields else "not_detected",
        "fields": fields,
        "ocr_lines": lines,
    }


def extract_panel(image, engine, output_dir):
    import cv2
    from .vision import read_text

    height, width = image.shape[:2]
    # Start with the lower-left info panel region in uncropped preset screenshots.
    x1, y1, x2, y2 = 0, int(height * 0.66), int(width * 0.215), int(height * 0.96)
    crop = image[slice(y1, y2), slice(x1, x2)]
    cv2.imencode(".png", crop)[1].tofile(str(Path(output_dir) / "stats-panel.png"))
    _, lines = read_text(engine, cv2.resize(crop, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC))
    result = parse_panel(lines)
    result.update(box=[x1, y1, x2 - x1, y2 - y1], crop="stats-panel.png", ocr_scale=3)
    return result


def compare_stats(panel, calculated=None):
    comparisons = {}
    for key, (_, decimals, _) in FIELDS.items():
        observed = panel.get("fields", {}).get(key, {})
        predicted = (calculated or {}).get(key)
        if observed.get("status") != "read" or predicted is None or not math.isfinite(float(predicted)):
            comparisons[key] = {"status": "insufficient_evidence"}
            continue
        # Allow half a display unit so hidden precision and tie rounding do not reject a build.
        tolerance = Decimal(1).scaleb(-decimals) / 2
        difference = Decimal(str(predicted)) - Decimal(str(observed["value"]))
        comparisons[key] = {
            "status": "agree" if abs(difference) <= tolerance else "differ",
            "observed": observed["value"],
            "calculated": predicted,
            "difference": float(difference),
            "tolerance": float(tolerance),
        }
    statuses = [row["status"] for row in comparisons.values()]
    status = (
        "stats_differ"
        if "differ" in statuses
        else ("stats_agree" if all(value == "agree" for value in statuses) else "insufficient_evidence")
    )
    observed_weight = panel.get("fields", {}).get("total_weight", {}).get("value")
    calculated_weight = (calculated or {}).get("total_weight")
    return {
        "status": status,
        "fields": comparisons,
        "compared_fields": sum(s != "insufficient_evidence" for s in statuses),
        "weight_is_advisory": True,
        "weight": {"observed": observed_weight, "calculated": calculated_weight},
        "note": "Stat agreement supports a candidate; it does not establish its identity or slot validity.",
    }


def evaluate_builds(db_path, catalog, report, builds):
    from stats import _compute_stats

    if not isinstance(builds, list):
        raise ValueError("Candidate builds must be a JSON list")
    results = []
    with sqlite3.connect(Path(db_path).resolve().as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        for build in builds:
            weapon_id = build.get("weapon_id", report["weapon_id"])
            attachments = build.get("attachment_ids")
            if weapon_id not in catalog.items or not catalog.items[weapon_id]["is_weapon"]:
                raise ValueError("Each candidate needs a valid weapon_id")
            if report["weapon_id"] and weapon_id != report["weapon_id"]:
                raise ValueError("Candidate weapon does not match the recognized weapon")
            if not isinstance(attachments, list) or not all(isinstance(item, str) for item in attachments):
                raise ValueError("Each candidate needs an attachment_ids list of item IDs")
            if not set(attachments).issubset(catalog.reachable(weapon_id)):
                raise ValueError("Candidate contains attachments unreachable from its weapon")
            items = {}
            for item_id in set(attachments) | {weapon_id}:
                row = db.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
                items[item_id] = SimpleNamespace(**dict(row))
            calculated = _compute_stats(items[weapon_id], attachments, items)
            comparison = compare_stats(report.get("stats_panel", {}), calculated)
            results.append(
                {
                    "name": build.get("name", str(len(results) + 1)),
                    "weapon_id": weapon_id,
                    "attachment_ids": attachments,
                    "calculated_stats": calculated,
                    "stat_comparison": comparison,
                    "slot_validity": "not_checked",
                }
            )
    # Rank comparable candidates by mismatch measured in display units; never declare a winner.
    for result in results:
        fields = result["stat_comparison"]["fields"].values()
        errors = [abs(row["difference"]) / (2 * row["tolerance"]) for row in fields if "difference" in row]
        result["display_unit_error"] = round(sum(errors), 4) if errors else None
    return sorted(
        results,
        key=lambda r: (
            -r["stat_comparison"]["compared_fields"],
            r["display_unit_error"] is None,
            r["display_unit_error"] or 0,
        ),
    )
