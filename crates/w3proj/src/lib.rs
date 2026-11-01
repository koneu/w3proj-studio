//! Warcraft III map projects: unpack a `.w3x` into a git-friendly folder and
//! pack it back as a release step.

pub mod codec;
pub mod header;
pub mod names;
pub mod objdata;
pub mod paths;
pub mod project;

pub use codec::{Codec, Registry};
pub use project::{
    pack, unpack, verify, Manifest, PackReport, UnpackOptions, UnpackReport, VerifyReport,
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
