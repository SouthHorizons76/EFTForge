# Preset screenshot recognition experiment

Run locally on the `prototype/screenshot-build-import` branch. This is a backend CLI experiment, with no API or frontend integration. Open the existing item database read-only; do not sync or modify it.

From `backend/`, using the project's virtual environment:

```powershell
.\venv\Scripts\python.exe -m pip install -r recognition/requirements.txt
.\venv\Scripts\python.exe -m recognition --image C:\screenshots\preset.png --output C:\screenshots\mcx-result
```

Choose a new output directory for each run. RapidOCR uses ONNX Runtime on CPU. Initial model setup may need network access. The two direct OCR dependencies are pinned to the smoke-tested versions; transitive dependencies are not locked.

Use original, uncropped preset screenshots with all attachment categories visible. Start with English at 1920x1080. Card dimensions scale with screenshot height, but different UI scales and aspect ratios are not validated. The title crop assumes the layout shown in the initial examples.

Inspect `source.png` for the preserved input, `detected-cards.png` to see numbered detections, individual `card-*.png` crops, `observations.json` for raw OCR, and `report.json` for ranked catalog matches. Each card records `source` (`card_border`, `full_frame`, or `merged` when both paths reached it) and `border_support`, the fraction of the fitted box's four edges backed by visible contrast; `null` means no border fit was accepted and the box is the raw detection. OCR coordinates inside each observation refer to the enlarged label crop; card coordinates refer to the original screenshot. Supply `--weapon-id ITEM_ID` to override uncertain title recognition and `--db PATH` to use another catalog.

`stats-panel.png` preserves the lower-left info panel crop. Both JSON files include `stats_panel`: ergonomics, MOA, sighting range, vertical recoil, and horizontal recoil, with raw OCR, confidence, and missing/uncertain readings. Weight is recorded as advisory data. Panel OCR currently expects English labels in the original layout. A closed panel produces `not_detected`, not zero stats. Panel OCR boxes are relative to the crop enlarged by `ocr_scale`.

`review-regions.png` adds amber boxes, separate from green recognized cards: `overlap?` for a suspected overlap and `no border?` for a name that no card border supports. Inspect `overlap-*.png`, `unverified-*.png`, and `review_regions` in the report. Each region preserves two possible card boxes and any readable text fragments with ranked item candidates. These are unresolved hypotheses, not confirmed attachments. Fragment OCR boxes refer to the enlarged upper portion of the overlap crop. Fully hidden information still needs manual selection or another screenshot; icon matching and combining multiple screenshots are not implemented.

## Compare candidate builds with the stats panel

The prototype does not assemble a complete build automatically. To compare manually chosen candidate item lists, supply a JSON file like this (replace the attachment placeholders with actual item IDs, preserving repeated instances):

```json
[
  {
    "name": "Candidate A",
    "weapon_id": "5447a9cd4bdc2dbd208b4567",
    "attachment_ids": ["ATTACHMENT_ITEM_ID", "ANOTHER_ATTACHMENT_ITEM_ID"]
  }
]
```

```powershell
.\venv\Scripts\python.exe -m recognition --observations recognition/.runs/test-03-panel/observations.json --candidate-builds candidates.json --output recognition/.runs/candidate-comparison
```

The optional `weapon_id` defaults to the recognized weapon. Reuse observations from a run containing `stats_panel` to avoid repeating OCR. The candidate comparison reads the database without modifying it and calls the shared `stats._compute_stats` calculation. It rejects unknown/unreachable parts, but does not validate the installed slot tree, conflicts, or completeness.

Read `candidate_builds` in `report.json` for computed values, per-stat differences, and `stats_agree`, `stats_differ`, or `insufficient_evidence`. Comparisons use half a displayed unit (0.05 ergonomics, 0.005 MOA, 0.5 for range/recoil); confidence below 0.85 or conflicting OCR readings are excluded. All five reliable comparisons are required for `stats_agree`. Candidates are ranked by comparison coverage and then total error measured in display units, with no automatic winner or probability claim. Recoil directions share a modifier and the score is only a diagnostic ranking.

The top-level `stat_comparison` stays `insufficient_evidence` because no single build is selected automatically. Weight never changes the comparison outcome. Ammo effects, weapon condition, game-version changes, and formula differences have not been calibrated against the preset panel. Agreement supports a candidate but cannot prove which visually similar parts are installed.

Replay observations without installing OCR dependencies:

```powershell
.\venv\Scripts\python.exe -m recognition --observations recognition/example-observations.json --output C:\screenshots\replay-result
```

The example contains manually transcribed labels from the supplied MCX screenshot. It is a matching smoke test, not an OCR accuracy benchmark. You can also edit a saved observations file to isolate recognition errors from matching errors.

## Current behavior and limits

- Detect approximately square card borders, snap each detection to its four visible borders, and read the upper label with RapidOCR. Save full card crops for future icon matching. Fitting matters for identification, not only for tidy boxes: a box offset by a few pixels clips the label, and a clipped `MCX GEN1` reads as `MCX` and matches a different attachment.
- Use full-frame OCR as a fallback for missed labels. Group full-frame lines that stack inside one label before anchoring a card, so a wrapped name such as `UCS CR` stays whole instead of becoming a `UCS` card and a `CR` card. Apply the same punctuation-insensitive slot/UI label filter to both OCR passes, and skip readings inside the stats panel and the bottom navigation bar.
- Require a fitted card border before accepting a detection. Text painted on the weapon model, such as the HAMR lettering on a Leupold scope or a receiver's stencilling, reads like an attachment name and otherwise becomes a card sitting on the gun body. Across the sampled builds every real card scored at least 0.87 border support while those false readings scored 0.57 or fitted no border at all, so the gate is set at 0.75.
- Keep a rejected reading as an `unverified_card` review region with its crop instead of discarding it, because a border can also be hidden behind the weapon. Drop one only when it overlaps a card that was accepted, which makes it a duplicate detection rather than a separate name.
- Read a taller label strip when the first reading already wrapped, so a three-line name such as `BA Hanson 13.7"` is not clipped to `BA Hanson` and matched to the 16" barrel instead. Accept the taller reading only when it extends the first.
- Deduplicate cards by box overlap rather than by label text, so a build carrying the same attachment twice keeps both cards. When two detections land on one card, keep the longer reading only when it starts with the shorter one; a prepended character is the card's corner icon, not part of a name.
- Reject a reading as a slot overlay when every word in it is part of some slot label, which covers clipped overlays such as `RECE` or `ARD/ER` without excluding item names such as Stock Pad or Mount Adapter.
- Resolve a unique exact weapon title before considering fuzzy-match margins between similar models.
- Match normalized English/Chinese item names using character similarity, restricting attachments to the weapon's reachable compatibility graph. Compare the literal reading first, then retry with confusable glyphs folded (`0`/`O`, `1`/`l`, `5`/`S`, `8`/`B`, `2`/`Z`, `6`/`G`) so `GF-M0D3` still reaches `GF MOD3`; folding can only raise a score, so it never dilutes a clean match. Strip the inch-mark family before NFKC, which would otherwise fold an ordinal indicator into a trailing letter and count it against `M-LOK 4.1"`.
- Preserve tied variants and repeated card observations. Mark literal `NONE` labels as empty without guessing their slot.
- Report possible parent slots, including slots on intermediate adapters. These are catalog possibilities, not evidence that those adapters are installed.
- Always require review. Similarity and OCR scores are not calibrated probabilities. No conflict validation, attachment instance assignment, icon matching, or complete build export is implemented yet.
- Do not trace the connector lines to recover the slot tree. The lines are ambiguous where they cross the weapon, so a build is assembled by matching each recognized short name against the whole weapon's compatible attachment list, the same list the optimizer's attachment filter offers, and leaving the slot assignment to that stage.
- Overlapping or broken borders can be missed; a card whose border is mostly hidden now becomes a review region rather than a card, so heavy occlusion costs recall in exchange for not inventing attachments. Cropped labels can lose variant suffixes. A missing detection never means an empty slot. Glyph confusions that the fold does not cover still cost similarity: `D` read as `0` leaves `PMAG D60` and `SRD762-QD` below 0.9, correct at rank 1 but not exact.
- Keep suspected overlaps as review regions when a card-height left edge aligns with a narrow exposed strip. This limited heuristic can miss other overlap arrangements or produce false review regions.

## Validation and next experiments

```powershell
.\venv\Scripts\python.exe -m pytest tests/test_recognition.py tests/test_recognition_panel.py -q -p no:cacheprovider
```

Collect original screenshots paired with exact item IDs and slot paths. Include overlaps, repeated items, color variants, different resolutions, and empty slots. Keep some builds out of tuning. Measure card detection recall, top-1/top-5 item identification, exact slot assignment, full-build correctness, and corrections per import separately. Compare OCR alone against OCR plus icon matching before adding a reconstruction solver.

The implementation uses the [RapidOCR Python API](https://rapidai.github.io/RapidOCRDocs/main/en/install_usage/rapidocr/usage/). No screenshot benchmark results are claimed yet.
