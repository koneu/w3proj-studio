import assert from "node:assert/strict";
import { test } from "node:test";
import { openTarget, realFiles, virtualOver, virtualTab } from "./projectview";

const file = (path: string, virtual = false) => ({ path, size: 1, modified: 1, ...(virtual ? { virtual } : {}) });
const FILES = [
  file("map/terrain/terrain.json"), file("map/terrain/main/terrain.txt"), file("map/objects/units/custom/h000.json"), file("map/war3map.wts"),
  file("map/war3map.w3e.txt", true), file("map/war3map.doo.json", true), file("map/war3map.w3u.json", true), file("map/war3map.shd", true), file(".w3proj/pathing.json", true),
  file("maps/One.w3x/map/terrain/terrain.json"), file("maps/One.w3x/map/war3map.w3e.txt", true),
  file("flat/map/war3map.w3e.txt"), file("flat/map/terrain/terrain.json"),
];

test("a user is shown the files on disk, and terrain.json leads to the terrain editor's file of its map", () => {
  assert.ok(realFiles(FILES).every((f) => !f.virtual));
  assert.equal(realFiles(FILES).length, 7);
  assert.equal(openTarget("map/terrain/terrain.json", FILES), "map/war3map.w3e.txt");
  assert.equal(openTarget("maps/One.w3x/map/terrain/terrain.json", FILES), "maps/One.w3x/map/war3map.w3e.txt");
  assert.equal(openTarget("flat/map/terrain/terrain.json", FILES), "flat/map/terrain/terrain.json", "a real single file isn't a virtual one's stand-in");
  assert.equal(openTarget("map/war3map.wts", FILES), "map/war3map.wts");
  assert.deepEqual(virtualTab("map/war3map.w3e.txt", FILES), { label: "Terrain", tooltip: "The terrain in map/terrain/" });
  assert.match(virtualTab("map/war3map.doo.json", FILES)!.tooltip, /not a file there; put together from map\/terrain\//);
  assert.match(virtualTab("map/war3map.w3u.json", FILES)!.tooltip, /from map\/objects\//);
  assert.match(virtualTab("map/war3map.shd", FILES)!.tooltip, /kept in build\/derived\//);
  assert.equal(virtualTab("flat/map/war3map.w3e.txt", FILES), null, "a file on disk is itself");
});

test("deleting or moving real files takes in the virtual ones made from them", () => {
  const over = (p: string) => virtualOver(p, FILES).sort();
  assert.deepEqual(over("map/terrain/main/terrain.txt"), ["map/war3map.doo.json", "map/war3map.w3e.txt"]);
  assert.deepEqual(over("map/terrain"), ["map/war3map.doo.json", "map/war3map.w3e.txt"]);
  assert.deepEqual(over("map/objects/units"), ["map/war3map.w3u.json"]);
  assert.deepEqual(over("map"), ["map/war3map.doo.json", "map/war3map.shd", "map/war3map.w3e.txt", "map/war3map.w3u.json"]);
  assert.deepEqual(over("maps/One.w3x/map/terrain"), ["maps/One.w3x/map/war3map.w3e.txt"]);
  assert.deepEqual(over("map/war3map.wts"), []);
});
