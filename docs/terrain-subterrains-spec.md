# Spec: Split Terrain & Subterrains (`map/terrain/`)

> **One layout (decided 2026-11-26):** `map/terrain/` is the only terrain layout Studio writes, even with one subterrain. The older flat layout (`map/war3map.w3e.txt` and the map-wide object and region files in `map/`) is still read, and converted the first time Studio touches it.
>
> - **Unpack and New Map** write `map/terrain/` with one subterrain `main` over the whole map and put the derived files into `.w3proj/derived/`. A map that came without shadows or a minimap packs back without them (`derived-from.json` lists them under `absent`, forgotten once the derived files are made anew).
> - **A flat project is converted** by an unpack into it and by opening it in the app (its campaign's chapter maps too), which says so once, or says why it stayed flat.
> - **What stays flat:** a terrain kept raw, and a map without terrain (a campaign).
> - **`w3proj terrain merge` is a command for tools only** (decided 2026-11-27): about 70 test and comparison scripts unpack a map and edit its terrain and placed objects as single files, and merge the unpack first. `w3proj pack` reads such a project. Studio never writes one, the app has no command for it, and the next unpack into it splits it again. `w3proj cat <project> <file>` prints a file as the app reads it, whatever the layout.
> - **What this means for every project:** the derived files are not in git, so a fresh clone can't be packed without the game (`w3proj rebuild`); and every file under `map/terrain/` counts as a source of the derived files, so a pack right after a hand edit of a region or unit is refused until `w3proj rebuild` (or `--force-stale`).

## Goal & Motivation

In the flat layout (`map/war3map.w3e.txt`, `map/war3map.doo.json`, `map/war3mapUnits.doo.json`, `map/war3map.w3r.json`), the entire map's terrain and placed objects lived in single map-wide files:
- In `war3map.w3e.txt`, Git merges edits to different rows (north/south) cleanly, but edits in the same rows across different columns (east/west) conflict because each line spans the entire width of the map.
- Placed units, doodads, and regions share global arrays and sequential `creationNumber` (`editorId`) counters, so two people editing different areas of a large map on separate branches run into array-tail conflicts and duplicate `creationNumber` allocations.
- Binary derived files (`war3map.wpm`, `war3map.shd`, `war3mapMap.blp`, `war3map.mmp`) change as a whole on every terrain save and conflict on every Git merge.

The **Subterrain format** is the multi-file layout in `map/terrain/`:
- **Small / single-author maps:** one subterrain `main` over the whole map, which behaves like a normal map and is ready to be cut.
- **Large / multi-author maps:** partition the map canvas into named **subterrains** (`1..n` folders, e.g. `elwynn_forest/`, `westfall/`, `dungeon_north/`) so multiple mappers can work on separate zones in parallel and merge via Git without conflicts, and each of them loads, sees and rebuilds only the zone they work on (section 6).

---

## 1. Directory Layout

```text
map/
  terrain/
    terrain.json          # 1..1 Global canvas, master tile/cliff palettes, default corner fill, and subterrain list
    main/                 # Example: "Split Terrain" makes one subterrain covering the whole canvas, named main
      terrain.txt         # Ground & water corner grids for this subterrain's rectangle (w3e.txt format)
      doodads.json        # Placed doodads & destructibles inside this subterrain
      units.json          # Placed units & items inside this subterrain
      regions.json        # Regions inside this subterrain
      pathing.txt         # Optional: hand-painted pathing brush overrides in this subterrain
    <subterrain_name>/    # 1..n named subterrain folders
      terrain.txt
      doodads.json
      units.json
      regions.json
      pathing.txt
```

---

## 2. Global Canvas & Subterrain Layout (`terrain/terrain.json`)

The root `terrain/terrain.json` owns all map-wide invariants that must not drift across subterrains:

```json
{
  "format": "w3proj.terrain/1",
  "tileset": "L",
  "customTilesets": 1,
  "ground": ["Ldrt", "Ldro", "Ldrg", "Lrok", "Lgrs", "Lgrd"],
  "cliffs": ["CLdi", "CLgr"],
  "corners": [257, 257],
  "offset": [-16384, -16384],
  "w3eVersion": 12,
  "trailer": "",
  "defaultCorner": {
    "height": 0,
    "water": 0,
    "waterBits": 0,
    "texture": 0,
    "textureBits": 0,
    "variation": 0,
    "cliffVariation": 0,
    "cliffTexture": 15,
    "layer": 2,
    "flags": 8
  },
  "dooHeader": {
    "doodadsVersion": 8,
    "doodadsSubversion": 11,
    "unitsVersion": 8,
    "unitsSubversion": 11,
    "skinIds": true
  },
  "subterrains": [
    {
      "name": "elwynn_forest",
      "folder": "elwynn_forest",
      "x": 32,
      "y": 32,
      "w": 64,
      "h": 64,
      "idRange": [10000, 19999]
    },
    {
      "name": "westfall",
      "folder": "westfall",
      "x": 96,
      "y": 32,
      "w": 64,
      "h": 64,
      "idRange": [20000, 29999]
    }
  ]
}
```

`defaultCorner` holds every per-corner field of the w3e text format (same names, `flags` as the w3e bit set: 1 ramp, 2 blight, 4 water, 8 boundary), so an uncovered corner round-trips byte-for-byte. `trailer` is the w3e `[trailer]` hex. A non-integer `offset` is written as the string `"bits:XXXXXXXX"`, as w3e.txt does. `dooHeader` is optional on read (kept when present, written by the object split).

**One rule for uncovered corners:** every corner outside all subterrains is filled from `defaultCorner`, nothing else (no `waterBits` derived from camera bounds). Consequences, as implemented in stage 1a:
- Loading then saving never changes the map: a corner is omitted from disk only when it equals `defaultCorner`.
- A split that leaves corners uncovered is **refused** when any of them differs from `defaultCorner` (on real maps the area outside the playable bounds has `waterBits` set, so it isn't one value). Studio then says which corners and asks for a rectangle covering them. A split that covers the whole canvas always works.
- A save that would have to drop such a corner is refused too, never silently dropped.
- Splitting without rectangles makes one subterrain `main` over the whole canvas; `defaultCorner` is then the most common corner.
- At least one subterrain is required; unknown keys in `terrain.json` and unknown files under `map/terrain/` are errors (until a stage adds them).

### Canvas & Space Efficiency Rules

1. **Implicit Default Canvas (No Wasted Disk Space):**
   - Warcraft III requires a contiguous `width × height` corner grid (`(W_tiles + 1) × (H_tiles + 1)`).
   - Instead of storing untouched areas on disk, `terrain.json` defines `corners: [W, H]` and `defaultCorner`.
   - Any canvas corner `(x, y)` not covered by a subterrain is filled in memory from `defaultCorner`. You can create a 256×256 map and only save the 64×64 subterrain folders you have actually built.
2. **Strict Corner Ownership (No Shared-Seam Duplication):**
   - A subterrain at `(x, y)` with size `(w, h)` owns corners `x <= cx < x + w` and `y <= cy < y + h`.
   - Named subterrains in `subterrains[]` must not overlap. There is no catch-all subterrain: a subterrain is always an explicit rectangle, and conversion from the flat layout makes one rectangle over the whole canvas.
   - Because neighboring tiles share boundary corners and multi-corner rules (`rampLift`, `cornerNormal`, cliff meshes, water surfaces) look ±1 to ±2 corners across borders, the editor always assembles the full in-memory `Terrain` grid on load and slices it back into subterrain rectangles on save.
3. **Locked Global Tile & Cliff Palettes:**
   - Warcraft III limits `war3map.w3e` to a single global ground tile list (up to 16 in v11, 64 in v12) and cliff list (4-bit `cliffTexture`, up to 16 active cliff types), and `customTilesets = 0` has special slot-remapping rules.
   - Keeping `ground` and `cliffs` in `terrain/terrain.json` ensures two branches cannot silently assign conflicting slot indices or overflow the 16-cliff / 64-tile limit without an immediate, visible Git diff in `terrain.json`.

---

## 3. Subterrain Ground Format (`<subterrain>/terrain.txt`)

Rather than using the clipboard's `Fragment` JSON (`lib/terrain/fragment.ts`—which uses center-relative coordinates, ground-relative object heights, and verbose JSON objects per corner), each subterrain's `terrain.txt` uses the **same compact, lossless ASCII grid format as `war3map.w3e.txt`** (`crates/w3proj/src/w3e.rs`):

```text
corners 64 64

[height]
0*64
...

[water] all 0

[water-bits] all 0

[texture]
0001122...

[variation]
...

[cliff-variation] all 0

[cliff-texture] all f

[layer] all 2

[flags] all 0
```

- **Why not `Fragment` JSON on disk?**
  - `Fragment` is designed for clipboard copy/paste, rotation, and mirroring across different maps.
  - Using `w3e.txt`'s ASCII grids keeps files small (a couple of kilobytes per subterrain with `value*count` run-length encoding and `[section] all <val>`), preserves `water-bits` and `texture-bits` byte-accurately, and lets the Rust `w3proj` crate pack and unpack subterrains directly without needing a 3D height solver.

---

## 4. Placed Objects & Regions (`doodads.json`, `units.json`, `regions.json`)

Each subterrain folder holds the objects whose `(x, y)` world position falls inside that subterrain's rectangle (objects outside every rectangle go to the nearest one).

1. **Stored Coordinates (`[x, y, z]`):**
   - Store the exact world `[x, y, z]` coordinates (as in `war3map.doo` and `war3mapUnits.doo`), **not** `z - groundAt(x, y)` or bounding-box-center offsets.
   - **Why:**
     - Resizing a subterrain's rectangle won't shift the coordinates of every untouched object inside it.
     - No floating-point rounding drift on `z` across save/pack round-trips.
     - Rust's `w3proj pack` can merge `doodads.json` and `units.json` from all subterrains into `war3map.doo` and `war3mapUnits.doo` without calculating bilinear ground heights or ramp lifts.
2. **Per-Subterrain ID Ranges (`idRange`) for Conflict-Free Merging:**
   - Every placed unit, doodad, and region has a `creationNumber` (`editorId`), which scripts and triggers reference as `gg_unit_<id>_<num>`, `gg_dest_<id>_<num>`, or `gg_rct_<name>`, and which Waygates use to target regions.
   - Each subterrain in `terrain.json` is assigned a disjoint `idRange: [minId, maxId]` automatically, never by hand: the i-th subterrain of a first split gets `[(i+1)·10000, (i+1)·10000+9999]` (`[10000, 19999]`, `[20000, 29999]`, …); once Studio adds a range, `idRange` becomes a list `[[min, max], …]` (one range keeps the old form, old files stay valid).
   - When a mapper places a new unit, doodad, or region inside `elwynn_forest`, Studio allocates the next free ID within `elwynn_forest`'s `idRange`.
   - Two mappers working in different subterrains on separate Git branches will **never allocate colliding `creationNumber`s**.
   - **Ranges only steer allocation, they are never validated against existing objects.** An imported map's IDs lie anywhere; an object moved over a seam keeps its ID, which then lies outside the new subterrain's range. Allocation takes the next free ID in the range that is also unused map-wide (all subterrains loaded).
   - When a subterrain's ranges are full, Studio allocates in the next block of 10000 above the highest range (from one past it to the end of that block) and records that range in `terrain.json` for the subterrain when the object is saved. Two ranges, within one subterrain or across subterrains, must not overlap; `terrain.json` is validated on load, and a merge that makes two branches pick overlapping ranges shows as a Git conflict in `terrain.json` or as a load error that `w3proj terrain check` lists (offering to re-assign ranges for new objects is not built; existing IDs never change).
   - A duplicate `creationNumber` found on load (e.g. after a merge) is an error listing both files; it is never silently renumbered, because scripts reference the IDs.
   - **Duplicates the imported map already has are kept** (as the trigger folders keep imported duplicate ids, docs/trigger-folders-spec.md section 4): a split of a flat file (an unpack, `w3proj terrain split`) lists the numbers it holds more than once per kind in `terrain.json`, `objects.<kind>.importedTwice` (sorted, absent when empty; e.g. `"doodads": { "magic": "W3do", "specialVersion": 0, "importedTwice": [581] }`). Merging lets exactly the listed numbers through, so such a map packs back as it came; a number found twice that isn't listed (a Git merge's, in one file or across subterrains) is still the error above, and `w3proj pack` refuses it. `w3proj terrain check` (and Check Terrain IDs) tells listed ones as information (exit 0). A later write (a save, Map Size, a relayout, `terrain fix-ids`) keeps a listed number only while the content still holds it more than once and never lists a new one: a save that makes a new duplicate is refused. A partial load (section 6) keeps the list as it is. `terrain fix-ids` renumbers listed and unlisted ones alike.
   - For doodads and units, `creationNumber` 0 (older maps give every doodad editorId 0) and 4294967295 (unset) are not assignments (for regions, index 0 is a real number: the first region of a flat map gets 0, and it counts in the duplicate check and the list): they may occur any number of times and are exempt from the duplicate check; objects with equal numbers are ordered within a file by subterrain, then by their index in the flat file (`order` written wherever that isn't their flat place), and stage 2's allocator never hands out 0 or 4294967295. (Of the 119 maps in smoketest_maps, two hold other duplicates: wowr4.6, doodads 581 three times; FiresOverEversong, 35 numbers.)
3. **Ownership rules:**
   - A unit, doodad or item belongs to the subterrain whose rectangle holds its `(x, y)` (corner ownership, as in section 2). Outside the canvas, or in no rectangle: the nearest subterrain (by distance to its rectangle, ties to the first in `subterrains[]`).
   - A region (a rectangle) belongs to the subterrain holding its **minimum corner** (`left`, `bottom`), however far it reaches.
   - Cameras (`w3c`), sounds (`w3s`) and the special doodads of `war3map.doo` are out of scope for this split; they stay in their own files, and the special doodads follow the doodads' rule (position decides).
4. **Deterministic Packing Order & Moving Objects Across Seams:**
   - Within each subterrain file, objects are sorted by `creationNumber`.
   - When an object is dragged across a subterrain boundary, its `creationNumber` stays unchanged; it simply moves from `subterrain_A/units.json` to `subterrain_B/units.json`.
   - On `w3proj pack`, objects from all subterrains are concatenated and sorted deterministically by `creationNumber` (with special terrain doodads merged in the same way).
   - **Order and byte-identity:** a map's original `war3map.doo` order isn't always `creationNumber` order. Each file is sorted by `creationNumber`, and an object gets `"order"` (its index in the original flat file, written as the first key) **only where that index differs from its place in the sorted order**. Merging puts objects that have an `order` at that index and fills the remaining places in sorted order (plain "sort by `order` else by `creationNumber`" does not round-trip: flat [100, 200, 900, 300] would come back as [900, 300, 100, 200]). A map split and merged again without edits is byte-identical; the round-trip checker covers both layouts.
   - **Doodads of version 13 and up** all have `editorId` 4294967295 (as the current World Editor saves them); their creation number is the placement id (`trailer[0]`). The duplicate-ID rule and stage 2's allocator use that value.
   - **Special doodads** have no creation number: they are sorted by y, x, id, z and use `order` the same way.
   - **Global object-file fields:** `terrain.json` has `dooHeader` (versions, `skinIds`) and an optional `objects` key for what else is global in the flat files (e.g. `{"doodads":{"magic":"W3do","specialVersion":0},"units":{"magic":"W3do"},"regions":{"version":5}}`, plus a per-file `skinIds` only where it differs from `dooHeader`). A kind listed there lives in the subterrains and every subterrain must then have its file.
   - A key that appears twice in a subterrain file or in `terrain.json` is an error (serde would silently keep one).

---

## 5. Treating Derived Binary Files as Build Artifacts

Even with split subterrain files, committing `war3map.wpm` (pathing), `war3map.shd` (shadows), `war3mapMap.blp` (minimap image), and `war3map.mmp` (minimap icons) to Git as monolithic binary files under `map/` would cause binary Git merge conflicts whenever two branches save terrain.

### Design for Derived Files

1. **Treat `.wpm`, `.shd`, `war3mapMap.blp`, and `.mmp` as Build Artifacts:**
   - These four files are generated from terrain + doodads + units + map info.
   - In a `map/terrain/` project they are not tracked in Git (a new project's `.gitignore` lists `/.w3proj/derived/`; split adds `/.w3proj/derived-from.json`, merge leaves both lines): they live in `.w3proj/` (git-ignored) and Studio regenerates them on open/save/pack when `.w3proj/derived-from.json` reports stale sources. This is fixed for the layout, not a per-project setting.
2. **Persisting Hand-Painted Pathing (`pathing.txt`):**
   - Hand-painted pathing is today kept in `.w3proj/pathing.json` (see `app/src/builtin/terrain-pathing/file.ts`, `PathingOverrides`). Under `map/terrain/` it moves into the subterrains as `<subterrain>/pathing.txt` so it merges per zone; the split migrates it (the old file is kept as `.bak`), and a project split before is migrated on open, pack and rebuild. Flat-layout projects keep `.w3proj/pathing.json`.
   - An override is a **mask and a value** per 4×4-pathing-cell (which of the `.wpm` bits it sets, and to what), not one character per cell: one line per override, `x y mask value` (hex), sorted by `y` then `x`, cell coordinates relative to the subterrain's corner origin (so resizing the rectangle does not change them); contiguous runs on a row are written `x..x2 y mask value`.
   - A pathing cell belongs to the subterrain holding its tile's south-west corner (4 cells per tile, so a cell never straddles a seam); a cell in no subterrain is refused, never dropped.
   - `mask` = bits to set or clear, `value` = what they are set to. A cell that sets and clears the same bit, a `pathing.json` for another map size, or one with fields besides format/width/height/cells can't be kept in a split project and is refused. `x` and `y` are lowercase hex without leading zeros, `mask` and `value` two digits; lines may come in any order; a cell twice is an error; an empty overrides list leaves no `pathing.txt` and reads back as no file.
   - When Studio generates `war3map.wpm`, it computes the base pathing from terrain + doodads/buildings and stamps each subterrain's overrides on top.
3. **Headless / CLI Packing: refuse rather than ship wrong pathing:**
   - `crates/w3proj` (pure Rust) cannot read CASC, so it cannot compute doodad pathing, shadows or the minimap.
   - `w3proj pack` of a `map/terrain/` project uses the derived files in `.w3proj/` only when `derived-from.json` says they follow the sources (`derived.rs` `SOURCES` is extended to `map/terrain/**` so every subterrain file counts). If they are missing (`war3map.wpm`, `war3map.shd`, `war3mapMap.blp`, `war3map.mmp` or `war3map.mmp.json`) or not known to follow (stale, no record, unreadable record), `pack` **fails** with the reason and says to open/save in Studio or run it headless (`appctl` / `headless`) to rebuild them.
   - `--allow-terrain-only-derived` is the explicit way around the refusal: `pack` then uses the derived files as they are even when stale, or leaves them out when there are none (the pure-Rust crate cannot compute them: no terrain-only pathing is invented, since units would walk through trees and buildings), and the output says so. Whether the game and the World Editor accept a map without `war3map.wpm` / `.shd` / minimap is to be tried (open point); a release pack never uses the flag.
   - A fresh clone or CI without the game install therefore cannot make a release pack. That is intended; the derived cache can be shared between machines as a build artifact (CI cache), never committed.
   - A project still in the flat layout (not yet converted, or merged for a tool) has its derived files in `map/`, and `pack` takes them as they are.
   - **The map script is a derived file too, with its own group in the same record** ([trigger-folders-spec.md](trigger-folders-spec.md), section 5): placed units, destructables, items and regions go into `war3map.j` / `.lua`, so a terrain save makes the script stale, `SOURCES` for the script group includes `map/terrain/**`, a partial open leaves it stale for the closed part, and `pack` refuses it the same way (flag `--allow-stale-script`, separate from `--allow-terrain-only-derived`). Only for projects whose script is `"generated"`; a `"kept"` script is a normal tracked file and is not touched by terrain saves.
   - Tests that pack a split project without a prior unpack of a real map (which records fresh derived files) pass `--allow-terrain-only-derived`, or write fresh derived files and a fresh `derived-from.json` record first; the Windows CI has no game install and needs the same.

---

## 6. Working on Part of the Map (Partial Load)

Goal: someone working on `westfall` loads, renders and rebuilds only `westfall`, not the whole map.

1. **Open set (local, not in Git):** the user picks which subterrains to open (command "Open Subterrains…", a side view listing them with checkboxes). The choice is stored in `.w3proj/` (git-ignored), per user. The default for a map with more than one subterrain is the last open set, else all.
2. **What loads:**
   - *Open* subterrains: fully loaded, editable.
   - *Halo*: the corners and objects within 2 corners of an open subterrain's rectangle, from its neighbours. Objects are picked by position only (the file layer has no model sizes), so a doodad whose model reaches in from further away isn't in the halo. A neighbour that reaches into the halo is read in full: only subterrains beyond the halo are never opened. Loaded read-only so seams, cliffs, ramps, water edges, shadows and pathing near the border come out right. Edits are clamped to the open rectangles; a brush stroke or drag over the halo changes nothing there.
   - *Closed* subterrains: not read from disk, not rendered, not simulated. Drawn as an empty area with the name overlay; optionally a flat low-resolution overview (heights and ground colour only) from a cached `.w3proj/overview/<name>.png` if it exists.
3. **Where the speed comes from** (measured 2026-11-21 on a 256² map split 4×4 with 1 of 16 open: ground quads -92%, bytes read 401→207 MB, at rest 9.5→4.9 s, derive after an edit 51→22 s; Xvfb software GL, so no GPU frame times; see `app/scripts/measure-subterrains.mjs`): fewer tiles, doodads and units to draw and keep in GPU memory; fewer files read; and the derived rebuilds (pathing, shadows, today a few seconds after each tool edit) only cover the open rectangle plus halo instead of the whole map.
4. **Derived files and a partial open:** `war3map.wpm`, `.shd` and the minimap cannot be completed from a partial map. While a subterrain is closed, Studio updates the pathing only where the open part changed, shadows only where the open part changed, and keeps the minimap and its icons as they were (not composited), and marks the derived files stale for the rest in `derived-from.json`. A full-map rebuild happens when everything is opened, or on `pack`, which refuses until it is done (section 5).
5. **What stays whole-map:** `terrain.json` (palettes, canvas), `war3map.w3i` (camera bounds, players), the object data, triggers and strings. Palettes being global means a partial open can't assign a conflicting tile slot: it may only append to the palettes, never reorder or remove.
6. **IDs with closed subterrains:** new objects get IDs from the open subterrain's `idRange`, so no closed file needs reading to avoid collisions. The duplicate-ID check over everything runs on a full open, on `pack` and in a project check command.
7. **Saving:** only open subterrains are sliced and written, and only those whose content changed. Closed subterrain files are never touched.
8. **Triggers and scripts referring to objects in a closed subterrain** keep working (they only use names and IDs); the trigger editor's object pickers list closed-subterrain objects by name from a small per-subterrain index (`.w3proj/index/<name>.json`, rebuilt on save) without loading them.
9. **Implementation note:** the in-memory `Terrain` stays a full-size grid so existing code keeps working; closed regions are a mask (default-filled, skipped by rendering, brushes, derive and save). A smaller grid is a later optimisation.

---

## 7. Implementation Order

The format above is fixed up front; the work lands in stages, each usable on its own and checked by the round-trip checker:

1. Layout-aware reader/writer layer, `terrain.json`, `terrain.txt` per subterrain, objects and regions per subterrain, split/merge commands (lossless).
2. `idRange` allocation and duplicate-ID detection.
3. Derived files out of git: `derived.rs` over `map/terrain/**`, `pack` refusing stale files, `pathing.txt` replacing `.w3proj/pathing.json`.
4. Partial load (open set, halo, masks, scoped derive), then measure on a large map.
5. Seam check, subterrain overlay and resize/rename/merge in the viewer.

---

## 8. Editor UX & Extension Responsibilities

- **Subterrain Overlay in Terrain Viewer:**
  - Toggleable overlay drawing subterrain rectangles, names, and ownership boundaries on the terrain canvas.
  - Ability to create, resize, rename, or merge subterrains in the UI (snapped to tile boundaries). The command that joins subterrains is called "Join Subterrains…" ("merge" means converting back to the flat layout, `w3proj terrain merge`).
- **Seam check:**
  - Disjoint files stop textual Git conflicts, not semantic ones: cliffs, ramps and water edges look ±2 corners across a seam, so two branches editing near the same seam can merge cleanly into an inconsistent seam. A command "Check Terrain Seams" (run automatically after a merge touching two subterrains and on pack) reloads the assembled grid, re-derives cliff/ramp/water rules along seams and reports any corner the rules would change. It never edits silently. The cliff, ramp and water rules are actions, not invariants, so the check tests three invariants instead: a cliff of more than 2 levels between neighbouring corners (error), a ramp run that doesn't climb one level in one direction (error) and water that steps within one tile (warning, because World Editor maps contain it). A cliff type missing from the map's cliff list is not checked: the World Editor's own maps have it. It runs on `pack` (an error stops the pack; `--allow-seam-issues` packs anyway) and on demand; an opt-in post-merge hook (`w3proj terrain merge-hook`) runs it when the two merged sides together changed two subterrain folders or `terrain.json`.
- **Layouts and compatibility:**
  - One layout written, two read: Studio writes `map/terrain/` only. The reader also accepts the flat layout (`map/war3map.w3e.txt`), which an unpack and the app's open convert (lossless, checked by the round-trip checker). The app has no command that goes back; `w3proj terrain merge` does, for tools.
  - A project whose terrain couldn't be converted (kept raw) opens flat, and the Terrain Layout editor's Split Terrain is there for it.
- **Migration scope:** the flat names appear in about 34 TS files and in `project.rs`, `names.rs`, `derived.rs`, the backend and the CLI tests. All file access goes through one layout-aware layer (read: assemble; write: slice and write only subterrains whose content hash changed); file watching covers `map/terrain/**`.
