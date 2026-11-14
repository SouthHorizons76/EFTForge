"""The game data snapshots this server runs on, for other copies of EFTForge to follow.

The desktop app checks /snapshots/{game}/index.json every few minutes and downloads the
snapshot it names (services/snapshots.py), so it always runs on the same data as the
live site. Only what this server already uses is published: its newest snapshot.

A snapshot's file is named after the data state it holds and never changes, so a CDN
may keep it for good. The index is tiny and is only cached for a minute.
"""

import os
import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from game_snapshot import SnapshotError, load_snapshot, pick_snapshot_file
from services.snapshots import local_path

router = APIRouter()

_GAMES = ("eft", "arena")
_FILE_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]{0,80}\.json$")
_INDEX_MAX_AGE = 60
_FILE_MAX_AGE = 365 * 24 * 3600


def _current(game: str):
    """(file path, its index entry) of the snapshot this server uses for `game`."""
    if game not in _GAMES:
        raise HTTPException(status_code=404, detail="Not Found")
    path = local_path(game)
    try:
        file_path = pick_snapshot_file(path) if path else None
    except SnapshotError:
        file_path = None
    if not file_path:
        raise HTTPException(status_code=404, detail="no_snapshot")
    name = os.path.basename(file_path)
    entry = None
    if os.path.isdir(path):
        from services.snapshots import _read_index

        entry = next((e for e in _read_index(path) if e.get("file") == name), None)
    if entry is None:
        # A single configured file: describe it from its own header
        try:
            snap = load_snapshot(file_path)
        except SnapshotError:
            raise HTTPException(status_code=404, detail="no_snapshot")
        entry = {k: snap.get(k) for k in ("id", "game", "detected", "version")}
    return file_path, {**entry, "file": name}


@router.get("/snapshots/{game}/index.json")
def snapshot_index(game: str):
    _, entry = _current(game)
    return JSONResponse({"snapshots": [entry]}, headers={"Cache-Control": f"public, max-age={_INDEX_MAX_AGE}"})


@router.get("/snapshots/{game}/{name}")
def snapshot_file(game: str, name: str):
    file_path, entry = _current(game)
    # Only the snapshot in use, by its own name
    if not _FILE_RE.match(name) or name != entry["file"]:
        raise HTTPException(status_code=404, detail="Not Found")
    # Commit-named files never change; a single configured file may be rewritten in place
    immutable = os.path.isdir(local_path(game))
    cache = f"public, max-age={_FILE_MAX_AGE}, immutable" if immutable else f"public, max-age={_INDEX_MAX_AGE}"
    return FileResponse(file_path, media_type="application/json", headers={"Cache-Control": cache})
