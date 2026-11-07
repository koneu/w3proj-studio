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
smoke test builds first, and the rest of the gate waits for that build, not for the whole test. A step whose prerequisite
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
   window. Building a trigger's events and actions, and placing with the mouse, are still GUI rounds.
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
