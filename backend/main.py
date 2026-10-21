"""EFTForge API: builds the FastAPI app, prepares the databases, and mounts every
router. Endpoints live in routers/, shared logic in services/."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware as GZIPMiddleware

# Import every model module so its tables are registered before prepare_databases() below.
import models_builds  # noqa: F401
import models_item_offers  # noqa: F401
import models_items  # noqa: F401
import models_ratings  # noqa: F401
import models_slot_allowed  # noqa: F401
import models_slots  # noqa: F401
import models_stat_changelog  # noqa: F401
import models_traders  # noqa: F401
import models_weapon_presets  # noqa: F401
from catalog_cache import DATA_VERSION_HEADER, CatalogCacheMiddleware
from config import CORS_ORIGINS, DESKTOP_MODE, ENABLE_API_DOCS, LOCAL_DEV
from db_migrations import prepare_databases
from optimizer.cancellation import SolveCancellationMiddleware
from routers import (
    admin_builds,
    announcements,
    atlas,
    build_calc,
    catalog,
    combo,
    comments,
    community_builds,
    guns,
    images,
    leaderboard,
    moderation,
    optimizer,
    profile,
    proxy,
    ratings,
    stat_changelog,
    system,
)
from services.build_cards import start_card_migration
from services.community_proxy import add_dev_connected_middleware
from services.solver_cache import clear_solver_caches
from services.sync import data_version, start_background_sync

_docs_url = "/docs" if ENABLE_API_DOCS else None
_redoc_url = "/redoc" if ENABLE_API_DOCS else None
_openapi_url = "/openapi.json" if ENABLE_API_DOCS else None

app = FastAPI(title="EFTForge API", docs_url=_docs_url, redoc_url=_redoc_url, openapi_url=_openapi_url)
# Local dev connected mode (DEV modal). Added first so it sits inside CORS and
# the forwarded responses still get our CORS headers.
if LOCAL_DEV:
    add_dev_connected_middleware(app)
app.add_middleware(SolveCancellationMiddleware)
app.add_middleware(GZIPMiddleware, minimum_size=500)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "X-Admin-Key", "X-Client-ID"],
    expose_headers=[DATA_VERSION_HEADER],
)
# Catalog GETs tagged with ?dv= become cacheable by EdgeOne and browsers (see
# catalog_cache.py and services/sync.py).
app.add_middleware(CatalogCacheMiddleware, data_version=data_version)


def _desktop_status(code: str) -> None:
    # Picked up by the Tauri launcher and forwarded to the splash screen -
    # see backend/desktop_main.py and ui-shell/index.html.
    if DESKTOP_MODE:
        print(f"EFTFORGE_STATUS={code}", flush=True)


prepare_databases(status=_desktop_status)


@app.on_event("startup")
async def _on_startup():
    start_background_sync()
    start_card_migration()


# Kept in the order the routes used to be declared in, so path matching stays the same.
for _module in (
    system,
    proxy,
    catalog,
    guns,
    build_calc,
    combo,
    optimizer,
    ratings,
    images,
    admin_builds,
    profile,
    community_builds,
    comments,
    moderation,
    announcements,
    leaderboard,
    stat_changelog,
    atlas,
):
    app.include_router(_module.router)


# ---------------------------------------------------
# Desktop app mode - must stay at the very bottom: the static-frontend mount
# it registers is a catch-all, so every API route has to be defined first.
# ---------------------------------------------------

if DESKTOP_MODE:
    from desktop import init_desktop

    def _desktop_clear_caches():
        clear_solver_caches()

    init_desktop(app, clear_caches=_desktop_clear_caches)
