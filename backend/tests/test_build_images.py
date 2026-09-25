"""Exercise build image cache keys without Kitbash! or the game database."""

import os
import subprocess
from copy import deepcopy

import pytest

os.environ.setdefault("IP_HASH_SECRET", "build-images-test-secret")
os.environ.setdefault("ADMIN_API_KEY", "build-images-test-admin")

import build_images
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


def test_ammo_is_always_chambered(monkeypatch):
    loads = []

    class FakeCompositor:
        def load_ammo(self, items, ammo, chamber=False):
            loads.append((len(items), ammo, chamber))
            return items

        def drawable(self, items):
            return items, []

        def render(self, items, scale):
            from PIL import Image

            return Image.new("RGBA", (1, 1))

    monkeypatch.setattr(build_images, "_get", lambda: FakeCompositor())
    monkeypatch.setattr(build_images, "_cache", build_images.OrderedDict())
    monkeypatch.setattr(build_images, "_cache_bytes", 0)
    build_images.render_webp("stripped", build()[:1], "6" * 24)
    build_images.render_webp("built", build(), "6" * 24, "7" * 24)
    assert loads == [(1, "6" * 24, True), (2, "6" * 24, True), (2, "7" * 24, True)]


def test_version_reads_the_kitbash_head_commit_codename_and_game_version(monkeypatch, tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@t",
        "GIT_COMMITTER_DATE": "2026-09-22T23:58:03-04:00",
    }
    subprocess.run(["git", "-C", str(tmp_path), "commit", "-q", "--allow-empty", "-m", "x"], check=True, env=env)
    head = subprocess.run(["git", "-C", str(tmp_path), "rev-parse", "HEAD"], capture_output=True, text=True).stdout
    (tmp_path / "data").mkdir()
    manifest = tmp_path / "data" / "sprites.manifest.json"
    manifest.write_text('{"version": 5, "gameVersion": "1.1.5.1.47510", "models": {}}')
    (tmp_path / "CODENAME").write_text("Sirius\n")
    monkeypatch.setattr(build_images, "KITBASH_DIR", str(tmp_path))
    monkeypatch.setattr(build_images, "available", lambda: True)
    build_images.version.cache_clear()
    try:
        assert build_images.version() == {
            "commit": head.strip(),
            "date": "2026-09-22T23:58:03-04:00",
            "codename": "Sirius",
            "gameVersion": "1.1.5.1.47510",
        }
        # A manifest from before the stamp, or a checkout git cannot read, leaves just that part out.
        manifest.write_text('{"version": 5, "models": {}}')
        build_images.version.cache_clear()
        monkeypatch.setattr(build_images, "KITBASH_DIR", str(tmp_path / "missing"))
        assert build_images.version() == {"commit": None, "date": None, "codename": None, "gameVersion": None}
        monkeypatch.setattr(build_images, "available", lambda: False)
        build_images.version.cache_clear()
        assert build_images.version() is None
    finally:
        build_images.version.cache_clear()
