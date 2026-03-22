import os
import warnings

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

if not IP_HASH_SECRET:
    warnings.warn("IP_HASH_SECRET is not set - IP hashes are not salted. Set this in production.")
if not ADMIN_API_KEY:
    warnings.warn("ADMIN_API_KEY is not set - admin endpoints will return 503. Set this in production.")
