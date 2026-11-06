# Atlas player lookup artwork

`endings/` holds the game's badge for each ending a profile can show, named by the ending's
`systemName` in `/client/ending/list` (which is how the lookup names a player's
selected ending). They are the game's own sprites, unchanged, from TarkTetris's extracted
UI (`ui-assets/sprites/resources.assets/<systemName>.png`); tarkov.dev has no images of
the endings.

`skills/` holds the game's picture of each skill, named by the skill's id in a profile
(`Endurance.png`, `MagDrills.png`...), also unchanged from TarkTetris's extracted UI
(`ui-assets/sprites/resources.assets/skill_<group>_<name>.png`, e.g. `skill_practical_magdrills.png`
for `MagDrills`, `skill_combat_weapondrawing.png` for `AimDrills`). A skill with no picture
here just shows its name.

`seasonal-perks/` holds an icon for each seasonal modifier, from eftarkov.com's traits page
(`www.eftarkov.com/uploads/traits/<id>.webp`), scaled from 272 to 96 px. Each is named
by the modifier's image id in `/client/seasonal-perks/list` (the last part of its
`imageUrl`, which the lookup passes on as `image`, with `.webp` for `.png`). eftarkov.com
still has Underdog's under an older id, so that one was renamed to the current id
(`6a69cb535f87600b9a0fe43f`). A modifier with no icon here shows its name instead.

Level badges, prestige icons and achievement icons come from tarkov.dev
(`assets.tarkov.dev/player-level-group-<n>.png`, `prestige-<n>-icon.webp`,
`achievement-<id>-icon.webp`).
