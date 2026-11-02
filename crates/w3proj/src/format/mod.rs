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
            });
        }
        "variant" => Kind::Variant { prefer: parse(&raw.prefer)? },
        other => return Err(err(format!("unknown type {other:?}"))),
    };
    // `count` on a non-list node: a list of that node.
    Ok(match count {
        Some(count) => Node {
            name: raw.name,
            kind: Kind::List(count, Box::new(Node { name: None, kind: base, cond: None, check, default: None })),
            cond,
            check: None,
            default: raw.default,
        },
        None => Node { name: raw.name, kind: base, cond, check, default: raw.default },
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
