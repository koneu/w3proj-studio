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

/// The made-up TriggerData.txt the fixture's war3map.wtg is read with (nothing from the game).
fn trigger_data() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/TriggerData.txt")
}

/// Unpacks with the made-up TriggerData, so the trigger codec really runs.
fn unpack(map: &Path, project: &Path) -> String {
    ok(&["unpack", s(map), s(project), "--game", "none", "--trigger-data", s(&trigger_data())])
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
    unpack(&first, &project);
    pack(&project, &second);

    assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap(), "the map changed");

    let (want, got) = (files(&fixture().join("map")), files(&project.join("map")));
    assert_eq!(want.keys().collect::<Vec<_>>(), got.keys().collect::<Vec<_>>());
    for (name, bytes) in &want {
        assert!(*bytes == got[name], "{name} came back different");
    }
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
    let (want, got) = (files(&fixture().join("map")), files(&project.join("map")));
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
        ("war3map.w3u", "objdata-json"),
        ("war3map.w3e", "w3e-text"),
        ("war3map.wtg", "wtg-json"),
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
    unpack(&first, &project);

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
        return; // as root every folder can be searched: nothing to show
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
    let mut child = Command::new(env!("CARGO_BIN_EXE_w3proj"))
        .args(args)
        .env_remove("W3PROJ_FORMATS")
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
    for i in 0..600 {
        fs::copy(&one, maps.join(format!("{}_{i:04}.w3x", "a".repeat(100)))).unwrap();
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
    for i in 0..40 {
        // Growing sizes, so that the biggest, which start first, finish last.
        let mut b = bytes.clone();
        b.extend(std::iter::repeat_n(0u8, i * 4096));
        fs::write(maps.join(format!("m{i:02}.w3x")), b).unwrap();
    }
    fs::write(maps.join("m13_bad.w3x"), b"this is not an archive").unwrap();
    fs::write(maps.join("sub/m99_bad.w3m"), &bytes[..bytes.len() / 2]).unwrap();
    let run = |jobs: &str, quiet: bool| {
        let mut args = vec!["verify", s(&maps), "--game", "none"];
        if quiet {
            args.push("-q");
        }
        let o = Command::new(env!("CARGO_BIN_EXE_w3proj")).args(&args).env("W3PROJ_VERIFY_JOBS", jobs).env_remove("W3PROJ_FORMATS").output().unwrap();
        (o.status.code(), text(&o))
    };
    for quiet in [false, true] {
        let (code1, one_thread) = run("1", quiet);
        let (code8, many_threads) = run("8", quiet);
        assert_eq!(code1, Some(1), "the bad maps must make it fail: {one_thread}");
        assert_eq!(code1, code8);
        assert!(one_thread.contains("m13_bad.w3x") && one_thread.contains("m39.w3x") || quiet, "{one_thread}");
        assert_eq!(one_thread, many_threads);
    }
}

#[test]
fn the_trigger_codec_really_runs() {
    let dir = workdir("wtg");
    let (first, project, edited) = (dir.join("first.w3x"), dir.join("project"), dir.join("edited.w3x"));
    pack(&fixture(), &first);

    // Binary in the map, JSON in the project: not a raw passthrough.
    let bin = w3proj(&["cat", s(&first), "war3map.wtg"]).stdout;
    assert_eq!(&bin[..4], b"WTG!");
    unpack(&first, &project);
    assert!(!project.join("map/war3map.wtg").exists());
    assert!(project.join("map/war3map.wtg.json").exists());

    // An edit of the JSON reaches the binary.
    let path = project.join("map/war3map.wtg.json");
    fs::write(&path, fs::read_to_string(&path).unwrap().replace("Foo Init", "Bar Init")).unwrap();
    pack(&project, &edited);
    let bin = w3proj(&["cat", s(&edited), "war3map.wtg"]).stdout;
    assert!(bin.windows(8).any(|w| w == b"Bar Init"));
    assert!(!bin.windows(8).any(|w| w == b"Foo Init"));
}

#[test]
fn a_function_missing_from_trigger_data_leaves_the_file_raw_and_undamaged() {
    let dir = workdir("wtg_unknown");
    let (first, project, second) = (dir.join("first.w3x"), dir.join("project"), dir.join("second.w3x"));
    pack(&fixture(), &first);

    // The same data without DoFooThing, which the fixture's trigger uses.
    let data = dir.join("TriggerData.txt");
    let full = fs::read_to_string(trigger_data()).unwrap();
    let cut: String = full.lines().filter(|l| !l.starts_with("DoFooThing")).map(|l| format!("{l}
")).collect();
    assert_ne!(full.len(), cut.len(), "the control line wasn't there");
    fs::write(&data, cut).unwrap();

    let out = ok(&["unpack", s(&first), s(&project), "--game", "none", "--trigger-data", s(&data)]);
    assert!(out.contains("raw war3map.wtg"), "{out}");
    assert!(out.contains("unknown trigger function \"DoFooThing\""), "{out}");
    assert!(!project.join("map/war3map.wtg.json").exists());
    let kept = fs::read(project.join("map/war3map.wtg")).unwrap();
    assert_eq!(kept, w3proj(&["cat", s(&first), "war3map.wtg"]).stdout, "the raw file changed");

    pack(&project, &second);
    assert_eq!(fs::read(first).unwrap(), fs::read(second).unwrap());
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
