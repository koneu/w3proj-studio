//! Object data (`.w3u .w3t .w3b .w3d .w3a .w3h .w3q`) ⇄ JSON.
//!
//! Binary layout (versions 1–3):
//! ```text
//! u32 version
//! table original, table custom
//! table  := u32 count, object[count]
//! object := id base, id new, (v3: u32 sets, {u32 flag, u32 n, mod[n]}[sets] | u32 n, mod[n])
//! mod    := id field, u32 type, (w3d/w3a/w3q: u32 level, u32 data), value, id end
//! value  := i32 | f32 | f32 | cstring        (type 0 int, 1 real, 2 unreal, 3 string)
//! ```

use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

use crate::{Error, Result};

pub const FORMAT: &str = "w3proj.objects/1";

/// Returns whether `name` is object data, and if so whether its mods carry
/// the level/data fields.
pub fn kind(name: &str) -> Option<bool> {
    let ext = name.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "w3u" | "w3t" | "w3b" | "w3h" => Some(false),
        "w3d" | "w3a" | "w3q" => Some(true),
        _ => None,
    }
}

/// A four-byte id. Printable ids serialise as text ("hfoo"), others as hex
/// ("0x00000000", bytes in file order).
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct Id(pub [u8; 4]);

impl Id {
    fn is_zero(&self) -> bool {
        self.0 == [0; 4]
    }
}

impl Serialize for Id {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        if self.0.iter().all(|b| (0x20..0x7F).contains(b)) {
            s.serialize_str(std::str::from_utf8(&self.0).unwrap())
        } else {
            let hex: String = self.0.iter().map(|b| format!("{b:02x}")).collect();
            s.serialize_str(&format!("0x{hex}"))
        }
    }
}

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        let b = s.as_bytes();
        if b.len() == 4 {
            return Ok(Id(b.try_into().unwrap()));
        }
        if b.len() == 10 && s.starts_with("0x") {
            let mut out = [0u8; 4];
            for (i, o) in out.iter_mut().enumerate() {
                *o = u8::from_str_radix(&s[2 + i * 2..4 + i * 2], 16)
                    .map_err(serde::de::Error::custom)?;
            }
            return Ok(Id(out));
        }
        Err(serde::de::Error::custom(format!("invalid id {s:?}")))
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ValueType {
    Int,
    Real,
    Unreal,
    String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Mod {
    pub field: Id,
    #[serde(rename = "type")]
    pub ty: ValueType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<u32>,
    #[serde(serialize_with = "ser_value")]
    pub value: Value,
    /// Only when it differs from the object's `end`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<Id>,
}

/// Reals are written as f32 so JSON shows the shortest exact form (0.1, not
/// 0.10000000149011612).
fn ser_value<S: Serializer>(v: &Value, s: S) -> std::result::Result<S::Ok, S::Error> {
    match v {
        Value::Number(n) if n.is_f64() => s.serialize_f32(n.as_f64().unwrap() as f32),
        other => other.serialize(s),
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Set {
    pub flag: u32,
    pub mods: Vec<Mod>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Object {
    pub base: Id,
    #[serde(default, skip_serializing_if = "Id::is_zero")]
    pub id: Id,
    /// Default end token of this object's mods (older files repeat the
    /// object id after every mod).
    #[serde(default, skip_serializing_if = "Id::is_zero")]
    pub end: Id,
    /// Present for v3 files with anything but a single flag-0 set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sets: Option<Vec<Set>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mods: Option<Vec<Mod>>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ObjectFile {
    pub format: String,
    pub version: u32,
    pub original: Vec<Object>,
    pub custom: Vec<Object>,
}

struct Reader<'a> {
    d: &'a [u8],
    p: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let s = self
            .d
            .get(self.p..self.p + n)
            .ok_or_else(|| Error::Format("unexpected end of object data".into()))?;
        self.p += n;
        Ok(s)
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn id(&mut self) -> Result<Id> {
        Ok(Id(self.take(4)?.try_into().unwrap()))
    }
    fn cstr(&mut self) -> Result<String> {
        let rest = &self.d[self.p..];
        let n = rest
            .iter()
            .position(|&b| b == 0)
            .ok_or_else(|| Error::Format("unterminated string".into()))?;
        let s = crate::lossless::decode(&rest[..n]);
        self.p += n + 1;
        Ok(s)
    }
}

fn read_mods(r: &mut Reader, opt_ints: bool) -> Result<Vec<Mod>> {
    let n = r.u32()?;
    let mut mods = Vec::with_capacity(n.min(4096) as usize);
    for _ in 0..n {
        let field = r.id()?;
        let ty = match r.u32()? {
            0 => ValueType::Int,
            1 => ValueType::Real,
            2 => ValueType::Unreal,
            3 => ValueType::String,
            t => return Err(Error::Format(format!("unknown value type {t}"))),
        };
        let (level, data) = if opt_ints {
            (Some(r.u32()?), Some(r.u32()?))
        } else {
            (None, None)
        };
        let value = match ty {
            ValueType::Int => Value::from(r.u32()? as i32),
            ValueType::Real | ValueType::Unreal => {
                let f = f32::from_bits(r.u32()?);
                if !f.is_finite() {
                    return Err(Error::Format("non-finite real".into()));
                }
                Value::from(f as f64)
            }
            ValueType::String => Value::from(r.cstr()?),
        };
        let end = Some(r.id()?);
        mods.push(Mod {
            field,
            ty,
            level,
            data,
            value,
            end,
        });
    }
    Ok(mods)
}

pub fn decode(bytes: &[u8], opt_ints: bool) -> Result<ObjectFile> {
    let mut r = Reader { d: bytes, p: 0 };
    let version = r.u32()?;
    if !(1..=3).contains(&version) {
        return Err(Error::Format(format!("unsupported object data version {version}")));
    }
    let mut tables = Vec::new();
    for _ in 0..2 {
        let n = r.u32()?;
        let mut objs = Vec::with_capacity(n.min(65536) as usize);
        for _ in 0..n {
            let base = r.id()?;
            let id = r.id()?;
            let (sets, mods) = if version >= 3 {
                let count = r.u32()?;
                let mut sets = Vec::new();
                for _ in 0..count {
                    let flag = r.u32()?;
                    sets.push(Set {
                        flag,
                        mods: read_mods(&mut r, opt_ints)?,
                    });
                }
                if sets.len() == 1 && sets[0].flag == 0 {
                    (None, Some(sets.pop().unwrap().mods))
                } else {
                    (Some(sets), None)
                }
            } else {
                (None, Some(read_mods(&mut r, opt_ints)?))
            };
            let mut obj = Object {
                base,
                id,
                end: Id::default(),
                sets,
                mods,
            };
            hoist_end(&mut obj);
            objs.push(obj);
        }
        tables.push(objs);
    }
    if r.p != bytes.len() {
        return Err(Error::Format("trailing bytes after object data".into()));
    }
    let custom = tables.pop().unwrap();
    let original = tables.pop().unwrap();
    Ok(ObjectFile {
        format: FORMAT.into(),
        version,
        original,
        custom,
    })
}

/// Moves the most common end token to the object and drops it from mods
/// that match.
fn hoist_end(obj: &mut Object) {
    let all: Vec<&mut Mod> = match (&mut obj.sets, &mut obj.mods) {
        (Some(sets), _) => sets.iter_mut().flat_map(|s| s.mods.iter_mut()).collect(),
        (None, Some(mods)) => mods.iter_mut().collect(),
        (None, None) => Vec::new(),
    };
    let mut counts: Vec<(Id, usize)> = Vec::new();
    for m in &all {
        let e = m.end.unwrap_or_default();
        match counts.iter_mut().find(|(id, _)| *id == e) {
            Some(c) => c.1 += 1,
            None => counts.push((e, 1)),
        }
    }
    let common = counts
        .iter()
        .fold(None::<(Id, usize)>, |best, &(id, n)| match best {
            Some((_, bn)) if bn >= n => best,
            _ => Some((id, n)),
        })
        .map(|(id, _)| id)
        .unwrap_or_default();
    obj.end = common;
    for m in all {
        if m.end == Some(common) {
            m.end = None;
        }
    }
}

fn write_mods(out: &mut Vec<u8>, mods: &[Mod], end: Id, opt_ints: bool) -> Result<()> {
    out.extend((mods.len() as u32).to_le_bytes());
    for m in mods {
        out.extend(m.field.0);
        let (code, err) = match m.ty {
            ValueType::Int => (0u32, "int"),
            ValueType::Real => (1, "real"),
            ValueType::Unreal => (2, "unreal"),
            ValueType::String => (3, "string"),
        };
        out.extend(code.to_le_bytes());
        if opt_ints {
            out.extend(m.level.unwrap_or(0).to_le_bytes());
            out.extend(m.data.unwrap_or(0).to_le_bytes());
        }
        let bad = || Error::Format(format!("field {:?}: value is not a valid {err}", m.field));
        match m.ty {
            ValueType::Int => {
                let v = m.value.as_i64().ok_or_else(bad)?;
                let v = i32::try_from(v).map_err(|_| bad())?;
                out.extend(v.to_le_bytes());
            }
            ValueType::Real | ValueType::Unreal => {
                let v = m.value.as_f64().ok_or_else(bad)? as f32;
                out.extend(v.to_bits().to_le_bytes());
            }
            ValueType::String => {
                out.extend(crate::lossless::encode(m.value.as_str().ok_or_else(bad)?));
                out.push(0);
            }
        }
        out.extend(m.end.unwrap_or(end).0);
    }
    Ok(())
}

pub fn encode(file: &ObjectFile, opt_ints: bool) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    out.extend(file.version.to_le_bytes());
    for table in [&file.original, &file.custom] {
        out.extend((table.len() as u32).to_le_bytes());
        for o in table {
            out.extend(o.base.0);
            out.extend(o.id.0);
            let empty = Vec::new();
            if file.version >= 3 {
                match (&o.sets, &o.mods) {
                    (Some(sets), _) => {
                        out.extend((sets.len() as u32).to_le_bytes());
                        for s in sets {
                            out.extend(s.flag.to_le_bytes());
                            write_mods(&mut out, &s.mods, o.end, opt_ints)?;
                        }
                    }
                    (None, mods) => {
                        out.extend(1u32.to_le_bytes());
                        out.extend(0u32.to_le_bytes());
                        write_mods(&mut out, mods.as_ref().unwrap_or(&empty), o.end, opt_ints)?;
                    }
                }
            } else {
                if o.sets.is_some() {
                    return Err(Error::Format("sets require object data version 3".into()));
                }
                write_mods(&mut out, o.mods.as_ref().unwrap_or(&empty), o.end, opt_ints)?;
            }
        }
    }
    Ok(out)
}

pub fn to_json(bytes: &[u8], opt_ints: bool) -> Result<Vec<u8>> {
    let file = decode(bytes, opt_ints)?;
    let mut out = serde_json::to_vec_pretty(&file).map_err(|e| Error::Format(e.to_string()))?;
    out.push(b'\n');
    Ok(out)
}

pub fn from_json(json: &[u8], opt_ints: bool) -> Result<Vec<u8>> {
    let file: ObjectFile =
        serde_json::from_slice(json).map_err(|e| Error::Format(format!("invalid JSON: {e}")))?;
    encode(&file, opt_ints)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(version: u32, opt: bool) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend(version.to_le_bytes());
        b.extend(0u32.to_le_bytes()); // no original objects
        b.extend(1u32.to_le_bytes());
        b.extend(b"hfoo");
        b.extend(b"h000");
        if version >= 3 {
            b.extend(1u32.to_le_bytes());
            b.extend(0u32.to_le_bytes());
        }
        b.extend(2u32.to_le_bytes());
        b.extend(b"unam");
        b.extend(3u32.to_le_bytes());
        if opt {
            b.extend(1u32.to_le_bytes());
            b.extend(0u32.to_le_bytes());
        }
        b.extend(b"Footman Captain\0");
        b.extend([0u8; 4]);
        b.extend(b"usca");
        b.extend(1u32.to_le_bytes());
        if opt {
            b.extend(1u32.to_le_bytes());
            b.extend(0u32.to_le_bytes());
        }
        b.extend(1.1f32.to_bits().to_le_bytes());
        b.extend(b"h000");
        b
    }

    #[test]
    fn roundtrip_all_versions() {
        for v in 1..=3 {
            for opt in [false, true] {
                let bin = sample(v, opt);
                let json = to_json(&bin, opt).unwrap();
                let text = String::from_utf8(json.clone()).unwrap();
                assert!(text.contains("\"value\": 1.1"), "{text}");
                assert_eq!(from_json(&json, opt).unwrap(), bin, "v{v} opt={opt}");
            }
        }
    }
}
