# Preset screenshot recognition experiment

Run locally on the `prototype/screenshot-build-import` branch. This is a backend CLI experiment, with no API or frontend integration. Open the existing item database read-only; do not sync or modify it.

From `backend/`, using the project's virtual environment:

```powershell
.\venv\Scripts\python.exe -m pip install -r recognition/requirements.txt
.\venv\Scripts\python.exe -m recognition --image C:\screenshots\preset.png --output C:\screenshots\mcx-result
```

Choose a new output directory for each run. RapidOCR uses ONNX Runtime on CPU. Initial model setup may need network access. The direct experimental dependencies are pinned; transitive dependencies are not locked. LZString is used only to export import codes.

Use original, uncropped preset screenshots with all attachment categories visible. Start with English at 1920x1080. Card dimensions scale with screenshot height, but different UI scales and aspect ratios are not validated. The title crop assumes the layout shown in the initial examples.

Inspect `source.png` for the preserved input, `detected-cards.png` to see numbered detections, individual `card-*.png` crops, `observations.json` for raw OCR, and `report.json` for ranked catalog matches. Each card records `source` (`card_border`, `full_frame`, or `merged` when both paths reached it) and `border_support`, the fraction of the fitted box's four edges backed by visible contrast; `null` means no border fit was accepted and the box is the raw detection. OCR coordinates inside each observation refer to the enlarged label crop; card coordinates refer to the original screenshot. Supply `--weapon-id ITEM_ID` to override uncertain title recognition and `--db PATH` to use another catalog.

`stats-panel.png` preserves the lower-left info panel crop. Both JSON files include `stats_panel`: ergonomics, MOA, sighting range, vertical recoil, and horizontal recoil, with raw OCR, confidence, and missing/uncertain readings. Weight is recorded as advisory data. Panel OCR currently expects English labels in the original layout. A closed panel produces `not_detected`, not zero stats. Panel OCR boxes are relative to the crop enlarged by `ocr_scale`.

`review-regions.png` adds amber boxes, separate from green recognized cards: `overlap?` for a suspected overlap and `no border?` for a name that no card border supports. Inspect `overlap-*.png`, `unverified-*.png`, and `review_regions` in the report. Each region preserves two possible card boxes and any readable text fragments with ranked item candidates. These are unresolved hypotheses, not confirmed attachments. Fragment OCR boxes refer to the enlarged upper portion of the overlap crop. Fully hidden information still needs manual selection or another screenshot; combining multiple screenshots and matching overlap fragments are not implemented.

## Distinguish attachment variants with icons

Use `--icons` to compare the candidates OCR could not separate: every candidate within 0.02 text similarity of the best one. That covers parts sharing a short name, the color variants of one part, and two differently named parts a clipped label left tied. On the first run, add `--download-icons` to fetch missing transparent reference images from the catalog's `base_image_link` URLs:

```powershell
.\venv\Scripts\python.exe -m recognition --observations recognition/.runs/test-02/observations.json --icons --download-icons --reconstruct --output recognition/.runs/icon-test-02
```

The same flags work with `--image`. References are cached by item ID and source URL in the ignored `recognition/.icon-cache/` directory. Use `--icon-cache PATH` to relocate it. Subsequent runs work offline without `--download-icons`. No full catalog download or database sync is needed. If an asset changes at the same URL, remove its cached file and download it again.

Read `icon-report.json` for each candidate's shape score, color error, chroma error, coverage, combined score, and the margin between the strongest two matches. `alignment` says whether the group was placed together or separately, and `reason` names the gate that abstained. `icon-card-*.png` shows the observed crop followed by each successfully aligned reference overlaid on the compared pixels. `preview_columns` gives their item IDs in image order; the JSON includes full names. Compared crops are copied to the output so the icon stage can replay that run. For observations stored separately from their images, supply `--crops-dir` pointing to the original run directory.

Matching fits transparent references to a square canvas larger than a card, searches scale and position in a coarse pass followed by a fine one, and compares opaque attachment pixels. The canvas is deliberately larger than the 65px card: the reference mask has to be eroded to drop edge pixels that blended into the card background, and at card resolution that erosion eats most of a thin part such as a charging handle. Excluded from every comparison are the border, the label band, whose height follows the wrapped line count, and both bottom-corner badges. The purchase badge turns red when a part cannot be bought, so reading it would hand free evidence to every red variant.

Three measurements are kept apart. Structure is the grayscale correlation over the compared pixels. Color error is how far the color is off overall. Chroma error is how far the color leans once each pixel's own brightness is removed, which is the measurement that separates a tan part from a grey one: card lighting washes the render out against the flat catalog asset, leaving the two only a few levels apart overall while their channel balance still separates. Each drops its worst tenth of pixels, so a connector line crossing the card or one specular highlight cannot outweigh the body of the part.

References whose silhouettes agree, meaning one part in several colors, are placed once, together, and the placement is decided on structure alone. Fitting each color separately answers a color question by comparing two different crops of the card, and letting the full score choose the placement lets one variant's color pick the pixels its own color is judged on.

All competing variants must be comparable, and the best score must exceed the runner-up by at least 0.04 before the evidence is marked `supported`. Current gates are score >= 0.67, shape correlation >= 0.65, color error <= 0.10, at least 2% of the canvas compared, and at least 35% of the placed reference landing on comparable card pixels. These are experimental thresholds, not calibrated probabilities. Groups larger than eight tied candidates abstain without downloading anything.

Supported visual evidence leads its own tie in the card's candidate list, penalizes alternative variants during reconstruction, and breaks ties after the stat comparison. It never reorders candidates across different text scores, deletes candidates, or bypasses slot validation. Missing references, missing crops, flat or uninformative images, weak matches, and near ties leave OCR ranking unchanged. Every result still requires review.

Across the three saved screenshots, 22 cards left ambiguous by OCR were checked by hand against the crops and kept as fixtures under `tests/data`. The current matcher reads 17 of them correctly and none incorrectly. The other five show the part with its own children fitted, a scope sitting in its mount or a handguard carrying its base, which no bare reference can be placed against, so abstaining is the only correct outcome and all five abstain. The previous shared-short-name matcher read 15 of the same set. That is one hand-checked set on one UI language at 1920x1080, not a benchmark.

This stage reranks tied candidates on already detected cards. It does not yet search the whole icon library for unreadable labels, detect cards using icons alone, recover concealed parts, or match a card that shows an assembled sub-tree. Adding a reference for a catalog item requires no matching-code change, but different rendering layouts may require further alignment work.

The approach was informed by RatEye's [template matching](https://github.com/RatScanner/RatEye/blob/master/RatEye/Processing/Icon.cs) and [reference preparation](https://github.com/RatScanner/RatEye/blob/master/RatEye/IconManager.cs). This Python implementation uses masked transparent references and separate color/structure evidence for preset cards.

## Reconstruct and import a candidate build

Add `--reconstruct` to either an image run or an observations replay:

```powershell
.\venv\Scripts\python.exe -m recognition --observations recognition/.runs/test-02/observations.json --reconstruct --output recognition/.runs/reconstruction-test-02
```

Read `reconstruction` in `report.json`, then inspect `candidate-01.json`. Each candidate includes named attachment instances, their parent and slot IDs, the supporting card index, inferred adapters, unresolved cards, missing required slots, calculated stats, and per-stat differences. `candidate-01` is the highest-ranked hypothesis, not an automatically confirmed build.

After reviewing it, copy the contents of `candidate-01.code.txt` into EFTForge's existing build-code import field. For example, from `backend/`:

```powershell
Get-Content recognition/.runs/reconstruction-test-02/candidate-01.code.txt -Raw | Set-Clipboard
```

Other `candidate-*.json` and `.code.txt` files offer alternative hypotheses. A partial candidate can still have an import code so you can finish it in the workbench. Check `completeness`, `validation.missing_required_slots`, `unresolved_card_indices`, and `inferred_instances` first. `observations_accounted_for` means the recognized cards fit and required slots are filled; it cannot establish that the screenshot contains no undetected optional parts. Overlap/review regions keep a candidate marked partial and are not automatically installed.

The search uses the following constraints and limits:

- Keep separate attachment instances, one item per parent-instance slot, and at most one assignment per detected card. Validate slot ownership, allowed items, item conflicts, and blocked slots. Check slot conflicts in both directions, including slots exposed by another installed part, consistently with the workbench's conservative compatibility checks.
- Process likely parents first. Keep alternative trees in a bounded beam, and leave a card unresolved when no retained hypothesis can place it. Preserve candidates tied at the catalog cutoff, including shared short names. Within reconstruction, consider matches no more than 0.12 below the best text score.
- Try direct installation before inferring dependencies. Search the shortest available adapter chains first, with at most two adapters per chain and three inferred parts per tree. Label inferred parts explicitly; do not fill required slots or concealed cards with arbitrary defaults. An observed card can claim an adapter inferred earlier.
- Retain 48 trees by default and return up to five alternatives. Stop search at 10 seconds or 100,000 attempted placements, with a cap of 32 successful placements per card candidate and tree. `search.truncated_by` reports beam, placement, or budget pruning. `--beam-width 128 --search-seconds 20` allows a wider search, but does not change the other caps. These are heuristic hypotheses, not an exhaustive search or a proven optimum.
- Rank by accounted-for cards, missing required slots, inferred parts, panel error in display units, and text penalty. Prefer different item combinations among returned alternatives before repeating placements of the same combination. Literal text matches win ties over confusable-glyph matches. Stat agreement never removes the review requirement, and weight does not affect ranking.
- Export the existing version-1 build-code payload, with parents before children. If a used slot ID belongs to multiple installed parent instances, withhold the code and set `export_status` to `ambiguous_parent_instances`: the current importer cannot reliably address those instances separately. The complete candidate tree remains in JSON.

The item database stays read-only. No API, upload flow, or frontend code is changed. The generated payload and codec are checked in backend tests; manually verify the actual import in the workbench.

## Compare manually supplied builds with the stats panel

To compare manually chosen candidate item lists independently of reconstruction, supply a JSON file like this (replace the attachment placeholders with actual item IDs, preserving repeated instances):

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
- Always require review. Similarity and OCR scores are not calibrated probabilities. `--reconstruct` adds conflict validation, instance assignment, and candidate export. `--icons` adds visual comparisons between the candidates OCR left tied. Multi-screenshot merging is not implemented.
- Do not trace the connector lines to recover the slot tree. The lines are ambiguous where they cross the weapon, so a build is assembled by matching each recognized short name against the whole weapon's compatible attachment list, the same list the optimizer's attachment filter offers, and leaving the slot assignment to that stage.
- Overlapping or broken borders can be missed; a card whose border is mostly hidden now becomes a review region rather than a card, so heavy occlusion costs recall in exchange for not inventing attachments. Cropped labels can lose variant suffixes. A missing detection never means an empty slot. Glyph confusions that the fold does not cover still cost similarity: `D` read as `0` leaves `PMAG D60` and `SRD762-QD` below 0.9, correct at rank 1 but not exact.
- Keep suspected overlaps as review regions when a card-height left edge aligns with a narrow exposed strip. This limited heuristic can miss other overlap arrangements or produce false review regions.

## Validation and next experiments

```powershell
.\venv\Scripts\python.exe -m pytest tests/test_recognition.py tests/test_recognition_panel.py tests/test_recognition_reconstruct.py tests/test_recognition_icons.py tests/test_recognition_icon_accuracy.py -q -p no:cacheprovider
```

The reconstruction tests use small catalogs with known expected trees to cover nesting, repeated parts, shared names, slot capacity, conflicts, required slots, inference, search limits, and export. They do not measure screenshot accuracy.

`test_recognition_icon_accuracy.py` is the one test that does, for the icon stage. It runs the 22 hand-checked cards in `tests/data/icon_cards` against the pinned references in `tests/data/icon_references`, needing no network, no download cache, and no run directory. Naming the wrong variant fails outright; the supported count is a ratchet in `EXPECTED_CORRECT`, currently 17. Raise it when a change earns it, and treat lowering it as a decision to argue for rather than a number to edit. The answers in `icon_ground_truth.json` were read off the crops by eye, so regenerating a crop means re-checking its answer.

That set is small enough that thresholds can look better or worse by luck. A 112px comparison canvas scores 16 where both 96 and 128 score 17, which is noise, not a finding.

For scale instead of realism, sweep the whole catalog. The first run needs the references, about 2.8 MB over 688 requests, and takes roughly four minutes after that:

```powershell
.\venv\Scripts\python.exe -m recognition.variant_sweep --download --output recognition/.runs/variant-sweep.json
```

It finds every set of reachable attachments a weapon offers under one short name, 301 groups over 688 items, builds a card from each reference, and asks the matcher to pick that reference back out of its own group. The card is knocked about to land where real cards land, which `test_recognition_variant_sweep.py` pins so the degradation cannot drift into trivially easy or impossible. Each card is seeded from its own item and the groups are sorted, because `reachable` returns a set and Python randomizes string hashing per process: one shared random stream over an unsorted traversal flipped 31 of 759 trials between runs while the totals stayed within one of each other, which is enough to hide a real regression.

Read it as an upper bound: the card is synthesised from the image being compared against, so it sees neither game-render drift nor assembled sub-tree icons. The current run identifies 640 of 759 and names the wrong variant in none of them.

All 127 abstentions are information limits rather than tuning problems. Three quarters are `not_all_variants_comparable`, where one group member is a long thin part, a barrel, a rail or a heat shield, that the square canvas flattens into a band too small to judge. Lowering the compared-pixel floor to recover them starts naming handguards as rails: 0.012 and 0.008 each buy about 25 identifications for one wrong answer, and 0.005 buys three wrong answers. That is a bad trade here, because an abstention only leaves OCR ranking alone while a wrong variant puts the wrong part in an imported build. The hand-checked set sees neither the gain nor the errors, which is the clearest argument for keeping both measurements. The rest are parts with too little texture to correlate, magazines and charging handles, which are also the weakest real cards: the STANAG magazine is the lowest of the 22 at 0.651 structure.

None of this is reachable by tuning at 1920x1080. A higher-resolution screenshot gives a proportionally larger card and is the obvious thing to try first, but no such screenshots have been collected yet.

Searching below the ordinary scale range does not recover the assembled-icon cards, and was tried. A card showing a part with its children fitted has the whole assembly scaled to fit, so the part sits smaller and off centre, which suggests retrying at 0.55 to 0.8 scale and a wider offset once the ordinary search has failed. On the five real assembled cards that fallback reached 0.78 structure at best, below the 0.85 it would need to be trusted, and on the ARE card it still ranked black above the visibly red part. On the sweep it gained nothing, 640 either way, and named an MP-443 magazine as an MP-443 pistol grip at a margin of 0.47. A shrunken reference has too much room to find a flattering patch of card. The scale range stays tight.

Collect original screenshots paired with exact item IDs and slot paths. Include overlaps, repeated items, color variants, different resolutions, and empty slots. Keep some builds out of tuning. Measure card detection recall, top-1/top-5 item identification, exact slot assignment, full-build correctness, and corrections per import separately. Compare OCR alone against OCR plus icon matching using the same reconstruction stage.

The implementation uses the [RapidOCR Python API](https://rapidai.github.io/RapidOCRDocs/main/en/install_usage/rapidocr/usage/). No screenshot benchmark results are claimed yet.
