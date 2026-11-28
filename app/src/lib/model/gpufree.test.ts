import assert from "node:assert/strict";
import { test } from "node:test";
import { countingGl, tinyMdx, tinyTga } from "../testhelpers/countinggl";
import { decodeImage } from "../image/index.ts";
import { parseModel } from "./mdl";
import { ModelGpu, ModelRenderer } from "./renderer";

const still = { frame: 0, seqStart: 0, seqEnd: 1000, time: 0 };
const instance = { buffer: {} as WebGLBuffer, runs: [{ team: 0, first: 0, count: 1 }] };

/** A context with the per-context shared objects already made (they outlive any model), and what is live then. */
function warm() {
  const c = countingGl();
  new ModelGpu(c.gl, parseModel(tinyMdx("a.tga"))).dispose();
  return Object.assign(c, { before: c.snapshot() });
}

test("ModelGpu.dispose deletes exactly what the model made: bone texture, vertex arrays and buffers", () => {
  const c = warm();
  const gpu = new ModelGpu(c.gl, parseModel(tinyMdx("a.tga", 3)));
  gpu.pose(still);
  // Per geoset: its vertex array, six attribute buffers (a geoset without a second UV set shares one) and the indices; plus the bone texture.
  assert.equal(c.since(c.before).length > 3 * 3, true, "something was made");
  gpu.dispose();
  assert.deepEqual(c.since(c.before), [], "everything made is deleted");
  assert.deepEqual(c.bad, [], "nothing deleted twice or not made here");
});

test("dispose twice deletes nothing the second time; a disposed model poses and draws nothing", () => {
  const c = warm();
  const gpu = new ModelGpu(c.gl, parseModel(tinyMdx("a.tga")));
  gpu.dispose();
  const deletes = { ...c.deletes }, poses = gpu.fullPoses;
  gpu.dispose();
  assert.deepEqual(c.deletes, deletes);
  gpu.pose(still);
  gpu.drawInstances(new Float32Array(16), instance, {});
  gpu.draw(new Float32Array(16), new Float32Array(16));
  assert.equal(gpu.fullPoses, poses, "no pose on deleted textures");
  assert.equal(gpu.disposed, true);
  assert.deepEqual(c.bad, []);
});

test("the wireframe's vertex array and indices are deleted only when a wireframe was drawn", () => {
  const c = warm();
  const plain = new ModelGpu(c.gl, parseModel(tinyMdx("a.tga", 2)));
  const arrays = c.creates.vertexArray;
  plain.pose(still);
  plain.drawInstances(new Float32Array(16), instance, {});
  assert.equal(c.creates.vertexArray, arrays, "no wire array made without a wireframe draw");
  const before = c.deletes.vertexArray;
  plain.dispose();
  assert.equal(c.deletes.vertexArray - before, 2, "one array per geoset, no wire array to delete");

  const wired = new ModelGpu(c.gl, parseModel(tinyMdx("a.tga", 2)));
  wired.pose(still);
  const made = c.creates.vertexArray;
  wired.drawInstances(new Float32Array(16), instance, { wireframe: true });
  assert.equal(c.creates.vertexArray - made, 2, "a wire array per geoset");
  wired.dispose();
  assert.deepEqual(c.since(c.before), []);
  assert.deepEqual(c.bad, []);
});

test("a lost context: dispose deletes nothing and doesn't throw", () => {
  const c = warm();
  const gpu = new ModelGpu(c.gl, parseModel(tinyMdx("a.tga")));
  c.lost = true;
  const deletes = { ...c.deletes };
  gpu.dispose();
  assert.deepEqual(c.deletes, deletes);
  assert.equal(gpu.disposed, true);
});

/** A renderer on a fake canvas that hands out the counting context. */
function renderer(c: ReturnType<typeof countingGl>, texture = "a.tga") {
  const canvas = { getContext: () => c.gl, clientWidth: 10, clientHeight: 10 } as unknown as HTMLCanvasElement;
  return new ModelRenderer(canvas, parseModel(tinyMdx(texture)));
}

test("ModelRenderer.free deletes what the renderer made, its textures included, and leaves the context's shared objects", () => {
  const c = warm();
  const r = renderer(c);
  r.setTexture(0, decodeImage(tinyTga(), "a.tga"));
  r.setTexture(0, decodeImage(tinyTga(), "a.tga"));
  assert.equal(c.since(c.before).filter((o) => (o as { kind: string }).kind === "texture").length, 2, "the replaced texture was deleted at once, the new one is live (plus the bone texture)");
  r.free();
  assert.deepEqual(c.since(c.before), [], "everything the renderer made is gone");
  const deletes = { ...c.deletes };
  r.free();
  assert.deepEqual(c.deletes, deletes, "twice is nothing");
  r.setTexture(0, decodeImage(tinyTga(), "a.tga"));
  assert.deepEqual(c.since(c.before), [], "a texture that arrives after the free is not made");
  assert.deepEqual(c.bad, []);
  // The next model on the same context still works: the shared program and textures were not deleted.
  const next = renderer(c);
  next.free();
  assert.deepEqual(c.since(c.before), []);
  assert.deepEqual(c.bad, []);
});

test("a context lost: ModelRenderer.free deletes nothing", () => {
  const c = warm();
  const r = renderer(c);
  c.lost = true;
  const deletes = { ...c.deletes };
  r.free();
  assert.deepEqual(c.deletes, deletes);
});
