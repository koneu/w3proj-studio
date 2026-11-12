import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setWater } from "./aitools";
import { parseW3e, type Terrain } from "../../lib/terrain/w3e";

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
/** What the World Editor's click changed, per corner: ground height, layer, water, cliff type. */
const look = (t: Terrain) => t.corners.map((c) => [c.rawHeight, c.layer, c.hasWater, c.hasWater ? c.rawWater : 0, c.cliffTexture, c.texture, c.ramp]);
const kinds = [{ cliffID: "CAgr", groundTile: "Agrd" }];

/** The WE's file, with the cliff variation (the World Editor picks it at random) as it was. */
function expected(name: string, before: Terrain): Terrain {
  const t = load(name);
  t.corners.forEach((c, i) => { c.cliffVariation = before.corners[i].cliffVariation; });
  return t;
}

for (const [mode, file] of [["shallow", "ash-shallow.w3e"], ["deep", "ash-deep.w3e"]] as const) {
  test(`set_water ${mode} on one corner gives the same`, () => {
    const t = load("ash-before.w3e"), want = expected(file, load("ash-before.w3e"));
    const x = t.offsetX + X * 128, y = t.offsetY + Y * 128;
    setWater(t, { left: x - 10, bottom: y - 10, right: x + 10, top: y + 10 }, "box", mode, kinds);
    assert.deepEqual(look(t), look(want));
  });
}

