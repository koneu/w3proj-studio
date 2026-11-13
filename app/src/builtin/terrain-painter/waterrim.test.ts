import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { applyLayer, retypeCliffs, Stroke, cornerBrush } from "./tools";
import { flattenWaterRim } from "../../lib/terrain/waterrim";
import { waterLevelAt, WATER_OFFSET, parseW3e, type Terrain } from "../../lib/terrain/w3e";
import { w3eFromText } from "../../lib/terrain/w3etext";

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
    // Brush size 1, the click a little off the corner: the brush takes the nearest corner alone.
    const brush = cornerBrush(t, t.offsetX + X * 128 + 40, t.offsetY + Y * 128 - 30, 1);
    assert.equal(applyLayer(t, brush, mode, { layer, waterLevel: waterLevelAt(c.height - WATER_OFFSET) }, stroke), true);
    retypeCliffs(t, stroke, ["Agrd"]);
    assert.deepEqual(look(t), look(want));
    assert.equal(stroke.corners().filter((i) => at(t, i % t.width, Math.floor(i / t.width)).rawHeight !== load("ash-before.w3e").corners[i].rawHeight).length, 12, "12 neighbours");
  });
}

/** A fixture of tests/fixtures/water-brush that is JSON. */
function json<T>(name: string): T {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const p = join(dir, "tests", "fixtures", "water-brush", name);
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as T;
    if (dirname(dir) === dir) throw new Error(`tests/fixtures/water-brush/${name} not found`);
  }
}

/** The empty map the World Editor's size 2 and 3 clicks were made on: 65 x 65 corners, layer 2, height 0, Dirt. */
function emptyLordaeron(): Terrain {
  const text = ["W3E version 12", "tileset L", "custom-tilesets 0", "ground Ldrt Ldro Ldrg Lrok Lgrs Lgrd", "cliffs CLdi CLgr", "corners 65 65",
    "offset -4096 -4096", "[height] all 0", "[water] all 0", "[water-bits] all 0", "[texture] all 0", "[variation] all 0",
    "[cliff-variation] all 0", "[cliff-texture] all f", "[layer] all 2", "[flags] all 0"].join("\n");
  return parseW3e(w3eFromText(text));
}

for (const size of [2, 3]) {
  test(`the Shallow Water brush of size ${size} takes the corners the World Editor's does`, () => {
    const we = json<{ centre: [number, number]; changes: { x: number; y: number; section: string; after: string }[] }>(`lordaeron-shallow-size${size}.json`);
    const t = emptyLordaeron(), before = emptyLordaeron();
    const [cx, cy] = we.centre, c = at(t, cx, cy);
    const stroke = new Stroke("shallow");
    // The click lands a little off the corner, as a click does.
    const brush = cornerBrush(t, t.offsetX + cx * 128 - 50, t.offsetY + cy * 128 + 20, size);
    assert.equal(applyLayer(t, brush, "shallow", { layer: c.layer - 1, waterLevel: waterLevelAt(c.height - WATER_OFFSET) }, stroke), true);
    // The cliff type the World Editor's palette had chosen: Grass Cliff, the map's second.
    retypeCliffs(t, stroke, ["Ldrt", "Lgrs"], 1);
    const key = (x: number, y: number) => `${x},${y}`;
    const weSet = (section: string) => we.changes.filter((e) => e.section === section).map((e) => key(e.x, e.y)).sort();
    const ours = (changed: (a: Terrain["corners"][number], b: Terrain["corners"][number]) => boolean) =>
      t.corners.flatMap((k, i) => (changed(k, before.corners[i]) ? [key(i % t.width, Math.floor(i / t.width))] : [])).sort();
    assert.deepEqual(ours((a, b) => a.layer !== b.layer), weSet("layer"), "layer 2 to 1");
    assert.deepEqual(ours((a, b) => a.hasWater !== b.hasWater), weSet("flags"), "the water flag");
    assert.equal(we.changes.filter((e) => e.section === "flags").every((e) => e.after === "4"), true, "the World Editor's flag is the water bit (control)");
    assert.deepEqual(ours((a, b) => a.cliffTexture !== b.cliffTexture), weSet("cliff-texture"), "cliff type");
    assert.equal(t.corners.every((k) => k.cliffTexture === 1 || k.cliffTexture === 15), true);
    assert.deepEqual(ours((a, b) => a.rawHeight !== b.rawHeight || a.texture !== b.texture || (a.rawWater & 0x3fff) !== (b.rawWater & 0x3fff)), [], "height, ground and water level as they were");
    assert.equal(weSet("layer").length, size === 2 ? 5 : 13);
  });
}

test("the water brush: centred on the nearest corner, size − 1 tiles round it", () => {
  const t = emptyLordaeron();
  assert.deepEqual(cornerBrush(t, 70, -200, 1), { x: 128, y: -256, radius: 0, square: false });
  assert.deepEqual(cornerBrush(t, -63, 63, 3, true), { x: 0, y: 0, radius: 2, square: true });
  assert.equal(cornerBrush(t, 0, 0, 0).radius, 0, "never less than one corner");
});

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
