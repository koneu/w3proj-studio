import assert from "node:assert/strict";
import { test } from "node:test";
import { pictureTarget } from "./picturetarget";

const BOTH = ["map/war3map.w3e", "map/war3map.w3e.txt"];
const open = (...paths: string[]) => (p: string) => paths.includes(p);

test("pictureTarget: with two terrain files, the picture is of the tab in front, not the first file", () => {
  assert.equal(pictureTarget(undefined, "map/war3map.w3e.txt", BOTH, open(...BOTH)), "map/war3map.w3e.txt");
  assert.equal(pictureTarget(undefined, "map/war3map.w3e", BOTH, open(...BOTH)), "map/war3map.w3e");
  assert.equal(pictureTarget(undefined, "Map/War3map.w3e.txt", BOTH, open()), "Map/War3map.w3e.txt", "the tab's own spelling");
});

test("pictureTarget: another tab in front takes an open terrain editor, else the project's own", () => {
  assert.equal(pictureTarget(undefined, "map/war3map.j", BOTH, open("map/war3map.w3e.txt")), "map/war3map.w3e.txt");
  assert.equal(pictureTarget(undefined, null, BOTH, open()), null);
  // A game map's read-only terrain in front isn't one of the project's.
  assert.equal(pictureTarget(undefined, "w3:game:Maps/FrozenThrone/(2)Echo.w3x/war3map.w3e", BOTH, open()), null);
});

test("pictureTarget: the file asked for wins; one that isn't a terrain file of the project is refused", () => {
  assert.equal(pictureTarget("map/war3map.w3e", "map/war3map.w3e.txt", BOTH, open(...BOTH)), "map/war3map.w3e");
  assert.equal(pictureTarget("map\\War3map.w3e.txt", null, BOTH, open()), "map/war3map.w3e.txt");
  assert.throws(() => pictureTarget("map/war3map.w3e.txt", null, ["map/war3map.w3e"], open()), /terrain files: map\/war3map\.w3e\./);
  assert.throws(() => pictureTarget("map/war3map.j", null, BOTH, open()), /terrain files/);
  assert.throws(() => pictureTarget(3, null, BOTH, open()), /terrain files/);
});
