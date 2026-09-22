"""Exercise build image cache keys without Kitbash! or the game database."""

import os
from copy import deepcopy

import pytest

os.environ.setdefault("IP_HASH_SECRET", "build-images-test-secret")
os.environ.setdefault("ADMIN_API_KEY", "build-images-test-admin")

from build_images import build_image_key, loaded_image_key

GUN = "1" * 24


def build(variant=2):
    return [
        {"_id": "a" * 24, "_tpl": GUN, "slotId": "hideout", "parentId": "hideout"},
        {"_id": "b" * 24, "_tpl": f"{variant:024x}", "slotId": "mod_stock", "parentId": "a" * 24},
    ]


def test_cache_identity_preserves_hierarchy_but_ignores_instance_names_and_order():
    items = build()
    items += [
        {"_id": "c" * 24, "_tpl": "3" * 24, "slotId": "mod_scope", "parentId": "a" * 24},
        {"_id": "d" * 24, "_tpl": "4" * 24, "slotId": "mod_mount", "parentId": "b" * 24},
    ]
    key = build_image_key(GUN, items)
    renamed = deepcopy(items)
    renamed[0]["_id"] = "e" * 24
    for item in renamed[1:]:
        if item["parentId"] == "a" * 24:
            item["parentId"] = "e" * 24
    assert build_image_key(GUN, [renamed[0], *reversed(renamed[1:])]) == key
    items[-1]["parentId"] = "c" * 24
    assert build_image_key(GUN, items) != key
    items[0]["_tpl"] = "5" * 24
    assert build_image_key("5" * 24, items) != key


@pytest.mark.parametrize("defect", ["empty", "root", "id", "duplicate", "parent", "cycle", "slot", "extra_root"])
def test_invalid_payloads_are_rejected(defect):
    items = build()
    if defect == "empty":
        items = []
    elif defect == "root":
        items[0]["_tpl"] = "9" * 24
    elif defect == "id":
        items[1]["_id"] = "invalid"
    elif defect == "duplicate":
        items[1]["_id"] = items[0]["_id"]
    elif defect == "parent":
        items[1]["parentId"] = "f" * 24
    elif defect == "cycle":
        items[1]["parentId"] = items[1]["_id"]
    elif defect == "slot":
        items.append({**items[1], "_id": "c" * 24})
    else:
        items[1]["parentId"] = "hideout"
    with pytest.raises(ValueError):
        build_image_key(GUN, items)


def test_loaded_key_separates_each_ammo_and_keeps_empty_builds_on_the_build_key():
    key = build_image_key(GUN, build())
    assert loaded_image_key(key, None, None) == key
    loaded = {
        loaded_image_key(key, a, u)
        for a, u in [("6" * 24, None), ("7" * 24, None), (None, "6" * 24), ("6" * 24, "7" * 24)]
    }
    assert len(loaded) == 4 and key not in loaded
    with pytest.raises(ValueError):
        loaded_image_key(key, "not-an-id", None)
