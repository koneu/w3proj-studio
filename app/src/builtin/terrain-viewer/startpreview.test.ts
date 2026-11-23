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

test("a start in shallow water or under a special shows no preview; deep water and dry ground keep it", () => {
  const units = [sloc(0, 128, 128)];
  const races = new Map([[0, 1]]);
  const shown = (t: Terrain, specials: { x0: number; y0: number; x1: number; y1: number }[] = []) =>
    startPreviews(units, races, (x, y) => startPreviewHidden(t, specials, x, y)).length;
  assert.equal(shown(pond(0)), 1, "control: dry ground");
  assert.equal(shown(pond(30)), 0, "shallow water");
  assert.equal(shown(pond(200)), 1, "deep water");
  assert.equal(shown(pond(0), [{ x0: 1, y0: 1, x1: 1, y1: 1 }]), 0, "under a special");
  assert.equal(shown(pond(0), [{ x0: 0, y0: 0, x1: 0, y1: 0 }]), 1, "a special next to it");
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
