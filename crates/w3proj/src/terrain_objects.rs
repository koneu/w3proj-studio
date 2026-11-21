//! Placed objects and regions in the split terrain layout (`terrain_layout`): each subterrain's
//! `doodads.json`, `units.json` and `regions.json` hold the entries of the flat `war3map.doo.json`,
//! `war3mapUnits.doo.json` and `war3map.w3r.json` whose position lies in its rectangle.
//!
//! ```text
//! doodads.json   {"doodads": [...], "specials": [...]}
//! units.json     {"units": [...]}
//! regions.json   {"regions": [...]}
//! ```
//!
//! An entry is the flat file's entry as it is (every field, exact world position), plus `"order"`
//! first where it needs one. What the flat files hold besides their lists is global and goes into
//! `terrain.json`: `dooHeader` (versions, skin ids) and `objects` (which flat files there are, the
//! doodad files' `magic` and `specialVersion`, the regions' `version`, a file's `skinIds` where it
//! differs from `dooHeader`'s).
//!
//! **Who owns an entry:** a doodad, unit or item belongs to the subterrain whose rectangle holds its
//! `(x, y)` in world coordinates (corner `c` lies at `offset + 128 · c`, a subterrain covers
//! `[offset + 128 · x, offset + 128 · (x + w))` and the same in y); outside every rectangle, the
//! nearest one (distance to the rectangle, ties to the first in `subterrains[]`). A position that
//! isn't a finite number lands in the first. A region belongs to the subterrain holding its minimum
//! corner (`left`, `bottom`), a special doodad (placed by tile) to the one holding its tile corner.
//!
//! **Order:** each list is sorted by creation number (`editorId`; for version-13 doodads the placement
//! id `trailer[0]`, their `editorId` is -1 in every one; regions: `index`); special doodads, which
//! have none, by `y`, `x`, `id`, `z`. An entry whose index in the flat file differs from its place in
//! that sorted order keeps the index as `"order"`. Merging puts every entry with an `order` at that
//! index and fills the other places with the rest in sorted order, so a map split and merged without
//! edits gives back the same flat file. A creation number twice is an error naming both files; it is
//! never renumbered (scripts refer to it).

use std::collections::{BTreeMap, HashMap};

use serde_json::{Map, Value};

use crate::terrain_layout::{self as tl, DooHeader, Subterrain};
use crate::{Error, Result};

/// A tile's size in world units.
const TILE: f64 = 128.0;

/// One entry of a list, as the flat file has it.
type Entry = Map<String, Value>;
/// Flat object files: kind → bytes.
pub type Flats = BTreeMap<Kind, Vec<u8>>;

/// An entry on its way into a subterrain's file: sort key, index in the flat file, order, entry.
type Placed = (SortKey, usize, Option<u64>, Entry);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Kind {
    Doodads,
    Units,
    Regions,
}

pub const KINDS: [Kind; 3] = [Kind::Doodads, Kind::Units, Kind::Regions];

impl Kind {
    /// The flat layout's file, relative to `map/`.
    pub fn flat(self) -> &'static str {
        match self {
            Kind::Doodads => "war3map.doo.json",
            Kind::Units => "war3mapUnits.doo.json",
            Kind::Regions => "war3map.w3r.json",
        }
    }
    /// The archive file kept raw (its codec couldn't read it): then it stays where it is.
    pub fn raw(self) -> &'static str {
        match self {
            Kind::Doodads => "war3map.doo",
            Kind::Units => "war3mapUnits.doo",
            Kind::Regions => "war3map.w3r",
        }
    }
    /// The file in a subterrain's folder.
    pub fn file(self) -> &'static str {
        match self {
            Kind::Doodads => "doodads.json",
            Kind::Units => "units.json",
            Kind::Regions => "regions.json",
        }
    }
    /// The list's key in both files, and the kind's key in `terrain.json`'s `objects`.
    pub fn name(self) -> &'static str {
        match self {
            Kind::Doodads => "doodads",
            Kind::Units => "units",
            Kind::Regions => "regions",
        }
    }
    fn format(self) -> &'static str {
        match self {
            Kind::Doodads => "w3proj.doodads/1",
            Kind::Units => "w3proj.units/1",
            Kind::Regions => "w3proj.regions/1",
        }
    }
    /// The flat file's keys, in the order unpack writes them.
    fn keys(self) -> &'static [&'static str] {
        match self {
            Kind::Doodads => &["format", "magic", "version", "subversion", "skinIds", "doodads", "specialVersion", "specials"],
            Kind::Units => &["format", "magic", "version", "subversion", "skinIds", "units"],
            Kind::Regions => &["format", "version", "regions"],
        }
    }
}

/// The header of a placement file (`war3map.doo`, `war3mapUnits.doo`). `skin_ids`: the flat file's
/// `skinIds`, when it has one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DooFile {
    pub magic: String,
    pub version: u32,
    pub subversion: u32,
    pub skin_ids: Option<bool>,
}

/// What the flat object files hold besides their lists; a kind that is `None` has no flat file (or
/// keeps it in the flat layout, raw).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Heads {
    /// The doodads' header and `specialVersion`.
    pub doodads: Option<(DooFile, u32)>,
    pub units: Option<DooFile>,
    /// The regions' `version`.
    pub regions: Option<u32>,
}

impl Heads {
    pub fn has(&self, kind: Kind) -> bool {
        match kind {
            Kind::Doodads => self.doodads.is_some(),
            Kind::Units => self.units.is_some(),
            Kind::Regions => self.regions.is_some(),
        }
    }

    pub fn is_empty(&self) -> bool {
        KINDS.iter().all(|k| !self.has(*k))
    }

    /// `terrain.json`'s `dooHeader` for these files: each file's version and subversion (a missing
    /// file takes the other's), `skinIds` of the first file that has one (else false). None without
    /// doodads and units.
    pub fn doo_header(&self) -> Option<DooHeader> {
        let d = self.doodads.as_ref().map(|(f, _)| f);
        let (dv, uv) = match (d, self.units.as_ref()) {
            (None, None) => return None,
            (Some(d), None) => (d, d),
            (None, Some(u)) => (u, u),
            (Some(d), Some(u)) => (d, u),
        };
        Some(DooHeader {
            doodads_version: dv.version,
            doodads_subversion: dv.subversion,
            units_version: uv.version,
            units_subversion: uv.subversion,
            skin_ids: d.into_iter().chain(self.units.as_ref()).find_map(|f| f.skin_ids).unwrap_or(false),
        })
    }

    /// `terrain.json`'s `"objects": {…}` (two spaces in), or nothing when there are no object files.
    pub(crate) fn to_json(&self, header: Option<&DooHeader>) -> String {
        if self.is_empty() {
            return String::new();
        }
        let q = |s: &str| serde_json::to_string(s).expect("a string serializes");
        // A file's skinIds goes in only where dooHeader doesn't give it: a version-8 file takes dooHeader's.
        let skin = |f: &DooFile| {
            let given = (f.version == 8).then(|| header.map(|h| h.skin_ids).unwrap_or(false));
            match f.skin_ids {
                s if s == given => String::new(),
                Some(b) => format!(", \"skinIds\": {b}"),
                None => String::new(),
            }
        };
        let mut parts = Vec::new();
        if let Some((f, special)) = &self.doodads {
            parts.push(format!("    \"doodads\": {{ \"magic\": {}, \"specialVersion\": {special}{} }}", q(&f.magic), skin(f)));
        }
        if let Some(f) = &self.units {
            parts.push(format!("    \"units\": {{ \"magic\": {}{} }}", q(&f.magic), skin(f)));
        }
        if let Some(v) = self.regions {
            parts.push(format!("    \"regions\": {{ \"version\": {v} }}"));
        }
        format!("  \"objects\": {{\n{}\n  }},\n", parts.join(",\n"))
    }

    /// Reads `terrain.json`'s `objects` with its `dooHeader` (needed when there are doodads or units).
    pub(crate) fn parse(v: &Value, header: Option<&DooHeader>) -> Result<Heads> {
        let o = tl::object(v, "objects", &[], &["doodads", "units", "regions"])?;
        let doo = |key: &str, extra: &[&str]| -> Result<Option<(DooFile, Map<String, Value>)>> {
            let Some(v) = o.get(key) else { return Ok(None) };
            let what = format!("objects.{key}");
            let mut need = vec!["magic"];
            need.extend_from_slice(extra);
            let f = tl::object(v, &what, &need, &["skinIds"])?;
            let h = header.ok_or_else(|| tl::bad(format!("{what} is there, dooHeader isn't")))?;
            let (version, subversion) = if key == "doodads" { (h.doodads_version, h.doodads_subversion) } else { (h.units_version, h.units_subversion) };
            let skin_ids = match f.get("skinIds") {
                None => (version == 8).then_some(h.skin_ids),
                Some(b) => Some(b.as_bool().ok_or_else(|| tl::bad(format!("{what}.skinIds isn't true or false")))?),
            };
            let magic = f["magic"].as_str().ok_or_else(|| tl::bad(format!("{what}.magic isn't a string")))?.to_string();
            Ok(Some((DooFile { magic, version, subversion, skin_ids }, f.clone())))
        };
        let doodads = match doo("doodads", &["specialVersion"])? {
            None => None,
            Some((f, m)) => Some((f, tl::uint(&m["specialVersion"], "objects.doodads.specialVersion", u32::MAX as u64)? as u32)),
        };
        let units = doo("units", &[])?.map(|(f, _)| f);
        let regions = match o.get("regions") {
            None => None,
            Some(v) => {
                let r = tl::object(v, "objects.regions", &["version"], &[])?;
                Some(tl::uint(&r["version"], "objects.regions.version", u32::MAX as u64)? as u32)
            }
        };
        Ok(Heads { doodads, units, regions })
    }
}

// ---- entries ----

/// What a list is sorted by.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum SortKey {
    /// A creation number.
    Number(u32),
    /// A special doodad: y, x, id, z, then its whole text (so only alike entries tie).
    Special(u64, u64, String, u64, String),
}

/// The two lists of a kind: its own, and the doodads' special doodads.
#[derive(Clone, Copy, PartialEq, Eq)]
enum List {
    Main,
    Specials,
}

fn list_key(kind: Kind, list: List) -> &'static str {
    match list {
        List::Main => kind.name(),
        List::Specials => "specials",
    }
}

fn lists(kind: Kind) -> &'static [List] {
    match kind {
        Kind::Doodads => &[List::Main, List::Specials],
        _ => &[List::Main],
    }
}

/// An entry's sort key; `version`: the doodads' (version 13 numbers them by `trailer[0]`).
fn sort_key(kind: Kind, list: List, version: u32, e: &Map<String, Value>) -> std::result::Result<SortKey, String> {
    if list == List::Specials {
        let n = |k: &str| e.get(k).and_then(Value::as_u64).unwrap_or(u64::MAX);
        let id = e.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let text = serde_json::to_string(e).expect("JSON serializes");
        return Ok(SortKey::Special(n("y"), n("x"), id, n("z"), text));
    }
    let (field, v) = match kind {
        Kind::Doodads if version >= 13 => ("trailer[0]", e.get("trailer").and_then(|t| t.get(0))),
        Kind::Doodads | Kind::Units => ("editorId", e.get("editorId")),
        Kind::Regions => ("index", e.get("index")),
    };
    v.and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .map(SortKey::Number)
        .ok_or_else(|| format!("an entry's creation number ({field}) isn't a whole number from 0 to {}", u32::MAX))
}

/// A float as the codecs write it: a number, or `"f32:0x…"` for one that isn't finite.
fn float(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.strip_prefix("f32:0x").and_then(|h| u32::from_str_radix(h, 16).ok()).map(|b| f32::from_bits(b) as f64),
        _ => None,
    }
}

/// The world `(x, y)` that decides an entry's subterrain.
fn position(kind: Kind, list: List, e: &Map<String, Value>, offset: [f32; 2]) -> std::result::Result<(f64, f64), String> {
    let p = match (kind, list) {
        (_, List::Specials) => {
            let n = |k: &str| e.get(k).and_then(Value::as_u64).map(|n| offset[if k == "x" { 0 } else { 1 }] as f64 + n as f64 * TILE);
            n("x").zip(n("y"))
        }
        (Kind::Regions, _) => e.get("left").and_then(float).zip(e.get("bottom").and_then(float)),
        _ => match e.get("position").and_then(Value::as_array).map(Vec::as_slice) {
            Some([x, y, _]) => float(x).zip(float(y)),
            _ => None,
        },
    };
    p.ok_or_else(|| {
        match (kind, list) {
            (_, List::Specials) => "a special doodad's x and y aren't whole numbers",
            (Kind::Regions, _) => "a region's left and bottom aren't numbers",
            _ => "an entry's position isn't a list of three numbers",
        }
        .to_string()
    })
}

/// The subterrain an object at world `(x, y)` belongs to (see the module's text).
pub fn owner(subs: &[Subterrain], offset: [f32; 2], x: f64, y: f64) -> usize {
    let mut best = (0, f64::INFINITY);
    for (i, s) in subs.iter().enumerate() {
        let (left, right) = (offset[0] as f64 + s.x as f64 * TILE, offset[0] as f64 + (s.x + s.w) as f64 * TILE);
        let (bottom, top) = (offset[1] as f64 + s.y as f64 * TILE, offset[1] as f64 + (s.y + s.h) as f64 * TILE);
        if left <= x && x < right && bottom <= y && y < top {
            return i;
        }
        let dx = (left - x).max(x - right).max(0.0);
        let dy = (bottom - y).max(y - top).max(0.0);
        let d = dx * dx + dy * dy;
        if d < best.1 {
            best = (i, d);
        }
    }
    best.0
}

fn with_order(order: Option<u64>, e: Map<String, Value>) -> Value {
    match order {
        None => Value::Object(e),
        Some(o) => {
            let mut m = Map::new();
            m.insert("order".into(), o.into());
            m.extend(e);
            Value::Object(m)
        }
    }
}

/// JSON as `serde_json` reads it, but a key twice in one object is an error: damage that cuts from
/// inside one entry to inside the next (`…, "editorId": 0, ⟨cut⟩ "position": …`) leaves valid JSON
/// with keys twice, and plain JSON reading would quietly keep one object of the two.
pub(crate) fn strict_json(bytes: &[u8]) -> std::result::Result<Value, String> {
    use serde::de::{DeserializeSeed, Deserializer, Error as _, MapAccess, SeqAccess, Visitor};
    struct Strict;
    impl<'de> DeserializeSeed<'de> for Strict {
        type Value = Value;
        fn deserialize<D: Deserializer<'de>>(self, d: D) -> std::result::Result<Value, D::Error> {
            d.deserialize_any(Strict)
        }
    }
    impl<'de> Visitor<'de> for Strict {
        type Value = Value;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("JSON")
        }
        fn visit_bool<E>(self, v: bool) -> std::result::Result<Value, E> {
            Ok(Value::Bool(v))
        }
        fn visit_i64<E>(self, v: i64) -> std::result::Result<Value, E> {
            Ok(v.into())
        }
        fn visit_u64<E>(self, v: u64) -> std::result::Result<Value, E> {
            Ok(v.into())
        }
        fn visit_f64<E>(self, v: f64) -> std::result::Result<Value, E> {
            Ok(serde_json::Number::from_f64(v).map_or(Value::Null, Value::Number))
        }
        fn visit_str<E>(self, v: &str) -> std::result::Result<Value, E> {
            Ok(Value::String(v.to_string()))
        }
        fn visit_string<E>(self, v: String) -> std::result::Result<Value, E> {
            Ok(Value::String(v))
        }
        fn visit_unit<E>(self) -> std::result::Result<Value, E> {
            Ok(Value::Null)
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Value, A::Error> {
            let mut out = Vec::new();
            while let Some(v) = seq.next_element_seed(Strict)? {
                out.push(v);
            }
            Ok(Value::Array(out))
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Value, A::Error> {
            let mut out = Map::new();
            while let Some(k) = map.next_key::<String>()? {
                if out.contains_key(&k) {
                    return Err(A::Error::custom(format!("key \"{k}\" twice in one object")));
                }
                let v = map.next_value_seed(Strict)?;
                out.insert(k, v);
            }
            Ok(Value::Object(out))
        }
    }
    let mut de = serde_json::Deserializer::from_slice(bytes);
    let v = Strict.deserialize(&mut de).map_err(|e| e.to_string())?;
    de.end().map_err(|e| e.to_string())?;
    Ok(v)
}

fn pretty(v: &Value) -> Vec<u8> {
    let mut out = serde_json::to_vec_pretty(v).expect("JSON serializes");
    out.push(b'\n');
    out
}

fn flat_err(kind: Kind, m: impl std::fmt::Display) -> Error {
    Error::Format(format!("map/{} can't go into map/{}/: {m}", kind.flat(), tl::DIR))
}

fn u32_of(v: Option<&Value>) -> Option<u32> {
    v.and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok())
}

/// A flat file's header (`Heads` for its kind) and lists.
fn read_flat(kind: Kind, bytes: &[u8]) -> Result<(Heads, Vec<Vec<Entry>>)> {
    let doc: Value = serde_json::from_slice(bytes).map_err(|e| flat_err(kind, format!("it isn't JSON ({e})")))?;
    let o = doc.as_object().ok_or_else(|| flat_err(kind, "it isn't a JSON object"))?;
    if let Some(k) = o.keys().find(|k| !kind.keys().contains(&k.as_str())) {
        return Err(flat_err(kind, format!("it has a key \"{k}\" the split layout doesn't keep")));
    }
    if o.get("format").and_then(Value::as_str) != Some(kind.format()) {
        return Err(flat_err(kind, format!("its format isn't \"{}\"", kind.format())));
    }
    let need_u32 = |k: &str| u32_of(o.get(k)).ok_or_else(|| flat_err(kind, format!("its {k} isn't a whole number from 0 to {}", u32::MAX)));
    let doo = || -> Result<DooFile> {
        Ok(DooFile {
            magic: o.get("magic").and_then(Value::as_str).ok_or_else(|| flat_err(kind, "its magic isn't a string"))?.to_string(),
            version: need_u32("version")?,
            subversion: need_u32("subversion")?,
            skin_ids: match o.get("skinIds") {
                None => None,
                Some(b) => Some(b.as_bool().ok_or_else(|| flat_err(kind, "its skinIds isn't true or false"))?),
            },
        })
    };
    let mut heads = Heads::default();
    match kind {
        Kind::Doodads => heads.doodads = Some((doo()?, need_u32("specialVersion")?)),
        Kind::Units => heads.units = Some(doo()?),
        Kind::Regions => heads.regions = Some(need_u32("version")?),
    }
    let mut out = Vec::new();
    for list in lists(kind) {
        let key = list_key(kind, *list);
        let items = o.get(key).and_then(Value::as_array).ok_or_else(|| flat_err(kind, format!("its {key} isn't a list")))?;
        let mut entries = Vec::with_capacity(items.len());
        for (i, e) in items.iter().enumerate() {
            let e = e.as_object().ok_or_else(|| flat_err(kind, format!("{key}[{i}] isn't an object")))?;
            if e.contains_key("order") {
                return Err(flat_err(kind, format!("{key}[{i}] has a key \"order\", which the split layout uses itself")));
            }
            entries.push(e.clone());
        }
        out.push(entries);
    }
    Ok((heads, out))
}

fn doodads_version(heads: &Heads) -> u32 {
    heads.doodads.as_ref().map(|(f, _)| f.version).unwrap_or(0)
}

/// The flat object files (kind → bytes) cut into the subterrains `subs` of a canvas at `offset`:
/// the headers for `terrain.json`, and each subterrain's file (path relative to `map/` → bytes) for
/// every kind there is.
pub(crate) fn slice(flats: &Flats, subs: &[Subterrain], offset: [f32; 2]) -> Result<(Heads, BTreeMap<String, Vec<u8>>)> {
    let mut heads = Heads::default();
    let mut files = BTreeMap::new();
    for (&kind, bytes) in flats {
        let (head, entries) = read_flat(kind, bytes)?;
        let version = doodads_version(&head);
        match kind {
            Kind::Doodads => heads.doodads = head.doodads,
            Kind::Units => heads.units = head.units,
            Kind::Regions => heads.regions = head.regions,
        }
        // Per subterrain, per list: (sort key, index in the flat file, order, entry).
        let mut per_sub: Vec<Vec<Vec<Placed>>> = vec![vec![Vec::new(); lists(kind).len()]; subs.len()];
        for (li, (&list, entries)) in lists(kind).iter().zip(entries).enumerate() {
            let key = list_key(kind, list);
            let mut keys = Vec::with_capacity(entries.len());
            let mut seen: HashMap<u32, usize> = HashMap::new();
            for (i, e) in entries.iter().enumerate() {
                let k = sort_key(kind, list, version, e).map_err(|m| flat_err(kind, format!("{key}[{i}]: {m}")))?;
                if let SortKey::Number(n) = k {
                    if let Some(first) = seen.insert(n, i) {
                        return Err(flat_err(kind, format!("{key}[{first}] and {key}[{i}] have the same creation number {n} (creation numbers are never renumbered: change one by hand)")));
                    }
                }
                keys.push(k);
            }
            let mut sorted: Vec<usize> = (0..entries.len()).collect();
            sorted.sort_by(|&a, &b| keys[a].cmp(&keys[b]).then(a.cmp(&b)));
            let mut rank = vec![0; entries.len()];
            for (r, &i) in sorted.iter().enumerate() {
                rank[i] = r;
            }
            for (i, e) in entries.into_iter().enumerate() {
                let (x, y) = position(kind, list, &e, offset).map_err(|m| flat_err(kind, format!("{key}[{i}]: {m}")))?;
                let order = (rank[i] != i).then_some(i as u64);
                per_sub[owner(subs, offset, x, y)][li].push((keys[i].clone(), i, order, e));
            }
        }
        for (s, mut found) in subs.iter().zip(per_sub) {
            let mut doc = Map::new();
            for (&list, items) in lists(kind).iter().zip(found.iter_mut()) {
                items.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
                let values = items.drain(..).map(|(_, _, order, e)| with_order(order, e)).collect();
                doc.insert(list_key(kind, list).into(), Value::Array(values));
            }
            files.insert(s.object_path(kind), pretty(&Value::Object(doc)));
        }
    }
    Ok((heads, files))
}

/// One entry read from a subterrain's file.
struct Item {
    order: Option<u64>,
    key: SortKey,
    entry: Map<String, Value>,
}

/// The entries in their flat file's order: each with an `order` at that index (or the first free
/// place after it, when edits made the orders disagree), the others in sorted order around them.
fn merge(items: Vec<Item>) -> Vec<Map<String, Value>> {
    let (mut pinned, mut rest): (Vec<Item>, Vec<Item>) = items.into_iter().partition(|i| i.order.is_some());
    rest.sort_by(|a, b| a.key.cmp(&b.key));
    pinned.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.key.cmp(&b.key)));
    let n = pinned.len() + rest.len();
    let (mut pinned, mut rest) = (pinned.into_iter().peekable(), rest.into_iter().peekable());
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let take_pinned = match (pinned.peek(), rest.peek()) {
            (Some(p), Some(_)) => p.order.is_some_and(|o| o <= i as u64),
            (Some(_), None) => true,
            _ => false,
        };
        let item = if take_pinned { pinned.next() } else { rest.next() };
        out.extend(item.map(|i| i.entry));
    }
    out
}

/// A subterrain's file for `kind`: its lists' entries (an entry's `order` taken off).
fn read_sub(kind: Kind, path: &str, bytes: &[u8], version: u32) -> Result<Vec<Vec<Item>>> {
    let what = format!("map/{path}");
    let bad = |m: String| Error::Format(format!("{what}: {m}"));
    let doc = strict_json(bytes).map_err(|e| bad(format!("isn't JSON: {e}")))?;
    let o = doc.as_object().ok_or_else(|| bad("isn't a JSON object".into()))?;
    let keys: Vec<&str> = lists(kind).iter().map(|l| list_key(kind, *l)).collect();
    if let Some(k) = o.keys().find(|k| !keys.contains(&k.as_str())) {
        return Err(bad(format!("has an unknown key \"{k}\"")));
    }
    let mut out = Vec::new();
    for &list in lists(kind) {
        let key = list_key(kind, list);
        let items = o.get(key).ok_or_else(|| bad(format!("lacks \"{key}\"")))?.as_array().ok_or_else(|| bad(format!("{key} isn't a list")))?;
        let mut read = Vec::with_capacity(items.len());
        for (i, e) in items.iter().enumerate() {
            let mut entry = e.as_object().ok_or_else(|| bad(format!("{key}[{i}] isn't an object")))?.clone();
            let order = match entry.shift_remove("order") {
                None => None,
                Some(v) => Some(v.as_u64().ok_or_else(|| bad(format!("{key}[{i}].order isn't a whole number from 0")))?),
            };
            let key = sort_key(kind, list, version, &entry).map_err(|m| bad(format!("{key}[{i}]: {m}")))?;
            read.push(Item { order, key, entry });
        }
        out.push(read);
    }
    Ok(out)
}

/// The flat object files (kind → bytes, as unpack writes them) of the kinds `heads` has, merged from
/// the subterrains' files (`get`: path relative to `map/` → bytes). A subterrain without its file,
/// a file that can't be read and a creation number found twice are errors.
pub(crate) fn assemble(heads: &Heads, subs: &[Subterrain], get: &dyn Fn(&str) -> Option<Vec<u8>>) -> Result<Flats> {
    let mut out = BTreeMap::new();
    let version = doodads_version(heads);
    for kind in KINDS.into_iter().filter(|k| heads.has(*k)) {
        let mut per_list: Vec<Vec<Item>> = lists(kind).iter().map(|_| Vec::new()).collect();
        let mut seen: HashMap<u32, String> = HashMap::new();
        for s in subs {
            let path = s.object_path(kind);
            let bytes = get(&path).ok_or_else(|| Error::Format(format!("map/{path} is missing: subterrain \"{}\" has no {} file", s.name, kind.name())))?;
            for (li, items) in read_sub(kind, &path, &bytes, version)?.into_iter().enumerate() {
                for item in &items {
                    if let SortKey::Number(n) = item.key {
                        if let Some(other) = seen.insert(n, path.clone()) {
                            return Err(Error::Format(if other == path {
                                format!("map/{path} holds creation number {n} twice (creation numbers are never renumbered: change one by hand)")
                            } else {
                                format!("creation number {n} is in map/{other} and in map/{path} (creation numbers are never renumbered: change one by hand)")
                            }));
                        }
                    }
                }
                per_list[li].extend(items);
            }
        }
        let mut doc = Map::new();
        doc.insert("format".into(), kind.format().into());
        let doo = |doc: &mut Map<String, Value>, f: &DooFile| {
            doc.insert("magic".into(), f.magic.clone().into());
            doc.insert("version".into(), f.version.into());
            doc.insert("subversion".into(), f.subversion.into());
            if let Some(b) = f.skin_ids {
                doc.insert("skinIds".into(), b.into());
            }
        };
        let mut lists_merged = per_list.into_iter().map(|items| Value::Array(merge(items).into_iter().map(Value::Object).collect()));
        match kind {
            Kind::Doodads => {
                let (f, special) = heads.doodads.as_ref().expect("has doodads");
                doo(&mut doc, f);
                doc.insert("doodads".into(), lists_merged.next().expect("two lists"));
                doc.insert("specialVersion".into(), (*special).into());
                doc.insert("specials".into(), lists_merged.next().expect("two lists"));
            }
            Kind::Units => {
                doo(&mut doc, heads.units.as_ref().expect("has units"));
                doc.insert("units".into(), lists_merged.next().expect("one list"));
            }
            Kind::Regions => {
                doc.insert("version".into(), heads.regions.expect("has regions").into());
                doc.insert("regions".into(), lists_merged.next().expect("one list"));
            }
        }
        out.insert(kind, pretty(&Value::Object(doc)));
    }
    Ok(out)
}

/// Whether two flat object files hold the same (as JSON: they pack into the same bytes).
pub(crate) fn same(a: &[u8], b: &[u8]) -> bool {
    match (serde_json::from_slice::<Value>(a), serde_json::from_slice::<Value>(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub(name: &str, x: usize, y: usize, w: usize, h: usize) -> Subterrain {
        Subterrain { name: name.into(), folder: name.into(), x, y, w, h, id_range: [0, 0] }
    }

    /// Two subterrains side by side with a gap between them, on a canvas at offset (-512, -256):
    /// a covers world x -512..-256, b covers 0..512, both y -256..0.
    fn subs() -> Vec<Subterrain> {
        vec![sub("a", 0, 0, 2, 2), sub("b", 4, 0, 4, 2)]
    }
    const OFF: [f32; 2] = [-512.0, -256.0];

    #[test]
    fn ownership() {
        let s = subs();
        // Inside, and the rectangle's lower edges belong to it, its upper ones to the next.
        assert_eq!(owner(&s, OFF, -400.0, -100.0), 0);
        assert_eq!(owner(&s, OFF, -512.0, -256.0), 0);
        assert_eq!(owner(&s, OFF, 0.0, -1.0), 1);
        assert_eq!(owner(&s, OFF, 511.9, -0.1), 1);
        // Outside every rectangle: the nearest one.
        assert_eq!(owner(&s, OFF, -200.0, -100.0), 0, "in the gap, nearer a");
        assert_eq!(owner(&s, OFF, -50.0, -100.0), 1, "in the gap, nearer b");
        assert_eq!(owner(&s, OFF, 2000.0, 5000.0), 1, "far outside the canvas");
        assert_eq!(owner(&s, OFF, -9000.0, 0.0), 0);
        // A tie goes to the first in subterrains[]: the middle of the gap, and b listed first.
        assert_eq!(owner(&s, OFF, -128.0, -100.0), 0);
        let swapped = vec![s[1].clone(), s[0].clone()];
        assert_eq!(owner(&swapped, OFF, -128.0, -100.0), 0, "b first now");
        assert_eq!(owner(&swapped, OFF, -129.0, -100.0), 1);
        // Not a finite number: the first.
        assert_eq!(owner(&s, OFF, f64::NAN, f64::NAN), 0);
        assert_eq!(owner(&swapped, OFF, f64::INFINITY, 0.0), 0);
    }

    fn doo_flat(doodads: &[(u32, f64, f64)], specials: &[(u32, u32)]) -> Vec<u8> {
        let d: Vec<Value> = doodads
            .iter()
            .map(|(id, x, y)| serde_json::json!({"id": "LTlt", "variation": 0, "position": [x, y, 1.5], "angle": 0.0, "flags": 2, "life": 100, "editorId": id}))
            .collect();
        let s: Vec<Value> = specials.iter().map(|(x, y)| serde_json::json!({"id": "YTlc", "z": 0, "x": x, "y": y})).collect();
        pretty(&serde_json::json!({"format": "w3proj.doodads/1", "magic": "W3do", "version": 8, "subversion": 11, "skinIds": true, "doodads": d, "specialVersion": 0, "specials": s}))
    }

    fn round_trip(flats: &BTreeMap<Kind, Vec<u8>>, s: &[Subterrain]) -> (Heads, BTreeMap<String, Vec<u8>>) {
        let (heads, files) = slice(flats, s, OFF).unwrap();
        let back = assemble(&heads, s, &|p| files.get(p).cloned()).unwrap();
        assert_eq!(&back, flats, "split and merged, the flat files come back byte for byte");
        (heads, files)
    }

    fn entries(files: &BTreeMap<String, Vec<u8>>, path: &str, list: &str) -> Vec<Value> {
        let v: Value = serde_json::from_slice(&files[path]).unwrap();
        v[list].as_array().unwrap().clone()
    }

    #[test]
    fn objects_go_by_position_and_come_back() {
        // Doodad 7 lies in b, 3 in a, 5 in the gap nearer b; specials by tile corner.
        let flats = BTreeMap::from([(Kind::Doodads, doo_flat(&[(7, 100.0, -50.0), (3, -500.0, -250.0), (5, -60.0, 0.0)], &[(5, 0), (0, 1)]))]);
        let (heads, files) = round_trip(&flats, &subs());
        assert_eq!(heads.doodads.as_ref().unwrap().0, DooFile { magic: "W3do".into(), version: 8, subversion: 11, skin_ids: Some(true) });
        let ids = |p: &str| entries(&files, p, "doodads").iter().map(|e| e["editorId"].as_u64().unwrap()).collect::<Vec<_>>();
        assert_eq!(ids("terrain/a/doodads.json"), vec![3]);
        assert_eq!(ids("terrain/b/doodads.json"), vec![5, 7], "sorted by creation number");
        let sx = |p: &str| entries(&files, p, "specials").iter().map(|e| e["x"].as_u64().unwrap()).collect::<Vec<_>>();
        assert_eq!(sx("terrain/a/doodads.json"), vec![0]);
        assert_eq!(sx("terrain/b/doodads.json"), vec![5]);
        // The exact position and every field stay; "order" only where the flat index differs from the sorted
        // place: flat [7, 3, 5] sorted is [3, 5, 7], so all three move; specials [(5,0), (0,1)] are in y order.
        let b = entries(&files, "terrain/b/doodads.json", "doodads");
        assert_eq!(b[1], serde_json::json!({"order": 0, "id": "LTlt", "variation": 0, "position": [100.0, -50.0, 1.5], "angle": 0.0, "flags": 2, "life": 100, "editorId": 7}));
        assert_eq!(b[0]["order"], 2);
        assert!(entries(&files, "terrain/b/doodads.json", "specials").iter().all(|e| e.get("order").is_none()));
        let text = String::from_utf8(files["terrain/b/doodads.json"].clone()).unwrap();
        assert!(text.starts_with("{\n  \"doodads\": [\n    {\n      \"order\": 2,\n"), "{text}");
    }

    #[test]
    fn order_only_where_it_differs() {
        // Already sorted: no order at all.
        let flats = BTreeMap::from([(Kind::Doodads, doo_flat(&[(1, 100.0, -50.0), (2, -500.0, -250.0), (9, 10.0, -10.0)], &[]))]);
        let (_, files) = round_trip(&flats, &subs());
        assert!(files.values().all(|f| !String::from_utf8_lossy(f).contains("\"order\"")));
        // One out of place: [1, 9, 2, 3] sorted is [1, 2, 3, 9]; 1 keeps its place, the rest move.
        let flats = BTreeMap::from([(Kind::Doodads, doo_flat(&[(1, 100.0, -50.0), (9, -500.0, -250.0), (2, 10.0, -10.0), (3, 20.0, -10.0)], &[]))]);
        let (_, files) = round_trip(&flats, &subs());
        let all: Vec<Value> = ["terrain/a/doodads.json", "terrain/b/doodads.json"].iter().flat_map(|p| entries(&files, p, "doodads")).collect();
        let order = |id: u64| all.iter().find(|e| e["editorId"] == id).unwrap().get("order").cloned();
        assert_eq!(order(1), None);
        assert_eq!(order(9), Some(1.into()));
        assert_eq!(order(2), Some(2.into()));
        assert_eq!(order(3), Some(3.into()));
        // The control: without the orders, the merge gives the sorted order, not the flat file's.
        let stripped: BTreeMap<String, Vec<u8>> = files
            .iter()
            .map(|(k, v)| {
                let mut doc: Value = serde_json::from_slice(v).unwrap();
                doc["doodads"].as_array_mut().unwrap().iter_mut().for_each(|e| {
                    e.as_object_mut().unwrap().shift_remove("order");
                });
                (k.clone(), pretty(&doc))
            })
            .collect();
        let heads = slice(&flats, &subs(), OFF).unwrap().0;
        let merged = assemble(&heads, &subs(), &|p| stripped.get(p).cloned()).unwrap();
        assert_ne!(merged[&Kind::Doodads], flats[&Kind::Doodads]);
        let doc: Value = serde_json::from_slice(&merged[&Kind::Doodads]).unwrap();
        assert_eq!(doc["doodads"].as_array().unwrap().iter().map(|e| e["editorId"].as_u64().unwrap()).collect::<Vec<_>>(), vec![1, 2, 3, 9]);
    }

    /// Edits that make the orders disagree (an entry deleted, so an order points past the end) still give
    /// every entry once.
    #[test]
    fn orders_after_edits_lose_nothing() {
        let item = |order: Option<u64>, n: u32| Item { order, key: SortKey::Number(n), entry: Map::from_iter([("n".to_string(), Value::from(n))]) };
        let got = merge(vec![item(Some(7), 1), item(None, 2), item(Some(0), 3), item(Some(0), 4), item(None, 0)]);
        let ns: Vec<u64> = got.iter().map(|e| e["n"].as_u64().unwrap()).collect();
        assert_eq!(ns, vec![3, 4, 0, 2, 1]);
    }

    #[test]
    fn regions_by_their_minimum_corner() {
        let region = |index: u32, left: f64, bottom: f64, right: f64, top: f64| serde_json::json!({"left": left, "bottom": bottom, "right": right, "top": top, "name": format!("r{index}"), "index": index, "weather": "0x00000000", "sound": "", "color": {"blue": 1, "green": 2, "red": 3, "alpha": 255}});
        // r0 starts in a and reaches far into b; r1 starts in b; r2 starts left of the canvas, nearest a.
        let flat = pretty(&serde_json::json!({"format": "w3proj.regions/1", "version": 5, "regions": [region(0, -500.0, -200.0, 400.0, 0.0), region(1, 10.0, -250.0, 20.0, -240.0), region(2, -2000.0, -100.0, 300.0, -50.0)]}));
        let flats = BTreeMap::from([(Kind::Regions, flat)]);
        let (heads, files) = round_trip(&flats, &subs());
        assert_eq!(heads.regions, Some(5));
        let names = |p: &str| entries(&files, p, "regions").iter().map(|e| e["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(names("terrain/a/regions.json"), vec!["r0", "r2"]);
        assert_eq!(names("terrain/b/regions.json"), vec!["r1"]);
    }

    #[test]
    fn units_and_version_13_doodads() {
        let unit = |id: u32, x: f64| serde_json::json!({"id": "hfoo", "position": [x, -10.0, 0.0], "editorId": id});
        let units = pretty(&serde_json::json!({"format": "w3proj.units/1", "magic": "W3do", "version": 13, "subversion": 11, "units": [unit(2, 100.0), unit(4, -400.0)]}));
        // Version 13 doodads all have editorId -1; trailer[0] numbers them.
        let doodad = |n: u32, x: f64| serde_json::json!({"id": "ATtr", "position": [x, -10.0, 0.0], "editorId": u32::MAX, "trailer": [n, 0, 0]});
        let doo = pretty(&serde_json::json!({"format": "w3proj.doodads/1", "magic": "W3do", "version": 13, "subversion": 11, "doodads": [doodad(0, 100.0), doodad(1, -400.0), doodad(2, 200.0)], "specialVersion": 0, "specials": []}));
        let flats = BTreeMap::from([(Kind::Units, units), (Kind::Doodads, doo)]);
        let (heads, files) = round_trip(&flats, &subs());
        assert!(files.values().all(|f| !String::from_utf8_lossy(f).contains("\"order\"")), "trailer[0] is already in order");
        // The control: numbered by editorId (all -1), version 13 doodads would be duplicates.
        let mut v12 = flats.clone();
        let text = String::from_utf8(v12[&Kind::Doodads].clone()).unwrap().replace("\"version\": 13", "\"version\": 12");
        v12.insert(Kind::Doodads, text.into_bytes());
        assert!(slice(&v12, &subs(), OFF).unwrap_err().to_string().contains("same creation number 4294967295"));
        assert_eq!(heads.doo_header().unwrap(), DooHeader { doodads_version: 13, doodads_subversion: 11, units_version: 13, units_subversion: 11, skin_ids: false });
        assert_eq!(heads.units.as_ref().unwrap().skin_ids, None);
    }

    #[test]
    fn creation_numbers_twice_are_errors() {
        let flats = BTreeMap::from([(Kind::Doodads, doo_flat(&[(1, 100.0, -50.0), (2, -500.0, -250.0)], &[]))]);
        let (heads, files) = slice(&flats, &subs(), OFF).unwrap();
        // b's doodad renumbered to a's by hand: an error naming both files, nothing renumbered.
        let mut f = files.clone();
        let b = String::from_utf8(f["terrain/b/doodads.json"].clone()).unwrap().replace("\"editorId\": 1", "\"editorId\": 2");
        f.insert("terrain/b/doodads.json".into(), b.into_bytes());
        let e = assemble(&heads, &subs(), &|p| f.get(p).cloned()).unwrap_err().to_string();
        assert!(e.contains("creation number 2") && e.contains("map/terrain/a/doodads.json") && e.contains("map/terrain/b/doodads.json"), "{e}");
        // Twice in one file.
        let mut f = files.clone();
        let one = entries(&files, "terrain/b/doodads.json", "doodads")[0].clone();
        f.insert("terrain/b/doodads.json".into(), pretty(&serde_json::json!({"doodads": [one.clone(), one], "specials": []})));
        let e = assemble(&heads, &subs(), &|p| f.get(p).cloned()).unwrap_err().to_string();
        assert!(e.contains("map/terrain/b/doodads.json holds creation number 1 twice"), "{e}");
        // A flat file with a number twice can't be split.
        let twice = BTreeMap::from([(Kind::Doodads, doo_flat(&[(4, 100.0, -50.0), (4, -500.0, -250.0)], &[]))]);
        let e = slice(&twice, &subs(), OFF).unwrap_err().to_string();
        assert!(e.contains("doodads[0] and doodads[1] have the same creation number 4"), "{e}");
    }

    #[test]
    fn what_cant_be_kept_is_refused() {
        let ok = doo_flat(&[(1, 100.0, -50.0)], &[]);
        let text = String::from_utf8(ok).unwrap();
        for (from, to, why) in [
            ("\"format\": \"w3proj.doodads/1\"", "\"format\": \"w3proj.doodads/2\"", "format"),
            ("\"specialVersion\": 0", "\"specialVersion\": 0, \"extra\": 1", "key \"extra\""),
            ("\"editorId\": 1", "\"editorId\": -1", "creation number"),
            ("\"editorId\": 1", "\"editorId\": 1, \"order\": 3", "\"order\""),
            ("\"position\": [", "\"position\": [1.0, ", "position"),
            ("\"magic\": \"W3do\"", "\"magic\": 5", "magic"),
        ] {
            let flats = BTreeMap::from([(Kind::Doodads, text.replacen(from, to, 1).into_bytes())]);
            let e = slice(&flats, &subs(), OFF).err().unwrap_or_else(|| panic!("accepted {to}")).to_string();
            assert!(e.contains(why) && e.contains("map/war3map.doo.json"), "{e} (expected {why})");
        }
    }

    #[test]
    fn subterrain_files_are_checked() {
        let flats = BTreeMap::from([(Kind::Doodads, doo_flat(&[(1, 100.0, -50.0)], &[]))]);
        let (heads, files) = slice(&flats, &subs(), OFF).unwrap();
        for (bad, why) in [
            ("{\"doodads\": []}", "lacks \"specials\""),
            ("{\"doodads\": [], \"specials\": [], \"units\": []}", "unknown key"),
            ("{\"doodads\": [{\"order\": -1, \"editorId\": 3, \"position\": [0, 0, 0]}], \"specials\": []}", "order"),
            ("{\"doodads\": [{\"position\": [0, 0, 0]}], \"specials\": []}", "creation number"),
            ("{\"doodads\": [1], \"specials\": []}", "isn't an object"),
            ("[]", "isn't a JSON object"),
            ("{ broken", "isn't JSON"),
        ] {
            let mut f = files.clone();
            f.insert("terrain/a/doodads.json".into(), bad.as_bytes().to_vec());
            let e = assemble(&heads, &subs(), &|p| f.get(p).cloned()).err().unwrap_or_else(|| panic!("accepted {bad}")).to_string();
            assert!(e.contains(why) && e.contains("map/terrain/a/doodads.json"), "{e} (expected {why})");
        }
        let mut f = files.clone();
        f.remove("terrain/a/doodads.json");
        assert!(assemble(&heads, &subs(), &|p| f.get(p).cloned()).unwrap_err().to_string().contains("missing"));
    }

    /// A cut from inside one entry to inside the next leaves valid JSON with keys twice (found by the damaged-input
    /// rounds, seed 3530): an error, not one doodad of two. The control: plain JSON reading takes it.
    #[test]
    fn keys_twice_are_errors() {
        let cut = br#"{"doodads": [{"id": "ATtr", "editorId": 0, "position": [0, 0, 0], "editorId": 1}], "specials": []}"#;
        assert!(serde_json::from_slice::<Value>(cut).is_ok());
        assert!(strict_json(cut).unwrap_err().contains("key \"editorId\" twice"));
        let heads = Heads { doodads: Some((DooFile { magic: "W3do".into(), version: 8, subversion: 11, skin_ids: Some(true) }, 0)), ..Heads::default() };
        let e = assemble(&heads, &subs(), &|_| Some(cut.to_vec())).unwrap_err().to_string();
        assert!(e.contains("twice"), "{e}");
        // The same as serde_json otherwise, numbers included.
        let text = br#"{"a": [1, -2, 3.5, 1e300, "x", null, true, {"b": {}}], "c": 18446744073709551615}"#;
        assert_eq!(strict_json(text).unwrap(), serde_json::from_slice::<Value>(text).unwrap());
        assert!(strict_json(b"{} x").is_err());
    }

    /// terrain.json's objects with dooHeader: what they don't hold comes from dooHeader, a file's skinIds only
    /// where it differs.
    #[test]
    fn heads_in_terrain_json() {
        let file = |version: u32, skin_ids: Option<bool>| DooFile { magic: "W3do".into(), version, subversion: 11, skin_ids };
        for heads in [
            Heads { doodads: Some((file(8, Some(true)), 0)), units: Some(file(8, Some(true))), regions: Some(5) },
            Heads { doodads: Some((file(8, Some(false)), 3)), units: Some(file(8, Some(true))), regions: None },
            Heads { doodads: None, units: Some(file(13, None)), regions: Some(7) },
            Heads { doodads: Some((file(7, None), 0)), units: None, regions: None },
            Heads { doodads: Some((file(12, Some(true)), 0)), units: None, regions: None },
            Heads { doodads: None, units: None, regions: Some(5) },
        ] {
            let header = heads.doo_header();
            let json = format!("{{\n{}\"x\": 0}}", heads.to_json(header.as_ref()));
            let v: Value = serde_json::from_str(&json).unwrap_or_else(|e| panic!("{e}: {json}"));
            assert_eq!(Heads::parse(&v["objects"], header.as_ref()).unwrap(), heads, "{json}");
        }
        let v = serde_json::json!({"units": {"magic": "W3do"}});
        assert!(Heads::parse(&v, None).unwrap_err().to_string().contains("dooHeader"));
        let v = serde_json::json!({"units": {"magic": "W3do", "extra": 1}});
        assert!(Heads::parse(&v, Heads::default().doo_header().as_ref()).is_err());
    }
}
