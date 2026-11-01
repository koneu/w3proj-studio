//! The unpacked project format.
//!
//! ```text
//! MyMap/
//!   w3proj.toml      manifest: map header, archive settings, pack settings
//!   header.bin       only if the HM3W header can't be regenerated exactly
//!   map/             one file per archive file (codec suffix appended)
//!   unnamed/         files whose names could not be recovered (not packed)
//!   build/           pack output (git-ignored)
//! ```
//!
//! Unpacking is split into `extract` (archive → in-memory file set) and
//! `write_files` (file set → disk, touching only files that changed), so the
//! same code backs import, re-sync after editing in the World Editor, and
//! in-memory verification.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use mpq::{Archive, ArchiveBuilder, WriteOptions};
use serde::{Deserialize, Serialize};

use crate::codec::Registry;
use crate::header::MapHeader;
use crate::{names, paths, Error, Result};

pub const MANIFEST: &str = "w3proj.toml";
pub const MAP_DIR: &str = "map";
pub const UNNAMED_DIR: &str = "unnamed";
pub const HEADER_FILE: &str = "header.bin";
pub const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub format: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map: Option<MapHeader>,
    #[serde(default)]
    pub archive: ArchiveSettings,
    #[serde(default)]
    pub pack: PackSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveSettings {
    pub sector_size_shift: u16,
}

impl Default for ArchiveSettings {
    fn default() -> Self {
        ArchiveSettings {
            sector_size_shift: 3,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PackSettings {
    /// Default output path for `pack`, relative to the project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// Project paths that must be packed as-is even if a codec suffix
    /// matches them (e.g. an imported file really named `x.w3u.json`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub raw: Vec<String>,
}

impl Manifest {
    pub fn load(project: &Path) -> Result<Manifest> {
        let text = fs::read_to_string(project.join(MANIFEST))
            .map_err(|e| Error::Project(format!("cannot read {MANIFEST}: {e}")))?;
        toml::from_str(&text).map_err(|e| Error::Project(format!("{MANIFEST}: {e}")))
    }

    pub fn save(&self, project: &Path) -> Result<()> {
        let body = toml::to_string_pretty(self).map_err(|e| Error::Project(e.to_string()))?;
        let text = format!("# w3proj project manifest. Pack with `w3proj pack`.\n{body}");
        write_if_changed(&project.join(MANIFEST), text.as_bytes())?;
        Ok(())
    }

    pub fn display_name(&self, project: &Path) -> String {
        self.map
            .as_ref()
            .map(|m| m.name.clone())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| {
                project
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub archive_name: String,
    pub project_path: String,
    pub size: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
    /// Why a matching codec was not used.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct UnpackReport {
    pub files: Vec<FileEntry>,
    /// Files whose name could not be recovered. Saved under `unnamed/` but
    /// not packed.
    pub unnamed: Vec<String>,
    /// Files that could not be read at all.
    pub errors: Vec<(String, String)>,
    pub written: usize,
    pub deleted: usize,
    pub unchanged: usize,
}

impl UnpackReport {
    pub fn is_complete(&self) -> bool {
        self.unnamed.is_empty() && self.errors.is_empty()
    }
}

/// An archive's contents in project form, not yet on disk.
pub struct Extracted {
    pub manifest: Manifest,
    pub raw_header: Option<Vec<u8>>,
    /// project path (relative to `map/`) → bytes
    pub files: BTreeMap<String, Vec<u8>>,
    /// file name (relative to `unnamed/`) → bytes
    pub unnamed: BTreeMap<String, Vec<u8>>,
    pub report: UnpackReport,
}

pub fn extract(archive: &Archive, codecs: &Registry) -> Extracted {
    let mut report = UnpackReport::default();

    // Collect candidate names, then keep those that exist.
    let mut candidates: BTreeSet<String> = names::KNOWN
        .iter()
        .chain(names::META_FILES)
        .map(|s| s.to_string())
        .collect();
    if let Ok(list) = archive.read("(listfile)") {
        candidates.extend(names::parse_listfile(&list));
    }
    if let Ok(imp) = archive.read("war3map.imp") {
        candidates.extend(names::parse_imp(&imp));
    }

    // slot → name; repeat scanning newly found files until nothing new turns up.
    let mut named: BTreeMap<usize, String> = BTreeMap::new();
    let mut scanned: BTreeSet<usize> = BTreeSet::new();
    let mut tried: BTreeSet<String> = BTreeSet::new();
    let total = archive.slots().len();
    for _round in 0..4 {
        for c in std::mem::take(&mut candidates) {
            if !tried.insert(c.to_ascii_uppercase()) {
                continue;
            }
            if let Some(slot) = archive.find(&c) {
                named.entry(slot.slot).or_insert(c);
            }
        }
        if named.len() == total {
            break;
        }
        let pending: Vec<(usize, String)> = named
            .iter()
            .filter(|(s, _)| !scanned.contains(*s))
            .map(|(s, n)| (*s, n.clone()))
            .collect();
        if pending.is_empty() {
            break;
        }
        for (slot, name) in pending {
            scanned.insert(slot);
            if let Ok(bytes) = archive.read(&name) {
                names::scan_candidates(&bytes, &mut candidates);
            }
        }
    }

    let mut files = BTreeMap::new();
    let mut unnamed = BTreeMap::new();
    for slot in archive.slots() {
        let Some(name) = named.get(&slot.slot) else {
            let file = format!(
                "slot{:05}-{:08x}{:08x}.bin",
                slot.slot, slot.hash.hash_a, slot.hash.hash_b
            );
            match archive.read_block(&slot.block, None) {
                Ok(bytes) => {
                    unnamed.insert(file.clone(), bytes);
                }
                Err(e) => report.errors.push((file.clone(), e.to_string())),
            }
            report.unnamed.push(file);
            continue;
        };
        if names::is_meta(name) {
            continue;
        }
        let bytes = match archive.read_block(&slot.block, Some(name)) {
            Ok(b) => b,
            Err(e) => {
                report.errors.push((name.clone(), e.to_string()));
                continue;
            }
        };
        let base_path = paths::to_project_path(name);
        if files.contains_key(&base_path) {
            continue; // same file under another locale
        }
        let mut entry = FileEntry {
            archive_name: name.clone(),
            project_path: base_path.clone(),
            size: bytes.len(),
            codec: None,
            note: None,
        };
        let mut stored = None;
        for codec in codecs.for_archive_name(name) {
            match codec.decode(name, &bytes) {
                Ok(decoded) => match codec.encode(name, &decoded) {
                    Ok(re) if re == bytes => {
                        entry.project_path = format!("{base_path}{}", codec.suffix());
                        entry.codec = Some(codec.id().to_string());
                        entry.note = None;
                        stored = Some(decoded);
                        break;
                    }
                    Ok(_) => entry.note = Some(format!("{}: round trip differs", codec.id())),
                    Err(e) => entry.note = Some(format!("{}: {e}", codec.id())),
                },
                Err(e) => entry.note = Some(format!("{}: {e}", codec.id())),
            }
        }
        files.insert(entry.project_path.clone(), stored.unwrap_or(bytes));
        report.files.push(entry);
    }

    // A raw file whose path looks like a codec output must be marked raw.
    let mut raw = Vec::new();
    for e in &report.files {
        if e.codec.is_none() && codecs.for_project_path(&e.project_path).is_some() {
            raw.push(e.project_path.clone());
        }
    }

    let prefix = archive.prefix();
    let header = MapHeader::parse(prefix);
    let exact = header.as_ref().is_some_and(|h| h.to_bytes() == prefix);
    let raw_header = (!prefix.is_empty() && !exact).then(|| prefix.to_vec());

    let manifest = Manifest {
        format: FORMAT_VERSION,
        map: header,
        archive: ArchiveSettings {
            sector_size_shift: archive.header().sector_size_shift,
        },
        pack: PackSettings { output: None, raw },
    };
    Extracted {
        manifest,
        raw_header,
        files,
        unnamed,
        report,
    }
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> Result<bool> {
    if fs::read(path).ok().as_deref() == Some(bytes) {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, bytes)?;
    Ok(true)
}

fn walk(root: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
    if !root.exists() {
        return Ok(out);
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                stack.push(path);
            } else {
                let rel = path.strip_prefix(root).unwrap();
                let rel: Vec<String> = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect();
                out.push(rel.join("/"));
            }
        }
    }
    out.sort();
    Ok(out)
}

fn remove_empty_dirs(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                remove_empty_dirs(&e.path());
                let _ = fs::remove_dir(e.path());
            }
        }
    }
}

/// Replaces the contents of `dir` with `files`, writing only what changed.
fn sync_dir(dir: &Path, files: &BTreeMap<String, Vec<u8>>, report: &mut UnpackReport) -> Result<()> {
    let wanted: BTreeSet<String> = files.keys().map(|k| k.to_ascii_lowercase()).collect();
    for existing in walk(dir)? {
        if !wanted.contains(&existing.to_ascii_lowercase()) {
            fs::remove_file(dir.join(&existing))?;
            report.deleted += 1;
        }
    }
    for (rel, bytes) in files {
        if write_if_changed(&dir.join(rel), bytes)? {
            report.written += 1;
        } else {
            report.unchanged += 1;
        }
    }
    remove_empty_dirs(dir);
    Ok(())
}

const GITATTRIBUTES: &str = "\
# Keep every map file byte-exact; text files still diff normally.
* -text
*.j diff
*.lua diff
*.json diff
*.txt diff
*.wts diff
*.fdf diff
*.toc diff
";

const GITIGNORE: &str = "build/\n";

/// Writes an extracted archive into a project directory. Existing pack
/// settings in the manifest are kept.
pub fn write_files(project: &Path, mut ex: Extracted) -> Result<UnpackReport> {
    fs::create_dir_all(project)?;
    if let Ok(old) = Manifest::load(project) {
        let mut raw = old.pack.raw;
        raw.extend(ex.manifest.pack.raw);
        raw.sort();
        raw.dedup();
        ex.manifest.pack = PackSettings {
            output: old.pack.output,
            raw,
        };
    }
    ex.manifest.save(project)?;
    let header_path = project.join(HEADER_FILE);
    match &ex.raw_header {
        Some(h) => {
            write_if_changed(&header_path, h)?;
        }
        None if header_path.exists() => fs::remove_file(&header_path)?,
        None => {}
    }
    for (name, text) in [(".gitattributes", GITATTRIBUTES), (".gitignore", GITIGNORE)] {
        let p = project.join(name);
        if !p.exists() {
            fs::write(p, text)?;
        }
    }
    let mut report = ex.report;
    sync_dir(&project.join(MAP_DIR), &ex.files, &mut report)?;
    let unnamed_dir = project.join(UNNAMED_DIR);
    if ex.unnamed.is_empty() {
        let _ = fs::remove_dir_all(&unnamed_dir);
    } else {
        let mut scratch = UnpackReport::default();
        sync_dir(&unnamed_dir, &ex.unnamed, &mut scratch)?;
    }
    Ok(report)
}

#[derive(Debug, Clone, Default)]
pub struct UnpackOptions {
    /// Write the project even if some files could not be read or named.
    pub allow_incomplete: bool,
}

/// Imports a map into a (new or existing) project directory.
pub fn unpack(map: &Path, project: &Path, codecs: &Registry, opts: &UnpackOptions) -> Result<UnpackReport> {
    let archive = Archive::open(map)?;
    let ex = extract(&archive, codecs);
    if !ex.report.is_complete() && !opts.allow_incomplete {
        return Err(Error::Incomplete(Box::new(ex.report)));
    }
    write_files(project, ex)
}

#[derive(Debug, Serialize)]
pub struct PackReport {
    pub output: PathBuf,
    pub files: usize,
    pub bytes: usize,
}

/// Project files (relative to `map/`) → archive files.
pub fn encode_files(
    files: &BTreeMap<String, Vec<u8>>,
    raw: &[String],
    codecs: &Registry,
) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut out: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut seen: BTreeMap<String, String> = BTreeMap::new();
    for (path, bytes) in files {
        let (name, data) = match codecs.for_project_path(path) {
            Some((stem, codec)) if !raw.iter().any(|r| r == path) => {
                let name = paths::to_archive_name(&stem);
                let data = codec
                    .encode(&name, bytes)
                    .map_err(|e| Error::Project(format!("{path}: {e}")))?;
                (name, data)
            }
            _ => (paths::to_archive_name(path), bytes.clone()),
        };
        if let Some(prev) = seen.insert(name.to_ascii_uppercase(), path.clone()) {
            return Err(Error::Project(format!(
                "{prev} and {path} both map to archive file {name}"
            )));
        }
        out.insert(name, data);
    }
    Ok(out)
}

pub fn build_archive(manifest: &Manifest, prefix: &[u8], files: BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>> {
    let mut builder = ArchiveBuilder::new(WriteOptions {
        sector_size_shift: manifest.archive.sector_size_shift,
        ..WriteOptions::default()
    });
    for (name, data) in files {
        builder.add(&name, data);
    }
    Ok(builder.write(prefix)?)
}

/// (manifest, map header bytes, files under `map/`)
pub type ProjectContents = (Manifest, Vec<u8>, BTreeMap<String, Vec<u8>>);

pub fn read_project(project: &Path) -> Result<ProjectContents> {
    let manifest = Manifest::load(project)?;
    let header_path = project.join(HEADER_FILE);
    let prefix = if header_path.exists() {
        fs::read(header_path)?
    } else {
        manifest.map.as_ref().map(|m| m.to_bytes()).unwrap_or_default()
    };
    let map_dir = project.join(MAP_DIR);
    let mut files = BTreeMap::new();
    for rel in walk(&map_dir)? {
        files.insert(rel.clone(), fs::read(map_dir.join(&rel))?);
    }
    Ok((manifest, prefix, files))
}

pub fn default_output(project: &Path, manifest: &Manifest) -> PathBuf {
    match &manifest.pack.output {
        Some(o) => project.join(o),
        None => {
            let name = project
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "map".into());
            project.join("build").join(format!("{name}.w3x"))
        }
    }
}

/// Packs a project into a `.w3x`. Writes atomically via a temp file.
pub fn pack(project: &Path, output: Option<&Path>, codecs: &Registry) -> Result<PackReport> {
    let (manifest, prefix, files) = read_project(project)?;
    let encoded = encode_files(&files, &manifest.pack.raw, codecs)?;
    let count = encoded.len();
    let bytes = build_archive(&manifest, &prefix, encoded)?;
    let output = output
        .map(Path::to_path_buf)
        .unwrap_or_else(|| default_output(project, &manifest));
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = output.with_extension("w3x.tmp");
    fs::write(&tmp, &bytes)?;
    fs::rename(&tmp, &output)?;
    Ok(PackReport {
        output,
        files: count,
        bytes: bytes.len(),
    })
}

#[derive(Debug, Serialize)]
pub struct VerifyReport {
    pub files: usize,
    pub codec_files: usize,
    pub codec_fallbacks: Vec<(String, String)>,
    pub mismatches: Vec<String>,
    pub unnamed: usize,
    pub errors: Vec<(String, String)>,
}

impl VerifyReport {
    pub fn ok(&self) -> bool {
        self.mismatches.is_empty()
    }
}

/// Unpacks and repacks a map in memory and checks every file survives.
pub fn verify(map: &Path, codecs: &Registry) -> Result<VerifyReport> {
    let archive = Archive::open(map)?;
    let ex = extract(&archive, codecs);
    let encoded = encode_files(&ex.files, &ex.manifest.pack.raw, codecs)?;
    let prefix = ex
        .raw_header
        .clone()
        .or_else(|| ex.manifest.map.as_ref().map(|m| m.to_bytes()))
        .unwrap_or_default();
    let packed = Archive::from_bytes(build_archive(&ex.manifest, &prefix, encoded)?)?;

    let mut mismatches = Vec::new();
    if packed.prefix() != &prefix[..] {
        mismatches.push("<map header>".into());
    }
    for f in &ex.report.files {
        let original = archive.read(&f.archive_name).ok();
        let repacked = packed.read(&f.archive_name).ok();
        if original.is_none() || original != repacked {
            mismatches.push(f.archive_name.clone());
        }
    }
    Ok(VerifyReport {
        files: ex.report.files.len(),
        codec_files: ex.report.files.iter().filter(|f| f.codec.is_some()).count(),
        codec_fallbacks: ex
            .report
            .files
            .iter()
            .filter_map(|f| Some((f.archive_name.clone(), f.note.clone()?)))
            .collect(),
        mismatches,
        unnamed: ex.report.unnamed.len(),
        errors: ex.report.errors,
    })
}
