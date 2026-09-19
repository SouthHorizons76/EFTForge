"""Retain visible border fragments as overlap hypotheses for manual review."""


def find_overlap_regions(image, cards):
    import cv2
    import numpy as np

    height, width = image.shape[:2]
    scale = height / 1080
    side = round(65 * scale)
    edges = cv2.Canny(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), 15, 40)
    vertical = cv2.morphologyEx(edges, cv2.MORPH_OPEN, np.ones((max(10, round(40 * scale)), 1), np.uint8))
    contours, _ = cv2.findContours(vertical, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    left_edges = [cv2.boundingRect(contour) for contour in contours]
    kernel = max(2, round(3 * scale))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((kernel, kernel), np.uint8))
    contours, _ = cv2.findContours(closed, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    regions = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        # Look for a tall narrow visible strip beside a full-height left card edge.
        if not (12 * scale <= w <= 42 * scale and 55 * scale <= h <= 72 * scale):
            continue
        if cv2.contourArea(contour) < w * h * 0.45:
            continue
        if not (width * 0.12 < x < width * 0.94 and height * 0.12 < y < height * 0.88):
            continue
        for lx, ly, _, lh in left_edges:
            span = x + w - lx
            if not (side * 1.15 <= span <= side * 1.8 and abs(ly - y) <= 4 * scale and abs(lh - h) <= 6 * scale):
                continue
            if not 55 * scale <= lh <= 72 * scale:
                continue
            box = [lx, min(y, ly), span, max(h, lh)]
            possible = [[lx, ly, side, side], [x + w - side, y, side, side]]
            # Avoid review regions already covered by two separately recognized cards.
            if all(
                any(abs(c["box"][0] - px) < 10 * scale and abs(c["box"][1] - py) < 10 * scale for c in cards)
                for px, py, _, _ in possible
            ):
                continue
            if any(abs(r["box"][0] - lx) < 10 * scale and abs(r["box"][1] - y) < 10 * scale for r in regions):
                continue
            regions.append(
                {
                    "box": box,
                    "possible_card_boxes": possible,
                    "status": "unresolved_overlap",
                    "reason": "Aligned card-height borders with a narrow exposed strip; two cards are a hypothesis.",
                    "requires_review": True,
                }
            )
    return sorted(regions, key=lambda region: (region["box"][1], region["box"][0]))


def extract_overlap_regions(image, cards, engine, output_dir):
    from pathlib import Path
    import cv2
    from .vision import read_text

    regions = find_overlap_regions(image, cards)
    for index, region in enumerate(regions):
        x, y, w, h = region["box"]
        crop = image[slice(y, y + h), slice(x, x + w)]
        filename = f"overlap-{index:03d}.png"
        cv2.imencode(".png", crop)[1].tofile(str(Path(output_dir) / filename))
        region["crop"] = filename
        region["fragments"] = []
        # Keep fragments separate; do not concatenate names from two overlapping cards.
        label_crop = crop[slice(0, max(1, round(h * 0.45))), :]
        _, lines = read_text(engine, cv2.resize(label_crop, None, fx=5, fy=5, interpolation=cv2.INTER_CUBIC))
        for line in lines:
            region["fragments"].append({"text": line["text"], "confidence": line["score"], "box": line["box"]})
        region["ocr_scale"] = 5
    return regions
