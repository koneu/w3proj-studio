//! `w3proj rebuild` end to end: the real binary, Node running the app's code (app/src/headless), the installed game.
//! On a copy of the mini map: what is made, what pack takes afterwards, what is skipped when nothing changed. Needs the
//! game (W3PROJ_GAME, else the main checkout's `.game-path`, as tests/gamepath.mjs finds it) and Node with the app's
//! packages installed: without the game the tests that need it say so and pass, as the corpus tests do. That the
//! files are the app's own bytes is app-smoke's `rebuildCli` (the app and the CLI on copies of one project).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mini-map")
}

fn workdir(test: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("rebuild-{test}"));
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
    listed.iter().find(|l| Path::new(l).exists()).or(listed.first()).map(|l| l.to_string())
}

fn w3proj(args: &[&str], game: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_w3proj")).args(args).env("W3PROJ_GAME", game).env_remove("W3PROJ_FORMATS").output().unwrap()
}

fn text(o: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

/// The derived files and the record, as bytes (None: not there).
fn derived(project: &Path) -> Vec<Option<Vec<u8>>> {
    ["map/war3map.wpm", "map/war3map.shd", "map/war3mapMap.blp", "map/war3map.mmp.json", ".w3proj/derived-from.json"]
        .iter()
        .map(|f| fs::read(project.join(f)).ok())
        .collect()
}

#[test]
fn rebuild_makes_what_pack_takes_skips_what_follows_and_records_only_when_all_follow() {
    let Some(game) = game() else {
        eprintln!("skipped: no game set up (W3PROJ_GAME or .game-path)");
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
    assert!(project.join(".w3proj/derived-from.json").is_file(), "{said}");
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
        eprintln!("skipped: no game set up (W3PROJ_GAME or .game-path)");
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

/// `w3proj pack` makes the script Studio wrote last again before packing, so a second player added to war3map.w3i
/// outside the app reaches the packed war3map.j (its InitAllyPriorities is what the pack works out for the w3i:
/// allies.rs script_agrees gives no warning). Controls: --keep-script packs the stale script and warns; a script
/// edited by hand isn't made again (kept, with the warning).
#[test]
fn pack_makes_studios_script_again_and_keeps_one_edited_by_hand() {
    let Some(game) = game() else {
        eprintln!("skipped: no game set up (W3PROJ_GAME or .game-path)");
        return;
    };
    let dir = workdir("pack-script");
    let project = dir.join("project");
    copy_dir(&fixture(), &project);
    let script = project.join("map/war3map.j");
    // No script there: Studio writes its own, and records it (.w3proj/generated-script).
    fs::remove_file(&script).unwrap();
    let o = w3proj(&["rebuild", s(&project), "--only=script"], &game);
    assert!(o.status.success() && text(&o).contains("written    map/war3map.j"), "{}", text(&o));
    let studios = fs::read_to_string(&script).unwrap();
    assert!(!studios.contains("SetStartLocPrio("), "one player has no priorities: {studios}");

    // Nothing changed: the pack makes the same script and writes nothing.
    let o = w3proj(&["pack", s(&project), "-o", s(&dir.join("same.w3x"))], &game);
    assert!(o.status.success(), "{}", text(&o));
    assert!(!text(&o).contains("warning") && !text(&o).contains("written"), "{}", text(&o));
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
    let o = w3proj(&["pack", s(&project), "--keep-script", "-o", s(&dir.join("kept.w3x"))], &game);
    assert!(o.status.success() && text(&o).contains(stale), "{}", text(&o));
    assert!(!packed_script(&dir.join("kept.w3x"), &game).contains(prio));
    assert_eq!(fs::read_to_string(&script).unwrap(), studios);

    let o = w3proj(&["pack", s(&project), "-o", s(&dir.join("made.w3x"))], &game);
    let said = text(&o);
    assert!(o.status.success(), "{said}");
    assert!(said.contains("written    map/war3map.j (map script made again"), "{said}");
    assert!(!said.contains("warning"), "the made script agrees with the w3i the pack worked out: {said}");
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
    let o = w3proj(&["pack", s(&project), "-o", s(&dir.join("edited.w3x"))], &game);
    assert!(o.status.success() && text(&o).contains(stale), "{}", text(&o));
    assert!(!text(&o).contains("written"), "{}", text(&o));
    assert_eq!(fs::read_to_string(&script).unwrap(), edited);
    assert_eq!(packed_script(&dir.join("edited.w3x"), &game), edited);
    let _ = fs::remove_dir_all(&dir);
}

/// Studio's script, but its generator can't run (no game to read the tables from): the pack goes on with the script
/// as it is and says why it wasn't made again.
#[test]
fn a_script_that_cant_be_made_again_is_packed_as_it_is_with_a_warning() {
    let Some(game) = game() else {
        eprintln!("skipped: no game set up (W3PROJ_GAME or .game-path)");
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
