"""Rate and concurrency guards shared by every solver endpoint."""

import contextlib
import hashlib
import os
import time

from fastapi import HTTPException

from config import BETA_MODE, OPTIMIZER_MAX_SOLVES, RUNTIME_DIR
from server_semaphore import server_semaphore

# Solve concurrency guard: an optimizer call can legitimately use up to the shared
# solver's normal 30s budget plus process startup and cleanup. Without
# this, a spammed re-optimize button (or a script hitting these endpoints directly,
# bypassing the frontend's re-click guard) can pile up many overlapping solves on one
# worker's threadpool and starve every other request that worker is handling. Cap it
# to one in-flight solve per IP, plus a server-wide cap across all workers, and fail
# fast with 429 instead of silently queuing behind the threadpool.
#
# The per-IP part has to be a file, not an in-memory set: prod runs one Gunicorn
# worker *process* per CPU core (reset.py), each with its own copy of this module's
# state, so a plain dict/set would only catch a repeat request that happened to land
# on the same worker as the first one. A lock file under RUNTIME_DIR is visible to
# every worker, same as SYNC_IN_PROGRESS_FILE in services/sync.py.
#
# The global cap is shared across workers too. Every solve is a spawned child process
# holding a full core and its own copy of scipy, so a per-worker cap let 2 workers run
# 4 solves on the 2 core / 2 GB prod box and starve every other request.
_SOLVE_LOCK_DIR = os.path.join(RUNTIME_DIR, "solve_locks")
os.makedirs(_SOLVE_LOCK_DIR, exist_ok=True)
_SOLVE_LOCK_STALE_SECONDS = 60
_MAX_CONCURRENT_SOLVES = OPTIMIZER_MAX_SOLVES
_SOLVE_CONCURRENCY_SEM = server_semaphore(_MAX_CONCURRENT_SOLVES, _SOLVE_LOCK_DIR, "slot")


def _ip_solve_lock_path(ip: str) -> str:
    # Hashed rather than the raw IP: keeps filenames filesystem-safe (IPv6 has
    # colons) and avoids writing raw client IPs to disk.
    return os.path.join(_SOLVE_LOCK_DIR, hashlib.sha256(ip.encode()).hexdigest() + ".lock")


def _acquire_ip_solve_lock(ip: str) -> bool:
    """Atomic create-if-absent (O_EXCL) across processes, so two workers racing
    on the same IP can't both win. A lock left behind by a worker that crashed
    mid-solve (instead of releasing normally) self-heals once it goes stale."""
    path = _ip_solve_lock_path(ip)
    for _ in range(2):  # 2nd pass only runs after clearing a stale lock
        try:
            os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            return True
        except FileExistsError:
            try:
                stale = time.time() - os.path.getmtime(path) > _SOLVE_LOCK_STALE_SECONDS
            except OSError:
                continue  # lock vanished between the failed create and this check - retry
            if not stale:
                return False
            try:
                os.remove(path)
            except OSError:
                pass
    return False


def _release_ip_solve_lock(ip: str) -> None:
    try:
        os.remove(_ip_solve_lock_path(ip))
    except OSError:
        pass


# Per-IP request-rate throttle for the solve endpoints, separate from the solve_slot
# guard. An identical-params request that hits OPTIMIZE_CACHE never reaches
# solve_slot at all (there's no solve to serialize) and returns in ~0ms - cheap
# next to a real solve, but not free: every request still opens a DB session and
# runs a real query (the weapon lookup) before the cache check ever runs. Without
# this, an autoclicker spamming the same build would sail past the concurrency
# guard entirely and still generate real per-request DB/HTTP load at whatever
# rate it fires. Same cooldown-dict pattern as the publish and comment cooldowns,
# just keyed by IP instead of client_id_hash since these endpoints don't require
# an X-Client-ID. Checked as the first thing in each endpoint, before any DB work.
_solve_request_last: dict[str, float] = {}
_SOLVE_REQUEST_COOLDOWN = 1.0


def _refuse_in_beta() -> None:
    """The beta shares the 2 core / 2 GB box with the live site, so it never solves:
    one tester's optimizer run would take a core and the memory the live solver needs."""
    if BETA_MODE:
        raise HTTPException(
            status_code=403,
            detail={
                "reason_key": "optimizer.reason.betaDisabled",
                "message": "This feature is disabled on the BETA branch.",
            },
        )


def check_solve_rate_limit(ip: str) -> None:
    _refuse_in_beta()
    now = time.monotonic()
    stale = [k for k, t in _solve_request_last.items() if now - t > _SOLVE_REQUEST_COOLDOWN * 20]
    for k in stale:
        del _solve_request_last[k]
    last = _solve_request_last.get(ip, 0.0)
    if now - last < _SOLVE_REQUEST_COOLDOWN:
        raise HTTPException(
            status_code=429,
            detail={
                "reason_key": "optimizer.reason.tooManyRequests",
                "message": "Too many requests - please slow down.",
            },
        )
    _solve_request_last[ip] = now


@contextlib.contextmanager
def solve_slot(ip: str):
    """detail carries a reason_key (mirroring the optimize result's own
    reason_key/reason_params convention) so the frontend can render a
    translated message instead of this English fallback text."""
    _refuse_in_beta()
    if not _acquire_ip_solve_lock(ip):
        raise HTTPException(
            status_code=429,
            detail={
                "reason_key": "optimizer.reason.alreadySolving",
                "message": "You already have an optimization running - wait for it to finish.",
            },
        )
    try:
        if not _SOLVE_CONCURRENCY_SEM.acquire(blocking=False):
            raise HTTPException(
                status_code=429,
                detail={
                    "reason_key": "optimizer.reason.serverBusy",
                    "message": "Server is busy solving other requests - try again shortly.",
                },
            )
        try:
            yield
        finally:
            _SOLVE_CONCURRENCY_SEM.release()
    finally:
        _release_ip_solve_lock(ip)
