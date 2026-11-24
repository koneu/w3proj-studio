//! Working on part of a split map (spec "Working on Part of the Map"): the subterrains a user opened, kept locally in
//! `.w3proj/open-subterrains.json` (git-ignored, one per checkout), and what the app's flat files hold then.
//!
//! ```text
//! {"format": "w3proj.open-subterrains/1", "open": ["westfall", "elwynn_forest"]}
//! ```
//!
//! No file: every subterrain is open (the default; "Open Subterrains…" with all of them ticked removes it). A file that
//! is there but can't be read, or names a subterrain `terrain.json` doesn't have, is an error: the terrain doesn't open,
//! rather than opening more or fewer subterrains than were chosen. `W3PROJ_OPEN_SUBTERRAINS` (`all`, or names
//! separated by commas) overrides the file for one process (headless jobs), and `set_override` for this process
//! (`w3proj rebuild` works on everything).
//!
//! With a subterrain closed (`Partial`), each corner of the canvas is open (in an open subterrain), halo (within `HALO`
//! corners of one, in another subterrain or none: read for the seams, never written) or closed (default-filled, not
//! read). Reading a flat file assembles the open subterrains whole and from the others only what lies in the halo; a
//! closed subterrain none of whose rectangle lies in the halo is never opened. Writing takes the open subterrains' share
//! of the content and refuses, writing nothing, when the content changed anything outside them: a corner, an object or
//! a pathing override in the halo or the closed area, an object moved there, a palette slot reordered (closed files name
//! slots by number), an object file's header. Only open subterrains' files are written.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;

use crate::terrain_layout::{self as tl, Layout, Subterrain};
use crate::terrain_objects::{self as objects, KINDS};
use crate::w3e;
use crate::{Error, Result};

/// The file, relative to the project.
pub const FILE: [&str; 2] = [".w3proj", "open-subterrains.json"];
/// Its name for messages.
pub const NAME: &str = ".w3proj/open-subterrains.json";
/// The `.gitignore` line it needs: the choice is each user's own.
pub const IGNORED: &str = "/.w3proj/open-subterrains.json";
const FORMAT: &str = "w3proj.open-subterrains/1";
/// How far (in corners) around an open subterrain its neighbours are loaded read-only.
pub const HALO: usize = 2;
/// The variable that overrides the file for one process.
pub const ENV: &str = "W3PROJ_OPEN_SUBTERRAINS";

/// Per corner (`Partial::mask`): in no open subterrain nor its halo.
pub const CLOSED: u8 = 0;
/// Per corner: within `HALO` corners of an open subterrain, outside every open one (read-only).
pub const HALO_CORNER: u8 = 1;
/// Per corner: in an open subterrain.
pub const OPEN: u8 = 2;

/// Which subterrains are open.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Choice {
    All,
    Names(Vec<String>),
}

/// Where the choice came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// No file: everything open.
    Default,
    File,
    Env,
    Override,
}

static OVERRIDE: Mutex<Option<Choice>> = Mutex::new(None);

/// Overrides the file (and `ENV`) for this process; None goes back to them.
pub fn set_override(c: Option<Choice>) {
    *OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) = c;
}

/// The file of a project.
pub fn path(project: &Path) -> PathBuf {
    FILE.iter().fold(project.to_path_buf(), |p, c| p.join(c))
}

fn damaged(why: impl std::fmt::Display) -> Error {
    Error::Project(format!("{NAME} can't be read ({why}): pick the subterrains again with Open Subterrains…, or delete the file to open them all"))
}

/// The names a file holds: `{"format": …, "open": [names…]}`, at least one, none twice. Anything else is an error.
pub fn parse(bytes: &[u8]) -> Result<Vec<String>> {
    let doc = objects::strict_json(bytes).map_err(|e| damaged(format!("it isn't JSON: {e}")))?;
    let o = doc.as_object().ok_or_else(|| damaged("it isn't a JSON object"))?;
    if let Some(k) = o.keys().find(|k| *k != "format" && *k != "open") {
        return Err(damaged(format!("it has an unknown key \"{k}\"")));
    }
    if o.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(damaged(format!("its format isn't \"{FORMAT}\"")));
    }
    let list = o.get("open").and_then(Value::as_array).ok_or_else(|| damaged("its \"open\" isn't a list"))?;
    let mut names: Vec<String> = Vec::with_capacity(list.len().min(1024));
    for v in list {
        let n = v.as_str().filter(|s| !s.trim().is_empty()).ok_or_else(|| damaged("\"open\" holds something other than a subterrain's name"))?;
        if names.iter().any(|m| m == n) {
            return Err(damaged(format!("it names \"{n}\" twice")));
        }
        names.push(n.to_string());
    }
    if names.is_empty() {
        return Err(damaged("it opens no subterrain"));
    }
    Ok(names)
}

/// The file's text for `names`.
pub fn to_json(names: &[String]) -> Vec<u8> {
    let list: Vec<String> = names.iter().map(|n| serde_json::to_string(n).expect("a string serializes")).collect();
    format!("{{\n  \"format\": \"{FORMAT}\",\n  \"open\": [{}]\n}}\n", list.join(", ")).into_bytes()
}

fn parse_env(v: &str) -> Result<Choice> {
    if v.trim().eq_ignore_ascii_case("all") {
        return Ok(Choice::All);
    }
    let names: Vec<String> = v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if names.is_empty() {
        return Err(Error::Project(format!("{ENV} is set but names no subterrain (\"all\", or names separated by commas)")));
    }
    Ok(Choice::Names(names))
}

/// The choice for a project: the override, `ENV`, the file, else everything.
pub fn choice(project: &Path) -> Result<(Choice, Source)> {
    if let Some(c) = OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return Ok((c, Source::Override));
    }
    if let Ok(v) = std::env::var(ENV) {
        return Ok((parse_env(&v)?, Source::Env));
    }
    match fs::read(path(project)) {
        Ok(b) => Ok((Choice::Names(parse(&b)?), Source::File)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((Choice::All, Source::Default)),
        Err(e) => Err(damaged(e)),
    }
}

/// Stores the choice of a split project (`layout`): every subterrain removes the file (the default), fewer write it
/// and make `.gitignore` ignore it. Names `terrain.json` doesn't have, none, or one twice are refused.
pub fn store(project: &Path, layout: &Layout, names: &[String]) -> Result<()> {
    if names.is_empty() {
        return Err(Error::Project("at least one subterrain has to stay open".into()));
    }
    for (i, n) in names.iter().enumerate() {
        if !layout.subterrains.iter().any(|s| &s.name == n) {
            return Err(Error::Project(format!("there is no subterrain \"{n}\" (map/{})", tl::LAYOUT_FILE)));
        }
        if names[..i].contains(n) {
            return Err(Error::Project(format!("\"{n}\" is named twice")));
        }
    }
    let p = path(project);
    if layout.subterrains.iter().all(|s| names.contains(&s.name)) {
        return match fs::remove_file(&p) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(Error::Project(format!("{NAME} can't be removed: {e}"))),
            _ => Ok(()),
        };
    }
    // In the order of terrain.json, so the same choice is the same file.
    let ordered: Vec<String> = layout.subterrains.iter().filter(|s| names.contains(&s.name)).map(|s| s.name.clone()).collect();
    crate::project::write_atomic(&p, &to_json(&ordered))?;
    crate::derived::ensure_lines(project, &[IGNORED])?;
    Ok(())
}

/// A partial load: which subterrains are open, which give halo, and every corner's state.
#[derive(Clone, Debug)]
pub struct Partial {
    /// Per subterrain (`terrain.json`'s order): open.
    pub open: Vec<bool>,
    /// Per subterrain: not open, and its rectangle reaches into an open one's halo (it is read, never written).
    pub halo: Vec<bool>,
    /// Per corner, row 0 the south row: `CLOSED`, `HALO_CORNER` or `OPEN`.
    pub mask: Vec<u8>,
    pub width: usize,
    pub height: usize,
    /// The open rectangles grown by `HALO`, clipped to the canvas: `[x0, y0, x1, y1)` in corners.
    grown: Vec<[usize; 4]>,
    offset: [f32; 2],
}

impl Partial {
    /// The partial load of `layout` for a choice; None when every subterrain is open. A name the layout doesn't have
    /// is an error (a renamed or removed subterrain: pick again).
    pub fn new(layout: &Layout, choice: &Choice) -> Result<Option<Partial>> {
        let Choice::Names(names) = choice else { return Ok(None) };
        let subs = &layout.subterrains;
        if let Some(n) = names.iter().find(|n| !subs.iter().any(|s| &&s.name == n)) {
            return Err(Error::Project(format!(
                "{NAME} opens subterrain \"{n}\", which map/{} doesn't have: pick the subterrains again with Open Subterrains…, or delete the file to open them all",
                tl::LAYOUT_FILE
            )));
        }
        let open: Vec<bool> = subs.iter().map(|s| names.contains(&s.name)).collect();
        if open.iter().all(|o| *o) {
            return Ok(None);
        }
        let [width, height] = layout.corners();
        let mut mask = vec![CLOSED; width * height];
        let mut grown = Vec::new();
        for (s, _) in subs.iter().zip(&open).filter(|(_, o)| **o) {
            for y in s.y..s.y + s.h {
                mask[y * width + s.x..y * width + s.x + s.w].iter_mut().for_each(|m| *m = OPEN);
            }
            grown.push([s.x.saturating_sub(HALO), s.y.saturating_sub(HALO), (s.x + s.w + HALO).min(width), (s.y + s.h + HALO).min(height)]);
        }
        for g in &grown {
            for y in g[1]..g[3] {
                for m in &mut mask[y * width + g[0]..y * width + g[2]] {
                    if *m == CLOSED {
                        *m = HALO_CORNER;
                    }
                }
            }
        }
        let halo = subs
            .iter()
            .zip(&open)
            .map(|(s, o)| !o && grown.iter().any(|g| s.x < g[2] && g[0] < s.x + s.w && s.y < g[3] && g[1] < s.y + s.h))
            .collect();
        Ok(Some(Partial { open, halo, mask, width, height, grown, offset: layout.offset() }))
    }

    /// Whether subterrain `i`'s files are read (open or halo).
    pub fn loaded(&self, i: usize) -> bool {
        self.open[i] || self.halo[i]
    }

    /// How many subterrains are closed (neither open nor read for the halo, and the halo ones: everything not open).
    pub fn closed_count(&self) -> usize {
        self.open.iter().filter(|o| !**o).count()
    }

    /// Whether a world area `[left, bottom, right, top]` (a point twice) reaches into an open subterrain's halo: grown
    /// rectangle `[x0, x1)` covers world `[offset + 128·x0, offset + 128·x1)`, as ownership measures.
    pub fn near(&self, a: [f64; 4]) -> bool {
        let (ox, oy) = (self.offset[0] as f64, self.offset[1] as f64);
        self.grown.iter().any(|g| {
            let (l, r) = (ox + 128.0 * g[0] as f64, ox + 128.0 * g[2] as f64);
            let (b, t) = (oy + 128.0 * g[1] as f64, oy + 128.0 * g[3] as f64);
            a[0] < r && a[2] >= l && a[1] < t && a[3] >= b
        })
    }

    /// The mask as text, one character per corner (`0` closed, `1` halo, `2` open), rows from the south.
    pub fn mask_text(&self) -> String {
        self.mask.iter().map(|m| (b'0' + m) as char).collect()
    }
}

/// The subterrain owning corner `i` of a canvas `width` wide, for messages.
fn corner_owner(subs: &[Subterrain], width: usize, i: usize) -> String {
    let (x, y) = (i % width, i / width);
    match subs.iter().find(|s| s.x <= x && x < s.x + s.w && s.y <= y && y < s.y + s.h) {
        Some(s) => format!("subterrain \"{}\"", s.name),
        None => "no subterrain".to_string(),
    }
}

fn read_sub_file(map_dir: &Path, rel: &str) -> Result<Option<Vec<u8>>> {
    match fs::read(crate::paths::join_rel(map_dir, rel)) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::Project(format!("map/{rel} can't be read: {e}"))),
    }
}

/// The files of a partial load (relative to `map/`, as the full layer reads them): `terrain.json` and the open and halo
/// subterrains' ground and object files. Closed subterrains' files are never opened.
fn loaded_files(map_dir: &Path, layout: &Layout, p: &Partial) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut files = BTreeMap::new();
    for (_, s) in layout.subterrains.iter().enumerate().filter(|(i, _)| p.loaded(*i)) {
        let kinds = KINDS.into_iter().filter(|k| layout.objects.has(*k)).map(|k| s.object_path(k));
        for rel in std::iter::once(s.ground_path()).chain(kinds) {
            if let Some(b) = read_sub_file(map_dir, &rel)? {
                files.insert(rel, b);
            }
        }
    }
    Ok(files)
}

/// The checks `flatten` makes on the layout's file names (no file of a kind both flat and in the subterrains, nothing
/// under `map/terrain/` the layout doesn't name), on the names only: a closed subterrain's files aren't read for it.
fn check_names(map_dir: &Path, layout: &Layout) -> Result<()> {
    for kind in KINDS.into_iter().filter(|k| layout.objects.has(*k)) {
        for name in [kind.flat(), kind.raw()] {
            if map_dir.join(name).try_exists().map_err(|e| Error::Project(format!("map/{name} can't be checked: {e}")))? {
                return Err(Error::Project(format!(
                    "the project has its {} both in map/{name} and in map/{}/: keep one (`w3proj terrain merge` makes the flat file)",
                    kind.name(),
                    tl::DIR
                )));
            }
        }
    }
    let mut ours: std::collections::HashSet<String> = layout.subterrains.iter().map(Subterrain::ground_path).collect();
    ours.insert(tl::LAYOUT_FILE.to_string());
    ours.extend(layout.subterrains.iter().map(crate::terrain_pathing::path));
    for kind in KINDS.into_iter().filter(|k| layout.objects.has(*k)) {
        ours.extend(layout.subterrains.iter().map(|s| s.object_path(kind)));
    }
    for path in tl::FOLDER.paths(map_dir)? {
        if !ours.contains(&path) {
            return Err(Error::Project(format!("map/{path} isn't part of the terrain layout (map/{}/ holds terrain.json and each subterrain's files only)", tl::DIR)));
        }
    }
    Ok(())
}

/// The flat files (`tl::FLAT_NAMES` the layout holds) of a partial load: the terrain with the open subterrains whole,
/// the halo from the others and `defaultCorner` elsewhere; the objects and regions of the open subterrains and those of
/// halo subterrains that reach into the halo (`Partial::near`).
pub(crate) fn read_flat_files(map_dir: &Path, layout: &Layout, p: &Partial) -> Result<BTreeMap<String, Vec<u8>>> {
    check_names(map_dir, layout)?;
    let files = loaded_files(map_dir, layout, p)?;
    let mut t = layout.head.clone();
    t.corners = vec![layout.default_corner; t.width * t.height];
    for (i, s) in layout.subterrains.iter().enumerate().filter(|(i, _)| p.loaded(*i)) {
        let path = s.ground_path();
        let bytes = files.get(&path).ok_or_else(|| Error::Format(format!("map/{path} is missing: subterrain \"{}\" has no ground file", s.name)))?;
        let corners = tl::parse_ground(&path, bytes, s.w, s.h, t.version)?;
        for row in 0..s.h {
            for col in 0..s.w {
                let at = (s.y + row) * t.width + s.x + col;
                if p.open[i] || p.mask[at] == HALO_CORNER {
                    t.corners[at] = corners[row * s.w + col];
                }
            }
        }
    }
    let mut out = BTreeMap::new();
    out.insert(tl::FLAT_FILE.to_string(), w3e::terrain_text(&t)?);
    let take = |i: usize| p.loaded(i).then_some(p.open[i]);
    let near = |a: [f64; 4]| p.near(a);
    let merged = objects::assemble_with(&layout.objects, &layout.subterrains, layout.offset(), &take, &near, &|rel| files.get(rel).cloned())?;
    out.extend(merged.into_iter().map(|(kind, bytes)| (kind.flat().to_string(), bytes)));
    Ok(out)
}

/// The layout's files to write for the flat file `name` written as `bytes` in a partial load (only open subterrains'
/// files, and `terrain.json` when its palettes grew or an id range was added), or the reason it is refused. `layout`
/// is updated with what `terrain.json` gets.
pub(crate) fn write_flat(map_dir: &Path, layout: &mut Layout, p: &Partial, name: &str, bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>> {
    let before = read_flat_files(map_dir, layout, p)?;
    let Some(old) = before.get(name) else {
        return Err(Error::Project(format!("map/{name} isn't one the split terrain holds (map/{})", tl::LAYOUT_FILE)));
    };
    let refused = |why: String| Error::Project(format!("{why}; {} of the {} subterrains are closed (nothing was written). Open them with Open Subterrains… to edit there", p.closed_count(), p.open.len()));
    let mut files = BTreeMap::new();
    if name == tl::FLAT_FILE {
        let new = w3e::terrain_from_text(bytes)?;
        let old = w3e::terrain_from_text(old)?;
        if [new.width, new.height] != layout.corners() || new.offset != layout.head.offset {
            return Err(Error::Project(format!(
                "the terrain is {}×{} corners, its subterrains cover a canvas of {}×{} (map/{}): the map size changes only with every subterrain open (Open Subterrains…)",
                new.width,
                new.height,
                layout.head.width,
                layout.head.height,
                tl::LAYOUT_FILE
            )));
        }
        let same_head = new.version == old.version
            && new.tileset == old.tileset
            && new.custom_tilesets == old.custom_tilesets
            && new.offset.map(f32::to_bits) == old.offset.map(f32::to_bits)
            && new.trailer == old.trailer
            && new.ground.starts_with(&old.ground)
            && new.cliffs.starts_with(&old.cliffs);
        if !same_head {
            return Err(refused("the terrain's tileset, version or tile lists changed (only a tile added at the end can be, while closed subterrains name tiles by their place in the lists)".into()));
        }
        if let Some(i) = (0..new.corners.len()).find(|&i| p.mask[i] != OPEN && new.corners[i] != old.corners[i]) {
            let what = if p.mask[i] == HALO_CORNER { "read-only, beside an open one" } else { "closed" };
            return Err(refused(format!("the edit changes corner {},{} in {} ({what})", i % new.width, i / new.width, corner_owner(&layout.subterrains, new.width, i))));
        }
        for (s, _) in layout.subterrains.iter().zip(&p.open).filter(|(_, o)| **o) {
            let mut corners = Vec::with_capacity(s.w * s.h);
            for row in 0..s.h {
                let at = (s.y + row) * new.width + s.x;
                corners.extend_from_slice(&new.corners[at..at + s.w]);
            }
            let text = tl::ground_text(&corners, s.w, s.h, new.version);
            // Never store what can't be read back as it was.
            if tl::parse_ground(&s.ground_path(), &text, s.w, s.h, new.version)? != corners {
                return Err(Error::Format(format!("map/{} doesn't read back as written (nothing was written)", s.ground_path())));
            }
            files.insert(s.ground_path(), text);
        }
        if new.ground != layout.head.ground || new.cliffs != layout.head.cliffs {
            layout.head.ground = new.ground;
            layout.head.cliffs = new.cliffs;
            files.insert(tl::LAYOUT_FILE.to_string(), layout.to_json()?);
        }
        return Ok(files);
    }
    let Some(kind) = KINDS.into_iter().find(|k| k.flat() == name && layout.objects.has(*k)) else {
        return Err(Error::Project(format!("map/{name} isn't one the split terrain holds (map/{})", tl::LAYOUT_FILE)));
    };
    let offset = layout.offset();
    let current = loaded_files(map_dir, layout, p)?;
    let take = |i: usize| p.loaded(i).then_some(p.open[i]);
    let near = |a: [f64; 4]| p.near(a);
    let written = objects::write_partial(kind, bytes, &layout.objects, &layout.subterrains, offset, &take, &near, &|rel| current.get(rel).cloned())
        .map_err(|e| match e {
            Error::Project(m) if m.starts_with("refused: ") => refused(m["refused: ".len()..].to_string()),
            e => e,
        })?;
    // New creation numbers above every range: the range Studio's allocator took, recorded (as the full layer does).
    let old_numbers: std::collections::HashSet<u32> = objects::flat_numbers(kind, old, offset)?.into_iter().map(|(n, _, _)| n).collect();
    let new: Vec<(u32, usize)> = objects::flat_numbers(kind, bytes, offset)?
        .into_iter()
        .filter(|(n, _, _)| !old_numbers.contains(n))
        .map(|(n, x, y)| (n, objects::owner(&layout.subterrains, offset, x, y)))
        .collect();
    let ranges_before: Vec<Vec<[u32; 2]>> = layout.subterrains.iter().map(|s| s.id_ranges.clone()).collect();
    crate::terrain_ids::record_new(&mut layout.subterrains, new);
    if layout.subterrains.iter().map(|s| &s.id_ranges).ne(ranges_before.iter()) {
        files.insert(tl::LAYOUT_FILE.to_string(), layout.to_json()?);
    }
    files.extend(written);
    Ok(files)
}

/// The pathing overrides (`.w3proj/pathing.json`) of a partial load: the open subterrains' `pathing.txt` and the halo
/// subterrains' cells whose tile lies in the halo. None when none of them has an override and no open one has a file.
pub(crate) fn read_pathing(map_dir: &Path, layout: &Layout, p: &Partial) -> Result<Option<Vec<u8>>> {
    Ok(pathing_cells(map_dir, layout, p)?.map(|(cells, _)| crate::terrain_pathing::json_text(layout.corners(), &cells)))
}

/// Pathing overrides, absolute.
type Cells = Vec<crate::terrain_pathing::Cell>;

/// `read_pathing`'s cells (absolute), and which of them lie outside the open subterrains.
fn pathing_cells(map_dir: &Path, layout: &Layout, p: &Partial) -> Result<Option<(Cells, Cells)>> {
    use crate::terrain_pathing as tp;
    let corners = layout.corners();
    let (mut all, mut outside, mut open_file) = (Vec::new(), Vec::new(), false);
    for (i, s) in layout.subterrains.iter().enumerate().filter(|(i, _)| p.loaded(*i)) {
        let rel = tp::path(s);
        let Some(bytes) = read_sub_file(map_dir, &rel)? else { continue };
        open_file |= p.open[i];
        let [x0, y0, w, h] = tp::cell_rect(s, corners);
        for c in tp::parse_txt(&format!("map/{rel}"), &bytes, w, h)? {
            let c = tp::Cell { x: c.x + x0 as u32, y: c.y + y0 as u32, ..c };
            if p.open[i] {
                all.push(c);
            } else if p.mask[(c.y / 4) as usize * p.width + (c.x / 4) as usize] == HALO_CORNER {
                all.push(c);
                outside.push(c);
            }
        }
    }
    if all.is_empty() && !open_file {
        return Ok(None);
    }
    all.sort();
    outside.sort();
    Ok(Some((all, outside)))
}

/// Files to write (path relative to `map/` → bytes), and files to remove.
pub(crate) type Writes = (BTreeMap<String, Vec<u8>>, Vec<String>);

/// The open subterrains' `pathing.txt` for `.w3proj/pathing.json` written as `bytes` in a partial load: (files to
/// write, open subterrains' files to remove). Refused when an override outside the open subterrains changed.
pub(crate) fn write_pathing(map_dir: &Path, layout: &Layout, p: &Partial, bytes: &[u8]) -> Result<Writes> {
    use crate::terrain_pathing as tp;
    let corners = layout.corners();
    let cells = tp::parse_json(bytes, corners)?;
    let (w, owner) = tp::owners(layout);
    let mut per: Vec<Vec<tp::Cell>> = vec![Vec::new(); layout.subterrains.len()];
    let mut outside = Vec::new();
    for c in &cells {
        match owner[c.y as usize * w + c.x as usize] {
            Some(i) if p.open[i as usize] => {
                let [x0, y0, _, _] = tp::cell_rect(&layout.subterrains[i as usize], corners);
                per[i as usize].push(tp::Cell { x: c.x - x0 as u32, y: c.y - y0 as u32, ..*c });
            }
            _ => outside.push(*c),
        }
    }
    outside.sort();
    let before = pathing_cells(map_dir, layout, p)?.map(|(_, o)| o).unwrap_or_default();
    if outside != before {
        let c = outside.iter().find(|c| !before.contains(c)).or_else(|| before.iter().find(|c| !outside.contains(c))).copied();
        let at = c.map(|c| format!(" (cell {}, {})", c.x, c.y)).unwrap_or_default();
        return Err(Error::Project(format!(
            "{}: an override outside the open subterrains changed{at}; {} of the {} subterrains are closed (nothing was written). Open them with Open Subterrains… to paint there",
            tp::JSON_NAME,
            p.closed_count(),
            p.open.len()
        )));
    }
    let mut files = BTreeMap::new();
    let mut remove = Vec::new();
    for ((s, open), cells) in layout.subterrains.iter().zip(&p.open).zip(per) {
        if !open {
            continue;
        }
        if cells.is_empty() {
            remove.push(tp::path(s));
        } else {
            files.insert(tp::path(s), tp::txt(&cells));
        }
    }
    Ok((files, remove))
}

/// Of a partial load, the subterrains' `pathing.txt` that are there among the open and halo ones (relative to `map/`).
pub(crate) fn pathing_files(map_dir: &Path, layout: &Layout, p: &Partial) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for (_, s) in layout.subterrains.iter().enumerate().filter(|(i, _)| p.loaded(*i)) {
        let rel = crate::terrain_pathing::path(s);
        let at = crate::paths::join_rel(map_dir, &rel);
        if at.try_exists().map_err(|e| Error::Project(format!("map/{rel} can't be checked: {e}")))? {
            out.push(rel);
        }
    }
    Ok(out)
}

/// The partial load of the project whose `map/` folder this is, from its choice; None when everything is open.
/// A choice that can't be read is an error.
pub fn of_map_dir(map_dir: &Path, layout: &Layout) -> Result<Option<Partial>> {
    let project = map_dir.parent().ok_or_else(|| Error::Project("no project folder above map/".into()))?;
    let (c, _) = choice(project)?;
    Partial::new(layout, &c)
}

/// What the app's Subterrains view and the terrain editor are told (`terrain_open_state`).
#[derive(serde::Serialize, Debug)]
pub struct State {
    pub partial: bool,
    pub source: Source,
    pub corners: [usize; 2],
    pub halo: usize,
    pub subterrains: Vec<SubState>,
    /// `Partial::mask_text`; empty when everything is open.
    pub mask: String,
    /// Why the choice can't be used (a damaged file, a name the layout doesn't have): then the terrain doesn't open.
    pub error: Option<String>,
}

#[derive(serde::Serialize, Debug)]
pub struct SubState {
    pub name: String,
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
    pub open: bool,
    /// Read for the halo (not open).
    pub halo: bool,
    /// The bytes of its files on disk (sizes only: nothing of a closed one is read).
    pub bytes: u64,
}

/// The state of a split project (`project`): its subterrains and which are open. None for a flat project.
pub fn state(project: &Path) -> Result<Option<State>> {
    let map_dir = project.join(crate::project::MAP_DIR);
    if !tl::is_split_on_disk(&map_dir)? {
        return Ok(None);
    }
    let bytes = fs::read(map_dir.join(tl::DIR).join("terrain.json")).map_err(|e| Error::Project(format!("map/{} can't be read: {e}", tl::LAYOUT_FILE)))?;
    let layout = Layout::parse(&bytes)?;
    let (picked, error) = match choice(project).and_then(|(c, src)| Partial::new(&layout, &c).map(|p| (p, src))) {
        Ok((p, src)) => ((p, src), None),
        Err(e) => ((None, Source::File), Some(e.to_string())),
    };
    let (partial, source) = picked;
    let size = |s: &Subterrain| -> u64 {
        let dir = map_dir.join(tl::DIR).join(&s.folder);
        fs::read_dir(&dir).map(|es| es.flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()).unwrap_or(0)
    };
    let subterrains = layout
        .subterrains
        .iter()
        .enumerate()
        .map(|(i, s)| SubState {
            name: s.name.clone(),
            x: s.x,
            y: s.y,
            w: s.w,
            h: s.h,
            open: error.is_none() && partial.as_ref().is_none_or(|p| p.open[i]),
            halo: partial.as_ref().is_some_and(|p| p.halo[i]),
            bytes: size(s),
        })
        .collect();
    Ok(Some(State {
        partial: partial.is_some(),
        source,
        corners: layout.corners(),
        halo: HALO,
        subterrains,
        mask: partial.as_ref().map(Partial::mask_text).unwrap_or_default(),
        error,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::w3e::{Corner, Terrain};
    use serde_json::json;

    /// 25×17 corners at (0, 0): corner c lies at world 128·c.
    const W: usize = 25;
    const H: usize = 17;

    /// A split project in a fresh folder: a 25×17 terrain, doodads every third tile, units every fifth, four regions
    /// and a special doodad, cut into 3×2 subterrains (south row a0 a1 a2, north row b0 b1 b2: x 0/8/16, y 0/8).
    fn project(test: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("w3proj-open-{test}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("map")).unwrap();
        fs::write(dir.join("w3proj.toml"), "format = 1\n\n[archive]\nsector_size_shift = 3\n\n[pack]\n").unwrap();
        let corners = (0..W * H)
            .map(|i| Corner {
                height: 0x2000 + (i % 7) as i16 * 4,
                water: 0x2000 - 80,
                texture: (i % 3) as u8,
                flags: 0,
                texture_bits: 0,
                variation: (i % 5) as u8,
                cliff_variation: 0,
                cliff_texture: 15,
                layer: 2,
            })
            .collect();
        let t = Terrain {
            version: 11,
            tileset: b'L',
            custom_tilesets: 1,
            ground: vec![*b"Ldrt", *b"Lgrs", *b"Lrok"],
            cliffs: vec![*b"CLdi"],
            width: W,
            height: H,
            offset: [0.0, 0.0],
            corners,
            trailer: Vec::new(),
        };
        fs::write(dir.join("map").join("war3map.w3e.txt"), w3e::terrain_text(&t).unwrap()).unwrap();
        let mut doodads = Vec::new();
        for ty in (0..H - 1).step_by(3) {
            for tx in (0..W - 1).step_by(3) {
                let n = doodads.len() as u32 + 1;
                doodads.push(json!({"id": "ATtr", "variation": 0, "position": [128.0 * tx as f64 + 40.0, 128.0 * ty as f64 + 40.0, 0.0], "angle": 0.5, "scale": [1.0, 1.0, 1.0],
                    "skinId": "ATtr", "flags": 2, "life": 100, "itemTable": -1, "itemSets": [], "editorId": n}));
            }
        }
        let doo = json!({"format": "w3proj.doodads/1", "magic": "W3do", "version": 8, "subversion": 11, "skinIds": true, "doodads": doodads, "specialVersion": 0, "specials": [{"id": "YTlc", "z": 0, "x": 2, "y": 2}]});
        let mut units = Vec::new();
        for ty in (1..H - 1).step_by(5) {
            for tx in (1..W - 1).step_by(5) {
                let n = 1000 + units.len() as u32;
                units.push(json!({"id": "hfoo", "variation": 0, "position": [128.0 * tx as f64 + 64.0, 128.0 * ty as f64 + 64.0, 0.0], "angle": 4.5, "scale": [1.0, 1.0, 1.0],
                    "skinId": "hfoo", "flags": 2, "player": 0, "unknown1": 0, "unknown2": 0, "hp": -1, "mana": -1, "itemTable": -1, "itemSets": [], "gold": 0,
                    "targetAcquisition": -1.0, "level": 1, "strength": 0, "agility": 0, "intelligence": 0, "inventory": [], "abilities": [], "randomType": 0,
                    "randomLevel": "010000", "randomClass": 0, "color": -1, "waygate": -1, "editorId": n}));
            }
        }
        let units = json!({"format": "w3proj.units/1", "magic": "W3do", "version": 8, "subversion": 11, "skinIds": true, "units": units});
        let region = |i: u32, l: f64, b: f64, r: f64, t: f64| json!({"left": l, "bottom": b, "right": r, "top": t, "name": format!("R{i}"), "index": i, "weather": "0x00000000", "sound": "", "color": {"blue": 255, "green": 128, "red": 128, "alpha": 255}});
        let regions = json!({"format": "w3proj.regions/1", "version": 5, "regions": [region(0, 100.0, 100.0, 300.0, 300.0), region(1, 1100.0, 200.0, 1400.0, 500.0), region(2, 2200.0, 1200.0, 2600.0, 1700.0), region(3, 900.0, 900.0, 1300.0, 1300.0)]});
        for (name, v) in [("war3map.doo.json", doo), ("war3mapUnits.doo.json", units), ("war3map.w3r.json", regions)] {
            fs::write(dir.join("map").join(name), serde_json::to_vec_pretty(&v).unwrap()).unwrap();
        }
        let rects: Vec<tl::Rect> = ["a0:0,0,8,8", "a1:8,0,8,8", "a2:16,0,9,8", "b0:0,8,8,9", "b1:8,8,8,9", "b2:16,8,9,9"].iter().map(|r| r.parse().unwrap()).collect();
        tl::split_project(&dir, &rects).unwrap();
        dir
    }

    fn open(project: &Path, names: &[&str]) {
        fs::create_dir_all(project.join(".w3proj")).unwrap();
        fs::write(path(project), to_json(&names.iter().map(|s| s.to_string()).collect::<Vec<_>>())).unwrap();
    }

    fn map(project: &Path) -> PathBuf {
        project.join("map")
    }

    fn layout(project: &Path) -> Layout {
        Layout::parse(&fs::read(map(project).join("terrain").join("terrain.json")).unwrap()).unwrap()
    }

    /// Every file of a subterrain's folder: name → (bytes, last write).
    fn folder(project: &Path, sub: &str) -> BTreeMap<String, (Vec<u8>, std::time::SystemTime)> {
        let dir = map(project).join("terrain").join(sub);
        fs::read_dir(&dir).unwrap().flatten().map(|e| (e.file_name().to_string_lossy().into_owned(), (fs::read(e.path()).unwrap(), e.metadata().unwrap().modified().unwrap()))).collect()
    }

    fn json_of(bytes: &[u8]) -> Value {
        serde_json::from_slice(bytes).unwrap()
    }

    /// A list of a flat object file's entries as sorted texts (a partial load's order needn't be the written one).
    fn entries(bytes: &[u8], key: &str) -> Vec<String> {
        let mut v: Vec<String> = json_of(bytes)[key].as_array().unwrap().iter().map(|e| e.to_string()).collect();
        v.sort();
        v
    }

    #[test]
    fn the_mask_marks_open_halo_and_closed_corners() {
        let dir = project("mask");
        let l = layout(&dir);
        assert!(Partial::new(&l, &Choice::All).unwrap().is_none());
        let every: Vec<String> = l.subterrains.iter().map(|s| s.name.clone()).collect();
        assert!(Partial::new(&l, &Choice::Names(every)).unwrap().is_none(), "every subterrain named: everything open");
        let p = Partial::new(&l, &Choice::Names(vec!["a0".into()])).unwrap().unwrap();
        let at = |x: usize, y: usize| p.mask[y * W + x];
        assert_eq!((at(0, 0), at(7, 7)), (OPEN, OPEN));
        assert_eq!((at(8, 0), at(9, 7), at(0, 9), at(9, 9)), (HALO_CORNER, HALO_CORNER, HALO_CORNER, HALO_CORNER), "two corners into a1, b0 and b1");
        assert_eq!((at(10, 0), at(0, 10), at(10, 10), at(20, 15)), (CLOSED, CLOSED, CLOSED, CLOSED));
        assert_eq!(p.open, [true, false, false, false, false, false]);
        assert_eq!(p.halo, [false, true, false, true, true, false], "a1, b0, b1 give halo; a2 and b2 don't");
        assert_eq!(p.closed_count(), 5);
        assert_eq!(p.mask_text().len(), W * H);
        assert!(Partial::new(&l, &Choice::Names(vec!["nope".into()])).unwrap_err().to_string().contains("\"nope\""));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_partial_read_has_the_open_ones_whole_the_halo_and_defaults_elsewhere() {
        let dir = project("read");
        let full: BTreeMap<&str, Vec<u8>> = tl::FLAT_NAMES.iter().map(|n| (*n, tl::read_flat(&map(&dir), n).unwrap())).collect();
        open(&dir, &["a0"]);
        let l = layout(&dir);
        let p = of_map_dir(&map(&dir), &l).unwrap().unwrap();
        let t = w3e::terrain_from_text(&tl::read_flat(&map(&dir), tl::FLAT_FILE).unwrap()).unwrap();
        let whole = w3e::terrain_from_text(&full[tl::FLAT_FILE]).unwrap();
        for i in 0..W * H {
            match p.mask[i] {
                CLOSED => assert_eq!(t.corners[i], l.default_corner, "corner {i}"),
                _ => assert_eq!(t.corners[i], whole.corners[i], "corner {i}"),
            }
        }
        // Doodads: a0's (x, y < 1024) all, the halo's (< 1280) too, none further.
        let doo = json_of(&tl::read_flat(&map(&dir), "war3map.doo.json").unwrap());
        let xy: Vec<(f64, f64)> = doo["doodads"].as_array().unwrap().iter().map(|d| (d["position"][0].as_f64().unwrap(), d["position"][1].as_f64().unwrap())).collect();
        let want: Vec<(f64, f64)> = json_of(&full["war3map.doo.json"])["doodads"].as_array().unwrap().iter().map(|d| (d["position"][0].as_f64().unwrap(), d["position"][1].as_f64().unwrap())).filter(|(x, y)| *x < 1280.0 && *y < 1280.0).collect();
        let mut got = xy.clone();
        got.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut want = want;
        want.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(got, want);
        assert!(xy.iter().any(|(x, _)| *x >= 1024.0), "the halo's doodads are there");
        assert_eq!(doo["specials"].as_array().unwrap().len(), 1, "the special doodad lies in a0");
        // Regions: R0 (a0), R1 (a1, reaching into the halo), R3 (b1's corner (900, 900) lies in a0: a0's); not R2.
        let regions = json_of(&tl::read_flat(&map(&dir), "war3map.w3r.json").unwrap());
        let mut names: Vec<&str> = regions["regions"].as_array().unwrap().iter().map(|r| r["name"].as_str().unwrap()).collect();
        names.sort();
        assert_eq!(names, ["R0", "R1", "R3"]);
        let _ = fs::remove_dir_all(dir);
    }

    /// A closed subterrain beyond the halo is never opened: its files replaced by folders of the same name (reading one
    /// fails everywhere), every flat file still reads and writes, the derived files' sources leave it out. The control:
    /// with everything open the same project can't be read.
    #[test]
    fn closed_files_are_never_opened() {
        let dir = project("never");
        for sub in ["a2", "b2"] {
            for f in ["terrain.txt", "doodads.json", "units.json", "regions.json"] {
                let p = map(&dir).join("terrain").join(sub).join(f);
                fs::remove_file(&p).unwrap();
                fs::create_dir_all(p.join("x")).unwrap();
            }
        }
        assert!(tl::read_flat(&map(&dir), tl::FLAT_FILE).is_err(), "control: a full read opens them");
        open(&dir, &["a0"]);
        for n in tl::FLAT_NAMES {
            let bytes = tl::read_flat(&map(&dir), n).unwrap();
            tl::write_flat(&map(&dir), n, &bytes).unwrap();
        }
        let sources = crate::derived::sources_open(&dir).unwrap();
        assert_eq!(sources.get(crate::derived::CLOSED_KEY).map(String::as_str), Some("5"));
        assert!(!sources.keys().any(|k| k.contains("/a2/") || k.contains("/b2/")));
        // The pathing overrides too.
        assert!(tl::read_pathing(&dir).unwrap().is_none());
        let views = tl::flat_views(&map(&dir)).unwrap().unwrap();
        assert!(views.iter().all(|v| v.sources.iter().all(|s| !s.contains("/a2/") && !s.contains("/b2/"))), "{views:?}");
        let _ = fs::remove_dir_all(dir);
    }

    /// The write safety, by random edits of the flat files a partial load reads (fixed seed): an edit inside the open
    /// subterrain is saved, one touching the halo or the closed area (a corner, an object placed, moved, changed or
    /// removed there) is refused with nothing written; closed subterrains' files keep their bytes and times through all
    /// of it; at the end the whole map reads with every closed object as it was.
    #[test]
    fn random_edits_never_touch_closed_subterrains() {
        let dir = project("random");
        let initial: BTreeMap<&str, Vec<u8>> = tl::FLAT_NAMES.iter().map(|n| (*n, tl::read_flat(&map(&dir), n).unwrap())).collect();
        open(&dir, &["a1"]);
        let l = layout(&dir);
        let p = of_map_dir(&map(&dir), &l).unwrap().unwrap();
        let closed: Vec<&str> = ["a0", "a2", "b0", "b1", "b2"].to_vec();
        let before_closed: Vec<_> = closed.iter().map(|s| folder(&dir, s)).collect();
        let all_files = |d: &Path| crate::project::walk(&map(d).join("terrain")).unwrap().into_iter().map(|r| (r.clone(), fs::read(crate::paths::join_rel(&map(d).join("terrain"), &r)).unwrap())).collect::<BTreeMap<_, _>>();
        let mut seed: u64 = 0x005e_ed0f_0be0;
        println!("seed {seed:x}");
        let mut rnd = |n: usize| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as usize) % n.max(1)
        };
        let owner_open = |x: f64, y: f64| p.open[objects::owner(&l.subterrains, l.offset(), x, y)];
        let (mut saved, mut refused) = (0, 0);
        let mut next_number = 50_000u32;
        for round in 0..160 {
            let before = all_files(&dir);
            let op = rnd(5);
            let (name, bytes, ok) = if op == 0 {
                let text = tl::read_flat(&map(&dir), tl::FLAT_FILE).unwrap();
                let mut t = w3e::terrain_from_text(&text).unwrap();
                let i = rnd(W * H);
                t.corners[i].height = t.corners[i].height.wrapping_add(16 + rnd(100) as i16);
                (tl::FLAT_FILE, w3e::terrain_text(&t).unwrap(), p.mask[i] == OPEN)
            } else {
                let (name, key) = [("war3map.doo.json", "doodads"), ("war3mapUnits.doo.json", "units")][rnd(2)];
                let mut doc = json_of(&tl::read_flat(&map(&dir), name).unwrap());
                let list = doc[key].as_array_mut().unwrap();
                let ok = match op {
                    // Moved somewhere on the map.
                    1 if !list.is_empty() => {
                        let j = rnd(list.len());
                        let (ox, oy) = (list[j]["position"][0].as_f64().unwrap(), list[j]["position"][1].as_f64().unwrap());
                        let (x, y) = (rnd(3000) as f64 + 0.5, rnd(2000) as f64 + 0.5);
                        list[j]["position"] = json!([x, y, 0.0]);
                        owner_open(ox, oy) && owner_open(x, y)
                    }
                    // Removed.
                    2 if !list.is_empty() => {
                        let j = rnd(list.len());
                        let e = list.remove(j);
                        owner_open(e["position"][0].as_f64().unwrap(), e["position"][1].as_f64().unwrap())
                    }
                    // Changed in place.
                    3 if !list.is_empty() => {
                        let j = rnd(list.len());
                        list[j]["angle"] = json!(1.0 + rnd(5) as f64);
                        owner_open(list[j]["position"][0].as_f64().unwrap(), list[j]["position"][1].as_f64().unwrap())
                    }
                    // A new one with a number of its own.
                    _ => {
                        let mut e = list.first().cloned().unwrap_or_else(|| json!({}));
                        let (x, y) = (rnd(3000) as f64 + 0.5, rnd(2000) as f64 + 0.5);
                        e["position"] = json!([x, y, 0.0]);
                        e["editorId"] = json!(next_number);
                        next_number += 1;
                        list.push(e);
                        owner_open(x, y)
                    }
                };
                (name, serde_json::to_vec_pretty(&doc).unwrap(), ok)
            };
            let r = tl::write_flat(&map(&dir), name, &bytes);
            assert_eq!(r.is_ok(), ok, "round {round}, op {op}, {name}: {r:?}");
            if ok {
                saved += 1;
                let back = tl::read_flat(&map(&dir), name).unwrap();
                if name == tl::FLAT_FILE {
                    assert_eq!(back, bytes, "round {round}: the terrain reads back as written");
                } else {
                    let key = if name.contains("Units") { "units" } else { "doodads" };
                    assert_eq!(entries(&back, key), entries(&bytes, key), "round {round}: {name} reads back as written");
                }
                assert!(r.unwrap().iter().all(|w| w == tl::LAYOUT_FILE || w.starts_with("terrain/a1/")), "round {round}: only a1's files are written");
            } else {
                refused += 1;
                let e = r.unwrap_err().to_string();
                assert!(e.contains("nothing was written"), "round {round}: {e}");
                assert_eq!(all_files(&dir), before, "round {round}: a refused write changes nothing");
            }
            for (s, b) in closed.iter().zip(&before_closed) {
                assert_eq!(&folder(&dir, s), b, "round {round}: closed subterrain {s} changed");
            }
        }
        assert!(saved > 20 && refused > 20, "both outcomes ran: {saved} saved, {refused} refused");
        // Everything open again: the whole map reads, no number twice, the closed subterrains' objects as they were.
        fs::remove_file(path(&dir)).unwrap();
        for n in tl::FLAT_NAMES {
            tl::read_flat(&map(&dir), n).unwrap();
        }
        assert!(!crate::terrain_ids::check(&dir).unwrap().has_errors());
        let a1 = &l.subterrains[1];
        let outside = |e: &&Value| {
            let (x, y) = (e["position"][0].as_f64().unwrap(), e["position"][1].as_f64().unwrap());
            !(128.0 * a1.x as f64 <= x && x < 128.0 * (a1.x + a1.w) as f64 && y < 128.0 * (a1.y + a1.h) as f64)
        };
        for (name, key) in [("war3map.doo.json", "doodads"), ("war3mapUnits.doo.json", "units")] {
            let now = json_of(&tl::read_flat(&map(&dir), name).unwrap());
            let was = json_of(&initial[name]);
            let mut a: Vec<String> = now[key].as_array().unwrap().iter().filter(outside).map(Value::to_string).collect();
            let mut b: Vec<String> = was[key].as_array().unwrap().iter().filter(outside).map(Value::to_string).collect();
            a.sort();
            b.sort();
            assert_eq!(a, b, "{name}: the objects outside a1 are the ones there were");
        }
        let _ = fs::remove_dir_all(dir);
    }

    /// A partial load's own file unchanged writes nothing (byte for byte), and the terrain's palette may grow but not be
    /// reordered.
    #[test]
    fn unchanged_writes_nothing_and_palettes_only_grow() {
        let dir = project("palette");
        open(&dir, &["b1"]);
        for n in tl::FLAT_NAMES {
            let bytes = tl::read_flat(&map(&dir), n).unwrap();
            assert!(tl::write_flat(&map(&dir), n, &bytes).unwrap().is_empty(), "{n}");
        }
        let text = String::from_utf8(tl::read_flat(&map(&dir), tl::FLAT_FILE).unwrap()).unwrap();
        let grown = text.replace("ground Ldrt Lgrs Lrok", "ground Ldrt Lgrs Lrok Lgrd");
        assert_eq!(tl::write_flat(&map(&dir), tl::FLAT_FILE, grown.as_bytes()).unwrap(), [tl::LAYOUT_FILE.to_string()]);
        let swapped = grown.replace("ground Ldrt Lgrs Lrok Lgrd", "ground Lgrs Ldrt Lrok Lgrd");
        assert!(tl::write_flat(&map(&dir), tl::FLAT_FILE, swapped.as_bytes()).unwrap_err().to_string().contains("tile lists"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn pathing_overrides_outside_the_open_subterrains_are_read_only() {
        use crate::terrain_pathing as tp;
        let dir = project("pathing");
        // Overrides in a0 (open) and b0 (halo: its cell row 32 lies in the strip) and b2 (closed), written whole first.
        let corners = [W, H];
        let cells = vec![tp::Cell { x: 4, y: 4, mask: 2, value: 2 }, tp::Cell { x: 4, y: 33, mask: 2, value: 2 }, tp::Cell { x: 80, y: 50, mask: 8, value: 0 }];
        tl::write_pathing(&dir, &tp::json_text(corners, &cells)).unwrap();
        let b2 = folder(&dir, "b2");
        open(&dir, &["a0"]);
        let json = tl::read_pathing(&dir).unwrap().unwrap();
        assert_eq!(tp::parse_json(&json, corners).unwrap(), cells[..2], "a0's and the halo's, not b2's");
        // A new override in a0: only a0's file; one in the halo: refused.
        let more = [cells[0], cells[1], tp::Cell { x: 6, y: 6, mask: 2, value: 0 }];
        let (written, _) = tl::write_pathing(&dir, &tp::json_text(corners, &more)).unwrap();
        assert_eq!(written, ["terrain/a0/pathing.txt"]);
        let halo_edit = [cells[0], tp::Cell { x: 4, y: 33, mask: 2, value: 0 }];
        assert!(tl::write_pathing(&dir, &tp::json_text(corners, &halo_edit)).unwrap_err().to_string().contains("outside the open subterrains"));
        // Deleting removes a0's file only.
        assert_eq!(tl::delete_pathing(&dir).unwrap(), ["terrain/a0/pathing.txt"]);
        assert_eq!(folder(&dir, "b2"), b2);
        assert!(map(&dir).join("terrain").join("b0").join("pathing.txt").is_file());
        let _ = fs::remove_dir_all(dir);
    }

    /// A choice that can't be read (damaged, unknown keys, nothing open, a name twice or one the layout doesn't have) is
    /// an error naming the file when the terrain is read, never a guess; the file list still has the flat names; storing
    /// refuses bad names, removes the file for "all" and makes .gitignore ignore it otherwise.
    #[test]
    fn a_damaged_choice_is_an_error() {
        let dir = project("damaged");
        let l = layout(&dir);
        fs::create_dir_all(dir.join(".w3proj")).unwrap();
        for (text, why) in [
            (&b"{ not json"[..], "isn't JSON"),
            (br#"{"format": "w3proj.open-subterrains/1", "open": ["a0"], "x": 1}"#, "unknown key"),
            (br#"{"format": "w3proj.open-subterrains/2", "open": ["a0"]}"#, "format"),
            (br#"{"format": "w3proj.open-subterrains/1", "open": []}"#, "opens no subterrain"),
            (br#"{"format": "w3proj.open-subterrains/1", "open": ["a0", "a0"]}"#, "twice"),
            (br#"{"format": "w3proj.open-subterrains/1", "open": ["zz"]}"#, "\"zz\""),
            (br#"{"format": "w3proj.open-subterrains/1", "open": ["a0"], "open": ["b0"]}"#, "twice"),
        ] {
            fs::write(path(&dir), text).unwrap();
            let e = tl::read_flat(&map(&dir), tl::FLAT_FILE).unwrap_err().to_string();
            assert!(e.contains(NAME) && e.contains(why), "{why}: {e}");
            assert!(tl::write_flat(&map(&dir), tl::FLAT_FILE, b"").is_err());
            assert_eq!(tl::flat_views(&map(&dir)).unwrap().unwrap().len(), 4, "the flat names are still listed");
            let s = state(&dir).unwrap().unwrap();
            assert!(s.error.is_some() && s.subterrains.len() == 6 && !s.partial, "{why}");
        }
        assert!(store(&dir, &l, &[]).is_err());
        assert!(store(&dir, &l, &["zz".into()]).unwrap_err().to_string().contains("\"zz\""));
        store(&dir, &l, &["b1".into(), "a0".into()]).unwrap();
        assert_eq!(parse(&fs::read(path(&dir)).unwrap()).unwrap(), ["a0", "b1"], "in terrain.json's order");
        assert!(fs::read_to_string(dir.join(".gitignore")).unwrap().lines().any(|l| l == IGNORED));
        let s = state(&dir).unwrap().unwrap();
        assert!(s.partial && s.error.is_none() && s.mask.len() == W * H);
        assert_eq!(s.subterrains.iter().filter(|s| s.open).map(|s| s.name.as_str()).collect::<Vec<_>>(), ["a0", "b1"]);
        let every: Vec<String> = l.subterrains.iter().map(|s| s.name.clone()).collect();
        store(&dir, &l, &every).unwrap();
        assert!(!path(&dir).exists(), "all open: the file goes");
        assert!(!state(&dir).unwrap().unwrap().partial);
        let _ = fs::remove_dir_all(dir);
    }

    /// The derived files' record of a save made with subterrains closed says so: `check` takes them for stale (pack
    /// refuses), whatever the sources are; a record made with everything open is fresh again.
    #[test]
    fn a_partial_record_is_never_fresh() {
        let dir = project("derived");
        open(&dir, &["a0", "b0"]);
        crate::derived::record(&dir, &crate::derived::sources_open(&dir).unwrap()).unwrap();
        assert_eq!(crate::derived::check(&dir).unwrap(), crate::derived::Freshness::Partial(4));
        assert!(crate::derived::Freshness::partial_text(4).contains("4 subterrains were closed"));
        fs::remove_file(path(&dir)).unwrap();
        crate::derived::record(&dir, &crate::derived::sources_open(&dir).unwrap()).unwrap();
        assert_eq!(crate::derived::check(&dir).unwrap(), crate::derived::Freshness::Fresh);
        let _ = fs::remove_dir_all(dir);
    }
}
