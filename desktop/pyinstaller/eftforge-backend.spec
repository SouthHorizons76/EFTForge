# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the desktop app's backend sidecar.
#
# Deliberately code-only (one ~25 MB exe): the static frontend and the
# tarkov.db snapshot are installed as Tauri resources on disk instead of being
# packed in here, so they aren't re-extracted from the onefile bundle on every
# launch. The Tauri launcher points the exe at them via EFTFORGE_FRONTEND_DIR
# and EFTFORGE_RESOURCE_DIR.
#
# Build via desktop/scripts/build_backend.py (or directly:
#   pyinstaller desktop/pyinstaller/eftforge-backend.spec --noconfirm).

import os

from PyInstaller.utils.hooks import collect_submodules

spec_dir    = os.path.dirname(os.path.abspath(SPEC))
repo_root   = os.path.normpath(os.path.join(spec_dir, "..", ".."))
backend_dir = os.path.join(repo_root, "backend")

a = Analysis(
    [os.path.join(backend_dir, "desktop_main.py")],
    pathex=[backend_dir],
    binaries=[],
    datas=[
        # sync_tarkov_dev._sync_spt_hidden_stats() falls back to this file
        # (looked up next to its own __file__) when SPT_ITEMS_PATH isn't set,
        # which is always true on end-user machines. Frozen modules resolve
        # __file__ to sys._MEIPASS, so the json has to land at the MEIPASS
        # root to be found there.
        (os.path.join(backend_dir, "spt_weapon_stats.json"), "."),
    ],
    hiddenimports=[
        # Imported lazily by desktop_main / desktop.py.
        "main",
        "desktop",
        "sync_tarkov_dev",
        # uvicorn resolves these via string config at runtime.
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.loops.asyncio",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        # scipy 1.18 moved its vendored array_api_compat from scipy._lib to
        # scipy._external; PyInstaller's bundled scipy hook still only lists
        # the old _lib location as a hidden import, so the _external copy
        # (which scipy.optimize actually imports) gets missed and crashes
        # the frozen exe with ModuleNotFoundError. Collect it explicitly
        # until the hook catches up.
        *collect_submodules("scipy._external"),
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        # Server-only: build-card image generation (patchright drives a real
        # browser on prod; in connected mode images come from eftforge.com).
        "patchright",
        "PIL",
        # Dev / prod-only tooling that must not bloat the exe.
        "gunicorn",
        "pytest",
        "black",
        "tkinter",
        # Don't add "unittest" or "pydoc" here even though they look test/dev-
        # only - I tried that and scipy.optimize (needed by optimizer/milp.py)
        # imports both for real at runtime via numpy.testing and
        # scipy._lib._docscrape, not just for tests/interactive help.
        # Excluding either crashes the frozen exe on startup with
        # ModuleNotFoundError before uvicorn ever binds the port.
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="eftforge-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,   # stdout carries the EFTFORGE_PORT handshake; the Tauri
                    # launcher spawns it windowless, manual runs show logs.
    disable_windowed_traceback=False,
)
