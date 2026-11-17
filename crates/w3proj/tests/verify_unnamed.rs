//! Why `w3proj verify` calls a map "incomplete" (4 of smoketest_maps, 2026-11-16: the four copies of The Chosen Ones
//! campaign, 580 files unnamed each): the archive has no (listfile) and no war3campaign.imp, and some imports are named
//! by no file that is read (no script, model or object data mentions them), so their names can't be recovered. They
//! are counted as unnamed, the map still round-trips (ok), and a name found anywhere names the file again.

use std::path::{Path, PathBuf};

use mpq::{ArchiveBuilder, WriteOptions};
use w3proj::Registry;

const ORPHAN: &str = "war3campImported\\Orphan.blp";

fn map(tag: &str, listfile: bool, script: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("verify-unnamed-{tag}"));
    let _ = std::fs::remove_dir_all(&dir); // nothing of an earlier run
    std::fs::create_dir_all(&dir).unwrap();
    let mut b = ArchiveBuilder::new(WriteOptions { listfile, ..WriteOptions::default() });
    // A map is told by its war3map.w3i; with no codecs its bytes are only carried over.
    b.add("war3map.w3i", vec![28, 0, 0, 0]);
    b.add("war3map.j", script.as_bytes().to_vec());
    b.add(ORPHAN, b"BLP1 not referenced".to_vec());
    let path = dir.join("map.w3x");
    std::fs::write(&path, b.write(b"HM3W\0\0\0\0").unwrap()).unwrap();
    path
}

const PLAIN: &str = "function main takes nothing returns nothing\nendfunction\n";

#[test]
fn an_import_nothing_names_in_a_map_without_a_listfile_is_unnamed_and_the_map_still_round_trips() {
    let r = w3proj::project::verify(&map("bare", false, PLAIN), &Registry::empty(), None).unwrap();
    assert!(r.ok(), "{:?}", r.mismatches);
    assert_eq!(r.unnamed, 1, "the orphan import is unnamed");
    assert!(r.errors.is_empty());
}

#[test]
fn control_a_listfile_or_a_script_naming_it_names_the_import() {
    let listed = w3proj::project::verify(&map("listed", true, PLAIN), &Registry::empty(), None).unwrap();
    assert_eq!(listed.unnamed, 0);
    let named = format!("{PLAIN}// {ORPHAN}\n");
    let r = w3proj::project::verify(&map("script", false, &named), &Registry::empty(), None).unwrap();
    assert!(r.ok(), "{:?}", r.mismatches);
    assert_eq!(r.unnamed, 0, "the script's mention names it");
}

/// A script names its files in string literals, whose backslashes are doubled: `"war3campImported\\Orphan.blp"` names
/// war3campImported\Orphan.blp (The Chosen Ones campaign: 44 of its 580 unnamed files are named only that way).
#[test]
fn a_script_string_literal_with_doubled_backslashes_names_the_import() {
    let literal = format!("{PLAIN}call Preload(\"{}\")\n", ORPHAN.replace('\\', r"\\"));
    assert!(literal.contains(r"war3campImported\\Orphan.blp"), "the literal's backslashes are doubled");
    let r = w3proj::project::verify(&map("literal", false, &literal), &Registry::empty(), None).unwrap();
    assert!(r.ok(), "{:?}", r.mismatches);
    assert_eq!(r.unnamed, 0, "the script's string literal names it");
}
