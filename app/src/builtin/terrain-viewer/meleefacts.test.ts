// What check_melee and check_path walk on (meleefacts.ts): the grid from pathing, what stands in the way and painted
// Boundary; and the saved project's source (w3proj check) telling a placement file that is absent from one that is
// there but can't be read.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { NO_WALK, NO_WATER } from "../../lib/terrain/pathing";
import { parseW3e } from "../../lib/terrain/w3e";
import { w3eFromText } from "../../lib/terrain/w3etext";
import { pathReport, projectWalkSource, walkGrid, type WalkSource } from "./meleefacts";
import { readFixture } from "../../lib/testhelpers/testutil";

/** The mini map's map/ folder file `name`. */
const fixture = (name: string): string => readFixture("mini-map", "map", name);
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

test("check_path movement: float is stopped by land (0x40), walk by what can't be waded (0x02); default is walk", async () => {
  const t = parseW3e(w3eFromText(terrainText));
  const from: [number, number] = [t.offsetX + 2 * 32, t.offsetY + 4 * 32], to: [number, number] = [t.offsetX + 14 * 32, t.offsetY + 4 * 32];
  const column = (flag: number): WalkSource => {
    const src = source([], []);
    const cells = new Uint8Array(16 * 8);
    for (let y = 0; y < 8; y++) cells[y * 16 + 8] = flag;
    return { ...src, pathing: async () => ({ cells, width: 16, height: 8 }) };
  };
  const ok = async (flag: number, movement?: "walk" | "float") => (await pathReport(column(flag), from, to, 0, movement)).walkable;
  // Water too deep to wade: no walking, but a ship sails it.
  assert.equal(await ok(NO_WALK, "walk"), false);
  assert.equal(await ok(NO_WALK, "float"), true);
  // Land strip: a ship can't cross it, a walker can.
  assert.equal(await ok(NO_WATER, "float"), false);
  assert.equal(await ok(NO_WATER, "walk"), true);
  // A cliff stops both.
  assert.equal(await ok(NO_WALK | NO_WATER, "walk"), false);
  assert.equal(await ok(NO_WALK | NO_WATER, "float"), false);
  // Default is walk.
  assert.equal(await ok(NO_WALK), false);
  assert.equal(await ok(NO_WATER), true);
});

test("check_path float: deep water (0x02 only) is sailed, the ground's own no-walk cells aren't a blocker for a ship", async () => {
  const t = parseW3e(w3eFromText(terrainText));
  const from: [number, number] = [t.offsetX + 2 * 32, t.offsetY + 4 * 32], to: [number, number] = [t.offsetX + 14 * 32, t.offsetY + 4 * 32];
  /** A column of `flag` cells; blockers() as the real sources give them: with the ground's no-walk cells (Occupancy.build)
   *  unless objectsOnly (Occupancy.mask), and `standing` cells for what is placed. */
  const lake = (flag: number, standing: number[] = []): WalkSource => {
    const cells = new Uint8Array(16 * 8);
    for (let y = 0; y < 8; y++) cells[y * 16 + 8] = flag;
    return {
      ...source([], []),
      pathing: async () => ({ cells, width: 16, height: 8 }),
      blockers: async (objectsOnly) => { const b = new Uint8Array(16 * 8); for (let i = 0; i < b.length; i++) if ((!objectsOnly && cells[i] & NO_WALK) || standing.includes(i)) b[i] = 1; return b; },
    };
  };
  const ok = async (src: WalkSource, movement?: "walk" | "float") => (await pathReport(src, from, to, 0, movement)).walkable;
  // Deep water: walk is blocked, float crosses (the report's start isn't "inside something that blocks" either).
  assert.equal(await ok(lake(NO_WALK), "walk"), false);
  assert.equal(await ok(lake(NO_WALK), "float"), true);
  assert.equal((await walkGrid(lake(NO_WALK), "float")).blocked.every((b) => b === 0), true);
  // Shallow ford (no flags): both cross.
  assert.equal(await ok(lake(0), "walk"), true);
  assert.equal(await ok(lake(0), "float"), true);
  // Land: float blocked, walk not.
  assert.equal(await ok(lake(NO_WATER), "float"), false);
  assert.equal(await ok(lake(NO_WATER), "walk"), true);
  // A placed object in the water stops a ship (control: the objects still count).
  const wall = Array.from({ length: 8 }, (_, y) => y * 16 + 8);
  assert.equal(await ok(lake(NO_WALK, wall), "float"), false);
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
  // The real source's objects-only blockers (ships): no objects, so nothing blocks (control: it runs and has the grid's size).
  const only = await src.blockers(true).catch((e) => e);
  assert.ok(only instanceof Uint8Array && only.length === 16 * 8 && only.every((b) => b === 0), String(only));
  await assert.rejects(projectWalkSource(project({ "map/war3map.w3e.txt": terrainText }, ["map/war3mapUnits.doo.json"]), opts), /can't read/);
  await assert.rejects(projectWalkSource(project({}), opts), /no terrain/);
});

test("the saved project's source lists the units and the doodads", async () => {
  const units = JSON.stringify({ units: [{ id: "sloc", position: [0, 0, 0], player: 0 }] });
  const doodads = JSON.stringify({ doodads: [{ id: "LTlt", position: [64, 0, 0] }] });
  const src = await projectWalkSource(project({ "map/war3map.w3e.txt": terrainText, "map/war3mapUnits.doo.json": units, "map/war3map.doo.json": doodads }), opts);
  assert.deepEqual(src.list().map((e) => e.id), ["sloc", "LTlt"]);
});

test("walkGrid uses objects-only blockers even for walk movement so walkable bridges stayed open", async () => {
  const t = parseW3e(w3eFromText(terrainText));
  const from: [number, number] = [t.offsetX + 2 * 32, t.offsetY + 4 * 32], to: [number, number] = [t.offsetX + 14 * 32, t.offsetY + 4 * 32];
  // Column 8 was NO_WALK terrain cleared by a bridge in pathing(), while non-objectsOnly blockers() (Occupancy.build)
  // re-blocks it without bridges. Placed objects (objectsOnly = true) block only cell (3, 14) off the bridge.
  const bridgeCells = new Set(Array.from({ length: 8 }, (_, y) => y * 16 + 8));
  const standingCell = 3 * 16 + 14;
  const src: WalkSource = {
    terrain: t,
    pathing: async () => ({ cells: new Uint8Array(16 * 8), width: 16, height: 8 }),
    blockers: async (objectsOnly) => {
      const b = new Uint8Array(16 * 8);
      if (!objectsOnly) for (const i of bridgeCells) b[i] = 1;
      b[standingCell] = 1;
      return b;
    },
    list: () => [],
    baseOf: () => undefined,
  };
  assert.equal((await pathReport(src, from, to, 0, "walk")).walkable, true);
  assert.equal((await walkGrid(src, "walk")).blocked[standingCell], 1, "control: placed object still blocks");
});
