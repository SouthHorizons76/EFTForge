"""The render helper process: a drawing that hangs or crashes costs that one picture, never
the server worker, and the worker's event loop watchdog reports a stall. Only made-up data."""

import asyncio
import os
import sys
import textwrap
import time

import pytest

os.environ.setdefault("IP_HASH_SECRET", "render-helper-test-secret")
os.environ.setdefault("ADMIN_API_KEY", "render-helper-test-admin")

import build_images  # noqa: E402
from tests.test_build_images import build  # noqa: E402


@pytest.fixture
def helper(monkeypatch, tmp_path):
    """Run the render helper from a script of the test's own, isolated, with short limits."""

    def use(body: str):
        script = tmp_path / "helper.py"
        script.write_text(textwrap.dedent(body), encoding="utf-8")
        monkeypatch.setattr(build_images, "HELPER_SCRIPT", str(script))

    monkeypatch.setattr(build_images, "ISOLATED", True)
    monkeypatch.setattr(build_images, "RENDER_TIMEOUT_SECONDS", 1)
    monkeypatch.setattr(build_images, "RENDER_WAIT_SECONDS", 2)
    monkeypatch.setattr(build_images, "_helper", None)
    monkeypatch.setattr(build_images, "_helper_failed_at", 0.0)
    monkeypatch.setattr(build_images, "_cache", build_images.OrderedDict())
    monkeypatch.setattr(build_images, "_cache_bytes", 0)
    yield use
    if build_images._helper is not None:
        build_images._helper.kill()


ANSWERS = """
    import base64, json, sys
    for line in sys.stdin:
        job = json.loads(line)
        if job["op"] == "ping":
            reply = {"ok": True, "loaded": True}
        elif job["items"][0]["_tpl"] == "9" * 24:
            reply = {"ok": False, "error": "unsupported", "message": "no sprites for it"}
        else:
            reply = {"ok": True, "data": base64.b64encode(b"webp:" + job["items"][0]["_tpl"].encode()).decode(), "skipped": ["5" * 24]}
        sys.stdout.write(json.dumps(reply) + "\\n"); sys.stdout.flush()
"""


def test_a_build_is_drawn_by_the_helper_and_cached(helper):
    helper(ANSWERS)
    assert build_images.loaded()
    first = build_images.render_webp("k1", build())
    assert first == (b"webp:" + b"1" * 24, ["5" * 24])
    proc = build_images._helper.proc
    # a cache hit never asks the helper again, and the same helper takes the next drawing
    assert build_images.render_webp("k1", build()) == first
    build_images.render_webp("k2", build())
    assert build_images._helper.proc is proc


def test_the_helpers_refusals_keep_their_kind(helper):
    helper(ANSWERS)
    items = build()
    items[0]["_tpl"] = "9" * 24
    with pytest.raises(build_images.UnsupportedWeapon):
        build_images.render_webp("k", items)


def test_a_hung_drawing_costs_one_picture_and_the_next_gets_a_fresh_helper(helper):
    helper("""
        import sys, time
        for line in sys.stdin:
            time.sleep(60)  # never answers
    """)
    started = time.monotonic()
    with pytest.raises(build_images.Unrenderable):
        build_images.render_webp("k1", build())
    assert time.monotonic() - started < 5
    hung = build_images._helper
    assert hung is None  # killed, not reused
    helper(ANSWERS)
    assert build_images.render_webp("k2", build())[0].startswith(b"webp:")


def test_a_crashed_helper_is_replaced(helper):
    helper("""
        import sys
        sys.stdin.readline()
        sys.exit(3)
    """)
    with pytest.raises(build_images.Unrenderable):
        build_images.render_webp("k1", build())
    helper(ANSWERS)
    assert build_images.render_webp("k2", build())[0].startswith(b"webp:")


def test_a_helper_without_kitbash_is_not_restarted_for_every_picture(helper):
    helper("""
        import json, sys
        for line in sys.stdin:
            sys.stdout.write(json.dumps({"ok": False, "error": "unloaded", "message": "no kitbash"}) + "\\n")
            sys.stdout.flush()
    """)
    with pytest.raises(build_images.Unrenderable):
        build_images.render_webp("k1", build())
    assert build_images._helper_failed_at > 0


def test_the_real_helper_draws_what_this_process_would(helper, monkeypatch):
    # The shipped render_helper.py against a real Kitbash! checkout, where there is one
    if not build_images.available():
        pytest.skip("no Kitbash! checkout here")
    monkeypatch.setattr(
        build_images, "HELPER_SCRIPT", os.path.join(os.path.dirname(build_images.__file__), "render_helper.py")
    )
    monkeypatch.setattr(build_images, "RENDER_TIMEOUT_SECONDS", 60)
    monkeypatch.setattr(build_images, "RENDER_WAIT_SECONDS", 60)
    assert build_images._helper_call({"op": "ping"}) == {"ok": True, "loaded": True}
    import json

    with open(os.path.join(build_images.KITBASH_DIR, "data", "sprites.manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    # The first few items with sprites: one of them draws on its own as a bare root
    drawn = None
    for tpl in list(manifest.get("templates") or {})[:40]:
        items = [{"_id": "a" * 24, "_tpl": tpl, "slotId": "hideout", "parentId": "hideout"}]
        try:
            monkeypatch.setattr(build_images, "ISOLATED", False)
            here = build_images._render_here(items, None, None)
        except build_images.Unrenderable:
            continue
        monkeypatch.setattr(build_images, "ISOLATED", True)
        drawn = (here, build_images.render_webp(f"real-{tpl}", items))
        break
    if drawn is None:
        pytest.skip("none of the first sprites draws on its own")
    assert drawn[0] == drawn[1]


def test_the_watchdog_dumps_every_thread_when_the_loop_stalls(monkeypatch, capfd):
    from services import loop_watchdog

    monkeypatch.setattr(loop_watchdog, "_started", False)
    monkeypatch.setattr(loop_watchdog, "PING_SECONDS", 0.1)
    monkeypatch.setattr(loop_watchdog, "STALL_SECONDS", 0.5)

    async def stall():
        loop_watchdog.start(asyncio.get_running_loop())
        await asyncio.sleep(0.3)
        time.sleep(1.5)  # the loop stuck, as a blocking call on it would leave it
        await asyncio.sleep(0.3)

    asyncio.run(stall())
    err = capfd.readouterr().err
    assert "the event loop has not answered" in err
    assert "test_the_watchdog_dumps_every_thread_when_the_loop_stalls" in err
    assert sys.modules["services.loop_watchdog"]
