# Arena mode artwork

`weapon-types/` holds the game's own weapon type icons, which the Arena loadout's weapon
picker shows down its filter column the way the game's preset editor does
(`assault-rifles`, `carbines`, `marksman-rifles`, `sniper-rifles`, `smgs`, `machine-guns`,
`shotguns`, `grenade-launchers`, `pistols`, from `icon_weapons_assaultrifles`,
`icon_weapons_carbines`, `icon_weapons_dmr`, `icon_weapons_botaction`, `icon_weapons_smg`,
`icon_weapons_mg`, `icon_weapons_shotguns`, `icon_weapons_gl` and `icon_weapons_pistols`).
They are 32 px white sprites from TarkTetris's extracted UI
(`ui-assets/sprites/resources.assets/`), as lossless WebP.

`tabs/` and `carry/` hold the game's icons for the item list's five category tabs: `weapons`
and `equipment` (`icon_weapons`, `icon_gear_rigs`), then meds, magazines and ammo (`medical`,
`magazine`, `ammo`, from `icon_medical`, `handbook_magazines_icon` and `icon_ammo`), the last
two also the magazines and ammo tabs' one filter. `meds/` holds the meds tab's filters
(`medkits`, `injury`, `pills`, `injectors`, from `icon_medical_medkits`, `icon_medical_injury`,
`icon_medical_pills` and `icon_medical_injectors`). All from the same TarkTetris folder, as
lossless WebP.

`gear/` holds the game's gear icons for the gear pickers' category column, named by the
loadout slot each stands for (`Headwear`, `Earpiece`, `FaceCover`, `Eyewear`, `ArmorVest`,
`TacticalVest`, `Scabbard`, and `plate` and `attachment` for armor plates and helmet parts,
from `icon_gear_headwear`, `icon_gear_headsets`, `icon_gear_facecovers`, `icon_gear_visors`,
`icon_gear_armor`, `icon_gear_rigs`, `icon_weapons_melee`, `icon_armor_plate` and
`icon_gear_components`), from the same TarkTetris folder, as lossless WebP.

`menu/` holds the game's context menu icons for the loadout's right click menu (`modding`,
`unload`, `unload-ammo`, `duplicate`, `discard`, from `Modding`, `Unload`, `UnloadAmmo`,
`CopyId` and `Discard`), from the same TarkTetris folder, as lossless WebP.

`classes/` holds Arena's icon for each preset class (`assault` the shield, `enforcer` the
fist, `scout` the aperture, `marksman` the crosshair), from the game's largest set (its 240 px
class tiles): only the glyph, made white on transparent (keeping its anti-aliased edge) and
trimmed to what's drawn, about 150 px across, as lossless WebP. The class picker and the
class tabs show them.

`blastgang.webp` is BlastGang's logo at its largest size (306 by 121 once trimmed), as WebP at
quality 90, for the class picker's BlastGang banner. The Atlas player lookup has a 40 px copy
of its own (`atlas-lookup/arena/modes/`).
