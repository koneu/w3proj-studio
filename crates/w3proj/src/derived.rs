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

/// The files under `map/` the derived files are made from, raw or as text (any case).
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
