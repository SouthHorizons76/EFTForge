# EFTForge Desktop

Downloadable Windows app: the regular EFTForge frontend in a native WebView2
window (Tauri 2), powered by the same FastAPI backend running locally as a
PyInstaller sidecar exe. Works out of the box - game data follows the live site's Atlas snapshots, prices and
images still come from tarkov.dev, and
community features connect to EFTForge.com.

```
EFTForge.exe (Tauri shell, ~5 MB)
  |- spawns eftforge-backend.exe (PyInstaller sidecar, ~20 MB)
  |    |- serves the frontend (installed as resources) at 127.0.0.1:47651
  |    |- serves the full API from local SQLite in <install>/data/
  |    |- "connected" mode: community endpoints proxied to www.eftforge.com
  |    |- "local" mode: community endpoints use local SQLite (like dev)
  |- WebView2 window -> http://127.0.0.1:47651
  |- update check: Gitee first, GitHub fallback (user-configurable in-app)
```

## Where files live (portable-first)

Everything mutable goes to `<install dir>/data/` (SQLite DBs, settings,
webview profile with localStorage). Deleting the install folder removes every
trace. Only if the install dir is not writable (e.g. `C:\Program Files`) does
it fall back to `%LOCALAPPDATA%\EFTForge\data`. Logic lives in
`backend/config.py::_resolve_desktop_data_dir()` and is mirrored in
`src-tauri/src/main.rs::resolve_data_dir()` - keep them in sync.

The local server port is fixed (47651, fallback +1..+9): localStorage is
scoped to the origin `http://127.0.0.1:<port>`, so a changing port would
"lose" users' saved builds.

## Desktop mode = dev mode

The app sets `EFTFORGE_DESKTOP=1`. The frontend gets
`window.__EFTFORGE_DESKTOP__` injected into index.html by the backend. The
hostname is 127.0.0.1, so every localhost-gated devtool works, and the backend
generates a local admin key (`data/admin.key`, auto-filled into localStorage)
so admin endpoints work against the user's own data. `/admin` is never proxied
to prod.

## Local development

The backend runs unfrozen exactly like the packaged app:

```powershell
backend\venv\Scripts\python.exe backend\desktop_main.py
# -> EFTFORGE_PORT=47651, data dir backend\data\, frontend served from ..\frontend
```

Useful env overrides: `EFTFORGE_PORT`, `EFTFORGE_DATA_DIR`,
`EFTFORGE_REMOTE_ORIGIN` (point the community proxy at a staging server),
`EFTFORGE_FRONTEND_DIR`, `EFTFORGE_APP_VERSION`.

Desktop endpoints: `GET/POST /desktop/settings`, `POST /desktop/sync`,
`GET /desktop/sync-status`.

## Building the installer locally

Prereqs: the backend venv, Node 20+, Rust (`rustup` + MSVC build tools).
One-time: `cd desktop && npm install`.

```powershell
# 1. freeze the backend + stage sidecar/resources
backend\venv\Scripts\python.exe desktop\scripts\build_backend.py

# 2. build the app (installer lands in desktop\src-tauri\target\release\bundle\nsis\)
cd desktop
npm run build
```

`tauri dev` also works after step 1 (it uses the same sidecar binary).

## Updater

Tauri's built-in updater checks these manifests (order depends on the
in-app "update source" setting, default auto = Gitee then GitHub):

- `https://gitee.com/morph1ne/eftforge-assets/raw/master/desktop/latest.json`
- `https://github.com/SouthHorizons76/EFTForge/releases/latest/download/latest.json`

Updates are cryptographically signed. One-time setup:

```powershell
cd desktop
npm run tauri signer generate -- -w $HOME\.tauri\eftforge.key
```

Put the printed **public key** into `src-tauri/tauri.conf.json` -> `plugins.updater.pubkey`
(currently a `REPLACE_WITH_TAURI_SIGNER_PUBKEY` placeholder - the updater is
inert until this is done). Keep the private key out of the repo; add it to
GitHub Actions secrets as `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`).

## Releasing

1. Bump `version` in `src-tauri/tauri.conf.json` (and `src-tauri/Cargo.toml`).
2. Commit, then tag and push: `git tag app-v0.1.0 && git push origin app-v0.1.0`.
3. `.github/workflows/desktop-release.yml` builds a fresh-snapshot installer
   and publishes the GitHub release (secrets: `TAURI_SIGNING_PRIVATE_KEY`,
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
4. Mirror to Gitee manually, from a machine with real Gitee connectivity
   (GitHub-hosted runners throttle/stall on the installer upload - this is
   *not* run in CI):
   ```
   $env:GITEE_TOKEN = "..."
   python desktop/scripts/mirror_to_gitee.py --tag app-v0.1.0
   ```
   Gitee repos configurable via env in `scripts/mirror_to_gitee.py`.

Compatibility note: shipped apps keep talking to the live community API in
connected mode - keep those endpoints backward compatible, or gate breaking
changes on a minimum-app-version check.

## Known gaps / follow-ups

- The Windows installer itself is not Authenticode-signed (SmartScreen will
  warn on first download); Tauri update signing is independent of this.
- Verify Gitee release-attachment download URLs work anonymously for files of
  installer size on the account tier in use; if not, host the installer as a
  raw file or via Gitee Pages instead (mirror script would need a small tweak).
- Gitee mirroring is a manual post-release step (see above) - GitHub Actions
  runners can't reliably upload the installer to Gitee.
