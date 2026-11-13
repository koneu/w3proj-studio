//! `w3proj check` end to end on the mini map: the app's own Problems checks run in Node through the CLI,
//! without a game (its reads fail, which those checks report as failed), the project's ignore file honoured
//! and counted, the exit code from the errors, and nothing in the project written.
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let target = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() { copy_dir(&e.path(), &target) } else { std::fs::copy(e.path(), &target).unwrap(); }
    }
}

/// Every file under `dir` with its bytes, sorted.
fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() { stack.push(p) } else { out.push((p.clone(), std::fs::read(&p).unwrap())) }
        }
    }
    out.sort();
    out
}

fn mini_map(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("w3proj-check-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    copy_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mini-map"), &dir);
    dir
}

fn check(project: &Path, args: &[&str]) -> (Option<i32>, Value) {
    let out = Command::new(env!("CARGO_BIN_EXE_w3proj"))
        .arg("check")
        .arg(project)
        .args(["--json", "--game"])
        .arg(project.join("no-game-here"))
        .args(args)
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    let report = serde_json::from_str(&text).unwrap_or_else(|e| panic!("not a JSON report ({e}): {text}\n{}", String::from_utf8_lossy(&out.stderr)));
    (out.status.code(), report)
}

fn rows<'a>(r: &'a Value, check: &str) -> Vec<&'a Value> {
    r["rows"].as_array().unwrap().iter().filter(|row| row["check"] == check).collect()
}

#[test]
fn the_problems_checks_run_honour_the_ignore_file_and_write_nothing() {
    let dir = mini_map("ignore");
    let before = snapshot(&dir);
    let (code, r) = check(&dir, &["--only=problems"]);
    // Without a game, the checks that read it fail: failures are errors, not "no problems".
    assert_eq!(code, Some(1), "{r}");
    assert!(rows(&r, "jass").iter().any(|row| row["severity"] == "error" && row["message"].as_str().unwrap().contains("the check failed")), "{r}");
    let unlisted = rows(&r, "unlistedImports");
    assert_eq!(unlisted.len(), 1, "{r}");
    assert_eq!(r["ignored"], 0);
    assert_eq!(snapshot(&dir), before, "the check wrote into the project");

    // Ignored by the project: gone from the rows, counted.
    let about = format!("{}\n{}", unlisted[0]["location"].as_str().unwrap(), unlisted[0]["message"].as_str().unwrap());
    std::fs::create_dir_all(dir.join(".w3proj")).unwrap();
    let ignore = serde_json::json!({ "version": 1, "rules": [], "items": [{ "check": "unlistedImports", "about": about }] });
    std::fs::write(dir.join(".w3proj/problems-ignore.json"), serde_json::to_string(&ignore).unwrap()).unwrap();
    let (_, r) = check(&dir, &["--only=problems"]);
    assert!(rows(&r, "unlistedImports").is_empty(), "{r}");
    assert_eq!(r["ignored"], 1);
    assert_eq!(r["ignoreError"], Value::Null);

    // An ignore file that is there but broken hides nothing, and says so.
    std::fs::write(dir.join(".w3proj/problems-ignore.json"), "{ broken").unwrap();
    let (_, r) = check(&dir, &["--only=problems"]);
    assert_eq!(rows(&r, "unlistedImports").len(), 1, "{r}");
    assert!(r["ignoreError"].as_str().unwrap().contains("can't be used"), "{r}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn melee_is_left_out_of_a_map_without_the_melee_flag_and_path_needs_points() {
    let dir = mini_map("sections");
    let (_, r) = check(&dir, &[]);
    let skipped: Vec<&str> = r["sections"].as_array().unwrap().iter().filter(|s| s["ran"] == false).map(|s| s["section"].as_str().unwrap()).collect();
    assert_eq!(skipped, ["melee", "path"], "{r}");
    assert!(rows(&r, "melee").is_empty());
    let out = Command::new(env!("CARGO_BIN_EXE_w3proj")).arg("check").arg(&dir).arg("--only=path").output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("--path"), "{}", String::from_utf8_lossy(&out.stderr));
    let _ = std::fs::remove_dir_all(&dir);
}
