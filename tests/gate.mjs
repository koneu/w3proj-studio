// One command for every automatic check, with one honest answer. See TESTING.md.
//
//   node tests/gate.mjs            the commit gate: types, unit and system tests, clippy, UI smoke
//   node tests/gate.mjs coverage   the commit gate's tests, measured against tests/coverage-floor.json
//   node tests/gate.mjs corpus     real maps and the installed game (local only, some minutes)
//   node tests/gate.mjs all        all of the above
//
// Every step runs even after a failure, and the exit code is non-zero if any step failed or
// couldn't run. A check that is missing what it needs FAILS: a green result always means it ran.
//
// Needs for `coverage`: cargo-llvm-cov and the llvm-tools component.
// Needs for `corpus`: the maps (W3PROJ_CORPUS, default smoketest_maps next to the main checkout)
// and the game (W3PROJ_GAME, default the Warcraft III folder above it).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(repo, "app");
const exe = process.platform === "win32" ? ".exe" : "";

/** The main checkout, also from a git worktree: that's where the ignored maps are. */
function mainCheckout() {
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8" });
  return r.status === 0 ? dirname(resolve(repo, r.stdout.trim())) : repo;
}

const corpus = process.env.W3PROJ_CORPUS ?? join(mainCheckout(), "smoketest_maps");
const game = process.env.W3PROJ_GAME ?? dirname(mainCheckout());

/** Runs a command; its exit code decides. Output goes straight to the terminal. */
function shell(command, cwd = repo, env = {}) {
  return () => spawnSync(command, { cwd, shell: true, stdio: "inherit", env: { ...process.env, ...env } }).status === 0;
}

const needs = (path, what, check) => () => {
  if (!existsSync(path)) {
    console.error(`missing ${what}: ${path}`);
    return false;
  }
  return check();
};

/** Rust line coverage per crate, against the floors. */
function rustCoverage() {
  const out = join(repo, "target", "cov-rust.json");
  const measured = shell(`cargo llvm-cov --workspace --locked --json --summary-only --output-path "${out}"`)();
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
  for (const [crate, a] of Object.entries(areas)) {
    const percent = (100 * a.covered) / a.lines;
    const floor = all.rust[crate];
    console.log(`${crate.padEnd(8)} ${percent.toFixed(1).padStart(5)}%  ${a.covered} / ${a.lines}${floor === undefined ? "" : `  (floor ${floor}%)`}`);
    if (floor !== undefined && percent < floor) {
      console.error(`coverage of ${crate} fell below its floor`);
      ok = false;
    }
    if (process.argv.includes("--update-floor") && floor !== undefined) all.rust[crate] = Math.max(floor, Math.floor(percent * 10) / 10);
  }
  if (process.argv.includes("--update-floor")) writeFileSync(floorFile, JSON.stringify(all, null, 2) + "\n");
  return ok;
}

const commit = [
  ["types and module boundaries", shell("npm run --silent check", app)],
  ["TypeScript unit tests", shell("npm test --silent -- --test-reporter=dot", app)],
  ["Rust unit and system tests", shell("cargo test --workspace --locked --quiet")],
  ["clippy", shell("cargo clippy --workspace --all-targets --locked --quiet -- -D warnings")],
  ["UI smoke (headless)", shell("node scripts/ui-smoke.mjs --build", app)],
];
const coverage = [
  ["TypeScript coverage floors", shell(`npm run --silent coverage -- --check${process.argv.includes("--update-floor") ? " --update-floor" : ""}`, app)],
  ["Rust coverage floors", rustCoverage],
];
const bin = join(repo, "target", "release", `w3proj${exe}`);
const local = [
  ["release CLI", shell("cargo build --release --locked -p w3proj-cli")],
  ["hostile input, 20000 rounds", shell("cargo test --release -p w3proj --test robustness --locked --quiet", repo, { W3PROJ_ROBUSTNESS_ROUNDS: "20000" })],
  ["corpus round trip and codec baseline", needs(corpus, "the map corpus", shell(`"${bin}" verify -q "${corpus}" --baseline tests/corpus-baseline.tsv --game "${game}"`))],
  ["Rust and TypeScript codecs agree", needs(corpus, "the map corpus", shell(`node scripts/twin-check.mjs "${corpus}"`, app, { W3PROJ_GAME: game, W3PROJ_BIN: bin }))],
  ["the real app on a scratch project", shell("node scripts/app-smoke.mjs", app, { W3PROJ_BIN: bin })],
  ["generated scripts against the World Editor's", needs(join(game, ".build.info"), "the game", shell("node scripts/script-check/run.mjs", app, { W3PROJ_GAME: game, W3PROJ_BIN: bin }))],
];

const tiers = { commit, coverage, corpus: local, all: [...commit, ...coverage, ...local] };
const tier = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "commit";
if (!tiers[tier]) {
  console.error(`no tier "${tier}": ${Object.keys(tiers).join(", ")}`);
  process.exit(2);
}

const results = [];
for (const [name, step] of tiers[tier]) {
  console.log(`\n=== ${name}`);
  const started = Date.now();
  let ok = false;
  try {
    ok = step();
  } catch (e) {
    console.error(e);
  }
  results.push({ name, ok, seconds: Math.round((Date.now() - started) / 1000) });
}

console.log(`\n--- gate: ${tier}`);
for (const r of results) console.log(`${r.ok ? "pass" : "FAIL"}  ${String(r.seconds).padStart(4)}s  ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} of ${results.length} FAILED` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);
