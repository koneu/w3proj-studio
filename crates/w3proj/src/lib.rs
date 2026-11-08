//! Warcraft III map projects: unpack a `.w3x` into a git-friendly folder and
//! pack it back as a release step.

pub mod codec;
pub mod format;
pub mod header;
pub mod lossless;
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
/// Windows: a named pipe. Elsewhere: a Unix socket in the user's own runtime folder (XDG_RUNTIME_DIR,
/// readable by nobody else), or in the temp folder when there is none.
pub fn mcp_pipe_name() -> String {
    let user_var = if cfg!(windows) { "USERNAME" } else { "USER" };
    let user: String = std::env::var(user_var).unwrap_or_default().chars().filter(char::is_ascii_alphanumeric).collect();
    if cfg!(windows) {
        return format!(r"\\.\pipe\w3proj-studio-{user}");
    }
    let dir = std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty()).map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
    dir.join(format!("w3proj-studio-{user}.sock")).to_string_lossy().into_owned()
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
}

pub type Result<T> = std::result::Result<T, Error>;
