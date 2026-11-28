// Doodad pick cost on a large forest: only instances whose bounding sphere (and box) the ray meets get the model's
// triangle pass (renderer.ts pickObject, meshpick.ts rayMesh). Headless: pickObject is driven without GL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { worldSphere } from "../../lib/model/frustum";
import { boxSphere, placement, type Placed } from "./objects";
import { TerrainRenderer, type ObjectBatch, type ObjectInstance } from "./renderer";

const COLS = 200, ROWS = 100, SPACING = 100;
const box = { min: [-20, -20, 0], max: [20, 20, 100] };

/** A forest of COLS x ROWS instances of one small model; `trianglePasses()` is how often the triangle pass read the geoset's positions (only rayMesh does). */
function forest() {
  let passes = 0;
  const geoset = {
    lod: 0, faces: new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]),
    get positions() { passes++; return new Float32Array([-20, -20, 100, 20, -20, 100, 20, 20, 100, -20, 20, 100, -20, -20, 0, 20, -20, 0, 20, 20, 0, -20, 20, 0]); },
  };
  const local = boxSphere(box);
  const instances: ObjectInstance[] = [];
  for (let i = 0; i < COLS * ROWS; i++) {
    const placed = { id: "ATtr", angle: 0, scale: [1, 1, 1], position: [(i % COLS) * SPACING, Math.floor(i / COLS) * SPACING, 0] } as unknown as Placed;
    const world = placement(placed, 1);
    instances.push({ world, team: 0, bounds: local, sphere: worldSphere(world, local), pick: { kind: "w3d", id: "ATtr", index: i, placed, model: "", extraScale: 1 } } as ObjectInstance);
  }
  const batch = { group: "doodads", instances, gpu: { model: { extent: box, geosets: [geoset] } } } as unknown as ObjectBatch;
  const view = { batches: [batch], hiddenGroups: new Set<string>() } as unknown as TerrainRenderer;
  return {
    instances, trianglePasses: () => passes,
    pick: (origin: [number, number, number], dir: [number, number, number]) => TerrainRenderer.prototype.pickObject.call(view, { origin, dir }),
  };
}

test("a pick over 20000 doodads runs the triangle pass only for those the ray meets", () => {
  const f = forest();
  assert.equal(f.instances.length, 20000);
  // Straight down onto one tree.
  const hit = f.pick([50 * SPACING, 40 * SPACING, 500], [0, 0, -1]);
  assert.equal(hit, f.instances[40 * COLS + 50]);
  assert.equal(f.trianglePasses(), 1, "one tree under the ray, one triangle pass");
  // Through the empty ground between the columns: no pass at all.
  const before = f.trianglePasses();
  assert.equal(f.pick([50 * SPACING + 50, 40 * SPACING + 50, 500], [0, 0, -1]), null);
  assert.equal(f.trianglePasses(), before, "a ray between the trees runs no triangle pass");
  // Along one whole column: every tree in it is met, and only those.
  const c0 = f.trianglePasses();
  const nearest = f.pick([30 * SPACING, -500, 50], [0, 1, 0]);
  assert.equal(nearest, f.instances[30]);
  assert.equal(f.trianglePasses() - c0, ROWS, "the ROWS trees of the column, not the 20000");
  // No time bound: the triangle pass counts above are the cost, and they don't change with the machine's load.
});
