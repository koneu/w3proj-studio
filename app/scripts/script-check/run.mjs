// Compares lib/script with the World Editor's own output on the game's maps, without any setup:
// extracts the maps and tables into target/script-check, runs the checks in this folder, and holds
// the results against tests/script-baseline.json (counts only, nothing of the game's).
//
//   node scripts/script-check/run.mjs [--update-baseline] [--fresh]
//
// W3PROJ_GAME is the install folder, W3PROJ_BIN the w3proj binary (default target/release). The
// extraction is kept until the game's build changes or --fresh is given.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeSections, mergeValid, printSections, printValid } from "./report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..", "..");
const repo = resolve(app, "..");
const game = process.env.W3PROJ_GAME;
const bin = process.env.W3PROJ_BIN ?? join(repo, "target", "release", `w3proj${process.platform === "win32" ? ".exe" : ""}`);
const work = join(repo, "target", "script-check");
const baselineFile = join(repo, "tests", "script-baseline.json");
const gameArgs = game ? ["--install", game] : [];
const update = process.argv.includes("--update-baseline");

function run(args) {
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr || r.error}`);
  return r.stdout;
}

/** `game cat` into a file: the bytes have to stay as they are. */
function extract(path, file) {
  const fd = openSync(file, "w");
  const r = spawnSync(bin, ["game", ...gameArgs, "cat", path], { stdio: ["ignore", fd, "pipe"] });
  closeSync(fd);
  if (r.status !== 0) throw new Error(`can't read ${path}: ${r.stderr}`);
}

function waitFor(args) {
  return new Promise((done) => {
    const p = spawn(bin, args, { stdio: "ignore" });
    p.on("error", () => done(1));
    p.on("close", done);
  });
}

const root = "War3.w3mod:";

/** The game's tables: cheap, so they're always read. */
function readTables() {
  for (const [path, file] of [
    ["UI/TriggerData.txt", "TriggerData.txt"], ["UI/WorldEditData.txt", "WorldEditData.txt"],
    ["Units/UnitBalance.slk", "UnitBalance.slk"], ["Units/ItemData.slk", "ItemData.slk"], ["Units/AbilityData.slk", "AbilityData.slk"], ["Units/unitUI.slk", "unitUI.slk"],
    ["Scripts/common.j", "common.j"], ["Scripts/Blizzard.j", "Blizzard.j"],
  ]) extract(root + path, join(work, file));
}

async function prepare() {
  mkdirSync(work, { recursive: true });
  const build = run(["game", ...gameArgs, "info"]);
  const stamp = join(work, "game-build.txt");
  if (!process.argv.includes("--fresh") && existsSync(stamp) && readFileSync(stamp, "utf8") === build) return;
  console.log("extracting the game's maps and tables (a few minutes, once per game build)");
  rmSync(work, { recursive: true, force: true });
  for (const d of ["abil", "soundinfo", "ws", "maps"]) mkdirSync(join(work, d), { recursive: true });

  const list = (filter) => run(["game", ...gameArgs, "ls", filter]).split(/\r?\n/).filter((l) => l.startsWith(root));
  for (const p of list("AbilityFunc.txt")) if (!p.includes("_Balance")) extract(p, join(work, "abil", p.split("/").pop()));
  for (const p of list("UI/SoundInfo/")) if (p.endsWith(".slk")) extract(p, join(work, "soundinfo", p.split("/").pop()));

  // Without the game's TriggerData, so the trigger files stay the World Editor's bytes.
  const maps = list(".w3x").filter((p) => p.toLowerCase().endsWith(".w3x"));
  const queue = maps.map((p) => ({ path: p, name: p.slice(root.length).replace(/\.w3x$/i, "").replace(/[^\w.-]+/g, "_") }));
  let failed = 0;
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const file = join(work, "maps", `${m.name}.w3x`);
      extract(m.path, file);
      if (await waitFor(["unpack", file, join(work, "ws", m.name), "--game", "none", "--allow-incomplete"])) failed++;
      rmSync(file);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(`${maps.length} maps unpacked, ${failed} couldn't be`);
  writeFileSync(stamp, build);
}

/**
 * A check in the extraction folder; it writes what it measured as JSON. With `shards` above 1 the
 * maps are split into that many runs of maps, one process each (SCRIPT_CHECK_SHARD), and the
 * details come back in the order of the shards, that is of the maps. What a shard prints on stderr
 * is shown in that order too, its stdout only with `echo` (for a check that doesn't go by maps).
 */
async function check(script, shards, echo, ...args) {
  const runs = Array.from({ length: shards }, (_, i) => {
    const out = join(work, `${script}.${i}.json`);
    rmSync(out, { force: true });
    return new Promise((done) => {
      const p = spawn(process.execPath, ["--no-warnings", "--experimental-transform-types", "--import", new URL("./tsregister.mjs", import.meta.url).href, join(here, script), join(app, "src", "lib"), ...args], {
        cwd: work, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SCRIPT_CHECK_JSON: out, SCRIPT_CHECK_SHARD: `${i}/${shards}` },
      });
      let stdout = "", stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("error", (e) => done({ out, status: 1, stdout, stderr: stderr + e }));
      p.on("close", (status) => done({ out, status, stdout, stderr }));
    });
  });
  const results = await Promise.all(runs);
  // Shown later, by the caller, so that the report doesn't depend on which check ends first.
  const shown = () => {
    for (const r of results) {
      if (echo) process.stdout.write(r.stdout);
      process.stderr.write(r.stderr);
    }
  };
  if (results.some((r) => r.status !== 0 || !existsSync(r.out))) {
    shown();
    throw new Error(`${script} failed`);
  }
  return { details: results.map((r) => JSON.parse(readFileSync(r.out, "utf8"))), shown };
}

await prepare();
readTables();
const cores = availableParallelism();
const shards = Number(process.env.SCRIPT_CHECK_SHARDS) || Math.max(1, Math.min(8, cores >> 1));
// The three checks run side by side; the report below is in a fixed order whichever ends first.
const [sectionRuns, validRuns, mistakeRuns] = await Promise.all([
  check("sections.mts", shards, false, "", "0"),
  check("jass-valid.mts", shards, false, "0"),
  check("jass-mistakes.mts", 1, true),
]);
const sections = mergeSections(sectionRuns.details);
const valid = mergeValid(validRuns.details);
const [mistakes] = mistakeRuns.details;
sectionRuns.shown();
printSections(sections);
validRuns.shown();
printValid(valid, { heads: true });
mistakeRuns.shown();
const measured = {
  sections: { identical: sections.stats, problems: sections.broken.length, guarded: sections.guarded.length, checked: sections.checked },
  valid: { common: valid.common, blizzard: valid.blizzard, maps: valid.maps, clean: valid.clean, reports: valid.reports },
  mistakes,
};

if (update) {
  writeFileSync(baselineFile, JSON.stringify(measured, null, 2) + "\n");
  console.log(`wrote ${baselineFile}`);
  process.exit(0);
}

// A count may get better, never worse: identical and clean counts rise, the rest stay at or below.
const base = JSON.parse(readFileSync(baselineFile, "utf8"));
const problems = [];
const better = [];
const atLeast = (name, got, want) => {
  if (got < want) problems.push(`${name}: ${got}, was ${want}`);
  else if (got > want) better.push(`${name}: ${got}, was ${want}`);
};
const atMost = (name, got, want) => {
  if (got > want) problems.push(`${name}: ${got}, was ${want}`);
  else if (got < want) better.push(`${name}: ${got}, was ${want}`);
};
for (const [k, [ok, n]] of Object.entries(base.sections.identical)) {
  const got = measured.sections.identical[k];
  if (!got) { problems.push(`${k || "(header)"}: not measured any more`); continue; }
  if (got[1] !== n) problems.push(`${k || "(header)"}: ${got[1]} maps compared, was ${n}`);
  atLeast(k || "(header)", got[0], ok);
}
atMost("problems reported on the game's maps", measured.sections.problems, base.sections.problems);
atMost("maps the guard would keep", measured.sections.guarded, base.sections.guarded);
atMost("reports on common.j", measured.valid.common, base.valid.common);
atMost("reports on Blizzard.j", measured.valid.blizzard, base.valid.blizzard);
atMost("reports on valid maps", measured.valid.reports, base.valid.reports);
if (measured.valid.maps !== base.valid.maps) problems.push(`${measured.valid.maps} maps checked, was ${base.valid.maps}`);
atMost("mistakes the checker misses", measured.mistakes.missed, 0);
atMost("correct code the checker rejects", measured.mistakes.falseAlarms, 0);

for (const b of better) console.log(`better: ${b}`);
for (const p of problems) console.error(`WORSE: ${p}`);
if (better.length && !problems.length) console.log("improved: run with --update-baseline to keep it");
console.log(problems.length ? `script check: ${problems.length} got worse` : "script check: nothing got worse");
process.exit(problems.length ? 1 : 0);
