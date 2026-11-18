// Makes the maps for finding which of SnowareBay's dead tree walls (205 NTtw at life 0) the World Editor's Export
// Minimap draws (76 of them on the map itself), by changing one thing at a time on the map with only those doodads:
//
//   node tests/fixtures/we-specs/make-tree-walls.mjs <w3proj cli> <game folder> <SnowareBay .w3x> [out folder] [name]
//
// The out folder is target/tree-walls of the checkout by default. Maps (all with the 205 NTtw only; no units):
//   tw-orig      the ground as it is
//   tw-flat5     height 0, cliff level 2, no cliffs, texture slot 5 (snow) everywhere
//   tw-flat0     the same with slot 0
//   tw-flat-only the textures as they are, height 0, level 2, no cliffs
//   tw-tex5-only height and cliffs as they are, slot 5 everywhere
//   tw-alive     the ground as it is, the walls' life 100
//   tw-spread    the ground as it is, the walls moved 640 apart in a grid on the flat snow (no neighbours)
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game, source, outArg] = process.argv.slice(2, 6).map((p) => (p ? resolve(p) : p));
const only = process.argv[6];
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!source) { console.error("usage: make-tree-walls.mjs <w3proj cli> <game folder> <SnowareBay .w3x> [out folder] [name]"); process.exit(2); }
const outDir = outArg || resolve(here, "..", "..", "..", "target", "tree-walls");
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};

/** Sections of the w3e text that are replaced by `rows` (the text has one row per line, a section ends at a blank line). */
function replaceSections(text, sections) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[([a-z-]+)\]/.exec(lines[i]);
    if (m && m[1] in sections) {
      out.push(`[${m[1]}]`, ...sections[m[1]]);
      while (i + 1 < lines.length && lines[i + 1] !== "" && !lines[i + 1].startsWith("[")) i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

const MAPS = {
  "tw-orig": {},
  "tw-flat5": { flat: true, texture: "5" },
  "tw-flat0": { flat: true, texture: "0" },
  "tw-flat-only": { flat: true },
  "tw-tex5-only": { texture: "5" },
  "tw-alive": { life: 100 },
  "tw-spread": { spread: true },
};

const scratch = mkdtempSync(join(tmpdir(), "we-specs-tree-walls-"));
try {
  mkdirSync(outDir, { recursive: true });
  for (const [name, how] of Object.entries(MAPS)) {
    if (only && only !== name) continue;
    const dir = join(scratch, name);
    run("unpack", source, dir, "--game", game);
    const w3e = join(dir, "map", "war3map.w3e.txt");
    let text = readFileSync(w3e, "utf8");
    const corners = Number(/^corners (\d+)/m.exec(text)?.[1]);
    if (!corners) throw new Error("no corner count in the w3e text");
    const uniform = (cell) => Array.from({ length: corners }, () => String(cell).repeat(corners));
    const sections = {};
    if (how.flat) {
      sections.height = Array.from({ length: corners }, () => `0*${corners}`);
      sections.layer = uniform("2");
      sections["cliff-texture"] = uniform("f");
    }
    if (how.texture) sections.texture = uniform(how.texture);
    text = replaceSections(text, sections);
    writeFileSync(w3e, text);

    const dooFile = join(dir, "map", "war3map.doo.json");
    const doo = JSON.parse(readFileSync(dooFile, "utf8"));
    doo.doodads = doo.doodads.filter((o) => o.id === "NTtw");
    if (how.life !== undefined) for (const o of doo.doodads) o.life = how.life;
    if (how.spread) {
      // a 15 x 14 grid over the map, 640 apart: no wall has another within 640 (the ground is whatever it is there)
      doo.doodads.forEach((o, k) => { o.position = [-4480 + (k % 15) * 640, -4480 + Math.floor(k / 15) * 640, o.position[2]]; });
    }
    writeFileSync(dooFile, JSON.stringify(doo, null, 2));
    const unitsFile = join(dir, "map", "war3mapUnits.doo.json");
    const units = JSON.parse(readFileSync(unitsFile, "utf8"));
    units.units = [];
    writeFileSync(unitsFile, JSON.stringify(units, null, 2));
    run("pack", dir, "-o", join(outDir, `${name}.w3x`), "--force-stale");
    console.log(`made ${join(outDir, `${name}.w3x`)}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
