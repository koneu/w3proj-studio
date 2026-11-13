//! Replacing a file in one step, so a write that fails partway (a full disk, a crash) never leaves it
//! cut short.
//!
//! The bytes go to a temporary file next to the target (same folder, so the same file system), which
//! is flushed to disk and then renamed over the target. The temporary file is named
//! `.<name>.<pid>-<n>.tmp`: [`is_temp`] tells it, and every file listing (the app's, the packer's)
//! leaves such names out. A leftover one (from a crash) older than [`STALE`] goes on the next write
//! of the same file.
//!
//! - **Symbolic links**: the write goes through to the file the link points at (the link stays a link).
//! - **Hard links**: the target becomes a file of its own; other names of the old file keep the old bytes.
//! - **Permissions**: the old file's go over to the new one (Unix). A read-only target is refused, as
//!   writing into it would be.
//! - **Windows**: `fs::rename` replaces an existing file (it is opened for deletion, so a file another
//!   program holds open without sharing deletion can't be replaced, just as it couldn't be truncated).
//!   A rename refused for a moment (a virus scanner or indexer looking at the new file) is tried again.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How old a leftover temporary file must be before a later write removes it: a write running in
/// another process (the CLI, a second app window) is never that slow.
pub const STALE: Duration = Duration::from_secs(60 * 60);

/// Writes `bytes` to `path` in one step (see the module).
pub fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_with(path, |f| f.write_all(bytes))
}

/// As [`write`], with the contents written by `fill` into the temporary file. An error from `fill`
/// leaves the target as it was and removes the temporary file.
pub fn write_with(path: &Path, fill: impl FnOnce(&mut fs::File) -> io::Result<()>) -> io::Result<()> {
    let path = follow_links(path)?;
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("{}: no file name", path.display())))?;
    let old = match fs::metadata(&path) {
        Ok(m) if m.is_dir() => {
            return Err(io::Error::new(io::ErrorKind::IsADirectory, format!("{} is a folder", path.display())))
        }
        Ok(m) if m.permissions().readonly() => {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, format!("{} is read-only", path.display())))
        }
        Ok(m) => Some(m),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    remove_stale(dir, &name);
    // One temporary name per process and call, so two writers never share one.
    static COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!("{}{}-{n}.tmp", temp_prefix(&name), std::process::id()));
    let done = (|| -> io::Result<()> {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        fill(&mut f)?;
        f.sync_all()?;
        drop(f);
        // The new file is made with default permissions: the old file's go over to it (a file the
        // user made private stays private).
        #[cfg(unix)]
        if let Some(old) = &old {
            fs::set_permissions(&tmp, old.permissions())?;
        }
        #[cfg(not(unix))]
        let _ = &old;
        rename_over(&tmp, &path)
    })();
    if let Err(e) = done {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Whether a file name is one of [`write`]'s temporary files: `.<name>.<digits>-<digits>.tmp`.
pub fn is_temp(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('.').and_then(|r| r.strip_suffix(".tmp")) else {
        return false;
    };
    let Some((head, id)) = rest.rsplit_once('.') else {
        return false;
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    !head.is_empty() && id.split_once('-').is_some_and(|(pid, n)| digits(pid) && digits(n))
}

/// `.<name>.`, with a long name shortened so the temporary name stays within the usual 255-byte limit.
fn temp_prefix(name: &str) -> String {
    let mut end = name.len().min(200);
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    format!(".{}.", &name[..end])
}

/// The file a symbolic link leads to (through any chain of links); the path itself when it is none.
/// A link to nothing yet leads to where the file will be made.
fn follow_links(path: &Path) -> io::Result<PathBuf> {
    let mut at = path.to_path_buf();
    for _ in 0..40 {
        match fs::symlink_metadata(&at) {
            Ok(m) if m.file_type().is_symlink() => {
                let to = fs::read_link(&at)?;
                at = match at.parent() {
                    Some(parent) if to.is_relative() => parent.join(to),
                    _ => to,
                };
            }
            _ => return Ok(at),
        }
    }
    Err(io::Error::other(format!("{}: too many levels of symbolic links", path.display())))
}

/// Removes leftover temporary files of `name` in `dir` older than [`STALE`]. Best effort: one that
/// can't be listed or removed stays (listings leave it out anyway).
fn remove_stale(dir: &Path, name: &str) {
    let prefix = temp_prefix(name);
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let file = entry.file_name();
        let file = file.to_string_lossy();
        // The prefix must be followed by the id alone: `.a.b.1-2.tmp` belongs to `a.b`, not to `a`.
        let ours = is_temp(&file) && file.strip_prefix(prefix.as_str()).is_some_and(|id| !id.trim_end_matches(".tmp").contains('.'));
        if !ours {
            continue;
        }
        let old = entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok());
        if old.is_some_and(|age| age >= STALE) && entry.file_type().is_ok_and(|t| t.is_file()) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Renames `from` over `to`. On Windows a refusal (access denied, sharing violation) is tried again a
/// few times: right after a file is written, a scanner may hold it for a moment.
fn rename_over(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        let mut wait = 10;
        for _ in 0..5 {
            match fs::rename(from, to) {
                Err(e) if e.kind() == io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(32) => {
                    std::thread::sleep(Duration::from_millis(wait));
                    wait *= 2;
                }
                r => return r,
            }
        }
    }
    fs::rename(from, to)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("w3proj-atomic-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn a_write_failing_partway_leaves_the_old_file() {
        let dir = scratch("fail");
        let p = dir.join("war3map.w3i");
        fs::write(&p, b"old contents").unwrap();
        let e = write_with(&p, |f| {
            f.write_all(b"new, but only ha")?;
            Err(io::Error::new(io::ErrorKind::StorageFull, "disk full"))
        })
        .unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::StorageFull);
        assert_eq!(fs::read(&p).unwrap(), b"old contents");
        assert_eq!(names(&dir), ["war3map.w3i"], "the temporary file is removed");
        write(&p, b"new").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"new");
        assert_eq!(names(&dir), ["war3map.w3i"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn temp_names_are_told() {
        assert!(is_temp(".war3map.w3i.123-0.tmp"));
        assert!(is_temp(".a.b.c.1-22.tmp"));
        for n in ["war3map.w3i", ".gitignore", ".x.tmp", "..1-2.tmp", ".a.1-.tmp", ".a.-2.tmp", ".a.1-2x.tmp", "a.1-2.tmp", ".a.12.tmp"] {
            assert!(!is_temp(n), "{n}");
        }
        let long = "é".repeat(150);
        assert!(is_temp(&format!("{}{}-{}.tmp", temp_prefix(&long), 1, 2)));
        assert!(temp_prefix(&long).len() <= 202);
    }

    #[test]
    fn stale_temp_files_of_the_file_go_others_stay() {
        let dir = scratch("stale");
        let p = dir.join("a");
        let old = dir.join(".a.999-1.tmp");
        let fresh = dir.join(".a.999-2.tmp");
        let other = dir.join(".a.b.999-3.tmp");
        for f in [&old, &fresh, &other] {
            fs::write(f, b"x").unwrap();
        }
        let past = std::time::SystemTime::now() - STALE - Duration::from_secs(60);
        for f in [&old, &other] {
            fs::File::options().write(true).open(f).unwrap().set_modified(past).unwrap();
        }
        write(&p, b"1").unwrap();
        assert_eq!(names(&dir), [".a.999-2.tmp", ".a.b.999-3.tmp", "a"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn read_only_targets_are_refused() {
        let dir = scratch("ro");
        let p = dir.join("a");
        fs::write(&p, b"old").unwrap();
        let mut perm = fs::metadata(&p).unwrap().permissions();
        perm.set_readonly(true);
        fs::set_permissions(&p, perm.clone()).unwrap();
        assert_eq!(write(&p, b"new").unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(&p).unwrap(), b"old");
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        fs::set_permissions(&p, perm).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn permissions_are_kept_and_links_written_through() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = scratch("unix");
        let real = dir.join("real.txt");
        fs::write(&real, b"old").unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.join("link.txt");
        symlink("real.txt", &link).unwrap();
        write(&link, b"new").unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "the link stays a link");
        assert_eq!(fs::read(&real).unwrap(), b"new");
        assert_eq!(fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o600);
        // A link to nothing yet: the file is made where it points.
        let dangling = dir.join("dangling");
        symlink("sub/made.txt", &dangling).unwrap();
        write(&dangling, b"made").unwrap();
        assert_eq!(fs::read(dir.join("sub/made.txt")).unwrap(), b"made");
        fs::remove_dir_all(&dir).unwrap();
    }
}
