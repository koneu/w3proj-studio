//! Windows programs on Linux (the game, the World Editor, JassHelper) are started through Steam's Proton,
//! the way Steam starts them: the Proton build Steam uses for that game, in the game's own Steam prefix,
//! with Steam's environment. Steam can't pass arguments (`-loadfile <map>`) to a game it starts itself, so
//! the app runs `proton runinprefix <exe> <args>` with the same build and prefix instead (see `command`).
//!
//! An install in a Steam prefix sits at `<steam>/steamapps/compatdata/<app id>/pfx/drive_c/…`. Steam writes
//! the Proton build it last used into `<compatdata>/<app id>/config_info`: its second line is a path inside
//! that build (`<tool>/files/share/fonts/`).

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, PartialEq)]
pub struct Proton {
    /// The Proton build's folder (holds the `proton` script).
    pub tool: PathBuf,
    /// `<steam>/steamapps/compatdata/<app id>`.
    pub compat_data: PathBuf,
    /// Steam's own folder (`<steam>`).
    pub steam_root: PathBuf,
    pub app_id: String,
}

/// Whether a program is a Windows one (started through Proton on Linux).
pub fn is_windows_program(exe: &Path) -> bool {
    exe.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"))
}

/// The Steam prefix a path is in, and the Proton build Steam uses for it; None outside a Steam prefix.
pub fn proton_for(exe: &Path) -> Result<Proton, String> {
    let pfx = exe
        .ancestors()
        .find(|a| a.file_name().is_some_and(|n| n == "pfx") && a.parent().and_then(Path::parent).and_then(Path::file_name).is_some_and(|n| n == "compatdata"))
        .ok_or_else(|| format!("{} is a Windows program, and on Linux it's started through Steam (Proton), but it isn't in a Steam prefix (…/steamapps/compatdata/<id>/pfx/…). Add the game to Steam and run it there once.", exe.display()))?;
    let odd = || format!("{} isn't laid out like a Steam prefix (…/steamapps/compatdata/<id>/pfx/…).", exe.display());
    let compat_data = pfx.parent().ok_or_else(odd)?.to_path_buf();
    let app_id = compat_data.file_name().ok_or_else(odd)?.to_string_lossy().into_owned();
    let library = compat_data.parent().and_then(Path::parent).and_then(Path::parent).ok_or_else(odd)?;
    let steam_root = steam_root_for(library, std::env::var_os("HOME").map(PathBuf::from).as_deref());
    let info = std::fs::read_to_string(compat_data.join("config_info"))
        .map_err(|_| format!("Steam hasn't run the game in {} yet (no config_info), so it isn't known which Proton to use. Start it from Steam once.", compat_data.display()))?;
    let tool = tool_from_config_info(&info)
        .filter(|t| t.join("proton").is_file())
        .ok_or_else(|| format!("The Proton build Steam used for {} isn't there any more (see its config_info). Start the game from Steam once, so Steam sets it up again.", compat_data.display()))?;
    Ok(Proton { tool, compat_data, steam_root, app_id })
}

/// Steam's own folder (STEAM_COMPAT_CLIENT_INSTALL_PATH). The library a prefix is in is Steam's own folder only
/// for the first library; a game in a further library (another drive) has its prefix there, so Steam's folder
/// comes from `~/.steam/root`, the link Steam keeps to itself. A library with Steam's own files is Steam's folder.
pub fn steam_root_for(library: &Path, home: Option<&Path>) -> PathBuf {
    let is_steam = |p: &Path| p.join("steam.sh").is_file() || p.join("ubuntu12_32").is_dir();
    if is_steam(library) {
        return library.to_path_buf();
    }
    home.map(|h| h.join(".steam").join("root"))
        .and_then(|link| std::fs::canonicalize(link).ok())
        .filter(|p| is_steam(p))
        .unwrap_or_else(|| library.to_path_buf())
}

/// The Proton build's folder, from a config_info: the first line naming a path inside it (`…/files/…` or,
/// in older builds, `…/dist/…`).
pub fn tool_from_config_info(info: &str) -> Option<PathBuf> {
    info.lines().find_map(|l| {
        let l = l.trim();
        ["/files/", "/dist/"].iter().find_map(|seg| l.find(seg).map(|i| PathBuf::from(&l[..i])))
    })
}

/// A Linux path as the Windows program sees it: Wine maps the whole file system to `Z:`.
pub fn wine_path(p: &str) -> String {
    if p.starts_with('/') { format!("Z:{}", p.replace('/', "\\")) } else { p.to_string() }
}

/// `proton runinprefix <exe> <args>`, with the environment Steam gives the game.
///
/// Not `proton run`: that starts the program through Proton's own steam.exe, which after the program has ended
/// keeps waiting until no other (non-system) Windows program runs in the prefix's wineserver. The game's prefix
/// usually has the user's Battle.net and its Agent running, so every `proton run` and its steam.exe stayed until
/// Battle.net was closed (seen 2026-11-08: four games and two World Editors, hours after their windows closed),
/// and Studio never heard that the World Editor had ended. `runinprefix` runs the program with Wine directly, in
/// the same prefix and environment, and ends with it. It also leaves the prefix's files alone (no prefix
/// update), which `run` would do in the user's prefix; Steam has set the prefix up (proton_for needs its config_info).
/// Nothing else in the prefix is touched: no `wineserver -k`, which would end the user's other programs there.
pub fn command(proton: &Proton, exe: &Path, args: &[String]) -> Command {
    let mut cmd = Command::new(proton.tool.join("proton"));
    cmd.arg("runinprefix").arg(exe).args(args);
    cmd.env("STEAM_COMPAT_DATA_PATH", &proton.compat_data)
        .env("STEAM_COMPAT_CLIENT_INSTALL_PATH", &proton.steam_root)
        .env("SteamAppId", &proton.app_id)
        .env("SteamGameId", &proton.app_id);
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    cmd
}

/// What is left of a prefix's Wine processes after a program of ours has ended, and whether that is only Wine's own
/// services. Wine's services (`wineserver`, `services.exe`, `winedevice.exe`, `plugplay.exe`, `svchost.exe`,
/// `rpcss.exe`, `explorer.exe`) stay as long as something holds them; when nothing but them is left the
/// server is a leak (seen 2026-11-15: a wineserver and two winedevice.exe 13 hours after the run that started
/// them was killed by `timeout`). Anything else in the prefix (the user's Battle.net, a game, a World Editor) is
/// a program that may be using the server. `cmdlines` are the NUL-separated command lines of the processes whose
/// WINEPREFIX is the prefix.
#[cfg(any(unix, test))]
fn only_wine_services_left(cmdlines: &[Vec<u8>]) -> bool {
    const SERVICES: [&str; 8] = ["wineserver", "services.exe", "winedevice.exe", "plugplay.exe", "svchost.exe", "rpcss.exe", "explorer.exe", "conhost.exe"];
    !cmdlines.is_empty()
        && cmdlines.iter().all(|c| {
            let args: Vec<String> = c.split(|b| *b == 0).filter(|a| !a.is_empty()).map(|a| String::from_utf8_lossy(a).to_lowercase()).collect();
            let name = |a: &String| a.rsplit(['\\', '/']).next().unwrap_or_default().to_string();
            // `explorer.exe /desktop` is the prefix's desktop; an explorer window of the user's is another command line.
            let first = args.first().map(name).unwrap_or_default();
            SERVICES.contains(&first.as_str()) && (first != "explorer.exe" || args.get(1).is_some_and(|a| a.starts_with("/desktop")))
        })
}

/// `end_idle_server` for the prefix of `exe`, if it is a Windows program in a Steam prefix; else nothing happens.
#[cfg(unix)]
pub fn end_idle_server_of(exe: &Path) -> bool {
    is_windows_program(exe) && proton_for(exe).is_ok_and(|p| end_idle_server(&p))
}

/// For a program that Studio starts and doesn't wait on (the World Editor, the game): a thread waits for `child` to
/// end, then ends the prefix's idle server as `tool_run` does. Returns the thread (the tests join it).
#[cfg(unix)]
pub fn end_idle_server_after(exe: PathBuf, mut child: std::process::Child) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let _ = child.wait();
        end_idle_server_of(&exe);
    })
}

/// After a Windows program of ours has ended (also ended by a guard or a timeout): if nothing but Wine's own services
/// is left in its prefix, stops that prefix's server with the build's `wineserver -k`, so it doesn't stay for good.
/// If any other program runs in the prefix (the user's Battle.net, the game), nothing is touched: the prefix is the
/// user's and shared (README), and `-k` would end those. Returns whether it stopped the server.
#[cfg(unix)]
pub fn end_idle_server(proton: &Proton) -> bool {
    let prefix = proton.compat_data.join("pfx");
    let server = proton.tool.join("files/bin/wineserver");
    if !server.is_file() {
        return false;
    }
    // Wine's services take a moment to go after the last program; a program of ours that ended just now may still
    // be seen. Look twice, a short while apart, and act only when both looks agree it is just services.
    for look in 0..2 {
        if look > 0 {
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
        let left = prefix_cmdlines(&prefix);
        if left.is_empty() {
            return false;
        }
        if !only_wine_services_left(&left) {
            return false;
        }
    }
    let mut cmd = Command::new(&server);
    cmd.arg("-k").env("WINEPREFIX", &prefix).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let Ok(mut child) = cmd.spawn() else { return false };
    // Bounded: `-k` normally returns at once.
    let t = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(s)) => return s.success(),
            Ok(None) if t.elapsed() < std::time::Duration::from_secs(10) => std::thread::sleep(std::time::Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// The command lines of the processes (of this user) whose WINEPREFIX is `prefix`.
#[cfg(unix)]
fn prefix_cmdlines(prefix: &Path) -> Vec<Vec<u8>> {
    let Ok(procs) = std::fs::read_dir("/proc") else { return Vec::new() };
    let mut found = Vec::new();
    for p in procs.flatten() {
        if !p.file_name().to_str().is_some_and(|s| s.bytes().all(|b| b.is_ascii_digit())) {
            continue;
        }
        let (Ok(environ), Ok(cmdline)) = (std::fs::read(p.path().join("environ")), std::fs::read(p.path().join("cmdline"))) else { continue };
        let ours = environ
            .split(|b| *b == 0)
            .find_map(|e| e.strip_prefix(b"WINEPREFIX="))
            .is_some_and(|v| Path::new(String::from_utf8_lossy(v).trim_end_matches('/')) == prefix);
        if ours && !cmdline.is_empty() {
            found.push(cmdline);
        }
    }
    found
}

/// Ends Wine's desktop process (`explorer.exe /desktop`) of `proton`'s prefix when the X display it was started on is
/// gone. The first Windows program in a prefix starts it on that program's display, and every later program in the
/// prefix waits on it; when that display has ended (a hidden Xvfb of a smoke run or tester app that stopped, while
/// another app on another display uses the same prefix), the desktop stays but every later program hangs or exits
/// having done nothing (JassHelper, 2026-11-14: "nothing happened for 60 s", or exit code 0 and no output). With it
/// ended, the next program starts a new one on its own display. A desktop on a display that is there (the user's
/// screen) is never touched.
#[cfg(target_os = "linux")]
pub fn end_stale_desktops(proton: &Proton) {
    let prefix = proton.compat_data.join("pfx");
    let x11 = Path::new("/tmp/.X11-unix");
    let Ok(procs) = std::fs::read_dir("/proc") else { return };
    for p in procs.flatten() {
        let Some(pid) = p.file_name().to_str().and_then(|s| s.parse::<i32>().ok()) else { continue };
        let (Ok(cmdline), Ok(environ)) = (std::fs::read(p.path().join("cmdline")), std::fs::read(p.path().join("environ"))) else { continue };
        if is_stale_desktop(&cmdline, &environ, &prefix, x11) {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
}

/// Whether a process (its NUL-separated command line and environment) is the Wine desktop of `prefix` on an X
/// display whose socket isn't in `x11` (/tmp/.X11-unix) any more.
#[cfg(any(target_os = "linux", test))]
fn is_stale_desktop(cmdline: &[u8], environ: &[u8], prefix: &Path, x11: &Path) -> bool {
    let args: Vec<String> = cmdline.split(|b| *b == 0).map(|a| String::from_utf8_lossy(a).to_lowercase()).collect();
    let is_desktop = args.first().is_some_and(|a| a.rsplit(['\\', '/']).next() == Some("explorer.exe")) && args.iter().skip(1).any(|a| a.starts_with("/desktop"));
    if !is_desktop {
        return false;
    }
    let var = |name: &str| environ.split(|b| *b == 0).find_map(|e| e.strip_prefix(format!("{name}=").as_bytes()).map(|v| String::from_utf8_lossy(v).into_owned()));
    let Some(wine_prefix) = var("WINEPREFIX") else { return false };
    if Path::new(wine_prefix.trim_end_matches('/')) != prefix {
        return false;
    }
    var("DISPLAY").is_some_and(|d| display_gone(&d, x11))
}

/// Whether a local X display (`:N`, `:N.S`, `unix:N`) has no socket in `x11`; a display on another host is never gone.
#[cfg(any(target_os = "linux", test))]
fn display_gone(display: &str, x11: &Path) -> bool {
    let local = display.strip_prefix("unix").unwrap_or(display);
    let Some(number) = local.strip_prefix(':').map(|n| n.split('.').next().unwrap_or_default()) else { return false };
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    !x11.join(format!("X{number}")).exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A desktop is stale only when it is the prefix's explorer.exe /desktop and its local display's socket is gone.
    #[test]
    fn only_the_prefixs_desktop_on_a_display_that_is_gone_is_stale() {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let x11 = std::env::temp_dir().join(format!("w3proj-x11-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&x11);
        std::fs::create_dir_all(&x11).unwrap();
        std::fs::write(x11.join("X0"), "").unwrap();
        let prefix = Path::new("/steam/steamapps/compatdata/1/pfx");
        let desktop = b"C:\\windows\\system32\\explorer.exe\0/desktop\0";
        let env = |display: &str, pfx: &str| format!("HOME=/h\0WINEPREFIX={pfx}\0DISPLAY={display}\0").into_bytes();
        assert!(is_stale_desktop(desktop, &env(":101", "/steam/steamapps/compatdata/1/pfx/"), prefix, &x11));
        assert!(is_stale_desktop(desktop, &env(":101.0", "/steam/steamapps/compatdata/1/pfx"), prefix, &x11));
        // The control: the same on a display that is there (the user's screen).
        assert!(!is_stale_desktop(desktop, &env(":0", "/steam/steamapps/compatdata/1/pfx/"), prefix, &x11));
        assert!(!is_stale_desktop(desktop, &env(":0.0", "/steam/steamapps/compatdata/1/pfx/"), prefix, &x11));
        // Another prefix's, another program, a remote display, none.
        assert!(!is_stale_desktop(desktop, &env(":101", "/steam/steamapps/compatdata/2/pfx/"), prefix, &x11));
        assert!(!is_stale_desktop(b"C:\\windows\\system32\\explorer.exe\0", &env(":101", "/steam/steamapps/compatdata/1/pfx/"), prefix, &x11));
        assert!(!is_stale_desktop(b"C:\\windows\\system32\\services.exe\0", &env(":101", "/steam/steamapps/compatdata/1/pfx/"), prefix, &x11));
        assert!(!is_stale_desktop(desktop, &env("otherhost:10.0", "/steam/steamapps/compatdata/1/pfx/"), prefix, &x11));
        assert!(!is_stale_desktop(desktop, b"WINEPREFIX=/steam/steamapps/compatdata/1/pfx\0", prefix, &x11));
        assert!(!is_stale_desktop(desktop, &env(":", "/steam/steamapps/compatdata/1/pfx/"), prefix, &x11));
        let _ = std::fs::remove_dir_all(&x11);
    }

    #[test]
    fn a_prefix_with_only_wines_services_left_is_idle_and_one_with_any_program_is_not() {
        let c = |s: &str| s.replace('|', "\0").into_bytes();
        let services = vec![c("/p/files/bin/wineserver|-f"), c("C:\\windows\\system32\\winedevice.exe|"), c("C:\\windows\\system32\\services.exe|"), c("C:\\windows\\system32\\explorer.exe|/desktop")];
        assert!(only_wine_services_left(&services));
        // The controls: a program of the user's, an explorer window, nothing seen at all.
        let mut with_game = services.clone();
        with_game.push(c("Z:\\g\\Battle.net.exe|"));
        assert!(!only_wine_services_left(&with_game));
        let mut with_window = services.clone();
        with_window.push(c("C:\\windows\\system32\\explorer.exe|C:\\users"));
        assert!(!only_wine_services_left(&with_window));
        assert!(!only_wine_services_left(&[]));
    }

    /// A fake wineserver: `-k` records that it was asked, with which WINEPREFIX; a fake service in the prefix
    /// (a process with WINEPREFIX set, named wineserver) stands for the leftover. Nothing of the machine's is touched.
    #[cfg(unix)]
    #[test]
    fn an_idle_server_is_stopped_with_the_builds_wineserver_and_a_busy_one_is_left() {
        use std::os::unix::fs::PermissionsExt;
        // One at a time: a program started in one test while the other one has just written a file to run holds that
        // file open for a moment (a forked child before its exec), which makes the other's start fail "Text file busy".
        let _one_at_a_time = EXEC_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let (root, exe) = steam();
        let p = proton_for(&exe).unwrap();
        let bin = p.tool.join("files/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let log = root.join("k.log");
        let server = bin.join("wineserver");
        std::fs::write(&server, format!("#!/bin/sh\necho \"$1 $WINEPREFIX\" >> '{}'\n", log.display())).unwrap();
        std::fs::set_permissions(&server, std::fs::Permissions::from_mode(0o755)).unwrap();
        let prefix = p.compat_data.join("pfx");
        // No Wine process in the prefix: nothing to stop, and `-k` is not run.
        assert!(!end_idle_server(&p));
        assert!(!log.exists());
        // A leftover service: a copy of sleep named wineserver, started with the prefix.
        let sleep = ["/bin/sleep", "/usr/bin/sleep"].into_iter().find(|f| Path::new(f).is_file()).unwrap();
        let fake = root.join("wineserver");
        std::fs::copy(sleep, &fake).unwrap();
        let mut service = Command::new(&fake).arg("30").env("WINEPREFIX", &prefix).spawn().unwrap();
        assert!(end_idle_server(&p), "an idle server was left");
        assert_eq!(std::fs::read_to_string(&log).unwrap().trim(), format!("-k {}", prefix.display()));
        // The control: with a program of the user's in the prefix, `-k` isn't run again.
        let game = root.join("Battle.net.exe");
        std::fs::copy(sleep, &game).unwrap();
        let mut busy = Command::new(&game).arg("30").env("WINEPREFIX", &prefix).spawn().unwrap();
        assert!(!end_idle_server(&p));
        assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 1, "a busy prefix's server was ended");
        let _ = service.kill();
        let _ = busy.kill();
        let _ = service.wait();
        let _ = busy.wait();
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A program started and not waited on (the game): when it ends, the leftover server is stopped; not before.
    #[cfg(unix)]
    #[test]
    fn the_server_is_ended_after_a_program_that_isnt_waited_on_exits() {
        use std::os::unix::fs::PermissionsExt;
        // One at a time: a program started in one test while the other one has just written a file to run holds that
        // file open for a moment (a forked child before its exec), which makes the other's start fail "Text file busy".
        let _one_at_a_time = EXEC_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let (root, exe) = steam();
        let p = proton_for(&exe).unwrap();
        let bin = p.tool.join("files/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let log = root.join("k.log");
        let server = bin.join("wineserver");
        std::fs::write(&server, format!("#!/bin/sh\necho \"$1 $WINEPREFIX\" >> '{}'\n", log.display())).unwrap();
        std::fs::set_permissions(&server, std::fs::Permissions::from_mode(0o755)).unwrap();
        let prefix = p.compat_data.join("pfx");
        let sleep = ["/bin/sleep", "/usr/bin/sleep"].into_iter().find(|f| Path::new(f).is_file()).unwrap();
        let fake = root.join("wineserver");
        std::fs::copy(sleep, &fake).unwrap();
        let mut service = Command::new(&fake).arg("30").env("WINEPREFIX", &prefix).spawn().unwrap();
        let child = Command::new(sleep).arg("1").spawn().unwrap();
        let waiting = end_idle_server_after(exe.clone(), child);
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!log.exists(), "the server was ended while the program ran");
        waiting.join().unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap().trim(), format!("-k {}", prefix.display()));
        let _ = service.kill();
        let _ = service.wait();
        std::fs::remove_dir_all(&root).unwrap();
    }

    static EXEC_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    /// A Steam folder with one prefix (app id 4104009084) holding the game, and a Proton build.
    fn steam() -> (PathBuf, PathBuf) {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("w3proj-proton-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("steam.sh"), "").unwrap();
        let tool = root.join("compatibilitytools.d/Proton-GE Latest");
        std::fs::create_dir_all(tool.join("files/share/fonts")).unwrap();
        std::fs::write(tool.join("proton"), "#!/bin/sh\n").unwrap();
        let data = root.join("steamapps/compatdata/4104009084");
        let bin = data.join("pfx/drive_c/Program Files (x86)/Warcraft III/_retail_/x86_64");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(data.join("config_info"), format!("GE-Proton11-7\n{}/files/share/fonts/\n{}/files/lib/\n", tool.display(), tool.display())).unwrap();
        (root, bin.join("World Editor.exe"))
    }

    #[test]
    fn the_prefix_and_proton_build_come_from_the_path_and_config_info() {
        let (root, exe) = steam();
        let p = proton_for(&exe).unwrap();
        assert_eq!(p.app_id, "4104009084");
        assert_eq!(p.compat_data, root.join("steamapps/compatdata/4104009084"));
        assert_eq!(p.steam_root, root);
        assert_eq!(p.tool, root.join("compatibilitytools.d/Proton-GE Latest"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn outside_a_steam_prefix_or_without_its_proton_it_says_why() {
        assert!(proton_for(Path::new("/home/u/Games/battlenet/drive_c/Warcraft III/x.exe")).unwrap_err().contains("isn't in a Steam prefix"));
        let (root, exe) = steam();
        std::fs::remove_file(root.join("compatibilitytools.d/Proton-GE Latest/proton")).unwrap();
        assert!(proton_for(&exe).unwrap_err().contains("isn't there any more"));
        std::fs::remove_file(root.join("steamapps/compatdata/4104009084/config_info")).unwrap();
        assert!(proton_for(&exe).unwrap_err().contains("no config_info"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_game_in_a_second_library_gets_steams_own_folder_from_the_steam_root_link() {
        let (root, _) = steam();
        let home = root.join("home");
        std::fs::create_dir_all(home.join(".steam")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&root, home.join(".steam/root")).unwrap();
        let library = root.join("other-drive/SteamLibrary");
        std::fs::create_dir_all(&library).unwrap();
        #[cfg(unix)]
        assert_eq!(steam_root_for(&library, Some(&home)), std::fs::canonicalize(&root).unwrap());
        assert_eq!(steam_root_for(&root, Some(&home)), root, "the first library is Steam's folder itself");
        assert_eq!(steam_root_for(&library, None), library, "nothing better known: the library");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_path_without_a_folder_above_steamapps_is_an_error_not_a_crash() {
        assert!(proton_for(Path::new("/compatdata/1/pfx/x.exe")).is_err());
    }

    #[test]
    fn config_info_names_the_build_by_a_path_inside_it() {
        assert_eq!(tool_from_config_info("GE-Proton11-7\n/s/compatibilitytools.d/GE/files/share/fonts/\n"), Some(PathBuf::from("/s/compatibilitytools.d/GE")));
        assert_eq!(tool_from_config_info("5.0\n/s/steamapps/common/Proton 5.0/dist/share/fonts/\n"), Some(PathBuf::from("/s/steamapps/common/Proton 5.0")));
        assert_eq!(tool_from_config_info("nothing here\n"), None);
    }

    #[test]
    fn linux_paths_reach_the_windows_program_as_z_drive_paths() {
        assert_eq!(wine_path("/home/u/maps/a b.w3x"), r"Z:\home\u\maps\a b.w3x");
        assert_eq!(wine_path("input.j"), "input.j");
        assert_eq!(wine_path("-launch"), "-launch");
    }

    /// `runinprefix`, not `run`: `run`'s steam.exe outlives the program while the user's Battle.net runs in the prefix.
    #[test]
    fn the_command_is_proton_runinprefix_with_steams_environment() {
        let (root, exe) = steam();
        let p = proton_for(&exe).unwrap();
        let cmd = command(&p, &exe, &["-launch".into(), "-loadfile".into(), wine_path("/m/a.w3x")]);
        assert_eq!(cmd.get_program(), p.tool.join("proton").as_os_str());
        let args: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["runinprefix".to_string(), exe.to_string_lossy().into_owned(), "-launch".into(), "-loadfile".into(), r"Z:\m\a.w3x".into()]);
        let env: std::collections::HashMap<_, _> = cmd.get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.unwrap().to_string_lossy().into_owned())).collect();
        assert_eq!(env["STEAM_COMPAT_DATA_PATH"], root.join("steamapps/compatdata/4104009084").to_string_lossy());
        assert_eq!(env["STEAM_COMPAT_CLIENT_INSTALL_PATH"], root.to_string_lossy());
        assert_eq!(env["SteamAppId"], "4104009084");
        assert_eq!(cmd.get_current_dir(), exe.parent());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
