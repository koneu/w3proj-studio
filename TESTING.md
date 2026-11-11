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
then runs the project checks and the first half of the full run's checks (`firstHalf`, newMaps to viewModes);
`--part=2/2 --no-build` starts once that build is done (part 1's `Built application at`) and runs the second half
(`secondHalf`, unitProperties to contextLoss) on the same build. Each part has its own folder
(`target/app-smoke-part<n>`, or `W3_SMOKE_DIR` with `-part<n>`), its settings in it (the app reads
`W3PROJ_CONFIG_DIR`, since both have the build's identifier; app-smoke stops when the app doesn't say it listened),
and its own Xvfb display and WebDriver ports (Linux; a driver that loses the race for a display starts again) or
DevTools port and WebView2 folder (Windows). The halves keep the full run's order, so a check that relies on what an
earlier one left stays behind it (testMapWithoutGame on the map objectsWhileOpening left open); every check of the
second half also runs alone (`--only`). They are balanced by the times each check prints (`took X s: <check>`):
about 6 minutes each once built (the batch tier went from about 15 minutes to 8 on an idle machine). To run one half by hand: `node scripts/app-smoke.mjs --part=1/2` (in `app/`), or
`--part=2/2` (it builds unless `--no-build`: not while part 1 builds). A plain `node scripts/app-smoke.mjs` still
runs everything in one app.

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
| look up a game table's rows | `w3proj game slk Units/UnitData.slk hfoo hbot --col unitID,movetp` (tab-separated, header first) |
| see how the open points burn down | `node scripts/openpoints-burndown.mjs` (repo root): reads `openpoints/*.md` (an open point is a `- [ ] ` line plus its indented lines), writes `openpoints/openpoints.json` (every point with file, section, text, a stable id), adds an entry to `openpoints/burndown.json` and writes `openpoints/burndown.html` (the chart, data inside, opens from disk). `--dry-run` prints the counts, `--no-entry` refreshes without an entry. The open points stay local; only the script is in git |
| look at the real World Editor (Linux, **local only**) | `node scripts/we-drive.mjs <steps>` (in `app/`): `--map`, `--wait-ready`, `--compare-ready`, `--compare-ready-unlit`, `--look x,y[,distance…]\|center`, `--shot`, `--shot-window`, `--shot-screen`, `--key`, `--click X,Y`, `--wheel N`, `--windows`, `--view-menu`, `--view Lighting=off`, `--game-view on\|off\|status`, `--fps ms`, `--save FILE` (Ctrl+S, the default-name reminder answered, the saved map copied to FILE), `--close`; options `--mode sd\|hd`, `--day-night fixed\|cycle` (fixed by default). The list is at the top of the file; setting up and the proof that nothing of the user's changed: `scripts/we-setup.mjs` |

The game folder: `W3PROJ_GAME`, else `.game-path` in the checkout (written by `scripts/setup-linux.sh`; its first
line is a comment, the path is the first line that isn't), else the folder above the checkout (the Windows layout).
The CLI reads `W3PROJ_GAME` too. The smoke app's identifier is one per checkout (`W3_SMOKE_ID` overrides it), so
runs in two worktrees don't share settings; none of these tools starts the game or the World Editor, except
`we-drive.mjs`, which starts the World Editor only.

### The real World Editor: we-drive.mjs

**Local only: it needs the installed game, Proton, Xvfb, bubblewrap, a C compiler, python3 with python-xlib and Pillow,
and Mesa's lavapipe; it is not part of CI or the gate.** Without one of them it prints `{"skipped": why}` and exits 0.
It never starts the game itself.

- **Nothing of the user's is touched.** `we-setup.mjs` keeps one farm for all worktrees in `target/we` of the main
  checkout (`W3PROJ_WE_DIR` moves it): `install/` holds hardlinks of the install, except what the editor writes (the
  CASC `.idx` files, `shmem`, `ecache`: about 10 MB of copies), and `prefix/` is a Wine prefix of its own (about
  0.35 GB). The farm is made again only for another game build (`.build.info`), `--clean` removes it all. The editor
  runs in bubblewrap with the user's whole Steam prefix and every hardlink mounted read-only; the editor opens the
  CASC data files for writing, so `we-rofs.c` (preloaded) turns those opens into read-only ones. One World Editor runs
  at a time (`target/we/lock`; a second run waits and says so). `we-setup.mjs --snapshot` and `--compare` show the
  install and the user's `Documents/Warcraft III` unchanged; the user's own Battle.net app writes elsewhere in that
  prefix while it runs (and touches the install's `shmem` files when it checks the game), which `--compare` lists.
- **Nothing on the screen, no sound.** A display of its own (Xvfb, 1600x1000), Vulkan through lavapipe. Wine's audio
  drivers are off, PulseAudio and PipeWire are pointed at nothing and their sockets and `/dev/snd` are hidden, and
  the editor's interface sounds are off in its preferences: nothing of it shows in `pactl list sink-inputs`.
- **Preferences** (`Documents/Warcraft III/WorldEditPreferences.txt` in the farm's prefix, written before each start,
  the rest kept): `Has Been Run=true`, no interface or splash sounds, `Fixed Day Night Cycle` from `--day-night`, and
  the graphics: `--mode sd` sets `assetMode`, `hd` and the Reforged switches (`Buildings`, `Environment`, `EnvOld`,
  `Heroes`, `Icons`, `Textures`, `Units`, `Vfx`) to 0, `--mode hd` (the default) to 1; told apart by pictures of
  footmen, a barracks and trees close up (classic red-roofed barracks and round trees in SD, the white stone barracks
  and new trees in HD). The install's text locale goes into the prefix's registry (else the editor shows
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
- **Saving** (`--save FILE`, branch save-parity, 2026-11-09): variants of a map made with the release CLI (unpack, JSON,
  pack), saved by the editor and unpacked again, show what its save works out by itself. Found so: the ally priorities
  (lib/terrain/startlocations.ts `editorAllyPriorities`), hit points and mana of 0 saved as -1 (lib/terrain/owner.ts
  `savedUnitValues`), and that it never upgrades a subversion-9 unit file (unitprops.ts `ownSetsOnly`). Start locations
  too close to cliffs bring up "This map is no longer considered a melee map … invalid positions", which `--save`
  reports; the flat `empty_map_on_newest_world_editor.w3m` doesn't. The save also turns the Melee flag back on for a map
  that meets its rules (a copy with the flag off got it). Those rules (branch props-ui-fixes: copies of (4)PhantomGrove
  with the flag cleared and one change each) are in lib/terrain/owner.ts `meleeBlockers`; Studio's save takes the flag
  off by them but never puts it back, since two of the editor's reasons (custom triggers, start locations in invalid
  positions) it can't tell. A player's flag bit 1 is SetPlayerRaceSelectable (map-info/priorities.ts RACE_SELECTABLE).
- **Dialogs that don't draw**: Scenario > Player Properties opened (window "Scenario Properties") but stayed a blank
  white rectangle in the hidden display, also after moving the pointer over it and clicking; `--close` then can't
  answer it.
- **Unit Properties**: `--key u` (units layer), `--click` on the unit, `--key Return` opens the dialog (two clicks are too
  slow for a double click). Its tab strip moves two tabs per click or arrow key in this display: `--click` on General,
  `--key Right`, `--key Left` lands on Abilities. The Skin button on General opens "Choose Skin", which does draw (a list
  of the kind's types, filter All/Standard/Custom and a search box); a random unit's second tab is Random Unit (Random
  Unit Type: Any Neutral Hostile Unit, From Random Group, Use Custom Table with New/Delete/Edit Unit). Found so on copies
  of cliff.w3m (branch unit-props-2, 2026-11-10): the editor draws a placed unit's skin and its Custom Color only where
  the type allows a custom team colour (`utcc`, not "is a waygate"), and its script switches a custom ability on by
  its base's order.
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

## What's still unproven

In order of what I'd do next.

1. **Editing by hand in the other editors.** `app-smoke` opens a project and every editor, makes new
   maps, places objects, saves, builds and unpacks. The New Map dialog, painting terrain, changing a
   unit's field and renaming a trigger go by mouse and keyboard, sent over DevTools into the hidden
   window (on Linux over WebDriver, in Xvfb: `app/scripts/webdriver.mjs`). Building a trigger's events and actions, and placing with the mouse, are still GUI rounds.
2. **Hostile input on the TypeScript side.** `mdx.ts`, the image decoders and the JASS parser
   read map files too. They can't corrupt memory, but they can freeze the app.
3. **`war3map.wtg` in the mini map.** It stays raw without the game's TriggerData, so its codec is
   at 37%. A small made-up TriggerData fixes that.
4. **The game itself.** Nothing automatic proves that a map loads in the game: the release checklist
   is all there is. Saved-by-World-Editor samples of each file version would at least pin the
   formats, and could settle the unknown fields listed in `openpoints/test.md`.
5. **The generated script isn't identical yet.** Of the 326 JASS maps, 196 match the World Editor's
   file exactly, 99 have the same lines in another order, and 31 really differ, mostly by a few
   lines. `openpoints/test.md` lists what's left.
