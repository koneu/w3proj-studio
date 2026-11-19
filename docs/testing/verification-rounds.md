# Verification rounds

One build, many testers, World Editor slots: verify-build, we-compare and the rules for a round. Part of the [testing guide](../../TESTING.md); index in [README](README.md).

**One build per round**: `node scripts/verify-build.mjs [--commit REV] [--tester NAME] [--json] [--no-cli] [--force]` (in `app/`)
`git archive`s the commit into `target/verify/<short-sha>/` of the main checkout, runs `npm ci`, builds the smoke app
(`appctl.mjs buildApp`, debug, sccache through the main checkout's `.cargo/config.toml`) and the release CLI, and writes
`verify.json`. A commit already built is not built again (the second caller prints at once); two callers at once take
turns (a lock folder next to it). It prints the binary, the CLI and the command lines for a tester named NAME:

- app-drive: `node scripts/app-drive.mjs --app <binary> --work <own folder> <steps>`

- app-smoke: `W3_APP_BIN=<binary> W3PROJ_BIN=<cli> W3_SMOKE_DIR=<own folder> node scripts/app-smoke.mjs --only=<check>`

- we-compare: `node scripts/we-compare.mjs --app <binary> --work <own folder> --slot auto <spec.json>` (the first free
  World Editor slot: testers' editors run at once, see "Several editors")

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
**one we-drive process**: one display, one setup, one slot's lock and ONE editor (each next map is opened in it, `--map` on the
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
COMPARED); the JSON report is `<work>/report.json`. The work folder is locked (`we-compare.lock`): parallel runs need
their own `--work` (the default is the slot's, `target/we-compare-slotN`: see "Several editors"). Kinds that can give a false DIFFERS between two random draws: `w3e-variation` (a value worn by
about 5% of a texture's corners sits on the cut), `doodad-places` (a doodad at a 64 square's edge), `w3e-spread`
(a rare offset drawn in one run only): rerun before calling it a finding. Unit tests: `we-compare.test.mjs`,
`we-compare-w3e.test.mjs`, `we-compare-runner.test.mjs`. It isn't in the gate (the gate has no World Editor step); run it by hand with a
`W3PROJ_WE_DIR` of its own and `we-setup.mjs --clean` afterwards.
