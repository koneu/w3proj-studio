//! The flat object files of a project whose object data is in `map/objects/` (`w3proj::object_layout`, one file per
//! object).
//!
//! The app's code reads and writes `map/war3map.w3u.json`, `war3mapSkin.w3u.json` and the other kinds' (a campaign's
//! `war3campaign*`) as before, format `w3proj.objects/1`. In the layout these files aren't on disk: the file commands
//! answer for them here (`crate::flatview::view_of`). A read assembles the file; a write cuts it into the object files
//! and writes only those whose bytes changed; the list of the project's files has them, with a size and time made from
//! the files they stand for (`objects.json` and the kind's folder), so a change to any of those shows as a change of
//! the flat file. A project still in the flat layout (its flat files on disk) doesn't come here.

use std::path::{Path, PathBuf};

use w3proj::object_layout as ol;

use crate::flatview::Also;
use crate::{err, modified_ms, CmdResult, FileInfo, Stamp};

/// One flat object file of a project in the layout: its `map/` folder, its kind and half.
pub struct ObjectFlat {
    map_dir: PathBuf,
    kind: ol::Kind,
    half: usize,
}

/// The flat object file `path` stands for in a project in the object layout, or None (any other file, a project of the
/// flat layout, a kind kept raw). A path that can't be checked or an `objects.json` that can't be read is an error,
/// never "a file of its own".
pub fn object_of(path: &Path) -> CmdResult<Option<ObjectFlat>> {
    let Some(file) = path.file_name().and_then(|n| n.to_str()) else { return Ok(None) };
    let Some(map_dir) = path.parent() else { return Ok(None) };
    Ok(ol::flat_view(map_dir, file).map_err(err)?.map(|(kind, half)| ObjectFlat { map_dir: map_dir.to_path_buf(), kind, half }))
}

/// `rel` (a `/`-separated path under `map/`) joined to `base` one component at a time.
fn join_rel(base: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(base.to_path_buf(), |p, c| p.join(c))
}

/// The error a read of a file that isn't there gives (the app tells "not found" by it).
fn not_found(path: &Path) -> String {
    format!("{}: {}", path.display(), std::io::Error::from_raw_os_error(2))
}

impl ObjectFlat {
    /// The path the app knows the file by.
    fn path(&self) -> CmdResult<PathBuf> {
        let prefix = ol::Prefix::of_map_dir(&self.map_dir).map_err(err)?;
        Ok(self.map_dir.join(prefix.flat(self.kind, self.half)))
    }

    /// Whether `objects.json` lists the file (the flat file is there).
    pub fn listed(&self) -> CmdResult<bool> {
        Ok(ol::listed(&self.map_dir).map_err(err)?.contains(&(self.kind, self.half)))
    }

    /// The size (the sum of the files it is made from) and last write (the latest of them) the list and a stat give it,
    /// so any write of one of them changes it; None when it isn't there.
    pub fn stamp(&self) -> CmdResult<Option<Stamp>> {
        if !self.listed()? {
            return Ok(None);
        }
        let (mut size, mut modified) = (0, 0);
        for s in ol::sources(&self.map_dir, self.kind).map_err(err)? {
            if let Ok(meta) = std::fs::metadata(join_rel(&self.map_dir, &s)) {
                size += meta.len();
                modified = modified.max(modified_ms(&meta));
            }
        }
        Ok(Some(Stamp::new(size, modified)))
    }

    /// The flat file, assembled; "not found" when it isn't there.
    pub fn read(&self) -> CmdResult<Vec<u8>> {
        match ol::read_flat(&self.map_dir, self.kind, self.half).map_err(err)? {
            Some(b) => Ok(b),
            None => Err(not_found(&self.path()?)),
        }
    }

    /// A hash of what it holds; None when it can't be read or isn't there.
    pub fn hash(&self) -> Option<String> {
        self.read().ok().map(|b| crate::content_hash(&b))
    }

    /// Writes it into the object files (`w3proj::object_layout::write_flat`): its stamp, with every file written or
    /// removed and every other flat file made from one of them in `also`. Refused, nothing written, when the content
    /// can't be packed or kept in the layout.
    pub fn write(&self, bytes: &[u8]) -> CmdResult<Stamp> {
        let name = self.path()?.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let done = ol::write_flat(&self.map_dir, self.kind, self.half, bytes).map_err(|e| format!("map/{name} wasn't saved into map/{}/: {e}", ol::DIR))?;
        self.after(done)
    }

    /// Takes the file's half out of the object files (`w3proj::object_layout::delete_flat`).
    pub fn delete(&self) -> CmdResult<()> {
        if !self.listed()? {
            return Err(not_found(&self.path()?));
        }
        ol::delete_flat(&self.map_dir, self.kind, self.half).map_err(err).map(|_| ())
    }

    /// The stamp after a write that wrote and removed `done`'s files.
    fn after(&self, done: ol::Written) -> CmdResult<Stamp> {
        let mut also = Vec::new();
        // Written, so a stamp that can't be read back is unknown, not an error (`stamp_or_unknown`).
        for rel in &done.written {
            let at = join_rel(&self.map_dir, rel);
            also.push(Also::of(&at, &crate::stamp_or_unknown(|| crate::stamp_of(&at))));
        }
        for rel in &done.removed {
            also.push(Also::removed(&join_rel(&self.map_dir, rel)));
        }
        // The other flat files made from what changed: the kind's other half, and every kind's when objects.json changed.
        // The write is done: a listing that can't be read back now leaves them out (they show as changed at the next check).
        let root = done.written.iter().any(|w| w == ol::ROOT_FILE);
        if root || !done.written.is_empty() || !done.removed.is_empty() {
            for (kind, half) in ol::listed(&self.map_dir).unwrap_or_default() {
                if (kind, half) == (self.kind, self.half) || (!root && kind != self.kind) {
                    continue;
                }
                let other = ObjectFlat { map_dir: self.map_dir.clone(), kind, half };
                if let (Ok(path), Ok(Some(s))) = (other.path(), other.stamp()) {
                    also.push(Also::of(&path, &s));
                }
            }
        }
        let mut stamp = crate::stamp_or_unknown(|| self.stamp().and_then(|s| s.ok_or_else(|| "gone".to_string())));
        stamp.also = also;
        Ok(stamp)
    }
}

/// Check Objects (`objects_check`, `w3proj::object_layout::check`): what the object files on disk get wrong, in the
/// project's `map/` and its campaign chapters', each file as a project path. A file that can't be read is a finding
/// too. Nothing for a project without the layout.
pub fn check(root: &str) -> CmdResult<Vec<ol::check::Issue>> {
    let root = Path::new(root);
    let mut dirs = vec![w3proj::project::MAP_DIR.to_string()];
    let maps = root.join(w3proj::project::MAPS_DIR);
    if maps.is_dir() {
        let mut chapters: Vec<String> = std::fs::read_dir(&maps)
            .map_err(|e| format!("{}: {e}", maps.display()))?
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| format!("{}/{}/{}", w3proj::project::MAPS_DIR, e.file_name().to_string_lossy(), w3proj::project::MAP_DIR))
            .filter(|m| join_rel(root, m).is_dir())
            .collect();
        chapters.sort();
        dirs.extend(chapters);
    }
    let mut out = Vec::new();
    for dir in dirs {
        let map_dir = join_rel(root, &dir);
        let mut files = std::collections::BTreeMap::new();
        let mut unread = Vec::new();
        for path in ol::FOLDER.paths(&map_dir).map_err(err)? {
            if ol::layout_path(&path).is_none() {
                continue;
            }
            match std::fs::read(join_rel(&map_dir, &path)) {
                Ok(b) => {
                    files.insert(path, b);
                }
                Err(e) => unread.push(ol::check::Issue {
                    severity: w3proj::trigger_check::Severity::Error,
                    message: format!("map/{path} can't be read: {e}"),
                    file: path,
                    line: None,
                }),
            }
        }
        let prefix = ol::Prefix::of_map_dir(&map_dir).map_err(err)?;
        // With a file unread, the rest would be judged without it (a missing objects.json, say): its error stands alone.
        let found = if unread.is_empty() { ol::check::check(&files, prefix) } else { unread };
        out.extend(found.into_iter().map(|i| ol::check::Issue { file: format!("{dir}/{}", i.file), ..i }));
    }
    Ok(out)
}

/// Adds the flat object files of every `map/` folder below `root` that keeps its objects in the layout to a project's
/// file list (`walk_project`), unless a file of that name is listed, with the size and time of the files they are made
/// from (taken from the list itself: no second look at the disk).
pub fn list(root: &Path, files: &mut Vec<FileInfo>) {
    let suffix = format!("/{}", ol::ROOT_FILE);
    let maps: Vec<String> = files
        .iter()
        .filter_map(|f| f.path.strip_suffix(&suffix).filter(|m| m.rsplit('/').next().is_some_and(|n| n.eq_ignore_ascii_case("map"))).map(str::to_string))
        .collect();
    let mut more = Vec::new();
    for map in maps {
        let map_dir = map.split('/').fold(root.to_path_buf(), |p, part| p.join(part));
        let Ok(prefix) = ol::Prefix::of_map_dir(&map_dir) else { continue };
        let Ok(listed) = ol::listed(&map_dir) else { continue };
        let root_file = format!("{map}/{}", ol::ROOT_FILE);
        let root_stamp = files.iter().find(|f| f.path == root_file).map(|f| (f.size, f.modified)).unwrap_or_default();
        for (kind, half) in listed {
            let path = format!("{map}/{}", prefix.flat(kind, half));
            if files.iter().any(|f| f.path.eq_ignore_ascii_case(&path)) || more.iter().any(|f: &FileInfo| f.path == path) {
                continue;
            }
            // A kind kept raw (or a flat file on disk) isn't answered from the folder.
            if !matches!(ol::flat_view(&map_dir, &prefix.flat(kind, half)), Ok(Some(_))) {
                continue;
            }
            let head = format!("{map}/{}/{}/", ol::DIR, kind.folder);
            let (mut size, mut modified) = root_stamp;
            for f in files.iter().filter(|f| f.path.starts_with(&head)) {
                size += f.size;
                modified = modified.max(f.modified);
            }
            more.push(FileInfo { path, size, modified, is_virtual: true });
        }
    }
    if !more.is_empty() {
        files.extend(more);
        files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A project whose units are in the layout (h000 with both halves, h001 with data only), and its flat files.
    fn project(name: &str) -> (PathBuf, Vec<u8>) {
        let dir = std::env::temp_dir().join(format!("w3proj-objectview-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("map")).unwrap();
        std::fs::write(dir.join(w3proj::project::MANIFEST), "format = 1\n").unwrap();
        let data = br#"{"format":"w3proj.objects/1","version":3,"original":[],"custom":[{"base":"hfoo","id":"h000","mods":[{"field":"umpm","type":"int","value":5}]},{"base":"hfoo","id":"h001","mods":[]}]}"#;
        let skin = br#"{"format":"w3proj.objects/1","version":3,"original":[],"custom":[{"base":"hfoo","id":"h000","mods":[{"field":"unam","type":"string","value":"A"}]}]}"#;
        // In the codec's own form, as the app saves (codec_canonicalize).
        let canonical = |j: &[u8]| w3proj::objdata::to_json(&w3proj::objdata::from_json(j, false).unwrap(), false).unwrap();
        crate::write_bytes(&dir.join("map/war3map.w3u.json"), &canonical(data)).unwrap();
        crate::write_bytes(&dir.join("map/war3mapSkin.w3u.json"), &canonical(skin)).unwrap();
        let flat = crate::read_bytes(&dir.join("map/war3map.w3u.json")).unwrap();
        assert_eq!(flat, canonical(data), "a read after the save gives back what was saved");
        (dir, flat)
    }

    #[test]
    fn the_flat_object_files_are_answered_from_the_folder() {
        let (dir, flat) = project("rw");
        let map = dir.join("map");
        assert!(!map.join("war3map.w3u.json").exists(), "nothing on disk under the flat name");
        assert!(map.join("objects/units/custom/h000.json").is_file());
        let text = String::from_utf8(flat.clone()).unwrap();
        assert!(text.starts_with("{\n  \"format\": \"w3proj.objects/1\",\n  \"version\": 3,"), "{text}");
        assert!(crate::exists(&map.join("war3map.w3u.json")).unwrap());
        assert!(!crate::exists(&map.join("war3map.w3t.json")).unwrap(), "a kind not listed isn't there");
        let missing = crate::read_bytes(&map.join("war3map.w3t.json")).unwrap_err();
        assert!(missing.contains("war3map.w3t.json") && missing.contains(&std::io::Error::from_raw_os_error(2).to_string()), "{missing}");
        assert!(crate::stat(&map.join("war3map.w3t.json")).is_none());
        // A change of one unit writes that unit's file only; the other half's flat file is in `also`.
        let changed = text.replace("\"value\": 5", "\"value\": 6");
        let s = crate::write_bytes(&map.join("war3map.w3u.json"), changed.as_bytes()).unwrap();
        let also: Vec<String> = s.also.iter().map(|a| a.path.replace('\\', "/")).collect();
        assert!(also[0].ends_with("map/objects/units/custom/h000.json"), "{also:?}");
        assert!(also.iter().any(|a| a.ends_with("map/war3mapSkin.w3u.json")), "{also:?}");
        assert_eq!(also.len(), 2, "{also:?}");
        assert_eq!(crate::read_bytes(&map.join("war3map.w3u.json")).unwrap(), changed.as_bytes());
        let stat = crate::stat(&map.join("war3map.w3u.json")).unwrap();
        assert_eq!((stat.size, stat.modified), (s.size, s.modified));
        assert_eq!(crate::stat_hashed(&map.join("war3map.w3u.json")).unwrap().hash, Some(crate::content_hash(changed.as_bytes())));
        // The list has the flat names, stamped as a stat gives them.
        let (list, _) = crate::walk_project(&dir, false).unwrap();
        let entry = list.iter().find(|f| f.path == "map/war3map.w3u.json").expect("listed");
        assert_eq!((entry.size, entry.modified), (stat.size, stat.modified));
        assert!(list.iter().any(|f| f.path == "map/war3mapSkin.w3u.json"));
        assert!(!list.iter().any(|f| f.path == "map/war3map.w3t.json"));
        // Moving is refused; deleting takes the half out.
        assert!(crate::flatview::refuse_moving(&map.join("war3map.w3u.json")).unwrap_err().contains("map/objects/"));
        assert!(crate::flatview::delete_view(&map.join("war3mapSkin.w3u.json")).unwrap());
        assert!(!crate::exists(&map.join("war3mapSkin.w3u.json")).unwrap());
        assert!(!std::fs::read_to_string(map.join("objects/units/custom/h000.json")).unwrap().contains("\"skin\""));
        // A refused write leaves everything as it was.
        let before = std::fs::read(map.join("objects/units/custom/h000.json")).unwrap();
        let e = crate::write_bytes(&map.join("war3map.w3u.json"), b"{\"format\":\"w3proj.objects/1\",\"version\":3,\"original\":[],\"custom\":[{\"base\":\"hfoo\",\"id\":\"h000\"},{\"base\":\"hfoo\",\"id\":\"h000\"}]}").unwrap_err();
        assert!(e.contains("map/war3map.w3u.json wasn't saved into map/objects/") && e.contains("twice"), "{e}");
        assert_eq!(std::fs::read(map.join("objects/units/custom/h000.json")).unwrap(), before);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_flat_project_keeps_its_files() {
        let dir = std::env::temp_dir().join(format!("w3proj-objectview-flat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("map")).unwrap();
        std::fs::write(dir.join(w3proj::project::MANIFEST), "format = 1\n").unwrap();
        std::fs::write(dir.join("map/war3map.w3u.json"), b"{}").unwrap();
        assert!(object_of(&dir.join("map/war3map.w3u.json")).unwrap().is_none());
        assert!(object_of(&dir.join("map/war3map.w3t.json")).unwrap().is_none(), "the flat layout: its next sync converts it");
        crate::write_bytes(&dir.join("map/war3map.w3t.json"), b"x").unwrap();
        assert_eq!(std::fs::read(dir.join("map/war3map.w3t.json")).unwrap(), b"x", "written as a file of its own");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
