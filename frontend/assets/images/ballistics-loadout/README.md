# Ballistics loadout artwork

Reuse the equipment placeholders and character silhouette from TarkTetris's inventory UI.
Keep the original PNG files unchanged and apply EFTForge's colors and presentation in CSS.

Source paths in TarkTetris:

- `ui-assets/sprites/resources.assets/`: equipment, plate, attachment and ammo placeholders.
- `ui-assets/sprites/sharedassets44.assets/character_pmc.png`: character silhouette.

The armor simulator's loadout follows TarkTetris's gear panel (`src/ui/theme.js`,
`GEAR_SLOTS`), keeping only the ballistics slots: ammo takes the free earpiece spot and
the rig the free left one. Plates and helmet attachments are 56 by 56 slots around their
parent (back plate above, front plate below, side plates and attachments beside it), so
the columns sit 72 apart and a 72 tall band runs between the rows (`armor-sim.js`,
`GEAR_LAYOUT`).

Keep from the source geometry:

- Slot bodies 125 by 125, each with a 131 by 20 header at (-3, -22).
- Each placeholder's original native dimensions and offsets from `theme.js`.
- The 512 by 768 character behind the panel, at the same offset from the middle column.
- One uniform scale for the whole panel, down to fit narrow panels and capped at native size.
