import assert from "node:assert/strict";
import { test } from "node:test";
import { readLightMdl, readLightMdx, type LightModel } from "../../lib/model/dnclight";
import { exportBytes } from "./export";

const model: LightModel = { version: 1800, name: "L", blendTime: 150, sequences: [{ name: "Stand", start: 0, end: 60000, moveSpeed: 0, nonLooping: false, rarity: 0 }], globalSequences: [], lights: [], pivots: [] };

test("the export's ending picks the form: .mdx bytes or .mdl text, in either case; another ending is refused", () => {
  assert.equal(readLightMdx(exportBytes(model, "/a/Light.MDX")).name, "L");
  assert.equal(readLightMdl(new TextDecoder().decode(exportBytes(model, "C:\\a\\Light.mdl"))).name, "L");
  assert.throws(() => exportBytes(model, "/a/Light.txt"), /\.mdx or \.mdl/);
});
