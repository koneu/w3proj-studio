//! Tauri backend: exposes the w3proj core, file access, settings, extension
//! discovery and World Editor / game launching to the web UI.
//!
//! The backend stays small on purpose. Features live in UI extensions, which
//! reach the core only through these commands.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

mod gamefind;
mod mcp;
mod mcpclients;
#[cfg_attr(windows, allow(dead_code))]
mod proton;
mod strays;
mod toolrun;

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

/// Off the UI thread: resolving the path (see `path_normalize`) and reading the manifest wait on
/// the disk, which on a network or mapped drive can take long.
#[tauri::command]
async fn project_open(path: String) -> CmdResult<ProjectInfo> {
    tauri::async_runtime::spawn_blocking(move || open_project(&path)).await.map_err(err)?
}

fn open_project(path: &str) -> CmdResult<ProjectInfo> {
    let root = PathBuf::from(normal_path(&project_root(path).to_string_lossy()));
    let manifest = project::Manifest::load(&root).map_err(err)?;
    Ok(ProjectInfo {
        name: manifest.display_name(&root),
        default_output: project::default_output(&root, &manifest)
            .map_err(err)?
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

/// Size and last write of one file, as `project_files` reports them: what a write left, to tell it
/// from a later change by another program. None when there is no such file.
#[tauri::command]
fn fs_stat(path: String) -> Option<Stamp> {
    stamp_of(Path::new(&path)).ok()
}

/// Size, last write and a hash of the contents: what an editor read or wrote. A write of the same size within
/// the same millisecond leaves size and time alike; the hash still tells it. None when there is no such file;
/// no hash when it is there but can't be read (it isn't taken for missing).
#[tauri::command]
fn fs_stat_hashed(path: String) -> Option<HashedStamp> {
    let path = Path::new(&path);
    // Time first: a write between the two gives a hash of the newer bytes with the older time, which differs
    // from the next look at the time anyway.
    let stamp = stamp_of(path).ok()?;
    let hash = std::fs::read(path).ok().map(|b| content_hash(&b));
    Some(HashedStamp { size: stamp.size, modified: stamp.modified, hash })
}

#[derive(Serialize)]
struct HashedStamp {
    size: u64,
    modified: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    hash: Option<String>,
}

/// FNV-1a, 64 bits, as hex: tells two contents of the same size apart (not a guard against someone making
/// them collide on purpose).
fn content_hash(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// The file's size and time right after we wrote it: what the workspace compares later to tell our
/// own save from a change by another program.
fn stamp_of(path: &Path) -> CmdResult<Stamp> {
    let meta = std::fs::metadata(path).map_err(err)?;
    Ok(Stamp { size: meta.len(), modified: modified_ms(&meta) })
}

#[derive(Serialize, Debug)]
struct Stamp {
    size: u64,
    modified: u64,
}

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// All project files except build output and VCS metadata. Any folder that can't be read fails the
/// whole list: the workspace takes a file missing from it for one deleted by another program.
#[tauri::command]
fn project_files(root: String) -> CmdResult<Vec<FileInfo>> {
    walk_project(Path::new(&root), false).map(|(files, _)| files)
}

/// A folder (or entry) `project_files_partial` couldn't read, below the root, and why.
#[derive(Serialize, Debug)]
struct Unreadable {
    path: String,
    error: String,
}

#[derive(Serialize)]
struct PartialFiles {
    files: Vec<FileInfo>,
    /// What was skipped: the caller decides whether a skipped folder matters to it.
    unreadable: Vec<Unreadable>,
}

/// As `project_files`, but a subfolder that can't be read is skipped and named in `unreadable`
/// instead of failing the whole list (an unreadable root still fails): for a campaign's files,
/// where one chapter's unreadable folder must not hide the campaign's own files from every chapter.
#[tauri::command]
fn project_files_partial(root: String) -> CmdResult<PartialFiles> {
    walk_project(Path::new(&root), true).map(|(files, unreadable)| PartialFiles { files, unreadable })
}

/// The files below `root` (forward slashes, sorted without case), without build output and VCS
/// metadata. `skip_unreadable`: a subfolder or entry that can't be read is listed in the second
/// value and left out, instead of failing.
fn walk_project(root: &Path, skip_unreadable: bool) -> CmdResult<(Vec<FileInfo>, Vec<Unreadable>)> {
    let mut out = Vec::new();
    let mut unreadable = Vec::new();
    // Part by part: on Linux a `\` is a character of a name, and turned into `/` it would name another path.
    let rel_of = |path: &Path| {
        let rel = path.strip_prefix(root).unwrap();
        rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
    };
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        // Fails the walk, or (when skipping, below the root) notes what was skipped.
        let mut skip = |path: &Path, e: std::io::Error| -> CmdResult<()> {
            if skip_unreadable && path != root {
                unreadable.push(Unreadable { path: rel_of(path), error: e.to_string() });
                Ok(())
            } else {
                Err(err(e))
            }
        };
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) => {
                skip(&dir, e)?;
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) => {
                    // The rest of this folder can't be trusted to come: it counts as unreadable.
                    skip(&dir, e)?;
                    break;
                }
            };
            let path = entry.path();
            // A name with a `\` (only possible off Windows) is a stray file of an older version (strays.rs): no
            // project path can name it (lib/paths.ts takes `\` for a separator), so it isn't listed, never as the
            // file its name looks like; opening the project offers to move it.
            if entry.file_name().to_string_lossy().contains('\\') {
                continue;
            }
            let rel = rel_of(&path);
            // A save in progress (`write_file`) or a crash's leftover: no project file, and never
            // reported as one added by another program.
            let temp = || w3proj::atomic::is_temp(&entry.file_name().to_string_lossy());
            let is_dir = match entry.file_type() {
                Ok(t) => t.is_dir(),
                Err(e) => {
                    skip(&path, e)?;
                    continue;
                }
            };
            if is_dir {
                if !matches!(rel.as_str(), "build" | ".git" | "node_modules") {
                    stack.push(path);
                }
            } else if !temp() {
                let meta = entry.metadata().ok();
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified = meta.as_ref().map(modified_ms).unwrap_or(0);
                out.push(FileInfo { path: rel, size, modified });
            }
        }
    }
    out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    unreadable.sort_by(|a, b| a.path.cmp(&b.path));
    Ok((out, unreadable))
}

/// Imports a map into `dir` (new project) or re-syncs an existing one. `refuse_deletes`: write nothing when
/// files under map/ or maps/ would be deleted, and fail with `WOULD_DELETE: <JSON list>` (so the app asks first).
/// `replaces`: with `refuse_deletes`, the project `dir` will take the place of (see `UnpackOptions::replaces`).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn project_unpack(
    app: AppHandle,
    map: String,
    dir: String,
    allow_incomplete: bool,
    install: Option<String>,
    refuse_deletes: Option<bool>,
    replaces: Option<String>,
) -> CmdResult<Value> {
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
        let opts = UnpackOptions {
            allow_incomplete,
            more_names,
            refuse_deletes: refuse_deletes.unwrap_or(false),
            replaces: replaces.map(PathBuf::from),
        };
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
            Err(w3proj::Error::WouldDelete(gone)) => Err(format!("WOULD_DELETE: {}", serde_json::to_string(&gone).map_err(err)?)),
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

/// The project's terrain and doodad files as they are now (`w3proj::derived`), taken before pathing, shadows and the
/// minimap are made from them.
#[tauri::command]
async fn derived_sources(root: String) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = w3proj::derived::sources(Path::new(&root)).map_err(err)?;
        serde_json::to_value(&s).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Records that pathing, shadows and the minimap were made from `sources` (`derived_sources`): a pack outside the app
/// (`w3proj pack`) refuses them once the terrain or doodads change again.
#[tauri::command]
async fn derived_record(root: String, sources: std::collections::BTreeMap<String, String>) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || w3proj::derived::record(Path::new(&root), &sources).map_err(err))
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
    w3proj::atomic::write(Path::new(&path), &bin).map_err(err)
}

/// Reads a binary object data file, like one the World Editor exported, as project JSON.
#[tauri::command]
fn objects_import(name: String, path: String) -> CmdResult<String> {
    let opt = w3proj::objdata::kind(&name).ok_or("not an object data file")?;
    let bin = std::fs::read(&path).map_err(err)?;
    let json = w3proj::objdata::to_json(&bin, opt).map_err(err)?;
    String::from_utf8(json).map_err(err)
}

/// One kind's object data (project JSON) in a `.w3o`.
#[derive(serde::Serialize, serde::Deserialize)]
struct W3oPart {
    kind: String,
    text: String,
}

/// Writes all given kinds of object data into one `.w3o` file.
#[tauri::command]
fn w3o_export(parts: Vec<W3oPart>, path: String) -> CmdResult<()> {
    let parts: Vec<(String, String)> = parts.into_iter().map(|p| (p.kind, p.text)).collect();
    let bin = w3proj::w3o::pack_json(&parts).map_err(err)?;
    w3proj::atomic::write(Path::new(&path), &bin).map_err(err)
}

/// Reads a `.w3o` as the project JSON of each kind it holds.
#[tauri::command]
fn w3o_import(path: String) -> CmdResult<Vec<W3oPart>> {
    let bin = std::fs::read(&path).map_err(err)?;
    let parts = w3proj::w3o::unpack_json(&bin).map_err(err)?;
    Ok(parts.into_iter().map(|(kind, text)| W3oPart { kind, text }).collect())
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
/// format definitions in effect, for viewers that read either form. Off the UI thread: a big file
/// takes a while to read and decode.
#[tauri::command]
async fn codec_decode(app: AppHandle, root: String, path: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || decode_file(&app, &root, &path)).await.map_err(err)?
}

fn decode_file(app: &AppHandle, root: &str, path: &str) -> CmdResult<String> {
    let rel = path.strip_prefix("map/").unwrap_or(path);
    // The file first: callers try this for files that may not be there (the raw form of a document
    // whose JSON form is missing), and loading the format definitions for nothing is slow.
    let bytes = std::fs::read(Path::new(root).join(path)).map_err(err)?;
    let registry = Registry::for_project(Path::new(root), &user_format_dirs(app)?).map_err(err)?;
    let name = w3proj::paths::to_archive_name(rel);
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
fn codec_write(app: AppHandle, root: String, path: String, text: String) -> CmdResult<Stamp> {
    let rel = path.strip_prefix("map/").unwrap_or(&path);
    let registry = Registry::for_project(Path::new(&root), &user_format_dirs(&app)?).map_err(err)?;
    let name = w3proj::paths::to_archive_name(rel);
    let mut last = format!("no format definition writes {name}");
    for codec in registry.for_archive_name(&name) {
        match codec.encode(&name, text.as_bytes()) {
            Ok(bin) => {
                return write_file(&Path::new(&root).join(&path), |f| f.write_all(&bin));
            }
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
    if !exists_checked(&path)? {
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
fn fs_write_text(path: String, text: String) -> CmdResult<Stamp> {
    write_file(Path::new(&path), |f| f.write_all(text.as_bytes()))
}

/// Every save of the app: the folders above are made, then the file is replaced in one step
/// (`w3proj::atomic`: a temporary file renamed over it), so a write that fails partway (a full disk)
/// leaves the old file whole. A link is written through to its file. Gives the stamp the file has after.
fn write_file(path: &Path, fill: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>) -> CmdResult<Stamp> {
    w3proj::atomic::write_with(path, fill).map_err(err)?;
    stamp_of(path)
}

/// Writes the raw request body to the file named by the (URI-encoded) `path`
/// header; binary files skip JSON encoding this way.
#[tauri::command]
fn fs_write_bytes(request: tauri::ipc::Request<'_>) -> CmdResult<Stamp> {
    let path = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing path header")?;
    let path = percent_decode(path)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw byte body".into());
    };
    write_file(Path::new(&path), |f| f.write_all(bytes))
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
            // A name with a `\` is a stray of an older version (see walk_project): not a folder path.
            if !entry.file_type().map_err(err)?.is_dir() || entry.file_name().to_string_lossy().contains('\\') {
                continue;
            }
            let path = entry.path();
            let rel = path.strip_prefix(&root).unwrap().components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
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
    if exists_checked(&dst)? {
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
            } else if kind.is_file() && !w3proj::atomic::is_temp(&name) {
                // Not a save's temporary file: half written, it is nothing to import.
                files.push(format!("{prefix}{name}"));
            }
        }
    }
    files.sort();
    Ok(files)
}

/// Whether something is at the path. A path that can't be checked (a folder above it may not be looked
/// into) is an error, never "not there": callers create or write over what they take for absent.
#[tauri::command]
fn fs_exists(path: String) -> CmdResult<bool> {
    exists_checked(Path::new(&path))
}

fn exists_checked(path: &Path) -> CmdResult<bool> {
    path.try_exists().map_err(|e| format!("{}: can't be checked: {e}", path.display()))
}

/// Stray files of the project at `root` (see `strays`): found, never changed.
#[tauri::command]
async fn project_strays(root: String) -> CmdResult<Vec<strays::Stray>> {
    tauri::async_runtime::spawn_blocking(move || strays::scan(Path::new(&root))).await.map_err(err)
}

/// Moves one stray file of the project where it belongs, or deletes it when it is a copy of the file there.
#[tauri::command]
async fn project_fix_stray(root: String, path: String) -> CmdResult<strays::Fixed> {
    tauri::async_runtime::spawn_blocking(move || strays::fix(Path::new(&root), Path::new(&path))).await.map_err(err)?
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> CmdResult<()> {
    reveal_command(&path).spawn().map(|_| ()).map_err(err)
}

/// Shows a file in the system's file manager: selected in Explorer (Windows) and Finder (macOS); on Linux its
/// folder is opened with xdg-open, as there's no common way to select a file. A folder is opened itself.
fn reveal_command(path: &str) -> Command {
    #[cfg(windows)]
    {
        // Explorer only understands backslashes, and needs `/select,"path"` as one
        // raw argument (Rust would quote the whole thing, which it misreads).
        use std::os::windows::process::CommandExt;
        let native = path.replace('/', "\\");
        let mut cmd = Command::new("explorer");
        if Path::new(&native).is_file() {
            cmd.raw_arg(format!("/select,\"{native}\""));
        } else {
            cmd.raw_arg(format!("\"{native}\""));
        }
        cmd
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("open");
        if Path::new(path).is_file() {
            cmd.arg("-R");
        }
        cmd.arg(path);
        cmd
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let p = Path::new(path);
        let folder = if p.is_file() { p.parent().unwrap_or(p) } else { p };
        let mut cmd = Command::new("xdg-open");
        cmd.arg(folder);
        cmd
    }
}

// ---------------------------------------------------------------- settings & extensions

fn config_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = chosen_config_dir(std::env::var_os("W3PROJ_CONFIG_DIR"), || app.path().app_config_dir().map_err(err))?;
    std::fs::create_dir_all(dir.join("extensions")).map_err(err)?;
    Ok(dir)
}

/// The settings folder: W3PROJ_CONFIG_DIR when set (two smoke-test apps of one build run side by side, each with its
/// own settings: app-smoke.mjs --part), else the system's folder for the app's identifier.
fn chosen_config_dir(over: Option<std::ffi::OsString>, system: impl FnOnce() -> CmdResult<PathBuf>) -> CmdResult<PathBuf> {
    match over {
        Some(dir) if !dir.is_empty() => Ok(PathBuf::from(dir)),
        _ => system(),
    }
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

/// Warcraft III installs in the usual places (Windows default folders; Steam, Lutris and Wine prefixes on
/// Linux), newest build first. Reads only each one's .build.info.
#[tauri::command]
async fn game_find() -> CmdResult<Vec<gamefind::FoundGame>> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    Ok(gamefind::find(home.as_deref()))
}

/// The game's `Maps` folder for the player's own maps (gamefind::user_folder), which its Custom Game lists. The
/// folder itself may not exist yet; packing into it makes it.
#[tauri::command]
fn game_maps_folder(app: AppHandle, install: String) -> CmdResult<String> {
    let documents = app.path().document_dir().ok();
    let dir = gamefind::user_folder(Path::new(&install), documents.as_deref())?;
    Ok(dir.join("Maps").to_string_lossy().into_owned())
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

/// `game_resolve` for many paths in one call (the Problems checks look up thousands): the stored
/// full path of each, or null, in the order given.
#[tauri::command]
async fn game_resolve_many(state: State<'_, Game>, install: String, paths: Vec<String>, mode_name: String, tileset: Option<String>) -> CmdResult<Vec<Option<String>>> {
    let g = game_data(&state, &install)?;
    let mode = mode(&mode_name)?;
    let tileset = tileset_letter(&tileset);
    Ok(paths.iter().map(|p| g.resolve(p, mode, tileset).map(str::to_string)).collect())
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
    let args: Vec<String> = ["-launch", "-loadfile", map].iter().chain(extra).map(|s| s.to_string()).collect();
    program(exe, args)?
        .current_dir(Path::new(exe).parent().unwrap_or(Path::new(".")))
        .spawn()
        .map_err(err)
}

/// A program with its arguments. On Linux a Windows program (`.exe`) is started through Steam's Proton in
/// the Steam prefix it's in (proton.rs), and full paths among the arguments become Wine's `Z:\…`.
fn program(exe: &str, args: Vec<String>) -> CmdResult<Command> {
    #[cfg(not(windows))]
    if proton::is_windows_program(Path::new(exe)) {
        let p = proton::proton_for(Path::new(exe))?;
        let args: Vec<String> = args.iter().map(|a| proton::wine_path(a)).collect();
        return Ok(proton::command(&p, Path::new(exe), &args));
    }
    let mut cmd = Command::new(exe);
    cmd.args(args);
    Ok(cmd)
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
/// `args`: the Test Map options as flags (map-project/testmap.ts builds them from the settings); without them
/// the defaults above. Only the World Editor's Test Map flags are let through.
#[tauri::command]
fn game_test_map(exe: String, map: String, args: Option<Vec<String>>) -> CmdResult<()> {
    let args = args.unwrap_or_else(|| ["-mapdiff", "1", "-testmapprofile", "WorldEdit", "-fixedseed", "1"].map(String::from).to_vec());
    check_test_map_args(&args)?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    launch(&exe, &map, &args).map(|_| ())
}

/// Whether `args` are Test Map flags the World Editor passes, each with a value it allows (a profile is any name
/// that doesn't look like a flag): nothing else reaches the game's command line.
fn check_test_map_args(args: &[String]) -> CmdResult<()> {
    let mut i = 0;
    while i < args.len() {
        let flag = args[i].as_str();
        let value = args.get(i + 1).map(String::as_str);
        let ok = match flag {
            "-nowfpause" => { i += 1; continue; }
            "-windowmode" => matches!(value, Some("windowed" | "windowedfullscreen" | "fullscreen")),
            "-hd" => matches!(value, Some("0" | "1" | "2")),
            "-teen" => matches!(value, Some("0" | "1")),
            "-mapdiff" => matches!(value, Some("0" | "1" | "2" | "3")),
            "-fixedseed" => matches!(value, Some("0" | "1")),
            "-testmapprofile" => value.is_some_and(|v| !v.is_empty() && !v.starts_with('-') && !v.contains('"')),
            _ => false,
        };
        if !ok {
            return Err(format!("Test Map: {flag} {} isn't a Test Map option the game takes", value.unwrap_or("")));
        }
        i += 2;
    }
    Ok(())
}

/// Runs an external program (e.g. a script compiler a language extension uses, like the game's
/// JassHelper) in `cwd` and waits for it to exit; no console window, output captured. What it leaves running
/// from its own folder is ended then (JassHelper's error window). With a `guard` it is also ended when it goes too
/// long without progress, or doesn't exit after writing its result (toolrun.rs).
#[tauri::command]
async fn tool_run(exe: String, args: Vec<String>, cwd: String, guard: Option<toolrun::Guard>) -> CmdResult<toolrun::ToolResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = program(&exe, args)?;
        cmd.current_dir(&cwd);
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
        // A program given by its path (not one found on PATH, like git) has a folder its own programs come from.
        let own = Path::new(&exe);
        let own = own.is_absolute().then_some(own);
        toolrun::run(cmd, &exe, Path::new(&cwd), own, guard.as_ref())
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
            fs_stat,
            fs_stat_hashed,
            project_files,
            project_files_partial,
            project_folders,
            project_unpack,
            project_create,
            ui_show_cursor,
            project_pack,
            derived_sources,
            derived_record,
            objects_canonicalize,
            objects_export,
            objects_import,
            w3o_export,
            w3o_import,
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
            project_strays,
            project_fix_stray,
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
            game_find,
            game_maps_folder,
            game_info,
            game_list,
            game_resolve,
            game_resolve_many,
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

    #[cfg(not(any(windows, target_os = "macos")))]
    #[test]
    fn on_linux_a_file_is_shown_by_opening_its_folder_with_xdg_open() {
        let (dir, root) = project();
        let file = dir.join("map/sub/a.txt");
        let cmd = reveal_command(&file.to_string_lossy());
        assert_eq!(cmd.get_program(), "xdg-open");
        assert_eq!(cmd.get_args().collect::<Vec<_>>(), [dir.join("map/sub").as_os_str()]);
        let cmd = reveal_command(&root);
        assert_eq!(cmd.get_args().collect::<Vec<_>>(), [dir.as_os_str()]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(not(windows))]
    #[test]
    fn on_linux_a_windows_program_outside_a_steam_prefix_is_refused_and_others_run_as_they_are() {
        let e = program("/home/u/Games/battlenet/drive_c/Warcraft III/World Editor.exe", vec![]).unwrap_err();
        assert!(e.contains("Steam"), "{e}");
        let cmd = program("git", vec!["status".into()]).unwrap();
        assert_eq!(cmd.get_program(), "git");
        assert_eq!(cmd.get_args().collect::<Vec<_>>(), ["status"]);
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
    fn project_open_off_the_main_thread_gives_the_project_by_folder_or_manifest() {
        let (base, _) = project();
        let dir = base.join("new");
        let root = dir.to_string_lossy().into_owned();
        w3proj::create(&dir, None).unwrap();
        let open = |path: String| tauri::async_runtime::block_on(project_open(path));
        let by_folder = open(root.clone()).unwrap_or_else(|e| panic!("{e}"));
        let by_manifest = open(dir.join(project::MANIFEST).to_string_lossy().into_owned()).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(by_folder.root, normal_path(&root));
        assert_eq!(by_manifest.root, by_folder.root);
        assert_eq!(by_manifest.name, by_folder.name);
        assert_eq!(by_manifest.manifest, by_folder.manifest);
        // No manifest: the manifest's own error, as before.
        let Err(err) = open(dir.join("map").to_string_lossy().into_owned()) else { panic!("a folder without a manifest opened") };
        assert!(err.contains("cannot read w3proj.toml"), "{err}");
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// A save that fails partway (here the writer fails after half the bytes, as on a full disk) leaves
    /// the old file whole and no temporary file behind; std::fs::write would have cut the file short.
    #[test]
    fn a_save_failing_partway_leaves_the_old_file_whole() {
        let (dir, _) = project();
        let file = dir.join("map/sub/a.txt");
        std::fs::write(&file, b"the old contents").unwrap();
        let e = write_file(&file, |f| {
            f.write_all(b"the new con")?;
            Err(std::io::Error::new(std::io::ErrorKind::StorageFull, "No space left on device"))
        })
        .unwrap_err();
        assert!(e.contains("No space left"), "{e}");
        assert_eq!(std::fs::read(&file).unwrap(), b"the old contents");
        let names: Vec<_> = std::fs::read_dir(dir.join("map/sub")).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["a.txt"], "no temporary file is left");
        // A save that goes through: the new bytes and their stamp; a new folder is made.
        let stamp = fs_write_text(file.to_string_lossy().into_owned(), "new".into()).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"new");
        assert_eq!(stamp.size, 3);
        let deep = dir.join("map/new/b.txt");
        fs_write_text(deep.to_string_lossy().into_owned(), "b".into()).unwrap();
        assert_eq!(std::fs::read(&deep).unwrap(), b"b");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A save's temporary file (there while it runs, or left by a crash) isn't in the file list the
    /// workspace checks for external changes, nor in an import's list; a dot file of the user's is.
    #[test]
    fn a_saves_temporary_file_is_in_no_listing() {
        let (dir, root) = project();
        let tmp = ".a.txt.4242-7.tmp";
        assert!(w3proj::atomic::is_temp(tmp));
        std::fs::write(dir.join("map/sub").join(tmp), b"half").unwrap();
        std::fs::write(dir.join("map/sub/.keep"), b"").unwrap();
        let listed: Vec<String> = project_files(root.clone()).unwrap().into_iter().map(|f| f.path).collect();
        assert_eq!(listed, ["map/sub/.keep", "map/sub/a.txt"]);
        let partial: Vec<String> = project_files_partial(root.clone()).unwrap().files.into_iter().map(|f| f.path).collect();
        assert_eq!(partial, listed);
        assert_eq!(list_tree(&dir.join("map")).unwrap(), ["sub/.keep", "sub/a.txt"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A same-size write that keeps the time (as one in the same millisecond does) changes the hash, not the stamp.
    #[test]
    fn fs_stat_hashed_tells_a_same_size_write_in_the_same_millisecond() {
        let (dir, _) = project();
        let file = dir.join("map/sub/a.txt");
        let p = file.to_string_lossy().into_owned();
        std::fs::write(&file, "abcd").unwrap();
        let first = fs_stat_hashed(p.clone()).unwrap();
        let same = fs_stat_hashed(p.clone()).unwrap();
        assert!(first.hash.is_some());
        assert_eq!(first.hash, same.hash, "the same bytes, the same hash");
        let time = std::fs::metadata(&file).unwrap().modified().unwrap();
        std::fs::write(&file, "abce").unwrap();
        std::fs::File::options().write(true).open(&file).unwrap().set_modified(time).unwrap();
        let after = fs_stat_hashed(p.clone()).unwrap();
        assert_eq!((after.size, after.modified), (first.size, first.modified), "size and time alike");
        assert_ne!(after.hash, first.hash);
        assert!(fs_stat_hashed(dir.join("nope").to_string_lossy().into_owned()).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// fs_write_bytes takes its path from a header the app escapes with encodeURIComponent: a name that starts
    /// with U+FEFF (which archive names may) comes back with it, not without.
    #[test]
    fn percent_decode_keeps_a_leading_byte_order_mark() {
        assert_eq!(percent_decode("%2Fp%2Fmap%2F%EF%BB%BFb.mdx").unwrap(), "/p/map/\u{feff}b.mdx");
        assert_eq!(percent_decode("%EF%BB%BF%EF%BB%BFx").unwrap(), "\u{feff}\u{feff}x");
        assert_eq!(percent_decode("\u{feff}plain").unwrap(), "\u{feff}plain");
        // Control: other escapes decode as before.
        assert_eq!(percent_decode("a%20b%25").unwrap(), "a b%");
    }

    #[test]
    fn fs_stat_reports_what_project_files_does() {
        let (dir, root) = project();
        let file = dir.join("map/sub/a.txt");
        let st = fs_stat(file.to_string_lossy().into_owned()).unwrap();
        let listed = project_files(root).unwrap().into_iter().find(|f| f.path == "map/sub/a.txt").unwrap();
        assert_eq!((st.size, st.modified), (listed.size, listed.modified));
        assert!(fs_stat(dir.join("nope").to_string_lossy().into_owned()).is_none());
        // A write answers with the stamp of what it left.
        let w = dir.join("new/dir/w.txt").to_string_lossy().into_owned();
        let wrote = fs_write_text(w.clone(), "hello".into()).unwrap();
        let st = fs_stat(w).unwrap();
        assert_eq!((wrote.size, wrote.modified), (5, st.modified));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A file in a folder that can't be looked into isn't "not there": fs_exists says it can't tell, as
    /// fs_rename does before moving onto it. Absent and present are answered as before.
    #[cfg(unix)]
    #[test]
    fn fs_exists_tells_a_path_it_cant_check_from_one_that_isnt_there() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, root) = project();
        let locked = dir.join("maps").join("Chapter 2");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::write(locked.join("war3campaign.w3f"), b"c").unwrap();
        let inside = locked.join("war3campaign.w3f").to_string_lossy().into_owned();
        // As the app receives the answers (a value, or an error it rejects with).
        let answer = |p: String| format!("{:?}", fs_exists(p));
        let present = answer(dir.join("map").join("sub").join("a.txt").to_string_lossy().into_owned());
        let absent = answer(dir.join("map").join("nope.txt").to_string_lossy().into_owned());
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Running as root looks into it anyway: then there's nothing unreadable to test with.
        let readable = std::fs::metadata(locked.join("war3campaign.w3f")).is_ok();
        let unknown = answer(inside.clone());
        let from = dir.join("map").join("sub").join("a.txt").to_string_lossy().into_owned();
        let renamed = fs_rename(root.clone(), from.clone(), inside.clone());
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        let kept = std::fs::read(locked.join("war3campaign.w3f")).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        if !readable {
            assert!(unknown.starts_with("Err(") && unknown.contains("can't be checked"), "a file in a folder that can't be looked into was answered {unknown}");
            assert!(renamed.is_err(), "a move onto a path that can't be checked went ahead");
        }
        assert_eq!(kept, b"c");
        assert_eq!(present, "Ok(true)");
        assert_eq!(absent, "Ok(false)");
    }

    /// A campaign with one chapter folder that can't be read: the partial list skips and names it and
    /// still has the campaign's own files; the strict list (the workspace's) fails as before.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_subfolder_is_skipped_and_named_by_the_partial_list_only() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, root) = project();
        let locked = dir.join("maps/Chapter 2");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::write(locked.join("secret.txt"), b"s").unwrap();
        std::fs::create_dir_all(dir.join("maps/Chapter 1/map")).unwrap();
        std::fs::write(dir.join("maps/Chapter 1/map/war3map.w3i"), b"i").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Running as root reads it anyway: then there's nothing unreadable to test with.
        let readable = std::fs::read_dir(&locked).is_ok();
        let partial = project_files_partial(root.clone());
        let strict = project_files(root.clone());
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        if readable {
            return;
        }
        let partial = partial.expect("one unreadable chapter folder failed the whole campaign list");
        let paths: Vec<&str> = partial.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["map/sub/a.txt", "maps/Chapter 1/map/war3map.w3i"]);
        assert_eq!(partial.unreadable.len(), 1, "{:?}", partial.unreadable);
        assert_eq!(partial.unreadable[0].path, "maps/Chapter 2");
        assert!(!partial.unreadable[0].error.is_empty());
        assert!(strict.is_err(), "the workspace's list must not pass a folder it couldn't read for an empty one");
        // An unreadable root fails the partial list too: there is nothing it could list.
        assert!(project_files_partial(dir.join("nope").to_string_lossy().into_owned()).is_err());
    }

    /// A name with a literal `\` (an older version's stray file, strays.rs) isn't listed, and never as the path its
    /// name looks like: `map/sub\b.txt` next to `map/sub/a.txt` isn't `map/sub/b.txt`, and nothing below a folder named
    /// `x\y` is `x/y/…`. Unix only: on Windows a name can't hold a `\`.
    #[cfg(unix)]
    #[test]
    fn a_name_with_a_backslash_is_left_out_not_taken_for_a_path() {
        let (dir, root) = project();
        std::fs::write(dir.join("map").join(r"sub\b.txt"), b"stray").unwrap();
        std::fs::create_dir_all(dir.join(r"map\deep")).unwrap();
        std::fs::write(dir.join(r"map\deep").join("c.txt"), b"stray").unwrap();
        std::fs::write(dir.join("map").join("plain.txt"), b"p").unwrap();
        let strict = project_files(root.clone());
        let partial = project_files_partial(root.clone());
        let mut folders = project_folders(root).unwrap();
        folders.sort();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(folders, ["map", "map/sub"], "folders");
        let paths: Vec<String> = strict.unwrap().into_iter().map(|f| f.path).collect();
        assert_eq!(paths, ["map/plain.txt", "map/sub/a.txt"]);
        let partial = partial.unwrap();
        let paths: Vec<&str> = partial.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["map/plain.txt", "map/sub/a.txt"]);
        assert!(partial.unreadable.is_empty(), "{:?}", partial.unreadable);
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

/// A Windows program on Linux starts through Proton in a way that ends with the program (see proton::command):
/// Test Map and Open in World Editor left a `proton run` and its steam.exe behind for as long as Battle.net ran.
#[cfg(all(test, not(windows)))]
mod program_tests {
    use super::program;

    #[test]
    fn a_windows_program_runs_through_proton_runinprefix_not_run() {
        let root = std::env::temp_dir().join(format!("w3proj-program-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let tool = root.join("compatibilitytools.d/GE");
        std::fs::create_dir_all(tool.join("files/share/fonts")).unwrap();
        std::fs::write(tool.join("proton"), "").unwrap();
        std::fs::write(root.join("steam.sh"), "").unwrap();
        let data = root.join("steamapps/compatdata/123");
        let bin = data.join("pfx/drive_c/Warcraft III/_retail_/x86_64");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(data.join("config_info"), format!("GE\n{}/files/share/fonts/\n", tool.display())).unwrap();
        let exe = bin.join("Warcraft III.exe");
        let cmd = program(&exe.to_string_lossy(), vec!["-launch".into(), "-loadfile".into(), "/m/a.w3x".into()]).unwrap();
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(cmd.get_program(), tool.join("proton").as_os_str());
        assert_eq!(args[0], "runinprefix", "proton run's steam.exe waits for every program in the prefix, Battle.net too");
        assert_eq!(args[1..], [exe.to_string_lossy().into_owned(), "-launch".into(), "-loadfile".into(), r"Z:\m\a.w3x".into()]);
    }
}

#[cfg(test)]
mod config_dir_tests {
    use super::chosen_config_dir;
    use std::path::PathBuf;

    #[test]
    fn the_variable_wins_when_set_and_not_empty() {
        let system = || Ok(PathBuf::from("system"));
        assert_eq!(chosen_config_dir(Some("smoke/config".into()), system).unwrap(), PathBuf::from("smoke/config"));
        assert_eq!(chosen_config_dir(Some("".into()), system).unwrap(), PathBuf::from("system"));
        assert_eq!(chosen_config_dir(None, system).unwrap(), PathBuf::from("system"));
    }
}

#[cfg(test)]
mod test_map_tests {
    use super::check_test_map_args;

    fn args(s: &[&str]) -> Vec<String> {
        s.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn the_world_editors_flags_pass() {
        assert!(check_test_map_args(&args(&["-mapdiff", "1", "-testmapprofile", "WorldEdit", "-fixedseed", "1"])).is_ok());
        let all = ["-windowmode", "windowedfullscreen", "-hd", "2", "-teen", "0", "-nowfpause", "-mapdiff", "2", "-testmapprofile", "My Name"];
        assert!(check_test_map_args(&args(&all)).is_ok());
        assert!(check_test_map_args(&[]).is_ok());
    }

    #[test]
    fn anything_else_is_refused() {
        for bad in [
            &["-loadfile", "x.w3x"][..],
            &["-mapdiff", "9"],
            &["-hd", "3"],
            &["-windowmode", "maximized"],
            &["-testmapprofile", "-launch"],
            &["-testmapprofile"],
            &["-fixedseed"],
            &["-mapdiff", "1", "extra"],
        ] {
            assert!(check_test_map_args(&args(bad)).is_err(), "{bad:?}");
        }
    }
}
