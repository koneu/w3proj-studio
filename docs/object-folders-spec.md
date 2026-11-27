# Spec: One File per Object (`map/objects/`)

Companion to [terrain-subterrains-spec.md](terrain-subterrains-spec.md) and [trigger-folders-spec.md](trigger-folders-spec.md). It uses the same mechanism: a layout-aware read/write layer in Rust (`folder_codec.rs`), the packed files built at pack time, and a check command for what a merge can break. Where this spec says "as in the trigger spec" it means that mechanism, not a second copy of it.

Status: stage 0 done (2026-11-26); stage 1 (the Rust layer) built on branch `object-folders-rust`, without its World Editor check (deviations at the end). Milestone entry M27.

## Goal & Motivation

Today each kind of object is one JSON file, and Reforged maps have a second one beside it:
- **`map/war3map.w3u.json`** and `.w3t`, `.w3b`, `.w3d`, `.w3a`, `.w3h`, `.w3q` (`crates/w3proj/src/objdata.rs`, format `w3proj.objects/1`): two lists, `original` (changed standard objects) and `custom` (new objects).
- **`map/war3mapSkin.w3u.json`** and so on: the same two lists again, holding the fields Reforged keeps in the Skin file (names, tooltips, models, icons).
- A campaign has the same files as `war3campaign.*` in its own `map/`.

Problems:
1. **Append conflicts.** Two people who each add an object edit the same spot of the same list, so Git conflicts every time.
2. **One object in two files.** A unit's hit points are in `war3map.w3u.json`, its name in `war3mapSkin.w3u.json`. A review of "what changed on this unit" reads two files.
3. **Size.** WoWR's 14 object files are 10.3 MB of JSON for 7,420 objects. Every edit is a diff in a file nobody opens by hand.
4. **No file to point at.** A Problems entry, a search hit or a Git blame cannot name one object.

The folder format stores one file per object, with both halves in it.

**A repack stays byte-identical.** An unchanged project packs into the same bytes as the map it came from. This is the first thing the smoke tests check, and it decides several points below (stored order, empty entries, end tokens kept as they are).

**This is the only layout, for every map**, as for triggers: no flat-layout compatibility, no dual reader, no convert command. An old project is converted by a `.w3x` round trip (pack with the old build, unpack with the new one). An `objects.json` with a higher major `format` than the build knows is refused with a message, never half-read.

**An object file that cannot be decoded** keeps today's behaviour: the binary stays in the project as an opaque raw file (`map/war3map.w3u`), and that kind has no folder. Stage 0 found none in 514 tables.

---

## 1. Directory Layout

```text
map/
  objects/
    objects.json            # format, and which packed files exist with which version
    units/                  # war3map.w3u + war3mapSkin.w3u
      custom/
        order.txt           # only when the map's order is not the default one (section 3)
        h000.json
        H000~8.json         # "~8": the first letter is upper case (section 2)
      original/
        hfoo.json
    items/                  # .w3t
    destructables/          # .w3b
    doodads/                # .w3d
    abilities/              # .w3a
    buffs/                  # .w3h
    upgrades/               # .w3q
```

`war3map.w3?` and `war3mapSkin.w3?` are **not** in the project in this layout; pack builds them. A campaign's own `map/objects/` packs into `war3campaign.*` (no folder in the 124 map folders of stage 0 has both prefixes). Chapter maps keep theirs under `maps/<chapter>/map/objects/`.

A folder exists only while it holds something. `custom/` and `original/` mirror the two lists of the packed file: `custom` is what the user called "new", `original` is "edited".

### `map/objects/objects.json`
```json
{
  "format": "w3proj.objectfolders/1",
  "files": {
    "units": { "data": 3, "skin": 3 },
    "items": { "skin": 3 },
    "abilities": { "data": 2 }
  }
}
```
- `data` and `skin` give the version of `war3map.<ext>` and `war3mapSkin.<ext>`. A key that is missing means pack writes no such file.
- A file with no objects at all is still written when it is listed (10 such files in the corpus). So "the file exists" lives here, not in whether a folder has files.
- It changes only when a kind gets its first object or a file's version changes, so it is not a merge hot spot.
- What Studio lists for a map made from scratch, and where it puts a field of a map without Skin files, stays as `skin.ts` and the Object Editor decide today.

---

## 2. Object Files

```json
{
  "id": "h09L",
  "base": "halt",
  "data": {
    "mods": [
      {"field": "upap", "type": "string", "value": "unwalkable", "end": "halt"},
      {"field": "umpm", "type": "int", "value": 500},
      {"field": "umvr", "type": "unreal", "value": 0.1}
    ]
  },
  "skin": {
    "mods": [
      {"field": "unam", "type": "string", "value": "TRIGSTR_5456"},
      {"field": "umdl", "type": "string", "value": "war3mapImported\\AltarOfEldersDalaranV3.02.mdl"}
    ]
  }
}
```

- `base` and `id` are the entry's own (`id` only in `custom/`, as today).
- **`data` and `skin` are the object's entry in `war3map.<ext>` and in `war3mapSkin.<ext>`**, each with exactly the keys the flat entry has today (`end`, `mods`, `sets`; `level` and `data` columns per change in `.w3d`, `.w3a`, `.w3q`). Nothing is merged or moved between them: the two halves can have different `end` tokens (5,564 objects in the corpus do).
- **A missing half means the object is not in that file. An empty half (`"skin": {}`) means it is there without changes.** Both are common and must survive: 12,920 Skin entries and 7,594 base entries in the corpus have no changes, and 10 tables have objects only the Skin file lists.
- **One change per line**, so two people changing different fields of one object merge cleanly. The reader takes any valid JSON; the writer always writes this form.
- Unknown keys are ignored, as the object codec does today. Values, ids and floats use the forms of `objects.schema.json`.
- The same field in both halves is allowed and kept (the World Editor reads such a map, the Skin value wins, see `skin.ts`). The corpus has none.

### File names
The file name is a pure function of the id. It never depends on other files, so a name is decided once and two branches that create the same id get the same path (an add/add conflict, which is the right report).

- An id of four letters or digits is its own name: `hfoo.json`.
- **Upper case is marked**, because `h000` (a unit) and `H000` (a hero) are different objects, and Windows and macOS would hold them as one file. The name gets `~` and one hex digit saying which letters are upper case (8 first, 4 second, 2 third, 1 fourth): `H000~8.json`, `AFfs~c.json`, `Affs~8.json`. This is not a rare case: 70 tables in the corpus have such pairs, 874 pairs in all, the game's own `Nman` / `nman` among them. With the mark, no two names in any table collide when case is ignored.
- Any other id is `0x` and its eight hex digits, the form the JSON already uses for an id that is not printable. The corpus has none.
- **The object's name is not part of the file name.** Names repeat, a name is often a reference (`TRIGSTR_5456`) or carries colour codes, and a rename in the Object Editor would rename the file. The Object Editor, the search and the Problems view show the name next to the id.

The id inside the file is the truth. A file whose name does not fit its id is reported (section 5).

---

## 3. Order

The order of the objects in a packed file has no known effect in the game or the World Editor. It is stored only so that a repack is byte-identical: 577 of 849 custom tables and 486 of 849 original tables in the corpus are not sorted by id, and nothing else derives their order.

- **`order.txt`** in `custom/` or `original/`, one file name without `.json` per line (`h000`, `H000~8`).
- **One list serves both halves.** Pack writes each file's objects in list order, leaving out those without that half. Stage 0: wherever both files list an object, they agree on the order (335 of 335 custom pairs and 325 of 335 original pairs are the same list; the other 10 have a base file without the entries).
- **Objects that are not listed come after the listed ones, sorted by id.** So:
  - **Studio does not list a new object.** Two people adding objects touch no shared file at all.
  - A map made in Studio has no `order.txt`.
  - A file dropped in from outside needs no edit.
- **Unpack writes `order.txt` only when the map's order differs from what the folder would give without it**, and rewrites it only when the order really changed. A map Studio packed therefore unpacks into the same files it was packed from.
- Deleting an object in Studio removes its line. A listed name without a file is ignored and reported (section 5).

Open: what order a World Editor save writes. If it reorders, the first sync after such a save rewrites `order.txt` (and nothing else). Checked in stage 1's done-criterion.

---

## 4. The Packed Files as Build Artifacts

`war3map.w3?`, `war3mapSkin.w3?` and `war3campaign*.w3?` are **pack outputs, not stored**, built from `map/objects/` by the pure-Rust codec (`objdata.rs` stays as the binary codec). They need no game data, so there is no staleness and no record: the project has no copy to go stale, as for `war3map.wtg` in the trigger spec.

- The derived files that read object data (pathing, the minimap, the map script) take `map/objects/**` as a source: `derived.rs` (`EXT` list and the script sources), `SCRIPT_INPUTS` and `CAMPAIGN_INPUTS` in `app/src/lib/script/guard.ts`.
- `.w3o` export and import (`w3o.rs`) are unchanged; they are fed from the assembled tables.
- Object texts stay literal in the files, as today (`docs/testing/object-text-strings.md`); this spec does not move them.

---

## 5. Merge Checks ("Check Objects")

Separate files stop textual conflicts, not semantic ones. The command runs on pack and in the Problems view; it reports and never edits silently (a repair is a listed fix the user applies):
- conflict markers, a file that cannot be read;
- a file whose name does not fit its id, or whose folder does not fit it (`id` in `original/`, none in `custom/`);
- one id in `custom/` and `original/` of the same kind (the corpus has none, so this is always a merge or a copied file);
- `order.txt`: a name listed twice, or without a file;
- a half for a file `objects.json` does not list (the changes would not be packed).

Two branches that each create `h000` meet as an add/add conflict on `h000.json`; Git reports that itself. Giving one of them a free id and rewriting its references is a repair for later, not part of the first build.

Pack refuses the errors above, as it does for the trigger tree. The checks the Problems view already runs on object data (a base that does not exist, limits) stay as they are and now point at the object's file.

---

## 6. Performance

- **Measured (stage 0, WoWR, 7,420 files, warm Linux, NVMe, a Python prototype):** write 0.86 s, read and parse 0.20 s. The files hold 6.4 MB (10.3 MB as the 14 flat files, which indent every change over several lines). On disk they take 30 MB, because each small file fills a 4 KB block. Git stores them compressed either way.
- **Read:** thousands of small files. The tables are read **in Rust, in parallel, and handed to the app as the tables it reads today** (one `original` / `custom` pair per packed file). The app never makes one call per object, and the readers listed in section 8 keep their in-memory shape.
- **Write:** better than today. The layer keeps a content hash per file and writes only the objects that changed, instead of two multi-MB JSON files. Dirty state is per object.
- **Watching:** a save or a `git checkout` touches many files. `map/objects/**` is watched with a debounce and handled as one batch.
- **Windows is not measured.** On NTFS with Defender, 7,400 files can cost seconds. This is the main risk; stage 2 measures it before the stage counts as done.
- **Prerequisite:** an outside change to many objects (a pull) while the Object Editor has unsaved edits: an object with unsaved edits keeps them and shows a conflict flag, the others reload. This lands with stage 2.

---

## 7. Implementation Order

0. **Stage 0 (done 2026-11-26, throwaway scripts, nothing in the repository).** All 36 archives of `smoketest_maps` unpacked: 124 map folders, 514 object tables, 81,000 entries, 49,183 objects. Split into the layout above and joined again, **all 514 tables come back equal** to the flat JSON they were made from, with one order list per folder and the two halves kept as they are. Not covered: the 273 maps inside the game's own storage (stage 1 runs `w3proj verify` over them), and the comparison is of the flat JSON, not of packed bytes (the flat JSON to bytes step is today's verified codec). Findings:
   - versions: base files are version 1 (5), 2 (164) or 3 (345); every Skin file is version 3; 179 tables have no Skin file; a Skin file never comes without a base file;
   - no id twice in a table, no id in both `original` and `custom`, no id outside `A-Za-z0-9`, no object using `sets`, no field in both halves, no custom object whose `base` differs between the halves.
1. **Rust layer** (`object_layout.rs` on `folder_codec.rs`): `objects.json`, object files, `order.txt`, file names, raw fallback; unpack, pack and `verify` switched over; the flat files, their tests and `objects.schema.json`'s flat form replaced; schemas for the new files in `docs/schemas`. **Done when** `w3proj verify` passes every map of the corpus byte for byte, and a WoWR packed from the folders has been opened and saved in the real World Editor and the result diffed (also answers section 3's open question). *Built (branch `object-folders-rust`): verify passes all 36 archives of `smoketest_maps` (797 packed object files now read by `object-folders`, none fell back); WoWR (7,420 object files) and The Invasion of Kalimdor Reworked (campaign and chapters) unpack and pack byte for byte. The World Editor check is open (test.md).*
2. **App**: one backend call that returns and takes the assembled tables; every reader of section 8 through it; per-object writes; the watcher batch; Object Editor reload with unsaved edits. **Done when** changing one unit in the Object Editor changes exactly that unit's file, and opening WoWR is timed on Windows and Linux.
3. **Check Objects** in the Problems view and the CLI (`w3proj objects <project> --check`), pack refusing its errors, and the Source Control view naming the object a changed file belongs to.

## 8. Migration Scope

The flat names are replaced, not supported next to the new ones. All access goes through the layout-aware layer.

- **Rust:** `objdata.rs` (keeps the binary codec, loses the project JSON form), `project.rs`, `names.rs`, `derived.rs`, `folder_codec.rs`, the format list in `crates/w3proj/src/format`, the backend's `objects_canonicalize`, the CLI and corpus baseline (`tests/corpus-baseline.tsv` lists 797 files as `objdata-json`).
- **App:** `builtin/object-editor` (service, `skin.ts`, `w3o.ts`, `standard.ts`), `builtin/problems`, `builtin/map-script`, `builtin/map-info` (tech tree, Move Texts), `builtin/terrain-viewer` (placement, type facts, minimap), `builtin/script-resources`, `builtin/source-control`, `builtin/mcp-server`, `workbench`, `lib/script/guard.ts`.
- **Docs:** `docs/schemas/README.md` and a schema per new file.

## 9. Decisions

- One file per object, keyed by id; the name is not in the file name.
- Upper case is marked in the file name (`~` and a hex digit), always, not only on a collision.
- Both halves (`data`, `skin`) in one file, each kept exactly as its entry is; nothing moves between them.
- A repack is byte-identical: order is stored for imported maps (`order.txt`), empty entries and end tokens are kept.
- New objects are not listed in `order.txt`; unlisted objects are packed after the listed ones, by id.
- Folder layout is the only layout; old projects convert by a `.w3x` round trip. Undecodable files stay raw.
- The packed object files are pack outputs, not stored.
- Whether the World Editor accepts a map packed from this layout, and what order its save writes, are tests (stage 1), not design questions.

## Stage 1 as built (branch `object-folders-rust`): deviations

- **The game's `Objects\` folder.** The game keeps files under `Objects\` (`Objects\InventoryItems\…`), and maps import files there: WoWR has such imports, and on Windows `map/Objects/` and `map/objects/` are one folder. So only `objects/objects.json` and everything below `objects/<kind>/` (the seven folder names) are the layout's, with the first folder matched in any case (`object_layout::layout_path`); any other file under `Objects\` is an import as before. Unpack refuses the layout (the kinds stay raw) only for a map file of its own at one of the layout's paths. A file both as `objects/…` and `Objects/…` (a file system that tells cases apart) is an error at pack.
- **File names:** an id of four lower-case letters and digits that Windows keeps for a device (`com1`…`com9`, `lpt1`…`lpt9`, and `com0`, `lpt0`) is named `0x…`, as a non-alphanumeric one; with an upper-case letter it has the `~` mark and is no device name.
- **What the layout can't hold stays raw**, as an undecodable kind: an id twice in a table, a standard object with an id of its own or a custom one without, the halves giving an object other bases or orders that don't agree, an id both standard and custom. The kind's two packed files stay as raw files with the reason in the unpack report (the corpus has none).
- **`order.txt` when unpacking:** the shortest head of the map's order after which the rest is sorted by id (the rest then needs no line). A sync into a project keeps the `order.txt` on disk when it gives the map's order too (its names without a file dropped), so a map Studio packed comes back with the same files.
- **The flat form stays as the app's view.** The app reads and writes `map/war3map.w3u.json` and the others (format `w3proj.objects/1`, `objects.schema.json`) through the backend's file layer (`crates/backend/src/objectview.rs`), which answers them from `map/objects/` (stage 2 replaces this with one call for all tables). A write of a flat file sets that half of each object, keeps the other, removes an object left with neither (and its `order.txt` line), doesn't list a new object, lists the packed file in `objects.json`; it refuses an id twice or a base other than the other half's, writing nothing. A read gives back what the app last wrote while the kind's files are as that write left them (a new object comes back where the app put it, not by id), so a read after a save is the save (an MCP undo compares them). A project that still has flat object files on disk (and no `objects.json`) isn't answered from the folder: its next sync converts it. `w3proj objects <project>` prints the flat tables as the app reads them (the script check and app-smoke read through it). `pack` still packs such a project's flat files through the codec (the mini map fixture is one).
- **Pack refuses** conflict markers (in object files, `order.txt`, `objects.json`), a file that can't be read, a name or folder that doesn't fit the id, a half for a packed file `objects.json` doesn't list, object files without `objects.json`, any other file below `objects/<kind>/`. It only warns about an `order.txt` name listed twice or without a file, and an object file with neither half. The Problems view's checks (stage 3) aren't built.
- **Timing (Linux, NVMe, release build, WoWR):** unpack 8.8 s (6.0 s with the flat files), a re-sync that changes nothing 4.0 s; through the backend, reading the flat `war3map.w3u.json` (2,233 custom and 731 standard units) 115 ms, writing it 220 ms (unchanged: nothing written), listing the project's 14,227 files 90 ms. Windows isn't measured.
