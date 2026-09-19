"""Run the prototype without starting FastAPI or loading server secrets."""

import argparse
import json
import math
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
    parser.add_argument("--icons", action="store_true", help="Compare shared-name variants using cached card icons")
    parser.add_argument("--download-icons", action="store_true", help="Fetch missing reference images for --icons")
    parser.add_argument("--icon-cache", type=Path, default=Path(__file__).parent / ".icon-cache")
    parser.add_argument("--crops-dir", type=Path, help="Original card crop directory when replaying observations")
    parser.add_argument(
        "--reconstruct", action="store_true", help="Search slot trees and export candidate import codes"
    )
    parser.add_argument("--search-seconds", type=float, default=10.0, help="Reconstruction search budget (default: 10)")
    parser.add_argument("--beam-width", type=int, default=48, help="Trees retained per search step (default: 48)")
    parser.add_argument(
        "--candidate-builds", type=Path, help="JSON candidate item lists to calculate and compare with panel stats"
    )
    parser.add_argument("--output", type=Path, required=True, help="New directory for debug artifacts")
    args = parser.parse_args()
    if args.download_icons and not args.icons:
        parser.error("--download-icons requires --icons")
    if not math.isfinite(args.search_seconds) or args.search_seconds <= 0 or args.beam_width <= 0:
        parser.error("Search seconds and beam width must be positive")
    if args.reconstruct:
        try:
            from .reconstruct import SearchLimits, encode_payload, reconstruct

            encode_payload({"v": 1, "g": "dependency-check", "p": []})
        except ImportError as exc:
            parser.error(f"Install recognition/requirements.txt for import-code export: {exc}")
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
    if args.icons:
        from .icons import IconCache, apply_icon_evidence

        crops_dir = args.crops_dir or (args.observations.parent if args.observations else args.output)
        icon_summary = apply_icon_evidence(
            catalog, report, crops_dir, IconCache(args.icon_cache, download=args.download_icons), args.output
        )
        print(
            f"Icon evidence supports {icon_summary['supported_cards']} of {icon_summary['compared_cards']} compared cards."
        )
    if args.candidate_builds:
        builds = json.loads(args.candidate_builds.read_text(encoding="utf-8"))
        report["candidate_builds"] = evaluate_builds(args.db, catalog, report, builds)
    args.output.mkdir(parents=True, exist_ok=True)
    if args.reconstruct:
        report["reconstruction"] = reconstruct(
            catalog, report, SearchLimits(seconds=args.search_seconds, beam_width=args.beam_width)
        )
        for index, candidate in enumerate(report["reconstruction"]["candidates"], 1):
            stem = f"candidate-{index:02d}"
            if candidate["payload"] is not None:
                code_file = stem + ".code.txt"
                (args.output / code_file).write_text(encode_payload(candidate["payload"]), encoding="utf-8")
                candidate["code_file"] = code_file
            (args.output / (stem + ".json")).write_text(
                json.dumps(candidate, indent=2, ensure_ascii=False), encoding="utf-8"
            )
        print(f"Reconstructed {len(report['reconstruction']['candidates'])} candidates; review before importing.")
    for name, data in (("observations.json", observations), ("report.json", report)):
        (args.output / name).write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Recognized {len(report['cards'])} card observations. Review {args.output / 'report.json'}")


if __name__ == "__main__":
    main()
