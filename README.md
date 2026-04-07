<div align="center">

# EFTForge

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

EFTForge is a full-stack Escape from Tarkov weapon build simulator. It provides recursive attachment tree simulation, real-time stat calculation via the EvoErgo engine, conflict detection, and a community build publishing platform. All item data is sourced live from the [tarkov.dev](https://tarkov.dev) GraphQL API.

---

## Features

### Build Simulation
- Recursive attachment tree rendering with full slot and allowed-item resolution
- Factory preset auto-install simulation
- Real-time stat calculation: ergonomics, recoil, weight, EED, arm stamina, overswing
- Full magazine ammo weight modeling
- Real attachment conflict detection (`conflictingItems` + `conflictingSlotIds`)
- Non-blocking conflict toast notifications
- Build serialization and LZ-String compression for shareable codes
- Session restore on page reload

### EvoErgo Engine
- Arm stamina drain calculation
- Weight delta (EED) from weapon ideal weight
- Overswing modeling based on excess weapon weight

### Community Platform
- Publish, browse, and load community-submitted builds
- Attachment and build voting (like/dislike ratings)
- Leaderboard and featured build system
- Admin moderation: feature, unlist, ban
- Build load count tracking

### Localization
- English and Chinese (Simplified) with automatic fallbacks
- Chinese item name translations stored alongside source data

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python, FastAPI, SQLAlchemy, SQLite, Pydantic, Uvicorn |
| Frontend | Vanilla JavaScript (ES2022), modular architecture |
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

> **Note:** `sync_tarkov_dev.py` is called automatically by launch.bat, which calls reset.py. Never run it directly during local development, it is only used on the live production server for manual out-of-cycle resyncs.

---

## API Overview

The backend runs at `http://127.0.0.1:8000` by default. Interactive docs are available at `/docs` when `ENABLE_API_DOCS=1` is set in `.env`.

| Group | Endpoints |
|---|---|
| Items | `GET /guns`, `GET /ammo/{caliber}`, `GET /items/{id}/slots`, `GET /slots/{id}/allowed-items` |
| Build | `POST /build/validate`, `POST /build/calculate`, `POST /build/batch-process` |
| Ratings | `GET /ratings/attachments/bulk`, `POST /ratings/attachments/{id}/vote` |
| Community Builds | `POST /builds/publish`, `GET /builds/public`, `POST /builds/{id}/load`, `DELETE /builds/{id}` |
| Notifications | `GET /builds/notifications`, `GET /announcements` |
| Admin | Build management, author management, ban system, announcements |

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
