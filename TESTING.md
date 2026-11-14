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
| make a project's pathing, shadows, minimap and script as the app does, without it | `w3proj rebuild <project> [--only=wpm,shd,minimap,script] [--force]`: the app's own code in Node (`app/src/headless`); app-smoke's `rebuildCli` holds its bytes against the app's |
| look up a game table's rows | `w3proj game slk Units/UnitData.slk hfoo hbot --col unitID,movetp` (tab-separated, header first) |
| see how the open points burn down | `node scripts/openpoints-burndown.mjs` (repo root): reads `openpoints/*.md` (an open point is a `- [ ] ` line plus its indented lines; leading `[tag]`s such as `[game]`, `[windows]`, `[we]`, `[eye]`, `[extra]` become `tags`), writes `openpoints/openpoints.json` (every point with file, section, tags, text, a stable id), adds an entry to `openpoints/burndown.json` (per file, plus three lines: to build / to prove by agents / waiting for the user, primary vs `[extra]`, and per snapshot how many ids opened, closed or were edited) and `openpoints/burndown-ids.json` (the ids: first snapshot, then the deltas; a vanished id with a new one of at least 80% similar text is an edit), and writes `openpoints/burndown.html` (chart, tiles, per-day table; data inside, opens from disk). `--dry-run` prints the counts, `--no-entry` refreshes without an entry. The open points stay local; only the script is in git |
| apply testers' verdicts to the open points | `node scripts/openpoints-close.mjs <verdicts-file> [--dry-run]` (repo root): lines `<id>: PASS \| FAIL \| DIFFERS \| NOT DONE — <text>`. PASS removes the item block; FAIL/DIFFERS add a one-line item to `bugs.md` "From verification" pointing at the old one; NOT DONE adds `(not done: reason, date)`, the second moves the item to `user.md` (game/Windows/user) or `onhold.md`. Unknown ids refuse the whole run; changed files are copied to `openpoints/.backup/<timestamp>/` first. Tested in `app/scripts/openpoints.test.mjs` |
| see how well the app's pathing (war3map.wpm) matches the maps' own | `node scripts/wpm-compare.mjs [maps or folders] [--map NAME] [--cells N] [--save F] [--baseline F]` (in `app/`): regenerates each map's wpm with `buildPathingMap` (what a save runs) and diffs it with the stored file: exact or differing cells per map and a total. Default `smoketest_maps`; give the downloaded ladder folders for the large set. `--cells N` lists differing cells (x,y, tile, stored->regenerated), `--save` writes the result, `--baseline` reports maps that got better or worse (exit 1 if worse). Unpacked maps are cached in the temp folder |
| look at the real World Editor (Linux, **local only**) | `node scripts/we-drive.mjs <steps>` (in `app/`): `--map`, `--wait-ready`, `--compare-ready`, `--compare-ready-unlit`, `--look x,y[,distance…]\|center`, `--shot`, `--shot-window`, `--shot-screen`, `--key KEY[@MS]` (@MS holds it), `--click X,Y`, `--double-click X,Y`, `--drag X,Y:X,Y[@MS]` (with `--drag-mod alt|shift|ctrl` before it), `--wheel N[@X,Y]`, `--windows`, `--view-menu`, `--view Lighting=off`, `--game-view on\|off\|status`, `--fps ms`, `--open FILE` (opens a map in the running editor: Ctrl+O, the copy's row in the editor's Open list; `--map` on a running editor does this, restarting if it fails; "via" in the step's line says which), `--save FILE` (Ctrl+S, the default-name reminder answered, the saved map copied to FILE), `--export-minimap FILE` (File > Export Minimap with the dialog's defaults, the TGA copied to FILE), `--type TEXT` (into the open dialog), `--close`; options `--screen WxH` (another view size), `--mode sd\|hd\|de`, `--day-night fixed\|cycle` (fixed by default). The list is at the top of the file; setting up and the proof that nothing of the user's changed: `scripts/we-setup.mjs` |

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
  pointer. The nudge is Edit > Nudge Selection: the number pad (`--key Num_Lock` once, then `--key KP_6`; without Num
  Lock the keys arrive as arrows and do nothing), 64 a step for a tree, 8 for a doodad without pathing and a footman.
  Measured again in nudge-turn-we (target/evidence/nudge-turn-we): the nudge is 64 for a tree (LTlt) and a farm (hhou), 8
  for a doodad without pathing (LPcr) and a footman; the diagonals KP_7 9 1 3 move both axes the whole step (a tree:
  -64/+64, +64/+64, -64/-64, +64/-64); KP_Divide turns a selection 5 degrees left, KP_Multiply 5 right. Studio:
  selectionkeys.ts (NUDGE 8, TURN 5), doodadedit.ts GRID_NUDGE_STEPS.
  The editor takes the drag's second-to-last motion step (a footman dragged 576 in 20 steps moved 547). Found: with
  Enforce Camera Bounds on (and off alike) drags and nudges go past the camera bounds; a unit stops with its collision
  size or half its footprint inside the playable part (footman, collision 31: 3296; farm, 4x4 cells: 3264); a doodad
  goes past the playable part and stops with its centre strictly inside the map (tree and a 12x12 LZth 4032 on 64
  steps, a pathless LPcr 4088 on 8 steps). The camera too scrolls past the camera bounds with the switch on. Studio:
  limits.ts `insetBy`, terrain-viewer `moveBounds`; app-smoke heightsLimits.
- **Projection for clicks**: with `--look X,Y,D` (angle 304, fov 70, rotation 90) a ground point maps to the display
  through TESTING's Studio-equivalent camera (target y - 0.0993 D, distance 0.9127 D, pitch 57.2, vertical fov 41.06,
  the view at 156,79): the status bar read (3713.9, 515.4) where (3712, 512) was aimed (`proj.py` in that folder).

**Local only: it needs the installed game, Proton, Xvfb, bubblewrap, a C compiler, python3 with python-xlib and Pillow,
and Mesa's lavapipe; it is not part of CI or the gate.** Without one of them it prints `{"skipped": why}` and exits 0.
It never starts the game itself.

- **Nothing of the user's is touched.** `we-setup.mjs` keeps one farm for all worktrees in `target/we` of the main
  checkout (`W3PROJ_WE_DIR` moves it): `install/` holds hardlinks of the install, except what the editor writes (the
  CASC `.idx` files, `shmem`, `ecache`: about 10 MB of copies), and `prefix/` is a Wine prefix of its own (about
  0.35 GB). The farm is made again only for another game build (`.build.info`), `--clean` removes it all. The editor
  runs in bubblewrap with the user's whole Steam prefix and every hardlink mounted read-only; the editor opens the
  CASC data files for writing, so `we-rofs.c` (preloaded) turns those opens into read-only ones. One World Editor runs
  at a time, machine-wide: the lock is `$XDG_RUNTIME_DIR/w3proj-we.lock` (else the temp dir, with the user name), shared by
  every worktree and every `W3PROJ_WE_DIR`; a second run says once who holds it and since when, and waits
  (`takeLock`'s timeout; a dead pid is taken over). `we-setup.mjs --snapshot` and `--compare` show the
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
- **Preferences** (`Documents/Warcraft III/WorldEditPreferences.txt` in the farm's prefix, written before each start,
  the rest kept): `Has Been Run=true`, no interface or splash sounds, `Fixed Day Night Cycle` from `--day-night`, and
  the graphics: `--mode sd|hd|de` sets `assetMode` to 0, 1 or 2 (File > Preferences > General > Asset Mode offers
  SD, HD, DE; DE is the 3.0 art) and `hd` and the Reforged switches (`Buildings`, `Environment`, `EnvOld`, `Heroes`,
  `Icons`, `Textures`, `Units`, `Vfx`) to 0 for sd, else 1. Told apart (2026-11-13) by pictures of one map in all
  three modes: `assetMode` alone decides (assetMode 2 with every other switch 0 draws DE, assetMode 0 with them all
  1 draws SD); the registry and the install showed no mode value in a before/after diff. SD has round trees, HD flat grass with
  pointed trees, DE feathered pines and a detailed terrain. Switching in the dialog crashes the hidden editor
  (it re-opens its archive over the network), so write the key instead. The install's text locale goes into the prefix's registry (else the editor shows
  `WESTRING_…` names). The first start of a new prefix shows the editor's welcome, which asks to accept Blizzard's
  terms. The user accepted them in their own install (which the farm is made from) and agreed on 2026-11-08 that
  we-drive presses Continue in its own prefix; `W3PROJ_WE_ACCEPT_TERMS=0` makes it report the dialog instead. The
  shared prefix keeps the answer, so this comes up once per new prefix.
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
  start on flat buildable ground). Branch melee-flag-set (2026-11-13): copies with the flag cleared of cliff.w3m,
  (2)BanditRidge, (8)Friends, (4)RustyCreek_S2_v1.3 and (4)FrozenClover (a creep 12 from a start) got it back from the
  editor's save, as from Studio's; (6)Zandalar got it back too, where Studio leaves it off (doodads 39 from the starts).
  Studio puts it back on 153 of the game's 185 FrozenThrone melee maps with the flag cleared. A player's flag bit 1 is SetPlayerRaceSelectable (map-info/priorities.ts RACE_SELECTABLE).
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

`W3_APP_BIN` (or `--app`) makes `appctl.mjs`, app-drive, app-smoke and we-compare run that binary and build nothing.
Settings (`W3PROJ_CONFIG_DIR`, default `<work>/config`) and the webview's storage (`XDG_DATA_HOME`/`XDG_CACHE_HOME`
under the work folder, Linux) are per run, so testers sharing a binary share nothing. The identifier of the build is
the same for all (`W3_SMOKE_ID` only names the build). Proven with two `app-drive` and two `app-smoke --only=byHand` runs
at once on one binary. Costs (this machine, sccache warm): archive 0 s, `npm ci` 3 s, app build 142 s, CLI about 10 s more.

**we-compare** (`node scripts/we-compare.mjs [--app P] [--work D] [--json F] [--no-we] <spec.json…>`, local only like
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
(not a failure). Exit 0 as expected, 1 not, 2 something couldn't run; the JSON report is `<work>/report.json`. Unit
tests: `we-compare.test.mjs`. It isn't in the gate (the gate has no World Editor step); run it by hand with a
`W3PROJ_WE_DIR` of its own and `we-setup.mjs --clean` afterwards.

Saved-file specs of package D (branch we-specs-d, 2026-11-14; `ramp-wpm`, `boundary-wpm`, `doodad-snap-custom`, `map-size-38x42`, `paint-variation`; inputs and generators `make-doodad-snap.mjs`, `make-odd-size.mjs` in `tests/fixtures/we-specs/`): compare kind `w3e-variation` (per texture the corner count and the ground variations that 5% of its corners wear: the draw is random). The editor's palette: Blight 1552,111, Boundary 1552,143, Remove Boundary 1552,175, Ramp 1505,311. Known differences recorded as `expect: differs`: its Ramp flags stand one corner column left of Studio's on the same click; its Blight brush also turns corners round it to the map's second ground tile (`boundary-flags-wpm`'s w3e). Boundary matches since branch boundary-we (2026-11-14): its brush is centred on the lower-left corner of the tile under the pointer, not the nearest corner (16 size-1 clicks at 0.2 to 0.8 of a tile, sizes 2, 3, 5: 5, 13, 49 corners round that corner), and its wpm makes a tile whose lower-left corner is painted 0xce, the border's byte, over a cliff or water alike, 0xee when blighted; Remove Boundary frees it. A palette tile (Boundary, Blight) picked after a water brush leaves the water brush on: the next click paints water too, so a spec picks the water last.

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
Dragged cliff strokes (branch drag-stroke-we, 2026-11-14, spec `drag-stroke`): the editor stamps its brush only where the
pointer is at its own ticks, nothing in between (a 20 ms `--drag` of size 1 raised one corner, of size 3 one brush, not at
the press point), so a quick drag has gaps and two runs of it differ; at 3 s for 20 steps it sees every step and matches
Studio's stroke (stamped along the way, `strokepath.ts`). The layer is the start's + 1 for the whole stroke, as Studio's.

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
3. **`war3map.wtg` in the mini map.** It stays raw without the game's TriggerData, so its codec is
   at 37%. A small made-up TriggerData fixes that.
4. **The game itself.** Nothing automatic proves that a map loads in the game: the release checklist
   is all there is. Saved-by-World-Editor samples of each file version would at least pin the
   formats, and could settle the unknown fields listed in `openpoints/test.md`.
5. **The generated script isn't identical yet.** Of the 326 JASS maps, 196 match the World Editor's
   file exactly, 99 have the same lines in another order, and 31 really differ, mostly by a few
   lines. `openpoints/test.md` lists what's left.
