//! `w3proj rebuild`: a project's derived files (pathing war3map.wpm, shadows war3map.shd, the minimap
//! war3mapMap.blp with its icons war3map.mmp, and the map script war3map.j / .lua) made again from its
//! files, without the app.
//!
//! They are made by the app's own TypeScript, not by a second copy of it here: this starts it in Node
//! (`app/src/headless`, one bundled file) and answers its backend commands over a pipe with the same Rust
//! the app answers them with (the `backend` crate). So a rebuild here writes what the app writes, and a fix
//! to a generator reaches both. What is due is decided here: pathing, shadows and the minimap only when the
//! terrain or doodads changed since they were made (w3proj::derived), the script always (the app's own
//! guard keeps a script that was edited by hand). Afterwards the record pack checks is written anew.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use w3proj::derived::{self, Freshness};

/// The parts, in the order they run and are reported.
pub const PARTS: [&str; 4] = ["wpm", "shd", "minimap", "script"];
/// The parts made from the terrain and doodads (w3proj::derived records them as one).
const DERIVED_PARTS: [&str; 3] = ["wpm", "shd", "minimap"];

fn what(part: &str) -> &'static str {
    match part {
        "wpm" => "pathing",
        "shd" => "shadows",
        "minimap" => "minimap",
        _ => "map script",
    }
}

pub struct Options {
    pub project: PathBuf,
    /// The parts asked for by name (`--only`); None: what is due.
    pub only: Option<Vec<String>>,
    /// Pathing, shadows and the minimap even when they follow the terrain and doodads.
    pub force: bool,
    /// The game folder (its data: tables, models, textures).
    pub game: String,
    /// The graphics mode the app's setting would give (sd, hd, de); None: the project's, else the app's default.
    pub mode: Option<String>,
    /// Format definition folders besides the project's own (W3PROJ_FORMATS).
    pub formats: Vec<PathBuf>,
}

pub fn run(o: Options) -> Result<ExitCode> {
    let info = backend::open_project(&o.project.to_string_lossy()).map_err(anyhow::Error::msg).with_context(|| format!("opening {}", o.project.display()))?;
    let root = PathBuf::from(&info.root);
    let parts = due(&o, &root)?;
    // Taken before anything is made: a terrain or doodad file written meanwhile shows as changed since.
    let sources = derived::sources(&root)?;
    let mut failed = false;
    let mut done: Vec<&str> = Vec::new();
    if !parts.run.is_empty() {
        let mut settings = json!({ "game.installDir": o.game });
        if let Some(mode) = &o.mode {
            backend::mode(mode).map_err(anyhow::Error::msg)?;
            settings["game.graphicsMode"] = json!(mode);
        }
        let job = json!({ "task": "rebuild", "root": info.root, "parts": parts.run, "settings": settings });
        let server = Server { root: root.clone(), formats: o.formats.clone(), game: backend::GameCache::default() };
        // Every part reads the game. Without it some still come out, wrong: shadows without the doodads' models
        // (the app's Calculate Shadows does the same), written over the good ones. So nothing is made at all.
        if let Err(e) = server.game.get(&o.game) {
            bail!("{e}: nothing was made. The files come from the game's tables, models and textures: give its folder with --game or W3PROJ_GAME");
        }
        let report = run_host(&job, &server)?;
        if let Some(e) = report.get("error").and_then(Value::as_str) {
            bail!("the rebuild stopped: {e}");
        }
        for r in report["parts"].as_array().into_iter().flatten() {
            let part = r["part"].as_str().unwrap_or("?");
            let status = r["status"].as_str().unwrap_or("?");
            let files = r["files"].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join(", ");
            let note = r["note"].as_str().map(|n| format!(": {n}")).unwrap_or_default();
            println!("{status:<9}  {files} ({}){note}", what(part));
            failed |= status == "failed";
            if status == "written" || status == "unchanged" {
                done.push(PARTS.iter().find(|p| **p == part).copied().unwrap_or("?"));
            }
        }
        let also = report["alsoChanged"].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>();
        if !also.is_empty() {
            println!("also written: {} (as the app's save of the script writes it)", also.join(", "));
        }
        // What the app would have shown besides: not the questions nobody answers here, nor what a part's line said.
        let notes: Vec<&str> = report["parts"].as_array().into_iter().flatten().filter_map(|r| r["note"].as_str()).collect();
        for m in report["messages"].as_array().into_iter().flatten() {
            if let (Some(sev), Some(text)) = (m["severity"].as_str(), m["text"].as_str()) {
                if m["asked"] != json!(true) && !notes.iter().any(|n| n.contains(text)) {
                    println!("  {sev}: {text}");
                }
            }
        }
    }
    for (parts, why) in &parts.skipped {
        println!("skipped    {}: {why}", parts.iter().map(|p| what(p)).collect::<Vec<_>>().join(", "));
    }
    // The record says pathing, shadows and the minimap follow the sources: only when each of them does now.
    let follow = |p: &&str| done.contains(p) || parts.fresh.contains(p);
    if DERIVED_PARTS.iter().all(follow) {
        if !sources.is_empty() {
            derived::record(&root, &sources)?;
        }
    } else if parts.run.iter().any(|p| DERIVED_PARTS.contains(&p.as_str())) {
        let left = DERIVED_PARTS.iter().filter(|p| !follow(p)).map(|p| what(p)).collect::<Vec<_>>().join(", ");
        println!("not recorded as up to date ({}): {left} still to be made, `w3proj pack` takes them for outdated", derived::STAMP_FILE);
    }
    Ok(if failed { ExitCode::FAILURE } else { ExitCode::SUCCESS })
}

struct Due {
    run: Vec<String>,
    /// Derived parts not made because they follow the terrain and doodads.
    fresh: Vec<&'static str>,
    skipped: Vec<(Vec<&'static str>, String)>,
}

fn due(o: &Options, root: &Path) -> Result<Due> {
    if let Some(only) = &o.only {
        for p in only {
            if !PARTS.contains(&p.as_str()) {
                bail!("--only: no part {p:?} (wpm, shd, minimap, script)");
            }
        }
        let run = PARTS.iter().filter(|p| only.iter().any(|q| q == *p)).map(|p| p.to_string()).collect();
        return Ok(Due { run, fresh: Vec::new(), skipped: Vec::new() });
    }
    let mut run = Vec::new();
    let mut fresh = Vec::new();
    let mut skipped = Vec::new();
    let freshness = derived::check(root)?;
    if freshness == Freshness::Fresh && !o.force {
        fresh.extend(DERIVED_PARTS);
        skipped.push((DERIVED_PARTS.to_vec(), "they follow the terrain and doodads (--force makes them again)".to_string()));
    } else {
        if let Freshness::Unreadable(why) = &freshness {
            println!("note: {why}; pathing, shadows and the minimap are made again");
        }
        run.extend(DERIVED_PARTS.iter().map(|p| p.to_string()));
    }
    run.push("script".to_string());
    Ok(Due { run, fresh, skipped })
}

// ---------------------------------------------------------------- the host

/// The bundle's file name, as a release ships it.
const BUNDLE: &str = "w3proj-headless.mjs";

/// Where a release puts the bundle, seen from this program's folder `exe_dir`: beside it (Windows installers, the
/// loose download, macOS beside the program), Tauri's resource folder of the installed app (Linux packages and the
/// AppImage: the program in usr/bin, resources in usr/lib/<the app>/; macOS: ../Resources).
fn bundle_places(exe_dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![exe_dir.join(BUNDLE), exe_dir.join("../Resources").join(BUNDLE)];
    // The app's folder under lib is named by Tauri after the app (its product or program name): every folder there
    // that holds the bundle counts, so a renamed product still finds it.
    for name in ["w3proj-studio", "W3Proj Studio"] {
        out.push(exe_dir.join("../lib").join(name).join(BUNDLE));
    }
    if let Ok(entries) = std::fs::read_dir(exe_dir.join("../lib")) {
        let mut more: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path().join(BUNDLE)).collect();
        more.sort();
        out.extend(more);
    }
    out
}

/// Where the app's code for Node is: a bundle named by W3PROJ_HEADLESS, the one a release installs with this
/// program (`bundle_places`), else the checkout this was built from, which bundles its code as it is now.
fn host_command(job: &Value) -> Result<Command> {
    let node = std::env::var_os("W3PROJ_NODE").unwrap_or_else(|| "node".into());
    let mut cmd = Command::new(&node);
    let shipped = std::env::current_exe().ok().and_then(|e| e.parent().map(bundle_places)).unwrap_or_default();
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../app");
    if let Some(file) = std::env::var_os("W3PROJ_HEADLESS") {
        cmd.arg(file);
    } else if let Some(file) = shipped.iter().find(|f| f.is_file()) {
        cmd.arg(file);
    } else if checkout.join("scripts/headless.mjs").is_file() && checkout.join("node_modules/esbuild").is_dir() {
        cmd.arg(checkout.join("scripts/headless.mjs"));
    } else {
        bail!(
            "w3proj rebuild runs W3Proj Studio's own code in Node.js, and found none of it: {BUNDLE} isn't beside this \
             program or in the installed app's resources. Put it there (node app/scripts/headless.mjs --out <file> makes \
             it), or set W3PROJ_HEADLESS to it"
        );
    }
    cmd.arg(job.to_string());
    Ok(cmd)
}

/// How long the host may send nothing before it counts as stuck (W3PROJ_REBUILD_IDLE_SECS changes it). Its own
/// watchdog (ipc.ts) says sooner what it waited for; this one also catches a host stuck in a loop.
fn idle_limit() -> Duration {
    let secs = std::env::var("W3PROJ_REBUILD_IDLE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(600);
    Duration::from_secs(secs)
}

/// Runs the host with `job`, answering its commands until it reports; its report.
fn run_host(job: &Value, server: &Server) -> Result<Value> {
    let mut cmd = host_command(job)?;
    let idle = idle_limit();
    cmd.env("W3PROJ_REBUILD_IDLE_SECS", (idle.as_secs() / 2).max(1).to_string());
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| {
            let node = cmd.get_program().to_string_lossy().into_owned();
            anyhow::anyhow!("can't start {node} ({e}): w3proj rebuild needs Node.js 22 or newer (or W3PROJ_NODE naming it)")
        })?;
    let mut to = child.stdin.take().expect("piped stdin");
    let frames = read_frames(BufReader::new(child.stdout.take().expect("piped stdout")));
    let report = serve(&frames, &mut to, server, idle);
    drop(to);
    // Nothing more is answered: a host still running would wait for answers that never come.
    if !matches!(report, Ok(Some(_))) {
        let _ = child.kill();
    }
    let status = child.wait()?;
    match report {
        Ok(Some(r)) => Ok(r),
        Ok(None) => bail!("the rebuild in Node ended without a report ({status})"),
        Err(e) => Err(e.context(format!("the rebuild in Node ({status})"))),
    }
}

/// One frame of app/src/headless/ipc.ts: a JSON line, and the raw bytes its `len` counts.
type Frame = (Value, Option<Vec<u8>>);

fn read_frame(from: &mut impl BufRead) -> Result<Option<Frame>> {
    let mut line = Vec::new();
    if from.read_until(b'\n', &mut line)? == 0 {
        return Ok(None);
    }
    let msg: Value = serde_json::from_slice(&line).context("a message from Node that isn't JSON")?;
    let body = match msg.get("len").and_then(Value::as_u64) {
        Some(n) => {
            let mut b = vec![0; usize::try_from(n)?];
            from.read_exact(&mut b)?;
            Some(b)
        }
        None => None,
    };
    Ok(Some((msg, body)))
}

/// The frames from `from`, read on a thread of their own (so waiting for the next has a time limit); the channel
/// ends after the pipe's end or a broken frame.
fn read_frames(mut from: impl BufRead + Send + 'static) -> Receiver<Result<Option<Frame>>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || loop {
        let frame = read_frame(&mut from);
        let last = !matches!(frame, Ok(Some(_)));
        if tx.send(frame).is_err() || last {
            return;
        }
    });
    rx
}

/// Answers the frames until the report comes (Some) or the pipe ends (None); an error when the host sends nothing
/// for `idle`.
fn serve(frames: &Receiver<Result<Option<Frame>>>, to: &mut impl Write, server: &Server, idle: Duration) -> Result<Option<Value>> {
    loop {
        let (msg, body) = match frames.recv_timeout(idle) {
            Ok(frame) => match frame? {
                Some(f) => f,
                None => return Ok(None),
            },
            Err(RecvTimeoutError::Timeout) => bail!("the rebuild in Node sent nothing for {} s: stopped", idle.as_secs()),
            Err(RecvTimeoutError::Disconnected) => return Ok(None),
        };
        if let Some(report) = msg.get("done") {
            return Ok(Some(report.clone()));
        }
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let cmd = msg.get("cmd").and_then(Value::as_str).unwrap_or("");
        let args = msg.get("args").cloned().unwrap_or(Value::Null);
        let answer = match server.answer(cmd, &args, body) {
            Ok(Answer::Json(v)) => format!("{}\n", json!({ "id": id, "ok": v })).into_bytes(),
            Ok(Answer::Bytes(b)) => {
                let mut out = format!("{}\n", json!({ "id": id, "len": b.len() })).into_bytes();
                out.extend_from_slice(&b);
                out
            }
            Err(e) => format!("{}\n", json!({ "id": id, "err": e })).into_bytes(),
        };
        to.write_all(&answer)?;
        to.flush()?;
    }
}

pub enum Answer {
    Json(Value),
    Bytes(Vec<u8>),
}

/// The backend commands the app's code calls, answered as the app answers them (crates/backend).
pub struct Server {
    pub root: PathBuf,
    pub formats: Vec<PathBuf>,
    pub game: backend::GameCache,
}

fn arg<'a>(args: &'a Value, name: &str) -> Result<&'a str, String> {
    args.get(name).and_then(Value::as_str).ok_or_else(|| format!("missing argument {name}"))
}

fn opt_arg(args: &Value, name: &str) -> Option<String> {
    args.get(name).and_then(Value::as_str).map(str::to_string)
}

fn to_json(v: impl serde::Serialize) -> Result<Answer, String> {
    serde_json::to_value(v).map(Answer::Json).map_err(backend::err)
}

impl Server {
    /// A file this job may write: inside the project. The app's code writes only the project's files here; one
    /// outside it is refused rather than written where nobody asked for a change.
    fn writable(&self, path: &str) -> Result<PathBuf, String> {
        let p = PathBuf::from(path);
        backend::write_lands_inside(&self.root, &p).map_err(|e| format!("{e}: w3proj rebuild writes only the project's files"))?;
        Ok(p)
    }

    pub fn answer(&self, cmd: &str, args: &Value, body: Option<Vec<u8>>) -> Result<Answer, String> {
        let path = || arg(args, "path");
        let root = || arg(args, "root");
        match cmd {
            "project_open" => to_json(backend::open_project(path()?)?),
            "project_files" => to_json(backend::walk_project(Path::new(root()?), false)?.0),
            "project_folders" => to_json(backend::project_folders(Path::new(root()?))?),
            "path_normalize" => to_json(backend::normal_path(path()?)),
            "fs_stat" => to_json(backend::stamp_of(Path::new(path()?)).ok()),
            "fs_exists" => to_json(backend::exists_checked(Path::new(path()?))?),
            "fs_read_text" => to_json(backend::read_text(Path::new(path()?))?),
            "fs_read_bytes" => Ok(Answer::Bytes(std::fs::read(path()?).map_err(backend::err)?)),
            "fs_list_tree" => to_json(backend::list_tree(Path::new(path()?))?),
            "fs_write_text" => {
                let text = arg(args, "text")?;
                to_json(backend::write_file(&self.writable(path()?)?, |f| f.write_all(text.as_bytes()))?)
            }
            "fs_write_bytes" => {
                let bytes = body.ok_or("expected a raw byte body")?;
                to_json(backend::write_file(&self.writable(path()?)?, |f| f.write_all(&bytes))?)
            }
            "codec_decode" => to_json(backend::codec_decode(root()?, path()?, &self.formats)?),
            "codec_canonicalize" => to_json(backend::codec_canonicalize(root()?, path()?, arg(args, "text")?, &self.formats)?),
            "codec_write" => {
                self.writable(&Path::new(root()?).join(path()?).to_string_lossy())?;
                to_json(backend::codec_write(root()?, path()?, arg(args, "text")?, &self.formats)?)
            }
            "derived_sources" => to_json(w3proj::derived::sources(Path::new(root()?)).map_err(backend::err)?),
            // The CLI records what the files follow itself, once the job is done and only if all of them do (rebuild::run).
            "derived_record" => Ok(Answer::Json(Value::Null)),
            "game_read" => {
                let g = self.game.get(arg(args, "install")?)?;
                Ok(Answer::Bytes(backend::game_read(&g, path()?, arg(args, "modeName")?, &opt_arg(args, "tileset"))?))
            }
            "game_resolve" => {
                let g = self.game.get(arg(args, "install")?)?;
                to_json(backend::game_resolve(&g, path()?, arg(args, "modeName")?, &opt_arg(args, "tileset"))?)
            }
            "game_list" => to_json(backend::game_list(&*self.game.get(arg(args, "install")?)?)),
            "game_info" => to_json(backend::game_info(&*self.game.get(arg(args, "install")?)?)),
            "game_resolve_many" => {
                let g = self.game.get(arg(args, "install")?)?;
                let paths = args.get("paths").and_then(Value::as_array).ok_or("missing argument paths")?;
                let (mode, tileset) = (arg(args, "modeName")?, opt_arg(args, "tileset"));
                let out = paths
                    .iter()
                    .map(|p| backend::game_resolve(&g, p.as_str().unwrap_or(""), mode, &tileset))
                    .collect::<Result<Vec<_>, _>>()?;
                to_json(out)
            }
            _ => Err(format!("w3proj rebuild has no backend command {cmd:?}: it needs the app")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn server(root: &Path) -> Server {
        Server { root: root.to_path_buf(), formats: Vec::new(), game: backend::GameCache::default() }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("w3proj-rebuild-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("map")).unwrap();
        dir
    }

    /// The frames of ipc.ts: a JSON line, a raw body after it when it says `len`; answers in the same form.
    #[test]
    fn frames_with_and_without_a_body_are_answered_and_the_report_ends_it() {
        let dir = scratch("frames");
        let file = dir.join("map").join("a.bin");
        let p = file.to_string_lossy().into_owned();
        let mut input = Vec::new();
        input.extend(format!("{}\n", json!({ "id": 1, "cmd": "fs_write_bytes", "args": { "path": p }, "len": 3 })).as_bytes());
        input.extend([0u8, 10, 255]);
        input.extend(format!("{}\n", json!({ "id": 2, "cmd": "fs_read_bytes", "args": { "path": p } })).as_bytes());
        input.extend(format!("{}\n", json!({ "id": 3, "cmd": "no_such_command", "args": {} })).as_bytes());
        input.extend(format!("{}\n", json!({ "done": { "parts": [] } })).as_bytes());
        let mut out = Vec::new();
        let report = serve(&read_frames(std::io::Cursor::new(input)), &mut out, &server(&dir), Duration::from_secs(10)).unwrap();
        assert_eq!(report, Some(json!({ "parts": [] })));
        assert_eq!(std::fs::read(&file).unwrap(), [0, 10, 255]);
        // Answer 1: the stamp; answer 2: the bytes after a line with their length; answer 3: an error.
        let mut r = &out[..];
        let next_line = |r: &mut &[u8]| {
            let mut l = Vec::new();
            r.read_until(b'\n', &mut l).unwrap();
            serde_json::from_slice::<Value>(&l).unwrap()
        };
        let one = next_line(&mut r);
        assert_eq!((one["id"].clone(), one["ok"]["size"].clone()), (json!(1), json!(3)));
        let two = next_line(&mut r);
        assert_eq!((two["id"].clone(), two["len"].clone()), (json!(2), json!(3)));
        let mut bytes = [0u8; 3];
        r.read_exact(&mut bytes).unwrap();
        assert_eq!(bytes, [0, 10, 255]);
        let three = next_line(&mut r);
        assert_eq!(three["id"], 3);
        assert!(three["err"].as_str().unwrap().contains("no_such_command"), "{three}");
        assert!(r.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writes_outside_the_project_are_refused() {
        let dir = scratch("outside");
        let s = server(&dir);
        let outside = std::env::temp_dir().join(format!("w3proj-rebuild-outside-{}.txt", std::process::id()));
        let e = s.answer("fs_write_text", &json!({ "path": outside.to_string_lossy(), "text": "x" }), None).err().unwrap();
        assert!(e.contains("outside the project"), "{e}");
        assert!(!outside.exists());
        let sneaky = dir.join("map").join("..").join("..").join("x.txt");
        assert!(s.answer("fs_write_text", &json!({ "path": sneaky.to_string_lossy(), "text": "x" }), None).is_err());
        let inside = dir.join("map").join("ok.txt");
        assert!(s.answer("fs_write_text", &json!({ "path": inside.to_string_lossy(), "text": "x" }), None).is_ok());
        assert_eq!(std::fs::read_to_string(&inside).unwrap(), "x");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A pipe that ends before the report is told apart from a report (Node died).
    #[test]
    fn a_pipe_that_ends_without_a_report_is_none() {
        let dir = scratch("eof");
        let mut out = Vec::new();
        assert_eq!(serve(&read_frames(std::io::Cursor::new(Vec::new())), &mut out, &server(&dir), Duration::from_secs(10)).unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A host that sends nothing (stuck on a promise that never settles, or in a loop) stops the job after the
    /// idle limit instead of holding it for good.
    #[test]
    fn a_host_that_sends_nothing_is_stopped() {
        let dir = scratch("idle");
        let (_tx, rx) = mpsc::channel::<Result<Option<Frame>>>();
        let started = std::time::Instant::now();
        let e = serve(&rx, &mut Vec::new(), &server(&dir), Duration::from_millis(200)).unwrap_err();
        assert!(e.to_string().contains("sent nothing"), "{e}");
        assert!(started.elapsed() < Duration::from_secs(5));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The bundle of an installed app is found beside the program and in Tauri's resource folder (Linux packages:
    /// usr/bin and usr/lib/<app>/), whatever the app's folder there is called.
    #[test]
    fn the_shipped_bundle_is_found_beside_the_program_and_in_the_resources() {
        let dir = scratch("places");
        let bin = dir.join("usr").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(dir.join("usr/lib/Some App")).unwrap();
        std::fs::write(dir.join("usr/lib/Some App").join(BUNDLE), "").unwrap();
        let found: Vec<_> = bundle_places(&bin).into_iter().filter(|p| p.is_file()).collect();
        assert_eq!(found.len(), 1, "{found:?}");
        std::fs::write(bin.join(BUNDLE), "").unwrap();
        assert_eq!(bundle_places(&bin).into_iter().find(|p| p.is_file()), Some(bin.join(BUNDLE)), "beside the program wins");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A link inside the project to a file or folder outside it doesn't let a write land outside.
    #[cfg(unix)]
    #[test]
    fn writes_through_links_out_of_the_project_are_refused() {
        let dir = scratch("links");
        let away = std::env::temp_dir().join(format!("w3proj-rebuild-away-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&away);
        std::fs::create_dir_all(&away).unwrap();
        std::fs::write(away.join("victim.shd"), "keep").unwrap();
        std::os::unix::fs::symlink(away.join("victim.shd"), dir.join("map/war3map.shd")).unwrap();
        std::os::unix::fs::symlink(&away, dir.join("linked")).unwrap();
        std::os::unix::fs::symlink(away.join("missing.txt"), dir.join("map/dangling.txt")).unwrap();
        let s = server(&dir);
        for p in [dir.join("map/war3map.shd"), dir.join("linked/new.txt"), dir.join("linked/deeper/new.txt"), dir.join("map/dangling.txt")] {
            let e = s.answer("fs_write_text", &json!({ "path": p.to_string_lossy(), "text": "x" }), None).err();
            assert!(e.as_deref().is_some_and(|e| e.contains("outside the project")), "{} was written: {e:?}", p.display());
        }
        assert_eq!(std::fs::read_to_string(away.join("victim.shd")).unwrap(), "keep");
        assert!(!away.join("new.txt").exists() && !away.join("deeper").exists() && !away.join("missing.txt").exists());
        // Control: a new file in a new folder inside the project is written.
        let fresh = dir.join(".w3proj/new/ok.txt");
        assert!(s.answer("fs_write_text", &json!({ "path": fresh.to_string_lossy(), "text": "x" }), None).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&away);
    }
}
