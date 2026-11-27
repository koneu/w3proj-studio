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
//! project's rectangles (`slice`), and only files whose bytes changed are written (`write_changed`). The file layer
//! (reading `map/terrain/`, writing what changed, removing what a slice no longer has) is the one the trigger folders
//! use too (`crate::folder_codec`).
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

use crate::folder_codec::{read_if_there, Files, Folder};
use crate::terrain_objects::{self as objects, Flats, Heads, Kind, KINDS};
use crate::w3e::{self, Corner, Terrain};
use crate::{Error, Result};

pub const FORMAT: &str = "w3proj.terrain/1";
/// The layout's folder under `map/`.
pub const DIR: &str = "terrain";
/// The layout's folder (`crate::folder_codec`).
pub const FOLDER: Folder = Folder::new(DIR);
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
/// `default_corner` can't be stored: an error. Creation numbers found twice: `kept` as for
/// `terrain_objects::slice` (None for an import, the project's list for a write over its files). The result is read
/// again and compared with `t` and `flats` before it is returned.
fn slice_terrain(
    t: &Terrain,
    subterrains: Vec<Subterrain>,
    default_corner: Corner,
    doo_header: Option<DooHeader>,
    flats: &Flats,
    kept: Option<&objects::Twice>,
) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut head = t.clone();
    head.corners = Vec::new();
    let mut layout = Layout { head, default_corner, doo_header, objects: Heads::default(), subterrains };
    layout.check()?;
    let (heads, object_files) = objects::slice(flats, &layout.subterrains, t.offset, kept)?;
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
    slice_terrain(t, subterrains, default_corner, None, flats, None)
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
    FOLDER.holds(path)
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

/// The whole terrain of a split project whose `map/` folder this is, every subterrain read whatever the open set
/// (`crate::terrain_open`), as `war3map.w3e.txt` text, with its subterrains: what the seam check looks at. None for a
/// flat project; a layout or ground file that can't be read is an error.
pub fn whole_ground(map_dir: &Path) -> Result<Option<(Vec<u8>, Vec<Subterrain>)>> {
    if !is_split_on_disk(map_dir)? {
        return Ok(None);
    }
    let layout = layout_of(map_dir)?;
    let mut ground = BTreeMap::new();
    read_if_there(map_dir, &layout.subterrains.iter().map(Subterrain::ground_path).collect::<Vec<_>>().iter().map(String::as_str).collect::<Vec<_>>(), &mut ground)?;
    let t = assemble_terrain(&layout, &|p| ground.get(p).cloned())?;
    Ok(Some((w3e::terrain_text(&t)?, layout.subterrains)))
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
    if let Some(k) = FOLDER.first_in(files) {
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
        return split_incoming(map_dir, files);
    }
    let layout = Layout::parse(&fs::read(map_dir.join(LAYOUT_FILE))?)?;
    let pathing: Vec<String> = layout.subterrains.iter().map(crate::terrain_pathing::path).collect();
    if let Some(k) = FOLDER.first_in(files) {
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
    // A map whose size or position changed (Map Size in the World Editor): the subterrains and the painted pathing
    // follow as with Studio's own Map Size.
    let moved = [t.width, t.height] != layout.corners() || t.offset != layout.head.offset;
    let mut painted = BTreeMap::new();
    read_if_there(map_dir, &pathing.iter().map(String::as_str).collect::<Vec<_>>(), &mut painted)?;
    let sliced = if moved {
        resized_files(&painted, &layout, &t, &flats, None)
    } else {
        slice_terrain(&t, layout.subterrains, layout.default_corner, layout.doo_header, &flats, None)
    }
    .map_err(|e| {
        Error::Project(format!("the map's terrain and objects don't fit the project's subterrains ({e}): merge the terrain first (`w3proj terrain merge`), then split it again"))
    })?;
    files.remove(&flat);
    for name in &names {
        files.remove(name);
    }
    files.extend(sliced);
    if !moved {
        files.extend(painted);
    }
    Ok(crate::derived::take(files))
}

/// A sync into a project without a terrain layout yet (a new project): the map's terrain and placed objects are cut
/// into one subterrain `main` over the whole canvas (`split`), its derived files taken out for the store, as in a split
/// project. The split layout is the only one a sync writes. The files stay flat, and nothing is returned, where there
/// is nothing to split or it can't be: a flat terrain file still on disk (a project `flat_on_disk` couldn't convert),
/// a map without terrain (a campaign), a terrain kept raw, files of the map's own under `terrain/`.
fn split_incoming(map_dir: &Path, files: &mut BTreeMap<String, Vec<u8>>) -> Result<BTreeMap<String, Vec<u8>>> {
    if flat_on_disk(map_dir)? || key(files, FLAT_FILE).is_none() {
        return Ok(BTreeMap::new());
    }
    let mut cut = files.clone();
    if split(&mut cut, &[]).is_err() {
        return Ok(BTreeMap::new());
    }
    *files = cut;
    Ok(crate::derived::take(files))
}

/// Whether a project's `map/` folder holds a flat terrain file (text or raw): the layout before the split one became
/// the only one.
pub fn flat_on_disk(map_dir: &Path) -> Result<bool> {
    for name in [FLAT_FILE, FLAT_RAW] {
        if map_dir.join(name).try_exists().map_err(|e| Error::Project(format!("map/{name} can't be checked: {e}")))? {
            return Ok(true);
        }
    }
    Ok(false)
}

pub use crate::folder_codec::write_changed;

/// The split layout's files on disk (relative to `map/`), read; a project without `map/terrain/`
/// gives none.
pub(crate) fn read_layout_files(map_dir: &Path) -> Result<Files> {
    FOLDER.read_disk(map_dir)
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

/// `.gitignore` gets the derived files' store and record (`crate::derived::IGNORED`); the path written, if it changed.
fn ignore_store(project: &Path, lines: &[&str]) -> Result<Option<String>> {
    Ok(crate::derived::ensure_lines(project, lines)?.then(|| ".gitignore".to_string()))
}

/// Moves `.w3proj/pathing.json` to `backup` (in `build/`, made when it isn't there).
fn move_to_backup(project: &Path, backup: &Path) -> Result<()> {
    if let Some(dir) = backup.parent() {
        fs::create_dir_all(dir)?;
    }
    Ok(fs::rename(crate::terrain_pathing::json_path(project), backup)?)
}

/// Splits a flat project's terrain and placed objects into `map/terrain/` (`split`): the layout's
/// files are written first, then `map/war3map.w3e.txt` and the flat object files go. Nothing is
/// written when the split can't be lossless. An object file packed raw stays where it is.
///
/// The derived files (`crate::derived::FILES`) move from `map/` into the store `build/derived/`, which
/// `.gitignore` then ignores with the record `build/derived-from.json` (still valid: the sources are
/// the same terrain). The Pathing tool's `.w3proj/pathing.json` goes into the subterrains' `pathing.txt`
/// (`crate::terrain_pathing`) and is kept as `build/pathing.json.bak`; one that can't go there
/// refuses the split.
pub fn split_project(project: &Path, rects: &[Rect]) -> Result<Converted> {
    crate::derived::move_local(project)?;
    let _one = FLAT_WRITES.lock().unwrap_or_else(|e| e.into_inner());
    let SplitPlan { files, before, pathing_json, .. } = split_plan(project, rects)?;
    let map_dir = project.join(crate::project::MAP_DIR);
    let fresh = derived_fresh(project)?;
    let backup = pathing_json.as_ref().map(|_| crate::terrain_pathing::backup_path(project)).transpose()?;
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
        move_to_backup(project, &backup)?;
        done.removed.push(crate::terrain_pathing::JSON_NAME.to_string());
        done.written.push(format!("build/{}", backup.file_name().unwrap_or_default().to_string_lossy()));
    }
    done.written.extend(ignore_store(project, &crate::derived::IGNORED)?);
    if fresh {
        crate::derived::record_now(project)?;
    }
    Ok(done)
}

/// What a split of a flat project into `rects` makes, before anything is written: the flat files read (`old`), the
/// layout's files (`files`, the pathing overrides sliced in), the flat files there were (`before`), the Pathing tool's
/// `.w3proj/pathing.json` if there is one. Everything that refuses a split refuses here.
struct SplitPlan {
    old: BTreeMap<String, Vec<u8>>,
    files: BTreeMap<String, Vec<u8>>,
    before: Vec<String>,
    pathing_json: Option<Vec<u8>>,
}

fn split_plan(project: &Path, rects: &[Rect]) -> Result<SplitPlan> {
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
    let old = files.clone();
    split(&mut files, rects)?;
    // Everything that could refuse, before anything is written.
    let pathing_json = crate::terrain_pathing::read_json(project)?;
    if let Some(json) = &pathing_json {
        let layout = Layout::parse(&files[LAYOUT_FILE])?;
        let sliced = crate::terrain_pathing::slice(json, &layout).map_err(|e| Error::Project(format!("{e}: fix or move away {} first", crate::terrain_pathing::JSON_NAME)))?;
        files.extend(sliced);
    }
    crate::derived::can_move(project, true)?;
    Ok(SplitPlan { old, files, before, pathing_json })
}

/// Merges a split project's terrain and objects back into `map/war3map.w3e.txt` and the flat object
/// files (`flatten`): those are written first, then the layout's files go. The subterrains' `pathing.txt`
/// become `.w3proj/pathing.json` again (none: no file), the store's derived files go back into `map/`
/// (`.gitignore` keeps ignoring the store, which a flat project doesn't have).
pub fn merge_project(project: &Path) -> Result<Converted> {
    crate::derived::move_local(project)?;
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
    FOLDER.remove_stale(&map_dir, &layout_paths, &Files::new())?;
    FOLDER.remove_empty(&map_dir, None);
    let store = crate::derived::STORE_DIR.join("/");
    for name in crate::derived::out_of_store(project)? {
        done.removed.push(format!("{store}/{name}"));
        done.written.push(at(&name));
    }
    done.written.extend(ignore_store(project, &crate::derived::IGNORED)?);
    if fresh {
        crate::derived::record_now(project)?;
    }
    Ok(done)
}

// ---- new, resized, renamed and joined subterrains ----

/// One subterrain of a new layout (`relayout`): its name and rectangle, and the subterrains of the current layout it
/// continues (`from`): one for a subterrain kept, moved, resized or renamed, several for subterrains joined into one,
/// none for a new one. `from` None: the subterrain of the same name if there is one, else none.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Planned {
    pub rect: Rect,
    pub from: Option<Vec<String>>,
}

/// `NAME:x,y,w,h` (the subterrain of that name, or a new one) or `NAME=OLD[+OLD…]:x,y,w,h` (what it continues: a
/// rename, or several joined; `NAME=:x,y,w,h` a new one even where the name was there).
impl std::str::FromStr for Planned {
    type Err = String;
    fn from_str(s: &str) -> std::result::Result<Planned, String> {
        let (head, nums) = s.rsplit_once(':').ok_or_else(|| format!("\"{s}\" isn't NAME[=OLD+OLD]:x,y,w,h"))?;
        let (name, from) = match head.split_once('=') {
            Some((n, f)) => (n, Some(f.split('+').map(str::trim).filter(|x| !x.is_empty()).map(str::to_string).collect())),
            None => (head, None),
        };
        let rect: Rect = format!("{name}:{nums}").parse()?;
        Ok(Planned { rect, from })
    }
}

/// The first block of 10000 creation numbers above every range of `subs` (1 at least).
fn next_block(subs: &[Subterrain]) -> u64 {
    subs.iter().flat_map(|s| s.id_ranges.iter()).map(|r| u64::from(r[1]) / 10000 + 1).max().unwrap_or(1)
}

/// Block `block`'s id range, for the new subterrain `name`.
fn block_range(block: u64, name: &str) -> Result<[u32; 2]> {
    let none = || Error::Project(format!("no id range is left above the others for \"{name}\""));
    let lo = u32::try_from(block * 10000).map_err(|_| none())?;
    Ok([lo, lo.checked_add(9999).ok_or_else(none)?])
}

/// The split project files (relative to `map/`) cut into a new set of subterrains (`plan`): the whole terrain, the
/// placed objects and regions and the pathing overrides are read from the current layout and sliced into the new one,
/// so nothing changes but which file holds what. Objects go where their position lies (`terrain_objects`, as a split).
/// A subterrain keeps the id ranges of those it continues (joined ones: all of theirs) and its folder when it keeps
/// its name; a new one gets the next block of 10000 above every range. `terrain.json`'s canvas, palettes, default
/// corner and object headers stay. Refused, `files` unchanged, when the new layout isn't one (overlaps, past the canvas,
/// names or folders twice), a corner it leaves uncovered differs from the default corner, a pathing override would lie
/// in no subterrain, an old subterrain is continued twice or isn't there, or a folder would only change its case.
pub fn relayout(files: &mut BTreeMap<String, Vec<u8>>, plan: &[Planned]) -> Result<()> {
    if !is_split(files)? {
        return Err(Error::Project(format!("the terrain isn't split (there is no map/{LAYOUT_FILE})")));
    }
    if plan.is_empty() {
        return Err(Error::Project("there has to be one subterrain at least".into()));
    }
    let old = Layout::parse(&files[LAYOUT_FILE])?;
    let mut block = next_block(&old.subterrains);
    let mut taken: HashMap<&str, &str> = HashMap::new();
    let mut subs = Vec::with_capacity(plan.len());
    for p in plan {
        let name = p.rect.name.as_str();
        let from: Vec<&str> = match &p.from {
            Some(f) => f.iter().map(String::as_str).collect(),
            None => old.subterrains.iter().filter(|s| s.name == name).map(|s| s.name.as_str()).collect(),
        };
        let mut ranges = Vec::new();
        let mut folder = name.to_string();
        for f in &from {
            let o = old.subterrains.iter().find(|s| s.name == *f).ok_or_else(|| Error::Project(format!("there is no subterrain \"{f}\" to make \"{name}\" from")))?;
            if let Some(other) = taken.insert(o.name.as_str(), name) {
                return Err(Error::Project(format!("subterrain \"{f}\" can't go into both \"{other}\" and \"{name}\"")));
            }
            ranges.extend(o.id_ranges.iter().copied());
            if o.name == name {
                folder = o.folder.clone();
            }
        }
        if let Some(o) = old.subterrains.iter().find(|o| o.folder != folder && o.folder.eq_ignore_ascii_case(&folder)) {
            return Err(Error::Project(format!(
                "folder \"{}\" can't become \"{folder}\": only the case changes, and Windows and macOS see one folder (rename it to another name first)",
                o.folder
            )));
        }
        if ranges.is_empty() {
            ranges.push(block_range(block, name)?);
            block += 1;
        }
        ranges.sort();
        subs.push(Subterrain { name: name.to_string(), folder, x: p.rect.x, y: p.rect.y, w: p.rect.w, h: p.rect.h, id_ranges: ranges });
    }
    // The flat form (what the map is), then sliced into the new rectangles; nothing of it is kept if that refuses.
    let mut flat = files.clone();
    flatten(&mut flat)?;
    let pathing = crate::terrain_pathing::assemble(&old, &|p| files.get(p).cloned())?;
    let t = w3e::terrain_from_text(&flat[FLAT_FILE])?;
    let (flats, _) = flat_object_files(&flat)?;
    let mut new = slice_terrain(&t, subs, old.default_corner, old.doo_header.clone(), &flats, Some(&old.objects.twice))?;
    if let Some(json) = pathing {
        let layout = Layout::parse(&new[LAYOUT_FILE])?;
        new.extend(crate::terrain_pathing::slice(&json, &layout).map_err(|e| Error::Project(format!("the pathing overrides don't fit the new subterrains: {e}")))?);
    }
    files.retain(|k, _| !under_dir(k));
    files.extend(new);
    Ok(())
}

/// `relayout` of a split project on disk: the new layout's files written (only those whose bytes changed), then the
/// old files it doesn't have removed (a renamed subterrain's folder goes). Nothing is written when it refuses. The
/// local choice of open subterrains (`build/open-subterrains.json`) follows: a subterrain is open when one it
/// continues was, or when it is new. The derived files' record is made again when it said they followed (the map is
/// the same).
pub fn relayout_project(project: &Path, plan: &[Planned]) -> Result<Converted> {
    let _one = FLAT_WRITES.lock().unwrap_or_else(|e| e.into_inner());
    relayout_on_disk(project, plan)
}

/// `relayout_project` without taking `FLAT_WRITES` (the caller holds it).
fn relayout_on_disk(project: &Path, plan: &[Planned]) -> Result<Converted> {
    let map_dir = project.join(crate::project::MAP_DIR);
    if !is_split_on_disk(&map_dir)? {
        return Err(Error::Project(format!("the terrain isn't split (there is no map/{LAYOUT_FILE})")));
    }
    let mut files = read_layout_files(&map_dir)?;
    // Flat object files beside the layout: flatten refuses a kind in both.
    let flat_names: Vec<&str> = KINDS.iter().flat_map(|k| [k.flat(), k.raw()]).collect();
    read_if_there(&map_dir, &flat_names, &mut files)?;
    let before: Vec<String> = files.keys().filter(|k| under_dir(k)).cloned().collect();
    let fresh = derived_fresh(project)?;
    let opened = match fs::read(crate::terrain_open::path(project)) {
        Ok(b) => Some(crate::terrain_open::parse(&b)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(Error::Project(format!("{} can't be read: {e}", crate::terrain_open::NAME))),
    };
    let old = Layout::parse(&files[LAYOUT_FILE])?;
    relayout(&mut files, plan)?;
    let new = Layout::parse(&files[LAYOUT_FILE])?;
    let open_now: Option<Vec<String>> = opened.map(|was| {
        plan.iter()
            .filter(|p| {
                let from: Vec<&str> = match &p.from {
                    Some(f) => f.iter().map(String::as_str).collect(),
                    None => old.subterrains.iter().filter(|s| s.name == p.rect.name).map(|s| s.name.as_str()).collect(),
                };
                from.is_empty() || from.iter().any(|f| was.iter().any(|w| w == f))
            })
            .map(|p| p.rect.name.clone())
            .collect()
    });
    let layout_files: BTreeMap<String, Vec<u8>> = files.into_iter().filter(|(k, _)| under_dir(k)).collect();
    let written = write_changed(&map_dir, &layout_files)?;
    let removed = FOLDER.remove_stale(&map_dir, &before, &layout_files)?;
    for s in &old.subterrains {
        if !new.subterrains.iter().any(|n| n.folder == s.folder) {
            FOLDER.remove_empty(&map_dir, Some(&s.folder));
        }
    }
    if let Some(names) = open_now {
        let all = new.subterrains.iter().map(|s| s.name.clone()).collect::<Vec<_>>();
        crate::terrain_open::store(project, &new, if names.is_empty() { &all } else { &names })?;
    }
    if fresh {
        crate::derived::record_now(project)?;
    }
    let at = |p: &String| format!("{}/{p}", crate::project::MAP_DIR);
    Ok(Converted { written: written.iter().map(at).collect(), removed: removed.into_iter().map(at).collect() })
}

// ---- the layout editor: what a change would do, and taking one back ----

/// One subterrain of a layout as the layout editor previews it (`relayout_preview`, `split_preview`).
#[derive(Debug, serde::Serialize)]
pub struct PreviewSub {
    pub name: String,
    pub folder: String,
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
    #[serde(rename = "idRanges")]
    pub id_ranges: Vec<[u32; 2]>,
    /// The subterrains of the current layout it continues (none: a new one, or a split).
    pub from: Vec<String>,
    pub doodads: usize,
    pub units: usize,
    pub regions: usize,
}

/// Objects of one kind that change subterrain: they were in `from`, which the subterrain `to` doesn't continue.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct Move {
    pub kind: &'static str,
    pub from: String,
    pub to: String,
    pub count: usize,
}

/// What a change of the subterrains would do, nothing written: the files written and removed (relative to the
/// project), every subterrain afterwards with its objects, and the objects that change subterrain.
#[derive(Debug, Default, serde::Serialize)]
pub struct Preview {
    pub written: Vec<String>,
    pub removed: Vec<String>,
    pub subterrains: Vec<PreviewSub>,
    pub moves: Vec<Move>,
}

/// The entries of a subterrain's object file of `kind`, every list (doodads: the special ones too), each as one
/// canonical text without `order` (a place in the flat file, not part of the object). No file: none.
fn sub_objects(files: &BTreeMap<String, Vec<u8>>, s: &Subterrain, kind: Kind) -> Result<Vec<String>> {
    let path = s.object_path(kind);
    let Some(bytes) = files.get(&path) else { return Ok(Vec::new()) };
    let doc: Value = serde_json::from_slice(bytes).map_err(|e| bad(format!("map/{path} isn't JSON: {e}")))?;
    let mut out = Vec::new();
    for key in [kind.name(), "specials"] {
        for e in doc.get(key).and_then(Value::as_array).into_iter().flatten() {
            let mut e = e.clone();
            if let Some(m) = e.as_object_mut() {
                m.shift_remove("order");
            }
            out.push(e.to_string());
        }
    }
    Ok(out)
}

/// What the files `new` make of the files `old` (both relative to `map/`; `old` split or flat): per subterrain of
/// `new` its objects, the objects of each kind that come from a subterrain it doesn't continue (`from`: a new name →
/// the old names it continues), the files written and removed.
fn preview_of(old: &BTreeMap<String, Vec<u8>>, new: &BTreeMap<String, Vec<u8>>, from: &HashMap<String, Vec<String>>) -> Result<Preview> {
    let layout = Layout::parse(&new[LAYOUT_FILE])?;
    // Where each object was: its text → the old subterrains holding such an object.
    let mut was: HashMap<(Kind, String), Vec<String>> = HashMap::new();
    if is_split(old)? {
        for s in &Layout::parse(&old[LAYOUT_FILE])?.subterrains {
            for kind in KINDS {
                for o in sub_objects(old, s, kind)? {
                    was.entry((kind, o)).or_default().push(s.name.clone());
                }
            }
        }
    }
    let mut moves: BTreeMap<(Kind, String, String), usize> = BTreeMap::new();
    let mut subterrains = Vec::with_capacity(layout.subterrains.len());
    for s in &layout.subterrains {
        let continues = from.get(&s.name).cloned().unwrap_or_default();
        let mut counts = [0usize; 3];
        for (k, kind) in KINDS.iter().enumerate() {
            let list = sub_objects(new, s, *kind)?;
            counts[k] = list.len();
            for o in list {
                if let Some(old_name) = was.get_mut(&(*kind, o)).and_then(Vec::pop) {
                    if !continues.contains(&old_name) {
                        *moves.entry((*kind, old_name, s.name.clone())).or_default() += 1;
                    }
                }
            }
        }
        subterrains.push(PreviewSub {
            name: s.name.clone(),
            folder: s.folder.clone(),
            x: s.x,
            y: s.y,
            w: s.w,
            h: s.h,
            id_ranges: s.id_ranges.clone(),
            from: continues,
            doodads: counts[0],
            units: counts[1],
            regions: counts[2],
        });
    }
    let at = |p: &String| format!("{}/{p}", crate::project::MAP_DIR);
    Ok(Preview {
        written: new.iter().filter(|(k, b)| old.get(*k) != Some(*b)).map(|(k, _)| at(k)).collect(),
        removed: old.keys().filter(|k| !new.contains_key(*k)).map(at).collect(),
        subterrains,
        moves: moves.into_iter().map(|((kind, from, to), count)| Move { kind: kind.name(), from, to, count }).collect(),
    })
}

/// What `relayout_project` would do with `plan`, nothing written; its refusals as the error.
pub fn relayout_preview(project: &Path, plan: &[Planned]) -> Result<Preview> {
    let map_dir = project.join(crate::project::MAP_DIR);
    let old = {
        let _one = FLAT_WRITES.lock().unwrap_or_else(|e| e.into_inner());
        if !is_split_on_disk(&map_dir)? {
            return Err(Error::Project(format!("the terrain isn't split (there is no map/{LAYOUT_FILE})")));
        }
        let mut files = read_layout_files(&map_dir)?;
        let flat_names: Vec<&str> = KINDS.iter().flat_map(|k| [k.flat(), k.raw()]).collect();
        read_if_there(&map_dir, &flat_names, &mut files)?;
        files
    };
    let layout = Layout::parse(&old[LAYOUT_FILE])?;
    let mut new = old.clone();
    relayout(&mut new, plan)?;
    let from = plan
        .iter()
        .map(|p| {
            let continues = match &p.from {
                Some(f) => f.clone(),
                None => layout.subterrains.iter().filter(|s| s.name == p.rect.name).map(|s| s.name.clone()).collect(),
            };
            (p.rect.name.clone(), continues)
        })
        .collect();
    preview_of(&old, &new, &from)
}

/// What `split_project` would do with `rects`, nothing written; its refusals as the error.
pub fn split_preview(project: &Path, rects: &[Rect]) -> Result<Preview> {
    let plan = {
        let _one = FLAT_WRITES.lock().unwrap_or_else(|e| e.into_inner());
        split_plan(project, rects)?
    };
    preview_of(&plan.old, &plan.files, &HashMap::new())
}

/// A split project's layout as it is on disk: the files under `map/terrain/` (relative to `map/`) and the open choice
/// (`build/open-subterrains.json`, None when there is none). What `restore_layout` puts back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayoutState {
    pub files: BTreeMap<String, Vec<u8>>,
    pub open: Option<Vec<u8>>,
}

impl LayoutState {
    /// How many bytes it holds.
    pub fn size(&self) -> usize {
        self.files.values().map(Vec::len).sum::<usize>() + self.open.as_ref().map_or(0, Vec::len)
    }
}

fn layout_state(project: &Path) -> Result<LayoutState> {
    let files = read_layout_files(&project.join(crate::project::MAP_DIR))?;
    let open = match fs::read(crate::terrain_open::path(project)) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(Error::Project(format!("{} can't be read: {e}", crate::terrain_open::NAME))),
    };
    Ok(LayoutState { files, open })
}

/// `relayout_project`, with the layout as it was before and as it is after: what taking it back needs
/// (`restore_layout`).
pub fn relayout_project_undoable(project: &Path, plan: &[Planned]) -> Result<(Converted, LayoutState, LayoutState)> {
    let _one = FLAT_WRITES.lock().unwrap_or_else(|e| e.into_inner());
    if !is_split_on_disk(&project.join(crate::project::MAP_DIR))? {
        return Err(Error::Project(format!("the terrain isn't split (there is no map/{LAYOUT_FILE})")));
    }
    let before = layout_state(project)?;
    let done = relayout_on_disk(project, plan)?;
    let after = layout_state(project)?;
    Ok((done, before, after))
}

/// Puts a split project's layout (the files under `map/terrain/` and the open choice) back to `to`, only while it is
/// `from` on disk: anything saved since (an edit in a subterrain, another change of the layout) refuses it, so nothing
/// is lost. Files whose bytes differ are written, the others removed, folders left empty go; the derived files'
/// record is made again when it said they followed (the map is the same).
pub fn restore_layout(project: &Path, from: &LayoutState, to: &LayoutState) -> Result<Converted> {
    let _one = FLAT_WRITES.lock().unwrap_or_else(|e| e.into_inner());
    let map_dir = project.join(crate::project::MAP_DIR);
    let now = layout_state(project)?;
    if now != *from {
        let mut changed: Vec<String> = now.files.keys().chain(from.files.keys()).filter(|k| now.files.get(*k) != from.files.get(*k)).map(|k| format!("map/{k}")).collect();
        changed.sort();
        changed.dedup();
        if now.open != from.open {
            changed.push(crate::terrain_open::NAME.to_string());
        }
        let shown = changed.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
        let more = if changed.len() > 3 { format!(" and {} more", changed.len() - 3) } else { String::new() };
        return Err(Error::Project(format!("the subterrains' files changed since ({shown}{more}): taking the change back would lose that")));
    }
    let fresh = derived_fresh(project)?;
    let written = write_changed(&map_dir, &to.files)?;
    let removed = FOLDER.remove_stale(&map_dir, now.files.keys(), &to.files)?;
    let prefix = format!("{DIR}/");
    let folders: HashSet<&str> = removed.iter().filter_map(|p| p.strip_prefix(&prefix)).filter_map(|p| p.split_once('/')).map(|(f, _)| f).collect();
    for f in folders {
        FOLDER.remove_empty(&map_dir, Some(f));
    }
    let at = |p: &String| format!("{}/{p}", crate::project::MAP_DIR);
    let mut done = Converted { written: written.iter().map(at).collect(), removed: removed.into_iter().map(at).collect() };
    if now.open != to.open {
        let p = crate::terrain_open::path(project);
        match &to.open {
            Some(b) => {
                crate::project::write_atomic(&p, b)?;
                done.written.push(crate::terrain_open::NAME.to_string());
            }
            None => {
                fs::remove_file(&p).map_err(|e| Error::Project(format!("{} can't be removed: {e}", crate::terrain_open::NAME)))?;
                done.removed.push(crate::terrain_open::NAME.to_string());
            }
        }
    }
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
    let all: Vec<String> = FOLDER.paths(map_dir)?;
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
    let flats: Flats = KINDS.into_iter().filter(|k| layout.objects.has(*k)).map(|k| (k, files[k.flat()].clone())).collect();
    if [t.width, t.height] == layout.corners() && t.offset == layout.head.offset {
        let sliced = slice_terrain(&t, layout.subterrains, layout.default_corner, layout.doo_header, &flats, Some(&layout.objects.twice))?;
        return write_changed(map_dir, &sliced);
    }
    // Map Size: the canvas grows or shrinks; what no subterrain holds any more goes. The layout's files as on disk
    // (the flat files above were assembled from them, which took them out), for the pathing overrides and what goes.
    let old_files = read_layout_files(map_dir)?;
    let sliced = resized_files(&old_files, &layout, &t, &flats, Some(&layout.objects.twice))?;
    let written = write_changed(map_dir, &sliced)?;
    // The old layout's files the new one doesn't have (a subterrain cut away, overrides cut off) go.
    FOLDER.remove_stale(map_dir, old_files.keys(), &sliced)?;
    let new_layout = Layout::parse(&sliced[LAYOUT_FILE])?;
    for s in &layout.subterrains {
        if !new_layout.subterrains.iter().any(|n| n.folder == s.folder) {
            FOLDER.remove_empty(map_dir, Some(&s.folder));
        }
    }
    Ok(written)
}

/// A terrain after Map Size (`change`: tiles added to the west, east, south and north, negative cut), as the app's
/// resizeTerrain makes it: world positions stay, a new corner copies the nearest corner of the old edge (its variation
/// too: the app rolls new ones, which is the same for the subterrains).
pub(crate) fn map_sized(t: &Terrain, change: [i64; 4]) -> Terrain {
    let [l, r, b, n] = change;
    let (w, h) = ((t.width as i64 + l + r) as usize, (t.height as i64 + b + n) as usize);
    let mut corners = Vec::with_capacity(w * h);
    for y in 0..h as i64 {
        for x in 0..w as i64 {
            let (ox, oy) = ((x - l).clamp(0, t.width as i64 - 1) as usize, (y - b).clamp(0, t.height as i64 - 1) as usize);
            corners.push(t.corners[oy * t.width + ox]);
        }
    }
    Terrain { width: w, height: h, offset: [t.offset[0] - (l * 128) as f32, t.offset[1] - (b * 128) as f32], corners, ..t.clone() }
}

/// `w3proj verify`'s Map Size check of a split layout's files (relative to `map/`): the terrain grown by `by` corners on
/// every side (`map_sized`, objects as they are) and cut back to its size gives the same files.
pub fn map_size_round_trip(files: &BTreeMap<String, Vec<u8>>, by: i64) -> Result<bool> {
    let layout = Layout::parse(files.get(LAYOUT_FILE).ok_or_else(|| Error::Project(format!("map/{LAYOUT_FILE} is missing")))?)?;
    let mut flat = files.clone();
    flatten(&mut flat)?;
    let t = w3e::terrain_from_text(&flat[FLAT_FILE])?;
    let flats: Flats = KINDS.into_iter().filter(|k| layout.objects.has(*k)).map(|k| (k, flat[k.flat()].clone())).collect();
    let grown = resized_files(files, &layout, &map_sized(&t, [by; 4]), &flats, Some(&layout.objects.twice))?;
    let back = resized_files(&grown, &Layout::parse(&grown[LAYOUT_FILE])?, &t, &flats, Some(&layout.objects.twice))?;
    Ok(back.into_iter().eq(files.iter().filter(|(k, _)| under_dir(k)).map(|(k, v)| (k.clone(), v.clone()))))
}

/// The split layout's files (relative to `map/`) after Map Size made the terrain `t` (another size or offset; the
/// object files `flats` as the resize left them): the subterrains follow (`resized_canvas`), every file is cut anew from
/// `t` and `flats`, the pathing overrides (read from `files` with `layout`) move with their ground, those now off the
/// map go. The whole new set of files: one of `files` under `map/terrain/` that isn't in it is no longer the layout's.
/// `kept`: as for `slice_terrain`.
fn resized_files(
    files: &BTreeMap<String, Vec<u8>>,
    layout: &Layout,
    t: &Terrain,
    flats: &Flats,
    kept: Option<&objects::Twice>,
) -> Result<BTreeMap<String, Vec<u8>>> {
    let shift = canvas_shift(layout, t)?;
    let mut subs = resized_canvas(&layout.subterrains, layout.corners(), [t.width, t.height], shift)?;
    cover_growth(&mut subs, layout.corners(), t, shift, &layout.default_corner)?;
    let pathing = crate::terrain_pathing::assemble(layout, &|p| files.get(p).cloned())?;
    let mut sliced = slice_terrain(t, subs, layout.default_corner, layout.doo_header.clone(), flats, kept)?;
    if let Some(json) = pathing {
        let cells = crate::terrain_pathing::parse_json(&json, layout.corners())?;
        let [w, h] = crate::terrain_pathing::map_size([t.width, t.height]);
        let moved: Vec<crate::terrain_pathing::Cell> = cells
            .into_iter()
            .filter_map(|c| {
                let (x, y) = (i64::from(c.x) + shift[0] * 4, i64::from(c.y) + shift[1] * 4);
                (x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h).then_some(crate::terrain_pathing::Cell { x: x as u32, y: y as u32, ..c })
            })
            .collect();
        let new_layout = Layout::parse(&sliced[LAYOUT_FILE])?;
        sliced.extend(crate::terrain_pathing::slice(&crate::terrain_pathing::json_text([t.width, t.height], &moved), &new_layout)?);
    }
    Ok(sliced)
}

/// Beside an edge no subterrain reaches, the strip Map Size adds lies in none of the resized subterrains `subs`. Where
/// it holds a corner other than the default one (the copied ground gets new variations), it is added as a subterrain of
/// its own, so nothing is lost: rectangles over the added, uncovered corners, named after the side ("east_edge"), each
/// with the next block of creation numbers. A rectangle holding the default corner alone stays uncovered. Cutting the
/// strip off again (Undo Resize) takes its subterrain with it. `old`: the canvas before, `shift`: corners added west
/// and south.
fn cover_growth(subs: &mut Vec<Subterrain>, old: [usize; 2], t: &Terrain, shift: [i64; 2], default_corner: &Corner) -> Result<()> {
    let (w, h) = (t.width, t.height);
    // The added corners in no subterrain.
    let added = |at: usize, d: i64, old_n: usize| (at as i64) < d || at as i64 - d >= old_n as i64;
    let mut open: Vec<bool> = (0..w * h).map(|i| added(i % w, shift[0], old[0]) || added(i / w, shift[1], old[1])).collect();
    for s in subs.iter() {
        for row in s.y..(s.y + s.h).min(h) {
            open[row * w + s.x.min(w)..row * w + (s.x + s.w).min(w)].fill(false);
        }
    }
    let mut block = next_block(subs);
    for start in 0..w * h {
        if !open[start] {
            continue;
        }
        let (x, y) = (start % w, start / w);
        let width = (x..w).take_while(|&cx| open[y * w + cx]).count();
        let height = (y..h).take_while(|&cy| open[cy * w + x..cy * w + x + width].iter().all(|&o| o)).count();
        let mut keep = false;
        for row in y..y + height {
            open[row * w + x..row * w + x + width].fill(false);
            keep |= t.corners[row * w + x..row * w + x + width].iter().any(|c| c != default_corner);
        }
        if !keep {
            continue;
        }
        let side = if ((x + width) as i64) <= shift[0] {
            "west"
        } else if x as i64 - shift[0] >= old[0] as i64 {
            "east"
        } else if ((y + height) as i64) <= shift[1] {
            "south"
        } else {
            "north"
        };
        let used = |n: &str| subs.iter().any(|s| s.name.eq_ignore_ascii_case(n) || s.folder.eq_ignore_ascii_case(n));
        let name = std::iter::once(format!("{side}_edge")).chain((2..).map(|i| format!("{side}_edge_{i}"))).find(|n| !used(n)).expect("a free name");
        let range = block_range(block, &name)?;
        block += 1;
        subs.push(Subterrain { folder: name.clone(), name, x, y, w: width, h: height, id_ranges: vec![range] });
    }
    Ok(())
}

/// The corners a terrain of another size adds on the canvas's west and south side (negative: cuts), as Map Size
/// changes it: world positions stay, so the shift is the offsets' difference in tiles. An offset that moved by part of
/// a tile is refused.
fn canvas_shift(layout: &Layout, t: &Terrain) -> Result<[i64; 2]> {
    let mut out = [0i64; 2];
    for (i, o) in out.iter_mut().enumerate() {
        let d = (f64::from(layout.head.offset[i]) - f64::from(t.offset[i])) / 128.0;
        if !d.is_finite() || d.fract() != 0.0 {
            return Err(Error::Project(format!(
                "the terrain's offset moved by part of a tile ({} to {}), so the subterrains can't follow it (map/{LAYOUT_FILE}): merge them first (Merge Subterrains)",
                layout.head.offset[i], t.offset[i]
            )));
        }
        *o = d as i64;
    }
    Ok(out)
}

/// The subterrains of a canvas of `old` corners after Map Size made it `new`, `shift` corners added on the west and
/// south (negative: cut off), as the flat resize changes the map: each rectangle keeps its ground (moves by `shift` in
/// corners), one that reached an edge of the old canvas reaches the same edge of the new one (the ground Map Size adds
/// copies the edge, so it is the edge subterrain's), what lies past the new canvas is cut off, and a subterrain cut
/// off entirely goes (its objects went with the resize, as in a flat map). Names, folders and id ranges stay. Refused
/// when none is left.
///
/// The rule for growth, per axis: the strip added on a side joins every subterrain that reached that side, each over
/// its own span along it, so the rectangles stay rectangles and still tile the canvas; a corner region (two sides grown)
/// joins the subterrain that held that corner, as it reached both sides. A layout covering the whole canvas therefore
/// covers the new one; for a strip no subterrain reaches see `cover_growth`.
pub fn resized_canvas(subs: &[Subterrain], old: [usize; 2], new: [usize; 2], shift: [i64; 2]) -> Result<Vec<Subterrain>> {
    let span = |at: usize, len: usize, old_n: usize, new_n: usize, d: i64| -> Option<(usize, usize)> {
        let (mut a, mut b) = (at as i64 + d, (at + len) as i64 + d);
        if at == 0 && d > 0 {
            a = 0;
        }
        if at + len == old_n {
            b = b.max(new_n as i64);
        }
        let (a, b) = (a.max(0), b.min(new_n as i64));
        (b > a).then_some((a as usize, (b - a) as usize))
    };
    let out: Vec<Subterrain> = subs
        .iter()
        .filter_map(|s| {
            let (x, w) = span(s.x, s.w, old[0], new[0], shift[0])?;
            let (y, h) = span(s.y, s.h, old[1], new[1], shift[1])?;
            Some(Subterrain { x, y, w, h, ..s.clone() })
        })
        .collect();
    if out.is_empty() {
        return Err(Error::Project("the new map size leaves no subterrain (there has to be one at least)".into()));
    }
    Ok(out)
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
/// `pathing.txt` when none has one yet (kept as `build/pathing.json.bak`). Nothing for a flat project. What moved,
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
            move_to_backup(project, &backup)?;
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

    /// Map Size beside an edge no subterrain reaches (the corners there are the default corner). Ground equal to the
    /// default corner stays outside every subterrain (as `w3proj verify`'s round trip grows it); ground with the new
    /// variations the app rolls goes into a new subterrain, which shrinking the map back removes again.
    #[test]
    fn map_size_beside_an_uncovered_edge_adds_a_subterrain() {
        let mut t = terrain(12, true);
        let fill = t.corners[t.width * t.height - 1];
        for y in 0..t.height {
            for x in 0..t.width {
                if x >= 6 || y >= 5 {
                    t.corners[y * t.width + x] = fill;
                }
            }
        }
        let mut files = flat_files(&t);
        split(&mut files, &[rect("left:0,0,3,5"), rect("mid:3,0,3,5")]).unwrap();
        let layout = Layout::parse(&files[LAYOUT_FILE]).unwrap();
        let flats: Flats = Flats::new();
        let names = |l: &Layout| l.subterrains.iter().map(|s| s.name.clone()).collect::<Vec<_>>();
        let split_files: BTreeMap<String, Vec<u8>> = files.iter().filter(|(k, _)| under_dir(k)).map(|(k, v)| (k.clone(), v.clone())).collect();
        // Copied exactly (map_sized): the new corners are the default corner, kept outside every subterrain.
        for change in [[0, 2, 0, 0], [0, 0, 0, 2], [0, 2, 0, 2]] {
            let grown = resized_files(&files, &layout, &map_sized(&t, change), &flats, Some(&layout.objects.twice)).unwrap();
            assert_eq!(names(&Layout::parse(&grown[LAYOUT_FILE]).unwrap()), ["left", "mid"], "{change:?}");
        }
        // With new variations, as the app's resize rolls them, on the uncovered edges: every such corner is kept in a
        // subterrain named after its side. [left, right, bottom, top].
        for (change, want) in [([0, 2, 0, 0], vec!["east_edge"]), ([0, 0, 0, 2], vec!["north_edge"]), ([0, 2, 0, 2], vec!["east_edge", "north_edge"])] {
            let mut grown = map_sized(&t, change);
            let (w, h) = (grown.width, grown.height);
            for y in 0..h {
                for x in 0..w {
                    if x >= t.width || y >= t.height {
                        grown.corners[y * w + x].variation ^= 1;
                    }
                }
            }
            let sliced = resized_files(&files, &layout, &grown, &flats, Some(&layout.objects.twice)).unwrap_or_else(|e| panic!("{change:?}: {e}"));
            let new = Layout::parse(&sliced[LAYOUT_FILE]).unwrap();
            assert_eq!(names(&new)[2..], want[..], "{change:?}");
            let ranges: Vec<[u32; 2]> = new.subterrains.iter().flat_map(|s| s.id_ranges.clone()).collect();
            assert_eq!(ranges, (1..=ranges.len() as u32).map(|i| [i * 10000, i * 10000 + 9999]).collect::<Vec<_>>(), "{change:?}");
            let mut flat = sliced.clone();
            flatten(&mut flat).unwrap();
            assert_eq!(w3e::terrain_from_text(&flat[FLAT_FILE]).unwrap().corners, grown.corners, "{change:?}: nothing lost");
            // Shrunk back: the strip's subterrain goes, every file as it was.
            let back = resized_files(&sliced, &new, &t, &flats, Some(&new.objects.twice)).unwrap();
            assert_eq!(back, split_files, "{change:?} shrunk back");
        }
        // Growth on the covered sides (west, south) adds none.
        let mut grown = map_sized(&t, [2, 0, 2, 0]);
        grown.corners[0].variation ^= 1;
        let sliced = resized_files(&files, &layout, &grown, &flats, Some(&layout.objects.twice)).unwrap();
        assert_eq!(names(&Layout::parse(&sliced[LAYOUT_FILE]).unwrap()), ["left", "mid"]);
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

    /// A sync from a map whose size changed (Map Size in the World Editor) into a project with one subterrain over the
    /// whole map, as every new project has: the subterrain follows the new canvas and the painted pathing its ground.
    #[test]
    fn a_sync_follows_a_changed_map_size() {
        let dir = std::env::temp_dir().join(format!("w3proj-terrain-syncsize-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let t = terrain(12, false);
        let mut files = flat_files(&t);
        files.remove("war3map.j");
        split(&mut files, &[]).unwrap();
        write_changed(&dir, &files).unwrap();
        let layout = Layout::parse(&files[LAYOUT_FILE]).unwrap();
        let painted = crate::terrain_pathing::sample_json([t.width, t.height]).unwrap();
        write_changed(&dir, &crate::terrain_pathing::slice(&painted, &layout).unwrap()).unwrap();
        let cells = crate::terrain_pathing::parse_json(&painted, [t.width, t.height]).unwrap();
        // Grown on the west and north, then cut back.
        for (change, shift) in [([2i64, 0, 0, 3], 8i64), ([-2, 0, 0, -3], 0)] {
            let from = if shift == 0 { map_sized(&t, [2, 0, 0, 3]) } else { t.clone() };
            let to = map_sized(&from, change);
            let mut sync = BTreeMap::from([(FLAT_FILE.to_string(), w3e::terrain_text(&to).unwrap())]);
            prepare_sync(&dir, &mut sync).unwrap();
            write_changed(&dir, &sync).unwrap();
            let now = read_layout_files(&dir).unwrap();
            assert_eq!(assemble(&now).unwrap(), w3e::write(&to));
            let layout = Layout::parse(&now[LAYOUT_FILE]).unwrap();
            assert_eq!(layout.subterrains.iter().map(|s| (s.name.as_str(), s.w, s.h)).collect::<Vec<_>>(), [("main", to.width, to.height)]);
            let got = crate::terrain_pathing::assemble(&layout, &|p| now.get(p).cloned()).unwrap();
            let want: Vec<crate::terrain_pathing::Cell> = cells.iter().map(|c| crate::terrain_pathing::Cell { x: (i64::from(c.x) + shift) as u32, ..*c }).collect();
            assert_eq!(got, Some(crate::terrain_pathing::json_text([to.width, to.height], &want)));
        }
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
        fs::create_dir_all(pj.parent().unwrap()).unwrap();
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
        assert!(!pj.exists() && fs::read(dir.join("build/pathing.json.bak")).unwrap() == json);
        assert_eq!(read_pathing(&dir).unwrap().as_deref(), Some(&json[..]));
        assert!(pathing_files(&dir).unwrap().len() >= 3, "the overrides cross the seams");
        assert_eq!(crate::derived::check(&dir).unwrap(), crate::derived::Freshness::Fresh);
        assert!(fs::read_to_string(dir.join(".gitignore")).unwrap().lines().any(|l| l == "build/"));

        // As a project split before stage 3 has it: migrated, the record still fresh.
        fs::rename(store.join("war3map.wpm"), map_dir.join("war3map.wpm")).unwrap();
        delete_pathing(&dir).unwrap();
        fs::write(&pj, &json).unwrap();
        let moved = migrate_split(&dir).unwrap();
        assert_eq!(moved, ["map/war3map.wpm", ".w3proj/pathing.json"]);
        assert!(store.join("war3map.wpm").is_file() && !pj.exists() && dir.join("build/pathing.json.bak2").is_file());
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
            ["terrain/terrain.json", "terrain/sw/units.json", "terrain/se/units.json", "terrain/nw/units.json", "terrain/ne/units.json", "../build/open-subterrains.json"]
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

        // Refused, nothing written: another canvas whose offset moved by part of a tile (Map Size moves it by tiles),
        // text that isn't a terrain, a name the layout doesn't hold.
        let before = read_layout_files(&dir).unwrap();
        let mut bigger = edited.clone();
        bigger.width += 1;
        bigger.offset[0] += 1.0;
        bigger.corners = vec![bigger.corners[0]; bigger.width * bigger.height];
        let e = write_flat(&dir, FLAT_FILE, &w3e::terrain_text(&bigger).unwrap()).unwrap_err().to_string();
        assert!(e.contains("part of a tile"), "{e}");
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

    /// The test terrain with objects and pathing overrides over the seams, split 2×2 with the overrides sliced in: the
    /// flat files and the split ones.
    type Files = BTreeMap<String, Vec<u8>>;

    fn split_with_everything() -> (Files, Files, Vec<u8>) {
        let t = terrain(12, false);
        let mut flat = flat_files(&t);
        with_objects(&mut flat, 8);
        let mut files = flat.clone();
        split(&mut files, &grid_2x2(t.width, t.height)).unwrap();
        let json = crate::terrain_pathing::sample_json([t.width, t.height]).unwrap();
        let layout = Layout::parse(&files[LAYOUT_FILE]).unwrap();
        files.extend(crate::terrain_pathing::slice(&json, &layout).unwrap());
        (flat, files, json)
    }

    fn plan(list: &[&str]) -> Vec<Planned> {
        list.iter().map(|s| s.parse().unwrap()).collect()
    }

    /// What `relayout` must keep: the flat files come back the same, so do the pathing overrides; every object lies in
    /// the subterrain that owns its position (a region by its minimum corner).
    fn assert_lossless(files: &BTreeMap<String, Vec<u8>>, flat: &BTreeMap<String, Vec<u8>>, json: &[u8], what: &str) {
        let layout = Layout::parse(&files[LAYOUT_FILE]).unwrap();
        let mut back = files.clone();
        assert!(flatten(&mut back).unwrap(), "{what}");
        assert_eq!(&back, flat, "{what}: the map changed");
        assert_eq!(crate::terrain_pathing::assemble(&layout, &|p| files.get(p).cloned()).unwrap().as_deref(), Some(json), "{what}: the pathing overrides changed");
        for (i, s) in layout.subterrains.iter().enumerate() {
            for (kind, list, x, y) in [(Kind::Units, "units", "position", ""), (Kind::Doodads, "doodads", "position", ""), (Kind::Regions, "regions", "left", "bottom")] {
                let doc: Value = serde_json::from_slice(&files[&s.object_path(kind)]).unwrap();
                for e in doc[list].as_array().unwrap() {
                    let (px, py) = if y.is_empty() { (e[x][0].as_f64().unwrap(), e[x][1].as_f64().unwrap()) } else { (e[x].as_f64().unwrap(), e[y].as_f64().unwrap()) };
                    assert_eq!(objects::owner(&layout.subterrains, layout.offset(), px, py), i, "{what}: {list} at {px},{py} is in {}", s.name);
                }
            }
        }
    }

    #[test]
    fn subterrains_renamed_joined_resized_and_new_keep_the_map_ids_and_folders() {
        let (flat, split, json) = split_with_everything();
        let ranges = |files: &BTreeMap<String, Vec<u8>>, name: &str| Layout::parse(&files[LAYOUT_FILE]).unwrap().subterrains.into_iter().find(|s| s.name == name).map(|s| (s.folder, s.id_ranges));
        // The grid's rows are 0–2 and 3–6, columns 0–3 and 4–8; sw 10000…, se 20000…, nw 30000…, ne 40000….
        let mut files = split.clone();
        relayout(&mut files, &plan(&["south=sw+se:0,0,9,3", "west=nw:0,3,4,4", "ne:4,3,5,4"])).unwrap();
        assert_lossless(&files, &flat, &json, "joined and renamed");
        assert_eq!(ranges(&files, "south"), Some(("south".into(), vec![[10000, 19999], [20000, 29999]])), "a join keeps both ranges");
        assert_eq!(ranges(&files, "west"), Some(("west".into(), vec![[30000, 39999]])), "a rename keeps its range, the folder follows the name");
        assert_eq!(ranges(&files, "ne"), Some(("ne".into(), vec![[40000, 49999]])));
        assert!(files.keys().all(|k| !k.starts_with("terrain/sw/") && !k.starts_with("terrain/nw/")), "the old folders' files are gone");
        assert!(files.contains_key("terrain/south/pathing.txt") && files.contains_key("terrain/south/units.json"));
        // Resized (the seam moved one corner east) and a new one carved out: the new one gets the next block.
        let mut files = split.clone();
        relayout(&mut files, &plan(&["sw:0,0,2,3", "mid:2,0,3,3", "se:5,0,4,3", "nw:0,3,5,4", "ne:5,3,4,4"])).unwrap();
        assert_lossless(&files, &flat, &json, "resized, one new");
        assert_eq!(ranges(&files, "mid"), Some(("mid".into(), vec![[50000, 59999]])));
        assert_eq!(ranges(&files, "nw"), Some(("nw".into(), vec![[30000, 39999]])));
        // The same layout again: the same files.
        let mut same = split.clone();
        relayout(&mut same, &plan(&["sw:0,0,4,3", "se:4,0,5,3", "nw:0,3,4,4", "ne:4,3,5,4"])).unwrap();
        assert_eq!(same, split);
        // Refused, the files as they were: an overlap, a corner left out that isn't the default one, an old subterrain
        // that isn't there or goes into two, a folder that would only change its case, no subterrain.
        for (bad, why) in [
            (vec!["sw:0,0,5,3", "se:4,0,5,3", "nw:0,3,4,4", "ne:4,3,5,4"], "overlap"),
            (vec!["sw:0,0,4,3", "nw:0,3,4,4", "ne:4,3,5,4"], "would be lost"),
            (vec!["x=nope:0,0,9,7"], "no subterrain \"nope\""),
            (vec!["a=sw:0,0,4,3", "b=sw+se:4,0,5,3", "nw:0,3,4,4", "ne:4,3,5,4"], "both"),
            (vec!["SW=sw:0,0,4,3", "se:4,0,5,3", "nw:0,3,4,4", "ne:4,3,5,4"], "only the case"),
        ] {
            let mut f = split.clone();
            let e = relayout(&mut f, &plan(&bad)).unwrap_err().to_string();
            assert!(e.contains(why), "{bad:?}: {e}");
            assert_eq!(f, split, "{bad:?}: refused, yet changed");
        }
        let mut f = split.clone();
        assert!(relayout(&mut f, &[]).is_err());
        assert_eq!("a=b+c:1,2,3,4".parse::<Planned>().unwrap(), Planned { rect: rect("a:1,2,3,4"), from: Some(vec!["b".into(), "c".into()]) });
        assert_eq!("a=:1,2,3,4".parse::<Planned>().unwrap().from, Some(vec![]));
        assert_eq!("a:1,2,3,4".parse::<Planned>().unwrap().from, None);
    }

    /// Random layouts, one after the other (fixed seed): a canvas cut into rectangles by random cuts, each continuing a
    /// random old subterrain or none. Every relayout keeps the map, the pathing overrides and every object in the
    /// subterrain that owns its position, and the ranges of what it continues; one that drops a rectangle either
    /// works (its corners were all the default one) or leaves the files as they were.
    #[test]
    fn random_layouts_lose_nothing() {
        let (flat, mut files, json) = split_with_everything();
        let mut seed: u64 = 0x5eed_7e44;
        let mut next = |n: usize| -> usize {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as usize) % n.max(1)
        };
        eprintln!("random_layouts_lose_nothing: seed 0x5eed7e44");
        let (mut ok, mut refused) = (0, 0);
        for round in 0..60 {
            let mut rects = vec![(0usize, 0usize, 9usize, 7usize)];
            for _ in 0..next(5) {
                let k = next(rects.len());
                let (x, y, w, h) = rects[k];
                if next(2) == 0 && w > 1 {
                    let c = 1 + next(w - 1);
                    rects[k] = (x, y, c, h);
                    rects.push((x + c, y, w - c, h));
                } else if h > 1 {
                    let c = 1 + next(h - 1);
                    rects[k] = (x, y, w, c);
                    rects.push((x, y + c, w, h - c));
                }
            }
            let old = Layout::parse(&files[LAYOUT_FILE]).unwrap();
            let mut olds: Vec<&Subterrain> = old.subterrains.iter().collect();
            let mut list = Vec::new();
            for (i, (x, y, w, h)) in rects.iter().enumerate() {
                let from = if !olds.is_empty() && next(3) > 0 { vec![olds.remove(next(olds.len())).name.clone()] } else { vec![] };
                list.push(Planned { rect: Rect { name: format!("r{round}_{i}"), x: *x, y: *y, w: *w, h: *h }, from: Some(from) });
            }
            let drop = list.len() > 1 && next(6) == 0;
            if drop {
                list.remove(next(list.len()));
            }
            let mut f = files.clone();
            match relayout(&mut f, &list) {
                Ok(()) => {
                    assert_lossless(&f, &flat, &json, &format!("round {round}"));
                    let new = Layout::parse(&f[LAYOUT_FILE]).unwrap();
                    for p in &list {
                        let mut want: Vec<[u32; 2]> = p.from.iter().flatten().flat_map(|n| old.subterrains.iter().find(|s| &s.name == n).unwrap().id_ranges.clone()).collect();
                        want.sort();
                        let got = &new.subterrains.iter().find(|s| s.name == p.rect.name).unwrap().id_ranges;
                        if !want.is_empty() {
                            assert_eq!(got, &want, "round {round}: {}", p.rect.name);
                        }
                    }
                    files = f;
                    ok += 1;
                }
                Err(e) => {
                    assert!(drop, "round {round}: a layout covering the canvas was refused: {e}");
                    assert_eq!(f, files, "round {round}: refused, yet changed");
                    refused += 1;
                }
            }
        }
        assert!(ok > 30 && refused > 0, "ok {ok}, refused {refused}: the rounds reached too little");
    }

    /// On disk: a renamed subterrain's folder goes, the open choice follows the names, the derived files' record stays
    /// fresh, and a merge afterwards gives back the flat files the project had before it was split.
    #[test]
    fn a_relayout_on_disk_renames_folders_and_keeps_the_open_choice() {
        let dir = std::env::temp_dir().join(format!("w3proj-terrain-relayout-{}", std::process::id()));
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
        fs::create_dir_all(dir.join(".w3proj")).unwrap();
        fs::write(crate::terrain_pathing::json_path(&dir), &json).unwrap();
        split_project(&dir, &grid_2x2(t.width, t.height)).unwrap();
        let layout = Layout::parse(&fs::read(map_dir.join(LAYOUT_FILE)).unwrap()).unwrap();
        crate::terrain_open::store(&dir, &layout, &["sw".into(), "ne".into()]).unwrap();
        let before: Vec<String> = crate::project::walk(&dir).unwrap();

        // Refused: nothing on disk changes.
        assert!(relayout_project(&dir, &plan(&["sw:0,0,4,3", "nw:0,3,4,4", "ne:4,3,5,4"])).is_err());
        assert_eq!(crate::project::walk(&dir).unwrap(), before);

        let done = relayout_project(&dir, &plan(&["south_west=sw:0,0,4,3", "se:4,0,5,3", "north=nw+ne:0,3,9,4"])).unwrap();
        assert!(done.removed.iter().any(|p| p == "map/terrain/sw/terrain.txt") && done.written.iter().any(|p| p == "map/terrain/south_west/terrain.txt"), "{done:?}");
        assert!(!map_dir.join("terrain").join("sw").exists() && !map_dir.join("terrain").join("nw").exists() && !map_dir.join("terrain").join("ne").exists(), "the old folders are gone");
        assert!(map_dir.join("terrain").join("se").join("terrain.txt").is_file());
        let open = crate::terrain_open::parse(&fs::read(crate::terrain_open::path(&dir)).unwrap()).unwrap();
        assert_eq!(open, ["south_west", "north"], "sw was open, so is south_west; ne was, so is north; se wasn't");
        assert_eq!(crate::derived::check(&dir).unwrap(), crate::derived::Freshness::Fresh, "the same map: the derived files still follow");
        assert_eq!(crate::terrain_pathing::assemble(&Layout::parse(&fs::read(map_dir.join(LAYOUT_FILE)).unwrap()).unwrap(), &|p| fs::read(crate::paths::join_rel(&map_dir, p)).ok()).unwrap(), Some(json.clone()));
        fs::remove_file(crate::terrain_open::path(&dir)).unwrap();
        merge_project(&dir).unwrap();
        for (name, bytes) in &flat {
            assert_eq!(&fs::read(map_dir.join(name)).unwrap(), bytes, "{name} after split, relayout and merge");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// The layout editor: a preview says what a split or relayout would write and which objects change subterrain,
    /// writing nothing, and refuses with the change's own reason; a change kept for undo is taken back byte for byte
    /// (the open choice and the derived files' record too) and made again, and refused once a file changed since.
    #[test]
    fn a_relayout_previewed_taken_back_and_made_again() {
        let dir = std::env::temp_dir().join(format!("w3proj-terrain-undo-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        crate::project::create(&dir, None).unwrap();
        let map_dir = dir.join("map");
        let t = terrain(12, false);
        let mut flat = flat_files(&t);
        with_objects(&mut flat, 8);
        write_changed(&map_dir, &flat).unwrap();
        fs::write(map_dir.join("war3map.wpm"), b"pathing").unwrap();
        crate::derived::record_now(&dir).unwrap();
        let disk = || -> Vec<(String, Vec<u8>)> { crate::project::walk(&dir).unwrap().into_iter().map(|p| (p.clone(), fs::read(crate::paths::join_rel(&dir, &p)).unwrap())).collect() };

        // A split previewed: one subterrain with every object, the flat files to go; nothing written.
        let flat_disk = disk();
        let p = split_preview(&dir, &[]).unwrap();
        assert_eq!(p.subterrains.iter().map(|s| (s.name.as_str(), s.doodads, s.units, s.regions)).collect::<Vec<_>>(), [("main", 5, 4, 1)]);
        assert!(p.written.contains(&"map/terrain/terrain.json".to_string()) && p.removed.contains(&"map/war3map.w3e.txt".to_string()), "{p:?}");
        assert!(p.moves.is_empty());
        assert!(split_preview(&dir, &[rect("west:0,0,2,3")]).unwrap_err().to_string().contains("would be lost"));
        assert_eq!(disk(), flat_disk, "a preview writes nothing");

        split_project(&dir, &grid_2x2(t.width, t.height)).unwrap();
        let layout = Layout::parse(&fs::read(map_dir.join(LAYOUT_FILE)).unwrap()).unwrap();
        crate::terrain_open::store(&dir, &layout, &["sw".into(), "ne".into()]).unwrap();
        let split_disk = disk();
        // Column 0 (the objects at world x -500) into a new subterrain: those of sw and nw move into it.
        let new = plan(&["west=:0,0,1,7", "sw:1,0,3,3", "se:4,0,5,3", "nw:1,3,3,4", "ne:4,3,5,4"]);
        let p = relayout_preview(&dir, &new).unwrap();
        let moves: Vec<(&str, &str, &str, usize)> = p.moves.iter().map(|m| (m.kind, m.from.as_str(), m.to.as_str(), m.count)).collect();
        assert_eq!(moves, [("doodads", "nw", "west", 1), ("doodads", "sw", "west", 1), ("units", "nw", "west", 1), ("units", "sw", "west", 1)]);
        assert_eq!(p.subterrains.iter().map(|s| (s.name.as_str(), s.units, s.from.clone())).collect::<Vec<_>>()[..2], [("west", 2, vec![]), ("sw", 0, vec!["sw".to_string()])]);
        assert_eq!(p.subterrains[0].id_ranges, [[50000, 59999]], "a new one gets the next block");
        assert!(p.written.contains(&"map/terrain/west/units.json".to_string()) && p.removed.is_empty(), "{p:?}");
        let refused = relayout_preview(&dir, &plan(&["sw:0,0,4,3", "nw:0,3,4,4", "ne:4,3,5,4"])).unwrap_err().to_string();
        assert!(refused.contains("would be lost"), "{refused}");
        assert_eq!(disk(), split_disk, "a preview writes nothing");

        // Applied, kept for undo; the preview said what it wrote.
        let (done, before, after) = relayout_project_undoable(&dir, &new).unwrap();
        assert_eq!(done.written, p.written);
        let applied_disk = disk();
        assert_ne!(applied_disk, split_disk);
        assert_eq!(crate::terrain_open::parse(after.open.as_deref().unwrap()).unwrap(), ["west", "sw", "ne"], "a new one is open");
        // Taken back: every file as before, the new folder gone, the open choice back, the derived files still follow.
        let back = restore_layout(&dir, &after, &before).unwrap();
        assert!(back.removed.contains(&"map/terrain/west/units.json".to_string()) && back.written.contains(&crate::terrain_open::NAME.to_string()), "{back:?}");
        assert_eq!(disk(), split_disk);
        assert!(!map_dir.join("terrain").join("west").exists());
        assert_eq!(crate::derived::check(&dir).unwrap(), crate::derived::Freshness::Fresh);
        // Made again, then a file changed since: taking it back is refused and changes nothing.
        restore_layout(&dir, &before, &after).unwrap();
        assert_eq!(disk(), applied_disk);
        let units = map_dir.join("terrain").join("west").join("units.json");
        let original = fs::read(&units).unwrap();
        let edited = [original.clone(), b" ".to_vec()].concat();
        fs::write(&units, &edited).unwrap();
        let changed = disk();
        let e = restore_layout(&dir, &after, &before).unwrap_err().to_string();
        assert!(e.contains("changed since (map/terrain/west/units.json)"), "{e}");
        assert_eq!(disk(), changed);
        // Control: refused when the layout isn't the one it was made from, also for the open choice alone.
        fs::write(&units, &original).unwrap();
        assert_eq!(disk(), applied_disk);
        fs::remove_file(crate::terrain_open::path(&dir)).unwrap();
        assert!(restore_layout(&dir, &after, &before).unwrap_err().to_string().contains(crate::terrain_open::NAME));
        let _ = fs::remove_dir_all(&dir);
    }

    /// The flat object files as the app's Map Size leaves them for terrain `t`: objects strictly inside the new map, the
    /// special doodads moved with their tiles (those off the map gone), regions whose minimum corner is off the map gone.
    fn objects_map_sized(flat: &Files, t: &Terrain, shift: [i64; 2]) -> Files {
        let (left, bottom) = (f64::from(t.offset[0]), f64::from(t.offset[1]));
        let (right, top) = (left + 128.0 * (t.width - 1) as f64, bottom + 128.0 * (t.height - 1) as f64);
        let inside = |x: f64, y: f64| left < x && x < right && bottom < y && y < top;
        let mut out = Files::new();
        for (name, list, special) in [("war3map.doo.json", "doodads", true), ("war3mapUnits.doo.json", "units", false), ("war3map.w3r.json", "regions", false)] {
            let mut doc: Value = serde_json::from_slice(&flat[name]).unwrap();
            doc[list].as_array_mut().unwrap().retain(|e| match e.get("position") {
                Some(p) => inside(p[0].as_f64().unwrap(), p[1].as_f64().unwrap()),
                None => inside(e["left"].as_f64().unwrap(), e["bottom"].as_f64().unwrap()),
            });
            if special {
                let specials = doc["specials"].as_array_mut().unwrap();
                for s in specials.iter_mut() {
                    s["x"] = (s["x"].as_i64().unwrap() + shift[0]).into();
                    s["y"] = (s["y"].as_i64().unwrap() + shift[1]).into();
                }
                specials.retain(|s| (0..t.width as i64 - 1).contains(&s["x"].as_i64().unwrap()) && (0..t.height as i64 - 1).contains(&s["y"].as_i64().unwrap()));
            }
            out.insert(name.into(), [serde_json::to_vec_pretty(&doc).unwrap(), b"\n".to_vec()].concat());
        }
        out
    }

    /// Map Size on a split terrain (what `write_flat` does when the terrain comes with another size): random changes of
    /// the four sides (seeded), the terrain and objects as the app's resize leaves them. The layout's files then hold
    /// exactly that map; every object lies in the subterrain owning its position; the subterrains left keep name,
    /// folder and ranges; the pathing overrides move with their ground (those off the map go). A growth shrunk back
    /// gives the split files back byte for byte (nothing was cut). A partial load refuses the change.
    #[test]
    fn random_map_sizes_keep_the_split_map() {
        let (flat, split, json) = split_with_everything();
        let old_layout = Layout::parse(&split[LAYOUT_FILE]).unwrap();
        let old_t = w3e::terrain_from_text(&flat[FLAT_FILE]).unwrap();
        let old_cells = crate::terrain_pathing::parse_json(&json, old_layout.corners()).unwrap();
        let mut seed: u64 = 0x5eed_512e;
        let mut next = |n: i64| -> i64 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) % n as u64) as i64
        };
        eprintln!("random_map_sizes_keep_the_split_map: seed 0x5eed512e");
        let (mut grown_back, mut cut, mut dropped) = (0, 0, 0);
        for round in 0..60 {
            let mut change = [0i64; 4];
            for c in change.iter_mut() {
                *c = next(9) - 4;
            }
            // At least two corners each way.
            if old_t.width as i64 + change[0] + change[1] < 2 || old_t.height as i64 + change[2] + change[3] < 2 {
                continue;
            }
            let t = map_sized(&old_t, change);
            let shift = [change[0], change[2]];
            let objects = objects_map_sized(&flat, &t, shift);
            let mut files = split.clone();
            files.insert(FLAT_FILE.into(), w3e::terrain_text(&t).unwrap());
            files.extend(objects.clone());
            let flats: Flats = KINDS.into_iter().map(|k| (k, objects[k.flat()].clone())).collect();
            let out = resized_files(&files, &old_layout, &t, &flats, Some(&old_layout.objects.twice)).unwrap_or_else(|e| panic!("round {round} {change:?}: {e}"));
            assert!(out.keys().all(|k| under_dir(k)), "round {round}");
            let layout = Layout::parse(&out[LAYOUT_FILE]).unwrap();
            assert_eq!(layout.corners(), [t.width, t.height]);
            // The map is the resized one.
            let mut back = out.clone();
            assert!(flatten(&mut back).unwrap());
            assert_eq!(back[FLAT_FILE], files[FLAT_FILE], "round {round} {change:?}: the terrain");
            for (name, bytes) in &objects {
                assert!(objects::same(&back[name], bytes), "round {round} {change:?}: {name}");
            }
            // Owners by position, names, folders and ranges kept.
            for (i, s) in layout.subterrains.iter().enumerate() {
                let was = old_layout.subterrains.iter().find(|o| o.name == s.name).expect("only old subterrains");
                assert_eq!((&s.folder, &s.id_ranges), (&was.folder, &was.id_ranges), "round {round}");
                for (kind, list) in [(Kind::Units, "units"), (Kind::Doodads, "doodads")] {
                    let doc: Value = serde_json::from_slice(&out[&s.object_path(kind)]).unwrap();
                    for e in doc[list].as_array().unwrap() {
                        let (x, y) = (e["position"][0].as_f64().unwrap(), e["position"][1].as_f64().unwrap());
                        assert_eq!(objects::owner(&layout.subterrains, layout.offset(), x, y), i, "round {round}: {list} at {x},{y}");
                    }
                }
            }
            dropped += old_layout.subterrains.len() - layout.subterrains.len();
            // The pathing overrides moved with their ground.
            let (w, h) = (4 * (t.width - 1) as i64, 4 * (t.height - 1) as i64);
            let want: Vec<crate::terrain_pathing::Cell> = old_cells
                .iter()
                .filter_map(|c| {
                    let (x, y) = (i64::from(c.x) + 4 * shift[0], i64::from(c.y) + 4 * shift[1]);
                    (x >= 0 && y >= 0 && x < w && y < h).then_some(crate::terrain_pathing::Cell { x: x as u32, y: y as u32, ..*c })
                })
                .collect();
            let got = crate::terrain_pathing::assemble(&layout, &|p| out.get(p).cloned()).unwrap();
            if want.is_empty() {
                assert_eq!(got, None, "round {round}");
            } else {
                assert_eq!(got, Some(crate::terrain_pathing::json_text([t.width, t.height], &want)), "round {round} {change:?}: the overrides");
            }
            // Grown only: shrunk back, the split files as they were.
            if change.iter().all(|c| *c >= 0) {
                let mut again = out.clone();
                again.insert(FLAT_FILE.into(), flat[FLAT_FILE].clone());
                let flats: Flats = KINDS.into_iter().map(|k| (k, flat[k.flat()].clone())).collect();
                let undone = resized_files(&again, &layout, &old_t, &flats, Some(&layout.objects.twice)).unwrap();
                let before: Files = split.iter().filter(|(k, _)| under_dir(k)).map(|(k, v)| (k.clone(), v.clone())).collect();
                assert_eq!(undone, before, "round {round} {change:?}: grown and shrunk back");
                grown_back += 1;
            } else {
                cut += 1;
            }
        }
        assert!(grown_back > 0 && cut > 20 && dropped > 0, "grown back {grown_back}, cut {cut}, subterrains cut away {dropped}: the rounds reached too little");
        // An offset moved by part of a tile is refused.
        let mut odd = map_sized(&old_t, [1, 0, 0, 0]);
        odd.offset[0] += 1.0;
        assert!(canvas_shift(&old_layout, &odd).unwrap_err().to_string().contains("part of a tile"));
    }

    /// On disk: Map Size cutting the east half off a 2×2 split removes the east subterrains' folders and their pathing
    /// overrides, the west ones keep theirs; grown back, the east is the west ones' (the ground Map Size adds copies the
    /// edge), and the map reads as written.
    #[test]
    fn map_size_on_disk_removes_what_it_cuts_away() {
        let dir = std::env::temp_dir().join(format!("w3proj-terrain-mapsize-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        crate::project::create(&dir, None).unwrap();
        let map_dir = dir.join("map");
        let t = terrain(12, false);
        let mut flat = flat_files(&t);
        with_objects(&mut flat, 8);
        write_changed(&map_dir, &flat).unwrap();
        let json = crate::terrain_pathing::json_path(&dir);
        fs::create_dir_all(json.parent().unwrap()).unwrap();
        fs::write(&json, crate::terrain_pathing::sample_json([t.width, t.height]).unwrap()).unwrap();
        split_project(&dir, &grid_2x2(t.width, t.height)).unwrap();
        assert!(map_dir.join("terrain/se/pathing.txt").is_file() || map_dir.join("terrain/ne/pathing.txt").is_file());
        // Cut 5 corners off the east (the east subterrains start at corner 4): objects there go, as Map Size removes them.
        let cut = map_sized(&t, [0, -5, 0, 0]);
        for (name, list) in [("war3map.doo.json", "doodads"), ("war3mapUnits.doo.json", "units")] {
            let mut doc: Value = serde_json::from_slice(&read_flat(&map_dir, name).unwrap()).unwrap();
            doc[list].as_array_mut().unwrap().retain(|e| e["position"][0].as_f64().unwrap() < -100.0);
            if list == "doodads" {
                doc["specials"] = serde_json::json!([]);
            }
            write_flat(&map_dir, name, &serde_json::to_vec_pretty(&doc).unwrap()).unwrap();
        }
        let mut regions: Value = serde_json::from_slice(&read_flat(&map_dir, "war3map.w3r.json").unwrap()).unwrap();
        regions["regions"] = serde_json::json!([]);
        write_flat(&map_dir, "war3map.w3r.json", &serde_json::to_vec_pretty(&regions).unwrap()).unwrap();
        write_flat(&map_dir, FLAT_FILE, &w3e::terrain_text(&cut).unwrap()).unwrap();
        let layout = Layout::parse(&fs::read(map_dir.join(LAYOUT_FILE)).unwrap()).unwrap();
        assert_eq!(layout.subterrains.iter().map(|s| (s.name.as_str(), s.w)).collect::<Vec<_>>(), [("sw", 4), ("nw", 4)]);
        assert!(!map_dir.join("terrain/se").exists() && !map_dir.join("terrain/ne").exists(), "the cut subterrains' folders are gone");
        assert_eq!(read_flat(&map_dir, FLAT_FILE).unwrap(), w3e::terrain_text(&cut).unwrap());
        // The overrides on the west half stay, those cut off go.
        let cells = crate::terrain_pathing::parse_json(&crate::terrain_pathing::sample_json([t.width, t.height]).unwrap(), [t.width, t.height]).unwrap();
        let kept: Vec<_> = cells.into_iter().filter(|c| c.x < 4 * 3).collect();
        assert!(!kept.is_empty());
        let got = crate::terrain_pathing::assemble(&layout, &|p| fs::read(crate::paths::join_rel(&map_dir, p)).ok()).unwrap();
        assert_eq!(got, Some(crate::terrain_pathing::json_text([cut.width, cut.height], &kept)));
        // Grown back east: the west subterrains reach the new edge.
        let grown = map_sized(&cut, [0, 5, 0, 0]);
        write_flat(&map_dir, FLAT_FILE, &w3e::terrain_text(&grown).unwrap()).unwrap();
        let layout = Layout::parse(&fs::read(map_dir.join(LAYOUT_FILE)).unwrap()).unwrap();
        assert_eq!(layout.subterrains.iter().map(|s| (s.name.as_str(), s.w)).collect::<Vec<_>>(), [("sw", 9), ("nw", 9)]);
        assert_eq!(read_flat(&map_dir, FLAT_FILE).unwrap(), w3e::terrain_text(&grown).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    /// The growth rule of `resized_canvas` side by side, on a 65×65 canvas split 2×2 and into one `main`: the strip added
    /// on a side joins the subterrains on that side (each over its span), a corner region the corner one; the others
    /// only move with their ground. The layout still tiles the canvas. A cut takes rows off the edge ones, and one cut
    /// off entirely goes.
    #[test]
    fn map_size_grows_and_cuts_the_edge_subterrains() {
        let sub = |r: &Rect| Subterrain { name: r.name.clone(), folder: r.name.clone(), x: r.x, y: r.y, w: r.w, h: r.h, id_ranges: vec![[1, 2]] };
        let grid: Vec<Subterrain> = grid_2x2(65, 65).iter().map(sub).collect();
        let main = vec![sub(&Rect { name: "main".into(), x: 0, y: 0, w: 65, h: 65 })];
        let rects = |subs: &[Subterrain]| subs.iter().map(|s| (s.name.clone(), s.x, s.y, s.w, s.h)).collect::<Vec<_>>();
        // [west, east, south, north] in corners: the canvas and the shift resized_canvas is given (as canvas_shift makes it).
        let resized = |subs: &[Subterrain], c: [i64; 4]| {
            let new = [(65 + c[0] + c[1]) as usize, (65 + c[2] + c[3]) as usize];
            resized_canvas(subs, [65, 65], new, [c[0], c[2]]).map(|s| rects(&s))
        };
        let tiles = |subs: &[(String, usize, usize, usize, usize)], w: usize, h: usize| {
            let mut n = vec![0u8; w * h];
            for (_, x, y, sw, sh) in subs {
                for yy in *y..y + sh {
                    for xx in *x..x + sw {
                        n[yy * w + xx] += 1;
                    }
                }
            }
            n.iter().all(|&k| k == 1)
        };
        let r = |n: &str, x, y, w, h| (n.to_string(), x, y, w, h);
        // 2×2 (sw 0,0 32×32; se 32,0 33×32; nw 0,32 32×33; ne 32,32 33×33), one side at a time.
        type Want<'a> = [(&'a str, usize, usize, usize, usize); 4];
        let cases: [([i64; 4], Want); 6] = [
            ([4, 0, 0, 0], [("sw", 0, 0, 36, 32), ("se", 36, 0, 33, 32), ("nw", 0, 32, 36, 33), ("ne", 36, 32, 33, 33)]),
            ([0, 4, 0, 0], [("sw", 0, 0, 32, 32), ("se", 32, 0, 37, 32), ("nw", 0, 32, 32, 33), ("ne", 32, 32, 37, 33)]),
            ([0, 0, 4, 0], [("sw", 0, 0, 32, 36), ("se", 32, 0, 33, 36), ("nw", 0, 36, 32, 33), ("ne", 32, 36, 33, 33)]),
            ([0, 0, 0, 4], [("sw", 0, 0, 32, 32), ("se", 32, 0, 33, 32), ("nw", 0, 32, 32, 37), ("ne", 32, 32, 33, 37)]),
            // Two sides at once: the corner region (west and north) is nw's, the one subterrain on both sides.
            ([8, 0, 0, 4], [("sw", 0, 0, 40, 32), ("se", 40, 0, 33, 32), ("nw", 0, 32, 40, 37), ("ne", 40, 32, 33, 37)]),
            // Every side: each corner region to its corner subterrain.
            ([4, 4, 4, 4], [("sw", 0, 0, 36, 36), ("se", 36, 0, 37, 36), ("nw", 0, 36, 36, 37), ("ne", 36, 36, 37, 37)]),
        ];
        for (c, want) in cases {
            let got = resized(&grid, c).unwrap();
            assert_eq!(got, want.iter().map(|&(n, x, y, w, h)| r(n, x, y, w, h)).collect::<Vec<_>>(), "2×2 grown by {c:?}");
            assert!(tiles(&got, (65 + c[0] + c[1]) as usize, (65 + c[2] + c[3]) as usize), "2×2 grown by {c:?} tiles the canvas");
            // `main` covers the whole new canvas.
            assert_eq!(resized(&main, c).unwrap(), vec![r("main", 0, 0, (65 + c[0] + c[1]) as usize, (65 + c[2] + c[3]) as usize)], "main grown by {c:?}");
        }
        // Cuts: 8 off the west and 4 off the north take them off the edge subterrains; the others keep their size.
        let got = resized(&grid, [-8, 0, 0, -4]).unwrap();
        assert_eq!(got, vec![r("sw", 0, 0, 24, 32), r("se", 24, 0, 33, 32), r("nw", 0, 32, 24, 29), r("ne", 24, 32, 33, 29)]);
        assert!(tiles(&got, 57, 61));
        // 36 off the west: the west column (32 wide) is gone entirely, the east one is the canvas's west edge now.
        let got = resized(&grid, [-36, 0, 0, 0]).unwrap();
        assert_eq!(got, vec![r("se", 0, 0, 29, 32), r("ne", 0, 32, 29, 33)]);
        assert!(tiles(&got, 29, 65));
        // Cut and grown at once (west cut, east grown): the east column takes the new strip.
        assert_eq!(resized(&grid, [-4, 8, 0, 0]).unwrap(), vec![r("sw", 0, 0, 28, 32), r("se", 28, 0, 41, 32), r("nw", 0, 32, 28, 33), r("ne", 28, 32, 41, 33)]);
        assert_eq!(resized(&main, [-8, 0, -4, 0]).unwrap(), vec![r("main", 0, 0, 57, 61)]);
        // Nothing left is refused (control: a canvas of 0 corners leaves no rectangle).
        assert!(resized_canvas(&grid, [65, 65], [0, 65], [-65, 0]).is_err());
    }

    #[test]
    fn rect_arguments() {
        assert_eq!(rect("west:0,0,64,129"), Rect { name: "west".into(), x: 0, y: 0, w: 64, h: 129 });
        for bad in ["west", "west:1,2,3", "west:1,2,3,x", "west:-1,0,1,1"] {
            assert!(bad.parse::<Rect>().is_err(), "{bad}");
        }
    }
}
