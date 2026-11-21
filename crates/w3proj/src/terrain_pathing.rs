//! Hand-painted pathing in a project whose terrain is split (`map/terrain/`, `crate::terrain_layout`).
//!
//! The Pathing tool keeps its overrides in `.w3proj/pathing.json` (app/src/lib/terrain/resize.ts `PathingOverrides`:
//! the pathing map's size in cells, then one `[x, y, set, clear]` per cell, the bits a cell gets and loses, applied as
//! `(cell | set) & !clear`). In a split project they live in the subterrains instead, `<folder>/pathing.txt`, so they
//! merge per zone; the app still reads and writes `.w3proj/pathing.json`, which the file layer assembles from these
//! files and slices back into them (crates/backend flatview.rs).
//!
//! ```text
//! 1c 4 07 02          cell (0x1c, 4) of the subterrain: mask 07 (the bits it decides), value 02 (what they become)
//! 0..13 a 0a 0a       cells 0 to 0x13 of row 0xa, the same override
//! ```
//!
//! One line per override, `x y mask value`, all hexadecimal (x and y without leading zeros, mask and value two digits);
//! `mask` = `set | clear`, `value` = `set` (the editor never sets and clears one bit, and such a cell is refused).
//! Coordinates are cells relative to the subterrain's corner origin (cell `(4 · sx, 4 · sy)` of the pathing map), so
//! moving a rectangle's far edge doesn't change them. Cells in a row with the same override are one line, `x..x2`.
//! Lines are written sorted by y, then x. A cell belongs to the subterrain holding its tile (4 × 4 cells per tile), the
//! tile to the one holding its south-west corner; a cell in no subterrain can't be kept (refused, never dropped).

use std::collections::{BTreeMap, HashSet};

use serde_json::Value;

use crate::terrain_layout::{Layout, Subterrain, DIR};
use crate::{Error, Result};

/// A subterrain's overrides, in its folder.
pub const FILE: &str = "pathing.txt";
/// The Pathing tool's file the subterrains' files stand for, relative to the project.
pub const JSON_FILE: [&str; 2] = [".w3proj", "pathing.json"];
/// `JSON_FILE` as one name, for messages.
pub const JSON_NAME: &str = ".w3proj/pathing.json";
const FORMAT: &str = "w3proj.pathing/1";

/// One override, `x` and `y` in cells (relative to a subterrain's origin in its file, absolute in the pathing map).
/// Ordered by row, then column.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Cell {
    pub y: u32,
    pub x: u32,
    pub mask: u8,
    pub value: u8,
}

/// The pathing map's size in cells for a canvas of `corners`: 4 per tile.
pub fn map_size(corners: [usize; 2]) -> [usize; 2] {
    [corners[0].saturating_sub(1).saturating_mul(4), corners[1].saturating_sub(1).saturating_mul(4)]
}

/// The cells a subterrain holds: `[x, y, w, h]` in the pathing map (its tiles: the ones whose south-west corner it owns).
pub fn cell_rect(s: &Subterrain, corners: [usize; 2]) -> [usize; 4] {
    let tiles = [corners[0].saturating_sub(1), corners[1].saturating_sub(1)];
    let (x1, y1) = (s.x.saturating_add(s.w).min(tiles[0]), s.y.saturating_add(s.h).min(tiles[1]));
    let (x0, y0) = (s.x.min(x1), s.y.min(y1));
    [x0 * 4, y0 * 4, (x1 - x0) * 4, (y1 - y0) * 4]
}

/// A subterrain's overrides file, relative to `map/`.
pub fn path(s: &Subterrain) -> String {
    format!("{DIR}/{}/{FILE}", s.folder)
}

fn hex_number(t: &str) -> Option<u32> {
    let ok = !t.is_empty() && t.len() <= 8 && t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) && (t == "0" || !t.starts_with('0'));
    ok.then(|| u32::from_str_radix(t, 16).ok()).flatten()
}

fn hex_byte(t: &str) -> Option<u8> {
    (t.len() == 2 && t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).then(|| u8::from_str_radix(t, 16).ok()).flatten()
}

/// The overrides of one `pathing.txt` (`what`: its name for messages) of a subterrain holding `w` × `h` cells, relative
/// to its origin. Anything that isn't an override line as written here is an error naming the line, never skipped: a
/// line that doesn't parse, a cell outside the subterrain or twice, a value with bits outside its mask.
pub fn parse_txt(what: &str, bytes: &[u8], w: usize, h: usize) -> Result<Vec<Cell>> {
    let text = std::str::from_utf8(bytes).map_err(|_| Error::Format(format!("{what}: not UTF-8 text")))?;
    let body = text.strip_suffix('\n').unwrap_or(text);
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    if body.is_empty() {
        return Ok(out);
    }
    for (i, line) in body.split('\n').enumerate() {
        let bad = |why: &str| Error::Format(format!("{what} line {}: {why} (\"{}\")", i + 1, line.chars().take(60).collect::<String>()));
        let parts: Vec<&str> = line.split(' ').collect();
        let [xs, ys, ms, vs] = parts[..] else { return Err(bad("isn't \"x y mask value\" (hexadecimal, one space apart)")) };
        let (x0, x1) = match xs.split_once("..") {
            Some((a, b)) => {
                let (a, b) = (hex_number(a).ok_or_else(|| bad("its x isn't a hexadecimal number"))?, hex_number(b).ok_or_else(|| bad("its x2 isn't a hexadecimal number"))?);
                if b <= a {
                    return Err(bad("a run x..x2 must end after it starts"));
                }
                (a, b)
            }
            None => {
                let x = hex_number(xs).ok_or_else(|| bad("its x isn't a hexadecimal number"))?;
                (x, x)
            }
        };
        let y = hex_number(ys).ok_or_else(|| bad("its y isn't a hexadecimal number"))?;
        let mask = hex_byte(ms).ok_or_else(|| bad("its mask isn't two hexadecimal digits"))?;
        let value = hex_byte(vs).ok_or_else(|| bad("its value isn't two hexadecimal digits"))?;
        if value & !mask != 0 {
            return Err(bad("its value sets bits outside its mask"));
        }
        if x1 as usize >= w || y as usize >= h {
            return Err(bad(&format!("the cell lies outside the subterrain's {w}×{h} pathing cells")));
        }
        for x in x0..=x1 {
            if !seen.insert((x, y)) {
                return Err(bad(&format!("cell {x:x} {y:x} has an override already")));
            }
            out.push(Cell { y, x, mask, value });
        }
    }
    out.sort();
    Ok(out)
}

/// A subterrain's `pathing.txt` for its overrides (relative to its origin): sorted by row, then column, runs on a row
/// joined.
pub fn txt(cells: &[Cell]) -> Vec<u8> {
    let mut cells = cells.to_vec();
    cells.sort();
    let mut s = String::new();
    let mut i = 0;
    while i < cells.len() {
        let c = cells[i];
        let mut j = i;
        while j + 1 < cells.len() && cells[j + 1].y == c.y && cells[j + 1].x == cells[j].x + 1 && cells[j + 1].mask == c.mask && cells[j + 1].value == c.value {
            j += 1;
        }
        if j > i {
            s += &format!("{:x}..{:x} {:x} {:02x} {:02x}\n", c.x, cells[j].x, c.y, c.mask, c.value);
        } else {
            s += &format!("{:x} {:x} {:02x} {:02x}\n", c.x, c.y, c.mask, c.value);
        }
        i = j + 1;
    }
    s.into_bytes()
}

/// `.w3proj/pathing.json`'s overrides for the pathing map of a canvas of `corners`, absolute, sorted. What a split
/// project can't keep is an error saying why: another format, fields of its own (the subterrains' files hold the
/// overrides only), another map size, a cell outside the map or twice, a bit both set and cleared, numbers that aren't
/// bytes.
fn parse_json(bytes: &[u8], corners: [usize; 2]) -> Result<Vec<Cell>> {
    let bad = |why: String| Error::Format(format!("{JSON_NAME} can't go into the subterrains' {FILE}: {why}"));
    let doc = crate::terrain_objects::strict_json(bytes).map_err(|e| bad(format!("it isn't JSON ({e})")))?;
    let o = doc.as_object().ok_or_else(|| bad("it isn't a JSON object".into()))?;
    if let Some(k) = o.keys().find(|k| !["format", "width", "height", "cells"].contains(&k.as_str())) {
        return Err(bad(format!("it holds \"{k}\", and a split project keeps the overrides only (merge the subterrains to keep it)")));
    }
    if let Some(f) = o.get("format") {
        if f.as_str() != Some(FORMAT) {
            return Err(bad(format!("its format isn't \"{FORMAT}\"")));
        }
    }
    let [w, h] = map_size(corners);
    let size = |k: &str| o.get(k).and_then(Value::as_u64).ok_or_else(|| bad(format!("its {k} isn't a whole number")));
    let (fw, fh) = (size("width")?, size("height")?);
    if (fw, fh) != (w as u64, h as u64) {
        return Err(bad(format!("it is for a {fw}×{fh} pathing map, the terrain's is {w}×{h}")));
    }
    let list = o.get("cells").and_then(Value::as_array).ok_or_else(|| bad("its cells aren't a list".into()))?;
    let mut out = Vec::with_capacity(list.len().min(1 << 20));
    let mut seen = HashSet::new();
    for (i, c) in list.iter().enumerate() {
        let n: Option<Vec<u64>> = c.as_array().filter(|a| a.len() == 4).and_then(|a| a.iter().map(Value::as_u64).collect());
        let Some([x, y, set, clear]) = n.as_deref().and_then(|n| <[u64; 4]>::try_from(n).ok()) else {
            return Err(bad(format!("cells[{i}] isn't [x, y, set, clear] of whole numbers from 0")));
        };
        if x >= w as u64 || y >= h as u64 {
            return Err(bad(format!("cells[{i}] ({x}, {y}) lies outside the {w}×{h} pathing map")));
        }
        if set > 255 || clear > 255 {
            return Err(bad(format!("cells[{i}]: set and clear are pathing bits (0 to 255)")));
        }
        if set & clear != 0 {
            return Err(bad(format!("cells[{i}] both sets and clears bits {:02x}", set & clear)));
        }
        if !seen.insert((x, y)) {
            return Err(bad(format!("cell ({x}, {y}) is there twice")));
        }
        out.push(Cell { y: y as u32, x: x as u32, mask: (set | clear) as u8, value: set as u8 });
    }
    out.sort();
    Ok(out)
}

/// `.w3proj/pathing.json` as the Pathing tool writes it (resize.ts `pathingOverridesText`), for absolute cells.
fn json_text(corners: [usize; 2], cells: &[Cell]) -> Vec<u8> {
    let [w, h] = map_size(corners);
    let mut cells = cells.to_vec();
    cells.sort();
    let rows: Vec<String> = cells.iter().map(|c| format!("\n    [{},{},{},{}]", c.x, c.y, c.value, c.mask & !c.value)).collect();
    let tail = if rows.is_empty() { "" } else { "\n  " };
    format!("{{\n  \"format\": \"{FORMAT}\",\n  \"width\": {w},\n  \"height\": {h},\n  \"cells\": [{}{tail}]\n}}\n", rows.join(",")).into_bytes()
}

/// For each cell of the pathing map, the index of the subterrain holding it (None: in none).
fn owners(layout: &Layout) -> (usize, Vec<Option<u32>>) {
    let corners = layout.corners();
    let [w, h] = map_size(corners);
    let mut owner = vec![None; w * h];
    for (i, s) in layout.subterrains.iter().enumerate() {
        let [x, y, cw, ch] = cell_rect(s, corners);
        for row in y..y + ch {
            owner[row * w + x..row * w + x + cw].iter_mut().for_each(|o| *o = Some(i as u32));
        }
    }
    (w, owner)
}

/// `.w3proj/pathing.json` cut into the subterrains' `pathing.txt` (paths relative to `map/`): one file per subterrain
/// holding overrides, the others have none. Refused when the file can't be kept (`parse_json`), when a cell lies in no
/// subterrain, or when the files don't give back the same overrides.
pub fn slice(json: &[u8], layout: &Layout) -> Result<BTreeMap<String, Vec<u8>>> {
    let corners = layout.corners();
    let cells = parse_json(json, corners)?;
    let (w, owner) = owners(layout);
    let mut per: Vec<Vec<Cell>> = vec![Vec::new(); layout.subterrains.len()];
    for c in &cells {
        let Some(i) = owner[c.y as usize * w + c.x as usize] else {
            return Err(Error::Format(format!(
                "{JSON_NAME}: the override of cell ({}, {}) lies in no subterrain, so it would be lost (make the subterrains cover its tile)",
                c.x, c.y
            )));
        };
        let [x0, y0, _, _] = cell_rect(&layout.subterrains[i as usize], corners);
        per[i as usize].push(Cell { x: c.x - x0 as u32, y: c.y - y0 as u32, ..*c });
    }
    let files: BTreeMap<String, Vec<u8>> = layout.subterrains.iter().zip(per).filter(|(_, c)| !c.is_empty()).map(|(s, c)| (path(s), txt(&c))).collect();
    // Never store what doesn't come back.
    let back = assemble_cells(layout, &|p| files.get(p).cloned())?;
    if back != cells {
        return Err(Error::Format(format!("{JSON_NAME}: the subterrains' {FILE} don't give back the same overrides (nothing was written)")));
    }
    Ok(files)
}

fn assemble_cells(layout: &Layout, get: &dyn Fn(&str) -> Option<Vec<u8>>) -> Result<Vec<Cell>> {
    let corners = layout.corners();
    let mut all = Vec::new();
    for s in &layout.subterrains {
        let p = path(s);
        let Some(bytes) = get(&p) else { continue };
        let [x0, y0, w, h] = cell_rect(s, corners);
        for c in parse_txt(&format!("map/{p}"), &bytes, w, h)? {
            all.push(Cell { x: c.x + x0 as u32, y: c.y + y0 as u32, ..c });
        }
    }
    all.sort();
    Ok(all)
}

/// `.w3proj/pathing.json` assembled from the subterrains' `pathing.txt` (`get`: path relative to `map/` → bytes, None
/// when absent), as the Pathing tool writes it; None when no subterrain has one. A file that is there and can't be read
/// is an error naming its line (`parse_txt`).
pub fn assemble(layout: &Layout, get: &dyn Fn(&str) -> Option<Vec<u8>>) -> Result<Option<Vec<u8>>> {
    if !layout.subterrains.iter().any(|s| get(&path(s)).is_some()) {
        return Ok(None);
    }
    Ok(Some(json_text(layout.corners(), &assemble_cells(layout, get)?)))
}

/// A `.w3proj/pathing.json` for a canvas of `corners` with overrides over the seams of a 2×2 grid
/// (`terrain_layout::grid_2x2`) and in the corners of the map, as the Pathing tool writes it: what `w3proj verify` splits
/// and merges with every map. None for a map without pathing cells.
pub fn sample_json(corners: [usize; 2]) -> Option<Vec<u8>> {
    let [w, h] = map_size(corners);
    if w == 0 || h == 0 {
        return None;
    }
    let (sx, sy) = ((corners[0] / 2 * 4).min(w - 1), (corners[1] / 2 * 4).min(h - 1));
    let mut cells = std::collections::BTreeSet::new();
    // A row over the west/east seam, a column over the south/north seam, the four corners of the map.
    for x in sx.saturating_sub(3)..(sx + 3).min(w) {
        cells.insert(Cell { y: (sy / 2) as u32, x: x as u32, mask: 0x0a, value: 0x02 });
    }
    for y in sy.saturating_sub(2)..(sy + 2).min(h) {
        cells.insert(Cell { y: y as u32, x: (sx / 2) as u32, mask: 0x08, value: 0x00 });
    }
    for (x, y) in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)] {
        cells.insert(Cell { y: y as u32, x: x as u32, mask: 0x02, value: 0x02 });
    }
    // One override per cell (a corner can fall on a run).
    let mut seen = HashSet::new();
    let cells: Vec<Cell> = cells.into_iter().filter(|c| seen.insert((c.x, c.y))).collect();
    Some(json_text(corners, &cells))
}

/// The Pathing tool's file of a project (`JSON_FILE`).
pub fn json_path(project: &std::path::Path) -> std::path::PathBuf {
    JSON_FILE.iter().fold(project.to_path_buf(), |p, c| p.join(c))
}

/// The project's `.w3proj/pathing.json` bytes; None when there is none. One that is there but can't be read is an error.
pub fn read_json(project: &std::path::Path) -> Result<Option<Vec<u8>>> {
    match std::fs::read(json_path(project)) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::Project(format!("{JSON_NAME} can't be read: {e}"))),
    }
}

/// A name for the backup of `.w3proj/pathing.json` that isn't taken, as the Pathing tool picks one
/// (app/src/builtin/terrain-pathing/file.ts backupPath): `.bak`, else `.bak2`, `.bak3`…
pub fn backup_path(project: &std::path::Path) -> Result<std::path::PathBuf> {
    let p = json_path(project);
    for i in 1..100 {
        let name = format!("pathing.json.bak{}", if i == 1 { String::new() } else { i.to_string() });
        let b = p.with_file_name(name);
        if !b.try_exists().map_err(|e| Error::Project(format!("{} can't be checked: {e}", b.display())))? {
            return Ok(b);
        }
    }
    Err(Error::Project(format!("{JSON_NAME}: there are 99 backups of it already; move some away first")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(subs: &str) -> Layout {
        let json = format!(
            "{{\"format\":\"w3proj.terrain/1\",\"tileset\":\"L\",\"customTilesets\":1,\"ground\":[\"Ldrt\"],\"cliffs\":[],\"corners\":[9,5],\"offset\":[0,0],\"w3eVersion\":12,\"trailer\":\"\",\
             \"defaultCorner\":{{\"height\":0,\"water\":0,\"waterBits\":0,\"texture\":0,\"textureBits\":0,\"variation\":0,\"cliffVariation\":0,\"cliffTexture\":15,\"layer\":2,\"flags\":8}},\"subterrains\":[{subs}]}}"
        );
        Layout::parse(json.as_bytes()).unwrap()
    }

    /// 9×5 corners (32×16 cells): west 0..4 and east 4..9 corners wide.
    fn two() -> Layout {
        layout(
            "{\"name\":\"w\",\"folder\":\"w\",\"x\":0,\"y\":0,\"w\":4,\"h\":5,\"idRange\":[1,9]},\
             {\"name\":\"e\",\"folder\":\"e\",\"x\":4,\"y\":0,\"w\":5,\"h\":5,\"idRange\":[10,19]}",
        )
    }

    fn json(cells: &[[u32; 4]]) -> Vec<u8> {
        let rows: Vec<String> = cells.iter().map(|c| format!("\n    [{},{},{},{}]", c[0], c[1], c[2], c[3])).collect();
        let tail = if rows.is_empty() { "" } else { "\n  " };
        format!("{{\n  \"format\": \"w3proj.pathing/1\",\n  \"width\": 32,\n  \"height\": 16,\n  \"cells\": [{}{tail}]\n}}\n", rows.join(",")).into_bytes()
    }

    #[test]
    fn cells_go_to_the_subterrain_of_their_tile_and_come_back() {
        let l = two();
        assert_eq!(cell_rect(&l.subterrains[0], l.corners()), [0, 0, 16, 16]);
        assert_eq!(cell_rect(&l.subterrains[1], l.corners()), [16, 0, 16, 16], "the east edge's corners hold no tile");
        // A run over the seam (cells 14..17 of row 3), one cell further on, a lone cell in the east.
        let cells = [[14, 3, 2, 8], [15, 3, 2, 8], [16, 3, 2, 8], [17, 3, 2, 8], [19, 3, 2, 8], [31, 15, 0, 10], [0, 0, 1, 0]];
        let mut sorted = cells;
        sorted.sort_by_key(|c| (c[1], c[0]));
        let text = json(&sorted);
        let files = slice(&text, &l).unwrap();
        assert_eq!(String::from_utf8(files["terrain/w/pathing.txt"].clone()).unwrap(), "0 0 01 01\ne..f 3 0a 02\n");
        assert_eq!(String::from_utf8(files["terrain/e/pathing.txt"].clone()).unwrap(), "0..1 3 0a 02\n3 3 0a 02\nf f 0a 00\n");
        assert_eq!(assemble(&l, &|p| files.get(p).cloned()).unwrap().unwrap(), text, "byte for byte");
        // Only the files there count; none at all: no pathing.json.
        assert_eq!(assemble(&l, &|_| None).unwrap(), None);
        // An empty list: no files (the overrides file comes back absent).
        assert!(slice(&json(&[]), &l).unwrap().is_empty());
    }

    #[test]
    fn what_a_split_project_cant_keep_is_refused() {
        let l = two();
        for (bad, why) in [
            (&b"{ not json"[..], "isn't JSON"),
            (b"{\"format\":\"w3proj.pathing/1\",\"width\":32,\"height\":16,\"cells\":[],\"note\":1}", "\"note\""),
            (b"{\"format\":\"w3proj.pathing/2\",\"width\":32,\"height\":16,\"cells\":[]}", "format"),
            (b"{\"width\":36,\"height\":16,\"cells\":[]}", "36×16"),
            (b"{\"width\":32,\"height\":16,\"cells\":[[32,0,1,0]]}", "outside"),
            (b"{\"width\":32,\"height\":16,\"cells\":[[1,1,3,1]]}", "both sets and clears"),
            (b"{\"width\":32,\"height\":16,\"cells\":[[1,1,256,0]]}", "0 to 255"),
            (b"{\"width\":32,\"height\":16,\"cells\":[[1,1,1,0],[1,1,2,0]]}", "twice"),
            (b"{\"width\":32,\"height\":16,\"cells\":[[1,1,1]]}", "isn't [x, y, set, clear]"),
            (b"{\"width\":32,\"width\":32,\"height\":16,\"cells\":[]}", "twice"),
        ] {
            let e = slice(bad, &l).err().unwrap_or_else(|| panic!("accepted {}", String::from_utf8_lossy(bad))).to_string();
            assert!(e.contains(why), "{e} (expected {why})");
        }
        // A cell whose tile no subterrain holds: refused, not dropped.
        let west = layout("{\"name\":\"w\",\"folder\":\"w\",\"x\":0,\"y\":0,\"w\":4,\"h\":5,\"idRange\":[1,9]}");
        assert!(slice(&json(&[[20, 1, 1, 0]]), &west).unwrap_err().to_string().contains("lies in no subterrain"));
        assert!(slice(&json(&[[2, 1, 1, 0]]), &west).is_ok(), "control");
    }

    #[test]
    fn pathing_txt_is_read_strictly() {
        let ok = |t: &str| parse_txt("p", t.as_bytes(), 16, 16);
        assert_eq!(ok("").unwrap(), vec![]);
        assert_eq!(ok("a..c f 0a 02").unwrap().len(), 3, "the last newline may be left out");
        assert_eq!(ok("3 1 0a 02\n1 1 0a 02\n").unwrap()[0].x, 1, "any order is read, sorted");
        for (bad, why) in [
            ("1 1 0a 02\n\n", "isn't \"x y mask value\""),
            ("1  1 0a 02\n", "isn't \"x y mask value\""),
            ("1 1 0a 02 x\n", "isn't \"x y mask value\""),
            ("01 1 0a 02\n", "x isn't"),
            ("A 1 0a 02\n", "x isn't"),
            ("1 g 0a 02\n", "y isn't"),
            ("1 1 a 02\n", "mask"),
            ("1 1 0a 0g\n", "value"),
            ("1 1 0a 05\n", "outside its mask"),
            ("10 1 0a 02\n", "outside the subterrain"),
            ("1 10 0a 02\n", "outside the subterrain"),
            ("3..3 1 0a 02\n", "end after"),
            ("1..3 1 0a 02\n2 1 0a 02\n", "already"),
            ("1 1 0a 02\r\n", "value"),
            ("1 1 0a 02\n<<<<<<< HEAD\n", "isn't"),
        ] {
            let e = ok(bad).err().unwrap_or_else(|| panic!("accepted {bad:?}")).to_string();
            assert!(e.contains(why), "{e} (expected {why})");
        }
        assert!(parse_txt("p", b"\xff", 16, 16).is_err());
    }
}
