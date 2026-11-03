//! Tauri backend: exposes the w3proj core, file access, settings, extension
//! discovery and World Editor / game launching to the web UI.
//!
//! The backend stays small on purpose. Features live in UI extensions, which
//! reach the core only through these commands.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use w3proj::{project, Registry, UnpackOptions};

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Default)]
struct Watches(Mutex<Vec<PathBuf>>);

// ---------------------------------------------------------------- project

#[derive(Serialize)]
struct ProjectInfo {
    root: String,
    name: String,
    manifest: Value,
    default_output: String,
}

fn project_root(path: &str) -> PathBuf {
    let p = PathBuf::from(path);
    if p.file_name().is_some_and(|n| n == project::MANIFEST) {
        p.parent().map(Path::to_path_buf).unwrap_or(p)
    } else {
        p
    }
}

#[tauri::command]
fn project_open(path: String) -> CmdResult<ProjectInfo> {
    let root = project_root(&path);
    let manifest = project::Manifest::load(&root).map_err(err)?;
    Ok(ProjectInfo {
        name: manifest.display_name(&root),
        default_output: project::default_output(&root, &manifest)
            .to_string_lossy()
            .into_owned(),
        manifest: serde_json::to_value(&manifest).map_err(err)?,
        root: root.to_string_lossy().into_owned(),
    })
}

#[derive(Serialize)]
struct FileInfo {
    path: String,
    size: u64,
}

/// All project files except build output and VCS metadata.
#[tauri::command]
fn project_files(root: String) -> CmdResult<Vec<FileInfo>> {
    let root = PathBuf::from(root);
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).map_err(err)? {
            let entry = entry.map_err(err)?;
            let path = entry.path();
            let rel = path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
            if entry.file_type().map_err(err)?.is_dir() {
                if !matches!(rel.as_str(), "build" | ".git" | "node_modules") {
                    stack.push(path);
                }
            } else {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                out.push(FileInfo { path: rel, size });
            }
        }
    }
    out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(out)
}

/// Imports a map into `dir` (new project) or re-syncs an existing one.
#[tauri::command]
async fn project_unpack(app: AppHandle, map: String, dir: String, allow_incomplete: bool) -> CmdResult<Value> {
    let user_formats = user_format_dirs(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let opts = UnpackOptions { allow_incomplete };
        let codecs = Registry::for_project(Path::new(&dir), &user_formats).map_err(err)?;
        match w3proj::unpack(Path::new(&map), Path::new(&dir), &codecs, &opts) {
            Ok(report) => serde_json::to_value(&report).map_err(err),
            Err(w3proj::Error::Incomplete(r)) => Err(format!(
                "INCOMPLETE: {} unnamed and {} unreadable files (protected map?)",
                r.unnamed.len(),
                r.errors.len()
            )),
            Err(e) => Err(err(e)),
        }
    })
    .await
    .map_err(err)?
}

/// Creates an empty project for a new map (see `w3proj::create`).
#[tauri::command]
fn project_create(dir: String, name: String, flags: u32, max_players: u32) -> CmdResult<()> {
    let header = w3proj::header::MapHeader { name, flags, max_players, unknown: 0 };
    w3proj::create(Path::new(&dir), header).map_err(err)
}

#[tauri::command]
async fn project_pack(app: AppHandle, root: String, output: Option<String>) -> CmdResult<Value> {
    let user_formats = user_format_dirs(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let codecs = Registry::for_project(Path::new(&root), &user_formats).map_err(err)?;
        let r = w3proj::pack(
            Path::new(&root),
            output.as_deref().map(Path::new),
            &codecs,
        )
        .map_err(err)?;
        serde_json::to_value(&r).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Validates object-data JSON by encoding it, and returns it in canonical
/// formatting so edits from the UI produce minimal diffs.
#[tauri::command]
fn objects_canonicalize(name: String, text: String) -> CmdResult<String> {
    let stem = name.strip_suffix(".json").unwrap_or(&name);
    let opt = w3proj::objdata::kind(stem).ok_or("not an object data file")?;
    let bin = w3proj::objdata::from_json(text.as_bytes(), opt).map_err(err)?;
    let json = w3proj::objdata::to_json(&bin, opt).map_err(err)?;
    String::from_utf8(json).map_err(err)
}

/// Validates a codec-backed project file (e.g. `map/war3map.w3i.json`) by
/// encoding it to the archive format, and returns it in canonical form.
#[tauri::command]
fn codec_canonicalize(app: AppHandle, root: String, path: String, text: String) -> CmdResult<String> {
    let rel = path.strip_prefix("map/").unwrap_or(&path);
    let registry = Registry::for_project(Path::new(&root), &user_format_dirs(&app)?).map_err(err)?;
    let (stem, codec) = registry
        .for_project_path(rel)
        .ok_or_else(|| format!("{path} is not a codec-backed file"))?;
    let name = w3proj::paths::to_archive_name(&stem);
    let bin = codec.encode(&name, text.as_bytes()).map_err(err)?;
    let canonical = codec.decode(&name, &bin).map_err(err)?;
    String::from_utf8(canonical).map_err(err)
}

/// Decodes a raw project file (e.g. `map/war3map.doo`) to JSON with the
/// format definitions in effect, for viewers that read either form.
#[tauri::command]
fn codec_decode(app: AppHandle, root: String, path: String) -> CmdResult<String> {
    let rel = path.strip_prefix("map/").unwrap_or(&path);
    let registry = Registry::for_project(Path::new(&root), &user_format_dirs(&app)?).map_err(err)?;
    let name = w3proj::paths::to_archive_name(rel);
    let bytes = std::fs::read(Path::new(&root).join(&path)).map_err(err)?;
    let mut last = format!("no format definition reads {name}");
    for codec in registry.for_archive_name(&name) {
        match codec.decode(&name, &bytes) {
            Ok(json) => return String::from_utf8(json).map_err(err),
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

/// Encodes JSON (as produced by `codec_decode`) back to the archive format
/// and writes it to a raw project file (e.g. `map/war3map.doo`).
#[tauri::command]
fn codec_write(app: AppHandle, root: String, path: String, text: String) -> CmdResult<()> {
    let rel = path.strip_prefix("map/").unwrap_or(&path);
    let registry = Registry::for_project(Path::new(&root), &user_format_dirs(&app)?).map_err(err)?;
    let name = w3proj::paths::to_archive_name(rel);
    let mut last = format!("no format definition writes {name}");
    for codec in registry.for_archive_name(&name) {
        match codec.encode(&name, text.as_bytes()) {
            Ok(bin) => return std::fs::write(Path::new(&root).join(&path), bin).map_err(err),
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

/// The app's user format folder: `<config>/formats`.
fn user_format_dirs(app: &AppHandle) -> CmdResult<Vec<PathBuf>> {
    Ok(vec![config_dir(app)?.join("formats")])
}

#[derive(Serialize)]
struct FormatInfo {
    name: String,
    description: String,
    files: Vec<String>,
    /// "builtin", or the definition file's path.
    source: String,
    builtin: bool,
}

/// Format definitions in effect for a project (or without one).
#[tauri::command]
fn formats_list(app: AppHandle, root: Option<String>) -> CmdResult<Vec<FormatInfo>> {
    let user = user_format_dirs(&app)?;
    let registry = match root {
        Some(r) => Registry::for_project(Path::new(&r), &user),
        None => Registry::with_formats(&user),
    }
    .map_err(err)?;
    Ok(registry
        .formats()
        .into_iter()
        .map(|f| {
            let d = &f.def;
            let (source, builtin) = match &d.source {
                w3proj::format::Source::Builtin => ("builtin".to_string(), true),
                w3proj::format::Source::File(p) => (p.to_string_lossy().into_owned(), false),
            };
            FormatInfo { name: d.name.clone(), description: d.description.clone(), files: d.files.clone(), source, builtin }
        })
        .collect())
}

/// Copies a built-in definition into `<project>/.w3proj/formats/<name>.json`
/// so it can be edited; returns the new file's path.
#[tauri::command]
fn format_customize(root: String, name: String) -> CmdResult<String> {
    let text = w3proj::format::builtin_text(&name).ok_or_else(|| format!("no built-in format {name:?}"))?;
    let dir = w3proj::format::project_dir(Path::new(&root));
    std::fs::create_dir_all(&dir).map_err(err)?;
    let path = dir.join(format!("{name}.json"));
    if !path.exists() {
        std::fs::write(&path, text).map_err(err)?;
    }
    Ok(path.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------- files

#[tauri::command]
fn fs_read_text(path: String) -> CmdResult<String> {
    let bytes = std::fs::read(&path).map_err(err)?;
    String::from_utf8(bytes).map_err(|_| "NOT_UTF8".to_string())
}

#[tauri::command]
fn fs_write_text(path: String, text: String) -> CmdResult<()> {
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::write(&path, text).map_err(err)
}

/// Writes the raw request body to the file named by the (URI-encoded) `path`
/// header; binary files skip JSON encoding this way.
#[tauri::command]
fn fs_write_bytes(request: tauri::ipc::Request<'_>) -> CmdResult<()> {
    let path = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing path header")?;
    let path = percent_decode(path)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw byte body".into());
    };
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::write(&path, bytes).map_err(err)
}

/// Decodes `%XX` escapes (as produced by encodeURIComponent).
fn percent_decode(s: &str) -> CmdResult<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).map_err(err)?;
            out.push(u8::from_str_radix(hex, 16).map_err(err)?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(err)
}

#[tauri::command]
fn fs_read_bytes(path: String) -> CmdResult<tauri::ipc::Response> {
    Ok(tauri::ipc::Response::new(std::fs::read(&path).map_err(err)?))
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn ShowCursor(show: i32) -> i32;
}

/// Makes the mouse pointer visible before a native dialog opens. With
/// Windows' "hide pointer while typing", the web view hides it on a key
/// press and only shows it again when the mouse moves over the page, which
/// a dialog opened from the keyboard (command palette, shortcut) prevents.
/// The display counter is shared with the dialog (same UI thread).
#[tauri::command]
fn ui_show_cursor(app: AppHandle) -> CmdResult<()> {
    #[cfg(windows)]
    app.run_on_main_thread(|| unsafe {
        let mut count = ShowCursor(1);
        while count < 0 {
            count = ShowCursor(1);
        }
        // It was visible already: undo the extra increment.
        if count > 0 {
            ShowCursor(0);
        }
    })
    .map_err(err)?;
    #[cfg(not(windows))]
    let _ = app;
    Ok(())
}

/// A file path inside `root` (the open project); deleting and renaming go
/// nowhere else.
fn inside(root: &str, path: &str) -> CmdResult<PathBuf> {
    let root = std::fs::canonicalize(root).map_err(|e| format!("{root}: {e}"))?;
    let p = PathBuf::from(path);
    let parent = p.parent().ok_or("no parent folder")?;
    let parent = std::fs::canonicalize(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    if !parent.starts_with(&root) {
        return Err(format!("{path} is outside the project"));
    }
    Ok(parent.join(p.file_name().ok_or("no file name")?))
}

/// Deletes a file of the project; empty folders it leaves behind go too (up to the root).
#[tauri::command]
fn fs_delete(root: String, path: String) -> CmdResult<()> {
    let p = inside(&root, &path)?;
    std::fs::remove_file(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    let root = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
    let mut dir = p.parent().map(Path::to_path_buf);
    while let Some(d) = dir {
        if d == root || std::fs::remove_dir(&d).is_err() {
            break;
        }
        dir = d.parent().map(Path::to_path_buf);
    }
    Ok(())
}

/// Renames (moves) a file within the project, creating folders as needed.
#[tauri::command]
fn fs_rename(root: String, from: String, to: String) -> CmdResult<()> {
    let src = inside(&root, &from)?;
    // Checked as written before any folder is created, then again resolved.
    let target = Path::new(&to);
    if target.components().any(|c| matches!(c, std::path::Component::ParentDir)) || !target.starts_with(&root) {
        return Err(format!("{to} is outside the project"));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let dst = inside(&root, &to)?;
    if dst.exists() {
        return Err(format!("{to} already exists"));
    }
    std::fs::rename(&src, &dst).map_err(|e| format!("{}: {e}", src.display()))
}

#[tauri::command]
fn fs_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> CmdResult<()> {
    // Explorer only understands backslashes, and needs `/select,"path"` as one
    // raw argument (Rust would quote the whole thing, which it misreads).
    let native = path.replace('/', "\\");
    let p = PathBuf::from(&native);
    let mut cmd = Command::new("explorer");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if p.is_file() {
            cmd.raw_arg(format!("/select,\"{native}\""));
        } else {
            cmd.raw_arg(format!("\"{native}\""));
        }
    }
    #[cfg(not(windows))]
    cmd.arg(&p);
    cmd.spawn().map(|_| ()).map_err(err)
}

// ---------------------------------------------------------------- settings & extensions

fn config_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app.path().app_config_dir().map_err(err)?;
    std::fs::create_dir_all(dir.join("extensions")).map_err(err)?;
    Ok(dir)
}

#[derive(Serialize)]
struct Paths {
    config_dir: String,
    settings: String,
    user_extensions: String,
}

#[tauri::command]
fn app_paths(app: AppHandle) -> CmdResult<Paths> {
    let dir = config_dir(&app)?;
    let s = |p: PathBuf| p.to_string_lossy().into_owned();
    Ok(Paths {
        settings: s(dir.join("settings.json")),
        user_extensions: s(dir.join("extensions")),
        config_dir: s(dir),
    })
}

#[derive(Serialize)]
struct ExternalExtension {
    dir: String,
    source: &'static str,
    manifest: Value,
    main_source: Option<String>,
}

fn scan_extensions(dir: &Path, source: &'static str, out: &mut Vec<ExternalExtension>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    for d in dirs {
        let Ok(text) = std::fs::read_to_string(d.join("extension.json")) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let main = manifest
            .get("main")
            .and_then(Value::as_str)
            .and_then(|m| std::fs::read_to_string(d.join(m)).ok());
        out.push(ExternalExtension {
            dir: d.to_string_lossy().into_owned(),
            source,
            manifest,
            main_source: main,
        });
    }
}

/// User extensions (config dir) plus project-local ones
/// (`<project>/.w3proj/extensions`).
#[tauri::command]
fn extensions_scan(app: AppHandle, project_root: Option<String>) -> CmdResult<Vec<ExternalExtension>> {
    let mut out = Vec::new();
    scan_extensions(&config_dir(&app)?.join("extensions"), "user", &mut out);
    if let Some(root) = project_root {
        scan_extensions(&Path::new(&root).join(".w3proj").join("extensions"), "project", &mut out);
    }
    Ok(out)
}

// ---------------------------------------------------------------- game data (CASC)

/// The opened game storage, keyed by install folder. Opening takes a moment
/// (index + encoding + root), so it happens once, on first use.
#[derive(Default)]
struct Game(Mutex<Option<(PathBuf, Arc<casc::GameData>)>>);

fn game_data(state: &Game, install: &str) -> CmdResult<Arc<casc::GameData>> {
    let mut guard = state.0.lock().unwrap();
    if let Some((dir, g)) = guard.as_ref() {
        if dir == Path::new(install) {
            return Ok(g.clone());
        }
    }
    let g = Arc::new(casc::GameData::open(Path::new(install)).map_err(|e| format!("game data: {e}"))?);
    *guard = Some((PathBuf::from(install), g.clone()));
    Ok(g)
}

fn mode(m: &str) -> CmdResult<casc::Mode> {
    casc::Mode::parse(m).ok_or_else(|| format!("unknown graphics mode {m:?} (sd, hd or de)"))
}

#[derive(Serialize)]
struct GameInfo {
    version: String,
    locale: String,
    entries: usize,
    stored: usize,
}

#[tauri::command]
async fn game_info(state: State<'_, Game>, install: String) -> CmdResult<GameInfo> {
    let g = game_data(&state, &install)?;
    Ok(GameInfo {
        version: g.storage.build.version.clone(),
        locale: g.locale.clone(),
        entries: g.total_entries(),
        stored: g.local_paths().count(),
    })
}

/// Newline-separated full paths of every stored file (one string keeps the
/// IPC payload small for ~90k entries).
#[tauri::command]
async fn game_list(state: State<'_, Game>, install: String) -> CmdResult<String> {
    let g = game_data(&state, &install)?;
    Ok(g.local_paths().collect::<Vec<_>>().join("\n"))
}

/// Resolves a plain path (`Units\UnitData.slk`) to the stored full path.
#[tauri::command]
async fn game_resolve(state: State<'_, Game>, install: String, path: String, mode_name: String) -> CmdResult<Option<String>> {
    let g = game_data(&state, &install)?;
    Ok(g.resolve(&path, mode(&mode_name)?, None).map(str::to_string))
}

/// Reads a full path (`War3.w3mod:…`) as-is, or resolves a plain path.
#[tauri::command]
async fn game_read(state: State<'_, Game>, install: String, path: String, mode_name: String) -> CmdResult<tauri::ipc::Response> {
    let g = game_data(&state, &install)?;
    let bytes = if path.contains(".w3mod:") {
        g.read_exact(&path)
    } else {
        g.read(&path, mode(&mode_name)?, None).map(|(_, b)| b)
    }
    .map_err(err)?;
    Ok(tauri::ipc::Response::new(bytes))
}

// ---------------------------------------------------------------- World Editor & game

fn modified(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// Launches an executable with `-launch -loadfile <map>`. `-launch` makes the
/// Reforged binaries start directly instead of bouncing to the launcher.
fn launch(exe: &str, map: &str) -> CmdResult<std::process::Child> {
    if !Path::new(exe).exists() {
        return Err(format!("not found: {exe} (check settings)"));
    }
    Command::new(exe)
        .args(["-launch", "-loadfile", map])
        .current_dir(Path::new(exe).parent().unwrap_or(Path::new(".")))
        .spawn()
        .map_err(err)
}

/// Opens a map in the World Editor and watches it. Every time the editor
/// saves, `w3://map-saved` is emitted so the UI can sync the project.
#[tauri::command]
fn world_editor_open(app: AppHandle, watches: State<Watches>, exe: String, map: String, root: String) -> CmdResult<()> {
    let mut child = launch(&exe, &map)?;
    let map_path = PathBuf::from(&map);
    watches.0.lock().unwrap().push(map_path.clone());
    std::thread::spawn(move || {
        let mut last = modified(&map_path);
        loop {
            std::thread::sleep(Duration::from_millis(1000));
            let exited = !matches!(child.try_wait(), Ok(None));
            let now = modified(&map_path);
            if now != last {
                last = now;
                // Give the editor a moment to finish writing.
                std::thread::sleep(Duration::from_millis(1500));
                last = modified(&map_path).or(last);
                let _ = app.emit("w3://map-saved", serde_json::json!({ "map": map, "root": root }));
            }
            if exited {
                let _ = app.emit("w3://world-editor-exited", serde_json::json!({ "map": map, "root": root }));
                let w = app.state::<Watches>();
                w.0.lock().unwrap().retain(|p| p != &map_path);
                break;
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn game_test_map(exe: String, map: String) -> CmdResult<()> {
    launch(&exe, &map).map(|_| ())
}

#[tauri::command]
fn watched_maps(watches: State<Watches>) -> Vec<String> {
    watches
        .0
        .lock()
        .unwrap()
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Watches::default())
        .manage(Game::default())
        .invoke_handler(tauri::generate_handler![
            project_open,
            project_files,
            project_unpack,
            project_create,
            ui_show_cursor,
            project_pack,
            objects_canonicalize,
            codec_canonicalize,
            codec_decode,
            codec_write,
            formats_list,
            format_customize,
            fs_read_text,
            fs_write_text,
            fs_write_bytes,
            fs_delete,
            fs_rename,
            fs_read_bytes,
            fs_exists,
            reveal_in_explorer,
            app_paths,
            extensions_scan,
            world_editor_open,
            game_test_map,
            watched_maps,
            game_info,
            game_list,
            game_resolve,
            game_read,
        ])
        .run(tauri::generate_context!())
        .expect("error while running W3Proj Studio");
}

#[cfg(test)]
mod fs_tests {
    use super::*;

    fn project() -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("w3proj-fs-test-{}-{}", std::process::id(), rand_suffix()));
        std::fs::create_dir_all(dir.join("map/sub")).unwrap();
        std::fs::write(dir.join("map/sub/a.txt"), b"a").unwrap();
        let root = dir.to_string_lossy().into_owned();
        (dir, root)
    }
    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    #[test]
    fn rename_inside_and_delete_removes_empty_folders() {
        let (dir, root) = project();
        let from = dir.join("map/sub/a.txt").to_string_lossy().into_owned();
        let to = dir.join("map/new/deep/b.txt").to_string_lossy().into_owned();
        fs_rename(root.clone(), from.clone(), to.clone()).unwrap();
        assert!(!Path::new(&from).exists() && Path::new(&to).exists());
        fs_delete(root.clone(), to).unwrap();
        // The emptied folders go, the project root and map/ stay (map/sub is empty but wasn't touched).
        assert!(!dir.join("map/new").exists());
        assert!(dir.join("map").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn nothing_outside_the_project() {
        let (dir, root) = project();
        let from = dir.join("map/sub/a.txt").to_string_lossy().into_owned();
        let outside = std::env::temp_dir().join(format!("w3proj-outside-{}", rand_suffix()));
        assert!(fs_rename(root.clone(), from.clone(), outside.join("x.txt").to_string_lossy().into_owned()).is_err());
        assert!(!outside.exists(), "no folder created outside");
        let sneaky = format!(r"{root}\map\..\..\escape.txt");
        assert!(fs_rename(root.clone(), from.clone(), sneaky).is_err());
        let victim = std::env::temp_dir().join(format!("w3proj-victim-{}.txt", rand_suffix()));
        std::fs::write(&victim, b"keep").unwrap();
        assert!(fs_delete(root.clone(), victim.to_string_lossy().into_owned()).is_err());
        assert!(victim.exists());
        std::fs::remove_file(victim).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
