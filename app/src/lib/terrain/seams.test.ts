import assert from "node:assert/strict";
import { test } from "node:test";
import { dropBrokenRamps } from "./cliffs";
import { ownerGrid, seamIssues, seamLines, type SeamRect } from "./seams";
import type { Corner, Terrain } from "./w3e";

/** Rows from the north, a digit per corner: its cliff level (ramps and water are set by hand). */
function land(rows: string[]): Terrain {
  const height = rows.length, width = rows[0].length;
  const corners: Corner[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    corners.push({ layer: Number(rows[height - 1 - y][x]), ramp: false, hasWater: false, rawWater: 0, cliffTexture: 0 } as Corner);
  }
  return { width, height, offsetX: 0, offsetY: 0, corners, cliffTiles: ["CLdi"] } as unknown as Terrain;
}
const at = (t: Terrain, x: number, y: number) => t.corners[y * t.width + x];
/** West (x 0–2) and east (x 3–5) halves of a 6×3 canvas. */
const halves: SeamRect[] = [{ name: "west", x: 0, y: 0, w: 3, h: 3 }, { name: "east", x: 3, y: 0, w: 3, h: 3 }];

test("strict corner ownership: each corner in the rectangle that holds it, none outside", () => {
  const o = ownerGrid(4, 2, [{ name: "a", x: 0, y: 0, w: 2, h: 1 }, { name: "b", x: 2, y: 1, w: 2, h: 1 }]);
  assert.deepEqual([...o], [0, 0, -1, -1, -1, -1, 1, 1]);
});

test("a consistent seam reports nothing; two edits that are each fine merge into a cliff of four levels", () => {
  const base = ["222222", "222222", "222222"];
  assert.deepEqual(seamIssues(land(base), halves).issues, [], "control: flat");
  // Branch A raised the west side's edge to 4, branch B lowered the east side's to 0: each a cliff of two.
  const a = land(["224222", "222222", "222222"]), b = land(["222022", "222222", "222222"]);
  assert.deepEqual(seamIssues(a, halves).issues, [], "branch A alone");
  assert.deepEqual(seamIssues(b, halves).issues, [], "branch B alone");
  const merged = land(["224022", "222222", "222222"]);
  const r = seamIssues(merged, halves);
  assert.equal(r.errors, 1);
  assert.deepEqual(r.issues.map((i) => [i.rule, i.severity, i.corners]), [["cliff-height", "error", [{ x: 2, y: 2, subterrain: "west" }, { x: 3, y: 2, subterrain: "east" }]]]);
  assert.match(seamLines(r)[0], /^error cliff-height: a cliff of 4 levels between 2,2 \(west\) on level 4 and 3,2 \(east\) on level 0/);
  assert.match(seamLines(r).at(-1)!, /1 error and 0 warnings along 1 seam/);
  // The same cliff inside one subterrain isn't a seam's: not reported.
  assert.deepEqual(seamIssues(land(["402222", "222222", "222222"]), halves).issues, []);
  // Diagonal pairs across the seam count too.
  assert.deepEqual(seamIssues(land(["224222", "222022", "222222"]), halves).issues.map((i) => i.corners.map((c) => `${c.x},${c.y}`)), [["2,2", "3,1"]]);
});

test("ramp flags across the seam that no longer climb one level are an error; a ramp that does, or a level row, isn't", () => {
  const t = land(["222222", "223322", "222222"]);
  const run = (levels: number[]) => {
    [0, 1, 2, 3].forEach((k) => { const c = at(t, 1 + k, 1); c.ramp = true; c.layer = levels[k]; });
    return seamIssues(t, halves).issues.filter((i) => i.rule === "ramp");
  };
  assert.deepEqual(run([2, 2, 3, 3]), [], "climbs one level, one way");
  assert.deepEqual(run([2, 2, 2, 2]), [], "a row across a wide ramp");
  const broken = run([2, 3, 3, 2]);
  assert.equal(broken.length, 1);
  assert.deepEqual(broken[0].corners.map((c) => `${c.x}${c.subterrain[0]}`), ["1w", "2w", "3e", "4e"]);
  // The rule is the brushes': dropBrokenRamps takes the same run off after a move that broke it.
  const dropped = dropBrokenRamps(t, new Map([[1 * t.width + 4, 3]]), { touch() {} });
  assert.equal(dropped.length, 4);
  // A broken run that stays on one side is no seam's.
  const one = land(["222222", "232222", "222222"]);
  [0, 1, 2].forEach((k) => { at(one, k, 1).ramp = true; });
  assert.deepEqual(seamIssues(one, halves).issues, []);
});

test("water that steps within a tile across the seam is a warning; one level, or a step inside one subterrain, isn't", () => {
  const t = land(["222222", "222222", "222222"]);
  const wet = (x: number, y: number, level: number) => { const c = at(t, x, y); c.hasWater = true; c.rawWater = level; };
  wet(2, 1, 0x2000); wet(3, 1, 0x2000); wet(2, 0, 0x2000); wet(3, 0, 0x2000);
  assert.deepEqual(seamIssues(t, halves).issues, [], "one level");
  wet(3, 1, 0x2100);
  wet(1, 0, 0x1f00);
  const r = seamIssues(t, halves);
  assert.equal(r.errors, 0);
  assert.equal(r.warnings, 2);
  assert.deepEqual(r.issues.map((i) => i.corners.map((c) => `${c.x},${c.y}`).join(" ")), ["2,0 3,1", "2,1 3,1"]);
  assert.ok(r.issues.every((i) => i.severity === "warning" && i.rule === "water-level"));
});

test("corners no subterrain covers are never part of a seam", () => {
  const t = land(["222222", "222222", "222222"]);
  at(t, 3, 1).layer = 6;
  const r = seamIssues(t, [{ name: "west", x: 0, y: 0, w: 3, h: 3 }]);
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.seams, []);
});
