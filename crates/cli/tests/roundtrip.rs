//! System tests of the real `w3proj` binary on a tiny project made up for the tests
//! (`tests/fixtures/mini-map`): nothing here needs the game or third-party maps, so it runs in CI.
//! The promise under test is the project's core one: pack → unpack → pack changes nothing.

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
    Command::new(env!("CARGO_BIN_EXE_w3proj")).args(args).env_remove("W3PROJ_FORMATS").output().unwrap()
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

fn pack(project: &Path, out: &Path) {
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
    ok(&["unpack", s(&first), s(&project), "--game", "none"]);
    pack(&project, &second);

    assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap(), "the map changed");

    let (want, got) = (files(&fixture().join("map")), files(&project.join("map")));
    assert_eq!(want.keys().collect::<Vec<_>>(), got.keys().collect::<Vec<_>>());
    for (name, bytes) in &want {
        assert!(*bytes == got[name], "{name} came back different");
    }
}

#[test]
fn packing_twice_gives_the_same_bytes() {
    let dir = workdir("deterministic");
    let (a, b) = (dir.join("a.w3x"), dir.join("b.w3x"));
    pack(&fixture(), &a);
    pack(&fixture(), &b);
    assert_eq!(fs::read(a).unwrap(), fs::read(b).unwrap());
}

#[test]
fn verify_finds_every_codec_at_work() {
    let dir = workdir("verify");
    let map = dir.join("mini.w3x");
    pack(&fixture(), &map);
    let baseline = dir.join("baseline.tsv");
    ok(&["verify", s(&map), "--game", "none", "--baseline", s(&baseline), "--update-baseline"]);

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
        ("war3map.w3u", "objdata-json"),
        ("war3map.w3e", "w3e-text"),
    ] {
        assert_eq!(codec(file).as_deref(), Some(id), "{file} in\n{table}");
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
    ok(&["unpack", s(&first), s(&project), "--game", "none"]);

    let path = project.join("map/war3map.w3r.json");
    fs::write(&path, fs::read_to_string(&path).unwrap().replace("Middle", "Edited")).unwrap();
    pack(&project, &edited);

    let o = w3proj(&["cat", s(&edited), "war3map.w3r"]);
    assert!(String::from_utf8_lossy(&o.stdout).contains("Edited"));
    assert_ne!(fs::read(first).unwrap(), fs::read(edited).unwrap());
}

#[test]
fn a_project_file_that_makes_no_sense_stops_the_pack() {
    let dir = workdir("broken");
    let (first, project, out) = (dir.join("first.w3x"), dir.join("project"), dir.join("out.w3x"));
    pack(&fixture(), &first);
    ok(&["unpack", s(&first), s(&project), "--game", "none"]);

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
    ok(&["unpack", s(&first), s(&project), "--game", "none"]);
    let before = files(&project.join("map"));

    // A stray file disappears, because the project mirrors the map.
    fs::write(project.join("map/stray.txt"), "left over").unwrap();
    ok(&["unpack", s(&first), s(&project), "--game", "none"]);

    assert_eq!(before, files(&project.join("map")));
    pack(&project, &second);
    assert_eq!(fs::read(first).unwrap(), fs::read(second).unwrap());
}
