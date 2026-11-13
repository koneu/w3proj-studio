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
    assert!(!o.status.success());
    assert!(text(&o).contains("nothing was made"), "{}", text(&o));
    assert!(text(&o).contains("--game"), "{}", text(&o));
    assert_eq!(derived(&project), derived(&fixture()));
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
