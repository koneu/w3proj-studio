import assert from "node:assert/strict";
import { test } from "node:test";
import { groundHeight, parseW3e, setGroundHeight, writeW3e, type Terrain } from "../../lib/terrain/w3e";
import { w3eFromText, w3eToText } from "../../lib/terrain/w3etext";
import { HEIGHT_TICK, heightPerPoint, HeightStroke } from "../../lib/terrain/strokepath";
import { applyHeight, applyLayer, matchCliffTypes, paintBoundary, paintTexture, Stroke } from "./tools";

/** A flat 32×32 Lordaeron Summer map covered in grass (Lgrs), cliff level 2, cliff types unset
 *  (15), as the World Editor's New Map makes it. */
function flatMap(): Terrain {
  const width = 33, height = 33;
  const groundTiles = ["Ldrt", "Ldro", "Ldrg", "Lrok", "Lgrs", "Lgrd"];
  return {
    version: 11, tileset: "L", customTilesets: false, customTilesetsRaw: 0, groundTiles, cliffTiles: ["CLdi", "CLgr"],
    width, height, offsetX: -16 * 128, offsetY: -16 * 128, trailer: new Uint8Array(0),
    corners: Array.from({ length: width * height }, () => {
      const c = {
        height: 0, water: -89.6, texture: groundTiles.indexOf("Lgrs"), variation: 0, cliffVariation: 0, cliffTexture: 15, layer: 2,
        ramp: false, blight: false, hasWater: false, boundary: false, rawHeight: 0x2000, rawWater: 0x2000, texExtra: 0,
      };
      setGroundHeight(c, 0);
      return c;
    }),
  };
}
/** The ground tile of each cliff type number on such a map (dirt cliff, grass cliff). */
const CLIFF_GROUND = ["Ldrt", "Lgrs"];

const centre = (t: Terrain) => ({ x: t.offsetX + 16 * 128, y: t.offsetY + 16 * 128 });
/** Cliff layers of the 7×7 corners around the centre, one row per line (north first). */
function layers(t: Terrain): string {
  const rows: string[] = [];
  for (let y = 19; y >= 13; y--) {
    let r = "";
    for (let x = 13; x <= 19; x++) r += t.corners[y * t.width + x].layer.toString(16);
    rows.push(r);
  }
  return rows.join("\n");
}

test("Boundary paints as a stroke of its own, leaves the ground, and comes off again", () => {
  const t = flatMap(), ground = t.corners.map((c) => [c.texture, c.rawHeight, c.layer, c.rawWater]);
  const brush = { x: 0, y: 0, radius: 2, square: true };
  const s = new Stroke("boundary");
  assert.equal(paintBoundary(t, brush, true, s), true);
  assert.equal(s.finish(t), true, "a stroke of nothing but Boundary counts as a change");
  const painted = t.corners.filter((c) => c.boundary).length;
  assert.ok(painted > 0);
  assert.deepEqual(t.corners.map((c) => [c.texture, c.rawHeight, c.layer, c.rawWater]), ground);
  assert.equal(parseW3e(writeW3e(t)).corners.filter((c) => c.boundary).length, painted, "it's in the file");
  s.undo(t);
  assert.equal(t.corners.some((c) => c.boundary), false);
  s.redo(t);
  assert.equal(t.corners.filter((c) => c.boundary).length, painted);
  const off = new Stroke("unboundary");
  assert.equal(paintBoundary(t, brush, false, off), true);
  assert.equal(off.finish(t), true);
  assert.equal(t.corners.some((c) => c.boundary), false);
  assert.equal(paintBoundary(t, brush, false, new Stroke("unboundary")), false, "nothing left to take off");
});

test("square and round cliff brushes, and undo", () => {
  const t = flatMap();
  const s = new Stroke("cliffUp2");
  applyLayer(t, { ...centre(t), radius: 2, square: true }, "cliffUp2", { layer: 4 }, s);
  assert.equal(layers(t), ["2222222", "2444442", "2444442", "2444442", "2444442", "2444442", "2222222"].join("\n"));
  assert.equal(s.finish(t), true);
  s.undo(t);
  assert.equal(layers(t), Array(7).fill("2222222").join("\n"));
  applyLayer(t, { ...centre(t), radius: 2 }, "cliffUp2", { layer: 4 }, new Stroke("cliffUp2"));
  assert.equal(layers(t), ["2222222", "2224222", "2244422", "2444442", "2244422", "2224222", "2222222"].join("\n"));
});

test("a cliff raised on grass becomes a grass cliff, on the cliff corners only", () => {
  const t = flatMap();
  const s = new Stroke("cliffUp");
  applyLayer(t, { ...centre(t), radius: 2, square: true }, "cliffUp", { layer: 3 }, s);
  assert.equal(matchCliffTypes(t, s.corners(), CLIFF_GROUND, s), true);
  // The ring of the raised square and the ring around it form the cliff tiles; inside and outside stay 15.
  const at = (x: number, y: number) => t.corners[y * t.width + x].cliffTexture;
  assert.equal(at(14, 16), 1);
  assert.equal(at(13, 16), 1);
  assert.equal(at(16, 16), 15);
  assert.equal(at(11, 16), 15);
});

/** A drag across the map at a speed, with the clock ticking `ms` apart while the mouse reports
 *  many times in between, as the painter runs it. `busy` makes every third tick late. */
function drag(speedPerMs: number, ms: number, busy = false) {
  const t = flatMap(), s = new Stroke("raise"), radius = 2, y = 0, from = -800, to = 800;
  const brush = new HeightStroke([from, y], -HEIGHT_TICK, radius * 64);
  let now = 0, at = from, n = 0;
  const stamp = () => { for (const d of brush.tick(now, 16)) applyHeight(t, { x: d.x, y: d.y, radius }, "raise", d.amount, s); };
  stamp();
  while (at < to) {
    const step = busy && ++n % 3 === 0 ? ms * 3 : ms;
    for (let m = 0; m < 5; m++) { at = Math.min(to, at + (speedPerMs * step) / 5); brush.moveTo([at, y]); }
    now += step;
    stamp();
  }
  return [...Array(9).keys()].map((i) => groundHeight(t.corners[16 * t.width + 12 + i]));
}

test("a quick drag is one even ridge, not bumps", () => {
  const ridge = drag(8, 40);
  assert.ok(Math.min(...ridge) > 0, ridge.join());
  assert.ok(Math.max(...ridge) / Math.min(...ridge) < 1.4, ridge.join());
});

test("a busy app doesn't leave bumps on a quick drag", () => {
  const ridge = drag(8, 40, true);
  assert.ok(Math.min(...ridge) > 0, ridge.join());
  assert.ok(Math.max(...ridge) / Math.min(...ridge) < 1.4, ridge.join());
});

test("standing still keeps adding at the same place", () => {
  const brush = new HeightStroke([100, 100], 0, 128);
  assert.deepEqual(brush.tick(HEIGHT_TICK, 16), [{ x: 100, y: 100, amount: 16 }]);
  assert.deepEqual(brush.tick(HEIGHT_TICK * 2, 16), [{ x: 100, y: 100, amount: 16 }]);
});

test("a stamp only ever goes to the newest place, never back", () => {
  const brush = new HeightStroke([0, 0], 0, 128);
  brush.moveTo([50, 0]);
  brush.moveTo([1000, 0]);
  const stamps = brush.tick(HEIGHT_TICK, 16);
  assert.equal(stamps[stamps.length - 1].x, 1000);
  assert.deepEqual(brush.tick(HEIGHT_TICK * 2, 16).map((d) => d.x), [1000]);
});

test("a drag adds less the faster it goes, not more", () => {
  const slow = Math.max(...drag(2, 40)), quick = Math.max(...drag(8, 40));
  assert.ok(quick < slow, `${quick} ${slow}`);
});

test("how often the mouse reports doesn't change the height", () => {
  const often = drag(4, 20), seldom = drag(4, 80);
  assert.ok(Math.abs(Math.max(...often) - Math.max(...seldom)) / Math.max(...often) < 0.25, `${often} ${seldom}`);
});

test("height goes by time, and a stall doesn't count in full", () => {
  assert.equal(heightPerPoint(16, HEIGHT_TICK, 1), 16);
  assert.equal(heightPerPoint(16, HEIGHT_TICK * 2, 2), 16);
  assert.equal(heightPerPoint(16, 5000, 1), heightPerPoint(16, 200, 1));
});

test("a chosen cliff type wins over the ground", () => {
  const t = flatMap();
  const s = new Stroke("cliffUp");
  applyLayer(t, { ...centre(t), radius: 2, square: true }, "cliffUp", { layer: 3 }, s);
  matchCliffTypes(t, s.corners(), CLIFF_GROUND, s, 0);
  assert.equal(t.corners[16 * t.width + 14].cliffTexture, 0);
});

test("painting grass at a dirt cliff makes it a grass cliff; flat ground keeps its cliff type", () => {
  const t = flatMap();
  const up = new Stroke("cliffUp");
  applyLayer(t, { ...centre(t), radius: 2, square: true }, "cliffUp", { layer: 3 }, up);
  matchCliffTypes(t, up.corners(), CLIFF_GROUND, up, 0);
  // The ground is grass already (only the dirt cliff's rim looks like dirt): painting grass
  // changes no texture, yet the cliff must follow (the area the brush covered counts).
  const s = new Stroke("paint");
  assert.equal(paintTexture(t, { ...centre(t), radius: 4 }, t.groundTiles.indexOf("Lgrs"), s), false);
  assert.equal(matchCliffTypes(t, s.area(), CLIFF_GROUND, s), true);
  assert.equal(t.corners[16 * t.width + 14].cliffTexture, 1);
  assert.equal(s.finish(t), true);
  const far = new Stroke("paint");
  paintTexture(t, { x: t.offsetX + 4 * 128, y: t.offsetY + 4 * 128, radius: 1 }, t.groundTiles.indexOf("Ldrt"), far);
  assert.equal(matchCliffTypes(t, far.area(), CLIFF_GROUND, far), false);
});

test("the terrain survives w3e and text round trips", () => {
  const t = flatMap();
  applyLayer(t, { ...centre(t), radius: 2 }, "cliffUp", { layer: 3 }, new Stroke("cliffUp"));
  const bytes = writeW3e(t);
  assert.deepEqual(writeW3e(parseW3e(bytes)), bytes);
  assert.deepEqual(w3eFromText(w3eToText(bytes)), bytes);
});
