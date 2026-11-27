//! Object data as one file per object (`map/objects/`, docs/object-folders-spec.md): the seven kinds' packed files
//! (`war3map.w3u`, `.w3t`, `.w3b`, `.w3d`, `.w3a`, `.w3h`, `.w3q`), their `war3mapSkin.*` halves, and a campaign's
//! `war3campaign*` files in its own `map/`, to and from
//!
//! ```text
//! objects/objects.json                       format, and which packed files there are with which version
//! objects/<kind>/custom|original/<name>.json one object: `id` (custom only), `base`, its `data` and `skin` halves
//! objects/<kind>/custom|original/order.txt   only where the map's order isn't the default (listed, then by id)
//! ```
//!
//! `crate::objdata` stays the binary codec; this module only lays its tables out. The packed files are pack outputs
//! (`assemble`); unpack cuts them into the folder (`split_flat`, which checks that they come back byte for byte, else
//! the kind stays raw). The app reads and writes the flat names (`map/war3map.w3u.json`, format `w3proj.objects/1`)
//! through its file layer, which answers them from the folder (`flat_view`, `read_flat`, `write_flat`).
//!
//! Paths are relative to the project's `map/` folder, with `/`, as in `crate::project::read_project`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::folder_codec::{self, Files, Folder};
use crate::objdata::{self, Id, Mod, Object, ObjectFile, Set};
use crate::{Error, Result};

pub const DIR: &str = "objects";
/// The layout's folder under `map/`.
pub const FOLDER: Folder = Folder::new(DIR);
/// The layout's root file: which packed files there are, with their versions.
pub const ROOT_FILE: &str = "objects/objects.json";
pub const FORMAT: &str = "w3proj.objectfolders/1";
const FORMAT_NAME: &str = "w3proj.objectfolders/";
const FORMAT_MAJOR: u64 = 1;
/// The codec the unpack report names for the files that went into the folder.
pub const CODEC_ID: &str = "object-folders";
pub const ORDER: &str = "order.txt";
/// The two lists of a packed file, as folders: changed standard objects, objects made in the map.
pub const TABLES: [&str; 2] = ["original", "custom"];
/// An object file's two halves: its entry in `war3map.<ext>` and in `war3mapSkin.<ext>`.
pub const HALVES: [&str; 2] = ["data", "skin"];

fn bad(m: impl Into<String>) -> Error {
    Error::Project(m.into())
}

/// One kind of object data: its folder, its file extension, whether its changes carry level and data columns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Kind {
    pub folder: &'static str,
    pub ext: &'static str,
    pub levels: bool,
}

pub const KINDS: [Kind; 7] = [
    Kind { folder: "units", ext: "w3u", levels: false },
    Kind { folder: "items", ext: "w3t", levels: false },
    Kind { folder: "destructables", ext: "w3b", levels: false },
    Kind { folder: "doodads", ext: "w3d", levels: true },
    Kind { folder: "abilities", ext: "w3a", levels: true },
    Kind { folder: "buffs", ext: "w3h", levels: false },
    Kind { folder: "upgrades", ext: "w3q", levels: true },
];

/// A map's packed files are `war3map*`, a campaign's own `war3campaign*`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prefix {
    Map,
    Campaign,
}

const CAMPAIGN_INFO: [&str; 2] = ["war3campaign.w3f", "war3campaign.w3f.json"];

impl Prefix {
    pub fn word(self) -> &'static str {
        match self {
            Prefix::Map => "war3map",
            Prefix::Campaign => "war3campaign",
        }
    }

    /// A campaign's files (relative to `map/`) have its campaign info, raw or as JSON.
    pub fn of_files(files: &Files) -> Prefix {
        if files.keys().any(|k| CAMPAIGN_INFO.iter().any(|c| k.eq_ignore_ascii_case(c))) {
            Prefix::Campaign
        } else {
            Prefix::Map
        }
    }

    /// The prefix of a project's `map/` folder (its campaign info there or not); one that can't be checked is an error.
    pub fn of_map_dir(map_dir: &Path) -> Result<Prefix> {
        for name in CAMPAIGN_INFO {
            if crate::project::there(&map_dir.join(name))? {
                return Ok(Prefix::Campaign);
            }
        }
        Ok(Prefix::Map)
    }

    /// The packed file of a kind's half (`war3mapSkin.w3u`).
    pub fn packed(self, kind: Kind, half: usize) -> String {
        format!("{}{}.{}", self.word(), if half == 1 { "Skin" } else { "" }, kind.ext)
    }

    /// The flat name the app reads a kind's half by (`war3mapSkin.w3u.json`).
    pub fn flat(self, kind: Kind, half: usize) -> String {
        format!("{}.json", self.packed(kind, half))
    }
}

/// The kind and half a flat name of `prefix` stands for (`war3mapSkin.w3u.json`, any case).
pub fn flat_name(prefix: Prefix, name: &str) -> Option<(Kind, usize)> {
    KINDS.iter().find_map(|k| (0..2).find(|&h| prefix.flat(*k, h).eq_ignore_ascii_case(name)).map(|h| (*k, h)))
}

/// What `crate::project::would_delete` compares a packed object file by: the kind's folder, for the packed files of
/// either prefix and half, so a kind kept in another form isn't taken for one lost. None for any other name.
pub fn object_key(archive_name: &str) -> Option<String> {
    for kind in KINDS {
        for prefix in [Prefix::Map, Prefix::Campaign] {
            if (0..2).any(|h| prefix.packed(kind, h).eq_ignore_ascii_case(archive_name)) {
                return Some(format!("{DIR}/{}", kind.folder));
            }
        }
    }
    None
}

/// The same for a project path of the layout (`layout_path`): `objects/<kind>` for one of a kind's files, None for the
/// root file and any other path.
pub fn layout_key(path: &str) -> Option<String> {
    let path = layout_path(path)?;
    let (folder, _) = path[DIR.len() + 1..].split_once('/')?;
    Some(format!("{DIR}/{folder}"))
}

/// The layout's path a project path is (relative to `map/`, spelt as the layout spells it): `objects/objects.json` and
/// everything below `objects/<kind>/`, the first folder in any case. The game keeps files in a folder `Objects\` too,
/// and maps import files into it (WoWR: `Objects\InventoryItems\…`): those are files of the map's own, and on a file
/// system that ignores case they share the folder with the layout, which then may be spelt `Objects/`. None for any
/// path outside the layout.
pub fn layout_path(path: &str) -> Option<String> {
    let (top, rest) = path.split_once('/')?;
    if !top.eq_ignore_ascii_case(DIR) {
        return None;
    }
    let ours = rest == "objects.json" || rest.split_once('/').is_some_and(|(first, below)| !below.is_empty() && KINDS.iter().any(|k| k.folder == first));
    ours.then(|| format!("{DIR}/{rest}"))
}

/// The layout's files among project files (relative to `map/`), under the layout's spelling (`layout_path`); those
/// packed raw (files of the map's own) left out. Two that are one file of the layout (`objects/` and `Objects/` on a
/// file system that tells cases apart) are an error.
fn layout_files(files: &Files, raw: &[String]) -> Result<Files> {
    let mut out = Files::new();
    let mut from: HashMap<String, &String> = HashMap::new();
    for (k, v) in files.iter().filter(|(k, _)| !raw.iter().any(|r| r == *k)) {
        let Some(p) = layout_path(k) else { continue };
        if let Some(other) = from.insert(p.clone(), k) {
            return Err(bad(format!("map/{other} and map/{k} are both there: they are one file of the object layout; keep one")));
        }
        out.insert(p, v.clone());
    }
    Ok(out)
}

// ---- file names ----

/// Windows' device names among four-letter ids: no file may be named so, in any case.
fn reserved(stem: &str) -> bool {
    let l = stem.to_ascii_lowercase();
    (l.starts_with("com") || l.starts_with("lpt")) && l.as_bytes()[3].is_ascii_digit()
}

/// The file name (without `.json`) of the object `id`: the id itself where it is four letters or digits, with `~` and
/// a hex digit marking its upper-case letters (8 the first, 4 the second, 2 the third, 1 the fourth: `H000~8`,
/// `AFfs~c`); `0x` and its eight hex digits for any other id, and for one all in lower case that Windows keeps for a
/// device (`com1`).
pub fn file_stem(id: Id) -> String {
    let b = id.0;
    if b.iter().all(u8::is_ascii_alphanumeric) {
        let s = std::str::from_utf8(&b).expect("ASCII");
        let mask = b.iter().fold(0u8, |m, c| (m << 1) | u8::from(c.is_ascii_uppercase()));
        if mask != 0 {
            return format!("{s}~{mask:x}");
        }
        if !reserved(s) {
            return s.to_string();
        }
    }
    let hex: String = b.iter().map(|c| format!("{c:02x}")).collect();
    format!("0x{hex}")
}

/// The id a file name (without `.json`) stands for, where it is one `file_stem` gives.
pub fn stem_id(stem: &str) -> Option<Id> {
    let b = stem.as_bytes();
    let id = if let Some(hex) = stem.strip_prefix("0x") {
        if hex.len() != 8 {
            return None;
        }
        let mut out = [0u8; 4];
        for (i, o) in out.iter_mut().enumerate() {
            *o = u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()?;
        }
        Id(out)
    } else {
        Id(b.get(..4)?.try_into().ok()?)
    };
    (file_stem(id) == stem).then_some(id)
}

// ---- the model ----

/// One half of an object file: the object's entry in one packed file without its `base` and `id`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Half {
    #[serde(default)]
    pub end: Id,
    #[serde(default)]
    pub sets: Option<Vec<Set>>,
    #[serde(default)]
    pub mods: Option<Vec<Mod>>,
}

/// One object of a kind: its id (zero in `original`), base and halves (`HALVES`).
#[derive(Debug, Clone)]
struct Obj {
    base: Id,
    id: Id,
    halves: [Option<Half>; 2],
}

impl Obj {
    /// What it is keyed by in table `t`: a standard object by its base, a custom one by its id.
    fn key(&self, t: usize) -> Id {
        if t == 0 { self.base } else { self.id }
    }
}

/// A kind's packed files as the folder holds them: their versions (none: no such file), each table's objects in pack
/// order, and each table's `order.txt` names (none: no such file).
#[derive(Debug, Clone, Default)]
struct KindData {
    versions: [Option<u32>; 2],
    tables: [Vec<Obj>; 2],
    orders: [Vec<String>; 2],
}

fn half_of(o: Object) -> (Id, Id, Half) {
    (o.base, o.id, Half { end: o.end, sets: o.sets, mods: o.mods })
}

/// An entry of a packed file from an object's half; one without changes has an empty `mods`, as the codec reads it.
fn object_of(base: Id, id: Id, h: Half) -> Object {
    let mods = if h.sets.is_none() && h.mods.is_none() { Some(Vec::new()) } else { h.mods };
    Object { base, id, end: h.end, sets: h.sets, mods }
}

impl KindData {
    /// The packed files' tables, as the codec reads them (`objdata::ObjectFile`).
    fn to_flat(&self) -> [Option<ObjectFile>; 2] {
        let mut out: [Option<ObjectFile>; 2] = [None, None];
        for (h, v) in self.versions.iter().enumerate() {
            if let Some(v) = v {
                out[h] = Some(ObjectFile { format: objdata::FORMAT.into(), version: *v, original: Vec::new(), custom: Vec::new() });
            }
        }
        for (t, objs) in self.tables.iter().enumerate() {
            for o in objs {
                for (h, half) in o.halves.iter().enumerate() {
                    if let (Some(half), Some(f)) = (half, out[h].as_mut()) {
                        let entry = object_of(o.base, o.id, half.clone());
                        if t == 0 { f.original.push(entry) } else { f.custom.push(entry) }
                    }
                }
            }
        }
        out
    }
}

/// A kind's packed files (their tables, as the codec reads them) as one object list per table. The order is one list
/// for both halves: where an object is in both, the files must agree on it. Errs on what the layout can't hold: an id
/// twice in a table, a standard object with an id or a custom one without, an object whose base differs between the
/// halves, an id both standard and custom, two orders that don't agree.
fn from_flat(kind: Kind, prefix: Prefix, files: [Option<ObjectFile>; 2]) -> std::result::Result<KindData, String> {
    let mut data = KindData::default();
    for (h, f) in files.into_iter().enumerate() {
        let Some(f) = f else { continue };
        data.versions[h] = Some(f.version);
        let name = prefix.packed(kind, h);
        for (t, list) in [f.original, f.custom].into_iter().enumerate() {
            let objs = &mut data.tables[t];
            let mut index: HashMap<[u8; 4], usize> = objs.iter().enumerate().map(|(i, o)| (o.key(t).0, i)).collect();
            let mut cursor = 0;
            for o in list {
                let (base, id, half) = half_of(o);
                if t == 0 && !id.is_zero() {
                    return Err(format!("{name} changes the standard object {base} under an id of its own ({id})"));
                }
                if t == 1 && id.is_zero() {
                    return Err(format!("{name} has a custom object made from {base} without an id"));
                }
                let key = if t == 0 { base } else { id };
                match index.get(&key.0) {
                    Some(&i) => {
                        let ob = &mut objs[i];
                        if ob.halves[h].is_some() {
                            return Err(format!("{name} lists {key} twice"));
                        }
                        if ob.base != base {
                            return Err(format!("{key} is made from {} in one packed file and from {base} in {name}", ob.base));
                        }
                        if i < cursor {
                            return Err(format!("{name} lists its {} objects in another order than {}", TABLES[t], prefix.packed(kind, 0)));
                        }
                        ob.halves[h] = Some(half);
                        cursor = i + 1;
                    }
                    None => {
                        let mut halves = [None, None];
                        halves[h] = Some(half);
                        objs.insert(cursor, Obj { base, id, halves });
                        if cursor + 1 == objs.len() {
                            index.insert(key.0, cursor);
                        } else {
                            index = objs.iter().enumerate().map(|(i, o)| (o.key(t).0, i)).collect();
                        }
                        cursor += 1;
                    }
                }
            }
        }
    }
    let standard: HashSet<[u8; 4]> = data.tables[0].iter().map(|o| o.base.0).collect();
    if let Some(o) = data.tables[1].iter().find(|o| standard.contains(&o.id.0)) {
        return Err(format!("{} is both a changed standard object and a custom one", o.id));
    }
    // order.txt: the shortest head of the order after which the rest is sorted by id (the unlisted objects come so).
    for t in 0..2 {
        let keys: Vec<[u8; 4]> = data.tables[t].iter().map(|o| o.key(t).0).collect();
        let mut k = keys.len();
        while k > 0 && (k == keys.len() || keys[k - 1] < keys[k]) {
            k -= 1;
        }
        data.orders[t] = data.tables[t][..k].iter().map(|o| file_stem(o.key(t))).collect();
    }
    Ok(data)
}

// ---- writing the files ----

/// serde_json's compact form with a space after `:` and `,`: one change per line, as the spec shows them.
struct Spaced;

impl serde_json::ser::Formatter for Spaced {
    fn begin_array_value<W: ?Sized + std::io::Write>(&mut self, w: &mut W, first: bool) -> std::io::Result<()> {
        if first { Ok(()) } else { w.write_all(b", ") }
    }
    fn begin_object_key<W: ?Sized + std::io::Write>(&mut self, w: &mut W, first: bool) -> std::io::Result<()> {
        if first { Ok(()) } else { w.write_all(b", ") }
    }
    fn begin_object_value<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
        w.write_all(b": ")
    }
}

fn json<T: Serialize + ?Sized>(v: &T) -> String {
    let mut out = Vec::new();
    v.serialize(&mut serde_json::Serializer::with_formatter(&mut out, Spaced)).expect("an id, a number or a string serializes");
    String::from_utf8(out).expect("serde_json writes UTF-8")
}

fn mods_text(mods: &[Mod], indent: &str, close: &str) -> String {
    if mods.is_empty() {
        return "[]".into();
    }
    let lines: Vec<String> = mods.iter().map(|m| format!("{indent}{}", json(m))).collect();
    format!("[\n{}\n{close}]", lines.join(",\n"))
}

fn half_text(h: &Half) -> String {
    let mut parts = Vec::new();
    if !h.end.is_zero() {
        parts.push(format!("\"end\": {}", json(&h.end)));
    }
    if let Some(sets) = &h.sets {
        if sets.is_empty() {
            parts.push("\"sets\": []".into());
        } else {
            let items: Vec<String> = sets.iter().map(|s| format!("      {{\"flag\": {}, \"mods\": {}}}", s.flag, mods_text(&s.mods, "        ", "      "))).collect();
            parts.push(format!("\"sets\": [\n{}\n    ]", items.join(",\n")));
        }
    }
    if let Some(mods) = h.mods.as_ref().filter(|m| !m.is_empty()) {
        parts.push(format!("\"mods\": {}", mods_text(mods, "      ", "    ")));
    }
    if parts.is_empty() { "{}".into() } else { format!("{{\n    {}\n  }}", parts.join(",\n    ")) }
}

/// An object file's text: `id` (custom objects), `base`, then each half there is; one change per line.
fn object_text(t: usize, o: &Obj) -> Vec<u8> {
    let mut lines = Vec::new();
    if t == 1 {
        lines.push(format!("  \"id\": {}", json(&o.id)));
    }
    lines.push(format!("  \"base\": {}", json(&o.base)));
    for (h, half) in o.halves.iter().enumerate() {
        if let Some(half) = half {
            lines.push(format!("  \"{}\": {}", HALVES[h], half_text(half)));
        }
    }
    format!("{{\n{}\n}}\n", lines.join(",\n")).into_bytes()
}

fn order_text(names: &[String]) -> Vec<u8> {
    let mut s = names.join("\n");
    s.push('\n');
    s.into_bytes()
}

/// The folder of a kind's table, relative to `map/`.
fn table_dir(kind: Kind, t: usize) -> String {
    format!("{DIR}/{}/{}", kind.folder, TABLES[t])
}

/// A kind's files (object files and `order.txt`) into `out`.
fn kind_files(kind: Kind, data: &KindData, out: &mut Files) {
    for t in 0..2 {
        let dir = table_dir(kind, t);
        for o in &data.tables[t] {
            out.insert(format!("{dir}/{}.json", file_stem(o.key(t))), object_text(t, o));
        }
        if !data.orders[t].is_empty() {
            out.insert(format!("{dir}/{ORDER}"), order_text(&data.orders[t]));
        }
    }
}

/// Each kind's packed files' versions (`data`, `skin`), in `KINDS` order: `objects.json`.
type Versions = [[Option<u32>; 2]; 7];

fn root_text(v: &Versions) -> Vec<u8> {
    let entries: Vec<String> = KINDS
        .iter()
        .zip(v)
        .filter(|(_, v)| v.iter().any(Option::is_some))
        .map(|(k, v)| {
            let halves: Vec<String> = (0..2).filter_map(|h| v[h].map(|n| format!("\"{}\": {n}", HALVES[h]))).collect();
            format!("    \"{}\": {{{}}}", k.folder, halves.join(", "))
        })
        .collect();
    let files = if entries.is_empty() { "{}".to_string() } else { format!("{{\n{}\n  }}", entries.join(",\n")) };
    format!("{{\n  \"format\": \"{FORMAT}\",\n  \"files\": {files}\n}}\n").into_bytes()
}

// ---- reading the files ----

/// Whether a file holds Git's conflict markers (a line that is one, or starts one and a space).
fn has_conflict_markers(bytes: &[u8]) -> bool {
    bytes.split(|&b| b == b'\n').any(|l| {
        let l = l.strip_suffix(b"\r").unwrap_or(l);
        l == b"=======" || [&b"<<<<<<<"[..], b">>>>>>>", b"|||||||"].iter().any(|m| l == *m || (l.starts_with(m) && l.get(7) == Some(&b' ')))
    })
}

fn conflict(path: &str) -> Error {
    bad(format!("map/{path} has merge conflict markers: resolve the conflict first"))
}

fn not_part(path: &str) -> Error {
    bad(format!(
        "map/{path} isn't part of the object layout (map/{DIR}/ holds objects.json and <kind>/original|custom/ with one <id>.json per object and an order.txt; kinds: {})",
        KINDS.iter().map(|k| k.folder).collect::<Vec<_>>().join(", ")
    ))
}

/// `objects.json`: each kind's packed files' versions. A newer major format is refused, never half read.
fn parse_root(bytes: &[u8]) -> Result<Versions> {
    let at = format!("map/{ROOT_FILE}");
    if has_conflict_markers(bytes) {
        return Err(conflict(ROOT_FILE));
    }
    let v: Value = serde_json::from_slice(bytes).map_err(|e| bad(format!("{at} can't be read: {e}")))?;
    let format = v.get("format").and_then(Value::as_str).ok_or_else(|| bad(format!("{at} has no \"format\"")))?;
    let major = format
        .strip_prefix(FORMAT_NAME)
        .and_then(|rest| rest.split('.').next())
        .and_then(|m| m.parse::<u64>().ok())
        .filter(|m| *m >= 1)
        .ok_or_else(|| bad(format!("{at}: \"format\" is {format:?}, not {FORMAT}")))?;
    if major > FORMAT_MAJOR {
        return Err(bad(format!("{at} is in format {format}, newer than this version of W3Proj Studio reads ({FORMAT}): update W3Proj Studio")));
    }
    let mut out: Versions = Default::default();
    let Some(files) = v.get("files") else { return Ok(out) };
    let files = files.as_object().ok_or_else(|| bad(format!("{at}: \"files\" isn't an object")))?;
    for (k, val) in files {
        let i = KINDS.iter().position(|kind| kind.folder == k).ok_or_else(|| {
            bad(format!("{at} lists {k:?}, which is no kind of object data ({})", KINDS.iter().map(|k| k.folder).collect::<Vec<_>>().join(", ")))
        })?;
        let val = val.as_object().ok_or_else(|| bad(format!("{at}: \"{k}\" isn't an object")))?;
        for h in 0..2 {
            if let Some(x) = val.get(HALVES[h]) {
                let n = x.as_u64().filter(|n| (1..=3).contains(n)).ok_or_else(|| bad(format!("{at}: {k}'s \"{}\" is {x}, not a version from 1 to 3", HALVES[h])))?;
                out[i][h] = Some(n as u32);
            }
        }
    }
    Ok(out)
}

/// One object file (`path`, in table `t` of `kind`): its name (without `.json`) and the object. Errs, naming the file,
/// on conflict markers, what isn't an object file, an `id` in `original/` or none in `custom/`, a name that doesn't fit
/// the id, a half for a packed file `objects.json` doesn't list.
fn parse_object(path: &str, bytes: &[u8], t: usize, kind: Kind, prefix: Prefix, versions: [Option<u32>; 2]) -> Result<(String, Obj)> {
    let at = format!("map/{path}");
    if has_conflict_markers(bytes) {
        return Err(conflict(path));
    }
    let v: Value = serde_json::from_slice(bytes).map_err(|e| bad(format!("{at} can't be read: {e}")))?;
    let Value::Object(mut m) = v else { return Err(bad(format!("{at} isn't a JSON object"))) };
    let id_of = |m: &mut Map<String, Value>, key: &str| -> Result<Option<Id>> {
        match m.remove(key) {
            None => Ok(None),
            Some(v) => serde_json::from_value::<Id>(v).map(Some).map_err(|e| bad(format!("{at}: \"{key}\": {e}"))),
        }
    };
    let base = id_of(&mut m, "base")?.ok_or_else(|| bad(format!("{at} has no \"base\"")))?;
    let id = id_of(&mut m, "id")?.unwrap_or_default();
    if t == 0 && !id.is_zero() {
        return Err(bad(format!(
            "{at} has an \"id\" ({id}): an object in original/ is a changed standard object and has none (custom/ holds the objects made in the map)"
        )));
    }
    if t == 1 && id.is_zero() {
        return Err(bad(format!("{at} has no \"id\": an object in custom/ needs one (original/ holds the changed standard objects)")));
    }
    let key = if t == 0 { base } else { id };
    let name = path.rsplit('/').next().unwrap_or(path);
    let stem = name.strip_suffix(".json").unwrap_or(name);
    let want = file_stem(key);
    if stem != want {
        return Err(bad(format!("{at} holds {key}, whose file is named {want}.json: rename it (the id inside the file is what counts)")));
    }
    let mut halves = [None, None];
    for h in 0..2 {
        if let Some(v) = m.remove(HALVES[h]) {
            if versions[h].is_none() {
                return Err(bad(format!(
                    "{at} has a \"{}\" half, but map/{ROOT_FILE} lists no {} for {}: its changes wouldn't be packed",
                    HALVES[h],
                    prefix.packed(kind, h),
                    kind.folder
                )));
            }
            halves[h] = Some(serde_json::from_value::<Half>(v).map_err(|e| bad(format!("{at}: \"{}\": {e}", HALVES[h])))?);
        }
    }
    Ok((want, Obj { base, id, halves }))
}

/// The names `order.txt` lists that `present` has, in its order, each once; what it lists twice or without a file
/// into `warnings` (`at`: the file, for them).
fn listed_names(at: &str, bytes: &[u8], present: &dyn Fn(&str) -> bool, warnings: &mut Vec<String>) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for line in text.lines() {
        let name = line.trim();
        if name.is_empty() {
            continue;
        }
        if !seen.insert(name.to_string()) {
            warnings.push(format!("{at} lists {name} twice (the first one counts)"));
        } else if present(name) {
            out.push(name.to_string());
        } else {
            warnings.push(format!("{at} lists {name}, which has no file there (left out)"));
        }
    }
    out
}

/// The files whose paths start with `head`.
fn below<'a>(files: &'a Files, head: &'a str) -> impl Iterator<Item = (&'a String, &'a Vec<u8>)> + 'a {
    use std::ops::Bound;
    files.range::<str, _>((Bound::Included(head), Bound::Unbounded)).take_while(move |(k, _)| k.starts_with(head))
}

/// A kind's objects from the layout's files (`files`: any project files; those of the kind are read): each table in
/// pack order (the names `order.txt` lists, then the others by id). What a pack only warns about (an object with neither
/// half, `order.txt` naming a file twice or one that isn't there) into `warnings`.
fn parse_kind(kind: Kind, prefix: Prefix, versions: [Option<u32>; 2], files: &Files, warnings: &mut Vec<String>) -> Result<KindData> {
    let head = format!("{DIR}/{}/", kind.folder);
    let mut objs: [Vec<(String, Obj)>; 2] = Default::default();
    let mut orders: [Option<&Vec<u8>>; 2] = [None, None];
    for (path, bytes) in below(files, &head) {
        let rest = &path[head.len()..];
        let Some((table, name)) = rest.split_once('/') else { return Err(not_part(path)) };
        let Some(t) = TABLES.iter().position(|x| *x == table) else { return Err(not_part(path)) };
        if name.contains('/') {
            return Err(not_part(path));
        }
        if name == ORDER {
            if has_conflict_markers(bytes) {
                return Err(conflict(path));
            }
            orders[t] = Some(bytes);
        } else if name.len() > 5 && name.ends_with(".json") {
            let (stem, o) = parse_object(path, bytes, t, kind, prefix, versions)?;
            if o.halves.iter().all(Option::is_none) {
                warnings.push(format!("map/{path} has neither a \"data\" nor a \"skin\" half: nothing of it is packed"));
            }
            objs[t].push((stem, o));
        } else {
            return Err(not_part(path));
        }
    }
    let mut data = KindData { versions, ..KindData::default() };
    for (t, list) in objs.into_iter().enumerate() {
        let mut by_name: HashMap<String, Obj> = list.into_iter().collect();
        let mut ordered = Vec::with_capacity(by_name.len());
        if let Some(bytes) = orders[t] {
            let at = format!("map/{head}{}/{ORDER}", TABLES[t]);
            let listed = listed_names(&at, bytes, &|n| by_name.contains_key(n), warnings);
            for name in &listed {
                ordered.push(by_name.remove(name).expect("listed names have files"));
            }
            data.orders[t] = listed;
        }
        let mut rest: Vec<Obj> = by_name.into_values().collect();
        rest.sort_by_key(|o| o.key(t).0);
        ordered.extend(rest);
        data.tables[t] = ordered;
    }
    Ok(data)
}

/// Encodes a kind's packed files; a value the codec refuses names the object's file.
fn encode_kind(kind: Kind, prefix: Prefix, data: &KindData) -> Result<[Option<Vec<u8>>; 2]> {
    let mut out = [None, None];
    for (h, f) in data.to_flat().into_iter().enumerate() {
        let Some(f) = f else { continue };
        out[h] = Some(objdata::encode(&f, kind.levels).map_err(|e| {
            for (t, objs) in data.tables.iter().enumerate() {
                for o in objs.iter().filter(|o| o.halves[h].is_some()) {
                    let one = KindData { versions: data.versions, tables: if t == 0 { [vec![o.clone()], vec![]] } else { [vec![], vec![o.clone()]] }, orders: Default::default() };
                    if let Some(Some(f)) = one.to_flat().into_iter().nth(h) {
                        if let Err(e) = objdata::encode(&f, kind.levels) {
                            return bad(format!("map/{}/{}.json: \"{}\": {e}", table_dir(kind, t), file_stem(o.key(t)), HALVES[h]));
                        }
                    }
                }
            }
            bad(format!("{}: {e}", prefix.packed(kind, h)))
        })?);
    }
    Ok(out)
}

// ---- unpack and pack ----

/// What `split_flat` made of a map's object data.
#[derive(Debug, Default)]
pub struct Split {
    /// The layout's files (relative to `map/`), `objects.json` among them; none when no kind went into it.
    pub layout: Files,
    /// The flat files (`war3map.w3u.json`, …) that went into the layout.
    pub taken: Vec<String>,
    /// The kinds that stay as they are (raw), and why.
    pub kept: Vec<(Kind, String)>,
}

/// A map's object data, as the codec unpacked it among `files` (relative to `map/`: `war3map.w3u.json` and
/// `war3mapSkin.w3u.json` of `prefix`, spelt so), cut into the layout. Each kind's files have to come back byte for
/// byte from it; a kind that doesn't, that has a half the codec couldn't read (kept raw), or anything the layout can't
/// hold, is kept (with why). Nothing goes into the layout when the map has a file of its own where the layout keeps
/// its files (`layout_path`; its other files under `Objects\` are imports, as any).
pub fn split_flat(files: &Files, prefix: Prefix) -> Split {
    let mut out = Split::default();
    let mut versions: Versions = Default::default();
    let own = files.keys().find(|k| layout_path(k).is_some()).cloned();
    for (i, kind) in KINDS.iter().enumerate() {
        let names = [prefix.packed(*kind, 0), prefix.packed(*kind, 1)];
        let flat_keys = [format!("{}.json", names[0]), format!("{}.json", names[1])];
        let flat = [files.get(&flat_keys[0]), files.get(&flat_keys[1])];
        let raw: Vec<&String> = names.iter().filter(|n| files.contains_key(*n)).collect();
        if flat.iter().all(Option::is_none) && raw.is_empty() {
            continue;
        }
        let result = (|| -> std::result::Result<(Files, [Option<u32>; 2]), String> {
            if let Some(own) = &own {
                return Err(format!("the map has a file of its own where the object layout keeps its files ({own})"));
            }
            if let Some(r) = raw.first() {
                return Err(format!("{r} couldn't be read, so both of {}'s packed files stay raw", kind.folder));
            }
            let mut parsed = [None, None];
            let mut bins = [None, None];
            for h in 0..2 {
                if let Some(b) = flat[h] {
                    let f: ObjectFile = serde_json::from_slice(b).map_err(|e| format!("{}: {e}", flat_keys[h]))?;
                    bins[h] = Some(objdata::encode(&f, kind.levels).map_err(|e| format!("{}: {e}", names[h]))?);
                    parsed[h] = Some(f);
                }
            }
            let data = from_flat(*kind, prefix, parsed)?;
            let mut layout = Files::new();
            kind_files(*kind, &data, &mut layout);
            let back = parse_kind(*kind, prefix, data.versions, &layout, &mut Vec::new()).map_err(|e| e.to_string())?;
            let again = encode_kind(*kind, prefix, &back).map_err(|e| e.to_string())?;
            for h in 0..2 {
                if again[h] != bins[h] {
                    return Err(format!("{} doesn't come back byte for byte from map/{DIR}/", names[h]));
                }
            }
            Ok((layout, data.versions))
        })();
        match result {
            Ok((layout, v)) => {
                out.layout.extend(layout);
                versions[i] = v;
                out.taken.extend((0..2).filter(|h| flat[*h].is_some()).map(|h| flat_keys[h].clone()));
            }
            Err(why) => out.kept.push((*kind, why)),
        }
    }
    if !out.taken.is_empty() {
        out.layout.insert(ROOT_FILE.into(), root_text(&versions));
    }
    out
}

/// Whether project files (relative to `map/`) hold the layout: `objects/objects.json` (`layout_path`), unless packed
/// raw (a file of the map's own by that name).
pub fn is_layout(files: &Files, raw: &[String]) -> bool {
    files.keys().any(|k| layout_path(k).as_deref() == Some(ROOT_FILE) && !raw.iter().any(|r| r == k))
}

/// Whether a project path is one the layout keeps (`layout_path`), so packing takes it into the packed object files
/// instead of the map: false for a path packed raw.
pub fn is_layout_file(path: &str, raw: &[String]) -> bool {
    layout_path(path).is_some() && !raw.iter().any(|r| r == path)
}

/// Errs when project files have files of the layout but no `objects.json` (not packed raw): they would go into the map
/// as files of their own, and its object data would be missing.
pub fn check_root(files: &Files, raw: &[String]) -> Result<()> {
    if is_layout(files, raw) {
        return Ok(());
    }
    match files.keys().find(|p| is_layout_file(p, raw)) {
        Some(p) => Err(bad(format!("map/{p} is an object file, but map/{ROOT_FILE} is missing: without it the objects can't be packed"))),
        None => Ok(()),
    }
}

/// The packed object files (archive name, bytes) the layout among `files` (relative to `map/`, `layout_path`) makes, in
/// the prefix of the map or campaign. Every file where the layout keeps its files (but those in `raw`) must be the
/// layout's; a file that can't be read, holds conflict markers, or whose name or folder doesn't fit its id is an error
/// naming it. What a pack only warns about goes into `warnings`.
pub fn assemble(files: &Files, raw: &[String], prefix: Prefix, warnings: &mut Vec<String>) -> Result<Vec<(String, Vec<u8>)>> {
    let files = layout_files(files, raw)?;
    let root =parse_root(files.get(ROOT_FILE).ok_or_else(|| bad(format!("map/{ROOT_FILE} is missing")))?)?;
    let mut out = Vec::new();
    for (i, kind) in KINDS.iter().enumerate() {
        let data = parse_kind(*kind, prefix, root[i], &files, warnings)?;
        for (h, bytes) in encode_kind(*kind, prefix, &data)?.into_iter().enumerate() {
            if let Some(bytes) = bytes {
                out.push((prefix.packed(*kind, h), bytes));
            }
        }
    }
    Ok(out)
}

/// For a sync into a project that keeps its objects in the layout: an `order.txt` on disk that gives the map's order as
/// well as the new one (its names without a file left out) stays as it is, so a sync only rewrites it when the order
/// changed. One that can't be read stops the sync.
pub fn prepare_sync(map_dir: &Path, files: &mut Files) -> Result<()> {
    if !files.contains_key(ROOT_FILE) {
        return Ok(());
    }
    for kind in KINDS {
        for t in 0..2 {
            let dir = table_dir(kind, t);
            let key = format!("{dir}/{ORDER}");
            let on_disk = match std::fs::read(crate::paths::join_rel(map_dir, &key)) {
                Ok(b) => b,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(bad(format!("map/{key} can't be read: {e}"))),
            };
            let head = format!("{dir}/");
            let names: HashSet<String> = below(files, &head)
                .filter_map(|(k, _)| k[head.len()..].strip_suffix(".json").map(str::to_string))
                .collect();
            let present = |n: &str| names.contains(n);
            let order_of = |listed: &[String]| -> Vec<String> {
                let mut rest: Vec<&String> = names.iter().filter(|n| !listed.contains(n)).collect();
                rest.sort_by_key(|n| stem_id(n).map(|id| id.0));
                listed.iter().cloned().chain(rest.into_iter().cloned()).collect()
            };
            let incoming = files.get(&key).map(|b| listed_names("", b, &present, &mut Vec::new())).unwrap_or_default();
            let kept = listed_names("", &on_disk, &present, &mut Vec::new());
            if order_of(&kept) == order_of(&incoming) {
                if kept.is_empty() {
                    files.remove(&key);
                } else {
                    files.insert(key, order_text(&kept));
                }
            }
        }
    }
    Ok(())
}

// ---- the flat files the layout stands for (the app's file layer) ----

/// Whether the flat file `name` of a project's `map/` folder is answered from `map/objects/`, and which kind and half
/// it is. Not when `map_dir` isn't a project's `map/` folder, the name isn't one of its prefix, the file is on disk
/// (a file of its own: a project of the flat layout), the kind is kept raw, or the project has flat object files and
/// no `objects.json` (the flat layout, converted by its next sync). A path that can't be checked is an error.
pub fn flat_view(map_dir: &Path, name: &str) -> Result<Option<(Kind, usize)>> {
    if !map_dir.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(crate::project::MAP_DIR)) {
        return Ok(None);
    }
    let Some(project) = map_dir.parent() else { return Ok(None) };
    // A cheap test first: most file reads are of other names.
    if flat_name(Prefix::Map, name).is_none() && flat_name(Prefix::Campaign, name).is_none() {
        return Ok(None);
    }
    if !crate::project::there(&project.join(crate::project::MANIFEST))? {
        return Ok(None);
    }
    let prefix = Prefix::of_map_dir(map_dir)?;
    let Some((kind, half)) = flat_name(prefix, name) else { return Ok(None) };
    let there = |n: &str| crate::project::there(&map_dir.join(n));
    if there(name)? || there(&prefix.packed(kind, 0))? || there(&prefix.packed(kind, 1))? {
        return Ok(None);
    }
    if there(ROOT_FILE)? {
        return Ok(Some((kind, half)));
    }
    for k in KINDS {
        for h in 0..2 {
            if there(&prefix.flat(k, h))? {
                return Ok(None);
            }
        }
    }
    Ok(Some((kind, half)))
}

/// The project's `objects.json` on disk; None when it isn't there. One that can't be read is an error.
fn read_root(map_dir: &Path) -> Result<Option<Versions>> {
    Ok(read_root_bytes(map_dir)?.map(|(v, _)| v))
}

/// `read_root`, with the file's bytes.
fn read_root_bytes(map_dir: &Path) -> Result<Option<(Versions, Vec<u8>)>> {
    match std::fs::read(crate::paths::join_rel(map_dir, ROOT_FILE)) {
        Ok(b) => Ok(Some((parse_root(&b)?, b))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(bad(format!("map/{ROOT_FILE} can't be read: {e}"))),
    }
}

/// A fingerprint of a kind's files as they are (`objects.json` and the kind's folder: names and bytes).
fn fingerprint(root: &[u8], files: &Files) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    root.hash(&mut h);
    files.hash(&mut h);
    h.finish()
}

/// What the app last wrote of each flat file of one project's `map/` folder (the kind's index in `KINDS` and the half →
/// the fingerprint of the kind's files the write left, and the bytes written). While the files are as that write left
/// them, a read gives back those bytes: the folder holds the same objects, but not their order where the app put a new
/// one elsewhere than the folder would (unlisted objects come by id), so without it a read after a save would differ
/// from what was saved (an MCP undo would take that for a change since). Only the latest `map/` folder is kept.
type LastWritten = HashMap<(usize, usize), (u64, Vec<u8>)>;
static LAST_WRITTEN: std::sync::Mutex<Option<(std::path::PathBuf, LastWritten)>> = std::sync::Mutex::new(None);

/// What the app last wrote of a flat file, if the kind's files are still as that write left them (`LAST_WRITTEN`).
fn last_written(map_dir: &Path, key: (usize, usize), print: u64) -> Option<Vec<u8>> {
    let last = LAST_WRITTEN.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, entries) = last.as_ref()?;
    let (p, bytes) = entries.get(&key)?;
    (dir == map_dir && *p == print).then(|| bytes.clone())
}

/// Notes a change of a kind's files from fingerprint `old` to `new`: the half written (`wrote`: its bytes, None for a
/// delete) has them now, the other half's note stays good where it was good before (its content didn't change).
fn note_written(map_dir: &Path, kind: usize, half: usize, wrote: Option<&[u8]>, old: u64, new: u64) {
    let mut last = LAST_WRITTEN.lock().unwrap_or_else(|e| e.into_inner());
    if last.as_ref().is_none_or(|(dir, _)| dir != map_dir) {
        *last = Some((map_dir.to_path_buf(), HashMap::new()));
    }
    let entries = &mut last.as_mut().expect("set above").1;
    match wrote {
        Some(b) => {
            entries.insert((kind, half), (new, b.to_vec()));
        }
        None => {
            entries.remove(&(kind, half));
        }
    }
    let other = (kind, 1 - half);
    match entries.get_mut(&other) {
        Some(e) if e.0 == old => e.0 = new,
        Some(_) => {
            entries.remove(&other);
        }
        None => {}
    }
}

/// The packed files the project's `objects.json` lists (kind, half); none without one.
pub fn listed(map_dir: &Path) -> Result<Vec<(Kind, usize)>> {
    let Some(root) = read_root(map_dir)? else { return Ok(Vec::new()) };
    Ok(KINDS.iter().zip(root).flat_map(|(k, v)| (0..2).filter(move |h| v[*h].is_some()).map(move |h| (*k, h))).collect())
}

/// The files (relative to `map/`) a kind's flat files are made from: `objects.json` and every file under its folder.
pub fn sources(map_dir: &Path, kind: Kind) -> Result<Vec<String>> {
    let mut out = vec![ROOT_FILE.to_string()];
    out.extend(crate::project::walk(&map_dir.join(DIR).join(kind.folder))?.into_iter().map(|rel| format!("{DIR}/{}/{rel}", kind.folder)));
    Ok(out)
}

/// A kind's files on disk (relative to `map/`), read; many at once, in parallel. One that can't be read is an error.
fn read_kind_disk(map_dir: &Path, kind: Kind) -> Result<Files> {
    let paths: Vec<String> = sources(map_dir, kind)?.into_iter().skip(1).collect();
    read_parallel(map_dir, &paths)
}

/// The files `paths` (relative to `map_dir`), read on a few threads when there are many.
fn read_parallel(map_dir: &Path, paths: &[String]) -> Result<Files> {
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    if paths.len() < 64 || threads < 2 {
        return paths.iter().map(|p| Ok((p.clone(), folder_codec::read(map_dir, p)?))).collect();
    }
    let chunk = paths.len().div_ceil(threads);
    std::thread::scope(|s| {
        let jobs: Vec<_> = paths.chunks(chunk).map(|part| s.spawn(move || part.iter().map(|p| Ok((p.clone(), folder_codec::read(map_dir, p)?))).collect::<Result<Vec<_>>>())).collect();
        let mut out = Files::new();
        for j in jobs {
            out.extend(j.join().map_err(|_| bad("a thread reading map/objects/ failed"))??);
        }
        Ok(out)
    })
}

/// The flat file of a kind's half as the codec writes it (`objdata::to_json`'s form).
fn flat_text(f: &ObjectFile) -> Result<Vec<u8>> {
    let mut out = serde_json::to_vec_pretty(f).map_err(|e| Error::Format(e.to_string()))?;
    out.push(b'\n');
    Ok(out)
}

/// The flat file of a kind's half (`war3map.w3u.json`'s content, format `w3proj.objects/1`), assembled from the
/// project's `map/objects/`; None when `objects.json` doesn't list that packed file. Anything the folder has wrong is an
/// error naming the file, never an empty table.
pub fn read_flat(map_dir: &Path, kind: Kind, half: usize) -> Result<Option<Vec<u8>>> {
    let Some((root, root_bytes)) = read_root_bytes(map_dir)? else { return Ok(None) };
    let i = KINDS.iter().position(|k| *k == kind).expect("one of KINDS");
    if root[i][half].is_none() {
        return Ok(None);
    }
    let prefix = Prefix::of_map_dir(map_dir)?;
    let files = read_kind_disk(map_dir, kind)?;
    // Read as the app wrote it last, while the files are as that write left them (`LAST_WRITTEN`).
    if let Some(bytes) = last_written(map_dir, (i, half), fingerprint(&root_bytes, &files)) {
        return Ok(Some(bytes));
    }
    let data = parse_kind(kind, prefix, root[i], &files, &mut Vec::new())?;
    match data.to_flat().into_iter().nth(half).flatten() {
        Some(f) => flat_text(&f).map(Some),
        None => Ok(None),
    }
}

/// The files (relative to `map/`) a write of a flat file wrote and removed.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct Written {
    pub written: Vec<String>,
    pub removed: Vec<String>,
}

/// One write of a project's object folder at a time: each reads what the one before left, so none puts back what
/// another just wrote (the two halves of a kind share their files).
static WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Writes the flat file of a kind's half (`bytes`: `war3map.w3u.json`'s content) into the project's `map/objects/`:
/// each object's half becomes what the flat file has, the other half stays; an object left with neither goes, and its
/// line in `order.txt` with it. A new object isn't listed in `order.txt`. `objects.json` lists the file (with its
/// version). Only files whose bytes change are written. Nothing is written when the content can't be packed or kept in
/// the layout (an id twice, a base other than the other half's), or the folder as it is can't be read.
pub fn write_flat(map_dir: &Path, kind: Kind, half: usize, bytes: &[u8]) -> Result<Written> {
    let new: ObjectFile = serde_json::from_slice(bytes).map_err(|e| bad(format!("invalid JSON: {e}")))?;
    if !(1..=3).contains(&new.version) {
        return Err(bad(format!("object data version {} isn't one from 1 to 3", new.version)));
    }
    objdata::encode(&new, kind.levels)?;
    let _one = WRITES.lock().unwrap_or_else(|e| e.into_inner());
    change(map_dir, kind, half, Some(bytes), |data, prefix| {
        data.versions[half] = Some(new.version);
        let name = prefix.flat(kind, half);
        for (t, list) in [new.original, new.custom].into_iter().enumerate() {
            let objs = &mut data.tables[t];
            for o in objs.iter_mut() {
                o.halves[half] = None;
            }
            let mut index: HashMap<[u8; 4], usize> = objs.iter().enumerate().map(|(i, o)| (o.key(t).0, i)).collect();
            let mut seen = HashSet::new();
            for o in list {
                let (base, id, h) = half_of(o);
                if t == 0 && !id.is_zero() {
                    return Err(bad(format!("{name}: the standard object {base} has an id of its own ({id})")));
                }
                if t == 1 && id.is_zero() {
                    return Err(bad(format!("{name}: a custom object made from {base} has no id")));
                }
                let key = if t == 0 { base } else { id };
                if !seen.insert(key.0) {
                    return Err(bad(format!("{name} lists {key} twice in \"{}\"", TABLES[t])));
                }
                match index.get(&key.0) {
                    Some(&i) => {
                        let ob = &mut objs[i];
                        if ob.halves[1 - half].is_some() && ob.base != base {
                            return Err(bad(format!(
                                "{name}: {key} is made from {base}, but its {} half from {} (map/{}/{}.json has one base)",
                                HALVES[1 - half],
                                ob.base,
                                table_dir(kind, t),
                                file_stem(key)
                            )));
                        }
                        ob.base = base;
                        ob.halves[half] = Some(h);
                    }
                    None => {
                        let mut halves = [None, None];
                        halves[half] = Some(h);
                        index.insert(key.0, objs.len());
                        objs.push(Obj { base, id, halves });
                    }
                }
            }
        }
        Ok(())
    })
}

/// Takes the packed file of a kind's half out of the project's `map/objects/` (the flat file deleted): every object's
/// half goes (an object left with neither, with its file), and `objects.json` no longer lists it.
pub fn delete_flat(map_dir: &Path, kind: Kind, half: usize) -> Result<Written> {
    let _one = WRITES.lock().unwrap_or_else(|e| e.into_inner());
    change(map_dir, kind, half, None, |data, _| {
        data.versions[half] = None;
        for objs in &mut data.tables {
            for o in objs.iter_mut() {
                o.halves[half] = None;
            }
        }
        Ok(())
    })
}

/// Reads a kind from disk, lets `edit` change it, and writes back what changed: objects with neither half go (and
/// their `order.txt` lines), `objects.json` is written when its versions changed. `half` and `wrote`: the flat file the
/// change is a write (its bytes) or a delete (None) of, for `LAST_WRITTEN`. The caller holds `WRITES`.
fn change(map_dir: &Path, kind: Kind, half: usize, wrote: Option<&[u8]>, edit: impl FnOnce(&mut KindData, Prefix) -> Result<()>) -> Result<Written> {
    let prefix = Prefix::of_map_dir(map_dir)?;
    let old = read_root_bytes(map_dir)?;
    let old_root = old.as_ref().map(|(v, _)| *v);
    let old_root_bytes = old.map(|(_, b)| b).unwrap_or_default();
    let mut root = old_root.unwrap_or_default();
    let i = KINDS.iter().position(|k| *k == kind).expect("one of KINDS");
    let old_files = read_kind_disk(map_dir, kind)?;
    let mut data = parse_kind(kind, prefix, root[i], &old_files, &mut Vec::new())?;
    // What each file held, in the writer's form: a file whose object (or order) the edit leaves as it was stays as it
    // is on disk, also when written by hand in another form.
    let mut before = Files::new();
    kind_files(kind, &data, &mut before);
    edit(&mut data, prefix)?;
    for (t, objs) in data.tables.iter_mut().enumerate() {
        objs.retain(|o| o.halves.iter().any(Option::is_some));
        let names: HashSet<String> = objs.iter().map(|o| file_stem(o.key(t))).collect();
        data.orders[t].retain(|n| names.contains(n));
    }
    root[i] = data.versions;
    let mut files = Files::new();
    kind_files(kind, &data, &mut files);
    let unchanged: HashSet<String> = files.iter().filter(|(p, b)| before.get(*p) == Some(*b) && old_files.contains_key(*p)).map(|(p, _)| p.clone()).collect();
    if old_root != Some(root) {
        files.insert(ROOT_FILE.to_string(), root_text(&root));
    }
    let to_write: Files = files.iter().filter(|(p, _)| !unchanged.contains(*p)).map(|(p, b)| (p.clone(), b.clone())).collect();
    let written = folder_codec::write_changed(map_dir, &to_write)?;
    let mut removed = Vec::new();
    for p in old_files.keys().filter(|p| !files.contains_key(*p)) {
        folder_codec::remove_if_there(&crate::paths::join_rel(map_dir, p))?;
        FOLDER.prune_above(map_dir, p);
        removed.push(p.clone());
    }
    // The kind's files as this change left them: those it kept as they were on disk, the others as written.
    let new_root_bytes = files.remove(ROOT_FILE).unwrap_or(old_root_bytes.clone());
    let now: Files = files.into_iter().map(|(p, b)| if unchanged.contains(&p) { let kept = old_files[&p].clone(); (p, kept) } else { (p, b) }).collect();
    note_written(map_dir, i, half, wrote, fingerprint(&old_root_bytes, &old_files), fingerprint(&new_root_bytes, &now));
    Ok(Written { written, removed })
}

#[cfg(test)]
mod tests;
