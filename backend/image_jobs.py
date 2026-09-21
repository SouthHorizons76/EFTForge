"""Validate build identity and schedule work before entering the image proxy."""

import asyncio
import copy
import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass


def build_image_key(gun_id: str, items: list) -> str:
    # Validate the complete tree before caching or dispatching any build.
    if not items or len(items) > 150:
        raise ValueError("Expected 1 to 150 build items")
    nodes = {}
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Invalid build item")
        for field in ("_id", "_tpl"):
            if not isinstance(item.get(field), str) or not re.fullmatch(r"[0-9a-f]{24}", item[field]):
                raise ValueError(f"Invalid item {field}")
        if item["_id"] in nodes:
            raise ValueError("Duplicate item instance")
        if not isinstance(item.get("slotId"), str) or not item["slotId"]:
            raise ValueError("Missing item slot")
        if not isinstance(item.get("parentId"), str):
            raise ValueError("Missing item parent")
        nodes[item["_id"]] = item
    root = items[0]
    if root["_tpl"] != gun_id or root["slotId"] != "hideout" or root["parentId"] != "hideout":
        raise ValueError("Build root does not match the requested weapon")
    children = {iid: [] for iid in nodes}
    occupied = set()
    for item in items[1:]:
        parent = item["parentId"]
        if parent not in nodes:
            raise ValueError("Unknown attachment parent")
        placement = (parent, item["slotId"])
        if placement in occupied:
            raise ValueError("Duplicate attachment slot")
        occupied.add(placement)
        children[parent].append(item)
    visited = set()

    def encode(item):
        iid = item["_id"]
        if iid in visited:
            raise ValueError("Cyclic build tree")
        visited.add(iid)
        return [item["_tpl"], item["slotId"], [encode(c) for c in sorted(children[iid], key=lambda c: c["slotId"])]]

    encoded = encode(root)
    if len(visited) != len(nodes):
        raise ValueError("Disconnected build tree")
    return hashlib.sha256(json.dumps(encoded, separators=(",", ":")).encode()).hexdigest()


def loaded_image_key(key: str, ammo: str | None, ubgl_ammo: str | None) -> str:
    """The render cache key for a build whose magazines are loaded with `ammo` and
    whose UBGL holds `ubgl_ammo`; the build key itself when both are empty."""
    for tpl in (ammo, ubgl_ammo):
        if tpl is not None and not re.fullmatch(r"[0-9a-f]{24}", tpl):
            raise ValueError("Invalid ammo id")
    if not (ammo or ubgl_ammo):
        return key
    return hashlib.sha256(f"{key}|{ammo or ''}|{ubgl_ammo or ''}".encode()).hexdigest()


class ImageQueueFull(RuntimeError):
    pass


@dataclass
class _Job:
    key: str
    gun_id: str
    items: list
    weapon_name: str
    priority: int
    result: asyncio.Future
    created: float
    source: str
    waiters: int = 0
    started: bool = False


class ImageJobs:
    # Own all jobs on the proxy event loop, including health and publication jobs.
    def __init__(self, generate, max_jobs=128):
        self.generate = generate
        self.max_jobs = max_jobs
        self.jobs = {}
        self.worker = None
        self.log = logging.getLogger(__name__)

    @property
    def busy(self):
        return bool(self.jobs)

    async def request(self, gun_id, items, weapon_name, priority=0, source="preview"):
        key = build_image_key(gun_id, items)
        job = self.jobs.get(key)
        if job is None:
            if len(self.jobs) >= self.max_jobs:
                raise ImageQueueFull("Image generation queue is full")
            result = asyncio.get_running_loop().create_future()
            # Retrieve failures even when all subscribers have left an active job.
            result.add_done_callback(lambda f: None if f.cancelled() else f.exception())
            job = _Job(key, gun_id, copy.deepcopy(items), weapon_name, priority, result, time.monotonic(), source)
            self.jobs[key] = job
        job.priority = min(job.priority, priority)
        job.waiters += 1
        if self.worker is None or self.worker.done():
            self.worker = asyncio.create_task(self._run())
        try:
            return await asyncio.shield(job.result)
        finally:
            job.waiters -= 1
            if not job.waiters and not job.started and self.jobs.get(key) is job:
                del self.jobs[key]
                job.result.cancel()
                self.log.info("image job discarded source=%s build=%s", job.source, key[:16])

    async def _run(self):
        while self.jobs:
            job = min(self.jobs.values(), key=lambda j: (j.priority, j.created))
            job.started = True
            self.log.info(
                "image job started source=%s gun=%s build=%s queued_seconds=%.3f",
                job.source,
                job.gun_id,
                job.key[:16],
                time.monotonic() - job.created,
            )
            try:
                result = await self.generate(job.gun_id, job.items, job.weapon_name)
                if (
                    not isinstance(result, dict)
                    or not isinstance(result.get("imageUrl"), str)
                    or not result["imageUrl"]
                ):
                    raise RuntimeError("Image generator returned no imageUrl")
            except Exception as exc:
                job.result.set_exception(exc)
            else:
                self.log.info("image job completed build=%s url=%s", job.key[:16], result.get("imageUrl"))
                job.result.set_result(result)
            finally:
                del self.jobs[job.key]
