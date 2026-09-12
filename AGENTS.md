# AGENTS.md

Guidance for AI agents (and humans) working in this repository. This project is **EFTForge** - a full-stack Escape from Tarkov weapon build simulator and community build-sharing platform.

For feature-level documentation see [README.md](README.md) (English) / [README_ZH.md](README_ZH.md) (Chinese). For local dev setup, lint/test commands, and code style rules, see [CONTRIBUTING.md](CONTRIBUTING.md). This file complements those - it captures architecture context and working-agreement rules an agent needs before touching code.

---

## Repo layout

| Path | What it is |
|---|---|
| `backend/` | Python/FastAPI server. All item data, build calculation, the MILP optimizer, ratings, community builds, profiles, admin tools. SQLite via SQLAlchemy. |
| `frontend/` | Vanilla JavaScript (ES2022) SPA. Classic `<script>` tags sharing a global scope, **not** ES modules - cross-file functions are declared as ESLint globals, not imported/exported. |
| `desktop/` | Windows desktop app: Tauri 2 shell (Rust) wrapping a WebView2 window pointed at a PyInstaller-frozen copy of the backend running as a local sidecar exe. See [desktop/README.md](desktop/README.md). |
| `template/` | Seed/template JSON (e.g. `announcements.json`) used when provisioning a fresh environment. |
| `local-app/` | Empty except `node_modules/` - not tracked in git, not part of the shipped project. Leftover/scratch; don't treat it as a real module. |
| `readme-assets/` | Images/SVGs referenced by the READMEs. |
| `launch.bat` | One-shot local dev launcher: builds/syncs the DB on first run, starts the FastAPI backend on `127.0.0.1:8000`, serves the frontend on `127.0.0.1:5500`, opens the browser. |

---

## Backend architecture (`backend/`)

- **Entry point:** `main.py` (~5800 lines) - all FastAPI routes live here, grouped by feature (items, build, optimizer, image gen, ratings, community builds, comments, profile, notifications, stat tracker, admin).
- **Desktop entry point:** `desktop_main.py` / `desktop.py` - same backend, run in "desktop mode" (`EFTFORGE_DESKTOP=1`), serving the frontend as static files and gating admin/local-only endpoints to `127.0.0.1`.
- **Databases:** four separate SQLite DBs, each with its own engine/session and model files:
  - `tarkov.db` via `database.py` - item/slot/trader data synced from tarkov.dev (`models_items.py`, `models_slots.py`, `models_slot_allowed.py`, `models_traders.py`, `models_item_offers.py`, `models_weapon_presets.py`).
  - `ratings.db` via `database_ratings.py` (`models_ratings.py`) - attachment/build voting.
  - `builds.db` via `database_builds.py` (`models_builds.py`) - published community builds, comments, notifications, bans, announcements.
  - `changelog.db` via `database_changelog.py` (`models_stat_changelog.py`) - the Stat Tracker's daily-sync diff history.
- **Optimizer (`backend/optimizer/`):** constraint-based MILP solver (HiGHS backend) that fills every attachment slot at once.
  - `solver.py` - main `optimize_weapon` / `OptimizeParams` entry point, stat ranges, MOA floor.
  - `milp.py` - the actual MILP formulation.
  - `compat_map.py` - builds the slot/item compatibility map the solver searches over.
  - `feasibility.py` - pre-solve feasibility checks.
  - `pricing.py` - trader/flea pricing logic feeding the solver's budget constraint.
  - `gunsmith.py` - **backend-only, not exposed in the frontend UI** (see Gunsmith mode note below).
- **Sync:** `sync_tarkov_dev.py` pulls item/slot/trader data from the tarkov.dev static JSON API (`json.tarkov.dev`), including language overlays. It's invoked automatically by `reset.py`, which `launch.bat` calls. Do not run `sync_tarkov_dev.py` directly during local dev - it's for manual out-of-cycle resyncs on the live production server only.
- **Stats:** `stats.py` holds the shared backend build-stat calculations. The EED and arm-stamina formulas are **intentionally duplicated** in `frontend/modules/calculations.js` for real-time client-side calculation. Keep those copies in sync by hand; there is no shared source between Python and JavaScript.
- **Config:** `config.py` reads `.env`. `IP_HASH_SECRET` and `ADMIN_API_KEY` are required (server refuses to start without them); everything else has defaults. `config.py::_resolve_desktop_data_dir()` must stay in sync with `desktop/src-tauri/src/main.rs::resolve_data_dir()`.
- **Tests:** `backend/tests/` - pytest, covering the optimizer/solver (termination, sparse constraints, ammo handling, concurrency, API regressions), gunsmith, combo transport, reachability, and the EvoErgo/EED calculation formulas.

## Frontend architecture (`frontend/`)

- **No build step, no bundler.** `index.html` loads `app.js` and each `modules/*.js` file via plain `<script src="modules/x.js?v=N">` tags, in dependency order. Every module attaches to a shared global namespace rather than using `import`/`export`.
- **`app.js`** - core app bootstrap, shared UI setup, and update/sync notices. Client-side EED and arm-stamina helpers live in `modules/calculations.js` (kept in sync with `backend/stats.py` by hand).
- **`modules/`** - one file per feature area: `api.js` (backend calls), `state.js`, `tree.js` / `attachment-grid.js` (the two workbench views), `slot-selector.js`, `optimizer.js`, `graph.js` (attachment graph), `calculations.js`, `build-manager.js`, `tab-manager.js` (workbench tabs and session management), `build-preview.js`, `ammo-table.js`, `leaderboard.js`, `profile.js`, `tracker.js` (Stat Tracker), `news.js`, `lang.js` (i18n), `desktop-settings.js`, `window-controls.js` (desktop titlebar), plus `*-devtool.js` files for localhost-only dev panels.
- **`?v=N` cache-busting params** in `index.html`: **never bump these yourself** when editing a module (see Working Agreements below) - the maintainer bumps all of them together right before a prod release.
- **Tests:** `frontend/tests/` - minimal, currently just `combo-api.test.js` and `combo-view.test.js`. No broad frontend test suite exists yet.
- **Linting:** ESLint per `.eslintrc.json` (`npm run lint` from `frontend/`).

## Desktop app (`desktop/`)

Tauri 2 (Rust, `src-tauri/`) + a PyInstaller-frozen backend sidecar (`pyinstaller/`). The frontend is the same codebase served locally instead of over the internet. Key points if working in this area:
- Data dir resolution is portable-first (`<install dir>/data/`), falling back to `%LOCALAPPDATA%` only if the install dir isn't writable - logic duplicated in Python and Rust, see above.
- Local server port defaults to 47651, then tries 47652 through 47660, with an ephemeral port as the final fallback. Preserve the preferred port because localStorage is origin-scoped. `EFTFORGE_PORT` can explicitly override it.
- Desktop mode is dev mode: `window.__EFTFORGE_DESKTOP__`, a local admin key auto-generated to `data/admin.key`, every localhost-gated devtool active.
- Release flow: bump version in `src-tauri/tauri.conf.json` + `Cargo.toml`, tag `app-vX.Y.Z`, push - `.github/workflows/desktop-release.yml` builds and publishes.

## CI

`.github/workflows/ci.yml` runs on pushes/PRs matching its path filters (backend, frontend, and selected lint/CI configuration files): `black --check`, `flake8`, `pytest` for the backend, plus `eslint` and frontend regression tests (`npm test`) for the frontend. `mypy` runs but is currently non-blocking. These describe CI checks; the working agreement below still governs local frontend verification. Backend formatting is `black` at line length 120 (`pyproject.toml`); `.flake8` documents the handful of deliberately-ignored rules (E501, W503, E221/E272 for aligned dict columns, E402 for `sync_tarkov_dev.py`'s dotenv ordering, E712 for SQLAlchemy's `== True` DSL).

---

## Working agreements (things I've been corrected on or confirmed on before)

These apply specifically to this repository and override generic default behavior:

1. **Never launch or check the frontend myself.** No dev server, no browser, no Playwright/screenshotting against `frontend/`. The maintainer verifies all frontend/UI changes manually. Backend-only verification (Python scripts, pytest, syntax checks) is fine.
2. **Never bump the `?v=N` cache-busting params** on `<script>` tags in `frontend/index.html` when editing a `frontend/modules/*.js` file, even though a comment in that file suggests doing so. The maintainer will prompt you to bump all of them together, all at once, right before a prod release. Only touch them if asked directly.
3. **"Write a commit message" means output text only.** Never run `git add`/`git commit` (or any git command) on that request alone - only act on an explicit "commit this" / "make the commit".
4. **Commit messages / patch notes / changelogs:** only describe a fix as a "bug fix" if the bug existed in a version that actually shipped to users. Bugs introduced and fixed within the same unreleased feature work fold silently into the feature description - no "fixed X" framing, since no user was ever affected.
5. **Gunsmith mode is backend-only right now.** `backend/optimizer/gunsmith.py`, the `/build/gunsmith-tasks` and `/build/gunsmith-solve` endpoints, and `backend/data/gunsmith_tasks.json` are fully implemented and tested, but there is no frontend UI wired up to them. Do not describe it as a live/available feature in README.md, README_ZH.md, patch notes, or any other user-facing doc until the frontend exposes it.
6. **Code comments:** first-person/imperative developer voice ("track the hovered card so we can reset it"), never third-person ("this function handles..."). No emojis in code or comments unless explicitly asked.
7. **No em dash (—)** anywhere in written output - chat replies, commit messages, docs, code comments. Use a regular hyphen (`-`) instead. Even better, avoid hyphens altogether if possible.
8. **Chinese-language text** (README_ZH.md edits, GitHub replies, translations) uses fullwidth Chinese punctuation (`,` `。` `:` `;` `?` `!`), not halfwidth ASCII equivalents - except inside inline code/technical tokens.

9. **Release news ownership:** as specified in `CONTRIBUTING.md`, do not add or edit `frontend/news/` posts or `manifest.json` as part of a feature or fix PR. Morph1ne writes and publishes release notes, version bumps, and the news feed after changes ship.

## Quick reference: don't run these directly

- `sync_tarkov_dev.py` - production-only manual resync tool; local dev gets data via `reset.py`/`launch.bat` automatically.
- Anything that starts a frontend dev server or opens a browser - the maintainer handles frontend verification.
