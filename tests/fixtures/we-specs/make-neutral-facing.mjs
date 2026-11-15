// Makes neutral-facing.w3x for the building facing spec (tests/we-compare/neutral-facing.json) from flat.w3x (the World
// Editor's own new 64x64 Lordaeron Summer map):
//
//   node tests/fixtures/we-specs/make-neutral-facing.mjs <w3proj cli> <game folder>
//
// Gold mines (ngol), taverns (ntav) and goblin merchants (ngme) of Neutral Passive, Player 1's barracks (hbar) and a
// footman (hfoo) as the control, each at the angles 0, 0.5, 90 degrees, 3.0 and 5.5 radians and the whole number 2.0,
// on their building grid near the middle of the map (the editor's opening view). Fields as the editor places them.
// "neg": neutral-facing-neg.w3x, the mine, the barracks and the footman at negative, whole and out-of-range angles.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2, 4).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-neutral-facing.mjs <w3proj cli> <game folder> [neg]"); process.exit(2); }
const neg = process.argv[4] === "neg";
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};

const TYPES = neg ? [["ngol", 27], ["hbar", 0], ["hfoo", 0]] : [["ngol", 27], ["ntav", 27], ["ngme", 27], ["hbar", 0], ["hfoo", 0]];
const ANGLES = neg ? [-1, -2, -0.5, -2.0725150108337402, -90, 400, 7, 1, 6.5, 360] : [0, 0.5, Math.PI / 2, 3.0, 5.5, 2.0];
const STEP = neg ? 384 : 512;

const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  const dir = join(scratch, "neutral");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const file = join(dir, "map", "war3mapUnits.doo.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const template = doc.units[0];
  let n = 1;
  TYPES.forEach(([id, player], row) => ANGLES.forEach((a, col) => {
    doc.units.push({
      ...template, id, skinId: id, position: [-1280 - (neg ? 448 : 0) + col * STEP, -1024 + row * STEP, 0], angle: Math.fround(a), player,
      hp: -1, mana: -1, level: 1, gold: id === "ngol" ? 12500 : 0, targetAcquisition: -1, editorId: n++, trailer: [0, 0],
    });
  }));
  writeFileSync(file, JSON.stringify(doc, null, 2));
  run("pack", dir, "-o", join(here, neg ? "neutral-facing-neg.w3x" : "neutral-facing.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
