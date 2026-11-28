// Makes src/builtin/terrain-viewer/meleereference.json: what check_melee's comparison holds a two-player map against.
// Every two-player melee map in the game's own storage ("Maps/…/(2)Name.w3x"; of a map kept in several versions the
// newest listed) is read out, unpacked and run through `w3proj check --only=melee --json`; its feature numbers
// (meleecheck.ts `features`) go into the reference as the lowest, the usual span, the median and the highest per
// feature (meleefeatures.ts referenceOf). Only those numbers are stored: no map, no name.
//
//   node scripts/melee-reference.mjs [--list] [--out FILE]
//
//   --list      print each map's features as it is measured
//   --out FILE  write there instead of the source file (to compare before replacing it)
//   --motifs-out FILE  where melee_motif's spans go (default: meleemotifs.json beside the reference)
//
// It also makes meleemotifs.json beside it: what the maps' camp pockets, naturals and shop clearings usually measure
// (meleemotifs.ts), again as spans only: no map, no patch of one.
//
// Needs the CLI (W3PROJ_BIN, else target/release, else target/debug of this checkout) and the installed game
// (W3PROJ_GAME, .game-path). A development tool: run it again when a feature is added or its measure changes.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gamePath } from "../../tests/gamepath.mjs";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? ".exe" : "";
const cli = process.env.W3PROJ_BIN ?? ["release", "debug"].map((p) => join(app, "..", "target", p, `w3proj${exe}`)).find(existsSync);
if (!cli || !existsSync(cli)) throw new Error("no w3proj CLI found: run cargo build first, or set W3PROJ_BIN");

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = (name) => { const i = args.indexOf(name); if (i < 0) return null; const [, v] = args.splice(i, 2); return v ?? null; };
const optMotifs = opt("--motifs-out");
const list = flag("--list"), out = opt("--out") ?? join(app, "src", "builtin", "terrain-viewer", "meleereference.json");
if (args.length) throw new Error(`unknown argument ${args[0]}`);

const game = gamePath();
// W3PROJ_MELEE_PLACES: the check also gives the measures of the map's camps, naturals and shops (headless/check.ts).
const env = { ...process.env, W3PROJ_GAME: game, W3PROJ_MELEE_PLACES: "1" };
const run = (argv) => execFileSync(cli, argv, { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"], env });

/** A map's name without what tells its versions apart: "(2)EchoIsles_S2_v2.2.w3x" and "(2)EchoIsles.w3x" are one map. */
export const mapKey = (path) => basename(path).replace(/\.w3[xm]$/i, "").replace(/_(lv|s\d+|v\d+(\.\d+)*)(?=_|$)/gi, "").replace(/[^a-z0-9]/gi, "").toLowerCase();

const stored = run(["game", "--install", game, "ls", "Maps/"]).toString("utf8").split(/\r?\n/)
  .filter((p) => /(^|[/:])Maps\//.test(p) && /\/\(2\)[^/]*\.w3[xm]$/i.test(p) && !/_Locales|_HD\.w3mod|_DE\.w3mod/i.test(p));
// The last listed of each (the season folders come after the plain ones).
const byKey = new Map(stored.map((p) => [mapKey(p), p]));

const { build } = await import("esbuild");
const cache = join(app, "..", "target", "w3proj-melee-reference");
mkdirSync(cache, { recursive: true });
const bundle = join(cache, `features-${process.pid}.mjs`);
await build({ stdin: { contents: `export { referenceOf } from "./src/builtin/terrain-viewer/meleefeatures"; export { motifOf } from "./src/builtin/terrain-viewer/meleemotifs";`, resolveDir: app, loader: "ts" }, bundle: true, format: "esm", platform: "node", outfile: bundle, logLevel: "warning" });
const { referenceOf, motifOf } = await import(pathToFileURL(bundle).href);
rmSync(bundle, { force: true });

const stamp = Math.floor(statSync(cli).mtimeMs);
const measured = [], places = {};
let failed = 0;
for (const [key, path] of [...byKey].sort()) {
  const dir = join(cache, `${key}-${stamp}`);
  try {
    if (!existsSync(join(dir, "w3proj.toml"))) {
      rmSync(dir, { recursive: true, force: true });
      const file = join(cache, `${key}.w3x`);
      writeFileSync(file, run(["game", "--install", game, "cat", path.replace(/^[^:]*:(?=Maps\/)/, "")]));
      run(["unpack", file, dir]);
      rmSync(file, { force: true });
    }
    // Exit 1 means findings, which the report still holds.
    let text;
    try { text = run(["check", dir, "--only=melee", "--json"]).toString("utf8"); } catch (e) { text = e.stdout?.toString("utf8") ?? ""; if (!text) throw e; }
    const report = JSON.parse(text), features = report.melee?.features;
    if (!features || !Object.keys(features).length) throw new Error("the check gave no features");
    measured.push(features);
    for (const [kind, list] of Object.entries(report.meleePlaces ?? {})) (places[kind] ??= []).push(...list);
    if (list) console.log(`${key}: ${JSON.stringify(features)}`);
  } catch (e) {
    failed++;
    console.error(`${key}: not measured (${String(e.message ?? e).split("\n")[0]})`);
  }
}
if (measured.length < 10) throw new Error(`only ${measured.length} maps were measured: no reference written`);
const reference = referenceOf(measured);
writeFileSync(out, `${JSON.stringify(reference, null, 2)}\n`);
console.log(`${measured.length} two-player maps measured${failed ? `, ${failed} not` : ""}; ${Object.keys(reference.features).length} features written to ${out}`);

// melee_motif's spans (meleemotifs.ts): what the camps, naturals and shops of these maps measure, per kind. Only the
// spans are written: a place whose middle is closed (room under 96) is left out.
const motifs = {};
for (const [kind, list] of Object.entries(places)) motifs[kind] = motifOf(list.filter((p) => p.room >= 96));
const motifsOut = optMotifs ?? join(dirname(out), "meleemotifs.json");
writeFileSync(motifsOut, `${JSON.stringify(motifs, null, 2)}\n`);
console.log(`${Object.entries(motifs).map(([k, m]) => `${m.places} ${k}`).join(", ")} measured; their spans written to ${motifsOut}`);
