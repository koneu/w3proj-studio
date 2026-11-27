use super::*;

/// One change as the binary has it: field, type 0 (int) or 3 (string), value, end token.
enum V<'a> {
    Int(i32),
    Str(&'a str),
}

struct Entry<'a> {
    base: &'a [u8; 4],
    id: &'a [u8; 4],
    mods: Vec<(&'a [u8; 4], V<'a>, &'a [u8; 4])>,
}

fn e<'a>(base: &'a [u8; 4], id: &'a [u8; 4], mods: Vec<(&'a [u8; 4], V<'a>, &'a [u8; 4])>) -> Entry<'a> {
    Entry { base, id, mods }
}

/// A packed object file of `version` (no level columns): the two tables.
fn packed(version: u32, original: &[Entry], custom: &[Entry]) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend(version.to_le_bytes());
    for table in [original, custom] {
        b.extend((table.len() as u32).to_le_bytes());
        for o in table {
            b.extend(o.base);
            b.extend(o.id);
            if version >= 3 {
                b.extend(1u32.to_le_bytes());
                b.extend(0u32.to_le_bytes());
            }
            b.extend((o.mods.len() as u32).to_le_bytes());
            for (field, v, end) in &o.mods {
                b.extend(*field);
                match v {
                    V::Int(n) => {
                        b.extend(0u32.to_le_bytes());
                        b.extend(n.to_le_bytes());
                    }
                    V::Str(s) => {
                        b.extend(3u32.to_le_bytes());
                        b.extend(s.as_bytes());
                        b.push(0);
                    }
                }
                b.extend(*end);
            }
        }
    }
    b
}

const UNITS: Kind = KINDS[0];

/// The flat files (as the codec unpacks them) of a map's units: `war3map.w3u` and, where given, `war3mapSkin.w3u`.
fn flat_files(data: Option<&[u8]>, skin: Option<&[u8]>) -> Files {
    let mut files = Files::new();
    if let Some(d) = data {
        files.insert("war3map.w3u.json".into(), objdata::to_json(d, false).unwrap());
    }
    if let Some(s) = skin {
        files.insert("war3mapSkin.w3u.json".into(), objdata::to_json(s, false).unwrap());
    }
    files
}

/// Split, then assembled again: the packed files, by name.
fn round_trip(files: &Files) -> (Split, BTreeMap<String, Vec<u8>>) {
    let split = split_flat(files, Prefix::Map);
    let packed = assemble(&split.layout, &[], Prefix::Map, &mut Vec::new()).unwrap();
    (split, packed.into_iter().collect())
}

use std::collections::BTreeMap;

fn text(files: &Files, path: &str) -> String {
    String::from_utf8(files.get(path).unwrap_or_else(|| panic!("no {path} among {:?}", files.keys().collect::<Vec<_>>())).clone()).unwrap()
}

#[test]
fn file_names_follow_the_id() {
    for (id, stem) in [
        (*b"hfoo", "hfoo"),
        (*b"h000", "h000"),
        (*b"H000", "H000~8"),
        (*b"AFfs", "AFfs~c"),
        (*b"Affs", "Affs~8"),
        (*b"Nman", "Nman~8"),
        (*b"nman", "nman"),
        (*b"ABCD", "ABCD~f"),
        (*b"h-0!", "0x682d3021"),
        ([0, 1, 2, 255], "0x000102ff"),
        (*b"com1", "0x636f6d31"),
        (*b"COM1", "COM1~e"),
        (*b"lpt9", "0x6c707439"),
    ] {
        assert_eq!(file_stem(Id(id)), stem);
        assert_eq!(stem_id(stem), Some(Id(id)), "{stem}");
    }
    for not in ["H000", "h000~8", "AFfs~8", "0x682D3021", "0x6869", "hfo", "hfoo~0", "com1"] {
        assert_eq!(stem_id(not), None, "{not}");
    }
    // No two names of a table collide where case is ignored (Windows, macOS).
    let ids = [*b"h000", *b"H000", *b"Nman", *b"nman", *b"AFfs", *b"Affs", *b"afFS", *b"AFFS"];
    let names: HashSet<String> = ids.iter().map(|i| file_stem(Id(*i)).to_ascii_lowercase()).collect();
    assert_eq!(names.len(), ids.len());
}

#[test]
fn split_writes_one_file_per_object_with_both_halves() {
    let data = packed(3, &[e(b"hfoo", b"\0\0\0\0", vec![(b"umvs", V::Int(300), b"\0\0\0\0")])], &[e(b"halt", b"h09L", vec![(b"umpm", V::Int(500), b"h09L"), (b"upap", V::Str("unwalkable"), b"halt")])]);
    let skin = packed(3, &[], &[e(b"halt", b"h09L", vec![(b"unam", V::Str("TRIGSTR_5456"), b"h09L")])]);
    let (split, back) = round_trip(&flat_files(Some(&data), Some(&skin)));
    assert!(split.kept.is_empty(), "{:?}", split.kept);
    assert_eq!(split.taken, ["war3map.w3u.json", "war3mapSkin.w3u.json"]);
    assert_eq!(
        split.layout.keys().collect::<Vec<_>>(),
        ["objects/objects.json", "objects/units/custom/h09L~1.json", "objects/units/original/hfoo.json"]
    );
    assert_eq!(text(&split.layout, ROOT_FILE), "{\n  \"format\": \"w3proj.objectfolders/1\",\n  \"files\": {\n    \"units\": {\"data\": 3, \"skin\": 3}\n  }\n}\n");
    assert_eq!(
        text(&split.layout, "objects/units/custom/h09L~1.json"),
        "{\n  \"id\": \"h09L\",\n  \"base\": \"halt\",\n  \"data\": {\n    \"end\": \"h09L\",\n    \"mods\": [\n      {\"field\": \"umpm\", \"type\": \"int\", \"value\": 500},\n      {\"field\": \"upap\", \"type\": \"string\", \"value\": \"unwalkable\", \"end\": \"halt\"}\n    ]\n  },\n  \"skin\": {\n    \"end\": \"h09L\",\n    \"mods\": [\n      {\"field\": \"unam\", \"type\": \"string\", \"value\": \"TRIGSTR_5456\"}\n    ]\n  }\n}\n"
    );
    assert_eq!(text(&split.layout, "objects/units/original/hfoo.json"), "{\n  \"base\": \"hfoo\",\n  \"data\": {\n    \"mods\": [\n      {\"field\": \"umvs\", \"type\": \"int\", \"value\": 300}\n    ]\n  }\n}\n");
    assert_eq!(back["war3map.w3u"], data);
    assert_eq!(back["war3mapSkin.w3u"], skin);
}

/// A missing half means the object isn't in that packed file; an empty one (`{}`) that it is there without changes. Both
/// come back as they were, as do objects only the Skin file has.
#[test]
fn a_missing_half_and_an_empty_half_differ() {
    let data = packed(3, &[], &[e(b"hfoo", b"h000", vec![]), e(b"hfoo", b"h001", vec![(b"umpm", V::Int(1), b"\0\0\0\0")])]);
    let skin = packed(3, &[], &[e(b"hfoo", b"h000", vec![]), e(b"hpea", b"h002", vec![])]);
    let (split, back) = round_trip(&flat_files(Some(&data), Some(&skin)));
    assert!(split.kept.is_empty(), "{:?}", split.kept);
    assert_eq!(text(&split.layout, "objects/units/custom/h000.json"), "{\n  \"id\": \"h000\",\n  \"base\": \"hfoo\",\n  \"data\": {},\n  \"skin\": {}\n}\n");
    let h001 = text(&split.layout, "objects/units/custom/h001.json");
    assert!(h001.contains("\"data\"") && !h001.contains("\"skin\""), "{h001}");
    let h002 = text(&split.layout, "objects/units/custom/h002.json");
    assert!(h002.contains("\"skin\": {}") && !h002.contains("\"data\""), "only in the Skin file: {h002}");
    assert_eq!(back["war3map.w3u"], data);
    assert_eq!(back["war3mapSkin.w3u"], skin);
}

#[test]
fn the_halves_keep_their_own_end_tokens() {
    let data = packed(2, &[], &[e(b"hfoo", b"h000", vec![(b"umpm", V::Int(1), b"h000"), (b"umvs", V::Int(2), b"h000")])]);
    let skin = packed(3, &[], &[e(b"hfoo", b"h000", vec![(b"unam", V::Str("x"), b"\0\0\0\0")])]);
    let (split, back) = round_trip(&flat_files(Some(&data), Some(&skin)));
    let f = text(&split.layout, "objects/units/custom/h000.json");
    assert!(f.contains("\"data\": {\n    \"end\": \"h000\""), "{f}");
    assert!(f.contains("\"skin\": {\n    \"mods\""), "the skin half has no end of its own: {f}");
    assert_eq!(text(&split.layout, ROOT_FILE).lines().nth(3).unwrap().trim(), "\"units\": {\"data\": 2, \"skin\": 3}");
    assert_eq!(back["war3map.w3u"], data);
    assert_eq!(back["war3mapSkin.w3u"], skin);
}

#[test]
fn case_only_ids_and_odd_ids_get_their_own_files() {
    let data = packed(
        3,
        &[e(b"Nman", b"\0\0\0\0", vec![]), e(b"nman", b"\0\0\0\0", vec![])],
        &[e(b"AOcl", b"AFfs", vec![]), e(b"AOcl", b"Affs", vec![]), e(b"hfoo", b"h-0!", vec![])],
    );
    let (split, back) = round_trip(&flat_files(Some(&data), None));
    assert!(split.kept.is_empty(), "{:?}", split.kept);
    for p in ["objects/units/original/Nman~8.json", "objects/units/original/nman.json", "objects/units/custom/AFfs~c.json", "objects/units/custom/Affs~8.json", "objects/units/custom/0x682d3021.json"] {
        assert!(split.layout.contains_key(p), "{p}: {:?}", split.layout.keys().collect::<Vec<_>>());
    }
    assert!(text(&split.layout, "objects/units/custom/0x682d3021.json").contains("\"id\": \"h-0!\""));
    assert_eq!(back["war3map.w3u"], data);
}

#[test]
fn version_one_and_two_files_without_skin() {
    for v in [1, 2] {
        let data = packed(v, &[e(b"hfoo", b"\0\0\0\0", vec![(b"umvs", V::Int(1), b"hfoo")])], &[e(b"hfoo", b"h000", vec![(b"unam", V::Str("A"), b"h000")])]);
        let (split, back) = round_trip(&flat_files(Some(&data), None));
        assert!(text(&split.layout, ROOT_FILE).contains(&format!("\"units\": {{\"data\": {v}}}")));
        assert_eq!(back.keys().collect::<Vec<_>>(), ["war3map.w3u"], "no Skin file packed");
        assert_eq!(back["war3map.w3u"], data, "version {v}");
    }
}

#[test]
fn a_listed_file_without_objects_is_packed() {
    let data = packed(2, &[], &[]);
    let skin = packed(3, &[], &[]);
    let (split, back) = round_trip(&flat_files(Some(&data), Some(&skin)));
    assert_eq!(split.layout.keys().collect::<Vec<_>>(), [ROOT_FILE], "no folder for the kind, only its listing");
    assert_eq!(back["war3map.w3u"], data);
    assert_eq!(back["war3mapSkin.w3u"], skin);
}

#[test]
fn order_is_stored_only_where_it_isnt_the_default() {
    // Sorted: no order.txt.
    let sorted = packed(3, &[], &[e(b"hfoo", b"H000", vec![]), e(b"hfoo", b"h000", vec![]), e(b"hfoo", b"h001", vec![])]);
    let (split, back) = round_trip(&flat_files(Some(&sorted), None));
    assert!(!split.layout.keys().any(|k| k.ends_with(ORDER)), "{:?}", split.layout.keys().collect::<Vec<_>>());
    assert_eq!(back["war3map.w3u"], sorted);
    // Not sorted: the shortest head after which the rest is sorted is listed.
    let mixed = packed(3, &[], &[e(b"hfoo", b"h002", vec![]), e(b"hfoo", b"h000", vec![]), e(b"hfoo", b"h001", vec![]), e(b"hfoo", b"h003", vec![])]);
    let (split, back) = round_trip(&flat_files(Some(&mixed), None));
    assert_eq!(text(&split.layout, "objects/units/custom/order.txt"), "h002\n");
    assert_eq!(back["war3map.w3u"], mixed);
    // One list for both halves, an object only the Skin file has among them.
    let data = packed(3, &[], &[e(b"hfoo", b"h002", vec![]), e(b"hfoo", b"h000", vec![])]);
    let skin = packed(3, &[], &[e(b"hfoo", b"h005", vec![]), e(b"hfoo", b"h002", vec![]), e(b"hfoo", b"h000", vec![])]);
    let (split, back) = round_trip(&flat_files(Some(&data), Some(&skin)));
    assert_eq!(text(&split.layout, "objects/units/custom/order.txt"), "h005\nh002\n");
    assert_eq!(back["war3map.w3u"], data);
    assert_eq!(back["war3mapSkin.w3u"], skin);
}

/// The layout's files of a small unit table (h002 listed first), to change by hand.
fn sample_layout() -> Files {
    let data = packed(3, &[], &[e(b"hfoo", b"h002", vec![]), e(b"hfoo", b"h000", vec![]), e(b"hfoo", b"h001", vec![])]);
    split_flat(&flat_files(Some(&data), None), Prefix::Map).layout
}

fn custom_order(files: &Files) -> Vec<String> {
    let f = assemble(files, &[], Prefix::Map, &mut Vec::new()).unwrap();
    let file = objdata::decode(&f[0].1, false).unwrap();
    file.custom.iter().map(|o| o.id.to_string()).collect()
}

#[test]
fn unlisted_objects_come_after_the_listed_ones_by_id() {
    let mut files = sample_layout();
    let new = |id: &str| format!("{{\"id\": \"{id}\", \"base\": \"hfoo\", \"data\": {{}}}}").into_bytes();
    files.insert("objects/units/custom/h00a.json".into(), new("h00a"));
    files.insert("objects/units/custom/H000~8.json".into(), new("H000"));
    assert_eq!(custom_order(&files), ["h002", "H000", "h000", "h001", "h00a"]);
}

#[test]
fn an_order_txt_name_without_a_file_is_left_out_with_a_warning() {
    let mut files = sample_layout();
    files.insert("objects/units/custom/order.txt".into(), b"h009\nh001\nh001\n\nh002\n".to_vec());
    let mut warnings = Vec::new();
    let packed = assemble(&files, &[], Prefix::Map, &mut warnings).unwrap();
    let ids: Vec<String> = objdata::decode(&packed[0].1, false).unwrap().custom.iter().map(|o| o.id.to_string()).collect();
    assert_eq!(ids, ["h001", "h002", "h000"]);
    assert_eq!(warnings.len(), 2, "{warnings:?}");
    assert!(warnings[0].contains("lists h009, which has no file"), "{warnings:?}");
    assert!(warnings[1].contains("lists h001 twice"), "{warnings:?}");
}

#[test]
fn pack_refuses_what_the_layout_cant_hold_naming_the_file() {
    let refused = |change: &dyn Fn(&mut Files), want: &str| {
        let mut files = sample_layout();
        change(&mut files);
        let e = assemble(&files, &[], Prefix::Map, &mut Vec::new()).expect_err(want).to_string();
        assert!(e.contains(want), "{want}: {e}");
    };
    refused(&|f| { f.insert("objects/units/custom/h000.json".into(), b"{\"id\": \"h001\", \"base\": \"hfoo\", \"data\": {}}".to_vec()); }, "map/objects/units/custom/h000.json holds h001, whose file is named h001.json");
    refused(&|f| { f.insert("objects/units/custom/h000.json".into(), b"{\"id\": \"H000\", \"base\": \"hfoo\", \"data\": {}}".to_vec()); }, "named H000~8.json");
    refused(&|f| { f.insert("objects/units/original/hfoo.json".into(), b"{\"id\": \"h000\", \"base\": \"hfoo\", \"data\": {}}".to_vec()); }, "map/objects/units/original/hfoo.json has an \"id\"");
    refused(&|f| { f.insert("objects/units/custom/hfoo.json".into(), b"{\"base\": \"hfoo\", \"data\": {}}".to_vec()); }, "map/objects/units/custom/hfoo.json has no \"id\"");
    refused(&|f| { f.insert("objects/units/custom/h000.json".into(), b"<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> b\n".to_vec()); }, "map/objects/units/custom/h000.json has merge conflict markers");
    refused(&|f| { f.insert("objects/units/custom/order.txt".into(), b"h000\n<<<<<<< ours\nh001\n=======\n>>>>>>> theirs\n".to_vec()); }, "map/objects/units/custom/order.txt has merge conflict markers");
    refused(&|f| { f.insert("objects/units/custom/h000.json".into(), b"{\"id\": \"h000\", \"base\": ".to_vec()); }, "map/objects/units/custom/h000.json can't be read");
    refused(&|f| { f.insert("objects/units/custom/h000.json".into(), b"{\"id\": \"h000\", \"base\": \"hfoo\", \"skin\": {}}".to_vec()); }, "has a \"skin\" half, but map/objects/objects.json lists no war3mapSkin.w3u");
    refused(&|f| { f.insert("objects/units/h000.json".into(), b"{}".to_vec()); }, "map/objects/units/h000.json isn't part of the object layout");
    refused(&|f| { f.insert("objects/units/custom/sub/h000.json".into(), b"{}".to_vec()); }, "map/objects/units/custom/sub/h000.json isn't part of the object layout");
    refused(&|f| { f.insert("objects/units/custom/notes.txt".into(), b"".to_vec()); }, "isn't part of the object layout");
    refused(&|f| { f.insert("Objects/units/custom/h009.json".into(), b"{\"id\": \"h001\", \"base\": \"hfoo\"}".to_vec()); }, "map/objects/units/custom/h009.json holds h001");
    refused(&|f| { f.insert("Objects/units/custom/h000.json".into(), b"{}".to_vec()); }, "map/Objects/units/custom/h000.json and map/objects/units/custom/h000.json are both there");
    refused(&|f| { f.insert(ROOT_FILE.into(), b"{\"format\": \"w3proj.objectfolders/2\", \"files\": {}}".to_vec()); }, "newer than this version of W3Proj Studio reads");
    refused(&|f| { f.insert(ROOT_FILE.into(), b"{\"format\": \"w3proj.objectfolders/1\", \"files\": {\"units\": {\"data\": 4}}}".to_vec()); }, "not a version from 1 to 3");
    refused(&|f| { f.insert("objects/units/custom/h000.json".into(), b"{\"id\": \"h000\", \"base\": \"hfoo\", \"data\": {\"mods\": [{\"field\": \"umpm\", \"type\": \"int\", \"value\": 1e12}]}}".to_vec()); }, "map/objects/units/custom/h000.json: \"data\":");
    // A later minor format reads the same (control).
    let mut files = sample_layout();
    files.insert(ROOT_FILE.into(), b"{\"format\": \"w3proj.objectfolders/1.4\", \"files\": {\"units\": {\"data\": 3}}, \"later\": true}".to_vec());
    assert_eq!(custom_order(&files), ["h002", "h000", "h001"]);
}

/// The game's own `Objects\` folder, which maps import files into, is no part of the layout: its files are the map's
/// own (they share the folder with the layout where case is ignored, which may then be spelt `Objects/`).
#[test]
fn the_games_objects_folder_holds_imports() {
    for (path, ours) in [
        ("objects/objects.json", Some("objects/objects.json")),
        ("Objects/objects.json", Some("objects/objects.json")),
        ("objects/units/custom/h000.json", Some("objects/units/custom/h000.json")),
        ("OBJECTS/abilities/original/AHbz~8.json", Some("objects/abilities/original/AHbz~8.json")),
        ("Objects/InventoryItems/RingOfProtection/RingOfProtection.blp", None),
        ("objects/Units/x.blp", None),
        ("objects/units", None),
        ("objects/units/", None),
        ("objects/readme.txt", None),
        ("objectsx/units/a", None),
        ("map/objects/units/a", None),
    ] {
        assert_eq!(layout_path(path).as_deref(), ours, "{path}");
    }
    // Spelt Objects/ (a folder that ignores case, made by an import first): still packed.
    let files: Files = sample_layout().into_iter().map(|(k, v)| (k.replacen("objects/", "Objects/", 1), v)).collect();
    assert!(is_layout(&files, &[]));
    assert_eq!(custom_order(&files), ["h002", "h000", "h001"]);
    // An import there doesn't keep a map's objects out of the layout.
    let mut flat = flat_files(Some(&packed(3, &[], &[e(b"hfoo", b"h000", vec![])])), None);
    flat.insert("Objects/InventoryItems/x.blp".into(), b"x".to_vec());
    let split = split_flat(&flat, Prefix::Map);
    assert_eq!(split.taken, ["war3map.w3u.json"], "{:?}", split.kept);
    assert!(!split.layout.contains_key("Objects/InventoryItems/x.blp"));
}

#[test]
fn object_files_without_objects_json_are_an_error() {
    let mut files = sample_layout();
    files.remove(ROOT_FILE);
    let e = check_root(&files, &[]).unwrap_err().to_string();
    assert!(e.contains("map/objects/objects.json is missing"), "{e}");
    assert!(check_root(&files, &files.keys().cloned().collect::<Vec<_>>()).is_ok(), "the map's own files (raw) are files of their own");
    assert!(check_root(&sample_layout(), &[]).is_ok());
}

/// A kind the layout can't hold stays raw (both halves), with why; the others still go into the layout.
#[test]
fn what_the_layout_cant_hold_stays_as_it_is() {
    type Case<'a> = (&'a str, Vec<u8>, Option<Vec<u8>>);
    let cases: [Case; 4] = [
        ("twice", packed(3, &[], &[e(b"hfoo", b"h000", vec![]), e(b"hfoo", b"h000", vec![])]), None),
        ("made from", packed(3, &[], &[e(b"hfoo", b"h000", vec![])]), Some(packed(3, &[], &[e(b"hpea", b"h000", vec![])]))),
        ("another order", packed(3, &[], &[e(b"hfoo", b"h000", vec![]), e(b"hfoo", b"h001", vec![])]), Some(packed(3, &[], &[e(b"hfoo", b"h001", vec![]), e(b"hfoo", b"h000", vec![])]))),
        ("both a changed standard object and a custom one", packed(3, &[e(b"h000", b"\0\0\0\0", vec![])], &[e(b"hfoo", b"h000", vec![])]), None),
    ];
    for (why, data, skin) in cases {
        let mut files = flat_files(Some(&data), skin.as_deref());
        files.insert("war3map.w3t.json".into(), objdata::to_json(&packed(2, &[], &[]), false).unwrap());
        let split = split_flat(&files, Prefix::Map);
        assert_eq!(split.kept.len(), 1, "{why}");
        assert_eq!(split.kept[0].0, UNITS);
        assert!(split.kept[0].1.contains(why), "{why}: {}", split.kept[0].1);
        assert_eq!(split.taken, ["war3map.w3t.json"], "{why}");
    }
    // A file of the map's own where the layout keeps its files: nothing goes into the layout.
    let mut files = flat_files(Some(&packed(3, &[], &[])), None);
    files.insert("objects/units/readme.txt".into(), b"x".to_vec());
    let split = split_flat(&files, Prefix::Map);
    assert!(split.layout.is_empty() && split.taken.is_empty());
    assert!(split.kept[0].1.contains("a file of its own where the object layout keeps its files (objects/units/readme.txt)"), "{:?}", split.kept);
    // A half the codec couldn't read (raw): both stay raw.
    let mut files = flat_files(Some(&packed(3, &[], &[])), None);
    files.insert("war3mapSkin.w3u".into(), b"junk".to_vec());
    let split = split_flat(&files, Prefix::Map);
    assert!(split.taken.is_empty());
    assert!(split.kept[0].1.contains("war3mapSkin.w3u couldn't be read"), "{:?}", split.kept);
}

#[test]
fn a_campaign_packs_into_its_own_names() {
    let data = packed(3, &[], &[e(b"hfoo", b"h000", vec![])]);
    let mut files = Files::new();
    files.insert("war3campaign.w3f.json".into(), b"{}".to_vec());
    files.insert("war3campaign.w3u.json".into(), objdata::to_json(&data, false).unwrap());
    files.insert("war3map.w3t.json".into(), objdata::to_json(&packed(3, &[], &[]), false).unwrap());
    let prefix = Prefix::of_files(&files);
    assert_eq!(prefix, Prefix::Campaign);
    let split = split_flat(&files, prefix);
    assert_eq!(split.taken, ["war3campaign.w3u.json"], "a map's name in a campaign isn't its object data");
    let back = assemble(&split.layout, &[], prefix, &mut Vec::new()).unwrap();
    assert_eq!(back, [("war3campaign.w3u".to_string(), data)]);
}

#[test]
fn sets_and_level_columns_come_back() {
    // A version 3 ability with two sets and level/data columns, and one with no sets at all.
    let mut b = Vec::new();
    b.extend(3u32.to_le_bytes());
    b.extend(0u32.to_le_bytes());
    b.extend(2u32.to_le_bytes());
    b.extend(b"AHbz");
    b.extend(b"A000");
    b.extend(2u32.to_le_bytes());
    for flag in [0u32, 1] {
        b.extend(flag.to_le_bytes());
        b.extend(1u32.to_le_bytes());
        b.extend(b"Hbz1");
        b.extend(2u32.to_le_bytes());
        b.extend(2u32.to_le_bytes());
        b.extend(1u32.to_le_bytes());
        b.extend(0.1f32.to_bits().to_le_bytes());
        b.extend([0u8; 4]);
    }
    b.extend(b"AHbz");
    b.extend(b"A001");
    b.extend(0u32.to_le_bytes());
    let mut files = Files::new();
    files.insert("war3map.w3a.json".into(), objdata::to_json(&b, true).unwrap());
    let split = split_flat(&files, Prefix::Map);
    assert!(split.kept.is_empty(), "{:?}", split.kept);
    let a000 = text(&split.layout, "objects/abilities/custom/A000~8.json");
    assert!(a000.contains("\"sets\": [\n      {\"flag\": 0, \"mods\": [\n        {\"field\": \"Hbz1\", \"type\": \"unreal\", \"level\": 2, \"data\": 1, \"value\": 0.1}\n      ]},"), "{a000}");
    assert!(text(&split.layout, "objects/abilities/custom/A001~8.json").contains("\"data\": {\n    \"sets\": []\n  }"));
    let back = assemble(&split.layout, &[], Prefix::Map, &mut Vec::new()).unwrap();
    assert_eq!(back, [("war3map.w3a".to_string(), b)]);
}

#[test]
fn any_valid_json_reads() {
    let mut files = sample_layout();
    files.insert("objects/units/custom/h000.json".into(), b"{\"base\":\"hfoo\",\"data\":{\"mods\":[{\"value\":7,\"type\":\"int\",\"field\":\"umpm\"}]},\"id\":\"h000\",\"note\":\"mine\"}".to_vec());
    let f = assemble(&files, &[], Prefix::Map, &mut Vec::new()).unwrap();
    let file = objdata::decode(&f[0].1, false).unwrap();
    let h000 = file.custom.iter().find(|o| o.id.to_string() == "h000").unwrap();
    assert_eq!(h000.mods.as_ref().unwrap()[0].value, 7);
}

/// The fixture (tests/fixtures/object-folders, the mini map's object data with custom units in both halves) is in the
/// form the writer gives: packed and split again, the same files.
#[test]
fn the_fixture_is_what_a_split_writes() {
    let map = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/object-folders/map");
    let files = FOLDER.read_disk(&map).unwrap();
    assert!(files.len() > 10);
    let mut warnings = Vec::new();
    let packed = assemble(&files, &[], Prefix::Map, &mut warnings).unwrap();
    assert!(warnings.is_empty(), "{warnings:?}");
    let mut flat = Files::new();
    for (name, bytes) in &packed {
        let kind = KINDS.iter().find(|k| name.ends_with(k.ext)).unwrap();
        flat.insert(format!("{name}.json"), objdata::to_json(bytes, kind.levels).unwrap());
    }
    let units = objdata::decode(&packed.iter().find(|(n, _)| n == "war3mapSkin.w3u").unwrap().1, false).unwrap();
    assert_eq!(units.custom.iter().map(|o| o.id.to_string()).collect::<Vec<_>>(), ["n000", "h000", "H000"], "listed, then by id");
    let split = split_flat(&flat, Prefix::Map);
    assert!(split.kept.is_empty(), "{:?}", split.kept);
    assert_eq!(split.layout, files);
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("w3proj-object-layout-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("map")).unwrap();
    std::fs::write(dir.join(crate::project::MANIFEST), "format = 1\n").unwrap();
    dir
}

fn write_all(map_dir: &Path, files: &Files) {
    for (k, v) in files {
        let p = crate::paths::join_rel(map_dir, k);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, v).unwrap();
    }
}

#[test]
fn the_flat_files_read_and_write_through_the_folder() {
    let dir = scratch("flat");
    let map = dir.join("map");
    let data = packed(3, &[], &[e(b"hfoo", b"h002", vec![]), e(b"hfoo", b"h000", vec![(b"umpm", V::Int(1), b"\0\0\0\0")]), e(b"hfoo", b"h001", vec![])]);
    let skin = packed(3, &[], &[e(b"hfoo", b"h000", vec![(b"unam", V::Str("A"), b"\0\0\0\0")])]);
    let flat = flat_files(Some(&data), Some(&skin));
    write_all(&map, &split_flat(&flat, Prefix::Map).layout);
    assert_eq!(flat_view(&map, "war3map.w3u.json").unwrap(), Some((UNITS, 0)));
    assert_eq!(flat_view(&map, "war3mapSkin.w3u.json").unwrap(), Some((UNITS, 1)));
    assert_eq!(flat_view(&map, "war3map.w3i.json").unwrap(), None);
    assert_eq!(flat_view(&map, "war3campaign.w3u.json").unwrap(), None, "a map's folder has no campaign files");
    // The read is the codec's flat file, byte for byte.
    assert_eq!(read_flat(&map, UNITS, 0).unwrap().unwrap(), flat["war3map.w3u.json"]);
    assert_eq!(read_flat(&map, UNITS, 1).unwrap().unwrap(), flat["war3mapSkin.w3u.json"]);
    assert_eq!(read_flat(&map, KINDS[1], 0).unwrap(), None, "not listed: not there");
    // A write of the same content writes nothing.
    assert_eq!(write_flat(&map, UNITS, 0, &flat["war3map.w3u.json"]).unwrap(), Written::default());
    // One change writes that object's file only; a new object isn't listed in order.txt; a deleted one loses its line.
    let changed = packed(3, &[], &[e(b"hfoo", b"h002", vec![]), e(b"hfoo", b"h000", vec![(b"umpm", V::Int(2), b"\0\0\0\0")]), e(b"hfoo", b"h001", vec![])]);
    let w = write_flat(&map, UNITS, 0, &objdata::to_json(&changed, false).unwrap()).unwrap();
    assert_eq!(w, Written { written: vec!["objects/units/custom/h000.json".into()], removed: vec![] });
    let added = packed(3, &[], &[e(b"hfoo", b"h000", vec![(b"umpm", V::Int(2), b"\0\0\0\0")]), e(b"hfoo", b"h001", vec![]), e(b"hfoo", b"h003", vec![])]);
    let w = write_flat(&map, UNITS, 0, &objdata::to_json(&added, false).unwrap()).unwrap();
    assert_eq!(w.written, ["objects/units/custom/h003.json"]);
    assert_eq!(w.removed, ["objects/units/custom/h002.json", "objects/units/custom/order.txt"], "h002 had only this half; order.txt listed only it");
    assert!(std::fs::read_to_string(map.join("objects/units/custom/h000.json")).unwrap().contains("\"skin\""), "the other half stays");
    // Deleting the data half of h000 keeps its file for the skin half.
    let fewer = packed(3, &[], &[e(b"hfoo", b"h001", vec![])]);
    let w = write_flat(&map, UNITS, 0, &objdata::to_json(&fewer, false).unwrap()).unwrap();
    assert_eq!(w.written, ["objects/units/custom/h000.json"]);
    assert_eq!(w.removed, ["objects/units/custom/h003.json"]);
    // A file written by hand in another form stays as it is when a write leaves its object as it was.
    let by_hand = b"{\"base\":\"hfoo\",\"id\":\"h001\",\"data\":{}}".to_vec();
    std::fs::write(map.join("objects/units/custom/h001.json"), &by_hand).unwrap();
    let other = packed(3, &[], &[e(b"hfoo", b"h001", vec![]), e(b"hfoo", b"h004", vec![])]);
    let w = write_flat(&map, UNITS, 0, &objdata::to_json(&other, false).unwrap()).unwrap();
    assert_eq!(w.written, ["objects/units/custom/h004.json"]);
    assert_eq!(std::fs::read(map.join("objects/units/custom/h001.json")).unwrap(), by_hand);
    let w = write_flat(&map, UNITS, 0, &objdata::to_json(&fewer, false).unwrap()).unwrap();
    assert_eq!(w.removed, ["objects/units/custom/h004.json"]);
    // A new object where the folder wouldn't put it (H000 after h001: unlisted objects come by id): a read gives back what
    // was written while the files are as the write left them, and the folder's order once they changed.
    let placed = packed(3, &[], &[e(b"hfoo", b"h001", vec![]), e(b"Hpal", b"H000", vec![])]);
    let placed_json = objdata::to_json(&placed, false).unwrap();
    let w = write_flat(&map, UNITS, 0, &placed_json).unwrap();
    assert_eq!(w.written, ["objects/units/custom/H000~8.json"], "not listed in order.txt");
    assert_eq!(read_flat(&map, UNITS, 0).unwrap().unwrap(), placed_json);
    let skin_before = read_flat(&map, UNITS, 1).unwrap().unwrap();
    std::fs::write(map.join("objects/units/custom/H000~8.json"), b"{\"id\": \"H000\", \"base\": \"Hpal\", \"data\": {}}").unwrap();
    let by_id = packed(3, &[], &[e(b"Hpal", b"H000", vec![]), e(b"hfoo", b"h001", vec![])]);
    assert_eq!(read_flat(&map, UNITS, 0).unwrap().unwrap(), objdata::to_json(&by_id, false).unwrap(), "changed outside: the folder's order");
    assert_eq!(read_flat(&map, UNITS, 1).unwrap().unwrap(), skin_before, "the other half as it was");
    let w = write_flat(&map, UNITS, 0, &objdata::to_json(&fewer, false).unwrap()).unwrap();
    assert_eq!(w.removed, ["objects/units/custom/H000~8.json"]);
    // A new kind: listed in objects.json.
    let items = packed(2, &[], &[e(b"ratc", b"I000", vec![])]);
    let w = write_flat(&map, KINDS[1], 0, &objdata::to_json(&items, false).unwrap()).unwrap();
    assert_eq!(w.written, ["objects/items/custom/I000~8.json", ROOT_FILE]);
    assert_eq!(read_flat(&map, KINDS[1], 0).unwrap().unwrap(), objdata::to_json(&items, false).unwrap());
    // Refused, nothing written: an id twice, a base other than the other half's, content that doesn't pack.
    let before = FOLDER.read_disk(&map).unwrap();
    let twice = packed(3, &[], &[e(b"hfoo", b"h001", vec![]), e(b"hfoo", b"h001", vec![])]);
    assert!(write_flat(&map, UNITS, 0, &objdata::to_json(&twice, false).unwrap()).unwrap_err().to_string().contains("lists h001 twice"));
    let rebased = packed(3, &[], &[e(b"hpea", b"h000", vec![])]);
    assert!(write_flat(&map, UNITS, 0, &objdata::to_json(&rebased, false).unwrap()).unwrap_err().to_string().contains("one base"));
    assert!(write_flat(&map, UNITS, 0, b"{\"format\": \"w3proj.objects/1\", \"version\": 3, \"original\": [], \"custom\": [{\"base\": \"hfoo\", \"id\": \"h009\", \"mods\": [{\"field\": \"umpm\", \"type\": \"int\", \"value\": 1.5}]}]}").is_err());
    assert!(write_flat(&map, UNITS, 0, b"not json").is_err());
    assert_eq!(FOLDER.read_disk(&map).unwrap(), before, "a refused write changed nothing");
    // A broken object file: reads and writes say which, nothing is written.
    std::fs::write(map.join("objects/units/custom/h001.json"), b"{").unwrap();
    assert!(read_flat(&map, UNITS, 0).unwrap_err().to_string().contains("map/objects/units/custom/h001.json can't be read"));
    assert!(write_flat(&map, UNITS, 0, &objdata::to_json(&fewer, false).unwrap()).unwrap_err().to_string().contains("h001.json"));
    // Deleting a flat file takes its half out.
    std::fs::write(map.join("objects/units/custom/h001.json"), text(&split_flat(&flat, Prefix::Map).layout, "objects/units/custom/h001.json")).unwrap();
    let w = delete_flat(&map, UNITS, 1).unwrap();
    assert_eq!(w.removed, ["objects/units/custom/h000.json"], "h000 had only its skin half left");
    assert_eq!(read_flat(&map, UNITS, 1).unwrap(), None);
    assert!(listed(&map).unwrap().contains(&(UNITS, 0)));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_flat_layout_and_raw_kinds_arent_answered_from_the_folder() {
    let dir = scratch("view");
    let map = dir.join("map");
    // No object data at all: the folder answers (a write makes it).
    assert_eq!(flat_view(&map, "war3map.w3u.json").unwrap(), Some((UNITS, 0)));
    assert_eq!(read_flat(&map, UNITS, 0).unwrap(), None);
    // A flat project (no objects.json, a flat object file): its files are what they are.
    std::fs::write(map.join("war3map.w3t.json"), b"{}").unwrap();
    assert_eq!(flat_view(&map, "war3map.w3u.json").unwrap(), None);
    assert_eq!(flat_view(&map, "war3map.w3t.json").unwrap(), None);
    std::fs::remove_file(map.join("war3map.w3t.json")).unwrap();
    // A kind kept raw.
    write_all(&map, &split_flat(&flat_files(Some(&packed(3, &[], &[])), None), Prefix::Map).layout);
    std::fs::write(map.join("war3map.w3a"), b"x").unwrap();
    assert_eq!(flat_view(&map, "war3map.w3a.json").unwrap(), None);
    assert_eq!(flat_view(&map, "war3mapSkin.w3a.json").unwrap(), None);
    assert_eq!(flat_view(&map, "war3map.w3u.json").unwrap(), Some((UNITS, 0)));
    // Not a project's map folder.
    std::fs::remove_file(dir.join(crate::project::MANIFEST)).unwrap();
    assert_eq!(flat_view(&map, "war3map.w3u.json").unwrap(), None);
    // A campaign's own map folder answers its own names.
    std::fs::write(dir.join(crate::project::MANIFEST), "format = 1\n").unwrap();
    std::fs::write(map.join("war3campaign.w3f.json"), b"{}").unwrap();
    assert_eq!(flat_view(&map, "war3campaign.w3u.json").unwrap(), Some((UNITS, 0)));
    assert_eq!(flat_view(&map, "war3map.w3u.json").unwrap(), None);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_sync_keeps_an_order_txt_that_still_gives_the_maps_order() {
    let dir = scratch("sync");
    let map = dir.join("map");
    let mut layout = sample_layout();
    // The project's own (longer) order.txt, which gives the same order: kept, with its line for a deleted object gone.
    layout.insert("objects/units/custom/order.txt".into(), b"h002\nh000\nh009\n".to_vec());
    write_all(&map, &layout);
    let mut incoming = sample_layout();
    prepare_sync(&map, &mut incoming).unwrap();
    assert_eq!(text(&incoming, "objects/units/custom/order.txt"), "h002\nh000\n");
    // A map in another order: the map's order.txt wins.
    let other = packed(3, &[], &[e(b"hfoo", b"h001", vec![]), e(b"hfoo", b"h000", vec![]), e(b"hfoo", b"h002", vec![])]);
    let mut incoming = split_flat(&flat_files(Some(&other), None), Prefix::Map).layout;
    prepare_sync(&map, &mut incoming).unwrap();
    assert_eq!(text(&incoming, "objects/units/custom/order.txt"), "h001\n");
    // A map in the default order, a project whose order.txt gives it too: kept.
    std::fs::write(map.join("objects/units/custom/order.txt"), b"h000\n").unwrap();
    let sorted = packed(3, &[], &[e(b"hfoo", b"h000", vec![]), e(b"hfoo", b"h001", vec![]), e(b"hfoo", b"h002", vec![])]);
    let mut incoming = split_flat(&flat_files(Some(&sorted), None), Prefix::Map).layout;
    prepare_sync(&map, &mut incoming).unwrap();
    assert_eq!(text(&incoming, "objects/units/custom/order.txt"), "h000\n");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Check Objects reports every file's fault at once, where pack stops at the first; a layout pack takes gives nothing.
#[test]
fn check_reports_every_fault_by_file() {
    use crate::trigger_check::Severity;
    let root = "{\n  \"format\": \"w3proj.objectfolders/1\",\n  \"files\": {\n    \"units\": {\"data\": 3}\n  }\n}\n";
    let unit = |id: &str, base: &str| format!("{{\"id\": \"{id}\", \"base\": \"{base}\", \"data\": {{\"mods\": []}}}}");
    let mut files = Files::new();
    let put = |files: &mut Files, p: &str, t: &str| {
        files.insert(p.to_string(), t.as_bytes().to_vec());
    };
    put(&mut files, "objects/objects.json", root);
    put(&mut files, "objects/units/custom/h000.json", &unit("h000", "hfoo"));
    put(&mut files, "objects/units/original/hkni.json", "{\"base\": \"hkni\", \"data\": {\"mods\": []}}");
    // The game's own folder of that name is no part of the layout.
    put(&mut files, "Objects/InventoryItems/x.txt", "x");
    assert_eq!(check::check(&files, Prefix::Map), vec![]);
    assert!(assemble(&files, &[], Prefix::Map, &mut Vec::new()).is_ok());

    put(&mut files, "objects/units/custom/h001.json", "{\n<<<<<<< ours\n=======\n>>>>>>> theirs\n}");
    put(&mut files, "objects/units/custom/h002.json", &unit("h003", "hfoo"));
    put(&mut files, "objects/units/custom/hkni.json", &unit("hkni", "hfoo"));
    put(&mut files, "objects/units/custom/h004.json", "{\"id\": \"h004\", \"base\": \"hfoo\", \"skin\": {\"mods\": []}}");
    put(&mut files, "objects/units/custom/order.txt", "h000\nh000\nh999\nh001\n");
    put(&mut files, "objects/units/notes.md", "n");
    let got = check::check(&files, Prefix::Map);
    let of = |s: Severity| got.iter().filter(|i| i.severity == s).map(|i| (i.file.as_str(), i.line)).collect::<Vec<_>>();
    assert_eq!(
        of(Severity::Error),
        [
            ("objects/units/custom/h001.json", Some(2)),
            ("objects/units/custom/h002.json", None),
            ("objects/units/custom/h004.json", None),
            ("objects/units/custom/hkni.json", None),
            ("objects/units/notes.md", None),
        ],
        "{got:#?}"
    );
    // h000 twice and h999 without a file; h001 has a file, though it can't be read.
    assert_eq!(of(Severity::Warning), [("objects/units/custom/order.txt", None), ("objects/units/custom/order.txt", None)], "{got:#?}");
    assert!(assemble(&files, &[], Prefix::Map, &mut Vec::new()).is_err());
}

/// One id as a new object and as a changed standard one (a merge, a copied file): pack refuses it, naming both files.
#[test]
fn one_id_in_both_tables_is_refused() {
    let mut files = Files::new();
    files.insert("objects/objects.json".into(), b"{\"format\": \"w3proj.objectfolders/1\", \"files\": {\"units\": {\"data\": 3}}}".to_vec());
    files.insert("objects/units/custom/hkni.json".into(), b"{\"id\": \"hkni\", \"base\": \"hfoo\", \"data\": {\"mods\": []}}".to_vec());
    files.insert("objects/units/original/hkni.json".into(), b"{\"base\": \"hkni\", \"data\": {\"mods\": []}}".to_vec());
    let e = assemble(&files, &[], Prefix::Map, &mut Vec::new()).unwrap_err().to_string();
    assert!(e.contains("custom/hkni.json") && e.contains("original/hkni.json"), "{e}");
    let got = check::check(&files, Prefix::Map);
    assert_eq!(got.len(), 1, "{got:#?}");
    assert_eq!(got[0].file, "objects/units/custom/hkni.json");
}
