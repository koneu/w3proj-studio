//! Codecs turn archive files into diff-friendly project files and back.
//!
//! A codec is only used for a file if `encode(decode(x)) == x`; otherwise the
//! file is stored raw. That check runs on every unpack, so packing a project
//! is always lossless no matter how incomplete a codec is.

use crate::{mapinfo, objdata, Result};

pub trait Codec: Send + Sync {
    /// Stable identifier, e.g. `objdata-json`.
    fn id(&self) -> &'static str;
    /// Appended to the archive name to form the project file name.
    fn suffix(&self) -> &'static str;
    fn matches(&self, archive_name: &str) -> bool;
    /// Archive bytes → project bytes.
    fn decode(&self, archive_name: &str, bytes: &[u8]) -> Result<Vec<u8>>;
    /// Project bytes → archive bytes.
    fn encode(&self, archive_name: &str, bytes: &[u8]) -> Result<Vec<u8>>;
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

/// `war3map.w3i` (map info) as JSON.
pub struct MapInfoJson;

impl Codec for MapInfoJson {
    fn id(&self) -> &'static str {
        "mapinfo-json"
    }
    fn suffix(&self) -> &'static str {
        ".json"
    }
    fn matches(&self, name: &str) -> bool {
        name.eq_ignore_ascii_case("war3map.w3i")
    }
    fn decode(&self, _name: &str, bytes: &[u8]) -> Result<Vec<u8>> {
        mapinfo::to_json(bytes)
    }
    fn encode(&self, _name: &str, bytes: &[u8]) -> Result<Vec<u8>> {
        mapinfo::from_json(bytes)
    }
}

pub struct Registry {
    codecs: Vec<Box<dyn Codec>>,
}

impl Default for Registry {
    fn default() -> Self {
        Registry {
            codecs: vec![Box::new(ObjectDataJson), Box::new(MapInfoJson)],
        }
    }
}

impl Registry {
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
