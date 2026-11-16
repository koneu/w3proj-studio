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
