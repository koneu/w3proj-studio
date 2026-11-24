//! Whether a project's derived files (pathing war3map.wpm, shadows war3map.shd, the minimap
//! war3mapMap.blp) still follow its terrain and doodads.
//!
//! The app makes them from war3map.w3e and war3map.doo, after a terrain save at once and a few
//! seconds after a tool's edit; this crate can't make them (that needs the game's pathing textures
//! and models). So whoever made them records here what the sources were (`record`): an unpack from
//! a map (the World Editor made its files from each other), the app after it wrote them. A pack
//! outside the app checks that record (`check`): sources changed since mean the derived files in
//! the project are older than the ground and doodads they'd go into the map with.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::project::{write_atomic, MAP_DIR};
use crate::{Error, Result};

/// The record, in the project folder.
pub const STAMP_FILE: &str = ".w3proj/derived-from.json";

const FORMAT: &str = "w3proj.derived-from/1";

/// The files under `map/` the derived files are made from, raw or as text (any case), and with the
/// split terrain layout every file under `map/terrain/` (`sources`).
const SOURCES: &[&str] = &["war3map.w3e", "war3map.w3e.txt", "war3map.doo", "war3map.doo.json"];

/// The files the sources go into, for messages.
pub const DERIVED: &str = "pathing (war3map.wpm), shadows (war3map.shd) and the minimap (war3mapMap.blp)";

/// The project's source files as they are now: file name under `map/` → a fingerprint of its bytes.
/// Absent ones aren't in it; one that is there but can't be read is an error.
pub type Sources = BTreeMap<String, String>;

pub fn sources(project: &Path) -> Result<Sources> {
    // The split terrain layout: every file under map/terrain/ counts (`terrain/<path>`).
    read_sources(project, &|_| false)
}

/// The key of a record made while subterrains were closed (`sources_open`): how many. Not a file name (`?` can't be one
/// on Windows), so it never stands for a source.
pub const CLOSED_KEY: &str = "?closed-subterrains";

/// The sources as the app records them after making the derived files from what it has loaded: `sources`, but with
/// subterrains closed (`crate::terrain_open`) their files are left out (never read) and `CLOSED_KEY` says how many there
/// were, so `check` takes the files for stale whatever else matches (they can't follow a map that wasn't all there).
pub fn sources_open(project: &Path) -> Result<Sources> {
    let map = project.join(MAP_DIR);
    if !crate::terrain_layout::is_split_on_disk(&map)? {
        return sources(project);
    }
    let bytes = fs::read(map.join(crate::terrain_layout::DIR).join("terrain.json")).map_err(|e| Error::Project(format!("map/{} can't be read: {e}", crate::terrain_layout::LAYOUT_FILE)))?;
    let layout = crate::terrain_layout::Layout::parse(&bytes)?;
    let Some(partial) = crate::terrain_open::of_map_dir(&map, &layout)? else { return sources(project) };
    let closed: Vec<String> = layout.subterrains.iter().zip(&partial.open).filter(|(_, o)| !**o).map(|(s, _)| format!("{}/{}/", crate::terrain_layout::DIR, s.folder)).collect();
    let mut out = read_sources(project, &|path| closed.iter().any(|c| path.starts_with(c.as_str())))?;
    out.insert(CLOSED_KEY.to_string(), partial.closed_count().to_string());
    Ok(out)
}

/// The source files' fingerprints (`sources`), those under `map/` whose path `skip` names left out unread.
fn read_sources(project: &Path, skip: &dyn Fn(&str) -> bool) -> Result<Sources> {
    let map = project.join(MAP_DIR);
    let mut out = Sources::new();
    let entries = match fs::read_dir(&map) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(Error::Project(format!("{} can't be read: {e}", map.display()))),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !SOURCES.iter().any(|s| s.eq_ignore_ascii_case(&name)) || !entry.file_type()?.is_file() {
            continue;
        }
        let bytes = fs::read(entry.path()).map_err(|e| Error::Project(format!("{MAP_DIR}/{name} can't be read: {e}")))?;
        out.insert(name, fingerprint(&bytes));
    }
    if crate::terrain_layout::is_split_on_disk(&map)? {
        for path in crate::terrain_layout::FOLDER.paths(&map)? {
            if skip(&path) {
                continue;
            }
            let bytes = crate::folder_codec::read(&map, &path)?;
            out.insert(path, fingerprint(&bytes));
        }
    }
    Ok(out)
}

/// FNV-1a (64 bit) and the length: it tells an edited file from the one recorded, nothing more.
fn fingerprint(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}-{}", bytes.len())
}

/// Records that the derived files follow `sources` (taken before they were made: a source written
/// meanwhile then shows as changed). A project with no source files gets no record. The map script's
/// group in the record (`record_script`) stays as it is.
pub fn record(project: &Path, sources: &Sources) -> Result<()> {
    if sources.is_empty() {
        return Ok(());
    }
    write_group(project, "files", Some(sources))
}

/// Sets one group of the record (`files`: pathing, shadows and the minimap; `script`: the map script), or removes it
/// (None); the other stays. A record that can't be read is written anew by `record` (it says what pathing, shadows and
/// the minimap follow, all a record said before the script had a group), and is an error for the script's group: written
/// over, a record whose terrain group refused a pack would let it through.
fn write_group(project: &Path, key: &str, sources: Option<&Sources>) -> Result<()> {
    let _held = RecordLock::take(project);
    let path = project.join(STAMP_FILE);
    let old = match fs::read(&path) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) if key == "files" => None,
        Err(e) => return Err(Error::Project(format!("{STAMP_FILE} is there but can't be read ({e}): the map script's record isn't written"))),
    };
    let parsed = old
        .as_deref()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(b).ok())
        .filter(|d| d.get("format").and_then(serde_json::Value::as_str) == Some(FORMAT))
        .and_then(|d| d.as_object().cloned());
    if parsed.is_none() && old.is_some() && key != "files" {
        return Err(Error::Project(format!("{STAMP_FILE} isn't a record of the derived files' sources: the map script's record isn't written (W3Proj Studio's save or `w3proj rebuild` writes it anew)")));
    }
    let mut doc = parsed.unwrap_or_default();
    doc.insert("format".into(), FORMAT.into());
    match sources {
        Some(s) => {
            let value = serde_json::to_value(s).map_err(|e| Error::Format(e.to_string()))?;
            doc.insert(key.into(), if key == "files" { value } else { serde_json::json!({ "files": value }) });
        }
        None => {
            doc.remove(key);
        }
    }
    if doc.len() == 1 {
        // Only the format is left: no record.
        if old.is_some() {
            fs::remove_file(&path)?;
        }
        return Ok(());
    }
    let mut text = serde_json::to_string_pretty(&serde_json::Value::Object(doc)).map_err(|e| Error::Format(e.to_string()))?;
    text.push('\n');
    if old.as_deref() == Some(text.as_bytes()) {
        return Ok(());
    }
    write_atomic(&path, text.as_bytes())
}

/// Held while a group of the record is read, changed and written back (`write_group`), so two writers (the app's
/// `record` after making pathing, shadows and the minimap, a sync's `record_script`, in one process or the app and the
/// CLI) never write back a record read before the other's write, losing that group. An OS lock on a file outside the
/// project (in the temporary folder, named after the project's path: nothing turns up in its git status), which the OS
/// lets go when a process ends however it ends. Where that file can't be opened or locked, a lock within the process.
struct RecordLock {
    _file: Option<fs::File>,
    _inner: Option<std::sync::MutexGuard<'static, ()>>,
}

impl RecordLock {
    fn take(project: &Path) -> RecordLock {
        if let Some(file) = Self::lock_file(project) {
            if file.lock().is_ok() {
                return RecordLock { _file: Some(file), _inner: None };
            }
        }
        static INNER: std::sync::Mutex<()> = std::sync::Mutex::new(());
        RecordLock { _file: None, _inner: Some(INNER.lock().unwrap_or_else(|e| e.into_inner())) }
    }

    fn lock_file(project: &Path) -> Option<fs::File> {
        let full = fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
        let dir = std::env::temp_dir().join("w3proj-locks");
        fs::create_dir_all(&dir).ok()?;
        let name = format!("derived-from-{}.lock", fingerprint(full.to_string_lossy().as_bytes()));
        fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(dir.join(name)).ok()
    }
}

/// Records the sources as they are now.
pub fn record_now(project: &Path) -> Result<()> {
    record(project, &sources(project)?)
}

#[derive(Debug, PartialEq)]
pub enum Freshness {
    /// The sources are those recorded.
    Fresh,
    /// No record (a project from before records were kept): nothing can be told.
    Unknown,
    /// These source files changed, appeared or went since the record.
    Stale(Vec<String>),
    /// The record is there but can't be read (why).
    Unreadable(String),
    /// They were made while this many subterrains were closed (`sources_open`): they follow part of the map only.
    Partial(usize),
}

impl Freshness {
    /// What a refusal says about a record that was made with subterrains closed.
    pub fn partial_text(n: usize) -> String {
        format!(
            "{n} subterrain{} {} closed when they were saved, so they follow part of the map only: open all subterrains in Studio and save, or run `w3proj rebuild`",
            if n == 1 { "" } else { "s" },
            if n == 1 { "was" } else { "were" }
        )
    }
}

pub fn check(project: &Path) -> Result<Freshness> {
    check_group(project, false, &sources)
}

/// `check` of one group of the record: pathing, shadows and the minimap, or (`script`) the map script.
fn check_group(project: &Path, script: bool, now: &dyn Fn(&Path) -> Result<Sources>) -> Result<Freshness> {
    let path = project.join(STAMP_FILE);
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Freshness::Unknown),
        Err(e) => return Ok(Freshness::Unreadable(format!("{STAMP_FILE} is there but can't be read ({e})"))),
    };
    let recorded = match parse(&bytes, script) {
        Some(Some(r)) => r,
        Some(None) => return Ok(Freshness::Unknown),
        None => return Ok(Freshness::Unreadable(format!("{STAMP_FILE} isn't a record of the derived files' sources"))),
    };
    if let Some(n) = recorded.get(CLOSED_KEY) {
        return Ok(Freshness::Partial(n.parse().unwrap_or(1)));
    }
    let now = now(project)?;
    let lower = |m: &Sources| m.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.clone())).collect::<BTreeMap<_, _>>();
    let (was, is) = (lower(&recorded), lower(&now));
    let mut changed: Vec<String> = is
        .iter()
        .filter(|(k, v)| was.get(*k) != Some(*v))
        .map(|(k, _)| k.clone())
        .chain(was.keys().filter(|k| !is.contains_key(*k)).cloned())
        .collect();
    changed.sort();
    changed.dedup();
    Ok(if changed.is_empty() { Freshness::Fresh } else { Freshness::Stale(changed) })
}

/// A group of the record: None when the record isn't one (another format, a group that isn't a list of fingerprints),
/// Some(None) when it hasn't the group.
fn parse(bytes: &[u8], script: bool) -> Option<Option<Sources>> {
    let doc: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    if doc.get("format")?.as_str()? != FORMAT {
        return None;
    }
    let group = if script {
        match doc.get("script") {
            None => return Some(None),
            Some(s) => s.get("files")?,
        }
    } else {
        match doc.get("files") {
            None => return Some(None),
            Some(f) => f,
        }
    };
    group.as_object()?.iter().map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect::<Option<Sources>>().map(Some)
}

// ---- the map script (`crate::trigger_layout` "script": "generated") ----
//
// A generated script isn't tracked in git: it lives in the store `.w3proj/derived/` (war3map.j or war3map.lua), and the
// record's `script` group says what it was made from (`script_sources`). Studio's generator writes it (it needs the
// game's data); a pack outside the app takes it only when the record says it follows its sources.

/// The map script's names (`.w3proj/derived/` or `map/`).
pub const SCRIPT_FILES: [&str; 2] = ["war3map.j", "war3map.lua"];

/// The record of the script Studio wrote last (app/src/lib/script/guard.ts SCRIPT_STAMP): its hash (`script_hash`).
pub const SCRIPT_STAMP: &str = ".w3proj/generated-script";

/// guard.ts scriptHash: FNV-1a over the text's UTF-16 code units, as 8 hex digits.
pub fn script_hash(text: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for unit in text.encode_utf16() {
        h = (h ^ u32::from(unit)).wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

/// The hash `SCRIPT_STAMP` holds; None when it isn't there or can't be read (nothing then is taken for Studio's).
pub fn script_stamp(project: &Path) -> Option<String> {
    fs::read(project.join(SCRIPT_STAMP)).ok().map(|b| String::from_utf8_lossy(&b).trim().to_string())
}

/// The map script files in the project's store: name → bytes. One that is there and can't be read is an error.
pub fn read_script_store(project: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    let dir = store_dir(project);
    let mut out = BTreeMap::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(Error::Project(format!("{} can't be read: {e}", STORE_DIR.join("/")))),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !SCRIPT_FILES.iter().any(|s| s.eq_ignore_ascii_case(&name)) || !entry.file_type()?.is_file() {
            continue;
        }
        let bytes = fs::read(entry.path()).map_err(|e| Error::Project(format!("{}/{name} can't be read: {e}", STORE_DIR.join("/"))))?;
        out.insert(name, bytes);
    }
    Ok(out)
}

/// Makes the store hold `script` (name, bytes) as the map script and no other; None removes the one there.
pub fn sync_script_store(project: &Path, script: Option<(&str, &[u8])>) -> Result<()> {
    let dir = store_dir(project);
    for (name, _) in read_script_store(project)? {
        if script.is_none_or(|(n, _)| n != name) {
            fs::remove_file(dir.join(&name))?;
        }
    }
    if let Some((name, bytes)) = script {
        fs::create_dir_all(&dir)?;
        crate::project::write_if_changed(&dir.join(name), bytes)?;
    }
    let _ = fs::remove_dir(&dir);
    Ok(())
}

/// Whether a file name under `map/` is one the map script is made from (guard.ts SCRIPT_INPUTS: the map's info, object
/// data, placed objects, regions, cameras, sounds, strings, raw or as JSON; any case).
fn is_script_input(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    let l = l.strip_suffix(".json").unwrap_or(&l);
    const EXT: [&str; 14] = ["wtg", "wct", "wts", "w3i", "w3r", "w3c", "w3s", "w3l", "doo", "w3e", "w3u", "w3t", "w3a", "w3b"];
    match l.split_once('.') {
        Some(("war3map", ext)) => EXT.contains(&ext),
        Some(("war3mapunits", "doo")) => true,
        Some(("war3mapskin", ext)) => ["w3u", "w3a", "w3b"].contains(&ext),
        _ => false,
    }
}

/// The map script's sources as they are now: `SCRIPT_INPUTS` under `map/` and every file under `map/triggers/` and
/// `map/terrain/` (name under `map/` → fingerprint). One that is there but can't be read is an error.
pub fn script_sources(project: &Path) -> Result<Sources> {
    let map = project.join(MAP_DIR);
    let mut out = Sources::new();
    let entries = match fs::read_dir(&map) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(Error::Project(format!("{} can't be read: {e}", map.display()))),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_script_input(&name) || !entry.file_type()?.is_file() {
            continue;
        }
        let bytes = fs::read(entry.path()).map_err(|e| Error::Project(format!("{MAP_DIR}/{name} can't be read: {e}")))?;
        out.insert(name, fingerprint(&bytes));
    }
    for dir in [crate::trigger_layout::DIR, crate::terrain_layout::DIR] {
        for rel in crate::project::walk(&map.join(dir))? {
            let path = format!("{dir}/{rel}");
            let bytes = fs::read(crate::paths::join_rel(&map, &path)).map_err(|e| Error::Project(format!("{MAP_DIR}/{path} can't be read: {e}")))?;
            out.insert(path, fingerprint(&bytes));
        }
    }
    Ok(out)
}

/// The script's sources as the app records them before generating from what it has loaded: `script_sources`, and while
/// subterrains are closed (`crate::terrain_open`) `CLOSED_KEY` with how many, so `check_script` takes the script for one
/// made from part of the map (the placed objects of the closed ones are missing from it) whatever else matches.
pub fn script_sources_open(project: &Path) -> Result<Sources> {
    let mut out = script_sources(project)?;
    let map = project.join(MAP_DIR);
    if crate::terrain_layout::is_split_on_disk(&map)? {
        let bytes = fs::read(map.join(crate::terrain_layout::DIR).join("terrain.json")).map_err(|e| Error::Project(format!("map/{} can't be read: {e}", crate::terrain_layout::LAYOUT_FILE)))?;
        let layout = crate::terrain_layout::Layout::parse(&bytes)?;
        if let Some(partial) = crate::terrain_open::of_map_dir(&map, &layout)? {
            out.insert(CLOSED_KEY.to_string(), partial.closed_count().to_string());
        }
    }
    Ok(out)
}

/// Records that the generated map script in the store follows `sources` (`script_sources`, taken before it was made);
/// the record's other group stays.
pub fn record_script(project: &Path, sources: &Sources) -> Result<()> {
    write_group(project, "script", Some(sources))
}

/// Records the script's sources as they are now.
pub fn record_script_now(project: &Path) -> Result<()> {
    record_script(project, &script_sources(project)?)
}

/// Removes the script's group from the record (the script is a tracked file again).
pub fn clear_script_record(project: &Path) -> Result<()> {
    match fs::read(project.join(STAMP_FILE)) {
        Ok(b) if parse(&b, true).is_some_and(|g| g.is_some()) => write_group(project, "script", None),
        _ => Ok(()),
    }
}

/// Whether the generated map script follows its sources (`check`, for the record's `script` group).
pub fn check_script(project: &Path) -> Result<Freshness> {
    check_group(project, true, &script_sources)
}

// ---- where the derived files are: map/ (flat layout) or the local store (split layout) ----
//
// In a project whose terrain is split (`map/terrain/`, `crate::terrain_layout`) the derived files aren't tracked in git:
// they live in `.w3proj/derived/` under the names they have in `map/` (git-ignored, `IGNORED`), and the app's file
// layer answers the `map/` names from there (crates/backend flatview.rs). A flat project keeps them in `map/`.

/// The store of a split project's derived files, relative to the project.
pub const STORE_DIR: [&str; 2] = [".w3proj", "derived"];

/// The derived files' names under `map/` (any case): pathing, shadows, the minimap and its icons (raw or as JSON).
pub const FILES: [&str; 5] = ["war3map.wpm", "war3map.shd", "war3mapMap.blp", "war3map.mmp", "war3map.mmp.json"];

/// What a pack of a split project needs, one entry per file (any of its names).
const REQUIRED: [&[&str]; 4] = [&["war3map.wpm"], &["war3map.shd"], &["war3mapMap.blp"], &["war3map.mmp", "war3map.mmp.json"]];

/// The `.gitignore` lines a split project needs: the store and the record are local, never committed.
pub const IGNORED: [&str; 2] = ["/.w3proj/derived/", "/.w3proj/derived-from.json"];

/// The same for a campaign's chapter maps (`maps/<chapter>/`), which are projects of their own with no `.gitignore`.
pub const CHAPTERS_IGNORED: [&str; 2] = ["/maps/*/.w3proj/derived/", "/maps/*/.w3proj/derived-from.json"];

/// Whether a file name under `map/` is a derived file's (`FILES`, any case): the name as `FILES` has it.
pub fn derived_name(name: &str) -> Option<&'static str> {
    FILES.iter().copied().find(|f| f.eq_ignore_ascii_case(name))
}

/// The project's store folder (`STORE_DIR`).
pub fn store_dir(project: &Path) -> std::path::PathBuf {
    STORE_DIR.iter().fold(project.to_path_buf(), |p, c| p.join(c))
}

/// Whether the project's terrain is split (its derived files then live in the store).
pub fn uses_store(project: &Path) -> Result<bool> {
    crate::terrain_layout::is_split_on_disk(&project.join(MAP_DIR))
}

/// The derived files in a folder (`map/` or the store): name as on disk → bytes. A file that is there and can't be read is
/// an error; a folder that isn't there has none.
fn read_derived_in(dir: &Path, shown: &str) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut out = BTreeMap::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(Error::Project(format!("{shown} can't be read: {e}"))),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if derived_name(&name).is_none() || !entry.file_type()?.is_file() {
            continue;
        }
        let bytes = fs::read(entry.path()).map_err(|e| Error::Project(format!("{shown}/{name} can't be read: {e}")))?;
        out.insert(name, bytes);
    }
    Ok(out)
}

/// The derived files in the project's store: name under `map/` → bytes.
pub fn read_store(project: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    read_derived_in(&store_dir(project), &STORE_DIR.join("/"))
}

/// The derived files among project files (relative to `map/`), taken out of them: name → bytes.
pub fn take(files: &mut BTreeMap<String, Vec<u8>>) -> BTreeMap<String, Vec<u8>> {
    let names: Vec<String> = files.keys().filter(|k| derived_name(k).is_some()).cloned().collect();
    names.into_iter().filter_map(|n| files.remove(&n).map(|b| (n, b))).collect()
}

/// Makes the store hold exactly `derived` (name under `map/` → bytes): those written where they differ, other derived
/// files there removed (a map without shadows leaves none behind). A name in another case than the one there replaces it.
pub fn sync_store(project: &Path, derived: &BTreeMap<String, Vec<u8>>) -> Result<()> {
    let dir = store_dir(project);
    for (name, _) in read_derived_in(&dir, &STORE_DIR.join("/"))? {
        if !derived.contains_key(&name) {
            fs::remove_file(dir.join(&name))?;
        }
    }
    for (name, bytes) in derived {
        crate::project::write_if_changed(&dir.join(name), bytes)?;
    }
    let _ = fs::remove_dir(&dir);
    Ok(())
}

/// The derived files at `from` and at `to`; an error when one is at both places and differs (which one the project means
/// can't be told).
type Both = (BTreeMap<String, Vec<u8>>, BTreeMap<String, Vec<u8>>);

fn both_places(from: &Path, from_shown: &str, to: &Path, to_shown: &str) -> Result<Both> {
    let found = read_derived_in(from, from_shown)?;
    let there = read_derived_in(to, to_shown)?;
    for (name, bytes) in &found {
        if let Some((other, b)) = there.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)) {
            if b != bytes {
                return Err(Error::Project(format!(
                    "{from_shown}/{name} and {to_shown}/{other} are both there and differ: keep one (delete the other), then try again"
                )));
            }
        }
    }
    Ok((found, there))
}

/// Whether `into_store` (`into`) or `out_of_store` would go through: an error when a file is at both places and differs.
/// For a conversion, before it writes anything.
pub fn can_move(project: &Path, into: bool) -> Result<()> {
    let (map, store) = (project.join(MAP_DIR), store_dir(project));
    let store_shown = STORE_DIR.join("/");
    if into {
        both_places(&map, MAP_DIR, &store, &store_shown).map(|_| ())
    } else {
        both_places(&store, &store_shown, &map, MAP_DIR).map(|_| ())
    }
}

/// What `into_store` and `out_of_store` moved: the names.
fn move_derived(from: &Path, from_shown: &str, to: &Path, to_shown: &str) -> Result<Vec<String>> {
    let (found, there) = both_places(from, from_shown, to, to_shown)?;
    let mut moved = Vec::new();
    for name in found.keys() {
        // The same bytes at both places: the moved one takes the other's place (its name wins).
        if let Some((other, _)) = there.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)) {
            fs::remove_file(to.join(other))?;
        }
        fs::create_dir_all(to)?;
        fs::rename(from.join(name), to.join(name))?;
        moved.push(name.clone());
    }
    Ok(moved)
}

/// Moves the derived files in `map/` into the store (a split; a project split before the store existed). Both there
/// and different: an error, nothing moved.
pub fn into_store(project: &Path) -> Result<Vec<String>> {
    move_derived(&project.join(MAP_DIR), MAP_DIR, &store_dir(project), &STORE_DIR.join("/"))
}

/// Moves the store's derived files back into `map/` (a merge); the empty store folder goes.
pub fn out_of_store(project: &Path) -> Result<Vec<String>> {
    let dir = store_dir(project);
    let moved = move_derived(&dir, &STORE_DIR.join("/"), &project.join(MAP_DIR), MAP_DIR)?;
    let _ = fs::remove_dir(&dir);
    Ok(moved)
}

/// A split project whose derived files are still in `map/` (split before the store existed): moved into the store, and
/// its `.gitignore` gets `IGNORED`. Nothing for a flat project. What was moved.
pub fn migrate(project: &Path) -> Result<Vec<String>> {
    if !uses_store(project)? {
        return Ok(Vec::new());
    }
    let moved = into_store(project)?;
    if !moved.is_empty() || store_dir(project).is_dir() {
        ensure_ignored(project)?;
    }
    Ok(moved)
}

/// The derived files a pack needs that a split project's store lacks (`REQUIRED`, the first name of each). None in a
/// flat project (its pack takes what `map/` has, as always).
pub fn missing(project: &Path) -> Result<Vec<&'static str>> {
    if !uses_store(project)? {
        return Ok(Vec::new());
    }
    let have = read_store(project)?;
    Ok(REQUIRED.iter().filter(|names| !have.keys().any(|k| names.iter().any(|n| n.eq_ignore_ascii_case(k)))).map(|names| names[0]).collect())
}

/// Adds the `IGNORED` lines the project's `.gitignore` lacks (makes the file when there is none). A file that is there
/// but can't be read is an error, never written over. Whether it was changed.
pub fn ensure_ignored(project: &Path) -> Result<bool> {
    ensure_lines(project, &IGNORED)
}

/// Adds `lines` the project's `.gitignore` lacks (`ensure_ignored`).
pub fn ensure_lines(project: &Path, lines: &[&str]) -> Result<bool> {
    let path = project.join(".gitignore");
    let mut text = match fs::read(&path) {
        Ok(b) => String::from_utf8(b).map_err(|_| Error::Project(format!("{} isn't UTF-8 text: add {} to it by hand", path.display(), lines.join(", "))))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(Error::Project(format!("{} can't be read ({e}): add {} to it by hand", path.display(), lines.join(", ")))),
    };
    let have: Vec<&str> = text.lines().map(str::trim).collect();
    let add: Vec<&str> = lines.iter().copied().filter(|l| !have.contains(l)).collect();
    if add.is_empty() {
        return Ok(false);
    }
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    for l in add {
        text.push_str(l);
        text.push('\n');
    }
    write_atomic(&path, text.as_bytes())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("w3proj-derived-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(MAP_DIR)).unwrap();
        fs::write(dir.join("map/war3map.w3e.txt"), "ground").unwrap();
        fs::write(dir.join("map/war3map.doo.json"), "{}").unwrap();
        fs::write(dir.join("map/war3map.wpm"), "pathing").unwrap();
        dir
    }

    #[test]
    fn a_source_edited_after_the_record_is_stale_and_others_are_not() {
        let dir = project("edit");
        assert_eq!(check(&dir).unwrap(), Freshness::Unknown);
        record_now(&dir).unwrap();
        assert_eq!(check(&dir).unwrap(), Freshness::Fresh);
        // A derived file written afterwards changes nothing.
        fs::write(dir.join("map/war3map.wpm"), "new pathing").unwrap();
        assert_eq!(check(&dir).unwrap(), Freshness::Fresh);
        fs::write(dir.join("map/war3map.doo.json"), "{\"doodads\":[]}").unwrap();
        assert_eq!(check(&dir).unwrap(), Freshness::Stale(vec!["war3map.doo.json".into()]));
        record_now(&dir).unwrap();
        // Gone, and kept raw instead of as text: both count.
        fs::remove_file(dir.join("map/war3map.w3e.txt")).unwrap();
        fs::write(dir.join("map/war3map.w3e"), "raw").unwrap();
        assert_eq!(check(&dir).unwrap(), Freshness::Stale(vec!["war3map.w3e".into(), "war3map.w3e.txt".into()]));
        let _ = fs::remove_dir_all(&dir);
    }

    /// With the split terrain layout every file under map/terrain/ is a source.
    #[test]
    fn every_file_of_a_split_terrain_is_a_source() {
        let dir = project("split");
        fs::remove_file(dir.join("map/war3map.w3e.txt")).unwrap();
        fs::create_dir_all(dir.join("map/terrain/a")).unwrap();
        fs::write(dir.join("map/terrain/terrain.json"), "{\"format\":\"w3proj.terrain/1\"}").unwrap();
        fs::write(dir.join("map/terrain/a/terrain.txt"), "corners").unwrap();
        record_now(&dir).unwrap();
        assert_eq!(check(&dir).unwrap(), Freshness::Fresh);
        fs::write(dir.join("map/terrain/a/terrain.txt"), "corners 1 1").unwrap();
        assert_eq!(check(&dir).unwrap(), Freshness::Stale(vec!["terrain/a/terrain.txt".into()]));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_record_that_cant_be_read_is_not_taken_for_none() {
        let dir = project("bad");
        for bad in ["", "{ not json", "{\"format\":\"other\",\"files\":{}}", "{\"format\":\"w3proj.derived-from/1\",\"files\":{\"a\":1}}"] {
            fs::create_dir_all(dir.join(".w3proj")).unwrap();
            fs::write(dir.join(STAMP_FILE), bad).unwrap();
            assert!(matches!(check(&dir).unwrap(), Freshness::Unreadable(_)), "{bad:?}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// The hash is guard.ts scriptHash's (the same values there: guard.test.ts), over UTF-16 code units.
    #[test]
    fn the_script_hash_is_the_apps() {
        assert_eq!(script_hash(""), "811c9dc5");
        assert_eq!(script_hash("abc"), "1a47e90b");
        assert_eq!(script_hash("\u{e4}\u{20ac}\u{1F600}"), "3702d130");
    }

    /// The map script's group and the terrain's share the record: writing one keeps the other, each is checked on its
    /// own, and a record that can't be read isn't written over for the script (its terrain group would pass then).
    #[test]
    fn the_scripts_group_and_the_terrains_are_kept_apart() {
        let dir = project("script");
        fs::create_dir_all(dir.join("map/triggers")).unwrap();
        fs::write(dir.join("map/triggers/triggers.json"), "{}").unwrap();
        fs::write(dir.join("map/war3map.w3i.json"), "{}").unwrap();
        assert_eq!(check_script(&dir).unwrap(), Freshness::Unknown);
        record_script_now(&dir).unwrap();
        assert_eq!(check_script(&dir).unwrap(), Freshness::Fresh);
        assert_eq!(check(&dir).unwrap(), Freshness::Unknown, "the script's record says nothing of the terrain's files");
        record_now(&dir).unwrap();
        assert_eq!((check(&dir).unwrap(), check_script(&dir).unwrap()), (Freshness::Fresh, Freshness::Fresh));
        // A trigger file: only the script is stale; the terrain's doodads: both.
        fs::write(dir.join("map/triggers/triggers.json"), "{ }").unwrap();
        assert_eq!((check(&dir).unwrap(), check_script(&dir).unwrap()), (Freshness::Fresh, Freshness::Stale(vec!["triggers/triggers.json".into()])));
        record_script_now(&dir).unwrap();
        fs::write(dir.join("map/war3map.doo.json"), "{\"doodads\":[]}").unwrap();
        assert_eq!(check(&dir).unwrap(), Freshness::Stale(vec!["war3map.doo.json".into()]));
        assert_eq!(check_script(&dir).unwrap(), Freshness::Stale(vec!["war3map.doo.json".into()]));
        // Cleared: the terrain's group stays.
        clear_script_record(&dir).unwrap();
        assert_eq!(check_script(&dir).unwrap(), Freshness::Unknown);
        assert_eq!(check(&dir).unwrap(), Freshness::Stale(vec!["war3map.doo.json".into()]));
        // An unreadable record: an error for the script, never written over.
        fs::write(dir.join(STAMP_FILE), "{ not json").unwrap();
        assert!(record_script_now(&dir).is_err());
        assert_eq!(fs::read(dir.join(STAMP_FILE)).unwrap(), b"{ not json");
        assert!(matches!(check_script(&dir).unwrap(), Freshness::Unreadable(_)));
        let _ = fs::remove_dir_all(&dir);
    }

    /// The app's `record` (after making pathing, shadows and the minimap) and a sync's `record_script` running at once:
    /// each rewrites the whole record, so without the lock one could write back a record it read before the other's
    /// write and lose that group. Each writer is the only one writing its group (round numbers going up), so a record
    /// read after a writer's round finished must hold that round or a later one in its group.
    #[test]
    fn the_terrains_and_the_scripts_writers_at_once_lose_no_group() {
        use std::sync::atomic::{AtomicI64, Ordering};
        use std::sync::Arc;
        let dir = project("race");
        const ROUNDS: i64 = 200;
        // The last round each writer finished (files, script); -1: none yet.
        let done = Arc::new([AtomicI64::new(-1), AtomicI64::new(-1)]);
        let round_in = |doc: &serde_json::Value, g: usize| -> i64 {
            let group = if g == 0 { doc.get("files") } else { doc.get("script").and_then(|s| s.get("files")) };
            group.and_then(|f| f.get("war3map.w3e.txt")).and_then(serde_json::Value::as_str).map_or(-1, |s| s.parse().unwrap())
        };
        let writer = |g: usize| {
            let (dir, done) = (dir.clone(), done.clone());
            std::thread::spawn(move || {
                for i in 0..ROUNDS {
                    let sources = Sources::from([("war3map.w3e.txt".to_string(), i.to_string())]);
                    if g == 0 { record(&dir, &sources) } else { record_script(&dir, &sources) }.unwrap();
                    done[g].store(i, Ordering::SeqCst);
                    let expected = [done[0].load(Ordering::SeqCst), done[1].load(Ordering::SeqCst)];
                    let doc: serde_json::Value = serde_json::from_slice(&fs::read(dir.join(STAMP_FILE)).unwrap()).unwrap();
                    for (k, name) in ["files", "script"].iter().enumerate() {
                        let got = round_in(&doc, k);
                        assert!(got >= expected[k], "the {name} group says round {got} after round {} was recorded: lost or written back old", expected[k]);
                    }
                }
            })
        };
        let (a, b) = (writer(0), writer(1));
        let (a, b) = (a.join(), b.join());
        let _ = fs::remove_dir_all(&dir);
        a.unwrap();
        b.unwrap();
    }

    #[test]
    fn a_project_with_no_sources_gets_no_record() {
        let dir = std::env::temp_dir().join(format!("w3proj-derived-none-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        record_now(&dir).unwrap();
        assert!(!dir.join(STAMP_FILE).exists());
        assert_eq!(check(&dir).unwrap(), Freshness::Unknown);
        let _ = fs::remove_dir_all(&dir);
    }
}
