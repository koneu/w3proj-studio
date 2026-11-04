# W3Proj Studio

A modular editor for Warcraft III maps. Maps live as **unpacked, git-friendly
project folders**, and packing to `.w3x` is a release step. Binary map data
(terrain, doodads, regions…) is still edited in Blizzard's World Editor, which
this tool launches and syncs back from.

## How the World Editor stores a map (and what we do with it)

A `.w3x` is a 512-byte `HM3W` header (name, flags, max players) followed by an
MPQ archive. The archive holds files like:

| file | content | in the project |
|---|---|---|
| `war3map.j` / `.lua` | map script (triggers compile to this) | text, as-is |
| `war3map.w3u/.w3t/.w3a/.w3b/.w3d/.w3h/.w3q` | object data: unit/item/ability/… modifications | **JSON** (`*.json`) |
| `war3map.wts` | trigger strings (`TRIGSTR_xxx`) | text, as-is |
| `war3map.w3i` | map info: name, players, forces, options, fog, … (format v25–v39) | **JSON** (`war3map.w3i.json`) |
| `war3map.doo`, `war3mapUnits.doo` | placed doodads/destructables; units, items, start locations (v8, v12, v13) | **JSON** |
| `war3map.w3e`, `.wpm`, `.shd` | terrain, pathing, shadows | binary |
| `war3map.w3r/.w3c/.w3s` | regions, cameras, sounds | **JSON** |
| `war3map.wtg` | GUI triggers, variables, categories | **JSON** (`war3map.wtg.json`; unpacking needs the game's `UI\TriggerData.txt`, packing doesn't) |
| `war3map.wct` | custom script: the map header and each trigger's text | **text** (`war3map.wct.txt`, one section per trigger) |
| `war3map.imp`, `war3mapImported\*` | imports | as-is |

Every codec is checked on unpack: a file is stored as JSON only if
`encode(decode(file))` gives back the original bytes; otherwise it is kept raw.
So **pack is always lossless**. Verified against 676 local maps: 0 mismatches.
The object-data codec round-trips every file in that set.

## Format definitions

Blizzard's binary layouts are not hard-coded: they are **format definitions** (JSON with
`//` comments) interpreted by one engine (`crates/w3proj/src/format`). The built-ins live in
[crates/w3proj/formats/](crates/w3proj/formats/) — `w3i`, `doodads`, `units`, `regions`, `cameras`, `sounds` — and are compiled
into the CLI and the app. A definition lists fields with types, counts, `if` conditions
(`version >= 39`), plausibility `check`s and **variants** for layouts that differ without a
version bump (e.g. v39 player HUD skins, v8 doodads without skin ids): the engine tries each
reading and keeps the one that reproduces the file byte-exactly and passes the checks; ambiguous
choices are reported in the unpack output.

To adapt a format (a new patch, an unknown field): copy the definition into the project —
*Extensions → Formats → Customize*, or `w3proj formats --show w3i > .w3proj/formats/w3i.json` —
edit it, and re-sync. Definitions in `.w3proj/formats` (project), the app's user `formats`
folder or `W3PROJ_FORMATS` (CLI) replace built-ins with the same `name`. `w3proj formats`
lists what is active. Every file is still checked round-trip on unpack, so a wrong definition
makes files fall back to raw — it cannot corrupt a map.

## Project layout

```
MyMap/
  w3proj.toml       map header + archive/pack settings
  map/              one file per archive file (object data as *.json)
  unnamed/          files of protected maps whose names can't be recovered (not packed)
  build/            pack output (git-ignored)
  .w3proj/extensions/   optional project-local extensions
```

## Repository layout

```
crates/mpq       MPQ v1 reader/writer (zlib/bzip2/pkware, encrypted tables, deterministic output)
crates/casc      read-only CASC reader for the installed game (index, BLTE, encoding, text root,
                 mod layering SD/HD/DE + locale + FileAliases + .blp→.dds fallback)
crates/w3proj    project format, codecs, unpack/sync/pack/verify
crates/cli       `w3proj` command line
app/             Tauri desktop app
  src-tauri/     Rust backend (thin: exposes the core, files, launching WE/game)
  src/workbench/ VS Code-like shell: activity bar, views, tabs, palette, status bar, output
  src/extensions/api.ts       the public extension API
  src/extensions/services.ts  contracts of the services extensions provide each other
  src/lib/       shared code that belongs to no extension
    image/                 dependency-free BLP1/BLP2, DDS (BC1–5) and TGA decoders, incl. a
                           baseline + progressive JPEG decoder for BLP1's 4-channel JPEGs
    model/                 MDX parser (v800–v1800) and WebGL2 renderer (GPU skinning)
    formats/text.ts        SLK and INI parsing
    objects/metadata.ts    object data knowledge from the game (fields, names, defaults)
  src/builtin/   built-in extensions (explorer, text editor, object editor, texture viewer, map project, …)
    terrain-viewer/        w3e parser, ground/water renderer, cliffs, object placement, pathing map
```

Module boundaries (checked by `npm run check` and the build, `app/scripts/check-imports.mjs`):
an extension imports only its own files, `src/lib`, `src/extensions` and `workbench/dom`.
Functionality one extension offers others goes through a service, not an import.

## Build & run

Requires Rust (the toolchain version is pinned in `rust-toolchain.toml`), Node 20+, and WebView2.

```sh
cargo test --workspace
cargo build --release -p w3proj-cli        # → target/release/w3proj.exe

cd app
npm install
npx tauri dev                              # run the editor
npx tauri build                            # installer in target/release/bundle
```

### CLI

```sh
w3proj unpack MyMap.w3x MyMap/      # create or re-sync a project
w3proj pack MyMap/ [-o out.w3x]     # release build (default: MyMap/build/MyMap.w3x)
w3proj verify *.w3x                 # unpack→pack in memory, compare every file
w3proj ls MyMap.w3x                 # sizes, stored sizes, flags, table sizes
w3proj cat MyMap.w3x war3map.j
w3proj formats [--project MyMap/] [--show w3i]   # format definitions in use

# the installed game's own data (default install: C:\Program Files (x86)\Warcraft III)
w3proj game info                               # build, locale, layer order
w3proj game ls footman                         # stored files containing "footman"
w3proj game --mode hd resolve Units/Human/Footman/Footman.mdx
w3proj game cat Units/UnitMetaData.slk
```

### Corpus checks (regression tests on real maps)

Real maps aren't in the repository (`smoketest_maps/` is ignored: size and third-party
content), so the conversions are checked against a local map folder:

```sh
# unpack→pack every map/campaign in the folder, and compare which codec reads each file
# with tests/corpus-baseline.tsv (a codec that silently falls back to raw fails too)
w3proj verify -q smoketest_maps --baseline tests/corpus-baseline.tsv
# after an intended change (new codec, new maps): rewrite the checked maps' lines
w3proj verify -q smoketest_maps --baseline tests/corpus-baseline.tsv --update-baseline

# the TypeScript copies of the text codecs (w3e, wct, wtg) give the same text and bytes as Rust
cd app && node scripts/twin-check.mjs ../smoketest_maps
```

Maps missing from the baseline are reported as new, not as failures. Both need the installed
game for TriggerData.txt (`--game` / `W3PROJ_GAME`).

### Game data

The app reads the game's files straight from the CASC storage in `Data/`:

- The **Game Data** sidebar lets you browse and search all ~94k stored files and open them
  read-only, so textures open in the Texture Viewer and SLKs and scripts in the text editor.
- The object editor shows every field that applies to an object, with World Editor labels
  (`uhpm` → "Hit Points Maximum (Base)") and the inherited value from the game tables;
  editing an inherited value creates the modification, ↺ resets it. Abilities and upgrades
  show one row per level. **+ New** picks the base object by name and suggests the next
  free id (`hfoo` → `h000`); **Open Object Editor…** (F6) creates missing object files.
- Extensions use `w3.game.read("Units\\UnitData.slk")` etc. Plain paths resolve like the
  game does: locale → art layer (`game.graphicsMode`: `hd`/`sd`/`de`) → base, with
  `FileAliases.json` and `.blp`→`.dds` fallback.
- Settings: `game.installDir`, `game.graphicsMode`.

### Model viewer

`.mdx` files (game data or imported into a map) open in a 3D viewer: animations with
speed and scrubbing, team colour, wireframe, per-geoset visibility, and the list of
textures with load status. It reads MDX v800 (classic) through v1800 (Reforged), including
HD skin weights and LODs (LOD 1–3 start hidden) and the HD team-colour mask. Textures are
looked up in the map first, then in the model's own game layer (`.blp`/`.tif` → `.dds`).
Particles, ribbons, lights, cameras and PBR lighting aren't drawn yet.

### Terrain viewer

**F3** (or opening `war3map.w3e`) shows the map in 3D: ground textures blended the way the
game does (corner-mask tile atlas with variations), cliff models, water, and placed doodads,
destructables, units and items as models (from the game's skin tables; player colours for
units). Drag or arrow keys pan, right-drag rotates, the wheel zooms. Reads `w3e` v11 (classic)
and v12 (2.0). Raw `war3map.doo` / `war3mapUnits.doo` are decoded through the format engine
(`codec_decode`) when the project doesn't have them as JSON. See OPEN_POINTS for what's
approximated.

### Map properties

The **Scenario** sidebar (or F7) opens `war3map.w3i.json` as a form: description, loading and
prologue screens, map options, environment (weather, fog, water, camera zoom), players and
forces. Texts that live in the string table (`TRIGSTR_…`) are edited in `war3map.wts` directly,
changing only that string. Formats v25 (TFT) through v39 (3.0) are supported; v32–v39 follow
War3Net / wc3libs and are verified byte-exact against the game's own 3.0 campaign maps.

## Workflow with the World Editor

1. **Import .w3x as New Project…** (or **New Map…**, Ctrl+N, for an empty map), then commit the folder.
2. Edit scripts and object data in the app, or press **F5 — Open in World
   Editor**. That packs `build/<name>.edit.w3x`, starts
   `World Editor.exe -launch -loadfile <map>`, and watches the file. Each save
   in the World Editor syncs back into `map/`. The `project.syncOnWorldEditorSave`
   setting takes `ask`, `always` or `never`.
3. **Ctrl+Shift+B — Pack Release .w3x**. **Ctrl+F5** packs and starts the game
   with the map.

The editor and game paths are in *Preferences: Open Settings (JSON)*. They default
to `_retail_\x86_64`.

## Extensions

Everything beyond the shell is an extension. Built-ins and user extensions use
the same API (`app/src/extensions/api.ts`):

```
%APPDATA%\dev.w3proj.studio\extensions\<name>\extension.json + main.js
<project>\.w3proj\extensions\<name>\…
```

```json
{
  "id": "me.stats", "name": "Stats", "version": "0.1.0", "main": "main.js",
  "contributes": {
    "commands": [{ "id": "me.stats.run", "title": "Run Stats", "keybinding": "ctrl+alt+s" }],
    "viewContainers": [{ "id": "stats", "title": "Stats", "icon": "∑" }],
    "views": [{ "id": "me.stats.view", "title": "Stats", "container": "stats" }],
    "editors": [{ "id": "me.stats.editor", "title": "Stats Editor", "patterns": ["*.w3i"] }]
  }
}
```

```js
export function activate(w3, ctx) {
  ctx.subscriptions.push(w3.commands.register("me.stats.run", () => w3.window.showInfo("hi")));
}
```

**Replacing built-ins.** Every built-in can be turned off: `"extensions.disabled": ["w3.objectEditor"]`
in settings (or the Disable button in the Extensions view; applies after a reload). To make a
different editor the default for some files without disabling anything, map a glob to an editor
id: `"editorAssociations": { "*.w3u.json": "my.objectEditor" }`, or use *Configure Default Editor
for This File Type…*. Extensions with an id that is already taken are skipped (see the Extension
Host log), so a replacement uses its own id plus one of these two settings.

Extensions activate lazily: a contributed command, view or editor activates
its extension on first use. `"activationEvents": ["onStartup"]` loads it
immediately. *Extensions: Create Sample Extension* writes a working example.

**Settings.** Extensions declare settings in `contributes.configuration` (type, default,
description, minimum/maximum, enum) and read them with `w3.settings.get(key)`. Values come from
the open project (`.w3proj/settings.json`, versioned with the map), then the user
(`%APPDATA%dev.w3proj.studiosettings.json`), then the declared default; settings with
`"scope": "user"` (paths, lists) ignore the project layer. *Preferences: Open Settings* (Ctrl+,)
edits either layer; the map tools' parameters live under `terrain.*` (pathing, shadows, minimap).

```json
"configuration": { "title": "Stats", "properties": {
  "stats.limit": { "type": "integer", "default": 10, "minimum": 1, "description": "Rows to show." }
} }
```

**Services and dependencies.** An extension shares functionality by declaring
`"contributes": { "services": [{ "id": "me.thing" }] }` and calling
`w3.services.provide("me.thing", impl)` in `activate`. Users call
`await w3.services.get("me.thing")` (which activates the provider) and list the
provider in `"extensionDependencies": ["me.provider"]`. If a dependency is
disabled or missing, the dependent fails to activate with a message naming it
(Extensions view). Built-in services:

| Service | Provider | What |
|---|---|---|
| `w3.objects` | Object Editor | `pick(host, { title, kinds })`: the object browser (search, facets, field filters, the map's custom objects), one tab per kind; `icon(kind, id)` |
| `w3.terrain` | Terrain Viewer | `registerToolGroup(group)`: a tab in the terrain editor with its own toolbar, pointer/key handlers, ground overlay, pathing filter and save hook; the handle exposes terrain strokes, ground tiles and placed objects |

The terrain editor itself only does view, selection, undo and saving; its tools are sub-extensions
that use `w3.terrain`: Terrain Painter (`terrain-painter`), Object Placer (`terrain-objects`) and
Pathing Editor (`terrain-pathing`, overrides in `.w3proj/pathing.json`).

## Known limits / next steps

- Binary formats (`w3e`, `wpm`, `shd`, …) are stored raw. New codecs
  plug into `crates/w3proj/src/codec.rs` and are verified automatically.
- Game data is read-only, and only files stored locally can be read (other
  locales aren't downloaded). Encrypted CASC entries aren't supported; none
  are present in 3.0.1.
- Files of protected maps whose names were stripped can't be repacked.
- Archive names that aren't UTF-8 (rare, old Asian-locale maps) are not recovered.
