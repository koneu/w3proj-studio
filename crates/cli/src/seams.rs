//! `w3proj terrain seams` and the seam check `w3proj pack` runs on a split project: Check Terrain Seams of W3Proj
//! Studio (`app/src/lib/terrain/seams.ts`), the terrain brushes' cliff, ramp and water rules applied where two
//! subterrains meet. The rules are the app's own TypeScript, run in Node the way `w3proj check` runs its code
//! (rebuild.rs: the bundle, the pipe, the backend crate's answers), so the command line reports what the app's command
//! and its MCP tool report. Nothing is written: this job's backend refuses every write.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::rebuild::{run_host, Server};

/// What the check found in a split project.
pub struct Found {
    pub errors: usize,
    /// The report's lines (one per issue, severity first, then the summary).
    pub lines: Vec<String>,
    /// The report as the app's command gives it.
    pub report: Value,
}

/// Runs the check on `project` (its whole terrain as saved: every subterrain, whatever is open). None for a flat project.
pub fn check(project: &Path, formats: &[PathBuf]) -> Result<Option<Found>> {
    let info = backend::open_project(&project.to_string_lossy()).map_err(anyhow::Error::msg).with_context(|| format!("opening {}", project.display()))?;
    let server = Server { root: PathBuf::from(&info.root), formats: formats.to_vec(), game: backend::GameCache::default(), read_only: true };
    let done = run_host(&json!({ "task": "seams", "root": info.root }), &server)?;
    if let Some(e) = done.get("error").and_then(Value::as_str) {
        bail!("the seam check stopped: {e}");
    }
    let report = done["report"].clone();
    if report.is_null() {
        return Ok(None);
    }
    let count = |k: &str| report[k].as_u64().unwrap_or(0) as usize;
    let lines = done["lines"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
    Ok(Some(Found { errors: count("errors"), lines, report }))
}

/// `w3proj terrain seams`: the report as lines (or JSON); exit 1 when there are errors.
pub fn run(project: &Path, json_out: bool, formats: &[PathBuf]) -> Result<ExitCode> {
    let Some(found) = check(project, formats)? else {
        bail!("the terrain of {} isn't split (there is no map/terrain/terrain.json): there are no seams", project.display());
    };
    if json_out {
        println!("{}", serde_json::to_string_pretty(&found.report)?);
    } else {
        for l in &found.lines {
            println!("{l}");
        }
    }
    Ok(if found.errors > 0 { ExitCode::FAILURE } else { ExitCode::SUCCESS })
}

/// The seam check of `w3proj pack`, on the project and its chapter maps (`projects`: place in the pack, folder) whose
/// terrain is split. Errors stop the pack, and so does a check that can't run (no Node.js, no bundle), unless `allow`
/// (`--allow-seam-issues`), which tells them as warnings and packs. Warnings are told and never stop it.
pub fn check_for_pack(projects: &[(String, PathBuf)], allow: bool, formats: &[PathBuf]) -> Result<()> {
    let flag = "--allow-seam-issues packs anyway";
    for (at, dir) in projects {
        let split = w3proj::terrain_layout::is_split_on_disk(&dir.join(w3proj::project::MAP_DIR)).with_context(|| format!("checking {}", dir.display()))?;
        if !split {
            continue;
        }
        let found = match check(dir, formats) {
            Ok(Some(f)) => f,
            Ok(None) => continue,
            Err(e) if allow => {
                eprintln!("warning: {at}the terrain's seams weren't checked ({e:#}): {flag}");
                continue;
            }
            Err(e) => bail!("{at}the terrain's seams can't be checked ({e:#}); `w3proj terrain seams` runs the check, {flag}"),
        };
        for l in found.lines.iter().take(found.lines.len().saturating_sub(1)) {
            if l.starts_with("warning") || allow {
                eprintln!("{at}seam {l}");
            } else {
                println!("{at}seam {l}");
            }
        }
        if found.errors > 0 {
            let summary = found.lines.last().cloned().unwrap_or_default();
            if allow {
                eprintln!("warning: {at}seam check: {summary}; packed anyway (--allow-seam-issues)");
            } else {
                bail!(
                    "{at}the terrain's seams have {} error{} (seam check: {summary}): two edits of neighbouring subterrains left \
                     corners the terrain brushes wouldn't (fix them in W3Proj Studio: Check Terrain Seams lists them), or {flag}",
                    found.errors,
                    if found.errors == 1 { "" } else { "s" }
                );
            }
        }
    }
    Ok(())
}
