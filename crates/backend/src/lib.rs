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

pub mod flatview;
pub mod script;
pub mod triggers;

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
    // A split terrain's flat files (flatview): the app's code finds them as in a flat project.
    flatview::list_flat(root, &mut out);
    // A generated map script (flatview::script_of): under its map/ name, from the store.
    flatview::list_scripts(root, &mut out);
    Ok((out, unreadable))
}

/// The project's folders (forward slashes), the ones without files too; what `walk_project`
/// leaves out is left out here.
pub fn project_folders(root: &Path) -> CmdResult<Vec<String>> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        // A subfolder that can't be read is listed itself but not entered (`walk_project` names it); the root must be readable.
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) if dir != root => continue,
            Err(e) => return Err(err(e)),
        };
        for entry in entries {
            let Ok(entry) = entry else { break };
            // A name with a `\` is a stray of an older version (see walk_project): not a folder path.
            if !entry.file_type().is_ok_and(|t| t.is_dir()) || entry.file_name().to_string_lossy().contains('\\') {
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
    /// Other files the write changed (a split terrain's flat file: the subterrain files it went into).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub also: Vec<flatview::Also>,
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
    Ok(Stamp { size: meta.len(), modified: modified_ms(&meta), also: Vec::new() })
}

/// Every save of the app: the folders above are made, then the file is replaced in one step
/// (`w3proj::atomic`: a temporary file renamed over it), so a write that fails partway (a full disk)
/// leaves the old file whole. A link is written through to its file. Gives the stamp the file has after.
pub fn write_file(path: &Path, fill: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>) -> CmdResult<Stamp> {
    w3proj::atomic::write_with(path, fill).map_err(err)?;
    stamp_of(path)
}

/// A file path inside `root` (the open project), for deleting and renaming: its folder is resolved (links, `..`,
/// short names), the file name itself isn't, so a link is deleted or moved, not what it points to.
pub fn inside(root: &str, path: &str) -> CmdResult<PathBuf> {
    let root = std::fs::canonicalize(root).map_err(|e| format!("{root}: {e}"))?;
    let p = PathBuf::from(path);
    let parent = p.parent().ok_or("no parent folder")?;
    let parent = std::fs::canonicalize(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    if !parent.starts_with(&root) {
        return Err(format!("{path} is outside the project"));
    }
    Ok(parent.join(p.file_name().ok_or("no file name")?))
}

/// Whether a write to `path` lands inside `root`, through any link on the way: the file itself when it is there (a
/// link is written through to its file), else the deepest folder above it that is there, resolved, must be under the
/// resolved root. Resolved paths compare in one spelling (case and short names on Windows, links everywhere).
pub fn write_lands_inside(root: &Path, path: &Path) -> CmdResult<()> {
    let outside = || format!("{} is outside the project", path.display());
    if !path.is_absolute() || path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(outside());
    }
    let root = std::fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let mut at = path;
    loop {
        match std::fs::canonicalize(at) {
            Ok(real) => return if real.starts_with(&root) { Ok(()) } else { Err(outside()) },
            // A link whose target isn't there: a write would make the target, wherever it is.
            Err(_) if at.symlink_metadata().is_ok() => return Err(outside()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => at = at.parent().ok_or_else(outside)?,
            Err(e) => return Err(format!("{}: can't be checked: {e}", at.display())),
        }
    }
}

/// A text file; `NOT_UTF8` when it is there but isn't UTF-8 (the workspace tells binary files by it). A split
/// terrain's flat file is assembled (`flatview`).
pub fn read_text(path: &Path) -> CmdResult<String> {
    let bytes = flatview::read_bytes(path)?;
    String::from_utf8(bytes).map_err(|_| "NOT_UTF8".to_string())
}

/// A file's bytes (`fs_read_bytes`); a split terrain's flat file assembled (`flatview`).
pub fn read_bytes(path: &Path) -> CmdResult<Vec<u8>> {
    flatview::read_bytes(path)
}

/// Writes a file the app saves (`fs_write_text`, `fs_write_bytes`): in one step (`write_file`), or for a split
/// terrain's flat file into the subterrains it stands for (`flatview::write_flat`).
pub fn write_bytes(path: &Path, bytes: &[u8]) -> CmdResult<Stamp> {
    match flatview::write_view(path, bytes)? {
        Some(stamp) => Ok(stamp),
        None => write_file(path, |f| f.write_all(bytes)),
    }
}

/// A file's size and time (`fs_stat`), None when there is none; a split terrain's flat file has its sources', a derived
/// file its stored file's, the Pathing tool's file its subterrains' `pathing.txt` (`flatview::stat_view`).
pub fn stat(path: &Path) -> Option<Stamp> {
    match flatview::stat_view(path) {
        Ok(Some(s)) => s,
        _ => stamp_of(path).ok(),
    }
}

#[derive(Serialize, Debug)]
pub struct HashedStamp {
    pub size: u64,
    pub modified: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

/// Size, last write and a hash of the contents (`fs_stat_hashed`); None when there is no such file, no hash when it
/// is there but can't be read (it isn't taken for missing). A split terrain's flat file: its sources'.
pub fn stat_hashed(path: &Path) -> Option<HashedStamp> {
    if let (Ok(Some(s)), Ok(Some(hash))) = (flatview::stat_view(path), flatview::hash_view(path)) {
        return s.map(|s| HashedStamp { size: s.size, modified: s.modified, hash });
    }
    // Time first: a write between the two gives a hash of the newer bytes with the older time, which differs
    // from the next look at the time anyway.
    let stamp = stamp_of(path).ok()?;
    let hash = std::fs::read(path).ok().map(|b| content_hash(&b));
    Some(HashedStamp { size: stamp.size, modified: stamp.modified, hash })
}

/// FNV-1a, 64 bits, as hex: tells two contents of the same size apart (not a guard against someone making
/// them collide on purpose).
pub fn content_hash(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Whether something is at the path (`fs_exists`), a split terrain's flat file too. A path that can't be checked is
/// an error (`exists_checked`).
pub fn exists(path: &Path) -> CmdResult<bool> {
    match flatview::exists_view(path)? {
        Some(there) => Ok(there),
        None => exists_checked(path),
    }
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
    let preserve = serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.get("skinIds").and_then(serde_json::Value::as_bool));
    let bin = codec.encode(&name, text.as_bytes()).map_err(err)?;
    let mut canonical = codec.decode(&name, &bin).map_err(err)?;
    let full = Path::new(root).join(path);
    w3proj::project::resolve_empty_v8_skin_ids(
        &name,
        &mut canonical,
        || w3proj::project::w3i_skin_status_in_dir(full.parent().unwrap_or_else(|| Path::new(root)), &registry),
        &registry,
        preserve,
    );
    String::from_utf8(canonical).map_err(err)
}

/// Decodes a raw project file (e.g. `map/war3map.doo`) to JSON with the format definitions in
/// effect, for viewers that read either form.
pub fn codec_decode(root: &str, path: &str, formats: &[PathBuf]) -> CmdResult<String> {
    let rel = path.strip_prefix("map/").unwrap_or(path);
    // The file first: callers try this for files that may not be there (the raw form of a document
    // whose JSON form is missing), and loading the format definitions for nothing is slow.
    let full = Path::new(root).join(path);
    // A split project's derived files are answered from its store (flatview).
    let bytes = read_bytes(&full)?;
    let registry = Registry::for_project(Path::new(root), formats).map_err(err)?;
    let name = w3proj::paths::to_archive_name(rel);
    let mut last = format!("no format definition reads {name}");
    for codec in registry.for_archive_name(&name) {
        match codec.decode(&name, &bytes) {
            Ok(mut json) => {
                w3proj::project::resolve_empty_v8_skin_ids(
                    &name,
                    &mut json,
                    || w3proj::project::w3i_skin_status_in_dir(full.parent().unwrap_or_else(|| Path::new(root)), &registry),
                    &registry,
                    None,
                );
                return String::from_utf8(json).map_err(err);
            }
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
                // A split project's derived files go into its store (flatview).
                return write_bytes(&Path::new(root).join(path), &bin);
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

#[cfg(test)]
mod codec_tests {
    use super::*;

    /// A camera or region value past what its field holds (an f32 past its range) is refused by both ways an editor
    /// writes: the raw file (codec_write) stays byte for byte as it was, and the JSON form gets no canonical text to
    /// write. A valid value goes through both (control).
    #[test]
    fn refused_camera_and_region_values_leave_the_files_unchanged() {
        let dir = std::env::temp_dir().join(format!("w3proj-backend-refuse-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("map")).unwrap();
        let root = dir.to_str().unwrap();
        let cameras = r#"{"format":"w3proj.cameras/1","version":3,"cameras":[{"targetX":1,"targetY":2,"zOffset":0,"rotation":90,"angleOfAttack":304,"distance":1650,"roll":0,"fieldOfView":70,"farZ":5000,"nearZ":16,"localPitch":0,"localYaw":0,"localRoll":0,"dofDistance":0,"dofScale":0,"posAbsoluteZ":0,"name":"Look","trailer":0}]}"#;
        let regions = r#"{"format":"w3proj.regions/1","version":5,"regions":[{"left":0,"bottom":0,"right":64,"top":64,"name":"Area","index":0,"weather":"0x00000000","sound":"","color":{"blue":1,"green":2,"red":3,"alpha":255}}]}"#;
        for (file, text, field, value) in [("map/war3map.w3c", cameras, "\"distance\":1650", "\"distance\":1e39"), ("map/war3map.w3r", regions, "\"right\":64", "\"right\":1e39")] {
            codec_write(root, file, text, &[]).unwrap();
            let before = std::fs::read(dir.join(file)).unwrap();
            let bad = text.replace(field, value);
            assert_ne!(bad, text);
            assert!(codec_write(root, file, &bad, &[]).is_err(), "{file}: {value} was written");
            assert_eq!(std::fs::read(dir.join(file)).unwrap(), before, "{file}: a refused write changed the file");
            assert!(codec_canonicalize(root, &format!("{file}.json"), &bad, &[]).is_err(), "{file}.json: {value} was taken");
            // Control: a value the field holds is written.
            let good = text.replace(field, &value.replace("1e39", "128"));
            codec_write(root, file, &good, &[]).unwrap();
            assert_ne!(std::fs::read(dir.join(file)).unwrap(), before, "{file}: the control value wasn't written");
            codec_canonicalize(root, &format!("{file}.json"), &good, &[]).unwrap();
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn codec_decode_and_canonicalize_resolve_empty_v8_skin_ids_from_w3i() {
        let dir = std::env::temp_dir().join(format!("w3proj-backend-v8skin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("map")).unwrap();
        let root = dir.to_str().unwrap();

        let empty_units = [b"W3do".to_vec(), 8u32.to_le_bytes().to_vec(), 11u32.to_le_bytes().to_vec(), 0u32.to_le_bytes().to_vec()].concat();
        let empty_doo = [empty_units.clone(), 0u32.to_le_bytes().to_vec(), 0u32.to_le_bytes().to_vec()].concat();
        std::fs::write(dir.join("map/war3mapUnits.doo"), &empty_units).unwrap();
        std::fs::write(dir.join("map/war3map.doo"), &empty_doo).unwrap();

        let units_with_true = r#"{"format":"w3proj.units/1","magic":"W3do","version":8,"subversion":11,"skinIds":true,"units":[]}"#;
        let units_with_false = r#"{"format":"w3proj.units/1","magic":"W3do","version":8,"subversion":11,"skinIds":false,"units":[]}"#;
        let doo_with_true = r#"{"format":"w3proj.doodads/1","magic":"W3do","version":8,"subversion":11,"skinIds":true,"doodads":[],"specialVersion":0,"specials":[]}"#;

        // Pre-Reforged war3map.w3i.json -> false.
        std::fs::write(dir.join("map/war3map.w3i.json"), r#"{"version":25,"editorVersion":6059}"#).unwrap();
        let dec_u: serde_json::Value = serde_json::from_str(&codec_decode(root, "map/war3mapUnits.doo", &[]).unwrap()).unwrap();
        let dec_d: serde_json::Value = serde_json::from_str(&codec_decode(root, "map/war3map.doo", &[]).unwrap()).unwrap();
        assert_eq!(dec_u["skinIds"], false);
        assert_eq!(dec_d["skinIds"], false);
        let can_u: serde_json::Value = serde_json::from_str(&codec_canonicalize(root, "map/war3mapUnits.doo.json", units_with_true, &[]).unwrap()).unwrap();
        let can_d: serde_json::Value = serde_json::from_str(&codec_canonicalize(root, "map/war3map.doo.json", doo_with_true, &[]).unwrap()).unwrap();
        assert_eq!(can_u["skinIds"], false);
        assert_eq!(can_d["skinIds"], false);

        // Reforged war3map.w3i.json -> true.
        std::fs::write(dir.join("map/war3map.w3i.json"), r#"{"version":33,"editorVersion":6117}"#).unwrap();
        let dec_u: serde_json::Value = serde_json::from_str(&codec_decode(root, "map/war3mapUnits.doo", &[]).unwrap()).unwrap();
        let can_u: serde_json::Value = serde_json::from_str(&codec_canonicalize(root, "map/war3mapUnits.doo.json", units_with_false, &[]).unwrap()).unwrap();
        assert_eq!(dec_u["skinIds"], true);
        assert_eq!(can_u["skinIds"], true);

        // Raw war3map.w3i (no .json) with Reforged editorVersion -> true too.
        std::fs::remove_file(dir.join("map/war3map.w3i.json")).unwrap();
        let min_w3i = r#"{"format":"w3proj.mapinfo/1","version":25,"saves":1,"editorVersion":6114,"name":"M","author":"A","description":"D","suggestedPlayers":"1","cameraBounds":[-1,-1,1,1,-1,1,1,-1],"cameraComplements":[1,1,1,1],"playableWidth":2,"playableHeight":2,"flags":0,"tileset":"L","loadingScreen":{"number":-1,"model":"","text":"","title":"","subtitle":""},"gameDataSet":0,"prologue":{"path":"","text":"","title":"","subtitle":""},"fog":{"style":0,"start":0,"end":0,"density":0,"color":[0,0,0,0]},"weather":"0x00000000","soundEnvironment":"","lightEnvironment":"","waterTint":[0,0,0,0],"players":[],"forces":[],"upgrades":[],"techs":[],"unitTables":[],"itemTables":[]}"#;
        codec_write(root, "map/war3map.w3i", min_w3i, &[]).unwrap();
        let dec_raw_w3i: serde_json::Value = serde_json::from_str(&codec_decode(root, "map/war3mapUnits.doo", &[]).unwrap()).unwrap();
        assert_eq!(dec_raw_w3i["skinIds"], true);
        std::fs::remove_file(dir.join("map/war3map.w3i")).unwrap();

        // Absent war3map.w3i -> false for raw decode and canonicalize alike.
        let dec_absent: serde_json::Value = serde_json::from_str(&codec_decode(root, "map/war3mapUnits.doo", &[]).unwrap()).unwrap();
        assert_eq!(dec_absent["skinIds"], false);
        let can_absent: serde_json::Value = serde_json::from_str(&codec_canonicalize(root, "map/war3mapUnits.doo.json", units_with_true, &[]).unwrap()).unwrap();
        assert_eq!(can_absent["skinIds"], false);

        // Corrupt/unreadable war3map.w3i -> raw decode defaults false, while canonicalize preserves the input's flag.
        std::fs::write(dir.join("map/war3map.w3i.json"), b"{corrupt").unwrap();
        let dec_corrupt: serde_json::Value = serde_json::from_str(&codec_decode(root, "map/war3mapUnits.doo", &[]).unwrap()).unwrap();
        assert_eq!(dec_corrupt["skinIds"], false);
        let can_corrupt_true: serde_json::Value = serde_json::from_str(&codec_canonicalize(root, "map/war3mapUnits.doo.json", units_with_true, &[]).unwrap()).unwrap();
        let can_corrupt_false: serde_json::Value = serde_json::from_str(&codec_canonicalize(root, "map/war3mapUnits.doo.json", units_with_false, &[]).unwrap()).unwrap();
        let can_corrupt_doo_true: serde_json::Value = serde_json::from_str(&codec_canonicalize(root, "map/war3map.doo.json", doo_with_true, &[]).unwrap()).unwrap();
        assert_eq!(can_corrupt_true["skinIds"], true);
        assert_eq!(can_corrupt_false["skinIds"], false);
        assert_eq!(can_corrupt_doo_true["skinIds"], true);

        // Missing map subfolder (unreadable dir) also preserves input flag instead of treating as Absent.
        std::fs::remove_dir_all(dir.join("map")).unwrap();
        let can_unreadable_dir: serde_json::Value = serde_json::from_str(&codec_canonicalize(root, "map/war3mapUnits.doo.json", units_with_true, &[]).unwrap()).unwrap();
        assert_eq!(can_unreadable_dir["skinIds"], true);

        let _ = std::fs::remove_dir_all(dir);
    }
}
