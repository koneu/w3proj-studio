# The gate and the smoke tests: details

How the gate schedules its steps, how the real-app smoke test splits into two apps, time limits, logs, coverage folders, the watchdog. Part of the [testing guide](../../TESTING.md); index in [README](README.md).

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

**Memory.** Each step has an estimate of its peak memory (`mem` in MB, measured as the summed RSS of its
process tree), and a step starts only while the estimates of the running steps add up to no more than the
budget, printed at the start (`gate: memory budget ...`). A step that waits for memory alone says so
(`wait <step>: needs about ... MB`). The budget is 80% of the smaller of `MemAvailable` (`os.freemem()` on
Windows and macOS) and what the gate's cgroup leaves (cgroup v2: `memory.max` minus `memory.current`, the
tightest from its own cgroup up, so `systemd-run --user --scope -p MemoryMax=20G` is seen);
`W3_GATE_MEM_MB=<MB>` sets it instead. A step bigger than the budget still runs, alone. A step whose need grew a
lot gets its new estimate in `tests/gate.mjs`.

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
