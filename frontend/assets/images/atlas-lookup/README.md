# Atlas player lookup artwork

`endings/` holds the game's badge for each ending a profile can show, named by the ending's
`systemName` in `/client/ending/list` (which is how the lookup names a player's
selected ending). They are the game's own sprites, unchanged, from TarkTetris's extracted
UI (`ui-assets/sprites/resources.assets/<systemName>.png`); tarkov.dev has no images of
the endings. Level badges, prestige icons and achievement icons come from tarkov.dev
(`assets.tarkov.dev/player-level-group-<n>.png`, `prestige-<n>-icon.webp`,
`achievement-<id>-icon.webp`).
