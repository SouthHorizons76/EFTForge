"""Check the image API boundary with a fake Kitbash! renderer."""

import asyncio
import os
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from tests.test_build_images import GUN, build


@pytest.fixture
def api(monkeypatch):
    # Import lazily so collection does not initialize the application databases.
    os.environ.setdefault("IP_HASH_SECRET", "image-test-secret")
    os.environ.setdefault("ADMIN_API_KEY", "image-test-admin")
    import main

    monkeypatch.setattr(main, "_imggen_disabled", False)
    monkeypatch.setattr(main.build_images, "available", lambda: True)
    return main


def fake_renderer(monkeypatch, api, unrenderable_ammo=None):
    calls = []

    def render(key, items, ammo=None, ubgl_ammo=None):
        calls.append((key, ammo, ubgl_ammo))
        if unrenderable_ammo and ammo == unrenderable_ammo:
            raise api.build_images.Unrenderable("no sprite for that round")
        return b"webp", []

    monkeypatch.setattr(api.build_images, "render_webp", render)
    return calls


def test_api_rejects_non_weapon_and_mismatched_roots_before_rendering(api, monkeypatch):
    calls = fake_renderer(monkeypatch, api)
    weapon = SimpleNamespace(is_weapon=False, name="test gun")
    db = SimpleNamespace(get=lambda *args: weapon)

    async def run():
        with pytest.raises(HTTPException) as error:
            await api.build_image(GUN, build(), "preview", db)
        assert error.value.status_code == 422
        weapon.is_weapon = True
        items = build()
        items[0]["_tpl"] = "f" * 24
        with pytest.raises(HTTPException) as error:
            await api.build_image(GUN, items, "preview", db)
        assert error.value.status_code == 422
        assert calls == []

    asyncio.run(run())


def test_api_is_unavailable_without_kitbash_or_when_disabled(api, monkeypatch):
    calls = fake_renderer(monkeypatch, api)
    db = SimpleNamespace(get=lambda *args: SimpleNamespace(is_weapon=True, name="test gun"))

    async def run():
        monkeypatch.setattr(api.build_images, "available", lambda: False)
        assert await api.build_image_status() == {"disabled": True}
        with pytest.raises(HTTPException) as error:
            await api.build_image(GUN, build(), "preview", db)
        assert error.value.status_code == 503
        monkeypatch.setattr(api.build_images, "available", lambda: True)
        assert await api.build_image_status() == {"disabled": False}
        monkeypatch.setattr(api, "_imggen_disabled", True)
        assert await api.build_image_status() == {"disabled": True}
        with pytest.raises(HTTPException) as error:
            await api.build_image(GUN, build(), "preview", db)
        assert error.value.status_code == 503
        assert calls == []

    asyncio.run(run())


def test_loaded_build_renders_with_its_ammo(api, monkeypatch):
    calls = fake_renderer(monkeypatch, api, unrenderable_ammo="7" * 24)
    db = SimpleNamespace(get=lambda *args: SimpleNamespace(is_weapon=True, name="test gun"))

    def with_mag():
        return build() + [{"_id": "c" * 24, "_tpl": "9" * 24, "slotId": "mod_magazine", "parentId": "a" * 24}]

    async def run():
        empty = await api.build_image(GUN, with_mag(), "preview", db)
        loaded = await api.build_image(GUN, with_mag(), "preview", db, True, "6" * 24, "8" * 24)
        ignored = await api.build_image(GUN, with_mag(), "preview", db, False, "6" * 24, None)
        magless = await api.build_image(GUN, build(), "preview", db, True, "6" * 24, None)
        assert empty == ignored == loaded == magless == {"image_url": api.build_images.data_url(b"webp"), "skipped": []}
        (k0, *none0), (k1, *ammo1), (k2, *none2), (k3, *none3) = calls
        assert none0 == none2 == none3 == [None, None] and k0 == k2
        assert ammo1 == ["6" * 24, "8" * 24] and k1 != k0
        # No magazine to load: the magless build renders, and caches, as empty.
        assert k3 == api.build_image_key(GUN, build())
        with pytest.raises(HTTPException) as error:
            await api.build_image(GUN, with_mag(), "preview", db, True, "bad", None)
        assert error.value.status_code == 422

    asyncio.run(run())


def test_unrenderable_build_is_rejected_with_the_reason(api, monkeypatch):
    fake_renderer(monkeypatch, api, unrenderable_ammo="7" * 24)
    db = SimpleNamespace(get=lambda *args: SimpleNamespace(is_weapon=True, name="test gun"))
    items = build() + [{"_id": "c" * 24, "_tpl": "9" * 24, "slotId": "mod_magazine", "parentId": "a" * 24}]

    async def run():
        with pytest.raises(HTTPException) as error:
            await api.build_image(GUN, items, "preview", db, True, "7" * 24, None)
        assert error.value.status_code == 422
        assert "no sprite for that round" in error.value.detail

    asyncio.run(run())


def test_parts_kitbash_cannot_draw_are_left_out(api, monkeypatch):
    monkeypatch.setattr(api.build_images, "render_webp", lambda *args: (b"webp", ["9" * 24]))
    db = SimpleNamespace(get=lambda *args: SimpleNamespace(is_weapon=True, name="test gun"))
    result = asyncio.run(api.build_image(GUN, build(), "preview", db))
    assert result == {"image_url": api.build_images.data_url(b"webp"), "skipped": ["9" * 24]}


def test_weapon_kitbash_cannot_draw_is_rejected_with_its_own_code(api, monkeypatch):
    def unsupported(*args):
        raise api.build_images.UnsupportedWeapon("no baked model")

    monkeypatch.setattr(api.build_images, "render_webp", unsupported)
    db = SimpleNamespace(get=lambda *args: SimpleNamespace(is_weapon=True, name="test gun"))
    with pytest.raises(HTTPException) as error:
        asyncio.run(api.build_image(GUN, build(), "preview", db))
    assert error.value.status_code == 422
    assert error.value.detail["code"] == "unsupported_weapon"


def test_gun_list_points_only_unknown_images_at_kitbash(api, monkeypatch):
    monkeypatch.setattr(api.build_images, "available", lambda: True)
    gun = SimpleNamespace(id=GUN, image_512_link=api.UNKNOWN_IMAGE_512, bare_image_512_link="https://x/bare.webp")
    assert api._gun_image_512(gun, bare=False) == f"/guns/{GUN}/image"
    assert api._gun_image_512(gun, bare=True) == "https://x/bare.webp"
    monkeypatch.setattr(api.build_images, "available", lambda: False)
    assert api._gun_image_512(gun, bare=False) == api.UNKNOWN_IMAGE_512


def test_gun_image_falls_back_to_unknown_when_kitbash_cannot_draw(api, monkeypatch):
    monkeypatch.setattr(api.build_images, "available", lambda: True)

    def unrenderable(*args):
        raise api.build_images.Unrenderable("no sprite")

    monkeypatch.setattr(api.build_images, "render_webp", unrenderable)
    db = SimpleNamespace(get=lambda *args: SimpleNamespace(id=GUN, is_weapon=True))
    response = asyncio.run(api.get_gun_image(GUN, bare=True, db=db))
    assert response.status_code == 302
    assert response.headers["location"] == api.UNKNOWN_IMAGE_512


def test_gun_routes_are_registered(api):
    paths = {route.path for route in api.app.routes}
    assert {"/guns", "/guns/{gun_id}/image", "/guns/{gun_id}/init", "/graph/searchable-items"} <= paths
