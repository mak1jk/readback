//! ReadBack backend: finds agent session files on disk, reads them on demand,
//! and watches agent folders so new or appended sessions reach the UI live.

mod summary;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use notify::{RecursiveMode, Watcher};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize, Deserialize, Clone)]
struct FileInfo {
    path: String,
    name: String,
    size: u64,
    /// Modification time, epoch milliseconds.
    mtime: u64,
}

#[derive(Serialize, Deserialize, Clone)]
struct ScanItem {
    #[serde(flatten)]
    file: FileInfo,
    summary: Option<summary::Summary>,
}

/// Summaries cached by path; an entry is reused while size and mtime are unchanged.
#[derive(Default)]
struct ScanCache {
    loaded: Mutex<bool>,
    entries: Mutex<HashMap<String, ScanItem>>,
}

const CACHE_FILE: &str = "scan-index-v2.json";

fn summarize(agent: &str, path: &Path) -> Option<summary::Summary> {
    match agent {
        "codex" => summary::codex(path),
        _ => summary::external(agent, path),
    }
}

#[derive(Default)]
struct Watchers {
    roots: Mutex<HashSet<(String, PathBuf)>>,
    handles: Mutex<Vec<notify::RecommendedWatcher>>,
}

fn expand(app: &AppHandle, p: &str) -> Result<PathBuf, String> {
    if p == "~" || p.starts_with("~/") {
        let home = app.path().home_dir().map_err(|e| e.to_string())?;
        return Ok(if p == "~" { home } else { home.join(&p[2..]) });
    }
    Ok(PathBuf::from(p))
}

fn info(path: &Path) -> Option<FileInfo> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(FileInfo {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name()?.to_string_lossy().into_owned(),
        size: meta.len(),
        mtime,
    })
}

fn has_ext(path: &Path, exts: &[String]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| exts.iter().any(|x| x.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

/// Recursively list session files under `path` with a list-view summary each, newest first.
/// Summaries are computed in parallel and cached in the app data dir. A missing folder yields [].
#[tauri::command]
async fn scan_agent(app: AppHandle, agent: String, path: String, exts: Vec<String>) -> Result<Vec<ScanItem>, String> {
    let root = expand(&app, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !root.is_dir() {
            return Ok(vec![]);
        }
        let cache = app.state::<ScanCache>();
        let cache_path = app.path().app_data_dir().map_err(|e| e.to_string())?.join(CACHE_FILE);
        {
            let mut loaded = cache.loaded.lock().unwrap();
            if !*loaded {
                *loaded = true;
                if let Ok(bytes) = std::fs::read(&cache_path) {
                    if let Ok(map) = serde_json::from_slice::<HashMap<String, ScanItem>>(&bytes) {
                        *cache.entries.lock().unwrap() = map;
                    }
                }
            }
        }
        let files: Vec<FileInfo> = walkdir::WalkDir::new(&root)
            .follow_links(true)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file() && has_ext(e.path(), &exts))
            .filter_map(|e| info(e.path()))
            .collect();
        #[cfg(debug_assertions)]
        let started = std::time::Instant::now();
        let known = cache.entries.lock().unwrap().clone();
        let mut fresh = 0usize;
        let mut out: Vec<ScanItem> = files
            .into_par_iter()
            .map(|f| match known.get(&format!("{agent}:{}", f.path)) {
                Some(c) if c.file.size == f.size && c.file.mtime == f.mtime => (c.clone(), false),
                _ => {
                    let summary = summarize(&agent, Path::new(&f.path));
                    (ScanItem { file: f, summary }, true)
                }
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|(item, new)| {
                fresh += new as usize;
                item
            })
            .collect();
        if fresh > 0 {
            let mut entries = cache.entries.lock().unwrap();
            for it in &out {
                entries.insert(format!("{agent}:{}", it.file.path), it.clone());
            }
            if let Some(dir) = cache_path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&cache_path, serde_json::to_vec(&*entries).unwrap_or_default());
        }
        #[cfg(debug_assertions)]
        eprintln!("[scan] {agent} {}: {} files, {} summarized, {} sessions, {:?}", root.display(), out.len(), fresh, out.iter().filter(|i| i.summary.is_some()).count(), started.elapsed());
        out.sort_by(|a, b| b.file.mtime.cmp(&a.file.mtime));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Summaries for specific files (watcher updates), bypassing the cache.
#[tauri::command]
fn summarize_files(agent: String, paths: Vec<String>) -> Vec<ScanItem> {
    paths
        .iter()
        .filter_map(|p| info(Path::new(p)))
        .map(|f| {
            let summary = summarize(&agent, Path::new(&f.path));
            ScanItem { file: f, summary }
        })
        .collect()
}

#[tauri::command]
fn stat_files(paths: Vec<String>) -> Vec<FileInfo> {
    paths.iter().filter_map(|p| info(Path::new(p))).collect()
}

/// Raw file bytes (an ArrayBuffer on the JS side) — avoids JSON-encoding very large sessions.
#[tauri::command]
async fn read_session(path: String) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(tokio_read(&path).await?))
}

async fn tokio_read(path: &str) -> Result<Vec<u8>, String> {
    let path = path.to_owned();
    tauri::async_runtime::spawn_blocking(move || std::fs::read(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

/// Watch `path` recursively and emit `session-file-changed` with a `FileInfo` whenever a matching
/// file is created or modified. Watching the same folder twice is a no-op.
#[tauri::command]
fn watch_folder(app: AppHandle, state: State<'_, Watchers>, agent: String, path: String, exts: Vec<String>) -> Result<(), String> {
    let root = expand(&app, &path)?;
    let key = (agent.clone(), root.clone());
    if !root.is_dir() || state.roots.lock().unwrap().contains(&key) {
        return Ok(());
    }
    let handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        if !(ev.kind.is_create() || ev.kind.is_modify()) {
            return;
        }
        for p in ev.paths.iter().filter(|p| has_ext(p, &exts)) {
            if let Some(fi) = info(p) {
                let _ = handle.emit("session-file-changed", serde_json::json!({"agent": agent, "path": fi.path, "name": fi.name, "size": fi.size, "mtime": fi.mtime}));
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    state.roots.lock().unwrap().insert(key);
    state.handles.lock().unwrap().push(watcher);
    Ok(())
}

fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let import = MenuItemBuilder::with_id("import", "Import Files…").accelerator("CmdOrCtrl+O").build(app)?;
    let folder = MenuItemBuilder::with_id("open-folder", "Open Sessions Folder…").accelerator("CmdOrCtrl+Shift+O").build(app)?;
    let find = MenuItemBuilder::with_id("find", "Find").accelerator("CmdOrCtrl+F").build(app)?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&import)
        .item(&folder)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&find)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().fullscreen().build()?;
    let mut menu = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "ReadBack")
            .about(None)
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu = menu.item(&app_menu);
    }
    menu.item(&file).item(&edit).item(&window).build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Watchers::default())
        .manage(ScanCache::default())
        .setup(|app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, ev| {
                let id = ev.id().as_ref();
                if matches!(id, "import" | "open-folder" | "find") {
                    let _ = app.emit("menu", id);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![scan_agent, summarize_files, stat_files, read_session, write_text_file, watch_folder])
        .run(tauri::generate_context!())
        .expect("error while running ReadBack");
}
