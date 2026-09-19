"""Extract inspectable card crops and OCR observations from preset screenshots."""

from itertools import combinations
from pathlib import Path
import re

INTERFACE_LABELS = {
    "handguard",
    "magazine",
    "back",
    "mount",
    "receiver",
    "bolt",
    "stock",
    "pistgrip",
    "pistolgrip",
    "gasblock",
    "barrel",
    "ubgl",
    "launcher",
    "charginghandle",
    "muzzle",
    "foregrip",
    "scope",
    "sight",
    "tactical",
    "auxiliary",
}


def is_interface_label(text):
    # Normalize punctuation equally for card OCR and full-frame fallback OCR.
    normalized = re.sub(r"[\W_]+", "", text.casefold())
    if normalized in INTERFACE_LABELS:
        return True
    # The weapon model clips slot overlays, so OCR returns fragments such as RECE or ARD/ER.
    # Treat text as an overlay only when every word is part of some slot label, which keeps
    # item names like Stock Pad and Mount Adapter that pair a slot word with a foreign word.
    words = [word for word in re.split(r"[\W_]+", text.casefold()) if len(word) >= 2]
    if not words or max(len(word) for word in words) < 3:
        return False
    return all(any(word in label for label in INTERFACE_LABELS) for word in words)


def detect_cards(image):
    import cv2
    import numpy as np

    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 35, 100)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    scale = height / 1080
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        # Start with the roughly square 65px cards in a 1080p preset screenshot.
        if not (48 * scale <= w <= 85 * scale and 48 * scale <= h <= 85 * scale):
            continue
        if not (0.8 <= w / h <= 1.25 and x > width * 0.12 and y > height * 0.12):
            continue
        if cv2.contourArea(contour) < w * h * 0.65:
            continue
        candidates.append((x, y, w, h))

    # Recover cards whose border is interrupted by connector lines or the weapon.
    # Pair long horizontal or vertical segments instead of requiring one closed contour.
    lines = cv2.HoughLinesP(
        edges,
        1,
        np.pi / 180,
        threshold=max(15, round(25 * scale)),
        minLineLength=max(20, round(34 * scale)),
        maxLineGap=max(4, round(12 * scale)),
    )
    horizontal = []
    vertical = []
    if lines is not None:
        for line in lines:
            x1, y1, x2, y2 = map(int, line)
            dx, dy = abs(x2 - x1), abs(y2 - y1)
            if dy <= 3 * scale and 42 * scale <= dx <= 85 * scale:
                horizontal.append((min(x1, x2), round((y1 + y2) / 2), dx))
            if dx <= 3 * scale and 42 * scale <= dy <= 85 * scale:
                vertical.append((round((x1 + x2) / 2), min(y1, y2), dy))

    minimum_side, maximum_side = 52 * scale, 78 * scale
    for (x1, y1, length1), (x2, y2, length2) in combinations(horizontal, 2):
        side = abs(y2 - y1)
        overlap = min(x1 + length1, x2 + length2) - max(x1, x2)
        if minimum_side <= side <= maximum_side and overlap >= 35 * scale:
            x = min(x1, x2)
            candidates.append((x, min(y1, y2), round(max(length1, length2, side)), round(side)))
    for (x1, y1, length1), (x2, y2, length2) in combinations(vertical, 2):
        side = abs(x2 - x1)
        overlap = min(y1 + length1, y2 + length2) - max(y1, y2)
        if minimum_side <= side <= maximum_side and overlap >= 35 * scale:
            y = min(y1, y2)
            candidates.append((min(x1, x2), y, round(side), round(max(length1, length2, side))))

    # A top-left or bottom-left corner is useful when the opposite edges are hidden.
    expected_side = round(65 * scale)
    for hx, hy, _ in horizontal:
        for vx, vy, vlength in vertical:
            if abs(hx - vx) > 4 * scale:
                continue
            if abs(hy - vy) <= 4 * scale:
                candidates.append((min(hx, vx), min(hy, vy), expected_side, expected_side))
            elif abs(hy - (vy + vlength)) <= 4 * scale:
                candidates.append((min(hx, vx), round(hy - expected_side), expected_side, expected_side))
    boxes = []
    for box in sorted(
        candidates,
        key=lambda b: (abs(b[2] - b[3]) + abs((b[2] + b[3]) / 2 - 65 * scale), b[1], b[0]),
    ):
        x, y, w, h = box
        if x < width * 0.12 or y < height * 0.12 or x + w >= width or y + h >= height:
            continue
        duplicate = False
        for bx, by, bw, bh in boxes:
            intersection = max(0, min(x + w, bx + bw) - max(x, bx)) * max(0, min(y + h, by + bh) - max(y, by))
            union = w * h + bw * bh - intersection
            if (union and intersection / union >= 0.3) or (abs(x - bx) < 10 * scale and abs(y - by) < 10 * scale):
                duplicate = True
                break
        if duplicate:
            continue
        boxes.append(box)
    return sorted(boxes, key=lambda b: (b[1], b[0]))


def read_text(engine, image):
    # Pass every stage explicitly because RapidOCR retains per-call stage overrides.
    result = engine(image, use_det=True, use_cls=True, use_rec=True)
    if result.txts is None:
        return "", []
    lines = [
        {"text": text, "score": float(score), "box": box.tolist()}
        for text, score, box in zip(result.txts, result.scores, result.boxes)
    ]
    lines.sort(key=lambda line: (min(point[1] for point in line["box"]), min(point[0] for point in line["box"])))
    return " ".join(line["text"] for line in lines), lines


def read_label(engine, image):
    import cv2

    enlarged = cv2.resize(image, None, fx=5, fy=5, interpolation=cv2.INTER_CUBIC)
    text, lines = read_text(engine, enlarged)
    if text:
        return text, lines
    # The detector often skips two-character labels such as DP; recognize the whole strip directly.
    result = engine(enlarged, use_det=False, use_cls=False, use_rec=True)
    if result.txts and result.scores[0] >= 0.65:
        return result.txts[0].strip(), [{"text": result.txts[0], "score": float(result.scores[0]), "box": None}]
    return "", []


# Across the sampled builds every real card scored at least 0.87, while text painted on the
# weapon model and readings inside the stats panel scored 0.57 or fitted no border at all.
MIN_BORDER_SUPPORT = 0.75


def group_label_lines(lines, scale):
    """Join OCR lines stacked inside one card label so a wrapped name stays whole.

    Full-frame OCR returns one entry per rendered line, so a card labelled "UCS CR"
    arrives as "UCS" above "CR". Treating those as two cards loses the real name and
    lets the shorter fragment match the wrong compatible attachment.
    """
    blocks = []
    for line in sorted(lines, key=lambda row: (row["top"], row["left"])):
        for block in blocks:
            overlap = min(block["right"], line["right"]) - max(block["left"], line["left"])
            narrower = max(1, min(block["right"] - block["left"], line["right"] - line["left"]))
            # A wrapped label continues directly below and shares the card's left alignment.
            if (
                overlap >= narrower * 0.4
                and -2 * scale <= line["top"] - block["bottom"] <= 7 * scale
                and line["bottom"] - block["top"] <= 34 * scale
            ):
                block["texts"].append(line["text"])
                block["score"] = min(block["score"], line["score"])
                block["left"] = min(block["left"], line["left"])
                block["right"] = max(block["right"], line["right"])
                block["bottom"] = max(block["bottom"], line["bottom"])
                break
        else:
            blocks.append({**line, "texts": [line["text"]]})
    return [
        {"text": " ".join(block["texts"]).strip(), "score": block["score"], "left": block["left"], "top": block["top"]}
        for block in blocks
    ]


def _box_overlap(first, second):
    ax, ay, aw, ah = first
    bx, by, bw, bh = second
    intersection = max(0, min(ax + aw, bx + bw) - max(ax, bx)) * max(0, min(ay + ah, by + bh) - max(ay, by))
    return intersection / min(aw * ah, bw * bh)


def _label_key(text):
    return re.sub(r"[\W_]+", "", text.casefold())


def _extends(existing, replacement):
    # A wrapped label continues to the right and below, so a longer reading must start with
    # the text it replaces. Prepended characters are the card's corner icon, not a name.
    old, new = _label_key(existing), _label_key(replacement)
    return len(new) > len(old) and new.startswith(old)


def extract(image_path, output_dir, label_validator=None):
    import cv2
    import numpy as np
    from rapidocr import RapidOCR

    image = cv2.imdecode(np.fromfile(str(image_path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Cannot decode image: {image_path}")
    height, width = image.shape[:2]
    if width * height > 24_000_000 or min(width, height) < 300:
        raise ValueError("Use a screenshot between 300px per side and 24 megapixels")
    engine = RapidOCR()
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    from .panel import extract_panel

    stats_panel = extract_panel(image, engine, output_dir)
    # Keep the input beside the report so every run can be reproduced and retuned.
    cv2.imencode(".png", image)[1].tofile(str(output_dir / "source.png"))
    # Read the weapon subtitle below WEAPON BUILDS, excluding the checkbox row.
    title = image[slice(int(height * 0.053), int(height * 0.081)), slice(int(width * 0.25), int(width * 0.75))]
    weapon_text, title_lines = read_text(engine, cv2.resize(title, None, fx=3, fy=3))
    from .borders import CardBorderFitter

    scale = height / 1080
    side = round(65 * scale)
    fitter = CardBorderFitter(image)

    def label_strip(crop, fraction):
        # Keep the top label region, clear of the border and the lower status badges.
        inset = max(2, round(3 * scale))
        bottom = max(inset + 1, int(crop.shape[0] * fraction))
        return crop[slice(inset, bottom), slice(inset, max(inset + 1, crop.shape[1] - inset))]

    def read_card(box, fallback_text=None, fallback_lines=()):
        # Snap to the four visible borders first; a box offset by a few pixels crops the
        # label and turns MCX GEN1 into MCX, which then matches a different attachment.
        fitted = fitter.fit(box)
        x, y, w, h = fitted["box"] if fitted else box
        if x < width * 0.12 or y < height * 0.12 or x + w >= width or y + h >= height:
            return None
        crop = image[slice(y, y + h), slice(x, x + w)]
        text, lines = read_label(engine, label_strip(crop, 0.49))
        # A label that already wrapped can wrap once more, as BA Hanson 13.7" does. Read a
        # taller strip and keep it only when it extends the first reading, so that the item
        # icon below the label can never add characters of its own.
        if len(lines) >= 2:
            taller, taller_lines = read_label(engine, label_strip(crop, 0.62))
            if _extends(text, taller):
                text, lines = taller, taller_lines
        if fallback_text is not None and not _extends(fallback_text, text):
            text, lines = fallback_text, list(fallback_lines)
        return {
            "text": text,
            "box": [x, y, w, h],
            "crop_image": crop,
            "ocr_lines": lines,
            "border_support": fitted["border_support"] if fitted else None,
        }

    def accept(card):
        if not any(character.isalpha() for character in card["text"]) or is_interface_label(card["text"]):
            return False
        return label_validator is None or label_validator(card["text"], weapon_text)

    panel_x, panel_y, panel_w, panel_h = stats_panel.get("box", (0, height, 0, 0))

    def in_interface(x, y):
        # The stats panel and the bottom navigation bar are interface text, never cards.
        if panel_x <= x <= panel_x + panel_w and panel_y <= y <= panel_y + panel_h:
            return True
        return y > height * 0.93

    detected = []
    unverified = []

    def add(card, source):
        # A name painted on the weapon model reads like an attachment but has no card around
        # it. Require the fitted border before trusting a detection, and keep what fails for
        # review instead of dropping it, because a hidden border is not an empty slot.
        x, y = card["box"][0], card["box"][1]
        support = card["border_support"]
        if in_interface(x, y) or support is None or support < MIN_BORDER_SUPPORT:
            unverified.append({**card, "source": source})
            return
        existing = next((row for row in detected if _box_overlap(row["box"], card["box"]) >= 0.45), None)
        if existing is None:
            detected.append({**card, "source": source})
        elif _extends(existing["text"], card["text"]):
            existing.update(text=card["text"], ocr_lines=card["ocr_lines"], source="merged")

    for box in detect_cards(image):
        card = read_card(box)
        if card is not None and accept(card):
            add(card, "card_border")

    # Full-frame OCR can find labels whose card border is hidden by the weapon model.
    # Anchor a standard card around those labels, then let the same validator reject UI text.
    full_result = engine(image, use_det=True, use_cls=True, use_rec=True)
    full_texts = full_result.txts if full_result.txts is not None else ()
    full_scores = full_result.scores if full_result.scores is not None else ()
    full_boxes = full_result.boxes if full_result.boxes is not None else ()
    full_lines = []
    for text, score, box in zip(full_texts, full_scores, full_boxes):
        if not text.strip() or score < 0.65:
            continue
        points = box.tolist()
        full_lines.append(
            {
                "text": text.strip(),
                "score": float(score),
                "left": min(point[0] for point in points),
                "right": max(point[0] for point in points),
                "top": min(point[1] for point in points),
                "bottom": max(point[1] for point in points),
            }
        )
    for block in group_label_lines(full_lines, scale):
        label = block["text"]
        if is_interface_label(label) or block["left"] < width * 0.12 or block["top"] < height * 0.12:
            continue
        if in_interface(block["left"], block["top"]):
            continue
        if label_validator is not None and not label_validator(label, weapon_text):
            continue
        lines = [{"text": label, "score": block["score"], "box": None}]
        card = read_card((round(block["left"] - 8 * scale), round(block["top"] - 8 * scale), side, side), label, lines)
        if card is not None and accept(card):
            add(card, "full_frame")

    cards = []
    overlay = image.copy()
    detected.sort(key=lambda card: (card["box"][1], card["box"][0]))
    for index, card in enumerate(detected):
        x, y, w, h = card["box"]
        crop_name = f"card-{index:03d}.png"
        cv2.imencode(".png", card.pop("crop_image"))[1].tofile(str(output_dir / crop_name))
        cards.append({**card, "crop": crop_name})
        cv2.rectangle(overlay, (x, y), (x + w, y + h), (0, 255, 0), 1)
        cv2.putText(overlay, str(index), (x, y - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 0), 1)
    cv2.imencode(".png", overlay)[1].tofile(str(output_dir / "detected-cards.png"))
    from .overlap import extract_overlap_regions

    review_regions = extract_overlap_regions(image, cards, engine, output_dir)
    # A weaker second detection of a card that was already accepted is a duplicate, not an
    # unverified name, so it must not raise a review region of its own.
    unverified = [
        card for card in unverified if not any(_box_overlap(card["box"], row["box"]) >= 0.45 for row in cards)
    ]
    unverified.sort(key=lambda card: (card["box"][1], card["box"][0]))
    for index, card in enumerate(unverified):
        crop_name = f"unverified-{index:03d}.png"
        cv2.imencode(".png", card["crop_image"])[1].tofile(str(output_dir / crop_name))
        review_regions.append(
            {
                "box": card["box"],
                "status": "unverified_card",
                "reason": (
                    "A name was read here but no card border supports it. Expect text printed on the "
                    "weapon model or interface text; a card hidden behind the weapon is also possible."
                ),
                "requires_review": True,
                "crop": crop_name,
                "source": card["source"],
                "border_support": card["border_support"],
                "fragments": [{"text": card["text"], "confidence": None, "box": None}],
            }
        )
    labels = {"unverified_card": "no border?"}
    for region in review_regions:
        x, y, w, h = region["box"]
        cv2.rectangle(overlay, (x, y), (x + w, y + h), (0, 180, 255), 2)
        caption = labels.get(region.get("status"), "overlap?")
        cv2.putText(overlay, caption, (x, y - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 180, 255), 1)
    cv2.imencode(".png", overlay)[1].tofile(str(output_dir / "review-regions.png"))
    return {
        "weapon_text": weapon_text,
        "weapon_ocr_lines": title_lines,
        "cards": cards,
        "image_size": [width, height],
        "stats_panel": stats_panel,
        "review_regions": review_regions,
    }
