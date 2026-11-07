//! `w3proj` — unpack Warcraft III maps into git-friendly projects and pack
//! them back.

mod mcp;

/// `println!`/`print!` that end the command quietly when the reader has gone away
/// (`w3proj ... | head`) instead of panicking. Any other write error is reported.
macro_rules! println {
    ($($arg:tt)*) => { $crate::out(format_args!("{}\n", format_args!($($arg)*))) };
}
macro_rules! print {
    ($($arg:tt)*) => { $crate::out(format_args!($($arg)*)) };
}

/// Set once the reader of stdout has closed the pipe: the output is dropped from then on, but the
/// command still finishes its work (writes, exit code) as if nothing happened.
static PIPE_CLOSED: AtomicBool = AtomicBool::new(false);

fn out(args: std::fmt::Arguments) {
    use std::io::Write;
    if PIPE_CLOSED.load(Ordering::Relaxed) {
        return;
    }
    if let Err(e) = std::io::stdout().write_fmt(args) {
        if e.kind() == std::io::ErrorKind::BrokenPipe {
            PIPE_CLOSED.store(true, Ordering::Relaxed);
            return;
        }
        eprintln!("error: writing to stdout: {e}");
        std::process::exit(1);
    }
}

/// Writes raw bytes to stdout. A closed pipe is not an error; any other failure is.
fn write_stdout(bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    if PIPE_CLOSED.load(Ordering::Relaxed) {
        return Ok(());
    }
    let mut so = std::io::stdout();
    match so.write_all(bytes).and_then(|()| so.flush()) {
        Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => {
            PIPE_CLOSED.store(true, Ordering::Relaxed);
            Ok(())
        }
        r => Ok(r?),
    }
}

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use w3proj::{Registry, UnpackOptions};

const DEFAULT_INSTALL: &str = r"C:\Program Files (x86)\Warcraft III";

/// The installed game's data, opened when first needed (None: "none", or it can't be opened).
type LazyGame = Arc<dyn Fn() -> Option<Arc<casc::GameData>> + Send + Sync>;

fn lazy_game(install: &str) -> Option<LazyGame> {
    if install.eq_ignore_ascii_case("none") {
        return None;
    }
    let install = PathBuf::from(install);
    let game = OnceLock::new();
    Some(Arc::new(move || {
        game.get_or_init(|| match casc::GameData::open(&install) {
            Ok(g) => Some(Arc::new(g)),
            Err(e) => {
                eprintln!("note: game data not used ({e})");
                None
            }
        })
        .clone()
    }))
}

/// The installed game's file names, read when first needed.
fn game_names(game: &Option<LazyGame>) -> Option<w3proj::project::NameSource> {
    let game = game.clone()?;
    let names = OnceLock::new();
    Some(Arc::new(move || {
        names
            .get_or_init(|| game().map(|g| w3proj::names::from_game_paths(g.all_paths())).unwrap_or_default())
            .clone()
    }))
}

/// Lets `codecs` read GUI triggers with the game's TriggerData.txt.
/// Map name → (file → codec id or "raw").
type Baseline = BTreeMap<String, BTreeMap<String, String>>;

const BASELINE_HEADER: &str = "# w3proj verify --baseline: map, file, codec that reads it (\"raw\": a codec claims it but fell back)\n";

fn read_baseline(path: &std::path::Path) -> Result<Baseline> {
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let mut base = Baseline::new();
    for line in text.lines().filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let mut cols = line.split('\t');
        let (Some(map), Some(file), Some(codec)) = (cols.next(), cols.next(), cols.next()) else {
            anyhow::bail!("{}: expected map, file and codec separated by tabs: {line}", path.display());
        };
        base.entry(map.to_string()).or_default().insert(file.to_string(), codec.to_string());
    }
    Ok(base)
}

fn write_baseline(path: &std::path::Path, base: &Baseline) -> Result<()> {
    let mut out = String::from(BASELINE_HEADER);
    for (map, files) in base {
        for (file, codec) in files {
            out.push_str(&format!("{map}\t{file}\t{codec}\n"));
        }
    }
    std::fs::write(path, out).with_context(|| format!("writing {}", path.display()))
}

/// What changed from the baseline, one line per file.
fn baseline_diffs(before: &BTreeMap<String, String>, now: &BTreeMap<String, String>) -> Vec<String> {
    let mut out = Vec::new();
    for (file, old) in before {
        match now.get(file) {
            Some(new) if new == old => {}
            Some(new) => out.push(format!("{file}: {old} → {new}")),
            None => out.push(format!("{file}: {old} → no codec claims it")),
        }
    }
    for (file, new) in now.iter().filter(|(f, _)| !before.contains_key(*f)) {
        out.push(format!("{file}: not in the baseline → {new}"));
    }
    out
}

/// Maps given directly, plus the maps and campaigns found in given folders (sorted), each with
/// its baseline key: the path below the given folder (`/`-separated), or the file name.
fn expand_maps(args: &[PathBuf]) -> Result<Vec<(PathBuf, String)>> {
    fn walk(dir: &std::path::Path, out: &mut Vec<PathBuf>) -> Result<()> {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
            .with_context(|| format!("reading {}", dir.display()))?
            .map(|e| e.map(|e| e.path()))
            .collect::<std::io::Result<_>>()?;
        entries.sort();
        for p in entries {
            if p.is_dir() {
                walk(&p, out)?;
            } else if p.extension().and_then(|e| e.to_str()).is_some_and(|e| ["w3x", "w3m", "w3n"].contains(&e.to_ascii_lowercase().as_str())) {
                out.push(p);
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    for a in args {
        if a.is_dir() {
            let mut found = Vec::new();
            walk(a, &mut found)?;
            out.extend(found.into_iter().map(|p| {
                let rel = p.strip_prefix(a).unwrap_or(&p);
                let key = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
                (p, key)
            }));
        } else {
            out.push((a.clone(), a.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
        }
    }
    Ok(out)
}

/// File bytes of maps being checked at once (W3PROJ_VERIFY_MEMORY_MB overrides). Checking a map
/// takes about 4.5 times its size in memory (a 1 GB campaign peaked at 4.3 GB), and campaigns are
/// 1-2 GB, so only so much runs together; a map above it runs alone. The default lets the two
/// biggest campaigns of the corpus run side by side (about 12 GB) and nothing more.
fn in_flight_bytes() -> u64 {
    std::env::var("W3PROJ_VERIFY_MEMORY_MB").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(3072) << 20
}

/// Threads for `verify`: the cores, or W3PROJ_VERIFY_JOBS (1 checks one map after the other).
fn verify_threads() -> usize {
    std::env::var("W3PROJ_VERIFY_JOBS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()))
}

/// Gives back a map's share of the memory budget, also when its check panics.
struct Share<'a> {
    state: &'a Mutex<(Vec<usize>, u64)>,
    freed: &'a Condvar,
    bytes: u64,
}

impl Drop for Share<'_> {
    fn drop(&mut self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).1 -= self.bytes;
        self.freed.notify_all();
    }
}

/// Runs `work` on every path on several threads, biggest files first and within the memory
/// budget, and hands the results to `each` on this thread in the order of `paths`.
fn in_order<R: Send>(paths: &[&std::path::Path], work: impl Fn(&std::path::Path) -> R + Sync, mut each: impl FnMut(usize, R)) {
    let threads = verify_threads().min(paths.len());
    if threads <= 1 {
        for (i, p) in paths.iter().enumerate() {
            each(i, work(p));
        }
        return;
    }
    let budget = in_flight_bytes();
    let sizes: Vec<u64> = paths.iter().map(|p| std::fs::metadata(p).map_or(0, |m| m.len())).collect();
    let mut queue: Vec<usize> = (0..paths.len()).collect();
    queue.sort_by_key(|&i| std::cmp::Reverse(sizes[i]));
    let state = Mutex::new((queue, 0u64));
    let freed = Condvar::new();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::scope(|s| {
        for _ in 0..threads {
            let (tx, state, freed, sizes, work, budget) = (tx.clone(), &state, &freed, &sizes, &work, budget);
            s.spawn(move || loop {
                let (i, _share) = {
                    let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
                    loop {
                        if st.0.is_empty() {
                            return;
                        }
                        let in_flight = st.1;
                        // Nothing in flight: whatever comes next fits, however big.
                        if let Some(at) = st.0.iter().position(|&i| in_flight == 0 || in_flight + sizes[i] <= budget) {
                            let i = st.0.remove(at);
                            st.1 += sizes[i];
                            break (i, Share { state, freed, bytes: sizes[i] });
                        }
                        st = freed.wait(st).unwrap_or_else(|e| e.into_inner());
                    }
                };
                if tx.send((i, work(paths[i]))).is_err() {
                    return;
                }
            });
        }
        drop(tx);
        let mut ready = BTreeMap::new();
        let mut next = 0;
        // A closed channel before all results: a worker panicked, and the scope reports it.
        while next < paths.len() {
            let Ok((i, r)) = rx.recv() else { break };
            ready.insert(i, r);
            while let Some(r) = ready.remove(&next) {
                each(next, r);
                next += 1;
            }
        }
    });
}

/// A `--trigger-data` file that can't be read is an error, before any work starts.
fn check_trigger_data(file: &Option<PathBuf>) -> Result<()> {
    if let Some(file) = file {
        std::fs::read(file).with_context(|| format!("--trigger-data {}: can't read the file", file.display()))?;
    }
    Ok(())
}

/// `file`: a TriggerData.txt to use instead of the game's (the tests bring a made-up one).
fn with_trigger_data(mut codecs: Registry, game: &Option<LazyGame>, file: &Option<PathBuf>) -> Registry {
    if let Some(file) = file.clone() {
        codecs.set_trigger_data(Arc::new(move || {
            let bytes = std::fs::read(&file).ok()?;
            Some(Arc::new(w3proj::triggerdata::TriggerData::parse(&String::from_utf8_lossy(&bytes))))
        }));
    } else if let Some(game) = game.clone() {
        codecs.set_trigger_data(Arc::new(move || {
            let (_, bytes) = game()?.read(r"UI\TriggerData.txt", casc::Mode::Hd, None).ok()?;
            Some(Arc::new(w3proj::triggerdata::TriggerData::parse(&String::from_utf8_lossy(&bytes))))
        }));
    }
    codecs
}

#[derive(Parser)]
#[command(name = "w3proj", version, about)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Unpack a map into a project folder (creates or re-syncs it).
    Unpack {
        map: PathBuf,
        project: PathBuf,
        /// Write the project even if some files can't be read or named.
        #[arg(long)]
        allow_incomplete: bool,
        /// Game install folder: its TriggerData.txt reads GUI triggers (war3map.wtg as JSON), its
        /// file names are tried when a map's names are missing (protected maps, files replacing
        /// the game's). "none" to skip both.
        #[arg(long, default_value = DEFAULT_INSTALL)]
        game: String,
        /// Read GUI triggers with this TriggerData.txt instead of the game's.
        #[arg(long, hide = true)]
        trigger_data: Option<PathBuf>,
    },
    /// Pack a project folder into a .w3x (the release step).
    Pack {
        project: PathBuf,
        /// Output map; defaults to [pack].output or build/<folder>.w3x.
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
    /// Check that maps survive unpack → pack unchanged (in memory).
    Verify {
        /// Maps and campaigns, or folders searched for .w3x/.w3m/.w3n files.
        maps: Vec<PathBuf>,
        /// Also compare which codec reads each file with this file (tab-separated: map, file,
        /// codec or "raw"); a codec that stops reading a file fails like a mismatch.
        #[arg(long)]
        baseline: Option<PathBuf>,
        /// Write the checked maps' codec use into the baseline (other maps' lines stay).
        #[arg(long, requires = "baseline")]
        update_baseline: bool,
        /// Only print failures and a summary.
        #[arg(short, long)]
        quiet: bool,
        /// Game install folder: its TriggerData.txt reads GUI triggers (war3map.wtg as JSON), its
        /// file names are tried when a map's names are missing (protected maps, files replacing
        /// the game's). "none" to skip both.
        #[arg(long, default_value = DEFAULT_INSTALL)]
        game: String,
        /// Read GUI triggers with this TriggerData.txt instead of the game's.
        #[arg(long, hide = true)]
        trigger_data: Option<PathBuf>,
    },
    /// List the files in a map.
    Ls { map: PathBuf },
    /// MCP server over stdin and stdout: AI clients start this to use the running W3Proj Studio.
    Mcp,
    /// Print one file from a map to stdout.
    Cat { map: PathBuf, file: String },
    /// List the format definitions in use (built-in, W3PROJ_FORMATS, project).
    Formats {
        /// Include the project's .w3proj/formats overrides.
        #[arg(long)]
        project: Option<PathBuf>,
        /// Print the definition with this name instead of the list.
        #[arg(long)]
        show: Option<String>,
    },
    /// Read the game's own data (CASC storage of the installed game).
    Game {
        #[command(subcommand)]
        cmd: GameCmd,
        /// Game install folder (the one containing .build.info).
        #[arg(long, global = true, default_value = DEFAULT_INSTALL)]
        install: PathBuf,
        /// Art set used to resolve plain paths: sd, hd or de.
        #[arg(long, global = true, default_value = "sd")]
        mode: String,
    },
}

#[derive(Subcommand)]
enum GameCmd {
    /// Show build, locale, file counts and layer order.
    Info,
    /// List stored files whose full path contains FILTER (case-insensitive).
    Ls { filter: Option<String> },
    /// Print a file. Plain paths (Units/UnitData.slk) are resolved through the
    /// mod layers; full paths (War3.w3mod:...) are read as-is.
    Cat { path: String },
    /// Show which stored file a plain path resolves to.
    Resolve { path: String },
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

/// Extra format definition folders from W3PROJ_FORMATS (separated by ';').
fn extra_format_dirs() -> Vec<PathBuf> {
    std::env::var("W3PROJ_FORMATS")
        .map(|v| v.split(';').filter(|s| !s.is_empty()).map(PathBuf::from).collect())
        .unwrap_or_default()
}

fn run(cli: Cli) -> Result<ExitCode> {
    let extra = extra_format_dirs();
    match cli.cmd {
        Cmd::Unpack {
            map,
            project,
            allow_incomplete,
            game,
            trigger_data,
        } => {
            check_trigger_data(&trigger_data)?;
            let game = lazy_game(&game);
            let opts = UnpackOptions {
                allow_incomplete,
                more_names: game_names(&game),
            };
            let codecs = with_trigger_data(Registry::for_project(&project, &extra)?, &game, &trigger_data);
            let report = match w3proj::unpack(&map, &project, &codecs, &opts) {
                Err(w3proj::Error::Incomplete(r)) => {
                    for (f, e) in &r.errors {
                        eprintln!("  unreadable {f}: {e}");
                    }
                    for f in &r.unnamed {
                        eprintln!("  unnamed    {f}");
                    }
                    anyhow::bail!(
                        "map could not be fully unpacked; pass --allow-incomplete to write it anyway \
                         (unnamed/unreadable files will be missing from packed builds)"
                    );
                }
                r => r.with_context(|| format!("unpacking {}", map.display()))?,
            };
            for f in report.files.iter().filter(|f| f.note.is_some()) {
                println!("  raw {} ({})", f.archive_name, f.note.as_deref().unwrap());
            }
            for f in &report.files {
                for i in &f.info {
                    println!("  note {}: {i}", f.archive_name);
                }
            }
            println!(
                "{} files ({} via codecs): {} written, {} unchanged, {} deleted",
                report.files.len(),
                report.files.iter().filter(|f| f.codec.is_some()).count(),
                report.written,
                report.unchanged,
                report.deleted
            );
            if !report.is_complete() {
                println!(
                    "warning: {} unnamed and {} unreadable files are not part of the project",
                    report.unnamed.len(),
                    report.errors.len()
                );
            }
        }
        Cmd::Pack { project, output } => {
            let codecs = Registry::for_project(&project, &extra)?;
            let r = w3proj::pack(&project, output.as_deref(), &codecs)
                .with_context(|| format!("packing {}", project.display()))?;
            println!("{} files, {} bytes → {}", r.files, r.bytes, r.output.display());
        }
        Cmd::Verify { maps, baseline, update_baseline, quiet, game, trigger_data } => {
            check_trigger_data(&trigger_data)?;
            let maps = expand_maps(&maps)?;
            let mut base = match &baseline {
                Some(path) if path.exists() => read_baseline(path)?,
                _ => Baseline::new(),
            };
            let mut changed = 0;
            let game = lazy_game(&game);
            let codecs = with_trigger_data(Registry::with_formats(&extra)?, &game, &trigger_data);
            let names = game_names(&game);
            let (mut ok, mut failed, mut incomplete) = (0, 0, 0);
            // The maps are checked on all cores; their reports come back here in the order given,
            // so the output is the same as one map after the other.
            let paths: Vec<&std::path::Path> = maps.iter().map(|(p, _)| p.as_path()).collect();
            let verify_one = |map: &std::path::Path| w3proj::verify(map, &codecs, names.as_ref());
            in_order(&paths, verify_one, |i, report| {
                let (map, key) = &maps[i];
                if let (Some(_), Ok(r)) = (&baseline, &report) {
                    let now: BTreeMap<String, String> = r.codec_use.iter().cloned().collect();
                    if update_baseline {
                        base.insert(key.clone(), now);
                    } else if let Some(before) = base.get(key) {
                        let diffs = baseline_diffs(before, &now);
                        changed += usize::from(!diffs.is_empty());
                        for d in diffs {
                            println!("CODEC {} — {d}", map.display());
                        }
                    } else {
                        println!("new  {} — not in the baseline", map.display());
                    }
                }
                match report {
                    Ok(r) if r.ok() => {
                        ok += 1;
                        let partial = r.unnamed + r.errors.len() > 0;
                        incomplete += usize::from(partial);
                        if !quiet || partial {
                            println!(
                                "ok   {} — {} files, {} via codecs{}",
                                map.display(),
                                r.files,
                                r.codec_files,
                                if partial {
                                    format!(" ({} unnamed, {} unreadable)", r.unnamed, r.errors.len())
                                } else {
                                    String::new()
                                }
                            );
                        }
                        if !quiet {
                            for (f, n) in &r.codec_fallbacks {
                                println!("       raw {f}: {n}");
                            }
                        }
                    }
                    Ok(r) => {
                        failed += 1;
                        println!("FAIL {} — mismatched: {}", map.display(), r.mismatches.join(", "));
                    }
                    Err(e) => {
                        failed += 1;
                        println!("FAIL {} — {e}", map.display());
                    }
                }
            });
            println!("{ok} ok ({incomplete} incomplete), {failed} failed");
            if let Some(path) = &baseline {
                if update_baseline {
                    write_baseline(path, &base)?;
                    println!("baseline written: {}", path.display());
                } else {
                    println!("{changed} with codec changes against the baseline");
                }
            }
            if failed + changed > 0 {
                return Ok(ExitCode::FAILURE);
            }
        }
        Cmd::Mcp => mcp::run()?,
        Cmd::Ls { map } => {
            let archive = mpq::Archive::open(&map)?;
            let ex = w3proj::project::extract(&archive, &Registry::empty());
            println!("{:>10}  {:>10}  {:<8}  name", "size", "stored", "flags");
            let mut stored_total = 0u64;
            for f in &ex.report.files {
                let b = archive.find(&f.archive_name).map(|s| s.block);
                let stored = b.map_or(0, |b| b.compressed_size);
                stored_total += stored as u64;
                println!(
                    "{:>10}  {:>10}  {:08x}  {}",
                    f.size,
                    stored,
                    b.map_or(0, |b| b.flags),
                    f.archive_name
                );
            }
            for f in &ex.report.unnamed {
                println!("{:>10}  {:>10}  {:<8}  <unnamed {f}>", "?", "?", "");
            }
            let h = archive.header();
            println!(
                "file data {stored_total} bytes; archive {} bytes; sector size {}; hash table {} entries, block table {} entries",
                h.archive_size,
                archive.sector_size(),
                h.hash_table_entries,
                h.block_table_entries
            );
        }
        Cmd::Game { cmd, install, mode } => {
            let mode = casc::Mode::parse(&mode).context("--mode must be sd, hd or de")?;
            let game = casc::GameData::open(&install)
                .with_context(|| format!("opening game data in {}", install.display()))?;
            match cmd {
                GameCmd::Info => {
                    println!("build    {}", game.storage.build.version);
                    println!("locale   {}", game.locale);
                    println!(
                        "entries  {} ({} stored locally)",
                        game.total_entries(),
                        game.local_paths().count()
                    );
                    println!("layers   {}", game.layers(mode, None).join(" > "));
                }
                GameCmd::Ls { filter } => {
                    let f = filter.unwrap_or_default().to_lowercase();
                    for p in game.local_paths().filter(|p| p.to_lowercase().contains(&f)) {
                        println!("{p}");
                    }
                }
                GameCmd::Cat { path } => {
                    let bytes = if path.contains(".w3mod:") {
                        game.read_exact(&path)?
                    } else {
                        game.read(&path, mode, None)?.1
                    };
                    write_stdout(&bytes)?;
                }
                GameCmd::Resolve { path } => match game.resolve(&path, mode, None) {
                    Some(full) => println!("{full}"),
                    None => anyhow::bail!("{path} not found in {mode:?} layers"),
                },
            }
        }
        Cmd::Formats { project, show } => {
            let codecs = match &project {
                Some(p) => Registry::for_project(p, &extra)?,
                None => Registry::with_formats(&extra)?,
            };
            for f in codecs.formats() {
                let def = &f.def;
                let source = match &def.source {
                    w3proj::format::Source::Builtin => "built-in".to_string(),
                    w3proj::format::Source::File(p) => p.display().to_string(),
                };
                match &show {
                    Some(name) if name == &def.name => match &def.source {
                        w3proj::format::Source::File(p) => print!("{}", std::fs::read_to_string(p)?),
                        w3proj::format::Source::Builtin => print!("{}", w3proj::format::builtin_text(&def.name).unwrap_or_default()),
                    },
                    Some(_) => {}
                    None => println!("{:<8} {:<28} {}  ({source})", def.name, def.files.join(", "), def.description),
                }
            }
        }
        Cmd::Cat { map, file } => {
            let bytes = mpq::Archive::open(&map)?.read(&file)?;
            write_stdout(&bytes)?;
        }
    }
    Ok(ExitCode::SUCCESS)
}
