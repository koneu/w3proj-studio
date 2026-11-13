import assert from "node:assert/strict";
import { test } from "node:test";
import { isMeleeMap, playerRaces, startBuilding, startPreviewKey, startPreviews } from "./startpreview";
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

test("previews show on melee maps only", () => {
  const units = [sloc(0, 1, 2)];
  assert.equal(startPreviews(units, new Map(), true).length, 1);
  assert.equal(startPreviews(units, new Map(), false).length, 0);
  assert.equal(isMeleeMap({ flags: 4 | 1 }), true);
  assert.equal(isMeleeMap({ flags: 1 }), false);
  assert.equal(isMeleeMap({}), false);
  assert.equal(isMeleeMap(null), false);
});

test("the key changes with a start's place, player, race and the Melee flag, and not with other units", () => {
  const units = [sloc(0, 1, 2), { ...sloc(0, 5, 5), id: "hfoo" }];
  const key = startPreviewKey(units, new Map([[0, 1]]), true);
  assert.equal(startPreviewKey([sloc(0, 1, 2)], new Map([[0, 1]]), true), key);
  assert.notEqual(startPreviewKey([sloc(0, 1, 3)], new Map([[0, 1]]), true), key);
  assert.notEqual(startPreviewKey([sloc(1, 1, 2)], new Map([[0, 1]]), true), key);
  assert.notEqual(startPreviewKey(units, new Map([[0, 2]]), true), key);
  assert.notEqual(startPreviewKey(units, new Map([[0, 1]]), false), key);
  assert.notEqual(startPreviewKey([], new Map(), true), key);
});
