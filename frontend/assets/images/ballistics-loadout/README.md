# Ballistics loadout artwork

Reuse the equipment placeholders and character silhouette from TarkTetris's inventory UI.
Keep the original PNG files unchanged and apply EFTForge's colors and presentation in CSS.

Source paths in TarkTetris:

- `ui-assets/sprites/resources.assets/`: equipment, plate, attachment and ammo placeholders.
- `ui-assets/sprites/sharedassets44.assets/character_pmc.png`: character silhouette.
- `ui-assets/sprites/resources.assets/armor_classes_*.png`: the I to VI class badges, renamed
  `armor_class_<level>.png` by the numeral they show (the source numbering is out of order).

`inserts/` holds pictures of the built-in soft and integrated armor inserts (soft armor
front/back/sides, collar, groin, shoulders, helmet sections), which tarkov.dev has no
images for, named by the slot they belong to (`armor-sim.js`, `INSERT_ART`).

The armor simulator's loadout follows TarkTetris's gear panel (`src/ui/theme.js`,
`GEAR_SLOTS`), keeping only the ballistics slots: ammo takes the free earpiece spot and
the rig the free left one. Plates and helmet attachments are 56 by 56 slots around their
parent (back plate above, front plate below, side plates and attachments beside it), so
the columns sit 72 apart and a band runs between the rows (`armor-sim.js`,
`GEAR_LAYOUT`). The board covers TarkTetris's whole left panel down to its bottom bar
(594 by 797, slots 98 below its top), so the character shows head to toe. The target's HP
fields are a second 131 by 20 header bar 22 above a slot's own (`HP_HEADINGS`), which widens
the band between the rows to 94 so the back plate clears both bars. The stomach's bar sits
2 under the middle slot, with the front plate below it; the legs' bars float side by side
on the character (`HP_SPOTS`). A tab's hover preview crops to the 478 tall slot band.

Keep from the source geometry:

- Slot bodies 125 by 125, each with a 131 by 20 header at (-3, -22).
- Each placeholder's original native dimensions and offsets from `theme.js`.
- The 512 by 768 character behind the panel, at the same offset from the middle column.
- One uniform scale for the whole panel, down to fit narrow panels and capped at native size.
