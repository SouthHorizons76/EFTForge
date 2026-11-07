# Atlas player lookup artwork

`endings/` holds the game's badge for each ending a profile can show, named by the ending's
`systemName` in `/client/ending/list` (which is how the lookup names a player's
selected ending). They are the game's own sprites, as WebP, from TarkTetris's extracted
UI (`ui-assets/sprites/resources.assets/<systemName>.png`); tarkov.dev has no images of
the endings.

Every picture here is WebP (lossless for the small icons, quality 90 for the larger ones), to keep
page loads light.

`stats/` and `editions/` hold the game's icons for the overall stats its profile shows one
for (`raids`, `survived`, `kia`, `mia`, `awol`, `kills`, `online`, from `icon_survival_big`,
`icon_survived_big`, `icon_notsurvive_big`, `icon_mia_big`, `icon_leave_big`,
`icon_kills_big` and `icon_time`) and for each edition (`EOD`, `Unheard`, `Sherpa`,
`Emissary`, `Developer`, from `icon_unique_id_big_big`, `icon_user_unheard_big`,
`icon_user_sherpa_big`, `icon_user_emissary_big` and `icon_developer_big`), as WebP from
TarkTetris's extracted UI (`ui-assets/sprites/resources.assets/`).

`ui/` holds the game's own icons the profile screen uses (tab and panel icons, which the
page fills with Atlas' colors as masks, the USEC and BEAR logos, the EXP and elite icons,
the empty slot cross), as WebP from TarkTetris's extracted UI (`ui-assets/sprites/`,
under their own names), and the level badges `rank5.webp` to `rank80.webp`, scaled from 300
to the 100 px they're drawn at. The screen's chrome (cards, bands, tabs, bars) is Atlas'
own CSS, not the game's sprites.

`leagues/` holds the league rank badges, named by rank (`1.webp` Recruit to `7.webp`
Conductor): the game's own emblems (`rank_icons_<rank>_1920x1920`), without the shadow
around them, scaled from 1024 to 240 px. Without a badge, the page shows the rank's numeral.

Prestige, achievement, skill and seasonal modifier icons come from tarkov.dev
(`assets.tarkov.dev/prestige-<n>-icon.webp`, `achievement-<id>-icon.webp`,
`skill-<id>-icon.webp`, `<modifier id>.webp`). A skill or modifier whose icon doesn't load
shows its name instead.
