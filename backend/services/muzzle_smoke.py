"""Per item muzzle smoke for the attachment table, from the 3D viewer's smoke simulation.

data/muzzle_smoke.json is generated offline from Kitbash!'s muzzle smoke data (each device
on its own, a 10 shot string at 600 RPM): {item id: [smoke per shot in cm²·s, % of the
view within 5° of the aim hidden at worst, depth of its emitters in its model]}. Items with
no smoke of their own are left out.
"""

import json
import os
from functools import lru_cache

_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "muzzle_smoke.json")


@lru_cache(maxsize=1)
def _table():
    try:
        with open(_PATH, encoding="utf-8") as f:
            return json.load(f).get("items", {})
    except (OSError, ValueError):
        return {}


def smoke_fields(item_id):
    # Merged into an item's serialized record; nulls for an item with no smoke of its own.
    # smoke_depth is how deep its emitters sit in its model: of parts mounted side by side
    # the game keeps the deeper ones' smoke, which the combo view needs to pick the right part.
    v = _table().get(item_id)
    return {
        "smoke_per_shot": v[0] if v else None,
        "smoke_aim": v[1] if v else None,
        "smoke_depth": v[2] if v and len(v) > 2 else None,
    }
