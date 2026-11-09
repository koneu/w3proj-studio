//! What a sync tells: the strays it left alone (`UnpackReport::strays`), and what it would delete
//! before it does (`UnpackOptions::refuse_deletes`), so the app can ask.

mod sync_common;

use std::fs;

use sync_common::*;
use w3proj::project::{self, MANIFEST};
use w3proj::{Registry, UnpackOptions};

/// Only where a name can hold a `\` (on Windows these names are paths).
#[cfg(unix)]
#[test]
fn a_sync_reports_the_strays_it_kept() {
    let dir = workdir("strays-reported");
    let root = new_project(&dir);
    fs::write(root.join("map").join(r"Scripts\a.lua"), b"mine").unwrap();
    let chapter = root.join("maps").join("Old.w3x");
    project::create(&chapter, Some(header("Old"))).unwrap();
    fs::write(chapter.join("map").join(r"a\b.txt"), b"x").unwrap();
    let r = project::write_files(&root, extracted(&root, "Map", &[("war3map.j", SCRIPT)])).unwrap();
    assert_eq!(r.strays, ["map/Scripts\\a.lua", "maps/Old.w3x/"]);
    assert_eq!(r.deleted, 0);
    // Strays aren't among what a sync would delete.
    let ex = extracted(&root, "Map", &[("war3map.j", SCRIPT)]);
    let codecs = Registry::with_formats(&[]).unwrap();
    assert_eq!(project::would_delete(&root, &ex, &codecs).unwrap(), Vec::<String>::new());
}

/// A file the map has in another form (raw where the project has the codec's text, as when the trigger codec can't
/// run) is replaced, not lost: no question for it.
#[test]
fn a_file_only_written_in_another_form_isnt_among_what_goes() {
    let dir = workdir("other-form");
    let root = new_project(&dir);
    let codecs = Registry::with_formats(&[]).unwrap();
    assert!(codecs.for_project_path("war3map.w3u.json").is_some(), "control: the object codec names war3map.w3u.json");
    fs::write(root.join("map").join("war3map.w3u.json"), b"{}").unwrap();
    fs::write(root.join("map").join("added.txt"), b"mine").unwrap();
    let ex = extracted(&root, "Map", &[("war3map.j", SCRIPT), ("war3map.w3u", b"raw")]);
    assert_eq!(project::would_delete(&root, &ex, &codecs).unwrap(), ["map/added.txt"]);
    // A file named like a codec's output but marked raw in the project is that very archive file: the map doesn't have it.
    let mut m = w3proj::Manifest::load(&root).unwrap();
    m.pack.raw = vec!["war3map.w3u.json".into()];
    m.save(&root).unwrap();
    assert_eq!(project::would_delete(&root, &ex, &codecs).unwrap(), ["map/added.txt", "map/war3map.w3u.json"]);
}

#[test]
fn what_a_sync_would_delete_is_known_before_and_nothing_is_written() {
    let dir = workdir("would-delete");
    let root = new_project(&dir);
    let codecs = Registry::with_formats(&[]).unwrap();
    let built = dir.join("built.w3x");
    w3proj::pack(&root, Some(&built), &codecs).unwrap();
    fs::create_dir_all(root.join("map").join("Imports")).unwrap();
    fs::write(root.join("map").join("Imports").join("added.txt"), b"mine").unwrap();
    let gone_chapter = root.join("maps").join("Gone.w3x");
    project::create(&gone_chapter, Some(header("Gone"))).unwrap();
    let manifest = fs::read(root.join(MANIFEST)).unwrap();
    let opts = UnpackOptions { refuse_deletes: true, ..Default::default() };
    match w3proj::unpack(&built, &root, &codecs, &opts) {
        Err(w3proj::Error::WouldDelete(gone)) => assert_eq!(gone, ["map/Imports/added.txt", "maps/Gone.w3x/"]),
        other => panic!("expected WouldDelete, got {:?}", other.map(|r| r.deleted)),
    }
    assert!(root.join("map").join("Imports").join("added.txt").exists());
    assert!(gone_chapter.join(MANIFEST).exists());
    assert_eq!(fs::read(root.join(MANIFEST)).unwrap(), manifest, "nothing was written");
    // Asked and answered: the sync deletes them.
    let r = w3proj::unpack(&built, &root, &codecs, &UnpackOptions::default()).unwrap();
    assert_eq!(r.deleted, 2);
    assert!(!root.join("map").join("Imports").exists());
    // Nothing to delete: no refusal.
    w3proj::unpack(&built, &root, &codecs, &opts).unwrap();
}
