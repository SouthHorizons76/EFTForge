"""Check the image API boundary with fake generation and no upstream requests."""

import asyncio
import concurrent.futures
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from image_jobs import ImageJobs
from tests.test_image_jobs import GUN, build


@pytest.fixture
def api(monkeypatch):
    # Import lazily so collection does not initialize the application databases.
    os.environ.setdefault("IP_HASH_SECRET", "image-test-secret")
    os.environ.setdefault("ADMIN_API_KEY", "image-test-admin")
    import main

    monkeypatch.setattr(main, "_imggen_disabled", False)
    monkeypatch.setattr(main, "_IMAGE_GEN_CACHE", {})
    return main


def test_api_rejects_non_weapon_and_mismatched_roots_before_generation(api, monkeypatch):
    generate = AsyncMock(return_value={"imageUrl": "/test.webp"})
    monkeypatch.setattr(api, "_image_jobs", ImageJobs(generate))
    weapon = SimpleNamespace(is_weapon=False, name="test gun")
    db = SimpleNamespace(get=lambda *args: weapon)
    request = SimpleNamespace(is_disconnected=AsyncMock(return_value=False))

    async def run():
        with pytest.raises(HTTPException) as error:
            await api.proxy_build_image(request, GUN, build(), "preview", db)
        assert error.value.status_code == 422
        weapon.is_weapon = True
        items = build()
        items[0]["_tpl"] = "f" * 24
        with pytest.raises(HTTPException) as error:
            await api.proxy_build_image(request, GUN, items, "preview", db)
        assert error.value.status_code == 422
        generate.assert_not_awaited()

    asyncio.run(run())


def test_api_caches_valid_build_and_never_changes_proxy_payload(api, monkeypatch):
    generate = AsyncMock(return_value={"imageUrl": "/test.webp"})
    monkeypatch.setattr(api, "_image_jobs", ImageJobs(generate))
    db = SimpleNamespace(get=lambda *args: SimpleNamespace(is_weapon=True, name="test gun"))
    request = SimpleNamespace(is_disconnected=AsyncMock(return_value=False))

    async def run():
        first = await api.proxy_build_image(request, GUN, build(), "preview", db)
        second = await api.proxy_build_image(request, GUN, build(), "export", db)
        assert first == second == {"image_url": "https://image-gen.tarkov-changes.com/test.webp"}
        generate.assert_awaited_once_with(GUN, build(), "test gun")

    asyncio.run(run())


def test_loaded_build_renders_with_its_ammo_and_falls_back_empty(api, monkeypatch):
    generate = AsyncMock(return_value={"imageUrl": "/test.webp"})
    monkeypatch.setattr(api, "_image_jobs", ImageJobs(generate))
    db = SimpleNamespace(get=lambda *args: SimpleNamespace(is_weapon=True, name="test gun"))
    request = SimpleNamespace(is_disconnected=AsyncMock(return_value=False))
    calls = []

    def render(key, items, ammo=None, ubgl_ammo=None):
        calls.append((key, ammo, ubgl_ammo))
        if ammo == "7" * 24:
            raise api.build_images.Unrenderable("no sprite for that round")
        return b"webp"

    monkeypatch.setattr(api.build_images, "available", lambda: True)
    monkeypatch.setattr(api.build_images, "render_webp", render)

    async def run():
        empty = await api.proxy_build_image(request, GUN, build(), "preview", db)
        loaded = await api.proxy_build_image(request, GUN, build(), "preview", db, True, "6" * 24, "8" * 24)
        ignored = await api.proxy_build_image(request, GUN, build(), "preview", db, False, "6" * 24, None)
        assert empty == ignored == loaded == {"image_url": api.build_images.data_url(b"webp")}
        (k0, *none0), (k1, *ammo1), (k2, *none2) = calls
        assert none0 == none2 == [None, None] and k0 == k2
        assert ammo1 == ["6" * 24, "8" * 24] and k1 != k0
        # Kitbash! cannot draw it: the image-gen proxy gets the build as sent, empty.
        fallback = await api.proxy_build_image(request, GUN, build(), "preview", db, True, "7" * 24, None)
        assert fallback == {"image_url": "https://image-gen.tarkov-changes.com/test.webp"}
        generate.assert_awaited_once_with(GUN, build(), "test gun")
        with pytest.raises(HTTPException) as error:
            await api.proxy_build_image(request, GUN, build(), "preview", db, True, "bad", None)
        assert error.value.status_code == 422

    asyncio.run(run())


def test_disconnected_http_request_withdraws_its_subscription(api):
    async def run():
        future = concurrent.futures.Future()
        request = SimpleNamespace(is_disconnected=AsyncMock(return_value=True))
        with pytest.raises(HTTPException) as error:
            await api._await_image_job(future, request)
        assert error.value.status_code == 499
        assert future.cancelled()

    asyncio.run(run())


def test_browser_recovery_finishes_before_next_job_starts(api, monkeypatch):
    async def run():
        calls = []
        recovery_started, allow_recovery = asyncio.Event(), asyncio.Event()

        async def generate(gun, items, name):
            calls.append(name)
            if name == "broken":
                raise RuntimeError("failed browser operation")
            return {"imageUrl": "/ok.webp"}

        async def recover():
            recovery_started.set()
            await allow_recovery.wait()
            calls.append("recovered")

        monkeypatch.setattr(api, "_do_pw_request", generate)
        monkeypatch.setattr(api, "_reset_pw_page", recover)
        queue = ImageJobs(api._generate_image_job)
        first = asyncio.create_task(queue.request(GUN, build(2), "broken"))
        await recovery_started.wait()
        second = asyncio.create_task(queue.request(GUN, build(3), "next"))
        await asyncio.sleep(0)
        assert calls == ["broken"]
        allow_recovery.set()
        with pytest.raises(RuntimeError):
            await first
        assert await second == {"imageUrl": "/ok.webp"}
        await queue.worker
        assert calls == ["broken", "recovered", "next"]

    asyncio.run(run())
