//! `w3proj` — unpack Warcraft III maps into git-friendly projects and pack
//! them back.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use w3proj::{Registry, UnpackOptions};

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
        maps: Vec<PathBuf>,
        /// Only print failures and a summary.
        #[arg(short, long)]
        quiet: bool,
    },
    /// List the files in a map.
    Ls { map: PathBuf },
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
        #[arg(long, global = true, default_value = r"C:\Program Files (x86)\Warcraft III")]
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
        } => {
            let opts = UnpackOptions { allow_incomplete };
            let codecs = Registry::for_project(&project, &extra)?;
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
        Cmd::Verify { maps, quiet } => {
            let codecs = Registry::with_formats(&extra)?;
            let (mut ok, mut failed, mut incomplete) = (0, 0, 0);
            for map in &maps {
                match w3proj::verify(map, &codecs) {
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
            }
            println!("{ok} ok ({incomplete} incomplete), {failed} failed");
            if failed > 0 {
                return Ok(ExitCode::FAILURE);
            }
        }
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
                    use std::io::Write;
                    let bytes = if path.contains(".w3mod:") {
                        game.read_exact(&path)?
                    } else {
                        game.read(&path, mode, None)?.1
                    };
                    std::io::stdout().write_all(&bytes)?;
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
            use std::io::Write;
            let bytes = mpq::Archive::open(&map)?.read(&file)?;
            std::io::stdout().write_all(&bytes)?;
        }
    }
    Ok(ExitCode::SUCCESS)
}
