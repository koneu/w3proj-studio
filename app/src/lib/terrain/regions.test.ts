import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_REGION_INDEX, nextRegionIndex, REGION_EDGES, regionBoxProblem, regionEdgeOnGrid, regionsOnGrid, shiftInside, typedRegionEdge } from "./regions";

const region = () => ({ left: -64, bottom: -32, right: 64, top: 96, name: "Area", index: 3 });

test("typedRegionEdge: an edge war3map.w3r's float can't hold, or one that leaves no size, is refused and the region stays", () => {
  for (const key of REGION_EDGES) {
    const r = region();
    const before = structuredClone(r);
    // Past the float, no number, and past the opposite edge.
    const across = key === "left" ? "64" : key === "right" ? "-64" : key === "bottom" ? "96" : "-32";
    for (const typed of ["1e39", "-1e39", "Infinity", "NaN", "", "abc", across]) {
      const got = typedRegionEdge(r, key, typed);
      assert.ok(got && "refused" in got, `${key} = ${JSON.stringify(typed)} was taken`);
      assert.deepEqual(r, before, `${key} = ${typed} changed the region`);
    }
    assert.match((typedRegionEdge(r, key, "1e39") as { refused: string }).refused, /from -3\.4e38 to 3\.4e38/);
    // Controls: the float's end on the open side, a plain value, and its own value (no change).
    const far = key === "left" || key === "bottom" ? "-3.4028234663852886e38" : "3.4028234663852886e38";
    assert.deepEqual(typedRegionEdge(r, key, far), { change: { [key]: Number(far) } });
    assert.deepEqual(typedRegionEdge(r, key, key === "left" || key === "bottom" ? "-128" : "128"), { change: { [key]: key === "left" || key === "bottom" ? -128 : 128 } });
    assert.equal(typedRegionEdge(r, key, String(r[key])), null);
  }
});

test("regionBoxProblem: add_region's rectangle is refused past the float, without numbers or without size", () => {
  assert.equal(regionBoxProblem({ left: 0, bottom: 0, right: 32, top: 32 }), null);
  for (const key of REGION_EDGES) {
    for (const v of [1e39, -1e39, Infinity, NaN, "32", undefined]) {
      const box: Record<string, unknown> = { left: 0, bottom: 0, right: 32, top: 32, [key]: v };
      assert.ok(regionBoxProblem(box as never), `${key} = ${String(v)} was taken`);
    }
  }
  assert.ok(regionBoxProblem({ left: 32, bottom: 0, right: 32, top: 32 }));
  assert.ok(regionBoxProblem({ left: 0, bottom: 40, right: 32, top: 32 }));
});

test("regionEdgeOnGrid: the nearest line of the 32 grid, halves up, as the World Editor's open and save (we-compare region-round, 2026-11-18)", () => {
  // The editor's saved values for region-round.w3m's edges.
  const seen: [number, number][] = [
    [16, 32], [48, 64], [112, 128], [1008, 1024], [-1008, -992], [-112, -96], [-48, -32], [-16, 0],
    [15.9, 0], [16.1, 32], [47.9, 32], [48.1, 64], [-16.1, -32], [-15.9, 0], [200, 192], [208, 224], [400, 416],
    [40, 32], [50, 64], [300, 288], [500, 512], [-1000.25, -992], [-3600.75, -3616], [100.5, 96], [333.3, 320],
    [-4090, -4096], [-4095.5, -4096], [4090, 4096], [4095.5, 4096], [47, 32], [600, 608], [700, 704], [-47, -32], [-40, -32],
  ];
  for (const [v, want] of seen) assert.equal(regionEdgeOnGrid(v), want, `${v}`);
  assert.ok(Object.is(regionEdgeOnGrid(-10), 0), "a small negative edge gives 0, not -0");
  for (const v of [0, 32, -4096, 3.4028234663852886e38, -3.4028234663852886e38]) assert.equal(regionEdgeOnGrid(v), v);
  for (const v of [NaN, Infinity, -Infinity]) assert.ok(Object.is(regionEdgeOnGrid(v), v));
});

test("regionsOnGrid: copies of the regions that move, the others kept; null when none moves; edges meeting stay with no size", () => {
  const on = { left: -64, bottom: -32, right: 64, top: 96, name: "On", index: 0 };
  const off = { left: 40, bottom: 600, right: 47, top: 700, name: "Off", index: 1 };
  const list = [on, off];
  const got = regionsOnGrid(list)!;
  assert.equal(got[0], on);
  assert.deepEqual(got[1], { left: 32, bottom: 608, right: 32, top: 704, name: "Off", index: 1 });
  assert.deepEqual(off, { left: 40, bottom: 600, right: 47, top: 700, name: "Off", index: 1 }, "the region read isn't changed in place");
  assert.equal(regionsOnGrid([on]), null);
  assert.equal(regionsOnGrid([]), null);
});

test("typedRegionEdge: a typed edge goes onto the region grid; one that lands on the opposite edge is refused", () => {
  const r = region();
  assert.deepEqual(typedRegionEdge(r, "right", "100"), { change: { right: 96 } });
  // Onto the value the region has already: no change.
  assert.equal(typedRegionEdge(r, "left", "-80"), null);
  assert.equal(typedRegionEdge(r, "top", "111.9"), null);
  assert.deepEqual(typedRegionEdge(r, "top", "112"), { change: { top: 128 } });
  const got = typedRegionEdge(r, "left", "50");
  assert.ok(got && "refused" in got && /left must be below right/.test(got.refused), JSON.stringify(got));
  const map = { left: -4096, bottom: -4096, right: 4096, top: 4096 };
  assert.deepEqual(typedRegionEdge(r, "right", "4100", map), { change: { right: 4096 } });
});

test("nextRegionIndex: one past the highest, refused (not wrapped to 0) past the file's u32", () => {
  assert.equal(nextRegionIndex([]), 0);
  assert.equal(nextRegionIndex([{ index: 4 }, { index: 1 }]), 5);
  assert.equal(nextRegionIndex([{ index: MAX_REGION_INDEX - 1 }]), MAX_REGION_INDEX);
  const got = nextRegionIndex([{ index: 0 }, { index: MAX_REGION_INDEX }]);
  assert.ok(typeof got === "object" && /4294967295/.test(got.refused));
});

test("regionBoxProblem and typedRegionEdge: a region outside the map is refused as the World Editor never makes one (we-drive 2026-11-16)", () => {
  const map = { left: -4096, bottom: -4096, right: 4096, top: 4096 };
  const box = { left: -64, bottom: -32, right: 64, top: 96 };
  assert.equal(regionBoxProblem(box, map), null);
  // The whole map, the border outside the playable part (the editor made one at x -3936), and no map to go by.
  assert.equal(regionBoxProblem({ ...map }, map), null);
  assert.equal(regionBoxProblem({ left: -3936, bottom: -1376, right: -3552, top: 128 }, map), null);
  assert.equal(regionBoxProblem({ left: 5000, bottom: 0, right: 6000, top: 32 }), null);
  for (const key of REGION_EDGES) {
    const out = key === "left" || key === "bottom" ? -4096.5 : 4096.5;
    const got = regionBoxProblem({ ...box, [key]: out }, map);
    assert.match(got ?? "", /inside the map/, `${key} = ${out} was taken`);
  }
  // Wholly outside, and across an edge.
  assert.match(regionBoxProblem({ left: 4200, bottom: 0, right: 4300, top: 32 }, map) ?? "", /inside the map/);
  assert.match(regionBoxProblem({ left: 4000, bottom: 0, right: 5000, top: 32 }, map) ?? "", /inside the map/);
  // Typed into one edge: refused with the edge's name, the region unchanged; an edge on the map's edge goes through.
  const r = { ...box, name: "Area", index: 1 };
  const before = structuredClone(r);
  const got = typedRegionEdge(r, "right", "5000", map);
  assert.ok(got && "refused" in got && got.refused.startsWith("Right: a region must lie inside the map"), JSON.stringify(got));
  assert.deepEqual(r, before);
  assert.deepEqual(typedRegionEdge(r, "right", "4096", map), { change: { right: 4096 } });
  assert.deepEqual(typedRegionEdge(r, "left", "-4096", map), { change: { left: -4096 } });
  // The shape rules still come first.
  assert.match(regionBoxProblem({ left: 32, bottom: 0, right: 0, top: 32 }, map) ?? "", /left must be below right/);
});

test("shiftInside: a region dragged past the map's edge stops with its edge on the map's, as the World Editor's (we-drive 2026-11-18)", () => {
  const map = { left: -4096, bottom: -4096, right: 4096, top: 4096 };
  // flat.w3x: 3296..3552 dragged about 850 east (the pointer off the map) ended at 3840..4096, its size kept.
  const r = { left: 3296, right: 3552, bottom: -224, top: 160 };
  assert.deepEqual(shiftInside([r], 864, 0, map), [544, 0]);
  // A move that fits is left as it is (the editor's 448 east), and so are both axes at once past two edges.
  assert.deepEqual(shiftInside([r], 448, -32, map), [448, -32]);
  assert.deepEqual(shiftInside([r], 900, -9000, map), [544, -3872]);
  assert.deepEqual(shiftInside([{ left: -4000, right: -3900, bottom: 3900, top: 4000 }], -500, 500, map), [-96, 96]);
  // Several regions move by one shift, held by the one nearest the edge.
  assert.deepEqual(shiftInside([r, { left: 0, right: 32, bottom: 0, top: 32 }], 864, 0, map), [544, 0]);
  // A region already past the edge (from the file) isn't pushed further out, and can come back in.
  const out = { left: 4000, right: 4200, bottom: 0, top: 32 };
  assert.deepEqual(shiftInside([out], 64, 0, map), [0, 0]);
  assert.deepEqual(shiftInside([out], -320, 0, map), [-320, 0]);
  // Without the map's rectangle nothing is held.
  assert.deepEqual(shiftInside([r], 864, 0, null), [864, 0]);
});
