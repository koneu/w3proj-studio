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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** A check in the extraction folder; it writes what it measured as JSON. */
function check(script, ...args) {
  const out = join(work, `${script}.json`);
  rmSync(out, { force: true });
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-transform-types", "--import", new URL("./tsregister.mjs", import.meta.url).href, join(here, script), join(app, "src", "lib"), ...args], {
    cwd: work, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, SCRIPT_CHECK_JSON: out },
  });
  if (r.status !== 0 || !existsSync(out)) throw new Error(`${script} failed`);
  return JSON.parse(readFileSync(out, "utf8"));
}

await prepare();
readTables();
const measured = {
  sections: check("sections.mts", "", "0"),
  valid: check("jass-valid.mts", "0"),
  mistakes: check("jass-mistakes.mts"),
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
