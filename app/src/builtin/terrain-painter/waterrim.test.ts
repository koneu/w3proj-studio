import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { applyLayer, retypeCliffs, Stroke, cornerBrush } from "./tools";
import { flattenWaterRim } from "../../lib/terrain/waterrim";
import { setGroundHeight, waterLevelAt, WATER_OFFSET, parseW3e, type Terrain } from "../../lib/terrain/w3e";
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

test("the AI tools' rim leaves what is on another layer, in the area or already water", () => {
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

test("the AI tools' rim takes the height of the nearest wet corner", () => {
  const t = load("ash-before.w3e");
  const a = Y * t.width + 20, b = Y * t.width + 26;
  at(t, 20, Y).rawHeight = 8300; at(t, 26, Y).rawHeight = 8900;
  flattenWaterRim(t, [a, b], new Set([a, b]), () => {});
  assert.equal(at(t, 21, Y).rawHeight, 8300);
  assert.equal(at(t, 25, Y).rawHeight, 8900);
  assert.equal(at(t, 20, Y + 2).rawHeight, 8300);
  assert.equal(at(t, 20, Y + 1).rawHeight, 8300);
});

/** tests/fixtures/water-brush/slope-clicks.json: the World Editor's water clicks on the we-compare slope maps. */
interface SlopeClick { name: string; input: "slope" | "edge"; mode: "shallow" | "deep"; size: number; centre: [number, number]; changes: number[][] }

/** tests/fixtures/we-specs/slope.w3x (or slope-edge.w3x) as a terrain: make-slope.mjs and make-water-inputs.mjs. */
function slopeMap(edge: boolean): Terrain {
  const rows = (f: (x: number) => string, sep = "") => Array.from({ length: 65 }, () => Array.from({ length: 65 }, (_, x) => f(x)).join(sep));
  const text = ["W3E version 12", "tileset L", "custom-tilesets 0", "ground Ldrt Ldro Ldrg Lrok Lgrs Lgrd", "cliffs CLdi CLgr", "corners 65 65",
    "offset -4096 -4096", "[height]", ...rows((x) => String((x - 32) * 24), " "), "[water] all 0", "[water-bits] all 0", "[texture] all 0",
    "[variation] all 0", "[cliff-variation] all 0",
    ...(edge ? ["[cliff-texture]", ...rows((x) => (x === 33 || x === 34 ? "0" : "f")), "[layer]", ...rows((x) => (x >= 34 ? "3" : "2"))] : ["[cliff-texture] all f", "[layer] all 2"]),
    "[flags] all 0"].join("\n");
  return parseW3e(w3eFromText(text));
}

/** What a corner holds that the fixture lists: ground (stored, minus 0x2000), layer, water flag, water word, cliff type. */
const fields = (c: Terrain["corners"][number]) => [c.rawHeight - 0x2000, c.layer, c.hasWater ? 1 : 0, c.rawWater & 0x3fff, c.cliffTexture];

/** What Studio doesn't do as the World Editor yet, per click: the fields (of ground, layer, wet, water, type) that
 *  still differ somewhere, and why (waterrim.ts). On the high side of a cliff edge the editor typed the corners it
 *  raised as the plateau's cliff (0) and left the outer rim of the new cliff untyped (15); Studio gives them the chosen
 *  type (1). */
const NOT_YET: Record<string, { fields: string[]; why: string }> = {
  "water-brush-edge-high": { fields: ["type"], why: "the raised corners' cliff type" },
  "water-brush-edge-high-far": { fields: ["type"], why: "the raised corners' cliff type" },
  "water-brush-edge-high-deep": { fields: ["type"], why: "the raised corners' cliff type" },
  "water-brush-edge-low-deep": { fields: ["layer", "wet", "type"], why: "the editor left one water corner dry next to a corner it kept a level up (a 3-level cliff refused)" },
};
const FIELDS = ["ground", "layer", "wet", "water", "type"];

/** The painter's click: the brush round the nearest corner, the water one or two levels below it with the surface the
 *  water offset under its ground, Grass Cliff (the palette's start) for the cliffs (index.ts). */
function click(t: Terrain, c: SlopeClick) {
  const [cx, cy] = c.centre, from = at(t, cx, cy);
  const stroke = new Stroke(c.mode);
  const brush = cornerBrush(t, t.offsetX + cx * 128 + 30, t.offsetY + cy * 128 - 20, c.size);
  // Enforce Water Height Limits on, as the editor had it (we-drive pins it): the ground here is far above the floor.
  applyLayer(t, brush, c.mode, { layer: from.layer - (c.mode === "deep" ? 2 : 1), waterLevel: waterLevelAt(from.height - WATER_OFFSET), start: from.layer }, stroke, true);
  retypeCliffs(t, stroke, ["Ldrt", "Lgrs"], 1);
  return stroke;
}

for (const c of json<{ clicks: SlopeClick[] }>("slope-clicks.json").clicks) {
  const notYet = NOT_YET[c.name];
  test(`${c.name}: ${c.mode} size ${c.size} at ${c.centre} on the ${c.input} map, as the World Editor${notYet ? ` but ${notYet.fields.join(", ")} (${notYet.why})` : ""}`, () => {
    const t = slopeMap(c.input === "edge"), want = slopeMap(c.input === "edge");
    for (const [x, y, ground, layer, wet, water, type] of c.changes) {
      const k = at(want, x, y);
      k.rawHeight = ground + 0x2000; k.layer = layer; k.hasWater = wet === 1; k.rawWater = (k.rawWater & 0xc000) | water; k.cliffTexture = type;
    }
    click(t, c);
    // Within the brush's reach (size + 2 corners round the centre): the editor re-typed a whole cliff edge once, far
    // from the click (edge-low; not again in edge-low-deep), which isn't followed.
    const reach = c.size + 2, diffs: string[] = [], differing = new Set<string>();
    for (let y = c.centre[1] - reach; y <= c.centre[1] + reach; y++) for (let x = c.centre[0] - reach; x <= c.centre[0] + reach; x++) {
      const a = fields(at(t, x, y)), b = fields(at(want, x, y));
      const off = FIELDS.filter((_, k) => a[k] !== b[k] && !notYet?.fields.includes(FIELDS[k]));
      FIELDS.forEach((f, k) => { if (a[k] !== b[k]) differing.add(f); });
      if (off.length) diffs.push(`${x},${y} ${off.join(" ")}: Studio ${a.join(" ")}, WE ${b.join(" ")}`);
    }
    assert.deepEqual(diffs, []);
    if (notYet) assert.deepEqual([...differing].sort(), [...notYet.fields].sort(), "the known differences are all there (when one goes, take it off NOT_YET)");
  });
}

test("the water brush flattens round the clicked corner, not round the nearest water corner (control: the old rule fails)", () => {
  // The size 3 click on the slope: the editor's ground of the 47 corners within 4 is the clicked corner's (0), so the
  // water corners at the brush's rim (x = 30, 34) are flattened too, which a rule by the nearest water corner leaves.
  const c = json<{ clicks: SlopeClick[] }>("slope-clicks.json").clicks.find((k) => k.name === "water-brush-slope-shallow")!;
  const t = slopeMap(false);
  click(t, c);
  assert.equal(at(t, 30, 30).rawHeight - 0x2000, 0);
  assert.equal(at(t, 34, 30).rawHeight - 0x2000, 0);
  assert.equal(at(t, 36, 30).rawHeight - 0x2000, 0, "four corners out");
  assert.equal(at(t, 37, 30).rawHeight - 0x2000, 120, "five out: as it was");
  assert.equal(c.changes.filter(([, , g]) => g === 0).length, 47, "the fixture: the editor's 47 corners at 0");
});

/** tests/fixtures/water-brush/low-ground-lift.json: the World Editor's water clicks on low flat ground. */
interface LowGround { centre: [number, number]; cases: { ground: { rest: number; centre?: number; next?: number }; tool: "shallow" | "deep"; size: number; changes: number[][] }[] }
const lowGround = json<LowGround>("low-ground-lift.json");

/** The empty Lordaeron map with every stored ground height `rest`, the centre (or its four neighbours) set apart. */
function lowMap(g: LowGround["cases"][number]["ground"], [cx, cy]: [number, number]): Terrain {
  const t = emptyLordaeron();
  t.corners.forEach((c, i) => {
    const d = Math.abs((i % t.width) - cx) + Math.abs(Math.floor(i / t.width) - cy);
    const h = d === 0 && g.centre !== undefined ? g.centre : d === 1 && g.next !== undefined ? g.next : g.rest;
    setGroundHeight(c, h / 4);
  });
  return t;
}

/** The painter's click on the low map, Enforce Water Height Limits on or off. */
function lowClick(t: Terrain, mode: "shallow" | "deep", size: number, [cx, cy]: [number, number], enforce: boolean) {
  const from = at(t, cx, cy);
  const brush = cornerBrush(t, t.offsetX + cx * 128 + 30, t.offsetY + cy * 128 - 20, size);
  applyLayer(t, brush, mode, { layer: from.layer - (mode === "deep" ? 2 : 1), waterLevel: waterLevelAt(from.height - WATER_OFFSET), start: from.layer }, new Stroke(mode), enforce);
}

for (const c of lowGround.cases) {
  const g = c.ground;
  const ground = g.centre !== undefined ? `${g.centre} at the centre, ${g.rest} round it` : g.next !== undefined ? `${g.next} next to the centre, ${g.rest} elsewhere` : `${g.rest}`;
  test(`low ground (stored ${ground}): the ${c.tool} brush of size ${c.size} lifts the ground as the World Editor's (${c.changes.length} corners)`, () => {
    const t = lowMap(g, lowGround.centre), want = lowMap(g, lowGround.centre);
    for (const [x, y, h] of c.changes) at(want, x, y).rawHeight = h + 0x2000;
    lowClick(t, c.tool, c.size, lowGround.centre, true);
    const diffs = t.corners.flatMap((k, i) => k.rawHeight === want.corners[i].rawHeight ? []
      : [`${i % t.width},${Math.floor(i / t.width)}: Studio ${k.rawHeight - 0x2000}, WE ${want.corners[i].rawHeight - 0x2000}`]);
    assert.deepEqual(diffs, []);
  });
}

test("low ground: the lift is the switch's (off: the ground stays; control for the cases above)", () => {
  const c = lowGround.cases.find((k) => k.ground.rest === -8160 && k.tool === "deep" && k.size === 1 && k.ground.centre === undefined)!;
  assert.equal(c.changes.length, 37, "the fixture: the editor lifted 37 corners");
  const t = lowMap(c.ground, lowGround.centre);
  lowClick(t, "deep", 1, lowGround.centre, false);
  assert.equal(t.corners.every((k) => k.rawHeight - 0x2000 === -8160), true);
  const on = lowMap(c.ground, lowGround.centre);
  lowClick(on, "deep", 1, lowGround.centre, true);
  assert.equal(at(on, ...lowGround.centre).height, -2048, "the clicked corner on the floor (waterrim.ts GROUND_FLOOR), its cliff level counted in");
  assert.equal(at(on, ...lowGround.centre).rawHeight - 0x2000, -7168);
});
