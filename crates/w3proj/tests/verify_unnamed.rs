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

/// A map without a (listfile) holding `files` (name, bytes) besides war3map.w3i and the plain script: how many of
/// them stay unnamed.
fn unnamed_among(tag: &str, files: &[(&str, Vec<u8>)]) -> usize {
    unnamed_with_script(tag, PLAIN, files)
}

fn unnamed_with_script(tag: &str, script: &str, files: &[(&str, Vec<u8>)]) -> usize {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("verify-unnamed-{tag}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut b = ArchiveBuilder::new(WriteOptions { listfile: false, ..WriteOptions::default() });
    b.add("war3map.w3i", vec![28, 0, 0, 0]);
    b.add("war3map.j", script.as_bytes().to_vec());
    for (name, bytes) in files {
        b.add(name, bytes.clone());
    }
    let path = dir.join("map.w3x");
    std::fs::write(&path, b.write(b"HM3W\0\0\0\0").unwrap()).unwrap();
    let r = w3proj::project::verify(&path, &Registry::empty(), None).unwrap();
    assert!(r.ok(), "{:?}", r.mismatches);
    r.unnamed
}

/// An MDX whose MODL chunk is named `name` and which lists `texture` (or none).
fn mdx(name: &str, texture: Option<&str>) -> Vec<u8> {
    let mut out = b"MDLX".to_vec();
    let chunk = |out: &mut Vec<u8>, tag: &[u8], data: &[u8]| {
        out.extend_from_slice(tag);
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(data);
    };
    chunk(&mut out, b"VERS", &800u32.to_le_bytes());
    let mut modl = vec![0u8; 80 + 4 + 28 + 4];
    modl[..name.len()].copy_from_slice(name.as_bytes());
    chunk(&mut out, b"MODL", &modl);
    if let Some(t) = texture {
        let mut tex = vec![0u8; 268];
        tex[4..4 + t.len()].copy_from_slice(t.as_bytes());
        chunk(&mut out, b"TEXS", &tex);
    }
    out
}

/// The Chosen Ones campaign (2026-11-20): its files are named by none of the earlier rules, but by these. Each file is
/// read in the second pass even unnamed, so a model names itself and its textures.
#[test]
fn a_model_names_itself_by_its_modl_name_in_the_import_folders() {
    assert_eq!(unnamed_among("modl", &[("war3campImported\\Tower01.mdx", mdx("Tower01", None))]), 0);
    // Control: stored under another name than its MODL name, nothing names it.
    assert_eq!(unnamed_among("modl-control", &[("war3campImported\\Tower02.mdx", mdx("Tower01", None))]), 1);
}

#[test]
fn a_texture_a_model_names_with_folders_is_found_by_its_file_name_in_the_import_folders() {
    let files = |stored: &'static str| vec![("war3campImported\\Axe.mdx", mdx("Axe", Some("Textures\\Zap1b.blp"))), (stored, b"BLP1 tex".to_vec())];
    assert_eq!(unnamed_among("tex-camp", &files("war3campImported\\Zap1b.blp")), 0);
    assert_eq!(unnamed_among("tex-root", &files("Zap1b.blp")), 0);
    assert_eq!(unnamed_among("tex-control", &files("war3campImported\\Zap1c.blp")), 1);
}

#[test]
fn a_chapter_scripts_war3map_imported_path_names_the_campaign_import_and_fonts_are_named() {
    let script = format!("{PLAIN}call AddSpecialEffect(\"war3mapImported\\\\Knock.mdx\", 0, 0)\n// ChatFont=BLKCHCRY.ttf\n");
    let r = |tag: &str, stored: &str| unnamed_with_script(tag, &script, &[(stored, b"x".to_vec())]);
    assert_eq!(r("swap-camp", "war3campImported\\Knock.mdx"), 0);
    assert_eq!(r("swap-font", "BLKCHCRY.ttf"), 0);
    assert_eq!(r("swap-control", "war3campImported\\Other.mdx"), 1, "control");
}
