import os

# Load .env file if present (dev convenience; prod should set vars directly)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./tarkov.db")

# Comma-separated list of allowed CORS origins, e.g.
#   CORS_ORIGINS=http://localhost:5500,https://myapp.example.com
_raw = os.environ.get("CORS_ORIGINS", "http://127.0.0.1:5500")
CORS_ORIGINS = [o.strip() for o in _raw.split(",") if o.strip()]

# Ratings system
RATINGS_DB_URL = os.environ.get("RATINGS_DB_URL", "sqlite:///./ratings.db")

# Builds / publishing system
BUILDS_DB_URL = os.environ.get("BUILDS_DB_URL", "sqlite:///./builds.db")
IP_HASH_SECRET = os.environ.get("IP_HASH_SECRET", "")
ADMIN_API_KEY  = os.environ.get("ADMIN_API_KEY",  "")

# Set ENABLE_API_DOCS=1 to re-enable /docs and /redoc (dev only).
# Docs are disabled by default to avoid leaking the full API schema in production.
ENABLE_API_DOCS = os.environ.get("ENABLE_API_DOCS", "0") == "1"

# Comma-separated list of trusted reverse-proxy IPs whose X-Forwarded-For /
# X-Real-IP headers are honoured for client IP detection.
# Example: TRUSTED_PROXY_IPS=127.0.0.1,::1,10.0.0.1
# Leave unset (default) to trust only 127.0.0.1 and ::1.
_proxy_raw = os.environ.get("TRUSTED_PROXY_IPS", "127.0.0.1,::1")
TRUSTED_PROXY_IPS: set[str] = {ip.strip() for ip in _proxy_raw.split(",") if ip.strip()}

_missing = []
if not IP_HASH_SECRET:
    _missing.append("IP_HASH_SECRET is not set - IP hashes are not salted.")
if not ADMIN_API_KEY:
    _missing.append("ADMIN_API_KEY is not set - admin endpoints will return 503.")
if _missing:
    raise RuntimeError(
        "Missing required environment variables:\n" + "\n".join(f"  - {m}" for m in _missing)
    )
