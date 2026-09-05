"""Shared, request-local compatibility index and conservative graph pruning.

The index copies primitive graph data, never session-bound ORM objects. Views
do not mutate it. Full-build required-slot propagation is opt-in: the Combo
Calculator intentionally permits incomplete assemblies and annotated conflicts.
"""

from collections import defaultdict, deque
from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping


@dataclass(frozen=True)
class PrunedCompatibility:
    item_ids: frozenset[str]
    slot_items: Mapping[str, tuple[str, ...]]
    empty_required_roots: frozenset[str]
    unreachable_count: int
    required_failure_count: int
    passes: int


class CompatibilityIndex:
    def __init__(self, slots, slot_items, items):
        slots = tuple(slots)
        owners = {s.id: s.parent_item_id for s in slots}
        owned = defaultdict(list)
        for sid, owner in owners.items():
            owned[owner].append(sid)
        incoming = defaultdict(list)
        edges = {s: tuple(dict.fromkeys(ids)) for s, ids in slot_items.items()}
        for sid, ids in edges.items():
            for iid in ids:
                incoming[iid].append(sid)
        self.slot_items = MappingProxyType(edges)
        self.slot_owner = MappingProxyType(owners)
        self.item_slots = MappingProxyType({i: tuple(s) for i, s in owned.items()})
        self.incoming_slots = MappingProxyType({i: tuple(s) for i, s in incoming.items()})
        self.required_slots = frozenset(s.id for s in slots if s.required)
        self.item_conflicts = MappingProxyType(
            {i: frozenset(filter(None, (m.conflicting_item_ids or "").split(","))) for i, m in items.items()}
        )
        self.slot_conflicts = MappingProxyType(
            {i: frozenset(filter(None, (m.conflicting_slot_ids or "").split(","))) for i, m in items.items()}
        )
        reverse_items, reverse_slots = defaultdict(set), defaultdict(set)
        for iid, conflicts in self.item_conflicts.items():
            for other in conflicts:
                reverse_items[other].add(iid)
        for iid, conflicts in self.slot_conflicts.items():
            for sid in conflicts:
                reverse_slots[sid].add(iid)
        self._reverse_items = {i: frozenset(ids) for i, ids in reverse_items.items()}
        self._reverse_slots = {s: frozenset(ids) for s, ids in reverse_slots.items()}

    def _conflicts_against(self, fixed_ids):
        banned_items, banned_slots = set(), set()
        for iid in fixed_ids:
            banned_items.update(self.item_conflicts.get(iid, ()))
            banned_items.update(self._reverse_items.get(iid, ()))
            banned_slots.update(self.slot_conflicts.get(iid, ()))
            for sid in self.item_slots.get(iid, ()):
                banned_items.update(self._reverse_slots.get(sid, ()))
        return banned_items, banned_slots

    def blocked_edges(self, fixed_ids):
        """Conflicts against fixed items using Combo's existing four checks.

        Callers decide whether such conflicts exclude or merely annotate an
        option. Two optional candidates are never globally ruled out here.
        """
        banned_items, banned_slots = self._conflicts_against(fixed_ids)
        blocked = defaultdict(set)
        for iid in banned_items:
            for sid in self.incoming_slots.get(iid, ()):
                blocked[sid].add(iid)
        for sid in banned_slots:
            blocked[sid].update(self.slot_items.get(sid, ()))
        return dict(blocked)

    def owner_blocked_edges(self):
        """Placements conflicting with their own owner, which must be installed."""
        blocked = {}
        for owner, slots in self.item_slots.items():
            banned_items, banned_slots = self._conflicts_against({owner})
            for sid in slots:
                allowed = self.slot_items.get(sid, ())
                ids = set(allowed) if sid in banned_slots else banned_items.intersection(allowed)
                if ids:
                    blocked[sid] = ids
        return blocked

    def reachable(self, root_slots):
        """Cheap unfiltered traversal for callers checking whether a cut matters."""
        reached = set()
        queue = deque(root_slots)
        while queue:
            for iid in self.slot_items.get(queue.popleft(), ()):
                if iid not in reached:
                    reached.add(iid)
                    queue.extend(self.item_slots.get(iid, ()))
        return reached

    def prune(self, root_slots, allowed_ids, *, require_complete=False, blocked_edges=None):
        """Remove only candidates lacking structural support from these roots.

        Reverse-slot counts propagate required-slot failures in a work queue.
        A rooted traversal after each cascade also removes orphaned cycles;
        positive parent counts alone cannot establish reachability. This is a
        necessary-condition check, not a replacement for placement or MILP.
        """
        roots = frozenset(root_slots)
        alive = set(allowed_ids)
        blocked = blocked_edges or {}
        if not blocked and self.incoming_slots.keys() <= alive:
            # The optimizer already filters its input edges. Reuse both
            # directions instead of allocating the same adjacency lists twice.
            edges = self.slot_items
            incoming = self.incoming_slots
        else:
            edges = {
                s: tuple(i for i in ids if i in alive and i not in blocked.get(s, ()))
                for s, ids in self.slot_items.items()
            }
            incoming = defaultdict(list)
            for sid, ids in edges.items():
                for iid in ids:
                    incoming[iid].append(sid)
        counts = {s: len(ids) for s, ids in edges.items()}
        required = self.required_slots if require_complete else frozenset()
        # Only traversable slots belong to this view; other owner slots may
        # still be indexed for conflict checks.
        required = required & (edges.keys() | roots)
        failed_owners = deque(self.slot_owner[s] for s in required if counts.get(s, 0) == 0 and s not in roots)
        unreachable_count = required_failure_count = passes = 0
        while True:
            passes += 1
            reached = set()
            queue = deque(roots)
            while queue:
                sid = queue.popleft()
                for iid in edges.get(sid, ()):
                    if iid in alive and iid not in reached:
                        reached.add(iid)
                        queue.extend(self.item_slots.get(iid, ()))
            orphaned = alive - reached
            removals = deque((iid, False) for iid in orphaned)
            removals.extend((iid, True) for iid in failed_owners)
            failed_owners.clear()
            removed = False
            while removals:
                iid, required_failure = removals.popleft()
                if iid not in alive:
                    continue
                removed = True
                alive.remove(iid)
                required_failure_count += int(required_failure)
                unreachable_count += int(not required_failure)
                for sid in incoming.get(iid, ()):
                    counts[sid] -= 1
                    if counts[sid] == 0 and sid in required and sid not in roots:
                        removals.append((self.slot_owner[sid], True))
            if not removed:
                break
        return PrunedCompatibility(
            frozenset(alive),
            MappingProxyType(
                {
                    s: tuple(i for i in ids if i in alive) if s in roots or self.slot_owner[s] in alive else ()
                    for s, ids in edges.items()
                }
            ),
            frozenset(s for s in roots & required if counts.get(s, 0) == 0),
            unreachable_count,
            required_failure_count,
            passes,
        )
