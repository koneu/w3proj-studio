import assert from "node:assert/strict";
import { test } from "node:test";
import { slotKeys } from "./slots";
import { ownLightFile } from "../terrain-viewer/lighting";

test("Terrain lighting is war3map.w3l's second slot and Unit lighting its first, as the World Editor's Light Editor labels them", () => {
  // we-drive 2026-11-20 (branch we-batch-3): the Light Editor's list on Unit wrote the first slot (the codec's
  // terrainModel / terrainEnabled), on Terrain the second.
  assert.deepEqual(slotKeys("unit"), { model: "terrainModel", enabled: "terrainEnabled" });
  assert.deepEqual(slotKeys("terrain"), { model: "unitModel", enabled: "unitEnabled" });
  // The view lights each by the slot the editor's label names (ownLightFile: the ground by the second slot).
  const w3l = { terrainModel: "first.mdl", unitModel: "second.mdl", terrainEnabled: 1, unitEnabled: 1 };
  for (const kind of ["terrain", "unit"] as const) assert.equal(ownLightFile(w3l, kind), w3l[slotKeys(kind).model], kind);
});
