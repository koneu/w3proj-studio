//! System tests of the real `w3proj` binary on a tiny project made up for the tests
//! (`tests/fixtures/mini-map`): nothing here needs the game or third-party maps, so it runs in CI.
//! The promise under test is the project's core one: pack → unpack → pack changes nothing.

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mini-map")
}

/// A folder for one test, under the build's temporary directory.
fn workdir(test: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(test);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn w3proj(args: &[&str]) -> Output {
    common::w3proj_cmd().args(args).output().unwrap()
}

fn text(o: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))
}

/// Runs a command that has to work, and returns what it printed.
fn ok(args: &[&str]) -> String {
    let o = w3proj(args);
    assert!(o.status.success(), "w3proj {args:?} failed: {}", text(&o));
    text(&o)
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

/// The made-up TriggerData.txt the fixture's war3map.wtg is read with (nothing from the game).
fn trigger_data() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/TriggerData.txt")
}

/// Unpacks with the made-up TriggerData, so the trigger codec really runs.
fn unpack(map: &Path, project: &Path) -> String {
    ok(&["unpack", s(map), s(project), "--game", "none", "--trigger-data", s(&trigger_data())])
}

fn pack(project: &Path, out: &Path) {
    // [Refactored] When packing the unmodified fixture() for setup, reuse cached packed bytes instead of spawning a new w3proj subprocess 20+ times.
    if project == fixture() {
        static PACKED_FIXTURE: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
        let bytes = PACKED_FIXTURE.get_or_init(|| {
            let tmp = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("cached-mini-{}.w3x", std::process::id()));
            ok(&["pack", s(&fixture()), "-o", s(&tmp)]);
            let b = fs::read(&tmp).unwrap();
            let _ = fs::remove_file(&tmp);
            b
        });
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(out, bytes).unwrap();
        return;
    }
    ok(&["pack", s(project), "-o", s(out)]);
}

fn files(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for e in fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                out.insert(rel, fs::read(&p).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

#[test]
fn pack_unpack_pack_changes_nothing() {
    let dir = workdir("roundtrip");
    let (first, project, second) = (dir.join("first.w3x"), dir.join("project"), dir.join("second.w3x"));

    pack(&fixture(), &first);
    unpack(&first, &project);
    pack(&project, &second);

    assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap(), "the map changed");

    let (want, got) = (fixture_unpacked(&first), files(&project.join("map")));
    assert_eq!(want.keys().collect::<Vec<_>>(), got.keys().collect::<Vec<_>>());
    for (name, bytes) in &want {
        assert!(*bytes == got[name], "{name} came back different");
    }
}

/// The fixture's map/ files as an unpack of `map` (the fixture packed) writes them. The fixture's trigger folders
/// (map/triggers/) are made by hand, as a map made in Studio: no ids. Packed, they get ids, and an unpack is an import,
/// which keeps them in the files: the folders come back as the layout splits the packed war3map.wtg and war3map.wct.
fn fixture_unpacked(map: &Path) -> BTreeMap<String, Vec<u8>> {
    use w3proj::trigger_layout as tl;
    let mut want = files(&fixture().join("map"));
    want.retain(|k, _| !tl::is_layout_path(k));
    let (wtg, wct) = (w3proj(&["cat", s(map), "war3map.wtg"]).stdout, w3proj(&["cat", s(map), "war3map.wct"]).stdout);
    let data = w3proj::triggerdata::TriggerData::parse(&fs::read_to_string(trigger_data()).unwrap());
    want.extend(tl::split_map(&wtg, &wct, &data, tl::Lang::Jass).unwrap());
    want
}

/// The map's files loose in a folder, as the World Editor saves a "Warcraft III Scenario Folder"
/// (names from `ls`, bytes from `cat`; an archive name's `\` becomes a subfolder).
fn map_folder(map: &Path, folder: &Path) -> usize {
    let listing = ok(&["ls", s(map)]);
    let names: Vec<&str> = listing
        .lines()
        .skip(1)
        .filter(|l| !l.starts_with("file data"))
        .filter_map(|l| l.split_whitespace().nth(3))
        .collect();
    for name in &names {
        let o = w3proj(&["cat", s(map), name]);
        assert!(o.status.success(), "cat {name}: {}", text(&o));
        let path = name.split('\\').fold(folder.to_path_buf(), |p, c| p.join(c));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, o.stdout).unwrap();
    }
    names.len()
}

#[test]
fn a_map_folder_unpacks_like_the_packed_map() {
    let dir = workdir("folder");
    let (first, folder, project, second) = (dir.join("first.w3x"), dir.join("Mini.w3x"), dir.join("project"), dir.join("second.w3x"));
    pack(&fixture(), &first);
    assert!(map_folder(&first, &folder) >= 13);
    assert!(folder.join("war3mapImported").join("readme.txt").is_file());

    unpack(&folder, &project);
    let (want, got) = (fixture_unpacked(&first), files(&project.join("map")));
    assert_eq!(want.keys().collect::<Vec<_>>(), got.keys().collect::<Vec<_>>());
    for (name, bytes) in &want {
        assert!(*bytes == got[name], "{name} came back different");
    }
    // The fixture has no map header, like a folder: the same map, byte for byte.
    pack(&project, &second);
    assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap(), "the map changed");
}

#[test]
fn a_folder_that_is_no_map_or_holds_the_project_is_refused() {
    let dir = workdir("folder-refused");
    let first = dir.join("first.w3x");
    pack(&fixture(), &first);

    // No war3map.w3i: not a map folder.
    let empty = dir.join("empty");
    fs::create_dir_all(&empty).unwrap();
    fs::write(empty.join("notes.txt"), "hello").unwrap();
    let o = w3proj(&["unpack", s(&empty), s(&dir.join("p1")), "--game", "none"]);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert!(text(&o).contains("no map folder"), "{}", text(&o));
    assert!(!dir.join("p1").exists());

    // A project inside the map folder would be read as part of the map, then sync away its files.
    let folder = dir.join("Mini.w3x");
    map_folder(&first, &folder);
    let before = files(&folder);
    let o = w3proj(&["unpack", s(&folder), s(&folder.join("project")), "--game", "none"]);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert!(text(&o).contains("can't be inside"), "{}", text(&o));
    assert_eq!(before, files(&folder), "the map folder changed");
    // Control: next to it, it works.
    ok(&["unpack", s(&folder), s(&dir.join("next")), "--game", "none"]);
    assert!(dir.join("next/map/war3map.j").is_file());
}

#[test]
fn packing_twice_gives_the_same_bytes() {
    let dir = workdir("deterministic");
    let (a, b) = (dir.join("a.w3x"), dir.join("b.w3x"));
    // [Refactored] Invoke w3proj pack directly here so determinism test exercises two real CLI pack runs.
    ok(&["pack", s(&fixture()), "-o", s(&a)]);
    ok(&["pack", s(&fixture()), "-o", s(&b)]);
    assert_eq!(fs::read(a).unwrap(), fs::read(b).unwrap());
}

#[test]
fn verify_finds_every_codec_at_work() {
    let dir = workdir("verify");
    let map = dir.join("mini.w3x");
    pack(&fixture(), &map);
    let baseline = dir.join("baseline.tsv");
    ok(&["verify", s(&map), "--game", "none", "--trigger-data", s(&trigger_data()), "--baseline", s(&baseline), "--update-baseline"]);

    let table = fs::read_to_string(&baseline).unwrap();
    let codec = |file: &str| {
        table.lines().map(|l| l.split('\t').collect::<Vec<_>>()).find(|c| c.get(1) == Some(&file)).map(|c| c[2].to_string())
    };
    for (file, id) in [
        ("war3map.w3i", "format:w3i"),
        ("war3map.doo", "format:doodads"),
        ("war3mapUnits.doo", "format:units"),
        ("war3map.w3r", "format:regions"),
        ("war3map.w3c", "format:cameras"),
        ("war3map.mmp", "format:minimap"),
        ("war3map.w3s", "format:sounds"),
        ("war3map.w3l", "format:lights"),
        ("war3map.imp", "format:imports"),
        ("war3map.w3u", "objdata-json"),
        ("war3map.w3t", "objdata-json"),
        ("war3map.w3b", "objdata-json"),
        ("war3map.w3d", "objdata-json"),
        ("war3map.w3a", "objdata-json"),
        ("war3map.w3h", "objdata-json"),
        ("war3map.w3q", "objdata-json"),
        ("war3map.w3e", "w3e-text"),
        // The fixture has the trigger folders: both files go into map/triggers/.
        ("war3map.wtg", "trigger-folders"),
        ("war3map.wct", "trigger-folders"),
    ] {
        assert_eq!(codec(file).as_deref(), Some(id), "{file} in\n{table}");
    }
}

/// The made-up campaign (`tests/fixtures/mini-campaign`; campaign info can't go into the mini map, it would make it a
/// campaign): pack → unpack → pack is identical, its files come back as they are, and every one of them went through
/// its codec.
#[test]
fn the_mini_campaign_round_trips_through_its_codecs() {
    let dir = workdir("campaign");
    let fixture = fixture().join("../mini-campaign");
    let (first, project, second, baseline) = (dir.join("first.w3n"), dir.join("project"), dir.join("second.w3n"), dir.join("baseline.tsv"));
    ok(&["pack", s(&fixture), "-o", s(&first)]);
    ok(&["unpack", s(&first), s(&project), "--game", "none"]);
    ok(&["pack", s(&project), "-o", s(&second)]);
    assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap(), "the campaign changed");
    let (want, got) = (files(&fixture.join("map")), files(&project.join("map")));
    assert_eq!(want.keys().collect::<Vec<_>>(), got.keys().collect::<Vec<_>>());
    for (name, bytes) in &want {
        assert!(*bytes == got[name], "{name} came back different");
    }

    ok(&["verify", s(&first), "--game", "none", "--baseline", s(&baseline), "--update-baseline"]);
    let table = fs::read_to_string(&baseline).unwrap();
    for (file, id) in [("war3campaign.w3f", "format:campaign"), ("war3campaign.imp", "format:imports"), ("war3campaign.w3u", "objdata-json")] {
        let row = table.lines().map(|l| l.split('\t').collect::<Vec<_>>()).find(|c| c.get(1) == Some(&file)).map(|c| c[2].to_string());
        assert_eq!(row.as_deref(), Some(id), "{file} in\n{table}");
    }
}

#[test]
fn verify_fails_when_a_codec_stops_reading_a_file() {
    let dir = workdir("baseline");
    let map = dir.join("mini.w3x");
    pack(&fixture(), &map);
    let baseline = dir.join("baseline.tsv");
    ok(&["verify", s(&map), "--game", "none", "--baseline", s(&baseline), "--update-baseline"]);

    // The same file now claims another codec read it last time: a silent change must fail.
    let table = fs::read_to_string(&baseline).unwrap().replace("format:doodads", "format:regions");
    fs::write(&baseline, table).unwrap();
    let o = w3proj(&["verify", s(&map), "--game", "none", "--baseline", s(&baseline)]);
    assert!(!o.status.success(), "{}", text(&o));
}

/// A cut-off map opens as an archive whose tables are gone (the reader clamps them for protected
/// maps): verify said "ok, 0 files". It has to fail, as garbage does.
#[test]
fn verify_fails_a_map_that_cant_be_read() {
    let dir = workdir("verify_unreadable");
    let map = dir.join("mini.w3x");
    pack(&fixture(), &map);
    let bytes = fs::read(&map).unwrap();
    let truncated = dir.join("truncated.w3x");
    fs::write(&truncated, &bytes[..bytes.len().min(5000) / 2]).unwrap();
    let garbage = dir.join("garbage.w3x");
    fs::write(&garbage, (0..5000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect::<Vec<_>>()).unwrap();
    // The whole map still passes (the control).
    ok(&["verify", s(&map), "--game", "none"]);
    for bad in [&truncated, &garbage] {
        let o = w3proj(&["verify", s(bad), "--game", "none"]);
        let out = text(&o);
        assert_eq!(o.status.code(), Some(1), "{}: {out}", bad.display());
        assert!(out.contains("FAIL") && !out.contains("0 files"), "{}: {out}", bad.display());
        assert!(out.contains("0 ok"), "{}: {out}", bad.display());
    }
    let out = text(&w3proj(&["verify", s(&truncated), "--game", "none"]));
    assert!(out.contains("not a readable map"), "{out}");
}

/// A map whose war3map.wts lacks strings its files refer to shows TRIGSTR_<n> in the game: verify
/// lists them as a warning (exit 0, like an incomplete map), and fails with --warnings-fail.
#[test]
fn verify_warns_about_strings_the_wts_lacks() {
    let dir = workdir("verify_strings");
    let (map, project, broken) = (dir.join("mini.w3x"), dir.join("project"), dir.join("broken.w3x"));
    pack(&fixture(), &map);
    // The control: every string of the fixture is in its table.
    let out = ok(&["verify", s(&map), "--game", "none", "--warnings-fail"]);
    assert!(!out.contains("TRIGSTR"), "{out}");
    assert!(out.contains("0 with warnings"), "{out}");

    unpack(&map, &project);
    let wts_path = project.join("map/war3map.wts");
    let wts = fs::read_to_string(&wts_path).unwrap();
    let start = wts.find("STRING 3").expect("the fixture has string 3");
    let end = start + wts[start..].find('}').unwrap() + 1;
    fs::write(&wts_path, format!("{}{}", &wts[..start], &wts[end..])).unwrap();
    ok(&["pack", s(&project), "-o", s(&broken), "--keep-unused-strings"]);

    let out = ok(&["verify", s(&broken), "--game", "none"]);
    assert!(out.contains("warn") && out.contains("TRIGSTR_003"), "{out}");
    assert!(!out.contains("TRIGSTR_001") && !out.contains("TRIGSTR_002"), "{out}");
    assert!(out.contains("1 with warnings"), "{out}");
    // Quiet still lists them.
    let out = ok(&["verify", "-q", s(&broken), "--game", "none"]);
    assert!(out.contains("TRIGSTR_003"), "{out}");
    let o = w3proj(&["verify", s(&broken), "--game", "none", "--warnings-fail"]);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
}

#[test]
fn ls_and_cat_read_a_map() {
    let dir = workdir("read");
    let map = dir.join("mini.w3x");
    pack(&fixture(), &map);

    let listing = ok(&["ls", s(&map)]);
    for name in ["war3map.w3i", "war3map.j", r"war3mapImported\readme.txt"] {
        assert!(listing.contains(name), "{name} in {listing}");
    }
    let o = w3proj(&["cat", s(&map), "war3map.j"]);
    assert!(o.status.success());
    assert_eq!(o.stdout, fs::read(fixture().join("map/war3map.j")).unwrap());
}

#[test]
fn a_changed_project_file_reaches_the_map() {
    let dir = workdir("edit");
    let (first, project, edited) = (dir.join("first.w3x"), dir.join("project"), dir.join("edited.w3x"));
    pack(&fixture(), &first);
    unpack(&first, &project);

    let path = project.join("map/war3map.w3r.json");
    fs::write(&path, fs::read_to_string(&path).unwrap().replace("Middle", "Edited")).unwrap();
    pack(&project, &edited);

    let o = w3proj(&["cat", s(&edited), "war3map.w3r"]);
    assert!(String::from_utf8_lossy(&o.stdout).contains("Edited"));
    assert_ne!(fs::read(first).unwrap(), fs::read(edited).unwrap());
}

/// war3mapExtra.txt holds the World Editor's per-map preferences (its JassHelper menu, Map Properties > Prefs). The
/// editor's own saves (branch map-settings-we): LF lines with an empty one at the end, and a file of 0 bytes when
/// nothing is set, which it keeps in the map. Each must come back byte for byte through pack, unpack and pack.
#[test]
fn the_map_preferences_file_keeps_its_bytes_even_when_empty() {
    let saves: [&[u8]; 3] = [
        b"[MapExtraInfo]\nEnableJassHelper=true\nEnableJassHelperDebug=true\nEnableJassHelperOptimizer=true\nEnableJassHelperVJass=false\nEnforceTerrainLimits=true\nSkyModel=2\nTimeOfDay=3\n\n",
        b"[MapExtraInfo]\r\nSkyModel=2\r\nTimeOfDay=4\r\n\r\n",
        b"",
    ];
    for (i, bytes) in saves.iter().enumerate() {
        let dir = workdir(&format!("mapextra-{i}"));
        let (source, first, project, second) = (dir.join("source"), dir.join("first.w3x"), dir.join("project"), dir.join("second.w3x"));
        // The fixture with this save of the file in place of its own.
        for (name, data) in files(&fixture()) {
            let to = source.join(&name);
            fs::create_dir_all(to.parent().unwrap()).unwrap();
            fs::write(to, data).unwrap();
        }
        fs::write(source.join("map/war3mapExtra.txt"), bytes).unwrap();
        pack(&source, &first);
        // In the map (an empty file too), under its own name.
        assert!(ok(&["ls", s(&first)]).contains("war3mapExtra.txt"), "save {i}: not in the packed map");
        assert_eq!(w3proj(&["cat", s(&first), "war3mapExtra.txt"]).stdout, bytes.to_vec(), "save {i}: packed differently");
        unpack(&first, &project);
        assert_eq!(fs::read(project.join("map/war3mapExtra.txt")).unwrap(), bytes.to_vec(), "save {i}: unpacked differently");
        pack(&project, &second);
        assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap(), "save {i}: the map changed");
    }
}

#[test]
fn a_project_file_that_makes_no_sense_stops_the_pack() {
    let dir = workdir("broken");
    let (first, project, out) = (dir.join("first.w3x"), dir.join("project"), dir.join("out.w3x"));
    pack(&fixture(), &first);
    unpack(&first, &project);

    fs::write(project.join("map/war3map.w3r.json"), "{ not json").unwrap();
    let o = w3proj(&["pack", s(&project), "-o", s(&out)]);
    assert!(!o.status.success(), "{}", text(&o));
    assert!(!out.exists(), "a failed pack left a map behind");
    assert!(text(&o).contains("error"), "{}", text(&o));
}

#[test]
fn a_file_that_is_no_map_is_an_error_not_a_crash() {
    let dir = workdir("nomap");
    let map = dir.join("nothing.w3x");
    fs::write(&map, b"this is not an archive").unwrap();
    for args in [vec!["ls", s(&map)], vec!["verify", s(&map), "--game", "none"]] {
        let o = w3proj(&args);
        assert_eq!(o.status.code(), Some(1), "{args:?}: {}", text(&o));
        assert!(!text(&o).contains("panicked"), "{}", text(&o));
    }
}

#[test]
fn unpacking_into_a_project_again_keeps_it_in_sync() {
    let dir = workdir("resync");
    let (first, project, second) = (dir.join("first.w3x"), dir.join("project"), dir.join("second.w3x"));
    pack(&fixture(), &first);
    unpack(&first, &project);
    let before = files(&project.join("map"));

    // A stray file disappears, because the project mirrors the map (asked for: without the flag the sync refuses,
    // see a_resync_that_would_delete_files_lists_them_and_writes_nothing).
    fs::write(project.join("map/stray.txt"), "left over").unwrap();
    ok(&["unpack", s(&first), s(&project), "--game", "none", "--trigger-data", s(&trigger_data()), "--allow-deletes"]);

    assert_eq!(before, files(&project.join("map")));
    pack(&project, &second);
    assert_eq!(fs::read(first).unwrap(), fs::read(second).unwrap());
}

/// A w3proj.toml that is there but isn't TOML stops a sync from the map: written anew it would lose the pack settings
/// in it. Nothing below the project changes; once the file reads again, the sync keeps its settings.
#[test]
fn a_manifest_that_cant_be_read_stops_the_sync_and_is_kept() {
    let dir = workdir("broken-manifest");
    let (first, project) = (dir.join("first.w3x"), dir.join("project"));
    pack(&fixture(), &first);
    unpack(&first, &project);
    let manifest = project.join("w3proj.toml");
    let good = fs::read_to_string(&manifest).unwrap();
    let mine = if good.contains("[pack]\n") {
        good.replacen("[pack]\n", "[pack]\noutput = \"dist/mine.w3x\"\n", 1)
    } else {
        format!("{good}\n[pack]\noutput = \"dist/mine.w3x\"\n")
    };
    // An unclosed string: not TOML any more. The pack settings in it are the user's.
    let broken = format!("{mine}oops = \"\n");
    fs::write(&manifest, &broken).unwrap();
    fs::write(project.join("map").join("stray.txt"), "kept").unwrap();
    let o = w3proj(&["unpack", s(&first), s(&project), "--game", "none", "--trigger-data", s(&trigger_data())]);
    assert!(!o.status.success(), "the sync went on over a broken w3proj.toml: {}", text(&o));
    assert!(text(&o).contains("w3proj.toml"), "{}", text(&o));
    assert_eq!(fs::read_to_string(&manifest).unwrap(), broken, "the broken manifest was written over");
    assert!(project.join("map").join("stray.txt").exists(), "the failed sync changed map/");
    // Control: the same sync with the manifest readable again goes through and keeps its output.
    fs::write(&manifest, &mine).unwrap();
    ok(&["unpack", s(&first), s(&project), "--game", "none", "--trigger-data", s(&trigger_data()), "--allow-deletes"]);
    assert!(fs::read_to_string(&manifest).unwrap().contains("dist/mine.w3x"));
    assert!(!project.join("map").join("stray.txt").exists());
}

/// A re-sync that would delete files the user added under map/ writes nothing and lists them, as the
/// app asks first; --allow-deletes deletes them.
#[test]
fn a_resync_that_would_delete_files_lists_them_and_writes_nothing() {
    let dir = workdir("resync-deletes");
    let (first, project) = (dir.join("first.w3x"), dir.join("project"));
    pack(&fixture(), &first);
    unpack(&first, &project);
    // Control: a re-sync that deletes nothing goes through without the flag.
    unpack(&first, &project);
    let added = project.join("map").join("added.txt");
    fs::write(&added, "mine").unwrap();
    let script = project.join("map").join("war3map.j");
    let before = fs::read(&script).unwrap();
    fs::write(&script, b"changed").unwrap();
    let o = w3proj(&["unpack", s(&first), s(&project), "--game", "none", "--trigger-data", s(&trigger_data())]);
    assert!(!o.status.success(), "the sync deleted without asking: {}", text(&o));
    assert!(text(&o).contains("would delete map/added.txt"), "{}", text(&o));
    assert!(text(&o).contains("--allow-deletes"), "{}", text(&o));
    assert_eq!(fs::read_to_string(&added).unwrap(), "mine");
    assert_eq!(fs::read(&script).unwrap(), b"changed", "the refused sync wrote other files");
    let out = ok(&["unpack", s(&first), s(&project), "--game", "none", "--trigger-data", s(&trigger_data()), "--allow-deletes"]);
    assert!(out.contains("1 deleted"), "{out}");
    assert!(!added.exists());
    assert_eq!(fs::read(&script).unwrap(), before);
}

/// A chapter map of a campaign whose folder can't be looked into stops the pack: taken for "no chapter there", it
/// was left out of the campaign without a word. (Unix only: a folder without its search right.)
#[cfg(unix)]
#[test]
fn a_chapter_that_cant_be_checked_stops_the_pack() {
    use std::os::unix::fs::PermissionsExt;
    let dir = workdir("hidden-chapter");
    let (project, out) = (dir.join("campaign"), dir.join("out.w3n"));
    let chapter = project.join("maps").join("Chapter.w3x");
    fs::create_dir_all(project.join("map")).unwrap();
    fs::create_dir_all(chapter.join("map")).unwrap();
    fs::write(project.join("w3proj.toml"), "format = 1\n").unwrap();
    fs::write(project.join("map").join("notes.txt"), "campaign").unwrap();
    fs::write(chapter.join("w3proj.toml"), "format = 1\n").unwrap();
    fs::write(chapter.join("map").join("notes.txt"), "chapter").unwrap();
    // Control: readable, the chapter is packed into the campaign.
    pack(&project, &out);
    assert!(ok(&["ls", s(&out)]).contains("Chapter.w3x"), "the control pack has no chapter");
    fs::remove_file(&out).unwrap();
    // Read but not searched: its names list, but whether w3proj.toml is in it can't be checked.
    fs::set_permissions(&chapter, fs::Permissions::from_mode(0o600)).unwrap();
    let checkable = chapter.join("w3proj.toml").try_exists().is_ok();
    let o = w3proj(&["pack", s(&project), "-o", s(&out)]);
    fs::set_permissions(&chapter, fs::Permissions::from_mode(0o755)).unwrap();
    if checkable {
        // As root every folder can be searched: nothing to show here.
        common::skip_or_fail("a folder without the search permission can still be searched (running as root?)");
        return;
    }
    assert!(!o.status.success(), "packed without the chapter it couldn't check: {}", text(&o));
    assert!(text(&o).contains("can't be checked"), "{}", text(&o));
    assert!(!out.exists(), "a failed pack left a map behind");
}

/// A file whose name starts with U+FEFF (which a UTF-8 decoder may take for a byte-order mark and drop) packs
/// under the archive name the app computes for it (tests/fixtures/archive-names.json, which the app's
/// archivepath.test.ts checks), and unpacks to the same file again.
#[test]
fn a_name_starting_with_a_byte_order_mark_keeps_it_through_pack_and_unpack() {
    let dir = workdir("bom-name");
    let (first, project, packed, again) = (dir.join("first.w3x"), dir.join("project"), dir.join("packed.w3x"), dir.join("again"));
    pack(&fixture(), &first);
    unpack(&first, &project);
    let fixture_names: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(fixture().join("../archive-names.json")).unwrap()).unwrap();
    let case = fixture_names["roundTrip"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["path"].as_str().unwrap().starts_with("war3mapImported/\u{feff}"))
        .expect("a case with a leading U+FEFF in the fixture");
    let (path, archive) = (case["path"].as_str().unwrap(), case["archive"].as_str().unwrap());
    let file = path.split('/').fold(project.join("map"), |p, c| p.join(c));
    fs::write(&file, "bom named").unwrap();

    pack(&project, &packed);
    let listing = ok(&["ls", s(&packed)]);
    assert!(listing.lines().any(|l| l.split_whitespace().nth(3) == Some(archive)), "{archive:?} in {listing}");
    let o = w3proj(&["cat", s(&packed), archive]);
    assert!(o.status.success(), "{}", text(&o));
    assert_eq!(o.stdout, b"bom named");
    // Control: the name without the mark isn't in the map.
    assert!(!w3proj(&["cat", s(&packed), &archive.replace('\u{feff}', "")]).status.success());

    unpack(&packed, &again);
    assert_eq!(fs::read(path.split('/').fold(again.join("map"), |p, c| p.join(c))).unwrap(), b"bom named");
}

/// Runs `w3proj args` with its output pipe already closed on the reader's side, like `| head`.
fn run_with_closed_pipe(args: &[&str]) -> Output {
    use std::process::Stdio;
    let mut child = common::w3proj_cmd()
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    drop(child.stdout.take()); // the reader goes away before the command prints anything
    child.wait_with_output().unwrap()
}

#[test]
fn a_closed_output_pipe_ends_the_command_quietly() {
    let dir = workdir("closed_pipe");
    let map = dir.join("mini.w3x");
    pack(&fixture(), &map);
    for args in [vec!["ls", s(&map)], vec!["formats"]] {
        let o = run_with_closed_pipe(&args);
        let err = String::from_utf8_lossy(&o.stderr);
        assert!(!err.contains("panicked") && !err.contains("failed printing"), "{args:?} panicked: {err}");
        assert!(err.trim().is_empty(), "{args:?} should stay quiet, stderr: {err}");
        assert!(o.status.success(), "{args:?} should exit cleanly, got {:?}", o.status);
    }
}

#[test]
fn a_real_error_still_reports_and_fails() {
    let dir = workdir("real_error");
    let missing = dir.join("missing.w3x");
    let o = w3proj(&["ls", s(&missing)]);
    assert!(!o.status.success());
    assert!(String::from_utf8_lossy(&o.stderr).contains("error:"), "{}", text(&o));
}

/// A folder of many copies of the packed mini map, with long names, so that `verify` prints far
/// more than any pipe buffer holds: some write is then certain to happen after the reader left.
/// With `bad`, a file that is no map sorts last, so `verify` has a failure to report at the end.
fn many_maps(test: &str, bad: bool) -> PathBuf {
    let dir = workdir(test);
    let one = dir.join("one.w3x");
    pack(&fixture(), &one);
    let maps = dir.join("maps");
    fs::create_dir_all(&maps).unwrap();
    // [Refactored] Right-sized from 600 copies (100-char prefix) to 220 copies (200-char prefix = >66 KiB stdout, still exceeding OS 64 KiB pipe buffer).
    let prefix = "a".repeat(200);
    for i in 0..220 {
        fs::copy(&one, maps.join(format!("{prefix}_{i:04}.w3x"))).unwrap();
    }
    if bad {
        fs::write(maps.join("zzz_not_a_map.w3x"), b"this is not an archive").unwrap();
    }
    maps
}

#[test]
fn a_closed_pipe_does_not_stop_verify_from_writing_the_baseline() {
    let maps = many_maps("closed_pipe_baseline", false);
    let baseline = maps.parent().unwrap().join("baseline.tsv");
    let o = run_with_closed_pipe(&["verify", s(&maps), "--game", "none", "--baseline", s(&baseline), "--update-baseline"]);
    assert!(o.status.success(), "{:?}: {}", o.status, text(&o));
    assert!(String::from_utf8_lossy(&o.stderr).trim().is_empty(), "{}", text(&o));
    let table = fs::read_to_string(&baseline).expect("the baseline was not written");
    assert!(table.contains("war3map.w3i"), "{table}");
}

#[test]
fn a_closed_pipe_does_not_hide_a_failing_verify() {
    let maps = many_maps("closed_pipe_failure", true);
    let o = run_with_closed_pipe(&["verify", s(&maps), "--game", "none"]);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert!(!String::from_utf8_lossy(&o.stderr).contains("panicked"), "{}", text(&o));
}

/// A folder of maps that also holds projects checks the maps, not what the projects packed: their `build/` maps and
/// checkpoints are outputs (the corpus tier failed on them), also one whose name is such a path with backslashes.
#[test]
fn verify_on_a_folder_leaves_out_the_projects_outputs() {
    let dir = workdir("verify_outputs");
    let maps = dir.join("maps");
    let project = maps.join("proj");
    // Joined part by part: `join("build/x")` keeps the `/` on Windows, where verify prints `\`.
    let build = project.join("build");
    fs::create_dir_all(build.join("checkpoints")).unwrap();
    pack(&fixture(), &maps.join("real.w3x"));
    // Outputs that aren't maps: verify fails if it reads any of them.
    let outputs = [build.join("proj.w3x"), build.join("checkpoints").join("proj 2026-11-08 07-11-01.w3x")];
    for o in &outputs {
        fs::write(o, b"this is not an archive").unwrap();
    }
    let misnamed = maps.join("proj\\build\\checkpoints\\proj 2026-11-08 07-11-21.w3x");
    if cfg!(unix) {
        fs::write(&misnamed, b"this is not an archive").unwrap();
    }
    let verify = |path: &Path| {
        let o = w3proj(&["verify", s(path), "--game", "none"]);
        (o.status.code(), text(&o))
    };
    // A folder named build is left out with or without a manifest; the same file elsewhere is read (and fails).
    let (_, out) = verify(&maps);
    assert!(outputs.iter().all(|o| !out.contains(&*o.to_string_lossy())), "{out}");
    let other = project.join("other");
    fs::create_dir_all(&other).unwrap();
    fs::write(other.join("proj.w3x"), b"this is not an archive").unwrap();
    let (code2, out2) = verify(&maps);
    assert_eq!(code2, Some(1), "{out2}");
    assert!(out2.contains(&*other.join("proj.w3x").to_string_lossy()), "{out2}");
    if cfg!(unix) {
        assert!(out2.contains("07-11-21"), "{out2}");
    }
    fs::remove_dir_all(&other).unwrap();
    fs::write(project.join("w3proj.toml"), "").unwrap();
    let (code, out) = verify(&maps);
    assert_eq!(code, Some(0), "{out}");
    assert!(out.contains("real.w3x") && out.contains("1 ok"), "{out}");
    // Given directly, a project's folder is searched, but its build folder is still left out.
    fs::create_dir_all(project.join("other")).unwrap();
    fs::write(project.join("other").join("x.w3x"), b"this is not an archive").unwrap();
    let (code, out) = verify(&project);
    assert_eq!(code, Some(1), "{out}");
    assert!(out.contains("0 ok") && out.contains("1 failed"), "{out}");
    assert!(outputs.iter().all(|o| !out.contains(&*o.to_string_lossy())), "{out}");
}

/// `verify` on all cores prints what one map after the other prints, in the same order, with the
/// failures in their places and the same exit code.
#[test]
fn verify_on_many_threads_prints_what_one_thread_prints() {
    let dir = workdir("verify_threads");
    let one = dir.join("one.w3x");
    pack(&fixture(), &one);
    let bytes = fs::read(&one).unwrap();
    let maps = dir.join("maps");
    fs::create_dir_all(maps.join("sub")).unwrap();
    // [Refactored] Right-sized from 40 to 16 maps across 4 verify runs (160 -> 64 map verifications, still saturating 8 threads with varying file sizes).
    for i in 0..16 {
        // Growing sizes, so that the biggest, which start first, finish last.
        let mut b = bytes.clone();
        b.extend(std::iter::repeat_n(0u8, i * 4096));
        fs::write(maps.join(format!("m{i:02}.w3x")), b).unwrap();
    }
    fs::write(maps.join("m05_bad.w3x"), b"this is not an archive").unwrap();
    fs::write(maps.join("sub/m99_bad.w3m"), &bytes[..bytes.len() / 2]).unwrap();
    let run = |jobs: &str, quiet: bool| {
        let mut args = vec!["verify", s(&maps), "--game", "none"];
        if quiet {
            args.push("-q");
        }
        let o = common::w3proj_cmd().args(&args).env("W3PROJ_VERIFY_JOBS", jobs).output().unwrap();
        (o.status.code(), text(&o))
    };
    for quiet in [false, true] {
        let (code1, one_thread) = run("1", quiet);
        let (code8, many_threads) = run("8", quiet);
        assert_eq!(code1, Some(1), "the bad maps must make it fail: {one_thread}");
        assert_eq!(code1, code8);
        assert!(one_thread.contains("m05_bad.w3x") && one_thread.contains("m15.w3x") || quiet, "{one_thread}");
        assert_eq!(one_thread, many_threads);
    }
}

#[test]
fn an_unreadable_trigger_data_file_is_an_error_that_names_it() {
    let dir = workdir("wtg_bad_data");
    let (project, missing, map) = (dir.join("project"), dir.join("nothing.txt"), dir.join("map.w3x"));
    pack(&fixture(), &map);
    // A folder can't be read as a file either.
    for bad in [missing.as_path(), dir.as_path()] {
        let runs = [
            vec!["unpack", s(&map), s(&project), "--game", "none", "--trigger-data", s(bad)],
            vec!["verify", s(&map), "--game", "none", "--trigger-data", s(bad)],
        ];
        for args in runs {
            let o = w3proj(&args);
            assert!(!o.status.success(), "w3proj {args:?} should fail: {}", text(&o));
            assert!(text(&o).contains(s(bad)), "the message doesn't name {}: {}", bad.display(), text(&o));
        }
    }
    assert!(!project.exists(), "work started before the file was checked");
}

/// Pathing, shadows and the minimap follow the terrain and doodads only through the app, a moment after an edit
/// (once a stale war3map.wpm left a lake walkable). A pack outside the app right after an edit, before they were made
/// again, stops and says why; `--force-stale` packs them as they are.
#[test]
fn a_pack_right_after_a_terrain_or_doodad_edit_refuses_the_old_derived_files() {
    let dir = workdir("derived_stale");
    let map = dir.join("map.w3x");
    pack(&fixture(), &map);
    let edits: [(&str, &str, &str); 2] = [
        ("map/war3map.w3e.txt", "0*4 -12\n", "0*4 -11\n"),
        ("map/war3map.doo.json", "64.0,", "96.0,"),
    ];
    for (file, from, to) in edits {
        let (project, out) = (dir.join(format!("project-{}", file.len())), dir.join("out.w3x"));
        unpack(&map, &project);
        // Unpacked from a map, its derived files are the map's own: packed as they are.
        pack(&project, &out);
        let path = project.join(file);
        let before = fs::read_to_string(&path).unwrap();
        assert!(before.contains(from), "{file} no longer has {from:?}");
        fs::write(&path, before.replacen(from, to, 1)).unwrap();
        let _ = fs::remove_file(&out);
        let o = w3proj(&["pack", s(&project), "-o", s(&out)]);
        assert!(!o.status.success(), "a pack right after editing {file} went ahead: {}", text(&o));
        assert!(!out.exists(), "the refused pack left a map behind");
        let said = text(&o);
        for words in ["war3map.wpm", file.trim_start_matches("map/"), "--force-stale"] {
            assert!(said.contains(words), "the refusal doesn't name {words}: {said}");
        }
        ok(&["pack", s(&project), "-o", s(&out), "--force-stale"]);
        assert!(out.exists());
    }
}

/// A write of war3map.wts that fails partway at the file level: the re-sync runs under a file-size limit of 4 KiB
/// (`ulimit -f 4`, SIGXFSZ ignored, so the write gets EFBIG after the first 4 KiB, as on a full disk) and the map's
/// war3map.wts is 12 KiB. The writer the app and the CLI share (w3proj::atomic, behind the app's fs_write_text too)
/// leaves the old file whole and no temporary file; a writer that truncated first would leave a 4 KiB start. The
/// retry without the limit writes the whole new file.
#[cfg(unix)]
#[test]
fn a_wts_write_cut_short_by_the_file_system_leaves_the_old_file_whole() {
    let dir = workdir("wts_cut_short");
    let (small, big) = (dir.join("small.w3x"), dir.join("big.w3x"));
    pack(&fixture(), &small);
    // STRING 3 (the map's description, referenced by war3map.w3i, so the pack keeps it) made 12 KiB long.
    let source = dir.join("big-source");
    unpack(&small, &source);
    let wts = source.join("map/war3map.wts");
    let text = fs::read_to_string(&wts).unwrap();
    assert!(text.contains("A map for tests."), "the fixture's STRING 3 changed");
    fs::write(&wts, text.replacen("A map for tests.", &"long text ".repeat(1200), 1)).unwrap();
    pack(&source, &big);

    let project = dir.join("project");
    unpack(&small, &project);
    let path = project.join("map/war3map.wts");
    let old = fs::read(&path).unwrap();
    let limited = "trap '' XFSZ; ulimit -f 4; exec \"$0\" unpack \"$1\" \"$2\" --game none --trigger-data \"$3\"";
    let o = common::hermetic(&mut Command::new("sh"))
        .args(["-c", limited,env!("CARGO_BIN_EXE_w3proj"), s(&big), s(&project), s(&trigger_data())])
        .output()
        .unwrap();
    // The control: the limit really stopped the write.
    assert!(!o.status.success(), "the re-sync went through under the limit: {}", self::text(&o));
    assert!(self::text(&o).contains("os error 27"), "not stopped by the file size: {}", self::text(&o));
    assert_eq!(fs::read(&path).unwrap(), old, "war3map.wts is no longer the old file");
    let left: Vec<String> = fs::read_dir(project.join("map")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".tmp")).collect();
    assert!(left.is_empty(), "temporary files left: {left:?}");

    unpack(&big, &project);
    let now = fs::read_to_string(&path).unwrap();
    assert!(now.len() > 12_000 && now.contains("long text long text"), "the retry didn't write the whole file ({} bytes)", now.len());
}

/// A project folder given to verify used to print "0 ok" and exit 0 (it searches folders for maps
/// and a project holds none). It has to fail with a message that says what to do; the packed map
/// of the same project (the control) still passes.
#[test]
fn verify_refuses_a_project_folder() {
    let dir = workdir("verify_project_folder");
    let map = dir.join("mini.w3x");
    pack(&fixture(), &map);
    ok(&["verify", s(&map), "--game", "none"]);
    let o = w3proj(&["verify", s(&fixture()), "--game", "none"]);
    let out = text(&o);
    assert!(!o.status.success(), "{out}");
    assert!(out.contains("project folder") && !out.contains("0 ok"), "{out}");
}

/// A pack gives the user players the ally priorities the World Editor's save works out, unless the
/// map has "Modify ally priorities" on (w3proj `allies`, the app's `applyAllyPriorities`).
#[test]
fn a_pack_works_out_stale_ally_priorities_unless_the_map_keeps_its_own() {
    let dir = workdir("ally-priorities");
    let first = dir.join("first.w3x");
    // (The fixture's own masks already match: pack_unpack_pack_changes_nothing has its war3map.w3i come back as it is.)
    pack(&fixture(), &first);
    let project = dir.join("project");
    unpack(&first, &project);
    let info = project.join("map/war3map.w3i.json");
    let original: serde_json::Value = serde_json::from_str(&fs::read_to_string(&info).unwrap()).unwrap();
    let back = |flags: u64, name: &str| -> serde_json::Value {
        let mut v = original.clone();
        v["flags"] = flags.into();
        v["players"][0]["allyLow"] = 2.into();
        v["players"][0]["enemyHigh"] = 2.into();
        let mut second = v["players"][0].clone();
        second["id"] = 1.into();
        second["start"] = serde_json::json!([0.0, 1280.0]);
        second["allyHigh"] = 0.into();
        v["players"].as_array_mut().unwrap().push(second);
        fs::write(&info, serde_json::to_string_pretty(&v).unwrap()).unwrap();
        let (map, out) = (dir.join(format!("{name}.w3x")), dir.join(name));
        pack(&project, &map);
        unpack(&map, &out);
        serde_json::from_str(&fs::read_to_string(out.join("map/war3map.w3i.json")).unwrap()).unwrap()
    };
    let flags = original["flags"].as_u64().unwrap();
    assert_eq!(flags & 2, 0, "the fixture has Modify ally priorities off");
    let worked = back(flags, "worked");
    let masks = |v: &serde_json::Value, i: usize| ["allyLow", "allyHigh", "enemyLow", "enemyHigh"].map(|k| v["players"][i][k].as_u64().unwrap());
    assert_eq!(masks(&worked, 0), [0, 2, 0, 0], "player 1 gets player 2 as High, the stale Low and enemy masks go");
    assert_eq!(masks(&worked, 1), [0, 1, 0, 0]);
    let own = back(flags | 2, "own");
    assert_eq!(masks(&own, 0), [2, 0, 0, 2], "Modify ally priorities: the map's own masks");
    assert_eq!(masks(&own, 1), [2, 0, 0, 2]);
}

/// A pack can't make the script again: when it works out ally priorities the project's war3map.j
/// doesn't set (the start locations or players changed outside the app), it says so and packs the
/// script as it is. A script that already sets them (the World Editor's, after masks were edited
/// by hand) gets no warning.
#[test]
fn a_pack_warns_when_the_script_hasnt_the_ally_priorities_it_worked_out() {
    let dir = workdir("ally-priorities-script");
    let first = dir.join("first.w3x");
    assert!(!ok(&["pack", s(&fixture()), "-o", s(&first)]).contains("warning:"), "the fixture's masks need no change");
    let project = dir.join("project");
    unpack(&first, &project);
    let info = project.join("map/war3map.w3i.json");
    let mut v: serde_json::Value = serde_json::from_str(&fs::read_to_string(&info).unwrap()).unwrap();
    let mut second = v["players"][0].clone();
    second["id"] = 1.into();
    second["start"] = serde_json::json!([0.0, 1280.0]);
    v["players"].as_array_mut().unwrap().push(second);
    fs::write(&info, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    let script = project.join("map/war3map.j");
    let original = fs::read_to_string(&script).unwrap();
    assert!(!original.contains("InitAllyPriorities"));
    let out = ok(&["pack", s(&project), "-o", s(&dir.join("stale.w3x"))]);
    assert!(out.contains("warning: map/war3map.j: InitAllyPriorities doesn't set the ally priorities"), "{out}");
    // As the app's generator writes it for these two players (setup.ts playersSection).
    let prio = "function InitAllyPriorities takes nothing returns nothing\r\n\r\n    call SetStartLocPrioCount( 0, 1 )\r\n    \
                call SetStartLocPrio( 0, 0, 1, MAP_LOC_PRIO_HIGH )\r\n\r\n    call SetStartLocPrioCount( 1, 1 )\r\n    \
                call SetStartLocPrio( 1, 0, 0, MAP_LOC_PRIO_HIGH )\r\nendfunction\r\n";
    fs::write(&script, format!("{original}{prio}")).unwrap();
    let out = ok(&["pack", s(&project), "-o", s(&dir.join("matching.w3x"))]);
    assert!(!out.contains("warning:"), "{out}");
}

#[test]
fn verify_finds_no_map_in_an_empty_folder_and_says_so() {
    let dir = workdir("verify-empty");
    let empty = dir.join("empty");
    fs::create_dir_all(&empty).unwrap();
    fs::write(empty.join("notes.txt"), "hello").unwrap();
    let o = w3proj(&["verify", s(&empty), "--game", "none"]);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert!(String::from_utf8_lossy(&o.stderr).contains("no maps"), "{}", text(&o));
    assert!(!text(&o).contains("0 ok"), "{}", text(&o));
    // A bad file path is a failed map, reported once, not as "no maps".
    let o = w3proj(&["verify", s(&dir.join("missing.w3x")), "--game", "none"]);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert_eq!(text(&o).matches("missing.w3x").count(), 1, "{}", text(&o));
    // Control: a folder with one small map still verifies and exits 0.
    pack(&fixture(), &empty.join("Mini.w3x"));
    let o = w3proj(&["verify", s(&empty), "--game", "none"]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    assert!(text(&o).contains("1 ok"), "{}", text(&o));
}

/// The split terrain layout (map/terrain/, terrain with placed objects and regions) packs into the same map as the
/// flat war3map.w3e.txt and object files it was split from, keeps the derived files' record fresh (a pack without
/// --force-stale goes ahead), stays split when the map is unpacked into the project again, and merges back into
/// the very same flat files.
#[test]
fn a_split_terrain_packs_the_same_map_and_merges_back() {
    let dir = workdir("terrain_split");
    let first = dir.join("first.w3x");
    pack(&fixture(), &first);
    let flat_text = fs::read(fixture().join("map/war3map.w3e.txt")).unwrap();
    const OBJECTS: [&str; 3] = ["war3map.doo.json", "war3mapUnits.doo.json", "war3map.w3r.json"];
    let grid = vec!["sw:0,0,2,1", "se:2,0,3,1", "nw:0,1,2,2", "ne:2,1,3,2"];
    for (name, rects) in [("main", vec![]), ("grid", grid.clone())] {
        let project = dir.join(format!("project-{name}"));
        unpack(&first, &project);
        let flat_objects: Vec<Vec<u8>> = OBJECTS.iter().map(|f| fs::read(project.join("map").join(f)).unwrap()).collect();
        let mut args = vec!["terrain", "split", s(&project)];
        for r in &rects {
            args.extend(["--rect", r]);
        }
        let said = ok(&args);
        assert!(said.contains("terrain split into map/terrain/"), "{said}");
        let map = project.join("map");
        assert!(!map.join("war3map.w3e.txt").exists());
        let folders: Vec<&str> = if rects.is_empty() { vec!["main"] } else { vec!["sw", "se", "nw", "ne"] };
        for f in &folders {
            for file in ["terrain.txt", "doodads.json", "units.json", "regions.json"] {
                assert!(map.join("terrain").join(f).join(file).is_file(), "{f}/{file}");
            }
        }
        for f in OBJECTS {
            assert!(!map.join(f).exists(), "{name}: {f} stayed flat");
        }
        let layout = fs::read_to_string(map.join("terrain/terrain.json")).unwrap();
        assert!(layout.contains("\"dooHeader\": {") && layout.contains("\"objects\": {"), "{layout}");
        // The mini map has no shadows and minimap image: the store lacks them, so only the flag packs it (as the map was).
        let second = dir.join(format!("{name}.w3x"));
        ok(&["pack", s(&project), "-o", s(&second), "--allow-terrain-only-derived"]);
        assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap(), "{name}: the split project packs another map");

        // Unpacked again, the project keeps its layout and nothing in it changes.
        let resync = unpack(&first, &project);
        assert!(resync.contains("0 written"), "{resync}");
        assert!(!map.join("war3map.w3e.txt").exists() && map.join("terrain/terrain.json").is_file());

        let said = ok(&["terrain", "merge", s(&project)]);
        assert!(said.contains("merged into map/war3map.w3e.txt"), "{said}");
        assert_eq!(fs::read(map.join("war3map.w3e.txt")).unwrap(), flat_text, "{name}: merged back into another text");
        for (f, bytes) in OBJECTS.iter().zip(&flat_objects) {
            assert_eq!(&fs::read(map.join(f)).unwrap(), bytes, "{name}: {f} merged back into another file");
        }
        assert!(!map.join("terrain").exists(), "{name}: map/terrain/ is left behind");
        let third = dir.join(format!("{name}-merged.w3x"));
        pack(&project, &third);
        assert_eq!(fs::read(&first).unwrap(), fs::read(&third).unwrap());
    }

    // The footman (creation number 2) at 0,0 lies in sw; moved to the north-east, it goes into ne/units.json on the
    // next sync with its creation number, and only the two files change.
    let project = dir.join("project-move");
    unpack(&first, &project);
    let mut args = vec!["terrain", "split", s(&project)];
    for r in &grid {
        args.extend(["--rect", r]);
    }
    ok(&args);
    // Shadows and a minimap image as W3Proj Studio would have made them: every derived file is in the store, the record
    // fresh, so only the edit below stops the pack.
    for name in ["war3map.shd", "war3mapMap.blp"] {
        fs::write(project.join(".w3proj/derived").join(name), name.as_bytes()).unwrap();
    }
    let units = |sub: &str| -> serde_json::Value { serde_json::from_slice(&fs::read(project.join(format!("map/terrain/{sub}/units.json"))).unwrap()).unwrap() };
    let mut sw = units("sw");
    assert_eq!(sw["units"][0]["editorId"], 2);
    assert_eq!(units("ne")["units"].as_array().unwrap().len(), 0);
    sw["units"][0]["position"] = serde_json::json!([300.0, 200.0, 0.0]);
    fs::write(project.join("map/terrain/sw/units.json"), serde_json::to_vec_pretty(&sw).unwrap()).unwrap();
    let moved = dir.join("moved.w3x");
    // A subterrain's units.json is a source of the derived files: the pack sees the edit.
    let o = w3proj(&["pack", s(&project), "-o", s(&moved)]);
    assert!(!o.status.success() && text(&o).contains("map/terrain/sw/units.json changed"), "{}", text(&o));
    ok(&["pack", s(&project), "-o", s(&moved), "--force-stale"]);
    let said = unpack(&moved, &project);
    assert!(said.contains("2 written"), "{said}");
    assert_eq!(units("sw")["units"].as_array().unwrap().len(), 0);
    let ne = units("ne");
    assert_eq!(ne["units"][0]["editorId"], 2);
    assert_eq!(ne["units"][0]["position"], serde_json::json!([300.0, 200.0, 0.0]));

    // A split that would drop corners (the rest of the canvas isn't one corner value) writes nothing.
    let project = dir.join("project-partial");
    unpack(&first, &project);
    let o = w3proj(&["terrain", "split", s(&project), "--rect", "corner:0,0,2,2"]);
    assert!(!o.status.success(), "{}", text(&o));
    assert!(text(&o).contains("would be lost"), "{}", text(&o));
    assert!(!project.join("map/terrain").exists());
    assert_eq!(fs::read(project.join("map/war3map.w3e.txt")).unwrap(), flat_text);
    // Merging a flat project, splitting a split one: refused.
    assert!(!w3proj(&["terrain", "merge", s(&project)]).status.success());
    ok(&["terrain", "split", s(&project)]);
    assert!(!w3proj(&["terrain", "split", s(&project)]).status.success());
}

/// The Pathing tool's file of the mini map (16×8 pathing cells) with overrides over both seams of the 2×2 grid below, as
/// app/src/lib/terrain/resize.ts pathingOverridesText writes it.
const PATHING: &str = "{\n  \"format\": \"w3proj.pathing/1\",\n  \"width\": 16,\n  \"height\": 8,\n  \"cells\": [\n    [6,2,2,8],\n    [7,2,2,8],\n    [8,2,2,8],\n    [9,2,2,8],\n    [3,3,0,8],\n    [3,4,0,8],\n    [15,7,2,0]\n  ]\n}\n";
const GRID: [&str; 4] = ["sw:0,0,2,1", "se:2,0,3,1", "nw:0,1,2,2", "ne:2,1,3,2"];

/// Stage 3 of the split layout: the derived files leave `map/` (and git) for `.w3proj/derived/`, the Pathing tool's
/// overrides leave `.w3proj/pathing.json` for the subterrains' `pathing.txt`. A split moves both (the record stays
/// fresh, the project packs into the same map), a pack refuses derived files that are stale or missing and says why and
/// what to do, `--allow-terrain-only-derived` packs anyway and says so, an unpack over the split project writes the map's
/// derived files into the store, a damaged pathing.txt stops a pack, and a merge gives back both byte for byte.
#[test]
fn a_split_project_keeps_derived_files_and_pathing_out_of_git() {
    let dir = workdir("terrain_stage3");
    let first = dir.join("first.w3x");
    pack(&fixture(), &first);
    let project = dir.join("project");
    unpack(&first, &project);
    let (map, store) = (project.join("map"), project.join(".w3proj").join("derived"));
    // Shadows and a minimap image besides the mini map's pathing and minimap icons: all four derived files.
    fs::write(map.join("war3map.shd"), b"shadows").unwrap();
    fs::write(map.join("war3mapMap.blp"), b"minimap").unwrap();
    fs::write(project.join(".w3proj/pathing.json"), PATHING).unwrap();
    const DERIVED: [&str; 4] = ["war3map.wpm", "war3map.shd", "war3mapMap.blp", "war3map.mmp.json"];
    let derived: Vec<Vec<u8>> = DERIVED.iter().map(|f| fs::read(map.join(f)).unwrap()).collect();
    let flat = dir.join("flat.w3x");
    ok(&["pack", s(&project), "-o", s(&flat)]);

    let mut args = vec!["terrain", "split", s(&project)];
    for r in GRID {
        args.extend(["--rect", r]);
    }
    ok(&args);
    for (f, bytes) in DERIVED.iter().zip(&derived) {
        assert!(!map.join(f).exists(), "{f} stayed in map/");
        assert_eq!(&fs::read(store.join(f)).unwrap(), bytes, "{f} moved into the store as it was");
    }
    let ignore = fs::read_to_string(project.join(".gitignore")).unwrap();
    assert!(ignore.lines().any(|l| l == "/.w3proj/derived/") && ignore.lines().any(|l| l == "/.w3proj/derived-from.json"), "{ignore}");
    assert!(!project.join(".w3proj/pathing.json").exists());
    assert_eq!(fs::read_to_string(project.join(".w3proj/pathing.json.bak")).unwrap(), PATHING, "the old file is kept");
    let txt = |sub: &str| fs::read_to_string(map.join("terrain").join(sub).join("pathing.txt")).unwrap();
    assert_eq!(txt("sw"), "6..7 2 0a 02\n3 3 08 00\n");
    assert_eq!(txt("se"), "0..1 2 0a 02\n");
    assert_eq!(txt("nw"), "3 0 08 00\n");
    assert_eq!(txt("ne"), "7 3 02 02\n");
    // The record still says they follow (the sources are the same terrain): the pack goes ahead, the same map.
    let split = dir.join("split.w3x");
    ok(&["pack", s(&project), "-o", s(&split)]);
    assert_eq!(fs::read(&flat).unwrap(), fs::read(&split).unwrap(), "the split project packs another map");

    // An unpack over the split project writes the map's derived files into the store, never into map/.
    fs::remove_file(store.join("war3map.shd")).unwrap();
    unpack(&split, &project);
    assert_eq!(fs::read(store.join("war3map.shd")).unwrap(), b"shadows");
    assert!(DERIVED.iter().all(|f| !map.join(f).exists()), "an unpack wrote derived files into map/");
    assert_eq!(txt("sw"), "6..7 2 0a 02\n3 3 08 00\n", "an unpack keeps the pathing overrides");

    // A source edited: the pack refuses, naming the file, why and what to do; --force-stale packs.
    let out = dir.join("out.w3x");
    let sw_units = map.join("terrain/sw/units.json");
    let units_before = fs::read(&sw_units).unwrap();
    let mut doc: serde_json::Value = serde_json::from_slice(&units_before).unwrap();
    doc["units"][0]["position"] = serde_json::json!([10.0, -20.0, 0.0]);
    fs::write(&sw_units, serde_json::to_vec_pretty(&doc).unwrap()).unwrap();
    let o = w3proj(&["pack", s(&project), "-o", s(&out)]);
    let said = text(&o);
    assert!(!o.status.success() && said.contains("map/terrain/sw/units.json changed") && said.contains("w3proj rebuild") && said.contains("--allow-terrain-only-derived"), "{said}");
    ok(&["pack", s(&project), "-o", s(&out), "--force-stale"]);
    fs::write(&sw_units, &units_before).unwrap();

    // One missing: refused even with --force-stale; the flag leaves it out and says so.
    fs::remove_file(store.join("war3mapMap.blp")).unwrap();
    for extra in [None, Some("--force-stale")] {
        let mut args = vec!["pack", s(&project), "-o", s(&out)];
        args.extend(extra);
        let o = w3proj(&args);
        assert!(!o.status.success() && text(&o).contains("war3mapMap.blp is missing in .w3proj/derived/"), "{extra:?}: {}", text(&o));
    }
    let said = ok(&["pack", s(&project), "-o", s(&out), "--allow-terrain-only-derived"]);
    assert!(said.contains("war3mapMap.blp left out of the map"), "{said}");
    let listed = ok(&["ls", s(&out)]);
    assert!(!listed.to_lowercase().contains("war3mapmap.blp") && listed.contains("war3map.shd"), "{listed}");
    fs::write(store.join("war3mapMap.blp"), b"minimap").unwrap();

    // A damaged pathing.txt stops a pack (never fewer overrides).
    fs::write(map.join("terrain/ne/pathing.txt"), "7 3 02 02\n<<<<<<< HEAD\n").unwrap();
    let o = w3proj(&["pack", s(&project), "-o", s(&out), "--force-stale"]);
    assert!(!o.status.success() && text(&o).contains("map/terrain/ne/pathing.txt line 2"), "{}", text(&o));
    fs::write(map.join("terrain/ne/pathing.txt"), "7 3 02 02\n").unwrap();

    // Merged: the derived files back in map/, the overrides back in .w3proj/pathing.json, byte for byte.
    fs::remove_file(project.join(".w3proj/pathing.json.bak")).unwrap();
    ok(&["terrain", "merge", s(&project)]);
    for (f, bytes) in DERIVED.iter().zip(&derived) {
        assert_eq!(&fs::read(map.join(f)).unwrap(), bytes, "{f} back in map/");
    }
    assert!(!store.exists(), "the store is left behind");
    assert_eq!(fs::read_to_string(project.join(".w3proj/pathing.json")).unwrap(), PATHING);
    assert!(!map.join("terrain").exists());
    let merged = dir.join("merged.w3x");
    ok(&["pack", s(&project), "-o", s(&merged)]);
    assert_eq!(fs::read(&flat).unwrap(), fs::read(&merged).unwrap());
}

/// A flat project is as before: its derived files stay in map/, its pathing overrides in .w3proj/pathing.json, a pack
/// takes them without a store or the new flag, and nothing of the split layout's appears.
#[test]
fn a_flat_project_keeps_its_derived_files_in_map() {
    let dir = workdir("terrain_stage3_flat");
    let first = dir.join("first.w3x");
    pack(&fixture(), &first);
    let project = dir.join("project");
    unpack(&first, &project);
    fs::write(project.join(".w3proj/pathing.json"), PATHING).unwrap();
    let before = files(&project);
    let second = dir.join("second.w3x");
    ok(&["pack", s(&project), "-o", s(&second)]);
    assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap());
    assert_eq!(files(&project), before, "a flat project's pack moves nothing");
    assert!(project.join("map/war3map.wpm").is_file() && !project.join(".w3proj/derived").exists());
    // Unpacked again: nothing written, the derived files in map/.
    let said = unpack(&first, &project);
    assert!(said.contains("0 written"), "{said}");
    assert!(project.join("map/war3map.wpm").is_file() && !project.join(".w3proj/derived").exists());
    // A stale record still stops its pack as before; --force-stale goes on.
    fs::write(project.join("map/war3map.doo.json"), fs::read(project.join("map/war3map.doo.json")).unwrap().iter().chain(b"\n").copied().collect::<Vec<u8>>()).unwrap();
    let o = w3proj(&["pack", s(&project), "-o", s(&second)]);
    assert!(!o.status.success() && text(&o).contains("map/war3map.doo.json changed"), "{}", text(&o));
    ok(&["pack", s(&project), "-o", s(&second), "--force-stale"]);
}

/// `w3proj terrain seams` (the app's Check Terrain Seams, run in Node): two edits of neighbouring subterrains, each fine
/// alone (a cliff of two levels), merged into a cliff of four across the seam, are reported (exit 1) with both corners
/// and subterrains; `w3proj pack` refuses them unless --allow-seam-issues, which says so. A flat project has no seams.
#[test]
fn terrain_seams_reports_two_merged_edits_and_a_pack_refuses_them() {
    let dir = workdir("terrain_seams");
    let map = dir.join("first.w3x");
    pack(&fixture(), &map);
    let project = dir.join("project");
    unpack(&map, &project);
    assert!(!w3proj(&["terrain", "seams", s(&project)]).status.success(), "flat: refused");
    let mut args = vec!["terrain", "split", s(&project)];
    for r in GRID {
        args.extend(["--rect", r]);
    }
    ok(&args);
    let said = ok(&["terrain", "seams", s(&project)]);
    assert!(said.contains("no seam issues: 6 seams"), "control: the split itself has none: {said}");
    // The mini map's grid: sw is 2×1 corners, se 3×1, all on level 2. Branch A raises sw's east corner (1,0) to 4,
    // branch B lowers se's west corner (2,0) to 0.
    let terrain = |sub: &str| project.join("map/terrain").join(sub).join("terrain.txt");
    let (sw, se) = (fs::read_to_string(terrain("sw")).unwrap(), fs::read_to_string(terrain("se")).unwrap());
    assert!(sw.contains("[layer] all 2\n") && se.contains("[layer] all 2\n"));
    let (sw_a, se_b) = (sw.replace("[layer] all 2\n", "[layer]\n24\n"), se.replace("[layer] all 2\n", "[layer]\n022\n"));
    for (file, edited, other, original) in [(terrain("sw"), &sw_a, terrain("se"), &se), (terrain("se"), &se_b, terrain("sw"), &sw)] {
        fs::write(&file, edited).unwrap();
        fs::write(&other, original).unwrap();
        let said = ok(&["terrain", "seams", s(&project)]);
        assert!(said.contains("no seam issues"), "one branch alone: {said}");
    }
    fs::write(terrain("sw"), &sw_a).unwrap();
    fs::write(terrain("se"), &se_b).unwrap();
    let o = w3proj(&["terrain", "seams", s(&project)]);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert!(text(&o).contains("error cliff-height: a cliff of 4 levels between 1,0 (sw) on level 4 and 2,0 (se) on level 0"), "{}", text(&o));
    let json: serde_json::Value = serde_json::from_str(&String::from_utf8_lossy(&w3proj(&["terrain", "seams", s(&project), "--json"]).stdout)).unwrap();
    assert_eq!(json["errors"], 1);
    assert_eq!(json["issues"][0]["corners"], serde_json::json!([{ "x": 1, "y": 0, "subterrain": "sw" }, { "x": 2, "y": 0, "subterrain": "se" }]));
    let out = dir.join("out.w3x");
    let o = w3proj(&["pack", s(&project), "-o", s(&out), "--allow-terrain-only-derived"]);
    assert!(!o.status.success() && text(&o).contains("the terrain's seams have 1 error") && text(&o).contains("--allow-seam-issues"), "{}", text(&o));
    assert!(!out.exists(), "a refused pack writes no map");
    let said = ok(&["pack", s(&project), "-o", s(&out), "--allow-terrain-only-derived", "--allow-seam-issues"]);
    assert!(said.contains("packed anyway (--allow-seam-issues)") && out.is_file(), "{said}");
    // The check never writes.
    assert_eq!(fs::read_to_string(terrain("sw")).unwrap(), sw_a);
    assert_eq!(fs::read_to_string(terrain("se")).unwrap(), se_b);
}

/// `w3proj terrain relayout`: subterrains joined, renamed and resized pack into the very same map, the derived files'
/// record stays fresh (a plain pack goes ahead), a renamed folder goes, the ranges follow, and a merge gives back the
/// flat files. One that would drop corners writes nothing.
#[test]
fn terrain_relayout_packs_the_same_map() {
    let dir = workdir("terrain_relayout");
    let first = dir.join("first.w3x");
    pack(&fixture(), &first);
    let project = dir.join("project");
    unpack(&first, &project);
    let flat_text = fs::read(project.join("map/war3map.w3e.txt")).unwrap();
    fs::write(project.join(".w3proj/pathing.json"), PATHING).unwrap();
    let mut args = vec!["terrain", "split", s(&project)];
    for r in GRID {
        args.extend(["--rect", r]);
    }
    ok(&args);
    for name in ["war3map.shd", "war3mapMap.blp"] {
        fs::write(project.join(".w3proj/derived").join(name), name.as_bytes()).unwrap();
    }
    let split = dir.join("split.w3x");
    ok(&["pack", s(&project), "-o", s(&split)]);
    let map = project.join("map");
    let before = files(&project);
    let o = w3proj(&["terrain", "relayout", s(&project), "--rect", "sw:0,0,2,1", "--rect", "nw:0,1,2,2", "--rect", "ne:2,1,3,2"]);
    assert!(!o.status.success() && text(&o).contains("would be lost"), "{}", text(&o));
    assert_eq!(files(&project), before, "a refused relayout wrote something");
    let said = ok(&["terrain", "relayout", s(&project), "--rect", "south=sw+se:0,0,5,1", "--rect", "west=nw:0,1,3,2", "--rect", "ne:3,1,2,2"]);
    assert!(said.contains("subterrains changed"), "{said}");
    assert!(!map.join("terrain/sw").exists() && !map.join("terrain/nw").exists() && map.join("terrain/south/terrain.txt").is_file() && map.join("terrain/west/units.json").is_file());
    let layout = fs::read_to_string(map.join("terrain/terrain.json")).unwrap();
    assert!(layout.contains("\"name\": \"south\",\n      \"folder\": \"south\",\n      \"x\": 0,\n      \"y\": 0,\n      \"w\": 5,\n      \"h\": 1,\n      \"idRange\": [[10000, 19999], [20000, 29999]]"), "{layout}");
    let relaid = dir.join("relaid.w3x");
    ok(&["pack", s(&project), "-o", s(&relaid)]);
    assert_eq!(fs::read(&split).unwrap(), fs::read(&relaid).unwrap(), "the changed subterrains pack another map");
    ok(&["terrain", "merge", s(&project)]);
    assert_eq!(fs::read(map.join("war3map.w3e.txt")).unwrap(), flat_text);
    assert_eq!(fs::read_to_string(project.join(".w3proj/pathing.json")).unwrap(), PATHING);
}

/// `w3proj terrain check`: a split project's creation numbers. Numbers outside a subterrain's range are information
/// (exit 0); a number in two subterrains' files is an error naming both (exit 1), and the same duplicate stops a pack,
/// naming both files. A flat project without numbers twice passes.
#[test]
fn terrain_check_lists_duplicates_and_a_pack_refuses_them() {
    let dir = workdir("terrain_check");
    let map = dir.join("first.w3x");
    pack(&fixture(), &map);
    let project = dir.join("project");
    unpack(&map, &project);
    assert!(ok(&["terrain", "check", s(&project)]).contains("0 found twice"), "flat: checked, nothing twice");
    let mut args = vec!["terrain", "split", s(&project)];
    for r in ["sw:0,0,2,1", "se:2,0,3,1", "nw:0,1,2,2", "ne:2,1,3,2"] {
        args.extend(["--rect", r]);
    }
    ok(&args);
    // The mini map's numbers (footman 2, doodads 0 and 1, region 0) lie below every range: information only.
    let said = ok(&["terrain", "check", s(&project)]);
    assert!(said.contains("info: 1 units in \"sw\" have numbers outside its idRange (2)") && said.contains("0 found twice"), "{said}");
    let json: serde_json::Value = serde_json::from_str(&ok(&["terrain", "check", s(&project), "--json"])).unwrap();
    assert_eq!(json["duplicates"], serde_json::json!([]));
    // The footman's number given to a unit in ne as well (a merge of two branches that both took it).
    let ne = project.join("map/terrain/ne/units.json");
    let sw: serde_json::Value = serde_json::from_slice(&fs::read(project.join("map/terrain/sw/units.json")).unwrap()).unwrap();
    let mut twin = sw["units"][0].clone();
    twin["position"] = serde_json::json!([300.0, 200.0, 0.0]);
    fs::write(&ne, serde_json::to_vec_pretty(&serde_json::json!({"units": [twin]})).unwrap()).unwrap();
    let o = w3proj(&["terrain", "check", s(&project)]);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert!(text(&o).contains("error: creation number 2 (units) is in map/terrain/sw/units.json and map/terrain/ne/units.json"), "{}", text(&o));
    let o = w3proj(&["pack", s(&project), "-o", s(&dir.join("twice.w3x")), "--force-stale", "--allow-terrain-only-derived"]);
    assert!(!o.status.success() && text(&o).contains("creation number 2 is in map/terrain/sw/units.json and in map/terrain/ne/units.json"), "{}", text(&o));
}


/// `w3proj terrain fix-ids` on the pattern of a real map that couldn't be split (wowr4.6: creation number 581 on three
/// stacked doodads, the last an exact copy of the one before): `terrain check` lists all three in the flat project, the
/// split names all three and points at the fix, fix-ids without --apply only prints the plan; --renumber --apply changes
/// the two numbers and nothing else (the packed war3map.doo differs in their eight bytes only), and the map then splits,
/// merges back and packs the same. --delete-copies takes only the copy.
#[test]
fn fix_ids_renumbers_numbers_found_twice_and_nothing_else() {
    let dir = workdir("fix_ids");
    let map = dir.join("first.w3x");
    pack(&fixture(), &map);
    let project = dir.join("project");
    unpack(&map, &project);
    let doo_path = project.join("map/war3map.doo.json");
    let mut doo: serde_json::Value = serde_json::from_slice(&fs::read(&doo_path).unwrap()).unwrap();
    let list = doo["doodads"].as_array_mut().unwrap();
    let mut lt = list[1].clone();
    lt["position"] = serde_json::json!([96.0, 96.0, 0.0]);
    lt["editorId"] = 581.into();
    let mut other = lt.clone();
    other["variation"] = 1.into();
    list.extend([other, lt.clone(), lt]);
    fs::write(&doo_path, serde_json::to_vec_pretty(&doo).unwrap()).unwrap();
    // As unpack writes it, so the plan's file differs from it by the numbers only.
    let twice = dir.join("twice.w3x");
    ok(&["pack", s(&project), "-o", s(&twice), "--force-stale"]);
    unpack(&twice, &project);
    let o = w3proj(&["terrain", "check", s(&project)]);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    for m in ["map/war3map.doo.json [2]", "map/war3map.doo.json [3]", "map/war3map.doo.json [4]", "an exact copy of [3]", "fix-ids"] {
        assert!(text(&o).contains(m), "{m}: {}", text(&o));
    }
    let o = w3proj(&["terrain", "split", s(&project)]);
    assert!(!o.status.success() && text(&o).contains("doodads[2], doodads[3] and doodads[4] have the same creation number 581") && text(&o).contains("fix-ids"), "{}", text(&o));
    let before = files(&project);
    let plan = ok(&["terrain", "fix-ids", s(&project), "--renumber"]);
    assert!(plan.contains("[3] ") && plan.contains("gets 582") && plan.contains("gets 583") && plan.contains("--apply"), "{plan}");
    assert_eq!(files(&project), before, "a plan wrote something");
    let said = ok(&["terrain", "fix-ids", s(&project), "--renumber", "--apply"]);
    assert!(said.contains("wrote map/war3map.doo.json"), "{said}");
    let after = files(&project);
    let changed: Vec<&String> = after.keys().filter(|k| before.get(*k) != after.get(*k)).collect();
    assert_eq!(changed, ["map/war3map.doo.json"]);
    let fixed = dir.join("fixed.w3x");
    ok(&["pack", s(&project), "-o", s(&fixed), "--force-stale"]);
    let (a, b) = (w3proj(&["cat", s(&twice), "war3map.doo"]).stdout, w3proj(&["cat", s(&fixed), "war3map.doo"]).stdout);
    assert_eq!(a.len(), b.len());
    let differ: Vec<usize> = (0..a.len()).filter(|&i| a[i] != b[i]).collect();
    // 581, 582 and 583 differ in their lowest byte only (0x45, 0x46, 0x47; little-endian u32).
    let got: Vec<(u8, u8)> = differ.iter().map(|&i| (a[i], b[i])).collect();
    assert_eq!(got, [(0x45, 0x46), (0x45, 0x47)], "only the two numbers' bytes differ: at {differ:?}");
    ok(&["terrain", "check", s(&project)]);
    ok(&["terrain", "split", s(&project)]);
    ok(&["terrain", "merge", s(&project)]);
    let again = dir.join("again.w3x");
    ok(&["pack", s(&project), "-o", s(&again), "--force-stale"]);
    assert_eq!(w3proj(&["cat", s(&again), "war3map.doo"]).stdout, b, "split and merged back, the same doodads");

    // Delete Copies on the map as it was: only the copy goes, the one that differs stays and is said.
    let project = dir.join("project2");
    unpack(&twice, &project);
    let said = ok(&["terrain", "fix-ids", s(&project), "--delete-copies", "--apply"]);
    assert!(said.contains("deleted") && said.contains("stays (not an exact copy)") && said.contains("1 deleted, 2 still sharing a number"), "{said}");
    let doo: serde_json::Value = serde_json::from_slice(&fs::read(project.join("map/war3map.doo.json")).unwrap()).unwrap();
    assert_eq!(doo["doodads"].as_array().unwrap().len(), 4);
    assert!(!w3proj(&["terrain", "split", s(&project)]).status.success(), "two that differ still share 581");
}

/// `w3proj terrain merge-hook`: installed into a real repository whose project lies in a folder with a space, the
/// post-merge hook stays silent after a merge that touched one subterrain and reports the seam check's error after one
/// that brought two branches' edits of two subterrains together (the cliff of the seams test); installing again
/// changes nothing; a Git LFS-style post-merge hook that was there first keeps its text and runs too, and --remove
/// takes out only this hook's block; a hook that isn't an sh script is never touched.
#[test]
fn the_merge_hook_checks_the_seams_after_a_merge() {
    let dir = workdir("merge_hook");
    let repo = dir.join("repo");
    let project = repo.join("maps").join("My Map");
    let map = dir.join("first.w3x");
    pack(&fixture(), &map);
    unpack(&map, &project);
    let mut args = vec!["terrain", "split", s(&project)];
    for r in GRID {
        args.extend(["--rect", r]);
    }
    ok(&args);
    let git = |args: &[&str]| -> Output {
        let o = Command::new("git")
            .args(["-c", "user.name=w3proj test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(&repo)
            .env_remove("W3PROJ_BIN")
            .output()
            .expect("git runs");
        assert!(o.status.success(), "git {args:?}: {}", text(&o));
        o
    };
    git(&["init", "-q"]);
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "base"]);
    // A post-merge hook as Git LFS installs one (as soon as a project has LFS rules) is there first.
    let hook = PathBuf::from(String::from_utf8_lossy(&git(&["rev-parse", "--absolute-git-dir"]).stdout).trim()).join("hooks").join("post-merge");
    let lfs = "#!/bin/sh\ncommand -v git >/dev/null 2>&1 || { printf >&2 \"no git\\n\"; exit 2; }\necho \"lfs-style post-merge ran ($#)\"\n";
    fs::create_dir_all(hook.parent().unwrap()).unwrap();
    fs::write(&hook, lfs).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let said = ok(&["terrain", "merge-hook", s(&project)]);
    assert!(said.contains("added to") && said.contains("kept"), "{said}");
    let text_of_hook = fs::read_to_string(&hook).unwrap();
    assert!(text_of_hook.contains("project='maps/My Map/'"), "{text_of_hook}");
    assert!(text_of_hook.starts_with("#!/bin/sh\n# >>> w3proj terrain merge-hook: begin >>>\n"), "{text_of_hook}");
    assert!(text_of_hook.ends_with(&lfs["#!/bin/sh\n".len()..]), "the LFS hook's text is all kept, after the block: {text_of_hook}");
    assert!(ok(&["terrain", "merge-hook", s(&project)]).contains("updated"));
    assert_eq!(fs::read_to_string(&hook).unwrap(), text_of_hook, "installing again changes nothing");

    let terrain = |sub: &str| project.join("map/terrain").join(sub).join("terrain.txt");
    let (sw, se) = (fs::read_to_string(terrain("sw")).unwrap(), fs::read_to_string(terrain("se")).unwrap());
    let base = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]).stdout).trim().to_string();
    // A branch that touches one subterrain, merged (a fast-forward): the hook stays silent.
    git(&["checkout", "-q", "-b", "one", &base]);
    fs::write(project.join("map/terrain/ne/units.json"), fs::read_to_string(project.join("map/terrain/ne/units.json")).unwrap() + "\n").unwrap();
    git(&["commit", "-q", "-am", "ne only"]);
    git(&["checkout", "-q", "main"]);
    let quiet = git(&["merge", "--no-edit", "-q", "one"]);
    assert!(!text(&quiet).contains("w3proj:"), "one subterrain: the hook stays silent: {}", text(&quiet));
    assert!(text(&quiet).contains("lfs-style post-merge ran (1)"), "the LFS hook still runs, with git's argument: {}", text(&quiet));
    // Branch B lowers se's west corner; main raises sw's east one; each alone is fine, merged a cliff of 4 levels.
    git(&["checkout", "-q", "-b", "b", &base]);
    fs::write(terrain("se"), se.replace("[layer] all 2\n", "[layer]\n022\n")).unwrap();
    git(&["commit", "-q", "-am", "se"]);
    git(&["checkout", "-q", "main"]);
    fs::write(terrain("sw"), sw.replace("[layer] all 2\n", "[layer]\n24\n")).unwrap();
    git(&["commit", "-q", "-am", "sw"]);
    let merged = git(&["merge", "--no-edit", "-q", "b"]);
    let said = text(&merged);
    assert!(said.contains("w3proj: the merged branches changed 3 subterrain(s)") && said.contains("cliff-height") && said.contains("seam issues"), "{said}");
    assert!(said.contains("lfs-style post-merge ran"), "both hooks run on the merge: {said}");

    // --remove takes out only the block: the LFS hook is as it was, and removing it again is refused.
    assert!(ok(&["terrain", "merge-hook", s(&project), "--remove"]).contains("the rest of it is left"));
    assert_eq!(fs::read_to_string(&hook).unwrap(), lfs);
    assert!(!w3proj(&["terrain", "merge-hook", s(&project), "--remove"]).status.success(), "someone else's isn't removed");
    assert_eq!(fs::read_to_string(&hook).unwrap(), lfs);

    // A post-merge hook that isn't an sh script: left as it is, the line to add is printed.
    let python = "#!/usr/bin/env python3\nprint('mine')\n";
    fs::write(&hook, python).unwrap();
    let o = w3proj(&["terrain", "merge-hook", s(&project)]);
    assert!(!o.status.success() && text(&o).contains("isn't an sh script") && text(&o).contains("terrain seams"), "{}", text(&o));
    assert_eq!(fs::read_to_string(&hook).unwrap(), python);
    assert!(!w3proj(&["terrain", "merge-hook", s(&project), "--remove"]).status.success(), "someone else's isn't removed");
    assert_eq!(fs::read_to_string(&hook).unwrap(), python);
    // A hook written before the block existed (MARK alone) is all ours: replaced, then removed with its file.
    fs::write(&hook, "#!/bin/sh\n# w3proj terrain merge-hook\necho old\n").unwrap();
    assert!(ok(&["terrain", "merge-hook", s(&project)]).contains("updated"));
    assert!(!fs::read_to_string(&hook).unwrap().contains("echo old"));
    fs::remove_file(&hook).unwrap();
    ok(&["terrain", "merge-hook", s(&project)]);
    assert!(ok(&["terrain", "merge-hook", s(&project), "--remove"]).contains("removed") && !hook.exists());
}
