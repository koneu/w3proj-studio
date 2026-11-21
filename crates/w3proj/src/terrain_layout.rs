//! The split terrain layout `map/terrain/`: the map's ground in named rectangles (subterrains), so
//! people working on different parts of a large map edit different files.
//!
//! ```text
//! map/terrain/terrain.json        canvas, palettes, the corner uncovered corners get, the subterrains
//! map/terrain/<folder>/terrain.txt   one subterrain's corners, in the grid text of war3map.w3e.txt
//! map/terrain/<folder>/doodads.json, units.json, regions.json   its placed objects (`terrain_objects`)
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
//! Placed objects (war3map.doo.json, war3mapUnits.doo.json) and regions (war3map.w3r.json) go into
//! the subterrains by position (`terrain_objects`); what those files hold besides their lists is in
//! `terrain.json` (`dooHeader`, `objects`). A kind whose flat file isn't there (or is kept raw) has no
//! files in the subterrains and no entry in `objects`; a raw one stays in `map/` as it is.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde_json::{Map, Value};

use crate::terrain_objects::{self as objects, Flats, Heads, Kind, KINDS};
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

pub(crate) fn bad(m: impl Into<String>) -> Error {
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
    /// The creation numbers new objects in it get: `[min, max]` ranges, lowest first (one, until a range is full and
    /// Studio adds another, `crate::terrain_ids`). Never checked against existing objects.
    pub id_ranges: Vec<[u32; 2]>,
}

impl Subterrain {
    /// Its ground file, relative to `map/`.
    pub fn ground_path(&self) -> String {
        format!("{DIR}/{}/{GROUND_FILE}", self.folder)
    }

    /// Its file of placed objects of a kind, relative to `map/`.
    pub fn object_path(&self, kind: Kind) -> String {
        format!("{DIR}/{}/{}", self.folder, kind.file())
    }
}

/// The placed objects' file headers (`war3map.doo`, `war3mapUnits.doo`) once objects live in the
/// subterrains (`Heads::doo_header`); kept when there without objects.
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
    pub(crate) head: Terrain,
    pub(crate) default_corner: Corner,
    pub doo_header: Option<DooHeader>,
    /// The object files in the subterrains (`terrain.json`'s `objects`, with `dooHeader`).
    pub objects: Heads,
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

pub(crate) fn object<'a>(v: &'a Value, what: &str, keys: &[&str], optional: &[&str]) -> Result<&'a Map<String, Value>> {
    let o = v.as_object().ok_or_else(|| bad(format!("{what} isn't an object")))?;
    if let Some(k) = o.keys().find(|k| !keys.contains(&k.as_str()) && !optional.contains(&k.as_str())) {
        return Err(bad(format!("{what} has an unknown key \"{k}\"")));
    }
    if let Some(k) = keys.iter().find(|k| !o.contains_key(**k)) {
        return Err(bad(format!("{what} lacks \"{k}\"")));
    }
    Ok(o)
}

pub(crate) fn uint(v: &Value, what: &str, max: u64) -> Result<u64> {
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

/// A subterrain's `idRange`: one range `[min, max]`, or a list of them `[[min, max], …]` once one was full.
fn id_ranges(v: &Value, what: &str) -> Result<Vec<[u32; 2]>> {
    let id = |v: &Value| uint(v, what, u32::MAX as u64).map(|v| v as u32);
    let list = v.as_array().ok_or_else(|| bad(format!("{what} isn't a list")))?;
    if list.iter().all(Value::is_array) && !list.is_empty() {
        list.iter()
            .map(|r| {
                let [lo, hi] = pair(r, what)?;
                Ok([id(lo)?, id(hi)?])
            })
            .collect()
    } else {
        let [lo, hi] = pair(v, what)?;
        Ok(vec![[id(lo)?, id(hi)?]])
    }
}

/// `idRange` as written: one range as `[min, max]` (as every terrain.json had it before ranges could be added), more
/// as `[[min, max], …]`.
fn id_ranges_json(ranges: &[[u32; 2]]) -> String {
    match ranges {
        [r] => format!("[{}, {}]", r[0], r[1]),
        _ => format!("[{}]", ranges.iter().map(|r| format!("[{}, {}]", r[0], r[1])).collect::<Vec<_>>().join(", ")),
    }
}

/// Two id ranges that overlap (`Layout::range_overlaps`): the subterrains' names and the ranges.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct RangeOverlap {
    pub a: String,
    #[serde(rename = "aRange")]
    pub a_range: [u32; 2],
    pub b: String,
    #[serde(rename = "bRange")]
    pub b_range: [u32; 2],
}

impl std::fmt::Display for RangeOverlap {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        if self.a == self.b {
            write!(f, "two idRanges of \"{}\" overlap ({}–{} and {}–{})", self.a, self.a_range[0], self.a_range[1], self.b_range[0], self.b_range[1])
        } else {
            write!(f, "the idRanges of \"{}\" and \"{}\" overlap ({}–{} and {}–{})", self.a, self.b, self.a_range[0], self.a_range[1], self.b_range[0], self.b_range[1])
        }
    }
}

const TOP: &[&str] =&["format", "tileset", "customTilesets", "ground", "cliffs", "corners", "offset", "w3eVersion", "trailer", "defaultCorner", "subterrains"];
const SUB: &[&str] = &["name", "folder", "x", "y", "w", "h", "idRange"];
const DOO: &[&str] = &["doodadsVersion", "doodadsSubversion", "unitsVersion", "unitsSubversion", "skinIds"];

impl Layout {
    /// Reads `terrain.json` without `check` (`w3proj terrain check` lists what is wrong rather than stopping at it).
    pub fn parse_unchecked(bytes: &[u8]) -> Result<Layout> {
        let doc =objects::strict_json(bytes).map_err(|e| bad(format!("isn't JSON: {e}")))?;
        let o = object(&doc, "the file", TOP, &["dooHeader", "objects"])?;
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
        let objects = match o.get("objects") {
            None => Heads::default(),
            Some(v) => Heads::parse(v, doo_header.as_ref())?,
        };
        let list = o["subterrains"].as_array().ok_or_else(|| bad("subterrains isn't a list"))?;
        let mut subterrains = Vec::with_capacity(list.len().min(1024));
        for (i, s) in list.iter().enumerate() {
            let what = format!("subterrains[{i}]");
            let s = object(s, &what, SUB, &[])?;
            let text = |k: &str| s[k].as_str().map(str::to_string).ok_or_else(|| bad(format!("{what}.{k} isn't a string")));
            let num = |k: &str| uint(&s[k], &format!("{what}.{k}"), u32::MAX as u64).map(|v| v as usize);
            subterrains.push(Subterrain {
                name: text("name")?,
                folder: text("folder")?,
                x: num("x")?,
                y: num("y")?,
                w: num("w")?,
                h: num("h")?,
                id_ranges: id_ranges(&s["idRange"], &format!("{what}.idRange"))?,
            });
        }
        Ok(Layout { head, default_corner, doo_header, objects, subterrains })
    }

    /// Reads and checks `terrain.json` (`check`).
    pub fn parse(bytes: &[u8]) -> Result<Layout> {
        let layout = Layout::parse_unchecked(bytes)?;
        layout.check()?;
        Ok(layout)
    }

    /// What loading checks: `check_shape`, and no two id ranges overlap (`range_overlaps`).
    pub fn check(&self) -> Result<()> {
        self.check_shape()?;
        match self.range_overlaps().first() {
            Some(o) => Err(bad(o.to_string())),
            None => Ok(()),
        }
    }

    /// Every two id ranges that overlap (of two subterrains, or two of one), in the order of their starts.
    pub fn range_overlaps(&self) -> Vec<RangeOverlap> {
        let mut ranges: Vec<(&[u32; 2], &str)> = self.subterrains.iter().flat_map(|s| s.id_ranges.iter().map(move |r| (r, s.name.as_str()))).collect();
        ranges.sort();
        let mut out = Vec::new();
        for (i, (a, an)) in ranges.iter().enumerate() {
            for (b, bn) in &ranges[i + 1..] {
                if b[0] > a[1] {
                    break;
                }
                out.push(RangeOverlap { a: an.to_string(), a_range: **a, b: bn.to_string(), b_range: **b });
            }
        }
        out
    }

    /// What loading checks besides the id ranges' overlaps: the canvas isn't too large, the default corner fits the
    /// version, there is at least one subterrain, names and folders are unique (folders also ignoring case) and
    /// safe, rectangles lie within the canvas and don't overlap, each subterrain has id ranges that start before they
    /// end.
    pub fn check_shape(&self) -> Result<()> {
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
            if s.id_ranges.is_empty() {
                return Err(bad(format!("subterrain \"{}\" has no idRange", s.name)));
            }
            if s.id_ranges.iter().any(|r| r[0] > r[1]) {
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
        Ok(())
    }

    /// The canvas in corners.
    pub fn corners(&self) -> [usize; 2] {
        [self.head.width, self.head.height]
    }

    /// The world position of corner (0, 0), what ownership measures rectangles from (`terrain_objects::owner`).
    pub fn offset(&self) -> [f32; 2] {
        self.head.offset
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
        s += &self.objects.to_json(self.doo_header.as_ref());
        let subs: Vec<String> = self
            .subterrains
            .iter()
            .map(|st| {
                format!(
                    "    {{\n      \"name\": {},\n      \"folder\": {},\n      \"x\": {},\n      \"y\": {},\n      \"w\": {},\n      \"h\": {},\n      \"idRange\": {}\n    }}",
                    q(&st.name),
                    q(&st.folder),
                    st.x,
                    st.y,
                    st.w,
                    st.h,
                    id_ranges_json(&st.id_ranges)
                )
            })
            .collect();
        s += &format!("  \"subterrains\": [\n{}\n  ]\n}}\n", subs.join(",\n"));
        Ok(s.into_bytes())
    }
}

// ---- terrain.txt ----

/// A subterrain's ground file: `corners w h`, then the grid sections of war3map.w3e.txt.
pub(crate) fn ground_text(corners: &[Corner], w: usize, h: usize, version: u32) -> Vec<u8> {
    let mut s = format!("corners {w} {h}\n");
    w3e::write_grids(&mut s, corners, w, version);
    s.into_bytes()
}

pub(crate) fn parse_ground(path: &str, bytes: &[u8], w: usize, h: usize, version: u32) -> Result<Vec<Corner>> {
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

/// The files of a layout (relative to `map/`) holding the whole terrain `t` and the flat object
/// files `flats` (kind → bytes): `terrain.json` with `t`'s header, the given subterrains and default
/// corner and the objects' headers (`doo_header` is kept when there are no doodads and units), each
/// subterrain's ground and object files. A corner outside every subterrain that isn't
/// `default_corner` can't be stored: an error. The result is read again and compared with `t` and
/// `flats` before it is returned.
fn slice_terrain(t: &Terrain, subterrains: Vec<Subterrain>, default_corner: Corner, doo_header: Option<DooHeader>, flats: &Flats) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut head = t.clone();
    head.corners = Vec::new();
    let mut layout = Layout { head, default_corner, doo_header, objects: Heads::default(), subterrains };
    layout.check()?;
    let (heads, object_files) = objects::slice(flats, &layout.subterrains, t.offset)?;
    layout.doo_header = heads.doo_header().or(layout.doo_header);
    layout.objects = heads;
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
    files.extend(object_files);
    files.insert(LAYOUT_FILE.to_string(), layout.to_json()?);
    // Never store what can't be read back as it was.
    let read = Layout::parse(&files[LAYOUT_FILE])?;
    let again = assemble_terrain(&read, &|p| files.get(p).cloned())?;
    if w3e::write(&again) != w3e::write(t) {
        return Err(Error::Format("the subterrains don't assemble into the same terrain again (nothing was written)".into()));
    }
    let merged = objects::assemble(&read.objects, &read.subterrains, &|p| files.get(p).cloned())?;
    for (kind, bytes) in flats {
        if !merged.get(kind).is_some_and(|m| objects::same(bytes, m)) {
            return Err(Error::Format(format!(
                "map/{} doesn't come back from the subterrains as it was (it isn't in the form unpack writes?), so it can't be split (nothing was written)",
                kind.flat()
            )));
        }
    }
    Ok(files)
}

/// The flat object files among project `files` (relative to `map/`) that go into the subterrains:
/// kind → its file's name there. A kind kept raw, or without a file, has none. A name in another
/// case than unpack writes it is an error (the merge would write it in that one).
fn flat_objects(files: &BTreeMap<String, Vec<u8>>) -> Result<BTreeMap<Kind, String>> {
    let mut out = BTreeMap::new();
    for kind in KINDS {
        if let Some(k) = key(files, kind.flat()) {
            if k != kind.flat() {
                return Err(Error::Project(format!("map/{k} can't go into map/{DIR}/ under another name: rename it to {} first", kind.flat())));
            }
            out.insert(kind, k.clone());
        }
    }
    Ok(out)
}

/// The flat object files (`flat_objects`) of `files`: kind → bytes, and their names.
fn flat_object_files(files: &BTreeMap<String, Vec<u8>>) -> Result<(Flats, Vec<String>)> {
    let names = flat_objects(files)?;
    let flats = names.iter().map(|(k, name)| (*k, files[name].clone())).collect();
    Ok((flats, names.into_values().collect()))
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
/// uncovered corner the most common one. The flat object files `flats` go into the subterrains.
fn split_terrain(t: &Terrain, rects: &[Rect], flats: &Flats) -> Result<BTreeMap<String, Vec<u8>>> {
    let whole = [Rect { name: "main".into(), x: 0, y: 0, w: t.width, h: t.height }];
    let rects = if rects.is_empty() { &whole[..] } else { rects };
    let mut subterrains = Vec::with_capacity(rects.len());
    for (i, r) in rects.iter().enumerate() {
        let lo = u32::try_from(i + 1).ok().and_then(|n| n.checked_mul(10000)).ok_or_else(|| Error::Format("too many subterrains".into()))?;
        let hi = lo.checked_add(9999).ok_or_else(|| Error::Format("too many subterrains".into()))?;
        subterrains.push(Subterrain { name: r.name.clone(), folder: r.name.clone(), x: r.x, y: r.y, w: r.w, h: r.h, id_ranges: vec![[lo, hi]] });
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
    slice_terrain(t, subterrains, default_corner, None, flats)
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

/// The canvas of a flat project's terrain (`map/war3map.w3e.txt` under `map_dir`), in corners: what a split's
/// rectangles are measured in.
pub fn flat_canvas(map_dir: &Path) -> Result<[usize; 2]> {
    let bytes = fs::read(map_dir.join(FLAT_FILE)).map_err(|e| Error::Project(format!("map/{FLAT_FILE} can't be read: {e}")))?;
    let t = w3e::terrain_from_text(&bytes)?;
    Ok([t.width, t.height])
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
/// files go, `war3map.w3e.txt` holds the assembled terrain and the flat object files the merged
/// objects. Files of the flat layout stay as they are; one of an object kind the subterrains hold is
/// an error (both layouts). The subterrains' hand-painted pathing (`pathing.txt`, `crate::terrain_pathing`)
/// isn't part of the map: it is read (a damaged one is an error) and left out. Another file under
/// `terrain/` is an error (this version keeps nothing else there). Returns whether the files were in
/// the split layout.
pub fn flatten(files: &mut BTreeMap<String, Vec<u8>>) -> Result<bool> {
    flatten_with(files, true)
}

/// `flatten`; `check_pathing`: the subterrains' `pathing.txt` are read too (the app's view of the terrain leaves that to
/// the Pathing tool's file, so a damaged one doesn't keep the terrain from opening).
fn flatten_with(files: &mut BTreeMap<String, Vec<u8>>, check_pathing: bool) -> Result<bool> {
    if !is_split(files)? {
        return Ok(false);
    }
    let layout = Layout::parse(&files[LAYOUT_FILE])?;
    let t = assemble_terrain(&layout, &|p| files.get(p).cloned())?;
    let mut ours: HashSet<String> = layout.subterrains.iter().map(Subterrain::ground_path).collect();
    ours.insert(LAYOUT_FILE.to_string());
    ours.extend(layout.subterrains.iter().map(crate::terrain_pathing::path));
    if check_pathing {
        crate::terrain_pathing::assemble(&layout, &|p| files.get(p).cloned())?;
    }
    for kind in KINDS.into_iter().filter(|k| layout.objects.has(*k)) {
        ours.extend(layout.subterrains.iter().map(|s| s.object_path(kind)));
        if let Some(flat) = key(files, kind.flat()).or_else(|| key(files, kind.raw())) {
            return Err(Error::Project(format!(
                "the project has its {} both in map/{flat} and in map/{DIR}/: keep one (`w3proj terrain merge` makes the flat file)",
                kind.name()
            )));
        }
    }
    if let Some(other) = files.keys().find(|k| under_dir(k) && !ours.contains(*k)) {
        let objects: Vec<&str> = KINDS.iter().filter(|k| layout.objects.has(**k)).map(|k| k.file()).collect();
        return Err(Error::Project(format!(
            "map/{other} isn't part of the terrain layout (map/{DIR}/ holds terrain.json and each subterrain's {GROUND_FILE}{} and {} only)",
            objects.iter().map(|f| format!(", {f}")).collect::<String>(),
            crate::terrain_pathing::FILE
        )));
    }
    let merged = objects::assemble(&layout.objects, &layout.subterrains, &|p| files.get(p).cloned())?;
    files.retain(|k, _| !ours.contains(k));
    files.insert(FLAT_FILE.to_string(), w3e::terrain_text(&t)?);
    files.extend(merged.into_iter().map(|(kind, bytes)| (kind.flat().to_string(), bytes)));
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
    let (flats, names) = flat_object_files(files)?;
    let layout = split_terrain(&t, rects, &flats)?;
    files.remove(&flat);
    for name in &names {
        files.remove(name);
    }
    files.extend(layout);
    Ok(())
}

/// For a sync from a map into a project with the split layout: the map's `war3map.w3e.txt` among
/// `files` (relative to `map/`) is cut into the project's subterrains (its `terrain.json` keeps
/// them, its default corner and objects' header; the header follows the map). A flat project's files
/// stay as they are. Errors when the map's terrain can't go into the layout: stored raw, missing,
/// reaching outside the rectangles with other corners than the default, or the map has files of its
/// own under `terrain/`. The subterrains' hand-painted pathing (`pathing.txt`) stays as it is (it isn't
/// in the map). The map's derived files (`crate::derived::FILES`) are taken out of `files` and returned:
/// a split project keeps them in its store (`crate::derived::sync_store`), not in `map/`. A flat
/// project returns none.
pub fn prepare_sync(map_dir: &Path, files: &mut BTreeMap<String, Vec<u8>>) -> Result<BTreeMap<String, Vec<u8>>> {
    if !is_split_on_disk(map_dir)? {
        return Ok(BTreeMap::new());
    }
    let layout = Layout::parse(&fs::read(map_dir.join(LAYOUT_FILE))?)?;
    let pathing: Vec<String> = layout.subterrains.iter().map(crate::terrain_pathing::path).collect();
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
    let (flats, names) = flat_object_files(files)?;
    let sliced = slice_terrain(&t, layout.subterrains, layout.default_corner, layout.doo_header, &flats).map_err(|e| {
        Error::Project(format!("the map's terrain and objects don't fit the project's subterrains ({e}): merge the terrain first (`w3proj terrain merge`), then split it again"))
    })?;
    files.remove(&flat);
    for name in &names {
        files.remove(name);
    }
    files.extend(sliced);
    read_if_there(map_dir, &pathing.iter().map(String::as_str).collect::<Vec<_>>(), files)?;
    Ok(crate::derived::take(files))
}

/// Writes `files` (relative to `map_dir`) whose bytes differ from those on disk, each in one step
/// (`crate::atomic`); returns the paths written.
pub fn write_changed(map_dir: &Path, files: &BTreeMap<String, Vec<u8>>) -> Result<Vec<String>> {
    let mut written = Vec::new();
    for (rel, bytes) in files {
        if crate::project::write_if_changed(&crate::paths::join_rel(map_dir, rel), bytes)? {
            written.push(rel.clone());
        }
    }
    Ok(written)
}

/// The split layout's files on disk (relative to `map/`), read; a project without `map/terrain/`
/// gives none.
pub(crate) fn read_layout_files(map_dir: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut files = BTreeMap::new();
    for rel in crate::project::walk(&map_dir.join(DIR))? {
        let path = format!("{DIR}/{rel}");
        let bytes = fs::read(crate::paths::join_rel(map_dir, &path)).map_err(|e| Error::Project(format!("map/{path} can't be read: {e}")))?;
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

/// Reads `names` under `map_dir` into `files` where they are there.
fn read_if_there(map_dir: &Path, names: &[&str], files: &mut BTreeMap<String, Vec<u8>>) -> Result<()> {
    for name in names {
        match fs::read(crate::paths::join_rel(map_dir, name)) {
            Ok(b) => {
                files.insert(name.to_string(), b);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(Error::Project(format!("map/{name} can't be read: {e}"))),
        }
    }
    Ok(())
}

/// `.gitignore` gets the derived files' store and record (`crate::derived::IGNORED`); the path written, if it changed.
fn ignore_store(project: &Path, lines: &[&str]) -> Result<Option<String>> {
    Ok(crate::derived::ensure_lines(project, lines)?.then(|| ".gitignore".to_string()))
}

/// Splits a flat project's terrain and placed objects into `map/terrain/` (`split`): the layout's
/// files are written first, then `map/war3map.w3e.txt` and the flat object files go. Nothing is
/// written when the split can't be lossless. An object file packed raw stays where it is.
///
/// The derived files (`crate::derived::FILES`) move from `map/` into the store `.w3proj/derived/`, which
/// `.gitignore` then ignores with the record `.w3proj/derived-from.json` (still valid: the sources are
/// the same terrain). The Pathing tool's `.w3proj/pathing.json` goes into the subterrains' `pathing.txt`
/// (`crate::terrain_pathing`) and is kept as `.w3proj/pathing.json.bak`; one that can't go there
/// refuses the split.
pub fn split_project(project: &Path, rects: &[Rect]) -> Result<Converted> {
    let _one = FLAT_WRITES.lock().unwrap_or_else(|e| e.into_inner());
    let manifest = crate::project::Manifest::load(project)?;
    let packed_raw = |name: &str| manifest.pack.raw.iter().any(|r| r.eq_ignore_ascii_case(name));
    if packed_raw(FLAT_FILE) {
        return Err(Error::Project(format!("map/{FLAT_FILE} is packed raw (w3proj.toml [pack] raw): it isn't the map's terrain text")));
    }
    let map_dir = project.join(crate::project::MAP_DIR);
    if is_split_on_disk(&map_dir)? {
        return Err(Error::Project("the terrain is split already".into()));
    }
    let mut files = read_layout_files(&map_dir)?;
    read_if_there(&map_dir, &[FLAT_FILE, FLAT_RAW], &mut files)?;
    let object_names: Vec<&str> = KINDS.iter().map(|k| k.flat()).filter(|n| !packed_raw(n)).collect();
    read_if_there(&map_dir, &object_names, &mut files)?;
    let before: Vec<String> = [FLAT_FILE].into_iter().chain(object_names).filter(|n| files.contains_key(*n)).map(str::to_string).collect();
    let fresh = derived_fresh(project)?;
    split(&mut files, rects)?;
    // Everything that could refuse, before anything is written.
    let pathing_json = crate::terrain_pathing::read_json(project)?;
    if let Some(json) = &pathing_json {
        let layout = Layout::parse(&files[LAYOUT_FILE])?;
        let sliced = crate::terrain_pathing::slice(json, &layout).map_err(|e| Error::Project(format!("{e}: fix or move away {} first", crate::terrain_pathing::JSON_NAME)))?;
        files.extend(sliced);
    }
    let backup = pathing_json.as_ref().map(|_| crate::terrain_pathing::backup_path(project)).transpose()?;
    crate::derived::can_move(project, true)?;
    let written = write_changed(&map_dir, &files)?;
    let removed: Vec<&String> = before.iter().filter(|n| !files.contains_key(*n)).collect();
    for name in &removed {
        fs::remove_file(map_dir.join(name))?;
    }
    let at = |p: &String| format!("{}/{p}", crate::project::MAP_DIR);
    let mut done = Converted { written: written.iter().map(at).collect(), removed: removed.into_iter().map(at).collect() };
    let store = crate::derived::STORE_DIR.join("/");
    for name in crate::derived::into_store(project)? {
        done.removed.push(at(&name));
        done.written.push(format!("{store}/{name}"));
    }
    if let Some(backup) = backup {
        fs::rename(crate::terrain_pathing::json_path(project), &backup)?;
        done.removed.push(crate::terrain_pathing::JSON_NAME.to_string());
        done.written.push(format!(".w3proj/{}", backup.file_name().unwrap_or_default().to_string_lossy()));
    }
    done.written.extend(ignore_store(project, &crate::derived::IGNORED)?);
    if fresh {
        crate::derived::record_now(project)?;
    }
    Ok(done)
}

/// Merges a split project's terrain and objects back into `map/war3map.w3e.txt` and the flat object
/// files (`flatten`): those are written first, then the layout's files go. The subterrains' `pathing.txt`
/// become `.w3proj/pathing.json` again (none: no file), the store's derived files go back into `map/`
/// (`.gitignore` keeps ignoring the store, which a flat project doesn't have).
pub fn merge_project(project: &Path) -> Result<Converted> {
    let _one = FLAT_WRITES.lock().unwrap_or_else(|e| e.into_inner());
    let map_dir = project.join(crate::project::MAP_DIR);
    if !is_split_on_disk(&map_dir)? {
        return Err(Error::Project(format!("the terrain isn't split (there is no map/{LAYOUT_FILE})")));
    }
    let mut files = read_layout_files(&map_dir)?;
    let layout_paths: Vec<String> = files.keys().cloned().collect();
    // Flat object files already there: kept when the subterrains don't hold that kind, else both
    // layouts (an error).
    let flat_names: Vec<&str> = KINDS.iter().flat_map(|k| [k.flat(), k.raw()]).collect();
    read_if_there(&map_dir, &flat_names, &mut files)?;
    let fresh = derived_fresh(project)?;
    // Everything that could refuse, before anything is written: the pathing overrides read, no pathing.json in the way,
    // the derived files movable.
    let layout = Layout::parse(&files[LAYOUT_FILE])?;
    let pathing = crate::terrain_pathing::assemble(&layout, &|p| files.get(p).cloned())?;
    if pathing.is_some() && crate::terrain_pathing::read_json(project)?.is_some() {
        return Err(Error::Project(format!(
            "{} is there besides the subterrains' {}: move it away first (the merge writes the overrides there)",
            crate::terrain_pathing::JSON_NAME,
            crate::terrain_pathing::FILE
        )));
    }
    crate::derived::can_move(project, false)?;
    flatten(&mut files)?;
    let written = write_changed(&map_dir, &files)?;
    let at = |p: &String| format!("{}/{p}", crate::project::MAP_DIR);
    let mut done = Converted { written: written.iter().map(at).collect(), removed: layout_paths.iter().map(at).collect() };
    if let Some(json) = &pathing {
        crate::project::write_atomic(&crate::terrain_pathing::json_path(project), json)?;
        done.written.push(crate::terrain_pathing::JSON_NAME.to_string());
    }
    for p in &layout_paths {
        fs::remove_file(crate::paths::join_rel(&map_dir, p))?;
    }
    remove_empty(&map_dir.join(DIR));
    let store = crate::derived::STORE_DIR.join("/");
    for name in crate::derived::out_of_store(project)? {
        done.removed.push(format!("{store}/{name}"));
        done.written.push(at(&name));
    }
    done.written.extend(ignore_store(project, &crate::derived::IGNORED[..1])?);
    if fresh {
        crate::derived::record_now(project)?;
    }
    Ok(done)
}

// ---- the flat files a split project stands for (the app's file layer) ----

/// The flat files (relative to `map/`) the split layout stands for: the app reads and writes these names in either
/// layout (`flat_views`, `read_flat`, `write_flat`), so its code knows one layout only.
pub const FLAT_NAMES: [&str; 4] = [FLAT_FILE, "war3map.doo.json", "war3mapUnits.doo.json", "war3map.w3r.json"];

/// One flat file a split project stands for, and the layout's files (relative to `map/`) it is made from: what
/// changes it when it changes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlatView {
    pub name: &'static str,
    pub sources: Vec<String>,
}

/// The flat files a project's `map/` folder stands for: None in the flat layout. The terrain is made from
/// `terrain.json` and every file under `map/terrain/` that isn't an object file of a kind the subterrains hold or a
/// subterrain's `pathing.txt` (a stray file there changes it too: reading it then says why); each object kind in `objects` from
/// `terrain.json` and its subterrains' files. A `terrain.json` that can't be read gives the terrain alone, made
/// from every file under `map/terrain/`: reading it says what is wrong, rather than the map losing its terrain.
pub fn flat_views(map_dir: &Path) -> Result<Option<Vec<FlatView>>> {
    if !is_split_on_disk(map_dir)? {
        return Ok(None);
    }
    let all: Vec<String> = crate::project::walk(&map_dir.join(DIR))?.into_iter().map(|r| format!("{DIR}/{r}")).collect();
    let layout = match fs::read(map_dir.join(LAYOUT_FILE)).map_err(Error::from).and_then(|b| Layout::parse(&b)) {
        Ok(l) => l,
        Err(_) => return Ok(Some(vec![FlatView { name: FLAT_FILE, sources: all }])),
    };
    let kinds: Vec<Kind> = KINDS.into_iter().filter(|k| layout.objects.has(*k)).collect();
    // With subterrains closed, the files of the open and halo ones only (a closed one's are never read, and its changes
    // don't change what the app sees); one that can't be told (a damaged choice) lists them all, and reading says why.
    let partial = crate::terrain_open::of_map_dir(map_dir, &layout).ok().flatten();
    let loaded = |i: usize| partial.as_ref().is_none_or(|p| p.loaded(i));
    let closed_dirs: Vec<String> = layout.subterrains.iter().enumerate().filter(|(i, _)| !loaded(*i)).map(|(_, s)| format!("{DIR}/{}/", s.folder)).collect();
    // The objects' files and the hand-painted pathing (`.w3proj/pathing.json`'s, not the terrain's).
    let mut objects: HashSet<String> = kinds.iter().flat_map(|k| layout.subterrains.iter().map(|s| s.object_path(*k))).collect();
    objects.extend(layout.subterrains.iter().map(crate::terrain_pathing::path));
    let ground = all.into_iter().filter(|p| !objects.contains(p) && !closed_dirs.iter().any(|d| p.starts_with(d.as_str())));
    // The choice itself: changing it changes what the flat files hold.
    let choice = format!("../{}", crate::terrain_open::NAME);
    let mut out = vec![FlatView { name: FLAT_FILE, sources: ground.chain(std::iter::once(choice.clone())).collect() }];
    for kind in kinds {
        let subs = layout.subterrains.iter().enumerate().filter(|(i, _)| loaded(*i)).map(|(_, s)| s.object_path(kind));
        let sources = std::iter::once(LAYOUT_FILE.to_string()).chain(subs).chain(std::iter::once(choice.clone())).collect();
        out.push(FlatView { name: kind.flat(), sources });
    }
    Ok(Some(out))
}

/// The layout's files and the flat object files beside them, read, then assembled into the flat files (`flatten`).
fn read_flat_files(map_dir: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut files = read_layout_files(map_dir)?;
    let flat_names: Vec<&str> = KINDS.iter().flat_map(|k| [k.flat(), k.raw()]).collect();
    read_if_there(map_dir, &flat_names, &mut files)?;
    if !flatten_with(&mut files, false)? {
        return Err(Error::Project(format!("the terrain isn't split (there is no map/{LAYOUT_FILE})")));
    }
    Ok(files)
}

/// The flat file `name` (one of `FLAT_NAMES`) of a split project's `map/` folder, assembled from the subterrains: the
/// bytes `w3proj terrain merge` would write. Anything the layout's files have wrong is an error, never an empty file.
pub fn read_flat(map_dir: &Path, name: &str) -> Result<Vec<u8>> {
    let mut files = match partial_of(map_dir)? {
        Some((layout, p)) => crate::terrain_open::read_flat_files(map_dir, &layout, &p)?,
        None => read_flat_files(map_dir)?,
    };
    files.remove(name).ok_or_else(|| Error::Project(format!("map/{name} isn't one the split terrain holds (map/{LAYOUT_FILE})")))
}

/// The layout of a split project's `map/` folder (read and checked).
fn layout_of(map_dir: &Path) -> Result<Layout> {
    Layout::parse(&fs::read(map_dir.join(LAYOUT_FILE)).map_err(|e| Error::Project(format!("map/{LAYOUT_FILE} can't be read: {e}")))?)
}

/// A split project's layout and partial load (`crate::terrain_open`) when some of its subterrains are closed; None when
/// all are open. A layout or choice that can't be read is an error.
fn partial_of(map_dir: &Path) -> Result<Option<(Layout, crate::terrain_open::Partial)>> {
    if !is_split_on_disk(map_dir)? {
        return Ok(None);
    }
    let layout = layout_of(map_dir)?;
    Ok(crate::terrain_open::of_map_dir(map_dir, &layout)?.map(|p| (layout, p)))
}

/// One write of a split project's files at a time (`write_flat`, `split_project`, `merge_project`): each reads what
/// the others left, so none puts back what another just wrote.
static FLAT_WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Writes the flat file `name` (one of `FLAT_NAMES`) of a split project: the files it stands for as they are now with
/// `bytes` in its place, sliced into the project's subterrains (`terrain.json` keeps them, its default corner and
/// objects' header follow the content). Only files whose bytes changed are written; the paths written (relative to
/// `map/`). Nothing is written when the content can't go into the layout as it is: a corner outside every subterrain
/// that isn't the default, another canvas size, content that doesn't parse or come back the same.
pub fn write_flat(map_dir: &Path, name: &str, bytes: &[u8]) -> Result<Vec<String>> {
    let _one = FLAT_WRITES.lock().unwrap_or_else(|e| e.into_inner());
    // Some subterrains closed: only the open ones' files are written (crate::terrain_open::write_flat).
    if let Some((mut layout, p)) = partial_of(map_dir)? {
        let files = crate::terrain_open::write_flat(map_dir, &mut layout, &p, name, bytes)?;
        return write_changed(map_dir, &files);
    }
    let layout = layout_of(map_dir)?;
    let mut files = read_flat_files(map_dir)?;
    if !files.contains_key(name) {
        return Err(Error::Project(format!("map/{name} isn't one the split terrain holds (map/{LAYOUT_FILE})")));
    }
    let mut layout = layout;
    // A creation number new in this write that lies above every id range: the range Studio's allocator took for it
    // once its subterrain's were full, recorded now (`crate::terrain_ids::record_new`).
    if let Some(kind) = KINDS.into_iter().find(|k| k.flat() == name && layout.objects.has(*k)) {
        let offset = layout.head.offset;
        let old: HashSet<u32> = objects::flat_numbers(kind, &files[name], offset)?.into_iter().map(|(n, _, _)| n).collect();
        let new: Vec<(u32, usize)> = objects::flat_numbers(kind, bytes, offset)?
            .into_iter()
            .filter(|(n, _, _)| !old.contains(n))
            .map(|(n, x, y)| (n, objects::owner(&layout.subterrains, offset, x, y)))
            .collect();
        crate::terrain_ids::record_new(&mut layout.subterrains, new);
    }
    files.insert(name.to_string(), bytes.to_vec());
    let t = w3e::terrain_from_text(&files[FLAT_FILE])?;
    if [t.width, t.height] != layout.corners() {
        return Err(Error::Project(format!(
            "the terrain is {}×{} corners, its subterrains cover a canvas of {}×{} (map/{LAYOUT_FILE}): a split terrain can't change size yet; merge it first (Merge Subterrains)",
            t.width,
            t.height,
            layout.head.width,
            layout.head.height
        )));
    }
    let flats: Flats = KINDS.into_iter().filter(|k| layout.objects.has(*k)).map(|k| (k, files[k.flat()].clone())).collect();
    let sliced = slice_terrain(&t, layout.subterrains, layout.default_corner, layout.doo_header, &flats)?;
    write_changed(map_dir, &sliced)
}

// ---- the Pathing tool's file of a split project (the app's file layer) ----

/// A split project's layout, for its pathing files.
fn pathing_layout(project: &Path) -> Result<(std::path::PathBuf, Layout)> {
    let map_dir = project.join(crate::project::MAP_DIR);
    let bytes = fs::read(map_dir.join(DIR).join("terrain.json")).map_err(|e| Error::Project(format!("map/{LAYOUT_FILE} can't be read: {e}")))?;
    Ok((map_dir, Layout::parse(&bytes)?))
}

/// A `.w3proj/pathing.json` on disk in a split project: the overrides are in the subterrains, so it is in the way.
fn pathing_json_in_the_way(project: &Path) -> Result<()> {
    let p = crate::terrain_pathing::json_path(project);
    if p.try_exists().map_err(|e| Error::Project(format!("{} can't be checked: {e}", p.display())))? {
        return Err(Error::Project(format!(
            "{} is there, but the terrain is split and its pathing overrides are in map/{DIR}/<subterrain>/{}: move {} away (its overrides aren't read)",
            crate::terrain_pathing::JSON_NAME,
            crate::terrain_pathing::FILE,
            crate::terrain_pathing::JSON_NAME
        )));
    }
    Ok(())
}

/// The subterrains' `pathing.txt` that are there (relative to `map/`), of a split project.
pub fn pathing_files(project: &Path) -> Result<Vec<String>> {
    let (map_dir, layout) = pathing_layout(project)?;
    if let Some(p) = crate::terrain_open::of_map_dir(&map_dir, &layout)? {
        return crate::terrain_open::pathing_files(&map_dir, &layout, &p);
    }
    let mut out = Vec::new();
    for p in layout.subterrains.iter().map(crate::terrain_pathing::path) {
        let at = crate::paths::join_rel(&map_dir, &p);
        if at.try_exists().map_err(|e| Error::Project(format!("map/{p} can't be checked: {e}")))? {
            out.push(p);
        }
    }
    Ok(out)
}

/// A split project's `.w3proj/pathing.json` as the Pathing tool reads it, assembled from the subterrains' `pathing.txt`
/// (`crate::terrain_pathing::assemble`): None when no subterrain has one. A damaged one is an error naming its line, never
/// fewer overrides; so is a real `.w3proj/pathing.json` beside them.
pub fn read_pathing(project: &Path) -> Result<Option<Vec<u8>>> {
    let (map_dir, layout) = pathing_layout(project)?;
    pathing_json_in_the_way(project)?;
    if let Some(p) = crate::terrain_open::of_map_dir(&map_dir, &layout)? {
        return crate::terrain_open::read_pathing(&map_dir, &layout, &p);
    }
    let mut files = BTreeMap::new();
    let paths: Vec<String> = layout.subterrains.iter().map(crate::terrain_pathing::path).collect();
    read_if_there(&map_dir, &paths.iter().map(String::as_str).collect::<Vec<_>>(), &mut files)?;
    crate::terrain_pathing::assemble(&layout, &|p| files.get(p).cloned())
}

/// Writes a split project's `.w3proj/pathing.json` into the subterrains' `pathing.txt` (`crate::terrain_pathing::slice`):
/// only files whose bytes change are written, a subterrain left without overrides loses its file. The paths written and
/// removed (relative to `map/`). Nothing is written when the content can't be kept there.
pub fn write_pathing(project: &Path, bytes: &[u8]) -> Result<(Vec<String>, Vec<String>)> {
    let _one = FLAT_WRITES.lock().unwrap_or_else(|e| e.into_inner());
    let (map_dir, layout) = pathing_layout(project)?;
    pathing_json_in_the_way(project)?;
    // Some subterrains closed: the open ones' files only, and only when nothing outside them changed.
    let (sliced, removable) = match crate::terrain_open::of_map_dir(&map_dir, &layout)? {
        Some(p) => crate::terrain_open::write_pathing(&map_dir, &layout, &p, bytes)?,
        None => {
            let sliced = crate::terrain_pathing::slice(bytes, &layout)?;
            let removable = layout.subterrains.iter().map(crate::terrain_pathing::path).filter(|p| !sliced.contains_key(p)).collect();
            (sliced, removable)
        }
    };
    let written = write_changed(&map_dir, &sliced)?;
    let mut removed = Vec::new();
    for p in removable {
        match fs::remove_file(crate::paths::join_rel(&map_dir, &p)) {
            Ok(()) => removed.push(p),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(Error::Project(format!("map/{p} can't be removed: {e}"))),
        }
    }
    Ok((written, removed))
}

/// A project split before derived files and pathing overrides moved out of `map/` and `.w3proj/pathing.json` (stage 1):
/// its derived files go into the store (`crate::derived::migrate`), its `.w3proj/pathing.json` into the subterrains'
/// `pathing.txt` when none has one yet (kept as `.w3proj/pathing.json.bak`). Nothing for a flat project. What moved,
/// relative to the project. A pathing.json that can't go into the subterrains is an error (it stays where it is).
pub fn migrate_split(project: &Path) -> Result<Vec<String>> {
    if !is_split_on_disk(&project.join(crate::project::MAP_DIR))? {
        return Ok(Vec::new());
    }
    let mut moved: Vec<String> = crate::derived::migrate(project)?.into_iter().map(|n| format!("{}/{n}", crate::project::MAP_DIR)).collect();
    if let Some(json) = crate::terrain_pathing::read_json(project)? {
        if pathing_files(project)?.is_empty() {
            // The same overrides in other files: derived files that followed them still do.
            let fresh = derived_fresh(project)?;
            let _one = FLAT_WRITES.lock().unwrap_or_else(|e| e.into_inner());
            let (map_dir, layout) = pathing_layout(project)?;
            let sliced = crate::terrain_pathing::slice(&json, &layout)?;
            let backup = crate::terrain_pathing::backup_path(project)?;
            write_changed(&map_dir, &sliced)?;
            fs::rename(crate::terrain_pathing::json_path(project), backup)?;
            moved.push(crate::terrain_pathing::JSON_NAME.to_string());
            if fresh {
                crate::derived::record_now(project)?;
            }
        }
    }
    Ok(moved)
}

/// Deletes a split project's `.w3proj/pathing.json`: every subterrain's `pathing.txt`. The paths removed (relative to `map/`).
pub fn delete_pathing(project: &Path) -> Result<Vec<String>> {
    let _one = FLAT_WRITES.lock().unwrap_or_else(|e| e.into_inner());
    let (map_dir, layout) = pathing_layout(project)?;
    // Some subterrains closed: only the open ones' files go (a closed one's, halo or not, is never touched).
    let partial = crate::terrain_open::of_map_dir(&map_dir, &layout)?;
    let open: HashSet<String> = layout.subterrains.iter().enumerate().filter(|(i, _)| partial.as_ref().is_none_or(|p| p.open[*i])).map(|(_, s)| crate::terrain_pathing::path(s)).collect();
    let mut removed = Vec::new();
    for p in pathing_files(project)?.into_iter().filter(|p| open.contains(p)) {
        fs::remove_file(crate::paths::join_rel(&map_dir, &p))?;
        removed.push(p);
    }
    Ok(removed)
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
        assert_eq!(layout.subterrains, vec![Subterrain { name: "main".into(), folder: "main".into(), x: 0, y: 0, w: 9, h: 7, id_ranges: vec![[10000, 19999]] }]);
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
        // idRange as a list of ranges (once one was full): read, written back the same; overlaps within one subterrain
        // and with another's are errors, as are an empty list and a range that isn't two numbers.
        let list = |r: &str| sub("a", "a", 0, 0, 5, 5, [1, 9]).replace("[1,9]", r);
        let two = ok(format!("{},{}", list("[[1,9],[20,29]]"), sub("b", "b", 5, 0, 5, 10, [10, 19]))).unwrap();
        assert_eq!(two.subterrains[0].id_ranges, [[1, 9], [20, 29]]);
        assert_eq!(two.subterrains[1].id_ranges, [[10, 19]]);
        let text = String::from_utf8(two.to_json().unwrap()).unwrap();
        assert!(text.contains("\"idRange\": [[1, 9], [20, 29]]\n") && text.contains("\"idRange\": [10, 19]\n"), "{text}");
        assert_eq!(Layout::parse(text.as_bytes()).unwrap().subterrains, two.subterrains);
        fails(list("[[1,9],[5,12]]"), "two idRanges of \"a\" overlap");
        fails(format!("{},{}", list("[[1,9],[15,29]]"), sub("b", "b", 5, 0, 5, 10, [10, 19])), "the idRanges of \"b\" and \"a\" overlap");
        fails(list("[]"), "idRange");
        fails(list("[[1,9],[3]]"), "idRange");
        fails(list("[[1,9],[9,1]]"), "starts after");
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

    /// Flat object files for `terrain`'s canvas (offset -576, 0.25; corners 9×7): a doodad and a unit in each
    /// corner of the canvas, a region, a special doodad.
    fn with_objects(files: &mut BTreeMap<String, Vec<u8>>, doodads_version: u32) {
        let pretty = |v: Value| [serde_json::to_vec_pretty(&v).unwrap(), b"\n".to_vec()].concat();
        let at = [(-500.0, 10.0), (400.0, 10.0), (-500.0, 700.0), (400.0, 700.0)];
        let doodads: Vec<Value> = at.iter().enumerate().map(|(i, (x, y))| serde_json::json!({"id": "LTlt", "position": [x, y, 0.0], "editorId": 10 - i})).collect();
        let units: Vec<Value> = at.iter().enumerate().map(|(i, (x, y))| serde_json::json!({"id": "hfoo", "position": [x, y, 0.0], "editorId": i})).collect();
        let mut doo = serde_json::json!({"format": "w3proj.doodads/1", "magic": "W3do", "version": doodads_version, "subversion": 11, "skinIds": true, "doodads": doodads, "specialVersion": 2, "specials": [{"id": "YTlc", "z": 0, "x": 7, "y": 6}]});
        if doodads_version != 8 {
            doo.as_object_mut().unwrap().shift_remove("skinIds");
        }
        files.insert("war3map.doo.json".into(), pretty(doo));
        files.insert("war3mapUnits.doo.json".into(), pretty(serde_json::json!({"format": "w3proj.units/1", "magic": "W3do", "version": 8, "subversion": 9, "skinIds": false, "units": units})));
        files.insert("war3map.w3r.json".into(), pretty(serde_json::json!({"format": "w3proj.regions/1", "version": 5, "regions": [{"left": 300.0, "bottom": 600.0, "name": "r", "index": 0}]})));
    }

    #[test]
    fn objects_split_with_the_terrain() {
        let t = terrain(12, false);
        let mut flat = flat_files(&t);
        with_objects(&mut flat, 8);
        let mut files = flat.clone();
        split(&mut files, &grid_2x2(t.width, t.height)).unwrap();
        for name in ["war3map.doo.json", "war3mapUnits.doo.json", "war3map.w3r.json"] {
            assert!(!files.contains_key(name), "{name} stayed flat");
        }
        let names = |path: &str, list: &str, key: &str| -> Vec<Value> {
            let v: Value = serde_json::from_slice(&files[path]).unwrap();
            v[list].as_array().unwrap().iter().map(|e| e[key].clone()).collect()
        };
        // Grid split at corner 4 (world x -64) and 3 (world y 384.25).
        assert_eq!(names("terrain/sw/units.json", "units", "editorId"), vec![Value::from(0)]);
        assert_eq!(names("terrain/ne/units.json", "units", "editorId"), vec![Value::from(3)]);
        assert_eq!(names("terrain/ne/doodads.json", "doodads", "editorId"), vec![Value::from(7)]);
        assert_eq!(names("terrain/ne/doodads.json", "specials", "id"), vec![Value::from("YTlc")]);
        assert_eq!(names("terrain/ne/regions.json", "regions", "name"), vec![Value::from("r")]);
        assert_eq!(names("terrain/nw/regions.json", "regions", "name"), Vec::<Value>::new());
        // dooHeader from the flat files' headers; what it lacks in objects; read and written again, the same text.
        let layout = Layout::parse(&files[LAYOUT_FILE]).unwrap();
        assert_eq!(layout.doo_header, Some(DooHeader { doodads_version: 8, doodads_subversion: 11, units_version: 8, units_subversion: 9, skin_ids: true }));
        let json = String::from_utf8(files[LAYOUT_FILE].clone()).unwrap();
        assert!(
            json.contains(
                "  \"objects\": {\n    \"doodads\": { \"magic\": \"W3do\", \"specialVersion\": 2 },\n    \"units\": { \"magic\": \"W3do\", \"skinIds\": false },\n    \"regions\": { \"version\": 5 }\n  },\n"
            ),
            "{json}"
        );
        assert_eq!(layout.to_json().unwrap(), files[LAYOUT_FILE]);
        let mut back = files.clone();
        assert!(flatten(&mut back).unwrap());
        assert_eq!(back, flat);

        // A flat object file next to the subterrains' of that kind: both layouts, an error.
        for name in ["war3map.doo.json", "war3map.doo"] {
            let mut both = files.clone();
            both.insert(name.into(), b"{}".to_vec());
            assert!(flatten(&mut both).unwrap_err().to_string().contains("both"), "{name}");
        }
        // A kind's file gone from a subterrain: an error, never a map without it.
        let mut gone = files.clone();
        gone.remove("terrain/se/regions.json");
        assert!(flatten(&mut gone).unwrap_err().to_string().contains("map/terrain/se/regions.json is missing"));
        // terrain.json without objects: the subterrains' object files aren't part of the layout.
        let mut no_objects = files.clone();
        let mut layout = Layout::parse(&files[LAYOUT_FILE]).unwrap();
        layout.objects = Heads::default();
        no_objects.insert(LAYOUT_FILE.into(), layout.to_json().unwrap());
        assert!(flatten(&mut no_objects).unwrap_err().to_string().contains("isn't part of the terrain layout"));
    }

    /// A kind without a flat file, or kept raw, has no files in the subterrains and stays as it is; a layout of
    /// stage 1a (no objects) keeps flat object files beside it.
    #[test]
    fn object_kinds_that_stay_flat() {
        let t = terrain(12, false);
        let mut flat = flat_files(&t);
        with_objects(&mut flat, 13);
        flat.remove("war3mapUnits.doo.json");
        let doo = flat.remove("war3map.doo.json").unwrap();
        flat.insert("war3map.doo".into(), doo);
        let mut files = flat.clone();
        split(&mut files, &[]).unwrap();
        assert!(files.contains_key("war3map.doo") && files.contains_key("terrain/main/regions.json"));
        assert!(!files.keys().any(|k| k.ends_with("units.json") || k.ends_with("doodads.json")), "{:?}", files.keys());
        let layout = Layout::parse(&files[LAYOUT_FILE]).unwrap();
        assert_eq!(layout.doo_header, None);
        assert_eq!(layout.objects, Heads { regions: Some(5), ..Heads::default() });
        let mut back = files.clone();
        flatten(&mut back).unwrap();
        assert_eq!(back, flat);
        // Stage 1a: only the terrain split, the objects flat.
        let mut ground_only = flat_files(&t);
        let mut grounds = ground_only.clone();
        split(&mut grounds, &[]).unwrap();
        with_objects(&mut ground_only, 8);
        with_objects(&mut grounds, 8);
        flatten(&mut grounds).unwrap();
        assert_eq!(grounds, ground_only);
        // A flat object file named in another case can't go into the subterrains.
        let mut odd = flat_files(&t);
        odd.insert("War3map.w3r.json".into(), b"{}".to_vec());
        assert!(split(&mut odd, &[]).unwrap_err().to_string().contains("rename it to war3map.w3r.json"));
    }

    /// An object moved over a seam changes file on the next slice, with its creation number; only the two files
    /// it left and entered are written.
    #[test]
    fn an_object_moved_over_a_seam_changes_file() {
        let dir = std::env::temp_dir().join(format!("w3proj-terrain-objects-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let t = terrain(12, false);
        let mut files = flat_files(&t);
        files.remove("war3map.j");
        with_objects(&mut files, 8);
        let flat = files.clone();
        split(&mut files, &grid_2x2(t.width, t.height)).unwrap();
        write_changed(&dir, &files).unwrap();
        // Unit 0 goes from the south-west to the south-east.
        let mut sync = flat.clone();
        let units = String::from_utf8(sync["war3mapUnits.doo.json"].clone()).unwrap().replacen("-500.0", "100.0", 1);
        sync.insert("war3mapUnits.doo.json".into(), units.into_bytes());
        prepare_sync(&dir, &mut sync).unwrap();
        assert_eq!(write_changed(&dir, &sync).unwrap(), vec!["terrain/se/units.json".to_string(), "terrain/sw/units.json".to_string()]);
        let se: Value = serde_json::from_slice(&sync["terrain/se/units.json"]).unwrap();
        let ids: Vec<&Value> = se["units"].as_array().unwrap().iter().map(|u| &u["editorId"]).collect();
        assert_eq!(ids, vec![&Value::from(0), &Value::from(1)]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Stage 3 on disk: a split moves the derived files into the store and `.w3proj/pathing.json` into the subterrains'
    /// `pathing.txt` (kept as `.bak`), the record stays fresh; what would refuse refuses before anything is written; a
    /// project split before (its derived files in map/, a pathing.json) is moved by `migrate_split`; a merge gives
    /// both back byte for byte.
    #[test]
    fn a_split_moves_derived_files_and_pathing_and_a_merge_moves_them_back() {
        let dir = std::env::temp_dir().join(format!("w3proj-terrain-stage3-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        crate::project::create(&dir, None).unwrap();
        let map_dir = dir.join("map");
        let t = terrain(12, false);
        let mut flat = flat_files(&t);
        with_objects(&mut flat, 8);
        write_changed(&map_dir, &flat).unwrap();
        fs::write(map_dir.join("war3map.wpm"), b"pathing").unwrap();
        crate::derived::record_now(&dir).unwrap();
        let json = crate::terrain_pathing::sample_json([t.width, t.height]).unwrap();
        let pj = crate::terrain_pathing::json_path(&dir);
        fs::write(&pj, &json).unwrap();
        let snapshot = || crate::project::walk(&dir).unwrap().into_iter().map(|p| (p.clone(), fs::read(crate::paths::join_rel(&dir, &p)).unwrap())).collect::<BTreeMap<_, _>>();
        let grid = grid_2x2(t.width, t.height);

        // Refused before anything is written: a store file that differs, a pathing.json a split can't keep.
        let store = crate::derived::store_dir(&dir);
        fs::create_dir_all(&store).unwrap();
        fs::write(store.join("war3map.wpm"), b"other").unwrap();
        let before = snapshot();
        assert!(split_project(&dir, &grid).unwrap_err().to_string().contains("both there and differ"));
        assert_eq!(snapshot(), before);
        fs::remove_file(store.join("war3map.wpm")).unwrap();
        let noted = String::from_utf8(json.clone()).unwrap().replacen("\"format\"", "\"note\": 1,\n  \"format\"", 1);
        fs::write(&pj, &noted).unwrap();
        let before = snapshot();
        assert!(split_project(&dir, &grid).unwrap_err().to_string().contains("\"note\""));
        assert_eq!(snapshot(), before);
        fs::write(&pj, &json).unwrap();

        let done = split_project(&dir, &grid).unwrap();
        assert!(!map_dir.join("war3map.wpm").exists() && fs::read(store.join("war3map.wpm")).unwrap() == b"pathing");
        assert!(done.removed.contains(&"map/war3map.wpm".to_string()) && done.removed.contains(&".w3proj/pathing.json".to_string()), "{done:?}");
        assert!(!pj.exists() && fs::read(pj.with_file_name("pathing.json.bak")).unwrap() == json);
        assert_eq!(read_pathing(&dir).unwrap().as_deref(), Some(&json[..]));
        assert!(pathing_files(&dir).unwrap().len() >= 3, "the overrides cross the seams");
        assert_eq!(crate::derived::check(&dir).unwrap(), crate::derived::Freshness::Fresh);
        assert!(fs::read_to_string(dir.join(".gitignore")).unwrap().contains("/.w3proj/derived-from.json\n"));

        // As a project split before stage 3 has it: migrated, the record still fresh.
        fs::rename(store.join("war3map.wpm"), map_dir.join("war3map.wpm")).unwrap();
        delete_pathing(&dir).unwrap();
        fs::write(&pj, &json).unwrap();
        let moved = migrate_split(&dir).unwrap();
        assert_eq!(moved, ["map/war3map.wpm", ".w3proj/pathing.json"]);
        assert!(store.join("war3map.wpm").is_file() && !pj.exists() && pj.with_file_name("pathing.json.bak2").is_file());
        assert_eq!(read_pathing(&dir).unwrap().as_deref(), Some(&json[..]));
        assert_eq!(crate::derived::check(&dir).unwrap(), crate::derived::Freshness::Fresh);
        assert!(migrate_split(&dir).unwrap().is_empty(), "nothing more to move");

        merge_project(&dir).unwrap();
        assert_eq!(fs::read(&pj).unwrap(), json, "pathing.json back byte for byte");
        assert_eq!(fs::read(map_dir.join("war3map.wpm")).unwrap(), b"pathing");
        assert!(!store.exists());
        for (name, bytes) in &flat {
            assert_eq!(&fs::read(map_dir.join(name)).unwrap(), bytes, "{name}");
        }
        assert_eq!(crate::derived::check(&dir).unwrap(), crate::derived::Freshness::Fresh);
        let _ = fs::remove_dir_all(&dir);
    }

    /// The flat names of a split project: listed with what they are made from, read as merge would write them,
    /// written back into the owning subterrain only; a write that can't be kept writes nothing; two writes at once
    /// both land.
    #[test]
    fn flat_files_of_a_split_project() {
        let dir = std::env::temp_dir().join(format!("w3proj-terrain-flat-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(flat_views(&dir).unwrap(), None, "a flat project has no flat views");
        let t = terrain(12, false);
        let mut flat = flat_files(&t);
        flat.remove("war3map.j");
        with_objects(&mut flat, 8);
        let mut files = flat.clone();
        split(&mut files, &grid_2x2(t.width, t.height)).unwrap();
        write_changed(&dir, &files).unwrap();

        let views = flat_views(&dir).unwrap().unwrap();
        assert_eq!(views.iter().map(|v| v.name).collect::<Vec<_>>(), FLAT_NAMES.to_vec());
        assert!(views[0].sources.contains(&"terrain/terrain.json".to_string()) && views[0].sources.contains(&"terrain/ne/terrain.txt".to_string()));
        assert!(!views[0].sources.iter().any(|s| s.ends_with("units.json")), "{:?}", views[0].sources);
        // The choice of open subterrains too (`crate::terrain_open`): changing it changes what the flat files hold.
        assert_eq!(
            views[2].sources,
            ["terrain/terrain.json", "terrain/sw/units.json", "terrain/se/units.json", "terrain/nw/units.json", "terrain/ne/units.json", "../.w3proj/open-subterrains.json"]
        );
        for name in FLAT_NAMES {
            assert_eq!(read_flat(&dir, name).unwrap(), flat[name], "{name}");
        }

        // The same content: nothing written. One corner in the north-east: that subterrain's ground only.
        assert!(write_flat(&dir, FLAT_FILE, &flat[FLAT_FILE]).unwrap().is_empty());
        let mut edited = t.clone();
        edited.corners[(t.height - 1) * t.width + t.width - 1].height += 4;
        let text = w3e::terrain_text(&edited).unwrap();
        assert_eq!(write_flat(&dir, FLAT_FILE, &text).unwrap(), ["terrain/ne/terrain.txt"]);
        assert_eq!(read_flat(&dir, FLAT_FILE).unwrap(), text);
        // A unit over the seam: the two files it left and entered.
        let units = String::from_utf8(flat["war3mapUnits.doo.json"].clone()).unwrap().replacen("-500.0", "100.0", 1);
        assert_eq!(write_flat(&dir, "war3mapUnits.doo.json", units.as_bytes()).unwrap(), ["terrain/se/units.json", "terrain/sw/units.json"]);
        assert!(objects::same(&read_flat(&dir, "war3mapUnits.doo.json").unwrap(), units.as_bytes()));

        // Refused, nothing written: another canvas size, text that isn't a terrain, a name the layout doesn't hold.
        let before = read_layout_files(&dir).unwrap();
        let mut bigger = edited.clone();
        bigger.width += 1;
        bigger.corners = vec![bigger.corners[0]; bigger.width * bigger.height];
        let e = write_flat(&dir, FLAT_FILE, &w3e::terrain_text(&bigger).unwrap()).unwrap_err().to_string();
        assert!(e.contains("can't change size"), "{e}");
        assert!(write_flat(&dir, FLAT_FILE, b"not a terrain").is_err());
        assert!(write_flat(&dir, "war3map.w3c.json", b"{}").is_err());
        assert_eq!(read_layout_files(&dir).unwrap(), before, "a refused write changes nothing");

        // Two writes at once, of different files: each keeps the other's change.
        let mut moved = edited.clone();
        moved.corners[0].height += 8;
        let text2 = w3e::terrain_text(&moved).unwrap();
        let regions = String::from_utf8(flat["war3map.w3r.json"].clone()).unwrap().replace("\"r\"", "\"renamed\"");
        std::thread::scope(|s| {
            s.spawn(|| write_flat(&dir, FLAT_FILE, &text2).unwrap());
            s.spawn(|| write_flat(&dir, "war3map.w3r.json", regions.as_bytes()).unwrap());
        });
        assert_eq!(read_flat(&dir, FLAT_FILE).unwrap(), text2);
        assert!(String::from_utf8(read_flat(&dir, "war3map.w3r.json").unwrap()).unwrap().contains("renamed"));

        // A terrain.json that can't be read: the terrain alone is listed, and reading it says why.
        fs::write(dir.join(LAYOUT_FILE), b"{").unwrap();
        let views = flat_views(&dir).unwrap().unwrap();
        assert_eq!(views.iter().map(|v| v.name).collect::<Vec<_>>(), [FLAT_FILE]);
        assert!(read_flat(&dir, FLAT_FILE).unwrap_err().to_string().contains("isn't JSON"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// A creation number new in a write and above every id range (what Studio's allocator hands out once a
    /// subterrain's ranges are full): its block is recorded in terrain.json for the subterrain holding the object, in
    /// the same write. Numbers already there, inside a range or below the top record nothing.
    #[test]
    fn a_new_number_above_every_range_records_its_range() {
        let dir = std::env::temp_dir().join(format!("w3proj-terrain-ranges-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let t = terrain(12, false);
        let mut flat = flat_files(&t);
        flat.remove("war3map.j");
        with_objects(&mut flat, 8);
        let mut files = flat.clone();
        split(&mut files, &grid_2x2(t.width, t.height)).unwrap();
        write_changed(&dir, &files).unwrap();
        let ranges = |name: &str| Layout::parse(&fs::read(dir.join(LAYOUT_FILE)).unwrap()).unwrap().subterrains.into_iter().find(|s| s.name == name).unwrap().id_ranges;
        assert_eq!(ranges("sw"), [[10000, 19999]]);
        // The flat units with one more at the end (so no other entry's place changes).
        let unit_at = |n: u32, x: f64, y: f64| {
            let mut doc: Value = serde_json::from_slice(&flat["war3mapUnits.doo.json"]).unwrap();
            doc["units"].as_array_mut().unwrap().push(serde_json::json!({"id": "hfoo", "position": [x, y, 0.0], "editorId": n}));
            serde_json::to_string_pretty(&doc).unwrap() + "\n"
        };
        let units = |n: u32| unit_at(n, -500.0, 10.0);
        // A number typed by hand below the top, and one inside ne's range, in sw: nothing recorded.
        for n in [15, 40000] {
            let written = write_flat(&dir, "war3mapUnits.doo.json", units(n).as_bytes()).unwrap();
            assert_eq!(written, ["terrain/sw/units.json"], "{n}");
        }
        // 50003 in sw: above every range (ne's ends at 49999).
        let text = units(50003);
        let written = write_flat(&dir, "war3mapUnits.doo.json", text.as_bytes()).unwrap();
        assert_eq!(written, ["terrain/sw/units.json", "terrain/terrain.json"]);
        assert_eq!(ranges("sw"), [[10000, 19999], [50000, 59999]]);
        let json = String::from_utf8(fs::read(dir.join(LAYOUT_FILE)).unwrap()).unwrap();
        assert!(json.contains("\"idRange\": [[10000, 19999], [50000, 59999]]\n") && json.contains("\"idRange\": [20000, 29999]\n"), "{json}");
        // The same file again (the number isn't new now), and the object moved to ne: nothing more recorded.
        assert!(write_flat(&dir, "war3mapUnits.doo.json", text.as_bytes()).unwrap().is_empty());
        let moved = unit_at(50003, 400.0, 700.0);
        assert_eq!(write_flat(&dir, "war3mapUnits.doo.json", moved.as_bytes()).unwrap(), ["terrain/ne/units.json", "terrain/sw/units.json"]);
        assert_eq!(ranges("ne"), [[40000, 49999]]);
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
