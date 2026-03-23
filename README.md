# EFTForge

A full-stack Escape from Tarkov build simulator and EvoErgo engine. EFTForge provides real-time weapon modding with recursive attachment tree simulation, live stat calculation, conflict detection, and a community build publishing platform. Data is sourced from the [tarkov.dev](https://tarkov.dev) GraphQL API.

---

## Features

**Build Simulation**
- Recursive attachment tree rendering with full slot/allowed-item resolution
- Factory preset auto-install simulation
- Real-time stat calculation: ergonomics, recoil, weight, EED, arm stamina, overswing
- Full magazine ammo weight modeling
- Real attachment conflict detection (`conflictingItems` + `conflictingSlotIds`)
- Non-blocking conflict toast notifications
- Build serialization and compression via LZ-String for shareable links
- Session restore on page reload

**EvoErgo Engine**
- Arm stamina calculation
- Weight delta (EED) from weapon ideal weight
- Overswing modeling

**Community Builds**
- Publish, browse, and load community-submitted builds
- Attachment and build voting (like/dislike ratings)
- Build persistence across sessions
- Admin moderation: feature, unlist, ban

**Localization**
- English and Chinese (Simplified) language support with fallbacks
- Chinese item name translations stored alongside source data

---

## Tech Stack

| Layer | Technologies |
|---|---|
| Backend | Python, FastAPI, SQLAlchemy, SQLite, Pydantic, Uvicorn |
| Frontend | Vanilla JavaScript (ES2022), modular architecture |
| Data Source | tarkov.dev GraphQL API |
| Compression | LZ-String |
| Markdown | marked.js |

---

## Prerequisites

- Python 3.10+
- A modern web browser
- (Optional) VS Code with Live Server for frontend development

---

## Getting Started

### 1. Clone the repository

```bash
git clone <your-repo-url>
cd db4tarkovCN
```

### 2. Set up the backend

```bash
cd backend
python -m venv venv
source venv/Scripts/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and set the required values:

```env
DATABASE_URL=sqlite:///./tarkov.db
RATINGS_DB_URL=sqlite:///./ratings.db
BUILDS_DB_URL=sqlite:///./builds.db
CORS_ORIGINS=http://127.0.0.1:5500
IP_HASH_SECRET=your-secret-here
ADMIN_API_KEY=your-admin-key-here
```

`IP_HASH_SECRET` and `ADMIN_API_KEY` are required for production. Admin endpoints return `503` if `ADMIN_API_KEY` is not set.

### 4. Sync the database

```bash
python sync_tarkov_dev.py
```

### 5. Start the backend

```bash
uvicorn main:app --reload
```

Or use the provided launcher on Windows (Edit browser path if you're not using Chrome):

```bat
launch.bat
```

### 6. Serve the frontend

Open `frontend/index.html` with Live Server (default: `http://127.0.0.1:5500`) or any static file server.

---

## Project Structure

```
db4tarkovCN/
├── backend/
│   ├── main.py                  # FastAPI application and route definitions
│   ├── config.py                # Environment config, CORS, keys
│   ├── database.py              # Main item/weapon/attachment DB
│   ├── database_ratings.py      # Attachment rating DB
│   ├── database_builds.py       # Community builds DB
│   ├── models_items.py          # Item ORM models (weapons, attachments, ammo)
│   ├── models_slots.py          # Slot definitions
│   ├── models_builds.py         # Build, vote, ban, notification models
│   ├── models_ratings.py        # Attachment vote/rating models
│   ├── models_stat_changelog.py # Stat change tracking
│   ├── sync_tarkov_dev.py       # tarkov.dev GraphQL sync worker
│   ├── reset.py                 # Database reset utilities
│   ├── snapshot_dbs.py          # Database backup/restore
│   ├── requirements.txt
│   ├── .env.example
│   └── tests/
│       └── test_calculations.py
├── frontend/
│   ├── index.html
│   ├── app.js                   # Main init, event listeners, gun selection
│   ├── modules/
│   │   ├── api.js               # All HTTP requests
│   │   ├── state.js             # Global state management
│   │   ├── config.js            # Frontend config and feature flags
│   │   ├── calculations.js      # EvoErgo engine (EED, arm stamina)
│   │   ├── build-manager.js     # Build persistence and serialization
│   │   ├── slot-selector.js     # Attachment tree UI rendering
│   │   ├── stats-panel.js       # Real-time stat display
│   │   ├── gun-list.js          # Gun filtering and selection UI
│   │   ├── tree.js              # Attachment tree data structure
│   │   ├── lang.js              # i18n strings (EN/ZH)
│   │   ├── news.js              # In-app changelog rendering
│   │   └── utils.js             # Toast notifications, helpers
│   ├── assets/
│   │   ├── images/
│   │   └── fonts/
│   └── news/                    # Static news posts and images
├── launch.bat
├── LICENSE
└── README.md
```

---

## API Overview

The FastAPI backend runs on `http://127.0.0.1:8000` by default. Key endpoint groups:

| Group | Endpoints |
|---|---|
| Items | `GET /guns`, `GET /ammo/{caliber}`, `GET /items/{id}/slots`, `GET /slots/{id}/allowed-items` |
| Build | `POST /build/validate`, `POST /build/calculate`, `POST /build/batch-process` |
| Ratings | `GET /ratings/attachments/bulk`, `POST /ratings/attachments/{id}/vote` |
| Community | `POST /builds/publish`, `GET /builds/public`, `POST /builds/{id}/load`, `DELETE /builds/{id}` |
| Notifications | `GET /builds/notifications`, `GET /announcements` |
| Admin | Build management, author management, ban system, announcements |

Interactive API docs are available at `http://127.0.0.1:8000/docs` when the backend is running.

---

## EvoErgo Concept Credit

The EvoErgo concept was originally developed by **SpaceMonkey37**.

EFTForge implements and expands upon this system in a live simulation environment. This project would not have been possible without the foundational theory developed by SpaceMonkey37.

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Disclaimer

EFTForge is a fan-made project and is not affiliated with Battlestate Games. All Escape from Tarkov data is sourced from [tarkov.dev](https://tarkov.dev).
