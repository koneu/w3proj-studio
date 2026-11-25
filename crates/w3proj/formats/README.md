# File formats of W3Proj Studio

Every file format the project reads or writes, where its code is, how it looks in an unpacked
project, and what proves it. Written 2026-11-24 from the code at that date. A claim marked
*unverified* was not checked in the code.

This folder holds the **format definitions**: JSON files that describe a binary layout (field
names, types, counts, version conditions, plausibility checks) for one engine
(`crates/w3proj/src/format/`, node reference in its `mod.rs` header). Ten formats have one. All other
formats are hand-written codecs, in Rust, in TypeScript or in both. The TypeScript side has no
definitions of its own: `app/src/lib/formats/` (see the README there) holds helpers for text files
(SLK, INI, string tables), not binary layouts.

`w3proj formats [--project DIR] [--show NAME]` lists the definitions in use and prints one.
A definition in `<project>/.w3proj/formats`, in the app's user `formats` folder or in `W3PROJ_FORMATS`
replaces the built-in one of the same `name`.

## How a file gets from the map to the project

1. Unpack asks the codecs that claim an archive name (`crates/w3proj/src/codec.rs`, `Registry`).
2. A codec is used only if `encode(decode(bytes)) == bytes` (`project.rs`, `add_file`). Otherwise the
   file is stored raw, byte for byte, and the unpack report notes why. So no codec, however
   incomplete, can change a map on pack.
3. Pack reverses it. The triggers and the split terrain are directory-valued codecs
   (`folder_codec.rs`): one archive file stands for many project files.

The project keeps `format` strings of the form `w3proj.<name>/<major>` in its JSON documents. The definition engine refuses a document whose `format` differs from the definition's `jsonFormat`
(`format/engine.rs`), and `triggers`, `terrain` and `pathing` refuse a different major version (tests in
`trigger_layout.rs`, `terrain_layout.rs`, `terrain_pathing.rs` change `/1` to `/2` and expect a refusal). Hand-written JSON Schemas (draft 2020-12) for the project files of the ten definitions are in
[docs/schemas](../../../docs/schemas/README.md), with a VS Code mapping; `app/src/lib/formats/schemas.test.ts` checks
them against the definitions, the mini-map and the corpus.

## Map files, binary (Reign of Chaos to Reforged 3.0)

"Def" is a format definition in this folder. "Round trip" is what unpack checks for every file; the
corpus column says how many files the corpus baseline (`tests/corpus-baseline.tsv`, run by
`node tests/gate.mjs corpus`) lists under that codec (a map's file counts once per map or campaign
copy). The mini-map is `tests/fixtures/mini-map`.

| File | Versions the code accepts | Rust | TypeScript | Project form, `format` tag | Spec / schema | Tests |
|---|---|---|---|---|---|---|
| `war3map.w3i` map info | 18, 25 to 39 | def `w3i.json` | none (reads the JSON) | `map/war3map.w3i.json`, `w3proj.mapinfo/1` | the definition; `docs/schemas/w3i.schema.json` (each of the ten has one) | mini-map in `cli/tests/roundtrip.rs` `verify_finds_every_codec_at_work`; corpus 116 rows (`format:w3i`); 3 campaign chapter maps' w3i fall back to raw in the baseline (reason not looked up) |
| `war3map.doo` doodads | 7, 8, 12, 13 | def `doodads.json` | none | `map/war3map.doo.json`, `w3proj.doodads/1` | the definition | same test; corpus 128 |
| `war3mapUnits.doo` units, items, starts | 7, 8, 12, 13 | def `units.json` | none | `map/war3mapUnits.doo.json`, `w3proj.units/1` | the definition | same test; corpus 116 |
| `war3map.w3r` regions | 5, 7 | def `regions.json` | none | `.w3r.json`, `w3proj.regions/1` | the definition | same test; corpus 114 |
| `war3map.w3c` cameras | 0, 3 | def `cameras.json` | none | `.w3c.json`, `w3proj.cameras/1` | the definition | same test; corpus 114 |
| `war3map.w3s` sounds | 1 to 3 | def `sounds.json` | none | `.w3s.json`, `w3proj.sounds/1` | the definition | **not in the mini-map**; corpus 84 |
| `war3map.w3l` own lighting | 3 | def `lights.json` | none | `.w3l.json`, `w3proj.lights/1` | the definition | **not in the mini-map**; corpus 22 |
| `war3map.imp`, `war3campaign.imp` imports | 1 | def `imports.json` | none | `.imp.json`, `w3proj.imports/1` | the definition | **not in the mini-map**; corpus 55 |
| `war3map.mmp` minimap icons | 0 | def `minimap.json` | none | `.mmp.json`, `w3proj.minimap/1` | the definition | mini-map; corpus 126 |
| `war3campaign.w3f` campaign info | 1 to 3 | def `campaign.json` | none | `.w3f.json`, `w3proj.campaign/1` | the definition | **not in the mini-map**; corpus 8 |
| `war3map.w3e` terrain | 11, 12 (`w3e.rs`) | `w3e.rs` (text grids) | `lib/terrain/w3e.ts` (parse, write), `w3etext.ts` (the same text) | `map/war3map.w3e.txt`, header line `W3E version N`, no tag | header comment of `w3e.rs`; no schema | `w3e.rs` unit tests, `lib/terrain/w3e.test.ts`, `w3etext.test.ts`; mini-map; corpus 128; `app/scripts/twin-check.mjs` compares Rust and TS text on real maps |
| `war3map.w3u .w3t .w3b .w3d .w3a .w3h .w3q`, `war3mapSkin.*`, `war3campaign.*` object data | 1 to 3 (header of `objdata.rs`) | `objdata.rs` | none: `builtin/object-editor/` works on the JSON (no `DataView` use found there) | `.json`, `w3proj.objects/1` | layout in the `objdata.rs` header; no schema | `objdata.rs` unit tests; mini-map has only `war3map.w3u`; corpus 797 rows (the largest group) |
| `war3map.wtg` triggers, `war3map.wct` custom script | Reforged and classic v4/v7 (`wtg.rs`, `wct.rs`) | `wtg.rs`, `wct.rs`, `triggerdata.rs`, `trigger_layout.rs` | `lib/triggers/wtg.ts` (`parseWtg`, `writeWtg`, `parseWct`, `writeWct`), `triggerdata.ts` | folders `map/triggers/`, `triggers.json` with `w3proj.triggers/1`, GUI triggers `.gui.json`, script `.j`/`.lua` with a `// @w3proj {...}` line | `trigger_layout.rs` header; the long spec is `docs/trigger-folders-spec.md`; no schema | `crates/cli/tests/triggers.rs`, `w3proj/tests/wtg_hostile.rs`, `wct_inner_zero_bytes.rs`, `trigger_layout.rs` tests, `lib/triggers/wtg.test.ts`; fixture `tests/fixtures/trigger-folders`; corpus 228 rows; `twin-check.mjs`. Reading needs the game's `TriggerData.txt`; without it the files stay raw (writing doesn't need it) |
| `war3map.wts` trigger strings | one layout | `wts.rs` (string table, pruning) | `lib/formats/wts.ts` (`pruneStrings`), `localewts.ts`, `prunedstrings.ts` | kept as text, byte for byte, `map/war3map.wts`; dropped strings are recorded in `.w3proj/pruned-strings.json`, `w3proj.prunedStrings/1` | `wts.rs` header; no schema | `w3proj/tests/wts_prune.rs`, `wts.rs` tests, `lib/formats/wts.test.ts`, `wtsprune.test.ts`, `prunedstrings.test.ts`; fixtures `tests/fixtures/wts-*`; `app/scripts/wts-corpus.mjs` |
| `war3map.wpm` pathing | `MP3W`, version 0 | none (stored raw) | `lib/terrain/pathing.ts` generates it; layout in its header comment | raw binary `map/war3map.wpm` (hand overrides: `.w3proj/pathing.json`, `w3proj.pathing/1`; in a split project `<folder>/pathing.txt`, `terrain_pathing.rs`) | comment in `pathing.ts` only | `lib/terrain/pathing.test.ts`, `terrain_pathing.rs` tests; mini-map holds one. No reader that checks a stored file against the layout was found (*unverified*) |
| `war3map.shd` shadows | no header, one byte per cell | none (raw) | `builtin/terrain-viewer/shadows.ts`, `shadowmap.ts` generate it | raw binary | comment in `shadows.ts` only | `shadows.test.ts`, `shadowmap.test.ts`, `viewshadows.test.ts` |
| `war3map.wai` AI | version 2 | none | `lib/ai/wai.ts` (`parseWai`, `writeWai`) | raw binary | comment in `wai.ts`; no schema | `lib/ai/wai.test.ts` ("an AI with every section survives, to the byte"), `hostile.test.ts`; `hostile-seeds.mjs` on the game's `.wai` |
| `.w3o` all object data in one file | 1 | `w3o.rs` (`pack`, `unpack`, `_json` variants), called by the app's Tauri commands `w3o_export`, `w3o_import` (`app/src-tauri/src/lib.rs`) | `builtin/object-editor/w3o.ts` (version conversion, merge), `w3ofiles.ts` (calls the commands) | not stored in a project; the app imports and exports it | `w3o.rs` header | `w3o.rs` tests, `robustness.rs` `w3o_survives_damaged_files`, `builtin/object-editor/w3o.test.ts`; fixture `tests/fixtures/w3o` |

## Containers and the game's storage

| What | Rust | TypeScript | Project form | Notes and tests |
|---|---|---|---|---|
| `.w3x`, `.w3m` map: 512-byte `HM3W` header + MPQ v1 | `crates/mpq` (read, write, ADPCM, Huffman, `crypto.rs`), `header.rs` | none (the app reads through the backend) | `w3proj.toml` (`format = 1`, `project.rs` `FORMAT_VERSION`; written by `manifest_text.rs` without touching what the user added), `header.bin` only if the header can't be regenerated | `crates/mpq` unit tests, `crates/cli/tests/mpq_sound_sectors.rs`, `robustness.rs` `archive_reader_survives_damaged_maps`, `decompression_survives_damaged_sectors`; corpus verify |
| `.w3n` campaign (an MPQ without the map header) | `project.rs` (`is_campaign_project`, `maps/` holds each chapter as a project of its own) | `builtin/campaign-editor/` | `maps/<chapter map name>/` plus the campaign's own files | `crates/w3proj/tests/campaign_gitignore.rs`; corpus rows `map project` 104 |
| Split terrain | `terrain_layout.rs`, `terrain_objects.rs`, `terrain_ids.rs`, `terrain_open.rs` | `lib/terrain/subterrainplan.ts`, `layoutdraft.ts`, `builtin/terrain-layout/` | `map/terrain/terrain.json` (`w3proj.terrain/1`), per subterrain `terrain.txt`, `doodads.json`, `units.json`, `regions.json`, `pathing.txt`; local `.w3proj/open-subterrains.json` (`w3proj.open-subterrains/1`) | spec `docs/terrain-subterrains-spec.md`; tests in the Rust files, `robustness.rs` `damaged_split_terrain_files_are_errors`; `w3proj verify` runs a split round trip on every map |
| Derived-files record | `derived.rs` | none | `.w3proj/derived-from.json`, `w3proj.derived-from/1`; generated-script stamp `.w3proj/generated-script` | `derived.rs` tests |
| Clipboard fragment of terrain | none | `lib/terrain/fragment.ts` | `w3proj.fragment/1`, in the app's clipboard, not in a project | `fragment.test.ts`; `twin-check.mjs` |
| The game's CASC storage | `crates/casc` (read only) | none | not stored | `casc` unit tests; `w3proj game ...` |

## Models, images, tables and text

None of these has a Rust codec except the SLK reader in the CLI. They stay byte for byte in a project.

| File | TypeScript | Rust | Notes and tests |
|---|---|---|---|
| `.mdx` model | `lib/model/mdx.ts` (`parseMdx`; `renameTextures` edits a file in place), `dnclight.ts` | none | read; `renameTextures` edits in place; `classic.ts` writes a Reforged model as Classic MDX 800; `mdx.test.ts`, `hostile.test.ts`, `hostile-seeds.mjs` |
| `.mdl` model text | `lib/model/mdl.ts` (`parseMdl`, `parseModel`);  | none | `mdl.test.ts`, `hostile.test.ts` |
| `.blp` (BLP1 JPEG, BLP2), `.dds`, `.tga` | `lib/image/` (`decodeImage`; `encodeBlp1Jpeg` writes BLP1) | none | `decode.test.ts`, `dxt.test.ts`, `encode.test.ts`, `png.test.ts`, `hostile.test.ts`. TGA and DDS are read only. `war3mapMap.blp` (minimap) is generated by `builtin/terrain-viewer/minimapgen.ts` |
| `.png`, `.jpg` | `lib/image/png.ts` (writes stored PNG), `jpeg.ts` (decoder) | none | `png.test.ts` |
| `.slk` tables | `lib/formats/text.ts` (`parseSlk`) | `crates/cli/src/slk.rs` (`w3proj game slk`) | `lib/formats/formats.test.ts` |
| `.ini`, `.txt` profiles (`war3mapSkin.txt`, `war3mapMisc.txt`, `war3mapExtra.txt`) | `lib/formats/text.ts` (`parseIni`), `iniedit.ts` | none | stored as text; `formats.test.ts` |
| `.j` JASS, `.lua` | `lib/jass/check.ts`, `lib/lua/check.ts` (checkers, not codecs) | `crates/backend/src/script.rs` (script generation) | stored as text; `hostile.test.ts` covers the checkers |
| `.fdf`, `.toc` | text editor only | `wts.rs` scans them for string references | stored as text |
| `UI\TriggerData.txt` | `lib/triggers/triggerdata.ts` | `triggerdata.rs` | read from the game, never stored; `triggerdata.test.ts`, `hostile.test.ts` |
| Sound files (`.wav`, `.mp3`, `.flac`) | `lib/audio/duration.ts` | none | only the duration is read; `duration.test.ts` |

## Gaps

| Gap | Facts | Suggested follow-up |
|---|---|---|
| **JSON Schemas only for the ten definitions** | `docs/schemas/*.schema.json`, hand-written, kept in step with the definitions by `app/src/lib/formats/schemas.test.ts`. The code-defined project JSON (`objects`, `triggers`, `terrain`, `pathing`, the split terrain's per-subterrain object files) has none | write schemas for the code-defined ones |
| **Layouts without a definition**: object data (w3u family), w3e, wtg, wct, wts, wai, w3o, wpm, shd, mdx, blp | hand-written Rust and/or TypeScript; their layout is documented in a header comment at best (`objdata.rs`, `w3e.rs`, `wtg.rs`, `wct.rs`, `w3o.rs`, `pathing.ts`, `shadows.ts`, `wai.ts`) | Either say "code is the spec" in this README or move the simpler ones (`wpm`, `shd`, `wai`) into definitions |
| **Rust and TypeScript copies** | w3e, wtg/wct, wts and lossless text exist twice; `twin-check.mjs` compares w3e and triggers on real maps, `fragment` too. `app/scripts/wts-corpus.mjs` (Rust-vs-TS string pruning on real maps) is not named in `tests/` or TESTING.md | decide whether the gate should run it |
| Formats not in the mini-map | `w3s`, `w3l`, `imp`, `w3f`, all object kinds except `w3u`, `wai`, `wpm` parse checks. `codecs_survive_damaged_files` (hostile rounds) reads only the mini-map, so these definitions get no hostile rounds in the commit tier; the corpus tier's `hostile-seeds.mjs` (game files) may reach some (*unverified*) | Add them to `tests/fixtures/mini-map` (project rule: a new format goes there) |
| Three campaign chapter maps' `war3map.w3i` fall back to raw | rows `raw` in `tests/corpus-baseline.tsv` | find out why the definition or round trip differs (not looked up) |
| Versions never seen | `regions` 7, `lights`, `campaign` v2 and v3, doodads and units 12 and 13 come from the game's 3.0 maps; several fields keep neutral names (see each definition's header) | none, informational |

## The question: "do we have a json for every format we figured out?"

Short answer: no.

- **A JSON definition of the binary layout:** for 10 formats (`w3i`, `doodads`, `units`, `regions`,
  `cameras`, `sounds`, `imports`, `campaign`, `minimap`, `lights`), in this folder. Not for object
  data, terrain, triggers, strings, AI, pathing, shadows, models and images.
- **A JSON form in the project:** for those 10, object data (`w3proj.objects/1`), the trigger tree
  (`w3proj.triggers/1`, plus `.gui.json` files), the split terrain (`w3proj.terrain/1`) and its
  objects. Terrain (flat) is text; strings, pathing, shadows, AI, models, images are raw.
- **A JSON Schema:** for the same 10, in `docs/schemas` (hand-written, tested against the definitions and the
  corpus). Not for object data, triggers or the split terrain.
