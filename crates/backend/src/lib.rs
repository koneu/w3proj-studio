//! The app's backend commands that need no window: the project's files, reads and writes, the codecs and
//! the game's data. The app (`app/src-tauri`) wraps them as its commands; `w3proj rebuild` answers the
//! app's own TypeScript with them when it runs without the app (the CLI's headless host). One body for
//! both, so the app's code finds the same files, gets the same errors and writes the same way in either.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use w3proj::{project, Registry};

pub type CmdResult<T> = Result<T, String>;

pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ---------------------------------------------------------------- project

#[derive(Serialize)]
pub struct ProjectInfo {
    pub root: String,
    pub name: String,
    pub manifest: Value,
    pub default_output: String,
}

pub fn project_root(path: &str) -> PathBuf {
    let p = PathBuf::from(path);
    if p.file_name().is_some_and(|n| n == project::MANIFEST) {
        p.parent().map(Path::to_path_buf).unwrap_or(p)
    } else {
        p
    }
}

/// `\\?\C:\x` as `C:\x`, `\\?\UNC\server\share\x` as `\\server\share\x`: the verbatim prefix
/// canonicalize puts on a Windows path, taken off again. Anything else stays as it is.
pub fn strip_verbatim(s: &str) -> String {
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
pub fn keep_spelling(path: &str) -> String {
    let t = path.trim_end_matches(['\\', '/']);
    if t.len() == 2 { format!(r"{t}\") } else { t.to_string() }
}

/// A path in one spelling: symlinks and, on Windows, 8.3 short names resolved (`KONSTA~1` is
/// `Konstantin`), without the `\\?\` prefix canonicalize adds. A path that can't be resolved
/// (it isn't there) stays as it is. A path on a mapped network drive (`Z:\`) keeps its drive
/// letter: canonicalize would turn it into the share's UNC name.
pub fn normal_path(path: &str) -> String {
    let Ok(p) = std::fs::canonicalize(path) else { return path.to_string() };
    let s = strip_verbatim(&p.to_string_lossy());
    let has_drive = path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic();
    if has_drive && s.starts_with(r"\\") {
        return keep_spelling(path);
    }
    s
}

pub fn open_project(path: &str) -> CmdResult<ProjectInfo> {
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
pub struct FileInfo {
    pub path: String,
    pub size: u64,
    /// Last write, ms since the Unix epoch (0 if unknown): to notice changes made outside the app.
    pub modified: u64,
}

/// A folder (or entry) `project_files_partial` couldn't read, below the root, and why.
#[derive(Serialize, Debug)]
pub struct Unreadable {
    pub path: String,
    pub error: String,
}

/// The files below `root` (forward slashes, sorted without case), without build output and VCS
/// metadata. `skip_unreadable`: a subfolder or entry that can't be read is listed in the second
/// value and left out, instead of failing.
pub fn walk_project(root: &Path, skip_unreadable: bool) -> CmdResult<(Vec<FileInfo>, Vec<Unreadable>)> {
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

/// The project's folders (forward slashes), the ones without files too; what `walk_project`
/// leaves out is left out here.
pub fn project_folders(root: &Path) -> CmdResult<Vec<String>> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).map_err(err)? {
            let entry = entry.map_err(err)?;
            // A name with a `\` is a stray of an older version (see walk_project): not a folder path.
            if !entry.file_type().map_err(err)?.is_dir() || entry.file_name().to_string_lossy().contains('\\') {
                continue;
            }
            let path = entry.path();
            let rel = path.strip_prefix(root).unwrap().components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
            if !matches!(rel.as_str(), "build" | ".git" | "node_modules") {
                stack.push(path);
                out.push(rel);
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- files

#[derive(Serialize, Debug)]
pub struct Stamp {
    pub size: u64,
    pub modified: u64,
}

pub fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The file's size and time right after we wrote it: what the workspace compares later to tell our
/// own save from a change by another program.
pub fn stamp_of(path: &Path) -> CmdResult<Stamp> {
    let meta = std::fs::metadata(path).map_err(err)?;
    Ok(Stamp { size: meta.len(), modified: modified_ms(&meta) })
}

/// Every save of the app: the folders above are made, then the file is replaced in one step
/// (`w3proj::atomic`: a temporary file renamed over it), so a write that fails partway (a full disk)
/// leaves the old file whole. A link is written through to its file. Gives the stamp the file has after.
pub fn write_file(path: &Path, fill: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>) -> CmdResult<Stamp> {
    w3proj::atomic::write_with(path, fill).map_err(err)?;
    stamp_of(path)
}

/// A text file; `NOT_UTF8` when it is there but isn't UTF-8 (the workspace tells binary files by it).
pub fn read_text(path: &Path) -> CmdResult<String> {
    let bytes = std::fs::read(path).map_err(err)?;
    String::from_utf8(bytes).map_err(|_| "NOT_UTF8".to_string())
}

/// Whether something is at the path. A path that can't be checked (a folder above it may not be looked
/// into) is an error, never "not there": callers create or write over what they take for absent.
pub fn exists_checked(path: &Path) -> CmdResult<bool> {
    path.try_exists().map_err(|e| format!("{}: can't be checked: {e}", path.display()))
}

/// Every file below a folder, as sorted paths relative to it with `/` separators. Links aren't
/// followed, so a link back up can't make this endless.
pub fn list_tree(root: &Path) -> CmdResult<Vec<String>> {
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

// ---------------------------------------------------------------- codecs

/// Validates a codec-backed project file (e.g. `map/war3map.w3i.json`) by encoding it to the archive
/// format, and returns it in canonical form. `formats`: format definition folders besides the
/// project's own (the app's user folder, W3PROJ_FORMATS for the CLI).
pub fn codec_canonicalize(root: &str, path: &str, text: &str, formats: &[PathBuf]) -> CmdResult<String> {
    let rel = path.strip_prefix("map/").unwrap_or(path);
    let registry = Registry::for_project(Path::new(root), formats).map_err(err)?;
    let (stem, codec) = registry
        .for_project_path(rel)
        .ok_or_else(|| format!("{path} is not a codec-backed file"))?;
    let name = w3proj::paths::to_archive_name(&stem);
    let bin = codec.encode(&name, text.as_bytes()).map_err(err)?;
    let canonical = codec.decode(&name, &bin).map_err(err)?;
    String::from_utf8(canonical).map_err(err)
}

/// Decodes a raw project file (e.g. `map/war3map.doo`) to JSON with the format definitions in
/// effect, for viewers that read either form.
pub fn codec_decode(root: &str, path: &str, formats: &[PathBuf]) -> CmdResult<String> {
    let rel = path.strip_prefix("map/").unwrap_or(path);
    // The file first: callers try this for files that may not be there (the raw form of a document
    // whose JSON form is missing), and loading the format definitions for nothing is slow.
    let bytes = std::fs::read(Path::new(root).join(path)).map_err(err)?;
    let registry = Registry::for_project(Path::new(root), formats).map_err(err)?;
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

/// Encodes JSON (as produced by `codec_decode`) back to the archive format and writes it to a raw
/// project file (e.g. `map/war3map.doo`).
pub fn codec_write(root: &str, path: &str, text: &str, formats: &[PathBuf]) -> CmdResult<Stamp> {
    let rel = path.strip_prefix("map/").unwrap_or(path);
    let registry = Registry::for_project(Path::new(root), formats).map_err(err)?;
    let name = w3proj::paths::to_archive_name(rel);
    let mut last = format!("no format definition writes {name}");
    for codec in registry.for_archive_name(&name) {
        match codec.encode(&name, text.as_bytes()) {
            Ok(bin) => {
                return write_file(&Path::new(root).join(path), |f| f.write_all(&bin));
            }
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

// ---------------------------------------------------------------- game data (CASC)

/// The opened game storage, keyed by install folder. Opening takes a moment
/// (index + encoding + root), so it happens once, on first use.
#[derive(Default)]
pub struct GameCache(Mutex<Option<(PathBuf, Arc<casc::GameData>)>>);

impl GameCache {
    pub fn get(&self, install: &str) -> CmdResult<Arc<casc::GameData>> {
        let mut guard = self.0.lock().unwrap();
        if let Some((dir, g)) = guard.as_ref() {
            if dir == Path::new(install) {
                return Ok(g.clone());
            }
        }
        let g = Arc::new(casc::GameData::open(Path::new(install)).map_err(|e| format!("game data: {e}"))?);
        *guard = Some((PathBuf::from(install), g.clone()));
        Ok(g)
    }
}

pub fn mode(m: &str) -> CmdResult<casc::Mode> {
    casc::Mode::parse(m).ok_or_else(|| format!("unknown graphics mode {m:?} (sd, hd or de)"))
}

/// A tileset letter ("L"), which adds that tileset's folders (`_Tilesets/L.w3mod`) to the lookup.
pub fn tileset_letter(t: &Option<String>) -> Option<char> {
    t.as_deref().and_then(|s| s.chars().next())
}

#[derive(Serialize)]
pub struct GameInfo {
    pub version: String,
    pub locale: String,
    pub entries: usize,
    pub stored: usize,
}

pub fn game_info(g: &casc::GameData) -> GameInfo {
    GameInfo {
        version: g.storage.build.version.clone(),
        locale: g.locale.clone(),
        entries: g.total_entries(),
        stored: g.local_paths().count(),
    }
}

/// Newline-separated full paths of every stored file (one string keeps the IPC payload small for ~90k entries).
pub fn game_list(g: &casc::GameData) -> String {
    g.local_paths().collect::<Vec<_>>().join("\n")
}

/// Reads a full path (`War3.w3mod:…`) as-is, or resolves a plain path.
pub fn game_read(g: &casc::GameData, path: &str, mode_name: &str, tileset: &Option<String>) -> CmdResult<Vec<u8>> {
    if path.contains(".w3mod:") {
        g.read_exact(path)
    } else {
        g.read(path, mode(mode_name)?, tileset_letter(tileset)).map(|(_, b)| b)
    }
    .map_err(err)
}

/// Resolves a plain path (`Units\UnitData.slk`) to the stored full path.
pub fn game_resolve(g: &casc::GameData, path: &str, mode_name: &str, tileset: &Option<String>) -> CmdResult<Option<String>> {
    Ok(g.resolve(path, mode(mode_name)?, tileset_letter(tileset)).map(str::to_string))
}
