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

EFTForge is a full-stack Escape from Tarkov weapon build simulator and community platform. It provides a dual-view visual workbench, real-time stat calculations, live composite build preview images, flea/trader price fetching, and a community build publishing system with leaderboards. All item data is sourced from the [tarkov.dev](https://tarkov.dev) GraphQL API.

---

## Features

### Workbench
- **Grid view** - attachment slots arranged spatially on a 2D canvas mirroring the physical weapon layout (barrel, stock, optics, grip, etc.), grouped into zones (Upper, Lower, Left, Right, Extras)
- **List view** - traditional recursive attachment tree with full slot and allowed-item resolution
- Factory preset auto-install simulation
- Build State Intelligence - gun display name syncs to a saved build name when the installed attachments match it exactly

### Stat Calculation
- Real-time stats: ergonomics, recoil, weight, arm stamina, sighting range
- Full magazine ammo weight modeling
- EvoErgo Engine: arm stamina drain, EvoErgoDelta, OverSwing
- **16 hidden per-weapon stats** sourced from tarkov.dev + SPT game files: aim deviation, recoil angle, camera snap, recoil dispersion, recoil return speed, mount recoil multipliers, and more
- Real attachment conflict detection (`conflictingItems` + `conflictingSlotIds`)

### Live Build Preview
- Composite gun image generated in real-time as attachments are added or removed
- Powered by [image-gen.tarkov-changes.com](https://image-gen.tarkov-changes.com/build) via a backend Playwright proxy
- Server-side result cache (up to 500 entries)
- Factory configs and bare guns use static tarkov.dev images directly
- Preview toggle to disable generation when the service is slow or unavailable

### Attachment Compare Mode
- Set any installed attachment as a compare baseline
- Hover other attachments in the slot table to see live stat deltas on the ergo and recoil bars
- Weight and EED deltas update simultaneously in the stat panel

### Price Panel
- Per-item cost breakdown for every attachment in the current build
- Cheapest source auto-selected between trader and flea market
- PvP / PvE flea price cache toggle (separate caches, no re-fetch on switch)
- Per-trader loyalty level gating (LL1-4) for Prapor, Skier, Peacekeeper, Mechanic, and Jaeger
- Price chips visible inline in the attachment tree (Workbench list view) at a glance
- Attachment selector **Buyable** filter - hides attachments your traders cannot currently sell
- Quest unlock notes on attachments that require completing a trader task

### Stat Tracker
- Surfaces item stat changes detected automatically during daily server data syncs
- Each entry shows old/new values, percentage change, and the date detected
- Covers a rolling 7-day window, grouped by date

### Community Platform
- Publish, browse, and load community-submitted builds
- Auto-generated composite preview images hosted permanently on Gitee [https://gitee.com/morph1ne/eftforge-assets/](https://gitee.com/morph1ne/eftforge-assets/)
- Voting (like/dislike) on builds and individual attachments
- **Leaderboard** - top 10 trending / top 50 all-time for builds; top 20 / top 100 for attachments; filterable and sortable
- Featured build system curated by admins
- Build load count tracking
- In-app notifications for admin moderation actions
- Admin tools: feature, unlist, ban, announcements

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
| Asset Hosting | Gitee (community build card images) |
| Data Source | tarkov.dev GraphQL API |
| Compression | LZ-String |
| Markdown | marked.js |

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
- Wipe and rebuild the local database from scratch
- Sync all item data from tarkov.dev automatically
- Start the FastAPI backend at `http://127.0.0.1:8000`
- Serve the frontend at `http://127.0.0.1:5500`
- Open your browser to both

Once the backend console shows **"Application startup complete"**, the site will auto-populate with guns. That's it!

> **Note:** `sync_tarkov_dev.py` is called automatically by launch.bat, which calls reset.py. Avoid running it directly during local development, it is only used on the live production server for manual out-of-cycle resyncs.

---

## API Overview

The backend runs at `http://127.0.0.1:8000` by default. Interactive docs are available at `/docs` when `ENABLE_API_DOCS=1` is set in `.env`.

| Group | Endpoints |
|---|---|
| Items | `GET /guns`, `GET /ammo/{caliber}`, `GET /items/{id}/slots`, `GET /slots/{id}/allowed-items` |
| Build | `POST /build/validate`, `POST /build/calculate`, `POST /build/batch-process`, `GET /build/init/{gun_id}` |
| Image Gen | `POST /build/image-gen` |
| Ratings | `GET /ratings/attachments/bulk`, `POST /ratings/attachments/{id}/vote` |
| Community Builds | `POST /builds/publish`, `GET /builds/public`, `POST /builds/{id}/load`, `DELETE /builds/{id}` |
| Notifications | `GET /builds/notifications`, `GET /announcements` |
| Stat Tracker | `GET /stat-changes` |
| Health | `GET /health` |
| Admin | Build management, author management, ban system, announcements, migration tools |

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

## EvoErgo Credit

The EvoErgo concept was originally developed by **SpaceMonkey37**. EFTForge implements and expands upon this system in a live simulation environment. This project would not have been possible without SpaceMonkey37's foundational theory.

---

## License

MIT - see [LICENSE](LICENSE) for details.

---

## Disclaimer

EFTForge is a fan-made project and is not affiliated with Battlestate Games. All game data is sourced from [tarkov.dev](https://tarkov.dev).
