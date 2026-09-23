"""Check the image API boundary with a fake Kitbash! renderer."""

import asyncio
import os
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from tests.test_build_images import GUN, build

REQ = SimpleNamespace(client=SimpleNamespace(host="203.0.113.7"), headers={})


@pytest.fixture
def api(monkeypatch):
    # Import lazily so collection does not initialize the application databases.
    os.environ.setdefault("IP_HASH_SECRET", "image-test-secret")
    os.environ.setdefault("ADMIN_API_KEY", "image-test-admin")
    import main

    monkeypatch.setattr(main, "_imggen_disabled", False)
    monkeypatch.setattr(main.build_images, "available", lambda: True)
    monkeypatch.setattr(main.build_images, "version", lambda: None)
    monkeypatch.setattr(main, "_image_buckets", {})
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
            await api.build_image(REQ, GUN, build(), "preview", db)
        assert error.value.status_code == 422
        weapon.is_weapon = True
        items = build()
        items[0]["_tpl"] = "f" * 24
        with pytest.raises(HTTPException) as error:
            await api.build_image(REQ, GUN, items, "preview", db)
        assert error.value.status_code == 422
        assert calls == []

    asyncio.run(run())


def test_api_is_unavailable_without_kitbash_or_when_disabled(api, monkeypatch):
    calls = fake_renderer(monkeypatch, api)
    db = SimpleNamespace(get=lambda *args: SimpleNamespace(is_weapon=True, name="test gun"))

    async def run():
        monkeypatch.setattr(api.build_images, "available", lambda: False)
        assert await api.build_image_status() == {"disabled": True, "kitbash": None}
        with pytest.raises(HTTPException) as error:
            await api.build_image(REQ, GUN, build(), "preview", db)
        assert error.value.status_code == 503
        monkeypatch.setattr(api.build_images, "available", lambda: True)
        assert await api.build_image_status() == {"disabled": False, "kitbash": None}
        monkeypatch.setattr(api, "_imggen_disabled", True)
        assert await api.build_image_status() == {"disabled": True, "kitbash": None}
        with pytest.raises(HTTPException) as error:
            await api.build_image(REQ, GUN, build(), "preview", db)
        assert error.value.status_code == 503
        assert calls == []

    asyncio.run(run())


def test_loaded_build_renders_with_its_ammo(api, monkeypatch):
    calls = fake_renderer(monkeypatch, api, unrenderable_ammo="7" * 24)
    db = SimpleNamespace(get=lambda *args: SimpleNamespace(is_weapon=True, name="test gun"))

    def with_mag():
        return build() + [{"_id": "c" * 24, "_tpl": "9" * 24, "slotId": "mod_magazine", "parentId": "a" * 24}]

    async def run():
        empty = await api.build_image(REQ, GUN, with_mag(), "preview", db)
        loaded = await api.build_image(REQ, GUN, with_mag(), "preview", db, True, "6" * 24, "8" * 24)
        ignored = await api.build_image(REQ, GUN, with_mag(), "preview", db, False, "6" * 24, None)
        magless = await api.build_image(REQ, GUN, build(), "preview", db, True, "6" * 24, None)
        assert empty == ignored == loaded == magless == {"image_url": api.build_images.data_url(b"webp"), "skipped": []}
        (k0, *none0), (k1, *ammo1), (k2, *none2), (k3, *ammo3) = calls
        assert none0 == none2 == [None, None] and k0 == k2
        assert ammo1 == ["6" * 24, "8" * 24] and k1 != k0
        # No magazine to load, but the round still goes in the chamber.
        assert ammo3 == ["6" * 24, None] and k3 != api.build_image_key(GUN, build())
        with pytest.raises(HTTPException) as error:
            await api.build_image(REQ, GUN, with_mag(), "preview", db, True, "bad", None)
        assert error.value.status_code == 422

    asyncio.run(run())


def test_unrenderable_build_is_rejected_with_the_reason(api, monkeypatch):
    fake_renderer(monkeypatch, api, unrenderable_ammo="7" * 24)
    db = SimpleNamespace(get=lambda *args: SimpleNamespace(is_weapon=True, name="test gun"))
    items = build() + [{"_id": "c" * 24, "_tpl": "9" * 24, "slotId": "mod_magazine", "parentId": "a" * 24}]

    async def run():
        with pytest.raises(HTTPException) as error:
            await api.build_image(REQ, GUN, items, "preview", db, True, "7" * 24, None)
        assert error.value.status_code == 422
        assert "no sprite for that round" in error.value.detail

    asyncio.run(run())


def test_parts_kitbash_cannot_draw_are_left_out(api, monkeypatch):
    monkeypatch.setattr(api.build_images, "render_webp", lambda *args: (b"webp", ["9" * 24]))
    db = SimpleNamespace(get=lambda *args: SimpleNamespace(is_weapon=True, name="test gun"))
    result = asyncio.run(api.build_image(REQ, GUN, build(), "preview", db))
    assert result == {"image_url": api.build_images.data_url(b"webp"), "skipped": ["9" * 24]}


def test_weapon_kitbash_cannot_draw_is_rejected_with_its_own_code(api, monkeypatch):
    def unsupported(*args):
        raise api.build_images.UnsupportedWeapon("no baked model")

    monkeypatch.setattr(api.build_images, "render_webp", unsupported)
    db = SimpleNamespace(get=lambda *args: SimpleNamespace(is_weapon=True, name="test gun"))
    with pytest.raises(HTTPException) as error:
        asyncio.run(api.build_image(REQ, GUN, build(), "preview", db))
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
    gun = SimpleNamespace(id=GUN, is_weapon=True, bare_image_512_link=api.UNKNOWN_IMAGE_512)
    db = SimpleNamespace(get=lambda *args: gun)
    response = asyncio.run(api.get_gun_image(GUN, bare=True, db=db))
    assert response.status_code == 302
    assert response.headers["location"] == api.UNKNOWN_IMAGE_512


def test_gun_image_draws_only_guns_tarkov_dev_has_no_image_for(api, monkeypatch):
    calls = fake_renderer(monkeypatch, api)
    gun = SimpleNamespace(
        id=GUN, is_weapon=True, image_512_link="https://x/full.webp", bare_image_512_link=api.UNKNOWN_IMAGE_512
    )
    db = SimpleNamespace(get=lambda *args: gun)
    response = asyncio.run(api.get_gun_image(GUN, bare=False, db=db))
    assert response.status_code == 302
    assert response.headers["location"] == "https://x/full.webp"
    assert calls == []
    gun.image_512_link = None
    response = asyncio.run(api.get_gun_image(GUN, bare=False, db=db))
    assert response.headers["location"] == api.UNKNOWN_IMAGE_512
    assert calls == []
    response = asyncio.run(api.get_gun_image(GUN, bare=True, db=db))
    assert response.status_code == 200 and response.body == b"webp"
    assert len(calls) == 1


def test_gun_routes_are_registered(api):
    paths = {route.path for route in api.app.routes}
    assert {"/guns", "/guns/{gun_id}/image", "/guns/{gun_id}/init", "/graph/searchable-items"} <= paths


def test_one_ip_is_throttled_after_its_burst(api, monkeypatch):
    fake_renderer(monkeypatch, api)
    db = SimpleNamespace(get=lambda *args: SimpleNamespace(is_weapon=True, name="test gun"))
    other = SimpleNamespace(client=SimpleNamespace(host="203.0.113.8"), headers={})

    async def run():
        for _ in range(api._IMAGE_BURST):
            await api.build_image(REQ, GUN, build(), "preview", db)
        with pytest.raises(HTTPException) as error:
            await api.build_image(REQ, GUN, build(), "preview", db)
        assert error.value.status_code == 429
        # Another client keeps its own budget.
        await api.build_image(other, GUN, build(), "preview", db)

    asyncio.run(run())


def test_renders_past_the_queue_cap_are_turned_away(api, monkeypatch):
    calls = fake_renderer(monkeypatch, api)
    monkeypatch.setattr(api, "_RENDER_QUEUE_SEM", api.threading.BoundedSemaphore(1))
    api._RENDER_QUEUE_SEM.acquire()
    db = SimpleNamespace(get=lambda *args: SimpleNamespace(is_weapon=True, name="test gun"))
    with pytest.raises(HTTPException) as error:
        asyncio.run(api.build_image(REQ, GUN, build(), "preview", db))
    assert error.value.status_code == 429
    assert calls == []


def test_worker_markers_never_reach_clients(api):
    for marker in ("error:gen-failed", api._CARD_WAITING_PARTS, "dryrun:https://x/build_1.webp", None, ""):
        assert api._public_card_url(marker) is None
    assert api._public_card_url("https://gitee.com/x/build_1.webp?v=1") == "https://gitee.com/x/build_1.webp?v=1"


def test_card_kitbash_cannot_draw_yet_waits_instead_of_failing(api, monkeypatch):
    import config

    monkeypatch.setattr(config, "GITEE_DRY_RUN", True)
    monkeypatch.setattr(api.build_images, "loaded", lambda: True)
    monkeypatch.setattr(api, "_build_spt_items", lambda gun_id, pairs: build())
    saved, waiting = [], []
    monkeypatch.setattr(api, "_save_build_card", lambda *args: saved.append(args) or True)
    monkeypatch.setattr(api, "_mark_card_waiting", waiting.append)

    # A part it has no sprite for.
    monkeypatch.setattr(api.build_images, "render_webp", lambda *args: (b"webp", ["9" * 24]))
    assert api._generate_and_save_build_image(1, GUN, []) == "incomplete"

    # A weapon it cannot draw at all.
    def unsupported(*args):
        raise api.build_images.UnsupportedWeapon("no baked model")

    monkeypatch.setattr(api.build_images, "render_webp", unsupported)
    assert api._generate_and_save_build_image(2, GUN, []) == "incomplete"
    assert waiting == [1, 2] and saved == []

    monkeypatch.setattr(api.build_images, "render_webp", lambda *args: (b"webp", []))
    assert api._generate_and_save_build_image(3, GUN, []) == "saved"
    assert saved == [(3, b"webp", "webp")] and waiting == [1, 2]


def test_card_is_not_marked_waiting_when_kitbash_failed_to_load(api, monkeypatch):
    import config

    monkeypatch.setattr(config, "GITEE_DRY_RUN", True)
    monkeypatch.setattr(api.build_images, "loaded", lambda: False)
    monkeypatch.setattr(api, "_mark_card_waiting", lambda build_id: pytest.fail("must not mark"))
    assert api._generate_and_save_build_image(1, GUN, []) == "failed"


class _FakeBuildsSession:
    def __init__(self, builds):
        self.builds = builds

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get(self, model, build_id):
        return self.builds.get(build_id)


def test_card_regen_batch_redraws_waiting_builds_and_releases_its_lock(api, monkeypatch, tmp_path):
    monkeypatch.setattr(api, "_CARD_REGEN_LOCK_FILE", str(tmp_path / "card_regen.lock"))
    builds = {
        1: SimpleNamespace(gun_id=GUN, pairs_json="[]", card_image_url=api._CARD_WAITING_PARTS),
        # Given a card some other way after the batch was queued.
        2: SimpleNamespace(gun_id=GUN, pairs_json="[]", card_image_url=api._GITEE_RAW_PREFIX + "build_2.webp"),
        4: SimpleNamespace(gun_id=GUN, pairs_json="[]", card_image_url="error:gen-failed"),
    }
    monkeypatch.setattr(api, "BuildsSessionLocal", lambda: _FakeBuildsSession(builds))
    drawn = []
    monkeypatch.setattr(
        api, "_generate_and_save_build_image", lambda build_id, *args: drawn.append(build_id) or "saved"
    )

    assert api._acquire_card_regen_lock()
    assert not api._acquire_card_regen_lock()
    # 3 was deleted after the batch was queued.
    api._regenerate_cards([1, 2, 3, 4])
    assert drawn == [1, 4]
    assert api._acquire_card_regen_lock()


def test_card_regen_route_is_registered(api):
    assert "/admin/migration/regenerate-unsupported" in {route.path for route in api.app.routes}


def test_migration_worker_does_not_start_without_kitbash(api, monkeypatch):
    import config

    monkeypatch.setattr(config, "GITEE_DRY_RUN", True)
    monkeypatch.setattr(config, "DISABLE_BG_MIGRATE", False)
    monkeypatch.setattr(api.build_images, "loaded", lambda: False)

    async def no_sleep(_):
        pass

    def no_db():
        raise AssertionError("the worker must not touch any build")

    monkeypatch.setattr(api.asyncio, "sleep", no_sleep)
    monkeypatch.setattr(api, "BuildsSessionLocal", no_db)
    asyncio.run(api._bg_migrate_build_images())
