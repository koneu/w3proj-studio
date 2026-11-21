//! The split terrain layout `map/terrain/`: the map's ground in named rectangles (subterrains), so
//! people working on different parts of a large map edit different files.
//!
//! ```text
//! map/terrain/terrain.json        canvas, palettes, the corner uncovered corners get, the subterrains
//! map/terrain/<folder>/terrain.txt   one subterrain's corners, in the grid text of war3map.w3e.txt
//! ```
//!
//! The flat `map/war3map.w3e.txt` stays the default; a project has one layout or the other. Reading
//! assembles the subterrains into one whole terrain (`flatten`, used by `project::read_project`, so
//! packing sees `war3map.w3e.txt` either way); writing slices a whole terrain back into the
//! project's rectangles (`slice`), and only files whose bytes changed are written (`write_changed`).
//! Every slice is assembled again in memory and compared before anything is written: a terrain that
//! can't come back byte for byte is refused, never stored.
//!
//! A subterrain owns corners `x <= cx < x + w`, `y <= cy < y + h` (row 0 is the south row, as in
//! war3map.w3e); rectangles don't overlap, and a corner no rectangle covers gets `defaultCorner`. So
//! a corner is left out of the files only where it equals `defaultCorner`; a slice that would have to
//! drop another one is refused.
//!
//! Placed objects (war3map.doo, war3mapUnits.doo) and regions (war3map.w3r) are not split here yet:
//! they stay in their flat files. `dooHeader` is read and kept when present, not made.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde_json::{Map, Value};

use crate::w3e::{self, Corner, Terrain};
use crate::{Error, Result};

pub const FORMAT: &str = "w3proj.terrain/1";
/// The layout's folder under `map/`.
pub const DIR: &str = "terrain";
/// The layout file, relative to `map/`.
pub const LAYOUT_FILE: &str = "terrain/terrain.json";
/// A subterrain's ground, in its folder.
pub const GROUND_FILE: &str = "terrain.txt";
/// The flat layout's terrain, relative to `map/`.
pub const FLAT_FILE: &str = "war3map.w3e.txt";
/// The flat terrain kept raw (its text form couldn't be read when it was unpacked).
const FLAT_RAW: &str = "war3map.w3e";

fn bad(m: impl Into<String>) -> Error {
    Error::Format(format!("map/{LAYOUT_FILE}: {}", m.into()))
}

/// One named rectangle of the canvas, in corners.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subterrain {
    pub name: String,
    pub folder: String,
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
    /// The creation numbers new objects in it get (`[min, max]`); never checked against existing ones.
    pub id_range: [u32; 2],
}

impl Subterrain {
    /// Its ground file, relative to `map/`.
    pub fn ground_path(&self) -> String {
        format!("{DIR}/{}/{GROUND_FILE}", self.folder)
    }
}

/// The placed objects' file headers (`war3map.doo`, `war3mapUnits.doo`) once objects live in the
/// subterrains (not made by this version, kept when there).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DooHeader {
    pub doodads_version: u32,
    pub doodads_subversion: u32,
    pub units_version: u32,
    pub units_subversion: u32,
    pub skin_ids: bool,
}

/// `terrain.json`: the whole terrain's header (its corners left empty), the default corner, the
/// subterrains.
#[derive(Clone)]
pub struct Layout {
    head: Terrain,
    default_corner: Corner,
    pub doo_header: Option<DooHeader>,
    pub subterrains: Vec<Subterrain>,
}

/// A rectangle asked for by a split (`name:x,y,w,h`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rect {
    pub name: String,
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
}

impl std::str::FromStr for Rect {
    type Err = String;
    fn from_str(s: &str) -> std::result::Result<Rect, String> {
        let (name, nums) = s.rsplit_once(':').ok_or_else(|| format!("\"{s}\" isn't name:x,y,w,h"))?;
        let n: Vec<usize> = nums
            .split(',')
            .map(|v| v.trim().parse::<usize>())
            .collect::<std::result::Result<_, _>>()
            .map_err(|_| format!("\"{s}\" isn't name:x,y,w,h (whole numbers of corners)"))?;
        let [x, y, w, h] = n[..] else { return Err(format!("\"{s}\" isn't name:x,y,w,h")) };
        Ok(Rect { name: name.to_string(), x, y, w, h })
    }
}

/// A folder name that is one plain folder on every system: not empty, not `.` or `..`, no path
/// separator or other character Windows refuses, no trailing dot or space, no device name, not the
/// layout file's name.
pub fn check_folder(name: &str) -> std::result::Result<(), String> {
    const RESERVED: &[&str] = &["con", "prn", "aux", "nul"];
    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    let device = RESERVED.contains(&stem.as_str())
        || ((stem.starts_with("com") || stem.starts_with("lpt")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    if name.is_empty() {
        Err("a folder name can't be empty".into())
    } else if name == "." || name == ".." {
        Err(format!("\"{name}\" isn't a folder name"))
    } else if let Some(c) = name.chars().find(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control()) {
        Err(format!("folder \"{name}\" holds {c:?}, which isn't allowed in a folder name"))
    } else if name.ends_with('.') || name.ends_with(' ') || name.starts_with(' ') {
        Err(format!("folder \"{name}\" starts with a space or ends with a dot or space"))
    } else if device {
        Err(format!("folder \"{name}\" is a device name on Windows"))
    } else if name.eq_ignore_ascii_case("terrain.json") {
        Err("a subterrain's folder can't be named terrain.json".into())
    } else {
        Ok(())
    }
}

// ---- terrain.json ----

fn object<'a>(v: &'a Value, what: &str, keys: &[&str], optional: &[&str]) -> Result<&'a Map<String, Value>> {
    let o = v.as_object().ok_or_else(|| bad(format!("{what} isn't an object")))?;
    if let Some(k) = o.keys().find(|k| !keys.contains(&k.as_str()) && !optional.contains(&k.as_str())) {
        return Err(bad(format!("{what} has an unknown key \"{k}\"")));
    }
    if let Some(k) = keys.iter().find(|k| !o.contains_key(**k)) {
        return Err(bad(format!("{what} lacks \"{k}\"")));
    }
    Ok(o)
}

fn uint(v: &Value, what: &str, max: u64) -> Result<u64> {
    v.as_u64().filter(|&n| n <= max).ok_or_else(|| bad(format!("{what} isn't a whole number from 0 to {max}")))
}

fn pair<'a>(v: &'a Value, what: &str) -> Result<[&'a Value; 2]> {
    match v.as_array().map(Vec::as_slice) {
        Some([a, b]) => Ok([a, b]),
        _ => Err(bad(format!("{what} isn't a list of two"))),
    }
}

fn ids(v: &Value, what: &str) -> Result<Vec<[u8; 4]>> {
    v.as_array()
        .ok_or_else(|| bad(format!("{what} isn't a list")))?
        .iter()
        .map(|id| id.as_str().ok_or_else(|| bad(format!("{what} holds something other than a tile id"))).and_then(|s| w3e::id_parse(s).map_err(|e| bad(format!("{what}: {e}")))))
        .collect()
}

fn offset(v: &Value) -> Result<f32> {
    let text = match v {
        Value::Number(n) if n.is_i64() => n.to_string(),
        Value::String(s) if s.starts_with("bits:") => s.clone(),
        _ => return Err(bad("offset holds something other than a whole number or \"bits:XXXXXXXX\"")),
    };
    w3e::parse_float(&text).map_err(|e| bad(e.to_string()))
}

fn json_float(v: f32) -> String {
    let t = w3e::float_text(v);
    if t.starts_with("bits:") {
        format!("\"{t}\"")
    } else {
        t
    }
}

fn hex(s: &str) -> Result<Vec<u8>> {
    if !s.len().is_multiple_of(2) || !s.is_ascii() {
        return Err(bad("trailer isn't hex"));
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| bad("trailer isn't hex"))).collect()
}

const TOP: &[&str] = &["format", "tileset", "customTilesets", "ground", "cliffs", "corners", "offset", "w3eVersion", "trailer", "defaultCorner", "subterrains"];
const SUB: &[&str] = &["name", "folder", "x", "y", "w", "h", "idRange"];
const DOO: &[&str] = &["doodadsVersion", "doodadsSubversion", "unitsVersion", "unitsSubversion", "skinIds"];

impl Layout {
    /// Reads and checks `terrain.json` (`check`).
    pub fn parse(bytes: &[u8]) -> Result<Layout> {
        let doc: Value = serde_json::from_slice(bytes).map_err(|e| bad(format!("isn't JSON: {e}")))?;
        let o = object(&doc, "the file", TOP, &["dooHeader"])?;
        if o["format"].as_str() != Some(FORMAT) {
            return Err(bad(format!("format isn't \"{FORMAT}\"")));
        }
        let version = uint(&o["w3eVersion"], "w3eVersion", u32::MAX as u64)? as u32;
        if version != 11 && version != 12 {
            return Err(bad(format!("w3eVersion {version} isn't 11 or 12")));
        }
        let tileset = match o["tileset"].as_str().map(str::as_bytes) {
            Some([c]) if c.is_ascii_graphic() => *c,
            _ => return Err(bad("tileset isn't one printable character")),
        };
        let custom_tilesets = uint(&o["customTilesets"], "customTilesets", u32::MAX as u64)? as u32;
        let [w, h] = pair(&o["corners"], "corners")?;
        let (width, height) = (uint(w, "corners", u32::MAX as u64)? as usize, uint(h, "corners", u32::MAX as u64)? as usize);
        let [ox, oy] = pair(&o["offset"], "offset")?;
        let trailer = hex(o["trailer"].as_str().ok_or_else(|| bad("trailer isn't a string"))?)?;
        let head = Terrain {
            version,
            tileset,
            custom_tilesets,
            ground: ids(&o["ground"], "ground")?,
            cliffs: ids(&o["cliffs"], "cliffs")?,
            width,
            height,
            offset: [offset(ox)?, offset(oy)?],
            corners: Vec::new(),
            trailer,
        };
        let names: Vec<&str> = w3e::FIELD_NAMES.iter().map(|(_, j)| *j).collect();
        let dc = object(&o["defaultCorner"], "defaultCorner", &names, &[])?;
        let mut default_corner = Corner::default();
        for (section, key) in w3e::FIELD_NAMES {
            let v = dc[*key].as_i64().ok_or_else(|| bad(format!("defaultCorner.{key} isn't a whole number")))?;
            w3e::field_set(&mut default_corner, section, v).map_err(|e| bad(format!("defaultCorner.{key}: {e}")))?;
        }
        let doo_header = match o.get("dooHeader") {
            None => None,
            Some(v) => {
                let d = object(v, "dooHeader", DOO, &[])?;
                let n = |k: &str| uint(&d[k], &format!("dooHeader.{k}"), u32::MAX as u64).map(|v| v as u32);
                Some(DooHeader {
                    doodads_version: n("doodadsVersion")?,
                    doodads_subversion: n("doodadsSubversion")?,
                    units_version: n("unitsVersion")?,
                    units_subversion: n("unitsSubversion")?,
                    skin_ids: d["skinIds"].as_bool().ok_or_else(|| bad("dooHeader.skinIds isn't true or false"))?,
                })
            }
        };
        let list = o["subterrains"].as_array().ok_or_else(|| bad("subterrains isn't a list"))?;
        let mut subterrains = Vec::with_capacity(list.len().min(1024));
        for (i, s) in list.iter().enumerate() {
            let what = format!("subterrains[{i}]");
            let s = object(s, &what, SUB, &[])?;
            let text = |k: &str| s[k].as_str().map(str::to_string).ok_or_else(|| bad(format!("{what}.{k} isn't a string")));
            let num = |k: &str| uint(&s[k], &format!("{what}.{k}"), u32::MAX as u64).map(|v| v as usize);
            let [lo, hi] = pair(&s["idRange"], &format!("{what}.idRange"))?;
            let id = |v: &Value| uint(v, &format!("{what}.idRange"), u32::MAX as u64).map(|v| v as u32);
            subterrains.push(Subterrain {
                name: text("name")?,
                folder: text("folder")?,
                x: num("x")?,
                y: num("y")?,
                w: num("w")?,
                h: num("h")?,
                id_range: [id(lo)?, id(hi)?],
            });
        }
        let layout = Layout { head, default_corner, doo_header, subterrains };
        layout.check()?;
        Ok(layout)
    }

    /// What loading checks: the canvas isn't too large, the default corner fits the version, there
    /// is at least one subterrain, names and folders are unique (folders also ignoring case) and
    /// safe, rectangles lie within the canvas and don't overlap, id ranges don't overlap.
    pub fn check(&self) -> Result<()> {
        let (width, height) = (self.head.width, self.head.height);
        let n = width.checked_mul(height).filter(|&n| n <= w3e::MAX_CORNERS).ok_or_else(|| bad("the canvas is too large"))?;
        if self.head.version == 11 && (self.default_corner.texture > 15 || self.default_corner.texture_bits != 0) {
            return Err(bad("defaultCorner: version 11 holds textures 0–15 and no texture bits"));
        }
        if self.subterrains.is_empty() {
            return Err(bad("there is no subterrain"));
        }
        let (mut names, mut folders) = (HashSet::new(), HashSet::new());
        for s in &self.subterrains {
            if s.name.trim().is_empty() {
                return Err(bad("a subterrain's name is empty"));
            }
            if !names.insert(s.name.as_str()) {
                return Err(bad(format!("two subterrains are named \"{}\"", s.name)));
            }
            check_folder(&s.folder).map_err(|e| bad(format!("subterrain \"{}\": {e}", s.name)))?;
            if !folders.insert(s.folder.to_lowercase()) {
                return Err(bad(format!("two subterrains use folder \"{}\" (folder names are compared ignoring case)", s.folder)));
            }
            if s.w == 0 || s.h == 0 {
                return Err(bad(format!("subterrain \"{}\" is empty ({}×{} corners)", s.name, s.w, s.h)));
            }
            if s.x.checked_add(s.w).is_none_or(|r| r > width) || s.y.checked_add(s.h).is_none_or(|t| t > height) {
                return Err(bad(format!("subterrain \"{}\" ({},{} {}×{}) reaches past the canvas of {width}×{height} corners", s.name, s.x, s.y, s.w, s.h)));
            }
            if s.id_range[0] > s.id_range[1] {
                return Err(bad(format!("subterrain \"{}\": idRange starts after it ends", s.name)));
            }
        }
        // Painted one by one: the first corner painted twice is an overlap, so this never paints more
        // than the canvas.
        let mut owner = vec![u32::MAX; n];
        for (i, s) in self.subterrains.iter().enumerate() {
            for y in s.y..s.y + s.h {
                for o in &mut owner[y * width + s.x..y * width + s.x + s.w] {
                    if *o != u32::MAX {
                        let other = &self.subterrains[*o as usize].name;
                        return Err(bad(format!("subterrains \"{other}\" and \"{}\" overlap", s.name)));
                    }
                    *o = i as u32;
                }
            }
        }
        let mut ranges: Vec<&Subterrain> = self.subterrains.iter().collect();
        ranges.sort_by_key(|s| s.id_range);
        for p in ranges.windows(2) {
            if p[1].id_range[0] <= p[0].id_range[1] {
                return Err(bad(format!("the idRanges of \"{}\" and \"{}\" overlap", p[0].name, p[1].name)));
            }
        }
        Ok(())
    }

    /// The canvas in corners.
    pub fn corners(&self) -> [usize; 2] {
        [self.head.width, self.head.height]
    }

    /// `terrain.json` as written to disk (keys in a fixed order, short lists on one line).
    pub fn to_json(&self) -> Result<Vec<u8>> {
        let q = |s: &str| serde_json::to_string(s).expect("a string serializes");
        let list = |l: &[[u8; 4]]| -> Result<String> { Ok(l.iter().map(|id| w3e::id_text(id).map(|t| q(&t))).collect::<Result<Vec<_>>>()?.join(", ")) };
        let t = &self.head;
        let mut s = String::from("{\n");
        s += &format!("  \"format\": {},\n", q(FORMAT));
        s += &format!("  \"tileset\": {},\n", q(&(t.tileset as char).to_string()));
        s += &format!("  \"customTilesets\": {},\n", t.custom_tilesets);
        s += &format!("  \"ground\": [{}],\n", list(&t.ground)?);
        s += &format!("  \"cliffs\": [{}],\n", list(&t.cliffs)?);
        s += &format!("  \"corners\": [{}, {}],\n", t.width, t.height);
        s += &format!("  \"offset\": [{}, {}],\n", json_float(t.offset[0]), json_float(t.offset[1]));
        s += &format!("  \"w3eVersion\": {},\n", t.version);
        s += &format!("  \"trailer\": \"{}\",\n", t.trailer.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let fields: Vec<String> = w3e::FIELD_NAMES
            .iter()
            .map(|(section, key)| format!("    \"{key}\": {}", w3e::field_get(&self.default_corner, section).unwrap_or(0)))
            .collect();
        s += &format!("  \"defaultCorner\": {{\n{}\n  }},\n", fields.join(",\n"));
        if let Some(d) = &self.doo_header {
            s += &format!(
                "  \"dooHeader\": {{\n    \"doodadsVersion\": {},\n    \"doodadsSubversion\": {},\n    \"unitsVersion\": {},\n    \"unitsSubversion\": {},\n    \"skinIds\": {}\n  }},\n",
                d.doodads_version, d.doodads_subversion, d.units_version, d.units_subversion, d.skin_ids
            );
        }
        let subs: Vec<String> = self
            .subterrains
            .iter()
            .map(|st| {
                format!(
                    "    {{\n      \"name\": {},\n      \"folder\": {},\n      \"x\": {},\n      \"y\": {},\n      \"w\": {},\n      \"h\": {},\n      \"idRange\": [{}, {}]\n    }}",
                    q(&st.name),
                    q(&st.folder),
                    st.x,
                    st.y,
                    st.w,
                    st.h,
                    st.id_range[0],
                    st.id_range[1]
                )
            })
            .collect();
        s += &format!("  \"subterrains\": [\n{}\n  ]\n}}\n", subs.join(",\n"));
        Ok(s.into_bytes())
    }
}

// ---- terrain.txt ----

/// A subterrain's ground file: `corners w h`, then the grid sections of war3map.w3e.txt.
fn ground_text(corners: &[Corner], w: usize, h: usize, version: u32) -> Vec<u8> {
    let mut s = format!("corners {w} {h}\n");
    w3e::write_grids(&mut s, corners, w, version);
    s.into_bytes()
}

fn parse_ground(path: &str, bytes: &[u8], w: usize, h: usize, version: u32) -> Result<Vec<Corner>> {
    let what = format!("map/{path}");
    let text = std::str::from_utf8(bytes).map_err(|_| Error::Format(format!("{what}: not UTF-8")))?;
    let mut lines = w3e::text_lines(text);
    let mut size = None;
    while let Some(l) = lines.next_if(|l| !l.starts_with('[')) {
        let (k, v) = l.split_once(' ').unwrap_or((l, ""));
        if k != "corners" || size.is_some() {
            return Err(Error::Format(format!("{what}: expected one \"corners <w> <h>\" line before the grids, found \"{l}\"")));
        }
        let n: Vec<usize> = v.split_whitespace().filter_map(|n| n.parse().ok()).collect();
        size = Some(n);
    }
    if size.as_deref() != Some(&[w, h][..]) {
        return Err(Error::Format(format!("{what}: its \"corners\" line isn't the subterrain's size in terrain.json, {w} {h}")));
    }
    let (corners, _) = w3e::read_grids(&what, &mut lines, w, h, version, false)?;
    Ok(corners)
}

// ---- assemble and slice ----

/// The whole terrain from a layout and its subterrains' ground files (`ground`: path relative to
/// `map/` → bytes). A subterrain without its file is an error.
fn assemble_terrain(layout: &Layout, ground: &dyn Fn(&str) -> Option<Vec<u8>>) -> Result<Terrain> {
    let mut t = layout.head.clone();
    t.corners = vec![layout.default_corner; t.width * t.height];
    for s in &layout.subterrains {
        let path = s.ground_path();
        let bytes = ground(&path).ok_or_else(|| Error::Format(format!("map/{path} is missing: subterrain \"{}\" has no ground file", s.name)))?;
        let corners = parse_ground(&path, &bytes, s.w, s.h, t.version)?;
        for row in 0..s.h {
            let at = (s.y + row) * t.width + s.x;
            t.corners[at..at + s.w].copy_from_slice(&corners[row * s.w..(row + 1) * s.w]);
        }
    }
    Ok(t)
}

/// The files of a layout (relative to `map/`) holding the whole terrain `t`: `terrain.json` with
/// `t`'s header and the given subterrains, default corner and objects' header, and each
/// subterrain's ground. A corner outside every subterrain that isn't `default_corner` can't be
/// stored: an error. The result is assembled again and compared with `t` before it is returned.
fn slice_terrain(t: &Terrain, subterrains: Vec<Subterrain>, default_corner: Corner, doo_header: Option<DooHeader>) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut head = t.clone();
    head.corners = Vec::new();
    let layout = Layout { head, default_corner, doo_header, subterrains };
    layout.check()?;
    let mut covered = vec![false; t.width * t.height];
    let mut files = BTreeMap::new();
    for s in &layout.subterrains {
        let mut corners = Vec::with_capacity(s.w * s.h);
        for row in 0..s.h {
            let at = (s.y + row) * t.width + s.x;
            corners.extend_from_slice(&t.corners[at..at + s.w]);
            covered[at..at + s.w].iter_mut().for_each(|c| *c = true);
        }
        files.insert(s.ground_path(), ground_text(&corners, s.w, s.h, t.version));
    }
    if let Some(i) = (0..covered.len()).find(|&i| !covered[i] && t.corners[i] != default_corner) {
        return Err(Error::Format(format!(
            "corner {},{} lies in no subterrain and differs from defaultCorner: it would be lost (make the subterrains cover it)",
            i % t.width,
            i / t.width
        )));
    }
    files.insert(LAYOUT_FILE.to_string(), layout.to_json()?);
    // Never store what can't be read back as it was.
    let again = assemble_terrain(&Layout::parse(&files[LAYOUT_FILE])?, &|p| files.get(p).cloned())?;
    if w3e::write(&again) != w3e::write(t) {
        return Err(Error::Format("the subterrains don't assemble into the same terrain again (nothing was written)".into()));
    }
    Ok(files)
}

/// The corner most corners are (the first such in corner order on a tie).
fn most_common(corners: &[Corner]) -> Corner {
    let mut count: HashMap<Corner, usize> = HashMap::new();
    for c in corners {
        *count.entry(*c).or_default() += 1;
    }
    let max = count.values().copied().max().unwrap_or(0);
    corners.iter().copied().find(|c| count[c] == max).unwrap_or_default()
}

/// New layout files for the whole terrain `t`, cut into `rects` (none: one subterrain `main` over
/// the whole canvas). Subterrain i gets idRange `[(i + 1) · 10000, (i + 1) · 10000 + 9999]`. The
/// default corner is the one every uncovered corner holds (they must all be alike), or with no
/// uncovered corner the most common one.
fn split_terrain(t: &Terrain, rects: &[Rect]) -> Result<BTreeMap<String, Vec<u8>>> {
    let whole = [Rect { name: "main".into(), x: 0, y: 0, w: t.width, h: t.height }];
    let rects = if rects.is_empty() { &whole[..] } else { rects };
    let mut subterrains = Vec::with_capacity(rects.len());
    for (i, r) in rects.iter().enumerate() {
        let lo = u32::try_from(i + 1).ok().and_then(|n| n.checked_mul(10000)).ok_or_else(|| Error::Format("too many subterrains".into()))?;
        let hi = lo.checked_add(9999).ok_or_else(|| Error::Format("too many subterrains".into()))?;
        subterrains.push(Subterrain { name: r.name.clone(), folder: r.name.clone(), x: r.x, y: r.y, w: r.w, h: r.h, id_range: [lo, hi] });
    }
    let mut covered = vec![false; t.width * t.height];
    for s in &subterrains {
        for y in s.y..(s.y + s.h).min(t.height) {
            for x in s.x..(s.x + s.w).min(t.width) {
                covered[y * t.width + x] = true;
            }
        }
    }
    let uncovered: Vec<Corner> = (0..covered.len()).filter(|&i| !covered[i]).map(|i| t.corners[i]).collect();
    let default_corner = match uncovered.first() {
        Some(first) => *first,
        None => most_common(&t.corners),
    };
    slice_terrain(t, subterrains, default_corner, None)
}

/// A 2×2 grid over the canvas (`sw`, `se`, `nw`, `ne`); a canvas narrower or lower than 2 corners
/// gets fewer.
pub fn grid_2x2(width: usize, height: usize) -> Vec<Rect> {
    let xs: Vec<(usize, usize, &str)> = if width >= 2 { vec![(0, width / 2, "w"), (width / 2, width - width / 2, "e")] } else { vec![(0, width, "w")] };
    let ys: Vec<(usize, usize, &str)> = if height >= 2 { vec![(0, height / 2, "s"), (height / 2, height - height / 2, "n")] } else { vec![(0, height, "s")] };
    let mut out = Vec::new();
    for (y, h, ny) in &ys {
        for (x, w, nx) in &xs {
            out.push(Rect { name: format!("{ny}{nx}"), x: *x, y: *y, w: *w, h: *h });
        }
    }
    out
}

// ---- project files ----

fn key<'a>(files: &'a BTreeMap<String, Vec<u8>>, name: &str) -> Option<&'a String> {
    files.keys().find(|k| k.eq_ignore_ascii_case(name))
}

fn under_dir(path: &str) -> bool {
    path.len() > DIR.len() && path.as_bytes()[DIR.len()] == b'/' && path[..DIR.len()].eq_ignore_ascii_case(DIR)
}

/// Which layout a project has, from its `terrain.json` (if there) and whether a flat terrain file
/// is there. Without a flat file, a `terrain.json` makes it the split layout, whatever it holds (one
/// that can't be read is then an error when it is read, never a map without terrain). Next to a flat
/// terrain, a `terrain.json` of this format is an error (both layouts), any other a file of the
/// map's own (an import).
fn decide(layout_file: Option<&[u8]>, flat: bool) -> Result<bool> {
    let Some(bytes) = layout_file else { return Ok(false) };
    if !flat {
        return Ok(true);
    }
    let format = serde_json::from_slice::<Value>(bytes).ok().and_then(|v| v.get("format").and_then(Value::as_str).map(str::to_string));
    if format.is_some_and(|f| f.starts_with("w3proj.terrain/")) {
        return Err(Error::Project(format!(
            "the project has both terrain layouts, map/{FLAT_FILE} (or {FLAT_RAW}) and map/{LAYOUT_FILE}: keep one (`w3proj terrain merge` or `split` makes one from the other)"
        )));
    }
    Ok(false)
}

/// Whether the project files (relative to `map/`) are in the split layout (`decide`).
pub fn is_split(files: &BTreeMap<String, Vec<u8>>) -> Result<bool> {
    let flat = key(files, FLAT_FILE).is_some() || key(files, FLAT_RAW).is_some();
    decide(files.get(LAYOUT_FILE).map(Vec::as_slice), flat)
}

/// Whether the project whose `map/` folder this is has the split layout (`decide`). A layout file
/// that is there but can't be read is an error.
pub fn is_split_on_disk(map_dir: &Path) -> Result<bool> {
    let bytes = match fs::read(map_dir.join(LAYOUT_FILE)) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(Error::Project(format!("map/{LAYOUT_FILE} can't be read: {e}"))),
    };
    let mut flat = false;
    for name in [FLAT_FILE, FLAT_RAW] {
        flat |= map_dir.join(name).try_exists().map_err(|e| Error::Project(format!("map/{name} can't be checked: {e}")))?;
    }
    decide(Some(&bytes), flat)
}

/// The whole terrain (war3map.w3e bytes) of split-layout project files.
pub fn assemble(files: &BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>> {
    let bytes = files.get(LAYOUT_FILE).ok_or_else(|| Error::Project(format!("map/{LAYOUT_FILE} is missing")))?;
    let layout = Layout::parse(bytes)?;
    Ok(w3e::write(&assemble_terrain(&layout, &|p| files.get(p).cloned())?))
}

/// Project files (relative to `map/`) in the split layout become those of the flat one: the layout's
/// files go and `war3map.w3e.txt` holds the assembled terrain. Files of the flat layout stay as they
/// are. Another file under `terrain/` is an error (this version keeps nothing else there). Returns
/// whether the files were in the split layout.
pub fn flatten(files: &mut BTreeMap<String, Vec<u8>>) -> Result<bool> {
    if !is_split(files)? {
        return Ok(false);
    }
    let layout = Layout::parse(&files[LAYOUT_FILE])?;
    let t = assemble_terrain(&layout, &|p| files.get(p).cloned())?;
    let mut ours: HashSet<String> = layout.subterrains.iter().map(Subterrain::ground_path).collect();
    ours.insert(LAYOUT_FILE.to_string());
    if let Some(other) = files.keys().find(|k| under_dir(k) && !ours.contains(*k)) {
        return Err(Error::Project(format!(
            "map/{other} isn't part of the terrain layout (map/{DIR}/ holds terrain.json and each subterrain's {GROUND_FILE} only)"
        )));
    }
    files.retain(|k, _| !ours.contains(k));
    files.insert(FLAT_FILE.to_string(), w3e::terrain_text(&t)?);
    Ok(true)
}

/// Cuts the flat project files' terrain (`war3map.w3e.txt`) into a new split layout: `rects`, or one
/// subterrain `main` over the whole canvas. The files of the layout replace the flat file.
pub fn split(files: &mut BTreeMap<String, Vec<u8>>, rects: &[Rect]) -> Result<()> {
    if is_split(files)? {
        return Err(Error::Project("the terrain is split already".into()));
    }
    if let Some(k) = files.keys().find(|k| under_dir(k)) {
        return Err(Error::Project(format!("map/{k} is there already (a file of the map's own?): the terrain layout needs map/{DIR}/ to itself")));
    }
    let Some(flat) = key(files, FLAT_FILE).cloned() else {
        return Err(Error::Project(if key(files, FLAT_RAW).is_some() {
            format!("the terrain is kept raw (map/{FLAT_RAW}): only its text form map/{FLAT_FILE} can be split")
        } else {
            format!("map/{FLAT_FILE} is missing: there is no terrain to split")
        }));
    };
    let t = w3e::terrain_from_text(&files[&flat])?;
    let layout = split_terrain(&t, rects)?;
    files.remove(&flat);
    files.extend(layout);
    Ok(())
}

/// For a sync from a map into a project with the split layout: the map's `war3map.w3e.txt` among
/// `files` (relative to `map/`) is cut into the project's subterrains (its `terrain.json` keeps
/// them, its default corner and objects' header; the header follows the map). A flat project's files
/// stay as they are. Errors when the map's terrain can't go into the layout: stored raw, missing,
/// reaching outside the rectangles with other corners than the default, or the map has files of its
/// own under `terrain/`.
pub fn prepare_sync(map_dir: &Path, files: &mut BTreeMap<String, Vec<u8>>) -> Result<()> {
    if !is_split_on_disk(map_dir)? {
        return Ok(());
    }
    let layout = Layout::parse(&fs::read(map_dir.join(LAYOUT_FILE))?)?;
    if let Some(k) = files.keys().find(|k| under_dir(k)) {
        return Err(Error::Project(format!("the map has a file map/{k}, but the project keeps its terrain in map/{DIR}/: merge the terrain first (`w3proj terrain merge`)")));
    }
    let Some(flat) = key(files, FLAT_FILE).cloned() else {
        return Err(Error::Project(if key(files, FLAT_RAW).is_some() {
            format!("the map's terrain couldn't be read as text, so it can't go into the project's map/{DIR}/: merge the terrain first (`w3proj terrain merge`)")
        } else {
            format!("the map has no terrain (war3map.w3e), so the project's map/{DIR}/ would go: merge the terrain first (`w3proj terrain merge`)")
        }));
    };
    let t = w3e::terrain_from_text(&files[&flat])?;
    let sliced = slice_terrain(&t, layout.subterrains, layout.default_corner, layout.doo_header)
        .map_err(|e| Error::Project(format!("the map's terrain doesn't fit the project's subterrains ({e}): merge the terrain first (`w3proj terrain merge`), then split it again")))?;
    files.remove(&flat);
    files.extend(sliced);
    Ok(())
}

/// Writes `files` (relative to `map_dir`) whose bytes differ from those on disk, each in one step
/// (`crate::atomic`); returns the paths written.
pub fn write_changed(map_dir: &Path, files: &BTreeMap<String, Vec<u8>>) -> Result<Vec<String>> {
    let mut written = Vec::new();
    for (rel, bytes) in files {
        if crate::project::write_if_changed(&map_dir.join(rel), bytes)? {
            written.push(rel.clone());
        }
    }
    Ok(written)
}

/// The split layout's files on disk (relative to `map/`), read; a project without `map/terrain/`
/// gives none.
fn read_layout_files(map_dir: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut files = BTreeMap::new();
    for rel in crate::project::walk(&map_dir.join(DIR))? {
        let path = format!("{DIR}/{rel}");
        let bytes = fs::read(map_dir.join(&path)).map_err(|e| Error::Project(format!("map/{path} can't be read: {e}")))?;
        files.insert(path, bytes);
    }
    Ok(files)
}

/// What `split_project` and `merge_project` did, relative to the project.
#[derive(Debug, Default, serde::Serialize)]
pub struct Converted {
    pub written: Vec<String>,
    pub removed: Vec<String>,
}

/// Whether the derived files' record (`crate::derived`) said they follow the sources: then they
/// still do after a conversion (the terrain is the same), and the record is made again for the new
/// file names.
fn derived_fresh(project: &Path) -> Result<bool> {
    Ok(crate::derived::check(project)? == crate::derived::Freshness::Fresh)
}

/// Splits a flat project's terrain into `map/terrain/` (`split`): the layout's files are written
/// first, then `map/war3map.w3e.txt` goes. Nothing is written when the split can't be lossless.
pub fn split_project(project: &Path, rects: &[Rect]) -> Result<Converted> {
    let manifest = crate::project::Manifest::load(project)?;
    if manifest.pack.raw.iter().any(|r| r.eq_ignore_ascii_case(FLAT_FILE)) {
        return Err(Error::Project(format!("map/{FLAT_FILE} is packed raw (w3proj.toml [pack] raw): it isn't the map's terrain text")));
    }
    let map_dir = project.join(crate::project::MAP_DIR);
    if is_split_on_disk(&map_dir)? {
        return Err(Error::Project("the terrain is split already".into()));
    }
    let mut files = read_layout_files(&map_dir)?;
    for name in [FLAT_FILE, FLAT_RAW] {
        match fs::read(map_dir.join(name)) {
            Ok(b) => {
                files.insert(name.to_string(), b);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(Error::Project(format!("map/{name} can't be read: {e}"))),
        }
    }
    let fresh = derived_fresh(project)?;
    split(&mut files, rects)?;
    let written = write_changed(&map_dir, &files)?;
    fs::remove_file(map_dir.join(FLAT_FILE))?;
    if fresh {
        crate::derived::record_now(project)?;
    }
    let at = |p: &String| format!("{}/{p}", crate::project::MAP_DIR);
    Ok(Converted { written: written.iter().map(at).collect(), removed: vec![at(&FLAT_FILE.to_string())] })
}

/// Merges a split project's terrain back into `map/war3map.w3e.txt` (`flatten`): that file is
/// written first, then the layout's files go.
pub fn merge_project(project: &Path) -> Result<Converted> {
    let map_dir = project.join(crate::project::MAP_DIR);
    if !is_split_on_disk(&map_dir)? {
        return Err(Error::Project(format!("the terrain isn't split (there is no map/{LAYOUT_FILE})")));
    }
    let mut files = read_layout_files(&map_dir)?;
    let layout_paths: Vec<String> = files.keys().cloned().collect();
    let fresh = derived_fresh(project)?;
    flatten(&mut files)?;
    let written = write_changed(&map_dir, &files)?;
    for p in &layout_paths {
        fs::remove_file(map_dir.join(p))?;
    }
    remove_empty(&map_dir.join(DIR));
    if fresh {
        crate::derived::record_now(project)?;
    }
    let at = |p: &String| format!("{}/{p}", crate::project::MAP_DIR);
    Ok(Converted { written: written.iter().map(at).collect(), removed: layout_paths.iter().map(at).collect() })
}

/// Removes `dir` and the folders below it that are empty (a folder holding anything stays).
fn remove_empty(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                remove_empty(&e.path());
            }
        }
    }
    let _ = fs::remove_dir(dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 9×7 terrain with a bit of everything; `texture_bits` on one corner when `bits`.
    fn terrain(version: u32, bits: bool) -> Terrain {
        let (width, height) = (9, 7);
        let corners = (0..width * height)
            .map(|i| Corner {
                height: 0x2000 + if i % 5 == 0 { -40 } else { (i % 3) as i16 * 8 },
                water: 0x2000 - 80 + if i % 9 == 8 { 0x4000 } else { 0 },
                texture: (i % 4) as u8,
                flags: if i == 10 { 0b0101 } else { 0 },
                texture_bits: if bits && i == 20 { 3 } else { 0 },
                variation: (i * 7 % 18) as u8,
                cliff_variation: (i % 2) as u8,
                cliff_texture: 15,
                layer: 2 + (i % 2) as u8,
            })
            .collect();
        Terrain {
            version,
            tileset: b'L',
            custom_tilesets: 1,
            ground: vec![*b"Ldrt", *b"Lgrs", *b"Lrok", [0, 1, 2, 3]],
            cliffs: vec![*b"CLdi", *b"CLgr"],
            width,
            height,
            offset: [-576.0, 0.25],
            corners,
            trailer: vec![0xde, 0xad],
        }
    }

    fn flat_files(t: &Terrain) -> BTreeMap<String, Vec<u8>> {
        BTreeMap::from([(FLAT_FILE.to_string(), w3e::terrain_text(t).unwrap()), ("war3map.j".to_string(), b"// script".to_vec())])
    }

    fn rect(s: &str) -> Rect {
        s.parse().unwrap()
    }

    #[test]
    fn split_and_merge_give_back_the_same_files() {
        for t in [terrain(12, false), terrain(12, true), terrain(11, false)] {
            let flat = flat_files(&t);
            for rects in [vec![], grid_2x2(t.width, t.height), vec![rect("a:0,0,1,7"), rect("b:1,0,8,3"), rect("c:1,3,8,4")]] {
                let mut files = flat.clone();
                split(&mut files, &rects).unwrap();
                assert!(!files.contains_key(FLAT_FILE));
                assert!(is_split(&files).unwrap());
                assert_eq!(assemble(&files).unwrap(), w3e::write(&t));
                assert!(flatten(&mut files).unwrap());
                assert_eq!(files, flat, "{rects:?}");
            }
        }
    }

    #[test]
    fn one_subterrain_main_by_default() {
        let mut files = flat_files(&terrain(12, false));
        split(&mut files, &[]).unwrap();
        let layout = Layout::parse(&files[LAYOUT_FILE]).unwrap();
        assert_eq!(layout.subterrains, vec![Subterrain { name: "main".into(), folder: "main".into(), x: 0, y: 0, w: 9, h: 7, id_range: [10000, 19999] }]);
        let ground = String::from_utf8(files["terrain/main/terrain.txt"].clone()).unwrap();
        assert!(ground.starts_with("corners 9 7\n\n[height]\n"), "{ground}");
        assert!(!ground.contains("[trailer]"));
        let json = String::from_utf8(files[LAYOUT_FILE].clone()).unwrap();
        assert!(json.contains("\"ground\": [\"Ldrt\", \"Lgrs\", \"Lrok\", \"hex:00010203\"],\n"), "{json}");
        assert!(json.contains("\"offset\": [-576, \"bits:3e800000\"],\n"), "{json}");
        assert!(json.contains("\"trailer\": \"dead\",\n"), "{json}");
    }

    /// Uncovered corners come from defaultCorner, every field of it; a split leaves out only corners
    /// equal to it, and refuses to drop any other.
    #[test]
    fn default_corner_round_trip() {
        let mut t = terrain(12, true);
        let fill = Corner { height: 0x2000 + 12, water: 0x4000 | (0x2000 - 3), texture: 33, flags: 9, texture_bits: 5, variation: 17, cliff_variation: 6, cliff_texture: 14, layer: 13 };
        // Columns 6.. and rows 5.. outside the subterrains, all the fill corner.
        for y in 0..t.height {
            for x in 0..t.width {
                if x >= 6 || y >= 5 {
                    t.corners[y * t.width + x] = fill;
                }
            }
        }
        let flat = flat_files(&t);
        let mut files = flat.clone();
        split(&mut files, &[rect("left:0,0,3,5"), rect("mid:3,0,3,5")]).unwrap();
        let layout = Layout::parse(&files[LAYOUT_FILE]).unwrap();
        assert_eq!(layout.default_corner, fill);
        let json = String::from_utf8(files[LAYOUT_FILE].clone()).unwrap();
        for f in ["\"height\": 12", "\"water\": -3", "\"waterBits\": 1", "\"texture\": 33", "\"textureBits\": 5", "\"variation\": 17", "\"cliffVariation\": 6", "\"cliffTexture\": 14", "\"layer\": 13", "\"flags\": 9"] {
            assert!(json.contains(f), "{f} in {json}");
        }
        // Written again from what was read, it is the same text.
        assert_eq!(layout.to_json().unwrap(), files[LAYOUT_FILE]);
        let mut back = files.clone();
        flatten(&mut back).unwrap();
        assert_eq!(back, flat);
        // One uncovered corner that isn't the default: refused, not dropped.
        t.corners[t.width * t.height - 1].height += 1;
        let mut files = flat_files(&t);
        let e = split(&mut files, &[rect("left:0,0,3,5"), rect("mid:3,0,3,5")]).unwrap_err().to_string();
        assert!(e.contains("would be lost"), "{e}");
        assert!(files.contains_key(FLAT_FILE), "a refused split leaves the files as they were");
    }

    fn layout_json(subterrains: &str) -> String {
        format!(
            "{{\"format\":\"w3proj.terrain/1\",\"tileset\":\"L\",\"customTilesets\":1,\"ground\":[\"Ldrt\"],\"cliffs\":[],\"corners\":[10,10],\"offset\":[0,0],\"w3eVersion\":12,\"trailer\":\"\",\
             \"defaultCorner\":{{\"height\":0,\"water\":0,\"waterBits\":0,\"texture\":0,\"textureBits\":0,\"variation\":0,\"cliffVariation\":0,\"cliffTexture\":15,\"layer\":2,\"flags\":8}},\"subterrains\":[{subterrains}]}}"
        )
    }

    fn sub(name: &str, folder: &str, x: usize, y: usize, w: usize, h: usize, ids: [u32; 2]) -> String {
        format!("{{\"name\":\"{name}\",\"folder\":\"{folder}\",\"x\":{x},\"y\":{y},\"w\":{w},\"h\":{h},\"idRange\":[{},{}]}}", ids[0], ids[1])
    }

    #[test]
    fn validation() {
        let ok = |s: String| Layout::parse(layout_json(&s).as_bytes());
        let fails = |s: String, why: &str| {
            let e = ok(s.clone()).err().unwrap_or_else(|| panic!("accepted {s}")).to_string();
            assert!(e.contains(why), "{e} (expected {why})");
        };
        ok(format!("{},{}", sub("a", "a", 0, 0, 5, 10, [1, 9]), sub("b", "b", 5, 0, 5, 10, [10, 19]))).unwrap();
        fails(String::new(), "no subterrain");
        fails(sub("a", "a", 0, 0, 11, 10, [1, 9]), "past the canvas");
        fails(sub("a", "a", 6, 0, 5, 1, [1, 9]), "past the canvas");
        fails(sub("a", "a", 0, 0, 0, 1, [1, 9]), "empty");
        fails(format!("{},{}", sub("a", "a", 0, 0, 5, 5, [1, 9]), sub("b", "b", 4, 4, 2, 2, [10, 19])), "overlap");
        fails(format!("{},{}", sub("a", "a", 0, 0, 5, 5, [1, 10]), sub("b", "b", 5, 5, 2, 2, [10, 19])), "idRanges");
        fails(sub("a", "a", 0, 0, 5, 5, [9, 1]), "starts after");
        fails(format!("{},{}", sub("a", "x", 0, 0, 5, 5, [1, 9]), sub("b", "X", 5, 5, 2, 2, [10, 19])), "ignoring case");
        fails(format!("{},{}", sub("a", "x", 0, 0, 5, 5, [1, 9]), sub("a", "y", 5, 5, 2, 2, [10, 19])), "named");
        for folder in ["", ".", "..", "a/b", "a\\\\b", "../up", "c:", "con", "Lpt1.txt", "x.", " x", "terrain.json"] {
            fails(sub("a", folder, 0, 0, 5, 5, [1, 9]), "");
            assert!(check_folder(&folder.replace("\\\\", "\\")).is_err(), "{folder}");
        }
        for folder in ["elwynn_forest", "Westfall 2", "a..b", "über"] {
            assert!(check_folder(folder).is_ok(), "{folder}");
        }
        fails(sub("a", "a", 0, 0, 5, 5, [1, 9]).replace("\"idRange\"", "\"extra\":1,\"idRange\""), "unknown key");
        fails(sub("a", "a", 0, 0, 5, 5, [1, 9]).replace(",\"h\":5", ""), "lacks \"h\"");
        let base = layout_json(&sub("a", "a", 0, 0, 5, 5, [1, 9]));
        for (from, to, why) in [
            ("\"layer\":2", "\"layer\":16", "defaultCorner.layer"),
            ("\"height\":0", "\"height\":40000", "defaultCorner.height"),
            ("\"w3eVersion\":12", "\"w3eVersion\":13", "w3eVersion"),
            ("\"format\":\"w3proj.terrain/1\"", "\"format\":\"w3proj.terrain/2\"", "format"),
            ("\"corners\":[10,10]", "\"corners\":[100000,100000]", "too large"),
            ("\"trailer\":\"\"", "\"trailer\":\"abc\"", "hex"),
            ("\"tileset\":\"L\"", "\"tileset\":\"LL\"", "tileset"),
            ("\"offset\":[0,0]", "\"offset\":[0.5,0]", "offset"),
            ("\"ground\":[\"Ldrt\"]", "\"ground\":[\"hex:€12345\"]", "ground"),
        ] {
            let e = Layout::parse(base.replace(from, to).as_bytes()).err().unwrap_or_else(|| panic!("accepted {to}")).to_string();
            assert!(e.contains(why), "{e} (expected {why})");
        }
        // A dooHeader is optional, all of it when there.
        let doo = base.replace("\"subterrains\"", "\"dooHeader\":{\"doodadsVersion\":8,\"doodadsSubversion\":11,\"unitsVersion\":8,\"unitsSubversion\":11,\"skinIds\":true},\"subterrains\"");
        let l = Layout::parse(doo.as_bytes()).unwrap();
        assert_eq!(l.doo_header, Some(DooHeader { doodads_version: 8, doodads_subversion: 11, units_version: 8, units_subversion: 11, skin_ids: true }));
        assert_eq!(Layout::parse(&l.to_json().unwrap()).unwrap().doo_header, l.doo_header);
        assert!(Layout::parse(doo.replace(",\"skinIds\":true", "").as_bytes()).is_err());
    }

    #[test]
    fn ground_files_are_checked() {
        let mut files = flat_files(&terrain(12, false));
        split(&mut files, &grid_2x2(9, 7)).unwrap();
        let path = "terrain/sw/terrain.txt";
        let good = files[path].clone();
        let text = String::from_utf8(good.clone()).unwrap();
        for (bad, why) in [
            (text.replace("corners 4 3", "corners 4 4"), "size"),
            (text.replace("corners 4 3\n", ""), "size"),
            (format!("{text}\n[trailer]\nff\n"), "unknown section [trailer]"),
            (text.replace("[layer]", "[layers]"), "unknown section"),
        ] {
            let mut f = files.clone();
            f.insert(path.into(), bad.into_bytes());
            let e = flatten(&mut f).unwrap_err().to_string();
            assert!(e.contains(why) && e.contains("map/terrain/sw/terrain.txt"), "{e} (expected {why})");
        }
        let mut f = files.clone();
        f.remove(path);
        assert!(flatten(&mut f).unwrap_err().to_string().contains("missing"));
        let mut f = files.clone();
        f.insert("terrain/sw/doodads.json".into(), b"[]".to_vec());
        assert!(flatten(&mut f).unwrap_err().to_string().contains("isn't part of the terrain layout"));
    }

    #[test]
    fn which_layout() {
        let mut files = flat_files(&terrain(12, false));
        assert!(!is_split(&files).unwrap());
        // A terrain.json of the map's own next to the flat terrain is just a file.
        files.insert(LAYOUT_FILE.into(), b"{\"format\":\"something else\"}".to_vec());
        assert!(!is_split(&files).unwrap());
        files.insert(LAYOUT_FILE.into(), b"not json".to_vec());
        assert!(!is_split(&files).unwrap());
        let mut split_files = flat_files(&terrain(12, false));
        split(&mut split_files, &[]).unwrap();
        // Both layouts: an error, never one of them silently.
        let mut both = split_files.clone();
        both.insert(FLAT_FILE.into(), b"x".to_vec());
        assert!(is_split(&both).unwrap_err().to_string().contains("both terrain layouts"));
        // A layout file that can't be read, or isn't of this format, with no flat terrain: an error, never
        // "flat without terrain".
        for junk in [&b"{ broken"[..], b"{\"format\":\"w3proj.terrrain/1\"}", b"[]"] {
            let mut broken = split_files.clone();
            broken.insert(LAYOUT_FILE.into(), junk.to_vec());
            assert!(is_split(&broken).unwrap());
            assert!(flatten(&mut broken).is_err());
        }
    }

    #[test]
    fn only_changed_files_are_written() {
        let dir = std::env::temp_dir().join(format!("w3proj-terrain-layout-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let t = terrain(12, false);
        let mut files = flat_files(&t);
        files.remove("war3map.j");
        split(&mut files, &grid_2x2(t.width, t.height)).unwrap();
        let first = write_changed(&dir, &files).unwrap();
        assert_eq!(first.len(), 5);
        assert!(write_changed(&dir, &files).unwrap().is_empty(), "nothing changed, nothing written");
        // One corner in the north-east changes: only that subterrain's file is written again.
        let mut edited = t.clone();
        let at = (t.height - 1) * t.width + t.width - 1;
        edited.corners[at].height += 4;
        let mut sync = BTreeMap::from([(FLAT_FILE.to_string(), w3e::terrain_text(&edited).unwrap())]);
        prepare_sync(&dir, &mut sync).unwrap();
        assert_eq!(write_changed(&dir, &sync).unwrap(), vec!["terrain/ne/terrain.txt".to_string()]);
        assert_eq!(assemble(&read_layout_files(&dir).unwrap()).unwrap(), w3e::write(&edited));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rect_arguments() {
        assert_eq!(rect("west:0,0,64,129"), Rect { name: "west".into(), x: 0, y: 0, w: 64, h: 129 });
        for bad in ["west", "west:1,2,3", "west:1,2,3,x", "west:-1,0,1,1"] {
            assert!(bad.parse::<Rect>().is_err(), "{bad}");
        }
    }
}
