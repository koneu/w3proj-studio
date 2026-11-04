// Particle emitters (PRE2) at run time: each placed model instance gets a ParticleInstance
// that spawns, moves and ages its particles; ParticleRenderer draws the particles of many
// instances as camera-facing quads, batched by texture and blend mode.
//
// Rules (Warcraft III's ParticleEmitter2): particles start in a width × length rectangle
// around the emitter's pivot and fly along the emitter's +Z axis, spread randomly within
// `latitude` degrees, at `speed` ± `variation`; gravity pulls them down; colour, opacity and
// size go from the start to the middle segment (at `time` of the life) and on to the end;
// the sprite cell walks through the head interval in the first part of the life and the
// decay interval in the second. "Tail" particles are streaks along their motion.

import { compile, sample, type Clock, type Mat4, type Vec3 } from "./renderer";
import { PRE2_FLAGS, type Model, type ParticleEmitter2, type RibbonEmitter } from "./mdx";

interface Particle {
  /** World position (or model space for ModelSpace emitters). */
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number;
}

interface EmitterState {
  e: ParticleEmitter2;
  particles: Particle[];
  /** Fractional particles carried to the next step. */
  carry: number;
  /** Frame at the last step, for squirt bursts. */
  lastFrame: number;
}

/** One cut across a ribbon: its top and bottom point (world), falling at `vz`. */
interface RibbonSegment { a: Vec3; b: Vec3; vz: number; age: number }

interface RibbonState {
  r: RibbonEmitter;
  /** Oldest first. */
  segments: RibbonSegment[];
  /** Where the ribbon starts now (the emitter), while it emits. */
  head: { a: Vec3; b: Vec3 } | null;
  carry: number;
  /** Colour (r, g, b, a) and texture cell at the last step. */
  color: [number, number, number, number];
  cell: number;
}

/** Most particles one emitter of one instance keeps (a runaway emission rate stays bounded). */
const MAX_PER_EMITTER = 1000;

const transformPoint = (m: Mat4, x: number, y: number, z: number): Vec3 => [
  m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14],
];
const transformDir = (m: Mat4, x: number, y: number, z: number): Vec3 => [
  m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z,
];
const mul = (a: Mat4, b: Mat4): Mat4 => {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
};

/** The particles of one placed model. Step it with the model's pose, then hand it to a ParticleRenderer. */
export class ParticleInstance {
  readonly emitters: EmitterState[];
  readonly ribbons: RibbonState[];

  constructor(readonly model: Model, private random: () => number = Math.random) {
    this.emitters = model.particleEmitters2.map((e) => ({ e, particles: [], carry: 0, lastFrame: -1 }));
    this.ribbons = model.ribbons.map((r) => ({ r, segments: [], head: null, carry: 0, color: [1, 1, 1, 1], cell: 0 }));
  }

  /** Particles and ribbon segments alive now. */
  get count() { return this.emitters.reduce((n, s) => n + s.particles.length, 0) + this.ribbons.reduce((n, s) => n + s.segments.length, 0); }

  /** Advances `dt` seconds. `nodeWorld`: the model's node matrices at `clock` (ModelGpu.nodeWorld);
   *  `world`: where the instance stands. */
  step(dt: number, clock: Clock, nodeWorld: Mat4[], world: Mat4) {
    this.stepRibbons(dt, clock, nodeWorld, world);
    const m = this.model, gs = m.globalSequences, rnd = this.random;
    for (const s of this.emitters) {
      const e = s.e;
      const node = nodeWorld[e.node.objectId];
      const modelSpace = (e.node.flags & PRE2_FLAGS.modelSpace) !== 0;
      const gravity = sample(e.gravityTrack, clock, gs, [e.gravity])[0];
      // Age and move what's there.
      let keep = 0;
      for (const p of s.particles) {
        p.age += dt;
        if (p.age >= e.lifespan) continue;
        p.vz -= gravity * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        s.particles[keep++] = p;
      }
      s.particles.length = keep;

      // Spawn.
      const visible = sample(e.visibilityTrack, clock, gs, [1])[0] > 0;
      const rate = sample(e.emissionRateTrack, clock, gs, [e.emissionRate])[0];
      let spawn = 0;
      if (e.squirt) {
        // A burst of `rate` particles when the animation passes an emission rate key.
        const t = e.emissionRateTrack;
        if (t && s.lastFrame >= 0 && clock.frame !== s.lastFrame) {
          for (let i = 0; i < t.times.length; i++) {
            const k = t.times[i];
            if (k > s.lastFrame && k <= clock.frame && k >= clock.seqStart && k <= clock.seqEnd) spawn += t.values[i];
          }
        }
      } else if (visible) {
        s.carry += rate * dt;
        spawn = Math.floor(s.carry);
        s.carry -= spawn;
      }
      s.lastFrame = clock.frame;
      if (!visible || spawn <= 0 || !node) continue;

      const speed = sample(e.speedTrack, clock, gs, [e.speed])[0];
      const variation = sample(e.variationTrack, clock, gs, [e.variation])[0];
      const latitude = (sample(e.latitudeTrack, clock, gs, [e.latitude])[0] * Math.PI) / 180;
      const width = sample(e.widthTrack, clock, gs, [e.width])[0];
      const length = sample(e.lengthTrack, clock, gs, [e.length])[0];
      const toWorld = modelSpace ? node : mul(world, node);
      const pivot: Vec3 = [m.pivots[e.node.objectId * 3] ?? 0, m.pivots[e.node.objectId * 3 + 1] ?? 0, m.pivots[e.node.objectId * 3 + 2] ?? 0];
      const line = (e.node.flags & PRE2_FLAGS.lineEmitter) !== 0;
      for (let i = 0; i < spawn && s.particles.length < MAX_PER_EMITTER; i++) {
        const lx = pivot[0] + (rnd() - 0.5) * width, ly = pivot[1] + (rnd() - 0.5) * length, lz = pivot[2];
        // Within the cone around +Z (line emitters: in the XZ plane).
        const polar = rnd() * latitude, azimuth = line ? (rnd() < 0.5 ? 0 : Math.PI) : rnd() * Math.PI * 2;
        const sp = speed * (1 + (rnd() * 2 - 1) * variation);
        const [x, y, z] = transformPoint(toWorld, lx, ly, lz);
        const d = transformDir(toWorld, Math.sin(polar) * Math.cos(azimuth), Math.sin(polar) * Math.sin(azimuth), Math.cos(polar));
        const dl = Math.hypot(d[0], d[1], d[2]) || 1;
        s.particles.push({ x, y, z, vx: (d[0] / dl) * sp, vy: (d[1] / dl) * sp, vz: (d[2] / dl) * sp, age: 0 });
      }
    }
  }

  /** Ribbons: segments age and fall; a visible emitter adds `emissionRate` segments a second
   *  at its node (`heightAbove` up and `heightBelow` down its Y axis). */
  stepRibbons(dt: number, clock: Clock, nodeWorld: Mat4[], world: Mat4) {
    const m = this.model, gs = m.globalSequences;
    for (const s of this.ribbons) {
      const r = s.r;
      let keep = 0;
      for (const seg of s.segments) {
        seg.age += dt;
        if (seg.age >= r.lifespan) continue;
        seg.vz -= r.gravity * dt;
        seg.a[2] += seg.vz * dt; seg.b[2] += seg.vz * dt;
        s.segments[keep++] = seg;
      }
      s.segments.length = keep;
      const color = sample(r.colorTrack, clock, gs, r.color);
      s.color = [color[0], color[1], color[2], sample(r.alphaTrack, clock, gs, [r.alpha])[0]];
      s.cell = Math.round(sample(r.textureSlotTrack, clock, gs, [r.textureSlot])[0]);
      const node = nodeWorld[r.node.objectId];
      if (!node || sample(r.visibilityTrack, clock, gs, [1])[0] <= 0) { s.head = null; s.carry = 0; continue; }
      const above = sample(r.heightAboveTrack, clock, gs, [r.heightAbove])[0];
      const below = sample(r.heightBelowTrack, clock, gs, [r.heightBelow])[0];
      const id = r.node.objectId, toWorld = mul(world, node);
      const px = m.pivots[id * 3] ?? 0, py = m.pivots[id * 3 + 1] ?? 0, pz = m.pivots[id * 3 + 2] ?? 0;
      s.head = { a: transformPoint(toWorld, px, py + above, pz), b: transformPoint(toWorld, px, py - below, pz) };
      s.carry += r.emissionRate * dt;
      if (s.carry >= 1 && s.segments.length < MAX_PER_EMITTER) {
        // Segments spawned in one step would lie on top of each other: one is enough.
        s.carry -= Math.floor(s.carry);
        s.segments.push({ a: [...s.head.a], b: [...s.head.b], vz: 0, age: 0 });
      }
    }
  }
}

const VS = `#version 300 es
in vec3 aPos; in vec2 aUv; in vec4 aColor;
uniform mat4 uViewProj;
out vec2 vUv; out vec4 vColor;
void main() { vUv = aUv; vColor = aColor; gl_Position = uViewProj * vec4(aPos, 1.0); }`;
const FS = `#version 300 es
precision mediump float;
in vec2 vUv; in vec4 vColor;
uniform sampler2D uTex; uniform float uAlphaTest;
// Modulate modes multiply the scene by the colour, which ignores alpha: fade toward the
// colour that changes nothing (white for modulate, grey for modulate 2x) where it's clear.
uniform float uNeutral;
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUv) * vColor;
  if (c.a < uAlphaTest) discard;
  outColor = uNeutral > 0.0 ? vec4(mix(vec3(uNeutral), c.rgb, c.a), 1.0) : c;
}`;

/** Floats per vertex: position 3, uv 2, colour 4. */
const STRIDE = 9;

/** Draws the particles of many instances. One per WebGL context. */
export class ParticleRenderer {
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private data = new Float32Array(STRIDE * 6 * 1024);
  private white: WebGLTexture;

  constructor(readonly gl: WebGL2RenderingContext) {
    this.prog = compile(gl, VS, FS);
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const attr = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(this.prog, name);
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
    };
    attr("aPos", 3, 0); attr("aUv", 2, 3); attr("aColor", 4, 5);
    gl.bindVertexArray(null);
    this.white = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  }

  /** Draws after the scene's opaque geometry (depth test on, depth writes off).
   *  `eye`: the camera position (quads face it); `textures`: the GPU textures of the emitters'
   *  model (by texture id; null: not loaded yet, drawn white). */
  draw(viewProj: Mat4, eye: Vec3, items: { particles: ParticleInstance; textures: (WebGLTexture | null)[]; world: Mat4 }[]) {
    const gl = this.gl;
    // Quads grouped by texture and blend mode.
    const groups = new Map<string, { tex: WebGLTexture; filter: number; prio: number; quads: number[] }>();
    for (const it of items) {
      for (const s of it.particles.emitters) {
        if (!s.particles.length) continue;
        const e = s.e;
        const tex = it.textures[e.textureId] ?? this.white;
        const key = `${e.filterMode}|${e.priorityPlane}|${e.textureId}|${it.particles.model.name}`;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { tex, filter: e.filterMode, prio: e.priorityPlane, quads: [] }));
        this.quads(g.quads, s, eye, (e.node.flags & PRE2_FLAGS.modelSpace) !== 0 ? it.world : null);
      }
      for (const s of it.particles.ribbons) {
        if (!s.segments.length) continue;
        // A ribbon draws with its material's first layer; layer blend modes map onto the
        // particles' (none/alpha key/blend/additive/add alpha/modulate/modulate 2x).
        const mat = it.particles.model.materials[s.r.materialId];
        const layer = mat?.layers[0];
        const texId = layer?.textureIds[0] ?? -1;
        const filter = [0, 4, 0, 1, 1, 2, 3][layer?.filterMode ?? 2] ?? 0;
        const prio = mat?.priorityPlane ?? 0;
        const key = `ribbon|${filter}|${prio}|${texId}|${it.particles.model.name}`;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { tex: it.textures[texId] ?? this.white, filter, prio, quads: [] }));
        ribbonQuads(g.quads, s);
      }
    }
    if (!groups.size) return;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, "uViewProj"), false, viewProj);
    gl.uniform1i(gl.getUniformLocation(this.prog, "uTex"), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    for (const g of [...groups.values()].sort((a, b) => a.prio - b.prio)) {
      const floats = g.quads.length;
      if (this.data.length < floats) this.data = new Float32Array(floats * 2);
      this.data.set(g.quads);
      gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, floats), gl.STREAM_DRAW);
      gl.bindTexture(gl.TEXTURE_2D, g.tex);
      gl.uniform1f(gl.getUniformLocation(this.prog, "uAlphaTest"), g.filter === 4 ? 0.75 : 0.003);
      gl.uniform1f(gl.getUniformLocation(this.prog, "uNeutral"), g.filter === 2 ? 1 : g.filter === 3 ? 0.5 : 0);
      switch (g.filter) {
        case 1: gl.blendFunc(gl.SRC_ALPHA, gl.ONE); break;
        case 2: gl.blendFunc(gl.ZERO, gl.SRC_COLOR); break;
        case 3: gl.blendFunc(gl.DST_COLOR, gl.SRC_COLOR); break;
        default: gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }
      gl.drawArrays(gl.TRIANGLES, 0, floats / STRIDE);
    }
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** Two triangles per particle (head) and per tail. `modelWorld`: for model-space emitters. */
  private quads(out: number[], s: EmitterState, eye: Vec3, modelWorld: Mat4 | null) {
    const e = s.e;
    const cols = Math.max(1, e.columns), rows = Math.max(1, e.rows);
    const mid = Math.min(Math.max(e.time, 0.0001), 0.9999);
    const head = e.headOrTail === 0 || e.headOrTail === 2, tail = e.headOrTail === 1 || e.headOrTail === 2;
    const xy = (e.node.flags & PRE2_FLAGS.xyQuad) !== 0;
    let list = s.particles;
    // Blended (not additive) sprites look right only when drawn back to front.
    if (e.filterMode === 0 || e.node.flags & PRE2_FLAGS.sortPrimsFarZ) {
      list = [...list].sort((a, b) => (b.x - eye[0]) ** 2 + (b.y - eye[1]) ** 2 + (b.z - eye[2]) ** 2 - ((a.x - eye[0]) ** 2 + (a.y - eye[1]) ** 2 + (a.z - eye[2]) ** 2));
    }
    for (const p of list) {
      const t = p.age / e.lifespan;
      const first = t < mid, f = first ? t / mid : (t - mid) / (1 - mid);
      const a = first ? 0 : 1, b = a + 1;
      const lerp = (x: number, y: number) => x + (y - x) * f;
      const scale = lerp(e.segmentScaling[a], e.segmentScaling[b]);
      const c = [lerp(e.segmentColor[a][0], e.segmentColor[b][0]), lerp(e.segmentColor[a][1], e.segmentColor[b][1]), lerp(e.segmentColor[a][2], e.segmentColor[b][2]), lerp(e.segmentAlpha[a], e.segmentAlpha[b]) / 255];
      const pos: Vec3 = modelWorld ? transformPoint(modelWorld, p.x, p.y, p.z) : [p.x, p.y, p.z];
      const vel: Vec3 = modelWorld ? transformDir(modelWorld, p.vx, p.vy, p.vz) : [p.vx, p.vy, p.vz];
      // Camera-facing axes at the particle (or flat on the ground for XYQuad emitters).
      const toEye: Vec3 = [eye[0] - pos[0], eye[1] - pos[1], eye[2] - pos[2]];
      let right: Vec3, up: Vec3;
      if (xy) {
        // Flat on the ground, the texture's up along the particle's motion (waves face the way
        // they roll); straight up or still: the world's axes.
        const len = Math.hypot(vel[0], vel[1]);
        up = len > 1e-6 ? [vel[0] / len, vel[1] / len, 0] : [0, 1, 0];
        right = [up[1], -up[0], 0];
      } else {
        right = norm(cross([0, 0, 1], toEye));
        up = norm(cross(toEye, right));
      }
      if (head) {
        const cell = spriteCell(first ? e.headIntervals : e.headDecayIntervals, f);
        quad(out, pos, right, up, scale, scale, cell, cols, rows, c);
      }
      if (tail) {
        // A streak from the particle back along its velocity.
        const back: Vec3 = [-vel[0] * e.tailLength, -vel[1] * e.tailLength, -vel[2] * e.tailLength];
        const len = Math.hypot(...back) / 2;
        if (len > 0) {
          const centre: Vec3 = [pos[0] + back[0] / 2, pos[1] + back[1] / 2, pos[2] + back[2] / 2];
          const along = norm(back);
          const side = norm(cross(along, toEye));
          const cell = spriteCell(first ? e.tailIntervals : e.tailDecayIntervals, f);
          quad(out, centre, side, along, scale, len, cell, cols, rows, c);
        }
      }
    }
  }
}

/** A ribbon as quads from its head (the emitter) back through its segments, newest first;
 *  the texture runs along it by age (u) and across from top to bottom (v), in its cell. */
function ribbonQuads(out: number[], s: RibbonState) {
  const r = s.r;
  const cols = Math.max(1, r.columns), rows = Math.max(1, r.rows);
  const cu = (s.cell % cols) / cols, cv = Math.floor(s.cell / cols) / rows;
  const points = [...s.segments].reverse().map((seg) => ({ a: seg.a, b: seg.b, u: seg.age / r.lifespan }));
  if (s.head) points.unshift({ a: s.head.a, b: s.head.b, u: 0 });
  const c = s.color;
  const v = (p: Vec3, u: number, across: number) => out.push(p[0], p[1], p[2], cu + (u / cols), cv + across / rows, c[0], c[1], c[2], c[3]);
  for (let i = 0; i + 1 < points.length; i++) {
    const p = points[i], q = points[i + 1];
    v(p.a, p.u, 0); v(p.b, p.u, 1); v(q.b, q.u, 1);
    v(p.a, p.u, 0); v(q.b, q.u, 1); v(q.a, q.u, 0);
  }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** The sprite cell at `f` (0–1) of a part of the life: [start, end, repeat] cycles `repeat` times. */
export function spriteCell(interval: [number, number, number], f: number): number {
  const [start, end, repeat] = interval;
  const n = end - start + 1;
  if (n <= 1) return start;
  const k = Math.max(1, repeat);
  return start + Math.min(n - 1, Math.floor(((f * k) % 1) * n));
}

/** One quad (two triangles) of half-size (w, h) along `right` and `up`, with sprite cell `cell`. */
function quad(out: number[], c: Vec3, right: Vec3, up: Vec3, w: number, h: number, cell: number, cols: number, rows: number, color: number[]) {
  const u0 = (cell % cols) / cols, v0 = Math.floor(cell / cols) / rows, u1 = u0 + 1 / cols, v1 = v0 + 1 / rows;
  const corner = (sx: number, sy: number, u: number, v: number) => out.push(
    c[0] + right[0] * w * sx + up[0] * h * sy, c[1] + right[1] * w * sx + up[1] * h * sy, c[2] + right[2] * w * sx + up[2] * h * sy,
    u, v, color[0], color[1], color[2], color[3]);
  corner(-1, -1, u0, v1); corner(1, -1, u1, v1); corner(1, 1, u1, v0);
  corner(-1, -1, u0, v1); corner(1, 1, u1, v0); corner(-1, 1, u0, v0);
}
