//! Tauri backend: exposes the w3proj core, file access, settings, extension
//! discovery and World Editor / game launching to the web UI.
//!
//! The backend stays small on purpose. Features live in UI extensions, which
//! reach the core only through these commands.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

mod mcp;
mod mcpclients;

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

/// `\\?\C:\x` as `C:\x`, `\\?\UNC\server\share\x` as `\\server\share\x`: the verbatim prefix
/// canonicalize puts on a Windows path, taken off again. Anything else stays as it is.
fn strip_verbatim(s: &str) -> String {
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.to_string()
    }
}

/// A path on a mapped drive as the user wrote it, without trailing separators. A bare drive
/// (`Z:`) means the current folder on that drive, so the drive's root keeps its separator.
fn keep_spelling(path: &str) -> String {
    let t = path.trim_end_matches(['\\', '/']);
    if t.len() == 2 { format!(r"{t}\") } else { t.to_string() }
}

/// A path in one spelling: symlinks and, on Windows, 8.3 short names resolved (`KONSTA~1` is
/// `Konstantin`), without the `\\?\` prefix canonicalize adds. A path that can't be resolved
/// (it isn't there) stays as it is. A path on a mapped network drive (`Z:\`) keeps its drive
/// letter: canonicalize would turn it into the share's UNC name.
fn normal_path(path: &str) -> String {
    let Ok(p) = std::fs::canonicalize(path) else { return path.to_string() };
    let s = strip_verbatim(&p.to_string_lossy());
    let has_drive = path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic();
    if has_drive && s.starts_with(r"\\") {
        return keep_spelling(path);
    }
    s
}

/// The path in one spelling (see `normal_path`): the key open tabs are remembered under. Off the
/// UI thread: an offline share can take a long time to answer.
#[tauri::command]
async fn path_normalize(path: String) -> String {
    let fallback = path.clone();
    tauri::async_runtime::spawn_blocking(move || normal_path(&path)).await.unwrap_or(fallback)
}

#[tauri::command]
fn project_open(path: String) -> CmdResult<ProjectInfo> {
    let root = PathBuf::from(normal_path(&project_root(&path).to_string_lossy()));
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
    /// Last write, ms since the Unix epoch (0 if unknown): to notice changes made outside the app.
    modified: u64,
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
                let meta = entry.metadata().ok();
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified = meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                out.push(FileInfo { path: rel, size, modified });
            }
        }
    }
    out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(out)
}

/// Imports a map into `dir` (new project) or re-syncs an existing one.
#[tauri::command]
async fn project_unpack(app: AppHandle, map: String, dir: String, allow_incomplete: bool, install: Option<String>) -> CmdResult<Value> {
    let user_formats = user_format_dirs(&app)?;
    // The game's file names, for files a map has replaced (asked only when names are missing).
    let install = install.filter(|i| !i.is_empty());
    let more_names = install.clone().map(|install| {
        let app = app.clone();
        Arc::new(move || match game_data(&app.state::<Game>(), &install) {
            Ok(g) => w3proj::names::from_game_paths(g.all_paths()),
            Err(_) => Vec::new(),
        }) as w3proj::project::NameSource
    });
    // GUI triggers (war3map.wtg) become JSON when the game's TriggerData.txt can be read.
    // W3PROJ_TRIGGERDATA (debug builds only, for the app smoke test): a TriggerData.txt to use
    // instead of the game's. An unreadable file is an error, never a silent fallback.
    #[cfg(debug_assertions)]
    let trigger_data: Option<w3proj::codec::TriggerDataSource> = match std::env::var_os("W3PROJ_TRIGGERDATA").map(PathBuf::from) {
        Some(file) => {
            let bytes = std::fs::read(&file).map_err(|e| format!("W3PROJ_TRIGGERDATA {}: {e}", file.display()))?;
            let data = Arc::new(w3proj::triggerdata::TriggerData::parse(&String::from_utf8_lossy(&bytes)));
            Some(Arc::new(move || Some(data.clone())))
        }
        None => None,
    };
    #[cfg(not(debug_assertions))]
    let trigger_data: Option<w3proj::codec::TriggerDataSource> = None;
    let trigger_data = trigger_data.or_else(|| install.map(|install| {
        let app = app.clone();
        Arc::new(move || {
            let g = game_data(&app.state::<Game>(), &install).ok()?;
            let (_, bytes) = g.read(r"UI\TriggerData.txt", casc::Mode::Hd, None).ok()?;
            Some(Arc::new(w3proj::triggerdata::TriggerData::parse(&String::from_utf8_lossy(&bytes))))
        }) as w3proj::codec::TriggerDataSource
    }));
    tauri::async_runtime::spawn_blocking(move || {
        let opts = UnpackOptions { allow_incomplete, more_names };
        let mut codecs = Registry::for_project(Path::new(&dir), &user_formats).map_err(err)?;
        if let Some(source) = trigger_data {
            codecs.set_trigger_data(source);
        }
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

/// Creates an empty project for a new map, or a new campaign with `campaign` (see `w3proj::create`).
#[tauri::command]
fn project_create(dir: String, name: String, flags: u32, max_players: u32, campaign: Option<bool>, header: Option<bool>) -> CmdResult<()> {
    // Campaigns have no map header; maps saved by World Editor 3.0.1 don't either (`header: false`).
    let with_header = !campaign.unwrap_or(false) && header.unwrap_or(true);
    let header = with_header.then_some(w3proj::header::MapHeader { name, flags, max_players, unknown: 0 });
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

/// Writes object data (`text`, in project JSON) as the game's binary file, which the
/// World Editor imports. `name` says which kind, like `war3map.w3u`.
#[tauri::command]
fn objects_export(name: String, text: String, path: String) -> CmdResult<()> {
    let opt = w3proj::objdata::kind(&name).ok_or("not an object data file")?;
    let bin = w3proj::objdata::from_json(text.as_bytes(), opt).map_err(err)?;
    std::fs::write(&path, bin).map_err(err)
}

/// Reads a binary object data file, like one the World Editor exported, as project JSON.
#[tauri::command]
fn objects_import(name: String, path: String) -> CmdResult<String> {
    let opt = w3proj::objdata::kind(&name).ok_or("not an object data file")?;
    let bin = std::fs::read(&path).map_err(err)?;
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

/// The project's folders (forward slashes), the ones without files too; what `project_files`
/// leaves out is left out here.
#[tauri::command]
fn project_folders(root: String) -> CmdResult<Vec<String>> {
    let root = PathBuf::from(root);
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).map_err(err)? {
            let entry = entry.map_err(err)?;
            if !entry.file_type().map_err(err)?.is_dir() {
                continue;
            }
            let path = entry.path();
            let rel = path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
            if !matches!(rel.as_str(), "build" | ".git" | "node_modules") {
                stack.push(path);
                out.push(rel);
            }
        }
    }
    Ok(out)
}

/// Creates a folder of the project (with the folders above it).
#[tauri::command]
fn fs_mkdir(root: String, path: String) -> CmdResult<()> {
    let target = Path::new(&path);
    if target.components().any(|c| matches!(c, std::path::Component::ParentDir)) || !target.starts_with(&root) {
        return Err(format!("{path} is outside the project"));
    }
    std::fs::create_dir_all(target).map_err(|e| format!("{path}: {e}"))
}

/// Removes an empty folder of the project (a folder with anything in it stays: it fails).
#[tauri::command]
fn fs_rmdir(root: String, path: String) -> CmdResult<()> {
    let p = inside(&root, &path)?;
    std::fs::remove_dir(&p).map_err(|e| format!("{}: {e}", p.display()))
}

/// Deletes a file of the project; empty folders it leaves behind go too (up to the root).
#[tauri::command]
fn fs_delete(root: String, path: String) -> CmdResult<()> {
    let p = inside(&root, &path)?;
    std::fs::remove_file(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    remove_empty_parents(&root, &p)
}

/// Removes the folders above `file` that are empty now (up to the project root; the project's
/// `map` folder stays even when its last file goes).
fn remove_empty_parents(root: &str, file: &Path) -> CmdResult<()> {
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let map = root.join("map");
    let mut dir = file.parent().map(Path::to_path_buf);
    while let Some(d) = dir {
        if d == root || d == map || std::fs::remove_dir(&d).is_err() {
            break;
        }
        dir = d.parent().map(Path::to_path_buf);
    }
    Ok(())
}

/// Renames (moves) a file within the project, creating folders as needed; folders it
/// leaves empty are removed.
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
    std::fs::rename(&src, &dst).map_err(|e| format!("{}: {e}", src.display()))?;
    // A folder the file was the last one in goes too (as when deleting).
    remove_empty_parents(&root, &src)
}

/// Copies a file (creating folders as needed), without passing its bytes through the webview:
/// imports and exports of large files (maps, campaigns, movies).
#[tauri::command]
async fn fs_copy(from: String, to: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = Path::new(&to).parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::copy(&from, &to).map(|_| ()).map_err(|e| format!("{from} → {to}: {e}"))
    })
    .await
    .map_err(err)?
}

/// Every file below a folder (any folder, for importing), as sorted paths relative to it with
/// `/` separators. Links aren't followed, so a link back up can't make this endless.
#[tauri::command]
async fn fs_list_tree(path: String) -> CmdResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || list_tree(Path::new(&path)))
        .await
        .map_err(err)?
}

fn list_tree(root: &Path) -> CmdResult<Vec<String>> {
    let mut files = Vec::new();
    let mut pending = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = pending.pop() {
        for entry in std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))? {
            let entry = entry.map_err(|e| format!("{}: {e}", dir.display()))?;
            let name = entry.file_name().into_string().map_err(|n| format!("{}: unusable file name", dir.join(n).display()))?;
            let kind = entry.file_type().map_err(|e| format!("{}: {e}", entry.path().display()))?;
            if kind.is_dir() {
                pending.push((entry.path(), format!("{prefix}{name}/")));
            } else if kind.is_file() {
                files.push(format!("{prefix}{name}"));
            }
        }
    }
    files.sort();
    Ok(files)
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
    user_guides: String,
}

#[tauri::command]
fn app_paths(app: AppHandle) -> CmdResult<Paths> {
    let dir = config_dir(&app)?;
    let s = |p: PathBuf| p.to_string_lossy().into_owned();
    Ok(Paths {
        settings: s(dir.join("settings.json")),
        user_extensions: s(dir.join("extensions")),
        user_guides: s(dir.join("guides")),
        config_dir: s(dir),
    })
}

/// Removes a user's guide, or their rules for a built-in one. A topic is a plain name, so nothing else can go.
#[tauri::command]
fn guide_remove(app: AppHandle, topic: String) -> CmdResult<()> {
    if topic.is_empty() || !topic.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ' ')) {
        return Err(format!("{topic:?} is no guide"));
    }
    let path = config_dir(&app)?.join("guides").join(format!("{topic}.md"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(err)?;
    }
    Ok(())
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
async fn game_resolve(state: State<'_, Game>, install: String, path: String, mode_name: String, tileset: Option<String>) -> CmdResult<Option<String>> {
    let g = game_data(&state, &install)?;
    Ok(g.resolve(&path, mode(&mode_name)?, tileset_letter(&tileset)).map(str::to_string))
}

/** A tileset letter ("L"), which adds that tileset's folders (`_Tilesets/L.w3mod`) to the lookup. */
fn tileset_letter(t: &Option<String>) -> Option<char> {
    t.as_deref().and_then(|s| s.chars().next())
}

/// Reads a full path (`War3.w3mod:…`) as-is, or resolves a plain path.
#[tauri::command]
async fn game_read(state: State<'_, Game>, install: String, path: String, mode_name: String, tileset: Option<String>) -> CmdResult<tauri::ipc::Response> {
    let g = game_data(&state, &install)?;
    let bytes = if path.contains(".w3mod:") {
        g.read_exact(&path)
    } else {
        g.read(&path, mode(&mode_name)?, tileset_letter(&tileset)).map(|(_, b)| b)
    }
    .map_err(err)?;
    Ok(tauri::ipc::Response::new(bytes))
}

// ---------------------------------------------------------------- World Editor & game

fn modified(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// Launches an executable with `-launch -loadfile <map>` and `extra` arguments. `-launch`
/// makes the Reforged binaries start directly instead of bouncing to the launcher.
fn launch(exe: &str, map: &str, extra: &[&str]) -> CmdResult<std::process::Child> {
    if !Path::new(exe).exists() {
        return Err(format!("not found: {exe} (check settings)"));
    }
    Command::new(exe)
        .args(["-launch", "-loadfile", map])
        .args(extra)
        .current_dir(Path::new(exe).parent().unwrap_or(Path::new(".")))
        .spawn()
        .map_err(err)
}

/// Opens a map in the World Editor and watches it. Every time the editor
/// saves, `w3://map-saved` is emitted so the UI can sync the project.
#[tauri::command]
fn world_editor_open(app: AppHandle, watches: State<Watches>, exe: String, map: String, root: String) -> CmdResult<()> {
    let mut child = launch(&exe, &map, &[])?;
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

/// Starts the game with the map as the World Editor's Test Map does (seen on 3.0.1): normal
/// difficulty, the "WorldEdit" test profile (not the player's own), a fixed random seed.
/// Unlike the World Editor, which Battle.net starts with its session, the game asks for a
/// login when this app wasn't started by Battle.net.
#[tauri::command]
fn game_test_map(exe: String, map: String) -> CmdResult<()> {
    launch(&exe, &map, &["-mapdiff", "1", "-testmapprofile", "WorldEdit", "-fixedseed", "1"]).map(|_| ())
}

/// What an external tool run printed and returned.
#[derive(Serialize)]
struct ToolResult {
    code: i32,
    stdout: String,
    stderr: String,
}

/// Runs an external program (e.g. a script compiler a language extension uses, like the game's
/// JassHelper) in `cwd` and waits for it; no console window, output captured.
#[tauri::command]
async fn tool_run(exe: String, args: Vec<String>, cwd: String) -> CmdResult<ToolResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&exe);
        cmd.args(&args).current_dir(&cwd);
        // No console to answer on: a remote that wants a password fails instead of hanging.
        if exe == "git" {
            cmd.env("GIT_TERMINAL_PROMPT", "0");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let child = cmd
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("{exe}: {e}"))?;
        // Whatever the tool starts ends with it (e.g. JassHelper opens its error dialog in a
        // second process): the job is closed when the tool has exited.
        #[cfg(windows)]
        let job = job::kill_on_close(&child);
        let out = child.wait_with_output().map_err(|e| format!("{exe}: {e}"))?;
        #[cfg(windows)]
        drop(job);
        Ok(ToolResult {
            code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    })
    .await
    .map_err(err)?
}

// ---------------------------------------------------------------- git

/// Runs git in `root` (no console window): stdout, or git's message on failure.
fn git(root: &str, args: &[&str]) -> CmdResult<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| format!("git: {e} (is git installed and on PATH?)"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(out.stdout)
}

#[derive(Serialize)]
struct GitChange {
    /// Project-relative, forward slashes.
    path: String,
    /// "M" modified, "A" added, "D" deleted, "R" renamed, "U" untracked, "C" conflict.
    status: String,
    /// Renames: the old path.
    from: Option<String>,
}

#[derive(Serialize)]
struct GitStatus {
    branch: String,
    /// The repository's folder, when the project is a subfolder of it (else empty).
    outer_repo: String,
    changes: Vec<GitChange>,
}

/// The project's uncommitted changes (it may sit anywhere inside a repository); None when it
/// isn't in one.
#[tauri::command]
async fn git_status(root: String) -> CmdResult<Option<GitStatus>> {
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(prefix) = git(&root, &["rev-parse", "--show-prefix"]) else { return Ok(None) };
        let prefix = String::from_utf8_lossy(&prefix).trim().to_string();
        let outer_repo = if prefix.is_empty() {
            String::new()
        } else {
            git(&root, &["rev-parse", "--show-toplevel"]).map(|t| String::from_utf8_lossy(&t).trim().to_string()).unwrap_or_default()
        };
        let branch = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])
            .map(|b| String::from_utf8_lossy(&b).trim().to_string())
            .unwrap_or_default();
        let out = git(&root, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."])?;
        let text = String::from_utf8_lossy(&out);
        let rel = |p: &str| p.strip_prefix(&prefix).unwrap_or(p).to_string();
        let mut changes = Vec::new();
        let mut parts = text.split('\0').filter(|s| !s.is_empty());
        while let Some(entry) = parts.next() {
            if entry.len() < 4 {
                continue;
            }
            let (x, y) = (entry.as_bytes()[0] as char, entry.as_bytes()[1] as char);
            let path = rel(&entry[3..]);
            // Renames and copies are followed by the old path.
            let from = if matches!(x, 'R' | 'C') { parts.next().map(rel) } else { None };
            let status = match (x, y) {
                ('?', _) => "U",
                ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D') => "C",
                (_, 'D') | ('D', _) => "D",
                ('R', _) => "R",
                ('A', _) => "A",
                _ => "M",
            };
            changes.push(GitChange { path, status: status.into(), from });
        }
        Ok(Some(GitStatus { branch, outer_repo, changes }))
    })
    .await
    .map_err(err)?
}

/// A project file as committed in HEAD: its text, or None when HEAD doesn't have it. Fails for
/// files that aren't UTF-8 text.
#[tauri::command]
async fn git_show(root: String, path: String, rev: Option<String>) -> CmdResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let spec = format!("{}:./{path}", rev.as_deref().unwrap_or("HEAD"));
        if git(&root, &["cat-file", "-e", &spec]).is_err() {
            return Ok(None);
        }
        let bytes = git(&root, &["show", &spec])?;
        String::from_utf8(bytes).map(Some).map_err(|_| "binary file".to_string())
    })
    .await
    .map_err(err)?
}

/// Size of a file in HEAD (for binary files), or None.
#[tauri::command]
async fn git_size(root: String, path: String, rev: Option<String>) -> CmdResult<Option<u64>> {
    tauri::async_runtime::spawn_blocking(move || {
        let spec = format!("{}:./{path}", rev.as_deref().unwrap_or("HEAD"));
        Ok(git(&root, &["cat-file", "-s", &spec]).ok().and_then(|b| String::from_utf8_lossy(&b).trim().parse().ok()))
    })
    .await
    .map_err(err)?
}

#[cfg(windows)]
mod job {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// A job object; closing it (drop) ends every process still in it.
    pub struct Job(HANDLE);

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    /// Puts `child` (and the processes it starts from now on) into a new kill-on-close job.
    pub fn kill_on_close(child: &std::process::Child) -> Option<Job> {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let job = Job(job);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
            if SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, &info as *const _ as *const _, size) == 0
                || AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) == 0
            {
                return None;
            }
            Some(job)
        }
    }
}

/// A new empty folder in the system's temp folder, for one tool run's input and output files.
#[tauri::command]
fn tool_temp_dir() -> CmdResult<String> {
    let stamp = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join("w3proj-studio").join(format!("tool-{stamp}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir.to_string_lossy().into_owned())
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
        .manage(mcp::Mcp::default())
        .invoke_handler(tauri::generate_handler![
            project_open,
            path_normalize,
            project_files,
            project_folders,
            project_unpack,
            project_create,
            ui_show_cursor,
            project_pack,
            objects_canonicalize,
            objects_export,
            objects_import,
            codec_canonicalize,
            codec_decode,
            codec_write,
            formats_list,
            format_customize,
            guide_remove,
            fs_read_text,
            fs_write_text,
            fs_write_bytes,
            fs_delete,
            fs_mkdir,
            fs_rmdir,
            fs_rename,
            fs_copy,
            fs_list_tree,
            fs_read_bytes,
            fs_exists,
            reveal_in_explorer,
            app_paths,
            extensions_scan,
            world_editor_open,
            game_test_map,
            tool_run,
            git_status,
            git_show,
            git_size,
            tool_temp_dir,
            watched_maps,
            game_info,
            game_list,
            game_resolve,
            game_read,
            mcp::mcp_serve,
            mcp::mcp_respond,
            mcp::mcp_bridge_path,
            mcpclients::mcp_clients,
            mcpclients::mcp_client_setup,
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
    /// Unique within this run: the tests run side by side, and a shared folder gets deleted under one.
    fn rand_suffix() -> usize {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    #[test]
    fn a_mapped_drive_keeps_its_spelling_and_its_root_separator() {
        assert_eq!(keep_spelling(r"Z:\"), r"Z:\");
        assert_eq!(keep_spelling("Z:/"), r"Z:\");
        assert_eq!(keep_spelling(r"Z:"), r"Z:\");
        assert_eq!(keep_spelling(r"Z:\maps\p\"), r"Z:\maps\p");
        assert_eq!(keep_spelling("Z:/maps/p"), "Z:/maps/p");
    }

    #[test]
    fn path_normalize_off_the_main_thread_gives_normal_paths_answer() {
        let (dir, root) = project();
        assert_eq!(tauri::async_runtime::block_on(path_normalize(root.clone())), normal_path(&root));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn strip_verbatim_takes_the_prefix_off() {
        assert_eq!(strip_verbatim(r"\\?\C:\x\y"), r"C:\x\y");
        assert_eq!(strip_verbatim(r"\\?\UNC\server\share\x"), r"\\server\share\x");
        assert_eq!(strip_verbatim(r"C:\x"), r"C:\x");
        assert_eq!(strip_verbatim("/home/x"), "/home/x");
    }

    #[test]
    #[cfg(windows)]
    fn normal_path_has_a_drive_letter_and_no_verbatim_prefix() {
        let (dir, root) = project();
        let long = normal_path(&root);
        let b = long.as_bytes();
        assert!(!long.starts_with(r"\\"), "{long}");
        assert!(b[1] == b':' && b[0].is_ascii_alphabetic(), "{long}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn normal_path_is_one_spelling_for_short_and_long_names() {
        let (dir, root) = project();
        let long = normal_path(&root);
        // A trailing separator and a dotted detour are the same place.
        assert_eq!(normal_path(&format!("{root}{}", std::path::MAIN_SEPARATOR)), long);
        assert_eq!(normal_path(&dir.join("map").join("..").to_string_lossy()), long);
        #[cfg(windows)]
        {
            assert_eq!(normal_path(&root.to_uppercase()).to_lowercase(), long.to_lowercase());
            // The 8.3 name of the folder, as the shell hands it out.
            let out = Command::new("cmd").args(["/C", "for", "%I", "in"]).arg(format!("({root})")).args(["do", "@echo", "%~sI"]).output().unwrap();
            let short = String::from_utf8_lossy(&out.stdout).trim().to_string();
            assert_eq!(normal_path(&short).to_lowercase(), long.to_lowercase(), "short {short}");
        }
        assert_eq!(normal_path("Z:/no/such/place"), "Z:/no/such/place");
        std::fs::remove_dir_all(&dir).unwrap();
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
    fn folders_empty_ones_too() {
        let (dir, root) = project();
        let empty = dir.join("map/empty/deep").to_string_lossy().into_owned();
        fs_mkdir(root.clone(), empty.clone()).unwrap();
        std::fs::create_dir_all(dir.join("build/x")).unwrap();
        let mut list = project_folders(root.clone()).unwrap();
        list.sort();
        assert_eq!(list, ["map", "map/empty", "map/empty/deep", "map/sub"]);
        // Only an empty folder goes.
        assert!(fs_rmdir(root.clone(), dir.join("map/sub").to_string_lossy().into_owned()).is_err());
        fs_rmdir(root.clone(), empty).unwrap();
        assert!(!dir.join("map/empty/deep").exists() && dir.join("map/empty").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn folders_stay_inside_the_project() {
        let (dir, root) = project();
        let outside = std::env::temp_dir().join(format!("w3proj-outside-{}", rand_suffix()));
        assert!(fs_mkdir(root.clone(), outside.to_string_lossy().into_owned()).is_err());
        assert!(fs_mkdir(root.clone(), format!(r"{root}\map\..\..\escape")).is_err());
        assert!(fs_rmdir(root.clone(), std::env::temp_dir().to_string_lossy().into_owned()).is_err());
        assert!(!outside.exists());
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

    #[test]
    fn list_tree_gives_relative_sorted_files() {
        let (dir, _) = project();
        std::fs::create_dir_all(dir.join("map/sub/deep")).unwrap();
        std::fs::create_dir_all(dir.join("map/empty")).unwrap();
        std::fs::write(dir.join("map/sub/deep/b.txt"), b"b").unwrap();
        std::fs::write(dir.join("map/top.txt"), b"t").unwrap();
        let files = list_tree(&dir.join("map")).unwrap();
        assert_eq!(files, ["sub/a.txt", "sub/deep/b.txt", "top.txt"]);
        assert!(list_tree(&dir.join("missing")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
