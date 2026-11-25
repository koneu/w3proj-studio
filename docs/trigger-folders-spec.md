# Spec: Folder-Based Trigger Format (`map/triggers/`)

Companion to [terrain-subterrains-spec.md](terrain-subterrains-spec.md). Both specs share one mechanism: a layout-aware read/write layer, derived files kept out of git in `.w3proj/`, and `pack` refusing stale ones. Where this spec says "as in the terrain spec" it means that mechanism, not a second copy of it.

## Goal & Motivation

Today the trigger tree is stored in two monolithic files:
- **`map/war3map.wtg.json`** (`crates/w3proj/src/wtg.rs`, `app/src/lib/triggers/wtg.ts`): the whole tree (categories, GUI triggers, comments, script items, variable nodes) and the global `variables` list.
- **`map/war3map.wct.txt`** (`crates/w3proj/src/wct.rs`): the custom script header and one `//== trigger K ==` section per trigger, matched to `war3map.wtg` **by position only**.

Problems:
1. **Positional coupling.** `.wct` has no trigger ids. Inserting a trigger near the top shifts every index after it, so Git merges conflict or attach a script to the wrong trigger.
2. **Whole-tree conflicts.** Any edit to any trigger, variable or fold state changes `war3map.wtg.json`.
3. **No external tooling.** Scripts are concatenated into one text, so editors, linters and formatters cannot treat a trigger or library as its own `.j` / `.lua` file, and diagnostics cannot point at a real file and line.
4. **The map script is committed.** `war3map.j` / `war3map.lua` is generated from the map's data (`app/src/lib/script/`) but tracked as a source, so two people editing different triggers conflict in generated code.

The folder format mirrors the Trigger Editor's tree as real directories with one file per trigger, and moves the generated map script out of git.

**This is the only layout, for every map.** The project is still young, so there is no flat-layout compatibility, no dual reader and no split/merge command. Unpacking a `.w3x` writes `map/triggers/`; packing reads it. An old project (or a map from elsewhere) is converted by a `.w3x` round trip: pack it with the old build, unpack it with the new one. A `triggers.json` with a higher major `format` than the build knows is refused with a message, never half-read.

(This differs from the terrain spec, where the flat layout stays the default. The two are independent; if terrain follows the same decision, its "Layouts and compatibility" section shrinks the same way.)

**Maps that cannot be decoded** (a `war3map.wtg` with functions TriggerData does not know) keep today's behaviour for any undecodable file: the binary `map/war3map.wtg` and `map/war3map.wct` stay in the project **as opaque raw files**, there is no `map/triggers/`, and the script is `"kept"` (section 5). Unpack says so. Nothing is half-split. (Stage 0: the game's TriggerData decoded every `war3map.wtg` of the 119 local maps that have one, so this is a rare case, not the normal one.)

**Classic maps (WC3 Reign of Chaos / Frozen Throne format v4 / v7 without the Reforged marker, 42 of the 119 maps) use the same layout with less in it:** no root item (`triggers.json` has no `root`), no trigger or variable ids, no `expanded` flags, no nesting, and no comment (16), script (32) or variable-node (64) items. Pack **refuses** what a Classic map cannot hold (a nested folder, an item of those types, a trigger at the root level) with the reason; a `.j` without frontmatter in a Classic map becomes a type 8 custom-text trigger (there are no script items); the editor does not offer them in a Classic map.

**Zero bytes in a text** (stage 0 result). The Frostwolf Clan map has two texts ending in `\0\0` (padding). Today's `wct.rs` rejects them, which is why that project keeps a raw `war3map.wct`. The folder reader must take each text by its **stored length and allow zero bytes inside**. Every text file goes through `lossless::encode` / `decode` on the way in and out, as `war3map.wct.txt` does today. `lossless` itself does not turn byte 0 into U+10FF00; the trigger layout does that when it writes a file and reverses it on read, and a real U+10FF00 in a text is written as escapes, so the two cannot be mistaken for each other (implemented in stage 2a). There is **no `nul` flag**. Cost: bytes that are not UTF-8 (old code pages) show as private-use characters in the file; no local map has any.

---

## 1. Directory Layout

```text
map/
  triggers/
    triggers.json                   # format, versions, root item, optional kept-as-imported state
    header.j                        # Map Custom Script Header (header.lua for a Lua map)
    order.txt                       # order of the root's children
    variables.json                  # variables at the root (and all of a Classic map's)
    Initialization/                 # category (type 4) or library folder (type 2)
      _category.json                # id?, name, type, isComment, expanded
      order.txt                     # order of this folder's children
      variables.json                # variables placed in this folder (Reforged)
      Melee_Initialization.gui.json # GUI trigger (type 8, isCustom false)
      Setup_Players.j               # custom-text trigger (type 8, isCustom true) or script item (type 32)
      Section_A.comment.json        # trigger comment (type 16)
    Combat/
      ...
```

`war3map.wtg` and `war3map.wct` are **not** in the project in this layout; see section 5.

---

## 2. Root, Category and Order Files

### Why order is stored, and how
Tree order is semantically significant: script items and custom-text triggers are emitted into the map script in tree order, and JASS has no forward declarations, so alphabetical order could break a library that calls another. `InitCustomTriggers` and `RunInitializationTriggers` also run in tree order. *(Stage 0 confirmed it on WoWR, Frostwolf, Firebrand, Orc04Interlude, FOE and Invictus: trigger sections, `InitCustomTriggers` and `RunInitializationTriggers` follow the preorder of the enabled type 8 triggers; script items come in tree order in their own block before the triggers. JassHelper may reorder vJASS libraries by `requires`.)*

Order lives in a plain-text **`order.txt` per folder, one entry per line**, not in a JSON array. JSON arrays make two adjacent insertions a comma conflict; separate lines merge cleanly unless both people insert at the very same spot, which is a real ordering conflict.

```text
$BossHP
Melee_Initialization.gui.json
Setup_Players.j
Bosses
```
- An entry is a file name, a sub-folder name, or `$<variable name>` for a variable node (so a variable's position among triggers survives; Reforged only).
- Files and folders on disk that are not listed are appended in alphabetical order (a `.j` dropped in from VS Code needs no edit). Listed entries that do not exist are ignored with a warning in the Problems view. `order.txt` is rewritten on save only when the order really changed.

### `map/triggers/triggers.json`
```json
{
  "format": "w3proj.triggers/1",
  "reforged": true,
  "version": 7,
  "wctVersion": 1,
  "wctComment": "",
  "unknown": 2,
  "root": { "id": 33554432, "name": "MyMap.w3x", "isComment": 0, "expanded": 1 },
  "script": "generated"
}
```
(`root` is absent in a Classic map, see Goal.)
- `script`: `"generated"` (section 5) or `"kept"`.
- Fields that only an **imported** map has (a map made in Studio from scratch has none):
  - `"counts"`: the per-type id counters with their `deleted` lists **verbatim, in their stored order** (section 4). Stage 0: 46 of 77 Reforged maps have a count that is not max id + 1, and 36 have unsorted `deleted` lists, so they cannot be derived.
  - `"variableOrder"`: the global variable table order, when it differs from the tree order the variables files give (54 of 119 maps; never sortable by id or name). **Dropped by the first save that adds, removes or renames a variable**, since from then on the tree order is the order (the table order only decides the order of the globals in `war3map.wtg` and the script's `InitGlobals`). An unchanged project still packs byte-identical.

### `<Category>/_category.json`
```json
{ "type": 4, "name": "Initialization / Setup", "isComment": 0, "expanded": 1 }
```
`id` appears only for items imported from an existing map (section 4), **stored verbatim: real World Editor maps contain categories with the same id** (16 campaign maps), and pack writes them back unchanged. To avoid Git noise from browsing, a save where only `expanded` flags changed does not write (as `onlyFoldsUnsaved` in `tree.ts`).

### File and folder names (slugs)
Display names may contain characters illegal on Windows or Linux, repeat, or differ only by case. The true name is the `"name"` field; the file name is a slug:
- illegal characters, spaces, trailing dots and a leading `.` become `_`; a leading `$` becomes `_` (so a folder is never read as a variable entry in `order.txt`);
- a name with no letter or digit left (the `-----` separator comments, 2,187 of the suffixes in the corpus) uses a fixed stem by kind: `comment`, `folder`, `trigger`, `script`; Windows reserved names (`CON`, `NUL`, `COM1`…) get a `_` suffix; each component is cut to 80 characters;
- a collision (also case-insensitive, so the tree checks out on Windows and macOS; files collide by **stem across extensions**, a custom-text trigger and a script item with the same name both want the stem `Damage_Engine`; folders collide by full name) gets a numeric suffix `~2`, `~3`…, numbered in tree order at import (one map has a run of 144);
- **an existing item keeps its file name until it is renamed**, so a suffix is decided once at creation and never flips when siblings are reordered or deleted. A rename writes the new file name and removes the old one (Git sees a rename).

---

## 3. Trigger and Script Files

### A. GUI triggers (`<Name>.gui.json`)
One compact JSON per trigger, with the same one-line-per-ECA layout as today's `writeWtgJson`:

```json
{
  "type": 8,
  "name": "Melee Initialization",
  "description": "Default melee starting units and resources.",
  "isComment": 0,
  "enabled": true,
  "initiallyOff": false,
  "runOnInit": false,
  "ecas": [
    {"kind": 0, "name": "MapInitializationEvent", "enabled": true, "params": [], "children": []},
    {"kind": 2, "name": "MeleeStartingVisibility", "enabled": true, "params": [], "children": []}
  ]
}
```
A GUI trigger that carries dormant custom text in `.wct` (a trigger converted and reverted in an old tool) keeps it in an optional `"wctText"` string. A GUI trigger with no text slot has neither field.

### B. Custom-text triggers and script items (`.j`, `.vjass`, `.lua`)
Both converted custom-text triggers (`type 8, isCustom true`) and Reforged script items (`type 32`) have code in `.wct` and metadata in `.wtg`. To keep every file a **valid standalone JASS / vJASS / Lua file with no sidecar**, metadata is **one frontmatter comment line** at the top:

```jass
// @w3proj {"type": 8, "name": "Setup Players", "description": "Spawns initial units.\nSets alliances.", "enabled": true, "initiallyOff": false, "runOnInit": true}
function Trig_Setup_Players_Actions takes nothing returns nothing
```
Lua uses `-- @w3proj {…}`. The description is inside the JSON (multi-line safe); there is no second `@w3proj-description` line. `id` is present only for imported items.

**Packing rule, exact so round trips stay byte-identical:**
- Unpack writes: optional BOM (if the text began with one), the frontmatter line with the text's own line ending (LF if it has none), then the text exactly as stored.
- Pack removes exactly that one line, and puts the BOM back in front of the remaining text. Nothing else is touched: CRLF, a missing final newline and trailing blank lines pass through.
- A malformed frontmatter line, or one with an unknown JSON key, is an error with file and line, never silently treated as code. (The frontmatter never reaches JassHelper or the generator: pack strips it first. It matters only to outside tools that read the files; stage 0 compiled WoWR with 323 frontmatter lines inserted and JassHelper kept them as comments.)
- **Git must not rewrite line endings.** Texts keep their own CRLF / LF breaks, one file CRLF and the next LF-only (FOE: 146 CRLF-only and 19 LF-only texts) and even mixed within one text (WoWR has 6 of those). A project's `.gitattributes` therefore has `map/triggers/** -text` (no `core.autocrlf` conversion, diffs stay text); a new project gets it, and the Problems view warns when it is missing in a project that has `map/triggers/`.

**Files made outside Studio** (no frontmatter): an enabled `type 8` custom-text trigger if the text defines `InitTrig_<name>`, otherwise an enabled `type 32` script item; the name is the file stem. The extension is chosen at creation from the map's script language (`.lua` for a Lua map, otherwise `.j`; see "Lua maps" in section 5); `.vjass` is accepted and kept. It does not change the data. (`.ai` is not a trigger file and is not part of this format.)

### B2. "No text" versus empty text
`.wct` tells a missing text slot ("no text") from an empty one (a lone zero byte), for the header and for each trigger. The files keep that difference: **a file that is absent means "no text"**, an existing empty file means an empty text. So no `header.j` / `header.lua` for a map whose header has no text (the W3Champions maps), and a GUI trigger without `"wctText"` has no text slot. A custom-text trigger or script item always has a file.

### C. Trigger comments (`<Name>.comment.json`)
One format only: `{ "type": 16, "name": "...", "description": "...", "isComment": 1 }`.

---

## 4. Variables and IDs

### Variables
In Warcraft III every `udg_*` variable is global to the map, even though Reforged shows variable nodes (`type 64`) inside folders. Storage follows the tree, the namespace stays global:
- A variable placed in a folder is saved in that folder's `variables.json`; root variables, and all of a Classic map's, in `map/triggers/variables.json`.
- One object per line, so two people adding variables to the same file merge cleanly.
- On load and pack the map-wide table is assembled from every `variables.json` in tree order (`variableOrder` overrides when the imported table order was different).
- **Merge check** ("Check Trigger Tree", below): two `variables.json` files defining the same name, with a different type, array flag/size or initial value, is an error; an identical duplicate is a warning and collapses to one.

### IDs (stage 0: ids and counters must be stored for imports)
Numeric `.wtg` item ids are internal to `.wtg` (stage 0: nothing else in the map, in `rename.ts` / `refs.ts` or in the MCP trigger tools uses them; `gg_trg_<Name>` uses the name), but byte-exact repack needs them: with everything stored 119 of 119 maps repack identically, without ids 24, without counts 53, without `variableOrder` 65.
- **Imported items keep their `id`**, in `_category.json`, in the file's JSON or frontmatter, and one `id` per `variables.json` line (a variable node's id and parent always equal its variable's; 0 mismatches in 119 maps). `triggers.json` keeps `counts` verbatim.
- **New items have no id** in the files. Loading assigns ids in memory (the app needs them for selection, undo and the tree: `tree.ts`, `variables.ts`, `allocItemId`), pack assigns them for the file, from free numbers in tree order.
- **Counter rule:** pack raises a stored counter only to cover ids **pack assigned itself**, never ids that came with the import. FOE's ids come from another tool and do not follow the editor's numbering; "cover any id in use" would rewrite its counters on the first repack.
- **The tree is built from item order, not from parent ids.** Item order in `.wtg` is always a preorder (0 violations in 77 maps), and real maps contain **duplicate category ids** (16 campaign maps, e.g. "Initialization" and "MapEvents" both `0x2000003`), which makes a parent id ambiguous. Imported duplicates are kept and written back unchanged; only a duplicate that appears after a Git merge (two new ids colliding) is reported by "Check Trigger Tree" and repaired on request, never silently by pack.
- **Known editor limit:** the Trigger Editor finds children by parent id (`trigger-editor/index.ts`, delete), so in a map with duplicate category ids deleting one category also collects the other's children. Filed as a bug; the editor must look children up by tree position before such maps are edited.

---

## 5. `war3map.wtg`, `war3map.wct` and the Map Script as Build Artifacts

Three different kinds of file, because they have different inputs:

1. **`war3map.wtg` and `war3map.wct`: pack outputs, not stored.** Built from `map/triggers/` by the pure-Rust codec (`wtg.rs`, `wct.rs`) at pack time. No game data, no staleness, no record: the project has no copy to go stale and `pack` always builds them. This removes the positional `.wct` coupling because each text is read from its own file.
2. **`war3map.j` / `war3map.lua`: derived by Studio's generator, as the terrain spec's derived files.** It is made from the triggers **and** placed objects, regions, cameras, sounds, object data, map info (the existing `SCRIPT_INPUTS` in `app/src/lib/script/guard.ts`). That needs the game's data, which the pure-Rust crate cannot read.
   - With `"script": "generated"`, the script is **not tracked in Git**. It lives in `.w3proj/derived/` (already git-ignored) with its hash in `.w3proj/generated-script`, and Studio regenerates it on open/save/pack when `.w3proj/derived-from.json` reports stale sources. The record gets a script group beside the terrain one; its sources are `SCRIPT_INPUTS` extended with `map/triggers/**` and `map/terrain/**` (`derived.rs` `SOURCES`).
   - `w3proj pack` uses it only when `derived-from.json` says it follows its sources. Missing or not known to follow (stale, no record, unreadable record): `pack` **fails** with the reason and says to open/save in Studio or run it headless (`appctl` / `headless`). **A map without a script is never packed** (a map with no `war3map.j` / `.lua` cannot run, and `project.rs` already checks this). `--allow-stale-script` is the explicit way to use a stale script as it is; a release pack never uses it. It stays a separate flag from the terrain spec's `--allow-terrain-only-derived`: that one may also leave files out, this one never may, and merging them would hide the difference.
   - A fresh clone or CI without the game install therefore cannot make a release pack, the same as for terrain; the derived cache can be shared as a CI cache, never committed. Tests that pack a project without a prior unpack of a real map write a fresh script and a fresh record first (or pass the flag); the Windows CI needs the same.
   - A partial terrain open (terrain spec, section 6) leaves the script stale for the closed part, exactly as it does the pathing and minimap; `pack` refuses until a full rebuild.
3. **A script that Studio did not make stays a source (`"script": "kept"`).** `guard.ts` already protects scripts that are not made from the map's triggers (the World Editor's, a hand-edited one, W3Champions' maps with 800 injected functions). For such a map the split keeps `map/war3map.j` / `.lua` as a **tracked file next to `triggers/`** and the generator never overwrites it. The command "Regenerate Map Script…" lists the functions that would be lost (`lostFunctions`) before it switches the project to `"generated"`. This is the answer to "can the script be a build artifact": yes, wherever the generator can reproduce it, and only there.

**vJASS maps (JassHelper).** A map whose texts are vJASS (libraries, scopes, structs, textmacros) gets its `war3map.j` from the generator **followed by JassHelper**, as the World Editor does on save: the saved script is JassHelper's processed output (expanded libraries, `//processed hook:` lines), not the generator's. Consequences:
- `"generated"` for such a map needs the game's JassHelper (a Windows program, run through Proton on Linux) in addition to the generator. Stage 0 measured about 9 s per run for WoWR's 7.9 MB script on a warm Linux machine (66 s for the first run of a session while Proton starts). That is still too slow to block a save, so the script is **regenerated on pack and on request ("Regenerate Map Script"); a background regeneration after a save is allowed but never blocks**; until it has run the script is stale, and the derived record says so.
- **JassHelper is not deterministic:** two runs on the same input differ in private name mangling (`Ascii__i` vs `Ascii___i`), `key` constants and the `jasshelper__initstructsN` suffix. A regenerated vJASS script never matches a stored one byte for byte, so staleness is judged from the **inputs** (the derived record), never by comparing outputs, and `lostFunctions` comparisons normalise `___` to `__` and ignore `jasshelper__initstructs*` (WoWR then reports 0 lost functions, Frostwolf's 68 are all JassHelper output).
- **JassHelper needs the map's own `common.j`.** WoWR imports its own `Scripts\common.j` (3,994 constants and 2 natives the game's lacks); the app passes only the game's, and the check fails. It compiles with the game's `common.j` plus the map's extra declarations. What the World Editor does here is unknown; a stage 2 prerequisite for `"generated"` on such maps (bug filed).
- A release pack of a vJASS map needs the game and JassHelper on the machine. Without them `pack` refuses, as above; there is no fallback that skips JassHelper.
- A map that comes from the World Editor has no Studio stamp, so it starts as `"kept"`. Switching it to `"generated"` is the user's decision after "Regenerate Map Script…" has shown what `lostFunctions` reports against the current script. If the generator plus JassHelper cannot reproduce the script, the map stays `"kept"` and still gets the folder layout for its triggers; only the git benefit for the script is missing.

**Lua maps.** The language is a property of the map, not of the trigger files: `war3map.w3i` `scriptType` (1 = Lua), as the app already reads it (`trigger-editor/index.ts` `scriptLanguage`, `map-script/index.ts`). Everything above applies the same way; what differs:
- **Files:** the header is `header.lua`, scripts are `.lua`, the frontmatter line is `-- @w3proj {…}`, the generated script is `war3map.lua`. GUI triggers (`.gui.json`) are language-neutral; only their compilation differs.
- **No JassHelper.** Lua maps skip vJASS, so generating `war3map.lua` is the generator alone (`lib/script/lua.ts` translates the generated JASS line by line, custom texts copied as they are). It is fast, so it can regenerate on save, and a release pack of a Lua map does not need JassHelper (it still needs the game's data for the generator, as in section 5).
- **Line endings:** the Lua writer uses CRLF, and the custom script header keeps its own LF breaks (`LF_BREAK` in `lua.ts`). The frontmatter rule (the text's own line ending) keeps both; stage 0 round-tripped every local map exactly.
- **Files made outside Studio:** the "defines `InitTrig_<name>`" test accepts both spellings, `function InitTrig_X takes nothing returns nothing` (JASS) and `function InitTrig_X()` (Lua). The default extension for a new file follows `scriptType`.
- **Wrong-language files:** a `.j` in a Lua map (or `.lua` in a JASS map) is a Problems error with file and line, never silently compiled. Changing `scriptType` in Map Info renames the header and warns that custom texts are **not translated**; every trigger text and the header are then listed as wrong-language until the user rewrites them.
- **Checks:** Lua files get the syntax check only (`lib/lua/check.ts`: blocks, brackets, strings; no unknown names), so Check Trigger Tree and per-file diagnostics report less for Lua than for JASS. Stated as a limit, not a promise.
- **Stage 0 Lua maps:** the ten W3Champions ladder maps in `smoketest_maps/*w3c*` are Lua (`scriptType` 1, no `war3map.j`). Their trigger trees are almost empty (`war3map.wtg` about 570 bytes, `.wct` 165 or 310 bytes, one trigger with no text and no header text), and the 520–610 KB `war3map.lua` is injected code that Studio did not make. So they test the **`"kept"` Lua case, an empty tree, and the "no text" rules**, but not GUI triggers, custom-text triggers or script items in Lua. **`smoketest_maps/FiresOverEversong(FOE)-v3.0.0.w3x` is the Lua map with real triggers:** `scriptType` 1, decodes with the game's TriggerData, 193 tree items (164 script items, 1 GUI trigger, 1 custom-text trigger, 18 folders, 8 variables), a 3.1 MB `.wct` (the largest single text is 349 KB) and a 2.8 MB `war3map.lua`; no illegal or non-ASCII names, no zero bytes, no BOM; 4 repeated names (`Systems`, `ALICE`, …); the header has no text. Its texts are CRLF in 146 files and LF-only in 19 (none mixed within one text, stage 0 corrected that), and its script items are libraries that depend on tree order (the `Systems` folder lists `DebugOffMode`, `DebugUtils`, `IngameConsole`, `CodeBridge`, … in an order Lua needs, so `order.txt` is not optional). It has few GUI triggers, so GUI triggers in a Lua map are still covered only by WoWR's JASS ones (GUI files are language-neutral) until a map with more of them turns up. `smoketest_maps/OriginZ 1.04h.w3m` is Lua too (`scriptType` 1, a 1 MB `war3map.lua` with 109 functions and 325 `gg_trg_` references) but **has no `war3map.wtg` and no `war3map.wct` in the archive at all** (triggers stripped, as protected maps do). It adds the **"no trigger files" case**: no `map/triggers/` is written, `pack` writes no `wtg` / `wct` (it never invents an empty tree), and the script is `"kept"`. Stage 0 `lostFunctions` (generator output against the current script): the W3Champions map HillsbradCreek has 926 injected functions (a TypeScript-to-Lua runtime) and none of the generator's own, so it stays `"kept"`; **FOE has 35, all World Editor helpers the Lua generator does not write (`array2DLua` and 34 `*BT` frame wrappers)**, so `"generated"` is realistic for FOE once the generator writes them.

**Functions TriggerData does not know** cannot be compiled by the generator. Such a map takes the raw fallback (see Goal), so a folder project never has a GUI trigger the generator cannot turn into JASS.

---

## 6. Merge Checks ("Check Trigger Tree")

Disjoint files stop textual conflicts, not semantic ones. The command runs automatically after a merge that touched `map/triggers/` and on pack; it reports and never edits silently (a repair, such as a new id, is a listed fix the user applies):
- duplicate ids that were not in the import (imported duplicates are accepted, section 4), duplicate or conflicting `udg_*` variables;
- slug collisions on a case-insensitive filesystem; `order.txt` entries without a file; files without frontmatter that look like they belong elsewhere;
- a trigger whose script defines `InitTrig_<other name>`;
- malformed frontmatter or `.gui.json`.

---

## 7. Performance

- **Measured (stage 0, WoWR, 2,228 files, warm Linux, 16 cores, NVMe, unoptimised prototype):** read 7–20 ms, write about 58 ms, assemble and encode `wtg` / `wct` about 175 ms; today's single files read and parse in about 54 ms. So about 0.2 s against 0.06 s for a read, and writing is no slower in practice (only changed files are written). Windows is not measured; that is the remaining risk.
- **Read:** one file and one parse today; thousands of small files for a big map. On NTFS with Defender that can cost seconds, on Linux little. The tree is read **in Rust, in parallel, and handed to the app as one structure**; the app never makes one IPC or VFS call per trigger. The Trigger Editor needs the whole tree anyway, so lazy loading is not part of this spec (reading headers first and bodies on open is a possible later step).
- **Write:** better than today. The layer keeps a content hash per file and writes only files that changed instead of rewriting a multi-MB JSON; dirty state is per trigger.
- **Watching:** a save or `git checkout` touches many files. `map/triggers/**` is watched with a debounce and handled as one batch.
- **Git:** diffs and merges improve a lot; a fresh checkout of thousands of files is somewhat slower on Windows.
- **Pack:** assembling `wtg` / `wct` is trivial; regenerating the script is the cost it already has today.
- **Prerequisite:** The Trigger Editor has no safe in-place reload with unsaved edits. The folder layout is the only layout, so an outside change to many triggers (a `git checkout`, a pull) must be handled: a dirty trigger keeps its edits and shows a conflict flag, the others reload. This lands with stage 2, not later.

---

## 8. Implementation Order

1. **Stage 0 (done 2026-11-22; branch `triggers-stage0`, `crates/w3proj/examples/triggers_stage0.rs`, throwaway).** 119 maps with a decodable `wtg` (77 Reforged, 42 Classic, 95 of them from the campaign files) round-trip byte for byte when ids, counts and `variableOrder` are stored; tree order, frontmatter pass-through, id internality and the vJASS first-line comment are confirmed; its findings are folded into the sections above. Still open from it: **Windows timing**, and a Lua map with many GUI triggers.
2. Layout-aware reader/writer (shares the terrain layer) replacing the flat codecs: `triggers.json`, files, `order.txt`, slugs, raw fallback for undecodable maps, unpack and pack switched over, flat files and tests removed, editor reload with unsaved edits.
3. Ids and counters (stored for imports, assigned for new, tree built from item order, duplicate-id handling), `wct.rs` accepting inner zero bytes, Classic rules, the editor's children lookup by tree position.
4. Script as derived: `derived.rs` over the new sources, script group in `derived-from.json`, `pack` refusing, `"kept"` mode and "Regenerate Map Script…". Prerequisites: the map's own `common.j` reaches JassHelper; the Lua generator writes `array2DLua` and the `*BT` helpers (for FOE); `lostFunctions` normalises JassHelper's naming. **Done when** a packed example map has been opened and saved in the real World Editor and the result diffed: the risk is the regenerated script, not `wtg`/`wct`.
5. Check Trigger Tree, per-file diagnostics.

## 9. Editor and Tooling Gains

- **Per-file diagnostics:** the vJASS/JASS tooling and the Problems view lint each trigger file with its own file and line, instead of mapping offsets inside one concatenated text.
- **Rename refactoring:** `rename.ts` / `refs.ts` rewrite only the files that reference a renamed variable or trigger.
- **One directory-valued codec mechanism** for terrain and triggers: one archive file ↔ many project files, with the same assemble-on-read, slice-on-write layer and file watching. This touches the sync and `pack_meta_files` tests; design it once for both.
- **Migration scope:** `war3map.wtg.json` / `.wct.txt` names appear across the app, `project.rs`, `names.rs`, `derived.rs` and CLI tests. They are replaced, not supported next to the new ones. All access goes through the layout-aware layer, as for terrain.

## 10. Decisions

- Folder layout is the only layout, default for every map; old maps convert by a `.w3x` round trip.
- Undecodable maps keep raw `war3map.wtg` / `.wct` (opaque) and a kept script.
- Real zero bytes in texts: no flag; every text goes through `lossless`, and `wct.rs` accepts inner zeros (stage 0).
- Ids, counts and (for imports) `variableOrder` are stored for exact repack; `variableOrder` is dropped by the first variable change; new items have no stored id; the tree comes from item order; imported duplicate ids are kept.
- Classic maps use the same layout with no root, ids, nesting or item types 16/32/64.
- Two refusal flags (`--allow-stale-script`, `--allow-terrain-only-derived`).
- Frontmatter in the script file, not a sidecar (stage 0 can overturn this).
- vJASS maps: script regenerated on pack or on request, never blocking a save (JassHelper is about 9 s warm and not deterministic, so staleness is judged from inputs); release pack needs the game and JassHelper; World Editor maps start `"kept"`, and switching is the user's choice after a `lostFunctions` report. WoWR is the stage 0 test map.
- Lua maps: language from `w3i` `scriptType`; no JassHelper; wrong-language files are errors; a language switch does not translate texts.
- Whether the real World Editor accepts a map packed from this layout is a test (stage 4 done-criterion), not a design question.

## Stage 4 as built (branch `trigger-folders-script`): deviations

- `"kept"`: a kept script that is Studio's own (stamp matches, or the data makes it exactly: the mini fixture) is still regenerated in place on saves, as the guard did; a kept script that isn't Studio's is never written by a save. The kept question's "Replace the script" still replaces in place (asked, checkpointed); switching to `"generated"` is only Regenerate Map Script….
- The `*BT` helpers and `array2DLua` are a third-party trigger editor's ("Better Triggers": the game's 3.0.1 TriggerData has no BT functions), not the World Editor's: written only for a Lua map whose current script has them (FOE), never otherwise. FOE's `globals(function(_ENV) … end)` call and `bt_` globals aren't written.
- vJASS: a generated script isn't compiled on open either (only on pack and on request); no background regeneration after a save. The CLI's headless generator has no JassHelper, so `w3proj pack` can't make a stale generated vJASS script (it refuses; Studio's pack or Regenerate makes it).
- The app's own pack refuses a stale generated script too (after trying to make it), not only `w3proj pack`.
- A sync from a map whose script isn't Studio's (a World Editor save) still turns a generated project kept (stage 2a's rule).
- The map's own common.j: its extra declarations are appended to the game's (types, a second `globals` block, natives); whether JassHelper/pjass accepts that on WoWR is not run yet.

## Stage 5 as built (branch `trigger-folders-checks`): deviations

- Imported vs merged duplicate ids: there is no record of the import's ids. Rule: folders' (category, library) ids are never reported (World Editor maps share them); a stored id held twice by triggers, comments or script items, or by two variables, is an error (ids are stored only for imported items, so a pair is a copied file or a rename/rename merge). An imported map with two triggers sharing an id would be reported; the corpus has none (`w3proj verify` now fails on any finding in an import).
- Renumber drops the later item's stored id (pack gives it a free one); no new number is written into the file.
- Pack refuses Check Trigger Tree's errors (conflict markers, unreadable files, a variable defined twice differently, case-only name collisions, wrong-language files), except a stored id held twice, which it writes back as imported and only tells; warnings are told. No override flag.
- Two triggers giving one `gg_trg_` global and a custom text defining another's `InitTrig_` are warnings, not errors; only enabled, non-comment triggers with a letter or digit in the name count (World Editor maps have rows of disabled "-----" separators).
- order.txt: files it doesn't list are reported only in folders that have an order.txt (a folder without one is alphabetical on purpose).
- Not built: running automatically after a merge (no git hook for triggers; `w3proj terrain merge-hook` isn't extended) or after outside changes in the app; "files without frontmatter that look like they belong elsewhere".
- Per-file diagnostics (Problems "Map script"): each JASS file is checked against the map script's and the other files' declarations; unknown `udg_`/`gg_` names are left to the whole script's check, whose findings inside a text the script copied verbatim are moved to the file's line (one report per line). vJASS files aren't linted per file (JassHelper compiles the whole script); "Check with JassHelper" still tells the text's own lines, not file lines. Lua files: syntax only.
- A trigger referring to a variable or trigger that no longer exists: the existing "References in triggers" check (GUI triggers); in JASS texts through the whole script's findings moved to the file.
- CLI: `w3proj triggers <project> --check [--fix renumber,order,collapse|all] [--json]`; `w3proj check` reports it through the Problems check.
