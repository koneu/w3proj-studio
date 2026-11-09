//! `.w3o`: all of a map's object data in one file, what the World Editor's Export All Object Data
//! writes and Import All Object Data reads.
//!
//! Layout, as documented by the modding community and confirmed by files Blizzard's own World Editor
//! wrote: the game's Reforged campaign AI files `Scripts/reforged_u05_navy.wai`,
//! `reforged_u08_blue.wai`, `reforged_u08_red.wai`, `reforged_u08_teal.wai` and `u05_mint.wai` (in
//! `War3.w3mod`) carry, after the AI's documented end, the path of the `.w3o` they were made with, its
//! date, and then that `.w3o` (see `embeddedObjectData` in `app/src/lib/ai/wai.ts`). All five read
//! with [`unpack`] to the end of the file (units, items, destructables, doodads and abilities present,
//! buffs and upgrades flagged absent) and [`pack`] gives the same bytes back (checked 2026-11-09):
//! ```text
//! u32 version (1)
//! for each kind in KINDS order (units, items, destructables, doodads, abilities, buffs, upgrades):
//!     u32 present (0 or 1), and if 1 the kind's object file, as in war3map.w3u and the like
//! ```
//!
//! The export folds each object's fields from the map's `war3mapSkin.w3?` file (names, models, art,
//! tooltips) into its entry. Where Reforged's editor puts those fields in a `.w3o` is **not verified**.

use crate::objdata;
use crate::{Error, Result};

/// The kinds in file order.
pub const KINDS: [&str; 7] = ["w3u", "w3t", "w3b", "w3d", "w3a", "w3h", "w3q"];
pub const VERSION: u32 = 1;

/// Puts object files together. `parts` are (kind, the kind's binary object file); a kind may come
/// once, and each file is read first, so what can't be read back isn't written.
pub fn pack(parts: &[(String, Vec<u8>)]) -> Result<Vec<u8>> {
    for (i, (kind, bytes)) in parts.iter().enumerate() {
        if !KINDS.contains(&kind.as_str()) {
            return Err(Error::Format(format!("{kind} is not an object data kind")));
        }
        if parts[..i].iter().any(|(k, _)| k == kind) {
            return Err(Error::Format(format!("{kind} is given twice")));
        }
        let opt = objdata::kind(kind).unwrap_or(false);
        objdata::decode(bytes, opt).map_err(|e| Error::Format(format!("{kind}: {e}")))?;
    }
    let mut out = VERSION.to_le_bytes().to_vec();
    for kind in KINDS {
        match parts.iter().find(|(k, _)| k == kind) {
            Some((_, bytes)) => {
                out.extend(1u32.to_le_bytes());
                out.extend(bytes);
            }
            None => out.extend(0u32.to_le_bytes()),
        }
    }
    Ok(out)
}

/// Takes a `.w3o` apart into (kind, binary object file) in file order; kinds it lacks are left out.
pub fn unpack(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>> {
    let word = |at: usize| -> Result<u32> {
        let b = bytes.get(at..at + 4).ok_or_else(|| Error::Format("unexpected end of object data file".into()))?;
        Ok(u32::from_le_bytes(b.try_into().unwrap()))
    };
    let version = word(0)?;
    if version != VERSION {
        return Err(Error::Format(format!("unsupported .w3o version {version}")));
    }
    let mut at = 4;
    let mut out = Vec::new();
    for kind in KINDS {
        match word(at)? {
            0 => at += 4,
            1 => {
                at += 4;
                let opt = objdata::kind(kind).unwrap_or(false);
                let (_, used) = objdata::decode_prefix(&bytes[at..], opt).map_err(|e| Error::Format(format!("{kind}: {e}")))?;
                out.push((kind.to_string(), bytes[at..at + used].to_vec()));
                at += used;
            }
            n => return Err(Error::Format(format!("{kind}: presence flag {n}"))),
        }
    }
    if at != bytes.len() {
        return Err(Error::Format("trailing bytes after the object data".into()));
    }
    Ok(out)
}

/// The same from the project's JSON form of each kind's object data (`w3proj.objects/1`).
pub fn pack_json(parts: &[(String, String)]) -> Result<Vec<u8>> {
    let mut binary = Vec::new();
    for (kind, text) in parts {
        let opt = objdata::kind(kind).ok_or_else(|| Error::Format(format!("{kind} is not an object data kind")))?;
        binary.push((kind.clone(), objdata::from_json(text.as_bytes(), opt).map_err(|e| Error::Format(format!("{kind}: {e}")))?));
    }
    pack(&binary)
}

/// A `.w3o` as the project's JSON of each kind it holds.
pub fn unpack_json(bytes: &[u8]) -> Result<Vec<(String, String)>> {
    unpack(bytes)?
        .into_iter()
        .map(|(kind, file)| {
            let opt = objdata::kind(&kind).unwrap_or(false);
            let json = objdata::to_json(&file, opt)?;
            String::from_utf8(json).map(|t| (kind, t)).map_err(|e| Error::Format(e.to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_round_trip_keeps_every_kind_and_its_values() {
        let bin = parts(&["w3u", "w3a", "w3t"]);
        let packed = pack(&bin).unwrap();
        let json = unpack_json(&packed).unwrap();
        assert_eq!(json.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["w3u", "w3t", "w3a"]);
        assert!(json.iter().all(|(_, t)| t.contains("\"id\": \"h000\"") && t.contains("w3proj.objects/1")));
        assert_eq!(pack_json(&json).unwrap(), packed);
        assert!(pack_json(&[("w3x".into(), "{}".into())]).is_err());
        assert!(pack_json(&[("w3u".into(), "not json".into())]).is_err());
    }

    /// A tiny object file of the kind: version 3, no standard objects, one custom (hfoo -> h000, no mods).
    fn file(version: u32) -> Vec<u8> {
        let mut b = version.to_le_bytes().to_vec();
        b.extend(0u32.to_le_bytes());
        b.extend(1u32.to_le_bytes());
        b.extend(b"hfoo");
        b.extend(b"h000");
        if version >= 3 {
            b.extend(1u32.to_le_bytes());
            b.extend(0u32.to_le_bytes());
        }
        b.extend(0u32.to_le_bytes());
        b
    }

    fn parts(kinds: &[&str]) -> Vec<(String, Vec<u8>)> {
        kinds.iter().map(|k| (k.to_string(), file(if *k == "w3t" { 1 } else { 3 }))).collect()
    }

    #[test]
    fn layout_is_version_then_a_flag_per_kind_in_order() {
        let packed = pack(&parts(&["w3t", "w3q"])).unwrap();
        let mut want = 1u32.to_le_bytes().to_vec();
        for kind in KINDS {
            match kind {
                "w3t" => {
                    want.extend(1u32.to_le_bytes());
                    want.extend(file(1));
                }
                "w3q" => {
                    want.extend(1u32.to_le_bytes());
                    want.extend(file(3));
                }
                _ => want.extend(0u32.to_le_bytes()),
            }
        }
        assert_eq!(packed, want);
    }

    #[test]
    fn unpack_gives_back_what_was_packed_in_file_order() {
        let all = parts(&["w3q", "w3u", "w3d", "w3a"]);
        let back = unpack(&pack(&all).unwrap()).unwrap();
        let kinds: Vec<_> = back.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(kinds, ["w3u", "w3d", "w3a", "w3q"]);
        for (k, bytes) in &back {
            assert_eq!(bytes, &all.iter().find(|(a, _)| a == k).unwrap().1);
        }
        assert!(unpack(&pack(&[]).unwrap()).unwrap().is_empty());
        assert_eq!(pack(&[]).unwrap().len(), 4 + 7 * 4);
    }

    #[test]
    fn bad_input_is_an_error() {
        assert!(pack(&[("w3x".into(), file(3))]).is_err());
        assert!(pack(&[("w3u".into(), file(3)), ("w3u".into(), file(3))]).is_err());
        assert!(pack(&[("w3u".into(), vec![1, 2, 3])]).is_err());
        let mut trailing = file(3);
        trailing.push(0);
        assert!(pack(&[("w3u".into(), trailing)]).is_err(), "a file with bytes after it");
        let good = pack(&parts(&["w3u"])).unwrap();
        assert!(unpack(&good[..good.len() - 1]).is_err(), "cut off");
        let mut more = good.clone();
        more.push(0);
        assert!(unpack(&more).is_err(), "trailing");
        let mut version = good.clone();
        version[0] = 2;
        assert!(unpack(&version).is_err());
        let mut flag = good;
        flag[4] = 2;
        assert!(unpack(&flag).is_err());
        assert!(unpack(&[]).is_err());
    }
}
