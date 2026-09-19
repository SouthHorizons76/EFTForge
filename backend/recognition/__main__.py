"""Run the prototype without starting FastAPI or loading server secrets."""

import argparse
import json
from pathlib import Path

from .catalog import Catalog, analyze, resolve_weapon
from .panel import evaluate_builds


def main():
    parser = argparse.ArgumentParser(description="Experimental EFT preset screenshot recognition")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--image", type=Path)
    source.add_argument("--observations", type=Path, help="Replay saved OCR JSON without OCR dependencies")
    parser.add_argument("--db", type=Path, default=Path(__file__).resolve().parents[1] / "tarkov.db")
    parser.add_argument("--weapon-id", help="Override uncertain title recognition")
    parser.add_argument(
        "--candidate-builds", type=Path, help="JSON candidate item lists to calculate and compare with panel stats"
    )
    parser.add_argument("--output", type=Path, required=True, help="New directory for debug artifacts")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Output directory already exists; choose a new directory to preserve previous experiments")
    catalog = Catalog(args.db)
    if args.observations:
        observations = json.loads(args.observations.read_text(encoding="utf-8"))
    else:
        try:
            from .vision import extract

            # Use the title and compatibility graph later in analysis; first retain only labels
            # that plausibly name some catalog item, plus the game's explicit empty marker.
            reachable_cache = {}

            def plausible_label(text, weapon_text):
                if text.strip().casefold() == "none":
                    return True
                if weapon_text not in reachable_cache:
                    detected_weapon_id, _ = resolve_weapon(catalog, weapon_text, args.weapon_id)
                    reachable_cache[weapon_text] = (
                        catalog.reachable(detected_weapon_id) if detected_weapon_id else set()
                    )
                candidates = catalog.rank(text, reachable_cache[weapon_text], limit=1)
                return bool(candidates and candidates[0]["text_similarity"] >= 0.7)

            observations = extract(args.image, args.output, plausible_label)
        except ImportError as exc:
            parser.error(f"Install recognition/requirements.txt for image input: {exc}")
    report = analyze(catalog, observations, args.weapon_id)
    if args.candidate_builds:
        builds = json.loads(args.candidate_builds.read_text(encoding="utf-8"))
        report["candidate_builds"] = evaluate_builds(args.db, catalog, report, builds)
    args.output.mkdir(parents=True, exist_ok=True)
    for name, data in (("observations.json", observations), ("report.json", report)):
        (args.output / name).write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Recognized {len(report['cards'])} card observations. Review {args.output / 'report.json'}")


if __name__ == "__main__":
    main()
