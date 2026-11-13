//! Runs an external tool (a script compiler a language extension uses, like the game's JassHelper, or git)
//! and waits for it, with its output captured.
//!
//! The tool has ended when its process exits, not when its output closes. Its stdout and stderr go to files,
//! not pipes: whatever it leaves running keeps them open, and waiting for the end of a pipe waited for that.
//! JassHelper, run through Proton on Linux, left two such things (seen 2026-11-12): on a compile error it starts
//! itself again as `jasshelper.exe --showerrors`, a window with the errors that waits for a click nobody gives
//! in the hidden app, and the first Windows program in a prefix starts Wine's services (wineserver, services.exe,
//! explorer.exe), which inherit its output and may stay for good. tool_run waited for both, so a vJASS map's
//! script generation never finished after a compile error (app, MCP delete_object, `settled()`).
//!
//! When it has exited, what it started that is still running and is its own (a program from its folder that holds
//! this run's output: the error window, not Wine's services or anything of the user's) is ended. A run with a
//! [`Guard`] is also ended when it goes too long without progress, or when its result is there and it still
//! hasn't exited; the result says so (`killed`).

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

/// What an external tool run printed and returned.
#[derive(Serialize, Debug)]
pub struct ToolResult {
    /// Its exit code; -1 when it was ended (`killed`) or ended by a signal.
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    /// Why it was ended before it exited, if it was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub killed: Option<String>,
}

/// Limits for a run that might not end by itself.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Guard {
    /// Ended after this long without progress: nothing new in its output or in the files of the folder it runs in.
    pub idle_ms: u64,
    /// Files (relative to the folder it runs in) that hold its result. Once one is there and nothing has changed for
    /// `settle_ms`, it is ended even though it hasn't exited.
    #[serde(default)]
    pub result_files: Vec<String>,
    #[serde(default = "default_settle_ms")]
    pub settle_ms: u64,
}

fn default_settle_ms() -> u64 {
    3000
}

const POLL: Duration = Duration::from_millis(50);
/// How often the folder is looked at for progress (a guarded run only).
const LOOK: Duration = Duration::from_millis(250);

/// Runs `cmd` (its program, arguments and folder `cwd` set) and waits for it to exit. `program` is the tool's own
/// file (None for a program found on PATH): programs from its folder that hold this run's output are its own, and are
/// ended when it has exited.
pub fn run(mut cmd: Command, label: &str, cwd: &Path, program: Option<&Path>, guard: Option<&Guard>) -> Result<ToolResult, String> {
    let out = Output::new().map_err(|e| format!("{label}: output files: {e}"))?;
    cmd.stdin(Stdio::null()).stdout(out.stdout_file()?).stderr(out.stderr_file()?);
    // Its own process group, so it can be ended with whatever it started there.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().map_err(|e| format!("{label}: {e}"))?;
    // Whatever the tool starts ends with it (JassHelper's error window is a second process): the job is closed when
    // it has exited or been ended.
    #[cfg(windows)]
    let job = crate::job::kill_on_close(&child);
    let waited = wait(&mut child, cwd, &out, guard);
    let (code, killed) = match waited {
        Ok(Ended::Exited(code)) => (code, None),
        Ok(Ended::Killed(why)) => {
            end_tree(&mut child);
            (-1, Some(why))
        }
        Err(e) => {
            end_tree(&mut child);
            return Err(format!("{label}: {e}"));
        }
    };
    #[cfg(windows)]
    drop(job);
    if let Some(p) = program {
        end_own_leftovers(p, &out);
    }
    Ok(ToolResult { code, stdout: out.read(&out.stdout), stderr: out.read(&out.stderr), killed })
}

enum Ended {
    Exited(i32),
    Killed(String),
}

fn wait(child: &mut Child, cwd: &Path, out: &Output, guard: Option<&Guard>) -> std::io::Result<Ended> {
    let Some(g) = guard else {
        return Ok(Ended::Exited(child.wait()?.code().unwrap_or(-1)));
    };
    let started = Instant::now();
    let mut last = progress(cwd, out, g);
    let mut changed = Instant::now();
    let mut looked = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Ended::Exited(status.code().unwrap_or(-1)));
        }
        std::thread::sleep(POLL);
        if looked.elapsed() < LOOK {
            continue;
        }
        looked = Instant::now();
        let now = progress(cwd, out, g);
        if now != last {
            last = now;
            changed = Instant::now();
        }
        let quiet = changed.elapsed();
        let secs = started.elapsed().as_secs();
        if let Some(f) = g.result_files.iter().find(|f| cwd.join(f).is_file()) {
            if quiet >= Duration::from_millis(g.settle_ms) {
                return Ok(Ended::Killed(format!("it wrote {f} but hadn't exited {:.1} s later; ended after {secs} s", quiet.as_secs_f32())));
            }
        }
        if quiet >= Duration::from_millis(g.idle_ms) {
            return Ok(Ended::Killed(format!("nothing happened for {} s; ended after {secs} s", quiet.as_secs())));
        }
    }
}

/// What has changed so far: the output's sizes, and the files in the folder (two levels) by size and time.
fn progress(cwd: &Path, out: &Output, g: &Guard) -> Vec<(PathBuf, u64, Option<SystemTime>)> {
    let mut seen = Vec::new();
    for f in [&out.stdout, &out.stderr] {
        seen.push((f.clone(), std::fs::metadata(f).map(|m| m.len()).unwrap_or(0), None));
    }
    let mut dirs = vec![(cwd.to_path_buf(), 0)];
    while let Some((dir, depth)) = dirs.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten().take(2000) {
            let Ok(m) = e.metadata() else { continue };
            if m.is_dir() {
                if depth < 1 {
                    dirs.push((e.path(), depth + 1));
                }
            } else {
                seen.push((e.path(), m.len(), m.modified().ok()));
            }
        }
    }
    for f in &g.result_files {
        if let Ok(m) = std::fs::metadata(cwd.join(f)) {
            seen.push((cwd.join(f), m.len(), m.modified().ok()));
        }
    }
    seen.sort();
    seen
}

/// Ends the tool and what it started in its process group (Unix) or job (Windows, when the job is closed).
fn end_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        // The group's id is the child's: still reserved, as the child hasn't been waited for.
        let pgid = child.id() as libc::pid_t;
        unsafe { libc::kill(-pgid, libc::SIGKILL) };
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// The tool's own programs still running after it: started from its folder (a Windows program's path as Wine shows
/// it, `C:\…\JassHelper\jasshelper.exe`, or a Linux one) and holding this run's stdout or stderr. Wine starts a
/// Windows program's children in sessions of their own, so the process group doesn't hold them.
#[cfg(target_os = "linux")]
fn end_own_leftovers(program: &Path, out: &Output) {
    use std::os::unix::fs::MetadataExt;
    let Some(dir) = program.parent() else { return };
    let Some(dir_name) = dir.file_name().map(|n| n.to_string_lossy().to_lowercase()) else { return };
    let ours: Vec<(u64, u64)> = [&out.stdout, &out.stderr].iter().filter_map(|f| std::fs::metadata(f).ok()).map(|m| (m.dev(), m.ino())).collect();
    // A process the tool started just before it exited may still be between fork and exec: it holds the output but
    // its command line is still the parent's (a shell, setsid), so one look would miss it. Look again until two looks
    // in a row see the same holders (or about a second has passed).
    let mut seen: Vec<(i32, String)> = Vec::new();
    let mut same = 0;
    for _ in 0..10 {
        let mut now = Vec::new();
        let Ok(procs) = std::fs::read_dir("/proc") else { return };
        for p in procs.flatten() {
            let Some(pid) = p.file_name().to_str().and_then(|s| s.parse::<i32>().ok()) else { continue };
            let holds = ["fd/1", "fd/2"].iter().any(|fd| std::fs::metadata(p.path().join(fd)).is_ok_and(|m| ours.contains(&(m.dev(), m.ino()))));
            if !holds {
                continue;
            }
            let Ok(cmdline) = std::fs::read(p.path().join("cmdline")) else { continue };
            let first = String::from_utf8_lossy(cmdline.split(|b| *b == 0).next().unwrap_or_default()).to_lowercase();
            let mut parts = first.rsplit(['\\', '/']);
            let (name, parent) = (parts.next().unwrap_or_default().to_string(), parts.next().unwrap_or_default().to_string());
            if !name.is_empty() && parent == dir_name && is_file_ci(dir, &name) {
                unsafe { libc::kill(pid, libc::SIGKILL) };
                continue;
            }
            now.push((pid, first));
        }
        now.sort();
        if now == seen {
            same += 1;
            if same >= 2 {
                break;
            }
        } else {
            same = 0;
            seen = now;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

#[cfg(not(target_os = "linux"))]
fn end_own_leftovers(_program: &Path, _out: &Output) {}

/// Whether `dir` holds a file named `name`, case aside (a Windows program's name as Wine shows it).
#[cfg(target_os = "linux")]
fn is_file_ci(dir: &Path, name: &str) -> bool {
    std::fs::read_dir(dir).is_ok_and(|es| es.flatten().any(|e| e.file_name().to_string_lossy().to_lowercase() == name && e.path().is_file()))
}

/// The run's stdout and stderr files, in a folder of their own that goes with it.
struct Output {
    dir: PathBuf,
    stdout: PathBuf,
    stderr: PathBuf,
}

impl Output {
    fn new() -> std::io::Result<Output> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let stamp = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir()
            .join("w3proj-studio")
            .join(format!("run-{}-{}-{stamp}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&dir)?;
        Ok(Output { stdout: dir.join("stdout.txt"), stderr: dir.join("stderr.txt"), dir })
    }
    fn stdout_file(&self) -> Result<std::fs::File, String> {
        std::fs::File::create(&self.stdout).map_err(|e| format!("{}: {e}", self.stdout.display()))
    }
    fn stderr_file(&self) -> Result<std::fs::File, String> {
        std::fs::File::create(&self.stderr).map_err(|e| format!("{}: {e}", self.stderr.display()))
    }
    fn read(&self, f: &Path) -> String {
        String::from_utf8_lossy(&std::fs::read(f).unwrap_or_default()).into_owned()
    }
}

impl Drop for Output {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("w3proj-toolrun-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Runs `script` with sh in `cwd`, in its own thread; None when it hasn't returned within `limit`.
    fn sh(script: &str, cwd: &Path, program: Option<PathBuf>, guard: Option<Guard>, limit: Duration) -> Option<(Result<ToolResult, String>, Duration)> {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(script).current_dir(cwd);
        let (tx, rx) = mpsc::channel();
        let cwd = cwd.to_path_buf();
        std::thread::spawn(move || {
            let t = Instant::now();
            let r = run(cmd, "sh", &cwd, program.as_deref(), guard.as_ref());
            let _ = tx.send((r, t.elapsed()));
        });
        rx.recv_timeout(limit).ok()
    }

    fn alive(pid: i32) -> bool {
        // A zombie has ended too (its parent, init here, hasn't reaped it yet).
        std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|s| s.rsplit(')').next().is_some_and(|r| !r.trim_start().starts_with('Z')))
    }

    fn pid_in(file: &Path) -> i32 {
        let t = Instant::now();
        loop {
            if let Some(p) = std::fs::read_to_string(file).ok().and_then(|s| s.trim().parse().ok()) {
                return p;
            }
            assert!(t.elapsed() < Duration::from_secs(5), "no pid in {}", file.display());
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Wine's services start with the first Windows program in a prefix, inherit its stdout and stderr, and may stay for
    /// good: waiting for the end of the output waited for them, and the app hung although JassHelper had ended. They
    /// aren't the tool's own, so they're left running.
    #[test]
    fn the_tool_has_ended_when_it_exits_even_if_something_it_started_keeps_its_output_open() {
        let dir = scratch("service");
        // `setsid sleep` stands for the service: its own session, our stdout and stderr, still running.
        let (r, took) = sh("setsid sleep 20 & echo $! > service.pid; echo compiled; exit 3", &dir, None, None, Duration::from_secs(10))
            .expect("tool_run waited for a process the tool left behind, not for the tool");
        let r = r.unwrap();
        assert_eq!(r.code, 3);
        assert_eq!(r.stdout.trim(), "compiled");
        assert!(r.killed.is_none());
        assert!(took < Duration::from_secs(10), "{took:?}");
        let service = pid_in(&dir.join("service.pid"));
        assert!(alive(service), "a process that isn't the tool's own was ended");
        unsafe { libc::kill(service, libc::SIGKILL) };
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// JassHelper's error window (`jasshelper.exe --showerrors`) is started from its folder, in a session of its own, and
    /// waits for a click: it's the tool's own, and is ended once the tool has exited.
    #[test]
    fn what_the_tool_starts_from_its_folder_and_leaves_running_is_ended_after_it() {
        let dir = scratch("window");
        let tool = dir.join("tool");
        std::fs::create_dir_all(&tool).unwrap();
        // A copy of sleep in the tool's folder stands for the error window.
        let sleep = ["/bin/sleep", "/usr/bin/sleep"].into_iter().find(|p| Path::new(p).is_file()).unwrap();
        std::fs::copy(sleep, tool.join("showerrors")).unwrap();
        let program = tool.join("compiler");
        std::fs::write(&program, "").unwrap();
        let script = format!("setsid '{}' 30 & echo $! > window.pid; echo errors > errors.txt; exit 1", tool.join("showerrors").display());
        let (r, took) = sh(&script, &dir, Some(program), None, Duration::from_secs(10)).expect("waited for the error window");
        assert_eq!(r.unwrap().code, 1);
        assert!(took < Duration::from_secs(10));
        let window = pid_in(&dir.join("window.pid"));
        let t = Instant::now();
        while alive(window) && t.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
        }
        let left = alive(window);
        if left {
            unsafe { libc::kill(window, libc::SIGKILL) };
        }
        assert!(!left, "the tool's error window was left running");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The error window may still be between fork and exec when the tool exits (on a busy machine, or started through a
    /// shell): it holds the output under the shell's name for a moment. It is ended all the same.
    #[test]
    fn what_the_tool_starts_just_before_it_exits_is_ended_after_it() {
        let dir = scratch("late");
        let tool = dir.join("tool");
        std::fs::create_dir_all(&tool).unwrap();
        let sleep = ["/bin/sleep", "/usr/bin/sleep"].into_iter().find(|p| Path::new(p).is_file()).unwrap();
        std::fs::copy(sleep, tool.join("showerrors")).unwrap();
        let program = tool.join("compiler");
        std::fs::write(&program, "").unwrap();
        let script = format!("setsid sh -c 'sleep 0.15; exec \"{}\" 30' & echo $! > window.pid; exit 1", tool.join("showerrors").display());
        let (r, _) = sh(&script, &dir, Some(program), None, Duration::from_secs(10)).expect("waited for the error window");
        assert_eq!(r.unwrap().code, 1);
        let window = pid_in(&dir.join("window.pid"));
        let t = Instant::now();
        while alive(window) && t.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(20));
        }
        let left = alive(window);
        if left {
            unsafe { libc::kill(window, libc::SIGKILL) };
        }
        assert!(!left, "the error window started just before the tool exited was left running");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A tool that never exits and does nothing is ended after the time without progress, with what it started.
    #[test]
    fn a_tool_that_hangs_without_progress_is_ended_with_its_children() {
        let dir = scratch("hang");
        let guard = Guard { idle_ms: 1500, result_files: vec!["output.j".into()], settle_ms: 500 };
        let (r, took) = sh("sleep 60 & echo $! > child.pid; echo started; wait", &dir, None, Some(guard), Duration::from_secs(20))
            .expect("a tool that never exits wasn't ended");
        let r = r.unwrap();
        assert_eq!(r.code, -1);
        assert!(r.killed.as_deref().is_some_and(|k| k.contains("nothing happened")), "{:?}", r.killed);
        assert_eq!(r.stdout.trim(), "started");
        assert!(took >= Duration::from_millis(1500) && took < Duration::from_secs(10), "{took:?}");
        let child = pid_in(&dir.join("child.pid"));
        std::thread::sleep(Duration::from_millis(200));
        assert!(!alive(child), "the hung tool's child was left running");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Progress keeps a slow tool going past the time without progress; its result there and no exit ends it soon after.
    #[test]
    fn a_tool_making_progress_runs_on_and_one_that_wrote_its_result_but_doesnt_exit_is_ended() {
        let dir = scratch("result");
        let guard = Guard { idle_ms: 1500, result_files: vec!["output.j".into(), "logs/compileerrors.txt".into()], settle_ms: 1000 };
        // 3 s of work in steps of 0.5 s (twice the time without progress), then the result, then no exit.
        let script = "mkdir logs; for i in 1 2 3 4 5 6; do echo $i >> logs/step.txt; sleep 0.5; done; echo done > output.j; exec sleep 60";
        let (r, took) = sh(script, &dir, None, Some(guard), Duration::from_secs(20)).expect("a tool that wrote its result but didn't exit wasn't ended");
        let r = r.unwrap();
        assert!(r.killed.as_deref().is_some_and(|k| k.contains("wrote output.j")), "{:?}", r.killed);
        assert!(took >= Duration::from_secs(3) && took < Duration::from_secs(10), "{took:?}");
        assert_eq!(std::fs::read_to_string(dir.join("output.j")).unwrap().trim(), "done");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The normal path is untouched: output and exit code, quickly, nothing ended.
    #[test]
    fn a_tool_that_exits_gives_its_output_and_code() {
        let dir = scratch("plain");
        let guard = Guard { idle_ms: 5000, result_files: vec![], settle_ms: 3000 };
        let (r, took) = sh("echo out; echo err >&2; exit 0", &dir, None, Some(guard), Duration::from_secs(10)).unwrap();
        let r = r.unwrap();
        assert_eq!((r.code, r.stdout.trim(), r.stderr.trim(), r.killed.is_none()), (0, "out", "err", true));
        assert!(took < Duration::from_secs(2), "{took:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

/// The same cases on Windows, where the tool and what it starts are in a job that is closed (and so ended) with it
/// (job.rs). PowerShell stands for the tool; `ping -n 60` for what it starts and leaves running.
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::sync::mpsc;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("w3proj-toolrun-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Runs `script` with PowerShell in `cwd`, in its own thread; None when it hasn't returned within `limit`.
    fn ps(script: &str, cwd: &Path, guard: Option<Guard>, limit: Duration) -> Option<(Result<ToolResult, String>, Duration)> {
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]).current_dir(cwd);
        let (tx, rx) = mpsc::channel();
        let cwd = cwd.to_path_buf();
        std::thread::spawn(move || {
            let t = Instant::now();
            let r = run(cmd, "powershell", &cwd, None, guard.as_ref());
            let _ = tx.send((r, t.elapsed()));
        });
        rx.recv_timeout(limit).ok()
    }

    fn alive(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        // SAFETY: plain calls on a process id; the handle is closed.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(h, &mut code) != 0;
            CloseHandle(h);
            ok && code == 259 // STILL_ACTIVE
        }
    }

    fn pid_in(file: &Path) -> u32 {
        let t = Instant::now();
        loop {
            if let Some(p) = std::fs::read_to_string(file).ok().and_then(|s| s.trim().parse().ok()) {
                return p;
            }
            assert!(t.elapsed() < Duration::from_secs(10), "no pid in {}", file.display());
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Waits up to `limit` for the process to be gone; ends it if it isn't, and says whether it had gone by itself.
    fn gone_within(pid: u32, limit: Duration) -> bool {
        let t = Instant::now();
        while alive(pid) && t.elapsed() < limit {
            std::thread::sleep(Duration::from_millis(20));
        }
        let left = alive(pid);
        if left {
            let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).output();
        }
        !left
    }

    /// Starts `ping -n 60` hidden and writes its id to child.pid (PowerShell).
    const START_CHILD: &str = "$c = Start-Process ping -ArgumentList '-n','60','127.0.0.1' -WindowStyle Hidden -PassThru; Set-Content child.pid $c.Id";

    #[test]
    fn a_tool_that_exits_gives_its_output_and_code() {
        let dir = scratch("plain");
        let guard = Guard { idle_ms: 10000, result_files: vec![], settle_ms: 3000 };
        let (r, _) = ps("Write-Output out; [Console]::Error.WriteLine('err'); exit 3", &dir, Some(guard), Duration::from_secs(30)).unwrap();
        let r = r.unwrap();
        assert_eq!((r.code, r.stdout.trim(), r.stderr.trim(), r.killed.is_none()), (3, "out", "err", true));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// JassHelper's error window: started by the tool and left waiting for a click. Ended once the tool has exited.
    #[test]
    fn what_the_tool_starts_and_leaves_running_is_ended_after_it() {
        let dir = scratch("window");
        let (r, _) = ps(&format!("{START_CHILD}; Write-Output errors; exit 1"), &dir, None, Duration::from_secs(30)).expect("waited for what the tool left running");
        assert_eq!(r.unwrap().code, 1);
        let child = pid_in(&dir.join("child.pid"));
        assert!(gone_within(child, Duration::from_secs(5)), "what the tool started was left running");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A tool that never exits and does nothing is ended after the time without progress, with what it started.
    #[test]
    fn a_tool_that_hangs_without_progress_is_ended_with_its_children() {
        let dir = scratch("hang");
        let guard = Guard { idle_ms: 3000, result_files: vec!["output.j".into()], settle_ms: 500 };
        let (r, took) = ps(&format!("{START_CHILD}; Write-Output started; Start-Sleep 60"), &dir, Some(guard), Duration::from_secs(40))
            .expect("a tool that never exits wasn't ended");
        let r = r.unwrap();
        assert_eq!(r.code, -1);
        assert!(r.killed.as_deref().is_some_and(|k| k.contains("nothing happened")), "{:?}", r.killed);
        assert_eq!(r.stdout.trim(), "started");
        assert!(took >= Duration::from_millis(3000) && took < Duration::from_secs(30), "{took:?}");
        let child = pid_in(&dir.join("child.pid"));
        assert!(gone_within(child, Duration::from_secs(3)), "the hung tool's child was left running");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Progress keeps a slow tool going past the time without progress; its result there and no exit ends it soon after.
    #[test]
    fn a_tool_making_progress_runs_on_and_one_that_wrote_its_result_but_doesnt_exit_is_ended() {
        let dir = scratch("result");
        let guard = Guard { idle_ms: 3000, result_files: vec!["output.j".into(), "logs/compileerrors.txt".into()], settle_ms: 1000 };
        // 4 s of work in steps of 0.5 s (longer than the time without progress), then the result, then no exit.
        let script = "New-Item -ItemType Directory logs | Out-Null; 1..8 | ForEach-Object { Add-Content logs/step.txt $_; Start-Sleep -Milliseconds 500 }; Set-Content output.j done; Start-Sleep 60";
        let (r, took) = ps(script, &dir, Some(guard), Duration::from_secs(40)).expect("a tool that wrote its result but didn't exit wasn't ended");
        let r = r.unwrap();
        assert!(r.killed.as_deref().is_some_and(|k| k.contains("wrote output.j")), "{:?}", r.killed);
        assert!(took >= Duration::from_secs(4) && took < Duration::from_secs(30), "{took:?}");
        assert_eq!(std::fs::read_to_string(dir.join("output.j")).unwrap().trim(), "done");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
