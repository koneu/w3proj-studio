// One command for every automatic check, with one honest answer. See TESTING.md.
//
//   node tests/gate.mjs            the commit gate: types, unit and system tests, clippy, UI smoke, web demo
//   node tests/gate.mjs coverage   the commit gate's tests, measured against tests/coverage-floor.json
//   node tests/gate.mjs corpus     real maps and the installed game (local only, some minutes)
//   node tests/gate.mjs batch      commit and corpus in one run (a merge batch: they overlap)
//   node tests/gate.mjs all        all of the above
//
//   --serial       one step at a time, in the order of the table (to compare, or to read one log)
//   --jobs=<n>     how many cores' worth of steps run together (default: twice the cores)
//   --only=<ids>   only these steps (ids as in the table below, comma separated) and the steps they come after:
//                  to run a failed step again without the rest. Not a gate result: the tiers are.
//   --no-queue     don't wait for another gate on this machine (or W3_GATE_QUEUE=0)
//   --update-floor raise the coverage floors to what was measured
//
// Safe to start any number of times, also at once and from several worktrees: the gates of one repository queue in
// the main checkout's target/gate-queue (tests/gate-lib.mjs withGateQueue). Commit gates of different worktrees run
// side by side, on one memory budget; a gate with any other step (the corpus tier: the app smoke test doesn't stand
// another gate's load) runs alone, and so do two gates of one checkout (they share app/dist and the smoke tests'
// folders). A run leaves nothing a later run trips over: its logs have a
// folder of their own, its scratch folders are emptied before use, and what a killed run left is cleared by the next.
//
// Every step runs even after a failure, and the exit code is non-zero if any step failed or
// couldn't run. A check that is missing what it needs FAILS: a green result always means it ran.
// The last line is GATE_EXIT=<code>, also when the output went through a pipe.
//
// Steps that don't need each other run side by side. What one needs from another is written down
// as `after` (the release CLI before everything that runs it, the app's build before the smoke parts
// that run it) and as locks, held for the whole step: "cargo-debug" and "cargo-release" (one cargo
// command in a profile's folder of target/ at a time; the two profiles don't wait for each other, as
// in cargo itself), "dist" (app/dist is read by every build of the Tauri crate, and rebuilt by the
// app's build and the UI smoke test: they take turns). Steps queue for a
// lock in the order they became ready, so a step waiting for "dist" alone isn't passed by later
// readers (tests/gate-scheduler.mjs, tested in app/scripts/gate-scheduler.test.mjs). A
// step whose `after` step failed fails without running. The app's build and its smoke parts are the
// longest chain, so they have `priority`: they start before others that are ready, and what gets free
// is kept for them while they wait. Each step writes its output to its own
// log under target/gate-logs/<tier>-<pid>/ and the gate prints it, or its tail, when the step ends.
//
// Needs for `coverage`: cargo-llvm-cov and the llvm-tools component.
// Needs for `corpus`: the maps (W3PROJ_CORPUS, default smoketest_maps next to the main checkout)
// and the game (W3PROJ_GAME, else the folder in `.game-path`, else the Warcraft III folder above it:
// tests/gamepath.mjs).

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, freemem } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Locks, schedule } from "./gate-scheduler.mjs";
import { assertInTable, checkFloors, gamePrefixBusy, installSignalHandlers, memoryBudget, missingDeps, processLines, runShell, sharedBudget, withFileLock, withGateQueue, withPrerequisites } from "./gate-lib.mjs";
import { wineserverReport } from "./wineservers.mjs";
import { gamePath } from "./gamepath.mjs";

// An older Node (a system one on Linux, when nvm's isn't loaded in this shell) fails steps in ways that look like
// bugs (no WebSocket global, unknown test flags): say so instead, before anything runs.
if (Number(process.versions.node.split(".")[0]) < 26) {
  console.error(`the gate needs Node 26 or newer; this is ${process.version} (${process.execPath}). On Linux: source ~/.nvm/nvm.sh`);
  console.log("GATE_EXIT=1");
  process.exit(1);
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(repo, "app");
const exe = process.platform === "win32" ? ".exe" : "";
const args = process.argv.slice(2);

// A new git worktree has no app/node_modules: every step would fail with its own confusing error.
const depsProblem = missingDeps(app);
if (depsProblem) {
  console.error(`gate: ${depsProblem}`);
  console.log("GATE_EXIT=1");
  process.exit(1);
}

/** The main checkout, also from a git worktree: that's where the ignored maps are. */
function mainCheckout() {
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8" });
  return r.status === 0 ? dirname(resolve(repo, r.stdout.trim())) : repo;
}

const corpus = process.env.W3PROJ_CORPUS ?? join(mainCheckout(), "smoketest_maps");
const game = gamePath(repo);

// ---- locks -----------------------------------------------------------------------------------

/** The locks between this gate's steps (tests/gate-scheduler.mjs). */
const locks = new Locks();

// ---- running commands ------------------------------------------------------------------------

/**
 * What a step can do. Everything it runs writes to the step's log; a command's exit code decides.
 * `stdout`: a file for the command's standard output instead of the log (the errors still go
 * to the log).
 */
function context(log) {
  const fd = openSync(log, "w");
  const write = (text) => {
    writeFileSync(fd, text.endsWith("\n") ? text : `${text}\n`);
  };
  return {
    say: write,
    log,
    sh(command, { cwd = repo, env = {}, stdout } = {}) {
      return runShell(command, { cwd, env, stdout, fd, write, timeoutMs: stepTimeoutMs, live: liveChildren });
    },
    close: () => closeSync(fd),
  };
}

/** A step's longest run: a hung one fails instead of holding the gate for ever. */
const stepTimeoutMs = (Number(process.env.W3_GATE_STEP_TIMEOUT_MIN) || 90) * 60000;
/** Every command a step started that hasn't ended. */
const liveChildren = new Set();

/** A command as a step: `sh("cargo ...", { cwd, env })`. */
const shell = (command, options) => (ctx) => ctx.sh(command, options);

const needs = (path, what, step) => async (ctx) => {
  if (!existsSync(path)) {
    ctx.say(`missing ${what}: ${path}`);
    return false;
  }
  return step(ctx);
};

/** Where cargo-llvm-cov builds. Shared by all worktrees of this repository: the dependencies are
 * compiled once, not once per worktree (3 minutes cold). Its file lock makes one gate at a time
 * use it, because cargo-llvm-cov sweeps every .profraw in its folder before it runs. */
const covTarget = process.env.W3PROJ_COV_TARGET_DIR ?? join(mainCheckout(), "target", "llvm-cov-shared");

/** Rust line coverage per crate, against the floors. */
async function rustCoverage(ctx) {
  const out = join(repo, "target", "cov-rust.json");
  mkdirSync(dirname(covTarget), { recursive: true });
  const measured = await withFileLock(`${covTarget}.lock`, repo, (m) => { ctx.say(m); console.log(`   Rust coverage: ${m}`); }, () =>
    ctx.sh(`cargo llvm-cov --workspace --locked --json --summary-only --output-path "${out}"`, { env: { CARGO_TARGET_DIR: covTarget } }),
  );
  if (!measured) return false;
  const areas = {};
  for (const f of JSON.parse(readFileSync(out, "utf8")).data[0].files) {
    const path = f.filename.replaceAll("\\", "/");
    const crate = /\/crates\/([^/]+)\//.exec(path)?.[1] ?? "app";
    const a = (areas[crate] ??= { lines: 0, covered: 0 });
    a.lines += f.summary.lines.count;
    a.covered += f.summary.lines.covered;
  }
  const floorFile = join(repo, "tests", "coverage-floor.json");
  const all = JSON.parse(readFileSync(floorFile, "utf8"));
  const updating = args.includes("--update-floor");
  const r = checkFloors(areas, all.rust, ctx.say, updating);
  all.rust = r.floors;
  const ok = r.ok;
  if (updating) writeFileSync(floorFile, JSON.stringify(all, null, 2) + "\n");
  return ok;
}

/**
 * The 20000-round hostile-input tests. Built under the cargo lock, then the test program runs by
 * itself: its minutes of work don't hold up the other cargo commands.
 */
async function hostileRounds(ctx) {
  const list = join(dirname(ctx.log), "robustness-build.json");
  mkdirSync(dirname(list), { recursive: true });
  const built = await locks.hold("cargo-release", "w", () => ctx.sh("cargo test --release -p w3proj --test robustness --locked --no-run --message-format=json", { stdout: list }));
  if (!built) {
    // The compiler's own messages, as cargo would have printed them, and anything else it said.
    for (const line of readFileSync(list, "utf8").split("\n")) {
      if (!line.startsWith("{")) {
        if (line.trim()) ctx.say(line);
        continue;
      }
      try {
        const m = JSON.parse(line);
        if (m.reason === "compiler-message" && m.message?.rendered) ctx.say(m.message.rendered);
      } catch {
        ctx.say(line);
      }
    }
    return false;
  }
  let program;
  for (const line of readFileSync(list, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    const m = JSON.parse(line);
    if (m.reason === "compiler-artifact" && m.target?.name === "robustness" && m.profile?.test && m.executable) program = m.executable;
  }
  if (!program) {
    ctx.say("cargo didn't say where the robustness tests are");
    return false;
  }
  return ctx.sh(`"${program}"`, { cwd: join(repo, "crates", "w3proj"), env: { W3PROJ_ROBUSTNESS_ROUNDS: "20000" } });
}

const bin = join(repo, "target", "release", `w3proj${exe}`);
// The app smoke test's settings folder goes by this identifier: one per worktree, so that gates of
// different worktrees don't share it (two gates in one worktree share target/ anyway). The same
// name each run, so no new folder is left in the user's settings per run.
const smokeId = process.env.W3_SMOKE_ID ?? `dev.w3proj.studio.smoke.${basename(repo).replace(/[^A-Za-z0-9-]+/g, "-")}`;
const smokeEnv = { W3PROJ_GAME: game, W3PROJ_BIN: bin, W3_SMOKE_ID: smokeId };
const hasGame = join(game, ".build.info");
// How many apps the app smoke test's checks are dealt to (app-smoke.mjs --part=k/n, cut by app/scripts/smoke-parts.mjs
// into runs of the same length). W3_SMOKE_PARTS: another number for this run. Three, because more didn't end the batch
// gate sooner on 8 cores (16 threads) and 64 GB (2026-11-28): an app's page works on one core, but beside the gate's
// other steps its checks take longer the more apps there are (all checks together: about 2100 s in five apps with
// nothing beside them, 2900 to 3500 s in a batch gate), so five parts took 730 and 773 s against 773 s for three, with
// 8 GB more in use and a check timing out once. Alone (--only=appsmoke1,...) five parts end in 506 s.
const SMOKE_PARTS = Math.min(16, Math.max(1, Math.floor(Number(process.env.W3_SMOKE_PARTS)) || 3));
// A part's memory: measured as PSS of its process tree, up to 5800 MB in five parts (they grow with every check).
const SMOKE_PART_MEM = 6500;
// The checks that run a Windows program (JassHelper, through Proton) in the user's game prefix. While the user's
// Warcraft III or Battle.net runs in that prefix they would fail in confusing ways (X BadWindow, "Fontconfig out of
// memory"; seen 2026-11-15), so the parts leave them out then (app-smoke.mjs --skip) and the table says so. The we-drive
// steps are not among them: the World Editor has its own prefix under target/we.
const PREFIX_CHECKS = ["vjassCheck", "scriptGenerated"];
/** Set when the steps start (runSteps): the process line that shows the game running, else null. */
let gameBusy = null;
const skipFlag = () => (gameBusy ? ` --skip=${PREFIX_CHECKS.join(",")}` : "");
/** The app smoke test's parts, on the build of `appbuild`: the gate's longest chain, so `priority`. */
const smokeParts = Array.from({ length: SMOKE_PARTS }, (_, i) => ({
  id: `appsmoke${i + 1}`, name: `the real app on a scratch project (part ${i + 1}/${SMOKE_PARTS})`, tier: "corpus", weight: 2, mem: SMOKE_PART_MEM, priority: 1, after: ["cli", "appbuild"],
  // The command is made when the step starts: whether the game runs is known by then.
  run: (ctx) => shell(`node scripts/app-smoke.mjs --part=${i + 1}/${SMOKE_PARTS} --no-build${skipFlag()}`, { cwd: app, env: smokeEnv })(ctx),
}));
const update = args.includes("--update-floor") ? " --update-floor" : "";

// Steps, in the order they are started when they can be. `weight`: about how many cores it keeps
// busy. `mem`: about its peak memory in MB (the summed RSS of its process tree, measured on 16 cores
// in a batch gate on 2026-11-25, cold caches; the scheduler's budget, docs/testing/gate-and-smoke.md).
// `tier`: the tiers it belongs to. The table at the end is in the order of `table`.
const steps = [
  { id: "cli", name: "release CLI", tier: "corpus", weight: 6, mem: 1000, priority: 1, locks: [["cargo-release", "w"]], run: shell("cargo build --release --locked -p w3proj-cli") },
  // The real app's smoke test: one build (the debug profile, so it runs beside the release CLI's), then SMOKE_PARTS
  // apps of it side by side, each with its share of the checks.
  // appbuild's mem: not measured alone (the old part 1, build and app together, peaked at 5000).
  { id: "appbuild", name: "the real app's build", tier: "corpus", weight: 6, mem: 5000, priority: 1, locks: [["cargo-debug", "w"], ["dist", "w"]], run: shell("node scripts/app-smoke.mjs --build-only", { cwd: app, env: smokeEnv }) },
  ...smokeParts,
  // `w3proj verify` checks the maps on all cores, so its memory grows with them: alone under a 20 GB limit.
  { id: "corpus", name: "corpus round trip and codec baseline", tier: "corpus", weight: 10, mem: 17000, after: ["cli"], run: needs(corpus, "the map corpus", shell(`"${bin}" verify -q "${corpus}" --baseline tests/corpus-baseline.tsv --game "${game}"`)) },
  { id: "hostile", name: "hostile input, 20000 rounds", tier: "corpus", weight: 10, mem: 1500, run: hostileRounds },
  { id: "seeds", name: "hostile input on the game's own files", tier: "corpus", weight: 2, mem: 1000, after: ["cli"], run: needs(hasGame, "the game", shell("node scripts/hostile-seeds.mjs", { cwd: app, env: { W3PROJ_GAME: game, W3PROJ_BIN: bin } })) },
  { id: "script", name: "generated scripts against the World Editor's", tier: "corpus", weight: 8, mem: 3500, after: ["cli"], run: needs(hasGame, "the game", shell("node scripts/script-check/run.mjs", { cwd: app, env: { W3PROJ_GAME: game, W3PROJ_BIN: bin } })) },
  // The first run extracts every .wts of the corpus and the game (2.5 min, then cached in target/wts-corpus), so it
  // weighs as much as an app smoke part.
  { id: "wts", name: "string tables against the frozen reading on every .wts", tier: "corpus", weight: 4, mem: 4000, after: ["cli"], run: needs(hasGame, "the game", shell("node scripts/wts-corpus.mjs", { cwd: app, env: { W3PROJ_GAME: game, W3PROJ_BIN: bin, W3PROJ_CORPUS: corpus } })) },
  { id: "twin", name: "Rust and TypeScript codecs agree", tier: "corpus", weight: 2, mem: 1500, after: ["cli"], run: needs(corpus, "the map corpus", shell(`node scripts/twin-check.mjs "${corpus}"`, { cwd: app, env: { W3PROJ_GAME: game, W3PROJ_BIN: bin } })) },
  // Before `rust` and `clippy`, and done with app/dist as soon as Vite prints "built in" (~1.5 s): its browser phase
  // overlaps them instead of queueing behind both. (It only reads app/dist from then on, as they do.)
  { id: "ui", name: "UI smoke (headless)", tier: "commit", weight: 2, mem: 1500, locks: [["dist", "w"]], built: "built in", run: shell("node scripts/ui-smoke.mjs --build", { cwd: app }) },
  // rustcov and tscov: not measured; as their test steps and a bit more.
  { id: "rustcov", name: "Rust coverage floors", tier: "coverage", weight: 8, mem: 4500, locks: [["dist", "r"]], run: rustCoverage },
  { id: "rust", name: "Rust unit and system tests", tier: "commit", weight: 4, mem: 3500, locks: [["cargo-debug", "w"], ["dist", "r"]], run: shell("cargo test --workspace --locked --quiet") },
  { id: "clippy", name: "clippy", tier: "commit", weight: 4, mem: 1500, locks: [["cargo-debug", "w"], ["dist", "r"]], run: shell("cargo clippy --workspace --all-targets --locked --quiet -- -D warnings") },
  // The web demo (docs/web-demo.md): its own build folder (app/dist-demo), so no "dist" lock. A missing browser FAILS, as in ui-smoke.
  { id: "demo", name: "web demo build and check (headless)", tier: "commit", weight: 2, mem: 1500, run: shell("node scripts/demo-check.mjs --build", { cwd: app }) },
  { id: "tsc", name: "types, module boundaries, scripts load", tier: "commit", weight: 4, mem: 700, run: shell("npm run --silent check", { cwd: app }) },
  // Without the game (W3PROJ_GAME=""): the tests that read its files are slow, and `tstestcorpus` runs them with W3PROJ_REQUIRE_CORPUS=1.
  { id: "tstest", name: "TypeScript unit tests", tier: "commit", weight: 4, mem: 3000, run: shell("npm test --silent -- --test-reporter=dot", { cwd: app, env: { W3PROJ_GAME: "" } }) },
  // The same tests in the tier that has the corpus and the game: a test for a missing map or game file FAILS here instead of skipping (testutil.ts).
  // The CLI's Rust tests that read the game (rebuild.rs) skip without it; here they fail instead. They find it by W3PROJ_GAME, else `.game-path`; every other CLI test
  // switches the game off for the binary it starts (crates/cli/tests/common), as their fixtures are made up.
  { id: "rustcorpus", name: "Rust CLI tests on the corpus (nothing skipped)", tier: "corpus", weight: 4, mem: 3500, after: ["cli"], locks: [["cargo-release", "w"]], run: needs(hasGame, "the game", shell("cargo test --release --locked -p w3proj-cli --quiet", { env: { W3PROJ_REQUIRE_CORPUS: "1", W3PROJ_CORPUS: corpus } })) },
  { id: "tstestcorpus", name: "TypeScript unit tests on the corpus (nothing skipped)", tier: "corpus", weight: 2, mem: 9000, after: ["cli"], run: needs(corpus, "the map corpus", needs(hasGame, "the game", shell("npm test --silent -- --test-reporter=dot", { cwd: app, env: { W3PROJ_REQUIRE_CORPUS: "1", W3PROJ_CORPUS: corpus, W3PROJ_GAME: game, W3PROJ_BIN: bin } }))) },
  { id: "tscov", name: "TypeScript coverage floors", tier: "coverage", weight: 3, mem: 4000, run: shell(`npm run --silent coverage -- --check${update}`, { cwd: app }) },
];
// The table: the order the steps always had.
const table = ["tsc", "tstest", "rust", "clippy", "ui", "demo", "tstestcorpus", "rustcorpus", "tscov", "rustcov", "cli", "hostile", "seeds", "corpus", "wts", "twin", "appbuild", ...smokeParts.map((s) => s.id), "script"];

const tiers = {
  commit: ["commit"],
  coverage: ["coverage"],
  corpus: ["corpus"],
  // A merge batch's check: both tiers in one run, so the Rust tests and clippy overlap the app smoke test.
  batch: ["commit", "corpus"],
  all: ["commit", "coverage", "corpus"],
};
const tierArg = args.find((a) => !a.startsWith("--"));
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",").filter(Boolean);
const tier = only ? "only" : (tierArg ?? "commit");
if (only ? tierArg !== undefined : !tiers[tier]) {
  console.error(only ? `--only names its steps: not with a tier ("${tierArg}")` : `no tier "${tier}": ${Object.keys(tiers).join(", ")}`);
  process.exit(2);
}
// A step missing from the table would be run but left out of the result.
assertInTable(steps, table);
const unknown = (only ?? []).filter((id) => !steps.some((s) => s.id === id));
if (unknown.length || only?.length === 0) {
  console.error(`--only: no step ${unknown.map((id) => `"${id}"`).join(", ") || "named"}; the steps: ${table.join(", ")}`);
  process.exit(2);
}
const chosen = only ? withPrerequisites(steps, only) : steps.filter((s) => tiers[tier].includes(s.tier));
// The `corpus` tier alone also needs nothing from the others; the `commit` tier needs the
// release CLI for nothing. A step's `after` that isn't part of the tier is simply not waited for.
const serial = args.includes("--serial");
const jobs = Number(args.find((a) => a.startsWith("--jobs="))?.slice(7)) || availableParallelism() * 2;

// One folder of logs for each run, so that gates running at once don't write over each other's;
// the folders of runs more than a day old go.
const logRoot = join(repo, "target", "gate-logs");
mkdirSync(logRoot, { recursive: true });
for (const old of readdirSync(logRoot)) {
  const path = join(logRoot, old);
  if (Date.now() - statSync(path).mtimeMs > 24 * 3600 * 1000) rmSync(path, { recursive: true, force: true });
}
const logDir = join(logRoot, `${tier}-${process.pid}`);
// A run of the last day with this process id (they come round again) left its logs here: not this run's.
rmSync(logDir, { recursive: true, force: true });
mkdirSync(logDir, { recursive: true });

// ---- scheduling ------------------------------------------------------------------------------

const done = new Map();
const clock = () => `${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s`;

/** What a step printed: all of it if short, else the end of it and where the rest is. */
function show(step, log, ok) {
  const lines = readFileSync(log, "utf8").split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const limit = ok ? 12 : 80;
  const where = relative(repo, log);
  const shown = lines.length > limit ? [`... ${lines.length - limit} lines above, all in ${where}`, ...lines.slice(-limit)] : lines;
  console.log([`\n=== ${step.name}: ${ok ? "pass" : "FAIL"}  (${clock()})  ${where}`, ...shown].join("\n"));
}

/** Runs one step, writing its log; resolves with whether it passed. */
async function launch(step, { built }) {
  console.log(`${clock()}  start  ${step.name}`);
  const log = join(logDir, `${step.id}.log`);
  const ctx = context(log);
  // A step that is done with app/dist before it ends says so in its log: from then on others
  // may build against it (the Tauri build is the first minute of the app smoke test).
  // [Refactored] Tighten `built` log poll from 1000 ms to 250 ms and skip re-reading when file size is unchanged.
  let lastSize = -1;
  const watch = step.built
    ? setInterval(() => {
        const size = statSync(log).size;
        if (size === lastSize) return;
        lastSize = size;
        if (!readFileSync(log, "utf8").includes(step.built)) return;
        clearInterval(watch);
        built();
      }, 250)
    : null;
  let ok;
  try {
    ok = (await step.run(ctx)) === true;
  } catch (e) {
    ctx.say(String(e?.stack ?? e));
    ok = false;
  } finally {
    clearInterval(watch);
    ctx.close();
  }
  show(step, log, ok);
  return ok;
}

/** A step that doesn't run fails, and says why in its log. */
function skip(step, why) {
  const log = join(logDir, `${step.id}.log`);
  writeFileSync(log, `${why}\n`);
  show(step, log, false);
}

// The queue between the gates of this repository on the machine, whichever worktree each is started in: it is in the
// main checkout. Commit gates run side by side (in different checkouts); a gate with any other step runs alone.
const queueDir = join(mainCheckout(), "target", "gate-queue");
const queued = !args.includes("--no-queue") && process.env.W3_GATE_QUEUE !== "0";
const exclusive = chosen.some((s) => s.tier !== "commit");
let queueEntry = null;

// Ctrl-C, a kill of the gate or its terminal closing ends the steps' processes too, and takes the gate out of the queue.
installSignalHandlers(liveChildren, (code) => {
  if (queueEntry) rmSync(queueEntry, { force: true });
  process.exit(code);
});

const readOrNull = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** `beside`: this gate's turn in the queue (the gates running beside it, and where to say what it may use), or null. */
async function runSteps(beside) {
  // The memory the running steps' estimates (`mem`) may add up to (tests/gate-lib.mjs memoryBudget). Read now, not
  // while this gate still waited; less what the gates beside this one may use.
  const budget = sharedBudget(memoryBudget({ read: readOrNull, freemem }), beside?.others() ?? []);
  beside?.claim(Math.min(budget.mb, chosen.reduce((n, s) => n + s.mem, 0)));
  console.log(`gate: memory budget ${budget.mb} MB (${budget.from}; set W3_GATE_MEM_MB to change)`);
  const onMemWait = (step, { used }) => console.log(`${clock()}  wait   ${step.name}: needs about ${step.mem} MB, ${used} of ${budget.mb} MB in use`);
  // Asked now, after the wait in the queue: the user may have started the game meanwhile.
  if (chosen.some((s) => s.id.startsWith("appsmoke"))) {
    gameBusy = gamePrefixBusy(processLines());
    if (gameBusy) console.log(`gate: SKIPPED (game running): ${PREFIX_CHECKS.join(", ")} of the app smoke test: ${gameBusy.slice(0, 120)}`);
  }
  const order = serial ? [...chosen].sort((a, b) => table.indexOf(a.id) - table.indexOf(b.id)) : chosen;
  await schedule({ steps: order, locks, serial, jobs, memBudget: budget.mb, onMemWait, launch, skip, done });
}

let started = Date.now();
if (queued) {
  await withGateQueue(queueDir, { repo, exclusive }, (m) => console.log(`gate: ${m}`), (beside) => {
    started = Date.now(); // the times count from the gate's own start, not from the wait
    return runSteps(beside);
  }, { onEntry: (file) => { queueEntry = file; } });
} else {
  await runSteps(null);
}

console.log(`\n--- gate: ${only ? `only ${chosen.map((s) => s.id).join(", ")} (not a tier: no gate result)` : tier}`);
for (const s of chosen) if (!done.has(s.id)) done.set(s.id, { ok: false, seconds: 0 }); // never ran: a failure, not a gap
const results = table.filter((id) => done.has(id)).map((id) => ({ name: steps.find((s) => s.id === id).name, ...done.get(id) }));
for (const r of results) console.log(`${r.ok ? "pass" : "FAIL"}  ${String(r.seconds).padStart(4)}s  ${r.name}`);
// A check that can't run fails (TESTING.md): green always means it ran. So the skipped ones count as failures, each named.
const skipped = gameBusy ? PREFIX_CHECKS : [];
for (const c of skipped) console.log(`SKIP  ${"".padStart(4)}   app smoke check ${c}: not run, the game or Battle.net runs in the game's prefix`);
const failed = results.filter((r) => !r.ok).length + skipped.length;
console.log(failed ? `${failed} of ${results.length + skipped.length} FAILED${skipped.length ? ` (${skipped.length} SKIPPED (game running): close Warcraft III and Battle.net, then run again)` : ""}` : `all ${results.length} passed`);
console.log(`total ${Math.round((Date.now() - started) / 1000)}s`);
const code = failed ? 1 : 0;
// Wine servers a run of ours left behind: reported, never killed (the prefix may be the user's).
for (const line of wineserverReport([repo, mainCheckout()])) console.log(line);
console.log(`GATE_EXIT=${code}`);
process.exitCode = code;
