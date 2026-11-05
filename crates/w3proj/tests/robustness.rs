//! Maps are downloaded from strangers, so everything here reads hostile bytes. Each test damages
//! valid data in many seeded, repeatable ways and checks what must hold for any input:
//!
//! - reading never panics, it returns an error;
//! - whatever a codec accepts still packs back to the bytes it came from.
//!
//! `W3PROJ_ROBUSTNESS_ROUNDS` overrides the number of rounds per file (default 200: quick enough
//! to run on every commit; the local gate runs more). A failure prints the seed to reproduce it.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, Once};

use mpq::Archive;
use w3proj::Registry;

/// A small generator with a fixed seed: the same damage on every run and machine.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

/// Damage of the kinds that break parsers: flipped bits, numbers at their limits (counts, lengths,
/// offsets), cut-off files, moved or doubled parts.
fn damage(data: &[u8], rng: &mut Rng) -> Vec<u8> {
    let mut b = data.to_vec();
    if b.is_empty() {
        return b;
    }
    for _ in 0..1 + rng.below(4) {
        let at = rng.below(b.len());
        match rng.below(6) {
            0 => b[at] ^= 1 << rng.below(8),
            1 => b[at] = rng.next() as u8,
            2 => {
                let limit: [u8; 4] = match rng.below(4) {
                    0 => [0xff; 4],
                    1 => [0xff, 0xff, 0xff, 0x7f],
                    2 => [0; 4],
                    _ => [0, 0, 0, 0x80],
                };
                let end = (at + 4).min(b.len());
                b[at..end].copy_from_slice(&limit[..end - at]);
            }
            3 => b.truncate(at.max(1)),
            4 => {
                let end = (at + rng.below(64)).min(b.len());
                let part = b[at..end].to_vec();
                let to = rng.below(b.len());
                b.splice(to..to, part);
            }
            _ => {
                let end = (at + rng.below(64)).min(b.len());
                b.drain(at..end);
                if b.is_empty() {
                    b.push(0);
                }
            }
        }
    }
    b
}

fn rounds() -> u64 {
    std::env::var("W3PROJ_ROBUSTNESS_ROUNDS").ok().and_then(|v| v.parse().ok()).unwrap_or(200)
}

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mini-map")
}

fn tmp(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("robustness");
    fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

/// The fixture as a map. Tests run in parallel: each passes its own name.
fn map_bytes(name: &str) -> Vec<u8> {
    let out = tmp(name);
    w3proj::pack(&fixture(), Some(&out), &Registry::default()).unwrap();
    fs::read(out).unwrap()
}

/// Files of the map that a codec reads.
fn codec_files(test: &str) -> Vec<(String, Vec<u8>)> {
    let archive = Archive::from_bytes(map_bytes(&format!("{test}.w3x"))).unwrap();
    let codecs = Registry::default();
    archive
        .read("(listfile)")
        .map(|l| String::from_utf8_lossy(&l).lines().map(str::to_string).collect::<Vec<_>>())
        .unwrap()
        .into_iter()
        .filter(|name| codecs.for_archive_name(name).next().is_some())
        .map(|name| {
            let bytes = archive.read(&name).unwrap();
            (name, bytes)
        })
        .collect()
}

thread_local! {
    /// Set while `guarded` runs code that may panic on purpose-damaged input.
    static GUARDED: Cell<bool> = const { Cell::new(false) };
}

/// Inside `guarded` a panic is collected instead of printed: each distinct one is listed once,
/// however many seeds meet it. Outside (a failed assert of the test itself) nothing changes.
fn collected_panics() -> &'static Mutex<Vec<String>> {
    static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());
    static HOOK: Once = Once::new();
    HOOK.call_once(|| {
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if !GUARDED.get() {
                return default(info);
            }
            let at = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
            SEEN.lock().unwrap().push(format!("{at}: {}", info.payload_as_str().unwrap_or("panic")));
        }));
    });
    &SEEN
}

/// Runs `body` and records a panic under `what`.
fn guarded(failures: &mut BTreeMap<String, String>, what: impl Fn() -> String, body: impl FnOnce()) {
    let seen = collected_panics();
    GUARDED.set(true);
    let result = catch_unwind(AssertUnwindSafe(body));
    GUARDED.set(false);
    if result.is_err() {
        let message = seen.lock().unwrap().pop().unwrap_or_default();
        // The same bug is met by many seeds: keep the first of each.
        failures.entry(message).or_insert_with(what);
    }
}

fn report(failures: BTreeMap<String, String>) {
    assert!(
        failures.is_empty(),
        "{} distinct failures:\n{}",
        failures.len(),
        failures.iter().map(|(m, w)| format!("  {m}\n    first seen: {w}")).collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn codecs_survive_damaged_files() {
    let codecs = Registry::default();
    let mut failures = BTreeMap::new();
    let mut lost = Vec::new();
    let (mut accepted, mut rejected) = (0, 0);
    for (name, bytes) in codec_files("codecs") {
        for seed in 0..rounds() {
            let bad = damage(&bytes, &mut Rng::new(seed + 1));
            for codec in codecs.for_archive_name(&name) {
                let what = || format!("decode {name} with {}, seed {seed}", codec.id());
                guarded(&mut failures, what, || {
                    // The promise that keeps unpacking safe: a codec is only used if encode
                    // gives the file back, so that check must never panic either.
                    let Ok(project) = codec.decode(&name, &bad) else {
                        rejected += 1;
                        return;
                    };
                    accepted += 1;
                    {
                        if let Ok(again) = codec.encode(&name, &project) {
                            if again != bad {
                                lost.push(format!("{name} with {}, seed {seed}", codec.id()));
                            }
                        }
                    }
                });
            }
        }
    }
    report(failures);
    // Not all codecs promise exact bytes on their own (project.rs compares and falls back to raw),
    // so this is only printed; the test below checks the promise end to end.
    println!("{accepted} damaged files accepted, {rejected} rejected, {} of them encoded differently (these fall back to raw)", lost.len());
    assert!(accepted > 0 && rejected > 0, "the damage reached nothing: {accepted} accepted, {rejected} rejected");
}

#[test]
fn damaged_project_files_are_errors() {
    let codecs = Registry::default();
    let mut failures = BTreeMap::new();
    for (name, bytes) in codec_files("project-files") {
        let codec = codecs.for_archive_name(&name).next().unwrap();
        let project = codec.decode(&name, &bytes).unwrap();
        for seed in 0..rounds() {
            let bad = damage(&project, &mut Rng::new(seed + 1));
            let what = || format!("encode {name} with {}, seed {seed}", codec.id());
            guarded(&mut failures, what, || {
                let _ = codec.encode(&name, &bad);
            });
        }
    }
    report(failures);
}

#[test]
fn archive_reader_survives_damaged_maps() {
    let bytes = map_bytes("archive.w3x");
    let mut failures = BTreeMap::new();
    for seed in 0..rounds() * 20 {
        let bad = damage(&bytes, &mut Rng::new(seed + 1));
        guarded(&mut failures, || format!("seed {seed}"), || {
            if let Ok(archive) = Archive::from_bytes(bad) {
                for slot in archive.slots() {
                    let _ = archive.read_block(&slot.block, None);
                }
                let _ = archive.read("(listfile)");
                let _ = archive.read("war3map.j");
            }
        });
    }
    report(failures);
}

/// Damage aimed at what the archive tables point to, through the file contents: compression
/// methods and sector tables are read before anything is checked.
#[test]
fn decompression_survives_damaged_sectors() {
    let bytes = map_bytes("sectors.w3x");
    // 0x200: the archive starts after the map header; its own header has the table offsets.
    let body_end = bytes.len().saturating_sub(4096);
    let mut failures = BTreeMap::new();
    for seed in 0..rounds() * 20 {
        let mut rng = Rng::new(seed + 1);
        let mut bad = bytes.clone();
        for _ in 0..1 + rng.below(8) {
            let at = 0x220 + rng.below(body_end.saturating_sub(0x220));
            bad[at] = rng.next() as u8;
        }
        guarded(&mut failures, || format!("seed {seed}"), || {
            if let Ok(archive) = Archive::from_bytes(bad) {
                for slot in archive.slots() {
                    let _ = archive.read_block(&slot.block, None);
                }
            }
        });
    }
    report(failures);
}

#[test]
fn verify_never_reports_a_silent_change() {
    let bytes = map_bytes("verify.w3x");
    let codecs = Registry::default();
    let path = tmp("damaged.w3x");
    let mut failures = BTreeMap::new();
    let mut changed = Vec::new();
    for seed in 0..rounds() {
        fs::write(&path, damage(&bytes, &mut Rng::new(seed + 1))).unwrap();
        guarded(&mut failures, || format!("seed {seed}"), || {
            if let Ok(report) = w3proj::verify(&path, &codecs, None) {
                if !report.mismatches.is_empty() {
                    changed.push(format!("seed {seed}: {:?}", report.mismatches));
                }
            }
        });
    }
    report(failures);
    assert!(changed.is_empty(), "packed differently:\n{}", changed.join("\n"));
}
