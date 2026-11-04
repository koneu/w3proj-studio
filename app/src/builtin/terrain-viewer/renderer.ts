// WebGL2 terrain: textured ground (Warcraft's corner-mask tile atlas), water,
// placed doodads/units as models, and point markers for objects without one.
// Cliff tiles get cliff models (see cliffs.ts); ramps stay sloped ground.

import { compile, mat4, type Clock, type DecodedTexture, type HeightMap, type Mat4, type ModelGpu, type Vec3 } from "../../lib/model/renderer";
import type { Model } from "../../lib/model/mdx";
import type { SceneLight } from "../../lib/model/dnclight";

/** Ground light without the map's lighting: soft ambient plus a light from the south-west. */
const GROUND_DEFAULT: SceneLight = { dir: [-0.3, -0.4, 0.85], diffuse: [0.65, 0.65, 0.65], ambient: [0.45, 0.45, 0.45] };
import { ParticleInstance, ParticleRenderer } from "../../lib/model/particles";
import type { Placed } from "./objects";
import { heightAt, rampLift, type Terrain } from "../../lib/terrain/w3e";

const norm = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Ground tile textures are 4×4 cells of corner-transition shapes (a cell's
// index is a bitmask of the tile corners the texture covers); "extended"
// textures are twice as wide and add 16 full-tile variations. Negative cells
// stand for a variation and are resolved once the texture's size is known.
const GROUND_VS = `#version 300 es
in vec3 aPos; in vec3 aNormal; in vec2 aLocal; in float aCell; in float aShade;
uniform mat4 uViewProj; uniform float uExtended;
out vec2 vUV; out vec3 vNormal; out float vShade;
void main() {
  int cell = int(aCell);
  bool ext = uExtended > 0.5;
  if (cell < 0) {
    int v = -cell - 1;
    cell = ext ? (v < 16 ? 16 + v : (v == 16 ? 15 : 0)) : (v == 0 ? 0 : 15);
  }
  int c = cell % 16;
  vec2 cr = vec2(float(c % 4) + (cell >= 16 ? 4.0 : 0.0), float(c / 4));
  // Stay clear of the neighbouring cells when filtering.
  vec2 local = mix(vec2(0.02), vec2(0.98), aLocal);
  vUV = (cr + local) / vec2(ext ? 8.0 : 4.0, 4.0);
  vNormal = aNormal; vShade = aShade;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;
const GROUND_FS = `#version 300 es
precision mediump float;
in vec2 vUV; in vec3 vNormal; in float vShade;
uniform sampler2D uTex;
uniform vec3 uLightDir; uniform vec3 uDiffuse; uniform vec3 uAmbient;
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUV);
  vec3 light = uAmbient + uDiffuse * max(dot(normalize(vNormal), normalize(uLightDir)), 0.0);
  outColor = vec4(c.rgb * light * vShade, c.a);
}`;

const COLOR_VS = `#version 300 es
in vec3 aPos; in vec4 aColor;
uniform mat4 uViewProj; uniform float uPointSize;
out vec4 vColor;
void main() { vColor = aColor; gl_Position = uViewProj * vec4(aPos, 1.0); gl_PointSize = uPointSize / gl_Position.w; }`;
const COLOR_FS = `#version 300 es
precision mediump float; in vec4 vColor; out vec4 outColor;
void main() { outColor = vColor; }`;

// Water: the tileset's animated texture (one copy per tile) under a colour that goes from
// "shallow min" to "shallow max" as the water deepens to 64/128 of a cliff layer (from 10/128),
// then from "deep min" to "deep max" until 72/128 (TerrainArt\Water.slk).
const WATER_VS = `#version 300 es
in vec3 aPos; in vec2 aUv; in float aDepth;
uniform mat4 uViewProj;
out vec2 vUv; out float vDepth;
void main() { vUv = aUv; vDepth = aDepth; gl_Position = uViewProj * vec4(aPos, 1.0); }`;
const WATER_FS = `#version 300 es
precision mediump float;
in vec2 vUv; in float vDepth;
uniform sampler2D uTex; uniform vec4 uShallowMin; uniform vec4 uShallowMax; uniform vec4 uDeepMin; uniform vec4 uDeepMax;
out vec4 outColor;
void main() {
  const float minDepth = 10.0 / 128.0, deepLevel = 64.0 / 128.0, maxDepth = 72.0 / 128.0;
  vec4 c = vDepth <= deepLevel
    ? mix(uShallowMin, uShallowMax, clamp((vDepth - minDepth) / (deepLevel - minDepth), 0.0, 1.0))
    : mix(uDeepMin, uDeepMax, clamp((vDepth - deepLevel) / (maxDepth - deepLevel), 0.0, 1.0));
  outColor = texture(uTex, vUv) * c;
}`;

/** A tileset's water: animation frames (by index; null until loaded), frames per second and
 *  the colour ramp (r, g, b, a in 0–1). */
export interface WaterLook {
  frames: (WebGLTexture | null)[];
  rate: number;
  shallowMin: number[]; shallowMax: number[]; deepMin: number[]; deepMax: number[];
}

/** Until the game's water is known: an untextured blue-grey ramp. */
const WATER_DEFAULT: WaterLook = {
  frames: [], rate: 1,
  shallowMin: [0.12, 0.32, 0.5, 0.25], shallowMax: [0.12, 0.32, 0.5, 0.6], deepMin: [0.12, 0.32, 0.5, 0.6], deepMax: [0.1, 0.27, 0.45, 0.85],
};

// Ground overlay: a texture spread over the map (one texel per 32×32 pathing
// cell), e.g. the pathing editor's view.
const OVERLAY_VS = `#version 300 es
in vec3 aPos;
uniform mat4 uViewProj; uniform vec4 uRect;
out vec2 vUV;
void main() { vUV = (aPos.xy - uRect.xy) / uRect.zw; gl_Position = uViewProj * vec4(aPos, 1.0); }`;
const OVERLAY_FS = `#version 300 es
precision mediump float; in vec2 vUV; uniform sampler2D uTex; out vec4 outColor;
void main() { outColor = texture(uTex, vUV); if (outColor.a < 0.01) discard; }`;

/** A ground-following circle (selection, brush outline). */
export interface Ring {
  x: number;
  y: number;
  r: number;
  rgb: Vec3;
  /** A square outline (half side `r`) instead of a circle. */
  square?: boolean;
}

export interface Marker {
  x: number;
  y: number;
  z: number;
  rgb: Vec3;
}

/** What a placed object is, for picking. */
export interface PickInfo {
  /** Object data kind: w3d, w3b, w3u or w3t. */
  kind: string;
  id: string;
  /** Base object of a custom id. */
  base?: string;
  /** Position in the placement file's list. */
  index: number;
  placed: Placed;
  model: string;
  /** Model scale on top of the placement's own (units' skin scale). */
  extraScale: number;
}

export interface ObjectInstance {
  world: Mat4;
  team: number;
  pick?: PickInfo;
  /** World-space bounding sphere [x, y, z, r]. */
  sphere?: [number, number, number, number];
}

/** One model placed any number of times; `group` is a toggle name (e.g. "doodads"). */
/** Particle emitters drawn for a batch's instances: the model's own, or (`classic`) those of the
 *  game's classic model for a Reforged one whose effects are PopcornFX. */
export interface EffectSource {
  model: Model;
  textures: (WebGLTexture | null)[];
  nodeWorld: Mat4[];
  clock: Clock;
  classic: boolean;
}

export interface ObjectBatch {
  group: string;
  gpu: ModelGpu;
  instances: ObjectInstance[];
  effects?: EffectSource;
  /** Bend the model onto the ground height map (cliffs). */
  followGround?: boolean;
}

interface Mesh {
  vao: WebGLVertexArrayObject;
  count: number;
}

/** Texture slot of the tileset's blight (beyond any ground tile index). */
export const BLIGHT_TEXTURE = 100;

export class TerrainRenderer {
  readonly gl: WebGL2RenderingContext;
  private groundProg: WebGLProgram;
  private colorProg: WebGLProgram;
  private ground: WebGLVertexArrayObject;
  /** Index range per ground texture, in draw order. */
  private ranges: { texture: number; offset: number; count: number }[] = [];
  private textures: ({ tex: WebGLTexture; extended: boolean } | null)[];
  private placeholder: WebGLTexture;
  private water: Mesh;
  private waterProg: WebGLProgram;
  /** The tileset's water (see setWaterLook); the default ramp until then. */
  private waterLook: WaterLook = WATER_DEFAULT;
  /** Water frame shown by the last render (the view redraws when it changes). */
  private waterFrameShown = -1;
  /** White texture for untextured water. */
  private waterWhite: WebGLTexture;
  private overlayProg: WebGLProgram | null = null;
  private overlay: { vao: WebGLVertexArrayObject; count: number; tex: WebGLTexture } | null = null;
  private wire: Mesh;
  private markers = new Map<string, Mesh>();
  private selection: Mesh[] = [];
  showWater = true;
  /** The map's day/night lighting at the chosen hour: terrain (ground, cliffs, doodads) and
   *  units; null: a neutral default light. */
  terrainLight: SceneLight | null = null;
  unitLight: SceneLight | null = null;
  /** Particle effects (fires, glows, …) of placed objects. */
  showEffects = true;
  private particleRenderer: ParticleRenderer | null = null;
  /** Particles per placed object (new instances after a rebuild start fresh). */
  private particleStates = new WeakMap<ObjectInstance, ParticleInstance>();
  private lastParticleTime = -1;
  wireframe = false;
  /** Object groups (models and markers) that aren't drawn. */
  hiddenGroups = new Set<string>();
  /** A model previewing a placement (drawn see-through; red when `ok` is false). */
  ghost: { gpu: ModelGpu; world: Mat4; team: number; ok: boolean } | null = null;
  readonly batches: ObjectBatch[] = [];
  /** Camera: looks at `target` from `distance` away. */
  yaw = -Math.PI / 2;
  pitch = 0.95;
  /** Vertical field of view (radians). */
  fov = Math.PI / 4;
  distance: number;
  target: Vec3;
  readonly center: Vec3;
  /** Ground heights without cliff layers, for models that follow the terrain. */
  private heightMap: HeightMap;
  /** Tiles covered by cliff models and the cliff ground rim, kept for rebuilds. */
  private cliffTiles = new Set<number>();
  private groundOverrides = new Map<number, number>();
  /** Brush outline under the pointer (editing tools). */
  private brush: Mesh | null = null;

  constructor(readonly canvas: HTMLCanvasElement, readonly terrain: Terrain) {
    const gl = canvas.getContext("webgl2", { antialias: true });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.groundProg = compile(gl, GROUND_VS, GROUND_FS);
    this.colorProg = compile(gl, COLOR_VS, COLOR_FS);
    this.waterProg = compile(gl, WATER_VS, WATER_FS);
    this.waterWhite = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.waterWhite);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    this.textures = terrain.groundTiles.map(() => null);
    this.placeholder = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.placeholder);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([110, 110, 100, 255]));
    this.ground = this.buildGround();
    this.water = this.buildWater();
    this.wire = this.buildWire();
    this.heightMap = this.buildHeightMap();

    const t = terrain, w = (t.width - 1) * 128, h = (t.height - 1) * 128;
    this.center = [t.offsetX + w / 2, t.offsetY + h / 2, 0];
    this.target = [...this.center];
    this.distance = Math.max(w, h) * 0.9;
  }

  private corner(x: number, y: number) {
    return this.terrain.corners[y * this.terrain.width + x];
  }

  /** Normal at a corner from its neighbours' heights. */
  private normal(x: number, y: number): Vec3 {
    const t = this.terrain;
    const hz = (cx: number, cy: number) => {
      const qx = Math.min(t.width - 1, Math.max(0, cx)), qy = Math.min(t.height - 1, Math.max(0, cy));
      return this.corner(qx, qy).height + rampLift(t, qx, qy);
    };
    const dx = hz(x + 1, y) - hz(x - 1, y), dy = hz(x, y + 1) - hz(x, y - 1);
    const n: Vec3 = [-dx, -dy, 256];
    const l = Math.hypot(...n);
    return [n[0] / l, n[1] / l, n[2] / l];
  }

  /** Rebuilds the ground without the tiles that cliff models cover, with
   *  ground textures replaced at some corners (corner index → texture). */
  setCliffTiles(tiles: Set<number>, overrides = new Map<number, number>()) {
    this.cliffTiles = tiles;
    this.groundOverrides = overrides;
    this.gl.deleteVertexArray(this.ground);
    this.ranges = [];
    this.ground = this.buildGround(tiles, overrides);
  }

  /** Rebuilds everything derived from the corners after an edit. */
  terrainChanged() {
    const gl = this.gl;
    this.setCliffTiles(this.cliffTiles, this.groundOverrides);
    for (const m of [this.water, this.wire]) gl.deleteVertexArray(m.vao);
    this.water = this.buildWater();
    this.wire = this.buildWire();
    if (this.overlay) this.overlay = { ...this.overlayMesh(), tex: this.overlay.tex };
    gl.bindTexture(gl.TEXTURE_2D, this.heightMap.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.terrain.width, this.terrain.height, gl.RED, gl.FLOAT, this.groundHeights());
  }

  private groundHeights(): Float32Array {
    return new Float32Array(this.terrain.corners.map((c) => c.height - (c.layer - 2) * 128));
  }

  private buildGround(skip = new Set<number>(), overrides = new Map<number, number>()): WebGLVertexArrayObject {
    const t = this.terrain, gl = this.gl;
    // Quads per texture so each texture is one draw call.
    const perTexture: number[][] = t.groundTiles.map(() => []);
    const normals: Vec3[] = [];
    for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) normals.push(this.normal(x, y));

    for (let y = 0; y < t.height - 1; y++) {
      for (let x = 0; x < t.width - 1; x++) {
        if (skip.has(y * (t.width - 1) + x)) continue;
        const bl = this.corner(x, y), br = this.corner(x + 1, y), tl = this.corner(x, y + 1), tr = this.corner(x + 1, y + 1);
        // Blight covers everything, so it gets its own slot drawn last.
        const tex = (cx: number, cy: number) => (this.corner(cx, cy).blight ? BLIGHT_TEXTURE : overrides.get(cy * t.width + cx) ?? this.corner(cx, cy).texture);
        const [tBl, tBr, tTl, tTr] = [tex(x, y), tex(x + 1, y), tex(x, y + 1), tex(x + 1, y + 1)];
        const used = [...new Set([tBl, tBr, tTl, tTr])].sort((a, b) => a - b);
        // Tiles at the camera boundary are shown darkened, like the editor does.
        const shade = bl.boundary || br.boundary || tl.boundary || tr.boundary ? 0.35 : 1;
        used.forEach((id, i) => {
          const cell = i === 0
            ? -1 - bl.variation
            : (tTl === id ? 8 : 0) | (tTr === id ? 4 : 0) | (tBl === id ? 2 : 0) | (tBr === id ? 1 : 0);
          const quad = perTexture[id] ?? (perTexture[id] = []);
          const push = (cx: number, cy: number, u: number, v: number) => {
            const c = this.corner(cx, cy), n = normals[cy * t.width + cx];
            quad.push(t.offsetX + cx * 128, t.offsetY + cy * 128, c.height + rampLift(t, cx, cy), n[0], n[1], n[2], u, v, cell, shade);
          };
          // Image rows run top-down: the tile's north edge is v = 0.
          push(x, y, 0, 1); push(x + 1, y, 1, 1); push(x + 1, y + 1, 1, 0); push(x, y + 1, 0, 0);
        });
      }
    }

    const floats = perTexture.reduce((n, q) => n + q.length, 0);
    const data = new Float32Array(floats);
    const quads = floats / 40;
    const index = new Uint32Array(quads * 6);
    let fo = 0, qo = 0;
    perTexture.forEach((q, texture) => {
      if (!q.length) return;
      data.set(q, fo);
      const n = q.length / 40;
      this.ranges.push({ texture, offset: qo * 6, count: n * 6 });
      for (let i = 0; i < n; i++) {
        const b = (qo + i) * 4;
        index.set([b, b + 1, b + 2, b, b + 2, b + 3], (qo + i) * 6);
      }
      fo += q.length;
      qo += n;
    });

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const attr = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(this.groundProg, name);
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 40, offset * 4);
    };
    attr("aPos", 3, 0); attr("aNormal", 3, 3); attr("aLocal", 2, 6); attr("aCell", 1, 8); attr("aShade", 1, 9);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return vao;
  }

  private buildHeightMap(): HeightMap {
    const t = this.terrain, gl = this.gl;
    const data = this.groundHeights();
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, t.width, t.height, 0, gl.RED, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return { texture, x: t.offsetX, y: t.offsetY, width: t.width, height: t.height };
  }

  private colorMesh(data: number[]): Mesh {
    const gl = this.gl, vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(this.colorProg, "aPos"), col = gl.getAttribLocation(this.colorProg, "aColor");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(col);
    gl.vertexAttribPointer(col, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);
    return { vao, count: data.length / 7 };
  }

  /** Water tiles: position, texture coordinate (one copy per tile), depth in cliff layers. */
  private buildWater(): Mesh {
    const t = this.terrain, gl = this.gl, out: number[] = [];
    for (let y = 0; y < t.height - 1; y++) {
      for (let x = 0; x < t.width - 1; x++) {
        const cs = [this.corner(x, y), this.corner(x + 1, y), this.corner(x + 1, y + 1), this.corner(x, y + 1)];
        if (!cs.some((c) => c.hasWater) || cs.every((c) => c.water <= c.height)) continue;
        const v = cs.map((c, i) => {
          const dx = i === 1 || i === 2 ? 1 : 0, dy = i >= 2 ? 1 : 0;
          return [t.offsetX + (x + dx) * 128, t.offsetY + (y + dy) * 128, c.water, dx, 1 - dy, (c.water - c.height) / 128];
        });
        out.push(...v[0], ...v[1], ...v[2], ...v[0], ...v[2], ...v[3]);
      }
    }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out), gl.STATIC_DRAW);
    const attr = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(this.waterProg, name);
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 24, offset * 4);
    };
    attr("aPos", 3, 0); attr("aUv", 2, 3); attr("aDepth", 1, 5);
    gl.bindVertexArray(null);
    return { vao, count: out.length / 6 };
  }

  /** The tileset's water (frames are filled in by setWaterFrame as they load). */
  setWaterLook(look: Omit<WaterLook, "frames">, frames: number) {
    this.waterLook = { ...look, frames: new Array(frames).fill(null) };
    this.waterFrameShown = -1;
  }

  setWaterFrame(i: number, img: DecodedTexture) {
    if (i >= this.waterLook.frames.length) return;
    const gl = this.gl, tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength));
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    this.waterLook.frames[i] = tex;
  }

  /** The water animation frame for now. */
  private waterFrame(): number {
    const n = this.waterLook.frames.length;
    return n > 1 ? Math.floor((performance.now() / 1000) * this.waterLook.rate) % n : 0;
  }

  private buildWire(): Mesh {
    const t = this.terrain, out: number[] = [];
    const p = (x: number, y: number) => [t.offsetX + x * 128, t.offsetY + y * 128, this.corner(x, y).height + 1, 0, 0, 0, 0.35];
    for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
      if (x + 1 < t.width) out.push(...p(x, y), ...p(x + 1, y));
      if (y + 1 < t.height) out.push(...p(x, y), ...p(x, y + 1));
    }
    return this.colorMesh(out);
  }

  /** Shows an RGBA texture over the ground (`width` × `height` texels, rows from
   *  the south, covering the whole map); null removes it. Re-calling with the
   *  same size only re-uploads the pixels. */
  setGroundOverlay(rgba: Uint8Array | null, width = 0, height = 0) {
    const gl = this.gl;
    if (!rgba) {
      if (this.overlay) { gl.deleteVertexArray(this.overlay.vao); gl.deleteTexture(this.overlay.tex); }
      this.overlay = null;
      return;
    }
    this.overlayProg ??= compile(gl, OVERLAY_VS, OVERLAY_FS);
    if (!this.overlay) {
      const tex = gl.createTexture()!;
      this.overlay = { ...this.overlayMesh(), tex };
    }
    gl.bindTexture(gl.TEXTURE_2D, this.overlay.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Ground-hugging tile quads for the overlay (positions only). */
  private overlayMesh(): { vao: WebGLVertexArrayObject; count: number } {
    const t = this.terrain, gl = this.gl, prog = this.overlayProg!;
    const pos = new Float32Array(t.width * t.height * 3);
    for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
      const o = (y * t.width + x) * 3;
      pos[o] = t.offsetX + x * 128; pos[o + 1] = t.offsetY + y * 128; pos[o + 2] = this.corner(x, y).height + rampLift(t, x, y) + 2;
    }
    const idx = new Uint32Array((t.width - 1) * (t.height - 1) * 6);
    let k = 0;
    for (let y = 0; y < t.height - 1; y++) for (let x = 0; x < t.width - 1; x++) {
      const a = y * t.width + x, b = a + 1, c = a + t.width, d = c + 1;
      idx.set([a, b, d, a, d, c], k); k += 6;
    }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 12, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: idx.length };
  }

  /** Replaces a named group of point markers (e.g. "doodads", "units"). */
  setMarkers(name: string, markers: Marker[]) {
    this.markers.set(name, this.colorMesh(markers.flatMap((m) => [m.x, m.y, m.z + 8, m.rgb[0] / 255, m.rgb[1] / 255, m.rgb[2] / 255, 1])));
  }

  setGroundTexture(i: number, img: DecodedTexture) {
    const gl = this.gl, tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength));
    gl.generateMipmap(gl.TEXTURE_2D);
    // Deeper mip levels would blend neighbouring cells together.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, Math.max(0, Math.log2(img.height / 4) - 3));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures[i] = { tex, extended: img.width > img.height };
  }

  /** Camera position. */
  eye(): Vec3 {
    return [
      this.target[0] + this.distance * Math.cos(this.pitch) * Math.cos(this.yaw),
      this.target[1] + this.distance * Math.cos(this.pitch) * Math.sin(this.yaw),
      this.target[2] + this.distance * Math.sin(this.pitch),
    ];
  }

  /** World-space ray through a canvas point (CSS pixels). Matches render()'s camera. */
  ray(px: number, py: number): { origin: Vec3; dir: Vec3 } {
    const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight);
    const eye = this.eye();
    const f = norm([this.target[0] - eye[0], this.target[1] - eye[1], this.target[2] - eye[2]]);
    const r = norm([f[1], -f[0], 0]);
    const u: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const t = Math.tan(this.fov / 2), nx = ((px / w) * 2 - 1) * t * (w / h), ny = (1 - (py / h) * 2) * t;
    return { origin: eye, dir: norm([f[0] + r[0] * nx + u[0] * ny, f[1] + r[1] * nx + u[1] * ny, f[2] + r[2] * nx + u[2] * ny]) };
  }

  /** Ground height (layers and ramps included) at a world point, bilinear between corners. */
  groundHeight(x: number, y: number): number {
    return heightAt(this.terrain, x, y);
  }

  /** The nearest placed object (with a model) hit by a ray. */
  /** The nearest placed object a ray hits. With `radiusOf`, objects are
   *  upright cylinders of that radius (their footprint) standing at their
   *  position up to the top of the model; otherwise the model's bounding sphere. */
  pickObject(ray: { origin: Vec3; dir: Vec3 }, radiusOf?: (inst: ObjectInstance) => number | undefined): ObjectInstance | null {
    const { origin: o, dir: d } = ray;
    let best: ObjectInstance | null = null, bestT = Infinity;
    for (const b of this.batches) {
      if (this.hiddenGroups.has(b.group)) continue;
      for (const inst of b.instances) {
        if (!inst.pick || !inst.sphere) continue;
        const [cx, cy, cz, sr] = inst.sphere;
        const r = radiusOf?.(inst);
        let t = Infinity;
        if (r === undefined) {
          const ox = o[0] - cx, oy = o[1] - cy, oz = o[2] - cz;
          const p = ox * d[0] + oy * d[1] + oz * d[2], q = ox * ox + oy * oy + oz * oz - sr * sr;
          const disc = p * p - q;
          if (disc >= 0) t = -p - Math.sqrt(disc);
        } else {
          const [px, py, pz] = inst.pick.placed.position;
          const bottom = pz - 16, top = Math.max(pz + 32, cz + sr * 0.8);
          // Side of the cylinder (the xy circle), then its top cap.
          const ox = o[0] - px, oy = o[1] - py;
          const a = d[0] * d[0] + d[1] * d[1], bq = ox * d[0] + oy * d[1], c = ox * ox + oy * oy - r * r;
          const disc = bq * bq - a * c;
          if (a > 1e-9 && disc >= 0) {
            const t0 = (-bq - Math.sqrt(disc)) / a, t1 = (-bq + Math.sqrt(disc)) / a;
            for (const tt of [t0, t1]) {
              const z = o[2] + d[2] * tt;
              if (tt > 0 && z >= bottom && z <= top) { t = Math.min(t, tt); break; }
            }
          }
          if (Math.abs(d[2]) > 1e-9) {
            const tc = (top - o[2]) / d[2];
            const hx = o[0] + d[0] * tc - px, hy = o[1] + d[1] * tc - py;
            if (tc > 0 && hx * hx + hy * hy <= r * r) t = Math.min(t, tc);
          }
        }
        if (t > 0 && t < bestT) { bestT = t; best = inst; }
      }
    }
    return best;
  }

  /** Where a ray meets the ground, or null if it misses the map. */
  pickGround(ray: { origin: Vec3; dir: Vec3 }): Vec3 | null {
    const { origin: o, dir: d } = ray;
    const at = (t: number): Vec3 => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    const above = (t: number) => { const p = at(t); return p[2] > this.groundHeight(p[0], p[1]); };
    const step = 32, far = this.distance * 10;
    let lo = 0;
    for (let t = step; t < far; t += step) {
      if (above(t)) { lo = t; continue; }
      let hi = t;
      for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (above(mid)) lo = mid; else hi = mid; }
      const p = at(hi), tt = this.terrain;
      const inside = p[0] >= tt.offsetX && p[1] >= tt.offsetY && p[0] <= tt.offsetX + (tt.width - 1) * 128 && p[1] <= tt.offsetY + (tt.height - 1) * 128;
      return inside ? p : null;
    }
    return null;
  }

  /** Marks spots with rings that follow the ground; null or [] clears them. */
  setSelection(sel: Ring | Ring[] | null) {
    for (const m of this.selection) this.gl.deleteVertexArray(m.vao);
    const rings = sel === null ? [] : Array.isArray(sel) ? sel : [sel];
    this.selection = rings.map((r) => this.ring(r, rings.length > 50 ? 16 : 64));
  }

  /** Canvas point (CSS pixels) of a world point, or null behind the camera. Inverse of ray(). */
  project(p: Vec3): [number, number] | null {
    const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight);
    const eye = this.eye();
    const f = norm([this.target[0] - eye[0], this.target[1] - eye[1], this.target[2] - eye[2]]);
    const r = norm([f[1], -f[0], 0]);
    const u: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
    const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
    if (z <= 0) return null;
    const t = Math.tan(this.fov / 2);
    const nx = (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / z / (t * (w / h)), ny = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / z / t;
    return [((nx + 1) / 2) * w, ((1 - ny) / 2) * h];
  }

  /** The brush outline (editing tools); null hides it. */
  setBrush(b: Ring | null) {
    if (this.brush) this.gl.deleteVertexArray(this.brush.vao);
    this.brush = b ? this.ring(b) : null;
  }

  private ring(r: Ring, segments = 64): Mesh {
    const data: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      let dx = Math.cos(a), dy = Math.sin(a);
      // Square: the same directions pushed out to the square's edge.
      if (r.square) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx /= m; dy /= m; }
      const x = r.x + dx * r.r, y = r.y + dy * r.r;
      data.push(x, y, this.groundHeight(x, y) + 4, r.rgb[0] / 255, r.rgb[1] / 255, r.rgb[2] / 255, 1);
    }
    return this.colorMesh(data);
  }

  /** Whether the view changes by itself (particles): then it should be drawn every frame. */
  get animating(): boolean {
    if (this.showWater && this.water.count && this.waterLook.frames.length > 1 && this.waterFrame() !== this.waterFrameShown) return true;
    return this.showEffects && this.batches.some((b) => b.instances.length && b.effects && !this.hiddenGroups.has(b.group));
  }

  /** Steps and draws the particles of placed objects near the view. */
  private drawParticles(viewProj: Mat4, eye: Vec3) {
    const now = performance.now();
    const dt = this.lastParticleTime < 0 ? 0 : Math.min(0.1, (now - this.lastParticleTime) / 1000);
    this.lastParticleTime = now;
    // Far objects aren't simulated (they keep their particles until the view comes back).
    const reach = this.distance * 2.5 + 1024;
    const items: Parameters<ParticleRenderer["draw"]>[2] = [];
    for (const b of this.batches) {
      const fx = b.effects;
      if (!fx || this.hiddenGroups.has(b.group)) continue;
      for (const inst of b.instances) {
        if (Math.hypot(inst.world[12] - this.target[0], inst.world[13] - this.target[1]) > reach) continue;
        let p = this.particleStates.get(inst);
        if (!p) this.particleStates.set(inst, (p = new ParticleInstance(fx.model)));
        p.step(dt, fx.clock, fx.nodeWorld, inst.world);
        items.push({ particles: p, textures: fx.textures, world: inst.world });
      }
    }
    if (!items.length) return;
    this.particleRenderer ??= new ParticleRenderer(this.gl);
    this.particleRenderer.draw(viewProj, eye, items);
  }

  render() {
    const gl = this.gl;
    const w = this.canvas.clientWidth * devicePixelRatio, h = this.canvas.clientHeight * devicePixelRatio;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.11, 0.12, 0.14, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);

    const viewProj = mat4.mul(
      mat4.perspective(this.fov, w / Math.max(1, h), Math.max(10, this.distance / 50), this.distance * 10),
      mat4.lookAt(this.eye(), this.target, [0, 0, 1]),
    );

    // Ground: lowest texture first, the others blend over it.
    gl.useProgram(this.groundProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.groundProg, "uViewProj"), false, viewProj);
    const groundLight = this.terrainLight ?? GROUND_DEFAULT;
    gl.uniform3fv(gl.getUniformLocation(this.groundProg, "uLightDir"), groundLight.dir);
    gl.uniform3fv(gl.getUniformLocation(this.groundProg, "uDiffuse"), groundLight.diffuse);
    gl.uniform3fv(gl.getUniformLocation(this.groundProg, "uAmbient"), groundLight.ambient);
    gl.uniform1i(gl.getUniformLocation(this.groundProg, "uTex"), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.ground);
    for (const r of this.ranges) {
      const t = this.textures[r.texture];
      gl.bindTexture(gl.TEXTURE_2D, t?.tex ?? this.placeholder);
      gl.uniform1f(gl.getUniformLocation(this.groundProg, "uExtended"), t?.extended ? 1 : 0);
      gl.drawElements(gl.TRIANGLES, r.count, gl.UNSIGNED_INT, r.offset * 4);
    }

    if (this.overlay && this.overlayProg) {
      const t = this.terrain;
      gl.useProgram(this.overlayProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.overlayProg, "uViewProj"), false, viewProj);
      gl.uniform4f(gl.getUniformLocation(this.overlayProg, "uRect"), t.offsetX, t.offsetY, (t.width - 1) * 128, (t.height - 1) * 128);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.overlay.tex);
      gl.uniform1i(gl.getUniformLocation(this.overlayProg, "uTex"), 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.bindVertexArray(this.overlay.vao);
      gl.drawElements(gl.TRIANGLES, this.overlay.count, gl.UNSIGNED_INT, 0);
      gl.depthMask(true);
    }

    // Placed objects: every opaque layer, then every blended one.
    for (const pass of ["opaque", "blended"] as const) {
      for (const b of this.batches) {
        if (this.hiddenGroups.has(b.group)) continue;
        const light = (b.group === "units" ? this.unitLight : this.terrainLight) ?? undefined;
        for (const inst of b.instances) b.gpu.draw(viewProj, inst.world, { team: inst.team, pass, heightMap: b.followGround ? this.heightMap : undefined, light });
      }
    }
    if (this.showEffects) this.drawParticles(viewProj, this.eye());
    else this.lastParticleTime = -1;
    // Placement preview: see-through, red where the object doesn't fit.
    if (this.ghost) {
      const g = this.ghost;
      g.gpu.draw(viewProj, g.world, { team: g.team, pass: "all", tint: [1, 1, 1, 0.75], mix: g.ok ? undefined : [1, 0.1, 0.1, 0.65], onTop: true });
    }
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.colorProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.colorProg, "uViewProj"), false, viewProj);
    gl.uniform1f(gl.getUniformLocation(this.colorProg, "uPointSize"), 5000);
    if (this.wireframe) {
      gl.bindVertexArray(this.wire.vao);
      gl.drawArrays(gl.LINES, 0, this.wire.count);
    }
    gl.disable(gl.BLEND);
    for (const [name, m] of this.markers) {
      if (this.hiddenGroups.has(name)) continue;
      gl.bindVertexArray(m.vao);
      gl.drawArrays(gl.POINTS, 0, m.count);
    }
    if (this.showWater && this.water.count) {
      const look = this.waterLook, frame = this.waterFrame();
      this.waterFrameShown = frame;
      gl.useProgram(this.waterProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.waterProg, "uViewProj"), false, viewProj);
      gl.uniform1i(gl.getUniformLocation(this.waterProg, "uTex"), 0);
      for (const [name, v] of [["uShallowMin", look.shallowMin], ["uShallowMax", look.shallowMax], ["uDeepMin", look.deepMin], ["uDeepMax", look.deepMax]] as const) {
        gl.uniform4fv(gl.getUniformLocation(this.waterProg, name), v);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, look.frames[frame] ?? look.frames.find((f) => f) ?? this.waterWhite);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(this.water.vao);
      gl.drawArrays(gl.TRIANGLES, 0, this.water.count);
      gl.depthMask(true);
      // The rings below use the colour program (its view matrix is still set).
      gl.useProgram(this.colorProg);
    }
    // Rings stay visible through trees and water.
    gl.disable(gl.DEPTH_TEST);
    for (const ring of [...this.selection, this.brush]) {
      if (!ring) continue;
      gl.bindVertexArray(ring.vao);
      gl.drawArrays(gl.LINE_LOOP, 0, ring.count);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }

  dispose() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
