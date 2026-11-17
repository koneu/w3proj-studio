import assert from "node:assert/strict";
import { test } from "node:test";
import { groundHeight, parseW3e, setGroundHeight, writeW3e, type Terrain } from "../../lib/terrain/w3e";
import { w3eFromText, w3eToText } from "../../lib/terrain/w3etext";
import { applyHeight, applyLayer, brushOf, brushReach, matchCliffTypes, paintBoundary, paintTexture, retypeCliffs, Stroke } from "./tools";
import * as painterTools from "./tools";
import { mulberry32 } from "../../lib/testhelpers/testutil";

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
        const open = tool !== "plateau" && tool !== "smooth" && tool !== "noise";
        assert.deepEqual([b.x, b.y, b.radius, !!b.open], [x, y, size - 1, open], `${tool} size ${size} at +${dx},${dy}`);
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

/** The stored ground word's change of the corners x 16 + dx, y 16 + dy for dy 2..-2 (north first), dx -2..2. */
function heightGrid(t: Terrain, reach = 2): number[][] {
  const rows: number[][] = [];
  for (let dy = reach; dy >= -reach; dy--) {
    const r: number[] = [];
    for (let dx = -reach; dx <= reach; dx++) r.push(t.corners[(16 + dy) * t.width + 16 + dx].rawHeight - 0x2000);
    rows.push(r);
  }
  return rows;
}

test("Raise and Lower stamp the World Editor's cosine dome: 25.6 stored units a size at the centre, rounded down", () => {
  // we-drive on flat.w3x, one click each (2026-11-15, branch raise-brush-we): the middle corner rose by 25, 51, 76, 128
  // and 204 at sizes 1, 2, 3, 5, 8.
  for (const [size, middle, corners] of [[1, 25, 1], [2, 51, 1], [3, 76, 9], [5, 128, 45], [8, 204, 145]]) {
    const t = flatMap(), { x, y } = centre(t), s = new Stroke("raise");
    assert.equal(applyHeight(t, brushOf("raise", t, x + 30, y - 20, size), "raise", 16, s), true);
    assert.equal(heightGrid(t)[2][2], middle, `size ${size}`);
    assert.equal(t.corners.filter((c) => c.rawHeight !== 0x2000).length, corners, `size ${size}`);
  }
  const zero = [0, 0, 0, 0, 0];
  let t = flatMap();
  applyHeight(t, brushOf("raise", t, 0, 0, 3), "raise", 0, new Stroke("raise"));
  assert.deepEqual(heightGrid(t), [zero, [0, 34, 54, 34, 0], [0, 54, 76, 54, 0], [0, 34, 54, 34, 0], zero]);
  applyHeight(t, brushOf("raise", t, 0, 0, 3), "raise", 0, new Stroke("raise"));
  assert.deepEqual(heightGrid(t), [zero, [0, 68, 108, 68, 0], [0, 108, 152, 108, 0], [0, 68, 108, 68, 0], zero], "a second click adds the same, each rounded down");
  t = flatMap();
  applyHeight(t, brushOf("lower", t, 0, 0, 3), "lower", 0, new Stroke("lower"));
  assert.deepEqual(heightGrid(t), [zero, [0, -35, -55, -35, 0], [0, -55, -77, -55, 0], [0, -35, -55, -35, 0], zero], "Lower rounds down too");
  t = flatMap();
  applyHeight(t, brushOf("raise", t, 0, 0, 5, true), "raise", 0, new Stroke("raise"));
  assert.deepEqual(heightGrid(t, 4).slice(0, 5), [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 19, 41, 48, 41, 19, 0, 0],
    [0, 19, 56, 81, 90, 81, 56, 19, 0],
    [0, 41, 81, 108, 118, 108, 81, 41, 0],
    [0, 48, 90, 118, 128, 118, 90, 48, 0],
  ], "size 5, the Square shape too: the editor's Square raised the same disc");
  t = flatMap();
  applyHeight(t, brushOf("lower", t, 0, 0, 5), "lower", 0, new Stroke("lower"));
  assert.deepEqual(heightGrid(t, 4)[4], [0, -49, -91, -119, -128, -119, -91, -49, 0]);
});

test("Plateau levels the whole disc to the stroke's start, rim included; Smooth is the World Editor's 48:2:1 kernel", () => {
  // we-drive, 2026-11-15: a size-5 Raise, then Plateau size 3 one corner east (its 118) and, on another copy, Smooth size 3
  // on the middle.
  const dome = () => { const t = flatMap(); applyHeight(t, brushOf("raise", t, 0, 0, 5), "raise", 0, new Stroke("raise")); return t; };
  let t = dome();
  const target = t.corners[16 * t.width + 17].rawHeight;
  applyHeight(t, brushOf("plateau", t, 128, 0, 3), "plateau", target, new Stroke("plateau"));
  assert.deepEqual(heightGrid(t, 4).slice(1, 5), [
    [0, 0, 19, 41, 48, 41, 19, 0, 0],
    [0, 19, 56, 81, 90, 118, 56, 19, 0],
    [0, 41, 81, 108, 118, 118, 118, 41, 0],
    [0, 48, 90, 118, 118, 118, 118, 118, 0],
  ]);
  t = dome();
  applyHeight(t, brushOf("smooth", t, 0, 0, 3), "smooth", 0, new Stroke("smooth"));
  assert.deepEqual(heightGrid(t, 4).slice(1, 5), [
    [0, 0, 19, 41, 48, 41, 19, 0, 0],
    [0, 19, 56, 81, 87, 81, 56, 19, 0],
    [0, 41, 81, 105, 115, 105, 81, 41, 0],
    [0, 48, 87, 115, 125, 115, 87, 48, 0],
  ]);
  // A spike of 255 (five size-2 Raises), smoothed by size 3 twice.
  t = flatMap();
  for (let k = 0; k < 5; k++) applyHeight(t, brushOf("raise", t, 0, 0, 2), "raise", 0, new Stroke("raise"));
  assert.equal(heightGrid(t)[2][2], 255);
  applyHeight(t, brushOf("smooth", t, 0, 0, 3), "smooth", 0, new Stroke("smooth"));
  assert.deepEqual(heightGrid(t).slice(1, 4), [[0, 4, 8, 4, 0], [0, 8, 204, 8, 0], [0, 4, 8, 4, 0]]);
  applyHeight(t, brushOf("smooth", t, 0, 0, 3), "smooth", 0, new Stroke("smooth"));
  assert.deepEqual(heightGrid(t).slice(1, 4), [[0, 7, 13, 7, 0], [0, 13, 164, 13, 0], [0, 7, 13, 7, 0]]);
  // Sizes 1 and 2 on the spike: the corner alone, then the cross.
  for (const [size, want] of [[1, [[0, 0, 0], [0, 204, 0], [0, 0, 0]]], [2, [[0, 8, 0], [8, 204, 8], [0, 8, 0]]]] as const) {
    t = flatMap();
    for (let k = 0; k < 5; k++) applyHeight(t, brushOf("raise", t, 0, 0, 2), "raise", 0, new Stroke("raise"));
    applyHeight(t, brushOf("smooth", t, 0, 0, size), "smooth", 0, new Stroke("smooth"));
    assert.deepEqual(heightGrid(t, 1), want, `Smooth size ${size}`);
  }
  // The Square shape counts for both (the editor's size 3: the 5 × 5 square), and the corners the disc takes per size.
  t = dome();
  applyHeight(t, brushOf("plateau", t, 128, 0, 3, true), "plateau", target, new Stroke("plateau"));
  assert.deepEqual(heightGrid(t, 4).slice(1, 5), [
    [0, 0, 19, 41, 48, 41, 19, 0, 0],
    [0, 19, 56, 118, 118, 118, 118, 118, 0],
    [0, 41, 81, 118, 118, 118, 118, 118, 0],
    [0, 48, 90, 118, 118, 118, 118, 118, 0],
  ]);
  t = dome();
  applyHeight(t, brushOf("smooth", t, 0, 0, 3, true), "smooth", 0, new Stroke("smooth"));
  assert.deepEqual(heightGrid(t, 4).slice(2, 5), [[0, 19, 54, 79, 87, 79, 54, 19, 0], [0, 41, 79, 105, 115, 105, 79, 41, 0], [0, 48, 87, 115, 125, 115, 87, 48, 0]]);
  for (const [size, n] of [[1, 1], [2, 5], [3, 13], [5, 49]]) {
    t = flatMap();
    applyHeight(t, brushOf("plateau", t, 0, 0, size), "plateau", 0x2000 + 100, new Stroke("plateau"));
    assert.equal(t.corners.filter((c) => c.rawHeight === 0x2000 + 100).length, n, `Plateau size ${size}`);
  }
});

test("raise and lower don't read the amount: any amount gives the same ground", () => {
  // applyHeight's amount is for plateau only (tools.ts applyHeight); raiseLower takes none, and Noise draws its steps.
  for (const tool of ["raise", "lower"] as const) {
    const a = flatMap(), b = flatMap();
    applyHeight(a, brushOf(tool, a, 0, 0, 3), tool, 0, new Stroke(tool));
    applyHeight(b, brushOf(tool, b, 0, 0, 3), tool, 9999, new Stroke(tool));
    assert.deepEqual(heightGrid(a), heightGrid(b), tool);
    assert.notDeepEqual(heightGrid(a), heightGrid(flatMap()), `${tool} moved something`);
  }
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
  assert.equal(strokeLayer("deep", 1), 1, "water that would go below 0 stays on the start's level (water-level1-deep)");
  assert.equal(strokeLayer("shallow", 0), 0);
  assert.equal(strokeLayer("shallow", 1), 0);
  assert.equal(strokeLayer("dry", 5), 5);
});

/** A flat 64×64 map of one cliff level, as tests/fixtures/we-specs/flat.w3x (level 2) and the made maps of branch
 *  cliff-slope-we (levels 12 to 15). */
function flat64(level: number): Terrain {
  const t = flatMap();
  const width = 65, height = 65;
  return { ...t, width, height, offsetX: -4096, offsetY: -4096, corners: Array.from({ length: width * height }, () => ({ ...t.corners[0], layer: level })) };
}
/** Cliff levels of the corners x0..x1, y1 down to y0, one row per line (north first). */
function levelRows(t: Terrain, x0: number, x1: number, y0: number, y1: number): string[] {
  const rows: string[] = [];
  for (let y = y1; y >= y0; y--) {
    let r = "";
    for (let x = x0; x <= x1; x++) r += t.corners[y * t.width + x].layer.toString(16);
    rows.push(r);
  }
  return rows;
}
/** One Increase Two click on corner (x, y) with Grass Cliff chosen, as the painter makes it (layerTarget, the stamp,
 *  then the cliff types). */
function increaseTwo(t: Terrain, x: number, y: number, size: number, limits = false): boolean {
  const target = painterTools.layerTarget(t, "cliffUp2", x, y, 1, limits);
  if (!target) return false;
  const s = new Stroke("cliffUp2");
  const changed = applyLayer(t, painterTools.cornerBrush(t, t.offsetX + x * 128, t.offsetY + y * 128, size), "cliffUp2", target, s);
  retypeCliffs(t, s, CLIFF_GROUND, 1);
  return changed;
}
/** Cliff types of the corners x0..x1, y1 down to y0 (north first). */
function typeRows(t: Terrain, x0: number, x1: number, y0: number, y1: number): string[] {
  const rows: string[] = [];
  for (let y = y1; y >= y0; y--) {
    let r = "";
    for (let x = x0; x <= x1; x++) r += t.corners[y * t.width + x].cliffTexture.toString(16);
    rows.push(r);
  }
  return rows;
}

test("the cliff slope spreads ring after ring until no cliff is taller than two levels, as the World Editor's", () => {
  // we-drive, 2026-11-15, branch cliff-slope-we: Increase Two clicked ten times at 748,500 of flat.w3x, saved after
  // each click. The pointer's corner moves south down the growing slope (the corners are those whose stamp gives the
  // editor's save; each was the only one that did). The editor's levels of x 26..38, y 32..18 after the tenth, size 1:
  const t = flat64(2);
  for (const y of [30, 29, 29, 28, 28, 27, 27, 26, 26, 25]) increaseTwo(t, 32, y, 1);
  assert.deepEqual(levelRows(t, 26, 38, 18, 32), [
    "2222222222222", "2222222222222", "2244444444422", "2246666666422", "2246888886422", "22468aaa86422", "22468aca86422",
    "22468aca86422", "22468aaa86422", "2246888886422", "2246666666422", "2244444444422", "2222222222222", "2222222222222",
    "2222222222222",
  ]);
  // Its cliff types: the slope's corners took Grass Cliff, the level-2 corners round its outermost ring didn't (the
  // first click's stencil, rows 31 to 29, did: tools.ts typingArea). The editor's, x 27..37, y 31..20:
  assert.deepEqual(typeRows(t, 27, 37, 20, 31), ["ffff111ffff", ...Array(10).fill("f111111111f"), "fffffffffff"]);
  // Size 3: the seventh click hit the level-14 top and wrapped round to 0 (strokeLayer), the slope taking the plateau
  // down round the pit; the eighth to tenth clicks climbed again. The editor's levels of x 22..42, y 34..14:
  const u = flat64(2);
  const clicks = [30, 29, 27, 26, 25, 24, 23];
  for (const y of clicks) increaseTwo(u, 32, y, 3);
  assert.deepEqual(levelRows(u, 22, 42, 14, 34), [
    "222222222222222222222", "222222222222222222222", "222222222444222222222", "222224444464444422222", "222244666666666442222",
    "222446688888886644222", "222466866666668664222", "222468664444466864222", "222466644222446664222", "222466442202244664222",
    "222466422000224664222", "222466420000024664222", "222466422000224664222", "222466442202244664222", "222466644222446664222",
    "222446664444466644222", "222244666666666442222", "222224444444444422222", "222222222222222222222", "222222222222222222222",
    "222222222222222222222",
  ]);
  for (const y of [28, 26, 25]) increaseTwo(u, 32, y, 3);
  assert.deepEqual(levelRows(u, 22, 42, 14, 34), [
    "222222222222222222222", "222222222222222222222", "222222224444422222222", "222224444666444422222", "222244666686666442222",
    "222446688888886644222", "222466888aaa888664222", "22246888aacaa88864222", "2224668aacccaa8664222", "2224668accccca8664222",
    "2224668aacccaa8664222", "22246688aacaa88664222", "222466688aaa886664222", "222466668888866664222", "222466666666666664222",
    "222446664444466644222", "222244666666666442222", "222224444444444422222", "222222222222222222222", "222222222222222222222",
    "222222222222222222222",
  ]);
  // The editor's, but two corners of the top row (30,33 and 34,33), which Studio types round the second click's ring
  // beside the brush and the editor didn't (Stroke.typingArea).
  assert.deepEqual(typeRows(u, 24, 40, 16, 33), [
    "ffffff11111ffffff", "fffff1111111fffff", "fff11111111111fff", "ff1111111111111ff", ...Array(11).fill("f111111111111111f"),
    "ff1111111111111ff", "fff11111111111fff", "fffffffffffffffff",
  ]);
});

test("Increase past the top wraps round without Enforce Terrain Limits and does nothing above 14 with it", () => {
  // we-drive, 2026-11-15, branch cliff-slope-we, one size-1 click on maps of one level: switch off, Increase Two from 14
  // and One from 15 set the corner to 0 and left a pit of square rings 2, 4, … 12 (the 14 field from x 25..39); switch
  // on, Increase One from 14 and Two from 13 and 14 changed nothing, One from 13 and Two from 12 built 14.
  const { strokeLayer, ENFORCED_TOP_LEVEL } = painterTools;
  assert.equal(ENFORCED_TOP_LEVEL, 14);
  assert.equal(strokeLayer("cliffUp2", 14), 0);
  assert.equal(strokeLayer("cliffUp", 15), 0);
  assert.equal(strokeLayer("cliffUp2", 15), 1);
  assert.equal(strokeLayer("cliffUp2", 13), 15, "15 is a level when the switch is off (Increase Two from 13 built it)");
  assert.equal(strokeLayer("cliffUp", 14, true), null);
  assert.equal(strokeLayer("cliffUp2", 13, true), null);
  assert.equal(strokeLayer("cliffUp2", 14, true), null);
  assert.equal(strokeLayer("cliffUp", 13, true), 14);
  assert.equal(strokeLayer("cliffUp2", 12, true), 14);
  assert.equal(strokeLayer("cliffDown2", 15, true), 13, "only Increase is held");
  assert.equal(strokeLayer("cliffLevel", 15, true), 15);
  const t = flat64(14);
  assert.equal(increaseTwo(t, 32, 30, 1), true);
  assert.deepEqual(levelRows(t, 25, 39, 23, 37), [
    "eeeeeeeeeeeeeee", "eccccccccccccce", "ecaaaaaaaaaaace", "eca888888888ace", "eca866666668ace", "eca864444468ace",
    "eca864222468ace", "eca864202468ace", "eca864222468ace", "eca864444468ace", "eca866666668ace", "eca888888888ace",
    "ecaaaaaaaaaaace", "eccccccccccccce", "eeeeeeeeeeeeeee",
  ]);
  const before = levelRows(flat64(14), 0, 64, 0, 64);
  const on = flat64(14);
  assert.equal(increaseTwo(on, 32, 30, 1, true), false, "no stroke with the switch on");
  assert.deepEqual(levelRows(on, 0, 64, 0, 64), before);
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
    const tt = flatMap(), before = tt.corners.map((c) => c.layer);
    const s = new Stroke("cliffLevel");
    assert.equal(applyLayer(tt, brushOf("cliffLevel", tt, centre(tt).x, centre(tt).y, size), "cliffLevel", { layer: 2 }, s), false, "no corner moves");
    assert.equal(retypeCliffs(tt, s, CLIFF_GROUND, 1), true);
    assert.deepEqual(tt.corners.map((c) => c.layer), before);
    assert.equal(tt.corners.filter((c) => c.cliffTexture === 1).length, count, `size ${size}`);
    if (size === 3) assert.equal(cliffTypes(tt).split("\n").slice(1, 8).join("\n"), plus);
    if (size === 1) assert.equal(cliffTypes(tt).split("\n").slice(2, 7).map((r) => r.slice(3, 6)).join(","), "...,111,111,111,...");
    if (size === 2) assert.equal(cliffTypes(tt).split("\n").slice(2, 7).join(","), ".........,..11111..,..11111..,..11111..,.........");
    assert.equal(s.finish(tt), true, "the typing alone is an undo step");
  }
  const water = new Stroke("shallow"), t = flatMap();
  applyLayer(t, brushOf("shallow", t, centre(t).x, centre(t).y, 1), "shallow", { layer: 1, waterLevel: 0x2000 }, water);
  assert.equal(water.own.size, 1, "the water brush has no stencil");
});

/** The same numbers every run (seed printed in the test's name). */
const seeded = mulberry32;

test("Noise (seed 7) takes whole steps of 25.6 from -10 to 10 on the corners within radius size - 1, the rim too", () => {
  // we-compare height-noise (2026-11-17): the editor's corners moved by -256, -231 ... -26, 25 ... 256 stored units.
  const brush = { ...centre(flatMap()), radius: 4 };
  const run = () => {
    const t = flatMap(), s = new Stroke("noise"), random = seeded(7);
    applyHeight(t, brush, "noise", 16, s, random);
    return { t, s };
  };
  const { t, s } = run();
  const raws = t.corners.map((c) => c.rawHeight - 0x2000);
  assert.deepEqual(run().t.corners.map((c) => c.rawHeight - 0x2000), raws, "the same seed gives the same ground");
  const inside = new Set(s.corners());
  assert.ok(inside.size > 30 && inside.size <= 49, `${inside.size} corners of the 49 changed (one in 21 stays)`);
  const steps = new Set([-256, -231, -205, -180, -154, -128, -103, -77, -52, -26, 25, 51, 76, 102, 128, 153, 179, 204, 230, 256]);
  assert.ok(raws.every((v) => v === 0 || steps.has(v)), `only whole steps: ${[...new Set(raws)].join()}`);
  assert.ok(raws.some((v) => v > 0) && raws.some((v) => v < 0), "some go up and some down");
  assert.ok(t.corners.every((c, i) => inside.has(i) || c.rawHeight === 0x2000), "nothing outside the brush moves");
  assert.equal(s.finish(t), true);
  s.undo(t);
  assert.ok(t.corners.every((c) => c.rawHeight === 0x2000), "undo takes the whole stroke back");
  s.redo(t);
  assert.deepEqual(t.corners.map((c) => c.rawHeight - 0x2000), raws);
});

test("Noise spreads evenly over the 20 steps and reaches the rim, whatever the size", () => {
  const counts = new Map<number, number>();
  let rim = 0;
  const random = seeded(11);
  for (let k = 0; k < 200; k++) {
    const t = flatMap(), s = new Stroke("noise");
    applyHeight(t, { ...centre(t), radius: 7 }, "noise", 0, s, random);
    t.corners.forEach((c, i) => {
      const v = c.rawHeight - 0x2000;
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
      if (v && Math.hypot((i % t.width) - 16, Math.floor(i / t.width) - 16) === 7) rim++;
    });
  }
  assert.equal(counts.size, 20, "every nonzero step comes up");
  const all = [...counts.values()];
  assert.ok(Math.max(...all) / Math.min(...all) < 1.25, `uneven: ${all.join()}`);
  assert.ok(rim > 0, "a corner on the rim moves");
});

test("Noise at sizes 3, 5 and 8 takes the 13, 49 and 149 corners within size - 1, as the editor's (47 and 140 changed at 5 and 8: one corner in 21 draws step 0)", () => {
  for (const [size, n] of [[3, 13], [5, 49], [8, 149]] as const) {
    const t = flatMap(), { x, y } = centre(t), s = new Stroke("noise");
    // 0.99 draws step 10 for every corner: none stays.
    applyHeight(t, brushOf("noise", t, x, y, size), "noise", 0, s, () => 0.99);
    assert.equal(s.corners().length, n, `size ${size}`);
    assert.ok(t.corners.every((c) => c.rawHeight === 0x2000 || c.rawHeight === 0x2000 + 256));
  }
});

test("Noise keeps to the stored height range like the other height tools", () => {
  const t = flatMap(), s = new Stroke("noise");
  for (let k = 0; k < 400; k++) applyHeight(t, { ...centre(t), radius: 1 }, "noise", 64, s, () => 0.99);
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
