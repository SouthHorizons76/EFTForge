import os
import sys

# Load .env file if present (dev convenience; prod should set vars directly)
try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

# ---------------------------------------------------------------------------
# Desktop app mode (EFTFORGE_DESKTOP=1)
#
# The packaged desktop app runs this same backend as a local sidecar process.
# Differences from web/dev mode, all resolved here so the rest of the backend
# just reads the usual config values:
#   - All mutable files (SQLite DBs, lock/notice files, settings) live in a
#     single data dir: portable "<exe dir>/data" when writable, otherwise
#     %LOCALAPPDATA%/EFTForge/data as a fallback (e.g. Program Files installs).
#   - IP_HASH_SECRET is generated once and persisted so local votes stay stable.
#   - ADMIN_API_KEY stays empty (admin endpoints 503) and the missing-env guard
#     below is skipped.
# ---------------------------------------------------------------------------
DESKTOP_MODE = os.environ.get("EFTFORGE_DESKTOP", "0") == "1"

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))


def _dir_writable(path: str) -> bool:
    try:
        os.makedirs(path, exist_ok=True)
        probe = os.path.join(path, ".write-probe")
        with open(probe, "w") as f:
            f.write("ok")
        os.remove(probe)
        return True
    except OSError:
        return False


def _resolve_desktop_data_dir() -> str:
    override = os.environ.get("EFTFORGE_DATA_DIR", "").strip()
    if override:
        os.makedirs(override, exist_ok=True)
        return override
    # Portable-first: keep everything next to the executable so an install is
    # fully self-contained and deleting the folder removes every trace.
    exe_dir = os.path.dirname(sys.executable) if getattr(sys, "frozen", False) else _BACKEND_DIR
    portable = os.path.join(exe_dir, "data")
    if _dir_writable(portable):
        return portable
    # Unwritable install location (e.g. Program Files) - fall back to LOCALAPPDATA.
    local_appdata = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    fallback = os.path.join(local_appdata, "EFTForge", "data")
    os.makedirs(fallback, exist_ok=True)
    return fallback


def _sqlite_url(path: str) -> str:
    return "sqlite:///" + path.replace("\\", "/")


if DESKTOP_MODE:
    DATA_DIR = _resolve_desktop_data_dir()
    # Lock/notice/last-sync files written by main.py and the sync scripts.
    RUNTIME_DIR = DATA_DIR
    _default_db_url = _sqlite_url(os.path.join(DATA_DIR, "tarkov.db"))
    _default_ratings_db_url = _sqlite_url(os.path.join(DATA_DIR, "ratings.db"))
    _default_builds_db_url = _sqlite_url(os.path.join(DATA_DIR, "builds.db"))
    _default_changelog_db_url = _sqlite_url(os.path.join(DATA_DIR, "changelog.db"))
else:
    DATA_DIR = _BACKEND_DIR
    RUNTIME_DIR = _BACKEND_DIR
    _default_db_url = "sqlite:///./tarkov.db"
    _default_ratings_db_url = "sqlite:///./ratings.db"
    _default_builds_db_url = "sqlite:///./builds.db"
    _default_changelog_db_url = "sqlite:///./changelog.db"

# Static frontend served by the local backend in desktop mode.
# Resolution: explicit env override -> PyInstaller bundle -> repo checkout.
_frontend_override = os.environ.get("EFTFORGE_FRONTEND_DIR", "").strip()
if _frontend_override:
    FRONTEND_DIR = _frontend_override
elif getattr(sys, "frozen", False):
    FRONTEND_DIR = os.path.join(getattr(sys, "_MEIPASS", _BACKEND_DIR), "frontend")
else:
    FRONTEND_DIR = os.path.normpath(os.path.join(_BACKEND_DIR, "..", "frontend"))

# Live-service origin the desktop app forwards community requests to when the
# user is in "connected" mode. Overridable for testing against a staging box.
# www is the canonical origin - the bare domain 301s to it.
REMOTE_ORIGIN = os.environ.get("EFTFORGE_REMOTE_ORIGIN", "https://www.eftforge.com").rstrip("/")

# Version of the desktop shell (set by the Tauri launcher); used for the
# identifying User-Agent on proxied requests and shown in the settings UI.
DESKTOP_APP_VERSION = os.environ.get("EFTFORGE_APP_VERSION", "dev")

DATABASE_URL = os.environ.get("DATABASE_URL", _default_db_url)

# Comma-separated list of allowed CORS origins, e.g.
#   CORS_ORIGINS=http://localhost:5500,https://myapp.example.com
_raw = os.environ.get("CORS_ORIGINS", "http://127.0.0.1:5500")
CORS_ORIGINS = [o.strip() for o in _raw.split(",") if o.strip()]

# Ratings system
RATINGS_DB_URL = os.environ.get("RATINGS_DB_URL", _default_ratings_db_url)

# Builds / publishing system
BUILDS_DB_URL = os.environ.get("BUILDS_DB_URL", _default_builds_db_url)

# Stat changelog - separate file so it survives tarkov.db resets
CHANGELOG_DB_URL = os.environ.get("CHANGELOG_DB_URL", _default_changelog_db_url)
IP_HASH_SECRET = os.environ.get("IP_HASH_SECRET", "")
ADMIN_API_KEY = os.environ.get("ADMIN_API_KEY", "")


def _load_or_create_secret(filename: str) -> str:
    """Desktop mode: generate a secret once and persist it in the data dir so it
    stays stable across restarts. Never leaves the user's machine."""
    path = os.path.join(DATA_DIR, filename)
    try:
        with open(path, "r", encoding="utf-8") as f:
            value = f.read().strip()
            if value:
                return value
    except OSError:
        pass
    import secrets as _secrets

    value = _secrets.token_hex(32)
    with open(path, "w", encoding="utf-8") as f:
        f.write(value)
    return value


if DESKTOP_MODE:
    # Salted IP hashes keep locally stored votes stable across restarts.
    if not IP_HASH_SECRET:
        IP_HASH_SECRET = _load_or_create_secret("secret.key")
    # The desktop app is the user's own machine and own data - admin endpoints
    # are fair game there (the community proxy never forwards /admin to prod).
    # The key is injected into the frontend so local admin devtools just work.
    if not ADMIN_API_KEY:
        ADMIN_API_KEY = _load_or_create_secret("admin.key")

# Set ENABLE_API_DOCS=1 to re-enable /docs and /redoc (dev only).
# Docs are disabled by default to avoid leaking the full API schema in production.
ENABLE_API_DOCS = os.environ.get("ENABLE_API_DOCS", "0") == "1"

# Gitee personal access token for uploading auto-generated build images.
# Required for the background image migration worker.
GITEE_TOKEN = os.environ.get("GITEE_TOKEN", "")

# Set to 1 to run the migration worker without uploading to Gitee.
# Generates images and logs what would be uploaded, but writes nothing.
GITEE_DRY_RUN = os.environ.get("GITEE_DRY_RUN", "0") == "1"

# Set to 1 to permanently disable the background migration worker.
# Use this once all builds have been migrated.
DISABLE_BG_MIGRATE = os.environ.get("DISABLE_BG_MIGRATE", "0") == "1"

# Comma-separated list of trusted reverse-proxy IPs whose X-Forwarded-For /
# X-Real-IP headers are honoured for client IP detection.
# Example: TRUSTED_PROXY_IPS=127.0.0.1,::1,10.0.0.1
# Leave unset (default) to trust only 127.0.0.1 and ::1.
_proxy_raw = os.environ.get("TRUSTED_PROXY_IPS", "127.0.0.1,::1")
TRUSTED_PROXY_IPS: set[str] = {ip.strip() for ip in _proxy_raw.split(",") if ip.strip()}

# Kitbash! checkout that renders build images in process from baked sprites.
# Unset: use the sibling checkout next to this repo when it exists.
# Empty string: disable it and use the image-gen proxy only.
_kitbash_default = os.path.normpath(os.path.join(_BACKEND_DIR, "..", "..", "Kitbash"))
KITBASH_DIR = os.environ.get("KITBASH_DIR", _kitbash_default).strip()
# Decoded-sprite cache per worker process, in MB.
KITBASH_CACHE_MB = int(os.environ.get("KITBASH_CACHE_MB", "128"))

# Desktop mode self-provisions both secrets above, so the guard only applies
# to web/dev deployments where they must be set explicitly.
_missing = []
if not IP_HASH_SECRET:
    _missing.append("IP_HASH_SECRET is not set - IP hashes are not salted.")
if not ADMIN_API_KEY:
    _missing.append("ADMIN_API_KEY is not set - admin endpoints will return 503.")
if _missing and not DESKTOP_MODE:
    raise RuntimeError("Missing required environment variables:\n" + "\n".join(f"  - {m}" for m in _missing))
