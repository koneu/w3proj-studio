// Checks Studio's Melee-flag rule on save against the game's own maps: each map's war3map.w3i Melee flag is cleared and
// savedMelee (src/lib/terrain/meleesave.ts, what a save runs) decides whether it goes back on. The World Editor's save
// puts it back on a map that meets its rules, so a map stored with the flag on should get it back, one stored without
// it should not.
//
//   node scripts/melee-corpus.mjs [--filter TEXT] [--save FILE] [--baseline FILE] [--list] [--why]
//
//   --filter TEXT    the game's maps whose stored path contains TEXT (default "Maps/FrozenThrone")
//   --save FILE      write the per-map result as JSON (a baseline for a later run)
//   --baseline FILE  compare with a saved result: lists the maps whose result changed; exit 1 if an agreement was lost
//   --list           print every map's line, not only the summary and the misses
//   --why            with each miss, the reasons Studio leaves the flag off (meleeSetBlockers)
//
// Maps are read out of the game's storage with the release CLI and unpacked (cached in the temp folder). No map is
// changed. Needs the release CLI (`cargo build --release`, or W3PROJ_BIN) and the installed game (W3PROJ_GAME,
// .game-path). A development tool, like wpm-compare.mjs.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gamePath, mainCheckout } from "../../tests/gamepath.mjs";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? ".exe" : "";
const cli = process.env.W3PROJ_BIN ?? join(mainCheckout(app), "target", "release", `w3proj${exe}`);
if (!existsSync(cli)) throw new Error(`${cli} not found: run cargo build --release first`);

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); if (i < 0) return null; const [, v] = args.splice(i, 2); return v ?? null; };
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const filter = opt("--filter") ?? "Maps/FrozenThrone", saveTo = opt("--save"), baseFile = opt("--baseline"), listAll = flag("--list"), showWhy = flag("--why");
if (args.length) throw new Error(`unknown argument ${args[0]}`);

const game = gamePath();
const run = (argv, opts = {}) => execFileSync(cli, argv, { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"], ...opts });
const gameCat = (p) => run(["game", "--install", game, "cat", p.replace(/\\/g, "/")]);

const cache = join(tmpdir(), "w3proj-melee-corpus");
mkdirSync(cache, { recursive: true });
const { build } = await import("esbuild");
const bundle = join(cache, `melee-${process.pid}.mjs`);
await build({
  stdin: { contents: `export { meleeSetBlockers, readMeleeFacts, savedMelee } from "./src/lib/terrain/meleesave"; export { MELEE_MAP } from "./src/lib/terrain/owner";`, resolveDir: app, loader: "ts" },
  bundle: true, format: "esm", platform: "node", outfile: bundle, logLevel: "warning",
});
const { meleeSetBlockers, readMeleeFacts, savedMelee, MELEE_MAP } = await import(pathToFileURL(bundle).href);
rmSync(bundle, { force: true });

// The game's tables, read once.
const tables = new Map();
const gameText = async (p) => {
  if (!tables.has(p)) tables.set(p, gameCat(p).toString("utf8"));
  return tables.get(p);
};

const listed = run(["game", "--install", game, "ls", filter]).toString("utf8").split(/\r?\n/).filter((l) => /\.w3[xm]$/i.test(l));
const results = [];
for (const line of listed) {
  const stored = line.replace(/^[^:]*:/, "");
  const name = stored.replace(/^Maps\/FrozenThrone\//i, "");
  const dir = join(cache, stored.replace(/[^\w.()-]/g, "_"));
  if (!existsSync(join(dir, ".unpacked"))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const file = join(dir, stored.split("/").pop());
    try {
      writeFileSync(file, run(["game", "--install", game, "cat", line]));
      run(["unpack", file, join(dir, "p"), "--game", game]);
    } catch (e) { results.push({ name, skip: `unpack failed: ${String(e.stderr ?? e).trim().split("\n").pop()}` }); continue; }
    writeFileSync(join(dir, ".unpacked"), "");
  }
  const root = join(dir, "p");
  const walk = (d, sub = "") => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name), `${sub}${e.name}/`) : [`${sub}${e.name}`]);
  const files = walk(root).map((path) => ({ path }));
  const ws = {
    files: () => files,
    readText: async (p) => readFileSync(join(root, p), "utf8"),
    readBytes: async (p) => new Uint8Array(readFileSync(join(root, p))),
    gameText,
  };
  let info, placed;
  try {
    info = JSON.parse(readFileSync(join(root, "map", "war3map.w3i.json"), "utf8"));
    const units = join(root, "map", "war3mapUnits.doo.json");
    placed = existsSync(units) ? JSON.parse(readFileSync(units, "utf8")).units ?? [] : [];
  } catch (e) { results.push({ name, skip: `unreadable: ${e}` }); continue; }
  const melee = (Number(info.flags) & MELEE_MAP) !== 0;
  const cleared = { ...info, flags: Number(info.flags) & ~MELEE_MAP };
  const r = await savedMelee(ws, cleared, placed);
  const studio = (r.flags & MELEE_MAP) !== 0;
  const why = showWhy && melee !== studio ? meleeSetBlockers(cleared, placed, await readMeleeFacts(ws, undefined, true)) : [];
  // The other direction: a map stored melee must keep its flag through a save.
  const kept = !melee || (((await savedMelee(ws, info, placed)).flags & MELEE_MAP) !== 0);
  results.push({ name, melee, studio, why, kept });
}
results.sort((a, b) => a.name.localeCompare(b.name));

const done = results.filter((r) => !r.skip);
const meleeMaps = done.filter((r) => r.melee), other = done.filter((r) => !r.melee);
for (const r of results) {
  if (r.skip) console.log(`${r.name}: skipped, ${r.skip}`);
  else if (listAll || r.melee !== r.studio) console.log(`${r.name}: stored ${r.melee ? "melee" : "not melee"}, Studio ${r.studio ? "sets it" : "leaves it off"}${r.why.length ? `: ${r.why.join("; ")}` : ""}`);
}
console.log(`melee maps: Studio sets the flag on ${meleeMaps.filter((r) => r.studio).length} of ${meleeMaps.length}`);
const droppedOn = meleeMaps.filter((r) => !r.kept);
for (const r of droppedOn) console.log(`${r.name}: stored melee, a save would take the flag OFF`);
console.log(`melee maps: a save keeps the flag on ${meleeMaps.length - droppedOn.length} of ${meleeMaps.length} (should be all)`);
console.log(`other maps: Studio sets it on ${other.filter((r) => r.studio).length} of ${other.length} (should be 0)`);

const now = Object.fromEntries(done.map((r) => [r.name, { melee: r.melee, studio: r.studio }]));
if (saveTo) { writeFileSync(saveTo, JSON.stringify({ maps: now }, null, 1) + "\n"); console.log(`saved ${saveTo}`); }
let lost = 0;
if (baseFile) {
  const base = JSON.parse(readFileSync(baseFile, "utf8")).maps;
  for (const [name, r] of Object.entries(now)) {
    const b = base[name];
    if (!b || b.studio === r.studio) continue;
    const agrees = r.studio === r.melee;
    if (!agrees) lost++;
    console.log(`changed: ${name}: Studio ${b.studio ? "set" : "left off"} -> ${r.studio ? "sets" : "leaves off"} (${agrees ? "now agrees" : "agreement lost"})`);
  }
  console.log(`against ${baseFile}: ${lost} agreements lost`);
}
process.exit(lost ? 1 : 0);
