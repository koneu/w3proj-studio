import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelGpu, type InstanceRuns } from "./renderer";

/** A WebGL2 context that does nothing and counts the calls made to it, by name, with their arguments. */
function countingGl() {
  const calls: { name: string; args: unknown[] }[] = [];
  const base: Record<string, unknown> = { getError: () => 0, getAttribLocation: (_p: unknown, name: string) => (name === "aWorld" ? 5 : 0), getExtension: () => null, NO_ERROR: 0 };
  const gl = new Proxy(base, {
    get: (t, k) => {
      if (k in t) return t[k as string];
      if (typeof k === "string" && /^[A-Z_0-9]+$/.test(k)) return k;
      return (...args: unknown[]) => { calls.push({ name: String(k), args }); return {}; };
    },
  }) as unknown as WebGL2RenderingContext;
  return { gl, calls, named: (n: string) => calls.filter((c) => c.name === n) };
}

/** One triangle, one material with the given layers, one texture per layer (replaceable ids given). */
function model(layers: { filterMode: number; replaceableId: number }[]) {
  return {
    nodes: [], textures: layers.map((l, i) => ({ replaceableId: l.replaceableId, path: l.replaceableId ? "" : `t${i}.blp`, flags: 0 })),
    materials: [{ priorityPlane: 0, flags: 0, layers: layers.map((l, i) => ({ filterMode: l.filterMode, shadingFlags: 0, textureIds: [i], textureAnimId: -1, coordId: 0, alpha: 1 })) }],
    geosets: [{ positions: new Float32Array(9), normals: new Float32Array(9), uvs: new Float32Array(6), faces: new Uint16Array([0, 1, 2]), vertexGroups: new Uint8Array(3), groups: [[0]], materialId: 0, lod: 0 }],
    geosetAnims: [], globalSequences: [], textureAnims: [], sequences: [],
  } as unknown as ConstructorParameters<typeof ModelGpu>[1];
}

const viewProj = new Float32Array(16);
const runs: InstanceRuns = { buffer: {} as WebGLBuffer, runs: [{ team: 0, first: 0, count: 5 }, { team: 3, first: 5, count: 2 }, { team: 7, first: 7, count: 1 }] };

test("all instances of a model are one draw call per layer, whatever their player colours", () => {
  const { gl, named } = countingGl();
  const gpu = new ModelGpu(gl, model([{ filterMode: 0, replaceableId: 0 }, { filterMode: 1, replaceableId: 0 }]));
  gpu.pose({ frame: 0, seqStart: 0, seqEnd: 0, time: 0 });
  const before = named("drawElementsInstanced").length;
  gpu.drawInstances(viewProj, runs, { pass: "all" });
  const draws = named("drawElementsInstanced").slice(before);
  assert.deepEqual(draws.map((d) => d.args[4]), [8, 8], "two layers, each drawing the 8 instances at once");
  assert.equal(named("drawElements").length, 0, "nothing drawn one instance at a time");
  assert.equal(named("uniformMatrix4fv").length, 1, "one view matrix for the lot, no world matrix per instance");
});

test("a layer that shows the player colour is drawn once per run, each with its colour's texture", () => {
  const { gl, named, calls } = countingGl();
  const gpu = new ModelGpu(gl, model([{ filterMode: 0, replaceableId: 0 }, { filterMode: 0, replaceableId: 1 }]));
  gpu.pose({ frame: 0, seqStart: 0, seqEnd: 0, time: 0 });
  const from = calls.length;
  gpu.drawInstances(viewProj, runs, { pass: "all" });
  const draws = calls.slice(from).filter((c) => c.name === "drawElementsInstanced").map((d) => d.args[4]);
  assert.deepEqual(draws, [8, 5, 2, 1], "the plain layer at once, the team colour layer run by run");
  // Each run's draw starts at its own instance: the world matrix columns point at first × 64 bytes.
  const offsets = named("vertexAttribPointer").filter((c) => c.args[0] === 5).map((c) => c.args[5]);
  assert.deepEqual(offsets, [0, 5 * 64, 7 * 64], "pointed at each run once (the first run is already where the plain layer left it)");
});

test("draw() of one instance goes through the same path: one instance, its own world matrix uploaded", () => {
  const { gl, named, calls } = countingGl();
  const gpu = new ModelGpu(gl, model([{ filterMode: 0, replaceableId: 0 }]));
  gpu.pose({ frame: 0, seqStart: 0, seqEnd: 0, time: 0 });
  const from = calls.length;
  const world = new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 10, 20, 30, 1]);
  gpu.draw(viewProj, world, { team: 2 });
  const after = calls.slice(from);
  const upload = after.find((c) => c.name === "bufferSubData");
  assert.equal(upload?.args[2], world, "the world matrix goes into the one-instance buffer");
  assert.deepEqual(after.filter((c) => c.name === "drawElementsInstanced").map((d) => d.args[4]), [1]);
  assert.equal(named("drawElements").length, 0);
});
