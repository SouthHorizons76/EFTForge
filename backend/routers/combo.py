"""Combo recommender: ranks attachment combinations for a slot in one request."""

import json
import time
from types import SimpleNamespace
from typing import Annotated, List

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from combo_transport import ComboResponseFormat, combo_result_event, format_combo_result
from compatibility import CompatibilityIndex
from models_items import Item
from models_slot_allowed import SlotAllowedItem
from models_slots import Slot
from routers.shared import (
    EQUIP_ERGO_MAX,
    EQUIP_ERGO_MIN,
    MAX_INSTALLED_IDS,
    STRENGTH_LEVEL_MAX,
    STRENGTH_LEVEL_MIN,
    cap_list,
    get_db,
    item_name,
    item_short_name,
)
from services.conflicts import check_conflicts
from services.solver_cache import COMBO_FULL_CACHE, COMBO_FULL_CACHE_LOCK, solver_cache_generation
from stats import _compute_stats

router = APIRouter()


# ---------------------------------------------------
# Combo Full (single-request combo recommender)
# ---------------------------------------------------


def _dedup_by_stats(combos: list) -> list:
    """Keep one combo per unique stat fingerprint (recoil, ergo, TrueErgo, weight).
    Removes color-variant duplicates and any other items with identical stat contributions."""
    seen: dict = {}
    result: list = []
    for combo in combos:
        fp = (
            round(combo.get("recoil_vertical") or 0, 1),
            round(combo.get("total_ergo") or 0, 1),
            round(combo.get("true_ergo_delta") or 0, 2),
            round(combo.get("total_weight") or 0, 3),
        )
        if fp not in seen:
            seen[fp] = True
            result.append(combo)
    return result


_COMBO_FULL_CACHE_MAX = 500
_COMBO_FRONTIER_CAP = 10_000
_COMBO_NESTED_EXPANSION_LIMIT = 50_000


@router.post("/build/combo-full")
def combo_full(
    base_item_id: str = Body(...),
    installed_ids: List[str] = Body(...),
    root_slot_id: str = Body(...),
    lang: str = Body(default="en"),
    strength_level: int = Body(default=10),
    equip_ergo_modifier: float = Body(default=0.0),
    exclude_child_slot_names: List[str] = Body(default=[]),
    exclude_item_ids: List[str] = Body(default=[]),
    db: Session = Depends(get_db),
    response_format: Annotated[ComboResponseFormat, Body()] = "legacy",
):
    _combo_started = time.perf_counter()
    if not (STRENGTH_LEVEL_MIN <= strength_level <= STRENGTH_LEVEL_MAX):
        raise HTTPException(
            status_code=422, detail=f"strength_level must be between {STRENGTH_LEVEL_MIN} and {STRENGTH_LEVEL_MAX}"
        )
    if not (EQUIP_ERGO_MIN <= equip_ergo_modifier <= EQUIP_ERGO_MAX):
        raise HTTPException(
            status_code=422, detail=f"equip_ergo_modifier must be between {EQUIP_ERGO_MIN} and {EQUIP_ERGO_MAX}"
        )

    cap_list("installed_ids", installed_ids, MAX_INSTALLED_IDS)
    cap_list("exclude_child_slot_names", exclude_child_slot_names, 200)
    cap_list("exclude_item_ids", exclude_item_ids, 2000)

    _cache_key = (
        solver_cache_generation(),
        base_item_id,
        tuple(sorted(installed_ids)),
        root_slot_id,
        lang,
        strength_level,
        round(equip_ergo_modifier, 6),
        frozenset(exclude_child_slot_names),
        frozenset(exclude_item_ids),
    )
    with COMBO_FULL_CACHE_LOCK:
        cached = COMBO_FULL_CACHE.get(_cache_key)
    if cached is not None:
        cached_result = {
            **cached,
            "metrics": {
                **cached.get("metrics", {}),
                "cache_hit": True,
                "processing_ms": round((time.perf_counter() - _combo_started) * 1000, 3),
            },
        }

        def _cached_stream():
            yield combo_result_event(cached_result, response_format)

        return StreamingResponse(
            _cached_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # 1. Base item
    base_item = db.query(Item).filter(Item.id == base_item_id).first()
    if not base_item:
        raise HTTPException(status_code=404, detail="Base item not found")

    # 2. Pre-load installed items and their slots (for conflict checks)
    installed_set_base = set(installed_ids) | {base_item_id}
    installed_items_list = db.query(Item).filter(Item.id.in_(installed_set_base)).all() if installed_ids else []
    items_map = {item.id: item for item in installed_items_list}
    items_map[base_item_id] = base_item

    installed_slots = db.query(Slot).filter(Slot.parent_item_id.in_(installed_set_base)).all()
    slots_by_item: dict = {iid: [] for iid in installed_set_base}
    for s in installed_slots:
        slots_by_item[s.parent_item_id].append(s)

    # 3. Load parent candidates for root slot + their items in one join
    root_allowed_rows = (
        db.query(Item)
        .join(SlotAllowedItem, SlotAllowedItem.allowed_item_id == Item.id)
        .filter(SlotAllowedItem.slot_id == root_slot_id)
        .all()
    )
    for item in root_allowed_rows:
        items_map[item.id] = item

    # 4. Check parents for external conflicts against the base installed set only.
    # All parents are kept - externally conflicting ones are included but marked.
    base_only_items_map = {iid: items_map[iid] for iid in installed_set_base if iid in items_map}
    all_parents = list(root_allowed_rows)
    parent_external_conflict: dict = {}
    for candidate in all_parents:
        r = check_conflicts(
            candidate,
            candidate.id,
            installed_set_base,
            base_only_items_map,
            slots_by_item,
            root_slot_id,
            lang,
        )
        if not r["valid"]:
            parent_external_conflict[candidate.id] = r

    base_stats = _compute_stats(base_item, installed_ids, items_map, strength_level, equip_ergo_modifier)

    if not all_parents:
        result = {
            "base": base_stats,
            "combos": [],
            "timed_out": False,
            "truncated": False,
            "truncation_reasons": [],
            "metrics": {
                "root_candidate_count": 0,
                "child_candidate_edge_count": 0,
                "nested_candidate_edge_count": 0,
                "reachable_item_count": 0,
                "frontier_peak": 0,
                "frontier_states_generated": 0,
                "frontier_cap_hits": 0,
                "nested_expansion_skips": 0,
                "pruning_ms": 0.0,
                "pruned_candidate_edge_count": 0,
                "pruning_passes": 0,
                "combo_count_before_dedup": 0,
                "combo_count": 0,
                "cache_hit": False,
                "processing_ms": round((time.perf_counter() - _combo_started) * 1000, 3),
            },
        }
        return format_combo_result(result, response_format)

    all_parent_ids = [p.id for p in all_parents]

    # 5. Load child slots for all parents
    all_child_slots = db.query(Slot).filter(Slot.parent_item_id.in_(all_parent_ids)).all()

    # Determine which child slots have allowed items (one count query)
    all_child_slot_ids = [s.id for s in all_child_slots]
    slot_has_items: set = set()
    if all_child_slot_ids:
        counts = (
            db.query(SlotAllowedItem.slot_id).filter(SlotAllowedItem.slot_id.in_(all_child_slot_ids)).distinct().all()
        )
        slot_has_items = {row[0] for row in counts}

    _EXCLUDED_SLOT_NAMES = frozenset(["Scope", "Tactical", "Front Sight", "Rear Sight"])
    exclude_names = set(exclude_child_slot_names) | _EXCLUDED_SLOT_NAMES
    child_slots_by_parent: dict = {}
    for s in all_child_slots:
        if s.id in slot_has_items and s.slot_name not in exclude_names:
            child_slots_by_parent.setdefault(s.parent_item_id, []).append(s)

    # 6. Load all child candidate items for all active child slots
    active_child_slot_ids = [s.id for slots in child_slots_by_parent.values() for s in slots]
    child_items_by_slot: dict = {}
    if active_child_slot_ids:
        child_allowed_rows = (
            db.query(SlotAllowedItem.slot_id, Item)
            .join(Item, SlotAllowedItem.allowed_item_id == Item.id)
            .filter(SlotAllowedItem.slot_id.in_(active_child_slot_ids))
            .all()
        )
        for slot_id_col, item in child_allowed_rows:
            child_items_by_slot.setdefault(slot_id_col, []).append(item)
            items_map[item.id] = item

    # Item ID exclusion: drop specific items from all child slots.
    # Also drops the slot entirely if it ends up empty after exclusion.
    if exclude_item_ids:
        _exclude_ids = set(exclude_item_ids)
        child_items_by_slot = {
            sid: [i for i in items if i.id not in _exclude_ids] for sid, items in child_items_by_slot.items()
        }
    child_slots_by_parent = {
        pid: [s for s in slots if child_items_by_slot.get(s.id)] for pid, slots in child_slots_by_parent.items()
    }

    # 7. Load slots for all parent + child items (needed for slot-conflict checks during expansion)
    all_combo_item_ids = set(all_parent_ids) | {item.id for items in child_items_by_slot.values() for item in items}
    if all_combo_item_ids:
        combo_item_slots = db.query(Slot).filter(Slot.parent_item_id.in_(all_combo_item_ids)).all()
        for s in combo_item_slots:
            slots_by_item.setdefault(s.parent_item_id, []).append(s)

    # BFS: recursively load child slots/items for ALL child items, not just
    # mount items. Stops when nothing new is found or the depth limit is hit.
    nested_slots_by_item: dict = {}  # item_id -> [Slot]
    nested_items_by_slot: dict = {}  # slot_id -> [Item]

    _excl_ids = set(exclude_item_ids) if exclude_item_ids else set()
    _already_expanded: set = set(all_parent_ids)
    _to_expand: set = {item.id for items in child_items_by_slot.values() for item in items}
    _already_expanded |= _to_expand

    _MAX_NEST_DEPTH = 4
    for _depth in range(_MAX_NEST_DEPTH):
        if not _to_expand:
            break

        _nest_slots = db.query(Slot).filter(Slot.parent_item_id.in_(_to_expand)).all()
        _nest_slot_ids = [s.id for s in _nest_slots]
        if not _nest_slot_ids:
            break

        _nest_has_items = {
            row[0]
            for row in db.query(SlotAllowedItem.slot_id)
            .filter(SlotAllowedItem.slot_id.in_(_nest_slot_ids))
            .distinct()
            .all()
        }
        _active_nest_slots = [s for s in _nest_slots if s.id in _nest_has_items and s.slot_name not in exclude_names]
        for s in _active_nest_slots:
            nested_slots_by_item.setdefault(s.parent_item_id, []).append(s)

        _active_nest_slot_ids = [s.id for s in _active_nest_slots]
        if not _active_nest_slot_ids:
            break

        _nest_rows = (
            db.query(SlotAllowedItem.slot_id, Item)
            .join(Item, SlotAllowedItem.allowed_item_id == Item.id)
            .filter(SlotAllowedItem.slot_id.in_(_active_nest_slot_ids))
            .all()
        )
        _next_expand: set = set()
        for _slot_id_col, _nest_item in _nest_rows:
            if _nest_item.id in _excl_ids:
                continue
            nested_items_by_slot.setdefault(_slot_id_col, []).append(_nest_item)
            items_map[_nest_item.id] = _nest_item
            if _nest_item.id not in _already_expanded:
                _next_expand.add(_nest_item.id)
                _already_expanded.add(_nest_item.id)

        # Drop slots that ended up empty after exclusion
        nested_slots_by_item = {
            mid: [s for s in slots if nested_items_by_slot.get(s.id)] for mid, slots in nested_slots_by_item.items()
        }

        # Load slots for newly found items (needed for conflict checking)
        if _next_expand:
            _new_item_slots = db.query(Slot).filter(Slot.parent_item_id.in_(_next_expand)).all()
            for s in _new_item_slots:
                slots_by_item.setdefault(s.parent_item_id, []).append(s)

        _to_expand = _next_expand

    # Release the DB connection now - all data is loaded into memory.
    # The expansion below is CPU-only and can run for several seconds on large trees;
    # holding the connection that whole time would block every other DB request.
    db.close()

    # Only deep trees benefit from eliminating an entire branch before state
    # expansion. Shallow combos keep their existing fast path. This index is
    # request-local; the existing generation-keyed result cache owns its lifetime.
    _index_started = time.perf_counter()
    combo_index = None
    if nested_items_by_slot:
        combo_index = CompatibilityIndex(
            [s for slots in slots_by_item.values() for s in slots],
            {
                sid: [item.id for item in items]
                for sid, items in {**child_items_by_slot, **nested_items_by_slot}.items()
            },
            items_map,
        )
    _pruning_metrics = {
        "pruning_ms": (time.perf_counter() - _index_started) * 1000,
        "pruned_candidate_edge_count": 0,
        "pruning_passes": 0,
    }

    # Deep trees repeatedly aggregate the same loaded scalar fields. Snapshot
    # once to avoid ORM descriptor dispatch in every build; the shared stats
    # function remains the sole implementation of the formulas.
    stats_items_map: dict = items_map
    if combo_index is not None:
        columns = tuple(column.key for column in Item.__table__.columns)
        stats_items_map = {
            iid: SimpleNamespace(**{key: getattr(item, key) for key in columns}) for iid, item in items_map.items()
        }
    stats_base_item = stats_items_map[base_item_id]

    # 8. Helper to serialize an item for the response
    serialized_items: dict[str, dict] = {}

    def _ser(item):
        # Records are read-only throughout result assembly and deduplication.
        # Reuse one per item instead of allocating one per occurrence in builds.
        if item.id in serialized_items:
            return serialized_items[item.id]
        record = {
            "id": item.id,
            "name": item_name(item, lang),
            "short_name": item_short_name(item, lang),
            "weight": item.weight,
            "ergonomics_modifier": item.ergonomics_modifier,
            "recoil_modifier": item.recoil_modifier,
            "accuracy_modifier": item.accuracy_modifier,
            "center_of_impact": item.center_of_impact,
            "deviation_curve": item.deviation_curve,
            "deviation_max": item.deviation_max,
            "sighting_range": item.sighting_range,
            "heat_factor": item.heat_factor,
            "cooling_factor": item.cooling_factor,
            "durability_burn_factor": item.durability_burn_factor,
            "velocity_modifier": item.velocity_modifier,
            "loudness": item.loudness,
            "icon_link": item.icon_link,
            "base_image_link": item.base_image_link,
            "conflicting_item_ids": item.conflicting_item_ids,
            "conflicting_slot_ids": item.conflicting_slot_ids,
            "magazine_capacity": item.magazine_capacity,
            "caliber": item.caliber,
            "is_weapon": item.is_weapon,
            "trader_price": item.trader_price,
            "trader_price_rub": item.trader_price_rub,
            "trader_currency": item.trader_currency,
            "trader_vendor": item.trader_vendor,
            "trader_min_level": item.trader_min_level,
            "task_unlock_id": item.task_unlock_id,
            "task_unlock_name": item.task_unlock_name,
            "task_unlock_name_zh": item.task_unlock_name_zh,
        }
        serialized_items[item.id] = record
        return record

    # 9. Conflict helpers and caches
    _valid_cache: dict = {}
    _ext_conflict_cache: dict = {}
    _owner_blocked = None

    def _get_external_conflict(item, slot_id):
        """Check item against the base installed set only (not combo items). Cached."""
        key = (item.id, slot_id)
        if key not in _ext_conflict_cache:
            r = check_conflicts(item, item.id, installed_set_base, base_only_items_map, slots_by_item, slot_id, lang)
            _ext_conflict_cache[key] = None if r["valid"] else r
        return _ext_conflict_cache[key]

    def _ser_conflict(r):
        if r is None:
            return None
        return {
            "reason_key": r["reason_key"],
            "reason_name": r["reason_name"],
            "conflicting_item_id": r["conflicting_item_id"],
            "conflicting_slot_id": r["conflicting_slot_id"],
        }

    def _validated_children(slot_id, inst_list, raw_candidates):
        """Returns [(item, external_conflict_or_None), ...] excluding internal conflicts."""
        key = (slot_id, tuple(sorted(inst_list)))
        if key in _valid_cache:
            return _valid_cache[key]
        # The frontend's installed_ids never include the weapon itself, so add it
        # here or a child that conflicts with the weapon (TRAX 2 on a Saiga-9) passes as clean.
        inst_set = set(inst_list) | {base_item_id}
        inst_items_map = {iid: items_map[iid] for iid in inst_set if iid in items_map}
        result = []
        for ci in raw_candidates:
            r_full = check_conflicts(ci, ci.id, inst_set, inst_items_map, slots_by_item, slot_id, lang)
            if r_full["valid"]:
                result.append((ci, None))
            else:
                # If the conflict is only with the base installed set (not with combo items),
                # include it as an externally conflicted option so it can be shown in red.
                r_ext = _get_external_conflict(ci, slot_id)
                if r_ext is not None:
                    result.append((ci, r_ext))
                # else: internal conflict (with parent or sibling child) - skip entirely
        _valid_cache[key] = result
        return result

    def _pruned_options(parent, root_slots):
        nonlocal _owner_blocked
        if combo_index is None:
            return child_items_by_slot, nested_items_by_slot
        started = time.perf_counter()
        if _owner_blocked is None:
            _owner_blocked = combo_index.owner_blocked_edges()
        blocked = combo_index.blocked_edges({parent.id})
        for sid, ids in _owner_blocked.items():
            blocked.setdefault(sid, set()).update(ids)
        if not any(blocked.values()):
            _pruning_metrics["pruning_ms"] += (time.perf_counter() - started) * 1000
            return child_items_by_slot, nested_items_by_slot
        reachable = combo_index.reachable(root_slots)
        # External conflicts are deliberately still shown in red. Even when
        # an internal conflict also exists, preserve _validated_children's
        # existing external-conflict precedence.
        blocked = {
            sid: {iid for iid in ids if _get_external_conflict(items_map[iid], sid) is None}
            for sid, ids in blocked.items()
            if sid in root_slots or combo_index.slot_owner.get(sid) in reachable
        }
        if not any(blocked.values()):
            _pruning_metrics["pruning_ms"] += (time.perf_counter() - started) * 1000
            return child_items_by_slot, nested_items_by_slot
        pruned = combo_index.prune(root_slots, reachable, blocked_edges=blocked)
        original_edges = sum(
            len(ids)
            for sid, ids in combo_index.slot_items.items()
            if sid in root_slots or combo_index.slot_owner[sid] in reachable
        )
        _pruning_metrics["pruned_candidate_edge_count"] += original_edges - sum(map(len, pruned.slot_items.values()))
        _pruning_metrics["pruning_passes"] += pruned.passes

        def restrict(options):
            return {
                sid: [item for item in items if item.id in pruned.slot_items.get(sid, ())]
                for sid, items in options.items()
            }

        children, nested = restrict(child_items_by_slot), restrict(nested_items_by_slot)
        _pruning_metrics["pruning_ms"] += (time.perf_counter() - started) * 1000
        return children, nested

    def _expand_item(base_state, item, nested_options):
        """Expand a state through all of item's nested child slots, returning all variants."""
        child_slots = nested_slots_by_item.get(item.id, [])
        if not child_slots:
            return [base_state]
        states = [base_state]
        for child_slot in child_slots:
            raw_items = nested_options.get(child_slot.id, [])
            if not raw_items:
                continue
            next_states = []
            for st in states:
                valid = _validated_children(child_slot.id, st["installed_ids"], raw_items)
                next_states.append(st)  # skip is always valid
                for ci, ci_conflict in valid:
                    new_st = {
                        "child_items": st["child_items"] + [ci],
                        "child_slot_ids": st["child_slot_ids"] + [child_slot.id],
                        "child_slot_parent_item_ids": st["child_slot_parent_item_ids"] + [item.id],
                        "installed_ids": st["installed_ids"] + [ci.id],
                        "conflict": st["conflict"] or ci_conflict,
                    }
                    next_states.extend(_expand_item(new_st, ci, nested_options))
            states = next_states
        return states

    # 10. Frontier expansion + stats (pure Python, no further DB queries)
    _combo_metrics = {
        "root_candidate_count": len(all_parents),
        "child_candidate_edge_count": sum(len(items) for items in child_items_by_slot.values()),
        "nested_candidate_edge_count": sum(len(items) for items in nested_items_by_slot.values()),
        "reachable_item_count": len(
            set(all_parent_ids)
            | {item.id for items in child_items_by_slot.values() for item in items}
            | {item.id for items in nested_items_by_slot.values() for item in items}
        ),
        "frontier_peak": 0,
        "frontier_states_generated": 0,
        "frontier_cap_hits": 0,
        "nested_expansion_skips": 0,
    }

    def _stream():
        all_combos = []
        any_truncated = False
        truncation_reasons = set()

        for parent in all_parents:
            child_slots = child_slots_by_parent.get(parent.id, [])
            parent_child_slot_ids = [cs.id for cs in child_slots]
            child_options, nested_options = _pruned_options(parent, parent_child_slot_ids)
            _valid_cache.clear()  # candidate views are scoped to this root parent
            parent_name = parent.name or parent.id
            parent_conflict = parent_external_conflict.get(parent.id)

            if not child_slots:
                combo_ids = installed_ids + [parent.id]
                stats = _compute_stats(stats_base_item, combo_ids, stats_items_map, strength_level, equip_ergo_modifier)
                all_combos.append(
                    {
                        "parent_item": _ser(parent),
                        "child_items": [],
                        "child_slot_ids": [],
                        "child_slot_parent_item_ids": [],
                        "all_child_slot_ids": [],
                        "all_nested_slot_ids": [],
                        "conflict": _ser_conflict(parent_conflict),
                        **stats,
                    }
                )
                continue

            # frontier: list of dicts { child_items, child_slot_ids, child_slot_parent_item_ids, installed_ids, conflict }
            frontier = [
                {
                    "child_items": [],
                    "child_slot_ids": [],
                    "child_slot_parent_item_ids": [],
                    "installed_ids": installed_ids + [parent.id],
                    "conflict": parent_conflict,
                }
            ]

            for cs in child_slots:
                raw_candidates = child_options.get(cs.id, [])
                if not raw_candidates:
                    continue

                next_frontier = []
                seen: dict = {}
                for state in frontier:
                    inst_list = state["installed_ids"]
                    key = tuple(sorted(inst_list))
                    if key not in seen:
                        seen[key] = _validated_children(cs.id, inst_list, raw_candidates)
                    valid_children_with_conflicts = seen[key]

                    next_frontier.append(state)  # "skip this child slot" is always valid
                    for ci, ext_conflict in valid_children_with_conflicts:
                        new_state = {
                            "child_items": state["child_items"] + [ci],
                            "child_slot_ids": state["child_slot_ids"] + [cs.id],
                            "child_slot_parent_item_ids": state["child_slot_parent_item_ids"] + [parent.id],
                            "installed_ids": state["installed_ids"] + [ci.id],
                            "conflict": state["conflict"] or ext_conflict,
                        }
                        if ci.id in nested_slots_by_item:
                            _est = len(frontier)
                            for _ns in nested_slots_by_item[ci.id]:
                                _est *= 1 + len(nested_options.get(_ns.id, []))
                            if _est > _COMBO_NESTED_EXPANSION_LIMIT:
                                next_frontier.append(new_state)
                                any_truncated = True
                                truncation_reasons.add("nested_expansion_limit")
                                _combo_metrics["nested_expansion_skips"] += 1
                            else:
                                next_frontier.extend(_expand_item(new_state, ci, nested_options))
                        else:
                            next_frontier.append(new_state)

                _combo_metrics["frontier_states_generated"] += len(next_frontier)
                _combo_metrics["frontier_peak"] = max(_combo_metrics["frontier_peak"], len(next_frontier))
                frontier = next_frontier
                capped = False
                if len(frontier) > _COMBO_FRONTIER_CAP:
                    frontier = frontier[:_COMBO_FRONTIER_CAP]
                    capped = True
                    any_truncated = True
                    truncation_reasons.add("frontier_cap")
                    _combo_metrics["frontier_cap_hits"] += 1
                yield f"data: {json.dumps({'type': 'progress', 'parent': parent_name, 'slot': cs.slot_name, 'frontier': len(frontier), 'cap': _COMBO_FRONTIER_CAP, 'capped': capped})}\n\n"

            for state in frontier:
                combo_ids = installed_ids + [parent.id] + [ci.id for ci in state["child_items"]]
                stats = _compute_stats(stats_base_item, combo_ids, stats_items_map, strength_level, equip_ergo_modifier)
                _nested_sid_set = set(parent_child_slot_ids)
                for _ci in state["child_items"]:
                    for _s in nested_slots_by_item.get(_ci.id, []):
                        _nested_sid_set.add(_s.id)
                all_combos.append(
                    {
                        "parent_item": _ser(parent),
                        "child_items": [_ser(ci) for ci in state["child_items"]],
                        "child_slot_ids": state["child_slot_ids"],
                        "child_slot_parent_item_ids": state["child_slot_parent_item_ids"],
                        "all_child_slot_ids": parent_child_slot_ids,
                        "all_nested_slot_ids": list(_nested_sid_set),
                        "conflict": _ser_conflict(state["conflict"]),
                        **stats,
                    }
                )

        clean = _dedup_by_stats([c for c in all_combos if not c.get("conflict")])
        conflicted = _dedup_by_stats([c for c in all_combos if c.get("conflict")])
        result = {
            "base": base_stats,
            "combos": clean + conflicted,
            "timed_out": False,
            "truncated": any_truncated,
            "truncation_reasons": sorted(truncation_reasons),
            "metrics": {
                **_combo_metrics,
                **_pruning_metrics,
                "pruning_ms": round(_pruning_metrics["pruning_ms"], 3),
                "combo_count_before_dedup": len(all_combos),
                "combo_count": len(clean) + len(conflicted),
                "cache_hit": False,
                "processing_ms": round((time.perf_counter() - _combo_started) * 1000, 3),
            },
        }

        with COMBO_FULL_CACHE_LOCK:
            if len(COMBO_FULL_CACHE) >= _COMBO_FULL_CACHE_MAX:
                keys = list(COMBO_FULL_CACHE.keys())
                for k in keys[: len(keys) // 2]:
                    del COMBO_FULL_CACHE[k]
            COMBO_FULL_CACHE[_cache_key] = result

        yield combo_result_event(result, response_format)

    return StreamingResponse(
        _stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )
