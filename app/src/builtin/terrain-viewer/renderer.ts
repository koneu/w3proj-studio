// WebGL2 terrain: textured ground (Warcraft's corner-mask tile atlas), water,
// placed doodads/units as models, and point markers for objects without one.
// Cliff tiles get cliff models (see cliffs.ts); ramps stay sloped ground.

import type { DecodedImage } from "../../lib/image/index";
import { FOG_FS, FOG_VS, setFog, type Fog } from "../../lib/model/fog";
import { createTexture } from "../../lib/model/gltexture";
import { frustumPlanes, sphereInView } from "../../lib/model/frustum";
import { compile, INSTANCE_BYTES, mat4, poseNodes, standClock, type Clock, type HeightMap, type InstanceRuns, type Mat4, type ModelGpu, type Vec3 } from "../../lib/model/renderer";
import type { Model } from "../../lib/model/mdx";
import type { SceneLight } from "../../lib/model/dnclight";

/** Ground light without the map's lighting: soft ambient plus a light from the south-west. */
const GROUND_DEFAULT: SceneLight = { dir: [-0.3, -0.4, 0.85], diffuse: [0.65, 0.65, 0.65], ambient: [0.45, 0.45, 0.45] };
import { ParticleInstance, ParticleRenderer } from "../../lib/model/particles";
import { MOST_PARTICLES, placeWeather, viewBox, type WeatherBox, type WeatherEffect } from "../../lib/model/weather";
import type { Placed } from "./objects";
import { cornerNormal, heightAt, rampLift, type Terrain } from "../../lib/terrain/w3e";

const norm = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Ground tile textures are 4×4 cells of corner-transition shapes (a cell's
// index is a bitmask of the tile corners the texture covers); "extended"
// textures are twice as wide and add 16 full-tile variations. Negative cells
// stand for a variation and are resolved once the texture's size is known.
const GROUND_VS = `#version 300 es
in vec3 aPos; in vec3 aNormal; in vec2 aLocal; in float aCell; in float aShade;
uniform mat4 uViewProj; uniform float uExtended;
out vec2 vUV; out vec3 vNormal; out float vShade;
${FOG_VS}
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
  vFogDepth = gl_Position.w;
}`;
const GROUND_FS = `#version 300 es
precision mediump float;
in vec2 vUV; in vec3 vNormal; in float vShade;
uniform sampler2D uTex;
uniform vec3 uLightDir; uniform vec3 uDiffuse; uniform vec3 uAmbient;
out vec4 outColor;
${FOG_FS}
void main() {
  vec4 c = texture(uTex, vUV);
  vec3 light = uAmbient + uDiffuse * max(dot(normalize(vNormal), normalize(uLightDir)), 0.0);
  outColor = vec4(fogged(c.rgb * light * vShade), c.a);
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
${FOG_VS}
void main() { vUv = aUv; vDepth = aDepth; gl_Position = uViewProj * vec4(aPos, 1.0); vFogDepth = gl_Position.w; }`;
const WATER_FS = `#version 300 es
precision mediump float;
in vec2 vUv; in float vDepth;
uniform sampler2D uTex; uniform vec4 uShallowMin; uniform vec4 uShallowMax; uniform vec4 uDeepMin; uniform vec4 uDeepMax;
// The scene light on a flat surface (the map's water tint is in the ramp: waterRamp); uGrey 1: the
// texture gives only its brightness (tinted water).
uniform vec3 uLight; uniform float uGrey;
out vec4 outColor;
${FOG_FS}
void main() {
  const float minDepth = 10.0 / 128.0, deepLevel = 64.0 / 128.0, maxDepth = 72.0 / 128.0;
  vec4 c = vDepth <= deepLevel
    ? mix(uShallowMin, uShallowMax, clamp((vDepth - minDepth) / (deepLevel - minDepth), 0.0, 1.0))
    : mix(uDeepMin, uDeepMax, clamp((vDepth - deepLevel) / (maxDepth - deepLevel), 0.0, 1.0));
  vec4 t = texture(uTex, vUv);
  t.rgb = mix(t.rgb, vec3(dot(t.rgb, vec3(0.299, 0.587, 0.114))), uGrey);
  vec4 w = t * c;
  outColor = vec4(fogged(w.rgb * uLight), w.a);
}`;

/** A tileset's water: animation frames (by index; null until loaded), frames per second and
 *  the colour ramp (r, g, b, a in 0–1). */
export interface WaterLook {
  frames: (WebGLTexture | null)[];
  rate: number;
  shallowMin: number[]; shallowMax: number[]; deepMin: number[]; deepMax: number[];
}

type WaterRamp = Pick<WaterLook, "shallowMin" | "shallowMax" | "deepMin" | "deepMax">;

/** The colour ramp the water is drawn with (the shader multiplies the texture by it), and whether the
 *  texture gives only its brightness (`grey`). The map's water tint (war3map.w3i, stored blue, green,
 *  red, alpha; null when its tinting is off) takes the place of the colour, as the game's
 *  SetWaterBaseColor does: 03b_Water_Tint's red tint is plainly red in the game, not the ramp's blue
 *  darkened, nor the (blue) texture's colour under red. Its alpha scales the ramp's, so the shallows
 *  still fade out at the shore. */
export function waterRamp(look: WaterRamp, tint: number[] | null): WaterRamp & { grey: boolean } {
  if (!tint) return { shallowMin: look.shallowMin, shallowMax: look.shallowMax, deepMin: look.deepMin, deepMax: look.deepMax, grey: false };
  const [b, g, r, a = 255] = tint;
  const apply = (c: number[]) => [r / 255, g / 255, b / 255, c[3] * (a / 255)];
  return { shallowMin: apply(look.shallowMin), shallowMax: apply(look.shallowMax), deepMin: apply(look.deepMin), deepMax: apply(look.deepMax), grey: true };
}

/** Until the game's water is known: an untextured blue-grey ramp. */
const WATER_DEFAULT: WaterLook = {
  frames: [], rate: 1,
  shallowMin: [0.12, 0.32, 0.5, 0.25], shallowMax: [0.12, 0.32, 0.5, 0.6], deepMin: [0.12, 0.32, 0.5, 0.6], deepMax: [0.1, 0.27, 0.45, 0.85],
};

// Building ground marks (splats): a texture draped over the ground, tinted, lit like the ground.
const SPLAT_VS = `#version 300 es
in vec3 aPos; in vec2 aUv;
uniform mat4 uViewProj;
out vec2 vUv;
${FOG_VS}
void main() { vUv = aUv; gl_Position = uViewProj * vec4(aPos, 1.0); vFogDepth = gl_Position.w; }`;
const SPLAT_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex; uniform vec4 uColor; uniform vec3 uLight;
out vec4 outColor;
${FOG_FS}
void main() { vec4 c = texture(uTex, vUv) * uColor; outColor = vec4(fogged(c.rgb * uLight), c.a); }`;

// Ground overlay: a texture spread over the map (one texel per 32×32 pathing
// cell), e.g. the pathing editor's view.
const OVERLAY_VS = `#version 300 es
in vec3 aPos;
uniform mat4 uViewProj; uniform vec4 uRect;
out vec2 vUV;
${FOG_VS}
void main() { vUV = (aPos.xy - uRect.xy) / uRect.zw; gl_Position = uViewProj * vec4(aPos, 1.0); vFogDepth = gl_Position.w; }`;
const OVERLAY_FS = `#version 300 es
precision mediump float; in vec2 vUV; uniform sampler2D uTex; out vec4 outColor;
${FOG_FS}
void main() { outColor = texture(uTex, vUV); if (outColor.a < 0.01) discard; outColor.rgb = fogged(outColor.rgb); }`;

// Grid lines over the ground, drawn per pixel so any map size costs the same: lines every uStep world units
// from the map's corner, fading out once the cells are too small to tell apart.
const GRID_VS = `#version 300 es
in vec3 aPos;
uniform mat4 uViewProj;
out highp vec2 vW;
${FOG_VS}
void main() { vW = aPos.xy; gl_Position = uViewProj * vec4(aPos, 1.0); vFogDepth = gl_Position.w; }`;
const GRID_FS = `#version 300 es
precision highp float; in vec2 vW; uniform vec2 uOrigin; uniform float uStep; uniform vec4 uColor; out vec4 outColor;
${FOG_FS}
void main() {
  vec2 g = (vW - uOrigin) / uStep, w = max(fwidth(g), vec2(1e-6));
  vec2 d = abs(fract(g - 0.5) - 0.5) / w;
  float line = (1.0 - min(min(d.x, d.y), 1.0)) * (1.0 - smoothstep(0.2, 0.45, max(w.x, w.y)));
  if (line < 0.02) discard;
  outColor = vec4(fogged(uColor.rgb), uColor.a * line);
}`;

/** A ground-following circle (selection, brush outline). */
export interface Ring {
  x: number;
  y: number;
  /** Height of the ring when it doesn't follow the ground: round a doodad that has a height of its own. */
  z?: number;
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
  /** The model's own bounding sphere [x, y, z, r], in model space: `sphere` is it placed by `world`. */
  bounds?: readonly [number, number, number, number];
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

/** The order object groups are drawn in; others come after, in the order they came. */
export const GROUP_ORDER = ["cliffs", "shoreline", "doodads", "units"];

/** The batches with one group's replaced, at the group's place in GROUP_ORDER. */
export function withGroup<B extends { group: string }>(batches: readonly B[], group: string, replacement: readonly B[]): B[] {
  const rank = (g: string) => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? GROUP_ORDER.length : i; };
  const others = batches.filter((b) => b.group !== group);
  const at = others.findIndex((b) => rank(b.group) > rank(group));
  return at < 0 ? [...others, ...replacement] : [...others.slice(0, at), ...replacement, ...others.slice(at)];
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

/** A weather's emitter doesn't animate: it has one still node. */
const WEATHER_CLOCK = { frame: 0, seqStart: 0, seqEnd: 0, time: 0 };
const WEATHER_NODES = [new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])];

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
  /** The map's water tint as stored (b, g, r, a in 0–255; see waterRamp) when tinting is on; null: none. */
  waterTint: number[] | null = null;
  private splatProg: WebGLProgram;
  /** Splat meshes by texture path and blend mode. */
  private splats: { texture: string; blend: number; color: number[]; vao: WebGLVertexArrayObject; count: number }[] = [];
  private splatTextures = new Map<string, WebGLTexture>();
  private overlayProg: WebGLProgram | null = null;
  private overlay: { vao: WebGLVertexArrayObject; count: number; pos: WebGLBuffer; tex: WebGLTexture } | null = null;
  /** The dark over the map's border: its own layer, as tools use the overlay. */
  private border: { vao: WebGLVertexArrayObject; count: number; pos: WebGLBuffer; tex: WebGLTexture } | null = null;
  showBorder = true;
  /** What the View toggles show over the ground (Height Map, Pathing - Naval, Camera Objects), one texture; tools keep `overlay`. */
  private viewLayer: { vao: WebGLVertexArrayObject; count: number; pos: WebGLBuffer; tex: WebGLTexture } | null = null;
  private held: { viewLayer: { vao: WebGLVertexArrayObject; count: number; pos: WebGLBuffer; tex: WebGLTexture } | null } | null = null;
  /** Grid lines every this many world units (0: none). */
  gridStep = 0;
  private gridProg: WebGLProgram | null = null;
  private gridMesh: { vao: WebGLVertexArrayObject; count: number; pos: WebGLBuffer } | null = null;
  /** The map's fog, and whether it's shown. */
  fog: Fog | null = null;
  showFog = true;
  /** A sky model drawn around the camera, and the radius it reaches at scale 1. */
  sky: { gpu: ModelGpu; radius: number } | null = null;
  showSky = true;
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
  /** The map's weather: over its box, or following the view without one. */
  weather: { effect: WeatherEffect; particles: ParticleInstance; texture: WebGLTexture | null; box: WeatherBox | null }[] = [];
  showWeather = true;
  wireframe = false;
  /** Object groups (models and markers) that aren't drawn. */
  hiddenGroups = new Set<string>();
  /** A model previewing a placement (drawn see-through; red when `ok` is false). */
  ghost: { gpu: ModelGpu; world: Mat4; team: number; ok: boolean } | null = null;
  /** Several at once, for what's being pasted. */
  ghosts: NonNullable<TerrainRenderer["ghost"]>[] = [];
  readonly batches: ObjectBatch[] = [];

  /** Puts the batches of one group in place of its old ones. Groups keep a fixed order, so what is
   *  drawn over what (see-through layers blend in drawing order) doesn't follow which group
   *  finished loading first. */
  setGroup(group: string, batches: ObjectBatch[]) {
    const next = withGroup(this.batches, group, batches);
    this.batches.length = 0;
    this.batches.push(...next);
    // The instance buffers of batches that are gone go with them.
    const kept = new Set(next);
    for (const [b, buf] of this.instanceBuffers) if (!kept.has(b)) { this.gl.deleteBuffer(buf.buffer); this.instanceBuffers.delete(b); }
  }

  /** Per batch, a GPU buffer of the world matrices of its instances in view, filled at each frame. */
  private instanceBuffers = new Map<ObjectBatch, { buffer: WebGLBuffer | null; bytes: number }>();
  /** Room to gather a batch's matrices before they're uploaded. */
  private instanceData = new Float32Array(16 * 1024);

  /** Fills a batch's instance buffer with its instances in view (all of them without `planes`), in runs
   *  of one player colour, and says what's where. */
  private gatherInstances(b: ObjectBatch, planes: Float32Array | null): InstanceRuns {
    const gl = this.gl;
    const byTeam = new Map<number, ObjectInstance[]>();
    let n = 0;
    for (const inst of b.instances) {
      if (planes && inst.sphere && !sphereInView(planes, inst.sphere)) continue;
      let list = byTeam.get(inst.team);
      if (!list) byTeam.set(inst.team, (list = []));
      list.push(inst);
      n++;
    }
    const runs: InstanceRuns["runs"] = [];
    let entry = this.instanceBuffers.get(b);
    if (!entry) this.instanceBuffers.set(b, (entry = { buffer: gl.createBuffer(), bytes: 0 }));
    if (!n) return { buffer: entry.buffer, runs };
    if (this.instanceData.length < n * 16) this.instanceData = new Float32Array(Math.max(n * 16, this.instanceData.length * 2));
    const data = this.instanceData;
    let at = 0;
    for (const [team, list] of byTeam) {
      runs.push({ team, first: at, count: list.length });
      for (const inst of list) data.set(inst.world, (at++) * 16);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
    if (entry.bytes < n * INSTANCE_BYTES) {
      entry.bytes = Math.max(n, 16, (entry.bytes / INSTANCE_BYTES) * 2) * INSTANCE_BYTES;
      gl.bufferData(gl.ARRAY_BUFFER, entry.bytes, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * 16);
    return { buffer: entry.buffer, runs };
  }
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
    // Opaque: blended layers (leaves, the boundary's shade) would otherwise leave the picture part see-through,
    // and the page behind lightened them, as pale ghosts in a fog that hides everything else.
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.groundProg = compile(gl, GROUND_VS, GROUND_FS);
    this.colorProg = compile(gl, COLOR_VS, COLOR_FS);
    this.waterProg = compile(gl, WATER_VS, WATER_FS);
    this.splatProg = compile(gl, SPLAT_VS, SPLAT_FS);
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
    return cornerNormal(this.terrain, x, y);
  }

  /** Rebuilds the ground without the tiles that cliff models cover, with
   *  ground textures replaced at some corners (corner index → texture). */
  setCliffTiles(tiles: Set<number>, overrides = new Map<number, number>()) {
    this.cliffTiles = tiles;
    this.groundOverrides = overrides;
    this.freeVao(this.ground);
    this.ranges = [];
    this.ground = this.buildGround(tiles, overrides);
  }

  /** Rebuilds everything derived from the corners after an edit. */
  terrainChanged() {
    const gl = this.gl;
    this.setCliffTiles(this.cliffTiles, this.groundOverrides);
    for (const m of [this.water, this.wire]) this.freeVao(m.vao);
    this.water = this.buildWater();
    this.wire = this.buildWire();
    // Same size, new heights: the overlays' meshes only get new positions.
    for (const layer of [this.overlay, this.border, this.viewLayer, this.held?.viewLayer, this.gridMesh]) if (layer) this.reshapeOverlay(layer.pos);
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
    const vb = this.buf(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const attr = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(this.groundProg, name);
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 40, offset * 4);
    };
    attr("aPos", 3, 0); attr("aNormal", 3, 3); attr("aLocal", 2, 6); attr("aCell", 1, 8); attr("aShade", 1, 9);
    const ib = this.buf(vao);
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
    const b = this.buf(vao);
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
        // Corners without water (the shore) keep the surface level: their stored level is
        // meaningless (often the default far below), which would tilt the water into the ground.
        const wet = cs.filter((c) => c.hasWater);
        const level = Math.max(...wet.map((c) => c.water));
        // On a cliff tile the dry corners are on the cliff top, but the wall goes down into the
        // water: they keep the wet corners' depth (no fade to clear at the wall). On a slope the
        // shallow edge fades out.
        const cliff = !cs.every((c) => c.layer === cs[0].layer);
        const wetDepth = Math.max(...wet.map((c) => c.water - c.height));
        const v = cs.map((c, i) => {
          const dx = i === 1 || i === 2 ? 1 : 0, dy = i >= 2 ? 1 : 0;
          const z = c.hasWater ? c.water : level;
          const depth = !c.hasWater && cliff ? wetDepth : z - c.height;
          return [t.offsetX + (x + dx) * 128, t.offsetY + (y + dy) * 128, z, dx, 1 - dy, depth / 128];
        });
        out.push(...v[0], ...v[1], ...v[2], ...v[0], ...v[2], ...v[3]);
      }
    }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vb = this.buf(vao);
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

  /** Building ground marks: squares (half-size `scale`) draped over the ground in 32-unit
   *  cells, grouped by texture, blend mode and colour. */
  setSplats(list: { x: number; y: number; scale: number; texture: string; blend: number; color: number[] }[]) {
    const gl = this.gl, t = this.terrain;
    for (const s of this.splats) this.freeVao(s.vao);
    const groups = new Map<string, { texture: string; blend: number; color: number[]; data: number[] }>();
    for (const s of list) {
      const key = `${s.texture}|${s.blend}|${s.color.join(",")}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { texture: s.texture, blend: s.blend, color: s.color, data: [] }));
      const n = Math.max(1, Math.ceil((2 * s.scale) / 32)), size = 2 * s.scale;
      const x0 = s.x - s.scale, y0 = s.y - s.scale;
      const v = (i: number, j: number) => {
        const x = x0 + (size * i) / n, y = y0 + (size * j) / n;
        return [x, y, heightAt(t, x, y) + 2, i / n, 1 - j / n];
      };
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        g.data.push(...v(i, j), ...v(i + 1, j), ...v(i + 1, j + 1), ...v(i, j), ...v(i + 1, j + 1), ...v(i, j + 1));
      }
    }
    this.splats = [...groups.values()].map((g) => {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const vb = this.buf(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g.data), gl.STATIC_DRAW);
      const attr = (name: string, size: number, offset: number) => {
        const loc = gl.getAttribLocation(this.splatProg, name);
        if (loc < 0) return;
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 20, offset * 4);
      };
      attr("aPos", 3, 0); attr("aUv", 2, 3);
      gl.bindVertexArray(null);
      return { texture: g.texture, blend: g.blend, color: g.color, vao, count: g.data.length / 5 };
    });
  }

  setSplatTexture(path: string, img: DecodedImage) {
    this.splatTextures.set(path.toLowerCase(), createTexture(this.gl, img, { repeat: [false, false] }));
  }

  /** The tileset's water (frames are filled in by setWaterFrame as they load). */
  setWaterLook(look: Omit<WaterLook, "frames">, frames: number) {
    this.waterLook = { ...look, frames: new Array(frames).fill(null) };
    this.waterFrameShown = -1;
  }

  setWaterFrame(i: number, img: DecodedImage) {
    if (i >= this.waterLook.frames.length) return;
    this.waterLook.frames[i] = createTexture(this.gl, img, { repeat: [true, true] });
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
  /** Everything shown, whatever the user switched off, apart from what the tool asks to `hide`,
   *  until the function it returns runs: a tool sees the map, not this person's way of looking at it. */
  showEverything(hide: { groups: string[]; water: boolean } = { groups: [], water: false }) {
    const { hiddenGroups, showWater, showEffects, wireframe, overlay, showBorder, showFog, showSky, showWeather, viewLayer, gridStep } = this;
    // The view layer is put aside, not dropped: a layer set while this lasts goes there, and is what comes back.
    this.held = { viewLayer };
    this.hiddenGroups = new Set(hide.groups);
    this.showWater = !hide.water;
    this.showEffects = true;
    this.wireframe = false;
    this.overlay = null;
    this.viewLayer = null;
    this.gridStep = 0;
    this.showBorder = false;
    this.showFog = false;
    this.showSky = false;
    this.showWeather = false;
    return () => {
      this.setGroundOverlay(null);
      const held = this.held;
      this.held = null;
      Object.assign(this, { hiddenGroups, showWater, showEffects, wireframe, overlay, showBorder, showFog, showSky, showWeather, viewLayer: held?.viewLayer ?? null, gridStep });
    };
  }

  setGroundOverlay(rgba: Uint8Array | null, width = 0, height = 0) {
    const gl = this.gl;
    if (!rgba) {
      if (this.overlay) { this.freeVao(this.overlay.vao); gl.deleteTexture(this.overlay.tex); }
      this.overlay = null;
      return;
    }
    if (!this.overlayProgram()) return;
    if (!this.overlay) {
      const tex = gl.createTexture()!;
      this.overlay = { ...this.overlayMesh(), tex };
    }
    this.uploadOverlay(this.overlay.tex, rgba, width, height);
  }

  /** The View toggles' picture (one texel per pathing cell, rows from the south); null removes it. */
  setViewLayer(rgba: Uint8Array | null, width = 0, height = 0) {
    const gl = this.gl;
    // While showEverything lasts the layer lives in `held`; the picture taken doesn't show it.
    const slot = this.held ?? (this as unknown as NonNullable<TerrainRenderer["held"]>);
    if (!rgba) {
      if (slot.viewLayer) { this.freeVao(slot.viewLayer.vao); gl.deleteTexture(slot.viewLayer.tex); }
      slot.viewLayer = null;
      return;
    }
    if (!this.overlayProgram()) return;
    slot.viewLayer ??= { ...this.overlayMesh(), tex: gl.createTexture()! };
    this.uploadOverlay(slot.viewLayer.tex, rgba, width, height);
  }

  /** The border's shade, one texel per tile. */
  setBorder(rgba: Uint8Array, width: number, height: number) {
    if (!this.overlayProgram()) return;
    this.border ??= { ...this.overlayMesh(), tex: this.gl.createTexture()! };
    this.uploadOverlay(this.border.tex, rgba, width, height);
  }

  /** The overlay program, compiled the first time; null once the context is gone (the editor closed
   *  while a file was still being read for a layer): a shader can't compile then, and nothing is drawn anyway. */
  private overlayProgram(): WebGLProgram | null {
    if (this.gl.isContextLost()) return null;
    return (this.overlayProg ??= compile(this.gl, OVERLAY_VS, OVERLAY_FS));
  }

  private uploadOverlay(tex: WebGLTexture, rgba: Uint8Array, width: number, height: number) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Every buffer made for a vertex array, so that dropping the array drops them too. */
  private vaoBuffers = new Map<WebGLVertexArrayObject, WebGLBuffer[]>();
  private buf(vao: WebGLVertexArrayObject): WebGLBuffer {
    const b = this.gl.createBuffer()!;
    const list = this.vaoBuffers.get(vao);
    if (list) list.push(b); else this.vaoBuffers.set(vao, [b]);
    return b;
  }
  private freeVao(vao: WebGLVertexArrayObject) {
    for (const b of this.vaoBuffers.get(vao) ?? []) this.gl.deleteBuffer(b);
    this.vaoBuffers.delete(vao);
    this.gl.deleteVertexArray(vao);
  }

  /** Corner positions for the overlay meshes, a little above the ground. */
  private overlayPositions(): Float32Array {
    const t = this.terrain;
    const pos = new Float32Array(t.width * t.height * 3);
    for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
      const o = (y * t.width + x) * 3;
      pos[o] = t.offsetX + x * 128; pos[o + 1] = t.offsetY + y * 128; pos[o + 2] = this.corner(x, y).height + rampLift(t, x, y) + 2;
    }
    return pos;
  }

  /** The ground changed height: the same mesh, new positions. */
  private reshapeOverlay(pos: WebGLBuffer) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.overlayPositions());
  }

  /** Ground-hugging tile quads for the overlay (positions only). */
  private overlayMesh(prog = this.overlayProg!): { vao: WebGLVertexArrayObject; count: number; pos: WebGLBuffer } {
    const t = this.terrain, gl = this.gl;
    const idx = new Uint32Array((t.width - 1) * (t.height - 1) * 6);
    let k = 0;
    for (let y = 0; y < t.height - 1; y++) for (let x = 0; x < t.width - 1; x++) {
      const a = y * t.width + x, b = a + 1, c = a + t.width, d = c + 1;
      idx.set([a, b, d, a, d, c], k); k += 6;
    }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const pos = this.buf(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, this.overlayPositions(), gl.DYNAMIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 12, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf(vao));
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: idx.length, pos };
  }

  /** Replaces a named group of point markers (e.g. "doodads", "units"). */
  setMarkers(name: string, markers: Marker[]) {
    const old = this.markers.get(name);
    if (old) this.freeVao(old.vao);
    this.markers.set(name, this.colorMesh(markers.flatMap((m) => [m.x, m.y, m.z + 8, m.rgb[0] / 255, m.rgb[1] / 255, m.rgb[2] / 255, 1])));
  }

  setGroundTexture(i: number, img: DecodedImage) {
    // Deeper mip levels would blend neighbouring cells together.
    const tex = createTexture(this.gl, img, { repeat: [false, false], maxLevel: Math.max(0, Math.log2(img.height / 4) - 3) });
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

  /** The nearest placed object a ray hits. With `radiusOf`, objects are
   *  upright cylinders of that radius (their footprint) standing at their
   *  position up to the top of the model; otherwise the model's bounding sphere.
   *  `extra` are objects drawn without a model of their own (the stand-ins of
   *  objects shown as markers), picked the same way; a hidden group's are left out too. */
  pickObject(ray: { origin: Vec3; dir: Vec3 }, radiusOf?: (inst: ObjectInstance) => number | undefined,
    extra: readonly { group: string; inst: ObjectInstance }[] = []): ObjectInstance | null {
    const { origin: o, dir: d } = ray;
    let best: ObjectInstance | null = null, bestT = Infinity;
    const sources = [...this.batches.map((b) => ({ group: b.group, instances: b.instances })),
      ...extra.map((s) => ({ group: s.group, instances: [s.inst] }))];
    for (const b of sources) {
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
    for (const m of this.selection) this.freeVao(m.vao);
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
    if (this.brush) this.freeVao(this.brush.vao);
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
      data.push(x, y, (r.z ?? this.groundHeight(x, y)) + 4, r.rgb[0] / 255, r.rgb[1] / 255, r.rgb[2] / 255, 1);
    }
    return this.colorMesh(data);
  }

  /** Placed objects play their Stand animation (see setAnimate). */
  private animate = true;
  private animStart = performance.now();
  /** When the last frame with animated objects was drawn (they redraw about 30 times a second). */
  private lastAnimFrame = 0;

  /** Placed objects play their Stand animation in a loop, or stand still at its start. */
  setAnimate(on: boolean) {
    this.animate = on;
    if (!on) for (const gpu of new Set(this.batches.map((b) => b.gpu))) gpu.pose(standClock(gpu.model, gpu.props));
  }

  /** Poses the placed models at the current moment of their Stand animation (one pose per
   *  model, shared by its instances), and the classic models whose effects stand in. Only models
   *  with an instance in view (`inView`) are posed, and those whose particles follow their pose
   *  (near objects have particles in view) or that a placement preview shows: the others are posed
   *  when they come into view, before they're drawn. */
  private poseAnimated(inView: ReadonlySet<ObjectBatch>) {
    const t = performance.now() - this.animStart;
    const at = (c: Clock): Clock => ({ ...c, frame: c.seqStart + (t % Math.max(1, c.seqEnd - c.seqStart)), time: t });
    const posed = new Set<ModelGpu>();
    const previewed = new Set([this.ghost, ...this.ghosts].map((g) => g?.gpu));
    for (const b of this.batches) {
      if (this.hiddenGroups.has(b.group)) continue;
      if (!inView.has(b) && !b.effects && !previewed.has(b.gpu)) continue;
      if (!posed.has(b.gpu) && b.gpu.model.sequences.length) {
        posed.add(b.gpu);
        b.gpu.pose(at(standClock(b.gpu.model, b.gpu.props)));
      }
      const fx = b.effects;
      if (fx?.classic) {
        fx.clock = at(standClock(fx.model, b.gpu.props));
        fx.nodeWorld = poseNodes(fx.model, fx.clock);
      }
    }
  }

  /** Whether the view changes by itself (animation, particles, water): then it's redrawn. */
  get animating(): boolean {
    if (this.showWater && this.water.count && this.waterLook.frames.length > 1 && this.waterFrame() !== this.waterFrameShown) return true;
    if (this.animate && performance.now() - this.lastAnimFrame > 33
      && this.batches.some((b) => b.instances.length && b.gpu.model.sequences.length && !this.hiddenGroups.has(b.group))) return true;
    if (this.showWeather && this.weather.length) return true;
    return this.showEffects && this.batches.some((b) => b.instances.length && b.effects && !this.hiddenGroups.has(b.group));
  }

  /** Weather to draw from now on. */
  setWeather(list: { effect: WeatherEffect; box: WeatherBox | null }[]) {
    this.weather = list.map((w) => ({ ...w, particles: new ParticleInstance(w.effect.model, Math.random, MOST_PARTICLES), texture: null }));
    return this.weather;
  }

  setWeatherTexture(w: TerrainRenderer["weather"][number], img: DecodedImage) {
    w.texture = createTexture(this.gl, img, { repeat: [false, false] });
  }

  /** Steps and draws the particles of placed objects near the view. */
  private drawParticles(viewProj: Mat4, eye: Vec3) {
    const now = performance.now();
    const dt = this.lastParticleTime < 0 ? 0 : Math.min(0.1, (now - this.lastParticleTime) / 1000);
    this.lastParticleTime = now;
    // Far objects aren't simulated (they keep their particles until the view comes back).
    const reach = this.distance * 2.5 + 1024;
    const items: Parameters<ParticleRenderer["draw"]>[2] = [];
    for (const b of this.showEffects ? this.batches : []) {
      const fx = b.effects;
      if (!fx || this.hiddenGroups.has(b.group)) continue;
      for (const inst of b.instances) {
        if (Math.hypot(inst.world[12] - this.target[0], inst.world[13] - this.target[1]) > reach) continue;
        let p = this.particleStates.get(inst);
        if (!p) this.particleStates.set(inst, (p = new ParticleInstance(fx.model)));
        // A model's own emitters follow its current pose; a classic stand-in has its own.
        p.step(dt, fx.classic ? fx.clock : b.gpu.poseClock, fx.classic ? fx.nodeWorld : b.gpu.nodeWorld, inst.world);
        items.push({ particles: p, textures: fx.textures, world: inst.world });
      }
    }
    if (this.showWeather) for (const w of this.weather) {
      const box = w.box ?? viewBox(this.target[0], this.target[1], this.distance);
      const world = placeWeather(w.effect, box, w.box ? this.groundHeight((box.left + box.right) / 2, (box.bottom + box.top) / 2) : this.target[2]);
      w.particles.step(dt, WEATHER_CLOCK, WEATHER_NODES, world);
      items.push({ particles: w.particles, textures: [w.texture], world });
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
    // Past the end of the fog there's nothing to see, so the background is the fog too. The fog counts from
    // the eye as in the game, also from further out than the game's camera: zoomed out, a near fog covers
    // everything, as it does there (the view's Fog box turns it off).
    const fog = this.showFog && this.fog ? this.fog : null;
    const back = fog?.color ?? [0.11, 0.12, 0.14];
    gl.clearColor(back[0], back[1], back[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);

    const far = this.distance * 10;
    const viewProj = mat4.mul(
      mat4.perspective(this.fov, w / Math.max(1, h), Math.max(10, this.distance / 50), far),
      mat4.lookAt(this.eye(), this.target, [0, 0, 1]),
    );

    // The sky: behind everything, around the camera, as far as the view reaches.
    if (this.sky && this.showSky) {
      const s = (far * 0.7) / Math.max(1, this.sky.radius), [x, y, z] = this.eye();
      gl.disable(gl.CULL_FACE);
      gl.depthMask(false);
      this.sky.gpu.draw(viewProj, new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, x, y, z, 1]), { onTop: true, pass: "all" });
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.disable(gl.BLEND);
    }

    // Ground: lowest texture first, the others blend over it.
    gl.useProgram(this.groundProg);
    setFog(gl, (name) => gl.getUniformLocation(this.groundProg, name), fog);
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

    for (const layer of [this.viewLayer, this.overlay, this.showBorder ? this.border : null]) {
      if (!layer || !this.overlayProg) continue;
      const t = this.terrain;
      gl.useProgram(this.overlayProg);
      // The border is part of the map, and fades with it. What a tool shows has to stay readable.
      setFog(gl, (name) => gl.getUniformLocation(this.overlayProg as WebGLProgram, name), layer === this.border ? fog : null);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.overlayProg, "uViewProj"), false, viewProj);
      gl.uniform4f(gl.getUniformLocation(this.overlayProg, "uRect"), t.offsetX, t.offsetY, (t.width - 1) * 128, (t.height - 1) * 128);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layer.tex);
      gl.uniform1i(gl.getUniformLocation(this.overlayProg, "uTex"), 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.bindVertexArray(layer.vao);
      gl.drawElements(gl.TRIANGLES, layer.count, gl.UNSIGNED_INT, 0);
      gl.depthMask(true);
    }

    if (this.gridStep > 0) this.drawGrid(viewProj);

    // Building ground marks, on the ground under the objects.
    if (this.splats.length && !this.hiddenGroups.has("units")) {
      gl.useProgram(this.splatProg);
      setFog(gl, (name) => gl.getUniformLocation(this.splatProg, name), fog);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.splatProg, "uViewProj"), false, viewProj);
      gl.uniform1i(gl.getUniformLocation(this.splatProg, "uTex"), 0);
      const sun = this.terrainLight;
      const up = sun ? Math.max(0, sun.dir[2] / (Math.hypot(...sun.dir) || 1)) : 0;
      const lit = sun ? [0, 1, 2].map((k) => sun.ambient[k] + sun.diffuse[k] * up) : [1, 1, 1];
      gl.uniform3f(gl.getUniformLocation(this.splatProg, "uLight"), lit[0], lit[1], lit[2]);
      gl.activeTexture(gl.TEXTURE0);
      gl.enable(gl.BLEND);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      for (const s of this.splats) {
        const tex = this.splatTextures.get(s.texture.toLowerCase());
        if (!tex) continue;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform4fv(gl.getUniformLocation(this.splatProg, "uColor"), s.color);
        gl.blendFunc(gl.SRC_ALPHA, s.blend === 1 ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
        gl.bindVertexArray(s.vao);
        gl.drawArrays(gl.TRIANGLES, 0, s.count);
      }
      gl.depthMask(true);
      gl.enable(gl.CULL_FACE);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    // Placed objects: every opaque layer, then every blended one; each model once per layer for all
    // its instances in view. Cliffs aren't culled: the ground they follow moves them up in the shader.
    const planes = frustumPlanes(viewProj);
    const gathered: [ObjectBatch, InstanceRuns][] = [];
    for (const b of this.batches) {
      if (this.hiddenGroups.has(b.group) || !b.instances.length) continue;
      const list = this.gatherInstances(b, b.followGround ? null : planes);
      if (list.runs.length) gathered.push([b, list]);
    }
    if (this.animate) { this.poseAnimated(new Set(gathered.map(([b]) => b))); this.lastAnimFrame = performance.now(); }
    for (const pass of ["opaque", "blended"] as const) {
      for (const [b, list] of gathered) {
        const light = (b.group === "units" ? this.unitLight : this.terrainLight) ?? undefined;
        b.gpu.drawInstances(viewProj, list, { pass, heightMap: b.followGround ? this.heightMap : undefined, light, fog });
      }
    }
    if (this.showEffects || this.showWeather) this.drawParticles(viewProj, this.eye());
    else this.lastParticleTime = -1;
    // Placement preview: see-through, red where the object doesn't fit.
    for (const g of this.ghost ? [this.ghost, ...this.ghosts] : this.ghosts) {
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
      setFog(gl, (name) => gl.getUniformLocation(this.waterProg, name), fog);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.waterProg, "uViewProj"), false, viewProj);
      gl.uniform1i(gl.getUniformLocation(this.waterProg, "uTex"), 0);
      const ramp = waterRamp(look, this.waterTint);
      for (const [name, v] of [["uShallowMin", ramp.shallowMin], ["uShallowMax", ramp.shallowMax], ["uDeepMin", ramp.deepMin], ["uDeepMax", ramp.deepMax]] as const) {
        gl.uniform4fv(gl.getUniformLocation(this.waterProg, name), v);
      }
      gl.uniform1f(gl.getUniformLocation(this.waterProg, "uGrey"), ramp.grey ? 1 : 0);
      // Lit like flat ground (normal straight up); the even light without the map's.
      const sun = this.terrainLight;
      const up = sun ? Math.max(0, sun.dir[2] / (Math.hypot(...sun.dir) || 1)) : 0;
      const lit = sun ? [0, 1, 2].map((k) => sun.ambient[k] + sun.diffuse[k] * up) : [1, 1, 1];
      gl.uniform3f(gl.getUniformLocation(this.waterProg, "uLight"), lit[0], lit[1], lit[2]);
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

  /** Grid lines over the ground; the larger the cell, the stronger the line. */
  private drawGrid(viewProj: Mat4) {
    const gl = this.gl, t = this.terrain;
    this.gridProg ??= compile(gl, GRID_VS, GRID_FS);
    this.gridMesh ??= this.overlayMesh(this.gridProg);
    gl.useProgram(this.gridProg);
    setFog(gl, (name) => gl.getUniformLocation(this.gridProg as WebGLProgram, name), null);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.gridProg, "uViewProj"), false, viewProj);
    gl.uniform2f(gl.getUniformLocation(this.gridProg, "uOrigin"), t.offsetX, t.offsetY);
    gl.uniform1f(gl.getUniformLocation(this.gridProg, "uStep"), this.gridStep);
    const colour = this.gridStep >= 512 ? [1, 0.9, 0.3, 0.95] : this.gridStep >= 128 ? [1, 1, 1, 0.7] : [0.75, 0.9, 1, 0.45];
    gl.uniform4fv(gl.getUniformLocation(this.gridProg, "uColor"), colour);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.bindVertexArray(this.gridMesh.vao);
    gl.drawElements(gl.TRIANGLES, this.gridMesh.count, gl.UNSIGNED_INT, 0);
    gl.depthMask(true);
  }

  dispose() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
