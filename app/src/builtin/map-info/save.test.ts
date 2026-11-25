import assert from "node:assert/strict";
import { test } from "node:test";
import { infoAsSaved } from "./save";

const info = (cameraZoom: object | undefined) => ({
  version: 33, flags: 0x0002, // Modify ally priorities: they stay as stored
  players: [{ id: 0, allyLow: 0, allyHigh: 0, start: [0, 0] }], forces: [{ players: 1 }],
  ...(cameraZoom ? { cameraZoom } : {}),
});

test("Map Properties' save writes 1250 into a camera zoom of 0, as the World Editor's save with Force camera zoom unticked", () => {
  const i = info({ default: 0, max: 0, min: 0 });
  infoAsSaved(i);
  assert.deepEqual(i.cameraZoom, { default: 1250, max: 1250, min: 1250 });
  const v32 = info({ default: 0, max: 0 });
  infoAsSaved(v32);
  assert.deepEqual(v32.cameraZoom, { default: 1250, max: 1250 }, "a v32 file has no minimum, and gets none");
});

test("a camera zoom already set, or none in the file, is saved as it is", () => {
  for (const z of [{ default: 1650, max: 3000, min: 1250 }, { default: 0, max: 0, min: 400 }, { default: 1650, max: 0, min: 0 }]) {
    const i = info({ ...z });
    infoAsSaved(i);
    assert.deepEqual(i.cameraZoom, z);
  }
  const old = info(undefined);
  infoAsSaved(old);
  assert.equal("cameraZoom" in old, false, "an older w3i gets none");
});
