//! `w3proj check`: a project checked as W3Proj Studio checks it, without the app: the Problems view's
//! checks (honouring the project's .w3proj/problems-ignore.json), check_melee on melee maps, and
//! check_path between two points.
//!
//! The checks are the app's own TypeScript (`app/src/headless/check.ts`), run in Node the way
//! `w3proj rebuild` runs its code (rebuild.rs: the bundle, the pipe, the backend crate's answers), so
//! the command line reports what the Problems view and the MCP tools report. Nothing is written: this
//! job's backend refuses every write.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::rebuild::{run_host, Server};

/// The sections, in the order they run and are reported.
pub const SECTIONS: [&str; 3] = ["problems", "melee", "path"];

pub struct Options {
    pub project: PathBuf,
    /// The sections asked for by name (`--only`); None: problems, and melee on a melee map.
    pub only: Option<Vec<String>>,
    /// check_path's points: `x1,y1:x2,y2`.
    pub path: Option<String>,
    /// The collision size of the unit the path and melee checks walk with.
    pub unit_size: Option<f64>,
    /// Warnings fail the check too, not only errors.
    pub warnings_fail: bool,
    /// The report as JSON instead of lines.
    pub json: bool,
    /// The game folder (its tables, models, textures).
    pub game: String,
    /// The graphics mode the app's setting would give (sd, hd, de); None: the project's, else the app's default.
    pub mode: Option<String>,
    /// Format definition folders besides the project's own (W3PROJ_FORMATS).
    pub formats: Vec<PathBuf>,
}

/// `x,y` as two finite numbers.
fn point(s: &str) -> Option<[f64; 2]> {
    let (x, y) = s.split_once(',')?;
    let (x, y) = (x.trim().parse::<f64>().ok()?, y.trim().parse::<f64>().ok()?);
    (x.is_finite() && y.is_finite()).then_some([x, y])
}

/// `x1,y1:x2,y2` as the two points of check_path.
pub fn parse_path(s: &str) -> Result<[[f64; 2]; 2]> {
    let bad = || anyhow::anyhow!("--path {s:?}: expected x1,y1:x2,y2 (world coordinates, e.g. -1200,300:2048,-512)");
    let (a, b) = s.split_once(':').ok_or_else(bad)?;
    Ok([point(a).ok_or_else(bad)?, point(b).ok_or_else(bad)?])
}

/// The job for check.ts.
fn job(o: &Options, root: &str) -> Result<Value> {
    if let Some(only) = &o.only {
        for s in only {
            if !SECTIONS.contains(&s.as_str()) {
                bail!("--only: no check {s:?} (problems, melee, path)");
            }
        }
        if only.iter().any(|s| s == "path") && o.path.is_none() {
            bail!("--only=path needs the two points: --path x1,y1:x2,y2");
        }
    }
    let mut settings = json!({ "game.installDir": o.game });
    if let Some(mode) = &o.mode {
        backend::mode(mode).map_err(anyhow::Error::msg)?;
        settings["game.graphicsMode"] = json!(mode);
    }
    let mut job = json!({ "task": "check", "root": root, "settings": settings });
    if let Some(only) = &o.only {
        job["only"] = json!(only);
    }
    if let Some(p) = &o.path {
        let [from, to] = parse_path(p)?;
        job["path"] = json!({ "from": from, "to": to });
    }
    if let Some(size) = o.unit_size {
        if !(size.is_finite() && size >= 0.0) {
            bail!("--unit-size must be 0 or more");
        }
        job["unitSize"] = json!(size);
    }
    Ok(job)
}

/// Counts of the report's rows by severity: (errors, warnings, infos).
pub fn counts(report: &Value) -> (usize, usize, usize) {
    let rows = report["rows"].as_array().map(Vec::as_slice).unwrap_or_default();
    let n = |s: &str| rows.iter().filter(|r| r["severity"] == s).count();
    (n("error"), n("warning"), n("info"))
}

/// The exit code: failure when there are errors, or warnings with `warnings_fail`.
pub fn verdict(report: &Value, warnings_fail: bool) -> ExitCode {
    let (errors, warnings, _) = counts(report);
    if errors > 0 || (warnings_fail && warnings > 0) { ExitCode::FAILURE } else { ExitCode::SUCCESS }
}

/// The report as lines: one per finding (severity, check, location, message), then what was skipped and the counts.
pub fn lines(report: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for r in report["rows"].as_array().into_iter().flatten() {
        let sev = r["severity"].as_str().unwrap_or("?");
        let check = r["check"].as_str().unwrap_or("?");
        let at = r["location"].as_str().map(|l| format!("  {l}")).unwrap_or_default();
        let message = r["message"].as_str().unwrap_or("");
        out.push(format!("{sev:<7}  {check}{at}: {message}"));
    }
    for s in report["sections"].as_array().into_iter().flatten() {
        if s["ran"] == json!(false) {
            if let (Some(name), Some(note)) = (s["section"].as_str(), s["note"].as_str()) {
                out.push(format!("skipped  {name}: {note}"));
            }
        }
    }
    let (errors, warnings, infos) = counts(report);
    let plural = |n: usize, one: &str| format!("{n} {one}{}", if n == 1 { "" } else { "s" });
    let mut summary = format!("{}, {}", plural(errors, "error"), plural(warnings, "warning"));
    if infos > 0 {
        summary.push_str(&format!(", {infos} info"));
    }
    let ignored = report["ignored"].as_u64().unwrap_or(0);
    if ignored > 0 {
        summary.push_str(&format!(
            "; {ignored} report{} ignored by the project (.w3proj/problems-ignore.json)",
            if ignored == 1 { "" } else { "s" }
        ));
    }
    out.push(summary);
    out
}

pub fn run(o: Options) -> Result<ExitCode> {
    let info = backend::open_project(&o.project.to_string_lossy())
        .map_err(anyhow::Error::msg)
        .with_context(|| format!("opening {}", o.project.display()))?;
    let job = job(&o, &info.root)?;
    let server = Server { root: PathBuf::from(&info.root), formats: o.formats.clone(), game: backend::GameCache::default(), read_only: true };
    let report = run_host(&job, &server)?;
    if let Some(e) = report.get("error").and_then(Value::as_str) {
        bail!("the check stopped: {e}");
    }
    if o.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        for l in lines(&report) {
            println!("{l}");
        }
    }
    Ok(verdict(&report, o.warnings_fail))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_points_are_read_and_bad_ones_refused() {
        assert_eq!(parse_path("-1200,300:2048.5,-512").unwrap(), [[-1200.0, 300.0], [2048.5, -512.0]]);
        assert_eq!(parse_path(" 1 , 2 : 3 , 4 ").unwrap(), [[1.0, 2.0], [3.0, 4.0]]);
        for bad in ["", "1,2", "1,2:3", "1,2:3,x", "a,b:c,d", "1,2:3,4:5,6", "NaN,1:2,3", "inf,1:2,3"] {
            assert!(parse_path(bad).is_err(), "{bad:?}");
        }
    }

    fn report(rows: &[(&str, &str)]) -> Value {
        json!({ "rows": rows.iter().map(|(s, c)| json!({ "severity": s, "check": c, "message": "m" })).collect::<Vec<_>>(), "ignored": 0, "sections": [] })
    }

    #[test]
    fn errors_fail_warnings_only_when_asked() {
        assert_eq!(verdict(&report(&[("error", "jass")]), false), ExitCode::FAILURE);
        assert_eq!(verdict(&report(&[("warning", "jass"), ("info", "path")]), false), ExitCode::SUCCESS, "control: warnings alone pass");
        assert_eq!(verdict(&report(&[("warning", "jass")]), true), ExitCode::FAILURE);
        assert_eq!(verdict(&report(&[("info", "path")]), true), ExitCode::SUCCESS, "info never fails");
        assert_eq!(verdict(&report(&[]), true), ExitCode::SUCCESS);
    }

    #[test]
    fn lines_name_severity_check_location_and_count_the_ignored() {
        let r = json!({
            "rows": [{ "severity": "error", "check": "jass", "location": "war3map.j:12", "message": "undeclared x" },
                     { "severity": "warning", "check": "melee/camps", "message": "few camps" }],
            "ignored": 3,
            "sections": [{ "section": "path", "ran": false, "note": "needs two points" }, { "section": "problems", "ran": true }],
        });
        let l = lines(&r);
        assert_eq!(l[0], "error    jass  war3map.j:12: undeclared x");
        assert_eq!(l[1], "warning  melee/camps: few camps");
        assert_eq!(l[2], "skipped  path: needs two points");
        assert_eq!(l[3], "1 error, 1 warning; 3 reports ignored by the project (.w3proj/problems-ignore.json)");
        assert_eq!(l.len(), 4);
    }

    /// The check's backend writes nothing, not even inside the project; the rebuild's still does (control).
    #[test]
    fn the_check_job_writes_nothing() {
        let dir = std::env::temp_dir().join(format!("w3proj-check-readonly-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("map")).unwrap();
        let file = dir.join("map").join("x.txt");
        let args = json!({ "path": file.to_string_lossy(), "text": "x" });
        let server = |read_only| Server { root: dir.clone(), formats: Vec::new(), game: backend::GameCache::default(), read_only };
        let e = server(true).answer("fs_write_text", &args, None).err().expect("refused");
        assert!(e.contains("only reads"), "{e}");
        assert!(server(true).answer("fs_write_bytes", &json!({ "path": file.to_string_lossy() }), Some(vec![1])).is_err());
        assert!(!file.exists());
        assert!(server(false).answer("fs_write_text", &args, None).is_ok(), "control: the rebuild's backend writes");
        assert!(file.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_job_refuses_unknown_checks_and_a_path_without_points() {
        let o = |only: Option<Vec<&str>>, path: Option<&str>| Options {
            project: PathBuf::new(),
            only: only.map(|v| v.into_iter().map(String::from).collect()),
            path: path.map(String::from),
            unit_size: None,
            warnings_fail: false,
            json: false,
            game: "g".into(),
            mode: None,
            formats: Vec::new(),
        };
        assert!(job(&o(Some(vec!["nope"]), None), "/p").is_err());
        assert!(job(&o(Some(vec!["path"]), None), "/p").is_err());
        let j = job(&o(Some(vec!["path", "melee"]), Some("1,2:3,4")), "/p").unwrap();
        assert_eq!(j["path"], json!({ "from": [1.0, 2.0], "to": [3.0, 4.0] }));
        assert_eq!(j["only"], json!(["path", "melee"]));
        assert_eq!(j["task"], "check");
        let plain = job(&o(None, None), "/p").unwrap();
        assert!(plain.get("only").is_none() && plain.get("path").is_none(), "control: nothing asked, nothing set");
    }
}
