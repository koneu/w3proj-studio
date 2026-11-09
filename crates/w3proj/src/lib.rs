//! Warcraft III map projects: unpack a `.w3x` into a git-friendly folder and
//! pack it back as a release step.

pub mod codec;
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

/// The folder the MCP socket is in: the user's runtime folder (XDG_RUNTIME_DIR, the user's own, mode 0700), or
/// else `w3proj-studio-<uid>` in the temp folder, which the app makes with mode 0700. A temp folder is shared
/// with other users, so the socket never sits in it directly: a name there could be taken by someone else first.
#[cfg(unix)]
pub fn mcp_socket_dir() -> std::path::PathBuf {
    match std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty()) {
        Some(dir) => std::path::PathBuf::from(dir),
        None => std::env::temp_dir().join(format!("w3proj-studio-{}", own_uid().map(|u| u.to_string()).unwrap_or_default())),
    }
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
    create, pack, unpack, verify, Manifest, PackReport, UnpackOptions, UnpackReport, VerifyReport,
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
