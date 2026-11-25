import assert from "node:assert/strict";
import { test } from "node:test";
import { namedTerrainFog } from "./terrainfog";

const rest = { linearStart: 1500, linearEnd: 6000, maxOpacity: 0.75 };

test("older JSON's terrain fog gets its names with the same bits, as the codec reads it (w3i.json was/wasType)", () => {
  // Height Start 250 and End -125 as the i32 of their bits, Draw Fog Over Sky 1 as the f32 of bits 1.
  assert.deepEqual(namedTerrainFog({ style: 1132068864, overSky: -1023803392, ...rest, height: 1e-45 }),
    { heightStart: 250, heightEnd: -125, ...rest, drawOverSky: 1 });
  // Bits that are no finite f32 keep them as the codec writes them; an "f32:0x…" goes back to its bits.
  assert.deepEqual(namedTerrainFog({ style: 2143289345, overSky: -8388608, ...rest, height: "f32:0x7fc00000" }),
    { heightStart: "f32:0x7fc00001", heightEnd: "f32:0xff800000", ...rest, drawOverSky: 0x7fc00000 });
  // A name wins and the old key goes; the input stays as it was; nothing to name stays as it is.
  const both = { heightStart: 7, style: 5, heightEnd: 1, overSky: 2, ...rest, drawOverSky: 0, height: 1 };
  assert.deepEqual(namedTerrainFog(both), { heightStart: 7, heightEnd: 1, ...rest, drawOverSky: 0 });
  assert.equal(both.style, 5);
  assert.equal(namedTerrainFog(undefined), undefined);
  const named = { heightStart: 1, heightEnd: 0, ...rest, drawOverSky: 1 };
  assert.deepEqual(namedTerrainFog(named), named);
});
