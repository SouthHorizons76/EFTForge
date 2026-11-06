"""Export the inventory geometry the Atlas player lookup draws containers with.

    python scripts/build_inventory_grids.py [--tarktetris C:/Projects/TarkTetris]

Reads TarkTetris's toy-data (items.json, grid_layouts.json) and writes
backend/data/inventory_grids.json, which backend/inventory_grids.py reads:

- items: each template's cell size, plus what changes the size of whatever it's attached to
  (extra size, forced or not), whether it adds its attached parts' size to its own, and how
  it folds.
- containers: each container's grids in order (id, cells across, cells down), and the name
  of the rig or backpack layout that arranges them, as the game only uses one for those.
- layouts: each named layout's size and where each of its grids sits, in pixels.

Rerun after TarkTetris rebuilds its data for a new game version.
"""

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "backend" / "data" / "inventory_grids.json"


def build(tarktetris: Path) -> dict:
    data = json.loads((tarktetris / "toy-data" / "items.json").read_text(encoding="utf-8"))
    layouts = json.loads((tarktetris / "toy-data" / "grid_layouts.json").read_text(encoding="utf-8"))
    items, containers, used = {}, {}, set()
    for tpl in data["items"]:
        flags = tpl.get("flags") or {}
        entry = {"w": tpl["w"], "h": tpl["h"]}
        if tpl.get("extra"):
            entry["extra"] = tpl["extra"]  # left, right, up, down
            if flags.get("ExtraSizeForceAdd"):
                entry["forced"] = 1
        if tpl.get("cls") == "AmmoBox" or flags.get("MergesWithChildren"):
            entry["merges"] = 1
        if tpl.get("fold"):
            entry["fold"] = [tpl["fold"].get("slot"), tpl["fold"].get("reduceRight", 0)]
        items[tpl["id"]] = entry
        if tpl.get("grids"):
            layout = {"Vest": tpl.get("rigLayout"), "Backpack": tpl.get("gridLayout")}.get(tpl.get("cls"))
            container = {"grids": [[g["id"], g["w"], g["h"]] for g in tpl["grids"]]}
            if layout and layout in layouts:
                container["layout"] = layout
                used.add(layout)
            containers[tpl["id"]] = container
    return {
        "game_version": data["meta"].get("gameVersion"),
        "items": items,
        "containers": containers,
        "layouts": {
            name: {"w": layouts[name]["w"], "h": layouts[name]["h"], "grids": [r[:2] for r in layouts[name]["grids"]]}
            for name in sorted(used)
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tarktetris", type=Path, default=ROOT.parent / "TarkTetris")
    args = parser.parse_args()
    out = build(args.tarktetris)
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"{OUT.relative_to(ROOT)}: {len(out['items'])} items, {len(out['containers'])} containers, "
        f"{len(out['layouts'])} layouts, game {out['game_version']}, {OUT.stat().st_size // 1024} KB"
    )


if __name__ == "__main__":
    main()
