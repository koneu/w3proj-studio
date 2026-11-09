//! What a sync (import over a project, re-sync from a map) must leave alone: the user's comments and
//! own keys in `w3proj.toml`, and files with a `\` in their name that an older version left on Linux
//! (moved only when the user says so). What it reports and can say before deleting: `sync_report.rs`.

mod sync_common;

use std::fs;

use sync_common::*;
use w3proj::project::{self, Manifest, MANIFEST};

#[test]
fn a_sync_that_changes_nothing_leaves_the_manifest_byte_for_byte() {
    let dir = workdir("manifest-same");
    let root = new_project(&dir);
    let text = commented(&root);
    project::write_files(&root, extracted(&root, "Map", &[("war3map.j", SCRIPT)])).unwrap();
    assert_eq!(fs::read_to_string(root.join(MANIFEST)).unwrap(), text);
}

#[test]
fn a_sync_changes_only_the_keys_studio_owns_in_the_manifest() {
    let dir = workdir("manifest-changed");
    let root = new_project(&dir);
    let text = commented(&root);
    project::write_files(&root, extracted(&root, "Renamed", &[("war3map.j", SCRIPT)])).unwrap();
    let after = fs::read_to_string(root.join(MANIFEST)).unwrap();
    assert_eq!(after, text.replace("name = \"Map\"", "name = \"Renamed\""), "only the name changed, its comment kept");
    assert_eq!(Manifest::load(&root).unwrap().map.unwrap().name, "Renamed");
    // Pack settings the user set are kept by a sync, and their comments too.
    let with_output = after.replace("[pack]\n", "[pack]\noutput = \"out/x.w3x\" # for the server\n");
    fs::write(root.join(MANIFEST), &with_output).unwrap();
    project::write_files(&root, extracted(&root, "Renamed", &[("war3map.j", SCRIPT)])).unwrap();
    assert_eq!(fs::read_to_string(root.join(MANIFEST)).unwrap(), with_output);
}

/// Absent and unreadable aren't alike: a manifest that is there but isn't TOML is never written over.
#[test]
fn a_manifest_that_isnt_toml_is_not_written_over() {
    let dir = workdir("manifest-broken");
    let root = new_project(&dir);
    let broken = "format = = 1\n# the user's\n";
    fs::write(root.join(MANIFEST), broken).unwrap();
    let m = Manifest { format: 1, map: Some(header("Map")), archive: Default::default(), pack: Default::default() };
    assert!(m.save(&root).is_err());
    assert_eq!(fs::read_to_string(root.join(MANIFEST)).unwrap(), broken);
    // Not there: written new.
    fs::remove_file(root.join(MANIFEST)).unwrap();
    m.save(&root).unwrap();
    assert_eq!(Manifest::load(&root).unwrap().map.unwrap().name, "Map");
}

/// Manifests damaged in many seeded ways: saving never panics, a refused save leaves the file as it
/// was, and what a save writes still loads.
#[test]
fn damaged_manifests_never_panic_a_save() {
    let dir = workdir("manifest-hostile");
    let root = new_project(&dir);
    let base = commented(&root).into_bytes();
    let m = Manifest { format: 1, map: Some(header("Map")), archive: Default::default(), pack: Default::default() };
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    for round in 0..300 {
        let mut bytes = base.clone();
        for _ in 0..1 + round % 4 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let at = (seed % bytes.len() as u64) as usize;
            match seed % 3 {
                0 => bytes[at] = b"[]=\"'#\n.,{}"[(seed >> 8) as usize % 11],
                1 => bytes.truncate(at),
                _ => bytes.insert(at, (seed >> 16) as u8),
            }
            if bytes.is_empty() {
                bytes.push(b'#');
            }
        }
        fs::write(root.join(MANIFEST), &bytes).unwrap();
        match m.save(&root) {
            Ok(()) => {
                if fs::read(root.join(MANIFEST)).unwrap() != bytes {
                    assert!(Manifest::load(&root).is_ok(), "round {round}: a written manifest doesn't load");
                }
            }
            Err(_) => assert_eq!(fs::read(root.join(MANIFEST)).unwrap(), bytes, "round {round}: a refused save changed the file"),
        }
    }
}

/// Only where a name can hold a `\` (on Windows these names are paths).
#[cfg(unix)]
#[test]
fn a_sync_never_deletes_a_file_with_a_backslash_in_its_name() {
    let dir = workdir("strays-kept");
    let root = new_project(&dir);
    let map = root.join("map");
    fs::write(map.join(r"Scripts\a.lua"), b"mine").unwrap();
    fs::create_dir_all(map.join(r"old\dir")).unwrap();
    fs::write(map.join(r"old\dir").join("b.txt"), b"in a stray folder").unwrap();
    fs::write(map.join("added.txt"), b"not in the map").unwrap();
    fs::create_dir_all(root.join("unnamed")).unwrap();
    fs::write(root.join("unnamed").join(r"x\y.bin"), b"unnamed stray").unwrap();
    // A chapter map no longer in the campaign, with a stray in it: kept whole.
    let chapter = root.join("maps").join("Old.w3x");
    project::create(&chapter, Some(header("Old"))).unwrap();
    fs::write(chapter.join("map").join(r"a\b.txt"), b"chapter stray").unwrap();
    project::write_files(&root, extracted(&root, "Map", &[("war3map.j", SCRIPT)])).unwrap();
    assert_eq!(fs::read(map.join(r"Scripts\a.lua")).unwrap(), b"mine");
    assert_eq!(fs::read(map.join(r"old\dir").join("b.txt")).unwrap(), b"in a stray folder");
    assert_eq!(fs::read(root.join("unnamed").join(r"x\y.bin")).unwrap(), b"unnamed stray");
    assert_eq!(fs::read(chapter.join("map").join(r"a\b.txt")).unwrap(), b"chapter stray");
    assert!(!map.join("added.txt").exists(), "a file the map doesn't have goes on a sync");
}
