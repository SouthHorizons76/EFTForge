"""Inventory geometry for the Atlas player lookup: how a container's grids are laid out, and
how many cells an item takes in them.

Reads data/inventory_grids.json (scripts/build_inventory_grids.py). An item's size follows
the game's rules, as TarkTetris implements them (src/engine/size.js):

- an item that merges with its children (a weapon, an ammo box...) grows by what's attached
  to it, except the chambered round and a folded stock's own slot, and so on down the tree;
- each attached part adds its extra size on each side: the largest wins for plain extra
  size, forced extra size adds up;
- a folded part takes its fold reduction off the right side (forced, on the item itself).

Positions are in the game's pixels: 63 px per cell, a grid n cells wide is 63n + 1 px.
"""

import json
from functools import lru_cache
from pathlib import Path

DATA = Path(__file__).resolve().parent / "data" / "inventory_grids.json"
CELL = 63
ROW_GAP = 6  # between grids without a layout, in one row


def cell_px(cells: int) -> int:
    return cells * CELL + 1


@lru_cache(maxsize=1)
def _data() -> dict:
    try:
        return json.loads(DATA.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"items": {}, "containers": {}, "layouts": {}}


def _template(tpl: str) -> dict:
    return _data()["items"].get(tpl) or {}


def _extra(t: dict) -> list:
    """[left, right, up, down, forced left, forced right, forced up, forced down]."""
    left, right, up, down = (t.get("extra") or [0, 0, 0, 0])[:4]
    return [0, 0, 0, 0, left, right, up, down] if t.get("forced") else [left, right, up, down, 0, 0, 0, 0]


def cell_size(node: dict) -> tuple[int, int]:
    """(cells across, cells down) of an item as it's built, before any turn in its grid."""
    total = [0] * 8
    stack = [(node, True)]
    while stack:
        item, root = stack.pop()
        t = _template(item.get("tpl"))
        extra = [0] * 8 if root else _extra(t)
        fold = t.get("fold")
        folded = bool(fold and item.get("folded"))
        if folded:
            extra[5 if root else 1] -= fold[1] or 0
        total = [max(a, b) for a, b in zip(total[:4], extra[:4])] + [a + b for a, b in zip(total[4:], extra[4:])]
        if not t.get("merges"):
            continue
        fold_slot = fold[0] if folded else None
        for child in item.get("children") or []:
            if child.get("slot") not in ("patron_in_weapon", fold_slot):
                stack.append((child, False))
        for inside in item.get("contents") or []:
            stack.append((inside, False))
    base = _template(node.get("tpl"))
    return (
        max(1, base.get("w", 1) + total[0] + total[1] + total[4] + total[5]),
        max(1, base.get("h", 1) + total[2] + total[3] + total[6] + total[7]),
    )


def container_grid(tpl: str) -> dict | None:
    """A container's grids as the game lays them out: its rig or backpack layout when it has
    one, otherwise one row. {w, h, grids: [{id, w, h, x, y}]}, sizes of grids in cells, the
    rest in pixels; None for an item without grids."""
    container = _data()["containers"].get(tpl)
    if not container:
        return None
    grids = [{"id": gid, "w": max(1, w), "h": max(1, h)} for gid, w, h in container["grids"]]
    layout = _data()["layouts"].get(container.get("layout") or "")
    if layout and len(layout["grids"]) >= len(grids):
        for grid, (x, y) in zip(grids, layout["grids"]):
            grid["x"], grid["y"] = x, y
        return {"w": layout["w"], "h": layout["h"], "grids": grids}
    x, height = -1, 0
    for grid in grids:
        grid["x"], grid["y"] = x, 0
        x += cell_px(grid["w"]) + ROW_GAP
        height = max(height, cell_px(grid["h"]))
    return {"w": x - ROW_GAP, "h": height + 1, "grids": grids}


def add_geometry(nodes: list) -> None:
    """Give every container among nodes (and inside them) its `grid`, and everything in one
    its `size` in cells and the `grid_index` it sits in."""
    for node in nodes:
        grid = container_grid(node.get("tpl"))
        if grid:
            node["grid"] = grid
        ids = [g["id"] for g in grid["grids"]] if grid else []
        for inside in node.get("contents") or []:
            inside["size"] = list(cell_size(inside))
            inside["grid_index"] = ids.index(inside.get("slot")) if inside.get("slot") in ids else 0
        add_geometry(node.get("contents") or [])
