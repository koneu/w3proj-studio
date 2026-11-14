//! Data-driven binary formats.
//!
//! A *format definition* (JSON, `//` comments allowed) describes a Blizzard
//! file layout: fields, types, counts, version conditions, plausibility
//! checks and *variants* — places where the layout is ambiguous (e.g. a field
//! only some editor builds write) and the engine must try the alternatives.
//! The engine turns bytes into JSON and back from such a definition, so a
//! format change in a game patch is fixed by editing a definition, not code.
//!
//! Built-in definitions are compiled into the binary (`formats/*.json`).
//! Definitions in override folders (a project's `.w3proj/formats`, the app's
//! user `formats` folder) replace built-ins with the same `name`.
//!
//! Node reference (one JSON object per field):
//!
//! | key       | meaning |
//! |-----------|---------|
//! | `name`    | key in the parent object (required inside structs) |
//! | `type`    | `u8 u16 u32 i32 f32 cstring char id rgba bytes struct list variant` |
//! | `fields`  | children of a `struct` |
//! | `item`    | element node of a `list` |
//! | `count`   | makes the node a list: a number, `"u32"` (count stored before the items), or an expression (`"len(positions)"`) |
//! | `size`    | byte length of `bytes` |
//! | `if`      | expression; the field exists only when true |
//! | `check`   | plausibility expression on `value`; failures make a variant less likely |
//! | `prefer`  | `variant` only: expression choosing the expected alternative |
//! | `default` | value written when the field is missing from the JSON |
//! | `was`     | where older JSON had the value, read when the field is missing: a sibling's name, or `name[index]` for an item of a sibling list (a field that got its name later) |
//! | `doc`     | free text for humans |

mod engine;
pub mod expr;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use crate::codec::Codec;
use crate::{Error, Result};

pub use engine::{decode, encode, Decoded};

/// Built-in definitions, compiled in so the CLI works without data files.
pub const BUILTIN: &[(&str, &str)] = &[
    ("w3i.json", include_str!("../../formats/w3i.json")),
    ("doodads.json", include_str!("../../formats/doodads.json")),
    ("units.json", include_str!("../../formats/units.json")),
    ("regions.json", include_str!("../../formats/regions.json")),
    ("cameras.json", include_str!("../../formats/cameras.json")),
    ("sounds.json", include_str!("../../formats/sounds.json")),
    ("imports.json", include_str!("../../formats/imports.json")),
    ("campaign.json", include_str!("../../formats/campaign.json")),
    ("minimap.json", include_str!("../../formats/minimap.json")),
    ("lights.json", include_str!("../../formats/lights.json")),
];

/// The source text of a built-in definition (to copy it into a project and edit).
pub fn builtin_text(name: &str) -> Option<&'static str> {
    BUILTIN.iter().find_map(|(_, text)| {
        let def = Definition::parse(text, Source::Builtin).ok()?;
        (def.name == name).then_some(*text)
    })
}

#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    Builtin,
    File(PathBuf),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawDefinition {
    name: String,
    #[serde(default)]
    description: String,
    files: Vec<String>,
    #[serde(rename = "jsonFormat")]
    json_format: String,
    /// Expression over the decoded root; false rejects the file (e.g. unsupported versions).
    #[serde(default)]
    accept: Option<String>,
    fields: Vec<RawNode>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawNode {
    #[serde(default)]
    name: Option<String>,
    #[serde(rename = "type")]
    ty: String,
    #[serde(default)]
    fields: Vec<RawNode>,
    #[serde(default)]
    item: Option<Box<RawNode>>,
    #[serde(default)]
    count: Option<Value>,
    #[serde(default)]
    size: Option<usize>,
    #[serde(default, rename = "if")]
    cond: Option<String>,
    #[serde(default)]
    check: Option<String>,
    #[serde(default)]
    prefer: Option<String>,
    #[serde(default)]
    default: Option<Value>,
    #[serde(default)]
    was: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    doc: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Prim {
    U8,
    U16,
    U32,
    I32,
    F32,
    CString,
    Char,
    Id,
    Rgba,
    Bytes(usize),
}

#[derive(Debug)]
pub enum Count {
    Fixed(usize),
    /// Stored as a u32 in front of the items.
    PrefixU32,
    Expr(expr::Expr),
}

#[derive(Debug)]
pub enum Kind {
    Prim(Prim),
    Struct(Vec<Node>),
    List(Count, Box<Node>),
    Variant { prefer: Option<expr::Expr> },
}

#[derive(Debug)]
pub struct Node {
    pub name: Option<String>,
    pub kind: Kind,
    pub cond: Option<expr::Expr>,
    pub check: Option<expr::Expr>,
    pub default: Option<Value>,
    /// Older JSON's place of the value (`was`): a sibling field, and an index into it when it's a list.
    pub was: Option<(String, Option<usize>)>,
}

#[derive(Debug)]
pub struct Definition {
    pub name: String,
    pub description: String,
    pub files: Vec<String>,
    pub json_format: String,
    pub accept: Option<expr::Expr>,
    pub fields: Vec<Node>,
    pub source: Source,
}

/// Strips `//` line comments outside strings.
fn strip_comments(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let (mut in_str, mut escaped) = (false, false);
    let mut chars = src.chars().peekable();
    while let Some(c) = chars.next() {
        if in_str {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
        } else if c == '"' {
            in_str = true;
            out.push(c);
        } else if c == '/' && chars.peek() == Some(&'/') {
            for c in chars.by_ref() {
                if c == '\n' {
                    out.push('\n');
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn compile_node(raw: RawNode, path: &str) -> Result<Node> {
    let here = format!("{path}.{}", raw.name.as_deref().unwrap_or("[]"));
    let err = |m: String| Error::Format(format!("{here}: {m}"));
    let parse = |s: &Option<String>| -> Result<Option<expr::Expr>> {
        s.as_deref().map(expr::parse).transpose().map_err(|e| err(e.to_string()))
    };
    let cond = parse(&raw.cond)?;
    let check = parse(&raw.check)?;
    let was = match raw.was.as_deref() {
        None => None,
        Some(s) => Some(match s.strip_suffix(']').and_then(|s| s.split_once('[')) {
            Some((name, index)) => (name.to_string(), Some(index.parse::<usize>().map_err(|_| err(format!("was: {s:?} isn't name[index]")))?)),
            None if !s.is_empty() && !s.contains(['[', ']']) => (s.to_string(), None),
            None => return Err(err(format!("was: {s:?} isn't a name or name[index]"))),
        }),
    };
    let count = match &raw.count {
        None => None,
        Some(Value::Number(n)) => Some(Count::Fixed(n.as_u64().ok_or_else(|| err("count must be a whole number".into()))? as usize)),
        Some(Value::String(s)) if s == "u32" => Some(Count::PrefixU32),
        Some(Value::String(s)) => Some(Count::Expr(expr::parse(s).map_err(|e| err(e.to_string()))?)),
        Some(_) => return Err(err("count must be a number or a string".into())),
    };
    let base = match raw.ty.as_str() {
        "u8" => Kind::Prim(Prim::U8),
        "u16" => Kind::Prim(Prim::U16),
        "u32" => Kind::Prim(Prim::U32),
        "i32" => Kind::Prim(Prim::I32),
        "f32" => Kind::Prim(Prim::F32),
        "cstring" => Kind::Prim(Prim::CString),
        "char" => Kind::Prim(Prim::Char),
        "id" => Kind::Prim(Prim::Id),
        "rgba" => Kind::Prim(Prim::Rgba),
        "bytes" => Kind::Prim(Prim::Bytes(raw.size.ok_or_else(|| err("bytes needs a size".into()))?)),
        "struct" => {
            let fields = raw
                .fields
                .into_iter()
                .map(|f| {
                    if f.name.is_none() {
                        return Err(err("struct fields need a name".into()));
                    }
                    compile_node(f, &here)
                })
                .collect::<Result<Vec<_>>>()?;
            Kind::Struct(fields)
        }
        "list" => {
            let item = raw.item.ok_or_else(|| err("list needs an item".into()))?;
            let count = count.ok_or_else(|| err("list needs a count".into()))?;
            return Ok(Node {
                name: raw.name,
                kind: Kind::List(count, Box::new(compile_node(*item, &here)?)),
                cond,
                check: None,
                default: raw.default,
                was,
            });
        }
        "variant" => Kind::Variant { prefer: parse(&raw.prefer)? },
        other => return Err(err(format!("unknown type {other:?}"))),
    };
    // `count` on a non-list node: a list of that node.
    Ok(match count {
        Some(count) => Node {
            name: raw.name,
            kind: Kind::List(count, Box::new(Node { name: None, kind: base, cond: None, check, default: None, was: None })),
            cond,
            check: None,
            default: raw.default,
            was,
        },
        None => Node { name: raw.name, kind: base, cond, check, default: raw.default, was },
    })
}

impl Definition {
    pub fn parse(text: &str, source: Source) -> Result<Definition> {
        let raw: RawDefinition = serde_json::from_str(&strip_comments(text))
            .map_err(|e| Error::Format(format!("format definition: {e}")))?;
        let fields = raw
            .fields
            .into_iter()
            .map(|f| compile_node(f, &raw.name))
            .collect::<Result<Vec<_>>>()?;
        Ok(Definition {
            name: raw.name,
            description: raw.description,
            files: raw.files,
            json_format: raw.json_format,
            accept: raw.accept.as_deref().map(expr::parse).transpose()?,
            fields,
            source,
        })
    }

    /// Whether an archive file name is handled by this definition
    /// (case-insensitive; `*` matches any run of characters).
    pub fn matches(&self, archive_name: &str) -> bool {
        let name = archive_name.replace('/', "\\").to_ascii_lowercase();
        self.files.iter().any(|pat| glob(&pat.replace('/', "\\").to_ascii_lowercase(), &name))
    }
}

fn glob(pat: &str, s: &str) -> bool {
    match pat.split_once('*') {
        None => pat == s,
        Some((head, rest)) => {
            let Some(tail) = s.strip_prefix(head) else { return false };
            (0..=tail.len()).any(|i| tail.is_char_boundary(i) && glob(rest, &tail[i..]))
        }
    }
}

/// Built-ins, then every `*.json` in the override folders (later folders win).
pub fn load_definitions(override_dirs: &[PathBuf]) -> Result<Vec<Arc<Definition>>> {
    let mut defs: Vec<Arc<Definition>> = BUILTIN
        .iter()
        .map(|(file, text)| Definition::parse(text, Source::Builtin).map_err(|e| Error::Format(format!("built-in {file}: {e}"))))
        .map(|d| d.map(Arc::new))
        .collect::<Result<_>>()?;
    for dir in override_dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("json")))
            .collect();
        files.sort();
        for path in files {
            let text = std::fs::read_to_string(&path)?;
            let def = Definition::parse(&text, Source::File(path.clone()))
                .map_err(|e| Error::Format(format!("{}: {e}", path.display())))?;
            defs.retain(|d| d.name != def.name);
            defs.push(Arc::new(def));
        }
    }
    Ok(defs)
}

/// The codec for a definition: archive bytes ⇄ pretty JSON.
pub struct FormatCodec {
    pub def: Arc<Definition>,
    id: &'static str,
}

impl FormatCodec {
    pub fn new(def: Arc<Definition>) -> Self {
        // Codec ids are &'static; definitions live for the program's lifetime anyway.
        let id: &'static str = Box::leak(format!("format:{}", def.name).into_boxed_str());
        FormatCodec { def, id }
    }
}

impl Codec for FormatCodec {
    fn id(&self) -> &'static str {
        self.id
    }
    fn suffix(&self) -> &'static str {
        ".json"
    }
    fn matches(&self, name: &str) -> bool {
        self.def.matches(name)
    }
    fn decode(&self, _name: &str, bytes: &[u8]) -> Result<Vec<u8>> {
        Ok(self.decode_with_notes("", bytes)?.0)
    }
    fn decode_with_notes(&self, _name: &str, bytes: &[u8]) -> Result<(Vec<u8>, Vec<String>)> {
        let d = decode(&self.def, bytes)?;
        let mut out = serde_json::to_vec_pretty(&d.value).map_err(|e| Error::Format(e.to_string()))?;
        out.push(b'\n');
        Ok((out, d.notes))
    }
    fn as_format(&self) -> Option<&FormatCodec> {
        Some(self)
    }
    fn encode(&self, _name: &str, bytes: &[u8]) -> Result<Vec<u8>> {
        let value: Value = serde_json::from_slice(bytes).map_err(|e| Error::Format(format!("invalid JSON: {e}")))?;
        encode(&self.def, &value)
    }
}

/// Override folders for a project: `<project>/.w3proj/formats`.
pub fn project_dir(project: &Path) -> PathBuf {
    project.join(".w3proj").join("formats")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globbing() {
        assert!(glob("war3map.w3i", "war3map.w3i"));
        assert!(glob("*.w3u", "war3mapskin.w3u"));
        assert!(glob("war3map*.doo", "war3mapunits.doo"));
        assert!(!glob("*.w3u", "war3map.w3t"));
    }

    #[test]
    fn comments_outside_strings_only() {
        let s = strip_comments("{\"a\": \"http://x\" // note\n}");
        assert_eq!(s, "{\"a\": \"http://x\" \n}");
    }

    #[test]
    fn builtins_parse() {
        let defs = load_definitions(&[]).unwrap();
        assert!(defs.iter().any(|d| d.name == "w3i" && d.matches("war3map.w3i")));
    }

    /// Items that read no bytes (empty structs) can't be held to the bytes left, but a count from the file is still
    /// bounded: a u32 in front of them or a count read from a field asks for millions of `{}` from four bytes otherwise.
    /// The control: a few of them decode and round-trip, also at the end of the file.
    #[test]
    fn counts_of_empty_items_are_bounded() {
        let prefixed = Definition::parse(
            r#"{ "name": "t", "files": ["t.bin"], "jsonFormat": "t/1",
                 "fields": [ { "name": "marks", "type": "list", "count": "u32", "item": { "type": "struct", "fields": [] } } ] }"#,
            Source::Builtin,
        )
        .unwrap();
        let counted = Definition::parse(
            r#"{ "name": "t", "files": ["t.bin"], "jsonFormat": "t/1",
                 "fields": [ { "name": "n", "type": "u32" },
                             { "name": "marks", "type": "list", "count": "n", "item": { "type": "struct", "fields": [] } } ] }"#,
            Source::Builtin,
        )
        .unwrap();
        for def in [&prefixed, &counted] {
            let few = decode(def, &3u32.to_le_bytes()).unwrap().value;
            assert_eq!(few["marks"].as_array().map(Vec::len), Some(3));
            assert_eq!(encode(def, &few).unwrap(), 3u32.to_le_bytes());
            for n in [1u32 << 24, u32::MAX] {
                assert!(decode(def, &n.to_le_bytes()).is_err(), "{} items from four bytes", n);
            }
        }
    }
}

/// Map info fixtures through the built-in w3i definition (formerly the
/// hand-written codec's tests).
#[cfg(test)]
mod w3i_tests {
    use super::*;
    use serde_json::json;

    fn w3i() -> Arc<Definition> {
        load_definitions(&[]).unwrap().into_iter().find(|d| d.name == "w3i").unwrap()
    }

    fn sample(version: u32, hud: bool) -> Value {
        let v39 = version >= 39;
        let mut m = json!({
            "format": "w3proj.mapinfo/1", "version": version, "saves": 7,
            "editorVersion": if hud { 7003 } else { 6127 },
        });
        let o = m.as_object_mut().unwrap();
        if version >= 27 {
            o.insert("gameVersion".into(), json!([3, 0, 1, 24371]));
        }
        for (k, v) in [
            ("name", json!("TRIGSTR_001")),
            ("author", json!("me")),
            ("description", json!("d")),
            ("suggestedPlayers", json!("1v1")),
            ("cameraBounds", json!([-1.5, 2.0, 3.25, 4.0, 5.0, 6.0, 7.0, 8.0])),
            ("cameraComplements", json!([6, 6, 4, 8])),
            ("playableWidth", json!(116)),
            ("playableHeight", json!(84)),
            ("flags", json!(0x8c14)),
            ("tileset", json!("L")),
        ] {
            o.insert(k.into(), v);
        }
        let mut ls = json!({ "number": -1 });
        if v39 {
            ls.as_object_mut().unwrap().insert("crestRace".into(), json!(1));
        }
        for (k, v) in [("model", ""), ("text", "t"), ("title", ""), ("subtitle", "")] {
            ls.as_object_mut().unwrap().insert(k.into(), json!(v));
        }
        o.insert("loadingScreen".into(), ls);
        o.insert("gameDataSet".into(), json!(0));
        o.insert("prologue".into(), json!({ "path": "", "text": "", "title": "", "subtitle": "" }));
        o.insert("fog".into(), json!({ "style": 0, "start": 3000.0, "end": 5000.0, "density": 0.5, "color": [255, 255, 255, 255] }));
        if v39 {
            o.insert("terrainFog".into(), json!({ "style": 0, "overSky": 1, "linearStart": 1000.0, "linearEnd": 8000.0, "maxOpacity": 1.0, "height": 0.0 }));
        }
        o.insert("weather".into(), json!("RAhr"));
        o.insert("soundEnvironment".into(), json!("Default"));
        o.insert("lightEnvironment".into(), json!(""));
        o.insert("waterTint".into(), json!([255, 255, 255, 255]));
        if version >= 28 {
            o.insert("scriptType".into(), json!(1));
        }
        if version >= 31 {
            o.insert("supportedModes".into(), json!(3));
            o.insert("gameDataVersion".into(), json!(1));
        }
        if version >= 32 {
            let mut z = json!({ "default": 1650, "max": 3000 });
            if version >= 33 {
                z.as_object_mut().unwrap().insert("min".into(), json!(500));
            }
            o.insert("cameraZoom".into(), z);
        }
        if v39 {
            o.insert(
                "water".into(),
                json!({ "minOpacity": 0, "maxOpacity": 100, "reflectivity": 10, "emissivity": 0, "edgeSoftness": 10,
                        "wavesVertexDisplacement": 20, "wavesNormalMapStrength": 100, "overrideColor": 0,
                        "environmentMapReflectivity": 100, "unknown": -1 }),
            );
            o.insert("playerHudSkins".into(), json!(hud));
        }
        let mut p = json!({ "id": 0, "controller": 1, "race": 1 });
        let po = p.as_object_mut().unwrap();
        if v39 && hud {
            po.insert("hudSkin".into(), json!(64));
        }
        for (k, v) in [
            ("fixedStart", json!(1)),
            ("name", json!("Player 1")),
            ("start", json!([-1024.0, 512.5])),
            ("allyLow", json!(0)),
            ("allyHigh", json!(0)),
        ] {
            po.insert(k.into(), v);
        }
        if version >= 31 {
            po.insert("enemyLow".into(), json!(0));
            po.insert("enemyHigh".into(), json!(0));
        }
        o.insert("players".into(), json!([p]));
        o.insert("forces".into(), json!([{ "flags": 0, "players": 1, "name": "Force 1" }]));
        o.insert("upgrades".into(), json!([{ "players": 1, "id": "Rhme", "level": 0, "availability": 2 }]));
        o.insert("techs".into(), json!([{ "players": 1, "id": "hfoo" }]));
        o.insert(
            "unitTables".into(),
            json!([{ "number": 0, "name": "Group", "positions": [0, 1], "lines": [{ "chance": 100, "ids": ["hfoo", "hkni"] }] }]),
        );
        o.insert("itemTables".into(), json!([{ "number": 0, "name": "Items", "sets": [[{ "chance": 100, "id": "ratc" }]] }]));
        m
    }

    #[test]
    fn roundtrip_all_versions() {
        let def = w3i();
        for v in [25, 28, 31, 32, 33, 39] {
            let json = sample(v, true);
            let bin = encode(&def, &json).unwrap();
            assert_eq!(decode(&def, &bin).unwrap().value, json, "v{v}");
        }
    }

    #[test]
    fn v39_hud_skin_variant_is_detected() {
        let def = w3i();
        for hud in [true, false] {
            let json = sample(39, hud);
            let bin = encode(&def, &json).unwrap();
            assert_eq!(decode(&def, &bin).unwrap().value, json, "hud={hud}");
        }
    }

    /// Random objects by level in random groups and item tables ("YYU3" a level 3 creep, "YYB/" a neutral passive
    /// building, "YiI2" a permanent level 2 item; the World Editor's own, app lib/objects/randomids.ts) are four
    /// bytes like any id: the file comes back byte for byte, the JSON names them as written.
    #[test]
    fn random_level_ids_round_trip_byte_exact() {
        let def = w3i();
        let mut json = sample(31, true);
        json["unitTables"] = json!([{ "number": 0, "name": "Probe", "positions": [0, 1, 2], "lines": [
            { "chance": 60, "ids": ["YYU3", "YYB/", "YiI2"] },
            { "chance": 40, "ids": ["YYU/", "0x00000000", "YYI:"] }
        ] }]);
        json["itemTables"] = json!([{ "number": 0, "name": "Loot", "sets": [[{ "chance": 100, "id": "YoI/" }]] }]);
        let bin = encode(&def, &json).unwrap();
        for id in [b"YYU3", b"YYB/", b"YiI2", b"YYU/", b"YYI:", b"YoI/"] {
            assert!(bin.windows(4).any(|w| w == id), "{} written as its bytes", String::from_utf8_lossy(id));
        }
        let back = decode(&def, &bin).unwrap().value;
        assert_eq!(back, json);
        assert_eq!(encode(&def, &back).unwrap(), bin);
    }

    #[test]
    fn unsupported_versions_are_rejected() {
        let mut json = sample(31, true);
        json["version"] = json!(40);
        assert!(encode(&w3i(), &json).is_err());
    }

    #[test]
    fn counted_lists_must_match() {
        let mut json = sample(31, true);
        json["unitTables"][0]["lines"][0]["ids"] = json!(["hfoo"]);
        assert!(encode(&w3i(), &json).is_err());
    }

    #[test]
    fn project_overrides_replace_builtins() {
        let dir = std::env::temp_dir().join(format!("w3proj-format-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("my.json"),
            r#"// a project-specific replacement
            { "name": "w3i", "files": ["war3map.w3i"], "jsonFormat": "custom/1",
              "fields": [ { "name": "version", "type": "u32" } ] }"#,
        )
        .unwrap();
        let defs = load_definitions(std::slice::from_ref(&dir)).unwrap();
        let w3i: Vec<_> = defs.iter().filter(|d| d.name == "w3i").collect();
        assert_eq!(w3i.len(), 1);
        assert_eq!(w3i[0].json_format, "custom/1");
        assert!(matches!(w3i[0].source, Source::File(_)));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

/// The oldest layouts, as the Reign of Chaos campaign writes them.
#[cfg(test)]
mod classic_tests {
    use super::*;

    fn def(name: &str) -> Arc<Definition> {
        load_definitions(&[]).unwrap().into_iter().find(|d| d.name == name).unwrap()
    }
    fn u(v: u32) -> Vec<u8> {
        v.to_le_bytes().to_vec()
    }
    fn f(n: usize) -> Vec<u8> {
        (0..n).flat_map(|i| (i as f32 + 1.5).to_le_bytes()).collect()
    }
    fn z(s: &str) -> Vec<u8> {
        [s.as_bytes(), &[0]].concat()
    }
    fn exact(name: &str, bytes: &[u8]) -> Value {
        let d = def(name);
        let got = decode(&d, bytes).unwrap().value;
        assert_eq!(encode(&d, &got).unwrap(), bytes, "{name} round trip");
        got
    }

    #[test]
    fn version_0_cameras_with_and_without_local_angles() {
        for (floats, angles) in [(13, true), (10, false)] {
            let one = |name: &str| [f(floats), z(name)].concat();
            let got = exact("cameras", &[u(0), u(2), one("First"), one("Second")].concat());
            assert_eq!(got["localAngles"], angles);
            assert_eq!(got["cameras"][1]["name"], "Second");
            assert_eq!(got["cameras"][0].get("localPitch").is_some(), angles);
        }
    }

    /// Version 3's three floats after the local angles are the World Editor's DoF Distance, DoF Scale and Pos Absolute Z
    /// (0, 123 and 2.5 typed in its camera dialog, 2026-11-12); JSON from before keeps them as `unknown`.
    #[test]
    fn version_3_cameras_name_their_depth_of_field() {
        let fl = |x: f32| x.to_le_bytes().to_vec();
        let one = [f(13), fl(0.0), fl(123.0), fl(2.5), z("look"), u(0)].concat();
        let bytes = [u(3), u(1), one].concat();
        let got = exact("cameras", &bytes);
        let cam = &got["cameras"][0];
        assert_eq!((cam["dofDistance"].as_f64(), cam["dofScale"].as_f64(), cam["posAbsoluteZ"].as_f64()), (Some(0.0), Some(123.0), Some(2.5)));
        assert!(cam.get("unknown").is_none());
        // The old JSON: the same bytes.
        let mut old = got.clone();
        let c = old["cameras"][0].as_object_mut().unwrap();
        for k in ["dofDistance", "dofScale", "posAbsoluteZ"] {
            c.remove(k);
        }
        c.insert("unknown".into(), serde_json::json!([0.0, 123.0, 2.5]));
        assert_eq!(encode(&def("cameras"), &old).unwrap(), bytes);
        // A name wins over the old list; neither is an error.
        old["cameras"][0]["dofScale"] = serde_json::json!(7.0);
        assert_eq!(encode(&def("cameras"), &old).unwrap()[4 + 4 + 14 * 4..4 + 4 + 15 * 4], 7f32.to_le_bytes());
        old["cameras"][0].as_object_mut().unwrap().remove("unknown");
        assert!(encode(&def("cameras"), &old).is_err());
    }

    /// Long names fit the longer layout as well: letters read as floats, and shifted names.
    #[test]
    fn long_camera_names_are_not_read_as_angles() {
        let one = |name: &str| [f(10), z(name)].concat();
        let got = exact("cameras", &[u(0), u(2), one("Camera 01 Opening Shot"), one("Camera 02 Teleport In")].concat());
        assert_eq!(got["localAngles"], false);
        assert_eq!(got["cameras"][0]["name"], "Camera 01 Opening Shot");
        assert_eq!(got["cameras"][1]["name"], "Camera 02 Teleport In");
    }

    #[test]
    fn version_7_doodads_have_no_item_drops() {
        let one = [b"ATtr".to_vec(), u(2), f(7), vec![2, 100], u(9)].concat();
        let got = exact("doodads", &[b"W3do".to_vec(), u(7), u(9), u(1), one, u(0), u(0)].concat());
        assert_eq!(got["doodads"][0]["editorId"], 9);
        assert_eq!(got["doodads"][0]["life"], 100);
    }

    #[test]
    fn version_7_units() {
        let one = [b"hfoo".to_vec(), u(0), f(7), vec![2], u(1), vec![0, 0], u(u32::MAX), u(u32::MAX), u(0), u(0), (-1f32).to_le_bytes().to_vec(), u(1),
            u(0), u(0), u(0), vec![1, 0, 0, 0], u(u32::MAX), u(u32::MAX), u(13)].concat();
        let got = exact("units", &[b"W3do".to_vec(), u(7), u(9), u(1), one].concat());
        assert_eq!(got["units"][0]["player"], 1);
        assert_eq!(got["units"][0]["editorId"], 13);
    }

    /// Import paths survive decode and encode. smoketest_maps' TurtleRock v2.0 (a W3Champions build) really stores
    /// 66 entries of flag 0 and an empty path (140 bytes: version 1, count 66, then 00 00 per entry); its files are
    /// named only by the archive's (listfile). The empty list must stay as it is, not be filled in or dropped.
    #[test]
    fn imports_keep_their_paths_and_blank_lists_stay_blank() {
        let got = exact("imports", &[u(1), u(2), vec![13], z("war3mapImported\\a.blp"), vec![29], z("_HD.w3mod\\b.mdx")].concat());
        assert_eq!(got["files"][0]["path"], "war3mapImported\\a.blp");
        assert_eq!(got["files"][1]["flags"], 29);
        let blank = [u(1), u(66), [0u8, 0].repeat(66)].concat();
        assert_eq!(blank.len(), 140);
        let got = exact("imports", &blank);
        let files = got["files"].as_array().unwrap();
        assert_eq!(files.len(), 66);
        assert!(files.iter().all(|e| e["path"] == "" && e["flags"] == 0));
    }

    #[test]
    fn version_18_map_info_stops_short() {
        let bytes = [
            u(18), u(3), u(6060), z("Name"), z("Author"), z("About"), z("1"), f(8), u(6), u(6), u(4), u(8), u(52), u(52), u(0xc61), b"A".to_vec(),
            u(29), z("Text"), z(""), z("Subtitle"), // loading screen
            u(0), z(""), z(""), z(""), // its number, prologue
            u(1), u(0), u(1), u(1), u(1), z("Player"), f(2), u(0), u(0), // one player
            u(1), u(0), u(u32::MAX), z("Force"), // one force
            u(0), u(0), u(0), // upgrades, techs, unit tables
        ].concat();
        let got = exact("w3i", &bytes);
        assert_eq!(got["loadingScreen"]["subtitle"], "Subtitle");
        assert_eq!(got["players"][0]["name"], "Player");
        assert_eq!(got["forces"][0]["name"], "Force");
        for absent in ["fog", "weather", "waterTint", "itemTables"] {
            assert!(got.get(absent).is_none(), "{absent}");
        }
    }
}
