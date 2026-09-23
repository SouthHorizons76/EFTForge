"""Audit weapon-reachable slot semantics without starting the app or changing its database."""

import argparse
from collections import Counter, defaultdict, deque
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from slot_semantics import slot_role


def audit(connection: sqlite3.Connection, limit: int = 20) -> dict:
    """Walk each reachable item once and report unresolved roles and recurring structures."""
    connection.row_factory = sqlite3.Row
    items = {row["id"]: dict(row) for row in connection.execute("SELECT id, name, is_weapon, category_ids FROM items")}
    slots_by_item = defaultdict(list)
    for row in connection.execute("SELECT id, parent_item_id, slot_game_name, required FROM slots ORDER BY id"):
        slots_by_item[row["parent_item_id"]].append(dict(row))
    allowed = defaultdict(list)
    for row in connection.execute("SELECT slot_id, allowed_item_id FROM slot_allowed_items"):
        allowed[row["slot_id"]].append(row["allowed_item_id"])

    visited = set()
    pending = deque(iid for iid, item in items.items() if item["is_weapon"])
    while pending:
        item_id = pending.popleft()
        if item_id in visited:
            continue
        visited.add(item_id)
        for slot in slots_by_item[item_id]:
            pending.extend(iid for iid in allowed[slot["id"]] if iid not in visited)

    unknown = []
    roles = Counter()
    raw_families = Counter()
    semantic_families = Counter()
    for item_id in sorted(visited):
        slots = slots_by_item[item_id]
        signature = []
        for slot in slots:
            categories = [items.get(iid, {}).get("category_ids") for iid in allowed[slot["id"]]]
            role = slot_role(slot["slot_game_name"], categories)
            roles[role] += 1
            signature.append((role, bool(slot["required"])))
            if role == "unknown":
                unknown.append({**slot, "parent_name": items.get(item_id, {}).get("name")})
        if slots:
            raw_families[tuple(sorted((s["slot_game_name"] or "", bool(s["required"])) for s in slots))] += 1
            semantic_families[tuple(sorted(signature))] += 1

    return {
        "weapon_count": sum(bool(item["is_weapon"]) for item in items.values()),
        "reachable_item_count": len(visited),
        "slot_bearing_item_count": sum(bool(slots_by_item[iid]) for iid in visited),
        "reachable_slot_count": sum(roles.values()),
        "roles": dict(sorted(roles.items())),
        "unknown_slot_count": len(unknown),
        "unknown_slots": unknown[:limit],
        "raw_signature_count": len(raw_families),
        "semantic_signature_count": len(semantic_families),
        "largest_semantic_families": [
            {"signature": signature, "item_count": count}
            for signature, count in sorted(semantic_families.items(), key=lambda pair: (-pair[1], pair[0]))[:limit]
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=Path(__file__).resolve().parents[1] / "backend" / "tarkov.db")
    parser.add_argument("--limit", type=int, default=20, help="Maximum details to print per report section")
    args = parser.parse_args()
    if args.limit < 0:
        parser.error("--limit must be zero or greater")
    with sqlite3.connect(f"{args.database.resolve().as_uri()}?mode=ro", uri=True) as connection:
        report = audit(connection, args.limit)
    print(json.dumps(report, indent=2, ensure_ascii=True))


if __name__ == "__main__":
    main()
