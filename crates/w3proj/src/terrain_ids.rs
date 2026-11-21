//! Creation numbers (`editorId`; a version-13 doodad's `trailer[0]`; a region's `index`) in the split terrain layout
//! (`terrain_layout`). Scripts refer to them (`gg_unit_hfoo_0012`, `gg_dest_…`), so an existing number never changes.
//!
//! **Allocation** is the app's (`app/src/lib/terrain/creationids.ts`, one function for every new object): in a split
//! project a new object gets the lowest number of its subterrain's `idRange` that no object of its kind namespace uses
//! map-wide; when the ranges are full, the lowest free one in the next block of 10000 above every range
//! (`block_of`). Kind namespaces as the flat files have them: units and items one (`war3mapUnits.doo`), doodads and
//! destructables one (`war3map.doo`), regions one (`war3map.w3r`).
//!
//! **Recording a new range** happens here, when the object is saved (`terrain_layout::write_flat`): a number that is
//! new in the write and lies above every range gets its block recorded for the subterrain holding the object
//! (`record_new`). So `terrain.json` is written under the same lock as the objects, and a range nobody saved an object
//! in is never recorded.
//!
//! **Checking** (`check`, `w3proj terrain check`): numbers found twice in one kind namespace and ranges that overlap are
//! errors; numbers outside their subterrain's ranges are information only (an object moved over a seam keeps its
//! number, and an imported map's numbers lie anywhere).

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use crate::terrain_layout::{self as tl, Layout, RangeOverlap, Subterrain};
use crate::terrain_objects::{self as objects, Kind};
use crate::{Error, Result};

/// How large an id range is, and what its start is a multiple of: the i-th subterrain of a first split gets
/// `[i · 10000, i · 10000 + 9999]` (i from 1), a range added later the next block above every range.
pub const BLOCK: u32 = 10000;

/// The block of `BLOCK` numbers holding `n`, never reaching 4294967295 (not an assignment).
pub fn block_of(n: u32) -> [u32; 2] {
    let lo = n / BLOCK * BLOCK;
    [lo, lo.saturating_add(BLOCK - 1).min(u32::MAX - 1)]
}

/// Records the ranges new creation numbers were allocated in (`new`: number and the index of the subterrain holding
/// its object): a number above every range of every subterrain gets its block (`block_of`) added to its subterrain's
/// ranges. A number inside a range, or below the highest one (a number typed by hand, an imported one), records
/// nothing. 0 and 4294967295 never do.
pub fn record_new(subs: &mut [Subterrain], new: impl IntoIterator<Item = (u32, usize)>) {
    for (n, i) in new {
        // 0 and 4294967295 record nothing for any kind (a region 0 lies below every range anyway).
        if !objects::assigned(Kind::Units, n) || i >= subs.len() {
            continue;
        }
        let top = subs.iter().flat_map(|s| s.id_ranges.iter().map(|r| r[1])).max();
        if top.is_some_and(|t| n <= t) {
            continue;
        }
        let mut block = block_of(n);
        // A range ending inside n's block (one written by hand): the new range starts after it.
        if let Some(t) = top {
            block[0] = block[0].max(t + 1);
        }
        subs[i].id_ranges.push(block);
        subs[i].id_ranges.sort();
    }
}

/// A creation number found more than once in one kind namespace: the files holding it (relative to the project; a
/// file twice when it holds the number twice).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Duplicate {
    pub kind: &'static str,
    pub number: u32,
    pub files: Vec<String>,
}

/// Objects of one kind in one subterrain whose numbers lie outside its ranges: how many, the lowest few.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Outside {
    pub subterrain: String,
    pub kind: &'static str,
    pub count: usize,
    pub examples: Vec<u32>,
}

/// What `check` found.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Report {
    pub duplicates: Vec<Duplicate>,
    pub overlaps: Vec<RangeOverlap>,
    /// Information only: moved objects and imported maps have numbers outside their subterrain's ranges.
    pub outside: Vec<Outside>,
    /// How many assigned numbers were checked.
    pub numbers: usize,
}

impl Report {
    /// Whether it found an error (a number twice, ranges that overlap).
    pub fn has_errors(&self) -> bool {
        !self.duplicates.is_empty() || !self.overlaps.is_empty()
    }

    /// The report as lines of text: errors, then information, then a summary line.
    pub fn lines(&self) -> Vec<String> {
        let mut out = Vec::new();
        for d in &self.duplicates {
            out.push(format!("error: creation number {} ({}) is in {}", d.number, d.kind, d.files.join(" and ")));
        }
        for o in &self.overlaps {
            out.push(format!("error: {o}"));
        }
        for o in &self.outside {
            let more = if o.count > o.examples.len() { ", …" } else { "" };
            let list = o.examples.iter().map(u32::to_string).collect::<Vec<_>>().join(", ");
            out.push(format!("info: {} {} in \"{}\" have numbers outside its idRange ({list}{more})", o.count, o.kind, o.subterrain));
        }
        out.push(format!(
            "{} creation numbers checked: {} found twice, {} overlapping ranges, {} outside their subterrain's ranges (information)",
            self.numbers,
            self.duplicates.len(),
            self.overlaps.len(),
            self.outside.iter().map(|o| o.count).sum::<usize>()
        ));
        out
    }
}

/// How many numbers `Outside` lists.
const EXAMPLES: usize = 5;

/// Checks a split layout's files (relative to `map/`): numbers twice per kind namespace, overlapping ranges, numbers
/// outside their subterrain's ranges. Whatever stops the files being read (a `terrain.json` or object file that can't
/// be read, rectangles that overlap, …) is an error.
pub fn check_files(files: &BTreeMap<String, Vec<u8>>) -> Result<Report> {
    let bytes = files.get(tl::LAYOUT_FILE).ok_or_else(|| Error::Project(format!("map/{} is missing", tl::LAYOUT_FILE)))?;
    let layout = Layout::parse_unchecked(bytes)?;
    layout.check_shape()?;
    let numbers = objects::sub_numbers(&layout.objects, &layout.subterrains, &|p| files.get(p).cloned())?;
    let mut seen: BTreeMap<(Kind, u32), Vec<String>> = BTreeMap::new();
    let mut outside: BTreeMap<(usize, Kind), Vec<u32>> = BTreeMap::new();
    for n in &numbers {
        seen.entry((n.kind, n.number)).or_default().push(format!("map/{}", n.path));
        if !layout.subterrains[n.sub].id_ranges.iter().any(|r| r[0] <= n.number && n.number <= r[1]) {
            outside.entry((n.sub, n.kind)).or_default().push(n.number);
        }
    }
    let duplicates = seen.into_iter().filter(|(_, f)| f.len() > 1).map(|((kind, number), files)| Duplicate { kind: kind.name(), number, files }).collect();
    let outside = outside
        .into_iter()
        .map(|((sub, kind), mut ns)| {
            ns.sort_unstable();
            Outside { subterrain: layout.subterrains[sub].name.clone(), kind: kind.name(), count: ns.len(), examples: ns.into_iter().take(EXAMPLES).collect() }
        })
        .collect();
    Ok(Report { duplicates, overlaps: layout.range_overlaps(), outside, numbers: numbers.len() })
}

/// `check_files` on a project's `map/terrain/`. A project whose terrain isn't split is an error (it has no ranges, and
/// every load of it checks its numbers anyway).
pub fn check(project: &Path) -> Result<Report> {
    let map_dir = project.join(crate::project::MAP_DIR);
    if !tl::is_split_on_disk(&map_dir)? {
        return Err(Error::Project(format!("the terrain isn't split (there is no map/{}): there are no subterrains to check", tl::LAYOUT_FILE)));
    }
    check_files(&tl::read_layout_files(&map_dir)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub(name: &str, ranges: &[[u32; 2]]) -> Subterrain {
        Subterrain { name: name.into(), folder: name.into(), x: 0, y: 0, w: 1, h: 1, id_ranges: ranges.to_vec() }
    }

    #[test]
    fn blocks() {
        assert_eq!(block_of(10000), [10000, 19999]);
        assert_eq!(block_of(39999), [30000, 39999]);
        assert_eq!(block_of(5), [0, 9999]);
        assert_eq!(block_of(u32::MAX - 1), [4294960000, u32::MAX - 1], "never 4294967295");
    }

    /// A number above every range records its block for its subterrain; one inside a range, below the top, or
    /// unassigned records nothing; the result stays valid (no overlaps).
    #[test]
    fn new_numbers_record_their_block() {
        let mut subs = vec![sub("a", &[[10000, 19999]]), sub("b", &[[20000, 29999]])];
        record_new(&mut subs, [(15000, 0), (25000, 0), (5, 1), (0, 0), (u32::MAX, 1)]);
        assert_eq!(subs[0].id_ranges, [[10000, 19999]], "inside a range or below the top: nothing");
        assert_eq!(subs[1].id_ranges, [[20000, 29999]]);
        record_new(&mut subs, [(30000, 0), (30001, 1), (40007, 1)]);
        assert_eq!(subs[0].id_ranges, [[10000, 19999], [30000, 39999]], "a's range was full: the next block");
        assert_eq!(subs[1].id_ranges, [[20000, 29999], [40000, 49999]], "30001 is a's now; 40007 opens b's next block");
        // A hand-written top range ending inside a block: the new one starts after it.
        let mut subs = vec![sub("a", &[[10000, 12345]])];
        record_new(&mut subs, [(12346, 0)]);
        assert_eq!(subs[0].id_ranges, [[10000, 12345], [12346, 19999]]);
    }

    fn layout_files(subterrains: &str, units: &[(&str, &str)]) -> BTreeMap<String, Vec<u8>> {
        let json = format!(
            "{{\"format\":\"w3proj.terrain/1\",\"tileset\":\"L\",\"customTilesets\":1,\"ground\":[\"Ldrt\"],\"cliffs\":[],\"corners\":[4,2],\"offset\":[0,0],\"w3eVersion\":12,\"trailer\":\"\",\
             \"defaultCorner\":{{\"height\":0,\"water\":0,\"waterBits\":0,\"texture\":0,\"textureBits\":0,\"variation\":0,\"cliffVariation\":0,\"cliffTexture\":15,\"layer\":2,\"flags\":8}},\
             \"dooHeader\":{{\"doodadsVersion\":8,\"doodadsSubversion\":11,\"unitsVersion\":8,\"unitsSubversion\":11,\"skinIds\":true}},\"objects\":{{\"units\":{{\"magic\":\"W3do\"}}}},\"subterrains\":[{subterrains}]}}"
        );
        let mut files = BTreeMap::from([(tl::LAYOUT_FILE.to_string(), json.into_bytes())]);
        for (folder, list) in units {
            files.insert(format!("terrain/{folder}/units.json"), format!("{{\"units\":[{list}]}}").into_bytes());
        }
        files
    }

    fn unit(n: u32, x: f64) -> String {
        format!("{{\"id\":\"hfoo\",\"position\":[{x},10,0],\"editorId\":{n}}}")
    }

    #[test]
    fn check_lists_duplicates_overlaps_and_outside() {
        let subs = "{\"name\":\"w\",\"folder\":\"w\",\"x\":0,\"y\":0,\"w\":2,\"h\":2,\"idRange\":[10000,19999]},{\"name\":\"e\",\"folder\":\"e\",\"x\":2,\"y\":0,\"w\":2,\"h\":2,\"idRange\":[[20000,29999],[30000,39999]]}";
        let w = [unit(10000, 10.0), unit(3, 20.0), unit(0, 30.0), unit(0, 40.0)].join(",");
        let e = [unit(30000, 300.0), unit(10000, 310.0), unit(u32::MAX, 320.0), unit(u32::MAX, 330.0)].join(",");
        let r = check_files(&layout_files(subs, &[("w", &w), ("e", &e)])).unwrap();
        assert_eq!(r.duplicates, [Duplicate { kind: "units", number: 10000, files: vec!["map/terrain/w/units.json".into(), "map/terrain/e/units.json".into()] }]);
        assert!(r.overlaps.is_empty());
        assert_eq!(
            r.outside,
            [
                Outside { subterrain: "w".into(), kind: "units", count: 1, examples: vec![3] },
                Outside { subterrain: "e".into(), kind: "units", count: 1, examples: vec![10000] },
            ],
            "0 and 4294967295 aren't assignments: neither twice nor outside"
        );
        assert_eq!(r.numbers, 4);
        assert!(r.has_errors());
        assert!(r.lines()[0].contains("creation number 10000 (units) is in map/terrain/w/units.json and map/terrain/e/units.json"), "{:?}", r.lines());
        // Control: without the second 10000, no error; the moved-in number stays information.
        let e = [unit(30000, 300.0), unit(20001, 310.0)].join(",");
        let r = check_files(&layout_files(subs, &[("w", &w), ("e", &e)])).unwrap();
        assert!(!r.has_errors(), "{:?}", r.lines());
        // Overlapping ranges are listed (loading stops at them).
        let over = subs.replace("[30000,39999]", "[15000,39999]");
        let files = layout_files(&over, &[("w", &w), ("e", &e)]);
        assert!(Layout::parse(&files[tl::LAYOUT_FILE]).err().map(|e| e.to_string()).unwrap_or_default().contains("overlap"));
        let r = check_files(&files).unwrap();
        assert_eq!(r.overlaps.len(), 2, "with w's range and with e's own other one: {:?}", r.overlaps);
        assert!(r.has_errors() && r.lines().iter().any(|l| l.contains("the idRanges of \"w\" and \"e\" overlap")), "{:?}", r.lines());
        assert!(r.lines().iter().any(|l| l.contains("two idRanges of \"e\" overlap")), "{:?}", r.lines());
        // A file that can't be read is an error, not a report.
        let mut files = layout_files(subs, &[("w", &w), ("e", &e)]);
        files.insert("terrain/e/units.json".into(), b"{ broken".to_vec());
        assert!(check_files(&files).is_err());
    }
}
