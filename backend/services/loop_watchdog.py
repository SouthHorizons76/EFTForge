"""Writes every thread's stack to the log when the event loop stops answering.

A worker whose event loop is stuck answers nothing, and Gunicorn kills it after 30 s with no
word on why. On 2026-11-16 that happened every few minutes, and finding the cause took
reading thread states out of /proc. Now a thread outside the loop pings it every couple of
seconds; when a ping goes unanswered for STALL_SECONDS, it dumps every thread's Python stack
to stderr (the journal) with faulthandler, which needs neither the loop nor the GIL, once per
stall. It costs one tiny callback on the loop per ping.
"""

from __future__ import annotations

import asyncio
import faulthandler
import logging
import sys
import threading
import time

_logger = logging.getLogger(__name__)

PING_SECONDS = 2.0
STALL_SECONDS = 10.0

_started = False


def start(loop: asyncio.AbstractEventLoop) -> None:
    """Watch `loop` from a daemon thread. Once per process."""
    global _started
    if _started:
        return
    _started = True
    last_answer = [time.monotonic()]

    def answered() -> None:
        last_answer[0] = time.monotonic()

    def watch() -> None:
        dumped = False
        while True:
            time.sleep(PING_SECONDS)
            try:
                loop.call_soon_threadsafe(answered)
            except RuntimeError:  # the loop is closed: the worker is shutting down
                return
            stalled = time.monotonic() - last_answer[0]
            if stalled < STALL_SECONDS:
                dumped = False
            elif not dumped:
                dumped = True
                sys.stderr.write(f"loop watchdog: the event loop has not answered for {stalled:.0f}s, every thread:\n")
                sys.stderr.flush()
                faulthandler.dump_traceback(file=sys.stderr, all_threads=True)
                sys.stderr.flush()

    threading.Thread(target=watch, name="loop-watchdog", daemon=True).start()
    _logger.info("loop watchdog: watching the event loop (stall after %ss)", STALL_SECONDS)
