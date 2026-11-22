// The light a model's real shadow keeps on HD water, by depth, in the World Editor and in Studio: the measurement
// behind renderer.ts WATER_SHADE / waterShadowKeep, repeatable (Linux, local: it runs the World Editor through
// we-drive; never the game).
//
//   node scripts/water-shadows.mjs [--steps maps,we,studio,measure] [--out DIR] [--pairs 8:70,12:80,…] [--frames N]
//                                  [--slot N] [--app BIN] [--no-build]
//
// maps     make-water-shadows.mjs per pair of depths (shallow lake : deep lake), trees scaled 2 in each lake, no
//          units (their shadows move): water-shadows-d<S>-D<D>-T-s2-U.w3x in <out>/maps
// we       one we-drive run (HD, gpu, game view off) per 8 maps: per map and lake, a --look at the lake's tree, then
//          --frames pictures 0.7 s apart with View > Shadows on and as many with it off (the camera stays: only the
//          menu item changes), <out>/pics/we-<pair>-<on|off>-<s|d>-<k>.png
// studio   app-drive per map (graphicsMode hd, --compare-ready lit, the same cameras through we:, grid and minimap off,
//          terrain.shadows.visible on and off), <out>/pics/st-…
// measure  shadow-keep.mjs over each lake's region (the tree's shadow on the water, the tree left out) of the mean of the
//          frames: one JSON line per pair, lake and program ({ depth, program, pixels, kept: [r, g, b] }), then a table
//          of green and blue. Red isn't readable (little of it in water, the editor's bed brighter).
//
// The waves move between frames and the editor's blue comes mostly from the sky's reflection on them: one frame on
// against one off scatters by up to 0.25 in blue in shallow water (2026-11-22), the means over 4 frames hold.
// Default --out: target/water-shadows-round of this checkout. Needs the release CLI (target/release/w3proj) and the
// game (W3PROJ_GAME / .game-path).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gamePath } from "../../tests/gamepath.mjs";
import { decodePng } from "./pic-compare.mjs";
import { shadowKeep } from "./shadow-keep.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : fallback; };
const flag = (name) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const steps = new Set(opt("--steps", "maps,we,studio,measure").split(","));
const out = resolve(opt("--out", join(repo, "target", "water-shadows-round")));
const pairs = opt("--pairs", "8:70,12:80,20:100,30:130,45:200,60:300").split(",").map((p) => p.split(":").map(Number));
const frames = Number(opt("--frames", "4"));
const slot = opt("--slot", "1"), appBin = opt("--app"), noBuild = flag("--no-build");
if (args.length || pairs.some(([s, d]) => !(s >= 1 && s <= 60 && d >= 61 && d <= 400)) || !(frames >= 1 && frames <= 8)) {
  console.error("usage: water-shadows.mjs [--steps maps,we,studio,measure] [--out DIR] [--pairs S:D,…] [--frames 1-8] [--slot N] [--app BIN] [--no-build]");
  process.exit(2);
}

/** The two lakes: the camera (we-drive --look) and, per program, the region of the tree's shadow on the water (x, y,
 *  w, h in the 1184x844 view, right of the tree, which isn't in it). The shadows lie at the same pixels in both
 *  (2026-11-22; Studio's trees are drawn about 25 px higher). */
const LAKES = {
  s: { look: "-256,256,2000", region: { we: [488, 280, 160, 170], st: [488, 280, 160, 170] } },
  d: { look: "1408,256,2000", region: { we: [658, 275, 100, 175], st: [658, 275, 100, 175] } },
};
const name = ([s, d]) => `d${s}-D${d}`;
const mapFile = (p) => join(out, "maps", `water-shadows-${name(p)}-T-s2-U.w3x`);
const pic = (program, p, state, lake, k) => join(out, "pics", `${program}-${name(p)}-${state}-${lake}-${k}.png`);
const run = (cmd, a, opts = {}) => {
  const r = spawnSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${a.slice(0, 3).join(" ")}…: exit ${r.status}\n${(r.stderr || "").slice(-2000)}${(r.stdout || "").slice(-2000)}`);
  return r.stdout;
};
mkdirSync(join(out, "pics"), { recursive: true });

if (steps.has("maps")) {
  const cli = join(repo, "target", "release", process.platform === "win32" ? "w3proj.exe" : "w3proj");
  for (const [s, d] of pairs) {
    run(process.execPath, [join(repo, "tests", "fixtures", "we-specs", "make-water-shadows.mjs"), cli, gamePath(here), join(out, "maps"),
      "--depth", String(s), "--deep", String(d), "--lake-trees", "--lake-tree-scale", "2", "--no-units"]);
  }
  console.log(JSON.stringify({ step: "maps", made: pairs.map(mapFile) }));
}

const shots = (program, p, state, lake) => Array.from({ length: frames }, (_, k) => pic(program, p, state, lake, k));

if (steps.has("we")) {
  // 2 looks a map, at most 16 in a we-drive run
  for (let i = 0; i < pairs.length; i += 8) {
    const a = ["--slot", slot, "--mode", "hd", "--renderer", "gpu", "--looks-every-map", "--timeout", "2400"];
    for (const p of pairs.slice(i, i + 8)) {
      a.push("--map", mapFile(p), "--compare-ready", "--close-modules", "--game-view", "off", "--view", "Shadows=on");
      for (const [lake, { look }] of Object.entries(LAKES)) {
        a.push("--look", look);
        for (const state of ["on", "off"]) {
          if (state === "off") a.push("--view", "Shadows=off", "--sleep", "500");
          shots("we", p, state, lake).forEach((f, k) => a.push(...(k ? ["--sleep", "700"] : []), "--shot", f));
        }
        a.push("--view", "Shadows=on", "--sleep", "500");
      }
    }
    a.push("--close");
    run(process.execPath, [join(here, "we-drive.mjs"), ...a], { timeout: 3000_000 });
    console.log(JSON.stringify({ step: "we", maps: pairs.slice(i, i + 8).map(name) }));
  }
}

if (steps.has("studio")) {
  const set = (v) => `w3.settings.set("terrain.shadows.visible", ${v})`;
  for (const p of pairs) {
    const a = [...(noBuild || appBin ? ["--no-build"] : []), ...(appBin ? ["--app", appBin] : []), "--work", join(out, "app-drive"),
      "--set", 'terrain.grid.default="none"', "--set", "terrain.minimap.panel=false", "--set", 'game.graphicsMode="hd"',
      "--map", mapFile(p), "--terrain", "--view-size", "1184x844", "--compare-ready", "lit"];
    for (const [lake, { look }] of Object.entries(LAKES)) {
      a.push("--camera", `we:${look}`, "--settle");
      for (const state of ["on", "off"]) {
        a.push("--eval", set(state === "on"), "--settle");
        shots("st", p, state, lake).forEach((f, k) => a.push(...(k ? ["--sleep", "700"] : []), "--shot", f));
      }
    }
    run(process.execPath, [join(here, "app-drive.mjs"), ...a], { timeout: 1500_000, env: { ...process.env, W3_SMOKE_ID: process.env.W3_SMOKE_ID ?? "dev.w3proj.studio.smoke.water-shadows" } });
    console.log(JSON.stringify({ step: "studio", map: name(p) }));
  }
}

if (steps.has("measure")) {
  const rows = [];
  for (const p of pairs) for (const [lake, { region }] of Object.entries(LAKES)) for (const program of ["we", "st"]) {
    const load = (state) => shots(program, p, state, lake).filter(existsSync).map((f) => decodePng(readFileSync(f)));
    const on = load("on"), off = load("off");
    if (!on.length || !off.length) continue;
    const depth = lake === "s" ? p[0] : p[1];
    const r = { depth, program, ...shadowKeep(on, off, region[program]) };
    rows.push(r);
    console.log(JSON.stringify(r));
  }
  const byDepth = new Map();
  for (const r of rows) byDepth.set(r.depth, { ...byDepth.get(r.depth), [r.program]: r.kept });
  const f = (k) => (k ? `${k[1].toFixed(3)} ${k[2].toFixed(3)}` : "  -     -  ");
  console.log("depth  editor G/B    Studio G/B");
  for (const [depth, v] of [...byDepth].sort((a, b) => a[0] - b[0])) console.log(`${String(depth).padStart(5)}  ${f(v.we)}   ${f(v.st)}`);
}
