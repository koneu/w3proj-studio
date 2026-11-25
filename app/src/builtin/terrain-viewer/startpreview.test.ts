import assert from "node:assert/strict";
import { test } from "node:test";
import { playerRaces, startBuilding, startPreviewHidden, startPreviewKey, startPreviews } from "./startpreview";
import type { Terrain } from "../../lib/terrain/w3e";
import type { Placed } from "./objects";

const sloc = (player: number | undefined, x: number, y: number): Placed => ({ id: "sloc", variation: 0, position: [x, y, 16], angle: 1, scale: [1, 1, 1], player });

test("each race shows its town hall, as the World Editor does", () => {
  assert.deepEqual([1, 2, 3, 4].map((race) => startBuilding(0, race)), ["htow", "ogre", "unpl", "etoa"]);
});

test("a selectable race (or none known) shows one of the four by player number, the same each time", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 23].map((p) => startBuilding(p, 0)), ["htow", "ogre", "unpl", "etoa", "htow", "etoa"]);
  assert.equal(startBuilding(5, undefined), "ogre");
  assert.equal(startBuilding(2, 9), "unpl");
});

test("one preview per start location: its player's town hall where it stands, facing 270°", () => {
  const units: Placed[] = [
    sloc(0, -2176, 640),
    { id: "hfoo", variation: 0, position: [0, 0, 0], angle: 0, scale: [1, 1, 1], player: 0 },
    sloc(3, 512, -256),
    sloc(undefined, 9, 9),
  ];
  const out = startPreviews(units, new Map([[0, 2], [3, 0]]));
  assert.deepEqual(out.map((p) => [p.id, p.player, p.position]), [["ogre", 0, [-2176, 640, 16]], ["etoa", 3, [512, -256, 16]]]);
  assert.ok(out.every((p) => Math.abs(p.angle - (3 * Math.PI) / 2) < 1e-9 && p.scale.every((s) => s === 1)));
  // A copy: moving the preview doesn't move the start location.
  out[0].position[0] = 0;
  assert.equal(units[0].position[0], -2176);
});

test("races come from the map's players; anything else is left out", () => {
  const races = playerRaces({ players: [{ id: 0, race: 1 }, { id: 1, race: 3 }, { id: "x", race: 2 }, { id: 4 }] });
  assert.deepEqual([...races], [[0, 1], [1, 3]]);
  assert.deepEqual([...playerRaces(null)], []);
  assert.deepEqual([...playerRaces({})], []);
});

test("the key changes with a start's place, player and race, and not with other units", () => {
  const units = [sloc(0, 1, 2), { ...sloc(0, 5, 5), id: "hfoo" }];
  const key = startPreviewKey(units, new Map([[0, 1]]));
  assert.equal(startPreviewKey([sloc(0, 1, 2)], new Map([[0, 1]])), key);
  assert.notEqual(startPreviewKey([sloc(0, 1, 3)], new Map([[0, 1]])), key);
  assert.notEqual(startPreviewKey([sloc(1, 1, 2)], new Map([[0, 1]])), key);
  assert.notEqual(startPreviewKey(units, new Map([[0, 2]])), key);
  assert.notEqual(startPreviewKey([], new Map()), key);
});

/** A 3 x 3 corner terrain, ground at 0; the left column (x 0) under water `depth` deep when depth > 0. */
function pond(depth: number): Terrain {
  const corners = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
    const wet = depth > 0;
    corners.push({ layer: 2, ramp: false, height: 0, rawHeight: 0x2000, hasWater: wet, water: wet ? depth : -2137.6, texture: 0, variation: 0, cliffVariation: 0, cliffTexture: 0, blight: false, boundary: false, rawWater: 0, texExtra: 0 });
  }
  return { version: 11, tileset: "L", customTilesets: false, groundTiles: ["Ldrt"], cliffTiles: ["CLdi"], width: 3, height: 3, offsetX: 0, offsetY: 0, corners, trailer: new Uint8Array(0) } as unknown as Terrain;
}

test("a start in water of any depth or under a special shows no preview; dry ground keeps it", () => {
  const units = [sloc(0, 128, 128)];
  const races = new Map([[0, 1]]);
  const shown = (t: Terrain, specials: { x0: number; y0: number; x1: number; y1: number }[] = []) =>
    startPreviews(units, races, (x, y) => startPreviewHidden(t, specials, x, y)).length;
  assert.equal(shown(pond(0)), 1, "control: dry ground");
  assert.equal(shown(pond(30)), 0, "shallow water");
  assert.equal(shown(pond(200)), 0, "deep water");
  assert.equal(shown(pond(0), [{ x0: 1, y0: 1, x1: 1, y1: 1 }]), 0, "under a special");
  assert.equal(shown(pond(0), [{ x0: 0, y0: 0, x1: 0, y1: 0 }]), 1, "a special next to it");
});

/** A 17 x 17 corner terrain, ground at 0, offset so corner 8 is at world 0; corners with x >= `from` under water
 *  `depth` deep (the w3e's level: depth + 89.6 is stored, as the editor's water offset). */
function shore(from: number, depth: number): Terrain {
  const corners = [];
  for (let y = 0; y < 17; y++) for (let x = 0; x < 17; x++) {
    const wet = x >= from;
    corners.push({ layer: 2, ramp: false, height: 0, rawHeight: 0x2000, hasWater: wet, water: wet ? depth : -89.6, texture: 0, variation: 0, cliffVariation: 0, cliffTexture: 0, blight: false, boundary: false, rawWater: 0, texExtra: 0 });
  }
  return { version: 11, tileset: "L", customTilesets: false, groundTiles: ["Ldrt"], cliffTiles: ["CLdi"], width: 17, height: 17, offsetX: -1024, offsetY: -1024, corners, trailer: new Uint8Array(0) } as unknown as Terrain;
}

test("water anywhere under the town hall's square hides the preview, water past it doesn't (we-drive 2026-11-25)", () => {
  // tests/fixtures/we-specs/make-start-preview.mjs, maps depth and ground: every depth from 0.15 to 100.15 hid it,
  // a surface below the ground (-10) didn't; water from the corner 128 or 256 east of the start hid it, from 384 not.
  const units = [sloc(0, 0, 0)];
  const races = new Map([[0, 1]]);
  const shown = (t: Terrain) => startPreviews(units, races, (x, y) => startPreviewHidden(t, [], x, y)).length;
  assert.equal(shown(shore(99, 30)), 1, "control: dry");
  for (const depth of [0.15, 30, 51.9, 52.15, 70, 100]) assert.equal(shown(shore(0, depth)), 0, `${depth} deep`);
  assert.equal(shown(shore(0, -10)), 1, "the surface under the ground");
  assert.equal(shown(shore(9, 30)), 0, "water from 128 east");
  assert.equal(shown(shore(10, 30)), 0, "water from 256 east");
  assert.equal(shown(shore(11, 30)), 1, "water from 384 east");
});

test("a gold mine nearer than 750 hides the preview (we-drive 2026-11-25, make-start-preview.mjs mine)", () => {
  const races = new Map([[0, 1]]);
  const mine = (x: number, y: number, id = "ngol"): Placed => ({ id, variation: 0, position: [x, y, 0], angle: 0, scale: [1, 1, 1], player: 27 });
  const shown = (...others: Placed[]) => startPreviews([sloc(0, 0, 0), ...others], races).length;
  assert.equal(shown(), 1, "control: no mine");
  for (const d of [0, 256, 512, 640, 700, 740, 749]) assert.equal(shown(mine(d, 0)), 0, `a mine ${d} away`);
  for (const d of [750, 760, 800]) assert.equal(shown(mine(d, 0)), 1, `a mine ${d} away`);
  assert.equal(shown(mine(528, 528)), 0, "(528, 528): 746.7 away");
  assert.equal(shown(mine(531, 531)), 1, "(531, 531): 751 away");
  assert.equal(shown({ ...mine(0, 0), id: "hhou" }), 1, "a farm on the start (measured: kept)");
  assert.equal(shown(mine(100, 0, "egol")), 0, "an entangled mine");
});

test("the key follows the hidden state, so Undo (the start back on dry ground) redraws the preview", () => {
  const units = [sloc(0, 128, 128)];
  const races = new Map([[0, 1]]);
  const keyIn = (t: Terrain) => startPreviewKey(units, races, (x, y) => startPreviewHidden(t, [], x, y));
  const dry = keyIn(pond(0)), wet = keyIn(pond(30));
  assert.notEqual(wet, dry);
  assert.equal(keyIn(pond(0)), dry, "back after Undo");
  assert.equal(wet, startPreviewKey([], races), "hidden = no previews");
});
