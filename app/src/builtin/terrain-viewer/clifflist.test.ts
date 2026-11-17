import assert from "node:assert/strict";
import { test } from "node:test";
import { parseW3e, setGroundHeight, writeW3e, type Terrain } from "../../lib/terrain/w3e";
import type { CliffType } from "./cliffs";
import { cliffList } from "./cliffs";
import { applyCliffRemoval, cliffEntryUse, cliffListWith, MAX_CLIFF_TYPES, planCliffRemoval } from "./clifflist";

const type = (cliffID: string, groundTile: string) => ({ cliffID, groundTile, cliffModelDir: "Cliffs", rampModelDir: "CliffTrans", texDir: "", texFile: "" }) as CliffType;
const GAME = ["CLdi:Ldrt", "CLgr:Lgrs", "CAdi:Adrt", "CAgr:Agrs", "CFdi:Fdrt", "CFgr:Fgrs", "CWgr:Wgrs", "CWsn:Wsnw", "CBde:Bdsr", "CBgr:Bgrr",
  "CNdi:Ndrt", "CNsn:Nsnw", "CCgr:Cgrs", "CCdi:Cdrt", "CYdi:Ydrt", "CYsq:Ysqd", "CVdi:Vdrt"].map((s) => type(s.slice(0, 4), s.slice(5)));
const TYPES = new Map(GAME.map((c) => [c.cliffID, c]));

/** 8 × 8 tiles at level 2, the example map 29's lists: ground Ldrt Lgrs, cliffs CLdi CLgr CAdi; corners hold 15. */
function flat(cliffTiles = ["CLdi", "CLgr", "CAdi"]): Terrain {
  const width = 9, height = 9;
  return {
    version: 11, tileset: "L", customTilesets: false, customTilesetsRaw: 0, groundTiles: ["Ldrt", "Lgrs"], cliffTiles,
    width, height, offsetX: 0, offsetY: 0, trailer: new Uint8Array(0),
    corners: Array.from({ length: width * height }, () => {
      const c = {
        height: 0, water: 0, texture: 1, variation: 0, cliffVariation: 0, cliffTexture: 15, layer: 2,
        ramp: false, blight: false, hasWater: false, boundary: false, rawHeight: 0x2000, rawWater: 0x2000, texExtra: 0,
      };
      setGroundHeight(c, 0);
      return c;
    }),
  };
}
const corner = (t: Terrain, x: number, y: number) => t.corners[y * t.width + x];
/** A one-corner mesa at (x, y) whose four cliff tiles' corners are of cliff type `cliff`. */
function mesa(t: Terrain, x: number, y: number, cliff: number) {
  corner(t, x, y).layer = 3;
  for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) corner(t, x + dx, y + dy).cliffTexture = cliff;
}

test("a third cliff type: corners on number 2 are drawn with it and counted as its use", () => {
  const t = flat();
  mesa(t, 4, 4, 2);
  assert.equal(cliffList(t, TYPES)[2]?.cliffID, "CAdi");
  assert.deepEqual(cliffEntryUse(t, TYPES), { corners: [0, 0, 4], tiles: [0, 0, 4] });
  // A save keeps the list and the numbers.
  const back = parseW3e(writeW3e(t));
  assert.deepEqual(back.cliffTiles, ["CLdi", "CLgr", "CAdi"]);
  assert.deepEqual(cliffEntryUse(back, TYPES), { corners: [0, 0, 4], tiles: [0, 0, 4] });
});

test("adding a cliff type: any of the game's, once, up to 15 entries", () => {
  assert.deepEqual(cliffListWith(["CLdi", "CLgr"], "CAdi", TYPES), ["CLdi", "CLgr", "CAdi"]);
  assert.throws(() => cliffListWith(["CLdi", "CLgr"], "CLno", TYPES), /CLno isn't one of the game's cliff types/);
  assert.throws(() => cliffListWith(["CLdi", "CLgr"], "CLgr", TYPES), /has CLgr already \(number 1\)/);
  const fourteen = GAME.slice(0, MAX_CLIFF_TYPES - 1).map((c) => c.cliffID);
  assert.equal(cliffListWith(fourteen, GAME[14].cliffID, TYPES).length, 15, "control: the 15th entry is taken");
  assert.throws(() => cliffListWith([...fourteen, GAME[14].cliffID], GAME[15].cliffID, TYPES), /15 entries: a corner can name only 15 \(0 to 14\)/);
});

test("removing a cliff type nothing uses: the later entries move up and their corners follow", () => {
  const t = flat(["CLdi", "CLgr", "CAdi"]);
  mesa(t, 4, 4, 2);
  const plan = planCliffRemoval(t.cliffTiles, 1, undefined, cliffEntryUse(t, TYPES));
  applyCliffRemoval(t, plan);
  assert.deepEqual(t.cliffTiles, ["CLdi", "CAdi"]);
  assert.deepEqual(cliffEntryUse(t, TYPES), { corners: [0, 4], tiles: [0, 4] }, "the mesa is still CAdi");
  assert.equal(t.corners.filter((c) => c.cliffTexture === 15).length, t.corners.length - 4, "15 stays 15");
});

test("removing a cliff type in use is refused without a replacement, and remaps to the chosen one with it", () => {
  const t = flat(["CLdi", "CLgr", "CAdi"]);
  mesa(t, 4, 4, 2);
  mesa(t, 2, 2, 1);
  const use = cliffEntryUse(t, TYPES);
  assert.throws(() => planCliffRemoval(t.cliffTiles, 2, undefined, use), /CAdi is in use \(4 corners, 4 cliff tiles\)/);
  assert.throws(() => planCliffRemoval(t.cliffTiles, 2, 2, use), /can't get cliff type 2/);
  assert.throws(() => planCliffRemoval(t.cliffTiles, 2, 3, use), /can't get cliff type 3/);
  assert.throws(() => planCliffRemoval(t.cliffTiles, 3, undefined, use), /no cliff type 3/);
  assert.throws(() => planCliffRemoval(["CLdi"], 0, undefined, { corners: [0], tiles: [0] }), /at least one/);
  // CLgr in use goes to CAdi: the mesa of 1 becomes CAdi's new number 1, as does CAdi's own.
  applyCliffRemoval(t, planCliffRemoval(t.cliffTiles, 1, 2, use));
  assert.deepEqual(t.cliffTiles, ["CLdi", "CAdi"]);
  assert.deepEqual(cliffEntryUse(t, TYPES).corners, [0, 8], "both mesas' corners are CAdi");
});

test("a list longer than 15: a corner's 15 isn't the 16th entry's use, and stays 15 when an entry goes", () => {
  const long = GAME.map((c) => c.cliffID);
  const t = flat(long);
  mesa(t, 4, 4, 14);
  const use = cliffEntryUse(t, TYPES);
  assert.equal(use.corners[15], 0);
  assert.throws(() => planCliffRemoval(long, 2, 15, use), /can't get cliff type 15/, "a replacement past 14 can't be painted");
  applyCliffRemoval(t, planCliffRemoval(long, 2, undefined, use));
  assert.equal(corner(t, 4, 4).cliffTexture, 13);
  assert.equal(corner(t, 0, 0).cliffTexture, 15);
  assert.equal(t.cliffTiles[13], long[14]);
});
