//! `w3proj pack` warns about what a packed map lacks that the game or the World Editor needs, and packs it anyway
//! without making anything up: no map script (war3map.j, or war3map.lua), no war3map.wtg (protected, JASS-only maps
//! such as MatrixPCDefense_v4.3: the World Editor says "Trigger data missing or invalid"). The control: the mini map
//! as it is packs without warnings.

use std::fs;
use std::path::{Path, PathBuf};

use mpq::Archive;
use w3proj::Registry;

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mini-map")
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

fn scratch(test: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("pack-warnings-{test}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn names(map: &Path) -> Vec<String> {
    let archive = Archive::open(map).unwrap();
    let list = String::from_utf8(archive.read("(listfile)").unwrap()).unwrap();
    list.lines().map(|l| l.trim().to_ascii_lowercase()).filter(|l| !l.is_empty()).collect()
}

const NO_SCRIPT: &str = "map/war3map.j is missing, so the packed map has no script";
const NO_WTG: &str = "map/war3map.wtg is missing";

#[test]
fn a_map_without_a_script_or_war3map_wtg_is_packed_with_a_warning_for_each() {
    let dir = scratch("map");
    let project = dir.join("mini");
    copy_dir(&fixture(), &project);
    let codecs = Registry::default();

    // Control: everything there, no warning.
    let whole = dir.join("whole.w3x");
    let r = w3proj::pack(&project, Some(&whole), &codecs).unwrap();
    assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    let whole_names = names(&whole);
    assert!(whole_names.contains(&"war3map.j".into()) && whole_names.contains(&"war3map.wtg".into()), "{whole_names:?}");

    // No war3map.j: warned, packed, nothing written in its place, the project left as it is.
    fs::remove_file(project.join("map/war3map.j")).unwrap();
    let out = dir.join("no-script.w3x");
    let r = w3proj::pack_pruned(&project, Some(&out), &codecs).unwrap();
    assert_eq!(r.warnings.len(), 1, "{:?}", r.warnings);
    assert!(r.warnings[0].contains(NO_SCRIPT), "{:?}", r.warnings);
    assert!(!names(&out).contains(&"war3map.j".into()));
    assert!(!project.join("map/war3map.j").exists());

    // A Lua map has its script in war3map.lua: no warning.
    fs::write(project.join("map/war3map.lua"), "function main() end\n").unwrap();
    let r = w3proj::pack(&project, Some(&dir.join("lua.w3x")), &codecs).unwrap();
    assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    fs::remove_file(project.join("map/war3map.lua")).unwrap();

    // No war3map.wtg either (a protected map): both warned, and no empty war3map.wtg goes into the archive.
    fs::remove_file(project.join("map/war3map.wtg.json")).unwrap();
    let out = dir.join("no-wtg.w3x");
    let r = w3proj::pack(&project, Some(&out), &codecs).unwrap();
    assert_eq!(r.warnings.len(), 2, "{:?}", r.warnings);
    assert!(r.warnings[0].contains(NO_SCRIPT) && r.warnings[1].contains(NO_WTG), "{:?}", r.warnings);
    assert!(r.warnings[1].contains("Trigger data missing or invalid"), "{:?}", r.warnings);
    let packed = names(&out);
    assert!(!packed.iter().any(|n| n.starts_with("war3map.wtg")), "{packed:?}");
    assert!(!project.join("map/war3map.wtg").exists() && !project.join("map/war3map.wtg.json").exists());
    // Everything else as in the whole map.
    let expect: Vec<_> = whole_names.iter().filter(|n| *n != "war3map.j" && *n != "war3map.wtg").cloned().collect();
    assert_eq!(packed, expect);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_campaign_is_not_warned_about_its_own_archive_but_about_a_chapter_map() {
    let dir = scratch("campaign");
    let campaign = dir.join("camp");
    fs::create_dir_all(campaign.join("map")).unwrap();
    fs::copy(fixture().join("w3proj.toml"), campaign.join("w3proj.toml")).unwrap();
    // The campaign's own files have neither a script nor a war3map.wtg (raw bytes: the pack takes them as they are).
    fs::write(campaign.join("map/war3campaign.w3f"), [1u8, 0, 0, 0]).unwrap();
    let whole = campaign.join("maps/Whole.w3x");
    copy_dir(&fixture(), &whole);
    let bare = campaign.join("maps/Bare.w3x");
    copy_dir(&fixture(), &bare);
    fs::remove_file(bare.join("map/war3map.j")).unwrap();
    fs::remove_file(bare.join("map/war3map.wtg.json")).unwrap();

    let r = w3proj::pack(&campaign, Some(&dir.join("camp.w3n")), &Registry::default()).unwrap();
    assert_eq!(r.warnings.len(), 2, "{:?}", r.warnings);
    assert!(r.warnings[0].starts_with(&format!("maps/Bare.w3x/{NO_SCRIPT}")), "{:?}", r.warnings);
    assert!(r.warnings[1].starts_with(&format!("maps/Bare.w3x/{NO_WTG}")), "{:?}", r.warnings);
    let _ = fs::remove_dir_all(&dir);
}
