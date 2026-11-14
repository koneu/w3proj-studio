import assert from "node:assert/strict";
import { test } from "node:test";
import { ObjectLoader, type Placed, type Skin } from "./objects";
import { TerrainRenderer } from "./renderer";

// How placed objects are drawn as the World Editor draws them, apart from objects.test.ts so that it builds against
// the loader as it was before (scripts/fails-without.mjs fails it by what it asserts).

/** A WebGL context that accepts every call (nothing is drawn): enough to make models and textures. */
function fakeGl(): WebGL2RenderingContext {
  return new Proxy({ getError: () => 0, getAttribLocation: () => 0, getExtension: () => null, getParameter: () => 16384 } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : typeof k === "string" && /^[A-Z_0-9]+$/.test(k) ? 1 : () => ({})),
  }) as unknown as WebGL2RenderingContext;
}

/** An MDX model of nothing but a Stand animation. */
function standModel(): Uint8Array {
  const buf = new Uint8Array(4 + 12 + 8 + 132);
  const dv = new DataView(buf.buffer);
  const tag = (p: number, s: string) => { for (let i = 0; i < 4; i++) buf[p + i] = s.charCodeAt(i); };
  tag(0, "MDLX");
  tag(4, "VERS"); dv.setUint32(8, 4, true); dv.setUint32(12, 800, true);
  tag(16, "SEQS"); dv.setUint32(20, 132, true);
  for (let k = 0; k < 5; k++) buf[24 + k] = "Stand".charCodeAt(k);
  dv.setUint32(24 + 84, 1000, true);
  return buf;
}

const placed = (id: string, scale: [number, number, number]): Placed => ({ id, variation: 0, position: [0, 0, 0], angle: 0, scale });
const skin = (kind: string, minScale: number, maxScale: number): Skin => ({
  kind, file: "Doodads\\Test\\Test", numVar: 1, texId: -1, texFile: "", modelScale: 1, minScale, maxScale, randScale: true, fixedRot: null, uberSplat: "",
});
/** The drawn scale along each axis: the lengths of the world matrix's first three columns. */
const drawnScale = (w: Float32Array) => [0, 4, 8].map((c) => +Math.hypot(w[c], w[c + 1], w[c + 2]).toFixed(4));

test("a doodad stored outside its type's scales is drawn at the nearest one, each axis on its own; the stored scale stays", async () => {
  const loader = new ObjectLoader(fakeGl(), () => Promise.resolve(standModel()), () => {});
  // The armor rack LOam: 0.8 to 2. ZZdt: 1 to 1 (placed at 4, the World Editor shows it at 1).
  const skins = new Map([["LOam", skin("w3d", 0.8, 2)], ["ZZdt", skin("w3d", 1, 1)]]);
  const big = placed("LOam", [3, 3, 3]), mixed = placed("LOam", [0.3, 1.5, 2.5]), mirrored = placed("LOam", [-3, 1, 1]), foot = placed("ZZdt", [4, 4, 4]);
  const out = await loader.load("doodads", [big, mixed, mirrored, foot], skins, () => 0);
  const world = (p: Placed) => out.batches.flatMap((b) => b.instances).find((i) => i.pick?.placed === p)!.world;
  assert.deepEqual(drawnScale(world(big)), [2, 2, 2]);
  assert.deepEqual(drawnScale(world(mixed)), [0.8, 1.5, 2]);
  assert.deepEqual(drawnScale(world(foot)), [1, 1, 1]);
  assert.ok(world(mirrored)[0] < 0, "a mirrored axis stays mirrored");
  assert.deepEqual(drawnScale(world(mirrored)), [2, 1, 1]);
  assert.deepEqual(big.scale, [3, 3, 3], "the placement keeps its own scale (it's saved as it is)");
  assert.deepEqual(mixed.scale, [0.3, 1.5, 2.5]);
});

test("destructables are held to their type's scales too, units and items aren't", async () => {
  const loader = new ObjectLoader(fakeGl(), () => Promise.resolve(standModel()), () => {});
  // Lordaeron's tree LTlt: 0.8 to 1.2; placed at 0.4 and 3 the World Editor shows it about as big as at 1.
  const trees = await loader.load("doodads", [placed("LTlt", [3, 3, 3]), placed("LTlt", [0.4, 0.4, 0.4])], new Map([["LTlt", skin("w3b", 0.8, 1.2)]]), () => 0);
  assert.deepEqual(trees.batches[0].instances.map((i) => drawnScale(i.world)), [[1.2, 1.2, 1.2], [0.8, 0.8, 0.8]]);
  const units = await loader.load("units", [placed("hfoo", [3, 3, 3])], new Map([["hfoo", skin("w3u", 1, 1)]]), () => 0);
  assert.deepEqual(drawnScale(units.batches[0].instances[0].world), [3, 3, 3]);
  const items = await loader.load("units", [placed("ratc", [2, 2, 2])], new Map([["ratc", skin("w3t", 1, 1)]]), () => 0);
  assert.deepEqual(drawnScale(items.batches[0].instances[0].world), [2, 2, 2]);
});

test("a doodad with a click helper gets the editor's see-through cube at 0.4 of its size, which follows it", async () => {
  const read: string[] = [];
  const loader = new ObjectLoader(fakeGl(), (path) => { read.push(path); return Promise.resolve(standModel()); }, () => {});
  const fire = { ...skin("w3d", 0.8, 1.2), clickHelper: true }, rock = skin("w3d", 0.8, 1.2);
  const lit = placed("YOtf", [3, 3, 3]), stone = placed("LRrk", [1, 1, 1]);
  lit.angle = Math.PI / 4;
  const out = await loader.load("doodads", [lit, stone], new Map([["YOtf", fire], ["LRrk", rock]]), () => 0);
  assert.ok(read.includes("Objects\\InvalidObject\\InvalidObject.mdx"), "the World Editor's click helper model");
  const helpers = out.batches.filter((b) => b.instances.some((i) => i.follows));
  assert.equal(helpers.length, 1);
  const [h] = helpers;
  assert.equal(h.group, "doodads", "shown and hidden with the doodads");
  assert.equal(h.editorOnly, true, "not in game view");
  assert.deepEqual(h.tint?.map((v) => +v.toFixed(3)), [1, 1, 1, 0.376], "see-through, ClickHelperColor's alpha 96");
  assert.equal(h.instances.length, 1, "only the doodad that has one");
  const cube = h.instances[0], owner = out.batches.flatMap((b) => b.instances).find((i) => i.pick?.placed === lit)!;
  assert.equal(cube.follows?.owner, owner);
  assert.equal(cube.pick, undefined, "picked as its doodad, not as an object of its own");
  // 0.4 of the doodad as drawn (held to 1.2), turned with it.
  assert.deepEqual(drawnScale(cube.world), [0.48, 0.48, 0.48]);
  assert.ok(Math.abs(Math.atan2(cube.world[1], cube.world[0]) - Math.PI / 4) < 1e-6);
  assert.deepEqual(out.problems, []);
});

test("a click on a doodad's click helper picks the doodad, not in game view", async () => {
  const loader = new ObjectLoader(fakeGl(), () => Promise.resolve(standModel()), () => {});
  const fire = placed("YOtf", [1, 1, 1]);
  fire.position = [400, 0, 0];
  const out = await loader.load("doodads", [fire], new Map([["YOtf", { ...skin("w3d", 1, 1), clickHelper: true }]]), () => 0);
  // The doodad's own model picks nothing here (no radius for it, a sphere far off): only its helper is in the way.
  const model = out.batches.find((b) => !b.instances[0].follows)!, helper = out.batches.find((b) => b.instances[0].follows)!;
  model.instances[0].sphere = [0, 0, -5000, 1];
  const pick = (showEditorOnly: boolean) => TerrainRenderer.prototype.pickObject.call(
    { batches: out.batches, hiddenGroups: new Set<string>(), showEditorOnly } as unknown as TerrainRenderer,
    // Down onto the helper's top (the cube is 0.4 × 128 high, on the doodad's spot).
    { origin: [400, 0, 2000], dir: [0, 0, -1] }, () => undefined);
  assert.ok(helper.instances[0].sphere![2] > 0, "the helper stands on the ground");
  assert.equal(pick(true), model.instances[0], "the doodad, through its helper");
  assert.equal(pick(false), null, "game view leaves the helper out");
});

test("without the click helper's model the doodads are drawn without one, and nothing is reported against them", async () => {
  const loader = new ObjectLoader(fakeGl(), (path) => (path.includes("InvalidObject") ? Promise.reject(new Error("not stored")) : Promise.resolve(standModel())), () => {});
  const out = await loader.load("doodads", [placed("YOtf", [1, 1, 1])], new Map([["YOtf", { ...skin("w3d", 1, 1), clickHelper: true }]]), () => 0);
  assert.equal(out.batches.length, 1);
  assert.ok(!out.batches[0].instances.some((i) => i.follows));
  assert.deepEqual(out.problems, []);
});

test("a type whose scales are no range (most below least, not a number) is drawn as stored", async () => {
  const loader = new ObjectLoader(fakeGl(), () => Promise.resolve(standModel()), () => {});
  const skins = new Map([["D000", skin("w3d", 2, 1)], ["D001", skin("w3d", NaN, 1)]]);
  const out = await loader.load("doodads", [placed("D000", [3, 3, 3]), placed("D001", [3, 3, 3])], skins, () => 0);
  assert.deepEqual(out.batches.flatMap((b) => b.instances).map((i) => drawnScale(i.world)), [[3, 3, 3], [3, 3, 3]]);
});

test("a model whose read failed in passing is read again by the next load; one that isn't there, or can't be parsed, is not", async () => {
  const reads: string[] = [];
  let busy = true;
  const loader = new ObjectLoader(fakeGl(), (path) => {
    reads.push(path);
    if (path.includes("Gone")) return Promise.reject(new Error(`not found: ${path}`));
    if (path.includes("Broken")) return Promise.resolve(new Uint8Array([1, 2, 3, 4]));
    return busy ? Promise.reject(new Error("the storage is busy")) : Promise.resolve(standModel());
  }, () => {});
  const skins = new Map([["D000", skin("w3d", 1, 1)], ["D001", { ...skin("w3d", 1, 1), file: "Doodads\\Gone\\Gone" }], ["D002", { ...skin("w3d", 1, 1), file: "Doodads\\Broken\\Broken" }]]);
  const all = [placed("D000", [1, 1, 1]), placed("D001", [1, 1, 1]), placed("D002", [1, 1, 1])];
  const first = await loader.load("doodads", all, skins, () => 0, undefined, undefined, false);
  assert.equal(first.problems.length, 3);
  busy = false;
  reads.length = 0;
  const second = await loader.load("doodads", all, skins, () => 0, undefined, undefined, false);
  assert.deepEqual(reads, ["Doodads\\Test\\Test.mdx"], "only the one that failed in passing");
  assert.deepEqual(second.problems.map((p) => p.items[0].id).sort(), ["D001", "D002"]);
});
