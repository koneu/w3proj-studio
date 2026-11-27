// Makes minimap-dots.w3x, minimap-dots-zoom.w3x and minimap-dots-more.w3x from flat.w3x (Lordaeron Summer, ground Lgrs everywhere), for reading how
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
/** The two maps: the margin in tiles on every side, the doodad types of the blocks, their origin, spacing and quarter of a pixel. */
const MAPS = {
  "minimap-dots": { margin: 0, types: ["LRrk", "LSeb", "LSrg"], origin: (t) => [-4096 + 256 + t * 2688, -4096 + 2048], step: 640, quarter: 8 },
  "minimap-dots-zoom": { margin: 16, types: ["LRrk", "LSrg"], origin: (t) => [-1792 + t * 2048, -1536], step: 512, quarter: 4, stepY: 768 },
  // Other kinds: a tree (destructable LTlt, its own minimap colour, 4x4), a 12x12 doodad, 8x6 and 4x6 (not full squares),
  // one with no pathing texture, a 4x4 vineyard. Two columns by two rows each (quarters of a pixel), three blocks a row.
  // A 128 x 128 map, no margin: 2 pixels a tile at 256 (a pixel is 64 units), the scale of real maps. Two rows of four blocks.
  "minimap-dots-128": { size: 128, margin: 0, types: ["LRrk", "LSeb", "LSrg", "LZth", "LSgr", "LSst", "LSpl", "VSvb"], origin: (t) => [-7680 + (t % 4) * 3840, -7680 + Math.floor(t / 4) * 3840], step: 640, quarter: 16 },
  // Sweeps: 4 types, each in two lines (the x offset grows by 4 units a doodad along the first, the y offset along the second),
  // 30 doodads 4 tiles apart (128 tiles: 2 pixels a tile) or, 64 tiles, 16 doodads 4 tiles apart at 8 units (4 pixels a tile).
  "minimap-dots-sweep": { size: 128, margin: 0, types: ["LRrk", "LSeb", "LSrg", "LZth"], sweep: { count: 30, tiles: 4, unit: 4, lineTiles: 14 } },
  "minimap-dots-sweep64": { size: 64, margin: 0, types: ["LRrk", "LSeb", "LSrg", "LZth"], sweep: { count: 15, tiles: 4, unit: 8, lineTiles: 7 } },
  // The offset from the tile corner in both axes at once: 8 x 8 doodads a type, 16 units (an eighth of a tile) more each way.
  "minimap-dots-grid": { size: 128, margin: 0, types: ["LRrk", "LSeb", "LSrg"], grid: { n: 8, tiles: 4, unit: 16 } },
  "minimap-dots-more": { margin: 0, types: ["LTlt", "LZth", "LSgr", "LSst", "LSpl", "VSvb"], origin: (t) => [-3840 + (t % 3) * 2688, -3584 + Math.floor(t / 3) * 2688], step: 640, quarter: 8, cols: 2, rows: 2 },
  // The dot colour of the doodad types whose model gives it (`models`), and the dot at angles other than 270 degrees (`angles`).
  "minimap-dots-models": { size: 64, margin: 0, models: true },
  // The same for the destructables (DestructableData.slk: crates, barrels, boxes, rubble, the Barrens skulls; 21 types).
  "minimap-dots-dests": { size: 64, margin: 0, models: true, table: "Units\\DestructableData.slk" },
  "minimap-dots-angles": { size: 64, margin: 0, types: ["LSgr", "LSst", "LZth", "LSrg", "LSeb"], angles: true },
  // Around the angles where the footprint turns (45, 135, 225, 315 degrees), and others: 8x6 and 4x6 pathing.
  "minimap-dots-angles-fine": { size: 64, margin: 0, types: ["LSgr", "LSst"], angleList: [40, 42, 44, 45, 46, 48, 50, 130, 132, 134, 135, 136, 138, 140, 220, 222, 224, 225, 226, 228, 230, 310, 312, 314, 315, 316, 318, 320, 0, 90, 180, 270, 360, -45, -90, 405] },
};

for (const [name, m] of Object.entries(MAPS)) {
  if (process.argv[4] && process.argv[4] !== name) continue; // optional 3rd argument: just this map
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
  try {
    const dir = join(scratch, "map");
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
    if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
    const SIZE = m.size ?? 64, N = SIZE + 1, half = SIZE * 64;
    const file = join(dir, "map", "war3map.w3e.txt");
    let lines = readFileSync(file, "utf8").split("\n");
    if (SIZE !== 64) {
      // The other sections become "all" lines (a blank map, as flat.w3x is): rows of the old size would not fit.
      const all = { height: "0", water: "0", variation: "0", "cliff-variation": "0", "cliff-texture": "f", layer: "2", flags: "0" };
      const kept = [];
      for (let i = 0; i < lines.length; i++) {
        const tag = /^\[([a-z-]+)\]/.exec(lines[i])?.[1];
        if (tag && tag in all) {
          kept.push(`[${tag}] all ${all[tag]}`);
          while (i + 1 < lines.length && lines[i + 1] !== "" && !lines[i + 1].startsWith("[")) i++;
        } else kept.push(lines[i]);
      }
      lines = kept;
    }
    // The corners' map-edge bits as flat.w3x has them (row 0, the north edge, 0; then the margin rows 1; a margin of 1s
    // at each side of the rows between, the last column 0), for this margin.
    const bits = lines.findIndex((l) => l.startsWith("[water-bits]"));
    if (bits < 0) throw new Error("no [water-bits] section in the w3e text");
    const rows = Array.from({ length: N }, (_, r) => {
      if (m.margin === 0 || r === 0) return "0".repeat(N);
      if (r <= m.margin || r > N - 1 - m.margin) return "1".repeat(N - 1) + "0";
      return Array.from({ length: N }, (_, c) => (c < m.margin || (c >= N - 1 - m.margin && c < N - 1) ? "1" : "0")).join("");
    });
    lines.splice(bits + 1, 65, ...rows); // flat.w3x has 65 rows
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("corners ")) lines[i] = `corners ${N} ${N}`;
      else if (lines[i].startsWith("offset ")) lines[i] = `offset ${-half} ${-half}`;
    }
    const at = lines.findIndex((l) => l.startsWith("[texture]"));
    if (at < 0) throw new Error("no [texture] section in the w3e text");
    lines.splice(at, 1, "[texture]", ...Array.from({ length: N }, () => "4".repeat(N)));
    writeFileSync(file, lines.join("\n"));
    const w3i = join(dir, "map", "war3map.w3i.json");
    const info = JSON.parse(readFileSync(w3i, "utf8"));
    const edge = m.margin * 128;
    info.cameraComplements = [m.margin, m.margin, m.margin, m.margin];
    info.playableWidth = SIZE - 2 * m.margin;
    info.playableHeight = SIZE - 2 * m.margin;
    // The camera bounds: the playable area, 4 tiles further in on three sides (flat.w3x: 4 tiles at left, right and top, none at the bottom).
    info.cameraBounds = [-half + edge + 512, -half + edge, half - edge - 512, half - edge - 512, -half + edge + 512, half - edge - 512, half - edge - 512, -half + edge];
    if (SIZE !== 64) {
      // The pathing map and the shadow map at the new size, all clear.
      const wpm = Buffer.alloc(16 + SIZE * 4 * SIZE * 4, 0x40);
      wpm.write("MP3W", 0, "latin1");
      wpm.writeUInt32LE(0, 4);
      wpm.writeUInt32LE(SIZE * 4, 8);
      wpm.writeUInt32LE(SIZE * 4, 12);
      writeFileSync(join(dir, "map", "war3map.wpm"), wpm);
      writeFileSync(join(dir, "map", "war3map.shd"), Buffer.alloc(SIZE * 4 * SIZE * 4));
    }
    writeFileSync(w3i, JSON.stringify(info, null, 2));
    const doo = join(dir, "map", "war3map.doo.json");
    const json = JSON.parse(readFileSync(doo, "utf8"));
    /** Where each doodad goes: a grid of blocks per type, or (`sweep`) lines of doodads whose offset from a tile corner grows. */
    const spots = [];
    if (m.grid) {
      // A block per type of n x n doodads `tiles` apart, the offset from a tile corner growing by `unit` units along both axes.
      const g = m.grid;
      m.types.forEach((id, t) => {
        for (let j = 0; j < g.n; j++) {
          for (let i = 0; i < g.n; i++) spots.push({ id, x: -half + (4 + t * g.n * g.tiles + i * g.tiles) * 128 + i * g.unit, y: -half + (6 + j * g.tiles) * 128 + j * g.unit });
        }
      });
    } else if (m.sweep) {
      // Line k of each type (x sweep: the x offset grows along the line, y sweep: the y offset), `count` doodads a line, `tiles`
      // apart, offset `unit` units more each; lines `lineTiles` apart.
      const s = m.sweep;
      let line = 0;
      for (const id of m.types) {
        for (const axis of ["x", "y"]) {
          for (let k = 0; k < s.count; k++) {
            const off = k * s.unit;
            spots.push({ id, x: -half + (4 + k * s.tiles) * 128 + (axis === "x" ? off : 0), y: -half + (6 + line * s.lineTiles) * 128 + (axis === "y" ? off : 0) });
          }
          line++;
        }
      }
    } else if (m.models) {
      // One doodad of every type whose dot colour comes from its model (showInMM 1, useMMColor not 1) and whose pathing
      // texture is none or a square of at most 8x8, in rows of 14, 4 tiles apart, at a tile corner (a tile's middle for
      // "none": its dot is the tile it stands in). "id path" lines go to <name>.txt, in order, for reading the pictures.
      const slk = spawnSync(cli, ["game", "slk", m.table ?? "Doodads\\Doodads.slk"], { encoding: "utf8", env: { ...process.env, W3PROJ_GAME: game } });
      if (slk.status !== 0) throw new Error(`w3proj game slk: ${slk.stderr}`);
      const [head, ...body] = slk.stdout.split("\n").filter(Boolean).map((l) => l.split("\t"));
      const col = (n) => head.indexOf(n);
      const ok = /^(none|PathTextures\\(2x2|4x4|6x6|8x8)Default\.tga)$/;
      const ids = body.filter((r) => r[col("showInMM")] === "1" && r[col("useMMColor")] !== "1" && ok.test(r[col("pathTex")])).map((r) => [r[0], r[col("pathTex")]]).sort();
      ids.slice(0, 14 * 14).forEach(([id, path], n) => {
        const half64 = path === "none" ? 64 : 0;
        spots.push({ id, x: -half + (4 + (n % 14) * 4) * 128 + half64, y: -half + (4 + Math.floor(n / 14) * 4) * 128 + half64 });
      });
      writeFileSync(join(here, `${name}.txt`), ids.slice(0, 14 * 14).map(([id, path]) => `${id} ${path}`).join("\n") + "\n");
    } else if (m.angleList) {
      // The angles of `angleList` (degrees), 12 to a row, one row of them per type at a tile's middle, 5 tiles apart.
      const rad = (d) => (d * Math.PI) / 180;
      m.types.forEach((id, t) => m.angleList.forEach((d, c) => spots.push({ id, angle: rad(d), x: -half + (4 + (c % 12) * 5) * 128 + 64, y: -half + (4 + (t * 3 + Math.floor(c / 12)) * 5) * 128 + 64 })));
    } else if (m.angles) {
      // Each type at angles 0, 15 ... 165 degrees (a footprint is symmetric under 180), 5 tiles apart in a row, two rows per
      // type: at a tile corner and at a tile's middle. Row 10 and 11: the angles 195 ... 345 of the second type (symmetry check).
      const rad = (d) => (d * Math.PI) / 180;
      m.types.forEach((id, t) => {
        for (const [r, off] of [[0, 0], [1, 64]]) {
          for (let c = 0; c < 12; c++) spots.push({ id, angle: rad(c * 15), x: -half + (4 + c * 5) * 128 + off, y: -half + (4 + (t * 2 + r) * 5) * 128 + off });
        }
      });
      for (let c = 0; c < 12; c++) spots.push({ id: m.types[0], angle: rad(180 + c * 15), x: -half + (4 + c * 5) * 128, y: -half + (4 + m.types.length * 2 * 5) * 128 });
    } else {
      m.types.forEach((id, t) => {
        const [ox, oy] = m.origin(t);
        for (let j = 0; j < (m.rows ?? 4); j++) {
          for (let i = 0; i < (m.cols ?? 4); i++) spots.push({ id, x: ox + i * m.step + i * m.quarter, y: oy + j * (m.stepY ?? m.step) + j * m.quarter });
        }
      });
    }
    spots.forEach(({ id, x, y, angle }, n) => {
      json.doodads.push({ id, variation: 0, position: [x, y, 0], angle: angle ?? 4.712389, scale: [1, 1, 1], skinId: id, preFlags: 4294967295, flags: 2, life: 100, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [n & 255, (n >> 8) & 255, 0], extras: [] });
    });
    writeFileSync(doo, JSON.stringify(json, null, 2));
    run("pack", "--keep-objects", dir, "-o", join(here, `${name}.w3x`), "--force-stale");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
