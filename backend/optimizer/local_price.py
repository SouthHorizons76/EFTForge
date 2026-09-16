"""Try a bounded set of cheaper nearby builds without another MILP solve."""

import time

import numpy as np

LOCAL_PRICE_SECONDS = 0.02
MAX_ROUNDS = 3
MAX_CHECKS = 48
MAX_MOVES_PER_RANK = 128


def improve_price(
    result,
    weapon,
    mods,
    compat_map,
    item_to_valid_slots,
    item_ids,
    idx,
    prices,
    cb,
    solve_stats,
    deadline,
    *,
    cache=None
):
    started = time.perf_counter()
    stop = min(deadline, started + LOCAL_PRICE_SECONDS)
    if result["status"] not in ("optimal", "feasible") or started >= stop:
        return result
    n = len(item_ids)
    selected = list(result["selected_items"])
    original = selected[:]
    factory = set((weapon.factory_attachment_ids or "").split(","))
    cache = {} if cache is None else cache
    input_key = (id(compat_map), id(mods), id(prices), tuple(item_ids))
    if cache.get("input_key") != input_key:
        # Share immutable inputs across samples, never across different markets
        # or candidate orderings. Keep changing model rows out of this cache.
        cache.clear()
        required = {}
        for slot, info in compat_map.slots_by_id.items():
            if info.required:
                required.setdefault(compat_map.slot_owner[slot], []).append(set(compat_map.slot_items[slot]))
        cache.update(
            input_key=input_key,
            price=np.array([prices[i]["price_rub"] for i in item_ids] + [0.0]),
            ergo=np.array([mods[i].ergonomics_modifier or 0 for i in item_ids] + [0.0]),
            recoil=np.array([mods[i].recoil_modifier or 0 for i in item_ids] + [0.0]),
            owners={i: {owner for _, owner in slots} for i, slots in item_to_valid_slots.items()},
            required=required,
            neighbors={},
        )
    price, ergo, recoil = cache["price"], cache["ergo"], cache["recoil"]
    base_ergo = weapon.base_ergonomics or 0
    original_indices = [idx[i] for i in original]
    ergo_floor = float(ergo[original_indices].sum())
    recoil_ceiling = float(recoil[original_indices].sum())
    original_stats = solve_stats.compute(original)
    if original_stats.get("recoil_vertical") is None:
        return result
    constraints = cb.build()
    owners, required = cache["owners"], cache["required"]
    checks = 0

    if len(selected) >= 63:
        return result
    selected_set = set(selected)
    children = {}
    for child in selected:
        for owner in owners[child]:
            children.setdefault(owner, set()).add(child)
    bits = {i: 1 << j for j, i in enumerate(selected)}
    blocked = [0] * (n + 1)
    for coeffs, _lower, upper in cb.rows:
        if upper != 1 or any(value != 1 for value in coeffs.values()):
            continue
        taken = 0
        for column in coeffs:
            if column < n:
                taken |= bits.get(item_ids[column], 0)
        if taken:
            for column in coeffs:
                blocked[column] |= taken
    moves = []
    for old in sorted(selected, key=lambda i: (-prices[i]["price_rub"], i)):
        if time.perf_counter() >= stop:
            break
        if old in factory:
            continue
        if old not in cache["neighbors"]:
            neighbors = set()
            for slot, _owner in item_to_valid_slots.get(old, []):
                neighbors.update(compat_map.slot_items[slot])
            neighbors.intersection_update(idx)
            cheap = sorted(neighbors, key=lambda i: (price[idx[i]], i))
            cache["neighbors"][old] = (
                cheap,
                sorted(cheap, key=lambda i: -ergo[idx[i]]),
                sorted(cheap, key=lambda i: recoil[idx[i]]),
            )
        # Bound the neighborhood, retaining cheap parts and stat donors.
        candidates = set()
        for ordered, count in zip(cache["neighbors"][old], (24, 6, 6)):
            candidates.update([i for i in ordered if i not in selected_set and i not in factory][:count])
        for new in sorted(candidates) + [None]:
            if time.perf_counter() >= stop:
                break
            j = idx[new] if new is not None else n
            forbidden = bits[old] | blocked[j]
            # Remove conflicting parts and children that lose their last parent.
            reached = {weapon.id}
            pending = [weapon.id]
            while pending:
                owner = pending.pop()
                next_items = {i for i in children.get(owner, ()) if not (bits[i] & forbidden)}
                if new is not None and owner in owners[new]:
                    next_items = next_items | {new}
                fresh = next_items - reached
                reached.update(fresh)
                pending.extend(fresh)
            reached.discard(weapon.id)
            if new is not None and new not in reached:
                continue
            removed = selected_set - reached
            # Preserve free factory parts, so the attachment saving also
            # reduces both base/preset purchase totals by the same amount.
            if removed & factory:
                continue
            if any(not (allowed & reached) for owner in reached | {weapon.id} for allowed in required.get(owner, ())):
                continue
            gone = [idx[i] for i in removed]
            moves.append(
                (
                    sum(bits[i] for i in removed),
                    j,
                    price[j] - float(price[gone].sum()),
                    ergo[j] - float(ergo[gone].sum()),
                    recoil[j] - float(recoil[gone].sum()),
                )
            )
    if not moves or time.perf_counter() >= stop:
        return {
            **result,
            "metrics": {
                **result.get("metrics", {}),
                "local_price_ms": round((time.perf_counter() - started) * 1000, 3),
                "local_price_checks": 0,
                "local_price_saved_rub": 0,
            },
        }
    if len(moves) > 3 * MAX_MOVES_PER_RANK:
        keep = set()
        for key in (lambda i: moves[i][2], lambda i: (-moves[i][3], moves[i][2]), lambda i: (moves[i][4], moves[i][2])):
            keep.update(sorted(range(len(moves)), key=key)[:MAX_MOVES_PER_RANK])
        moves = [moves[i] for i in sorted(keep)]
    moves.append((0, n, 0.0, 0.0, 0.0))
    masks = np.array([m[0] for m in moves], dtype=np.uint64)
    new = np.array([m[1] for m in moves])
    cost_delta, ergo_delta, recoil_delta = np.array([m[2:] for m in moves]).T
    for _ in range(MAX_ROUNDS):
        if time.perf_counter() >= stop:
            break
        current_set = set(selected)
        current_indices = [idx[i] for i in selected]
        current_ergo = float(ergo[current_indices].sum())
        current_recoil = float(recoil[current_indices].sum())
        remaining = sum(bits.get(i, 0) for i in selected)
        valid = (masks & remaining) == masks
        valid &= np.array([j == n or item_ids[j] not in current_set for j in new])
        savings = -(cost_delta[:, None] + cost_delta)
        eligible = (
            valid[:, None]
            & valid
            & (savings > 0)
            & (current_ergo + ergo_delta[:, None] + ergo_delta >= ergo_floor - 1e-9)
            & (current_recoil + recoil_delta[:, None] + recoil_delta <= recoil_ceiling + 1e-9)
            & ((masks[:, None] & masks) == 0)
            & ((new[:, None] != new) | (new == n))
        )
        eligible &= np.triu(np.ones(eligible.shape, dtype=bool), 1)
        candidates = np.flatnonzero(eligible)
        if not len(candidates):
            break
        # Limit feasibility/stat checks; never search to exhaustion.
        ranked = candidates[np.argsort(-savings.ravel()[candidates], kind="stable")[:MAX_CHECKS]]
        accepted = False
        for flat in ranked:
            if time.perf_counter() >= stop:
                break
            a, b = divmod(int(flat), len(moves))
            removed_mask = int(masks[a] | masks[b])
            candidate_set = {i for i in selected if not (bits.get(i, 0) & removed_mask)}
            candidate_set.update(item_ids[j] for j in (new[a], new[b]) if j < n)
            candidate = [i for i in item_ids if i in candidate_set]
            assignment = np.zeros(n + 1)
            candidate_indices = [idx[i] for i in candidate]
            assignment[candidate_indices] = 1
            assignment[n] = min(100, base_ergo + float(ergo[candidate_indices].sum()))
            checks += 1
            lhs = constraints.A @ assignment
            if assignment[n] < 0 or np.any(lhs < constraints.lb - 1e-7) or np.any(lhs > constraints.ub + 1e-7):
                continue
            stats = solve_stats.compute(candidate)
            if (
                stats["total_ergo"] < original_stats["total_ergo"]
                or stats["recoil_vertical"] > original_stats["recoil_vertical"]
            ):
                continue
            selected = candidate
            accepted = True
            break
        if not accepted:
            break

    return {
        **result,
        "selected_items": selected,
        "total_price_rub": sum(prices[i]["price_rub"] for i in selected),
        "metrics": {
            **result.get("metrics", {}),
            "local_price_ms": round((time.perf_counter() - started) * 1000, 3),
            "local_price_checks": checks,
            "local_price_before_ergo": base_ergo + sum(mods[i].ergonomics_modifier or 0 for i in original),
            "local_price_before_recoil_modifier": recoil_ceiling,
            "local_price_before_display_ergo": original_stats["total_ergo"],
            "local_price_before_display_recoil_v": original_stats["recoil_vertical"],
            "local_price_saved_rub": sum(prices[i]["price_rub"] for i in original)
            - sum(prices[i]["price_rub"] for i in selected),
        },
    }
