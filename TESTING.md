# Testing

How this project is tested, why, and what to do before committing or releasing.

## Short answers

| Question | Answer |
|---|---|
| Unit tests? | **Yes, for pure logic:** parsers, terrain math, script generation. Not for DOM-heavy editors, where they cost a lot and prove little. |
| System tests? | **Yes, and they matter most.** The product's promise is end to end: a map goes through the app and comes back correct. |
| Measure coverage? | **Yes, as a map of what nothing has ever run.** Floors guard the logic layers. There is no global target, and a high number proves little (see below). |
| Anything else? | **Hostile-input tests** (maps come from strangers), **real maps as test data**, and now and then **mutation testing** on the critical files. |

## What can go wrong, worst first

Tests are worth writing in this order, because this is the order of the damage.

1. **A map is silently damaged.** Someone's months of work are lost, possibly noticed much later.
2. **A map from the internet crashes or hangs the app.** Parsers read untrusted bytes.
3. **A map the app saves doesn't work in the game or World Editor.** This is the primary goal, and
   the hardest thing to test.
4. **A feature breaks unnoticed.** A panel stops opening, an extension stops loading.
5. **Something looks wrong.** Annoying, cheap to spot, cheap to fix.

## The layers

Each layer has an *oracle*: what decides that the answer is right. A test without a trustworthy
oracle only proves the code does what the code does.

| Layer | Oracle | Where | Runs |
|---|---|---|---|
| Static | compilers, clippy, module boundaries; every tooling script loads (`node --check`) and app-smoke's `--only` map names the same checks as its full run | `npm run check` (`scripts/check-scripts.mjs`), clippy | every commit, CI |
| Unit | known answers, round trips | `#[test]`, `src/**/*.test.ts` | every commit, CI |
| System | the map's own bytes: pack → unpack → pack is identical | `crates/cli/tests/` on `tests/fixtures/mini-map` | every commit, CI |
| Hostile input | never panics; what parses still round-trips | `crates/w3proj/tests/robustness.rs`, `wtg_hostile.rs` | every commit (200 rounds), corpus tier (20,000) |
| Hostile input, app | damaged files neither hang the app nor use up its memory, under a watchdog that kills a stuck parser | `app/src/lib/hostile.test.ts`, `app/scripts/hostile-seeds.mjs` | every commit (made-up files), corpus tier (the game's files) |
| Random maps | the JASS and Lua checkers on every generated script | `app/src/lib/script/random-maps.test.ts` | every commit, CI |
| UI smoke | the app's own error reports | `app/scripts/ui-smoke.mjs` | every commit, CI |
| Real app | the map it packs is the CLI's, byte for byte; nothing changes without an edit | `app/scripts/app-smoke.mjs` | locally, before merging |
| Corpus | real maps, and the baseline of which codec reads what; a map's whole ground through a fragment gives the same file | `w3proj verify`, `twin-check.mjs` | locally, before merging |
| Generated script | the World Editor's own `war3map.j` on the game's 326 JASS maps | `app/scripts/script-check/run.mjs`, `tests/script-baseline.json` | locally, before merging |
| The real thing | the game and World Editor | the release checklist below | by hand, before a release |

The top of the table is fast and runs everywhere; the bottom is slow and only runs here, because
real maps and game files can't go into the repository.

## Running it

```sh
node tests/gate.mjs            # before every commit: about 30 s once built
node tests/gate.mjs coverage   # against the floors (needs cargo-llvm-cov)
node tests/gate.mjs corpus     # real maps and the game: about 8 minutes (the app smoke test's two halves set the pace)
node tests/gate.mjs batch      # commit and corpus in one run, for a merge batch: they overlap
node tests/gate.mjs all        # all of it: before merging to master
```

The gate runs every step even after a failure and prints one table. Its exit code is the answer:
**a check that can't run fails**, so green always means it ran. That rule exists because the
easy mistakes here look like success: `check | tail; echo $?` reports `tail`'s exit code, and two
coverage tools reported numbers for tests they hadn't measured. The last line is
`GATE_EXIT=<code>`, so the answer survives a pipe.

**Steps run side by side.** Steps that don't need each other run together (about twice the cores' worth;
`--jobs=<n>` changes that, `--serial` goes one at a time in the table's order). What one needs
from another is written down in `tests/gate.mjs`: the release CLI comes before everything that runs
it, one cargo command works in `target/` at a time, and the smoke tests, which rebuild `app/dist`
(every build of the Tauri crate reads it), take turns with the cargo steps that build it. The real-app
smoke test builds first, and the rest of the gate waits for that build, not for the whole test. Steps
queue for a lock in the order they became ready: once the UI smoke test waits to rebuild `app/dist`,
no step that comes later starts building against it first (`tests/gate-scheduler.mjs`, with its
tests in `app/scripts/gate-scheduler.test.mjs`). A step whose prerequisite
failed fails without running.

**The real-app smoke test runs as two apps at once** in the corpus tier: `app-smoke.mjs --part=1/2` builds the app,
then runs the project checks and the first half of the full run's checks (`firstHalf`, newMaps to unitProperties);
`--part=2/2 --no-build` starts once that build is done (part 1's `Built application at`) and runs the second half
(`secondHalf`, itemTablesAccess to contextLoss) on the same build. Each part has its own folder
(`target/app-smoke-part<n>`, or `W3_SMOKE_DIR` with `-part<n>`), its settings in it (the app reads
`W3PROJ_CONFIG_DIR`, since both have the build's identifier; app-smoke stops when the app doesn't say it listened),
and its own Xvfb display and WebDriver ports (Linux; a driver that loses the race for a display starts again) or
DevTools port and WebView2 folder (Windows). The halves keep the full run's order, so a check that relies on what an
earlier one left stays behind it (testMapWithoutGame on the map objectsWhileOpening left open); every check of the
second half also runs alone (`--only`). They are balanced by the times each check prints (`took X s: <check>`):
about 6 minutes each once built (the batch tier went from about 15 minutes to 8 on an idle machine). To run one half by hand: `node scripts/app-smoke.mjs --part=1/2` (in `app/`), or
`--part=2/2` (it builds unless `--no-build`: not while part 1 builds). A plain `node scripts/app-smoke.mjs` still
runs everything in one app.

**A page call has a time limit of its own** (app-smoke: `page.evaluate`, `mcpTool`): 60 s unless it gives one
(`page.evaluate(expr, { timeout })`, `tool(name, args, { timeout })`; `W3_SMOKE_CALL_TIMEOUT` in ms changes the
default). One that hangs fails with `page call timed out after … s: <the call>` instead of holding the run until
WebDriver gives up; a call that took more than half its limit prints `slow page call: …` on stderr. On Linux the
session's script timeout is set to just past the call's limit, since WebDriver runs a session's commands one at a time.

Each step's output goes to `target/gate-logs/<tier>-<pid>/<step>.log`; the
gate prints it, or its end and the path, when the step finishes. Times in the table are wall time,
so they grow when steps compete for the cores.

**Rust coverage is built in one folder for all worktrees** (`target/llvm-cov-shared` of the main
checkout, or `W3PROJ_COV_TARGET_DIR`), so the dependencies are compiled once, not once per worktree.
`cargo llvm-cov` collects every `.profraw` in its folder, so gates from different worktrees take
turns on it through a lock folder next to it (`llvm-cov-shared.lock`): the second gate's coverage
step says it is waiting, and takes the lock over if the first gate's process has gone.

**The hostile-input watchdog counts processor time**, not the clock (`hostile.test.ts`): a worker's
second thread reports the process's processor time, and a file that uses more than 4 s of it is
killed and reported. With several gates on the machine a worker is held back for seconds at a time,
and a clock would call that a hang; a parser stuck in a loop still burns the 4 s. The count starts
when the worker is ready, so its start-up isn't charged to the first file. A file that takes 2
minutes on the clock is killed too: that catches a parser blocked without working.

A worker that stops by itself is reported with its exit code and the end of its stderr. Its reports wait
while the pipe to the test is full: a plain write failed then (EAGAIN) under other gates, and the corpus
tier reported that as files that crashed it.

**`w3proj verify` over a folder** checks maps on all cores (`W3PROJ_VERIFY_JOBS=1` for one at a
time), but prints in the order of the files. Projects in the folder (folders holding `w3proj.toml`) are
left out with what they packed (`build/`, checkpoints): outputs, not maps of their own. **A hostile-input failure** names its seed; run it
alone with `W3PROJ_ROBUSTNESS_SEED=<n>`.

Parts of it: `npm test`, `cargo test`, `npm run coverage`, `npm run ui-smoke`. Rounds of the
hostile-input tests are set with `W3PROJ_ROBUSTNESS_ROUNDS`. The corpus tier finds its maps with
`W3PROJ_CORPUS` and the game with `W3PROJ_GAME`.

## Tools: look before writing a scratch script

These exist so a session doesn't write the same one-off script again. Use them, and extend them when one
falls short, rather than copying their insides into a scratch file.

| To… | Use |
|---|---|
| run one TypeScript test file | `npm test -- src/lib/undo.test.ts` (in `app/`; other arguments go to node, e.g. `--test-name-pattern=…`) |
| show a test fails without the fix | `node scripts/fails-without.mjs <test> <changed source files…>` (in `app/`): passes as is, fails with those files as on `dev` (`--base`), files put back. Exit 3 means the old code merely didn't build: weak evidence. Rust: `--run "cargo test -p <crate> <name>"`, and `--keep-rust-tests` when the tests are in the changed file (every `#[cfg(…test…)] mod <name>` stays the new one) |
| look at the app, ask it something | `node scripts/app-drive.mjs <steps>` (in `app/`): the hidden smoke app (Xvfb on Linux), `--map`/`--project` (a copy), `--terrain`, `--camera game`, `--camera we[:x,y,…]` (the World Editor's view), `--view-size 1184x844`, `--compare-ready lit\|unlit`, `--look x,y`, `--shot file.png`, `--mcp tool={…}`, `--command id`, `--eval "…"` (an expression, statements, or statements that `return`), `--key Ctrl+Shift+Z` (a chord into the page: over WebDriver on Linux, so WebKitGTK's own key events come out), `--frame-cost ms` (CPU time per terrain frame: all, poses, particles, HD water's depth picture). Steps run in order; the list is at the top of the file |
| compare two pictures | `node scripts/pic-compare.mjs a.png b.png` (in `app/`): mean colour per region in both, their difference, the mean absolute difference of the pixels; `--region [name=]x,y,w,h`, `--sample` (whole and a 3x3 grid), `--diff d.png`, `--tolerance T` (exit 1 when a region's difference is above it, 2 when the pictures can't be compared). Plain JavaScript, no Pillow |
| run the real-app smoke test, or one check of it | `node scripts/app-smoke.mjs [--only=<check>]` (in `app/`): builds what it needs, the release CLI too; `--part=1/2` / `--part=2/2` runs one half (see "Running it") |
| read the game's files | `w3proj game cat Units/UnitData.slk`, `game ls <filter>`, `game resolve <path>` |
| make a project's pathing, shadows, minimap and script as the app does, without it | `w3proj rebuild <project> [--only=wpm,shd,minimap,script] [--force]` (`--force` also replaces a script Studio didn't write last): the app's own code in Node (`app/src/headless`); app-smoke's `rebuildCli` holds its bytes against the app's |
| Studio's minimap of a map to hold against the editor's Export Minimap | `node scripts/minimap-studio.mjs MAP.w3x OUT.blp [--mode sd\|hd] [--set terrain.minimap.groundNoise=0] [--keep DIR]` (in `app/`): unpacks, rebuilds the minimap with this checkout's code (JPEG quality 100), copies the BLP; `--set …groundNoise=0` leaves the grain out so shapes can be counted (`minimap-diff.mjs`, then the editor's TGA against it) |
| look up a game table's rows | `w3proj game slk Units/UnitData.slk hfoo hbot --col unitID,movetp` (tab-separated, header first) |
| see how the open points burn down | `node scripts/openpoints-burndown.mjs` (repo root): reads `openpoints/*.md` (an open point is a `- [ ] ` line plus its indented lines; leading `[tag]`s such as `[game]`, `[windows]`, `[we]`, `[eye]`, `[extra]` become `tags`), writes `openpoints/openpoints.json` (every point with file, section, tags, text, a stable id), adds an entry to `openpoints/burndown.json` (per file, plus three lines: to build / to prove by agents / waiting for the user, primary vs `[extra]`, and per snapshot how many ids opened, closed or were edited) and `openpoints/burndown-ids.json` (the ids: first snapshot, then the deltas; a vanished id with a new one of at least 80% similar text is an edit), and writes `openpoints/burndown.html` (chart, tiles, per-day table; data inside, opens from disk). `--dry-run` prints the counts, `--no-entry` refreshes without an entry. The open points stay local; only the script is in git |
| apply testers' verdicts to the open points | `node scripts/openpoints-close.mjs <verdicts-file> [--dry-run]` (repo root): lines `<id>: PASS \| FAIL \| DIFFERS \| NOT DONE — <text>`. PASS removes the item block; FAIL/DIFFERS add a one-line item to `bugs.md` "From verification" pointing at the old one; NOT DONE adds `(not done: reason, date)`, the second moves the item to `user.md` (game/Windows/user) or `onhold.md`. Unknown ids refuse the whole run; changed files are copied to `openpoints/.backup/<timestamp>/` first. Tested in `app/scripts/openpoints.test.mjs` |
| see how well the app's pathing (war3map.wpm) matches the maps' own | `node scripts/wpm-compare.mjs [maps or folders] [--map NAME] [--cells N] [--save F] [--baseline F]` (in `app/`): regenerates each map's wpm with `buildPathingMap` (what a save runs) and diffs it with the stored file: exact or differing cells per map and a total. Default `smoketest_maps`; give the downloaded ladder folders for the large set. `--cells N` lists differing cells (x,y, tile, stored->regenerated), `--save` writes the result, `--baseline` reports maps that got better or worse (exit 1 if worse). Unpacked maps are cached in the temp folder |
| check the save's Melee-flag rule against the game's maps | `node scripts/melee-corpus.mjs [--filter TEXT] [--why] [--save F] [--baseline F]` (in `app/`): clears each game map's Melee flag and runs `savedMelee` (meleesave.ts); a map stored melee should get it back, others not. `--why` names the reasons for each miss, `--baseline` lists maps whose result changed (exit 1 if an agreement was lost) |
| look at the real World Editor (Linux, **local only**) | `node scripts/we-drive.mjs <steps>` (in `app/`): `--map`, `--wait-ready`, `--compare-ready`, `--compare-ready-unlit`, `--look x,y[,distance…]\|center`, `--shot`, `--shot-window`, `--shot-screen`, `--clipboard FILE` (the editor's clipboard text, which Wine hands to X with LF line ends whatever the editor put in), `--key KEY[@MS]` (@MS holds it), `--click X,Y`, `--double-click X,Y`, `--drag X,Y:X,Y[@MS]` (with `--drag-mod alt|shift|ctrl` or `--drag-button 2|3` before it), `--move X,Y`, `--wheel N[@X,Y]`, `--windows`, `--close-modules`, `--view-menu`, `--view Lighting=off`, `--game-view on\|off\|status`, `--fps ms`, `--open FILE` (opens a map in the running editor: Ctrl+O, the copy's row in the editor's Open list; `--map` on a running editor does this, restarting if it fails; "via" in the step's line says which), `--save FILE` (Ctrl+S, the default-name reminder answered, the saved map copied to FILE), `--export-minimap FILE` (File > Export Minimap with the dialog's defaults, the TGA copied to FILE), `--type TEXT` (into the open dialog; printable ASCII only), `--campaign FILE` (a copy of the .w3n where the Campaign Editor's Open dialog lists it: F7, Ctrl+O, `--type` its bare file name, Return; the dialog refuses `/` and `:`), `--numlock on\|off\|status` (Num Lock as the X server holds it: pressed only when it differs), `--close`; options `--screen WxH` (another view size), `--mode sd\|hd\|de`, `--day-night fixed\|cycle` (fixed by default), `--timeout S`, `--work DIR`, `--save-accept T1,T2`, `--keep-prefs`, `--null-audio` (Wine's ALSA driver on with ALSA's config a lone null device: the editor has an audio device that plays nowhere, so File > Preferences opens; nothing else is let near the sound hardware), `--pref Section/Key=value` (see "Preferences"), `--expect-layout` (`--wait-ready` fails when the main window or tool palette isn't where spec clicks were measured), `--looks-every-map` (every `--map`/`--open` gets the run's `--look` cameras, not only the first: look n is row n in each). An unknown or malformed argument is refused before anything starts. Needs the install's English text (enUS in `.build.info`), else it says so and starts nothing. `--look` waits until two pictures a frame apart are the same (at most 10 s). The list is at the top of the file; setting up and the proof that nothing of the user's changed: `scripts/we-setup.mjs` |
| run a built binary that may be older than its sources | `tests/binfresh.mjs` refuses a `w3proj` or app binary older than a tracked source it is built from (CLI: `crates/`, Cargo files; app: also `app/src-tauri`, `app/src`, `index.html`, the vite/TS configs, the npm packages), as we-compare and the `make-*.mjs` generators use them: rebuild, or pass `--allow-stale` (where the tool parses its own flags) / `W3_ALLOW_STALE=1`. mtimes are compared, so a fresh checkout refuses a binary built before it |

The game folder: `W3PROJ_GAME`, else `.game-path` in the checkout (written by `scripts/setup-linux.sh` and
`scripts/setup-windows.bat`; one folder per line after `#` comments, the first that exists counts, so a checkout
shared by a Windows and a Linux machine lists both), else the folder above the checkout (the Windows layout).
The CLI reads `W3PROJ_GAME` too. The smoke app's identifier is one per checkout (`W3_SMOKE_ID` overrides it), so
runs in two worktrees don't share settings; none of these tools starts the game or the World Editor, except
`we-drive.mjs`, which starts the World Editor only.

### The real World Editor: we-drive.mjs

- **Dragging**: `--drag X,Y:X,Y[@MS]` presses the left button, moves in 20 steps over MS (400) and lets go; `--drag-mod alt` holds a key during the next drag. Measured (TerenasStand_LV, doodad layer `--key d`, a tree clicked, 800 ms): a plain drag of the selected tree changes nothing in war3map.doo (it is a box select), Alt+drag moves it (editor id 1224, (320, -576) to (576, -768)), the only change in 1680 doodads.
- **Moving objects at the edges** (branch we-drag-checks, 2026-11-13, SD, copies of the empty 64x64 map: camera bounds
  right at 2816, playable part 3328, map 4096; scripts and saves in `target/evidence/we-drag-checks/` of the main
  checkout). A plain drag that starts on a selected object moves it (a doodad by `--key d`, a unit by `--key u`; the
  first click must hit the model: a footman's feet miss, 10 px higher hits); Alt+drag moves a unit's centre to the
  pointer. The nudge is Edit > Nudge Selection: the number pad (`--numlock on`, then `--key KP_6`; without Num
  Lock the keys arrive as arrows and do nothing; a blind `--key Num_Lock` toggles whatever the spec before left, since the X server keeps the lock while an editor is connected), 64 a step for a tree, 8 for a doodad without pathing and a footman.
  Measured again in nudge-turn-we (target/evidence/nudge-turn-we): the nudge is 64 for a tree (LTlt) and a farm (hhou), 8
  for a doodad without pathing (LPcr) and a footman; the diagonals KP_7 9 1 3 move both axes the whole step (a tree:
  -64/+64, +64/+64, -64/-64, +64/-64); KP_Divide turns a selection 5 degrees left, KP_Multiply 5 right. Studio:
  selectionkeys.ts (NUDGE 8, TURN 5), doodadedit.ts GRID_NUDGE_STEPS.
  The editor takes the drag's second-to-last motion step (a footman dragged 576 in 20 steps moved 547). Found: with
  Enforce Camera Bounds on (and off alike) drags and nudges go past the camera bounds; a unit stops with its collision
  size or half its footprint inside the playable part (footman, collision 31: 3296; farm, 4x4 cells: 3264); a doodad
  goes past the playable part and stops with its centre strictly inside the map (tree and a 12x12 LZth 4032 on 64
  steps, a pathless LPcr 4088 on 8 steps). A step that would pass the limit is refused, the object stays at the last step that
  fits (spec edge-last-step: footman 3296, farm 3264, tree 4032, LPcr 4088; selected one at a time here, groups below; a box select of the lower objects needs a box 200 px wide). The camera too scrolls past the camera bounds with the switch on. Studio:
  limits.ts `insetBy`, terrain-viewer `moveBounds`; app-smoke heightsLimits.
  Groups and diagonals at the edge (branch edge-group-nudge-we, 2026-11-14; spec edge-group-nudge, whose first spec
  switches Num Lock on for the file, so run it whole): the editor's d mode selects only doodads and u only units, so a
  doodad and a unit are never one group. A group nudges all by the longest step (tree + pathless LPcr: both 64, a
  footman + farm: both 64) and is refused whole when any member's step would pass its limit (tree 4032 with LPcr 4032;
  footman 3264 with the farm 3200, not 3296 and 3264). In about 3 of 12 first runs of an editor a group stepped 8
  instead (the tree stayed, LPcr went to 4088): not explained. A diagonal (KP_9) at the east edge moves nothing, the
  free axis too, for one object and for a group. A tree dragged past the edge stops on the grid inside it (4032, 3968
  or 3904 in different runs: the last motion that fits varies), never on 4096; the unit and group drags didn't press
  reliably, so no drag spec. Studio: limits.ts `scaledNudge`, moveedit.ts `refuseShift` with `settle`.
- **Enforce Camera Bounds** (Advanced menu, Ctrl+Shift+B: `--click 260,41`, `--click 310,411`; branch camera-bounds-we,
  2026-11-14, SD, `tests/fixtures/we-compare/camera-bounds.w3m`: the empty 64x64 map, camera bounds x ±2816, y -3328..2816,
  playable part to 3328, map to 4096; scripts, pictures and saves in `target/evidence/camera-bounds-we/` of that
  worktree). The switch is about camera objects only: with it on, the camera palette's Create Camera and Set Camera To
  Current View refuse a view whose target is outside the camera bounds with an "Error" box, "The current camera position
  is outside of the world camera bounds." (refused at 3000, 0; 2820, 0; 4096, 0; 0, 2900 with the eye inside; made at
  2816, 0; 2700, 0; 0, -3000 with the eye south of the map); off, all are made (specs `camera-bounds-create`,
  `camera-bounds-create-off`). Camera Properties puts a Target X typed past the bound on it without a word (3100 became
  2816; off it stayed 3100: spec `camera-bounds-typed`), and a camera dragged by its model (View > Camera Objects on, a
  click on bare ground first) from 2700 to 3117.1 with the switch off stopped at 2805.0 with it on, the last step short
  of the bound (2784.3 in a quicker drag: no spec, the steps the editor sees vary).
  Everything else is the same on and off: a paste past the bounds is placed (a footman at
  3070.8, 0, an LPcr at 3072.2, -510.5; spec `camera-bounds-paste`), objects already past them stay through a save, a
  unit pasted or nudged past the playable part is refused either way (footman stays at 3296), and the view: the arrow
  keys stop with the camera target on the map's edge (4096.0 right, 4096.0 up; after V for game view too, its state not read back), a right-button drag
  pans past the bounds (the middle button pans nothing), and a minimap click, View Entire Map and 20 wheel notches out
  give the same pictures (mean difference at most 0.06). Unit and Doodad Properties have no X or Y to type. The camera
  palette (`--key m`): Create Camera 1476,80, Create Free Camera 1476,100, View Selected Camera 1476,119, Set Camera To
  Current View 1476,139, rows from 1396,177 (13 px each); a button wants a click on the palette first (a row), and the
  arrow keys want the pointer over the view (`--move`). The status bar's Point reads the ground under the pointer; with
  the opening camera's angles at distance 3000 the pointer at 748,404 is the camera target, 300,404 is 1153.1 west of
  it, 748,750 is 927.8 south (how the target was read where the bar is empty off the map). Camera Properties (a row,
  Return) has Target X at 709,328 and OK at 684,727 of the display. A run that closed the editor with a module window
  open (the Sound Editor) leaves it over the next run's view in the shared farm; `--wait-ready` closes it (below, "A module window the editor reopens"). Studio: lib/terrain/cameras.ts `viewInCameraBounds`, `targetInCameraBounds`, wheelzoom.ts `heldPan`;
  app-smoke heightsLimits.
- **Projection for clicks**: with `--look X,Y,D` (angle 304, fov 70, rotation 90) a ground point maps to the display
  through TESTING's Studio-equivalent camera (target y - 0.0993 D, distance 0.9127 D, pitch 57.2, vertical fov 41.06,
  the view at 156,79): the status bar read (3713.9, 515.4) where (3712, 512) was aimed (`proj.py` in that folder).
- **Picking a doodad** (branch doodad-pick-we, 2026-11-16, SD; spec `doodad-pick-we`, input and steps by
  `tests/fixtures/we-compare/make-doodad-pick-input.mjs`, whose `project` is the formula above): a click on bare flat
  ground, then Delete, on a tree LTlt, a rock LRrk (4x4 pathing) and a rune XOmr (2x2), 0 and 30, 45, 60, 80, 100, 130
  units from the centre towards E, W, N, S, from a view of 2000 (the editor snaps what it opens: 64, the rune 32 further,
  so the input stands on those). The editor picks where the model is on the screen, not by the footprint: tree hit to 60
  all round (W80 too, E80 no), rock to 80 all round, rune 30 (45 on one side); north (above the foot, the model's height)
  tree and rock 130, rune 100, none of them south or beside at 100. Studio's footprint cylinder (radius 32, 64, 32) missed
  the rock at E80 and W80, the tree at W80 and picked the rune at S30. Now (`renderer.ts` pickObject, `meshpick.ts`): the
  model's triangles inside its bounding sphere and box, and the cylinder besides. Studio's table with the clicks put where
  Studio's own camera shows the ground (`clickGround`: its 3D view isn't the editor's) agrees on 69 of 75 (before 66):
  tree S60, S80, rock S60, rune S30, E45, N80 differ (the rock's and the tree's S60 also under the old rule: a click
  there misses in Studio's frame; the rune is a thin model). Only mesh (no cylinder): rune 20 of 25, tree and rock 24.
- **Looks against Studio, branch we-compare-5** (2026-11-18; pictures, no spec; the maps were made from
  edge-last-step.w3m with the release CLI, unpack, JSON, pack). **Building ground marks**: farm (HSMA), town hall (HTOW),
  barracks (HMED), orc barracks (OMED) on flat ground, SD, `--view Shadows=off`, `--look x,y,1200`, each picture against
  one of the same map without the buildings (changed pixels over 30): the marks' widths and south edges in the editor and
  in Studio (`app-drive --set 'game.graphicsMode="sd"' --set terrain.shadows.visible=false --compare-ready lit`) within
  1 to 12 px (town hall 385-776 against 388-783, barracks 440-749 both, south edges within 2 px): UberSplatData's Scale is
  half the square's side (splats.ts). A placed building's own scale (war3mapUnits.doo, 0.2) changes neither model nor mark
  in either. **Fog from the eye** (map 02c, linear 500 to 2200, `--compare-ready`, `--look 0,0,D`): the editor's game view
  closes the fog in as the camera goes out, as Studio's (`--compare-ready game`): mean difference over the view's top
  half 11.7 / 12.0 / 9.3 / 1.6 / 1.6 at D 800 / 1200 / 1650 / 2500 / 3500, all fog colour from 3500 on; at 5000 the
  editor's ground ends a third down the view (black above, the sky's edge drawn), Studio's is fog. **Rain** (a region
  over the map with RLhr, angx and angy 10): the editor's streaks are vertical in the world (from a camera 15 degrees down
  they spread out from the middle; near it upright), Studio's all lean about 14 degrees one way (weather.ts tiltOf); the
  editor's are thin and bright, Studio's wider and fainter; with the camera at 3000 instead of 1650 the editor shows a
  fifth of the streak pixels (233 against 1090), Studio as many (its box grows with the view, weather.ts viewBox).
  Ember rain (VWeo, angx -50) and wind (WOcw, WNcw) didn't show a direction in stills. **View Selection keys** (Edit >
  View Selection with a unit selected): Cycle Main View Next ~, Previous Shift+~, View In Object Manager F1 (opens the
  Object Manager on Units, the type's row opened down to the object), View In Object Editor Ctrl+F1 (opens the Object
  Editor), Select In Tool Palette Ctrl+P (the palette's type becomes the unit's, "Brush: Units - Farm", nothing
  selected). Studio binds the three in the terrain view (extension.json; commands.test.ts, app-smoke newMaps' view
  commands). **Camera objects** (View > Camera Objects on, a camera seen from another): the editor draws a camera model,
  a line from it to the target and a small box at the target, no field-of-view cone; Studio's marker
  (cameras.ts cameraMarkers: arrowhead on the target, shaft, camera) has the same parts. **Unit looks** (HD, game view):
  a footman placed with the knight's skin is a knight in both; a footman with a stored colour 5 is in the owner's red in
  both; a custom footman with Allow Custom Team Color (utcc 1) and colour 5 is orange in both; a custom footman with
  Tinting Color 255, 40, 40 (uclr, uclg, uclb) is all red in the editor and untinted in Studio (no object tint is drawn).

- **Branch we-compare-6** (2026-11-18, SD). **Number pad with nothing selected** (flat.w3x, pointer over the view, `--numlock
  on`): KP_6, KP_8, Ctrl+KP_2/4/8 leave the picture as it was (mean difference under 1.1, the start ring's animation);
  with Num Lock off KP_6 pans and Ctrl+KP_8 zooms (they are the arrows). Studio's numpad camera bindings are gone
  (extension.json; viewmodes.test.ts). A module window left open when a run closes the editor (F6) comes back black over
  the view in every later run until one closes the editor without it: `--close-modules` before `--close`. **Object
  lists**: the Object Editor's tree (widened by `--drag 304,500:1100,500`) shows "Circle of Power (medium)", "Dimensional
  Gate (facing southeast)", "Repair (Human)": name, a space, the suffix (objectinfo.ts `labelWithSuffix`). **Export
  Minimap's Include Blight** (`--export-options terrain,water,blight,doodads,playable`, minimap-tiles-blight.w3x from
  `make-minimap-tiles.mjs blight`): 65.5, 61.5, 45.5 over Lgrs and Ldrt alike, Studio's export the same. **A camera past
  the camera bounds dragged with Enforce Camera Bounds on** (copies of the empty map, cameras at 3100, 0 and 3000, -700
  of distance 600, the bound 2816): dragged inward to 2716.3 it moved there; dragged further out, or inward to about 2940,
  it stayed (Studio's rule, app-smoke heightsLimits). **Map Size** (`tests/we-compare/resize-objects.json`): regions are
  clipped to the new map, those left without area go; camera objects whose target is outside the new camera bounds go,
  after a growth too (resize.ts `camerasAfterResize`); the editor's open rounds region edges to the 32 grid (nearest,
  halves up: -1000 to -992, -3600 to -3584, 100 to 96), Studio keeps them. **Replace Units beside rings**
  (`replace-units-rings.json`): an altar's, town hall's, tree of life's and necropolis' blue ring refuse a farm that
  reaches 16 into it, as the barracks' does. **A map with no start location unit** (the empty map's sloc removed, the
  player's start at 1280, -1536, fixedStart 1 and 0): the save makes one at a random place on the 64 grid (-2688, 2304;
  -1856, 2240; -2240, -2560), hit points and mana 0, and moves the w3i's start beside it (-2668.2, 2326.4), whatever
  fixedStart says; with fixedStart 1 it takes Melee off (owner.ts already). Studio puts the start at the w3i's start
  instead (startlocations.ts `startToAdd`). **AI Editor**: u05_mint.wai's Attacking tab shows Minimum Forces "First Hero
  Only" (the bytes HAIA; Attacking tab 403,234). **Level over flat ground** types cliff corners: cliff-type-stencil.json
  ran OK again (cliff-type-level-2: 15 corners). **Regions with the naval view** (flat.w3x with a yellow region across
  the south border and a red one across the west, View Entire Map, W, then Ctrl+R, P, N; box means): P and N are one
  switch in the editor (N turns Pathing - Ground off, P Naval). Naval alone: flat land 200, 114, 91 (ground 144, 100, 54),
  border 116, 54, 18. With regions: yellow over the playable land 230, 191, 41 and over the border 192, 164, 8, red over
  the border 192, 25, 8 (regions alone over the border: yellow 149, 146, 5, red 148, 7, 5). Studio (app-drive, the same
  toggles): naval alone 206, 131, 83 and 113, 61, 15; with regions yellow over land 239, 177, 64, but over the border the
  region is gone under the brown (108, 55, 15). No simple linear or sRGB blend of one colour fits the editor's three
  channels; the heights view wasn't tried.

**Local only: it needs the installed game, Proton, Xvfb, bubblewrap, a C compiler, python3 with python-xlib and Pillow,
and Mesa's lavapipe; it is not part of CI or the gate.** Without one of them it prints `{"skipped": why}` and exits 0.
It never starts the game itself.

- **Nothing of the user's is touched.** `we-setup.mjs` keeps one farm for all worktrees in `target/we` of the main
  checkout (`W3PROJ_WE_DIR` moves it): `install/` holds hardlinks of the install, except what the editor writes (the
  CASC `.idx` files, `shmem`, `ecache`: about 10 MB of copies), and `prefix/` is a Wine prefix of its own (about
  0.35 GB). The farm is made again only for another game build (`.build.info`), `--clean` removes it all. The editor
  runs in bubblewrap with the whole machine mounted read-only except the farm, its prefix, the run's work folder,
  `$XDG_RUNTIME_DIR` and `/tmp` (`writableDirs`), and with the user's whole Steam prefix and every hardlink read-only
  inside those; `--die-with-parent` takes Proton along when we-drive is killed, and each start kills a leftover
  wineserver of the prefix first; the editor opens the
  CASC data files for writing, so `we-rofs.c` (preloaded) turns those opens into read-only ones. One World Editor runs
  at a time, machine-wide: the lock is `$XDG_RUNTIME_DIR/w3proj-we.lock` (else the temp dir, with the user name), shared by
  every worktree and every `W3PROJ_WE_DIR`; a second run says once who holds it and since when, and waits
  (`takeLock`'s timeout; a dead pid is taken over). we-drive takes the lock before it sets the farm up, which may rebuild it
  for another game build; `setup` refuses to replace a farm another live run holds, and the folder must pass `guardedWeDir`
  (inside this repository or the main checkout, not holding or inside the game folder). `we-setup.mjs --snapshot` and `--compare` show the
  install and the user's `Documents/Warcraft III` unchanged; the user's own Battle.net app writes elsewhere in that
  prefix while it runs (and touches the install's `shmem` files when it checks the game), which `--compare` lists.
- **Nothing is ever sent to Blizzard.** The editor crashes on close with View > Light Ranges on, and its crash
  report dialog has "Send to Blizzard" ticked and a text box. The editor's sandbox has no network (`bwrap
  --unshare-net`: the editor's processes see only `lo`; it starts and loads maps as before), and every window list
  we-drive reads (`Session.windows()`, so every step, `--close` included) is checked for that dialog (`crashDialogs`:
  the owning program's name, else title or window class). Seen for real (2026-11-13): the dialog comes after the main
  window has gone, is titled exactly "Warcraft III World Editor" with the editor's class (`steam_app_<appid>`), and
  belongs to `BlizzardError.exe`, so the program name is what finds it. Only argv[0]'s file name counts, and a
  title's `[…]` (the map's path) is left out: paths may say "crash" (a worktree named so once tripped it). On a hit
  it takes a picture of the screen (`dialog-crash-*.png` in the work folder), types and clicks nothing, kills the
  editor, its crash reporter and everything else of its prefix (`wineserver -k` and the process group), and prints
  `crashed: true` with "the World Editor crashed; report dismissed without sending" (`--close` then counts as
  closed; any other step fails). Unticking the box isn't tried. `--close` types "n" only into a window of the main
  window's process: the "Warning" question, or an untitled or editor-titled dialog while the main window exists
  (`closeAction`); anything else of the kind counts as a crash. Tested on the recorded window list
  (`we-drive.test.mjs`); the crash leaves its dump in the farm's prefix (`Documents/Warcraft III/Errors`).
- **Nothing on the screen, no sound.** A display of its own (Xvfb, 1600x1000), Vulkan through lavapipe. Wine's audio
  drivers are off, PulseAudio and PipeWire are pointed at nothing and their sockets and `/dev/snd` are hidden, and
  the editor's interface sounds are off in its preferences: nothing of it shows in `pactl list sink-inputs`.
- **Never the user's desktop.** `we-x11.py` (clicks, keys, drags) refuses with exit 2 unless `--display :N` is an
  Xvfb process (found in `/proc`, by its argument or its `-displayfd` socket); no `--display` is refused too, so
  Xlib never falls back to `$DISPLAY`. `W3_ALLOW_REAL_DISPLAY=1` overrides it, for your own manual use only.
  `webdriver.mjs` (app-smoke, app-drive) and we-drive strip `DISPLAY`, `WAYLAND_DISPLAY` and `XAUTHORITY` from what
  they inherit and start their own Xvfb, or fail. Tested in `input-guard.test.mjs` with a fake `/proc`
  (`we-x11.py guard-check --display :N --procroot DIR`).
- **Preferences** (`Documents/Warcraft III/WorldEditPreferences.txt` in the farm's prefix, written before each start,
  the rest kept): `Has Been Run=true`, no interface or splash sounds, `Fixed Day Night Cycle` from `--day-night`, and
  the graphics: `--mode sd|hd|de` sets `assetMode` to 0, 1 or 2 (File > Preferences > General > Asset Mode offers
  SD, HD, DE; DE is the 3.0 art) and `hd` and the Reforged switches (`Buildings`, `Environment`, `EnvOld`, `Heroes`,
  `Icons`, `Textures`, `Units`, `Vfx`) to 0 for sd, else 1. Told apart (2026-11-13) by pictures of one map in all
  three modes: `assetMode` alone decides (assetMode 2 with every other switch 0 draws DE, assetMode 0 with them all
  1 draws SD); the registry and the install showed no mode value in a before/after diff. SD has round trees, HD flat grass with
  pointed trees, DE feathered pines and a detailed terrain. Switching in the dialog crashes the hidden editor
  (it re-opens its archive over the network), so write the key instead. The install's text locale goes into the prefix's registry (else the editor shows
  `WESTRING_…` names); it must be enUS (we-drive finds the dialogs by their English titles and refuses an install without it). The first start of a new prefix shows the editor's welcome, which asks to accept Blizzard's
  terms. The user accepted them in their own install (which the farm is made from) and agreed on 2026-11-08 that
  we-drive presses Continue in its own prefix; `W3PROJ_WE_ACCEPT_TERMS=0` makes it report the dialog instead. The
  shared prefix keeps the answer, so this comes up once per new prefix.
  Pinned before each start (else written as found, so a run depends on the last; `--keep-prefs` leaves them): `Enforce
  Water Limits` (Ctrl+Shift+W), `Enforce Camera Boundaries`, `Reset Fixed Z When Moving Objects=false` (the switch
  Ctrl+Shift+H toggles: seen 2026-11-17, false to true, kept by the next start when not pinned), the minimap's `Show
  Creep Camps` (PINNED_PREFS). `--pref Section/Key=value`
  (repeatable) writes any other key before each start, `--keep-prefs` or not; we-compare's `we.prefs` passes them.
- Game view: V toggles it, and `--game-view` reads it from View > Lock to Game View Settings. The "Game View Settings"
  label the editor shows in the upper right of the view on the user's machine didn't appear in the hidden display.
  A fog map confirms the state: 02e (exponential fog, density 0.5) is the full map with game view off and nothing but
  fog colour with it on (checked 2026-11-08).
- **Layout** in the fixed display: main window 4,30 1352x937, terrain view 156,79 1184x844, tool palette 1356,30
  240x600. Keys go to the main window (without a window manager the palette keeps the keyboard otherwise). Closing
  answers the "Save changes?" box (titled "Warning") with No; system dialogs are in English.
- **Timings** (this machine): a warm start shows the map after 10–14 s (main window after 6 s), a start with a new
  prefix after 23 s (39 s with closing). The terrain view draws about 14 frames a second in SD and about 2 in HD.
- **Game view** (`V`, View > Lock to Game View Settings) is read from the View menu's check mark. This build draws no
  "Game View Settings" note in the view, so the picture of the view can't tell.
- **The default camera when a map opens** is deterministic: the camera object with target = the terrain's centre
  (`offset + (corners - 1) * 64`), distance 3000, angle of attack 304, field of view 70, rotation 90 gives the same
  picture (mean difference under 1/255). It doesn't depend on the start locations, the camera bounds or the map size
  (eight test maps). In Studio's terms, at the view's 1184:844, fitted from a 256 grid of marked ground corners
  (0.5 px rms): `node scripts/app-drive.mjs … --terrain --camera "x=CX,y=CY-298,distance=2738,pitch=57.2,yaw=-90,fov=41.06"`
  (CX, CY the map's centre); Studio's picture with that camera fits back to the same numbers. For another camera of
  angle 304 and field of view 70 the numbers scale with its distance d (target `y - 0.0993 d`, distance `0.9127 d`).
  The editor puts the target above the middle of the view (an off-centre projection, at 0.385 of the height), which
  a centred camera matches only at this aspect.
- **A new camera's clipping** (branch camera-farz-we, 2026-11-15, SD; specs `tests/we-compare/camera-farz.json`, input
  `camera-farz.w3m`: eight cameras at 0, 0 from 500 to 5000, every second with far 9000 / near 50): Create Camera, Create
  Free Camera and Set Camera To Current View give the camera the view's far and near clipping, never one from the
  distance. The view has far 50000, near 16 when a map opens (the empty map and 4v4_MountHyjal); View Selected Camera
  gives it that camera's, which stay through wheel zoom (x1.1 a notch) and arrow-key panning. Studio:
  lib/terrain/cameras.ts `ViewClipping`, set by the Cameras tab's View button.
- **Applying a camera object**: `--key m` (camera layer), `--click 1396,177` (the first camera in the palette's list,
  13 px per row), `--click 1476,119` (View Selected Camera). Three runs gave the same picture. `--look` does this:
  its cameras go into we-drive's copy of the map before the start (unpacked with the release CLI, war3map.w3c.json,
  packed again), one row each, then two parking cameras at the terrain's corners; after View Selected Camera the
  parking camera farther away is selected, which takes the selected camera's green circle out of the picture
  without moving the view. `--look center` on cliff.w3m (SD) gives the opening picture exactly (difference 0).
- **The Camera Objects layer** (`--view "Camera Objects=on"`, Ctrl+M; branch camera-layer, 2026-11-13, a copy of
  cliff.w3m with flat cameras of distance 500, 1000 and 2000, and 12b_RoC_Orc04Interlude's 28): one blue model per
  camera, a small movie camera with an arrow whose tip is the target, pointing along the camera's view and scaled by
  its distance (the camera's back 0.365 of it from the target; world-sized, so it grows as the view comes closer). No
  footprint or field of view on the ground. Lit by the map's light (blue under 12b's, light cyan on cliff.w3m's day).
  Studio's lib/terrain/cameras.ts `cameraMarkers` lines up within 2 px at the opening view. The colour (branch
  camera-tab-markers) fits one colour lit by the units' light as the lighting model gives it, without HD's response
  to it (renderer `setShapes`); with that response no one colour fits both maps. The camera layer (`m`) shows no
  models by itself (View > Camera Objects does), but a selected camera (its palette row) gets a pure green circle
  round its target on the ground (following hills), radius 0.096 of its distance; on cliff.w3m's bright grass it is
  hard to see by eye (find it by difference).
- **Maps from other paths** (branch studio-maps-we-verify, 2026-11-16, SD; spec `tests/we-compare/studio-paths.json`, inputs `tests/fixtures/we-specs/make-studio-paths.mjs` into `target/studio-paths/`, from (2)EchoIsles): the editor opens and re-saves a map packed after `w3proj rebuild --force`, one with war3map.lua deleted and written by `rebuild`, one with war3map.wts deleted, and one saved by the terrain editor (selectAll, Numpad6, `editors.saveAll`: 3522 doodads moved 64, the editor keeps them); every one equals the plain unpack/pack control. What the editor's save changes in all of them: file versions (doo 8 to 13, w3e 11 to 12, w3i 31 to 39), `skinIds` dropped, `ChooseRandomItemExWithFilter`, `SetPlayerRaceSkin`, `SetHDWaterParamsEx` in the script (the Studio-regenerated script equals the game's original, so the 82 differing lines are the editor's newer generator); war3map.wpm and (with a wts) war3map.wts match. A deleted war3map.wts is not written again by Studio's save (names stay TRIGSTR_nnn; the editor blanks them). A map without war3map.wtg (MatrixPCDefense_v4.3) is refused: "Trigger data missing or invalid". The editor's save writes ally masks worked out from the starts where the w3i has zeros (echo: 2 and 1, as the original); Studio's pack keeps the zeros (`studio-paths-zeromasks`, `studio-paths-matrix-masks`). Rerun 2026-11-17 (branch fix-we-studio): Studio's save works the masks out too (zeromasks OK); MatrixPCDefense has no start location objects, so the editor places starts of its own **at random** (another place each run) and counts that as an edit (saves 1 to 2): its masks can't be compared. The doo's `skinIds` is a field of the version 8 the maps have (the editor writes a newer version without it). The editor's save moves 9 of echo's neutral buildings (tavern, marketplace, merchants, mercenary camps, ntrt/ntrg; gold mines not) by -1 to 2.7 off their stored height, 17 by up to 5.2 after Numpad 6: not heightAt at the point, nor a mean or maximum of points within 16 to 256 of it. Without war3map.wts neither save writes one; the editor writes the w3i's now stringless TRIGSTR_ names as "", Studio keeps the TRIGSTR_ text.
- **Open checks** (branch we-open-checks, 2026-11-17, SD): (1) the examples `footless-ramp-wpm` and `doodad-fix-on-load` run from their own folder (inputs next to the specs): OK (the six random scales of the second differ as its spec says). (2) Items: `tests/we-compare/items-script-set.json` (flat.w3x, build 24371, 11 items of five types placed by `place_objects`, Studio's script from `rebuild_map`, the editor opens that map and saves it; kind `text-set` = the lines of the script as a set, the order ignored). Studio's script has the editor's lines, `BlzSetItemColor ... ConvertPlayerColor(24)` included, in another order within a type (bspd 640 first in the editor, ratc 256 and -256 before -512; compared as `text` it differs, as `text-set` it matches), and war3mapUnits.doo matches. A spec that ran after one that set `script.generateOnSave` false got no script in Studio (settings stayed for the whole run; since branch fix-we-compare-tooling they are put back after each spec). (3) `tests/we-compare/open-paths.json` (inputs by `tests/fixtures/we-specs/make-open-paths.mjs` into `target/open-paths/`: projects of smoketest_maps packed by the release CLI): the editor opens and saves meelee_map, meelee_map_2, another melee map, Untitled, 03b_Water_Tint, (2)LastRefuge and ForsakenStart; w3i, doo, units and pathing equal Studio's save after Fix Doodads on Load except the differences the spec names (unit heights up to 0.7 in meelee_map and LastRefuge, 192 and 2184 pathing cells in meelee_map_2 and ForsakenStart; ForsakenStart's were the unplayable border's cells with a blighted nearest corner, 0xee in the editor's save, fixed in branch fix-we-studio: pathing.ts); the editor's own changes are ignored (skinIds, units subversion 11 with hp and mana -1, w3i flags and player names). Forsaken07 and Forsaken05Interlude packed from the campaign project, and the same maps as the campaign file holds them (`forsaken-07-original`: no Studio in it), open but the save stops at "Script Errors" (`Invalid object ID`, `gg_unit_... undeclared`: their objects are in the campaign's own object data), so a campaign map alone is the editor's problem, not the pack's; opening the campaign itself (Campaign Editor) wasn't tried. (4) `.w3o`: the Object Editor's File > Export All Object Data (F6, File 128,151, the item at 180,428, enabled only when the map has custom objects; type a bare file name, it lands in the folder of the last Open/Save dialog of the farm's prefix, which another run may have set) wrote `tests/fixtures/w3o/we-export-hillsbrad.w3o` for HillsbradCreek: version 1, a present flag per kind in w3u, w3t, w3b, w3d, w3a, w3h, w3q order, only the first three present; `w3o::unpack` reads it to the last byte and `pack` gives the same bytes (`w3o.rs` test, `examples/w3o_check.rs`). **we-drive and module windows**: a module the editor restores at its start (Trigger Editor left open by another run, or the Object Editor after a run that exported) ignores the close; the run waited 300 s and said "the map wasn't shown". `--wait-ready` now raises the main window over it after each close, and is ready 9 s after the first sight of it once the view isn't the grey 240 picture (`we-drive.test.mjs`). A module window the editor has just restored paints only after some input.
- **Script checks** (branch we-script-checks, 2026-11-17, SD): (1) **Destructable tint** (`tests/we-compare/dest-tint.json`, input `make-dest-tint.mjs`: flat.w3x with one destructable of each of the game's 344 types, LTlt with variations 1-6, flags 0/1/4 and lives 0-99, tints in war3map.w3b and war3mapSkin.w3b, a text trigger naming all; spec `lines` keeps the SetDestructableVertexColor lines): the editor (7003) writes 255, 255, 255 for every game type and every variation, scale, angle, life and flag; a tint comes only from object data, moved by its save into war3mapSkin.w3b: an original's change (LTe1 100/150/200, LTg1 80 in the skin file, LTg2 70 skin only, LTe4 60 in w3b only), and a custom type has only the fields it sets itself, **not** the change made to its base's original (LTe3 with bvcg 40 gives 255, 40, 255; a custom type on it with bvcb 7 gives 255, 255, 7, one with no mods 255s). Studio inherited the base's change; `objects.ts` `destructableTints` no longer does (unit test; `dest-tint` MATCH). No placement property changes a tint: the "tint not in the placement or object data" of test.md wasn't reproduced (the corpus has no such map; HumanX03, HumanX06, UndeadX07a-c are object data). **Flag 2** (`dest-flags.json`, `--unref`): the editor writes flags 2 (6 where it was 4) on every destructable its script doesn't create and 0 (4) on one it creates, whatever the input said (2, 3, 6 included: it creates a named one); so flag 2 is its mark "the game places it from the doo", worked out on each save from "named or has drops". Studio's script leaves a destructable with flag 2 out (`destructables.ts` GAME_PLACED) and new placements get flags 2 (placement.ts): a trigger that later names one gets no creation line (bugs.md). (2) **Injected script** (`injected-script.json`, input `make-injected-script.mjs`: flat.w3x whose war3map.j has an added global, two functions and an ExecuteFunc call in main): the editor opens it without a message and its save regenerates war3map.j from the triggers, the injected code is gone (no warning); Studio (app-drive, a placed unit, `script.generateOnSave`) keeps the file and asks "war3map.j has 2 functions that the map's triggers don't make (W3C_InjectedHelper, W3C_InjectedStart) ... Replace the script / Show Difference / Keep it", the global, functions and call stay. (3) **Camp grouping on real maps** (`camps-real.mjs`, `predict-camp-icons.mjs`, `read-camp-icons-real.py`): the minimap's icons with and without a click on Show Creep Camp Icon, the difference read as blobs, against Studio's `campGroups` on the neutral hostile units (icon on the first creep of each group): EchoIsles 19 of 19 (one icon split by the camera frame), TerenasStand 20 of 20, LastRefuge 20 of 20, Hammerfall 17 of 18, NorthernIsles 18 of 18, AutumnLeaves 20 of 20, HillsbradCreek 32 of 32, TurtleRock 22 of 22, 4v4 Deadlock 34 of 38 (mean distance 2 px, the icon's own offset): the unmatched five (Hammerfall 1, Deadlock 3 at the top edge of the read box, one merged with a neighbour) can't be read, none is an extra or a missing camp. (4) **AI Editor** (F8; `make-ai-embed.mjs` writes a .wai with a custom hero H000 "Zork the Custom One" (a .w3u wrapped as Studio's Import Custom Data does) in it): the editor's AI Editor opens it (toolbar Open 178,204 at 1600x1000 after `--move 700,600 --click 700,600` to make the module paint, the file by full Windows path with backslashes, `--type 'Z:\home\...\zork.wai'`: forward slashes are refused as "Invalid character(s) in path") and reads the data: the General tab's Custom Data Export and Clear are enabled, "Last Import File: custom.w3u" (the file name only) and "Last Import" the date Studio wrote, the Heroes tab shows "Zork the Custom One" in the hero list, training order and skill selection with the Paladin's skills. **Campaign Editor** (F7; Ctrl+O with a full path opens a .w3n: 126 MB The Chosen Ones in 15 s, 980 MB Curse of the Forsaken in about 45 s; Edit > Edit Map is Ctrl+M on the selected row of Map Files at 690,283): the chapter Object Editor isn't reachable: Chosen Ones' Prologue answers "Unable to load file ...: Unit data missing or invalid", Forsaken's first map opens nothing in 60 s (the main window stays on the old map), and the Object Editor (F6 or Module) shows the flat map's own 1533 standard abilities. we-drive: a restored "AI Editor - [Untitled]" window wasn't known as a module (`isReopenedModule`) and stalled `--wait-ready`.
- **Floating doodads** (branch doodad-nudge-z, 2026-11-16, SD; spec `tests/we-compare/doodad-water-z.json`, input by `tests/fixtures/we-specs/make-doodad-water-z.mjs`): the 298 doodads at z 294.4 after studio-paths-terrain-save were all of types with Doodads.slk `floats` 1 (lily pads, seaweed, bubbles), not a bounds clamp. The editor puts such a doodad without flag 4 on the water level of the corner nearest to it (halves round up on both axes) when that corner has the water flag and its level is above its ground (cliff level counted), else on the ground, and works this out again on every save (opened and saved, stored heights don't count; non-floating plain doodads go back to the ground the same way). EchoIsles' 3522 doodads fit it, as the original and as the editor saved them. Studio: w3e.ts `floatingLevelAt`, objheights.ts `doodadGround`, used where a move lands (nudge, drag, turns). On opening (branch doodad-open-rules): the same for every doodad and destructable without flag 4 (a tree LTlt too), with its life (doodads 255, destructables at most 100) and scale rules (four appended cases in the input); Studio's Fix Doodads on Load does it as the terrain view opens (doodadedit.ts `restAsOpened`, kept within 0.01), and `doodad-water-z-open` matches. Without the terrain view opened Studio writes the stored values. A fixed doodad (flags 6) moved by the nudge goes to its ground with flags 2 when the editor's Reset Fixed Z When Moving Objects is on, and keeps its height and flags with it off (`doodad-water-z-nudge`, `-keep`; 2026-11-17, branch fix-we-studio: the spec had failed because we-drive pins the switch off and Studio's default is on).
- **Heights on load: ramps and sample radius** (branch doodad-open-z-we, 2026-11-16, SD; specs `tests/we-compare/doodad-open-z.json` (input `make-doodad-open-z.mjs`, `wide` for the unknown ones) and `doodad-open-z-real.json` (smoketest_maps Hammerfall, AutumnLeaves, SnowareBay, Firebrand, and `-tweak` copies by `make-doodad-open-z-real.mjs` into `target/doodad-open-z/`)): the editor keeps every stored height of those maps on open and save (all 20 128 doodads), and puts copies raised by 37.5 back on them: the stored heights are its ground, not stale. Studio's Fix Doodads on Load had rewritten 100 of them (13, 25, 43, 19); the causes: (1) ramps: a ramp's middle corner is half a level up only where it climbs along one axis beside a straight tile (w3e.ts `rampLift`; the inside of a bend and a climb without a straight tile stay down), 196 doodads on ramp tiles fit; (2) destructables with an Elevation Sample Radius (DestructableData `radius`, `brad`) from 1 to 100 stand on the mean of the ground at (x ± 64, y ± 64) (objheights.ts `doodadGround`): walls, gates, icy rocks (50), the bridge YT00 (100), original-table changes to 1, 25, 64, 100; radius 0 and every custom type (whatever its radius) on the point (objects.ts `Skin.elevRadius`); radius 128, 150 and 200 (YT04) sample wider in a way not found (no square or ring of 4 to 25 points fits): Studio keeps their stored height on open (`ELEVATION_RADIUS_UNKNOWN`); (3) floating goes by the skin the doo names (SnowareBay's LWw0 drawn as NWfp floats). With them Fix Doodads on Load leaves 80 955 of the 80 956 plain doodads of smoketest_maps' 24 maps as stored; the one left: AutumnLeaves' seaweed 2213 on a cliff tile whose nearest corner is wet (419.15 over ground 252.75) next to a dry level-6 corner, which the editor keeps on the ground (the 1986 other floating ones fit `floatingLevelAt`). The editor also snaps YT04 to another grid point than Studio (32 west and south).
- **Import lists and graphics modes** (branch we-import-checks, 2026-11-17, we-drive `--mode sd|hd|de`; specs `tests/we-compare/import-modes.json`, inputs `tests/fixtures/we-specs/make-import-modes.mjs` into `target/import-modes/`). The editor's import list is its **Asset Manager** (F12, `--key F12`; its own menu: File > Import File Ctrl+I / Import Files Ctrl+Shift+I / Export, Edit > Replace File Ctrl+R / Replace File and Reload World / Delete File; columns File Name, Mode, Teen, Locale, Type, Size, Full Path, rows sorted by Full Path; widen the last column with `--drag 940,283:1450,283`, the bottom line says "Total Files: n/n"). Ctrl+I opens an Open dialog (`--type Z:\…`, Return) and asks nothing: the file lands at `war3mapImported\<name>` with flags 21, Mode SD, whatever its folder is called (`_HD.w3mod` in the path changes nothing), so the editor can't make a Reforged-only or 3.0 import; it has no "Use in" and no right-click menu. What it lists of a map that holds them (`import-modes-list`, 13 entries; its save keeps all 13 with the stored flags, 13 and 21 as stored): `_HD.w3mod\` Mode HD (also `_HD.w3mod\_Teen.w3mod\`: Teen Yes, Locale N/A), `_DE.w3mod\` Mode DE, `_Teen.w3mod\` Mode SD, Teen Yes, Locale N/A, and the **lower-case spellings `_hd.w3mod\`, `_teen.w3mod\` and `_locales\enus.w3mod\` as plain SD, Teen No, Locale Unknown**; Type Model, Text, and Other for .dds textures; Size in whole KB (a 7-byte text is 0). **Which file a graphics mode reads** (`import-modes-units`, camera `--look 0,0,1300`, pictures): hfoo with a model held only as `_HD.w3mod\war3mapImported\hdonly.mdx` is the HD Footman in HD and the green missing-model cube in SD and in 3.0 (DE); the same under `_hd.w3mod\` (lower case) is read in HD (the Asset Manager's SD is the listing only); a model held only below `_DE.w3mod\` is the cube in SD and HD and shows in 3.0; a model held plain and as `_HD.w3mod\` shows the HD one in HD, the plain one in SD **and in 3.0** (3.0 never reads the map's `_HD.w3mod\`: Studio did and now doesn't, `modeNames`, `mapModeHas`, `shownEntry`); a plain import of a game path (`Units\Human\Rifleman\Rifleman.mdx`, the Easter Rabbit) replaces the Rifleman in all three modes, **HD included**: the map's plain file wins over the game's own `_HD.w3mod` file (the test.md guess that Reforged prefers the game's `_hd` was wrong, so a plain import replacing a game model is not Classic-only and Problems has no mode warning to give; Studio's pictures of the same map match in SD, HD and 3.0). **TurtleRock v2.0 (W3Champions)** cleaned by Studio's "Clean up import list" (app-smoke importListCleanup's TurtleRockCleaned.w3x): the Asset Manager says Total Files 48/48 (the original's 66 blank entries: 66/66, names `war3mapImported\…` of size 0); the same model imported by Studio's Import files… gives the editor's entry (`import-modes-import`: `war3mapImported\Rabbit.mdx`, flags 21).
- **Format fields** (branch we-format-checks, 2026-11-17, SD; specs `tests/we-compare/format-checks.json`, inputs by
  `tests/fixtures/we-specs/make-format-checks.mjs fields|missing|hud|props`; scripts, pictures and saves in
  `target/evidence/we-format-checks/` of that worktree). war3map.w3c v3's u32 after the name is the camera type: the
  camera palette's Create Free Camera (1476,100) writes 1, Create Camera (1476,80) 0; the editor's save and its
  `BlzCameraSetupSetCameraType` make 2 and 7 into 1 (Studio's script too, jass.ts; its file keeps the value). An unedited
  8-byte version 0 w3c (4v4_MountHyjal) comes back as version 3 with no cameras; Studio keeps it. **Doodad Properties**
  (`d`, Escape for the selection brush, a click on the model, Return; the dialog at 508,353): a destructable has
  Variation, Position Z with Fixed Z, Adjust Z (12.5 typed: z 12.5 and flags 2 to 6), Scale with "Use model axes" (flag
  8), Life, Skin; it opens on the tab used last (one run typed Roll into the Lights tab), so click General (550,415)
  first. A doodad (the lamp post LOlp) has Rotation, Roll 607,492 and Pitch 607,517 (the doo's v13 trailer[1]
  and [2] in radians), Scale, Skin, and a Lights tab (618,415; its "Light 1" row 535,441, then Intensity 795,462 and the
  fields 20 px below: Shadow Start, Shadow End, Quadratic, Linear Falloff, Damping; Color; Casts Shadows): the doo's
  `extras`, nine dwords a light (doodads.json has the order and scales). Typed values replace after End and BackSpaces;
  the dialog shows a stored value beyond its 0..100 range as 100. `preFlags` 0 and 7 survive a save and show nowhere.
  **Water bit 15** of the w3e's water word: set in none of 493 maps; the editor's open and save clear it (and leave bit
  14 on where the w3i's complements don't put it). **HUD skins**: Scenario (166,41) > Player Properties (205,172)
  shows Human 1, Orc 2, Night Elf 4, Undead 8, Forsaken 128 and "Selected Race" for 64 and every other value (0, 16, 32,
  32759); the script names them RACE_PREF_HUMAN, ORC, NIGHTELF, UNDEAD, FORSAKEN, USER_SELECTABLE for 64 and RANDOM for
  the rest (setup.ts). A new map (ctrl+n, OK 759,632; ctrl+s, Return on "Not all player starting locations", Return on
  the Reminder, then the Save As box takes a typed `Z:\…` path and Return) gets a HUD skin that is whatever the memory
  held: 28671 three times in SD, 1866674037 in HD, 32759 in flat.w3x; the script says RANDOM for each. **Unknown object
  ids** (doodad Xzz1, unit xzz1): nothing is drawn, the view's message lines say "Invalid object ID: Xzz1" twice, and the
  save leaves both out; Studio draws its cube and keeps them. **A menu left open** (a click on Scenario, then Escape)
  keeps the main window in menu mode: `--close` timed out; press Escape twice.
- **Adjust Map String IDs** (branch locale-string-ids, 2026-11-13): Advanced (`--click 250,41`) > Adjust Map String IDs
  (`--click 300,163`) opens "Map String IDs", a list of war3map.wts's strings (rows at y 304, 318, … in steps of 14);
  `--double-click 392,304` opens "Enter New ID" with the number selected: `--key 4 --key Return`, then OK
  (`--click 871,710`) and `--save`. It leaves the `_Locales` tables alone (lib/formats/localewts.ts).
- **Saving** (`--save FILE`, branch save-parity, 2026-11-09): variants of a map made with the release CLI (unpack, JSON,
  pack), saved by the editor and unpacked again, show what its save works out by itself. Found so: the ally priorities
  (lib/terrain/startlocations.ts `editorAllyPriorities`), hit points and mana of 0 saved as -1 (lib/terrain/owner.ts
  `savedUnitValues`), and that it never upgrades a subversion-9 unit file (unitprops.ts `ownSetsOnly`). Start locations
  too close to cliffs bring up "This map is no longer considered a melee map … invalid positions", which `--save`
  reports; the flat `empty_map_on_newest_world_editor.w3m` doesn't. The save also turns the Melee flag back on for a map
  that meets its rules (a copy with the flag off got it). Those rules (branch props-ui-fixes: copies of (4)PhantomGrove
  with the flag cleared and one change each) are in lib/terrain/owner.ts `meleeBlockers`; Studio's save takes the flag
  off by them, and puts it back only where it can tell every reason is absent (lib/terrain/meleesave.ts
  `meleeSetBlockers`: the default trigger only, no object data or interface file, nothing but creeps within 512 of a
  start on flat buildable ground; the 512 is now the measured square, see "Start locations in invalid positions" below). Branch melee-flag-set (2026-11-13): copies with the flag cleared of cliff.w3m,
  (2)BanditRidge, (8)Friends, (4)RustyCreek_S2_v1.3 and (4)FrozenClover (a creep 12 from a start) got it back from the
  editor's save, as from Studio's; (6)Zandalar got it back too, where Studio leaves it off (doodads 39 from the starts).
  Studio puts it back on 153 of the game's 185 FrozenThrone melee maps with the flag cleared. Branch melee-flowers
  (2026-11-16, `scripts/melee-corpus.mjs` over all 223 maps under Maps/FrozenThrone): doodads and destructables without
  a pathing texture (flowers) no longer block a start, 171 -> 180 of 212 melee maps, 0 of 11 others; the 31 left are
  "not plainly valid" starts (cliffs, trees, ground). A player's flag bit 1 is SetPlayerRaceSelectable (map-info/priorities.ts RACE_SELECTABLE).
  **Start locations in invalid positions** (branch melee-valid-we, 2026-11-16, SD; spec `tests/we-compare/melee-valid-we.json`, 22 cases, inputs by `tests/fixtures/we-specs/make-melee-valid.mjs` into `target/melee-valid/` (flat.w3x, start at (0, -256), one thing added each; its `--case NAME=JSON` makes others), measured with one we-drive process per map, because then the whole file in one we-compare run failed every second map with "the editor exited while starting", `--restart-per-map` too (the late exit event of the closed editor, fixed in branch we-drive-fixes): all 22 as expected): the editor's save fits a 16 x 16-cell square (a town hall's) on each start, centred on the start rounded to the nearest 32 (halves up), and calls the start invalid when a cell of it isn't buildable in the pathing with destructables stamped in (trees count, though war3map.wpm leaves them out), when another start's square overlaps it, or when a gold mine's centre is nearer than 750. Measured: a tree (snapped to 64) at 256 or (256, 256) invalid, 320 or (320, 256) not; gold mine 749 and (528, 528) invalid, 750, 752, 768 and (530.5, 530.5) not; another start (in the w3i too) at 488, 480 and -496 invalid, 496, 504, 512, (512, 480) and -504 not; Lrok, a one-level cliff and shallow water whose unbuildable cells began 192 or 128 from the start invalid, at 320 or 256 not (the editor's own saved wpm agrees cell for cell). Not reasons: blight from 192 away (its cells 0x60), a tavern (also 256, 128 away), a goblin merchant on the start, an item 64 away. The stored wpm of all 212 melee maps of the corpus is buildable in every start's square. Studio: meleesave.ts `startsPlainlyValid`, `startPathing` (pathing.ts generatePathing with every doodad and destructable stamped, the map-edge tiles blocked), `START_SQUARE`, `MINE_CLEARANCE`; a doodad whose pathing can't be read (the tables name PathTextures\16x12Default.tga, which the game lacks) counts within 768 of a start. melee-corpus 180 -> 211 of 212 melee maps, 0 of 11 others, keep 212 of 212, no agreement lost (the one left, ConcealedHill, has custom triggers). Studio's save takes the flag off a melee map for a start surely invalid by these rules (`startsSurelyInvalid`, branch fix-bugs-w3i; `melee-valid-melee-tree-256` matches); a doodad of unknown pathing or a cell only unwalkable keeps it.
  **Requires The Frozen Throne data** (w3i flag 0x4000; branch fix-bugs-w3i, 2026-11-17, SD; spec `tests/we-compare/tft-flag-we.json`, inputs the `tft-*` cases of `make-melee-valid.mjs`): the editor's save sets it when a placed unit or item, or an item of a unit's drop set, has `version` 1 or 2 in UnitData.slk / ItemData.slk (tavern, nanb, sfoo, shas, shas as a frog's drop), and clears it when none has (flat.w3x with the flag set); not reasons: a unit of version 0 (nfrp), a destructable (LTbr), doodad (ZPfw) or ground tile (Zdrt, custom tilesets on: that save set flag 0x0008 instead, see below) of version 1, a random item (YjI5) in a drop set; Melee is independent. Re-saved, the game's (2)TheTwoRivers, (4)DesertStrife, (6)ScorchedBasin, (8)PlainsOfSnow, (8)ShamrockReef (rman, rreb or gold in drops) and Scenario (12)WormWar (nothing of version 1 placed; custom units based on Ucrl and nano, own triggers) keep it. Studio: `lib/terrain/tftflag.ts`, applied in meleesave.ts `meleeAfterSave`/`savedMelee`; it clears the flag only without custom object data and custom triggers, and a type it can't tell (custom, random unit), an inventory or a w3i item table holding one of version 1 leave it as it is. melee-corpus prints the agreement with the stored flag.
  **Flag 0x0008 is the custom tilesets flag** (branch we-compare-3, 2026-11-18, SD; spec `tests/we-compare/tileset-flag-we.json`, 3 cases MATCH; inputs `make-melee-valid.mjs` tft-tile-custom, tileset-*): the editor's save sets it exactly when war3map.w3e's custom tilesets flag is on and clears it when it is off (flat.w3x 0x9c14 to 0x9c1c, and a stored 0x9c1c back to 0x9c14). Measured with custom tilesets on: the tileset's own list, Zdrt (version 1) in the list unused and worn by 25 corners, Barrens' Bdrt worn: all set it; off: plain and a painted tile, neither. All 273 maps under the game's Maps folder (77 with custom tilesets) and the 14 maps of smoketest_maps agree; older documentation's "playable area was large and never shrunk" doesn't hold for this editor. Studio: `lib/terrain/tilesetflag.ts`, applied in meleesave.ts (an absent or unreadable terrain leaves the bit); melee-corpus turns the bit over and counts the maps whose save puts it back (273 of 273).
  **Melee flag and triggers / object data** (branch melee-we-rule, 2026-11-16, SD; spec `tests/we-compare/melee-flag-we.json`, 13 cases on a new 64x64 melee map, all MATCH): the editor's open and save takes the flag off (0x9c14 to 0x9c10) for a custom unit (a w3u entry), a variable, a second (script) trigger, no Melee Initialization, it disabled, Initially On off, or one action replaced; it keeps it for an empty w3u (made and deleted: the editor writes no w3u), a renamed category, Run on Map Initialization, a changed trigger description and a custom script header. Studio: lib/triggers/defaults.ts `hasCustomTriggers`, read by meleesave.ts for a map that is melee (the set-on rule keeps the stricter `isDefaultTriggers`, which since branch fix-bugs-6 lets a renamed category and Run on Map Initialization pass too: the editor decides afresh on each save, and ConcealedHill, stored melee, names its category "Initialisierung"; melee-corpus over all of Maps/ then 258 of 258 melee maps, 0 of 15 others). The bugs.md claim that Snowblind_S2_v1.2 has custom triggers is wrong: its trigger file is the default (the root's name differs); melee-corpus unchanged (180 of 212, 0 of 11, keep 212 of 212, and no melee map of the corpus has other than default triggers). A second map in one we-drive process often failed here with "the editor exited while starting": the closed editor's exit event, heard late, was taken for the new one's (fixed in branch we-drive-fixes: six maps in one process).
- **Dialogs that don't draw at once**: Scenario > Player Properties (window "Scenario Properties") draws about 3 s
  after the click; before that it is a blank white rectangle in the hidden display. Take pictures at least 3 s after
  a click. A menu left open at `--close` can't be answered by it: never leave one open.
- **Testers' hygiene**: a number field needs Enter (`\r`) or a blur, or `change` never fires and no edit happens (a
  hidden-app dirty-flag reading looked wrong for this reason). Kill processes by PID, never by pattern: a `pkill` by
  pattern once hit another display's Proton services.
- **Copy and paste of objects** (branch paste-anchor-we, 2026-11-12, SD, a flat 64x64 map): `--key d` (doodads layer),
  `--click` on a doodad or `--drag` a box round several, `--key ctrl+c`, `--key ctrl+v`, `--move` to a spot, `--click`
  there, `--key Escape`; the clipboard stays for another `ctrl+v`. The status bar's "Point: (x, y, z)" at the pointer
  (the bottom left of `--shot-window`) gives its world position; at the opening camera the ground maps to the display
  by a plane homography (fitted from six such readings to the pixel). The editor moves each doodad onto its own grid
  when the map loads (a barrel to 64n + 32, a crate to 64n), so the copied positions are read from its save.
  Which grid (branch paste-centre-we, 2026-11-15, SD; spec `paste-centre`, input `make-paste-centre-input.mjs`; the
  pointer read from a lone pathless LPcr pasted at the same pixel first): a group with something on a grid (a doodad or
  destructable with a pathing texture, a building) moves by whole 64s: its centre, the mean of the positions with each
  on its own grid (a farm saved at 290 counts at 320), and the pointer both go to the 64 grid, then each object onto its
  own grid; a group with nothing on a grid (pathless doodads, footmen, items) puts its mean exactly at the pointer.
  Studio: placement.ts `copyCentre`, `pasteCentreAt`. A box select whose corner is near the view's top edge scrolls the
  view, and a drag that starts on a still-selected doodad's model moves it: keep boxes well inside, click bare ground first.
- **Gold mines and start locations** (branch mine-start-grid, 2026-11-13, SD; spec tests/we-compare/mine-start-grid.json):
  both stand on the 64 grid when placed, nudged, dragged or Alt-moved (a mine by its 16×16 texture, a start location as
  a 4×4 building); loading and saving leaves off-grid ones where they are. Nudged, a start location stops 64 inside the
  whole map (4032 of 4096), past the playable part. The palette's Start Location (`--key u`, `--click 1510,403`) makes
  Player 1's start a new object (editor id last, hit points and mana 0); Neutral Passive is `--click 1435,80`, `--click
  1405,424`, its first building (`--click 1383,365`, 3 s later) the Gold Mine. A click on a start location selected it
  (its circle moved with the keys) but the save kept it where it was; a box select (`--drag` from bare ground) works.
  we-compare refuses `--look`: the spec's input has the camera objects, picked as --look does (`--key m`, `--click
  1396,177` for the first row, 13 px a row, `--click 1476,119`). Placing a unit without a texture (Phoenix Egg) is free:
  it stood at -1899.459, 500.253 where -1900, 500 was aimed through `proj.py`'s projection.
- **Doodad rules while editing** (branch doodad-rules-edit, 2026-11-13, HD, empty_map_on_newest_world_editor.w3m with a
  barrel LTbr at 32, 32 scale 1.2, a log AOlg (12x6 texture) at 1056, 0 facing 0, wheat LPwh (no texture); saved after
  each step): an 8 px drag of the barrel (about 20 units at the opening camera) didn't move it, an 18 px one put it at
  96, 32: dragged doodads stay on their grid (whether it jumps during the drag or at the release a picture can't tell
  with one `--drag`). `+` (`KP_Add`) ten times then `-` three times took the barrel's 1.2 to 1.35, not 1.55: the scale
  is held to the type's range (1.1 to 1.5) at once. The numpad `/` turned the barrel and the wheat freely (by 5° to 15°
  per press, depending on how long it was held) but the log a quarter per press (three: 0° to 270°, its place on the
  grid of 270°). Ctrl+arrows moved nothing, wheat included, and `]` turned nothing: not the editor's keys in this
  build. A `--click` on the wheat or the log may miss; a `--drag` box from bare ground round it selects it (a box
  starting on a doodad drags it). doodadedit.ts follows this.
- **Doodad facings and turned ranges on load** (branch verify3-p6-diffs, 2026-11-13, SD, the 212-doodad map of
  verification round 3 package 6 with 26 more, opened and saved): a destructable's fixed rotation is enforced (LTlt
  fixedRot 270 at 30, -90, 400 saved 270; LTt0 0 and ATt0 90 likewise, before the quarter turn of their 24×12
  texture), a doodad's isn't (YZef 270 at 30 stays 30); every other angle comes into 0..360 by whole turns in single
  precision, doodads and destructables, with or without a texture (1080 and 720 to 360, -720 to 0); a range the wrong
  way round saves every scale at its least (the map's LTex 1.5 to 1.1, LPfp 1.4 to 0.9); the tree bridges' doubled
  minScale/maxScale lines count by their first. doodadgrid.test.ts and doodadrules.test.ts hold the cases.
- **Unit Properties**: `--key u` (units layer), `--click` on the unit, `--key Return` opens the dialog (two clicks are too
  slow for a double click). Its tab strip moves two tabs per click or arrow key in this display: `--click` on General,
  `--key Right`, `--key Left` lands on Abilities. The Skin button on General opens "Choose Skin", which does draw (a list
  of the kind's types, filter All/Standard/Custom and a search box); a random unit's second tab is Random Unit (Random
  Unit Type: Any Neutral Hostile Unit, From Random Group, Use Custom Table with New/Delete/Edit Unit). Found so on copies
  of cliff.w3m (branch unit-props-2, 2026-11-10): the editor draws a placed unit's skin and its Custom Color only where
  the type allows a custom team colour (`utcc`, not "is a waygate"), and its script switches a custom ability on by
  its base's order.
  Placed destructables and doodads (branch skin-row-dest, 2026-11-13, empty 64x64 map, doodad layer `--key d`, click, Return):
  Doodad Properties has a Skin button at the end for both (a destructable's General tab: Variation, Z, Scale, Life, Skin;
  a plain doodad's: Rotation, Roll, Pitch, Scale, Skin); Choose Skin lists the kind's types (destructables for a tree).
  Choosing LTe1 for an LTlt and saving wrote skinId LTe1 in a version-13 doo, id and life unchanged.
- **Wheel zoom** (branch wheel-zoom-pivot, 2026-11-13, cliff.w3m, SD): each notch changes the camera distance by 1.1
  and keeps the camera target fixed, the eye sliding along the ray to it, wherever the pointer is: three notches in
  with the pointer at the view's middle, top left and bottom right all expand about (593, 325.5) of the 1184x844
  view, the target's place in the off-centre projection (focus of expansion of matched patches, residual 1.5 px).
  Studio zooms about the same point (wheelzoom.ts `zoomStep`).
- **Keyboard zoom and the zoom's row** (branch key-zoom, 2026-11-13, cliff.w3m, SD; numbers and the patch matcher in
  `target/evidence/key-zoom/` of that worktree): Ctrl+Up and Ctrl+Down are a wheel notch exactly (Ctrl+Up then a notch
  out gives the opening picture back to the pixel, a notch in after Ctrl+Up's undo the Ctrl+Up picture), wherever the
  pointer is. Held, they step once per key repeat (400 ms: one step; 1500 ms: 22, the display's repeat starting after
  660 ms at 25 a second). Page Up and Down, the number pad's + and -, and Ctrl+Page Up don't zoom. `--screen` gave
  other view sizes (moving the window by X doesn't: the editor doesn't lay it out again): the zoom keeps the middle
  column's point at row 325.0 of an 844 high view, 222.6 of 592, 220.2 of 585 and 211.7 of 565, whatever the width:
  0.4057 h - 17.4 (within 0.3 px), not a share of the height (325.5 / 844 misses the small views by 6). Studio uses
  that row for wheel and keys (wheelzoom.ts `zoomPivotRow`).
- **Random groups** (branch scatter-we, 2026-11-14, SD, `tests/fixtures/we-compare/random-group.w3m`: group 0 with lines
  footman, knight, rifleman and one placed unit of it; spec `random-group-scatter`): the editor has no scatter brush for
  units and no palette entry for a group (Neutral Hostile's palette has one Random Unit, by level, the red "?" at
  1478,333); several group units at once come from a paste. Its save numbers every pasted object on (a two-unit paste:
  editor ids 3 and 4), uDNR with random type 1, group, position. A placed group unit is drawn as one of its group's lines
  under a "?" from the start (which one differs per start). Advanced (260,41) has Cycle Random Groups - Next / Previous
  (Ctrl+= / Ctrl+-; `--key ctrl+equal` did nothing, the menu item 320,334 works) and Auto Cycle Random Groups (Ctrl+G,
  on): with it on the drawn line changes by itself every 2 to 5 s with no input at all, both ways round the lines (15
  pictures 2.3 s apart: F F R K R R R F R F K K F F F), and stays after Ctrl+G turns it off (10 pictures alike). It is
  not tied to placing: pastes changed the line or not as the timer had it.
  Studio: randomplace.ts `startAutoCycle` (2 to 5 s, uniform random line), the line starts random per open; app-smoke placerAndCampaign.
- **Light Ranges** (branch light-radius, 2026-11-13, HD, `--look X,Y,3000,270,70,90` straight down, copies of the
  empty map with imported copies of the Ruins Brazier's HD model, one light value changed each; numbers in
  `target/evidence/light-radius/` of the main checkout): one ring per light on the ground under it, in the light's
  colour, its radius set by the brightness alone (intensity times the colour's length; not the attenuation, not the
  object's scale), animated with the intensity track. Studio's fit: viewmodes.ts `lightRangeRadius`. In SD no rings
  were drawn. Closing the editor with Light Ranges on ended in its crash dialog each time (`--close` times out).
- **Loading**: big maps (4v4 Mount Hyjal) show a window titled "Progress" ("Loading Units n/300") for several
  seconds; `--wait-ready` waits for it (up to `--timeout`) instead of reporting it as a question.
- **The View menu** (`--view-menu`): Foliage, Doodads, Units, Water, Blight, Shadows, Lighting (L), Weather and
  Info Display are checked by default; Sky, Fog Effects, Light Ranges, Bloom, Ambient Occlusion, Grid, Camera Bounds,
  pathing, Regions and Camera Objects aren't. With game view on, these items are greyed and read as unchecked.
  G goes round the grids: none, large (yellow every 512), medium (white tiles, yellow every 4), small, none; the
  Grid item reads unchecked whatever is shown. B draws a thin light-blue line on the ground at the camera bounds
  (HillsbradCreek's west edge, mostly hidden behind trees). `--move` to the view's edge didn't scroll it in this
  display (checked 2026-11-10, SD).
- **Time and lighting**: with the day fixed (we-drive's default) the status bar says "Time: 06:00". Measured
  2026-11-08 at the opening view (pic-compare, whole picture), the editor's three states hardly differ: on cliff.w3m
  game view off with View > Lighting on, with it off, and game view on are within a mean absolute difference of
  0.7 and 1.3; on map 03 (Water Ford Lake Boats) 2.5 and 3.0. In SD that holds for any light (the classic picture
  clamps the light to 1); in HD it holds for map 03, but cliff.w3m's own strong lighting makes its game view much
  brighter than the editor's light (green about 233 against 123). The rest of the colour difference to Studio was
  the HD picture's tone (`lib/model/tone.ts`).

### Verification rounds: one build, many testers, one World Editor session

**One build per round**: `node scripts/verify-build.mjs [--commit REV] [--tester NAME] [--json] [--no-cli] [--force]` (in `app/`)
`git archive`s the commit into `target/verify/<short-sha>/` of the main checkout, runs `npm ci`, builds the smoke app
(`appctl.mjs buildApp`, debug, sccache through the main checkout's `.cargo/config.toml`) and the release CLI, and writes
`verify.json`. A commit already built is not built again (the second caller prints at once); two callers at once take
turns (a lock folder next to it). It prints the binary, the CLI and the command lines for a tester named NAME:

- app-drive: `node scripts/app-drive.mjs --app <binary> --work <own folder> <steps>`
- app-smoke: `W3_APP_BIN=<binary> W3PROJ_BIN=<cli> W3_SMOKE_DIR=<own folder> node scripts/app-smoke.mjs --only=<check>`
- we-compare: `node scripts/we-compare.mjs --app <binary> --work <own folder> <spec.json>`

**Pruning**: each build is about 3.8 GB, so before building a new commit `verify-build` deletes the older ones and
keeps the newest N (`--keep N`, default 2, `0` = keep all): `target/verify/<sha>` and `target/verify-runs/<sha>`, nothing
else (it refuses any path not directly under those two folders of the main checkout). A build with a `.lock` folder, one
whose runs folder changed in the last 2 hours (a tester may be using it) and the commit being built stay. It prints what
it removed and the space freed. `--dry-run` prints that without deleting or building.

`W3_APP_BIN` (or `--app`) makes `appctl.mjs`, app-drive, app-smoke and we-compare run that binary and build nothing.
Settings (`<work>/config` for app-drive and we-compare, which make and remove it and never take `W3PROJ_CONFIG_DIR`; app-smoke's `W3PROJ_CONFIG_DIR`, default inside its folder) and the webview's storage (`XDG_DATA_HOME`/`XDG_CACHE_HOME`
under the work folder, Linux) are per run, so testers sharing a binary share nothing. The identifier of the build is
the same for all (`W3_SMOKE_ID` only names the build). Proven with two `app-drive` and two `app-smoke --only=byHand` runs
at once on one binary. Costs (this machine, sccache warm): archive 0 s, `npm ci` 3 s, app build 142 s, CLI about 10 s more.

**we-compare** (`node scripts/we-compare.mjs [--app P] [--work D] [--json F] [--no-we] [--strict-ignore] [--keep-prefs] [--allow-stale] <spec.json…>`, local only like
we-drive): the common check "do the same in the World Editor and in Studio, save both, diff the saved files". A spec
(the list of fields is at the top of the script; `tests/we-compare/examples/` has three from verification round 3
package 6) names the input map (copied; `${MAIN}` is the main checkout), the World Editor's steps (we-drive's steps
between "map ready" and the save), Studio's steps (`mcp`, `eval`, `sleep`, `open`, `terrain`, `setting`, `command`; the
project is the input unpacked, or a `new_map` made by steps), and the files to compare. All specs of one mode go to
**one we-drive process**: one display, one setup, one lock and ONE editor (each next map is opened in it, `--map` on the
running editor; `--restart-per-map` is the old editor start per map, for timing). Measured 2026-11-13, 4 small maps, warm: 75 s
by restart, 47 s by open (an extra map costs about 9 s instead of 18 s; the start of a cold prefix is longer). Both saves are unpacked with the release CLI's codecs and compared per file: `parsed`
(the codecs' JSON, field by field: `doodads[3].angle: WE 4.71, Studio 0`, with the count of fields and of differing
entries), `wpm` (cells with x, y and flags), `text` (lines), `bytes`. `"expect": "differs"` marks a known difference
(not a failure); `"expectPaths": ["players[].start", …]` (JSON kinds) says which: every listed path must differ and no
other may, else the file is UNEXPECTED. A w3e difference whose corners change from run to run or cover the whole map
takes `"expectCorners": [{ "box": [x0, y0, x1, y1], "fields": ["texture"], "we": 1, "studio": 0, "delta": 512,
"corners": [min, max] }, …]` instead: every differing field must be claimed by a rule (the first whose box, fields and
values fit; no box is the whole map, `we`/`studio`/`delta` optional) and each rule's count of corners must lie in its
range, so a difference anywhere else, in another field or of another size stays red. Without either any difference passes, so a `differs` without `expectPaths` is
refused: on a JSON kind (name the paths) and on `text`, `text-set`, `text-exact`, `bytes` and `wpm` alike (compare the
file as a JSON kind, or narrow it with `lines` and expect a match), unless `tests/we-compare/differs-without-paths.json`
lists it ("spec-name file" in `entries` for the JSON kinds, `textEntries` for the others: written before the rule; both
only shrink, `we-compare-runner.test.mjs` fails on a longer list or an entry no spec needs). `tolerance` is a number for
every path or `{ "doodads[].z": 1, "camera": 4, "default": 0 }` (the longest matching pattern wins, `default` else 0),
so a tolerance for one field doesn't hide another. A file missing from a save is MISSING and one that can't be read (a w3e cut short, a file that didn't unpack
as JSON, a BLP that doesn't decode) is ERROR: neither is ever the expected difference. A `parsed` file of the World
Editor's save that `w3proj verify` doesn't get back byte for byte is ERROR too (the codecs' JSON on both sides would
hide what they lose). `text` normalises CRLF to LF; `text-exact` keeps line endings (the map's own bytes; the
`header-*` specs use it). `tolerance`, `ignore` and
`expectPaths` are refused on `text`, `bytes` and `wpm`; `lines` (a regular expression, `text` and `text-set` only) keeps only the
matching lines of both saves, and none matching in a save is ERROR (two empty texts would match); a text kind on a
binary file (a NUL in it) is ERROR; the minimap's tolerance is for its colours, not its size. A file of the checkout
that a `--type` text or an eval names (`${REPO}/target/import-modes/Rabbit.mdx`) must exist, else the spec is ERROR
naming the `make-*.mjs` that writes it (both sides would import nothing and match).
**Editor state between specs**: specs of one mode share one editor, so what a spec toggles stays for the next one
(Ctrl+Shift+W, Ctrl+Shift+H, a palette pick, a tree's scroll). Set, don't toggle: `--numlock on` instead of
`--key Num_Lock`; `"we": { "freshEditor": true }` closes the editor before the spec and starts a new one for it (its
preferences written again); `"we": { "prefs": { "Misc": { "Key": "value" } } }` writes WorldEditPreferences.txt keys
before each start of its editor (specs with other prefs get a we-drive process of their own). `"we": { "expectCrash":
true }` closes the editor right after the spec's save and fails the spec when it doesn't crash there
(close-crash-light-ranges). Every we-drive process runs with `--expect-layout`: an editor window of another size or
place fails all its specs with one message. An
`ignore` pattern that names no path of either file is listed as a warning (`--strict-ignore` makes it fail the file).
A missing input map is that spec's ERROR (naming the `make-*.mjs` that writes it); the rest run. After each spec
Studio's settings that it changed, the `w3.window` functions its evals stubbed and its `window.__*` globals are put
back; a Studio save that leaves an editor unsaved, or a failed terrain rebuild, fails the spec. A World Editor crash
while closing after the save is a warning in the report, the save kept.
Exit 0 as expected, 1 not (or MISSING), 2 something couldn't run (ERROR included), 3 `--no-we` (nothing compared, NOT
COMPARED); the JSON report is `<work>/report.json`. The work folder is locked (`we-compare.lock`): give parallel runs
their own `--work`. Kinds that can give a false DIFFERS between two random draws: `w3e-variation` (a value worn by
about 5% of a texture's corners sits on the cut), `doodad-places` (a doodad at a 64 square's edge), `w3e-spread`
(a rare offset drawn in one run only): rerun before calling it a finding. Unit tests: `we-compare.test.mjs`,
`we-compare-w3e.test.mjs`, `we-compare-runner.test.mjs`. It isn't in the gate (the gate has no World Editor step); run it by hand with a
`W3PROJ_WE_DIR` of its own and `we-setup.mjs --clean` afterwards.

Saved-file specs of package D (branch we-specs-d, 2026-11-14; `ramp-wpm`, `boundary-wpm`, `doodad-snap-custom`, `map-size-38x42`, `paint-variation`; inputs and generators `make-doodad-snap.mjs`, `make-odd-size.mjs` in `tests/fixtures/we-specs/`): compare kind `w3e-variation` (per texture the corner count and the ground variations that 5% of its corners wear: the draw is random). The editor's palette: Blight 1552,111, Boundary 1552,143, Remove Boundary 1552,175, Ramp 1505,311. Known differences recorded as `expect: differs`: its Blight brush also turns corners round it to the map's second ground tile (`boundary-flags-wpm`'s w3e). Boundary matches since branch boundary-we (2026-11-14): its brush is centred on the lower-left corner of the tile under the pointer, not the nearest corner (16 size-1 clicks at 0.2 to 0.8 of a tile, sizes 2, 3, 5: 5, 13, 49 corners round that corner), and its wpm makes a tile whose lower-left corner is painted 0xce, the border's byte, over a cliff or water alike, 0xee when blighted; Remove Boundary frees it. A palette tile (Boundary, Blight) picked after a water brush leaves the water brush on: the next click paints water too, so a spec picks the water last.

Ramp specs (branch ramp-we, 2026-11-14; `ramp-wpm`, `ramp-plateau` on `plateau.w3x`, a rectangular level-3 plateau from `make-plateau.mjs`): the editor's Ramp click flags one line of three corners down the cliff from the corner nearest the click (its high corner, or the one below it), whatever the size; on a plateau's corner both lines and the corners between (3x3); nothing beside a bend in the cliff; a drag flags a line at each corner it passes; a second click on a built line leaves it (Studio's takes the ramp off: `ramp-plateau-twice`, expect differs). The editor's ground pick over a cliff lands about 0.125 tile nearer than the slope between the corners (Studio's `pickHeightAt`; click 360,450 on the west face: row 31, the plain slope's 31.57 rounded to 32; `ramp-plateau-west` matches). Still open: clicks on the low ground in front of a face (west face y 380..440, south face 700) build nothing in the editor, a line in Studio. Screen to corner on plateau.w3x with the editor's opening camera (Studio's pick, the same as the editor's): on the south face (high row 27) the editor's Ramp builds at y 630-670 (nearest row 27 or 26), not at 590-610 (row 28) or 700 (row 25); x 450/550/650/750/850/950 are columns 27/28/30/32/34/36.
Ramps on a 45-degree diagonal cliff (branch we-compare-4, 2026-11-18; spec `ramp-diagonal`, input `diamond.w3x` from `make-plateau.mjs <cli> <game> diamond`: level 3 on |x-32|+|y-32| <= 8, each face a staircase of single corner steps; where a click lands was read from the status bar's Point after `--move`, as corners 32 + world/128): no click or drag on a high step, the plateau, the low ground or the south tip (a lone high corner: a line needs the cliff edge to go on beside its high corner on one side) flags anything, nor a drag along a face over its high steps. A click on a low step (high beside it along x, along y and between) flags the 3x3 block round it, but only when it lands inside the tile of those four corners: 27,28's block from 27.16,28.09, 27.17,28.22, 27.34,28.03, not from 26.93,28.01, 26.98,28.15, 27.15,27.96 (all nearest 27,28); 28,27's from 28.12,27.13, 27.998,27.27, 28.32,27.20, not from 28.20,26.995 or 27.83,27.35. A drag across a face flags the block of the low step it passes that way. The editor's Point z is the tile split into two triangles from its bottom-right to its top-left corner (13.8, 22.3, 34.0 where that fits). Studio: cliffs.ts `rampClick`. A pick-height rule (a quarter level up the cliff) fitted the diamond too but not plateau.w3x's west face (built from 24.03,31.46, 3.9 up); a "click on the high side of the low corner" rule for straight faces broke ramp-plateau-north, where Studio's pick over a face turned away lands behind the low corner (the editor's on the face at 32.04,35.35): straight faces keep the nearest-corner rule.
Package E (branch we-specs-e, 2026-11-14; specs `water-limit-low`, `map-size-limits`, `script-inputs-e`; inputs `make-low-ground.mjs`, `make-script-inputs.mjs` in `tests/fixtures/we-specs/`): with the editor's Enforce Water Limits on, a water brush on ground below about -1792 (Deep) or -1920 (Shallow) world units makes the editor raise the ground under the brush to that height (stored -7168 and -7680: -2048 with the cliff level counted in), with a cosine ring round each lifted corner; the water level stays where the old ground put it (at -2048 ground it is stored as 0, the lowest). The rule (branch water-low-header-we, 15 flat heights, sizes 1, 3, 5, and uneven grounds; fixture `tests/fixtures/water-brush/low-ground-lift.json`) is `waterrim.ts` `liftToFloor`; sizes 1 and 3 match exactly, size 5 doesn't yet, and the six specs MATCH. Map Size (Scenario > Map Size and Camera Bounds, 210,112; Modify Map Bounds 444,536, ticked state not kept between clicks of a fast run: sleep 60 between arrow clicks; right edge arrows 733,333 (in) / 753,333 (out), left 463,333 (out) / 482,333 (in), top 608,197 (out) / 608,217 (in), bottom 608,447 (in) / 608,467 (out); OK 819,831): one click is 4 tiles; the smallest map is 32 per side (10 clicks in from 64 stop at 32), the largest 480 per side (a coordinate limit of 32256 on the outer edges stops growth first on one side), 480 x 480 (230400 cells, Description "Legendary") is accepted with only a "Computing pathing map" bar, so the "exceeds the limit of %d cells" text is not reachable from the dialog. Growing to 480 x 64 puts the playable width at 472 (Studio 468). Custom gameplay constants (war3mapMisc.txt with one value) clear the Melee flag in the editor and in Studio (0x9c14 to 0x9c10); a trigger with Initially On off and Run on Map Initialization on is saved with both flags, `DisableTrigger` in the script and no RunInitializationTriggers entry, as Studio writes it; a custom script header of spaces or of tabs and spaces is written as it is, one of line breaks only ("\n\n") gets the second "Custom Script Code" banner and three empty lines (the header's LF breaks kept, then the editor's CRLF), in war3map.lua three empty lines; Studio writes the same lines (with CRLF) since branch water-low-header-we (specs `header-newlines`, `header-newlines-lua`, `header-spaces-lua`). The AI Editor (F8; tabs General, Heroes, Building, Attacking, Test Configuration at 507,234, Disable Fog of War 176,321, Disable Victory/Defeat 176,339, defaults fog off and victory/defeat on) saves .wai files by bare name into Documents/Warcraft III/Campaigns of the farm's prefix (a path in the name is refused); the saved option word is 1 with fog ticked and victory unticked, 3 with both ticked (bit 1 fog, bit 2 victory/defeat: Studio's mapping, `lib/ai/wai.ts` gameOptions). we-compare reads maps only, so no spec for it. `start-under-water-we` needs `--key t` first (the palette) to hit the start; it matches Studio now.

Map Size rules (branch mapsize-we, 2026-11-14; spec `map-size-limits`, 15 cases, new 64 x 64 and 96 x 64 maps, borders 6 6 4 8): a click moves the map's edge and keeps the border, until the edge would pass ±32256 (`resize.ts` COORD_LIMIT; 55 clicks from a 64 map, 51 on the right of a 96 one); each click beyond moves that side's playable edge and camera bounds out by 4 instead, taking the border down to 0 (6, 2, 0 on the left and right, 8, 4, 0 on top, 4, 0 at the bottom; then the arrow does nothing): 480 x 64 is playable 472, camera right 31488. Studio refuses growth past ±32256 (`coordProblem`, 2026-11-17), so the spec's Studio steps ask resize_map for the editor's result (change and border). A start location strictly inside the new map stays where it is, also past the playable edge (the top cut by 32 left (0, -256) 768 past it): units flag 1 (outside) and the save takes Melee off (`meleesave.ts` startsPastPlayable; none of the 18 smoketest maps has a start past its playable edge). One on or past the map's edge is removed and the save (its "Warning") makes a new one at a random place in the playable area, on the 64 grid, hit points and mana 0, the w3i's player start a few units beside it: (-1344, -2944) and (-2688, -2176) for the same cut, so the specs ignore those fields; Studio moves it into the camera bounds (`startAfterResize`).

Diagonal fences and angles (branch rotated-footprint-we, 2026-11-15; `tests/we-compare/fence-wpm.json`, inputs from `make-fence.mjs`, `angles`, `ints`): a diagonal pathing texture (Fence45, Fence135, ShortFence135) turns by quarters cell for cell as `pathing.ts` stamps it, the scale doesn't count, and example map 22's played Fence 1 gets the editor's own war3map.wpm. Opening a map, the editor reads a stored angle that is a whole number as degrees (2.0 is 2 degrees: a rectangle turns to 0), any doodad (doodadgrid.ts `openedAngle`).

Angles the editor reads on opening (branch snap-angle-we, 2026-11-15; specs `fence-neg`, `fence-dest` in `fence-wpm.json`, `neutral-facing.json`; inputs `make-fence.mjs neg|dest`, `make-neutral-facing.mjs [neg]`): every whole number is degrees, negative and above 360 too (-2 is 358, 361 is 1), and -1 is 135 (every copy, every type: a rectangle's quarter turn of it is 180, the old "-1 came back as 180"); -0.5 and -3.14159 stay radians. Destructables without a fixed rotation (LTbr, YTpl, LTcr, OTsp) read them as doodads do. Game doodads stored with flags 0 and 1 snap as with 2 and are saved with the solid flag. Units of every kind (gold mines, taverns, goblin merchants, barracks, footmen) keep their facing, drawn turned in the editor's view as in Studio's (no fixed facing for neutral buildings), but read a whole number as degrees, -1 as 135, and come into 0..360 by whole turns (-0.5 to 5.78, 400 to 40 degrees, 360 stays 360): doodadgrid.ts `openedUnitAngle`, applied on open with Snap Doodads on Load. The editor has no switch for its snap on load (no such string in WorldEditStrings.txt): the setting off is Studio's own. A water click under Enforce Water Height Limits (`water-floor-e-*` in `water-limit-low.json`, `low-ground-e.w3x`: level-1 ground at -2176, the clicked corner at -2048) lifts every corner of the map below -2048 to it, not only round the brush; the open alone doesn't (`low-ground-e-open`). The editor reads the ground word in its low 14 bits: stored -8400 (word -208) opens as 7984 (`low-ground-d-open`).

Doodad grid spec `doodad-snap-grid` (branch doodad-onepixel-grid, 2026-11-14; input from `make-doodad-snap.mjs grid`): all-magenta custom pictures 1 to 8 pixels, each placed at 16 offsets at 0 and 90 degrees; per axis a picture n pixels long stands on 64n + floor(n/2)*32 (1 on 64n, 2 and 3 on 64n+32, 4 and 8 on 64n), halves going up.

Terrain edits, drops and facings against the editor (branch verify-we-c, 2026-11-16, SD; specs `terrain-edits-we.json`, `drops-we.json`, inputs `make-uniform-heights.mjs`): Y (Set Uniform Doodad Heights, no dialog) on five carts, three on slope ground and two fixed at 100 and 300, gives the selection's mean and flags 6 in editor and Studio alike (`uniform-heights`); Adjust Cliff Levels +1 and -1 on `plateau.w3x` match corner by corner; the editor opens the maps Studio saved after those edits (`from: studio`) and saves them back unchanged. Drops given by place_objects show in the editor's Unit Properties > Items Dropped tab (two sets: Random Any Level Item, Random Level 5 Charged Item) and its save keeps them (`drops-we`). `neutral-facing(-neg)`, `replace-units-overlap-mine` and `mine-start-grid` (box-selected start location) run MATCH on this commit. A second we-drive process of one we-compare run could fail at its first map with "display :1 is not an Xvfb started for tests" (seen twice): the guard dropped the Xvfb when one of its fds closed during the scan; it now skips that fd and asks three times (branch we-drive-fixes), and a dead Xvfb is said as "Xvfb died".

Doodad turn keys and `_` destructables (branch doodad-turn-we, 2026-11-14; spec `doodad-turn-we`, input `make-doodad-snap.mjs turn`; box select, Num_Lock first for the number pad's digits): the number pad `/` turns a doodad with a mixed square picture a whole quarter per press (4x4 ring 270 to 0 in one, 2x2 diagonal 270 to 90 in two), a one-colour square one by 5 degrees (270 to 275). Number pad 6 nudges a destructable without a pathing texture by 8 and leaves its angle (a fixed rotation 90 stays at 22.9), one with a 2x2 texture to the next grid point (64) at its fixed 90. A destructable with a fixed rotation but no texture, placed from the Doodad palette (rows at 1410,184 + 13 per row), gets a random angle and stays where it was clicked; with a texture it faces its fixed rotation on its grid. Studio: doodadedit.ts `doodadTurn` (mixed) and `objects.type` (no fixedRot once the texture is read, `ready`).

Sound Editor order (branch sound-order-we, 2026-11-14; specs `sound-order-move`, `sound-order-sort`, input `make-sound-order-input.mjs`; F5 opens the editor, rows at 428,193 + 14 per row, its Edit menu at 139,131): Edit holds Increase/Decrease Sound Volume (Ctrl+Pg Up/Down), Increase/Decrease Music Volume (Ctrl+Shift+Pg Up/Down), Move Sound Variable Up/Down (Ctrl+Up/Down), Sort Sound Variables (Ctrl+R). Move swaps the selected sound with its neighbour in war3map.w3s (the first Up and the last Down do nothing); a save keeps every sound's volume field, whatever the volume keys did: they are the editor's playback volume (Decrease is greyed at the start; clicking Increase in its menu with the audio off crashed the editor, so the step size and range are not measured: Studio steps 10% within 0 to 1). The editor saves an empty `file` for a game sound it can't find under the path the map gives (also .ogg, which the game's storage holds), so the specs ignore `sounds[].file`. A module window left open (Sound Editor) ended the next `--map` of a run: `--close-modules` closes it first (`--save` also no longer stops on it).

Replace, square brush, margin (branch we-specs-d2, 2026-11-15; specs `replace-units`, `brush-square`, `enforce-limits-margin`, input `make-replace-input.mjs`): the Advanced menu (260,41) holds Replace Tiles 288,223, Replace Cliff Type 288,240, Replace Doodads 288,257 and Replace Units 288,274 (the Edit menu has no Replace). Replace Units ("Replace Units", 460x480 at 450,258): Old Unit Type's palette on the left (Human's Peasant 471,365, Footman 503,365), New Unit Type's race 733,290 (Neutral 705,361, then a filter box at 795,339: `--type "Gold Mine"` leaves one icon at 701,422), Swap Both Unit Types 461,711, Selected Units Only 461,728, OK 791,725; every footman became a Player 1 gold mine on the 64 grid nearest it, halves going up (Studio's replace_objects). The Shape buttons (Circle 1392,624, Square 1424,624) on Grass and on Level, Increase One and Decrease One give the square of half side size - 1, and the cliff brushes type the square one corner wider (Studio's `cliffTypeStencil` square). Enforce Terrain Limits changes nothing for a texture stroke, a placed tree or a paste in the margin past the playable part (the editor paints to the map's last corner; a footman's paste there is refused either way). A pasted pathless doodad (LPcr) lands at the pointer, inside the playable part too (`limits-*-paste-margin`; Studio matches since branch paste-centre-we). Replace Doodads ("Replace Doodads", 460x377 at 450,310; spec `replace-doodad-grid`): Old Doodad's category box 563,363 and New Doodad's 793,363 drop down Bridges/Ramps, Cinematic, Environment, Pathing Blockers, Props, Structures, Trees/Destructibles (y 459), Water at 13 px steps from 381; the lists start at 408, 13 px a row, in their own order (Trees/Destructibles: LTlt, LTbs, LTbr, LTbx, LTex, LTba, LOcg, LTcr), no filter box; Swap Both Doodad Types 461,643, Selected Doodads Only 461,660, Reset Variations 461,677, OK 791,674. A barrel (2x2) replaced by crates (4x4) goes to the 4x4 grid, halves going up; one whose crate would overlap a tree's pathing stays a barrel. A Ctrl+V paste places once: a second click without another Ctrl+V places nothing. Leaving a menu open by `--key Escape` keeps the menu bar's focus, and `--close` then times out: click the menu's title again to close it.

Camps, Replace Doodads on a real map, TurtleRock (branch we-package-specials-camps, 2026-11-16, SD):
**camp grouping** (`tests/fixtures/we-specs/make-camps.mjs`: camps.w3x, camps-b.w3x, `far D1,D2,D3,D4` for camps-far-*.w3x; no
spec file, we-compare has no picture specs): the editor shows a camp only as an icon on its minimap, "Show Creep Camp
Icon" (22,225 under the minimap; the editor keeps it ticked or not in its preferences, `[Minimap] Show Creep Camps`, which
we-drive unticks before each start since branch we-drive-fixes: the "first click doesn't take" was the box left ticked by the
run before, six runs in a row alternated; one click after `--wait-ready` ticks it, check it in a `--shot-screen`; the minimap crop (10,75)-(152,200) zoomed 5x
reads well, 1 px about 11 units), a grey dot per creep, a coloured icon on one creep of each camp: green below 10 (a lone nmrl,
a lone ogre lord 7), orange at 10 (a Green Dragon) and for 7+7+1=15, red at 20 (two Green Dragons): the levels added up,
Studio's bands. **Grouping**: pairs of murlocs 400, 450, 500, 600, 650, 700, 750, 800, 816, 824, 828 apart each show one icon and
one dot, 832, 1000, 1200 and 1500 apart two icons: the limit is 832 = 26 cells of 32 (CreepCampPathingCellDistance=26), not
Studio's 450 (meleecheck.ts `SAME_CAMP`, dropsview.ts). Not transitive: a creep joins a camp by its distance to the camp's
icon creep (five murlocs at -1500, -900, -416, 416, 1200: icons on the 1st, 3rd and 4th; a chain of three 400 apart: one icon,
on the middle one: see below, that was a neighbour camp's doing). Diagonals (branch camp-icon-we, 2026-11-16; maps camps-c/d/e/f.w3x from `make-camps.mjs c|d|e|f`, icons read by `read-camp-icons.py` from a `--shot-screen` and the generator's `.layout.json`, results in `camps-icons-we.json`, unit test clusters.test.ts): the distance is the straight one, whatever the direction: 588 on both axes (831.6) one icon, 589 (832.97), 600, 700 two; 820x100, 700x440, 440x700, 826x50, 831x40 (831.96) one, 831x45 (832.2), 100x832 two. The icon is on the first creep of each camp in the order of the map's units (chains of three 400 apart in all six orders, a chain 0/300/700 either way, vertical chains, a chain of four 300 apart: icons on the 1st and the 4th), so the "middle creep" above was camps-b's lone murloc and ogre lord 800 from the chain's ends taking them in. Studio's `campGroups` matched already; only its comment changed. The first click on "Show Creep Camp Icon" failed in 4 of 8 runs (the box kept from the run before, see above; fixed); a run without a tick shows grey dots only, so read-camp-icons.py prints empty icon lists then.
**Replace Doodads on HillsbradCreek** (spec `replace-doodads-hillsbrad`, Advanced > Replace Doodads: old tileset box
663,341, "Herbstliches Lordaeron" 513,515, [FTtw] first row 520,408; new LTcr kept from the earlier run): of 2786 FTtw the editor
replaced 2692 and says "94 doodads could not be replaced in their current locations" in the view; Studio replaces 2701
(85 left): nine crates the editor refuses, in rows of FTtw/LTcr 128 apart, e.g. (7616,3648), (7168,5568): they touch only the rounded no-build (blue) 2x2 corner of a large rock (BRrs, 12x12), and the editor counts other objects' blue cells as room taken (Studio's roomShape, branch replace-doodads-we: matches, 94 refused). The new variation: 0 and 1 stay, 2 to 9 become 0 or 1 at random (Studio's `variationAfter`), so the spec ignores variation.
**TurtleRock v2.0** opens in the editor with no dialog and no message (the unused cliff type CLno), `--map` then `--wait-ready`.
**Specials** YCr3, LCc0, YCx7 (AutumnLeaves_S2, tiles (16,37), (108,55), (13,24)): not measured; the editor's picture of them
(cliff models, flat shot from `--look`) can't be told from Studio's by eye for facing or height, and nothing in the editor reads them out.

Replace Units and room (branch replace-units-overlap, 2026-11-15; spec `replace-units-overlap`, input `make-replace-units-overlap-input.mjs`): the dialog keeps the last race of New Unit Type, so a spec sets it first (race box 733,290, Human 705,309; Human's filter box is 795,315 and typed German names found nothing: click the icon, Buildings row 1: Farm 797,525, Altar 829,525, Barracks 861,525; the header `Units: [hhou] Hof` names the pick). A footman that would become a building whose footprint covers another object stays a footman, as for Replace Doodads; the footprint takes in the texture's no-build (blue) part, so a barracks (8x8 no-walk in 12x12) or gold mine (8x8 in 16x16) is stopped by a tree its red part misses, and a farm by a barracks' ring. The editor has no Replace for a selection (Edit menu, Unit Properties).

Water for ships (branch ship-ford-rule, 2026-11-15; spec `ford-wpm`, input `make-ford.mjs`, no edits on either side): the editor's save makes the pathing map itself (the input's is stale). Water 2.4 to 51.9 deep is 0x08 (ships and footmen), 52.4 to 160.4 deep 0x0a (ships only): every whole tile under water is ship water whatever its depth, the 52 walk limit is the only threshold. Studio's `generatePathing` matches (pathing.test.ts); its naval view is red only where 0x40 is set.

Sound flags and new sounds (branch sound-flags-we, 2026-11-15; spec `sound-flags-we`, inputs `make-sound-flags-input.mjs`; the spec's description has the values): the Sound Editor's File menu (109,131) holds Use As Sound (147,271, with a file selected in the tree), Use As Music (Ctrl+M), Replace Internal Sound (175,314, Ctrl+P), Import Sound (Ctrl+I), Export Sound, Remove Imported Sound. Its Open dialog takes a typed path: a `--type` step's `${REPO_WE}` is the checkout as the editor sees it (Z:\… on Linux), an `eval`'s `${REPO}` its path for Studio. The tree keeps its scroll and open folders for the editor's session (another map opened in it too), so a spec clicks a row and presses Home before it clicks a folder. The Sound Properties dialog (a row, Return) has File, Variable, Looping, 3D sound, Volume, fades, Pitch, Effect, Channel and the distances, no dialogue, speaker or music fields (a Dialogue folder sound too): a keyed dialogue sound can't be made there.

Regions and Pathing - Ground over the playable map (branch region-fill-we, 2026-11-14; pictures, no spec file: `we-compare` has no picture specs): a flat 128x96 project with eight regions (1400 square: pure red, green, blue, yellow, white, black, grey 128, orange 255/128/0), the ground at height 0 (shallow water) and at -2000 (deep), and one with eight depths down to 1300 across; packed with the release CLI, shown by `we-drive` (a first map, then `--map` of the test map, `--click 260,41 --click 291,300` for the entire view, `--key ctrl+r`, `p`, `w` for Water off) and by `app-drive` (`viewEntireMap`, `toggleRegions`, `toggleGroundPathing`, `toggleWater`), box means at the same pixels. The editor blends both layers over the picture, water included, in linear light: `enc((1 - a) dec(d) + a dec(c))` with the colour's own value and a = 0.533 for regions, 0.26 for pathing (pure magenta where nothing walks, pure blue where nothing is built); a region's pure channel over black is 194, over the grass (1, 125, 0) 208, red 194, 86, 0; regions go under the pathing (red then blue 170, 75, 137, as two blends). The same function over land, shallow and deep water, which the pictures at any depth confirm: Pathing - Ground shows over deep water at every depth (purple 146, 72, 155 at 0, 141, 55, 150 at 1300), against the earlier EchoIsles reading that deep water hides it. Studio's mean differences after the change: over land (water off) 2.5 to 4.5 per channel in all eight boxes (regions, pathing, both), over water the same blend on a water that is darker than the editor's, which also shades west to east (67 to 39 red at the same depth, Studio flat 22): that gap is the water's, and is left. **Over the border** (branch regions-pathing-we, 2026-11-15; `regedge.w3x`: 128x96, margins 14, 3, 10, 2, a pure yellow region across the south edge, red across the west, water off, View Entire Map, boxes at the same pixels): the editor shows yellow alone 194, 195, 0 over the border, Pathing - Ground alone 137, 138, 137 (pure white at alpha 0.26 over its dark ground), both 210, 212, 137 (the two linear blends, regions first: the round-4 number 210, 210, 137 was this with yellow). Studio gave 227, 227, 33 (region alpha 194 in linear light, the grey drawn opaque, the border part on the old alpha-over); now the border is part of the linear layer (white 66, region alpha 136): 199/199/0, 148/148/139, 215/216/139 on its own brighter border ground (31, 47, 0 against 0, 13, 0: the border ground's shade, open). viewcmds.test.ts. Studio: renderer.ts `LINEAR_OVERLAY_FS` (the picture so far copied, `drawLinearLayer`), viewcmds.ts `REGION_FILL_ALPHA`, `GROUND_PATHING_ALPHA`; with the naval view or the heights on, the layers keep the old alpha-over under the water (not measured together).

**Export Minimap and the saved minimap** (branch we-minimap-checks, 2026-11-17; spec `minimap-save.json`, maps from `make-minimap-tiles.mjs` / `make-minimap-dots.mjs` in `tests/fixtures/we-specs`, tool `app/scripts/minimap-diff.mjs A B`: mean absolute and signed difference per channel of two TGA/BLP/PNG pictures). The maps are flat.w3x with no margin (64 x 64 tiles, 4 pixels a tile at 256; `-zoom`: 32 x 32, 8 a tile). `--export-minimap` and the saved war3mapMap.blp: the editor **re-renders war3mapMap.blp on every save** (the input's is flat.w3x's picture; the saved one equals the same map's export, mean difference 2 to 6 per channel: JPEG and grain, 12 on a random-corner map). Studio's export against the editor's (SD and HD): flat stripes of the six Lordaeron textures within 1.2 per channel (so Ldrg and Lrok colours are right: the open point "Ldrg/Lrok too red" isn't a colour-table matter, and wasn't reproduced on random or blocky ground, `rand`/`blobs`: tile-interior pixels within 1.0 per texture, all pixels within 4.5 at the edges; real maps not rerun), 16-pixel squares within 6 (rand) and 3 (blobs) between the two exports. The two **saved** BLPs differ more on `rand` (squares up to 15, red lower in Studio's): the editor's own saved picture is not its export's colours there, +6 to +9 red on the green textures and -8 blue on Lrok (its JPEG encoder's chroma on 4-pixel colour changes), so `minimap-save.json` has `blobs` (squares within 3) and not `rand`; a red shift at texture boundaries in a saved minimap from the editor's encoder is a possible source of the old "Ldrg/Lrok too red" reading (the direction there wasn't recorded), not a wrong colour in Studio's table. Where the editor differs: a tile is drawn by its south-west corner in both, but the editor's 4 x 4 pixels keep their 2 x 2 inner pixels pure, take 12 % from the neighbouring tile at the other edge pixels and about 45 % at the corner pixels (an isolated corner, `impulse`: the 4 x 4 block at full colour, its corner pixels at 0.25, a ring at 0.12 to 0.18), Studio softens with a 3 x 3 tent (0.25 / 0.125 / 0.0625): about +4 red on red-rich tiles at edges. **Dots** (`minimap-dots*.w3x`, SD and HD, 4 and 8 pixels a tile): the editor draws a doodad as a sharp, not softened square of whole pixels with its four corner pixels out, anchored at the pixel under the centre's bottom-left corner (a quarter pixel more east or north changes nothing), whatever the pathing texture: 4x4, 6x6, 8x8, 8x6 and 4x6 are all 2 tiles wide (8 x 8 pixels, 60 lit; 16 x 16 at 8 a tile, 252), 12x12 is 4 (a pathing texture of 0 cells, the palisade: a white 4 x 4); Studio's softened discs (radius 0.7 tile times the footprint) are 1.4 to 2.8 tiles wide. Not changed: on HillsbradCreek's real crop (`minimapexport.test.ts`, 2 pixels a tile) the old discs fit the cliffs' rocks to 0.1 and 2-tile squares overshoot them by 7 red, so the rule is not simply "2 tiles" at that scale (open point; settled by the next paragraph, "Dots as tiles"). Colours: the dot is the mean of the textures the geosets' materials show, once each, the team colour texture black (a goblin shipyard ruin 63,46,32, a granary the mean of its two, a one-texture house its texture); Studio took the first texture (fixed, `shownTextureMean`). In HD Studio drew **no** dots (the model's .tif isn't stored, only its .dds: `modelTextureColor` now reads the candidates of `texpath.ts`). Three of this branch's runs never got ready: another agent's run had left the Trigger Editor or Object Editor open, the editor reopened it as a grey, empty window over the map, and `--wait-ready`'s re-close (every 3 s) did not remove it within 400 s ("dialogs": [] in the timeout report; a later run without it was fine).

**Dots as tiles, tile edges, real maps** (branch we-minimap-2, 2026-11-17; maps `minimap-dots-128` (128 x 128 tiles, 2 pixels a tile, eight doodad kinds), `-sweep` / `-sweep64` (the centre moved 4 or 8 units at a time along x and along y, 2 and 4 pixels a tile), `-grid` (8 x 8 offsets), made by `make-minimap-dots.mjs <cli> <game> [name]`; Studio's side `scripts/minimap-studio.mjs`). **A doodad's dot is whole tiles**: the tiles [u - a, u + a] touches, u its centre in tiles from the map's corner, a = (cells - 2) / 8 of its pathing texture across (4x4: 0.25, 6x6: 0.5, 8x8: 0.75, 12x12: 1.25; none: 0, the tile it stands in; per axis for 8x6 and 4x6), whatever the scale; a full rectangle of cells (gates 20x4 too) is a dot, only a texture with gaps is drawn as its cells (`dotReach`). Why 2 pixels a tile looked different from 4: a lone tile's four pixels are all corner pixels, so a 4x4 doodad at a tile's middle is one tile and vanishes (0.17), at a tile edge 2 x 2 tiles = 4 x 4 pixels minus corners (HillsbradCreek's old "2-tile squares overshoot by 7 red" was that). **Tile edge smoothing** (`sharpShare`): a pixel on a tile edge takes 7/8 of its own tile and 1/8 across, a corner pixel 0.17 when only its own tile has the colour (0.87 with one neighbour, 0.99 with two), pixels on no edge are pure; the same at 4 and at 2 pixels a tile, so it isn't a function of the distance from the edge: the weights are bilinear as for a pixel an eighth of a tile from the edge (own 0.625, across 0.375), then each colour's share goes through a ramp from 1/3 to 2/3. Replaces the 3 x 3 tent (which gave the +4 red on red tiles). Studio against the editor's export with no grain: dots-128, -more, -grid, -sweep, -sweep64 (SD, and dots-128 in HD): 0 pixels more than 30 off in any channel (before: 500 to 1000); real maps, 4 x 4 block means, mean absolute difference per channel before and after: HillsbradCreek 4.1/2.7/2.9 to 2.5/2.0/1.8, TurtleRock 4.8/2.9/3.7 to 3.6/2.7/3.1, SnowareBay 6.4/5.5/5.6 to 4.2/4.0/4.0 (pixels more than 30 off: 3246 to 2559, 6297 to 6268, 14200 to 7105). **Ldrg/Lrok "too red" is not there**: the flat interiors of every texture of HillsbradCreek and TurtleRock (SD and HD) are within 1.5 per channel of the editor's, the editor's lower by 0.5 to 1.5 on all (its grain and the cut to whole numbers), no red excess. Doodad scale 0.8 to 1.2 changes nothing. **Palisade** (no pathing texture, no readable model): a grey dot, inner pixels 181.5 (the editor's grain takes about 1.5 off), 183 in the table. **SnowareBay's dead tree walls** (205 NTtw at life 0): the editor draws 76 (its 77); all on snow ground (texture slot 5 of 7: 73 of 144 there, none of 20 on ice and 1 of 16 on the other rock/snow slot), 13 of 64 of those under ground height 950 and 60 of 80 above; z of the object over 250: 90 per cent, under 200: 10 per cent; variation, scale, angle (all 270 degrees) and flags (all 2) don't separate them: the rule isn't known, none are drawn. Not settled: the colours of dots whose model has several textures are 5 to 12 per cent off in the brighter ones (LSgr 94 against the editor's 84, the ruin 65 against 61); the footprint's turn for angles other than 270 degrees (swapped when nearer 0 or 180: not measured); the cliff rule's one-pixel lines at cliff edges in TurtleRock and HillsbradCreek (the editor's thinner).

**HD water** (branch water-render-we, 2026-11-14; pictures, no spec file). Maps: the flat 128x96 project above (water stored 512 everywhere: surface 38.4 on Lordaeron) with eight bands of depth across the whole width, north to south 4, 12, 24, 38.4, 64, 96, 200, 800 (ten corner rows each, `[height]` of war3map.w3e.txt), no regions, one per tileset (`tileset`, the tileset's first six tiles of Terrain.slk in their order, its cliffs), and copies with war3map.w3i's `water` changed; packed with the release CLI. Shown as above (`--click 260,41 --click 291,300`, `w` for Water off), Studio with `--camera "fov=41.06"` before `viewEntireMap` (the editor's field of view; Studio's own 45 makes the view's edges steeper). In the pictures the bands lie at rows 20/100/180/260/340/420/500 (the editor) and 20 px higher in Studio. A tileset's ground list must be in Terrain.slk's order: with `custom-tilesets 0` the editor draws texture 4 of the tileset's own list (Northrend's ice where the file said snow), Studio the file's until branch custom-tilesets-0-we (2026-11-16, maps `custom-tilesets-<rev6|more9|few3>-<0|1>.w3x` from `make-custom-tilesets.mjs`, stripes per slot): with flag 0 the editor draws the tileset's whole own list by slot, whatever the file's list says (another order, 3 or 9 tiles), and a slot past its end with the tileset's first tile; `w3e.ts` `drawnGroundTiles` does that for the terrain view's textures (the saved file, and the minimap, which is saved, keep the file's list). Branch tileset0-lists (2026-11-16, spec `custom-tilesets-0.json`, compare kind `minimap`: war3mapMap.blp's 16-pixel squares by colour, within a tolerance): the editor's saved minimap shows the list drawn too (rev6, few3, more9 with flag 0; the flag-1 control in the file's order), and so does Studio's (`minimapgen.ts`). Its cliff type numbers don't follow the list drawn: Grass Cliff is 1 under the cliff list CLdi CLgr and 0 under CLgr CLdi (maps `custom-tilesets-rev6c-<0|1>`), with either flag, so they follow the w3e's cliff list, and so does Studio's `cliffList` since branch cliff-by-cliff-list (before, by the ground list; `ct0-cliff-*` match): the cliff models drawn, the palette, Tiles… use counts and the cliff brush all number by the stored cliff list, an entry the game doesn't define (CLno) keeping its place. The editor's save of a flag-0 map writes the tileset's own list as the file's ground list.
- **What it is**: in linear light `out = through(d) bed + own(d) deep + reflect(d) (k sky(R) - dim (through bed + own deep))`, d the depth, R the view reflected on a flat surface; hdwater.ts holds the tables and the fit, renderer.ts `WATER_FS` draws it over a copy of the picture so far (`copyScene`). Without the reflection (w3i `reflectivity` 0) the first two terms fit the bands of Lordaeron, Ashenvale, Barrens and Northrend within 2 levels (0.3 mean; Ashenvale's water lies 12.8 higher, Water.slk's height). The deep colour per tileset (the 200 and 800 bands with reflectivity 0) is renderer.ts `HD_DEEP`: Lordaeron, its Fall and Winter, Village and Village Fall 0, 48, 69; Ashenvale 0, 39, 71; Barrens 6, 31, 27; Northrend and Icecrown 0, 39/38, 21; Cityscape 36, 48, 126; Dalaran 6, 34, 51; Sunken Ruins 0, 91, 171; Black Citadel 5, 11, 4; Dalaran Ruins 20, 22, 7; Felwood, Dungeon, Underground, Outland black. The same tables fit those within 3 levels except Underground's 109 deep (11 in blue) and Sunken Ruins 24 to 64 deep (up to 16 greener in the editor).
- **The west-to-east shading** is a reflection, of a sky brighter in the west, south and up (the editor's water environment map; LordaeronSummer's Water_IBL is a blurred sky cube, its west face the brightest), the same on all four tilesets: reflectivity 0 or environment map reflectivity 0 takes it away (the band colours then flat across), reflectivity 20 and 40 give two and four times it in linear light, environment map reflectivity 50 half, View > Lighting off and wave normal strength 0 keep it (0 makes it sharper), two pictures 2.3 s apart differ by under a level (not the animation). Turning the editor's opening camera (`--look center,5000,304,70,R`, R 90/0/180/270): bright on the left looking north, on the right looking south, all over looking west (red about 80), dark looking east (25 to 50), and straight down (`aoa 270`) a bright corner to the south-west. Fitted (`HD_SKY`, a second-order spherical harmonic per channel) on a 200 deep map through the opening camera at 3000 turned by 45° steps, two at 1500 and View Entire Map: 3.1 levels mean per 16 px block, under 2 per picture; R flatter than 0.54 above the horizon wasn't seen and is held there. Shallow water shows less of it, more than its own colour (`HD_REFLECT_DEPTH`: 0.09 at 4, 0.37 at 12, 0.93 at 24, 1.16 at 38.4), and it dims the rest by 0.113 per 10 of reflectivity (environment map reflectivity 0: deep Lordaeron 0, 45, 65 against 0, 48, 69). The share varies across the view in shallow water (24 deep: 0.74 west, 0.51 east); the mean is taken.
- **Studio against the editor** (View Entire Map, band means in five columns, each side's own bed): before, flat 22, 57, 73 deep; after, mean differences per channel L 1.8/1.1/1.1 (worst 6), A 2.5/1.6/1.1 (7), B 1.9/2.1/2.5 (6), N 1.9/2.3/3.4 (8); the 200-deep map through the ten cameras 0.7 to 6.9 per channel (boxes under Studio's minimap and start-location ring excepted). The model alone (hdWaterPixel with the editor's bed, hdwater.test.ts) 1.4 mean, 6.2 at most. Real maps in game view (`--compare-ready`, the opening view): NorthernIsles' water within 3 (before 4 to 6), the whole picture 14.2 → 10.3; Murgul Oasis 9.6 → 9.2 (its open water 8 too dark in green, Sunken Ruins' mid depths); map 03's lake 0.7, 3.8, 0.7 → 4.8, 3.2, -7.0 (the old colour had been fitted there).
- **SD** (`--mode sd`, the same maps; nothing changed): Studio's classic water is the texture times Water.slk's ramp, as the editor's with View > Lighting off (Lordaeron 39, 46, 136 deep both, every band within 2). Lit, the editor's Lordaeron water is about 1.1 times that (44, 50, 149; Studio's light at 06:00 0.97), Ashenvale's 1.3 times (14, 85, 108 against 10, 65, 84; that run's "unlit" Ashenvale picture was lit: see below), Barrens and Northrend within 5. No west-to-east shading in SD.

**Water: the classic light, HD waves, Sunken Ruins** (branch water-waves-we, 2026-11-14; pictures, no spec file; the maps above, 200 deep `wdLdeep` for the waves).
- **Classic water's light**: the ramp's colour times `ambient intensity + intensity × how steeply the light shines down` of the **unit** light, without the light's colours, no brighter than white per channel, under the texture; Water.slk's `lighting` 0 (Dungeon, Underground, Felwood) leaves the water unlit. Found by giving the Lordaeron map the other tilesets' lights (war3map.w3i's `lightEnvironment`: the same water and bed under each): deep water 39, 46, 136 unlit and lit 43, 50, 149 under Lordaeron's lights (1.09; 0.3 + 1.3 × 0.616 = 1.10), 51, 59, 175 Ashenvale's (1.30; 0.5 + 0.80), 48, 55, 163 Felwood's (1.20; 0.4 + 0.80), 60, 69, 181 Dalaran's (1.51 in red and green; 0.7 + 0.80; the blue stops at white, 192 × 1.5), 17, 20, 55 Dungeon's and Underground's (0.41; 0.4: their unit light shines upwards; their terrain light would give 1.41). The same grey in all three channels although the ambient colours differ (Dalaran's would give green 1.42). Lit and unlit are the same picture for Barrens, Dalaran (ramp 255: at white already), Dungeon and Underground (`lighting` 0). Studio: renderer.ts `waterLight`, `WaterLook.lit`; band means against the editor (five columns, 12 to 800 deep, lit; before → after, mean per channel): Lordaeron 3.5/4.5/8.8 → 2.5/0.6/3.1, under Ashenvale's lights 8.3/9.6/23.0 → 3.0/1.5/2.7, Dalaran's 14/16/26 → 2.4/1.3/2.0, Dungeon's 21/23/58 → 2.5/1.0/1.9, Ashenvale 3.7/12.6/15.4 → 2.1/1.8/2.3, Northrend 1.8/6.0/3.9 → 0.9/1.5/0.7; deep water within 2 everywhere, the rest is the shallow bands over Studio's ground (5 to 7 brighter than the editor's in red and blue on Lordaeron, water off). Night and a running day aren't measured.
- **View > Lighting comes back with every map**: `--view Lighting=off` holds for the map shown; the next `--map` of the run is lit again though the menu still isn't ticked (the earlier "Ashenvale is 1.3 times brighter also unlit" was that). Switch it per map.
- **HD waves**: seen straight down (`--look center,1500,270,70,90` and 3000; 1.39 and 2.78 world units a pixel, from the band map's rows) the pattern's autocorrelation (green, the smooth trend of a 16 px Gaussian taken away) falls to half over 24 units east-west and 9 north-south: the green channel of ReplaceableTextures\Water\Water_Normal (12.7 and 4.8 of its 512 texels) at 1024 units a repeat. Pictures 1.2 s apart match where one is moved north-east and, as well, south-west, by 45 units a second east and north each (correlation 0.4 falling to 0.2 over five seconds): two layers against each other. Through the opening camera the blotches are shorter (7.6 by 4.1 px at 3000 where the green alone gives 10.7 by 3.3): the map's red comes in as the view gets level. Their strength is about the same over bright and dark water, 0.003 to 0.008 of linear light in green (2.6 to 4.6 levels), red and blue three quarters of it, one pattern in all channels (correlation 0.9); the w3i's `wavesNormalMapStrength` 0 takes them away (0.0007), 50 leaves about 0.6 of them, `wavesVertexDisplacement` 0 changes nothing. Studio (hdwater.ts `HD_WAVES`, `hdWaveLean`, `HD_WAVE_LIGHT`; the old ripple of the classic texture is gone) against the editor, four boxes each through the opening camera at 3000, at 1650, and turned east and west: strength 0.0057 against 0.0054 on average (per box 0.0043 to 0.0080 against 0.0031 to 0.0086: the editor's follows the sky behind it more), autocorrelation 7.8 by 4.3 px against 7.6 by 4.1 (3000), 13.6 by 6.0 against 11.3 by 5.0 (1650), 5.2 by 6.1 against 4.1 by 6.6 (east), 5.1 by 6.0 against 3.1 by 4.9 (west); before, 0.0005 and 2 px. The mean colour stays: the 3 × 3 box means of those pictures moved by 0.1 to 0.5 levels. What the model leaves out: the editor's blotches are dark on bright water and bright on dark (a real reflection of a sky with edges; Studio adds and takes alike), and its speed may go by frames, not seconds (measured under lavapipe).
- **Sunken Ruins**: its shallow water has another colour than its deep (0, 142, 181 against 0, 91, 171; the colour the water itself needs once the bed's share is taken away is 0, 142, 181 at 12 deep, 0, 135, 176 at 38.4, 0, 95, 170 at 96), mixed by depth (hdwater.ts `HD_SHALLOW_SHARE`, renderer.ts `HD_SHALLOW`). With the reflection off the model is within 2 of the editor's bands on the editor's bed (green was 16 short at 64 deep); Studio's picture with the default reflection, bands 12 to 800 in five columns: 2.2, 1.9, 3.3 off on average (5 at most), over a bed that is 4.5 to 6 brighter in Studio than in the editor (water off). The blue stays 3 to 5 high in deep water (171 against 167: the reflection's dimming, fitted on Lordaeron, seems stronger on this blue). Murgul Oasis in game view (the opening view, 148 × 140 px cells of open water): green was 6 to 10 short and is 3 to 5 over, blue 0 to 4 over, where Studio's sand beside it is 5 to 9 brighter than the editor's in every channel.
- **A module window the editor reopens** (another run closed it with the Trigger Editor open; the farm's prefix is shared) covers the view (a grey 240 picture). `--wait-ready` isn't ready while one is open: it closes it, and again every 3 s while it stays (a close before the editor has drawn the window is lost; `we-drive.test.mjs`). `--close-modules` still closes the ones a run opened itself.
- **Water on every tileset** (branch we-terrain-2, 2026-11-17; `tests/fixtures/we-specs/make-water-tilesets.mjs <cli> <game> <out>` writes `wt-<char>.w3x` for the 18 tilesets of the editor's list: flat.w3x with the tileset's first six ground tiles and two cliff types, water 512 everywhere, eight depth bands north to south 4, 12, 24, 38.4, 64, 96, 200, 800; pictures, no spec). **HD** (`we-drive --mode hd --map … --compare-ready --click 260,41 --click 291,300` View Entire Map, 18 maps in one process; Studio `app-drive --set 'game.graphicsMode="hd"' --map … --terrain --view-size 1184x844 --camera "fov=41.06" --command w3.terrain.viewEntireMap --compare-ready game`; band means over x 300-900, eight stripes): every tileset within 1 to 3 levels per channel on average (worst single stripe 8, red, Lordaeron Summer and Fall) except **Outland**, whose deep bands were 23, 10, 11 / 22, 12, 14 / 23, 11, 12 in the editor and 62, 63, 59 in Studio (black deep colour, so Lordaeron's reflected sky alone): the editor's Outland sky is dark red. `hdwater.ts` `HD_SKY_TINT` (linear 0.18, 0.06, 0.075 on HD_SKY, shader uniform `uSkyTint`) brings its deep stripes to +5 +1 0 and +1 0 0; measured at that one view and held for every direction. The earlier "A, F and W near black, Y indigo, Z bright blue" was Studio before HD_DEEP: Ashenvale 1.0/1.1/0.9, Lordaeron Fall 2.4/1.1/1.4, Winter 1.6/1.0/1.2, Cityscape 0.8/1.5/2.4, Sunken Ruins 1.8/2.0/3.6 mean difference. **SD** (`--mode sd`): `--look` of the editor on a second map of one process landed off (the camera of the first map), so one map per process, `--look 0,1536,600,270,70,0` (the 24 band) and `0,-2560,...` (the 200 band), Studio `--camera "x=0,y=1536,distance=600,pitch=89,yaw=-90,fov=41.06"`; View Entire Map and `--look center,5000` show black in the classic view (the far plane). Means of a 600 x 450 box, Studio minus editor: all 18 tilesets within 4 per channel in both bands, 16 of 18 within 2 (the exceptions: Lordaeron Summer at 24 deep, 133, 103, 86 in the editor, -4, -2, +1; Sunken Ruins 24 deep -3 red, 200 deep 13, 82, 171, +0, +1, +3); Outland is 98, 25, 8 over the 24 band (the ground) and black deep in both (the Water.slk colours of Outland are all 0, alpha 255). The classic water's colours need no change on any tileset; nothing in the first SD pass (second maps in a process, mostly 30 to 150 off) was real.
- **Calculate Shadows and what the editor leaves out** (branch we-terrain-2, 2026-11-17; File menu (19,41) > Calculate Shadows and Save Map (105,155), the save asks "Warning", `--save-accept Warning`; plain Save keeps the stored war3map.shd byte for byte: HillsbradCreek and LastRefuge saved without a change, so the sample maps' shadows are the old calculation's: Studio's against the stored LastRefuge 5446 cells, against a fresh calculation 3853 of 147456 (editor 10556 shaded, Studio 11611); (2)LastRefuge unpacked, doodads emptied or split by Doodads.slk's DoodadSkins `shadow`). **shadow=0 doodads cast nothing**: the 335 doodads of LastRefuge's 24 shadow=0 types (ZPsh, ZWsw, LPwh, LPfp, LPrs, ...) alone give the terrain-only shadow (8177 cells) exactly, 0 cells added or taken away; the other 2118 add 2379 cells (Studio `bakesShadow`: right). The 91 cells that still disagree are the same cell-edge disagreement as everywhere else: **terrain only** (cliffs; Studio's 225/30 heightfield cast) 7117 cells shared, 1736 Studio-only on the south-west rims, 1060 editor-only on the north-east ones; a fit of azimuth, elevation, sample offset and start height (nearest, bilinear, tile-maximum and minimum ground) found nothing better than 2244 cells off; **doodads on flat ground** (HD): the editor 2346 cells beyond the terrain, Studio 2704, 1954 shared, rocks LRrk (177 of the 2118) most of the difference; twenty rocks one by one on a flat map (10 variations at angle 0, one variation at 10 angles): the editor 259 cells, Studio 285, 172 shared; the editor's blob reaches one cell further west and south, Studio's north-east. The calculation follows the editor's graphics mode: the same rocks 259 cells in HD and 870 in SD (Studio's 285 and 590; 518 shared in SD); letting every geoset filter mode cast changed nothing. Not found: the rule that decides the edge cells (found for the terrain: next item).
- **Calculate Shadows: the terrain's rule** (branch we-shadow-3, 2026-11-17; `we-drive --save-shadows FILE`, we-compare `"we": { "save": "shadows" }`; maps from `tests/fixtures/we-specs/make-shadow-probes.mjs`: `shadow-terrain` (a 128 bank, cliffs one and two levels up, single corners raised 128, 256 and 512, two ridges, a 64 bank) and `shadow-rocks` (LRrk, ten variations, eight turns); spec `tests/we-compare/shadow-terrain.json` with plateau.w3x: both MATCH). The terrain's shadows are the same in SD and HD. **Heights per cell**: one per shd cell at its centre; ground tiles over their two triangles split from the top-left to the bottom-right corner (a raised corner's shadow is fatter along that diagonal than bilinear's); **cliff tiles** from a cliff model, but not the drawn one: the editor names it after the corners read from the top-left (top-left, top-right, bottom-right, bottom-left) and reads it a quarter turn round (the tile's (u, v) at the model's (1 - v, u)), the highest surface there, over the tile's lowest layer plus the ground's own height (of the eight name orders against the eight turns only this pair fits: the one-level cliff's shadow reaches a cell further in one row of four along an east face; the drawn model left 129 cells off, corner heights alone more). **The walk**: from each cell 16 cells toward the sun, one cell diagonal a step (225°), dark when a cell on the way is higher than the cell itself plus 32√2 · tan 30° per step (strictly; a 1-unit start offset adds an error, 2 and more many); the cells 17 steps off a 512 high corner stay lit. Fitted alternatives that lost: the old ray (bilinear ground, 16-unit steps from the centre, +1 start; 786 of 2618 cells off on the probe map), steps of 16 or 32 units (47 off), exact ray-triangle cliffs (64 off on the east face), cliff models cast like doodads (hundreds). Studio: shadows.ts `shadowCellHeights`, `shadowCliffName`, `cliffCellHeights`, `SHADOW_WALK_STEPS`; the probe map and plateau.w3x 0 cells off (were 786 and 286). **Real maps** (HD, the editor's fresh calculation; LastRefuge, TurtleRock and HillsbradCreek with their doodads emptied, LastRefuge whole): a variation the shadow's name lacks is counted round its variations (`shadowCliffVariation`; the drawn model's fall-back to the highest left 674, 840, 1646 cells off, this 367, 576, 1009), the ground under a cliff model is bilinear (330, 534, 859); before the branch 2950, 4222, 7405 of 8704, 11045, 18219 shaded cells, LastRefuge whole 3995 → 1438 of 11050. Left: mostly cells under water that Studio shades and the editor doesn't, at the north-east edges of shadows over a bumpy sea bed (TurtleRock 381 of its 534; a start offset of 0.5 halves them and adds others, the water level as the height takes thousands away: not found), and ramps. **Doodads**: SD casts alpha-tested geosets whole (the rocks: 983 of 984 cells and 5 more; with the alpha test 659 and 3 more; shadowmap.ts); HD rocks (opaque) 337 of the editor's 341 and 49 more, the extra cells at the rocks' middles, under the highest part (the model is a single cap covering each point once; neither faces toward or away from the sun, nor a height walk over the doodads (269 off), nor the surface's facing explain the editor's holes): not found.
- **Calculate Shadows: the walk's rise and length, water, ramps, cliff variations, doodads** (branch we-shadow-4, 2026-11-17, HD; `we-drive --save-shadows`; maps from `make-shadow-probes.mjs`: `shadow-slopes` (planes facing away from the sun falling 26.56, 26.63, 26.69 and 26.75 a step of the walk, two of them under water, a corner raised 1000), `shadow-cliffvar` (cliff variation 3 on faces whose shadow models BAAB and BBAA have two), `shadow-ramps` (a ramp down each face of a plateau) and `shadow-boxes` (box models imported as custom doodads: closed, without bottom, triangles turned inward, sunk 32, floating 32, a lone top facing up and down, a tall post); specs `shadow-slopes` and `shadow-cliffvar` in `tests/we-compare/shadow-terrain.json`). **The rise**: a step of the walk rises 80/3 (the sun about 30.5° high, not tan 30° = 26.13): on the real maps the cells whose steepest rise toward the sun lies between 26.13 and 26.6 are lit, those over 26.7 dark; the probe's planes at 26.63 lit, at 26.69 dark, the 128 bank's cells exactly 80/3 up dark (a 1536 corner's four exactly 80/3 up, 36 steps off, were lit: not explained, the committed probe avoids them). **The length**: none; the 16 steps of we-shadow-3 were the old rise's fit (a 1000 corner casts 33 cells, HillsbradCreek's slopes 28: 307 cells off after 16 steps, 75 without a limit). **Water** plays no part: TurtleRock's cells under water were the rise (534 off, 24 now, none of them about water; the wet planes as the dry ones). **Ramps**: a ramp side (lib/terrain/cliffs.ts `rampSides`) reads the ramp model named from the top-left corner on, a quarter turn round, as cliff tiles do (`shadowRampName`, `rampCellHeights`; shadow-ramps 42 cells off with the side tiles' cliff models, 28 as ground, 20 with the drawn ramp model, 7 so; LastRefuge 114, 113, 103, 87). **A variation the name lacks** goes round: 3 on a name of two reads 1 (shadow-cliffvar: 0 cells off, 383 with 0). **Doodads** (HD and SD alike): a cell's line toward the sun from its own ground (the walk's heights) meets the model; the cell is dark only when all of the model's surfaces on that line lie above the ground there: a closed box on the ground leaves its footprint lit (its bottom is on the line, at the ground), the box without its bottom shades it, sunk lit, floating dark, the triangles' turn changes nothing (`castShadow`); of the boxes' 235 cells the 8 whose centres lie exactly on a projected triangle's edge are off (the editor leaves some of those out, not found), LRrk's probe 7 of 341 (53 before), in SD 3 of 984 (6 at tan 30°). Before and after the branch, the editor's fresh calculation against Studio: TurtleRock, LastRefuge, HillsbradCreek without doodads 534, 330, 857 → 24, 87, 75 cells off (of 11045, 8704, 18219); LastRefuge whole 1438 → 487 of 11050. Left: the ramps' 7 cells, LastRefuge's 2-level notch at tile (61, 86) (the editor leaves it lit under its walls), the edge cells, whether a texture hole of an alpha-tested face counts as a surface.
- **Replace Tiles and Modify Tileset > Remove Tile** (plateau.w3x, we-compare `replace-tiles-cliff`, `replace-tiles-unused`: MATCH corner by corner): Replace Tiles (Advanced 260,41, 288,223; Old Tile combo 710,464, OK 692,535) changes the ground tile of every corner wearing the old tile, the cliff corners too, and nothing of the cliff types or layers: the plateau's grass look is its cliff type CLgr, not a ground tile, so a tile no corner wears (Grass) changes nothing. Modify Tileset (Advanced 288,61; Use custom tileset 651,319; the six thumbnails at x 421 + 32 r, y 376; Remove Tile 579,451; OK 848,708) removes a tile in use **without asking** and gives its corners a **random** remaining tile (the same tile removed twice gave 3 and 1, 4 and 1: six stripes of plateau.w3x, one per tile, each tile removed in its own run); the stripes of the tiles that stay shift down by one. Cliffs: a cliff type whose ground tile goes leaves the cliff list and its cliffs take the first remaining cliff type (Lgrs removed: cliff list CLdi, the CLgr cliffs 0; Ldrt removed: cliff list CLgr, the CLgr cliffs stay type 0); the custom tilesets flag becomes 1. Studio's `planRemoval` + `applyTileList` give the same textures, cliff types, ground and cliff lists and flag in all six runs when the replacement named is the one the editor drew (`tilecleanup.test.ts`); Studio asks for the replacement instead of drawing one.
- **Keys Y and Z** (Tools menu: Reset Random Brush Z, Set Uniform Doodad Heights Y; both greyed with nothing selected under the Doodads Selection brush; `we-drive --keyboard de`, setxkbmap before the editor starts, `--key` then names keysyms): under the German layout the key named `y` (the physical key US keyboards call Z) ran Set Uniform Doodad Heights on `uniform-heights.w3x` (five carts to 71.9, flags 6, as with the US layout), the key named `z` (the physical Y position) did nothing: the editor's accelerators are the letters, not the physical keys; Studio's `keyOf` reads `e.key` first, so Y is the letter there too. Z (Reset Random Brush) shows nothing in the saved file: eight LTlt placed with the palette's random rotation and variation, four, Z, four: the variations and scales of the second four don't repeat the first (4, 3, 6, 4 against 5, 9, 0, 8), so it isn't a seed reset; no Studio equivalent (its draws are made at the placement).

**Trigger Editor and Object Editor checks** (branch we-trigger-checks, 2026-11-17, SD; input `tests/fixtures/we-specs/trigger-checks.w3m` from `make-trigger-checks.mjs`: cameras Alpha and Bravo, a GUI trigger with a disabled line and a Custom Script action, an If/Then/Else trigger, a custom text trigger; specs `camera-rename-we`, `random-script` with `make-random-script.mjs`). Opening the Trigger Editor (F4) after the map is ready takes about 45 s to paint in this display (the Object Editor, F6 after a click on the view, 90 s; Module > Object Editor from the menu bar didn't open it twice), so use sleeps, not `--wait-ready`: a module window left open at the close is reopened by the next start (`--close-modules` first, Escape twice before it when a menu was open, or the close fails); a custom text trigger needs its `InitTrig_<name>` function or the save stops at "Generating Map Script". Param encoding in a hand-made war3map.wtg: a literal number or text is type 3, a preset (`CameraApply`, `OperatorEqual`, `Player00`) type 0, a camera `gg_cam_<name>` type 1 (a number as type 0 shows "Unknown"). **Copy As Text** (Edit menu, Ctrl+Shift+C; `--clipboard` reads it): the trigger's tree row or its own first line copies the whole trigger (name, then Events, Conditions, Actions indented 4, a line one level in per nesting, a block's If/Then/Else labels listed, an empty section its heading alone; every line ends with a LF, the last too); a disabled line is copied like any other, with no mark; a clicked line copies itself (a block line with its branches); a clicked section heading ("Actions") copies the heading and its lines one level in, a clicked branch label ("Then - Actions") the label and its lines one level in; Ctrl+A in the body copies the one line; a custom text trigger has Copy As Text greyed (nothing copied). Not reachable here: the clipboard's line endings (Wine converts CRLF to LF on the way to X). Studio: astext.ts `sectionAsText`, `branchAsText` (the section and branch cases were missing: they copied the whole trigger), app-smoke editorExtras. **Camera rename** (camera palette: M, a row, Return, the name typed, Return): the editor asks nothing; the GUI trigger line follows ("Apply Zulu <gen>"), script text naming the old gg_cam_ name is left alone, and a script that really uses it fails the save ("Script Errors", "Trigger 'Use Cams' has been disabled due to errors"). Studio's question about script text, dismissed, gives the same files (`camera-rename-we`: w3c, wct, wtg all MATCH). **Random objects in the script** (`random-script`, 24 placed objects: random items of classes 0..7 at level ffffff and 3, random units and a building by level, a list, groups numbered 2 and 7): war3map.j matched but for the groups' names: the editor numbers them by place in the list (gg_rg_000, gg_rg_001, "// Group 0") however the file numbers them, an object follows its group's number to that place, and one naming a group the map hasn't gets `set unitID = -1`; Studio now does the same (drops.ts `randomGroupGlobal`, `randomGroupSlot`), the whole script MATCH. **Negative reals** (Object Editor, Abilities, Heal with Stats - Levels typed 3; Edit > Auto Fill Levels, Ctrl+L, on Level 1 - Stats - Cooldown; the editor's Edit menu has Copy and Paste Ability, whole objects, no field paste): with Allow Negative Values off ([Object Editor] in WorldEditPreferences.txt) the dialog's Base Value and Previous Value Factor stop at 0 (typed -3 and -1 became 0.00), Level and Constant Factor take negatives (-2 shown), and every level's sum is floored at 0.00 in the preview, the next level going on from the floor (base 1, previous 1, level factor 4, constant -10: 1.00, 0.00, 2.00); a negative typed in Modify Selected Field left 0.000. Studio: objectedit.ts `autoFill` with a floor (was: negatives written). Not measured: with the preference on; Paste Ability of an object holding negatives; typed -2 over a non-zero value (clamped or refused; Studio refuses with a message).

**Misc checks against the editor** (branch we-misc-2, 2026-11-17, SD). One we-drive process runs only one map, so every Object Editor probe is one start (F6 after a click on the view, `--sleep 80000`; with other agents queued, wait for the lock with `--timeout 1800`).
(1) **Negative reals** (inputs `tests/fixtures/we-specs/make-negative-reals.mjs`: custom Heal A000 with Cooldown -3, -1.5, 2, Casting Time -0.5, Cast Range -100): `Allow Negative Values=1` in `[Object Editor]` of WorldEditPreferences.txt (kept by we-drive) changed nothing that can be seen: the editor has no switch for it in its Object Editor menus, and File > Preferences stops at "Unable to initialize audio device" (the dialog is unreachable here), so whether the key does anything is not proved. Observed with it set: Auto Fill Levels (Ctrl+L, field Level 1 Cooldown) opens with Base Value 0.00 where the field holds -3, Base Value and Previous Value Factor typed -3 and -1 become 0.00, Level Factor and Constant Factor keep -2 and -4, the preview floors every level at 0.00 (base 1, previous 1, level 4, constant -10: 1.00, 0.00, 2.00 as before), and OK on the untouched dialog overwrites the whole row with 0 (-3, -1.5, 2 all 0.000); Modify Selected Field typed -7 over Cast Range 350 gives **0.000** (clamped, no refusal; typed -2 over 0 stays 0, over Casting Time and Cooldown too), a real field (Hit Points Gained) takes -4, Mana Cost (int) typed -5 over 5 stays 5; stored negatives show as -3.000 and the like; Paste Ability (Edit > Copy Ability, Paste Ability, an ID asked, OK) copies the object with its negatives unchanged. Studio: objectedit.ts `clampsToZero` (a typed negative for an unreal field is made 0 while the setting is off; it refused before), app-smoke editorExtras.
(2) **Modules**: Module menu of this build (7003) lists Terrain Editor F3, Trigger Editor F4, Sound Editor F5, Object Editor F6, Campaign Editor F7, AI Editor F8, Object Manager F11, Asset Manager F12 and Light Editor; **no Sound Set Editor, Dialogue Editor or Foliage module** (Foliage is only the View > Foliage switch). Object Manager (F11): tabs Map Summary (Map Name, Expansion Required, Map Type, Playable Map Size, Map Size Description, Tileset, Total Units, Items, Doodads, Regions, Cameras, Triggers, Variables, Sounds, Custom Objects by kind), Units, Items, Doodads, Regions, Cameras, Triggers, Functions, Variables, Sounds. Light Editor: trees Terrain (23 internal DNC*Terrain.mdl, Imported 0) and Unit (internal, Imported), a Terrain/Unit drop-down, "Enable Custom Light", "Export Current Values" (greyed until enabled), a Preview time spin (0.00): edits the day and night lighting models; Studio has no counterpart.

**Misc checks against the editor, 4** (branch we-misc-4, 2026-11-17, SD). (1) **Pathing at rounding edges** (`tests/we-compare/fence-exact.json`, input `make-fence.mjs exact`: NOfl 8x2, NOal and VOal at every multiple of 45 degrees from -405 to 765 as single precision numbers, NOfl every quarter degree within 2 degrees of 45, 135, 225 and 315): the editor's doodads and its pathing map differed from Studio's only at 405, 675 and 765 degrees (the editor 0, 270, 0; Studio 90, 0, 90): the editor takes whole turns off the angle in single precision before it rounds to a quarter, so 405 and 765 (a hair under 45 once reduced) are 0 and 675 is 270. 225 and -45 matched already. Studio: `lib/terrain/quarter.ts` `quarterTurn` (wholeTurns first; `doodadgrid.ts` re-exports it), now also what `pathing.ts` `forEachStampCell` turns by (it rounded the double quotient before); both files MATCH. (2) **'hfoo' on an integer variable** (`var-code.json`, input `make-var-code.mjs`): the Variable dialog's value box for an Integer takes digits and a minus only (letters, quotes and x typed into it are dropped), so the editor can't make one; a map file's `'hfoo'`, `0x1F`, `-0x10`, empty and 42 stay as written and its script holds them as written (`set udg_i_quoted = 'hfoo'`, a valid JASS integer); wtg and the udg_ lines MATCH Studio's. Bare `hfoo`, `1.5` on an integer, `'hfoo'` on a unitcode and `abc` on a real are written into the script too and stop the save with Script Errors (undeclared identifier, type mismatch, syntax error; `make-var-code.mjs --all`). Studio refuses `'hfoo'` for an integer in its own box as the editor's can't type it; no change. (3) **Campaign Editor** (`make-campaign.mjs`: one chapter, with and without campaign object data; `--campaign FILE`, F7, Ctrl+O, the name typed, Return, click the chapter, Ctrl+M = Edit > Edit Map; the editor's dialog takes a bare name from Documents/Warcraft III/Campaigns only): **found: Edit Map answers "Unable to load file 'X' - Main map file could not be opened" for a chapter packed compressed, which every Studio-packed campaign had**; with the chapter stored whole (block flags 0x80000000, as the game's campaigns hold theirs) the editor opens it (title `<campaign>.w3n--Chapter1.w3x`). Fixed in the MPQ writer (`crates/mpq/src/write.rs` `is_nested_map`: .w3x and .w3m files are stored; a unit test checks the flags). The chapter's Object Editor (F6, Units) shows a campaign's custom unit under its own blue root "Campaign Units (1)" (Human, Melee, Units, Campaign Footman), the map's own under "Custom Units (0)", and a standard "Campaign (95)" folder under Human. Not Studio's doing: The Chosen Ones 1.0.w3n as the game ships it (chapters already stored) still answers "Unable to load file 'Prologue - The Chosen Ones Campaign.w3x' - Unit data missing or invalid." (cause not found). (4) **Audio device** (`we-drive --null-audio`): Wine's ALSA driver on, `ALSA_CONFIG_PATH` a file in the work folder with a lone null PCM (`pcm.!default { type null }`), /dev/snd, PulseAudio and PipeWire still hidden: File > Preferences (File menu at 18,41, Preferences at 54,419) opens; its General tab holds "Allow negative real values in the Object Editor" (matches `Allow Negative Values` in the prefs file, 0/1), ticking it asks "Are you sure you want to allow negative values?" (Return = Yes); OK at 789,696. With it off (file) or on (file, or ticked in the dialog and OK, same session) the Object Editor (Abilities, A000 Heal of make-negative-reals.mjs) behaves the same: stored negatives show (-3.000), typing -7 in Edit Ability Value - Real for Cooldown gives 0.000, Auto Fill Levels' Base Value -3 gives 0.00 (preview 0.00 all levels), an integer field (Mana Cost) drops the typed minus (7). So the preference has no effect on those paths. Studio's setting (`objectEditor.allowNegativeReals`) does let a typed negative through when on (`clampsToZero` only clamps while off): unchanged, whether it should is the user's call.

**AI Editor ranges** (branch we-ranges-5, 2026-11-18, SD; F8 on flat.w3x, the window opens at once; fields are read from `--shot-screen` crops, the boxes are 1 to 4 characters wide so `Home`/`End` show the ends; a `.wai` can't be saved through we-drive, so no we-compare spec). The editor's spin boxes drop `-` and `.` typed into them and pull a typed value in when the box is left (Tab) or an arrow is clicked: **Heroes** chance (six boxes): above 100 gives 100 (150, 99999999999); **the six always add up to 100**: setting one scales the others to the rest, a zero stays zero or gets 1 from the rounding (30 gave 14,14,14,14,14; 0 gave 20 each; Studio's boxes are independent, 0..100 each: unchanged, a behaviour not a range). **Test Configuration** Game Speed: 0 gives 1, 26 and 99 give 25, 3 stays (range 1..25; Studio had min 0, now `GAME_SPEED_LIMITS`). **Attacking** Repeat Waves: with one wave 2 to 100 give 1 and the arrow stops at 1, with two waves 2 stays and 3 gives 2 (0 stays 0: range 0..number of waves; Studio had no max, now `repeatWavesLimits`). **Building** harvest Workers (Fixed Value): 0 gives 1 (min 1; Studio had 0, now `HARVEST_WORKER_LIMITS`); 99, 100, 101 and 150 stay as typed in the box, so the upper end (Studio keeps 100) is not proved. Initial Delay takes 4 characters (99999999999 gave 9999; 1234567 gave 1234, down arrow 1233), Wave delay 3 (99999 gave 999): typing lengths, no clamp seen (Studio: any u32). Not reached: Handicap (its box is greyed while the one slot is Observer, the Team list holds nothing else; Control Computer doesn't change that), creep strengths (greyed in a new AI), Light Editor (no hour keys there, only a Preview time spin).
(3) **war3map.imp flags** (`tests/we-compare/import-flags.json`, inputs `make-import-modes.mjs` `import-flags`: a text file under every flags 0..31 on a plain path, and 13, 17, 21, 24, 25, 29 below `_HD.w3mod\`): the editor's save keeps every flags value without bit 2 as stored (0, 1, 4, 5, 8, 9, 12, 13, 16, 17, 20, 21, 24, 25, 28, 29; the six game values below `_HD.w3mod\` too) and writes an entry with bit 2 as a **blank entry** (path empty; bits 1 and 2 off, bit 1 on where bit 4 was: 2, 3 to 0; 6, 7 to 5; 10, 11 to 8; 14, 15 to 13; ...), so it never reads bit 2 as anything it keeps; no game value has bit 2. Its Asset Manager (F12) shows Mode, Teen and Locale from the path only: every plain entry is SD, No, Unknown whatever its flags (8, 16, 24 as 13, 17, 21), `_HD.w3mod\` entries are HD for 13, 17, 21, 25, 29 but flags **24 shows `war3mapImported\h24.txt` (the folder name dropped) as SD**: bit 1 decides whether the editor reads the mode folder at all. So 13 = 8+4+1 (mode folder, HD: Studio's own), 21 = 16+4+1 (the editor's own import), 24/25/29 and 17 are the other mixes the game's maps hold; bit 16 = plain/classic, bit 8 = mode folder, bit 4 and bit 1 not told apart by anything the editor shows. The spec records the bit-2 blanking as "expect differs".
(4) **Geoset colours** (inputs `make-geoset-color.mjs`: LavaCracks DOlc, GCracks GOlc, SunWell, AzsharaStatue, EyeOfSargeras, RuneArt, ShroomsBlue and ShimmeringPortal OZsp on flat.w3x; `--look 0,-250,2000` and `--camera we:0,-250,2000`, game view at 06:00): 37 of the 2629 classic models under Units, Buildings and Doodads hold a colour track (KGAC). The editor draws a track's keys **blue, green, red**: RuneArt's key (0, 0, 1) red (Studio black), the lava cracks (0, 0, 1) red, GCracks (1, 0.85, 0) cyan; Studio read them red, green, blue (renderer.ts: the tracks are turned now, unit test `modeldraw.test.ts`; the pictures of both now agree for those three). A model's static colour stays red, green, blue (ShimmeringPortal's (0.467, 0, 0.992): turned too its glow went red, the editor's is violet-pink). Left: AzsharaStatue is **gold** in the editor and grey stone in Studio (geoset 2 stores the static (0.31, 0.78, 0.86), a track holds white and (0.53, 0.6, 0.38) in Death), and ShroomsBlue is a small dark blue cap in the editor and a large spiky blue mushroom in Studio (not looked into). The editor's picture moves with its animation (three frames 2 s apart differ only in the glow).
(5) **Regions by drag near the map edge** (flat.w3x, 64x64, playable to ±3328, map to ±4096, `--look 3300,0,2200`): the selection mode (status "Brush: Regions - Selection", the palette's tool) makes **no region by dragging**, it box-selects; a region is made with the palette's tool button (1383,105, "Regions: Add") and a drag, and `Escape` returns to selection. A selected region (click inside) dragged east moves with the pointer in whole 32 steps (drags of 360 and 350 px moved it 576 and 544): 2528..2752 to 3104..3328 (the playable edge) to 3648..3872, **into the border past the playable part**, kept. Not reached: a move or resize past the map edge (4096): a drag that ends at the view's edge scrolls the view instead (and drops the selection), and the corner handle at the region's top right wasn't hit by a drag from its picture (no change, w5), so resizing near an edge stays unmeasured. **Measured** (branch we-compare-4, 2026-11-18, the same map and view; a region made by Add at 3296..3552, its corner handles are small squares at its corners on the view, e.g. bottom-right 656,493): a selected region dragged 850 east with the pointer ending off the map stops with its right edge on the map's, 3840..4096 and 3808..4096 in two runs, its size kept (Studio: regions.ts `shiftInside`); the bottom-right handle dragged off the map resizes to the last point inside, right 4064 (Studio's pick gives no ground off the map, so its resize stops there too); dragged to 3936 inside, kept. A drag from the middle of an edge resizes nothing.

**Misc checks against the editor, 5** (branch we-misc-5, 2026-11-18). (1) **Forsaken campaign** (Curse of the Forsaken Classic v4.0.1: the original and `w3proj unpack` + `pack` of it, 979 MB each; `--campaign FILE`, F7, Ctrl+O, the bare name typed, Return, about 50 s; the Campaign Editor's tree rows only take a click on their label (590..670, not 690: a click at 690,283 selected nothing and Ctrl+M opened the row clicked before), first chapter ForsakenStart.w3x at 620,283, Ctrl+M; title `<campaign>.w3n--ForsakenStart.w3x`): **the Studio-packed campaign opens, Edit Map opens the first chapter (its terrain is shown) and Ctrl+S saves without "Script Errors"**: "Creating Campaign Archive" runs about 90 s, the .w3n grows by 76 KB (the original: 82 KB), and the saved campaign unpacked equals the original's saved one file for file (`diff -r` of the two unpacks: nothing). Only ForsakenStart's own files changed in both (doo, units, j, blp, w3c, w3i, w3r, new w3grp and w3l). So the campaign's own object data does fix the standalone map's Script Errors (Misc checks 4). **Ctrl+S goes to the module that is active**: after `--wait-ready` the AI Editor ("answered") is, and a save opens its Save As dialog (AI Scripts); a `--click` into the terrain view first (700,500, or 700,120 over the campaign editor) gives the main window the key (`--close-modules` doesn't). The earlier "opens nothing in 60 s" (Misc checks 3) was the unselected row. (2) **GoldRush's minimap** (`minimap-goldrush.json`; the editor's export, its saved BLP and Studio's rebuild): the editor's re-render of the map equals the BLP stored in it within 0.16 per channel (deterministic: the same on another run and machine); Studio's differs from it by a mean 11.4 / 7.0 / 6.5 per pixel, 3.3 / 2.0 / 1.8 over 4 x 4 blocks (none: -0.1 / -0.1 / -0.3 signed): **the per-pixel grain** (white noise on the ground; the editor's is not a fixed pattern of the position: two maps of one texture have correlation 0.03, so it can't be copied) and thin strips: a line of one tile of a texture between others (the dirt between grass) is about 2 pixels wide in the editor, 1 in Studio (184 of 4096 blocks of 4 x 4 differ by more than 12, 5 of 256 blocks of 16 x 16 by more than the spec's tolerance 8, which is why `minimap-goldrush.json` is red); `terrain.minimap.regenerate` is "afterEdits", so Studio keeps the editor's image until an edit, which is the only way a save changes it. The editor's save of this map also drops the files of its `loot-indicator`, `UI`, `ReplaceableTextures` and `_teen.w3mod` folders (the archive 824 KB to 391 KB, 23 of 68 files unpack; the map has no war3map.imp, so they aren't in its import list); Studio's save keeps them. (3) **HD shadows and water** (`make-water-shadows.mjs`: two lakes 30 and 100 deep on flat.w3x, footmen on land and in both, gryphons over both, two trees; `--look 0,0,2400`, game view off, Shadows on and off; Studio `--compare-ready lit`, `terrain.shadows.visible`): the light kept in the shadow, on over off by regions of the shadow, editor against Studio (R/G/B): footman on land 0.72/0.71/0.59 against 0.80/0.81/0.79, tree on land 0.70/0.69/0.64 and 0.65/0.64/0.47 against 0.80/0.80/0.79 and 0.77/0.77/0.73, footman on the shallow lake 0.82/0.85/0.92 against 0.91/0.94/1.00, gryphon's shadow 0.76/0.80/0.96 against 0.85/0.86/0.89: **Studio's shadows are lighter than the editor's by 0.08 to 0.10 (blue by up to 0.26), on water as on land, not darker**; no single cause (the blue channel's larger share points at the sun colour of Lordaeron Summer's own light, which the fit of tone.ts SUN_SHADE / GAME_LIGHT_FILL on cliff.w3m and map 03 doesn't have), so nothing changed. The editor's game view (Lock to Game View Settings) was taken here to draw the map from farther away than its normal view at the same `--look` distance (the lake 425 px wide against 540); **not reproduced** (branch we-compare-3, 2026-11-18: flat.w3x with 25 rock squares 1024 apart, `--look 0,0,D` for D 1000, 1650, 2400, 3200, 4000, SD and HD, game view on before the looks and switched on after one: the squares' centres agree with the normal view's to 0.1 px, and Studio's `--camera we:0,0,D --compare-ready game` puts them within 0.6 px of the editor's game view at 1000, 2400 and 4000). View > Shadows can't be switched with game view on (items greyed): measure with it off. Hours weren't measured (the editor's day is fixed). (4) **Dead tree walls on Export Minimap** (`make-tree-walls.mjs`: SnowareBay with only its 205 NTtw, the ground as it is, flat with slot 5, flat with slot 0, ...; the editor's export against Studio's): **the rule isn't a selection**: with only the walls on the map the editor draws 27, 23, 22 and 24 of the 202 places (the same 22 in all four, the ground, height and texture slot changing nothing), the same walls with life 100 give 30 (23 of the 27 in common) and Studio's alive dots 28, so a wall of this type is a dot whatever its life; NTtw's DestructableData row has pathTexDeath "_", the tile it stands in, and a one tile dot is faint at 1.6 pixels a tile except beside other dots (the cluster of 20 in the south, a few at tile corners). Slot 0 (dirt) shows none because the dot's colour (32, 48, 32) is the dirt's: "snow ground only" was contrast. Studio (minimapgen.ts) now draws a dead destructable by its pathTexDeath instead of leaving it out: its set on the walls-only map equals the editor's (flat5: 23 and 23, all in common; flat only 22 of 22 plus one), SnowareBay's 4 x 4 block mean difference 4.31 / 4.34 / 4.39 to 3.88 / 3.90 / 3.84 (signed mean -1.12 / -0.91 / -1.24 to -0.33 / -0.05 / -0.15).

**HD shadows by hour and tileset, specials in Calculate Shadows** (branch we-shadows-1, 2026-11-18, HD). (1) **The light in
HD's real shadows**: `make-water-shadows.mjs --time 1|2|3 --tileset B` (Map Preferences' Time of Day in war3mapExtra.txt:
the status bar says 06:00, 12:00, 18:00; the editor's fixed day doesn't override it), one we-drive run with
`--looks-every-map` (every map gets the `--look` cameras), `--look 0,0,2400`, game view off, Shadows on and off; Studio
`--compare-ready lit` with `terrain.lighting.hour` 6, 12, 18. Taken back to linear light per pixel (the medians of the
darker half of each shadow), the ground keeps **0.36 to 0.39 of its light in the editor at every hour and on Lordaeron
Summer and Barrens alike** (dirt under the trees, footmen and a gryphon; 06:00 and 12:00 give the same picture there),
Studio 0.53 to 0.56. Misc checks 5's "0.08-0.10 lighter, blue up to 0.26" was this one factor seen through sRGB: the
dirt's blue is dark, so its ratio moves most. Map 03's footmen: the editor 0.375 (green; render-fixes-5's 0.50 was the
same shadow read through ACES's toe, which hdTone dropped on 2026-11-12, so Studio's shadows got lighter then). Studio
now leaves the ground GAME_SHADOW_FILL 0.31 of the lit light (tone.ts; the models keep GAME_LIGHT_FILL): 0.36 to 0.38 on
all of them, map 03 0.37; water under a footman 0.40/0.50 against the editor's 0.45/0.52 (red/green; before 0.56/0.60);
TwistedMeadows' opening view mixed (a house 0.49 against 0.52, rocks 0.38 and 0.51 against 0.44 and 0.45). cliff.w3m's own
lighting has no fill and is unchanged. (2) **Special doodads in Calculate Shadows** (`--save-shadows`; (2)LastRefuge with its
doodads emptied, with and without its one special, the cave YCr2 at tile 60, 85, footprint 12 x 12 cells): the cave
lights 26 cells of the notch it fills and darkens 2. Studio read the cliff models under it (26 + 2 off); the cave's own
model as it is drawn (origin in the footprint's middle, 270°, over the footprint's lowest layer), its highest surface on
all nine tiles, flat ones included, gives the editor's cells exactly (shadows.ts `specialCellHeights`); the tiles as
ground 44 off, the model on the cliff tiles only 6, turned 0/90/180 33 to 75, moved 16 units 6 to 14. The rest of the map
(59 cells) is the same with and without the special. (3) **Cells on a projected triangle's edge**
(make-shadow-probes.mjs shadow-boxes, saved again: the same 8 of 235 off): all eight lie on the boxes' diagonal x = y, the
sun's direction through the box: where the bottom's split edge and the west/south corner edge meet a cell's line. The
editor shades them for the box turned inward and leaves them lit for the closed, cap and floating boxes, so it is not a
plain inclusive or exclusive test (treating the edge as outside: 32 off, a tolerance of 1e-4: 41) nor a top-left rule;
probably the editor's floating-point rounding on lines exactly through an edge: not reproduced.

**Water shadows, HD saves, chapter objects, Open in World Editor** (branch we-compare-2, 2026-11-18, HD). (1) **Real
shadows on water**: `make-water-shadows.mjs --depth D --deep D --low-flyers --lake-trees` (lakes 12, 30, 45 deep beside
100 or 200 deep ones, gryphons and trees whose shadows fall in them), one we-drive run per batch of maps with
`--looks-every-map`, cameras `--look 300,250,2600` (shallow) and `1400,200,2400` (deep), Shadows on and off; Studio
`--compare-ready lit`, `--camera we:…`, `terrain.shadows.visible`. Units animate and waves move between the two pictures,
so per-pixel medians scatter by 0.05 to 0.14 (the same Studio build twice); the measure that held is the mean linear
light on over off over the shadow's core (where both pictures' blurred ratio is under 0.8), on the trees' still shadows.
The editor keeps green / blue 0.51 / 0.76 at 12 deep, 0.55 / 0.85 at 30, 0.68 / 0.89 at 45 (the bed's shadow seen
through alone gives that), 0.51 to 0.57 / 0.73 to 0.75 at 100 and 200 deep. Studio's one WATER_SHADE at every depth gave
0.47 / 0.66, 0.53 / 0.79, 0.58 / 0.83 and 0.58 to 0.66 / 0.78 to 0.81 (0.07 off on average); now (renderer.ts
`waterShadowKeep`: nothing taken of the water's own colour and reflection up to 45 deep, WATER_SHADE 0.9 / 0.5 / 0.72
from 100, smoothstep between) 0.51 / 0.73, 0.62 / 0.89, 0.68 / 0.92, 0.49 to 0.57 / 0.70 to 0.76 (0.03). Red isn't
readable in deep water (the editor's has 0.013 linear, Studio's 0.025); shallow red is the bed's (Studio's ground is
brighter, lowprio-bugs). (2) **The HD-mode save and Classic files** (`make-import-modes.mjs`, `--save` twice): of
import-modes-units, the editor writes `_HD.w3mod\war3mapImported\both.mdx` (the HD Peasant, 4372702 bytes) under the
plain `war3mapImported\both.mdx` (the Easter Rabbit, 56886): the import a placed unit (hpea) uses as its model; every
import of import-modes-list (none used) comes back byte for byte. A sync keeps the project's file then
(project.rs `keep_classic_over_hd`, report `kept_classic`; on the editor's real save the Rabbit stays). The save of the
13.8 MB map stood whole 1.2 s after Ctrl+S, one write seen at 500 ms polls (`--save` prints `writes` now), so Studio's
1.5 s wait before it syncs a World Editor save is enough there. (3) **The chapter Object Editor** (make-campaign.mjs
tiny-objects; `--campaign`, F7, Ctrl+O, the name typed, Return, the chapter row 620,283, Ctrl+M, then F6 and the Units
tab 147,198; a run whose Object Editor the editor restored at start showed the first map's data, `--close-modules`
after Ctrl+M and a click at 700,120 before F6 fixed it): a root **Campaign Units (1)** in blue between Standard Units
and Custom Units (0), Human > Melee > Units > Campaign Footman, all blue. Studio lists its Campaign group between
Custom and Modified standard now (it was last; app-smoke chapterObjects). A double-click on the first field with the
campaign unit chosen (258,706, then 380,243) opened "Edit Unit Value - Ability" (Abilities - Default Active Ability),
so the editor seems to let a chapter change a campaign object (the Campaign Editor covered the pictures; where the change
goes wasn't followed); Delete opened nothing. (4) **Open in World Editor**: app-smoke `worldEditorSync` with a stand-in
editor (WE_STANDIN: takes `-launch -loadfile`, rewrites the map whole, exits on a signal) proves the mark, the sync of a
save with "always" and the mark's end; with two editors open it now stays until both have closed. The real editor
through Proton isn't started by the app in a test (only we-drive starts it, through `proton run` in its own sandbox);
that its save goes to the `-loadfile` map is what `--save` copies.

**Map preferences** (branch map-settings-we, 2026-11-14; specs `tests/we-compare/map-prefs.json`; saves of
empty_map_on_newest_world_editor.w3m after each switch): the Trigger Editor's JassHelper menu (F4, menu 200,111: Enable
JassHelper 232,131, vJass 219,148, debug mode 236,165, optimizer 229,182; a click on 200,111 closes it, `--key Escape`
goes to the main window and leaves it open, which eats the next Ctrl+S; a save hides the Trigger Editor, F4 again) and
Scenario (166,41) > Map Preferences (203,146: Map Properties on its Prefs tab, Sky Display 700,195, Time of Day 700,217,
rows 13 px below, Enforce Terrain Limits 604,239, OK 818,831) write only `war3mapExtra.txt`, besides the save counter in
the w3i (lib/formats/mapextra.ts has the bytes: one [MapExtraInfo] section, LF, a fixed key order, only what differs
from the defaults, JassHelper's switches only with it on, an empty file once nothing is set). Not in the map: the
editor's own preferences (WorldEditPreferences.txt [Misc]: Sky Model, Fixed Day Night Cycle, Enforce Water Limits,
Enforce Camera Boundaries), which "Use Editor Preference" falls back to; the registry showed nothing. The editor reads
the file when it opens a map (the menu shows a map's debug mode ticked) and writes it from what it holds. In this
build the switches hardly reach the script: JassHelper on reformats it and inlines (with or without the optimizer),
`debug call` lines are dropped with debug mode on too (from the file and toggled in the menu), the optimizer changed
nothing on a small map, and vJass off left the editor's formatting with the inlining.

Ramps under the cliff brush (branch cut-ramp-wedges, 2026-11-14; spec `ramp-cliff-brush`): a line of ramp flags along x or y that climbed one level and doesn't after the brush loses all its flags, also where the brush didn't move the corner (lib/terrain/cliffs.ts `dropBrokenRamps`); one that still climbs keeps them. A w3e with ramps cut by a level change and their flags kept (Last Refuge's ramp after Studio's old Area Level ±1) the editor draws with black holes, as Studio did: the Area panel's Level now takes the flags off every ramp its block doesn't carry whole with the ground round it (`dropCutRamps`), and the editor draws those files clean.
Cliff types under the cliff brush (branch cliff-type-we, 2026-11-14; spec `cliff-type-stencil`, palette Level 1473,282): besides the corners on cliffs, the editor's Level, Increase One and Decrease One type a fixed stencil round the brush's centre, cliff or not, also where nothing moves (Level on flat ground). Size 1: the 3×3; size 2: 5 wide, 3 high; size 3: a plus of two 3-wide bars reaching 3 out (the same on flat ground, below, beside and on plateau.w3x's plateau); sizes 5 and 8: irregular shapes of 74 and 196 corners, the same at two places on flat ground and at five pointer positions round one corner, but a few rim corners differ next to an edited cliff (`cliff-type-up5-below`, `cliff-type-down5-edge`, expect differs). Studio: lib/terrain/cliffs.ts `cliffTypeStencil`. Clicks at 300,450 and 345,450 (west of the plateau) centre the editor's brush one row south of Studio's (spec `cliff-click-row`, expect differs, branch cliff-click-row-we): on flat ground 128 below the camera's target, Studio's `we` camera (we-camera.mjs FIT) meets the ground at y 31.569, the editor's fitted camera at 31.483, so the test camera is the cause, not the pick or the brush.

Tile strokes and cliff types (branch painted-cliff-type-we, 2026-11-14; specs `painted-cliff-type`, `cliff-floor`, `cliff-type-mixed`): a tile stroke alone never re-types a cliff (Apply Cliff unticked, or no cliff tool picked since the map opened: sizes 1, 3, 5, 8, on, beside and over part of a pit, Rock, Grass over Dirt Cliff, plateau.w3x's edge, either cliff type chosen: `painted-cliff-type-*`). The editor's Apply boxes add up: a tile picked while a cliff tool is on (or the other way round) leaves both ticked, and one click then paints and runs the cliff tool, with the same file as Studio's Paint stroke followed by its cliff stroke there (`painted-with-cliff-*`); the new cliff takes the chosen cliff type, not the tile's. A map opened in the running editor starts with Apply Cliff off, but the cliff tool and the size stay as the last map left them, and clicking a cliff type thumb ticks Apply Cliff with that tool. The cliff brush's limits (`cliff-floor`): a Decrease whose level would be below 0 does nothing at all (Decrease One and Two on a level-0 floor, Decrease Two on level 1; Studio: `strokeLayer`), and no cliff gets taller than two levels: the corners next to the brush come along to within two of its level (`cliff-reach-*`; Studio: `applyLayer`). A second cliff click at 748,500 on a size-8 Increase Two plateau made there does nothing in the editor (three runs; 800,520 works: `cliff-stack-*`). Cliff brush with another cliff type than the cliff it touches (`cliff-type-mixed`, expect differs, no rule found): the editor sets corners in the square size + 1 round the centre, outside the typed stencil, to the level the stroke started on (pit floor corners go up, low ground below a plateau goes up to it), and re-types the old cliff far beyond the brush (plateau.w3x's whole rim from one size-3 click; a pit's corners that are still on a cliff), sometimes with both types mixed; with no foreign cliff near (`-far`, `-plateau-up1-top`) or the same type chosen it matches Studio.

Terrain specs (`we-compare-w3e.mjs`, `we-compare-ui.mjs`; specs `cliff-adjust-dry`, `unit-heights`, `water-brush-slope`,
`water-brush-more`, `painted-cliff-type`, `height-random-stops` in `tests/we-compare/`, inputs and their generators in
`tests/fixtures/we-specs/`): compare kind `w3e` (the binary w3e corner by corner, `corners.30,27.ground: WE 0, Studio -48`;
the random ground and cliff variations are left out), `w3e-spread` (the set of ground offsets, for runs that draw at
random: Reset Height Field Random) and `unit-heights` (id, x, y, z of war3mapUnits.doo). Studio step `ui`: the terrain
painter's real mouse at the World Editor's screen positions (`["tab","Terrain"]`, `["view","we"]` the editor's opening
camera at its 1184x844 view, `["tool","Paint:"]`, `["texture","Lgrs"]`, `["size",3]`, `["click",748,500]`,
`["drag",x,y,x2,y2]`, `["cliff","Dirt"]` the Cliff type choice), so one list of positions drives both editors. The World Editor's palette on its 1600x1000 display
(`--key t`): tile thumbs 1409,112 (Dirt) / 1409,144 (Grass), cliff icons y=282 from x=1409 (1409 is Decrease Two; the
others, 32 px apart, are probably Decrease One, Level, Increase One, Increase Two), water brushes 1441,310 (Deep) and 1473,310 (Shallow), cliff type thumbs 1409,367 (Grass Cliff, chosen
when the editor starts) / 1441,367 (Dirt Cliff), Apply Cliff box 1373,244, sizes y=569 at x=1392 (1), 1424 (2), 1456 (3), 1488 (5), 1520 (8); Advanced menu
260,41 (Adjust Cliff Levels 299,206, Reset Height Field 300,189: its Random box 589,429, Smoothing slider 592 to 773
at y=534, Variation slider 589 to 773 at y=494, OK 669,573, "Continue anyway" 767,523). The editor's Create New Map
dialog (`ctrl+n`) lists 22 tilesets and no Misc, so a Misc-tileset base tile can't be compared there.
The water brush specs hold with the editor's Enforce Water Height Limits on, its default. we-drive now writes
`Enforce Water Limits=true` and `Enforce Camera Boundaries=1` (`PINNED_PREFS`) and `[Minimap] Show Creep Camps=false`
(`PINNED_MINIMAP_PREFS`; `withEditorPrefs`) before each editor start, so a run no
longer depends on what the last one left in the shared prefix (with the limit off, seen 2026-11-14, the editor leaves out
the 35-unit lift next to the water and the dry rim's water word). `--keep-prefs` (we-drive, we-compare) leaves all three as
they are. The other View toggles aren't in the preferences file. Within one running editor (several specs of a
we-compare process share it) a toggle a spec switched stays until the editor restarts.
Height brushes (branch raise-brush-we, 2026-11-15, spec `height-brush`, flat.w3x, clicks at 748,500): the palette's
Apply Height box 1372,470, tools at y=507: Raise 1409, Lower 1441, Plateau 1473, a spiky one 1505 (not measured), Smooth 1537; Shape at
y=624: Circle 1392, Square 1424 (the shape stays for the editor's session: a spec sets it back). The editor has no
strength: one stamp per click, and a pointer held still adds nothing (1 s and 3 s holds gave the click's result).
Raise/Lower: a cosine dome of 25.6 stored units a size at the middle, the corners strictly inside radius size - 1,
rounded down per stamp, round with either shape. Plateau and Smooth take the disc with its rim (or the square): Plateau
sets it to the stroke's first corner, Smooth is a 48:2:1 kernel (terrain-painter/tools.ts `raiseLower`, `plateau`,
`smooth`). A drag stamps at the editor's own ticks where the pointer moved (20 steps of 1, 5, 10, 15 px over 3-4 s added
5, 15, 18, 16 stamps), so no drag spec: Studio stamps per 40 ms tick once the pointer is 16 units on (`steppedTick`).
**Noise** (the spiky tool, 1505,507; branch we-terrain-2, 2026-11-17, spec `height-noise`, flat.w3x, compare kind `w3e-noise`): one stamp
takes every corner within radius size - 1, the rim included (sizes 3, 5, 8: 13, 49, 149 corners, 13, 45-47, 140-141 changed:
one in 21 draws 0), to its own whole step of -10..10 times 25.6 stored units, rounded down (-256, -231 ... -26, 25, 51 ... 256;
evenly drawn, whatever the size, no falloff, the Square shape takes the 9 x 9 square at size 5). A held button adds nothing
(45-48 corners within 256 after 2 s); a drag of 100 px over 2 s stamps along the way (73 corners up to 1286). Studio's was timed,
cosine-weighted and open-rimmed (44 of 49 corners, up to 410 when held): `tools.ts` `noise` now stamps like Raise (`steppedTick`),
the Strength slider and `HeightStroke` are gone; Studio's counts 13, 46, 142, 47, 79 at those settings, the drag 70 corners.
Cliff slopes (branch cliff-slope-we, 2026-11-15, spec `cliff-slope`; inputs `level14.w3x`, `pyramid.w3x` from
`make-levels.mjs`): after a cliff brush sets its corners, each corner beside or diagonal to one that moved comes to within
two levels of it, ring after ring until nothing moves (terrain-painter/tools.ts `cliffSlope`). Measured by saving after
each of ten Increase Two clicks on one pixel of flat.w3x (sizes 1 and 3): every save was Studio's stamp on one corner
(tools.test.ts). The "cap" of 12 such clicks seemed to have came from the pointer: its corner moves down the growing
slope, and a click on the top past 15 wraps round as the 4-bit level does (14 + 2 and 15 + 1 make level 0, a pit whose
slope takes the plateau down round it; Studio refuses that click, `topRefusal`). With Enforce Terrain Limits on, an Increase whose level would pass 14 does
nothing (from 13 and 14 alike). The slope's corners take the cliff type; the corners round them only round the ring
beside a brush larger than size 1 (`Stroke.typingArea`: fits the 20 saves but 2 corners; the rule is a guess beyond
them). Studio's pick over
cliffs of two levels lands on other corners than the editor's (`cliff-slope-up2-1-pick`, expect differs), so a click
sequence on one pixel (the `limits-*-cliff-cap` specs) still differs. Not built: with the limits on, an edit also put
every level-15 corner of the map to 14, and lowered the ground of a corner whose level and ground passed level 14's height
(an Increase One to 14 on ground +512 left 0 there, 98 and 183 round it); and the editor's open and save alone evened
out a map's cliffs taller than two levels (a level-12 block on level 2 came back stepped).
Dragged cliff strokes (branch drag-stroke-we, 2026-11-14, spec `drag-stroke`): the editor stamps its brush only where the
pointer is at its own ticks, nothing in between (a 20 ms `--drag` of size 1 raised one corner, of size 3 one brush, not at
the press point), so a quick drag has gaps and two runs of it differ; at 3 s for 20 steps it sees every step and matches
Studio's stroke (stamped along the way, `strokepath.ts`). The layer is the start's + 1 for the whole stroke, as Studio's.

Water brush specs of round 14 (branch we-specs-r14, 2026-11-14; `water-brush-square`, `water-brush-low-level`,
`water-brush-ramp`, `water-limit-square`): the palette's brush shape is under "Shape" at 1392,624 (circle) and 1424,624
(square; the palette window cuts the buttons off at y 630, the top half takes the click), Studio's `ui` action
`["shape","square"]`. Like the size, the shape stays as the last map left it in a running editor, so a spec after a
square one clicks the circle. Advanced > Enforce Water Height Limits is ctrl+shift+w (its check mark seen gone after the
key); it stays switched in that editor, so a spec that switches it off is the last of its file. With it off the editor
still lifts low ground under the brush (as with it on) and only leaves the dry rim's water word at 8192
(`water-limit-off-deep`, expect differs).

### Comparing pictures with Studio

Both sides at the same size, camera and lighting, then `pic-compare.mjs`:

```sh
node scripts/we-drive.mjs --map M --compare-ready --look center --shot we.png --close        # game view
node scripts/app-drive.mjs --map M --terrain --view-size 1184x844 --camera we --compare-ready game --shot st.png
node scripts/pic-compare.mjs we.png st.png --sample --diff d.png
```

| World Editor (we-drive) | Studio (app-drive) |
|---|---|
| `--compare-ready`: game view on, the day fixed (06:00) | `--compare-ready game`: Studio's game view (`terrain.gameView`, V), lighting on at hour 6: no start locations, regions, cameras, pathing, grids or light ranges, as the editor's |
| (game view off, the editor's marks drawn, lit) | `--compare-ready lit`: `terrain.lighting.enabled` on, `terrain.lighting.hour` 6, game view off (the pair used before Studio had a game view: start locations still drawn) |
| `--compare-ready-unlit`: game view off, View > Lighting off | `--compare-ready unlit`: `terrain.lighting.enabled` off (Studio's even light), game view off |

**What the editor's game view leaves out** (we-drive on a copy of map 03 with two regions, a camera, three lit
doodads, and Regions, Camera Objects, Pathing - Ground, Camera Bounds, Light Ranges and a grid all on, 2026-11-09):
all of those, and the start location with its start building; units, doodads, water and the lighting stay. Every View
item is greyed while it's on, and comes back as it was after. Studio's game view (viewmodes.ts `shownView`) does the
same, and its badge "Game View" stands where the editor's "Game View Settings" note would. With those items on in
both and the same camera (`--look center,2200`), the editor's game view against Studio's `--compare-ready game` was a
mean absolute difference of 6.7, against `--compare-ready lit` (the regions, pathing, grid and start location drawn)
24.1. Studio's toggles and keys are checked by app-smoke (`viewModes`).
| `--look x,y[,distance[,aoa[,fov[,rotation]]]]` | `--camera "we:x,y[,distance…]"` (only angle 304 and field of view 70 are fitted) |

Studio's defaults are lighting on at hour 12 (`terrain.lighting.*` in the terrain viewer's extension.json). On map
03 at the opening view (HD, both pairs), the mean absolute difference was 17.5 (lit) and 16.5 (unlit) before the
editor's picture tone went into Studio (`lib/model/tone.ts`, branch render-fixes-2), and is 7.7 and 6.9 after; on
cliff.w3m 42.8 and 14.1 before, 26.8 and 7.1 after. What is left on map 03 is the lake's shore and the start
location, which the editor hides in game view. The editor's HD game view draws no shoreline waves (its classic game
view and its unlit view do: white crests at the water's edge, where Studio's foam sits about a tile farther up the
shore); Studio leaves them out in HD with the lighting on (renderer.ts `groupShown`). On
cliff.w3m lit, its own lighting (sun 1.95, shadow intensity 5.85) came out brighter in the editor (grass green 248
against 218) until branch render-fixes-4 (below): 245 now, the opening view's mean difference 28.3 → 19.9; light_map.w3m
(the same lighting) 19.9 → 9.1 at its centre and 33.3 → 25.2 close up; map 03 7.0 → 7.2.

The camera lines up on raised ground too: on map 03 (ground 256 high at the centre) the start location's ring is
within 1 px of the editor's and the two footmen within 3–5 px. The lake's edge differs by how each fades the water
in from the shore (in SD within 3–14 px, in HD 10–30 px), not by the camera. The editor fades each corner by its own
stored water level, flagged or not: map 03's shore corners are stored far below (-346 under the bank), so its lake's
edge follows the wet corners tile by tile; the same map with them stored at the lake's level shows a smooth oval
(we-drive, both, 2026-11-08). Its HD lake is opaque sooner from the shore than the classic ramp (about 0.37 at depth
11, 0.59 at 22, 0.85 at 71). Both are in renderer.ts (`waterTile`, the HD branch of the water shader).

**Making the editor show a light**: `--look` maps are copies, so a variant of a map with a lighting model written
for the test (war3map.w3l naming two `<guid>.mdl` files, unpacked and packed with the release CLI) shows what the
editor does with one value at a time. That is how tone.ts was fitted: flat ground of cliff.w3m, the sun straight
down at intensity 0.5, 1 and 2, at 52° from the south, north, east and south-west, ambient alone, shadow intensity
0, 2 and 5.85; with no light at all the view is black and `--compare-ready` never sees it drawn.

Measured again on 2026-11-08 (branch render-fixes-3), with both of cliff.w3m's lighting files changed per variant:
- **The ground in game view follows the map's unit lighting model**, not the terrain one: changing only the terrain
  file (its shadow intensity, its sun's intensity) left the flat grass the same to the last digit; changing only the
  unit file changed it. (cliff.w3m's two files are the same and both name their model `DNCLordaeronTerrain`, so a
  cache by that name would look the same; a map with two different models would tell.)
- **The shadow intensity's lift is much stronger than shadeWrap's** at the cliff's sun (52° from straight up), and
  grows with the sun's intensity. k (the light on flat grass over the editor's own light, from the mean green by
  simulating the tone curve per pixel of the unlit picture, so values near white aren't underestimated): sun 1.95,
  ambient 0.2, shadow 0 / 1 / 2 / 3 / 5.85: 0.93 / 1.45 / 2.12 / 3.14 / 16.4 (Studio's hdLight and shadeWrap: 1.31
  / 1.81 / 2.32 / 2.83 / 4.28); shadow 5.85 with sun 0.5 / 1: 2.43 / 4.01; sun 1.95, shadow 5.85, ambient 0 / 1:
  13.4 / 32.7; shadow 0, ambient 0: sun 1.95 0.79.

Measured once more (branch render-fixes-4) with the cliff's south walls close up (`--look 0,600,1000`, the same twelve
variants and an unlit picture; walls told apart by their brown in the unlit picture, k per channel the same way):
- The sun is in the south-west (the unit shadows fall to the north-east), so those walls face it (cosine about 0.4),
  not away. Their green k for shadow 0 / 1 / 2 / 3 / 5.85: 0.71 / 1.22 / 1.67 / 2.14 / 3.81, about 0.5 more per unit,
  the same as the grass's while its green is below 200 (0.92 / 1.45 / 2.13): **the lift is the same on every
  surface**, 1.32 × (1 − 0.62) per unit for this sun, none with the sun straight down (`facing` in tone.ts). A lift by
  the surface's own (1 − cos), which shadeWrap was, whitened the walls (0.75 per unit).
- Beside a sun the ambient adds as it reads (walls 3.63 / 3.81 / 4.65 for ambient 0 / 0.2 / 1; 0.14–0.18 for 0.2 at
  shadow 0), not as the ambient-alone fit's 1.24 × colour^0.52 (hdLight).
- The large k above came from the tone curve, not the light: the walls' red (226) and the bright grass (238) need far
  more k under ACES than their green and the dim grass. With the light as above, ACES is 10.5 levels rms off over all
  36 means, ACES with a shoulder that reaches white from linear 0.69 on (`HD_SHOULDER`) 3.9.
- The ground doesn't follow the unit model after all, at least not the game's own: map 03 (no lighting of its own,
  so Lordaeron's terrain and unit models) with the ground under the unit light came out 18 levels darker than the
  editor's grass (106 against 125); under the terrain light it's within 0.1. The render-fixes-3 finding came from
  cliff.w3m, whose two files both name their model `DNCLordaeronTerrain`.

**Shadows** (branch view-shadows, 2026-11-09; we-drive `--game-view off` then `--view Shadows=off`, the luminance
ratio of the two pictures shows what View > Shadows draws): the classic (SD) view draws war3map.shd on the ground
(0.65 of the colour in a full cell, filtered between cells), the shadow images of buildings and destructables
(`ReplaceableTextures\Shadows`, a texel per 32-unit cell, the red texel on the object) and the units' Shadow.blp
textures; the HD view instead casts the models' own shadows (a footman's shape) and draws no war3map.shd at all.
How Studio follows that, and the numbers, are in `viewshadows.ts` (SHADOW_LOOK, shadowLookFor). A test map with
buildings, units, trees and a barrel on cliff.w3m's flat ground (made with the release CLI, unpack, JSON, pack) was
what told the parts apart.

**HD's real shadows** (branch hd-shadows, 2026-11-09; we-drive HD, Shadows on over off, `--game-view` on and off give
the same shadows): the models' own shapes from the sun, on the ground, on water and on the models; none from cliffs
or the ground (cliff.w3m: the same picture), and none at all with View > Lighting off. They fall from the units' sun
(map 03's footmen's to the north-east, as its unit light; the terrain light's is east). How light they are depends on
the lighting model, not a fixed darkness: the test map above (`lab.w3m`) with cliff.w3m's lighting files changed one
value at a time gave black shadows without ambient and shadow intensity, shadows as light as the lit ground at shadow
intensity 1, and lighter above (5.85: yellow on orange sand); the game's own HD lighting keeps about half the light
(map 03's footmen 0.68 of the colour). The fit is in tone.ts (SUN_SHADE, GAME_LIGHT_FILL, sunLight), the shadow map in
lib/model/sunshadow.ts. Against Studio's HD pictures (`--compare-ready lit`, the same looks, Shadows on over off), the
shadow's light over the lit ground (green) was 1.56 / 1.32 / 1.30 in the editor on the test map's three looks, 0.71 /
0.71 / 0.69 with the stand-ins before and 1.35 / 1.29 / 1.32 now; map 03's footmen 0.68, 0.62, 0.64; TwistedMeadows'
trees 0.73, none, 0.60. The overlap of the shadows (pixels that change with Shadows, both pictures; the editor's
include its animated models) went from 0.05–0.27 to 0.12–0.63 on the test map, 0.16–0.21 to 0.25 on map 03, 0.01 to
0.13 on TwistedMeadows; the whole picture's mean difference hardly moves (shadows are a small part of it: 10.9 → 10.5,
14.5 → 13.8, 13.7 → 11.8 on the test map, map 03 and TwistedMeadows within 0.2). The editor's gryphon flies, and its
shadow with it; Studio draws it so since branch terrain-extras (below). `app-drive --frame-cost` reports the last
frame's real shadows (`sunShadows`).

**Shadows, water and shore against the editor once more** (branch render-fixes-5, 2026-11-09; light ratios Shadows
on over off with the tone curve inverted per pixel, green, medians): the models never got the game lighting's fill
(the model shader's uniform list lacked it), so trees and units were near black in shadow and on their sides away
from the sun (TwistedMeadows' tree trunks 24, 11, 3 with Shadows off against the editor's 79, 52, 22; now 58, 29, 10).
Models now take it on every surface (tone.ts objectLight), the ground in shadow only. Ground in shadow: map 03's
footmen 0.50 (editor) / 0.54 → 0.56 (Studio before → after), TwistedMeadows' trees 0.54 / 0.51 → 0.56 and 0.60 /
0.52 → 0.59. HD water was the bigger part of TwistedMeadows' difference: its centre is water 38 deep over rock, which
the editor shows nearly as the rock; five pools of set depths (8–96) on flat grass gave the editor's opacity and a
lighter shallow colour (renderer.ts HD_WATER). TwistedMeadows' opening view against the editor's game view 16.8 →
10.4, unlit 19.1 → 11.2; the pools 11.4 → 10.0; a test lake on map 03 with a gryphon and two nagas 13.0 → 12.5 (lit),
15.6 → 14.0 (unlit); map 03 unchanged (6.9). The same pools put the editor's shore waves where the water is at least
24.5 deep and only on the shore's −X and −Y sides (shoreline.ts). Still different: the editor shows a swimming
naga's body through the water (its opacity seems to go by the water in front of what's behind, not by the bed's
depth), the lake's outline (an oval in the editor), and the trees' lit sides are darker than the editor's.

**Units' heights** (branch terrain-extras, 2026-11-09, HD, copies of map 03 with units added by the release CLI): the
editor draws every unit at its flying height (UnitData `moveHeight`, object data `umvh`) over the ground under it, and
ignores the height the placement file holds: footmen stored at 0, 256 and 600 on ground 256 stand on it alike, gryphons
(240) stored at those heights fly at the same height, a footman and a banshee given 300 and a gryphon given 600 in the
map's object data fly that high. Over the lake a flyer is over the bed (heightAt), not the surface; at the lake's cliff
edge it follows the ground as drawn (within the camera's few pixels). Ships stay on the surface. The selection circle of
a flyer lies on the ground under it. Studio's pictures at the same looks put the units within 5–15 px of the editor's
(their stand animations differ); app-smoke `flyingHeights` reads the drawn heights (`drawnUnits` of the view's handle).

**Fire and particle colours in HD** (branch render-fixes-4, 2026-11-09, a test map with AObr, ZObz, LObr, OOgr, ZZdt,
AOob and AOnt in a row, the editor in SD and HD): the particle colours are read right (red, green, blue): the
editor's classic view shows the same yellow-green fire on ZObz and the same faint green-yellow haze over the grate
OOgr as Studio's stand-ins. The HD editor draws the Reforged PopcornFX effects instead (orange glows), which Studio
can't; its stand-ins are the classic emitters, additive, so orange over the bright HD grass turns lime and blue
turns cyan. Particles don't go through the HD tone curve. What was wrong and is fixed: HD emissive textures (layer
slot 3: AOob's red runes were black, AOnt's lamp unlit), Reforged models whose classic emitters are empty
placeholders (LObr: no fire at all), the HD City cliffs' placeholder textures (`ReplaceableTextures\Cliff\Cliff1_…`,
drawn white on OrcX02_03) and Cityscape's HD water colour (blue).

**Click helpers, scale ranges, ZZdt, submerged models and trees** (branch render-fixes-6, 2026-11-09, copies of map 03
with doodads, custom doodad types and units added by the release CLI, the editor in SD and HD):
- Every `useClickHelper` doodad (Doodads.slk) gets the editor's click helper beside its model, outside game view only:
  WorldEditData.txt's `ClickHelper` (InvalidObject.mdx, a 128 cube whose white squares its geoset colours magenta) at
  `ClickHelperScale` 0.4 of the doodad as drawn, `ClickHelperColor`'s alpha 96 (objects.ts CLICK_HELPER). A dust type
  given scales 0.5–3 and placed at 1, 2 and 3 showed cubes 46, 80 and 126 px wide; turned doodads turn it. Studio's cube
  lands on the editor's to the pixel; its colour is the classic view's (the HD view blends it in linear light: brighter
  magenta, lighter black squares).
- A doodad or destructable stored outside its type's minScale..maxScale is drawn at the nearest end, per axis (ZZdt 1–1
  at 4, the armor rack LOam 0.8–2 at 3, the hay cart LOch 0.8–1.2 at 2, 1, 1, Lordaeron's tree LTlt 0.8–1.2 at 0.4 and
  3); the stored scale stays (objects.ts scaleRange).
- ZZdt (DemonFootPrint): the classic view does draw the footprint and its flame, small and under its click helper
  (seen through the cube at distance 900; a custom hay-cart type with the same model shows them plainly at 1000–2200).
  The HD view draws the Reforged model, which has no geometry and only a PopcornFX effect (CORN, visibility 1 in its
  Stand) that shows nothing; Studio stands in the classic model's emitters for PopcornFX models (the fires need them),
  so it draws a flame there. No table field or model value tells ZZdt from the fires (scanned: the 62 doodads whose HD
  model is PopcornFX and whose classic model has emitters).
- HD water over a model under its surface goes by the water in front of the point seen, not the bed's depth (the
  editor shows a swimming naga's tail): renderer.ts drawWaterDepth, viewdepth.ts. On the copy of map 03 with two naga
  myrmidons and a siren in its round lake the tails now show; the region's mean difference hardly moves (lit 14.2 →
  14.3, unlit 13.1 → 12.8: the swimming poses differ). The editor's tails look clearer still.
- TwistedMeadows' trees are darker than the editor's also with View > Lighting off (green 61 against 85), so not by the
  sun or the fill: the alpha test at 0.5 or 0.3 instead of 0.75 gives 63 and 64, an even light on the models of 1.0,
  1.2 and 1.43 gives 68, 75 and 82, where 1.2 matches the rocks there (87 against 87) but makes map 03's racks too red
  (38 against 28). Other HD models are darker too (TwistedMeadows' rocks 75 against 87, the roof 79 against 89, unlit),
  each by its own amount: the editor's HD shading of the materials (normal and ORM maps, which Studio's model shader
  doesn't use for light) is the likelier cause.

- **Special doodads** (branch special-doodads-we, 2026-11-13, AutumnLeaves_S2, look -6208,-5376,1200; we-drive SD and HD
  give the same picture): to see which patches of Studio's picture are the specials, rewrite war3map.doo.json with
  `specials: []` (app-drive `--eval` with `w3.workspace.writeText`) and `pic-compare` the two shots. At the first YCl2 the
  editor draws a cliff hollow exactly there, so the position fits; Studio's model shows as a hard-edged flat grass
  square with tan rock on it (lowprio-bugs). Not compared: facing and height of other types. The editor's picture is
  dark on its left half there (outside the camera bounds), Studio's isn't.
- **Specials, Classic conversions, portal, bounds line, variable values** (branch we-misc-3, 2026-11-17, we-drive
  `--mode hd` (its default) and `sd` against app-drive with `--set game.graphicsMode='"sd"'` (Studio's default is HD);
  `--camera we:` and `--look` with the same x,y,distance; pic-compare):
  (1) *Variable initial values* (`tests/we-compare/var-initial-values.json`, Studio's `add_trigger_variable` into a
  new map, the editor opens and saves it): real 1.5, 2.345, -0.1, 7 (the editor's script and wtg: 1.50, 2.35, -0.10,
  7.00), integer 0x1F, 0xff, 42, -5, unitcode hfoo (`'hfoo'` in the script), string: war3map.wtg and the `udg_` lines
  MATCH. (An integer variable can't hold `'hfoo'`: Studio refuses it, only the object-code types take 4 letters.)
  (2) *Specials* (input `tests/fixtures/we-specs/make-specials-look.mjs`: plateau.w3x with 25 specials, flat-ground
  rows of YCd1-4, YCl2, YCc1-4, LCc0, LCc2, YCg1, YCp2, YCu2, YCr2 and caves and collapses on all four faces of the
  two-layer plateau; looks 0,-2560 / 0,-1792 / 0,1536 / 0,-128 at 2600): the editor draws every one, the city types
  YCd/YCc too (on a Lordaeron Summer map). Same places and shapes as Studio's. Left: (a) on **flat ground** (corner
  cliff texture 15, the "none" of the w3e) the editor's cliff part is a flat quad with an unresolved texture, **white
  (255, 255, 255) in SD and blue (40, 66, 78) in HD**, tile-aligned at the footprint's edge; Studio's tile of the first cliff type is
  tan like the ground and shows nothing; (b) the dark inside of a cave or collapse is the editor's black all through
  the hollow, Studio's shows a ground-coloured polygon (AutumnLeaves' LCc0 at (5632,-1152), HD: the same, so not the
  plateau's doing; back faces were not the cause: switching culling off for the models changed only a small piece);
  (c) **fixed**: on a plateau's face the editor gives the special the cliff type of the tile it is placed by
  (`sp.x, sp.y`, the footprint's bottom left), Studio took the tile under the model's middle, often off the cliff, so
  its tops were tan where the editor's are green (`specialTileCliffType`; region 0,0,1184,640 of the plateau view
  mean absolute difference 21.1 to 15.9; plain ground alone is 7.7, the camera fit's offset). The camera fit
  moves a real map's picture by about 30 px at 1300 away (AutumnLeaves), so only shapes can be told there.
  (3) *Classic conversions* (`openpoints/example-maps/14c_GraphicsModes_Classic_and_HD.w3x`, SD, look 0,1800,3600): the
  editor draws all eight Studio-converted models (Iron Gate, Capital Tower, Palace Walls, Pillars, Wall Endcap) with
  the same shapes and textures as Studio, so the game's not drawing them (user.md 14c) isn't the model data the
  editor reads; the tower is 11 darker in mean colour in Studio (lighting; a native Classic model was not compared).
  (4) *Map 16's outer columns* (`16_Particles_Doodads.w3x`, HD, looks -2000,1600 and 2000,1600 at 3000, -2000,2400
  at 900): ShimmeringPortal's disc has the editor's hue (r:g:b 0.83:0.57:1 against 0.87:0.62:1) and is 12 darker; its
  rim is pinker in Studio (b/r 1.13 against the editor's 1.37, bluish white); the centre glow is a moving shape in
  both (magenta flower in the editor, a white slit in Studio at that moment). The Ruin Fountain is 125 px across in
  the editor and 80 in Studio at the same camera (the other doodads' sizes and places match): not looked into. Rising
  Water is more opaque and bluer in the editor.
  (5) *Camera bounds line* (`camera-bounds.w3m`, SD unlit, look 2816,0,1500 and 2816,2816,1500): the editor draws a
  one-pixel line of exactly (128, 128, 255) at the bound, Studio's was (150, 200, 255) drawn over two pixels at half
  strength: the colour is now the editor's (`CAMERA_BOUNDS_RGB`); the line is still antialiased over two pixels.
  The line is on by default in Studio's terrain view and off in the editor's.
- **Picture parity 4** (branch we-look-4, 2026-11-17; we-drive and app-drive as in the bullet above, inputs
  `make-specials-look.mjs`, `make-geoset-color.mjs`, `openpoints/example-maps/16_Particles_Doodads.w3x`):
  (1) *Camera bounds line*: now one pixel wide, every pixel exactly (128, 128, 255): `crispline.ts` steps the projected line
  pixel by pixel (Bresenham) and the renderer draws each pixel as a GL point of size 1 at its centre (the canvas is
  multisampled, a GL line came out over two pixels at half strength); camera-bounds.w3m, SD unlit, `--camera we:2816,0,1500`:
  844 pixels of exactly that colour in one column; at rotation 60 a one-pixel staircase of 1050. The editor's picture
  has no line (off by default there); Studio keeps it on by default (a UX choice, nothing in the editor's view mode needs it).
  (2) *Export Minimap in HD*: the editor draws the grey 183 dot for a doodad whose model is stored only below `_DE.w3mod`
  (EOcr, LCpa, LRsr, UO*, YO*); Studio's minimap reads the game without that layer (`minimapgen.ts` `withoutDeLayer`, the
  map's own import of the file still counts; the model view keeps the fallback). `mmsave-dots-models-hd` (new, same map as
  the SD spec) MATCH, `-sd` still MATCH. *A material never seen* (branch we-compare-3, 2026-11-18, HD Export Minimap of
  flat.w3x with five ASpr): the HD pier's three materials are its diffuse, a glow (alpha track) and the diffuse again at
  static alpha 0 (the walk plane); the editor's dot core is about 182, 152, 95, the mean of the first two (179.5, 149.5,
  94.5), not of all three (154, 125, 82). `minimapgen.ts` `shownTextureMean` leaves out a material whose first layer has
  alpha 0 and no alpha track; on minimap-dots-models only ASpr's dot changes (and USba's by 5, whose editor dot is the
  grey 183 one while Studio's is 104, 94, 108: not looked into).
  (3) *Geoset animation colours*: AzsharaStatue's geoset 2 (RedRock texture) holds only the static colour (0.31, 0.78, 0.86) and
  the editor draws it **gold**: the static colour is stored blue, green, red like the colour track's keys (Studio read it red,
  green, blue, grey stone); `renderer.ts` turns both now (`modeldraw.test.ts`; the statue is gold in Studio's picture).
  (Corrected by Picture parity 5: only the keys are turned; the gold is the statue's texture, its static-coloured pedestal is teal.)
  This makes ShimmeringPortal's static glow colour (0.467, 0, 0.992) pink-red where it was violet, and the portal rim of map 16
  was already pinker than the editor's: the rim's cause is not the static colour (the glow's alpha track, key times 3333
  and 10333, lies outside its Stand 14967-15300).
  **Left, with what was found**: (a) AzsharaStatue's pedestal is a teal hex column in the editor and a red-brown pyramid in Studio,
  and ShroomsBlue is the 27-vertex cap (geoset 1) alone in the editor where Studio draws the 110-vertex mushroom (geoset 0)
  and hides geoset 1. Both models' geoset alpha / colour tracks have **no key inside the Stand interval except one at its
  first frame** (Azshara Stand 167-1167: g1 alpha keys 167 = 0, 1333 = 1, g0 colour 167, 1333, 2667 with the last (0.53, 0.6,
  0.38); Shrooms stand 167-1167: g0 alpha keys 1833 = 1, 3233 = 0, g1 167 = 0, 1300 = 0, 2000 = 1, 6667 = 1). What the editor
  draws is each track's **last key** (g1 shown, g0 hidden, the teal from Azshara's last colour key turned blue, green, red),
  not the key at Stand's start that Studio takes. Not changed: as a general rule ("a track with no key after the sequence's
  first frame holds its last key") it would also reach every model whose Stand begins on a key, and no second model was measured.
  (b) Specials on flat ground: with replaceable 11 left unresolved on those (path empty: texture null, drawn white) the cave
  and collapse walls turned white too, where the editor keeps their rock texture and only the flat quad at the footprint's
  edge is white (SD) or blue (HD): the quad is not "texture 11 missing", so it was not changed (a tile of cliff texture 15 still
  takes the first type); the HD cave interior is black in the editor's pictures where Studio shows its ground through the
  hollow (HD CityCliffDoodadCave1: geoset 0 the cliff placeholders, opaque; geoset 1 the diffuse with blend, 285 triangles each,
  the diffuse 2048 x 2048 with 20 % of its pixels alpha 0 and a mean colour of 40, 33, 27): not settled.
  (c) Map 16 (HD, `--look` at 700): the editor's picture is about 1.4 times larger than Studio's at the same x, y, distance for
  everything (grass blades, the fountain 520 px against 360 px across; at 3000 it was 125 against 80 for the fountain alone),
  so the camera fit at short range is what differs, not the Ruins Fountain's scale (ZOfo, scale 1). Rising Water (IZrw,
  `RisingWaterDoodad.mdx`: one blend layer with the 24 `ReplaceableTextures\Water\WaterNN` frames, alpha track key 3567 = 1
  inside its Stand 3500-8500) is bluer and more opaque in the editor than Studio's green, light water; not looked into further.
- **Picture parity 5** (branch we-specials-5, 2026-11-18; we-drive `--compare-ready` / `--compare-ready-unlit` against
  app-drive `--compare-ready game|unlit` and `--camera we:`, pic-compare; test models made with lib/model/classic.ts
  `toClassicMdx` or by rewriting an MDX's texture entries, imported into copies of flat.w3x / specials-look.w3x under the
  game model's path, which the editor draws in SD and HD alike):
  (1) *Specials on flat ground*: the white (SD) / blue (HD) quads are **holes in the ground**, not the model. The YCc3 model
  with layer 0's texture made solid red and YCc2's layer 1 solid blue: every model triangle took the colour, the quads stayed
  white or black; a low side view shows them flat on the ground, white as the SD game view's background above the horizon.
  The editor leaves every tile of a special's footprint without ground, flat tiles too (cliffs.ts `planCliffs` hiddenTiles);
  where the model doesn't cover its tiles one sees what is behind the ground (SD game view white, without game view black;
  HD (42, 69, 82) under a skybox, Studio black). The black inside of HD caves is the same hole. specials-look, SD game view,
  `192,-1600,900`, region 330,400,240,140: mean absolute difference 97.7 to 0.1 (HD 52 to 54: the hole's colour); the plateau
  view and AutumnLeaves' LCc0 (HD) show the same shapes. In HD the cave's placeholder geoset (material 0) with its diffuse
  made red showed no red at all: the editor seems not to draw it (not followed up).
  (2) *Geoset colours*: copies of one mushroom (SD and HD): a colour track's key (1, 0, 0) is blue, (0, 0, 1) red; a static
  colour (1, 0, 0) red, a static (0, 0, 1) under a key (0, 1, 0) green: only keys are blue, green, red (renderer.ts;
  modeldraw.test.ts). AzsharaStatue's pedestal (static (0.31, 0.78, 0.86)) is teal, the statue gold by its texture.
  ShimmeringPortal's rim (static (0.47, 0, 0.99)) is violet again: map 16 `-2000,1600,3000`, region 500,0,180,110 mean
  difference (17, -4, -23) to (-7, -4, 2).
  (3) *Geoset tracks without a key in Stand*: not reproduced. ShroomsBlue's own two alpha tracks on copies of its mushroom,
  and tracks with keys only before, after or at the start of Stand (all sequences NonLooping, and Stand looping): the editor
  (SD) shows and hides exactly as Studio (static alpha where Stand has no key, a key at Stand's start held); the real
  ShroomsBlue shows its mushroom in both. Earlier pictures of the cap alone were not SD's.
  (4) *Rising Water* (HD model: one blend layer, alpha 0.5, ORM roughness 33, metallic 0, EnvironmentMap slot): with the
  layer's alpha set to 1 in a copy the editor's water is much more opaque, so the alpha is used; on a dirt map red and green
  match Studio's within 5 and the editor's blue is 31-43 higher, the same at the top and bottom of the view (not a Fresnel
  term): the HD material shading (environment light) Studio's model shader doesn't have, not this model's data.
  The Ruins Fountain (ZOfo) has `defScale:hd=1.45` in DoodadSkins.txt (125 against 80 px at 3000 in (c) above): not tested.
- **Border shade** (branch border-shade-models, 2026-11-13; copies of empty_map_on_newest_world_editor.w3m made with
  app-drive's MCP tools and packed with the CLI: a tree, a hay cart, a footman, claws of attack, a start location and a
  YCl2 three tiles inside (x -2944) and three tiles past the west edge (x -3712), a raised plateau and a lake across the
  edge; a second copy with trees, footmen every 64, a farm and a hay cart across the corner line x -3328; a bare copy for
  the models' masks; `--look x,y,1200,270,70,90` from above, SD and HD, game view on and off). Past the edge the share of
  its brightness a model keeps (the median over its pixels): the SD ground 0.149, the HD ground 0.088; a cliff fades
  across the edge as the ground does, per pixel; a special doodad 0.146 (as the ground); units, items, start locations
  0 (black) in both modes; SD doodads and trees black, HD ones about as the ground (a tree 0.107, a hay cart 0.071).
  Whole models, not per pixel: a footman or SD tree on the corner line is lit, one 64 further out black; an HD tree on
  the line is shaded whole, an HD hay cart 32 inside lit; a farm on the line is lit, its ground texture too. The water
  past the edge is black. Studio: renderer.ts `edgeMode`, lib/model/renderer.ts EdgeShade; app-smoke specialDoodads
  holds it. AutumnLeaves_S2's left edge (`--look -6272,-5248,1200`, game view; pic-compare region 200,0,380,700, past the
  edge): the editor's mean colour (10, 10, 8) SD and (7, 6, 4) HD; Studio's before (59, 55, 34) and (71, 66, 39), after
  (9, 8, 5) and (13, 12, 6), mean absolute differences 42.9 to 6.8 (SD) and 53.7 to 6.7 (HD); inside the playable part
  unchanged (0.1 and 1.7, animation). Studio's HD border ground keeps more than the editor's (0.20 against 0.088; open).
- **Where the border is** (branch border-from-w3i, 2026-11-13; copies of AutumnLeaves_S2, margins 15, made with the CLI,
  one thing changed each; `--look -5760,0,2400`, SD): the w3i's `cameraComplements` alone decide what the editor darkens.
  Left complement 23 moved the dark edge 8 tiles in; the map-edge marks (water word 0x4000) at 23, `playableWidth` 90 or
  the camera bounds 1024 further in alone moved nothing; the editor's save writes the marks from the complements.
  Studio: w3e.ts `playableEdgeTiles`, the renderer's `setPlayable`/`edgeTiles` (the marks only until the w3i is read).
  **Its shape**, from above (`--look x,y,1200,270,70,90`, rotation 0 for north and south; about 1.03 px a unit; a copy of
  the empty map with lakes 400 deep across each edge, written into the unpacked war3map.w3e.txt): SD water fades
  linearly per corner, a corner dark when the tile north-east of it is past the edge, so over the last border tile on
  the west and south and the last playable tile on the east and north (half colour 77/69 px out, 80/70 px in); HD water
  is dark by the pixel, hard (half colour 39-46 px inside on all sides, a tenth 24-29). The ground's shade fades over
  about a cell (0.9 to 0.1 in 26 units) in both modes, its middle in SD 9-37 px inside (unevenly), in HD 35 px inside
  on all sides (Studio 16); HD's dark ground keeps 8 % of the lit ground's brightness (Studio 14 %). Studio: area.ts
  `darkWaterCorners`, renderer.ts `HD_WATER_EDGE`. HillsbradCreek's east and north water (the verify camera, HD), half
  colour from the editor's: 45 and 34 px before, 6 and 9 after; SD 2 and 7.

## Refused values: the terrain viewer and its AI tools

Decision 2026-11-15: a value past what its stored field holds is refused with a message and the map left as it was, never
wrapped, clamped without a word, truncated or overflowed. "Measured, kept": the World Editor does that too and a
we-compare spec or we-drive record relies on it, so Studio does it as well (the user decides those, see the last rows).
Tests: `values.test.ts`, `aitools.test.ts`, `lib/terrain/w3e.test.ts`, `unitprops.test.ts`, `lib/terrain/cameras.test.ts`,
`lib/terrain/regions.test.ts`, Rust `camera_and_region_values_past_their_fields_are_refused` and
`refused_camera_and_region_values_leave_the_files_unchanged`, `map_properties_numbers_past_their_fields_are_refused`,
app-smoke `mcpLimits`; the Map Properties, Map Size and trigger rows: `numbers.test.ts`, `techtree.test.ts`,
`atmosphere.test.ts`, `resize.test.ts`, `literals.test.ts`, `triggerinfo.test.ts`, `wtg.test.ts`.

| Field | Bound | Checked in | Behaviour |
|---|---|---|---|
| w3e corner fields on save | height word -32768..32767, water word 0..0xffff, texture 0..15 (v11) / 63 (v12), variation 0..31, cliff variation 0..7, cliff texture and layer 0..15, whole numbers; tile ids 4 characters | `w3e.ts` `w3eWriteProblem` (writeW3e) | refused: the save fails, nothing cut to its bits |
| water level (14 bits) | 0..0x3fff, whole | `w3e.ts` `setWaterLevel` | refused (was `& 0x3fff`, a wrap); callers pass levels already in range |
| water from brushes and `set_water` | 0..0x3fff | `limits.ts` `waterLimitHits`, `toollimits.ts` | Enforce Water Height Limits on: refused, "Not done: the water at N corners..."; off: cut at the end, the user's choice by the switch |
| ground height from AI tools (`sculpt_terrain`, roughen, `paint_path` flatten, `set_water` ford/lake) | -10240..6143.75 (without cliff level) | `aitools.ts` `refuseGroundPast`, `limits.ts` `groundLimitText` | refused whole: "Not done: the ground at N corners would go past..." |
| ground height from brushes, Reset Height Field Random | the same | `setGroundHeight`, terrain-painter `setRaw` | measured, kept: stops at the end (we-compare height-random-stops); NaN refused |
| cliff level, AI tools | 0..15 | `aitools.ts` `setCliffs`, `setWater` | refused; `set_cliff_level` level/by whole numbers |
| cliff level, Increase brush | 0..15 | terrain-painter `tools.ts` `strokeLayer`, `topRefusal` | refused with a toast: Enforce Terrain Limits on, above 14 (the editor: nothing, silently); off, above 15 (the editor wraps it round: we-compare cliff-slope-wrap, a known difference) |
| Adjust Cliff Levels | whole number; up to cliffShiftRange max | `wholemap.ts` `adjustCliffLevels` | refused: a water word (wet or dry) past its 14 bits (the editor wraps it: cliff-adjust-dry, known differences), a raise past +10 or past level 14 (the editor cuts it); measured, kept: down stops at level 0 |
| ground tiles | 16 slots, a known 4-character tile | `aitools.ts` `groundSlot`, `paint_*` tools | refused |
| ground variation | 0..17 written by Studio (5 bits) | `randomVariation`; text form `w3etext.ts` | only Studio writes it; the text form refuses past 31 |
| map size | 32..480 per side, multiples of 4 | `resize.ts` `resizeProblem`, `coordProblem` | refused, growth past ±32256 too (the editor moves the playable edge instead; map-size-limits asks Studio for the editor's result directly) |
| new map | sizes 32..480 by 32, cliff level 0..14 | `newmap.ts` `mapChoices`, the dialog's lists | refused |
| camera target typed | camera bounds | terrain-cameras `typeValue` | measured, kept: with Enforce Camera Bounds on put on the bound (camera-bounds) |
| camera values typed (all 13 fields of the Cameras tab) | a 32-bit float; an empty field or text is no value; and what the World Editor's Camera Properties would move (`CAMERA_RANGES`: distance 0.5 to 100000, rotation, angle of attack and roll 0 to 360, field of view 5 to 120, Z offset ±4096, near 0 to 9500, far 101 to 100000, far at least 1 above near, DoF Distance 0 to 10000, DoF Scale 0 to 1000, Pos Absolute Z ±4096; recorded in `tests/fixtures/we-specs/camera-region-limits-we.json`, we-drive 2026-11-16 and 2026-11-18) | `cameras.ts` `typedCameraValue` | refused: "Not changed: Distance to the target must be a number from -3.4e38 to 3.4e38" (app-smoke `cameraEditing`) |
| Sound Editor numbers typed | the field's stored type; and what the World Editor's Sound Properties would move (`SOUND_LIMITS`: volume 0 to 127, fade rates 1 to 127 (sounds; music's dialog unmeasured), pitch 0.1 to 2, distances 0 to 100000; recorded in `tests/fixtures/we-specs/sound-limits-we.json`, we-drive 2026-11-18). The editor's dialog has no cone fields: the cone angles keep 0 to 360 | `sound-editor/numbers.ts` | refused with why, the box shows the value kept (app-smoke `soundNumbersRefused`) |
| region edges typed, `add_region` | a 32-bit float; left below right, bottom below top; inside the map (the editor makes no region outside it) | `regions.ts` `typedRegionEdge`, `regionBoxProblem` | refused, the field marked and a toast (app-smoke `atmosphereTools`) |
| new region's number (drawn, `add_region`) | up to 2^32-1 | `regions.ts` `nextRegionIndex` | refused, not wrapped to 0 |
| any f32 field of a codec-backed file on write (w3c, w3r, doo, w3i, …) | the f32 range | format engine `write_prim` | refused: the save or canonicalize fails, nothing written (was stored as infinity); integer fields were already refused past their width |
| object position typed (Selection panel, Edit all x/y), `move_object` | inside the map's corners; a 32-bit float | `values.ts` `placedValueProblem` | refused: "Not changed: x ... is off the map"; `place_objects` skips one off the map with that reason, also with ignoreRoom |
| object nudge and drag | the object's limit | `limits.ts` `scaledNudge`, `moveedit.ts` | measured: a nudge step past it is refused (edge-last-step), a drag stops at the last motion that fits (we-drive, see "edge" above), kept |
| z, facing | finite 32-bit float | `placedValueProblem` | refused; any finite facing is stored as given (a turn more is the same facing) |
| scale | 0 and up, finite | `placedValueProblem` | refused below 0; measured, kept: with Fix Doodads on Load a doodad's scale is held to its type's range, 0 a random size in it (`doodadrules.ts` savedScale) |
| variation of a placed object | 0..numVar-1, whole | `placedValueProblem`, `aitools.ts` `dress` | refused (was clamped in `place_objects` and Edit all) |
| owner | player 1..28 | `placedValueProblem`, `place_objects` | refused (was clamped in Edit all) |
| hit points %, mana, gold, acquisition, hero level, attributes, skills, slots, colour, life, skin, item ids, drop chance, random level/class/table | `unitprops.ts` limits (hp 1..100, mana 1..1000000, gold 0..1000000, acquire above 0..5000, level 1..max, attributes 1..100000, colour 0..23, life 0..100, chance 0..100 each) | `unitprops.ts` `checkChange` | refused, "Nothing was changed: ..."; a drop set's total past 100 is let through on purpose (shown red) |
| item table, waygate region, random group and position numbers | 0..2^31-1, whole | `unitprops.ts` `storedIndex` | refused, also when the map's lists can't be read |
| `place_objects` unit choices | acquireRange above 0..5000, gold 0..1000000, drop level 0..8 | `aitools.ts` `setUnitChoices` | refused |
| tool settings | `edge` 0..1, `width` above 0, `density` 0.05..1, `limit` 1 up, `jitter` 0 up, `count` 1..30 | `values.ts` `givenNumber` | refused (were held to the nearest end or replaced by the default) |
| Reset Height Field Random | variation 0..20, smoothing 0..8, whole | `wholemap.ts` `randomizeHeightField` | refused |
| Map Properties number fields (loading screen, crest race, game data set/version, camera zoom, fog, terrain fog, water rendering, colour alphas, a player's start x/y) | the field's type in `w3i.json` (i32, u32, u8, f32) | map-info `numbers.ts` `setInfoNumber` (`numbers.test.ts` holds the types against `w3i.json`) | refused with a toast, the box shows the value kept, no undo step (the alphas were clamped to 0..255; app-smoke `typedFieldSave`) |
| upgrade level, random group / item table chance (Map Properties) | level 1..2^32 (stored from 0 in a u32), chance 0..100 | map-info `techtree.ts` `techNumber` | refused, the field marked |
| `set_sky` fogStart, fogEnd, fogDensity, overSky | f32, i32 | `atmosphere.ts` `applySky` | refused with why, no edit (app-smoke `atmosphereTools`) |
| Map Size sides and borders typed | whole numbers, borders 0 up | `resize.ts` `sidesProblem` | refused, the problem shown and Apply off (were rounded and clamped to 0; app-smoke `resizeUndo`) |
| trigger parameter Value (integer, real) | an integer -2^31..2^31-1 in decimal or 0x hex; a real in the f32 range without an exponent (the script takes the text as it is) | `lib/triggers/literals.ts` `literalProblem` | refused in the dialog with why |
| variable initial value (Variables table, `add_trigger_variable`), array size from `add_trigger_variable` | as above (a real is kept with 2 decimals, never with an exponent); size 1..32768 | `literals.ts` `typedInitialValue`, `triggerinfo.ts` `variableArgs` | refused with a toast / error, no edit (app-smoke `typedFieldSave`) |
| any u32/i32 of war3map.wtg written by the app | its width | `wtg.ts` Writer | refused, nothing written (was `>>> 0`, a wrap) |

## Process

**Every change.** Run the gate. Fixing a bug starts with a test that fails because of it.

**New format or parser.** Add it to the mini map, add damage rounds if it reads bytes, and run the
corpus tier. A change in `tests/corpus-baseline.tsv` has to be intended: `--update-baseline`
is for new codecs and maps, never for making a failure go away.

**Change to the script generator.** The corpus tier compares it with the World Editor. Counts in
`tests/script-baseline.json` may rise, never fall; when they rise, keep it with
`node app/scripts/script-check/run.mjs --update-baseline`.

**Before merging to master.** `node tests/gate.mjs all`.

**Before a release.** The whole gate, then the checklist. Only the game can answer these:

- [ ] Open a map saved by the app in the real World Editor; save it there; it stays intact.
- [ ] Test Map from the app: it loads, triggers run.
- [ ] A new map made in the app opens in both.
- [ ] Note anything newly proven or still unproven in `openpoints/test.md`.

**GUI rounds in the running app** are for what only eyes can judge. They use scratch copies and a
backed-up `settings.json`, and they don't take over the screen while someone works at the PC.
`ui-smoke` and `app-smoke` show no window and use their own settings, so they're always allowed.

## Coverage: what the numbers mean

Measured on 2026-11-06. TypeScript counts every source file, so a file no test imports is 0%.

| Area | Lines covered |
|---|---|
| Rust, all (no game needed) | 67% (47% before the system tests) |
| `mpq` / `w3proj` / `cli` | 89% / 81% / 56% |
| `casc` (reads the game's storage) | 23% |
| Tauri backend (`app/src-tauri`) | 33% |
| `lib/image`, `lib/lua`, `lib/formats`, `lib/triggers`, `lib/terrain` | 65–90% |
| `lib/script` (writes `war3map.j`) | 87% (2% before its tests) |
| `lib/jass` | 79% |
| `lib/ai`, `lib/objects` | 95%, 89% (0% before their tests) |
| `workbench`, most of `builtin/` | 0–10% |

Unit coverage counts only unit tests: the UI smoke and the corpus run far more code than this
shows. The low numbers in the last rows are the useful part of this table.

**How to use it:** look for what's at zero and ask whether that's a risk. `tests/coverage-floor.json`
holds floors for the logic layers, so tested code doesn't quietly stop being tested. Raise a floor
when an area gets better (`--update-floor`). There's no global target, because that rewards tests
of whatever is easiest.

**Why not more:** coverage says a line ran, not that anything checked the result. A trial of
mutation testing (changing the code and seeing whether a test notices) found `mpq/crypto.rs` at
99% line coverage with 20 of its 85 mutants surviving. Replacing `decrypt_bytes` with nothing
passed every test, so reading encrypted files had no real test at all. Over the four files tried,
84% of mutants were detected before that fix.

Mutation testing is too slow for each commit, so run it now and then on small critical files:

```sh
cargo mutants -f crates/mpq/src/crypto.rs -p mpq
```

## Rules for writing tests

Each of these comes from a test on this project that looked fine and wasn't.

- **Prove the test can fail.** Break the code once and see it go red. The UI smoke was checked
  with a sabotaged extension, the generator's tests by putting each bug they found back.
- **Feed the check what the app gets.** `script-check` read raw terrain and custom text, but projects
  keep those as text files, so it quietly compared without them. It reported missing triggers
  and 7 false alarms that weren't there.
- **Let the oracle overrule you.** A rule that looks right goes through the comparison first: one
  of today's added 147 differences and was taken out again.
- **The check has to run the app's code.** `script-check` used to keep its own copy of how orders
  are looked up, so it could only ever prove the copy. Share the code instead (`lib/script/objects.ts`).
- **Give "it was rejected" a control.** The first `wtg_hostile` test passed at once, because its
  hand-built file was invalid and never reached the recursion. A sane depth must parse, or
  an error at the hostile depth means nothing. With the control, it crashed the process.
- **Count what happened.** The damage tests fail if everything is accepted or everything is
  rejected: that would mean the damage reached nothing.
- **Don't change the code under a running check.** A corpus run started next to a sabotage bundled the
  sabotaged file and reported 67 failures, under a `tail` that said exit 0.
- **Same input every run.** Random tests use a fixed seed and print it.
- **Go through the front door.** `app-smoke` first packed with the backend call directly and passed;
  the Build command it stood in for left out what had just been saved.
- **Test the result, not the call.** A round trip or known answer, not "it didn't throw".
- **Fixtures are made up.** Nothing from the game or other people's maps goes into the repository;
  `tests/fixtures` is handwritten and stays byte-exact through `.gitattributes`.
  `lib/jass/mini-game.fixture.ts` is a small handwritten stand-in for the game's script API.
- **Real maps are read-only.** Work on copies in a scratch folder.
- **A flaky test is a bug.** Fix it or remove it; don't rerun until green.
- **Wait for the condition, not the clock.** A fixed pause after an action is too long on an idle machine and too short
  under load. In app-smoke wait with `until(…)` on what the action brings about, or with `settled(page)`
  (`w3Workbench.settled()`: saves and writes ended, debounced work done, terrain views drawn; workbench.ts says what
  it covers). A pause stays only where time itself is tested (something must *not* happen, edge scrolling), with a
  comment saying so.

## What's still unproven

In order of what I'd do next.

1. **Editing by hand in the other editors.** `app-smoke` opens a project and every editor, makes new
   maps, places objects, saves, builds and unpacks. The New Map dialog, painting terrain, changing a
   unit's field and renaming a trigger go by mouse and keyboard, sent over DevTools into the hidden
   window (on Linux over WebDriver, in Xvfb: `app/scripts/webdriver.mjs`). Building a trigger's events and actions, and placing with the mouse, are still GUI rounds.
2. **Hostile input on the TypeScript side.** Covered by `lib/hostile.test.ts` (terrain, AI, model and image
   parsers; hidden app PASS 2026-11-11, see `openpoints/test.md`). Unproven: textures in other people's maps
   (the limits were checked on the game's own 1,658).
3. **`war3map.wtg` in the mini map.** Done: `tests/fixtures/TriggerData.txt` is a small made-up TriggerData
   (the app smoke test reads it through `W3PROJ_TRIGGERDATA`, debug builds only), so the mini map's wtg goes through the JSON codec.
   What stays unproven is the codec on triggers the made-up table doesn't name.
4. **The game itself.** Nothing automatic proves that a map loads in the game: the release checklist
   is all there is. Saved-by-World-Editor samples of each file version would at least pin the
   formats, and could settle the unknown fields listed in `openpoints/test.md`.
5. **The generated script isn't identical yet.** Of the 326 JASS maps, 219 match the World Editor's
   file exactly (`script-check`, 2026-11-17; the 41 of 49 Lua maps too, the 375 trigger files byte-exact); the other 107 differ
   in some section, mostly by a few lines. `openpoints/bugs.md` lists what's left.
