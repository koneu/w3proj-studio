//! Codecs turn archive files into diff-friendly project files and back.
//!
//! A codec is only used for a file if `encode(decode(x)) == x`; otherwise the
//! file is stored raw. That check runs on every unpack, so packing a project
//! is always lossless no matter how incomplete a codec is.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use crate::format::{self, FormatCodec};
use crate::triggerdata::TriggerData;
use crate::{objdata, w3e, wct, wtg, Error, Result};

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

/// Custom script texts as one text file (see `wct`).
pub struct CustomTextCodec;

impl Codec for CustomTextCodec {
    fn id(&self) -> &'static str {
        "wct-text"
    }
    fn suffix(&self) -> &'static str {
        ".txt"
    }
    fn matches(&self, name: &str) -> bool {
        name.eq_ignore_ascii_case("war3map.wct")
    }
    fn decode(&self, _: &str, bytes: &[u8]) -> Result<Vec<u8>> {
        wct::to_text(bytes)
    }
    fn encode(&self, _: &str, bytes: &[u8]) -> Result<Vec<u8>> {
        wct::from_text(bytes)
    }
}

/// Terrain as text grids (see `w3e`).
pub struct TerrainText;

impl Codec for TerrainText {
    fn id(&self) -> &'static str {
        "w3e-text"
    }
    fn suffix(&self) -> &'static str {
        ".txt"
    }
    fn matches(&self, name: &str) -> bool {
        name.eq_ignore_ascii_case("war3map.w3e")
    }
    fn decode(&self, _: &str, bytes: &[u8]) -> Result<Vec<u8>> {
        w3e::to_text(bytes)
    }
    fn encode(&self, _: &str, bytes: &[u8]) -> Result<Vec<u8>> {
        w3e::from_text(bytes)
    }
}

/// Where the GUI trigger codec gets the game's TriggerData.txt (asked on the first decode).
pub type TriggerDataSource = Arc<dyn Fn() -> Option<Arc<TriggerData>> + Send + Sync>;

/// GUI triggers as JSON (see `wtg`). Decoding needs TriggerData; without a source the file
/// stays raw on unpack, while projects that have the JSON still pack.
pub struct TriggersJson {
    source: Option<TriggerDataSource>,
    data: OnceLock<Option<Arc<TriggerData>>>,
}

impl TriggersJson {
    pub fn new(source: Option<TriggerDataSource>) -> Self {
        TriggersJson { source, data: OnceLock::new() }
    }
}

impl Codec for TriggersJson {
    fn id(&self) -> &'static str {
        "wtg-json"
    }
    fn suffix(&self) -> &'static str {
        ".json"
    }
    fn matches(&self, name: &str) -> bool {
        name.eq_ignore_ascii_case("war3map.wtg")
    }
    fn decode(&self, _: &str, bytes: &[u8]) -> Result<Vec<u8>> {
        let data = self
            .data
            .get_or_init(|| self.source.as_ref().and_then(|s| s()))
            .as_ref()
            .ok_or_else(|| Error::Format("war3map.wtg: the game's TriggerData.txt isn't available".into()))?;
        wtg::to_json(bytes, data)
    }
    fn encode(&self, _: &str, bytes: &[u8]) -> Result<Vec<u8>> {
        wtg::from_json(bytes)
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
        let mut codecs: Vec<Box<dyn Codec>> = vec![Box::new(ObjectDataJson), Box::new(CustomTextCodec), Box::new(TerrainText), Box::new(TriggersJson::new(None))];
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

    /// Lets the GUI trigger codec decode (it needs the game's TriggerData.txt).
    pub fn set_trigger_data(&mut self, source: TriggerDataSource) {
        for c in &mut self.codecs {
            if c.id() == "wtg-json" {
                *c = Box::new(TriggersJson::new(Some(source.clone())));
            }
        }
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
