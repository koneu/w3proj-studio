import assert from "node:assert/strict";
import { test } from "node:test";
import { setGroundHeight, type Terrain } from "../../lib/terrain/w3e";
import type { CliffType } from "./cliffs";
import { applyTileList, cliffGroundInUse, cliffTypeUse, planRemoval, tileUse, unusedTiles } from "./tilecleanup";

const type = (cliffID: string, groundTile: string) => ({ cliffID, groundTile, cliffModelDir: "Cliffs", rampModelDir: "CliffTrans", texDir: "", texFile: "" }) as CliffType;
const TYPES = new Map([type("CLdi", "Ldrt"), type("CLgr", "Lgrs"), type("CLro", "Lrok")].map((c) => [c.cliffID, c]));

/** 8 × 8 tiles of Lgrs at level 2. Ldrt, Lrok and Lgrd (no cliff type) are in the list; cliff types 0..2 are CLdi,
 *  CLgr, CLro in list order. */
function flat(groundTiles = ["Ldrt", "Lgrs", "Lrok", "Lgrd"]): Terrain {
  const width = 9, height = 9;
  return {
    version: 12, tileset: "L", customTilesets: true, customTilesetsRaw: 1, groundTiles, cliffTiles: ["CLdi", "CLgr", "CLro"],
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
/** A one-corner mesa at (4, 4) whose four cliff tiles (bottom-left corners (3,3), (4,3), (3,4), (4,4)) are of
 *  cliff type `cliff`. */
function mesa(t: Terrain, cliff: number) {
  corner(t, 4, 4).layer = 3;
  for (const [x, y] of [[3, 3], [4, 3], [3, 4], [4, 4]]) corner(t, x, y).cliffTexture = cliff;
}

test("a tile is in use where corners show it, or where a cliff is made of it", () => {
  const t = flat();
  corner(t, 0, 0).texture = 3;
  mesa(t, 0);
  const use = tileUse(t, TYPES);
  assert.deepEqual(use.ground, [0, 80, 0, 1]);
  assert.deepEqual(use.cliffs, [4, 0, 0, 0], "Ldrt's cliff type makes the mesa");
  assert.deepEqual(unusedTiles(use), [2], "only Lrok: Ldrt is a cliff, Lgrd a corner");
});

test("cliff type 15 (or one past the list) is the first type, as the renderer draws it", () => {
  const t = flat();
  mesa(t, 15);
  assert.deepEqual(tileUse(t, TYPES).cliffs, [4, 0, 0, 0]);
  const u = flat();
  mesa(u, 9);
  assert.deepEqual(tileUse(u, TYPES).cliffs, [4, 0, 0, 0]);
});

test("flat ground and ramps are no cliffs; without the cliff types nothing counts as one", () => {
  const t = flat();
  for (const c of t.corners) c.cliffTexture = 2;
  assert.deepEqual(tileUse(t, TYPES).cliffs, [0, 0, 0, 0]);
  mesa(t, 2);
  assert.deepEqual(tileUse(t, new Map()).cliffs, [0, 0, 0, 0]);
});

test("cliffTypeUse counts cliff tiles by cliff type number, whatever the ground list (Replace Cliff Type's counts)", () => {
  // With the custom tilesets flag 0 the file's ground list need not hold a cliff type's tile (here Lrok): its cliffs
  // still count, by the w3e's cliff list. Through the ground list (tileUse) they'd be lost.
  const t = flat(["Lgrs", "Lgrd"]);
  t.customTilesetsRaw = 0;
  mesa(t, 2);
  assert.deepEqual(cliffTypeUse(t, TYPES), [0, 0, 4]);
  assert.deepEqual(tileUse(t, TYPES).cliffs, [0, 0], "the ground list has no Lrok to count them under");
  const u = flat();
  mesa(u, 15);
  assert.deepEqual(cliffTypeUse(u, TYPES), [4, 0, 0], "past the list: the first type, as tileUse");
  assert.deepEqual(cliffTypeUse(u, new Map()), [0, 0, 0]);
});

test("removing used tiles needs a replacement that stays", () => {
  const t = flat();
  mesa(t, 0);
  const use = tileUse(t, TYPES);
  assert.throws(() => planRemoval(t.groundTiles, [1], new Map(), use), /Lgrs is in use \(81 corners, 0 cliff tiles\)/);
  assert.throws(() => planRemoval(t.groundTiles, [0], new Map(), use), /Ldrt is in use \(0 corners, 4 cliff tiles\)/);
  assert.throws(() => planRemoval(t.groundTiles, [1, 2], new Map([[1, 2]]), use), /is removed too/);
  assert.throws(() => planRemoval(t.groundTiles, [1], new Map([[1, 7]]), use), /isn't in the list/);
  assert.throws(() => planRemoval(t.groundTiles, [0, 1, 2, 3], new Map([[0, 1], [1, 0]]), use), /at least one ground tile/);
  assert.throws(() => planRemoval(t.groundTiles, [4], new Map(), use), /no ground tile 4/);
  assert.throws(() => planRemoval(t.groundTiles, [], new Map(), use), /No ground tile/);
  // Control: the same with what's needed goes through.
  assert.deepEqual(planRemoval(t.groundTiles, [1, 2], new Map([[1, 3]]), use).tiles, ["Ldrt", "Lgrd"]);
});

test("the unused tiles go, the rest keep their corners under new indices", () => {
  const t = flat();
  corner(t, 0, 0).texture = 3;
  const before = t.corners.map((c) => t.groundTiles[c.texture]);
  const plan = planRemoval(t.groundTiles, unusedTiles(tileUse(t, TYPES)), new Map(), tileUse(t, TYPES));
  assert.deepEqual(plan.removed, ["Ldrt", "Lrok"]);
  applyTileList(t, plan.tiles, plan.map, TYPES, undefined);
  assert.deepEqual(t.groundTiles, ["Lgrs", "Lgrd"]);
  assert.deepEqual(t.corners.map((c) => t.groundTiles[c.texture]), before, "every corner shows what it showed");
  assert.deepEqual(t.cliffTiles, ["CLgr"], "Ldrt's and Lrok's cliff types went with them");
});

test("a forced removal repaints the corners and gives the cliffs the replacement's cliff type", () => {
  const t = flat();
  for (let x = 0; x < 9; x++) corner(t, x, 0).texture = 2;
  mesa(t, 2);
  const use = tileUse(t, TYPES);
  // Lrok (corners and the mesa's cliffs) becomes Ldrt.
  const plan = planRemoval(t.groundTiles, [2], new Map([[2, 0]]), use);
  applyTileList(t, plan.tiles, plan.map, TYPES, undefined);
  assert.deepEqual(t.groundTiles, ["Ldrt", "Lgrs", "Lgrd"]);
  for (let x = 0; x < 9; x++) assert.equal(t.groundTiles[corner(t, x, 0).texture], "Ldrt");
  assert.equal(t.groundTiles[corner(t, 4, 4).texture], "Lgrs", "other corners keep their tile");
  assert.equal(corner(t, 3, 3).cliffTexture, 0, "the mesa is now CLdi (type 0 of CLdi, CLgr)");
  assert.deepEqual(tileUse(t, TYPES).cliffs, [4, 0, 0]);
});

test("a replacement without a cliff type: the cliffs take the corner's ground's", () => {
  const t = flat();
  mesa(t, 2);
  const plan = planRemoval(t.groundTiles, [2], new Map([[2, 3]]), tileUse(t, TYPES));
  applyTileList(t, plan.tiles, plan.map, TYPES, undefined);
  assert.equal(corner(t, 3, 3).cliffTexture, 1, "Lgrs's CLgr, the ground there");
});

test("a type that stays keeps its cliffs when tiles before it go", () => {
  const t = flat();
  mesa(t, 2);
  for (const c of t.corners) if (c.texture === 1) c.texture = 3;
  const use = tileUse(t, TYPES);
  const plan = planRemoval(t.groundTiles, [0, 1], new Map(), use);
  applyTileList(t, plan.tiles, plan.map, TYPES, undefined);
  assert.deepEqual(t.groundTiles, ["Lrok", "Lgrd"]);
  assert.equal(corner(t, 3, 3).cliffTexture, 0, "CLro is type 0 now");
  assert.deepEqual(tileUse(t, TYPES).cliffs, [4, 0]);
});

test("cliff types go by the w3e's cliff list, also when it isn't in the ground list's order", () => {
  const t = flat();
  t.cliffTiles = ["CLro", "CLno", "CLdi", "CLgr"];
  mesa(t, 0);
  assert.deepEqual(tileUse(t, TYPES).cliffs, [0, 0, 4, 0], "type 0 is CLro, Lrok's");
  const u = flat();
  u.cliffTiles = ["CLro", "CLno", "CLdi", "CLgr"];
  mesa(u, 1);
  assert.deepEqual(tileUse(u, TYPES).cliffs, [0, 0, 4, 0], "CLno, which the game doesn't define, is drawn as the first type (CLro)");
  // Lgrd goes: the stored list takes the ground list's order, CLno stays at the end, the mesa stays CLro.
  const plan = planRemoval(t.groundTiles, [3], new Map(), tileUse(t, TYPES));
  applyTileList(t, plan.tiles, plan.map, TYPES, undefined);
  assert.deepEqual(t.cliffTiles, ["CLdi", "CLgr", "CLro", "CLno"]);
  assert.equal(corner(t, 3, 3).cliffTexture, 2);
  assert.deepEqual(tileUse(t, TYPES).cliffs, [0, 0, 4]);
});

test("a cliff type whose ground tile isn't in the list stays in the cliff list with its cliffs", () => {
  const t = flat(["Ldrt", "Lgrd"]);
  for (const c of t.corners) c.texture = 0;
  t.cliffTiles = ["CLdi", "CLro"];
  mesa(t, 1);
  applyTileList(t, ["Lgrd", "Ldrt"], (i) => 1 - i, TYPES, undefined);
  assert.deepEqual(t.cliffTiles, ["CLdi", "CLro"]);
  assert.equal(corner(t, 3, 3).cliffTexture, 1, "still CLro");
});

test("a ground list change that would grow the cliff list past 15 is refused with nothing changed; one that long already stays", () => {
  const many = new Map([...TYPES, ...Array.from({ length: 15 }, (_, i) => [`C${String(i).padStart(3, "0")}`, `G${String(i).padStart(3, "0")}`] as const)
    .map(([id, g]) => [id, { ...TYPES.get("CLdi")!, cliffID: id, groundTile: g }] as const)]);
  const fifteen = Array.from({ length: 15 }, (_, i) => `C${String(i).padStart(3, "0")}`);
  const t = flat(["Lgrd"]);
  t.cliffTiles = [...fifteen];
  // Adding Ldrt: its CLdi would be a 16th entry.
  assert.throws(() => applyTileList(t, ["Lgrd", "Ldrt"], (i) => i, many, undefined), /cliff list 16 long/);
  assert.deepEqual([t.groundTiles, t.cliffTiles], [["Lgrd"], fifteen], "nothing changed");
  // Control: a list of 16 already (CLdi in it) can be reordered.
  const u = flat(["Ldrt", "Lgrd"]);
  u.cliffTiles = [...fifteen, "CLdi"];
  applyTileList(u, ["Lgrd", "Ldrt"], (i) => 1 - i, many, undefined);
  assert.equal(u.cliffTiles.length, 16);
  assert.deepEqual(u.groundTiles, ["Lgrd", "Ldrt"]);
});

test("reordering the ground tiles keeps the cliff list: a cliff type removed from it doesn't come back", () => {
  // CLgr (Lgrs's) was removed in the Cliffs… panel; the mesa is CLro, type 1 of CLdi, CLro.
  const t = flat();
  t.cliffTiles = ["CLdi", "CLro"];
  mesa(t, 1);
  const before = t.corners.map((c) => t.groundTiles[c.texture]);
  // Lgrs moves to the front.
  const order = [1, 0, 2, 3], inverse = new Map(order.map((old, nw) => [old, nw]));
  applyTileList(t, order.map((i) => t.groundTiles[i]), (old) => inverse.get(old) ?? old, TYPES, undefined);
  assert.deepEqual(t.groundTiles, ["Lgrs", "Ldrt", "Lrok", "Lgrd"]);
  assert.deepEqual(t.cliffTiles, ["CLdi", "CLro"], "no CLgr, same order");
  assert.equal(corner(t, 3, 3).cliffTexture, 1, "the mesa stays CLro");
  assert.deepEqual(t.corners.map((c) => t.groundTiles[c.texture]), before, "every corner shows what it showed");
  // Control: removing a tile still rebuilds the list from the ground order.
  const u = flat();
  u.cliffTiles = ["CLro", "CLdi"];
  const plan = planRemoval(u.groundTiles, [3], new Map(), tileUse(u, TYPES));
  applyTileList(u, plan.tiles, plan.map, TYPES, undefined);
  assert.deepEqual(u.cliffTiles, ["CLdi", "CLgr", "CLro"]);
});

test("Remove Tile as the World Editor's Modify Tileset does it (we-drive 2026-11-17, plateau.w3x with a stripe of each of the six tiles)", () => {
  // Lordaeron Summer's own six tiles, cliff types CLdi (Ldrt) and CLgr (Lgrs), a mesa of CLgr cliffs. Per removed tile: the
  // replacement the editor happened to give its corners (it picks a random one), the stripes' new tiles, the ground and
  // cliff lists it saved, and the mesa's cliff type. The editor saved the custom tilesets flag as 1 in each.
  const own = ["Ldrt", "Ldro", "Ldrg", "Lrok", "Lgrs", "Lgrd"];
  const types = new Map([type("CLdi", "Ldrt"), type("CLgr", "Lgrs")].map((c) => [c.cliffID, c]));
  const cases: [number, number, number[], string, string, number][] = [
    [0, 2, [1, 0, 1, 2, 3, 4], "Ldro Ldrg Lrok Lgrs Lgrd", "CLgr", 0],
    [1, 2, [0, 1, 1, 2, 3, 4], "Ldrt Ldrg Lrok Lgrs Lgrd", "CLdi CLgr", 1],
    [2, 5, [0, 1, 4, 2, 3, 4], "Ldrt Ldro Lrok Lgrs Lgrd", "CLdi CLgr", 1],
    [3, 5, [0, 1, 2, 4, 3, 4], "Ldrt Ldro Ldrg Lgrs Lgrd", "CLdi CLgr", 1],
    [4, 1, [0, 1, 2, 3, 1, 4], "Ldrt Ldro Ldrg Lrok Lgrd", "CLdi", 0],
    [5, 4, [0, 1, 2, 3, 4, 4], "Ldrt Ldro Ldrg Lrok Lgrs", "CLdi CLgr", 1],
  ];
  for (const [removed, replacement, stripes, ground, cliffs, mesaType] of cases) {
    const t = flat(own);
    t.cliffTiles = ["CLdi", "CLgr"];
    own.forEach((_, i) => { corner(t, i, 0).texture = i; });
    mesa(t, 1);
    const plan = planRemoval(t.groundTiles, [removed], new Map([[removed, own.indexOf(own[replacement])]]), tileUse(t, types));
    applyTileList(t, plan.tiles, plan.map, types, undefined);
    assert.deepEqual(own.map((_, i) => corner(t, i, 0).texture), stripes, `removed ${own[removed]}: the stripes' tiles`);
    assert.equal(t.groundTiles.join(" "), ground, `removed ${own[removed]}: the ground list`);
    assert.equal(t.cliffTiles.join(" "), cliffs, `removed ${own[removed]}: the cliff list`);
    assert.equal(corner(t, 3, 3).cliffTexture, mesaType, `removed ${own[removed]}: the mesa's cliff type`);
    assert.equal(t.customTilesetsRaw, 1);
  }
  // Control: another replacement (the editor's pick is random) gives the removed tile's stripe another tile.
  const t = flat(own);
  t.cliffTiles = ["CLdi", "CLgr"];
  corner(t, 0, 0).texture = 0;
  const plan = planRemoval(t.groundTiles, [0], new Map([[0, 3]]), tileUse(t, types));
  applyTileList(t, plan.tiles, plan.map, types, undefined);
  assert.equal(corner(t, 0, 0).texture, 2, "Lrok is the third of Ldro Ldrg Lrok Lgrs Lgrd");
});

test("the custom tiles flag follows the list: the tileset's own list is 0, another 1", () => {
  const own = ["Ldrt", "Lgrs", "Lrok"];
  const t = flat([...own, "Lgrd"]);
  const plan = planRemoval(t.groundTiles, [3], new Map(), tileUse(t, TYPES));
  applyTileList(t, plan.tiles, plan.map, TYPES, own);
  assert.equal(t.customTilesetsRaw, 0);
  assert.equal(t.customTilesets, false);
  const u = flat([...own, "Lgrd"]);
  const p2 = planRemoval(u.groundTiles, [2], new Map(), tileUse(u, TYPES));
  applyTileList(u, p2.tiles, p2.map, TYPES, own);
  assert.equal(u.customTilesetsRaw, 1);
  assert.equal(u.customTilesets, true);
});

test("cliffGroundInUse: the ground tiles of the cliff types drawn, by a cliff tile's bottom-left corner, met from the south (we-compare cliff-ground-*)", () => {
  // Only listed (no cliff), or only on flat corners: nothing.
  const t = flat();
  corner(t, 1, 1).cliffTexture = 2;
  assert.deepEqual(cliffGroundInUse(t, TYPES), []);
  // A mesa of CLro: its ground tile; corner 15 (or past the list) counts as the first type, CLdi.
  mesa(t, 2);
  assert.deepEqual(cliffGroundInUse(t, TYPES), ["Lrok"]);
  corner(t, 3, 3).cliffTexture = 15;
  assert.deepEqual(cliffGroundInUse(t, TYPES), ["Ldrt", "Lrok"]);
  // cliff-ground-north-low: the type only on the mesa's top corners (bottom-left of no cliff tile) isn't drawn.
  const low = flat();
  mesa(low, 1);
  for (const [x, y] of [[3, 5], [4, 5], [5, 5], [5, 4], [5, 3]]) corner(low, x, y).cliffTexture = 2;
  assert.deepEqual(cliffGroundInUse(low, TYPES), ["Lgrs"]);
  // cliff-ground-two: the order is the first tile's from the south, not the cliff list's.
  const two = flat();
  corner(two, 2, 6).layer = 3;
  for (const [x, y] of [[1, 5], [2, 5], [1, 6], [2, 6]]) corner(two, x, y).cliffTexture = 0;
  corner(two, 6, 2).layer = 3;
  for (const [x, y] of [[5, 1], [6, 1], [5, 2], [6, 2]]) corner(two, x, y).cliffTexture = 2;
  assert.deepEqual(cliffGroundInUse(two, TYPES), ["Lrok", "Ldrt"]);
  // The cliff types not read yet: nothing.
  assert.deepEqual(cliffGroundInUse(two, new Map()), []);
});
