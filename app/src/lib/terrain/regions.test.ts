import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_REGION_INDEX, nextRegionIndex, REGION_EDGES, regionBoxProblem, typedRegionEdge } from "./regions";

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
