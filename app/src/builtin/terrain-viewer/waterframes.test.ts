import assert from "node:assert/strict";
import { test } from "node:test";
import { countingGl, tinyTga } from "../../lib/testhelpers/countinggl";
import { decodeImage } from "../../lib/image/index";
import { TerrainRenderer } from "./renderer";

// The water's animation frames are textures of the view: a reload of the tileset's art (an import changed) sets the
// look and its frames again, and the frames before must be deleted, not left to the garbage collector.

const img = () => decodeImage(tinyTga(), "frame.tga");
const look = { rate: 15, shallowMin: [0, 0, 0, 0], shallowMax: [0, 0, 0, 0], deepMin: [0, 0, 0, 0], deepMax: [0, 0, 0, 0], lit: false };

/** A renderer with only what setWaterLook and setWaterFrame use: the whole view needs a real canvas. */
function waterOnly() {
  const c = countingGl();
  const r = Object.create(TerrainRenderer.prototype) as TerrainRenderer;
  Object.assign(r, { gl: c.gl, waterLook: { ...look, frames: [] }, waterFrameShown: -1 });
  return { c, r };
}

test("water frames: setting the look again deletes the frames before; five reloads keep the count flat", () => {
  const { c, r } = waterOnly();
  const load = () => {
    r.setWaterLook(look, 45);
    for (let i = 0; i < 45; i++) r.setWaterFrame(i, img());
  };
  load();
  assert.equal(c.live.texture.size, 45);
  for (let n = 0; n < 5; n++) load();
  assert.equal(c.live.texture.size, 45, "the frames of the looks before are gone");
  assert.deepEqual(c.bad, [], "nothing deleted twice");
});

test("water frames: a frame set twice deletes the one it replaces; one past the look's count makes nothing", () => {
  const { c, r } = waterOnly();
  r.setWaterLook(look, 2);
  r.setWaterFrame(0, img());
  r.setWaterFrame(0, img());
  r.setWaterFrame(5, img());
  assert.equal(c.live.texture.size, 1);
  assert.equal(c.deletes.texture, 1);
  assert.deepEqual(c.bad, []);
});
