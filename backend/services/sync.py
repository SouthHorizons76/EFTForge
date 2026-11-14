"""Background tarkov.dev sync (hyperactive mode) and the catalog data version.

The flags here are rebound at runtime, so other modules read them as
`sync.sync_running` etc. instead of importing a copy of the value."""

import asyncio
import logging
import os
import subprocess
import sys
import time

import build_images
from catalog_cache import code_stamp, make_data_version
from config import RUNTIME_DIR
from database import engine
from services import arena
from services.solver_cache import clear_solver_caches
from solver_cache_epoch import read_solver_cache_epoch

_logger = logging.getLogger(__name__)

# This file sits one level below the backend root.
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Hyperactive sync mode: re-syncs tarkov.dev data every 30 minutes instead of relying
# solely on the external daily cron. Useful immediately after a game patch when
# tarkov.dev data is still catching up to the new game state.
HYPERACTIVE_LOCK_FILE = os.path.join(RUNTIME_DIR, "hyperactive.lock")
hyperactive_mode: bool = os.path.exists(HYPERACTIVE_LOCK_FILE)
SYNC_INTERVAL_HYPERACTIVE_SECS = 1800  # 30 minutes
sync_running: bool = False
last_sync_at: float | None = None
sync_trigger: asyncio.Event = asyncio.Event()
# Written before the subprocess starts and removed after - visible to all gunicorn workers.
SYNC_IN_PROGRESS_FILE = os.path.join(RUNTIME_DIR, "sync_in_progress.lock")


def is_sync_running() -> bool:
    """True while this worker or any other one is running a sync."""
    return sync_running or os.path.exists(SYNC_IN_PROGRESS_FILE)


# Catalog GETs tagged with ?dv= become cacheable by EdgeOne and browsers (see
# catalog_cache.py). The lambdas read module state lazily.
data_version = make_data_version(
    db_path=os.path.abspath(engine.url.database or ""),
    read_epoch=read_solver_cache_epoch,
    sync_running=is_sync_running,
    stamp=code_stamp(_BACKEND_DIR),
    extra=lambda: f"{build_images.available()}|{arena.db_stamp()}",
)


_bg_sync_task: asyncio.Task | None = None


async def _run_sync_once() -> bool:
    """Run sync_tarkov_dev.py in a thread pool so the event loop stays unblocked."""
    global sync_running, last_sync_at
    if sync_running:
        _logger.info("Hyperactive sync skipped - previous run still in progress.")
        return False
    sync_running = True
    try:
        open(SYNC_IN_PROGRESS_FILE, "w").close()  # broadcast to all workers
        sync_script = os.path.join(_BACKEND_DIR, "sync_tarkov_dev.py")
        loop = asyncio.get_event_loop()
        ret = await loop.run_in_executor(
            None,
            lambda: subprocess.run([sys.executable, sync_script], timeout=600).returncode,
        )
        if ret == 0:
            last_sync_at = time.time()
            clear_solver_caches()
            _logger.info("Hyperactive sync completed.")
            return True
        _logger.error("Hyperactive sync exited with code %s.", ret)
        return False
    except Exception as exc:
        _logger.error("Hyperactive sync failed: %s", exc)
        return False
    finally:
        sync_running = False
        if os.path.exists(SYNC_IN_PROGRESS_FILE):
            os.remove(SYNC_IN_PROGRESS_FILE)


async def _bg_hyperactive_sync():
    """Background loop: while hyperactive mode is on, re-sync every 30 minutes.
    Triggers an immediate sync as soon as the mode is enabled."""
    while True:
        if not hyperactive_mode:
            # Idle - wait indefinitely until the admin enables the mode.
            await sync_trigger.wait()
            sync_trigger.clear()
            continue
        # Hyperactive mode is active: sync now, then wait the interval.
        await _run_sync_once()
        try:
            await asyncio.wait_for(
                sync_trigger.wait(),
                timeout=float(SYNC_INTERVAL_HYPERACTIVE_SECS),
            )
            sync_trigger.clear()
        except asyncio.TimeoutError:
            pass
        # Loop back - if mode was disabled while waiting, the next iteration idles.


def start_background_sync() -> None:
    global _bg_sync_task
    # Remove a stale in-progress lock left by a previous crash.
    if os.path.exists(SYNC_IN_PROGRESS_FILE):
        os.remove(SYNC_IN_PROGRESS_FILE)
    _bg_sync_task = asyncio.create_task(_bg_hyperactive_sync())
