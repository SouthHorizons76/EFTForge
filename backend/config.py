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
