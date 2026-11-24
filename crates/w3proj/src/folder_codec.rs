//! The file layer shared by the directory-valued codecs: one archive file (or two) stands for many project files in
//! one folder under `map/`. The split terrain (`crate::terrain_layout`, `map/terrain/`, war3map.w3e and the placed
//! objects) and the trigger folders (`crate::trigger_layout`, `map/triggers/`, war3map.wtg and war3map.wct) are the
//! two. Each keeps its own assembling (files to the archive's bytes) and slicing (bytes to files): their inputs and the
//! stage of a pack or sync they run in differ. What is the same for both is here: which project paths a folder holds,
//! reading it from disk, writing only the files whose bytes changed, and taking away the files a new slice no longer
//! has.
//!
//! Paths are relative to the project's `map/` folder, with `/`, as in `crate::project::read_project`.

use std::collections::BTreeMap;
use std::path::Path;

use crate::{Error, Result};

/// Project files, keyed by their path relative to `map/`.
pub type Files = BTreeMap<String, Vec<u8>>;

/// The folder under `map/` a directory-valued codec keeps its files in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Folder {
    /// The folder's name, relative to `map/` (`terrain`, `triggers`).
    pub dir: &'static str,
}

impl Folder {
    pub const fn new(dir: &'static str) -> Self {
        Folder { dir }
    }

    /// Whether a project path lies below the folder, its name in any case (a map's own file there, on a file system
    /// that doesn't tell cases apart, is in the way all the same).
    pub fn holds(&self, path: &str) -> bool {
        let d = self.dir.len();
        path.len() > d && path.as_bytes()[d] == b'/' && path[..d].eq_ignore_ascii_case(self.dir)
    }

    /// Whether a project path lies below the folder, spelt exactly as the folder.
    pub fn holds_exact(&self, path: &str) -> bool {
        path.len() > self.dir.len() && path.starts_with(self.dir) && path.as_bytes()[self.dir.len()] == b'/'
    }

    /// The first of `files` below the folder (`holds`): in a map's files, one of the map's own.
    pub fn first_in<'a>(&self, files: &'a Files) -> Option<&'a String> {
        files.keys().find(|k| self.holds(k))
    }

    /// The folder's files on disk (relative to `map/`, sorted), not read; none when the folder isn't there.
    pub fn paths(&self, map_dir: &Path) -> Result<Vec<String>> {
        Ok(crate::project::walk(&map_dir.join(self.dir))?.into_iter().map(|rel| format!("{}/{rel}", self.dir)).collect())
    }

    /// The folder's files on disk (keys relative to `map/`), read; none when the folder isn't there. One that can't be
    /// read is an error naming it.
    pub fn read_disk(&self, map_dir: &Path) -> Result<Files> {
        let mut out = Files::new();
        for path in self.paths(map_dir)? {
            let bytes = read(map_dir, &path)?;
            out.insert(path, bytes);
        }
        Ok(out)
    }

    /// Removes the files of `old` below the folder that `new` doesn't have (what a new slice no longer holds), in
    /// `old`'s order; the paths removed. A file that can't be removed is an error (the ones before it are gone).
    pub fn remove_stale<'a>(&self, map_dir: &Path, old: impl IntoIterator<Item = &'a String>, new: &Files) -> Result<Vec<&'a String>> {
        let stale: Vec<&String> = old.into_iter().filter(|p| self.holds(p) && !new.contains_key(*p)).collect();
        for p in &stale {
            std::fs::remove_file(crate::paths::join_rel(map_dir, p))?;
        }
        Ok(stale)
    }

    /// Removes the folder (`sub` None) or its sub-folder `sub` with the folders below it that are empty (one holding
    /// anything stays).
    pub fn remove_empty(&self, map_dir: &Path, sub: Option<&str>) {
        match sub {
            Some(sub) => remove_empty_dir(&crate::paths::join_rel(map_dir, &format!("{}/{sub}", self.dir))),
            None => remove_empty_dir(&map_dir.join(self.dir)),
        }
    }
}

/// The file `path` (relative to `map_dir`), read; one that can't be is an error naming it.
pub fn read(map_dir: &Path, path: &str) -> Result<Vec<u8>> {
    std::fs::read(crate::paths::join_rel(map_dir, path)).map_err(|e| Error::Project(format!("map/{path} can't be read: {e}")))
}

/// Reads `names` under `map_dir` into `files` where they are there; one that is there but can't be read is an error.
pub fn read_if_there(map_dir: &Path, names: &[&str], files: &mut Files) -> Result<()> {
    for name in names {
        match std::fs::read(crate::paths::join_rel(map_dir, name)) {
            Ok(b) => {
                files.insert(name.to_string(), b);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(Error::Project(format!("map/{name} can't be read: {e}"))),
        }
    }
    Ok(())
}

/// Writes `files` (relative to `map_dir`) whose bytes differ from those on disk, each in one step (`crate::atomic`);
/// returns the paths written.
pub fn write_changed(map_dir: &Path, files: &Files) -> Result<Vec<String>> {
    let mut written = Vec::new();
    for (rel, bytes) in files {
        if crate::project::write_if_changed(&crate::paths::join_rel(map_dir, rel), bytes)? {
            written.push(rel.clone());
        }
    }
    Ok(written)
}

/// Removes `dir` and the folders below it that are empty (a folder holding anything stays).
fn remove_empty_dir(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                remove_empty_dir(&e.path());
            }
        }
    }
    let _ = std::fs::remove_dir(dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    const F: Folder = Folder::new("terrain");

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("w3proj-folder-codec-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn paths_below_the_folder() {
        for (p, any, exact) in [
            ("terrain/a.txt", true, true),
            ("Terrain/a.txt", true, false),
            ("TERRAIN/x/y", true, false),
            ("terrain/", true, true),
            ("terrain", false, false),
            ("terrains/a", false, false),
            ("terrain.json", false, false),
            ("map/terrain/a", false, false),
            ("", false, false),
        ] {
            assert_eq!(F.holds(p), any, "{p}");
            assert_eq!(F.holds_exact(p), exact, "{p}");
        }
        let files: Files = [("a.txt".to_string(), vec![]), ("TERRAIN/b".to_string(), vec![]), ("terrain/c".to_string(), vec![])].into();
        assert_eq!(F.first_in(&files).map(String::as_str), Some("TERRAIN/b"));
    }

    #[test]
    fn reads_writes_changed_and_removes_stale() {
        let dir = scratch("rw");
        assert!(F.read_disk(&dir).unwrap().is_empty(), "no folder, no files");
        let mut files: Files = [("terrain/a/x.txt".to_string(), b"1".to_vec()), ("terrain/b/y.txt".to_string(), b"2".to_vec()), ("other.txt".to_string(), b"3".to_vec())].into();
        assert_eq!(write_changed(&dir, &files).unwrap().len(), 3);
        assert!(write_changed(&dir, &files).unwrap().is_empty(), "nothing changed, nothing written");
        files.insert("terrain/a/x.txt".into(), b"4".to_vec());
        assert_eq!(write_changed(&dir, &files).unwrap(), vec!["terrain/a/x.txt".to_string()]);
        let disk = F.read_disk(&dir).unwrap();
        assert_eq!(disk.keys().collect::<Vec<_>>(), ["terrain/a/x.txt", "terrain/b/y.txt"], "only the folder's files");
        assert_eq!(disk["terrain/a/x.txt"], b"4");
        let new: Files = [("terrain/a/x.txt".to_string(), b"4".to_vec())].into();
        let old: Vec<String> = files.keys().cloned().collect();
        assert_eq!(F.remove_stale(&dir, &old, &new).unwrap(), vec!["terrain/b/y.txt"], "a file outside the folder stays");
        assert!(dir.join("other.txt").is_file());
        assert!(dir.join("terrain/b").is_dir());
        F.remove_empty(&dir, Some("b"));
        assert!(!dir.join("terrain/b").exists());
        F.remove_empty(&dir, Some("a"));
        F.remove_empty(&dir, None);
        assert!(dir.join("terrain/a/x.txt").is_file(), "a folder holding a file stays");
        std::fs::remove_file(dir.join("terrain/a/x.txt")).unwrap();
        F.remove_empty(&dir, None);
        assert!(!dir.join("terrain").exists(), "the folder goes once empty");
        let mut got = Files::new();
        read_if_there(&dir, &["other.txt", "missing.txt"], &mut got).unwrap();
        assert_eq!(got.keys().collect::<Vec<_>>(), ["other.txt"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
