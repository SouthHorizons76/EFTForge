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

`arena/` holds Arena's own icons for its profile screen, as WebP: `stats/` the dashboard's
(`victories`, `winrate`, `kills`, `headshots`, `deaths`, `online`), `mini/` the level bar's
(`matches`, `kd`, `winrate`, `kills`, `wins`, `quit`), `editions/` the icon before the
nickname (`EOD`, `Unheard`, `Sherpa`, `Emissary`, `Developer`, and `Default` when none is
shown), `ranks/` Arena's level badges `rank5` to `rank80` (scaled from 300 to 100 px, chosen
on the same five-level steps as EFT's), and `bp-emblem` and `bp-level` the battle pass
emblem and the plate its level sits on (white, filled orange by the page). `modes/` holds
each Arena mode's logo (`TeamFight`, `LastHero`, `CheckPoint`, `BlastGang`, `ShootOut`, the
last also for Shootout's duo mode) for the statistics cards' headers, from the game's
smallest set, trimmed to what's drawn and 40 px tall, as WebP at quality 70 (alpha 50).
`passes/` holds each battle pass season's metal medallion for the battle passes panel
(`season1` TEMPUS CAMPIONUM, `season2` CASUS BELLI, `season3` MORBUS IMPERIUM; Season 0 has
none): the icon of the season's own Legendary achievement, without the badge frame, trimmed
and at most 80 px, as WebP.

`arena/achievements/` holds the Arena achievement badges (tarkov.dev only has EFT's), named
by achievement id, built as the profile draws them: the game's upright badge background and
frame for the achievement's rarity, with its icon at 78% between them, 98 x 112, as WebP at
quality 70 (alpha 50), about 2 KB each. The icons are the game's own (the images Arena's
achievement list names); two the game hadn't shown yet, Rigged Match and Lionheart, come from
the Escape from Tarkov Wiki's [Achievements](https://escapefromtarkov.fandom.com/wiki/Achievements)
page. A new Arena achievement shows an empty badge until its icon is added here.

`clothing/` holds the game's icon of each upper and lower body piece the character panel's
clothing slots show, named by the piece's customization id (the profile's `customization.body`
and `customization.feet`). They come from the game's own clothing icon cache
(`%LOCALAPPDATA%\Temp\Battlestate Games\EscapeFromTarkov\Icon Cache\live\Clothing` and the
same under `EscapeFromTarkovArena`), which names each icon by a hash in its `index.json`:
`17 ^ hash(name) ^ hash(prefab path)` over the piece's `_name` and `_props.Prefab.path` in
`/client/customization`, where hash is .NET's legacy string hash with both halves seeded 5381
(`h = ((h << 5) + h) ^ c` over alternate characters, then `h1 + h2 * 1566083941`). EFT's icons
are 94 px and Arena's 76; a piece in both uses EFT's. WebP at quality 80 (alpha 80), about
2 KB each. The cache only holds the pieces the game has shown on that PC, so a piece missing
here keeps the empty slot's cross until its icon is added; browsing Ragman's clothing in either
game fills the cache with more.

Prestige, achievement, skill and seasonal modifier icons come from tarkov.dev
(`assets.tarkov.dev/prestige-<n>-icon.webp`, `achievement-<id>-icon.webp`,
`skill-<id>-icon.webp`, `<modifier id>.webp`). A skill or modifier whose icon doesn't load
shows its name instead.
