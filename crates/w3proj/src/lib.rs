//! Warcraft III map projects: unpack a `.w3x` into a git-friendly folder and
//! pack it back as a release step.

pub mod codec;
pub mod derived;
pub mod format;
pub mod header;
pub mod lossless;
mod manifest_text;
pub mod names;
pub mod objdata;
pub mod paths;
pub mod project;
pub mod triggerdata;
pub mod w3o;
pub mod w3e;
pub mod wct;
pub mod wtg;
pub mod wts;

/// The pipe between `w3proj mcp` and the running app. Per user: two people's apps don't meet.
/// Windows: a named pipe. Elsewhere: a Unix socket in a folder only this user can open
/// ([`mcp_socket_dir`]); both ends check that folder ([`private_dir`]) before using the socket.
pub fn mcp_pipe_name() -> String {
    #[cfg(windows)]
    {
        let user: String = std::env::var("USERNAME").unwrap_or_default().chars().filter(char::is_ascii_alphanumeric).collect();
        format!(r"\\.\pipe\w3proj-studio-{user}")
    }
    #[cfg(unix)]
    {
        let uid = own_uid().map(|u| u.to_string()).unwrap_or_default();
        mcp_socket_dir().join(format!("w3proj-studio-{uid}.sock")).to_string_lossy().into_owned()
    }
    #[cfg(not(any(windows, unix)))]
    {
        String::new()
    }
}

/// The folder the MCP socket is in: the user's runtime folder (XDG_RUNTIME_DIR, the user's own, mode 0700); without
/// that variable `/run/user/<uid>` when it is this user's alone (a launcher such as the Claude app starts the `w3proj
/// mcp` bridge with little more than HOME set, while the app runs in a session that has the variable); or else
/// `w3proj-studio-<uid>` in the temp folder, which the app makes with mode 0700. A temp folder is shared with other
/// users, so the socket never sits in it directly: a name there could be taken by someone else first.
#[cfg(unix)]
pub fn mcp_socket_dir() -> std::path::PathBuf {
    pick_socket_dir(std::env::var_os("XDG_RUNTIME_DIR"), std::path::Path::new("/run/user"), &std::env::temp_dir(), own_uid())
}

#[cfg(unix)]
fn pick_socket_dir(xdg: Option<std::ffi::OsString>, run_user: &std::path::Path, temp: &std::path::Path, uid: Option<u32>) -> std::path::PathBuf {
    if let Some(dir) = xdg.filter(|d| !d.is_empty()) {
        return std::path::PathBuf::from(dir);
    }
    if let Some(uid) = uid {
        let run = run_user.join(uid.to_string());
        if private_dir(&run).is_ok() {
            return run;
        }
    }
    temp.join(format!("w3proj-studio-{}", uid.map(|u| u.to_string()).unwrap_or_default()))
}

/// This process's user id: the owner of /proc/self on Linux, else of the home folder.
#[cfg(unix)]
pub fn own_uid() -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata("/proc/self").ok().or_else(|| std::fs::metadata(std::env::var_os("HOME")?).ok())?;
    Some(meta.uid())
}

/// Whether a folder is this user's alone: owned by them, a real folder (not a link), no access for anyone else.
/// The MCP socket is used only in such a folder, so no other user can put a socket of their own in its place
/// or reach ours.
#[cfg(unix)]
pub fn private_dir(dir: &std::path::Path) -> std::result::Result<(), String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let m = std::fs::symlink_metadata(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    if !m.is_dir() {
        return Err(format!("{} isn't a folder", dir.display()));
    }
    if Some(m.uid()) != own_uid() {
        return Err(format!("{} belongs to another user", dir.display()));
    }
    if m.permissions().mode() & 0o077 != 0 {
        return Err(format!("{} can be opened by other users (mode {:o})", dir.display(), m.permissions().mode() & 0o777));
    }
    Ok(())
}

pub use codec::{Codec, Registry};
pub use project::{
    create, pack, pack_pruned, unpack, verify, Manifest, PackReport, UnpackOptions, UnpackReport, VerifyReport,
};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Mpq(#[from] mpq::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Format(String),
    #[error("{0}")]
    Project(String),
    #[error("map could not be fully unpacked ({} unreadable, {} unnamed files)", .0.errors.len(), .0.unnamed.len())]
    Incomplete(Box<UnpackReport>),
    /// A sync asked not to delete would have (`UnpackOptions::refuse_deletes`): what it would
    /// delete, from the project root. Nothing was written.
    #[error("the sync would delete {} files the map doesn't have", .0.len())]
    WouldDelete(Vec<String>),
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(all(test, unix))]
mod socket_dir_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn runtime_folder_without_the_variable() {
        let base = std::env::temp_dir().join(format!("w3proj-sockdir-{}", std::process::id()));
        let uid = own_uid().unwrap();
        let run = base.join("run");
        let mine = run.join(uid.to_string());
        std::fs::create_dir_all(&mine).unwrap();
        let temp = base.join("tmp");
        let fallback = temp.join(format!("w3proj-studio-{uid}"));
        // The variable wins.
        assert_eq!(pick_socket_dir(Some("/x".into()), &run, &temp, Some(uid)), std::path::PathBuf::from("/x"));
        // Without it, the user's own /run/user/<uid>, as the app's session has it.
        std::fs::set_permissions(&mine, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(pick_socket_dir(None, &run, &temp, Some(uid)), mine);
        assert_eq!(pick_socket_dir(Some("".into()), &run, &temp, Some(uid)), mine);
        // Not when others can open it, nor when it's missing: the temp folder's private one.
        std::fs::set_permissions(&mine, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(pick_socket_dir(None, &run, &temp, Some(uid)), fallback);
        std::fs::remove_dir_all(&base).unwrap();
        assert_eq!(pick_socket_dir(None, &run, &temp, Some(uid)), fallback);
    }
}
