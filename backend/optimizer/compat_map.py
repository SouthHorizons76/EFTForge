"""Builds the weapon's attachment compatibility graph for the solver.

I'm reusing EFTForge's existing Slot/SlotAllowedItem tables instead of the
original optimizer's own BFS over a tarkov.dev-shaped item lookup - this is
the same compatibility graph the Combo Calculator already walks one level at
a time (see main.py's combo-full route), just traversed all the way out in
one pass here.
"""

from collections import deque
from typing import NamedTuple

from models_slots import Slot
from models_slot_allowed import SlotAllowedItem


class _SlotInfo(NamedTuple):
    id: str
    parent_item_id: str
    slot_name: str
    required: bool


class CompatMap:
    def __init__(self):
        self.reachable_ids = set()  # every mod id reachable from the weapon (excludes the weapon itself)
        self.slot_items = {}  # slot_id -> [item_id, ...] allowed in that slot
        self.slot_owner = {}  # slot_id -> id of the item (or weapon) that owns this slot
        self.item_to_slots = {}  # owner item id -> [slot_id, ...] it owns
        self.slots_by_id = {}  # slot_id -> immutable scalar slot record
        self.pruning_metrics = {}  # request-local measurements after market filtering


def build_compatibility_map(db, weapon_id: str) -> CompatMap:
    cmap = CompatMap()
    visited = set()
    slot_query = db.query(Slot.id, Slot.parent_item_id, Slot.slot_name, Slot.required)

    def _register_owner_slots(owner_id, slots):
        cmap.item_to_slots[owner_id] = [s.id for s in slots]
        for s in slots:
            cmap.slot_owner[s.id] = owner_id
            cmap.slots_by_id[s.id] = s
            cmap.slot_items.setdefault(s.id, [])

    weapon_slots = [_SlotInfo(*row) for row in slot_query.filter(Slot.parent_item_id == weapon_id).all()]
    _register_owner_slots(weapon_id, weapon_slots)

    frontier_slot_ids = deque(s.id for s in weapon_slots)
    while frontier_slot_ids:
        batch = list(frontier_slot_ids)
        frontier_slot_ids.clear()

        allowed_rows = (
            db.query(SlotAllowedItem.slot_id, SlotAllowedItem.allowed_item_id)
            .filter(SlotAllowedItem.slot_id.in_(batch))
            .all()
        )

        newly_discovered = set()
        for slot_id, allowed_item_id in allowed_rows:
            if allowed_item_id == weapon_id:
                continue  # a slot can't accept the weapon itself
            cmap.slot_items[slot_id].append(allowed_item_id)
            if allowed_item_id not in visited:
                newly_discovered.add(allowed_item_id)

        if not newly_discovered:
            continue

        visited |= newly_discovered
        cmap.reachable_ids |= newly_discovered

        child_slots = [_SlotInfo(*row) for row in slot_query.filter(Slot.parent_item_id.in_(newly_discovered)).all()]
        by_owner = {}
        for s in child_slots:
            by_owner.setdefault(s.parent_item_id, []).append(s)
        for owner_id, slots in by_owner.items():
            _register_owner_slots(owner_id, slots)
            frontier_slot_ids.extend(s.id for s in slots)

    return cmap
