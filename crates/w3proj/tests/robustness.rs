//! Maps are downloaded from strangers, so everything here reads hostile bytes. Each test damages
//! valid data in many seeded, repeatable ways and checks what must hold for any input:
//!
//! - reading never panics, it returns an error;
//! - whatever a codec accepts still packs back to the bytes it came from.
//!
//! `W3PROJ_ROBUSTNESS_ROUNDS` overrides the number of rounds per file (default 200: quick enough
//! to run on every commit; the local gate runs more). A failure prints the seed to reproduce it.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::fs;
use std::ops::Range;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
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

/// The built-in codecs, with the fixture's made-up TriggerData so the trigger codec decodes too.
fn registry() -> Registry {
    let text = fs::read_to_string(fixture().join("../TriggerData.txt")).unwrap();
    let data = std::sync::Arc::new(w3proj::triggerdata::TriggerData::parse(&text));
    let mut codecs = Registry::default();
    codecs.set_trigger_data(std::sync::Arc::new(move || Some(data.clone())));
    codecs
}

fn tmp(name: &str) -> PathBuf {
    // The gate runs the debug and the release build of these tests at once: one folder each run.
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("robustness-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

/// The fixture as a map. Tests run in parallel: each passes its own name.
fn map_bytes(name: &str) -> Vec<u8> {
    let out = tmp(name);
    w3proj::pack(&fixture(), Some(&out), &registry()).unwrap();
    fs::read(out).unwrap()
}

/// Files of the map that a codec reads.
fn codec_files(test: &str) -> Vec<(String, Vec<u8>)> {
    let archive = Archive::from_bytes(map_bytes(&format!("{test}.w3x"))).unwrap();
    let codecs = registry();
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
    /// The panics collected on this thread (a panic is reported by the thread it happens on).
    static SEEN: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

/// Inside `guarded` a panic is collected instead of printed: each distinct one is listed once,
/// however many seeds meet it. Outside (a failed assert of the test itself) nothing changes.
fn collect_panics() {
    static HOOK: Once = Once::new();
    HOOK.call_once(|| {
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if !GUARDED.get() {
                return default(info);
            }
            let at = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
            SEEN.with_borrow_mut(|seen| seen.push(format!("{at}: {}", info.payload_as_str().unwrap_or("panic"))));
        }));
    });
}

/// Runs `body` and records a panic under `what`.
fn guarded(failures: &mut BTreeMap<String, String>, what: impl Fn() -> String, body: impl FnOnce()) {
    collect_panics();
    GUARDED.set(true);
    let result = catch_unwind(AssertUnwindSafe(body));
    GUARDED.set(false);
    if result.is_err() {
        let message = SEEN.with_borrow_mut(|seen| seen.pop()).unwrap_or_default();
        // The same bug is met by many seeds: keep the first of each.
        failures.entry(message).or_insert_with(what);
    }
}

/// Seeds per piece of work. Fixed, so which seeds a piece gets never depends on the machine.
const CHUNK: u64 = 250;

/// A run of seeds for one thread. `seeds()` counts what it hands out, so that `par_seeds` can
/// check that every seed of the range ran exactly once.
struct Chunk {
    range: Range<u64>,
    count: Cell<u64>,
    hash: Cell<u64>,
}

fn mix(seed: u64) -> u64 {
    let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Chunk {
    fn seeds(&self) -> impl Iterator<Item = u64> + '_ {
        self.range.clone().inspect(|&seed| {
            self.count.set(self.count.get() + 1);
            self.hash.set(self.hash.get().wrapping_add(mix(seed)));
        })
    }
}

/// A failure's seed was asked for alone (then "the damage reached nothing" says nothing).
fn single_seed() -> bool {
    std::env::var("W3PROJ_ROBUSTNESS_SEED").is_ok()
}

/// The seeds of one loop: `0..total`, or with `W3PROJ_ROBUSTNESS_SEED=<n>` only seed n, to
/// reproduce a failure that names its seed.
fn seeds(total: u64) -> Range<u64> {
    match std::env::var("W3PROJ_ROBUSTNESS_SEED").ok().and_then(|v| v.parse::<u64>().ok()) {
        Some(only) if only < total => only..only + 1,
        Some(_) => 0..0,
        None => 0..total,
    }
}

/// Runs `work` over the seeds in chunks of `CHUNK` on all cores and returns what each chunk made,
/// in the order of the seeds. Seed s damages the same way whichever thread meets it.
/// Prints how many seeds ran and a hash of them, and fails if that isn't exactly `seeds`.
fn par_seeds<A: Send>(what: &str, seeds: Range<u64>, work: impl Fn(&Chunk) -> A + Sync) -> Vec<A> {
    let starts: Vec<u64> = seeds.clone().step_by(CHUNK as usize).collect();
    let next = AtomicUsize::new(0);
    let done: Mutex<Vec<Option<(A, u64, u64)>>> = Mutex::new((0..starts.len()).map(|_| None).collect());
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get()).min(starts.len());
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                let Some(&start) = starts.get(i) else { return };
                let chunk = Chunk { range: start..(start + CHUNK).min(seeds.end), count: Cell::new(0), hash: Cell::new(0) };
                let made = work(&chunk);
                done.lock().unwrap()[i] = Some((made, chunk.count.get(), chunk.hash.get()));
            });
        }
    });
    let (mut count, mut hash) = (0u64, 0u64);
    let made: Vec<A> = done
        .into_inner()
        .unwrap()
        .into_iter()
        .map(|slot| {
            let (made, n, h) = slot.expect("a chunk of seeds didn't run");
            count += n;
            hash = hash.wrapping_add(h);
            made
        })
        .collect();
    let want_hash = seeds.clone().fold(0u64, |h, s| h.wrapping_add(mix(s)));
    println!("seeds {what}: {count} ran, hash {hash:016x}");
    assert_eq!((count, hash), (seeds.end - seeds.start, want_hash), "{what}: not exactly the seeds {seeds:?} ran");
    made
}

/// What one run of seeds found; `merge` puts the runs together as if it had been one.
#[derive(Default)]
struct Found {
    failures: BTreeMap<String, String>,
    notes: Vec<String>,
    accepted: u32,
    rejected: u32,
    per_codec: BTreeMap<String, (u32, u32)>,
}

impl Found {
    /// In the order of the seeds: the first failure of each kind stays the first.
    fn merge(&mut self, other: Found) {
        for (message, what) in other.failures {
            self.failures.entry(message).or_insert(what);
        }
        self.notes.extend(other.notes);
        self.accepted += other.accepted;
        self.rejected += other.rejected;
        for (codec, (a, r)) in other.per_codec {
            let e = self.per_codec.entry(codec).or_default();
            e.0 += a;
            e.1 += r;
        }
    }

    fn all(runs: Vec<Found>) -> Found {
        runs.into_iter().fold(Found::default(), |mut total, run| {
            total.merge(run);
            total
        })
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
    let codecs = registry();
    let mut total = Found::default();
    for (name, bytes) in codec_files("codecs") {
        let runs = par_seeds(&format!("codecs {name}"), seeds(rounds()), |chunk| {
            let mut found = Found::default();
            for seed in chunk.seeds() {
                let bad = damage(&bytes, &mut Rng::new(seed + 1));
                for codec in codecs.for_archive_name(&name) {
                    let what = || format!("decode {name} with {}, seed {seed}", codec.id());
                    guarded(&mut found.failures, what, || {
                        // The promise that keeps unpacking safe: a codec is only used if encode
                        // gives the file back, so that check must never panic either.
                        let Ok(project) = codec.decode(&name, &bad) else {
                            found.rejected += 1;
                            // Per codec: (accepted, rejected). A codec whose damage only ever goes
                            // one way proves little.
                            found.per_codec.entry(codec.id().to_string()).or_default().1 += 1;
                            return;
                        };
                        found.accepted += 1;
                        found.per_codec.entry(codec.id().to_string()).or_default().0 += 1;
                        if let Ok(again) = codec.encode(&name, &project) {
                            if again != bad {
                                found.notes.push(format!("{name} with {}, seed {seed}", codec.id()));
                            }
                        }
                    });
                }
            }
            found
        });
        total.merge(Found::all(runs));
    }
    let Found { failures, notes: lost, accepted, rejected, per_codec } = total;
    report(failures);
    // Not all codecs promise exact bytes on their own (project.rs compares and falls back to raw),
    // so this is only printed; the test below checks the promise end to end.
    println!("{accepted} damaged files accepted, {rejected} rejected, {} of them encoded differently (these fall back to raw)", lost.len());
    println!("per codec (accepted, rejected): {per_codec:?}");
    if !single_seed() {
        assert!(accepted > 0 && rejected > 0, "the damage reached nothing: {accepted} accepted, {rejected} rejected");
        let wtg = per_codec.get("wtg-json").copied().unwrap_or_default();
        assert!(wtg.0 > 0 && wtg.1 > 0, "wtg-json must see both damaged files it accepts and rejects: {per_codec:?}");
    }
}

#[test]
fn damaged_project_files_are_errors() {
    let codecs = registry();
    let mut total = Found::default();
    for (name, bytes) in codec_files("project-files") {
        let codec = codecs.for_archive_name(&name).next().unwrap();
        let project = codec.decode(&name, &bytes).unwrap();
        let runs = par_seeds(&format!("project files {name}"), seeds(rounds()), |chunk| {
            let mut found = Found::default();
            for seed in chunk.seeds() {
                let bad = damage(&project, &mut Rng::new(seed + 1));
                let what = || format!("encode {name} with {}, seed {seed}", codec.id());
                guarded(&mut found.failures, what, || {
                    let _ = codec.encode(&name, &bad);
                });
            }
            found
        });
        total.merge(Found::all(runs));
    }
    report(total.failures);
}

#[test]
fn archive_reader_survives_damaged_maps() {
    let bytes = map_bytes("archive.w3x");
    let runs = par_seeds("archive reader", seeds(rounds() * 20), |chunk| {
        let mut found = Found::default();
        for seed in chunk.seeds() {
            let bad = damage(&bytes, &mut Rng::new(seed + 1));
            guarded(&mut found.failures, || format!("seed {seed}"), || {
                if let Ok(archive) = Archive::from_bytes(bad) {
                    for slot in archive.slots() {
                        let _ = archive.read_block(&slot.block, None);
                    }
                    let _ = archive.read("(listfile)");
                    let _ = archive.read("war3map.j");
                }
            });
        }
        found
    });
    report(Found::all(runs).failures);
}

/// Damage aimed at what the archive tables point to, through the file contents: compression
/// methods and sector tables are read before anything is checked.
#[test]
fn decompression_survives_damaged_sectors() {
    let bytes = map_bytes("sectors.w3x");
    // 0x200: the archive starts after the map header; its own header has the table offsets.
    let body_end = bytes.len().saturating_sub(4096);
    let runs = par_seeds("decompression", seeds(rounds() * 20), |chunk| {
        let mut found = Found::default();
        for seed in chunk.seeds() {
            let mut rng = Rng::new(seed + 1);
            let mut bad = bytes.clone();
            for _ in 0..1 + rng.below(8) {
                let at = 0x220 + rng.below(body_end.saturating_sub(0x220));
                bad[at] = rng.next() as u8;
            }
            guarded(&mut found.failures, || format!("seed {seed}"), || {
                if let Ok(archive) = Archive::from_bytes(bad) {
                    for slot in archive.slots() {
                        let _ = archive.read_block(&slot.block, None);
                    }
                }
            });
        }
        found
    });
    report(Found::all(runs).failures);
}

#[test]
fn verify_never_reports_a_silent_change() {
    let bytes = map_bytes("verify.w3x");
    let codecs = registry();
    let runs = par_seeds("verify", seeds(rounds()), |chunk| {
        // verify reads a file: one for each piece of work.
        let path = tmp(&format!("damaged-{}.w3x", chunk.range.start));
        let mut found = Found::default();
        for seed in chunk.seeds() {
            fs::write(&path, damage(&bytes, &mut Rng::new(seed + 1))).unwrap();
            guarded(&mut found.failures, || format!("seed {seed}"), || {
                if let Ok(report) = w3proj::verify(&path, &codecs, None) {
                    if !report.mismatches.is_empty() {
                        found.notes.push(format!("seed {seed}: {:?}", report.mismatches));
                    }
                }
            });
        }
        found
    });
    let Found { failures, notes: changed, .. } = Found::all(runs);
    report(failures);
    assert!(changed.is_empty(), "packed differently:\n{}", changed.join("\n"));
}

/// A `.w3o` of several kinds, made from the fixture's unit data.
fn w3o_bytes() -> Vec<u8> {
    let text = fs::read_to_string(fixture().join("map/war3map.w3u.json")).unwrap();
    let parts: Vec<(String, String)> = ["w3u", "w3t", "w3a", "w3q"].iter().map(|k| (k.to_string(), text.clone())).collect();
    w3proj::w3o::pack_json(&parts).unwrap()
}

/// The all-in-one object data file is read from strangers too: it never panics, and whatever is
/// accepted puts back together as the same bytes.
#[test]
fn w3o_survives_damaged_files() {
    let bytes = w3o_bytes();
    assert_eq!(w3proj::w3o::unpack(&bytes).unwrap().len(), 4, "the undamaged file must read: else rejecting means nothing");
    let runs = par_seeds("w3o", seeds(rounds() * 5), |chunk| {
        let mut found = Found::default();
        for seed in chunk.seeds() {
            let bad = damage(&bytes, &mut Rng::new(seed + 1));
            guarded(&mut found.failures, || format!("seed {seed}"), || match w3proj::w3o::unpack(&bad) {
                Ok(parts) => {
                    found.accepted += 1;
                    assert_eq!(w3proj::w3o::pack(&parts).unwrap(), bad, "seed {seed}: accepted but not the same bytes");
                    let _ = w3proj::w3o::unpack_json(&bad);
                }
                Err(_) => found.rejected += 1,
            });
        }
        found
    });
    let Found { failures, accepted, rejected, .. } = Found::all(runs);
    report(failures);
    println!("w3o: {accepted} damaged files accepted, {rejected} rejected");
    if !single_seed() {
        assert!(accepted > 0 && rejected > 0, "the damage reached nothing: {accepted} accepted, {rejected} rejected");
    }
}
