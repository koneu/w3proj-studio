//! A campaign project's `.gitignore` (`build/`) covers each chapter's `build/derived/` store and derived-from record:
//! the chapter projects have no `.gitignore` of their own. Unpacking again (the sync) adds the lines to a campaign
//! project made before that lacks the line. Control: a path that isn't derived stays unignored.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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

fn ignored(root: &Path, rel: &str) -> bool {
    let out = Command::new("git").arg("-C").arg(root).args(["check-ignore", "-q", rel]).output().unwrap();
    match out.status.code() {
        Some(0) => true,
        Some(1) => false,
        c => panic!("git check-ignore failed ({c:?}): {}", String::from_utf8_lossy(&out.stderr)),
    }
}

#[test]
fn a_campaign_project_ignores_every_chapters_derived_store() {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("campaign-gitignore-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let src = dir.join("src");
    fs::create_dir_all(src.join("map")).unwrap();
    fs::copy(fixture().join("w3proj.toml"), src.join("w3proj.toml")).unwrap();
    fs::write(src.join("map/war3campaign.w3f"), [1u8, 0, 0, 0]).unwrap();
    copy_dir(&fixture(), &src.join("maps/One.w3x"));
    let codecs = Registry::default();
    let w3n = dir.join("camp.w3n");
    w3proj::pack(&src, Some(&w3n), &codecs).unwrap();

    let root = dir.join("proj");
    w3proj::unpack(&w3n, &root, &codecs, &w3proj::UnpackOptions::default()).unwrap();
    assert!(root.join("maps/One.w3x/w3proj.toml").is_file(), "the chapter became a project");
    Command::new("git").arg("-C").arg(&root).arg("init").arg("-q").status().unwrap();
    for rel in ["maps/One.w3x/build/derived/x", "maps/One.w3x/build/derived-from.json", "build/derived/x"] {
        assert!(ignored(&root, rel), "{rel} isn't ignored");
    }
    assert!(!ignored(&root, "maps/One.w3x/map/war3map.w3i"), "control: a map file stays tracked");

    // A campaign project from before: the lines are missing; the sync adds them.
    let old = fs::read_to_string(root.join(".gitignore")).unwrap().replace("build/\n", "");
    fs::write(root.join(".gitignore"), old).unwrap();
    assert!(!ignored(&root, "maps/One.w3x/build/derived/x"));
    w3proj::unpack(&w3n, &root, &codecs, &w3proj::UnpackOptions::default()).unwrap();
    assert!(ignored(&root, "maps/One.w3x/build/derived/x"), "the sync adds the line");
    let _ = fs::remove_dir_all(&dir);
}
