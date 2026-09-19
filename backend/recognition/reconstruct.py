"""Search bounded, instance-aware slot trees from recognized card candidates."""

import json
import math
import time
from collections import Counter, deque
from dataclasses import dataclass
from types import SimpleNamespace

from .panel import compare_stats


@dataclass(frozen=True)
class SearchLimits:
    beam_width: int = 48
    max_results: int = 5
    max_inferred: int = 3
    max_adapter_depth: int = 2
    max_placements: int = 32
    max_expansions: int = 100000
    seconds: float = 10.0

    def __post_init__(self):
        if (
            not math.isfinite(self.seconds)
            or min(self.beam_width, self.max_results, self.max_placements, self.max_expansions, self.seconds) <= 0
        ):
            raise ValueError("Search budgets must be positive")
        if min(self.max_inferred, self.max_adapter_depth) < 0:
            raise ValueError("Inference limits cannot be negative")


def _ids(item, field):
    return set(filter(None, (item.get(field) or "").split(",")))


def _conflicts(catalog, nodes):
    # Check both directions independently of insertion order. Honor blocked occupied
    # slots and slot-owner conflicts, as the workbench's compatibility checks do.
    for index, node in enumerate(nodes):
        item = catalog.items[node["item_id"]]
        blocked_items = _ids(item, "conflicting_item_ids")
        blocked_slots = _ids(item, "conflicting_slot_ids")
        for other_index, other in enumerate(nodes):
            if index == other_index:
                continue
            if other["item_id"] in blocked_items:
                return True
            if other.get("slot_id") in blocked_slots:
                return True
            if any(slot["id"] in blocked_slots for slot in catalog.slots_by_parent[other["item_id"]]):
                return True
    return False


def validate_tree(catalog, weapon_id, nodes):
    """Validate a parent-before-child instance tree, including missing required slots."""
    errors, missing = [], []
    root = {"instance_id": "root", "item_id": weapon_id, "parent_instance_id": None}
    if not nodes or any(nodes[0].get(key) != value for key, value in root.items()):
        return {"valid": False, "errors": ["invalid_root"], "missing_required_slots": []}
    if weapon_id not in catalog.items or not catalog.items[weapon_id]["is_weapon"]:
        return {"valid": False, "errors": ["invalid_weapon"], "missing_required_slots": []}
    seen, occupied, cards = {"root": nodes[0]}, set(), set()
    for node in nodes[1:]:
        parent = seen.get(node.get("parent_instance_id"))
        slot = catalog.slots.get(node.get("slot_id"))
        key = (node.get("parent_instance_id"), node.get("slot_id"))
        if node["instance_id"] in seen:
            errors.append("duplicate_instance")
        if not parent or not slot or slot["parent_item_id"] != parent["item_id"]:
            errors.append("invalid_parent_slot")
        elif node["item_id"] not in catalog.allowed[slot["id"]]:
            errors.append("incompatible_item")
        if node["item_id"] not in catalog.items:
            errors.append("unknown_item")
        if key in occupied:
            errors.append("occupied_slot")
        card = node.get("card_index")
        if card is not None:
            if card in cards:
                errors.append("reused_card")
            cards.add(card)
        occupied.add(key)
        seen[node["instance_id"]] = node
    if not errors:
        if _conflicts(catalog, nodes):
            errors.append("conflicting_parts")
        for node in nodes:
            for slot in catalog.slots_by_parent[node["item_id"]]:
                if slot.get("required") and (node["instance_id"], slot["id"]) not in occupied:
                    missing.append({"parent_instance_id": node["instance_id"], "slot_id": slot["id"]})
    return {"valid": not errors, "errors": sorted(set(errors)), "missing_required_slots": missing}


def import_payload(catalog, weapon_id, nodes):
    # The existing v1 importer addresses template slots, not parent instances.
    # Withhold ambiguous trees rather than silently attaching to the wrong copy.
    if not validate_tree(catalog, weapon_id, nodes)["valid"]:
        return None
    owners = Counter(slot["id"] for node in nodes for slot in catalog.slots_by_parent[node["item_id"]])
    if any(owners[node["slot_id"]] != 1 for node in nodes[1:]):
        return None
    return {"v": 1, "g": weapon_id, "p": [[node["slot_id"], node["item_id"]] for node in nodes[1:]]}


def encode_payload(payload):
    from lzstring import LZString

    # Keep the wire JSON ASCII so Python code points and JavaScript UTF-16 agree.
    return LZString.compressToEncodedURIComponent(json.dumps(payload, separators=(",", ":"), ensure_ascii=True))


def _depths(catalog, weapon_id):
    depths = {weapon_id: 0}
    queue = deque([weapon_id])
    while queue:
        parent = queue.popleft()
        for edge in catalog.by_parent[parent]:
            child = edge["allowed_item_id"]
            if child not in depths:
                depths[child] = depths[parent] + 1
                queue.append(child)
    return depths


def _paths(catalog, nodes, target, depth, deadline, preferred):
    # Walk backward from an observed item to an installed parent. Never infer a
    # recursive copy of an ancestor template just to consume another observation.
    occupied = {(node.get("parent_instance_id"), node.get("slot_id")) for node in nodes[1:]}

    def walk(item_id, remaining, visited):
        edges = sorted(
            catalog.by_item[item_id], key=lambda edge: (-preferred.get(edge["parent_item_id"], 0), edge["slot_id"])
        )
        for edge in edges:
            if time.monotonic() >= deadline:
                return
            parent_id = edge["parent_item_id"]
            if parent_id in visited:
                continue
            step = (edge["slot_id"], item_id)
            for node in nodes:
                if node["item_id"] == parent_id and (node["instance_id"], edge["slot_id"]) not in occupied:
                    yield node["instance_id"], [step]
            if remaining and parent_id in catalog.items and not catalog.items[parent_id]["is_weapon"]:
                for instance, path in walk(parent_id, remaining - 1, visited | {parent_id}):
                    yield instance, path + [step]

    yield from walk(target, depth, {target})


def _attach(catalog, nodes, parent, path, card_index, candidate):
    result = list(nodes)
    occupied = {(node.get("parent_instance_id"), node.get("slot_id")) for node in nodes[1:]}
    by_id = {node["instance_id"]: node for node in nodes}
    ancestors = set()
    current = by_id[parent]
    while current:
        ancestors.add(current["item_id"])
        current = by_id.get(current.get("parent_instance_id"))
    for index, (slot, item) in enumerate(path):
        if (parent, slot) in occupied or item in ancestors:
            return None
        instance = f"{parent}/{slot}"
        observed = index == len(path) - 1
        node = {
            "instance_id": instance,
            "parent_instance_id": parent,
            "slot_id": slot,
            "item_id": item,
            "card_index": card_index if observed else None,
            "evidence": "observed" if observed else "inferred_adapter",
        }
        if observed:
            node["text_similarity"] = candidate["text_similarity"]
            node["icon_penalty"] = candidate.get("icon_penalty", 0)
        result.append(node)
        ancestors.add(item)
        parent = instance
    return None if _conflicts(catalog, result) else result


def _state_key(state):
    nodes, loss = state
    matched = sum(node.get("card_index") is not None for node in nodes)
    inferred = sum(node.get("evidence") == "inferred_adapter" for node in nodes)
    icon_penalty = sum(node.get("icon_penalty", 0) for node in nodes)
    return -matched, loss + icon_penalty + 0.2 * inferred, inferred


def _signature(nodes):
    # Collapse interchangeable assignments of identical cards while retaining
    # distinct placements and the difference between observed and inferred parts.
    return tuple(sorted((n["instance_id"], n["item_id"], n.get("evidence", "root")) for n in nodes))


def reconstruct(catalog, report, limits=None):
    from stats import _compute_stats

    limits = limits or SearchLimits()
    weapon_id = report.get("weapon_id")
    result = {"status": "weapon_unresolved", "requires_review": True, "candidates": []}
    if not weapon_id:
        return result
    started = time.monotonic()
    deadline = started + limits.seconds
    depths = _depths(catalog, weapon_id)
    cards = [card for card in report["cards"] if card["status"] != "empty"]
    preferred = {}
    for card in cards:
        for candidate in card["candidates"]:
            preferred[candidate["item_id"]] = max(preferred.get(candidate["item_id"], 0), candidate["text_similarity"])
    # Install likely parents first. Retain lower-ranked item alternatives inside
    # each beam step; a later card can claim a previously inferred adapter.
    cards.sort(
        key=lambda c: (depths.get(c["candidates"][0]["item_id"], 999) if c["candidates"] else 999, c["card_index"])
    )
    root = {"instance_id": "root", "item_id": weapon_id, "parent_instance_id": None}
    beam = [([root], 0.0)]
    expansions = 0
    truncations = set()
    for card in cards:
        next_states = list(beam)  # Keep an unresolved branch instead of forcing a bad match.
        for nodes, loss in beam:
            for candidate in card["candidates"]:
                if expansions >= limits.max_expansions or time.monotonic() >= deadline:
                    truncations.add("budget")
                    break
                item_id = candidate["item_id"]
                if item_id not in depths or item_id == weapon_id:
                    continue
                if candidate["text_similarity"] < card["candidates"][0]["text_similarity"] - 0.12:
                    continue
                penalty = 1 - candidate["text_similarity"] + (0 if candidate.get("literal_exact") else 0.02)
                for index, node in enumerate(nodes):
                    if node["item_id"] == item_id and node.get("evidence") == "inferred_adapter":
                        adopted = list(nodes)
                        adopted[index] = {
                            **node,
                            "card_index": card["card_index"],
                            "evidence": "observed",
                            "text_similarity": candidate["text_similarity"],
                            "icon_penalty": candidate.get("icon_penalty", 0),
                        }
                        next_states.append((adopted, loss + penalty))
                inferred = sum(n.get("evidence") == "inferred_adapter" for n in nodes)
                remaining = min(limits.max_adapter_depth, limits.max_inferred - inferred)
                placements = 0
                # Enumerate shorter chains before longer ones, deduplicating paths.
                seen_paths = set()
                for depth in range(remaining + 1):
                    for parent, path in _paths(catalog, nodes, item_id, depth, deadline, preferred):
                        signature = (parent, tuple(path))
                        if signature in seen_paths:
                            continue
                        seen_paths.add(signature)
                        expansions += 1
                        attached = _attach(catalog, nodes, parent, path, card["card_index"], candidate)
                        if attached:
                            next_states.append((attached, loss + penalty))
                            placements += 1
                        if placements >= limits.max_placements or expansions >= limits.max_expansions:
                            truncations.add("placements" if placements >= limits.max_placements else "budget")
                            break
                    if placements >= limits.max_placements or expansions >= limits.max_expansions:
                        break
                    if placements:
                        break
            if "budget" in truncations:
                break
        unique = {}
        for state in sorted(next_states, key=_state_key):
            unique.setdefault(_signature(state[0]), state)
        if len(unique) > limits.beam_width:
            truncations.add("beam")
        beam = list(unique.values())[: limits.beam_width]
        if "budget" in truncations or time.monotonic() >= deadline:
            truncations.add("budget")
            break
    items = {key: SimpleNamespace(**value) for key, value in catalog.items.items()}
    candidates = []
    for nodes, loss in beam:
        validation = validate_tree(catalog, weapon_id, nodes)
        if not validation["valid"]:
            continue
        attachments = [node["item_id"] for node in nodes[1:]]
        calculated = _compute_stats(items[weapon_id], attachments, items)
        comparison = compare_stats(report.get("stats_panel", {}), calculated)
        errors = [
            abs(row["difference"]) / (2 * row["tolerance"])
            for row in comparison["fields"].values()
            if "difference" in row
        ]
        matched = {node["card_index"] for node in nodes if node.get("card_index") is not None}
        unresolved = [card["card_index"] for card in cards if card["card_index"] not in matched]
        inferred = [node["instance_id"] for node in nodes if node.get("evidence") == "inferred_adapter"]
        payload = import_payload(catalog, weapon_id, nodes)
        nodes = [
            {
                **node,
                "name": catalog.items[node["item_id"]]["name"],
                "short_name": catalog.items[node["item_id"]]["short_name"],
            }
            for node in nodes
        ]
        candidates.append(
            {
                "nodes": nodes,
                "attachment_ids": attachments,
                "validation": validation,
                "unresolved_card_indices": unresolved,
                "inferred_instances": inferred,
                "review_region_count": len(report.get("review_regions", [])),
                "calculated_stats": calculated,
                "stat_comparison": comparison,
                "display_unit_error": round(sum(errors), 4) if errors else None,
                "text_penalty": round(loss, 4),
                "icon_penalty": round(sum(node.get("icon_penalty", 0) for node in nodes), 4),
                "payload": payload,
                "export_status": "ready_for_review" if payload else "ambiguous_parent_instances",
                "completeness": (
                    "partial"
                    if unresolved or validation["missing_required_slots"] or inferred or report.get("review_regions")
                    else "observations_accounted_for"
                ),
            }
        )
    # Prefer coverage and required-slot completeness. Use stats only to rank
    # alternatives with comparable evidence; never reject a tree on stats alone.
    candidates.sort(
        key=lambda c: (
            len(c["unresolved_card_indices"]),
            len(c["validation"]["missing_required_slots"]),
            len(c["inferred_instances"]),
            c["display_unit_error"] or 0,
            c["icon_penalty"],
            c["text_penalty"],
        )
    )
    # Offer different item combinations before alternate placements of the same
    # combination. Keep the other placements in the result when room remains.
    distinct, placements, combinations = [], [], set()
    for candidate in candidates:
        combination = tuple(sorted(candidate["attachment_ids"]))
        if combination in combinations:
            placements.append(candidate)
        else:
            combinations.add(combination)
            distinct.append(candidate)
    candidates = distinct + placements
    result.update(
        status="review_required",
        candidates=candidates[: limits.max_results],
        search={
            "expansions": expansions,
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "truncated_by": sorted(truncations),
            "limits": vars(limits),
        },
        note="Bounded hypotheses, not a proven optimum or exact identification. Review every import.",
    )
    return result
