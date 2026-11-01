//! Codecs turn archive files into diff-friendly project files and back.
//!
//! A codec is only used for a file if `encode(decode(x)) == x`; otherwise the
//! file is stored raw. That check runs on every unpack, so packing a project
//! is always lossless no matter how incomplete a codec is.

use std::path::{Path, PathBuf};

use crate::format::{self, FormatCodec};
use crate::{objdata, Result};

pub trait Codec: Send + Sync {
    /// Stable identifier, e.g. `objdata-json`.
    fn id(&self) -> &'static str;
    /// Appended to the archive name to form the project file name.
    fn suffix(&self) -> &'static str;
    fn matches(&self, archive_name: &str) -> bool;
    /// Archive bytes → project bytes.
    fn decode(&self, archive_name: &str, bytes: &[u8]) -> Result<Vec<u8>>;
    /// Like `decode`, plus remarks worth showing (e.g. which variant of an
    /// ambiguous layout was chosen).
    fn decode_with_notes(&self, archive_name: &str, bytes: &[u8]) -> Result<(Vec<u8>, Vec<String>)> {
        Ok((self.decode(archive_name, bytes)?, Vec::new()))
    }
    /// Project bytes → archive bytes.
    fn encode(&self, archive_name: &str, bytes: &[u8]) -> Result<Vec<u8>>;
    /// The format definition behind this codec, if it is data-driven.
    fn as_format(&self) -> Option<&FormatCodec> {
        None
    }
}

pub struct ObjectDataJson;

impl Codec for ObjectDataJson {
    fn id(&self) -> &'static str {
        "objdata-json"
    }
    fn suffix(&self) -> &'static str {
        ".json"
    }
    fn matches(&self, name: &str) -> bool {
        objdata::kind(name).is_some()
    }
    fn decode(&self, name: &str, bytes: &[u8]) -> Result<Vec<u8>> {
        objdata::to_json(bytes, objdata::kind(name).unwrap_or(false))
    }
    fn encode(&self, name: &str, bytes: &[u8]) -> Result<Vec<u8>> {
        objdata::from_json(bytes, objdata::kind(name).unwrap_or(false))
    }
}

pub struct Registry {
    codecs: Vec<Box<dyn Codec>>,
}

impl Default for Registry {
    /// Built-in codecs and format definitions.
    fn default() -> Self {
        Registry::with_formats(&[]).expect("built-in format definitions are valid")
    }
}

impl Registry {
    /// Built-ins plus definitions from override folders (later folders win).
    pub fn with_formats(override_dirs: &[PathBuf]) -> Result<Self> {
        let mut codecs: Vec<Box<dyn Codec>> = vec![Box::new(ObjectDataJson)];
        for def in format::load_definitions(override_dirs)? {
            codecs.push(Box::new(FormatCodec::new(def)));
        }
        Ok(Registry { codecs })
    }

    /// Registry for a project: built-ins, `extra` folders (e.g. the user's),
    /// then the project's `.w3proj/formats`.
    pub fn for_project(project: &Path, extra: &[PathBuf]) -> Result<Self> {
        let mut dirs = extra.to_vec();
        dirs.push(format::project_dir(project));
        Registry::with_formats(&dirs)
    }

    /// Format definitions in use, in order.
    pub fn formats(&self) -> Vec<&FormatCodec> {
        self.codecs.iter().filter_map(|c| c.as_format()).collect()
    }

    pub fn empty() -> Self {
        Registry { codecs: Vec::new() }
    }

    pub fn register(&mut self, codec: Box<dyn Codec>) {
        self.codecs.push(codec);
    }

    pub fn by_id(&self, id: &str) -> Option<&dyn Codec> {
        self.codecs.iter().find(|c| c.id() == id).map(|c| c.as_ref())
    }

    /// Codecs that claim an archive file, in registration order.
    pub fn for_archive_name<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a dyn Codec> {
        self.codecs
            .iter()
            .filter(move |c| c.matches(name))
            .map(|c| c.as_ref())
    }

    /// Resolves a project path to (archive path, codec) if a codec's suffix
    /// applies to it.
    pub fn for_project_path<'a>(&'a self, path: &str) -> Option<(String, &'a dyn Codec)> {
        self.codecs.iter().find_map(|c| {
            let stem = path.strip_suffix(c.suffix())?;
            c.matches(stem).then(|| (stem.to_string(), c.as_ref()))
        })
    }
}
