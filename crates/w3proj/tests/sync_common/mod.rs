//! Helpers of the sync tests (`sync_safety.rs`, `sync_report.rs`): a small project and what a sync brings.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use w3proj::header::MapHeader;
use w3proj::project::{self, Extracted, Manifest, MANIFEST};
use w3proj::UnpackReport;

/// A folder for one test, under the build's temporary directory.
pub fn workdir(test: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("sync-{test}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

pub fn header(name: &str) -> MapHeader {
    MapHeader { name: name.into(), flags: 0, max_players: 1, unknown: 0 }
}

pub const SCRIPT: &[u8] = b"function main takes nothing returns nothing\nendfunction\n";

/// A project with one map file.
pub fn new_project(dir: &Path) -> PathBuf {
    let root = dir.join("proj");
    project::create(&root, Some(header("Map"))).unwrap();
    fs::write(root.join("map").join("war3map.j"), SCRIPT).unwrap();
    root
}

/// What syncing a map with these files and this header brings.
pub fn extracted(root: &Path, name: &str, files: &[(&str, &[u8])]) -> Extracted {
    let mut manifest = Manifest::load(root).unwrap();
    manifest.map = Some(header(name));
    Extracted {
        manifest,
        raw_header: None,
        files: files.iter().map(|(k, v)| (k.to_string(), v.to_vec())).collect(),
        unnamed: BTreeMap::new(),
        nested: BTreeMap::new(),
        report: UnpackReport::default(),
    }
}

/// The manifest as a user keeps it: comments, keys and a table Studio doesn't know (one key in a table
/// Studio owns).
pub fn commented(root: &Path) -> String {
    let made = fs::read_to_string(root.join(MANIFEST)).unwrap();
    let text = format!(
        "# My map. Built by CI from this file.\nchannel = \"beta\" # read by our script\n{}\n# ours\n[ci]\nupload = true\n",
        made.replace("name = \"Map\"", "name = \"Map\" # shown in the lobby").replace("[pack]\n", "[pack]\nstrip = true\n"),
    );
    fs::write(root.join(MANIFEST), &text).unwrap();
    text
}
