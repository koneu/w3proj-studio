// What check_melee and check_path walk on (meleefacts.ts): the grid from pathing, what stands in the way and painted
// Boundary; and the saved project's source (w3proj check) telling a placement file that is absent from one that is
// there but can't be read.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { NO_WALK } from "../../lib/terrain/pathing";
import { parseW3e } from "../../lib/terrain/w3e";
import { w3eFromText } from "../../lib/terrain/w3etext";
import { pathReport, projectWalkSource, walkGrid, type WalkSource } from "./meleefacts";

/** The mini map's map/ folder, found from where the tests run (app/ or the repository). */
function fixture(name: string): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const p = join(dir, "tests", "fixtures", "mini-map", "map", name);
    if (existsSync(p)) return readFileSync(p, "utf8");
    if (dirname(dir) === dir) throw new Error("tests/fixtures/mini-map not found");
  }
}
const terrainText = fixture("war3map.w3e.txt");

/** The mini map's ground (5 × 3 corners: 4 × 2 tiles, 16 × 8 pathing cells) with these cells of pathing and blockers. */
function source(blockedCells: number[], standing: number[], list: WalkSource["list"] = () => []): WalkSource {
  const terrain = parseW3e(w3eFromText(terrainText));
  const width = (terrain.width - 1) * 4, height = (terrain.height - 1) * 4;
  return {
    terrain,
    pathing: async () => { const cells = new Uint8Array(width * height); for (const i of blockedCells) cells[i] = NO_WALK; return { cells, width, height }; },
    blockers: async () => { const b = new Uint8Array(width * height); for (const i of standing) b[i] = 1; return b; },
    list, baseOf: () => undefined,
  };
}

test("the grid blocks what the pathing map blocks and what stands there; the rest is open", async () => {
  const g = await walkGrid(source([3], [20]));
  assert.equal(g.width, 16);
  assert.equal(g.blocked[3], 1, "pathing");
  assert.equal(g.blocked[20], 1, "a doodad standing there");
  assert.equal(g.blocked[5], 0, "control: open ground");
});

test("check_path names what stands where a unit gets stuck", async () => {
  const t = parseW3e(w3eFromText(terrainText));
  // A wall across the map at column 8, with a tree object standing by it.
  const wall = Array.from({ length: 8 }, (_, y) => y * 16 + 8);
  const near = { id: "LTlt", position: [t.offsetX + 8 * 32 + 16, t.offsetY + 4 * 32 + 16, 0], angle: 0, scale: [1, 1, 1], variation: 0 };
  const from: [number, number] = [t.offsetX + 2 * 32, t.offsetY + 4 * 32], to: [number, number] = [t.offsetX + 14 * 32, t.offsetY + 4 * 32];
  const blocked = await pathReport(source(wall, [], () => [near] as never), from, to, 0);
  assert.equal(blocked.walkable, false);
  assert.equal(blocked.standingNearby?.id, "LTlt");
  const open = await pathReport(source([], []), from, to, 0);
  assert.equal(open.walkable, true, "control: without the wall it gets through");
});

/** A project with these files (path → text); `broken` are listed but can't be read. */
function project(files: Record<string, string>, broken: string[] = []) {
  return {
    workspace: {
      project: () => ({ root: "/p" }),
      files: () => [...Object.keys(files), ...broken].map((path) => ({ path })),
      readText: async (p: string) => { if (p in files) return files[p]; throw new Error(`can't read ${p}`); },
      readBytes: async (p: string) => { throw new Error(`can't read ${p}`); },
    },
    game: { readText: async () => "" },
    settings: { get: () => undefined },
    backend: { invoke: async () => { throw new Error("no backend"); } },
  } as unknown as W3Api;
}
const opts = { read: async () => { throw new Error("no file"); }, baseOf: () => undefined, groups: [] };

test("the saved project's source: no placement files is no objects; one that is there but unreadable fails", async () => {
  const src = await projectWalkSource(project({ "map/war3map.w3e.txt": terrainText }), opts);
  assert.deepEqual(src.list(), []);
  assert.equal(src.terrain.width, 5);
  await assert.rejects(projectWalkSource(project({ "map/war3map.w3e.txt": terrainText }, ["map/war3mapUnits.doo.json"]), opts), /can't read/);
  await assert.rejects(projectWalkSource(project({}), opts), /no terrain/);
});

test("the saved project's source lists the units and the doodads", async () => {
  const units = JSON.stringify({ units: [{ id: "sloc", position: [0, 0, 0], player: 0 }] });
  const doodads = JSON.stringify({ doodads: [{ id: "LTlt", position: [64, 0, 0] }] });
  const src = await projectWalkSource(project({ "map/war3map.w3e.txt": terrainText, "map/war3mapUnits.doo.json": units, "map/war3map.doo.json": doodads }), opts);
  assert.deepEqual(src.list().map((e) => e.id), ["sloc", "LTlt"]);
});
