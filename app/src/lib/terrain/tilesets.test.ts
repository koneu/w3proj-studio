import assert from "node:assert/strict";
import { test } from "node:test";
import { customTilesFlag } from "./tilesets";

const own = ["Ldrt", "Ldro", "Ldrg", "Lrok", "Lgrs", "Lgrd"];

test("a tile list that is exactly its tileset's own isn't custom", () => {
  assert.equal(customTilesFlag([...own], own), 0);
});

test("any other list is custom: another order, a tile more or less, another tileset's", () => {
  assert.equal(customTilesFlag([own[1], own[0], ...own.slice(2)], own), 1);
  assert.equal(customTilesFlag(own.slice(0, -1), own), 1);
  assert.equal(customTilesFlag([...own, "Agrs"], own), 1);
  assert.equal(customTilesFlag(["Adrt", "Adrd"], own), 1);
});

test("with the tileset's list unknown the flag stays set", () => {
  assert.equal(customTilesFlag([...own], undefined), 1);
});
