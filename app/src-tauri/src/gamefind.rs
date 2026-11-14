//! Warcraft III installs in the usual places, for the first start (and whenever the configured folder
//! doesn't open): on Windows where Battle.net registered it and the usual folders of every fixed drive, on
//! Linux the Wine prefixes of Steam (Proton), Lutris and plain Wine. Only each install's `.build.info` is
//! read, for its build; the storage isn't opened.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct FoundGame {
    pub path: String,
    /// The build from `.build.info` ("3.0.1.24371"), or empty when it couldn't be read.
    pub version: String,
}

/// The build in a `.build.info`: a `|`-separated table whose header names a `Version!…` column.
pub fn build_version(text: &str) -> Option<String> {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let header = lines.next()?;
    let col = header.split('|').position(|h| h.starts_with("Version!"))?;
    lines.find_map(|l| l.split('|').nth(col).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string))
}

/// Compares builds part by part as numbers ("3.0.1.24371" > "2.0.10.1" > "2.0.2.22796"); unreadable last.
pub fn newer_first(a: &FoundGame, b: &FoundGame) -> std::cmp::Ordering {
    let parts = |v: &str| v.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    match (a.version.is_empty(), b.version.is_empty()) {
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        _ => parts(&b.version).cmp(&parts(&a.version)).then_with(|| a.path.cmp(&b.path)),
    }
}

const WC3: &str = "Warcraft III";

/// The game's names as Battle.net installs and registers it: the game and its public test realm.
#[cfg_attr(not(windows), allow(dead_code))]
const WINDOWS_NAMES: [&str; 2] = [WC3, "Warcraft III Public Test"];

/// The folders that may hold the game on Windows, in this order: where Battle.net says it installed it (`registered`,
/// from its entry among the installed programs, wherever that is), the Program Files folders (`program_files`), then
/// the usual places on each fixed drive (`drives`, their roots): Program Files (x86), Program Files, the root, Games.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_candidates(registered: &[PathBuf], program_files: &[PathBuf], drives: &[PathBuf]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = registered.to_vec();
    for name in WINDOWS_NAMES {
        out.extend(program_files.iter().map(|p| p.join(name)));
        for d in drives {
            for parent in [d.join("Program Files (x86)"), d.join("Program Files"), d.clone(), d.join("Games")] {
                out.push(parent.join(name));
            }
        }
    }
    out
}

/// Where Battle.net installed the game (Windows): the InstallLocation of its uninstall entries, machine-wide (both
/// registry views) and the user's own.
#[cfg(windows)]
fn registered_installs() -> Vec<PathBuf> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let mut out = Vec::new();
    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        for view in [r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall", r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"] {
            for name in WINDOWS_NAMES {
                let key = wide(&format!(r"{view}\{name}"));
                let value = wide("InstallLocation");
                let mut buf = vec![0u16; 1024];
                let mut len = (buf.len() * 2) as u32;
                // SAFETY: the key and value names are NUL-terminated, and `len` is the buffer's size in bytes.
                let r = unsafe { RegGetValueW(root, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut len) };
                if r == 0 {
                    let n = (len as usize / 2).saturating_sub(1).min(buf.len());
                    let s = String::from_utf16_lossy(&buf[..n]);
                    let s = s.trim_end_matches('\0').trim();
                    if !s.is_empty() {
                        out.push(PathBuf::from(s));
                    }
                }
            }
        }
    }
    out
}

/// The roots of the fixed drives (Windows): no network, removable or optical drives, which can keep a look slow.
#[cfg(windows)]
fn fixed_drives() -> Vec<PathBuf> {
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    const DRIVE_FIXED: u32 = 3;
    // SAFETY: no arguments; the answer is a bit mask of drive letters.
    let mask = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| format!("{}:\\", (b'A' + i) as char))
        .filter(|root| {
            let w: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: a NUL-terminated root path.
            unsafe { GetDriveTypeW(w.as_ptr()) == DRIVE_FIXED }
        })
        .map(PathBuf::from)
        .collect()
}

/// The folders that may hold the game: on Windows (the home folder isn't used), else in this home folder's Wine prefixes.
#[cfg(windows)]
fn candidates(_home: Option<&Path>) -> Vec<PathBuf> {
    let program_files: Vec<PathBuf> = ["ProgramFiles(x86)", "ProgramFiles"].iter().filter_map(|v| std::env::var(v).ok()).map(PathBuf::from).collect();
    windows_candidates(&registered_installs(), &program_files, &fixed_drives())
}

#[cfg(not(windows))]
fn candidates(home: Option<&Path>) -> Vec<PathBuf> {
    prefix_candidates(home)
}

/// The game's folder in the Wine prefixes of this home folder: Steam (Proton, every library), Lutris, plain Wine.
#[cfg_attr(windows, allow(dead_code))]
fn prefix_candidates(home: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Some(home) = home else { return out };
    let in_prefix = |prefix: &Path| prefix.join("drive_c").join("Program Files (x86)").join(WC3);

    // Steam: its own folder in its usual places, and further libraries listed in libraryfolders.vdf.
    let mut libraries: Vec<PathBuf> = [".steam/steam", ".steam/debian-installation", ".local/share/Steam", ".var/app/com.valvesoftware.Steam/.local/share/Steam"]
        .iter()
        .map(|p| home.join(p))
        .collect();
    for lib in libraries.clone() {
        if let Ok(text) = std::fs::read_to_string(lib.join("steamapps/libraryfolders.vdf")) {
            libraries.extend(library_paths(&text).into_iter().map(PathBuf::from));
        }
    }
    for lib in &libraries {
        for prefix in subdirs(&lib.join("steamapps/compatdata")) {
            out.push(in_prefix(&prefix.join("pfx")));
        }
    }
    // Lutris (its default "Games" folder and its own prefixes) and plain Wine.
    for parent in [home.join("Games"), home.join(".local/share/lutris/prefixes")] {
        out.extend(subdirs(&parent).iter().map(|p| in_prefix(p)));
    }
    out.push(in_prefix(&home.join(".wine")));
    out
}

/// The `"path"` entries of a Steam libraryfolders.vdf.
#[cfg_attr(windows, allow(dead_code))]
fn library_paths(vdf: &str) -> Vec<String> {
    vdf.lines()
        .filter_map(|l| {
            let mut parts = l.split('"').filter(|s| !s.trim().is_empty());
            (parts.next()? == "path").then(|| parts.next().map(|p| p.replace("\\\\", "\\")))?
        })
        .collect()
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir).map(|it| it.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default()
}

/// Every install found, newest build first, each folder once (also when two ways lead to it).
pub fn find(home: Option<&Path>) -> Vec<FoundGame> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<FoundGame> = candidates(home)
        .into_iter()
        .filter_map(|dir| {
            let text = std::fs::read_to_string(dir.join(".build.info")).ok()?;
            // One spelling (links and short names resolved), without the `\\?\` canonicalize puts before a Windows path
            // (the folder offered at start showed as "\\?\C:\Program Files (x86)\Warcraft III").
            let real = PathBuf::from(backend::normal_path(&dir.to_string_lossy()));
            seen.insert(real.clone()).then(|| FoundGame { path: real.to_string_lossy().into_owned(), version: build_version(&text).unwrap_or_default() })
        })
        .collect();
    out.sort_by(newer_first);
    out
}

/// The game's own folder for the player's files (`Documents/Warcraft III`, where its `Maps` are listed in Custom
/// Game). For an install inside a Wine prefix (Proton, Lutris, plain Wine) that's the Documents of the prefix's
/// user: the one that already has the folder (the game made it on its first start), else Proton's `steamuser`.
/// Otherwise it's in `documents`, the system's Documents folder.
pub fn user_folder(install: &Path, documents: Option<&Path>) -> Result<PathBuf, String> {
    let drive_c = install.ancestors().find(|a| a.file_name().is_some_and(|n| n.eq_ignore_ascii_case("drive_c")));
    let Some(drive_c) = drive_c else {
        return documents.map(|d| d.join("Warcraft III")).ok_or_else(|| "The system's Documents folder isn't known.".to_string());
    };
    let mut users = subdirs(&drive_c.join("users"));
    users.sort();
    // Proton's user first, so a stray user of the same prefix doesn't win a tie.
    users.sort_by_key(|u| u.file_name().is_none_or(|n| n != "steamuser"));
    let of = |u: &PathBuf| u.join("Documents").join("Warcraft III");
    users
        .iter()
        .map(of)
        .find(|d| d.is_dir())
        .or_else(|| users.iter().find(|u| u.file_name().is_some_and(|n| n == "steamuser")).map(of))
        .ok_or_else(|| format!("No Warcraft III folder in the Documents of {}: start the game there once.", drive_c.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    fn home() -> PathBuf {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("w3proj-gamefind-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn install(dir: &Path, version: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(".build.info"), format!("Branch!STRING:0|Active!DEC:1|Version!STRING:0|Product!STRING:0\neu|1|{version}|w3\nus|1|{version}|w3\n")).unwrap();
    }

    #[test]
    fn the_build_comes_from_the_version_column() {
        assert_eq!(build_version("A!X:0|Version!STRING:0\nx|3.0.1.24371\n").as_deref(), Some("3.0.1.24371"));
        assert_eq!(build_version("A!X:0|Version!STRING:0\nx|\ny|2.0.2.1\n").as_deref(), Some("2.0.2.1"));
        assert_eq!(build_version("A!X:0|B!X:0\nx|y\n"), None);
        assert_eq!(build_version(""), None);
    }

    #[test]
    fn builds_compare_as_numbers_newest_first() {
        let g = |v: &str| FoundGame { path: v.into(), version: v.into() };
        let mut list = [g("2.0.2.22796"), g(""), g("3.0.1.24371"), g("2.0.10.1")];
        list.sort_by(newer_first);
        assert_eq!(list.iter().map(|x| x.version.as_str()).collect::<Vec<_>>(), ["3.0.1.24371", "2.0.10.1", "2.0.2.22796", ""]);
    }

    #[test]
    fn windows_looks_where_battle_net_registered_it_first_then_program_files_then_every_fixed_drive() {
        // Paths compared as built with the same joins: on Linux, where this runs too, a join puts `/` after "D:\".
        let registered = [PathBuf::from(r"E:\Blizzard\Warcraft III")];
        let program_files = [PathBuf::from(r"C:\Program Files (x86)")];
        let (c, d) = (PathBuf::from(r"C:\"), PathBuf::from(r"D:\"));
        let got = windows_candidates(&registered, &program_files, &[c, d.clone()]);
        assert_eq!(got[0], registered[0], "the registered folder comes first");
        assert_eq!(got[1], program_files[0].join("Warcraft III"));
        for want in [
            d.join("Program Files (x86)").join("Warcraft III"),
            d.join("Program Files").join("Warcraft III"),
            d.join("Warcraft III"),
            d.join("Games").join("Warcraft III"),
            d.join("Games").join("Warcraft III Public Test"),
        ] {
            assert!(got.contains(&want), "{} isn't looked at: {got:?}", want.display());
        }
        // Nothing registered, no drives: the Program Files folders alone (as before).
        assert_eq!(windows_candidates(&[], &program_files, &[]).len(), 2);
    }

    #[test]
    fn steam_library_paths_are_read_from_the_vdf() {
        let vdf = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"/mnt/games/SteamLibrary\"\n\t\t\"label\"\t\t\"\"\n\t}\n}\n";
        assert_eq!(library_paths(vdf), ["/mnt/games/SteamLibrary"]);
    }

    #[cfg(not(windows))]
    #[test]
    fn installs_in_steam_lutris_and_wine_prefixes_are_found_newest_first() {
        let h = home();
        let wc3 = |prefix: PathBuf| prefix.join("drive_c/Program Files (x86)/Warcraft III");
        install(&wc3(h.join(".steam/steam/steamapps/compatdata/111/pfx")), "3.0.1.24371");
        install(&wc3(h.join("Games/battlenet")), "2.0.2.22796");
        install(&wc3(h.join(".wine")), "2.0.4.23745");
        // A Steam prefix without the game, and a folder without .build.info, aren't installs.
        std::fs::create_dir_all(h.join(".steam/steam/steamapps/compatdata/222/pfx")).unwrap();
        std::fs::create_dir_all(wc3(h.join("Games/empty"))).unwrap();
        // A second Steam library on another drive, listed in libraryfolders.vdf.
        let other = h.join("other-drive/SteamLibrary");
        install(&wc3(other.join("steamapps/compatdata/333/pfx")), "1.36.2.21230");
        std::fs::write(h.join(".steam/steam/steamapps/libraryfolders.vdf"), format!("\"libraryfolders\"\n{{\n\"1\"\n{{\n\"path\"\t\"{}\"\n}}\n}}\n", other.display())).unwrap();

        let found = find(Some(&h));
        assert_eq!(found.iter().map(|g| g.version.as_str()).collect::<Vec<_>>(), ["3.0.1.24371", "2.0.4.23745", "2.0.2.22796", "1.36.2.21230"]);
        assert!(found[0].path.ends_with("compatdata/111/pfx/drive_c/Program Files (x86)/Warcraft III"), "{}", found[0].path);
        std::fs::remove_dir_all(&h).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn one_install_reached_two_ways_is_listed_once() {
        let h = home();
        install(&h.join(".local/share/Steam/steamapps/compatdata/1/pfx/drive_c/Program Files (x86)/Warcraft III"), "3.0.1.1");
        std::fs::create_dir_all(h.join(".steam")).unwrap();
        std::os::unix::fs::symlink(h.join(".local/share/Steam"), h.join(".steam/steam")).unwrap();
        assert_eq!(find(Some(&h)).len(), 1);
        std::fs::remove_dir_all(&h).unwrap();
    }

    #[test]
    fn the_user_folder_is_in_the_prefixs_documents_or_the_systems() {
        let h = home();
        let game = h.join("pfx/drive_c/Program Files (x86)/Warcraft III");
        install(&game, "3.0.1.24371");
        std::fs::create_dir_all(h.join("pfx/drive_c/users/Public/Documents")).unwrap();
        // Before the game's first start: Proton's user, if the prefix has one.
        assert!(user_folder(&game, None).unwrap_err().contains("start the game there once"));
        std::fs::create_dir_all(h.join("pfx/drive_c/users/steamuser")).unwrap();
        assert_eq!(user_folder(&game, None).unwrap(), h.join("pfx/drive_c/users/steamuser/Documents/Warcraft III"));
        // The user whose Documents the game already uses wins (plain Wine: the login name).
        std::fs::create_dir_all(h.join("pfx/drive_c/users/koneu/Documents/Warcraft III")).unwrap();
        assert_eq!(user_folder(&game, None).unwrap(), h.join("pfx/drive_c/users/koneu/Documents/Warcraft III"));
        std::fs::create_dir_all(h.join("pfx/drive_c/users/steamuser/Documents/Warcraft III")).unwrap();
        assert_eq!(user_folder(&game, None).unwrap(), h.join("pfx/drive_c/users/steamuser/Documents/Warcraft III"));
        // Not in a prefix: the system's Documents.
        let docs = h.join("Documents");
        assert_eq!(user_folder(&h.join("Warcraft III"), Some(&docs)).unwrap(), docs.join("Warcraft III"));
        assert!(user_folder(&h.join("Warcraft III"), None).is_err());
    }
}
