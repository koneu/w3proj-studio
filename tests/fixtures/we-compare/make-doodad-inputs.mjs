// Makes the input maps of the doodad specs in tests/we-compare/ from p6's map X (verification round 3, 212 doodads:
// the 200 of doodad-save-rules plus 12 odd angles, scale ranges and off-grid pathing doodads):
//
//   node tests/fixtures/we-compare/make-doodad-inputs.mjs <X.w3x> <w3proj cli> <game folder> <out folder>
//
// writes flag-bits.w3x, scale-one-axis.w3x, scale-turned-range.w3x (a few doodads each, in X's map) and
// reopen-base.w3x (X without the 8 doodads where the two editors differ on purpose: LTt0 and the destructable angles).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [xMap, cli, game, outDir] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
if (!outDir) { console.error("usage: make-doodad-inputs.mjs <X.w3x> <w3proj cli> <game folder> <out folder>"); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const scratch = mkdtempSync(join(tmpdir(), "we-compare-inputs-"));
try {
  const make = (name, edit) => {
    const dir = join(scratch, name);
    run("unpack", xMap, dir, "--game", game);
    const file = join(dir, "map", "war3map.doo.json");
    const doo = JSON.parse(readFileSync(file, "utf8"));
    doo.doodads = edit(doo.doodads);
    writeFileSync(file, JSON.stringify(doo, null, 2));
    run("pack", dir, "-o", join(outDir, `${name}.w3x`), "--force-stale");
  };
  const doodad = (id, x, y, scale, flags, n) => ({
    id, variation: 0, position: [x, y, 0], angle: 0, scale, skinId: id, preFlags: 4294967295, flags,
    life: ["LTbr", "LTcr", "LTt0"].includes(id) ? 100 : 255, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [n, 0, 0], extras: [],
  });
  // A row of doodads: `cases` is [scale or flags], x steps of 256 from -2976, y per row.
  const rows = (list) => list.map((d, i) => doodad(d.id, d.x ?? -2976 + 256 * (i % 20), d.y ?? 2700 - 256 * Math.floor(i / 20), d.scale ?? [1, 1, 1], d.flags ?? 2, i));

  // Item "flag bits above 4": inside the playable area (x -3328..3328, y -3584..3072) and outside it (x 3360).
  const flagValues = [0x08, 0x10, 0x20, 0x40, 0x80, 0x0e, 0x1e, 0x7e, 0xfe, 0xff, 0xf8, 0x88];
  make("flag-bits", () => rows([
    ...["LTbr", "LOch", "LTcr"].flatMap((id) => flagValues.map((flags) => ({ id, flags }))),
    ...["LTbr", "LOch"].flatMap((id, k) => flagValues.slice(0, 8).map((flags, i) => ({ id, flags, x: 3360 + 64 * (k % 2), y: -2976 + 256 * i }))),
  ]));

  // Item "a scale with only one axis at 0" (LTbr 1.1..1.5, LTcr 0.8..1.2, LOch 0.8..1.2: from saverules-cases.txt).
  const axes = [[0, 1, 1], [1, 0, 1], [1, 1, 0], [0, 0, 1], [0, 1.3, 1.3], [1.3, 0, 0], [1, 0, 0], [0, 0, 0.9]];
  make("scale-one-axis", () => rows(["LTbr", "LTcr", "LOch"].flatMap((id) => axes.map((scale) => ({ id, scale })))));

  // Item "a 0 scale of a type with a turned range": LTt0's range is 1 to 0.8 (min above max). References in range and out.
  const turned = [[0, 0, 0], [0, 1, 1], [0, 0.9, 0.9], [1, 0, 1], [1, 1, 0], [0.9, 0.9, 0.9], [1, 1, 1], [0.8, 0.8, 0.8], [0.5, 0.5, 0.5], [2, 2, 2]];
  make("scale-turned-range", () => rows(turned.map((scale) => ({ id: "LTt0", scale }))));

  // The two doodad items "a map saved by Studio ... opens in the World Editor": everything of X the editors agree on.
  // (indices 200 to 207 of X: LTt0 x4, then LTbr x4 at angles -90, -270, 450, 720.)
  make("reopen-base", (all) => all.filter((d, i) => i < 200 || i > 207));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
