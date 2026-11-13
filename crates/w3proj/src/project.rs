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
use crate::{names, paths, wts, Error, Result};

pub const MANIFEST: &str = "w3proj.toml";
pub const MAP_DIR: &str = "map";
pub const UNNAMED_DIR: &str = "unnamed";
pub const MAPS_DIR: &str = "maps";
pub const HEADER_FILE: &str = "header.bin";
pub const FORMAT_VERSION: u32 = 1;

/// Whether something is at `path`. A path that can't be checked (a folder above it may not be looked
/// into) is an error, never "not there": what is taken for absent gets created or written over.
fn there(path: &Path) -> Result<bool> {
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
    for codec in codecs.for_archive_name(name) {
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

/// What follows reading a map's files: trigger names in the custom script, chapter maps as
/// projects, raw marks, the header and the manifest. `prefix`: the bytes before the archive.
fn finish(
    mut files: BTreeMap<String, Vec<u8>>,
    unnamed: BTreeMap<String, Vec<u8>>,
    mut report: UnpackReport,
    prefix: &[u8],
    sector_size_shift: u16,
    codecs: &Registry,
    extra: &[String],
) -> Extracted {
    // Custom script sections get their triggers' names (comments; only when the wtg was decoded).
    let names = files.get("war3map.wtg.json").and_then(|j| crate::wtg::text_trigger_names(j));
    if let (Some(names), Some(text)) = (names, files.get("war3map.wct.txt")) {
        if let Ok(named) = crate::wct::with_names(text, &names) {
            files.insert("war3map.wct.txt".into(), named);
        }
    }

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

    // A raw file whose path looks like a codec output must be marked raw.
    let mut raw = Vec::new();
    for e in &report.files {
        if e.codec.is_none() && codecs.for_project_path(&e.project_path).is_some() {
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

/// Replaces `path` in one step: the bytes go to a temporary file next to it (same folder, so the same
/// file system), flushed to disk, then renamed over it. A crash mid-write leaves the old file whole
/// (and maybe the temporary file), never a truncated one. `fs::rename` replaces an existing file on
/// Windows too (MoveFileEx with MOVEFILE_REPLACE_EXISTING).
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // One temporary name per process and call, so two writers never share one.
    static COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(".{name}.{}-{n}.tmp", std::process::id()));
    let done = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        // The new file is made with default permissions: the old file's go over to it (a manifest the
        // user made private stays private). Unix only: on Windows the only one is read-only, which a
        // rename over the file would fail on anyway.
        #[cfg(unix)]
        if let Ok(old) = fs::metadata(path) {
            fs::set_permissions(&tmp, old.permissions())?;
        }
        fs::rename(&tmp, path)
    })();
    if let Err(e) = done {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

fn walk(root: &Path) -> Result<Vec<String>> {
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

/// The archive file a project path packs into, lowercased (as `encode_files` names it).
fn archive_key(path: &str, raw: &[String], codecs: &Registry) -> String {
    let name = match codecs.for_project_path(path) {
        Some((stem, _)) if !raw.iter().any(|r| r == path) => paths::to_archive_name(&stem),
        _ => paths::to_archive_name(path),
    };
    name.to_ascii_lowercase()
}

/// What syncing `ex` into `project` would delete under `map/` and `maps/`: the files the user may
/// have added there whose archive file the map doesn't have, from the project root with `/`. A file
/// only written in another form (e.g. `war3map.wtg` raw instead of `war3map.wtg.json`) isn't lost
/// and isn't in it. A chapter map's whole project folder ends in `/`. Strays aren't in it: they are
/// never deleted.
pub fn would_delete(project: &Path, ex: &Extracted, codecs: &Registry) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let kept: BTreeSet<String> = ex.files.keys().map(|p| archive_key(p, &ex.manifest.pack.raw, codecs)).collect();
    // Raw files as the project on disk has them; a manifest that can't be read stops the sync anyway.
    let old_raw = Manifest::load(project).map(|m| m.pack.raw).unwrap_or_default();
    let (gone, _) = extra_files(&project.join(MAP_DIR), &ex.files)?;
    out.extend(
        gone.into_iter()
            .filter(|p| !kept.contains(&archive_key(p, &old_raw, codecs)))
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
*.lua diff
*.json diff
*.txt diff
*.wts diff
*.fdf diff
*.toc diff
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

/// The default `.gitattributes` before the LFS rules: replaced by the current one on the next
/// sync (a changed file is left alone).
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

const GITIGNORE: &str = "build/\n";

/// Writes an extracted archive into a project directory. Existing pack
/// settings in the manifest are kept.
pub fn write_files(project: &Path, ex: Extracted) -> Result<UnpackReport> {
    write_project(project, ex, true)
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

/// `top`: the project itself (gets git files), not a chapter map inside a campaign.
fn write_project(project: &Path, mut ex: Extracted, top: bool) -> Result<UnpackReport> {
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
        let outdated = name == ".gitattributes" && fs::read(&p).is_ok_and(|old| old == GITATTRIBUTES_V1.as_bytes());
        if !there(&p)? || outdated {
            write_atomic(&p, text.as_bytes())?;
        }
    }
    let mut report = ex.report;
    sync_dir(&project.join(MAP_DIR), MAP_DIR, &ex.files, &mut report)?;
    // The map's pathing, shadows and minimap came with its terrain and doodads: they follow these (`derived`).
    crate::derived::record_now(project)?;
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
    for (dir, inner) in std::mem::take(&mut ex.nested) {
        let r = write_project(&maps_dir.join(&dir), inner, false)?;
        report.written += r.written;
        report.unchanged += r.unchanged;
        report.deleted += r.deleted;
        report.strays.extend(r.strays.into_iter().map(|p| format!("{MAPS_DIR}/{dir}/{p}")));
    }
    remove_empty_dirs(&maps_dir);
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
    write_files(project, ex)
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
    if there(project)? && fs::read_dir(project)?.next().is_some() {
        return Err(Error::Project(format!("{} is not empty", project.display())));
    }
    fs::create_dir_all(project.join(MAP_DIR))?;
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

/// Builds a project's archive (chapter maps under `maps/` are packed into it first).
fn pack_bytes(project: &Path, codecs: &Registry) -> Result<(Vec<u8>, usize)> {
    pack_bytes_with(project, codecs, None)
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

/// `prune`: the map's war3map.wts goes into the archive without the strings nothing refers to
/// (`wts::prune_files`; the project's files stay as they are), and what that did is put there.
/// Chapter maps are packed as they are.
fn pack_bytes_with(project: &Path, codecs: &Registry, prune: Option<&mut wts::PruneOutcome>) -> Result<(Vec<u8>, usize)> {
    let (manifest, prefix, mut files) = read_project(project)?;
    if let Some(outcome) = prune {
        *outcome = wts::prune_files(&mut files, read_pruned_record(project), codecs);
    }
    let mut encoded = encode_files(&files, &manifest.pack.raw, codecs)?;
    let maps_dir = project.join(MAPS_DIR);
    for dir in nested_projects(&maps_dir)? {
        let name = paths::to_archive_name(&dir);
        if encoded.keys().any(|k| k.eq_ignore_ascii_case(&name)) {
            return Err(Error::Project(format!(
                "{MAPS_DIR}/{dir} and {MAP_DIR}/{dir} both map to archive file {name}"
            )));
        }
        let (bytes, _) = pack_bytes(&maps_dir.join(&dir), codecs)?;
        encoded.insert(name, bytes);
    }
    let count = encoded.len();
    Ok((build_archive(&manifest, &prefix, encoded)?, count))
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

/// Packs the project's files as they are (the app drops unused strings in the project first).
pub fn pack(project: &Path, output: Option<&Path>, codecs: &Registry) -> Result<PackReport> {
    pack_to(project, output, codecs, false)
}

/// Packs with the strings nothing refers to left out of war3map.wts, as the World Editor's save
/// and the app's packing drop them (`wts`); the project's files stay as they are. Chapter maps
/// and war3campaign.wts aren't pruned.
pub fn pack_pruned(project: &Path, output: Option<&Path>, codecs: &Registry) -> Result<PackReport> {
    pack_to(project, output, codecs, true)
}

/// Whether `project` is a chapter map of a campaign project (`<campaign>/maps/<chapter>`).
fn is_chapter_project(project: &Path) -> bool {
    let abs = project.canonicalize().unwrap_or_else(|_| project.to_path_buf());
    abs.parent()
        .filter(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case(MAPS_DIR)))
        .and_then(Path::parent)
        .is_some_and(|campaign| campaign.join(MANIFEST).is_file())
}

fn pack_to(project: &Path, output: Option<&Path>, codecs: &Registry, prune: bool) -> Result<PackReport> {
    let manifest = Manifest::load(project)?;
    let mut outcome = wts::PruneOutcome::default();
    // A chapter map packed on its own comes out as the campaign packs it (and the app exports it).
    let chapter = prune && is_chapter_project(project);
    if chapter {
        outcome.kept = Some("a campaign's chapter maps aren't pruned".into());
    }
    let (bytes, count) = pack_bytes_with(project, codecs, (prune && !chapter).then_some(&mut outcome))?;
    let output = match output {
        Some(o) => o.to_path_buf(),
        None => default_output(project, &manifest)?,
    };
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
        strings: prune.then_some(outcome),
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

pub fn verify(map: &Path, codecs: &Registry, more_names: Option<&NameSource>) -> Result<VerifyReport> {
    let archive = Archive::open(map)?;
    let ex = extract_named(&archive, codecs, more_names);
    let packed = Archive::from_bytes(pack_extracted(&ex, codecs)?)?;
    let mut mismatches = Vec::new();
    compare(&archive, &packed, &ex, "", &mut mismatches);
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
    })
}
