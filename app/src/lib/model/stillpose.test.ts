import assert from "node:assert/strict";
import { test } from "node:test";
import type { Track } from "./mdx";
import { ModelGpu, poseNodes, poseStill, trackStill } from "./renderer";

const track = (times: number[], values: number[], size: number, interp = 1, extra: Partial<Track> = {}): Track =>
  ({ interp, globalSeq: -1, times: new Uint32Array(times), values: new Float32Array(values), size, ...extra }) as unknown as Track;

test("a track is still in a sequence with no key, one key, or equal keys interpolated without tangents", () => {
  assert.equal(trackStill(undefined, 0, 100, []), true);
  assert.equal(trackStill(track([50], [1, 2, 3], 3), 0, 100, []), true, "one key");
  assert.equal(trackStill(track([0, 100], [1, 2, 3, 1, 2, 3], 3), 0, 100, []), true, "equal keys, linear");
  assert.equal(trackStill(track([0, 100], [1, 2, 3, 1, 2, 4], 3), 0, 100, []), false, "keys that differ");
  assert.equal(trackStill(track([0, 100, 300], [1, 2, 3, 1, 2, 3, 9, 9, 9], 3), 0, 100, []), true, "a different key in another sequence doesn't count");
  assert.equal(trackStill(track([0, 100], [5, 9], 1, 0), 0, 100, []), false, "stepping between different keys moves");
});

test("Hermite and Bezier curves between equal keys bend by their tangents; quaternions stay only at unit length", () => {
  const tan = new Float32Array([1, 1, 1, 1, 1, 1]);
  assert.equal(trackStill(track([0, 100], [1, 2, 3, 1, 2, 3], 3, 2, { inTan: tan, outTan: tan }), 0, 100, []), false);
  assert.equal(trackStill(track([0, 100], [0, 0, 0, 1, 0, 0, 0, 1], 4, 2), 0, 100, []), true, "a unit quaternion twice");
  assert.equal(trackStill(track([0, 100], [0, 0, 0, 2, 0, 0, 0, 2], 4, 1), 0, 100, []), false, "slerp normalises a longer one in between");
});

test("a global sequence counts over its own length; one of length 0 holds its first key", () => {
  const moving = track([0, 500], [0, 1], 1, 1, { globalSeq: 0 });
  assert.equal(trackStill(moving, 0, 10, [1000]), false, "moves in its own time, whatever the sequence");
  assert.equal(trackStill(moving, 0, 10, [0]), true);
});

/** A model with one bone, whose translation track is given, and one triangle on it. */
function model(translation: Track | undefined) {
  return {
    nodes: [{ parentId: -1, translation }], pivots: new Float32Array(3),
    textures: [{ replaceableId: 0, path: "t.blp", flags: 0 }], materials: [{ priorityPlane: 0, flags: 0, layers: [{ filterMode: 0, shadingFlags: 0, textureIds: [0], textureAnimId: -1, coordId: 0, alpha: 1 }] }],
    geosets: [{ positions: new Float32Array(9), normals: new Float32Array(9), uvs: new Float32Array(6), faces: new Uint16Array([0, 1, 2]), vertexGroups: new Uint8Array(3), groups: [[0]], materialId: 0, lod: 0 }],
    geosetAnims: [], globalSequences: [], textureAnims: [], sequences: [{ name: "Stand", start: 0, end: 1000 }],
  } as unknown as ConstructorParameters<typeof ModelGpu>[1];
}

function gl() {
  const calls: string[] = [];
  const g = new Proxy({ getError: () => 0, getAttribLocation: () => 0, getExtension: () => null } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : typeof k === "string" && /^[A-Z_0-9]+$/.test(k) ? 1 : (..._a: unknown[]) => { calls.push(String(k)); return {}; }),
  }) as unknown as WebGL2RenderingContext;
  return { g, uploads: () => calls.filter((c) => c === "texSubImage2D").length };
}

const at = (frame: number) => ({ frame, seqStart: 0, seqEnd: 1000, time: frame });

test("a model in which nothing moves is posed once; its clock still moves on", () => {
  const still = model(track([0, 1000], [5, 0, 0, 5, 0, 0], 3));
  assert.equal(poseStill(still, 0, 1000), true);
  const { g, uploads } = gl();
  const gpu = new ModelGpu(g, still);
  gpu.pose(at(0));
  const before = uploads();
  gpu.pose(at(400));
  gpu.pose(at(800));
  assert.equal(gpu.fullPoses, 1);
  assert.equal(uploads(), before, "no bone upload for the same pose");
  assert.equal(gpu.poseClock.frame, 800, "particles go by the clock");
  assert.deepEqual(Array.from(gpu.nodeWorld[0]), Array.from(poseNodes(still, at(800))[0]), "and the pose kept is the pose of now");
  gpu.hidden.add(0);
  gpu.pose(at(900));
  assert.equal(gpu.fullPoses, 2, "a geoset hidden or shown poses again");
});

test("a model that moves is posed at every moment (the control)", () => {
  const moving = model(track([0, 1000], [0, 0, 0, 100, 0, 0], 3));
  assert.equal(poseStill(moving, 0, 1000), false);
  const { g } = gl();
  const gpu = new ModelGpu(g, moving);
  gpu.pose(at(0));
  gpu.pose(at(400));
  gpu.pose(at(800));
  assert.equal(gpu.fullPoses, 3);
  assert.equal(gpu.nodeWorld[0][12], 80);
});
