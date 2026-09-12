"""Measure backend memory on Windows without starting a server or modifying live databases.

Run from the repository root with backend/venv/Scripts/python.exe
backend/benchmarks/memory_profile.py --help for the available cases and options.
Use a fresh process per case. Tracing adds overhead; compare OS memory without it.
Only the flea case downloads public data; all other cases use local game data.
"""

import argparse
import asyncio
import ctypes
from ctypes import wintypes
from contextlib import contextmanager
import gc
import json
import os
from pathlib import Path
import sys
import shutil
import time
import tracemalloc
import uuid


@contextmanager
def audit_runtime(root):
    path = root.resolve() / (".memory-audit-" + uuid.uuid4().hex)
    path.mkdir()
    try:
        yield str(path)
    finally:
        if path.resolve().parent != root.resolve():
            raise RuntimeError("Audit runtime escaped the workspace")
        shutil.rmtree(path)


class ProcessMemory(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
        (name, ctypes.c_size_t)
        for name in (
            "PeakWorkingSetSize",
            "WorkingSetSize",
            "QuotaPeakPagedPoolUsage",
            "QuotaPagedPoolUsage",
            "QuotaPeakNonPagedPoolUsage",
            "QuotaNonPagedPoolUsage",
            "PagefileUsage",
            "PeakPagefileUsage",
            "PrivateUsage",
        )
    ]


def memory(stage, **extra):
    counters = ProcessMemory()
    counters.cb = ctypes.sizeof(counters)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessMemory), wintypes.DWORD]
    if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
        raise ctypes.WinError(ctypes.get_last_error())
    result = {"stage": stage, **extra}
    for label, field in (
        ("working_set_mib", "WorkingSetSize"),
        ("private_mib", "PrivateUsage"),
        ("lifetime_peak_working_set_mib", "PeakWorkingSetSize"),
    ):
        result[label] = round(getattr(counters, field) / 1048576, 3)
    if tracemalloc.is_tracing():
        current, peak = tracemalloc.get_traced_memory()
        result.update(python_current_mib=round(current / 1048576, 3), python_peak_mib=round(peak / 1048576, 3))
    print(json.dumps(result), flush=True)


def deep_size(value):
    seen = set()

    def visit(obj):
        if id(obj) in seen:
            return 0
        seen.add(id(obj))
        total = sys.getsizeof(obj)
        if isinstance(obj, dict):
            total += sum(visit(k) + visit(v) for k, v in obj.items())
        elif isinstance(obj, (list, tuple, set, frozenset)):
            total += sum(visit(v) for v in obj)
        return total

    return visit(value)


async def consume(response):
    total = 0
    async for chunk in response.body_iterator:
        total += len(chunk.encode("utf-8") if isinstance(chunk, str) else chunk)
    return total


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=("stock", "receiver", "optimizer", "gun-init", "flea"), default="stock")
    parser.add_argument("--blas-threads", type=int)
    parser.add_argument("--trace", action="store_true")
    parser.add_argument("--runs", type=int, default=3)
    args = parser.parse_args()
    if args.blas_threads is not None:
        os.environ["OPENBLAS_NUM_THREADS"] = str(args.blas_threads)
    if sys.platform != "win32":
        parser.error("Use Windows for the process memory counters.")
    backend = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(backend))
    os.environ.update(EFTFORGE_DESKTOP="0", IP_HASH_SECRET="memory-audit-only", ADMIN_API_KEY="memory-audit-only")
    for name in ("DATABASE_URL", "RATINGS_DB_URL", "BUILDS_DB_URL", "CHANGELOG_DB_URL"):
        os.environ[name] = "sqlite://"
    if args.trace:
        tracemalloc.start(1)
    memory(
        "python",
        python=sys.version,
        case=args.case,
        logical_cpus=os.cpu_count(),
        openblas_num_threads=os.environ.get("OPENBLAS_NUM_THREADS"),
    )
    if args.case == "flea":
        import requests

        for mode in ("regular", "pve"):
            with requests.get(f"https://json.tarkov.dev/{mode}/items", stream=True, timeout=60) as response:
                response.raise_for_status()
                raw = bytearray()
                for chunk in response.iter_content(1048576):
                    raw.extend(chunk)
                    if len(raw) > 256 * 1048576:
                        raise RuntimeError("Public response exceeded the 256 MiB audit limit")
            payload = json.loads(raw)
            items = payload.get("data", {}).get("items", {})
            prices = {item["id"]: item.get("avg24hPrice") for item in items.values()}
            memory(
                "public_flea_payload",
                mode=mode,
                decompressed_bytes=len(raw),
                items=len(items),
                payload_deep_mib=round(deep_size(payload) / 1048576, 3),
                price_map_deep_mib=round(deep_size(prices) / 1048576, 3),
                price_map_json_bytes=len(json.dumps(prices).encode("utf-8")),
            )
            del payload, items, raw, prices
            gc.collect()
            memory("public_flea_released", mode=mode)
        return
    import fastapi
    import sqlalchemy

    memory("fastapi_sqlalchemy", fastapi=fastapi.__version__, sqlalchemy=sqlalchemy.__version__)
    import scipy.optimize

    memory("scipy_optimize", scipy=scipy.__version__)
    with audit_runtime(backend.parent) as runtime:
        import config

        config.RUNTIME_DIR = runtime
        import main as api

        memory("main_import")
        from sqlalchemy.orm import Session
        from optimizer.solver import OptimizeParams, optimize_weapon

        database = backend / "tarkov.db"
        engine = sqlalchemy.create_engine(f"sqlite:///file:{database.as_posix()}?mode=ro&uri=true")
        try:
            with engine.connect() as connection:
                counts = {
                    table: connection.exec_driver_sql(f"SELECT count(*) FROM {table}").scalar()
                    for table in ("items", "slots", "slot_allowed_items")
                }
            memory("database_open", database_bytes=database.stat().st_size, counts=counts)
            for run in range(args.runs):
                api._clear_solver_caches()
                gc.collect()
                if args.trace:
                    tracemalloc.reset_peak()
                start = time.perf_counter()
                with Session(engine) as db:
                    if args.case == "gun-init":
                        from models_items import Item

                        ids = [
                            row[0] for row in db.query(Item.id).filter(Item.is_weapon.is_(True)).order_by(Item.id).all()
                        ]
                        payloads = [api.get_gun_init(gun_id, lang="en", db=db) for gun_id in ids]
                        sizes = sorted(len(json.dumps(p).encode("utf-8")) for p in payloads)
                        details = {
                            "gun_count": len(ids),
                            "all_payloads_deep_mib": round(deep_size(payloads) / 1048576, 3),
                            "all_wire_mib": round(sum(sizes) / 1048576, 3),
                            "largest_wire_bytes": sizes[-1],
                        }
                        del payloads
                    elif args.case == "optimizer":
                        result = optimize_weapon(db, "5447a9cd4bdc2dbd208b4567", OptimizeParams())
                        details = {"status": result.get("status"), "metrics": result.get("metrics")}
                        del result
                    else:
                        slot = "55d5a3074bdc2d61338b4574" if args.case == "stock" else "55d5a2ec4bdc2d972f8b4575"
                        response = api.combo_full(
                            "5447a9cd4bdc2dbd208b4567",
                            [],
                            slot,
                            "en",
                            10,
                            0.0,
                            [] if args.case == "stock" else ["Handguard"],
                            [],
                            db,
                            "items-v1",
                        )
                        wire_bytes = asyncio.run(consume(response))
                        del response
                        cached = next(iter(api._COMBO_FULL_CACHE.values()))
                        details = {
                            "wire_bytes": wire_bytes,
                            "metrics": cached["metrics"],
                            "cache_deep_mib": round(deep_size(api._COMBO_FULL_CACHE) / 1048576, 3),
                        }
                        del cached
                gc.collect()
                memory("after_workload", run=run + 1, seconds=round(time.perf_counter() - start, 3), **details)
                api._clear_solver_caches()
                gc.collect()
                memory("after_cache_clear", run=run + 1)
            if args.trace:
                snapshot = tracemalloc.take_snapshot()
                print(json.dumps({"top_retained": [str(s) for s in snapshot.statistics("lineno")[:15]]}), flush=True)
        finally:
            engine.dispose()


if __name__ == "__main__":
    main()
