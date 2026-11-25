# Testing

How this project is tested, why, and what to do before committing or releasing.

## Short answers

| Question | Answer |
|---|---|
| Unit tests? | **Yes, for pure logic:** parsers, terrain math, script generation. Not for DOM-heavy editors, where they cost a lot and prove little. |
| System tests? | **Yes, and they matter most.** The product's promise is end to end: a map goes through the app and comes back correct. |
| Measure coverage? | **Yes, as a map of what nothing has ever run.** Floors guard the logic layers. There is no global target, and a high number proves little (see below). |
| Anything else? | **Hostile-input tests** (maps come from strangers), **real maps as test data**, and now and then **mutation testing** on the critical files. |

### How do I run all the tests?

| I want | Run |
|---|---|
| everything automatic, before a commit | `node tests/gate.mjs`: types, TypeScript unit tests, Rust tests, clippy, headless UI smoke (what GitHub CI runs too) |
| everything including real maps and the game, before a merge or release | `node tests/gate.mjs batch` (commit + corpus: release CLI, the real app's smoke test in two parts, corpus round trip and codec baseline, hostile input, codecs agreeing, TypeScript tests with nothing skipped, generated scripts against the World Editor's). `node tests/gate.mjs all` adds the coverage floors (needs `cargo-llvm-cov` and the llvm-tools component) |
| one piece | `cd app && npm test -- <file>`, `npm run check`, `node scripts/app-smoke.mjs --only=<check>`; `cargo test --workspace`; `cargo clippy --workspace --all-targets -- -D warnings` |
| the real World Editor (Linux, local, not in the gate) | `node app/scripts/we-compare.mjs <spec.json…>`, see "The real World Editor" below |

Gate options: `--serial`, `--jobs=<n>`, `--update-floor`. Logs are in `target/gate-logs/<tier>-<pid>/`, the last line is
`GATE_EXIT=<code>`, and a check missing what it needs **fails**: green always means it ran. Steps start only while
their memory estimates fit a budget (80% of free memory or of a cgroup limit such as `systemd-run -p MemoryMax=`,
printed at the start); `W3_GATE_MEM_MB=<MB>` sets it ([details](docs/testing/gate-and-smoke.md)).

**Where the maps and the game go.** The corpus is `smoketest_maps/` at the root of the *main* checkout (git-ignored,
third-party maps aren't in the repository; worktrees find it through the main checkout), or any folder named by
`W3PROJ_CORPUS=<folder>`: put `.w3x`, `.w3m` and `.w3n` files there, sub-folders are fine. The game's install folder is
read from `.game-path` in the main checkout (git-ignored; `scripts/setup-linux.sh` or `scripts/setup-windows.ps1` write
it) or `W3PROJ_GAME=<folder>`. Without them the commit gate still passes and the corpus tier fails: it never skips
silently. Minimum on a fresh clone: Node 26+, `npm ci` in `app/` (also in every new worktree: the gate refuses to start without it), the Rust toolchain.

The CLI's system tests (`crates/cli/tests/`) give the same result whether or not `W3PROJ_GAME` is set: their fixtures are
made up, and the game's TriggerData.txt doesn't know their functions. Start the binary through `common::w3proj_cmd()`,
which runs it with `W3PROJ_GAME=none`; a test that needs the real game sets its folder after that (`rebuild.rs`).

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
| System | the map's own bytes: pack → unpack → pack is identical | `crates/cli/tests/` on `tests/fixtures/mini-map` (a file for every format definition and object data kind, except the campaign info) and `tests/fixtures/mini-campaign` (`war3campaign.w3f`, `.imp`, `.w3u`: in a map, campaign info would make it a campaign) | every commit, CI |
| Hostile input | never panics; what parses still round-trips; the two fixtures hold a file for every format definition (`the_fixtures_hold_a_file_for_every_codec`) | `crates/w3proj/tests/robustness.rs`, `wtg_hostile.rs` | every commit (200 rounds), corpus tier (20,000) |
| Hostile input, app | damaged files neither hang the app nor use up its memory, under a watchdog that kills a stuck parser | `app/src/lib/hostile.test.ts`, `app/scripts/hostile-seeds.mjs` | every commit (made-up files), corpus tier (the game's files) |
| Fast game transfer | the 127.0.0.1 server (`game.fastTransfer`, `crates/backend/src/fastgame.rs`) serves game_read's bytes and refuses everything else: no or a wrong token, another Host or Origin, not GET, a body, filesystem paths, other routes; huge heads, slow and idle clients, too many connections or requests; the port closes on stop; damaged request bytes never panic, hang or stop it (seeded rounds, `W3PROJ_ROBUSTNESS_ROUNDS`). `GameService` uses it when on and falls back to game_read (stand-in fetch); app-smoke `--only=fastGameTransfer` does both in the real app with the game and prints both routes' MB/s | `crates/backend/tests/fastgame.rs`, `app/src/workbench/gamefast.test.ts`, app-smoke `fastGameTransfer` | every commit (Rust, TS), app smoke (needs the game) |
| JSON Schemas | each schema in `docs/schemas` names its format definition's fields and types, or the keys its codec reads (object data, split terrain, pathing, trigger folders); the fixtures, with a file for every definition schema (commit tier), and every corpus map's unpacked and split files (corpus tier) pass, broken samples fail | `app/src/lib/formats/schemas.test.ts` (Ajv) | every commit, corpus tier |
| Random maps | the JASS and Lua checkers on every generated script | `app/src/lib/script/random-maps.test.ts` | every commit, CI |
| UI smoke | the app's own error reports | `app/scripts/ui-smoke.mjs` | every commit, CI |
| Real app | the map it packs is the CLI's, byte for byte; nothing changes without an edit | `app/scripts/app-smoke.mjs` | locally, before merging |
| Corpus | real maps, and the baseline of which codec reads what; a map's whole ground through a fragment gives the same file | `w3proj verify`, `twin-check.mjs` | locally, before merging |
| String tables on real maps | `wts.ts` against a frozen older reading of every corpus and game `.wts` (6,393 files): untouched tables give their bytes back, edits move no other string | `app/scripts/wts-corpus.mjs` (verdict: `wts-verdict.mjs`, unit-tested in `wts-verdict.test.mjs`): a text cut at a `}` inside a line (the rule of `wts.test.ts`; 33 `_Locales/jaJP` copies) or a recovered block is expected, anything else fails; the first run extracts every `.wts` into `target/wts-corpus` (about 2.5 min and 4 GB, later runs use the cache; the gate's memory budget counts it) | corpus tier (step `wts`) |
| Generated script | the World Editor's own `war3map.j` on the game's 326 JASS maps; the Lua check (syntax and unknown names) silent on the game's 49 Lua maps | `app/scripts/script-check/run.mjs`, `tests/script-baseline.json` | locally, before merging |
| The real thing | the game and World Editor | the release checklist below | by hand, before a release |

The top of the table is fast and runs everywhere; the bottom is slow and only runs here, because
real maps and game files can't go into the repository.

## Running it

```sh
node tests/gate.mjs            # before every commit: about 30 s once built
node tests/gate.mjs coverage   # against the floors (needs cargo-llvm-cov; scripts/setup-linux.sh --with-coverage-tools)
node tests/gate.mjs corpus     # real maps and the game: about 8 minutes (the app smoke test's two halves set the pace)
node tests/gate.mjs batch      # commit and corpus in one run, for a merge batch: they overlap
node tests/gate.mjs all        # all of it: before merging to master
```

The gate runs every step even after a failure and prints one table. Its exit code is the answer:
**a check that can't run fails**, so green always means it ran. That rule exists because the
easy mistakes here look like success: `check | tail; echo $?` reports `tail`'s exit code, and two
coverage tools reported numbers for tests they hadn't measured. The last line is
`GATE_EXIT=<code>`, so the answer survives a pipe.

Parts of it: `npm test`, `cargo test`, `npm run coverage`, `npm run ui-smoke`. Rounds of the
hostile-input tests are set with `W3PROJ_ROBUSTNESS_ROUNDS`. The corpus tier finds its maps with
`W3PROJ_CORPUS` and the game with `W3PROJ_GAME`.

How the gate schedules its steps, the real-app smoke test's two halves (`--part=1/2`, `--part=2/2`), the page-call time
limit (`W3_SMOKE_CALL_TIMEOUT`), the logs in `target/gate-logs/`, the shared coverage folder, the hostile-input watchdog
and `w3proj verify` over a folder: [docs/testing/gate-and-smoke.md](docs/testing/gate-and-smoke.md).

## Tools: look before writing a scratch script

These exist so a session doesn't write the same one-off script again. Use them, and extend them when one
falls short, rather than copying their insides into a scratch file.

| To… | Use |
|---|---|
| run one TypeScript test file | `npm test -- src/lib/undo.test.ts` (in `app/`; other arguments go to node, e.g. `--test-name-pattern=…`) |
| show a test fails without the fix | `node scripts/fails-without.mjs <test> <changed source files…>` (in `app/`): passes as is, fails with those files as on `dev` (`--base`), files put back. Exit 3 means the old code merely didn't build: weak evidence. Rust: `--run "cargo test -p <crate> <name>"`, and `--keep-rust-tests` when the tests are in the changed file (every `#[cfg(…test…)] mod <name>` stays the new one) |
| look at the app, ask it something | `node scripts/app-drive.mjs <steps>` (in `app/`): the hidden smoke app (Xvfb on Linux), `--map`/`--project` (a copy), `--terrain`, `--camera game`, `--camera we[:x,y,…]` (the World Editor's view), `--view-size 1184x844`, `--compare-ready lit\|unlit`, `--look x,y`, `--shot file.png`, `--mcp tool={…}`, `--command id`, `--eval "…"` (an expression, statements, or statements that `return`), `--key Ctrl+Shift+Z` (a chord into the page: over WebDriver on Linux, so WebKitGTK's own key events come out), `--frame-cost ms` (CPU time per terrain frame: all, poses, particles, HD water's depth picture). Steps run in order; the list is at the top of the file |
| compare two pictures | `node scripts/pic-compare.mjs a.png b.png` (in `app/`): mean colour per region in both, their difference, the mean absolute difference of the pixels; `--region [name=]x,y,w,h`, `--sample` (whole and a 3x3 grid), `--diff d.png`, `--tolerance T` (exit 1 when a region's difference is above it, 2 when the pictures can't be compared). Plain JavaScript, no Pillow |
| measure how much light a shadow keeps | `node scripts/shadow-keep.mjs ON[,ON…] OFF[,OFF…] --region [name=]x,y,w,h` (in `app/`): pictures of one view with Shadows on and off (several frames each are averaged: waves and animations move), per channel in linear light the sum over the shadow's core (blurred ratio under `--threshold`, default 0.8) on over off; a region without a shadow gives `kept: null` |
| measure shadows on HD water against the World Editor | `node scripts/water-shadows.mjs [--steps maps,we,studio,measure] [--pairs 8:70,…] [--out DIR]` (in `app/`, Linux, local: runs we-drive): lakes of six pairs of depths with a scaled tree in each (make-water-shadows.mjs), four frames with View > Shadows on and off in the editor and in Studio, shadow-keep over each tree's shadow, a table of green and blue by depth (renderer.ts `waterShadowKeep`) |
| run the real-app smoke test, or one check of it | `node scripts/app-smoke.mjs [--only=<check>]` (in `app/`): builds what it needs, the release CLI too; `--part=1/2` / `--part=2/2` runs one half (see "Running it") |
| read the game's files | `w3proj game cat Units/UnitData.slk`, `game ls <filter>`, `game resolve <path>` |
| measure what opening only some subterrains saves | `node scripts/measure-subterrains.mjs [--map M.w3x \| --project DIR] [--scenarios all,one] [--one NAME] [--out F.json]` (in `app/`): makes a large split project once (the corpus's largest canvas, grown to `--size` 256 tiles by the app's Resize Map, filled with doodads, creeps and plateaus by the AI tools, split `--grid` 4×4 by `w3proj terrain split`; kept in `target/measure-subterrains/source`), then per scenario (all open, one open via `.w3proj/open-subterrains.json`) the hidden app's time to the first frame and to rest, RSS (JS heap where the webview has it: not WebKitGTK), bytes read, the flat files' read, what the renderer holds (ground quads, water triangles, doodads, units, cliffs), an edit's and a save's time with their derived-file rebuilds. Xvfb's software GL says nothing about GPU frame times; bytes read are all the app's processes read (`/proc/<pid>/io` on Linux, `Win32_Process` on Windows) |
| make a project's pathing, shadows, minimap and script as the app does, without it | `w3proj rebuild <project> [--only=wpm,shd,minimap,script] [--force]` (`--force` also replaces a script Studio didn't write last): the app's own code in Node (`app/src/headless`); app-smoke's `rebuildCli` holds its bytes against the app's |
| Studio's minimap of a map to hold against the editor's Export Minimap | `node scripts/minimap-studio.mjs MAP.w3x OUT.blp [--mode sd\|hd] [--set terrain.minimap.groundNoise=0] [--keep DIR]` (in `app/`): unpacks, rebuilds the minimap with this checkout's code (JPEG quality 100), copies the BLP; `--set …groundNoise=0` leaves the grain out so shapes can be counted (`minimap-diff.mjs`, then the editor's TGA against it) |
| look up a game table's rows | `w3proj game slk Units/UnitData.slk hfoo hbot --col unitID,movetp` (tab-separated, header first) |
| see how the open points burn down | `node scripts/openpoints-burndown.mjs` (repo root): reads `openpoints/*.md` (an open point is a `- [ ] ` line plus its indented lines; leading `[tag]`s such as `[game]`, `[windows]`, `[we]`, `[eye]`, `[extra]` become `tags`), writes `openpoints/openpoints.json` (every point with file, section, tags, text, a stable id), adds an entry to `openpoints/burndown.json` (per file, plus three lines: to build / to prove by agents / waiting for the user, primary vs `[extra]`, and per snapshot how many ids opened, closed or were edited) and `openpoints/burndown-ids.json` (the ids: first snapshot, then the deltas; a vanished id with a new one of at least 80% similar text is an edit), and writes `openpoints/burndown.html` (chart, tiles, per-day table; data inside, opens from disk). `--dry-run` prints the counts, `--no-entry` refreshes without an entry. The open points stay local; only the script is in git |
| apply testers' verdicts to the open points | `node scripts/openpoints-close.mjs <verdicts-file> [--dry-run]` (repo root): lines `<id>: PASS \| FAIL \| DIFFERS \| NOT DONE — <text>`. PASS removes the item block; FAIL/DIFFERS add a one-line item to `bugs.md` "From verification" pointing at the old one; NOT DONE adds `(not done: reason, date)`, the second moves the item to `user.md` (game/Windows/user) or `onhold.md`. Unknown ids refuse the whole run; changed files are copied to `openpoints/.backup/<timestamp>/` first. Tested in `app/scripts/openpoints.test.mjs` |
| see how well the app's pathing (war3map.wpm) matches the maps' own | `node scripts/wpm-compare.mjs [maps or folders] [--map NAME] [--cells N] [--save F] [--baseline F]` (in `app/`): regenerates each map's wpm with `buildPathingMap` (what a save runs) and diffs it with the stored file: exact or differing cells per map and a total. Default `smoketest_maps`; give the downloaded ladder folders for the large set. `--cells N` lists differing cells (x,y, tile, stored->regenerated), `--save` writes the result, `--baseline` reports maps that got better or worse (exit 1 if worse). Unpacked maps are cached in the temp folder |
| check the save's Melee-flag rule against the game's maps | `node scripts/melee-corpus.mjs [--filter TEXT] [--why] [--save F] [--baseline F]` (in `app/`): clears each game map's Melee flag and runs `savedMelee` (meleesave.ts); a map stored melee should get it back, others not. `--why` names the reasons for each miss, `--baseline` lists maps whose result changed (exit 1 if an agreement was lost) |
| count how maps store their object texts | `node scripts/object-text-census.mjs <maps or folders> [--json F]` (in `app/`): per map, the values of the fields the editor's save moves into war3map.wts (movetexts.ts `MOVED_FIELDS`) in the main and Skin object files, as references, literals and empty texts, and whether its war3map.wts carries the editor's object comments (docs/testing/object-text-strings.md) |
| look at the real World Editor (Linux, **local only**) | `node scripts/we-drive.mjs <steps>` (in `app/`): `--map`, `--wait-ready`, `--compare-ready`, `--compare-ready-unlit`, `--look x,y[,distance…]\|center`, `--shot`, `--shot-window`, `--shot-screen`, `--clipboard FILE` (the editor's clipboard text, which Wine hands to X with LF line ends whatever the editor put in), `--key KEY[@MS]` (@MS holds it), `--click X,Y`, `--double-click X,Y`, `--drag X,Y:X,Y[@MS]` (with `--drag-mod alt|shift|ctrl`, `--drag-button 2|3` or `--drag-hold MS` before it; a drag holds still 250 ms at both ends by default, as the editor reads the pointer once a frame), `--move X,Y`, `--wheel N[@X,Y]`, `--windows`, `--close-modules`, `--view-menu`, `--view Lighting=off`, `--game-view on\|off\|status`, `--fps ms`, `--open FILE` (opens a map in the running editor: Ctrl+O, the copy's row in the editor's Open list; `--map` on a running editor does this, restarting if it fails; "via" in the step's line says which), `--save FILE` (Ctrl+S, the default-name reminder answered, the saved map copied to FILE), `--export-minimap FILE` (File > Export Minimap with the dialog's defaults, the TGA copied to FILE), `--type TEXT` (into the open dialog; printable ASCII only), `--campaign FILE` (a copy of the .w3n where the Campaign Editor's Open dialog lists it: F7, Ctrl+O, `--type` its bare file name, Return; the dialog refuses `/` and `:`), `--numlock on\|off\|status` (Num Lock as the X server holds it: pressed only when it differs), `--close`; options `--screen WxH` (another view size), `--mode sd\|hd\|de`, `--day-night fixed\|cycle` (fixed by default), `--timeout S`, `--work DIR`, `--save-accept T1,T2`, `--keep-prefs`, `--null-audio` (Wine's ALSA driver on with ALSA's config a lone null device: the editor has an audio device that plays nowhere, so File > Preferences opens; nothing else is let near the sound hardware), `--pref Section/Key=value` (see "Preferences"), `--expect-layout` (`--wait-ready` fails when the main window or tool palette isn't where spec clicks were measured), `--looks-every-map` (every `--map`/`--open` gets the run's `--look` cameras, not only the first: look n is row n in each), `--slot N` (another World Editor slot: editors on two slots run at once), `--frame-cap N` (default 10, 0 none) and `--renderer software|gpu` (see "Editor CPU"), `--alone` (every slot's lock: no other editor meanwhile, for `--fps`; see "Several editors"). An unknown or malformed argument is refused before anything starts. Needs the install's English text (enUS in `.build.info`), else it says so and starts nothing. `--look` waits until two pictures a frame apart are the same (at most 10 s). The list is at the top of the file; setting up and the proof that nothing of the user's changed: `scripts/we-setup.mjs` |
| run a built binary that may be older than its sources | `tests/binfresh.mjs` refuses a `w3proj` or app binary older than a tracked source it is built from (CLI: `crates/`, Cargo files; app: also `app/src-tauri`, `app/src`, `index.html`, the vite/TS configs, the npm packages), as we-compare and the `make-*.mjs` generators use them: rebuild, or pass `--allow-stale` (anywhere on the command line; `binfresh.mjs` takes it out of `process.argv` on import, so positional arguments don't shift) / `W3_ALLOW_STALE=1`. mtimes are compared, so a fresh checkout refuses a binary built before it |

The game folder: `W3PROJ_GAME`, else `.game-path` in the checkout (written by `scripts/setup-linux.sh` and
`scripts/setup-windows.bat`; one folder per line after `#` comments, the first that exists counts, so a checkout
shared by a Windows and a Linux machine lists both), else the folder above the checkout (the Windows layout).
The CLI reads `W3PROJ_GAME` too. The smoke app's identifier is one per checkout (`W3_SMOKE_ID` overrides it), so
runs in two worktrees don't share settings; none of these tools starts the game or the World Editor, except
`we-drive.mjs`, which starts the World Editor only.

## The real World Editor: we-drive, we-compare, slots

The measurements behind these rules, and every per-branch finding, are in [docs/testing/](docs/testing/README.md).
This is the short form.

- **Local only.** `we-drive.mjs` needs the installed game, Proton, Xvfb, bubblewrap, a C compiler, python3 with
  python-xlib and Pillow, and Mesa's lavapipe; without one it prints `{"skipped": why}` and exits 0. Not in CI, not in
  the gate. It starts the World Editor only, never the game ([how it works](docs/testing/editor-tooling.md)).
- **Nothing of the user's is touched, nothing is sent out, nothing is shown.** One farm for all worktrees in
  `target/we`, its own prefix, a sandbox without network, its own Xvfb display; `we-x11.py` refuses any display that
  isn't an Xvfb process. Never start `World Editor.exe` any other way and never touch its crash dialog.
- **One editor per lock.** A we-drive process holds its slot's lock for the whole run: expect to wait, with
  `--timeout`. Slot 0 is the farm; `--slot N` runs another editor at once, `we-compare --slot auto [--slots 0,1,2]`
  takes the first free one and `--shard i/n` deals whole spec files out to n runs. `--fps` is not parallel-safe: use
  `--alone`. Details and the A/B numbers: [editor-tooling.md](docs/testing/editor-tooling.md).
- **Options that change pictures.** `--frame-cap N` (default 10: the editor redraws all the time and each frame costs
  CPU under lavapipe; settled pictures are the same bytes, animations' phase can differ; `0` = none),
  `--renderer software|gpu` (default software: the same pictures on every machine; we-compare's `auto` uses gpu only
  for specs that need none of lavapipe's exact pixels; a spec's `we.renderer` overrides). Measurements:
  [editor-tooling.md](docs/testing/editor-tooling.md).
- **Positions are measured on the fixed 1600x1000 display** (main window, terrain view 1184x844, palette); clicks
  need the projection of a ground point to the screen: [layout and camera](docs/testing/editor-tooling.md),
  [projection for clicks](docs/testing/cameras-and-views.md).
- **Wait for the editor, not the clock.** `--wait-ready` instead of fixed pauses (`we-sleeps.mjs` counts the ones left); a number field needs Enter
  or a blur before an edit happens ([hygiene](docs/testing/editor-tooling.md)).
- **World Editor parity work:** observe the editor first, write the we-compare spec (`node scripts/we-compare.mjs
  <spec.json…>`: the same steps in the editor and in Studio, both saved, files diffed) before changing Studio, and keep it.
  One we-drive process runs one mode's specs in one editor; what a spec toggles stays for the next
  ([rules of a round](docs/testing/verification-rounds.md)).
- **One build per round:** `node scripts/verify-build.mjs` builds a commit once into `target/verify/<sha>/` for all
  testers (older builds are pruned, about 3.8 GB each); testers run app-drive, app-smoke and we-compare against that
  binary with `--app` / `W3_APP_BIN` ([verification-rounds.md](docs/testing/verification-rounds.md)).
- **Pictures:** same size, camera and lighting on both sides, then `pic-compare.mjs`:
  [pictures.md](docs/testing/pictures.md).

| Topic | Where the findings are |
|---|---|
| terrain, ramps, cliffs, water, the border | [terrain-and-water.md](docs/testing/terrain-and-water.md) |
| minimaps | [minimaps.md](docs/testing/minimaps.md) |
| lighting, shadows | [lighting-and-shadows.md](docs/testing/lighting-and-shadows.md) |
| doodads, units, items | [doodads-and-units.md](docs/testing/doodads-and-units.md) |
| what files store (w3i, w3e, wpm, doo, wts, objects) | [saved-data-rules.md](docs/testing/saved-data-rules.md) |
| Trigger, Object, Sound, AI editors | [editors-and-ui.md](docs/testing/editors-and-ui.md) |
| cameras, zoom, View menu | [cameras-and-views.md](docs/testing/cameras-and-views.md) |
| rounds that measured many things | [branch-rounds.md](docs/testing/branch-rounds.md) |

## Refused values

Decision 2026-11-15: a value past what its stored field holds is refused with a message and the map left as it was,
never wrapped, clamped without a word, truncated or overflowed, unless the World Editor does otherwise and a we-compare
spec relies on it ("measured, kept"). The table of every field, its bound, where it is checked and its tests is in
[docs/testing/refused-values.md](docs/testing/refused-values.md).


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

Mutation testing is too slow for each commit, so run it now and then on small critical files. Never uncapped: a
mutant that turns `i += 1` into `i *= 1` loops while allocating, and one filled the machine's 62 GB. The runner caps
each test binary, the scope the whole run (Linux; cargo-mutants can live in `target/tools`):

```sh
CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER=$PWD/tests/mutants-runner.sh \
  systemd-run --user --scope -p MemoryMax=18G -p MemorySwapMax=0 -- \
  cargo mutants -j 3 --timeout 60 -f crates/mpq/src/crypto.rs -p mpq
```

Last run (2026-11-24) on `lossless.rs`, `paths.rs`, `format/expr.rs` and `wtg.rs`: the survivors left are equivalent
mutants, each explained where it is (`lossless.rs` FIRST, `paths.rs` percent_decode).

`cargo-mutants`, `cargo-llvm-cov` and the `llvm-tools` rustup component are optional installs:
`scripts/setup-linux.sh --with-coverage-tools` (or `scripts\setup-windows.bat --with-coverage-tools`).

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
