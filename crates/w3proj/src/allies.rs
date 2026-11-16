//! The ally priorities the World Editor works out when it saves a map, applied at pack.
//!
//! The rule is the app's (`app/src/lib/terrain/startlocations.ts`, `editorAllyPriorities` and
//! `applyAllyPriorities`, found with we-drive saves and checked on the game's maps): unless the map
//! has "Modify ally priorities" on, each user player gets High for the user players whose start is
//! at most 1.25 times as far from its own as the nearest other user's start, Low up to 1.5 times,
//! and no enemy priorities. Computer and neutral players keep what they have. The app applies it
//! on its saves; a pack applies it too, so a map packed from a project whose masks went stale
//! (edited by hand, or by another tool) comes out as the World Editor's save would write it.

use serde_json::Value;

use crate::codec::Registry;
use crate::format::{decode, encode, Definition};

/// war3map.w3i flag: "Modify ally priorities" (the map keeps its own).
pub const MODIFY_ALLY_PRIORITIES: u64 = 0x0002;
/// A player slot a person plays (controller User).
const USER: u64 = 1;

/// The JSON format of map info (`formats/w3i.json`).
const MAPINFO_FORMAT: &str = "w3proj.mapinfo/1";

/// A number as the app reads it: a JSON number, else NaN (non-finite floats are strings in the
/// project's JSON, and `"f32:0x…" - x` is NaN there).
fn num(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// Gives the user players of a map info value (`w3proj.mapinfo/1`) the World Editor's ally
/// priorities and takes their enemy priorities away, when the Modify flag is off; the other players
/// keep theirs, and a file version without enemy priorities stays without. True when anything changed.
pub fn apply_ally_priorities(info: &mut Value) -> bool {
    let Some(flags) = info.get("flags").and_then(Value::as_u64) else { return false };
    if flags & MODIFY_ALLY_PRIORITIES != 0 {
        return false;
    }
    let Some(players) = info.get_mut("players").and_then(Value::as_array_mut) else { return false };
    // (index in the list, id, start) of the user players.
    let users: Vec<(usize, u64, f64, f64)> = players
        .iter()
        .enumerate()
        .filter(|(_, p)| p.get("controller").and_then(Value::as_u64) == Some(USER))
        .filter_map(|(i, p)| {
            let id = p.get("id").and_then(Value::as_u64).filter(|id| *id < 32)?;
            let start = p.get("start").and_then(Value::as_array);
            Some((i, id, num(start.and_then(|s| s.first())), num(start.and_then(|s| s.get(1)))))
        })
        .collect();
    let mut changed = false;
    for &(index, _, x, y) in &users {
        let others: Vec<(u64, f64)> = users
            .iter()
            .filter(|(j, ..)| *j != index)
            .map(|&(_, qid, qx, qy)| (qid, (qx - x).powi(2) + (qy - y).powi(2)))
            .collect();
        let (mut low, mut high) = (0u32, 0u32);
        if !others.is_empty() {
            // Math.min: NaN when any distance is NaN (f64::min would skip it).
            let nearest = others.iter().fold(f64::INFINITY, |m, &(_, d)| if d.is_nan() || m.is_nan() { f64::NAN } else { m.min(d) });
            // Squared distances: 1.25² and 1.5² are exact, so exactly 1.25 or 1.5 times counts.
            for &(qid, d) in &others {
                if d <= 1.5625 * nearest {
                    high |= 1 << qid;
                } else if d <= 2.25 * nearest {
                    low |= 1 << qid;
                }
            }
        }
        let Some(p) = players[index].as_object_mut() else { continue };
        for (key, want) in [("allyLow", low), ("allyHigh", high)] {
            if p.get(key).and_then(Value::as_u64) != Some(u64::from(want)) {
                p.insert(key.into(), Value::from(want));
                changed = true;
            }
        }
        for key in ["enemyLow", "enemyHigh"] {
            if p.get(key).is_some_and(|v| v.as_u64() != Some(0)) {
                p.insert(key.into(), Value::from(0u32));
                changed = true;
            }
        }
    }
    changed
}

/// The map info definition among the registry's codecs.
fn mapinfo_definition(codecs: &Registry) -> Option<&Definition> {
    codecs
        .for_archive_name("war3map.w3i")
        .filter_map(|c| c.as_format())
        .map(|f| f.def.as_ref())
        .find(|d| d.json_format == MAPINFO_FORMAT)
}

/// war3map.w3i bytes with the World Editor's ally priorities (`apply_ally_priorities`), or `None`
/// when they stay as they are: the masks already match, the Modify flag is on, or the file can't
/// be read back byte for byte (then nothing in it is touched).
pub fn pack_w3i(bytes: &[u8], codecs: &Registry) -> Option<Vec<u8>> {
    let def = mapinfo_definition(codecs)?;
    let mut value = decode(def, bytes).ok()?.value;
    if encode(def, &value).ok()?.as_slice() != bytes {
        return None;
    }
    if !apply_ally_priorities(&mut value) {
        return None;
    }
    encode(def, &value).ok()
}

/// The cases of the app's tests (`startlocations.test.ts`, we-drive saves v1-v9), so both carry the same rule.
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MELEE_FLAGS: u64 = 0x9c14;

    fn user(id: u32, x: f64, y: f64) -> Value {
        json!({ "id": id, "controller": 1, "race": 1, "fixedStart": 0, "name": format!("P{id}"), "start": [x, y],
                "allyLow": 0, "allyHigh": 0, "enemyLow": 0, "enemyHigh": 0 })
    }
    fn with(mut p: Value, more: Value) -> Value {
        for (k, v) in more.as_object().unwrap() {
            p[k] = v.clone();
        }
        p
    }
    fn info(flags: u64, players: Vec<Value>) -> Value {
        json!({ "flags": flags, "players": players })
    }
    fn ids(mask: &Value) -> Vec<u32> {
        let m = mask.as_u64().unwrap();
        (0..24).filter(|k| (m >> k) & 1 == 1).collect()
    }
    /// Each player's [low ids, high ids].
    fn masks(info: &Value) -> Vec<[Vec<u32>; 2]> {
        info["players"].as_array().unwrap().iter().map(|p| [ids(&p["allyLow"]), ids(&p["allyHigh"])]).collect()
    }
    fn v(list: &[(&[u32], &[u32])]) -> Vec<[Vec<u32>; 2]> {
        list.iter().map(|(l, h)| [l.to_vec(), h.to_vec()]).collect()
    }

    #[test]
    fn exactly_1_25_is_high_and_exactly_1_5_low() {
        let mut i = info(MELEE_FLAGS, vec![
            user(0, 0.0, 0.0),
            with(user(1, 0.0, 1280.0), json!({ "allyLow": 4, "enemyHigh": 1 })),
            user(2, 0.0, -1600.0),
            user(3, 1920.0, 0.0),
        ]);
        assert!(apply_ally_priorities(&mut i));
        assert_eq!(masks(&i), v(&[(&[3], &[1, 2]), (&[], &[0]), (&[], &[0]), (&[2], &[0, 1])]));
        assert_eq!(i["players"][1]["enemyHigh"], json!(0), "the editor takes enemy priorities away");
        assert!(!apply_ally_priorities(&mut i), "a second save changes nothing");
    }

    #[test]
    fn just_inside_and_outside_the_bounds() {
        let r = 1280.0;
        let d45 = |k: f64| k * r / std::f64::consts::SQRT_2;
        let mut i = info(MELEE_FLAGS, vec![
            user(0, 0.0, 0.0),
            user(1, 0.0, r),
            user(2, 0.0, -1.24 * r),
            user(3, 1.26 * r, 0.0),
            user(4, -1.495 * r, 0.0),
            user(5, d45(1.505), -d45(1.505)),
        ]);
        apply_ally_priorities(&mut i);
        assert_eq!(
            masks(&i),
            v(&[(&[3, 4], &[1, 2]), (&[], &[0]), (&[], &[0, 5]), (&[1], &[0, 5]), (&[2], &[0, 1]), (&[0], &[2, 3])])
        );
    }

    #[test]
    fn computers_are_left_out_and_modify_keeps_the_maps_own() {
        let mut square = info(0x9c54, vec![
            user(0, -1600.0, -1600.0),
            user(1, 1600.0, -1600.0),
            user(2, 1600.0, 1600.0),
            user(3, -1600.0, 1600.0),
        ]);
        apply_ally_priorities(&mut square);
        assert_eq!(masks(&square), v(&[(&[2], &[1, 3]), (&[3], &[0, 2]), (&[0], &[1, 3]), (&[1], &[0, 2])]));
        let mut computer = info(MELEE_FLAGS, vec![
            user(0, 0.0, 0.0),
            with(user(1, 0.0, 1280.0), json!({ "controller": 2, "allyLow": 5, "enemyLow": 1 })),
            user(2, 0.0, -1500.0),
        ]);
        apply_ally_priorities(&mut computer);
        assert_eq!(masks(&computer), v(&[(&[], &[2]), (&[0, 2], &[]), (&[], &[0])]));
        assert_eq!(computer["players"][1]["enemyLow"], json!(1));
        let mut own = info(MELEE_FLAGS | MODIFY_ALLY_PRIORITIES, vec![
            with(user(0, 0.0, 0.0), json!({ "allyLow": 2 })),
            user(1, 0.0, 1280.0),
            user(2, 0.0, -1400.0),
        ]);
        assert!(!apply_ally_priorities(&mut own));
        assert_eq!(masks(&own), v(&[(&[1], &[]), (&[], &[]), (&[], &[])]));
    }

    #[test]
    fn a_lone_player_has_none_and_old_versions_get_no_enemy_fields() {
        let mut alone = info(MELEE_FLAGS, vec![with(user(0, 0.0, 0.0), json!({ "allyHigh": 2 }))]);
        apply_ally_priorities(&mut alone);
        assert_eq!(masks(&alone), v(&[(&[], &[])]));
        let old = |id, y| {
            let mut p = user(id, 0.0, y);
            p.as_object_mut().unwrap().retain(|k, _| !k.starts_with("enemy"));
            p
        };
        let mut i = info(MELEE_FLAGS, vec![old(0, 0.0), old(1, 640.0)]);
        apply_ally_priorities(&mut i);
        assert_eq!(masks(&i), v(&[(&[], &[1]), (&[], &[0])]));
        assert!(i["players"][0].get("enemyLow").is_none());
    }

    #[test]
    fn a_start_that_is_no_number_gives_nothing() {
        // As in the app: NaN distances count for nothing, and make the nearest NaN (Math.min).
        let mut i = info(MELEE_FLAGS, vec![
            with(user(0, 0.0, 0.0), json!({ "allyHigh": 6 })),
            with(user(1, 0.0, 0.0), json!({ "start": ["f32:0x7fc00000", 0.0] })),
            user(2, 0.0, 640.0),
        ]);
        apply_ally_priorities(&mut i);
        assert_eq!(masks(&i), v(&[(&[], &[]), (&[], &[]), (&[], &[])]));
    }

    /// The mini map's war3map.w3i as the archive holds it, with `players` and `flags` set.
    fn mini_w3i(codecs: &Registry, flags: u64, players: Vec<Value>) -> Vec<u8> {
        let text = include_str!("../../../tests/fixtures/mini-map/map/war3map.w3i.json");
        let mut value: Value = serde_json::from_str(text).unwrap();
        value["flags"] = json!(flags);
        value["players"] = Value::Array(players);
        encode(mapinfo_definition(codecs).unwrap(), &value).unwrap()
    }

    #[test]
    fn pack_replaces_stale_masks_and_leaves_matching_ones_byte_for_byte() {
        let codecs = Registry::with_formats(&[]).unwrap();
        let def = mapinfo_definition(&codecs).unwrap();
        let stale = mini_w3i(&codecs, MELEE_FLAGS, vec![
            with(user(0, 0.0, 0.0), json!({ "allyLow": 2, "enemyLow": 4 })),
            user(1, 0.0, 1280.0),
            with(user(2, 0.0, -1600.0), json!({ "controller": 2, "allyHigh": 3 })),
        ]);
        let packed = pack_w3i(&stale, &codecs).expect("stale masks are worked out anew");
        let back = decode(def, &packed).unwrap().value;
        assert_eq!(masks(&back), v(&[(&[], &[1]), (&[], &[0]), (&[], &[0, 1])]), "the computer keeps its own");
        assert_eq!(back["players"][0]["enemyLow"], json!(0));
        assert_eq!(pack_w3i(&packed, &codecs), None, "masks that match stay as they are");
    }

    #[test]
    fn pack_leaves_a_map_with_modify_ally_priorities_alone() {
        let codecs = Registry::with_formats(&[]).unwrap();
        let own = mini_w3i(&codecs, MELEE_FLAGS | MODIFY_ALLY_PRIORITIES, vec![
            with(user(0, 0.0, 0.0), json!({ "allyLow": 2, "enemyLow": 4 })),
            user(1, 0.0, 1280.0),
        ]);
        assert_eq!(pack_w3i(&own, &codecs), None);
    }

    #[test]
    fn pack_leaves_unreadable_info_alone() {
        let codecs = Registry::with_formats(&[]).unwrap();
        let stale = mini_w3i(&codecs, MELEE_FLAGS, vec![with(user(0, 0.0, 0.0), json!({ "allyHigh": 1 })), user(1, 0.0, 64.0)]);
        assert!(pack_w3i(&stale, &codecs).is_some());
        // Trailing bytes the definition doesn't read: it doesn't come back byte for byte, so it isn't touched.
        let mut odd = stale.clone();
        odd.extend_from_slice(b"tail");
        assert_eq!(pack_w3i(&odd, &codecs), None);
        assert_eq!(pack_w3i(&stale[..stale.len() / 2], &codecs), None);
        assert_eq!(pack_w3i(&[], &codecs), None);
    }
}
