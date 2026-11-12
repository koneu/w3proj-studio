import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { applyLayer, matchCliffTypes, Stroke } from "./tools";
import { flattenWaterRim } from "../../lib/terrain/waterrim";
import { waterLevelAt, WATER_OFFSET, parseW3e, type Terrain } from "../../lib/terrain/w3e";

/** A file of tests/fixtures/water-brush: the w3e of Ashenvale's 12a_RoC_Orc04Interlude_v0_control.w3m as it was, and
 *  as the World Editor saved it after one Shallow (and one Deep) brush click on corner 50,24, found from where the
 *  tests run (app/ or the repository). */
function load(name: string): Terrain {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const p = join(dir, "tests", "fixtures", "water-brush", name);
    if (existsSync(p)) return parseW3e(new Uint8Array(readFileSync(p)));
    if (dirname(dir) === dir) throw new Error(`tests/fixtures/water-brush/${name} not found`);
  }
}
const X = 50, Y = 24;
const at = (t: Terrain, x: number, y: number) => t.corners[y * t.width + x];
/** What the World Editor's click changed, per corner: ground height, layer, water, cliff type. */
const look = (t: Terrain) => t.corners.map((c) => [c.rawHeight, c.layer, c.hasWater, c.hasWater ? c.rawWater : 0, c.cliffTexture, c.texture, c.ramp]);

/** The WE's file, with the cliff variation (the World Editor picks it at random) as it was. */
function expected(name: string, before: Terrain): Terrain {
  const t = load(name);
  t.corners.forEach((c, i) => { c.cliffVariation = before.corners[i].cliffVariation; });
  return t;
}

for (const [mode, file] of [["shallow", "ash-shallow.w3e"], ["deep", "ash-deep.w3e"]] as const) {
  test(`the ${mode} brush on one corner levels the ground two corners round it, as the World Editor`, () => {
    const t = load("ash-before.w3e"), want = expected(file, load("ash-before.w3e"));
    const c = at(t, X, Y);
    const layer = c.layer - (mode === "deep" ? 2 : 1);
    const stroke = new Stroke(mode);
    assert.equal(applyLayer(t, { x: t.offsetX + X * 128, y: t.offsetY + Y * 128, radius: 0.01 }, mode, { layer, waterLevel: waterLevelAt(c.height - WATER_OFFSET) }, stroke), true);
    matchCliffTypes(t, stroke.area(), ["Agrd"], stroke);
    assert.deepEqual(look(t), look(want));
    assert.equal(stroke.corners().filter((i) => at(t, i % t.width, Math.floor(i / t.width)).rawHeight !== load("ash-before.w3e").corners[i].rawHeight).length, 12, "12 neighbours");
  });
}

test("the rim leaves what is on another layer, in the brush or already water", () => {
  const t = load("ash-before.w3e");
  const i = Y * t.width + X;
  at(t, X + 1, Y).layer = 4;
  at(t, X - 1, Y).hasWater = true;
  const before = look(t);
  const changed = flattenWaterRim(t, [i], new Set([i, i + t.width]), () => {});
  assert.equal(changed.includes(i + t.width), false, "in the brush");
  assert.equal(changed.includes(i + 1), false, "other layer");
  assert.equal(changed.includes(i - 1), false, "water");
  assert.equal(changed.includes(i + 2), true, "reaches past a skipped one");
  const after = look(t);
  assert.deepEqual(after[i + 1], before[i + 1]);
  assert.deepEqual(after[i - 1], before[i - 1]);
});

test("the rim takes the height of the nearest wet corner", () => {
  const t = load("ash-before.w3e");
  const a = Y * t.width + 20, b = Y * t.width + 26;
  at(t, 20, Y).rawHeight = 8300; at(t, 26, Y).rawHeight = 8900;
  flattenWaterRim(t, [a, b], new Set([a, b]), () => {});
  assert.equal(at(t, 21, Y).rawHeight, 8300);
  assert.equal(at(t, 25, Y).rawHeight, 8900);
  assert.equal(at(t, 20, Y + 2).rawHeight, 8300);
  assert.equal(at(t, 20, Y + 1).rawHeight, 8300);
});
