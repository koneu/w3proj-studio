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

/** The colours (uColor, red, green, blue) a draw of a one-layer model with this geoset animation gave, one per clock. */
function geosetColours(anim: { color: [number, number, number]; colorTrack?: { interp: 0; globalSeq: number; times: Uint32Array; values: Float32Array; size: number } }, clocks: { frame: number; seqStart: number; seqEnd: number; time: number }[]) {
  const colours: number[][] = [];
  const { gl } = recordingGl();
  const recording = new Proxy(gl as unknown as Record<string, unknown>, {
    get: (t, k) => (k === "uniform4f" ? (loc: string, ...v: number[]) => { if (loc === "uColor") colours.push(v); } : t[k as string]),
  }) as unknown as WebGL2RenderingContext;
  const m = model(3);
  m.geosetAnims.push({ geosetId: 0, alpha: 1, ...anim });
  const gpu = new ModelGpu(recording, m);
  for (const clock of clocks) {
    gpu.pose(clock);
    gpu.drawInstances(new Float32Array(16), { buffer: {} as WebGLBuffer, runs: [{ team: 0, first: 0, count: 1 }] }, {});
  }
  return colours.map((c) => c.slice(0, 3).map((v) => +v.toFixed(3)));
}

test("a geoset animation's static colour and a colour track's keys are blue, green, red (the World Editor's pictures)", () => {
  // World Editor, we-drive (tests/fixtures/we-specs/make-geoset-color.mjs): RuneArt's key (0, 0, 1) is red, GCracks'
  // (1, 0.85, 0) cyan, AzsharaStatue's static (0.31, 0.78, 0.86) gold.
  const still = { frame: 0, seqStart: 0, seqEnd: 0, time: 0 };
  assert.deepEqual(geosetColours({ color: [0.31, 0.78, 0.86] }, [still]), [[0.86, 0.78, 0.31]]);
  const track = { interp: 0 as const, globalSeq: -1, times: new Uint32Array([0, 100]), values: new Float32Array([0, 0, 1, 0, 0.5, 1]), size: 3 };
  // a sequence with no key of the track keeps the static colour
  const colours = geosetColours({ color: [0.25, 0.5, 0.75], colorTrack: track }, [{ frame: 0, seqStart: 0, seqEnd: 50, time: 0 }, { frame: 300, seqStart: 200, seqEnd: 250, time: 300 }]);
  assert.deepEqual(colours, [[1, 0, 0], [0.75, 0.5, 0.25]]);
});

test("a model is drawn in the tone it's asked for (tone.ts), with its light's HD shading", () => {
  // cliff.w3m's own sun: from the south-west, shadow intensity 5.85.
  const light = { dir: [-0.675, -0.406, 0.616] as [number, number, number], diffuse: [1.95, 1.95, 1.95] as [number, number, number], ambient: [0, 0, 0] as [number, number, number], shadow: 5.85 };
  const both = (opts: DrawOpts) => [drawnWith(0, "uTone", opts), drawnWith(0, "uShadeWrap", opts)];
  assert.deepEqual(both({}), [[0], [0]], "the model viewer: colour × light, plain shading, as before");
  assert.deepEqual(both({ tone: 2, light }), [[2], [5.85]], "HD");
  assert.deepEqual(both({ tone: 1, light }), [[1], [0]], "classic: the cosine alone");
});

test("a model under the game's own lighting gets its fill (tone.ts GAME_LIGHT_FILL), as the ground does", () => {
  // Without it, trees and units in the real shadows, and their sides away from the sun, were nearly black.
  const light = { dir: [-0.392, -0.169, 0.904] as [number, number, number], diffuse: [1, 1, 1] as [number, number, number], ambient: [0, 0, 0] as [number, number, number], shadow: 0.265, fill: 0.45 };
  assert.deepEqual(drawnWith(0, "uSunFill", { tone: 2, light }), [0.45]);
  assert.deepEqual(drawnWith(0, "uSunFill", { tone: 1, light }), [0], "classic: none");
});

/** What a draw of a one-layer model did: draw calls, its uniform1f values by name, the textures bound on unit 5. */
function drawRecord(filterMode: number, opts: DrawOpts) {
  const { gl, floats } = recordingGl();
  let unit = 0;
  const draws: number[] = [], onFive: unknown[] = [], caps: [string, number][] = [];
  const recording = new Proxy(gl as unknown as Record<string, unknown>, {
    get: (t, k) => {
      if (k === "TEXTURE0") return 1000;
      if (k === "activeTexture") return (u: number) => { unit = u - 1000; };
      if (k === "bindTexture") return (_t: number, tex: unknown) => { if (unit === 5) onFive.push(tex); };
      if (k === "drawElementsInstanced") return (_m: number, _c: number, _t: number, _o: number, n: number) => { draws.push(n); };
      if (k === "enable" || k === "disable") return (cap: number) => { caps.push([k, cap]); };
      if (k === "CULL_FACE") return 77;
      return t[k as string];
    },
  }) as unknown as WebGL2RenderingContext;
  const gpu = new ModelGpu(recording, model(filterMode));
  gpu.pose({ frame: 0, seqStart: 0, seqEnd: 0, time: 0 });
  floats.length = 0;
  onFive.length = 0;
  caps.length = 0;
  gpu.drawInstances(new Float32Array(16), { buffer: {} as WebGLBuffer, runs: [{ team: 0, first: 0, count: 3 }] }, opts);
  const f = (name: string) => floats.filter(([n]) => n === name).map(([, v]) => v);
  return { draws, f, onFive, caps };
}

test("into the sun's shadow map go the layers that hide what's behind them, from both sides, alpha-tested", () => {
  for (const mode of [0, 1]) {
    const r = drawRecord(mode, { shadowPass: true });
    assert.deepEqual(r.draws, [3], `mode ${mode} casts, every instance in one draw`);
    assert.deepEqual(r.f("uShadowPass"), [1]);
    assert.deepEqual(r.f("uAlphaTest"), [mode === 1 ? 0.75 : 0.01], "the same cut as when drawn: leaves cast their shape");
    assert.ok(r.caps.some(([k, c]) => k === "disable" && c === 77), "both sides");
  }
  for (const mode of [2, 3, 4, 5, 6]) assert.deepEqual(drawRecord(mode, { shadowPass: true }).draws, [], `mode ${mode} (blended) casts nothing`);
  assert.deepEqual(drawRecord(0, {}).f("uShadowPass"), [0], "drawn as usual otherwise");
});

test("a model is shaded with the sun's shadow map it's given, and the map isn't read while it's drawn into", () => {
  const map = { name: "the sun's map" } as unknown as WebGLTexture;
  const sun = { texture: map, lookup: new Float32Array(16), texel: 4, size: 2048 };
  const lit = drawRecord(0, { sun });
  assert.deepEqual(lit.f("uSunOn"), [1]);
  assert.deepEqual(lit.onFive, [map]);
  const none = drawRecord(0, {});
  assert.deepEqual(none.f("uSunOn"), [0], "no map: all lit");
  assert.equal(none.onFive.length, 1, "a depth texture is still bound for the shadow sampler");
  assert.notEqual(none.onFive[0], map);
  const pass = drawRecord(0, { sun, shadowPass: true });
  assert.deepEqual(pass.f("uSunOn"), [0]);
  assert.ok(!pass.onFive.includes(map), "never the map being drawn into");
});

test("a model whose node ids have a gap is posed like any other", () => {
  // A node chunk that only warned (ATCH, PRE2, …) or collision shapes in between leave ids without a node.
  const m = model(0);
  const node = (objectId: number, parentId: number) => ({ name: "", objectId, parentId, flags: 0, kind: "bone" });
  const nodes: unknown[] = [];
  nodes[0] = node(0, -1);
  nodes[5] = node(5, 0);
  (m as unknown as { nodes: unknown[]; pivots: Float32Array }).nodes = nodes;
  (m as unknown as { pivots: Float32Array }).pivots = new Float32Array(18);
  const { gl } = recordingGl();
  const gpu = new ModelGpu(gl, m);
  gpu.pose({ frame: 0, seqStart: 0, seqEnd: 0, time: 0 });
  assert.equal(gpu.stats.nodes, 2);
  assert.equal(gpu.nodeWorld[5]?.length, 16);
});
