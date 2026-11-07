import assert from "node:assert/strict";
import { test } from "node:test";
import { areaBetween, changeArea, tileOf, centreOf, fragmentOf, FRAGMENT_FORMAT, groundOf, groundOrigin, snapped, restoreTiles, stampGround, tileSnapshot, turnAngle, turnFragment, turnGround, turnOffset, type FragmentGround } from "./fragment";
import { parseW3e, setGroundHeight, setWaterLevel, writeW3e, type Corner, type Terrain } from "./w3e";

const tree = (x: number, y: number, z = 0, angle = 0) => ({ list: "doodads" as const, entry: { id: "LTlt", position: [x, y, z], angle, scale: [1, 1, 1], life: 100 } });
const flat = () => 0;

test("a fragment is relative to its centre, on the pathing grid", () => {
  const f = fragmentOf([tree(96, 64), tree(160, 128)], flat);
  assert.deepEqual(f.objects.map((o) => o.at), [[-32, -32, 0], [32, 32, 0]]);
  assert.deepEqual(centreOf([[0, 0], [33, 33]]), [32, 32]);
  assert.equal(snapped(47), 32);
  assert.equal(snapped(49), 64);
});

test("height is kept from the ground, so a raised doodad stays raised on other ground", () => {
  const f = fragmentOf([tree(0, 0, 340)], () => 300);
  assert.equal(f.objects[0].at[2], 40);
});

test("a fragment holds no position of the map, and doesn't share the object it came from", () => {
  const source = tree(0, 0);
  const f = fragmentOf([source], flat);
  assert.equal("position" in f.objects[0].entry, false);
  assert.equal("angle" in f.objects[0].entry, false);
  (f.objects[0].entry.scale as number[])[0] = 9;
  assert.equal(source.entry.scale[0], 1);
});

test("a fragment survives being a file: the same after JSON", () => {
  const unit = { list: "units" as const, entry: { id: "hfoo", position: [64, 0, 0], angle: 0, player: 3 } };
  const f = turnFragment(fragmentOf([tree(0, 0, 0, 1), unit], flat), "cw");
  assert.equal(f.format, FRAGMENT_FORMAT);
  assert.deepEqual(JSON.parse(JSON.stringify(f)), f);
});

test("turns: where a point goes", () => {
  assert.deepEqual(turnOffset("mirrorX", 3, 5), [-3, 5]);
  assert.deepEqual(turnOffset("mirrorY", 3, 5), [3, -5]);
  assert.deepEqual(turnOffset("cw", 1, 0), [0, -1], "east turns to south");
  assert.deepEqual(turnOffset("ccw", 1, 0), [0, 1], "east turns to north");
});

test("turns: a facing goes with its point", () => {
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
  const east = 0, north = Math.PI / 2, west = Math.PI, south = Math.PI * 1.5;
  close(turnAngle("mirrorX", east), west);
  close(turnAngle("mirrorX", north), north);
  close(turnAngle("mirrorY", north), south);
  close(turnAngle("mirrorY", east), east);
  close(turnAngle("cw", east), south);
  close(turnAngle("ccw", east), north);
  for (const turn of ["mirrorX", "mirrorY", "cw", "ccw"] as const) {
    for (const a of [0, 0.5, 1.5, 3, 6]) {
      const [x, y] = turnOffset(turn, Math.cos(a), Math.sin(a)), b = turnAngle(turn, a);
      close(Math.cos(b), x);
      close(Math.sin(b), y);
    }
  }
});

test("turning all the way round, or mirroring twice, gives the same fragment", () => {
  const f = fragmentOf([tree(0, 0, 0, 1), tree(128, 64, 0, 2)], flat);
  const near = (a: typeof f, b: typeof f) => a.objects.forEach((o, i) => {
    assert.ok(Math.abs(o.angle - b.objects[i].angle) < 1e-9);
    o.at.forEach((v, k) => assert.ok(Math.abs(v - b.objects[i].at[k]) < 1e-9));
  });
  near(["cw", "cw", "cw", "cw"].reduce((x, t) => turnFragment(x, t as "cw"), f), f);
  near(turnFragment(turnFragment(f, "mirrorX"), "mirrorX"), f);
  near(turnFragment(turnFragment(f, "cw"), "ccw"), f);
});

const corner = (texture = 0, ground = 0): Corner => {
  const c: Corner = {
    height: 0, water: -89.6, texture, variation: 1, cliffVariation: 0, cliffTexture: 15, layer: 2,
    ramp: false, blight: false, hasWater: false, boundary: false, rawHeight: 0x2000, rawWater: 0x2000, texExtra: 0,
  };
  setGroundHeight(c, ground);
  return c;
};
const land = (width: number, height: number, tiles = ["Ldrt", "Lgrs"]): Terrain => ({
  version: 12, tileset: "L", customTilesets: false, customTilesetsRaw: 0, groundTiles: tiles, cliffTiles: ["CLdi", "CLgr"],
  width, height, offsetX: -256, offsetY: -256, corners: Array.from({ length: width * height }, () => corner()), trailer: new Uint8Array(0),
});
const textures = (g: FragmentGround) => Array.from({ length: g.height }, (_, y) => g.corners.slice(y * g.width, (y + 1) * g.width).map((c) => c.texture).join(""));

test("ground is relative to the centre, and keeps its height and water", () => {
  const t = land(5, 5);
  const c = t.corners[1 * 5 + 2];
  setGroundHeight(c, 40);
  setWaterLevel(c, 0x2100);
  const g = groundOf(t, { x0: 1, y0: 0, x1: 3, y1: 1 }, [0, 0]);
  assert.deepEqual([g.width, g.height, g.at], [3, 2, [-128, -256]]);
  assert.equal(g.corners[1 * 3 + 1].ground, 40);
  assert.equal(g.corners[1 * 3 + 1].water, 0x2100);
  assert.equal(g.corners[1 * 3 + 1].hasWater, true);
});

test("the map's border isn't copied: not taken along, and left alone where it lands", () => {
  const from = land(3, 3);
  from.corners.forEach((c) => { c.rawWater |= 0x4000; });
  const g = groundOf(from, { x0: 0, y0: 0, x1: 2, y1: 2 }, [0, 0]);
  assert.equal(g.corners.some((c) => c.water & 0xc000), false);
  const to = land(3, 3);
  to.corners[0].rawWater |= 0x4000;
  stampGround(to, g, [0, 0], [0, 1], [0, 1]);
  assert.equal(to.corners[0].rawWater & 0x4000, 0x4000, "still the border");
  assert.equal(to.corners[4].rawWater & 0x4000, 0, "still inside");
});

test("types keep their name in a map that numbers them otherwise", () => {
  const from = land(2, 2);
  from.corners[0].texture = 1;
  from.corners[0].cliffTexture = 1;
  const g = groundOf(from, { x0: 0, y0: 0, x1: 1, y1: 1 }, [0, 0]);
  assert.deepEqual([g.tiles, g.cliffs], [["Ldrt", "Lgrs"], ["CLdi", "CLgr"]]);
  const to = land(2, 2, ["Lgrs", "Ldrt"]);
  stampGround(to, g, [0, 0], g.tiles.map((id) => to.groundTiles.indexOf(id)), [1, 0]);
  assert.equal(to.groundTiles[to.corners[0].texture], "Lgrs");
  assert.equal(to.corners[0].cliffTexture, 0);
  assert.equal(to.corners[1].cliffTexture, 15, "no cliff type stays that");
});

test("stamping restores on undo, redoes, and survives the file", () => {
  const t = land(4, 4);
  setGroundHeight(t.corners[0], 80);
  t.corners[0].layer = 2;
  const g = groundOf(t, { x0: 0, y0: 0, x1: 0, y1: 0 }, [0, 0]);
  g.corners[0].layer = 5;
  const was = structuredClone(t.corners[15]);
  const st = stampGround(t, g, [3, 3], [0, 1], [0, 1]);
  assert.deepEqual(st.corners, [15]);
  assert.equal(t.corners[15].layer, 5);
  assert.equal(t.corners[15].height, 80 + 3 * 128);
  const again = parseW3e(writeW3e(t)).corners[15];
  assert.equal(again.height, t.corners[15].height, "height matches what the file says");
  assert.equal(again.water, t.corners[15].water);
  st.undo();
  assert.deepEqual(t.corners[15], was);
  st.redo();
  assert.equal(t.corners[15].layer, 5);
});

test("what falls off the map is left out", () => {
  const t = land(3, 3), g = groundOf(land(2, 2), { x0: 0, y0: 0, x1: 1, y1: 1 }, [0, 0]);
  assert.equal(stampGround(t, g, [2, 2], [0, 1], [0, 1]).corners.length, 1);
  assert.equal(stampGround(t, g, [-1, -1], [0, 1], [0, 1]).corners.length, 1);
  assert.equal(stampGround(t, g, [9, 9], [0, 1], [0, 1]).corners.length, 0);
});

test("a pasted area lands on whole tiles", () => {
  const t = land(9, 9), g = groundOf(t, { x0: 0, y0: 0, x1: 2, y1: 2 }, [0, 0]);
  assert.deepEqual(groundOrigin(t, g, 0, 0), [0, 0]);
  assert.deepEqual(groundOrigin(t, g, 130, 250), [1, 2]);
});

test("ground turns: the corners go where the turn sends them", () => {
  // 3 wide, 2 high, row 0 in the south: "012" / "345".
  const t = land(3, 2);
  t.corners.forEach((c, i) => { c.texture = i; });
  const g = groundOf(t, { x0: 0, y0: 0, x1: 2, y1: 1 }, [0, 0]);
  assert.deepEqual(textures(g), ["012", "345"]);
  assert.deepEqual(textures(turnGround(g, "mirrorX")), ["210", "543"]);
  assert.deepEqual(textures(turnGround(g, "mirrorY")), ["345", "012"]);
  const cw = turnGround(g, "cw");
  assert.deepEqual([cw.width, cw.height], [2, 3]);
  assert.deepEqual(textures(cw), ["25", "14", "03"]);
  assert.equal(cw.corners[0].texture, 2, "the south-east corner turns to the south-west");
  assert.equal(cw.corners[cw.width * 2 + 1].texture, 3, "the north-west corner turns to the north-east");
  const ccw = turnGround(g, "ccw");
  assert.equal(ccw.corners[0].texture, 3, "the north-west corner turns to the south-west");
  assert.equal(ccw.corners[ccw.width * 2 + 1].texture, 2, "the south-east corner turns to the north-east");
});

test("ground and its objects stay together through a turn", () => {
  // Each corner's place from the centre has to turn just as turnOffset turns a point.
  const t = land(4, 3);
  t.corners.forEach((c, i) => { c.texture = i; });
  const g = groundOf(t, { x0: 0, y0: 0, x1: 3, y1: 2 }, [32, 64]);
  const place = (s: FragmentGround, texture: number) => {
    const i = s.corners.findIndex((c) => c.texture === texture);
    return [s.at[0] + (i % s.width) * 128, s.at[1] + Math.floor(i / s.width) * 128];
  };
  for (const turn of ["mirrorX", "mirrorY", "cw", "ccw"] as const) {
    const turned = turnGround(g, turn);
    for (let tex = 0; tex < 12; tex++) {
      const [x, y] = place(g, tex);
      assert.deepEqual(place(turned, tex), turnOffset(turn, x, y), `${turn}, corner ${tex}`);
    }
  }
});

test("turning ground all the way round gives it back", () => {
  const t = land(3, 2);
  t.corners.forEach((c, i) => { c.texture = i; });
  const g = groundOf(t, { x0: 0, y0: 0, x1: 2, y1: 1 }, [32, 0]);
  assert.deepEqual(["cw", "cw", "cw", "cw"].reduce((x, s) => turnGround(x, s as "cw"), g), g);
  assert.deepEqual(turnGround(turnGround(g, "mirrorY"), "mirrorY"), g);
});

test("a fragment with ground survives being a file, and turns with it", () => {
  const t = land(3, 3);
  const f = { ...fragmentOf([tree(0, 0)], flat, [0, 0]), ground: groundOf(t, { x0: 0, y0: 0, x1: 2, y1: 2 }, [0, 0]) };
  const turned = turnFragment(f, "cw");
  assert.deepEqual(JSON.parse(JSON.stringify(turned)), turned);
  assert.deepEqual([turned.ground!.width, turned.ground!.height], [3, 3]);
});

test("painted Boundary goes along with the ground, and isn't the map's border", () => {
  const from = land(2, 2);
  from.corners[0].boundary = true;
  const g = groundOf(from, { x0: 0, y0: 0, x1: 1, y1: 1 }, [0, 0]);
  const to = land(2, 2);
  to.corners[1].boundary = true;
  const st = stampGround(to, g, [0, 0], [0, 1], [0, 1]);
  assert.deepEqual(to.corners.map((c) => c.boundary), [true, false, false, false]);
  st.undo();
  assert.deepEqual(to.corners.map((c) => c.boundary), [false, true, false, false]);
  assert.equal(parseW3e(writeW3e(from)).corners[0].boundary, true);
  assert.equal(from.corners[0].rawWater & 0x4000, 0);
});

test("an area runs between two tiles, dragged any way", () => {
  assert.deepEqual(areaBetween([2, 3], [5, 7]), { x0: 2, y0: 3, x1: 6, y1: 8 });
  assert.deepEqual(areaBetween([5, 7], [2, 3]), { x0: 2, y0: 3, x1: 6, y1: 8 });
  assert.deepEqual(areaBetween([4, 4], [4, 4]), { x0: 4, y0: 4, x1: 5, y1: 5 }, "one tile");
});

test("a drag past the edge stays on the map", () => {
  const t = { width: 5, height: 5, offsetX: -256, offsetY: -256 };
  assert.deepEqual(tileOf(t, -256, -256), [0, 0]);
  assert.deepEqual(tileOf(t, 1, 1), [2, 2]);
  assert.deepEqual(tileOf(t, -9999, 9999), [0, 3]);
});

test("changing an area touches only what's in it and what's asked for, and undoes", () => {
  const t = land(4, 4);
  t.corners.forEach((c, i) => { c.texture = i % 2; });
  const was = t.corners.map((c) => c.texture);
  const st = changeArea(t, { x0: 1, y0: 1, x1: 2, y1: 2 }, (c) => { if (c.texture !== 1) return false; c.texture = 5; return true; });
  assert.deepEqual(st.corners, [5, 9].filter((i) => was[i] === 1));
  assert.equal(t.corners[1].texture, 1, "outside the area");
  assert.equal(t.corners[6].texture, 0, "another tile");
  st.undo();
  assert.deepEqual(t.corners.map((c) => c.texture), was);
  st.redo();
  assert.equal(t.corners[5].texture, 5);
});

test("tiles added for a paste that is refused go again, to the last cliff type and the custom-tilesets flag", () => {
  const t = land(3, 3);
  const before = tileSnapshot(t);
  t.groundTiles.push("Lrok");
  t.cliffTiles.push("CLrk");
  t.customTilesets = true;
  t.customTilesetsRaw = 1;
  restoreTiles(t, before);
  assert.deepEqual(t.groundTiles, ["Ldrt", "Lgrs"]);
  assert.deepEqual(t.cliffTiles, before.cliffs);
  assert.equal(t.customTilesets, before.custom);
  assert.equal(t.customTilesetsRaw, before.raw);
  // The snapshot is a copy: tiles added after it don't change it.
  t.groundTiles.push("Lrok");
  assert.deepEqual(before.ground, ["Ldrt", "Lgrs"]);
});

test("a turned fragment keeps waiting for the same types", () => {
  const typesReady = Promise.resolve([]);
  const f = { ...fragmentOf([{ list: "units", entry: { position: [0, 0, 0], angle: 0 } }], () => 0), typesReady };
  for (const turn of ["mirrorX", "cw"] as const) assert.equal(turnFragment(f, turn).typesReady, typesReady);
});
