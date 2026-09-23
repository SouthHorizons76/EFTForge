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
- Fit handguard mounts in neighboring lower lanes and keep accessory branches
  within three columns. Measure occupied cells, then move a complete branch
  vertically if those cells conflict. Preserve its direction through adapters.
- Keep unknown roles with their owning branch and allocate real cells for them.
- Use the returned grid dimensions and weapon rectangle for both the workbench
  and image export. Preserve horizontal scroll during workbench rebuilds.
- Keep Combo View's assembly boundaries separate from visual placement rules.

## Layout contract

Each input descriptor contains `id`, `parentId`, `role`, and `order`. Use an
ancestry path as `id`, the owning slot's path as `parentId`, and `null` for direct
weapon slots. Use `order` as a stable sibling sort key, independent of API response
order.

Return `positions`, a map from instance path to `{ col, row, extras: false }`, plus
`gunCol`, `gunRow`, `gunSpan`, `totalCols`, and `totalRows`. Coordinates start at one.
Return ten columns, with the weapon starting at column seven. Keep every input
slot visible exactly once, with no overlap between slots or the weapon. Reject duplicate IDs and ancestry
cycles. Keep a descriptor with an unavailable owner visible below the weapon.
Grow vertically as attachments are added; do not widen the frame to fit entire
subtree rectangles. Use internal numbered slot names for stable ordering only,
not as claims about a rail's physical orientation.

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
or purpose.

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
slots, losing their ownership, or restoring absolute per-item coordinates. The
source data does not provide physical rail orientation.

Add small semantic placement hints only for ambiguities that cannot be resolved
from ownership and compatibility. Retire legacy overrides as their cases are
covered. Keep release hashes untouched during development; the release helper
will also hash new local JavaScript and CSS tags that have no version parameter.
