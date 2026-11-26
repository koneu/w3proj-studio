# Notes moved out of the open points

Moved on 2026-11-25. These are facts, decisions and limits, not work to do. Dates and branch names are as first written, and the notes were not re-checked when moved.

## Facts and behaviour

- Existing projects keep their raw `war3map.w3i`, `war3map.w3e` and `war3map.wtg` until they're re-synced once.
- `newmap.ts:96` builds a new map's cliff list in CliffTypes.slk order; it agrees with the WE's Ashenvale file and is left as it is.
- The melee start check (meleesave.ts UNKNOWN_REACH): a doodad whose pathing can't be read counts within 768 of a start; the tables name PathTextures\16x12Default.tga, which the game lacks.
- The World Editor's save drops item-table and attribute fields when it writes a subversion-11 .w3m as 9 (the editor's data loss; Studio keeps the fields).
- The World Editor's save drops the item sets of plain doodads (non-destructables, e.g. LPrs) in war3map.doo; Studio keeps them (we-compare barricade-flags, expected difference) (2026-11-25).
- The World Editor refuses to save Invictus (Script Errors, line 1128, unexpected `%`), the original map too: probably the same `%%`/`%*` text issue as WoWR in test.md; not Studio-caused (2026-11-22).
- smoketest_maps/wowr4.6 `GoblinFemale_Portrait.mdx` is truncated at 36864 bytes in the source project (listed as known damaged in classiccheck.test.ts); needs an intact copy of the map if one exists.
- "Try to set up for …" depends on where clients keep their data: Claude Desktop's Store version moved it twice already, to %LOCALAPPDATA%\Claude-Data\claude_* so far.
- GoldRush's picture is bound by read throughput (about 575 MB of models and textures at 150–180 MB/s); model → texture reads chain by nature. Backend `game_read` does a blocking CASC read inside an async command (ties a runtime worker; `spawn_blocking` may help, not measured).
- `w3proj rebuild` internals (`cli-rebuild`, 2026-11-13): in a checkout every run bundles app/src/headless with esbuild (~1 s) into target/headless/w3proj-headless-<hash>.mjs (old bundles are pruned after 10 min, app/scripts/headless-prune.mjs); the Rust side answers the host's commands one at a time (fine for GoldRush: 5.5 s); the Rust integration test (crates/cli/tests/rebuild.rs) skips without a game, so in CI only its no-game and bad-argument cases run; game_resolve_many's loop exists in the Tauri command and in rebuild.rs (small, not in crates/backend).
- The editor's camera height is smoothed ground (a cliff 250 units away moves the picture 22 px); app-drive's `--camera we:` takes the ground height at the shifted target (index.ts ~4906 lookAt), so comparisons on uneven ground drift (a 256-deep pit shows larger in the editor).
- The editor caches lighting models by file name inside one process: a light variant needs its own we-drive run or its own GUID name.

## Decisions and behaviour by design

- JassHelper runs in the game's Wine prefix (design; README 'Linux' says so), next to the Proton services the app starts there (wineserver, explorer, xalia, services). Untested: a game and a JassHelper run at the same time in that prefix.
- Undo across restarts: decided 2026-11-21 to keep undo session-only (in-memory, up to 30 steps); no undo history on disk. Hot exit covers unsaved edits and checkpoints cover macro rollbacks (`set_tileset` and `resize_map` take checkpoints).
- Checkpoints extension off: `invalid.ts`, `w3ofiles.ts`, `soundfiles.ts` and the MCP server depend on it. Delete Invalid Objects and Replace Internal Sound rely on checkpoints, not a one-step undo. Decided (2026-11-08): go on without the checkpoints extension, with a one-time warning that no checkpoint is made.
- Test Map asks for the Battle.net login on every launch: the World Editor inherits Battle.net's session (Battle.net starts it) and passes it to the game. Without Battle.net starting this app there's no session to hand over. Out of scope; the login itself is in `user.md`.
- Add To Map isn't an undo step: Ctrl+Z after it doesn't remove the script or the import (it writes directly, `ai-editor/index.ts` addToMap; round 3 p4, hidden app, 2026-11-13). By design per the code, but if undo was meant to cover it, it fails. (Undo does remove a .w3a custom-data import.)
- unitprops.ts save-time validation (lines ~373 and ~421) still allows a drop chance of 0..100 on purpose (a stored 0 must keep saving); the typed edit clamps to 1..100. Decide if the validation should be stricter (2026-11-22).
- `--shot`'s fixed sleeps and the built-in 300 ms waits after click and key remain.

## Working notes: tests, tooling and agents

- One-off scripts (`node -e` and the like) must run under a timeout: a leftover one from a deleted worktree (reading tests/fixtures/water-brush/ash-shallow.w3e) ran at 150% CPU for 6.4 hours, slowing every gate and keeping its agent waiting on its own background work (killed 2026-11-16 18:09).
- Implementers must make file edits with Edit/Write, not one-off python or sed scripts (several slips reported, 2026-11-17).
- Parallel gates and agents reached memory exhaustion once (a gate was killed with exit 137). Consider running at most one gate at a time, and `gate --jobs=4`.
- Gate output: agents twice wrote a stray gate log into the read-only Warcraft III folder through a wrong relative path (both removed). Keep gate output in the worktree or $TEMP, by absolute path.
- we-compare specs queue behind other WE runs (one waited over 900 s for the lock) (sound-order-we 2026-11-14).
- we-compare 'the save didn't finish' on the first map after another agent's editor session (seen 4 times; once a 'Sound Editor' window); the spec needs a re-run.
- we-drive repeated clicks on one pixel with `--move`: the editor's cliff stamp spreads irregularly after about 10 clicks, so such specs are only reproducible per click sequence (2026-11-15).
- we-compare: the ramp drags' Studio side (moves 75 ms apart) fails at frame caps below 10; keep we-drive's frame cap at 10 or above for drag specs.
- we-drive's settle intervals (1000 ms HD, 200 ms SD) assume at least 2 frames a second: tie them to `--frame-cap` if a cap below 10 is ever used.
- A new hard-coded trigger function name in the Trigger Editor or script generator must also be added to `NEEDED` in `app/src/demo/gamedata.test.ts` (and the demo's TriggerData.txt); no automatic grep finds them (the test covers the current set, the sample map's names and the parser's shape).
- map-roundtrip-checker's stored-vs-regenerated wpm comparison on ramp tiles is uninformative (no tile rules, stamps or margins). Not a result.
- Note for ui-smoke: its synthetic key events must bubble (the Object Editor file picker's keys now sit on its dialog; a non-bubbling Escape hung the smoke for 400+ s).
- The older `ls`/`formats` closed-pipe test is timing dependent. The verify tests (incl. `verify --update-baseline` and a failing verify with a closed pipe) are the deterministic ones.

## Known unknowns: nothing can measure these yet

- no Pathing brush size in the WE palette (the Terrain palette is clipped under Shape: Circle and shows no pathing brush). The Pathing brush's size against the WE: not compared (not reachable in the WE palette); the other brushes' sizes were measured. Round 4 idea: its size may be in the prefix's registry (Tool Windows Reforged); not tried. [from: Terrain viewer]
- the editor's rendered mesh heights (no height map in the editor). The ramp-lift rule matches the WE beyond the synthetic and 4-map data (mesh heights not compared). [from: Terrain/doodad editing]
- View Selection's order for mixed doodads and units at equal x (the WE's d and u modes select only doodads or only units, so no mixed set is reachable; the `verify3-p8a-diffs` branch holds the order, not merged). [from: Terrain viewer]
- the Campaign Editor's campaign properties (no step opens that dialog yet). Campaign picture dropdown: the names offered and whether the path is stored with or without the extension, against the WE's campaign properties (no step opens that dialog yet). [from: Batch merged 2026-11-12]
- the WE's way to copy ground (not found yet). Copying and pasting ground under `custom-tilesets 0` in the WE keeps the look of Studio's fragment.ts groundOf (the WE's way to copy ground wasn't found). [from: Ground tile names under custom-tilesets 0]
- a keyed dialogue sound in the Sound Editor (Sound Properties has no dialogue or speaker fields). `unknown2` 0 on dialogue sounds: the WE's Sound Editor can't make a keyed dialogue sound (Sound Properties has no dialogue or speaker fields); needs another way in, and so does the keyless speaker-name numbering. [from: From verification round 4]
- a WE dialog that shows the doo v13 `preFlags` field (none does). The doo v13 `preFlags` field: its meaning (no WE dialog shows it; 0 and 7 are kept). [from: we tools review]
- a minimap compare that reads one dot's colour (the we-compare minimap kind reads 16-pixel blocks). The saved minimap's grey dot (183) for a doodad whose model only `_DE.w3mod` has, in HD (`minimapBase` leaves `_DE` out in HD, as the export does): proven by unit test only, since no block-level we-compare can see one dot's colour. [from: we tools review]
- fields for cone angles and outside-cone volume in Sound Properties (there are none). Sound cone angles 0..360 and outside-cone volume -1..127 are unproven: the WE's Sound Properties has no fields for them; music dialog limits not measured. [from: World Editor round 2]
- hour keys in the Light Editor (it has none). Lighting key hour 0..24 not compared (the Light Editor has no hour keys). [from: World Editor round 2]
- the editor's ground height under a unit (no height map in the editor). Art - Elevation - Sample Points 3 (siege engines hmtt/hrtt, nccd…): the editor's ground rule is neither evenly spread points nor a triangle, mean or max; Studio keeps a 32 tolerance (objheights.ts unitGround).
- the editor's ground height under a unit (no height map in the editor). Ground under units: building/unit save rule (sample points, building on the highest point 16 × Scaling Value from its centre) fits 2019 objects; check once by eye in a Studio-saved map opened in the WE.
- writing a `_HD.w3mod\` import through the editor (Import File and Import Files put the file at war3mapImported\, Mode SD; Modify File Properties' Full Path can't reach the prefix, but its Mode list changes it: `docs/testing/saved-data-rules.md` "Asset Manager"). Never click the Asset Manager's File menu Test Map (Ctrl+F9). [from: we tools review]
- we-compare has no campaign or chapter input, so "Edit a Copy in This Map" (campaign object edited in a chapter, saved as a copy in war3map.w3u plus the skin file) cannot be compared file against file with the editor; needs a spec type that drives the Campaign Editor (F7, open the .w3n, open the chapter, Object Editor, edit a campaign unit) with measured coordinates (xc, 2026-11-22).
- Not reached in we-batch-3, left in test.md as they are: Skin fields, the _HD.w3mod import dialog, drop chance and numeric field limits, the drop-table random item, the hfoo Value tab, vJASS/JassHelper, AI hero chances and meanings, campaign items.
- Map Properties > Prefs 'External Custom Data Source' isn't measured (its key needs the editor's file dialog).
