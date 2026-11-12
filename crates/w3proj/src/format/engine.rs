//! Interprets a [`Definition`]: bytes → JSON (`decode`) and JSON → bytes (`encode`).
//!
//! Decoding tries every combination of the definition's variants and keeps
//! the reading that consumes the file exactly, fails the fewest `check`s and
//! agrees with the variants' `prefer` expressions. The notes say which
//! alternatives also fit, so an ambiguous file is visible instead of silent.

use serde_json::{Map, Number, Value};

use super::expr::{Scope, Val};
use super::{Count, Definition, Kind, Node, Prim};
use crate::objdata::Id;
use crate::{Error, Result};

pub struct Decoded {
    pub value: Value,
    /// Human-readable remarks: chosen variants, ambiguity, failed checks.
    pub notes: Vec<String>,
}

/// Field values visible to expressions: the objects being read/written,
/// innermost last, plus an optional `value` for checks.
struct Frames<'a> {
    frames: &'a [Map<String, Value>],
    value: Option<&'a Value>,
}

fn to_val(v: &Value) -> Option<Val> {
    match v {
        Value::Bool(b) => Some(Val::Bool(*b)),
        Value::Number(n) => n.as_f64().map(Val::Num),
        _ => None,
    }
}

impl Scope for Frames<'_> {
    fn get(&self, name: &str) -> Option<Val> {
        if name == "value" {
            return self.value.and_then(to_val);
        }
        self.frames.iter().rev().find_map(|f| f.get(name)).and_then(to_val)
    }
    fn len(&self, name: &str) -> Option<usize> {
        match self.frames.iter().rev().find_map(|f| f.get(name))? {
            Value::Array(a) => Some(a.len()),
            Value::String(s) => Some(s.len()),
            _ => None,
        }
    }
}

fn eval_bool(e: &super::expr::Expr, frames: &[Map<String, Value>], value: Option<&Value>) -> Result<bool> {
    Ok(e.eval(&Frames { frames, value })?.truthy())
}

fn eval_count(e: &super::expr::Expr, frames: &[Map<String, Value>]) -> Result<usize> {
    let n = e.eval(&Frames { frames, value: None })?.num();
    if n < 0.0 || n.fract() != 0.0 {
        return Err(Error::Format(format!("count evaluated to {n}")));
    }
    Ok(n as usize)
}

/// f32 as the shortest decimal that reads back to the same bits. NaN and
/// infinities (JSON has no literal for them) keep their exact bits as a string.
fn f32_json(f: f32) -> Result<Value> {
    if !f.is_finite() {
        return Ok(Value::String(format!("f32:0x{:08x}", f.to_bits())));
    }
    let shortest: f64 = format!("{f}").parse().unwrap();
    Ok(Value::Number(Number::from_f64(shortest).unwrap()))
}

// ------------------------------------------------------------------ decode

struct Reader<'a> {
    d: &'a [u8],
    p: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let s = self.d.get(self.p..self.p + n).ok_or_else(|| Error::Format(format!("unexpected end of file at byte {}", self.p)))?;
        self.p += n;
        Ok(s)
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
}

struct Attempt<'v> {
    /// Variant name → value forced for this attempt.
    variants: &'v [(String, bool)],
    check_failures: Vec<String>,
    /// Variants whose forced value disagrees with their `prefer` expression.
    prefer_mismatches: usize,
}

fn read_prim(p: Prim, r: &mut Reader) -> Result<Value> {
    Ok(match p {
        Prim::U8 => Value::from(r.take(1)?[0]),
        Prim::U16 => Value::from(u16::from_le_bytes(r.take(2)?.try_into().unwrap())),
        Prim::U32 => Value::from(r.u32()?),
        Prim::I32 => Value::from(r.u32()? as i32),
        Prim::F32 => f32_json(f32::from_bits(r.u32()?))?,
        Prim::CString => {
            let rest = &r.d[r.p..];
            let n = rest.iter().position(|&b| b == 0).ok_or_else(|| Error::Format("unterminated string".into()))?;
            let s = crate::lossless::decode(&rest[..n]);
            r.p += n + 1;
            Value::String(s)
        }
        Prim::Char => {
            let b = r.take(1)?[0];
            if b == 0 {
                Value::String(String::new())
            } else if b.is_ascii_graphic() {
                Value::String((b as char).to_string())
            } else {
                return Err(Error::Format(format!("unexpected character byte {b}")));
            }
        }
        Prim::Id => serde_json::to_value(Id(r.take(4)?.try_into().unwrap())).unwrap(),
        Prim::Rgba => Value::Array(r.take(4)?.iter().map(|b| Value::from(*b)).collect()),
        Prim::Bytes(n) => Value::String(r.take(n)?.iter().map(|b| format!("{b:02x}")).collect()),
    })
}

/// The most items of a list of empty structs whose count comes from the file (a u32 in front, or an expression).
const MAX_EMPTY_ITEMS: usize = 1 << 16;

/// Reads one node's value. `frames` holds the enclosing objects.
fn read(node: &Node, r: &mut Reader, frames: &mut Vec<Map<String, Value>>, at: &mut Attempt) -> Result<Value> {
    match &node.kind {
        Kind::Prim(p) => {
            let v = read_prim(*p, r)?;
            if let Some(check) = &node.check {
                if !eval_bool(check, frames, Some(&v))? {
                    at.check_failures.push(format!("{} = {v}", node.name.as_deref().unwrap_or("item")));
                }
            }
            Ok(v)
        }
        Kind::Struct(fields) => {
            frames.push(Map::new());
            for f in fields {
                if let Some(cond) = &f.cond {
                    if !eval_bool(cond, frames, None)? {
                        continue;
                    }
                }
                let v = read(f, r, frames, at)?;
                frames.last_mut().unwrap().insert(f.name.clone().unwrap(), v);
            }
            Ok(Value::Object(frames.pop().unwrap()))
        }
        Kind::List(count, item) => {
            let n = match count {
                Count::Fixed(n) => *n,
                Count::PrefixU32 => r.u32()? as usize,
                Count::Expr(e) => eval_count(e, frames)?,
            };
            // Every item takes at least one byte (except empty structs), so a
            // count larger than the rest of the file is a misread, not a reason
            // to allocate gigabytes. Empty structs read nothing, so the bytes
            // left can't bound them, but a count from the file still asks for
            // that many values: they get a fixed limit instead.
            let empty = matches!(item.kind, Kind::Struct(ref f) if f.is_empty());
            if empty && !matches!(count, Count::Fixed(_)) && n > MAX_EMPTY_ITEMS {
                return Err(Error::Format(format!("count {n} of empty items exceeds {MAX_EMPTY_ITEMS}")));
            }
            if n > r.d.len() - r.p && !empty {
                return Err(Error::Format(format!("count {n} exceeds the remaining {} bytes", r.d.len() - r.p)));
            }
            let mut items = Vec::with_capacity(n);
            for _ in 0..n {
                items.push(read(item, r, frames, at)?);
            }
            Ok(Value::Array(items))
        }
        Kind::Variant { prefer } => {
            let name = node.name.as_deref().unwrap_or_default();
            let preferred = match prefer {
                Some(e) => eval_bool(e, frames, None)?,
                None => true,
            };
            let chosen = at.variants.iter().find(|(n, _)| n == name).map(|(_, v)| *v).unwrap_or(preferred);
            if chosen != preferred {
                at.prefer_mismatches += 1;
            }
            Ok(Value::Bool(chosen))
        }
    }
}

fn variant_names(nodes: &[Node], out: &mut Vec<String>) {
    for n in nodes {
        match &n.kind {
            Kind::Variant { .. } => {
                if let Some(name) = &n.name {
                    if !out.contains(name) {
                        out.push(name.clone());
                    }
                }
            }
            Kind::Struct(fields) => variant_names(fields, out),
            Kind::List(_, item) => variant_names(std::slice::from_ref(item.as_ref()), out),
            Kind::Prim(_) => {}
        }
    }
}

struct Outcome {
    value: Value,
    variants: Vec<(String, bool)>,
    check_failures: Vec<String>,
    prefer_mismatches: usize,
}

fn attempt(def: &Definition, bytes: &[u8], variants: &[(String, bool)]) -> Result<Outcome> {
    let mut r = Reader { d: bytes, p: 0 };
    let mut at = Attempt { variants, check_failures: Vec::new(), prefer_mismatches: 0 };
    let mut frames = vec![Map::new()];
    frames[0].insert("format".into(), Value::String(def.json_format.clone()));
    for f in &def.fields {
        if let Some(cond) = &f.cond {
            if !eval_bool(cond, &frames, None)? {
                continue;
            }
        }
        let v = read(f, &mut r, &mut frames, &mut at)?;
        frames[0].insert(f.name.clone().unwrap(), v);
    }
    if r.p != bytes.len() {
        return Err(Error::Format(format!("{} trailing bytes", bytes.len() - r.p)));
    }
    if let Some(accept) = &def.accept {
        if !eval_bool(accept, &frames, None)? {
            return Err(Error::Format(format!("not accepted by the {} definition", def.name)));
        }
    }
    Ok(Outcome {
        value: Value::Object(frames.pop().unwrap()),
        variants: variants.to_vec(),
        check_failures: at.check_failures,
        prefer_mismatches: at.prefer_mismatches,
    })
}

pub fn decode(def: &Definition, bytes: &[u8]) -> Result<Decoded> {
    let mut names = Vec::new();
    variant_names(&def.fields, &mut names);
    if names.len() > 8 {
        return Err(Error::Format("too many variants in definition (max 8)".into()));
    }
    let mut ok: Vec<Outcome> = Vec::new();
    let mut first_err = None;
    for mask in 0..(1u32 << names.len()) {
        let assignment: Vec<(String, bool)> = names.iter().enumerate().map(|(i, n)| (n.clone(), mask & (1 << i) != 0)).collect();
        match attempt(def, bytes, &assignment) {
            Ok(o) => ok.push(o),
            Err(e) => {
                first_err.get_or_insert(e);
            }
        }
    }
    if ok.is_empty() {
        return Err(first_err.unwrap_or_else(|| Error::Format("no reading fits".into())));
    }
    // Fewest failed checks first, then agreement with `prefer`.
    ok.sort_by_key(|o| (o.check_failures.len(), o.prefer_mismatches));
    // Different assignments can produce the same JSON when a variant's field
    // isn't reached; only genuinely different readings are alternatives.
    let best = ok.remove(0);
    let mut notes = Vec::new();
    let differing: Vec<&Outcome> = ok.iter().filter(|o| o.value != best.value).collect();
    let describe = |o: &Outcome| o.variants.iter().map(|(n, v)| format!("{n}={v}")).collect::<Vec<_>>().join(", ");
    if !names.is_empty() && !differing.is_empty() {
        let clean = differing.iter().filter(|o| o.check_failures.is_empty()).count();
        notes.push(format!(
            "variants {}: chosen; {} other reading(s) also fit the bytes{}",
            describe(&best),
            differing.len(),
            if clean > 0 && best.check_failures.is_empty() {
                format!(" ({clean} without failed checks — ambiguous)")
            } else {
                " but fail checks".into()
            }
        ));
    }
    if !best.check_failures.is_empty() {
        notes.push(format!("failed checks: {}", best.check_failures.join("; ")));
    }
    Ok(Decoded { value: best.value, notes })
}

// ------------------------------------------------------------------ encode

fn write_prim(p: Prim, v: &Value, out: &mut Vec<u8>, what: &str) -> Result<()> {
    let bad = || Error::Format(format!("{what}: {v} is not a valid {p:?}"));
    let int = |min: i64, max: i64| -> Result<i64> {
        let n = v.as_i64().ok_or_else(bad)?;
        if n < min || n > max {
            return Err(bad());
        }
        Ok(n)
    };
    match p {
        Prim::U8 => out.push(int(0, 255)? as u8),
        Prim::U16 => out.extend((int(0, u16::MAX as i64)? as u16).to_le_bytes()),
        Prim::U32 => out.extend((int(0, u32::MAX as i64)? as u32).to_le_bytes()),
        Prim::I32 => out.extend((int(i32::MIN as i64, i32::MAX as i64)? as i32).to_le_bytes()),
        Prim::F32 => {
            let bits = match v.as_str().and_then(|s| s.strip_prefix("f32:0x")) {
                Some(hex) => u32::from_str_radix(hex, 16).map_err(|_| bad())?,
                None => (v.as_f64().ok_or_else(bad)? as f32).to_bits(),
            };
            out.extend(bits.to_le_bytes());
        }
        Prim::CString => {
            let s = v.as_str().ok_or_else(bad)?;
            if s.contains('\0') {
                return Err(bad());
            }
            out.extend(crate::lossless::encode(s));
            out.push(0);
        }
        Prim::Char => match v.as_str().ok_or_else(bad)?.as_bytes() {
            [] => out.push(0),
            [b] => out.push(*b),
            _ => return Err(bad()),
        },
        Prim::Id => {
            let id: Id = serde_json::from_value(v.clone()).map_err(|_| bad())?;
            out.extend(id.0);
        }
        Prim::Rgba => {
            let a = v.as_array().filter(|a| a.len() == 4).ok_or_else(bad)?;
            for c in a {
                out.push(c.as_u64().filter(|c| *c <= 255).ok_or_else(bad)? as u8);
            }
        }
        Prim::Bytes(n) => {
            let s = v.as_str().filter(|s| s.len() == n * 2).ok_or_else(bad)?;
            for i in 0..n {
                out.push(u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).map_err(|_| bad())?);
            }
        }
    }
    Ok(())
}

fn write(node: &Node, v: &Value, out: &mut Vec<u8>, frames: &mut Vec<Map<String, Value>>, path: &str) -> Result<()> {
    match &node.kind {
        Kind::Prim(p) => write_prim(*p, v, out, path),
        Kind::Struct(fields) => {
            let obj = v.as_object().ok_or_else(|| Error::Format(format!("{path}: expected an object")))?;
            frames.push(obj.clone());
            for f in fields {
                let name = f.name.as_deref().unwrap();
                if let Some(cond) = &f.cond {
                    if !eval_bool(cond, frames, None)? {
                        continue;
                    }
                }
                let value = field_value(f, obj, frames, &format!("{path}.{name}"))?;
                // Make computed values (defaults, variants) visible to later conditions.
                frames.last_mut().unwrap().insert(name.to_string(), value.clone());
                write(f, &value, out, frames, &format!("{path}.{name}"))?;
            }
            frames.pop();
            Ok(())
        }
        Kind::List(count, item) => {
            let items = v.as_array().ok_or_else(|| Error::Format(format!("{path}: expected a list")))?;
            match count {
                Count::Fixed(n) if items.len() != *n => {
                    return Err(Error::Format(format!("{path}: needs exactly {n} items, has {}", items.len())));
                }
                Count::Expr(e) => {
                    let n = eval_count(e, frames)?;
                    if items.len() != n {
                        return Err(Error::Format(format!("{path}: needs {n} items, has {}", items.len())));
                    }
                }
                Count::PrefixU32 => out.extend((items.len() as u32).to_le_bytes()),
                Count::Fixed(_) => {}
            }
            for (i, it) in items.iter().enumerate() {
                write(item, it, out, frames, &format!("{path}[{i}]"))?;
            }
            Ok(())
        }
        Kind::Variant { .. } => Ok(()), // decides layout only; no bytes
    }
}

/// The JSON value for a field of `obj`, falling back to where older JSON had it (`was`), its default or `prefer`.
fn field_value(f: &Node, obj: &Map<String, Value>, frames: &[Map<String, Value>], path: &str) -> Result<Value> {
    if let Some(v) = obj.get(f.name.as_deref().unwrap_or_default()) {
        return Ok(v.clone());
    }
    if let Some((old, index)) = &f.was {
        let found = match (obj.get(old), index) {
            (Some(v), None) => Some(v),
            (Some(Value::Array(items)), Some(i)) => items.get(*i),
            (Some(v), Some(_)) => return Err(Error::Format(format!("{path}: the older field {old} is {v}, not a list"))),
            (None, _) => None,
        };
        if let Some(v) = found {
            return Ok(v.clone());
        }
    }
    if let Some(d) = &f.default {
        return Ok(d.clone());
    }
    if let Kind::Variant { prefer } = &f.kind {
        return Ok(Value::Bool(match prefer {
            Some(e) => eval_bool(e, frames, None)?,
            None => true,
        }));
    }
    Err(Error::Format(format!("{path} is missing")))
}

pub fn encode(def: &Definition, value: &Value) -> Result<Vec<u8>> {
    let obj = value.as_object().ok_or_else(|| Error::Format("expected a JSON object".into()))?;
    if obj.get("format").and_then(Value::as_str) != Some(def.json_format.as_str()) {
        return Err(Error::Format(format!("expected \"format\": \"{}\"", def.json_format)));
    }
    if let Some(accept) = &def.accept {
        if !eval_bool(accept, std::slice::from_ref(obj), None)? {
            return Err(Error::Format(format!("not accepted by the {} definition", def.name)));
        }
    }
    let mut out = Vec::new();
    let mut frames = vec![obj.clone()];
    for f in &def.fields {
        let name = f.name.as_deref().unwrap();
        if let Some(cond) = &f.cond {
            if !eval_bool(cond, &frames, None)? {
                continue;
            }
        }
        let v = field_value(f, obj, &frames, name)?;
        frames[0].insert(name.to_string(), v.clone());
        write(f, &v, &mut out, &mut frames, name)?;
    }
    Ok(out)
}
