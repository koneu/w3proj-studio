//! `w3proj rebuild` end to end: the real binary, Node running the app's code (app/src/headless), the installed game.
//! On a copy of the mini map: what is made, what pack takes afterwards, what is skipped when nothing changed. Needs the
//! game (W3PROJ_GAME, else the main checkout's `.game-path`, as tests/gamepath.mjs finds it) and Node with the app's
//! packages installed: without the game the tests that need it say so and pass (they fail under W3PROJ_REQUIRE_CORPUS=1), as the corpus tests do. That the
//! files are the app's own bytes is app-smoke's `rebuildCli` (the app and the CLI on copies of one project).

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mini-map")
}

fn workdir(test: &str) -> PathBuf {
    // The gate runs these tests twice at once in one checkout (debug, and release on the corpus): a folder per build.
    let build = if cfg!(debug_assertions) { "" } else { "-release" };
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("rebuild-{test}{build}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let target = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &target);
        } else {
            fs::copy(e.path(), &target).unwrap();
        }
    }
}

/// The game folder, or None when this machine has none set up.
fn game() -> Option<String> {
    if let Ok(g) = std::env::var("W3PROJ_GAME") {
        return Some(g);
    }
    let common = Command::new("git")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .ok()?;
    let main = Path::new(String::from_utf8_lossy(&common.stdout).trim()).parent()?.to_path_buf();
    let text = fs::read_to_string(main.join(".game-path")).ok()?;
    // One folder per line; the first that exists wins (a checkout shared by a Windows and a Linux machine), as in tests/gamepath.mjs.
    let listed: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).collect();
    // None when none exists: a folder that isn't there is no game, and the tests say so (or fail, when required).
    listed.iter().find(|l| Path::new(l).exists()).map(|l| l.to_string())
}

/// Runs the CLI with `game`. A pack checks the GUI functions of map/triggers/ with the made-up TriggerData.txt the mini
/// map's triggers are written in (tests/fixtures/TriggerData.txt), not the game's, which doesn't know them.
fn w3proj(args: &[&str], game: &str) -> Output {
    let data = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/TriggerData.txt");
    let mut cmd = common::w3proj_cmd();
    cmd.args(args);
    if args.first() == Some(&"pack") {
        cmd.arg("--trigger-data").arg(&data);
    }
    cmd.env("W3PROJ_GAME", game).output().unwrap()
}

fn text(o: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

/// The derived files and the record, as bytes (None: not there).
fn derived(project: &Path) -> Vec<Option<Vec<u8>>> {
    ["map/war3map.wpm", "map/war3map.shd", "map/war3mapMap.blp", "map/war3map.mmp.json", "build/derived-from.json"]
        .iter()
        .map(|f| fs::read(project.join(f)).ok())
        .collect()
}

#[test]
fn rebuild_makes_what_pack_takes_skips_what_follows_and_records_only_when_all_follow() {
    let Some(game) = game() else {
        common::skip_or_fail("no game set up (W3PROJ_GAME or .game-path)");
        return;
    };
    let dir = workdir("cycle");
    let project = dir.join("project");
    copy_dir(&fixture(), &project);
    let pack = |label: &str| w3proj(&["pack", s(&project), "-o", s(&dir.join(format!("{label}.w3x")))], &game);

    // First run: no record yet, so everything is made, and recorded.
    let first = w3proj(&["rebuild", s(&project)], &game);
    let said = text(&first);
    assert!(first.status.success(), "{said}");
    for part in ["(pathing)", "(shadows)", "(minimap)", "(map script)"] {
        assert!(said.lines().any(|l| l.contains(part)), "no line for {part}: {said}");
    }
    assert!(said.contains("written    map/war3map.shd"), "{said}");
    assert!(project.join("build/derived-from.json").is_file(), "{said}");
    assert!(pack("first").status.success());

    // Nothing changed: pathing, shadows and the minimap are left as they are.
    let kept = derived(&project);
    let again = w3proj(&["rebuild", s(&project)], &game);
    assert!(again.status.success(), "{}", text(&again));
    assert!(text(&again).contains("skipped    pathing, shadows, minimap"), "{}", text(&again));
    assert_eq!(derived(&project), kept);

    // A doodad moved outside the app: pack refuses (the control: the record is what decides), a rebuild of the pathing
    // alone isn't recorded (shadows and the minimap don't follow yet), a whole one is.
    let doo = project.join("map/war3map.doo.json");
    let moved = fs::read_to_string(&doo).unwrap().replacen("64.0,", "320.0,", 1);
    fs::write(&doo, moved).unwrap();
    assert!(!pack("stale").status.success(), "pack took the derived files after the doodads changed");
    let only = w3proj(&["rebuild", s(&project), "--only=wpm"], &game);
    assert!(only.status.success(), "{}", text(&only));
    assert!(text(&only).contains("not recorded as up to date"), "{}", text(&only));
    assert!(!text(&only).contains("(map script)"), "--only=wpm made the script too: {}", text(&only));
    assert!(!pack("only-wpm").status.success(), "pack took shadows and minimap made before the move");
    let whole = w3proj(&["rebuild", s(&project)], &game);
    assert!(whole.status.success(), "{}", text(&whole));
    assert!(pack("rebuilt").status.success(), "{}", text(&pack("rebuilt")));
    let _ = fs::remove_dir_all(&dir);
}

/// A game folder that can't be read makes nothing (shadows would come out without the doodads' models) and says why.
#[test]
fn without_the_game_nothing_is_made() {
    let dir = workdir("no-game");
    let project = dir.join("project");
    copy_dir(&fixture(), &project);
    let o = w3proj(&["rebuild", s(&project)], s(&dir.join("no-such-game")));
    // Pathing, shadows and the minimap are kept, per part, with the reason (not an abort of the whole run); the
    // script needs the game's tables too and fails, so the run as a whole exits 1.
    assert!(!o.status.success(), "{}", text(&o));
    assert!(text(&o).contains("failed") && text(&o).contains("map script"), "{}", text(&o));
    assert!(text(&o).contains("kept"), "{}", text(&o));
    assert!(text(&o).contains("war3map.shd"), "{}", text(&o));
    assert!(text(&o).contains("--game"), "{}", text(&o));
    assert_eq!(derived(&project), derived(&fixture()));
    // Only the shadows asked for: nothing can be made, and it says so.
    let o = w3proj(&["rebuild", s(&project), "--only=shd"], s(&dir.join("no-such-game")));
    assert!(o.status.success(), "{}", text(&o));
    assert!(text(&o).contains("kept") && text(&o).contains("nothing was made"), "{}", text(&o));
    assert!(!text(&o).contains("error:"), "{}", text(&o));
    assert_eq!(derived(&project), derived(&fixture()));
    let _ = fs::remove_dir_all(&dir);
}

/// The game is there, but the only doodad model that casts a shadow can't be read (the map's own Trough0.mdx, broken
/// bytes on disk, which wins over the game's): the shadows would leave every doodad out, so the verdict (shadowmap.ts
/// shadowVerdict) keeps the stored war3map.shd, the line says kept and why, and the run still exits 0. The control,
/// without the broken model, writes the shadows over the same stored bytes.
#[test]
fn shadows_whose_models_are_all_unreadable_keep_the_stored_file() {
    let Some(game) = game() else {
        common::skip_or_fail("no game set up (W3PROJ_GAME or .game-path)");
        return;
    };
    let dir = workdir("shd-verdict");
    let stored: Vec<u8> = (0..4096u32).map(|i| (i.wrapping_mul(7) & 0xff) as u8).collect();
    let make = |name: &str, broken: bool| {
        let project = dir.join(name);
        copy_dir(&fixture(), &project);
        fs::write(project.join("map/war3map.shd"), &stored).unwrap();
        if broken {
            // LOtr (the mini map's trough, variation 0) is the one doodad with a shadow; ATtr is a destructable.
            let model = project.join("map/Doodads/LordaeronSummer/Props/Trough/Trough0.mdx");
            fs::create_dir_all(model.parent().unwrap()).unwrap();
            fs::write(&model, b"MDLXbroken-not-a-model").unwrap();
        }
        project
    };

    let project = make("broken", true);
    let o = w3proj(&["rebuild", s(&project), "--only=shd"], &game);
    let said = text(&o);
    assert!(o.status.success(), "a kept part isn't a failure: {said}");
    let line = said.lines().find(|l| l.contains("war3map.shd")).unwrap_or_else(|| panic!("no line for the shadows: {said}"));
    assert!(line.starts_with("kept"), "{said}");
    assert!(line.contains("none of the 1 doodad models could be read") && line.contains("the stored war3map.shd is kept"), "{said}");
    assert!(said.contains("not recorded as up to date"), "{said}");
    assert_eq!(fs::read(project.join("map/war3map.shd")).unwrap(), stored, "the stored shadows changed");

    let control = make("control", false);
    let o = w3proj(&["rebuild", s(&control), "--only=shd"], &game);
    assert!(o.status.success(), "{}", text(&o));
    assert!(text(&o).contains("written    map/war3map.shd"), "{}", text(&o));
    assert_ne!(fs::read(control.join("map/war3map.shd")).unwrap(), stored, "the control didn't write the shadows");
    let _ = fs::remove_dir_all(&dir);
}

/// The packed map's war3map.j.
fn packed_script(map: &Path, game: &str) -> String {
    let o = w3proj(&["cat", s(map), "war3map.j"], game);
    assert!(o.status.success(), "{}", text(&o));
    String::from_utf8_lossy(&o.stdout).into_owned()
}

/// (The packs here take `--keep-objects`: the mini map's hand-made doodads aren't on the editor's grids.)
/// `w3proj pack` makes the script Studio wrote last again before packing, so a second player added to war3map.w3i
/// outside the app reaches the packed war3map.j (its InitAllyPriorities is what the pack works out for the w3i:
/// allies.rs script_agrees gives no warning). Controls: --keep-script packs the stale script and warns; a script
/// edited by hand isn't made again (kept, with the warning).
#[test]
fn pack_makes_studios_script_again_and_keeps_one_edited_by_hand() {
    let Some(game) = game() else {
        common::skip_or_fail("no game set up (W3PROJ_GAME or .game-path)");
        return;
    };
    let dir = workdir("pack-script");
    let project = dir.join("project");
    copy_dir(&fixture(), &project);
    let script = project.join("map/war3map.j");
    // No script there: Studio writes its own, and records it (build/generated-script).
    fs::remove_file(&script).unwrap();
    let o = w3proj(&["rebuild", s(&project), "--only=script"], &game);
    assert!(o.status.success() && text(&o).contains("written    map/war3map.j"), "{}", text(&o));
    let studios = fs::read_to_string(&script).unwrap();
    assert!(!studios.contains("SetStartLocPrio("), "one player has no priorities: {studios}");
    // The triggers come from map/triggers/: the custom script header, the custom text and the GUI triggers.
    for made in ["function FooHelper takes nothing returns integer", "function InitTrig_Foo_Script takes nothing returns nothing", "call InitTrig_Foo_Init(", "gg_trg_Foo_Branch"] {
        assert!(studios.contains(made), "no {made:?} in the script made from map/triggers/: {studios}");
    }

    // Nothing changed: the pack makes the same script and writes nothing.
    let o = w3proj(&["pack", s(&project), "--keep-objects", "-o", s(&dir.join("same.w3x"))], &game);
    assert!(o.status.success(), "{}", text(&o));
    assert!(!text(&o).contains("warning:") && !text(&o).contains("written"), "{}", text(&o));
    assert_eq!(fs::read_to_string(&script).unwrap(), studios);

    // A second user player, near the first: both get the other as High.
    let info = project.join("map/war3map.w3i.json");
    let mut v: serde_json::Value = serde_json::from_str(&fs::read_to_string(&info).unwrap()).unwrap();
    let mut second = v["players"][0].clone();
    second["id"] = 1.into();
    second["start"] = serde_json::json!([0.0, 1280.0]);
    v["players"].as_array_mut().unwrap().push(second);
    fs::write(&info, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    let prio = "call SetStartLocPrio( 0, 0, 1, MAP_LOC_PRIO_HIGH )";
    let stale = "InitAllyPriorities doesn't set the ally priorities";

    // Control: --keep-script packs the stale script, and the pack's check says so.
    let o = w3proj(&["pack", s(&project), "--keep-objects", "--keep-script", "-o", s(&dir.join("kept.w3x"))], &game);
    assert!(o.status.success() && text(&o).contains(stale), "{}", text(&o));
    assert!(!packed_script(&dir.join("kept.w3x"), &game).contains(prio));
    assert_eq!(fs::read_to_string(&script).unwrap(), studios);

    let o = w3proj(&["pack", s(&project), "--keep-objects", "-o", s(&dir.join("made.w3x"))], &game);
    let said = text(&o);
    assert!(o.status.success(), "{said}");
    assert!(said.contains("written    map/war3map.j (map script made again"), "{said}");
    assert!(!said.contains("warning:"), "the made script agrees with the w3i the pack worked out: {said}");
    let made = fs::read_to_string(&script).unwrap();
    assert!(made.contains(prio) && made.contains("call SetStartLocPrio( 1, 0, 0, MAP_LOC_PRIO_HIGH )"), "{made}");
    assert!(made.contains("call DefineStartLocation( 1, 0.0, 1280.0 )"), "the new player's start is in the script: {made}");
    assert_eq!(packed_script(&dir.join("made.w3x"), &game), made, "the pack took the script it made");

    // Edited by hand: not Studio's any more, so it stays as it is, with the warning, after a third player came.
    let edited = format!("{made}// my own line\n");
    fs::write(&script, &edited).unwrap();
    let mut third = v["players"][0].clone();
    third["id"] = 2.into();
    third["start"] = serde_json::json!([1280.0, 0.0]);
    v["players"].as_array_mut().unwrap().push(third);
    fs::write(&info, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    let o = w3proj(&["pack", s(&project), "--keep-objects", "-o", s(&dir.join("edited.w3x"))], &game);
    assert!(o.status.success() && text(&o).contains(stale), "{}", text(&o));
    assert!(!text(&o).contains("written"), "{}", text(&o));
    assert_eq!(fs::read_to_string(&script).unwrap(), edited);
    assert_eq!(packed_script(&dir.join("edited.w3x"), &game), edited);
    let _ = fs::remove_dir_all(&dir);
}

/// A generated script (map/triggers/triggers.json "script": "generated", in build/derived/): `w3proj pack` makes it
/// again when it doesn't follow its sources (switched from a tracked file, a header edited outside the app, none there),
/// writes it into the store only (never map/), records what it was made from, and packs it. Controls: with `--game none`
/// nothing is made, so the stale script is refused (--allow-stale-script takes it) and a missing one is refused always.
#[test]
fn pack_makes_a_generated_script_in_the_store_and_records_it() {
    let Some(game) = game() else {
        common::skip_or_fail("no game set up (W3PROJ_GAME or .game-path)");
        return;
    };
    let dir = workdir("pack-generated");
    let project = dir.join("project");
    copy_dir(&fixture(), &project);
    w3proj::trigger_layout::set_script_mode(&project, w3proj::trigger_layout::ScriptMode::Generated).unwrap();
    let store = project.join("build/derived/war3map.j");
    assert!(store.is_file() && !project.join("map/war3map.j").exists());
    assert_eq!(w3proj::derived::check_script(&project).unwrap(), w3proj::derived::Freshness::Unknown, "a moved script follows nothing yet");
    let pack = |label: &str, extra: &[&str], game: &str| {
        let out = dir.join(format!("{label}.w3x"));
        // --keep-objects: the script is what this is about (the placed objects: pack_puts_the_placed_objects_…).
        let mut args = vec!["pack", s(&project), "--keep-objects", "-o", s(&out)];
        args.extend_from_slice(extra);
        (w3proj(&args, game), out)
    };
    let (o, out) = pack("first", &[], &game);
    assert!(o.status.success() && text(&o).contains("map script made again"), "{}", text(&o));
    assert_eq!(w3proj::derived::check_script(&project).unwrap(), w3proj::derived::Freshness::Fresh, "the generator recorded its sources: {}", text(&o));
    assert!(!project.join("map/war3map.j").exists(), "nothing written into map/");
    assert_eq!(packed_script(&out, &game), fs::read_to_string(&store).unwrap(), "the pack took the script in the store");

    // Follows its sources: packed as it is, the generator not started.
    let (o, _) = pack("same", &[], &game);
    assert!(o.status.success() && !text(&o).contains("made again"), "{}", text(&o));

    // The header edited outside the app: stale. Without the game nothing is made, so it is refused, or taken as it is.
    let header = project.join("map/triggers/header.j");
    fs::write(&header, format!("{}// edited outside\r\n", fs::read_to_string(&header).unwrap())).unwrap();
    let (o, _) = pack("refused", &["--game", "none"], &game);
    assert!(!o.status.success() && text(&o).contains("triggers/header.j changed") && text(&o).contains("--allow-stale-script"), "{}", text(&o));
    let (o, stale) = pack("stale", &["--game", "none", "--allow-stale-script"], &game);
    assert!(o.status.success() && !packed_script(&stale, &game).contains("// edited outside"), "{}", text(&o));
    // With the game: made again with the edit.
    let (o, out) = pack("edited", &[], &game);
    assert!(o.status.success(), "{}", text(&o));
    assert!(packed_script(&out, &game).contains("// edited outside"), "{}", text(&o));
    assert_eq!(w3proj::derived::check_script(&project).unwrap(), w3proj::derived::Freshness::Fresh);

    // None in the store (a fresh clone): refused without the game, whatever the flags; made with it.
    fs::remove_file(&store).unwrap();
    let (o, _) = pack("missing", &["--game", "none", "--allow-stale-script"], &game);
    assert!(!o.status.success() && text(&o).contains("missing"), "{}", text(&o));
    let (o, out) = pack("clone", &[], &game);
    assert!(o.status.success() && store.is_file(), "{}", text(&o));
    assert!(packed_script(&out, &game).contains("function InitTrig_Foo_Script takes nothing returns nothing"));
    let _ = fs::remove_dir_all(&dir);
}

/// Studio's script, but its generator can't run (no game to read the tables from): the pack goes on with the script
/// as it is and says why it wasn't made again.
#[test]
fn a_script_that_cant_be_made_again_is_packed_as_it_is_with_a_warning() {
    let Some(game) = game() else {
        common::skip_or_fail("no game set up (W3PROJ_GAME or .game-path)");
        return;
    };
    let dir = workdir("pack-script-no-game");
    let project = dir.join("project");
    copy_dir(&fixture(), &project);
    let script = project.join("map/war3map.j");
    fs::remove_file(&script).unwrap();
    let o = w3proj(&["rebuild", s(&project), "--only=script"], &game);
    assert!(o.status.success(), "{}", text(&o));
    let studios = fs::read(&script).unwrap();
    let o = w3proj(&["pack", s(&project), "-o", s(&dir.join("out.w3x"))], s(&dir.join("no-such-game")));
    assert!(o.status.success(), "{}", text(&o));
    assert!(text(&o).contains("warning: map script not made again"), "{}", text(&o));
    assert_eq!(fs::read(&script).unwrap(), studios);
    assert!(dir.join("out.w3x").is_file());
    let _ = fs::remove_dir_all(&dir);
}

/// A script that isn't the one Studio wrote last (map 15's, from elsewhere, with a function of its own) is kept by
/// `w3proj rebuild` (the control) and replaced with --force, whose line names the file and the code that is gone.
#[test]
fn rebuild_force_replaces_a_script_studio_did_not_write_and_says_so() {
    let Some(game) = game() else {
        common::skip_or_fail("no game set up (W3PROJ_GAME or .game-path)");
        return;
    };
    let dir = workdir("force-script");
    let project = dir.join("project");
    copy_dir(&fixture(), &project);
    let script = project.join("map/war3map.j");
    let foreign = format!("{}\nfunction MyOwnCode takes nothing returns nothing\nendfunction\n", fs::read_to_string(&script).unwrap());
    fs::write(&script, &foreign).unwrap();

    let o = w3proj(&["rebuild", s(&project), "--only=script"], &game);
    assert!(o.status.success(), "{}", text(&o));
    assert!(text(&o).contains("kept") && text(&o).contains("map/war3map.j"), "{}", text(&o));
    assert_eq!(fs::read_to_string(&script).unwrap(), foreign, "without --force the script stays");

    let o = w3proj(&["rebuild", s(&project), "--only=script", "--force"], &game);
    let said = text(&o);
    assert!(o.status.success(), "{said}");
    assert!(said.contains("written    map/war3map.j"), "{said}");
    assert!(said.contains("replacing a war3map.j that wasn't the script Studio wrote last"), "{said}");
    assert!(said.contains("MyOwnCode"), "the line names the code that is gone: {said}");
    let made = fs::read_to_string(&script).unwrap();
    assert!(!made.contains("MyOwnCode") && made.contains("function main takes nothing"), "{made}");

    // Now it's Studio's: a plain rebuild makes it again, with nothing replaced.
    let o = w3proj(&["rebuild", s(&project), "--only=script", "--force"], &game);
    assert!(o.status.success() && !text(&o).contains("replacing"), "{}", text(&o));
    assert_eq!(fs::read_to_string(&script).unwrap(), made);
    let _ = fs::remove_dir_all(&dir);
}

/// The files in `build/replaced-scripts/`: name → bytes (none when the folder isn't there).
fn backups(project: &Path) -> Vec<(String, Vec<u8>)> {
    let Ok(dir) = fs::read_dir(project.join("build/replaced-scripts")) else { return Vec::new() };
    let mut out: Vec<(String, Vec<u8>)> = dir.map(|e| e.unwrap()).map(|e| (e.file_name().to_string_lossy().into_owned(), fs::read(e.path()).unwrap())).collect();
    out.sort();
    out
}

/// `--replace-script` (the app's "Replace the script", with a backup instead of a checkpoint): a hand-edited script is
/// kept by a plain rebuild (the control), replaced with the flag, its old bytes in build/replaced-scripts/ (git-ignored),
/// and the next run is up to date and leaves the backup alone. A script that isn't UTF-8 (lossless strings from an old
/// code page) is kept aside byte for byte.
#[test]
fn rebuild_replace_script_backs_up_the_script_it_replaces() {
    let Some(game) = game() else {
        common::skip_or_fail("no game set up (W3PROJ_GAME or .game-path)");
        return;
    };
    let dir = workdir("replace-script");
    for (label, tail) in [("utf8", b"\n// my own line\nfunction MyOwnCode takes nothing returns nothing\nendfunction\n".to_vec()), ("cp1252", b"\n// caf\xe9 \xff\xfe not UTF-8\n".to_vec())] {
        let project = dir.join(label);
        copy_dir(&fixture(), &project);
        let script = project.join("map/war3map.j");
        let mut edited = fs::read(&script).unwrap();
        edited.extend_from_slice(&tail);
        fs::write(&script, &edited).unwrap();

        // Control: without the flag the script stays, and the line says so.
        let o = w3proj(&["rebuild", s(&project), "--only=script"], &game);
        assert!(o.status.success(), "{}", text(&o));
        assert!(text(&o).lines().any(|l| l.starts_with("kept") && l.contains("map/war3map.j")), "{}", text(&o));
        assert_eq!(fs::read(&script).unwrap(), edited, "{label}: a plain rebuild changed the script");
        assert!(backups(&project).is_empty());

        let o = w3proj(&["rebuild", s(&project), "--only=script", "--replace-script"], &game);
        let said = text(&o);
        assert!(o.status.success(), "{label}: {said}");
        assert!(said.contains("written    map/war3map.j"), "{label}: {said}");
        let made = fs::read(&script).unwrap();
        assert_ne!(made, edited, "{label}: not replaced");
        assert!(String::from_utf8_lossy(&made).contains("function main takes nothing"), "{label}");
        let kept = backups(&project);
        assert_eq!(kept.len(), 1, "{label}: {kept:?}");
        let (name, bytes) = &kept[0];
        assert!(name.starts_with("war3map.") && name.ends_with(".j"), "{label}: {name}");
        assert_eq!(bytes, &edited, "{label}: the backup isn't the old script byte for byte");
        assert!(said.contains(&format!("backup     build/replaced-scripts/{name}")), "{label}: {said}");
        let ignore = fs::read_to_string(project.join(".gitignore")).unwrap();
        assert!(ignore.lines().any(|l| l == "build/"), "{label}: {ignore}");

        // Studio's now: up to date, nothing backed up again, the backup untouched.
        let o = w3proj(&["rebuild", s(&project), "--only=script", "--replace-script"], &game);
        let said = text(&o);
        assert!(o.status.success(), "{label}: {said}");
        assert!(said.contains("up to date") && !said.contains("backup ") && !said.contains("replacing"), "{label}: {said}");
        assert_eq!(fs::read(&script).unwrap(), made);
        assert_eq!(backups(&project), kept, "{label}: the second run touched the backups");
    }
    let _ = fs::remove_dir_all(&dir);
}

/// `--replace-script` on a map without triggers (no map/triggers/, no war3map.wtg) is refused before anything is made, as
/// is one whose --only leaves the script out. Needs no game: nothing runs.
#[test]
fn rebuild_replace_script_without_triggers_is_refused() {
    let dir = workdir("replace-no-triggers");
    let project = dir.join("project");
    copy_dir(&fixture(), &project);
    let script = project.join("map/war3map.j");
    let edited = format!("{}// mine\n", fs::read_to_string(&script).unwrap());
    fs::write(&script, &edited).unwrap();

    let o = w3proj(&["rebuild", s(&project), "--only=wpm", "--replace-script"], "none");
    assert!(!o.status.success() && text(&o).contains("--only must name script"), "{}", text(&o));

    fs::remove_dir_all(project.join("map/triggers")).unwrap();
    assert!(!project.join("map/war3map.wtg").exists());
    let o = w3proj(&["rebuild", s(&project), "--replace-script"], "none");
    let said = text(&o);
    assert!(!o.status.success(), "{said}");
    assert!(said.contains("no triggers to make a map script from") && said.contains("nothing was replaced"), "{said}");
    assert!(!said.contains("written") && !said.contains("kept "), "refused before anything ran: {said}");
    assert_eq!(fs::read_to_string(&script).unwrap(), edited);
    assert!(backups(&project).is_empty());
    assert_eq!(derived(&project), derived(&fixture()));
    let _ = fs::remove_dir_all(&dir);
}

/// A map whose triggers are vJASS: the generator keeps the script (no JassHelper in the CLI), so --replace-script fails,
/// says why, and leaves the script and no backup behind.
#[test]
fn rebuild_replace_script_of_a_vjass_map_fails_and_says_jasshelper() {
    let Some(game) = game() else {
        common::skip_or_fail("no game set up (W3PROJ_GAME or .game-path)");
        return;
    };
    let dir = workdir("replace-vjass");
    let project = dir.join("project");
    copy_dir(&fixture(), &project);
    let header = project.join("map/triggers/header.j");
    fs::write(&header, format!("{}library Mine\nendlibrary\r\n", fs::read_to_string(&header).unwrap())).unwrap();
    let script = project.join("map/war3map.j");
    let edited = format!("{}// mine\n", fs::read_to_string(&script).unwrap());
    fs::write(&script, &edited).unwrap();

    let o = w3proj(&["rebuild", s(&project), "--only=script", "--replace-script"], &game);
    let said = text(&o);
    assert!(!o.status.success(), "{said}");
    assert!(said.contains("wasn't replaced") && said.contains("JassHelper"), "{said}");
    assert_eq!(fs::read_to_string(&script).unwrap(), edited);
    assert!(backups(&project).is_empty(), "{:?}", backups(&project));
    let _ = fs::remove_dir_all(&dir);
}

/// A map with no script at all (made without one, its script deleted) gets one written into map/ before the pack, as
/// the app's packing does (map-script w3.script.forPack), whether its triggers are in map/triggers/ or it has none:
/// the game can't run a map without one. Controls: --keep-script and a generator that can't run pack it without one,
/// with the warnings.
#[test]
fn pack_writes_a_script_for_a_map_without_one() {
    let Some(game) = game() else {
        common::skip_or_fail("no game set up (W3PROJ_GAME or .game-path)");
        return;
    };
    let dir = workdir("pack-no-script");
    let missing = "warning: map/war3map.j is missing, so the packed map has no script";
    for triggers in [true, false] {
        let project = dir.join(format!("project-{triggers}"));
        copy_dir(&fixture(), &project);
        let script = project.join("map/war3map.j");
        fs::remove_file(&script).unwrap();
        if !triggers {
            fs::remove_dir_all(project.join("map/triggers")).unwrap();
        }
        let pack = |label: &str, extra: &[&str], game: &str| {
            let out = dir.join(format!("{label}-{triggers}.w3x"));
            let mut args = vec!["pack", s(&project), "-o", s(&out)];
            args.extend_from_slice(extra);
            (w3proj(&args, game), out)
        };

        // Controls first: nothing made, packed without a script, and said so.
        let (o, out) = pack("kept", &["--keep-script"], &game);
        assert!(o.status.success() && text(&o).contains(missing), "{}", text(&o));
        assert!(!script.exists() && !w3proj(&["ls", s(&out)], &game).stdout.windows(9).any(|w| w == b"war3map.j"));
        let (o, _) = pack("no-game", &[], s(&dir.join("no-such-game")));
        let said = text(&o);
        assert!(o.status.success() && said.contains("warning: the map has no script and none could be made") && said.contains(missing), "{said}");
        assert!(!script.exists());

        let (o, out) = pack("made", &[], &game);
        let said = text(&o);
        assert!(o.status.success(), "{said}");
        assert!(said.contains("written    map/war3map.j (the map had no script"), "{said}");
        assert!(!said.contains(missing) && !said.contains("none could be made"), "{said}");
        let made = fs::read_to_string(&script).unwrap();
        assert!(made.contains("function main takes nothing returns nothing"), "{made}");
        assert_eq!(made.contains("function InitTrig_Foo_Script takes nothing returns nothing"), triggers, "{made}");
        assert_eq!(packed_script(&out, &game), made, "the pack took the script it made");
    }
    let _ = fs::remove_dir_all(&dir);
}

/// `w3proj pack` says when the map has no script or no war3map.wtg, and packs it all the same (the library's
/// pack_warnings.rs holds what goes into the archive).
#[test]
fn pack_warns_about_a_missing_script_and_war3map_wtg() {
    let dir = workdir("pack-missing");
    let project = dir.join("project");
    copy_dir(&fixture(), &project);
    // [Refactored] Removed redundant control pack of unmodified mini-map (already covered in pack_warnings.rs and roundtrip.rs).
    fs::remove_file(project.join("map/war3map.j")).unwrap();
    fs::remove_dir_all(project.join("map/triggers")).unwrap();
    let out = dir.join("bare.w3x");
    let o = w3proj(&["pack", s(&project), "-o", s(&out)], "none");
    let said = String::from_utf8_lossy(&o.stderr).into_owned();
    assert!(o.status.success(), "{}", text(&o));
    assert!(said.contains("warning: map/war3map.j is missing, so the packed map has no script"), "{said}");
    assert!(said.contains("warning: map/war3map.wtg is missing"), "{said}");
    assert!(out.is_file());
    assert!(!project.join("map/war3map.j").exists() && !project.join("map/war3map.wtg").exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn an_unknown_part_is_refused() {
    let dir = workdir("unknown-part");
    let project = dir.join("project");
    copy_dir(&fixture(), &project);
    let o = w3proj(&["rebuild", s(&project), "--only=wpm,pathing"], "none");
    assert!(!o.status.success());
    assert!(text(&o).contains("no part \"pathing\""), "{}", text(&o));
    let _ = fs::remove_dir_all(&dir);
}

/// A pack applies to the placed objects what the app's Pack Map does (the World Editor's rules on opening a map): a tree
/// off its grid is put on it and the project written, and the derived files that followed the project still count as
/// following it (the pack goes through, and the next one changes nothing). `--keep-objects` packs it as it is.
#[test]
fn pack_puts_the_placed_objects_on_their_grids_as_the_app_does() {
    let Some(game) = game() else {
        common::skip_or_fail("no game set up (W3PROJ_GAME or .game-path)");
        return;
    };
    let dir = workdir("pack-prepare");
    let project = dir.join("project");
    copy_dir(&fixture(), &project);
    // The mini map's first destructable, a tree wall with a pathing texture, moved off its grid.
    let doo = project.join("map/war3map.doo.json");
    let mut list: serde_json::Value = serde_json::from_slice(&fs::read(&doo).unwrap()).unwrap();
    assert_eq!(list["doodads"][0]["id"], "ATtr");
    let x = list["doodads"][0]["position"][0].as_f64().unwrap();
    let off = (x / 32.0).floor() * 32.0 + 13.0;
    list["doodads"][0]["position"][0] = off.into();
    fs::write(&doo, serde_json::to_vec_pretty(&list).unwrap()).unwrap();
    let made = w3proj(&["rebuild", s(&project)], &game);
    assert!(made.status.success(), "{}", text(&made));
    let stored = fs::read(&doo).unwrap();
    let placed_x = || serde_json::from_slice::<serde_json::Value>(&fs::read(&doo).unwrap()).unwrap()["doodads"][0]["position"][0].as_f64().unwrap();

    // Control: as it is.
    let kept = w3proj(&["pack", s(&project), "-o", s(&dir.join("kept.w3x")), "--keep-objects", "--keep-script"], &game);
    assert!(kept.status.success(), "{}", text(&kept));
    assert_eq!(fs::read(&doo).unwrap(), stored, "--keep-objects wrote the placed objects");

    let packed = w3proj(&["pack", s(&project), "-o", s(&dir.join("out.w3x"))], &game);
    let said = text(&packed);
    assert!(packed.status.success(), "{said}");
    assert!(said.contains("written    the placed objects in map/"), "{said}");
    let now = placed_x();
    assert!(now != off && now % 16.0 == 0.0, "the tree at {off} is at {now}: {said}");
    let again = w3proj(&["pack", s(&project), "-o", s(&dir.join("again.w3x"))], &game);
    assert!(again.status.success() && !text(&again).contains("written    the placed objects"), "{}", text(&again));
}

