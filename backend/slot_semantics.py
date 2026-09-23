"""Classify attachment slots from stable game names and category IDs."""

import re
from collections.abc import Iterable

# Preserve the game's separate pistol_grip and pistolgrip slot families.
_GAME_NAME_ROLES = {
    "mod_reciever": "receiver",
    "mod_receiver": "receiver",
    "mod_handguard": "handguard",
    "mod_catch": "catch",
    "mod_barrel": "barrel",
    "mod_gas_block": "gas_block",
    "mod_muzzle": "muzzle",
    "mod_stock": "stock",
    "mod_stock_akms": "stock",
    "mod_stock_axis": "stock",
    "mod_scope": "scope",
    "mod_sight_rear": "rear_sight",
    "mod_sight_front": "front_sight",
    "mod_magazine": "magazine",
    "mod_pistol_grip": "pistol_grip",
    "mod_pistol_grip_akms": "pistol_grip",
    "mod_pistolgrip": "grip",
    "mod_foregrip": "foregrip",
    "mod_bipod": "bipod",
    "mod_charge": "charge",
    "mod_tactical": "tactical",
    "mod_flashlight": "tactical",
    "mod_mount": "mount",
    "mod_launcher": "launcher",
    "mod_nvg": "shroud",
    "mod_trigger": "trigger",
    "camora": "chamber",
    "mod_hammer": "hammer",
}

# Use taxonomy IDs, not the localized Handbook labels stored beside them.
# Leave ironsights unresolved because their category does not distinguish front/rear.
_CATEGORY_ROLES = {
    "555ef6e44bdc2de9068b457e": "barrel",
    "55818afb4bdc2dde698b456d": "bipod",
    "55818a6f4bdc2db9688b456b": "charge",
    "5448fe394bdc2d0d028b456c": "muzzle",
    "55818b164bdc2ddc698b456c": "tactical",
    "55818b084bdc2d5b648b4571": "tactical",
    "55818af64bdc2d5b648b4570": "foregrip",
    "56ea9461d2720b67698b456f": "gas_block",
    "55818a104bdc2db9688b4569": "handguard",
    "5448bc234bdc2d3c308b4569": "magazine",
    "55818b224bdc2dde698b456f": "mount",
    "55818a684bdc2ddd698b456d": "pistol_grip",
    "55818a304bdc2db5418b457d": "receiver",
    "55818add4bdc2d5b648b456f": "scope",
    "55818acf4bdc2dde698b456b": "scope",
    "55818ad54bdc2ddc698b4569": "scope",
    "55818ae44bdc2dde698b456c": "scope",
    "55818aeb4bdc2ddc698b456a": "scope",
    "55818a594bdc2db9688b456a": "stock",
    "55818b014bdc2ddc698b456b": "launcher",
}

SLOT_ROLES = frozenset(_GAME_NAME_ROLES.values()) | {"unknown"}


def category_role(category_ids: str | None) -> str:
    """Resolve a single item's semantic role without consulting its display name."""
    roles = {_CATEGORY_ROLES[cid.strip()] for cid in (category_ids or "").split(",") if cid.strip() in _CATEGORY_ROLES}
    return next(iter(roles)) if len(roles) == 1 else "unknown"


def slot_role(slot_game_name: str | None, allowed_category_ids: Iterable[str | None] = ()) -> str:
    """Prefer the raw game slot role; narrow generic mounts only on unanimous evidence."""
    name = re.sub(r"_?\d+$", "", (slot_game_name or "").strip().lower())
    role = _GAME_NAME_ROLES.get(name, "unknown")
    if role != "mount":
        return role
    candidate_roles = {category_role(ids) for ids in allowed_category_ids}
    if len(candidate_roles) == 1 and "unknown" not in candidate_roles:
        return next(iter(candidate_roles))
    return "mount"
