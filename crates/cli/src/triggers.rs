//! `w3proj triggers <project> --check [--fix …]`: Check Trigger Tree of W3Proj Studio on the command line, the same
//! check (`w3proj::trigger_check`, through the backend crate as the app's Problems view calls it) on the files of
//! `map/triggers/` as they are on disk. Fixes are written only when asked for (`--fix`), each file in one step.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{bail, Context, Result};
use serde_json::Value;
use w3proj::trigger_check::{Issue, Severity};

/// The report's lines: one per issue (severity, file and line, message, the fix that would repair it), then the counts.
pub fn lines(issues: &[Issue]) -> Vec<String> {
    let mut out: Vec<String> = issues
        .iter()
        .map(|i| {
            let sev = if i.severity == Severity::Error { "error" } else { "warning" };
            let fix = i.fix.map(|f| format!(" [--fix {}]", f.as_str())).unwrap_or_default();
            format!("{sev:<7}  {i}{fix}")
        })
        .collect();
    let errors = issues.iter().filter(|i| i.severity == Severity::Error).count();
    let warnings = issues.len() - errors;
    let plural = |n: usize, one: &str| format!("{n} {one}{}", if n == 1 { "" } else { "s" });
    out.push(format!("Check Trigger Tree: {}, {}", plural(errors, "error"), plural(warnings, "warning")));
    out
}

/// The fixes named by `--fix` (comma-separated, or "all").
pub fn parse_fixes(list: &[String]) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for item in list.iter().flat_map(|s| s.split(',')).map(str::trim).filter(|s| !s.is_empty()) {
        if item == "all" {
            out.extend(["renumber", "order", "collapse"].map(String::from));
        } else if w3proj::trigger_check::Fix::parse(item).is_some() {
            out.push(item.to_string());
        } else {
            bail!("--fix {item:?}: the fixes are renumber, order, collapse (or all)");
        }
    }
    Ok(out)
}

/// Writes a fix plan (`backend::triggers::fix`) into the project: each file in one step, removed ones removed.
fn apply(project: &Path, plan: &Value) -> Result<usize> {
    let mut n = 0;
    for w in plan["write"].as_array().into_iter().flatten() {
        let (Some(path), Some(text)) = (w["path"].as_str(), w["text"].as_str()) else { bail!("a fix plan without path or text") };
        let at = w3proj::paths::join_rel(project, path);
        w3proj::atomic::write(&at, text.as_bytes()).with_context(|| format!("writing {path}"))?;
        println!("  wrote {path}");
        n += 1;
    }
    for d in plan["delete"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        match std::fs::remove_file(w3proj::paths::join_rel(project, d)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => bail!("removing {d}: {e}"),
        }
        println!("  removed {d}");
        n += 1;
    }
    Ok(n)
}

/// `--check` (and `--fix`): the report as lines or JSON; exit 1 when errors are left.
pub fn run(project: &Path, fixes: &[String], json: bool, formats: &[PathBuf]) -> Result<ExitCode> {
    let root = project.to_string_lossy().to_string();
    if !project.join(w3proj::project::MAP_DIR).join(w3proj::trigger_layout::ROOT_FILE).is_file() && !project.join(w3proj::project::MAP_DIR).join(w3proj::trigger_layout::DIR).is_dir() {
        bail!("{} has no map/{}/: there is no trigger tree to check", project.display(), w3proj::trigger_layout::DIR);
    }
    let fixes = parse_fixes(fixes)?;
    if !fixes.is_empty() {
        let plan = backend::triggers::fix(&root, formats, &fixes).map_err(anyhow::Error::msg)?;
        let n = apply(project, &plan)?;
        println!("fixed ({}): {n} file{} changed", fixes.join(", "), if n == 1 { "" } else { "s" });
    }
    let issues = backend::triggers::check(&root, formats).map_err(anyhow::Error::msg)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&issues)?);
    } else {
        for l in lines(&issues) {
            println!("{l}");
        }
    }
    Ok(if issues.iter().any(|i| i.severity == Severity::Error) { ExitCode::FAILURE } else { ExitCode::SUCCESS })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixes_are_named_or_all_and_others_refused() {
        assert_eq!(parse_fixes(&["order,collapse".into()]).unwrap(), ["order", "collapse"]);
        assert_eq!(parse_fixes(&["all".into()]).unwrap(), ["renumber", "order", "collapse"]);
        assert!(parse_fixes(&["order".into(), "nope".into()]).is_err());
        assert!(parse_fixes(&[]).unwrap().is_empty());
    }
}
