"""Read generated handguard mount directions without requiring Kitbash at runtime."""

from collections.abc import Iterable
from functools import lru_cache
import json
import math
from pathlib import Path

from slot_semantics import slot_role

MPR45_ID = "5649a2464bdc2d91118b45a8"
MOUNT_DIRECTIONS = frozenset({"left", "right", "top", "bottom", "offset_left"})
_UNKNOWN = ("unknown", "unknown")
_DATA_PATH = Path(__file__).resolve().parent / "data" / "slot_mounts.json"


def _unit_quaternion(value):
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    if any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in value):
        return None
    norm = math.sqrt(sum(v * v for v in value))
    return tuple(v / norm for v in value) if norm > 1e-9 else None


def _multiply(a, b):
    x, y, z, w = a
    bx, by, bz, bw = b
    return (
        w * bx + x * bw + y * bz - z * by,
        w * by - x * bz + y * bw + z * bx,
        w * bz + x * by - y * bx + z * bw,
        w * bw - x * bx - y * by - z * bz,
    )


def classify_bone_mount(bone: dict | None, owner_orientations: Iterable) -> str:
    """Classify the measured outward normal after composing the owner's baked rotations."""
    local = _unit_quaternion(bone.get("rot")) if isinstance(bone, dict) else None
    if local is None:
        return "unknown"
    directions = set()
    for raw_orientation in owner_orientations:
        orientation = _unit_quaternion(raw_orientation)
        if orientation is None:
            return "unknown"
        x, y, z, w = _multiply(orientation, local)
        # Rotate the bone's +Z axis into the weapon frame. Follow its facing,
        # not its position: model pivots and diagonal rails can sit off centre.
        nx, ny, nz = 2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)
        if abs(nz) > 0.35:
            return "unknown"
        if abs(nx) >= 0.35:
            # Calibrate the UI sides against the existing HK Quad Rail layout.
            directions.add("left" if nx > 0 else "right")
        elif abs(ny) >= 0.85:
            directions.add("top" if ny > 0 else "bottom")
        else:
            return "unknown"
    return next(iter(directions)) if len(directions) == 1 else "unknown"


@lru_cache(maxsize=1)
def _load_metadata() -> dict:
    try:
        data = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) and data.get("version") == 1 else {}


def slot_mount_hint(parent_item_id: str, slot_game_name: str | None) -> tuple[str, str]:
    """Use exact template and raw-slot keys so new or stale keys fall back safely."""
    data = _load_metadata()
    items, profiles = data.get("items", {}), data.get("profiles", [])
    if not isinstance(items, dict) or not isinstance(profiles, list):
        return _UNKNOWN
    index = items.get(parent_item_id)
    if not isinstance(index, int) or not 0 <= index < len(profiles) or not isinstance(profiles[index], dict):
        return _UNKNOWN
    direction = profiles[index].get(slot_game_name)
    if not isinstance(direction, str) or direction not in MOUNT_DIRECTIONS:
        return _UNKNOWN
    return direction, "compatibility" if direction == "offset_left" else "geometry"


def slot_mount_fields(parent_item_id: str, slot_game_name: str | None, allowed_item_ids: Iterable[str] = ()) -> dict:
    """Recheck compatibility-derived hints against the current catalogue before exposing them."""
    direction, source = slot_mount_hint(parent_item_id, slot_game_name)
    if slot_role(slot_game_name) in {"mount", "tactical", "scope"} and set(allowed_item_ids) == {MPR45_ID}:
        direction, source = "offset_left", "compatibility"
    elif source == "compatibility":
        direction, source = _UNKNOWN
    return {"slot_mount": direction, "slot_mount_source": source}
