# Ballistics loadout artwork

Reuse the equipment placeholders and character silhouette from TarkTetris's inventory UI.
Keep the original PNG files unchanged and apply EFTForge's colors and presentation in CSS.

Source paths in TarkTetris:

- `ui-assets/sprites/resources.assets/`: equipment, plate, attachment and ammo placeholders.
- `ui-assets/sprites/sharedassets44.assets/character_pmc.png`: character silhouette.

The equipment arrangement follows `src/ui/theme.js` (`GEAR_SLOTS`), with the rig in the
free left column and only ballistics-related equipment included. Render plates and helmet
attachments below their parent equipment. Keep ammo separate from the worn loadout.

Preserve the source geometry when styling the equipment:

- Use a 499 by 313 crop starting at source coordinates (64, 146).
- Keep slot bodies 125 by 125, with columns 184 apart and rows 166 apart.
- Place the 131 by 20 header at (-3, -22) relative to each slot body.
- Keep each placeholder's original native dimensions and offsets from `theme.js`.
- Position the 512 by 768 character at (-67, -49) within the crop.
- Scale the entire crop uniformly down to fit narrow panels and cap it at native size.
- Overlay item captions, class and durability within the body so equipping items preserves its size.
