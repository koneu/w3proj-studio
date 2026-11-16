import assert from "node:assert/strict";
import { test } from "node:test";
import { worldSphere } from "../../lib/model/frustum";
import type { Vec3 } from "../../lib/model/renderer";
import { inverseAffine, rayBox } from "./meshpick";
import { boxSphere, placement, type Placed } from "./objects";
import { TerrainRenderer, type ObjectBatch, type ObjectInstance } from "./renderer";

const W = 1184, H = 844;
/** Studio's camera for the editor's look at (0, 0) from 2000 (TESTING.md "Projection for clicks": target y - 0.0993 d, distance 0.9127 d, pitch 57.2, field of view 41.06). */
const camera = () => ({
  canvas: { clientWidth: W, clientHeight: H }, target: [0, -0.0993333 * 2000, 0] as Vec3, distance: 0.9127 * 2000, yaw: -Math.PI / 2,
  pitch: (57.2 * Math.PI) / 180, fov: (41.06 * Math.PI) / 180, eye: TerrainRenderer.prototype.eye,
}) as unknown as TerrainRenderer;

test("a ray meets a placed box where the placed box stands", () => {
  const box = { min: [-10, -20, 0], max: [10, 20, 30] };
  // Turned 90 degrees, doubled, standing at (100, 0): the box is then 80 wide in x (the 40 long side, doubled) and 40 in y.
  const world = placement({ angle: Math.PI / 2, scale: [2, 2, 2], position: [100, 0, 0] } as Placed, 1);
  const down = (x: number, y: number) => rayBox(box, world, [x, y, 500], [0, 0, -1]);
  assert.ok(Math.abs(down(100, 0) - (500 - 60)) < 1e-9, "onto the top, 60 up");
  assert.ok(Number.isFinite(down(100 + 39, 0)), "inside the long side");
  assert.equal(down(100 + 41, 0), Infinity, "beyond the long side");
  assert.ok(Number.isFinite(down(100, 19)) && down(100, 21) === Infinity, "the short side turned to y");
  assert.ok(Number.isFinite(rayBox(box, world, [100, -500, 30], [0, 1, 0])), "from the side");
  assert.equal(rayBox(box, world, [100, -500, 70], [0, 1, 0]), Infinity, "over the top");
  assert.equal(rayBox(box, world, [100, 500, 30], [0, 1, 0]), Infinity, "pointing away");
  const inv = inverseAffine(world)!;
  assert.ok(Math.abs(inv[0] * world[0] + inv[1] * world[1] + inv[2] * world[2] - 1) < 1e-9);
  assert.equal(inverseAffine(new Float32Array(16)), null, "a flat scale has no inverse");
});

/**
 * The rock LRrk (Lords_Rock0.mdx, SD: box x -91.8..87.2, y -85.3..81, z 0.5..81.2; type scale range 0.9 to 1.0, saved
 * as 1) turned 270 degrees, clicked on bare ground at 0, 30, 45, 60, 80, 100 and 130 units from its centre towards
 * east, west, north and south, in the editor's view of 0, 0 from 2000: which the World Editor selects (we-compare spec
 * doodad-pick-we, branch doodad-pick-we, 2026-11-16). The rule before was the pathing footprint's cylinder (4x4 cells:
 * radius 64), which never reaches the ground 80 off.
 */
const WE_ROCK_HITS = new Set(["0", ...[30, 45, 60, 80].flatMap((d) => ["E", "W", "N", "S"].map((c) => `${c}${d}`)), "N100", "N130"]);
const DIRS: Record<string, [number, number]> = { E: [1, 0], W: [-1, 0], N: [0, 1], S: [0, -1] };

function rockView(withModel: boolean) {
  const box = { min: [-91.8, -85.3, 0.5], max: [87.2, 81, 81.2] };
  const placed = { id: "LRrk", angle: (270 * Math.PI) / 180, scale: [1, 1, 1], position: [0, 0, 0] } as unknown as Placed;
  const world = placement(placed, 1);
  const local = boxSphere(box);
  const inst: ObjectInstance = {
    world, team: 0, bounds: local, sphere: worldSphere(world, local),
    pick: { kind: "w3d", id: "LRrk", index: 0, placed, model: "", extraScale: 1 },
  };
  const batch = { group: "doodads", instances: [inst], gpu: withModel ? { model: { extent: box, geosets: [] } } : undefined } as unknown as ObjectBatch;
  const cam = camera();
  return (label: string, radius?: number) => {
    const [d, ...rest] = [label[0], Number(label.slice(1) || 0)] as [string, number];
    const [ux, uy] = DIRS[d] ?? [0, 0];
    const at: Vec3 = [ux * rest[0], uy * rest[0], 0];
    const [px, py] = TerrainRenderer.prototype.project.call(cam, at)!;
    const ray = TerrainRenderer.prototype.ray.call(cam, px, py);
    return TerrainRenderer.prototype.pickObject.call({ batches: [batch], hiddenGroups: new Set<string>() } as unknown as TerrainRenderer, ray, radius === undefined ? undefined : () => radius) === inst;
  };
}

test("a click on a rock picks it where the World Editor does: by the model's box, not its footprint", () => {
  const click = rockView(true);
  const labels = ["0", ...[30, 45, 60, 80, 100, 130].flatMap((d) => ["E", "W", "N", "S"].map((c) => `${c}${d}`))];
  const differs = labels.filter((l) => click(l, 64) !== WE_ROCK_HITS.has(l));
  assert.deepEqual(differs, [], "the footprint's radius is still given: the model's box decides");
});

test("the footprint's cylinder (a model without a box) misses the clicks the editor takes", () => {
  const click = rockView(false);
  assert.equal(click("E80", 64), false, "80 off is outside a footprint of radius 64");
  assert.equal(click("E60", 64), true);
});
