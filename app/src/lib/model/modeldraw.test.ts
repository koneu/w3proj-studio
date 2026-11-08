import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelGpu } from "./renderer";

/** A WebGL context that does nothing but note each uniform1f by the uniform's name. */
function recordingGl() {
  const floats: [string, number][] = [];
  const base: Record<string, unknown> = {
    getExtension: () => null, getError: () => 0, getAttribLocation: () => 0, NO_ERROR: 0,
    getUniformLocation: (_p: unknown, name: string) => name,
    uniform1f: (loc: string, v: number) => { floats.push([loc, v]); },
  };
  const gl = new Proxy(base, {
    get: (t, k) => (k in t ? t[k as string] : typeof k === "string" && /^[A-Z_0-9]+$/.test(k) ? 1 : () => ({})),
  }) as unknown as WebGL2RenderingContext;
  return { gl, floats };
}

/** A one-triangle model with one layer of this filter mode. */
function model(filterMode: number) {
  const layer = { filterMode, shadingFlags: 0, textureIds: [0], textureAnimId: -1, coordId: 0, alpha: 1 };
  return {
    nodes: [], textures: [{ replaceableId: 0, path: "a.dds", flags: 0 }], materials: [{ priorityPlane: 0, flags: 0, layers: [layer] }],
    geosets: [{ positions: new Float32Array(9), normals: new Float32Array(9), uvs: new Float32Array(6), faces: new Uint16Array([0, 1, 2]), vertexGroups: new Uint8Array(3), groups: [[0]], materialId: 0, lod: 0 }],
    geosetAnims: [], globalSequences: [], textureAnims: [], sequences: [],
  } as unknown as ConstructorParameters<typeof ModelGpu>[1];
}

type DrawOpts = Parameters<ModelGpu["drawInstances"]>[2];

/** The values a draw of a one-layer model gave the named uniform. */
function drawnWith(filterMode: number, name: string, opts: DrawOpts) {
  const { gl, floats } = recordingGl();
  const gpu = new ModelGpu(gl, model(filterMode));
  gpu.pose({ frame: 0, seqStart: 0, seqEnd: 0, time: 0 });
  floats.length = 0;
  gpu.drawInstances(new Float32Array(16), { buffer: {} as WebGLBuffer, runs: [{ team: 0, first: 0, count: 1 }] }, opts);
  return floats.filter(([n]) => n === name).map(([, v]) => v);
}
const drawn = (filterMode: number, name: string, tint?: [number, number, number, number]) => drawnWith(filterMode, name, { tint });

test("an opaque layer (filter mode None) ignores its texture's alpha: HD diffuse textures with alpha 0 still show", () => {
  // Wood_Debris_Barrels_01 (YCde): one layer, mode 0, its _Diffuse.dds alpha 0 everywhere; the editor draws it whole.
  assert.deepEqual(drawn(0, "uOpaque"), [1]);
  assert.deepEqual(drawn(0, "uAlphaTest"), [0.01], "only the layer's own fade can drop it");
});

test("transparent and blended layers keep using the texture's alpha", () => {
  assert.deepEqual(drawn(1, "uOpaque"), [0]);
  assert.deepEqual(drawn(1, "uAlphaTest"), [0.75]);
  for (const mode of [2, 3, 4, 5, 6]) assert.deepEqual(drawn(mode, "uOpaque"), [0], `mode ${mode}`);
});

test("a see-through tint scales the threshold as before", () => {
  assert.deepEqual(drawn(1, "uAlphaTest", [1, 1, 1, 0.5]), [0.375]);
  assert.deepEqual(drawn(0, "uOpaque", [1, 1, 1, 0.5]), [1]);
});

test("a model is drawn in the tone it's asked for (tone.ts), with its light's HD shading", () => {
  // cliff.w3m's own sun: from the south-west, shadow intensity 5.85.
  const light = { dir: [-0.675, -0.406, 0.616] as [number, number, number], diffuse: [1.95, 1.95, 1.95] as [number, number, number], ambient: [0, 0, 0] as [number, number, number], shadow: 5.85 };
  const both = (opts: DrawOpts) => [drawnWith(0, "uTone", opts), drawnWith(0, "uShadeWrap", opts)];
  assert.deepEqual(both({}), [[0], [0]], "the model viewer: colour × light, plain shading, as before");
  assert.deepEqual(both({ tone: 2, light }), [[2], [5.85]], "HD");
  assert.deepEqual(both({ tone: 1, light }), [[1], [0]], "classic: the cosine alone");
});
