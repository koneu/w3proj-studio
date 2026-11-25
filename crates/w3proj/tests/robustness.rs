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
use std::sync::{Arc, Mutex, Once, Weak};

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

/// A number set in the environment: None when the variable isn't set, a panic when it is set to something that isn't
/// one (a typo must not quietly run the defaults and look like a pass).
fn env_u64(name: &str) -> Option<u64> {
    match std::env::var(name) {
        Ok(v) => Some(v.trim().parse().unwrap_or_else(|_| panic!("{name}={v:?} isn't a number"))),
        Err(std::env::VarError::NotPresent) => None,
        Err(e) => panic!("{name}: {e}"),
    }
}

fn rounds() -> u64 {
    env_u64("W3PROJ_ROBUSTNESS_ROUNDS").unwrap_or(200)
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

/// How many tests hold the folder; the last one to let go removes it.
static TMP_USERS: std::sync::Mutex<usize> = std::sync::Mutex::new(0);

fn tmp_dir() -> PathBuf {
    // The gate runs the debug and the release build of these tests at once: one folder each run.
    Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("robustness-{}", std::process::id()))
}

/// Keeps the scratch folder alive for one test; dropped (also on a failed assert), the last one removes it.
struct TmpGuard;

impl TmpGuard {
    fn new() -> TmpGuard {
        let mut users = TMP_USERS.lock().unwrap_or_else(|e| e.into_inner());
        *users += 1;
        fs::create_dir_all(tmp_dir()).unwrap();
        TmpGuard
    }
}

impl Drop for TmpGuard {
    fn drop(&mut self) {
        let mut users = TMP_USERS.lock().unwrap_or_else(|e| e.into_inner());
        *users -= 1;
        if *users == 0 {
            fs::remove_dir_all(tmp_dir()).ok();
        }
    }
}

fn tmp(name: &str) -> PathBuf {
    tmp_dir().join(name)
}

/// The fixture as a map. Cached once per test binary so `w3proj::pack(&fixture(), ...)` is not re-run 5 times.
fn map_bytes(_name: &str) -> Vec<u8> {
    // [Refactored] Cached packed mini-map bytes in OnceLock across all 5 tests in this binary.
    static BYTES: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    BYTES
        .get_or_init(|| {
            let _guard = TmpGuard::new();
            let out = tmp("shared-fixture.w3x");
            w3proj::pack(&fixture(), Some(&out), &registry()).unwrap();
            fs::read(out).unwrap()
        })
        .clone()
}

/// The made-up campaign (`tests/fixtures/mini-campaign`: war3campaign.w3f, .imp, .w3u) as a campaign archive. A map
/// can't hold campaign info (war3campaign.w3f makes it a campaign), so it is a fixture of its own.
fn campaign_bytes() -> Vec<u8> {
    static BYTES: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    BYTES
        .get_or_init(|| {
            let _guard = TmpGuard::new();
            let out = tmp("shared-campaign.w3n");
            w3proj::pack(&fixture().join("../mini-campaign"), Some(&out), &registry()).unwrap();
            fs::read(out).unwrap()
        })
        .clone()
}

/// Files of the mini map and the mini campaign that a codec reads.
fn codec_files(test: &str) -> Vec<(String, Vec<u8>)> {
    let codecs = registry();
    let mut out = Vec::new();
    for bytes in [map_bytes(&format!("{test}.w3x")), campaign_bytes()] {
        let archive = Archive::from_bytes(bytes).unwrap();
        let names = archive
            .read("(listfile)")
            .map(|l| String::from_utf8_lossy(&l).lines().map(str::to_string).collect::<Vec<_>>())
            .unwrap();
        for name in names.into_iter().filter(|name| codecs.for_archive_name(name).any(|c| c.unpacks())) {
            let bytes = archive.read(&name).unwrap();
            out.push((name, bytes));
        }
    }
    out
}

/// The hostile rounds reach every format: each format definition and each kind of object data has a file in the
/// fixtures (a new definition without one would get no damaged input in the commit tier).
#[test]
fn the_fixtures_hold_a_file_for_every_codec() {
    let codecs = registry();
    let files = codec_files("coverage");
    let used: std::collections::BTreeSet<String> =
        files.iter().flat_map(|(name, _)| codecs.for_archive_name(name).map(|c| c.id().to_string()).collect::<Vec<_>>()).collect();
    let missing: Vec<&str> = codecs.formats().iter().map(|f| w3proj::Codec::id(*f)).filter(|id| !used.contains(*id)).collect();
    assert!(missing.is_empty(), "format definitions without a file in tests/fixtures/mini-map or mini-campaign: {missing:?}");
    let kinds: std::collections::BTreeSet<String> =
        files.iter().filter_map(|(name, _)| name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase())).collect();
    // (war3map.wtg and .wct have hostile rounds of their own: damaged_trigger_files_split_or_are_refused.)
    for kind in ["w3u", "w3t", "w3b", "w3d", "w3a", "w3h", "w3q", "w3e"] {
        assert!(kinds.contains(kind), "no .{kind} file in the fixtures");
    }
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

/// The whole process's resident memory may grow to this many MB (`W3PROJ_ROBUSTNESS_MEM_MB` overrides it); past it
/// the watchdog names the cases running then and ends the process. A case that allocates what a damaged header asks
/// for would otherwise use up the machine's memory instead of failing (the TS hostile children have the same cap).
const MEM_MB: u64 = 1536;

/// The process's resident memory in MB, read from /proc (Linux only: elsewhere there is no cap).
fn resident_mb() -> Option<u64> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let status = fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmRSS:"))?;
    let kb: u64 = line["VmRSS:".len()..].trim().trim_end_matches("kB").trim().parse().ok()?;
    Some(kb / 1024)
}

/// The case each thread is running (empty between cases), for the watchdog's report. Weak: a finished thread's slot
/// goes away with it.
static CASES: Mutex<Vec<Weak<Mutex<String>>>> = Mutex::new(Vec::new());

thread_local! {
    /// This thread's slot in `CASES`.
    static CASE: Arc<Mutex<String>> = {
        let slot = Arc::new(Mutex::new(String::new()));
        let mut cases = CASES.lock().unwrap_or_else(|e| e.into_inner());
        cases.retain(|c| c.strong_count() > 0);
        cases.push(Arc::downgrade(&slot));
        slot
    };
    /// The loop of seeds this thread works for (`par_seeds`'s `what`), so the report names the test too.
    static LOOP: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Starts the memory watchdog once: a thread that looks at the resident memory every 20 ms and, past the cap, prints
/// the cases running and ends the process (a case can't be stopped from outside, and its memory is the problem).
fn watch_memory() {
    static WATCH: Once = Once::new();
    WATCH.call_once(|| {
        if resident_mb().is_none() {
            return;
        }
        let limit = env_u64("W3PROJ_ROBUSTNESS_MEM_MB").unwrap_or(MEM_MB);
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(20));
            let Some(mb) = resident_mb() else { continue };
            if mb <= limit {
                continue;
            }
            let running: Vec<String> = CASES
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .filter_map(Weak::upgrade)
                .map(|slot| slot.lock().unwrap_or_else(|e| e.into_inner()).clone())
                .filter(|case| !case.is_empty())
                .collect();
            // Straight to stderr: eprintln! in a thread a test started goes to the test's captured output, which the
            // exit below throws away.
            let report = format!("robustness: {mb} MB resident, over the cap of {limit} MB; the cases running then:\n  {}\n", running.join("\n  "));
            std::io::Write::write_all(&mut std::io::stderr(), report.as_bytes()).ok();
            fs::remove_dir_all(tmp_dir()).ok();
            std::process::exit(1);
        });
    });
}

/// Runs `body` and records a panic under `what`.
fn guarded(failures: &mut BTreeMap<String, String>, what: impl Fn() -> String, body: impl FnOnce()) {
    collect_panics();
    watch_memory();
    CASE.with(|slot| *slot.lock().unwrap_or_else(|e| e.into_inner()) = LOOP.with_borrow(|l| format!("{l}: {}", what())));
    GUARDED.set(true);
    let result = catch_unwind(AssertUnwindSafe(body));
    GUARDED.set(false);
    CASE.with(|slot| slot.lock().unwrap_or_else(|e| e.into_inner()).clear());
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
    match env_u64("W3PROJ_ROBUSTNESS_SEED") {
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
            scope.spawn(|| {
                LOOP.with_borrow_mut(|l| what.clone_into(l));
                loop {
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    let Some(&start) = starts.get(i) else { return };
                    let chunk = Chunk { range: start..(start + CHUNK).min(seeds.end), count: Cell::new(0), hash: Cell::new(0) };
                    let made = work(&chunk);
                    done.lock().unwrap()[i] = Some((made, chunk.count.get(), chunk.hash.get()));
                }
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
                for codec in codecs.for_archive_name(&name).filter(|c| c.unpacks()) {
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
    }
}

/// war3map.wtg and war3map.wct go into map/triggers/ (`trigger_layout::split_map`): damaged, they never make it panic,
/// and what it accepts packs back (as `encode_files` assembles it) to the very bytes it got.
#[test]
fn damaged_trigger_files_split_or_are_refused() {
    use w3proj::trigger_layout as tl;
    let text = fs::read_to_string(fixture().join("../TriggerData.txt")).unwrap();
    let data = w3proj::triggerdata::TriggerData::parse(&text);
    let mut total = Found::default();
    for classic in [false, true] {
        let (wtg, wct) = tl::sample_map(classic);
        tl::split_map(&wtg, &wct, &data, tl::Lang::Jass).expect("the undamaged sample splits: else refusing means nothing");
        for target in ["war3map.wtg", "war3map.wct"] {
            let runs = par_seeds(&format!("trigger split {target} classic={classic}"), seeds(rounds()), |chunk| {
                let mut found = Found::default();
                for seed in chunk.seeds() {
                    let mut rng = Rng::new(seed + 1);
                    let (w, c) = if target == "war3map.wtg" { (damage(&wtg, &mut rng), wct.clone()) } else { (wtg.clone(), damage(&wct, &mut rng)) };
                    guarded(&mut found.failures, || format!("{target} classic={classic}, seed {seed}"), || match tl::split_map(&w, &c, &data, tl::Lang::Jass) {
                        Ok(files) => {
                            found.accepted += 1;
                            let (a, b, _) = tl::assemble(&files, tl::Lang::Jass, Some(&data)).expect("accepted, then assembled");
                            assert!(a == w && b == c, "{target} classic={classic}, seed {seed}: accepted but not the same bytes");
                        }
                        Err(_) => found.rejected += 1,
                    });
                }
                found
            });
            total.merge(Found::all(runs));
        }
    }
    let Found { failures, accepted, rejected, .. } = total;
    report(failures);
    println!("trigger split: {accepted} damaged files accepted, {rejected} refused");
    if !single_seed() {
        assert!(accepted > 0 && rejected > 0, "the damage reached nothing: {accepted} accepted, {rejected} rejected");
    }
}

/// The files of map/triggers/ come from git merges and hand edits: a damaged one is an error (naming the file), never a
/// panic, and what pack accepts is a whole tree: every trigger file of the layout is in war3map.wtg.
#[test]
fn damaged_trigger_folder_files_are_errors() {
    use w3proj::trigger_layout as tl;
    let text = fs::read_to_string(fixture().join("../TriggerData.txt")).unwrap();
    let data = w3proj::triggerdata::TriggerData::parse(&text);
    let (wtg, wct) = tl::sample_map(false);
    let files = tl::split_map(&wtg, &wct, &data, tl::Lang::Jass).unwrap();
    let mut total = Found::default();
    for name in files.keys().cloned().collect::<Vec<_>>() {
        let runs = par_seeds(&format!("trigger folders {name}"), seeds(rounds()), |chunk| {
            let mut found = Found::default();
            for seed in chunk.seeds() {
                let mut f = files.clone();
                let bad = damage(&files[&name], &mut Rng::new(seed + 1));
                f.insert(name.clone(), bad);
                guarded(&mut found.failures, || format!("{name} damaged, seed {seed}"), || match tl::assemble(&f, tl::Lang::Jass, Some(&data)) {
                    Ok((w, _, _)) => {
                        found.accepted += 1;
                        let back = w3proj::wtg::parse(&w, &data).expect("what pack wrote reads back");
                        let triggers = back.items.iter().filter(|i| matches!(i, w3proj::wtg::Item::Trigger(_))).count();
                        let trigger_files = f.keys().filter(|k| *k != "triggers/header.j" && (k.ends_with(".gui.json") || k.ends_with(".comment.json") || k.ends_with(".j"))).count();
                        assert_eq!(triggers, trigger_files, "{name}, seed {seed}: a trigger file went missing");
                    }
                    Err(e) => {
                        found.rejected += 1;
                        assert!(e.to_string().contains("map/triggers/"), "the error names the file: {e}");
                    }
                });
            }
            found
        });
        total.merge(Found::all(runs));
    }
    let Found { failures, accepted, rejected, .. } = total;
    report(failures);
    if !single_seed() {
        assert!(accepted > 0 && rejected > 0, "the damage reached nothing: {accepted} accepted, {rejected} rejected");
    }
}

#[test]
fn damaged_project_files_are_errors() {
    let codecs = registry();
    let mut total = Found::default();
    for (name, bytes) in codec_files("project-files") {
        let codec = codecs.for_archive_name(&name).find(|c| c.unpacks()).unwrap();
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

/// The split terrain layout (map/terrain/: terrain.json and each subterrain's terrain.txt, doodads.json,
/// units.json and regions.json) comes from git merges and hand edits: a damaged file is an error, never a
/// panic, and what is accepted assembles into a terrain that packs and object files with every object (a
/// damaged object file never ships a map without its objects).
#[test]
fn damaged_split_terrain_files_are_errors() {
    let (layout, counts) = split_fixture();
    let mut total = Found::default();
    for name in layout.keys().cloned().collect::<Vec<_>>() {
        let runs = par_seeds(&format!("split terrain {name}"), seeds(rounds()), |chunk| {
            let mut found = Found::default();
            for seed in chunk.seeds() {
                guarded(&mut found.failures, || format!("flatten with {name} damaged, seed {seed}"), || {
                    if damaged_split(&layout, &counts, &name, seed) {
                        found.accepted += 1;
                    } else {
                        found.rejected += 1;
                    }
                });
            }
            found
        });
        total.merge(Found::all(runs));
    }
    let Found { failures, accepted, rejected, .. } = total;
    report(failures);
    if !single_seed() {
        assert!(accepted > 0 && rejected > 0, "the damage reached nothing: {accepted} accepted, {rejected} rejected");
    }
}

/// Seeds the 20,000 rounds found, kept in every run. 7893: a doubled part left the tail of a doodad
/// (`itemTable`, `itemSets`, `editorId` 0) as an object of its own, merged as one doodad more once 0 stopped
/// counting as a duplicate creation number.
#[test]
fn damaged_split_terrain_regressions() {
    let (layout, counts) = split_fixture();
    const FOUND: &[(&str, u64)] = &[("terrain/sw/doodads.json", 7893)];
    for &(name, seed) in FOUND {
        assert!(!damaged_split(&layout, &counts, name, seed), "{name}, seed {seed}: the damaged file was accepted");
    }
}

/// The subterrains' hand-painted pathing (`pathing.txt`) comes from git merges and hand edits like the rest of the
/// layout: a damaged one is an error naming its line, never a panic and never fewer overrides. What is accepted holds
/// every line of the file (each parses on its own, and the assembled overrides count exactly their cells), and a pack's
/// read of the layout (`flatten`) accepts what the Pathing tool's read accepts.
#[test]
fn damaged_pathing_txt_is_an_error_never_fewer_overrides() {
    use w3proj::terrain_layout as tl;
    use w3proj::terrain_pathing as tp;
    let (mut layout_files, _) = split_fixture();
    let layout = tl::Layout::parse(&layout_files[tl::LAYOUT_FILE]).unwrap();
    let json = tp::sample_json(layout.corners()).unwrap();
    let pathing = tp::slice(&json, &layout).unwrap();
    assert!(pathing.len() >= 3, "the sample overrides cross the seams: {:?}", pathing.keys());
    layout_files.extend(pathing.clone());
    let mut total = Found::default();
    for name in pathing.keys().cloned().collect::<Vec<_>>() {
        let sub = layout.subterrains.iter().find(|s| tp::path(s) == name).unwrap().clone();
        let [_, _, w, h] = tp::cell_rect(&sub, layout.corners());
        let runs = par_seeds(&format!("pathing.txt {name}"), seeds(rounds()), |chunk| {
            let mut found = Found::default();
            for seed in chunk.seeds() {
                guarded(&mut found.failures, || format!("{name} damaged, seed {seed}"), || {
                    let mut files = layout_files.clone();
                    let bad = damage(&layout_files[&name], &mut Rng::new(seed + 1));
                    files.insert(name.clone(), bad.clone());
                    let read = tp::assemble(&layout, &|p| files.get(p).cloned());
                    let packed = tl::flatten(&mut files.clone());
                    assert_eq!(read.is_ok(), packed.is_ok(), "the pack's read and the Pathing tool's disagree");
                    match read {
                        Err(e) => {
                            assert!(e.to_string().contains("pathing.txt"), "the error names the file: {e}");
                            found.rejected += 1;
                        }
                        Ok(assembled) => {
                            // Every line of the damaged file parses on its own: none was skipped.
                            let text = std::str::from_utf8(&bad).expect("accepted text is UTF-8");
                            let body = text.strip_suffix('\n').unwrap_or(text);
                            let mut cells = 0;
                            for line in body.split('\n').filter(|_| !body.is_empty()) {
                                cells += tp::parse_txt("line", line.as_bytes(), w, h).unwrap_or_else(|e| panic!("an accepted file has a line that doesn't parse: {e}")).len();
                            }
                            let others: usize = pathing.iter().filter(|(k, _)| **k != name).map(|(k, v)| {
                                let s = layout.subterrains.iter().find(|s| tp::path(s) == *k).unwrap();
                                let [_, _, w, h] = tp::cell_rect(s, layout.corners());
                                tp::parse_txt(k, v, w, h).unwrap().len()
                            }).sum();
                            let doc: serde_json::Value = serde_json::from_slice(&assembled.expect("files are there")).unwrap();
                            assert_eq!(doc["cells"].as_array().unwrap().len(), cells + others, "the assembled file lost or gained overrides");
                            found.accepted += 1;
                        }
                    }
                });
            }
            found
        });
        total.merge(Found::all(runs));
    }
    let Found { failures, accepted, rejected, .. } = total;
    report(failures);
    if !single_seed() {
        assert!(accepted > 0 && rejected > 0, "the damage reached nothing: {accepted} accepted, {rejected} rejected");
    }
}

/// The mini map split 2×2 (`terrain_layout::split`), and how many entries each object kind has.
type Counts = Vec<(w3proj::terrain_objects::Kind, usize)>;

fn split_fixture() -> (BTreeMap<String, Vec<u8>>, Counts) {
    use w3proj::terrain_layout as tl;
    use w3proj::terrain_objects::KINDS;
    let map = fixture().join("map");
    let mut layout = BTreeMap::from([(tl::FLAT_FILE.to_string(), fs::read(map.join(tl::FLAT_FILE)).unwrap())]);
    let mut counts = Vec::new();
    for kind in KINDS {
        let bytes = fs::read(map.join(kind.flat())).unwrap();
        let doc: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let n = doc[kind.name()].as_array().unwrap().len();
        assert!(n > 0, "the fixture has {}", kind.name());
        counts.push((kind, n));
        layout.insert(kind.flat().to_string(), bytes);
    }
    tl::split(&mut layout, &tl::grid_2x2(5, 3)).unwrap();
    assert!(layout.keys().any(|k| k.ends_with("/units.json")), "the objects went into the subterrains");
    (layout, counts)
}

/// The split layout with file `name` damaged by `seed`, flattened: false when that is an error; true when it is
/// accepted, after checking that what it gives packs and holds every object (a panic otherwise).
fn damaged_split(layout: &BTreeMap<String, Vec<u8>>, counts: &Counts, name: &str, seed: u64) -> bool {
    use w3proj::terrain_layout as tl;
    let mut files = layout.clone();
    files.insert(name.to_string(), damage(&layout[name], &mut Rng::new(seed + 1)));
    match tl::flatten(&mut files) {
        // Damage never turns the project into a flat one without terrain.
        Ok(false) => panic!("a damaged layout was taken for the flat layout"),
        Ok(true) => {
            assert!(w3proj::w3e::from_text(&files[tl::FLAT_FILE]).is_ok(), "an accepted layout assembled into a terrain that doesn't pack");
            static CODECS: std::sync::OnceLock<w3proj::codec::Registry> = std::sync::OnceLock::new();
            let codecs = CODECS.get_or_init(w3proj::codec::Registry::default);
            for (kind, n) in counts {
                let flat = files.get(kind.flat()).unwrap_or_else(|| panic!("an accepted layout lost {}", kind.flat()));
                let doc: serde_json::Value = serde_json::from_slice(flat).expect("merged object files are JSON");
                assert_eq!(doc[kind.name()].as_array().map(Vec::len), Some(*n), "an accepted layout lost {}", kind.name());
                // What the merge made goes through the codec (an error is the pack's refusal, not a panic).
                let _ = codecs.for_project_path(kind.flat()).unwrap().1.encode(kind.raw(), flat);
            }
            true
        }
        Err(_) => false,
    }
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

/// (attributes), from a map packed with one (`PackOptions::attributes`): damaged as part of the archive, and on its own
/// against block counts at their limits. Reading it never panics.
#[test]
fn attributes_survive_damaged_archives() {
    let map = {
        let _guard = TmpGuard::new();
        let out = tmp("attributes-fixture.w3x");
        w3proj::pack_with(&fixture(), Some(&out), &registry(), w3proj::PackOptions { attributes: true, ..Default::default() }).unwrap();
        fs::read(out).unwrap()
    };
    let archive = Archive::from_bytes(map.clone()).unwrap();
    let own = archive.read(mpq::attributes::NAME).unwrap();
    let blocks = archive.header().block_table_entries as usize;
    assert!(mpq::attributes::Attributes::parse(&own, blocks).is_ok(), "the undamaged one must read");
    let runs = par_seeds("attributes", seeds(rounds() * 10), |chunk| {
        let mut found = Found::default();
        for seed in chunk.seeds() {
            let mut rng = Rng::new(seed + 1);
            let (bad_map, bad_own) = (damage(&map, &mut rng), damage(&own, &mut rng));
            let count = match rng.below(5) {
                0 => usize::MAX,
                1 => u32::MAX as usize,
                2 => 0,
                3 => rng.next() as usize,
                _ => blocks + rng.below(3),
            };
            guarded(&mut found.failures, || format!("seed {seed}"), || {
                if let Ok(a) = Archive::from_bytes(bad_map) {
                    if let Ok(raw) = a.read(mpq::attributes::NAME) {
                        let _ = mpq::attributes::Attributes::parse(&raw, a.header().block_table_entries as usize);
                    }
                }
                let _ = mpq::attributes::Attributes::parse(&bad_own, count);
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
    let _guard = TmpGuard::new();
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

/// `w3proj pack` prunes war3map.wts (`w3proj::wts`), reading a stranger's string table, sounds file
/// and the app's record of dropped strings: none of them damaged makes it panic, and a table it
/// prunes keeps every string the map refers to as it was.
#[test]
fn wts_pruning_survives_damaged_files() {
    use w3proj::wts;
    let root = fixture().join("../wts-prune");
    let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for name in ["war3map.wts", "war3map.w3i.json", "war3map.w3s.json", "war3map.wct.txt", "war3map.wtg"] {
        files.insert(name.into(), fs::read(root.join("map").join(name)).unwrap());
    }
    let record = fs::read(root.join(wts::PRUNED_STRINGS_FILE)).unwrap();
    let codecs = registry();
    {
        let mut f = files.clone();
        let r = wts::prune_files(&mut f, Ok(Some(String::from_utf8(record.clone()).unwrap())), &codecs);
        assert!(r.kept.is_none() && !r.dropped.is_empty(), "the undamaged fixture must prune: else keeping means nothing");
    }
    let targets = ["war3map.wts", "war3map.w3s.json", "record"];
    let runs = par_seeds("wts pruning", seeds(rounds() * 5), |chunk| {
        let mut found = Found::default();
        for seed in chunk.seeds() {
            let target = targets[(seed % 3) as usize];
            let mut f = files.clone();
            let mut rec = record.clone();
            let mut rng = Rng::new(seed + 1);
            match target {
                "record" => rec = damage(&rec, &mut rng),
                name => {
                    let bad = damage(&f[name], &mut rng);
                    f.insert(name.into(), bad);
                }
            }
            let before = f["war3map.wts"].clone();
            guarded(&mut found.failures, || format!("{target}, seed {seed}"), || {
                let rec = String::from_utf8(rec).map_err(|_| "not UTF-8".to_string()).map(Some);
                let r = wts::prune_files(&mut f, rec, &codecs);
                if r.kept.is_some() {
                    found.rejected += 1;
                    assert_eq!(f["war3map.wts"], before, "{target}, seed {seed}: kept, yet the table changed");
                    return;
                }
                found.accepted += 1;
                let refs = wts::map_string_refs(&f, &codecs).unwrap();
                // As the table is read (a damaged one isn't UTF-8 any more): `lossless`, so a string is compared byte for byte.
                let lossless = w3proj::lossless::decode;
                let (was, now) = (wts::strings(&lossless(&before)), wts::strings(&lossless(&f["war3map.wts"])));
                for (n, v) in &was {
                    if refs.contains(n) {
                        assert_eq!(now.get(n), Some(v), "{target}, seed {seed}: string {n} referenced but not kept as it was");
                    }
                }
            });
        }
        found
    });
    let Found { failures, accepted, rejected, .. } = Found::all(runs);
    report(failures);
    println!("wts pruning: {accepted} damaged inputs pruned, {rejected} kept the table");
    if !single_seed() {
        assert!(accepted > 0 && rejected > 0, "the damage reached nothing: {accepted} pruned, {rejected} kept");
    }
}

/// The memory watchdog's own test: this test program run again with `W3PROJ_ROBUSTNESS_HOG` set, where one case
/// allocates twice a low cap (as a header's size taken at its word does) and then waits. The watchdog must end that
/// run and name the case; without it the run passes.
#[cfg(target_os = "linux")]
#[test]
fn memory_watchdog_names_the_case() {
    const CAP_MB: u64 = 128;
    if std::env::var_os("W3PROJ_ROBUSTNESS_HOG").is_some() {
        par_seeds("hog", 0..1, |chunk| {
            let mut found = Found::default();
            for seed in chunk.seeds() {
                guarded(&mut found.failures, || format!("allocating, seed {seed}"), || {
                    let held: Vec<Vec<u8>> = (0..2 * CAP_MB).map(|_| vec![1u8; 1 << 20]).collect();
                    std::hint::black_box(&held);
                    std::thread::sleep(std::time::Duration::from_secs(3));
                });
            }
            found
        });
        return;
    }
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["memory_watchdog_names_the_case", "--exact", "--test-threads=1"])
        .env("W3PROJ_ROBUSTNESS_HOG", "1")
        .env("W3PROJ_ROBUSTNESS_MEM_MB", CAP_MB.to_string())
        .env_remove("W3PROJ_ROBUSTNESS_SEED")
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "the allocating case ran to its end: no watchdog\n{stderr}");
    assert!(stderr.contains(&format!("over the cap of {CAP_MB} MB")) && stderr.contains("hog: allocating, seed 0"), "the report names the cap and the case:\n{stderr}");
}
