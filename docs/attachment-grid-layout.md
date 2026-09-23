# Attachment grid layout refactor

Keep the installed build tree as the source of slot ownership. Reserve a compact
weapon silhouette first, then fit accessory branches around their owners. Use
slot semantics and ancestry rather than individual item coordinates.

## First implementation

- Resolve `slot_role` in `backend/slot_semantics.py` from internal game slot names.
  Narrow generic mount slots only when the compatible items' category IDs agree
  on one known role. Keep mixed or incomplete evidence as `mount`.
- Return the same `slot_role` and `required` fields from individual slot requests,
  batched requests, and gun initialization.
- Return `slot_mount` and `slot_mount_source` through those same paths. Use
  generated mount geometry for handguard rails and compatibility for MPR45-only
  ports, including those internally named mount or tactical. Keep mounting
  direction separate from attachment role.
- Return `attachment_role` with build items from category IDs. When a generic
  mount contains a known handguard, stock, or other part, use that installed role
  for placement. Keep explicit slot roles authoritative and leave empty mixed
  mounts generic. Preserve this metadata through factory, manual, saved-build,
  and combo loading paths.
- Collect slot instance paths from the weapon, ancestor slots, and installed item
  IDs. Keep repeated copies of the same attachment distinct without occurrence
  counters.
- Pass plain descriptors to `EFTForge.attachmentLayout.compute(entries)` in
  `frontend/modules/attachment-layout.js`. Keep this engine independent of the
  DOM, API requests, build state, and coordinate overrides.
- Reserve a ten-column frame, with the weapon in columns seven through nine and
  the stock in column ten. Put one primary receiver, handguard, catch, barrel,
  gas block, and muzzle in the contiguous left queue when those roles exist.
- Anchor receiver optics above the weapon, the rear sight in column nine, the
  charging handle in column ten, and the magazine/pistol grip below the weapon.
  Resolve these positions through receiver and chassis ownership instead of
  letting attachment depth widen the silhouette.
- Extend repeated body parts and stock/buffer chains vertically in the same
  columns before placing their accessories. Keep child optics on a handguard
  above that handguard, including when it consists of multiple pieces.
- Put left/right handguard rails below-left/below-right, bottom rails directly
  below, top tactical rails directly above, and MPR45-only scope slots above-left.
  Keep descendants in their port's column and direction through adapters. Stack
  ports sharing a side outward without moving them to the opposite side.
- Spread unmeasured handguard tactical/mount slots across neighboring lower lanes.
  Treat this as fallback placement, not evidence of physical orientation.
  Measure occupied cells and move complete branches vertically on collision.
- Keep unknown roles with their owning branch and allocate real cells for them.
- Use the returned grid dimensions and weapon rectangle for both the workbench
  and image export. Preserve horizontal scroll during workbench rebuilds.
- Keep Combo View's assembly boundaries separate from visual placement rules.

## Layout contract

Each input descriptor contains `id`, `parentId`, `role`, `mount`, and `order`. Use an
ancestry path as `id`, the owning slot's path as `parentId`, and `null` for direct
weapon slots. Use `order` as a stable sibling sort key, independent of API response
order. Pass `slot_mount` as `mount`: `left`, `right`, `top`, `bottom`,
`offset_left`, or `unknown`. Apply these ports to tactical, mount, and scope
children of handguards and inherit the resulting lane through their accessory
descendants. Keep explicit foregrip/bipod slots below regardless of connector
normals. Ignore missing or unsupported port values and use the ordinary fallback.

Return `positions`, a map from instance path to `{ col, row, extras: false }`, plus
`gunCol`, `gunRow`, `gunSpan`, `totalCols`, and `totalRows`. Coordinates start at one.
Return ten columns, with the weapon starting at column seven. Keep every input
slot visible exactly once, with no overlap between slots or the weapon. Reject duplicate IDs and ancestry
cycles. Keep a descriptor with an unavailable owner visible below the weapon.
Grow vertically as attachments are added; do not widen the frame to fit entire
subtree rectangles. Use internal numbered slot names for stable ordering only,
not as claims about a rail's physical orientation.

## Generate physical ports

The item database has no physical transforms. The existing Kitbash asset data
does: `bones-all.json` stores mount rotations and `sprites.manifest.json` stores
the owner's baked orientations. Compose those rotations and classify the mount's
outward normal in the weapon frame. Use the normal rather than its position:
some model pivots are displaced and several handguards mount upside-down.
Require agreement across baked owner orientations; leave ambiguous cases unknown.
Map positive model X to grid left, matching the HK Quad Rail reference layout.
Keep diagonal side rails on their respective left/right lanes.

Generate the shared profiles from the repository root after updating the local
catalogue and Kitbash assets:

```powershell
backend/venv/Scripts/python.exe scripts/generate_slot_mounts.py --kitbash-data C:/Projects/Kitbash/data
```

Use `--database` and `--output` to select alternate paths, or `--check` to verify
that the existing output matches without writing. Read the catalogue and Kitbash
files without changing either. Commit the generated `backend/data/slot_mounts.json`
with the code. Deduplicate identical port profiles and generate template mappings;
do not edit either by hand. The deployed API reads this compact file and requires
no Kitbash checkout. Include it in the desktop backend bundle as well.

Recognize MPR45-only scope, mount, and tactical slots by the exact compatible item
ID. Their upper-left grid placement is a presentation convention; the parent rail
itself can face up.
Recheck that compatibility against the current database when serving slots,
including new templates that do not yet have generated geometry.

Unknown template/slot keys remain usable with fallback placement until the next
generation. Return `slot_mount_source` as `geometry`, `compatibility`, or `unknown`
so diagnostics can distinguish measured ports from fallback. Keep these fields
on rendered cells as `data-slot-mount` and `data-slot-mount-source`.

## Compare during migration

Automatic layout is the default on this branch. Keep the existing coordinate
overrides and legacy engine available for comparison until representative builds
have been reviewed.

On localhost, open the existing grid devtool with `_agDevTool.show()`. Use its
`Layout: Automatic` / `Layout: Legacy` button, or call
`_agDevTool.setLayout('automatic')` / `_agDevTool.setLayout('legacy')`. Persist this
choice locally. Enable coordinate dragging only in Legacy mode; automatic layout
does not consume `_AG_OVERRIDES`.

## Catalogue audit

Run this from the repository root to inspect the local database without starting
the app, syncing data, or modifying the database:

```powershell
backend/venv/Scripts/python.exe scripts/attachment_layout_audit.py --limit 20
```

Report weapon-reachable roles, unknown slot definitions, and recurring immediate
slot structures. Bound traversal by visiting each item once. Count generic mounts
separately from unknown roles: a known mount can still have ambiguous orientation
or purpose. Report handguard rail coverage by mount source and list unknown ports
separately, so new templates that need a geometry refresh are visible even when
their attachment roles are already known. Exclude foregrip/bipod connectors from
this rail audit and keep those slots below the handguard by their functional role.

Treat this as a metadata audit. It does not enumerate every legal build or prove
layout quality. The existing frontend overlap scanner also retains its legacy
sampling strategy and does not provide exhaustive coverage of automatic layout.

## Verification and next steps

Use backend tests for role classification, endpoint consistency, batched lookup
cost, audit traversal, and release hashing. Frontend regression files cover the
pure engine, grid integration, and Combo View boundaries. Keep frontend execution
and visual verification with the maintainer, as required by `AGENTS.md`.

Review representative pistols, rifles, shotguns, long muzzle/stock chains, wide
handguards, repeated mounts, and unknown-slot fallbacks. Check selection, removal,
parent highlighting, horizontal scrolling, and exported images.

Follow up by generating representative legal build fixtures from catalogue
structures and tuning reusable assembly rules against them. Deep or heavily
branched builds can need additional rows. Improve compactness without dropping
slots, losing their ownership, or restoring absolute per-item coordinates.

Extend geometry-based ports to other assemblies as their mounting conventions
are established. Retire legacy overrides as their cases are covered. Keep release
hashes untouched during development; the release helper
will also hash new local JavaScript and CSS tags that have no version parameter.
