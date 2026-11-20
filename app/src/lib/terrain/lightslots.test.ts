import assert from "node:assert/strict";
import { test } from "node:test";
import { slotKeys } from "./lightslots";

test("Terrain lighting is war3map.w3l's second slot and Unit lighting its first, as the World Editor's Light Editor labels them", () => {
  // we-drive 2026-11-20 (branch we-batch-3): the Light Editor's list on Unit wrote the first slot (the codec's
  // terrainModel / terrainEnabled), on Terrain the second.
  assert.deepEqual(slotKeys("unit"), { model: "terrainModel", enabled: "terrainEnabled" });
  assert.deepEqual(slotKeys("terrain"), { model: "unitModel", enabled: "unitEnabled" });
});
