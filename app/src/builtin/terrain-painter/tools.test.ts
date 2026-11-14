import assert from "node:assert/strict";
import { test } from "node:test";
import { groundHeight, parseW3e, setGroundHeight, writeW3e, type Terrain } from "../../lib/terrain/w3e";
import { w3eFromText, w3eToText } from "../../lib/terrain/w3etext";
import { HEIGHT_TICK, heightPerPoint, HeightStroke } from "../../lib/terrain/strokepath";
import { applyHeight, applyLayer, brushOf, brushReach, matchCliffTypes, paintBoundary, paintTexture, retypeCliffs, Stroke } from "./tools";
import * as painterTools from "./tools";

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

/** The World Editor's corners per brush size (we-drive, one click each on a flat map: Raise One in verify round 3 item 7,
 *  a grass texture in verify3-we-diffs, both 2026-11-13): sizes 1, 2, 3, 5, 8. */
const WE_CORNERS: [number, number][] = [[1, 1], [2, 5], [3, 13], [5, 49], [8, 149]];

test("cliff and texture brushes take the World Editor's corners: a disc of radius size − 1 round the nearest corner", () => {
  // Pointers all over the centre corner's cell (the World Editor's count doesn't depend on where in it).
  const pointers = [[0, 0], [40, -30], [-63, 63], [63, -63], [-20, 50]];
  for (const [size, want] of WE_CORNERS) {
    for (const [dx, dy] of pointers) {
      const t = flatMap(), { x, y } = centre(t);
      const s = new Stroke("cliffUp");
      applyLayer(t, brushOf("cliffUp", t, x + dx, y + dy, size), "cliffUp", { layer: 3 }, s);
      const raised = t.corners.flatMap((c, i) => (c.layer === 3 ? [i] : []));
      assert.equal(raised.length, want, `+1 size ${size} at +${dx},${dy}`);
      // Centred on the centre corner: as many corners each side of it.
      const xs = raised.map((i) => (i % t.width) - 16), ys = raised.map((i) => Math.floor(i / t.width) - 16);
      assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [1 - size, size - 1, 1 - size, size - 1], `size ${size} at +${dx},${dy}`);

      const p = flatMap(), dirt = p.groundTiles.indexOf("Ldrt");
      paintTexture(p, brushOf("paint", p, x + dx, y + dy, size), dirt, new Stroke("paint"));
      assert.equal(p.corners.filter((c) => c.texture === dirt).length, want, `texture size ${size} at +${dx},${dy}`);
      for (const tool of ["blight", "cliffDown", "deep", "dry"]) assert.deepEqual(brushOf(tool, t, x + dx, y + dy, size), brushOf("paint", t, x + dx, y + dy, size), tool);
    }
  }
});

test("Boundary brushes are centred on the lower-left corner of the tile under the pointer, as the World Editor's", () => {
  // we-drive, 2026-11-14 (branch boundary-we): size-1 clicks at 0.2, 0.4, 0.6 and 0.8 of a tile in x and y each flagged
  // the corner below and left of the pointer; sizes 2, 3 and 5 took 5, 13 and 49 corners round it.
  for (const [size, want] of [[1, 1], [2, 5], [3, 13], [5, 49]]) {
    for (const [fx, fy] of [[0.2, 0.8], [0.4, 0.6], [0.6, 0.4], [0.8, 0.2], [0, 0.66]]) {
      const t = flatMap(), { x, y } = centre(t);
      for (const tool of ["boundary", "unboundary"]) {
        const b = brushOf(tool, t, x + fx * 128, y + fy * 128, size);
        assert.deepEqual([b.x, b.y, b.radius], [x, y, size - 1], `${tool} size ${size} at ${fx},${fy} of the tile`);
      }
      paintBoundary(t, brushOf("boundary", t, x + fx * 128, y + fy * 128, size), true, new Stroke("boundary"));
      assert.equal(t.corners.filter((c) => c.boundary).length, want, `size ${size}`);
      assert.ok(t.corners[16 * t.width + 16].boundary, "the tile's lower-left corner is painted");
    }
  }
  // On a corner line, a hair to the left of it by rounding in the pick: still the tile past the line (the World Editor's
  // click at the view's centre column flagged column 32).
  const t = flatMap(), { x, y } = centre(t);
  assert.equal(brushOf("boundary", t, x - 1e-9, y + 40, 1).x, x);
  assert.equal(brushOf("boundary", t, x - 10, y + 40, 1).x, x - 128, "a real step left is the tile to the left");
});

test("height brushes take the World Editor's corners: inside radius size − 1 round the nearest corner, not its rim", () => {
  // we-drive, Raise, one click each on flat ground (2026-11-13): 1, 1, 9, 45, 145 corners at sizes 1, 2, 3, 5, 8.
  const want: [number, number][] = [[1, 1], [2, 1], [3, 9], [5, 45], [8, 145]];
  for (const [size, n] of want) {
    for (const [dx, dy] of [[0, 0], [40, -30], [-63, 63]]) {
      const t = flatMap(), { x, y } = centre(t);
      for (const tool of ["raise", "lower", "plateau", "smooth", "noise"] as const) {
        const b = brushOf(tool, t, x + dx, y + dy, size);
        assert.deepEqual([b.x, b.y, b.radius, b.open], [x, y, size - 1, true], `${tool} size ${size} at +${dx},${dy}`);
      }
      applyHeight(t, brushOf("raise", t, x + dx, y + dy, size), "raise", 64, new Stroke("raise"));
      const raised = t.corners.flatMap((c, i) => (groundHeight(c) > 0 ? [i] : []));
      assert.equal(raised.length, n, `raise size ${size} at +${dx},${dy}`);
      assert.ok(raised.includes(16 * t.width + 16), "the centre corner rises");
    }
  }
  // The outline: half a tile past the outermost corners taken (size 1 and 2: the one corner).
  const t = flatMap();
  assert.equal(brushReach(brushOf("raise", t, 0, 0, 1)), 64);
  assert.equal(brushReach(brushOf("raise", t, 0, 0, 2)), 64);
  assert.equal(brushReach(brushOf("raise", t, 0, 0, 5)), 3.5 * 128);
  assert.equal(brushReach(brushOf("cliffUp", t, 0, 0, 1)), 64);
  assert.equal(brushReach(brushOf("cliffUp", t, 0, 0, 3)), 2.5 * 128);
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

/** Cliff types of the 9×9 corners around the centre, one row per line (north first), 15 as ".". */
function cliffTypes(t: Terrain): string {
  const rows: string[] = [];
  for (let y = 20; y >= 12; y--) {
    let r = "";
    for (let x = 12; x <= 20; x++) { const v = t.corners[y * t.width + x].cliffTexture; r += v === 15 ? "." : v.toString(16); }
    rows.push(r);
  }
  return rows.join("\n");
}

test("a cliff pit gets its cliff type as the World Editor's, and a ground texture stroke over it re-types nothing", () => {
  // we-compare painted-cliff-type (2026-11-13): on grass, Decrease Two size 3 with Grass Cliff typed the 13 lowered
  // corners (the middle one too, though only the pit is round it) and the 24 round them on cliff tiles; a Dirt stroke
  // of size 5 over it, Apply Cliff on or off, left all 37 as they were.
  const PIT = [".........", "...111...", "..11111..", ".1111111.", ".1111111.", ".1111111.", "..11111..", "...111...", "........."].join("\n");
  const t = flatMap();
  const down = new Stroke("cliffDown2");
  applyLayer(t, brushOf("cliffDown2", t, centre(t).x + 20, centre(t).y - 30, 3), "cliffDown2", { layer: 0 }, down);
  assert.equal(retypeCliffs(t, down, CLIFF_GROUND), true);
  assert.equal(cliffTypes(t), PIT);
  const paint = new Stroke("paint");
  assert.equal(paintTexture(t, brushOf("paint", t, centre(t).x, centre(t).y, 5), t.groundTiles.indexOf("Ldrt"), paint), true);
  assert.equal(retypeCliffs(t, paint, CLIFF_GROUND), false, "no corner re-typed");
  assert.equal(retypeCliffs(t, paint, CLIFF_GROUND, 0), false, "not with a chosen type either");
  assert.equal(cliffTypes(t), PIT);
});

test("a Decrease that would go below level 0 is no stroke at all, as the World Editor's", () => {
  // we-compare cliff-floor (2026-11-14): Decrease Two and Decrease One of size 5 on the floor of a level-0 pit, and
  // Decrease Two on a level-1 floor, moved and typed nothing in the editor; Studio lowered the whole brush to level 0.
  const { strokeLayer } = painterTools;
  assert.equal(strokeLayer("cliffDown2", 0), null);
  assert.equal(strokeLayer("cliffDown", 0), null);
  assert.equal(strokeLayer("cliffDown2", 1), null, "not as far as it gets either");
  assert.equal(strokeLayer("cliffDown", 1), 0);
  assert.equal(strokeLayer("cliffDown2", 2), 0);
  assert.equal(strokeLayer("cliffUp2", 2), 4);
  assert.equal(strokeLayer("cliffLevel", 3), 3);
  assert.equal(strokeLayer("deep", 1), 0, "the water brushes keep to level 0");
  assert.equal(strokeLayer("dry", 5), 5);
});

test("the corners next to a cliff brush come along to within two levels of it, as the World Editor's", () => {
  // we-compare cliff-reach-up2-edge and cliff-reach-down2-below (2026-11-14): on plateau.w3x (level 3 on 2) Increase
  // Two of size 3 on the edge (3 to 5) took the low corners round the brush to 3, and Decrease Two below the edge (2
  // to 0) the plateau's corners round the brush to 2. The plateau here: rows 17 and up.
  const plateau = () => {
    const t = flatMap();
    for (let y = 17; y < t.height; y++) for (let x = 0; x < t.width; x++) t.corners[y * t.width + x].layer = 3;
    return t;
  };
  const up = plateau(), s = new Stroke("cliffUp2");
  assert.equal(applyLayer(up, brushOf("cliffUp2", up, centre(up).x, centre(up).y + 128, 3), "cliffUp2", { layer: 5 }, s), true);
  assert.equal(layers(up), ["3335333", "3355533", "3555553", "3355533", "2335332", "2233322", "2222222"].join("\n"));
  retypeCliffs(up, s, CLIFF_GROUND, 1);
  assert.equal(up.corners[13 * up.width + 16].cliffTexture, 1, "the new cliff below the raised ring is typed");
  assert.equal(s.finish(up), true);
  s.undo(up);
  assert.equal(layers(up), ["3333333", "3333333", "3333333", "2222222", "2222222", "2222222", "2222222"].join("\n"), "one undo step takes the ring back too");

  const down = plateau();
  assert.equal(applyLayer(down, brushOf("cliffDown2", down, centre(down).x, centre(down).y, 3), "cliffDown2", { layer: 0 }, new Stroke("cliffDown2")), true);
  assert.equal(layers(down), ["3322233", "3220223", "2200022", "2000002", "2200022", "2220222", "2222222"].join("\n"));

  const one = plateau();
  applyLayer(one, brushOf("cliffUp", one, centre(one).x, centre(one).y + 128, 3), "cliffUp", { layer: 4 }, new Stroke("cliffUp"));
  assert.equal(layers(one).split("\n")[4], "2224222", "two levels are a cliff the brush leaves");
});

test("a size-3 Increase One below a plateau types the plateau's corners 2 and 3 rows above the centre, as the World Editor's", () => {
  // we-compare ramp-cliff-brush-up3 and cliff-type-stencil (2026-11-14): the editor typed plateau.w3x's corners 31-33 x
  // 28-29 above a size-3 Increase One centred on 32,26 (the plateau's low edge row), though no cliff touches them.
  const t = flatMap();
  for (let y = 17; y < t.height; y++) for (let x = 0; x < t.width; x++) t.corners[y * t.width + x].layer = 3;
  for (const y of [16, 17]) for (let x = 0; x < t.width; x++) t.corners[y * t.width + x].cliffTexture = 1;
  const up = new Stroke("cliffUp");
  assert.equal(applyLayer(t, brushOf("cliffUp", t, centre(t).x + 20, centre(t).y - 30, 3), "cliffUp", { layer: 3 }, up), true);
  retypeCliffs(t, up, CLIFF_GROUND, 1);
  assert.equal(cliffTypes(t), [
    ".........",
    "...111...",
    "...111...",
    "111111111",
    "111111111",
    ".1111111.",
    "..11111..",
    "...111...",
    ".........",
  ].join("\n"));
  assert.equal(up.finish(t), true);
  up.undo(t);
  assert.equal(t.corners[18 * t.width + 16].cliffTexture, 15, "undo takes the type back");
});

test("Level on flat ground moves nothing but types the World Editor's stencil round the centre", () => {
  // we-compare cliff-type-stencil (2026-11-14): Level on flat.w3x typed 9, 15, 33, 74 and 196 corners at sizes 1, 2, 3,
  // 5 and 8 (the shapes in cliffTypeStencil).
  const plus = ["...111...", "...111...", ".1111111.", ".1111111.", ".1111111.", "...111...", "...111..."].join("\n");
  for (const [size, count] of [[1, 9], [2, 15], [3, 33], [5, 74], [8, 196]]) {
    const t = flatMap(), layers = t.corners.map((c) => c.layer);
    const s = new Stroke("cliffLevel");
    assert.equal(applyLayer(t, brushOf("cliffLevel", t, centre(t).x, centre(t).y, size), "cliffLevel", { layer: 2 }, s), false, "no corner moves");
    assert.equal(retypeCliffs(t, s, CLIFF_GROUND, 1), true);
    assert.deepEqual(t.corners.map((c) => c.layer), layers);
    assert.equal(t.corners.filter((c) => c.cliffTexture === 1).length, count, `size ${size}`);
    if (size === 3) assert.equal(cliffTypes(t).split("\n").slice(1, 8).join("\n"), plus);
    if (size === 1) assert.equal(cliffTypes(t).split("\n").slice(2, 7).map((r) => r.slice(3, 6)).join(","), "...,111,111,111,...");
    if (size === 2) assert.equal(cliffTypes(t).split("\n").slice(2, 7).join(","), ".........,..11111..,..11111..,..11111..,.........");
    assert.equal(s.finish(t), true, "the typing alone is an undo step");
  }
  const water = new Stroke("shallow"), t = flatMap();
  applyLayer(t, brushOf("shallow", t, centre(t).x, centre(t).y, 1), "shallow", { layer: 1, waterLevel: 0x2000 }, water);
  assert.equal(water.own.size, 1, "the water brush has no stencil");
});

/** The same numbers every run (seed printed in the test's name). */
const seeded = (seed: number) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

test("Noise (seed 7) roughens the ground under the brush only, within the strength, the same every time", () => {
  const brush = { ...centre(flatMap()), radius: 3 };
  const run = () => {
    const t = flatMap(), s = new Stroke("noise"), random = seeded(7);
    for (let k = 0; k < 4; k++) applyHeight(t, brush, "noise", 16, s, random);
    return { t, s };
  };
  const { t, s } = run();
  const heights = t.corners.map(groundHeight);
  assert.deepEqual(run().t.corners.map(groundHeight), heights, "the same seed gives the same ground");
  const inside = new Set(s.corners());
  const moved = heights.filter((h, i) => inside.has(i) && h !== 0);
  assert.ok(moved.length > inside.size / 2, `${moved.length} of ${inside.size} corners moved`);
  assert.ok(moved.some((h) => h > 0) && moved.some((h) => h < 0), "some go up and some down");
  assert.ok(heights.every((h) => Math.abs(h) <= 4 * 16), "no corner moves more than the strength per stamp");
  assert.ok(heights.every((h, i) => inside.has(i) || h === 0), "nothing outside the brush moves");
  assert.equal(s.finish(t), true);
  s.undo(t);
  assert.ok(t.corners.every((c) => groundHeight(c) === 0), "undo takes the whole stroke back");
  s.redo(t);
  assert.deepEqual(t.corners.map(groundHeight), heights);
});

test("Noise keeps to the stored height range like the other height tools", () => {
  const t = flatMap(), s = new Stroke("noise");
  for (let k = 0; k < 400; k++) applyHeight(t, { ...centre(t), radius: 1 }, "noise", 64, s, () => 1);
  assert.equal(t.corners[16 * t.width + 16].rawHeight, 0x7fff, "pushed past the top, the centre stops at it");
  assert.ok(t.corners.every((c) => c.rawHeight >= -0x8000 && c.rawHeight <= 0x7fff));
  assert.deepEqual(writeW3e(parseW3e(writeW3e(t))), writeW3e(t));
});

/** A level-3 plateau north of row 16 with a wide ramp down its south face: the columns 13-19 flagged on rows 14-16
 *  (low, low, high), as the World Editor's Ramp dragged along a face flags them (we-compare ramp-cliff-brush-wide). */
function rampedPlateau(): Terrain {
  const t = flatMap();
  t.corners.forEach((c, i) => {
    const x = i % t.width, y = Math.floor(i / t.width);
    if (y >= 16) c.layer = 3;
    c.ramp = x >= 13 && x <= 19 && y >= 14 && y <= 16;
  });
  return t;
}
/** Layer and ramp flag of the corners x 12-20, y 13-17, one row per line (north first): "3r" flagged, "3." not. */
function ramps(t: Terrain): string[] {
  const rows: string[] = [];
  for (let y = 17; y >= 13; y--) {
    let r = "";
    for (let x = 12; x <= 20; x++) { const c = t.corners[y * t.width + x]; r += c.layer + (c.ramp ? "r" : ".") + " "; }
    rows.push(r.trim());
  }
  return rows;
}

test("a cliff brush takes the flags off a ramp line it no longer lets climb one level, as the World Editor does", () => {
  const at = (t: Terrain, x: number, y: number) => brushOf("cliffUp", t, t.offsetX + x * 128, t.offsetY + y * 128, 1);
  // Increase One on the high corner of the middle column: that column alone loses its flags (2,2,4 climbs two); the
  // rows across the ramp are level and keep theirs (the editor's save of ramp-cliff-brush-wide, 2026-11-14).
  let t = rampedPlateau();
  const s = new Stroke("cliffUp");
  applyLayer(t, at(t, 16, 16), "cliffUp", { layer: 4 }, s);
  assert.deepEqual(ramps(t), [
    "3. 3. 3. 3. 3. 3. 3. 3. 3.",
    "3. 3r 3r 3r 4. 3r 3r 3r 3.",
    "2. 2r 2r 2r 2. 2r 2r 2r 2.",
    "2. 2r 2r 2r 2. 2r 2r 2r 2.",
    "2. 2. 2. 2. 2. 2. 2. 2. 2.",
  ]);
  s.undo(t);
  assert.deepEqual(ramps(t), ramps(rampedPlateau()), "the stroke's undo gives the flags back");
  // Decrease One there: 2,2,2 is level, the column goes too.
  t = rampedPlateau();
  applyLayer(t, at(t, 16, 16), "cliffDown", { layer: 2 }, new Stroke("cliffDown"));
  assert.deepEqual(ramps(t)[1], "3. 3r 3r 3r 2. 3r 3r 3r 3.");
  assert.deepEqual(ramps(t)[2], "2. 2r 2r 2r 2. 2r 2r 2r 2.");
  // Increase One size 3 on the middle corner raises the two low ones: 3,3,3 is level, the column's high corner the
  // brush left as it was loses its flag too (ramp-cliff-brush-up3, on separate lines there).
  t = rampedPlateau();
  applyLayer(t, brushOf("cliffUp", t, t.offsetX + 16 * 128, t.offsetY + 15 * 128, 3), "cliffUp", { layer: 3 }, new Stroke("cliffUp"));
  assert.deepEqual([14, 15, 16].map((y) => t.corners[y * t.width + 16].ramp), [false, false, false]);
  // Increase One on the middle corner: 2,3,3 still climbs one level, every flag stays (ramp-cliff-brush-wide-low).
  t = rampedPlateau();
  applyLayer(t, at(t, 16, 15), "cliffUp", { layer: 3 }, new Stroke("cliffUp"));
  assert.deepEqual(ramps(t)[2], "2. 2r 2r 2r 3r 2r 2r 2r 2.");
  assert.equal(t.corners.filter((c) => c.ramp).length, 21);
});

test("the terrain survives w3e and text round trips", () => {
  const t = flatMap();
  applyLayer(t, { ...centre(t), radius: 2 }, "cliffUp", { layer: 3 }, new Stroke("cliffUp"));
  const bytes = writeW3e(t);
  assert.deepEqual(writeW3e(parseW3e(bytes)), bytes);
  assert.deepEqual(w3eFromText(w3eToText(bytes)), bytes);
});
