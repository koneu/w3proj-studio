// MDX (binary Warcraft III model) parser: geometry, materials, textures,
// sequences and the node hierarchy with animation tracks.
//
// Versions: 800 (classic, map imports) and 1800 (all models shipped with 3.0;
// adds geoset LODs, HD tangents/skin weights and multi-texture layers).
// Chunks the renderer needs are parsed strictly (every byte accounted for);
// particle emitters (PRE2) and ribbons (RIBB) too; other effects (lights, …) are
// only read for their skeleton nodes and otherwise skipped.

export type Interp = 0 | 1 | 2 | 3; // none, linear, hermite, bezier

export interface Track {
  interp: Interp;
  globalSeq: number;
  times: Uint32Array;
  /** `size` floats per key (1, 3 or 4); ints are stored as floats. */
  values: Float32Array;
  inTan?: Float32Array;
  outTan?: Float32Array;
  size: number;
}

export interface Extent {
  radius: number;
  min: [number, number, number];
  max: [number, number, number];
}

export interface Sequence {
  name: string;
  start: number;
  end: number;
  moveSpeed: number;
  flags: number;
  rarity: number;
  extent: Extent;
}

export interface Texture {
  replaceableId: number;
  path: string;
  flags: number;
}

export interface Layer {
  filterMode: number;
  shadingFlags: number;
  /** Texture ids per slot (slot 0 = diffuse). */
  textureIds: number[];
  textureAnimId: number;
  coordId: number;
  alpha: number;
  alphaTrack?: Track;
  /** Which texture the diffuse slot shows over time (a flipbook): the layer's KMTF, or a Reforged layer's slot 0 one. */
  textureTrack?: Track;
  /** A Reforged layer's per-slot texture tracks (same order as `textureIds`), when any slot has one. */
  slotTracks?: (Track | undefined)[];
}

export interface Material {
  priorityPlane: number;
  flags: number;
  layers: Layer[];
}

export interface Geoset {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** Triangle indices. */
  faces: Uint16Array;
  /** Per vertex: index into `groups` (classic skinning). */
  vertexGroups: Uint8Array | Uint16Array;
  /** Matrix groups: object ids of the bones each group averages. */
  groups: number[][];
  /** HD skinning: 4 group indices + 4 weights (0–255) per vertex. */
  skin?: Uint16Array;
  materialId: number;
  lod: number;
  lodName: string;
  extent: Extent;
}

export interface GeosetAnim {
  geosetId: number;
  alpha: number;
  color: [number, number, number];
  alphaTrack?: Track;
  colorTrack?: Track;
}

export interface Node {
  name: string;
  objectId: number;
  parentId: number;
  flags: number;
  kind: string;
  translation?: Track;
  rotation?: Track;
  scaling?: Track;
}

/** A particle emitter (PRE2, "ParticleEmitter2"): camera-facing sprites spawned from a
 *  rectangle around its node, flying out in a cone, falling with gravity, changing colour,
 *  opacity and size over their life in three segments (start, middle at `time`, end). */
export interface ParticleEmitter2 {
  /** The emitter's node (also in `Model.nodes`); its flags hold the emitter flags. */
  node: Node;
  speed: number;
  /** Random speed change, as a fraction of `speed`. */
  variation: number;
  /** Half-angle of the emission cone, in degrees. */
  latitude: number;
  gravity: number;
  /** Seconds. */
  lifespan: number;
  /** Particles per second. */
  emissionRate: number;
  /** Size of the spawn rectangle (x × y around the pivot). */
  width: number;
  length: number;
  /** 0 blend, 1 additive, 2 modulate, 3 modulate 2×, 4 alpha key. */
  filterMode: number;
  /** Texture cells (sprite sheet). */
  rows: number;
  columns: number;
  /** 0 head (a sprite), 1 tail (a streak along the motion), 2 both. */
  headOrTail: number;
  tailLength: number;
  /** Where the middle segment sits in the life (0–1). */
  time: number;
  /** Start, middle, end colours (r, g, b in 0–1). */
  segmentColor: [number, number, number][];
  /** Start, middle, end opacity (0–255). */
  segmentAlpha: [number, number, number];
  segmentScaling: [number, number, number];
  /** Sprite cells as [start, end, repeat]: head in the first and the second part of the life, tail the same. */
  headIntervals: [number, number, number];
  headDecayIntervals: [number, number, number];
  tailIntervals: [number, number, number];
  tailDecayIntervals: [number, number, number];
  textureId: number;
  /** Emits a burst when the emission rate track jumps (spell effects) instead of a stream. */
  squirt: boolean;
  priorityPlane: number;
  replaceableId: number;
  speedTrack?: Track;
  variationTrack?: Track;
  latitudeTrack?: Track;
  gravityTrack?: Track;
  emissionRateTrack?: Track;
  widthTrack?: Track;
  lengthTrack?: Track;
  visibilityTrack?: Track;
}

/** A ribbon emitter (RIBB): a strip left behind its node as it moves, one segment per spawn
 *  from `heightAbove` to `heightBelow` along the node's Y axis, each living `lifespan` seconds,
 *  drawn with a material of the model. */
export interface RibbonEmitter {
  node: Node;
  heightAbove: number;
  heightBelow: number;
  alpha: number;
  /** r, g, b in 0–1 (RGB: Mark of Chaos is red, Starfall purple). */
  color: [number, number, number];
  lifespan: number;
  /** Sprite cell of the material's texture (rows × columns). */
  textureSlot: number;
  /** Segments per second. */
  emissionRate: number;
  rows: number;
  columns: number;
  materialId: number;
  gravity: number;
  heightAboveTrack?: Track;
  heightBelowTrack?: Track;
  alphaTrack?: Track;
  colorTrack?: Track;
  textureSlotTrack?: Track;
  visibilityTrack?: Track;
}

/** Emitter flags in `ParticleEmitter2.node.flags`. */
export const PRE2_FLAGS = { unshaded: 0x8000, sortPrimsFarZ: 0x10000, lineEmitter: 0x20000, unfogged: 0x40000, modelSpace: 0x80000, xyQuad: 0x100000 };

/** A texture animation (TXAN): moves, turns and scales a layer's texture coordinates. */
export interface TextureAnim {
  translation?: Track;
  /** Quaternion; only the turn about Z matters for texture coordinates. */
  rotation?: Track;
  scaling?: Track;
}

/** A light (LITE): where it is (its node) and how far it reaches, for the terrain view's Light Ranges. */
export interface ModelLight {
  node: Node;
  /** 0 omnidirectional, 1 directional, 2 ambient. */
  type: number;
  /** World units from the light: full strength up to the start, nothing past the end. */
  attenuationStart: number;
  attenuationEnd: number;
  /** Its colour (0–1 each, in the file's order) and intensity: the fixed values (an animated one's first key), and
   *  the tracks that animate them (KLAC, KLAI) when it has them. How bright it is sets how far the World Editor's Light Ranges ring reaches (viewmodes.ts lightRangeRadius). */
  color: [number, number, number];
  intensity: number;
  colorTrack?: Track;
  intensityTrack?: Track;
}

export interface Model {
  version: number;
  name: string;
  extent: Extent;
  sequences: Sequence[];
  globalSequences: number[];
  textures: Texture[];
  materials: Material[];
  geosets: Geoset[];
  geosetAnims: GeosetAnim[];
  /** All nodes (bones, helpers, attachments, emitters, …) by object id. */
  nodes: Node[];
  pivots: Float32Array;
  particleEmitters2: ParticleEmitter2[];
  ribbons: RibbonEmitter[];
  /** By `Layer.textureAnimId` (-1: none). */
  textureAnims: TextureAnim[];
  /** The model's lights (LITE), when it has any. They don't light anything here: the terrain view shows their reach. */
  lights?: ModelLight[];
  /** Chunks present but not rendered (lights, cameras, …). */
  skipped: string[];
  warnings: string[];
}

const TRACK_SIZE: Record<string, number> = {
  KGTR: 3, KGRT: 4, KGSC: 3, KGAO: 1, KGAC: 3, KMTF: 1, KMTA: 1, KMTE: 1, KFC3: 3, KFCA: 1, KFTC: 1,
  KATV: 1, KTAT: 3, KTAR: 4, KTAS: 3, KP2V: 1, KP2S: 1, KP2L: 1, KP2G: 1, KP2E: 1, KP2N: 1, KP2W: 1, KP2R: 1,
  KRVS: 1, KRHA: 1, KRHB: 1, KRAL: 1, KRCO: 3, KRTX: 1, KLAS: 1, KLAE: 1, KLAC: 3, KLIC: 3, KLAI: 1, KLBI: 1,
  KLBC: 3, KLAV: 1, KCTR: 3, KTTR: 3, KCRL: 1, KPPV: 1, KPPA: 1, KPPE: 1, KPPC: 3, KPPL: 1, KPPR: 1, KPPS: 1,
};
/** Tracks stored as integers. */
const INT_TRACKS = new Set(["KMTF", "KRTX"]);

class Reader {
  p = 0;
  readonly b: DataView;
  readonly u8: Uint8Array;
  constructor(b: DataView, u8: Uint8Array) {
    this.b = b;
    this.u8 = u8;
  }
  get left() { return this.b.byteLength - this.p; }
  u32() { const v = this.b.getUint32(this.p, true); this.p += 4; return v; }
  i32() { const v = this.b.getInt32(this.p, true); this.p += 4; return v; }
  f32() { const v = this.b.getFloat32(this.p, true); this.p += 4; return v; }
  tag() { const s = String.fromCharCode(this.u8[this.p], this.u8[this.p + 1], this.u8[this.p + 2], this.u8[this.p + 3]); this.p += 4; return s; }
  peekTag() { return this.left >= 4 ? String.fromCharCode(this.u8[this.p], this.u8[this.p + 1], this.u8[this.p + 2], this.u8[this.p + 3]) : ""; }
  str(n: number) {
    const bytes = this.u8.subarray(this.p, this.p + n);
    this.p += n;
    const end = bytes.indexOf(0);
    return new TextDecoder("latin1").decode(end < 0 ? bytes : bytes.subarray(0, end));
  }
  f32s(n: number) {
    // Copy: the source may not be 4-byte aligned.
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.f32();
    return out;
  }
  u32s(n: number) {
    const out = new Uint32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.u32();
    return out;
  }
  bytes(n: number) { const s = this.u8.slice(this.p, this.p + n); this.p += n; return s; }
  need(n: number, what: string) { if (n < 0 || n > this.left) throw new Error(`${what}: ${n} bytes needed, ${this.left} left at ${this.p}`); }
  /** Reads an object's stated size (which counts its size field) and returns where the object ends. A size that
   *  doesn't cover the field itself, or reaches past `end` (the chunk's end), is refused: the reader is set to the
   *  object's end afterwards, and a size of 0 would send it back to the same place for ever. */
  objectEnd(end: number, what: string) {
    const start = this.p, size = this.u32();
    if (size < 4 || start + size > end) throw new Error(`${what}: size ${size} at ${start}, ${end - start} bytes left in the chunk`);
    return start + size;
  }
  extent(): Extent {
    return { radius: this.f32(), min: [this.f32(), this.f32(), this.f32()], max: [this.f32(), this.f32(), this.f32()] };
  }
}

function readTrack(r: Reader, tag: string): Track {
  const size = TRACK_SIZE[tag];
  if (!size) throw new Error(`unknown track ${tag}`);
  const count = r.u32();
  const interp = r.u32() as Interp;
  const globalSeq = r.i32();
  if (interp > 3) throw new Error(`${tag}: bad interpolation ${interp}`);
  const tangents = interp > 1;
  r.need(count * 4 * (1 + size * (tangents ? 3 : 1)), tag);
  const times = new Uint32Array(count);
  const values = new Float32Array(count * size);
  const inTan = tangents ? new Float32Array(count * size) : undefined;
  const outTan = tangents ? new Float32Array(count * size) : undefined;
  const int = INT_TRACKS.has(tag);
  const val = () => (int ? r.u32() : r.f32());
  for (let i = 0; i < count; i++) {
    times[i] = r.u32();
    for (let k = 0; k < size; k++) values[i * size + k] = val();
    if (tangents) {
      for (let k = 0; k < size; k++) inTan![i * size + k] = val();
      for (let k = 0; k < size; k++) outTan![i * size + k] = val();
    }
  }
  return { interp, globalSeq, times, values, inTan, outTan, size };
}

/** Reads tracks until `end`; returns them by tag. */
function readTracks(r: Reader, end: number): Record<string, Track> {
  const out: Record<string, Track> = {};
  while (r.p < end) {
    const tag = r.tag();
    out[tag] = readTrack(r, tag);
  }
  if (r.p !== end) throw new Error(`tracks overran by ${r.p - end} bytes`);
  return out;
}

/** Node header shared by bones, helpers, attachments, emitters, … */
function readNode(r: Reader, kind: string): Node {
  const start = r.p;
  const size = r.u32();
  r.need(size - 4, `${kind} node`);
  const name = r.str(80);
  const objectId = r.u32();
  const parentId = r.i32();
  const flags = r.u32();
  const tracks = readTracks(r, start + size);
  return { name, objectId, parentId, flags, kind, translation: tracks.KGTR, rotation: tracks.KGRT, scaling: tracks.KGSC };
}

/** A light's fixed values after its node, up to `end` (the light's end). Three layouts, measured on the game's
 *  models (versions 1600–1800) and on custom ones (800–1800): 44 bytes up to version 1100 (type, attenuation start
 *  and end, colour, intensity, ambient colour and intensity), 48 in version 1200 (a shadow intensity after those) and
 *  72 from 1600 on (a word after the type; shadow intensity, shadow casting start and end, two falloffs and a damping
 *  after the ambient intensity: dnclight.ts). 1300–1500 weren't seen with lights. The version's layout is tried
 *  first, then the others: the first after which the rest reads as tracks up to the light's end, exactly, is it; when
 *  none does, the version's one is read without its tracks. Null when the values aren't readable or make no sense. */
function readLight(r: Reader, node: Node, end: number, version: number): ModelLight | null {
  const start = r.p;
  const order = version < 1200 ? [44, 48, 72] : version < 1600 ? [48, 72, 44] : [72, 48, 44];
  let size = 0;
  let tracks: Record<string, Track> = {};
  for (const n of order) {
    if (start + n > end) continue;
    r.p = start + n;
    try {
      tracks = readTracks(r, end);
      size = n;
      break;
    } catch { /* not this layout */ }
  }
  if (!size) size = order.find((n) => start + n <= end) ?? 0;
  if (!size) return null;
  r.p = start;
  const type = r.u32();
  if (size === 72) r.u32();
  const attenuationStart = r.f32(), attenuationEnd = r.f32();
  const color: [number, number, number] = [r.f32(), r.f32(), r.f32()];
  const intensity = r.f32();
  const ok = (v: number) => Number.isFinite(v) && v >= 0 && v < 1e7;
  if (!ok(attenuationStart) || !ok(attenuationEnd) || type > 2) return null;
  const light: ModelLight = { node, type, attenuationStart, attenuationEnd, color: color.every(Number.isFinite) ? color : [1, 1, 1], intensity: Number.isFinite(intensity) ? intensity : 0 };
  // The tracks after the fixed values (none when they're damaged: the light keeps its fixed values). An animated
  // value's fixed one isn't used: its first key stands in, as mdl.ts reads it.
  const first = (t: Track, k: number) => (t.values.length > k && Number.isFinite(t.values[k]) ? t.values[k] : null);
  if (tracks.KLAC?.size === 3) {
    light.colorTrack = tracks.KLAC;
    light.color = light.color.map((c, k) => first(tracks.KLAC, k) ?? c) as [number, number, number];
  }
  if (tracks.KLAI?.size === 1) {
    light.intensityTrack = tracks.KLAI;
    light.intensity = first(tracks.KLAI, 0) ?? light.intensity;
  }
  return light;
}

function readParticleEmitter2(r: Reader, end: number): ParticleEmitter2 {
  const node = readNode(r, "pre2");
  const speed = r.f32(), variation = r.f32(), latitude = r.f32(), gravity = r.f32(), lifespan = r.f32(), emissionRate = r.f32();
  const width = r.f32(), length = r.f32();
  const filterMode = r.u32(), rows = r.u32(), columns = r.u32(), headOrTail = r.u32();
  const tailLength = r.f32(), time = r.f32();
  const segmentColor = [0, 1, 2].map(() => [r.f32(), r.f32(), r.f32()] as [number, number, number]);
  const segmentAlpha = [r.u8[r.p++], r.u8[r.p++], r.u8[r.p++]] as [number, number, number];
  const segmentScaling = [r.f32(), r.f32(), r.f32()] as [number, number, number];
  const interval = () => [r.u32(), r.u32(), r.u32()] as [number, number, number];
  const headIntervals = interval(), headDecayIntervals = interval(), tailIntervals = interval(), tailDecayIntervals = interval();
  const textureId = r.u32(), squirt = r.u32() !== 0, priorityPlane = r.u32(), replaceableId = r.u32();
  const t = readTracks(r, end);
  return {
    node, speed, variation, latitude, gravity, lifespan, emissionRate, width, length, filterMode, rows, columns, headOrTail,
    tailLength, time, segmentColor, segmentAlpha, segmentScaling, headIntervals, headDecayIntervals, tailIntervals,
    tailDecayIntervals, textureId, squirt, priorityPlane, replaceableId,
    speedTrack: t.KP2S, variationTrack: t.KP2R, latitudeTrack: t.KP2L, gravityTrack: t.KP2G, emissionRateTrack: t.KP2E,
    widthTrack: t.KP2W, lengthTrack: t.KP2N, visibilityTrack: t.KP2V,
  };
}

function readRibbon(r: Reader, end: number): RibbonEmitter {
  const node = readNode(r, "ribb");
  const heightAbove = r.f32(), heightBelow = r.f32(), alpha = r.f32();
  const color = [r.f32(), r.f32(), r.f32()] as [number, number, number];
  const lifespan = r.f32(), textureSlot = r.u32(), emissionRate = r.u32(), rows = r.u32(), columns = r.u32(), materialId = r.u32();
  const gravity = r.f32();
  const t = readTracks(r, end);
  return {
    node, heightAbove, heightBelow, alpha, color, lifespan, textureSlot, emissionRate, rows, columns, materialId, gravity,
    heightAboveTrack: t.KRHA, heightBelowTrack: t.KRHB, alphaTrack: t.KRAL, colorTrack: t.KRCO, textureSlotTrack: t.KRTX, visibilityTrack: t.KRVS,
  };
}

function readGeoset(r: Reader, version: number): Geoset {
  const start = r.p;
  const size = r.u32();
  r.need(size - 4, "geoset");
  const end = start + size;
  const expect = (tag: string) => {
    const t = r.tag();
    if (t !== tag) throw new Error(`geoset: expected ${tag}, found ${JSON.stringify(t)} at ${r.p - 4}`);
    return r.u32();
  };
  const positions = r.f32s(expect("VRTX") * 3);
  const normals = r.f32s(expect("NRMS") * 3);
  const types = r.u32s(expect("PTYP"));
  const counts = r.u32s(expect("PCNT"));
  const nIdx = expect("PVTX");
  const idx = new Uint16Array(nIdx);
  for (let i = 0; i < nIdx; i++) { idx[i] = r.b.getUint16(r.p, true); r.p += 2; }
  // Only triangle lists (type 4) are used by the game's models.
  if (types.some((t) => t !== 4)) throw new Error(`geoset: unsupported primitive types ${[...types]}`);
  if (counts.reduce((a, b) => a + b, 0) !== nIdx) throw new Error("geoset: primitive counts don't match indices");
  const vertexGroups = r.bytes(expect("GNDX"));
  const groupSizes = r.u32s(expect("MTGC"));
  const matrices = r.u32s(expect("MATS"));
  const groups: number[][] = [];
  let m = 0;
  for (const n of groupSizes) { groups.push([...matrices.subarray(m, m + n)]); m += n; }
  const materialId = r.u32();
  r.u32(); // selection group
  r.u32(); // selection flags
  let lod = 0, lodName = "";
  if (version > 800) { lod = r.u32(); lodName = r.str(80); }
  const extent = r.extent();
  const extentCount = r.u32();
  r.p += extentCount * 28; // per-sequence extents
  let skin: Uint16Array | undefined;
  while (r.peekTag() === "TANG" || r.peekTag() === "SKIN") {
    const t = r.tag();
    const n = r.u32();
    if (t === "TANG") {
      r.p += n * 16;
      continue;
    }
    // v1000 stores bytes, v1800 16-bit values; the following UVAS tag tells which.
    const tagAt = (o: number) => String.fromCharCode(...r.u8.subarray(o, o + 4));
    const wide = tagAt(r.p + n) !== "UVAS" && tagAt(r.p + n * 2) === "UVAS";
    skin = new Uint16Array(n);
    for (let i = 0; i < n; i++) skin[i] = wide ? r.b.getUint16(r.p + i * 2, true) : r.u8[r.p + i];
    r.p += wide ? n * 2 : n;
  }
  const sets = expect("UVAS");
  let uvs = new Float32Array(0);
  for (let s = 0; s < sets; s++) {
    const n = expect("UVBS");
    const set = r.f32s(n * 2);
    if (s === 0) uvs = set;
  }
  if (r.p !== end) throw new Error(`geoset: ${end - r.p} unread bytes`);
  const vertices = positions.length / 3;
  if (skin && skin.length !== vertices * 8) throw new Error("geoset: SKIN size mismatch");
  return {
    positions, normals, uvs, faces: idx, materialId, lod, lodName, extent, groups, skin,
    vertexGroups: vertexGroups.length === vertices ? vertexGroups : new Uint8Array(vertices),
  };
}

function readLayer(r: Reader, version: number): Layer {
  const start = r.p;
  const size = r.u32();
  r.need(size - 4, "layer");
  const end = start + size;
  const filterMode = r.u32();
  const shadingFlags = r.u32();
  const textureId = r.u32();
  const textureAnimId = r.i32();
  const coordId = r.u32();
  const alpha = r.f32();
  let textureIds = [textureId];
  let slotTracks: (Track | undefined)[] | undefined;
  // The Reforged additions are present only if the layer has room for them
  // before its tracks (v1300 files use the classic 28-byte layer again).
  const hasMore = (n: number) => end - r.p >= n && !r.peekTag().startsWith("K");
  if (version > 800 && hasMore(24)) {
    r.f32(); // emissive gain
    r.f32s(3); // fresnel colour
    r.f32(); // fresnel opacity
    r.f32(); // fresnel team colour
  }
  if (version >= 1100 && hasMore(8)) {
    r.u32(); // HD flag
    const n = r.u32();
    textureIds = [];
    slotTracks = [];
    for (let i = 0; i < n; i++) {
      textureIds.push(r.u32());
      r.u32(); // slot
      // Per-slot texture id tracks follow the slot when present: a flipbook (the HD City Fountain's water
      // names the stone's diffuse as its texture and plays War3_FountainWater_Diff_0000…0049 through one).
      slotTracks.push(r.peekTag() === "KMTF" ? readTrack(r, (r.tag(), "KMTF")) : undefined);
    }
    if (!textureIds.length) textureIds = [textureId];
    if (!slotTracks.some((t) => t)) slotTracks = undefined;
  }
  const tracks = readTracks(r, end);
  // The diffuse slot's flipbook is the layer's texture track (what a classic layer's KMTF is).
  return { filterMode, shadingFlags, textureIds, textureAnimId, coordId, alpha, alphaTrack: tracks.KMTA, textureTrack: tracks.KMTF ?? slotTracks?.[0], slotTracks };
}

export function parseMdx(buf: Uint8Array): Model {
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), buf);
  if (r.tag() !== "MDLX") throw new Error("not an MDX model (missing MDLX)");
  const model: Model = {
    version: 800, name: "", extent: { radius: 0, min: [0, 0, 0], max: [0, 0, 0] },
    sequences: [], globalSequences: [], textures: [], materials: [], geosets: [], geosetAnims: [],
    nodes: [], pivots: new Float32Array(0), particleEmitters2: [], ribbons: [], textureAnims: [], skipped: [], warnings: [],
  };
  // The ids count the nodes, so they stay far below the file's size. `nodes` is indexed by them and
  // the renderer walks and spreads it: a damaged id of billions would stop the app.
  const node = (n: Node) => {
    if (n.objectId >= buf.length) throw new Error(`node id ${n.objectId}`);
    model.nodes[n.objectId] = n;
  };
  while (r.left >= 8) {
    const tag = r.tag();
    const size = r.u32();
    r.need(size, tag);
    const end = r.p + size;
    try {
      switch (tag) {
        case "VERS": model.version = r.u32(); break;
        case "MODL": model.name = r.str(80); r.p += 260; model.extent = r.extent(); r.u32(); break;
        case "SEQS":
          while (r.p < end) {
            model.sequences.push({ name: r.str(80), start: r.u32(), end: r.u32(), moveSpeed: r.f32(), flags: r.u32(), rarity: r.f32(), extent: (r.u32(), r.extent()) });
          }
          break;
        case "GLBS": while (r.p < end) model.globalSequences.push(r.u32()); break;
        case "TEXS": while (r.p < end) model.textures.push({ replaceableId: r.u32(), path: r.str(260), flags: r.u32() }); break;
        case "MTLS":
          while (r.p < end) {
            const mStart = r.p;
            const mSize = r.u32();
            const priorityPlane = r.u32();
            const flags = r.u32();
            if (model.version >= 900 && model.version < 1100) r.p += 80; // shader name
            if (r.tag() !== "LAYS") throw new Error("material: missing LAYS");
            const layers: Layer[] = [];
            for (let n = r.u32(); n > 0; n--) layers.push(readLayer(r, model.version));
            if (r.p !== mStart + mSize) throw new Error(`material: ${mStart + mSize - r.p} unread bytes`);
            model.materials.push({ priorityPlane, flags, layers });
          }
          break;
        case "GEOS": while (r.p < end) model.geosets.push(readGeoset(r, model.version)); break;
        case "GEOA":
          while (r.p < end) {
            const aStart = r.p;
            const aSize = r.u32();
            const alpha = r.f32();
            r.u32(); // flags
            const color: [number, number, number] = [r.f32(), r.f32(), r.f32()];
            const geosetId = r.u32();
            const tracks = readTracks(r, aStart + aSize);
            model.geosetAnims.push({ geosetId, alpha, color, alphaTrack: tracks.KGAO, colorTrack: tracks.KGAC });
          }
          break;
        case "BONE": while (r.p < end) { node(readNode(r, "bone")); r.p += 8; } break;
        case "HELP": while (r.p < end) node(readNode(r, "helper")); break;
        case "PIVT": model.pivots = r.f32s(size / 4); break;
        case "TXAN":
          while (r.p < end) {
            const aStart = r.p;
            const t = readTracks(r, aStart + r.u32());
            model.textureAnims.push({ translation: t.KTAT, rotation: t.KTAR, scaling: t.KTAS });
          }
          break;
        case "PRE2":
          while (r.p < end) {
            const oStart = r.p;
            const e = readParticleEmitter2(r, oStart + r.u32());
            node(e.node);
            model.particleEmitters2.push(e);
          }
          break;
        case "RIBB":
          while (r.p < end) {
            const oStart = r.p;
            const e = readRibbon(r, oStart + r.u32());
            node(e.node);
            model.ribbons.push(e);
          }
          break;
        case "LITE":
          while (r.p < end) {
            const oEnd = r.objectEnd(end, "light");
            const n = readNode(r, "lite");
            node(n);
            // A light whose values can't be read is left out; its node stays, as the other objects' do.
            const light = readLight(r, n, oEnd, model.version);
            if (light) (model.lights ??= []).push(light);
            r.p = oEnd;
          }
          model.skipped.push(tag);
          break;
        // Objects with an outer size: only their node matters here.
        case "ATCH": case "PREM": case "CORN":
          while (r.p < end) {
            const oEnd = r.objectEnd(end, tag.toLowerCase());
            node(readNode(r, tag.toLowerCase()));
            r.p = oEnd;
          }
          if (tag !== "ATCH") model.skipped.push(tag);
          break;
        case "EVTS":
          while (r.p < end) {
            node(readNode(r, "event"));
            if (r.peekTag() === "KEVT") { r.tag(); const n = r.u32(); r.u32(); r.p += n * 4; }
          }
          break;
        default:
          // CLID, CAMS, TXAN, FAFX, BPOS, … are not needed for display.
          model.skipped.push(tag);
          r.p = end;
      }
      if (r.p !== end) throw new Error(`${end - r.p} unread bytes`);
    } catch (e) {
      // Chunks the renderer depends on must be right; others only warn.
      if (["GEOS", "MTLS", "TEXS", "SEQS", "BONE", "HELP", "PIVT", "GEOA"].includes(tag)) throw new Error(`${tag}: ${(e as Error).message}`);
      model.warnings.push(`${tag}: ${(e as Error).message}`);
    }
    r.p = end;
  }
  return model;
}

/** A copy of an MDX file with texture paths renamed (`rename` returns the new path, or the
 *  same one). Texture entries have a fixed size (id, 260-byte path, flags), so nothing else in
 *  the file moves. Paths longer than 259 bytes are refused. */
export function renameTextures(buf: Uint8Array, rename: (path: string, index: number) => string): Uint8Array {
  const out = buf.slice();
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const tag = (p: number) => String.fromCharCode(out[p], out[p + 1], out[p + 2], out[p + 3]);
  if (tag(0) !== "MDLX") throw new Error("not an MDX model (missing MDLX)");
  for (let p = 4; p + 8 <= out.length;) {
    const size = dv.getUint32(p + 4, true);
    if (tag(p) === "TEXS") {
      for (let e = p + 8, i = 0; e + 268 <= p + 8 + size; e += 268, i++) {
        const raw = out.subarray(e + 4, e + 264);
        const end = raw.indexOf(0);
        const old = new TextDecoder("latin1").decode(end < 0 ? raw : raw.subarray(0, end));
        const name = rename(old, i);
        if (name === old) continue;
        const bytes = new TextEncoder().encode(name);
        if (bytes.length > 259) throw new Error(`texture path too long: ${name}`);
        raw.fill(0);
        raw.set(bytes);
      }
    }
    p += 8 + size;
  }
  return out;
}
