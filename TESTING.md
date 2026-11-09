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
| Static | compilers, clippy, module boundaries | `npm run check`, clippy | every commit, CI |
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
node tests/gate.mjs corpus     # real maps and the game: about 6 minutes
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
failed fails without running. Each step's output goes to `target/gate-logs/<tier>-<pid>/<step>.log`; the
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

**`w3proj verify` over a folder** checks maps on all cores (`W3PROJ_VERIFY_JOBS=1` for one at a
time), but prints in the order of the files. **A hostile-input failure** names its seed; run it
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
| show a test fails without the fix | `node scripts/fails-without.mjs <test> <changed source files…>` (in `app/`): passes as is, fails with those files as on `dev` (`--base`), files put back. Exit 3 means the old code merely didn't build: weak evidence. Rust: `--run "cargo test -p <crate> <name>"` |
| look at the app, ask it something | `node scripts/app-drive.mjs <steps>` (in `app/`): the hidden smoke app (Xvfb on Linux), `--map`/`--project` (a copy), `--terrain`, `--camera game`, `--camera we[:x,y,…]` (the World Editor's view), `--view-size 1184x844`, `--compare-ready lit\|unlit`, `--look x,y`, `--shot file.png`, `--mcp tool={…}`, `--command id`, `--eval "…"` (an expression, statements, or statements that `return`), `--frame-cost ms` (CPU time per terrain frame: all, poses, particles). Steps run in order; the list is at the top of the file |
| compare two pictures | `node scripts/pic-compare.mjs a.png b.png` (in `app/`): mean colour per region in both, their difference, the mean absolute difference of the pixels; `--region [name=]x,y,w,h`, `--sample` (whole and a 3x3 grid), `--diff d.png`, `--tolerance T` (exit 1 when a region's difference is above it, 2 when the pictures can't be compared). Plain JavaScript, no Pillow |
| run the real-app smoke test, or one check of it | `node scripts/app-smoke.mjs [--only=<check>]` (in `app/`): builds what it needs, the release CLI too |
| read the game's files | `w3proj game cat Units/UnitData.slk`, `game ls <filter>`, `game resolve <path>` |
| look up a game table's rows | `w3proj game slk Units/UnitData.slk hfoo hbot --col unitID,movetp` (tab-separated, header first) |
| look at the real World Editor (Linux, **local only**) | `node scripts/we-drive.mjs <steps>` (in `app/`): `--map`, `--wait-ready`, `--compare-ready`, `--compare-ready-unlit`, `--look x,y[,distance…]\|center`, `--shot`, `--shot-window`, `--shot-screen`, `--key`, `--click X,Y`, `--wheel N`, `--windows`, `--view-menu`, `--view Lighting=off`, `--game-view on\|off\|status`, `--fps ms`, `--close`; options `--mode sd\|hd`, `--day-night fixed\|cycle` (fixed by default). The list is at the top of the file; setting up and the proof that nothing of the user's changed: `scripts/we-setup.mjs` |

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
- **Loading**: big maps (4v4 Mount Hyjal) show a window titled "Progress" ("Loading Units n/300") for several
  seconds; `--wait-ready` waits for it (up to `--timeout`) instead of reporting it as a question.
- **The View menu** (`--view-menu`): Foliage, Doodads, Units, Water, Blight, Shadows, Lighting (L), Weather and
  Info Display are checked by default; Sky, Fog Effects, Light Ranges, Bloom, Ambient Occlusion, Grid, Camera Bounds,
  pathing, Regions and Camera Objects aren't. With game view on, these items are greyed and read as unchecked.
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
node scripts/we-drive.mjs --map M --compare-ready --look center --shot we.png --close        # lit
node scripts/app-drive.mjs --map M --terrain --view-size 1184x844 --camera we --compare-ready lit --shot st.png
node scripts/pic-compare.mjs we.png st.png --sample --diff d.png
```

| World Editor (we-drive) | Studio (app-drive) |
|---|---|
| `--compare-ready`: game view on, the day fixed (06:00) | `--compare-ready lit`: `terrain.lighting.enabled` on, `terrain.lighting.hour` 6 |
| `--compare-ready-unlit`: game view off, View > Lighting off | `--compare-ready unlit`: `terrain.lighting.enabled` off (Studio's even light) |
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

**Fire and particle colours in HD** (branch render-fixes-4, 2026-11-09, a test map with AObr, ZObz, LObr, OOgr, ZZdt,
AOob and AOnt in a row, the editor in SD and HD): the particle colours are read right (red, green, blue): the
editor's classic view shows the same yellow-green fire on ZObz and the same faint green-yellow haze over the grate
OOgr as Studio's stand-ins. The HD editor draws the Reforged PopcornFX effects instead (orange glows), which Studio
can't; its stand-ins are the classic emitters, additive, so orange over the bright HD grass turns lime and blue
turns cyan. Particles don't go through the HD tone curve. What was wrong and is fixed: HD emissive textures (layer
slot 3: AOob's red runes were black, AOnt's lamp unlit), Reforged models whose classic emitters are empty
placeholders (LObr: no fire at all), the HD City cliffs' placeholder textures (`ReplaceableTextures\Cliff\Cliff1_…`,
drawn white on OrcX02_03) and Cityscape's HD water colour (blue).

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
