//! The ally priorities the World Editor works out when it saves a map, applied at pack.
//!
//! The rule is the app's (`app/src/lib/terrain/startlocations.ts`, `editorAllyPriorities` and
//! `applyAllyPriorities`, found with we-drive saves and checked on the game's maps): unless the map
//! has "Modify ally priorities" on, each user player gets High for the user players whose start is
//! at most 1.25 times as far from its own as the nearest other user's start, Low up to 1.5 times,
//! and no enemy priorities. Computer and neutral players keep what they have. The app applies it
//! on its saves; a pack applies it too, so a map packed from a project whose masks went stale
//! (edited by hand, or by another tool) comes out as the World Editor's save would write it.
//!
//! The map script isn't made again here: masks only come out different when the start locations,
//! controllers or players changed (or "Modify ally priorities" went off), and those go into the
//! rest of the script too (DefineStartLocation, SetPlayerController, …), which only the app's
//! generator writes (`w3proj pack` runs it first for a script Studio wrote, crates/cli rebuild.rs
//! `script_for_pack`). So a pack tells when the script's InitAllyPriorities doesn't set the
//! priorities it worked out (`script_agrees`).

use std::collections::BTreeSet;

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

/// One start location priority of a map script: (enemy, player index, the other player's index,
/// low). Indices are positions in war3map.w3i's player list, as `SetStartLocPrio` takes them.
type Priority = (bool, usize, usize, bool);

/// Whether a map script sets the ally priorities of a war3map.w3i (`script_agrees`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptPriorities {
    Agree,
    Disagree,
    /// InitAllyPriorities has a line this doesn't read: it can't be told.
    Unknown,
}

/// The priorities the app's generator writes into InitAllyPriorities for these masks
/// (`app/src/lib/script/setup.ts` playersSection): for each player, the others whose id bit is in
/// low | high, LOW when the low mask has it; ids no player has count for nothing.
fn mask_priorities(info: &Value) -> BTreeSet<Priority> {
    let players = info.get("players").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let ids: Vec<Option<u64>> = players.iter().map(|p| p.get("id").and_then(Value::as_u64)).collect();
    let mask = |p: &Value, key: &str| p.get(key).and_then(Value::as_u64).unwrap_or(0);
    let mut out = BTreeSet::new();
    for (index, p) in players.iter().enumerate() {
        for (enemy, low_key, high_key) in [(false, "allyLow", "allyHigh"), (true, "enemyLow", "enemyHigh")] {
            let (low, high) = (mask(p, low_key), mask(p, high_key));
            for (other, id) in ids.iter().enumerate() {
                let Some(id) = id.filter(|id| *id < 64) else { continue };
                if other != index && ((low | high) >> id) & 1 == 1 {
                    out.insert((enemy, index, other, (low >> id) & 1 == 1));
                }
            }
        }
    }
    out
}

/// The priorities a map script's InitAllyPriorities sets (war3map.j or war3map.lua; none when it
/// has no such function), or `None` when it has a line this doesn't read.
fn script_priorities(script: &str) -> Option<BTreeSet<Priority>> {
    let mut out = BTreeSet::new();
    let mut lines = script.lines().map(str::trim);
    let starts = |l: &str| {
        l.strip_prefix("function InitAllyPriorities").is_some_and(|rest| !rest.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_'))
    };
    if !lines.any(starts) {
        return Some(out);
    }
    for line in lines {
        // JASS ends it with endfunction, Lua with end.
        if line == "endfunction" || line == "end" {
            return Some(out);
        }
        if line.is_empty() || line.starts_with("//") || line.starts_with("--") {
            continue;
        }
        let call = line.strip_prefix("call ").unwrap_or(line);
        let (name, rest) = call.split_once('(')?;
        let args: Vec<&str> = rest.strip_suffix(')')?.split(',').map(str::trim).collect();
        let enemy = match name.trim() {
            "SetStartLocPrioCount" | "SetEnemyStartLocPrioCount" => continue,
            "SetStartLocPrio" => false,
            "SetEnemyStartLocPrio" => true,
            _ => return None,
        };
        let [index, _, other, prio] = args.as_slice() else { return None };
        let low = match *prio {
            "MAP_LOC_PRIO_LOW" => true,
            "MAP_LOC_PRIO_HIGH" => false,
            "MAP_LOC_PRIO_NONE" => continue,
            _ => return None,
        };
        out.insert((enemy, index.parse().ok()?, other.parse().ok()?, low));
    }
    // No end: not a function this reads.
    None
}

/// Whether a map script's InitAllyPriorities sets the ally priorities of war3map.w3i bytes. A pack
/// works them out anew in war3map.w3i (`pack_w3i`) but can't make the script again (only the app's
/// generator can), so it tells.
pub fn script_agrees(w3i: &[u8], script: &[u8], codecs: &Registry) -> ScriptPriorities {
    let Some(info) = mapinfo_definition(codecs).and_then(|def| decode(def, w3i).ok()) else { return ScriptPriorities::Unknown };
    match script_priorities(&String::from_utf8_lossy(script)) {
        None => ScriptPriorities::Unknown,
        Some(set) if set == mask_priorities(&info.value) => ScriptPriorities::Agree,
        Some(_) => ScriptPriorities::Disagree,
    }
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

    /// InitAllyPriorities as the app's generator (setup.ts playersSection) writes it for players 0
    /// and 1 at the mini map's starts: 0 has 1 as High, 1 has 0 as High.
    const JASS: &str = "function InitCustomTeams takes nothing returns nothing\r\nendfunction\r\n\r\n\
        function InitAllyPriorities takes nothing returns nothing\r\n\r\n\
        \x20   call SetStartLocPrioCount( 0, 1 )\r\n    call SetStartLocPrio( 0, 0, 1, MAP_LOC_PRIO_HIGH )\r\n\r\n\
        \x20   call SetStartLocPrioCount( 1, 1 )\r\n    call SetStartLocPrio( 1, 0, 0, MAP_LOC_PRIO_HIGH )\r\nendfunction\r\n\r\n\
        function config takes nothing returns nothing\r\n    call InitAllyPriorities(  )\r\nendfunction\r\n";
    /// The same as the generator's Lua (lua.ts jassToLua).
    const LUA: &str = "function InitAllyPriorities()\r\nSetStartLocPrioCount(0, 1)\r\nSetStartLocPrio(0, 0, 1, MAP_LOC_PRIO_HIGH)\r\n\
        SetStartLocPrioCount(1, 1)\r\nSetStartLocPrio(1, 0, 0, MAP_LOC_PRIO_HIGH)\r\nend\r\n\r\nfunction config()\r\nInitAllyPriorities()\r\nend\r\n";

    #[test]
    fn a_script_agrees_when_its_ally_priorities_are_those_of_the_info() {
        let codecs = Registry::with_formats(&[]).unwrap();
        let worked = |flags| pack_w3i(&mini_w3i(&codecs, flags, vec![with(user(0, 0.0, 0.0), json!({ "allyLow": 2 })), user(1, 0.0, 1280.0)]), &codecs).unwrap();
        let w3i = worked(MELEE_FLAGS);
        assert_eq!(script_agrees(&w3i, JASS.as_bytes(), &codecs), ScriptPriorities::Agree);
        assert_eq!(script_agrees(&w3i, LUA.as_bytes(), &codecs), ScriptPriorities::Agree);
        // Controls: a LOW instead of HIGH, a missing player, no function at all, an enemy priority more.
        let low = JASS.replacen("1, MAP_LOC_PRIO_HIGH", "1, MAP_LOC_PRIO_LOW", 1);
        assert_eq!(script_agrees(&w3i, low.as_bytes(), &codecs), ScriptPriorities::Disagree);
        let one = LUA.replace("SetStartLocPrio(1, 0, 0, MAP_LOC_PRIO_HIGH)\r\n", "");
        assert_eq!(script_agrees(&w3i, one.as_bytes(), &codecs), ScriptPriorities::Disagree);
        let none = "function config takes nothing returns nothing\r\nendfunction\r\n";
        assert_eq!(script_agrees(&w3i, none.as_bytes(), &codecs), ScriptPriorities::Disagree);
        let enemy = JASS.replace("endfunction\r\n\r\nfunction config", "    call SetEnemyStartLocPrio( 1, 0, 0, MAP_LOC_PRIO_LOW )\r\nendfunction\r\n\r\nfunction config");
        assert_eq!(script_agrees(&w3i, enemy.as_bytes(), &codecs), ScriptPriorities::Disagree);
        // A lone player has no priorities: a script without the function agrees.
        let alone = mini_w3i(&codecs, MELEE_FLAGS, vec![user(0, 0.0, 0.0)]);
        assert_eq!(script_agrees(&alone, none.as_bytes(), &codecs), ScriptPriorities::Agree);
    }

    #[test]
    fn a_script_line_that_isnt_read_cant_be_told() {
        let codecs = Registry::with_formats(&[]).unwrap();
        let w3i = mini_w3i(&codecs, MELEE_FLAGS, vec![with(user(0, 0.0, 0.0), json!({ "allyHigh": 2 })), with(user(1, 0.0, 1280.0), json!({ "allyHigh": 1 }))]);
        assert_eq!(script_agrees(&w3i, JASS.as_bytes(), &codecs), ScriptPriorities::Agree);
        for odd in [
            JASS.replace("MAP_LOC_PRIO_HIGH )\r\nendfunction", "ConvertStartLocPrio(2) )\r\nendfunction"),
            JASS.replace("    call SetStartLocPrioCount( 1, 1 )", "    call DoSomething(  )"),
            JASS.replace("( 1, 0, 0,", "( x, 0, 0,"),
            JASS.split("    call SetStartLocPrioCount( 1, 1 )").next().unwrap().to_string(),
        ] {
            assert_eq!(script_agrees(&w3i, odd.as_bytes(), &codecs), ScriptPriorities::Unknown, "{odd}");
        }
        assert_eq!(script_agrees(&w3i[..10], JASS.as_bytes(), &codecs), ScriptPriorities::Unknown, "info that can't be read");
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
