// One command for every automatic check, with one honest answer. See TESTING.md.
//
//   node tests/gate.mjs            the commit gate: types, unit and system tests, clippy, UI smoke
//   node tests/gate.mjs coverage   the commit gate's tests, measured against tests/coverage-floor.json
//   node tests/gate.mjs corpus     real maps and the installed game (local only, some minutes)
//   node tests/gate.mjs all        all of the above
//
//   --serial       one step at a time, in the order of the table (to compare, or to read one log)
//   --jobs=<n>     how many cores' worth of steps run together (default: twice the cores)
//   --update-floor raise the coverage floors to what was measured
//
// Every step runs even after a failure, and the exit code is non-zero if any step failed or
// couldn't run. A check that is missing what it needs FAILS: a green result always means it ran.
// The last line is GATE_EXIT=<code>, also when the output went through a pipe.
//
// Steps that don't need each other run side by side. What one needs from another is written down
// as `after` (the release CLI before everything that runs it) and as locks, held for the whole
// step: "cargo" (one cargo command in the target folder at a time), "dist" (app/dist is read by
// every build of the Tauri crate, and rebuilt by the smoke tests: they take turns; the app smoke
// test only needs it for its first minute, the build, and says so in its log). Steps queue for a
// lock in the order they became ready, so a step waiting for "dist" alone isn't passed by later
// readers (tests/gate-scheduler.mjs, tested in app/scripts/gate-scheduler.test.mjs). A
// step whose `after` step failed fails without running. Each step writes its output to its own
// log under target/gate-logs/<tier>-<pid>/ and the gate prints it, or its tail, when the step ends.
//
// Needs for `coverage`: cargo-llvm-cov and the llvm-tools component.
// Needs for `corpus`: the maps (W3PROJ_CORPUS, default smoketest_maps next to the main checkout)
// and the game (W3PROJ_GAME, else the folder in `.game-path`, else the Warcraft III folder above it:
// tests/gamepath.mjs).

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Locks, schedule } from "./gate-scheduler.mjs";
import { gamePath } from "./gamepath.mjs";

// An older Node (a system one on Linux, when nvm's isn't loaded in this shell) fails steps in ways that look like
// bugs (no WebSocket global, unknown test flags): say so instead, before anything runs.
if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error(`the gate needs Node 22 or newer; this is ${process.version} (${process.execPath}). On Linux: source ~/.nvm/nvm.sh`);
  console.log("GATE_EXIT=1");
  process.exit(1);
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(repo, "app");
const exe = process.platform === "win32" ? ".exe" : "";
const args = process.argv.slice(2);

/** The main checkout, also from a git worktree: that's where the ignored maps are. */
function mainCheckout() {
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8" });
  return r.status === 0 ? dirname(resolve(repo, r.stdout.trim())) : repo;
}

const corpus = process.env.W3PROJ_CORPUS ?? join(mainCheckout(), "smoketest_maps");
const game = gamePath(repo);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- locks -----------------------------------------------------------------------------------

/** The locks between this gate's steps (tests/gate-scheduler.mjs). */
const locks = new Locks();

/** The owner written into a lock folder, or null while there is none (being made, or left half made). */
function lockOwner(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function ageMs(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * A lock between gates running at once, also from different worktrees: a folder that exists while
 * it is held, with the owner's process in it. A folder left by a process that is gone is taken over.
 */
async function withFileLock(dir, say, body) {
  const owner = join(dir, "owner.json");
  let told = 0;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(owner, JSON.stringify({ pid: process.pid, repo, since: new Date().toISOString() }));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const held = lockOwner(owner);
      // Stale: its process is gone, or it never got an owner (a gate killed between the two
      // steps above) and is older than a moment.
      const stale = held ? !alive(held.pid) : ageMs(dir) > 10000;
      if (stale) {
        // Taken over by renaming it away first: of two gates that both see it stale only one can
        // rename it, and a gate that took the lock in between isn't swept away (its owner is checked
        // once more right before the rename).
        const again = lockOwner(owner);
        if (again ? alive(again.pid) || again.pid !== held?.pid : held || ageMs(dir) <= 10000) continue;
        const gone = `${dir}.stale-${process.pid}-${Date.now()}`;
        try {
          renameSync(dir, gone);
        } catch {
          continue;
        }
        say(held ? `took over the lock of ${held.repo} (process ${held.pid} is gone)` : `took over a lock without an owner: ${dir}`);
        rmSync(gone, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - told > 30000) {
        say(`waiting for ${held ? `the gate of ${held.repo} (process ${held.pid}, since ${held.since})` : "another gate"}: ${dir}`);
        told = Date.now();
      }
      await sleep(1000);
    }
  }
  try {
    return await body();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
      return new Promise((done) => {
        const out = stdout ? openSync(stdout, "w") : fd;
        const child = spawn(command, { cwd, shell: true, stdio: ["ignore", out, fd], env: { ...process.env, ...env } });
        child.on("error", (e) => {
          write(String(e));
          done(false);
        });
        child.on("close", (code) => {
          if (stdout) closeSync(out);
          done(code === 0);
        });
      });
    },
    close: () => closeSync(fd),
  };
}

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
  const measured = await withFileLock(`${covTarget}.lock`, (m) => { ctx.say(m); console.log(`   Rust coverage: ${m}`); }, () =>
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
  let ok = true;
  const updating = args.includes("--update-floor");
  for (const [crate, a] of Object.entries(areas)) {
    const percent = (100 * a.covered) / a.lines;
    const floor = all.rust[crate];
    ctx.say(`${crate.padEnd(8)} ${percent.toFixed(1).padStart(5)}%  ${a.covered} / ${a.lines}${floor === undefined ? "" : `  (floor ${floor}%)`}`);
    if (floor !== undefined && percent < floor) {
      ctx.say(`coverage of ${crate} fell below its floor`);
      ok = false;
    }
    if (updating && floor !== undefined) all.rust[crate] = Math.max(floor, Math.floor(percent * 10) / 10);
  }
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
  const built = await locks.hold("cargo", "w", () => ctx.sh("cargo test --release -p w3proj --test robustness --locked --no-run --message-format=json", { stdout: list }));
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
const hasGame = join(game, ".build.info");
const update = args.includes("--update-floor") ? " --update-floor" : "";

// Steps, in the order they are started when they can be. `weight`: about how many cores it keeps
// busy. `tier`: the tiers it belongs to. The table at the end is in the order of `table`.
const steps = [
  { id: "cli", name: "release CLI", tier: "corpus", weight: 6, locks: [["cargo", "w"]], run: shell("cargo build --release --locked -p w3proj-cli") },
  { id: "appsmoke", name: "the real app on a scratch project", tier: "corpus", weight: 4, after: ["cli"], locks: [["dist", "w"]], built: "Built application at", run: shell("node scripts/app-smoke.mjs", { cwd: app, env: { W3PROJ_GAME: game, W3PROJ_BIN: bin, W3_SMOKE_ID: smokeId } }) },
  { id: "corpus", name: "corpus round trip and codec baseline", tier: "corpus", weight: 10, after: ["cli"], run: needs(corpus, "the map corpus", shell(`"${bin}" verify -q "${corpus}" --baseline tests/corpus-baseline.tsv --game "${game}"`)) },
  { id: "hostile", name: "hostile input, 20000 rounds", tier: "corpus", weight: 10, run: hostileRounds },
  { id: "seeds", name: "hostile input on the game's own files", tier: "corpus", weight: 2, after: ["cli"], run: needs(hasGame, "the game", shell("node scripts/hostile-seeds.mjs", { cwd: app, env: { W3PROJ_GAME: game, W3PROJ_BIN: bin } })) },
  { id: "script", name: "generated scripts against the World Editor's", tier: "corpus", weight: 8, after: ["cli"], run: needs(hasGame, "the game", shell("node scripts/script-check/run.mjs", { cwd: app, env: { W3PROJ_GAME: game, W3PROJ_BIN: bin } })) },
  { id: "twin", name: "Rust and TypeScript codecs agree", tier: "corpus", weight: 2, after: ["cli"], run: needs(corpus, "the map corpus", shell(`node scripts/twin-check.mjs "${corpus}"`, { cwd: app, env: { W3PROJ_GAME: game, W3PROJ_BIN: bin } })) },
  { id: "rustcov", name: "Rust coverage floors", tier: "coverage", weight: 8, after: ["appsmoke#built"], locks: [["dist", "r"]], run: rustCoverage },
  { id: "rust", name: "Rust unit and system tests", tier: "commit", weight: 4, after: ["appsmoke#built"], locks: [["cargo", "w"], ["dist", "r"]], run: shell("cargo test --workspace --locked --quiet") },
  { id: "clippy", name: "clippy", tier: "commit", weight: 4, after: ["appsmoke#built"], locks: [["cargo", "w"], ["dist", "r"]], run: shell("cargo clippy --workspace --all-targets --locked --quiet -- -D warnings") },
  { id: "ui", name: "UI smoke (headless)", tier: "commit", weight: 2, after: ["appsmoke#built"], locks: [["dist", "w"]], run: shell("node scripts/ui-smoke.mjs --build", { cwd: app }) },
  { id: "tsc", name: "types, module boundaries, scripts load", tier: "commit", weight: 2, run: shell("npm run --silent check", { cwd: app }) },
  { id: "tstest", name: "TypeScript unit tests", tier: "commit", weight: 2, run: shell("npm test --silent -- --test-reporter=dot", { cwd: app }) },
  { id: "tscov", name: "TypeScript coverage floors", tier: "coverage", weight: 3, run: shell(`npm run --silent coverage -- --check${update}`, { cwd: app }) },
];
// The table: the order the steps always had.
const table = ["tsc", "tstest", "rust", "clippy", "ui", "tscov", "rustcov", "cli", "hostile", "seeds", "corpus", "twin", "appsmoke", "script"];

const tiers = {
  commit: ["commit"],
  coverage: ["coverage"],
  corpus: ["corpus"],
  all: ["commit", "coverage", "corpus"],
};
const tier = args.find((a) => !a.startsWith("--")) ?? "commit";
if (!tiers[tier]) {
  console.error(`no tier "${tier}": ${Object.keys(tiers).join(", ")}`);
  process.exit(2);
}
const chosen = steps.filter((s) => tiers[tier].includes(s.tier));
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
mkdirSync(logDir, { recursive: true });

// ---- scheduling ------------------------------------------------------------------------------

const done = new Map();
const started = Date.now();
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
  const watch = step.built
    ? setInterval(() => {
        if (!readFileSync(log, "utf8").includes(step.built)) return;
        clearInterval(watch);
        built();
      }, 1000)
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

const order = serial ? [...chosen].sort((a, b) => table.indexOf(a.id) - table.indexOf(b.id)) : chosen;
await schedule({ steps: order, locks, serial, jobs, launch, skip, done });

console.log(`\n--- gate: ${tier}`);
const results = table.filter((id) => done.has(id)).map((id) => ({ name: steps.find((s) => s.id === id).name, ...done.get(id) }));
for (const r of results) console.log(`${r.ok ? "pass" : "FAIL"}  ${String(r.seconds).padStart(4)}s  ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} of ${results.length} FAILED` : `all ${results.length} passed`);
console.log(`total ${Math.round((Date.now() - started) / 1000)}s`);
const code = failed ? 1 : 0;
console.log(`GATE_EXIT=${code}`);
process.exitCode = code;
