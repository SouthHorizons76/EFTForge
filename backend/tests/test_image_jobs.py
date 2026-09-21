"""Exercise image scheduling without a browser, service calls, or game database."""

import asyncio
from copy import deepcopy

import pytest

from image_jobs import ImageJobs, ImageQueueFull, build_image_key, loaded_image_key

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


async def cancel(task):
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


def test_latest_waiter_replaces_abandoned_jobs_without_interrupting_active_generation():
    async def run():
        started, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def generate(gun, items, name):
            calls.append(items[1]["_tpl"])
            started.set()
            await release.wait()
            return {"imageUrl": calls[-1]}

        queue = ImageJobs(generate)
        active = asyncio.create_task(queue.request(GUN, build(2), "gun"))
        await started.wait()
        stale = asyncio.create_task(queue.request(GUN, build(3), "gun"))
        await asyncio.sleep(0)
        await cancel(stale)
        await cancel(active)
        latest = asyncio.create_task(queue.request(GUN, build(4), "gun"))
        await asyncio.sleep(0)
        assert queue.busy
        assert calls == [f"{2:024x}"]
        release.set()
        assert await latest == {"imageUrl": f"{4:024x}"}
        await queue.worker
        assert calls == [f"{2:024x}", f"{4:024x}"]
        assert not queue.busy

    asyncio.run(run())


def test_identical_consumers_share_generation_and_cancel_independently():
    async def run():
        started, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def generate(*args):
            calls.append(args)
            started.set()
            await release.wait()
            return {"imageUrl": "shared"}

        queue = ImageJobs(generate)
        first = asyncio.create_task(queue.request(GUN, build(), "gun"))
        await started.wait()
        second = asyncio.create_task(queue.request(GUN, build(), "gun"))
        await asyncio.sleep(0)
        await cancel(first)
        release.set()
        assert await second == {"imageUrl": "shared"}
        assert len(calls) == 1
        await queue.worker

    asyncio.run(run())


def test_visible_work_precedes_background_and_queued_payload_is_immutable():
    async def run():
        started, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def generate(gun, items, name):
            calls.append(items[1]["_tpl"])
            started.set()
            await release.wait()
            return {"imageUrl": name}

        queue = ImageJobs(generate)
        first = asyncio.create_task(queue.request(GUN, build(2), "active"))
        await started.wait()
        payload = build(3)
        background = asyncio.create_task(queue.request(GUN, payload, "background", priority=2))
        hover = asyncio.create_task(queue.request(GUN, build(4), "hover", priority=1))
        visible = asyncio.create_task(queue.request(GUN, build(5), "visible"))
        await asyncio.sleep(0)
        payload[1]["_tpl"] = "f" * 24
        release.set()
        await asyncio.gather(first, background, hover, visible)
        await queue.worker
        assert calls == [f"{i:024x}" for i in (2, 5, 4, 3)]

    asyncio.run(run())


def test_failed_job_releases_queue_and_capacity_is_bounded():
    async def run():
        started, release = asyncio.Event(), asyncio.Event()

        async def generate(gun, items, name):
            started.set()
            await release.wait()
            if name == "fail":
                raise RuntimeError("service failure")
            return {"imageUrl": "ok"}

        queue = ImageJobs(generate, max_jobs=2)
        first = asyncio.create_task(queue.request(GUN, build(2), "fail"))
        await started.wait()
        second = asyncio.create_task(queue.request(GUN, build(3), "ok"))
        await asyncio.sleep(0)
        with pytest.raises(ImageQueueFull):
            await queue.request(GUN, build(4), "overflow")
        release.set()
        with pytest.raises(RuntimeError, match="service failure"):
            await first
        assert await second == {"imageUrl": "ok"}
        await queue.worker
        assert not queue.busy
        assert await queue.request(GUN, build(4), "ok") == {"imageUrl": "ok"}

    asyncio.run(run())


@pytest.mark.parametrize("response", [None, [], {}, {"imageUrl": 123}, {"imageUrl": ""}])
def test_malformed_service_response_does_not_strand_other_jobs(response):
    async def run():
        async def generate(gun, items, name):
            return response if name == "bad" else {"imageUrl": "ok"}

        queue = ImageJobs(generate)
        bad = asyncio.create_task(queue.request(GUN, build(2), "bad"))
        good = asyncio.create_task(queue.request(GUN, build(3), "good"))
        with pytest.raises(RuntimeError, match="no imageUrl"):
            await bad
        assert await good == {"imageUrl": "ok"}
        await queue.worker
        assert not queue.busy

    asyncio.run(run())
