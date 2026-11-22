//! The trigger folders (`map/triggers/`, `w3proj::trigger_layout`) through the real `w3proj` binary, on a made-up map:
//! the mini map's files with the triggers of `trigger_layout::sample_map` (functions of tests/fixtures/TriggerData.txt).
//! Unpack splits war3map.wtg and war3map.wct into one file per trigger, pack gives them back byte for byte, an edit of
//! a file reaches the map, a sync keeps the files' names, and a generated script is refused when it doesn't follow.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use w3proj::trigger_layout as tl;

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mini-map")
}

/// What unpacking the sample map writes into map/triggers/ (checked in, so a change of the format shows in a diff).
fn golden() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/trigger-folders/map/triggers")
}

fn trigger_data() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/TriggerData.txt")
}

fn workdir(test: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("triggers-{test}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn w3proj(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_w3proj")).args(args).env_remove("W3PROJ_FORMATS").env_remove("W3PROJ_GAME").output().unwrap()
}

fn text(o: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))
}

fn ok(args: &[&str]) -> String {
    let o = w3proj(args);
    assert!(o.status.success(), "w3proj {args:?} failed: {}", text(&o));
    text(&o)
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

fn unpack(map: &Path, project: &Path) -> String {
    ok(&["unpack", s(map), s(project), "--game", "none", "--trigger-data", s(&trigger_data())])
}

fn pack(project: &Path, out: &Path, more: &[&str]) -> Output {
    let data = trigger_data();
    let mut args = vec!["pack", s(project), "-o", s(out), "--game", "none", "--trigger-data", s(&data)];
    args.extend(more);
    w3proj(&args)
}

fn cat(map: &Path, name: &str) -> Vec<u8> {
    let o = w3proj(&["cat", s(map), name]);
    assert!(o.status.success(), "{}", text(&o));
    o.stdout
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &to.join(e.file_name()));
        } else {
            fs::copy(e.path(), to.join(e.file_name())).unwrap();
        }
    }
}

/// The files below `dir`, `/` between folders.
fn files(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for e in fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                out.insert(p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"), fs::read(&p).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    if dir.is_dir() {
        walk(dir, dir, &mut out);
    }
    out
}

/// The mini map with the sample's war3map.wtg and war3map.wct (`classic`: a Classic tree; `lua`: war3map.w3i's
/// scriptType 1), packed. Returns the map and the two files.
fn sample_map(dir: &Path, classic: bool, lua: bool) -> (PathBuf, Vec<u8>, Vec<u8>) {
    let src = dir.join("source");
    copy_dir(&fixture(), &src);
    fs::remove_file(src.join("map/war3map.wtg.json")).unwrap();
    let (wtg, wct) = tl::sample_map(classic);
    fs::write(src.join("map/war3map.wtg"), &wtg).unwrap();
    fs::write(src.join("map/war3map.wct"), &wct).unwrap();
    if lua {
        let w3i = src.join("map/war3map.w3i.json");
        let json = fs::read_to_string(&w3i).unwrap();
        assert!(json.contains("\"scriptType\": 0"));
        fs::write(&w3i, json.replace("\"scriptType\": 0", "\"scriptType\": 1")).unwrap();
    }
    let map = dir.join("sample.w3x");
    let o = pack(&src, &map, &[]);
    assert!(o.status.success(), "{}", text(&o));
    assert_eq!(cat(&map, "war3map.wtg"), wtg);
    (map, wtg, wct)
}

#[test]
fn unpack_writes_the_trigger_folders_and_pack_gives_the_map_back() {
    let dir = workdir("roundtrip");
    let (map, wtg, wct) = sample_map(&dir, false, false);
    let project = dir.join("project");
    unpack(&map, &project);
    let m = project.join("map");
    for gone in ["war3map.wtg", "war3map.wct", "war3map.wtg.json", "war3map.wct.txt"] {
        assert!(!m.join(gone).exists(), "{gone} is in the project");
    }
    // The format, file by file (tests/fixtures/trigger-folders).
    let got = files(&m.join("triggers"));
    let want = files(&golden());
    assert_eq!(got.keys().collect::<Vec<_>>(), want.keys().collect::<Vec<_>>());
    for (name, bytes) in &want {
        assert!(got[name] == *bytes, "map/triggers/{name} isn't the one in tests/fixtures/trigger-folders:\n{}", String::from_utf8_lossy(&got[name]));
    }
    let setup = String::from_utf8(got["Initialization/Setup_Players.j"].clone()).unwrap();
    assert!(setup.starts_with("// @w3proj {\"type\":8,\"id\":50331649,\"name\":\"Setup Players\""), "{setup}");
    assert!(setup.contains("}\r\nfunction Trig_Setup_Players_Actions"), "the frontmatter takes the text's CRLF: {setup}");
    // The script is the map's own (no Studio stamp): kept, a tracked file.
    assert!(String::from_utf8_lossy(&got["triggers.json"]).contains("\"script\": \"kept\""));
    assert!(m.join("war3map.j").is_file());
    assert!(fs::read_to_string(project.join(".gitattributes")).unwrap().contains("map/triggers/** -text"));

    let second = dir.join("second.w3x");
    let o = pack(&project, &second, &[]);
    assert!(o.status.success(), "{}", text(&o));
    assert_eq!((cat(&second, "war3map.wtg"), cat(&second, "war3map.wct")), (wtg, wct));
    assert_eq!(fs::read(&map).unwrap(), fs::read(&second).unwrap(), "the map changed");
    // verify names the layout as what reads both files.
    let baseline = dir.join("baseline.tsv");
    ok(&["verify", s(&map), "--game", "none", "--trigger-data", s(&trigger_data()), "--baseline", s(&baseline), "--update-baseline"]);
    let table = fs::read_to_string(&baseline).unwrap();
    assert!(table.contains("\twar3map.wtg\ttrigger-folders\n") && table.contains("\twar3map.wct\ttrigger-folders\n"), "{table}");
}

#[test]
fn lua_and_classic_maps_round_trip() {
    for (classic, lua) in [(false, true), (true, false)] {
        let dir = workdir(&format!("variant-{classic}-{lua}"));
        let (map, _, _) = sample_map(&dir, classic, lua);
        let project = dir.join("project");
        unpack(&map, &project);
        let t = project.join("map/triggers");
        if lua {
            assert!(t.join("header.lua").is_file() && t.join("Initialization/Setup_Players.lua").is_file());
            let f = fs::read_to_string(t.join("Systems/Damage_Engine.lua")).unwrap();
            assert!(f.starts_with("-- @w3proj {"), "{f}");
        }
        if classic {
            let root = fs::read_to_string(t.join("triggers.json")).unwrap();
            assert!(!root.contains("\"root\"") && !root.contains("\"counts\""), "{root}");
            assert!(t.join("Setup/Setup_Players.j").is_file());
        }
        let second = dir.join("second.w3x");
        let o = pack(&project, &second, &[]);
        assert!(o.status.success(), "{}", text(&o));
        assert_eq!(fs::read(&map).unwrap(), fs::read(&second).unwrap(), "classic={classic} lua={lua}: the map changed");
    }
}

#[test]
fn edits_and_new_files_reach_the_map() {
    let dir = workdir("edits");
    let (map, _, _) = sample_map(&dir, false, false);
    let project = dir.join("project");
    unpack(&map, &project);
    let t = project.join("map/triggers");
    // A trigger's text, a GUI trigger's name, and a script dropped in from outside (no frontmatter, unlisted).
    let setup = t.join("Initialization/Setup_Players.j");
    fs::write(&setup, fs::read_to_string(&setup).unwrap().replace("endfunction\r\nfunction InitTrig", "    call DoNothing()\r\nendfunction\r\nfunction InitTrig")).unwrap();
    let gui = t.join("Initialization/Melee_Initialization.gui.json");
    fs::write(&gui, fs::read_to_string(&gui).unwrap().replace("\"name\": \"Melee Initialization\"", "\"name\": \"Melee Setup\"")).unwrap();
    fs::write(t.join("Systems/Extra.j"), "library Extra\nendlibrary\n").unwrap();
    let out = dir.join("edited.w3x");
    let o = pack(&project, &out, &[]);
    assert!(o.status.success(), "{}", text(&o));
    let (wtg, wct) = (cat(&out, "war3map.wtg"), cat(&out, "war3map.wct"));
    let has = |b: &[u8], what: &str| b.windows(what.len()).any(|w| w == what.as_bytes());
    assert!(has(&wct, "    call DoNothing()\r\n") && !has(&wct, "// @w3proj"), "the text, without its frontmatter");
    // The name, with its terminating zero (the description still says "Melee Initialization.").
    assert!(has(&wtg, "Melee Setup\0") && !has(&wtg, "Melee Initialization\0"));
    assert!(has(&wtg, "Extra") && has(&wct, "library Extra\n"));
    // A malformed file stops the pack, naming it.
    fs::write(&gui, "{ \"name\": ").unwrap();
    let o = pack(&project, &dir.join("broken.w3x"), &[]);
    assert!(!o.status.success() && text(&o).contains("map/triggers/Initialization/Melee_Initialization.gui.json:1"), "{}", text(&o));
    // A function the TriggerData doesn't know too.
    fs::write(&gui, "{\"name\":\"M\",\"ecas\":[{\"kind\":2,\"name\":\"NoSuchFoo\",\"enabled\":true,\"params\":[],\"children\":[]}]}").unwrap();
    let o = pack(&project, &dir.join("broken.w3x"), &[]);
    assert!(!o.status.success() && text(&o).contains("\"NoSuchFoo\" isn't a function"), "{}", text(&o));
}

#[test]
fn a_function_missing_from_trigger_data_leaves_both_files_raw_and_undamaged() {
    let dir = workdir("unknown");
    let (map, wtg, wct) = sample_map(&dir, false, false);
    // The same data without DoFooThing, which the sample's GUI trigger uses.
    let data = dir.join("TriggerData.txt");
    let full = fs::read_to_string(trigger_data()).unwrap();
    let cut: String = full.lines().filter(|l| !l.starts_with("DoFooThing")).map(|l| format!("{l}\n")).collect();
    assert_ne!(full.len(), cut.len(), "the control line wasn't there");
    fs::write(&data, cut).unwrap();
    let project = dir.join("project");
    let out = ok(&["unpack", s(&map), s(&project), "--game", "none", "--trigger-data", s(&data)]);
    assert!(out.contains("raw war3map.wtg") && out.contains("unknown trigger function \"DoFooThing\""), "{out}");
    assert!(!project.join("map/triggers").exists());
    assert_eq!((fs::read(project.join("map/war3map.wtg")).unwrap(), fs::read(project.join("map/war3map.wct")).unwrap()), (wtg, wct));
    let second = dir.join("second.w3x");
    assert!(pack(&project, &second, &[]).status.success());
    assert_eq!(fs::read(map).unwrap(), fs::read(second).unwrap());
}

#[test]
fn a_sync_keeps_the_names_the_files_have() {
    let dir = workdir("names");
    let (map, _, _) = sample_map(&dir, false, false);
    let project = dir.join("project");
    unpack(&map, &project);
    let t = project.join("map/triggers");
    // Renamed by hand (order.txt too): the item keeps the name on the next sync from the same map.
    fs::rename(t.join("Initialization/Setup_Players.j"), t.join("Initialization/SetupPlayers.j")).unwrap();
    let order = t.join("Initialization/order.txt");
    fs::write(&order, fs::read_to_string(&order).unwrap().replace("Setup_Players.j", "SetupPlayers.j")).unwrap();
    let before = files(&t);
    unpack(&map, &project);
    assert_eq!(files(&t), before, "the sync changed the trigger files");
    // Control: a fresh unpack names it as the slug says.
    let fresh = dir.join("fresh");
    unpack(&map, &fresh);
    assert!(fresh.join("map/triggers/Initialization/Setup_Players.j").is_file());
}

/// A script Studio wrote (`.w3proj/generated-script` holds its hash) becomes "generated" on a sync: out of git, in
/// `.w3proj/derived/`, with a record of its sources. Pack takes it while the record says it follows; after an edit of a
/// trigger it refuses (`--allow-stale-script` packs it as it is), and a missing one is refused whatever the flags.
#[test]
fn a_generated_script_is_packed_only_while_it_follows_its_sources() {
    let dir = workdir("generated");
    let (map, _, _) = sample_map(&dir, false, false);
    let project = dir.join("project");
    unpack(&map, &project);
    let script = fs::read(project.join("map/war3map.j")).unwrap();
    fs::create_dir_all(project.join(".w3proj")).unwrap();
    fs::write(project.join(w3proj::derived::SCRIPT_STAMP), format!("{}\n", w3proj::derived::script_hash(std::str::from_utf8(&script).unwrap()))).unwrap();
    unpack(&map, &project);
    assert!(fs::read_to_string(project.join("map/triggers/triggers.json")).unwrap().contains("\"script\": \"generated\""));
    assert!(!project.join("map/war3map.j").exists(), "a generated script isn't tracked");
    assert_eq!(fs::read(project.join(".w3proj/derived/war3map.j")).unwrap(), script);
    assert!(fs::read_to_string(project.join(".gitignore")).unwrap().contains("/.w3proj/derived-from.json"));
    assert_eq!(w3proj::derived::check_script(&project).unwrap(), w3proj::derived::Freshness::Fresh);
    let out = dir.join("out.w3x");
    let o = pack(&project, &out, &[]);
    assert!(o.status.success(), "{}", text(&o));
    assert_eq!(fs::read(&map).unwrap(), fs::read(&out).unwrap(), "the script comes from the store");
    // A sync from the same map keeps it generated.
    unpack(&map, &project);
    assert!(!project.join("map/war3map.j").exists() && project.join(".w3proj/derived/war3map.j").is_file());
    // A trigger edited: stale.
    let setup = project.join("map/triggers/Initialization/Setup_Players.j");
    fs::write(&setup, [fs::read(&setup).unwrap(), b"// more\r\n".to_vec()].concat()).unwrap();
    let o = pack(&project, &out, &[]);
    assert!(!o.status.success() && text(&o).contains("triggers/initialization/setup_players.j changed") && text(&o).contains("--allow-stale-script"), "{}", text(&o));
    let o = pack(&project, &out, &["--allow-stale-script"]);
    assert!(o.status.success() && text(&o).contains("warning: --allow-stale-script"), "{}", text(&o));
    assert_eq!(cat(&out, "war3map.j"), script);
    // Missing: never packed.
    fs::remove_file(project.join(".w3proj/derived/war3map.j")).unwrap();
    let o = pack(&project, &out, &["--allow-stale-script"]);
    assert!(!o.status.success() && text(&o).contains("the map script is missing in .w3proj/derived/"), "{}", text(&o));
    // One in map/ as well as in the store: an error, not a guess.
    fs::write(project.join(".w3proj/derived/war3map.j"), &script).unwrap();
    fs::write(project.join("map/war3map.j"), &script).unwrap();
    let o = pack(&project, &out, &["--allow-stale-script"]);
    assert!(!o.status.success() && text(&o).contains("are both there"), "{}", text(&o));
    // The World Editor saved it again (another script): kept, back in map/, the store's goes.
    fs::remove_file(project.join("map/war3map.j")).unwrap();
    let src = dir.join("source");
    fs::write(src.join("map/war3map.j"), b"function main takes nothing returns nothing\nendfunction\n").unwrap();
    let edited = dir.join("from-we.w3x");
    assert!(pack(&src, &edited, &[]).status.success());
    unpack(&edited, &project);
    assert!(fs::read_to_string(project.join("map/triggers/triggers.json")).unwrap().contains("\"script\": \"kept\""));
    assert!(project.join("map/war3map.j").is_file() && !project.join(".w3proj/derived/war3map.j").exists());
    assert_eq!(w3proj::derived::check_script(&project).unwrap(), w3proj::derived::Freshness::Unknown);
}

/// A map with war3map.wtg but no war3map.wct (the mini map), and one with neither: no map/triggers/, and pack makes
/// up none of them.
#[test]
fn without_both_files_nothing_is_split_or_made_up() {
    let dir = workdir("partial");
    let first = dir.join("mini.w3x");
    assert!(pack(&fixture(), &first, &[]).status.success());
    let project = dir.join("project");
    let out = unpack(&first, &project);
    assert!(out.contains("raw war3map.wtg (trigger-folders: the map has no war3map.wct)"), "{out}");
    assert!(!project.join("map/triggers").exists() && project.join("map/war3map.wtg").is_file());
    fs::remove_file(project.join("map/war3map.wtg")).unwrap();
    let second = dir.join("second.w3x");
    assert!(pack(&project, &second, &[]).status.success());
    let listing = ok(&["ls", s(&second)]);
    assert!(!listing.contains("war3map.wtg") && !listing.contains("war3map.wct"), "{listing}");
}
