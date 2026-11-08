// WebGL2 rendering of parsed MDX models: GPU skinning (bone matrices in a
// float texture), keyframe animation, Warcraft blend modes, team colour.
// Particles, ribbons and texture animations are not drawn.

import { FOG_FS, FOG_VS, setFog, type Fog } from "./fog";
import type { DecodedImage } from "../image/index";
import { createTexture, isOpaqueTexture } from "./gltexture";
import { standSequence } from "./stand";
import type { Extent, Model, TextureAnim, Track } from "./mdx";
import { ParticleInstance, ParticleRenderer } from "./particles";
import type { SceneLight } from "./dnclight";

/** Shading without a scene light (model viewer): soft ambient plus a light from the front left. */
export const DEFAULT_LIGHT: SceneLight = { dir: [0.4, -0.3, 0.85], diffuse: [0.7, 0.7, 0.7], ambient: [0.45, 0.45, 0.45] };

export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;

// ------------------------------------------------------------------ math

export const mat4 = {
  identity(): Mat4 { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
  mul(a: Mat4, b: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return out;
  },
  perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
    const f = 1 / Math.tan(fovy / 2), m = new Float32Array(16);
    m[0] = f / aspect; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1; m[14] = (2 * far * near) / (near - far);
    return m;
  },
  lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
    const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x), m = mat4.identity();
    m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
    m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
    m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
    m[12] = -dot(x, eye); m[13] = -dot(y, eye); m[14] = -dot(z, eye);
    return m;
  },
  /** T(pivot) · T(t) · R(q) · S(s) · T(-pivot) */
  node(pivot: Vec3, t: Vec3, q: number[], s: Vec3): Mat4 {
    const [x, y, z, w] = q, m = new Float32Array(16);
    const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
    const r = [1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy)];
    for (let c = 0; c < 3; c++) for (let rr = 0; rr < 3; rr++) m[c * 4 + rr] = r[c * 3 + rr] * s[c];
    m[15] = 1;
    // translation = pivot + t - (R·S)·pivot
    for (let rr = 0; rr < 3; rr++) {
      m[12 + rr] = pivot[rr] + t[rr] - (m[rr] * pivot[0] + m[4 + rr] * pivot[1] + m[8 + rr] * pivot[2]);
    }
    return m;
  },
};
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ------------------------------------------------------------------ animation

export interface Clock {
  /** Current frame within the sequence interval. */
  frame: number;
  seqStart: number;
  seqEnd: number;
  /** Milliseconds since start, for global sequences. */
  time: number;
}

/** Whether a track's key times never go down (as the format has them), checked once per list. */
const timesInOrder = new WeakMap<Uint32Array, boolean>();
function inOrder(times: Uint32Array): boolean {
  let ok = timesInOrder.get(times);
  if (ok === undefined) {
    ok = true;
    for (let k = 1; k < times.length && ok; k++) if (times[k] < times[k - 1]) ok = false;
    timesInOrder.set(times, ok);
  }
  return ok;
}

/** The first index in [lo, hi) whose time is at least `v` (`orAbove` false) or above it (true), or hi; times in order. */
function firstFrom(times: Uint32Array, lo: number, hi: number, v: number, orAbove: boolean): number {
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (orAbove ? times[mid] > v : times[mid] >= v) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/** Key k of a track into out (made `size` long). */
function keyInto(values: Float32Array, size: number, k: number, out: number[]): number[] {
  out.length = size;
  for (let j = 0; j < size; j++) out[j] = values[k * size + j];
  return out;
}

/** Samples a track; `fallback` when it has no key inside the interval. */
export function sample(track: Track | undefined, clock: Clock, globalSeqs: number[], fallback: number[]): number[] {
  return sampleInto(track, clock, globalSeqs, fallback, []);
}

/** sample(), with the value written into `out` (made `size` long) instead of a new array: `out`, or
 *  `fallback` itself when the track has no key inside the interval. For poses, which sample thousands
 *  of tracks a frame. */
export function sampleInto(track: Track | undefined, clock: Clock, globalSeqs: number[], fallback: number[], out: number[]): number[] {
  if (!track || track.times.length === 0) return fallback;
  let t = clock.frame, start = clock.seqStart, end = clock.seqEnd;
  const { times, values, size } = track;
  if (track.globalSeq >= 0) {
    const dur = globalSeqs[track.globalSeq] ?? 0;
    // A global sequence of length 0 holds a constant: the first key, wherever it sits
    // (e.g. shoreline emitters keep their sideways turn there).
    if (dur <= 0) return keyInto(values, size, 0, out);
    start = 0; end = dur; t = clock.time % dur;
  }
  let first = -1, last = -1, i: number;
  const sorted = inOrder(times);
  if (sorted) {
    // The keys of every sequence are in one list, in time order: the sequence's are found by halving.
    first = firstFrom(times, 0, times.length, start, false);
    last = firstFrom(times, first, times.length, end, true) - 1;
    if (first > last) first = last = -1;
  } else {
    for (let k = 0; k < times.length; k++) {
      if (times[k] < start || times[k] > end) continue;
      if (first < 0) first = k;
      last = k;
    }
  }
  if (first < 0) return fallback;
  if (t <= times[first] || first === last) return keyInto(values, size, first, out);
  if (t >= times[last]) return keyInto(values, size, last, out);
  // The last key at or before t (t is between the first and the last key here).
  i = sorted ? Math.min(last - 1, Math.max(first, firstFrom(times, first, last + 1, t, true) - 1)) : first;
  while (i < last && times[i + 1] <= t) i++;
  const a = i, b = i + 1, u = (t - times[a]) / (times[b] - times[a]);
  if (track.interp === 0) return keyInto(values, size, a, out);
  out.length = size;
  const A = a * size, B = b * size;
  if (size === 4) {
    // Quaternions: slerp for all interpolation types (the shorter way round).
    let d = values[A] * values[B] + values[A + 1] * values[B + 1] + values[A + 2] * values[B + 2] + values[A + 3] * values[B + 3];
    const sign = d < 0 ? -1 : 1;
    d = Math.abs(d);
    if (d > 0.9995) {
      for (let k = 0; k < 4; k++) out[k] = values[A + k] + (sign * values[B + k] - values[A + k]) * u;
      const l = Math.hypot(out[0], out[1], out[2], out[3]);
      for (let k = 0; k < 4; k++) out[k] = out[k] / l;
      return out;
    }
    const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - u) * th) / s, wb = Math.sin(u * th) / s;
    for (let k = 0; k < 4; k++) out[k] = values[A + k] * wa + sign * values[B + k] * wb;
    return out;
  }
  if (track.interp === 1 || !track.inTan || !track.outTan) {
    for (let k = 0; k < size; k++) out[k] = values[A + k] + (values[B + k] - values[A + k]) * u;
    return out;
  }
  const ot = track.outTan, it = track.inTan;
  if (track.interp === 2) {
    // Hermite
    const u2 = u * u, u3 = u2 * u;
    const h1 = 2 * u3 - 3 * u2 + 1, h2 = -2 * u3 + 3 * u2, h3 = u3 - 2 * u2 + u, h4 = u3 - u2;
    for (let k = 0; k < size; k++) out[k] = h1 * values[A + k] + h2 * values[B + k] + h3 * ot[A + k] + h4 * it[B + k];
    return out;
  }
  // Bezier
  const iu = 1 - u;
  for (let k = 0; k < size; k++) out[k] = iu * iu * iu * values[A + k] + 3 * iu * iu * u * ot[A + k] + 3 * iu * u * u * it[B + k] + u * u * u * values[B + k];
  return out;
}

const IDENTITY3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** A layer's texture coordinate transform (column-major 3×3) at a moment: scaled and turned
 *  about the texture's centre, then moved; identity without an animation. */
export function textureMatrix(anim: TextureAnim | undefined, clock: Clock, globalSeqs: number[]): Float32Array {
  if (!anim) return IDENTITY3;
  const [tx, ty] = sample(anim.translation, clock, globalSeqs, [0, 0, 0]);
  const q = sample(anim.rotation, clock, globalSeqs, [0, 0, 0, 1]);
  const [sx, sy] = sample(anim.scaling, clock, globalSeqs, [1, 1, 1]);
  // Only the turn about Z applies to a 2D texture.
  const angle = 2 * Math.atan2(q[2], q[3]);
  const c = Math.cos(angle), s = Math.sin(angle);
  const ax = c * sx, ay = s * sx, bx = -s * sy, by = c * sy;
  // uv' = centre + R·S·(uv − centre) + t
  return new Float32Array([ax, ay, 0, bx, by, 0, 0.5 + tx - (ax + bx) * 0.5, 0.5 + ty - (ay + by) * 0.5, 1]);
}

/** Nodes parents first (cached per model). */
const nodeOrders = new WeakMap<Model, number[]>();
function nodeOrder(model: Model): number[] {
  let order = nodeOrders.get(model);
  if (!order) {
    const depth = (id: number, guard = 0): number => {
      const n = model.nodes[id];
      return !n || n.parentId < 0 || guard > 256 ? 0 : 1 + depth(n.parentId, guard + 1);
    };
    order = model.nodes.map((n, i) => (n ? i : -1)).filter((i) => i >= 0).sort((a, b) => depth(a) - depth(b));
    nodeOrders.set(model, order);
  }
  return order;
}

/** A node's translation, rotation and scaling without a key (read only). */
const NO_MOVE = [0, 0, 0], NO_TURN = [0, 0, 0, 1], NO_SCALE = [1, 1, 1];

/** Model-space matrix of every node (by object id) at a moment of an animation. */
export function poseNodes(model: Model, clock: Clock): Mat4[] {
  const world: Mat4[] = [];
  // The samples go into the same three arrays node after node: mat4.node only reads them.
  const T: number[] = [], R: number[] = [], S: number[] = [], pivot: Vec3 = [0, 0, 0];
  for (const id of nodeOrder(model)) {
    const n = model.nodes[id];
    pivot[0] = model.pivots[id * 3] ?? 0; pivot[1] = model.pivots[id * 3 + 1] ?? 0; pivot[2] = model.pivots[id * 3 + 2] ?? 0;
    const t = sampleInto(n.translation, clock, model.globalSequences, NO_MOVE, T) as Vec3;
    const r = sampleInto(n.rotation, clock, model.globalSequences, NO_TURN, R);
    const s = sampleInto(n.scaling, clock, model.globalSequences, NO_SCALE, S) as Vec3;
    const local = mat4.node(pivot, t, r, s);
    world[id] = n.parentId >= 0 && world[n.parentId] ? mat4.mul(world[n.parentId], local) : local;
  }
  return world;
}

/** Whether a track gives the same value at every moment of a sequence (or of its global sequence),
 *  going by what sample() does: no key or one key in it, or keys that are all the same and are
 *  interpolated without tangents. Hermite and Bezier curves bend between equal keys, so they count as moving. */
export function trackStill(track: Track | undefined, seqStart: number, seqEnd: number, globalSeqs: number[]): boolean {
  if (!track || track.times.length === 0) return true;
  let start = seqStart, end = seqEnd;
  if (track.globalSeq >= 0) {
    const dur = globalSeqs[track.globalSeq] ?? 0;
    if (dur <= 0) return true;
    start = 0; end = dur;
  }
  const { times, values, size } = track;
  let first = -1, keys = 0;
  for (let i = 0; i < times.length; i++) {
    if (times[i] < start || times[i] > end) continue;
    keys++;
    if (first < 0) { first = i; continue; }
    for (let k = 0; k < size; k++) if (values[i * size + k] !== values[first * size + k]) return false;
  }
  if (keys < 2 || track.interp === 0) return true;
  // Equal quaternions are slerped into themselves only when they're of unit length (slerp normalises).
  if (size === 4) return Math.abs(Math.hypot(values[first * 4], values[first * 4 + 1], values[first * 4 + 2], values[first * 4 + 3]) - 1) < 1e-4;
  return track.interp === 1 || !track.inTan || !track.outTan;
}

/** Whether nothing a pose gives (node matrices, geoset opacity and colour, layer opacity, texture and
 *  texture transform) changes during the sequence from `seqStart` to `seqEnd`: then posing it again is the same pose. */
export function poseStill(model: Model, seqStart: number, seqEnd: number): boolean {
  const gs = model.globalSequences, still = (t: Track | undefined) => trackStill(t, seqStart, seqEnd, gs);
  for (const n of model.nodes) if (n && !(still(n.translation) && still(n.rotation) && still(n.scaling))) return false;
  for (const ga of model.geosetAnims) if (!still(ga.alphaTrack) || !still(ga.colorTrack)) return false;
  for (const mat of model.materials) for (const l of mat.layers) if (!still(l.alphaTrack) || !still(l.textureTrack)) return false;
  for (const ta of model.textureAnims) if (ta && !(still(ta.translation) && still(ta.rotation) && still(ta.scaling))) return false;
  return true;
}

/** The start of the Stand animation of a look (see ./stand): how placed objects stand. */
export function standClock(model: Model, props: readonly string[] = []): Clock {
  const stand = standSequence(model.sequences, props);
  return { frame: stand?.start ?? 0, seqStart: stand?.start ?? 0, seqEnd: stand?.end ?? 0, time: 0 };
}

// ------------------------------------------------------------------ team colours

export const TEAM_COLORS: [string, Vec3][] = [
  ["Red", [255, 3, 3]], ["Blue", [0, 66, 255]], ["Teal", [28, 230, 185]], ["Purple", [84, 0, 129]],
  ["Yellow", [255, 252, 1]], ["Orange", [254, 138, 14]], ["Green", [32, 192, 0]], ["Pink", [229, 91, 176]],
  ["Gray", [149, 150, 151]], ["Light Blue", [126, 191, 241]], ["Dark Green", [16, 98, 70]], ["Brown", [78, 42, 4]],
  ["Maroon", [155, 0, 0]], ["Navy", [0, 0, 195]], ["Turquoise", [0, 234, 255]], ["Violet", [190, 0, 254]],
  ["Wheat", [235, 205, 135]], ["Peach", [248, 164, 139]], ["Mint", [191, 255, 128]], ["Lavender", [220, 185, 235]],
  ["Coal", [40, 40, 40]], ["Snow", [235, 240, 255]], ["Emerald", [0, 120, 30]], ["Peanut", [164, 111, 51]],
];

/** Textures for replaceable ids other than team colour/glow. */
const REPLACEABLE: Record<number, string> = {
  11: "ReplaceableTextures\\Cliff\\Cliff0.blp",
  31: "ReplaceableTextures\\LordaeronTree\\LordaeronSummerTree.blp",
  32: "ReplaceableTextures\\AshenvaleTree\\AshenTree.blp",
  33: "ReplaceableTextures\\BarrensTree\\BarrensTree.blp",
  34: "ReplaceableTextures\\NorthrendTree\\NorthTree.blp",
  35: "ReplaceableTextures\\Mushroom\\MushroomTree.blp",
  36: "ReplaceableTextures\\RuinsTree\\RuinsTree.blp",
  37: "ReplaceableTextures\\OutlandMushroomTree\\MushroomTree.blp",
};

// ------------------------------------------------------------------ shaders

const VS = `#version 300 es
precision highp float;
in vec3 aPos; in vec3 aNormal; in vec2 aUV; in vec4 aBones; in vec4 aWeights;
// The instance's world transform: one per instance, so every copy of a model in a batch is one draw.
in mat4 aWorld;
uniform mat4 uViewProj;
// Texture animation (TXAN) of the layer: identity without one.
uniform mat3 uTexMatrix;
uniform highp sampler2D uBones;
// Optional ground height map (R32F, one texel per terrain corner): cliff models
// follow it. uHeightRect = world x/y of corner (0,0), corners per row/column.
uniform highp sampler2D uHeight; uniform float uUseHeight; uniform vec4 uHeightRect;
out vec3 vNormal; out vec2 vUV;
${FOG_VS}
float groundAt(vec2 p) {
  vec2 g = clamp((p - uHeightRect.xy) / 128.0, vec2(0.0), uHeightRect.zw - 1.0);
  ivec2 i0 = ivec2(floor(g)), i1 = min(i0 + 1, ivec2(uHeightRect.zw) - 1);
  vec2 f = g - vec2(i0);
  float a = mix(texelFetch(uHeight, i0, 0).r, texelFetch(uHeight, ivec2(i1.x, i0.y), 0).r, f.x);
  float b = mix(texelFetch(uHeight, ivec2(i0.x, i1.y), 0).r, texelFetch(uHeight, i1, 0).r, f.x);
  return mix(a, b, f.y);
}
mat4 bone(float id) {
  int i = int(id) * 4;
  return mat4(texelFetch(uBones, ivec2(i % 1024, i / 1024), 0), texelFetch(uBones, ivec2((i + 1) % 1024, (i + 1) / 1024), 0),
              texelFetch(uBones, ivec2((i + 2) % 1024, (i + 2) / 1024), 0), texelFetch(uBones, ivec2((i + 3) % 1024, (i + 3) / 1024), 0));
}
void main() {
  mat4 m = aWeights.x * bone(aBones.x) + aWeights.y * bone(aBones.y) + aWeights.z * bone(aBones.z) + aWeights.w * bone(aBones.w);
  if (aWeights.x + aWeights.y + aWeights.z + aWeights.w < 0.001) m = mat4(1.0);
  vNormal = mat3(aWorld) * mat3(m) * aNormal;
  vUV = (uTexMatrix * vec3(aUV, 1.0)).xy;
  vec4 world = aWorld * m * vec4(aPos, 1.0);
  if (uUseHeight > 0.5) world.z += groundAt(world.xy);
  gl_Position = uViewProj * world;
  vFogDepth = gl_Position.w;
}`;

const FS = `#version 300 es
precision mediump float;
in vec3 vNormal; in vec2 vUV;
uniform sampler2D uTex; uniform vec4 uColor; uniform float uAlphaTest; uniform float uUnshaded;
// HD materials: the ORM texture's alpha masks where team colour goes.
uniform sampler2D uOrm; uniform float uHd; uniform vec3 uTeam; uniform vec4 uMix;
// Scene light: direction toward it, diffuse and ambient colour (intensity included).
uniform vec3 uLightDir; uniform vec3 uDiffuse; uniform vec3 uAmbient;
out vec4 outColor;
${FOG_FS}
void main() {
  vec4 c = texture(uTex, vUV);
  if (uHd > 0.5) c.rgb = mix(c.rgb, c.rgb * uTeam, texture(uOrm, vUV).a);
  c *= uColor;
  if (c.a < uAlphaTest) discard;
  vec3 light = uUnshaded > 0.5 ? vec3(1.0) : uAmbient + uDiffuse * max(dot(normalize(vNormal), normalize(uLightDir)), 0.0);
  outColor = vec4(fogged(mix(c.rgb * light, uMix.rgb, uMix.a)), c.a);
}`;

const LINE_VS = `#version 300 es
in vec3 aPos; uniform mat4 uViewProj;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); }`;
const LINE_FS = `#version 300 es
precision mediump float; uniform vec4 uColor; out vec4 outColor;
void main() { outColor = uColor; }`;

export function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link error");
  return p;
}

// ------------------------------------------------------------------ GPU model

/** A vertex array and where its instance attributes point now, so they're only set again when that changes. */
interface InstancedVao {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer | null;
  first: number;
}

interface GpuGeoset {
  vao: InstancedVao;
  indexCount: number;
  wireVao: InstancedVao;
  wireCount: number;
  materialId: number;
  geosetId: number;
}

export interface Stats {
  vertices: number;
  triangles: number;
  geosets: number;
  nodes: number;
  textures: number;
}

/** The model's stored extent, or (when it's empty, as in many HD models)
 *  the bind-pose box of the full-detail geosets. */
export function bounds(model: Model): Pick<Extent, "min" | "max"> {
  const e = model.extent;
  if (e.max.some((v, i) => v > e.min[i])) return e;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const g of model.geosets) {
    if (g.lod > 0) continue;
    for (let i = 0; i < g.positions.length; i++) {
      const v = g.positions[i]!, k = i % 3;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  return min[0] <= max[0] ? { min, max } : { min: [-50, -50, 0], max: [50, 50, 100] };
}

/** Bytes per instance in an instance buffer: its world matrix, 16 floats, column-major. */
export const INSTANCE_BYTES = 64;

/** Instances of one model to draw together, one draw per layer: their world matrices one after the
 *  other in `buffer` (INSTANCE_BYTES each), in runs of one player colour. Only layers that show the
 *  player colour are drawn run by run. */
export interface InstanceRuns {
  buffer: WebGLBuffer | null;
  /** Consecutive instances of one player colour: the first one's index in the buffer, and how many. */
  runs: { team: number; first: number; count: number }[];
}

const UNIFORMS = ["uViewProj", "uBones", "uTex", "uOrm", "uHd", "uTeam", "uColor", "uAlphaTest", "uUnshaded", "uHeight", "uUseHeight", "uHeightRect", "uMix", "uFogColor", "uFogRange", "uFogStyle", "uLightDir", "uDiffuse", "uAmbient", "uTexMatrix"] as const;

/** Resources shared by every model drawn into one context. */
interface Shared {
  prog: WebGLProgram;
  u: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  /** First of the four attribute locations of the instance's world matrix (-1: none). */
  world: number;
  /** Room for one instance, for models drawn one at a time (draw). */
  one: WebGLBuffer | null;
  white: WebGLTexture;
  /** 1×1 team colour and generated team glow, per player colour. */
  team: WebGLTexture[];
  glow: WebGLTexture[];
}
const sharedByContext = new WeakMap<WebGL2RenderingContext, Shared>();

function shared(gl: WebGL2RenderingContext): Shared {
  let s = sharedByContext.get(gl);
  if (!s) {
    const solid = (rgba: number[]) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
      return t;
    };
    const glow = (rgb: Vec3) => {
      const n = 64, data = new Uint8Array(n * n * 4), t = gl.createTexture()!;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const d = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2), a = Math.max(0, 1 - d) ** 2;
        data.set([rgb[0], rgb[1], rgb[2], Math.round(a * 255)], (y * n + x) * 4);
      }
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      return t;
    };
    const prog = compile(gl, VS, FS);
    const one = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, one);
    gl.bufferData(gl.ARRAY_BUFFER, INSTANCE_BYTES, gl.DYNAMIC_DRAW);
    s = {
      prog,
      u: Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)])) as Shared["u"],
      world: gl.getAttribLocation(prog, "aWorld"),
      one,
      white: solid([255, 255, 255, 255]),
      team: TEAM_COLORS.map(([, c]) => solid([...c, 255])),
      glow: TEAM_COLORS.map(([, c]) => glow(c)),
    };
    sharedByContext.set(gl, s);
  }
  return s;
}

/** Uploads a decoded image with mipmaps. `flags` is the MDX texture's: bit 0
 *  wraps width, bit 1 wraps height. */
export type DrawPass = "opaque" | "blended" | "all";

export interface DrawOptions {
  /** Player colour index (TEAM_COLORS). */
  team?: number;
  fog?: Fog | null;
  wireframe?: boolean;
  /** Opaque layers, blended layers, or both (opaque first). */
  pass?: DrawPass;
  /** Raise vertices by a terrain height map (R32F texture, one texel per corner). */
  heightMap?: HeightMap;
  /** Multiplies colour and opacity (r, g, b, a in 0–1); every layer is then blended (ghost previews). */
  tint?: [number, number, number, number];
  /** Blends the shaded colour toward rgb by amount (r, g, b, amount in 0–1), e.g. red for "can't place". */
  mix?: [number, number, number, number];
  /** Draw over everything (no depth test), e.g. a preview that must stay visible. */
  onTop?: boolean;
  /** Scene light (default: DEFAULT_LIGHT). */
  light?: SceneLight;
}

export interface HeightMap {
  texture: WebGLTexture;
  /** World position of corner (0, 0). */
  x: number;
  y: number;
  /** Corners per row / column. */
  width: number;
  height: number;
}

/** The filter mode a layer is drawn with. A blend layer (2) with a texture that has no transparency, at full
 *  opacity, covers what is behind it like an opaque one does: drawn as one, it goes under the blended layers
 *  in front of it and hides what is behind it, instead of being painted over all of them in the file's order
 *  (ShimmeringPortal's disc). Any fade (alpha under 1) is the layer blending again. */
export function effectiveFilterMode(filterMode: number, alpha: number, opaqueTexture: boolean): number {
  return filterMode === 2 && alpha >= 0.999 && opaqueTexture ? 0 : filterMode;
}

type Layer = Model["materials"][number]["layers"][number];

/** A Set that counts its changes, so a user can tell it changed without comparing its contents. */
export class VersionedSet<T> extends Set<T> {
  version = 0;
  add(v: T) { if (!this.has(v)) this.version++; return super.add(v); }
  delete(v: T) { const had = super.delete(v); if (had) this.version++; return had; }
  clear() { if (this.size) this.version++; super.clear(); }
}

/** One model's GPU resources in a WebGL2 context: pose it for a moment of an
 *  animation, then draw it any number of times. */
export class ModelGpu {
  /** GPU texture per model texture; null until loaded. */
  readonly textures: (WebGLTexture | null)[];
  /** Hidden geosets (by index); HD lower-detail copies start hidden. */
  readonly hidden = new VersionedSet<number>();
  readonly stats: Stats;
  /** The look it stands in (the unit's Animprops): models with one are loaded once per look. */
  props: readonly string[] = [];
  private sh: Shared;
  private geosets: GpuGeoset[] = [];
  private boneTex: WebGLTexture;
  private boneData: Float32Array;
  private nodeOrder: number[];
  /** The layers to draw at the last pose, with what the pose gives them: opacity (layer times geoset),
   *  colour (r, g, b), texture coordinate transform and texture. Every instance shares them. */
  private draws: { g: GpuGeoset; layer: Layer; prio: number; blended: boolean; mode: number; alpha: number; texIndex: number; color: number[]; texMatrix: Float32Array }[] = [];
  /** The posed layers in the order their file modes give, and those of them that are blend layers. */
  private base: ModelGpu["draws"] = [];
  private blend2: ModelGpu["draws"] = [];
  private poseSeq = 0;
  private classCache: { pose: number; refs: (WebGLTexture | null)[]; list: ModelGpu["draws"] } | null = null;
  private geoAlpha = new Map<number, number>();
  private geoColor = new Map<number, number[]>();
  private clock: Clock = { frame: 0, seqStart: 0, seqEnd: 0, time: 0 };
  /** The sequence (start, end) of the last full pose, whether nothing moves in it (see poseStill), and
   *  the version of `hidden` it was made with. */
  private posed = { start: NaN, end: NaN, still: false, hidden: -1 };
  /** Full poses made (not counting those a still sequence skipped): for tests. */
  fullPoses = 0;
  /** Model-space matrix of every node (by object id) at the last pose; emitters follow them. */
  nodeWorld: Mat4[] = [];
  /** The moment of the last pose. */
  get poseClock(): Clock { return this.clock; }

  constructor(readonly gl: WebGL2RenderingContext, readonly model: Model) {
    this.sh = shared(gl);
    this.textures = model.textures.map(() => null);

    const maxId = Math.max(0, ...model.nodes.map((n, i) => (n ? i : 0)));
    const texels = (maxId + 1) * 4;
    this.boneData = new Float32Array(1024 * Math.ceil(texels / 1024) * 4);
    this.boneTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.boneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1024, Math.ceil(texels / 1024), 0, gl.RGBA, gl.FLOAT, this.boneData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    this.nodeOrder = nodeOrder(model);

    let vertices = 0, triangles = 0;
    model.geosets.forEach((g, gi) => {
      this.geosets.push(this.upload(g, gi));
      vertices += g.positions.length / 3;
      triangles += g.faces.length / 3;
      if (g.lod > 0) this.hidden.add(gi);
    });
    this.stats = { vertices, triangles, geosets: model.geosets.length, nodes: this.nodeOrder.length, textures: model.textures.length };
  }

  /** Paths to load for the model's textures; replaceable ids resolve through
   *  `replaceable` first (e.g. a destructable's own tree texture). */
  texturePaths(replaceable: Record<number, string> = {}): (string | null)[] {
    // In HD layers a replaceable texture names a set: X_Diffuse, X_Normal, X_ORM.
    const slot = new Map<number, string>();
    for (const mat of this.model.materials) for (const l of mat.layers) {
      if (l.textureIds.length >= 3) ["_Diffuse", "_Normal", "_ORM"].forEach((s, k) => slot.set(l.textureIds[k], s));
    }
    return this.model.textures.map((t, i) => {
      if (t.replaceableId === 0) return t.path;
      const p = replaceable[t.replaceableId] ?? REPLACEABLE[t.replaceableId];
      const s = slot.get(i);
      return p && s ? p.replace(/\.blp$/i, `${s}.blp`) : p ?? null;
    });
  }

  private upload(g: Model["geosets"][number], geosetId: number): GpuGeoset {
    const gl = this.gl, n = g.positions.length / 3;
    const bones = new Float32Array(n * 4), weights = new Float32Array(n * 4);
    for (let v = 0; v < n; v++) {
      if (g.skin) {
        for (let k = 0; k < 4; k++) {
          bones[v * 4 + k] = g.groups[g.skin[v * 8 + k]]?.[0] ?? 0;
          weights[v * 4 + k] = g.skin[v * 8 + 4 + k] / 255;
        }
      } else {
        const group = g.groups[g.vertexGroups[v]] ?? [];
        const used = group.slice(0, 4);
        used.forEach((id, k) => { bones[v * 4 + k] = id; weights[v * 4 + k] = 1 / used.length; });
      }
    }
    const prog = this.sh.prog;
    const buffers = new Map<string, WebGLBuffer>();
    const attr = (name: string, data: Float32Array, size: number) => {
      const loc = gl.getAttribLocation(prog, name);
      if (loc < 0) return;
      let b = buffers.get(name);
      if (!b) {
        b = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        buffers.set(name, b);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    const uvs = g.uvs.length ? g.uvs : new Float32Array(n * 2);
    const attributes = () => {
      attr("aPos", g.positions, 3);
      attr("aNormal", g.normals, 3);
      attr("aUV", uvs, 2);
      attr("aBones", bones, 4);
      attr("aWeights", weights, 4);
      // The world matrix, a column per location, steps once per instance; its buffer is set at the draw.
      const w = this.sh.world;
      if (w >= 0) for (let k = 0; k < 4; k++) { gl.enableVertexAttribArray(w + k); gl.vertexAttribDivisor(w + k, 1); }
    };
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    attributes();
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.faces, gl.STATIC_DRAW);

    // Wireframe: same vertex buffers, line indices.
    const lines = new Uint16Array(g.faces.length * 2);
    for (let i = 0; i < g.faces.length; i += 3) {
      const [a, b, c] = [g.faces[i], g.faces[i + 1], g.faces[i + 2]];
      lines.set([a, b, b, c, c, a], i * 2);
    }
    const wireVao = gl.createVertexArray()!;
    gl.bindVertexArray(wireVao);
    attributes();
    const lb = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lb);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lines, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao: { vao, buffer: null, first: -1 }, indexCount: g.faces.length, wireVao: { vao: wireVao, buffer: null, first: -1 }, wireCount: lines.length, materialId: g.materialId, geosetId };
  }

  /** Bone matrices and geoset animation state for a moment of an animation. */
  pose(clock: Clock) {
    const m = this.model;
    this.clock = clock;
    // A sequence in which nothing moves gives the same pose at every moment: posed once, it stays
    // (unless the geosets shown changed). The clock still moves on, for the particles that follow it.
    const p = this.posed, sameSpan = p.start === clock.seqStart && p.end === clock.seqEnd;
    if (!sameSpan) p.still = poseStill(m, clock.seqStart, clock.seqEnd);
    if (p.still && sameSpan && p.hidden === this.hidden.version) return;
    p.start = clock.seqStart; p.end = clock.seqEnd; p.hidden = this.hidden.version;
    this.fullPoses++;
    const world = poseNodes(m, clock);
    this.nodeWorld = world;
    for (const id of this.nodeOrder) this.boneData.set(world[id], id * 16);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.boneTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1024, this.boneData.length / 4096, gl.RGBA, gl.FLOAT, this.boneData);

    this.geoAlpha.clear();
    this.geoColor.clear();
    for (const ga of m.geosetAnims) {
      this.geoAlpha.set(ga.geosetId, sample(ga.alphaTrack, clock, m.globalSequences, [ga.alpha])[0]);
      this.geoColor.set(ga.geosetId, sample(ga.colorTrack, clock, m.globalSequences, ga.color));
    }

    // Opaque layers first, then blended ones (by priority plane).
    this.draws = [];
    for (const g of this.geosets) {
      if (this.hidden.has(g.geosetId) || (this.geoAlpha.get(g.geosetId) ?? 1) <= 0.01) continue;
      const mat = m.materials[g.materialId];
      if (!mat) continue;
      // Geoset animation colours are stored as BGR.
      const bgr = this.geoColor.get(g.geosetId) ?? [1, 1, 1];
      const color = [bgr[2], bgr[1], bgr[0]];
      for (const layer of mat.layers) {
        const alpha = sample(layer.alphaTrack, clock, m.globalSequences, [layer.alpha])[0] * (this.geoAlpha.get(g.geosetId) ?? 1);
        const texIndex = layer.textureTrack ? sample(layer.textureTrack, clock, m.globalSequences, [layer.textureIds[0]])[0] : layer.textureIds[0];
        const texMatrix = textureMatrix(m.textureAnims[layer.textureAnimId], clock, m.globalSequences);
        this.draws.push({ g, layer, prio: mat.priorityPlane, blended: layer.filterMode >= 2, mode: layer.filterMode, alpha, texIndex, color, texMatrix });
      }
    }
    this.blend2 = this.draws.filter((d) => d.layer.filterMode === 2);
    this.base = this.draws.slice().sort((a, b) => Number(a.blended) - Number(b.blended) || a.prio - b.prio);
    this.poseSeq++;
    this.classCache = null;
  }

  /** The posed layers with the filter mode each is drawn with, opaque ones first. A blend layer's class
   *  depends on its texture, which arrives after the first pose (and a still model is posed once), so
   *  it is checked at every draw, but only redone when a pose or one of those textures has changed. */
  private classified() {
    if (!this.blend2.length) return this.base;
    const c = this.classCache, refs = this.blend2.map((d) => this.textures[d.texIndex]);
    if (c && c.pose === this.poseSeq && refs.every((t, i) => t === c.refs[i])) return c.list;
    const m = this.model;
    // `base` has every blend layer as blended (its file mode): any drawn as opaque now needs its own order.
    let changed = false;
    for (const [i, d] of this.blend2.entries()) {
      const tex = m.textures[d.texIndex];
      const mode = effectiveFilterMode(2, d.alpha, !tex?.replaceableId && isOpaqueTexture(refs[i]));
      if (mode !== 2) changed = true;
      d.mode = mode;
      d.blended = mode >= 2;
    }
    const list = changed ? this.draws.slice().sort((a, b) => Number(a.blended) - Number(b.blended) || a.prio - b.prio) : this.base;
    this.classCache = { pose: this.poseSeq, refs, list };
    return list;
  }

  /** Draws the posed model with a world transform. */
  draw(viewProj: Mat4, world: Mat4, opts: DrawOptions = {}) {
    const gl = this.gl, sh = this.sh;
    gl.bindBuffer(gl.ARRAY_BUFFER, sh.one);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, world, 0, 16);
    this.drawInstances(viewProj, { buffer: sh.one, runs: [{ team: opts.team ?? 0, first: 0, count: 1 }] }, opts);
  }

  /** Draws the posed model once for each instance in `instances`: one draw call per layer, or per layer
   *  and run of one player colour for the layers that show it. `opts.team` is not used: each run has its own. */
  drawInstances(viewProj: Mat4, instances: InstanceRuns, opts: DrawOptions = {}) {
    const runs = instances.runs;
    let total = 0;
    for (const r of runs) total += r.count;
    if (!total || !instances.buffer) return;
    const gl = this.gl, m = this.model, sh = this.sh, u = sh.u;
    const pass = opts.pass ?? "all";
    gl.useProgram(sh.prog);
    gl.uniformMatrix4fv(u.uViewProj, false, viewProj);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.boneTex);
    gl.uniform1i(u.uBones, 1);
    gl.uniform1i(u.uOrm, 2);
    const hm = opts.heightMap;
    gl.uniform1f(u.uUseHeight, hm ? 1 : 0);
    if (hm) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, hm.texture);
      gl.uniform1i(u.uHeight, 3);
      gl.uniform4f(u.uHeightRect, hm.x, hm.y, hm.width, hm.height);
    }
    const mx = opts.mix ?? [0, 0, 0, 0];
    gl.uniform4f(u.uMix, mx[0], mx[1], mx[2], mx[3]);
    setFog(gl, (name) => (u as Record<string, WebGLUniformLocation | null>)[name], opts.fog);
    const light = opts.light ?? DEFAULT_LIGHT;
    gl.uniform3f(u.uLightDir, light.dir[0], light.dir[1], light.dir[2]);
    gl.uniform3f(u.uDiffuse, light.diffuse[0], light.diffuse[1], light.diffuse[2]);
    gl.uniform3f(u.uAmbient, light.ambient[0], light.ambient[1], light.ambient[2]);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.uTex, 0);
    // Runs that follow each other in the buffer are drawn in one call where the colour doesn't show.
    let contiguous = true;
    for (let i = 1; i < runs.length; i++) if (runs[i].first !== runs[i - 1].first + runs[i - 1].count) contiguous = false;
    const tint = opts.tint ?? [1, 1, 1, 1];
    const teamRgb = (team: number) => TEAM_COLORS[team]?.[1] ?? TEAM_COLORS[0][1];

    for (const { g, layer, blended, mode, alpha, color, texMatrix, texIndex } of this.classified()) {
      if ((pass === "opaque" && blended) || (pass === "blended" && !blended)) continue;
      if (alpha <= 0.01) continue;
      gl.uniform4f(u.uColor, color[0] * tint[0], color[1] * tint[1], color[2] * tint[2], alpha * tint[3]);
      gl.uniformMatrix3fv(u.uTexMatrix, false, texMatrix);
      const tex = m.textures[texIndex];
      // Team colour (1) and team glow (2) are textures of the player's colour.
      const teamTexture = tex?.replaceableId === 1 ? sh.team : tex?.replaceableId === 2 ? sh.glow : null;
      if (!teamTexture) gl.bindTexture(gl.TEXTURE_2D, this.textures[texIndex] ?? sh.white);
      // HD layers list [diffuse, normal, ORM, emissive, team colour, environment]; the ORM's alpha masks the player colour.
      const orm = layer.textureIds.length >= 3 ? this.textures[layer.textureIds[2]] : null;
      gl.uniform1f(u.uHd, orm ? 1 : 0);
      if (orm) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, orm);
        gl.activeTexture(gl.TEXTURE0);
      }

      const sf = layer.shadingFlags;
      gl.uniform1f(u.uUnshaded, sf & 0x1 ? 1 : 0);
      if (sf & 0x10) gl.disable(gl.CULL_FACE); else { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); }
      if (sf & 0x40) gl.disable(gl.DEPTH_TEST); else gl.enable(gl.DEPTH_TEST);
      gl.uniform1f(u.uAlphaTest, (mode === 1 ? 0.75 : 0.01) * (opts.tint?.[3] ?? 1));
      switch (mode) {
        case 0: case 1: gl.disable(gl.BLEND); gl.depthMask(true); break;
        case 2: gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); break;
        case 3: case 4: gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE); gl.depthMask(false); break;
        case 5: gl.enable(gl.BLEND); gl.blendFunc(gl.ZERO, gl.SRC_COLOR); gl.depthMask(false); break;
        default: gl.enable(gl.BLEND); gl.blendFunc(gl.DST_COLOR, gl.SRC_COLOR); gl.depthMask(false);
      }
      if (sf & 0x80) gl.depthMask(false);
      if (opts.onTop) gl.disable(gl.DEPTH_TEST);
      if (opts.tint && mode <= 1) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); }
      const v = opts.wireframe ? g.wireVao : g.vao;
      const prim = opts.wireframe ? gl.LINES : gl.TRIANGLES, count = opts.wireframe ? g.wireCount : g.indexCount;
      gl.bindVertexArray(v.vao);
      if (!teamTexture && !orm && contiguous) {
        this.pointInstances(v, instances.buffer, runs[0].first);
        gl.drawElementsInstanced(prim, count, gl.UNSIGNED_SHORT, 0, total);
        continue;
      }
      for (const r of runs) {
        if (!r.count) continue;
        if (teamTexture) gl.bindTexture(gl.TEXTURE_2D, teamTexture[r.team] ?? sh.white);
        if (orm) { const rgb = teamRgb(r.team); gl.uniform3f(u.uTeam, rgb[0] / 255, rgb[1] / 255, rgb[2] / 255); }
        this.pointInstances(v, instances.buffer, r.first);
        gl.drawElementsInstanced(prim, count, gl.UNSIGNED_SHORT, 0, r.count);
      }
    }
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  /** Points a vertex array's world matrix attribute at an instance buffer from instance `first` on (it stays set in the array). */
  private pointInstances(v: InstancedVao, buffer: WebGLBuffer, first: number) {
    const loc = this.sh.world;
    if (loc < 0 || (v.buffer === buffer && v.first === first)) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (let k = 0; k < 4; k++) gl.vertexAttribPointer(loc + k, 4, gl.FLOAT, false, INSTANCE_BYTES, first * INSTANCE_BYTES + k * 16);
    v.buffer = buffer;
    v.first = first;
  }
}

// ------------------------------------------------------------------ viewer

/** A single model on its own canvas, with an orbit camera and a ground grid. */
export class ModelRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly gpu: ModelGpu;
  private lineProg: WebGLProgram;
  private grid: { vao: WebGLVertexArrayObject; count: number };
  private team = 0;
  /** Particle emitters (none: null). */
  private particles: ParticleInstance | null;
  private particleRenderer: ParticleRenderer | null;
  /** Effects from another model (see setEffectModel), with its own textures. */
  private effectModel: Model | null = null;
  private effectTextures: (WebGLTexture | null)[] = [];
  private lastTime = -1;
  wireframe = false;
  /** Draw particle effects. */
  showParticles = true;
  showGrid = true;
  /** Camera orbit around `target`. */
  yaw = -Math.PI / 2;
  pitch = 0.35;
  distance: number;
  target: Vec3;

  constructor(readonly canvas: HTMLCanvasElement, readonly model: Model) {
    const gl = canvas.getContext("webgl2", { antialias: true, premultipliedAlpha: false });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.gpu = new ModelGpu(gl, model);
    this.lineProg = compile(gl, LINE_VS, LINE_FS);
    this.grid = this.makeGrid();
    this.particles = model.particleEmitters2.length || model.ribbons.length ? new ParticleInstance(model) : null;
    this.particleRenderer = this.particles ? new ParticleRenderer(gl) : null;
    const e = bounds(model);
    this.target = [(e.min[0] + e.max[0]) / 2, (e.min[1] + e.max[1]) / 2, (e.min[2] + e.max[2]) / 2];
    this.distance = Math.max(80, Math.hypot(e.max[0] - e.min[0], e.max[1] - e.min[1], e.max[2] - e.min[2]) * 1.4);
  }

  get hidden() { return this.gpu.hidden; }
  get stats() { return this.gpu.stats; }

  setTeamColor(index: number) {
    this.team = index;
  }

  /** Paths to load for the model's textures (replaceables resolved). */
  texturePaths(): (string | null)[] {
    return this.gpu.texturePaths();
  }

  setTexture(i: number, img: DecodedImage) {
    const { flags } = this.model.textures[i];
    this.gpu.textures[i] = createTexture(this.gl, img, { repeat: [(flags & 1) !== 0, (flags & 2) !== 0] });
  }

  private makeGrid() {
    const gl = this.gl, lines: number[] = [], size = 512, step = 64;
    for (let i = -size; i <= size; i += step) lines.push(i, -size, 0, i, size, 0, -size, i, 0, size, i, 0);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.lineProg, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { vao, count: lines.length / 3 };
  }

  render(clock: Clock) {
    const gl = this.gl;
    const w = this.canvas.clientWidth * devicePixelRatio, h = this.canvas.clientHeight * devicePixelRatio;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    // Multi-layer materials draw several layers at the same depth.
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0.11, 0.12, 0.14, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const eye: Vec3 = [
      this.target[0] + this.distance * Math.cos(this.pitch) * Math.cos(this.yaw),
      this.target[1] + this.distance * Math.cos(this.pitch) * Math.sin(this.yaw),
      this.target[2] + this.distance * Math.sin(this.pitch),
    ];
    const viewProj = mat4.mul(mat4.perspective(Math.PI / 4, w / Math.max(1, h), this.distance / 100, this.distance * 20), mat4.lookAt(eye, this.target, [0, 0, 1]));

    if (this.showGrid) {
      gl.useProgram(this.lineProg);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, "uViewProj"), false, viewProj);
      gl.uniform4f(gl.getUniformLocation(this.lineProg, "uColor"), 0.3, 0.32, 0.36, 1);
      gl.bindVertexArray(this.grid.vao);
      gl.drawArrays(gl.LINES, 0, this.grid.count);
    }

    this.gpu.pose(clock);
    const world = mat4.identity();
    this.gpu.draw(viewProj, world, { team: this.team, wireframe: this.wireframe });
    if (this.particles && this.particleRenderer) {
      // Seconds since the last frame (a pause or a hidden tab doesn't burst particles).
      const dt = this.lastTime < 0 ? 0 : Math.min(0.1, Math.max(0, (clock.time - this.lastTime) / 1000));
      this.lastTime = clock.time;
      const fx = this.effectModel;
      if (fx) {
        // The effect model's own animation of the same name, at the same point in it.
        const name = this.model.sequences.find((s) => s.start === clock.seqStart && s.end === clock.seqEnd)?.name;
        const s = fx.sequences.find((x) => x.name === name) ?? fx.sequences[0];
        const at = s ? Math.min(s.end, s.start + (clock.frame - clock.seqStart)) : 0;
        const fxClock: Clock = { frame: at, seqStart: s?.start ?? 0, seqEnd: s?.end ?? 0, time: clock.time };
        this.particles.step(dt, fxClock, poseNodes(fx, fxClock), world);
      } else {
        this.particles.step(dt, clock, this.gpu.nodeWorld, world);
      }
      if (this.showParticles && !this.wireframe) {
        this.particleRenderer.draw(viewProj, eye, [{ particles: this.particles, textures: fx ? this.effectTextures : this.gpu.textures, world }]);
      }
    }
  }

  /** Draws another model's particle emitters and ribbons instead of this one's: for a Reforged
   *  model whose effects are PopcornFX (not drawn), its classic copy's. Its textures come by
   *  setEffectTexture. */
  setEffectModel(m: Model) {
    this.effectModel = m;
    this.effectTextures = m.textures.map(() => null);
    this.particles = new ParticleInstance(m);
    this.particleRenderer ??= new ParticleRenderer(this.gl);
  }

  setEffectTexture(i: number, img: DecodedImage) {
    if (!this.effectModel) return;
    const { flags } = this.effectModel.textures[i];
    this.effectTextures[i] = createTexture(this.gl, img, { repeat: [(flags & 1) !== 0, (flags & 2) !== 0] });
  }

  /** Particles alive now (0 without emitters). */
  get particleCount() { return this.particles?.count ?? 0; }
  get hasParticles() { return this.particles !== null; }

  dispose() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
