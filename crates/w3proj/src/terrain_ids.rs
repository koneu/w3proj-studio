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
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Duplicate {
    pub kind: &'static str,
    pub number: u32,
    pub files: Vec<String>,
    /// Every object holding it: file, index, type, position, exact copies (`fix_plan`'s groups).
    pub members: Vec<FixMember>,
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
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
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
            let place = match d.files.as_slice() {
                [first, rest @ ..] if rest.iter().all(|f| f == first) => format!("{} times in {first}", d.files.len()),
                _ => format!("in {}", d.files.join(" and ")),
            };
            out.push(format!("error: creation number {} ({}) is {place}", d.number, d.kind));
            for m in &d.members {
                let at = m.x.zip(m.y).map(|(x, y)| format!(" at ({x:.0}, {y:.0})")).unwrap_or_default();
                let copy = m.copy_of.map(|c| format!(", an exact copy of [{c}]")).unwrap_or_default();
                out.push(format!("  {} [{}] {}{at}{copy}", m.file, m.index, m.id));
            }
        }
        if !self.duplicates.is_empty() {
            out.push(format!("fix: {}", objects::FIX_HINT));
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
    let duplicates = seen.into_iter().filter(|(_, f)| f.len() > 1).map(|((kind, number), files)| Duplicate { kind: kind.name(), number, files, members: Vec::new() }).collect();
    let outside = outside
        .into_iter()
        .map(|((sub, kind), mut ns)| {
            ns.sort_unstable();
            Outside { subterrain: layout.subterrains[sub].name.clone(), kind: kind.name(), count: ns.len(), examples: ns.into_iter().take(EXAMPLES).collect() }
        })
        .collect();
    Ok(Report { duplicates, overlaps: layout.range_overlaps(), outside, numbers: numbers.len() })
}

/// A project's creation numbers: `check_files` on a split project's `map/terrain/`; a flat project's object files for
/// numbers found twice (it has no ranges). Each number found twice lists every object holding it (`fix_plan`).
pub fn check(project: &Path) -> Result<Report> {
    let map_dir = project.join(crate::project::MAP_DIR);
    let mut report = if tl::is_split_on_disk(&map_dir)? {
        check_files(&tl::read_layout_files(&map_dir)?)?
    } else {
        let mut numbers = 0;
        for kind in objects::KINDS {
            match std::fs::read(map_dir.join(kind.flat())) {
                Ok(b) => numbers += objects::flat_numbers(kind, &b, [0.0, 0.0])?.len(),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(Error::Project(format!("map/{} can't be read: {e}", kind.flat()))),
            }
        }
        Report { numbers, ..Report::default() }
    };
    let groups = fix_plan(project, None)?.groups;
    if groups.is_empty() {
        return Ok(report);
    }
    if report.duplicates.is_empty() {
        report.duplicates = groups.iter().map(|g| Duplicate { kind: g.kind, number: g.number, files: g.members.iter().map(|m| m.file.clone()).collect(), members: Vec::new() }).collect();
    }
    for d in &mut report.duplicates {
        if let Some(g) = groups.iter().find(|g| g.kind == d.kind && g.number == d.number) {
            d.members = g.members.clone();
        }
    }
    Ok(report)
}

// ---- fixing creation numbers found twice (Fix Duplicate Creation Numbers…, `w3proj terrain fix-ids`) ----

/// What to do with the members of a creation number found twice. Nothing changes without one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FixMode {
    /// Every member but the first (the lowest index) gets the next free number.
    Renumber,
    /// Members that are exact copies of an earlier member (every field alike but the number) are removed; the others
    /// stay and are reported.
    DeleteCopies,
}

impl FixMode {
    pub fn name(self) -> &'static str {
        match self {
            FixMode::Renumber => "renumber",
            FixMode::DeleteCopies => "deleteCopies",
        }
    }
}

/// One member of a group (`FixGroup`) and what the fix does with it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixMember {
    /// The file holding it, relative to the project (a split project: its subterrain's file).
    pub file: String,
    /// Its index in the flat file's list (a split project: in the merged list, `w3proj terrain merge`'s).
    pub index: usize,
    pub id: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    /// The index of an earlier member it is an exact copy of.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy_of: Option<usize>,
    /// "keep" (the first, and every member without a fix chosen), "renumber", "delete", or "stays" (not an exact
    /// copy: Delete Copies leaves it, still sharing the number).
    pub action: &'static str,
    /// Its new number ("renumber").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<u32>,
}

/// The objects of one kind namespace sharing a creation number.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FixGroup {
    pub kind: &'static str,
    pub number: u32,
    pub members: Vec<FixMember>,
}

/// What `fix_plan` found and would do; `files` is what `fix_write` writes.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixPlan {
    pub mode: Option<&'static str>,
    pub groups: Vec<FixGroup>,
    pub renumbered: usize,
    pub deleted: usize,
    /// Members still sharing a number with another after the fix (Delete Copies: those that differ).
    pub still_twice: usize,
    /// Object files that are kept raw (their codec couldn't read them): not checked.
    pub unchecked: Vec<String>,
    /// The new files, relative to the project. A flat project's are JSON to be written in its codec's form.
    #[serde(skip)]
    pub files: BTreeMap<String, Vec<u8>>,
}

impl FixPlan {
    /// The plan as lines of text: per group its members and what happens to them, then a summary line.
    pub fn lines(&self) -> Vec<String> {
        let mut out = Vec::new();
        for g in &self.groups {
            out.push(format!("creation number {} ({}) is on {} objects:", g.number, g.kind, g.members.len()));
            for m in &g.members {
                let at = match (m.x, m.y) {
                    (Some(x), Some(y)) => format!(" at ({x:.0}, {y:.0})"),
                    _ => String::new(),
                };
                let copy = m.copy_of.map(|c| format!(", an exact copy of [{c}]")).unwrap_or_default();
                let what = match (m.action, m.to) {
                    ("renumber", Some(n)) => format!(": gets {n}"),
                    ("delete", _) => ": deleted".into(),
                    ("stays", _) => ": stays (not an exact copy)".into(),
                    _ => String::new(),
                };
                out.push(format!("  {} [{}] {}{at}{copy}{what}", m.file, m.index, m.id));
            }
        }
        let total: usize = self.groups.iter().map(|g| g.members.len()).sum();
        out.push(match self.mode {
            None => format!("{} creation numbers found twice, on {total} objects (--renumber or --delete-copies says what to do)", self.groups.len()),
            Some(_) => format!("{} creation numbers found twice, on {total} objects: {} renumbered, {} deleted, {} still sharing a number", self.groups.len(), self.renumbered, self.deleted, self.still_twice),
        });
        for u in &self.unchecked {
            out.push(format!("not checked: {u} is kept raw"));
        }
        out
    }
}

/// Every creation number found more than once in a project, flat or split, with all its members, and (`mode`) what
/// fixing them does: the new files are in the plan, nothing is written. Renumbering gives each member but the first the
/// lowest free number of its subterrain's ranges that no object of its kind namespace uses (the ranges full: above
/// every range, recorded in `terrain.json` as `record_new` does), in a flat map the next above the highest number in
/// use; never 0 or 4294967295. A fix of a split project with subterrains closed is refused (it rewrites any of them).
pub fn fix_plan(project: &Path, mode: Option<FixMode>) -> Result<FixPlan> {
    let map_dir = project.join(crate::project::MAP_DIR);
    let mut plan = FixPlan { mode: mode.map(FixMode::name), ..FixPlan::default() };
    // The flat files (kind → bytes), and for a split project its layout.
    let mut flats: objects::Flats = BTreeMap::new();
    let mut split: Option<Layout> = None;
    if tl::is_split_on_disk(&map_dir)? {
        let files = tl::read_layout_files(&map_dir)?;
        let layout = Layout::parse(files.get(tl::LAYOUT_FILE).ok_or_else(|| Error::Project(format!("map/{} is missing", tl::LAYOUT_FILE)))?)?;
        if mode.is_some() && crate::terrain_open::of_map_dir(&map_dir, &layout)?.is_some() {
            return Err(Error::Project("some subterrains are closed, and the fix may change any of them: open them all (Open Subterrains…) first".into()));
        }
        flats = objects::assemble_twice_ok(&layout.objects, &layout.subterrains, &|p| files.get(p).cloned())?;
        split = Some(layout);
    } else {
        for kind in objects::KINDS {
            match std::fs::read(map_dir.join(kind.flat())) {
                Ok(b) => {
                    flats.insert(kind, b);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    if map_dir.join(kind.raw()).exists() {
                        plan.unchecked.push(format!("map/{}", kind.raw()));
                    }
                }
                Err(e) => return Err(Error::Project(format!("map/{} can't be read: {e}", kind.flat()))),
            }
        }
    }
    let offset = split.as_ref().map(|l| l.offset()).unwrap_or([0.0, 0.0]);
    let mut subs: Vec<Subterrain> = split.as_ref().map(|l| l.subterrains.clone()).unwrap_or_default();
    let mut changed: objects::Flats = BTreeMap::new();
    for (&kind, bytes) in &flats {
        let twins = objects::flat_twins(kind, bytes)?;
        if twins.is_empty() {
            continue;
        }
        let mut used: std::collections::HashSet<u32> = objects::flat_numbers(kind, bytes, offset)?.into_iter().map(|(n, _, _)| n).collect();
        let mut renumber: Vec<(usize, u32)> = Vec::new();
        let mut delete: Vec<usize> = Vec::new();
        for t in twins {
            let mut members = Vec::with_capacity(t.members.len());
            for (m, tw) in t.members.into_iter().enumerate() {
                let sub = tw.x.zip(tw.y).map(|(x, y)| objects::owner(&subs, offset, x, y)).unwrap_or(0);
                let file = match &split {
                    Some(_) => format!("{}/{}", crate::project::MAP_DIR, subs[sub].object_path(kind)),
                    None => format!("{}/{}", crate::project::MAP_DIR, kind.flat()),
                };
                let (action, to) = match mode {
                    _ if m == 0 => ("keep", None),
                    None => ("keep", None),
                    Some(FixMode::DeleteCopies) if tw.copy_of.is_some() => ("delete", None),
                    Some(FixMode::DeleteCopies) => ("stays", None),
                    Some(FixMode::Renumber) => {
                        let n = if split.is_some() { next_in_subterrain(&mut subs, sub, &used)? } else { next_above(kind, &used)? };
                        used.insert(n);
                        ("renumber", Some(n))
                    }
                };
                match (action, to) {
                    ("renumber", Some(n)) => {
                        renumber.push((tw.index, n));
                        plan.renumbered += 1;
                    }
                    ("delete", _) => {
                        delete.push(tw.index);
                        plan.deleted += 1;
                    }
                    ("stays", _) => plan.still_twice += 1,
                    _ => {}
                }
                members.push(FixMember { file, index: tw.index, id: tw.id, x: tw.x, y: tw.y, copy_of: tw.copy_of, action, to });
            }
            // Delete Copies: the first stays sharing its number when a member that differs stays too.
            if members.iter().any(|m| m.action == "stays") {
                plan.still_twice += 1;
            }
            plan.groups.push(FixGroup { kind: kind.name(), number: t.number, members });
        }
        if !renumber.is_empty() || !delete.is_empty() {
            changed.insert(kind, objects::flat_fixed(kind, bytes, &renumber, &delete)?);
        }
    }
    if changed.is_empty() {
        return Ok(plan);
    }
    match split {
        None => {
            for (kind, bytes) in changed {
                plan.files.insert(format!("{}/{}", crate::project::MAP_DIR, kind.flat()), bytes);
            }
        }
        Some(mut layout) => {
            let (_, sliced) = objects::slice(&changed, &subs, offset)?;
            let disk = |rel: &str| std::fs::read(crate::paths::join_rel(&map_dir, rel)).ok();
            for (rel, bytes) in sliced {
                if disk(&rel).as_deref() != Some(bytes.as_slice()) {
                    plan.files.insert(format!("{}/{rel}", crate::project::MAP_DIR), bytes);
                }
            }
            if subs != layout.subterrains {
                layout.subterrains = subs;
                plan.files.insert(format!("{}/{}", crate::project::MAP_DIR, tl::LAYOUT_FILE), layout.to_json()?);
            }
        }
    }
    Ok(plan)
}

/// Writes a plan's files (`fix_plan`), relative to the project, as they are (a flat project's object files as JSON:
/// the backend writes them in their codec's form instead). The paths written.
pub fn fix_write(project: &Path, plan: &FixPlan) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for (rel, bytes) in &plan.files {
        if crate::project::write_if_changed(&crate::paths::join_rel(project, rel), bytes)? {
            out.push(rel.clone());
        }
    }
    Ok(out)
}

/// The next free number above every number of the kind in use (a flat map): never 0 or 4294967295.
fn next_above(kind: Kind, used: &std::collections::HashSet<u32>) -> Result<u32> {
    let top = used.iter().copied().filter(|n| objects::assigned(kind, *n)).max().unwrap_or(0);
    top.checked_add(1).filter(|n| *n != u32::MAX).ok_or_else(|| Error::Project(format!("no creation number is left above {top}")))
}

/// The lowest free number in subterrain `sub`'s ranges; the ranges full, the lowest free above every range, whose
/// block is then recorded for it (`record_new`).
fn next_in_subterrain(subs: &mut [Subterrain], sub: usize, used: &std::collections::HashSet<u32>) -> Result<u32> {
    let free = |n: &u32| objects::assigned(Kind::Units, *n) && !used.contains(n);
    if let Some(n) = subs[sub].id_ranges.iter().find_map(|r| (r[0]..=r[1]).find(free)) {
        return Ok(n);
    }
    let top = subs.iter().flat_map(|s| s.id_ranges.iter().map(|r| r[1])).max().unwrap_or(0);
    let n = (top.saturating_add(1)..u32::MAX).find(free).ok_or_else(|| Error::Project("no creation number is left above every id range".into()))?;
    record_new(subs, [(n, sub)]);
    Ok(n)
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
        assert_eq!(r.duplicates, [Duplicate { kind: "units", number: 10000, files: vec!["map/terrain/w/units.json".into(), "map/terrain/e/units.json".into()], members: Vec::new() }]);
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

    /// The mini map as a flat project with the pattern of a real map that couldn't be split (wowr4.6: creation number
    /// 581 on three stacked LT04 doodads, the last an exact copy of the one before, the first differing).
    fn stacked_twins(tag: &str) -> (std::path::PathBuf, serde_json::Value) {
        let mini = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mini-map/map");
        let root = std::env::temp_dir().join(format!("w3proj-fixids-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("map")).unwrap();
        std::fs::copy(mini.join("../w3proj.toml"), root.join("w3proj.toml")).unwrap();
        for e in std::fs::read_dir(&mini).unwrap() {
            let e = e.unwrap();
            if e.file_type().unwrap().is_file() {
                std::fs::copy(e.path(), root.join("map").join(e.file_name())).unwrap();
            }
        }
        let path = root.join("map").join("war3map.doo.json");
        let mut doo: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let list = doo["doodads"].as_array_mut().unwrap();
        let mut lt = list[1].clone();
        lt["id"] = "LT04".into();
        lt["skinId"] = "LT04".into();
        lt["position"] = serde_json::json!([96.0, 96.0, 0.0]);
        lt["editorId"] = 581.into();
        let mut other = lt.clone();
        other["variation"] = 3.into();
        list.extend([other, lt.clone(), lt]);
        std::fs::write(&path, serde_json::to_vec_pretty(&doo).unwrap()).unwrap();
        (root, doo)
    }

    /// Only these entries' creation numbers differ between two doodad files: every other value is the same.
    fn only_numbers_differ(a: &serde_json::Value, b: &serde_json::Value, changed: &[(usize, u64)]) {
        let (la, lb) = (a["doodads"].as_array().unwrap(), b["doodads"].as_array().unwrap());
        assert_eq!(la.len(), lb.len());
        for (i, (x, y)) in la.iter().zip(lb).enumerate() {
            match changed.iter().find(|c| c.0 == i) {
                Some(&(_, n)) => {
                    assert_eq!(y["editorId"].as_u64(), Some(n), "[{i}]");
                    let mut y = y.clone();
                    y["editorId"] = x["editorId"].clone();
                    assert_eq!(x, &y, "[{i}]: only its number changed");
                }
                None => assert_eq!(x, y, "[{i}]"),
            }
        }
        assert_eq!(a["specials"], b["specials"]);
    }

    /// A flat project's numbers found twice: the check lists every member (index, type, position, the exact copy), the
    /// split refuses naming all three and pointing at the fix, nothing is written without a fix chosen; Renumber gives
    /// the second and third the next numbers above the highest, changes nothing else, and the map splits and merges back.
    #[test]
    fn numbers_found_twice_in_a_flat_project_are_listed_and_renumbered() {
        let (root, before) = stacked_twins("renumber");
        let r = check(&root).unwrap();
        assert!(r.has_errors());
        assert_eq!(r.duplicates.len(), 1);
        let d = &r.duplicates[0];
        assert_eq!((d.kind, d.number), ("doodads", 581));
        let m: Vec<(usize, &str, Option<usize>)> = d.members.iter().map(|m| (m.index, m.id.as_str(), m.copy_of)).collect();
        assert_eq!(m, [(2, "LT04", None), (3, "LT04", None), (4, "LT04", Some(3))]);
        assert_eq!((d.members[0].x, d.members[0].y), (Some(96.0), Some(96.0)));
        assert!(r.lines().iter().any(|l| l.contains("map/war3map.doo.json [4] LT04 at (96, 96), an exact copy of [3]")), "{:?}", r.lines());
        let e = tl::split_project(&root, &[]).unwrap_err().to_string();
        assert!(e.contains("doodads[2], doodads[3] and doodads[4] have the same creation number 581") && e.contains("fix-ids"), "{e}");
        // Without a fix chosen: the plan lists them, no files.
        let look = fix_plan(&root, None).unwrap();
        assert!(look.files.is_empty() && look.renumbered == 0 && look.groups[0].members.iter().all(|m| m.action == "keep"));
        let plan = fix_plan(&root, Some(FixMode::Renumber)).unwrap();
        assert_eq!((plan.renumbered, plan.deleted, plan.still_twice), (2, 0, 0));
        assert_eq!(plan.groups[0].members.iter().map(|m| (m.action, m.to)).collect::<Vec<_>>(), [("keep", None), ("renumber", Some(582)), ("renumber", Some(583))]);
        assert_eq!(plan.files.keys().collect::<Vec<_>>(), ["map/war3map.doo.json"]);
        assert_eq!(fix_write(&root, &plan).unwrap(), ["map/war3map.doo.json"]);
        let fixed: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("map/war3map.doo.json")).unwrap()).unwrap();
        only_numbers_differ(&before, &fixed, &[(3, 582), (4, 583)]);
        assert!(!check(&root).unwrap().has_errors());
        tl::split_project(&root, &[]).unwrap();
        tl::merge_project(&root).unwrap();
        let merged: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("map/war3map.doo.json")).unwrap()).unwrap();
        assert_eq!(merged, fixed, "split and merged back unchanged");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Delete Copies removes only the exact copy; the member that differs stays, still sharing the number, so the
    /// split still refuses; a Renumber after it fixes the rest. A split project: renumbered within its subterrain's
    /// range, then above every range (recorded in terrain.json) once that is full.
    #[test]
    fn delete_copies_leaves_members_that_differ_and_split_projects_renumber_in_their_ranges() {
        let (root, before) = stacked_twins("delete");
        let plan = fix_plan(&root, Some(FixMode::DeleteCopies)).unwrap();
        assert_eq!((plan.renumbered, plan.deleted, plan.still_twice), (0, 1, 2));
        assert_eq!(plan.groups[0].members.iter().map(|m| m.action).collect::<Vec<_>>(), ["keep", "stays", "delete"]);
        fix_write(&root, &plan).unwrap();
        let after: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("map/war3map.doo.json")).unwrap()).unwrap();
        let mut expected = before.clone();
        expected["doodads"].as_array_mut().unwrap().remove(4);
        assert_eq!(after, expected, "only the copy went");
        assert!(tl::split_project(&root, &[]).unwrap_err().to_string().contains("doodads[2] and doodads[3] have the same creation number 581"));
        fix_write(&root, &fix_plan(&root, Some(FixMode::Renumber)).unwrap()).unwrap();
        tl::split_project(&root, &[]).unwrap();
        let _ = std::fs::remove_dir_all(&root);

        // A split project whose two LT04 share a number (put in by hand, as a merge of two branches would).
        let (root, _) = stacked_twins("split");
        fix_write(&root, &fix_plan(&root, Some(FixMode::DeleteCopies)).unwrap()).unwrap();
        let path = root.join("map/war3map.doo.json");
        let mut doo: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        doo["doodads"][3]["editorId"] = 582.into();
        std::fs::write(&path, serde_json::to_vec_pretty(&doo).unwrap()).unwrap();
        tl::split_project(&root, &[]).unwrap();
        let sub = root.join("map/terrain/main/doodads.json");
        let text = String::from_utf8(std::fs::read(&sub).unwrap()).unwrap().replace("\"editorId\": 582", "\"editorId\": 581");
        std::fs::write(&sub, text).unwrap();
        let r = check(&root).unwrap();
        assert_eq!(r.duplicates.len(), 1);
        assert_eq!(r.duplicates[0].members.len(), 2);
        assert!(r.duplicates[0].members.iter().all(|m| m.file == "map/terrain/main/doodads.json"), "{:?}", r.duplicates);
        let plan = fix_plan(&root, Some(FixMode::Renumber)).unwrap();
        assert_eq!(plan.groups[0].members[1].to, Some(10000), "the lowest free number of main's range [10000, 19999]");
        fix_write(&root, &plan).unwrap();
        assert!(!check(&root).unwrap().has_errors());
        tl::merge_project(&root).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The allocator: the subterrain's range first, then above every range, recording its block; a flat map above the
    /// highest number; never 0 or 4294967295.
    #[test]
    fn renumbering_takes_free_numbers() {
        let mut subs = vec![sub("a", &[[10, 11]]), sub("b", &[[20000, 29999]])];
        let used: std::collections::HashSet<u32> = [10, 11, 30000].into();
        assert_eq!(next_in_subterrain(&mut subs, 1, &used).unwrap(), 20000);
        assert_eq!(next_in_subterrain(&mut subs, 0, &used).unwrap(), 30001, "a is full: above every range");
        assert_eq!(subs[0].id_ranges, [[10, 11], [30000, 39999]]);
        assert_eq!(next_above(Kind::Doodads, &[5, u32::MAX, 0].into()).unwrap(), 6);
        assert_eq!(next_above(Kind::Units, &std::collections::HashSet::new()).unwrap(), 1);
        assert!(next_above(Kind::Units, &[u32::MAX - 1].into()).is_err());
    }
}
