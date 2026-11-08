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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

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
