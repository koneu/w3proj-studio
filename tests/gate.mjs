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
// test only needs it for its first minute, the build, and says so in its log). A
// step whose `after` step failed fails without running. Each step writes its output to its own
// log under target/gate-logs/<tier>-<pid>/ and the gate prints it, or its tail, when the step ends.
//
// Needs for `coverage`: cargo-llvm-cov and the llvm-tools component.
// Needs for `corpus`: the maps (W3PROJ_CORPUS, default smoketest_maps next to the main checkout)
// and the game (W3PROJ_GAME, default the Warcraft III folder above it).

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const game = process.env.W3PROJ_GAME ?? dirname(mainCheckout());

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- locks -----------------------------------------------------------------------------------

/** Named locks, shared ("r": many at once) or exclusive ("w"). */
class Locks {
  state = new Map();
  waiting = [];
  can(name, mode) {
    const s = this.state.get(name) ?? { r: 0, w: false };
    return mode === "w" ? !s.w && s.r === 0 : !s.w;
  }
  take(name, mode) {
    const s = this.state.get(name) ?? { r: 0, w: false };
    if (mode === "w") s.w = true;
    else s.r++;
    this.state.set(name, s);
  }
  release(name, mode) {
    const s = this.state.get(name);
    if (mode === "w") s.w = false;
    else s.r--;
    this.waiting = this.waiting.filter((go) => !go());
    this.onRelease?.();
  }
  /** Waits for the lock, runs `body` holding it. First come, first served among those waiting. */
  async hold(name, mode, body) {
    await new Promise((granted) => {
      const go = () => {
        if (!this.can(name, mode)) return false;
        this.take(name, mode);
        granted();
        return true;
      };
      if (!go()) this.waiting.push(go);
    });
    try {
      return await body();
    } finally {
      this.release(name, mode);
    }
  }
}
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

/** Rust line coverage per crate, against the floors. */
async function rustCoverage(ctx) {
  const out = join(repo, "target", "cov-rust.json");
  const measured = await ctx.sh(`cargo llvm-cov --workspace --locked --json --summary-only --output-path "${out}"`);
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
    ctx.say(readFileSync(list, "utf8").split("\n").filter((l) => !l.startsWith("{")).join("\n"));
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
const hasGame = join(game, ".build.info");
const update = args.includes("--update-floor") ? " --update-floor" : "";

// Steps, in the order they are started when they can be. `weight`: about how many cores it keeps
// busy. `tier`: the tiers it belongs to. The table at the end is in the order of `table`.
const steps = [
  { id: "cli", name: "release CLI", tier: "corpus", weight: 6, locks: [["cargo", "w"]], run: shell("cargo build --release --locked -p w3proj-cli") },
  { id: "appsmoke", name: "the real app on a scratch project", tier: "corpus", weight: 4, after: ["cli"], locks: [["dist", "w"]], built: "Built application at", run: shell("node scripts/app-smoke.mjs", { cwd: app, env: { W3PROJ_BIN: bin } }) },
  { id: "corpus", name: "corpus round trip and codec baseline", tier: "corpus", weight: 10, after: ["cli"], run: needs(corpus, "the map corpus", shell(`"${bin}" verify -q "${corpus}" --baseline tests/corpus-baseline.tsv --game "${game}"`)) },
  { id: "hostile", name: "hostile input, 20000 rounds", tier: "corpus", weight: 10, run: hostileRounds },
  { id: "seeds", name: "hostile input on the game's own files", tier: "corpus", weight: 2, after: ["cli"], run: needs(hasGame, "the game", shell("node scripts/hostile-seeds.mjs", { cwd: app, env: { W3PROJ_GAME: game, W3PROJ_BIN: bin } })) },
  { id: "script", name: "generated scripts against the World Editor's", tier: "corpus", weight: 8, after: ["cli"], run: needs(hasGame, "the game", shell("node scripts/script-check/run.mjs", { cwd: app, env: { W3PROJ_GAME: game, W3PROJ_BIN: bin } })) },
  { id: "twin", name: "Rust and TypeScript codecs agree", tier: "corpus", weight: 2, after: ["cli"], run: needs(corpus, "the map corpus", shell(`node scripts/twin-check.mjs "${corpus}"`, { cwd: app, env: { W3PROJ_GAME: game, W3PROJ_BIN: bin } })) },
  { id: "rustcov", name: "Rust coverage floors", tier: "coverage", weight: 8, after: ["appsmoke#built"], locks: [["dist", "r"]], run: rustCoverage },
  { id: "rust", name: "Rust unit and system tests", tier: "commit", weight: 4, after: ["appsmoke#built"], locks: [["cargo", "w"], ["dist", "r"]], run: shell("cargo test --workspace --locked --quiet") },
  { id: "clippy", name: "clippy", tier: "commit", weight: 4, after: ["appsmoke#built"], locks: [["cargo", "w"], ["dist", "r"]], run: shell("cargo clippy --workspace --all-targets --locked --quiet -- -D warnings") },
  { id: "ui", name: "UI smoke (headless)", tier: "commit", weight: 2, after: ["appsmoke#built"], locks: [["dist", "w"]], run: shell("node scripts/ui-smoke.mjs --build", { cwd: app }) },
  { id: "tsc", name: "types and module boundaries", tier: "commit", weight: 2, run: shell("npm run --silent check", { cwd: app }) },
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

function runAll() {
  const order = serial ? [...chosen].sort((a, b) => table.indexOf(a.id) - table.indexOf(b.id)) : chosen;
  const waiting = [...order];
  let busy = 0;
  let running = 0;
  return new Promise((finish) => {
    locks.onRelease = () => pump();
    function pump() {
      for (const step of [...waiting]) {
        const deps = (step.after ?? []).filter((id) => chosen.some((s) => s.id === id.split("#")[0]));
        if (deps.some((id) => !done.has(id))) continue;
        const log = join(logDir, `${step.id}.log`);
        if (deps.some((id) => !done.get(id).ok)) {
          waiting.splice(waiting.indexOf(step), 1);
          writeFileSync(log, `not run: ${deps.filter((id) => !done.get(id).ok).join(", ")} failed\n`);
          show(step, log, false);
          done.set(step.id, { ok: false, seconds: 0 });
          continue;
        }
        const held = [...(step.locks ?? [])];
        const fits = running === 0 || (!serial && busy + step.weight <= jobs);
        if (!fits || !held.every(([name, mode]) => locks.can(name, mode))) continue;
        waiting.splice(waiting.indexOf(step), 1);
        for (const [name, mode] of held) locks.take(name, mode);
        busy += step.weight;
        running++;
        console.log(`${clock()}  start  ${step.name}`);
        const t0 = Date.now();
        const ctx = context(log);
        // A step that is done with app/dist before it ends says so in its log: from then on others
        // may build against it (the Tauri build is the first minute of the app smoke test).
        const built = step.built
          ? setInterval(() => {
              if (!readFileSync(log, "utf8").includes(step.built)) return;
              clearInterval(built);
              done.set(`${step.id}#built`, { ok: true, seconds: 0 });
              for (const [name, mode] of held.splice(0)) locks.release(name, mode);
              pump();
            }, 1000)
          : null;
        Promise.resolve()
          .then(() => step.run(ctx))
          .catch((e) => {
            ctx.say(String(e?.stack ?? e));
            return false;
          })
          .then((ok) => {
            clearInterval(built);
            ctx.close();
            if (step.built && !done.has(`${step.id}#built`)) done.set(`${step.id}#built`, { ok: true, seconds: 0 });
            busy -= step.weight;
            running--;
            show(step, log, ok === true);
            done.set(step.id, { ok: ok === true, seconds: Math.round((Date.now() - t0) / 1000) });
            for (const [name, mode] of held) locks.release(name, mode);
            pump();
          });
      }
      if (!waiting.length && running === 0) finish();
    }
    pump();
  });
}

await runAll();

console.log(`\n--- gate: ${tier}`);
const results = table.filter((id) => done.has(id)).map((id) => ({ name: steps.find((s) => s.id === id).name, ...done.get(id) }));
for (const r of results) console.log(`${r.ok ? "pass" : "FAIL"}  ${String(r.seconds).padStart(4)}s  ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} of ${results.length} FAILED` : `all ${results.length} passed`);
console.log(`total ${Math.round((Date.now() - started) / 1000)}s`);
const code = failed ? 1 : 0;
console.log(`GATE_EXIT=${code}`);
process.exitCode = code;
