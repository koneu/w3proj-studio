//! The map script as a derived file (trigger-folders spec, section 5): a project whose `map/triggers/triggers.json` says
//! `"script": "generated"` keeps `war3map.j` / `war3map.lua` out of git, in `build/derived/` (the file commands answer
//! `map/war3map.j` from there, `flatview::script_of`), and the record `build/derived-from.json` says what it was made
//! from (`w3proj::derived::record_script`). The app's generator asks here how things stand, records after it wrote, and
//! switches a project between the two modes. The app and the CLI's headless host answer these commands alike.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;
use w3proj::derived::{self, Freshness};
use w3proj::trigger_layout::{self, ScriptMode};

use crate::{err, CmdResult};

/// How a project's map script stands (`state`).
#[derive(Serialize, Debug, PartialEq)]
pub struct State {
    /// "generated", "kept", or None: the project has no `map/triggers/` (its triggers are kept raw, or it has none), so its
    /// script is a tracked file as in "kept".
    pub mode: Option<&'static str>,
    /// For a generated script: "fresh" (it follows its sources), "stale" (they changed since: `changed`), "unknown" (no
    /// record), "unreadable" (`why`), "partial" (made while subterrains were closed); None for a kept one.
    pub freshness: Option<&'static str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub changed: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    /// For a generated script: whether the store has one (a fresh clone has none).
    pub stored: bool,
}

/// "script_state": the project's script mode and, for a generated script, whether it follows its sources. A
/// `triggers.json` that can't be read is an error, never "kept".
pub fn state(root: &str) -> CmdResult<State> {
    let project = Path::new(root);
    let mode = trigger_layout::script_mode_on_disk(&project.join(w3proj::project::MAP_DIR)).map_err(err)?;
    if mode != Some(ScriptMode::Generated) {
        return Ok(State { mode: mode.map(ScriptMode::as_str), freshness: None, changed: Vec::new(), why: None, stored: false });
    }
    let stored = !derived::read_script_store(project).map_err(err)?.is_empty();
    let (freshness, changed, why) = match derived::check_script(project).map_err(err)? {
        Freshness::Fresh => ("fresh", Vec::new(), None),
        Freshness::Stale(c) => ("stale", c, None),
        Freshness::Unknown => ("unknown", Vec::new(), None),
        Freshness::Unreadable(w) => ("unreadable", Vec::new(), Some(w)),
        Freshness::Partial(n) => ("partial", Vec::new(), Some(Freshness::partial_text(n))),
    };
    Ok(State { mode: Some("generated"), freshness: Some(freshness), changed, why, stored })
}

/// "script_sources": the files the map script is made from, as they are now, taken before the generator reads them: one
/// written meanwhile shows as changed in the record. With subterrains closed the generator sees part of the map, and the
/// record says so (`w3proj::derived::script_sources_open`).
pub fn sources(root: &str) -> CmdResult<BTreeMap<String, String>> {
    derived::script_sources_open(Path::new(root)).map_err(err)
}

/// "script_record": records that the generated script in the store was made from `sources` (`sources`). Only for a
/// project whose script is generated: a kept script has no record, and one recorded would let a later switch pass a
/// script nobody made.
pub fn record(root: &str, sources: &BTreeMap<String, String>) -> CmdResult<()> {
    let project = Path::new(root);
    if trigger_layout::script_mode_on_disk(&project.join(w3proj::project::MAP_DIR)).map_err(err)? != Some(ScriptMode::Generated) {
        return Err("the project's map script isn't generated (map/triggers/triggers.json \"script\"), so nothing is recorded".into());
    }
    if derived::read_script_store(project).map_err(err)?.is_empty() {
        return Err(format!("there is no map script in {} to record", derived::STORE_DIR.join("/")));
    }
    derived::record_script(project, sources).map_err(err)
}

/// "script_set_mode": `w3proj::trigger_layout::set_script_mode` ("generated" or "kept").
pub fn set_mode(root: &str, mode: &str) -> CmdResult<trigger_layout::ModeChange> {
    let mode = ScriptMode::parse(mode).ok_or_else(|| format!("mode must be \"generated\" or \"kept\", not {mode:?}"))?;
    trigger_layout::set_script_mode(Path::new(root), mode).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn copy_dir(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for e in fs::read_dir(from).unwrap() {
            let e = e.unwrap();
            if e.file_type().unwrap().is_dir() {
                copy_dir(&e.path(), &to.join(e.file_name()));
            } else {
                fs::copy(e.path(), to.join(e.file_name())).unwrap();
            }
        }
    }

    fn mini(test: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("w3proj-backend-script-{test}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        copy_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mini-map"), &dir);
        dir
    }

    /// The mini map's kept script switched to generated: it moves into the store, `map/war3map.j` is answered from there
    /// by every file command (read, stat, exists, list, write, delete), a write lands in the store and never in map/, the
    /// record follows only a recorded write and goes stale with a trigger file; back to kept it is a tracked file again.
    /// A kept project's map/war3map.j is itself (control).
    #[test]
    fn a_generated_script_is_answered_from_the_store() {
        let dir = mini("store");
        let root = dir.to_string_lossy().into_owned();
        let j = dir.join("map").join("war3map.j");
        let stored = dir.join("build").join("derived").join("war3map.j");
        let original = fs::read(&j).unwrap();
        assert_eq!(state(&root).unwrap().mode, Some("kept"));
        assert!(crate::flatview::script_of(&j).unwrap().is_none(), "control: a kept script is itself");
        assert!(record(&root, &sources(&root).unwrap()).unwrap_err().contains("isn't generated"));

        let change = set_mode(&root, "generated").unwrap();
        assert_eq!(change, trigger_layout::ModeChange { was: "kept", moved: Some("war3map.j".into()) });
        assert!(!j.exists() && fs::read(&stored).unwrap() == original, "moved into the store as it was");
        assert!(fs::read_to_string(dir.join(".gitignore")).unwrap().lines().any(|l| l == "build/"));
        assert!(fs::read_to_string(dir.join("map/triggers/triggers.json")).unwrap().contains("\"script\": \"generated\""));
        let s = state(&root).unwrap();
        assert_eq!((s.mode, s.freshness, s.stored), (Some("generated"), Some("unknown"), true), "a moved script isn't known to follow anything");
        assert_eq!(crate::read_bytes(&j).unwrap(), original);
        assert!(crate::exists(&j).unwrap() && crate::stat(&j).is_some());
        let (listed, _) = crate::walk_project(&dir, false).unwrap();
        assert!(listed.iter().any(|f| f.path == "map/war3map.j"), "listed under its map/ name");

        // Generated again by the app: sources first, then the write, then the record.
        let before = sources(&root).unwrap();
        let st = crate::write_bytes(&j, b"// made\r\n").unwrap();
        assert_eq!(st.also.iter().map(|a| a.path.as_str()).collect::<Vec<_>>(), [stored.to_string_lossy()]);
        assert!(!j.exists(), "nothing written into map/");
        record(&root, &before).unwrap();
        assert_eq!(state(&root).unwrap().freshness, Some("fresh"));
        fs::write(dir.join("map/triggers/triggers.json"), fs::read_to_string(dir.join("map/triggers/triggers.json")).unwrap() + "\n").unwrap();
        let s = state(&root).unwrap();
        assert_eq!((s.freshness, s.changed), (Some("stale"), vec!["triggers/triggers.json".to_string()]));
        assert!(crate::flatview::refuse_moving(&j).unwrap_err().contains("generated"));
        // The same mode again: nothing changes.
        assert_eq!(set_mode(&root, "generated").unwrap().moved, None);

        // Back to kept: a tracked file again, no record, the store empty.
        assert_eq!(set_mode(&root, "kept").unwrap().moved, Some("war3map.j".into()));
        assert_eq!(fs::read(&j).unwrap(), b"// made\r\n");
        assert!(!stored.exists() && crate::flatview::script_of(&j).unwrap().is_none());
        assert_eq!(state(&root).unwrap().mode, Some("kept"));
        assert!(set_mode(&root, "both").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    /// Generated while subterrains are closed (Open Subterrains…): the generator saw part of the map (the closed ones'
    /// placed objects aren't in its flat files), so the record says partial and the script doesn't follow, whatever else
    /// matches; with all open again the same recording is fresh (control).
    #[test]
    fn a_script_made_with_subterrains_closed_follows_part_of_the_map() {
        let dir = mini("partial");
        let root = dir.to_string_lossy().into_owned();
        w3proj::terrain_layout::split_project(&dir, &w3proj::terrain_layout::grid_2x2(5, 3)).unwrap();
        set_mode(&root, "generated").unwrap();
        crate::flatview::set_open(&root, &["ne".into()]).unwrap();
        record(&root, &sources(&root).unwrap()).unwrap();
        let s = state(&root).unwrap();
        assert_eq!(s.freshness, Some("partial"), "{s:?}");
        assert!(s.why.unwrap_or_default().contains("3 subterrains were closed"));
        crate::flatview::set_open(&root, &["sw".into(), "se".into(), "nw".into(), "ne".into()]).unwrap();
        record(&root, &sources(&root).unwrap()).unwrap();
        assert_eq!(state(&root).unwrap().freshness, Some("fresh"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// Refused, nothing written: a different script at both places, both war3map.j and war3map.lua, no map/triggers/, a
    /// triggers.json that can't be read; recording with no script in the store.
    #[test]
    fn switches_that_would_lose_a_script_are_refused() {
        let dir = mini("refused");
        let root = dir.to_string_lossy().into_owned();
        let store = dir.join("build").join("derived");
        fs::create_dir_all(&store).unwrap();
        fs::write(store.join("war3map.j"), "other").unwrap();
        let snapshot = || crate::list_tree(&dir).unwrap().into_iter().map(|p| (p.clone(), fs::read(dir.join(&p)).unwrap())).collect::<Vec<_>>();
        let before = snapshot();
        assert!(set_mode(&root, "generated").unwrap_err().contains("are both there"));
        assert_eq!(snapshot(), before);
        fs::remove_file(store.join("war3map.j")).unwrap();
        fs::write(dir.join("map/war3map.lua"), "-- lua").unwrap();
        let before = snapshot();
        assert!(set_mode(&root, "generated").unwrap_err().contains("keep one"));
        assert_eq!(snapshot(), before);
        fs::remove_file(dir.join("map/war3map.lua")).unwrap();
        fs::write(dir.join("map/triggers/triggers.json"), "{ not json").unwrap();
        assert!(set_mode(&root, "generated").is_err());
        assert!(state(&root).is_err(), "unreadable is an error, never kept");
        fs::remove_dir_all(dir.join("map/triggers")).unwrap();
        assert!(set_mode(&root, "generated").unwrap_err().contains("stays a tracked file"));
        assert_eq!(state(&root).unwrap().mode, None);
        let _ = fs::remove_dir_all(&dir);
    }
}
