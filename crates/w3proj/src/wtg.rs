//! `war3map.wtg` (GUI triggers, variables, categories) as JSON, in the shape the app's trigger
//! editor uses (`app/src/lib/triggers/wtg.ts`, `TriggerFile`).
//!
//! Reading needs the game's TriggerData.txt: parameters are stored without a count. Writing
//! doesn't, so a project packs without the game. Layouts:
//! Reforged: "WTG!", marker, version, 8 × (count, deleted ids), unknown, variables (with id and
//! parent), items (categories, triggers, script items, variables' folder entries).
//! Classic (v4/v7): "WTG!", version, categories, unknown, variables, triggers; categories are
//! turned into items (type 4) as the app does, and back.

use serde::{Deserialize, Serialize};

use crate::triggerdata::TriggerData;
use crate::{Error, Result};

const MARKER: u32 = 0x8000_0004;

#[derive(Serialize, Deserialize, PartialEq, Debug)]
pub struct TriggerFile {
    pub reforged: bool,
    pub version: u32,
    pub counts: Vec<Count>,
    pub unknown: u32,
    pub variables: Vec<Variable>,
    pub items: Vec<Item>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
pub struct Count {
    pub count: u32,
    pub deleted: Vec<u32>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub unknown: u32,
    pub is_array: bool,
    pub array_size: u32,
    pub initialized: bool,
    pub initial_value: String,
    pub id: u32,
    pub parent: i32,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(untagged)]
pub enum Item {
    Trigger(Trigger),
    Category(Category),
    Element(Element),
}

/// Types 1 (map), 2 (library), 4 (category).
#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Category {
    #[serde(rename = "type")]
    pub ty: u32,
    pub id: u32,
    pub name: String,
    pub is_comment: u32,
    pub expanded: u32,
    pub parent: i32,
}

/// Types 8 (trigger), 16 (comment), 32 (script).
#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Trigger {
    #[serde(rename = "type")]
    pub ty: u32,
    pub name: String,
    pub description: String,
    pub is_comment: u32,
    pub id: u32,
    pub enabled: bool,
    pub is_custom: bool,
    pub initially_off: bool,
    pub run_on_init: bool,
    pub parent: i32,
    pub ecas: Vec<Eca>,
}

/// Type 64 (a variable in the tree).
#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Element {
    #[serde(rename = "type")]
    pub ty: u32,
    pub id: u32,
    pub name: String,
    pub parent: i32,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Eca {
    pub kind: u32,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub group: Option<u32>,
    pub name: String,
    pub enabled: bool,
    pub params: Vec<Param>,
    pub children: Vec<Eca>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Param {
    #[serde(rename = "type")]
    pub ty: i32,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub call: Option<Box<Call>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub index: Option<Box<Param>>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Call {
    pub kind: u32,
    pub name: String,
    pub has_params: bool,
    pub params: Vec<Param>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub trailer: Option<u32>,
}

fn err(m: impl Into<String>) -> Error {
    Error::Format(format!("war3map.wtg: {}", m.into()))
}

struct Reader<'a> {
    b: &'a [u8],
    o: usize,
}

impl Reader<'_> {
    fn u32(&mut self) -> Result<u32> {
        let s = self.b.get(self.o..self.o + 4).ok_or_else(|| err("truncated"))?;
        self.o += 4;
        Ok(u32::from_le_bytes(s.try_into().unwrap()))
    }
    fn i32(&mut self) -> Result<i32> {
        Ok(self.u32()? as i32)
    }
    fn flag(&mut self) -> Result<bool> {
        match self.u32()? {
            0 => Ok(false),
            1 => Ok(true),
            v => Err(err(format!("flag {v} at {}", self.o - 4))),
        }
    }
    fn str(&mut self) -> Result<String> {
        let rest = &self.b[self.o.min(self.b.len())..];
        let n = rest.iter().position(|&c| c == 0).ok_or_else(|| err("unterminated string"))?;
        self.o += n + 1;
        String::from_utf8(rest[..n].to_vec()).map_err(|_| err("string isn't UTF-8"))
    }
    fn list<T>(&mut self, mut f: impl FnMut(&mut Self) -> Result<T>) -> Result<Vec<T>> {
        let n = self.u32()? as usize;
        if n > self.b.len() {
            return Err(err("count larger than the file"));
        }
        (0..n).map(|_| f(self)).collect()
    }
}

struct Ctx<'a> {
    data: &'a TriggerData,
    v7: bool,
}

impl Ctx<'_> {
    fn args(&self, kind: u32, name: &str) -> Result<usize> {
        self.data
            .arg_count(kind, name)
            .ok_or_else(|| err(format!("unknown trigger function \"{name}\" (not in TriggerData.txt)")))
    }
    fn param(&self, r: &mut Reader) -> Result<Param> {
        let ty = r.i32()?;
        let value = r.str()?;
        let call = if r.flag()? {
            let kind = r.u32()?;
            let name = r.str()?;
            let has_params = r.flag()?;
            let n = if has_params { self.args(kind, &name)? } else { 0 };
            let params = (0..n).map(|_| self.param(r)).collect::<Result<_>>()?;
            let trailer = if self.v7 { Some(r.u32()?) } else { None };
            Some(Box::new(Call { kind, name, has_params, params, trailer }))
        } else {
            None
        };
        let index = if r.flag()? { Some(Box::new(self.param(r)?)) } else { None };
        Ok(Param { ty, value, call, index })
    }
    fn eca(&self, r: &mut Reader, child: bool) -> Result<Eca> {
        let kind = r.u32()?;
        let group = if child { Some(r.u32()?) } else { None };
        let name = r.str()?;
        let enabled = r.flag()?;
        let params = (0..self.args(kind, &name)?).map(|_| self.param(r)).collect::<Result<_>>()?;
        let children = if self.v7 { r.list(|r| self.eca(r, true))? } else { Vec::new() };
        Ok(Eca { kind, group, name, enabled, params, children })
    }
    fn trigger(&self, r: &mut Reader, ty: u32, id: Option<u32>) -> Result<Trigger> {
        let name = r.str()?;
        let description = r.str()?;
        let is_comment = if self.v7 { r.u32()? } else { 0 };
        let id = match id {
            Some(i) => i,
            None => r.u32()?,
        };
        Ok(Trigger {
            ty,
            name,
            description,
            is_comment,
            id,
            enabled: r.flag()?,
            is_custom: r.flag()?,
            initially_off: r.flag()?,
            run_on_init: r.flag()?,
            parent: r.i32()?,
            ecas: r.list(|r| self.eca(r, false))?,
        })
    }
}

pub fn parse(b: &[u8], data: &TriggerData) -> Result<TriggerFile> {
    if b.get(..4) != Some(b"WTG!") {
        return Err(err("missing WTG! header"));
    }
    let mut r = Reader { b, o: 4 };
    let first = r.u32()?;
    let f = if first == MARKER {
        let version = r.u32()?;
        let ctx = Ctx { data, v7: true };
        let counts = (0..8)
            .map(|_| Ok(Count { count: r.u32()?, deleted: r.list(|r| r.u32())? }))
            .collect::<Result<_>>()?;
        let unknown = r.u32()?;
        let variables = r.list(|r| {
            Ok(Variable {
                name: r.str()?,
                ty: r.str()?,
                unknown: r.u32()?,
                is_array: r.flag()?,
                array_size: r.u32()?,
                initialized: r.flag()?,
                initial_value: r.str()?,
                id: r.u32()?,
                parent: r.i32()?,
            })
        })?;
        let items = r.list(|r| {
            let ty = r.u32()?;
            Ok(match ty {
                1 | 2 | 4 => Item::Category(Category {
                    ty,
                    id: r.u32()?,
                    name: r.str()?,
                    is_comment: r.u32()?,
                    expanded: r.u32()?,
                    parent: r.i32()?,
                }),
                8 | 16 | 32 => Item::Trigger(ctx.trigger(r, ty, None)?),
                64 => Item::Element(Element { ty, id: r.u32()?, name: r.str()?, parent: r.i32()? }),
                t => return Err(err(format!("unknown item type {t}"))),
            })
        })?;
        TriggerFile { reforged: true, version, counts, unknown, variables, items }
    } else {
        let version = first;
        if version != 4 && version != 7 {
            return Err(err(format!("unsupported version {version}")));
        }
        let ctx = Ctx { data, v7: version == 7 };
        let mut items = r.list(|r| {
            let id = r.u32()?;
            let name = r.str()?;
            let is_comment = if ctx.v7 { r.u32()? } else { 0 };
            Ok(Item::Category(Category { ty: 4, id, name, is_comment, expanded: 1, parent: -1 }))
        })?;
        let unknown = r.u32()?;
        let mut i = 0;
        let variables = r.list(|r| {
            let v = Variable {
                name: r.str()?,
                ty: r.str()?,
                unknown: r.u32()?,
                is_array: r.flag()?,
                array_size: if ctx.v7 { r.u32()? } else { 1 },
                initialized: r.flag()?,
                initial_value: r.str()?,
                id: i,
                parent: -1,
            };
            i += 1;
            Ok(v)
        })?;
        let mut i = 0;
        let triggers = r.list(|r| {
            let t = ctx.trigger(r, 8, Some(i))?;
            i += 1;
            Ok(Item::Trigger(t))
        })?;
        items.extend(triggers);
        TriggerFile { reforged: false, version, counts: Vec::new(), unknown, variables, items }
    };
    if r.o != b.len() {
        return Err(err(format!("{} bytes after the trigger data", b.len().saturating_sub(r.o))));
    }
    Ok(f)
}

struct Writer {
    out: Vec<u8>,
    v7: bool,
}

impl Writer {
    fn u32(&mut self, v: u32) {
        self.out.extend_from_slice(&v.to_le_bytes());
    }
    fn i32(&mut self, v: i32) {
        self.u32(v as u32);
    }
    fn str(&mut self, s: &str) {
        self.out.extend_from_slice(s.as_bytes());
        self.out.push(0);
    }
    fn param(&mut self, p: &Param) {
        self.i32(p.ty);
        self.str(&p.value);
        self.u32(p.call.is_some() as u32);
        if let Some(c) = &p.call {
            self.u32(c.kind);
            self.str(&c.name);
            self.u32(c.has_params as u32);
            if c.has_params {
                for q in &c.params {
                    self.param(q);
                }
            }
            if self.v7 {
                self.u32(c.trailer.unwrap_or(0));
            }
        }
        self.u32(p.index.is_some() as u32);
        if let Some(i) = &p.index {
            self.param(i);
        }
    }
    fn eca(&mut self, e: &Eca, child: bool) {
        self.u32(e.kind);
        if child {
            self.u32(e.group.unwrap_or(0));
        }
        self.str(&e.name);
        self.u32(e.enabled as u32);
        for p in &e.params {
            self.param(p);
        }
        if self.v7 {
            self.u32(e.children.len() as u32);
            for c in &e.children {
                self.eca(c, true);
            }
        }
    }
    fn flags(&mut self, t: &Trigger) {
        for f in [t.enabled, t.is_custom, t.initially_off, t.run_on_init] {
            self.u32(f as u32);
        }
        self.i32(t.parent);
        self.u32(t.ecas.len() as u32);
        for e in &t.ecas {
            self.eca(e, false);
        }
    }
}

pub fn write(f: &TriggerFile) -> Vec<u8> {
    let mut w = Writer { out: b"WTG!".to_vec(), v7: f.reforged || f.version == 7 };
    if f.reforged {
        w.u32(MARKER);
        w.u32(f.version);
        for c in &f.counts {
            w.u32(c.count);
            w.u32(c.deleted.len() as u32);
            for d in &c.deleted {
                w.u32(*d);
            }
        }
        w.u32(f.unknown);
        w.u32(f.variables.len() as u32);
        for v in &f.variables {
            w.str(&v.name);
            w.str(&v.ty);
            w.u32(v.unknown);
            w.u32(v.is_array as u32);
            w.u32(v.array_size);
            w.u32(v.initialized as u32);
            w.str(&v.initial_value);
            w.u32(v.id);
            w.i32(v.parent);
        }
        w.u32(f.items.len() as u32);
        for it in &f.items {
            match it {
                Item::Element(e) => {
                    w.u32(e.ty);
                    w.u32(e.id);
                    w.str(&e.name);
                    w.i32(e.parent);
                }
                Item::Category(c) => {
                    w.u32(c.ty);
                    w.u32(c.id);
                    w.str(&c.name);
                    w.u32(c.is_comment);
                    w.u32(c.expanded);
                    w.i32(c.parent);
                }
                Item::Trigger(t) => {
                    w.u32(t.ty);
                    w.str(&t.name);
                    w.str(&t.description);
                    w.u32(t.is_comment);
                    w.u32(t.id);
                    w.flags(t);
                }
            }
        }
        return w.out;
    }
    let v7 = w.v7;
    let categories: Vec<&Category> = f.items.iter().filter_map(|i| if let Item::Category(c) = i { Some(c) } else { None }).collect();
    w.u32(f.version);
    w.u32(categories.len() as u32);
    for c in categories {
        w.u32(c.id);
        w.str(&c.name);
        if v7 {
            w.u32(c.is_comment);
        }
    }
    w.u32(f.unknown);
    w.u32(f.variables.len() as u32);
    for v in &f.variables {
        w.str(&v.name);
        w.str(&v.ty);
        w.u32(v.unknown);
        w.u32(v.is_array as u32);
        if v7 {
            w.u32(v.array_size);
        }
        w.u32(v.initialized as u32);
        w.str(&v.initial_value);
    }
    let triggers: Vec<&Trigger> = f.items.iter().filter_map(|i| if let Item::Trigger(t) = i { Some(t) } else { None }).collect();
    w.u32(triggers.len() as u32);
    for t in triggers {
        w.str(&t.name);
        w.str(&t.description);
        if v7 {
            w.u32(t.is_comment);
        }
        w.flags(t);
    }
    w.out
}

/// The file's layout (the app writes the same): the file, triggers and ECAs (objects with
/// `items`, `ecas` or `children`) one key per line, two-space indent; arrays of objects one
/// element per line; everything else (parameters, variables, categories, counts) on one line.
fn layout(v: &serde_json::Value, indent: &str, out: &mut String) {
    use serde_json::Value;
    let inner = format!("{indent}  ");
    match v {
        Value::Object(m) if ["items", "ecas", "children"].iter().any(|k| m.contains_key(*k)) => {
            out.push_str("{\n");
            for (i, (k, x)) in m.iter().enumerate() {
                out.push_str(&inner);
                out.push_str(&Value::String(k.clone()).to_string());
                out.push_str(": ");
                layout(x, &inner, out);
                out.push_str(if i + 1 < m.len() { ",\n" } else { "\n" });
            }
            out.push_str(indent);
            out.push('}');
        }
        Value::Array(a) if a.iter().any(Value::is_object) => {
            out.push_str("[\n");
            for (i, x) in a.iter().enumerate() {
                out.push_str(&inner);
                layout(x, &inner, out);
                out.push_str(if i + 1 < a.len() { ",\n" } else { "\n" });
            }
            out.push_str(indent);
            out.push(']');
        }
        _ => out.push_str(&v.to_string()),
    }
}

/// Binary → JSON (see `layout`; trailing line break).
pub fn to_json(b: &[u8], data: &TriggerData) -> Result<Vec<u8>> {
    let f = parse(b, data)?;
    let v = serde_json::to_value(&f).map_err(|e| err(e.to_string()))?;
    let mut out = String::new();
    layout(&v, "", &mut out);
    out.push('\n');
    Ok(out.into_bytes())
}

/// JSON → binary.
pub fn from_json(json: &[u8]) -> Result<Vec<u8>> {
    let f: TriggerFile = serde_json::from_slice(json).map_err(|e| err(e.to_string()))?;
    for it in &f.items {
        let ok = match it {
            Item::Category(c) => matches!(c.ty, 1 | 2 | 4),
            Item::Trigger(t) => matches!(t.ty, 8 | 16 | 32),
            Item::Element(e) => e.ty == 64,
        };
        if !ok {
            return Err(err("an item's type doesn't match its fields"));
        }
    }
    Ok(write(&f))
}

/// Names of the triggers with a custom text slot (types 8 and 32), in war3map.wct's order, from
/// the JSON form.
pub fn text_trigger_names(json: &[u8]) -> Option<Vec<String>> {
    let f: TriggerFile = serde_json::from_slice(json).ok()?;
    Some(
        f.items
            .into_iter()
            .filter_map(|i| match i {
                Item::Trigger(t) if t.ty == 8 || t.ty == 32 => Some(t.name),
                _ => None,
            })
            .collect(),
    )
}
