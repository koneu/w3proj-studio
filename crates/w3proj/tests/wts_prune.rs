//! `w3proj pack` leaves unused strings out of war3map.wts by the app's rules (`w3proj::wts`). The
//! fixture `tests/fixtures/wts-prune` is pruned by the app's TypeScript too
//! (`app/src/builtin/map-project/prunestrings.test.ts`): both must give `expected.wts`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use mpq::Archive;
use w3proj::wts::{self, StringNum};
use w3proj::Registry;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

fn files_below(dir: &Path, rel: &str, out: &mut BTreeMap<String, Vec<u8>>) {
    for e in fs::read_dir(dir).unwrap() {
        let e = e.unwrap();
        let name = format!("{rel}{}", e.file_name().to_string_lossy());
        if e.file_type().unwrap().is_dir() {
            files_below(&e.path(), &format!("{name}/"), out);
        } else {
            out.insert(name, fs::read(e.path()).unwrap());
        }
    }
}

fn list(v: &[StringNum]) -> Vec<f64> {
    v.iter().map(|n| n.value()).collect()
}

#[test]
fn the_fixture_prunes_as_the_app_does() {
    let root = fixtures().join("wts-prune");
    let mut files = BTreeMap::new();
    files_below(&root.join("map"), "", &mut files);
    let record = fs::read_to_string(root.join(wts::PRUNED_STRINGS_FILE)).unwrap();
    let r = wts::prune_files(&mut files, Ok(Some(record)), &Registry::default());
    assert_eq!(r.kept, None);
    assert_eq!(list(&r.dropped), [3.0, 5.0, 9.0, 12.0]);
    assert_eq!(list(&r.restored), [20.0]);
    let expected = fs::read_to_string(root.join("expected.wts")).unwrap();
    assert_eq!(String::from_utf8(files["war3map.wts"].clone()).unwrap(), expected);
    // The German table stays byte for byte: the strings war3map.wts dropped (3, 5, 12) and its own 30 too, and its
    // text's `TRIGSTR_009` doesn't keep 9 (a string table refers to nothing).
    let de = "_Locales/deDE.w3mod/war3map.wts";
    assert_eq!(files[de], fs::read(root.join("map").join(de)).unwrap());
}

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

fn packed_wts(out: &Path) -> String {
    String::from_utf8(Archive::open(out).unwrap().read("war3map.wts").unwrap()).unwrap()
}

#[test]
fn pack_pruned_leaves_orphans_out_and_restores_recorded_strings_the_project_keeps_its_files() {
    let tmp = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("wts-prune-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    let project = tmp.join("mini");
    copy_dir(&fixtures().join("mini-map"), &project);
    let codecs = Registry::default();
    let wts_path = project.join("map/war3map.wts");
    let original = fs::read_to_string(&wts_path).unwrap();
    // String 6 (force 1's name) was dropped by an earlier pack and recorded; 99 is an orphan.
    let six = "STRING 6\n{\nForce\n}\n";
    assert!(original.contains(six));
    let edited = format!("{}STRING 99\n{{\nnobody's\n}}\n", original.replace(six, ""));
    fs::write(&wts_path, &edited).unwrap();
    // A German table holding the orphan 99 and an orphan of its own: packed as it is.
    let de = "STRING 99\r\n{\r\nniemandes\r\n}\r\n\r\nSTRING 100\r\n{\r\nnur deutsch\r\n}\r\n\r\n";
    fs::create_dir_all(project.join("map/_Locales/deDE.w3mod")).unwrap();
    fs::write(project.join("map/_Locales/deDE.w3mod/war3map.wts"), de).unwrap();
    fs::create_dir_all(project.join(".w3proj")).unwrap();
    fs::write(project.join(wts::PRUNED_STRINGS_FILE), r#"{"format":"w3proj.prunedStrings/1","strings":{"6":"Force"}}"#).unwrap();

    let out = tmp.join("pruned.w3x");
    let r = w3proj::pack_pruned(&project, Some(&out), &codecs).unwrap();
    let s = r.strings.as_ref().unwrap();
    assert_eq!((list(&s.dropped), list(&s.restored), s.kept.clone()), (vec![99.0], vec![6.0], None));
    let packed = packed_wts(&out);
    assert!(!packed.contains("STRING 99"));
    assert!(packed.ends_with("STRING 6\n{\nForce\n}\n\n"), "{packed}");
    assert_eq!(Archive::open(&out).unwrap().read("_Locales\\deDE.w3mod\\war3map.wts").unwrap(), de.as_bytes());
    assert_eq!(fs::read_to_string(&wts_path).unwrap(), edited, "the project's file stays as it is");

    // The control: plain `pack` packs the table as it is.
    let plain = tmp.join("plain.w3x");
    assert!(w3proj::pack(&project, Some(&plain), &codecs).unwrap().strings.is_none());
    assert_eq!(packed_wts(&plain), edited);

    // A chapter map of a campaign project, packed on its own: as it is (chapter maps aren't pruned).
    let campaign = tmp.join("camp");
    fs::create_dir_all(campaign.join("maps")).unwrap();
    fs::copy(project.join("w3proj.toml"), campaign.join("w3proj.toml")).unwrap();
    let chapter = campaign.join("maps").join("One.w3x");
    copy_dir(&project, &chapter);
    let out = tmp.join("chapter.w3x");
    let r = w3proj::pack_pruned(&chapter, Some(&out), &codecs).unwrap();
    let s = r.strings.as_ref().unwrap();
    assert!(s.dropped.is_empty() && s.kept.as_deref().is_some_and(|k| k.contains("chapter")), "{s:?}");
    assert_eq!(packed_wts(&out), edited);
    let _ = fs::remove_dir_all(&tmp);
}
