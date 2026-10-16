// EFTForge desktop launcher.
//
// Responsibilities (all in Rust - the webview UI is the regular EFTForge
// frontend served over http by the local backend, no Tauri IPC involved):
//   1. Resolve the portable data dir (next to the exe when writable, else
//      %LOCALAPPDATA%\EFTForge\data) - must mirror backend/config.py.
//   2. Spawn the PyInstaller backend sidecar, read "EFTFORGE_PORT=<n>" from
//      its stdout, then navigate the window to the local server.
//   3. Check for app updates from Gitee/GitHub per the user's
//      update_source setting (data/settings.json, written by the backend).
//   4. Guarantee the sidecar dies with this process, no matter how this
//      process dies - see create_sidecar_job() below.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

const GITEE_MANIFEST: &str =
    "https://gitee.com/morph1ne/eftforge-assets/raw/master/desktop/latest.json";
const GITHUB_MANIFEST: &str =
    "https://github.com/SouthHorizons76/EFTForge/releases/latest/download/latest.json";

struct BackendChild(Mutex<Option<CommandChild>>);

/// Portable-first data dir - keep in sync with _resolve_desktop_data_dir()
/// in backend/config.py (the backend re-runs the same logic; passing the
/// result via EFTFORGE_DATA_DIR just guarantees both sides agree).
fn resolve_data_dir() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));
    if let Some(dir) = exe_dir {
        let portable = dir.join("data");
        if fs::create_dir_all(&portable).is_ok() {
            let probe = portable.join(".write-probe");
            if fs::write(&probe, "ok").is_ok() {
                let _ = fs::remove_file(&probe);
                return portable;
            }
        }
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("EFTForge").join("data")
}

/// update_source from data/settings.json ("auto" | "gitee" | "github").
/// The backend owns this file; we only read it at launch.
fn read_update_source(data_dir: &PathBuf) -> String {
    let path = data_dir.join("settings.json");
    if let Ok(raw) = fs::read_to_string(path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(s) = v.get("update_source").and_then(|s| s.as_str()) {
                return s.to_string();
            }
        }
    }
    "auto".to_string()
}

/// close_action from data/settings.json ("ask" | "tray" | "exit"). The
/// backend (POST /desktop/settings, from the close-choice modal's "remember
/// my choice" checkbox and the desktop settings modal) owns this file - it
/// is re-read on every close request rather than cached, since the running
/// app never restarts when the user changes it.
fn read_close_action(data_dir: &PathBuf) -> String {
    let path = data_dir.join("settings.json");
    if let Ok(raw) = fs::read_to_string(path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(s) = v.get("close_action").and_then(|s| s.as_str()) {
                return s.to_string();
            }
        }
    }
    "ask".to_string()
}

fn build_updater(
    handle: &tauri::AppHandle,
    source: &str,
) -> Result<tauri_plugin_updater::Updater, String> {
    let endpoints: Vec<&str> = match source {
        "gitee" => vec![GITEE_MANIFEST],
        "github" => vec![GITHUB_MANIFEST],
        // auto: Gitee first - reachable both in and outside China; GitHub
        // often times out inside China, so it is the fallback.
        _ => vec![GITEE_MANIFEST, GITHUB_MANIFEST],
    };
    let urls: Vec<tauri::Url> = endpoints
        .iter()
        .filter_map(|u| u.parse().ok())
        .collect();

    handle
        .updater_builder()
        .endpoints(urls)
        .and_then(|b| b.build())
        .map_err(|e| e.to_string())
}

/// Result of a user-triggered update check, reported back to the About
/// modal's "Check for Updates" button via the `manual_check_for_updates`
/// command. The silent startup check (below) doesn't need this - it only
/// ever acts when an update is actually found.
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum UpdateCheckResult {
    UpToDate,
    Available { version: String },
    Error { message: String },
}

/// Shows the confirm dialog and, if accepted, downloads/installs the update.
/// Shared by the silent startup check and the manual About-modal check.
///
/// The download runs while the app stays fully usable, so its progress is
/// surfaced to the page via events (frontend/modules/desktop-settings.js
/// listens and shows a badge on the Settings button + a progress bar in the
/// settings modal): update-download-started {version}, then throttled
/// update-download-progress {downloaded, total}, then update-installing
/// right before the installer takes over (the app exits at that point -
/// install() launches the NSIS installer and never returns on Windows), or
/// update-error {message} on any failure.
async fn prompt_and_install(handle: tauri::AppHandle, update: tauri_plugin_updater::Update) {
    let version = update.version.clone();
    let ask_handle = handle.clone();
    let confirmed = tauri::async_runtime::spawn_blocking(move || {
        ask_handle
            .dialog()
            .message(format!(
                "发现新版本 EFTForge v{version}，是否现在更新？\n\
                 A new version (v{version}) is available. Update now?"
            ))
            .title("EFTForge 更新 / Update")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "更新 Update".into(),
                "稍后 Later".into(),
            ))
            .blocking_show()
    })
    .await
    .unwrap_or(false);

    if !confirmed {
        return;
    }

    let _ = handle.emit(
        "update-download-started",
        serde_json::json!({ "version": update.version }),
    );

    let progress_handle = handle.clone();
    let mut downloaded: u64 = 0;
    // Backdated so the very first chunk emits immediately.
    let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let finish_handle = handle.clone();

    let bytes = match update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                if last_emit.elapsed().as_millis() >= 150 {
                    last_emit = std::time::Instant::now();
                    let _ = progress_handle.emit(
                        "update-download-progress",
                        serde_json::json!({ "downloaded": downloaded, "total": total }),
                    );
                }
            },
            move || {
                let _ = finish_handle.emit("update-installing", ());
            },
        )
        .await
    {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("[updater] download failed: {e}");
            let _ = handle.emit("update-error", serde_json::json!({ "message": e.to_string() }));
            let _ = handle
                .dialog()
                .message(format!("更新失败 / Update failed: {e}"))
                .kind(MessageDialogKind::Error)
                .blocking_show();
            return;
        }
    };

    match update.install(bytes) {
        // On Windows install() launches the installer and exits this process
        // itself; restart() only runs on platforms where it returns.
        Ok(_) => handle.restart(),
        Err(e) => {
            eprintln!("[updater] install failed: {e}");
            let _ = handle.emit("update-error", serde_json::json!({ "message": e.to_string() }));
            let _ = handle
                .dialog()
                .message(format!("更新失败 / Update failed: {e}"))
                .kind(MessageDialogKind::Error)
                .blocking_show();
        }
    }
}

/// Silent startup check - only acts (dialog + install) when an update is
/// actually found; otherwise says nothing.
async fn check_for_updates(handle: tauri::AppHandle, source: String) {
    let updater = match build_updater(&handle, &source) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[updater] setup failed: {e}");
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => prompt_and_install(handle, update).await,
        Ok(None) => {}
        Err(e) => eprintln!("[updater] check failed: {e}"),
    }
}

/// User-triggered check from the About modal's "Check for Updates" button.
/// Reads update_source the same way the startup check does, so it honors
/// whatever the user picked in Settings - Gitee/GitHub/auto. Unlike the
/// silent startup check, this always reports back to the caller so the
/// button can show "up to date" / an error, not just act silently.
#[tauri::command]
async fn manual_check_for_updates(handle: tauri::AppHandle) -> UpdateCheckResult {
    let source = read_update_source(&resolve_data_dir());

    let updater = match build_updater(&handle, &source) {
        Ok(u) => u,
        Err(message) => return UpdateCheckResult::Error { message },
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            // Fire and forget: the About button gets its "update available"
            // answer right away instead of hanging until the download (which
            // can take minutes) finishes behind the confirm dialog.
            tauri::async_runtime::spawn(prompt_and_install(handle, update));
            UpdateCheckResult::Available { version }
        }
        Ok(None) => UpdateCheckResult::UpToDate,
        Err(e) => UpdateCheckResult::Error {
            message: e.to_string(),
        },
    }
}

/// Invoked by the close-choice modal (frontend/modules/window-controls.js)
/// when the user picks "Minimize to Tray" for the close request currently
/// being held open by the CloseRequested handler below.
#[tauri::command]
fn close_to_tray(handle: tauri::AppHandle) {
    if let Some(w) = handle.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// Invoked by the close-choice modal when the user picks "Exit". Goes
/// through AppHandle::exit so the existing RunEvent::Exit handler still
/// kills the backend sidecar.
#[tauri::command]
fn exit_app(handle: tauri::AppHandle) {
    handle.exit(0);
}

/// Held across get_perf_metrics calls so per-process CPU% (which sysinfo
/// derives from the delta since the *previous* refresh of that pid) is
/// meaningful from the very first poll instead of reading 0 until a second
/// call happens to land - the settings modal polls this every second, so in
/// practice consecutive calls are already spaced far enough apart for
/// sysinfo's own MINIMUM_CPU_UPDATE_INTERVAL either way, but a fresh
/// System per call would still throw away that history for no reason.
struct PerfState(Mutex<System>);

#[derive(serde::Serialize)]
struct ProcMetrics {
    mem_mb: f64,
    cpu_pct: f32,
    uptime_secs: u64,
}

#[derive(serde::Serialize)]
struct PerfMetrics {
    app: ProcMetrics,
    // None when the sidecar isn't tracked yet (still starting) or has died -
    // the frontend shows that as an explicit "not running" state rather than
    // silently dropping the row, since a sidecar that's supposed to be there
    // but isn't is itself worth surfacing.
    backend: Option<ProcMetrics>,
    sys_used_mem_mb: f64,
    sys_total_mem_mb: f64,
}

/// WebView2 (like any Chromium embed) is multi-process - the browser/GPU/
/// renderer/network/crashpad processes that do the actual work of running
/// the page all live under this one as children (and grandchildren), not as
/// this process itself. Reading just root's own PID massively undercounts
/// "what the app is using" - this walks the full descendant tree so the
/// reported number matches what Task Manager's grouped app entry covers.
/// Same logic applies to the backend: its --sync-worker re-invocation
/// (see create_sidecar_job's docs above) runs as a child process too.
fn tree_pids(sys: &System, root: Pid) -> Vec<Pid> {
    let mut children_of: std::collections::HashMap<Pid, Vec<Pid>> = std::collections::HashMap::new();
    for (pid, process) in sys.processes() {
        if let Some(parent) = process.parent() {
            children_of.entry(parent).or_default().push(*pid);
        }
    }

    let mut result = vec![root];
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if let Some(children) = children_of.get(&pid) {
            for &child in children {
                result.push(child);
                stack.push(child);
            }
        }
    }
    result
}

/// Sums memory and CPU% across root's whole process tree; uptime stays
/// root's own (summing uptimes across a tree is meaningless - root is the
/// one that's been alive since the app/sidecar actually started).
fn tree_metrics(sys: &System, root: Pid) -> Option<ProcMetrics> {
    let root_process = sys.process(root)?;
    let uptime_secs = root_process.run_time();

    let mut mem_mb = 0.0;
    let mut cpu_pct = 0.0f32;
    for pid in tree_pids(sys, root) {
        if let Some(p) = sys.process(pid) {
            mem_mb += p.memory() as f64 / 1_048_576.0;
            cpu_pct += p.cpu_usage();
        }
    }

    Some(ProcMetrics { mem_mb, cpu_pct, uptime_secs })
}

/// Real OS-level memory/CPU for this app's whole process tree (the Tauri
/// shell plus every WebView2 child it spawns) and the eftforge-backend
/// sidecar's tree, plus whole-machine RAM, shown live in the settings
/// modal's Performance section (frontend/modules/perf-metrics.js). Browser
/// APIs like performance.memory only see the JS heap, not the actual
/// process(es) or the machine - this is what the website build can't get,
/// and the reason this is a Tauri command instead of just JS on both sides.
#[tauri::command]
fn get_perf_metrics(perf: tauri::State<PerfState>, backend: tauri::State<BackendChild>) -> PerfMetrics {
    let app_pid = Pid::from_u32(std::process::id());
    let backend_pid = backend.0.lock().unwrap().as_ref().map(|c| Pid::from_u32(c.pid()));

    let mut sys = perf.0.lock().unwrap();
    // Need the full process table (not just our known pids) to walk parent
    // links and find the WebView2/sync-worker children - refresh_processes
    // can no longer target just app_pid/backend_pid like before.
    sys.refresh_processes(ProcessesToUpdate::All, true);
    sys.refresh_memory();

    PerfMetrics {
        app: tree_metrics(&sys, app_pid).unwrap_or(ProcMetrics { mem_mb: 0.0, cpu_pct: 0.0, uptime_secs: 0 }),
        backend: backend_pid.and_then(|bp| tree_metrics(&sys, bp)),
        sys_used_mem_mb: sys.used_memory() as f64 / 1_048_576.0,
        sys_total_mem_mb: sys.total_memory() as f64 / 1_048_576.0,
    }
}

/// WebView2's own file chooser and download UI don't reliably show up in this
/// frameless shell, so FILE_DIALOG_SCRIPT (injected into every page) reroutes
/// <input type="file"> clicks and <a download> clicks to these two commands,
/// which use the native dialogs from tauri-plugin-dialog instead. File bytes
/// cross the IPC boundary as base64 data URLs.
#[derive(serde::Serialize)]
struct PickedFile {
    name: String,
    data: String,
}

#[tauri::command]
async fn pick_files(
    window: tauri::WebviewWindow,
    extensions: Vec<String>,
    multiple: bool,
) -> Result<Vec<PickedFile>, String> {
    use base64::Engine;

    // The blocking_* dialog calls wait on the main thread, so keep them off
    // the async runtime's workers.
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = window.dialog().file().set_parent(&window);
        if !extensions.is_empty() {
            let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter("Files", &exts);
        }
        let picked = if multiple {
            dialog.blocking_pick_files().unwrap_or_default()
        } else {
            dialog.blocking_pick_file().into_iter().collect()
        };

        let mut files = Vec::with_capacity(picked.len());
        for file in picked {
            let path = file.into_path().map_err(|e| e.to_string())?;
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            files.push(PickedFile {
                name,
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
            });
        }
        Ok(files)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Returns false when the user cancels the save dialog.
#[tauri::command]
async fn save_file(window: tauri::WebviewWindow, file_name: String, data_url: String) -> Result<bool, String> {
    use base64::Engine;

    let encoded = data_url.split_once(',').map(|(_, d)| d).unwrap_or(&data_url);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name(file_name.clone());
        if let Some((_, ext)) = file_name.rsplit_once('.') {
            if !ext.is_empty() {
                dialog = dialog.add_filter(ext.to_uppercase(), &[ext]);
            }
        }
        let Some(target) = dialog.blocking_save_file() else {
            return Ok(false);
        };
        let path = target.into_path().map_err(|e| e.to_string())?;
        fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Page script that routes file inputs and downloads through pick_files and
/// save_file above. We hook the prototypes rather than listening for clicks
/// because the app triggers both programmatically (input.click() on a hidden
/// input, a.click() on a detached anchor), and those never bubble to the
/// document. URL.createObjectURL is wrapped so we can still get at a blob
/// whose URL the caller revokes right after a.click() returns.
const FILE_DIALOG_SCRIPT: &str = r#"(function() {
    function _core() {
        return window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__.core : null;
    }

    var MIME_EXTS = {
        'image/jpeg': ['jpg', 'jpeg'],
        'image/png': ['png'],
        'image/webp': ['webp'],
        'image/gif': ['gif'],
        'image/*': ['png', 'jpg', 'jpeg', 'webp', 'gif'],
        'application/json': ['json']
    };
    var EXT_MIME = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
        webp: 'image/webp', gif: 'image/gif', json: 'application/json'
    };

    // An accept token we can't map means no filter at all, so we never hide
    // a file the page would have taken.
    function _acceptExts(accept) {
        var out = [];
        var tokens = (accept || '').split(',');
        for (var i = 0; i < tokens.length; i++) {
            var t = tokens[i].trim().toLowerCase();
            if (!t) continue;
            if (t.charAt(0) === '.') out.push(t.slice(1));
            else if (MIME_EXTS[t]) out = out.concat(MIME_EXTS[t]);
            else return [];
        }
        return out;
    }

    function _b64ToBytes(b64) {
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    var _inputClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function() {
        var core = _core();
        if (this.type !== 'file' || !core) return _inputClick.call(this);
        var input = this;
        core.invoke('pick_files', { extensions: _acceptExts(input.accept), multiple: !!input.multiple })
            .then(function(files) {
                if (!files || !files.length) {
                    input.dispatchEvent(new Event('cancel'));
                    return;
                }
                var dt = new DataTransfer();
                files.forEach(function(f) {
                    var ext = (f.name.split('.').pop() || '').toLowerCase();
                    dt.items.add(new File([_b64ToBytes(f.data)], f.name, { type: EXT_MIME[ext] || '' }));
                });
                input.files = dt.files;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            })
            .catch(function(err) { console.error('[desktop] file picker failed:', err); });
    };

    var _blobs = new Map();
    var _createObjectURL = URL.createObjectURL;
    URL.createObjectURL = function(obj) {
        var url = _createObjectURL.call(URL, obj);
        if (obj instanceof Blob) _blobs.set(url, obj);
        return url;
    };
    var _revokeObjectURL = URL.revokeObjectURL;
    URL.revokeObjectURL = function(url) {
        _blobs.delete(url);
        return _revokeObjectURL.call(URL, url);
    };

    var _anchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
        var core = _core();
        var href = this.href || '';
        if (!core || !this.hasAttribute('download') || !/^(blob|data):/.test(href)) {
            return _anchorClick.call(this);
        }
        var name = this.getAttribute('download') || 'download';
        // A base64 data: href is already what save_file takes. Don't fetch() it,
        // since the page CSP's connect-src has no data: and refuses the request.
        var dataUrlPromise;
        if (/^data:[^,]*;base64,/i.test(href)) {
            dataUrlPromise = Promise.resolve(href);
        } else {
            var blob = _blobs.get(href);
            dataUrlPromise = (blob ? Promise.resolve(blob) : fetch(href).then(function(r) { return r.blob(); }))
                .then(function(b) {
                    return new Promise(function(resolve, reject) {
                        var reader = new FileReader();
                        reader.onload = function() { resolve(reader.result); };
                        reader.onerror = function() { reject(reader.error); };
                        reader.readAsDataURL(b);
                    });
                });
        }
        dataUrlPromise
            .then(function(dataUrl) { return core.invoke('save_file', { fileName: name, dataUrl: dataUrl }); })
            .catch(function(err) { console.error('[desktop] save failed:', err); });
    };
})();"#;

/// Page script that sends external links to open_url. WebView2's new-window
/// path (on_new_window below) stays as a fallback, but we catch the common
/// cases here: clicked anchors, a.click() on a detached anchor, and
/// window.open(). A connected anchor's a.click() fires a real click event,
/// so the window listener already covers it and the hook must not open it
/// a second time.
const LINK_SCRIPT: &str = r#"(function() {
    var APP_HOSTS = { '127.0.0.1': 1, 'localhost': 1, 'tauri.localhost': 1 };

    function _external(href) {
        var url;
        try { url = new URL(href, location.href); } catch (e) { return null; }
        if (url.protocol === 'mailto:') return url.href;
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return APP_HOSTS[url.hostname] ? null : url.href;
    }

    function _open(href) {
        var core = window.__TAURI__ && window.__TAURI__.core;
        if (!core) return false;
        core.invoke('open_url', { url: href })
            .catch(function(err) {
                console.error('[desktop] open link failed:', err);
                if (typeof window.showToast === 'function') window.showToast('Link', String(err), 5000, '#e74c3c');
            });
        return true;
    }

    // Capture phase on window runs before any page handler, so a modal that
    // calls stopPropagation() on its own clicks can't hide links from us.
    function _onClick(e) {
        if (e.button !== 0 && e.button !== 1) return;
        var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!a || a.hasAttribute('download')) return;
        var href = _external(a.href);
        if (href && _open(href)) e.preventDefault();
    }
    window.addEventListener('click', _onClick, true);
    window.addEventListener('auxclick', _onClick, true);

    var _anchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
        if (!this.isConnected && !this.hasAttribute('download')) {
            var href = _external(this.href);
            if (href && _open(href)) return;
        }
        return _anchorClick.call(this);
    };

    var _windowOpen = window.open;
    window.open = function(url) {
        var href = url ? _external(String(url)) : null;
        if (href && _open(href)) return null;
        return _windowOpen.apply(window, arguments);
    };
})();"#;

/// The app's own pages (the ui-shell splash and the local backend) stay in
/// the window; everything else belongs in the user's browser.
fn is_app_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "http" | "https" => matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "tauri.localhost")),
        "tauri" | "about" | "data" | "blob" => true,
        _ => false,
    }
}

/// Opens http/https/mailto URLs in the default browser by handing the URL to
/// rundll32's FileProtocolHandler in its own process, so nothing about this
/// process's threads or COM state can get in the way.
#[cfg(windows)]
fn open_in_browser(url: &tauri::Url) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return Err(format!("refusing to open {url}"));
    }
    std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url.as_str()])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to open {url}: {e}"))
}

#[cfg(not(windows))]
fn open_in_browser(url: &tauri::Url) -> Result<(), String> {
    Err(format!("external links unsupported on this platform: {url}"))
}

fn spawn_open_in_browser(url: tauri::Url) {
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = open_in_browser(&url) {
            eprintln!("[links] {e}");
        }
    });
}

/// External links from the page (LINK_SCRIPT intercepts the clicks).
#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    let url = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || open_in_browser(&url))
        .await
        .map_err(|e| e.to_string())?
}

/// Ties the sidecar's lifetime to this process at the OS level, so it cannot
/// be orphaned no matter how this process ends - normal exit, a crash, or a
/// forced kill from Task Manager/taskkill. The RunEvent::Exit handler below
/// only covers the graceful-shutdown path; this covers every path.
///
/// Mechanism: a Windows Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
/// that the sidecar (and transitively any process *it* spawns, like the
/// --sync-worker re-invocation) is assigned to right after spawning. This
/// process holds the only job handle and never closes it; Windows closes
/// every handle this process owns the moment the process terminates for any
/// reason, and KILL_ON_JOB_CLOSE means that last handle closing takes the
/// whole job down with it.
///
/// This process itself deliberately stays OUT of the job. It used to be in
/// it (relying on children auto-joining), but that broke the updater: the
/// elevated NSIS installer the updater launches gets re-parented to this
/// process by the UAC elevation flow, inherited the job, and was killed the
/// instant the updater exited the app - the update silently never happened.
#[cfg(windows)]
static SIDECAR_JOB: std::sync::OnceLock<isize> = std::sync::OnceLock::new();

#[cfg(windows)]
fn create_sidecar_job() {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let job: HANDLE = match CreateJobObjectW(None, None) {
            Ok(job) => job,
            Err(e) => {
                eprintln!("[job] CreateJobObjectW failed: {e}");
                return;
            }
        };

        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let set_ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if let Err(e) = set_ok {
            eprintln!("[job] SetInformationJobObject failed: {e}");
            return;
        }

        // `HANDLE` is a plain Copy wrapper with no Drop impl, so this handle
        // is never explicitly closed by us - it only closes when Windows
        // tears the whole process down, which is exactly the moment we want
        // the sidecar killed.
        let _ = SIDECAR_JOB.set(job.0 as isize);
    }
}

#[cfg(not(windows))]
fn create_sidecar_job() {}

/// Assigns the freshly spawned sidecar to the kill-on-close job created by
/// create_sidecar_job(). Called immediately after spawn, before the backend
/// has a chance to spawn any children of its own (those then join the job
/// automatically, being children of a job member).
#[cfg(windows)]
fn put_pid_in_sidecar_job(pid: u32) {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::AssignProcessToJobObject;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    let Some(&job) = SIDECAR_JOB.get() else {
        eprintln!("[job] no sidecar job - backend may outlive a crashed app");
        return;
    };
    let job = HANDLE(job as _);

    unsafe {
        match OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid) {
            Ok(process) => {
                if let Err(e) = AssignProcessToJobObject(job, process) {
                    eprintln!("[job] AssignProcessToJobObject({pid}) failed: {e}");
                }
                let _ = CloseHandle(process);
            }
            Err(e) => eprintln!("[job] OpenProcess({pid}) failed: {e}"),
        }
    }
}

fn main() {
    create_sidecar_job();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A "minimize to tray" close hides the window (hide/show), which
            // is a different state from minimized (unminimize alone doesn't
            // undo it) - a second launch attempt while tray-hidden needs
            // show() too, or the window silently stays invisible and it
            // looks like the relaunch did nothing.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            manual_check_for_updates,
            close_to_tray,
            exit_app,
            get_perf_metrics,
            pick_files,
            save_file,
            open_url
        ])
        .manage(BackendChild(Mutex::new(None)))
        .manage(PerfState(Mutex::new(System::new())))
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = resolve_data_dir();
            fs::create_dir_all(&data_dir)?;

            // Splash window immediately (bundled ui-shell page); it navigates
            // to the local server as soon as the backend reports its port.
            // The webview profile (localStorage with the user's saved builds!)
            // lives in the portable data dir, not %APPDATA%.
            #[allow(unused_mut)]
            let mut builder =
                WebviewWindowBuilder::new(&handle, "main", WebviewUrl::App("index.html".into()))
                    .title("EFTForge")
                    .inner_size(1500.0, 940.0)
                    .min_inner_size(1024.0, 700.0)
                    .center()
                    // No native title bar - the site's own header bar (and the
                    // ui-shell splash page) draw the title bar instead, via
                    // data-tauri-drag-region + custom minimize/maximize/close
                    // buttons. See frontend/modules/window-controls.js.
                    .decorations(false)
                    // WebView2's native accelerator keys (F5, Ctrl+P, Ctrl+F, ...)
                    // get disabled below via AreBrowserAcceleratorKeysEnabled, which
                    // hands those key events to the page instead of eating them.
                    // Re-implement the ones we want: F5/Ctrl+Shift+R reload and
                    // Ctrl+Scroll page zoom.
                    .initialization_script(
                        r#"(function() {
                            window.addEventListener('keydown', function(e) {
                                if (e.key === 'F5' || e.keyCode === 116) {
                                    e.preventDefault();
                                    location.reload();
                                } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
                                    e.preventDefault();
                                    location.reload();
                                }
                            }, true);
                            var ZOOM_LEVELS = [0.25,0.33,0.5,0.67,0.75,0.8,0.9,1.0,1.1,1.25,1.5,1.75,2.0,2.5,3.0,4.0,5.0];
                            var _zi = 7; // index of 1.0
                            var _zoomEl = null;
                            var _zoomTimer = null;
                            function _showZoom(z) {
                                if (!_zoomEl) {
                                    _zoomEl = document.createElement('div');
                                    _zoomEl.style.cssText = 'position:fixed;bottom:20px;right:20px;' +
                                        'z-index:2147483647;background:rgba(0,0,0,0.65);color:#fff;' +
                                        'font:600 13px/1.4 system-ui,sans-serif;padding:5px 12px;' +
                                        'border-radius:4px;pointer-events:none;opacity:0;' +
                                        'transition:opacity 0.15s ease;';
                                    (document.body || document.documentElement).appendChild(_zoomEl);
                                }
                                _zoomEl.textContent = Math.round(z * 100) + '%';
                                _zoomEl.style.zoom = 1 / z;
                                _zoomEl.style.opacity = '1';
                                clearTimeout(_zoomTimer);
                                _zoomTimer = setTimeout(function() {
                                    if (_zoomEl) _zoomEl.style.opacity = '0';
                                }, 1500);
                            }
                            function _applyZoom(z) {
                                // Prefer WebView2's native page zoom: like the
                                // browser's own Ctrl+scroll, it shrinks the CSS-px
                                // viewport so vh/dvh units reflow, which keeps
                                // max-height:90vh modals inside the screen. CSS
                                // `zoom` (the fallback) only visually scales and
                                // leaves vh at its unzoomed value, so zoomed-in
                                // modals overflow top and bottom.
                                try {
                                    if (window.__TAURI__ && window.__TAURI__.webview) {
                                        window.__TAURI__.webview.getCurrentWebview().setZoom(z);
                                        return;
                                    }
                                } catch (err) {}
                                document.documentElement.style.zoom = z;
                            }
                            window.addEventListener('wheel', function(e) {
                                if (!e.ctrlKey || e.defaultPrevented) return;
                                e.preventDefault();
                                if (e.deltaY < 0 && _zi < ZOOM_LEVELS.length - 1) _zi++;
                                else if (e.deltaY > 0 && _zi > 0) _zi--;
                                var z = ZOOM_LEVELS[_zi];
                                _applyZoom(z);
                                _showZoom(z);
                            }, { passive: false });
                        })();"#,
                    )
                    .initialization_script(FILE_DIALOG_SCRIPT)
                    .initialization_script(LINK_SCRIPT)
                    // WebView2 drops target="_blank" and window.open() requests
                    // outright when no handler is registered, so hand them to
                    // the default browser. Plain links that would navigate the
                    // app itself off to another site go there too.
                    .on_new_window(|url, _features| {
                        spawn_open_in_browser(url);
                        tauri::webview::NewWindowResponse::Deny
                    })
                    .on_navigation(|url| {
                        if is_app_url(url) {
                            return true;
                        }
                        spawn_open_in_browser(url.clone());
                        false
                    });
            #[cfg(windows)]
            {
                builder = builder.data_directory(data_dir.join("webview"));
            }
            let window = builder.build()?;

            // decorations(false) removes the native title bar, but Windows 11's
            // DWM still rounds a borderless window's corners by default (the
            // "no title bar" look, not the "sharp edges" look) - opt back out.
            #[cfg(windows)]
            {
                use windows::Win32::Graphics::Dwm::{
                    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
                };
                if let Ok(hwnd) = window.hwnd() {
                    let pref = DWMWCP_DONOTROUND;
                    let result = unsafe {
                        DwmSetWindowAttribute(
                            hwnd,
                            DWMWA_WINDOW_CORNER_PREFERENCE,
                            &pref as *const _ as *const _,
                            std::mem::size_of_val(&pref) as u32,
                        )
                    };
                    if let Err(e) = result {
                        eprintln!("[window] failed to square off corners: {e}");
                    }
                }
            }

            // Lock down WebView2's default browser chrome - no right-click menu,
            // no F12/devtools, no other native browser shortcuts (Ctrl+P, Ctrl+F,
            // Ctrl+U, Alt+Left/Right nav, etc). F5/Ctrl+F5 are restored above.
            #[cfg(windows)]
            {
                let lockdown = window.with_webview(|webview| {
                    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                    use windows::core::Interface;

                    let result: windows::core::Result<()> = (|| unsafe {
                        let core = webview.controller().CoreWebView2()?;
                        let settings = core.Settings()?;
                        settings.SetAreDefaultContextMenusEnabled(false)?;
                        settings.SetAreDevToolsEnabled(false)?;
                        if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
                            settings3.SetAreBrowserAcceleratorKeysEnabled(false)?;
                        }
                        Ok(())
                    })();
                    if let Err(e) = result {
                        eprintln!("[webview] failed to lock down browser chrome: {e}");
                    }
                });
                if let Err(e) = lockdown {
                    eprintln!("[webview] with_webview failed: {e}");
                }
            }

            // System tray: lets a "minimize to tray" close choice actually mean
            // something. Double-clicking the icon or its "Open" menu item
            // restores the window; "Exit" fully quits (bypasses the close
            // prompt/tray behavior entirely, same as choosing "Exit" there).
            if let Some(tray_icon) = app.default_window_icon().cloned() {
                let tray_open = MenuItem::with_id(app, "tray_open", "Open", true, None::<&str>)?;
                let tray_exit = MenuItem::with_id(app, "tray_exit", "Exit", true, None::<&str>)?;
                let tray_menu = Menu::with_items(app, &[&tray_open, &tray_exit])?;
                TrayIconBuilder::new()
                    .icon(tray_icon)
                    .menu(&tray_menu)
                    .tooltip("EFTForge")
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "tray_open" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.unminimize();
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "tray_exit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::DoubleClick {
                            button: MouseButton::Left,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.unminimize();
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            } else {
                eprintln!("[tray] no default window icon configured - system tray disabled");
            }

            // Close button (and Alt+F4/taskbar close) never closes the window
            // directly - it's intercepted here so "minimize to tray" and "ask
            // every time" can both work regardless of what triggered the
            // close. A remembered choice (data/settings.json close_action,
            // set via the close-choice modal's "remember" checkbox or the
            // desktop settings modal) acts immediately with no prompt; "ask"
            // (the default) hands off to the frontend's own modal via this
            // event, which then calls back through close_to_tray/exit_app.
            let close_data_dir = data_dir.clone();
            let close_handle = handle.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    match read_close_action(&close_data_dir).as_str() {
                        "tray" => {
                            if let Some(w) = close_handle.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                        "exit" => close_handle.exit(0),
                        _ => {
                            let _ = close_handle.emit("close-requested", ());
                        }
                    }
                }
            });

            // Backend sidecar.
            let resource_dir = handle.path().resource_dir()?;
            let sidecar = handle
                .shell()
                .sidecar("eftforge-backend")?
                .env("EFTFORGE_DESKTOP", "1")
                .env("EFTFORGE_DATA_DIR", data_dir.to_string_lossy().to_string())
                .env(
                    "EFTFORGE_FRONTEND_DIR",
                    resource_dir.join("frontend").to_string_lossy().to_string(),
                )
                .env(
                    "EFTFORGE_RESOURCE_DIR",
                    resource_dir.to_string_lossy().to_string(),
                )
                .env(
                    "EFTFORGE_APP_VERSION",
                    handle.package_info().version.to_string(),
                )
                .current_dir(data_dir.clone());
            let (mut rx, child) = sidecar.spawn()?;
            #[cfg(windows)]
            put_pid_in_sidecar_job(child.pid());
            app.state::<BackendChild>().0.lock().unwrap().replace(child);

            let spawn_time = std::time::Instant::now();
            // The backend prints EFTFORGE_PORT before uvicorn actually binds
            // the listening socket, so navigating on that line alone races
            // the server startup - the webview would occasionally hit
            // connection-refused and show WebView2's "can't reach this page"
            // before the real page loads. Poll the port until it accepts a
            // TCP connection before navigating, so the splash only hands off
            // once the server is actually there to receive it.
            //
            // Sequencing: show the splash (green blob) for at least
            // MIN_SPLASH_MILLIS, and once the port is actually accepting
            // connections, call the splash's __eftforgeReady() hook - it
            // eases the blob to the site gold over 1s - then navigate after
            // READY_TRANSITION_MILLIS so the transition finishes on screen.
            const MIN_SPLASH_MILLIS: u64 = 600;
            const READY_TRANSITION_MILLIS: u64 = 1100;
            const PORT_POLL_INTERVAL_MILLIS: u64 = 60;
            const PORT_POLL_TIMEOUT_SECS: u64 = 20;

            async fn wait_for_port(port: &str) {
                let addr = format!("127.0.0.1:{port}");
                let deadline = std::time::Instant::now()
                    + std::time::Duration::from_secs(PORT_POLL_TIMEOUT_SECS);
                loop {
                    if tokio::net::TcpStream::connect(&addr).await.is_ok() {
                        return;
                    }
                    if std::time::Instant::now() >= deadline {
                        // Give up waiting and navigate anyway - better to show
                        // whatever error state the webview lands on than to
                        // hang on the splash forever.
                        return;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(
                        PORT_POLL_INTERVAL_MILLIS,
                    ))
                    .await;
                }
            }

            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            let line = String::from_utf8_lossy(&bytes);
                            let line = line.trim();
                            if let Some(status) = line.strip_prefix("EFTFORGE_STATUS=") {
                                // Forward known startup stages to the splash so it
                                // shows more than a static "starting..." message.
                                if let Ok(payload) = serde_json::to_string(status) {
                                    let _ = window.eval(&format!(
                                        "window.__eftforgeStatus && window.__eftforgeStatus({payload})"
                                    ));
                                }
                            }
                            if let Some(port) = line.strip_prefix("EFTFORGE_PORT=") {
                                let _ = window.eval(
                                    "window.__eftforgeStatus && window.__eftforgeStatus('connecting')",
                                );
                                wait_for_port(port).await;
                                let elapsed = spawn_time.elapsed().as_millis() as u64;
                                if elapsed < MIN_SPLASH_MILLIS {
                                    tokio::time::sleep(std::time::Duration::from_millis(
                                        MIN_SPLASH_MILLIS - elapsed,
                                    ))
                                    .await;
                                }
                                // Backend is genuinely reachable: play the
                                // ready transition, then hand off.
                                let _ = window.eval(
                                    "window.__eftforgeStatus && window.__eftforgeStatus('ready')",
                                );
                                let _ = window
                                    .eval("window.__eftforgeReady && window.__eftforgeReady()");
                                tokio::time::sleep(std::time::Duration::from_millis(
                                    READY_TRANSITION_MILLIS,
                                ))
                                .await;
                                let _ = window.eval(&format!(
                                    "window.location.replace('http://127.0.0.1:{port}/')"
                                ));
                            }
                            println!("[backend] {line}");
                        }
                        CommandEvent::Stderr(bytes) => {
                            eprintln!("[backend] {}", String::from_utf8_lossy(&bytes).trim_end());
                        }
                        CommandEvent::Error(err) => {
                            eprintln!("[backend] spawn error: {err}");
                            let message = format!("spawn error: {err}");
                            if let Ok(payload) = serde_json::to_string(&message) {
                                let _ = window.eval(&format!(
                                    "window.__eftforgeError && window.__eftforgeError({payload})"
                                ));
                            }
                        }
                        CommandEvent::Terminated(status) => {
                            eprintln!("[backend] exited: {status:?}");
                            // Harmless no-op if this fires after the splash has
                            // already navigated away (e.g. the sidecar dying
                            // during normal app shutdown) - __eftforgeError only
                            // exists on the splash page.
                            let message = format!("backend exited unexpectedly: {status:?}");
                            if let Ok(payload) = serde_json::to_string(&message) {
                                let _ = window.eval(&format!(
                                    "window.__eftforgeError && window.__eftforgeError({payload})"
                                ));
                            }
                        }
                        _ => {}
                    }
                }
            });

            // Update check, honoring the user's source preference.
            let update_handle = handle.clone();
            let source = read_update_source(&data_dir);
            tauri::async_runtime::spawn(async move {
                check_for_updates(update_handle, source).await;
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build EFTForge app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(child) = app.state::<BackendChild>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
