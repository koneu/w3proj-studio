//! Why a packed map has one entry fewer than the original (test.md: "(2)EchoIsles_S2_v2.2 writes 27 entries where the
//! original has 28"): the dropped entry is (attributes), the MPQ's per-block CRC32 table. Unpack doesn't keep it and
//! pack doesn't write it, on purpose (`project::build_archive`); every named file of the map is still packed. The same
//! held for every map of smoketest_maps that has an (attributes) (2026-11-16); maps without one keep their count.

use std::path::{Path, PathBuf};

use mpq::{Archive, ArchiveBuilder, WriteOptions};
use w3proj::project::{self, UnpackOptions};
use w3proj::Registry;

const IMPORT: &str = "war3mapImported\\Kept.blp";

fn dir(tag: &str) -> PathBuf {
    let d = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("pack-meta-{tag}"));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A map as the World Editor saves it: its files, a (listfile) and an (attributes); `signed` adds a (signature).
fn original(d: &Path, signed: bool) -> PathBuf {
    let mut b = ArchiveBuilder::new(WriteOptions::default());
    b.add("war3map.w3i", vec![28, 0, 0, 0]);
    b.add("war3map.j", b"function main takes nothing returns nothing\nendfunction\n".to_vec());
    b.add(IMPORT, b"BLP1 an import".to_vec());
    // Version 100, CRC32 only, one CRC per block (contents don't matter: nothing reads them).
    let mut attributes = vec![100, 0, 0, 0, 1, 0, 0, 0];
    attributes.extend([0u8; 4 * 5]);
    b.add("(attributes)", attributes);
    if signed {
        b.add("(signature)", vec![0u8; 72]);
    }
    let path = d.join("original.w3x");
    std::fs::write(&path, b.write(b"HM3W\0\0\0\0").unwrap()).unwrap();
    path
}

fn round_trip(tag: &str, signed: bool) -> (Archive, Archive) {
    let d = dir(tag);
    let map = original(&d, signed);
    let codecs = Registry::empty();
    project::unpack(&map, &d.join("proj"), &codecs, &UnpackOptions::default()).unwrap();
    let out = d.join("packed.w3x");
    project::pack(&d.join("proj"), Some(&out), &codecs).unwrap();
    (Archive::open(&map).unwrap(), Archive::open(&out).unwrap())
}

#[test]
fn pack_leaves_out_attributes_and_signature_and_keeps_every_named_file() {
    let (orig, packed) = round_trip("signed", true);
    assert!(orig.read("(attributes)").is_ok(), "control: the original has an (attributes)");
    assert!(orig.read("(signature)").is_ok(), "control: the original has a (signature)");
    assert!(packed.read("(attributes)").is_err(), "the packed map has no (attributes)");
    assert!(packed.read("(signature)").is_err(), "the packed map has no (signature)");
    for name in ["war3map.w3i", "war3map.j", IMPORT] {
        assert_eq!(packed.read(name).unwrap(), orig.read(name).unwrap(), "{name} is packed as it was");
    }
    let list = String::from_utf8(packed.read("(listfile)").unwrap()).unwrap();
    assert!(list.split("\r\n").any(|n| n == IMPORT), "the new (listfile) names the import: {list:?}");
}

#[test]
fn the_packed_map_has_exactly_one_entry_fewer_than_an_unsigned_original() {
    let (orig, packed) = round_trip("unsigned", false);
    let (o, p) = (orig.header().block_table_entries, packed.header().block_table_entries);
    assert_eq!(o, 5, "control: three files, (listfile) and (attributes)");
    assert_eq!(p, o - 1, "only (attributes) is gone");
}

/// The project holds none of the bookkeeping, so a project can't carry a stale (attributes) into a pack.
#[test]
fn unpack_writes_no_meta_file_into_the_project() {
    let d = dir("project");
    let map = original(&d, true);
    project::unpack(&map, &d.join("proj"), &Registry::empty(), &UnpackOptions::default()).unwrap();
    for meta in ["(listfile)", "(attributes)", "(signature)"] {
        assert!(!d.join("proj").join("map").join(meta).exists(), "{meta} isn't in the project");
    }
    assert!(d.join("proj").join("map").join("war3map.j").exists(), "control: the map's files are");
}
