//! The MPQ `(attributes)`: what real maps hold (corpus tier) and what `w3proj pack --attributes` writes.
//!
//! The corpus test reads every map of the corpus (W3PROJ_CORPUS, default `smoketest_maps` next to the main checkout;
//! campaigns' chapter maps too) that has an (attributes), recomputes the CRC32 of each block it can read with
//! `mpq::attributes::crc32` and checks it against the stored one: the writer uses that function, so this proves its
//! values are the World Editor's. Without the corpus it says so and passes; with `W3PROJ_REQUIRE_CORPUS=1` (the gate's
//! `rustcorpus`) it fails.

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Output;

use mpq::attributes::{self, Attributes};
use mpq::Archive;

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mini-map")
}

fn workdir(test: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("attributes-{test}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn w3proj(args: &[&str]) -> Output {
    common::w3proj_cmd().args(args).output().unwrap()
}

fn ok(args: &[&str]) -> String {
    let o = w3proj(args);
    let text = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
    assert!(o.status.success(), "w3proj {args:?} failed: {text}");
    text
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap() {
        let p = e.unwrap().path();
        let dest = to.join(p.file_name().unwrap());
        if p.is_dir() {
            copy_dir(&p, &dest);
        } else {
            fs::copy(&p, &dest).unwrap();
        }
    }
}

fn files(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for e in fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                out.insert(p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"), fs::read(&p).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

/// What checking one archive's (attributes) found.
#[derive(Default, Debug)]
struct Checked {
    blocks: usize,
    /// Blocks read and compared.
    matched: usize,
    /// Encrypted blocks no name is known for.
    unreadable: usize,
    mismatches: Vec<String>,
}

/// Recomputes the CRC32 of every block of `a` it can read and compares it with its (attributes). `None`: there is none.
fn check(a: &Archive) -> Option<Checked> {
    let raw = a.read(attributes::NAME).ok()?;
    let n = a.header().block_table_entries as usize;
    let mut c = Checked { blocks: n, ..Checked::default() };
    let attrs = match Attributes::parse(&raw, n) {
        Ok(attrs) => attrs,
        Err(e) => {
            c.mismatches.push(format!("unreadable: {e}"));
            return Some(c);
        }
    };
    if attrs.version != attributes::VERSION || attrs.flags & attributes::CRC32 == 0 {
        c.mismatches.push(format!("version {} flags {:#x}", attrs.version, attrs.flags));
        return Some(c);
    }
    let list = String::from_utf8_lossy(&a.read("(listfile)").unwrap_or_default()).into_owned();
    let mut names: BTreeMap<u32, String> = BTreeMap::new();
    for name in list.lines().chain(w3proj::names::META_FILES.iter().copied()) {
        if let Some(slot) = a.find(name) {
            names.insert(slot.hash.block_index, name.to_string());
        }
    }
    let own = a.find(attributes::NAME).map(|s| s.hash.block_index);
    for slot in a.slots() {
        let i = slot.hash.block_index;
        let stored = attrs.crc32[i as usize];
        if Some(i) == own {
            if stored != 0 {
                c.mismatches.push(format!("(attributes)'s own CRC is {stored:#x}"));
            }
            continue;
        }
        match a.read_block(&slot.block, names.get(&i).map(String::as_str)) {
            Ok(data) if attributes::crc32(&data) == stored => c.matched += 1,
            Ok(data) => c.mismatches.push(format!("block {i} {:?}: stored {stored:#x}, computed {:#x}", names.get(&i), attributes::crc32(&data))),
            Err(mpq::Error::NeedsName) => c.unreadable += 1,
            Err(e) => c.mismatches.push(format!("block {i} {:?}: {e}", names.get(&i))),
        }
    }
    Some(c)
}

fn corpus() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("W3PROJ_CORPUS") {
        return Some(PathBuf::from(p)).filter(|p| p.is_dir());
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().map(|d| d.join("smoketest_maps")).find(|p| p.is_dir())
}

fn is_map(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".w3x") || n.ends_with(".w3m") || n.ends_with(".w3n")
}

fn maps(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            maps(&p, out);
        } else if is_map(&p.to_string_lossy()) {
            out.push(p);
        }
    }
}

/// Every (attributes) of the corpus, chapter maps included, against CRC32s computed here.
fn check_archive(a: &Archive, at: &str, report: &mut Vec<(String, Checked)>) {
    if let Some(c) = check(a) {
        report.push((at.to_string(), c));
    }
    let list = String::from_utf8_lossy(&a.read("(listfile)").unwrap_or_default()).into_owned();
    for name in list.lines().filter(|n| is_map(n)) {
        if let Some(inner) = a.read(name).ok().and_then(|b| Archive::from_bytes(b).ok()) {
            check_archive(&inner, &format!("{at}/{name}"), report);
        }
    }
}

#[test]
fn real_maps_crcs_are_recomputed_exactly() {
    let Some(dir) = corpus() else {
        return common::skip_or_fail("no map corpus (smoketest_maps or W3PROJ_CORPUS)");
    };
    let mut paths = Vec::new();
    maps(&dir, &mut paths);
    let mut report = Vec::new();
    for p in &paths {
        if let Ok(a) = Archive::open(p) {
            check_archive(&a, &p.display().to_string(), &mut report);
        }
    }
    let matched: usize = report.iter().map(|(_, c)| c.matched).sum();
    let unreadable: usize = report.iter().map(|(_, c)| c.unreadable).sum();
    println!("{} archives with (attributes), {matched} blocks' CRC32 recomputed, {unreadable} unreadable", report.len());
    let bad: Vec<String> = report
        .iter()
        .filter(|(_, c)| !c.mismatches.is_empty())
        .map(|(at, c)| format!("{at}: {}", c.mismatches.iter().take(5).cloned().collect::<Vec<_>>().join("; ")))
        .collect();
    assert!(bad.is_empty(), "CRC32s that don't match:\n{}", bad.join("\n"));
    // The corpus of 2026-11-25 has 121 such archives (chapter maps counted) and 20,301 readable blocks; a run that
    // finds few compared nothing.
    assert!(report.len() >= 10 && matched >= 1000, "too little compared: {} archives, {matched} blocks", report.len());
}

#[test]
fn pack_with_attributes_writes_a_crc_per_block_and_the_same_bytes_twice() {
    let dir = workdir("pack");
    let (a, b, plain) = (dir.join("a.w3x"), dir.join("b.w3x"), dir.join("plain.w3x"));
    ok(&["pack", s(&fixture()), "-o", s(&a), "--attributes"]);
    ok(&["pack", s(&fixture()), "-o", s(&b), "--attributes"]);
    ok(&["pack", s(&fixture()), "-o", s(&plain)]);
    assert_eq!(fs::read(&a).unwrap(), fs::read(&b).unwrap(), "packing twice gave other bytes");

    let (with, without) = (Archive::open(&a).unwrap(), Archive::open(&plain).unwrap());
    assert!(!without.contains(attributes::NAME), "control: without the flag there is none");
    let c = check(&with).expect("the flag wrote an (attributes)");
    assert!(c.mismatches.is_empty(), "{:?}", c.mismatches);
    assert_eq!((c.blocks, c.matched, c.unreadable), (without.header().block_table_entries as usize + 1, c.blocks - 1, 0));
    let attrs = Attributes::parse(&with.read(attributes::NAME).unwrap(), c.blocks).unwrap();
    assert_eq!((attrs.version, attrs.flags, attrs.time.len()), (100, attributes::CRC32, 0), "the World Editor's form: no time stamps");
    assert_eq!(with.find(attributes::NAME).unwrap().hash.block_index as usize, c.blocks - 1, "it is the last block");

    // Every file but the bookkeeping is the same as without the flag.
    let list = String::from_utf8(without.read("(listfile)").unwrap()).unwrap();
    assert_eq!(with.read("(listfile)").unwrap(), list.as_bytes(), "(listfile) names the same files");
    for name in list.lines() {
        assert_eq!(with.read(name).unwrap(), without.read(name).unwrap(), "{name}");
    }

    // pack -> unpack -> verify, and the unpacked project is the same as one unpacked from the map without it.
    let (p1, p2) = (dir.join("project-with"), dir.join("project-without"));
    ok(&["unpack", s(&a), s(&p1), "--game", "none"]);
    ok(&["unpack", s(&plain), s(&p2), "--game", "none"]);
    assert!(files(&p1) == files(&p2), "unpacking the map with (attributes) gave other project files");
    let out = ok(&["verify", s(&a), "--game", "none"]);
    assert!(out.contains("1 ok"), "{out}");
    let again = dir.join("again.w3x");
    ok(&["pack", s(&p1), "-o", s(&again), "--attributes"]);
    let (first, second) = (Archive::open(&a).unwrap(), Archive::open(&again).unwrap());
    for name in list.lines().chain([attributes::NAME, "(listfile)"]) {
        assert_eq!(first.read(name).unwrap(), second.read(name).unwrap(), "{name} after pack, unpack, pack");
    }
}

/// A campaign's chapter maps get one too, as the World Editor's campaigns have them (every chapter map of the corpus).
#[test]
fn chapter_maps_get_attributes_too() {
    let dir = workdir("campaign");
    let campaign = dir.join("campaign");
    copy_dir(&fixture().join("../mini-campaign"), &campaign);
    copy_dir(&fixture(), &campaign.join("maps").join("Chapter.w3x"));
    let out = dir.join("c.w3n");
    ok(&["pack", s(&campaign), "-o", s(&out), "--attributes", "--game", "none"]);
    let outer = Archive::open(&out).unwrap();
    let c = check(&outer).expect("the campaign has an (attributes)");
    assert!(c.mismatches.is_empty() && c.matched == c.blocks - 1, "{c:?}");
    let inner = Archive::from_bytes(outer.read("Chapter.w3x").unwrap()).unwrap();
    let c = check(&inner).expect("the chapter map has an (attributes)");
    assert!(c.mismatches.is_empty() && c.matched == c.blocks - 1, "{c:?}");
}
