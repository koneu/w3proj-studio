// Makes minimap-dots.w3x and minimap-dots-zoom.w3x from flat.w3x (Lordaeron Summer, ground Lgrs everywhere), for reading how
// the World Editor's minimap draws a doodad whose pathing texture is one full square:
//
//   node tests/fixtures/we-specs/make-minimap-dots.mjs <w3proj cli> <game folder>
//
// dots: the whole map is the playable area (camera complements 0: 64 x 64 tiles, 4 pixels a tile at 256). Block 0 is LRrk
//   (a rock, pathing 4x4 = one tile), block 1 LSeb (6x6), block 2 LSrg (8x8). Inside a block the doodads are 5 tiles apart,
//   and the i-th column and j-th row are moved by i and j quarters of a pixel (8 units; a pixel is 32), so the 16 dots of
//   a block show every sub-pixel position of the centre against the pixel grid.
// zoom: the same with the playable area 32 x 32 tiles (complements 16: 8 pixels a tile, a pixel is 16 units), blocks LRrk
//   and LSrg, 4 tiles apart, quarters of a pixel being 4 units.
// All at angle 270 degrees, scale 1, no trees.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2, 4).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
if (!game) { console.error("usage: make-minimap-dots.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const N = 65;
/** The two maps: the margin in tiles on every side, the doodad types of the blocks, their origin, spacing and quarter of a pixel. */
const MAPS = {
  "minimap-dots": { margin: 0, types: ["LRrk", "LSeb", "LSrg"], origin: (t) => [-4096 + 256 + t * 2688, -4096 + 2048], step: 640, quarter: 8 },
  "minimap-dots-zoom": { margin: 16, types: ["LRrk", "LSrg"], origin: (t) => [-1792 + t * 2048, -1536], step: 512, quarter: 4, stepY: 768 },
  // Other kinds: a tree (destructable LTlt, its own minimap colour, 4x4), a 12x12 doodad, 8x6 and 4x6 (not full squares),
  // one with no pathing texture, a 4x4 vineyard. Two columns by two rows each (quarters of a pixel), three blocks a row.
  "minimap-dots-more": { margin: 0, types: ["LTlt", "LZth", "LSgr", "LSst", "LSpl", "VSvb"], origin: (t) => [-3840 + (t % 3) * 2688, -3584 + Math.floor(t / 3) * 2688], step: 640, quarter: 8, cols: 2, rows: 2 },
};

for (const [name, m] of Object.entries(MAPS)) {
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
  try {
    const dir = join(scratch, "map");
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    const file = join(dir, "map", "war3map.w3e.txt");
    const lines = readFileSync(file, "utf8").split("\n");
    // The corners' map-edge bits as flat.w3x has them (row 0, the north edge, 0; then the margin rows 1; a margin of 1s
    // at each side of the rows between, the last column 0), for this margin.
    const bits = lines.findIndex((l) => l.startsWith("[water-bits]"));
    const rows = Array.from({ length: N }, (_, r) => {
      if (m.margin === 0 || r === 0) return "0".repeat(N);
      if (r <= m.margin || r > N - 1 - m.margin) return "1".repeat(N - 1) + "0";
      return Array.from({ length: N }, (_, c) => (c < m.margin || (c >= N - 1 - m.margin && c < N - 1) ? "1" : "0")).join("");
    });
    lines.splice(bits + 1, N, ...rows);
    const at = lines.findIndex((l) => l.startsWith("[texture]"));
    lines.splice(at, 1, "[texture]", ...Array.from({ length: N }, () => "4".repeat(N)));
    writeFileSync(file, lines.join("\n"));
    const w3i = join(dir, "map", "war3map.w3i.json");
    const info = JSON.parse(readFileSync(w3i, "utf8"));
    const edge = m.margin * 128;
    info.cameraComplements = [m.margin, m.margin, m.margin, m.margin];
    info.playableWidth = 64 - 2 * m.margin;
    info.playableHeight = 64 - 2 * m.margin;
    // The camera bounds: the playable area, 4 tiles further in on three sides (flat.w3x: 4 tiles at left, right and top, none at the bottom).
    info.cameraBounds = [-4096 + edge + 512, -4096 + edge, 4096 - edge - 512, 4096 - edge - 512, -4096 + edge + 512, 4096 - edge - 512, 4096 - edge - 512, -4096 + edge];
    writeFileSync(w3i, JSON.stringify(info, null, 2));
    const doo = join(dir, "map", "war3map.doo.json");
    const json = JSON.parse(readFileSync(doo, "utf8"));
    let n = 0;
    m.types.forEach((id, t) => {
      const [ox, oy] = m.origin(t);
      for (let j = 0; j < (m.rows ?? 4); j++) {
        for (let i = 0; i < (m.cols ?? 4); i++) {
          const x = ox + i * m.step + i * m.quarter, y = oy + j * (m.stepY ?? m.step) + j * m.quarter;
          json.doodads.push({ id, variation: 0, position: [x, y, 0], angle: 4.712389, scale: [1, 1, 1], skinId: id, preFlags: 4294967295, flags: 2, life: 100, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [n & 255, (n >> 8) & 255, 0], extras: [] });
          n++;
        }
      }
    });
    writeFileSync(doo, JSON.stringify(json, null, 2));
    run("pack", dir, "-o", join(here, `${name}.w3x`), "--force-stale");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
