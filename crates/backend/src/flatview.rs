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
            if let Ok(meta) = std::fs::metadata(join_rel(&self.map_dir, s)) {
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
            match std::fs::read(join_rel(&self.map_dir, s)) {
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

/// Whether `map_dir` (a folder named `map`, any case) is a split project's: its layout file is there (one look at the
/// disk for every other project) and decides so. A layout that can't be told is an error.
fn split_map_dir(map_dir: &Path) -> CmdResult<bool> {
    if !map_dir.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(w3proj::project::MAP_DIR)) {
        return Ok(false);
    }
    if !exists_checked(&join_rel(map_dir, layout::LAYOUT_FILE))? {
        return Ok(false);
    }
    layout::is_split_on_disk(map_dir).map_err(err)
}

/// A derived file of a split project (`map/war3map.wpm`, `.shd`, `war3mapMap.blp`, `war3map.mmp(.json)`,
/// `w3proj::derived::FILES`): the file in the project's store `.w3proj/derived/` it is kept as (the name there in any
/// case, else the one asked for). None for any other file and in a flat project.
pub fn derived_of(path: &Path) -> CmdResult<Option<PathBuf>> {
    let Some(file) = path.file_name().and_then(|n| n.to_str()) else { return Ok(None) };
    if w3proj::derived::derived_name(file).is_none() {
        return Ok(None);
    }
    let Some(map_dir) = path.parent() else { return Ok(None) };
    let Some(project) = map_dir.parent() else { return Ok(None) };
    if !split_map_dir(map_dir)? {
        return Ok(None);
    }
    let store = w3proj::derived::store_dir(project);
    let stored = match std::fs::read_dir(&store) {
        Ok(entries) => entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).find(|n| n.eq_ignore_ascii_case(file)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("{}: {e}", store.display())),
    };
    Ok(Some(store.join(stored.as_deref().unwrap_or(file))))
}

/// The map script of a project whose script is generated (`map/war3map.j` or `map/war3map.lua` while
/// `map/triggers/triggers.json` says `"script": "generated"`, `w3proj::trigger_layout::ScriptMode`): the file in the
/// project's store `.w3proj/derived/` it is kept as (the name there in any case, else the one asked for), so the app's
/// generator writes it there and git never sees it. None for any other file and for a kept script (a tracked file). A
/// `triggers.json` that is there but can't be read is an error, never "a file of its own".
pub fn script_of(path: &Path) -> CmdResult<Option<PathBuf>> {
    let Some(file) = path.file_name().and_then(|n| n.to_str()) else { return Ok(None) };
    if !w3proj::derived::SCRIPT_FILES.iter().any(|s| s.eq_ignore_ascii_case(file)) {
        return Ok(None);
    }
    let Some(map_dir) = path.parent() else { return Ok(None) };
    if !map_dir.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(w3proj::project::MAP_DIR)) {
        return Ok(None);
    }
    let Some(project) = map_dir.parent() else { return Ok(None) };
    if w3proj::trigger_layout::script_mode_on_disk(map_dir).map_err(err)? != Some(w3proj::trigger_layout::ScriptMode::Generated) {
        return Ok(None);
    }
    let store = w3proj::derived::store_dir(project);
    let stored = match std::fs::read_dir(&store) {
        Ok(entries) => entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).find(|n| n.eq_ignore_ascii_case(file)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("{}: {e}", store.display())),
    };
    Ok(Some(store.join(stored.as_deref().unwrap_or(file))))
}

/// The Pathing tool's `.w3proj/pathing.json` of a split project (`w3proj::terrain_pathing`): its project folder. None for
/// any other file and in a flat project.
pub fn pathing_of(path: &Path) -> CmdResult<Option<PathBuf>> {
    let named = |p: &Path, name: &str| p.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(name));
    let [dir, file] = w3proj::terrain_pathing::JSON_FILE;
    let Some(parent) = path.parent() else { return Ok(None) };
    if !named(path, file) || !named(parent, dir) {
        return Ok(None);
    }
    let Some(project) = parent.parent() else { return Ok(None) };
    Ok(split_map_dir(&project.join(w3proj::project::MAP_DIR))?.then(|| project.to_path_buf()))
}

/// The error a read of a file that isn't there gives (the app tells "not found" by it).
fn not_found(path: &Path) -> String {
    format!("{}: {}", path.display(), std::io::Error::from_raw_os_error(2))
}

/// The subterrains' `pathing.txt` of a split project that are there, as paths.
fn pathing_paths(project: &Path) -> CmdResult<Vec<PathBuf>> {
    let map_dir = project.join(w3proj::project::MAP_DIR);
    Ok(layout::pathing_files(project).map_err(err)?.iter().map(|p| join_rel(&map_dir, p)).collect())
}

/// The stamp of a split project's `.w3proj/pathing.json`: the size and last write of its subterrains' `pathing.txt`
/// (`Flat::stamp`); None when there is none.
pub fn pathing_stamp(project: &Path) -> Option<Stamp> {
    let paths = pathing_paths(project).ok()?;
    if paths.is_empty() {
        return crate::stamp_of(&w3proj::terrain_pathing::json_path(project)).ok();
    }
    let (mut size, mut modified) = (0, 0);
    for p in &paths {
        if let Ok(meta) = std::fs::metadata(p) {
            size += meta.len();
            modified = modified.max(modified_ms(&meta));
        }
    }
    Some(Stamp { size, modified, also: Vec::new() })
}

/// Whether a split project's `.w3proj/pathing.json` is there: a subterrain has a `pathing.txt` (or the file itself is
/// there, which reading then says is in the way).
pub fn pathing_exists(project: &Path) -> CmdResult<bool> {
    Ok(!pathing_paths(project)?.is_empty() || exists_checked(&w3proj::terrain_pathing::json_path(project))?)
}

/// A split project's `.w3proj/pathing.json`, assembled (`w3proj::terrain_layout::read_pathing`); "not found" when no
/// subterrain has overrides.
fn read_pathing(project: &Path) -> CmdResult<Vec<u8>> {
    layout::read_pathing(project).map_err(err)?.ok_or_else(|| not_found(&w3proj::terrain_pathing::json_path(project)))
}

/// Writes a split project's `.w3proj/pathing.json` into its subterrains' `pathing.txt`
/// (`w3proj::terrain_layout::write_pathing`): the stamp, with every file written or removed in `also`.
fn write_pathing(project: &Path, bytes: &[u8]) -> CmdResult<Stamp> {
    let (written, removed) = layout::write_pathing(project, bytes).map_err(|e| format!("{} wasn't saved into map/terrain/: {e}", w3proj::terrain_pathing::JSON_NAME))?;
    let map_dir = project.join(w3proj::project::MAP_DIR);
    let mut also = Vec::new();
    for rel in &written {
        let at = join_rel(&map_dir, rel);
        let s = crate::stamp_of(&at)?;
        also.push(Also { path: at.to_string_lossy().into_owned(), size: s.size, modified: s.modified });
    }
    // A file removed: listed with size and time 0, as gone.
    for rel in &removed {
        also.push(Also { path: join_rel(&map_dir, rel).to_string_lossy().into_owned(), size: 0, modified: 0 });
    }
    let mut stamp = pathing_stamp(project).unwrap_or(Stamp { size: 0, modified: 0, also: Vec::new() });
    stamp.also = also;
    Ok(stamp)
}

/// Writes a derived file of a split project into the store (`derived_of`): the stamp, the stored file in `also`. The
/// project's `.gitignore` gets the store when it is made.
fn write_derived(project_file: &Path, real: &Path, bytes: &[u8]) -> CmdResult<Stamp> {
    let project = project_file.parent().and_then(Path::parent).ok_or("no project folder")?;
    let new_store = !exists_checked(&w3proj::derived::store_dir(project))?;
    let s = crate::write_file(real, |f| std::io::Write::write_all(f, bytes))?;
    // The file is written either way; a .gitignore that can't be read is left alone (split, merge and pack say so).
    if new_store {
        let _ = w3proj::derived::ensure_ignored(project);
    }
    Ok(Stamp { size: s.size, modified: s.modified, also: vec![Also { path: real.to_string_lossy().into_owned(), size: s.size, modified: s.modified }] })
}

/// What a project path stands for in a split project: one of its flat files, a derived file in the store, the Pathing
/// tool's file; None for every other path (it is what it is).
pub enum View {
    Flat(Flat),
    Derived(PathBuf),
    Pathing(PathBuf),
    /// A generated map script, kept in the store (`script_of`).
    Script(PathBuf),
}

/// `View` of a path. A layout that can't be told is an error, never "a file of its own".
pub fn view_of(path: &Path) -> CmdResult<Option<View>> {
    if let Some(f) = flat_of(path)? {
        return Ok(Some(View::Flat(f)));
    }
    if let Some(real) = derived_of(path)? {
        return Ok(Some(View::Derived(real)));
    }
    if let Some(real) = script_of(path)? {
        return Ok(Some(View::Script(real)));
    }
    Ok(pathing_of(path)?.map(View::Pathing))
}

/// A file's bytes: a flat file of a split project assembled (`flat_of`), a derived one from the store, the Pathing tool's
/// file from the subterrains, any other as it is on disk.
pub fn read_bytes(path: &Path) -> CmdResult<Vec<u8>> {
    match view_of(path)? {
        Some(View::Flat(f)) => layout::read_flat(&f.map_dir, f.name).map_err(err),
        Some(View::Derived(real) | View::Script(real)) => std::fs::read(&real).map_err(|e| stored_err(path, &real, &e)),
        Some(View::Pathing(project)) => read_pathing(&project),
        None => std::fs::read(path).map_err(err),
    }
}

/// Writes a file of a split project that stands for others (`view_of`); None for any other file (the caller writes it).
pub fn write_view(path: &Path, bytes: &[u8]) -> CmdResult<Option<Stamp>> {
    Ok(match view_of(path)? {
        Some(View::Flat(f)) => Some(write_flat(&f, bytes)?),
        Some(View::Derived(real) | View::Script(real)) => Some(write_derived(path, &real, bytes)?),
        Some(View::Pathing(project)) => Some(write_pathing(&project, bytes)?),
        None => None,
    })
}

/// A file's size and time when it stands for others in a split project (`view_of`): Some(None) when it isn't there,
/// None for any other file.
pub fn stat_view(path: &Path) -> CmdResult<Option<Option<Stamp>>> {
    Ok(match view_of(path)? {
        Some(View::Flat(f)) => Some(Some(f.stamp())),
        Some(View::Derived(real) | View::Script(real)) => Some(crate::stamp_of(&real).ok()),
        Some(View::Pathing(project)) => Some(pathing_stamp(&project)),
        None => None,
    })
}

/// A hash of what a file of a split project that stands for others holds; None for any other file, Some(None) when it
/// can't be read.
pub fn hash_view(path: &Path) -> CmdResult<Option<Option<String>>> {
    Ok(match view_of(path)? {
        Some(View::Flat(f)) => Some(f.hash().ok()),
        Some(View::Derived(real) | View::Script(real)) => Some(std::fs::read(real).ok().map(|b| crate::content_hash(&b))),
        Some(View::Pathing(project)) => Some(read_pathing(&project).ok().map(|b| crate::content_hash(&b))),
        None => None,
    })
}

/// Whether a file that stands for others in a split project is there; None for any other file.
pub fn exists_view(path: &Path) -> CmdResult<Option<bool>> {
    Ok(match view_of(path)? {
        Some(View::Flat(_)) => Some(true),
        Some(View::Derived(real) | View::Script(real)) => Some(exists_checked(&real)?),
        Some(View::Pathing(project)) => Some(pathing_exists(&project)?),
        None => None,
    })
}

/// Deletes a file of a split project that stands for others: a derived file in the store, the Pathing tool's file (every
/// subterrain's `pathing.txt`). A flat file can't be deleted (`refuse_moving`). False for any other file (the caller
/// deletes it).
pub fn delete_view(path: &Path) -> CmdResult<bool> {
    match view_of(path)? {
        Some(View::Flat(_)) => refuse_moving(path).map(|_| true),
        Some(View::Derived(real) | View::Script(real)) => std::fs::remove_file(&real).map(|_| true).map_err(|e| stored_err(path, &real, &e)),
        Some(View::Pathing(project)) => {
            if layout::delete_pathing(&project).map_err(err)?.is_empty() {
                // Only the file itself (in the way): it goes as any file.
                return Ok(false);
            }
            Ok(true)
        }
        None => Ok(false),
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
        // The derived files in the store under their map/ names, and the Pathing tool's file when a subterrain has
        // overrides (one of these names on disk is listed as itself already).
        let Some(project) = map_dir.parent() else { continue };
        let at = if map.contains('/') { map.rsplit_once('/').map(|(p, _)| format!("{p}/")).unwrap_or_default() } else { String::new() };
        let mut more = Vec::new();
        if let Ok(store) = w3proj::derived::read_store(project) {
            for name in store.keys() {
                if let Ok(s) = crate::stamp_of(&w3proj::derived::store_dir(project).join(name)) {
                    more.push(FileInfo { path: format!("{map}/{name}"), size: s.size, modified: s.modified });
                }
            }
        }
        if pathing_paths(project).is_ok_and(|p| !p.is_empty()) {
            if let Some(s) = pathing_stamp(project) {
                more.push(FileInfo { path: format!("{at}{}", w3proj::terrain_pathing::JSON_NAME), size: s.size, modified: s.modified });
            }
        }
        for f in more {
            if !files.iter().any(|g| g.path.eq_ignore_ascii_case(&f.path)) {
                files.push(f);
            }
        }
    }
    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
}

/// The error of a file kept elsewhere (a derived file or generated script in the store): names the file looked at, not
/// only the `map/` name the caller asked for (which may well be on disk, where this isn't looked for).
fn stored_err(path: &Path, real: &Path, e: &std::io::Error) -> String {
    let name = path.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    format!("{}: {e} ({name} is read from the project's store .w3proj/derived/, not from map/)", real.display())
}

/// Adds the generated map script of every `map/` folder below `root` whose script is generated (`script_of`) to a
/// project's file list under its `map/` name, from the store, unless a file of that name is listed already.
pub fn list_scripts(root: &Path, files: &mut Vec<FileInfo>) {
    let suffix = format!("/{}", w3proj::trigger_layout::ROOT_FILE);
    let maps: Vec<String> = files
        .iter()
        .filter_map(|f| f.path.strip_suffix(&suffix).filter(|m| m.rsplit('/').next().is_some_and(|n| n.eq_ignore_ascii_case("map"))).map(str::to_string))
        .collect();
    let mut more = Vec::new();
    for map in maps {
        let map_dir = map.split('/').fold(root.to_path_buf(), |p, part| p.join(part));
        if w3proj::trigger_layout::script_mode_on_disk(&map_dir).ok().flatten() != Some(w3proj::trigger_layout::ScriptMode::Generated) {
            continue;
        }
        let Some(project) = map_dir.parent() else { continue };
        let Ok(store) = w3proj::derived::read_script_store(project) else { continue };
        for name in store.keys() {
            let path = format!("{map}/{name}");
            if files.iter().any(|f| f.path.eq_ignore_ascii_case(&path)) {
                continue;
            }
            if let Ok(s) = crate::stamp_of(&w3proj::derived::store_dir(project).join(name)) {
                more.push(FileInfo { path, size: s.size, modified: s.modified });
            }
        }
    }
    if !more.is_empty() {
        files.extend(more);
        files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    }
}

/// "Split Terrain into Subterrains…" (`terrain_split`): the project's terrain and placed objects cut into `rects`
/// (`name:x,y,w,h` in corners, as `w3proj terrain split --rect`; the one word `2x2` for a 2×2 grid over the canvas,
/// `sw`, `se`, `nw`, `ne`), or one subterrain `main` over the canvas when there are none. The files written and
/// removed, relative to the project; the refusal's reason as the error, nothing written then.
pub fn split(root: &str, rects: &[String]) -> CmdResult<layout::Converted> {
    let rects = split_rects(root, rects)?;
    layout::split_project(Path::new(root), &rects).map_err(err)
}

/// A split's rectangles as given (`split`): `2x2` the grid over the flat canvas.
fn split_rects(root: &str, rects: &[String]) -> CmdResult<Vec<layout::Rect>> {
    let map_dir = Path::new(root).join(w3proj::project::MAP_DIR);
    if layout::is_split_on_disk(&map_dir).map_err(err)? {
        return Err("the terrain is split already".into());
    }
    if rects.len() == 1 && rects[0] == "2x2" {
        let [w, h] = layout::flat_canvas(&map_dir).map_err(err)?;
        return Ok(layout::grid_2x2(w, h));
    }
    rects.iter().map(|r| r.parse::<layout::Rect>()).collect()
}

/// "terrain_split_preview" (the layout editor's Split Terrain): what `split` would write, every subterrain with its
/// objects; nothing written. The refusal's reason as the error.
pub fn split_preview(root: &str, rects: &[String]) -> CmdResult<layout::Preview> {
    let rects = split_rects(root, rects)?;
    layout::split_preview(Path::new(root), &rects).map_err(err)
}

/// New, resized, renamed and joined subterrains (`terrain_relayout`, as `w3proj terrain relayout`): `plan` is the new
/// set, each `NAME[=OLD+OLD]:x,y,w,h` (`w3proj::terrain_layout::Planned`). The files written and removed; the refusal's
/// reason as the error, nothing written then.
pub fn relayout(root: &str, plan: &[String]) -> CmdResult<layout::Converted> {
    layout::relayout_project(Path::new(root), &parse_plan(plan)?).map_err(err)
}

fn parse_plan(plan: &[String]) -> CmdResult<Vec<layout::Planned>> {
    plan.iter().map(|p| p.parse::<layout::Planned>()).collect()
}

/// "terrain_relayout_preview" (the layout editor's live preview): what `relayout` would do with `plan`, nothing
/// written; the refusal's reason as the error.
pub fn relayout_preview(root: &str, plan: &[String]) -> CmdResult<layout::Preview> {
    layout::relayout_preview(Path::new(root), &parse_plan(plan)?).map_err(err)
}

/// A change of the subterrains that can be taken back (`relayout_undoable`): the project, its layout before and after.
struct UndoEntry {
    id: u64,
    root: String,
    before: layout::LayoutState,
    after: layout::LayoutState,
}

/// The changes `relayout_undo` can take back, the newest last: at most `UNDO_KEEP`, fewer while they hold more than
/// `UNDO_BYTES` (the newest always stays).
static UNDO: std::sync::Mutex<Vec<UndoEntry>> = std::sync::Mutex::new(Vec::new());
static NEXT_UNDO: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
const UNDO_KEEP: usize = 16;
const UNDO_BYTES: usize = 512 << 20;

/// What `relayout_undoable` did: the files written and removed, and the change's number for `relayout_undo`.
#[derive(Serialize, Debug)]
pub struct Applied {
    pub written: Vec<String>,
    pub removed: Vec<String>,
    pub undo: u64,
}

/// "terrain_relayout" with `undoable`: `relayout`, the layout before and after kept so `relayout_undo` can take it back
/// (the layout editor's Apply).
pub fn relayout_undoable(root: &str, plan: &[String]) -> CmdResult<Applied> {
    let (done, before, after) = layout::relayout_project_undoable(Path::new(root), &parse_plan(plan)?).map_err(err)?;
    let id = NEXT_UNDO.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut list = UNDO.lock().unwrap_or_else(|e| e.into_inner());
    list.push(UndoEntry { id, root: root.to_string(), before, after });
    while list.len() > UNDO_KEEP || (list.len() > 1 && list.iter().map(|e| e.before.size() + e.after.size()).sum::<usize>() > UNDO_BYTES) {
        list.remove(0);
    }
    Ok(Applied { written: done.written, removed: done.removed, undo: id })
}

/// "terrain_relayout_undo": takes the change `id` of `relayout_undoable` back (`redo`: makes it again), only while the
/// layout's files are as that change left them (as they were before it, for `redo`): anything saved since refuses it.
pub fn relayout_undo(root: &str, id: u64, redo: bool) -> CmdResult<layout::Converted> {
    let list = UNDO.lock().unwrap_or_else(|e| e.into_inner());
    let e = list
        .iter()
        .find(|e| e.id == id && e.root == root)
        .ok_or_else(|| format!("that change of the subterrains can't be {} any more (only the last {UNDO_KEEP} are kept, while the app runs)", if redo { "made again" } else { "taken back" }))?;
    // Undo: on disk as after the change, back to before it; redo the other way.
    let (now, to) = if redo { (&e.before, &e.after) } else { (&e.after, &e.before) };
    layout::restore_layout(Path::new(root), now, to).map_err(err)
}

/// "Merge Subterrains" (`terrain_merge`): the split terrain back into `map/war3map.w3e.txt` and the flat object files.
pub fn merge(root: &str) -> CmdResult<layout::Converted> {
    layout::merge_project(Path::new(root)).map_err(err)
}

/// "terrain_open_state": which subterrains of a split project are open (`w3proj::terrain_open::state`: names, rectangles,
/// open or read for the halo, sizes on disk, the corner mask the terrain editor draws by); None for a flat project. A
/// choice that can't be used (a damaged `.w3proj/open-subterrains.json`) is in its `error`, not an error of the call: the
/// Subterrains view still lists the subterrains so they can be picked again.
pub fn open_state(root: &str) -> CmdResult<Option<w3proj::terrain_open::State>> {
    w3proj::terrain_open::state(Path::new(root)).map_err(err)
}

/// "terrain_set_open" (Open Subterrains…): opens `names` (every subterrain removes `.w3proj/open-subterrains.json`, the
/// default); the new state. Refused for a flat project, no names, or a name the layout doesn't have.
pub fn set_open(root: &str, names: &[String]) -> CmdResult<Option<w3proj::terrain_open::State>> {
    let project = Path::new(root);
    let map_dir = project.join(w3proj::project::MAP_DIR);
    if !layout::is_split_on_disk(&map_dir).map_err(err)? {
        return Err("the terrain isn't split into subterrains (there is no map/terrain/terrain.json)".into());
    }
    let bytes = std::fs::read(join_rel(&map_dir, layout::LAYOUT_FILE)).map_err(|e| format!("map/{} can't be read: {e}", layout::LAYOUT_FILE))?;
    let l = layout::Layout::parse(&bytes).map_err(err)?;
    w3proj::terrain_open::store(project, &l, names).map_err(err)?;
    open_state(root)
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

/// "Fix Duplicate Creation Numbers…" (`terrain_fix_ids`, as `w3proj terrain fix-ids`): every creation number found
/// twice with all its members, and what `mode` ("renumber", "deleteCopies", or none: only list them) does. `files`: the
/// new files (relative to the project) and their text; a flat project's object files in their codec's form (what a save
/// writes), so a renumber changes nothing else of them. Nothing is written here: `write` writes them (the CLI), the app
/// writes them as one undoable edit.
pub fn fix_ids(root: &str, mode: Option<&str>, write: bool, formats: &[std::path::PathBuf]) -> CmdResult<serde_json::Value> {
    use w3proj::terrain_ids::FixMode;
    let mode = match mode {
        None => None,
        Some("renumber") => Some(FixMode::Renumber),
        Some("deleteCopies") => Some(FixMode::DeleteCopies),
        Some(m) => return Err(format!("mode must be \"renumber\" or \"deleteCopies\", not \"{m}\"")),
    };
    let mut plan = w3proj::terrain_ids::fix_plan(Path::new(root), mode).map_err(err)?;
    let split = plan.files.keys().any(|p| p.starts_with("map/terrain/"));
    let mut files = Vec::new();
    for (path, bytes) in plan.files.iter_mut() {
        let text = String::from_utf8(bytes.clone()).map_err(err)?;
        // A flat object file as its codec writes it (what unpack and a save write).
        let text = if split { text } else { crate::codec_canonicalize(root, path, &text, formats)? };
        *bytes = text.clone().into_bytes();
        files.push(serde_json::json!({ "path": path, "text": text }));
    }
    let written = if write { w3proj::terrain_ids::fix_write(Path::new(root), &plan).map_err(err)? } else { Vec::new() };
    let mut v = serde_json::to_value(&plan).map_err(err)?;
    v["files"] = files.into();
    v["lines"] = plan.lines().into();
    v["written"] = written.into();
    Ok(v)
}

/// One subterrain's rectangle (`terrain_whole`).
#[derive(Serialize, Debug, PartialEq)]
pub struct SubterrainRect {
    pub name: String,
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
}

/// The whole terrain of a split project (`terrain_whole`): `war3map.w3e.txt` text assembled from every subterrain, closed
/// ones too, and the rectangles.
#[derive(Serialize, Debug, PartialEq)]
pub struct WholeTerrain {
    pub text: String,
    pub subterrains: Vec<SubterrainRect>,
}

/// "terrain_whole" (Check Terrain Seams): the split project's whole terrain from disk, whatever subterrains are open, None
/// for a flat one. A layout or ground file that is there but can't be read is an error.
pub fn whole(root: &str) -> CmdResult<Option<WholeTerrain>> {
    let map_dir = Path::new(root).join(w3proj::project::MAP_DIR);
    let Some((text, subs)) = layout::whole_ground(&map_dir).map_err(err)? else { return Ok(None) };
    Ok(Some(WholeTerrain {
        text: String::from_utf8(text).map_err(err)?,
        subterrains: subs.into_iter().map(|s| SubterrainRect { name: s.name, x: s.x, y: s.y, w: s.w, h: s.h }).collect(),
    }))
}

/// Refuses to delete or move a flat file of a split project: it isn't a file, the subterrains are. Moving a derived file
/// or the Pathing tool's file of a split project is refused too (they stand for files elsewhere; deleting them is
/// `delete_view`).
pub fn refuse_moving(path: &Path) -> CmdResult<()> {
    match view_of(path)? {
        Some(View::Flat(f)) => Err(format!(
            "map/{} isn't a file of its own: the project's terrain is split, and it is made from map/terrain/. Merge the subterrains first (Merge Subterrains)",
            f.name
        )),
        Some(View::Derived(real)) => Err(format!("{} can't be moved: the project's terrain is split, and it is kept as {}", path.display(), real.display())),
        Some(View::Script(real)) => Err(format!(
            "{} can't be moved: the project's map script is generated (map/{} \"script\": \"generated\"), and it is kept as {}",
            path.display(),
            w3proj::trigger_layout::ROOT_FILE,
            real.display()
        )),
        Some(View::Pathing(_)) => Err(format!(
            "{} can't be moved: the project's terrain is split, and its pathing overrides are kept in map/terrain/<subterrain>/{}",
            w3proj::terrain_pathing::JSON_NAME,
            w3proj::terrain_pathing::FILE
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

    /// A generated script's file that isn't in the store (map/triggers/triggers.json says generated, the script is still
    /// in map/): the read's error names the store file looked at, and the file isn't taken from map/.
    #[test]
    fn a_generated_script_missing_from_the_store_names_the_store_file() {
        let dir = std::env::temp_dir().join(format!("w3proj-backend-flat-genscript-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        copy_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mini-map"), &dir);
        let triggers = dir.join("map/triggers/triggers.json");
        let text = fs::read_to_string(&triggers).unwrap();
        assert!(text.contains("\"script\": \"kept\""));
        fs::write(&triggers, text.replace("\"script\": \"kept\"", "\"script\": \"generated\"")).unwrap();
        fs::write(dir.join("map/war3map.lua"), "-- by hand").unwrap();
        let e = read_bytes(&dir.join("map/war3map.lua")).unwrap_err();
        let store = dir.join(".w3proj/derived/war3map.lua");
        // Windows prints the joined path with backslashes: compare with one separator.
        let slashed = e.replace('\\', "/");
        assert!(slashed.starts_with(&format!("{}:", store.display().to_string().replace('\\', "/"))), "{e}");
        assert!(slashed.contains(".w3proj/derived/"), "{e}");
        // Control: with the file in the store it reads that one.
        fs::create_dir_all(store.parent().unwrap()).unwrap();
        fs::write(&store, "-- stored").unwrap();
        assert_eq!(read_bytes(&dir.join("map/war3map.lua")).unwrap(), b"-- stored");
        let _ = fs::remove_dir_all(&dir);
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

        // Refused: deleting it, a terrain of another size whose offset moved by part of a tile (Map Size moves it by
        // tiles), text that isn't a terrain (nothing written).
        assert!(refuse_moving(&w3e).unwrap_err().contains("Merge the subterrains"));
        assert!(refuse_moving(&flat.join("map/war3map.w3e.txt")).is_ok(), "control");
        let files_before = layout_files(&split);
        // 15×1 corners: each section's three rows of five as one row (the size check is w3proj's own test).
        let mut wider = String::new();
        let edited_text = String::from_utf8(edited.clone()).unwrap();
        let (mut row, mut in_grid, mut numbers): (Vec<&str>, bool, bool) = (Vec::new(), false, false);
        for line in edited_text.replace("corners 5 3", "corners 15 1").replace("offset -128 -64", "offset -127 -64").lines() {
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
        assert!(e.contains("part of a tile"), "{e}\n{wider}");
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

    /// The derived files of a split project answer from `.w3proj/derived/` under their map/ names: read, stat, exists,
    /// listed, written there (named in `also`, `.gitignore` made to ignore the store), deleted from there, never moved.
    /// The flat project's are its own files (control).
    #[test]
    fn derived_files_of_a_split_project_are_in_the_store() {
        let (flat, split) = split_mini("derived");
        let wpm = split.join("map").join("war3map.wpm");
        let stored = split.join(".w3proj").join("derived").join("war3map.wpm");
        assert!(!wpm.exists() && stored.is_file(), "the split moved it");
        assert!(derived_of(&flat.join("map").join("war3map.wpm")).unwrap().is_none(), "control: a flat project's file is itself");
        assert_eq!(derived_of(&wpm).unwrap().as_deref(), Some(stored.as_path()));
        assert_eq!(crate::read_bytes(&wpm).unwrap(), fs::read(flat.join("map/war3map.wpm")).unwrap());
        assert!(crate::exists(&wpm).unwrap());
        let s = crate::stat(&wpm).unwrap();
        assert_eq!(s.size, fs::metadata(&stored).unwrap().len());
        let (listed, _) = crate::walk_project(&split, false).unwrap();
        let f = listed.iter().find(|f| f.path == "map/war3map.wpm").expect("listed under its map/ name");
        assert_eq!((f.size, f.modified), (s.size, s.modified));
        // Absent ones: not there, reading says "not found" as for any file; a write makes it in the store.
        let shd = split.join("map").join("war3map.shd");
        assert!(!crate::exists(&shd).unwrap() && crate::stat(&shd).is_none());
        assert!(crate::read_bytes(&shd).unwrap_err().contains("os error 2"));
        let _ = fs::remove_file(split.join(".gitignore"));
        let _ = fs::remove_dir_all(split.join(".w3proj").join("derived"));
        let st = crate::write_bytes(&shd, b"shadows").unwrap();
        let in_store = split.join(".w3proj").join("derived").join("war3map.shd");
        assert_eq!(fs::read(&in_store).unwrap(), b"shadows");
        assert!(!shd.exists(), "nothing written into map/");
        assert_eq!(st.also.iter().map(|a| a.path.as_str()).collect::<Vec<_>>(), [in_store.to_string_lossy()]);
        assert!(fs::read_to_string(split.join(".gitignore")).unwrap().contains("/.w3proj/derived/\n"), "the new store is ignored");
        // A raw minimap icons file through the codec commands lands in the store too.
        let root = split.to_string_lossy().into_owned();
        let icons = fs::read_to_string(flat.join("map").join("war3map.mmp.json")).unwrap();
        crate::codec_write(&root, "map/war3map.mmp", &icons, &[]).unwrap();
        assert!(split.join(".w3proj").join("derived").join("war3map.mmp").is_file() && !split.join("map").join("war3map.mmp").exists());
        let back: serde_json::Value = serde_json::from_str(&crate::codec_decode(&root, "map/war3map.mmp", &[]).unwrap()).unwrap();
        assert_eq!(back, serde_json::from_str::<serde_json::Value>(&icons).unwrap());
        assert!(refuse_moving(&shd).is_err(), "never moved");
        assert!(delete_view(&shd).unwrap());
        assert!(!in_store.exists());
        assert!(!delete_view(&flat.join("map").join("war3map.wpm")).unwrap(), "control: a flat project's file is deleted as any file");
        let _ = fs::remove_dir_all(flat.parent().unwrap());
    }

    /// The Pathing tool's `.w3proj/pathing.json` of a split project is assembled from the subterrains' `pathing.txt` and
    /// sliced back: a write changes only the owning subterrain's file, reads back byte for byte, is listed and stat with
    /// its files' stamp; a damaged pathing.txt is an error (the file is there, it can't be read); deleting removes every
    /// pathing.txt. A flat project's file is a file (control).
    #[test]
    fn the_pathing_file_of_a_split_project() {
        let (flat, split) = split_mini("pathing");
        let json = split.join(".w3proj").join("pathing.json");
        assert!(pathing_of(&flat.join(".w3proj").join("pathing.json")).unwrap().is_none(), "control");
        assert!(!crate::exists(&json).unwrap() && crate::stat(&json).is_none(), "no overrides: no file");
        assert!(crate::read_bytes(&json).unwrap_err().contains("os error 2"));
        // The mini map: 5×3 corners, 16×8 cells; the 2×2 grid's seams at cell x 8 and y 4.
        let text = |cells: &[[u32; 4]]| {
            let rows: Vec<String> = cells.iter().map(|c| format!("\n    [{},{},{},{}]", c[0], c[1], c[2], c[3])).collect();
            format!("{{\n  \"format\": \"w3proj.pathing/1\",\n  \"width\": 16,\n  \"height\": 8,\n  \"cells\": [{}\n  ]\n}}\n", rows.join(","))
        };
        let one = text(&[[7, 1, 2, 8], [8, 1, 2, 8], [3, 5, 0, 8]]);
        let st = crate::write_bytes(&json, one.as_bytes()).unwrap();
        assert!(!json.exists(), "nothing written to .w3proj/pathing.json");
        let txt = |s: &str| split.join("map").join("terrain").join(s).join("pathing.txt");
        assert_eq!(fs::read_to_string(txt("sw")).unwrap(), "7 1 0a 02\n");
        assert_eq!(fs::read_to_string(txt("se")).unwrap(), "0 1 0a 02\n");
        assert_eq!(fs::read_to_string(txt("nw")).unwrap(), "3 1 08 00\n");
        assert!(!txt("ne").exists());
        assert_eq!(st.also.len(), 3);
        assert_eq!(crate::read_text(&json).unwrap(), one, "read back byte for byte");
        let (listed, _) = crate::walk_project(&split, false).unwrap();
        let f = listed.iter().find(|f| f.path == ".w3proj/pathing.json").expect("listed");
        let s = crate::stat(&json).unwrap();
        assert_eq!((f.size, f.modified), (s.size, s.modified));
        assert_eq!(crate::stat_hashed(&json).unwrap().hash, Some(crate::content_hash(one.as_bytes())));
        // An edit in the north-west only: only nw's file is written; one that leaves se without overrides removes its file.
        let sw_before = fs::metadata(txt("sw")).unwrap().modified().unwrap();
        let two = text(&[[7, 1, 2, 8], [8, 1, 2, 8], [3, 5, 2, 0]]);
        let st = crate::write_bytes(&json, two.as_bytes()).unwrap();
        assert_eq!(st.also.iter().map(|a| a.path.clone()).collect::<Vec<_>>(), [txt("nw").to_string_lossy().into_owned()], "only the owning pathing.txt");
        assert_eq!(fs::metadata(txt("sw")).unwrap().modified().unwrap(), sw_before);
        let three = text(&[[7, 1, 2, 8], [3, 5, 2, 0]]);
        crate::write_bytes(&json, three.as_bytes()).unwrap();
        assert!(!txt("se").exists());
        assert_eq!(crate::read_text(&json).unwrap(), three);
        // Refused, nothing written: another size, fields a split project can't keep.
        let files_before = layout_files(&split);
        assert!(crate::write_bytes(&json, three.replace("\"width\": 16", "\"width\": 20").as_bytes()).unwrap_err().contains("20×8"));
        assert!(crate::write_bytes(&json, three.replace("\"format\"", "\"note\": 1,\n  \"format\"").as_bytes()).unwrap_err().contains("\"note\""));
        assert_eq!(layout_files(&split), files_before);
        // A damaged pathing.txt: there, and reading it says which line; the terrain still opens.
        fs::write(txt("nw"), "3 1 08 00\ngarbage\n").unwrap();
        assert!(crate::exists(&json).unwrap());
        assert!(crate::read_bytes(&json).unwrap_err().contains("map/terrain/nw/pathing.txt line 2"));
        assert!(crate::read_bytes(&split.join("map").join("war3map.w3e.txt")).is_ok());
        // A real .w3proj/pathing.json beside them is in the way.
        fs::write(txt("nw"), "3 1 08 00\n").unwrap();
        fs::write(&json, &three).unwrap();
        assert!(crate::read_bytes(&json).unwrap_err().contains("is there, but the terrain is split"));
        fs::remove_file(&json).unwrap();
        // Deleted: every pathing.txt goes; moving is refused.
        assert!(refuse_moving(&json).is_err());
        assert!(delete_view(&json).unwrap());
        assert!(!txt("sw").exists() && !txt("nw").exists() && !crate::exists(&json).unwrap());
        // The flat project's file is written as itself.
        let fj = flat.join(".w3proj").join("pathing.json");
        crate::write_bytes(&fj, one.as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&fj).unwrap(), one);
        let _ = fs::remove_dir_all(flat.parent().unwrap());
    }

    /// Open Subterrains… through the file commands: with only the north-east open, its corner is written into its file
    /// alone (named in `also`), the south-west's (read-only halo here) is refused with nothing written, the state says
    /// which are open and the mask; opening all again removes the choice. A flat project has no state.
    #[test]
    fn a_partial_open_through_the_file_commands() {
        let (flat, split) = split_mini("partial");
        let root = split.to_string_lossy().into_owned();
        assert!(open_state(&flat.to_string_lossy()).unwrap().is_none(), "control: a flat project");
        assert!(set_open(&flat.to_string_lossy(), &["ne".into()]).is_err());
        let s = set_open(&root, &["ne".into()]).unwrap().unwrap();
        assert!(s.partial && s.mask.len() == 15);
        assert_eq!(s.subterrains.iter().map(|x| (x.name.as_str(), x.open)).collect::<Vec<_>>(), [("sw", false), ("se", false), ("nw", false), ("ne", true)]);
        let w3e = split.join("map/war3map.w3e.txt");
        let text = String::from_utf8(read_bytes(&w3e).unwrap()).unwrap();
        // The north row's last corner (north-east) and the south row's first (south-west).
        let ne = text.replacen("[height]\n0*4 -12\n", "[height]\n0*4 4\n", 1);
        assert_ne!(ne, text);
        let stamp = crate::write_bytes(&w3e, ne.as_bytes()).unwrap();
        assert_eq!(stamp.also.iter().map(|a| a.path.as_str()).collect::<Vec<_>>(), [join_rel(&split.join("map"), "terrain/ne/terrain.txt").to_string_lossy()]);
        let before = layout_files(&split);
        let sw = ne.replacen("\n-12 0*4\n", "\n-8 0*4\n", 1);
        assert_ne!(sw, ne);
        let e = crate::write_bytes(&w3e, sw.as_bytes()).unwrap_err();
        assert!(e.contains("subterrain \"sw\"") && e.contains("nothing was written"), "{e}");
        assert_eq!(layout_files(&split), before);
        set_open(&root, &["sw".into(), "se".into(), "nw".into(), "ne".into()]).unwrap();
        assert!(!split.join(".w3proj").join("open-subterrains.json").exists());
        assert!(!open_state(&root).unwrap().unwrap().partial);
        let _ = fs::remove_dir_all(flat.parent().unwrap());
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
