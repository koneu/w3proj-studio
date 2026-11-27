# The gate and the smoke tests: details

How the gate schedules its steps, the queue between gates, how the real-app smoke test splits into three apps, time limits, logs, coverage folders, the watchdog. Part of the [testing guide](../../TESTING.md); index in [README](README.md).

**Steps run side by side.** Steps that don't need each other run together (about twice the cores' worth;
`--jobs=<n>` changes that, `--serial` goes one at a time in the table's order). What one needs
from another is written down in `tests/gate.mjs`: the release CLI comes before everything that runs
it, one cargo command works in a profile's folder of `target/` at a time (debug and release don't wait
for each other, as in cargo itself), and the app's build and the UI smoke test, which rebuild `app/dist`
(every build of the Tauri crate reads it), take turns with the cargo steps that read it. The real app is
built by a step of its own (`appbuild`, beside the release CLI's build), and its smoke parts start when
both are there. Steps
queue for a lock in the order they became ready: once the UI smoke test waits to rebuild `app/dist`,
no step that comes later starts building against it first (`tests/gate-scheduler.mjs`, with its
tests in `app/scripts/gate-scheduler.test.mjs`). A step whose prerequisite
failed fails without running.

**The longest chain goes first.** The app's build and the smoke parts after it decide how long the corpus tier
takes, so they have `priority` in the step table: they start before other steps that are ready, and while one of
them could start but for the cores or the memory, no step without priority starts, so what the running steps free
adds up for it. (Before, short steps took the memory one after the other and a smoke part waited two minutes.)

**Gates at once.** The gates of this repository queue on the machine, whichever worktree each is started in: a
folder in the main checkout (`target/gate-queue`, one file per gate that waits or runs, with its process in it).
- **Commit gates of different worktrees run side by side.** They share one memory budget: each writes into its entry
  what its steps may use, and a gate that starts beside others takes that off its own budget (`gate: memory budget …,
  less … MB for 2 other gates`). With several running a late one may be left little and run its steps one at a time.
- **A gate with any step outside the commit tier runs alone** (`corpus`, `batch`, `all`, `coverage`, or `--only` with
  such a step): the app smoke test doesn't stand the load of another gate (2026-11-27: two parts timed out beside
  another worktree's commit gate and passed alone), and the corpus step alone takes half the memory.
- **Two gates of one checkout never run together:** they share `app/dist`, the smoke tests' folders and the browser
  profiles.
- **First come, first served** among gates that can't run together: once a batch gate waits, commit gates that come
  later wait behind it instead of passing it for ever.

A gate that waits prints `gate: waiting for the gate of <checkout> (process …, running since …)` every 30 s; its
memory budget and its times count from its own start. What a killed gate left in the folder is removed by the next
one (the process is gone, or on Linux its number belongs to a process started at another time). Ctrl-C, a kill or a
closed terminal end the steps' processes and take the gate out of the queue. `--no-queue` (or `W3_GATE_QUEUE=0`)
starts at once, beside whatever runs.

**One step again.** `node tests/gate.mjs --only=appsmoke2` runs that step and what it comes after (the release CLI
and the app's build, both quick when nothing changed), `--only=rust,clippy` those two. The ids are the ones in the
step table of `tests/gate.mjs`; a wrong one lists them. It is for looking at one failure, not a gate result: only a
tier's run says the tree passed.

**Memory.** Each step has an estimate of its peak memory (`mem` in MB, measured as the summed RSS of its
process tree), and a step starts only while the estimates of the running steps add up to no more than the
budget, printed at the start (`gate: memory budget ...`). A step that waits for memory alone says so
(`wait <step>: needs about ... MB`). The budget is 80% of the smaller of `MemAvailable` (`os.freemem()` on
Windows and macOS) and what the gate's cgroup leaves (cgroup v2: `memory.max` minus `memory.current`, the
tightest from its own cgroup up, so `systemd-run --user --scope -p MemoryMax=20G` is seen);
`W3_GATE_MEM_MB=<MB>` sets it instead. A step bigger than the budget still runs, alone. A step whose need grew a
lot gets its new estimate in `tests/gate.mjs`.

**The real-app smoke test runs as three apps at once** in the corpus tier, on one build: `app-smoke.mjs --build-only`
builds the app (the gate's step `appbuild`), then `--part=1/3 --no-build` runs the project checks and the first third
of the full run's checks (`checksA`, newMaps to viewCommands), `--part=2/3 --no-build` the second (`checksB`,
itemTablesAccess to niceToHaves) and `--part=3/3 --no-build` the last (`checksC`, byHand to the end). The checks take
about as long in three apps as in two (2026-11-27, an idle machine: 1654 s in all against 1736 s), so the third app
ends the run sooner: 523, 460 and 671 s side by side, against 714 and 1022 s. Each part has its own folder
(`target/app-smoke-part<n>`, or `W3_SMOKE_DIR` with `-part<n>`), its settings in it (the app reads
`W3PROJ_CONFIG_DIR`, since both have the build's identifier; app-smoke stops when the app doesn't say it listened),
and its own Xvfb display and WebDriver ports (Linux; a driver that loses the race for a display starts again) or
DevTools port and WebView2 folder (Windows). The parts keep the full run's order, so a check that relies on what an
earlier one left stays behind it (testMapWithoutGame on the map objectsWhileOpening left open); every check from
itemTablesAccess on also runs alone (`--only`), so the cut between `checksB` and `checksC` can move. The parts are
balanced by the times each check prints (`took X s: <check>`): move the cut when one grows much longer than the others. The
copy of the release CLI next to the app (for the AI client setup check) is made once: a part that finds it there with
the same bytes leaves it, and a new one arrives under its name in one step, since another part may be running it. To
run one part by hand: `node scripts/app-smoke.mjs --part=2/3` (in `app/`; it builds unless `--no-build`: not while
another part or the gate builds). A plain `node scripts/app-smoke.mjs` still runs everything in one app.

**A page call has a time limit of its own** (app-smoke: `page.evaluate`, `mcpTool`): 60 s unless it gives one
(`page.evaluate(expr, { timeout })`, `tool(name, args, { timeout })`; `W3_SMOKE_CALL_TIMEOUT` in ms changes the
default). One that hangs fails with `page call timed out after … s: <the call>` instead of holding the run until
WebDriver gives up; a call that took more than half its limit prints `slow page call: …` on stderr. On Linux the
session's script timeout is set to just past the call's limit, since WebDriver runs a session's commands one at a time.

Each step's output goes to `target/gate-logs/<tier>-<pid>/<step>.log` (`only-<pid>` for `--only`; the folder is
emptied first, since process numbers come round again, and folders older than a day go); the
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
