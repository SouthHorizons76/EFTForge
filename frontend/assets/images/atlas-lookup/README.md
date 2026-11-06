# Atlas player lookup artwork

`endings/` holds the game's badge for each ending a profile can show, named by the ending's
`systemName` in `/client/ending/list` (which is how the lookup names a player's
selected ending). They are the game's own sprites, unchanged, from TarkTetris's extracted
UI (`ui-assets/sprites/resources.assets/<systemName>.png`); tarkov.dev has no images of
the endings. Level badges and prestige icons come from tarkov.dev
(`assets.tarkov.dev/player-level-group-<n>.png`, `prestige-<n>-icon.webp`).

`grid_cell.png` is the 63 by 63 inventory cell a container's grids are tiled with, also
unchanged from TarkTetris (`ui-assets/sprites/resources.assets/grid_cell.png`). The grids'
layout and the items' cell sizes come from TarkTetris's data too, exported to
`backend/data/inventory_grids.json` by `scripts/build_inventory_grids.py`.
