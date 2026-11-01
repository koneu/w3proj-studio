//! Read-only access to the local CASC storage of Warcraft III Reforged.

pub mod game;
pub mod storage;

pub use game::{GameData, Mode};
pub use storage::{hex, Storage};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Storage(String),
    #[error("corrupt storage: {0}")]
    Corrupt(&'static str),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("file is encrypted")]
    Encrypted,
}

pub type Result<T> = std::result::Result<T, Error>;
