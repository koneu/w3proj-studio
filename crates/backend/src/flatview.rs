//! The flat files of a project whose terrain is split into subterrains (`map/terrain/`, `w3proj::terrain_layout`).
//!
//! The app's code reads and writes `map/war3map.w3e.txt`, `war3map.doo.json`, `war3mapUnits.doo.json` and
//! `war3map.w3r.json` in either layout. In the split one these files aren't on disk: the file commands answer for them
//! here, from the layout's files. A read assembles the file (the bytes `w3proj terrain merge` would write); a write
//! slices the content back into the subterrains and writes only the files whose bytes changed; the list of the
//! project's files has them, with a size and time made from the files they stand for, so a change to any of those
//! shows as a change of the flat file. The flat layout doesn't come here: its files are what they are.

use std::path::{Path, PathBuf};

use serde::Serialize;
use w3proj::terrain_layout::{self as layout, FLAT_NAMES};

use crate::{err, exists_checked, modified_ms, CmdResult, FileInfo, Stamp};

/// One flat file of a split project: its `map/` folder, its name there, the layout's files it is made from.
pub struct Flat {
    map_dir: PathBuf,
    name: &'static str,
    sources: Vec<String>,
}

impl Flat {
    /// The size (the sum of the files it is made from) and last write (the latest of them) the list and a stat give
    /// it: any write of one of them changes it.
    pub fn stamp(&self) -> Stamp {
        let (mut size, mut modified) = (0, 0);
        for s in &self.sources {
            if let Ok(meta) = std::fs::metadata(self.map_dir.join(s)) {
                size += meta.len();
                modified = modified.max(modified_ms(&meta));
            }
        }
        Stamp { size, modified, also: Vec::new() }
    }

    /// A hash of the files it is made from, names and bytes: tells a change the size and time leave alike. An error
    /// when one of them is there but can't be read.
    pub fn hash(&self) -> CmdResult<String> {
        let mut all = Vec::new();
        for s in &self.sources {
            match std::fs::read(self.map_dir.join(s)) {
                Ok(b) => {
                    all.extend_from_slice(s.as_bytes());
                    all.push(0);
                    all.extend_from_slice(&(b.len() as u64).to_le_bytes());
                    all.extend_from_slice(&b);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("map/{s}: {e}")),
            }
        }
        Ok(crate::content_hash(&all))
    }
}

/// The flat file `path` stands for in a split project, or None (any other file, or a flat project). A layout that
/// can't be told (a `terrain.json` there but unreadable, both layouts at once) is an error, never "no such file".
pub fn flat_of(path: &Path) -> CmdResult<Option<Flat>> {
    let Some(file) = path.file_name().and_then(|n| n.to_str()) else { return Ok(None) };
    let Some(name) = FLAT_NAMES.iter().find(|n| n.eq_ignore_ascii_case(file)) else { return Ok(None) };
    let Some(map_dir) = path.parent() else { return Ok(None) };
    // One look at the disk for every other project: no layout file, no split layout.
    if !exists_checked(&map_dir.join(layout::LAYOUT_FILE))? {
        return Ok(None);
    }
    let views = layout::flat_views(map_dir).map_err(err)?;
    Ok(views.and_then(|v| v.into_iter().find(|v| v.name == *name)).map(|v| Flat { map_dir: map_dir.to_path_buf(), name: v.name, sources: v.sources }))
}

/// A file's bytes: a flat file of a split project assembled (`flat_of`), any other as it is on disk.
pub fn read_bytes(path: &Path) -> CmdResult<Vec<u8>> {
    match flat_of(path)? {
        Some(f) => layout::read_flat(&f.map_dir, f.name).map_err(err),
        None => std::fs::read(path).map_err(err),
    }
}

/// Another file a write changed, beside the one written: the files of the layout a flat file's write went into, and
/// the other flat files made from them. The workspace takes them for its own write, not another program's.
#[derive(Serialize, Debug)]
pub struct Also {
    pub path: String,
    pub size: u64,
    pub modified: u64,
}

/// `rel` (a `/`-separated path under `map/`, as the layout names its files) joined to `base` one component at a time, so
/// the result has the platform's separator throughout (a `/` left in after `terrain` would otherwise be mixed with `\` on Windows).
fn join_rel(base: &std::path::Path, rel: &str) -> std::path::PathBuf {
    rel.split('/').fold(base.to_path_buf(), |p, c| p.join(c))
}

/// Writes a flat file of a split project into its subterrains (`w3proj::terrain_layout::write_flat`): only the files
/// whose bytes change are written. The flat file's stamp, with every file written and every other flat file made
/// from one of them in `also`. Refused, nothing written, when the content can't be kept in the layout.
pub fn write_flat(f: &Flat, bytes: &[u8]) -> CmdResult<Stamp> {
    let written = layout::write_flat(&f.map_dir, f.name, bytes).map_err(|e| format!("map/{} wasn't saved into map/terrain/: {e}", f.name))?;
    let mut also = Vec::new();
    for rel in &written {
        let at = join_rel(&f.map_dir, rel);
        let s = crate::stamp_of(&at)?;
        also.push(Also { path: at.to_string_lossy().into_owned(), size: s.size, modified: s.modified });
    }
    for v in layout::flat_views(&f.map_dir).map_err(err)?.unwrap_or_default() {
        if v.name != f.name && v.sources.iter().any(|s| written.contains(s)) {
            let other = Flat { map_dir: f.map_dir.clone(), name: v.name, sources: v.sources };
            let s = other.stamp();
            also.push(Also { path: f.map_dir.join(v.name).to_string_lossy().into_owned(), size: s.size, modified: s.modified });
        }
    }
    let mut stamp = f.stamp();
    stamp.also = also;
    Ok(stamp)
}

/// Adds the flat files of every split `map/` folder below `root` to a project's file list (`walk_project`), unless a
/// file of that name is listed (both layouts: the flat file is the one there is, and packing says what is wrong).
pub fn list_flat(root: &Path, files: &mut Vec<FileInfo>) {
    let suffix = format!("/{}", layout::LAYOUT_FILE);
    let maps: Vec<String> = files
        .iter()
        .filter_map(|f| f.path.strip_suffix(&suffix).filter(|m| m.rsplit('/').next().is_some_and(|n| n.eq_ignore_ascii_case("map"))).map(str::to_string))
        .collect();
    for map in maps {
        let map_dir = map.split('/').fold(root.to_path_buf(), |p, part| p.join(part));
        let Ok(Some(views)) = layout::flat_views(&map_dir) else { continue };
        for v in views {
            let path = format!("{map}/{}", v.name);
            if files.iter().any(|f| f.path.eq_ignore_ascii_case(&path)) {
                continue;
            }
            let s = Flat { map_dir: map_dir.clone(), name: v.name, sources: v.sources }.stamp();
            files.push(FileInfo { path, size: s.size, modified: s.modified });
        }
    }
    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
}

/// "Split Terrain into Subterrains…" (`terrain_split`): the project's terrain and placed objects cut into `rects`
/// (`name:x,y,w,h` in corners, as `w3proj terrain split --rect`; the one word `2x2` for a 2×2 grid over the canvas,
/// `sw`, `se`, `nw`, `ne`), or one subterrain `main` over the canvas when there are none. The files written and
/// removed, relative to the project; the refusal's reason as the error, nothing written then.
pub fn split(root: &str, rects: &[String]) -> CmdResult<layout::Converted> {
    let map_dir = Path::new(root).join(w3proj::project::MAP_DIR);
    if layout::is_split_on_disk(&map_dir).map_err(err)? {
        return Err("the terrain is split already".into());
    }
    let rects = if rects.len() == 1 && rects[0] == "2x2" {
        let [w, h] = layout::flat_canvas(&map_dir).map_err(err)?;
        layout::grid_2x2(w, h)
    } else {
        rects.iter().map(|r| r.parse::<layout::Rect>()).collect::<Result<Vec<_>, _>>()?
    };
    layout::split_project(Path::new(root), &rects).map_err(err)
}

/// "Merge Subterrains" (`terrain_merge`): the split terrain back into `map/war3map.w3e.txt` and the flat object files.
pub fn merge(root: &str) -> CmdResult<layout::Converted> {
    layout::merge_project(Path::new(root)).map_err(err)
}

/// One subterrain as the app's creation-number allocator needs it (`terrain_id_layout`).
#[derive(Serialize, Debug, PartialEq)]
pub struct IdSubterrain {
    pub name: String,
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
    #[serde(rename = "idRanges")]
    pub id_ranges: Vec<[u32; 2]>,
}

/// What the app's allocator (app/src/lib/terrain/creationids.ts) goes by in a split project: the canvas's offset
/// (corner (0, 0) in world units; a coordinate that isn't a finite number is null) and the subterrains with their
/// rectangles and id ranges.
#[derive(Serialize, Debug, PartialEq)]
pub struct IdLayout {
    pub offset: [Option<f64>; 2],
    pub subterrains: Vec<IdSubterrain>,
}

/// "terrain_id_layout": the split project's `IdLayout`, None for a flat one. A `terrain.json` that can't be read is an
/// error, never a flat project (a new object would get the flat project's number).
pub fn id_layout(root: &str) -> CmdResult<Option<IdLayout>> {
    let map_dir = Path::new(root).join(w3proj::project::MAP_DIR);
    if !layout::is_split_on_disk(&map_dir).map_err(err)? {
        return Ok(None);
    }
    let bytes = std::fs::read(map_dir.join(layout::LAYOUT_FILE)).map_err(|e| format!("map/{} can't be read: {e}", layout::LAYOUT_FILE))?;
    let l = layout::Layout::parse(&bytes).map_err(err)?;
    let finite = |v: f32| v.is_finite().then_some(v as f64);
    let offset = l.offset();
    Ok(Some(IdLayout {
        offset: [finite(offset[0]), finite(offset[1])],
        subterrains: l.subterrains.into_iter().map(|s| IdSubterrain { name: s.name, x: s.x, y: s.y, w: s.w, h: s.h, id_ranges: s.id_ranges }).collect(),
    }))
}

/// "Check Terrain IDs" (`terrain_check`): numbers twice, overlapping ranges, numbers outside their ranges
/// (`w3proj::terrain_ids::check`, as `w3proj terrain check`), with the report's lines.
pub fn check(root: &str) -> CmdResult<serde_json::Value> {
    let report = w3proj::terrain_ids::check(Path::new(root)).map_err(err)?;
    let mut v = serde_json::to_value(&report).map_err(err)?;
    v["errors"] = report.has_errors().into();
    v["lines"] = report.lines().into();
    Ok(v)
}

/// Refuses to delete or move a flat file of a split project: it isn't a file, the subterrains are.
pub fn refuse_moving(path: &Path) -> CmdResult<()> {
    match flat_of(path)? {
        Some(f) => Err(format!(
            "map/{} isn't a file of its own: the project's terrain is split, and it is made from map/terrain/. Merge the subterrains first (Merge Subterrains)",
            f.name
        )),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn copy_dir(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for e in fs::read_dir(from).unwrap() {
            let e = e.unwrap();
            if e.file_type().unwrap().is_dir() {
                copy_dir(&e.path(), &to.join(e.file_name()));
            } else {
                fs::copy(e.path(), to.join(e.file_name())).unwrap();
            }
        }
    }

    /// A copy of the mini map, split into a 2×2 grid (`w3proj terrain split` with the grid's rectangles).
    fn split_mini(test: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("w3proj-backend-flat-{test}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (flat, split) = (dir.join("flat"), dir.join("split"));
        let mini = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mini-map");
        copy_dir(&mini, &flat);
        copy_dir(&mini, &split);
        // The mini map has 5×3 corners.
        assert!(fs::read_to_string(flat.join("map/war3map.w3e.txt")).unwrap().contains("\ncorners 5 3\n"));
        layout::split_project(&split, &layout::grid_2x2(5, 3)).unwrap();
        (flat, split)
    }

    /// The file commands on a split project: the flat names read as the flat project's files, are listed and stat
    /// with a stamp of their sources, write into the owning subterrain only (named in `also`), and can't be deleted.
    /// The flat project's files are untouched by any of it (control).
    #[test]
    fn the_flat_names_of_a_split_project() {
        let (flat, split) = split_mini("names");
        for name in FLAT_NAMES {
            let (a, b) = (flat.join("map").join(name), split.join("map").join(name));
            assert!(!b.exists(), "{name} isn't on disk");
            assert!(flat_of(&a).unwrap().is_none(), "control: a flat project's file is itself");
            assert!(crate::exists(&b).unwrap());
            let (want, got) = (fs::read(&a).unwrap(), read_bytes(&b).unwrap());
            if name.ends_with(".txt") {
                assert_eq!(got, want, "{name}");
            } else {
                let (x, y): (serde_json::Value, serde_json::Value) = (serde_json::from_slice(&want).unwrap(), serde_json::from_slice(&got).unwrap());
                assert_eq!(x, y, "{name}");
            }
            assert!(crate::stat(&b).is_some());
        }
        let (listed, _) = crate::walk_project(&split, false).unwrap();
        for name in FLAT_NAMES {
            let path = format!("map/{name}");
            let f = listed.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("{path} isn't listed"));
            let s = crate::stat(&split.join("map").join(name)).unwrap();
            assert_eq!((f.size, f.modified), (s.size, s.modified), "{path}: the list and a stat agree");
        }
        assert!(listed.iter().any(|f| f.path == "map/terrain/ne/terrain.txt"), "the layout's own files are listed too");

        // An edit of the north-east corner: only that subterrain's ground is written, and the stamp follows.
        let w3e = split.join("map/war3map.w3e.txt");
        let before = crate::stat_hashed(&w3e).unwrap();
        let text = String::from_utf8(read_bytes(&w3e).unwrap()).unwrap();
        // The text's first row is the north one: its last corner is the north-east one.
        let edited = text.replacen("[height]\n0*4 -12\n", "[height]\n0*4 4\n", 1).into_bytes();
        assert_ne!(edited, text.as_bytes());
        let stamp = crate::write_bytes(&w3e, &edited).unwrap();
        let written: Vec<&str> = stamp.also.iter().map(|a| a.path.as_str()).collect();
        assert_eq!(written, [join_rel(&split.join("map"), "terrain/ne/terrain.txt").to_string_lossy()], "only the owning subterrain");
        assert_eq!(read_bytes(&w3e).unwrap(), edited);
        let after = crate::stat_hashed(&w3e).unwrap();
        assert_ne!(after.hash, before.hash);
        assert_eq!((after.size, after.modified), (stamp.size, stamp.modified));
        assert!(!w3e.exists(), "nothing flat was written");
        // The same content again: nothing written.
        assert!(crate::write_bytes(&w3e, &edited).unwrap().also.is_empty());

        // Refused: deleting it, a terrain of another size, text that isn't a terrain (nothing written).
        assert!(refuse_moving(&w3e).unwrap_err().contains("Merge the subterrains"));
        assert!(refuse_moving(&flat.join("map/war3map.w3e.txt")).is_ok(), "control");
        let files_before = layout_files(&split);
        // 15×1 corners: each section's three rows of five as one row (the size check is w3proj's own test).
        let mut wider = String::new();
        let edited_text = String::from_utf8(edited.clone()).unwrap();
        let (mut row, mut in_grid, mut numbers): (Vec<&str>, bool, bool) = (Vec::new(), false, false);
        for line in edited_text.replace("corners 5 3", "corners 15 1").lines() {
            if line.starts_with('[') {
                // A grid follows a section line without "all"; height and water are rows of numbers.
                in_grid = !line.contains(" all ");
                numbers = line == "[height]" || line == "[water]";
            } else if in_grid && !line.is_empty() {
                row.push(line);
                if row.len() == 3 {
                    wider += &(row.join(if numbers { " " } else { "" }) + "\n");
                    row.clear();
                }
                continue;
            }
            wider += &(line.to_string() + "\n");
        }
        let e = crate::write_bytes(&w3e, wider.as_bytes()).unwrap_err();
        assert!(e.contains("can't change size"), "{e}\n{wider}");
        assert!(crate::write_bytes(&w3e, b"W3E version 11\n").is_err());
        assert_eq!(layout_files(&split), files_before);
        // A unit moved: only units files change, and the terrain's stamp stays (it isn't made from them).
        let units = split.join("map/war3mapUnits.doo.json");
        let w3e_stamp = crate::stat(&w3e).unwrap();
        let text = String::from_utf8(read_bytes(&units).unwrap()).unwrap();
        let moved = text.replacen("\"position\": [\n        0.0,", "\"position\": [\n        -100.0,", 1);
        assert_ne!(moved, text);
        let s = crate::write_bytes(&units, moved.as_bytes()).unwrap();
        assert!(!s.also.is_empty() && s.also.iter().all(|a| a.path.ends_with("units.json")), "{:?}", s.also);
        let again = crate::stat(&w3e).unwrap();
        assert_eq!((again.size, again.modified), (w3e_stamp.size, w3e_stamp.modified));
        let _ = fs::remove_dir_all(flat.parent().unwrap());
    }

    /// The commands behind "Split Terrain into Subterrains…" and "Merge Subterrains": a split the canvas can't keep
    /// is refused with the corner and writes nothing; `2x2` and one `main` split; a merge gives the flat files back
    /// byte for byte.
    #[test]
    fn split_and_merge_commands() {
        let (flat, split_dir) = split_mini("commands");
        let root = flat.to_string_lossy().into_owned();
        let snapshot = |p: &Path| crate::list_tree(&p.join("map")).unwrap().into_iter().map(|f| (f.clone(), fs::read(p.join("map").join(&f)).unwrap())).collect::<Vec<_>>();
        let before = snapshot(&flat);
        // The west half only: the south-east corner with water bits set lies outside and isn't the default corner.
        let e = split(&root, &["west:0,0,2,3".to_string()]).unwrap_err();
        assert!(e.contains("would be lost"), "{e}");
        assert_eq!(snapshot(&flat), before, "a refused split writes nothing");
        assert!(split(&root, &["bad rect".to_string()]).is_err());
        for rects in [vec!["2x2".to_string()], vec![]] {
            let r = split(&root, &rects).unwrap();
            assert!(r.removed.contains(&"map/war3map.w3e.txt".to_string()), "{:?}", r.removed);
            let names: Vec<&str> = if rects.is_empty() { vec!["main"] } else { vec!["sw", "se", "nw", "ne"] };
            for n in names {
                assert!(flat.join("map/terrain").join(n).join("terrain.txt").is_file(), "{n}");
            }
            assert!(split(&root, &rects).unwrap_err().contains("split already"));
            merge(&root).unwrap();
            assert_eq!(snapshot(&flat), before, "split and merged again: the same files");
        }
        assert!(merge(&root).unwrap_err().contains("isn't split"));
        let _ = fs::remove_dir_all(split_dir.parent().unwrap());
    }

    fn layout_files(project: &Path) -> Vec<(String, Vec<u8>)> {
        let dir = project.join("map/terrain");
        crate::list_tree(&dir).unwrap().into_iter().map(|p| (p.clone(), fs::read(dir.join(&p)).unwrap())).collect()
    }

    /// A `terrain.json` that can't be read: the terrain is listed and exists, and reading it is an error naming the
    /// file, never an empty terrain.
    #[test]
    fn an_unreadable_layout_is_an_error() {
        let (_flat, split) = split_mini("bad");
        fs::write(split.join("map/terrain/terrain.json"), b"{ not json").unwrap();
        let w3e = split.join("map/war3map.w3e.txt");
        assert!(crate::exists(&w3e).unwrap());
        let e = read_bytes(&w3e).unwrap_err();
        assert!(e.contains("terrain.json"), "{e}");
        assert!(crate::read_text(&w3e).is_err());
        let (listed, _) = crate::walk_project(&split, false).unwrap();
        assert!(listed.iter().any(|f| f.path == "map/war3map.w3e.txt"));
        assert!(!listed.iter().any(|f| f.path == "map/war3map.doo.json"), "which object kinds there are can't be told");
        let _ = fs::remove_dir_all(split.parent().unwrap());
    }
}
