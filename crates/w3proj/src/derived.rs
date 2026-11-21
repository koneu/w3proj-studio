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
    // The split terrain layout: every file under map/terrain/ counts (`terrain/<path>`).
    if crate::terrain_layout::is_split_on_disk(&map)? {
        for rel in crate::project::walk(&map.join(crate::terrain_layout::DIR))? {
            let path = format!("{}/{rel}", crate::terrain_layout::DIR);
            let bytes = fs::read(map.join(&path)).map_err(|e| Error::Project(format!("{MAP_DIR}/{path} can't be read: {e}")))?;
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
/// meanwhile then shows as changed). A project with no source files gets no record.
pub fn record(project: &Path, sources: &Sources) -> Result<()> {
    if sources.is_empty() {
        return Ok(());
    }
    let doc = serde_json::json!({ "format": FORMAT, "files": sources });
    let mut text = serde_json::to_string_pretty(&doc).map_err(|e| Error::Format(e.to_string()))?;
    text.push('\n');
    let path = project.join(STAMP_FILE);
    if fs::read(&path).ok().as_deref() == Some(text.as_bytes()) {
        return Ok(());
    }
    write_atomic(&path, text.as_bytes())
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
}

pub fn check(project: &Path) -> Result<Freshness> {
    let path = project.join(STAMP_FILE);
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Freshness::Unknown),
        Err(e) => return Ok(Freshness::Unreadable(format!("{STAMP_FILE} is there but can't be read ({e})"))),
    };
    let recorded = match parse(&bytes) {
        Some(r) => r,
        None => return Ok(Freshness::Unreadable(format!("{STAMP_FILE} isn't a record of the derived files' sources"))),
    };
    let now = sources(project)?;
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

fn parse(bytes: &[u8]) -> Option<Sources> {
    let doc: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    if doc.get("format")?.as_str()? != FORMAT {
        return None;
    }
    doc.get("files")?
        .as_object()?
        .iter()
        .map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
        .collect()
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
