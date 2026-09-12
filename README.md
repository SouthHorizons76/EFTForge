<div align="center">

<img src="readme-assets/title.svg" alt="EFTForge" width="301">

**Real-time Escape from Tarkov weapon build simulator and community build sharing platform**

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.100%2B-009688?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![Data: tarkov.dev](https://img.shields.io/badge/Data-tarkov.dev-orange?style=flat-square)](https://tarkov.dev)

[English](README.md) · [中文](README_ZH.md)

</div>

---

## Overview

EFTForge is a full-stack Escape from Tarkov weapon build simulator and community platform. It provides a dual-view visual workbench, real-time stat calculations, live composite build preview images, flea/trader price fetching, a combo calculator, attachment graphing, user profiles, build comments, and a community build publishing system with leaderboards. All item data is sourced from the [tarkov.dev](https://tarkov.dev) JSON API.

---

## Features

### Workbench
- **Grid view** - attachment slots arranged spatially on a 2D canvas mirroring the physical weapon layout (barrel, stock, optics, grip, etc.), grouped into zones (Upper, Lower, Left, Right, Extras)
- **List view** - traditional recursive attachment tree with full slot and allowed-item resolution
- **Build State Intelligence** - gun display name syncs to a saved build name when the installed attachments match it exactly
- **Build Image Export** - Export button in the workbench toolbar renders the current build to a PNG for saving or sharing

### Slot Selector
- **Attachment Favorites** - star button on each attachment row to bookmark items; favorites sort to the top and can be filtered via a header toggle; stored in localStorage
- **Combo Calculator** - BFS search across all valid attachment combinations for a slot, ranked by a chosen stat; results stream live with a progress indicator; installs the full combination in one click
- **Attachment Graph** - scatter plot of all attachments for the current slot on two configurable axes (V-Recoil, H-Recoil, Ergo, Recoil Modifier); zoom, pan, cluster cycling; custom cross-weapon graphs; exportable at 4x resolution

### Optimizer
Constraint-based weapon build solver (MILP, HiGHS backend) that fills every attachment slot at once instead of tuning one at a time.
- **Optimize mode** - weighted priorities (Ergonomics, or EvoErgo, Recoil, Price) via sliders or a triangle control, plus hard constraints: budget limit, min ergonomics, max weight, min magazine capacity, min sighting range, max MOA, suppressor requirement, and prevent overswing
- **Attachment Filtering** - force-include or ban specific mods, then re-optimize; results can also be locked or banned per part directly from the build manifest
- **Weight presets** - save and reuse custom priority-slider setups, alongside built-in presets (Balanced, Min. operable, Performance, Recoil+, Ergo+)
- **Explore mode** - generate alternative builds for the selected weapon across ergonomics/recoil, ergonomics/price, or recoil/price tradeoffs. Adjust sampling resolution, select a point to inspect its parts, and apply it to the workbench. Uses the configured constraints, attachment filters, and trader access; incomplete searches retain available builds.
- **Receiver vs. Factory Preset costing** - compares buying the base receiver against buying the weapon's factory preset, and prices the result off whichever is cheaper
- Respects the same trader loyalty levels, flea market toggle, and player level filters as the rest of the app
- See [Credits & Acknowledgements](#credits--acknowledgements) for the original creator of the optimizer feature

### Stat Calculation
- Real-time stats: ergonomics, recoil, weight, arm stamina, sighting range, etc.
- Full magazine ammo weight modeling
- Real attachment conflict detection (`conflictingItems` + `conflictingSlotIds`)

### Live Build Preview
- Composite gun image generated in real-time as attachments are added or removed
- Powered by [image-gen.tarkov-changes.com](https://image-gen.tarkov-changes.com) via a backend Playwright proxy
- Server-side result cache (up to 500 entries)
- Factory configs and bare guns use static tarkov.dev images directly
- Preview toggle to disable generation when the service is slow or unavailable

### Price System
- Per-item cost breakdown for every attachment in the current build
- Cheapest source auto-selected between trader and flea market
- PvP / PvE flea price cache toggle (separate caches, no re-fetch on switch)
- Per-trader loyalty level gating (LL1-4) for Prapor, Skier, Peacekeeper, Mechanic, and Jaeger
- Price chips visible in the attachment table at a glance
- Attachment selector **Buyable** filter - hides attachments your traders cannot currently sell
- Quest unlock notes on attachments that require completing a trader task

### Stat Tracker
- Surfaces item stat changes detected automatically during daily server data syncs
- Each entry shows old/new values, percentage change, and the date detected
- Covers a rolling 7-day window, grouped by date
- Panel header shows when the data was last synced

### User Profiles
- Quasi-local identity system: your profile token lives in localStorage with no registration, password, or email required
- Upload or update an avatar (resized to 128x128 JPEG, stored server-side)
- Edit your display name; author avatar and name appear on every community build card
- Account transfer flow to relink builds and comments when moving to a new device or browser

### Community Platform
- Publish, browse, and load community-submitted builds
- Auto-generated composite preview images and profile avatars hosted on Gitee [https://gitee.com/morph1ne/eftforge-assets/](https://gitee.com/morph1ne/eftforge-assets/)
- **Build Comments** - per-build comment thread; deletable by the author or an admin
- **Build Tags** - up to 5 preset tags per build (e.g. Budget, Recoil, Meta); tag filter row in the community list collapses automatically when no filters are active
- **My Community Builds** tab in the builds dialog to view and reload your own published builds
- Voting (like/dislike) on builds and individual attachments
- **Leaderboard** - top 10 trending / top 50 all-time for builds; top 20 / top 100 for attachments; filterable and sortable
- Featured build system curated by admins
- Build load count tracking
- In-app notifications for admin moderation actions
- Admin tools: feature, unlist, ban, comment moderation, announcements

### Build Management
- Local saved builds (up to 500 per device)
- Build serialization and LZ-String compression for build sharing and `?build=` URL codes
- Session restore on page reload - recovers your last active build state automatically
- Deep link support: external tools can pre-load a build directly via the `?build=` query parameter

### Localization
- English and Chinese (Simplified) with automatic fallbacks
- Chinese item name translations stored alongside source data

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python, FastAPI, SQLAlchemy, SQLite, Pydantic, Uvicorn |
| Frontend | Vanilla JavaScript (ES2022), modular architecture |
| Image Generation | Playwright / Patchright (headless browser proxy) |
| Asset Hosting | Gitee (community build card images, profile avatars) |
| Data Source | tarkov.dev JSON API |
| Compression | LZ-String |
| Markdown | marked.js |

---

## Desktop App

EFTForge is also available as a downloadable Windows app - the same workbench and stat calculations running natively on your machine via a local backend, with an optional connection to the live community servers. Useful if you're far from our hosting or have a slow connection to it, or if you just want everything to keep working when the site's services are temporarily down (community features excluded until it's back). Note that an internet connection is still required either way, since item data and images are fetched directly from [tarkov.dev](https://tarkov.dev), independent of EFTForge.com.

- **Download:** [GitHub Releases](https://github.com/SouthHorizons76/EFTForge/releases) - or the [Gitee mirror](https://gitee.com/morph1ne/eftforge-gitee-mirror/releases) if GitHub is slow or blocked for you
- **Details:** see [desktop/README.md](desktop/README.md) for architecture, local development, and build instructions

---

## Getting Started

### Prerequisites

- Python 3.10+
- A modern web browser (Chrome, Firefox, Edge, etc.)

---

### 1. Clone the repository

```bash
git clone https://github.com/SouthHorizons76/EFTForge.git
cd EFTForge
```

---

### 2. Configure `launch.bat`

Open `launch.bat` in a text editor before running anything.

**Browser path** - the launcher opens browser tabs automatically. The default path targets Chrome on Windows. If you use a different browser, update this line:

```bat
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --new-window ...
```

Examples for other browsers:
```bat
# Firefox
start "" "C:\Program Files\Mozilla Firefox\firefox.exe" -new-window ...

# Microsoft Edge
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --new-window ...
```

**Install Python dependencies** inside the `backend/` folder:

```bash
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
cd ..
```

---

### 3. Set up your `.env`

```bash
cd backend
copy .env.example .env
```

Edit `backend/.env`. These two variables are **required** - the server will refuse to start without them:

```env
IP_HASH_SECRET=any-random-string-here
ADMIN_API_KEY=your-admin-key-here
```

For local development any non-empty values work. For production use strong random values (`openssl rand -hex 32`).

Full `.env` reference (all optional except the two above):

```env
DATABASE_URL=sqlite:///./tarkov.db
RATINGS_DB_URL=sqlite:///./ratings.db
BUILDS_DB_URL=sqlite:///./builds.db
CORS_ORIGINS=http://127.0.0.1:5500
ENABLE_API_DOCS=0            # set to 1 to enable /docs and /redoc
TRUSTED_PROXY_IPS=127.0.0.1,::1

# Community build image generation (optional, used only on live prod.)
GITEE_TOKEN=                 # Gitee personal access token for uploading build card images
GITEE_DRY_RUN=0              # set to 1 to simulate uploads without writing to Gitee
DISABLE_BG_MIGRATE=0         # set to 1 to disable the background image migration worker
```

---

### 4. Run `launch.bat`

```bat
launch.bat
```

This single .bat file will:
- **First run**: build the database and sync all item data from tarkov.dev before starting, since there's nothing to serve yet
- **Subsequent runs**: start the FastAPI backend immediately against your existing local database, then re-sync tarkov.dev data in the background
- Start the FastAPI backend at `http://127.0.0.1:8000`
- Serve the frontend at `http://127.0.0.1:5500`
- Open your browser to both

The site is usable as soon as the backend console shows **"Application startup complete"**. If the background sync finds new data, a toast prompts you to refresh; otherwise nothing changes and you keep working on the data you already had. That's it!

> **Note:** `sync_tarkov_dev.py` is called automatically by launch.bat, which calls reset.py. Avoid running it directly during local development, it is only used on the live production server for manual out-of-cycle resyncs.

---

## API Overview

The backend runs at `http://127.0.0.1:8000` by default. Interactive docs are available at `/docs` when `ENABLE_API_DOCS=1` is set in `.env`.

| Group | Endpoints |
|---|---|
| Items | `GET /guns`, `GET /ammo/{caliber}`, `GET /items/{id}/slots`, `GET /slots/{id}/allowed-items`, `GET /graph/searchable-items` |
| Build | `POST /build/validate`, `POST /build/calculate`, `POST /build/batch-process`, `POST /build/combo-batch-process`, `POST /build/combo-full`, `GET /guns/{gun_id}/init` |
| Optimizer | `POST /build/optimize`, `POST /build/stat-ranges`, `POST /build/moa-floor`, `GET /build/mods`, `GET /build/default-preset`, `GET /build/gunsmith-tasks`, `POST /build/gunsmith-solve` |
| Image Gen | `POST /build-image` |
| Ratings | `GET /ratings/attachments/bulk`, `POST /ratings/attachments/{id}/vote`, `DELETE /ratings/attachments/{id}/vote`, `GET /ratings/builds/bulk`, `POST /ratings/builds/{id}/vote` |
| Community Builds | `POST /builds/publish`, `GET /builds/public`, `GET /builds/mine`, `POST /builds/{id}/load`, `DELETE /builds/{id}` |
| Comments | `GET /builds/{id}/comments`, `POST /builds/{id}/comments`, `DELETE /builds/{id}/comments/{comment_id}` |
| Profile | `POST /profile/avatar`, `POST /profile/update`, `POST /profile/transfer/preview`, `POST /profile/transfer` |
| Notifications | `GET /builds/notifications`, `GET /announcements` |
| Stat Tracker | `GET /stat-changelog` |
| Health | `GET /health` |
| Admin | Build management, comment moderation, author management, ban system, announcements, migration tools |

---

## External Integration

External tools can deep-link directly into EFTForge with a pre-loaded build via the `?build=` URL parameter:

```
https://eftforge.com/?build=<lzstring_encoded_code>
```

The build code is a LZ-String compressed, URL-safe encoded JSON payload:

```json
{ "v": 1, "g": "<gunId>", "p": [["slotId", "itemId"], ...], "a": "<ammoId>" }
```

EFTForge will auto-load the build on page load and strip the parameter from the URL. Item IDs must match EFTForge's internal tarkov.dev item IDs.

---

## Credits & Acknowledgements

The EvoErgo concept was originally developed by **SpaceMonkey37**. EFTForge implements and expands upon this system in a live simulation environment. This project would not have been possible without SpaceMonkey37's foundational theory.

The constraint-based build optimizer (MILP solver, priority weighting, budget/trader-level filtering) is a native reimplementation inspired by **AhaiMk01**'s [Tarkov Weapon Mod Optimizer](https://github.com/AhaiMk01/tarkov-weapon-optimizer).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local dev setup, lint/test commands, and code style. Security vulnerabilities should be reported per [SECURITY.md](SECURITY.md) rather than as public issues.

---

## License

MIT - see [LICENSE](LICENSE) for details.

---

## Disclaimer

EFTForge is a fan-made project and is not affiliated with Battlestate Games. All game data is sourced from [tarkov.dev](https://tarkov.dev).
