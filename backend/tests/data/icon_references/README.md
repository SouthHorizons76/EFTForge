# Pinned icon references

Transparent item images from `https://assets.tarkov.dev/<item id>-base-image.webp`, the
same URLs the catalog stores in `items.base_image_link`. They are checked in so
`tests/test_recognition_icon_accuracy.py` runs with no network and no download cache.

One file per item ID, covering only the items the hand-checked cards in
`../icon_cards` are compared against. This is not a mirror of the asset library: at
runtime `recognition/icons.py` downloads what it needs into the ignored
`recognition/.icon-cache/` directory instead.

Replace a file only when the upstream asset itself changes, and re-check the affected
answers in `../icon_ground_truth.json` by eye when you do, because those answers were
read from these exact images.
