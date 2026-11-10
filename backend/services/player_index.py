"""Atlas' own player index: account ID to current nickname, per game mode, so a nickname search on
the players page can go straight to the account without asking the game.

It learns from use: every profile Atlas looks up and every player a live search lists is recorded
with the name it has now (record). Names are unique within a mode, so recording a name also drops
any other account the index still had under it: a rename sorts itself out on the next lookup.

tarkov.dev's own index (players.tarkov.dev/<mode>/index.json, every account their lookups have
seen) is the head start: a mode is seeded from it once, the first time it has none (seed), and
seeding only ever adds accounts we haven't seen ourselves, so it never overrides what Atlas
learned. We don't depend on it after that. Our requests name Atlas in their User-Agent: the files
are open to any client that sends its own. reseed() runs the import again by hand.

PvP's index holds about three million accounts, nearly all of them long gone: only about 4% were
refreshed on tarkov.dev in the last 180 days (2026-11-10). So a mode in SEED_MAX_AGE_DAYS keeps only
the accounts its updated.json says were refreshed within that many days. Both files are read as
a stream, never whole (PvP's updated.json is about 70 MB), so the import holds just the kept IDs.

The index is only a shortcut. A name it doesn't know still goes to the game's own search, the
players page asks the game again when the profile it opened has another name, and the ban guess
always searches live, since a list can't say what the game's search leaves out. Key holders with
the lookup scope get it in tarkov.dev's shape (export, routers/atlas_lookup.py's /atlas/api/players).
"""

import asyncio
import codecs
import json
import logging
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request

from config import RUNTIME_DIR

_logger = logging.getLogger(__name__)

SOURCE_URL = "https://players.tarkov.dev"
USER_AGENT = "Atlas/1.0 (+https://www.eftforge.com/atlas)"
# Atlas' lookup modes and the folder tarkov.dev keeps each one's index in
SOURCE_PATHS = {"season": "pvp-season", "pvp": "profile", "pve": "pve", "arena": "arena"}
SEED_MODES = tuple(
    m
    for m in (s.strip() for s in os.environ.get("ATLAS_PLAYER_INDEX_SEED_MODES", "season,pve,arena,pvp").split(","))
    if m in SOURCE_PATHS
)
# Modes seeded with only the accounts tarkov.dev refreshed within this many days
SEED_MAX_AGE_DAYS = {"pvp": 180}
MAX_BYTES = 256 * 2**20
CHUNK_BYTES = 2**20
TIMEOUT_SECONDS = 300
SEEDED, ATLAS = "tarkov.dev", "atlas"

_DB_PATH = os.path.join(RUNTIME_DIR, "player_index.sqlite3")
_schema_lock = threading.Lock()
_schema_ready = False


def _connect() -> sqlite3.Connection:
    global _schema_ready
    con = sqlite3.connect(_DB_PATH, timeout=10, isolation_level=None)
    if not _schema_ready:
        with _schema_lock:
            con.execute("PRAGMA journal_mode=WAL")
            # the first, never deployed layout (a daily copy of tarkov.dev's index) had no source;
            # its rows were only that copy, so it goes and gets seeded again
            columns = {row[1] for row in con.execute("PRAGMA table_info(players)")}
            if columns and "source" not in columns:
                con.execute("DROP TABLE players")
                con.execute("DROP TABLE IF EXISTS refreshed")
            # seen: when Atlas last saw the account under this name (ms), 0 for a seeded one
            con.execute(
                "CREATE TABLE IF NOT EXISTS players (mode TEXT NOT NULL, account_id TEXT NOT NULL,"
                " nickname TEXT NOT NULL, name_key TEXT NOT NULL, source TEXT NOT NULL,"
                " seen INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (mode, account_id))"
            )
            con.execute("CREATE INDEX IF NOT EXISTS players_name ON players (mode, name_key)")
            con.execute("CREATE TABLE IF NOT EXISTS seeded (mode TEXT PRIMARY KEY, at REAL NOT NULL, count INTEGER)")
            _schema_ready = True
    return con


def _write(fn) -> None:
    con = _connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        try:
            fn(con)
            con.execute("COMMIT")
        except BaseException:
            con.execute("ROLLBACK")
            raise
    finally:
        con.close()


def find(mode: str, nickname: str) -> list[dict]:
    """The accounts the index holds under this nickname in this mode (case ignored), as the
    game's search lists players: [{"accountId", "nickname"}]. Empty when it doesn't know it."""
    if mode not in SOURCE_PATHS or not os.path.exists(_DB_PATH):
        return []
    con = _connect()
    try:
        rows = con.execute(
            "SELECT account_id, nickname FROM players WHERE mode = ? AND name_key = ? ORDER BY account_id",
            (mode, nickname.lower()),
        ).fetchall()
    finally:
        con.close()
    return [{"accountId": a, "nickname": n} for a, n in rows]


def _valid(account_id, nickname) -> bool:
    return isinstance(account_id, str) and account_id.isdigit() and isinstance(nickname, str) and bool(nickname)


def record(mode: str, players) -> None:
    """What Atlas just saw: (account ID, nickname) pairs from a profile or a live search. Each
    becomes the account's name, and any other account still listed under that name loses it."""
    seen = [(str(a), n) for a, n in players if _valid(str(a), n)]
    if mode not in SOURCE_PATHS or not seen:
        return
    now = int(time.time() * 1000)

    def write(con):
        for account_id, nickname in seen:
            key = nickname.lower()
            con.execute(
                "DELETE FROM players WHERE mode = ? AND name_key = ? AND account_id != ?", (mode, key, account_id)
            )
            con.execute(
                "INSERT OR REPLACE INTO players VALUES (?, ?, ?, ?, ?, ?)",
                (mode, account_id, nickname, key, ATLAS, now),
            )

    try:
        _write(write)
    except sqlite3.Error as exc:
        # a lookup never fails over the index; it just isn't learned from this time
        _logger.warning("player index: couldn't record %d %s players: %s", len(seen), mode, exc)


def seed(mode: str, pairs) -> int:
    """Add (account ID, nickname) pairs from an index.json for every account we don't know yet,
    and note the mode as seeded; returns how many were added. Accounts Atlas has seen keep their
    names, and a seeded name that belongs to one of them isn't added again."""
    rows = [(mode, a, n, n.lower(), SEEDED, 0) for a, n in pairs if _valid(a, n)]
    added = [0]

    def write(con):
        before = con.execute("SELECT COUNT(*) FROM players WHERE mode = ?", (mode,)).fetchone()[0]
        con.executemany(
            "INSERT OR IGNORE INTO players SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS"
            " (SELECT 1 FROM players WHERE mode = ?1 AND name_key = ?4 AND source = 'atlas')",
            rows,
        )
        added[0] = con.execute("SELECT COUNT(*) FROM players WHERE mode = ?", (mode,)).fetchone()[0] - before
        con.execute("INSERT OR REPLACE INTO seeded VALUES (?, ?, ?)", (mode, time.time(), added[0]))

    _write(write)
    return added[0]


def was_seeded(mode: str) -> bool:
    if not os.path.exists(_DB_PATH):
        return False
    con = _connect()
    try:
        return con.execute("SELECT 1 FROM seeded WHERE mode = ?", (mode,)).fetchone() is not None
    finally:
        con.close()


# The index for key holders, in tarkov.dev's own shape so a tool reading theirs reads ours:
# index.json is {account ID: nickname}, updated.json {account ID: when Atlas last saw it, Unix ms},
# the latter only for accounts Atlas has seen itself (a seeded one has no such time). Each file is
# built at most once per EXPORT_MAX_AGE and then served as is.
EXPORTS = ("index", "updated")
EXPORT_DIR = os.path.join(RUNTIME_DIR, "player_index_export")
EXPORT_MAX_AGE = 3600
_export_lock = threading.Lock()


def export(mode: str, kind: str) -> str:
    """The path of this mode's index.json or updated.json, built again once it's EXPORT_MAX_AGE old."""
    # the file name is built from our own names for the mode and kind, never the caller's text,
    # so nothing a request sends can steer the path
    mode = next((m for m in SOURCE_PATHS if m == mode), None)
    kind = next((k for k in EXPORTS if k == kind), None)
    if mode is None or kind is None:
        raise ValueError("no such export")
    path = os.path.join(EXPORT_DIR, f"{mode}-{kind}.json")
    with _export_lock:
        try:
            if time.time() - os.path.getmtime(path) < EXPORT_MAX_AGE:
                return path
        except OSError:
            pass
        os.makedirs(EXPORT_DIR, exist_ok=True)
        query = (
            "SELECT account_id, nickname FROM players WHERE mode = ?"
            if kind == "index"
            else "SELECT account_id, seen FROM players WHERE mode = ? AND source = 'atlas'"
        )
        tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
        con = _connect()
        try:
            # written a row at a time, in account ID order like tarkov.dev's, never held whole
            with open(tmp, "w", encoding="utf-8") as f:
                f.write("{")
                rows = con.execute(query + " ORDER BY CAST(account_id AS INTEGER)", (mode,))
                for n, (account_id, value) in enumerate(rows):
                    f.write(("," if n else "") + json.dumps(account_id) + ":" + json.dumps(value, ensure_ascii=False))
                f.write("}")
        finally:
            con.close()
        os.replace(tmp, path)
    return path


# One entry of a flat JSON object keyed by account ID: "<digits>": "<string>" or <number>
_ENTRY_RE = re.compile(r'"(\d+)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?)')


def _stream(mode: str, name: str):
    """(account ID, value) for each entry of tarkov.dev's <mode>/<name>.json, read a chunk at a
    time, so a file of millions of entries never sits in memory whole."""
    url = f"{SOURCE_URL}/{SOURCE_PATHS[mode]}/{name}.json"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res:
        yield from parse_entries(iter(lambda: res.read(CHUNK_BYTES), b""), url)


def parse_entries(chunks, what: str = "index"):
    """(account ID, value) from the chunks of a flat JSON object keyed by account ID. An entry
    split across two chunks is read once the next one arrives: each pass stops at the last
    ',"' boundary seen, which no nickname or number contains, and the decoder keeps a character
    split between chunks until its last byte arrives."""
    decode = codecs.getincrementaldecoder("utf-8")(errors="replace").decode
    buf, total = "", 0
    for chunk in chunks:
        total += len(chunk)
        if total > MAX_BYTES:
            raise ValueError(f"{what} is over {MAX_BYTES} bytes")
        buf += decode(chunk)
        cut = buf.rfind(',"')
        if cut < 0:
            continue
        for m in _ENTRY_RE.finditer(buf, 0, cut):
            yield m.group(1), json.loads(m.group(2))
        rest = cut + 1
        buf = buf[rest:]
    for m in _ENTRY_RE.finditer(buf):
        yield m.group(1), json.loads(m.group(2))


def fresh_pairs(mode: str):
    """This mode's (account ID, nickname) pairs from tarkov.dev, only the recently refreshed ones
    for a mode in SEED_MAX_AGE_DAYS."""
    max_age = SEED_MAX_AGE_DAYS.get(mode)
    keep = None
    if max_age:
        cutoff = (time.time() - max_age * 86400) * 1000
        keep = {a for a, at in _stream(mode, "updated") if isinstance(at, (int, float)) and at >= cutoff}
    for account_id, nickname in _stream(mode, "index"):
        if keep is None or account_id in keep:
            yield account_id, nickname


def reseed(mode: str) -> int:
    """Import tarkov.dev's index for this mode again, by hand; only accounts we don't know are added."""
    added = seed(mode, fresh_pairs(mode))
    _logger.info("player index: seeded %s with %d accounts from tarkov.dev", mode, added)
    return added


def seed_missing() -> None:
    for mode in SEED_MODES:
        if was_seeded(mode):
            continue
        try:
            reseed(mode)
        except (urllib.error.URLError, TimeoutError, ValueError, sqlite3.Error) as exc:
            # tried again on the next start; the index still learns from lookups meanwhile
            _logger.warning("player index: couldn't seed %s: %s", mode, exc)


_task: asyncio.Task | None = None


def start_player_index() -> None:
    """Seed any mode that hasn't been, once, while lookups are on (ATLAS_LOOKUP_URL set);
    ATLAS_PLAYER_INDEX_SEED=0 skips it."""
    global _task
    if not os.environ.get("ATLAS_LOOKUP_URL", "").strip() or os.environ.get("ATLAS_PLAYER_INDEX_SEED", "1") == "0":
        return
    if not SEED_MODES or (_task and not _task.done()):
        return
    _task = asyncio.create_task(asyncio.to_thread(seed_missing))
