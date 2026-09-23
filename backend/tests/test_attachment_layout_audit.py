"""Keep the catalogue audit bounded and independent of application startup."""

import importlib.util
from pathlib import Path
import sqlite3

_SPEC = importlib.util.spec_from_file_location(
    "attachment_layout_audit", Path(__file__).resolve().parents[2] / "scripts" / "attachment_layout_audit.py"
)
_AUDIT = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_AUDIT)


def test_audit_handles_cycles_and_limits_details_without_hiding_counts():
    with sqlite3.connect(":memory:") as connection:
        connection.executescript("""
            CREATE TABLE items (id TEXT, name TEXT, is_weapon BOOLEAN, category_ids TEXT);
            CREATE TABLE slots (id TEXT, parent_item_id TEXT, slot_game_name TEXT, required BOOLEAN);
            CREATE TABLE slot_allowed_items (slot_id TEXT, allowed_item_id TEXT);
            INSERT INTO items VALUES ('gun', 'Gun', 1, NULL), ('adapter', 'Adapter', 0, NULL),
                ('unreachable', 'Outside the weapon graph', 0, NULL);
            INSERT INTO slots VALUES ('root', 'gun', 'mod_mount', 0),
                ('cycle', 'adapter', 'mod_mount', 0), ('unknown1', 'adapter', 'mod_new', 0),
                ('unknown2', 'adapter', 'mod_new', 0), ('outside', 'unreachable', 'mod_new', 0);
            INSERT INTO slot_allowed_items VALUES ('root', 'adapter'), ('cycle', 'gun');
            PRAGMA query_only = ON;
            """)
        report = _AUDIT.audit(connection, limit=1)
        assert report["weapon_count"] == 1
        assert report["reachable_item_count"] == 2
        assert report["reachable_slot_count"] == 4
        assert report["slot_bearing_item_count"] == 2
        assert report["unknown_slot_count"] == 2
        assert len(report["unknown_slots"]) == len(report["largest_semantic_families"]) == 1
        assert report["raw_signature_count"] == report["semantic_signature_count"] == 2
        assert report["roles"] == {"mount": 2, "unknown": 2}
        assert _AUDIT.audit(connection, limit=0)["unknown_slots"] == []
