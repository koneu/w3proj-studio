//! The unpacked project format.
//!
//! ```text
//! MyMap/
//!   w3proj.toml      manifest: map header, archive settings, pack settings
//!   header.bin       only if the HM3W header can't be regenerated exactly
//!   map/             one file per archive file (codec suffix appended)
//!   maps/            campaigns: each chapter map as a project of its own
//!                    (folder named like the map file in the campaign)
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
use crate::{allies, names, paths, w3e, wts, Error, Result};

pub const MANIFEST: &str = "w3proj.toml";
pub const MAP_DIR: &str = "map";
pub const UNNAMED_DIR: &str = "unnamed";
pub const MAPS_DIR: &str = "maps";
pub const HEADER_FILE: &str = "header.bin";
pub const FORMAT_VERSION: u32 = 1;

/// First World Editor version whose version-8 placement files (`war3map.doo`, `war3mapUnits.doo`)
/// carry `skinId` (Reforged 1.32; measured in World Editor: 6088 crashes with `skinId`, 6089 opens).
pub const REFORGED_SKIN_ID_EDITOR_VERSION: u32 = 6089;

/// What `war3map.w3i` says about whether empty version-8 `.doo` files carry `skinId`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum W3iSkinStatus {
    Known(bool),
    Absent,
    Unreadable,
}

fn w3i_skin_status_from_json(bytes: &[u8]) -> W3iSkinStatus {
    let Ok(doc) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return W3iSkinStatus::Unreadable;
    };
    let Some(ed) = doc
        .get("editorVersion")
        .and_then(serde_json::Value::as_u64)
        .filter(|&v| v <= u32::MAX as u64)
    else {
        return W3iSkinStatus::Unreadable;
    };
    W3iSkinStatus::Known(ed >= REFORGED_SKIN_ID_EDITOR_VERSION as u64)
}

fn w3i_skin_status_from_raw(bytes: &[u8], codecs: &Registry) -> W3iSkinStatus {
    for codec in codecs.for_archive_name("war3map.w3i") {
        if let Ok(json) = codec.decode("war3map.w3i", bytes) {
            return w3i_skin_status_from_json(&json);
        }
    }
    W3iSkinStatus::Unreadable
}

fn w3i_skin_status_in_map(files: &BTreeMap<String, Vec<u8>>, errors: &[(String, String)], codecs: &Registry) -> W3iSkinStatus {
    if let Some((_, bytes)) = files.iter().find(|(k, _)| k.eq_ignore_ascii_case("war3map.w3i.json")) {
        return w3i_skin_status_from_json(bytes);
    }
    if let Some((_, bytes)) = files.iter().find(|(k, _)| k.eq_ignore_ascii_case("war3map.w3i")) {
        return w3i_skin_status_from_raw(bytes, codecs);
    }
    if errors.iter().any(|(name, _)| name.eq_ignore_ascii_case("war3map.w3i")) {
        return W3iSkinStatus::Unreadable;
    }
    W3iSkinStatus::Absent
}

/// Checks `map_dir` for `war3map.w3i.json` or raw `war3map.w3i` (case-insensitively) and returns
/// whether its `editorVersion` indicates Reforged `skinId` layout.
pub fn w3i_skin_status_in_dir(map_dir: &Path, codecs: &Registry) -> W3iSkinStatus {
    let Ok(entries) = fs::read_dir(map_dir) else {
        return W3iSkinStatus::Unreadable;
    };
    let mut json_path = None;
    let mut raw_path = None;
    for entry in entries {
        let Ok(entry) = entry else {
            return W3iSkinStatus::Unreadable;
        };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.eq_ignore_ascii_case("war3map.w3i.json") {
            json_path = Some(entry.path());
            break;
        } else if name.eq_ignore_ascii_case("war3map.w3i") {
            raw_path = Some(entry.path());
        }
    }
    if let Some(p) = json_path {
        return fs::read(&p).map_or(W3iSkinStatus::Unreadable, |b| w3i_skin_status_from_json(&b));
    }
    if let Some(p) = raw_path {
        return fs::read(&p).map_or(W3iSkinStatus::Unreadable, |b| w3i_skin_status_from_raw(&b, codecs));
    }
    W3iSkinStatus::Absent
}

fn placed_list_key(archive_name: &str) -> Option<&'static str> {
    if archive_name.eq_ignore_ascii_case("war3map.doo") {
        Some("doodads")
    } else if archive_name.eq_ignore_ascii_case("war3mapUnits.doo") {
        Some("units")
    } else {
        None
    }
}

/// Resolves `skinIds` on decoded empty version-8 `war3map.doo` / `war3mapUnits.doo` JSON from
/// `war3map.w3i` status, returning a diagnostic note if the file is an empty version-8 placement file.
/// When `war3map.w3i` is `Unreadable`, `preserve_on_unreadable` (if `Some`) keeps the caller's
/// existing flag instead of defaulting to `false`.
pub fn resolve_empty_v8_skin_ids(
    archive_name: &str,
    json_bytes: &mut Vec<u8>,
    status: impl FnOnce() -> W3iSkinStatus,
    codecs: &Registry,
    preserve_on_unreadable: Option<bool>,
) -> Option<String> {
    let list_key = placed_list_key(archive_name)?;
    let mut doc: serde_json::Value = serde_json::from_slice(json_bytes).ok()?;
    if doc.get("version").and_then(serde_json::Value::as_u64) != Some(8) {
        return None;
    }
    if !doc
        .get(list_key)
        .and_then(serde_json::Value::as_array)
        .is_some_and(Vec::is_empty)
    {
        return None;
    }
    let w3i = status();
    let target = match w3i {
        W3iSkinStatus::Known(v) => v,
        W3iSkinStatus::Absent => false,
        W3iSkinStatus::Unreadable => preserve_on_unreadable.unwrap_or(false),
    };
    let note = match w3i {
        W3iSkinStatus::Known(v) => format!("skinIds={v} from war3map.w3i (empty v8 list fits both)"),
        W3iSkinStatus::Absent => "skinIds=false (war3map.w3i absent; empty v8 list fits both)".into(),
        W3iSkinStatus::Unreadable => format!("skinIds={target} (war3map.w3i unreadable; empty v8 list fits both)"),
    };
    if doc.get("skinIds").and_then(serde_json::Value::as_bool) != Some(target) {
        if let Some(obj) = doc.as_object_mut() {
            obj.insert("skinIds".into(), serde_json::Value::Bool(target));
        }
        if let Ok(mut out) = serde_json::to_vec_pretty(&doc) {
            out.push(b'\n');
            let verified = codecs.for_archive_name(archive_name).any(|c| {
                matches!(
                    (c.encode(archive_name, json_bytes), c.encode(archive_name, &out)),
                    (Ok(a), Ok(b)) if a == b
                )
            });
            if verified {
                *json_bytes = out;
            }
        }
    }
    Some(note)
}

/// Whether something is at `path`. A path that can't be checked (a folder above it may not be looked
/// into) is an error, never "not there": what is taken for absent gets created or written over.
pub(crate) fn there(path: &Path) -> Result<bool> {
    path.try_exists()
        .map_err(|e| Error::Project(format!("{} can't be checked: {e}", path.display())))
}

/// Whether `path` is a folder; an error when that can't be checked (as `there`).
fn is_folder(path: &Path) -> Result<bool> {
    match fs::metadata(path) {
        Ok(m) => Ok(m.is_dir()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(Error::Project(format!("{} can't be checked: {e}", path.display()))),
    }
}

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

    /// Writes the manifest. One that is there is edited in place: only the keys Studio owns change,
    /// the user's comments and other keys stay, and nothing is written when the values are the same.
    /// One that is there but can't be read as TOML is an error and stays as it is.
    pub fn save(&self, project: &Path) -> Result<()> {
        let body = toml::to_string_pretty(self).map_err(|e| Error::Project(e.to_string()))?;
        let fresh = format!("# w3proj project manifest. Pack with `w3proj pack`.\n{body}");
        let path = project.join(MANIFEST);
        let kept = |why: String| Error::Project(format!("{}: {why}; it is kept as it is", path.display()));
        let text = match fs::read(&path) {
            Ok(bytes) => {
                let old = String::from_utf8(bytes).map_err(|_| kept("not UTF-8 text".into()))?;
                // A byte order mark (Notepad's) stays where it is: the TOML parser skips it, its
                // output wouldn't have it.
                let (bom, old) = match old.strip_prefix('\u{feff}') {
                    Some(rest) => ("\u{feff}", rest),
                    None => ("", old.as_str()),
                };
                match crate::manifest_text::merge(old, &fresh).map_err(kept)? {
                    Some(text) => format!("{bom}{text}"),
                    None => return Ok(()),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => fresh,
            Err(e) => return Err(kept(e.to_string())),
        };
        if fs::read(&path).ok().as_deref() != Some(text.as_bytes()) {
            write_atomic(&path, text.as_bytes())?;
        }
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
    /// What the codec noticed while decoding (e.g. which layout variant was chosen).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub info: Vec<String>,
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
    /// Files with a `\` in their name (left by an older version on Linux) that a sync would have
    /// deleted and left alone instead, from the project root with `/` between folders (the app offers
    /// to move them where they belong). A folder kept for one ends in `/`.
    pub strays: Vec<String>,
    /// Classic files the sync kept as the project had them (`keep_classic_over_hd`), from the project root with `/`
    /// between folders: the map held the bytes of their `_HD.w3mod/` version under the plain name.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub kept_classic: Vec<String>,
    /// `.mdl` files the sync left as the project had them (`keep_mdl_header_only`), from the project root
    /// with `/` between folders: only the `// MDLFile version` / `// Exported on` header lines differed.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub kept_mdl: Vec<String>,
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
    /// Campaigns: chapter maps as projects (folder under `maps/` → contents). Maps that can't
    /// be unpacked completely stay files in `files`.
    pub nested: BTreeMap<String, Extracted>,
    pub report: UnpackReport,
}

pub fn extract(archive: &Archive, codecs: &Registry) -> Extracted {
    extract_with(archive, codecs, &[])
}

/// `extra`: more candidate names (e.g. the game's own file paths, which maps override).
pub fn extract_with(archive: &Archive, codecs: &Registry, extra: &[String]) -> Extracted {
    let mut report = UnpackReport::default();

    // Collect candidate names, then keep those that exist.
    let mut candidates: BTreeSet<String> = names::KNOWN
        .iter()
        .chain(names::META_FILES)
        .map(|s| s.to_string())
        .chain(extra.iter().cloned())
        .collect();
    if let Ok(list) = archive.read("(listfile)") {
        candidates.extend(names::parse_listfile(&list));
    }
    for imp in ["war3map.imp", "war3campaign.imp"] {
        if let Ok(imp) = archive.read(imp) {
            candidates.extend(names::parse_imp(&imp));
        }
    }

    // slot → name; repeat scanning newly found files until nothing new turns up.
    let mut named: BTreeMap<usize, String> = BTreeMap::new();
    let mut scanned: BTreeSet<usize> = BTreeSet::new();
    let mut tried: BTreeSet<String> = BTreeSet::new();
    let total = archive.slots().len();
    // A second pass also reads the files still unnamed (their content doesn't need the name
    // unless encrypted): models list their textures, scripts their imports.
    for pass in 0..2 {
        if pass == 1 {
            if named.len() == total {
                break;
            }
            for slot in archive.slots() {
                if !named.contains_key(&slot.slot) {
                    if let Ok(bytes) = archive.read_block(&slot.block, None) {
                        names::scan_candidates(&bytes, &mut candidates);
                    }
                }
            }
        }
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
                    if is_map_name(&name) {
                        scan_nested_map(bytes, &mut candidates);
                    } else {
                        names::scan_candidates(&bytes, &mut candidates);
                    }
                }
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
        // The archive's own bookkeeping isn't map data and isn't kept in the project: pack writes a
        // new (listfile) and leaves (attributes) and (signature) out (`build_archive`).
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
        add_file(name, bytes, codecs, &mut files, &mut report);
    }

    let prefix = archive.prefix();
    finish(files, unnamed, report, prefix, archive.header().sector_size_shift, codecs, extra)
}

/// One named file of a map into the project's files, through the first codec that reads it back
/// to the same bytes (else raw).
fn add_file(name: &str, bytes: Vec<u8>, codecs: &Registry, files: &mut BTreeMap<String, Vec<u8>>, report: &mut UnpackReport) {
    let base_path = paths::to_project_path(name);
    if files.contains_key(&base_path) {
        return; // same file under another locale
    }
    let mut entry = FileEntry {
        archive_name: name.to_string(),
        project_path: base_path.clone(),
        size: bytes.len(),
        codec: None,
        note: None,
        info: Vec::new(),
    };
    let mut stored = None;
    for codec in codecs.for_archive_name(name).filter(|c| c.unpacks()) {
        match codec.decode_with_notes(name, &bytes) {
            Ok((decoded, info)) => match codec.encode(name, &decoded) {
                Ok(re) if re == bytes => {
                    entry.project_path = format!("{base_path}{}", codec.suffix());
                    entry.codec = Some(codec.id().to_string());
                    entry.note = None;
                    entry.info = info;
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

/// The map's war3map.wtg and war3map.wct (raw among `files`) as the folders of `map/triggers/`
/// (`crate::trigger_layout::split_map`, which checks that they come back byte for byte), read with the game's
/// TriggerData. When they can't be (no TriggerData, a function it doesn't know, only one of the two files, a file of the
/// map's own under `triggers\`, something the layout can't hold), both stay raw and their report entries say why.
fn split_triggers(files: &mut BTreeMap<String, Vec<u8>>, report: &mut UnpackReport, codecs: &Registry) {
    use crate::trigger_layout as tl;
    let key = |name: &str| files.keys().find(|k| k.eq_ignore_ascii_case(name)).cloned();
    let (wtg_key, wct_key) = (key(tl::WTG), key(tl::WCT));
    let split = match (&wtg_key, &wct_key) {
        (None, None) => return,
        (Some(_), None) => Err(format!("the map has no {}", tl::WCT)),
        (None, Some(_)) => Err(format!("the map has no {}", tl::WTG)),
        (Some(wtg), Some(wct)) => {
            if let Some(own) = tl::FOLDER.first_in(files) {
                Err(format!("the map has a file of its own under {}\\ ({own})", tl::DIR))
            } else {
                match codecs.trigger_data() {
                    None => Err("the game's TriggerData.txt isn't available".into()),
                    Some(data) => tl::split_map(&files[wtg], &files[wct], &data, tl::language(files, codecs)).map_err(|e| e.to_string()),
                }
            }
        }
    };
    let ours = |e: &FileEntry| [&wtg_key, &wct_key].iter().any(|k| k.as_deref() == Some(e.project_path.as_str()));
    match split {
        Ok(layout) => {
            for e in report.files.iter_mut().filter(|e| ours(e)) {
                e.codec = Some(tl::CODEC_ID.to_string());
                e.project_path = tl::ROOT_FILE.to_string();
                e.note = None;
            }
            for k in [&wtg_key, &wct_key].into_iter().flatten() {
                files.remove(k);
            }
            files.extend(layout);
        }
        Err(why) => {
            for e in report.files.iter_mut().filter(|e| ours(e)) {
                e.note = Some(format!("{}: {why}", tl::CODEC_ID));
            }
        }
    }
}

/// What follows reading a map's files: the trigger folders, chapter maps as projects, raw marks,
/// the header and the manifest. `prefix`: the bytes before the archive.
fn finish(
    mut files: BTreeMap<String, Vec<u8>>,
    unnamed: BTreeMap<String, Vec<u8>>,
    mut report: UnpackReport,
    prefix: &[u8],
    sector_size_shift: u16,
    codecs: &Registry,
    extra: &[String],
) -> Extracted {
    // Empty v8 placement files fit both skinIds=false and skinIds=true; resolve from war3map.w3i.
    let mut w3i = None;
    for entry in &mut report.files {
        if entry.codec.is_none() || placed_list_key(&entry.archive_name).is_none() {
            continue;
        }
        let Some(mut bytes) = files.get(&entry.project_path).cloned() else {
            continue;
        };
        let status = *w3i.get_or_insert_with(|| w3i_skin_status_in_map(&files, &report.errors, codecs));
        if let Some(note) = resolve_empty_v8_skin_ids(&entry.archive_name, &mut bytes, || status, codecs, None) {
            files.insert(entry.project_path.clone(), bytes);
            entry.info.retain(|n| !n.starts_with("variants skinIds="));
            entry.info.push(note);
        }
    }

    split_triggers(&mut files, &mut report, codecs);

    // Chapter maps of a campaign become projects of their own (if they unpack completely).
    let mut nested = BTreeMap::new();
    if files.contains_key("war3campaign.w3f") || files.keys().any(|k| k.starts_with("war3campaign.w3f.")) {
        for entry in report.files.iter_mut().filter(|e| e.codec.is_none() && is_map_name(&e.archive_name)) {
            let Some(bytes) = files.get(&entry.project_path) else { continue };
            let Ok(inner) = Archive::from_bytes(bytes.clone()) else { continue };
            let ex = extract_with(&inner, codecs, extra);
            if !ex.report.is_complete() {
                entry.note = Some("chapter map kept packed: not all of its files could be named".into());
                continue;
            }
            files.remove(&entry.project_path);
            let dir = entry.project_path.clone();
            entry.project_path = format!("../{MAPS_DIR}/{dir}");
            entry.codec = Some("map project".into());
            nested.insert(dir, ex);
        }
    }

    // A raw file whose path looks like a codec output must be marked raw (and the map's own file named like the trigger
    // layout's root file, which is the layout's only when it isn't raw).
    let mut raw = Vec::new();
    for e in &report.files {
        if e.codec.is_none() && (codecs.for_project_path(&e.project_path).is_some() || e.project_path == crate::trigger_layout::ROOT_FILE) {
            raw.push(e.project_path.clone());
        }
    }

    let header = MapHeader::parse(prefix);
    let exact = header.as_ref().is_some_and(|h| h.to_bytes() == prefix);
    let raw_header = (!prefix.is_empty() && !exact).then(|| prefix.to_vec());

    let manifest = Manifest {
        format: FORMAT_VERSION,
        map: header,
        archive: ArchiveSettings { sector_size_shift },
        pack: PackSettings { output: None, raw },
    };
    Extracted {
        manifest,
        raw_header,
        files,
        unnamed,
        nested,
        report,
    }
}

/// A map saved as a folder (the World Editor's "Warcraft III Scenario Folder": loose `war3map.*`
/// files, imports in subfolders) in project form, like `extract` of the packed map. The folder has
/// no map header (as maps of World Editor 3.0.1 and Studio's new maps) and no archive settings
/// (the default sector size). Symbolic links aren't followed; chapter maps saved as folders inside
/// a campaign folder are reported unreadable.
pub fn extract_dir(dir: &Path, codecs: &Registry) -> Result<Extracted> {
    let has = |name: &str| dir.join(name).is_file();
    if !has("war3map.w3i") && !has("war3campaign.w3f") {
        return Err(Error::Project(format!(
            "{} is no map folder (it has no war3map.w3i or war3campaign.w3f)",
            dir.display()
        )));
    }
    if there(&dir.join(MANIFEST))? {
        return Err(Error::Project(format!("{} is a project, not a map folder", dir.display())));
    }
    let mut report = UnpackReport::default();
    let mut files = BTreeMap::new();
    let mut stack = vec![(dir.to_path_buf(), String::new())];
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    while let Some((at, prefix)) = stack.pop() {
        for entry in fs::read_dir(&at)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            let file = entry.file_name().to_string_lossy().into_owned();
            let name = format!("{prefix}{file}");
            if kind.is_symlink() {
                report.errors.push((name, "a symbolic link (not followed)".into()));
            } else if kind.is_dir() && is_map_name(&file) {
                report.errors.push((name, "a chapter map saved as a folder (not read)".into()));
            } else if kind.is_dir() {
                stack.push((entry.path(), format!("{name}\\")));
            } else if !names::is_meta(&name) {
                found.push((name, entry.path()));
            }
        }
    }
    found.sort();
    for (name, path) in found {
        match fs::read(&path) {
            Ok(bytes) => add_file(&name, bytes, codecs, &mut files, &mut report),
            Err(e) => report.errors.push((name, e.to_string())),
        }
    }
    let shift = ArchiveSettings::default().sector_size_shift;
    Ok(finish(files, BTreeMap::new(), report, &[], shift, codecs, &[]))
}

fn is_map_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".w3x") || lower.ends_with(".w3m")
}

/// A campaign's chapter map: the files it names (scripts, object data, its own list) are often
/// imports of the campaign, which may have no list of its own.
fn scan_nested_map(bytes: Vec<u8>, out: &mut BTreeSet<String>) {
    let Ok(map) = Archive::from_bytes(bytes) else {
        return;
    };
    let mut inner: BTreeSet<String> = names::KNOWN.iter().map(|s| s.to_string()).collect();
    if let Ok(list) = map.read("(listfile)") {
        let list = names::parse_listfile(&list);
        out.extend(list.iter().cloned());
        inner.extend(list);
    }
    for name in inner {
        if let Ok(b) = map.read(&name) {
            names::scan_candidates(&b, out);
        }
    }
}

/// Replaces `path` with `bytes` in one step (`crate::atomic::write_lazily`: a file replaced is flushed
/// to disk first, a new one isn't) unless it holds them already.
pub(crate) fn write_if_changed(path: &Path, bytes: &[u8]) -> Result<bool> {
    if fs::read(path).ok().as_deref() == Some(bytes) {
        return Ok(false);
    }
    crate::atomic::write_lazily(path, bytes)?;
    Ok(true)
}

/// Replaces `path` in one step (`crate::atomic`): a crash mid-write leaves the old file whole, never a
/// truncated one.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    Ok(crate::atomic::write(path, bytes)?)
}

pub(crate) fn walk(root: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
    if !there(root)? {
        return Ok(out);
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                stack.push(path);
            } else if crate::atomic::is_temp(&entry.file_name().to_string_lossy()) {
                // A write in progress (or a crash's leftover): neither packed nor deleted by a sync.
                continue;
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

/// A file (or folder) with a `\` in its name: on Linux, left by an older version that joined paths
/// with a hand-written `\` (on Windows a name can't hold one). Never deleted by a sync: the app
/// offers to move it where it belongs (`app/src-tauri/src/strays.rs`).
fn is_stray(rel: &str) -> bool {
    rel.contains('\\')
}

/// The files in `dir` that aren't in `files` (paths relative to `dir`, `/` between folders): the
/// ones a sync deletes, and the strays it leaves alone.
fn extra_files(dir: &Path, files: &BTreeMap<String, Vec<u8>>) -> Result<(Vec<String>, Vec<String>)> {
    let on_disk = walk(dir)?;
    let listed: BTreeSet<&str> = on_disk.iter().map(String::as_str).collect();
    let mut wanted: BTreeMap<String, Vec<&str>> = BTreeMap::new();
    for k in files.keys() {
        wanted.entry(k.to_ascii_lowercase()).or_default().push(k);
    }
    // A file is kept when it has a wanted name exactly, or when it is the file a wanted name in
    // another case opens: on a file system that ignores case (Windows, macOS) the wanted name is
    // there without being listed itself. On one that doesn't (Linux), the wanted name opens nothing
    // yet, or a file of its own that the walk listed: then the existing one goes.
    let kept = |existing: &str| match wanted.get(&existing.to_ascii_lowercase()) {
        None => false,
        Some(names) => names
            .iter()
            .any(|w| *w == existing || (!listed.contains(w) && dir.join(w).is_file())),
    };
    let (strays, gone) = on_disk
        .iter()
        .filter(|existing| !kept(existing))
        .cloned()
        .partition(|existing| is_stray(existing));
    Ok((gone, strays))
}

/// The archive file a project path packs into, lowercased (as `encode_files` names it). `triggers`: the files hold
/// the trigger layout, whose files pack into war3map.wtg (and .wct).
fn archive_key(path: &str, raw: &[String], codecs: &Registry, triggers: bool) -> String {
    if triggers && crate::trigger_layout::is_layout_path(path) && !raw.iter().any(|r| r == path) {
        return crate::trigger_layout::WTG.to_string();
    }
    let name = match codecs.for_project_path(path) {
        Some((stem, _)) if !raw.iter().any(|r| r == path) => paths::to_archive_name(&stem),
        _ => paths::to_archive_name(path),
    };
    name.to_ascii_lowercase()
}

/// What syncing `ex` into `project` would delete under `map/` and `maps/`: the files the user may
/// have added there whose archive file the map doesn't have, from the project root with `/`. A file
/// only written in another form (e.g. `war3map.wtg` raw instead of `map/triggers/`) isn't lost
/// and isn't in it. A chapter map's whole project folder ends in `/`. Strays aren't in it: they are
/// never deleted.
pub fn would_delete(project: &Path, ex: &Extracted, codecs: &Registry) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let incoming = crate::trigger_layout::is_layout(&ex.files, &ex.manifest.pack.raw);
    let kept: BTreeSet<String> = ex.files.keys().map(|p| archive_key(p, &ex.manifest.pack.raw, codecs, incoming)).collect();
    // Raw files as the project on disk has them; a manifest that can't be read stops the sync anyway.
    let old_raw = Manifest::load(project).map(|m| m.pack.raw).unwrap_or_default();
    let on_disk = there(&project.join(MAP_DIR).join(crate::trigger_layout::ROOT_FILE))? && !old_raw.iter().any(|r| r == crate::trigger_layout::ROOT_FILE);
    // The files as the sync writes them (a split terrain layout kept: `terrain_layout::prepare_sync`).
    let mut files = ex.files.clone();
    // A split project's derived files go into the store, not map/.
    let _derived = crate::terrain_layout::prepare_sync(&project.join(MAP_DIR), &mut files)?;
    let (gone, _) = extra_files(&project.join(MAP_DIR), &files)?;
    out.extend(
        gone.into_iter()
            .filter(|p| !kept.contains(&archive_key(p, &old_raw, codecs, on_disk)))
            .map(|p| format!("{MAP_DIR}/{p}")),
    );
    let maps_dir = project.join(MAPS_DIR);
    // As write_project decides (the folders as its renames leave them); a folder renamed to the new
    // case keeps what it holds.
    let mut folders = subfolders(&maps_dir)?;
    for old in nested_projects(&maps_dir)? {
        let target = chapter_for(&maps_dir, &folders, &old, ex.nested.keys());
        if let ChapterFolder::Rename(new) = &target {
            folders.remove(&old);
            folders.insert(new.clone());
        }
        match target {
            ChapterFolder::Same(k) | ChapterFolder::Rename(k) => out.extend(
                would_delete(&maps_dir.join(&old), &ex.nested[&k], codecs)?
                    .into_iter()
                    .map(|p| format!("{MAPS_DIR}/{old}/{p}")),
            ),
            ChapterFolder::Gone if !holds_strays(&maps_dir.join(&old))? => out.push(format!("{MAPS_DIR}/{old}/")),
            ChapterFolder::Gone => {}
        }
    }
    Ok(out)
}

/// Whether a folder holds a stray anywhere below it.
fn holds_strays(dir: &Path) -> Result<bool> {
    Ok(walk(dir)?.iter().any(|p| is_stray(p)))
}

/// Replaces the contents of `dir` with `files`, writing only what changed. Strays are left alone and
/// reported, prefixed with `shown` (`dir` from the project root).
fn sync_dir(dir: &Path, shown: &str, files: &BTreeMap<String, Vec<u8>>, report: &mut UnpackReport) -> Result<()> {
    let (gone, strays) = extra_files(dir, files)?;
    for existing in gone {
        fs::remove_file(dir.join(&existing))?;
        report.deleted += 1;
    }
    report.strays.extend(strays.into_iter().map(|p| format!("{shown}/{p}")));
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
*.vjass diff
*.lua diff
*.json diff
*.txt diff
*.wts diff
*.fdf diff
*.toc diff
# Trigger texts keep their own line endings, CRLF in one and LF in the next.
map/triggers/** -text
# Imported assets (models, textures, sounds, videos, fonts) go to Git LFS where it is
# installed; without it git stores them as usual.
*.mdx filter=lfs diff=lfs merge=lfs -text
*.blp filter=lfs diff=lfs merge=lfs -text
*.dds filter=lfs diff=lfs merge=lfs -text
*.tga filter=lfs diff=lfs merge=lfs -text
*.tif filter=lfs diff=lfs merge=lfs -text
*.png filter=lfs diff=lfs merge=lfs -text
*.jpg filter=lfs diff=lfs merge=lfs -text
*.wav filter=lfs diff=lfs merge=lfs -text
*.mp3 filter=lfs diff=lfs merge=lfs -text
*.ogg filter=lfs diff=lfs merge=lfs -text
*.flac filter=lfs diff=lfs merge=lfs -text
*.webm filter=lfs diff=lfs merge=lfs -text
*.avi filter=lfs diff=lfs merge=lfs -text
*.bik filter=lfs diff=lfs merge=lfs -text
*.ttf filter=lfs diff=lfs merge=lfs -text
*.otf filter=lfs diff=lfs merge=lfs -text
# The map's own images (minimap, preview) are small and regenerated: plain git.
/map/war3map*.blp !filter !diff !merge
/map/war3map*.tga !filter !diff !merge
";

/// The lines `GITATTRIBUTES` got with the trigger folders (`crate::trigger_layout`).
const GITATTRIBUTES_TRIGGERS: [&str; 2] = ["*.vjass diff\n", "# Trigger texts keep their own line endings, CRLF in one and LF in the next.\nmap/triggers/** -text\n"];

/// Whether a project's `.gitattributes` is an earlier default (before the LFS rules, before the trigger folders'
/// lines): replaced by the current one on the next sync (a changed file is left alone).
fn outdated_gitattributes(old: &[u8]) -> bool {
    let v2 = GITATTRIBUTES_TRIGGERS.iter().fold(GITATTRIBUTES.to_string(), |s, l| s.replace(l, ""));
    old == GITATTRIBUTES_V1.as_bytes() || old == v2.as_bytes()
}

/// The default `.gitattributes` before the LFS rules.
const GITATTRIBUTES_V1: &str = "\
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

/// `.*.tmp`: a file being saved (`crate::atomic`) or one a crash left half written. `/.w3proj/derived/`: the derived
/// files of a split terrain (`crate::derived::STORE_DIR`; a flat project has none there).
const GITIGNORE: &str = "build/\n.*.tmp\n/.w3proj/derived/\n";

/// Writes an extracted archive into a project directory. Existing pack
/// settings in the manifest are kept.
pub fn write_files(project: &Path, ex: Extracted) -> Result<UnpackReport> {
    write_project(project, ex, true, false)
}

/// The manifest a sync into `project` keeps the pack settings of; None when there is none. One that is
/// there but can't be read stops the sync: written anew, it would lose the pack settings (output, raw
/// files) the user put in it.
fn old_manifest(project: &Path) -> Result<Option<Manifest>> {
    if !there(&project.join(MANIFEST))? {
        return Ok(None);
    }
    Manifest::load(project).map(Some).map_err(|e| {
        Error::Project(format!(
            "{e}. Nothing was written: {} is kept as it is; fix it (or move it away) and sync again",
            project.join(MANIFEST).display()
        ))
    })
}

/// The graphics mode folder whose version of a file the World Editor in HD mode saves under the plain name.
const HD_FOLDER: &str = "_HD.w3mod/";

/// Classic files a sync keeps as the project has them: a plain file (no mode folder) of `files` whose bytes are those
/// of its `_HD.w3mod/` version in the same map, where the project's own copy (in `map_dir`) differs. The World Editor
/// in HD mode saves so: an import a placed unit uses as its model, held plain (Classic) and below `_HD.w3mod\`, is
/// written back with the HD file's bytes under the plain name (we-drive, HD, branch we-compare-2, 2026-11-18:
/// make-import-modes.mjs import-modes-units, `war3mapImported\both.mdx`; the same map's imports no unit uses are
/// written back unchanged). Synced as it is, the project would lose its Classic model. `files` gets the project's
/// bytes back for those; returns their paths (relative to `map/`). A project copy that isn't there is nothing to
/// keep; one that can't be read stops the sync.
fn keep_classic_over_hd(map_dir: &Path, files: &mut BTreeMap<String, Vec<u8>>) -> Result<Vec<String>> {
    let mut kept = Vec::new();
    let twins: Vec<(String, String)> = files
        .keys()
        .filter_map(|k| k.strip_prefix(HD_FOLDER).map(|plain| (plain.to_string(), k.clone())))
        .collect();
    for (plain, hd) in twins {
        let (Some(new), Some(hd_bytes)) = (files.get(&plain), files.get(&hd)) else { continue };
        if new != hd_bytes {
            continue;
        }
        let own = match fs::read(map_dir.join(&plain)) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                return Err(Error::Project(format!(
                    "{} can't be read ({e}): the map holds its _HD.w3mod version's bytes under its name, and without the \
                     project's copy the sync can't tell whether that replaces it. The sync stopped before writing this project",
                    map_dir.join(&plain).display()
                )))
            }
        };
        if own != *new {
            files.insert(plain.clone(), own);
            kept.push(plain);
        }
    }
    Ok(kept)
}

/// Returns the body of a text `.mdl` starting right after a two-line export header
/// (`// MDLFile version…` followed by `// Exported on …`), or `None` when the file doesn't have
/// both lines or has nothing after them.
fn strip_mdl_export_header(bytes: &[u8]) -> Option<&[u8]> {
    let n1 = bytes.iter().position(|&b| b == b'\n')?;
    let line1 = bytes[..n1].strip_suffix(b"\r").unwrap_or(&bytes[..n1]);
    if !line1.starts_with(b"// MDLFile version\t") && !line1.starts_with(b"// MDLFile version ") {
        return None;
    }
    let rest = &bytes[n1 + 1..];
    let n2 = rest.iter().position(|&b| b == b'\n')?;
    let line2 = rest[..n2].strip_suffix(b"\r").unwrap_or(&rest[..n2]);
    if !line2.starts_with(b"// Exported on ") {
        return None;
    }
    let body = &rest[n2 + 1..];
    (!body.is_empty()).then_some(body)
}

/// `.mdl` files a sync leaves as the project has them: existing files under `map_dir` where both
/// the project's copy and the incoming one have the two-line export header (`// MDLFile version` /
/// `// Exported on`) and are byte-identical from line 3 onward. Files that aren't on disk yet are
/// untouched (fresh imports unpack verbatim); a file on disk that can't be read stops the sync
/// before anything is written.
fn keep_mdl_header_only(map_dir: &Path, files: &mut BTreeMap<String, Vec<u8>>) -> Result<Vec<String>> {
    let mut kept = Vec::new();
    for (rel, new) in files.iter_mut() {
        if !Path::new(rel).extension().is_some_and(|e| e.eq_ignore_ascii_case("mdl")) {
            continue;
        }
        let Some(new_body) = strip_mdl_export_header(new) else { continue };
        let own = match fs::read(map_dir.join(rel)) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                return Err(Error::Project(format!(
                    "{} can't be read ({e}): without the project's copy the sync can't tell whether only its \
                     export header changed. The sync stopped before writing this project",
                    map_dir.join(rel).display()
                )))
            }
        };
        if own == *new {
            continue;
        }
        if strip_mdl_export_header(&own) == Some(new_body) {
            *new = own;
            kept.push(rel.clone());
        }
    }
    Ok(kept)
}

/// `top`: the project itself (gets git files), not a chapter map inside a campaign.
fn write_project(project: &Path, mut ex: Extracted, top: bool, overwrite_mdl_headers: bool) -> Result<UnpackReport> {
    // Before anything is written: a project copy that can't be read stops the sync here.
    let map_dir = project.join(MAP_DIR);
    let kept = keep_classic_over_hd(&map_dir, &mut ex.files)?;
    let kept_mdl = if overwrite_mdl_headers {
        Vec::new()
    } else {
        keep_mdl_header_only(&map_dir, &mut ex.files)?
    };
    // A project with the split terrain layout keeps it: the map's terrain goes into its subterrains, its derived files
    // into the store (`crate::derived`; ones in map/ from before the store existed go, the map's replace them).
    let split = crate::terrain_layout::is_split_on_disk(&map_dir)?;
    let derived = crate::terrain_layout::prepare_sync(&map_dir, &mut ex.files)?;
    // The trigger folders keep the names they have on disk; a script Studio generated goes into the store
    // (`crate::trigger_layout::prepare_sync`).
    let script = crate::trigger_layout::prepare_sync(project, &mut ex.files)?;
    fs::create_dir_all(project)?;
    if let Some(old) = old_manifest(project)? {
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
        None if there(&header_path)? => fs::remove_file(&header_path)?,
        None => {}
    }
    for (name, text) in [(".gitattributes", GITATTRIBUTES), (".gitignore", GITIGNORE)] {
        let p = project.join(name);
        if !top {
            continue;
        }
        let outdated = name == ".gitattributes" && fs::read(&p).is_ok_and(|old| outdated_gitattributes(&old));
        if !there(&p)? || outdated {
            write_atomic(&p, text.as_bytes())?;
        }
    }
    let mut report = ex.report;
    report.kept_classic.extend(kept.into_iter().map(|p| format!("{MAP_DIR}/{p}")));
    report.kept_mdl.extend(kept_mdl.into_iter().map(|p| format!("{MAP_DIR}/{p}")));
    sync_dir(&map_dir, MAP_DIR, &ex.files, &mut report)?;
    if split {
        crate::derived::sync_store(project, &derived)?;
        if top {
            crate::derived::ensure_ignored(project)?;
        }
    }
    // The agent file sits next to .gitignore: written when absent, never rewritten (`agent_file`).
    if top {
        crate::agent_file::ensure(project, crate::agent_file::Kind::of(project)?)?;
    }
    // The map's pathing, shadows and minimap came with its terrain and doodads: they follow these (`derived`).
    crate::derived::record_now(project)?;
    // A generated script lives in the store, not in git, and follows the map's files as Studio wrote it; a kept one is
    // in map/ (a generated one the project had goes).
    crate::derived::sync_script_store(project, script.as_ref().map(|(n, b)| (n.as_str(), b.as_slice())))?;
    if script.is_some() {
        if top {
            crate::derived::ensure_ignored(project)?;
        }
        crate::derived::record_script_now(project)?;
    } else {
        crate::derived::clear_script_record(project)?;
    }
    // Chapter maps: one project each; ones no longer in the campaign are removed (unless a stray is
    // in one: then it stays as it is).
    let maps_dir = project.join(MAPS_DIR);
    let mut folders = subfolders(&maps_dir)?;
    for old in nested_projects(&maps_dir)? {
        let keep = match chapter_for(&maps_dir, &folders, &old, ex.nested.keys()) {
            ChapterFolder::Same(_) => true,
            // Its name in another case, on a file system that tells them apart: renamed, so what else the
            // folder holds (its manifest, build/) stays, and the sync below sees what it had.
            ChapterFolder::Rename(new) => {
                fs::rename(maps_dir.join(&old), maps_dir.join(&new))?;
                folders.remove(&old);
                folders.insert(new);
                true
            }
            ChapterFolder::Gone => false,
        };
        if !keep {
            if holds_strays(&maps_dir.join(&old))? {
                report.strays.push(format!("{MAPS_DIR}/{old}/"));
            } else {
                fs::remove_dir_all(maps_dir.join(&old))?;
                report.deleted += 1;
            }
        }
    }
    let has_chapters = !ex.nested.is_empty();
    for (dir, inner) in std::mem::take(&mut ex.nested) {
        let r = write_project(&maps_dir.join(&dir), inner, false, overwrite_mdl_headers)?;
        report.written += r.written;
        report.unchanged += r.unchanged;
        report.deleted += r.deleted;
        report.strays.extend(r.strays.into_iter().map(|p| format!("{MAPS_DIR}/{dir}/{p}")));
        report.kept_classic.extend(r.kept_classic.into_iter().map(|p| format!("{MAPS_DIR}/{dir}/{p}")));
        report.kept_mdl.extend(r.kept_mdl.into_iter().map(|p| format!("{MAPS_DIR}/{dir}/{p}")));
    }
    remove_empty_dirs(&maps_dir);
    // The chapters' stores and records are local too (their projects have no `.gitignore`: the campaign's covers them).
    if top && has_chapters {
        crate::derived::ensure_lines(project, &crate::derived::CHAPTERS_IGNORED)?;
    }
    // What couldn't be named: replaced as a whole (not counted), strays aside.
    let unnamed_dir = project.join(UNNAMED_DIR);
    let mut scratch = UnpackReport::default();
    sync_dir(&unnamed_dir, UNNAMED_DIR, &ex.unnamed, &mut scratch)?;
    if ex.unnamed.is_empty() {
        let _ = fs::remove_dir(&unnamed_dir);
    }
    report.strays.extend(scratch.strays);
    Ok(report)
}

/// More candidate names, produced only when an archive has files left unnamed.
pub type NameSource = std::sync::Arc<dyn Fn() -> Vec<String> + Send + Sync>;

#[derive(Clone, Default)]
pub struct UnpackOptions {
    /// Write the project even if some files could not be read or named.
    pub allow_incomplete: bool,
    /// Tried when names are missing (protected maps and campaigns): e.g. the game's file paths.
    pub more_names: Option<NameSource>,
    /// Write nothing and return `Error::WouldDelete` when the sync would delete files under `map/`
    /// or `maps/` (`would_delete`), so the caller can ask first.
    pub refuse_deletes: bool,
    /// With `refuse_deletes`: the project the written one takes the place of (the Campaign Editor's
    /// Replace Map unpacks into a new folder, then swaps it in). What would be deleted is what that
    /// one has that the map doesn't, from its root.
    pub replaces: Option<PathBuf>,
    /// Write incoming `.mdl` files verbatim even when only their export header lines changed (used when
    /// restoring a checkpoint or overwriting an existing project).
    pub overwrite_mdl_headers: bool,
}

/// Extracts, asking `more_names` for candidates if files are left unnamed.
fn extract_named(archive: &Archive, codecs: &Registry, more_names: Option<&NameSource>) -> Extracted {
    let ex = extract(archive, codecs);
    match more_names {
        Some(names) if !ex.report.unnamed.is_empty() => extract_with(archive, codecs, &names()),
        _ => ex,
    }
}

/// Imports a map into a (new or existing) project directory.
/// `map` may be a map folder (`extract_dir`); the project can't be in it or around it.
pub fn unpack(map: &Path, project: &Path, codecs: &Registry, opts: &UnpackOptions) -> Result<UnpackReport> {
    let ex = if map.is_dir() {
        let (a, b) = (absolute(map), absolute(project));
        if a.starts_with(&b) || b.starts_with(&a) {
            return Err(Error::Project(format!(
                "the project folder {} can't be inside the map folder {} or hold it",
                project.display(),
                map.display()
            )));
        }
        extract_dir(map, codecs)?
    } else {
        extract_named(&Archive::open(map)?, codecs, opts.more_names.as_ref())
    };
    if !ex.report.is_complete() && !opts.allow_incomplete {
        return Err(Error::Incomplete(Box::new(ex.report)));
    }
    if opts.refuse_deletes {
        // An unreadable manifest stops the sync anyway (write_project): said first, not after a question
        // about deleting.
        old_manifest(project)?;
        let gone = would_delete(opts.replaces.as_deref().unwrap_or(project), &ex, codecs)?;
        if !gone.is_empty() {
            return Err(Error::WouldDelete(gone));
        }
    }
    write_project(project, ex, true, opts.overwrite_mdl_headers)
}

/// The path made absolute and canonical where it exists (a project folder may not exist yet: then
/// its nearest existing parent is canonical and the rest is appended).
fn absolute(p: &Path) -> PathBuf {
    let p = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    let mut rest = Vec::new();
    let mut at = p.as_path();
    loop {
        if let Ok(c) = at.canonicalize() {
            return rest.iter().rev().fold(c, |acc: PathBuf, part| acc.join(part));
        }
        match (at.parent(), at.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                at = parent;
            }
            _ => return p,
        }
    }
}

/// Starts an empty project for a new map: manifest (with the map header),
/// git files and an empty `map/` folder. With `header` None it is a campaign's
/// (`.w3n` archives have no map header). The files are written by the caller.
/// Fails if the directory exists and isn't empty.
pub fn create(project: &Path, header: Option<MapHeader>) -> Result<()> {
    let campaign = header.is_none();
    create_as(project, header, campaign)
}

/// `create`, with `campaign` said outright: a map saved by World Editor 3.0.1 has no header either, but is no
/// campaign (the agent file describes the layout of the kind).
pub fn create_as(project: &Path, header: Option<MapHeader>, campaign: bool) -> Result<()> {
    if there(project)? && fs::read_dir(project)?.next().is_some() {
        return Err(Error::Project(format!("{} is not empty", project.display())));
    }
    fs::create_dir_all(project.join(MAP_DIR))?;
    let kind = if campaign { crate::agent_file::Kind::Campaign } else { crate::agent_file::Kind::Flat };
    let manifest = Manifest {
        format: FORMAT_VERSION,
        map: header,
        archive: ArchiveSettings::default(),
        pack: PackSettings::default(),
    };
    manifest.save(project)?;
    for (name, text) in [(".gitattributes", GITATTRIBUTES), (".gitignore", GITIGNORE)] {
        write_atomic(&project.join(name), text.as_bytes())?;
    }
    crate::agent_file::ensure(project, kind)?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct PackReport {
    pub output: PathBuf,
    pub files: usize,
    pub bytes: usize,
    /// What `pack_pruned` did to war3map.wts; `None` for `pack`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strings: Option<wts::PruneOutcome>,
    /// What the packed map has that the user should know (chapter maps' as `maps/<folder>/…`): a
    /// script whose ally priorities aren't those the pack worked out (`allies::script_agrees`), no script or no
    /// war3map.wtg (`missing_map_files`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// Project files (relative to `map/`) → archive files.
pub fn encode_files(
    files: &BTreeMap<String, Vec<u8>>,
    raw: &[String],
    codecs: &Registry,
) -> Result<BTreeMap<String, Vec<u8>>> {
    encode_files_noting(files, raw, codecs, &mut Vec::new())
}

/// `encode_files`, with what is worth a warning into `warnings` (the trigger folders' order.txt entries that aren't
/// there, a variable defined twice alike, …). The trigger folders (`map/triggers/`) pack into war3map.wtg and
/// war3map.wct (`crate::trigger_layout::assemble`, in the map's script language).
pub fn encode_files_noting(
    files: &BTreeMap<String, Vec<u8>>,
    raw: &[String],
    codecs: &Registry,
    warnings: &mut Vec<String>,
) -> Result<BTreeMap<String, Vec<u8>>> {
    use crate::trigger_layout as tl;
    let mut out: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut seen: BTreeMap<String, String> = BTreeMap::new();
    let triggers = tl::is_layout(files, raw);
    if triggers {
        let (wtg, wct, notes) = tl::assemble(files, tl::language(files, codecs), codecs.trigger_data().as_deref()).map_err(|e| Error::Project(e.to_string()))?;
        warnings.extend(notes);
        for (name, data) in [(tl::WTG, wtg), (tl::WCT, wct)] {
            seen.insert(name.to_ascii_uppercase(), format!("{}/", tl::DIR));
            out.insert(name.to_string(), data);
        }
    }
    for (path, bytes) in files {
        if triggers && tl::is_layout_path(path) && !raw.iter().any(|r| r == path) {
            continue;
        }
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

/// The archive gets a (listfile) of its files and nothing else of the MPQ's bookkeeping, so a packed
/// map has one entry fewer than a World Editor save: (attributes), which holds a CRC32 (and maybe a
/// time and MD5) per block, is left out on purpose. Its values describe the original's blocks, so
/// carried over it would be wrong for the new ones, and the game loads maps without it (every map of
/// smoketest_maps that had one: only it went missing, 2026-11-16). (signature) is left out too: a
/// signature over other bytes is worse than none. `tests/pack_meta_files.rs` pins both. `w3proj pack
/// --attributes` writes a new one instead (`build_archive_with`).
pub fn build_archive(manifest: &Manifest, prefix: &[u8], files: BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>> {
    build_archive_with(manifest, prefix, files, false)
}

/// `build_archive`; `attributes`: with a fresh (attributes) of the new blocks' CRC32s, as the World Editor's save
/// has it (`mpq::WriteOptions::attributes`), so the map has the same entries as one it saved.
pub fn build_archive_with(manifest: &Manifest, prefix: &[u8], files: BTreeMap<String, Vec<u8>>, attributes: bool) -> Result<Vec<u8>> {
    let mut builder = ArchiveBuilder::new(WriteOptions {
        sector_size_shift: manifest.archive.sector_size_shift,
        attributes,
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
    let prefix = if there(&header_path)? {
        fs::read(header_path)?
    } else {
        manifest.map.as_ref().map(|m| m.to_bytes()).unwrap_or_default()
    };
    let map_dir = project.join(MAP_DIR);
    let mut files = BTreeMap::new();
    for rel in walk(&map_dir)? {
        files.insert(rel.clone(), fs::read(map_dir.join(&rel))?);
    }
    // Either terrain layout: a split one (map/terrain/) is assembled into war3map.w3e.txt here, and its derived files
    // come from the store (`crate::derived`). Whether they may go into a map is the caller's to decide (`w3proj pack`
    // checks the record); one also left in map/ is an error, as two of anything else.
    if crate::terrain_layout::flatten(&mut files)? {
        for (name, bytes) in crate::derived::read_store(project)? {
            if let Some(k) = files.keys().find(|k| k.eq_ignore_ascii_case(&name)) {
                return Err(Error::Project(format!(
                    "{MAP_DIR}/{k} and {}/{name} are both there: a split project keeps its derived files in the store; delete the one in {MAP_DIR}/",
                    crate::derived::STORE_DIR.join("/")
                )));
            }
            files.insert(name, bytes);
        }
    }
    // A generated map script (map/triggers/triggers.json "script": "generated") isn't in git: it comes from the store.
    // Whether it may go into a map is the caller's to decide (`w3proj pack` checks the record); one also in map/ is an
    // error. None there: the map has no script (`missing_map_files`).
    if crate::trigger_layout::script_mode(&files)? == Some(crate::trigger_layout::ScriptMode::Generated) {
        for (name, bytes) in crate::derived::read_script_store(project)? {
            if let Some(k) = files.keys().find(|k| crate::derived::SCRIPT_FILES.iter().any(|s| k.eq_ignore_ascii_case(s))) {
                return Err(Error::Project(format!(
                    "{MAP_DIR}/{k} and {}/{name} are both there: the project's map script is generated ({MAP_DIR}/{} \"script\": \"generated\"), \
                     so it lives in the store; delete {MAP_DIR}/{k}, or make the script a tracked file (\"script\": \"kept\") and delete the store's",
                    crate::derived::STORE_DIR.join("/"),
                    crate::trigger_layout::ROOT_FILE
                )));
            }
            files.insert(name, bytes);
        }
    }
    Ok((manifest, prefix, files))
}

/// A campaign has campaign info (war3campaign.w3f, raw or as JSON).
/// A path that can't be checked is an error, not "no campaign" (the output's extension follows it).
pub fn is_campaign_project(project: &Path) -> Result<bool> {
    let map = project.join(MAP_DIR);
    Ok(there(&map.join("war3campaign.w3f"))? || there(&map.join("war3campaign.w3f.json"))?)
}

pub fn default_output(project: &Path, manifest: &Manifest) -> Result<PathBuf> {
    Ok(match &manifest.pack.output {
        Some(o) => project.join(o),
        None => {
            let name = project
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "map".into());
            let ext = if is_campaign_project(project)? { "w3n" } else { "w3x" };
            project.join("build").join(format!("{name}.{ext}"))
        }
    })
}

/// Packs a project into a `.w3x`. Writes atomically via a temp file.
/// Folders under `maps/` that are projects (chapter maps of a campaign).
fn nested_projects(maps_dir: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
    if is_folder(maps_dir)? {
        for entry in fs::read_dir(maps_dir)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() && there(&entry.path().join(MANIFEST))? {
                out.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    out.sort();
    Ok(out)
}

/// The names of all folders in `dir` (none when it isn't there).
fn subfolders(dir: &Path) -> Result<BTreeSet<String>> {
    let mut out = BTreeSet::new();
    if is_folder(dir)? {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                out.insert(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    Ok(out)
}

/// What a sync does with an existing chapter folder (see `chapter_for`).
#[derive(Debug, PartialEq)]
enum ChapterFolder {
    /// It is the folder of this chapter the sync brings: synced in place.
    Same(String),
    /// A chapter the sync brings has its name in another case, on a file system that tells cases
    /// apart, and no folder of its own yet: the folder is renamed to it.
    Rename(String),
    /// No chapter the sync brings is in it: it goes.
    Gone,
}

/// What becomes of the chapter folder `existing` under `maps_dir` on a sync bringing the chapters
/// `wanted`; `folders`: every folder there. Like `extra_files` for files: a wanted name is it
/// exactly, or opens it in another case (a file system that ignores case: the wanted name isn't among
/// `folders` itself, yet opens a folder). On one that doesn't, a wanted name in another case with no
/// folder of its own gets this one; one that has its own folder leaves this one to go.
fn chapter_for<'a>(
    maps_dir: &Path,
    folders: &BTreeSet<String>,
    existing: &str,
    wanted: impl Iterator<Item = &'a String>,
) -> ChapterFolder {
    let others: Vec<&String> = wanted.filter(|w| w.eq_ignore_ascii_case(existing)).collect();
    if let Some(w) = others.iter().find(|w| **w == existing) {
        return ChapterFolder::Same((*w).clone());
    }
    for w in others {
        if folders.contains(w.as_str()) {
            continue;
        }
        return if maps_dir.join(w).is_dir() { ChapterFolder::Same(w.clone()) } else { ChapterFolder::Rename(w.clone()) };
    }
    ChapterFolder::Gone
}

/// The app's record of dropped strings: `None` when it isn't there, `Err` (why) when it is there
/// and can't be read.
fn read_pruned_record(project: &Path) -> std::result::Result<Option<String>, String> {
    let path = project.join(wts::PRUNED_STRINGS_FILE);
    match fs::read(&path) {
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| format!("{} isn't UTF-8 text", wts::PRUNED_STRINGS_FILE)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{} is there but can't be read ({e})", wts::PRUNED_STRINGS_FILE)),
    }
}

/// What a map's archive (`encoded`: archive name → bytes) lacks that the game or the World Editor needs, as warnings;
/// the pack goes on and adds nothing. No map script (war3map.j, or war3map.lua for a Lua map): the game has nothing to
/// run. No war3map.wtg (protected, JASS-only maps leave it out): the World Editor refuses to open the map ("Trigger
/// data missing or invalid"); an empty one isn't made up, it would drop the triggers the script has. A campaign's own
/// archive (war3campaign.w3f) has neither.
fn missing_map_files(encoded: &BTreeMap<String, Vec<u8>>) -> Vec<String> {
    let has = |name: &str| encoded.keys().any(|k| k.eq_ignore_ascii_case(name));
    if has("war3campaign.w3f") {
        return Vec::new();
    }
    let mut out = Vec::new();
    if !has("war3map.j") && !has("war3map.lua") {
        out.push(format!(
            "{MAP_DIR}/war3map.j is missing, so the packed map has no script and the game can't run it: Generate Map Script in \
             W3Proj Studio or `w3proj rebuild --only script` makes it"
        ));
    }
    if !has("war3map.wtg") {
        out.push(format!(
            "{MAP_DIR}/war3map.wtg is missing (protected maps leave it out), so the World Editor can't open the packed map \
             (\"Trigger data missing or invalid\"); the game runs it from its script, and no empty war3map.wtg is made up"
        ));
    }
    out
}

/// The entries of an import list (`war3map.imp`: u32 version, u32 count, {u8 flags, cstring path}[count]) as flags and
/// path; stops at the first entry that runs past the end or isn't UTF-8 (what follows can't be told).
fn import_entries(bytes: &[u8]) -> Vec<(u8, String)> {
    let mut out = Vec::new();
    let Some(count) = bytes.get(4..8).map(|c| u32::from_le_bytes(c.try_into().unwrap())) else {
        return out;
    };
    let mut p = 8;
    for _ in 0..count {
        let Some(&flags) = bytes.get(p) else { break };
        let Some(n) = bytes.get(p + 1..).and_then(|rest| rest.iter().position(|&b| b == 0)) else {
            break;
        };
        let Ok(path) = std::str::from_utf8(&bytes[p + 1..p + 1 + n]) else {
            break;
        };
        out.push((flags, path.to_string()));
        p += n + 2;
    }
    out
}

/// The kinds of swap the World Editor's save was seen to drop: a sound listed under another sound extension, and the
/// preview image (`war3mapPreview.*`). Not others: Blizzard's own maps list `.mdl` models held as `.mdx` and a `.tga`
/// held as `.dds` (ForgottenHollow, SilverpineSprint, Dalaran), which looks like the editor's own conversion, and the
/// map's own files (war3mapMap.blp listed as war3mapmap.tga) are written by its save whatever the list says.
fn measured_swap(entry: &str, held: &str) -> bool {
    let ext = |p: &str| p.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    let sound = |p: &str| matches!(ext(p).as_str(), "flac" | "ogg" | "mp3" | "wav");
    let preview = |p: &str| !p.contains('\\') && p.to_ascii_lowercase().starts_with("war3mappreview.");
    (sound(entry) && sound(held)) || (preview(entry) && preview(held))
}

/// Import list entries whose file the archive (`encoded`: archive name → bytes) holds only under another extension
/// (of the kinds `measured_swap` names), as warnings: (12)WormWar lists `war3mapPreview.tga` and nine sounds as `.flac` and holds a `.dds` and `.ogg` files.
/// The World Editor's save drops such a file without a word (we-compare corpus-saves-wormwar, branch we-corpus-saves,
/// 2026-11-20); this pack keeps it (the game reads a sound under its other extensions). An entry with the standard
/// path flags (5, 8) names its file in the import folder or as listed; a `/` in a path is a `\`.
fn imports_under_other_extension(encoded: &BTreeMap<String, Vec<u8>>) -> Vec<String> {
    let lower: BTreeMap<String, &String> = encoded.keys().map(|k| (k.to_ascii_lowercase(), k)).collect();
    let stem = |p: &str| match p.rfind('.') {
        Some(i) if !p[i..].contains('\\') => p[..i].to_string(),
        _ => p.to_string(),
    };
    let mut by_stem: BTreeMap<String, Vec<&String>> = BTreeMap::new();
    for (l, k) in &lower {
        if l.rfind('.').is_some_and(|i| !l[i..].contains('\\')) {
            by_stem.entry(stem(l)).or_default().push(k);
        }
    }
    let mut out = Vec::new();
    for (list, folder) in [("war3map.imp", "war3mapImported"), ("war3campaign.imp", "war3campImported")] {
        let Some(bytes) = lower.get(list).map(|k| &encoded[*k]) else { continue };
        for (flags, path) in import_entries(bytes) {
            if path.is_empty() {
                continue;
            }
            let path = path.replace('/', "\\");
            let forms = if matches!(flags, 5 | 8) { vec![format!("{folder}\\{path}"), path.clone()] } else { vec![path.clone()] };
            let forms: Vec<String> = forms.iter().map(|f| f.to_ascii_lowercase()).collect();
            if forms.iter().any(|f| lower.contains_key(f)) {
                continue;
            }
            let held = forms.iter().filter(|f| *f != &stem(f)).find_map(|f| by_stem.get(&stem(f)).and_then(|v| v.first()));
            if let Some(held) = held.filter(|held| measured_swap(&path, held)) {
                out.push(format!(
                    "{MAP_DIR}/{list} lists {path}, but the map holds it as {held}: this pack keeps the file, the World \
                     Editor's save drops it without a warning"
                ));
            }
        }
    }
    out
}

/// `prune`: the map's war3map.wts goes into the archive without the strings nothing refers to
/// (`wts::prune_files`; the project's files stay as they are), and what that did is put there.
/// Chapter maps are packed as they are. Builds a project's archive (chapter maps under `maps/` are
/// packed into it first); what the user should know about it goes into `warnings`.
/// `attributes`: the archive and its chapter maps get an (attributes) (`build_archive_with`).
fn pack_bytes_with(
    project: &Path,
    codecs: &Registry,
    prune: Option<&mut wts::PruneOutcome>,
    warnings: &mut Vec<String>,
    attributes: bool,
) -> Result<(Vec<u8>, usize)> {
    let (manifest, prefix, mut files) = read_project(project)?;
    if let Some(outcome) = prune {
        *outcome = wts::prune_files(&mut files, read_pruned_record(project), codecs);
    }
    let mut encoded = encode_files_noting(&files, &manifest.pack.raw, codecs, warnings)?;
    warnings.extend(missing_map_files(&encoded));
    warnings.extend(imports_under_other_extension(&encoded));
    // The ally priorities the World Editor's save works out (`allies`); a map whose masks already
    // match goes in byte for byte. The script stays as it is: when its priorities aren't those, it
    // was made from other start locations or players; only the app's generator makes it again (its
    // save, and `w3proj pack` before it packs, for a script Studio wrote).
    let worked = encoded
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("war3map.w3i"))
        .and_then(|(k, w3i)| Some((k.clone(), allies::pack_w3i(w3i, codecs)?)));
    if let Some((key, worked)) = worked {
        for (name, script) in encoded.iter().filter(|(k, _)| k.eq_ignore_ascii_case("war3map.j") || k.eq_ignore_ascii_case("war3map.lua")) {
            let what = match allies::script_agrees(&worked, script, codecs) {
                allies::ScriptPriorities::Agree => continue,
                allies::ScriptPriorities::Disagree => "doesn't set",
                allies::ScriptPriorities::Unknown => "can't be told to set",
            };
            warnings.push(format!(
                "{MAP_DIR}/{name}: InitAllyPriorities {what} the ally priorities this pack worked out for war3map.w3i from the \
                 players' start locations; the script goes in as the project has it (only the script W3Proj Studio wrote last \
                 is made again, by its save and by `w3proj pack`): Generate Map Script in W3Proj Studio replaces it"
            ));
        }
        encoded.insert(key, worked);
    }
    let maps_dir = project.join(MAPS_DIR);
    for dir in nested_projects(&maps_dir)? {
        let name = paths::to_archive_name(&dir);
        if encoded.keys().any(|k| k.eq_ignore_ascii_case(&name)) {
            return Err(Error::Project(format!(
                "{MAPS_DIR}/{dir} and {MAP_DIR}/{dir} both map to archive file {name}"
            )));
        }
        let mut inner = Vec::new();
        let (bytes, _) = pack_bytes_with(&maps_dir.join(&dir), codecs, None, &mut inner, attributes)?;
        warnings.extend(inner.into_iter().map(|w| format!("{MAPS_DIR}/{dir}/{w}")));
        encoded.insert(name, bytes);
    }
    let count = encoded.len();
    Ok((build_archive_with(&manifest, &prefix, encoded, attributes)?, count))
}

/// Builds an extracted archive again in memory (chapter maps included).
fn pack_extracted(ex: &Extracted, codecs: &Registry) -> Result<Vec<u8>> {
    let mut encoded = encode_files(&ex.files, &ex.manifest.pack.raw, codecs)?;
    for (dir, inner) in &ex.nested {
        encoded.insert(paths::to_archive_name(dir), pack_extracted(inner, codecs)?);
    }
    build_archive(&ex.manifest, &prefix_of(ex), encoded)
}

fn prefix_of(ex: &Extracted) -> Vec<u8> {
    ex.raw_header
        .clone()
        .or_else(|| ex.manifest.map.as_ref().map(|m| m.to_bytes()))
        .unwrap_or_default()
}

/// Packs the project's files as they are (the app drops unused strings in the project first), with
/// the ally priorities in war3map.w3i the World Editor's save works out (`allies`).
pub fn pack(project: &Path, output: Option<&Path>, codecs: &Registry) -> Result<PackReport> {
    pack_with(project, output, codecs, PackOptions::default())
}

/// Packs with the strings nothing refers to left out of war3map.wts, as the World Editor's save
/// and the app's packing drop them (`wts`); the project's files stay as they are. Chapter maps
/// and war3campaign.wts aren't pruned.
pub fn pack_pruned(project: &Path, output: Option<&Path>, codecs: &Registry) -> Result<PackReport> {
    pack_with(project, output, codecs, PackOptions { prune: true, ..PackOptions::default() })
}

/// How `pack_with` packs. The default is `pack`.
#[derive(Debug, Clone, Copy, Default)]
pub struct PackOptions {
    /// As `pack_pruned`.
    pub prune: bool,
    /// The map (and its chapter maps) gets an (attributes) as a World Editor save has it: a CRC32 per block and no
    /// time stamps, so packing twice still gives the same bytes (`build_archive_with`).
    pub attributes: bool,
}

pub fn pack_with(project: &Path, output: Option<&Path>, codecs: &Registry, options: PackOptions) -> Result<PackReport> {
    pack_to(project, output, codecs, options.prune, options.attributes)
}

/// Whether `project` is a chapter map of a campaign project (`<campaign>/maps/<chapter>`).
fn is_chapter_project(project: &Path) -> bool {
    let abs = project.canonicalize().unwrap_or_else(|_| project.to_path_buf());
    abs.parent()
        .filter(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case(MAPS_DIR)))
        .and_then(Path::parent)
        .is_some_and(|campaign| campaign.join(MANIFEST).is_file())
}

fn pack_to(project: &Path, output: Option<&Path>, codecs: &Registry, prune: bool, attributes: bool) -> Result<PackReport> {
    let manifest = Manifest::load(project)?;
    let mut outcome = wts::PruneOutcome::default();
    // A chapter map packed on its own comes out as the campaign packs it (and the app exports it).
    let chapter = prune && is_chapter_project(project);
    if chapter {
        outcome.kept = Some("a campaign's chapter maps aren't pruned".into());
    }
    let mut warnings = Vec::new();
    let (bytes, count) = pack_bytes_with(project, codecs, (prune && !chapter).then_some(&mut outcome), &mut warnings, attributes)?;
    let output = match output {
        Some(o) => o.to_path_buf(),
        None => default_output(project, &manifest)?,
    };
    // Flushed to disk before it takes the old archive's place, under a hidden temporary name
    // (`crate::atomic`).
    write_atomic(&output, &bytes)?;
    Ok(PackReport {
        output,
        files: count,
        bytes: bytes.len(),
        strings: prune.then_some(outcome),
        warnings,
    })
}

#[derive(Debug, Serialize)]
pub struct VerifyReport {
    pub files: usize,
    pub codec_files: usize,
    pub codec_fallbacks: Vec<(String, String)>,
    /// Every file a codec claims (chapter maps' files as `<chapter folder>/<name>`): the codec
    /// that read it, or `raw` when it fell back.
    pub codec_use: Vec<(String, String)>,
    pub mismatches: Vec<String>,
    pub unnamed: usize,
    pub errors: Vec<(String, String)>,
    /// `TRIGSTR_<n>` references whose string isn't in the map's war3map.wts (a campaign's own
    /// files: war3campaign.wts), as `TRIGSTR_<n>`; chapter maps' as `<chapter folder>/TRIGSTR_<n>`.
    pub unresolved_strings: Vec<String>,
    /// Maps (`""`: the map itself, else the chapter folder) whose references couldn't be told, and why.
    pub strings_unchecked: Vec<(String, String)>,
    /// What the checks did to their copy of the map (creation numbers renumbered before the split round trip).
    pub notes: Vec<String>,
}

impl VerifyReport {
    pub fn ok(&self) -> bool {
        self.mismatches.is_empty()
    }
}

/// Files of `ex` that differ between the original and the repacked archive. Chapter maps are
/// compared file by file (they are packed anew, so their archive bytes differ).
fn compare(original: &Archive, packed: &Archive, ex: &Extracted, at: &str, out: &mut Vec<String>) {
    if packed.prefix() != &prefix_of(ex)[..] {
        out.push(format!("{at}<map header>"));
    }
    for f in &ex.report.files {
        let a = original.read(&f.archive_name).ok();
        let b = packed.read(&f.archive_name).ok();
        let inner = ex.nested.iter().find(|(dir, _)| paths::to_archive_name(dir) == f.archive_name);
        match (inner, a, b) {
            (Some((_, inner)), Some(a), Some(b)) => match (Archive::from_bytes(a), Archive::from_bytes(b)) {
                (Ok(a), Ok(b)) => compare(&a, &b, inner, &format!("{at}{}/", f.archive_name), out),
                _ => out.push(format!("{at}{}", f.archive_name)),
            },
            (None, Some(a), b) if Some(&a) == b.as_ref() => {}
            _ => out.push(format!("{at}{}", f.archive_name)),
        }
    }
}

/// Unpacks and repacks a map in memory and checks every file survives.
/// Codec per file that some codec claims, chapter maps included (see `VerifyReport::codec_use`).
fn codec_use(ex: &Extracted, codecs: &Registry) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = ex
        .report
        .files
        .iter()
        .filter(|f| f.codec.is_some() || codecs.for_archive_name(&f.archive_name).next().is_some())
        .map(|f| (f.archive_name.clone(), f.codec.clone().unwrap_or_else(|| "raw".into())))
        .collect();
    for (dir, chapter) in &ex.nested {
        out.extend(codec_use(chapter, codecs).into_iter().map(|(name, c)| (format!("{dir}/{name}"), c)));
    }
    out
}

/// Errs when `ex` isn't a map or campaign: its info file (war3map.w3i, war3campaign.w3f) isn't
/// there or can't be read. The archive reader takes what it can from a damaged file (protected
/// maps carry bogus tables), so a truncated map opens as an archive with no files at all.
fn check_readable(ex: &Extracted) -> Result<()> {
    const INFO: [&str; 2] = ["war3map.w3i", "war3campaign.w3f"];
    let is_info = |name: &str| INFO.iter().any(|i| name.eq_ignore_ascii_case(i));
    if ex.report.files.iter().any(|f| is_info(&f.archive_name)) {
        return Ok(());
    }
    if let Some((name, why)) = ex.report.errors.iter().find(|(name, _)| is_info(name)) {
        return Err(Error::Format(format!("not a readable map: {name} can't be read ({why})")));
    }
    let (files, unnamed) = (ex.report.files.len(), ex.report.unnamed.len());
    Err(Error::Format(if files + unnamed + ex.report.errors.len() == 0 {
        "not a readable map: the archive lists no files (truncated or damaged)".into()
    } else {
        format!("not a readable map: no war3map.w3i or war3campaign.w3f among its {files} files ({unnamed} unnamed, {} unreadable)", ex.report.errors.len())
    }))
}

/// `TRIGSTR_<n>` references of `ex` (chapter maps too) that its string table lacks, into
/// `unresolved` with `at` before each; maps whose references can't be told into `unchecked`.
fn unresolved_strings(ex: &Extracted, codecs: &Registry, at: &str, unresolved: &mut Vec<String>, unchecked: &mut Vec<(String, String)>) {
    match wts::map_string_refs(&ex.files, codecs) {
        Err(why) => unchecked.push((at.trim_end_matches('/').to_string(), why)),
        Ok(refs) => {
            let table = ex
                .files
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("war3map.wts") || k.eq_ignore_ascii_case("war3campaign.wts"))
                .map(|(_, bytes)| wts::strings(&crate::lossless::decode(bytes)))
                .unwrap_or_default();
            unresolved.extend(refs.iter().filter(|n| !table.contains_key(n)).map(|n| format!("{at}TRIGSTR_{:0>3}", n.to_string())));
        }
    }
    for (dir, chapter) in &ex.nested {
        unresolved_strings(chapter, codecs, &format!("{at}{dir}/"), unresolved, unchecked);
    }
}

/// The map's terrain and placed objects (chapter maps' too) split into the `map/terrain/` layout as a
/// 2×2 grid and read back (`terrain_layout::split`, then `flatten` as `read_project` reads it): the
/// project files have to come back byte for byte, and the map packed from them has to be the one
/// packed from the flat files. The derived files go into the store and back (`derived::take`, as
/// a split moves them), and a Pathing tool file with overrides over the seams
/// (`terrain_pathing::sample_json`) into the subterrains' `pathing.txt` and back, byte for byte. Between the
/// split and the merge the subterrains are joined, renamed and resized (`terrain_layout::relayout`), which must
/// change nothing either. A terrain kept raw has nothing to split. A map whose placed objects share creation numbers
/// (which a split refuses) is first renumbered on this copy as `w3proj terrain fix-ids --renumber` would
/// (`terrain_ids::renumber_flat_files`), said in `notes`; the round trip then must give back the renumbered files.
fn split_terrain_round_trip(ex: &Extracted, codecs: &Registry, at: &str, out: &mut Vec<String>, notes: &mut Vec<String>) {
    use crate::terrain_layout as tl;
    let text = ex.files.keys().find(|k| k.eq_ignore_ascii_case(tl::FLAT_FILE));
    if let Some(text) = text.filter(|k| !ex.manifest.pack.raw.contains(k)) {
        let result = w3e::terrain_from_text(&ex.files[text]).and_then(|t| {
            let mut base = ex.files.clone();
            let (renumbered, groups) = crate::terrain_ids::renumber_flat_files(&mut base)?;
            if renumbered > 0 {
                notes.push(format!("{at}renumbered {renumbered} creation numbers in {groups} groups found twice before splitting (on the copy; fix-ids)"));
            }
            let mut files = base.clone();
            tl::split(&mut files, &tl::grid_2x2(t.width, t.height))?;
            let store = crate::derived::take(&mut files);
            if let Some(json) = crate::terrain_pathing::sample_json([t.width, t.height]) {
                let layout = tl::Layout::parse(&files[tl::LAYOUT_FILE])?;
                let sliced = crate::terrain_pathing::slice(&json, &layout)?;
                if crate::terrain_pathing::assemble(&layout, &|p| sliced.get(p).cloned())?.as_deref() != Some(&json[..]) {
                    return Ok(Some("pathing.json"));
                }
                files.extend(sliced);
            }
            // Then the subterrains changed as the Subterrains commands change them (`terrain_layout::relayout`): the south
            // two joined, the north-west renamed and grown one corner east, the north-east shrunk to make room.
            if let [sw, _, nw, _] = &tl::grid_2x2(t.width, t.height)[..] {
                let grow = usize::from(nw.w + 1 < t.width);
                let plan: Vec<tl::Planned> = [
                    format!("south=sw+se:0,0,{},{}", t.width, sw.h),
                    format!("west=nw:0,{},{},{}", nw.y, nw.w + grow, nw.h),
                    format!("ne:{},{},{},{}", nw.w + grow, nw.y, t.width - nw.w - grow, nw.h),
                ]
                .iter()
                .map(|s| s.parse().map_err(Error::Project))
                .collect::<Result<_>>()?;
                tl::relayout(&mut files, &plan)?;
            }
            // And Map Size: grown by two tiles on every side and cut back, the same files (`terrain_layout::write_flat`).
            if !tl::map_size_round_trip(&files, 2)? {
                return Ok(Some("split layout after Map Size grew and shrank it"));
            }
            tl::flatten(&mut files)?;
            files.extend(store);
            if files != base {
                return Ok(Some("project files"));
            }
            let packed = |files: &BTreeMap<String, Vec<u8>>| -> Result<Vec<u8>> {
                let mut encoded = encode_files(files, &ex.manifest.pack.raw, codecs)?;
                for (dir, inner) in &ex.nested {
                    encoded.insert(paths::to_archive_name(dir), pack_extracted(inner, codecs)?);
                }
                build_archive(&ex.manifest, &prefix_of(ex), encoded)
            };
            Ok((packed(&files)? != packed(&base)?).then_some("packed map"))
        });
        match result {
            Ok(None) => {}
            Ok(Some(what)) => out.push(format!("{at}war3map.w3e and placed objects (split into map/terrain/ and merged: another {what})")),
            Err(e) => out.push(format!("{at}war3map.w3e and placed objects (split into map/terrain/: {e})")),
        }
    }
    for (dir, chapter) in &ex.nested {
        split_terrain_round_trip(chapter, codecs, &format!("{at}{dir}/"), out, notes);
    }
}

/// Check Trigger Tree on a map's unpacked trigger folders (and its chapters'): an import is never reported, its
/// categories' shared ids neither; anything found is a mismatch.
fn trigger_tree_clean(ex: &Extracted, codecs: &Registry, at: &str, out: &mut Vec<String>) {
    use crate::trigger_layout as tl;
    if tl::is_layout(&ex.files, &ex.manifest.pack.raw) {
        for issue in crate::trigger_check::check(&ex.files, Some(tl::language(&ex.files, codecs))) {
            out.push(format!("{at}map/triggers/ (Check Trigger Tree reports an import): {issue}"));
        }
    }
    for (dir, chapter) in &ex.nested {
        trigger_tree_clean(chapter, codecs, &format!("{at}{dir}/"), out);
    }
}

pub fn verify(map: &Path, codecs: &Registry, more_names: Option<&NameSource>) -> Result<VerifyReport> {
    let archive = Archive::open(map)?;
    let ex = extract_named(&archive, codecs, more_names);
    check_readable(&ex)?;
    let (mut unresolved, mut strings_unchecked) = (Vec::new(), Vec::new());
    unresolved_strings(&ex, codecs, "", &mut unresolved, &mut strings_unchecked);
    let packed = Archive::from_bytes(pack_extracted(&ex, codecs)?)?;
    let mut mismatches = Vec::new();
    compare(&archive, &packed, &ex, "", &mut mismatches);
    trigger_tree_clean(&ex, codecs, "", &mut mismatches);
    let mut notes = Vec::new();
    split_terrain_round_trip(&ex, codecs, "", &mut mismatches, &mut notes);
    Ok(VerifyReport {
        files: ex.report.files.len(),
        codec_files: ex.report.files.iter().filter(|f| f.codec.is_some()).count(),
        codec_fallbacks: ex
            .report
            .files
            .iter()
            .filter_map(|f| Some((f.archive_name.clone(), f.note.clone()?)))
            .collect(),
        codec_use: codec_use(&ex, codecs),
        mismatches,
        unnamed: ex.report.unnamed.len(),
        errors: ex.report.errors,
        unresolved_strings: unresolved,
        strings_unchecked,
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::{decode, encode, load_definitions};

    fn w3i_bytes(version: u32, editor_version: u32) -> Vec<u8> {
        let def = load_definitions(&[]).unwrap().into_iter().find(|d| d.name == "w3i").unwrap();
        let mut doc = serde_json::json!({
            "format": "w3proj.mapinfo/1",
            "version": version,
            "saves": 1,
            "editorVersion": editor_version,
            "name": "Map",
            "author": "A",
            "description": "D",
            "suggestedPlayers": "1",
            "cameraBounds": [-128.0, -128.0, 128.0, 128.0, -128.0, 128.0, 128.0, -128.0],
            "cameraComplements": [1, 1, 1, 1],
            "playableWidth": 2,
            "playableHeight": 2,
            "flags": 0,
            "tileset": "L",
            "loadingScreen": { "number": -1, "model": "", "text": "", "title": "", "subtitle": "" },
            "gameDataSet": 0,
            "prologue": { "path": "", "text": "", "title": "", "subtitle": "" },
            "fog": { "style": 0, "start": 3000.0, "end": 5000.0, "density": 0.5, "color": [255, 255, 255, 255] },
            "weather": "0x00000000",
            "soundEnvironment": "",
            "lightEnvironment": "",
            "waterTint": [255, 255, 255, 255],
            "players": [{ "id": 0, "controller": 1, "race": 1, "fixedStart": 0, "name": "P1", "start": [0.0, 0.0], "allyLow": 0, "allyHigh": 0 }],
            "forces": [{ "flags": 0, "players": 1, "name": "F1" }],
            "upgrades": [],
            "techs": [],
            "unitTables": [],
            "itemTables": [],
        });
        let o = doc.as_object_mut().unwrap();
        if version >= 27 {
            o.insert("gameVersion".into(), serde_json::json!([1, 32, 0, 0]));
        }
        if version >= 28 {
            o.insert("scriptType".into(), serde_json::json!(0));
        }
        if version >= 31 {
            o.insert("supportedModes".into(), serde_json::json!(3));
            o.insert("gameDataVersion".into(), serde_json::json!(1));
            let p = o.get_mut("players").unwrap().as_array_mut().unwrap()[0].as_object_mut().unwrap();
            p.insert("enemyLow".into(), serde_json::json!(0));
            p.insert("enemyHigh".into(), serde_json::json!(0));
        }
        encode(&def, &doc).unwrap()
    }

    fn empty_v8_doo(with_specials: bool) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"W3do");
        out.extend_from_slice(&8u32.to_le_bytes());
        out.extend_from_slice(&11u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        if with_specials {
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
        }
        out
    }

    fn non_empty_v8_skin_unit() -> Vec<u8> {
        let def = load_definitions(&[]).unwrap().into_iter().find(|d| d.name == "units").unwrap();
        let doc = serde_json::json!({
            "format": "w3proj.units/1",
            "magic": "W3do",
            "version": 8,
            "subversion": 11,
            "skinIds": true,
            "units": [{
                "id": "sloc",
                "variation": 0,
                "position": [0.0, 0.0, 0.0],
                "angle": 4.712389,
                "scale": [1.0, 1.0, 1.0],
                "skinId": "sloc",
                "flags": 2,
                "player": 0,
                "unknown1": 0,
                "unknown2": 0,
                "hp": -1,
                "mana": -1,
                "itemTable": -1,
                "itemSets": [],
                "gold": 0,
                "targetAcquisition": 0.0,
                "level": 0,
                "strength": 0,
                "agility": 0,
                "intelligence": 0,
                "inventory": [],
                "abilities": [],
                "randomType": 0,
                "randomLevel": "010000",
                "randomClass": 0,
                "color": -1,
                "waygate": -1,
                "editorId": 0
            }]
        });
        encode(&def, &doc).unwrap()
    }

    fn skin_ids_field(ex: &Extracted, path: &str) -> bool {
        let v: serde_json::Value = serde_json::from_slice(&ex.files[path]).unwrap();
        v["skinIds"].as_bool().unwrap()
    }

    fn make_archive(w3i: Option<&[u8]>, units: &[u8], doodads: &[u8]) -> Archive {
        let mut b = ArchiveBuilder::new(WriteOptions::default());
        if let Some(w3i) = w3i {
            b.add("war3map.w3i", w3i.to_vec());
        }
        b.add("war3map.doo", doodads.to_vec());
        b.add("war3mapUnits.doo", units.to_vec());
        b.add("war3map.j", b"function main takes nothing returns nothing\nendfunction\n".to_vec());
        let bytes = b.write(b"HM3W\0\0\0\0").unwrap();
        Archive::from_bytes(bytes).unwrap()
    }

    #[test]
    fn empty_v8_placements_follow_war3map_w3i_editor_version() {
        let codecs = Registry::with_formats(&[]).unwrap();
        let doo = empty_v8_doo(true);
        let units = empty_v8_doo(false);

        for (ver, ed, want) in [(25, 6059, false), (28, 6088, false), (28, 6089, true), (31, 6114, true)] {
            let w3i = w3i_bytes(ver, ed);
            let ar = make_archive(Some(&w3i), &units, &doo);
            let ex = extract_with(&ar, &codecs, &[]);
            assert_eq!(skin_ids_field(&ex, "war3map.doo.json"), want, "archive doo v{ver} ed{ed}");
            assert_eq!(skin_ids_field(&ex, "war3mapUnits.doo.json"), want, "archive units v{ver} ed{ed}");
            let packed = pack_extracted(&ex, &codecs).unwrap();
            let repacked = Archive::from_bytes(packed).unwrap();
            assert_eq!(repacked.read("war3map.doo").unwrap(), doo);
            assert_eq!(repacked.read("war3mapUnits.doo").unwrap(), units);

            // Folder unpack produces the same resolution.
            let dir = std::env::temp_dir().join(format!("w3proj-v8-dir-{ver}-{ed}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("war3map.w3i"), &w3i).unwrap();
            fs::write(dir.join("war3map.doo"), &doo).unwrap();
            fs::write(dir.join("war3mapUnits.doo"), &units).unwrap();
            let ex_dir = extract_dir(&dir, &codecs).unwrap();
            let _ = fs::remove_dir_all(&dir);
            assert_eq!(skin_ids_field(&ex_dir, "war3map.doo.json"), want, "dir doo v{ver} ed{ed}");
            assert_eq!(skin_ids_field(&ex_dir, "war3mapUnits.doo.json"), want, "dir units v{ver} ed{ed}");
        }

        // Absent war3map.w3i defaults conservatively to false.
        let ar_absent = make_archive(None, &units, &doo);
        let ex_absent = extract_with(&ar_absent, &codecs, &[]);
        assert!(!skin_ids_field(&ex_absent, "war3map.doo.json"));
        assert!(!skin_ids_field(&ex_absent, "war3mapUnits.doo.json"));
        let u_info = &ex_absent.report.files.iter().find(|f| f.archive_name == "war3mapUnits.doo").unwrap().info;
        assert!(u_info.iter().any(|s| s.contains("absent")), "{u_info:?}");

        // Unreadable war3map.w3i keeps false and reports unreadable rather than absent.
        let ar_bad = make_archive(Some(b"truncated"), &units, &doo);
        let ex_bad = extract_with(&ar_bad, &codecs, &[]);
        assert!(!skin_ids_field(&ex_bad, "war3map.doo.json"));
        assert!(!skin_ids_field(&ex_bad, "war3mapUnits.doo.json"));
        let u_info = &ex_bad.report.files.iter().find(|f| f.archive_name == "war3mapUnits.doo").unwrap().info;
        assert!(u_info.iter().any(|s| s.contains("unreadable")), "{u_info:?}");

        // Non-empty Reforged v8 file preserves skinIds: true byte-exact even when decoded standalone.
        let non_empty = non_empty_v8_skin_unit();
        let def_units = load_definitions(&[]).unwrap().into_iter().find(|d| d.name == "units").unwrap();
        let dec = decode(&def_units, &non_empty).unwrap();
        assert_eq!(dec.value["skinIds"], true);
        assert_eq!(encode(&def_units, &dec.value).unwrap(), non_empty);
    }

    /// The w3i of a protected map, cut by its protector, stays raw and packs back unchanged. Every map of the
    /// campaign "The Chosen Ones" (corpus, all four versions; protected: script moved to `scripts\war3map.j`, no
    /// trigger files, files without names in some chapters) ends its v25 w3i after the forces with one byte 0xff
    /// where the upgrade, techtree, random group and item table counts belong. No World Editor writes that, and a
    /// typed form would hide that the tables are gone (adding one there would change the layout), so raw is
    /// right; tests/corpus-baseline.tsv records them as `raw`.
    #[test]
    fn protector_cut_w3i_stays_raw_and_packs_back_unchanged() {
        let codecs = Registry::with_formats(&[]).unwrap();
        let whole = w3i_bytes(25, 6059);
        // The four table counts (all zero here) are the last 16 bytes; the protector left one 0xff instead.
        assert!(whole.ends_with(&[0; 16]));
        let mut cut = whole[..whole.len() - 16].to_vec();
        cut.push(0xff);
        for (w3i, want) in [(&whole, Some("format:w3i")), (&cut, None)] {
            let ar = make_archive(Some(w3i), &empty_v8_doo(false), &empty_v8_doo(true));
            let ex = extract_with(&ar, &codecs, &[]);
            let entry = ex.report.files.iter().find(|f| f.archive_name == "war3map.w3i").unwrap();
            assert_eq!(entry.codec.as_deref(), want, "{entry:?}");
            if want.is_none() {
                assert_eq!(ex.files.get("war3map.w3i"), Some(w3i), "kept as the raw bytes");
                assert!(!ex.files.contains_key("war3map.w3i.json"));
                assert!(entry.note.as_deref().is_some_and(|n| n.contains("unexpected end of file")), "{entry:?}");
            }
            let repacked = Archive::from_bytes(pack_extracted(&ex, &codecs).unwrap()).unwrap();
            assert_eq!(&repacked.read("war3map.w3i").unwrap(), w3i);
        }
    }

    /// verify's split-terrain round trip (terrain and placed objects) passes a map whose files come back, and
    /// reports one whose project files don't (a terrain text, or an object file, that isn't the one unpack
    /// writes, so the merged text differs) or that can't be split.
    #[test]
    fn verify_splits_the_terrain_and_reports_what_doesnt_come_back() {
        let mini = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mini-map/map");
        let codecs = Registry::default();
        let text = fs::read(mini.join("war3map.w3e.txt")).unwrap();
        let mut b = ArchiveBuilder::new(WriteOptions::default());
        b.add("war3map.w3e", w3e::from_text(&text).unwrap());
        b.add("war3map.w3i", w3i_bytes(31, 6114));
        for name in ["war3map.doo", "war3mapUnits.doo", "war3map.w3r"] {
            let json = fs::read(mini.join(format!("{name}.json"))).unwrap();
            b.add(name, codecs.for_project_path(&format!("{name}.json")).unwrap().1.encode(name, &json).unwrap());
        }
        let archive = b.write(b"").unwrap();
        let ex = extract_with(&Archive::from_bytes(archive.clone()).unwrap(), &codecs, &[]);
        assert_eq!(ex.files["war3map.w3e.txt"], text);
        assert!(ex.files.contains_key("war3map.doo.json") && ex.files.contains_key("war3mapUnits.doo.json") && ex.files.contains_key("war3map.w3r.json"));
        let mut out = Vec::new();
        let mut notes = Vec::new();
        split_terrain_round_trip(&ex, &codecs, "", &mut out, &mut notes);
        assert!(out.is_empty() && notes.is_empty(), "{out:?} {notes:?}");
        // Three doodads sharing a creation number (a real map's pattern, which a split refuses): renumbered on the copy,
        // said, and the round trip passes; the map's own files are untouched.
        let mut twins = extract_with(&Archive::from_bytes(archive).unwrap(), &codecs, &[]);
        let doo = String::from_utf8(twins.files["war3map.doo.json"].clone()).unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&doo).unwrap();
        let first = v["doodads"][1].clone();
        let mut lt = first.clone();
        lt["editorId"] = 581.into();
        let mut other = lt.clone();
        other["variation"] = 3.into();
        v["doodads"].as_array_mut().unwrap().extend([other, lt.clone(), lt]);
        let bytes = codecs.for_project_path("war3map.doo.json").unwrap().1.encode("war3map.doo", &serde_json::to_vec(&v).unwrap()).unwrap();
        let canonical = codecs.for_project_path("war3map.doo.json").unwrap().1.decode("war3map.doo", &bytes).unwrap();
        twins.files.insert("war3map.doo.json".into(), canonical.clone());
        split_terrain_round_trip(&twins, &codecs, "", &mut out, &mut notes);
        assert!(out.is_empty(), "{out:?}");
        assert_eq!(notes, ["renumbered 2 creation numbers in 1 groups found twice before splitting (on the copy; fix-ids)"]);
        assert_eq!(twins.files["war3map.doo.json"], canonical, "the map's files aren't changed");
        let mut odd = ex;
        odd.files.insert("war3map.w3e.txt".into(), [&b"# a comment\n"[..], &text].concat());
        split_terrain_round_trip(&odd, &codecs, "", &mut out, &mut Vec::new());
        assert_eq!(out, vec!["war3map.w3e and placed objects (split into map/terrain/ and merged: another project files)".to_string()]);
        // An object file in another form than unpack writes (the same JSON on one line).
        odd.files.insert("war3map.w3e.txt".into(), text.clone());
        let units: serde_json::Value = serde_json::from_slice(&odd.files["war3mapUnits.doo.json"]).unwrap();
        odd.files.insert("war3mapUnits.doo.json".into(), serde_json::to_vec(&units).unwrap());
        out.clear();
        split_terrain_round_trip(&odd, &codecs, "", &mut out, &mut Vec::new());
        assert_eq!(out, vec!["war3map.w3e and placed objects (split into map/terrain/ and merged: another project files)".to_string()]);
        // One that can't be split.
        odd.files.insert("war3mapUnits.doo.json".into(), b"{ broken".to_vec());
        out.clear();
        split_terrain_round_trip(&odd, &codecs, "", &mut out, &mut Vec::new());
        assert!(out.len() == 1 && out[0].contains("war3mapUnits.doo.json can't go into map/terrain/"), "{out:?}");
    }
}
