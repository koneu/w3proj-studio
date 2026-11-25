import assert from "node:assert/strict";
import { test } from "node:test";
import { judgedHidden, playerRaces, startBuilding, StartJudge, startPreviewHidden, startPreviewKey, startPreviews, startSpot } from "./startpreview";
import type { Terrain } from "../../lib/terrain/w3e";
import type { StartSurroundings } from "../../lib/terrain/meleesave";
import { NO_BUILD, NO_WALK } from "../../lib/terrain/pathing";
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

/** shore()'s 64 x 64 cells as the melee save tests them: all fit for a hall, but `blocked` (cell x, y) not buildable. */
function cellsWith(blocked: [number, number][]): StartSurroundings {
  const pathing = new Uint8Array(16 + 64 * 64);
  for (const [x, y] of blocked) pathing[16 + y * 64 + x] = NO_BUILD;
  return { pathing };
}

test("the judged rule hides a start's preview where the melee save calls it invalid (we-drive 2026-11-25)", () => {
  const races = new Map([[0, 1], [1, 1], [2, 1]]);
  const t = shore(99, 0);
  // World 0 is cell 32: the square of a start there is cells 24..39 each way.
  const shown = (units: Placed[], around: StartSurroundings) => {
    const judged = judgedHidden(t, units, around);
    return startPreviews(units, races, (x, y) => startPreviewHidden(t, [], x, y) || judged.has(startSpot(x, y))).map((p) => p.player);
  };
  assert.deepEqual(shown([sloc(0, 0, 0)], cellsWith([])), [0], "control: nothing in the square");
  assert.deepEqual(shown([sloc(0, 0, 0)], cellsWith([[36, 32]])), [], "a tree's (or blocker's, Lrok's, cliff's) cell in the square");
  assert.deepEqual(shown([sloc(0, 0, 0)], cellsWith([[39, 39]])), [], "its last cell");
  assert.deepEqual(shown([sloc(0, 0, 0)], cellsWith([[40, 32], [32, 23]])), [0], "cells just past it");
  // Another start: 488 away hides both, 496 neither (make-start-preview.mjs overlap).
  assert.deepEqual(shown([sloc(0, -256, 0), sloc(1, 232, 0)], cellsWith([])), [], "488 apart");
  assert.deepEqual(shown([sloc(0, -256, 0), sloc(1, 240, 0)], cellsWith([])), [0, 1], "496 apart");  // A footman on the start isn't a reason; unknown surroundings (a cell only unwalkable) keep the preview.
  const footman: Placed = { id: "hfoo", variation: 0, position: [0, 0, 0], angle: 0, scale: [1, 1, 1], player: 24 };
  assert.deepEqual(shown([sloc(0, 0, 0), footman], cellsWith([])), [0], "a footman on the start");
  const unwalkable = cellsWith([]);
  unwalkable.pathing[16 + 32 * 64 + 34] = NO_WALK;
  assert.deepEqual(shown([sloc(0, 0, 0)], unwalkable), [0], "unknown: kept");
  assert.deepEqual(shown([sloc(0, 0, 0)], { pathing: new Uint8Array(16) }), [0], "a pathing map of another size: kept");
});

/** Timers run by hand: `fire` runs the waiting ones. */
function handTimers() {
  let next = 1;
  const waiting = new Map<number, () => void>();
  return {
    timers: { set: (f: () => void) => { waiting.set(next, f); return next++; }, clear: (h: unknown) => { waiting.delete(h as number); } },
    fire: () => { const fs = [...waiting.values()]; waiting.clear(); for (const f of fs) f(); },
    get waiting() { return waiting.size; },
  };
}

/** A judge whose answers are given by hand, in the order asked. */
function handJudge() {
  const asked: ((r: ReadonlySet<string> | null) => void)[] = [];
  return { judge: () => new Promise<ReadonlySet<string> | null>((res) => asked.push(res)), asked };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("a judged result shows only when nothing changed since it was asked for; the last one stays until then", async () => {
  const clock = handTimers(), j = handJudge();
  let results = 0;
  const judge = new StartJudge(j.judge, () => results++, 300, clock.timers);
  judge.changed("a");
  judge.changed("a");
  assert.equal(clock.waiting, 1, "the same key twice: one judgement");
  clock.fire();
  assert.equal(j.asked.length, 1);
  j.asked[0](new Set([startSpot(0, 0)]));
  await flush();
  assert.equal(judge.hiddenAt(0, 0), true, "the result shows");
  assert.equal(results, 1, "and asks for a frame");
  // An edit (the tree removed): judged again; meanwhile the last result stays (no flicker).
  judge.changed("b");
  assert.equal(judge.hiddenAt(0, 0), true, "kept until the new result");
  clock.fire();
  // Another edit while that judgement runs (the tree put back): its result is stale and never shows.
  judge.changed("c");
  j.asked[1](new Set());
  await flush();
  assert.equal(judge.hiddenAt(0, 0), true, "the stale result (nothing hidden) didn't show");
  assert.equal(results, 1);
  clock.fire();
  assert.equal(j.asked.length, 3);
  j.asked[2](new Set([startSpot(0, 0), startSpot(512, 0)]));
  await flush();
  assert.equal(judge.hiddenAt(512, 0), true, "the newest result shows");
  assert.equal(results, 2);
  // Can't tell (no game): nothing hidden by it.
  judge.changed("d");
  clock.fire();
  j.asked[3](null);
  await flush();
  assert.equal(judge.hiddenAt(0, 0), false);
  assert.equal(results, 3);
});

test("a change whose timer fires while a judgement runs is judged right after it; nothing lands after dispose", async () => {
  const clock = handTimers(), j = handJudge();
  const judge = new StartJudge(j.judge, () => {}, 300, clock.timers);
  judge.changed("a");
  clock.fire();
  judge.changed("b");
  clock.fire();
  assert.equal(j.asked.length, 1, "one at a time");
  j.asked[0](new Set([startSpot(1, 1)]));
  await flush();
  assert.equal(judge.hiddenAt(1, 1), false, "stale");
  assert.equal(j.asked.length, 2, "judged again at once");
  j.asked[1](new Set([startSpot(2, 2)]));
  await flush();
  assert.equal(judge.hiddenAt(2, 2), true);
  // A judgement that throws counts as can't tell.
  const failing = new StartJudge(async () => { throw new Error("EIO"); }, () => {}, 300, clock.timers);
  failing.changed("a");
  clock.fire();
  await flush();
  assert.equal(failing.hiddenAt(2, 2), false);
  // Disposed while it runs: the result is dropped, no timer is left.
  judge.changed("c");
  clock.fire();
  judge.changed("d");
  judge.dispose();
  assert.equal(clock.waiting, 0, "the timer is gone");
  j.asked[2](new Set([startSpot(3, 3)]));
  await flush();
  assert.equal(judge.hiddenAt(3, 3), false);
  assert.equal(j.asked.length, 3);
});
