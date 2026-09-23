"""Generate compact handguard port hints from a read-only catalogue and measured Kitbash geometry."""

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import sqlite3
import sys

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "backend"))

from slot_mounts import MPR45_ID, classify_bone_mount
from slot_semantics import category_role, slot_role

# Keep explicit foregrips and bipods in their functional lower lane. Their
# connector bones do not consistently point outward from the handguard.
_ACCESSORY_ROLES = {"mount", "tactical", "scope"}
_STRUCTURAL_ROLES = {"receiver", "handguard", "barrel", "gas_block", "stock", "pistol_grip", "magazine", "charge"}


def generate(connection: sqlite3.Connection, bones_data: dict, manifest: dict) -> tuple[dict, dict]:
    """Require agreement across every baked owner orientation and deduplicate identical profiles."""
    if manifest.get("version") != 5:
        raise ValueError("Expected Kitbash sprite manifest version 5")
    bones = {entry["tpl"]: entry.get("bones", {}) for entry in bones_data["weapons"]}
    roles = {iid: category_role(ids) for iid, ids in connection.execute("SELECT id, category_ids FROM items")}
    allowed = defaultdict(set)
    for sid, iid in connection.execute("SELECT slot_id, allowed_item_id FROM slot_allowed_items"):
        allowed[sid].add(iid)
    by_owner = defaultdict(dict)
    counts = Counter()
    query = "SELECT id, parent_item_id, slot_game_name FROM slots ORDER BY parent_item_id, slot_game_name, id"
    for sid, owner, game_name in connection.execute(query):
        role = slot_role(game_name)
        if roles.get(owner) != "handguard" or role not in _ACCESSORY_ROLES:
            continue
        counts["accessory_ports"] += 1
        if any(roles.get(iid) in _STRUCTURAL_ROLES for iid in allowed[sid]):
            counts["structural_filters_skipped"] += 1
            continue
        if allowed[sid] == {MPR45_ID}:
            direction = "offset_left"
        else:
            model = manifest.get("templates", {}).get(owner)
            variants = manifest.get("models", {}).get(model, [])
            direction = classify_bone_mount(bones.get(owner, {}).get(game_name), [v.get("q") for v in variants])
        counts[direction] += 1
        if direction != "unknown":
            by_owner[owner][game_name] = direction

    signatures = {owner: tuple(sorted(profile.items())) for owner, profile in by_owner.items()}
    profiles = sorted(set(signatures.values()))
    indexes = {profile: index for index, profile in enumerate(profiles)}
    data = {
        "version": 1,
        "source": "Generated from Kitbash bones-all.json, sprite manifest v5, and catalogue compatibility",
        "profiles": [dict(profile) for profile in profiles],
        "items": {owner: indexes[profile] for owner, profile in sorted(signatures.items())},
    }
    return data, {**dict(sorted(counts.items())), "items": len(signatures), "profiles": len(profiles)}


def encode(data: dict) -> str:
    """Keep each shared profile and template mapping compact and deterministic."""
    lines = ["{", f'  "version": {data["version"]},', f'  "source": {json.dumps(data["source"])},', '  "profiles": [']
    lines.extend(
        "    " + json.dumps(profile, separators=(",", ":")) + ("," if i < len(data["profiles"]) - 1 else "")
        for i, profile in enumerate(data["profiles"])
    )
    lines.extend(["  ],", '  "items": {'])
    lines.extend(
        f"    {json.dumps(owner)}: {index}" + ("," if i < len(data["items"]) - 1 else "")
        for i, (owner, index) in enumerate(data["items"].items())
    )
    lines.extend(["  }", "}"])
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=REPO_ROOT / "backend" / "tarkov.db")
    parser.add_argument("--kitbash-data", type=Path, default=REPO_ROOT.parent / "Kitbash" / "data")
    parser.add_argument("--output", type=Path, default=REPO_ROOT / "backend" / "data" / "slot_mounts.json")
    parser.add_argument("--check", action="store_true", help="Compare against the checked-in output without writing")
    args = parser.parse_args()
    bones = json.loads((args.kitbash_data / "bones-all.json").read_text(encoding="utf-8"))
    manifest = json.loads((args.kitbash_data / "sprites.manifest.json").read_text(encoding="utf-8"))
    with sqlite3.connect(f"{args.database.resolve().as_uri()}?mode=ro", uri=True) as connection:
        data, report = generate(connection, bones, manifest)
    content = encode(data)
    if args.check:
        if not args.output.is_file() or args.output.read_text(encoding="utf-8") != content:
            raise SystemExit("Generated slot mount metadata differs from the requested output")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("w", encoding="utf-8", newline="\n") as output:
            output.write(content)
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
