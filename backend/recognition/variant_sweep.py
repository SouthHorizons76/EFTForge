"""Ask, for every tied variant group in the catalog, whether icons can pick the right one.

The hand-checked cards in tests/data cover 22 real cards. That is too few to steer
thresholds by: a 112px comparison canvas scores worse than either 96 or 128 on them, which
is noise. This sweep trades realism for scale. It builds a card from each reference and
asks the matcher to pick that reference back out of its group, over every group in the
catalog, which is a few hundred times more cases and needs no screenshots.

Read the result as an upper bound. The card is synthesised from the same image the matcher
compares against, so nothing here sees game-render-versus-catalog-asset drift, or a card
showing a part with its own children fitted. What it does see is which variants are
inherently inseparable at screenshot resolution, and whether the gates ever name the wrong
one once there are hundreds of chances to.

    python -m recognition.variant_sweep --download --output sweep.json
"""

import argparse
import collections
import json
import time
from pathlib import Path

import cv2
import numpy as np

from .catalog import Catalog, normalize
from .icons import CANVAS, IconCache, _canvas, _decide, _warp, compare_group

CARD_PIXELS = 68  # a preset card at 1920x1080, the resolution the matcher actually gets

# Tuned so a card matched against its own reference lands where real cards land: the
# hand-checked set gives shape 0.95 to 0.97, colour error around 0.025 and chroma error
# around 0.0035. Drift from those and the sweep stops predicting anything.
PLACEMENT_SCALE = (0.92, 0.98)
PLACEMENT_OFFSET = 3
LIGHTING_GAIN = (0.88, 1.12)
CAST_SIGMA = 2.0
BLUR_SIGMA = 0.6
LUMA_NOISE, CHROMA_NOISE = 3.0, 0.8
CONNECTOR_CHANCE = 0.4


def variant_groups(catalog):
    """Every set of reachable attachments a weapon offers under one short name."""
    groups = {}
    for weapon_id, item in catalog.items.items():
        if not item["is_weapon"]:
            continue
        by_name = collections.defaultdict(set)
        for reachable_id in catalog.reachable(weapon_id):
            name = normalize(catalog.items[reachable_id]["short_name"] or "")
            if name:
                by_name[name].add(reachable_id)
        for name, ids in by_name.items():
            if len(ids) > 1:
                groups.setdefault((name, tuple(sorted(ids))), set()).add(weapon_id)
    return [{"short_name": name, "item_ids": list(ids), "weapons": len(w)} for (name, ids), w in groups.items()]


def render_card(reference, rng):
    """Put a reference on a card the way the game does, then knock it about the way a
    screenshot does: misplaced slightly, relit, softened, resampled and crossed by a line."""
    placed = _warp(
        _canvas(reference, CANVAS),
        rng.uniform(*PLACEMENT_SCALE),
        rng.integers(-PLACEMENT_OFFSET, PLACEMENT_OFFSET + 1),
        rng.integers(-PLACEMENT_OFFSET, PLACEMENT_OFFSET + 1),
    )
    alpha = placed[:, :, 3:4].astype(np.float32) / 255
    background = np.full((CANVAS, CANVAS, 3), (48, 36, 28), np.float32)
    background += np.linspace(-6, 10, CANVAS, dtype=np.float32)[:, None, None]
    card = placed[:, :, :3].astype(np.float32) * alpha + background * (1 - alpha)
    # Card lighting is not the flat lighting of the catalog asset.
    card *= rng.uniform(*LIGHTING_GAIN)
    card += rng.normal(0, CAST_SIGMA, (1, 1, 3))
    card = cv2.GaussianBlur(card, (0, 0), BLUR_SIGMA)
    # Keep the noise mostly shared across channels. Independent per-channel noise invents
    # chroma error, which is the very axis that separates a tan variant from a grey one.
    card += rng.normal(0, LUMA_NOISE, card.shape[:2] + (1,))
    card += rng.normal(0, CHROMA_NOISE, card.shape)
    if rng.random() < CONNECTOR_CHANCE:
        x = int(rng.integers(10, CANVAS - 10))
        cv2.line(card, (x, 0), (x + int(rng.integers(-30, 30)), CANVAS), (70, 52, 40), 1)
    card = np.clip(card, 0, 255).astype(np.uint8)
    # The matcher receives a card at screenshot resolution, not at canvas resolution.
    return cv2.resize(card, (CARD_PIXELS, CARD_PIXELS), interpolation=cv2.INTER_AREA)


def decide(item_ids, names, results):
    """Run the production gates over one synthetic card's comparison."""
    matches = []
    for item_id, result in zip(item_ids, results):
        match = {"item_id": item_id, "name": names[item_id], "reference_status": "cached"}
        if result:
            match.update({key: value for key, value in result.items() if key != "preview"})
        matches.append(match)
    evidence = {"card_index": 0, "status": "insufficient_evidence", "matches": matches}
    candidates = [{"item_id": item_id, "icon_match": match} for item_id, match in zip(item_ids, matches)]
    scored = sorted([match for match in matches if "score" in match], key=lambda match: -match["score"])
    _decide(evidence, scored, candidates, len(matches))
    return evidence


def sweep(catalog, cache, groups, seed=20260919, progress=None):
    rng = np.random.default_rng(seed)
    tally = collections.Counter()
    rows, profile = [], []
    for index, group in enumerate(groups, 1):
        item_ids = group["item_ids"]
        names = {item_id: catalog.items[item_id]["name"] for item_id in item_ids}
        references = [cache.get(catalog.items[item_id])[0] for item_id in item_ids]
        if any(reference is None for reference in references):
            tally["reference_missing"] += 1
            continue
        outcomes = []
        for position, truth_id in enumerate(item_ids):
            card = render_card(references[position], rng)
            results = compare_group(card, references, 1)
            evidence = decide(item_ids, names, results)
            if results[position]:
                profile.append([results[position][key] for key in ("shape_score", "color_error", "chroma_error")])
            if evidence["status"] != "supported":
                outcome = "abstained"
            else:
                outcome = "correct" if evidence["best_item_id"] == truth_id else "wrong"
            tally[outcome] += 1
            outcomes.append(
                {
                    "truth": truth_id,
                    "outcome": outcome,
                    "named": evidence.get("best_item_id"),
                    "margin": evidence.get("margin"),
                    "reason": evidence.get("reason"),
                }
            )
        rows.append({"short_name": group["short_name"], "item_ids": item_ids, "names": names, "outcomes": outcomes})
        if progress:
            progress(index, len(groups), tally)
    return {"tally": dict(tally), "profile": profile, "groups": rows}


def main():
    parser = argparse.ArgumentParser(description="Sweep every tied variant group in the catalog")
    parser.add_argument("--db", type=Path, default=Path(__file__).resolve().parents[1] / "tarkov.db")
    parser.add_argument("--icon-cache", type=Path, default=Path(__file__).parent / ".icon-cache")
    parser.add_argument("--download", action="store_true", help="Fetch references the sweep is missing")
    parser.add_argument("--groups", type=int, help="Stop after this many groups, for a quick check")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Output file already exists; choose a new path to preserve previous sweeps")
    catalog = Catalog(args.db)
    groups = variant_groups(catalog)[: args.groups]
    items = sorted({item_id for group in groups for item_id in group["item_ids"]})
    print(f"{len(groups)} groups, {len(items)} items")
    cache = IconCache(args.icon_cache, download=args.download)
    if args.download:
        for position, item_id in enumerate(items, 1):
            started = time.monotonic()
            cache.get(catalog.items[item_id])
            if time.monotonic() - started > 0.05:
                time.sleep(0.15)  # only pause after a real request
            if position % 100 == 0:
                print(f"  cached {position}/{len(items)}", flush=True)
    started = time.monotonic()

    def progress(index, total, tally):
        if index % 50 == 0:
            print(f"  {index}/{total} {dict(tally)} {time.monotonic() - started:.0f}s", flush=True)

    result = sweep(catalog, cache, groups, progress=progress)
    profile = np.array(result.pop("profile"))
    print(result["tally"], f"in {time.monotonic() - started:.0f}s")
    if len(profile):
        print("card against its own reference (hand-checked cards give 0.966 / 0.025 / 0.0035):")
        for name, column in zip(("shape", "color", "chroma"), profile.T):
            print(
                f"  {name:7s} median={np.median(column):.4f} p25={np.percentile(column, 25):.4f} "
                f"p75={np.percentile(column, 75):.4f}"
            )
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
